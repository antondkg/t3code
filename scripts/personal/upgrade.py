#!/usr/bin/env python3
"""Move the personal T3 build to an upstream tag, build it, and install it on this Mac and remotes."""
import argparse
import json
import os
from pathlib import Path
import platform
import plistlib
import re
import shlex
import shutil
import sqlite3
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parents[2]
MANIFEST = ROOT / "scripts/personal/release.json"
APP = Path("/Applications/T3 Code (Beta).app")
USERDATA = Path.home() / ".t3/userdata"
BACKUPS = Path.home() / ".t3/personal-backups"
KEEP_BACKUPS = 2
HELPER_PID = BACKUPS / "install.pid"
# Quitting T3 can take down processes it started, so launchd owns the helper that swaps the app.
INSTALL_LABEL = "com.antondkg.t3-personal-install"
INSTALL_PLIST = BACKUPS / "install.plist"
SCHEDULE_LABEL = "com.antondkg.t3-personal-upgrade"
SCHEDULE_PLIST = Path.home() / f"Library/LaunchAgents/{SCHEDULE_LABEL}.plist"
SCHEDULE_LOG = Path.home() / "Library/Logs/t3-personal-upgrade.log"
BUMP_SUBJECT = "build: personal "
# T3's own agent sessions export this; a test fixture asserts it is absent.
CHECK_ENV = {k: v for k, v in os.environ.items() if k != "T3_ACP_MCP_AUTHORIZATION"}


def run(*args, cwd=ROOT, env=None):
    subprocess.run(args, cwd=cwd, env=env, check=True)


def out(*args):
    return subprocess.check_output(args, cwd=ROOT, text=True).strip()


def vp():
    return (os.environ.get("T3_PERSONAL_VP") or shutil.which("vp")
            or str(Path.home() / ".t3/build-tools/vite-plus/bin/vp"))


def latest_nightly():
    tags = out("git", "for-each-ref", "--sort=-creatordate", "--format=%(refname:short)",
               "refs/tags/v*-nightly.*").splitlines()
    if not tags:
        raise SystemExit("No upstream nightly tags found")
    return tags[0]


def next_version(current, tag):
    base = re.match(r"v(\d+\.\d+\.\d+)", tag).group(1)
    match = re.fullmatch(r"(\d+\.\d+\.\d+)-personal\.(\d+)", current)
    serial = int(match.group(2)) + 1 if match and match.group(1) == base else 1
    return f"{base}-personal.{serial}"


def linux_runtime_sha(tag):
    base = tag.removeprefix("v")
    assets = json.loads(out("gh", "release", "view", tag, "-R", "pingdotgg/t3code",
                            "--json", "assets"))["assets"]
    for asset in assets:
        if asset["name"] == f"t3-{base}-linux-x64.tar.gz":
            return asset["digest"].removeprefix("sha256:")
    raise SystemExit(f"{tag} has no Linux runtime archive")


def notify(message):
    print(message)
    script = f"display notification {json.dumps(message)} with title \"T3 personal build\""
    subprocess.run(["osascript", "-e", script], check=False)


def up_to_date(tag):
    manifest = json.loads(MANIFEST.read_text())
    return (manifest["upstreamTag"] == tag
            and out("git", "log", "-1", "--format=%s").startswith(BUMP_SUBJECT))


def update_source(tag, remote, unattended):
    manifest = json.loads(MANIFEST.read_text())
    on_tag = subprocess.run(["git", "merge-base", "--is-ancestor", tag, "HEAD"], cwd=ROOT).returncode == 0
    if not on_tag:
        print(f"Rebasing personal patches from {manifest['upstreamTag']} onto {tag}")
        if subprocess.run(["git", "rebase", "--onto", tag, manifest["upstreamTag"]], cwd=ROOT).returncode:
            if unattended:
                subprocess.run(["git", "rebase", "--abort"], cwd=ROOT, check=False)
                raise SystemExit(f"Rebase onto {tag} conflicts; ask an agent to run the upgrade "
                                 "(see AGENTS.md, Personal fork).")
            raise SystemExit("Rebase stopped on a conflict. Resolve it, run `git rebase --continue`, "
                             "then run this command again.")
    manifest["version"] = next_version(manifest["version"], tag)
    manifest["upstreamTag"] = tag
    manifest["upstreamCommit"] = out("git", "rev-parse", f"{tag}^{{commit}}")
    if remote:
        manifest["linuxRuntimeSha256"] = linux_runtime_sha(tag)
    MANIFEST.write_text(json.dumps(manifest, indent=2) + "\n")
    run(vp(), "i")
    run("git", "add", str(MANIFEST), "pnpm-lock.yaml")
    message = f"{BUMP_SUBJECT}{manifest['version']} on {tag}"
    # One version commit stays at the tip instead of accumulating with every build.
    amend = ["--amend"] if out("git", "log", "-1", "--format=%s").startswith(BUMP_SUBJECT) else []
    run("git", "commit", "--no-verify", *amend, "-m", message)
    return manifest


def install_remote(host, directory, version, commit):
    script = f"""set -eu
cd {directory}
git fetch -q origin
git checkout -q --detach {commit}
VP="${{T3_PERSONAL_VP:-$(command -v vp || echo "$HOME/.t3/build-tools/vite-plus/bin/vp")}}"
export PATH="$(dirname "$VP"):$PATH"
"$VP" i --frozen-lockfile
if command -v patchelf >/dev/null; then
  python3 scripts/personal/build.py cli
else
  nix --extra-experimental-features "nix-command flakes" shell nixpkgs#patchelf \
    --command python3 scripts/personal/build.py cli
fi
archive="$PWD/release/personal/cli/t3-{version}-linux-x64.tar.gz"
mkdir -p "$HOME/.t3/runtime/versions"
staging="$(mktemp -d "$HOME/.t3/runtime/versions/.staging-XXXXXX")"
tar -xzf "$archive" -C "$staging" --strip-components=1
"$staging/t3" --version >/dev/null
printf '%s\\n' {version} > "$staging/.install-complete"
rm -rf "$HOME/.t3/runtime/versions/{version}"
mv "$staging" "$HOME/.t3/runtime/versions/{version}"
# Keep this runtime and the one before it, and any other a running server still executes.
ls -1t "$HOME/.t3/runtime/versions" | grep -v '^[.]' | tail -n +3 | while read -r old; do
  pgrep -f "[r]untime/versions/$old/" >/dev/null || rm -rf "$HOME/.t3/runtime/versions/$old"
done
echo "Installed t3 {version} runtime on $(hostname)"
"""
    run("ssh", host, "bash -lc " + shlex.quote(script))


# electron-builder's own signer, without hardened runtime: that only matters for notarization.
SIGN_SCRIPT = """
const builder = require.resolve("app-builder-lib/package.json",
  { paths: [require.resolve("electron-builder/package.json")] });
const { signAsync } = require(require.resolve("@electron/osx-sign", { paths: [builder] }));
const [app, identity] = process.argv.slice(1);
signAsync({ app, identity, platform: "darwin", type: "distribution", preAutoEntitlements: false,
  optionsForFile: () => ({ hardenedRuntime: false }) })
  .catch((error) => { console.error(error); process.exit(1); });
"""


def signing_identity():
    if "T3_PERSONAL_SIGN_IDENTITY" in os.environ:
        return os.environ["T3_PERSONAL_SIGN_IDENTITY"] or None
    identities = out("security", "find-identity", "-v", "-p", "codesigning")
    match = re.search(r'"(Developer ID Application: [^"]+)"', identities)
    return match.group(1) if match else None


def sign_app(app):
    """A Developer ID signature lets 1Password trust T3 as a browser and keeps Keychain access stable."""
    identity = signing_identity()
    if identity is None:
        print("No Developer ID Application identity; the app stays ad-hoc signed")
        return
    print(f"Signing with {identity}")
    run("node", "-e", SIGN_SCRIPT, str(app), identity, cwd=ROOT / "apps/desktop")
    run("codesign", "--verify", "--deep", "--strict", str(app))


def staged_app(version):
    arch = "arm64" if platform.machine() == "arm64" else "x64"
    archive = ROOT / f"release/personal/desktop/T3-Code-{version}-{arch}.zip"
    staging = BACKUPS / f"staged-{version}"
    shutil.rmtree(staging, ignore_errors=True)
    staging.mkdir(parents=True)
    run("ditto", "-x", "-k", str(archive), str(staging))
    apps = list(staging.glob("*.app"))
    if len(apps) != 1:
        raise SystemExit(f"Expected one app in {archive}")
    sign_app(apps[0])
    return apps[0]


def t3_running():
    # Waiting only; nothing is ever signalled by this match. A failed ps reads as running.
    listing = subprocess.run(["ps", "-axo", "command="], capture_output=True, text=True)
    if listing.returncode != 0:
        return True
    prefix = f"{APP}/Contents/MacOS/"
    return any(line.startswith(prefix) for line in listing.stdout.splitlines())


def back_up_userdata(target):
    def skip(directory, names):
        return {n for n in names if n == "logs" or ".sqlite" in n}
    shutil.copytree(USERDATA, target, ignore=skip, symlinks=True)
    for database in USERDATA.glob("*.sqlite"):
        source = sqlite3.connect(f"file:{database}?mode=ro", uri=True)
        destination = sqlite3.connect(target / database.name)
        with destination:
            source.backup(destination)
        source.close()
        destination.close()


def finish_install(new_app):
    new_app = Path(new_app)
    HELPER_PID.write_text(str(os.getpid()))
    while t3_running():
        time.sleep(1)
    # A newer build stops only helpers still waiting, never one moving the app.
    HELPER_PID.unlink(missing_ok=True)
    old_version = out("defaults", "read", str(APP / "Contents/Info"),
                      "CFBundleShortVersionString") if APP.exists() else "none"
    backup = BACKUPS / f"{time.strftime('%Y%m%d-%H%M%S')}-from-{old_version}"
    backup.mkdir(parents=True)
    if USERDATA.exists():
        back_up_userdata(backup / "userdata")
    if APP.exists():
        shutil.move(str(APP), backup / APP.name)
    try:
        shutil.move(str(new_app), APP)
    except BaseException:
        if (backup / APP.name).exists() and not APP.exists():
            shutil.move(str(backup / APP.name), APP)
        raise
    shutil.rmtree(new_app.parent, ignore_errors=True)
    old = sorted(p for p in BACKUPS.iterdir() if p.is_dir() and not p.name.startswith("staged-"))
    for stale in old[:-KEEP_BACKUPS]:
        shutil.rmtree(stale, ignore_errors=True)
    print(f"Installed {APP.name}; previous app and data are in {backup}")
    run("open", str(APP))


def replace_pending_install():
    """A newer build supersedes one still waiting for T3 to quit."""
    try:
        pid = int(HELPER_PID.read_text())
        command = out("ps", "-o", "command=", "-p", str(pid))
    except (FileNotFoundError, ValueError, subprocess.CalledProcessError):
        return
    if "--finish-install" in command:
        os.kill(pid, 15)


def install_mac(version, unattended):
    replace_pending_install()
    new_app = staged_app(version)
    for stale in BACKUPS.glob("staged-*"):
        if stale != new_app.parent:
            shutil.rmtree(stale, ignore_errors=True)
    if not t3_running():
        finish_install(new_app)
        return
    log = BACKUPS / "install.log"
    arm_install_helper(new_app, log)
    message = f"T3 {version} is ready. Quit T3 to install it; it reopens on its own."
    notify(message) if unattended else print(f"{message} Log: {log}")


def arm_install_helper(new_app, log):
    domain = f"gui/{os.getuid()}"
    target = f"{domain}/{INSTALL_LABEL}"
    # A helper already moving the app has dropped its pid file; let it finish first.
    while "state = running" in subprocess.run(["launchctl", "print", target],
                                               capture_output=True, text=True).stdout:
        time.sleep(1)
    subprocess.run(["launchctl", "bootout", target], stderr=subprocess.DEVNULL, check=False)
    INSTALL_PLIST.write_bytes(plistlib.dumps({
        "Label": INSTALL_LABEL,
        "ProgramArguments": [sys.executable, str(Path(__file__).resolve()),
                             "--finish-install", str(new_app)],
        "RunAtLoad": True,
        "StandardOutPath": str(log),
        "StandardErrorPath": str(log),
    }))
    run("launchctl", "bootstrap", domain, str(INSTALL_PLIST))


def schedule(at, args):
    hour, minute = (int(part) for part in at.split(":"))
    SCHEDULE_PLIST.parent.mkdir(parents=True, exist_ok=True)
    SCHEDULE_LOG.parent.mkdir(parents=True, exist_ok=True)
    plist = {
        "Label": SCHEDULE_LABEL,
        "ProgramArguments": [sys.executable, str(Path(__file__).resolve()), "--unattended",
                             *[option for host in args.remote for option in ("--remote", host)],
                             "--remote-dir", args.remote_dir,
                             *(["--skip-checks"] if args.skip_checks else [])],
        "WorkingDirectory": str(ROOT),
        "EnvironmentVariables": {"PATH": os.environ.get("PATH", "/usr/bin:/bin")},
        "StartCalendarInterval": {"Hour": hour, "Minute": minute},
        "StandardOutPath": str(SCHEDULE_LOG),
        "StandardErrorPath": str(SCHEDULE_LOG),
    }
    unschedule()
    SCHEDULE_PLIST.write_bytes(plistlib.dumps(plist))
    run("launchctl", "bootstrap", f"gui/{os.getuid()}", str(SCHEDULE_PLIST))
    print(f"Upgrades run daily at {at}: {' '.join(plist['ProgramArguments'])}\nLog: {SCHEDULE_LOG}")


def unschedule():
    if SCHEDULE_PLIST.exists():
        subprocess.run(["launchctl", "bootout", f"gui/{os.getuid()}", str(SCHEDULE_PLIST)],
                       stderr=subprocess.DEVNULL, check=False)
        SCHEDULE_PLIST.unlink()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--tag", help="upstream tag (default: newest nightly)")
    parser.add_argument("--remote", action="append", default=[],
                        help="SSH host that runs a T3 server for this Mac; repeatable")
    parser.add_argument("--remote-dir", default="code/t3code-personal",
                        help="checkout of this fork on each remote, relative to its home")
    parser.add_argument("--skip-checks", action="store_true")
    parser.add_argument("--no-install", action="store_true")
    parser.add_argument("--force", action="store_true",
                        help="rebuild even when already on the target tag")
    parser.add_argument("--unattended", action="store_true",
                        help="abort conflicting rebases and report through notifications")
    parser.add_argument("--schedule", metavar="HH:MM",
                        help="run these options daily with --unattended, then exit")
    parser.add_argument("--unschedule", action="store_true")
    parser.add_argument("--finish-install", help=argparse.SUPPRESS)
    args = parser.parse_args()
    if args.finish_install:
        finish_install(args.finish_install)
        return
    if args.unschedule:
        unschedule()
        return
    if args.schedule:
        schedule(args.schedule, args)
        return
    try:
        upgrade(args)
    except BaseException as error:
        if args.unattended and not isinstance(error, KeyboardInterrupt):
            notify(f"Upgrade failed: {error}. Log: {SCHEDULE_LOG}")
        raise


def upgrade(args):
    if platform.system() != "Darwin":
        raise SystemExit("Run this on the Mac")
    if out("git", "status", "--porcelain", "--untracked-files=no"):
        raise SystemExit("Commit or stash changes first")
    run("git", "fetch", "-q", "upstream", "--tags", "--force")
    tag = args.tag or latest_nightly()
    if up_to_date(tag) and not args.force:
        print(f"Already on {tag}; --force rebuilds")
        return
    manifest = update_source(tag, args.remote, args.unattended)
    version = manifest["version"]
    if not args.skip_checks:
        run(vp(), "run", "check:changed", tag, env=CHECK_ENV)
    run(sys.executable, "scripts/personal/build.py", "desktop")
    if args.remote:
        branch = out("git", "branch", "--show-current")
        run("git", "push", "--force-with-lease", "origin", f"HEAD:{branch}")
        commit = out("git", "rev-parse", "HEAD")
        for host in args.remote:
            install_remote(host, args.remote_dir, version, commit)
    if not args.no_install:
        install_mac(version, args.unattended)


if __name__ == "__main__":
    main()

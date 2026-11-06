#!/usr/bin/env python3
"""Build the personal distribution using upstream packaging and locked dependencies."""
import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import platform
import shutil
import subprocess
import tarfile
import tempfile

ROOT = Path(__file__).resolve().parents[2]
RELEASE = json.loads((ROOT / "scripts/personal/release.json").read_text())
MANIFESTS = ["apps/server/package.json", "apps/desktop/package.json",
             "apps/web/package.json", "packages/contracts/package.json"]


def run(*args):
    subprocess.run(args, cwd=ROOT, env=ENV, check=True)


def digest(path):
    with path.open("rb") as handle:
        return hashlib.file_digest(handle, "sha256").hexdigest()


def cli_archive(output):
    # The native dependencies stay pinned to the source baseline; JS and the executable rebuild.
    native_inputs = ["native", "pnpm-lock.yaml", "pnpm-workspace.yaml",
                     "apps/server/package.json", "scripts/lib/cli-external-packages.ts"]
    subprocess.run(["git", "diff", "--quiet", RELEASE["upstreamCommit"], "--",
                    *native_inputs], cwd=ROOT, check=True)
    version = RELEASE["version"]
    base = RELEASE["upstreamTag"].removeprefix("v")
    cache = Path.home() / ".cache/t3-personal"
    cache.mkdir(parents=True, exist_ok=True)
    template = cache / f"t3-{base}-linux-x64.tar.gz"
    if not template.exists():
        temporary = template.with_suffix(".download")
        run("curl", "-fL", "--retry", "3", "-o", str(temporary),
            f"https://github.com/pingdotgg/t3code/releases/download/{RELEASE['upstreamTag']}/{template.name}")
        if digest(temporary) != RELEASE["linuxRuntimeSha256"]:
            temporary.unlink()
            raise SystemExit("Upstream runtime checksum mismatch")
        temporary.rename(template)
    if digest(template) != RELEASE["linuxRuntimeSha256"]:
        raise SystemExit("Cached runtime checksum mismatch")
    originals = {path: (ROOT / path).read_bytes() for path in MANIFESTS}
    try:
        run("vp", "exec", "node", "scripts/update-release-package-versions.ts", version)
        run("vp", "run", "--filter", "t3", "build")
        run("vp", "run", "--filter", "t3", "build:exe")
    finally:
        for path, contents in originals.items():
            (ROOT / path).write_bytes(contents)
    with tempfile.TemporaryDirectory(prefix="t3-personal-") as staging:
        stage = Path(staging)
        with tarfile.open(template) as archive:
            archive.extractall(stage, filter="data")
        old = stage / f"t3-{base}-linux-x64"
        runtime = stage / f"t3-{version}-linux-x64"
        old.rename(runtime)
        shutil.copy2(ROOT / "apps/server/dist-exe/t3", runtime / "t3")
        run("patchelf", "--set-rpath", "$ORIGIN/lib", str(runtime / "t3"))
        shutil.rmtree(runtime / "client")
        shutil.copytree(ROOT / "apps/server/dist/client", runtime / "client")
        result = subprocess.check_output([str(runtime / "t3"), "--version"], text=True)
        if version not in result:
            raise SystemExit(f"Unexpected CLI build identity: {result}")
        artifact = output / f"t3-{version}-linux-x64.tar.gz"
        with tarfile.open(artifact, "w:gz") as archive:
            archive.add(runtime, arcname=runtime.name)


parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("target", choices=["desktop", "cli"])
args = parser.parse_args()
subprocess.run(["git", "merge-base", "--is-ancestor", RELEASE["upstreamCommit"], "HEAD"],
               cwd=ROOT, check=True)
ENV = dict(os.environ)
vp = ENV.get("T3_PERSONAL_VP") or shutil.which("vp") or str(
    Path.home() / ".t3/build-tools/vite-plus/bin/vp")
ENV["PATH"] = str(Path(vp).resolve().parent) + os.pathsep + ENV.get("PATH", "")
node_version = json.loads((ROOT / "package.json").read_text())["engines"]["node"]
run("vp", "env", "install", node_version)
vp_home = Path(ENV.get("VP_HOME", str(Path(vp).resolve().parents[1])))
node = vp_home / "js_runtime/node" / node_version / "bin/node"
if not node.is_file():
    raise SystemExit(f"Cannot find the managed Node {node_version} in {vp_home}")
actual_version = subprocess.check_output([str(node), "--version"], text=True).strip()
if actual_version != f"v{node_version}":
    raise SystemExit(f"Expected Node {node_version}, found {actual_version}")
ENV["PATH"] = str(node.parent) + os.pathsep + ENV["PATH"]
if args.target == "desktop":
    ENV["RUSTUP_TOOLCHAIN"] = RELEASE["rustToolchain"]
# These are public vendor settings, not credentials; private overrides stay in ignored env files.
for line in (ROOT / ".env.example").read_text().splitlines():
    key, separator, value = line.partition("=")
    if separator and key in {"T3CODE_CLERK_PUBLISHABLE_KEY", "T3CODE_CLERK_JWT_TEMPLATE",
                             "T3CODE_CLERK_CLI_OAUTH_CLIENT_ID", "T3CODE_RELAY_URL"}:
        ENV.setdefault(key, value)
ENV["APP_VERSION"] = RELEASE["version"]
ENV["T3CODE_DESKTOP_UPDATE_REPOSITORY"] = RELEASE["repository"]
output = ROOT / "release/personal" / args.target
output.mkdir(parents=True, exist_ok=True)
lock_dir = ROOT / ".t3"
lock_dir.mkdir(exist_ok=True)
with (lock_dir / "personal-build.lock").open("w") as lock:
    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    if args.target == "desktop":
        if platform.system() != "Darwin":
            raise SystemExit("Build the desktop target on the Mac")
        run("vp", "run", "dist:desktop:dmg", "--build-version", RELEASE["version"],
            "--output-dir", str(output))
    else:
        if platform.system() != "Linux" or platform.machine() != "x86_64":
            raise SystemExit("Build the CLI target on a Linux x86_64 host")
        cli_archive(output)
    artifacts = {p.name: digest(p) for p in output.iterdir()
                 if p.is_file() and p.suffix in {".dmg", ".zip", ".gz"}}
    metadata = {**RELEASE, "sourceCommit": subprocess.check_output(
        ["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip(), "artifacts": artifacts}
    (output / "personal-build.json").write_text(json.dumps(metadata, indent=2) + "\n")
    print(json.dumps(metadata, indent=2))

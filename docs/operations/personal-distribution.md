# Personal distribution

The `codex/personal` branch carries the ACP history fix, preview browser extensions and
distribution configuration. It follows upstream's nightly tags, which carry the current UI.
Native imports use the agent-owned model instead of applying its new-session catalog default.
Retire this follow-up when upstream preserves model selection while importing and continuing native sessions.
`scripts/personal/release.json` pins the upstream tag, source commit, PR head, version and Linux
runtime checksum. Production data and machine configuration never belong in this repository.

## Preview browser extensions

Persistent preview profiles load Chrome Web Store extensions, and the first profile installs
1Password. Each profile signs in to 1Password on its own. `Cmd+Shift+X` in a preview page opens
the popup; extension tabs open in their own windows. `T3CODE_PREVIEW_EXTENSIONS=0` turns this off.
Electron 44's native `browser` namespace lacks the APIs electron-chrome-extensions adds to
`chrome`, so `preview-extension-preload.ts` aliases one to the other. After bumping Electron or
that library, check that 1Password's service worker still starts and its popup loads.
Retire the patch when upstream ships extension support in the preview browser.

## OpenCode native history

For an ACP instance on each environment, set `nativeHistorySourceInstanceId` to that environment's
configured OpenCode 2 provider instance. This is an explicit bridge, and never assumes a port,
password, binary name or account. The existing native provider owns authentication and transport.
Native sessions and credentials remain on their original machine.

Opening or reimporting a chat repairs the old replay copy with native message IDs, tools, reasoning,
timestamps, attachments and compactions. Already opened chats refresh every minute while the T3
server runs. Reads wait for native and T3 activity to stop; a failed read retains the existing copy.
The native session itself is never opened, closed, prompted or modified for a history read.
Retire this bridge when upstream's ACP history API exposes equivalent structured records and
native identity, with tested refresh and preservation semantics.

## Upgrade this Mac

```sh
python3 scripts/personal/upgrade.py --remote vallor-dev
```

The command rebases the patches onto the newest nightly tag (or `--tag`), bumps the personal
version in one commit at the branch tip, runs `check:changed`, and builds the Mac app. With
`--remote`, it pushes the branch, builds the matching Linux runtime in that host's checkout and
installs it under `~/.t3/runtime/versions/`, so the SSH connection never downloads a release. The
Mac app is signed with the first `Developer ID Application` identity in the keychain
(`T3_PERSONAL_SIGN_IDENTITY` overrides; empty keeps ad-hoc) so 1Password's Add Browser accepts it,
then swapped in when T3 quits, and reopens; the previous app and a SQLite-API copy of
`~/.t3/userdata` stay in `~/.t3/personal-backups/` (last three). On a rebase conflict, resolve it,
run `git rebase --continue`, and rerun the command. Publishing a release stays optional.

## Build

Install the upstream prerequisites, the manifest's Rust toolchain with `rustup toolchain install`,
and run `vp i --frozen-lockfile`. The helper selects the repository's exact Node version through
the Vite+ managed runtime directory, validates it, and leaves system defaults unchanged. Build from a committed
checkout, using the same commit on both hosts:

```sh
python3 scripts/personal/build.py desktop  # macOS: DMG, ZIP and update feed
python3 scripts/personal/build.py cli      # Linux x86_64: runtime archive
```

The Linux build compiles the server executable and web client. It reuses the checksum-pinned
upstream archive's unchanged native dependencies, resource monitor and libatomic license.
The build refuses native/dependency changes relative to the baseline, apart from new lockfile
entries such as desktop-only dependencies. Such changes require
upstream's full CLI archive build in a supported Linux packaging environment instead.

Artifacts and a source/checksum receipt appear under ignored `release/personal/`.
Package version alignment is temporary and restored after compilation, including failed builds.
The desktop feed and CLI downloads both point to this fork, keeping official updates from
replacing personal patches. Unsigned Mac builds may require manual installation of later DMGs.

## Move to a newer upstream release

Create an update branch. Pick the newest `v*-nightly.*` tag, or a stable tag to leave nightly.
Rebase the small patch series onto it, resolving
conflicts against upstream's intent. Remove the ACP patch when upstream ships an equivalent fix.

```sh
git fetch upstream --tags
git switch -c codex/update-t3
git rebase --onto <new-tag> <old-tag>
```

Update the manifest's upstream tag/commit, personal version and Linux archive SHA-256 from
the official release's asset digest. Run `vp run check:changed <new-tag>`, then repeat the real
ACP import and continuation test against isolated state. Check first import, repeated import,
history retention across a fork, and an already-attached thread. The upstream replay importer excludes threads with T3 turns. The explicit OpenCode bridge
reads the native API without opening an ACP session, reconciles imported rows through the event
store, and preserves run-owned rows. It uses native user-message IDs from ACP echoes and native assistant-message IDs embedded
in ACP item identities to avoid duplicating T3 turns, including weak turn refs. Validate that correlation when updating either ACP implementation.

Commit, push, and build both hosts from that commit. Tag it with `v<personal-version>`. Publish
the DMG, ZIP, `latest-mac.yml`, Linux runtime archive, SHA256SUMS and build receipts to a release
in this fork. Include only compiled code and public build configuration.

## Install and recover

Before changing binaries, stop T3 on both hosts and back up each host's own T3 home and Mac
Electron profile. Preserve hidden files, secrets, attachments and environment IDs. Use SQLite's
backup API for online snapshots; never copy a live SQLite file without its WAL. Keep credentials
on their original host. Do not run a development server against production state.

Keep a copy of the previous Mac app. Replace the app at the same path and bundle ID. On the
remote host, extract the matching archive into `~/.t3/runtime/versions/<personal-version>/`;
the desktop SSH connection uses that version automatically. Keep the previous runtime directory.
Existing chats, settings and SSH connection definitions remain in their original data directories.

After reopening, compare saved chat IDs/content and settings with the snapshot, verify both build
versions and the remote connection, then import and continue a disposable native OpenCode chat.
Keep the source/checksum receipts with the private installation record.

To recover, stop both T3 runtimes and reinstall the previous Mac app/runtime. If a later upstream
version migrated the database, restore that host's entire pre-upgrade data snapshot as well;
replacing only the binary does not undo database migrations. Retain the newer snapshot separately.

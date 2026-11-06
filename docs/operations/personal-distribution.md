# Personal distribution

The `codex/personal` branch carries the ACP history fix and distribution configuration.
`scripts/personal/release.json` pins the upstream tag, source commit, PR head, version and Linux
runtime checksum. Production data and machine configuration never belong in this repository.

## Build

Install the upstream prerequisites, the manifest's Rust toolchain with `rustup toolchain install`,
and run `vp i --frozen-lockfile`. The helper selects the repository's exact Node version through
`vp env exec` without changing system defaults. Build from a committed
checkout, using the same commit on both hosts:

```sh
python3 scripts/personal/build.py desktop  # macOS: DMG, ZIP and update feed
python3 scripts/personal/build.py cli      # Linux x86_64: runtime archive
```

The Linux build compiles the server executable and web client. It reuses the checksum-pinned
upstream archive's unchanged native dependencies, resource monitor and libatomic license.
The build refuses native/dependency changes relative to the baseline. Such changes require
upstream's full CLI archive build in a supported Linux packaging environment instead.

Artifacts and a source/checksum receipt appear under ignored `release/personal/`.
Package version alignment is temporary and restored after compilation, including failed builds.
The desktop feed and CLI downloads both point to this fork, keeping official updates from
replacing personal patches. Unsigned Mac builds may require manual installation of later DMGs.

## Move to a newer upstream release

Create an update branch. Rebase the small patch series onto the new upstream tag, resolving
conflicts against upstream's intent. Remove the ACP patch when upstream ships an equivalent fix.

```sh
git fetch upstream --tags
git switch -c codex/update-t3
git rebase --onto <new-tag> <old-tag>
```

Update the manifest's upstream tag/commit, personal version and Linux archive SHA-256 from
the official release's asset digest. Run `vp run check:changed <new-tag>`, then repeat the real
ACP import and continuation test against isolated state. Check first import, repeated import,
history retention across a fork, and an already-attached thread. Existing threads with T3 turns
are intentionally excluded from history backfill by the upstream patch.

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

---
paths:
  - "scripts/build.ts"
  - "install.sh"
  - "src/core/update.ts"
  - "src/services/Releases.ts"
  - "src/services/Host.ts"
  - "src/commands/update.ts"
  - "src/commands/doctor.ts"
  - "src/version.ts"
  - ".github/workflows/**"
  - "e2e/**"
---

# Distribution: binaries, releases, install, update

## Targets and the build

- Release targets are darwin arm64/x64 and linux x64/arm64 (glibc). musl and Windows are Deferred (OpenTUI needs `OPENTUI_LIBC=musl` at runtime on musl; Windows needs `install.ps1` and its own smoke job). Don't add a target without its smoke job.
- `scripts/build.ts` calls `Bun.build` with `compile` (minify, sourcemap, dotenv and bunfig autoload off, so a user's `.env` or `bunfig.toml` never changes the binary's behavior). `bun run build` builds the host binary to `dist/orx`; `bun run build:all` builds all four plus `dist/SHA256SUMS`. `dist/` is output: a hook denies hand edits.
- OpenTUI ships its native library as one optional package per platform (`@opentui/core-<os>-<arch>`). A build plugin replaces every non-target package import with an empty module, so each binary embeds exactly one native lib. A cross-build needs the target's package installed, so CI and `release.yml` run `bun install --os='*' --cpu='*'` before `build:all`; the build script refuses a target whose package is missing.
- `--version` is `VERSION` from `src/version.ts`, which reads `package.json` (bundled into the binary). A release tag must equal it; `release.yml` checks.

## Release

`release.yml` runs on a `v*` tag: the build job runs `bun run check` and `bun run build:all`; a smoke matrix (macos-latest, macos-15-intel, ubuntu-latest, ubuntu-24.04-arm) runs `orx --version` and `orx doctor --tui` on its own platform's binary; then `gh release create` publishes the four binaries, `SHA256SUMS`, and `install.sh`. Only that job has `contents: write`. Asset names are `orx-<platform>-<arch>` (`assetName` in `src/core/update.ts`); the build, `install.sh`, and `update` must agree on them.

## install.sh

A bash script with `set -euo pipefail`, run as `curl -fsSL .../install.sh | bash`: detect OS and arch, download the asset and `SHA256SUMS` to a temp dir, verify with `shasum -a 256` or `sha256sum`, stage the verified binary in `ORX_INSTALL_DIR` (default `~/.local/bin`) and rename it to `orx` within that directory (a rename on one filesystem is atomic, so a running `orx` is never half-written), and say what to add to `PATH` if the directory isn't on it. Fail loudly on an unsupported platform or a checksum mismatch; never install an unverified binary. `ORX_RELEASES_URL` points it at the stub releases server in tests.

## orx update

- `checkForUpdate` compares the latest release tag with `VERSION`; `--check` only reports.
- `applyUpdate` refuses when running from source (`Host.compiled` false: update the checkout instead), downloads the asset for `Host.platform`/`Host.arch`, verifies it against `SHA256SUMS` (a mismatch changes nothing and is `UpstreamUnavailable`, retryable), writes a temp file in the binary's own directory, `chmod 0o755`, and `rename`s it over the running binary. Never write in place: macOS kills a signed binary whose pages change under it, and a rename keeps the running process's inode. The temp file is removed if the rename fails.
- A `PlatformError` whose reason is `PermissionDenied` (EACCES, EPERM) is the tagged `PermissionDenied` (exit 6) with a hint (reinstall into a directory you own); other filesystem errors are defects.
- `Host` is the only way code learns the exec path, whether it's compiled, and the platform; `src/bin.ts` builds it (`import.meta.path` under `/$bunfs` means compiled). Tests pass their own.
- Releases reads `ORX_RELEASES_URL` and `ORX_RELEASES_REPO` on its own (`releasesConfig`), not through `AppConfig`, so a broken config file can't block the update that might fix it.

## e2e

`bun run e2e` builds `dist/orx`, then `bun test ./e2e` drives the compiled binary in a PTY against the stub OpenRouter and stub releases, with an env built from scratch (never inherited). It is the only check of the compiled binary: the embedded native lib, `$bunfs` paths, `--version`, stdout staying empty for a bad flag, exit 3 without a key, piped `ask --json`, a `.env` in the working directory being ignored, `orx ui` in a PTY, install.sh, and `update`. Keep it to those; behavior belongs in `tests/`.

## doctor

`orx doctor` (hidden) reports version, platform, compiled, paths, whether the key is set (never its value), and config errors, and never fails on bad config. `--tui` loads OpenTUI's native library and, at a terminal, creates and destroys a renderer: the release smoke uses it to prove a binary's TUI works on its platform.

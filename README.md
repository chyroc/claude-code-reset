# ccreset — Claude Code local state reset (CLI)

A tiny, **zero-dependency** Node.js CLI for inspecting and resetting the **local** data that
[Claude Code](https://claude.com/claude-code) stores on your own machine — login credentials,
cached account/entitlement state, the telemetry event buffer, and auto-backups.

It is the command-line equivalent of "sign out and clear the app's local data / do a clean
reinstall", without reinstalling anything. Linux and macOS.

> **What this is not.** It only manages files under your own `~/.claude` / `~/.claude.json`.
> It does **not** modify network, DNS, timezone, browser, or proxy settings, does not spoof
> identifiers (it simply deletes them so the official client regenerates its own), makes **zero
> network calls**, and contains no license server or telemetry of its own.

## Why

Claude Code keeps several kinds of local state that a normal "log out" may not fully clear:

- OAuth tokens in `~/.claude/.credentials.json`
- Account / identity / entitlement cache in `~/.claude.json`
  (`oauthAccount`, `userID`, `machineID`, `firstStartTime`, `numStartups`,
  `passesEligibility`, `extraUsage`, `metrics`)
- Unsent analytics events buffered in `~/.claude/telemetry/`
- Automatic backups in `~/.claude/backups/` that may contain plaintext copies of older state

`ccreset` lets you see exactly what's there, clear just the groups you want, and **automatically
snapshots everything first** so a reset is reversible.

## Install

Requires Node.js 18+.

```bash
git clone https://github.com/chyroc/claude-code-reset.git
cd claude-code-reset
npm link          # makes the `ccreset` command available
# …or run directly without linking:
node bin/ccreset.js status
```

## Usage

```text
ccreset status                     Show what local state exists (default, read-only)
ccreset reset [groups] [flags]     Reset selected groups (dry run without --apply)
ccreset snapshots                  List auto-created snapshots
ccreset restore <id|latest>        Restore files from a snapshot
```

Groups (default: `all`):

| group | effect |
|---|---|
| `auth` | delete `~/.claude/.credentials.json` (you'll need to log in again) |
| `account` | prune the account/identity/entitlement keys from `~/.claude.json`, keeping MCP servers, projects and other settings |
| `telemetry` | empty `~/.claude/telemetry/` |
| `backups` | delete `~/.claude/backups/*.backup.*` |

Flags:

- `--apply` — actually perform the reset (otherwise it's a dry-run preview)
- `-y, --yes` — skip the confirmation prompt
- `--no-snapshot` — do not back up before deleting (not recoverable)

### Examples

```bash
ccreset status                          # inspect, changes nothing
ccreset reset                           # dry-run preview of clearing everything
ccreset reset --apply                   # snapshot, then clear all groups
ccreset reset auth account --apply      # just sign out + clear account/billing cache
ccreset reset telemetry backups --apply # reclaim disk space from buffers
ccreset snapshots
ccreset restore latest                  # undo the last reset
```

## Safety model

- **Dry-run by default.** `reset` never changes anything without `--apply`.
- **Snapshot before mutate.** Before deleting, credentials / the global config / backups are copied
  into `~/.claude-reset-snapshots/<timestamp>/` (mode `0700`). Restore is one command.
- **Surgical, not a wipe.** The `account` group removes only the listed top-level keys from
  `~/.claude.json`; your MCP config, settings, and project state are preserved.
- **Path hardening.** Every target is resolved with `realpath`; symlinks that escape
  `~/.claude` (or `$CLAUDE_CONFIG_DIR`) are skipped, and paths on network shares / outside your
  home are never followed.
- **No fabricated values.** Identifiers are deleted, never invented — the official client
  regenerates its own on next launch, matching a genuinely clean first run.
- **Fully offline.** No network requests; snapshots never leave your machine.

Telemetry is the one group that is intentionally **not** snapshotted (it is a bulk, regenerable
event buffer); clearing it is not reversible, but it contains nothing needed to restore a session.

## Environment

- Honors `CLAUDE_CONFIG_DIR` (must be absolute) the same way Claude Code does.
- Snapshots always live in `~/.claude-reset-snapshots`, outside the config dir, so a "clear
  everything" run can never delete its own backup.

## Development

```bash
npm test     # node:test, runs entirely against a temporary HOME
```

## License

[MIT](LICENSE)

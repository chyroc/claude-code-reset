#!/usr/bin/env node
'use strict';

const { runReset, runRestore, ALL_GROUPS } = require('../lib/actions');
const { resolvePaths } = require('../lib/paths');
const { buildPlan, GROUPS } = require('../lib/targets');
const { listSnapshots } = require('../lib/snapshot');

const C = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
};
const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (c, s) => (useColor ? c + s + C.reset : s);

function humanBytes(n) {
  if (n < 1024) return `${n} B`;
  const u = ['KiB', 'MiB', 'GiB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(v >= 10 ? 0 : 1)} ${u[i]}`;
}

function parseFlags(argv) {
  const positional = [];
  const flags = new Set();
  const values = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (/^-/.test(a)) {
      const [k, inline] = a.replace(/^-+/, '').split('=');
      if (inline !== undefined) values[k] = inline;
      else if (argv[i + 1] && !/^-/.test(argv[i + 1])) values[k] = argv[(i += 1)];
      else flags.add(k);
    } else {
      positional.push(a);
    }
  }
  return { positional, flags, values };
}

function printStatus(p, plan) {
  console.log(paint(C.bold, 'Claude Code local state') + paint(C.dim, `  (config: ${p.configDir})`));
  console.log('');
  const rows = [
    ['auth', '~/.claude/.credentials.json', plan.auth, plan.auth.exists ? `${humanBytes(plan.auth.bytes)}` : '—'],
    ['account', '~/.claude.json  (pruned keys)', plan.account, plan.account.keysToRemove?.length ? `${plan.account.keysToRemove.length} keys` : 'no matching keys'],
    ['telemetry', '~/.claude/telemetry/', plan.telemetry, plan.telemetry.files ? `${plan.telemetry.files} files · ${humanBytes(plan.telemetry.bytes)}` : '—'],
    ['backups', '~/.claude/backups/', plan.backups, plan.backups.files ? `${plan.backups.files} files · ${humanBytes(plan.backups.bytes)}` : '—'],
  ];
  for (const [id, loc, info, detail] of rows) {
    const dot = info.exists ? paint(C.green, '●') : paint(C.dim, '○');
    console.log(`  ${dot} ${paint(C.cyan, id.padEnd(9))} ${paint(C.dim, loc)}`);
    if (info.exists) console.log(`      ${paint(C.dim, detail)}`);
    if (id === 'account' && info.keysToRemove?.length) {
      console.log(`      ${paint(C.yellow, 'will remove: ' + info.keysToRemove.join(', '))}`);
    }
  }
  console.log('');
}

function cmdStatus() {
  const p = resolvePaths();
  printStatus(p, buildPlan(p));
  console.log(paint(C.dim, 'Run `ccreset reset` (dry run) to preview, or add --apply to execute.'));
}

function cmdReset(args) {
  const groups = args.positional.length ? args.positional : ['all'];
  const apply = args.flags.has('apply') || args.flags.has('yes');
  const noSnapshot = args.flags.has('no-snapshot');
  const assumeYes = args.flags.has('yes') || args.flags.has('y');

  // Always compute the plan first (read-only) so we can show and confirm
  // before anything is mutated.
  const plan = runReset({ groups, apply: false, noSnapshot });
  printStatus(plan.paths, plan.before);

  if (!apply) {
    console.log(paint(C.yellow, C.bold + 'DRY RUN — no changes made.'));
    console.log(paint(C.dim, 'Selected groups: ' + plan.groups.join(', ')));
    console.log(paint(C.dim, 'Snapshots are created automatically before changes.'));
    console.log('');
    console.log('Execute with:  ' + paint(C.green, 'ccreset reset ' + plan.groups.join(' ') + ' --apply'));
    return 0;
  }

  if (!assumeYes) {
    process.stdout.write(paint(C.red, C.bold + '\nThis will modify/delete the local data shown above. Continue? [y/N] '));
    const buf = Buffer.alloc(1024);
    let n = 0;
    try {
      n = require('node:fs').readSync(0, buf, 0, buf.length);
    } catch {
      n = 0;
    }
    const ans = buf.toString('utf8', 0, n).trim().toLowerCase();
    if (ans !== 'y' && ans !== 'yes') {
      console.log(paint(C.dim, 'Aborted.'));
      return 1;
    }
  }

  // Confirmed — now perform the actual reset.
  const result = runReset({ groups, apply: true, noSnapshot });
  console.log(paint(C.green, C.bold + '\nDone.'));
  if (result.snapshot) {
    console.log(`  snapshot : ${paint(C.blue, result.snapshot.id)}  (restore with: ccreset restore ${result.snapshot.id})`);
  }
  if (result.changes.prunedKeys.length) {
    console.log(`  pruned   : ${result.changes.prunedKeys.join(', ')}`);
  }
  for (const r of result.changes.removed) console.log(`  removed  : ${r}`);
  if (result.changes.freedBytes) console.log(`  freed    : ${humanBytes(result.changes.freedBytes)}`);
  if (!result.snapshot && result.changes.removed.length) {
    console.log(paint(C.yellow, '  (no snapshot created — --no-snapshot was set; changes are not recoverable)'));
  }
  console.log(paint(C.dim, '\nRestart Claude Code; it regenerates fresh local identifiers as on a clean install.'));
  return 0;
}

function cmdSnapshots() {
  const p = resolvePaths();
  const snaps = listSnapshots(p.snapshotRoot);
  if (!snaps.length) {
    console.log(paint(C.dim, 'No snapshots yet. A snapshot is created before every applied reset.'));
    return;
  }
  console.log(paint(C.bold, 'Snapshots') + paint(C.dim, `  (${p.snapshotRoot})`) + '\n');
  for (const s of snaps) {
    const when = s.manifest?.createdAt ? new Date(s.manifest.createdAt).toISOString().replace('T', ' ').replace(/\..+/, ' UTC') : '?';
    const files = (s.manifest?.files || []).map((f) => f.rel).join(', ') || '';
    console.log(`  ${paint(C.blue, s.id)}  ${paint(C.dim, humanBytes(s.files).padStart(9))}  ${when}`);
    if (files) console.log(`      ${paint(C.dim, files)}`);
  }
  console.log(paint(C.dim, '\nRestore the newest with:  ccreset restore latest'));
}

function cmdRestore(args) {
  const id = args.positional[0] || 'latest';
  const result = runRestore(id);
  console.log(paint(C.green, C.bold + `Restored from ${result.snapshot}:`));
  for (const r of result.restored) console.log(`  ${r}`);
}

function usage() {
  console.log(`ccreset — inspect & reset Claude Code local state (Linux/macOS)

${paint(C.bold, 'USAGE')}
  ccreset status                     Show what local state exists (default, read-only)
  ccreset reset [groups] [flags]     Reset selected groups (dry run without --apply)
  ccreset snapshots                  List auto-created snapshots
  ccreset restore <id|latest>        Restore files from a snapshot

${paint(C.bold, 'GROUPS')}
  ${ALL_GROUPS.map((g) => paint(C.cyan, g)).join('   ')}   ${paint(C.dim,('(default: all)'))}
  ${paint(C.dim, 'auth      ' + GROUPS.auth.description)}
  ${paint(C.dim, 'account   ' + GROUPS.account.description)}
  ${paint(C.dim, 'telemetry ' + GROUPS.telemetry.description)}
  ${paint(C.dim, 'backups   ' + GROUPS.backups.description)}

${paint(C.bold, 'FLAGS')}
  --apply          Actually perform the reset (otherwise dry run)
  -y, --yes        Skip the confirmation prompt
  --no-snapshot    Do not back up before deleting (not recoverable)

${paint(C.bold, 'EXAMPLES')}
  ccreset reset --apply                       Back up, then clear all groups
  ccreset reset auth account --apply          Only log-in + account/billing cache
  ccreset reset telemetry backups --apply     Free space from buffers/backups
  ccreset restore latest

${paint(C.dim, 'Snapshots are stored in ~/.claude-reset-snapshots and never uploaded anywhere.')}`);
}

function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0] && !argv[0].startsWith('--') ? argv[0] : 'status';
  const rest = parseFlags(argv.slice(1));

  try {
    switch (cmd) {
      case 'status':
      case 'ls':
      case 'plan':
        return cmdStatus();
      case 'reset':
      case 'clean':
      case 'clear':
        return cmdReset(rest);
      case 'snapshots':
      case 'snap':
        return cmdSnapshots();
      case 'restore':
        return cmdRestore(rest);
      case 'help':
      case '--help':
      case '-h':
        usage();
        return 0;
      default:
        console.error(paint(C.red, `Unknown command: ${cmd}`));
        usage();
        return 2;
    }
  } catch (error) {
    console.error(paint(C.red, 'Error: ') + (error && error.message ? error.message : String(error)));
    return 1;
  }
}

process.exitCode = main();

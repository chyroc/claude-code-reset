'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { resolvePaths, safeRealpath } = require('./paths');
const {
  buildPlan,
  planGlobalConfig,
  newSnapshotId,
  GROUPS,
} = require('./targets');
const { createSnapshot, listSnapshots, copyTree } = require('./snapshot');

const ALL_GROUPS = Object.keys(GROUPS); // ['auth','account','telemetry','backups']

/** Recursively delete a path that has already been validated to sit under root. */
function rmValidated(target) {
  fs.rmSync(target, { recursive: true, force: true, maxRetries: 3 });
}

/**
 * Build the concrete snapshot item list for the selected groups.
 * Credentials/global-config/backups are backed up; telemetry is not.
 */
function collectSnapshotItems(p, groups, plan) {
  const items = [];

  if (groups.includes('auth') && plan.auth.exists) {
    const real = safeRealpath(p.credentials, p.configDir);
    if (real) {
      items.push({
        kind: 'file',
        abs: real,
        rel: 'config/.credentials.json',
        allowedRoot: p.configDir,
      });
    }
  }

  if (groups.includes('account') && plan.account.exists) {
    // Back up the original raw config so restore is byte-exact for that file.
    const raw = fs.readFileSync(p.globalConfig, 'utf8');
    items.push({ kind: 'rawfile', rel: 'home/.claude.json', raw });
  }

  if (groups.includes('backups') && plan.backups.exists && plan.backups.files > 0) {
    const real = safeRealpath(p.backupsDir, p.configDir);
    if (real) {
      items.push({
        kind: 'dir',
        abs: real,
        rel: 'config/backups',
        allowedRoot: p.configDir,
      });
    }
  }

  return items;
}

/**
 * Apply the selected reset groups.
 *
 * @param {object} opts
 * @param {string[]} opts.groups
 * @param {boolean} opts.apply - false = dry run (no changes, no snapshot)
 * @param {boolean} opts.noSnapshot
 * @param {NodeJS.ProcessEnv} [opts.env]
 */
function runReset(opts) {
  const groups = opts.groups.includes('all') ? ALL_GROUPS : opts.groups;
  for (const g of groups) {
    if (!ALL_GROUPS.includes(g)) throw new Error(`Unknown group: ${g}`);
  }

  const p = resolvePaths(opts.env);
  const plan = buildPlan(p);

  const before = {
    auth: plan.auth,
    account: plan.account,
    telemetry: plan.telemetry,
    backups: plan.backups,
  };

  // Dry run: just report.
  if (!opts.apply) {
    return { dryRun: true, groups, paths: p, before, snapshot: null, changes: null };
  }

  // Snapshot first (unless disabled).
  let snapshot = null;
  if (!opts.noSnapshot) {
    const items = collectSnapshotItems(p, groups, plan);
    if (items.length) {
      const id = newSnapshotId();
      snapshot = createSnapshot(p.snapshotRoot, items, id);
    }
  }

  const changes = { removed: [], prunedKeys: [], freedBytes: 0 };

  // auth
  if (groups.includes('auth') && plan.auth.exists) {
    const real = safeRealpath(p.credentials, p.configDir);
    if (real) {
      changes.freedBytes += plan.auth.bytes;
      rmValidated(real);
      changes.removed.push('~/.claude/.credentials.json');
    }
  }

  // account — prune specific keys, preserve everything else
  if (groups.includes('account') && plan.account.exists) {
    const realConfig = safeRealpath(p.globalConfig, p.home);
    if (realConfig) {
      const { next, removed } = planGlobalConfig(realConfig);
      if (removed.length) {
        const tmp = `${realConfig}.${process.pid}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 });
        fs.renameSync(tmp, realConfig);
        changes.prunedKeys = removed;
      }
    }
  }

  // telemetry — empty the directory contents, keep the directory itself
  if (groups.includes('telemetry') && plan.telemetry.exists) {
    const real = safeRealpath(p.telemetryDir, p.configDir);
    if (real) {
      changes.freedBytes += plan.telemetry.bytes;
      for (const name of fs.readdirSync(real)) {
        rmValidated(path.join(real, name));
      }
      changes.removed.push('~/.claude/telemetry/*');
    }
  }

  // backups — delete auto backup files
  if (groups.includes('backups') && plan.backups.exists) {
    const real = safeRealpath(p.backupsDir, p.configDir);
    if (real) {
      changes.freedBytes += plan.backups.bytes;
      for (const name of fs.readdirSync(real)) {
        rmValidated(path.join(real, name));
      }
      changes.removed.push('~/.claude/backups/*');
    }
  }

  return { dryRun: false, groups, paths: p, before, snapshot, changes };
}

/**
 * Restore a previous snapshot. Copies files back to their original locations.
 * Does NOT resurrect telemetry (it was never backed up).
 */
function runRestore(snapshotId, opts = {}) {
  const p = resolvePaths(opts.env);
  const snaps = listSnapshots(p.snapshotRoot);
  const snap = snapshotId === 'latest' ? snaps[0] : snaps.find((s) => s.id === snapshotId);
  if (!snap) throw new Error(`Snapshot not found: ${snapshotId}`);

  const storeRoot = path.join(snap.dir, 'files');
  const restored = [];

  const restoreTo = (rel, abs) => {
    const src = path.join(storeRoot, rel);
    if (!fs.existsSync(src)) return;
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    const st = fs.statSync(src);
    if (st.isDirectory()) {
      copyTree(src, abs);
    } else {
      fs.copyFileSync(src, abs);
      try {
        fs.chmodSync(abs, st.mode);
      } catch {
        /* ignore */
      }
    }
    restored.push(abs);
  };

  if (fs.existsSync(path.join(storeRoot, 'config/.credentials.json'))) {
    restoreTo('config/.credentials.json', p.credentials);
  }
  if (fs.existsSync(path.join(storeRoot, 'home/.claude.json'))) {
    restoreTo('home/.claude.json', p.globalConfig);
  }
  if (fs.existsSync(path.join(storeRoot, 'config/backups'))) {
    restoreTo('config/backups', p.backupsDir);
  }

  return { restored, snapshot: snap.id };
}

module.exports = { runReset, runRestore, ALL_GROUPS };

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

/**
 * Top-level keys in ~/.claude.json that carry account / identity / billing
 * state. Only these exact top-level fields are pruned; nested UI state that
 * happens to share a name (e.g. tipsHistoryByCommand.*.numStartups) is left
 * untouched.
 *
 * We DELETE these keys rather than writing fabricated values: once removed, the
 * official Claude Code client regenerates fresh identifiers on its next launch,
 * which is exactly the "clean reinstall" state.
 */
const GLOBAL_CONFIG_KEYS_TO_REMOVE = Object.freeze([
  // OAuth / account
  'oauthAccount',
  // Identifiers the client regenerates on first run
  'userID',
  'machineID',
  'firstStartTime',
  'numStartups',
  // Entitlement / billing / usage caches
  'passesEligibility',
  'extraUsage',
  'metrics',
]);

/** Groups the user can select independently. */
const GROUPS = Object.freeze({
  auth: {
    id: 'auth',
    title: 'Login credentials',
    description: 'Delete ~/.claude/.credentials.json (OAuth access/refresh tokens). You will need to log in again.',
  },
  account: {
    id: 'account',
    title: 'Account / identity / billing cache in ~/.claude.json',
    description:
      'Remove oauthAccount, userID, machineID, firstStartTime, numStartups, passesEligibility, extraUsage, metrics. ' +
      'Other config (MCP servers, settings, projects) is preserved. Client regenerates fresh IDs on next launch.',
  },
  telemetry: {
    id: 'telemetry',
    title: 'Telemetry event buffer',
    description: 'Empty ~/.claude/telemetry (unsent buffered analytics events). Regenerated automatically; not copied into snapshots.',
  },
  backups: {
    id: 'backups',
    title: 'Auto backups of ~/.claude.json',
    description: 'Delete ~/.claude/backups/*.backup.* which can contain plaintext copies of old account state.',
  },
});

/**
 * Read and prune the global config JSON. Pure: returns the next object plus the
 * list of keys actually removed. Never throws on missing file.
 *
 * @param {string} file
 * @returns {{raw:string|null, next:object, removed:string[]}}
 */
function planGlobalConfig(file) {
  let raw = null;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return { raw: null, next: {}, removed: [] };
    throw error;
  }
  const next = JSON.parse(raw);
  if (typeof next !== 'object' || next === null || Array.isArray(next)) {
    throw new Error(`${file} is not a JSON object; refusing to rewrite it.`);
  }
  const removed = [];
  for (const key of GLOBAL_CONFIG_KEYS_TO_REMOVE) {
    if (Object.prototype.hasOwnProperty.call(next, key)) {
      removed.push(key);
      delete next[key];
    }
  }
  return { raw, next, removed };
}

/** Recursively sum size and count of every file under a directory. */
function dirStats(target) {
  let files = 0;
  let bytes = 0;
  const stack = [target];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile()) {
        files += 1;
        try {
          bytes += fs.statSync(full).size;
        } catch {
          /* ignore raced deletions */
        }
      }
    }
  }
  return { files, bytes };
}

/**
 * Build a description of what currently exists and what each group would do.
 * Read-only.
 *
 * @param {ReturnType<typeof require('./paths').resolvePaths>} p
 */
function buildPlan(p) {
  const out = {};

  // auth
  try {
    const st = fs.statSync(p.credentials);
    out.auth = { exists: true, kind: 'file', files: 1, bytes: st.size };
  } catch {
    out.auth = { exists: false, kind: 'file', files: 0, bytes: 0 };
  }

  // account
  const gc = planGlobalConfig(p.globalConfig);
  out.account = {
    exists: gc.raw !== null,
    kind: 'json',
    bytes: gc.raw === null ? 0 : Buffer.byteLength(gc.raw),
    keysToRemove: gc.removed,
  };

  // telemetry
  try {
    const s = dirStats(p.telemetryDir);
    out.telemetry = { exists: fs.statSync(p.telemetryDir).isDirectory(), kind: 'dir', ...s };
  } catch {
    out.telemetry = { exists: false, kind: 'dir', files: 0, bytes: 0 };
  }

  // backups
  try {
    const s = dirStats(p.backupsDir);
    out.backups = { exists: fs.statSync(p.backupsDir).isDirectory(), kind: 'dir', ...s };
  } catch {
    out.backups = { exists: false, kind: 'dir', files: 0, bytes: 0 };
  }

  return out;
}

/** New snapshot id: UTC timestamp sortable + short random suffix. */
function newSnapshotId(now = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  const stamp =
    `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}` +
    `-${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}Z`;
  return `${stamp}-${crypto.randomBytes(3).toString('hex')}`;
}

module.exports = {
  GROUPS,
  GLOBAL_CONFIG_KEYS_TO_REMOVE,
  planGlobalConfig,
  buildPlan,
  dirStats,
  newSnapshotId,
};

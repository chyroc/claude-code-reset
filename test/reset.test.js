'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { resolvePaths } = require('../lib/paths');
const { runReset, runRestore } = require('../lib/actions');
const { planGlobalConfig } = require('../lib/targets');
const { listSnapshots } = require('../lib/snapshot');

function makeEnv() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ccreset-home-'));
  const env = { ...process.env, HOME: home, CLAUDE_CONFIG_DIR: '' };
  delete env.CLAUDE_CONFIG_DIR;
  return { home, env };
}

function seed(home) {
  const cfg = path.join(home, '.claude');
  fs.mkdirSync(path.join(cfg, 'telemetry'), { recursive: true });
  fs.mkdirSync(path.join(cfg, 'backups'), { recursive: true });

  // credentials
  fs.writeFileSync(
    path.join(cfg, '.credentials.json'),
    JSON.stringify({ accessToken: 'sekret-access', refreshToken: 'sekret-refresh' }),
    { mode: 0o600 },
  );

  // global config with account keys + unrelated config that must survive
  fs.writeFileSync(
    path.join(home, '.claude.json'),
    JSON.stringify(
      {
        oauthAccount: { email: 'old@example.com', stripe: { plan: 'pro' } },
        userID: 'user-old',
        machineID: 'machine-old',
        firstStartTime: '2026-01-01T00:00:00.000Z',
        numStartups: 42,
        passesEligibility: true,
        extraUsage: 99,
        metrics: { a: 1 },
        mcpServers: { keep: { command: 'x' } },
        projects: { keep: true },
      },
      null,
      2,
    ),
  );

  // telemetry buffer
  fs.writeFileSync(path.join(cfg, 'telemetry', '1p_failed_events_1.json'), '{"event":1}');
  fs.writeFileSync(path.join(cfg, 'telemetry', '1p_failed_events_2.json'), '{"event":2}');

  // auto backups
  fs.writeFileSync(path.join(cfg, 'backups', '.claude.json.backup.111'), 'old-plaintext');
  fs.writeFileSync(path.join(cfg, 'backups', '.claude.json.backup.222'), 'old-plaintext-2');

  return cfg;
}

test('dry run changes nothing', () => {
  const { home, env } = makeEnv();
  seed(home);
  const p = resolvePaths(env);
  const before = fs.readFileSync(p.globalConfig, 'utf8');

  const res = runReset({ groups: ['all'], apply: false, env });
  assert.equal(res.dryRun, true);
  assert.equal(fs.readFileSync(p.globalConfig, 'utf8'), before);
  assert.ok(fs.existsSync(p.credentials));
  assert.equal(fs.readdirSync(p.telemetryDir).length, 2);
  assert.equal(listSnapshots(p.snapshotRoot).length, 0);
});

test('apply removes credentials, prunes account keys, clears buffers', () => {
  const { home, env } = makeEnv();
  seed(home);
  const p = resolvePaths(env);

  const res = runReset({ groups: ['all'], apply: true, env });
  assert.equal(res.dryRun, false);

  assert.ok(!fs.existsSync(p.credentials), 'credentials deleted');
  assert.deepEqual(
    [...res.changes.prunedKeys].sort(),
    ['extraUsage', 'firstStartTime', 'machineID', 'metrics', 'numStartups', 'oauthAccount', 'passesEligibility', 'userID'].sort(),
  );

  const cfg = JSON.parse(fs.readFileSync(p.globalConfig, 'utf8'));
  assert.ok(!('oauthAccount' in cfg));
  assert.ok(!('machineID' in cfg));
  assert.ok(!('userID' in cfg));
  assert.deepEqual(cfg.mcpServers, { keep: { command: 'x' } }, 'unrelated config preserved');
  assert.equal(cfg.projects.keep, true);

  assert.equal(fs.readdirSync(p.telemetryDir).length, 0, 'telemetry emptied');
  assert.ok(fs.existsSync(p.telemetryDir), 'telemetry dir itself kept');
  assert.equal(fs.readdirSync(p.backupsDir).length, 0, 'backups emptied');

  const snaps = listSnapshots(p.snapshotRoot);
  assert.equal(snaps.length, 1, 'one snapshot created');
});

test('restore brings credentials and original global config back', () => {
  const { home, env } = makeEnv();
  seed(home);
  const p = resolvePaths(env);

  runReset({ groups: ['all'], apply: true, env });
  assert.ok(!fs.existsSync(p.credentials));

  const res = runRestore('latest', { env });
  assert.ok(res.restored.includes(p.credentials));
  assert.deepEqual(
    JSON.parse(fs.readFileSync(p.credentials, 'utf8')),
    { accessToken: 'sekret-access', refreshToken: 'sekret-refresh' },
  );
  const cfg = JSON.parse(fs.readFileSync(p.globalConfig, 'utf8'));
  assert.equal(cfg.machineID, 'machine-old');
  assert.equal(cfg.oauthAccount.email, 'old@example.com');
  const restoredBackups = fs.readdirSync(p.backupsDir);
  assert.equal(restoredBackups.length, 2);
});

test('individual groups: account only leaves credentials intact', () => {
  const { home, env } = makeEnv();
  seed(home);
  const p = resolvePaths(env);

  runReset({ groups: ['account'], apply: true, env });
  assert.ok(fs.existsSync(p.credentials), 'credentials untouched');
  assert.equal(fs.readdirSync(p.telemetryDir).length, 2, 'telemetry untouched');
  const cfg = JSON.parse(fs.readFileSync(p.globalConfig, 'utf8'));
  assert.ok(!('machineID' in cfg));
  assert.deepEqual(cfg.mcpServers, { keep: { command: 'x' } });
});

test('no-snapshot leaves no recovery point', () => {
  const { home, env } = makeEnv();
  seed(home);
  const p = resolvePaths(env);
  runReset({ groups: ['auth'], apply: true, noSnapshot: true, env });
  assert.equal(listSnapshots(p.snapshotRoot).length, 0);
});

test('symlink escaping config dir is not followed/deleted', () => {
  const { home, env } = makeEnv();
  const cfg = seed(home);
  const outside = path.join(home, 'outside-secret.txt');
  fs.writeFileSync(outside, 'do-not-touch');
  // credentials is a symlink pointing outside config dir
  fs.rmSync(path.join(cfg, '.credentials.json'));
  fs.symlinkSync(outside, path.join(cfg, '.credentials.json'));
  const p = resolvePaths(env);

  runReset({ groups: ['auth'], apply: true, env });
  assert.ok(fs.existsSync(outside), 'outside file preserved');
  assert.ok(fs.existsSync(p.credentials), 'dangling symlink left in place');
});

test('planGlobalConfig is tolerant when file absent', () => {
  const { home } = makeEnv();
  const r = planGlobalConfig(path.join(home, '.claude.json'));
  assert.equal(r.raw, null);
  assert.deepEqual(r.removed, []);
});

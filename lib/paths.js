'use strict';

const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

/**
 * Resolve every on-disk location this tool is allowed to touch.
 *
 * Honors CLAUDE_CONFIG_DIR the same way the Claude Code CLI does. Everything is
 * resolved to an absolute, symlink-real path up front so later checks cannot be
 * fooled by a symlink placed under ~/.claude.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{
 *   home: string,
 *   configDir: string,
 *   globalConfig: string,
 *   credentials: string,
 *   telemetryDir: string,
 *   backupsDir: string,
 *   snapshotRoot: string,
 * }}
 */
function resolvePaths(env = process.env) {
  // On POSIX os.homedir() honors HOME; prefer an explicitly passed env so the
  // module can be exercised against a sandboxed HOME without mutating process.env.
  const homeCandidate = process.platform === 'win32'
    ? env.USERPROFILE || os.homedir()
    : env.HOME || os.homedir();
  const home = path.resolve(homeCandidate);

  let configDir;
  if (typeof env.CLAUDE_CONFIG_DIR === 'string' && env.CLAUDE_CONFIG_DIR.trim()) {
    if (!path.isAbsolute(env.CLAUDE_CONFIG_DIR)) {
      throw new Error('CLAUDE_CONFIG_DIR must be an absolute path.');
    }
    configDir = path.resolve(env.CLAUDE_CONFIG_DIR);
  } else {
    configDir = path.join(home, '.claude');
  }

  // Snapshots live OUTSIDE the config dir so a "wipe everything" run can never
  // delete its own backup.
  const snapshotRoot = path.join(home, '.claude-reset-snapshots');

  return {
    home,
    configDir,
    globalConfig: path.join(home, '.claude.json'),
    credentials: path.join(configDir, '.credentials.json'),
    telemetryDir: path.join(configDir, 'telemetry'),
    backupsDir: path.join(configDir, 'backups'),
    snapshotRoot,
  };
}

/**
 * Resolve a path and refuse if it escapes the allowed root (defends against
 * hijacked symlinks). Returns the real path, or null if the path does not
 * exist / is not a regular directory-or-file we are allowed to manage.
 *
 * @param {string} target
 * @param {string} root
 * @returns {string|null}
 */
function safeRealpath(target, root) {
  let real;
  try {
    real = fs.realpathSync(target);
  } catch {
    return null; // does not exist
  }
  const rootReal = fs.realpathSync(root);
  if (real !== rootReal && !real.startsWith(rootReal + path.sep)) {
    return null;
  }
  return real;
}

module.exports = { resolvePaths, safeRealpath };

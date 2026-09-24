'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { safeRealpath } = require('./paths');

/** Recursively copy src -> dst, skipping symlinks, preserving file mode. */
function copyTree(src, dst) {
  const st = fs.lstatSync(src);
  if (st.isSymbolicLink()) return; // never follow/copy symlinks
  if (st.isDirectory()) {
    fs.mkdirSync(dst, { recursive: true, mode: st.mode });
    for (const name of fs.readdirSync(src)) {
      copyTree(path.join(src, name), path.join(dst, name));
    }
  } else if (st.isFile()) {
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst, fs.constants.COPYFILE_FICLONE);
    try {
      fs.chmodSync(dst, st.mode);
    } catch {
      /* best effort */
    }
  }
}

/**
 * Create a timestamped snapshot of the items about to be modified.
 *
 * Telemetry is intentionally NOT snapshotted (bulk regenerable buffer); pass it
 * only when explicitly requested via includeTelemetry=false default.
 *
 * @returns {{id:string, dir:string, items:string[], manifest:object}}
 */
function createSnapshot(snapshotRoot, items, id) {
  const dir = path.join(snapshotRoot, id);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

  const manifest = { id, createdAt: new Date().toISOString(), files: [] };
  const storeRoot = path.join(dir, 'files');
  const copied = [];

  for (const item of items) {
    // item: {kind:'file'|'dir', abs:string, rel:string}
    const real = safeRealpath(item.abs, item.allowedRoot);
    if (!real) continue; // missing or escapes root
    const dest = path.join(storeRoot, item.rel);
    if (item.kind === 'file') {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(real, dest);
      try {
        fs.chmodSync(dest, fs.statSync(real).mode);
      } catch {
        /* ignore */
      }
      manifest.files.push({ rel: item.rel, kind: 'file' });
    } else if (item.kind === 'dir') {
      copyTree(real, dest);
      manifest.files.push({ rel: item.rel, kind: 'dir' });
    }
    copied.push(item.rel);
  }

  // The original global config content (if pruned) is captured as raw text too,
  // passed via item.raw when present.
  for (const item of items) {
    if (item.kind === 'rawfile' && typeof item.raw === 'string') {
      const dest = path.join(storeRoot, item.rel);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, item.raw, { mode: 0o600 });
      manifest.files.push({ rel: item.rel, kind: 'file' });
      copied.push(item.rel);
    }
  }

  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2), {
    mode: 0o600,
  });
  return { id, dir, items: copied, manifest };
}

/** List snapshots, newest first, each with manifest and size. */
function listSnapshots(snapshotRoot) {
  let names;
  try {
    names = fs.readdirSync(snapshotRoot, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort()
      .reverse();
  } catch {
    return [];
  }
  return names.map((name) => {
    const dir = path.join(snapshotRoot, name);
    let manifest = null;
    try {
      manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
    } catch {
      /* leave null */
    }
    let bytes = 0;
    const stack = [path.join(dir, 'files')];
    while (stack.length) {
      const cur = stack.pop();
      let entries;
      try {
        entries = fs.readdirSync(cur, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of entries) {
        const full = path.join(cur, e.name);
        if (e.isDirectory()) stack.push(full);
        else {
          try {
            bytes += fs.statSync(full).size;
          } catch {
            /* ignore */
          }
        }
      }
    }
    return { id: name, dir, manifest, bytes };
  });
}

module.exports = { createSnapshot, listSnapshots, copyTree };

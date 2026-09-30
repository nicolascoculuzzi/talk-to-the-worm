// The site's own code, readable on the site: /docs shows it, /source/<path> serves each file as plain text.
// What can be served is fixed when the server starts: the text files found by walking a few folders, minus anything
// private (the data folder, the chat blocklist, .env files). A request's path is only ever looked up in that list by
// exact string, so nothing a visitor sends is ever joined onto a path on the disk.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { isUtf8 } from 'node:buffer';

export const SOURCE_FOLDERS = ['server', 'shared', 'public', 'scripts', 'test', 'data/registrations'];
export const SOURCE_ROOT_FILES = ['package.json', 'package-lock.json', 'README.md', 'CLAUDE.md', 'Dockerfile', 'render.yaml', '.env.example'];
export const MAX_SOURCE_BYTES = 1.5 * 1024 * 1024;
const TEXT_EXT = new Set(['.js', '.mjs', '.html', '.css', '.json', '.md', '.py', '.txt', '.svg', '.yaml', '.yml', '.jsonl']);
const TEXT_NAMES = new Set(['Dockerfile', '.env.example']);
const SKIP_DIRS = new Set(['node_modules', '.git', '.claude', 'var', 'config']);
const SKIP_FILES = new Set(['data/wiring.json', 'data/transmitters.json', 'data/morph.bin']);   // served at /data/ as they are
const NAME = /^[\w.@+-]+$/;   // names that need no escaping in a URL; anything else is left out
const TYPE = 'text/plain; charset=utf-8';   // every file as plain text, so no page, script or picture here ever renders
const NOFOLLOW = fs.constants.O_NOFOLLOW || 0;

/** Whether a relative path (with / separators) is one we would ever serve. */
export function sourceAllowed(rel) {
  if (typeof rel !== 'string' || SKIP_FILES.has(rel)) return false;
  const parts = rel.split('/'), base = parts[parts.length - 1];
  if (!parts.every((p) => NAME.test(p) && !p.includes('..'))) return false;
  if (parts.slice(0, -1).some((p) => SKIP_DIRS.has(p) || p.startsWith('.'))) return false;
  if (base.startsWith('.') && rel !== '.env.example') return false;   // hidden files (.env and the like) never
  return TEXT_NAMES.has(base) || TEXT_EXT.has(path.extname(base).toLowerCase());
}

// what a request may even ask for: no climbing out, no absolute paths, no backslashes
const plausible = (p) => typeof p === 'string' && p.length > 0 && p.length <= 512 && !p.includes('..') && !p.includes('\\')
  && !p.includes('\0') && !p.startsWith('/') && !path.isAbsolute(p) && !path.win32.isAbsolute(p);

function countLines(b) {
  let n = 0;
  for (let i = b.indexOf(10); i !== -1; i = b.indexOf(10, i + 1)) n++;
  return b.length && b[b.length - 1] !== 10 ? n + 1 : n;
}

/** A regular file's bytes if it is still text we serve; links are never followed. */
function readText(abs) {
  let fd;
  try {
    fd = fs.openSync(abs, fs.constants.O_RDONLY | NOFOLLOW);
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.size > MAX_SOURCE_BYTES) return null;
    const body = fs.readFileSync(fd);
    if (body.length > MAX_SOURCE_BYTES || body.includes(0) || !isUtf8(body)) return null;
    return { body, st };
  } catch {
    return null;
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch { /* already closed */ }
  }
}

function walk(root, rel, out) {
  let list;
  try { list = fs.readdirSync(path.join(root, ...rel.split('/')), { withFileTypes: true }); } catch { return; }
  list.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const d of list) {
    const r = `${rel}/${d.name}`;
    // a link is neither a file nor a folder here, so nothing outside the tree is ever reached
    if (d.isDirectory()) { if (!SKIP_DIRS.has(d.name) && !d.name.startsWith('.') && NAME.test(d.name)) walk(root, r, out); }
    else if (d.isFile() && sourceAllowed(r)) out.push(r);
  }
}

/**
 * @param {{ root: string, recheckMs?: number }} opts  root: the repository; index() looks for changed files at most
 *   every recheckMs (file() always does)
 */
export function createSource({ root, recheckMs = 1000 }) {
  const base = path.resolve(root);
  const entries = new Map();   // relative path -> {abs, body, sha256, etag, lines, mtimeMs, statSize, ino}
  let changed = true, cached = null, checkedAt = Date.now();

  function load(e, got) {
    const sha256 = crypto.createHash('sha256').update(got.body).digest('hex');
    Object.assign(e, { body: got.body, sha256, etag: `"${sha256}"`, lines: countLines(got.body), mtimeMs: got.st.mtimeMs, statSize: got.st.size, ino: got.st.ino });
    changed = true;
  }
  function drop(e) {
    if (e.body) { e.body = null; changed = true; }
    return false;
  }
  // re-read a file when it changed on disk (the server may run with node --watch); false when it can't be served now
  function fresh(e) {
    let st;
    try { st = fs.lstatSync(e.abs); } catch { return drop(e); }
    if (!st.isFile()) return drop(e);
    if (e.body && st.mtimeMs === e.mtimeMs && st.size === e.statSize && st.ino === e.ino) return true;
    const got = readText(e.abs);
    if (!got) return drop(e);
    load(e, got);
    return true;
  }

  // the allowlist, fixed now: these folders' text files, then the root files
  const found = [];
  for (const dir of SOURCE_FOLDERS) walk(base, dir, found);
  for (const name of SOURCE_ROOT_FILES) {
    try { if (fs.lstatSync(path.join(base, name)).isFile() && sourceAllowed(name)) found.push(name); } catch { /* not in this checkout */ }
  }
  for (const rel of found) {
    const e = { abs: path.join(base, ...rel.split('/')), body: null };
    const got = readText(e.abs);
    if (!got) continue;   // too big, not text, or gone
    load(e, got);
    entries.set(rel, e);
  }

  /** Every file we serve, in a fixed order: { files: [{path, size, lines, sha256}], total: {files, bytes, lines}, generatedAt } */
  function index() {
    const now = Date.now();
    if (now - checkedAt >= recheckMs) { checkedAt = now; for (const e of entries.values()) fresh(e); }
    if (changed || !cached) {
      changed = false;
      const files = [];
      let bytes = 0, lines = 0;
      for (const [rel, e] of entries) {
        if (!e.body) continue;
        files.push({ path: rel, size: e.body.length, lines: e.lines, sha256: e.sha256 });
        bytes += e.body.length; lines += e.lines;
      }
      cached = { files, total: { files: files.length, bytes, lines }, generatedAt: new Date().toISOString() };
    }
    return cached;
  }

  /** One allowlisted file, as served: { body, type, sha256, etag, size, lines }, or null. */
  function file(relPath) {
    if (!plausible(relPath)) return null;
    const e = entries.get(relPath);
    if (!e || !fresh(e)) return null;
    return { body: e.body, type: TYPE, sha256: e.sha256, etag: e.etag, size: e.body.length, lines: e.lines };
  }

  return { index, file };
}

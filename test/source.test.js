import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createSource, MAX_SOURCE_BYTES } from '../server/source.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');
const PRIVATE = /(^|\/)(node_modules|\.git|\.claude|var|config)\//;

// a small repository with everything the allowlist must leave out
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'source-'));
  const put = (rel, body) => {
    const f = path.join(dir, ...rel.split('/'));
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, body);
  };
  put('server/app.js', 'export const a = 1;\n');
  put('server/config.js', '// settings come from the environment\n');
  put('server/config/blocklist.txt', 'a config folder anywhere is private\n');
  put('server/node_modules/x/index.js', 'x');
  put('shared/sim.js', 'a\nb');
  put('public/docs.html', '<!doctype html>\n<title>x</title>\n');
  put('public/logo.svg', '<svg xmlns="http://www.w3.org/2000/svg"/>');
  put('public/pic.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]));
  put('public/nul.txt', 'a\0b');
  put('public/latin1.txt', Buffer.from([0x63, 0x61, 0x66, 0xe9]));   // not UTF-8
  put('public/big.json', `"${'x'.repeat(MAX_SOURCE_BYTES)}"`);
  put('public/.env', 'SECRET=1\n');
  put('public/.hidden.js', 'x');
  put('public/.git/HEAD', 'x');
  put('public/var/x.js', 'x');
  put('scripts/build.py', 'print(1)\n');
  put('test/fixtures/data.json', '{}\n');
  put('test/fixtures/blob.bin', 'x');
  put('data/registrations/model.json', '{}');
  put('data/registrations/model.json.ots', Buffer.from([0, 1, 2]));
  put('data/wiring.json', '{}');
  put('config/blocklist.txt', 'the chat blocklist\n');
  put('node_modules/ws/index.js', 'x');
  put('var/log.jsonl', '{}\n');
  put('.git/config', 'x');
  put('.claude/settings.json', '{}');
  put('.env', 'ADMIN_TOKEN=secret\n');
  put('.env.local', 'x');
  put('.env.example', 'PORT=3000\n');
  put('package.json', '{}\n');
  put('README.md', '# hi\n');
  put('Dockerfile', 'FROM node:22-alpine\n');
  put('notes.md', 'not one of the root files\n');
  fs.symlinkSync(path.join(dir, '.env'), path.join(dir, 'public', 'env.js'));    // a link to a secret
  fs.symlinkSync(path.join(dir, 'config'), path.join(dir, 'public', 'cfg'));     // a link to a private folder
  return dir;
}

test('the allowlist is the text files of the listed folders and root files, and nothing private', () => {
  const dir = fixture();
  try {
    const src = createSource({ root: dir });
    assert.deepEqual(src.index().files.map((f) => f.path), [
      'server/app.js', 'server/config.js', 'shared/sim.js', 'public/docs.html', 'public/logo.svg', 'scripts/build.py',
      'test/fixtures/data.json', 'data/registrations/model.json', 'package.json', 'README.md', 'Dockerfile', '.env.example',
    ]);
    assert.equal(src.file('shared/sim.js').body.toString(), 'a\nb');
    assert.equal(src.index().files.find((f) => f.path === 'shared/sim.js').lines, 2);
    assert.equal(src.index().files.find((f) => f.path === 'server/app.js').lines, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('file() serves only exact allowlisted paths, never anything derived from the request', () => {
  const dir = fixture();
  try {
    const src = createSource({ root: dir });
    const ok = src.file('server/app.js');
    assert.equal(ok.body.toString(), 'export const a = 1;\n');
    assert.equal(ok.type, 'text/plain; charset=utf-8');
    assert.equal(src.file('public/logo.svg').type, 'text/plain; charset=utf-8');   // served as text, so it never renders
    for (const p of [
      '../package.json', '/etc/passwd', 'server/../package.json', '.env', '.env.local', 'public/.env', 'config/blocklist.txt',
      'server/config/blocklist.txt', 'node_modules/ws/index.js', 'var/log.jsonl', '.git/config', 'public/env.js', 'public/cfg/blocklist.txt',
      'public/big.json', 'public/nul.txt', 'public/latin1.txt', 'public/pic.png', 'data/wiring.json', 'notes.md', 'server\\app.js', './server/app.js',
      'server//app.js', 'server/app.js/', 'SERVER/app.js', path.join(dir, 'server', 'app.js'), '', '__proto__', 'constructor', 'toString',
      null, undefined, 42, ['server/app.js'],
    ]) assert.equal(src.file(p), null, String(p));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a changed file is read again; a new, swapped or oversized one is not served', () => {
  const dir = fixture();
  try {
    const src = createSource({ root: dir, recheckMs: 0 });
    const f = path.join(dir, 'server', 'app.js');
    const before = src.file('server/app.js').sha256;
    fs.writeFileSync(f, 'export const a = 2; // changed\n');
    const after = src.file('server/app.js');
    assert.equal(after.body.toString(), 'export const a = 2; // changed\n');
    assert.notEqual(after.sha256, before);
    assert.equal(src.index().files.find((x) => x.path === 'server/app.js').sha256, sha256(after.body));

    fs.writeFileSync(path.join(dir, 'server', 'new.js'), 'x');   // the allowlist was fixed at start
    assert.equal(src.file('server/new.js'), null);

    fs.rmSync(f);
    assert.equal(src.file('server/app.js'), null);
    assert.ok(!src.index().files.some((x) => x.path === 'server/app.js'));
    fs.symlinkSync(path.join(dir, '.env'), f);                     // swapped for a link to a secret
    assert.equal(src.file('server/app.js'), null);
    fs.rmSync(f);
    fs.writeFileSync(f, 'back\n');
    assert.equal(src.file('server/app.js').body.toString(), 'back\n');

    fs.writeFileSync(path.join(dir, 'shared', 'sim.js'), 'x'.repeat(MAX_SOURCE_BYTES + 1));
    assert.equal(src.file('shared/sim.js'), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('this repository: the docs page and this module are listed, nothing private is, and every SHA-256 is of the bytes served', () => {
  const src = createSource({ root: ROOT });
  const ix = src.index();
  const paths = ix.files.map((f) => f.path);
  for (const p of ['server/source.js', 'public/docs.html', 'server/server.js', 'server/config.js', 'shared/sim.js', 'shared/model.js', 'package.json', 'data/registrations/model-v2.json']) {
    assert.ok(paths.includes(p), `${p} is listed`);
  }
  for (const p of paths) {
    assert.ok(!PRIVATE.test(p), `${p} is not private`);
    assert.ok(!p.split('/').pop().startsWith('.env') || p === '.env.example', `${p} is not an .env file`);
    assert.ok(!['data/wiring.json', 'data/transmitters.json', 'data/morph.bin'].includes(p), `${p} is served at /data/`);
  }
  assert.equal(new Set(paths).size, paths.length);
  let bytes = 0;
  for (const f of ix.files) {
    const got = src.file(f.path);
    assert.ok(got, f.path);
    assert.equal(sha256(got.body), f.sha256, f.path);
    assert.equal(got.sha256, f.sha256, f.path);
    assert.equal(got.body.length, f.size, f.path);
    assert.ok(got.body.equals(fs.readFileSync(path.join(ROOT, ...f.path.split('/')))), f.path);
    bytes += f.size;
  }
  assert.deepEqual([ix.total.files, ix.total.bytes], [ix.files.length, bytes]);
  assert.ok(!Number.isNaN(Date.parse(ix.generatedAt)));
});

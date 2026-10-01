import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import WebSocket from 'ws';
import { createWormServer } from '../server/server.js';
import { replayLog } from '../scripts/replay.js';
import { decodeFrame } from '../shared/frames.js';
import { createMirror, mirrorEvent } from '../shared/mirror.js';
import { loadD } from './data.js';

const N = 2675;
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function client(port) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/live`);
  const msgs = [], frames = [];
  ws.on('message', (data, isBinary) => {
    if (isBinary) { const bytes = new Uint8Array(N); const step = decodeFrame(new Uint8Array(data), bytes); frames.push({ step, bytes, size: data.length }); }
    else msgs.push(JSON.parse(String(data)));
  });
  const until = async (pred, ms = 10000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) { const m = msgs.find(pred); if (m) return m; await sleep(20); }
    throw new Error('timed out waiting for message');
  };
  return { ws, msgs, frames, until, open: new Promise((r) => ws.once('open', r)) };
}

const TOKEN = 'test-admin-token';
const admin = (port, p, method = 'POST') => fetch(`http://127.0.0.1:${port}${p}`, { method, headers: { Authorization: 'Bearer ' + TOKEN } }).then((r) => r.json());

test('two viewers share one worm; tugs, mods, leaderboard, and every chunk of the log replays and chains', async () => {
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'worm-'));
  const app = createWormServer({
    logDir, speed: 10, chunkMinutes: 0.02, ots: false, lab: false, adminToken: TOKEN, publicUrl: 'https://worm.example', pow: { bits: 0 },
    limits: { messagesPerMinute: 6000, messagesPerMinutePerIp: 6000, tugsPerHourPerIp: 3600 },
  });
  const { port } = await app.listen(0, '127.0.0.1');
  try {
    const a = client(port), b = client(port), c = client(port);
    await Promise.all([a.open, b.open, c.open]);
    // c is a browser checking the server live: it mirrors the worm and compares hashes every second
    const D = loadD();
    const mirror = createMirror(D, { sha256 });
    const checks = [];
    c.ws.on('message', async (data, isBinary) => {
      if (isBinary) return;
      const m = JSON.parse(String(data));
      if (m.t === 'state') mirror.state(m.state);
      const ev = mirrorEvent(m); if (ev) mirror.event(ev);
      if (m.t === 'sync') checks.push(await mirror.sync(m.step, m.sha));
    });
    await c.until((m) => m.t === 'hello');
    c.ws.send(JSON.stringify({ t: 'verify' }));
    await c.until((m) => m.t === 'state');
    const helloA = await a.until((m) => m.t === 'hello');
    const helloB = await b.until((m) => m.t === 'hello');
    assert.notEqual(helloA.you, helloB.you);
    assert.match(helloA.you, /^[a-z]+-[a-z]+-[0-9a-f]{2}$/);
    assert.ok(helloA.board && helloA.mod && helloA.proof);

    a.ws.send(JSON.stringify({ t: 'say', text: 'gm' }));
    const q = await b.until((m) => m.t === 'queued' && m.text === 'gm');
    assert.equal(q.by, helloA.you);
    await b.until((m) => m.t === 'start' && m.id === q.id && m.kind === 'say');

    // B sees activity caused by A's message, in the compact frame format
    const t0 = Date.now();
    while (Date.now() - t0 < 5000 && !b.frames.some((f) => f.bytes.some((v) => v > 20))) await sleep(50);
    assert.ok(b.frames.some((f) => f.bytes.some((v) => v > 20)), 'viewer B saw activity');
    assert.ok(b.frames.every((f) => f.step >= 0));
    assert.ok(Math.min(...b.frames.map((f) => f.size)) < 100, 'resting frames are tiny');

    // the finished message lands on the leaderboard
    await b.until((m) => m.t === 'done' && m.id === q.id);
    const board = await b.until((m) => m.t === 'board');
    assert.equal(board.board.today[0].text, 'gm');

    // B pokes; A sees it
    const touch = app.worm.roles.touch.slice(0, 6);
    b.ws.send(JSON.stringify({ t: 'poke', cells: touch }));
    const p = await a.until((m) => m.t === 'poke');
    assert.equal(p.by, helloB.you);
    assert.deepEqual(p.cells, touch);

    // scams are refused, to the sender only
    a.ws.send(JSON.stringify({ t: 'say', text: 'new ca 0x4eb990547bce4a982432ca88cf5fae7eed1a2d35' }));
    assert.equal((await a.until((m) => m.t === 'error')).code, 'address');
    a.ws.send(JSON.stringify({ t: 'tug', a: 'PEPE', b: 'pump.fun' }));
    assert.equal((await a.until((m) => m.t === 'error' && m.code === 'link')).code, 'link');

    // a tug: queued, played, result, and pokes refused while it plays
    a.ws.send(JSON.stringify({ t: 'tug', a: 'PEPE', b: 'WIF' }));
    const tq = await b.until((m) => m.t === 'tugqueued');
    assert.deepEqual([tq.a, tq.b], ['PEPE', 'WIF']);
    await b.until((m) => m.t === 'start' && m.id === tq.id && m.kind === 'tug');
    b.ws.send(JSON.stringify({ t: 'poke', cells: touch }));
    assert.equal((await b.until((m) => m.t === 'error' && m.code === 'tug')).code, 'tug');
    const tr = await b.until((m) => m.t === 'tugresult' && m.id === tq.id, 15000);
    assert.ok(['a', 'b', 'tie'].includes(tr.result.winner));
    const td = await b.until((m) => m.t === 'done' && m.id === tq.id, 15000);
    assert.deepEqual(td.summary.tug, tr.result);

    // a lamp: lit where everyone (and the live check) sees it, logged, and it reports the distances
    a.ws.send(JSON.stringify({ t: 'lamp' }));
    const lq = await b.until((m) => m.t === 'lampqueued');
    const ls = await b.until((m) => m.t === 'start' && m.id === lq.id && m.kind === 'lamp', 15000);
    assert.equal(ls.pos.length, 3);
    assert.equal(ls.dir.length, 3);
    const ld = await b.until((m) => m.t === 'done' && m.id === lq.id, 20000);
    assert.ok(ld.summary.lamp && ld.summary.lamp.from > 0);

    // mods: wrong token is invisible, pause/ban work and reach viewers
    assert.equal((await fetch(`http://127.0.0.1:${port}/admin/state`)).status, 404);
    const st = await admin(port, '/admin/state', 'GET');
    assert.equal(st.ok, true);
    assert.ok(st.feed.length >= 2);
    await admin(port, '/admin/pause?chat=1');
    await b.until((m) => m.t === 'mod' && m.chatPaused === true);
    a.ws.send(JSON.stringify({ t: 'say', text: 'still here' }));
    assert.equal((await a.until((m) => m.t === 'error' && m.code === 'paused')).code, 'paused');
    await admin(port, '/admin/pause?chat=0');
    const ban = await admin(port, `/admin/ban?id=${q.id}&hours=1`);
    assert.equal(ban.ok, true);
    assert.equal(ban.label, helloA.you);
    await b.until((m) => m.t === 'hide' && m.id === q.id);
    a.ws.send(JSON.stringify({ t: 'say', text: 'let me back' }));
    assert.equal((await a.until((m) => m.t === 'error' && m.code === 'muted')).code, 'muted');
    const ann = await admin(port, '/admin/announce?text=' + encodeURIComponent('visit pump.fun/x') + '&minutes=5');
    assert.equal(ann.ok, false, 'announcements refuse links too');
    assert.equal((await admin(port, '/admin/unban?key=' + encodeURIComponent(ban.key))).ok, true);

    // http surface: compressed, cached, templated
    const home = await fetch(`http://127.0.0.1:${port}/`, { headers: { 'Accept-Encoding': 'br' } });
    assert.equal(home.status, 200);
    assert.equal(home.headers.get('content-encoding'), 'br');
    const html = await home.text();
    assert.match(html, /BRAINWORM/);
    assert.doesNotMatch(html, /%ORIGIN%/);
    const again = await fetch(`http://127.0.0.1:${port}/`, { headers: { 'If-None-Match': home.headers.get('etag') } });
    assert.equal(again.status, 304);
    assert.equal((await fetch(`http://127.0.0.1:${port}/stream`)).status, 200);
    assert.equal((await fetch(`http://127.0.0.1:${port}/shared/worm.js`)).status, 200);
    assert.equal((await fetch(`http://127.0.0.1:${port}/%2e%2e/package.json`)).status, 404);
    assert.equal((await fetch(`http://127.0.0.1:${port}/log/..%2fpackage.json`)).status, 404);
    assert.equal((await fetch(`http://127.0.0.1:${port}/admin/clear`, { method: 'POST' })).status, 404);
    const health = await (await fetch(`http://127.0.0.1:${port}/healthz`)).json();
    assert.equal(health.ok, true);
    const logText = await (await fetch(`http://127.0.0.1:${port}/log/current.jsonl`)).text();
    assert.match(logText, /"k":"(boot|checkpoint)"/);
    const proof = await (await fetch(`http://127.0.0.1:${port}/proof.json`)).json();
    assert.ok(proof.chain.length >= 1, 'chunks were sealed into the proof chain');

    // the live mirror matched the server at every check, through messages, a tug, pokes and a lamp
    const done = checks.filter(Boolean);
    assert.ok(done.length >= 20, `only ${done.length} live checks`);
    assert.deepEqual(done.filter((x) => !x.ok), [], 'every live check matched');

    a.ws.close(); b.ws.close(); c.ws.close();
  } finally {
    await app.close();
  }

  // every chunk replays exactly, each checkpoint continues the previous chunk's end state,
  // and the proof chain links every chunk's hash
  const files = fs.readdirSync(logDir).filter((f) => /^events-.*\.jsonl$/.test(f)).sort();
  assert.ok(files.length >= 3, `only ${files.length} chunks`);
  const wiring = fs.readFileSync(new URL('../data/wiring.json', import.meta.url));
  let prevEnd = null, checked = 0;
  for (const f of files) {
    const { segments } = await replayLog(fs.readFileSync(path.join(logDir, f), 'utf8'), wiring);
    assert.equal(segments.length, 1);
    const s = segments[0];
    assert.deepEqual(s.warnings, [], f);
    assert.equal(s.matched, s.checked, s.mismatches.join('\n'));
    assert.ok(s.endChecked, `${f} was sealed`);
    if (prevEnd) assert.equal(s.startStateSha256, prevEnd, `${f} starts where the previous chunk ended`);
    prevEnd = s.endStateSha256;
    checked += s.checked;
  }
  assert.equal(checked, 4, 'the message, the poke, the tug and the lamp');
  const chain = fs.readFileSync(path.join(logDir, 'proof', 'chain.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  assert.equal(chain.length, files.length);
  let prev = 'genesis';
  for (const e of chain) {
    assert.equal(sha256(fs.readFileSync(path.join(logDir, e.log))), e.logSha256);
    const text = fs.readFileSync(path.join(logDir, 'proof', e.proof));
    assert.equal(sha256(text), e.chainSha256);
    assert.equal(e.prev, prev);
    assert.match(String(text), new RegExp(`prev ${prev}`));
    prev = e.chainSha256;
  }
});

test('a request line that is not a URL (bots send them) gets a 400 and the worm keeps running', async () => {
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'worm-'));
  const app = createWormServer({ logDir, speed: 10, ots: false, lab: false, pow: { bits: 0 } });
  const { port } = await app.listen(0, '127.0.0.1');
  try {
    const net = await import('node:net');
    const status = await new Promise((resolve, reject) => {
      const s = net.connect(port, '127.0.0.1', () => s.write('GET //[::1 HTTP/1.1\r\nHost: x\r\n\r\n'));
      let got = '';
      s.on('data', (d) => { got += d; if (/\r\n\r\n/.test(got)) { s.destroy(); resolve(got.split(' ')[1]); } });
      s.on('error', reject);
      setTimeout(() => { s.destroy(); reject(new Error('no answer: did the server die?')); }, 5000);
    });
    assert.equal(status, '400');
    const h = await fetch(`http://127.0.0.1:${port}/healthz`).then((r) => r.json());
    assert.equal(h.ok, true);
  } finally { await app.close(); fs.rmSync(logDir, { recursive: true, force: true }); }
});

test('behind a trusted proxy the real address is the last X-Forwarded-For entry: a bot cannot spend another address\'s budget or dodge its own', async () => {
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'worm-'));
  const app = createWormServer({ logDir, speed: 10, ots: false, lab: false, pow: { bits: 0 }, trustProxy: true });
  const { port } = await app.listen(0, '127.0.0.1');
  try {
    // /spawn/quote has a budget of 12 per address; the launchpad is shut here, so every call is a cheap 400
    const quote = (xff) => fetch(`http://127.0.0.1:${port}/spawn/quote`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': xff }, body: '{"mint":"x","side":"buy","amount":1}' }).then((r) => r.status);
    const statuses = [];
    for (let i = 0; i < 14; i++) statuses.push(await quote(`1.1.1.1, 9.9.9.9`));
    assert.equal(statuses.filter((s) => s === 429).length, 2, 'the 13th and 14th from the real address 9.9.9.9 are refused');
    assert.equal(await quote('2.2.2.2, 9.9.9.9'), 429, 'a made-up first entry does not buy a new budget: the real address is still 9.9.9.9');
    assert.equal(await quote('1.1.1.1, 8.8.8.8'), 400, 'another real address has its own budget, whatever a bot wrote before it');
  } finally { await app.close(); fs.rmSync(logDir, { recursive: true, force: true }); }
});

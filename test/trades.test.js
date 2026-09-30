import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import WebSocket from 'ws';
import { createWormServer } from '../server/server.js';
import { b58encode } from '../server/solana.js';
import { createMirror, mirrorEvent } from '../shared/mirror.js';
import { replayLog } from '../scripts/replay.js';
import { loadD } from './data.js';

const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');
const sig = () => b58encode(crypto.randomBytes(64));
const MINT = 'BRAiNWoRMxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxpump'.replace(/[^1-9A-HJ-NP-Za-km-z]/g, '1');

test('token trades reach the worm as logged, replayable pokes and flashes', async () => {
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trades-'));
  let feedTrade = null;
  const app = createWormServer({
    logDir, speed: 10, ots: false, lab: false, pow: { bits: 0 }, token: { mint: MINT, bigBuySol: 1, tradesPerSecond: 50 },
    tradeStreamFactory: ({ mint, onTrade }) => { assert.equal(mint, MINT); return { start() { feedTrade = onTrade; }, stop: async () => {}, status: () => ({ connected: true }) }; },
  });
  const { port } = await app.listen(0, '127.0.0.1');
  const msgs = [];
  const ws = new WebSocket(`ws://127.0.0.1:${port}/live`);
  const D = loadD();
  const mirror = createMirror(D, { sha256 });
  const checks = [];
  ws.on('message', async (d, bin) => {
    if (bin) return;
    const m = JSON.parse(String(d)); msgs.push(m);
    if (m.t === 'state') mirror.state(m.state);
    const ev = mirrorEvent(m); if (ev) mirror.event(ev);
    if (m.t === 'sync') checks.push(await mirror.sync(m.step, m.sha));
  });
  const until = async (pred, ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const m = msgs.find(pred); if (m) return m; await new Promise((r) => setTimeout(r, 20)); } throw new Error('timeout'); };
  try {
    await until((m) => m.t === 'hello');
    ws.send(JSON.stringify({ t: 'verify' }));
    await until((m) => m.t === 'state');
    const cfg = await (await fetch(`http://127.0.0.1:${port}/config.json`)).json();
    assert.equal(cfg.site.contract, MINT, 'the mint is the site contract');
    assert.equal(cfg.site.ticker, '$WORM');
    assert.ok(cfg.site.links.some((l) => l.url.includes('pump.fun/coin/' + MINT)));

    const buy = { signature: sig(), side: 'buy', sol: 2.5, tokens: 1000, trader: MINT, marketCapSol: 40, pool: 'pump', ts: Date.now() };
    feedTrade(buy);
    const poke = await until((m) => m.t === 'poke' && m.chain && m.chain.sig === buy.signature);
    assert.equal(poke.by, 'chain:buy');
    assert.equal(poke.chain.sol, 2.5);
    await until((m) => m.t === 'queued' && m.text === '█' && m.chain && m.chain.sig === buy.signature);
    const sell = { ...buy, signature: sig(), side: 'sell', sol: 0.3 };
    feedTrade(sell);
    const sp = await until((m) => m.t === 'poke' && m.chain && m.chain.sig === sell.signature);
    assert.equal(sp.by, 'chain:sell');
    // sells poke the tail end, buys the head end
    const segOf = (i) => D.segs[D.n[i][3]];
    assert.ok(poke.cells.every((i) => ['episphere', 'segment_0', 'segment_1'].includes(segOf(i))));
    assert.ok(sp.cells.every((i) => ['segment_2', 'segment_3', 'pygidium'].includes(segOf(i))));
    await until((m) => m.t === 'start' && m.text === '█');
    await new Promise((r) => setTimeout(r, 1500));
    const done = checks.filter(Boolean);
    assert.ok(done.length >= 5);
    assert.deepEqual(done.filter((x) => !x.ok), [], 'the live mirror matched through the trades');
    assert.equal((await fetch(`http://127.0.0.1:${port}/admin/state`)).status, 404, 'admin needs a token');
  } finally {
    ws.terminate();
    await app.close();
  }
  // the log carries each trade's signature and replays exactly
  const files = fs.readdirSync(logDir).filter((f) => f.endsWith('.jsonl'));
  const text = files.map((f) => fs.readFileSync(path.join(logDir, f), 'utf8')).join('');
  assert.match(text, /"by":"chain:buy".*"sig":"/);
  const wiring = fs.readFileSync(new URL('../data/wiring.json', import.meta.url));
  for (const f of files) {
    const { segments } = await replayLog(fs.readFileSync(path.join(logDir, f), 'utf8'), wiring);
    for (const s of segments) { assert.deepEqual(s.warnings, []); assert.equal(s.matched, s.checked); }
  }
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { hatch, feel, rebuild, b58bytes, touchSides, pick, COINWORM_VERSION } from '../shared/coinworm.js';
import { stateString } from '../shared/replay.js';
import { createCoinWorms } from '../server/coinworms.js';
import * as render from '../server/render.js';
import { b58encode, b58decode, generateKeypair } from '../server/solana.js';
import { loadD } from './data.js';

const D = loadD();
const sha = (w) => crypto.createHash('sha256').update(stateString(w)).digest('hex');
const sig = (seed) => b58encode(crypto.createHash('sha512').update(String(seed)).digest());
const trades = (n, from = 0) => Array.from({ length: n }, (_, i) => ({ signature: sig(from + i), side: (from + i) % 3 ? 'buy' : 'sell' }));

test('a coin worm hatches the same from the same ticker, and each ticker is its own first sight', () => {
  assert.equal(sha(hatch(D, 'GOOD').worm), sha(hatch(D, 'GOOD').worm));
  assert.notEqual(sha(hatch(D, 'GOOD').worm), sha(hatch(D, 'BAD').worm));
  const h = hatch(D, 'BRAINWORM', { keepPeak: true });
  assert.ok(h.peak > 0, 'the ticker lights its eyes');
  assert.equal(h.act.length, D.n.length);
});

test('a trade touches the head end for a buy and the tail end for a sell, cells picked from its signature', () => {
  const s = sig('x');
  assert.deepEqual(b58bytes(s), [...b58decode(s)]);
  const { worm } = hatch(D, 'GOOD'), sides = touchSides(worm);
  const b = feel(worm, { signature: s, side: 'buy' }, sides), c = feel(worm, { signature: s, side: 'sell' }, sides);
  assert.deepEqual(b.cells, pick(sides.head, b58decode(s)));
  assert.deepEqual(c.cells, pick(sides.tail, b58decode(s)));
  assert.ok(b.cells.every((x) => sides.head.includes(x)) && c.cells.every((x) => sides.tail.includes(x)));
});

test('the server keeps each coin worm trade by trade, across restarts, and it equals a rebuild from its public record', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coinworms-'));
  const mint = generateKeypair().address;
  let cw = createCoinWorms({ dir, D, render });
  assert.equal(cw.hatch(mint, 'GOOD'), true);
  assert.equal(cw.hatch(mint, 'OTHER'), false, 'a coin hatches once');
  assert.equal(cw.feel(mint, trades(7)), 7);
  assert.equal(cw.feel(mint, trades(7)), 0, 'each trade is felt once');
  assert.equal(cw.feel(mint, [{ ...trades(1)[0], n: 1 }]), 1, 'a second swap in the same transaction is its own trade');
  cw.stop();
  cw = createCoinWorms({ dir, D, render, live: 1 });   // a restart: the worm comes back from its record
  assert.equal(cw.feel(mint, trades(5, 7)), 5);
  const pub = cw.publicRecord(mint);
  assert.equal(pub.v, COINWORM_VERSION);
  assert.equal(pub.trades.length, 13);
  const { worm, stats } = rebuild(D, pub.ticker, pub.trades);
  assert.equal(sha(worm), pub.sha, 'anyone rebuilding it from the record gets the same worm');
  assert.deepEqual(stats, pub.stats);
  assert.equal(stats.trades, 13); assert.equal(stats.buys + stats.sells, 13); assert.ok(stats.cells > 0 && stats.swim > 0);
  assert.equal(cw.lastSignature(mint), pub.trades.at(-1).signature);
  const birth = cw.portrait(mint, 'birth'), now = cw.portrait(mint, 'now');
  for (const png of [birth, now]) assert.deepEqual([...png.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
  assert.equal(cw.portrait(mint, 'now'), now, 'kept until the next trade');
  assert.equal(cw.publicRecord(generateKeypair().address), null);
  cw.stop();
});

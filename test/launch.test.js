import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { WormCore } from '../shared/worm.js';
import { PARAMS } from '../shared/sim.js';
import { LOG_VERSION } from '../shared/replay.js';
import { createLaunch } from '../server/launch.js';
import { replayLog } from '../scripts/replay.js';
import { loadD, wiringRaw, txRaw } from './data.js';

const D = loadD();
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');

test('the launch moment is the first time a touch stops its cilia after arming, and a replay confirms it', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'launch-'));
  const lines = [{ k: 'boot', v: LOG_VERSION, run: 't', chunk: 0, ts: 0, step: 0, params: PARAMS, wiringSha256: sha256(wiringRaw), transmittersSha256: sha256(txRaw) }];
  const worm = new WormCore(D, {
    onEvent: (ev) => {
      if (ev.type === 'start') lines.push({ k: 'say', step: ev.step, id: ev.id, by: ev.meta.by, text: ev.text });
      if (ev.type === 'poke') lines.push({ k: 'poke', step: ev.step, id: ev.id, by: ev.meta.by, cells: ev.cells });
      if (ev.type === 'done') lines.push({ k: 'done', step: ev.step, id: ev.id, summary: ev.summary });
    },
  });
  const calls = [];
  const solana = {
    uploadPumpMetadata: async (o) => { calls.push(['upload', o.name, o.symbol, o.image.length > 0]); return { metadataUri: 'https://ipfs.example/meta.json', metadata: {} }; },
    prepareLaunch: async (o) => { calls.push(['prepare', o.creator, o.uri, o.symbol]); return { mint: 'Mint1111111111111111111111111111111111111111', tx: 'AA==', summary: { feePayer: o.creator, signers: [o.creator], programIds: [] } }; },
    confirmLaunch: async () => ({ confirmed: true, err: null, mintExists: true }),
  };
  const render = { renderActivityPNG: ({ act }) => Buffer.from('png:' + Array.from(act.slice(0, 8)).join(',')) };
  let launched = null;
  const launch = createLaunch({ dir, worm, D, writeLog: (o) => lines.push(o), render, solana, onLaunched: (l) => { launched = l; } });

  // a quiet stretch, then arm, then something that startles it
  for (let t = 0; t < 40; t++) { worm.tick(); launch.onStep(); }
  await assert.rejects(launch.uploadMetadata(), /moment/);
  launch.arm();
  worm.say('m1', 'gm', { by: 'a' });
  for (let t = 0; t < 200; t++) { worm.tick(); launch.onStep(); }
  assert.equal(launch.status().moment, null, 'a small message does not stop its cilia');
  worm.poke('p1', worm.roles.touch.slice(0, 6), { by: 'b' });
  for (let t = 0; t < 600 && !launch.status().moment; t++) { worm.tick(); launch.onStep(); }
  const m = launch.status().moment;
  assert.ok(m, 'a touch on the head stopped its cilia');
  assert.ok(m.stop > 0.05);
  assert.ok(fs.existsSync(launch.imagePath));
  assert.equal(m.imageSha256, sha256(fs.readFileSync(launch.imagePath)));
  assert.throws(() => launch.arm(), /already/);
  for (let t = 0; t < 400; t++) worm.tick();

  // an independent replay of the log finds the same first startle and the same state
  const { segments } = await replayLog(lines.map((l) => JSON.stringify(l)).join('\n'), wiringRaw);
  assert.deepEqual(segments[0].warnings, []);
  assert.equal(segments[0].launch.step, m.step);
  assert.equal(segments[0].launch.firstOk, true);
  assert.equal(segments[0].launch.stateOk, true);

  // a forged moment (one step later) is caught
  const forged = lines.map((l) => (l.k === 'launch-moment' ? { ...l, step: l.step + 1 } : l));
  const bad = await replayLog(forged.map((l) => JSON.stringify(l)).join('\n'), wiringRaw);
  assert.ok(bad.segments[0].warnings.some((w) => /first trigger/.test(w)));

  // metadata, prepare and confirm go through the Solana module; the server never signs for the owner
  const meta = await launch.uploadMetadata({ twitter: 'https://x.com/brainworm' });
  assert.equal(meta.uri, 'https://ipfs.example/meta.json');
  const prep = await launch.prepare({ creator: 'Creator11111111111111111111111111111111111' });
  assert.equal(prep.mint.length, 44);
  const conf = await launch.confirm({ signature: 'sig' });
  assert.equal(conf.ok, true);
  assert.equal(launched.mint, prep.mint);
  assert.equal(launch.status().launched.signature, 'sig');
  assert.deepEqual(calls.map((c) => c[0]), ['upload', 'prepare']);
  assert.deepEqual([calls[0][1], calls[0][2]], ['BRAINWORM', 'WORM'], 'named BRAINWORM, its ticker $WORM');
  // state survives a restart
  const again = createLaunch({ dir, worm, D, writeLog: () => {}, render, solana });
  assert.equal(again.mint, prep.mint);
});

test('a prepared launch is found on the chain even if nobody confirms it, and never twice', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'launch-'));
  const worm = new WormCore(D);
  const MINTS = ['MintAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', 'MintBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB'];
  let n = 0;
  const onChain = new Map();   // mint -> the signature that made it
  const solana = {
    uploadPumpMetadata: async () => ({ metadataUri: 'https://ipfs.example/meta.json' }),
    prepareLaunch: async (o) => ({ mint: MINTS[n++], tx: 'AA==', summary: { feePayer: o.creator, signers: [o.creator], programIds: [] } }),
    confirmLaunch: async ({ signature, mint }) => ({ confirmed: [...onChain.values()].includes(signature) || signature === 'other', err: null, mintExists: onChain.has(mint) }),
    rpc: async (method, params) => {
      if (method === 'getAccountInfo') return { value: onChain.has(params[0]) ? { data: ['', 'base64'] } : null };
      if (method === 'getSignaturesForAddress') return onChain.has(params[0]) ? [{ signature: 'buy-after', err: null }, { signature: onChain.get(params[0]), err: null }] : [];
      if (method === 'getTransaction') return { meta: { err: null }, transaction: { message: { accountKeys: ['Creator', ...[...onChain].filter(([, s]) => s === params[0]).map(([m]) => m)] } } };
      throw new Error('unexpected ' + method);
    },
  };
  const render = { renderActivityPNG: () => Buffer.from('png') };
  let launched = null;
  const open = () => createLaunch({ dir, worm, D, writeLog: () => {}, render, solana, watchEveryMs: 3600_000, onLaunched: (l) => { launched = l; } });
  const launch = open();
  launch.arm();
  worm.poke('p', worm.roles.touch.slice(0, 6));
  for (let t = 0; t < 600 && !launch.status().moment; t++) { worm.tick(); launch.onStep(); }
  await launch.uploadMetadata();
  const first = await launch.prepare({ creator: 'Creator11111111111111111111111111111111111' });
  const second = await launch.prepare({ creator: 'Creator11111111111111111111111111111111111' });   // the first one's blockhash ran out, say
  assert.deepEqual([first.mint, second.mint], MINTS);
  launch.stop();

  // a signature that made some other coin is not the launch
  onChain.set('SomeOtherMint111111111111111111111111111111', 'other');
  assert.equal((await launch.confirm({ signature: 'other' })).ok, false);

  // the first transaction landed late and the page was closed; after a restart the server finds it by itself
  onChain.set(MINTS[0], 'made-it');
  const again = open();
  assert.equal(await again.watch(), true);
  again.stop();
  assert.equal(again.mint, MINTS[0]);
  assert.equal(launched.signature, 'made-it', 'the transaction that made it, not a later buy');
  await assert.rejects(again.prepare({ creator: 'Creator11111111111111111111111111111111111' }), /Already launched/);
  assert.equal((await again.confirm({ signature: 'made-it' })).ok, true, 'the page confirming it afterwards is fine');
});

test('with a Pinata JWT configured, the launch uploads through Pinata', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'launch-'));
  const worm = new WormCore(D);
  const calls = [];
  const solana = {
    uploadPumpMetadata: async () => { calls.push('pump'); return { metadataUri: 'https://pump.example/m.json' }; },
    uploadPinataMetadata: async (o) => { calls.push(['pinata', o.jwt, o.symbol]); return { metadataUri: 'https://ipfs.io/ipfs/bafymeta' }; },
  };
  const render = { renderActivityPNG: () => Buffer.from('png') };
  const launch = createLaunch({ dir, worm, D, writeLog: () => {}, render, solana, pinataJwt: 'jwt-test' });
  assert.equal(launch.status().uploader, 'Pinata');
  launch.arm();
  worm.poke('p', worm.roles.touch.slice(0, 6));
  for (let t = 0; t < 600 && !launch.status().moment; t++) { worm.tick(); launch.onStep(); }
  const meta = await launch.uploadMetadata();
  assert.equal(meta.uri, 'https://ipfs.io/ipfs/bafymeta');
  assert.deepEqual(calls, [['pinata', 'jwt-test', 'WORM']]);
});

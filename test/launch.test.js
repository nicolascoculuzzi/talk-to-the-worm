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
import * as realPump from '../server/pump.js';
import { generateKeypair, parseTransaction, verifyTransactionSignatures } from '../server/solana.js';
import { makeMintKey, signSlot } from '../public/mintkey.js';
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
    confirmLaunch: async () => ({ confirmed: true, err: null, mintExists: true }),
  };
  const pump = { buildCreate: async (o) => { calls.push(['prepare', o.creator, o.uri, o.symbol, o.user]); return { mint: o.mint || 'Mint1111111111111111111111111111111111111111', tx: 'AA==', mintSigned: !o.mint, firstBuy: null }; } };
  const render = { renderActivityPNG: ({ act }) => Buffer.from('png:' + Array.from(act.slice(0, 8)).join(',')) };
  let launched = null;
  const launch = createLaunch({ dir, worm, D, writeLog: (o) => lines.push(o), render, solana, pump, onLaunched: (l) => { launched = l; } });

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
  assert.deepEqual(calls[1].slice(1), ['Creator11111111111111111111111111111111111', 'https://ipfs.example/meta.json', 'WORM', 'Creator11111111111111111111111111111111111'], 'the launching wallet is its creator');
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
  const pump = { buildCreate: async () => ({ mint: MINTS[n++], tx: 'AA==', mintSigned: true, firstBuy: null }) };
  const solana = {
    uploadPumpMetadata: async () => ({ metadataUri: 'https://ipfs.example/meta.json' }),
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
  const open = () => createLaunch({ dir, worm, D, writeLog: () => {}, render, solana, pump, watchEveryMs: 3600_000, onLaunched: (l) => { launched = l; } });
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

test('if the uploader refuses the server, the metadata is kept on the site under links that never change', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'launch-'));
  const worm = new WormCore(D);
  let refuse = true, builtWith = '';
  const solana = {
    uploadPumpMetadata: async () => { if (refuse) throw new Error('pump.fun ipfs: HTTP 403'); return { metadataUri: 'https://ipfs.example/meta.json' }; },
    confirmLaunch: async () => ({ confirmed: true, err: null, mintExists: true }),
  };
  const pump = { buildCreate: async (o) => { builtWith = o.uri; return { mint: 'Mint1111111111111111111111111111111111111111', tx: 'AA==', mintSigned: true, firstBuy: null }; } };
  const render = { renderActivityPNG: () => Buffer.from('the moment png') };
  const open = (o) => createLaunch({ dir, worm, D, writeLog: () => {}, render, solana, pump, publicUrl: 'https://worm.example', watchEveryMs: 3600_000, logger: { log() {}, warn() {} }, ...o });
  const off = open({ hostMetadata: false });
  off.arm();
  worm.poke('p', worm.roles.touch.slice(0, 6));
  for (let t = 0; t < 600 && !off.status().moment; t++) { worm.tick(); off.onStep(); }
  await assert.rejects(off.uploadMetadata(), /403/, 'no lasting disk: the uploader\'s refusal is shown');
  off.stop();

  const launch = open({ hostMetadata: true });
  const meta = await launch.uploadMetadata({ twitter: 'https://x.com/brainworm' });
  const m = meta.uri.match(/^https:\/\/worm\.example\/launch\/meta\/([A-Za-z0-9_-]{12}\.json)$/);
  assert.ok(m, meta.uri);
  assert.equal(launch.status().metadata.onSite, true);
  const json = JSON.parse(fs.readFileSync(launch.metaFile(m[1]), 'utf8'));
  assert.deepEqual([json.name, json.symbol, json.twitter, json.showName], ['BRAINWORM', 'WORM', 'https://x.com/brainworm', true]);
  const img = json.image.match(/^https:\/\/worm\.example\/launch\/meta\/([0-9a-f]{24}\.png)$/);
  assert.ok(img, json.image);
  assert.equal(fs.readFileSync(launch.metaFile(img[1]), 'utf8'), 'the moment png');
  assert.equal(launch.metaFile('../state.json'), null);
  assert.equal(launch.metaFile('AAAAAAAAAAAA.json'), null);

  // uploading again once pump.fun takes it replaces the link; the file kept earlier still shows what it showed
  refuse = false;
  assert.equal((await launch.uploadMetadata()).uri, 'https://ipfs.example/meta.json');
  assert.equal(launch.status().metadata.onSite, false);
  assert.ok(launch.metaFile(m[1]));
  refuse = true;
  const kept = await launch.uploadMetadata({ twitter: 'https://x.com/brainworm' });
  assert.equal(kept.uri, meta.uri, 'the same content, the same link');
  await launch.prepare({ creator: 'Creator11111111111111111111111111111111111' });
  assert.equal(builtWith, meta.uri, 'the coin is made with it');
  await launch.confirm({ signature: 'sig' });
  await assert.rejects(launch.uploadMetadata(), /already launched/, 'after the launch its metadata is never replaced');
  launch.stop();
});

// pump.fun's starting reserves and fees (as in test/pump.test.js), so the real create transaction can be built offline
const GLOBAL = {
  feeRecipient: '62qc2CNXwrYqQScmEdiZFFAnJR262PxWEuNQtxfafNgV', feeRecipients: [generateKeypair().address], buybackFeeRecipients: [generateKeypair().address],
  initialVirtualTokenReserves: 1_073_000_000_000_000n, initialVirtualSolReserves: 30_000_000_000n, initialRealTokenReserves: 793_100_000_000_000n, tokenTotalSupply: 1_000_000_000_000_000n, createV2Enabled: true,
};
const FEES = { flat: { lp: 0n, protocol: 95n, creator: 30n }, tiers: [{ threshold: 0n, fees: { lp: 0n, protocol: 95n, creator: 30n } }] };
const offlinePump = {
  ...realPump,
  buildCreate: (o) => realPump.buildCreate({ ...o, state: { global: GLOBAL, fees: FEES }, fetchImpl: async () => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { value: { blockhash: 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG' } } })) }),
};
const captureMoment = (launch, worm) => {
  launch.arm();
  worm.poke('p', worm.roles.touch.slice(0, 6));
  for (let t = 0; t < 600 && !launch.status().moment; t++) { worm.tick(); launch.onStep(); }
};

test('a contract address made ahead of time: the launch is built at it, its key signs in the browser, and it stays private', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'launch-'));
  const worm = new WormCore(D);
  const solana = { uploadPumpMetadata: async () => ({ metadataUri: 'https://ipfs.example/meta.json' }), confirmLaunch: async () => ({ confirmed: true, err: null, mintExists: true }) };
  let broadcast = null;
  const launch = createLaunch({ dir, worm, D, writeLog: () => {}, render: { renderActivityPNG: () => Buffer.from('png') }, solana, pump: offlinePump, watchEveryMs: 3600_000, onChange: (st) => { broadcast = st; } });
  const key = await makeMintKey(), creator = generateKeypair().address;
  assert.throws(() => launch.reserve({ mint: 'not an address' }), /not a Solana address/);
  launch.reserve({ mint: key.address });
  assert.equal(launch.reserved, key.address);
  assert.ok(!JSON.stringify(launch.status()).includes(key.address) && !JSON.stringify(broadcast).includes(key.address), 'the public status never shows it');
  captureMoment(launch, worm);
  await launch.uploadMetadata();
  const r = await launch.prepare({ creator, amountSol: 0.5 });
  assert.equal(r.mint, key.address);
  assert.equal(r.mintSigned, false);
  assert.ok(Math.abs(r.firstBuy.share - 0.017376518132293) < 1e-12, 'the dev buy, quoted: 1.74% of the supply for 0.5 SOL');
  const before = verifyTransactionSignatures(Buffer.from(r.tx, 'base64'));
  assert.deepEqual(before.map((x) => [x.address, x.present]), [[creator, false], [key.address, false]], 'both slots empty: the wallet and the browser sign');
  // the page signs the coin's slot with the key it keeps; the wallet's slot stays for the wallet
  const signed = await signSlot(Buffer.from(r.tx, 'base64'), key.secret);
  const after = verifyTransactionSignatures(signed);
  assert.deepEqual(after.map((x) => [x.present, x.valid]), [[false, false], [true, true]]);
  assert.equal(parseTransaction(signed).accountKeys[1], key.address);
  // preparing again keeps the address
  assert.equal((await launch.prepare({ creator, amountSol: 0.5 })).mint, key.address);
  await launch.confirm({ signature: 'sig' });
  assert.equal(launch.mint, key.address);
  assert.throws(() => launch.reserve({ mint: generateKeypair().address }), /already launched/);
  launch.stop();
});

test('the check runs the exact launch on Solana without sending it, and says what it would take from the wallet', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'launch-'));
  const worm = new WormCore(D);
  const creator = generateKeypair().address, key = await makeMintKey();
  const trade = JSON.parse(fs.readFileSync(new URL('./fixtures/pump-tradeevent.json', import.meta.url))).pump;
  let sim = null;
  const asked = [];
  const solana = {
    parseTransaction,
    rpc: async (method, params) => {
      asked.push(method);
      if (method === 'getBalance') return { value: 2_500_000_000 };
      if (method === 'getFeeForMessage') return { value: 185_000 };
      if (method === 'simulateTransaction') {
        assert.deepEqual([params[1].sigVerify, params[1].replaceRecentBlockhash, params[1].innerInstructions], [false, true, true]);
        assert.equal(parseTransaction(Buffer.from(params[0], 'base64')).accountKeys[1], key.address, 'the transaction at the reserved address');
        return { value: sim };
      }
      throw new Error('unexpected ' + method);
    },
  };
  const launch = createLaunch({ dir, worm, D, writeLog: () => {}, render: { renderActivityPNG: () => Buffer.from('png') }, solana, pump: offlinePump, publicUrl: 'https://worm.example', watchEveryMs: 3600_000 });
  launch.reserve({ mint: key.address });
  const moves = (source, lamports, type = 'transfer') => ({ parsed: { type, info: { source, lamports, destination: generateKeypair().address } } });
  sim = { err: null, logs: trade.logs, innerInstructions: [{ index: 1, instructions: [moves(creator, 1_838_960, 'createAccount'), moves(creator, 500_000_000), moves(generateKeypair().address, 99)] }] };
  const c = await launch.check({ creator, amountSol: 0.5 });
  assert.equal(c.works, true);
  assert.deepEqual([c.mint, c.reserved, c.standIn, c.balance], [key.address, true, true, 2.5]);
  assert.equal(c.cost, (185_000 + 1_838_960 + 500_000_000) / 1e9, 'rent, the dev buy and the network fee: only what leaves this wallet');
  const e = realPump.eventsFromLogs(trade.logs).find((x) => x.kind === 'trade');
  assert.equal(c.bought, Number(e.tokens) / 1e6);
  assert.equal(c.creatorFee, Number(e.creatorFee) / 1e9);
  // what a refusal means, in words
  sim = { err: 'AccountNotFound', logs: [] };
  assert.match((await launch.check({ creator, amountSol: 0.5 })).error, /does not have enough SOL: it has 2.5 SOL, and this launch needs about 0.512 SOL/);
  sim = { err: { InstructionError: [1, { Custom: 0 }] }, logs: ['Allocate: account Address { address: X, base: None } already in use'] };
  assert.match((await launch.check({ creator })).error, /already exists at the contract address/);
  sim = { err: { InstructionError: [2, { Custom: 6002 }] }, logs: ['Program log: AnchorError occurred. Error Code: TooMuchSolRequired. Error Number: 6002. Error Message: slippage: Too much SOL required to buy the given amount of tokens.'] };
  assert.match((await launch.check({ creator })).error, /pump\.fun refused it: slippage: Too much SOL required/);
  assert.ok(!asked.includes('sendTransaction'), 'nothing is ever sent');
  launch.stop();
});

test('a coin someone else made at a prepared address is not taken for $WORM', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'launch-'));
  const worm = new WormCore(D);
  const key = await makeMintKey(), owner = generateKeypair().address, stranger = generateKeypair().address;
  let madeBy = stranger;
  const solana = {
    uploadPumpMetadata: async () => ({ metadataUri: 'https://ipfs.example/meta.json' }),
    confirmLaunch: async () => ({ confirmed: true, err: null, mintExists: true }),
    rpc: async (method) => {
      if (method === 'getAccountInfo') return { value: { data: ['', 'base64'] } };
      if (method === 'getSignaturesForAddress') return [{ signature: 'made-it', err: null }];
      if (method === 'getTransaction') return { meta: { err: null }, transaction: { message: { accountKeys: [madeBy, key.address] } } };
      throw new Error('unexpected ' + method);
    },
  };
  const pump = { ...offlinePump, fetchCurves: async ({ mints }) => new Map(mints.map((m) => [m, { creator: madeBy }])) };
  const launch = createLaunch({ dir, worm, D, writeLog: () => {}, render: { renderActivityPNG: () => Buffer.from('png') }, solana, pump, watchEveryMs: 3600_000, logger: { log() {}, warn() {} } });
  launch.reserve({ mint: key.address });
  captureMoment(launch, worm);
  await launch.uploadMetadata();
  await launch.prepare({ creator: owner });
  // someone with a copy of the key made a coin there first: the chain has a coin at the address, but not the owner's
  assert.equal(await launch.watch(), false);
  assert.equal(launch.mint, null);
  // the owner switched wallets and prepared again, but the first wallet's transaction is the one that landed: it is recognised
  const second = generateKeypair().address;
  await launch.prepare({ creator: second });
  assert.equal(launch.creator, second);
  madeBy = owner;
  assert.equal(await launch.watch(), true);
  assert.equal(launch.mint, key.address);
  assert.equal(launch.creator, owner, 'the wallet that really launched it');
  launch.stop();
});

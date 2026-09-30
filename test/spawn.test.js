// SPAWN on pump.fun (server/spawn.js), with pump.fun, Jupiter and a Solana RPC faked; the chain's events are encoded
// the way pump.fun logs them, and read back by server/pump.js's own decoder.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { createSpawn, SOL_MINT } from '../server/spawn.js';
import { createWormServer } from '../server/server.js';
import * as realPump from '../server/pump.js';
import { generateKeypair, b58encode, b58decode, pumpSwapPool } from '../server/solana.js';
import { checkMessage } from '../server/moderation.js';

const addr = () => generateKeypair().address;
const sig = () => b58encode(crypto.randomBytes(64));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const quiet = { warn() {}, log() {} };
const WORM = addr(), OWNER = addr(), CREATOR = addr(), WORM_CREATOR = addr();
const PNG = 'data:image/png;base64,' + Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.from('a very small picture')]).toString('base64');
const moderate = (t) => checkMessage(t, []);
const GLOBAL = {
  feeRecipient: addr(), feeRecipients: [addr()], buybackFeeRecipients: [addr()], initialVirtualTokenReserves: 1_073_000_000_000_000n,
  initialVirtualSolReserves: 30_000_000_000n, initialRealTokenReserves: 793_100_000_000_000n, tokenTotalSupply: 1_000_000_000_000_000n, createV2Enabled: true,
};
const FEES = { flat: { lp: 0n, protocol: 95n, creator: 30n }, tiers: [] };

// pump.fun's events, as it logs them ("Program data: <base64>" inside its own frame)
const disc = (s) => crypto.createHash('sha256').update(s).digest().subarray(0, 8);
const u64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
const pk = (a) => Buffer.from(b58decode(a));
const frame = (program, data) => [`Program ${program} invoke [1]`, `Program data: ${data.toString('base64')}`, `Program ${program} success`];
function tradeLogs({ mint, side = 'buy', lamports = 100_000_000n, tokens = 3_000_000_000n, vSol = 31_000_000_000n, vTok = 1_040_000_000_000_000n, creator = OWNER, creatorFee = 30_000n, user = addr() }) {
  return frame(realPump.PUMP_PROGRAM, Buffer.concat([disc('event:TradeEvent'), pk(mint), u64(lamports), u64(tokens), Buffer.from([side === 'buy' ? 1 : 0]), pk(user), u64(Math.floor(Date.now() / 1000)),
    u64(vSol), u64(vTok), u64(0), u64(0), pk(addr()), u64(95), u64(0), pk(creator), u64(30), u64(creatorFee)]));
}
const collectLogs = (creator, lamports) => frame(realPump.PUMP_PROGRAM, Buffer.concat([disc('event:CollectCreatorFeeEvent'), u64(Math.floor(Date.now() / 1000)), pk(creator), u64(lamports), pk(SOL_MINT)]));
const ammCollectLogs = (creator, lamports) => frame(realPump.PUMP_AMM_PROGRAM, Buffer.concat([disc('event:CollectCoinCreatorFeeEvent'), u64(Math.floor(Date.now() / 1000)), pk(creator), u64(lamports), pk(addr()), pk(addr())]));
const curve = (extra = {}) => ({ ...realPump.freshCurve(GLOBAL, OWNER), ...extra });

// the chain, pump.fun (only what talks to it; its maths and decoders are the real ones), Jupiter and an RPC
function fakes() {
  const calls = [], curves = new Map(), logs = new Map(), accounts = new Map(), burns = new Map();
  const f = { balance: 5e9, vaults: { curve: 0n, amm: 0n }, NEW: null, wormUsd: 0, pools: new Set() };
  const buildCreate = async (o) => { calls.push(['create', o]); const mint = f.NEW || addr(); return { tx: 'Q1JF', mint, firstBuy: o.firstBuySol ? { lamports: 1n, tokens: 12_345_000_000n, minTokens: 12_000_000_000n } : null }; };
  const pump = {
    ...realPump,
    fetchProgramState: async () => ({ global: GLOBAL, fees: FEES }),
    fetchCurves: async ({ mints }) => new Map(mints.map((m) => [m, curves.get(m) || null])),
    fetchCreatorFees: async ({ creator }) => (creator === OWNER ? f.vaults : { curve: 0n, amm: 0n }),
    buildCreate,
    buildBuy: async (o) => { calls.push(['buy', o]); return 'QlVZ'; },
    buildSell: async (o) => { calls.push(['sell', o]); return 'U0VMTA=='; },
    buildCollect: async (o) => { calls.push(['collect', o]); return 'Q09MTA=='; },
    buildBurnReceived: async (o) => { calls.push(['burnReceived', o]); return { tx: 'QlVSTg==', amount: 1234.5, atoms: 1_234_500_000n }; },
    fetchLogs: async ({ signature }) => (logs.has(signature) ? { logs: logs.get(signature), blockTime: Date.now() / 1000, signer: OWNER } : null),
  };
  const reply = (o, status = 200) => new Response(JSON.stringify(o), { status });
  const fetchImpl = async (url, init = {}) => {
    const u = String(url);
    calls.push(['fetch', u]);
    if (/\/price\/v3/.test(u)) return reply({ [SOL_MINT]: { usdPrice: 200 }, ...(f.wormUsd ? { [WORM]: { usdPrice: f.wormUsd } } : {}) });
    if (/\/swap\/v1\/quote/.test(u)) { const q = Object.fromEntries(new URL(u).searchParams); calls.push(['quote', q]); return reply({ inputMint: q.inputMint, outputMint: q.outputMint, outAmount: '5000000', otherAmountThreshold: '4850000', priceImpactPct: '0.002', routePlan: [] }); }
    if (/\/swap\/v1\/swap/.test(u)) { calls.push(['swap', JSON.parse(init.body)]); return reply({ swapTransaction: 'U1dBUA==' }); }
    if (u.startsWith('http://rpc.test')) {
      const { method, params } = JSON.parse(init.body);
      calls.push(['rpc', method, params[0]]);
      const ok = (result) => reply({ jsonrpc: '2.0', id: 1, result });
      if (method === 'getBalance') return ok({ value: f.balance });
      if (method === 'getSignatureStatuses') return ok({ value: [{ confirmationStatus: 'confirmed', err: null }] });
      if (method === 'getSignaturesForAddress') return ok([]);
      if (method === 'getAccountInfo') return ok({ value: accounts.has(params[0]) ? { data: ['', 'base64'], owner: SOL_MINT, lamports: 1 } : null });
      if (method === 'getMultipleAccounts') return ok({ value: params[0].map((a) => (f.pools.has(a) ? { data: ['', 'base64'], owner: realPump.PUMP_AMM_PROGRAM, lamports: 1 } : null)) });
      if (method === 'getTransaction') {
        const amount = burns.get(params[0]);
        if (amount == null) return ok(null);
        return ok({ meta: { err: null }, transaction: { message: { instructions: [{ program: 'spl-token-2022', parsed: { type: 'burnChecked', info: { mint: WORM, authority: OWNER, tokenAmount: { amount: String(amount * 1e6), decimals: 6 } } } }] } } });
      }
    }
    throw new Error('unexpected fetch ' + u);
  };
  return Object.assign(f, { pump, buildCreate, fetchImpl, calls, curves, logs, accounts, burns });
}
function open(f, { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spawn-')), owner = OWNER, extra = {}, rootMint = () => WORM } = {}) {
  const sp = createSpawn({ dir, pump: f.pump, rootMint, moderate, fetchImpl: f.fetchImpl, opts: { rpc: 'http://rpc.test', publicUrl: 'https://worm.example', localMeta: true, owner, ...extra }, logger: quiet });
  return { sp, dir };
}

test('SPAWN on pump.fun: shut until it has a rewards wallet; then every launch names that wallet as the coin\'s pump.fun creator', async () => {
  const f = fakes();
  const { sp } = open(f, { owner: '' });
  assert.equal(sp.publicState().open, false);
  assert.match(sp.publicState().reason, /soon/);
  await assert.rejects(sp.create({ creator: CREATOR, name: 'Good', symbol: 'GOOD', image: 'worm' }), /not open/);
  // the owner gives it a wallet (not the one that launched $WORM), and it opens
  f.curves.set(WORM, curve({ creator: WORM_CREATOR }));
  await assert.rejects(sp.setOwner({ wallet: WORM_CREATOR }), /different/);
  await assert.rejects(sp.setOwner({ wallet: 'bad' }), /Connect/);
  const launcher = addr();
  await assert.rejects(sp.setOwner({ wallet: launcher, wormCreator: launcher }), /different/, 'nor the wallet preparing $WORM\'s launch');
  await sp.setOwner({ wallet: OWNER });
  assert.equal(sp.publicState().open, true);
  assert.equal(sp.publicState().quote, 'SOL');

  // launching: the name and ticker are checked, the picture is checked, the coin's creator is SPAWN's wallet
  await assert.rejects(sp.create({ creator: CREATOR, name: 'Good', symbol: 'no way!', image: PNG }), /Tickers/);
  await assert.rejects(sp.create({ creator: CREATOR, name: 'see https://scam.example', symbol: 'OK', image: PNG }));
  for (const t of ['WORM', 'BRAINWORM']) await assert.rejects(sp.create({ creator: CREATOR, name: 'Good', symbol: t, image: PNG }), /taken/);
  await assert.rejects(sp.create({ creator: CREATOR, name: 'Good', symbol: 'GOOD', image: 'data:text/html;base64,AAAA' }), /picture/);
  await assert.rejects(sp.create({ creator: CREATOR, name: 'Good', symbol: 'GOOD', image: 'data:image/png;base64,' + Buffer.from('<svg onload=x>').toString('base64') }), /not the picture/);
  f.balance = 0.01e9;
  await assert.rejects(sp.create({ creator: CREATOR, name: 'Good', symbol: 'GOOD', image: 'worm', firstBuy: '1' }), /needs about 1\.02 SOL/);
  f.balance = 5e9;
  const made = await sp.create({ creator: CREATOR, name: 'Good Coin', symbol: 'good', image: PNG, firstBuy: '0.5' });
  const cc = f.calls.find((x) => x[0] === 'create')[1];
  assert.deepEqual([cc.user, cc.creator, cc.symbol, cc.firstBuySol], [CREATOR, OWNER, 'GOOD', 0.5]);
  assert.match(cc.uri, /^https:\/\/worm\.example\/m\/[A-Za-z0-9_-]{12}$/, 'a short link: it goes on chain');
  assert.deepEqual(made.firstBuy, { coins: 12_345, minCoins: 12_000 });
  const meta = JSON.parse(fs.readFileSync(sp.metaFile(cc.uri.split('/').pop() + '.json')));
  assert.deepEqual([meta.name, meta.symbol, meta.showName], ['Good Coin', 'GOOD', true]);
  assert.match(meta.image, /^https:\/\/worm\.example\/spawn\/meta\/[0-9a-f]{24}\.png$/);
  assert.ok(sp.metaFile(meta.image.split('/').pop()));
  assert.equal(sp.metaFile('../state.json'), null);
  // with its worm's first sight, only its metadata is kept: the picture is drawn here on request
  await sp.create({ creator: CREATOR, name: 'Wormy', symbol: 'WORMY', image: 'worm' });
  const wm = JSON.parse(fs.readFileSync(sp.metaFile(f.calls.filter((x) => x[0] === 'create').at(-1)[1].uri.split('/').pop() + '.json')));
  assert.equal(wm.image, 'https://worm.example/spawn/hatch/WORMY.png');
});

test('the listing: only coins launched here whose curve names SPAWN\'s wallet; one that never lands is forgotten', async () => {
  const f = fakes();
  const { sp } = open(f);
  const mk = async (symbol) => { f.NEW = addr(); return (await sp.create({ creator: CREATOR, name: symbol + ' Coin', symbol, image: 'worm' })).mint; };
  const a = await mk('AAA'), b = await mk('BBB'), c = await mk('CCC');
  f.curves.set(a, curve({ realTokenReserves: 400_000_000_000_000n }));
  f.curves.set(b, curve({ creator: addr() }));   // a coin whose curve names someone else: not SPAWN's
  await sp.fresh(true);
  const st = sp.publicState();
  assert.deepEqual(st.coins.map((x) => x.symbol), ['AAA']);
  const coin = st.coins[0];
  assert.equal(coin.stage, 'curve');
  assert.ok(Math.abs(coin.progress - (1 - 400 / 793.1)) < 1e-9);
  assert.ok(coin.priceSol > 0 && Math.abs(coin.mcapSol - coin.priceSol * 1e9) < 1e-6);
  assert.equal(coin.creator, CREATOR, 'who launched it');
  assert.equal(sp.pending(c)?.symbol, 'CCC', 'launched here, not on chain yet: its page can wait for it');
  // an hour later it never landed: forgotten
  const real = Date.now, later = real() + 3601_000;
  Date.now = () => later;
  try { await sp.fresh(true); assert.equal(sp.pending(c), null); } finally { Date.now = real; }
});

test('trading: on the coin\'s curve, priced as it is now; through Jupiter once it has graduated; none while it moves', async () => {
  const f = fakes();
  const { sp } = open(f);
  f.NEW = addr();
  const { mint } = await sp.create({ creator: CREATOR, name: 'Trade Coin', symbol: 'TRD', image: 'worm' });
  f.curves.set(mint, curve());
  await sp.fresh(true);
  const q = await sp.quote({ mint, side: 'buy', amount: 0.5 });
  assert.equal(q.steps, 1);
  assert.deepEqual(q.route, ['SOL', '$TRD']);
  assert.equal(q.out.amount, 17_376_518.132293, 'what pump.fun gives for 0.5 SOL on a new curve');
  const user = addr();
  await sp.swap({ quoteId: q.quoteId, user });
  const b = f.calls.find((x) => x[0] === 'buy')[1];
  assert.deepEqual([b.mint, b.user, b.creator, b.lamports], [mint, user, OWNER, 500_000_000n]);
  assert.equal(b.minTokens, (17_376_518_132_293n * 9_700n) / 10_000n);
  await assert.rejects(sp.swap({ quoteId: q.quoteId, user }), /expired|used/, 'a quote is used once');
  // the price moved past the floor before signing: refused
  const q2 = await sp.quote({ mint, side: 'buy', amount: 0.5 });
  f.curves.set(mint, curve({ virtualSolReserves: 40_000_000_000n }));
  await assert.rejects(sp.swap({ quoteId: q2.quoteId, user }), /price moved/);
  // selling coins
  const qs = await sp.quote({ mint, side: 'sell', amount: 1000 });
  assert.equal(qs.out.symbol, 'SOL');
  await sp.swap({ quoteId: qs.quoteId, user });
  assert.equal(f.calls.find((x) => x[0] === 'sell')[1].amount, 1_000_000_000n);
  await assert.rejects(sp.quote({ mint: addr(), side: 'buy', amount: 1 }), /Not a SPAWN coin/);
  await assert.rejects(sp.quote({ mint, side: 'buy', amount: 0 }), /amount/);
  // the curve sold out: moving to PumpSwap, then trading there through Jupiter
  f.curves.set(mint, curve({ complete: true }));
  await sp.fresh(true);
  assert.equal(sp.publicState().coins[0].stage, 'graduating');
  await assert.rejects(sp.quote({ mint, side: 'buy', amount: 1 }), /PumpSwap/);
  f.pools.add(pumpSwapPool(mint));
  await sp.fresh(true);
  assert.equal(sp.publicState().coins[0].stage, 'graduated');
  const qj = await sp.quote({ mint, side: 'buy', amount: 1 });
  assert.equal(f.calls.find((x) => x[0] === 'quote')[1].outputMint, mint);
  await sp.swap({ quoteId: qj.quoteId, user });
  assert.equal(f.calls.find((x) => x[0] === 'swap')[1].userPublicKey, user);
});

test('creator rewards: collected (as pump.fun\'s events say), 64% buys $WORM on its curve, exactly what it bought is burned', async () => {
  const f = fakes();
  const { sp } = open(f);
  await assert.rejects(sp.collect({ wallet: addr() }), /rewards wallet/);
  await assert.rejects(sp.collect({ wallet: OWNER }), /Nothing to collect/);
  f.vaults = { curve: 2_000_000_000n, amm: 500_000_000n };
  const c = await sp.collect({ wallet: OWNER });
  assert.equal(c.sol, 2.5);
  const cc = f.calls.find((x) => x[0] === 'collect')[1];
  assert.deepEqual([cc.creator, cc.curve, cc.amm], [OWNER, true, true]);
  await assert.rejects(sp.collect({ wallet: OWNER }), /may still land/, 'one at a time');
  const S = sig();
  assert.deepEqual(await sp.collected({ signature: S }), { ok: false, error: 'Not confirmed yet.' });
  f.logs.set(S, [...collectLogs(OWNER, 2_000_000_000n), ...ammCollectLogs(OWNER, 500_000_000n), ...collectLogs(addr(), 9_000_000_000n)]);
  const got = await sp.collected({ signature: S });
  assert.deepEqual([got.ok, got.sol, got.owed], [true, 2.5, 1.6], 'only what came to SPAWN\'s wallet; 64% of it is owed to the buyback');
  assert.deepEqual(await sp.collected({ signature: S }), { ok: true }, 'recorded once');
  // the buyback: $WORM still on its pump.fun curve
  f.curves.set(WORM, curve({ creator: WORM_CREATOR }));
  const bb = await sp.buyback({ wallet: OWNER });
  assert.equal(bb.sol, 1.6);
  const buy = f.calls.find((x) => x[0] === 'buy')[1];
  assert.deepEqual([buy.mint, buy.user, buy.creator, buy.lamports], [WORM, OWNER, WORM_CREATOR, 1_600_000_000n]);
  const burn = await sp.burnBought({ signature: sig() });
  assert.equal(burn.amount, 1234.5);
  assert.equal(f.calls.find((x) => x[0] === 'burnReceived')[1].mint, WORM);
  assert.equal(sp.publicState().rewards.owed, 0, 'all of it spent');
  const SB = sig();
  f.burns.set(SB, 1234.5);
  assert.deepEqual(await sp.burned({ signature: SB }), { ok: true, amount: 1234.5 });
  assert.equal(sp.publicState().root.burned, 1234.5);
  const r = sp.publicState().rewards;
  assert.deepEqual([r.collected, r.spentOnWorm, r.share], [2.5, 1.6, 0.64]);
  await assert.rejects(sp.buyback({ wallet: OWNER }), /Less than 0\.001/);
  // after $WORM graduates, the buyback goes through Jupiter
  const S2 = sig();
  f.logs.set(S2, collectLogs(OWNER, 1_000_000_000n));
  await sp.collected({ signature: S2 });
  f.curves.set(WORM, curve({ creator: WORM_CREATOR, complete: true }));
  const bj = await sp.buyback({ wallet: OWNER });
  assert.equal(bj.sol, 0.64);
  assert.equal(f.calls.filter((x) => x[0] === 'quote').at(-1)[1].amount, '640000000');
});

test('pictures kept here: named by content, kept once a transaction names them, deleted once the chain says no coin used them', async () => {
  const f = fakes();
  const { sp, dir } = open(f);
  const meta = path.join(dir, 'spawn', 'meta'), files = () => fs.readdirSync(meta).sort();
  const a = await sp.create({ creator: CREATOR, name: 'Alpha', symbol: 'ALPHA', image: PNG });
  const b = await sp.create({ creator: CREATOR, name: 'Beta', symbol: 'BETA', image: PNG });
  const uri = (k) => f.calls.filter((x) => x[0] === 'create').at(k)[1].uri, uriA = uri(-2), uriB = uri(-1);
  assert.notEqual(uriA, uriB);
  const read = (u) => JSON.parse(fs.readFileSync(sp.metaFile(u.split('/').pop() + '.json')));
  assert.deepEqual([read(uriA).name, read(uriB).name], ['Alpha', 'Beta']);
  assert.equal(read(uriA).image, read(uriB).image, 'one picture, shared');
  assert.equal(files().length, 3);
  // a launch that fails to build keeps nothing
  f.pump.buildCreate = async () => { throw new Error('pump: boom'); };
  const other = 'data:image/png;base64,' + Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.from('another picture')]).toString('base64');
  await assert.rejects(sp.create({ creator: CREATOR, name: 'Gamma', symbol: 'GAMMA', image: other }), /Boom/);
  assert.equal(files().length, 3);
  f.pump.buildCreate = f.buildCreate;
  // later: Alpha is on the chain, Beta never landed: Beta's metadata goes, the shared picture stays
  f.curves.set(a.mint, curve());
  await sleep(700);
  const st = JSON.parse(fs.readFileSync(path.join(dir, 'spawn', 'state.json'), 'utf8'));
  for (const u of Object.values(st.uploads)) u.at -= 3 * 3600_000;
  fs.writeFileSync(path.join(dir, 'spawn', 'state.json'), JSON.stringify(st));
  const { sp: later } = open(f, { dir });
  await later.fresh(true);
  assert.ok(later.metaFile(uriA.split('/').pop() + '.json'));
  assert.equal(later.metaFile(uriB.split('/').pop() + '.json'), null);
  assert.equal(files().length, 2);
  assert.ok(f.calls.some((x) => x[0] === 'rpc' && x[1] === 'getAccountInfo' && x[2] === b.mint), 'the chain was asked first');
  // a full disk budget: no more picked pictures
  const { sp: full } = open(f, { dir, extra: { metaBudget: 10 } });
  await full.fresh(true);
  assert.equal(full.publicState().pictures, false);
  await assert.rejects(full.create({ creator: CREATOR, name: 'Delta', symbol: 'DELTA', image: other }), /full/);
});

class FakeWS extends EventEmitter {
  constructor(url) { super(); this.url = url; this.sent = []; FakeWS.all.push(this); setImmediate(() => this.emit('open')); }
  send(m) { this.sent.push(JSON.parse(m)); }
  ping() {} terminate() { this.emit('close'); }
  static all = [];
  static note(signature, logs, err = null) { for (const w of FakeWS.all) w.emit('message', JSON.stringify({ method: 'logsNotification', params: { result: { value: { signature, err, logs } } } })); }
}

test('the server: a buy of a SPAWN coin pokes the worm at the coin\'s own spot, and feeds the coin\'s own worm and its chart', async () => {
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spawn-srv-'));
  const f = fakes(), MINT = addr(), S1 = sig(), S2 = sig(), S3 = sig();
  fs.mkdirSync(path.join(logDir, 'spawn'), { recursive: true });
  fs.writeFileSync(path.join(logDir, 'spawn', 'state.json'), JSON.stringify({ owner: OWNER, owners: [OWNER], coins: { [MINT]: { name: 'Good Coin', symbol: 'GOOD', image: '', creator: CREATOR, createdAt: Date.now() } } }));
  f.curves.set(MINT, curve());
  FakeWS.all = [];
  const app = createWormServer({
    logDir, speed: 10, ots: false, lab: false, pow: { bits: 0 }, publicUrl: 'https://worm.example', token: { mint: WORM, solanaRpc: 'http://rpc.test' }, spawn: { localMeta: true },
    tradeStreamFactory: () => ({ start() {}, stop: async () => {}, status: () => ({}) }),
    spawnDeps: { pump: f.pump, fetchImpl: f.fetchImpl, ws: 'wss://rpc.test', WebSocketImpl: FakeWS },
  });
  const { port } = await app.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${port}`;
  const post = (p2, body) => fetch(base + p2, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  try {
    const page = await fetch(base + '/spawn');
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-security-policy'), /img-src 'self' data: blob: https:\/\/ipfs\.io https:\/\/gateway\.pinata\.cloud/);
    const pub = await (await fetch(base + '/spawn.json')).json();
    assert.equal(pub.open, true);
    assert.deepEqual(pub.coins.map((c) => c.symbol), ['GOOD']);
    assert.deepEqual([pub.fee.platform, pub.fee.protocolBps, pub.fee.creatorBps, pub.fee.buyback], ['pump.fun', 95, 30, 0.64]);
    const features = (await (await fetch(base + '/config.json')).json()).features;
    assert.deepEqual([features.spawn, features.spawnQuote], [true, 'SOL']);
    const bad = await post('/spawn/quote', { mint: addr(), side: 'buy', amount: 1 });
    assert.equal(bad.status, 400); assert.match((await bad.json()).error, /Not a SPAWN coin/);
    assert.equal((await post('/spawn/claim', { mint: MINT, creator: CREATOR })).status, 404, 'a coin\'s launcher has no creator fees to claim');
    assert.deepEqual(await (await post('/spawn/confirm', { signature: S1 })).json(), { confirmed: true, failed: false });

    // the stream listens to SPAWN's vaults; a buy pokes, a sell doesn't, a failed or repeated one is ignored
    for (let k = 0; k < 100 && !FakeWS.all.some((w) => w.sent.length); k++) await sleep(20);
    assert.deepEqual(FakeWS.all[0].sent.map((m) => m.params[0].mentions[0]), [realPump.creatorVault(OWNER), realPump.ammCreatorVaultAuthority(OWNER)]);
    FakeWS.note(S3, tradeLogs({ mint: MINT }), { InstructionError: [0, 'x'] });
    FakeWS.note(S2, tradeLogs({ mint: MINT, side: 'sell', lamports: 50_000_000n, vSol: 30_500_000_000n, vTok: 1_055_000_000_000_000n }));
    FakeWS.note(S1, tradeLogs({ mint: MINT, side: 'buy', lamports: 200_000_000n, vSol: 31_000_000_000n, vTok: 1_040_000_000_000_000n }));
    FakeWS.note(S1, tradeLogs({ mint: MINT }));
    let log = '';
    for (let k = 0; k < 200 && !log.includes(S1); k++) { await sleep(25); log = fs.readFileSync(app.logPath, 'utf8'); }
    const pokes = log.trim().split('\n').map((l) => JSON.parse(l)).filter((e) => e.k === 'poke' && e.by === 'spawn:$GOOD');
    assert.equal(pokes.length, 1, 'one buy, one poke');
    assert.deepEqual([pokes[0].sig, pokes[0].side, pokes[0].sol], [S1, 'buy', 0.2]);
    const h = crypto.createHash('sha256').update(MINT).digest(), touch = app.worm.roles.touch, spot = [];
    for (let k = 0; spot.length < 3; k++) { const c = touch[h[k] % touch.length]; if (!spot.includes(c)) spot.push(c); }
    assert.deepEqual(pokes[0].cells, spot, 'the coin\'s own spot');
    // its own worm felt both trades, in order, and rebuilds to the same worm
    let rec = null;
    for (let k = 0; k < 100 && !(rec?.trades?.length >= 2); k++) { await sleep(20); rec = await (await fetch(`${base}/spawn/worm/${MINT}.json`)).json().catch(() => null); }
    assert.deepEqual(rec.trades.map((t) => [t.signature, t.side]), [[S2, 'sell'], [S1, 'buy']]);
    const { rebuild } = await import('../shared/coinworm.js'), { stateString } = await import('../shared/replay.js'), { loadD } = await import('./data.js');
    assert.equal(crypto.createHash('sha256').update(stateString(rebuild(loadD(), rec.ticker, rec.trades).worm)).digest('hex'), rec.sha);
    // its chart: each trade with its price after it, in SOL
    const chart = await (await fetch(`${base}/spawn/chart/${MINT}.json`)).json();
    assert.deepEqual(chart.points.filter((x) => x[2] !== 'start').map((x) => [x[2], x[3], x[4]]), [['sell', 0.05, S2], ['buy', 0.2, S1]]);
    assert.ok(Math.abs(chart.points.at(-1)[1] - 31 / 1_040_000_000) < 1e-15);
    // its page, and a new coin's metadata at its short link
    const cp = await fetch(`${base}/c/${MINT}`);
    assert.equal(cp.status, 200);
    assert.match(await cp.text(), /<title>\$GOOD · its own worm, on SPAWN<\/title>/);
    f.NEW = addr();
    const made = await (await post('/spawn/create', { creator: CREATOR, name: 'New Coin', symbol: 'NEWC', image: 'worm' })).json();
    assert.equal(made.mint, f.NEW);
    const link = f.calls.filter((x) => x[0] === 'create').at(-1)[1].uri, m = await fetch(base + new URL(link).pathname);
    assert.equal(m.status, 200);
    assert.deepEqual([m.headers.get('content-type'), m.headers.get('access-control-allow-origin')], ['application/json; charset=utf-8', '*']);
    assert.equal((await m.json()).symbol, 'NEWC');
    assert.equal((await fetch(base + '/m/nope')).status, 404);
  } finally { await app.close(); }
});

test('the server before SPAWN has a rewards wallet: /spawn says it opens soon, and builds nothing', async () => {
  const f = fakes();
  const app = createWormServer({ logDir: '', ots: false, lab: false, pow: { bits: 0 }, spawnDeps: { pump: f.pump, fetchImpl: async () => { throw new Error('no network in tests'); } } });
  const { port } = await app.listen(0, '127.0.0.1');
  try {
    const pub = await (await fetch(`http://127.0.0.1:${port}/spawn.json`)).json();
    assert.equal(pub.open, false); assert.match(pub.reason, /soon/);
    const r = await fetch(`http://127.0.0.1:${port}/spawn/create`, { method: 'POST', body: JSON.stringify({ creator: addr() }) });
    assert.equal(r.status, 400); assert.match((await r.json()).error, /not open/);
    const codes = [];
    for (let k = 0; k < 6; k++) codes.push((await fetch(`http://127.0.0.1:${port}/spawn/create`, { method: 'POST', body: JSON.stringify({ creator: addr() }) })).status);
    assert.deepEqual(codes, [400, 400, 400, 400, 400, 429], 'launches from one address: a burst, then one every 2 minutes');
    assert.equal((await (await fetch(`http://127.0.0.1:${port}/config.json`)).json()).features.spawn, false);
  } finally { await app.close(); }
});

test('robust: a coin seen on chain is never forgotten; a buyback survives a restart; strangers\' coins make no work', async () => {
  const f = fakes();
  const { sp, dir } = open(f);
  f.NEW = addr();
  const { mint } = await sp.create({ creator: CREATOR, name: 'Kept Coin', symbol: 'KEPT', image: 'worm' });
  f.curves.set(mint, curve());
  await sp.fresh(true);
  assert.equal(sp.publicState().coins.length, 1);
  // an hour on, a node answers nothing for it: it's not listed this time, but it's not forgotten either
  f.curves.delete(mint);
  const real = Date.now, later = real() + 2 * 3600_000;
  Date.now = () => later;
  try { await sp.fresh(true); } finally { Date.now = real; }
  f.curves.set(mint, curve());
  await sp.fresh(true);
  assert.deepEqual(sp.publicState().coins.map((c) => c.symbol), ['KEPT']);

  // the buyback is built, then the server restarts before its burn: it is recorded with what it was built for, once
  const S = sig();
  f.logs.set(S, collectLogs(OWNER, 1_000_000_000n));
  await sp.collected({ signature: S });
  f.curves.set(WORM, curve({ creator: WORM_CREATOR }));
  const bb = await sp.buyback({ wallet: OWNER });
  assert.equal(bb.sol, 0.64);
  sp.stop();
  const { sp: again } = open(f, { dir });
  await again.burnBought({ signature: sig() });
  assert.equal(again.publicState().rewards.owed, 0, 'not owed twice');
  assert.equal(again.publicState().rewards.spentOnWorm, 0.64);

  // trades of a coin someone else made naming SPAWN's wallet: no refresh, no poke, nothing
  const reads = () => f.calls.filter((x) => x[0] === 'fetch' && /price\/v3/.test(x[1])).length;
  const ws = [], seen = [];
  class WS extends EventEmitter { constructor() { super(); ws.push(this); setImmediate(() => this.emit('open')); } send() {} ping() {} terminate() {} }
  const live = createSpawn({ dir: fs.mkdtempSync(path.join(os.tmpdir(), 'spawn-')), pump: f.pump, rootMint: () => WORM, moderate, fetchImpl: f.fetchImpl, onTrade: (t) => seen.push(t), opts: { rpc: 'http://rpc.test', publicUrl: 'https://worm.example', localMeta: true, owner: OWNER, ws: 'wss://x', WebSocketImpl: WS }, logger: quiet });
  await live.fresh(true);
  const base = reads();
  for (let k = 0; k < 5; k++) for (const w of ws) w.emit('message', JSON.stringify({ method: 'logsNotification', params: { result: { value: { signature: sig(), err: null, logs: tradeLogs({ mint: addr() }) } } } }));
  await sleep(50);
  assert.equal(reads(), base, 'no refreshes for coins that aren\'t SPAWN\'s');
  assert.deepEqual(seen, [], 'and no pokes');
  live.stop();
});

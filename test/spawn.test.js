import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { createSpawn, SOL_MINT } from '../server/spawn.js';
import { createWormServer } from '../server/server.js';
import { generateKeypair, b58encode } from '../server/solana.js';
import { checkMessage } from '../server/moderation.js';

const addr = () => generateKeypair().address;
const sig = () => b58encode(crypto.randomBytes(64));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const quiet = { warn() {}, log() {} };
const ROOT = addr(), CFG = addr(), OWNER = addr(), CREATOR = addr();
const PNG = 'data:image/png;base64,' + Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.from('a very small picture')]).toString('base64');
const moderate = (t) => checkMessage(t, []);

// the chain (server/dbc.js), Jupiter and a Solana RPC, faked
function fakes({ noDirect = false } = {}) {
  const pools = [], calls = [], configs = new Map(), tradesFor = new Map(), txs = new Map(), pictures = new Map(), NEW = addr();
  const dbc = {
    fetchConfig: async ({ address }) => configs.get(address) || null,
    listPools: async ({ config }) => pools.filter((p) => p.config === config),
    fetchPools: async ({ addresses }) => addresses.map((a) => pools.find((p) => p.address === a) || null),
    poolPrice: (p) => ({ price: 0.5, mcap: 5e8, progress: 0.25, graduated: (p.stage || 'curve') !== 'curve', stage: p.stage || 'curve' }),
    quoteBuy: (state, amt) => ({ out: BigInt(amt) * 2n, fee: 0n }),
    quoteSell: (state, amt) => ({ out: BigInt(amt) / 2n, fee: 0n }),
    buildSwap: async (o) => { calls.push(['curve', o]); return { tx: 'Q1VSVkU=' }; },
    buildCreateConfig: async (o) => { calls.push(['config', o]); return { address: f.nextConfig || CFG, tx: 'Q0ZH', curve: { graduationQuote: 1234, startMcap: o.startMcap, graduationMcap: o.graduationMcap, creatorShare: o.creatorShare } }; },
    buildCreatePool: async (o) => { calls.push(['create', o]); return { mint: NEW, pool: addr(), tx: 'Q1JF', firstBuy: null }; },
    buildClaimAndBurn: async ({ pools: ps, burn = true }) => { calls.push(['claimAndBurn', { burn, pools: ps.length }]); return ps.length ? [{ tx: 'QlVS', pools: ps.map((p) => p.address), [burn ? 'burn' : 'claim']: ps.reduce((n, p) => n + Number(p.partnerQuoteFee) / (burn ? 1e6 : 1e9), 0) }] : []; },
    buildClaimCreator: async ({ pool }) => ({ tx: 'Q0xN', amount: Number(pool.creatorQuoteFee) / 1e6 }),
    fetchTrades: async ({ signature }) => tradesFor.get(signature) ?? [],
    buildClaimGraduated: async (o) => { calls.push(['claimGraduated', o]); return o.coins.map((c) => ({ tx: 'R1JBRA==', coins: [c.baseMint] })); },
    buildBurnReceived: async (o) => { calls.push(['burnReceived', o]); return { tx: 'QlVSTg==', burns: [{ mint: ROOT, amount: 4 }] }; },
    ata: (owner, mint) => `ata:${owner}:${mint}`,
  };
  const f = { nextConfig: null, balance: 5e9, wsol: '0' };
  const reply = (o, status = 200) => new Response(JSON.stringify(o), { status });
  const fetchImpl = async (url, init = {}) => {
    const u = String(url);
    calls.push(['fetch', u, init.headers || {}]);
    if (/\/price\/v3/.test(u)) return reply({ [SOL_MINT]: { usdPrice: 200 }, [ROOT]: { usdPrice: 0.02 } });
    if (/\/swap\/v1\/quote/.test(u)) {
      const q = new URL(u).searchParams, i = q.get('inputMint'), o = q.get('outputMint');
      calls.push(['quote', Object.fromEntries(q)]);
      if (noDirect && i !== ROOT && o !== ROOT) return reply({ error: 'Could not find any route', errorCode: 'COULD_NOT_FIND_ANY_ROUTE' }, 400);
      const via = i === SOL_MINT && o !== ROOT ? [{ swapInfo: { outputMint: ROOT } }] : [];
      return reply({ inputMint: i, outputMint: o, outAmount: '5000000', otherAmountThreshold: '4850000', priceImpactPct: '0.002', routePlan: [...via, { swapInfo: { outputMint: o } }] });
    }
    if (/\/swap\/v1\/swap/.test(u)) { calls.push(['swap', JSON.parse(init.body)]); return reply({ swapTransaction: 'U1dBUA==' }); }
    if (u.startsWith('http://rpc.test')) {
      const { method, params } = JSON.parse(init.body);
      if (method === 'getSignatureStatuses') return reply({ jsonrpc: '2.0', id: 1, result: { value: [{ confirmationStatus: 'confirmed', err: null }] } });
      if (method === 'getTransaction') return reply({ jsonrpc: '2.0', id: 1, result: txs.get(params[0]) ?? null });
      if (method === 'getSignaturesForAddress') return reply({ jsonrpc: '2.0', id: 1, result: [] });
      if (method === 'getBalance') return reply({ jsonrpc: '2.0', id: 1, result: { value: f.balance } });
      if (method === 'getAccountInfo') {   // a token account: its amount at byte 64
        if (f.wsol === '0') return reply({ jsonrpc: '2.0', id: 1, result: { value: null } });
        const d = Buffer.alloc(165); d.writeBigUInt64LE(BigInt(f.wsol), 64);
        return reply({ jsonrpc: '2.0', id: 1, result: { value: { data: [d.toString('base64'), 'base64'], owner: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' } } });
      }
    }
    if (pictures.has(u)) return reply(pictures.get(u));
    throw new Error('unexpected fetch ' + u);
  };
  const pool = (mint, extra = {}) => ({ address: addr(), config: CFG, baseMint: mint, creator: CREATOR, baseVault: addr(), quoteVault: addr(), partnerQuoteFee: 3_000_000n, creatorQuoteFee: 2_000_000n, activationPoint: 1, name: '', symbol: '', ...extra });
  // a parsed transaction in which `authority` burned `amount` of `mint`
  const burnTx = (mint, authority, amount) => ({ meta: { err: null }, transaction: { message: { instructions: [{ program: 'spl-token', parsed: { type: 'burnChecked', info: { mint, authority, tokenAmount: { amount: String(amount * 1e6), decimals: 6 } } } }] } } });
  return Object.assign(f, { dbc, fetchImpl, pools, calls, configs, tradesFor, txs, pictures, pool, burnTx, NEW });
}
const openConfig = (f) => f.configs.set(CFG, { address: CFG, quoteMint: ROOT, feeClaimer: OWNER, collectFeeMode: 0, creatorShare: 20 });
// a launchpad that is already open, with one coin spawned on the page
async function openSpawn(fOpts, spOpts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spawn-'));
  const f = fakes(fOpts), MINT = addr();
  fs.mkdirSync(path.join(dir, 'spawn'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'spawn', 'state.json'), JSON.stringify({ configs: [{ address: CFG, partner: OWNER, quoteMint: ROOT, graduationQuote: 1234 }], coins: { [MINT]: { name: 'Good Coin', symbol: 'GOOD', image: '', creator: CREATOR, createdAt: Date.now() } } }));
  openConfig(f);
  f.pools.push(f.pool(MINT));
  const sp = createSpawn({ dir, dbc: f.dbc, rootMint: () => ROOT, moderate, fetchImpl: f.fetchImpl, opts: { rpc: 'http://rpc.test', publicUrl: 'https://worm.example', localMeta: true, ...spOpts }, logger: quiet });
  await sp.fresh(true);
  return { sp, f, MINT, dir };
}

test('SPAWN priced in $BRAINWORM: shut until a config exists; then coins, creator fees, claim and burn', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spawn-'));
  const f = fakes();
  let root = '';
  const sp = createSpawn({ dir, dbc: f.dbc, rootMint: () => root, moderate, fetchImpl: f.fetchImpl, opts: { rpc: 'http://rpc.test', publicUrl: 'https://worm.example', localMeta: true }, logger: quiet });
  assert.equal(sp.publicState().open, false);
  assert.match(sp.publicState().reason, /soon/);
  await assert.rejects(sp.quote({ mint: addr(), side: 'buy', amount: 1 }), /not open/);
  await assert.rejects(sp.buildConfig({ partner: OWNER, startMcap: 1, graduationMcap: 2, quote: 'root' }), /exist first/);
  root = ROOT;
  assert.match(sp.publicState().reason, /soon/);

  // the owner's config counts once it is on chain as it was built
  await assert.rejects(sp.buildConfig({ partner: 'nope', startMcap: 1e6, graduationMcap: 1.3e7 }), /wallet/);
  assert.equal((await sp.buildConfig({ partner: OWNER, startMcap: 1e6, graduationMcap: 1.3e7 })).address, CFG);
  const cfgCall = f.calls.find((c) => c[0] === 'config')[1];
  assert.equal(cfgCall.quoteMint, ROOT); assert.equal(cfgCall.creatorShare, 20);
  assert.deepEqual(await sp.confirmConfig({ signature: sig() }), { ok: false, error: 'Not on chain yet.' });
  f.configs.set(CFG, { address: CFG, quoteMint: ROOT, feeClaimer: addr(), collectFeeMode: 0, creatorShare: 20 });
  await assert.rejects(sp.confirmConfig({ signature: sig() }), /not the one/);
  openConfig(f);
  assert.equal((await sp.confirmConfig({ signature: sig() })).ok, true);
  assert.equal(sp.publicState().open, true);
  assert.equal(sp.publicState().graduationQuote, 1234);
  await assert.rejects(sp.buildConfig({ partner: addr(), startMcap: 1e6, graduationMcap: 1.3e7 }), /owner wallet/);
  assert.equal(sp.publicState().quote, '$BRAINWORM');

  // spawning: the name and ticker are checked, the picture is checked and hosted, the coin goes on the newest config
  await assert.rejects(sp.create({ creator: CREATOR, name: 'Good', symbol: 'no way!', image: PNG }), /Tickers/);
  await assert.rejects(sp.create({ creator: CREATOR, name: 'see https://scam.example', symbol: 'OK', image: PNG }));
  await assert.rejects(sp.create({ creator: CREATOR, name: 'Good', symbol: 'BRAINWORM', image: PNG }), /taken/);
  await assert.rejects(sp.create({ creator: CREATOR, name: 'Good', symbol: 'GOOD', image: 'data:text/html;base64,AAAA' }), /picture/);
  await assert.rejects(sp.create({ creator: CREATOR, name: 'Good', symbol: 'GOOD', image: 'data:image/png;base64,' + Buffer.from('<svg onload=x>').toString('base64') }), /not the picture/);
  const made = await sp.create({ creator: CREATOR, name: 'Good Coin', symbol: 'good', image: PNG, firstBuy: '10' });
  const cc = f.calls.find((x) => x[0] === 'create')[1];
  assert.equal(cc.config, CFG); assert.equal(cc.symbol, 'GOOD'); assert.equal(cc.firstBuyQuote, 10); assert.equal(cc.creator, CREATOR);
  assert.match(cc.uri, /^https:\/\/worm\.example\/spawn\/meta\/[0-9a-f]{24}\.json$/);
  const meta = JSON.parse(fs.readFileSync(sp.metaFile(cc.uri.split('/').pop())));
  assert.equal(meta.symbol, 'GOOD');
  assert.ok(sp.metaFile(meta.image.split('/').pop()));
  assert.equal(sp.metaFile('../state.json'), null);

  // the listing: coins spawned here, and ones made on the curve some other way only if their name passes the filter
  f.pools.push(f.pool(made.mint), f.pool(addr(), { name: 'Other', symbol: 'OTHR', creator: addr() }), f.pool(addr(), { name: 'buy at https://scam.example', symbol: 'SCAM' }));
  assert.equal(sp.created({ mint: made.mint, signature: sig() }), true);
  await sp.fresh(true);
  const st = sp.publicState();
  assert.deepEqual(st.coins.map((x) => x.symbol).sort(), ['GOOD', 'OTHR']);
  const good = st.coins.find((x) => x.symbol === 'GOOD');
  assert.match(good.image, /^https:\/\/worm\.example\/spawn\/meta\//);
  assert.equal(good.stage, 'curve');
  assert.equal(st.coins.find((x) => x.symbol === 'OTHR').image, '', 'no pictures from hosts the page does not allow');
  assert.ok(Math.abs(good.priceSol - 0.5 * 0.0001) < 1e-12, '0.5 $BRAINWORM at 0.0001 SOL each');
  assert.equal(st.root.waiting, 9, 'three pools, 3 $BRAINWORM each waiting to burn');

  // creators claim their own fees; the owner claims and burns the launchpad's share, and a burn counts as the chain says
  await assert.rejects(sp.claimCreator({ mint: made.mint, creator: OWNER }), /Only the wallet/);
  assert.deepEqual(await sp.claimCreator({ mint: made.mint, creator: CREATOR }), { txs: ['Q0xN'], amount: 2, quote: '$BRAINWORM' });
  await assert.rejects(sp.buildClaimAndBurn({ feeClaimer: CREATOR }), /fee claimer/);
  const burns = await sp.buildClaimAndBurn({ feeClaimer: OWNER });
  assert.deepEqual(burns.map((b) => [b.pools.length, b.burn]), [[3, 9]]);
  await assert.rejects(sp.buildClaimAndBurn({ feeClaimer: OWNER }), /may still land/, 'no second claim of the same fees while the first can land');
  const s1 = sig(), s2 = sig(), s3 = sig();
  assert.deepEqual(await sp.burned({ signature: s1 }), { ok: false, error: 'Not confirmed yet.' });
  f.txs.set(s1, f.burnTx(ROOT, OWNER, 9));
  f.txs.set(s2, f.burnTx(ROOT, addr(), 9));
  f.txs.set(s3, f.burnTx(addr(), OWNER, 9));
  assert.deepEqual(await sp.burned({ signature: s1 }), { ok: true, amount: 9 });
  assert.match((await sp.burned({ signature: s2 })).error, /burned no/, 'someone else\'s burn is not SPAWN\'s');
  assert.match((await sp.burned({ signature: s3 })).error, /burned no/, 'a burn of another coin is not a $BRAINWORM burn');
  assert.deepEqual(await sp.burned({ signature: s1 }), { ok: true }, 'counted once');
  assert.equal(sp.publicState().root.burned, 9);
  assert.deepEqual(sp.publicState().root.burns.map((b) => [b.signature, b.amount]), [[s1, 9]]);

  sp.addReaction(made.mint, 40); sp.addReaction(made.mint, 2);
  assert.deepEqual(sp.publicState().movers[0], { mint: made.mint, symbol: 'GOOD', pokes: 2, cells: 42 });
  sp.stop();
  const again = createSpawn({ dir, dbc: f.dbc, rootMint: () => ROOT, fetchImpl: f.fetchImpl, opts: { rpc: 'http://rpc.test', publicUrl: 'https://worm.example', localMeta: true }, logger: quiet });
  assert.equal(again.publicState().open, true, 'state survives a restart');
  assert.equal(again.publicState().root.burned, 9);
  again.stop();
});

test('buying: one Jupiter transaction when it has a route; each quote is the server\'s own, used once, in order, by one wallet', async () => {
  const { sp, f, MINT } = await openSpawn();
  await assert.rejects(sp.quote({ mint: addr(), side: 'buy', amount: 1 }), /Not a SPAWN coin/);
  await assert.rejects(sp.quote({ mint: MINT, side: 'buy', amount: 0 }), /amount/);
  const q = await sp.quote({ mint: MINT, side: 'buy', amount: '0.5' });
  assert.equal(q.steps, 1);
  assert.deepEqual(q.route, ['SOL', '$BRAINWORM', '$GOOD']);
  assert.deepEqual(q.out, { symbol: '$GOOD', amount: 5, min: 4.85 });
  const jq = f.calls.filter((x) => x[0] === 'quote').at(-1)[1];
  assert.deepEqual([jq.inputMint, jq.outputMint, jq.amount, jq.slippageBps], [SOL_MINT, MINT, '500000000', '300']);
  assert.equal(jq.restrictIntermediateTokens, undefined, 'the free API refuses restrictIntermediateTokens=false');
  await assert.rejects(sp.swap({ quoteId: 'made-up', user: CREATOR }), /expired/);
  await assert.rejects(sp.swap({ quoteId: q.quoteId, user: CREATOR, step: 1 }), /order/);
  assert.deepEqual(await sp.swap({ quoteId: q.quoteId, user: CREATOR }), { tx: 'U1dBUA==', step: 0, steps: 1 });
  assert.equal(f.calls.find((x) => x[0] === 'swap')[1].userPublicKey, CREATOR);
  await assert.rejects(sp.swap({ quoteId: q.quoteId, user: CREATOR }), /expired/, 'used once');
  sp.stop();
});

test('without a Jupiter route through $BRAINWORM, a buy is two steps (SOL → $BRAINWORM, then the coin\'s own curve); a sell mirrors it', async () => {
  const { sp, f, MINT } = await openSpawn({ noDirect: true });
  const q = await sp.quote({ mint: MINT, side: 'buy', amount: '0.5' });
  assert.equal(q.steps, 2);
  assert.deepEqual(q.route, ['SOL', '$BRAINWORM', '$GOOD']);
  // step two spends the least step one can deliver (4.85 $BRAINWORM), on the curve, with a 3% floor
  assert.deepEqual(q.out, { symbol: '$GOOD', amount: 9.7, min: 9.409 });
  const other = addr();
  assert.equal((await sp.swap({ quoteId: q.quoteId, user: CREATOR, step: 0 })).tx, 'U1dBUA==');
  await assert.rejects(sp.swap({ quoteId: q.quoteId, user: other, step: 1 }), /another wallet/);
  assert.deepEqual(await sp.swap({ quoteId: q.quoteId, user: CREATOR, step: 1 }), { tx: 'Q1VSVkU=', step: 1, steps: 2 });
  const leg = f.calls.find((x) => x[0] === 'curve')[1];
  assert.deepEqual([leg.side, leg.trader, leg.amountIn, leg.minOut], ['buy', CREATOR, 4_850_000n, 9_409_000n]);
  assert.equal(leg.pool.baseMint, MINT);

  const s = await sp.quote({ mint: MINT, side: 'sell', amount: '10' });
  assert.equal(s.steps, 2);
  assert.deepEqual(s.route, ['$GOOD', '$BRAINWORM', 'SOL']);
  const toSol = f.calls.filter((x) => x[0] === 'quote').at(-1)[1];
  assert.deepEqual([toSol.inputMint, toSol.outputMint, toSol.amount], [ROOT, SOL_MINT, '4850000'], 'step two sells the least step one can deliver');
  assert.deepEqual(s.out, { symbol: 'SOL', amount: 0.005, min: 0.00485 });

  // paying with $BRAINWORM is one step on the curve, whatever Jupiter can do
  const r = await sp.quote({ mint: MINT, side: 'buy', amount: '3', pay: 'root' });
  assert.equal(r.steps, 1);
  assert.deepEqual(r.route, ['$BRAINWORM', '$GOOD']);
  assert.deepEqual(r.out, { symbol: '$GOOD', amount: 6, min: 5.82 });
  sp.stop();
});

test('a coin whose curve filled waits for its graduation; a graduated one trades through Jupiter', async () => {
  const { sp, f, MINT } = await openSpawn({ noDirect: true });
  f.pools[0].stage = 'graduating';
  await sp.fresh(true);
  assert.equal(sp.publicState().coins[0].stage, 'graduating');
  await assert.rejects(sp.quote({ mint: MINT, side: 'buy', amount: 1 }), /graduating/);
  f.pools[0].stage = 'graduated';
  await sp.fresh(true);
  const q = await sp.quote({ mint: MINT, side: 'buy', amount: '2', pay: 'root' });
  const jq = f.calls.filter((x) => x[0] === 'quote').at(-1)[1];
  assert.deepEqual([jq.inputMint, jq.outputMint, jq.amount], [ROOT, MINT, '2000000'], 'after graduation the $BRAINWORM leg goes through Jupiter');
  assert.equal((await sp.swap({ quoteId: q.quoteId, user: CREATOR })).tx, 'U1dBUA==');
  sp.stop();
});

test('with a Jupiter key: its API, its header, and routes through less-traded middle tokens', async () => {
  const { sp, f, MINT } = await openSpawn({}, { jupiterKey: 'k-123' });
  await sp.quote({ mint: MINT, side: 'buy', amount: '1' });
  const [, url, headers] = f.calls.filter((x) => x[0] === 'fetch' && /quote/.test(x[1])).at(-1);
  assert.match(url, /^https:\/\/api\.jup\.ag\/swap\/v1\/quote\?/);
  assert.equal(headers['x-api-key'], 'k-123');
  assert.equal(new URL(url).searchParams.get('restrictIntermediateTokens'), 'false');
  sp.stop();
});

test('pictures go to Pinata with SPAWN named as where the coin was made', async () => {
  const up = [];
  const { sp } = await openSpawn({}, { pinataJwt: 'jwt', uploadPinata: async (o) => { up.push(o); return { metadataUri: 'https://ipfs.io/ipfs/bafkmeta', metadata: { image: 'https://ipfs.io/ipfs/bafkimage' } }; } });
  const made = await sp.create({ creator: CREATOR, name: 'Pinned', symbol: 'PIN', image: PNG });
  assert.equal(up[0].createdOn, 'https://worm.example/spawn');
  assert.equal(up[0].jwt, 'jwt');
  assert.ok(made.mint);
  assert.deepEqual(await sp.confirm({ signature: sig() }), { confirmed: true, failed: false });
  sp.stop();
});

class FakeWS extends EventEmitter {
  constructor(url) { super(); this.url = url; this.sent = []; FakeWS.all.push(this); setImmediate(() => this.emit('open')); }
  send(s) { this.sent.push(JSON.parse(s)); }
  ping() {}
  terminate() { this.emit('close'); }
  static all = [];
  static note(signature, err = null) { for (const w of FakeWS.all) w.emit('message', JSON.stringify({ jsonrpc: '2.0', method: 'logsNotification', params: { result: { value: { signature, err, logs: [] } } } })); }
}

test('the server: SPAWN buys poke the worm at the coin\'s own spot, logged with their transaction, and credited to the coin', async () => {
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spawn-srv-'));
  const f = fakes(), MINT = addr(), p = f.pool(MINT), S1 = sig(), S2 = sig(), S3 = sig();
  fs.mkdirSync(path.join(logDir, 'spawn'), { recursive: true });
  fs.writeFileSync(path.join(logDir, 'spawn', 'state.json'), JSON.stringify({ configs: [{ address: CFG, partner: OWNER, graduationQuote: 1234 }], coins: { [MINT]: { name: 'Good Coin', symbol: 'GOOD', image: '', creator: CREATOR, createdAt: Date.now() } } }));
  openConfig(f);
  f.pools.push(p);
  f.tradesFor.set(S1, [{ pool: p.address, config: CFG, side: 'buy', quote: 2_000_000n, coins: 1n, trader: addr() }]);
  f.tradesFor.set(S2, [{ pool: p.address, config: CFG, side: 'sell', quote: 2_000_000n, coins: 1n, trader: addr() }]);
  FakeWS.all = [];
  const app = createWormServer({
    logDir, speed: 10, ots: false, lab: false, pow: { bits: 0 }, publicUrl: 'https://worm.example', token: { mint: ROOT, solanaRpc: 'http://rpc.test' }, spawn: { localMeta: true },
    tradeStreamFactory: () => ({ start() {}, stop: async () => {}, status: () => ({}) }),
    spawnDeps: { dbc: f.dbc, fetchImpl: f.fetchImpl, ws: 'wss://rpc.test', WebSocketImpl: FakeWS },
  });
  const { port } = await app.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${port}`;
  const post = (p2, body) => fetch(base + p2, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  try {
    const page = await fetch(base + '/spawn');
    assert.equal(page.status, 200);
    assert.match(await page.clone().text(), /What the worm has to do with it/);
    assert.match(page.headers.get('content-security-policy'), /img-src 'self' data: blob: https:\/\/ipfs\.io https:\/\/gateway\.pinata\.cloud/);
    const pub = await (await fetch(base + '/spawn.json')).json();
    assert.equal(pub.open, true);
    assert.deepEqual(pub.coins.map((c) => c.symbol), ['GOOD']);
    const features = (await (await fetch(base + '/config.json')).json()).features;
    assert.deepEqual([features.spawn, features.spawnQuote], [true, '$BRAINWORM']);
    const bad = await post('/spawn/quote', { mint: addr(), side: 'buy', amount: 1 });
    assert.equal(bad.status, 400); assert.match((await bad.json()).error, /Not a SPAWN coin/);
    assert.deepEqual(await (await post('/spawn/confirm', { signature: S1 })).json(), { confirmed: true, failed: false });
    assert.equal((await fetch(base + '/spawn/nope', { method: 'POST', body: '{}' })).status, 404);
    for (const f2 of ['spawn-logo.svg', 'spawn-icon.png', 'spawn-og.png']) assert.equal((await fetch(`${base}/${f2}`)).status, 200, f2);

    // the trade stream subscribes to the config; a buy pokes, a sell doesn't, a failed or repeated one is ignored
    for (let k = 0; k < 100 && !FakeWS.all.some((w) => w.sent.length); k++) await sleep(20);
    assert.deepEqual(FakeWS.all[0].sent.map((m) => m.params[0].mentions), [[CFG]]);
    FakeWS.note(S3, { InstructionError: [0, 'x'] });
    FakeWS.note(S2); FakeWS.note(S1); FakeWS.note(S1);
    let log = '';
    for (let k = 0; k < 200 && !log.includes(S1); k++) { await sleep(25); log = fs.readFileSync(app.logPath, 'utf8'); }
    const pokes = log.trim().split('\n').map((l) => JSON.parse(l)).filter((e) => e.k === 'poke' && e.by === 'spawn:$GOOD');
    assert.equal(pokes.length, 1, 'one buy, one poke');
    assert.equal(pokes[0].sig, S1); assert.equal(pokes[0].side, 'buy'); assert.equal(pokes[0].sol, 0.0002, '2 $BRAINWORM at 0.0001 SOL');
    // the coin's own spot: three touch cells picked from the SHA-256 of its address
    const h = crypto.createHash('sha256').update(MINT).digest(), touch = app.worm.roles.touch, spot = [];
    for (let k = 0; spot.length < 3; k++) { const c = touch[h[k] % touch.length]; if (!spot.includes(c)) spot.push(c); }
    assert.deepEqual(pokes[0].cells, spot);
    let movers = [];
    for (let k = 0; k < 400 && !movers.length; k++) { await sleep(25); movers = (await (await fetch(base + '/spawn.json')).json()).movers; }
    assert.equal(movers[0].symbol, 'GOOD'); assert.equal(movers[0].pokes, 1); assert.ok(movers[0].cells > 0);

    // the coin's own worm hatched when it was listed and felt both trades; its record rebuilds to the same worm
    const rec = await (await fetch(`${base}/spawn/worm/${MINT}.json`)).json();
    assert.equal(rec.ticker, 'GOOD');
    assert.deepEqual(rec.trades.map((t) => [t.signature, t.side]), [[S2, 'sell'], [S1, 'buy']], 'buys and sells, each once, in the order they came');
    const { rebuild } = await import('../shared/coinworm.js'), { stateString } = await import('../shared/replay.js'), { loadD } = await import('./data.js');
    assert.equal(crypto.createHash('sha256').update(stateString(rebuild(loadD(), rec.ticker, rec.trades).worm)).digest('hex'), rec.sha);
    const coin = (await (await fetch(base + '/spawn.json')).json()).coins[0];
    assert.equal(coin.own.trades, 2); assert.equal(coin.own.sha, rec.sha);
    for (const u of [`/spawn/worm/${MINT}.png`, `/spawn/worm/${MINT}-birth.png`, '/spawn/hatch/GOOD.png']) {
      const r = await fetch(base + u);
      assert.equal(r.status, 200, u); assert.equal(r.headers.get('content-type'), 'image/png');
    }
    assert.ok((await (await fetch(base + '/spawn/hatch/GOOD.json')).json()).peak > 0);
    assert.equal((await fetch(base + '/spawn/hatch/nope!.json')).status, 404);
  } finally { await app.close(); }
});

test('the server before its first config: /spawn says it opens soon, and builds nothing', async () => {
  const app = createWormServer({ logDir: '', ots: false, lab: false, pow: { bits: 0 }, spawnDeps: { dbc: fakes().dbc, fetchImpl: async () => { throw new Error('no network in tests'); } } });
  const { port } = await app.listen(0, '127.0.0.1');
  try {
    const pub = await (await fetch(`http://127.0.0.1:${port}/spawn.json`)).json();
    assert.equal(pub.open, false); assert.match(pub.reason, /soon/); assert.equal(pub.quote, null);
    const r = await fetch(`http://127.0.0.1:${port}/spawn/create`, { method: 'POST', body: JSON.stringify({ creator: addr() }) });
    assert.equal(r.status, 400); assert.match((await r.json()).error, /not open/);
    assert.equal((await (await fetch(`http://127.0.0.1:${port}/config.json`)).json()).features.spawn, false);
  } finally { await app.close(); }
});

test('after graduation: the fee claimer\'s share of each graduated pool is claimed, then exactly what arrived is burned', async () => {
  const { sp, f, MINT } = await openSpawn();
  f.configs.set(CFG, { ...f.configs.get(CFG), migrationFeeOption: 2 });
  await assert.rejects(sp.buildClaimGraduated({ feeClaimer: CREATOR }), /fee claimer/);
  assert.deepEqual(await sp.buildClaimGraduated({ feeClaimer: OWNER }), [], 'nothing has graduated');
  f.pools[0].stage = 'graduated';
  const other = addr();
  f.pools.push(f.pool(other));   // still on its curve
  const txs = await sp.buildClaimGraduated({ feeClaimer: OWNER });
  assert.deepEqual(txs, [{ tx: 'R1JBRA==', coins: [MINT] }]);
  const call = f.calls.filter((c) => c[0] === 'claimGraduated').at(-1)[1];
  assert.deepEqual(call.coins, [{ baseMint: MINT, quoteMint: ROOT, migrationFeeOption: 2 }]);
  assert.equal(call.owner, OWNER);
  // the creator claims their own share: the curve's creator fees and their position in the graduated pool
  assert.deepEqual(await sp.claimCreator({ mint: MINT, creator: CREATOR }), { txs: ['Q0xN', 'R1JBRA=='], amount: 2, quote: '$BRAINWORM' });
  assert.equal(f.calls.filter((c) => c[0] === 'claimGraduated').at(-1)[1].owner, CREATOR);
  const s1 = sig();
  assert.deepEqual(await sp.burnClaimed({ signature: s1 }), { tx: 'QlVSTg==', burns: [{ mint: ROOT, amount: 4 }] });
  const b = f.calls.filter((c) => c[0] === 'burnReceived').at(-1)[1];
  assert.deepEqual([b.signature, b.owner, b.keep, b.only], [s1, OWNER, [ROOT, SOL_MINT], undefined], 'the owner\'s $BRAINWORM account stays open');
  sp.stop();
});

test('before $BRAINWORM: a config priced in SOL opens SPAWN; its coins trade in SOL on their curves; the launchpad\'s share waits, then buys $BRAINWORM to burn', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spawn-'));
  const f = fakes();
  let root = '';
  const sp = createSpawn({ dir, dbc: f.dbc, rootMint: () => root, moderate, fetchImpl: f.fetchImpl, opts: { rpc: 'http://rpc.test', publicUrl: 'https://worm.example', localMeta: true }, logger: quiet });
  assert.equal(sp.publicState().quote, null);
  await assert.rejects(sp.buildConfig({ partner: OWNER, startMcap: 28, graduationMcap: 400, quote: 'root' }), /exist first/);
  const b = await sp.buildConfig({ partner: OWNER, startMcap: 28, graduationMcap: 400 });
  assert.equal(b.quote, 'SOL');
  assert.equal(f.calls.find((c) => c[0] === 'config')[1].quoteMint, SOL_MINT, 'priced in SOL while $BRAINWORM does not exist');
  f.configs.set(CFG, { address: CFG, quoteMint: SOL_MINT, feeClaimer: OWNER, collectFeeMode: 0, creatorShare: 20 });
  assert.equal((await sp.confirmConfig({ signature: sig() })).ok, true);
  assert.equal(sp.publicState().open, true);
  assert.equal(sp.publicState().quote, 'SOL');

  // a coin: its first buy in SOL, and the wallet's SOL checked before anything is uploaded
  f.balance = 0.5e9;
  await assert.rejects(sp.create({ creator: CREATOR, name: 'Sol Coin', symbol: 'SOLC', image: PNG, firstBuy: '1' }), /needs about 1\.02 SOL.*It has 0\.5/);
  assert.equal(fs.readdirSync(path.join(dir, 'spawn', 'meta')).length, 0, 'nothing uploaded for a wallet that can\'t pay');
  f.balance = 5e9;
  const made = await sp.create({ creator: CREATOR, name: 'Sol Coin', symbol: 'SOLC', image: PNG, firstBuy: '1' });
  assert.equal(made.quote, 'SOL');
  assert.equal(f.calls.filter((c) => c[0] === 'create').at(-1)[1].firstBuyQuote, 1);
  f.pools.push(f.pool(made.mint, { partnerQuoteFee: 30_000_000n, creatorQuoteFee: 7_500_000n }));
  await sp.fresh(true, true);
  const coin = sp.publicState().coins.find((c) => c.symbol === 'SOLC');
  assert.equal(coin.quote, 'SOL');
  assert.equal(coin.priceSol, 0.5, 'its curve\'s price is already in SOL');
  assert.equal(coin.creatorFees, 0.0075);
  assert.deepEqual([sp.publicState().root.waitingSol, sp.publicState().root.waiting], [0.03, 0]);

  // trading: one step on its own curve, in SOL either way ($BRAINWORM isn't on offer for it)
  const q = await sp.quote({ mint: made.mint, side: 'buy', amount: '0.5', pay: 'root' });
  assert.deepEqual([q.steps, q.route, q.out], [1, ['SOL', '$SOLC'], { symbol: '$SOLC', amount: 1000, min: 970 }]);
  assert.equal((await sp.swap({ quoteId: q.quoteId, user: CREATOR })).tx, 'Q1VSVkU=');
  const leg = f.calls.filter((c) => c[0] === 'curve').at(-1)[1];
  assert.deepEqual([leg.side, leg.amountIn, leg.minOut], ['buy', 500_000_000n, 970_000_000n], '0.5 SOL in lamports; the floor in coin atoms');
  const s = await sp.quote({ mint: made.mint, side: 'sell', amount: '100' });
  assert.deepEqual([s.route, s.out], [['$SOLC', 'SOL'], { symbol: 'SOL', amount: 0.05, min: 0.0485 }]);
  assert.ok(!f.calls.some((c) => c[0] === 'quote'), 'no Jupiter for a coin on its curve');

  // its creator's fees arrive as SOL; the launchpad's share waits in the pools while $BRAINWORM doesn't exist
  assert.deepEqual(await sp.claimCreator({ mint: made.mint, creator: CREATOR }), { txs: ['Q0xN'], amount: 0.0075, quote: 'SOL' });
  await assert.rejects(sp.buildClaimSol({ feeClaimer: OWNER }), /wait in their pools/);
  assert.deepEqual(await sp.buildClaimAndBurn({ feeClaimer: OWNER }), [], 'fees in SOL are never burned as SOL');

  // $BRAINWORM launches: the SOL is claimed (kept wrapped), swapped for $BRAINWORM, and exactly what that bought is burned
  root = ROOT;
  assert.equal(sp.publicState().quote, 'SOL', 'new coins stay in SOL until the owner makes a $BRAINWORM config');
  await assert.rejects(sp.buildClaimSol({ feeClaimer: CREATOR }), /fee claimer/);
  const claims = await sp.buildClaimSol({ feeClaimer: OWNER });
  assert.deepEqual(claims.map((t) => [t.pools.length, t.claim]), [[1, 0.03]]);
  assert.deepEqual(f.calls.filter((c) => c[0] === 'claimAndBurn').at(-1)[1], { burn: false, pools: 1 });
  await assert.rejects(sp.buildClaimSol({ feeClaimer: OWNER }), /may still land/);
  await assert.rejects(sp.buyback({ feeClaimer: OWNER }), /No claimed fees/);
  f.wsol = '30000000';
  const bb = await sp.buyback({ feeClaimer: OWNER });
  assert.deepEqual([bb.tx, bb.sol, bb.root], ['U1dBUA==', 0.03, 5]);
  const jq = f.calls.filter((x) => x[0] === 'quote').at(-1)[1];
  assert.deepEqual([jq.inputMint, jq.outputMint, jq.amount], [SOL_MINT, ROOT, '30000000']);
  const js = f.calls.filter((x) => x[0] === 'swap').at(-1)[1];
  assert.deepEqual([js.userPublicKey, js.wrapAndUnwrapSol], [OWNER, false], 'it spends the wrapped SOL, not the wallet\'s own');
  const swapSig = sig();
  assert.equal((await sp.burnClaimed({ signature: swapSig, buyback: true })).tx, 'QlVSTg==');
  const br = f.calls.filter((c) => c[0] === 'burnReceived').at(-1)[1];
  assert.deepEqual([br.signature, br.owner, br.only], [swapSig, OWNER, [ROOT]], 'only the $BRAINWORM it bought');

  // the owner's $BRAINWORM config: new coins are priced in it, the SOL coin keeps trading in SOL
  f.nextConfig = addr();
  assert.equal((await sp.buildConfig({ partner: OWNER, startMcap: 1e6, graduationMcap: 1.3e7 })).quote, '$BRAINWORM');
  f.configs.set(f.nextConfig, { address: f.nextConfig, quoteMint: ROOT, feeClaimer: OWNER, collectFeeMode: 0, creatorShare: 20 });
  assert.equal((await sp.confirmConfig({ signature: sig() })).ok, true);
  assert.deepEqual([sp.publicState().quote, sp.publicState().config], ['$BRAINWORM', f.nextConfig]);
  await sp.create({ creator: CREATOR, name: 'Root Coin', symbol: 'ROOTC', image: PNG });
  assert.equal(f.calls.filter((c) => c[0] === 'create').at(-1)[1].config, f.nextConfig);
  assert.equal(sp.publicState().coins.find((c) => c.symbol === 'SOLC').quote, 'SOL');
  sp.stop();
});

test('with the owner\'s address SPAWN needs no saved state: its configs from the chain, its coins\' pictures from their metadata', async () => {
  const f = fakes(), SOLCFG = addr(), ROOTCFG = addr(), NOTOURS = addr(), MINT = addr(), OTHER = addr();
  const cfg = (address, quoteMint, spawn = true) => ({ address, quoteMint, feeClaimer: OWNER, collectFeeMode: 0, creatorShare: 20, migrationQuoteThreshold: 84_000_000_000n, spawn });
  f.configs.set(SOLCFG, cfg(SOLCFG, SOL_MINT)); f.configs.set(ROOTCFG, cfg(ROOTCFG, ROOT)); f.configs.set(NOTOURS, cfg(NOTOURS, SOL_MINT, false));
  f.dbc.findConfigs = async ({ feeClaimer }) => [...f.configs.values()].filter((c) => c.feeClaimer === feeClaimer);
  f.dbc.isSpawnConfig = (c) => c.spawn;
  f.pools.push(f.pool(MINT, { config: SOLCFG, name: 'Found', symbol: 'FOUND', uri: 'https://ipfs.io/ipfs/bafkfoundmeta' }), f.pool(OTHER, { config: NOTOURS, name: 'Other', symbol: 'OTHER' }));
  f.pictures.set('https://ipfs.io/ipfs/bafkfoundmeta', { name: 'Found', image: 'https://ipfs.io/ipfs/bafkfoundimage' });
  const opts = { rpc: 'http://rpc.test', publicUrl: 'https://worm.example', owner: OWNER, pinataJwt: 'jwt', uploadPinata: async () => ({ metadataUri: 'https://ipfs.io/ipfs/bafkm', metadata: { image: 'https://ipfs.io/ipfs/bafki' } }) };

  // before $BRAINWORM: its SOL config, found and open; a config with other parameters is not SPAWN's
  const early = createSpawn({ dir: null, dbc: f.dbc, rootMint: () => '', moderate, fetchImpl: f.fetchImpl, opts, logger: quiet });
  await early.fresh(true);
  assert.deepEqual([early.publicState().open, early.publicState().quote, early.publicState().config], [true, 'SOL', SOLCFG]);
  assert.deepEqual(early.publicState().coins.map((c) => c.symbol), ['FOUND']);
  early.stop();

  // after: both, and new coins go on $BRAINWORM's
  const sp = createSpawn({ dir: null, dbc: f.dbc, rootMint: () => ROOT, moderate, fetchImpl: f.fetchImpl, opts, logger: quiet });
  await sp.fresh(true);
  assert.deepEqual(sp.status().configs.map((c) => c.address).sort(), [SOLCFG, ROOTCFG].sort());
  assert.deepEqual([sp.publicState().quote, sp.publicState().config], ['$BRAINWORM', ROOTCFG]);
  await sleep(20); await sp.fresh(true);
  assert.equal(sp.publicState().coins[0].image, 'https://ipfs.io/ipfs/bafkfoundimage', 'the picture in its metadata, from a host the page allows');
  await assert.rejects(sp.buildConfig({ partner: addr(), startMcap: 1e6, graduationMcap: 1.3e7 }), /owner wallet/);
  sp.stop();
});

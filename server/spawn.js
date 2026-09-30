// SPAWN: the BRAINWORM launchpad. Anyone can spawn a coin on a Meteora Dynamic Bonding Curve. Until $BRAINWORM
// exists, coins are priced in SOL; once it has launched and the owner has made a config for it, new coins are priced
// in $BRAINWORM (coins made before keep trading in SOL). Every trade pays a 1% fee in the coin's quote token: Meteora
// keeps 20% of it, the coin's creator gets 20% of the rest, and the launchpad's share (64% of the fee) goes to
// $BRAINWORM's supply: fees in $BRAINWORM are claimed and burned whenever the owner signs a claim and burn; fees in
// SOL wait in their pools until $BRAINWORM exists, then are claimed, swapped for $BRAINWORM and burned. Each buy also
// pokes the worm at the coin's own spot.
//
// Every coin also hatches its own worm (shared/coinworm.js, kept by server/coinworms.js): a fresh copy of the same
// larva whose first sight is the coin's ticker and which feels every trade of the coin after that. Its trades also
// make its price chart (chart()).
//
// A coin priced in SOL trades on its own curve directly, in SOL (server/dbc.js wraps and unwraps it). A coin priced in
// $BRAINWORM: buying with SOL is one Jupiter transaction (SOL → $BRAINWORM → coin) when Jupiter finds a route;
// otherwise two, SOL → $BRAINWORM through Jupiter, then $BRAINWORM → coin on the coin's own curve, which works from
// the coin's first second. Holders of $BRAINWORM can trade on the curve directly, in one. Selling mirrors it.
//
// This module never holds a key and never sends a transaction. It builds unsigned transactions for people's own
// wallets (visitors, creators, the owner), reads the chain and reports trades. The only keys made are the fresh
// addresses of a new coin or config (server/dbc.js), which sign their own slot and are dropped.
//
// It keeps its state in LOG_DIR, and needs none of it to work: with the owner's address (SPAWN_OWNER) it finds its
// configs on the chain (and $BRAINWORM's mint in them, if the site has forgotten it), its coins' pictures in their
// metadata, and its burns in the owner's transactions.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import WebSocket from 'ws';
import { rpc, findProgramAddress, PUMP_PROGRAM } from './solana.js';
import { previewHatch } from './coinworms.js';

export const SOL_MINT = 'So11111111111111111111111111111111111111112';
export const FEE = Object.freeze({ bps: 100, protocolShare: 0.2, creatorShare: 0.2 });
export const SLIPPAGE_BPS = 300;
const QUOTE_TTL_MS = 120_000, REFRESH_MS = 20_000, SCAN_MS = 180_000, STALE_COIN_MS = 3600_000, CLAIM_LOCK_MS = 90_000, STUCK_MS = 600_000;
const MAX_IMAGE = 1_500_000, CHART_POINTS = 2000, SUPPLY = 1_000_000_000;
const ROOT_DECIMALS = 6;                 // $BRAINWORM, like every pump.fun coin
const LAUNCH_RENT_SOL = 0.02;            // what a new coin's own accounts cost its creator, about
const IMAGE_TYPES = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };
// a picture has to be what it says it is
const MAGIC = {
  'image/png': (b) => b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])),
  'image/jpeg': (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  'image/gif': (b) => /^GIF8[79]a$/.test(b.subarray(0, 6).toString('latin1')),
  'image/webp': (b) => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP',
};
export const IMAGE_HOSTS = ['https://ipfs.io/ipfs/', 'https://gateway.pinata.cloud/ipfs/'];   // the page's CSP allows these
const B58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/, SIG = /^[1-9A-HJ-NP-Za-km-z]{64,90}$/;
const dayKey = (ts = Date.now()) => new Date(ts).toISOString().slice(0, 10);
const round = (x, d = 6) => Math.round(x * 10 ** d) / 10 ** d;
const atoms = (x, decimals) => BigInt(Math.round(Number(x) * 10 ** decimals));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// what a config (or a coin on it) is priced in
const inSol = (c) => c?.quoteMint === SOL_MINT;
const decimalsOf = (c) => (inSol(c) ? 9 : ROOT_DECIMALS);
const quoteName = (c) => (inSol(c) ? 'SOL' : '$BRAINWORM');
const human = (e) => new Error(String(e?.message || e).replace(/^(dbc|solana): /, '').replace(/^./, (x) => x.toUpperCase()));

/**
 * @param {object} o
 * @param {string|null} o.dir       where state lives (LOG_DIR); null keeps it in memory
 * @param {object} o.dbc            server/dbc.js (injected so tests can fake the chain)
 * @param {() => string} o.rootMint $BRAINWORM's mint once it exists ('' before)
 * @param {(text: string) => {ok: boolean, text?: string, message?: string}} o.moderate  the site's chat filter
 * @param {object} o.opts           { rpc, ws, WebSocketImpl, publicUrl, pinataJwt, uploadPinata, jupiterKey, owner, localMeta }
 * @param {(t: object) => void} o.onTrade  every confirmed trade of a SPAWN coin
 * @param {object} [o.coinWorms]   server/coinworms.js: each coin's own worm
 * @param {object} [o.render]      server/render.js and the wiring D, for pictures drawn by a coin's worm
 */
export function createSpawn({ dir, dbc, rootMint, moderate = (t) => ({ ok: true, text: t }), opts = {}, onTrade = () => {}, coinWorms = null, render = null, D = null, fetchImpl = fetch, logger = console }) {
  const root = dir ? path.join(dir, 'spawn') : null;
  if (root) fs.mkdirSync(path.join(root, 'meta'), { recursive: true });
  const file = root && path.join(root, 'state.json');
  let s = { configs: [], coins: {}, images: {}, burns: [], day: { key: dayKey(), worm: {} } };
  try { if (file) s = { ...s, ...JSON.parse(fs.readFileSync(file, 'utf8')) }; } catch { /* first run */ }
  let saveTimer = null;
  const save = () => { if (!file || saveTimer) return; saveTimer = setTimeout(() => { saveTimer = null; fs.writeFile(file, JSON.stringify(s), () => {}); }, 500); };
  const chain = { url: opts.rpc, fetchImpl };
  // Jupiter's free API routes only through tokens it trusts as a middle hop; a key (a paid plan) lifts that
  const jupBase = opts.jupiterKey ? 'https://api.jup.ag' : 'https://lite-api.jup.ag';

  const quotes = new Map();   // quoteId -> {legs, at, user, next}: the server keeps each quote, so nobody can swap in a doctored one
  let pendingConfig = null;   // the config transaction last built for the owner, until it confirms
  let claimLockUntil = 0, solLockUntil = 0, scannedAt = 0, foundAt = 0;
  let cache = { at: 0, coins: [], pools: new Map(), byPool: new Map(), prices: {}, waiting: 0, waitingSol: 0, stuck: [] };
  // $BRAINWORM's mint: the site's (TOKEN_MINT or the launch record), else the one the owner's own configs on chain are
  // priced in (findConfigs), which only SPAWN uses: a deploy without a disk forgets the launch record
  let foundRoot = '';
  const brainworm = () => rootMint() || foundRoot || '';

  // configs are kept oldest first; old records name no quote mint and were all priced in $BRAINWORM
  const quoteMintOf = (c) => c.quoteMint || brainworm();
  /** The config new coins go on: the newest priced in $BRAINWORM once there is one, else the newest priced in SOL. */
  function current() {
    const r = brainworm(), mine = s.configs.filter((c) => quoteMintOf(c) === SOL_MINT || (r && quoteMintOf(c) === r));
    return mine.filter((c) => quoteMintOf(c) === r).at(-1) || mine.filter((c) => quoteMintOf(c) === SOL_MINT).at(-1) || null;
  }
  const partner = () => opts.owner || s.configs.at(-1)?.partner || null;
  // A picked picture and its metadata must stay up for good: on IPFS through Pinata, or on this server's own disk when that
  // disk lasts. A coin with its worm's first sight needs neither: its picture and metadata are a function of the chain,
  // served from here (coinMetadata), so launching works as soon as there's a config and an address to serve them from.
  const canHost = () => !!(opts.pinataJwt && opts.uploadPinata) || !!(opts.localMeta && root && opts.publicUrl);
  const canTrade = () => !!current();
  const canLaunch = () => canTrade() && (canHost() || !!opts.publicUrl);
  const ownMeta = (mint) => `${opts.publicUrl}/spawn/m/${mint}.json`, wormPicture = (symbol) => `${opts.publicUrl}/spawn/hatch/${symbol}.png`;

  /* ---------- reading the chain ---------- */

  const onHost = (u) => typeof u === 'string' && (IMAGE_HOSTS.some((h) => u.startsWith(h) && /^[A-Za-z0-9]+$/.test(u.slice(h.length))) || (!!opts.publicUrl && u.startsWith(opts.publicUrl + '/spawn/meta/')));
  const allowedImage = (u) => onHost(u) || (!!opts.publicUrl && typeof u === 'string' && /^\/spawn\/hatch\/[A-Z0-9]{1,10}\.png$/.test(u.slice(opts.publicUrl.length)) && u.startsWith(opts.publicUrl));
  // coins spawned on the page were checked then; ones made on the curve some other way are checked here, or not shown
  function shown(mint, p) {
    const own = s.coins[mint];
    if (own) return { name: own.name, symbol: own.symbol, image: allowedImage(own.image) ? own.image : '' };
    const n = moderate(p.name || ''), y = moderate(p.symbol || '');
    if (!(n.ok && y.ok && /^[A-Za-z0-9]{1,10}$/.test(y.text))) return null;
    const symbol = y.text.toUpperCase(), image = opts.publicUrl && p.uri === ownMeta(mint) ? wormPicture(symbol) : allowedImage(s.images[mint]) ? s.images[mint] : '';
    return { name: n.text, symbol, image };
  }

  /**
   * SPAWN's own configs from the chain: DBC configs whose fees go to the owner, made with SPAWN's parameters and priced
   * in SOL or $BRAINWORM. Needed when LOG_DIR did not survive a restart. Never trusted over what the state records.
   * When the site doesn't know $BRAINWORM's mint (no TOKEN_MINT, and the launch record went with the disk), it is the
   * one mint besides SOL they are priced in (SPAWN makes configs in nothing else), counting only configs the owner's
   * wallet paid for: a config names its fee claimer without their signature, so anyone can make one naming the owner.
   */
  async function findConfigs() {
    if (!opts.owner || !dbc.findConfigs || (foundAt && Date.now() - foundAt < SCAN_MS)) return false;
    foundAt = Date.now();   // a failed search waits its turn too: it is the call RPC nodes ration
    const found = (await dbc.findConfigs({ feeClaimer: opts.owner, ...chain })).filter((c) => dbc.isSpawnConfig(c, { creatorShare: FEE.creatorShare * 100, feeBps: FEE.bps }));
    if (!rootMint()) {
      const mints = new Set();
      for (const c of found) if (c.quoteMint !== SOL_MINT && await paidByOwner(c.address).catch((e) => logger.warn(`[spawn] who made ${c.address}: ${e.message}`))) mints.add(c.quoteMint);
      foundRoot = mints.size === 1 ? [...mints][0] : '';
    }
    let added = false;
    for (const c of found) {
      if (s.configs.some((x) => x.address === c.address)) continue;
      if (c.quoteMint !== SOL_MINT && c.quoteMint !== brainworm()) continue;
      s.configs.push({ address: c.address, partner: c.feeClaimer, quoteMint: c.quoteMint, graduationQuote: Number(c.migrationQuoteThreshold) / 10 ** decimalsOf(c), creatorShare: c.creatorShare, found: true });
      added = true;
    }
    if (added) logger.log?.(`[spawn] found ${s.configs.filter((c) => c.found).length} config(s) on chain for ${opts.owner}`);
    return added;
  }
  // Did the owner's wallet pay for this config? The transaction that made it is the oldest to mention it (its address
  // was a fresh key). The answer is kept; a config too busy to reach its first transaction (20,000 on) counts as not.
  const payers = new Map();   // config -> who paid for the transaction that made it
  async function paidByOwner(address) {
    if (!payers.has(address)) {
      let before, oldest = null;
      for (let k = 0; ; k++) {
        const page = await rpcRetry('getSignaturesForAddress', [address, { limit: 1000, ...(before ? { before } : {}), commitment: 'confirmed' }]);
        if (page.length) oldest = page.at(-1).signature;
        if (page.length < 1000) break;
        if (k === 19) { payers.set(address, ''); return false; }
        before = oldest;
      }
      const tx = oldest && await rpcRetry('getTransaction', [oldest, { encoding: 'json', maxSupportedTransactionVersion: 1, commitment: 'confirmed' }]);
      if (!tx) return false;   // not visible yet: asked again next time
      payers.set(address, tx.transaction.message.accountKeys[0]);
    }
    return payers.get(address) === opts.owner;
  }

  // $BRAINWORM's price from its pump.fun bonding curve, for the minutes after its launch when Jupiter has none yet: SOL
  // per whole token, from the curve's virtual reserves (tokens at byte 8, lamports at 16). 0 once it has graduated to
  // PumpSwap (byte 48; Jupiter prices it by then), for a curve priced in another token (newer ones name it at byte 83,
  // all zeros for SOL), or when the curve can't be read. Read at most every 20 s.
  let pumpCurve = { mint: '', at: 0, sol: 0 };
  async function curvePrice(mint) {
    if (pumpCurve.mint === mint && Date.now() - pumpCurve.at < REFRESH_MS) return pumpCurve.sol;
    let sol = 0;
    try {
      const a = (await rpc('getAccountInfo', [findProgramAddress(['bonding-curve', mint], PUMP_PROGRAM)[0], { encoding: 'base64', commitment: 'confirmed' }], chain))?.value;
      const d = a?.owner === PUMP_PROGRAM ? Buffer.from(a.data[0], 'base64') : null, tokens = d?.length > 48 ? d.readBigUInt64LE(8) : 0n;
      if (tokens && !d[48] && !d.subarray(83, 115).some((b) => b)) sol = Number(d.readBigUInt64LE(16)) / 1e9 / (Number(tokens) / 10 ** ROOT_DECIMALS);
    } catch (e) { logger.warn(`[spawn] $BRAINWORM's curve: ${e.message}`); }
    pumpCurve = { mint, at: Date.now(), sol };
    return sol;
  }
  /** SOL's and $BRAINWORM's prices from Jupiter's, with $BRAINWORM's from its curve while Jupiter has none. */
  async function withRoot(prices) {
    const r = brainworm(), solUsd = prices[SOL_MINT]?.usdPrice || 0;
    let rootUsd = (r && prices[r]?.usdPrice) || 0, rootSol = solUsd ? rootUsd / solUsd : 0;
    if (r && !rootSol) { rootSol = await curvePrice(r); rootUsd ||= rootSol * solUsd; }
    return { solUsd, rootUsd, rootSol };
  }

  async function refresh() {
    let found = false;
    try { found = await findConfigs(); } catch (e) { logger.warn(`[spawn] finding configs: ${e.message}`); }
    if (!s.configs.length) return;
    const cfgs = new Map();
    for (const c of s.configs) {
      const d = await dbc.fetchConfig({ address: c.address, ...chain });
      if (!d) continue;
      cfgs.set(c.address, d);
      if (!c.quoteMint && d.quoteMint) c.quoteMint = d.quoteMint;
    }
    // every pool on SPAWN's configs every few minutes (getProgramAccounts is the call RPC nodes ration), the known ones in between
    let list;
    if (!scannedAt || found || Date.now() - scannedAt > SCAN_MS) {
      list = [];
      for (const address of cfgs.keys()) list.push(...await dbc.listPools({ config: address, ...chain }));
      scannedAt = Date.now();
    } else list = (await dbc.fetchPools({ addresses: [...cache.pools.values()].map((p) => p.address), ...chain })).filter(Boolean);
    const pools = new Map();
    for (const p of list) if (cfgs.has(p.config)) { const c = cfgs.get(p.config); pools.set(p.baseMint, { ...p, cfg: c, ...dbc.poolPrice(p, c, decimalsOf(c)) }); }
    if (found) {
      // configs found on chain go in the order they were first used (a config with no coins yet is the newest)
      const first = new Map();
      for (const p of pools.values()) first.set(p.config, Math.min(first.get(p.config) ?? Infinity, p.activationPoint));
      const born = (c) => Math.min(first.get(c.address) ?? Infinity, c.createdAt ? c.createdAt / 1000 : Infinity);
      s.configs.sort((a, b) => (born(a) === born(b) ? 0 : born(a) < born(b) ? -1 : 1));
    }
    let prices = {};
    const graduated = [...pools.values()].filter((p) => p.stage === 'graduated').map((p) => p.baseMint);
    try { prices = await jupPrices([SOL_MINT, ...(brainworm() ? [brainworm()] : []), ...graduated.slice(0, 45)]); } catch (e) { logger.warn(`[spawn] prices: ${e.message}`); }
    const { solUsd, rootUsd, rootSol } = await withRoot(prices);
    const coins = [], byPool = new Map(), stuck = [];
    let waiting = 0n, waitingSol = 0n;
    for (const [mint, p] of pools) {
      byPool.set(p.address, mint);
      if (inSol(p.cfg)) waitingSol += p.partnerQuoteFee; else waiting += p.partnerQuoteFee;
      const show = shown(mint, p);
      if (p.stage === 'graduating' && p.finishedAt && Date.now() - p.finishedAt * 1000 > STUCK_MS) stuck.push({ mint, symbol: show?.symbol || '', pool: p.address, since: p.finishedAt * 1000 });
      if (!show) continue;
      const priceSol = p.stage === 'graduated' && prices[mint]?.usdPrice && solUsd ? prices[mint].usdPrice / solUsd : inSol(p.cfg) ? p.price : p.price * rootSol;
      coins.push({
        mint, pool: p.address, ...show, creator: p.creator, createdAt: (s.coins[mint]?.createdAt) || p.activationPoint * 1000,
        quote: quoteName(p.cfg), priceQuote: p.price, priceSol, priceUsd: priceSol * solUsd, mcapSol: priceSol * 1e9, progress: p.progress, graduated: p.graduated, stage: p.stage,
        creatorFees: Number(p.creatorQuoteFee) / 10 ** decimalsOf(p.cfg),
      });
    }
    // coins spawned on the page that never made it on chain are forgotten after an hour
    for (const [mint, c] of Object.entries(s.coins)) if (!pools.has(mint) && Date.now() - c.createdAt > STALE_COIN_MS) delete s.coins[mint];
    cache = { at: Date.now(), coins, pools, byPool, prices: { solUsd, rootUsd, rootSol }, waiting: Number(waiting) / 10 ** ROOT_DECIMALS, waitingSol: Number(waitingSol) / 1e9, stuck };
    // every coin shown hatches its own worm (a few each refresh, so a first listing of many coins doesn't stall the server)
    if (coinWorms) { let n = 0; for (const c of coins) if (!coinWorms.has(c.mint) && n++ < 10) coinWorms.hatch(c.mint, c.symbol); }
    save();
    startStream();
    if (!catching && (!caughtUpAt || coins.some((c) => !charted.has(c.mint)))) catching = catchUp().catch((e) => logger.warn(`[spawn] catch-up: ${e.message}`)).finally(() => { catching = null; });
    findPictures([...pools.values()]).catch(() => {});
    if (!burnsScanned && opts.owner && brainworm() && !s.burns.length) findBurns().catch((e) => logger.warn(`[spawn] burns: ${e.message}`));
  }
  let refreshing = null;
  function kick() {
    if (!refreshing) refreshing = refresh().catch((e) => logger.warn(`[spawn] refresh: ${e.message}`)).finally(() => { refreshing = null; });
    return refreshing;
  }
  /** Refresh in the background when the listing is old (the first read waits). force: wait for a fresh one; scan: look for new pools too. */
  async function fresh(force = false, scan = false) {
    if (scan) scannedAt = 0;
    if (force || scan) { if (refreshing) await refreshing; return kick(); }
    if (Date.now() - cache.at > REFRESH_MS) { const r = kick(); if (!cache.at) await r; }
  }

  // Pictures of coins this server did not see spawned (made elsewhere, or before LOG_DIR was lost): from their
  // metadata, when it is on IPFS or here, and only pictures from the same hosts. A few each refresh, three tries each.
  const pictureTries = new Map();
  async function findPictures(pools) {
    let n = 0;
    for (const p of pools) {
      if (n >= 3) break;
      if (s.coins[p.baseMint] || p.baseMint in s.images || !onHost(p.uri) || (pictureTries.get(p.baseMint) || 0) >= 3) continue;
      n++;
      pictureTries.set(p.baseMint, (pictureTries.get(p.baseMint) || 0) + 1);
      try {
        const r = await fetchImpl(p.uri, { signal: AbortSignal.timeout(8000) });
        const j = r.ok ? await r.json() : null;
        if (j) { s.images[p.baseMint] = allowedImage(j.image) ? j.image : ''; save(); }
      } catch { /* try again next time */ }
    }
  }

  function rollDay() { const k = dayKey(); if (s.day.key !== k) { s.day = { key: k, worm: {} }; save(); } }
  function publicState() {
    rollDay();
    const sym = (mint) => cache.coins.find((c) => c.mint === mint)?.symbol;
    const movers = Object.entries(s.day.worm).filter(([mint]) => sym(mint)).map(([mint, w]) => ({ mint, symbol: sym(mint), ...w }))
      .sort((a, b) => b.cells - a.cells || b.pokes - a.pokes).slice(0, 10);
    const cur = current();
    return {
      open: canLaunch(),
      reason: !cur ? 'Opening soon.' : !canLaunch() ? 'Opening soon: coin pictures are being set up.' : null,
      quote: cur ? quoteName(cur) : null,      // what new coins are priced in
      pictures: canHost(),                     // a picked picture can be kept for good (else every coin gets its worm's)
      root: {
        mint: brainworm() || null, priceSol: cache.prices.rootSol || 0, priceUsd: cache.prices.rootUsd || 0, solUsd: cache.prices.solUsd || 0,
        burned: round(s.burns.reduce((n, b) => n + b.amount, 0), 2), waiting: round(cache.waiting, 2), waitingSol: round(cache.waitingSol, 4),
        burns: s.burns.slice(-5).reverse().map((b) => ({ signature: b.signature, amount: round(b.amount, 2), at: b.at })),
      },
      fee: FEE,
      coins: cache.coins.map((c) => ({ ...c, worm: s.day.worm[c.mint] || { pokes: 0, cells: 0 }, own: coinWorms?.info(c.mint) || null })),
      movers,
      pokesToday: Object.values(s.day.worm).reduce((n, w) => n + w.pokes, 0),
      config: cur?.address || null,
      graduationQuote: cur?.graduationQuote || null,
    };
  }

  /* ---------- trading ---------- */

  async function jup(pathname, init = {}) {
    const headers = { ...(init.headers || {}), ...(opts.jupiterKey ? { 'x-api-key': opts.jupiterKey } : {}) };
    const r = await fetchImpl(jupBase + pathname, { ...init, headers, signal: AbortSignal.timeout(15_000) });
    const j = await r.json().catch(() => null);
    if (!r.ok || !j || j.error) {
      const e = new Error(`Jupiter: ${(j && (j.error || j.message)) || r.status}`);
      e.noRoute = /route/i.test(`${j?.error || ''} ${j?.errorCode || ''} ${j?.message || ''}`);
      throw e;
    }
    return j;
  }
  const jupPrices = (ids) => jup(`/price/v3?ids=${[...new Set(ids)].join(',')}`);
  const jupQuote = (inputMint, outputMint, amount) => jup(`/swap/v1/quote?${new URLSearchParams({
    inputMint, outputMint, amount: String(amount), slippageBps: String(SLIPPAGE_BPS), ...(opts.jupiterKey ? { restrictIntermediateTokens: 'false' } : {}),
  })}`);
  const jupLeg = (res) => ({ kind: 'jup', res, out: BigInt(res.outAmount), min: BigInt(res.otherAmountThreshold) });
  const jupSwap = (quoteResponse, user, wrapAndUnwrapSol = true) => jup('/swap/v1/swap', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ quoteResponse, userPublicKey: user, wrapAndUnwrapSol, dynamicComputeUnitLimit: true, prioritizationFeeLamports: { priorityLevelWithMaxLamports: { maxLamports: 1_000_000, priorityLevel: 'high' } } }),
  });

  // the coin's quote token ↔ coin: on the coin's own curve while it has one (no aggregator needed), through Jupiter once it graduated
  async function coinLeg(p, buy, amountIn) {
    if (p.stage === 'curve') {
      const state = { sqrtPrice: p.sqrtPrice, curve: p.cfg.curve, sqrtStartPrice: p.cfg.sqrtStartPrice, migrationSqrtPrice: p.cfg.migrationSqrtPrice, feeNumerator: p.cfg.feeNumerator };
      const { out } = buy ? dbc.quoteBuy(state, amountIn) : dbc.quoteSell(state, amountIn);
      return { kind: 'curve', pool: p.address, side: buy ? 'buy' : 'sell', amountIn, out, min: (out * BigInt(10_000 - SLIPPAGE_BPS)) / 10_000n };
    }
    return jupLeg(await jupQuote(buy ? p.cfg.quoteMint : p.baseMint, buy ? p.baseMint : p.cfg.quoteMint, amountIn));
  }

  /**
   * A quote: buying (amount in SOL, or in $BRAINWORM with pay 'root') or selling (amount in coins, for SOL or, with
   * pay 'root', for $BRAINWORM). A coin priced in SOL is one step on its own curve. A coin priced in $BRAINWORM is one
   * step, or two when Jupiter has no route through $BRAINWORM yet.
   */
  async function quote({ mint, side, amount, pay }) {
    if (!canTrade()) throw new Error('The launchpad is not open yet.');
    await fresh();
    const p = cache.pools.get(mint || ''), coin = p && cache.coins.find((c) => c.mint === mint);
    if (!B58.test(mint || '') || !coin) throw new Error('Not a SPAWN coin.');
    if (p.stage === 'graduating') throw new Error(`$${coin.symbol} is graduating to its Meteora pool. Trading opens again in a few minutes.`);
    const n = Number(amount), buy = side !== 'sell', sol = inSol(p.cfg), viaRoot = !sol && pay === 'root';
    if (!(n > 0) || !Number.isFinite(n)) throw new Error('Enter an amount.');
    if (buy && !viaRoot && n > 1000) throw new Error('That is more than this page will route.');
    const input = atoms(n, buy && !viaRoot ? 9 : 6);
    let legs;
    try {
      if (sol || viaRoot) legs = [await coinLeg(p, buy, input)];
      else {
        let direct = null;
        try { direct = await jupQuote(buy ? SOL_MINT : mint, buy ? mint : SOL_MINT, input); } catch (e) { if (!e.noRoute) throw e; }
        if (direct) legs = [jupLeg(direct)];
        else if (buy) { const a = jupLeg(await jupQuote(SOL_MINT, brainworm(), input)); legs = [a, await coinLeg(p, true, a.min)]; }
        else { const b = await coinLeg(p, false, input); legs = [b, jupLeg(await jupQuote(brainworm(), SOL_MINT, b.min))]; }
      }
    } catch (e) {
      if (/bigger than/.test(e.message)) throw new Error(`That is more than $${coin.symbol}'s curve has left.`);
      throw e.noRoute ? new Error(sol ? 'No route for that yet. Try again in a minute.' : 'No route for that yet. Try paying with $BRAINWORM, or again in a minute.') : e;
    }
    const name = (m) => (m === SOL_MINT ? 'SOL' : m === brainworm() ? '$BRAINWORM' : m === mint ? '$' + coin.symbol : m.slice(0, 4) + '…');
    const route = [buy ? (viaRoot ? '$BRAINWORM' : 'SOL') : '$' + coin.symbol];
    for (const l of legs) {
      if (l.kind === 'curve') route.push(l.side === 'buy' ? '$' + coin.symbol : quoteName(p.cfg));
      else for (const r of l.res.routePlan || []) if (r.swapInfo?.outputMint) route.push(name(r.swapInfo.outputMint));
    }
    const quoteId = crypto.randomBytes(9).toString('base64url');
    quotes.set(quoteId, { legs, at: Date.now(), user: null, next: 0 });
    for (const [k, v] of quotes) if (Date.now() - v.at > QUOTE_TTL_MS) quotes.delete(k);
    const last = legs.at(-1), outDec = buy || viaRoot ? 6 : 9;
    return {
      quoteId, steps: legs.length, route: route.filter((x, i) => x !== route[i - 1]),
      out: { symbol: buy ? '$' + coin.symbol : viaRoot ? '$BRAINWORM' : 'SOL', amount: Number(last.out) / 10 ** outDec, min: Number(last.min) / 10 ** outDec },
      priceImpactPct: legs.reduce((x, l) => x + (l.kind === 'jup' ? Number(l.res.priceImpactPct) || 0 : 0), 0),
    };
  }

  /** The transaction for one step of a quote this server made, for the visitor's wallet to sign and send. Steps go in order. */
  async function swap({ quoteId, user, step = 0 }) {
    const q = quotes.get(quoteId);
    if (!q || Date.now() - q.at > QUOTE_TTL_MS) throw new Error('That quote expired. Enter the amount again.');
    if (!B58.test(user || '')) throw new Error('Connect a wallet first.');
    if (q.user && q.user !== user) throw new Error('That quote is for another wallet.');
    const k = Number(step) || 0, leg = q.legs[k];
    if (!leg || k !== q.next) throw new Error('Those steps are out of order. Enter the amount again.');
    let tx;
    if (leg.kind === 'jup') {
      const j = await jupSwap(leg.res, user);
      if (!j.swapTransaction) throw new Error('Jupiter did not return a transaction.');
      tx = j.swapTransaction;
    } else {
      const [p] = await dbc.fetchPools({ addresses: [leg.pool], ...chain });
      if (!p) throw new Error('That coin\'s pool is not there.');
      tx = (await dbc.buildSwap({ pool: p, side: leg.side, trader: user, amountIn: leg.amountIn, minOut: leg.min, ...chain })).tx;
    }
    q.user = user; q.next = k + 1;
    if (q.next >= q.legs.length) quotes.delete(quoteId);
    return { tx, step: k, steps: q.legs.length };
  }

  /** Has a transaction landed? (the page waits for step one before building step two) */
  async function confirm({ signature }) {
    if (!SIG.test(signature || '')) throw new Error('Bad signature.');
    const st = (await rpc('getSignatureStatuses', [[signature]], chain))?.value?.[0];
    return { confirmed: !!st && !st.err && ['confirmed', 'finalized'].includes(st.confirmationStatus), failed: !!st?.err };
  }

  /* ---------- spawning a coin ---------- */

  const describe = (symbol, cfg) => `$${symbol} was spawned on SPAWN, the BRAINWORM launchpad${inSol(cfg) ? '' : ', priced in $BRAINWORM'}. It hatched its own copy of a simulated worm larva's nervous system, which feels every trade of it, and every buy pokes the live worm.${opts.publicUrl ? ` ${opts.publicUrl}/spawn` : ''}`;
  async function uploadMeta({ image, type, name, symbol, cfg }) {
    const site = opts.publicUrl ? `${opts.publicUrl}/spawn` : '';
    const description = describe(symbol, cfg);
    if (opts.pinataJwt && opts.uploadPinata) {
      const r = await opts.uploadPinata({ image, filename: `${symbol}.${IMAGE_TYPES[type]}`, name, symbol, description, website: site, createdOn: site, jwt: opts.pinataJwt, fetchImpl });
      return { uri: r.metadataUri, image: r.metadata?.image || '' };
    }
    if (!opts.localMeta || !root || !opts.publicUrl) throw new Error('Picture hosting is not set up yet (PINATA_JWT).');
    const id = crypto.createHash('sha256').update(image).digest('hex').slice(0, 24);
    fs.writeFileSync(path.join(root, 'meta', `${id}.${IMAGE_TYPES[type]}`), image);
    const imageUrl = `${opts.publicUrl}/spawn/meta/${id}.${IMAGE_TYPES[type]}`;
    fs.writeFileSync(path.join(root, 'meta', `${id}.json`), JSON.stringify({ name, symbol, description, image: imageUrl, website: site }));
    return { uri: `${opts.publicUrl}/spawn/meta/${id}.json`, image: imageUrl };
  }

  /** The create transaction for the creator's wallet (the coin's fresh mint key already signed in it). */
  async function create({ creator, name, symbol, image, firstBuy }) {
    if (!canLaunch()) throw new Error('The launchpad is not open yet.');
    if (!B58.test(creator || '')) throw new Error('Connect a wallet first.');
    const cfg = current();
    const nm = moderate(String(name || '').trim()), sy = moderate(String(symbol || '').trim().toUpperCase());
    if (!nm.ok) throw new Error(nm.message || 'That name is not allowed.');
    if (!sy.ok) throw new Error(sy.message || 'That ticker is not allowed.');
    if (!nm.text || Buffer.byteLength(nm.text) > 32) throw new Error('Names are 1 to 32 characters.');
    if (!/^[A-Z0-9]{1,10}$/.test(sy.text)) throw new Error('Tickers are 1 to 10 letters or digits.');
    if (sy.text === 'BRAINWORM') throw new Error('That ticker is taken.');
    const buy = Number(firstBuy || 0);
    if (!(buy >= 0) || !Number.isFinite(buy)) throw new Error(`The first buy is a number of ${quoteName(cfg)}.`);
    let m, bytes;
    if (image !== 'worm' && !canHost()) throw new Error('Picked pictures open soon. For now every coin gets its worm\'s first sight.');
    const fromChain = image === 'worm' && !canHost();   // its picture and metadata served from here, nothing uploaded
    if (image === 'worm') {
      // the picture its worm will see first: a fresh worm shown the ticker, drawn from the real wiring
      if (!fromChain && (!render || !D)) throw new Error('Pictures from the worm are not available here.');
      if (!fromChain) bytes = previewHatch({ D, render, ticker: sy.text, width: 512 }).png;
      m = [null, 'image/png'];
    } else {
      m = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/=]+)$/.exec(String(image || ''));
      if (!m) throw new Error('Add a PNG, JPG, WEBP or GIF picture, or use its worm\'s first sight.');
      bytes = Buffer.from(m[2], 'base64');
      if (bytes.length > MAX_IMAGE) throw new Error('That picture is too big (1.5 MB at most).');
      if (!MAGIC[m[1]](bytes)) throw new Error('That file is not the picture it says it is.');
    }
    // before anything is uploaded: can this wallet pay for its coin? (its accounts' rent, and a first buy in SOL)
    const lamports = await rpc('getBalance', [creator, { commitment: 'confirmed' }], chain).then((r) => r.value, () => null);
    const need = LAUNCH_RENT_SOL + (inSol(cfg) ? buy : 0);
    if (lamports != null && lamports / 1e9 < need) throw new Error(`Launching needs about ${round(need, 4)} SOL in that wallet (${inSol(cfg) && buy ? `${buy} for the first buy, and about ${LAUNCH_RENT_SOL} for the coin's accounts` : `about ${LAUNCH_RENT_SOL} for the coin's accounts`}). It has ${round(lamports / 1e9, 4)}.`);
    // its worm's first sight needs no upload where nothing lasts: its metadata is served from here, from the chain
    const meta = fromChain ? { uri: ownMeta, image: wormPicture(sy.text) } : await uploadMeta({ image: bytes, type: m[1], name: nm.text, symbol: sy.text, cfg });
    let built;
    try { built = await dbc.buildCreatePool({ config: cfg.address, creator, name: nm.text, symbol: sy.text, uri: meta.uri, firstBuyQuote: buy, ...chain }); } catch (e) { throw human(e); }
    s.coins[built.mint] = { name: nm.text, symbol: sy.text, image: meta.image, uri: typeof meta.uri === 'function' ? meta.uri(built.mint) : meta.uri, creator, createdAt: Date.now() };
    save();
    return { tx: built.tx, mint: built.mint, firstBuy: built.firstBuy, quote: quoteName(cfg) };
  }
  function created({ mint, signature }) {
    const c = s.coins[mint];
    if (!c || !SIG.test(signature || '')) return false;
    c.signature = signature; save();
    fresh(true, true).catch(() => {});
    return true;
  }

  /**
   * A creator's own fees on one coin, to their wallet: what its curve owes them, and once it has graduated, their
   * position's share of its pool's fees. One transaction for each; the page signs them in turn. Fees in SOL arrive as SOL.
   */
  async function claimCreator({ mint, creator }) {
    await fresh();
    const p = cache.pools.get(mint || '');
    if (!p) throw new Error('Not a SPAWN coin.');
    if (p.creator !== creator) throw new Error('Only the wallet that spawned this coin can claim its fees.');
    const txs = [];
    if (p.creatorQuoteFee > 0n) txs.push((await dbc.buildClaimCreator({ pool: p, creator, ...chain })).tx);
    if (p.stage === 'graduated') for (const t of await dbc.buildClaimGraduated({ coins: [coinOf(p)], owner: creator, unwrap: true, ...chain })) txs.push(t.tx);
    if (!txs.length) throw new Error('Nothing to claim yet.');
    return { txs, amount: Number(p.creatorQuoteFee) / 10 ** decimalsOf(p.cfg), quote: quoteName(p.cfg) };
  }
  const coinOf = (p) => ({ baseMint: p.baseMint, quoteMint: p.cfg.quoteMint, migrationFeeOption: p.cfg.migrationFeeOption });

  /* ---------- the owner: configs, claim and burn, and buying back with fees in SOL ---------- */

  /** SOL's and $BRAINWORM's prices now, for choosing a config's market caps (a new $BRAINWORM's from its curve). */
  async function rootPrice() {
    const r = brainworm(), p = await jupPrices([SOL_MINT, ...(r ? [r] : [])]).catch(() => ({}));
    return { ...await withRoot(p), root: r || null };
  }
  function checkPartner(wallet, what = 'owner') {
    if (!B58.test(wallet || '')) throw new Error(`Connect the ${what} wallet first.`);
    const p = partner();
    if (p && wallet !== p) throw new Error(`Use the ${what} wallet (${p}): it made SPAWN's configs and claims their fees.`);
  }
  /**
   * A new config for the owner's wallet, priced in SOL (quote 'sol') or in $BRAINWORM (quote 'root', once it exists;
   * market caps then in $BRAINWORM at today's price). New coins use the newest config, $BRAINWORM's first; coins
   * already made keep theirs.
   */
  async function buildConfig({ partner: wallet, startMcap, graduationMcap, quote: q = brainworm() ? 'root' : 'sol' }) {
    const inRoot = q === 'root';
    if (inRoot && !brainworm()) throw new Error('$BRAINWORM has to exist first: a config priced in it needs its mint.');
    checkPartner(wallet);
    const quoteMint = inRoot ? brainworm() : SOL_MINT;
    const built = await dbc.buildCreateConfig({ partner: wallet, quoteMint, startMcap: Number(startMcap), graduationMcap: Number(graduationMcap), creatorShare: FEE.creatorShare * 100, ...chain });
    pendingConfig = { address: built.address, partner: wallet, quoteMint, curve: built.curve, at: Date.now() };
    return { ...built, quote: inRoot ? '$BRAINWORM' : 'SOL' };
  }
  async function confirmConfig({ signature }) {
    if (!pendingConfig) throw new Error('No config was prepared.');
    if (!SIG.test(signature || '')) throw new Error('Bad signature.');
    const c = await dbc.fetchConfig({ address: pendingConfig.address, ...chain });
    if (!c) return { ok: false, error: 'Not on chain yet.' };
    if (c.quoteMint !== pendingConfig.quoteMint || c.feeClaimer !== pendingConfig.partner || c.collectFeeMode !== 0 || c.creatorShare !== FEE.creatorShare * 100) throw new Error('That config is not the one SPAWN built.');
    s.configs.push({ address: pendingConfig.address, partner: pendingConfig.partner, quoteMint: pendingConfig.quoteMint, signature, createdAt: Date.now(), ...pendingConfig.curve });
    pendingConfig = null;
    save();
    await fresh(true, true);
    return { ok: true, config: current() };
  }
  /**
   * Claim-and-burn transactions for every coin priced in $BRAINWORM with fees waiting, for the owner's wallet (three
   * pools each). Each claim is capped at the fees read now and the burn is their exact sum, so a second claim of the
   * same fees before the first lands would come up short and burn the owner's own $BRAINWORM: new ones wait until the
   * last ones have landed or expired.
   */
  async function buildClaimAndBurn({ feeClaimer, min = 1 }) {
    if (!current()) throw new Error('The launchpad is not set up.');
    checkPartner(feeClaimer, 'fee claimer');
    if (Date.now() < claimLockUntil) throw new Error('The last claim and burn may still land. Try again in a minute.');
    await fresh(true, true);
    const out = [];
    for (const cfg of s.configs) {
      if (inSol(cfg)) continue;
      const pools = [...cache.pools.values()].filter((p) => p.config === cfg.address && Number(p.partnerQuoteFee) / 10 ** ROOT_DECIMALS >= min);
      out.push(...await dbc.buildClaimAndBurn({ pools, feeClaimer, ...chain }));
    }
    if (out.length) claimLockUntil = Date.now() + CLAIM_LOCK_MS;
    return out;
  }
  /**
   * After graduation a coin trades in its DAMM v2 pool, whose fees (in the quote token only, on SPAWN's option) go to
   * its two locked positions: the creator's and the fee claimer's. These claim the fee claimer's share of every
   * graduated coin priced in $BRAINWORM; what each claim paid is known once it has landed, and burnClaimed builds the
   * burn for exactly that.
   */
  async function buildClaimGraduated({ feeClaimer }) {
    if (!current()) throw new Error('The launchpad is not set up.');
    checkPartner(feeClaimer, 'fee claimer');
    await fresh(true, true);
    const coins = [...cache.pools.values()].filter((p) => p.stage === 'graduated' && !inSol(p.cfg)).map(coinOf);
    return coins.length ? dbc.buildClaimGraduated({ coins, owner: feeClaimer, ...chain }) : [];
  }
  /**
   * Fees in SOL: the fee claimer's share of every coin priced in SOL, on its curve and in its graduated pool, claimed
   * into their wrapped-SOL account, where buyback() finds it. Only once $BRAINWORM exists: until then it waits in the pools.
   */
  async function buildClaimSol({ feeClaimer, min = 0.001 }) {
    if (!brainworm()) throw new Error('Fees in SOL wait in their pools until $BRAINWORM launches: then they buy it and it is burned.');
    checkPartner(feeClaimer, 'fee claimer');
    if (Date.now() < solLockUntil) throw new Error('The last claim may still land. Try again in a minute.');
    await fresh(true, true);
    const out = [];
    for (const cfg of s.configs) {
      if (!inSol(cfg)) continue;
      const pools = [...cache.pools.values()].filter((p) => p.config === cfg.address && Number(p.partnerQuoteFee) / 1e9 >= min);
      out.push(...await dbc.buildClaimAndBurn({ pools, feeClaimer, burn: false, ...chain }));
    }
    const graduated = [...cache.pools.values()].filter((p) => p.stage === 'graduated' && inSol(p.cfg)).map(coinOf);
    if (graduated.length) out.push(...await dbc.buildClaimGraduated({ coins: graduated, owner: feeClaimer, ...chain }));
    if (out.length) solLockUntil = Date.now() + CLAIM_LOCK_MS;
    return out;
  }
  /**
   * The buyback: every bit of SOL in the fee claimer's wrapped-SOL account (where claimed fees land) swapped for
   * $BRAINWORM through Jupiter, for their wallet to sign. Once it has landed, burnClaimed({ signature, buyback: true })
   * builds the burn of exactly the $BRAINWORM it bought.
   */
  async function buyback({ feeClaimer }) {
    if (!brainworm()) throw new Error('$BRAINWORM has not launched yet.');
    checkPartner(feeClaimer, 'fee claimer');
    // the account itself (its amount is at byte 64): every RPC serves this, unlike getTokenAccountBalance
    const info = await rpc('getAccountInfo', [dbc.ata(feeClaimer, SOL_MINT), { encoding: 'base64', commitment: 'confirmed' }], chain);
    const lamports = info?.value ? Buffer.from(info.value.data[0], 'base64').readBigUInt64LE(64) : 0n;
    if (lamports < 1_000_000n) throw new Error('No claimed fees in SOL to buy with yet (0.001 SOL at least).');
    const q = await jupQuote(SOL_MINT, brainworm(), lamports);
    const j = await jupSwap(q, feeClaimer, false);   // spends the wrapped SOL itself, not the wallet's own
    if (!j.swapTransaction) throw new Error('Jupiter did not return a transaction.');
    return { tx: j.swapTransaction, sol: Number(lamports) / 1e9, root: Number(q.outAmount) / 10 ** ROOT_DECIMALS, min: Number(q.otherAmountThreshold) / 10 ** ROOT_DECIMALS };
  }
  /** The burn of exactly what a landed claim (or, with buyback, a buyback) brought the fee claimer in $BRAINWORM. */
  async function burnClaimed({ signature, buyback: bought = false }) {
    if (!current()) throw new Error('The launchpad is not set up.');
    if (!SIG.test(signature || '')) throw new Error('Bad signature.');
    const owner = partner();
    return (await dbc.buildBurnReceived({ signature, owner, keep: [brainworm(), SOL_MINT], ...(bought ? { only: [brainworm()] } : {}), ...chain })) || { tx: null, burns: [] };
  }
  // how much $BRAINWORM SPAWN's fee claimer burned in a transaction (0 if none), read from the chain
  async function burnedIn(signature) {
    const tx = await rpc('getTransaction', [signature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 1, commitment: 'confirmed' }], chain);
    if (!tx) return null;
    if (tx.meta?.err) return 0;
    const claimers = new Set([...s.configs.map((c) => c.partner), ...(opts.owner ? [opts.owner] : [])]);
    let amount = 0;
    for (const ix of tx.transaction?.message?.instructions || []) {
      const x = ix.parsed;
      if (!x || !/^spl-token(-2022)?$/.test(ix.program) || !['burn', 'burnChecked'].includes(x.type) || x.info?.mint !== brainworm() || !claimers.has(x.info?.authority)) continue;
      amount += x.type === 'burnChecked' ? Number(x.info.tokenAmount.amount) / 10 ** x.info.tokenAmount.decimals : Number(x.info.amount) / 10 ** ROOT_DECIMALS;
    }
    return amount;
  }
  /** Record a claim and burn: read from the chain how much $BRAINWORM its fee claimer burned in it. */
  async function burned({ signature }) {
    if (!SIG.test(signature || '')) throw new Error('Bad signature.');
    if (s.burns.some((b) => b.signature === signature)) return { ok: true };
    const amount = await burnedIn(signature);
    if (amount === null) return { ok: false, error: 'Not confirmed yet.' };
    if (!(amount > 0)) return { ok: false, error: 'That transaction burned no $BRAINWORM from the fee claimer.' };
    s.burns.push({ signature, amount, at: Date.now() });
    save();
    return { ok: true, amount };
  }
  /** After LOG_DIR was lost: SPAWN's burns again, from the owner's latest transactions (a thousand at most). */
  let burnsScanned = false;
  async function findBurns() {
    burnsScanned = true;
    const got = [];
    let before;
    for (let seen = 0; seen < 1000;) {
      const page = await rpcRetry('getSignaturesForAddress', [opts.owner, { limit: 200, ...(before ? { before } : {}), commitment: 'confirmed' }]);
      for (const x of page) {
        if (x.err) continue;
        const amount = await burnedIn(x.signature).catch(() => 0);
        if (amount > 0) got.push({ signature: x.signature, amount, at: (x.blockTime || 0) * 1000 });
        await sleep(250);   // gentle on the RPC
      }
      seen += page.length;
      if (page.length < 200) break;
      before = page.at(-1).signature;
    }
    if (got.length && !s.burns.length) { s.burns = got.reverse(); save(); }
  }

  /* ---------- each coin's price chart ---------- */

  // Every trade of a coin: [time (ms), its price right after it in its quote token per whole coin, side, quote tokens,
  // signature], oldest first, CHART_POINTS at most, from its curve's first price when it was made. Kept in memory:
  // after a restart, catchUp() reads each coin's latest trades back from the chain.
  const charts = new Map();   // mint -> { points (each with its `${signature}:${n}` key after the signature), keys }
  const priceAt = (sqrtPrice, cfg) => (Number(sqrtPrice) / 2 ** 64) ** 2 * 10 ** ((cfg.tokenDecimal ?? 6) - decimalsOf(cfg));   // like dbc.poolPrice
  function chartOf(mint) {
    if (!charts.has(mint)) {
      const c = cache.coins.find((x) => x.mint === mint), cfg = cache.pools.get(mint)?.cfg;
      charts.set(mint, { points: c && cfg?.sqrtStartPrice ? [[c.createdAt, priceAt(cfg.sqrtStartPrice, cfg), 'start', 0, '']] : [], keys: new Set() });
    }
    return charts.get(mint);
  }
  /** A swap of a coin (from dbc.fetchTrades) at `at` ms; n counts the coin's swaps before it in the same transaction. */
  function chartTrade(mint, cfg, t, at, signature, n) {
    const h = chartOf(mint), key = `${signature}:${n}`;
    if (t.sqrtPrice == null || h.keys.has(key)) return;
    h.keys.add(key);
    let i = h.points.length;
    while (i && h.points[i - 1][0] > at) i--;
    h.points.splice(i, 0, [at, priceAt(t.sqrtPrice, cfg), t.side, Number(t.quote) / 10 ** decimalsOf(cfg), signature, key]);
    if (h.points.length > CHART_POINTS) for (const x of h.points.splice(0, h.points.length - CHART_POINTS)) h.keys.delete(x[5]);
  }
  /** A listed coin's chart, for /spawn/chart/<mint>.json (the page prices it in SOL or dollars with /spawn.json's root prices). */
  function chart(mint) {
    const c = cache.coins.find((x) => x.mint === mint), p = cache.pools.get(mint);
    return c && p ? { mint, symbol: c.symbol, quote: quoteName(p.cfg), supply: SUPPLY, points: chartOf(mint).points.map((x) => x.slice(0, 5)) } : null;
  }

  /* ---------- trades → the worm and the charts ---------- */

  let stream = null, streamKey = '', queue = [], working = false;
  function startStream() {
    const key = s.configs.map((c) => c.address).join(',');
    if (!key || !opts.ws || (stream && key === streamKey)) return;
    if (stream) stream.stop();   // a new config: listen to it too
    streamKey = key;
    stream = logsStream({ url: opts.ws, mentions: s.configs.map((c) => c.address), logger, WebSocketImpl: opts.WebSocketImpl, onSignature: (sig) => {
      queue.push({ sig, tries: 0, at: Date.now() });
      if (queue.length > 30) queue.splice(0, queue.length - 30);   // a burst: the worm can't take them all anyway
      work();
    } });
    stream.start();
  }
  async function work() {
    if (working) return;
    working = true;
    try {
      while (queue.length) {
        const job = queue.shift();
        let trades = null;
        try { trades = await dbc.fetchTrades({ signature: job.sig, configs: s.configs.map((c) => c.address), ...chain }); } catch (e) { logger.warn(`[spawn] trade: ${e.message}`); }
        if (trades === null && job.tries < 3) { job.tries++; setTimeout(() => { queue.push(job); work(); }, 2000 * job.tries); continue; }
        const n = new Map();   // swaps on the same coin within this transaction
        for (const t of trades || []) {
          let mint = cache.byPool.get(t.pool);
          if (!mint) { await fresh(true, true); mint = cache.byPool.get(t.pool); }
          const coin = cache.coins.find((c) => c.mint === mint), p = cache.pools.get(mint);
          if (!coin || !p) continue;
          const quote = Number(t.quote) / 10 ** decimalsOf(p.cfg), k = n.get(mint) || 0;
          n.set(mint, k + 1);
          chartTrade(mint, p.cfg, t, job.at, job.sig, k);
          if (coinWorms) {
            if (!coinWorms.has(mint)) coinWorms.hatch(mint, coin.symbol);
            coinWorms.feel(mint, [{ signature: job.sig, side: t.side, n: k }]);
          }
          onTrade({ mint, symbol: coin.symbol, side: t.side, signature: job.sig, trader: t.trader, quote, sol: inSol(p.cfg) ? quote : quote * (cache.prices.rootSol || 0) });
        }
        await sleep(400);   // gentle on the RPC
      }
    } finally { working = false; }
  }
  /**
   * After a restart (every deploy), each coin's worm feels the trades it missed while the site was down, from the
   * chain, oldest first. They don't poke the site's worm: that moment has passed. Every coin listed gets its chart
   * back the same way, its latest 1000 trades (at the start, and a coin listed later when it is).
   */
  let caughtUpAt = 0, catching = null;
  const charted = new Set();   // coins whose chart has been read back from the chain
  async function catchUp() {
    const worms = !caughtUpAt;   // the worms catch up once, when the site starts
    caughtUpAt ||= Date.now();
    const configs = s.configs.map((c) => c.address);
    for (const c of cache.coins) {
      const worm = worms && !!coinWorms?.has(c.mint), charting = !charted.has(c.mint), cfg = cache.pools.get(c.mint)?.cfg;
      if (!worm && !charting) continue;
      const last = worm ? coinWorms.lastSignature(c.mint) : null, sigs = [];
      let before;
      while (sigs.length < 1000) {
        const page = await rpcRetry('getSignaturesForAddress', [c.pool, { limit: 100, ...(before ? { before } : {}), ...(last && !charting ? { until: last } : {}), commitment: 'confirmed' }]);
        for (const x of page) if (!x.err) sigs.push(x);
        if (page.length < 100) break;
        before = page.at(-1).signature;
      }
      // the worm feels the ones after the last trade it felt (all of them if that isn't among these)
      const felt = sigs.findIndex((x) => x.signature === last), newer = !worm ? 0 : felt < 0 ? sigs.length : felt;
      for (let i = sigs.length - 1; i >= 0; i--) {   // oldest first
        const { signature: sig, blockTime } = sigs[i], trades = await dbc.fetchTrades({ signature: sig, configs, ...chain }).catch(() => null);
        let k = 0;
        for (const t of trades || []) {
          if (t.pool !== c.pool) continue;
          if (i < newer) coinWorms.feel(c.mint, [{ signature: sig, side: t.side, n: k }]);
          if (charting && cfg) chartTrade(c.mint, cfg, t, blockTime ? blockTime * 1000 : Date.now(), sig, k);
          k++;
        }
        await sleep(250);   // gentle on the RPC
      }
      if (!charting) continue;
      charted.add(c.mint);
      // more trades than were read back: its chart no longer reaches its first price
      if (sigs.length >= 1000) { const h = chartOf(c.mint); h.points = h.points.filter((x) => x[2] !== 'start'); }
    }
  }
  async function rpcRetry(method, params) {
    for (let k = 0; ; k++) {
      try { return await rpc(method, params, chain); } catch (e) { if (k >= 3 || !/HTTP (429|5\d\d)|too many/i.test(e.message)) throw e; await sleep(500 * 2 ** k); }
    }
  }

  /** The server tells us how many cells a coin's poke lit (its summary's peak). */
  function addReaction(mint, cells) {
    rollDay();
    const w = s.day.worm[mint] || (s.day.worm[mint] = { pokes: 0, cells: 0 });
    w.pokes++; w.cells += cells || 0; save();
  }

  /**
   * The metadata of a SPAWN coin whose picture is its worm's first sight, rebuilt from what the chain says (and the
   * page's own record right after it was spawned). Only for coins on SPAWN's configs that pass the chat filter, so no
   * other token can borrow this address for its metadata.
   */
  async function coinMetadata(mint) {
    if (!B58.test(mint || '') || !opts.publicUrl) return null;
    let own = s.coins[mint], coin = cache.coins.find((c) => c.mint === mint);
    if (!own && !coin) { await fresh(true, true).catch(() => {}); coin = cache.coins.find((c) => c.mint === mint); }
    const name = own?.name || coin?.name, symbol = own?.symbol || coin?.symbol, pool = cache.pools.get(mint);
    if (!name || !symbol || (own && own.uri !== ownMeta(mint)) || (!own && pool?.uri !== ownMeta(mint))) return null;
    const site = `${opts.publicUrl}/spawn`;
    return { name, symbol, description: describe(symbol, pool?.cfg || current()), image: wormPicture(symbol), showName: true, createdOn: site, website: site };
  }

  function metaFile(name) {
    if (!root || !/^[0-9a-f]{24}\.(json|png|jpg|webp|gif)$/.test(name)) return null;
    const f = path.join(root, 'meta', name);
    return fs.existsSync(f) ? f : null;
  }

  return {
    get open() { return canLaunch(); },
    get pricedIn() { return current() ? quoteName(current()) : null; },   // what new coins are priced in
    get foundRoot() { return foundRoot; },   // $BRAINWORM's mint as the owner's configs on chain have it, when the site has none (SPAWN's own use only)
    status: () => ({ open: canLaunch(), trading: canTrade(), hosting: canHost(), owner: opts.owner || null, configs: s.configs, current: current()?.address || null, foundRoot: foundRoot || null, pending: pendingConfig, burns: s.burns.slice(-20), burned: s.burns.reduce((n, b) => n + b.amount, 0), waiting: cache.waiting, waitingSol: cache.waitingSol, stuck: cache.stuck, coins: cache.coins.length, stream: !!stream, prices: cache.prices, caughtUpAt }),
    fresh, publicState, quote, swap, confirm, create, created, claimCreator, rootPrice, buildConfig, confirmConfig, buildClaimAndBurn, buildClaimGraduated, buildClaimSol, buyback, burnClaimed, burned, addReaction, metaFile, coinMetadata, chart,
    start() { if (s.configs.length || opts.owner) fresh().catch(() => {}); },
    stop() {
      if (stream) stream.stop();
      stream = null; streamKey = ''; queue = [];
      clearTimeout(saveTimer); saveTimer = null;
      if (file) try { fs.writeFileSync(file, JSON.stringify(s)); } catch { /* disk gone */ }
    },
  };
}

/**
 * Confirmed transactions that mention any of `mentions`, from Solana RPC logsSubscribe (one subscription each),
 * with pings and backoff. DBC reports swaps through a self-CPI event, not its logs, so only the signature is
 * passed on and the caller reads the transaction.
 */
export function logsStream({ url, mentions, onSignature, logger = console, WebSocketImpl = WebSocket }) {
  let ws = null, stopped = false, backoff = 1000, timer = null, ping = null;
  const seen = new Set();
  function open() {
    if (stopped) return;
    const sock = ws = new WebSocketImpl(url, { handshakeTimeout: 10_000 });
    sock.on('open', () => {
      backoff = 1000;
      mentions.forEach((m, i) => sock.send(JSON.stringify({ jsonrpc: '2.0', id: i + 1, method: 'logsSubscribe', params: [{ mentions: [m] }, { commitment: 'confirmed' }] })));
      ping = setInterval(() => { try { sock.ping(); } catch { /* closing */ } }, 30_000);
    });
    sock.on('message', (data) => {
      let m; try { m = JSON.parse(String(data)); } catch { return; }
      const v = m.method === 'logsNotification' ? m.params?.result?.value : null;
      if (!v || v.err || !v.signature || seen.has(v.signature)) return;
      seen.add(v.signature);
      if (seen.size > 2000) seen.clear();
      try { onSignature(v.signature); } catch (e) { logger.warn(`[spawn] ${e.message}`); }
    });
    sock.on('close', () => {
      clearInterval(ping);
      if (stopped || sock !== ws) return;
      clearTimeout(timer); timer = setTimeout(open, backoff); backoff = Math.min(60_000, backoff * 2);
    });
    sock.on('error', (e) => { logger.warn(`[spawn] stream: ${String(e.message).split(url).join('<url>')}`); });
  }
  return { start: open, stop() { stopped = true; clearTimeout(timer); clearInterval(ping); if (ws) ws.terminate(); ws = null; } };
}

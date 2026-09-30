// SPAWN: the BRAINWORM launchpad, on pump.fun. Anyone can launch a coin: a pump.fun coin, with pump.fun's bonding
// curve, fees and graduation to PumpSwap, whose pump.fun creator is SPAWN's rewards wallet (the owner's, set on /launch
// or by SPAWN_OWNER). So the creator rewards of every SPAWN coin collect in that wallet's pump.fun vaults. The owner
// collects them (collect() then collected()); 64% of everything collected buys $WORM (buyback()), and every bit of that
// $WORM is burned (burnBought() then burned()); the other 36% stays with the team. Each buy of a coin also pokes the
// worm at the coin's own spot.
//
// Every coin also hatches its own worm (shared/coinworm.js, kept by server/coinworms.js): a fresh copy of the same
// larva whose first sight is the coin's ticker and which feels every trade of the coin after that. Its trades also
// make its price chart (chart()). Trades are read from pump.fun's own events, from one log subscription: every trade of
// every SPAWN coin names the rewards wallet's vault.
//
// This module never holds a key and never sends a transaction. It builds unsigned transactions for people's own
// wallets (visitors, launchers, the owner), reads the chain and reports trades. The only key made is a new coin's
// fresh mint (server/pump.js), which signs its own slot and is dropped.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import WebSocket from 'ws';
import { rpc } from './solana.js';
import * as pumpLib from './pump.js';

export const SOL_MINT = 'So11111111111111111111111111111111111111112';
export const BUYBACK_SHARE = 0.64;   // of the creator rewards SPAWN collects: buys $WORM, all of it burned
export const SLIPPAGE_BPS = 300;
const QUOTE_TTL_MS = 120_000, REFRESH_MS = 20_000, STALE_COIN_MS = 3600_000, STATE_MS = 300_000, LOCK_MS = 90_000;
const MAX_IMAGE = 1_500_000, CHART_POINTS = 2000, SUPPLY = 1_000_000_000, DECIMALS = 6;
// pictures kept on this server's disk: at most this much, and one whose coin never reached the chain is deleted after a while
const META_BUDGET = 1e9, UPLOAD_GRACE_MS = 2 * 3600_000, SWEEP_MS = 600_000;
const LAUNCH_RENT_SOL = 0.02;            // what a new coin's own accounts cost its launcher, about
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
const RESERVED = new Set(['WORM', 'BRAINWORM']);   // the site's own coin
const dayKey = (ts = Date.now()) => new Date(ts).toISOString().slice(0, 10);
const round = (x, d = 6) => Math.round(x * 10 ** d) / 10 ** d;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sol = (lamports) => Number(lamports) / 1e9;
const human = (e) => new Error(String(e?.message || e).replace(/^(pump|solana): /, '').replace(/^./, (x) => x.toUpperCase()));

/**
 * @param {object} o
 * @param {string|null} o.dir       where state lives (LOG_DIR); null keeps it in memory
 * @param {object} [o.pump]         server/pump.js (injected so tests can fake the chain)
 * @param {() => string} o.rootMint $WORM's mint once it exists ('' before)
 * @param {(text: string) => {ok: boolean, text?: string, message?: string}} o.moderate  the site's chat filter
 * @param {object} o.opts           { rpc, ws, WebSocketImpl, publicUrl, pinataJwt, uploadPinata, jupiterKey, owner, localMeta, metaBudget }
 * @param {(t: object) => void} o.onTrade  every trade of a SPAWN coin seen live
 * @param {object} [o.coinWorms]   server/coinworms.js: each coin's own worm
 */
export function createSpawn({ dir, pump = pumpLib, rootMint, moderate = (t) => ({ ok: true, text: t }), opts = {}, onTrade = () => {}, onCoins = () => {}, coinWorms = null, render = null, D = null, fetchImpl = fetch, logger = console }) {
  const root = dir ? path.join(dir, 'spawn') : null;
  if (root) fs.mkdirSync(path.join(root, 'meta'), { recursive: true });
  const file = root && path.join(root, 'state.json');
  let s = { owners: [], owner: '', coins: {}, uploads: {}, claims: [], buybacks: [], burns: [], day: { key: dayKey(), worm: {} } };
  try { if (file) s = { ...s, ...JSON.parse(fs.readFileSync(file, 'utf8')) }; } catch { /* first run */ }
  for (const k of ['owners', 'claims', 'buybacks', 'burns']) if (!Array.isArray(s[k])) s[k] = [];
  if (!s.uploads || typeof s.uploads !== 'object') s.uploads = {};
  let saveTimer = null;
  // written whole or not at all (a new file, then renamed over the old one): a restart mid-write can't leave half a file
  const save = () => { if (!file || saveTimer) return; saveTimer = setTimeout(() => { saveTimer = null; fs.writeFile(file + '.tmp', JSON.stringify(s), (e) => { if (!e) fs.rename(file + '.tmp', file, () => {}); }); }, 500); };
  const metaDir = root && path.join(root, 'meta');
  let metaBytes = 0;   // what the kept pictures and their metadata take on disk
  if (metaDir) for (const n of fs.readdirSync(metaDir)) { try { metaBytes += fs.statSync(path.join(metaDir, n)).size; } catch { /* gone */ } }
  const chain = { url: opts.rpc, fetchImpl };
  // Jupiter's free API routes only through tokens it trusts as a middle hop; a key (a paid plan) lifts that
  const jupBase = opts.jupiterKey ? 'https://api.jup.ag' : 'https://lite-api.jup.ag';

  const quotes = new Map();   // quoteId -> {leg, at, user}: the server keeps each quote, so nobody can swap in a doctored one
  let cache = { at: 0, coins: [], curves: new Map(), byPool: new Map(), prices: {}, vaults: { curve: 0n, amm: 0n } };
  let collectLockUntil = 0, buybackLockUntil = 0, pendingBuyback = null;
  const worm = () => rootMint() || '';
  /** SPAWN's rewards wallet: every coin launched now names it as its pump.fun creator. */
  const owner = () => opts.owner || s.owner || '';
  const owners = () => [...new Set([...s.owners, ...(owner() ? [owner()] : [])])];   // every wallet coins were launched for
  // A picked picture and each coin's metadata must stay up for good: on IPFS through Pinata, or on this server's own
  // disk when that disk lasts.
  const pinata = () => !!(opts.pinataJwt && opts.uploadPinata);
  const canHost = () => pinata() || !!(opts.localMeta && root && opts.publicUrl);
  const budget = () => opts.metaBudget ?? META_BUDGET;
  const canPick = () => pinata() || (canHost() && metaBytes < budget());   // room for one more picked picture
  const canLaunch = () => !!owner() && canHost();
  const wormPicture = (symbol) => `${opts.publicUrl}/spawn/hatch/${symbol}.png`;

  // pump.fun's Global (fee recipients, a new curve's reserves) and its fee schedule, read every few minutes
  let program = null, programAt = 0;
  async function programState(force = false) {
    if (!program || force || Date.now() - programAt > STATE_MS) { program = await pump.fetchProgramState(chain); programAt = Date.now(); }
    return program;
  }

  /* ---------- reading the chain ---------- */

  const onHost = (u) => typeof u === 'string' && (IMAGE_HOSTS.some((h) => u.startsWith(h) && /^[A-Za-z0-9]+$/.test(u.slice(h.length))) || (!!opts.publicUrl && u.startsWith(opts.publicUrl + '/spawn/meta/')));
  const allowedImage = (u) => onHost(u) || (!!opts.publicUrl && typeof u === 'string' && u.startsWith(opts.publicUrl) && /^\/spawn\/hatch\/[A-Z0-9]{1,10}\.png$/.test(u.slice(opts.publicUrl.length)));

  async function jup(pathname, init = {}) {
    const headers = { ...(init.headers || {}), ...(opts.jupiterKey ? { 'x-api-key': opts.jupiterKey } : {}) };
    const r = await fetchImpl(jupBase + pathname, { ...init, headers, signal: AbortSignal.timeout(15_000) });
    const j = await r.json().catch(() => null);
    if (!r.ok || !j || j.error) {
      const e = new Error(`Jupiter: ${(j && (j.error || j.message)) || r.status}`);
      e.noRoute = /route|not[_ ]tradable/i.test(`${j?.error || ''} ${j?.errorCode || ''} ${j?.message || ''}`);
      throw e;
    }
    return j;
  }
  const jupPrices = (ids) => jup(`/price/v3?ids=${[...new Set(ids)].join(',')}`);
  const jupQuote = (inputMint, outputMint, amount) => jup(`/swap/v1/quote?${new URLSearchParams({ inputMint, outputMint, amount: String(amount), slippageBps: String(SLIPPAGE_BPS), ...(opts.jupiterKey ? { restrictIntermediateTokens: 'false' } : {}) })}`);
  const jupSwap = (quoteResponse, user) => jup('/swap/v1/swap', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ quoteResponse, userPublicKey: user, wrapAndUnwrapSol: true, dynamicComputeUnitLimit: true, prioritizationFeeLamports: { priorityLevelWithMaxLamports: { maxLamports: 1_000_000, priorityLevel: 'high' } } }),
  });

  /** $WORM's price in SOL: from its pump.fun curve while it has one, else Jupiter's. */
  async function wormPrice(prices, solUsd) {
    const m = worm();
    if (!m) return { rootSol: 0, rootUsd: 0 };
    let rootSol = 0;
    try { const c = (await pump.fetchCurves({ mints: [m], ...chain })).get(m); if (c && !c.complete) rootSol = pump.priceSol(c); } catch { /* Jupiter's then */ }
    if (!rootSol && prices[m]?.usdPrice && solUsd) rootSol = prices[m].usdPrice / solUsd;
    return { rootSol, rootUsd: rootSol * solUsd };
  }

  async function refresh() {
    const mints = Object.keys(s.coins);
    const [curves, state] = await Promise.all([mints.length ? pump.fetchCurves({ mints, ...chain }) : new Map(), programState().catch(() => program)]);
    const mine = new Set(owners());
    // graduated coins trade on PumpSwap once pump.fun has moved them there: until its pool exists they're "graduating"
    const done = mints.filter((m) => curves.get(m)?.complete);
    const pools = new Map(done.map((m) => [m, pump.pumpSwapPool(m)]));
    const livePools = new Set();
    if (done.length) {
      for (let i = 0; i < done.length; i += 100) {
        const r = await rpc('getMultipleAccounts', [done.slice(i, i + 100).map((m) => pools.get(m)), { encoding: 'base64', commitment: 'confirmed', dataSlice: { offset: 0, length: 0 } }], chain).catch(() => null);
        (r?.value || []).forEach((v, k) => { if (v) livePools.add(done[i + k]); });
      }
    }
    let prices = {};
    try { prices = await jupPrices([SOL_MINT, ...(worm() ? [worm()] : []), ...done.slice(0, 45)]); } catch (e) { logger.warn(`[spawn] prices: ${e.message}`); }
    const solUsd = prices[SOL_MINT]?.usdPrice || cache.prices.solUsd || 0;
    const { rootSol, rootUsd } = await wormPrice(prices, solUsd);
    const coins = [], byPool = new Map();
    for (const mint of mints) {
      const c = curves.get(mint), own = s.coins[mint];
      if (!c || !mine.has(c.creator)) continue;   // not on chain (yet), or not SPAWN's
      const stage = !c.complete ? 'curve' : livePools.has(mint) ? 'graduated' : 'graduating';
      if (stage !== 'curve') byPool.set(pools.get(mint), mint);
      const priceSol = stage === 'curve' ? pump.priceSol(c) : prices[mint]?.usdPrice && solUsd ? prices[mint].usdPrice / solUsd : pump.priceSol(c);
      coins.push({
        mint, name: own.name, symbol: own.symbol, image: allowedImage(own.image) ? own.image : '', creator: own.creator, createdAt: own.createdAt,
        quote: 'SOL', priceQuote: priceSol, priceSol, priceUsd: priceSol * solUsd, mcapSol: priceSol * SUPPLY, progress: pump.progress(c, state?.global), graduated: stage !== 'curve', stage,
      });
    }
    // coins launched on the page that never made it on chain are forgotten after an hour, and their kept pictures later
    for (const [mint, c] of Object.entries(s.coins)) if (!curves.get(mint) && Date.now() - c.createdAt > STALE_COIN_MS) delete s.coins[mint];
    await sweepUploads(new Set(coins.map((c) => c.mint))).catch((e) => logger.warn(`[spawn] sweeping pictures: ${e.message}`));
    let vaults = cache.vaults;
    if (owner()) try { vaults = await pump.fetchCreatorFees({ creator: owner(), ...chain }); } catch (e) { logger.warn(`[spawn] vaults: ${e.message}`); }
    cache = { at: Date.now(), coins, curves, byPool, prices: { solUsd, rootUsd, rootSol }, vaults };
    // every coin shown hatches its own worm (a few each refresh, so a first listing of many coins doesn't stall the server)
    if (coinWorms) { let n = 0; for (const c of coins) if (!coinWorms.has(c.mint) && n++ < 10) coinWorms.hatch(c.mint, c.symbol); }
    try { onCoins(coins); } catch (e) { logger.warn(`[spawn] ${e.message}`); }
    save();
    startStream();
    if (!catching && (!caughtUpAt || coins.some((c) => !charted.has(c.mint)))) catching = catchUp().catch((e) => logger.warn(`[spawn] catch-up: ${e.message}`)).finally(() => { catching = null; });
  }
  let refreshing = null;
  function kick() {
    if (!refreshing) refreshing = refresh().catch((e) => logger.warn(`[spawn] refresh: ${e.message}`)).finally(() => { refreshing = null; });
    return refreshing;
  }
  /** Refresh in the background when the listing is old (the first read waits). force: wait for a fresh one. */
  async function fresh(force = false) {
    if (force) { if (refreshing) await refreshing; return kick(); }
    if (Date.now() - cache.at > REFRESH_MS) { const r = kick(); if (!cache.at) await r; }
  }

  function rollDay() { const k = dayKey(); if (s.day.key !== k) { s.day = { key: k, worm: {} }; save(); } }
  const lamportsOf = (list) => list.reduce((n, x) => n + BigInt(x.lamports), 0n);
  /** The creator rewards: collected so far, spent on $WORM, and what 64% of the collected still owes the buyback (lamports). */
  function rewards() {
    const collected = lamportsOf(s.claims), spent = lamportsOf(s.buybacks);
    const owed = (collected * BigInt(Math.round(BUYBACK_SHARE * 10_000))) / 10_000n - spent;
    return { collected, spent, owed: owed > 0n ? owed : 0n };
  }
  function publicState() {
    rollDay();
    const sym = (mint) => cache.coins.find((c) => c.mint === mint)?.symbol;
    const movers = Object.entries(s.day.worm).filter(([mint]) => sym(mint)).map(([mint, w]) => ({ mint, symbol: sym(mint), ...w }))
      .sort((a, b) => b.cells - a.cells || b.pokes - a.pokes).slice(0, 10);
    const r = rewards(), fees = program?.fees?.flat;
    return {
      open: canLaunch(),
      reason: !owner() ? 'Opening soon.' : !canHost() ? 'Opening soon: coin pictures are being set up.' : null,
      quote: 'SOL',
      pictures: canPick(),                     // a picked picture can be kept for good (else every coin gets its worm's)
      root: {
        mint: worm() || null, priceSol: cache.prices.rootSol || 0, priceUsd: cache.prices.rootUsd || 0, solUsd: cache.prices.solUsd || 0,
        burned: round(s.burns.reduce((n, b) => n + b.amount, 0), 2),
        burns: s.burns.slice(-5).reverse().map((b) => ({ signature: b.signature, amount: round(b.amount, 2), at: b.at })),
      },
      rewards: {
        waiting: round(sol(cache.vaults.curve + cache.vaults.amm), 4),   // in SPAWN's vaults, not collected yet
        collected: round(sol(r.collected), 4), spentOnWorm: round(sol(r.spent), 4), owed: round(sol(r.owed), 4), share: BUYBACK_SHARE,
      },
      fee: { platform: 'pump.fun', protocolBps: fees ? Number(fees.protocol) : null, creatorBps: fees ? Number(fees.creator) : null, buyback: BUYBACK_SHARE },
      coins: cache.coins.map((c) => ({ ...c, worm: s.day.worm[c.mint] || { pokes: 0, cells: 0 }, own: coinWorms?.info(c.mint) || null })),
      movers,
      pokesToday: Object.values(s.day.worm).reduce((n, w) => n + w.pokes, 0),
    };
  }

  /* ---------- trading: on the coin's own curve, or through Jupiter once it has graduated ---------- */

  /** A quote: buying (amount in SOL) or selling (amount in coins). */
  async function quote({ mint, side, amount }) {
    await fresh();
    const coin = cache.coins.find((c) => c.mint === mint);
    if (!B58.test(mint || '') || !coin) throw new Error('Not a SPAWN coin.');
    if (coin.stage === 'graduating') throw new Error(`$${coin.symbol} is moving to PumpSwap. Trading opens again in a few minutes.`);
    const n = Number(amount), buy = side !== 'sell';
    if (!(n > 0) || !Number.isFinite(n)) throw new Error('Enter an amount.');
    if (buy && n > 1000) throw new Error('That is more than this page will route.');
    const amountIn = BigInt(Math.round(n * 10 ** (buy ? 9 : DECIMALS)));
    let leg;
    if (coin.stage === 'curve') {
      const [c, st] = await Promise.all([pump.fetchCurves({ mints: [mint], ...chain }).then((m) => m.get(mint)), programState()]);
      if (!c) throw new Error('That coin\'s curve is not there.');
      if (c.complete) { await fresh(true); throw new Error(`$${coin.symbol} just graduated. Trading opens again on PumpSwap in a few minutes.`); }
      const q = buy ? pump.quoteBuy(c, st.fees, amountIn) : pump.quoteSell(c, st.fees, amountIn);
      if (!(q.out > 0n)) throw new Error(buy ? 'Too little to buy anything.' : 'Too little to sell.');
      leg = { kind: 'curve', mint, side: buy ? 'buy' : 'sell', amountIn, out: q.out, min: pump.minOut(q.out, SLIPPAGE_BPS), creator: c.creator };
    } else {
      let res;
      try { res = await jupQuote(buy ? SOL_MINT : mint, buy ? mint : SOL_MINT, amountIn); } catch (e) { throw e.noRoute ? new Error('No route for that yet. Try again in a minute.') : e; }
      leg = { kind: 'jup', res, out: BigInt(res.outAmount), min: BigInt(res.otherAmountThreshold) };
    }
    const quoteId = crypto.randomBytes(9).toString('base64url');
    quotes.set(quoteId, { leg, at: Date.now(), user: null });
    for (const [k, v] of quotes) if (Date.now() - v.at > QUOTE_TTL_MS) quotes.delete(k);
    const dec = buy ? DECIMALS : 9;
    return {
      quoteId, steps: 1, route: buy ? ['SOL', '$' + coin.symbol] : ['$' + coin.symbol, 'SOL'],
      out: { symbol: buy ? '$' + coin.symbol : 'SOL', amount: Number(leg.out) / 10 ** dec, min: Number(leg.min) / 10 ** dec },
      priceImpactPct: leg.kind === 'jup' ? Number(leg.res.priceImpactPct) || 0 : 0,
    };
  }

  /** The transaction for a quote this server made, for the visitor's wallet to sign and send. */
  async function swap({ quoteId, user }) {
    const q = quotes.get(quoteId);
    if (!q || Date.now() - q.at > QUOTE_TTL_MS) throw new Error('That quote expired. Enter the amount again.');
    if (!B58.test(user || '')) throw new Error('Connect a wallet first.');
    if (q.user) throw new Error('That quote was used. Enter the amount again.');
    q.user = user;   // taken before anything is awaited: two requests at once can't both build it
    const { leg } = q;
    try {
      let tx;
      if (leg.kind === 'jup') {
        const j = await jupSwap(leg.res, user);
        if (!j.swapTransaction) throw new Error('Jupiter did not return a transaction.');
        tx = j.swapTransaction;
      } else {
        const [c, st] = await Promise.all([pump.fetchCurves({ mints: [leg.mint], ...chain }).then((m) => m.get(leg.mint)), programState()]);
        if (!c || c.complete) throw new Error('That coin just graduated. Enter the amount again in a few minutes.');
        // priced again now: a trade that would come in under the quote's floor could only fail on chain
        const now = leg.side === 'buy' ? pump.quoteBuy(c, st.fees, leg.amountIn).out : pump.quoteSell(c, st.fees, leg.amountIn).out;
        if (now < leg.min) throw new Error('The price moved. Get a new quote.');
        tx = leg.side === 'buy'
          ? await pump.buildBuy({ mint: leg.mint, user, creator: c.creator, lamports: leg.amountIn, minTokens: leg.min, global: st.global, ...chain })
          : await pump.buildSell({ mint: leg.mint, user, creator: c.creator, amount: leg.amountIn, minSol: leg.min, global: st.global, ...chain });
      }
      quotes.delete(quoteId);
      return { tx, step: 0, steps: 1 };
    } catch (e) { q.user = null; throw human(e); }   // nothing was built: it can be asked for again
  }

  /** Has a transaction landed? */
  async function confirm({ signature }) {
    if (!SIG.test(signature || '')) throw new Error('Bad signature.');
    const st = (await rpc('getSignatureStatuses', [[signature]], chain))?.value?.[0];
    return { confirmed: !!st && !st.err && ['confirmed', 'finalized'].includes(st.confirmationStatus), failed: !!st?.err };
  }

  /* ---------- launching a coin ---------- */

  const describe = (symbol) => `$${symbol} was launched on SPAWN, the BRAINWORM launchpad. It hatched its own copy of a simulated worm larva's nervous system, which feels every trade of it, and every buy pokes the live worm.${opts.publicUrl ? ` ${opts.publicUrl}/spawn` : ''}`;
  // A coin's metadata goes on chain as a link, and pump.fun's transaction is close to Solana's size limit: links here are
  // short, /m/<12 characters>. Each file is named by the hash of what's in it, so a name can only ever hold that
  // content: two coins with the same picture share the picture, never each other's metadata. Nothing is written until
  // a transaction names it (keep).
  const shortId = (b) => crypto.createHash('sha256').update(b).digest('base64url').slice(0, 12);
  async function uploadMeta({ image, type, name, symbol, wormImage }) {
    const site = opts.publicUrl ? `${opts.publicUrl}/spawn` : '';
    const description = describe(symbol);
    if (pinata()) {
      const r = await opts.uploadPinata({ image, filename: `${symbol}.${IMAGE_TYPES[type]}`, name, symbol, description, website: site, createdOn: site, jwt: opts.pinataJwt, fetchImpl });
      return { uri: r.metadataUri, image: r.metadata?.image || '' };
    }
    if (!opts.localMeta || !root || !opts.publicUrl) throw new Error('Picture hosting is not set up yet.');
    const imageName = wormImage ? null : `${crypto.createHash('sha256').update(image).digest('hex').slice(0, 24)}.${IMAGE_TYPES[type]}`;
    const imageUrl = wormImage || `${opts.publicUrl}/spawn/meta/${imageName}`;
    const json = JSON.stringify({ name, symbol, description, image: imageUrl, showName: true, createdOn: site, website: site }), jsonName = `${shortId(json)}.json`;
    if (metaBytes + (image?.length || 0) + json.length > budget()) throw new Error('Picture uploads are full for now. Launch it with its worm\'s first sight, or try again later.');
    const keep = (mint) => {
      for (const [n, b] of [[imageName, image], [jsonName, json]]) {
        if (!n) continue;
        const f = path.join(metaDir, n);
        if (!fs.existsSync(f)) { fs.writeFileSync(f, b); metaBytes += Buffer.byteLength(b); }
      }
      const u = s.uploads[jsonName] ||= { mints: [], at: 0, image: imageName };
      if (!u.live) { if (!u.mints.includes(mint)) u.mints.push(mint); u.at = Date.now(); }
    };
    return { uri: `${opts.publicUrl}/m/${jsonName.slice(0, -5)}`, image: imageUrl, keep };
  }
  const dropMeta = (n) => { if (!n) return; const f = path.join(metaDir, n); try { metaBytes -= fs.statSync(f).size; fs.rmSync(f); } catch { /* already gone */ } };
  /** Files kept for coins that never reached the chain (nobody signed, or it never landed) are deleted once the chain
   *  itself says that no coin named them: none of the listed coins uses the file, and none of the mints that named it
   *  exists. One a coin uses stays for good. */
  let sweptAt = 0;
  async function sweepUploads(listed) {
    if (!metaDir || Date.now() - sweptAt < SWEEP_MS) return;
    sweptAt = Date.now();
    for (const [n, u] of Object.entries(s.uploads)) {
      if (u.live) continue;
      if (u.mints.some((m) => listed.has(m))) { u.live = true; continue; }
      if (Date.now() - u.at < UPLOAD_GRACE_MS) continue;
      let exists = false, known = true;
      for (const m of u.mints) {
        try {
          const info = await rpc('getAccountInfo', [m, { encoding: 'base64', commitment: 'confirmed', dataSlice: { offset: 0, length: 0 } }], chain);
          if (!info || !('value' in info)) { known = false; break; }
          if (info.value) { exists = true; break; }
        } catch { known = false; break; }
      }
      if (exists) { u.live = true; continue; }
      if (!known) continue;   // ask again next time
      delete s.uploads[n];
      dropMeta(n);
      if (u.image && !Object.values(s.uploads).some((o) => o.image === u.image)) dropMeta(u.image);
    }
    save();
  }

  /**
   * The create transaction for the launcher's wallet (the coin's fresh mint key already signed in it): a pump.fun coin
   * whose creator is SPAWN's rewards wallet, and an optional first buy for the launcher in the same transaction.
   * canUpload: asked just before a picked picture is kept, once everything else checks out (the site's budget for them).
   */
  async function create({ creator, name, symbol, image, firstBuy }, { canUpload = () => true } = {}) {
    if (!canLaunch()) throw new Error('The launchpad is not open yet.');
    if (!B58.test(creator || '')) throw new Error('Connect a wallet first.');
    const nm = moderate(String(name || '').trim()), sy = moderate(String(symbol || '').trim().toUpperCase());
    if (!nm.ok) throw new Error(nm.message || 'That name is not allowed.');
    if (!sy.ok) throw new Error(sy.message || 'That ticker is not allowed.');
    if (!nm.text || Buffer.byteLength(nm.text) > 32) throw new Error('Names are 1 to 32 characters.');
    if (!/^[A-Z0-9]{1,10}$/.test(sy.text)) throw new Error('Tickers are 1 to 10 letters or digits.');
    if (RESERVED.has(sy.text)) throw new Error('That ticker is taken.');
    const buy = Number(firstBuy || 0);
    if (!(buy >= 0) || !Number.isFinite(buy) || buy > 100) throw new Error('The first buy is a number of SOL (100 at most).');
    let m = null, bytes = null;
    if (image !== 'worm') {
      if (!canPick()) throw new Error('Picture uploads are full for now. Launch it with its worm\'s first sight.');
      m = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/=]+)$/.exec(String(image || ''));
      if (!m) throw new Error('Add a PNG, JPG, WEBP or GIF picture, or use its worm\'s first sight.');
      bytes = Buffer.from(m[2], 'base64');
      if (bytes.length > MAX_IMAGE) throw new Error('That picture is too big (1.5 MB at most).');
      if (!MAGIC[m[1]](bytes)) throw new Error('That file is not the picture it says it is.');
    }
    // before anything is kept: can this wallet pay for its coin? (its accounts' rent, and a first buy)
    const lamports = await rpc('getBalance', [creator, { commitment: 'confirmed' }], chain).then((r) => r.value, () => null);
    const need = LAUNCH_RENT_SOL + buy;
    if (lamports != null && lamports / 1e9 < need) throw new Error(`Launching needs about ${round(need, 4)} SOL in that wallet (${buy ? `${buy} for the first buy, and about ${LAUNCH_RENT_SOL} for the coin's accounts` : `about ${LAUNCH_RENT_SOL} for the coin's accounts`}). It has ${round(lamports / 1e9, 4)}.`);
    if (image !== 'worm' && !canUpload()) throw new Error('Many coins are being launched right now. Try again in a minute, or give it its worm\'s first sight.');
    let meta;
    if (image === 'worm') {
      // its picture is its worm's first sight (a fresh worm shown the ticker, drawn from the real wiring): here it is
      // drawn on request, so only its metadata is kept; with Pinata the picture goes to IPFS too
      if (pinata() && (!render || !D)) throw new Error('Pictures from the worm are not available here.');
      const png = pinata() ? (await import('./coinworms.js')).previewHatch({ D, render, ticker: sy.text, width: 512 }).png : null;
      meta = await uploadMeta({ image: png, type: 'image/png', name: nm.text, symbol: sy.text, wormImage: pinata() ? null : wormPicture(sy.text) });
    } else meta = await uploadMeta({ image: bytes, type: m[1], name: nm.text, symbol: sy.text });
    let built;
    try { built = await pump.buildCreate({ user: creator, creator: owner(), name: nm.text, symbol: sy.text, uri: meta.uri, firstBuySol: buy, state: await programState(), ...chain }); } catch (e) { throw human(e); }
    meta.keep?.(built.mint);
    if (!s.owners.includes(owner())) s.owners.push(owner());
    s.coins[built.mint] = { name: nm.text, symbol: sy.text, image: meta.image, uri: meta.uri, creator, createdAt: Date.now() };
    save();
    const fb = built.firstBuy;
    return { tx: built.tx, mint: built.mint, firstBuy: fb ? { coins: Number(fb.tokens) / 10 ** DECIMALS, minCoins: Number(fb.minTokens) / 10 ** DECIMALS } : null, quote: 'SOL' };
  }
  function created({ mint, signature }) {
    const c = s.coins[mint];
    if (!c || !SIG.test(signature || '')) return false;
    c.signature = signature; save();
    fresh(true).catch(() => {});
    for (const ms of opts.rescanMs || [4000, 12000]) setTimeout(() => { if (!cache.coins.some((x) => x.mint === mint)) fresh(true).catch(() => {}); }, ms).unref?.();
    return true;
  }
  /** A coin launched on this page in the last hour that isn't listed yet (its page can be served: it polls the listing). */
  function pending(mint) {
    const c = s.coins[mint];
    return c && !cache.coins.some((x) => x.mint === mint) && Date.now() - c.createdAt < STALE_COIN_MS ? { mint, name: c.name, symbol: c.symbol, image: allowedImage(c.image) ? c.image : '', createdAt: c.createdAt } : null;
  }

  /* ---------- the owner: SPAWN's rewards wallet, collecting, the $WORM buyback and burn ---------- */

  const checkOwner = (wallet) => {
    if (!B58.test(wallet || '')) throw new Error('Connect SPAWN\'s rewards wallet first.');
    if (wallet !== owner()) throw new Error(`Use SPAWN's rewards wallet (${owner()}).`);
  };
  /** The wallet every new coin names as its pump.fun creator. Not the one that launches $WORM: its vault would mix the two. */
  async function setOwner({ wallet, wormCreator = '' }) {
    if (opts.owner) throw new Error('SPAWN\'s rewards wallet is set on the server (SPAWN_OWNER).');
    if (!B58.test(wallet || '')) throw new Error('Connect a wallet first.');
    if (wormCreator && wallet === wormCreator) throw new Error('Use a different wallet from the one that launched $WORM: $WORM\'s own creator rewards would mix with SPAWN\'s in the same vault.');
    if (worm()) {
      const c = (await pump.fetchCurves({ mints: [worm()], ...chain }).catch(() => new Map())).get(worm());
      if (c?.creator === wallet) throw new Error('That wallet is $WORM\'s creator. Use a different one: $WORM\'s own creator rewards would mix with SPAWN\'s in the same vault.');
    }
    s.owner = wallet;
    if (!s.owners.includes(wallet)) s.owners.push(wallet);
    save();
    await fresh(true);
    return { owner: wallet };
  }
  /** Every coin's creator rewards, from SPAWN's vaults (on the curve and on PumpSwap) to its wallet, as SOL. */
  async function collect({ wallet }) {
    checkOwner(wallet);
    if (Date.now() < collectLockUntil) throw new Error('The last collection may still land. Try again in a minute.');
    collectLockUntil = Date.now() + LOCK_MS;   // taken before anything is awaited
    try {
      const v = await pump.fetchCreatorFees({ creator: wallet, ...chain });
      if (v.curve + v.amm < 1_000_000n) throw new Error('Less than 0.001 SOL waiting. Nothing to collect yet.');
      return { tx: await pump.buildCollect({ creator: wallet, curve: v.curve > 0n, amm: v.amm > 0n, ...chain }), sol: sol(v.curve + v.amm) };
    } catch (e) { collectLockUntil = 0; throw human(e); }
  }
  /** Record a collection: exactly what pump.fun's and PumpSwap's events say it paid SPAWN's wallet. */
  async function collected({ signature }) {
    if (!SIG.test(signature || '')) throw new Error('Bad signature.');
    if (s.claims.some((c) => c.signature === signature)) return { ok: true };
    const l = await pump.fetchLogs({ signature, ...chain });
    if (!l) return { ok: false, error: 'Not confirmed yet.' };
    const lamports = pump.eventsFromLogs(l.logs).filter((e) => e.kind === 'collect' && owners().includes(e.creator)).reduce((n, e) => n + e.lamports, 0n);
    collectLockUntil = 0;
    if (!(lamports > 0n)) return { ok: false, error: 'That transaction collected nothing for SPAWN.' };
    s.claims.push({ signature, lamports: String(lamports), at: Date.now() });
    save();
    return { ok: true, sol: sol(lamports), owed: sol(rewards().owed) };
  }
  /**
   * The buyback: 64% of everything collected, less what earlier buybacks spent, into $WORM: on its pump.fun curve while
   * it has one, through Jupiter after. For SPAWN's wallet to sign; burnBought() then burns exactly what it bought.
   */
  async function buyback({ wallet }) {
    checkOwner(wallet);
    if (!worm()) throw new Error('$WORM has not launched yet.');
    const { owed } = rewards();
    if (owed < 1_000_000n) throw new Error('Less than 0.001 SOL owed to the buyback. Collect the creator rewards first.');
    if (Date.now() < buybackLockUntil) throw new Error('The last buyback may still land. Try again in a minute.');
    buybackLockUntil = Date.now() + LOCK_MS;
    try {
      const m = worm(), [c, st] = await Promise.all([pump.fetchCurves({ mints: [m], ...chain }).then((x) => x.get(m)), programState()]);
      let tx, out, min;
      if (c && !c.complete) {
        ({ out } = pump.quoteBuy(c, st.fees, owed)); min = pump.minOut(out, SLIPPAGE_BPS);
        tx = await pump.buildBuy({ mint: m, user: wallet, creator: c.creator, lamports: owed, minTokens: min, global: st.global, ...chain });
      } else {
        const q = await jupQuote(SOL_MINT, m, owed);
        const j = await jupSwap(q, wallet);
        if (!j.swapTransaction) throw new Error('Jupiter did not return a transaction.');
        tx = j.swapTransaction; out = BigInt(q.outAmount); min = BigInt(q.otherAmountThreshold);
      }
      pendingBuyback = { lamports: owed, at: Date.now() };
      return { tx, sol: sol(owed), worm: Number(out) / 10 ** DECIMALS, min: Number(min) / 10 ** DECIMALS };
    } catch (e) { buybackLockUntil = 0; throw human(e); }
  }
  /** Once a buyback has landed: it is recorded, and the burn of exactly the $WORM it bought is built. */
  async function burnBought({ signature }) {
    if (!SIG.test(signature || '')) throw new Error('Bad signature.');
    const b = await pump.buildBurnReceived({ signature, owner: owner(), mint: worm(), ...chain });
    if (!b) throw new Error('That transaction brought no $WORM.');
    if (!s.buybacks.some((x) => x.signature === signature)) {
      s.buybacks.push({ signature, lamports: String(pendingBuyback?.lamports ?? 0n), worm: b.amount, at: Date.now() });
      pendingBuyback = null; buybackLockUntil = 0; save();
    }
    return { tx: b.tx, amount: b.amount };
  }
  // how much $WORM SPAWN's wallet burned in a transaction (0 if none), read from the chain
  async function burnedIn(signature) {
    const tx = await rpc('getTransaction', [signature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0, commitment: 'confirmed' }], chain);
    if (!tx) return null;
    if (tx.meta?.err) return 0;
    let amount = 0;
    for (const ix of tx.transaction?.message?.instructions || []) {
      const x = ix.parsed;
      if (!x || !/^spl-token(-2022)?$/.test(ix.program) || !['burn', 'burnChecked'].includes(x.type) || x.info?.mint !== worm() || !owners().includes(x.info?.authority)) continue;
      amount += x.type === 'burnChecked' ? Number(x.info.tokenAmount.amount) / 10 ** x.info.tokenAmount.decimals : Number(x.info.amount) / 10 ** DECIMALS;
    }
    return amount;
  }
  /** Record a burn: read from the chain how much $WORM SPAWN's wallet burned in it. */
  async function burned({ signature }) {
    if (!SIG.test(signature || '')) throw new Error('Bad signature.');
    if (s.burns.some((b) => b.signature === signature)) return { ok: true };
    const amount = await burnedIn(signature);
    if (amount === null) return { ok: false, error: 'Not confirmed yet.' };
    if (!(amount > 0)) return { ok: false, error: 'That transaction burned no $WORM from SPAWN\'s wallet.' };
    s.burns.push({ signature, amount, at: Date.now() });
    save();
    return { ok: true, amount };
  }

  /* ---------- each coin's price chart ---------- */

  // Every trade of a coin: [time (ms), its price right after it in SOL per whole coin, side, SOL, signature], oldest
  // first, CHART_POINTS at most, from its curve's first price when it was made. Kept in memory: after a restart,
  // catchUp() reads the latest trades back from the chain.
  const charts = new Map();   // mint -> { points (each with its `${signature}:${n}` key after the signature), keys }
  function chartOf(mint) {
    if (!charts.has(mint)) {
      const c = cache.coins.find((x) => x.mint === mint), g = program?.global;
      const start = g ? Number(g.initialVirtualSolReserves) / 1e9 / (Number(g.initialVirtualTokenReserves) / 10 ** DECIMALS) : 0;
      charts.set(mint, { points: c && start ? [[c.createdAt, start, 'start', 0, '']] : [], keys: new Set() });
    }
    return charts.get(mint);
  }
  function chartTrade(mint, e, at, signature, n) {
    const h = chartOf(mint), key = `${signature}:${n}`, price = pump.tradePrice(e);
    if (!price || h.keys.has(key)) return;
    h.keys.add(key);
    let i = h.points.length;
    while (i && h.points[i - 1][0] > at) i--;
    h.points.splice(i, 0, [at, price, e.side, sol(e.lamports), signature, key]);
    if (h.points.length > CHART_POINTS) for (const x of h.points.splice(0, h.points.length - CHART_POINTS)) h.keys.delete(x[5]);
  }
  /** A listed coin's chart, for /spawn/chart/<mint>.json. */
  function chart(mint) {
    const c = cache.coins.find((x) => x.mint === mint);
    return c ? { mint, symbol: c.symbol, quote: 'SOL', supply: SUPPLY, points: chartOf(mint).points.map((x) => x.slice(0, 5)) } : null;
  }

  /* ---------- trades → the worm and the charts ---------- */

  // the SPAWN coin a trade event is about: by its mint on the curve, by its pool on PumpSwap
  const coinOf = (e) => { const mint = e.pool === 'pump' ? e.mint : cache.byPool.get(e.address); return mint && cache.coins.find((c) => c.mint === mint); };
  /** The trades of SPAWN's coins in one transaction's logs: [{ coin, event, n }], n counting each coin's trades in it. */
  function tradesIn(logs) {
    const n = new Map(), out = [];
    for (const e of pump.eventsFromLogs(logs)) {
      if (e.kind !== 'trade') continue;
      const coin = coinOf(e);
      if (!coin) continue;
      const k = n.get(coin.mint) || 0;
      n.set(coin.mint, k + 1);
      out.push({ coin, e, n: k });
    }
    return out;
  }
  let stream = null, streamKey = '';
  const vaultsOf = (w) => [pump.creatorVault(w), pump.ammCreatorVaultAuthority(w)];
  function startStream() {
    const mentions = owners().flatMap(vaultsOf), key = mentions.join(',');
    if (!key || !opts.ws || (stream && key === streamKey)) return;
    if (stream) stream.stop();   // a new rewards wallet: listen to it too
    streamKey = key;
    stream = logsStream({ url: opts.ws, mentions, logger, WebSocketImpl: opts.WebSocketImpl, onLogs: (signature, logs) => {
      let trades = tradesIn(logs);
      if (!trades.length && pump.eventsFromLogs(logs).some((e) => e.kind === 'trade' && e.pool === 'pump' && owners().includes(e.creator))) {
        // a coin this listing doesn't have yet (just launched): look again, then read it
        fresh(true).then(() => { for (const t of tradesIn(logs)) take(t, signature); }).catch(() => {});
        return;
      }
      for (const t of trades) take(t, signature);
      trades = null;
    } });
    stream.start();
  }
  /** A trade seen live: its chart point, its worm's touch (the worm skips one it has felt), and the site's poke. */
  function take({ coin, e, n }, signature) {
    chartTrade(coin.mint, e, Date.now(), signature, n);
    if (coinWorms) {
      if (!coinWorms.has(coin.mint)) coinWorms.hatch(coin.mint, coin.symbol);
      coinWorms.feel(coin.mint, [{ signature, side: e.side, n }]);
    }
    onTrade({ mint: coin.mint, symbol: coin.symbol, side: e.side, signature, trader: e.trader, sol: sol(e.lamports) });
  }
  /**
   * After a restart (every deploy), the coins' worms feel the trades they missed while the site was down, from the
   * chain, oldest first; they don't poke the site's worm: that moment has passed. Every coin listed gets its chart
   * back the same way. SPAWN's vaults are named by every trade of every coin, so one list of signatures covers them all.
   */
  let caughtUpAt = 0, catching = null;
  const charted = new Set();   // coins whose chart has been read back from the chain
  async function catchUp() {
    const worms = !caughtUpAt && !!coinWorms;   // the worms catch up once, when the site starts
    caughtUpAt ||= Date.now();
    const listed = cache.coins.map((c) => c.mint);
    if (!listed.length) return;
    const sigs = [];
    for (const vault of owners().flatMap(vaultsOf)) {
      let before;
      for (let got = 0; got < 600;) {
        const page = await rpcRetry('getSignaturesForAddress', [vault, { limit: 200, ...(before ? { before } : {}), commitment: 'confirmed' }]);
        for (const x of page) if (!x.err) sigs.push(x);
        got += page.length;
        if (page.length < 200) break;
        before = page.at(-1).signature;
      }
    }
    const order = [...new Map(sigs.map((x) => [x.signature, x])).values()].sort((a, b) => (a.slot || 0) - (b.slot || 0));   // oldest first
    // each worm feels the trades after the last one it felt; all of them when that one is older than these
    const inList = new Set(order.map((x) => x.signature));
    const last = new Map(listed.map((m) => [m, worms ? coinWorms.lastSignature(m) : null]));
    const feeling = new Map(listed.map((m) => [m, worms && (!last.get(m) || !inList.has(last.get(m)))]));
    for (const { signature, blockTime } of order) {
      const l = await pump.fetchLogs({ signature, ...chain }).catch(() => null);
      for (const t of l ? tradesIn(l.logs) : []) {
        chartTrade(t.coin.mint, t.e, blockTime ? blockTime * 1000 : Date.now(), signature, t.n);
        if (feeling.get(t.coin.mint)) {
          if (!coinWorms.has(t.coin.mint)) coinWorms.hatch(t.coin.mint, t.coin.symbol);
          coinWorms.feel(t.coin.mint, [{ signature, side: t.e.side, n: t.n }]);
        }
      }
      if (worms) for (const [m, sig] of last) if (sig === signature) feeling.set(m, true);   // everything after it is new
      await sleep(200);   // gentle on the RPC
    }
    for (const m of listed) charted.add(m);
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

  /** A kept file: a coin's metadata (<12 characters>.json, served at /m/<id>) or a picked picture (<24 hex>.<type>). */
  function metaFile(name) {
    if (!root || !/^([A-Za-z0-9_-]{12}\.json|[0-9a-f]{24}\.(png|jpg|webp|gif))$/.test(name)) return null;
    const f = path.join(root, 'meta', name);
    return fs.existsSync(f) ? f : null;
  }

  return {
    get open() { return canLaunch(); },
    get pricedIn() { return 'SOL'; },
    get owner() { return owner(); },
    status: () => ({ open: canLaunch(), hosting: canHost(), owner: owner() || null, ownerFromEnv: !!opts.owner, owners: owners(), coins: cache.coins.length, vaults: { curve: sol(cache.vaults.curve), amm: sol(cache.vaults.amm) }, rewards: (({ collected, spent, owed }) => ({ collected: sol(collected), spent: sol(spent), owed: sol(owed) }))(rewards()), claims: s.claims.slice(-20), buybacks: s.buybacks.slice(-20), burns: s.burns.slice(-20), burned: s.burns.reduce((n, b) => n + b.amount, 0), stream: !!stream, prices: cache.prices, caughtUpAt }),
    fresh, publicState, quote, swap, confirm, create, created, pending, setOwner, collect, collected, buyback, burnBought, burned, addReaction, metaFile, chart,
    start() { if (owner() || Object.keys(s.coins).length) fresh().catch(() => {}); },
    stop() {
      if (stream) stream.stop();
      stream = null; streamKey = '';
      clearTimeout(saveTimer); saveTimer = null;
      if (file) try { fs.writeFileSync(file, JSON.stringify(s)); } catch { /* disk gone */ }
    },
  };
}

/**
 * Confirmed transactions that mention any of `mentions`, with their logs, from Solana RPC logsSubscribe (one
 * subscription each), with pings and backoff. pump.fun and PumpSwap log their trade events, so the logs are enough.
 */
export function logsStream({ url, mentions, onLogs, logger = console, WebSocketImpl = WebSocket, pongTimeoutMs = 60_000 }) {
  let ws = null, stopped = false, backoff = 1000, timer = null, ping = null;
  const seen = new Set();
  function open() {
    if (stopped) return;
    const sock = ws = new WebSocketImpl(url, { handshakeTimeout: 10_000 });
    let heardAt = Date.now();   // a link can die without closing: one that answers nothing for a minute is dropped and opened again
    sock.on('open', () => {
      heardAt = Date.now();
      mentions.forEach((m, i) => sock.send(JSON.stringify({ jsonrpc: '2.0', id: i + 1, method: 'logsSubscribe', params: [{ mentions: [m] }, { commitment: 'confirmed' }] })));
      ping = setInterval(() => {
        if (Date.now() - heardAt > pongTimeoutMs) { logger.warn('[spawn] stream: no answer for a minute, reconnecting'); sock.terminate(); return; }
        try { sock.ping(); } catch { /* closing */ }
      }, 30_000);
    });
    sock.on('pong', () => { heardAt = Date.now(); });
    sock.on('message', (data) => {
      heardAt = Date.now();
      let m; try { m = JSON.parse(String(data)); } catch { return; }
      if (m.id && m.error) { logger.warn(`[spawn] stream: subscription refused (${m.error.message || m.error.code}), reconnecting`); sock.terminate(); return; }
      if (m.id && m.result != null) backoff = 1000;   // subscribed: the link is good (only then does the wait between tries start over)
      const v = m.method === 'logsNotification' ? m.params?.result?.value : null;
      if (!v || v.err || !v.signature || seen.has(v.signature)) return;
      seen.add(v.signature);
      if (seen.size > 2000) seen.clear();
      try { onLogs(v.signature, v.logs || []); } catch (e) { logger.warn(`[spawn] ${e.message}`); }
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

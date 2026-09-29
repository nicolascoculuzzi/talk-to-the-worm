// SPAWN: the $BRAINWORM launchpad. Anyone can spawn a coin on a Meteora Dynamic Bonding Curve priced in
// $BRAINWORM. Every trade pays a 1% fee in $BRAINWORM: Meteora keeps 20% of it, the coin's creator gets 20% of the
// rest, and the launchpad's share (64% of the fee) is claimed and burned out of $BRAINWORM's supply whenever the owner
// signs a claim and burn. Each buy also pokes the worm at the coin's own spot.
//
// Every coin also hatches its own worm (shared/coinworm.js, kept by server/coinworms.js): a fresh copy of the same
// larva whose first sight is the coin's ticker and which feels every trade of the coin after that.
//
// Buying with SOL is one Jupiter transaction (SOL → $BRAINWORM → coin) when Jupiter finds a route; otherwise it is
// two: SOL → $BRAINWORM through Jupiter, then $BRAINWORM → coin on the coin's own curve (server/dbc.js), which works
// from the coin's first second. Holders of $BRAINWORM can trade on the curve directly, in one. Selling mirrors it.
//
// This module never holds a key and never sends a transaction. It builds unsigned transactions for people's own
// wallets (visitors, creators, the owner), reads the chain and reports trades. The only keys made are the fresh
// addresses of a new coin or config (server/dbc.js), which sign their own slot and are dropped.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import WebSocket from 'ws';
import { rpc } from './solana.js';
import { previewHatch } from './coinworms.js';

export const SOL_MINT = 'So11111111111111111111111111111111111111112';
export const FEE = Object.freeze({ bps: 100, protocolShare: 0.2, creatorShare: 0.2 });
export const SLIPPAGE_BPS = 300;
const QUOTE_TTL_MS = 120_000, REFRESH_MS = 20_000, SCAN_MS = 180_000, STALE_COIN_MS = 3600_000, CLAIM_LOCK_MS = 90_000, STUCK_MS = 600_000;
const MAX_IMAGE = 1_500_000;
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

/**
 * @param {object} o
 * @param {string|null} o.dir       where state lives (LOG_DIR); null keeps it in memory
 * @param {object} o.dbc            server/dbc.js (injected so tests can fake the chain)
 * @param {() => string} o.rootMint $BRAINWORM's mint once it exists ('' before)
 * @param {(text: string) => {ok: boolean, text?: string, message?: string}} o.moderate  the site's chat filter
 * @param {object} o.opts           { rpc, ws, WebSocketImpl, publicUrl, pinataJwt, uploadPinata, jupiterKey }
 * @param {(t: object) => void} o.onTrade  every confirmed trade of a SPAWN coin
 * @param {object} [o.coinWorms]   server/coinworms.js: each coin's own worm
 * @param {object} [o.render]      server/render.js and the wiring D, for pictures drawn by a coin's worm
 */
export function createSpawn({ dir, dbc, rootMint, moderate = (t) => ({ ok: true, text: t }), opts = {}, onTrade = () => {}, coinWorms = null, render = null, D = null, fetchImpl = fetch, logger = console }) {
  const root = dir ? path.join(dir, 'spawn') : null;
  if (root) fs.mkdirSync(path.join(root, 'meta'), { recursive: true });
  const file = root && path.join(root, 'state.json');
  let s = { configs: [], coins: {}, burns: [], day: { key: dayKey(), worm: {} } };
  try { if (file) s = { ...s, ...JSON.parse(fs.readFileSync(file, 'utf8')) }; } catch { /* first run */ }
  let saveTimer = null;
  const save = () => { if (!file || saveTimer) return; saveTimer = setTimeout(() => { saveTimer = null; fs.writeFile(file, JSON.stringify(s), () => {}); }, 500); };
  const chain = { url: opts.rpc, fetchImpl };
  // Jupiter's free API routes only through tokens it trusts as a middle hop; a key (a paid plan) lifts that
  const jupBase = opts.jupiterKey ? 'https://api.jup.ag' : 'https://lite-api.jup.ag';

  const quotes = new Map();   // quoteId -> {legs, at, user, next}: the server keeps each quote, so nobody can swap in a doctored one
  let pendingConfig = null;   // the config transaction last built for the owner, until it confirms
  let claimLockUntil = 0, scannedAt = 0;
  let cache = { at: 0, coins: [], pools: new Map(), byPool: new Map(), prices: {}, waiting: 0, stuck: [] };

  const current = () => s.configs.at(-1) || null;
  const isOpen = () => !!(current() && rootMint());

  /* ---------- reading the chain ---------- */

  const allowedImage = (u) => typeof u === 'string' && (IMAGE_HOSTS.some((h) => u.startsWith(h) && /^[A-Za-z0-9]+$/.test(u.slice(h.length))) || (!!opts.publicUrl && u.startsWith(opts.publicUrl + '/spawn/meta/')));
  // coins spawned on the page were checked then; ones made on the curve some other way are checked here, or not shown
  function shown(mint, p) {
    const own = s.coins[mint];
    if (own) return { name: own.name, symbol: own.symbol, image: allowedImage(own.image) ? own.image : '' };
    const n = moderate(p.name || ''), y = moderate(p.symbol || '');
    return n.ok && y.ok && /^[A-Za-z0-9]{1,10}$/.test(y.text) ? { name: n.text, symbol: y.text.toUpperCase(), image: '' } : null;
  }

  async function refresh() {
    if (!isOpen()) return;
    const cfgs = new Map();
    for (const c of s.configs) { const d = await dbc.fetchConfig({ address: c.address, ...chain }); if (d) cfgs.set(c.address, d); }
    // every pool on SPAWN's configs every few minutes (getProgramAccounts is the call RPC nodes ration), the known ones in between
    let list;
    if (!scannedAt || Date.now() - scannedAt > SCAN_MS) {
      list = [];
      for (const address of cfgs.keys()) list.push(...await dbc.listPools({ config: address, ...chain }));
      scannedAt = Date.now();
    } else list = (await dbc.fetchPools({ addresses: [...cache.pools.values()].map((p) => p.address), ...chain })).filter(Boolean);
    const pools = new Map();
    for (const p of list) if (cfgs.has(p.config)) pools.set(p.baseMint, { ...p, cfg: cfgs.get(p.config), ...dbc.poolPrice(p, cfgs.get(p.config)) });
    let prices = {};
    const graduated = [...pools.values()].filter((p) => p.stage === 'graduated').map((p) => p.baseMint);
    try { prices = await jupPrices([SOL_MINT, rootMint(), ...graduated.slice(0, 45)]); } catch (e) { logger.warn(`[spawn] prices: ${e.message}`); }
    const solUsd = prices[SOL_MINT]?.usdPrice || 0, rootUsd = prices[rootMint()]?.usdPrice || 0;
    const rootSol = solUsd ? rootUsd / solUsd : 0;
    const coins = [], byPool = new Map(), stuck = [];
    let waiting = 0n;
    for (const [mint, p] of pools) {
      byPool.set(p.address, mint);
      waiting += p.partnerQuoteFee;
      const show = shown(mint, p);
      if (p.stage === 'graduating' && p.finishedAt && Date.now() - p.finishedAt * 1000 > STUCK_MS) stuck.push({ mint, symbol: show?.symbol || '', pool: p.address, since: p.finishedAt * 1000 });
      if (!show) continue;
      const priceSol = p.stage === 'graduated' && prices[mint]?.usdPrice && solUsd ? prices[mint].usdPrice / solUsd : p.price * rootSol;
      coins.push({
        mint, pool: p.address, ...show, creator: p.creator, createdAt: (s.coins[mint]?.createdAt) || p.activationPoint * 1000,
        priceRoot: p.price, priceSol, priceUsd: priceSol * solUsd, mcapSol: priceSol * 1e9, progress: p.progress, graduated: p.graduated, stage: p.stage,
        creatorFees: Number(p.creatorQuoteFee) / 1e6,
      });
    }
    // coins spawned on the page that never made it on chain are forgotten after an hour
    for (const [mint, c] of Object.entries(s.coins)) if (!pools.has(mint) && Date.now() - c.createdAt > STALE_COIN_MS) delete s.coins[mint];
    cache = { at: Date.now(), coins, pools, byPool, prices: { solUsd, rootUsd, rootSol }, waiting: Number(waiting) / 1e6, stuck };
    // every coin shown hatches its own worm (a few each refresh, so a first listing of many coins doesn't stall the server)
    if (coinWorms) { let n = 0; for (const c of coins) if (!coinWorms.has(c.mint) && n++ < 10) coinWorms.hatch(c.mint, c.symbol); }
    save();
    startStream();
    if (coinWorms && !caughtUpAt) catchUp().catch((e) => logger.warn(`[spawn] catch-up: ${e.message}`));
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

  function rollDay() { const k = dayKey(); if (s.day.key !== k) { s.day = { key: k, worm: {} }; save(); } }
  function publicState() {
    rollDay();
    const sym = (mint) => cache.coins.find((c) => c.mint === mint)?.symbol;
    const movers = Object.entries(s.day.worm).filter(([mint]) => sym(mint)).map(([mint, w]) => ({ mint, symbol: sym(mint), ...w }))
      .sort((a, b) => b.cells - a.cells || b.pokes - a.pokes).slice(0, 10);
    return {
      open: isOpen(),
      reason: !rootMint() ? 'Opens when $BRAINWORM launches.' : !current() ? 'Opening soon: the launchpad is being set up.' : null,
      root: {
        mint: rootMint() || null, priceSol: cache.prices.rootSol || 0, priceUsd: cache.prices.rootUsd || 0,
        burned: round(s.burns.reduce((n, b) => n + b.amount, 0), 2), waiting: round(cache.waiting, 2),
        burns: s.burns.slice(-5).reverse().map((b) => ({ signature: b.signature, amount: round(b.amount, 2), at: b.at })),
      },
      fee: FEE,
      coins: cache.coins.map((c) => ({ ...c, worm: s.day.worm[c.mint] || { pokes: 0, cells: 0 }, own: coinWorms?.info(c.mint) || null })),
      movers,
      pokesToday: Object.values(s.day.worm).reduce((n, w) => n + w.pokes, 0),
      config: current()?.address || null,
      graduationQuote: current()?.graduationQuote || null,
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

  // $BRAINWORM ↔ coin: on the coin's own curve while it has one (no aggregator needed), through Jupiter once it graduated
  async function coinLeg(p, buy, amountIn) {
    if (p.stage === 'curve') {
      const state = { sqrtPrice: p.sqrtPrice, curve: p.cfg.curve, sqrtStartPrice: p.cfg.sqrtStartPrice, migrationSqrtPrice: p.cfg.migrationSqrtPrice, feeNumerator: p.cfg.feeNumerator };
      const { out } = buy ? dbc.quoteBuy(state, amountIn) : dbc.quoteSell(state, amountIn);
      return { kind: 'curve', pool: p.address, side: buy ? 'buy' : 'sell', amountIn, out, min: (out * BigInt(10_000 - SLIPPAGE_BPS)) / 10_000n };
    }
    return jupLeg(await jupQuote(buy ? rootMint() : p.baseMint, buy ? p.baseMint : rootMint(), amountIn));
  }

  /**
   * A quote: buying (amount in SOL, or in $BRAINWORM with pay 'root') or selling (amount in coins, for SOL or, with
   * pay 'root', for $BRAINWORM). One step, or two when Jupiter has no route through $BRAINWORM yet.
   */
  async function quote({ mint, side, amount, pay }) {
    if (!isOpen()) throw new Error('The launchpad is not open yet.');
    await fresh();
    const p = cache.pools.get(mint || ''), coin = p && cache.coins.find((c) => c.mint === mint);
    if (!B58.test(mint || '') || !coin) throw new Error('Not a SPAWN coin.');
    if (p.stage === 'graduating') throw new Error(`$${coin.symbol} is graduating to its Meteora pool. Trading opens again in a few minutes.`);
    const n = Number(amount), buy = side !== 'sell', viaRoot = pay === 'root';
    if (!(n > 0) || !Number.isFinite(n)) throw new Error('Enter an amount.');
    if (buy && !viaRoot && n > 1000) throw new Error('That is more than this page will route.');
    const input = atoms(n, buy && !viaRoot ? 9 : 6);
    let legs;
    try {
      if (viaRoot) legs = [await coinLeg(p, buy, input)];
      else {
        let direct = null;
        try { direct = await jupQuote(buy ? SOL_MINT : mint, buy ? mint : SOL_MINT, input); } catch (e) { if (!e.noRoute) throw e; }
        if (direct) legs = [jupLeg(direct)];
        else if (buy) { const a = jupLeg(await jupQuote(SOL_MINT, rootMint(), input)); legs = [a, await coinLeg(p, true, a.min)]; }
        else { const b = await coinLeg(p, false, input); legs = [b, jupLeg(await jupQuote(rootMint(), SOL_MINT, b.min))]; }
      }
    } catch (e) {
      if (/bigger than/.test(e.message)) throw new Error(`That is more than $${coin.symbol}'s curve has left.`);
      throw e.noRoute ? new Error('No route for that yet. Try paying with $BRAINWORM, or again in a minute.') : e;
    }
    const name = (m) => (m === SOL_MINT ? 'SOL' : m === rootMint() ? '$BRAINWORM' : m === mint ? '$' + coin.symbol : m.slice(0, 4) + '…');
    const route = [buy ? (viaRoot ? '$BRAINWORM' : 'SOL') : '$' + coin.symbol];
    for (const l of legs) {
      if (l.kind === 'curve') route.push(l.side === 'buy' ? '$' + coin.symbol : '$BRAINWORM');
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
      const j = await jup('/swap/v1/swap', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ quoteResponse: leg.res, userPublicKey: user, wrapAndUnwrapSol: true, dynamicComputeUnitLimit: true, prioritizationFeeLamports: { priorityLevelWithMaxLamports: { maxLamports: 1_000_000, priorityLevel: 'high' } } }),
      });
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

  async function uploadMeta({ image, type, name, symbol }) {
    const site = opts.publicUrl ? `${opts.publicUrl}/spawn` : '';
    const description = `$${symbol} is a coin on SPAWN, priced in $BRAINWORM. Every trade burns some $BRAINWORM, and every buy pokes a live simulation of a real worm larva's wiring.${site ? ' ' + site : ''}`;
    if (opts.pinataJwt && opts.uploadPinata) {
      const r = await opts.uploadPinata({ image, filename: `${symbol}.${IMAGE_TYPES[type]}`, name, symbol, description, website: site, createdOn: site, jwt: opts.pinataJwt, fetchImpl });
      return { uri: r.metadataUri, image: r.metadata?.image || '' };
    }
    if (!root || !opts.publicUrl) throw new Error('Picture hosting is not set up yet (PINATA_JWT, or LOG_DIR and PUBLIC_URL).');
    const id = crypto.createHash('sha256').update(image).digest('hex').slice(0, 24);
    fs.writeFileSync(path.join(root, 'meta', `${id}.${IMAGE_TYPES[type]}`), image);
    const imageUrl = `${opts.publicUrl}/spawn/meta/${id}.${IMAGE_TYPES[type]}`;
    fs.writeFileSync(path.join(root, 'meta', `${id}.json`), JSON.stringify({ name, symbol, description, image: imageUrl, website: site }));
    return { uri: `${opts.publicUrl}/spawn/meta/${id}.json`, image: imageUrl };
  }

  /** The create transaction for the creator's wallet (the coin's fresh mint key already signed in it). */
  async function create({ creator, name, symbol, image, firstBuy }) {
    if (!isOpen()) throw new Error('The launchpad is not open yet.');
    if (!B58.test(creator || '')) throw new Error('Connect a wallet first.');
    const nm = moderate(String(name || '').trim()), sy = moderate(String(symbol || '').trim().toUpperCase());
    if (!nm.ok) throw new Error(nm.message || 'That name is not allowed.');
    if (!sy.ok) throw new Error(sy.message || 'That ticker is not allowed.');
    if (!nm.text || Buffer.byteLength(nm.text) > 32) throw new Error('Names are 1 to 32 characters.');
    if (!/^[A-Z0-9]{1,10}$/.test(sy.text)) throw new Error('Tickers are 1 to 10 letters or digits.');
    if (sy.text === 'BRAINWORM') throw new Error('That ticker is taken.');
    let m, bytes;
    if (image === 'worm') {
      // the picture its worm will see first: a fresh worm shown the ticker, drawn from the real wiring
      if (!render || !D) throw new Error('Pictures from the worm are not available here.');
      bytes = previewHatch({ D, render, ticker: sy.text, width: 512 }).png;
      m = [null, 'image/png'];
    } else {
      m = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/=]+)$/.exec(String(image || ''));
      if (!m) throw new Error('Add a PNG, JPG, WEBP or GIF picture, or use its worm\'s first sight.');
      bytes = Buffer.from(m[2], 'base64');
      if (bytes.length > MAX_IMAGE) throw new Error('That picture is too big (1.5 MB at most).');
      if (!MAGIC[m[1]](bytes)) throw new Error('That file is not the picture it says it is.');
    }
    const buy = Number(firstBuy || 0);
    if (!(buy >= 0) || !Number.isFinite(buy)) throw new Error('The first buy is a number of $BRAINWORM.');
    const meta = await uploadMeta({ image: bytes, type: m[1], name: nm.text, symbol: sy.text });
    const built = await dbc.buildCreatePool({ config: current().address, creator, name: nm.text, symbol: sy.text, uri: meta.uri, firstBuyQuote: buy, ...chain });
    s.coins[built.mint] = { name: nm.text, symbol: sy.text, image: meta.image, uri: meta.uri, creator, createdAt: Date.now() };
    save();
    return { tx: built.tx, mint: built.mint, firstBuy: built.firstBuy };
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
   * position's share of its pool's fees. One transaction for each; the page signs them in turn.
   */
  async function claimCreator({ mint, creator }) {
    await fresh();
    const p = cache.pools.get(mint || '');
    if (!p) throw new Error('Not a SPAWN coin.');
    if (p.creator !== creator) throw new Error('Only the wallet that spawned this coin can claim its fees.');
    const txs = [];
    if (p.creatorQuoteFee > 0n) txs.push((await dbc.buildClaimCreator({ pool: p, creator, ...chain })).tx);
    if (p.stage === 'graduated') for (const t of await dbc.buildClaimGraduated({ coins: [{ baseMint: p.baseMint, quoteMint: p.cfg.quoteMint, migrationFeeOption: p.cfg.migrationFeeOption }], owner: creator, ...chain })) txs.push(t.tx);
    if (!txs.length) throw new Error('Nothing to claim yet.');
    return { txs, amount: Number(p.creatorQuoteFee) / 1e6 };
  }

  /* ---------- the owner: configs, claim and burn ---------- */

  /** $BRAINWORM's price now, for choosing a config's market caps. */
  async function rootPrice() {
    if (!rootMint()) throw new Error('$BRAINWORM has not launched yet.');
    const p = await jupPrices([SOL_MINT, rootMint()]);
    const solUsd = p[SOL_MINT]?.usdPrice || 0, rootUsd = p[rootMint()]?.usdPrice || 0;
    return { solUsd, rootUsd, rootSol: solUsd ? rootUsd / solUsd : 0 };
  }
  /**
   * A new config at today's $BRAINWORM price, for the owner's wallet. New coins use the newest config; coins already
   * made keep theirs. Market caps are in $BRAINWORM.
   */
  async function buildConfig({ partner, startMcap, graduationMcap }) {
    if (!rootMint()) throw new Error('$BRAINWORM has to exist first: every coin here is priced in it.');
    if (!B58.test(partner || '')) throw new Error('Connect the owner wallet first.');
    if (current() && current().partner !== partner) throw new Error(`Use the same wallet as before (${current().partner}): it claims and burns every config's fees.`);
    const built = await dbc.buildCreateConfig({ partner, quoteMint: rootMint(), startMcap: Number(startMcap), graduationMcap: Number(graduationMcap), creatorShare: FEE.creatorShare * 100, ...chain });
    pendingConfig = { address: built.address, partner, curve: built.curve, at: Date.now() };
    return built;
  }
  async function confirmConfig({ signature }) {
    if (!pendingConfig) throw new Error('No config was prepared.');
    if (!SIG.test(signature || '')) throw new Error('Bad signature.');
    const c = await dbc.fetchConfig({ address: pendingConfig.address, ...chain });
    if (!c) return { ok: false, error: 'Not on chain yet.' };
    if (c.quoteMint !== rootMint() || c.feeClaimer !== pendingConfig.partner || c.collectFeeMode !== 0 || c.creatorShare !== FEE.creatorShare * 100) throw new Error('That config is not the one SPAWN built.');
    s.configs.push({ address: pendingConfig.address, partner: pendingConfig.partner, signature, createdAt: Date.now(), ...pendingConfig.curve });
    pendingConfig = null;
    save();
    await fresh(true, true);
    return { ok: true, config: current() };
  }
  /**
   * Claim-and-burn transactions for every pool with fees waiting, for the owner's wallet (three pools each). Each
   * claim is capped at the fees read now and the burn is their exact sum, so a second claim of the same fees before
   * the first lands would come up short and burn the owner's own $BRAINWORM: new ones wait until the last ones
   * have landed or expired.
   */
  async function buildClaimAndBurn({ feeClaimer, min = 1 }) {
    if (!current()) throw new Error('The launchpad is not set up.');
    if (feeClaimer !== current().partner) throw new Error(`Connect the fee claimer wallet (${current().partner}).`);
    if (Date.now() < claimLockUntil) throw new Error('The last claim and burn may still land. Try again in a minute.');
    await fresh(true, true);
    const out = [];
    for (const cfg of s.configs) {
      const pools = [...cache.pools.values()].filter((p) => p.config === cfg.address && Number(p.partnerQuoteFee) / 1e6 >= min);
      out.push(...await dbc.buildClaimAndBurn({ pools, feeClaimer, ...chain }));
    }
    if (out.length) claimLockUntil = Date.now() + CLAIM_LOCK_MS;
    return out;
  }
  /**
   * After graduation a coin trades in its DAMM v2 pool, whose fees (in $BRAINWORM only, on SPAWN's option) go to its
   * two locked positions: the creator's and the fee claimer's. These claim the fee claimer's share of every graduated
   * coin; what each claim paid is known once it has landed, and burnClaimed builds the burn for exactly that.
   */
  async function buildClaimGraduated({ feeClaimer }) {
    if (!current()) throw new Error('The launchpad is not set up.');
    if (feeClaimer !== current().partner) throw new Error(`Connect the fee claimer wallet (${current().partner}).`);
    await fresh(true, true);
    const coins = [...cache.pools.values()].filter((p) => p.stage === 'graduated').map((p) => ({ baseMint: p.baseMint, quoteMint: p.cfg.quoteMint, migrationFeeOption: p.cfg.migrationFeeOption }));
    return coins.length ? dbc.buildClaimGraduated({ coins, owner: feeClaimer, ...chain }) : [];
  }
  async function burnClaimed({ signature }) {
    if (!current()) throw new Error('The launchpad is not set up.');
    if (!SIG.test(signature || '')) throw new Error('Bad signature.');
    return (await dbc.buildBurnReceived({ signature, owner: current().partner, keep: [rootMint()], ...chain })) || { tx: null, burns: [] };
  }
  /** Record a claim and burn: read from the chain how much $BRAINWORM its fee claimer burned in it. */
  async function burned({ signature }) {
    if (!SIG.test(signature || '')) throw new Error('Bad signature.');
    if (s.burns.some((b) => b.signature === signature)) return { ok: true };
    const tx = await rpc('getTransaction', [signature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 1, commitment: 'confirmed' }], chain);
    if (!tx) return { ok: false, error: 'Not confirmed yet.' };
    if (tx.meta?.err) return { ok: false, error: 'That transaction failed on chain.' };
    const claimers = new Set(s.configs.map((c) => c.partner));
    let amount = 0;
    for (const ix of tx.transaction?.message?.instructions || []) {
      const x = ix.parsed;
      if (!x || !/^spl-token(-2022)?$/.test(ix.program) || !['burn', 'burnChecked'].includes(x.type) || x.info?.mint !== rootMint() || !claimers.has(x.info?.authority)) continue;
      amount += x.type === 'burnChecked' ? Number(x.info.tokenAmount.amount) / 10 ** x.info.tokenAmount.decimals : Number(x.info.amount) / 1e6;
    }
    if (!(amount > 0)) return { ok: false, error: 'That transaction burned no $BRAINWORM from the fee claimer.' };
    s.burns.push({ signature, amount, at: Date.now() });
    save();
    return { ok: true, amount };
  }

  /* ---------- trades → the worm ---------- */

  let stream = null, queue = [], working = false;
  function startStream() {
    if (stream || !s.configs.length || !opts.ws) return;
    stream = logsStream({ url: opts.ws, mentions: s.configs.map((c) => c.address), logger, WebSocketImpl: opts.WebSocketImpl, onSignature: (sig) => {
      queue.push({ sig, tries: 0 });
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
          const coin = cache.coins.find((c) => c.mint === mint);
          if (!coin) continue;
          const quote = Number(t.quote) / 1e6;
          if (coinWorms) {
            if (!coinWorms.has(mint)) coinWorms.hatch(mint, coin.symbol);
            coinWorms.feel(mint, [{ signature: job.sig, side: t.side, n: n.get(mint) || 0 }]);
            n.set(mint, (n.get(mint) || 0) + 1);
          }
          onTrade({ mint, symbol: coin.symbol, side: t.side, signature: job.sig, trader: t.trader, quote, sol: quote * (cache.prices.rootSol || 0) });
        }
        await new Promise((r) => setTimeout(r, 400));   // gentle on the RPC
      }
    } finally { working = false; }
  }
  /**
   * After a restart (every deploy), each coin's worm feels the trades it missed while the site was down, from the
   * chain, oldest first. They don't poke the site's worm: that moment has passed.
   */
  let caughtUpAt = 0;
  async function catchUp() {
    caughtUpAt = Date.now();
    const configs = s.configs.map((c) => c.address);
    for (const c of cache.coins) {
      if (!coinWorms.has(c.mint)) continue;
      const last = coinWorms.lastSignature(c.mint), sigs = [];
      let before;
      while (sigs.length < 1000) {
        const page = await rpcRetry('getSignaturesForAddress', [c.pool, { limit: 100, ...(before ? { before } : {}), ...(last ? { until: last } : {}), commitment: 'confirmed' }]);
        for (const x of page) if (!x.err) sigs.push(x.signature);
        if (page.length < 100) break;
        before = page.at(-1).signature;
      }
      for (const sig of sigs.reverse()) {
        const trades = await dbc.fetchTrades({ signature: sig, configs, ...chain }).catch(() => null);
        let k = 0;
        for (const t of trades || []) if (t.pool === c.pool) coinWorms.feel(c.mint, [{ signature: sig, side: t.side, n: k++ }]);
        await new Promise((r) => setTimeout(r, 250));   // gentle on the RPC
      }
    }
  }
  async function rpcRetry(method, params) {
    for (let k = 0; ; k++) {
      try { return await rpc(method, params, chain); } catch (e) { if (k >= 3 || !/HTTP (429|5\d\d)|too many/i.test(e.message)) throw e; await new Promise((r) => setTimeout(r, 500 * 2 ** k)); }
    }
  }

  /** The server tells us how many cells a coin's poke lit (its summary's peak). */
  function addReaction(mint, cells) {
    rollDay();
    const w = s.day.worm[mint] || (s.day.worm[mint] = { pokes: 0, cells: 0 });
    w.pokes++; w.cells += cells || 0; save();
  }

  function metaFile(name) {
    if (!root || !/^[0-9a-f]{24}\.(json|png|jpg|webp|gif)$/.test(name)) return null;
    const f = path.join(root, 'meta', name);
    return fs.existsSync(f) ? f : null;
  }

  return {
    get open() { return isOpen(); },
    status: () => ({ open: isOpen(), configs: s.configs, pending: pendingConfig, burns: s.burns.slice(-20), burned: s.burns.reduce((n, b) => n + b.amount, 0), waiting: cache.waiting, stuck: cache.stuck, coins: cache.coins.length, stream: !!stream, prices: cache.prices, caughtUpAt }),
    fresh, publicState, quote, swap, confirm, create, created, claimCreator, rootPrice, buildConfig, confirmConfig, buildClaimAndBurn, buildClaimGraduated, burnClaimed, burned, addReaction, metaFile,
    start() { if (isOpen()) fresh().catch(() => {}); },
    stop() {
      if (stream) stream.stop();
      stream = null; queue = [];
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

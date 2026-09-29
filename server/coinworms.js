// SPAWN's coin worms, kept by the server (shared/coinworm.js says what a coin's worm is). One record per coin in
// <LOG_DIR>/spawn/worms/<mint>.json: its ticker, every trade it has felt (signature and side, in order), what that
// did (stats), the hash of its state and the state itself, so a new trade needs no rebuild. The busiest few worms
// stay in memory; the rest are restored from their record when a trade comes. Anyone can rebuild a coin's worm from
// /spawn/worm/<mint>.json and check the hash; the page does it in the browser.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { WormCore } from '../shared/worm.js';
import { hatch, feel, touchSides, emptyStats, tally, COINWORM_VERSION } from '../shared/coinworm.js';
import { stateString } from '../shared/replay.js';
import { encodeSnapshot, decodeSnapshot } from '../shared/state.js';

const MINT = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/, TICKER = /^[A-Z0-9]{1,10}$/;
const commas = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
const q8 = (act) => (act ? Buffer.from(Uint8Array.from(act, (v) => Math.max(0, Math.min(255, Math.round(v * 255))))).toString('base64') : null);
const unq8 = (b64) => (b64 ? new Uint8Array(Buffer.from(b64, 'base64')) : null);

/**
 * @param {object} o
 * @param {string|null} o.dir   LOG_DIR (null keeps everything in memory)
 * @param {object} o.D          the wiring with transmitters
 * @param {object} o.render     server/render.js
 * @param {number} [o.live=24]  worms kept in memory
 */
export function createCoinWorms({ dir, D, render, logger = console, live = 24 }) {
  const root = dir ? path.join(dir, 'spawn', 'worms') : null;
  if (root) fs.mkdirSync(root, { recursive: true });
  const recs = new Map();          // mint -> record (with its encoded state)
  const worms = new Map();         // mint -> WormCore, least recently used first
  const seen = new Map();          // mint -> Set of `${signature}:${n}` already felt
  const pics = new Map();          // `${mint}:${which}:${trades}` -> PNG
  const dirty = new Set();
  let saveTimer = null, sides = null;
  const sha = (w) => crypto.createHash('sha256').update(stateString(w)).digest('hex');

  if (root) {
    for (const f of fs.readdirSync(root)) {
      if (!/\.json$/.test(f)) continue;
      try { const r = JSON.parse(fs.readFileSync(path.join(root, f), 'utf8')); if (r.v === COINWORM_VERSION && MINT.test(r.mint)) recs.set(r.mint, r); } catch { /* a torn write: it hatches again */ }
    }
  }
  function flush() {
    clearTimeout(saveTimer); saveTimer = null;
    if (!root) { dirty.clear(); return; }
    for (const mint of dirty) try { fs.writeFileSync(path.join(root, mint + '.json'), JSON.stringify(recs.get(mint))); } catch (e) { logger.warn(`[coinworms] ${e.message}`); }
    dirty.clear();
  }
  const save = (mint) => { dirty.add(mint); if (!saveTimer) saveTimer = setTimeout(flush, 1000); };

  function use(mint, worm) {
    worms.delete(mint); worms.set(mint, worm);
    while (worms.size > live) worms.delete(worms.keys().next().value);
    return worm;
  }
  function wormOf(mint) {
    const w = worms.get(mint);
    if (w) return use(mint, w);
    const r = recs.get(mint);
    return r ? use(mint, new WormCore(D).restore(decodeSnapshot(r.state))) : null;
  }
  function seenOf(mint) {
    if (!seen.has(mint)) {
      const s = new Set(), n = new Map();
      for (const [sig] of recs.get(mint).trades) { const k = n.get(sig) || 0; n.set(sig, k + 1); s.add(`${sig}:${k}`); }
      seen.set(mint, s);
    }
    return seen.get(mint);
  }

  /** Hatch a coin's worm if it has none: a fresh larva shown "$TICKER". */
  function hatchCoin(mint, ticker) {
    if (recs.has(mint)) return false;
    if (!MINT.test(mint) || !TICKER.test(ticker)) return false;
    const h = hatch(D, ticker, { keepPeak: true }), stats = emptyStats(h.peak);
    stats.swim = Math.round(h.swim * 10) / 10;
    recs.set(mint, { v: COINWORM_VERSION, mint, ticker, trades: [], stats, sha: sha(h.worm), birthAct: q8(h.act), lastAct: null, hatchedAt: Date.now(), state: encodeSnapshot(h.worm.snapshot()) });
    use(mint, h.worm);
    save(mint);
    return true;
  }

  /**
   * The coin's trades, as they come: [{ signature, side, n }] where n counts swaps on this coin within the same
   * transaction (0 for the first). Each is felt once. Returns how many were new.
   */
  function feelTrades(mint, trades) {
    const r = recs.get(mint);
    if (!r) return 0;
    const worm = wormOf(mint), s = seenOf(mint);
    sides ||= touchSides(worm);
    let added = 0;
    for (const t of trades) {
      const key = `${t.signature}:${t.n || 0}`;
      if (s.has(key) || !/^[1-9A-HJ-NP-Za-km-z]{64,90}$/.test(t.signature)) continue;
      const out = feel(worm, t, sides, { keepPeak: true });
      tally(r.stats, t.side, out);
      r.trades.push([t.signature, t.side === 'sell' ? 'sell' : 'buy']);
      if (out.act) r.lastAct = q8(out.act);
      s.add(key); added++;
    }
    if (added) { r.sha = sha(worm); r.state = encodeSnapshot(worm.snapshot()); save(mint); }
    return added;
  }

  /** The last signature a coin's worm felt (where catching up starts). */
  const lastSignature = (mint) => recs.get(mint)?.trades.at(-1)?.[0] || null;

  /** What anyone needs to rebuild it: ticker and trades in order, and what the server got. */
  function publicRecord(mint) {
    const r = recs.get(mint);
    return r ? { v: r.v, mint, ticker: r.ticker, trades: r.trades.map(([signature, side]) => ({ signature, side })), stats: r.stats, sha: r.sha, hatchedAt: r.hatchedAt } : null;
  }
  const info = (mint) => { const r = recs.get(mint); return r ? { ...r.stats, sha: r.sha } : null; };

  /** Its first sight ('birth') or its latest trade ('now') as a PNG, drawn by server/render.js and kept. */
  function portrait(mint, which = 'now') {
    const r = recs.get(mint);
    if (!r) return null;
    const act = which === 'birth' ? r.birthAct : r.lastAct || r.birthAct;
    const key = `${mint}:${which}:${which === 'birth' ? 0 : r.trades.length}`;
    if (pics.has(key)) return pics.get(key);
    const cells = unq8(act);
    const png = render.renderActivityPNG({
      D, act: cells, layout: 'square', width: 384, title: ['$' + r.ticker], titleColors: ['amber'],
      lines: [which === 'birth' ? `ITS FIRST SIGHT: ${commas(r.stats.birth)} CELLS FIRING` : r.trades.length ? `AFTER ${commas(r.trades.length)} TRADES` : 'NO TRADES YET'],
      footnote: 'A COIN\'S OWN WORM ON SPAWN',
    });
    for (const k of pics.keys()) if (k.startsWith(`${mint}:${which}:`)) pics.delete(k);
    pics.set(key, png);
    if (pics.size > 200) pics.delete(pics.keys().next().value);
    return png;
  }

  /** Its link preview (1200x630): the coin's ticker next to its worm at its latest trade (or its first sight), kept. */
  function sharePicture(mint) {
    const r = recs.get(mint);
    if (!r) return null;
    const key = `${mint}:og:${r.trades.length}`;
    if (pics.has(key)) return pics.get(key);
    const png = render.renderActivityPNG({
      D, act: unq8(r.lastAct || r.birthAct), layout: 'og', badge: 'SPAWN', title: ['$' + r.ticker], titleColors: ['amber'],
      lines: ['IT HATCHED ITS OWN WORM.', r.trades.length ? `IT HAS FELT ${commas(r.trades.length)} TRADES.` : `ITS FIRST SIGHT: ${commas(r.stats.birth)} CELLS FIRING.`],
      footnote: 'A COIN ON SPAWN, THE BRAINWORM LAUNCHPAD',
    });
    for (const k of pics.keys()) if (k.startsWith(`${mint}:og:`)) pics.delete(k);
    pics.set(key, png);
    if (pics.size > 200) pics.delete(pics.keys().next().value);
    return png;
  }

  return { hatch: hatchCoin, feel: feelTrades, has: (mint) => recs.has(mint), info, lastSignature, publicRecord, portrait, sharePicture, mints: () => [...recs.keys()], stop: flush };
}

/** What a fresh worm makes of a ticker, for the spawn form's preview and a coin's picture: { peak, png }. */
export function previewHatch({ D, render, ticker, width = 384 }) {
  const h = hatch(D, ticker, { keepPeak: true });
  return {
    peak: h.peak,
    png: render.renderActivityPNG({ D, act: h.act, layout: 'square', width, title: ['$' + ticker], titleColors: ['amber'], lines: [`ITS FIRST SIGHT: ${commas(h.peak)} CELLS FIRING`], footnote: 'A COIN\'S OWN WORM ON SPAWN' }),
  };
}

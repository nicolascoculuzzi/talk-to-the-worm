// A coin's own worm on SPAWN. Every coin hatches a fresh copy of the same larva (the wiring and model the site
// runs, nothing added). Its first sight is the coin's ticker, shown to its eyes the way a message is. After that it
// feels its coin's trades and nothing else: a buy touches its head end and a sell its tail end, three touch cells
// picked from the trade's transaction signature (the same mapping the site's worm uses for $BRAINWORM's trades), and
// each trade then runs STEPS_PER_TRADE steps of its time. Between trades its time stands still.
//
// So a coin's worm is a pure function of its ticker and its list of trades. Anyone can rebuild it from that list
// and compare the state hash. The worm doesn't know what a coin is; the mapping is ours, and it's all here.
// Runs unchanged in Node and in the browser: deterministic, no Math.random, Date, timers or I/O.
import { WormCore } from './worm.js';
import { UM_PER_UNIT } from './body.js';

export const COINWORM_VERSION = 1;
export const BIRTH_MAX_STEPS = 3000;   // the longest ticker has long passed its eyes by then
export const BIRTH_TAIL = 60;          // steps after the ticker has passed (2 s)
export const STEPS_PER_TRADE = 60;     // what each trade runs (2 s of its time)
const HEAD = ['episphere', 'segment_0', 'segment_1'], TAIL = ['segment_2', 'segment_3', 'pygidium'];

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
/** A base58 string's bytes (a Solana signature is 64). */
export function b58bytes(s) {
  let n = 0n;
  for (const c of s) { const d = B58.indexOf(c); if (d < 0) throw new Error('not base58'); n = n * 58n + BigInt(d); }
  const out = [];
  while (n > 0n) { out.unshift(Number(n & 255n)); n >>= 8n; }
  for (const c of s) { if (c !== '1') break; out.unshift(0); }
  return out;
}

/** The touch cells at the head end and at the tail end. */
export function touchSides(worm) {
  const seg = (i) => worm.D.segs[worm.D.n[i][3]];
  return { head: worm.roles.touch.filter((i) => HEAD.includes(seg(i))), tail: worm.roles.touch.filter((i) => TAIL.includes(seg(i))) };
}

/** Three distinct cells of `pool`, picked in turn by `bytes`. */
export function pick(pool, bytes, n = 3) {
  const cells = [];
  for (let k = 0; cells.length < n && k < bytes.length; k++) { const c = pool[bytes[k] % pool.length]; if (!cells.includes(c)) cells.push(c); }
  return cells;
}

const readout = () => ({ peak: 0, peakStep: 0, act: null });
function step(worm, r, keep) {
  worm.tick();
  if (worm.last.nAct > r.peak) { r.peak = worm.last.nAct; r.peakStep = worm.step; if (keep) r.act = Float32Array.from(worm.sim.r); }
}

/**
 * A new coin's worm: a fresh larva shown "$TICKER". Returns { worm, peak (most cells firing at once), swim (µm),
 * act (the activity at the peak, when keepPeak) }.
 */
export function hatch(D, ticker, { keepPeak = false } = {}) {
  const worm = new WormCore(D), r = readout(), dist0 = worm.body.state.dist;
  worm.say('birth', '$' + ticker, { by: 'birth' });
  for (let k = 0; k < BIRTH_MAX_STEPS && (worm.current || worm.queue.length); k++) step(worm, r, keepPeak);
  for (let k = 0; k < BIRTH_TAIL; k++) step(worm, r, keepPeak);
  return { worm, peak: r.peak, swim: (worm.body.state.dist - dist0) * UM_PER_UNIT, act: r.act };
}

/** One trade felt: { signature, side: 'buy'|'sell' }. Returns { cells, peak, swim (µm), act (when keepPeak) }. */
export function feel(worm, trade, sides = touchSides(worm), { keepPeak = false } = {}) {
  const cells = pick(trade.side === 'sell' ? sides.tail : sides.head, b58bytes(trade.signature));
  const r = readout(), dist0 = worm.body.state.dist;
  worm.poke(trade.signature.slice(0, 16), cells, { by: trade.side === 'sell' ? 'sell' : 'buy' });
  for (let k = 0; k < STEPS_PER_TRADE; k++) step(worm, r, keepPeak);
  return { cells, peak: r.peak, swim: (worm.body.state.dist - dist0) * UM_PER_UNIT, act: r.act };
}

/** What a coin's worm has been through, kept alongside it. */
export const emptyStats = (birth) => ({ birth, trades: 0, buys: 0, sells: 0, cells: 0, best: 0, swim: 0 });
export function tally(stats, side, r) {
  stats.trades++; stats[side === 'sell' ? 'sells' : 'buys']++;
  stats.cells += r.peak; stats.best = Math.max(stats.best, r.peak); stats.swim = Math.round((stats.swim + r.swim) * 10) / 10;
  return stats;
}

/**
 * Rebuild a coin's worm from its ticker and trades, in order. onProgress(done, total) is called every 50 trades.
 * Returns { worm, stats }.
 */
export function rebuild(D, ticker, trades, onProgress = () => {}) {
  const h = hatch(D, ticker), sides = touchSides(h.worm), stats = emptyStats(h.peak);
  stats.swim = Math.round(h.swim * 10) / 10;
  trades.forEach((t, i) => {
    tally(stats, t.side, feel(h.worm, t, sides));
    if (i % 50 === 49) onProgress(i + 1, trades.length);
  });
  return { worm: h.worm, stats };
}

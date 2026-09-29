// A coin's own worm, in the browser, from its public record (its ticker and every trade it felt, in order):
//  - check: rebuild it and hash the result, to compare with the hash the server published;
//  - frames: its first sight and its latest trade again, step by step, to watch them.
// Nothing is trusted but the wiring.
import { rebuild, touchSides, pick, b58bytes, BIRTH_MAX_STEPS, BIRTH_TAIL, STEPS_PER_TRADE } from '/shared/coinworm.js';
import { WormCore } from '/shared/worm.js';
import { stateString } from '/shared/replay.js';
import { withTransmitters } from '/shared/data.js';

const enc = new TextEncoder();
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
const sha256 = async (s) => hex(await crypto.subtle.digest('SHA-256', enc.encode(s)));
let D = null;

onmessage = async (e) => {
  const { id, mint, t = 'check' } = e.data;
  try {
    if (!D) {
      const [w, tx] = await Promise.all([fetch('/data/wiring.json').then((r) => r.json()), fetch('/data/transmitters.json').then((r) => r.json())]);
      D = withTransmitters(w, tx);
    }
    const rec = await fetch(`/spawn/worm/${mint}.json`, { cache: 'no-store' }).then((r) => { if (!r.ok) throw new Error('No worm for that coin yet.'); return r.json(); });
    const progress = (done, total) => postMessage({ id, t: 'progress', done, total });
    if (t === 'frames') return postFrames(id, rec, progress);
    progress(0, rec.trades.length);
    const { worm, stats } = rebuild(D, rec.ticker, rec.trades, progress);
    const mine = await sha256(stateString(worm));
    postMessage({ id, t: 'done', ok: mine === rec.sha, mine, theirs: rec.sha, trades: rec.trades.length, stats });
  } catch (err) { postMessage({ id, t: 'error', message: err.message }); }
};

// Every step of its first sight (what hatch() runs) and of its latest trade (what feel() runs, after every trade
// before it), each cell's activity as 0..255.
function postFrames(id, rec, progress) {
  const N = D.n.length, frames = [];
  const grab = (worm) => { const f = new Uint8Array(N), r = worm.sim.r; for (let i = 0; i < N; i++) f[i] = Math.max(0, Math.min(255, Math.round(r[i] * 255))); frames.push(f); };
  const w = new WormCore(D);
  w.say('birth', '$' + rec.ticker, { by: 'birth' });
  for (let k = 0; k < BIRTH_MAX_STEPS && (w.current || w.queue.length); k++) { w.tick(); grab(w); }
  for (let k = 0; k < BIRTH_TAIL; k++) { w.tick(); grab(w); }
  const birth = frames.length;
  let last = null;
  if (rec.trades.length) {
    progress(0, rec.trades.length);
    const { worm } = rebuild(D, rec.ticker, rec.trades.slice(0, -1), progress);
    const t = rec.trades.at(-1), sides = touchSides(worm), side = t.side === 'sell' ? 'sell' : 'buy';
    worm.poke(t.signature.slice(0, 16), pick(side === 'sell' ? sides.tail : sides.head, b58bytes(t.signature)), { by: side });
    for (let k = 0; k < STEPS_PER_TRADE; k++) { worm.tick(); grab(worm); }
    last = { side, signature: t.signature, trades: rec.trades.length };
  }
  const buf = new Uint8Array(frames.length * N);
  frames.forEach((f, i) => buf.set(f, i * N));
  postMessage({ id, t: 'frames', ticker: rec.ticker, n: N, count: frames.length, birth, last, buf }, [buf.buffer]);
}

// Rebuilds a coin's own worm in the browser from its public record (its ticker and every trade it felt, in order)
// and hashes the result, to compare with the hash the server published. Nothing is trusted but the wiring.
import { rebuild } from '/shared/coinworm.js';
import { stateString } from '/shared/replay.js';
import { withTransmitters } from '/shared/data.js';

const enc = new TextEncoder();
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
const sha256 = async (s) => hex(await crypto.subtle.digest('SHA-256', enc.encode(s)));
let D = null;

onmessage = async (e) => {
  const { id, mint } = e.data;
  try {
    if (!D) {
      const [w, t] = await Promise.all([fetch('/data/wiring.json').then((r) => r.json()), fetch('/data/transmitters.json').then((r) => r.json())]);
      D = withTransmitters(w, t);
    }
    const rec = await fetch(`/spawn/worm/${mint}.json`, { cache: 'no-store' }).then((r) => { if (!r.ok) throw new Error('No worm for that coin yet.'); return r.json(); });
    postMessage({ id, t: 'progress', done: 0, total: rec.trades.length });
    const { worm, stats } = rebuild(D, rec.ticker, rec.trades, (done, total) => postMessage({ id, t: 'progress', done, total }));
    const mine = await sha256(stateString(worm));
    postMessage({ id, t: 'done', ok: mine === rec.sha, mine, theirs: rec.sha, trades: rec.trades.length, stats });
  } catch (err) { postMessage({ id, t: 'error', message: err.message }); }
};

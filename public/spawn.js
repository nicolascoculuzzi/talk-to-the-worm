// SPAWN: the launchpad page. Coins are pump.fun coins: they trade in SOL on their pump.fun curve, and through Jupiter on
// PumpSwap once they have graduated. The visitor's own wallet signs every transaction; the server only builds them.
import { pixelWordmark } from '/pixel.js';
import { connect, connected, signAndSend, short, noWallet } from '/wallet.js';
import { mountLaunchForm, openInWallet } from '/launchform.js';
import { coinCard, coinPicture, el, fmt, compact, sol, usd } from '/coincard.js';
import { create2DRenderer } from '/render2d.js';

const $ = (id) => document.getElementById(id);
const api = async (path, body) => {
  const r = await fetch(path, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {});
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) throw new Error(j.error || `HTTP ${r.status}`);
  return j;
};

$('spmark').append(pixelWordmark([{ text: 'SPAWN', cls: 'amber', glow: true }]));
const launchForm = mountLaunchForm($('spawnform'), { onLaunched: () => setTimeout(load, 4000) });

/* ---------- live data ---------- */
// a coin's own link (/c/<mint>, or /spawn?coin=<mint>) opens its trade window
let data = null, sort = 'new', linked = new URLSearchParams(location.search).get('coin') || (/^\/c\/([1-9A-HJ-NP-Za-km-z]{32,44})$/.exec(location.pathname) || [])[1];
async function load() {
  try { data = await api('/spawn.json'); render(); } catch (e) { $('spstate').hidden = false; $('spstate').textContent = 'Could not reach the launchpad. Retrying…'; return; }
  // an old /spawn?coin=<mint> link goes to the coin's own page
  if (linked && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(linked) && !location.pathname.startsWith('/c/')) { location.replace(`/c/${linked}`); return; }
  const c = linked && data.coins.find((x) => x.mint === linked);
  if (c) { linked = null; openTrade(c); }
}
setInterval(load, 15000);
load();

function render() {
  const st = $('spstate');
  st.hidden = !!data.open; st.textContent = data.open ? '' : data.reason || 'Opening soon.';
  $('stcoins').textContent = fmt(data.coins.length);
  $('stburn').textContent = compact(data.root?.burned || 0);
  const w = data.rewards || {};
  $('stwaitk').textContent = 'Creator rewards, SOL';
  $('stwait').textContent = compact((w.waiting || 0) + (w.collected || 0));
  $('splede').textContent = 'Launch a coin on pump.fun and it hatches its own worm. Every buy pokes the big one. Its creator rewards go to SPAWN: 64% of them buy $WORM, and all of that is burned.';
  launchForm.update(data);
  const lb = data.root?.burns?.[0], lbp = $('lastburn');
  lbp.hidden = !lb;
  if (lb) lbp.replaceChildren(`Last burn: ${compact(lb.amount)} $WORM · `, link(lb.signature));
  const f = data.fee || {}, pct = (bps) => `${(bps / 100).toFixed(2).replace(/0$/, '')}%`;
  if (f.protocolBps != null && $('spawnnote')) $('spawnnote').textContent = `Free to launch, apart from about 0.02 SOL of rent for its accounts and an optional first buy, made in the same transaction. It's a pump.fun coin: its bonding curve, pump.fun's fee (currently ${pct(f.protocolBps + f.creatorBps)} of each trade, ${pct(f.creatorBps)} of it the creator's), and its graduation to PumpSwap when the curve sells out. Its creator is SPAWN, so its creator rewards come here, not to whoever launched it: 64% of them buy $WORM, all of it burned, and the other 36% stays with the team. It hatches its own worm, which feels every trade of it, and its buys poke the site's worm at its own spot.`;
  $('stpokes').textContent = fmt(data.pokesToday || 0);
  renderFee(data.fee);
  renderMovers(data.movers || []);
  renderCoins();
}

// where SPAWN's creator rewards go: 64% buys $WORM, all of it burned; 36% to the team
function renderFee(f) {
  if (!f) return;
  const burn = Math.round((f.buyback ?? 0.64) * 100), team = 100 - burn;
  if ($('feepct') && f.creatorBps != null) $('feepct').textContent = `${(f.creatorBps / 100).toFixed(2).replace(/0$/, '')}%`;
  const sq = $('squares');
  if (sq && (sq.childElementCount !== 100 || sq.dataset.k !== `${burn}`)) {
    sq.replaceChildren(); sq.dataset.k = `${burn}`;
    for (let i = 0; i < 100; i++) sq.append(el('i', i < burn ? 'burn' : 'creator'));
  }
  const key = $('feekey');
  if (!key) return;
  key.replaceChildren();
  for (const [cls, pct, text] of [['burn', burn, data?.root?.mint ? 'buys $WORM, and all of it is burned' : 'buys $WORM once it launches, and all of it is burned'], ['creator', team, 'to the team']]) {
    const li = el('li'); li.append(el('i', cls), el('b', null, `${pct}%`), ` ${text}`); key.append(li);
  }
}

function renderMovers(list) {
  const ol = $('movelist'); ol.replaceChildren();
  if (!list.length) { ol.append(el('li', 'empty', 'No trades yet today.')); return; }
  const top = Math.max(...list.map((m) => m.cells), 1);
  for (const m of list.slice(0, 10)) {
    const li = el('li'), bar = el('i');
    bar.style.transform = `scaleX(${Math.max(0.02, m.cells / top)})`;
    li.append(el('span', 'tk', '$' + m.symbol), el('span', 'meter', null), el('span', 'n', `${fmt(m.cells)} cells · ${fmt(m.pokes)} pokes`));
    li.querySelector('.meter').append(bar);
    ol.append(li);
  }
}

for (const b of document.querySelectorAll('.sorts button')) b.addEventListener('click', () => {
  sort = b.dataset.sort;
  for (const x of document.querySelectorAll('.sorts button')) x.setAttribute('aria-selected', String(x === b));
  renderCoins();
});
const SORTS = { new: (a, b) => b.createdAt - a.createdAt, mcap: (a, b) => b.mcapSol - a.mcapSol, grad: (a, b) => b.progress - a.progress, worm: (a, b) => (b.worm?.cells || 0) - (a.worm?.cells || 0), own: (a, b) => (b.own?.cells || 0) - (a.own?.cells || 0) };

$('coinsearch').addEventListener('input', () => renderCoins());
function renderCoins() {
  const grid = $('spgrid'), q = $('coinsearch').value.trim().toLowerCase().replace(/^\$/, '');
  const coins = [...(data?.coins || [])].filter((c) => !q || c.symbol.toLowerCase().includes(q) || c.name.toLowerCase().includes(q)).sort(SORTS[sort]);
  $('coincount').textContent = coins.length ? fmt(coins.length) : '';
  grid.replaceChildren();
  if (!coins.length) { grid.append(el('p', 'empty', q ? 'No coin matches that.' : data?.open ? 'No coins yet. Launch the first one below.' : 'No coins yet.')); return; }
  for (const c of coins) grid.append(coinCard(c));   // each opens the coin's own page
}

/* ---------- trading: one Jupiter transaction, signed in the visitor's wallet ---------- */
let coin = null, side = 'buy', pay = 'sol', quote = null, quoteTimer = null;
function openTrade(c) {
  stopWatching();
  coin = c; quote = null;
  $('tradeh').textContent = '$' + c.symbol;
  const pic = coinPicture(c);
  $('timg').hidden = !pic; if (pic) $('timg').src = pic;
  $('tprice').textContent = `${c.priceUsd ? usd(c.priceUsd) + ' · ' : ''}${sol(c.priceSol)} · in SOL`;
  $('paywith').hidden = true;   // every SPAWN coin trades in SOL
  pay = 'sol';
  setSide('buy'); $('tamount').value = ''; $('tquote').replaceChildren(); $('tlog').textContent = '';
  showClaim(); showOwn(c);
  $('trade').hidden = false; $('tamount').focus();
}

/* ---------- a coin's own worm: its portraits, what it has felt, and a check in this browser ---------- */
const mm = (um) => (um >= 1000 ? `${fmt(um / 1000, 1)} mm` : `${fmt(um)} µm`);
function showOwn(c) {
  const box = $('own'), o = c.own;
  box.hidden = !o;
  if (!o) return;
  $('ownbirth').src = `/spawn/worm/${c.mint}-birth.png`;
  $('ownnow').src = `/spawn/worm/${c.mint}.png?t=${o.trades}`;
  $('ownstats').textContent = `Its worm has felt ${fmt(o.trades)} trade${o.trades === 1 ? '' : 's'} (${fmt(o.buys)} buys, ${fmt(o.sells)} sells), `
    + `lit ${fmt(o.cells)} cells in all (${fmt(o.best)} at most at once) and swum ${mm(o.swim)}. At its first sight, "$${c.symbol}", ${fmt(o.birth)} cells fired.`;
  $('owncheckout').textContent = ''; $('owncheckout').className = 'small';
}
/* watching its worm: its first sight and its latest trade, replayed step by step in this browser from its public record */
const HEX = { eye: '#FFB84D', touch: '#FF9E7A', sn: '#7FC8FF', in: '#B9C9E8', mn: '#C49BFF', mus: '#FF6B5E', cil: '#56E6D2', other: '#6E7F8C' };
const COLORS = Object.fromEntries(Object.entries(HEX).map(([k, h]) => [k, [1, 3, 5].map((o) => parseInt(h.slice(o, o + 2), 16))]));
// the main page's colour key (app.js kindOf)
const kindOf = (x) => (x[6] & 1 ? 'eye' : x[6] & 4 ? 'touch' : x[6] & 64 ? 'cil' : x[1] === 0 ? 'sn' : x[1] === 1 ? 'in' : x[1] === 2 ? 'mn' : x[1] === 3 && /^MUS/.test(x[0]) ? 'mus' : 'other');
let wiring = null, watcher = null, watchId = 0, playing = 0;
$('ownwatchbtn').addEventListener('click', () => {
  if (playing) { stopWatching(); return; }
  if (!coin) return;
  const id = ++watchId, mint = coin.mint, out = $('owncheckout');
  $('ownwatchbtn').disabled = true; out.className = 'small'; out.textContent = 'Hatching it again in your browser…';
  wiring ||= fetch('/data/wiring.json').then((r) => r.json());
  watcher ||= new Worker('/coinworm-worker.js', { type: 'module' });
  watcher.onmessage = async (e) => {
    const m = e.data;
    if (m.id !== id) return;
    if (m.t === 'progress') { out.textContent = m.total ? `Rebuilding it from its trades: ${fmt(m.done)} of ${fmt(m.total)}…` : 'Hatching it again in your browser…'; return; }
    $('ownwatchbtn').disabled = false;
    if (m.t === 'error') { out.textContent = m.message; return; }
    if (coin?.mint !== mint || $('trade').hidden) return;
    out.textContent = '';
    play(await wiring, m);
  };
  watcher.postMessage({ id, mint, t: 'frames' });
});
function play(W, m) {
  const cv = $('owncanvas'), R = create2DRenderer(cv, { D: W, colors: COLORS, kinds: W.n.map(kindOf), dot: 2.4, glow: 0.12 });
  $('ownpics').hidden = true; $('ownwatch').hidden = false; $('ownwatchbtn').textContent = 'Stop';
  const px = Math.round(cv.clientWidth * Math.min(2, devicePixelRatio || 1)) || 480;
  R.resize(px, px);
  // its first sight in its own time (30 steps a second); a trade's touch is over in a third of a second, so it plays slowed
  const act = new Uint8Array(m.n), parts = [{ from: 0, to: m.birth, rate: 30, cap: `Its first sight: "$${m.ticker}"` }];
  if (m.last) parts.push({ from: m.birth, to: m.count, rate: 8, cap: `Its latest trade, a ${m.last.side}: its ${m.last.side === 'buy' ? 'head' : 'tail'} touched (slowed down)` });
  // each part ends a moment after its last cell stops firing (the steps after that are only quiet)
  for (const p of parts) {
    let end = p.from;
    for (let f = p.from; f < p.to; f++) { const fr = m.buf.subarray(f * m.n, (f + 1) * m.n); if (fr.some((v) => v > 12)) end = f; }
    p.to = Math.min(p.to, end + 1 + Math.round(p.rate * 0.8));
  }
  let part = 0, t0 = performance.now(), hold = 0;
  const loop = (now) => {
    if (!playing) return;
    const p = parts[part], len = p.to - p.from, k = Math.min(len - 1, Math.floor(((now - t0) / 1000) * p.rate));
    act.set(m.buf.subarray((p.from + k) * m.n, (p.from + k + 1) * m.n));
    let firing = 0;
    for (let i = 0; i < m.n; i++) if (act[i] > 12) firing++;
    R.frame({ cam: { yaw: 0.35 + now / 9000, pitch: 0.12, dist: 4.4, ty: -0.16, fov: 0.55 }, bend: 0, st: 0, act });
    $('owncap').textContent = `${p.cap} · ${fmt(firing)} cells firing`;
    if (k >= len - 1) { hold ||= now + 1400; if (now >= hold) { part = (part + 1) % parts.length; t0 = now; hold = 0; } }
    playing = requestAnimationFrame(loop);
  };
  playing = requestAnimationFrame(loop);
}
function stopWatching() {
  if (playing) cancelAnimationFrame(playing);
  playing = 0; watchId++;
  $('ownwatch').hidden = true; $('ownpics').hidden = false; $('ownwatchbtn').textContent = 'Watch it'; $('ownwatchbtn').disabled = false;
}
let checker = null, checkId = 0;
$('owncheck').addEventListener('click', () => {
  if (!coin) return;
  const out = $('owncheckout'), id = ++checkId, mint = coin.mint;
  checker ||= new Worker('/coinworm-worker.js', { type: 'module' });
  $('owncheck').disabled = true; out.className = 'small'; out.textContent = 'Loading the wiring…';
  checker.onmessage = (e) => {
    const m = e.data;
    if (m.id !== id) return;
    if (m.t === 'progress') { out.textContent = m.total ? `Rebuilding it from its trades: ${fmt(m.done)} of ${fmt(m.total)}…` : 'Rebuilding it from its first sight…'; return; }
    $('owncheck').disabled = false;
    if (m.t === 'error') { out.textContent = m.message; return; }
    out.className = 'small ' + (m.ok ? 'ok' : 'bad');
    out.textContent = m.ok ? `✓ Your browser rebuilt it from its ${fmt(m.trades)} trades: the same worm, state ${m.mine.slice(0, 12)}…` : `✗ Rebuilt from ${fmt(m.trades)} trades, it differs: yours ${m.mine.slice(0, 12)}…, the site's ${m.theirs.slice(0, 12)}…`;
  };
  checker.postMessage({ id, mint });
});
function setSide(s) {
  side = s;
  $('tbuy').setAttribute('aria-selected', String(s === 'buy')); $('tsell').setAttribute('aria-selected', String(s === 'sell'));
  $('paylabel').textContent = s === 'buy' ? 'Pay with' : 'Get';
  $('tgo').textContent = s === 'buy' ? 'Buy' : 'Sell';
  setPay(pay);
}
// every SPAWN coin trades in SOL
function setPay(p) {
  pay = p;
  $('psol').setAttribute('aria-selected', String(p === 'sol')); $('proot').setAttribute('aria-selected', String(p === 'root'));
  $('tunit').textContent = side === 'sell' ? '$' + coin.symbol : 'SOL';
  requote();
}
$('psol').addEventListener('click', () => setPay('sol'));
$('proot').addEventListener('click', () => setPay('root'));
// a coin's creator rewards go to SPAWN (64% of them to burning $WORM): nothing here for its launcher to claim
function showClaim() { $('tclaim').hidden = true; }
$('tbuy').addEventListener('click', () => setSide('buy'));
$('tsell').addEventListener('click', () => setSide('sell'));
$('tclose').addEventListener('click', () => { $('trade').hidden = true; stopWatching(); });
// share a coin: its own link, whose preview is its worm
$('tshare').addEventListener('click', async () => {
  if (!coin) return;
  const url = `${location.origin}/c/${coin.mint}`, text = `$${coin.symbol} hatched its own worm on SPAWN: a copy of a real larva's wiring that feels every trade of it.`;
  if (navigator.share) { try { await navigator.share({ title: '$' + coin.symbol, text, url }); return; } catch { /* cancelled */ } }
  open(`https://x.com/intent/post?text=${encodeURIComponent(text)}&url=${encodeURIComponent(url)}`, '_blank', 'noopener');
});
$('trade').addEventListener('click', (e) => { if (e.target.id === 'trade') { $('trade').hidden = true; stopWatching(); } });
addEventListener('keydown', (e) => { if (e.key === 'Escape') { $('trade').hidden = true; stopWatching(); } });
$('tamount').addEventListener('input', () => { clearTimeout(quoteTimer); quoteTimer = setTimeout(requote, 350); });

async function requote() {
  const amount = $('tamount').value.trim();
  quote = null; $('tgo').disabled = true;
  const q = $('tquote'); q.replaceChildren();
  if (!coin || !(Number(amount) > 0)) return;
  try {
    const j = await api('/spawn/quote', { mint: coin.mint, side, amount, pay });
    if (!coin || amount !== $('tamount').value.trim()) return;   // stale
    quote = j;
    const row = (k, v) => { const d = el('div'); d.append(el('dt', null, k), el('dd', null, v)); q.append(d); };
    row('You get about', `${compact(j.out.amount)} ${j.out.symbol}`);
    row('At least', `${compact(j.out.min)} ${j.out.symbol} or it doesn't happen`);
    row('Route', j.route.join(' → '));
    if (j.steps > 1) row('Steps', `${j.steps}: your wallet approves each one`);
    if (j.priceImpactPct > 0.01) row('Price impact', `${(j.priceImpactPct * 100).toFixed(2)}%`);
    $('tgo').disabled = !connected();
  } catch (e) { const d = el('div'); d.append(el('dt', null, 'Quote'), el('dd', null, e.message)); q.append(d); }
}
$('twallet').addEventListener('click', async () => {
  try { await connect(); } catch (e) {
    // a phone's browser has no wallet: open this coin's trade window inside a wallet app instead
    if (noWallet(e)) $('tlog').replaceChildren(...openInWallet(`${location.origin}/spawn?coin=${coin?.mint || ''}`));
    else $('tlog').textContent = e.message;
  }
});
// whichever form connected it, the trade window shows it
addEventListener('wallet-connected', (e) => { $('twallet').textContent = short(e.detail.address); $('tgo').disabled = !quote; showClaim(); });
$('tgo').addEventListener('click', async () => {
  if (!quote || !connected()) return;
  const log = $('tlog'), q = quote, many = q.steps > 1;
  try {
    $('tgo').disabled = true;
    let sig = null;
    for (let k = 0; k < q.steps; k++) {
      log.textContent = many ? `Step ${k + 1} of ${q.steps}: building the transaction…` : 'Building the transaction…';
      const { tx } = await api('/spawn/swap', { quoteId: q.quoteId, user: connected().address, step: k });
      log.textContent = many ? `Step ${k + 1} of ${q.steps}: check your wallet.` : 'Check your wallet.';
      sig = await signAndSend(tx);
      if (k < q.steps - 1) { log.textContent = `Step ${k + 1} sent. Waiting for it to land…`; await landed(sig); }
    }
    log.replaceChildren('Sent. ', link(sig));
    quote = null;
    setTimeout(load, 4000);
  } catch (e) { log.textContent = e.message; $('tgo').disabled = false; }
});
// the next step spends what this one bought, so it waits until this one has landed
async function landed(sig) {
  for (let t = 0; t < 40; t++) {
    await new Promise((r) => setTimeout(r, 1500));
    const c = await api('/spawn/confirm', { signature: sig }).catch(() => ({}));
    if (c.failed) throw new Error('That step failed on chain, so the next one was not sent.');
    if (c.confirmed) return;
  }
  throw new Error('The first step has not landed yet. Check your wallet before trying again.');
}
const link = (sig) => { const a = el('a', null, 'View on Solscan'); a.href = `https://solscan.io/tx/${sig}`; a.target = '_blank'; a.rel = 'noopener'; return a; };

// SPAWN: a coin's own page (/c/<mint>, or /coin.html?mint=<mint>). Its price and market cap, a chart of its market
// cap from its trades, its trades, a buy/sell panel, and its own worm: a fresh copy of the larva whose first sight
// was the coin's ticker and which has felt every trade of it since, replayed and checked in this browser from its
// public record. The visitor's own wallet signs every transaction; the server only builds them.
import { connect, connected, signAndSend, short, noWallet } from '/wallet.js';
import { openInWallet } from '/launchform.js';
import { create2DRenderer } from '/render2d.js';
import { createChart } from '/chart.js';

const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
async function api(path, body) {
  const r = await fetch(path, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : { cache: 'no-store' });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) throw new Error(j.error || `HTTP ${r.status}`);
  return j;
}

// the coin: /c/<mint>, or ?mint=<mint>
const B58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const MINT = [/^\/c\/([^/]+)\/?$/.exec(location.pathname)?.[1], new URLSearchParams(location.search).get('mint')].find((m) => m && B58.test(m)) || '';
const PAGE = `${location.origin}/c/${MINT}`;

/* ---------- numbers, the way traders read them ---------- */
const fmt = (n, d = 0) => Number(n || 0).toLocaleString('en-US', { maximumFractionDigits: d });
const big = (n) => Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: n >= 1000 || n < 100 ? 2 : 0 }).format(n || 0);
// a tiny price: 0.0000063 is 0.0₅63 (five zeros after the point, then the digits)
const SUB = '₀₁₂₃₄₅₆₇₈₉';
function tiny(n) {
  let e = Math.floor(Math.log10(n)), d = Math.round(n / 10 ** (e - 2));
  if (d >= 1000) { e++; d = Math.round(n / 10 ** (e - 2)); }
  return `0.0${String(-e - 1).replace(/\d/g, (x) => SUB[x])}${d}`;
}
const usd = (n) => (n >= 1 ? '$' + fmt(n, 2) : n >= 0.0001 ? '$' + fmt(n, 6) : n > 0 ? '$' + tiny(n) : '$0');
const unitPrice = (n) => (n >= 1 ? fmt(n, 2) : n >= 0.001 ? fmt(n, 4) : n > 0 ? tiny(n) : '0');
const amt = (n) => (!(n > 0) ? '0' : n >= 1e4 ? big(n) : n >= 1 ? fmt(n, 2) : n.toLocaleString('en-US', { maximumSignificantDigits: 3 }));
const mm = (um) => (um >= 1000 ? [fmt(um / 1000, 1), 'mm'] : [fmt(um), 'µm']);
function ago(t) {
  const s = Math.max(0, (Date.now() - t) / 1000);
  return s < 45 ? 'just now' : s < 3600 ? `${Math.max(1, Math.round(s / 60))}m ago` : s < 86400 ? `${Math.floor(s / 3600)}h ago` : s < 86400 * 45 ? `${Math.floor(s / 86400)}d ago` : new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}
const stamp = (t) => new Date(t).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const solscan = (sig, text = 'View on Solscan') => { const a = el('a', null, text); a.href = `https://solscan.io/tx/${sig}`; a.target = '_blank'; a.rel = 'noopener'; return a; };
const SIG = /^[1-9A-HJ-NP-Za-km-z]{64,90}$/;

/* ---------- state ---------- */
let data = null, coin = null;
// the chart's record: { quote, supply, points: [[ms, priceQuote, side, quoteAmount, signature], …] }; null when the server has none
let raw = null, chartTried = false, chartBusy = false, series = [], unit = null, range = 'all', showAll = false, seen = null, fallbackFor = -1;
// trading
let side = 'buy', pay = 'sol', quote = null, quoteSeq = 0, quoting = false, quoteErr = '', busy = false, inputTimer = 0;
// its worm
let wiringP = null, R = null, worker = null, jobSeq = 0, film = null, framesFor = -1, filming = false, raf = 0, inView = false;
let part = 0, t0 = 0, hold = 0, act = null, lastDraw = 0, dist = 0, hudKey = '', checking = false;
const jobs = new Map();
const still = matchMedia('(prefers-reduced-motion: reduce)');

/* ---------- live data ---------- */
function miss(title, text) {
  $('missh').textContent = title; $('misst').textContent = text;
  $('miss').hidden = false; $('head').hidden = true; $('grid').hidden = true;
  document.body.classList.remove('loading');
}
function state(text) { $('state').hidden = !text; $('state').textContent = text || ''; }

async function load() {
  if (!MINT) return;
  let j;
  try { j = await api('/spawn.json'); } catch { state('Could not reach the launchpad. Retrying…'); return; }
  state('');
  data = j;
  const c = (Array.isArray(j.coins) ? j.coins : []).find((x) => x && x.mint === MINT);
  if (!c) {
    if (!coin) miss('Not on SPAWN yet', 'If this coin was just launched, it shows up here within a minute.');
    return;
  }
  const first = !coin;
  coin = c;
  if (first) {
    $('miss').hidden = true; $('head').hidden = false; $('grid').hidden = false;
    document.body.classList.remove('loading');
    loadChart();
  }
  renderHead();
  syncPanel();
  renderOwn();
  renderChart();
  renderTrades();
  // a trade its worm hasn't been replayed with yet: replay it again, with the newest trade
  if (coin.own && inView && !filming && (!film || coin.own.trades > framesFor)) makeFilm();
}

function renderHead() {
  const c = coin, sym = '$' + c.symbol, done = c.stage === 'graduated';
  document.title = `${sym} · its own worm, on SPAWN`;
  $('sym').textContent = sym;
  $('name').textContent = c.name || '';
  $('age').textContent = c.createdAt ? `Launched ${ago(c.createdAt)}` : '';
  $('cashort').textContent = $('ca').classList.contains('done') ? 'Copied' : short(c.mint);
  $('picph').textContent = (c.symbol || '?').slice(0, 1);
  showPicture();
  // what it's worth: in US dollars once SOL's price is known, else in SOL, else in what it's priced in
  const solUsd = data?.root?.solUsd || 0, mcapSol = c.mcapSol || (c.priceSol || 0) * 1e9;
  const mcap = $('mcap');
  mcap.textContent = mcapSol && solUsd ? '$' + big(mcapSol * solUsd) : mcapSol ? big(mcapSol) + ' SOL' : c.priceQuote ? `${big(c.priceQuote * 1e9)} ${c.quote || ''}` : '—';
  mcap.title = mcapSol && solUsd ? '$' + fmt(mcapSol * solUsd) : '';
  $('price').textContent = c.priceUsd > 0 ? usd(c.priceUsd) : c.priceSol > 0 ? unitPrice(c.priceSol) + ' SOL' : c.priceQuote > 0 ? `${unitPrice(c.priceQuote)} ${c.quote || ''}` : '—';
  $('pricesol').textContent = c.priceUsd > 0 && c.priceSol > 0 ? unitPrice(c.priceSol) + ' SOL' : '';
  // how far along its curve it is
  const p = done || c.stage === 'graduating' ? 1 : Math.max(0, Math.min(1, Number(c.progress) || 0));
  $('gradbar').style.width = `${(p * 100).toFixed(2)}%`;
  $('gradpct').textContent = done ? '100%' : `${Math.floor(p * 100)}%`;
  $('gradk').textContent = done ? 'Graduated' : c.stage === 'graduating' ? 'Graduating' : 'To graduation';
  $('gradnote').textContent = done ? 'Trading on PumpSwap' : c.stage === 'graduating' ? 'Moving to PumpSwap…' : '';
  // it's a pump.fun coin: its page there too, once per coin
  const cpm = $('ca').closest('.cpmeta');
  if (cpm && !cpm.querySelector('.cppump')) { const a = el('a', 'cppump', 'pump.fun ↗'); a.href = `https://pump.fun/coin/${c.mint}`; a.target = '_blank'; a.rel = 'noopener'; cpm.append(' ', a); }
  // its description and links, as its launcher gave them (checked by the server: the links are x.com, t.me and one website)
  const d = $('desc'); if (d) { d.textContent = c.description || ''; d.hidden = !c.description; }
  if (cpm) {
    for (const old of cpm.querySelectorAll('.cplink')) old.remove();
    for (const [k, text] of [['twitter', 'X ↗'], ['telegram', 'Telegram ↗'], ['website', 'Website ↗']]) {
      const href = c[k]; if (!href || !/^https:\/\//.test(href)) continue;
      const a = el('a', 'cppump cplink', text); a.href = href; a.target = '_blank'; a.rel = 'noopener nofollow ugc'; cpm.append(' ', a);
    }
  }
  $('gradbarw').classList.toggle('moving', c.stage === 'graduating');
  $('gradbarw').classList.toggle('full', !!done);
  const pill = $('stagepill');
  pill.hidden = !(done || c.stage === 'graduating');
  pill.textContent = done ? 'Graduated' : 'Graduating';
  pill.classList.toggle('amber', !done);
}

// its picture, or its worm's latest portrait when it has none (or its picture won't load)
function showPicture() {
  const img = $('pic'), c = coin, worm = c.own ? `/spawn/worm/${c.mint}.png?t=${c.own.trades}` : '';
  const src = img.dataset.failed === c.image ? worm : c.image || worm;
  if (!src) { img.hidden = true; return; }
  if (img.getAttribute('src') !== src) { img.hidden = false; img.src = src; }
}
$('pic').addEventListener('error', () => {
  const img = $('pic');
  if (coin?.image && img.getAttribute('src') === coin.image) { img.dataset.failed = coin.image; showPicture(); } else img.hidden = true;
});

setInterval(() => { if (!document.hidden) load(); }, 15000);
setInterval(() => { if (!document.hidden && coin) loadChart(); }, 10000);
document.addEventListener('visibilitychange', () => { if (!document.hidden && coin) { load(); loadChart(); play(); } });

/* ---------- the chart and the trades, from its public trade record ---------- */
const RANGE_WORDS = { '1h': 'past hour', '6h': 'past 6 hours', '1d': 'past day', all: 'all time' };
const qsym = () => raw?.quote || coin?.quote || 'SOL';
// a market cap from a price in SOL: in dollars when SOL's price is known, else in SOL
function money() {
  const solUsd = data?.root?.solUsd || 0, toSol = qsym() === 'SOL' ? 1 : data?.root?.priceSol || 0;
  if (toSol && solUsd) return { k: toSol * solUsd, fmt: (v) => '$' + big(v) };
  if (toSol) return { k: toSol, fmt: (v) => `${big(v)} SOL` };
  return { k: 1, fmt: (v) => `${big(v)} ${qsym()}` };
}
const chart = createChart($('chart'), {
  value: (v) => (unit || money()).fmt(v),
  detail: (p) => (p.side === 'start' ? ['Launched', 'start'] : p.side === 'buy' || p.side === 'sell' ? [`${p.side === 'buy' ? 'Buy' : 'Sell'} · ${amt(p.amt)} ${qsym()}`, p.side] : null),
});
for (const b of document.querySelectorAll('.cpranges button')) b.addEventListener('click', () => {
  range = b.dataset.range;
  for (const x of document.querySelectorAll('.cpranges button')) x.setAttribute('aria-selected', String(x === b));
  chart.setRange(range);
  renderChange();
});

async function loadChart() {
  if (!MINT || chartBusy) return;
  chartBusy = true;
  try {
    const r = await fetch(`/spawn/chart/${MINT}.json`, { cache: 'no-store' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();
    raw = j && typeof j === 'object' ? j : null;
  } catch { raw = null; }
  finally { chartBusy = false; chartTried = true; }
  if (!coin) return;
  renderChart();
  renderTrades();
}

function renderChart() {
  unit = money();
  const supply = Number(raw?.supply) || 1e9, list = Array.isArray(raw?.points) ? raw.points : [];
  series = list
    .filter((p) => Array.isArray(p) && Number.isFinite(Number(p[0])) && Number(p[1]) > 0)
    .map(([t, price, s, amount, sig]) => ({ t: Number(t), v: Number(price) * supply * unit.k, side: s === 'sell' || s === 'start' ? s : 'buy', amt: Number(amount) || 0, sig: typeof sig === 'string' ? sig : '' }))
    .sort((a, b) => a.t - b.t);
  const traded = series.some((p) => p.side !== 'start');
  $('chartempty').hidden = traded || !chartTried;
  $('chart').classList.toggle('none', !traded);
  $('chart').parentElement.classList.toggle('nochart', !traded);
  chart.set(traded ? series : []);
  renderChange();
}
function renderChange() {
  const v = chart.view, out = $('change');
  if (!v || !(v.first > 0)) { out.replaceChildren(); $('chart').setAttribute('aria-label', 'No trades yet'); return; }
  const pct = ((v.last - v.first) / v.first) * 100, up = pct >= 0, n = Math.abs(pct);
  out.className = 'cpchg ' + (up ? 'up' : 'down');
  out.replaceChildren(`${up ? '+' : '−'}${n >= 100 ? fmt(n) : n.toFixed(n >= 10 ? 1 : 2)}%`, el('small', null, RANGE_WORDS[range]));
  $('chart').setAttribute('aria-label', `Market cap ${unit.fmt(v.last)}, ${up ? 'up' : 'down'} ${n.toFixed(1)}% ${RANGE_WORDS[range]}`);
}

const LIMIT = 25;
const txLink = (sig) => {
  if (!SIG.test(sig)) return el('span', 'cptx');
  const a = el('a', 'cptx'); a.href = `https://solscan.io/tx/${sig}`; a.target = '_blank'; a.rel = 'noopener';
  a.title = 'View on Solscan'; a.setAttribute('aria-label', 'View on Solscan');
  a.innerHTML = '<svg class="ic" viewBox="0 0 20 20" aria-hidden="true"><path d="M7 13 13 7M8.5 7H13v4.5"/></svg>';
  return a;
};
function renderTrades() {
  const ol = $('rows'), more = $('more');
  if (!raw) { more.hidden = true; if (chartTried) fallbackTrades(); return; }
  const trades = series.filter((p) => p.side !== 'start').reverse(), key = (p) => `${p.sig || p.t}:${p.side}:${p.amt}`;
  $('tradecount').textContent = trades.length ? fmt(trades.length) : '';
  if (!trades.length) { ol.replaceChildren(el('li', 'cpnone', 'No trades yet. The first one starts the chart.')); more.hidden = true; seen = new Set(); return; }
  const rows = (showAll ? trades : trades.slice(0, LIMIT)).map((p) => {
    const li = el('li', `cprow ${p.side}${seen && !seen.has(key(p)) ? ' new' : ''}`), v = el('span', 'cpval'), tm = el('time', 'cpago', ago(p.t));
    v.append(el('b', null, p.amt > 0 ? amt(p.amt) : '—'), el('small', null, qsym()));
    tm.dateTime = new Date(p.t).toISOString(); tm.title = stamp(p.t);
    li.append(el('span', `cpside ${p.side}`, p.side === 'buy' ? 'Buy' : 'Sell'), v, el('span', 'cpmc', unit.fmt(p.v)), tm, txLink(p.sig));
    return li;
  });
  ol.replaceChildren(...rows);
  seen = new Set(trades.map(key));
  more.hidden = showAll || trades.length <= LIMIT;
  more.textContent = `Show all ${fmt(trades.length)}`;
}
$('more').addEventListener('click', () => { showAll = true; renderTrades(); });

// until the server keeps a chart for it: the trades its worm felt (in order, with their transactions)
async function fallbackTrades() {
  const ol = $('rows'), n = coin?.own?.trades || 0;
  if (!n) { $('tradecount').textContent = ''; ol.replaceChildren(el('li', 'cpnone', 'No trades yet.')); fallbackFor = 0; return; }
  if (n === fallbackFor) return;
  fallbackFor = n;
  let rec;
  try { rec = await api(`/spawn/worm/${MINT}.json`); } catch { fallbackFor = -1; return; }
  if (raw) return;   // the chart arrived meanwhile
  const trades = (Array.isArray(rec.trades) ? rec.trades : []).filter((t) => t && typeof t.signature === 'string').reverse();
  $('tradecount').textContent = trades.length ? fmt(trades.length) : '';
  if (!trades.length) { ol.replaceChildren(el('li', 'cpnone', 'No trades yet.')); return; }
  ol.replaceChildren(...trades.slice(0, LIMIT).map((t) => {
    const s = t.side === 'sell' ? 'sell' : 'buy', li = el('li', `cprow ${s} bare`);
    li.append(el('span', `cpside ${s}`, s === 'buy' ? 'Buy' : 'Sell'), el('span', 'cpsig', `${t.signature.slice(0, 6)}…${t.signature.slice(-6)}`), txLink(t.signature));
    return li;
  }));
}

/* ---------- trading: the server builds each transaction, the visitor's own wallet signs and sends it ---------- */
const amountEl = $('amount');
const unitText = () => (side === 'sell' ? '$' + (coin?.symbol || '') : 'SOL');
function say(parts, bad = false) { const l = $('log'); l.classList.toggle('bad', bad); l.replaceChildren(...[].concat(parts)); }
// what a wallet says, in words
const walletError = (e) => { const m = String(e?.message || e || 'Something went wrong.'); return /reject|cancel|denied|declined/i.test(m) ? 'Cancelled in your wallet.' : m; };

function syncPanel() {
  const inSol = !coin || coin.quote === 'SOL';
  if (inSol) pay = 'sol';   // every SPAWN coin trades in SOL
  $('tbuy').setAttribute('aria-selected', String(side === 'buy'));
  $('tsell').setAttribute('aria-selected', String(side === 'sell'));
  $('unit').textContent = unitText();
  $('chips').hidden = !(side === 'buy' && pay === 'sol') || coin?.stage === 'graduating';
  amountEl.placeholder = side === 'sell' ? '0' : '0.0';
  amountEl.disabled = coin?.stage === 'graduating';
  updateGo();
}
function updateGo() {
  const b = $('go'), w = connected(), n = Number(amountEl.value);
  b.classList.toggle('sell', side === 'sell');
  b.classList.toggle('connect', !w);
  if (busy) { b.disabled = true; return; }
  if (!coin) { b.disabled = true; b.textContent = 'Loading…'; return; }
  if (coin.stage === 'graduating') { b.disabled = true; b.textContent = 'Graduating…'; return; }
  if (!w) { b.disabled = false; b.textContent = 'Connect wallet'; return; }
  if (!(n > 0)) { b.disabled = true; b.textContent = 'Enter an amount'; return; }
  if (!quote) { b.disabled = true; b.textContent = quoteErr ? 'No quote for that' : 'Getting a quote…'; return; }
  b.disabled = false; b.textContent = `${side === 'buy' ? 'Buy' : 'Sell'} $${coin.symbol}`;
}
// switching sides or currency keeps the amount only while it means the same thing
function choose(fn) {
  const before = unitText();
  fn();
  say([]);   // what happened on the other side (a cancelled sale, say) isn't about this one
  if (unitText() !== before) amountEl.value = '';
  syncPanel();
  requote();
}
$('tbuy').addEventListener('click', () => choose(() => { side = 'buy'; }));
$('tsell').addEventListener('click', () => choose(() => { side = 'sell'; }));
for (const b of $('chips').querySelectorAll('button')) b.addEventListener('click', () => { amountEl.value = b.dataset.v; requote(); });
amountEl.addEventListener('input', () => {
  const v = amountEl.value.replace(/,/g, '.').replace(/[^0-9.]/g, '').replace(/(\..*)\./g, '$1');
  if (v !== amountEl.value) amountEl.value = v;
  quote = null; quoteErr = ''; ++quoteSeq;
  $('quote').classList.add('stale');
  updateGo();
  clearTimeout(inputTimer);
  inputTimer = setTimeout(requote, 350);
});
amountEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') requote(); });

// what a quote is for; only the answer to the latest request counts, and only for exactly what is on screen now
// (a slow buy quote must never land on the Sell button)
const asked = () => ({ mint: coin?.mint, side, pay, amount: amountEl.value.trim() });
const same = (a, b) => !!a && !!b && a.mint === b.mint && a.side === b.side && a.pay === b.pay && a.amount === b.amount;
async function requote({ silent = false } = {}) {
  clearTimeout(inputTimer);
  const want = asked(), seq = ++quoteSeq, q = $('quote');
  if (!silent) { quote = null; quoteErr = ''; }
  if (!coin || !(Number(want.amount) > 0)) { quote = null; quoting = false; q.replaceChildren(); q.classList.remove('stale'); updateGo(); return; }
  if (!silent) { quoting = true; q.classList.add('stale'); updateGo(); }
  try {
    const j = await api('/spawn/quote', want);
    if (seq !== quoteSeq || !same(want, asked())) return;
    quote = { ...j, at: Date.now(), for: want };
    const row = (k, v, cls) => { const d = el('div', cls); d.append(el('dt', null, k), el('dd', null, v)); return d; };
    const out = j.out || {}, rows = [row('You get about', `${amt(out.amount)} ${out.symbol || ''}`), row('At least', `${amt(out.min)} ${out.symbol || ''}`)];
    if (Array.isArray(j.route) && (j.route.length > 2 || j.steps > 1)) rows.push(row('Route', j.route.join(' → ')));
    if (j.steps > 1) rows.push(row('Steps', `${j.steps}, your wallet approves each`));
    if (j.priceImpactPct > 0.01) rows.push(row('Price impact', `${(j.priceImpactPct * 100).toFixed(2)}%`, j.priceImpactPct > 0.05 ? 'warn' : ''));
    q.replaceChildren(...rows);
  } catch (e) {
    if (seq !== quoteSeq) return;
    quote = null; quoteErr = e.message;
    const d = el('div', 'warn'); d.append(el('dt', null, 'Quote'), el('dd', null, e.message));
    q.replaceChildren(d);
  } finally {
    if (seq === quoteSeq) { quoting = false; q.classList.remove('stale'); updateGo(); }
  }
}
// a quote holds for two minutes on the server: keep the one on screen fresh
setInterval(() => { if (quote && !busy && !quoting && !document.hidden && Date.now() - quote.at > 45e3) requote({ silent: true }); }, 5000);

async function connectWallet() {
  try { await connect(); } catch (e) {
    // a phone's browser has no wallet: open this page inside a wallet app instead
    if (noWallet(e)) say(openInWallet(PAGE)); else say(walletError(e), true);
  }
}
// whichever part of the page connected it, the panel shows it
addEventListener('wallet-connected', (e) => {
  const a = e.detail?.address, w = $('wallet');
  w.hidden = !a;
  if (a) w.replaceChildren(el('i'), 'Wallet ', el('b', null, short(a)));
  if (/No wallet in this browser/.test($('log').textContent)) say([]);
  updateGo();
});

$('go').addEventListener('click', async () => {
  if (busy || !coin) return;
  if (!connected()) { await connectWallet(); return; }
  if (!quote || !same(quote.for, asked())) { requote(); return; }
  const q = quote, many = q.steps > 1, b = $('go');
  let done = 0;   // steps that have landed
  busy = true; b.disabled = true; say([]);
  try {
    let sig = null;
    for (let k = 0; k < q.steps; k++) {
      b.textContent = many ? `Step ${k + 1} of ${q.steps}: building…` : 'Building the transaction…';
      const { tx } = await api('/spawn/swap', { quoteId: q.quoteId, user: connected().address, step: k });
      b.textContent = many ? `Step ${k + 1} of ${q.steps}: check your wallet` : 'Check your wallet…';
      sig = await signAndSend(tx);
      if (k < q.steps - 1) { b.textContent = `Step ${k + 1} sent. Waiting for it to land…`; await landed(sig); done = k + 1; }
    }
    ++quoteSeq; quote = null; amountEl.value = ''; $('quote').replaceChildren();
    say(['Sent. ', solscan(sig)]);
    setTimeout(() => { load(); loadChart(); }, 4000);
  } catch (e) {
    // the server spends a quote once it builds from it: never reuse one, get a fresh one
    ++quoteSeq; quote = null;
    const why = /price moved/i.test(String(e?.message)) ? 'The price moved, so here is a new quote.' : walletError(e);
    say(done ? `${why} Step ${done} landed.` : why, true);
    requote();
  } finally { busy = false; updateGo(); }
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


/* ---------- sharing ---------- */
$('share').addEventListener('click', async () => {
  if (!coin) return;
  const text = `$${coin.symbol} hatched its own worm on SPAWN: a copy of a real larva's wiring that feels every trade of it.`;
  if (navigator.share) {
    try { await navigator.share({ title: '$' + coin.symbol, text, url: PAGE }); return; } catch (e) { if (e?.name === 'AbortError') return; }
  }
  open(`https://x.com/intent/post?text=${encodeURIComponent(text)}&url=${encodeURIComponent(PAGE)}`, '_blank', 'noopener');
});
let copiedTimer = 0;
$('ca').addEventListener('click', async () => {
  if (!MINT) return;
  let ok = false;
  try { await navigator.clipboard.writeText(MINT); ok = true; } catch {
    const t = el('textarea'); t.value = MINT; t.setAttribute('readonly', ''); t.className = 'sr'; document.body.append(t); t.select();
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    t.remove();
  }
  const ca = $('ca');
  ca.classList.toggle('done', ok);
  $('cashort').textContent = ok ? 'Copied' : MINT;
  clearTimeout(copiedTimer);
  copiedTimer = setTimeout(() => { ca.classList.remove('done'); $('cashort').textContent = short(MINT); }, ok ? 1400 : 8000);
});

/* ---------- its own worm: its first sight and its latest trade, replayed step by step in this browser ---------- */
const HEX = { eye: '#FFB84D', touch: '#FF9E7A', sn: '#7FC8FF', in: '#B9C9E8', mn: '#C49BFF', mus: '#FF6B5E', cil: '#56E6D2', other: '#6E7F8C' };
const COLORS = Object.fromEntries(Object.entries(HEX).map(([k, h]) => [k, [1, 3, 5].map((o) => parseInt(h.slice(o, o + 2), 16))]));
// the main page's colour key (app.js kindOf)
const kindOf = (x) => (x[6] & 1 ? 'eye' : x[6] & 4 ? 'touch' : x[6] & 64 ? 'cil' : x[1] === 0 ? 'sn' : x[1] === 1 ? 'in' : x[1] === 2 ? 'mn' : x[1] === 3 && /^MUS/.test(x[0]) ? 'mus' : 'other');
const cv = $('wormcv');

// one worker does both: it rebuilds the worm from the wiring and the coin's public record
const NO_RUN = 'Couldn\'t run it in this browser.';
function work(msg, onProgress) {
  return new Promise((resolve, reject) => {
    if (!worker) {
      try { worker = new Worker('/coinworm-worker.js', { type: 'module' }); } catch { reject(new Error(NO_RUN)); return; }
      const fail = () => { for (const j of jobs.values()) j.reject(new Error(NO_RUN)); jobs.clear(); worker?.terminate(); worker = null; };
      worker.onerror = fail;
      worker.onmessageerror = fail;
      worker.onmessage = (e) => {
        const m = e.data, j = jobs.get(m?.id);
        if (!j) return;
        if (m.t === 'progress') { j.onProgress?.(m); return; }
        jobs.delete(m.id);
        if (m.t === 'error') j.reject(new Error(m.message || NO_RUN)); else j.resolve(m);
      };
    }
    const id = ++jobSeq;
    jobs.set(id, { resolve, reject, onProgress });
    worker.postMessage({ id, ...msg });
  });
}

// it's drawn bigger as its coin nears graduation: the camera comes closer, nothing else changes
const grown = () => (!coin ? 0 : coin.graduated || coin.stage !== 'curve' ? 1 : Math.max(0, Math.min(1, Number(coin.progress) || 0)));
const camDist = () => 6.2 - 2 * grown();

async function renderer() {
  if (R) return R;
  wiringP ||= fetch('/data/wiring.json').then((r) => { if (!r.ok) throw new Error('The wiring did not load.'); return r.json(); });
  let W;
  try { W = await wiringP; } catch (e) { wiringP = null; throw e; }
  if (!R) {
    R = create2DRenderer(cv, { D: W, colors: COLORS, kinds: W.n.map(kindOf), dot: 2.4, glow: 0.12 });
    act ||= new Uint8Array(W.n.length);
    fit();
  }
  return R;
}
function fit() {
  if (!R) return;
  const px = Math.round((cv.clientWidth || 480) * Math.min(2, devicePixelRatio || 1));
  R.resize(px, px);
  paint(performance.now());
}
new ResizeObserver(fit).observe($('stage'));

function paint(now) {
  if (!R || !act) return;
  dist = dist ? dist + (camDist() - dist) * 0.06 : camDist();
  R.frame({ cam: { yaw: still.matches ? 0.8 : 0.35 + now / 9000, pitch: 0.12, dist, ty: -0.16, fov: 0.55 }, bend: 0, st: 0, act });
}

function wait(text) { const w = $('wwait'); w.hidden = !text; w.textContent = text || ''; }

function renderOwn() {
  const c = coin, o = c.own, sym = '$' + c.symbol, done = c.stage === 'graduated';
  $('wormlede').textContent = `${sym} hatched its own copy of a real larva's wiring. The first thing it saw was "${sym}". Since then it feels every trade of it: a buy touches its head, a sell its tail.`;
  $('grow').textContent = done || c.stage === 'graduating' ? `Drawn at full size: ${sym} ${done ? 'has graduated' : 'is graduating'}. Same wiring, same model.` : `Drawn bigger as ${sym} nears graduation. Same wiring, same model.`;
  const set = (id, v, u) => { const d = $(id); d.replaceChildren(v); if (u) d.append(el('small', null, u)); };
  if (!o) {
    for (const id of ['s-trades', 's-cells', 's-best', 's-swim', 's-birth', 's-sides']) set(id, '—');
    $('check').disabled = true;
    if (!film) wait('Its worm is hatching. It shows up here in a moment.');
    return;
  }
  const [swim, swimUnit] = mm(o.swim || 0);
  set('s-trades', fmt(o.trades));
  set('s-cells', fmt(o.cells));
  set('s-best', fmt(o.best));
  set('s-swim', swim, swimUnit);
  set('s-birth', fmt(o.birth), 'cells');
  set('s-sides', `${fmt(o.buys)} · ${fmt(o.sells)}`);
  $('check').disabled = checking;
}

// each part ends a moment after its last cell stops firing (what follows is only quiet)
function partsOf(m) {
  const sym = `"$${m.ticker}"`, parts = [{ from: 0, to: m.birth, rate: 30, label: `First sight: ${sym}` }];
  if (m.last) parts.push({ from: m.birth, to: m.count, rate: 8, label: `Latest trade: a ${m.last.side}, its ${m.last.side === 'sell' ? 'tail' : 'head'} touched`, slow: true });
  for (const p of parts) {
    let end = p.from;
    for (let f = p.from; f < p.to; f++) { const fr = m.buf.subarray(f * m.n, (f + 1) * m.n); if (fr.some((v) => v > 12)) end = f; }
    p.to = Math.min(p.to, end + 1 + Math.round(p.rate * 0.8));
  }
  return parts.filter((p) => p.to > p.from);
}

async function makeFilm() {
  if (filming || !coin?.own) return;
  filming = true;
  if (!film) wait('Hatching it again in your browser…');
  try {
    renderer().catch(() => {});
    const m = await work({ mint: MINT, t: 'frames' }, (p) => { if (!film) wait(p.total ? `Rebuilding it from its trades: ${fmt(p.done)} of ${fmt(p.total)}…` : 'Hatching it again in your browser…'); });
    await renderer();
    const parts = partsOf(m);
    if (!parts.length) throw new Error('Nothing to replay yet.');
    const newTrade = !!film && !!m.last && m.last.signature !== film.m.last?.signature;
    film = { m, parts };
    framesFor = m.last ? m.last.trades : 0;
    if (act?.length !== m.n) act = new Uint8Array(m.n);
    // a new trade came in: show it now
    part = newTrade ? parts.length - 1 : Math.min(part, parts.length - 1);
    if (newTrade || !raf) { t0 = performance.now(); hold = 0; }
    wait('');
    $('hudfirew').hidden = false;
    play();
  } catch (e) {
    if (!film) { wait(e.message); renderer().then(() => paint(performance.now()), () => {}); }
  } finally { filming = false; }
}

function play() {
  if (raf || !film || !inView || document.hidden) return;
  t0 = performance.now(); hold = 0;
  raf = requestAnimationFrame(tick);
}
function tick(now) {
  raf = 0;
  if (!film || !inView || document.hidden) return;
  raf = requestAnimationFrame(tick);
  if (now - lastDraw < 30) return;   // about 30 frames a second is plenty
  lastDraw = now;
  const { m, parts } = film, p = parts[part] || parts[0], len = p.to - p.from;
  const k = Math.max(0, Math.min(len - 1, Math.floor(((now - t0) / 1000) * p.rate)));
  act.set(m.buf.subarray((p.from + k) * m.n, (p.from + k + 1) * m.n));
  let firing = 0;
  for (let i = 0; i < m.n; i++) if (act[i] > 12) firing++;
  paint(now);
  const key = `${part}:${firing}`;
  if (key !== hudKey) { hudKey = key; $('hudpart').textContent = p.label; $('hudslow').hidden = !p.slow; $('hudfire').textContent = fmt(firing); }
  if (k >= len - 1) { hold ||= now + 1400; if (now >= hold) { part = (part + 1) % parts.length; t0 = now; hold = 0; } }
}

// it plays while it's on screen
new IntersectionObserver((es) => {
  inView = es.some((e) => e.isIntersecting);
  if (!inView) { if (raf) cancelAnimationFrame(raf); raf = 0; return; }
  if (!R) renderer().then(() => paint(performance.now()), () => {});
  if (coin?.own && !film) makeFilm(); else play();
}, { rootMargin: '120px 0px' }).observe($('stage'));

// check it: rebuild it from its ticker and every trade, here, and compare with the state the site published
$('check').addEventListener('click', async () => {
  if (!coin?.own || checking) return;
  const b = $('check'), out = $('checkout');
  checking = true; b.disabled = true; out.className = 'cpcheckout'; out.textContent = 'Loading the wiring…';
  try {
    const m = await work({ mint: MINT }, (p) => { out.textContent = p.total ? `Rebuilding it: ${fmt(p.done)} of ${fmt(p.total)} trades…` : 'Rebuilding it from its first sight…'; });
    out.className = 'cpcheckout ' + (m.ok ? 'ok' : 'bad');
    out.textContent = m.ok
      ? `✓ The same worm. Your browser rebuilt it from its ${fmt(m.trades)} trade${m.trades === 1 ? '' : 's'}.`
      : `✗ It differs. Rebuilt from ${fmt(m.trades)} trades: yours ${String(m.mine).slice(0, 10)}…, the site's ${String(m.theirs).slice(0, 10)}…`;
    out.title = m.ok ? `State ${m.mine}` : '';
  } catch (e) { out.className = 'cpcheckout bad'; out.textContent = e.message; }
  finally { checking = false; b.disabled = !coin?.own; }
});

/* ---------- start ---------- */
if (!MINT) miss('No coin here', 'This link doesn\'t name a coin on SPAWN.');
else { syncPanel(); load(); }

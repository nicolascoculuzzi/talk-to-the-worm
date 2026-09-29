// SPAWN: the launchpad page. Coins trade on their own curves (in SOL, or in $BRAINWORM once it has launched); buying a
// coin priced in $BRAINWORM with SOL goes SOL → $BRAINWORM → coin through Jupiter. The visitor's own wallet signs
// every transaction; the server only builds them.
import { pixelWordmark } from '/pixel.js';
import { connect, connected, signAndSend, short } from '/wallet.js';
import { mountLaunchForm } from '/launchform.js';
import { coinCard, coinPicture, el, fmt, compact, sol, usd } from '/coincard.js';

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
let data = null, sort = 'new', linked = new URLSearchParams(location.search).get('coin');
async function load() {
  try { data = await api('/spawn.json'); render(); } catch (e) { $('spstate').hidden = false; $('spstate').textContent = 'Could not reach the launchpad. Retrying…'; return; }
  // /spawn?coin=<mint> opens that coin's trade window
  const c = linked && data.coins.find((x) => x.mint === linked);
  if (c) { linked = null; openTrade(c); }
}
setInterval(load, 15000);
load();

function render() {
  const st = $('spstate');
  st.hidden = !!data.open; st.textContent = data.open ? '' : data.reason || 'Opens when $BRAINWORM launches.';
  $('stcoins').textContent = fmt(data.coins.length);
  $('stburn').textContent = compact(data.root?.burned || 0);
  // before $BRAINWORM, what waits is SOL for buying it
  const inSol = !data.root?.mint || data.quote === 'SOL';
  $('stwaitk').textContent = inSol ? 'SOL for buybacks' : 'Waiting to burn';
  $('stwait').textContent = inSol ? compact(data.root?.waitingSol || 0) : compact(data.root?.waiting || 0);
  $('splede').textContent = data.quote === '$BRAINWORM'
    ? 'Launch a coin and it hatches its own worm. Every coin here is priced in $BRAINWORM, most of every fee is burned, and every buy pokes the big worm.'
    : 'Launch a coin and it hatches its own worm. Every buy pokes the big one. Coins are priced in SOL until $BRAINWORM launches, and most of every fee goes to burning it.';
  launchForm.update(data);
  const lb = data.root?.burns?.[0], lbp = $('lastburn');
  lbp.hidden = !lb;
  if (lb) lbp.replaceChildren(`Last burn: ${compact(lb.amount)} $BRAINWORM · `, link(lb.signature));
  if (data.graduationQuote) $('spawnnote').textContent = `Free to launch. No mint or freeze authority, and nothing held back for anyone: all 1,000,000,000 coins are on the curve or go to the graduated pool. It graduates to Meteora DAMM v2 once buyers have put in ${compact(data.graduationQuote)} ${data.quote || 'SOL'}, with its liquidity locked for good. It hatches its own worm, which feels every trade of it, and its buys poke the site's worm at its own spot.`;
  $('stpokes').textContent = fmt(data.pokesToday || 0);
  renderFee(data.fee);
  renderMovers(data.movers || []);
  renderCoins();
}

function renderFee(f) {
  if (!f) return;
  const protocol = Math.round(f.protocolShare * 100), creator = Math.round((1 - f.protocolShare) * f.creatorShare * 100), burn = 100 - protocol - creator;
  $('feepct').textContent = `${f.bps / 100}%`;
  const sq = $('squares');
  if (sq.childElementCount !== 100 || sq.dataset.k !== `${burn}-${creator}`) {
    sq.replaceChildren(); sq.dataset.k = `${burn}-${creator}`;
    for (let i = 0; i < 100; i++) sq.append(el('i', i < burn ? 'burn' : i < burn + creator ? 'creator' : 'meteora'));
  }
  const key = $('feekey'); key.replaceChildren();
  const burnText = data?.quote === '$BRAINWORM' ? 'burns $BRAINWORM for good' : 'buys $BRAINWORM to burn, once it launches';
  for (const [cls, pct, text] of [['burn', burn, burnText], ['creator', creator, "to the coin's creator"], ['meteora', protocol, 'kept by Meteora']]) {
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

function renderCoins() {
  const grid = $('spgrid');
  const coins = [...(data?.coins || [])].sort(SORTS[sort]);
  $('coincount').textContent = coins.length ? fmt(coins.length) : '';
  grid.replaceChildren();
  if (!coins.length) { grid.append(el('p', 'empty', data?.open ? 'No coins yet. Launch the first one.' : 'No coins yet.')); return; }
  for (const c of coins) grid.append(coinCard(c, { onBuy: openTrade }));
}

/* ---------- trading: one Jupiter transaction, signed in the visitor's wallet ---------- */
let coin = null, side = 'buy', pay = 'sol', quote = null, quoteTimer = null;
function openTrade(c) {
  coin = c; quote = null;
  $('tradeh').textContent = '$' + c.symbol;
  const pic = coinPicture(c);
  $('timg').hidden = !pic; if (pic) $('timg').src = pic;
  $('tprice').textContent = `${c.priceUsd ? usd(c.priceUsd) + ' · ' : ''}${sol(c.priceSol)} · priced in ${c.quote || '$BRAINWORM'}`;
  // a coin priced in SOL trades in SOL only; one priced in $BRAINWORM in either
  $('paywith').hidden = c.quote === 'SOL';
  if (c.quote === 'SOL') pay = 'sol';
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
// pay (or get) SOL through Jupiter, or $BRAINWORM straight on the coin's curve
function setPay(p) {
  pay = p;
  $('psol').setAttribute('aria-selected', String(p === 'sol')); $('proot').setAttribute('aria-selected', String(p === 'root'));
  $('tunit').textContent = side === 'sell' ? '$' + coin.symbol : p === 'sol' ? 'SOL' : '$BRAINWORM';
  requote();
}
$('psol').addEventListener('click', () => setPay('sol'));
$('proot').addEventListener('click', () => setPay('root'));
// the coin's creator can claim their share of its fees here
function showClaim() {
  const b = $('tclaim'), me = connected()?.address;
  b.hidden = !(coin && me && coin.creator === me && (coin.creatorFees > 0 || coin.stage === 'graduated'));
  if (!b.hidden) b.textContent = coin.stage === 'graduated' ? 'Claim your creator fees' : `Claim your ${compact(coin.creatorFees)} ${coin.quote || '$BRAINWORM'} in creator fees`;
}
$('tclaim').addEventListener('click', async () => {
  const log = $('tlog');
  try {
    $('tclaim').disabled = true; log.textContent = 'Building the transaction…';
    const { txs } = await api('/spawn/claim', { mint: coin.mint, creator: connected().address });
    let sig = null;
    for (const [k, tx] of txs.entries()) {
      log.textContent = txs.length > 1 ? `Claim ${k + 1} of ${txs.length}: check your wallet.` : 'Check your wallet.';
      sig = await signAndSend(tx);
    }
    log.replaceChildren('Claimed. ', link(sig));
    setTimeout(load, 4000);
  } catch (e) { log.textContent = e.message; } finally { $('tclaim').disabled = false; }
});
$('tbuy').addEventListener('click', () => setSide('buy'));
$('tsell').addEventListener('click', () => setSide('sell'));
$('tclose').addEventListener('click', () => { $('trade').hidden = true; });
$('trade').addEventListener('click', (e) => { if (e.target.id === 'trade') $('trade').hidden = true; });
addEventListener('keydown', (e) => { if (e.key === 'Escape') $('trade').hidden = true; });
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
  try { await connect(); } catch (e) { $('tlog').textContent = e.message; }
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

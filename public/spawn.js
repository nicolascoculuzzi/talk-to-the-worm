// SPAWN: the launchpad page. Every coin trades in $BRAINWORM; buying goes SOL → $BRAINWORM → coin in
// one Jupiter transaction that the visitor's own wallet signs. The server only builds transactions.
import { pixelWordmark } from '/pixel.js';
import { connect, connected, signAndSend } from '/wallet.js';

const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const fmt = (n, d = 0) => Number(n || 0).toLocaleString('en-US', { maximumFractionDigits: d, minimumFractionDigits: 0 });
const compact = (n) => Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 2 }).format(n || 0);
const sol = (n) => (n >= 1 ? fmt(n, 2) : n >= 0.001 ? fmt(n, 4) : n > 0 ? n.toExponential(2) : '0') + ' SOL';
const usd = (n) => (n > 0 ? '$' + (n >= 1 ? fmt(n, 2) : n >= 0.0001 ? fmt(n, 6) : n.toExponential(2)) : '');
const api = async (path, body) => {
  const r = await fetch(path, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {});
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) throw new Error(j.error || `HTTP ${r.status}`);
  return j;
};

$('spmark').append(pixelWordmark([{ text: 'SPAWN', cls: 'amber', glow: true }]));

/* ---------- live data ---------- */
let data = null, sort = 'new';
async function load() {
  try { data = await api('/spawn.json'); render(); } catch (e) { $('spstate').hidden = false; $('spstate').textContent = 'Could not reach the launchpad. Retrying…'; }
}
setInterval(load, 15000);
load();

function render() {
  const st = $('spstate');
  st.hidden = !!data.open; st.textContent = data.open ? '' : data.reason || 'Opens when $BRAINWORM launches.';
  $('stcoins').textContent = fmt(data.coins.length);
  $('stburn').textContent = compact(data.root?.burned || 0);
  $('stwait').textContent = compact(data.root?.waiting || 0);
  const lb = data.root?.burns?.[0], lbp = $('lastburn');
  lbp.hidden = !lb;
  if (lb) lbp.replaceChildren(`Last burn: ${compact(lb.amount)} $BRAINWORM · `, link(lb.signature));
  if (data.graduationQuote) $('spawnnote').textContent = `No mint or freeze authority, and nothing held back for anyone: all 1,000,000,000 coins are on the curve or go to the graduated pool. It graduates to Meteora DAMM v2 once buyers have put in ${compact(data.graduationQuote)} $BRAINWORM, with its liquidity locked for good. It hatches its own worm, which feels every trade of it, and its buys poke the site's worm at its own spot.`;
  $('stpokes').textContent = fmt(data.pokesToday || 0);
  $('spawnbtn').disabled = !data.open || !connected();
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
  for (const [cls, pct, text] of [['burn', burn, 'burns $BRAINWORM for good'], ['creator', creator, "to the coin's creator"], ['meteora', protocol, 'kept by Meteora']]) {
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
  if (!coins.length) { grid.append(el('p', 'empty', data?.open ? 'No coins yet. Spawn the first one.' : 'No coins yet.')); return; }
  for (const c of coins) {
    const card = el('article', 'coin');
    const img = el('img'); img.alt = ''; img.loading = 'lazy'; img.width = 56; img.height = 56;
    img.src = c.image || (c.own ? `/spawn/worm/${c.mint}.png?t=${c.own.trades}` : '');
    const head = el('div', 'ch'); const t = el('div'); t.append(el('b', null, '$' + c.symbol), el('span', null, c.name)); head.append(img, t);
    const stats = el('dl', 'cs');
    for (const [k, v] of [['Price', c.priceUsd ? usd(c.priceUsd) : sol(c.priceSol)], ['Mcap', sol(c.mcapSol)], ['Its worm', c.own ? `${fmt(c.own.trades)} trades` : 'hatching']]) { const d = el('div'); d.append(el('dt', null, k), el('dd', null, v)); stats.append(d); }
    const prog = el('div', 'prog'); const fill = el('i'); fill.style.transform = `scaleX(${Math.min(1, c.progress || 0)})`; prog.append(fill);
    const foot = el('div', 'cf'); foot.append(el('span', null, c.stage === 'graduating' ? 'Graduating to its Meteora pool…' : c.graduated ? 'Graduated · LP locked' : `${Math.round((c.progress || 0) * 100)}% to graduation`));
    const buy = el('button', 'btn-amber', 'Buy'); buy.type = 'button'; buy.disabled = c.stage === 'graduating'; buy.addEventListener('click', () => openTrade(c));
    foot.append(buy);
    card.append(head, stats, prog, foot);
    grid.append(card);
  }
}

/* ---------- trading: one Jupiter transaction, signed in the visitor's wallet ---------- */
let coin = null, side = 'buy', pay = 'sol', quote = null, quoteTimer = null;
function openTrade(c) {
  coin = c; quote = null;
  $('tradeh').textContent = '$' + c.symbol;
  const pic = c.image || (c.own ? `/spawn/worm/${c.mint}.png?t=${c.own.trades}` : '');
  $('timg').hidden = !pic; if (pic) $('timg').src = pic;
  $('tprice').textContent = `${c.priceUsd ? usd(c.priceUsd) + ' · ' : ''}${sol(c.priceSol)} · priced in $BRAINWORM`;
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
  if (!b.hidden) b.textContent = coin.stage === 'graduated' ? 'Claim your creator fees' : `Claim your ${compact(coin.creatorFees)} $BRAINWORM in creator fees`;
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
  try { const w = await connect(); $('twallet').textContent = short(w.address); $('wconnect').textContent = short(w.address); $('tgo').disabled = !quote; $('spawnbtn').disabled = !data?.open; showClaim(); }
  catch (e) { $('tlog').textContent = e.message; }
});
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
const short = (a) => `${a.slice(0, 4)}…${a.slice(-4)}`;
const link = (sig) => { const a = el('a', null, 'View on Solscan'); a.href = `https://solscan.io/tx/${sig}`; a.target = '_blank'; a.rel = 'noopener'; return a; };

/* ---------- spawning a coin ---------- */
let picData = null;
$('pic').addEventListener('change', async () => {
  const f = $('pic').files[0]; if (!f) return;
  try { picData = await shrink(f); $('wormpick').setAttribute('aria-pressed', 'false'); showPic(picData); }
  catch { $('spawnlog').textContent = 'That picture could not be read.'; }
});
/** Downscale to at most 512 px and re-encode, so uploads stay small. GIFs are kept as they are (up to 1 MB). */
async function shrink(file) {
  if (file.type === 'image/gif') { if (file.size > 1e6) throw new Error('big gif'); return await new Promise((res) => { const r = new FileReader(); r.onload = () => res(r.result); r.readAsDataURL(file); }); }
  const bmp = await createImageBitmap(file);
  const s = Math.min(1, 512 / Math.max(bmp.width, bmp.height)), c = document.createElement('canvas');
  c.width = Math.round(bmp.width * s); c.height = Math.round(bmp.height * s);
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  return c.toDataURL('image/webp', 0.9);
}
$('csym').addEventListener('input', () => { $('csym').value = $('csym').value.replace(/[^A-Za-z0-9]/g, '').toUpperCase(); hatchPreview(); });
$('cname').addEventListener('input', () => { if (!$('csym').dataset.touched) { $('csym').value = $('cname').value.replace(/[^A-Za-z0-9]/g, '').toUpperCase().slice(0, 10); hatchPreview(); } });
// what the coin's worm will see first: its ticker, shown to a fresh worm; the preview is the same picture it will get
let hatchTimer = null;
function hatchPreview() {
  clearTimeout(hatchTimer);
  hatchTimer = setTimeout(async () => {
    const t = $('csym').value, note = $('hatchnote');
    if (!/^[A-Z0-9]{1,10}$/.test(t)) { note.textContent = ''; if (picData === 'worm') showPic(null); return; }
    try {
      const j = await api(`/spawn/hatch/${t}.json`);
      if (t !== $('csym').value) return;
      note.textContent = `Its worm's first sight, "$${t}": ${fmt(j.peak)} cells fire.`;
      if (picData === 'worm') showPic(`/spawn/hatch/${t}.png`);
    } catch { note.textContent = ''; }
  }, 350);
}
function showPic(src) { $('picprev').hidden = !src; $('pictext').hidden = !!src; if (src) $('picprev').src = src; }
$('wormpick').addEventListener('click', () => {
  const on = picData !== 'worm';
  picData = on ? 'worm' : null;
  $('wormpick').setAttribute('aria-pressed', String(on));
  $('pic').value = '';
  showPic(on && /^[A-Z0-9]{1,10}$/.test($('csym').value) ? `/spawn/hatch/${$('csym').value}.png` : null);
  if (on) hatchPreview();
});
$('csym').addEventListener('keydown', () => { $('csym').dataset.touched = '1'; });
$('wconnect').addEventListener('click', async () => {
  try { const w = await connect(); $('wconnect').textContent = short(w.address); $('twallet').textContent = short(w.address); $('spawnbtn').disabled = !data?.open; }
  catch (e) { $('spawnlog').textContent = e.message; }
});
$('spawnform').addEventListener('submit', async (e) => {
  e.preventDefault();
  const log = $('spawnlog');
  if (!connected()) { log.textContent = 'Connect a wallet first.'; return; }
  if (!picData) { log.textContent = 'Add a picture, or use its worm\'s first sight.'; return; }
  try {
    $('spawnbtn').disabled = true; log.textContent = 'Uploading and building the transaction…';
    const j = await api('/spawn/create', { creator: connected().address, name: $('cname').value.trim(), symbol: $('csym').value.trim(), image: picData, firstBuy: $('cbuy').value.trim() || '0' });
    log.textContent = j.firstBuy ? `Check your wallet. Your first buy gets about ${compact(j.firstBuy.coins)} $${$('csym').value}.` : 'Check your wallet.';
    const sig = await signAndSend(j.tx);
    await api('/spawn/created', { mint: j.mint, signature: sig }).catch(() => {});
    log.replaceChildren(`Spawned $${$('csym').value}. `, link(sig));
    setTimeout(load, 4000);
  } catch (err) { log.textContent = err.message; $('spawnbtn').disabled = false; }
});

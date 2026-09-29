// A SPAWN coin's card, on /spawn and on the main page: its picture (or its own worm's latest portrait), its ticker
// and name, price, market cap, what its worm has felt, and how far it is to graduation.
export const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
export const fmt = (n, d = 0) => Number(n || 0).toLocaleString('en-US', { maximumFractionDigits: d, minimumFractionDigits: 0 });
export const compact = (n) => Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 2 }).format(n || 0);
// a tiny price the way traders read it: 0.0000063 is 0.0₅63 (five zeros after the point, then the digits)
const SUB = '₀₁₂₃₄₅₆₇₈₉';
function tiny(n) {
  let e = Math.floor(Math.log10(n)), digits = Math.round(n / 10 ** (e - 2));
  if (digits >= 1000) { e++; digits = Math.round(n / 10 ** (e - 2)); }   // 0.00009996 rounds up to 0.0001
  return `0.0${String(-e - 1).replace(/\d/g, (d) => SUB[d])}${digits}`;
}
export const sol = (n) => (n >= 1 ? fmt(n, 2) : n >= 0.001 ? fmt(n, 4) : n > 0 ? tiny(n) : '0') + ' SOL';
export const usd = (n) => (n > 0 ? '$' + (n >= 1 ? fmt(n, 2) : n >= 0.0001 ? fmt(n, 6) : tiny(n)) : '');
export const coinPicture = (c) => c.image || (c.own ? `/spawn/worm/${c.mint}.png?t=${c.own.trades}` : '');
export const stageText = (c) => (c.stage === 'graduating' ? 'Graduating to its Meteora pool…' : c.graduated ? 'Graduated · LP locked' : `${Math.round((c.progress || 0) * 100)}% to graduation`);

/** The card; its Buy button calls onBuy(c), or links to buyHref when there's no trade window on the page. */
export function coinCard(c, { onBuy = null, buyHref = null } = {}) {
  const card = el('article', 'spcoin');
  const img = el('img'); img.alt = ''; img.loading = 'lazy'; img.width = 56; img.height = 56;
  const src = coinPicture(c); if (src) img.src = src;
  const head = el('div', 'ch'), t = el('div');
  t.append(el('b', null, '$' + c.symbol), el('span', null, c.name));
  head.append(img, t);
  const stats = el('dl', 'cs');
  for (const [k, v] of [['Price', c.priceUsd ? usd(c.priceUsd) : sol(c.priceSol)], ['Mcap', c.mcapSol ? sol(c.mcapSol) : '—'], ['Its worm', c.own ? `${fmt(c.own.trades)} trades` : 'hatching']]) {
    const d = el('div'); d.append(el('dt', null, k), el('dd', null, v)); stats.append(d);
  }
  const prog = el('div', 'prog'), fill = el('i');
  fill.style.transform = `scaleX(${Math.min(1, c.progress || 0)})`;
  prog.append(fill);
  const foot = el('div', 'cf');
  foot.append(el('span', null, stageText(c)));
  let buy;
  if (onBuy) { buy = el('button', 'btn-amber', 'Buy'); buy.type = 'button'; buy.disabled = c.stage === 'graduating'; buy.addEventListener('click', () => onBuy(c)); }
  else { buy = el('a', 'btn-amber', 'Buy'); buy.href = buyHref || `/c/${c.mint}`; }
  foot.append(buy);
  card.append(head, stats, prog, foot);
  return card;
}

// A coin's market cap over time, drawn by hand on a canvas (no library) for its page on SPAWN.
// A coin's price only moves when someone trades it, so the line holds level between trades and eases into each
// trade's new level: a smooth step, never a guess at prices nobody paid. Crisp on any screen, redrawn whenever its
// box resizes, and a crosshair (mouse or finger) snaps to the nearest trade.

const RANGES = { '1h': 3600e3, '6h': 21600e3, '1d': 86400e3, all: Infinity };
const TIME_STEPS = [60e3, 120e3, 300e3, 600e3, 900e3, 1800e3, 3600e3, 7200e3, 10800e3, 21600e3, 43200e3, 86400e3, 172800e3, 604800e3, 1209600e3, 2592000e3];
const UP = [110, 231, 160], DOWN = [255, 107, 94];
const rgba = (c, a) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;
const FONT = '500 10.5px "Geist Mono", ui-monospace, SFMono-Regular, Menlo, monospace';
const clock = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
const day = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });
const stamp = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

/** Round numbers for a value scale: about `n` levels between lo and hi. */
function levels(lo, hi, n) {
  const span = hi - lo;
  if (!(span > 0)) return [lo];
  const raw = span / n, mag = 10 ** Math.floor(Math.log10(raw)), f = raw / mag;
  const step = (f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10) * mag, out = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-9; v += step) out.push(+v.toPrecision(12));
  return out;
}

/** Times for the bottom scale, on whole local minutes, hours or days, about one per 110 px. */
function times(t0, t1, width) {
  const want = Math.max(2, Math.floor(width / 110));
  const step = TIME_STEPS.find((s) => (t1 - t0) / s <= want) || TIME_STEPS[TIME_STEPS.length - 1];
  const off = new Date(t0).getTimezoneOffset() * 60e3, out = [];
  for (let t = Math.ceil((t0 - off) / step) * step + off; t <= t1; t += step) out.push(t);
  return { ticks: out, format: step >= 86400e3 ? day : clock };
}

/**
 * Fills `box` (positioned, with a height) with the chart. value(v) formats a market cap; detail(p) says what a
 * point was, as [text, className] or null. Returns { set(points), setRange(range), view }: points are
 * { t (ms), v, ... }, oldest first; view is what the current range shows ({ first, last, up }), or null.
 */
export function createChart(box, { value = String, detail = () => null } = {}) {
  const cv = document.createElement('canvas'), cx = cv.getContext('2d');
  const tip = document.createElement('div'), live = document.createElement('i');
  cv.className = 'cxcv'; tip.className = 'cxtip'; live.className = 'cxlive';
  tip.hidden = true; live.hidden = true;
  tip.setAttribute('aria-hidden', 'true'); live.setAttribute('aria-hidden', 'true');
  box.append(cv, tip, live);

  let pts = [], range = 'all', W = 0, H = 0, dpr = 1, hx = null, view = null, raf = 0, letGo = 0;

  // the points the range shows, from its left edge (carrying in the level before it) to now
  function compute() {
    const n = pts.length;
    if (!n) return null;
    const t1 = Math.max(Date.now(), pts[n - 1].t);
    let t0 = range === 'all' ? pts[0].t : Math.max(t1 - RANGES[range], pts[0].t);
    if (t1 - t0 < 60e3) t0 = t1 - 60e3;
    const s = [];
    let i = 0;
    while (i < n && pts[i].t < t0) i++;
    if (i > 0) s.push({ t: t0, v: pts[i - 1].v, synthetic: true });
    for (; i < n; i++) s.push(pts[i]);
    s.push({ t: t1, v: s[s.length - 1].v, synthetic: true });
    let lo = Infinity, hi = -Infinity;
    for (const p of s) { if (p.v < lo) lo = p.v; if (p.v > hi) hi = p.v; }
    const pad = (hi - lo) * 0.14 || hi * 0.05 || 1, first = s[0].v, last = s[s.length - 1].v;
    return { s, t0, t1, lo: Math.max(0, lo - pad), hi: hi + pad, first, last, up: last >= first };
  }

  function dot(x, y, r, fill) { cx.beginPath(); cx.arc(x, y, r, 0, Math.PI * 2); cx.fillStyle = fill; cx.fill(); }

  function draw() {
    raf = 0;
    cx.setTransform(1, 0, 0, 1, 0, 0);
    cx.clearRect(0, 0, cv.width, cv.height);
    view = compute();
    if (!view || W < 40 || H < 60) { live.hidden = true; tip.hidden = true; return; }
    cx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const { s, t0, t1, lo, hi, up } = view, col = up ? UP : DOWN;
    cx.font = FONT;
    const ys = levels(lo, hi, H >= 300 ? 5 : 4);
    let lw = 0;
    for (const v of ys) lw = Math.max(lw, cx.measureText(value(v)).width);
    const R = Math.max(40, W - Math.ceil(lw) - 18), T = 16, B = H - 28;
    const X = (t) => ((t - t0) / (t1 - t0)) * R, Y = (v) => B - ((v - lo) / (hi - lo)) * (B - T);
    const crisp = (a) => (Math.round(a * dpr) + 0.5) / dpr;   // a 1-device-pixel line on a pixel, not between two

    // the scale: faint levels with their values on the right, times along the bottom
    cx.lineWidth = 1 / dpr; cx.strokeStyle = 'rgba(46,66,80,.7)'; cx.setLineDash([2, 5]);
    cx.fillStyle = 'rgba(130,152,166,.72)'; cx.textBaseline = 'middle'; cx.textAlign = 'left';
    for (const v of ys) {
      const y = Y(v);
      if (y < T - 6 || y > B + 2) continue;
      cx.beginPath(); cx.moveTo(0, crisp(y)); cx.lineTo(R, crisp(y)); cx.stroke();
      cx.fillText(value(v), R + 10, y);
    }
    cx.setLineDash([]);
    const xs = times(t0, t1, R);
    cx.textAlign = 'center';
    for (const t of xs.ticks) {
      const x = X(t), label = xs.format.format(t), w = cx.measureText(label).width;
      if (x - w / 2 < 2 || x + w / 2 > R - 2) continue;
      cx.fillText(label, x, H - 11);
    }

    // the line: level between trades, easing into each trade's new level; points closer than a pixel merge
    const P = [];
    for (const p of s) {
      const x = X(p.t), y = Y(p.v), q = P[P.length - 1];
      if (q && x - q[0] < 0.75) { q[0] = x; q[1] = y; } else P.push([x, y]);
    }
    const trace = () => {
      cx.beginPath(); cx.moveTo(P[0][0], P[0][1]);
      for (let i = 1; i < P.length; i++) {
        const [x0, y0] = P[i - 1], [x, y] = P[i];
        if (Math.abs(y - y0) < 0.05) { cx.lineTo(x, y); continue; }
        const w = Math.min(16, (x - x0) * 0.85);
        cx.lineTo(x - w, y0);
        cx.bezierCurveTo(x - w * 0.42, y0, x - w * 0.58, y, x, y);
      }
    };
    const [xf] = P[0], [xe, ye] = P[P.length - 1];
    trace();
    cx.lineTo(xe, B); cx.lineTo(xf, B); cx.closePath();
    const g = cx.createLinearGradient(0, T, 0, B);
    g.addColorStop(0, rgba(col, 0.26)); g.addColorStop(0.65, rgba(col, 0.06)); g.addColorStop(1, rgba(col, 0));
    cx.fillStyle = g; cx.fill();
    trace();
    cx.lineWidth = 2; cx.lineJoin = 'round'; cx.lineCap = 'round'; cx.strokeStyle = rgba(col, 1);
    cx.shadowColor = rgba(col, 0.55); cx.shadowBlur = 12;
    cx.stroke();
    cx.shadowBlur = 0; cx.shadowColor = 'transparent';
    dot(xe, ye, 3.5, rgba(col, 1));
    live.hidden = false;
    live.classList.toggle('down', !up);
    live.style.transform = `translate(${xe.toFixed(1)}px,${ye.toFixed(1)}px)`;

    // the crosshair: the nearest trade to the pointer, and what it was
    if (hx == null) { tip.hidden = true; return; }
    let p = null, best = Infinity;
    for (const q of s) { if (q.synthetic) continue; const d = Math.abs(X(q.t) - hx); if (d < best) { best = d; p = q; } }
    if (!p) p = { t: t0 + (Math.max(0, Math.min(R, hx)) / R) * (t1 - t0), v: s[0].v };
    const x = X(p.t), y = Y(p.v);
    cx.lineWidth = 1; cx.strokeStyle = 'rgba(220,231,236,.3)'; cx.setLineDash([3, 4]);
    cx.beginPath(); cx.moveTo(crisp(x), T - 8); cx.lineTo(crisp(x), B); cx.stroke();
    cx.setLineDash([]);
    dot(x, y, 6, 'rgba(4,7,11,.9)');
    dot(x, y, 4, rgba(col, 1));
    const d = detail(p), b = document.createElement('b'), tm = document.createElement('time');
    b.textContent = value(p.v); tm.textContent = stamp.format(p.t);
    tip.replaceChildren(b);
    if (d) { const sp = document.createElement('span'); sp.className = d[1] || ''; sp.textContent = d[0]; tip.append(sp); }
    tip.append(tm);
    tip.hidden = false;
    const tw = tip.offsetWidth, th = tip.offsetHeight;
    let left = x + 14;
    if (left + tw > W - 2) left = x - 14 - tw;
    left = Math.max(2, left);
    const top = Math.max(2, Math.min(H - th - 2, y - th / 2));
    tip.style.transform = `translate(${Math.round(left)}px,${Math.round(top)}px)`;
  }
  const request = () => { if (!raf) raf = requestAnimationFrame(draw); };

  // mouse: follows the pointer; finger: drag along the line (the page still scrolls up and down), and it stays a moment
  const at = (e) => e.clientX - cv.getBoundingClientRect().left;
  const show = (e) => { clearTimeout(letGo); hx = at(e); request(); };
  const hide = () => { clearTimeout(letGo); hx = null; request(); };
  cv.addEventListener('pointermove', show);
  cv.addEventListener('pointerdown', show);
  cv.addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse') hide(); });
  cv.addEventListener('pointercancel', hide);
  cv.addEventListener('pointerup', (e) => { if (e.pointerType !== 'mouse') { clearTimeout(letGo); letGo = setTimeout(hide, 2200); } });

  new ResizeObserver(() => {
    const r = box.getBoundingClientRect();
    W = r.width; H = r.height; dpr = Math.min(3, window.devicePixelRatio || 1);
    cv.width = Math.max(1, Math.round(W * dpr)); cv.height = Math.max(1, Math.round(H * dpr));
    draw();
  }).observe(box);
  document.fonts?.ready?.then(request);

  return {
    set(points) { pts = Array.isArray(points) ? points : []; view = compute(); request(); },
    setRange(r) { if (r in RANGES) { range = r; view = compute(); request(); } },
    get view() { return view; },
  };
}

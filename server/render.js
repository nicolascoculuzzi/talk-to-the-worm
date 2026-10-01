// Renders one activity vector of the worm as a PNG: the real soma positions from data/wiring.json,
// each cell glowing by its own activity. Used for the link preview (scripts/make-og.js) and for the
// launch-moment token image, which anyone can re-render from the replayed log.
//
// Deterministic: no clock, no randomness, fixed iteration order. The same inputs give byte-identical
// PNGs on the same Node version. Pure Node, no dependencies: additive gaussian splats into a float
// buffer, tone-mapped, then a small PNG encoder (zlib from node:zlib).
import zlib from 'node:zlib';
import { GLYPHS, GLYPH_HEIGHT } from '../shared/glyphs.js';

/* ---------- colour ---------- */
const lin = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const enc = (c) => (c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055);
const hex = (h) => [1, 3, 5].map((k) => lin(parseInt(h.slice(k, k + 2), 16) / 255));
const KINDS = ['eye', 'touch', 'sn', 'in', 'mn', 'mus', 'cil', 'other'];
const COL = { eye: '#FFB84D', touch: '#FF9E7A', sn: '#7FC8FF', in: '#B9C9E8', mn: '#C49BFF', mus: '#FF6B5E', cil: '#56E6D2', other: '#6E7F8C' };
const LCOL = KINDS.map((k) => hex(COL[k]));
const DIM = hex('#6F8AA6'), HAZE = hex('#3E7C9A'), WHITE = [1, 1, 1], LINE = hex('#A0C8FF');
const INK = '#DCE7EC', MUTE = '#8298A6', FAINT = '#4E6270', AMBER = '#FFB84D', CORAL = '#FF6B5E';
const NAMED = { ink: INK, mute: MUTE, faint: FAINT, amber: AMBER, coral: CORAL };
function kind(x) { // same as public/app.js
  if (x[6] & 1) return 'eye';
  if (x[6] & 4) return 'touch';
  if (x[6] & 64) return 'cil';
  if (x[1] === 0) return 'sn';
  if (x[1] === 1) return 'in';
  if (x[1] === 2) return 'mn';
  if (x[1] === 3) return /^MUS/.test(x[0]) ? 'mus' : 'other';
  return 'other';
}

/* ---------- per-wiring data, computed once ---------- */
const PREP = new WeakMap();
function prep(D) {
  let p = PREP.get(D);
  if (p) return p;
  const drawn = [], kinds = new Uint8Array(D.n.length), edges = [];
  for (let i = 0; i < D.n.length; i++) { kinds[i] = KINDS.indexOf(kind(D.n[i])); if (D.n[i][5]) drawn.push(i); }
  for (let k = 0; k < D.e.length; k += 3) {
    const a = D.e[k], b = D.e[k + 1];
    if (D.n[a][5] && D.n[b][5] && a !== b) edges.push(a, b, Math.log2(1 + D.e[k + 2]));
  }
  p = { drawn, kinds, edges };
  PREP.set(D, p);
  return p;
}

/* ---------- float canvas with additive gaussian splats ---------- */
function canvas(w, h) { return { w, h, acc: new Float32Array(w * h * 3), ink: new Float32Array(w * h * 4) }; }
let WX = new Float32Array(1024);
function splat(cv, x, y, s, c, a) {
  const R = Math.ceil(s * 3), k = -1 / (2 * s * s), { w, h, acc } = cv;
  const x0 = Math.max(0, Math.floor(x - R)), x1 = Math.min(w - 1, Math.ceil(x + R));
  const y0 = Math.max(0, Math.floor(y - R)), y1 = Math.min(h - 1, Math.ceil(y + R));
  if (x0 > x1 || y0 > y1) return;
  if (WX.length < x1 - x0 + 1) WX = new Float32Array(2 * (x1 - x0 + 1));
  for (let px = x0; px <= x1; px++) { const d = px + 0.5 - x; WX[px - x0] = Math.exp(d * d * k); }
  for (let py = y0; py <= y1; py++) {
    const d = py + 0.5 - y, fy = a * Math.exp(d * d * k);
    if (fy < 1e-5) continue;
    for (let px = x0, o = (py * w + x0) * 3; px <= x1; px++, o += 3) {
      const f = fy * WX[px - x0];
      acc[o] += c[0] * f; acc[o + 1] += c[1] * f; acc[o + 2] += c[2] * f;
    }
  }
}
function line(cv, ax, ay, bx, by, c, a) {
  const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / 0.8));
  for (let t = 0; t <= n; t++) splat(cv, ax + ((bx - ax) * t) / n, ay + ((by - ay) * t) / n, 0.6, c, a);
}

/* ---------- pixel-font text (shared/glyphs.js): square pixels + glow ---------- */
const SUBST = { '…': '...', '·': '-', '•': '-', '–': '-', '—': '-', '‘': "'", '’': "'", '“': '"', '”': '"', '×': 'x' };
const clean = (s) => [...String(s)].map((ch) => SUBST[ch] ?? (GLYPHS[ch] ? ch : '?')).join('');
const textWidth = (s, sc) => [...s].reduce((w, ch) => w + (GLYPHS[ch].length + 1) * sc, -sc);
/** Largest scale <= want that fits maxW; if even scale 1 is too wide, cut the middle to "...". */
function fit(s, want, maxW) {
  s = clean(s);
  let sc = Math.max(1, Math.round(want));
  while (sc > 1 && textWidth(s, sc) > maxW) sc--;
  while (s.length > 5 && textWidth(s, sc) > maxW) { const h = (s.length - 4) >> 1; s = s.slice(0, h) + '...' + s.slice(s.length - h + 1); }
  return { s, sc };
}
function text(cv, s, x, y, sc, color, { glow = 0, gap = 0 } = {}) {
  const c = hex(NAMED[color] || (/^#[0-9a-f]{6}$/i.test(color) ? color : INK));
  for (const ch of s) {
    const cols = GLYPHS[ch];
    cols.forEach((bits, cx) => {
      for (let r = 0; r < GLYPH_HEIGHT; r++) {
        if (!((bits >> r) & 1)) continue;
        const px = x + cx * sc, py = y + r * sc;
        if (glow) splat(cv, px + sc / 2, py + sc / 2, sc * 1.6, c, glow);
        for (let yy = py; yy < py + sc - gap; yy++) {
          for (let xx = px; xx < px + sc - gap; xx++) {
            if (xx < 0 || yy < 0 || xx >= cv.w || yy >= cv.h) continue;
            const o = (yy * cv.w + xx) * 4;
            cv.ink[o] = c[0]; cv.ink[o + 1] = c[1]; cv.ink[o + 2] = c[2]; cv.ink[o + 3] = 1;
          }
        }
      }
    });
    x += (cols.length + 1) * sc;
  }
}
// a title part's colour: its own if given (titleColors), else ink and amber in turn
const titleColor = (o, i) => NAMED[o.titleColors[i]] || (/^#[0-9a-f]{6}$/i.test(o.titleColors[i] || '') ? o.titleColors[i] : i % 2 ? AMBER : INK);
const lineSpec = (l, i) => (typeof l === 'object' && l ? { s: l.text ?? '', color: l.color || (i ? MUTE : INK) } : { s: l ?? '', color: i ? MUTE : INK });

/* ---------- the larva ---------- */
function project(p, cam) {
  const [x, y, z] = p;
  const ca = Math.cos(cam.roll), sa = Math.sin(cam.roll);
  const x1 = x * ca + z * sa, z1 = -x * sa + z * ca;          // roll about the head-tail axis
  const cb = Math.cos(cam.yaw), sb = Math.sin(cam.yaw);
  const u = y * cb + z1 * sb, w1 = -y * sb + z1 * cb;         // head-tail axis along screen x
  const cc = Math.cos(cam.tilt), sc = Math.sin(cam.tilt);
  const v = x1 * cc - w1 * sc, w2 = x1 * sc + w1 * cc;
  const persp = 1 / (1 + w2 * cam.persp);
  const X = cam.flip * u * persp, Y = -v * persp, ct = Math.cos(cam.spin), st = Math.sin(cam.spin);
  return [X * ct - Y * st, X * st + Y * ct, persp];
}

// Each cell's glow is proportional to its own activity. Past EXPOSURE (total activity summed over
// cells) one global gain ~ 1/sqrt(total), and smaller glowing cores, keep a full-body startle from
// washing out to white; total brightness still grows with total activity.
const EXPOSURE = 100;
function drawLarva(cv, D, act, cam, box, size) {
  const { drawn, kinds, edges: E } = prep(D);
  let total = 0;
  for (const i of drawn) total += act[i];
  const g2 = Math.min(1, EXPOSURE / Math.max(total, 1e-9)), gain = Math.sqrt(g2);
  const P = new Float32Array(D.n.length * 3);
  const lo = [1e9, 1e9], hi = [-1e9, -1e9];
  for (const i of drawn) {
    const q = project(D.n[i][5], cam);
    P.set(q, i * 3);
    for (let a = 0; a < 2; a++) { lo[a] = Math.min(lo[a], q[a]); hi[a] = Math.max(hi[a], q[a]); }
  }
  const s = Math.min((box[2] - box[0]) / (hi[0] - lo[0]), (box[3] - box[1]) / (hi[1] - lo[1]));
  const ox = (box[0] + box[2]) / 2 - ((lo[0] + hi[0]) / 2) * s, oy = (box[1] + box[3]) / 2 - ((lo[1] + hi[1]) / 2) * s;
  for (const i of drawn) { P[i * 3] = ox + P[i * 3] * s; P[i * 3 + 1] = oy + P[i * 3 + 1] * s; }

  // connections between active cells: faint, additive, strongest first (stable sort: fixed order)
  const live = [];
  for (let k = 0; k < E.length; k += 3) {
    const f = Math.min(act[E[k]], act[E[k + 1]]);
    if (f > 0.05) live.push([f * E[k + 2], E[k], E[k + 1]]);
  }
  live.sort((p, q) => q[0] - p[0]).length = Math.min(live.length, 1400);
  for (const [f, a, b] of live) line(cv, P[a * 3], P[a * 3 + 1], P[b * 3], P[b * 3 + 1], LINE, Math.min(0.09, 0.02 * f) * size.line * gain);

  // cells: resting faint and small, active bright with a white-hot core and a wide halo
  const bloomA = size.bloomA * g2;
  // for a big image, the wide glows are drawn at 1/lowres resolution and scaled up: same look, much faster
  const wide = size.lowres ? canvas(Math.ceil(cv.w / size.lowres) + 1, Math.ceil(cv.h / size.lowres) + 1) : null;
  for (const i of drawn) {
    const k = KINDS[kinds[i]], c = LCOL[kinds[i]], v = Math.min(1, act[i]), pz = P[i * 3 + 2];
    const x = P[i * 3], y = P[i * 3 + 1], depth = Math.min(1.25, pz) ** 2;
    const rest = k === 'eye' ? 0.7 : k === 'touch' ? 0.34 : 0.2;
    const rc = c.map((q, j) => q * 0.55 + DIM[j] * 0.45), blur = 1 + Math.max(0, 1 - pz) * size.dof;
    if (wide) splat(wide, x / size.lowres, y / size.lowres, size.haze / size.lowres, HAZE, size.hazeA);
    else splat(cv, x, y, size.haze, HAZE, size.hazeA);
    splat(cv, x, y, size.core * pz * blur * (k === 'eye' ? 1.2 : 0.85), rc, (rest * size.rest * depth) / blur);
    if (v > 0.02) {
      splat(cv, x, y, size.core * pz * (1 + 2 * v * gain), c, 2.6 * v * depth * gain);
      splat(cv, x, y, size.core * pz * 0.8, WHITE, 1.4 * v * v * depth * g2);
      splat(cv, x, y, size.halo * pz, c, 0.16 * v * depth * gain);
      if (wide) splat(wide, x / size.lowres, y / size.lowres, size.bloom / size.lowres, c, bloomA * v);
      else splat(cv, x, y, size.bloom, c, bloomA * v);
    }
  }
  if (wide) addUpsampled(cv, wide, size.lowres);
  // centre of activity, for the background light (the middle of the box when nothing is active)
  let sx = 0, sy = 0, sw = 0;
  for (const i of drawn) { sx += P[i * 3] * act[i]; sy += P[i * 3 + 1] * act[i]; sw += act[i]; }
  return sw > 0 ? { cx: sx / sw, cy: sy / sw } : { cx: (box[0] + box[2]) / 2, cy: (box[1] + box[3]) / 2 };
}

/* ---------- compose: background, tone map, text, vignette, dither ---------- */
// 2x2 ordered dither: breaks up banding in the dark gradients and, unlike random noise, compresses well
const BAYER = [-0.375, 0.125, 0.375, -0.125];
/** Add a coarse light buffer (1/f resolution) into the full-size one, bilinearly interpolated. */
function addUpsampled(cv, lo, f) {
  for (let y = 0; y < cv.h; y++) {
    const v = Math.max(0, (y + 0.5) / f - 0.5), y0 = Math.min(lo.h - 2, Math.floor(v)), ty = v - y0;
    for (let x = 0; x < cv.w; x++) {
      const u = Math.max(0, (x + 0.5) / f - 0.5), x0 = Math.min(lo.w - 2, Math.floor(u)), tx = u - x0;
      const a = (y0 * lo.w + x0) * 3, b = a + lo.w * 3, o = (y * cv.w + x) * 3;
      for (let ch = 0; ch < 3; ch++) {
        const top = lo.acc[a + ch] + (lo.acc[a + 3 + ch] - lo.acc[a + ch]) * tx, bot = lo.acc[b + ch] + (lo.acc[b + 3 + ch] - lo.acc[b + ch]) * tx;
        cv.acc[o + ch] += top + (bot - top) * ty;
      }
    }
  }
}
/** Dim the light below y0 (smoothly, fully from y1 on) so text there stays legible over the larva. */
function shade(cv, y0, y1, strength) {
  for (let y = Math.max(0, Math.floor(y0)); y < cv.h; y++) {
    const t = Math.min(1, (y - y0) / (y1 - y0)), m = 1 - strength * t * t * (3 - 2 * t);
    for (let o = y * cv.w * 3, end = o + cv.w * 3; o < end; o++) cv.acc[o] *= m;
  }
}
function finish(cv, { cx, cy }) {
  const { w, h, acc, ink } = cv, out = Buffer.alloc(w * h * 3);
  const deep = hex('#0E1C27'), mid = hex('#0A121A'), abyss = hex('#04070B'), R = Math.hypot(w, h) / 2;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = y * w + x, d = Math.min(1, Math.hypot((x - cx) / 1.25, y - cy) / R);
      const t1 = Math.min(1, d / 0.45), t2 = Math.max(0, (d - 0.45) / 0.55);
      const vig = 1 - 0.35 * Math.max(0, Math.hypot((x - w / 2) / w, (y - h / 2) / h) * 1.7 - 0.25) ** 1.5;
      for (let ch = 0; ch < 3; ch++) {
        const bg = d < 0.45 ? deep[ch] + (mid[ch] - deep[ch]) * t1 : mid[ch] + (abyss[ch] - mid[ch]) * t2;
        let v = 1 - (1 - bg) * Math.exp(-acc[o * 3 + ch]);
        const a = ink[o * 4 + 3];
        if (a) v = v * (1 - a) + ink[o * 4 + ch] * a;
        out[o * 3 + ch] = Math.max(0, Math.min(255, Math.round(enc(v * vig) * 255 + BAYER[(y & 1) * 2 + (x & 1)])));
      }
    }
  }
  return out;
}

/* ---------- PNG (8-bit RGB) ---------- */
const CRC = new Int32Array(256).map((_, n) => { for (let k = 0; k < 8; k++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1; return n; });
const crc32 = (buf) => { let c = -1; for (const b of buf) c = CRC[(c ^ b) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; };
function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0); out.write(type, 4, 'latin1'); data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}
/** Encode 8-bit RGB pixels; each row gets the filter with the smallest sum of |residuals|. */
export function encodePNG(w, h, rgb, level = 9) {
  const stride = w * 3, raw = Buffer.alloc((stride + 1) * h), rows = [0, 1, 2, 3, 4].map(() => Buffer.alloc(stride));
  for (let y = 0; y < h; y++) {
    const cur = rgb.subarray(y * stride, (y + 1) * stride), up = y ? rgb.subarray((y - 1) * stride, y * stride) : null;
    let bestType = 0, bestCost = Infinity;
    for (let type = 0; type < 5; type++) {
      const row = rows[type];
      let cost = 0;
      for (let i = 0; i < stride; i++) {
        const a = i >= 3 ? cur[i - 3] : 0, b = up ? up[i] : 0, c = i >= 3 && up ? up[i - 3] : 0;
        let pred = 0;
        if (type === 1) pred = a;
        else if (type === 2) pred = b;
        else if (type === 3) pred = (a + b) >> 1;
        else if (type === 4) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
        const f = (cur[i] - pred) & 255;
        row[i] = f; cost += f < 128 ? f : 256 - f;
      }
      if (cost < bestCost) { bestCost = cost; bestType = type; }
    }
    raw[y * (stride + 1)] = bestType; rows[bestType].copy(raw, y * (stride + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level })), chunk('IEND', Buffer.alloc(0))]);
}

/* ---------- layouts (coordinates at the native size; other sizes scale them) ---------- */
// plan(words) -> {box: where the larva goes, scrim?: [y0, y1, strength] shade behind text}; text() draws the words
const LAYOUTS = {
  // link preview: larva horizontal on the right, head on the left facing the stacked title
  og: {
    w: 1200, h: 630, level: 9,
    cam: { roll: -0.25, yaw: 0.35, tilt: 0.2, persp: 0.35, flip: -1, spin: -0.08 },
    size: { core: 2, halo: 11, bloom: 44, bloomA: 0.026, line: 1.2, haze: 18, hazeA: 0.005, dof: 4, rest: 1 },
    plan: () => ({ box: [618, 56, 1165, 540] }),
    text(cv, o, X, Y, k) {
      const top = 96;
      if (o.badge) {
        splat(cv, X(76), Y(top + 13), 4.5 * k, hex(CORAL), 1.6);
        const b = fit(o.badge, 2 * k, X(440));
        text(cv, b.s, X(92), Y(top), b.sc, CORAL);
      }
      o.title.forEach((part, i) => {
        const t = fit(part, 9 * k, X(520)), c = titleColor(o, i);
        text(cv, t.s, X(64), Y(top + 26 + i * 128), t.sc, c, { glow: c === AMBER ? 0.03 : 0.005, gap: t.sc >= 5 ? 1 : 0 });
      });
      const y0 = top + 26 + o.title.length * 128 + 64;
      o.lines.forEach((l, i) => {
        const { s, color } = lineSpec(l, i), t = fit(s, 2 * k, X(580));
        text(cv, t.s, X(64), Y(y0 + i * 38), t.sc, color);
      });
      if (o.footnote) {
        const t = fit(o.footnote, k, X(1076));
        text(cv, t.s, X(1140) - textWidth(t.s, t.sc), Y(550), t.sc, FAINT);
      }
    },
  },
  // token image: larva upright, head up, seen from its back (so its left is on screen-left), title below
  square: {
    w: 1000, h: 1000,
    cam: { roll: 0.5, yaw: 0.45, tilt: 0, persp: 0.35, flip: -1, spin: Math.PI / 2 },
    level: 7, // zlib level 9 is ~4x slower on this image for ~5% smaller output
    size: { core: 2.6, halo: 14, bloom: 56, bloomA: 0.026, line: 1.4, haze: 24, hazeA: 0.005, dof: 4, rest: 1, lowres: 4 },
    // text stacks up from the bottom (footnote, lines, title); the larva ends just below the title's top
    plan(o) {
      const lines = o.lines.slice(0, 3), last = o.footnote ? 868 : 900, first = last - (lines.length - 1) * 46;
      const top = lines.length ? first - 130 : o.footnote ? 784 : 820;
      if (!o.title.length && !lines.length && !o.footnote) return { box: [150, 72, 850, 928] };
      return { lines, first, top, box: [150, 72, 850, Math.min(850, top + 80)], scrim: [top - 90, top + 150, 0.92] };
    },
    text(cv, o, X, Y, k, { lines = [], first, top }) {
      const centre = (t, y, color, opt) => text(cv, t.s, Math.round((cv.w - textWidth(t.s, t.sc)) / 2), Y(y), t.sc, color, opt);
      if (o.badge) {
        splat(cv, X(68), Y(69), 6 * k, hex(CORAL), 1.6);
        const b = fit(o.badge, 3 * k, X(600));
        text(cv, b.s, X(88), Y(50), b.sc, CORAL);
      }
      if (o.footnote) centre(fit(o.footnote, 2 * k, X(900)), 932, FAINT);
      lines.forEach((l, i) => { const { s, color } = lineSpec(l, i); centre(fit(s, 3 * k, X(880)), first + i * 46, color); });
      if (o.title.length) {
        const t = fit(o.title.join(''), 8 * k, X(856));
        let x = Math.round((cv.w - textWidth(t.s, t.sc)) / 2), from = 0;
        o.title.forEach((part, i) => {
          const s = t.s.slice(from, from + clean(part).length); from += s.length;
          if (!s) return;
          const c = titleColor(o, i);
          text(cv, s, x, Y(top), t.sc, c, { glow: c === AMBER ? 0.03 : 0.006, gap: t.sc >= 5 ? 1 : 0 });
          x += textWidth(s, t.sc) + t.sc;
        });
      }
    },
  },
  // social header (X, 1500x500): the og picture made wide, larva on the right, title and lines on the left
  banner: {
    w: 1500, h: 500, level: 9,
    cam: { roll: -0.25, yaw: 0.35, tilt: 0.2, persp: 0.35, flip: -1, spin: -0.08 },
    size: { core: 2, halo: 11, bloom: 44, bloomA: 0.026, line: 1.2, haze: 18, hazeA: 0.005, dof: 4, rest: 1 },
    plan: () => ({ box: [790, 10, 1480, 490] }),
    text(cv, o, X, Y, k) {
      const top = 72;
      if (o.badge) {
        splat(cv, X(76), Y(top + 13), 4.5 * k, hex(CORAL), 1.6);
        const b = fit(o.badge, 2 * k, X(440));
        text(cv, b.s, X(92), Y(top), b.sc, CORAL);
      }
      o.title.forEach((part, i) => {
        const t = fit(part, 7 * k, X(640)), c = titleColor(o, i);
        text(cv, t.s, X(64), Y(top + 26 + i * 100), t.sc, c, { glow: c === AMBER ? 0.03 : 0.005, gap: t.sc >= 5 ? 1 : 0 });
      });
      const y0 = top + 26 + o.title.length * 100 + 30;
      o.lines.forEach((l, i) => {
        const { s, color } = lineSpec(l, i), t = fit(s, 2 * k, X(700));
        text(cv, t.s, X(64), Y(y0 + i * 34), t.sc, color);
      });
      if (o.footnote) {
        const t = fit(o.footnote, k, X(700));
        text(cv, t.s, X(64), Y(462), t.sc, FAINT);
      }
    },
  },
  // home-screen icon: larva upright, head up, seen from its back (its left on screen-left), no text
  icon: {
    w: 180, h: 180, level: 9,
    cam: { roll: 0, yaw: 0, tilt: -0.3, persp: 0.35, flip: -1, spin: Math.PI / 2 },
    size: { core: 1, halo: 4, bloom: 16, bloomA: 0.008, line: 0.5, haze: 6, hazeA: 0.012, dof: 1, rest: 0.5 },
    plan: () => ({ box: [30, 20, 150, 160] }),
    text() {},
  },
};
export const LAYOUT_NAMES = Object.keys(LAYOUTS);

/**
 * Render one moment of the worm.
 * @param {object} o
 * @param {{n: any[], e: number[]}} o.D wiring data (data/wiring.json)
 * @param {ArrayLike<number>} o.act per-cell activity indexed like D.n: 0..1, or 0..255 for a Uint8Array
 * @param {'square'|'og'|'banner'|'icon'} [o.layout='square'] square 1000x1000 token image, og 1200x630 link preview, banner 1500x500 social header, icon 180x180
 * @param {number} [o.width] output size; defaults to the layout's own, other sizes scale the layout
 * @param {number} [o.height]
 * @param {string[]} [o.title=['BRAIN','WORM']] title parts, alternately ink and amber
 * @param {string[]} [o.titleColors=[]] a colour per title part instead ('ink', 'amber', … or '#RRGGBB')
 * @param {Array<string|{text: string, color?: string}>} [o.lines=[]] small lines under the title (first ink, then mute;
 *   color: 'ink' | 'mute' | 'faint' | 'amber' | 'coral' | '#RRGGBB'); the square shows up to 3
 * @param {string} [o.footnote=''] tiny line at the bottom
 * @param {string} [o.badge=''] e.g. 'LIVE': coral dot and label above the title
 * @returns {Buffer} PNG, 8-bit RGB
 */
export function renderActivityPNG({ D, act, layout = 'square', width, height, title = ['BRAIN', 'WORM'], titleColors = [], lines = [], footnote = '', badge = '' } = {}) {
  const L = LAYOUTS[layout];
  if (!L) throw new Error(`unknown layout "${layout}" (use ${LAYOUT_NAMES.join(', ')})`);
  if (!D || !Array.isArray(D.n) || !D.e) throw new Error('D must be the wiring data {n, e}');
  const W = Math.round(width || (height ? (height * L.w) / L.h : L.w)), H = Math.round(height || (W * L.h) / L.w);
  if (!(W >= 16 && H >= 16 && W <= 4096 && H <= 4096)) throw new Error('width and height must be 16..4096');
  const N = D.n.length, a = new Float32Array(N), u8 = act instanceof Uint8Array || act instanceof Uint8ClampedArray;
  for (let i = 0; i < N && act && i < act.length; i++) { const v = u8 ? act[i] / 255 : +act[i]; a[i] = v > 0 ? (v < 1 ? v : 1) : 0; }

  const sx = W / L.w, sy = H / L.h, k = Math.min(sx, sy);
  const X = (v) => (sx === 1 ? v : Math.round(v * sx)), Y = (v) => (sy === 1 ? v : Math.round(v * sy));
  const size = {};
  for (const [key, v] of Object.entries(L.size)) size[key] = /A$|^line$|^dof$|^rest$|^lowres$/.test(key) ? v : v * k;
  const words = { title: [].concat(title ?? []).map(String).filter(Boolean), titleColors: [].concat(titleColors ?? []), lines: [].concat(lines ?? []), footnote: footnote ? String(footnote) : '', badge: badge ? String(badge) : '' };
  const plan = L.plan(words), { box, scrim } = plan;
  const cv = canvas(W, H);
  const glow = drawLarva(cv, D, a, L.cam, [box[0] * sx, box[1] * sy, box[2] * sx, box[3] * sy], size);
  if (scrim) shade(cv, scrim[0] * sy, scrim[1] * sy, scrim[2]);
  L.text(cv, words, X, Y, k, plan);
  return encodePNG(W, H, finish(cv, glow), L.level);
}

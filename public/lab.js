// The /lab page: every registered test of the worm, the rule written down before it ran, its verdict,
// and its numbers against the rewired copies of the wiring. It shows only what the server's files say:
//   /lab.json                           the lab as this server ran it (shared/lab.js on the current model)
//   /data/lab-model-v1.json             the retired model v1's published results
//   /data/registrations/model-v2.json   the registration record; the .ots next to it is its Bitcoin timestamp
//   /data/lab-model-v2-first-run.json   the current model's first run, to compare the results hash
//   /manifest.json, /config.json        every number the model uses; what the live worm runs
//   /shared/model.js                    the registered model: what v1 was, and why it was replaced
// A missing field shows as a dash or is left out, never filled in. The CSP allows no inline styles, so
// positions and widths are set through the CSSOM (element.style), never through style attributes.

const $ = (id) => document.getElementById(id);
const NS = 'http://www.w3.org/2000/svg';
const MINUS = '−';
const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const reduced = () => !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
const report = (what) => (e) => console.error(`[lab] ${what}:`, e);
function attempt(what, fn, fallback = null) {
  try { return fn(); } catch (e) { report(what)(e); return fallback; }
}

/* ---------- DOM ---------- */
function add(node, kids) {
  for (const k of kids.flat(Infinity)) if (k !== null && k !== undefined && k !== false && k !== '') node.append(k instanceof Node ? k : String(k));
  return node;
}
function el(tag, cls, ...kids) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  return add(e, kids);
}
function sv(tag, attrs, ...kids) {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs || {})) if (v !== null && v !== undefined) e.setAttribute(k, String(v));
  return add(e, kids);
}
function a(href, text, cls) {
  const x = el('a', cls, text);
  x.href = href;
  return x;
}
function ext(href, text) {
  const x = a(href, text);
  x.target = '_blank';
  x.rel = 'noopener';
  return x;
}
const kv = (label, ...vals) => el('div', null, el('dt', null, label), el('dd', null, ...vals));
const ICONS = { check: 'M2.5 6.3l2.4 2.4 4.6-5', cross: 'M3.2 3.2l5.6 5.6M8.8 3.2l-5.6 5.6', dash: 'M3 6h6', chev: 'M3 4.5l3 3 3-3' };
const icon = (name, cls = 'ic') => sv('svg', { viewBox: '0 0 12 12', class: cls, 'aria-hidden': 'true', focusable: 'false' }, sv('path', { d: ICONS[name] || ICONS.dash }));
const check = (ok, yes, no) => el('span', 'chk ' + (ok ? 'ok' : 'bad'), icon(ok ? 'check' : 'cross'), ok ? yes : no);

/* ---------- numbers and words ---------- */
/** A number as the lab writes it: 4 significant digits, trailing zeros dropped, a true minus sign. */
function num(x, d = 4) {
  if (typeof x !== 'number') return x === null || x === undefined ? '—' : String(x);
  if (Number.isNaN(x)) return '—';
  if (!Number.isFinite(x)) return (x < 0 ? MINUS : '') + '∞';
  const ax = Math.abs(x);
  let s;
  if (Number.isInteger(x)) s = ax.toLocaleString('en-US');
  else {
    s = ax.toPrecision(d);
    if (s.includes('e')) s = s.replace(/\.?0+e/, 'e').replace('e+', 'e');
    else {
      if (s.includes('.')) s = s.replace(/0+$/, '').replace(/\.$/, '');
      const [i, f] = s.split('.');
      if (i.length > 3) s = Number(i).toLocaleString('en-US') + (f ? '.' + f : '');
    }
  }
  return (x < 0 && /[1-9]/.test(s) ? MINUS : '') + s;
}
/** A number exactly as published (for the manifest and the registered protocol values). */
const exact = (x) => (Number.isInteger(x) ? (x < 0 ? MINUS : '') + Math.abs(x).toLocaleString('en-US') : String(x).replace('-', MINUS));
const plain = (v) => (v === null || v === undefined ? '—' : typeof v === 'number' ? String(v).replace('-', MINUS) : Array.isArray(v) ? `(${v.map(plain).join(', ')})` : isObj(v) ? JSON.stringify(v) : String(v));
const pct = (f, d = 3) => (isNum(f) ? num(f * 100, d) + '%' : '—');
const cap = (s) => (typeof s === 'string' && s ? s[0].toUpperCase() + s.slice(1) : s);
const short = (h, n = 12) => (typeof h === 'string' && h ? (h.length > n ? h.slice(0, n) + '…' : h) : '—');
const pad2 = (n) => String(n).padStart(2, '0');
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function when(iso, time = true) {
  if (!iso) return '—';
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return String(iso);
  const day = `${t.getUTCDate()} ${MON[t.getUTCMonth()]} ${t.getUTCFullYear()}`;
  return time ? `${day}, ${pad2(t.getUTCHours())}:${pad2(t.getUTCMinutes())} UTC` : day;
}
const glyphName = (g) => (g === ' ' ? 'space' : `“${g}”`);
const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function verdictOf(v) {
  if (v === 'passes') return { cls: 'pass', text: 'Passes', icon: 'check' };
  if (v === 'fails') return { cls: 'fail', text: 'Fails', icon: 'cross' };
  if (typeof v === 'string' && v) return { cls: 'other', text: cap(v), icon: 'dash' };
  return { cls: 'other', text: 'Not run', icon: 'dash' };
}
const badge = (v, extra = '') => el('span', `lbbadge ${v.cls}${extra ? ' ' + extra : ''}`, icon(v.icon), el('span', null, v.text));

/* ---------- loading ---------- */
async function fetchJSON(url, { fresh = false, timeout = 12000 } = {}) {
  const ctl = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = ctl ? setTimeout(() => ctl.abort(), timeout) : 0;
  try {
    const r = await fetch(url, { cache: fresh ? 'no-store' : 'default', signal: ctl ? ctl.signal : undefined });
    let body = null;
    try { body = await r.json(); } catch { body = null; }
    return { ok: r.ok, status: r.status, body };
  } finally {
    clearTimeout(timer);
  }
}
const optional = (url) => fetchJSON(url).then((r) => (r.ok && isObj(r.body) ? r.body : null), () => null);

async function sha256Hex(text) {
  if (typeof text !== 'string' || !globalThis.crypto?.subtle) return null;
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** The registered protocols by id, from the exact text whose SHA-256 is the protocol fingerprint. */
function protocolsById(json) {
  const m = new Map();
  if (typeof json !== 'string') return m;
  try {
    const list = JSON.parse(json);
    if (Array.isArray(list)) for (const p of list) if (isObj(p) && p.id) m.set(p.id, p);
  } catch { /* each result also carries its own copy */ }
  return m;
}
function regHash(reg, re) {
  if (!isObj(reg?.sha256)) return null;
  for (const [k, h] of Object.entries(reg.sha256)) if (re.test(k) && typeof h === 'string') return h;
  return null;
}

/* ---------- what each kind of test measures (the rule text itself is always shown as registered) ---------- */
const P95NOTE = (r) => (isNum(r.control?.n) ? `p95 of the ${r.control.n} rewired copies` : 'p95 of the rewired copies');
function umPer(r) {   // µm per model unit, from the result's own numbers
  const x = r.real?.attraction, u = r.real?.attractionUm;
  if (isNum(x) && isNum(u) && x !== 0) return u / x;
  const c = r.control?.p95, cu = r.details?.controlUm?.p95;
  return isNum(c) && isNum(cu) && c !== 0 ? cu / c : null;
}
const inUm = (r) => { const f = umPer(r); return (x) => (isNum(x) ? (f ? `${num(x * f, 3)} µm` : num(x)) : '—'); };

function cond(label, measured, op, threshold, { show = (x) => num(x), note = null, published } = {}) {
  let met = null;
  if (typeof published === 'boolean') met = published;   // the lab's own record of the condition wins
  else if (isNum(measured) && isNum(threshold)) met = op === '>' ? measured > threshold : measured >= threshold;
  return { label, measured, op, threshold, show, note, met };
}
const gt = (label, m, t, o) => cond(label, m, '>', t, o);
const ge = (label, m, t, o) => cond(label, m, '≥', t, o);

function touchConds(r, P) {
  const R = r.real || {}, c = r.details?.conditions || {}, ratio = P.params?.ratio, out = [];
  if (isNum(ratio)) out.push(ge(`Touch at least ${num(ratio)}× the other senses`, R.touch, isNum(R.other) ? ratio * R.other : null, { note: `${num(ratio)} × ${num(R.other)}, the other senses`, published: c.atLeastRatioTimesOther }));
  out.push(gt('Touch above the rewired copies', R.touch, r.control?.p95, { note: P95NOTE(r), published: c.aboveScrambleP95 }));
  return out;
}
function crConds(r, P) {
  const R = r.real || {}, c = r.details?.conditions || {}, ratio = P.params?.ratio, ac = r.details?.arrestControl, out = [];
  if (isNum(ratio)) out.push(ge(`Startle at least ${num(ratio)}× the other senses`, R.startle, isNum(R.otherStartle) ? ratio * R.otherStartle : null, { note: `${num(ratio)} × ${num(R.otherStartle)}, the other senses`, published: c.startleSpecific }));
  out.push(gt('Startle above the rewired copies', R.startle, r.control?.p95, { note: P95NOTE(r), published: c.startleAboveScrambles }));
  if (isNum(ratio)) out.push(ge(`Cilia arrest at least ${num(ratio)}× the other senses`, R.arrest, isNum(R.otherArrest) ? ratio * R.otherArrest : null, { note: `${num(ratio)} × ${num(R.otherArrest)}, the other senses`, published: c.arrestSpecific }));
  out.push(gt('Cilia arrest above the rewired copies', R.arrest, ac?.p95, { note: isNum(ac?.n) ? `p95 of the ${ac.n} rewired copies' arrest` : "p95 of the rewired copies' arrest", published: c.arrestAboveScrambles }));
  return out;
}

const KINDS = {
  'eyes-sides': {
    what: 'lateralization', value: (r) => r.real?.lateralization,
    conds: (r) => [gt('Lateralization above the rewired copies', r.real?.lateralization, r.control?.p95, { note: P95NOTE(r) })],
    extra: eyesParts,
  },
  'touch-startle': {
    what: 'startle-muscle peak', value: (r) => r.real?.touch, conds: touchConds, extra: touchDraws,
    short: (r) => `touch ${num(r.real?.touch)} · rewired p95 ${num(r.control?.p95)}`,
  },
  'touch-startle-single': {
    what: 'mean startle-muscle peak', value: (r) => r.real?.touch, conds: touchConds, extra: touchSingles,
    short: (r) => `touch ${num(r.real?.touch)} · rewired p95 ${num(r.control?.p95)}`,
  },
  'light-latency': {
    what: 'latency', value: (r) => r.real?.steps, unit: ' steps', none: 'no response',
    pctText: (p) => `${num(p, 3)}% of the rewired copies were faster (ties count half)`,
    short: (r) => (r.real?.steps === null
      ? `no response · rewired mean ${num(r.control?.mean, 3)} steps`
      : `${num(r.real?.steps)} steps (${num(r.real?.ms, 3)} ms) · rewired mean ${num(r.control?.mean, 3)}`),
    extra: latencyNotes,
  },
  phototaxis: {
    what: 'attraction', value: (r) => r.real?.attraction, k: umPer, unit: (r) => (umPer(r) ? ' µm' : ''), zero: true, digits: 3,
    conds: (r) => {
      const show = inUm(r);
      return [
        gt('Attraction above 0', r.real?.attraction, 0, { show, note: 'positive = it stayed closer when the lamp was lit' }),
        gt('Attraction above the rewired copies', r.real?.attraction, r.control?.p95, { show, note: P95NOTE(r) }),
      ];
    },
    short: (r) => {
      const f = umPer(r), x = r.real?.attraction, p = r.control?.p95;
      return f && isNum(x) && isNum(p) ? `${num(Math.abs(x * f), 3)} µm ${x >= 0 ? 'closer' : 'farther'} · rewired p95 ${num(p * f, 3)} µm` : null;
    },
    extra: lampNotes,
  },
  'eyespot-cilia': {
    what: 'laterality', value: (r) => r.real?.laterality, zero: true,
    conds: (r) => [
      gt('Laterality above 0', r.real?.laterality, 0, { note: "positive = the lit side's cilia stop more" }),
      gt('Laterality above the rewired copies', r.real?.laterality, r.control?.p95, { note: P95NOTE(r) }),
    ],
    extra: eyespotNotes,
  },
  'cr-startle': {
    what: 'startle-muscle peak', value: (r) => r.real?.startle, conds: crConds, extra: crArrest,
    short: (r) => `startle ${num(r.real?.startle)} · rewired p95 ${num(r.control?.p95)}`,
  },
  'mc-burst': {
    what: 'share of ciliated cells stopped at once', value: (r) => r.real?.peak, k: () => 100, unit: '%',
    short: (r) => `${pct(r.real?.peak)} of cilia stop at once · rewired mean ${pct(r.control?.mean)}`,
    extra: bands,
  },
  alphabet: {
    short: (r) => { const t = r.real?.top?.[0]; return isObj(t) ? `${glyphName(t.glyph)} fires the most: ${num(t.peak)} cells` : null; },
    extra: alphabetRank,
  },
  fatigue: {
    short: (r) => { const p = r.real?.peaks; return Array.isArray(p) && p.length > 1 && isNum(r.real?.ratio) ? `poke ${p.length} fires ${pct(r.real.ratio)} of poke 1's cells` : null; },
    extra: fatigueTable,
  },
};

/** A test kind this page doesn't know yet: the real value is the one field whose percentile matches the published one. */
function percentileOf(values, x) {
  let below = 0, eq = 0;
  for (const v of values) { const V = v === null ? Infinity : v; if (V < x) below++; else if (V === x) eq++; }
  return values.length ? (100 * (below + eq / 2)) / values.length : null;
}
function guessValue(r) {
  const vals = r.control?.values, pc = r.percentile;
  if (!Array.isArray(vals) || !isNum(pc) || !isObj(r.real)) return undefined;
  const hits = new Set(Object.values(r.real).filter((x) => isNum(x) && Math.abs(percentileOf(vals, x) - pc) < 1e-9));
  return hits.size === 1 ? [...hits][0] : undefined;
}
const GENERIC = { what: 'the measured value', value: guessValue };

const titleOf = (r, i) => r.title || r.id || `Test ${i + 1}`;
const cardId = (prefix, r, i) => prefix + (r.id ? String(r.id).replace(/[^A-Za-z0-9_-]/g, '-') : `test-${i + 1}`);
const protoOf = (r, ctx) => ctx.protos?.get(r.id) || (isObj(r.protocol) ? r.protocol : {});
const specOf = (r, P) => KINDS[P.kind] || KINDS[r.id] || GENERIC;
const kOf = (spec, r) => { const k = spec.k ? spec.k(r) : 1; return isNum(k) && k !== 0 ? k : 1; };
const unitOf = (spec, r) => (typeof spec.unit === 'function' ? spec.unit(r) : spec.unit || '');

function shortLine(r, P, spec) {
  if (spec.short) { const s = attempt('short ' + r.id, () => spec.short(r, P)); if (s) return s; }
  const v = spec.value ? attempt('value ' + r.id, () => spec.value(r)) : undefined, p95 = r.control?.p95;
  if (isNum(v) && isNum(p95)) return `real ${num(v)} · rewired p95 ${num(p95)}`;
  const s = typeof r.summary === 'string' ? r.summary.split(/[;:]\s/)[0] : '';
  return s.length > 96 ? s.slice(0, 94) + '…' : s;
}

/* ---------- loading the lab ---------- */
let retryTimer = 0;
async function loadLab() {
  clearTimeout(retryTimer);
  let res = null;
  try { res = await fetchJSON('/lab.json', { fresh: true, timeout: 15000 }); } catch { res = null; }
  const d = res?.body;
  if (d && Array.isArray(d.results)) {
    try { await renderLab(d); } catch (e) { report('lab')(e); waiting('Something went wrong drawing the results. The raw data is at /lab.json.'); }
    return;
  }
  if (!res) return waiting('Could not reach the server. Trying again…', null, 5000);
  if (res.status === 404 || d?.state === 'off') return waiting('The lab is switched off on this server.');
  if (d?.state === 'error') return waiting('The lab could not run on this server. It runs again after a restart.', null, 30000);
  if (d?.state === 'stopped') return waiting('The lab was stopped on this server.', null, 30000);
  waiting('Running the tests… (about 20 s after a restart)', d?.progress?.fraction, 5000, d?.progress?.id);
}

function waiting(text, fraction = null, retryMs = 0, current = null) {
  const li = el('li', 'lbwait', el('p', null, text));
  if (isNum(fraction)) {
    const f = Math.max(0, Math.min(1, fraction)), bar = el('i');
    bar.style.width = `${Math.round(f * 100)}%`;
    li.append(el('div', 'progress', bar), el('p', 'small', `${Math.round(f * 100)}%${current ? ` · ${current}` : ''}`));
  }
  $('rows').replaceChildren(li);
  $('tallyline').textContent = text;
  const note = $('cardnote');
  if (note) note.textContent = text;
  if (retryMs > 0) retryTimer = setTimeout(loadLab, retryMs);
}

async function renderLab(lab) {
  const [v1, reg, cfg, model] = await Promise.all([v1P, regP, configP, modelP]);
  const results = lab.results.filter(isObj);
  const protos = protocolsById(lab.protocolJson);
  const protoHashP = sha256Hex(lab.protocolJson).catch(() => null);
  const v1Results = Array.isArray(v1?.results) ? v1.results.filter(isObj) : [];
  const ctx = { lab, prefix: 't-', protos, results, reg, v1ById: new Map(v1Results.map((r) => [r.id, r])) };
  attempt('facts', () => fillFacts(lab, results));
  attempt('board', () => renderBoard(results, ctx, v1Results));
  attempt('cards', () => renderCards($('cards'), results, ctx));
  attempt('v1', () => renderV1(v1, v1Results, lab, model));
  attempt('stamp', () => renderStamp(lab, reg, protos, protoHashP).catch(report('stamp')));
  attempt('proof', () => renderProof(lab, reg, cfg, protos, protoHashP));
  $('openall').hidden = !results.length;
  openFromHash();
}

function fillFacts(lab, results) {
  const scr = isNum(lab.scrambles?.n) && lab.scrambles.n > 0 ? lab.scrambles.n : results.find((r) => isNum(r.registeredScrambles) && r.registeredScrambles > 0)?.registeredScrambles;
  const facts = {
    cells: lab.wiring?.cells, synapses: lab.wiring?.synapses, connections: lab.wiring?.connections, scrambles: scr,
    tests: results.length, model: lab.model?.id, computed: lab.computedAt ? when(lab.computedAt) : null,
  };
  for (const e of document.querySelectorAll('[data-f]')) {
    const v = facts[e.dataset.f];
    if (v !== null && v !== undefined) e.textContent = isNum(v) ? num(v) : String(v);
  }
}

/* ---------- the board ---------- */
function tally(results) {
  const n = { pass: 0, fail: 0, other: 0 };
  for (const r of results) n[verdictOf(r.verdict).cls]++;
  n.allMeasured = results.every((r) => verdictOf(r.verdict).cls !== 'other' || r.verdict === 'measured');
  return n;
}
function renderBoard(results, ctx, v1Results) {
  const n = tally(results), total = results.length;
  const tile = (cls, label, count) => el('div', cls, el('dt', null, el('i'), label), el('dd', null, num(count), el('small', null, `of ${num(total)}`)));
  $('tally').replaceChildren(tile('pass', 'Pass', n.pass), tile('fail', 'Fail', n.fail), tile('other', n.allMeasured ? 'Measured' : 'Other', n.other));
  const withRule = n.pass + n.fail, words = [];
  words.push(withRule ? `${n.pass} of the ${withRule} tests with a pass rule ${n.pass === 1 ? 'passes' : 'pass'}.` : 'No test here has a pass rule.');
  if (n.other) {
    words.push(n.allMeasured
      ? `The other ${n.other} ${n.other === 1 ? 'is a measurement' : 'are measurements'} with no pass rule, published as ${n.other === 1 ? 'it' : 'they'} came out.`
      : `${n.other} more ${n.other === 1 ? 'has' : 'have'} no pass or fail verdict.`);
  }
  const old = tally(v1Results);
  if (old.pass + old.fail) words.push(`Under the retired model v1, ${old.pass} of ${old.pass + old.fail} passed.`);
  $('tallyline').textContent = words.join(' ');
  const ol = $('rows');
  ol.replaceChildren();
  results.forEach((r, i) => ol.append(attempt('row ' + r.id, () => boardRow(r, i, ctx), el('li', 'lbwait', titleOf(r, i)))));
}
function boardRow(r, i, ctx) {
  const P = protoOf(r, ctx), spec = specOf(r, P), v = verdictOf(r.verdict);
  const row = a('#' + cardId(ctx.prefix, r, i), null, 'lbrow ' + v.cls);
  const tt = el('span', 'tt', el('b', null, titleOf(r, i)));
  if (r.question) tt.append(el('small', null, r.question));
  if (P.registeredAfter) tt.append(el('em', null, `Registered after ${P.registeredAfter}`));
  row.append(el('span', 'no', pad2(i + 1)), tt, el('span', 'ln', shortLine(r, P, spec)), badge(v));
  row.addEventListener('click', (e) => { e.preventDefault(); openCard(row.hash.slice(1), true); });
  return el('li', null, row);
}

/* ---------- the cards ---------- */
function renderCards(box, results, ctx) {
  box.replaceChildren();
  results.forEach((r, i) => box.append(attempt('card ' + (r.id || i), () => card(r, i, ctx)) || plainCard(r, i, ctx)));
}
function plainCard(r, i, ctx) {
  const v = verdictOf(r.verdict), det = el('details', 'lbcard ' + v.cls);
  det.id = cardId(ctx.prefix, r, i);
  det.append(
    el('summary', null, el('span', 'no', pad2(i + 1)), el('div', 'lbsumt', el('h3', null, titleOf(r, i))), badge(v)),
    el('div', 'lbbody', r.summary ? el('p', 'lbsummary', r.summary) : null, r.rule ? el('p', 'lbrule', r.rule) : null),
  );
  return det;
}
const note = (kind, title, text, ...more) => el('div', 'lbnote' + (kind ? ' ' + kind : ''), el('b', null, title), text ? el('span', null, text) : null, ...more);
function jump(id, text) {
  const x = a('#' + id, text);
  x.addEventListener('click', (e) => { e.preventDefault(); openCard(id, true); });
  return x;
}

function card(r, i, ctx) {
  const P = protoOf(r, ctx), spec = specOf(r, P), v = verdictOf(r.verdict);
  const det = el('details', 'lbcard ' + v.cls);
  det.id = cardId(ctx.prefix, r, i);
  const head = el('div', 'lbsumt', el('h3', null, titleOf(r, i)));
  if (r.question) head.append(el('p', 'q', r.question));
  const line = shortLine(r, P, spec);
  if (line) head.append(el('p', 'ln', line));
  det.append(el('summary', null, el('span', 'no', pad2(i + 1)), head, badge(v), icon('chev', 'lbchev')));

  const body = el('div', 'lbbody');
  if (P.registeredAfter) body.append(note('warn', `Registered after ${P.registeredAfter}`, P.why));
  else if (P.why) body.append(note('', 'Why this version', P.why));
  if (P.follows) {
    const k = ctx.results.findIndex((x) => x.id === P.follows);
    if (k >= 0) { const prev = ctx.results[k]; body.append(note('', 'Follows', `“${titleOf(prev, k)}”, version ${prev.version ?? 1}: ${verdictOf(prev.verdict).text.toLowerCase()}.`, jump(cardId(ctx.prefix, prev, k), 'Open it'))); }
  }
  ctx.results.forEach((x, k) => {
    if (protoOf(x, ctx).follows === r.id) body.append(note('', 'Followed by', `“${titleOf(x, k)}”, registered after this result.`, jump(cardId(ctx.prefix, x, k), 'Open it')));
  });
  body.append(ruleBlock(r, P, ctx), resultBlock(r, P, spec, v));
  const old = ctx.v1ById?.get(r.id);
  if (old) body.append(v1Line(old));
  const cav = Array.isArray(r.caveats) ? r.caveats : Array.isArray(P.caveats) ? P.caveats : [];
  if (cav.length) body.append(el('div', 'lbblock', el('h4', null, 'Caveats'), el('ul', 'lbcav', cav.map((c) => el('li', null, String(c))))));
  body.append(el('div', 'lbmore', protocolBlock(P), rawBlock(r)));
  det.append(body);
  det.addEventListener('toggle', () => { if (det.open) for (const p of det.querySelectorAll('.lbplot')) p._redraw?.(); });
  return det;
}

function ruleBlock(r, P, ctx) {
  const b = el('div', 'lbblock', el('h4', null, 'The rule, written before it ran'), el('p', 'lbrule', P.rule || r.rule || '—'));
  const bits = [];
  if (P.registered) bits.push(`Registered ${when(P.registered, false)}`);
  if (P.registeredBefore) bits.push(`before ${P.registeredBefore}`);
  if (P.registeredAfter) bits.push(`after ${P.registeredAfter}`);
  const ver = P.version ?? r.version;
  if (ver !== undefined && ver !== null) bits.push(`version ${ver}`);
  const meta = el('p', 'lbrmeta', bits.join(' · '));
  const sha = ctx.lab?.protocolSha256s?.[r.id];
  if (typeof sha === 'string') {
    const c = el('code', null, short(sha, 16));
    c.title = sha;
    meta.append(bits.length ? ' · ' : '', 'fingerprint ', c);
    const registered = regHash(ctx.reg, new RegExp(`^protocol ${escapeRe(r.id)}$`));
    if (registered) meta.append(' ', check(registered === sha, 'in the registration record', 'differs from the registration record'));
  }
  if (meta.childNodes.length) b.append(meta);
  return b;
}

function resultBlock(r, P, spec, v) {
  const b = el('div', 'lbblock', el('h4', null, 'The result'));
  if (r.summary) b.append(el('p', 'lbsummary', r.summary));
  if (r.deviation) b.append(note('warn', 'Not the registered run', String(r.deviation)));
  const vs = attempt('versus ' + r.id, () => versus(r, P, spec, v));
  if (vs) b.append(vs);
  const chart = attempt('chart ' + r.id, () => mainChart(r, spec, v));
  if (chart) b.append(chart);
  if (spec.extra) { const x = attempt('extra ' + r.id, () => spec.extra(r, P, v)); if (x) b.append(x); }
  return b;
}

function condRow(c) {
  const state = c.met === true ? 'met' : c.met === false ? 'unmet' : 'na';
  return el('div', 'lbcond ' + state,
    el('span', 'cl', c.label),
    el('span', 'cm', el('small', null, 'Measured'), c.show(c.measured)),
    el('span', 'cr', el('small', null, 'Required'), `${c.op} ${c.show(c.threshold)}`, c.note ? el('i', null, c.note) : null),
    el('span', 'cst', icon(state === 'met' ? 'check' : state === 'unmet' ? 'cross' : 'dash'), state === 'met' ? 'Met' : state === 'unmet' ? 'Not met' : 'n/a'));
}

/** Measured vs required: each condition of the rule with its two numbers. The verdict is the lab's, never recomputed here. */
function versus(r, P, spec, v) {
  const k = kOf(spec, r), unit = unitOf(spec, r), dg = spec.digits || 4;
  const show = (x) => (isNum(x) ? num(x * k, dg) + unit : x === null && spec.none ? spec.none : '—');
  const value = spec.value ? attempt('value ' + r.id, () => spec.value(r)) : undefined;
  let conds = spec.conds ? attempt('conds ' + r.id, () => spec.conds(r, P), []) : [];
  if (!conds.length && v.cls !== 'other' && isNum(value) && isNum(r.control?.p95)) conds = [gt('Real wiring above the rewired copies', value, r.control.p95, { note: P95NOTE(r) })];
  const box = el('div', 'lbvs');
  for (const c of conds) box.append(condRow(c));
  if (conds.length) box.append(el('div', 'lbvsv', el('span', null, 'Verdict'), badge(v)));
  else if (isObj(r.control) && value !== undefined) {
    const c = r.control, bits = [];
    if (isNum(c.mean)) bits.push(`mean ${show(c.mean)}`);
    if (isNum(c.p95)) bits.push(`p95 ${show(c.p95)}`);
    if (isNum(c.responded) && isNum(c.n)) bits.push(`${c.responded} of ${c.n} responded`);
    box.append(el('div', 'lbcond na',
      el('span', 'cl', cap(spec.what || 'the measured value')),
      el('span', 'cm', el('small', null, 'Real wiring'), show(value)),
      el('span', 'cr', el('small', null, 'Rewired copies'), bits.join(' · ') || '—'),
      el('span', 'cst', icon('dash'), 'No pass rule')));
  }
  const also = [];
  if (isNum(r.percentile)) also.push(spec.pctText ? spec.pctText(r.percentile) : `${num(r.percentile, 3)}% of the rewired copies are below the real wiring (ties count half)`);
  if (isNum(r.p)) also.push(`Monte Carlo p = ${num(r.p, 3)}`);
  if (!box.childElementCount && !also.length) return null;
  const out = el('div', 'lbsub', el('h5', null, conds.length ? 'Measured vs required' : 'Measured'));
  if (box.childElementCount) out.append(box);
  if (also.length) out.append(el('p', 'lbalso', `${v.cls === 'other' ? 'Also reported' : 'Also reported, not used for the verdict'}: ${also.join('; ')}.`));
  return out;
}

function mainChart(r, spec, v) {
  const c = r.control;
  if (!isObj(c) || !Array.isArray(c.values) || !c.values.length) return null;
  const value = spec.value ? attempt('value ' + r.id, () => spec.value(r)) : undefined;
  return dotFigure({
    values: c.values, real: value, p95: c.p95, k: kOf(spec, r), unit: unitOf(spec, r),
    verdict: v, rule: v.cls !== 'other', what: spec.what || 'the measured value', none: spec.none || 'no value', zero: !!spec.zero, digits: spec.digits,
  });
}

function v1Line(old) {
  const box = el('div', 'lbv1', el('span', 'k', 'Under model v1 (retired)'), badge(verdictOf(old.verdict), 'sm'));
  if (old.summary) box.append(el('span', 'tx', old.summary));
  box.append(jump(cardId('v1-', old, 0), 'See it'));
  return box;
}

function table(heads, { scroll = false } = {}) {
  const t = el('table', 'lbtable' + (scroll ? '' : ' lbstk'));
  const tb = el('tbody');
  t.append(el('thead', null, el('tr', null, heads.map((h) => el('th', null, h)))), tb);
  return {
    el: scroll ? el('div', 'lbscroll', t) : t,
    row(cells) {
      const tr = el('tr');
      cells.forEach((c, i) => { const td = el('td', null, c); td.dataset.l = heads[i] ?? ''; tr.append(td); });
      tb.append(tr);
    },
  };
}

function protocolBlock(P) {
  const d = el('details', 'lbproto', el('summary', null, 'The protocol, as registered'));
  const dl = el('dl', 'lbkv prose');
  for (const [k, label] of [['stimulus', 'Stimulus'], ['measure', 'Measure'], ['control', 'Control']]) if (P[k]) dl.append(kv(label, String(P[k])));
  if (P.seed !== undefined && P.seed !== null) dl.append(kv('Seed', String(P.seed)));
  if (dl.childElementCount) d.append(dl);
  if (Array.isArray(P.chosen) && P.chosen.length) {
    const t = table(['Chosen', 'Value', 'Why']);
    for (const c of P.chosen) if (isObj(c)) t.row([c.name ?? '—', plain(c.value), c.why ?? '']);
    d.append(el('h5', null, 'Every number chosen for this test, and why'), t.el);
  }
  if (d.childElementCount < 2) d.append(el('p', 'small', 'No protocol text in this result.'));
  return d;
}

function rawBlock(r) {
  const d = el('details', 'lbraw', el('summary', null, 'Every number in this result'));
  d.addEventListener('toggle', () => {
    if (!d.open || d.dataset.filled) return;
    d.dataset.filled = '1';
    const pick = {};
    for (const k of ['real', 'control', 'percentile', 'p', 'details', 'scrambles', 'registeredScrambles', 'deviation']) if (k in r) pick[k] = r[k];
    d.append(el('pre', null, el('code', null, JSON.stringify(pick, null, 1))));
  });
  return d;
}

/* ---------- what each test adds to its result ---------- */
const lines = (title, texts) => {
  const t = texts.filter(Boolean);
  return t.length ? el('div', 'lbsub', el('h5', null, title), t.map((x) => el('p', 'lbfine', x))) : null;
};

function eyesParts(r) {
  const parts = r.details?.parts;
  if (!isObj(parts)) return null;
  const names = { L_cil: 'Ciliary bands', L_bend: 'Body-wall muscles' };
  const t = table(['Part', 'Real wiring (size)', 'More active on', 'Rewired p95', 'Percentile']);
  for (const [k, p] of Object.entries(parts)) if (isObj(p)) t.row([names[k] || k, num(p.realAbs ?? p.real), p.side || '—', num(p.controlAbs?.p95), isNum(p.percentile) ? num(p.percentile, 3) : '—']);
  const box = el('div', 'lbsub', el('h5', null, 'Its two parts, reported but not used for the verdict'), t.el);
  const m = r.details?.movers;
  if (isObj(m) && isNum(m.real)) box.append(el('p', 'lbfine', `Mean activity of the movers, over the two runs: ${num(m.real)}. Rewired copies: mean ${num(m.control?.mean)}.`));
  return box;
}

function touchDraws(r) {
  const R = r.real || {}, draws = r.details?.otherDraws;
  return lines('Also in the result', [
    isNum(R.touchCells) && `${R.touchCells} touch sensors driven together${isNum(R.touchPeakStep) ? `; the startle muscles peaked at step ${R.touchPeakStep}` : ''}.`,
    Array.isArray(draws) && draws.length && `Other sensory neurons, ${draws.length} draws of as many cells: peaks ${draws.map((x) => num(x?.peak, 3)).join(', ')}.`,
    isNum(R.ratio) && `Touch ÷ other senses: ${num(R.ratio, 3)}.`,
  ]);
}

function touchSingles(r, P) {
  const T = r.details?.touchPokes, O = r.details?.otherPokes;
  if (!isObj(T) && !isObj(O)) return null;
  const t = table(['Poked one at a time', 'Cells', `Startle above ${num(P.params?.reachThreshold)}`, 'Lit up over half the body', 'Mean startle peak']);
  if (isObj(T)) t.row(['Touch sensors', num(T.of), num(T.reachedStartle), num(T.cascades), num(r.real?.touch)]);
  if (isObj(O)) t.row(['Other sensory neurons', num(O.of), num(O.reachedStartle), num(O.cascades), num(r.real?.other)]);
  return el('div', 'lbsub', el('h5', null, 'Every poke'), t.el);
}

function latencyNotes(r, P) {
  const R = r.real || {}, c = r.control || {}, ms = r.details?.controlMs;
  return lines('Also in the result', [
    R.steps === null && `No muscle crossed ${num(P.params?.threshold)} within ${num(P.params?.maxSteps)} steps.`,
    isNum(R.steps) && `First muscle past ${num(P.params?.threshold)}: ${R.firstMuscle || '—'}, after ${num(R.steps)} steps (${num(R.ms, 3)} ms of model time).`,
    isNum(c.responded) && isNum(c.n) && `Rewired copies: ${c.responded} of ${c.n} responded${isNum(c.mean) ? `, after ${num(c.mean, 3)} steps on average${isNum(ms?.mean) ? ` (${num(ms.mean, 3)} ms)` : ''}` : ''}.`,
  ]);
}

function lampNotes(r) {
  const R = r.real || {}, trials = Array.isArray(R.trials) ? R.trials.filter(isObj) : [];
  const box = lines('Every direction', [
    isNum(R.endedCloser) && `Ended the trial closer to the lit lamp than to the dark one in ${R.endedCloser} of ${trials.length || '—'} directions.`,
    isNum(R.closestUm) && `Closest approach to a lit lamp: ${num(R.closestUm, 3)} µm.`,
  ]) || (trials.length ? el('div', 'lbsub', el('h5', null, 'Every direction')) : null);
  if (box && trials.length) {
    const um = (x) => (isNum(x) ? `${num(x)} µm` : '—');
    const t = table(['Lamp direction', 'Mean distance, lit', 'Mean distance, dark', 'Closest, lit'], { scroll: true });
    for (const x of trials) t.row([Array.isArray(x.dir) ? `(${x.dir.map((d) => num(d)).join(', ')})` : '—', um(x.litMeanUm), um(x.darkMeanUm), um(x.closestUm)]);
    box.append(t.el);
  }
  return box;
}

function eyespotNotes(r) {
  const R = r.real || {};
  return lines('Also in the result', [
    Array.isArray(R.leftCells) && Array.isArray(R.rightCells) && `Eyespot cells lit: ${R.leftCells.join(', ') || 'none'} on the left; ${R.rightCells.join(', ') || 'none'} on the right.`,
  ]);
}

function crArrest(r, P, v) {
  const R = r.real || {}, ac = r.details?.arrestControl, draws = r.details?.otherDraws;
  const box = el('div', 'lbsub', el('h5', null, 'The cilia arrest, against the rewired copies'));
  if (isObj(ac) && Array.isArray(ac.values) && ac.values.length) {
    box.append(dotFigure({ values: ac.values, real: R.arrest, p95: ac.p95, k: 1, unit: '', verdict: v, rule: true, what: 'peak mean cilia arrest', none: 'no value' }));
  }
  const texts = [
    isNum(R.crCells) && `${R.crCells} collar receptor cells driven together.`,
    Array.isArray(draws) && draws.length && `Other sensory neurons, ${draws.length} draws of as many cells: startle ${num(R.otherStartle)}, arrest ${num(R.otherArrest)} on average.`,
    isNum(r.details?.arrestPercentile) && `Arrest: ${num(r.details.arrestPercentile, 3)}% of the rewired copies below the real wiring.`,
  ].filter(Boolean);
  add(box, texts.map((x) => el('p', 'lbfine', x)));
  return box.childElementCount > 1 ? box : null;
}

function bands(r) {
  const b = r.real?.bandPeak;
  if (!isObj(b)) return null;
  const list = el('div', 'lbbands');
  for (const [name, f] of Object.entries(b)) {
    const bar = el('i');
    if (isNum(f)) bar.style.width = `${Math.max(0, Math.min(1, f)) * 100}%`;
    list.append(el('div', 'lbband', el('span', 'bn', name), el('span', 'bt', bar), el('span', 'bv', pct(f))));
  }
  return el('div', 'lbsub', el('h5', null, `Most stopped at once, by band${isNum(r.real?.cilia) ? ` · ${r.real.cilia} ciliated cells in all` : ''}`), list);
}

function alphabetRank(r) {
  const R = r.real || {};
  if (!Array.isArray(R.top) && !Array.isArray(R.bottom)) return null;
  const list = (title, rows) => el('div', 'lbglyphs', el('h5', null, title), el('ol', null, rows.filter(isObj).map((x) => el('li', null,
    el('span', 'r', isNum(x.rank) ? `#${x.rank}` : ''),
    el('b', 'g' + (x.glyph === ' ' ? ' sp' : ''), x.glyph === ' ' ? 'space' : String(x.glyph ?? '')),
    el('span', null, `${num(x.peak)} cells`, isNum(x.ink) ? el('small', null, ` · ${num(x.ink)} lit pixels`) : null)))));
  const grid = el('div', 'lbglyphgrid');
  if (Array.isArray(R.top)) grid.append(list('Most cells firing', R.top));
  if (Array.isArray(R.bottom)) grid.append(list('Fewest', R.bottom));
  const box = el('div', 'lbsub', el('h5', null, `The ranking${Array.isArray(R.all) ? ` of all ${R.all.length} glyphs` : ''}`), grid);
  if (isNum(R.spearmanInkPeak)) box.append(el('p', 'lbfine', `Rank correlation between a glyph's lit pixels and its peak: ${num(R.spearmanInkPeak, 3)}.`));
  return box;
}

function fatigueTable(r) {
  const R = r.real || {}, off = r.details?.noFatigue, m = r.details?.model;
  if (!Array.isArray(R.peaks)) return null;
  const t = table(['', ...R.peaks.map((_, i) => `Poke ${i + 1}`)], { scroll: true });
  t.row(['Peak cells firing', ...R.peaks.map((x) => num(x))]);
  if (isObj(off) && Array.isArray(off.peaks)) t.row(['With fatigue off', ...off.peaks.map((x) => num(x))]);
  const box = el('div', 'lbsub', el('h5', null, 'Every poke'), t.el);
  add(box, [
    Array.isArray(R.cells) && R.cells.length && `The same ${R.cells.length} touch sensors each time: ${R.cells.join(', ')}.`,
    isNum(R.ratio) && `Last poke ÷ first: ${num(R.ratio, 3)}${isNum(off?.ratio) ? `; with fatigue off: ${num(off.ratio, 3)}` : ''}.`,
    isObj(m) && isNum(m.tauA) && isNum(m.adapt) && `The model's fatigue: time constant ${m.tauA} steps, strength ${m.adapt}, both chosen by us.`,
  ].filter(Boolean).map((x) => el('p', 'lbfine', x)));
  return box;
}

/* ---------- the dot plot ---------- */
const ro = typeof ResizeObserver === 'function' ? new ResizeObserver((entries) => { for (const e of entries) e.target._redraw?.(); }) : null;
function mount(box, draw) {
  box._redraw = () => {
    const w = Math.floor(box.clientWidth);
    if (w >= 160 && w !== box._w) { box._w = w; attempt('chart', () => draw(w)); }
  };
  if (ro) ro.observe(box); else window.addEventListener('resize', box._redraw);
}
function niceTicks(lo, hi, count) {
  const span = hi - lo;
  if (!isNum(span) || !(span > 0)) return [];
  const raw = span / count, mag = 10 ** Math.floor(Math.log10(raw)), f = raw / mag;
  const step = (f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10) * mag, out = [];
  for (let i = Math.ceil(lo / step), end = Math.floor(hi / step); i <= end && out.length < 12; i++) out.push(Number((i * step).toPrecision(12)));
  return out;
}
function legendKey(cls, text) {
  const round = cls.startsWith('kdot') || cls.startsWith('knone');
  const shape = round ? sv('circle', { class: cls, cx: 7, cy: 7, r: 4 }) : sv('path', { class: cls, d: 'M7 1.5v11' });
  return el('span', null, sv('svg', { viewBox: '0 0 14 14', 'aria-hidden': 'true', focusable: 'false' }, shape), text);
}
function valuesList(pts, fmt, none) {
  const d = el('details', 'lbvals', el('summary', null, `All ${pts.length} values`));
  d.addEventListener('toggle', () => {
    if (!d.open || d.dataset.filled) return;
    d.dataset.filled = '1';
    d.append(el('ol', null, pts.map((p) => el('li', null, el('span', null, `#${p.k}`), p.v === null ? none : fmt(p.v)))));
  });
  return d;
}

/**
 * One dot per rewired copy (stacked where values meet), the real wiring as a line in its verdict's
 * colour, p95 as a dashed line. Copies with no value (no response) sit in their own column on the right.
 * cfg: {values, real, p95, k (display factor), unit, verdict, rule (p95 is the pass line), what, none}
 */
function dotFigure(cfg) {
  const k = isNum(cfg.k) && cfg.k !== 0 ? cfg.k : 1, unit = cfg.unit || '', dg = cfg.digits || 4;
  const fmt = (x, d = dg) => (isNum(x) ? num(x, d) + unit : '—');   // x in display units
  const pts = cfg.values.map((x, i) => ({ k: i, v: isNum(x) ? x * k : null }));
  const nums = pts.filter((p) => p.v !== null), nones = pts.filter((p) => p.v === null);
  const real = isNum(cfg.real) ? cfg.real * k : null, realNone = cfg.real === null && nones.length > 0;
  const p95 = isNum(cfg.p95) ? cfg.p95 * k : null, n = pts.length;
  const vmin = nums.length ? Math.min(...nums.map((p) => p.v)) : null, vmax = nums.length ? Math.max(...nums.map((p) => p.v)) : null;
  const realText = real !== null ? fmt(real) : realNone ? cfg.none : '—';

  const fig = el('figure', 'lbfig');
  const plot = el('div', 'lbplot');
  plot.tabIndex = 0;
  plot.setAttribute('role', 'img');
  plot.setAttribute('aria-label', `${cap(cfg.what)}. Real wiring: ${realText}. ${n} rewired copies${nums.length ? `, from ${fmt(vmin)} to ${fmt(vmax)}` : ''}${nones.length ? `; ${nones.length} with ${cfg.none}` : ''}. p95: ${fmt(p95)}.`);
  const tip = el('div', 'lbtip');
  tip.hidden = true;
  tip.setAttribute('aria-hidden', 'true');
  plot.append(tip);

  let svgNode = null, items = [], order = [], at = -1, W = 0, H = 0, lit = null;
  const show = (it) => {
    if (lit?.node) lit.node.classList.remove('hi');
    lit = it || null;
    if (!it || !svgNode) { tip.hidden = true; return; }
    if (it.node) it.node.classList.add('hi');
    tip.replaceChildren(el('b', null, it.val), el('span', null, it.label));
    tip.hidden = false;
    const pr = plot.getBoundingClientRect(), sr = svgNode.getBoundingClientRect();
    if (!sr.width || !sr.height) return;
    const x = sr.left - pr.left + (it.x * sr.width) / W, y = sr.top - pr.top + (it.y * sr.height) / H - 8;
    const half = tip.offsetWidth / 2 + 4;
    tip.style.left = `${Math.min(Math.max(x, half), Math.max(half, pr.width - half))}px`;
    tip.style.top = `${Math.max(0, y)}px`;
  };

  const draw = (w) => {
    W = w;
    const R = 4, D = 8, CLEAR = D + 1.5, narrow = w < 520, side = nones.length > 0 || realNone;
    const x0 = 14, x1 = Math.max(x0 + 60, w - (side ? 72 : 14)), xNone = x1 + 42;
    const ext = nums.map((p) => p.v);
    if (real !== null) ext.push(real);
    if (p95 !== null) ext.push(p95);
    if (cfg.zero) ext.push(0);
    let lo = ext.length ? Math.min(...ext) : 0, hi = ext.length ? Math.max(...ext) : 1;
    if (!(hi > lo)) { const pad = Math.abs(lo) * 0.5 || 1; lo -= pad; hi += pad; }
    const span = hi - lo;
    lo -= span * 0.05; hi += span * 0.05;
    const X = (v) => x0 + ((v - lo) / (hi - lo)) * (x1 - x0);

    // each dot on the lowest level where no neighbour is within a dot's width
    const placed = [];
    for (const p of nums.slice().sort((p1, p2) => p1.v - p2.v || p1.k - p2.k)) {
      const x = X(p.v), busy = new Set();
      for (const q of placed) if (Math.abs(q.x - x) < CLEAR) busy.add(q.level);
      let level = 0;
      while (busy.has(level)) level++;
      placed.push({ ...p, x, level });
    }
    nones.forEach((p, i) => placed.push({ ...p, x: xNone, level: i, none: true }));
    const levels = placed.reduce((m, q) => Math.max(m, q.level + 1), 1);
    const capH = narrow ? 92 : 128;
    let step = CLEAR;
    if ((levels - 1) * step + D > capH) step = (capH - D) / (levels - 1);
    const top = 26, base = Math.round(top + (levels - 1) * step + D + 4) + 0.5;
    H = Math.ceil(base + 22);
    const cy = (lv) => base - 3.5 - R - lv * step;

    const s = sv('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, 'aria-hidden': 'true', focusable: 'false' });
    s.append(sv('line', { class: 'ax', x1: x0, x2: x1, y1: base, y2: base }));
    const right = side ? xNone - 18 : W;
    for (const t of niceTicks(lo, hi, narrow ? 3 : 5)) {
      const x = X(t), label = num(t, 3) + unit, half = (label.length * 6.1 + 2) / 2;
      let anchor = 'middle', tx = x;
      if (x - half < 0) { anchor = 'start'; tx = Math.max(0, x - 4); } else if (x + half > right) { anchor = 'end'; tx = x + 4; }
      s.append(sv('line', { class: 'tk', x1: x, x2: x, y1: base, y2: base + 4 }), sv('text', { class: 'tl', x: tx, y: base + 16, 'text-anchor': anchor }, label));
    }
    if (cfg.zero && lo < 0 && hi > 0) s.append(sv('line', { class: 'zero', x1: X(0), x2: X(0), y1: top - 6, y2: base }));
    if (side) s.append(sv('line', { class: 'ax', x1: xNone - 14, x2: xNone + 14, y1: base, y2: base }), sv('text', { class: 'tl', x: xNone, y: base + 16, 'text-anchor': 'middle' }, 'none'));

    const xp = p95 !== null ? X(p95) : null;
    if (xp !== null) s.append(sv('line', { class: 'p95', x1: xp, x2: xp, y1: 16, y2: base }));
    for (const q of placed) {
      q.y = cy(q.level);
      q.node = sv('circle', { class: q.none ? 'dt none' : 'dt', cx: q.x.toFixed(2), cy: q.y.toFixed(2), r: R });
      s.append(q.node);
    }
    if (step < CLEAR) {   // squeezed stacks: say how many copies share a value
      const groups = new Map();
      for (const q of placed) { const key = q.none ? 'none' : q.v; if (!groups.has(key)) groups.set(key, []); groups.get(key).push(q); }
      for (const g of groups.values()) if (g.length >= 6) {
        const t = g.reduce((m, q) => (q.level > m.level ? q : m));
        s.append(sv('text', { class: 'cnt', x: t.x + R + 4, y: t.y + 3.5 }, `×${g.length}`));
      }
    }
    const xr = real !== null ? X(real) : realNone ? xNone : null;
    if (xr !== null) s.append(sv('line', { class: 'rl ' + cfg.verdict.cls, x1: xr, x2: xr, y1: 17, y2: base }), sv('circle', { class: 'rd ' + cfg.verdict.cls, cx: xr, cy: 17, r: 4 }));

    // the two line labels, pushed to either side when they would touch
    const labels = [];
    if (xr !== null) labels.push({ t: 'REAL', x: xr, cls: 'ml' });
    if (xp !== null) labels.push({ t: 'P95', x: xp, cls: 'ml pt' });
    const lw = (t) => t.length * 7 + 4;
    if (labels.length === 2) {
      const [l, r] = labels[0].x <= labels[1].x ? labels : [labels[1], labels[0]];
      if (r.x - l.x < (lw(l.t) + lw(r.t)) / 2 + 4) { l.anchor = 'end'; l.x -= 8; r.anchor = 'start'; r.x += 8; }
    }
    for (const L of labels) {
      let anchor = L.anchor || 'middle', x = L.x;
      const wl = lw(L.t);
      if (anchor === 'middle' && x - wl / 2 < 0) { anchor = 'start'; x = 0; }
      else if (anchor === 'middle' && x + wl / 2 > W) { anchor = 'end'; x = W; }
      else if (anchor === 'end' && x - wl < 0) { anchor = 'start'; x = 0; }
      else if (anchor === 'start' && x + wl > W) { anchor = 'end'; x = W; }
      s.append(sv('text', { class: L.cls, x, y: 10, 'text-anchor': anchor }, L.t));
    }

    // hover, tap and keys: the nearest copy or line
    const dots = placed.map((q) => ({ x: q.x, y: q.y, node: q.node, val: q.none ? cfg.none : fmt(q.v), label: `Rewired copy #${q.k}` }));
    const marks = [];
    if (xr !== null) marks.push({ x: xr, y: 17, line: true, val: realText, label: 'Real wiring' });
    if (xp !== null) marks.push({ x: xp, y: 17, line: true, val: fmt(p95), label: `p95 of the ${n} rewired copies` });
    items = [...dots, ...marks];
    order = items.slice().sort((i1, i2) => i1.x - i2.x || (i1.line ? -1 : 1));
    const nearest = (e) => {
      const rect = s.getBoundingClientRect();
      if (!rect.width) return null;
      const px = ((e.clientX - rect.left) * W) / rect.width, py = ((e.clientY - rect.top) * H) / rect.height;
      let best = null, bd = 22 * 22;
      for (const it of items) {
        const dx = it.x - px, dy = it.line ? 0 : it.y - py, d2 = dx * dx + dy * dy + (it.line ? 30 : 0);
        if (d2 < bd) { bd = d2; best = it; }
      }
      return best;
    };
    s.addEventListener('pointermove', (e) => show(nearest(e)));
    s.addEventListener('pointerdown', (e) => show(nearest(e)));
    s.addEventListener('pointerleave', (e) => { if (e.pointerType !== 'touch') show(null); });
    if (svgNode) svgNode.replaceWith(s); else plot.insertBefore(s, tip);
    svgNode = s;
    show(null);
    at = -1;
  };

  const realIndex = () => Math.max(0, order.findIndex((it) => it.label === 'Real wiring'));
  plot.addEventListener('keydown', (e) => {
    if (!order.length) return;
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      e.preventDefault();
      at = at < 0 ? realIndex() : (at + (e.key === 'ArrowRight' ? 1 : -1) + order.length) % order.length;
      show(order[at]);
    } else if (e.key === 'Escape') { at = -1; show(null); }
  });
  const byKeyboard = () => { try { return plot.matches(':focus-visible'); } catch { return true; } };
  plot.addEventListener('focus', () => { if (byKeyboard() && order.length) { at = realIndex(); show(order[at]); } });
  plot.addEventListener('blur', () => { at = -1; show(null); });
  mount(plot, draw);

  const leg = el('figcaption', 'lblegend', legendKey('kdot', `${n} rewired copies`));
  if (nones.length) leg.append(legendKey('knone', `${nones.length} with ${cfg.none}`));
  leg.append(legendKey('kreal ' + cfg.verdict.cls, `Real wiring: ${realText}`));
  if (p95 !== null) leg.append(legendKey('kp95', cfg.rule ? `p95: ${fmt(p95)}, the value to beat` : `p95: ${fmt(p95)}, for context`));
  fig.append(plot, leg, valuesList(pts, fmt, cfg.none));
  return fig;
}

/* ---------- model v1, retired ---------- */
function renderV1(v1, res, lab, model) {
  const wrap = $('v1');
  if (!wrap) return;
  if (!v1 || !res.length) { wrap.hidden = true; return; }
  const n = tally(res);
  $('v1sum').replaceChildren(el('span', 'lbrt', 'Model v1 (retired)'), el('span', 'lbrc',
    badge({ cls: 'pass', text: `${n.pass} pass`, icon: 'check' }, 'sm'),
    badge({ cls: 'fail', text: `${n.fail} fail`, icon: 'cross' }, 'sm'),
    n.other ? badge({ cls: 'other', text: `${n.other} ${n.allMeasured ? 'measured' : 'other'}`, icon: 'dash' }, 'sm') : null));
  const body = $('v1body');
  body.replaceChildren();
  if (typeof model?.replaces === 'string') body.append(el('p', null, el('b', null, 'What it was. '), cap(model.replaces.replace(/^model v1:\s*/i, '')) + '.'));
  if (typeof model?.why === 'string') body.append(el('p', null, el('b', null, 'Why it was replaced. '), model.why));
  const A = isObj(v1.protocolSha256s) ? v1.protocolSha256s : {}, B = isObj(lab.protocolSha256s) ? lab.protocolSha256s : {};
  const shared = Object.keys(A).filter((id) => id in B), same = shared.filter((id) => A[id] === B[id]), now = lab.model?.id || 'the current model';
  if (shared.length) {
    body.append(el('p', null, el('b', null, same.length === shared.length ? 'The same rules. ' : 'The rules. '), same.length === shared.length
      ? `The ${shared.length} tests it shares with ${now} have the same fingerprint in both runs: their protocols did not change.`
      : `Of the ${shared.length} tests it shares with ${now}, ${same.length} have the same fingerprint in both runs. Changed: ${shared.filter((id) => A[id] !== B[id]).join(', ')}.`));
  }
  const meta = [];
  if (v1.computedAt) meta.push(`Computed ${when(v1.computedAt)}`);
  if (v1.resultsSha256) meta.push(`results SHA-256 ${short(v1.resultsSha256, 16)}`);
  if (isObj(v1.model)) meta.push('model: ' + Object.entries(v1.model).map(([key, x]) => `${key} ${plain(x)}`).join(', '));
  body.append(el('p', 'lbrmeta', meta.join(' · '), meta.length ? ' · ' : '', a('/data/lab-model-v1.json', 'lab-model-v1.json')));
  const cards = el('div', 'lbcards');
  renderCards(cards, res, { lab: v1, prefix: 'v1-', protos: protocolsById(v1.protocolJson), results: res, reg: null, v1ById: null });
  body.append(cards);
  wrap.hidden = false;
}

/* ---------- proof ---------- */
async function renderStamp(lab, reg, protos, hashP) {
  const p = $('stamp'), regAll = regHash(reg, /^all protocols/);
  if (!p || !regAll) return;
  const ours = (await hashP) || lab.protocolSha256;
  if (typeof ours !== 'string') return;
  const ok = ours === regAll, rules = protos.size ? `All ${protos.size} rules` : 'The rules';
  p.replaceChildren(el('span', 'sd ' + (ok ? 'ok' : 'bad')), el('span', null,
    ok ? `${rules} below match the fingerprint registered on ${when(reg.registeredAt, false)} and timestamped in Bitcoin. `
      : `The rules below do not match the fingerprint registered on ${when(reg.registeredAt, false)}. `,
    a('#proof', 'Proof ↓')));
  p.hidden = false;
}

function hashRow(dl, label, hash, text) {
  const checks = el('span', 'lbchecks');
  dl.append(el('div', 'lbhash', el('dt', null, label), el('dd', null, el('code', null, typeof hash === 'string' ? hash : '—'), text ? el('small', null, text) : null, checks)));
  return { add: (node) => checks.append(node) };
}

function renderProof(lab, reg, cfg, protos, hashP) {
  const dl = $('hashes');
  dl.replaceChildren();
  const regAll = regHash(reg, /^all protocols/), regTx = regHash(reg, /transmitters/);
  const P = hashRow(dl, 'Protocols', lab.protocolSha256, `The registered text of ${protos.size ? `all ${protos.size} tests` : 'the tests'}: question, rule, every chosen number.`);
  if (regAll && typeof lab.protocolSha256 === 'string') P.add(check(lab.protocolSha256 === regAll, `same as registered on ${when(reg.registeredAt, false)}`, 'differs from the registration'));
  hashP.then((h) => { if (h && typeof lab.protocolSha256 === 'string') P.add(check(h === lab.protocolSha256, 'your browser re-hashed the text: same', 'your browser gets a different hash')); }).catch(report('protocol hash'));
  const Wr = hashRow(dl, 'Wiring', lab.wiringSha256, 'data/wiring.json, the traced connectome.');
  if (typeof cfg?.wiringSha256 === 'string' && typeof lab.wiringSha256 === 'string') Wr.add(check(cfg.wiringSha256 === lab.wiringSha256, 'the live worm runs this wiring', "not the live worm's wiring"));
  const tx = lab.key?.transmittersSha256;
  if (typeof tx === 'string') {
    const T = hashRow(dl, 'Transmitters', tx, "data/transmitters.json, from the lab's cell-type table.");
    if (regTx) T.add(check(tx === regTx, 'same as registered', 'differs from the registration'));
  }
  hashRow(dl, 'Code', lab.codeSha256, 'The lab, the model and the stimuli in shared/.');
  const Rs = hashRow(dl, 'Results', lab.resultsSha256, 'Every result on this page, as canonical JSON.');
  setTimeout(() => optional('/data/lab-model-v2-first-run.json').then((fr) => {
    if (!fr || typeof fr.resultsSha256 !== 'string' || typeof lab.resultsSha256 !== 'string') return;
    if (fr.labVersion !== lab.labVersion || fr.protocolSha256 !== lab.protocolSha256 || fr.model?.id !== lab.model?.id) return;   // not the same lab: nothing to compare
    const ok = fr.resultsSha256 === lab.resultsSha256;
    Rs.add(el('span', 'chk ' + (ok ? 'ok' : 'bad'), icon(ok ? 'check' : 'cross'), ok ? 'same as ' : 'differs from ', a('/data/lab-model-v2-first-run.json', `the first run of ${lab.model?.id || 'this model'}`)));
  }).catch(report('first run')), 600);

  const bits = [];
  if (lab.computedAt) bits.push(`Computed on this server ${when(lab.computedAt)}${isNum(lab.workerMs) ? `, in ${num(lab.workerMs / 1000, 3)} s` : ''}.`);
  if (lab.model?.id) bits.push(cfg?.model ? (cfg.model === lab.model.id ? `Model: ${lab.model.id}, the one the live worm runs.` : `Model: ${lab.model.id}; the live worm runs ${cfg.model}.`) : `Model: ${lab.model.id}.`);
  const sc = lab.scrambles;
  if (isNum(sc?.n) && Array.isArray(sc.made) && sc.made.length && isNum(sc.made[0]?.swaps)) bits.push(`Each of the ${sc.n} rewired copies: ${num(sc.made[0].swaps)} swaps${isNum(sc.swapsPerEdge) ? ` (${sc.swapsPerEdge} per connection)` : ''}, seeded in advance.`);
  $('computed').textContent = bits.join(' ');
  $('runhash').textContent = typeof lab.resultsSha256 === 'string' ? lab.resultsSha256 : '—';
  renderReg(reg, lab);
}

function renderReg(reg, lab) {
  const box = $('regbox');
  box.replaceChildren(el('h3', null, 'The registration'));
  const files = el('p', 'lblinks', a('/data/registrations/model-v2.json', 'model-v2.json', 'btn-ghost'), a('/data/registrations/model-v2.json.ots', 'model-v2.json.ots', 'btn-ghost'));
  files.lastChild.setAttribute('download', 'model-v2.json.ots');
  if (!reg) { box.append(el('p', 'lbfine', 'The registration record could not be loaded.'), files); return; }
  if (reg.what) box.append(el('p', 'lbregwhat', `${reg.what}.`));
  const dl = el('dl', 'lbkv');
  if (reg.registeredAt) dl.append(kv('Registered', when(reg.registeredAt)));
  const ours = (name) => {
    const m = /^protocol (.+)$/.exec(name);
    if (m) return lab.protocolSha256s?.[m[1]];
    if (/^all protocols/.test(name)) return lab.protocolSha256;
    if (/transmitters/.test(name)) return lab.key?.transmittersSha256;
    return undefined;
  };
  if (isObj(reg.sha256)) {
    for (const [name, h] of Object.entries(reg.sha256)) {
      const mine = ours(name);
      dl.append(kv(name, el('code', null, String(h)), typeof mine === 'string' ? el('br') : null, typeof mine === 'string' ? check(mine === h, 'this lab ran it', 'this lab ran something else') : null));
    }
  }
  if (reg.registration) dl.append(kv('registration', el('code', null, String(reg.registration))));
  if (reg.check) dl.append(kv('How to check', String(reg.check)));
  box.append(dl, files, el('p', 'lbfine', 'To check the Bitcoin timestamp, drop both files on ', ext('https://opentimestamps.org', 'opentimestamps.org'), '.'));
}

/* ---------- measured and chosen ---------- */
const TITLES = { data: 'The wiring', transmitters: 'Transmitters', eyes: 'Light on the eyes', poke: 'Pokes', tug: 'Tugs', body: 'The body', lamp: 'The lamp', spawn: 'SPAWN coins' };
const KEYS = { wiringSha256: 'wiring SHA-256', sha256: 'SHA-256', stepsPerSecond: 'steps per second', umPerUnit: 'µm per unit', tauA: 'tauA', coinWorm: "each coin's own worm" };
const humanize = (k) => KEYS[k] || String(k).replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/_/g, ' ').toLowerCase();

function valueEl(v) {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'number') return exact(v);
  if (typeof v === 'boolean') return v ? 'yes' : 'no';
  if (typeof v === 'string') return /^[0-9a-f]{64}$/i.test(v) ? el('code', null, v) : v;
  if (Array.isArray(v)) {
    return v.every((x) => typeof x === 'number') ? `(${v.map(exact).join(', ')})` : el('ul', 'lbul', v.map((x) => el('li', null, isObj(x) || Array.isArray(x) ? JSON.stringify(x) : String(x))));
  }
  if (isObj(v)) return el('dl', 'lbkv', Object.entries(v).map(([key, x]) => kv(humanize(key), valueEl(x))));
  return String(v);
}
function groupEl(name, obj) {
  const h = el('h4', null, TITLES[name] || cap(humanize(name)));
  if (obj.kind === 'simplified') h.append(el('span', 'tag simp', 'Simplified'));
  const dl = el('dl', 'lbkv'), nested = [];
  for (const [key, v] of Object.entries(obj)) {
    if (key === 'kind') continue;
    if (isObj(v) && typeof v.kind === 'string') { nested.push([key, v]); continue; }
    dl.append(kv(humanize(key), valueEl(v)));
  }
  return { group: el('section', 'lbgrp', h, dl), nested };
}

function renderManifest(mf) {
  const mBox = $('measuredlist'), cBox = $('chosenlist');
  if (!mf) {
    for (const b of [mBox, cBox]) b.replaceChildren(el('p', 'small', 'Could not load /manifest.json.'));
    $('registered').hidden = true;
    return;
  }
  mBox.replaceChildren();
  cBox.replaceChildren();
  const place = (name, obj) => {
    const target = obj.kind === 'measured' ? mBox : obj.kind === 'chosen' || obj.kind === 'simplified' ? cBox : null;
    if (!target) return;
    const { group, nested } = groupEl(name, obj);
    target.append(group);
    for (const [nk, nobj] of nested) place(nk, nobj);
  };
  for (const [g, obj] of Object.entries(mf)) {
    if (!isObj(obj) || g === 'code') continue;
    if (g === 'model') { attempt('model', () => renderModel(obj)); continue; }
    place(g, obj);
  }
  if (!mBox.childElementCount) mBox.append(el('p', 'small', 'Nothing in the manifest is marked measured.'));
  if (!cBox.childElementCount) cBox.append(el('p', 'small', 'Nothing in the manifest is marked chosen.'));
  if (!isObj(mf.model)) $('registered').hidden = true;
}

function renderModel(m) {
  const box = $('registered');
  box.replaceChildren(el('header', 'lbpanelhead', el('h3', null, 'The model'), el('span', 'tag verify', 'Registered')));
  const dl = el('dl', 'lbkv');
  for (const [key, v] of Object.entries(m)) {
    if (['kind', 'rules', 'notDone', 'references', 'inhibitorySynapses'].includes(key)) continue;
    if (key === 'registered' && typeof v === 'string') {
      const hit = /^(\/\S+)(.*)$/.exec(v);
      dl.append(kv('registered', hit ? [a(hit[1], hit[1]), hit[2]] : v));
    } else dl.append(kv(humanize(key), valueEl(v)));
  }
  const left = el('div', null, el('h4', null, 'Its numbers'), dl);
  const right = el('div');
  if (Array.isArray(m.rules) && m.rules.length) {
    const ol = el('ol', 'lbrules');
    for (const r of m.rules) if (isObj(r)) for (const [id, text] of Object.entries(r)) ol.append(el('li', null, el('b', null, id), String(text)));
    right.append(el('h4', null, 'Its rules, as registered'), ol);
  }
  if (Array.isArray(m.inhibitorySynapses) && m.inhibitorySynapses.length) right.append(el('h4', null, `Its inhibitory synapses (${m.inhibitorySynapses.length})`), el('ul', 'lbul', m.inhibitorySynapses.map((x) => el('li', null, String(x)))));
  if (Array.isArray(m.references) && m.references.length) right.append(el('h4', null, 'References'), el('ul', 'lbul', m.references.map((x) => el('li', null, String(x)))));
  box.append(el('div', 'lbmodelgrid', left, right));
  const nd = $('notdone');
  if (Array.isArray(m.notDone) && m.notDone.length) {
    nd.replaceChildren(el('h3', null, 'Left out of the model, as registered'), el('ul', 'plain', m.notDone.filter(isObj).map((x) => el('li', null, el('b', null, `${cap(String(x.what ?? ''))}.`), ' ', String(x.why ?? '')))));
    nd.hidden = false;
  }
}

/* ---------- navigation ---------- */
function openCard(id, scroll) {
  const t = document.getElementById(id);
  if (!t) return;
  for (let d = t.closest('details'); d; d = d.parentElement?.closest('details')) d.open = true;
  if (scroll) t.scrollIntoView({ behavior: reduced() ? 'auto' : 'smooth', block: 'start' });
  if (location.hash !== '#' + id) history.replaceState(null, '', '#' + id);
}
function openFromHash() {
  let id = '';
  try { id = decodeURIComponent(location.hash.slice(1)); } catch { return; }
  if (!id) return;
  const t = document.getElementById(id);
  if (!t) return;
  if (t.tagName === 'DETAILS') openCard(id, true); else t.scrollIntoView({ block: 'start' });
}
function setupOpenAll() {
  const b = $('openall');
  if (!b) return;
  b.addEventListener('click', () => {
    const cards = [...document.querySelectorAll('#cards > .lbcard')], open = cards.some((c) => !c.open);
    for (const c of cards) c.open = open;
    b.textContent = open ? 'Close all' : 'Open all';
  });
}

/* ---------- start (last, so every declaration above exists) ---------- */
const manifestP = optional('/manifest.json');
const configP = optional('/config.json');
const regP = optional('/data/registrations/model-v2.json');
const v1P = optional('/data/lab-model-v1.json');
const modelP = import('/shared/model.js').then((m) => (isObj(m.MODEL_V2) ? m.MODEL_V2 : null), () => null);

manifestP.then((mf) => attempt('manifest', () => renderManifest(mf)));
setupOpenAll();
window.addEventListener('hashchange', openFromHash);
loadLab();

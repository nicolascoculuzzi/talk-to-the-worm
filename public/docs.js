// /docs: the overview, and every file the site runs, read from /source/ and shown with line numbers and light
// colouring. No libraries: the colouring is a small scanner per language, made to read by, not a full parser.

const $ = (id) => document.getElementById(id);
const GROUPS = ['server', 'shared', 'public', 'scripts', 'test', 'data/registrations', 'root'];
const SECTIONS = new Set(['overview', 'what', 'spawn', 'check', 'programs', 'endpoints', 'files']);
const LANGS = { js: 'JavaScript', mjs: 'JavaScript', json: 'JSON', jsonl: 'JSON Lines', html: 'HTML', svg: 'SVG', css: 'CSS', py: 'Python', yaml: 'YAML', yml: 'YAML', md: 'Markdown', txt: 'Text', docker: 'Dockerfile', env: 'Settings' };
const BASE_TITLE = document.title;

const body = document.body, main = $('main'), side = $('dside'), tree = $('dtree'), filter = $('dfilter'), toggle = $('dtoggle');
const over = $('overview'), view = $('dview'), box = $('dcodebox'), pre = $('dcode'), gut = $('dgut');
const phone = matchMedia('(max-width: 959px)');
if ('scrollRestoration' in history) history.scrollRestoration = 'manual';

let files = [], byPath = new Map(), groups = new Map(), indexP = null, indexOk = false;
let current = null, seq = 0, overviewY = 0, wantTop = false, wantSection = false;
const texts = new Map();    // path -> {text, size, local, listed}: the bytes shown, their SHA-256 as hashed here and as listed
const folded = new Set();   // folder groups the reader closed

const ESC = /[&<>"]/g, ESC1 = /[&<>"]/, ESCS = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };
const esc = (s) => (ESC1.test(s) ? s.replace(ESC, (c) => ESCS[c]) : s);
const groupOf = (p) => GROUPS.find((g) => g !== 'root' && p.startsWith(g + '/')) || 'root';
const size = (n) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB` : `${(n / 1048576).toFixed(2)} MB`);
const int = (n) => n.toLocaleString('en-US');
const rawUrl = (p) => '/source/' + p.split('/').map(encodeURIComponent).join('/');
const hex = (buf) => Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
const countLines = (t) => (t.match(/\n/g) || []).length + (t && !t.endsWith('\n') ? 1 : 0);
const jump = (y) => { try { scrollTo({ top: y, behavior: 'instant' }); } catch { scrollTo(0, y); } };
function extOf(p) {
  const b = p.slice(p.lastIndexOf('/') + 1), i = b.lastIndexOf('.');
  return b === 'Dockerfile' ? 'docker' : b === '.env.example' ? 'env' : i > 0 ? b.slice(i + 1).toLowerCase() : '';
}

/* ---------- the list of files ---------- */

function loadIndex() {
  indexP = fetch('/source/index.json', { cache: 'no-store' })
    .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
    .then((ix) => { useIndex(ix); return ix; });
  indexP.catch(() => {
    if (indexOk) return;   // a refresh that failed: keep the list we have
    const msg = '<p class="dempty">Couldn\'t load the list of files.<button type="button" class="btn-ghost" data-retry>Try again</button></p>';
    tree.innerHTML = msg;
    $('dfiles').innerHTML = msg;
  });
  return indexP;
}

function useIndex(ix) {
  indexOk = true;
  files = ix.files;
  byPath = new Map(files.map((f) => [f.path, f]));
  groups = new Map(GROUPS.map((g) => [g, []]));
  for (const f of files) groups.get(groupOf(f.path)).push(f);
  const t = ix.total || {};
  $('dcount').textContent = `${int(files.length)} files`;
  $('dtotals').textContent = `${int(files.length)} files, ${int(t.lines ?? files.reduce((n, f) => n + f.lines, 0))} lines, ${size(t.bytes ?? files.reduce((n, f) => n + f.size, 0))}.`;
  $('dshalist').disabled = !files.length;
  renderTree();
  renderFiles();
  if (current) { mark(current); head(current, byPath.get(current), texts.get(current)); }
}

// a path with its folder dimmed and the filter's match marked
function label(rel, cut, s, e) {
  const at = [...new Set([0, cut, s, e, rel.length])].filter((x) => x >= 0 && x <= rel.length).sort((a, b) => a - b);
  let html = '';
  for (let k = 0; k < at.length - 1; k++) {
    const a = at[k], b = at[k + 1];
    let t = esc(rel.slice(a, b));
    if (s >= 0 && a >= s && b <= e) t = `<mark>${t}</mark>`;
    if (b <= cut) t = `<span class="dd">${t}</span>`;
    html += t;
  }
  return html;
}

function renderTree() {
  const q = filter.value.trim().toLowerCase();
  let html = '';
  for (const [g, list] of groups) {
    const hits = q ? list.filter((f) => f.path.toLowerCase().includes(q)) : list;
    if (!hits.length) continue;
    const prefix = g === 'root' ? '' : g + '/';
    html += `<details class="dgrp" data-g="${g}"${q || !folded.has(g) ? ' open' : ''}><summary>${g}<span class="dn">${hits.length}</span></summary><ul>`;
    for (const f of hits) {
      const rel = f.path.slice(prefix.length), at = q ? f.path.toLowerCase().indexOf(q) - prefix.length : -1;
      html += `<li><a href="#${esc(f.path)}" data-p="${esc(f.path)}"${f.path === current ? ' aria-current="page"' : ''}>${label(rel, rel.lastIndexOf('/') + 1, at, at + q.length)}</a></li>`;
    }
    html += '</ul></details>';
  }
  tree.innerHTML = html || (files.length ? `<p class="dempty">No file matches “${esc(filter.value.trim())}”.</p>` : '<p class="dempty">No files.</p>');
}

function renderFiles() {
  let html = '';
  for (const [g, list] of groups) {
    if (!list.length) continue;
    html += `<section class="dfgrp" aria-label="${g}"><h3><span>${g}</span><span>${list.length}</span></h3>`;
    for (const f of list) {
      const cut = f.path.lastIndexOf('/') + 1;
      html += `<a class="dfrow" href="#${esc(f.path)}"><span class="fp"><span class="dd">${esc(f.path.slice(0, cut))}</span>${esc(f.path.slice(cut))}</span>`
        + `<span class="fl">${int(f.lines)} lines</span><span class="fs">${size(f.size)}</span><span class="fh" title="SHA-256 ${f.sha256}">${f.sha256.slice(0, 16)}…</span></a>`;
    }
    html += '</section>';
  }
  $('dfiles').innerHTML = html || '<p class="dempty">No files.</p>';
}

// the open file's link: marked, its folder open, and in view in the sidebar (without moving the page)
function mark(path) {
  for (const a of tree.querySelectorAll('a[aria-current]')) a.removeAttribute('aria-current');
  if (path) $('dhome').removeAttribute('aria-current'); else $('dhome').setAttribute('aria-current', 'page');
  const a = path && tree.querySelector(`a[data-p="${CSS.escape(path)}"]`);
  if (!a) return;
  a.setAttribute('aria-current', 'page');
  const d = a.closest('details');
  if (d && !d.open) { d.open = true; folded.delete(d.dataset.g); }
  const s = side.getBoundingClientRect(), r = a.getBoundingClientRect();
  if (r.top < s.top + 140 || r.bottom > s.bottom - 24) side.scrollTop += r.top - s.top - s.height / 3;
}

function where(path) {
  const w = $('dwhere'), cut = path ? path.lastIndexOf('/') + 1 : 0;
  w.firstElementChild.textContent = path ? path.slice(0, cut) : '';
  w.lastElementChild.textContent = path ? path.slice(cut) : 'Overview';
}

/* ---------- what's shown: the overview, or one file ---------- */

function parseHash() {
  let h = location.hash.slice(1);
  try { h = decodeURIComponent(h); } catch { /* keep it as it is */ }
  const m = /^(.+):L(\d+)$/.exec(h);
  return m ? { key: m[1], line: Number(m[2]) } : { key: h, line: 0 };
}

async function route() {
  const { key, line } = parseHash();
  if (!key || SECTIONS.has(key)) return showOverview(key);
  if (indexOk && !byPath.has(key)) return showOverview('', key);
  openFile(key, line);   // before the list arrives too: it fills in the details when it does
  if (indexOk) return;
  try { await indexP; } catch { return; }
  if (current === key && !byPath.has(key)) showOverview('', key);
}

function showOverview(section, missing = '') {
  const fromFile = current !== null;
  current = null;
  seq++;
  view.hidden = true;
  over.hidden = false;
  document.title = BASE_TITLE;
  mark(null);
  where(null);
  closeDrawer();
  const miss = $('dmissing');
  miss.hidden = !missing;
  if (missing) miss.textContent = `There's no file called “${missing}” here.`;
  // back from a file: where the reader was; a clicked section link: that section
  const el = section && section !== 'overview' ? $(section) : null;
  if (wantTop || missing) jump(0);
  else if (fromFile && !wantSection) jump(overviewY);
  else if (el) el.scrollIntoView({ block: 'start', behavior: fromFile ? 'instant' : 'smooth' });
  wantTop = wantSection = false;
}

async function openFile(path, line) {
  const my = ++seq, fresh = current !== path;
  if (current === null && !over.hidden) overviewY = scrollY;
  current = path;
  over.hidden = true;
  view.hidden = false;
  document.title = `${path} · BRAINWORM docs`;
  mark(path);
  where(path);
  closeDrawer();
  const listed = byPath.get(path)?.sha256;
  let t = texts.get(path);
  head(path, byPath.get(path), t);
  if (fresh && !line) jump(0);
  if (!t || (listed && t.listed !== listed && t.local !== listed)) {
    box.classList.add('loading');
    pre.textContent = '';
    gut.textContent = '';
    delete pre.dataset.p;
    try { t = await fetchFile(path); } catch { if (my === seq) failed(path); return; }
    if (my !== seq) return;
    t.listed = listed;
    texts.set(path, t);
    if (t.local && listed && t.local !== listed) loadIndex().catch(() => {});   // it changed since the list was read
  }
  box.classList.remove('loading');
  if (pre.dataset.p !== path) {
    paint(t.text, extOf(path));
    pre.dataset.p = path;
    pre.setAttribute('aria-label', `The contents of ${path}`);
  }
  head(path, byPath.get(path), t);
  light(line, !!line);
  // picked from the drawer, which hides the link that had focus: carry it to the file
  if (fresh && phone.matches && (document.activeElement === body || side.contains(document.activeElement))) $('dpath').focus({ preventScroll: true });
}

async function fetchFile(path) {
  const r = await fetch(rawUrl(path), { cache: 'no-cache' });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const buf = await r.arrayBuffer();
  let local = null;
  try { if (crypto.subtle) local = hex(await crypto.subtle.digest('SHA-256', buf)); } catch { /* hashing needs https or localhost */ }
  return { text: new TextDecoder().decode(buf), size: buf.byteLength, local };
}

function head(path, f, t) {
  const cut = path.lastIndexOf('/') + 1;
  $('dpath').innerHTML = `<span class="dir">${esc(path.slice(0, cut))}</span>${esc(path.slice(cut))}`;
  $('draw').href = rawUrl(path);
  const lines = f ? f.lines : t ? countLines(t.text) : null, bytes = f ? f.size : t ? t.size : null;
  $('dmeta').innerHTML = [LANGS[extOf(path)] || 'Text', lines !== null && `${int(lines)} line${lines === 1 ? '' : 's'}`, bytes !== null && size(bytes)]
    .filter(Boolean).map((s) => `<span>${s}</span>`).join('');
  const sha = f?.sha256 || t?.local || '';
  $('dsha').textContent = sha || '…';
  $('dcopysha').disabled = !sha;
  const chk = $('dcheck');
  chk.hidden = !t?.local;
  if (!t?.local) return;
  const same = !f || t.local === f.sha256;
  chk.classList.toggle('bad', !same);
  chk.textContent = !f ? '✓ Hashed by your browser from the bytes below.'
    : same ? '✓ Your browser hashed the bytes below and got the same.'
      : 'The bytes below hash differently: this file changed since the list loaded.';
}

function failed(path) {
  box.classList.remove('loading');
  delete pre.dataset.p;
  gut.textContent = '';
  pre.innerHTML = `<span class="derr">Couldn't load ${esc(path)}.<button type="button" class="btn-ghost" data-reopen>Try again</button></span>`;
}

function paint(text, ext) {
  text = text.replace(/\r\n?/g, '\n');
  if (text.endsWith('\n')) text = text.slice(0, -1);   // the last newline ends the last line, it doesn't start one
  const lines = toLines((LEXERS[ext] || plainText)(text));
  let nums = '';
  for (let i = 1; i <= lines.length; i++) nums += `<span>${i}</span>`;
  gut.innerHTML = nums;
  // real newlines between the lines, so copying any part of the code gives back exactly its text
  pre.innerHTML = `<code>${lines.map((l) => `<span class="cl">${l}</span>`).join('\n')}</code>`;
}

function light(n, scroll) {
  for (const el of box.querySelectorAll('.hl')) el.classList.remove('hl');
  const el = n > 0 ? pre.firstElementChild?.children[n - 1] : null;
  if (!el) return;
  el.classList.add('hl');
  gut.children[n - 1]?.classList.add('hl');
  if (scroll) el.scrollIntoView({ block: 'center', behavior: 'instant' });
}

/* ---------- the drawer (phones) ---------- */

function openDrawer() {
  if (!phone.matches) return;
  body.classList.add('dopen');
  toggle.setAttribute('aria-expanded', 'true');
  main.inert = true;
  side.focus({ preventScroll: true });
  const a = tree.querySelector('a[aria-current]');
  if (a) a.scrollIntoView({ block: 'center', behavior: 'instant' });
}
function closeDrawer(refocus = false) {
  if (!body.classList.contains('dopen')) return;
  body.classList.remove('dopen');
  toggle.setAttribute('aria-expanded', 'false');
  main.inert = false;
  if (refocus) toggle.focus();
}

/* ---------- copying ---------- */

async function copy(text, btn) {
  let ok = false;
  try { await navigator.clipboard.writeText(text); ok = true; } catch {
    const ta = document.createElement('textarea');   // http pages and older browsers
    ta.value = text;
    ta.readOnly = true;
    ta.className = 'dclip';
    body.append(ta);
    ta.select();
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    ta.remove();
  }
  btn.dataset.label ??= btn.textContent;
  btn.textContent = ok ? 'Copied' : 'Copy failed';
  clearTimeout(btn.copyTimer);
  btn.copyTimer = setTimeout(() => { btn.textContent = btn.dataset.label; }, 1500);
}

/* ---------- events ---------- */

addEventListener('hashchange', route);
toggle.addEventListener('click', () => (body.classList.contains('dopen') ? closeDrawer(true) : openDrawer()));
$('dscrim').addEventListener('click', () => closeDrawer(true));
side.addEventListener('click', (e) => { if (e.target.closest('a')) closeDrawer(); });
phone.addEventListener('change', () => closeDrawer());
$('dhome').addEventListener('click', (e) => {
  wantTop = true;
  if (location.hash === '#overview') { e.preventDefault(); showOverview('overview'); }
});
filter.addEventListener('input', renderTree);
filter.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    const a = tree.querySelector('a[data-p]');
    if (a) { e.preventDefault(); closeDrawer(); location.hash = a.dataset.p; }
  } else if (e.key === 'Escape' && filter.value) {
    e.stopPropagation();
    filter.value = '';
    renderTree();
  }
});
tree.addEventListener('toggle', (e) => {
  const d = e.target;
  if (d.dataset?.g && !filter.value.trim()) { if (d.open) folded.delete(d.dataset.g); else folded.add(d.dataset.g); }
}, true);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && body.classList.contains('dopen')) { closeDrawer(true); return; }
  const el = document.activeElement;
  if (e.key === '/' && !e.metaKey && !e.ctrlKey && !e.altKey && !(el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)))) {
    e.preventDefault();
    openDrawer();
    filter.focus({ preventScroll: true });
    filter.select();
  }
});
document.addEventListener('click', (e) => {
  const a = e.target.closest?.('a[href^="#"]');
  if (a && SECTIONS.has(a.getAttribute('href').slice(1))) wantSection = location.hash !== a.getAttribute('href');   // same hash: no hashchange
  const t = e.target.closest?.('[data-copy],[data-retry],[data-reopen]');
  if (!t) return;
  if (t.dataset.copy) copy(t.dataset.copy, t);
  else if (t.hasAttribute('data-retry')) loadIndex().then(route, () => {});
  else if (current) { texts.delete(current); openFile(current, 0); }
});
$('dcopysha').addEventListener('click', (e) => copy($('dsha').textContent, e.currentTarget));
$('dshalist').addEventListener('click', (e) => copy(files.map((f) => `${f.sha256}  ${f.path}\n`).join(''), e.currentTarget));
// a line number links to its line
gut.addEventListener('click', (e) => {
  const s = e.target.closest?.('span');
  if (!s || !current) return;
  const n = Array.prototype.indexOf.call(gut.children, s) + 1;
  light(n, false);
  history.replaceState(null, '', `#${current}:L${n}`);
});

/* ---------- colouring: each scanner turns text into [class, text] tokens ('' is plain) ---------- */

const plainText = (src) => [['', src]];

// one sticky regex, one group per kind of token; a class can be a function of the matched text
function lexWith(re, classes) {
  return (src) => {
    const out = [];
    let plain = 0, m;
    re.lastIndex = 0;
    while (re.lastIndex < src.length && (m = re.exec(src))) {
      if (!m[0]) { re.lastIndex++; continue; }
      let g = 1;
      while (m[g] === undefined) g++;
      let cls = classes[g - 1];
      if (typeof cls === 'function') cls = cls(m[0]);
      if (!cls) continue;
      if (m.index > plain) out.push(['', src.slice(plain, m.index)]);
      out.push([cls, m[0]]);
      plain = re.lastIndex;
    }
    if (plain < src.length) out.push(['', src.slice(plain)]);
    return out;
  };
}

function byLine(fn) {
  return (src) => {
    const out = [];
    src.split('\n').forEach((l, k) => {
      if (k) out.push(['', '\n']);
      for (const t of fn(l)) if (t[1]) out.push(t);
    });
    return out;
  };
}

// tokens -> one HTML string per line, so no element ever spans two lines
function toLines(tokens) {
  const lines = [];
  let cur = '';
  for (const [cls, s] of tokens) {
    let a = 0;
    for (;;) {
      const nl = s.indexOf('\n', a), piece = nl < 0 ? s.slice(a) : s.slice(a, nl);
      if (piece) cur += cls ? `<span class="${cls}">${esc(piece)}</span>` : esc(piece);
      if (nl < 0) break;
      lines.push(cur);
      cur = '';
      a = nl + 1;
    }
  }
  lines.push(cur);
  return lines;
}

const JS_KW = new Set('async await break case catch class const continue debugger default delete do else export extends finally for from function if import in instanceof let new of return static super switch this throw try typeof var void while with yield'.split(' '));
const JS_LIT = new Set(['true', 'false', 'null', 'undefined', 'NaN', 'Infinity']);
const JS_EXPR = new Set(['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case', 'do', 'else', 'yield', 'await', 'extends']);   // a / after these starts a regex

function lexJS(src) {
  const out = [], n = src.length, NUM = /(?:0[xX][\da-fA-F_]+|0[bB][01_]+|0[oO][0-7_]+|(?:\d[\d_]*(?:\.[\d_]*)?|\.\d[\d_]*)(?:[eE][+-]?\d[\d_]*)?)n?/y, ID = /[A-Za-z_$À-￿][\w$À-￿]*/y;
  let plain = 0;
  const push = (cls, a, b) => { if (a > plain) out.push(['', src.slice(plain, a)]); out.push([cls, src.slice(a, b)]); plain = b; };
  const quote = (i, q) => {   // '...' or "...", which can't run past the end of their line
    for (let j = i + 1; j < n; j++) { const c = src[j]; if (c === '\\') j++; else if (c === q) return j + 1; else if (c === '\n') return j; }
    return n;
  };
  const regex = (i) => {      // the end of a regex literal starting at i, or -1 if there's none on this line
    let cls = false;
    for (let j = i + 1; j < n; j++) {
      const c = src[j];
      if (c === '\n') return -1;
      if (c === '\\') j++;
      else if (c === '[') cls = true;
      else if (c === ']') cls = false;
      else if (c === '/' && !cls) { j++; while (j < n && /[a-z]/i.test(src[j])) j++; return j; }
    }
    return -1;
  };
  const template = (i) => {   // `...${ code }...`: the text is a string, the code inside ${} is coloured as code
    let a = i;
    for (i++; i < n; i++) {
      const c = src[i];
      if (c === '\\') i++;
      else if (c === '`') { push('ts', a, i + 1); return i + 1; }
      else if (c === '$' && src[i + 1] === '{') { push('ts', a, i + 2); i = code(i + 2, true); if (i >= n) return n; a = i; }
    }
    push('ts', a, n);
    return n;
  };
  function code(i, inner) {   // until the end, or (inner) the } that closes a ${
    let value = false, dot = false, depth = 0;   // value: a / here divides; dot: a word here is a property
    while (i < n) {
      const c = src[i];
      if (c === ' ' || c === '\t' || c === '\n' || c === '\r') { i++; continue; }
      if (c === '/') {
        const d = src[i + 1];
        if (d === '/') { let j = src.indexOf('\n', i); if (j < 0) j = n; push('tc', i, j); i = j; continue; }
        if (d === '*') { let j = src.indexOf('*/', i + 2); j = j < 0 ? n : j + 2; push('tc', i, j); i = j; continue; }
        if (!value) { const j = regex(i); if (j > 0) { push('tr', i, j); i = j; value = true; dot = false; continue; } }
        i++; value = false; dot = false;
        continue;
      }
      if (c === '"' || c === "'") { const j = quote(i, c); push('ts', i, j); i = j; value = true; dot = false; continue; }
      if (c === '`') { i = template(i); value = true; dot = false; continue; }
      if ((c >= '0' && c <= '9') || (c === '.' && src[i + 1] >= '0' && src[i + 1] <= '9')) {
        NUM.lastIndex = i; NUM.exec(src);
        push('tn', i, NUM.lastIndex); i = NUM.lastIndex; value = true; dot = false;
        continue;
      }
      ID.lastIndex = i;
      const m = ID.exec(src);
      if (m) {
        const w = m[0], j = i + w.length;
        if (!dot && JS_KW.has(w)) push('tk', i, j);
        else if (!dot && JS_LIT.has(w)) push('tn', i, j);
        value = dot || !JS_EXPR.has(w); dot = false; i = j;
        continue;
      }
      if (c === '{') depth++;
      else if (c === '}') { if (inner && depth === 0) return i; depth--; }
      dot = c === '.';
      value = c === ')' || c === ']' || c === '}';
      i++;
    }
    return i;
  }
  let start = 0;
  if (src.startsWith('#!')) { start = src.indexOf('\n'); if (start < 0) start = n; push('tc', 0, start); }
  code(start, false);
  if (plain < n) out.push(['', src.slice(plain)]);
  return out;
}

function lexHTML(src) {   // tags, attributes, their values and comments; also SVG
  const out = [], n = src.length, TAG = /<\/?[A-Za-z!?][\w:.-]*/y, ATTR = /\s+|[^\s=>/"']+|=|"[^"]*"?|'[^']*'?|\/?>|[\s\S]/y;
  let i = 0, plain = 0;
  const push = (cls, a, b) => { if (a > plain) out.push(['', src.slice(plain, a)]); out.push([cls, src.slice(a, b)]); plain = b; };
  while (i < n) {
    const lt = src.indexOf('<', i);
    if (lt < 0) break;
    if (src.startsWith('<!--', lt)) { const e = src.indexOf('-->', lt + 4); i = e < 0 ? n : e + 3; push('tc', lt, i); continue; }
    TAG.lastIndex = lt;
    if (!TAG.exec(src)) { i = lt + 1; continue; }
    push('tt', lt, TAG.lastIndex);
    let j = TAG.lastIndex, eq = false;
    while (j < n) {
      ATTR.lastIndex = j;
      const a = ATTR.exec(src)[0], k = j + a.length, c = a[0];
      if (a === '>' || a === '/>') { push('tt', j, k); j = k; break; }
      if (c === '"' || c === "'") { push('ts', j, k); eq = false; }
      else if (a === '=') eq = true;
      else if (!/\s/.test(c)) { push(eq ? 'ts' : 'tp', j, k); eq = false; }
      j = k;
    }
    i = j;
  }
  if (plain < n) out.push(['', src.slice(plain)]);
  return out;
}

function lexCSS(src) {   // properties are coloured only inside a rule's { }, so a:hover stays a selector
  const re = /(\/\*[\s\S]*?(?:\*\/|$))|("(?:[^"\\\n]|\\[\s\S])*"?|'(?:[^'\\\n]|\\[\s\S])*'?)|(@[\w-]+)|(#[\da-fA-F]{3,8}(?![\w-]))|(--[\w-]+)|(-?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?(?:%|[a-zA-Z]+)?)|(-?[a-zA-Z_][\w-]*)|(!important)|([{};])|([^{};"'/@#.\w!-]+|[\s\S])/y;
  const out = [], stack = [];
  let plain = 0, prelude = 0, m;
  const push = (cls, a, b) => { if (a > plain) out.push(['', src.slice(plain, a)]); out.push([cls, src.slice(a, b)]); plain = b; };
  re.lastIndex = 0;
  while (re.lastIndex < src.length && (m = re.exec(src))) {
    const a = m.index, b = re.lastIndex;
    if (m[1] !== undefined) push('tc', a, b);
    else if (m[2] !== undefined) push('ts', a, b);
    else if (m[3] !== undefined || m[8] !== undefined) push('tk', a, b);
    else if (m[4] !== undefined || m[6] !== undefined) push('tn', a, b);
    else if (m[5] !== undefined) push('tp', a, b);
    else if (m[7] !== undefined) { if (stack[stack.length - 1] === 'decl' && /^\s*:/.test(src.slice(b, b + 24))) push('tp', a, b); }
    else if (m[9] !== undefined) {
      if (m[9] === '{') stack.push(/^@(?:-[a-z]+-)?(?:media|supports|layer|container|document|scope|keyframes|starting-style)\b/.test(src.slice(prelude, a).trim()) ? 'at' : 'decl');
      else if (m[9] === '}') stack.pop();
      prelude = b;
    }
  }
  if (plain < src.length) out.push(['', src.slice(plain)]);
  return out;
}

const PY_KW = new Set('and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield'.split(' '));
const lexPy = lexWith(
  /(#.*)|((?:[rRbBuUfF]{1,2})?(?:"""[\s\S]*?(?:"""|$)|'''[\s\S]*?(?:'''|$)|"(?:[^"\\\n]|\\[\s\S])*"?|'(?:[^'\\\n]|\\[\s\S])*'?))|(@[A-Za-z_][\w.]*)|((?:0[xX][\da-fA-F_]+|0[bB][01_]+|0[oO][0-7_]+|(?:\d[\d_]*\.?[\d_]*|\.\d[\d_]*)(?:[eE][+-]?\d+)?j?))|([A-Za-z_]\w*)|([^#"'@\w.]+|[\s\S])/y,
  ['tc', 'ts', 'tp', 'tn', (w) => (PY_KW.has(w) ? 'tk' : w === 'True' || w === 'False' || w === 'None' ? 'tn' : ''), ''],
);

const lexJSON = lexWith(/("(?:[^"\\\n]|\\.)*")(?=\s*:)|("(?:[^"\\\n]|\\.)*"?)|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|(true|false|null)(?![\w$])|([^"\d\-tfn]+|[\s\S])/y, ['tp', 'ts', 'tn', 'tn', '']);

const quoted = lexWith(/("(?:[^"\\\n]|\\.)*"?|'[^'\n]*'?)|([^"']+)/y, ['ts', '']);

const lexYAML = byLine((l) => {
  let com = '', i = l.search(/(?:^|\s)#/);
  if (i >= 0) { if (l[i] !== '#') i++; com = l.slice(i); l = l.slice(0, i); }
  const value = (v) => {
    const t = v.trim();
    if (!t) return [['', v]];
    const lead = v.slice(0, v.indexOf(t));
    return [['', lead], [/^(["']).*\1$/.test(t) ? 'ts' : /^(-?\d+(\.\d+)?|true|false|null|~)$/.test(t) ? 'tn' : '', t], ['', v.slice(lead.length + t.length)]];
  };
  const m = /^(\s*(?:-\s+)?)([\w.$/-]+)(\s*:)(\s.*|)$/.exec(l);
  return [...(m ? [['', m[1]], ['tp', m[2]], ['', m[3]], ...value(m[4])] : value(l)), ['tc', com]];
});

const lexDocker = byLine((l) => {
  if (/^\s*#/.test(l)) return [['tc', l]];
  const m = /^(\s*)([A-Z]+)(\s.*|)$/.exec(l);
  return m ? [['', m[1]], ['tk', m[2]], ...quoted(m[3])] : quoted(l);
});

const lexEnv = byLine((l) => {
  if (/^\s*#/.test(l)) return [['tc', l]];
  const m = /^(\s*)([A-Za-z_]\w*)(=)(.*)$/.exec(l);
  return m ? [['', m[1]], ['tp', m[2]], ['', m[3]], ['ts', m[4]]] : [['', l]];
});

const mdInline = lexWith(/(`[^`]+`)|(\]\([^)\s]+\)|<https?:\/\/[^>\s]+>)|(\*\*[^*]+\*\*)|(^\s*(?:[-*+]|\d+\.)(?=\s))|([^`\]*<\-+\d\s]+|[\s\S])/y, ['ts', 'tp', 'th', 'tk', '']);
function lexMD(src) {
  const out = [];
  let fence = false;
  src.split('\n').forEach((l, k) => {
    if (k) out.push(['', '\n']);
    if (/^\s*(```|~~~)/.test(l)) { fence = !fence; out.push(['tc', l]); }
    else if (fence) out.push(['ts', l]);
    else if (/^#{1,6}\s/.test(l)) out.push(['th', l]);
    else if (/^\s*>/.test(l)) out.push(['tc', l]);
    else for (const t of mdInline(l)) out.push(t);
  });
  return out;
}

const LEXERS = { js: lexJS, mjs: lexJS, json: lexJSON, jsonl: lexJSON, html: lexHTML, svg: lexHTML, css: lexCSS, py: lexPy, yaml: lexYAML, yml: lexYAML, md: lexMD, docker: lexDocker, env: lexEnv };

/* ---------- start ---------- */

$('dreplay').textContent = `npm run replay -- ${location.origin}/log/current.jsonl`;
loadIndex().catch(() => {});
route();

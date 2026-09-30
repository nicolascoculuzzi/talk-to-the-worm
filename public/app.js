// BRAINWORM browser client. The server runs the one worm and streams its activity; this page
// draws it, sends messages, tugs and pokes, and tells the story of what's happening. If the live
// connection is down it runs its own copy (offline mode) until the connection comes back.
import { indexRoles, readouts } from '/shared/roles.js';
import { WormCore, TUG_ORDER, TUG_SCORED } from '/shared/worm.js';
import { STEPS_PER_SECOND } from '/shared/sim.js';
import { VIEW, renderText, durationSteps } from '/shared/text.js';
import { decodeFrame } from '/shared/frames.js';
import { createGLRenderer, deform, project, KIND_INDEX } from '/gl.js';
import { create2DRenderer } from '/render2d.js';
import { createSound } from '/sound.js';
import { paintLED, paintLEDLevels, eyeWindows, pixelWordmark } from '/pixel.js';
import { createClipBuffer, recordClip, clipSupported, CLIP_SECONDS } from '/clip.js';
import { mirrorEvent } from '/shared/mirror.js';
import { loadMorph } from '/morph.js';
import { withTransmitters } from '/shared/data.js';
import { createTank } from '/tank.js';
import { BODY, UM_PER_UNIT } from '/shared/body.js';
import { LAMP, lampLight } from '/shared/lamp.js';
import { ciliaInputs, beats, meanArrestAll } from '/shared/cilia.js';
import { mountLaunchForm } from '/launchform.js';
import { coinCard, compact } from '/coincard.js';

const $ = (id) => document.getElementById(id);
const body = document.body;
const STREAM = /^\/stream\/?$/.test(location.pathname);
if (STREAM) body.classList.add('stream');
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
const coarse = matchMedia('(pointer: coarse)').matches;
const store = {
  get(k, d) { try { const v = localStorage.getItem('bw.' + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('bw.' + k, JSON.stringify(v)); } catch { /* private mode */ } },
};
const fmt = (n) => Math.round(n).toLocaleString('en-US');
const utc = (ts) => new Date(ts).toISOString().slice(11, 16) + ' UTC';
const short = (h) => (h ? `${h.slice(0, 10)}…${h.slice(-6)}` : '—');
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };

/* ---------- the data ---------- */
const D = withTransmitters(...(await Promise.all(['/data/wiring.json', '/data/transmitters.json'].map((u) => fetch(u).then((r) => r.json())))));
const N = D.n.length;
const roles = indexRoles(D);
const STEP_MS = 1000 / STEPS_PER_SECOND;
const HEX = { eye: '#FFB84D', touch: '#FF9E7A', sn: '#7FC8FF', in: '#B9C9E8', mn: '#C49BFF', mus: '#FF6B5E', cil: '#56E6D2', other: '#6E7F8C' };
const COLORS = Object.fromEntries(Object.entries(HEX).map(([k, h]) => [k, [1, 3, 5].map((o) => parseInt(h.slice(o, o + 2), 16))]));
const KLABEL = { eye: 'eye photoreceptor', touch: 'touch sensor', sn: 'sensory neuron', in: 'interneuron', mn: 'motor neuron', mus: 'muscle', cil: 'ciliated swimming cell', other: 'gland, glia or pigment cell' };
const SEGNAME = { episphere: 'head', segment_0: 'segment 0', segment_1: 'segment 1', segment_2: 'segment 2', segment_3: 'segment 3', pygidium: 'tail', fragment: '' };
function kindOf(x) {
  if (x[6] & 1) return 'eye';
  if (x[6] & 4) return 'touch';
  if (x[6] & 64) return 'cil';
  if (x[1] === 0) return 'sn';
  if (x[1] === 1) return 'in';
  if (x[1] === 2) return 'mn';
  if (x[1] === 3) return /^MUS/.test(x[0]) ? 'mus' : 'other';
  return 'other';
}
const KIND = D.n.map(kindOf);
const inDeg = new Int32Array(N), outDeg = new Int32Array(N);
for (let k = 0; k < D.e.length; k += 3) { outDeg[D.e[k]]++; inDeg[D.e[k + 1]]++; }
const drawn = roles.drawn;

$('wordmark').append(pixelWordmark([{ text: 'BRAIN', cls: 'ink' }, { text: 'WORM', cls: 'amber', glow: true }]));

/* ---------- renderer ---------- */
let cv = $('brain');
let R = null;
try { R = createGLRenderer(cv, { D, colors: COLORS, kinds: KIND, quality: coarse ? 'low' : 'high' }); } catch (e) { console.warn('WebGL renderer failed, using 2D', e); }
if (!R) {
  const c2 = cv.cloneNode(); cv.replaceWith(c2); cv = c2;
  R = create2DRenderer(cv, { D, colors: COLORS, kinds: KIND });
}
const ov = $('overlay'), og = ov.getContext('2d');
let dprScale = Math.min(window.devicePixelRatio || 1, coarse ? 1.5 : 2);
let VW = 1, VH = 1, ODPR = 1;
function resize() {
  VW = cv.clientWidth || innerWidth; VH = cv.clientHeight || innerHeight;
  R.resize(VW * dprScale, VH * dprScale);
  ODPR = Math.min(2, window.devicePixelRatio || 1);
  ov.width = Math.round(VW * ODPR); ov.height = Math.round(VH * ODPR);
  og.setTransform(ODPR, 0, 0, ODPR, 0, 0);
  measureLayout();
}

/* ---------- live state ---------- */
const act8 = new Uint8Array(N);
let fPrev = new Uint8Array(N), fCur = new Uint8Array(N);
const fTmp = new Uint8Array(N);
let curStep = -1, curT = 0;
let mode = 'connecting';
let local = null, localAcc = 0, localIds = 0;
let you = null, watchers = 0;
let nowMsg = null;          // {id, kind, text|a,b, by, startStep}
let queue = [];
const feed = new Map();
let board = { today: [], all: [], tugs: [] };
let modState = { chatPaused: false, pokesPaused: false, slowSec: 0, announce: null };
let site = {}, features = {}, calibration = null, twitch = null;
const ripples = [];

function currentStep(now) {
  if (mode === 'offline' && local) return local.step;
  if (curStep < 0) return 0;
  return curStep + Math.min(60, (now - curT) / STEP_MS);
}

/* ---------- connection ---------- */
let ws = null, retry = 0;
function connect() {
  let sock;
  try { sock = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/live'); } catch { return scheduleReconnect(); }
  ws = sock;
  sock.binaryType = 'arraybuffer';
  const failTimer = setTimeout(() => { if (mode !== 'live') goOffline(); }, 6000);
  sock.onmessage = (e) => {
    if (typeof e.data === 'string') { let m; try { m = JSON.parse(e.data); } catch { return; } onServer(m); } else onFrame(e.data);
  };
  sock.onclose = () => {
    clearTimeout(failTimer);
    if (ws === sock) ws = null;
    resetMirror('Reconnecting');
    if (mode === 'live') goOffline();
    scheduleReconnect();
  };
}
function scheduleReconnect() { setTimeout(connect, Math.min(15000, 800 * 2 ** retry++)); }
document.addEventListener('visibilitychange', () => { if (!document.hidden && !ws) { retry = 0; connect(); } });

function setMode(m) {
  mode = m;
  const s = $('status');
  s.dataset.mode = m;
  s.textContent = m === 'live' ? 'Live' : m === 'offline' ? 'Offline · your own copy' : 'Connecting';
  $('watchers').textContent = m === 'live' ? `${fmt(watchers)} watching` : ' ';
}

function goOffline() {
  if (mode === 'offline') return;
  local = new WormCore(D, { onEvent: onLocalEvent });
  nowMsg = null; queue = []; feed.clear(); renderFeed();
  swimTrail = []; poseTo = null;
  setMode('offline');
  setBadge('off', 'Offline');
}

function onFrame(buf) {
  const u8 = new Uint8Array(buf);
  const step = decodeFrame(u8, fTmp, poseTmp);
  if (step < 0) return;
  if (curStep >= 0 && step - curStep <= 4 && step > curStep) { const t = fPrev; fPrev = fCur; fCur = t; fCur.set(fTmp); }
  else { fPrev.set(fTmp); fCur.set(fTmp); }
  curStep = step; curT = performance.now();
  if (u8[0] > 2) onPose(step, poseTmp);
}

/* ---------- the body: its pose comes with every frame and is eased between them ---------- */
const poseTmp = new Float64Array(8);
const pose = { p: [0, 0, 0], q: [1, 0, 0, 0], dist: 0 };
let poseFrom = null, poseTo = null, poseT0 = 0, poseDur = 1, poseStep = -1;
let swimTrail = [], trailStep = -1, swimSpeed = 0;
const TRAIL_EVERY = 6, TRAIL_MAX = 300 * 3;
function pushTrail(p) { swimTrail.push(p[0], p[1], p[2]); if (swimTrail.length > TRAIL_MAX) swimTrail.splice(0, swimTrail.length - TRAIL_MAX); }
function onPose(step, v) {
  const to = { p: [v[0], v[1], v[2]], q: [v[3], v[4], v[5], v[6]], dist: v[7] };
  const ds = step - poseStep;
  if (poseTo && ds > 0 && ds < 90) {
    swimSpeed += ((to.dist - poseTo.dist) / ds * STEPS_PER_SECOND * UM_PER_UNIT - swimSpeed) * 0.35;
    poseFrom = { p: [...pose.p], q: [...pose.q], dist: pose.dist };
    poseDur = Math.min(400, ds * STEP_MS);
  } else { poseFrom = to; poseDur = 1; }
  poseTo = to; poseT0 = performance.now(); poseStep = step;
  if (trailStep < 0 || step - trailStep >= TRAIL_EVERY || step < trailStep) { pushTrail(to.p); trailStep = step; }
}
function updatePose(now) {
  if (mode === 'offline' && local) { const b = local.body.state; pose.p = [...b.p]; pose.q = [...b.q]; pose.dist = b.dist; return; }
  if (!poseTo) return;
  const a = Math.min(1, (now - poseT0) / poseDur), A = poseFrom, B = poseTo;
  for (let k = 0; k < 3; k++) pose.p[k] = A.p[k] + (B.p[k] - A.p[k]) * a;
  const sgn = A.q[0] * B.q[0] + A.q[1] * B.q[1] + A.q[2] * B.q[2] + A.q[3] * B.q[3] < 0 ? -1 : 1;
  let l = 0;
  for (let k = 0; k < 4; k++) { pose.q[k] = A.q[k] * (1 - a) + B.q[k] * sgn * a; l += pose.q[k] * pose.q[k]; }
  l = Math.sqrt(l) || 1; for (let k = 0; k < 4; k++) pose.q[k] /= l;
  pose.dist = A.dist + (B.dist - A.dist) * a;
}

function withMeta(m) { return { ...m, kind: m.kind || 'say' }; }

function onServer(m) {
  proofTap(m);
  switch (m.t) {
    case 'hello':
      retry = 0; you = m.you; watchers = m.watchers; local = null;
      swimTrail = Array.isArray(m.trail) ? m.trail.slice(-TRAIL_MAX) : []; trailStep = m.step; poseTo = null;
      feed.clear(); for (const it of m.feed || []) feed.set(it.id, { ...it });
      queue = m.queue || [];
      nowMsg = m.current ? withMeta(m.current) : null;
      if (m.board) setBoard(m.board);
      if (m.mod) setMod(m.mod);
      if (m.proof) setProofHead(m.proof);
      twitch = m.twitch || null; renderTwitch();
      if (m.launch) setLaunch(m.launch);
      setMode('live'); renderFeed(true); break;
    case 'watchers': watchers = m.n; setMode(mode); break;
    case 'queued':
      queue.push({ id: m.id, kind: 'say', text: m.text, by: m.by });
      feed.set(m.id, { id: m.id, kind: 'say', by: m.by, text: m.text, step: null, ahead: m.ahead, ts: Date.now() });
      if (m.by === you) toast(m.ahead ? `Queued: ${m.ahead} ahead of you` : 'Up next', true);
      renderFeed(); break;
    case 'tugqueued':
      queue.push({ id: m.id, kind: 'tug', a: m.a, b: m.b, by: m.by });
      feed.set(m.id, { id: m.id, kind: 'tug', by: m.by, a: m.a, b: m.b, step: null, ahead: m.ahead, ts: Date.now() });
      if (m.by === you) toast(m.ahead ? `Tug queued: ${m.ahead} ahead of you` : 'Your tug is up next', true);
      renderFeed(); break;
    case 'lampqueued':
      queue.push({ id: m.id, kind: 'lamp', by: m.by });
      feed.set(m.id, { id: m.id, kind: 'lamp', by: m.by, step: null, ahead: m.ahead, ts: Date.now() });
      if (m.by === you) toast(m.ahead ? `Lamp queued: ${m.ahead} ahead of you` : 'Your lamp is next', true);
      renderFeed(); break;
    case 'start':
      queue = queue.filter((q) => q.id !== m.id);
      nowMsg = withMeta({ id: m.id, kind: m.kind, text: m.text, a: m.a, b: m.b, pos: m.pos, by: m.by, startStep: m.step });
      { const it = feed.get(m.id); if (it) it.step = m.step; }
      onStimulusStart(nowMsg);
      renderFeed(); break;
    case 'poke':
      feed.set(m.id, { id: m.id, kind: 'poke', by: m.by, cells: m.cells, step: m.step, ts: m.ts });
      if (m.by !== you) ripples.push({ cells: m.cells, t: performance.now(), hit: true, by: m.by });
      renderFeed(); break;
    case 'tugresult': {
      const it = feed.get(m.id); if (it) it.result = m.result;
      onTugResult(m); renderFeed(); break;
    }
    case 'done': { const it = feed.get(m.id); if (it) { it.summary = m.summary; if (m.summary.tug) it.result = m.summary.tug; renderFeed(); } break; }
    case 'hide': feed.delete(m.id); renderFeed(); break;
    case 'feed': feed.clear(); for (const it of m.feed) feed.set(it.id, { ...it }); renderFeed(true); break;
    case 'board': setBoard(m.board); break;
    case 'record': onRecord(m); break;
    case 'mod': setMod(m); break;
    case 'proof': setProofHead(m.proof); loadProof(); break;
    case 'launch': setLaunch(m.launch); break;
    case 'error': toast(m.message); break;
  }
}

/* ---------- offline worm ---------- */
function onLocalEvent(ev) {
  if (ev.type === 'start') {
    queue = queue.filter((q) => q.id !== ev.id);
    const it = feed.get(ev.id); if (it) it.step = ev.step;
    nowMsg = withMeta({ id: ev.id, kind: ev.kind, text: ev.text, a: ev.a, b: ev.b, pos: ev.pos, by: 'you', startStep: ev.step });
    onStimulusStart(nowMsg);
  } else if (ev.type === 'poke') {
    feed.set(ev.id, { id: ev.id, kind: 'poke', by: you || 'you', cells: ev.cells, step: ev.step });
  } else if (ev.type === 'tug') {
    const it = feed.get(ev.id); if (it) it.result = ev.result;
    onTugResult({ id: ev.id, a: ev.a, b: ev.b, result: ev.result });
  } else if (ev.type === 'done') {
    const it = feed.get(ev.id); if (it) it.summary = ev.summary;
  }
  renderFeed();
}

/* ---------- sending ---------- */
const live = () => mode === 'live' && ws && ws.readyState === 1;
// before the server accepts anything, this browser solves a small proof-of-work puzzle (in the
// worker, ~0.1 s); anything sent before that waits here and goes the moment it's solved
let powReady = true;
const outbox = [];
function send(o) {
  if (mode === 'connecting' || (mode === 'live' && !powReady)) { if (outbox.length < 4) outbox.push(o); return true; }
  if (!live()) return false;
  ws.send(JSON.stringify(o));
  return true;
}
function flushOutbox() { while (outbox.length && live() && powReady) ws.send(JSON.stringify(outbox.shift())); }
function say(text) {
  text = (text || '').trim();
  if (!text) return false;
  dismissCoach();
  if (mode !== 'offline' && send({ t: 'say', text })) return true;
  if (!local) goOffline();
  const id = 'L' + (++localIds), shown = [...text].slice(0, 40).join('');
  const ahead = local.say(id, shown, { by: 'you' });
  queue.push({ id, kind: 'say', text: shown, by: 'you' });
  feed.set(id, { id, kind: 'say', by: you || 'you', text: shown, step: null, ahead });
  renderFeed();
  return true;
}
function tug(a, b) {
  a = (a || '').trim(); b = (b || '').trim();
  if (!a || !b) { toast('Type two words.'); return false; }
  dismissCoach();
  if (mode !== 'offline' && send({ t: 'tug', a, b })) return true;
  if (!local) goOffline();
  const id = 'T' + (++localIds);
  const ahead = local.tug(id, a.slice(0, 10), b.slice(0, 10), { by: 'you' });
  queue.push({ id, kind: 'tug', a, b, by: 'you' });
  feed.set(id, { id, kind: 'tug', by: you || 'you', a, b, step: null, ahead });
  renderFeed();
  return true;
}
function lamp() {
  dismissCoach();
  if (mode !== 'offline' && send({ t: 'lamp' })) return true;
  if (!local) goOffline();
  const id = 'M' + (++localIds), g = () => Math.random() * 2 - 1;
  let d = [g(), g(), g()]; while (Math.hypot(...d) < 0.1) d = [g(), g(), g()];
  local.lamp(id, d, { by: 'you' });
  queue.push({ id, kind: 'lamp', by: 'you' });
  feed.set(id, { id, kind: 'lamp', by: you || 'you', step: null });
  renderFeed();
  return true;
}
function sendPoke(cells) {
  if (modState.pokesPaused) { toast('Pokes are paused by the mods for a moment.'); return; }
  if (mode !== 'offline' && send({ t: 'poke', cells })) return;
  if (!local) goOffline();
  local.poke('P' + (++localIds), cells, { by: 'you' });
}
let toastTimer = null;
function toast(text, ok = false) {
  const t = $('toast'); t.textContent = text; t.classList.toggle('ok', ok);
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.textContent = ''; }, 4200);
}

// the worm's own controls fold behind one button: the launch card is what the page is for
const tabs = { say: $('tab-say'), tug: $('tab-tug'), lamp: $('tab-lamp') };
function setTab(which) {
  if (!tabs[which]) which = 'say';
  for (const [k, b] of Object.entries(tabs)) b.setAttribute('aria-selected', String(k === which));
  $('talk').hidden = which !== 'say'; $('tugform').hidden = which !== 'tug'; $('lampform').hidden = which !== 'lamp';
  $('chips').hidden = which !== 'say';
}
function openDock(open) {
  $('dock').classList.toggle('closed', !open);
  $('talkbtn').setAttribute('aria-expanded', String(open));
  if (open && !store.get('coached', false)) $('coach').hidden = false;
  if (open) $('msg').focus({ preventScroll: true });
}
$('talkbtn').addEventListener('click', () => openDock(true));
$('dockx').addEventListener('click', () => { openDock(false); dismissCoach(); });
tabs.say.addEventListener('click', () => { setTab('say'); $('msg').focus(); });
tabs.tug.addEventListener('click', () => { setTab('tug'); $('tugwa').focus(); });
tabs.lamp.addEventListener('click', () => setTab('lamp'));
$('lampform').addEventListener('submit', (e) => { e.preventDefault(); lamp(); });
$('talk').addEventListener('submit', (e) => { e.preventDefault(); const i = $('msg'); if (say(i.value)) i.value = ''; });
$('tugform').addEventListener('submit', (e) => { e.preventDefault(); if (tug($('tugwa').value, $('tugwb').value)) { $('tugwa').value = ''; $('tugwb').value = ''; } });
$('chips').addEventListener('click', (e) => { const b = e.target.closest('.chip'); if (b) say(b.textContent); });
$('pokebtn').addEventListener('click', () => {
  const i = roles.touch[Math.floor(Math.random() * roles.touch.length)];
  const near = roles.touch.map((j) => [dist3(i, j), j]).sort((a, b) => a[0] - b[0]).slice(0, 4).map((c) => c[1]);
  ripples.push({ cells: near, t: performance.now(), hit: true, mine: true });
  sendPoke(near);
});
function dist3(i, j) { const a = D.n[i][5], b = D.n[j][5]; return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]); }
for (const a of document.querySelectorAll('[data-go]')) {
  a.addEventListener('click', (e) => {
    e.preventDefault();
    if (a.dataset.go === 'swim') { $('swim').scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'center' }); $('swim').classList.remove('lit'); void $('swim').offsetWidth; $('swim').classList.add('lit'); return; }
    scrollTo({ top: 0, behavior: reduceMotion ? 'auto' : 'smooth' });
    const go = a.dataset.go;
    if (go !== 'launch') { openDock(true); setTab(go); }
    setTimeout(() => (go === 'tug' ? $('tugwa') : go === 'lamp' ? $('lampform').querySelector('button') : go === 'say' ? $('msg') : $('lname')).focus({ preventScroll: true }), 500);
  });
}

/* ---------- camera: a director, a scroll story, and your hands ---------- */
const TWO_PI = Math.PI * 2;
const wrap = (a) => a - TWO_PI * Math.floor((a + Math.PI) / TWO_PI);
const cam = { yaw: 2.6, pitch: 0.55, dist: 9, ty: 0.25, ox: 0, oy: 0, fov: 0.55 };
const aim = { yaw: 0.35, pitch: 0.12, dist: 4.4, ty: -0.16, ox: 0, oy: 0 };
const look = { exposure: 1.15, web: 0.014, kind: -1, kindK: 0, haze: 0.007, anatomy: 0 };
const lookAim = { ...look };
let heroOx = 0, heroOy = 0, scene = 'hero', step = null;
let userUntil = 0;             // the director leaves the camera alone until then
let spin = { yaw: 0, pitch: 0 };
let shake = 0;
let director = null;           // {until, ...overrides}
let introUntil = performance.now() + (reduceMotion ? 0 : 2600);

const SCENES = {
  hero: {},
  what: { ox: 0.42, oy: 0, dist: 3.1, ty: -0.12, exposure: 1.05, web: 0.022 },
  experiments: { ox: 0, oy: 0, dist: 4.2, ty: -0.16, exposure: 0.5 },
  board: { ox: 0, oy: 0, dist: 4.0, ty: -0.16, exposure: 0.5 },
  how: { ox: 0.42, oy: 0, dist: 3.2, ty: -0.12, exposure: 1.05 },
  proof: { ox: 0, oy: 0, dist: 4.4, ty: -0.16, exposure: 0.42, web: 0.03 },
  plainly: { ox: 0.42, oy: 0, dist: 3.4, ty: -0.14, exposure: 0.85 },
};
const STEPS = {
  eyes: { ty: 0.4, dist: 1.75, yaw: 0, pitch: 0.1, kind: KIND_INDEX.eye, labels: ['eyeL', 'eyeR'] },
  web: { dist: 3.2, web: 0.09, anatomy: 0.25, labels: ['brain', 'cord'] },
  model: { dist: 3.0, kind: KIND_INDEX.in, labels: ['brain', 'cord'] },
  muscles: { dist: 3.0, yaw: 0.95, pitch: 0.05, kind: KIND_INDEX.mus, labels: ['muscles', 'cilia'] },
  log: { dist: 3.8 },
};

// The worm gets its own box: the space the interface leaves free. The camera distance and a
// screen offset are solved so the whole larva (at any rotation) fits inside it, so the worm never
// sits under the title, the readouts or the dock, on any screen.
const WORM = { h: 1.84, w: 1.42, cy: -0.155 };      // body extent in world units, with room to bend
const ui = { brand: null, hudr: null, dock: null, hero: null, box: null };
let heroFit = { dist: 4.4, ox: 0, oy: 0, ty: WORM.cy };
const rectOf = (e) => { const r = e.getBoundingClientRect(); return { left: r.left, top: r.top + scrollY, right: r.right, bottom: r.bottom + scrollY, width: r.width, height: r.height }; };
function fitBox(box) {
  const f = VH / (2 * Math.tan((cam.fov || 0.55) / 2));
  const dist = Math.max(WORM.h * f / Math.max(80, box.height), WORM.w * f / Math.max(80, box.width)) * 1.04;
  return { dist, ox: ((box.left + box.right) / 2 - VW / 2) / (VW / 2), oy: -((box.top + box.bottom) / 2 - VH / 2) / (VH / 2), ty: WORM.cy, size: WORM.h * f / dist, box };
}
const wideHero = matchMedia('(min-width: 1024px)');
function measureLayout() {
  const brand = $('brand'), stage = $('stage'), card = $('launchcard');
  const saved = brand.style.transform; brand.style.transform = 'none';
  ui.brand = rectOf(brand); brand.style.transform = saved;
  ui.hudr = rectOf(document.querySelector('.hudr'));
  ui.hero = rectOf(stage);
  // the launch card: under the title on the left of wide screens, along the bottom of narrow ones
  const wide = wideHero.matches && !STREAM;
  stage.style.setProperty('--cardtop', `${Math.round(ui.brand.bottom - ui.hero.top + 22)}px`);
  ui.card = STREAM ? null : rectOf(card);
  stage.style.setProperty('--cardh', `${Math.round(ui.card?.height || 0)}px`);
  stage.style.setProperty('--cardr', wide && ui.card ? `${Math.round(ui.card.right - ui.hero.left)}px` : '0px');
  ui.dock = STREAM ? null : rectOf($('dock'));
  const g = VW < 720 ? 16 : 24, nav = STREAM ? 0 : 46;
  const top = ui.hero.top + nav + 14;
  const bottom = Math.min(ui.dock ? ui.dock.top : ui.hero.bottom - (STREAM ? 150 : 0), !wide && ui.card ? ui.card.top : Infinity) - 14;
  const heroRight = ui.hero.right, leftEdge = wide && ui.card ? Math.max(ui.brand.right, ui.card.right) : ui.brand.right;
  // option A: the column between the title (and the launch card) and the readouts; option B: the band below both
  const A = { left: Math.max(ui.hero.left + g, leftEdge + 28), right: Math.min(heroRight - g, ui.hudr.left - 28), top, bottom };
  const B = { left: wide && ui.card ? ui.card.right + 28 : ui.hero.left + g, right: heroRight - g, top: Math.max(ui.brand.bottom, ui.hudr.bottom) + 16, bottom };
  for (const r of [A, B]) { r.width = r.right - r.left; r.height = r.bottom - r.top; }
  const fa = A.width > 160 && A.height > 160 ? fitBox(A) : null, fb = B.width > 160 && B.height > 120 ? fitBox(B) : null;
  const best = fa && (!fb || fa.size >= fb.size * 0.92) ? fa : fb || fitBox({ left: ui.hero.left, right: heroRight, top, bottom, width: heroRight - ui.hero.left, height: bottom - top });
  heroFit = best; ui.box = best.box;
  heroOx = best.ox; heroOy = best.oy;
  if (body.classList.contains('intro')) placeIntroTitle();
}
document.fonts?.ready.then(() => measureLayout());

function storyScene(sc) {
  if (sc.ox == null || sc.ox === 0 || VW < 900) return { ...sc, ox: 0, oy: 0 };
  const col = document.querySelector(`[data-scene="${scene}"] .col`);
  if (!col) return sc;
  const r = col.getBoundingClientRect();
  const box = { left: r.right + 40, right: VW - 24, top: 46 + 24, bottom: VH - 24 };
  box.width = box.right - box.left; box.height = box.bottom - box.top;
  if (box.width < 260) return { ...sc, ox: 0, oy: 0 };
  const f = fitBox(box);
  return { ...sc, ox: f.ox, oy: f.oy, dist: sc.dist ? Math.max(sc.dist, f.dist * 0.85) : f.dist };
}

function onStimulusStart(m) {
  if (scene !== 'hero') return;
  if (m.kind === 'tug') director = { until: Infinity, tug: true };
  else director = { until: performance.now() + 2600, headFirst: true };
}

function updateCamera(dt, now) {
  const intro = now < introUntil;
  const s = scene === 'hero' ? { ox: heroFit.ox, oy: heroFit.oy, dist: heroFit.dist, ty: heroFit.ty } : storyScene(SCENES[scene] || {});
  const st = scene === 'how' && step ? STEPS[step] : null;
  aim.ox = s.ox ?? heroOx; aim.oy = s.oy ?? 0;
  aim.dist = st?.dist ?? s.dist ?? heroFit.dist;
  aim.ty = st?.ty ?? s.ty ?? -0.16;
  lookAim.exposure = s.exposure ?? 1.15; lookAim.web = st?.web ?? s.web ?? 0.014;
  lookAim.kind = st?.kind ?? -1; lookAim.kindK = st?.kind != null ? 1 : 0;
  lookAim.anatomy = anatomyOn && morphInfo ? (st && st.anatomy != null ? st.anatomy : 1) : 0;
  const free = now > userUntil && !drag;
  if (director && now > director.until) director = null;
  if (director && scene === 'hero' && free) {
    if (director.tug) { aim.yaw = cam.yaw + wrap(0 - cam.yaw); aim.pitch = 0.06; aim.dist = heroFit.dist * 0.97; }
    else if (director.headFirst) { aim.ty = heroFit.ty + 0.2; aim.dist = heroFit.dist * 0.8; aim.pitch = 0.08; }
  } else if (st && st.yaw != null && free) { aim.yaw = cam.yaw + wrap(st.yaw - cam.yaw); aim.pitch = st.pitch ?? aim.pitch; }
  else if (free && !reduceMotion && !(director && director.tug)) aim.yaw += dt * 0.07;

  if (!drag) {
    // momentum after a drag, then back to the director
    cam.yaw += spin.yaw * dt; cam.pitch = Math.max(-1.2, Math.min(1.2, cam.pitch + spin.pitch * dt));
    const decay = Math.exp(-dt * 3.5); spin.yaw *= decay; spin.pitch *= decay;
    if (now > userUntil) { const k = 1 - Math.exp(-dt * (intro ? 1.25 : 1.6)); cam.yaw += wrap(aim.yaw - cam.yaw) * k; cam.pitch += (aim.pitch - cam.pitch) * k; }
    else aim.yaw = cam.yaw;
  }
  const k = 1 - Math.exp(-dt * (intro ? 1.1 : 2.2));
  if (now > userUntil || scene !== 'hero') cam.dist += (aim.dist - cam.dist) * k;
  cam.ty += (aim.ty - cam.ty) * k; cam.ox += (aim.ox - cam.ox) * k; cam.oy += (aim.oy - cam.oy) * k;
  const kl = 1 - Math.exp(-dt * 2.5);
  for (const key of Object.keys(look)) look[key] += (lookAim[key] - look[key]) * kl;
  if (shake > 0.001) { shake *= Math.exp(-dt * 5); } else shake = 0;
}

/* ---------- your hands on the worm ---------- */
const hero = $('stage');
const proj = new Float32Array(N * 3);   // screen x, y (css px), w
function projectAll(bend, st) {
  const vp = R.vp; if (!vp) return;
  for (const i of drawn) {
    const [x, y, z] = deform(D.n[i][5], bend, st);
    const p = project(vp, x, y, z);
    proj[i * 3] = p[0] * VW; proj[i * 3 + 1] = p[1] * VH; proj[i * 3 + 2] = p[2];
  }
}
function nearest(x, y, maxPx, pool = drawn) {
  let best = -1, bd = maxPx * maxPx;
  for (const i of pool) {
    const dx = proj[i * 3] - x, dy = proj[i * 3 + 1] - y, d = dx * dx + dy * dy;
    if (d < bd && proj[i * 3 + 2] > 0) { bd = d; best = i; }
  }
  return best;
}
const isUI = (t) => !!t.closest('.dock, .corner a, .tip, button, a, input');
let drag = null, pinch = null, hover = -1, focusCell = -1, pressTimer = null;
const pointers = new Map();

hero.addEventListener('pointerdown', (e) => {
  if (isUI(e.target) || body.classList.contains('intro')) return;
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (pointers.size === 2) {
    const [a, b] = [...pointers.values()];
    pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), dist: cam.dist, mx: (a.x + b.x) / 2 };
    drag = null; clearTimeout(pressTimer); return;
  }
  drag = { x: e.clientX, y: e.clientY, lx: e.clientX, ly: e.clientY, t: performance.now(), moved: false, id: e.pointerId, type: e.pointerType };
  spin = { yaw: 0, pitch: 0 };
  if (e.pointerType === 'mouse') hero.setPointerCapture(e.pointerId);
  if (e.pointerType !== 'mouse') {
    clearTimeout(pressTimer);
    pressTimer = setTimeout(() => { if (drag && !drag.moved) { inspect(e.clientX, e.clientY, true); drag.inspected = true; } }, 480);
  }
});
hero.addEventListener('pointermove', (e) => {
  if (pointers.has(e.pointerId)) pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (pinch && pointers.size === 2) {
    const [a, b] = [...pointers.values()];
    cam.dist = Math.max(1.2, Math.min(7, pinch.dist * pinch.d / Math.max(20, Math.hypot(a.x - b.x, a.y - b.y))));
    const mx = (a.x + b.x) / 2;   // two fingers sliding sideways turn it
    cam.yaw -= (mx - pinch.mx) * 0.0065; pinch.mx = mx; aim.yaw = cam.yaw;
    userUntil = performance.now() + 12000; return;
  }
  if (drag && drag.id === e.pointerId) {
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    if (!drag.moved && Math.hypot(dx, dy) > 6) { drag.moved = true; clearTimeout(pressTimer); if (drag.type === 'mouse') hero.classList.add('dragging'); clearInspect(); }
    // on a touch screen one finger always scrolls the page; turning the worm takes two fingers
    if (drag.moved && drag.type === 'mouse') {
      const now = performance.now(), dtm = Math.max(1, now - drag.t) / 1000;
      const ddx = e.clientX - drag.lx, ddy = e.clientY - drag.ly;
      cam.yaw -= ddx * 0.0065;
      if (drag.type === 'mouse') cam.pitch = Math.max(-1.2, Math.min(1.2, cam.pitch + ddy * 0.005));
      spin = { yaw: -ddx * 0.0065 / dtm * 0.6, pitch: drag.type === 'mouse' ? ddy * 0.005 / dtm * 0.6 : 0 };
      drag.lx = e.clientX; drag.ly = e.clientY; drag.t = now;
      userUntil = now + 10000; aim.yaw = cam.yaw;
    }
    return;
  }
  if (e.pointerType === 'mouse' && !isUI(e.target)) hoverAt(e.clientX, e.clientY);
});
function endPointer(e) {
  pointers.delete(e.pointerId);
  if (pinch && pointers.size < 2) { pinch = null; return; }
  clearTimeout(pressTimer);
  if (drag && drag.id === e.pointerId) {
    if (!drag.moved && !drag.inspected && e.type === 'pointerup') pokeAt(e.clientX, e.clientY);
    if (performance.now() - drag.t > 80) spin = { yaw: 0, pitch: 0 };
    hero.classList.remove('dragging');
    drag = null;
  }
}
hero.addEventListener('pointerup', endPointer);
hero.addEventListener('pointercancel', endPointer);
hero.addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse') clearInspect(); });
addEventListener('wheel', (e) => {
  if (!(e.ctrlKey || e.metaKey) || !hero.contains(e.target) || isUI(e.target)) return;
  e.preventDefault();
  cam.dist = Math.max(1.2, Math.min(7, cam.dist * Math.exp(e.deltaY * 0.004)));
  userUntil = performance.now() + 12000;
}, { passive: false });
hero.addEventListener('dblclick', (e) => { if (!isUI(e.target)) resetView(); });

function pokeAt(sx, sy) {
  const near = nearest(sx, sy, Math.max(26, Math.min(VW, VH) * 0.05));
  if (near < 0) { ripples.push({ x: sx, y: sy, t: performance.now(), hit: false }); return; }
  const cells = roles.touch.map((i) => [Math.hypot(proj[i * 3] - sx, proj[i * 3 + 1] - sy), i]).sort((a, b) => a[0] - b[0]).slice(0, 6).map((c) => c[1]);
  ripples.push({ x: sx, y: sy, t: performance.now(), hit: true, mine: true });
  sendPoke(cells);
  dismissHint();
}

let hoverRaf = 0, hoverXY = null;
function hoverAt(x, y) {
  hoverXY = [x, y];
  if (hoverRaf) return;
  hoverRaf = requestAnimationFrame(() => { hoverRaf = 0; if (hoverXY) inspect(hoverXY[0], hoverXY[1], false); });
}
function inspect(x, y, sticky) {
  const i = nearest(x, y, sticky ? 30 : 14);
  if (i < 0) { if (!sticky) clearInspect(); return; }
  hover = i; focusCell = i;
  hero.classList.add('hovercell');
  const n = D.n[i], tip = $('tip');
  tip.replaceChildren();
  tip.append(el('b', null, n[0]));
  const side = n[2] === 0 ? 'left' : n[2] === 1 ? 'right' : 'midline';
  tip.append(el('span', 't', `${KLABEL[KIND[i]]} · ${SEGNAME[D.segs[n[3]]] || 'body'}, ${side}${n[7] ? ' · placed in its segment' : ''}`));
  const io = el('span', 'io');
  io.append(el('span', 'in', `in ← ${inDeg[i]} cells`), el('span', 'out', `out → ${outDeg[i]} cells`));
  tip.append(io);
  tip.hidden = false;
  const tx = Math.min(x, innerWidth - 320), ty = Math.max(70, Math.min(y, innerHeight - 90));
  tip.style.left = tx + 'px'; tip.style.top = ty + 'px';
  if (sticky) { clearTimeout(tip._t); tip._t = setTimeout(clearInspect, 3500); }
}
function clearInspect() { hover = -1; focusCell = -1; $('tip').hidden = true; hero.classList.remove('hovercell'); }

function resetView() {
  userUntil = 0; spin = { yaw: 0, pitch: 0 };
  aim.yaw = cam.yaw + wrap(0.35 - cam.yaw); aim.pitch = 0.12;
}
$('viewbtn').addEventListener('click', resetView);

/* ---------- anatomy labels ---------- */
const withPos = (ids) => ids.filter((i) => D.n[i][5]);
const centroidOf = (ids) => { const s = [0, 0, 0]; for (const i of ids) { const p = D.n[i][5]; s[0] += p[0]; s[1] += p[1]; s[2] += p[2]; } return s.map((v) => v / Math.max(1, ids.length)); };
const pick = (f) => withPos(D.n.map((_, i) => i).filter((i) => f(D.n[i], i)));
const ANCHORS = [
  { id: 'eyeL', text: 'Left eyes', p: centroidOf(withPos(roles.eyeL)) },
  { id: 'eyeR', text: 'Right eyes', p: centroidOf(withPos(roles.eyeR)) },
  { id: 'brain', text: 'Brain', p: centroidOf(pick((x) => x[1] === 1 && D.segs[x[3]] === 'episphere')) },
  { id: 'cord', text: 'Nerve cord', p: centroidOf(pick((x) => x[1] === 1 && /^segment/.test(D.segs[x[3]]))) },
  { id: 'cilia', text: 'Ciliary bands', p: centroidOf(withPos([...roles.cilL, ...roles.cilR])) },
  { id: 'muscles', text: 'Body-wall muscles', p: centroidOf(pick((x) => /^MUSlong/.test(x[0]))) },
  { id: 'tail', text: 'Tail', p: centroidOf(pick((x) => D.segs[x[3]] === 'pygidium')) },
].map((a) => ({ ...a, alpha: 0 }));
let labelsOn = store.get('labels', false);
function setLabels(on) { labelsOn = on; store.set('labels', on); $('labelbtn').setAttribute('aria-pressed', String(on)); }
setLabels(labelsOn);
$('labelbtn').addEventListener('click', () => setLabels(!labelsOn));

/* ---------- the larva's anatomy (cell shapes, yolk, body envelope) ---------- */
let anatomyOn = store.get('anatomy', true), morphInfo = null;
function setAnatomy(on) { anatomyOn = on; store.set('anatomy', on); $('anatbtn').setAttribute('aria-pressed', String(on)); if (on) loadAnatomy(); }
$('anatbtn').addEventListener('click', () => setAnatomy(!anatomyOn));
let anatomyLoading = false;
function loadAnatomy() {
  if (anatomyLoading || !R.setMorph) return;
  anatomyLoading = true;
  loadMorph().then((m) => {
    R.setMorph(m);
    morphInfo = { umPerUnit: m.umPerUnit, counts: m.counts };
    if (m.yolk) {
      const p = m.yolk.positions, c = [0, 0, 0];
      for (let i = 0; i < p.length; i += 3) { c[0] += p[i]; c[1] += p[i + 1]; c[2] += p[i + 2]; }
      ANCHORS.push({ id: 'yolk', text: 'Yolk', p: c.map((v) => v / (p.length / 3)), alpha: 0 });
    }
  }).catch((e) => { console.warn('anatomy not loaded', e); anatomyLoading = false; });
}
$('anatbtn').setAttribute('aria-pressed', String(anatomyOn));
if (!R.setMorph) $('anatbtn').hidden = true;

/* ---------- overlay: labels and ripples ---------- */
const blocked = (r) => {
  // interface rectangles in screen coordinates (only in the first screen)
  if (scene !== 'hero') return false;
  const y0 = scrollY;
  for (const u of [ui.brand, ui.hudr, ui.dock]) {
    if (!u) continue;
    if (r.x < u.right + 6 && r.x + r.w > u.left - 6 && r.y < u.bottom - y0 + 6 && r.y + r.h > u.top - y0 - 6) return true;
  }
  return false;
};
let hud = 0;   // fades the instrument marks in after the intro
function drawOverlay(now, dt, bend, st) {
  og.clearRect(0, 0, VW, VH);
  const vp = R.vp; if (!vp) return;
  hud += ((scene === 'hero' && !body.classList.contains('intro') && !STREAM ? 1 : 0) - hud) * (1 - Math.exp(-dt * 4));
  og.font = '500 10px "Geist Mono", ui-monospace, monospace';
  if (hud > 0.02 && ui.box) {
    // viewfinder brackets around the worm's box, with the camera readout
    const b = ui.box, y0 = scrollY, L = 14;
    const x1 = b.left, x2 = b.right, y1 = b.top - y0, y2 = b.bottom - y0;
    og.globalAlpha = hud * 0.5; og.strokeStyle = '#8298A6'; og.lineWidth = 1;
    og.beginPath();
    og.moveTo(x1, y1 + L); og.lineTo(x1, y1); og.lineTo(x1 + L, y1);
    og.moveTo(x2 - L, y1); og.lineTo(x2, y1); og.lineTo(x2, y1 + L);
    og.moveTo(x1, y2 - L); og.lineTo(x1, y2); og.lineTo(x1 + L, y2);
    og.moveTo(x2 - L, y2); og.lineTo(x2, y2); og.lineTo(x2, y2 - L);
    og.stroke();
    // a true scale bar, from the lab's nanometre coordinates
    if (morphInfo) {
      const pxPerUnit = VH / (2 * Math.tan((cam.fov || 0.55) / 2)) / cam.dist, um = 50;
      const label = `${um} µm`, len = um / morphInfo.umPerUnit * pxPerUnit;
      const sx = x2 - 10 - og.measureText(label).width - 6 - len, sy = y2 - 12;   // bottom right: the hint is centred
      og.globalAlpha = hud * 0.7; og.strokeStyle = '#DCE7EC'; og.lineWidth = 1;
      og.beginPath(); og.moveTo(sx, sy - 3); og.lineTo(sx, sy); og.lineTo(sx + len, sy); og.lineTo(sx + len, sy - 3); og.stroke();
      og.fillStyle = '#8298A6'; og.fillText(label, sx + len + 6, sy + 3);
    }
    // orientation gizmo: head (anterior), left and dorsal, as the camera sees them
    const gx = x1 + 30, gy = y2 - 30, o = project(vp, 0, -0.16, 0);
    const axes = [['HEAD', 0, 1, 0, '#FFB84D'], ['LEFT', -1, 0, 0, '#56E6D2'], ['DORSAL', 0, 0, 1, '#C49BFF']];
    for (const [name, ax, ay, az] of axes) {
      const p = project(vp, ax * 0.25, -0.16 + ay * 0.25, az * 0.25);
      let dx = (p[0] - o[0]) * VW, dy = (p[1] - o[1]) * VH; const len = Math.hypot(dx, dy) || 1;
      dx = dx / len * 20; dy = dy / len * 20;
      og.globalAlpha = hud * 0.75; og.strokeStyle = axes.find((a) => a[0] === name)[4];
      og.beginPath(); og.moveTo(gx, gy); og.lineTo(gx + dx, gy + dy); og.stroke();
      og.globalAlpha = hud * 0.5; og.fillStyle = og.strokeStyle;
      og.fillText(name[0], gx + dx * 1.35 - 3, gy + dy * 1.35 + 3);
    }
  }
  // anatomy labels: placed only where they touch neither the interface nor each other
  const want = new Set(scene === 'how' && step ? (STEPS[step].labels || []) : scene === 'hero' && labelsOn && !body.classList.contains('intro') ? ANCHORS.map((a) => a.id) : []);
  const c = project(vp, 0, -0.16, 0), cxs = c[0] * VW;
  og.font = '500 10.5px "Geist Mono", ui-monospace, monospace';
  const placed = [];
  const items = ANCHORS.map((a) => {
    a.alpha += ((want.has(a.id) ? 1 : 0) - a.alpha) * (1 - Math.exp(-dt * 6));
    if (a.alpha < 0.02) return null;
    const [x, y, z] = deform(a.p, bend, st), p = project(vp, x, y, z);
    return p[2] > 0 ? { a, sx: p[0] * VW, sy: p[1] * VH } : null;
  }).filter(Boolean).sort((u, v) => u.sy - v.sy);
  for (const it of items) {
    const t = it.a.text.toUpperCase(), w = og.measureText(t).width + 12;
    let spot = null;
    for (const dir of it.sx < cxs ? [-1, 1] : [1, -1]) {
      for (const dy of [-22, -40, -4, -58, 14]) {
        const lx = it.sx + dir * 58, ly = it.sy + dy;
        const r = { x: dir < 0 ? lx - w : lx, y: ly - 9, w, h: 17 };
        if (r.x < 4 || r.x + r.w > VW - 4 || r.y < 50 || r.y + r.h > VH - 4) continue;
        if (blocked(r) || placed.some((q) => r.x < q.x + q.w + 4 && r.x + r.w > q.x - 4 && r.y < q.y + q.h + 3 && r.y + r.h > q.y - 3)) continue;
        spot = { r, lx, ly, dir }; break;
      }
      if (spot) break;
    }
    if (!spot) continue;
    placed.push(spot.r);
    og.globalAlpha = it.a.alpha;
    og.strokeStyle = 'rgba(220,231,236,.55)'; og.lineWidth = 1;
    og.beginPath(); og.arc(it.sx, it.sy, 4.5, 0, 6.2832); og.stroke();
    og.beginPath(); og.moveTo(it.sx + spot.dir * 4.5, it.sy); og.lineTo(spot.lx - spot.dir * 6, spot.ly); og.lineTo(spot.lx, spot.ly); og.stroke();
    og.fillStyle = 'rgba(4,7,11,.72)'; og.fillRect(spot.r.x, spot.r.y, spot.r.w, spot.r.h);
    og.fillStyle = '#DCE7EC'; og.fillText(t, spot.r.x + 6, spot.ly + 3.5);
  }
  og.globalAlpha = 1;
  for (let q = ripples.length - 1; q >= 0; q--) {
    const rp = ripples[q], t = (now - rp.t) / 900;
    if (t > 1) { ripples.splice(q, 1); continue; }
    let x = rp.x, y = rp.y;
    if (rp.cells) { x = 0; y = 0; for (const i of rp.cells) { x += proj[i * 3]; y += proj[i * 3 + 1]; } x /= rp.cells.length; y /= rp.cells.length; }
    const e = 1 - (1 - t) ** 3;
    og.strokeStyle = rp.hit ? `rgba(255,107,94,${(1 - t) * 0.9})` : `rgba(130,152,166,${(1 - t) * 0.6})`;
    og.lineWidth = rp.mine ? 2 : 1.4;
    og.beginPath(); og.arc(x, y, 6 + e * 52, 0, 6.2832); og.stroke();
    if (rp.hit) { og.beginPath(); og.arc(x, y, 3 + e * 22, 0, 6.2832); og.stroke(); }
    if (rp.by && t < 0.85) {
      // who poked, on everyone's screen
      const who = rp.by.startsWith('chain:') ? rp.by.slice(6).toUpperCase() : rp.by.startsWith('spawn:') ? rp.by.slice(6) : rp.by.startsWith('twitch:') ? rp.by.slice(7) : rp.by;
      og.globalAlpha = Math.min(1, (0.85 - t) * 3);
      og.font = '500 10px "Geist Mono", ui-monospace, monospace';
      og.fillStyle = 'rgba(4,7,11,.7)'; const w = og.measureText(who).width;
      og.fillRect(x + 14, y - 26 - e * 10, w + 10, 15);
      og.fillStyle = '#FF9E7A'; og.fillText(who, x + 19, y - 15 - e * 10);
      og.globalAlpha = 1;
    }
  }
}

/* ---------- panels ---------- */
const prcEls = new Map();
for (const [ids, row] of [[roles.eyeL, $('prcL')], [roles.eyeR, $('prcR')]]) {
  for (const i of ids) { const d = el('i', 'prc'); d.title = D.n[i][0]; row.append(d); prcEls.set(i, d); }
}
const eyeview = $('eyeview'), eg = eyeview.getContext('2d');
const spark = $('spark'), sg = spark.getContext('2d');
const hist = new Float32Array(240); let hp = 0, lastHist = 0;
let lastHud = { cells: -1, step: -1 };
const tugAcc = { id: null, acc: [0, 0, 0, 0, 0], n: [0, 0, 0, 0, 0] };

function setLR(bar, txt, v, scale) {
  const x = Math.max(-1, Math.min(1, v / scale)), wv = Math.abs(x) * 50;
  bar.style.width = wv + '%'; bar.style.left = x > 0 ? (50 - wv) + '%' : '50%';
  txt.textContent = Math.abs(v) < scale * 0.08 ? 'even' : (x > 0 ? 'left ' : 'right ') + '+' + Math.round(Math.abs(x) * 100) + '%';
}

function paintPanels(now, ro, stepNow) {
  const cells = ro.nAct;
  if (cells !== lastHud.cells) {
    $('hudcells').textContent = fmt(cells); $('ncells').textContent = fmt(cells);
    $('hudcells').classList.toggle('hot', cells > 400);
    lastHud.cells = cells;
  }
  const s = Math.floor(stepNow);
  if (s !== lastHud.step) { $('hudstep').textContent = fmt(s); lastHud.step = s; }
  setLR($('bendbar'), $('bendtxt'), ro.bend, 0.06);
  setLR($('cilbar'), $('ciltxt'), ro.cil, 0.06);
  const st = Math.min(1, ro.st / 0.9); $('stbar').style.width = (st * 100) + '%'; $('sttxt').textContent = Math.round(st * 100) + '%';
  for (const [i, e] of prcEls) {
    const v = Math.min(1, act8[i] / 255 * 1.4);
    e.style.background = `rgba(255,184,77,${(0.08 + v * 0.92).toFixed(2)})`;
    e.style.boxShadow = v > 0.3 ? `0 0 ${Math.round(v * 10)}px rgba(255,184,77,.8)` : 'none';
  }
  if (now - lastHist > 66) { hist[hp] = cells; hp = (hp + 1) % hist.length; lastHist = now; drawSpark(); }

  // what the eyes see
  const isLamp = !!(nowMsg && nowMsg.kind === 'lamp');
  const ew = nowMsg && !isLamp ? eyeWindows(nowMsg, stepNow) : { windows: [] };
  if (isLamp && stepNow - nowMsg.startStep >= LAMP.steps + 2) nowMsg = null;
  else if (nowMsg && !isLamp && ((nowMsg.kind === 'tug' && ew.done) || (nowMsg.kind !== 'tug' && stepNow - nowMsg.startStep >= durationSteps(nowMsg.bmp || (nowMsg.bmp = renderText(nowMsg.text))) + 2))) {
    if (nowMsg.kind === 'tug') setTimeout(() => { if (!nowMsg || nowMsg.kind !== 'tug') $('tugbar').hidden = true; }, 7000);
    nowMsg = null;
  }
  const lampNow = nowMsg && nowMsg.kind === 'lamp' && nowMsg.pos ? lampLight(pose, nowMsg.pos) : null;
  if (lampNow) paintLEDLevels(eg, eyeview.width, eyeview.height, VIEW, Math.min(1, 1.6 * lampNow.L), Math.min(1, 1.6 * lampNow.R));
  else paintLED(eg, eyeview.width, eyeview.height, VIEW, nowMsg ? ew.windows : []);
  const dh = $('nowtext').parentElement, playing = !!nowMsg;
  const whoNow = nowMsg && (nowMsg.by === you || nowMsg.by === 'you' ? 'you' : String(nowMsg.by).replace(/^chain:/, 'a trade · ').replace(/^spawn:/, 'SPAWN · '));
  const nowText = nowMsg
    ? (nowMsg.kind === 'tug' ? `Tug · ${nowMsg.a} vs ${nowMsg.b} · from ${whoNow}`
      : nowMsg.kind === 'lamp' ? `Lamp · lit by ${whoNow}${lampNow ? ` · ${((lampNow.d * UM_PER_UNIT) / 1000).toFixed(2)} mm away` : ''}`
        : `Eyes · “${nowMsg.text}” from ${whoNow}`)
    : 'Eyes · dark';
  if ($('nowtext').textContent !== nowText) $('nowtext').textContent = nowText;
  const qt = queue.length ? `${queue.length} waiting` : '';
  if ($('queuetext').textContent !== qt) $('queuetext').textContent = qt;
  dh.classList.toggle('on', playing);

  // a tug in progress
  if (nowMsg && nowMsg.kind === 'tug') {
    const tb = $('tugbar');
    if (tugAcc.id !== nowMsg.id) { tugAcc.id = nowMsg.id; tugAcc.acc.fill(0); tugAcc.n.fill(0); $('tugA').classList.remove('win'); $('tugB').classList.remove('win'); }
    tb.hidden = false;
    $('tugA').textContent = nowMsg.a; $('tugB').textContent = nowMsg.b;
    if (ew.pass != null && ew.pass < TUG_ORDER.length) {
      tugAcc.acc[ew.pass] += ro.bend; tugAcc.n[ew.pass]++;
      $('tugpass').textContent = ew.pass === 0 ? 'warm-up' : `pass ${ew.pass} of 4`;
      const aSide = ew.aLeft ? 'left' : 'right';
      $('tugnote').textContent = `${nowMsg.a} → ${aSide} eyes · ${nowMsg.b} → ${aSide === 'left' ? 'right' : 'left'} eyes`;
      let sc = 0, k = 0;
      for (let p = 0; p < TUG_ORDER.length; p++) if (TUG_SCORED[p] && tugAcc.n[p]) { sc += TUG_ORDER[p] * tugAcc.acc[p] / tugAcc.n[p]; k++; }
      if (k) knot(sc / k);
    }
  }
}
/** A tug score (rad/s the body turned) in degrees per second. */
const degS = (v) => `${((v * 180) / Math.PI).toFixed(2)}°/s`;
function knot(score) {
  const x = Math.max(-1, Math.min(1, score / 0.004));   // rad/s the body turned (tugs score ~0.0005 to 0.004)
  $('tugknot').style.left = (50 - x * 46) + '%';
}
function drawSpark() {
  const w = spark.width, h = spark.height; sg.clearRect(0, 0, w, h);
  let top = 200; for (const v of hist) if (v > top) top = v;
  const path = () => { sg.beginPath(); for (let k = 0; k < hist.length; k++) { const v = hist[(hp + k) % hist.length]; const x = k / (hist.length - 1) * w, y = h - 3 - (v / top) * (h - 10); k ? sg.lineTo(x, y) : sg.moveTo(x, y); } };
  path(); sg.lineTo(w, h); sg.lineTo(0, h); sg.closePath();
  const gr = sg.createLinearGradient(0, 0, 0, h); gr.addColorStop(0, 'rgba(86,230,210,.28)'); gr.addColorStop(1, 'rgba(86,230,210,0)');
  sg.fillStyle = gr; sg.fill();
  path(); sg.strokeStyle = '#56E6D2'; sg.lineWidth = 2.5; sg.stroke();
}

/* ---------- moments: startles, records, tug results ---------- */
let bannerTimer = null;
function banner(kind, k, t, s, ms = 4200) {
  const b = $('banner');
  b.className = 'banner ' + (kind || '');
  $('bannerk').textContent = k; $('bannert').textContent = t; $('banners').textContent = s || '';
  b.hidden = false;
  clearTimeout(bannerTimer);
  bannerTimer = setTimeout(() => { b.classList.add('out'); setTimeout(() => { b.hidden = true; b.classList.remove('out'); }, 230); }, ms);
}
function flash() { if (reduceMotion) return; const f = $('flash'); f.classList.remove('go'); void f.offsetWidth; f.classList.add('go'); }
let lastStartle = 0, wasStartled = false;
function checkStartle(ro, now, stepNow) {
  // its startle reflex: a touch makes the cilia stop (outside its own stop-and-go rhythm)
  const stop = WormCore.rhythmNear(Math.floor(stepNow)) ? 0 : meanArrestAll(CILIA, act8, 255);
  const on = stop > 0.05;
  if (on && !wasStartled && now - lastStartle > 5000) {
    lastStartle = now; flash(); shake = reduceMotion ? 0 : 0.6;
    if (!(nowMsg && nowMsg.kind === 'tug')) banner('coral', 'Startle reflex', 'It stopped swimming', `${Math.round(stop * 100)}% of its cilia stopped`, 3200);
  }
  wasStartled = on;
}
function onRecord(m) {
  const e = m.entry;
  banner('', m.scope === 'all' ? 'New all-time record' : 'New record today', `“${e.text}”`, `${fmt(e.peak)} cells firing at once · ${e.by === you ? 'you' : e.by}`, 5200);
  flash(); sound.chime();
}
function onTugResult(m) {
  const r = m.result;
  const winWord = r.winner === 'a' ? m.a : r.winner === 'b' ? m.b : null;
  $('tugA').classList.toggle('win', r.winner === 'a'); $('tugB').classList.toggle('win', r.winner === 'b');
  $('tugpass').textContent = 'result'; knot(r.score);
  $('tugnote').textContent = `turned ${degS(Math.abs(r.score))} toward ${r.score >= 0 ? m.a : m.b} · not a choice`;
  banner('cyan', 'Tug result', winWord ? `The body turned toward ${winWord}` : 'Too close to call', 'Four passes, sides swapped', 6000);
  director = null;
  setTimeout(() => { if (!nowMsg || nowMsg.kind !== 'tug') $('tugbar').hidden = true; }, 7000);
}

/* ---------- feed ---------- */
const seen = new Set();
function dirWord(v) { return v > 0.012 ? 'left' : v < -0.012 ? 'right' : 'even'; }
function swimWords(s) {
  if (s.swim == null) return '';
  let t = ` · swam ${s.swim >= 1000 ? (s.swim / 1000).toFixed(1) + ' mm' : fmt(s.swim) + ' µm'}`;
  if (s.turn) t += ` · turned ${Math.abs(s.turn)}° ${s.turn > 0 ? 'left' : 'right'}`;
  if (s.stop) t += ` · cilia stopped ${s.stop} s`;
  return t;
}
function pokeWhere(cells) {
  if (!cells || !cells.length) return 'body';
  const segs = {}; let left = 0;
  for (const i of cells) { const sg2 = D.segs[D.n[i][3]]; segs[sg2] = (segs[sg2] || 0) + 1; if (D.n[i][2] === 0) left++; }
  const seg = Object.entries(segs).sort((a, b) => b[1] - a[1])[0][0];
  return `${left >= cells.length / 2 ? 'left' : 'right'} ${SEGNAME[seg] || 'body'}`;
}
function resultNode(it) {
  const res = el('span', 'res');
  if (it.kind === 'tug') {
    const r = it.result || (it.summary && it.summary.tug);
    if (!r) { res.textContent = it.step == null ? (it.ahead ? `→ waiting (${it.ahead} ahead)` : '→ up next') : '→ tugging…'; return res; }
    res.append('→ ');
    if (r.winner === 'tie') res.append('too close to call');
    else { res.append('body turned toward '); res.append(el('span', 'win', r.winner === 'a' ? it.a : it.b)); }
    res.append(` (${degS(Math.abs(r.score))})`);
    return res;
  }
  const s = it.summary;
  if (!s) { res.textContent = (it.kind === 'say' || it.kind === 'lamp') && it.step == null ? (it.ahead ? `→ waiting (${it.ahead} ahead)` : '→ up next') : it.kind === 'lamp' ? '→ lit…' : '→ reacting…'; return res; }
  if (it.kind === 'lamp' && s.lamp) {
    const mm = (u) => (u / 1000).toFixed(2);
    res.textContent = `→ ${mm(s.lamp.from)} → ${mm(s.lamp.to)} mm away (closest ${mm(s.lamp.closest)})` + swimWords(s);
    return res;
  }
  if (s.peak < 3) { res.textContent = '→ barely registered'; return res; }
  res.textContent = `→ ${fmt(s.peak)} cells fired · muscles ${dirWord(s.bend)} · cilia ${dirWord(s.cil)}` + (s.st > 0.3 ? ' · full startle' : '') + (s.flood > 0 ? ' · flooded its light sensors' : '') + swimWords(s) + (s.pokes ? ` · poked ${s.pokes}× during it, not ranked` : '');
  return res;
}
let feedQueued = false;
function renderFeed(reset = false) {
  if (reset) seen.clear();
  if (feedQueued) return; feedQueued = true;
  requestAnimationFrame(() => {
    feedQueued = false;
    const ul = $('feed'), items = [...feed.values()].reverse().slice(0, 40);
    ul.replaceChildren();
    if (!items.length) ul.append(el('li', 'empty', mode === 'offline' ? 'Offline. Messages and pokes only reach your copy.' : 'Nothing yet.'));
    for (const it of items) {
      const li = el('li', it.kind + (seen.has(it.id) ? '' : ' new'));
      seen.add(it.id);
      const mine = it.by === you || it.by === 'you';
      const tw = typeof it.by === 'string' && it.by.startsWith('twitch:');
      const chain = typeof it.by === 'string' && it.by.startsWith('chain:');
      const sp = typeof it.by === 'string' && it.by.startsWith('spawn:');
      const who = el('span', 'who' + (mine ? ' you' : ''));
      if (tw) who.append(el('span', 'tw', 'TWITCH'));
      if (sp) {
        who.append(el('span', 'tw buy', 'SPAWN'), it.by.slice(6) + ' ');
        if (it.chain) { const a = el('a', 'txl', `${it.chain.sol} SOL`); a.href = (site.txUrl || 'https://solscan.io/tx/') + it.chain.sig; a.target = '_blank'; a.rel = 'noopener'; who.append(a, ' '); }
      } else if (chain) {
        const side = it.by.slice(6);
        who.append(el('span', 'tw ' + (side === 'sell' ? 'sell' : 'buy'), side.toUpperCase()));
        if (it.chain) { const a = el('a', 'txl', `${it.chain.sol} SOL`); a.href = (site.txUrl || 'https://solscan.io/tx/') + it.chain.sig; a.target = '_blank'; a.rel = 'noopener'; who.append(a, ' '); }
      } else who.append((mine ? 'you' : tw ? it.by.slice(7) : it.by) + ' ');
      const what = el('b', null, it.kind === 'say' ? (chain ? 'flashed light across its eyes' : `“${it.text}”`) : it.kind === 'tug' ? `“${it.a}” vs “${it.b}”` : it.kind === 'lamp' ? 'lit the lamp' : `poked the ${pokeWhere(it.cells)}`);
      li.append(who, what, resultNode(it));
      ul.append(li);
    }
    $('feedcount').textContent = feed.size ? `${feed.size} recent` : '';
    if (STREAM) renderStreamFeed(items.slice(0, 5));
  });
}

/* ---------- SPAWN, the launchpad: the launch card, every coin, and the three busiest coins' own worms ---------- */
const launchForm = mountLaunchForm($('launchform'), { onLaunched: () => setTimeout(loadSpawn, 4000) });
let spawnData = null, homeSort = 'new';
async function loadSpawn() {
  const j = await fetch('/spawn.json').then((r) => (r.ok ? r.json() : null)).catch(() => null);
  if (!j) return;
  spawnData = j;
  launchForm.update(j);
  for (const id of ['spawnpill', 'spawnopen']) { const p = $(id); p.textContent = j.open ? (j.quote === 'SOL' ? 'Open · priced in SOL' : 'Open') : 'Opening soon'; p.classList.toggle('live', !!j.open); }
  const r = j.root || {}, inSol = !r.mint || j.quote === 'SOL';
  $('lccoins').textContent = compact(j.coins?.length || 0);
  $('lcwaitk').textContent = inSol ? 'Buyback SOL' : 'Burned';
  $('lcwait').textContent = inSol ? compact(r.waitingSol || 0) : compact(r.burned || 0);
  $('lcpokes').textContent = compact(j.pokesToday || 0);
  renderHomeCoins(j);
  showSpawnCoins(j);
}
const HOME_SORTS = { new: (a, b) => b.createdAt - a.createdAt, hot: (a, b) => (b.worm?.cells || 0) - (a.worm?.cells || 0) || b.createdAt - a.createdAt, grad: (a, b) => (b.progress || 0) - (a.progress || 0), mcap: (a, b) => (b.mcapSol || 0) - (a.mcapSol || 0) };
for (const b of $('homesorts').querySelectorAll('button')) b.addEventListener('click', () => {
  homeSort = b.dataset.sort;
  for (const x of $('homesorts').querySelectorAll('button')) x.setAttribute('aria-selected', String(x === b));
  if (spawnData) renderHomeCoins(spawnData);
});
function renderHomeCoins(j) {
  const all = [...(j.coins || [])].sort(HOME_SORTS[homeSort]), coins = all.slice(0, 12);
  $('homecoins').replaceChildren(...(coins.length ? coins.map((c) => coinCard(c)) : [el('p', 'empty', j.open ? 'No coins yet. Launch the first one: it takes a minute.' : 'Opening soon. The first coins will show up here.')]));
  $('homeall').textContent = all.length > coins.length ? `All ${all.length} coins →` : 'All coins →';
  const f = j.fee, r = j.root || {};
  if (!f) return;
  const burned = r.burned ? `${compact(r.burned)} $BRAINWORM burned so far. ` : '', waiting = r.waitingSol ? `${compact(r.waitingSol)} SOL of fees waiting to buy $BRAINWORM${r.mint ? '' : ' when it launches'}.` : '';
  $('homefee').textContent = burned + waiting;
}
setInterval(() => { if (!document.hidden) loadSpawn(); }, 30_000);
loadSpawn();
new ResizeObserver(() => measureLayout()).observe($('launchcard'));
function showSpawnCoins(j) {
  const coins = (j?.coins || []).filter((c) => c.own).sort((a, b) => (b.own.cells - a.own.cells) || (b.createdAt - a.createdAt)).slice(0, 3);
  if (!coins.length) { $('spawnnote').textContent = j?.open ? 'Open · no coins yet' : 'Opening soon'; return; }
  const box = $('spawncoins'); box.replaceChildren();
  for (const c of coins) {
    const a = el('a', 'spawncoin'); a.href = '/spawn#coins';
    const img = el('img'); img.alt = `$${c.symbol}'s own worm`; img.width = 112; img.height = 112; img.loading = 'lazy'; img.src = `/spawn/worm/${c.mint}.png?t=${c.own.trades}`;
    a.append(img, el('span', null, '$' + c.symbol));
    box.append(a);
  }
  $('spawnnote').textContent = 'Their own worms, after their latest trades';
}

/* ---------- leaderboard ---------- */
function setBoard(b) {
  board = b;
  $('boardday').textContent = b.day || '';
  const fill = (ol, list, emptyText) => {
    ol.replaceChildren();
    if (!list || !list.length) { ol.append(el('li', 'empty', emptyText)); return; }
    for (const e of list) {
      const li = el('li'), txt = el('span', 'txt', e.text);
      txt.append(el('small', null, `${e.by === you ? 'you' : e.by} · ${utc(e.ts)}`));
      const pk = el('span', 'pk', fmt(e.peak)); pk.append(el('small', null, 'cells'));
      li.append(txt, pk); ol.append(li);
    }
  };
  fill($('boardtoday'), b.today, 'Nothing yet today. Be first.');
  fill($('boardall'), b.all, 'Nothing yet.');
  const tl = $('tuglist'); tl.replaceChildren();
  if (!b.tugs || !b.tugs.length) tl.append(el('li', 'empty', 'No tugs yet.'));
  for (const t of b.tugs || []) {
    const li = el('li'), line = el('div', 'vsline');
    const A = el('b', t.result.winner === 'a' ? 'win' : '', t.a), B = el('b', t.result.winner === 'b' ? 'win' : '', t.b);
    line.append(A, el('i', null, 'vs'), B);
    li.append(line, `${t.result.winner === 'tie' ? 'too close to call' : 'turned toward ' + (t.result.winner === 'a' ? t.a : t.b)} · ${degS(Math.abs(t.result.score))} · ${utc(t.ts)}`);
    tl.append(li);
  }
  if (STREAM) renderStreamBoard();
}

/* ---------- proof ---------- */
let proofHead = null;
function setProofHead(p) {
  if (!p) return;
  proofHead = p;
  const h = p.head, pill = $('proofpill'), hud = $('proofhud');
  if (!h) { hud.textContent = 'first seal this hour'; pill.textContent = 'Hourly'; pill.className = 'pill pending'; return; }
  const btc = h.ots && h.ots.state === 'bitcoin';
  hud.textContent = `${fmt(p.chain)}h sealed · ${btc ? 'BTC #' + fmt(h.ots.height) : 'stamp pending'}`;
  pill.textContent = btc ? 'Anchored' : 'Sealing'; pill.className = 'pill ' + (btc ? 'anchored' : 'pending');
}
let proofLoading = false;
async function loadProof() {
  if (proofLoading) return; proofLoading = true;
  try {
    const r = await fetch('/proof.json'); if (!r.ok) return;
    const p = await r.json();
    const tb = $('proofchain').tBodies[0]; tb.replaceChildren();
    if (!p.chain.length) { const tr = el('tr'); const td = el('td', 'empty', 'The first hour seals an hour after start.'); td.colSpan = 6; tr.append(td); tb.append(tr); }
    for (const e of p.chain) {
      const tr = el('tr');
      const a = (href, text) => { const x = el('a', null, text); x.href = href; x.target = '_blank'; x.rel = 'noopener'; return x; };
      const btc = e.ots && e.ots.state === 'bitcoin' ? `block #${fmt(e.ots.height)}` : e.ots && e.ots.state === 'pending' ? 'pending' : '—';
      const files = el('td');
      const rb = el('button', 'btn-ghost', 'replay'); rb.type = 'button'; rb.style.padding = '4px 9px'; rb.style.marginRight = '10px';
      rb.addEventListener('click', () => { runReplay('/log/' + e.log, 'the hour sealed ' + utc(e.toTs)); $('replayres').scrollIntoView({ block: 'center', behavior: reduceMotion ? 'auto' : 'smooth' }); });
      files.append(rb, a('/log/' + e.log, 'log'), a('/proof/' + e.proof, 'txt'));
      if (e.ots && e.ots.state !== 'none') files.append(a('/proof/' + e.proof + '.ots', 'ots'));
      const td = (t) => el('td', null, t);
      const c1 = el('td'); c1.append(el('code', null, short(e.logSha256)));
      const c2 = el('td'); c2.append(el('code', null, short(e.chainSha256)));
      tr.append(td(`${new Date(e.toTs).toISOString().slice(0, 10)} ${utc(e.toTs)}`), td(fmt(e.events)), c1, c2, td(btc), files);
      tb.append(tr);
    }
    setProofHead({ head: p.chain[0] || null, chain: p.chain.length ? p.chain[0].n + 1 : 0 });
  } catch { /* offline */ } finally { proofLoading = false; }
}
$('replaycmd').textContent = `npm run replay -- ${location.origin}/log/current.jsonl`;


/* ---------- proof: your browser checks the server ---------- */
let worker = null;
function verifier() {
  if (!worker) {
    try {
      worker = new Worker('/verify-worker.js', { type: 'module' });
      worker.onmessage = ({ data }) => onVerifier(data);
      worker.onerror = () => { setBadge('off', 'Live check unavailable here'); };
    } catch { worker = { postMessage() {} }; setBadge('off', 'Live check unavailable here'); }
  }
  return worker;
}
const lc = { start: 0, checks: 0, bad: 0, last: null };
const ua = navigator.userAgent;
$('lcengine').textContent = (/Firefox\//.test(ua) ? 'SpiderMonkey (Firefox)' : /Edg\//.test(ua) ? 'V8 (Edge)' : /Chrome\//.test(ua) ? 'V8 (Chrome)' : /Safari\//.test(ua) ? 'JavaScriptCore (Safari)' : 'your browser') + ' vs V8 (server)';
function setBadge(state, text) {
  const b = $('verifybadge'); b.dataset.state = state; $('verifytext').textContent = innerWidth < 400 ? text.replace(/^Verified live/, 'Verified') : text;
  const pill = $('lcpill');
  pill.textContent = state === 'ok' ? 'Matching' : state === 'bad' ? 'Mismatch' : text.replace(/^Live check /, '');
  pill.className = 'pill ' + (state === 'ok' ? 'live' : state === 'bad' ? 'no' : 'pending');
}
function resetMirror(label) {
  if (worker) worker.postMessage({ t: 'mirror-reset' });
  lc.checks = 0; lc.bad = 0;
  if (label) setBadge('off', label);
}
function proofTap(m) {
  if (m.t === 'hello') {
    resetMirror('Live check starting');
    verifier();
    if (m.pow && m.pow.bits > 0) { powReady = false; verifier().postMessage({ t: 'pow', challenge: m.pow.challenge, bits: m.pow.bits }); }
    else { powReady = true; setTimeout(flushOutbox, 0); }
    setTimeout(() => { if (live()) ws.send(JSON.stringify({ t: 'verify' })); }, 900);
    return;
  }
  if (m.t === 'state') { lc.start = m.step; verifier().postMessage({ t: 'mirror-state', state: m.state }); setBadge('off', 'Checking…'); return; }
  const ev = mirrorEvent(m);
  if (ev) { verifier().postMessage({ t: 'mirror-event', ev }); logLine(ev.k, { k: ev.k, step: ev.step, id: ev.id, by: ev.by, ...(ev.k === 'say' ? { text: ev.text } : ev.k === 'tug' ? { a: ev.a, b: ev.b } : { cells: ev.cells }) }); }
  if (m.t === 'done') logLine('done', { k: 'done', step: m.step, id: m.id, summary: m.summary });
  if (m.t === 'sync') verifier().postMessage({ t: 'mirror-sync', step: m.step, sha: m.sha });
  if (m.t === 'clock') {
    $('hudclock').textContent = `${m.sps.toFixed(1)}/s`;
    if (m.pokes != null) $('actnote').textContent = `${fmt(m.pokes)} pokes · ${fmt(m.messages)} messages / min`;
  }
  if (m.t === 'pow-ok') { powReady = true; flushOutbox(); }
}
function onVerifier(d) {
  if (d.t === 'pow-solved') { if (live()) ws.send(JSON.stringify({ t: 'pow', nonce: d.nonce })); return; }
  if (d.t === 'check') {
    lc.checks++; if (!d.ok) { lc.bad++; console.warn('BRAINWORM live check mismatch', d); }
    const b = $('verifybadge');
    if (lc.bad) setBadge('bad', `Mismatch at step ${fmt(d.step)}`);
    else { setBadge('ok', `Verified live · ${fmt(lc.checks)}`); b.classList.remove('tick'); void b.offsetWidth; b.classList.add('tick'); }
    $('lcpass').textContent = `${fmt(lc.checks - lc.bad)} of ${fmt(lc.checks)}`;
    $('lcsteps').textContent = fmt(d.step - lc.start);
    $('lchash').textContent = short(d.mine);
    if (lc.checks % 10 === 1) logLine('sync', `# step ${fmt(d.step)}  server ${short(d.theirs)}  your browser ${short(d.mine)}  ${d.ok ? 'match' : 'MISMATCH'}`);
  } else if (d.t === 'replay-progress') {
    $('replaybar').style.width = Math.round(d.f * 100) + '%';
  } else if (d.t === 'replay-done') {
    replaying = false; $('replaybtn').disabled = false;
    $('replaybar').style.width = '100%';
    const segs = d.res.segments, r = $('replayres');
    const checked = segs.reduce((a, x) => a + x.checked, 0), matched = segs.reduce((a, x) => a + x.matched, 0), steps = segs.reduce((a, x) => a + x.steps, 0);
    const warn = segs.flatMap((x) => x.warnings), mism = segs.flatMap((x) => x.mismatches);
    const ok = !warn.length && !mism.length;
    r.className = 'result ' + (ok ? 'ok' : 'bad');
    r.textContent = ok
      ? `✓ ${fmt(matched)}/${fmt(checked)} results reproduced exactly. ${fmt(steps)} steps re-run in ${d.ms < 1000 ? Math.max(1, Math.round(d.ms)) + ' ms' : (d.ms / 1000).toFixed(1) + ' s'} on your device` + (segs.some((x) => x.endChecked) ? ', end-state hash matches.' : '.') + ` (${fmt(d.lines)} log lines)`
        + segs.filter((x) => x.launch).map((x) => ` Launch moment at step ${fmt(x.launch.step)} checked: ${x.launch.firstOk === false ? 'NOT the first stop' : x.launch.firstOk ? 'first stop after arming' : 'armed in an earlier hour'}, state ${x.launch.stateOk ? 'matches' : 'DIFFERS'}.`).join('')
      : `✗ ${[...warn, ...mism].slice(0, 3).join(' · ')}`;
  } else if (d.t === 'error') {
    replaying = false; $('replaybtn').disabled = false;
    $('replayres').className = 'result bad'; $('replayres').textContent = 'Could not run the check: ' + d.message;
  }
}
let replaying = false, replayN = 0;
function runReplay(url, label) {
  if (replaying) return;
  replaying = true; $('replaybtn').disabled = true;
  $('replaybar').style.width = '0%';
  $('replayres').className = 'result'; $('replayres').textContent = `Re-running ${label}…`;
  verifier().postMessage({ t: 'replay', url, id: ++replayN });
}
$('replaybtn').addEventListener('click', () => runReplay('/log/current.jsonl', 'this hour'));

// the log, as it's written
const logLines = [];
function logLine(kind, o) {
  const text = typeof o === 'string' ? o : JSON.stringify(o);
  logLines.push({ kind, text });
  if (logLines.length > 12) logLines.shift();
  const ol = $('logconsole'); ol.replaceChildren();
  for (const l of logLines) ol.append(el('li', 'k-' + l.kind, l.text));
}

// every number, measured or chosen
fetch('/manifest.json').then((r) => r.json()).then((mf) => {
  const tb = $('manifesttable').tBodies[0]; tb.replaceChildren();
  const group = (name, kind) => { const tr = el('tr', 'grp'); const td = el('td'); td.colSpan = 2; td.append(name); if (kind) td.append(el('span', 'pill ' + (kind === 'measured' ? 'measured' : 'pending'), kind)); tr.append(td); tb.append(tr); };
  const row = (k, v) => { const tr = el('tr'); tr.append(el('td', null, k), el('td', null, typeof v === 'object' ? JSON.stringify(v) : String(v))); tb.append(tr); };
  const titles = { data: 'The wiring', model: 'The model', eyes: 'Light on the eyes', poke: 'Pokes', tug: 'Tugs', code: 'Code your browser runs (SHA-256)' };
  for (const [g, obj] of Object.entries(mf)) {
    if (g === 'version') continue;
    group(titles[g] || g, obj.kind || (g === 'code' ? null : ''));
    for (const [k, v] of Object.entries(obj)) if (k !== 'kind') row(k, v);
  }
  row('model version', mf.version);
}).catch(() => {});

/* ---------- the lab ---------- */
const pct = (v) => `${Math.round(v * 100)}%`;
// small numbers keep two significant digits, so 0.000085 never shows as 0.0001 and 0 stays 0
const sig = (v) => (v === 0 ? '0' : Math.abs(v) < 0.001 ? v.toPrecision(2) : v.toFixed(4));
const LAB_SHORT = {
  'eyes-sides': (x) => `lit side ${sig(x.real.lateralization)} · rewired p95 ${sig(x.control.p95)}`,
  'touch-startle': (x) => `startle ${sig(x.real.touch)} · rewired p95 ${sig(x.control.p95)}`,
  'touch-startle-v2': (x) => `startle ${sig(x.real.touch)} · rewired p95 ${sig(x.control.p95)}`,
  'light-latency': (x) => `${fmt(x.real.ms)} ms · rewired avg ${fmt((x.control.mean * 1000) / STEPS_PER_SECOND)} ms`,
  alphabet: (x) => { const t = x.real.top && x.real.top[0]; return t ? `“${t.glyph}” fires most · ${fmt(t.peak)} cells` : ''; },
  fatigue: (x) => `10th poke ${Math.round(x.real.ratio * 100)}% of the 1st`,
  'follow-the-light': (x) => `${Math.abs(x.real.attractionUm).toFixed(1)} µm ${x.real.attraction >= 0 ? 'closer' : 'farther'} · rewired p95 ${x.details.controlUm.p95.toFixed(1)} µm`,
  'eyespot-cilia': (x) => `own side ${sig(x.real.laterality)} · rewired p95 ${sig(x.control.p95)}`,
  // both halves must beat the rewired worms: the muscles decide it here, so they come first
  'startle-reflex': (x) => { const c = x.details.conditions || {}; return `muscles ${sig(x.real.startle)} · rewired p95 ${sig(x.control.p95)} · cilia half ${c.arrestSpecific && c.arrestAboveScrambles ? 'passes' : 'fails'}`; },
  'stop-and-go': (x) => `${pct(x.real.peak)} of cilia stop at once · rewired avg ${pct(x.control.mean)}`,
};
async function loadLab(tries = 0) {
  let r;
  try { r = await fetch('/lab.json', { cache: 'no-store' }); } catch { return; }
  if (r.status === 404) { $('lab').hidden = true; return; }
  const d = await r.json().catch(() => null);
  if (!d) return;
  if (!Array.isArray(d.results)) { if (d.state === 'running' && tries < 40) setTimeout(() => loadLab(tries + 1), 5000); return; }
  const fails = d.results.filter((x) => x.verdict === 'fails').length, passes = d.results.filter((x) => x.verdict === 'passes').length;
  let v1 = {};
  try { const o = await (await fetch('/data/lab-model-v1.json')).json(); for (const x of o.results || []) v1[x.id] = x.verdict; } catch { /* only the current model then */ }
  const pill = $('labpill');
  pill.textContent = `${passes} pass · ${fails} fail`; pill.className = 'pill ' + (fails ? 'no' : 'live');
  const lampTest = d.results.find((x) => x.id === 'follow-the-light');
  if (lampTest) { const lp = $('lamppill'); lp.hidden = false; lp.textContent = `Lamp test ${lampTest.verdict}`; lp.className = 'pill ' + (lampTest.verdict === 'passes' ? 'live' : 'no'); }
  const ol = $('labrows'); ol.replaceChildren();
  for (const x of d.results) {
    const li = el('li'), det = el('details'), sum = el('summary'), lt = el('span', 'lt', x.title);
    if (x.protocol && x.protocol.registeredAfter) lt.append(el('small', null, `added after ${x.protocol.registeredAfter.replace(/^the /, '')}`));
    let short = ''; try { short = (LAB_SHORT[x.id] || (() => ''))(x); } catch { /* a result without these fields */ }
    const v = x.verdict === 'fails' ? ['Fails', 'no'] : x.verdict === 'passes' ? ['Passes', 'live'] : ['Measured', 'measured'];
    if (v1[x.id]) lt.append(el('small', null, `retired model v1: ${v1[x.id]}`));
    sum.append(lt, el('span', 'lm', short), el('span', 'pill ' + v[1], v[0]));
    det.append(sum, el('p', null, x.summary), el('p', 'rule', `Rule: ${x.rule}`));
    li.append(det); ol.append(li);
  }
}

/* ---------- the launch ---------- */
function setLaunch(l) {
  const pill = $('launchpill');
  const st = l.launched ? ['Launched', 'live'] : l.metadata ? ['Ready to sign', 'pending'] : l.moment ? ['Moment captured', 'measured'] : l.armed ? ['Armed', 'pending'] : ['Not armed', ''];
  pill.textContent = st[0]; pill.className = 'pill ' + st[1];
  if (l.moment && !l.launched) $('launchtext').textContent = `Launch moment: step ${fmt(l.moment.step)}, the first time a touch made it stop swimming after arming. Replay the log to check it.`;
  if (l.launched) $('launchtext').textContent = `Launched. The token image is the worm at step ${fmt(l.moment ? l.moment.step : 0)}. Buys poke its head, sells its tail, each logged with its signature.`;
}

/* ---------- mods ---------- */
let annTimer = null;
function setMod(m) {
  modState = { chatPaused: !!m.chatPaused, pokesPaused: !!m.pokesPaused, slowSec: m.slowSec | 0, announce: m.announce || null };
  const ms = $('modstate');
  const notes = [];
  if (modState.chatPaused) notes.push('Chat is paused by the mods for a moment.');
  else if (modState.slowSec) notes.push(`Slow mode: one message every ${modState.slowSec}s.`);
  if (modState.pokesPaused) notes.push('Pokes are paused.');
  ms.textContent = notes.join(' '); ms.hidden = !notes.length;
  for (const id of ['msg', 'tugwa', 'tugwb']) $(id).disabled = modState.chatPaused;
  clearInterval(annTimer);
  const a = modState.announce, bar = $('announce');
  if (a && a.text) {
    $('announcetext').textContent = a.text; bar.hidden = false;
    const tick = () => { const left = Math.max(0, (m.announce.until - Date.now()) / 1000); $('announceleft').textContent = left > 60 ? `${Math.ceil(left / 60)} min` : `${Math.ceil(left)}s`; if (left <= 0) { bar.hidden = true; clearInterval(annTimer); } };
    tick(); annTimer = setInterval(tick, 1000);
  } else bar.hidden = true;
}

/* ---------- site config: token, links, calibration, twitch ---------- */
fetch('/config.json').then((r) => r.json()).then((c) => {
  site = c.site || {}; features = c.features || {}; calibration = c.calibration || null;
  if (site.contract) {
    $('coin').hidden = false;
    $('coinca').textContent = site.contract;
    $('cointick').textContent = site.ticker ? '· ' + site.ticker : '';
    const nc = $('navcoin'); nc.textContent = site.ticker || 'Contract'; nc.hidden = false;
    const kv = $('cointable'); kv.replaceChildren();
    const row = (k, v) => { const d = el('div'); d.append(el('dt', null, k)); const dd = el('dd'); if (v instanceof Node) dd.append(v); else dd.textContent = v; d.append(dd); kv.append(d); };
    if (site.ticker) row('Ticker', site.ticker);
    row('Contract', site.contract);
    if (site.chain) row('Chain', site.chain);
    for (const l of site.links || []) { const a = el('a', null, l.url.replace(/^https:\/\//, '')); a.href = l.url; a.target = '_blank'; a.rel = 'noopener'; row(l.label, a); }
    $('copyca').addEventListener('click', () => {
      navigator.clipboard?.writeText(site.contract).then(() => { $('copyca').textContent = 'Copied'; setTimeout(() => { $('copyca').textContent = 'Copy'; }, 1500); }).catch(() => {});
    });
  }
  const fl = $('footlinks'); fl.replaceChildren();
  for (const l of site.links || []) { const a = el('a', null, l.label); a.href = l.url; a.target = '_blank'; a.rel = 'noopener'; fl.append(a); }
  if (calibration) renderCalibration();
  if (features.twitch && !twitch) twitch = { channel: features.twitch, prefix: '!worm' };
  renderTwitch();
}).catch(() => {});

function renderCalibration() {
  const dl = $('caltable');
  const row = (k, v, ok) => { const d = el('div'); d.append(el('dt', null, k), el('dd', ok ? 'ok' : '', v)); dl.append(d); };
  const swap = calibration.swap, big = Math.max(Math.abs(swap[0].score), Math.abs(swap[1].score));
  const sameMax = Math.max(...calibration.same.map((s) => Math.abs(s.score)));
  const f = (v) => (v > 0 ? '+' : v < 0 ? '−' : '') + degS(Math.abs(v));
  row('Same word, both sides', calibration.same.map((s) => `${s.a}: ${f(s.score)}`).join(' · '), sameMax < 0.2 * big);
  row('Swapped pair', `${swap[0].a}|${swap[0].b} ${f(swap[0].score)} · ${swap[1].a}|${swap[1].b} ${f(swap[1].score)}`, Math.sign(swap[0].score) === -Math.sign(swap[1].score));
  row('Run', 'on a fresh worm every time the server starts', true);
  $('calpill').textContent = sameMax < 0.2 * big && Math.sign(swap[0].score) === -Math.sign(swap[1].score) ? 'Measured · passes' : 'Measured · fails';
}
function renderTwitch() {
  const pill = $('twitchpill');
  if (twitch && twitch.channel) {
    pill.textContent = 'Live'; pill.className = 'pill live';
    $('twitchtext').textContent = `Connected to twitch.tv/${twitch.channel}. "${twitch.prefix || '!worm'} message" and "!poke" in chat reach this worm.`;
  }
  if (STREAM) renderStreamCta();
}

/* ---------- /stream ---------- */
function renderStreamCta() {
  const c = $('streamcta'); c.hidden = false; c.replaceChildren();
  c.append(el('span', 'k', 'Talk to the worm'));
  const t = el('div', 't');
  if (twitch && twitch.channel) { t.append('type '); t.append(el('code', null, `${twitch.prefix || '!worm'} your message`)); t.append(' in chat'); }
  else t.append(location.host);
  c.append(t);
}
function renderStreamFeed(items) {
  const ol = $('streamfeed'); ol.hidden = false; ol.replaceChildren();
  for (const it of items) {
    const li = el('li', it.kind);
    const who = it.by === you ? 'you' : String(it.by).replace(/^twitch:/, '');
    li.append(`${who} `, el('b', null, it.kind === 'say' ? `“${it.text}”` : it.kind === 'tug' ? `${it.a} vs ${it.b}` : it.kind === 'lamp' ? 'lit the lamp' : 'poked it'));
    ol.append(li);
  }
}
function renderStreamBoard() {
  const ol = $('streamboard'); ol.hidden = false; ol.replaceChildren();
  ol.append(el('li', 'h', 'Most cells today'));
  for (const e of (board.today || []).slice(0, 5)) { const li = el('li', null, e.text); li.append(el('span', null, fmt(e.peak))); ol.append(li); }
}

/* ---------- sound ---------- */
const sound = createSound({ kinds: KIND });
function setSoundUI() { const b = $('soundbtn'); b.setAttribute('aria-pressed', String(sound.enabled)); b.title = sound.enabled ? 'Sound on' : 'Sound: every firing cell clicks'; }
$('soundbtn').addEventListener('click', async () => {
  if (sound.enabled) { sound.disable(); store.set('sound', false); }
  else { await sound.enable(); store.set('sound', true); }
  setSoundUI();
});
if (store.get('sound', false)) addEventListener('pointerdown', async function once() { removeEventListener('pointerdown', once); if (!sound.enabled) { await sound.enable(); setSoundUI(); } });
const panOf = (i) => (D.n[i][5] ? (proj[i * 3] / VW) * 2 - 1 : 0);

/* ---------- clips ---------- */
const clipBuf = createClipBuffer(N);
let recording = false, clipUrl = null, clipBlob = null, clipName = '';
$('clipbtn').addEventListener('click', async () => {
  if (recording) return;
  if (!clipSupported()) { toast('Clips need a recent Chrome, Edge, Firefox or Safari.'); return; }
  const frames = clipBuf.frames();
  const withMsg = [...frames].reverse().find((f) => f.msg);
  const peak = frames.reduce((m, f) => Math.max(m, f.nAct), 0);
  const headline = withMsg ? (withMsg.msg.kind === 'tug' ? `Tug: ${withMsg.msg.a} vs ${withMsg.msg.b}` : withMsg.msg.kind === 'lamp' ? `Lamp → ${fmt(peak)} cells fired` : `“${withMsg.msg.text}” → ${fmt(peak)} cells fired`) : `${fmt(peak)} cells firing at once`;
  recording = true;
  const btn = $('clipbtn'), label = btn.querySelector('span');
  btn.classList.add('rec');
  try {
    const out = await recordClip({ frames, D, colors: COLORS, kinds: KIND, withSound: sound.enabled, site: location.host, headline, onProgress: (f) => { label.textContent = Math.round(f * 100) + '%'; } });
    clipBlob = out.blob;
    if (clipUrl) URL.revokeObjectURL(clipUrl);
    clipUrl = URL.createObjectURL(out.blob);
    clipName = `brainworm-${(withMsg && withMsg.msg.kind === 'say' ? withMsg.msg.text : withMsg && withMsg.msg.kind === 'lamp' ? 'lamp' : 'clip').replace(/[^a-z0-9]+/gi, '-').slice(0, 24) || 'clip'}.${out.ext}`;
    openClip(headline, peak, withMsg ? withMsg.msg : null, out.ext);
  } catch (e) { toast(e.message || 'Could not record a clip here.'); }
  finally { recording = false; btn.classList.remove('rec'); label.textContent = 'Clip'; }
});
function openClip(headline, peak, msg, ext) {
  const m = $('clipmodal'), v = $('clipvideo');
  v.src = clipUrl; v.play().catch(() => {});
  $('clipinfo').textContent = `${CLIP_SECONDS} seconds, ${ext.toUpperCase()}, rendered in your browser. ${ext === 'webm' ? 'X prefers MP4: Chrome or Safari save MP4.' : ''}`;
  const text = msg && msg.kind === 'say' ? `I said “${msg.text}” to a simulation of a real worm larva's nervous system and ${fmt(peak)} cells fired. Everyone watching sees the same worm.` : `${fmt(peak)} cells firing at once in a simulation of a real larva's nervous system. Everyone watching sees the same worm.`;
  $('clipx').href = `https://x.com/intent/post?text=${encodeURIComponent(text)}&url=${encodeURIComponent(location.origin)}`;
  m.hidden = false;
  $('clipsave').focus();
}
$('clipsave').addEventListener('click', () => { const a = el('a'); a.href = clipUrl; a.download = clipName; document.body.append(a); a.click(); a.remove(); });
$('clipshare').addEventListener('click', async () => {
  const file = new File([clipBlob], clipName, { type: clipBlob.type });
  if (navigator.canShare && navigator.canShare({ files: [file] })) { try { await navigator.share({ files: [file], title: 'BRAINWORM', text: 'A real larva\'s wiring, simulated live.' }); } catch { /* cancelled */ } }
  else toast('Sharing files isn\'t supported here. Download it instead.');
});
const closeClip = () => { $('clipmodal').hidden = true; $('clipvideo').pause(); };
$('clipclose').addEventListener('click', closeClip);
$('clipmodal').addEventListener('click', (e) => { if (e.target.id === 'clipmodal') closeClip(); });
addEventListener('keydown', (e) => { if (e.key === 'Escape') { closeClip(); clearInspect(); } });

/* ---------- share ---------- */
$('sharebtn').addEventListener('click', async () => {
  const data = { title: 'BRAINWORM', text: 'Launch a coin and it hatches its own worm: a copy of a real larva\'s wiring, simulated live.', url: location.origin };
  if (navigator.share) { try { await navigator.share(data); return; } catch { /* cancelled */ } }
  try { await navigator.clipboard.writeText(location.origin); toast('Link copied', true); } catch { toast(location.origin, true); }
});

/* ---------- first visit ---------- */
function dismissCoach() { if (!$('coach').hidden) { $('coach').hidden = true; store.set('coached', true); } }
function dismissHint() { $('hint').classList.add('gone'); }
if (coarse) $('hint').textContent = 'Tap to poke · two fingers to turn';
const narrowInput = matchMedia('(max-width: 420px)');
const setPlaceholder = () => { $('msg').placeholder = narrowInput.matches ? 'Say something' : 'Say something to the worm'; };
setPlaceholder(); narrowInput.addEventListener?.('change', setPlaceholder);
$('coach').addEventListener('click', dismissCoach);

/* ---------- the scroll story ---------- */
const sceneObs = new IntersectionObserver((entries) => {
  for (const e of entries) if (e.isIntersecting) scene = e.target.dataset.scene || 'hero';
}, { rootMargin: '-48% 0px -48% 0px' });
for (const s of document.querySelectorAll('[data-scene]')) sceneObs.observe(s);
const heroObs = new IntersectionObserver((entries) => { for (const e of entries) if (e.isIntersecting) scene = 'hero'; }, { rootMargin: '-48% 0px -48% 0px' });
heroObs.observe($('stage'));
const stepObs = new IntersectionObserver((entries) => {
  for (const e of entries) {
    if (!e.isIntersecting) continue;
    step = e.target.dataset.step;
    for (const li of document.querySelectorAll('.steps li')) li.classList.toggle('on', li === e.target);
  }
}, { rootMargin: '-45% 0px -45% 0px' });
for (const li of document.querySelectorAll('.steps li')) stepObs.observe(li);
const revealObs = new IntersectionObserver((entries) => {
  for (const e of entries) if (e.isIntersecting) { e.target.classList.add('in'); revealObs.unobserve(e.target); }
}, { rootMargin: '0px 0px -8% 0px' });
for (const sec of document.querySelectorAll('.section')) {
  [...sec.querySelectorAll('.eyebrow, .display, .lede, .legend, .exp, .boardcol, .steps li, .kv, .tablewrap, .howto, .plain li, .castrip')].forEach((n, k) => {
    n.classList.add('rv'); n.style.transitionDelay = Math.min(k, 6) * 45 + 'ms'; revealObs.observe(n);
  });
}

/* ---------- intro ---------- */
function placeIntroTitle() {
  const brand = $('brand'), h = $('stage').getBoundingClientRect();
  brand.style.transform = 'none';
  const b = brand.getBoundingClientRect();
  brand.style.transform = '';
  const free = h.width;
  const s = Math.min(2.8, (free * 0.62) / b.width);
  const cx = h.left + free / 2, cy = h.top + h.height * 0.44;
  body.style.setProperty('--ix', (cx - (b.left + (b.width * s) / 2)).toFixed(1) + 'px');
  body.style.setProperty('--iy', (cy - (b.top + (b.height * s) / 2)).toFixed(1) + 'px');
  body.style.setProperty('--is', s.toFixed(3));
}
function endIntro() {
  if (!body.classList.contains('intro')) return;
  body.classList.remove('intro'); body.classList.add('ready');
  setTimeout(measureLayout, 800);
  if (anatomyOn) setTimeout(loadAnatomy, 600);
  setTimeout(dismissHint, 16000);
}
addEventListener('scroll', () => { if (scrollY > 40) endIntro(); }, { passive: true });

/* ---------- the swim panel ---------- */
const CILIA = ciliaInputs(D);
const tankView = createTank($('tank'), { tank: BODY.tank, umPerUnit: UM_PER_UNIT, still: reduceMotion });
const tankBig = createTank($('tank2'), { tank: BODY.tank, umPerUnit: UM_PER_UNIT, still: reduceMotion });
let swimVisible = true, bigVisible = false, swimShownAt = 0;
new IntersectionObserver((es) => { for (const e of es) swimVisible = e.isIntersecting; }).observe($('tank'));
new IntersectionObserver((es) => { for (const e of es) bigVisible = e.isIntersecting; }).observe($('tank2'));
const setText = (id, t) => { const e = $(id); t = String(t); if (e.textContent !== t) e.textContent = t; };
function paintSwim(now, ro) {
  if ((!swimVisible && !bigVisible) || STREAM) return;
  // the same cilia rule the body uses (model v2), applied to the activity on screen
  const bt = beats(CILIA, act8, 255), beatL = bt.L, beatR = bt.R, beat = (beatL + beatR) / 2;
  const lampPos = nowMsg && nowMsg.kind === 'lamp' && nowMsg.pos ? nowMsg.pos : null;
  const view = { p: pose.p, q: pose.q, trail: swimTrail, beat, st: Math.min(1, ro.st / 0.9), time: now / 1000, lamp: lampPos };
  if (swimVisible) tankView.draw(view);
  if (bigVisible) tankBig.draw(view);
  if (!swimVisible || now - swimShownAt < 160) return;
  swimShownAt = now;
  const speed = mode === 'offline' && local ? local.body.state.speed * UM_PER_UNIT : swimSpeed;
  setText('swspeed', fmt(speed));
  setText('swdepth', (((BODY.tank - pose.p[1]) * UM_PER_UNIT) / 1000).toFixed(2));
  setText('swcilia', Math.round(beat * 100));
  const mm = (pose.dist * UM_PER_UNIT) / 1000;
  setText('swdist', mm < 1000 ? mm.toFixed(1) : mm < 1e6 ? (mm / 1000).toFixed(2) : fmt(mm / 1000));
  setText('swdistu', mm < 1000 ? 'mm' : 'm');
  const steer = BODY.ciliaTurn * (beatR - beatL) + BODY.muscleTurn * ro.bend;
  const lampD = lampPos ? Math.hypot(pose.p[0] - lampPos[0], pose.p[1] - lampPos[1], pose.p[2] - lampPos[2]) : 0;
  const [note, cls] = beat < 0.5 ? ['cilia stopped · sinking', 'stop'] : ro.st > 0.3 ? ['startle · braking', 'brake'] : lampPos ? [`lamp ${((lampD * UM_PER_UNIT) / 1000).toFixed(2)} mm away`, 'lamp'] : Math.abs(steer) > 0.6 ? [`turning ${steer > 0 ? 'left' : 'right'}`, 'turn'] : ['swimming', ''];
  setText('swimnote', note);
  if ($('swimnote').className !== cls) $('swimnote').className = cls;
}

/* ---------- main loop ---------- */
let last = performance.now(), frameMs = 16, slowFrames = 0;
function updateActivity(now) {
  if (mode === 'offline' && local) { local.quantize(act8); return; }
  if (curStep < 0) return;
  const a = Math.min(1, (now - curT) / (STEP_MS * 2));
  for (let i = 0; i < N; i++) act8[i] = fPrev[i] + (fCur[i] - fPrev[i]) * a;
}
let bendS = 0, stS = 0, lastKind = -1;
function frame(now) {
  const dtMs = Math.min(100, now - last); last = now;
  const dt = dtMs / 1000;
  if (mode === 'offline' && local) {
    localAcc += dtMs; let n = 0;
    while (localAcc >= STEP_MS && n++ < 5) { local.tick(); localAcc -= STEP_MS; if (local.step % TRAIL_EVERY === 0) pushTrail(local.body.state.p); }
    if (n >= 5) localAcc = 0;
  }
  updateActivity(now);
  updatePose(now);
  const ro = readouts(act8, roles, 255);
  bendS += (Math.max(-1, Math.min(1, ro.bend / 0.08)) - bendS) * (1 - Math.exp(-dt * 9));
  stS += (Math.min(1, ro.st / 0.9) - stS) * (1 - Math.exp(-dt * 12));
  updateCamera(dt, now);
  if (lookAim.kind >= 0) lastKind = lookAim.kind;
  const jitter = shake > 0 ? { yaw: (Math.random() - 0.5) * 0.02 * shake, pitch: (Math.random() - 0.5) * 0.015 * shake } : { yaw: 0, pitch: 0 };
  const drawCam = { ...cam, yaw: cam.yaw + jitter.yaw, pitch: cam.pitch + jitter.pitch };
  const stepNow = currentStep(now);
  R.frame({
    act: act8, cam: drawCam, bend: bendS, st: stS, shock: Math.max(stS * 0.6, shake * 0.8), time: now / 1000,
    hover, focus: focusCell, exposure: look.exposure, web: look.web, kind: look.kindK > 0.02 ? lastKind : -1, kindK: look.kindK, haze: look.haze * (1 - 0.6 * look.anatomy), anatomy: look.anatomy,
    dof: scene === 'hero' ? 0.3 : 0.25, bloom: 0.92,
  });
  projectAll(bendS, stS);
  drawOverlay(now, dt, bendS, stS);
  paintPanels(now, ro, stepNow);
  paintSwim(now, ro);
  checkStartle(ro, now, stepNow);
  sound.update(act8, panOf, stS);
  clipBuf.push({ t: now, act: act8, cam: drawCam, bend: bendS, st: stS, shock: shake, step: Math.floor(stepNow), msg: nowMsg, nAct: ro.nAct });
  // keep it smooth: if frames are slow for a while, render fewer pixels
  frameMs = frameMs * 0.95 + dtMs * 0.05;
  if (frameMs > 26 && dprScale > 0.6) { if (++slowFrames > 90) { dprScale = Math.max(0.6, dprScale * 0.85); slowFrames = 0; frameMs = 16; resize(); } } else slowFrames = 0;
  requestAnimationFrame(frame);
}

/* ---------- start ---------- */
window.__bw = { cam, aim, look, get scene() { return scene; }, get step() { return step; }, get heroOx() { return heroOx; }, get mode() { return mode; }, get fit() { return heroFit; }, get ui() { return ui; } };
new ResizeObserver(resize).observe(cv);
new ResizeObserver(measureLayout).observe($('dock'));
addEventListener('resize', measureLayout);
resize();
setMode('connecting');
renderFeed();
connect();
loadProof();
loadLab();
setInterval(loadProof, 5 * 60e3);
requestAnimationFrame((t) => {
  last = t; body.classList.remove('loading');
  placeIntroTitle();
  requestAnimationFrame(frame);
  if (reduceMotion || STREAM) { introUntil = 0; endIntro(); }
  else setTimeout(endIntro, 1700);
});

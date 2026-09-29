// One live worm for everyone.
// The server owns the only simulation. It streams activity to every viewer at 15 frames/s,
// takes messages, tugs and pokes from anyone (and optionally from Twitch chat), and writes every
// stimulus to a chunked event log that `npm run replay` can re-run to check the published summaries.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { WormCore } from '../shared/worm.js';
import { PARAMS, STEPS_PER_SECOND, inhibitorySynapses } from '../shared/sim.js';
import { encodeFrame } from '../shared/frames.js';
import { config as defaultConfig } from './config.js';
import { checkMessage, findScam, loadBlocklist, RateLimiter } from './moderation.js';
import { createStatic, MIME } from './static.js';
import { createLedger, LOG_VERSION } from './ledger.js';
import { stateString } from '../shared/replay.js';
import * as text from '../shared/text.js';
import { TUG_ORDER, TUG_SCORED, TUG_GAP, MAX_POKE_CELLS, POKE_STEPS, POKE_DRIVE } from '../shared/worm.js';
import { BODY, UM_PER_UNIT } from '../shared/body.js';
import { LAMP } from '../shared/lamp.js';
import { startLab } from './lab.js';
import { withTransmitters } from '../shared/data.js';
import { MODEL_V2 } from '../shared/model.js';
import { Board } from './board.js';
import { ModState, Counter } from './modstate.js';
import { makeHandle } from './names.js';
import * as ots from './ots.js';
import { createTwitchBridge } from './twitch.js';
import * as render from './render.js';
import * as solana from './solana.js';
import { createLaunch } from './launch.js';
import * as dbc from './dbc.js';
import { createSpawn, IMAGE_HOSTS } from './spawn.js';
import { createCoinWorms, previewHatch } from './coinworms.js';
import { COINWORM_VERSION, STEPS_PER_TRADE } from '../shared/coinworm.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STEP_MS = 1000 / STEPS_PER_SECOND;
const FRAME_EVERY = 2;          // steps per streamed frame (15 fps)
const REST_FRAME_EVERY = 6;     // when nothing is firing, 5 frames a second: the body still swims
const TRAIL_EVERY = 6, TRAIL_POINTS = 300;   // the last 60 s of the swim, sent to newcomers
const MAX_BUFFERED = 256 * 1024; // a viewer this far behind skips frames instead of piling them up
const TUG_WORD_MAX = 10;
const FEED_POKES = 20;          // pokes kept in the feed, so a poke storm can't push messages out
const OPEN = 1;
const SYNC_EVERY = 30;       // steps between state hashes sent to verifying browsers (1 s)
const IMG_ORIGINS = IMAGE_HOSTS.map((h) => new URL(h).origin).join(' ');   // where SPAWN coins' pictures live
const META_TYPES = { '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' };

/**
 * The tug's own check, run on a fresh worm at every start and published on the site:
 * the same word on both sides should come out even, and swapping two words should flip the result.
 */
export function calibrateTug(D, same = ['gm', 'PEPE', 'LFG'], pair = ['BONK', 'gm']) {
  const run = (a, b) => {
    let res = null;
    const w = new WormCore(D, { onEvent: (e) => { if (e.type === 'tug') res = e.result; } });
    w.tug('c', a, b);
    for (let i = 0; i < 20000 && !res; i++) w.tick();
    return res.score;
  };
  return {
    same: same.map((w) => ({ a: w, b: w, score: run(w, w) })),
    swap: [{ a: pair[0], b: pair[1], score: run(pair[0], pair[1]) }, { a: pair[1], b: pair[0], score: run(pair[1], pair[0]) }],
  };
}

export function createWormServer(overrides = {}) {
  const config = {
    ...defaultConfig, ...overrides,
    limits: { ...defaultConfig.limits, ...(overrides.limits || {}) },
    site: { ...defaultConfig.site, ...(overrides.site || {}) },
    twitch: { ...defaultConfig.twitch, ...(overrides.twitch || {}) },
    token: { ...defaultConfig.token, ...(overrides.token || {}) },
    pow: { ...defaultConfig.pow, ...(overrides.pow || {}) },
    spawn: { ...defaultConfig.spawn, ...(overrides.spawn || {}) },
  };
  const L = config.limits;
  const stepMs = STEP_MS / (config.speed || 1);   // speed > 1 only in tests
  const wiringRaw = fs.readFileSync(path.join(ROOT, 'data', 'wiring.json'));
  const wiringHash = crypto.createHash('sha256').update(wiringRaw).digest('hex');
  const txRaw = fs.readFileSync(path.join(ROOT, 'data', 'transmitters.json'));
  const txHash = crypto.createHash('sha256').update(txRaw).digest('hex');
  const D = withTransmitters(JSON.parse(wiringRaw), JSON.parse(txRaw));
  const dataDir = config.logDir ? path.resolve(ROOT, config.logDir) : null;
  if (dataDir) fs.mkdirSync(dataDir, { recursive: true });

  const mod = new ModState({ file: dataDir && path.join(dataDir, 'mod.json') });
  const board = new Board({ size: L.boardSize, file: dataDir && path.join(dataDir, 'board.json'), model: MODEL_V2.id });
  let fileBlocklist = loadBlocklist(path.resolve(ROOT, config.blocklistFile));
  const blocklist = () => (mod.extra.length ? fileBlocklist.concat(mod.extra) : fileBlocklist);
  const calibration = calibrateTug(D);
  // every number the model and the stimuli use, marked measured (from the data) or chosen (by us)
  function makeInhibitoryList() {   // model v2's inhibitory synapses, by name
    const inh = inhibitorySynapses(D), out = [];
    for (let m = 0; m < inh.length; m++) if (inh[m]) out.push(`${D.n[D.e[3 * m]][0]} → ${D.n[D.e[3 * m + 1]][0]} (${D.e[3 * m + 2]} synapses)`);
    return out;
  }
  const manifest = {
    version: LOG_VERSION,
    data: {
      kind: 'measured', wiringSha256: wiringHash, cells: D.n.length, connections: D.e.length / 3,
      synapses: D.e.reduce((s, v, k) => (k % 3 === 2 ? s + v : s), 0),
      source: 'Verasztó et al., Whole-body connectome of a segmented annelid larva, eLife 2025. https://github.com/JekelyLab/Platynereis_3D_connectome_2024 (CC BY 4.0)',
      rebuild: 'python3 scripts/build-data/build_wiring.py <lab repo> data/wiring.json reproduces the file byte-for-byte',
      transmitters: { kind: 'measured', sha256: txHash, known: Object.keys(D.tx).length, source: 'the lab\'s cell-type table, column "transmitter phenotype"', rebuild: 'python3 scripts/build-data/build_transmitters.py <lab repo> data/wiring.json data/transmitters.json' },
    },
    model: { kind: 'chosen', id: MODEL_V2.id, registered: '/data/registrations/model-v2.json (with a Bitcoin timestamp)', stepsPerSecond: STEPS_PER_SECOND, ...PARAMS, rules: MODEL_V2.rules.map((r) => ({ [r.id]: r.rule })), notDone: MODEL_V2.notDone, references: MODEL_V2.references, inhibitorySynapses: [...makeInhibitoryList()], tanh: 'shared/detmath.js, plain arithmetic so every engine agrees' },
    eyes: { kind: 'chosen', view: text.VIEW, speed: text.SPEED, eyeGain: text.EYE_GAIN, flood: text.FLOOD, floodGain: text.FLOOD_GAIN, mapping: '13 left photoreceptors sample strips of the left half of the view, 13 right ones the right half' },
    poke: { kind: 'chosen', maxCells: MAX_POKE_CELLS, steps: POKE_STEPS, drive: POKE_DRIVE },
    spawn: {
      kind: 'chosen', poke: 'a buy of a coin on SPAWN, the BRAINWORM launchpad, pokes three touch cells picked from the SHA-256 of the coin\'s address: the same spot for every buy of that coin, logged with its transaction',
      coinWorm: { version: COINWORM_VERSION, what: 'every coin on SPAWN also has its own worm: a fresh copy of this larva, nothing added', birth: 'its first sight is "$TICKER", shown to its eyes as a message', trades: `a buy touches three head-end touch cells, a sell three tail-end ones, picked from the trade\'s signature, then ${STEPS_PER_TRADE} steps; between trades its time stands still`, check: '/spawn/worm/<mint>.json lists its ticker, every trade in order and its state hash; shared/coinworm.js rebuild() recomputes it' },
    },
    tug: { kind: 'chosen', order: TUG_ORDER, scored: TUG_SCORED, gapSteps: TUG_GAP, score: 'how fast the body turned toward word A (rad/s), from its cilia and muscles as it steers, averaged over the scored passes; a tie below 0.0001' },
    body: { kind: 'chosen', ...BODY, umPerUnit: UM_PER_UNIT, physics: 'low Reynolds number: velocity proportional to force, no inertia; the body feeds back into the brain only through the lamp', cilia: 'model v2: cholinergic input stops a ciliated cell, serotonergic input keeps it beating (shared/cilia.js)', muscles: 'left-minus-right body-wall activity steers', startle: 'startle muscles brake' },
    lamp: { kind: 'chosen', ...LAMP, eyes: 'each side\'s eyes look along (±0.8, 0.5, 0.33) in the body frame; a pigment cup passes light from its own side as the cosine of the angle off that axis', brightness: '1 / (1 + (d / falloff)^2)', drive: 'each side\'s 13 photoreceptors get min(1, 1.6 × light), like a message\'s lit strip; the non-directional light sensors do not respond', placement: 'lit `distance` units from the worm in a random direction, kept inside the tank', test: '/lab.json follow-the-light, registered before any lamp was lit' },
    code: Object.fromEntries(['worm.js', 'sim.js', 'model.js', 'cilia.js', 'body.js', 'lamp.js', 'text.js', 'roles.js', 'state.js', 'replay.js', 'detmath.js', 'glyphs.js', 'data.js'].map((f) => [f, crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT, 'shared', f))).digest('hex')])),
  };
  const ipKey = (ip) => 'ip:' + crypto.createHash('sha256').update(mod.salt + ip).digest('hex').slice(0, 16);

  /* ---------- the worm, the feed, the log ---------- */
  const feed = [];
  const findItem = (id) => feed.find((f) => f.id === id);
  const senderOf = new Map();    // stimulus id -> {key, label}, for hide/mute
  const chainInfo = new Map();   // stimulus id -> {sig, side, sol} for stimuli made by token trades
  const clients = new Set();
  const stats = { say: new Counter(), poke: new Counter(), rejected: new Counter() };
  const startedAt = Date.now();
  let ledger = null;

  const worm = new WormCore(D, { onEvent });
  const writeLog = (o) => { if (ledger) ledger.write(o); };

  function onEvent(ev) {
    const by = ev.meta && ev.meta.by;
    if (ev.type === 'start') {
      const it = findItem(ev.id); if (it) it.step = ev.step;
      if (ev.kind === 'tug') {
        writeLog({ k: 'tug', step: ev.step, id: ev.id, by, a: ev.a, b: ev.b });
        broadcast({ t: 'start', kind: 'tug', id: ev.id, step: ev.step, by, a: ev.a, b: ev.b });
      } else if (ev.kind === 'lamp') {
        writeLog({ k: 'lamp', step: ev.step, id: ev.id, by, dir: ev.dir, pos: ev.pos });
        broadcast({ t: 'start', kind: 'lamp', id: ev.id, step: ev.step, by, dir: ev.dir, pos: ev.pos });
      } else {
        const ch = chainInfo.get(ev.id);
        writeLog({ k: 'say', step: ev.step, id: ev.id, by, text: ev.text, ...(ch ? { sig: ch.sig, side: ch.side, sol: ch.sol } : {}) });
        broadcast({ t: 'start', kind: 'say', id: ev.id, step: ev.step, by, text: ev.text });
      }
    } else if (ev.type === 'poke') {
      const ch = chainInfo.get(ev.id);
      const item = { id: ev.id, kind: 'poke', by, cells: ev.cells, step: ev.step, ts: Date.now(), ...(ch ? { chain: ch } : {}) };
      pushFeed(item);
      writeLog({ k: 'poke', step: ev.step, id: ev.id, by, cells: ev.cells, ...(ch ? { sig: ch.sig, side: ch.side, sol: ch.sol } : {}) });
      broadcast({ t: 'poke', ...item });
    } else if (ev.type === 'tug') {
      const it = findItem(ev.id); if (it) it.result = ev.result;
      broadcast({ t: 'tugresult', id: ev.id, a: ev.a, b: ev.b, by, result: ev.result });
      board.addTug({ id: ev.id, a: ev.a, b: ev.b, by, result: ev.result });
      broadcast({ t: 'board', board: board.snapshot() });
    } else if (ev.type === 'done') {
      const it = findItem(ev.id); if (it) it.summary = ev.summary;
      writeLog({ k: 'done', step: ev.step, id: ev.id, summary: ev.summary });
      broadcast({ t: 'done', id: ev.id, step: ev.step, summary: ev.summary });
      const coin = spawnPokes.get(ev.id);
      if (coin) { spawnPokes.delete(ev.id); spawn.addReaction(coin, ev.summary.peak); }
      if (ev.kind === 'say' && it && !ev.summary.pokes) {   // only undisturbed runs are ranked
        const r = board.add({ id: ev.id, text: it.text, by: it.by, peak: ev.summary.peak, ts: it.ts });
        if (r.changed) broadcast({ t: 'board', board: board.snapshot() });
        if (r.record) broadcast({ t: 'record', scope: r.record, entry: { id: ev.id, text: it.text, by: it.by, peak: ev.summary.peak } });
      }
    }
  }

  function pushFeed(item) {
    feed.push(item);
    if (item.kind === 'poke' && feed.filter((f) => f.kind === 'poke').length > FEED_POKES) feed.splice(feed.findIndex((f) => f.kind === 'poke'), 1);
    while (feed.length > L.feedSize) feed.shift();
  }

  const publicProof = (e) => e && { n: e.n, log: e.log, proof: e.proof, from: e.from, to: e.to, fromTs: e.fromTs, toTs: e.toTs, events: e.events, logSha256: e.logSha256, chainSha256: e.chainSha256, prev: e.prev, ots: e.ots };
  const proofUpdate = () => broadcast({ t: 'proof', proof: { head: publicProof(ledger.proofs(1)[0]) || null, chain: ledger.chainLength } });
  if (dataDir) {
    ledger = createLedger({
      dir: dataDir, worm, wiringSha256: wiringHash, transmittersSha256: txHash, chunkMs: config.chunkMinutes * 60e3, ots: config.ots ? ots : null,
      onSealed: () => proofUpdate(), onUpgraded: () => proofUpdate(),
    });
  }

  /* ---------- the launch and the token's trades ---------- */
  let trades = null;
  const tradeStats = { received: 0, used: 0, dropped: 0, lastAt: null };
  const tradeLimiter = new RateLimiter({ ratePerSec: config.token.tradesPerSecond, burst: 3 });
  const segOf = (i) => D.segs[D.n[i][3]];
  const headTouch = worm.roles.touch.filter((i) => ['episphere', 'segment_0', 'segment_1'].includes(segOf(i)));
  const tailTouch = worm.roles.touch.filter((i) => ['segment_2', 'segment_3', 'pygidium'].includes(segOf(i)));
  const launch = dataDir ? createLaunch({
    dir: dataDir, worm, D, writeLog, render, solana, publicUrl: config.publicUrl, pinataJwt: config.token.pinataJwt,
    onChange: (st) => broadcast({ t: 'launch', launch: st }),
    onLaunched: (l) => startTrades(l.mint),
  }) : null;
  const tokenMint = () => config.token.mint || (launch && launch.mint) || '';
  let lab = null;

  // SPAWN, the launchpad: coins priced in SOL, and in $BRAINWORM once it exists (server/spawn.js). A buy of one pokes the worm at that coin's
  // own spot: three touch cells picked from the coin's address, the same for every buy of it. The mapping is ours;
  // the worm has no idea what a coin is. Each poke is logged with its transaction.
  const spawnPokes = new Map();   // poke id -> the coin's mint, to credit the cells it lit
  const spawnStats = { received: 0, used: 0, dropped: 0, lastAt: null };
  const spawnLimiter = new RateLimiter({ ratePerSec: config.token.tradesPerSecond, burst: 3 });
  function spawnSpot(mint) {
    const h = crypto.createHash('sha256').update(mint).digest(), t = worm.roles.touch, cells = [];
    for (let k = 0; cells.length < 3 && k < h.length; k++) { const c = t[h[k] % t.length]; if (!cells.includes(c)) cells.push(c); }
    return cells;
  }
  function onSpawnTrade(t) {
    if (t.side !== 'buy') return;
    spawnStats.received++; spawnStats.lastAt = Date.now();
    if (!spawnLimiter.take('spawn') || worm.tugPlaying || mod.pokesPaused) { spawnStats.dropped++; return; }
    const sym = /^[A-Z0-9]{1,10}$/.test(t.symbol || '') && checkMessage(t.symbol, blocklist()).ok ? t.symbol : 'COIN';
    const id = newId('s'), info = { sig: t.signature, side: 'buy', sol: Math.round(t.sol * 10000) / 10000 };
    chainInfo.set(id, info); spawnPokes.set(id, t.mint);
    if (!worm.poke(id, spawnSpot(t.mint), { by: `spawn:$${sym}` })) { chainInfo.delete(id); spawnPokes.delete(id); spawnStats.dropped++; return; }
    spawnStats.used++;
    if (spawnPokes.size > 2000) for (const k of spawnPokes.keys()) { spawnPokes.delete(k); if (spawnPokes.size < 1000) break; }
  }
  const coinWorms = createCoinWorms({ dir: dataDir, D, render });
  const hatchLimiter = new RateLimiter({ ratePerSec: 2, burst: 12 }), hatched = new Map();   // the spawn form's previews, kept
  const spawn = createSpawn({
    dir: dataDir, dbc: config.spawnDeps?.dbc || dbc, rootMint: tokenMint, fetchImpl: config.spawnDeps?.fetchImpl || fetch, coinWorms, render, D,
    moderate: (t) => checkMessage(t, blocklist()), onTrade: onSpawnTrade,
    opts: {
      rpc: config.token.solanaRpc, ws: config.spawnDeps ? config.spawnDeps.ws || null : config.token.solanaWs, WebSocketImpl: config.spawnDeps?.WebSocketImpl, publicUrl: config.publicUrl,
      pinataJwt: config.token.pinataJwt, uploadPinata: config.spawnDeps?.uploadPinata || solana.uploadPinataMetadata, jupiterKey: config.token.jupiterKey, owner: config.spawn.owner, localMeta: config.spawn.localMeta,
    },
  });

  // A trade becomes a poke: buys at the head end, sells at the tail end, the touch cells picked from
  // the transaction signature's bytes. Big buys also flash light across the eyes. The mapping is ours;
  // the worm has no idea what a trade is. Every one is logged with its signature.
  function onTrade(t) {
    tradeStats.received++; tradeStats.lastAt = Date.now();
    if (!tradeLimiter.take('chain') || worm.tugPlaying || mod.pokesPaused) { tradeStats.dropped++; return; }
    let bytes; try { bytes = solana.b58decode(t.signature); } catch { tradeStats.dropped++; return; }
    const pool = t.side === 'sell' ? tailTouch : headTouch, cells = [];
    for (let k = 0; cells.length < 3 && k < bytes.length; k++) { const c = pool[bytes[k] % pool.length]; if (!cells.includes(c)) cells.push(c); }
    const by = `chain:${t.side}`, info = { sig: t.signature, side: t.side, sol: Math.round(t.sol * 10000) / 10000 };
    const id = newId('c');
    chainInfo.set(id, info);
    if (!worm.poke(id, cells, { by })) { chainInfo.delete(id); tradeStats.dropped++; return; }
    tradeStats.used++;
    if (t.side === 'buy' && t.sol >= config.token.bigBuySol && worm.queue.length < L.maxQueue) {
      const fid = newId('c');
      chainInfo.set(fid, info);
      const ahead = worm.say(fid, '█', { by });
      pushFeed({ id: fid, kind: 'say', by, text: '█', step: null, ts: Date.now(), chain: info });
      broadcast({ t: 'queued', id: fid, by, text: '█', ahead, chain: info });
    }
    if (chainInfo.size > 5000) for (const k of chainInfo.keys()) { chainInfo.delete(k); if (chainInfo.size < 2500) break; }
  }
  function startTrades(mint) {
    if (!mint || trades) return;
    if (config.tradeStreamFactory) { trades = config.tradeStreamFactory({ mint, onTrade }); trades.start(); return; }   // tests
    trades = config.token.pumpportalKey || !solana.createRpcTradeStream
      ? solana.createTradeStream({ mint, onTrade, apiKey: config.token.pumpportalKey })
      : solana.createRpcTradeStream({ mint, onTrade, url: config.token.solanaWs });
    trades.start();
  }
  const siteInfo = () => {
    const mint = tokenMint();
    const links = [...config.site.links];
    if (mint && !config.site.contract) links.unshift({ label: 'pump.fun', url: `https://pump.fun/coin/${mint}` }, { label: 'Solscan', url: `https://solscan.io/token/${mint}` });
    return { ...config.site, ticker: config.site.ticker || '$BRAINWORM', contract: config.site.contract || mint, chain: config.site.chain || (mint ? 'Solana' : ''), links, txUrl: config.token.txUrl };
  };

  /* ---------- streaming ---------- */
  let lastWasRest = false;
  const frameBuffer = () => { const b = worm.body.state; const f = encodeFrame(worm.sim.r, worm.step, [...b.p, ...b.q, b.dist]); return Buffer.from(f.buffer, f.byteOffset, f.byteLength); };
  function sendFrame() {
    const buf = frameBuffer();   // a fresh buffer per frame, shared by every viewer
    for (const ws of clients) if (ws.readyState === OPEN && ws.bufferedAmount < MAX_BUFFERED) ws.send(buf, { binary: true, compress: false });
  }
  function broadcast(msg) {
    if (!clients.size) return;
    const s = JSON.stringify(msg);
    for (const ws of clients) if (ws.readyState === OPEN) ws.send(s);
  }

  let nextStepAt = 0, timer = null, sweepTimer = null;
  const trail = [];
  function loop() {
    const now = performance.now();
    let n = 0;
    while (now >= nextStepAt && n < 5 * (config.speed || 1)) {
      worm.tick();
      nextStepAt += stepMs; n++;
      if (worm.step % TRAIL_EVERY === 0) { const p = worm.body.state.p; trail.push([+p[0].toFixed(1), +p[1].toFixed(1), +p[2].toFixed(1)]); if (trail.length > TRAIL_POINTS) trail.shift(); }
      const resting = worm.last.nAct === 0 && !worm.current;
      if (clients.size && (resting ? (!lastWasRest || worm.step % REST_FRAME_EVERY === 0) : worm.step % FRAME_EVERY === 0)) {
        sendFrame();
        lastWasRest = resting;
      }
      if (ledger) ledger.maybeCut();
      if (launch) launch.onStep();
      if (worm.step % SYNC_EVERY === 0) sendSync();
    }
    if (now - nextStepAt > 1000) nextStepAt = now; // after a stall, don't try to catch up
  }

  // Live verification: a browser that asks gets the worm's exact state, then every stimulus as it
  // happens (the normal broadcasts) and, once a second, the hash of the server's state. It runs its
  // own copy and compares. Hashing costs well under a millisecond.
  const verifiers = new Set();
  function sendSync() {
    if (!verifiers.size) return;
    const sha = crypto.createHash('sha256').update(stateString(worm)).digest('hex');
    const s = JSON.stringify({ t: 'sync', step: worm.step, sha });
    for (const ws of verifiers) if (ws.readyState === OPEN) ws.send(s);
  }

  // an honest clock: how fast the simulation actually ran over the last few seconds
  const clock = { sps: STEPS_PER_SECOND, at: performance.now(), step: 0 };
  const clockTimer = setInterval(() => {
    const t = performance.now(), dt = (t - clock.at) / 1000;
    if (dt > 0) clock.sps = Math.round(((worm.step - clock.step) / dt) * 10) / 10;
    clock.at = t; clock.step = worm.step;
    broadcast({ t: 'clock', sps: clock.sps, step: worm.step, pokes: stats.poke.lastMinute(), messages: stats.say.lastMinute() });
  }, 5000);
  clockTimer.unref?.();

  /* ---------- stimuli from anyone ---------- */
  const ipMsg = new RateLimiter({ ratePerSec: L.messagesPerMinutePerIp / 60, burst: 6 });
  const ipPoke = new RateLimiter({ ratePerSec: L.pokesPerSecondPerIp, burst: 10 });
  const ipTug = new RateLimiter({ ratePerSec: L.tugsPerHourPerIp / 3600, burst: 2 });
  const ipLamp = new RateLimiter({ ratePerSec: L.lampsPerHourPerIp / 3600, burst: 2 });
  const globalPoke = new RateLimiter({ ratePerSec: L.pokesPerSecondGlobal, burst: L.pokesPerSecondGlobal });
  const twitchMsg = new RateLimiter({ ratePerSec: 6 / 60, burst: 2 });
  const globalMsg = new RateLimiter({ ratePerSec: L.messagesPerSecondGlobal, burst: L.messagesPerSecondGlobal * 2 });
  const ipConnRate = new RateLimiter({ ratePerSec: L.connectionsPerMinutePerIp / 60, burst: Math.max(5, L.connectionsPerMinutePerIp / 2) });
  const newConns = new Counter();
  // the puzzle gets harder when connections spike (a flood of new sockets is what bots look like)
  const powBits = () => { if (!config.pow.bits) return 0; const n = newConns.lastMinute(); return config.pow.bits + (n > 600 ? 2 : 0) + (n > 2000 ? 2 : 0); };
  const powOk = (challenge, bits, nonce) => {
    if (!Number.isSafeInteger(nonce) || nonce < 0) return false;
    const h = crypto.createHash('sha256').update(`${challenge}:${nonce}`).digest();
    let z = 0;
    for (const byte of h) { if (byte === 0) { z += 8; continue; } z += Math.clz32(byte) - 24; break; }
    return z >= bits;
  };
  const lastSay = new Map();
  let idCounter = 0;
  const newId = (p) => p + (++idCounter).toString(36) + crypto.randomBytes(2).toString('hex');
  const reject = (code, message) => { stats.rejected.hit(); return { ok: false, code, message }; };

  // A sender is {key (for mutes), by (shown), takeMsg(), takePoke(), takeTug()}.
  function trySay(s, text) {
    const now = Date.now();
    if (mod.chatPaused) return reject('paused', 'Chat is paused by the mods for a moment.');
    if (mod.isBanned(s.key, now)) return reject('muted', 'You are muted for now.');
    if (mod.slowSec && now - (lastSay.get(s.key) || 0) < mod.slowSec * 1000) return reject('slow', `Slow mode is on: one message every ${mod.slowSec}s.`);
    if (!s.takeMsg()) return reject('slow', 'Slow down: one message every few seconds.');
    if (worm.queue.length >= L.maxQueue || !globalMsg.take('all')) return reject('busy', 'The worm has a queue. Try again in a few seconds.');
    const c = checkMessage(text, blocklist());
    if (!c.ok) return reject(c.code, c.message);
    lastSay.set(s.key, now);
    const id = newId('m');
    senderOf.set(id, { key: s.key, label: s.by });
    const ahead = worm.say(id, c.text, { by: s.by });
    pushFeed({ id, kind: 'say', by: s.by, text: c.text, step: null, ts: now });
    broadcast({ t: 'queued', id, by: s.by, text: c.text, ahead });
    stats.say.hit(now);
    return { ok: true, id };
  }

  function tryTug(s, a, b) {
    const now = Date.now();
    if (mod.chatPaused) return reject('paused', 'Chat is paused by the mods for a moment.');
    if (mod.isBanned(s.key, now)) return reject('muted', 'You are muted for now.');
    const words = [];
    for (const w of [a, b]) {
      const c = checkMessage(typeof w === 'string' ? w : '', blocklist());
      if (!c.ok) return reject(c.code, c.code === 'empty' ? 'Type two words.' : c.message);
      if ([...c.text].length > TUG_WORD_MAX) return reject('long', `Tug words are ${TUG_WORD_MAX} characters at most.`);
      words.push(c.text);
    }
    if (worm.queue.filter((m) => m.kind === 'tug').length >= L.maxTugsQueued) return reject('busy', 'A tug is already waiting. Try again once it starts.');
    if (worm.queue.length >= L.maxQueue) return reject('busy', 'The worm has a queue. Try again in a few seconds.');
    if (!s.takeTug()) return reject('slow', 'You started a tug recently. Give it a few minutes.');
    if (!globalMsg.take('all')) return reject('busy', 'The worm has a queue. Try again in a few seconds.');
    const id = newId('t');
    senderOf.set(id, { key: s.key, label: s.by });
    const ahead = worm.tug(id, words[0], words[1], { by: s.by });
    pushFeed({ id, kind: 'tug', by: s.by, a: words[0], b: words[1], step: null, ts: now });
    broadcast({ t: 'tugqueued', id, by: s.by, a: words[0], b: words[1], ahead });
    stats.say.hit(now);
    return { ok: true, id };
  }

  // a lamp is lit in a random direction from the worm when its turn comes (the direction is logged)
  function tryLamp(s) {
    const now = Date.now();
    if (mod.chatPaused) return reject('paused', 'Chat is paused by the mods for a moment.');
    if (mod.isBanned(s.key, now)) return reject('muted', 'You are muted for now.');
    if (worm.queue.filter((m) => m.kind === 'lamp').length >= L.maxLampsQueued) return reject('busy', 'A lamp is already waiting. Try again once it\'s lit.');
    if (worm.queue.length >= L.maxQueue) return reject('busy', 'The worm has a queue. Try again in a few seconds.');
    if (!s.takeLamp()) return reject('slow', 'You lit a lamp recently. Give it a few minutes.');
    if (!globalMsg.take('all')) return reject('busy', 'The worm has a queue. Try again in a few seconds.');
    const g = () => { const u = crypto.randomBytes(4).readUInt32LE() / 4294967296, v = crypto.randomBytes(4).readUInt32LE() / 4294967296; return Math.sqrt(-2 * Math.log(u || 1e-12)) * Math.cos(2 * Math.PI * v); };
    const dir = [g(), g(), g()].map((x) => Math.round(x * 1e6) / 1e6);
    const id = newId('l');
    senderOf.set(id, { key: s.key, label: s.by });
    const ahead = worm.lamp(id, dir, { by: s.by });
    if (ahead < 0) { senderOf.delete(id); return reject('bad', 'Try again.'); }
    pushFeed({ id, kind: 'lamp', by: s.by, step: null, ts: now });
    broadcast({ t: 'lampqueued', id, by: s.by, ahead });
    stats.say.hit(now);
    return { ok: true, id };
  }

  function tryPoke(s, cells) {
    if (mod.pokesPaused) return reject('paused', 'Pokes are paused by the mods for a moment.');
    if (mod.isBanned(s.key)) return reject('muted', 'You are muted for now.');
    if (!s.takePoke() || !globalPoke.take('all')) return { ok: false, code: 'slow', quiet: true };
    if (worm.tugPlaying) return reject('tug', 'Pokes are off while a tug plays, so nobody can push it one way.');
    const id = newId('p');
    senderOf.set(id, { key: s.key, label: s.by });
    const used = worm.poke(id, Array.isArray(cells) ? cells.slice(0, 12) : [], { by: s.by });
    if (!used) { senderOf.delete(id); return { ok: false, code: 'bad', quiet: true }; }
    stats.poke.hit();
    return { ok: true, id };
  }

  function hide(id) {
    const i = feed.findIndex((f) => f.id === id);
    if (i >= 0) feed.splice(i, 1);
    const q = worm.queue.findIndex((m) => m.id === id);   // not started yet: it never plays and is never logged
    if (q >= 0) worm.queue.splice(q, 1);
    broadcast({ t: 'hide', id });
    if (board.remove((e) => e.id === id)) broadcast({ t: 'board', board: board.snapshot() });
    return i >= 0 || q >= 0;
  }

  // senderOf only needs to remember recent stimuli
  function pruneSenders() {
    if (senderOf.size < 5000) return;
    const keep = new Set(feed.map((f) => f.id).concat(worm.queue.map((m) => m.id)));
    for (const id of senderOf.keys()) { if (senderOf.size < 2500) break; if (!keep.has(id)) senderOf.delete(id); }
  }

  /* ---------- Twitch chat ---------- */
  let twitch = null;
  if (config.twitch.channel) {
    const tw = (u) => ({
      key: 'tw:' + u.login, by: 'twitch:' + (u.name || u.login),
      takeMsg: () => twitchMsg.take(u.login), takePoke: () => ipPoke.take('tw:' + u.login), takeTug: () => false, takeLamp: () => false,
    });
    twitch = createTwitchBridge({
      channel: config.twitch.channel, sayPrefix: config.twitch.sayPrefix,
      onSay: (u, text) => { trySay(tw(u), text); },
      onPoke: (u) => {
        const t = worm.roles.touch, k = crypto.randomInt(t.length);
        tryPoke(tw(u), [t[k], t[(k + 1) % t.length], t[(k + 2) % t.length]]);
      },
    });
  }

  /* ---------- live connections ---------- */
  const connsPerIp = new Map();
  function clientIp(req) {
    if (config.trustProxy) {
      const xf = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
      if (xf) return xf;
    }
    return req.socket.remoteAddress || 'unknown';
  }

  const httpServer = http.createServer(handleHttp);
  const wss = new WebSocketServer({
    server: httpServer,
    path: '/live',
    maxPayload: 2048,
    perMessageDeflate: false,   // frames are already compact; per-viewer compression costs CPU and memory
    verifyClient: ({ origin }) => !config.allowedOrigins.length || config.allowedOrigins.includes(origin),
  });

  let watchersTimer = null;
  const announceWatchers = () => {
    if (watchersTimer) return;
    watchersTimer = setTimeout(() => { watchersTimer = null; broadcast({ t: 'watchers', n: clients.size }); }, 400);
  };

  function currentPublic() {
    const st = worm.status();
    const pub = (m) => (m.kind === 'tug' ? { kind: 'tug', id: m.id, a: m.a, b: m.b, by: m.meta.by }
      : m.kind === 'lamp' ? { kind: 'lamp', id: m.id, by: m.meta.by, ...(m.pos ? { pos: m.pos } : {}) }
        : { kind: 'say', id: m.id, text: m.text, by: m.meta.by });
    return { current: st.current && { ...pub(st.current), startStep: st.current.startStep }, queue: st.queue.map(pub) };
  }

  wss.on('connection', (ws, req) => {
    const ip = clientIp(req);
    const count = (connsPerIp.get(ip) || 0) + 1;
    if (count > L.maxConnectionsPerIp || !ipConnRate.take(ip)) { ws.close(1013, 'Too many connections from this address'); return; }
    newConns.hit();
    const bits = powBits();
    ws.pow = { challenge: crypto.randomBytes(12).toString('hex'), bits };
    ws.human = bits === 0;
    connsPerIp.set(ip, count);
    const key = ipKey(ip);
    const connMsg = new RateLimiter({ ratePerSec: L.messagesPerMinute / 60, burst: 2 });
    const connPoke = new RateLimiter({ ratePerSec: L.pokesPerSecond, burst: 3 });
    ws.handle = makeHandle();
    const sender = {
      key, by: ws.handle,
      takeMsg: () => connMsg.take('c') && ipMsg.take(key),
      takePoke: () => connPoke.take('c') && ipPoke.take(key),
      takeTug: () => connMsg.take('c') && ipTug.take(key),
      takeLamp: () => connMsg.take('c') && ipLamp.take(key),
    };
    clients.add(ws);
    const { current, queue } = currentPublic();
    ws.send(JSON.stringify({
      t: 'hello', v: LOG_VERSION, you: ws.handle, step: worm.step, watchers: clients.size, feed, current, queue, pow: { challenge: ws.pow.challenge, bits: ws.pow.bits }, trail: trail.flat(),
      mod: mod.publicState(), board: board.snapshot(), clock: { sps: clock.sps }, launch: launch ? launch.status() : null,
      proof: ledger ? { head: publicProof(ledger.proofs(1)[0]) || null, chain: ledger.chainLength } : null,
      twitch: twitch ? { channel: twitch.status().channel, prefix: config.twitch.sayPrefix } : null,
    }));
    ws.send(frameBuffer(), { binary: true, compress: false });
    announceWatchers();

    ws.on('message', (data, isBinary) => {
      if (isBinary) return;
      let msg; try { msg = JSON.parse(String(data)); } catch { return; }
      if (!msg || typeof msg !== 'object') return;
      let r = null;
      if (msg.t === 'pow') {
        if (!ws.human && powOk(ws.pow.challenge, ws.pow.bits, msg.nonce)) { ws.human = true; reply(ws, { t: 'pow-ok' }); }
        return;
      }
      if ((msg.t === 'say' || msg.t === 'tug' || msg.t === 'poke' || msg.t === 'lamp') && !ws.human) {
        if (msg.t !== 'poke') reply(ws, { t: 'error', code: 'pow', message: 'One moment: your browser is still getting ready.' });
        return;
      }
      if (msg.t === 'verify') {
        if (ws.verifying) return;       // the state is sent once per connection
        ws.verifying = true;
        verifiers.add(ws);
        ws.send(JSON.stringify({ t: 'state', step: worm.step, state: JSON.parse(stateString(worm)) }));
        return;
      }
      if (msg.t === 'say') r = trySay(sender, msg.text);
      else if (msg.t === 'tug') r = tryTug(sender, msg.a, msg.b);
      else if (msg.t === 'lamp') r = tryLamp(sender);
      else if (msg.t === 'poke') r = tryPoke(sender, msg.cells);
      if (r && !r.ok && !r.quiet) reply(ws, { t: 'error', code: r.code, message: r.message });
      pruneSenders();
    });
    ws.on('close', () => {
      clients.delete(ws); verifiers.delete(ws);
      const c = (connsPerIp.get(ip) || 1) - 1;
      if (c <= 0) connsPerIp.delete(ip); else connsPerIp.set(ip, c);
      announceWatchers();
    });
    ws.on('error', () => {});
  });
  const reply = (ws, o) => { if (ws.readyState === OPEN) ws.send(JSON.stringify(o)); };

  /* ---------- http ---------- */
  const statics = createStatic(
    { '/shared/': path.join(ROOT, 'shared'), '/data/': path.join(ROOT, 'data'), '/': path.join(ROOT, 'public') },
    { transformHtml: (html) => html.replaceAll('%ORIGIN%', config.publicUrl), maxAge: { '.json': 'public, max-age=3600', '.png': 'public, max-age=86400', '.bin': 'public, max-age=86400' } },
  );

  function securityHeaders(res) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    res.setHeader('Content-Security-Policy', [
      "default-src 'self'", "script-src 'self'", "style-src 'self' https://fonts.googleapis.com",
      "font-src https://fonts.gstatic.com", `img-src 'self' data: blob: ${IMG_ORIGINS}`, "media-src 'self' blob:",
      "connect-src 'self' ws: wss:", "frame-ancestors 'none'", "base-uri 'none'", "form-action 'self'",
    ].join('; '));
  }
  const json = (res, code, o) => { res.writeHead(code, { 'Content-Type': MIME['.json'], 'Cache-Control': 'no-store' }); res.end(JSON.stringify(o)); };
  const notFound = (res) => { res.writeHead(404, { 'Content-Type': MIME['.txt'] }); res.end('Not found'); };

  function isAdmin(req) {
    if (!config.adminToken) return false;
    const got = Buffer.from(String(req.headers.authorization || ''));
    const want = Buffer.from('Bearer ' + config.adminToken);
    return got.length === want.length && crypto.timingSafeEqual(got, want);
  }

  function adminState() {
    return {
      ok: true, watchers: clients.size, queue: worm.queue.length, step: worm.step, uptimeSec: Math.round((Date.now() - startedAt) / 1000),
      ...mod.publicState(), bans: mod.banList(), blocklist: { base: fileBlocklist.length, extra: mod.extra },
      twitch: twitch ? twitch.status() : { enabled: false },
      trades: trades ? { ...trades.status(), ...tradeStats, mint: tokenMint() } : { enabled: false, mint: tokenMint() },
      launch: launch ? launch.status() : null,
      spawn: { ...spawn.status(), trades: spawnStats },
      stats: { messagesLastMin: stats.say.lastMinute(), pokesLastMin: stats.poke.lastMinute(), rejectedLastMin: stats.rejected.lastMinute() },
      feed,
    };
  }
  const modChanged = () => broadcast({ t: 'mod', ...mod.publicState() });

  function handleAdmin(req, res, p, q) {
    if (!isAdmin(req)) return json(res, 404, { error: 'not found' });
    if (p === '/admin/state' && req.method === 'GET') return json(res, 200, adminState());
    if (req.method !== 'POST') return json(res, 404, { error: 'not found' });
    const flag = (k) => (q.has(k) ? q.get(k) === '1' || q.get(k) === 'true' : null);
    switch (p) {
      case '/admin/clear':
        feed.length = 0; broadcast({ t: 'feed', feed }); return json(res, 200, { ok: true });
      case '/admin/hide':
        return json(res, 200, { ok: hide(q.get('id')) });
      case '/admin/ban': {
        const s = senderOf.get(q.get('id'));
        if (!s) return json(res, 200, { ok: false, error: 'That item is too old to trace. Hide it instead.' });
        const hours = Math.max(0.1, Math.min(24 * 30, Number(q.get('hours')) || 24));
        mod.ban(s.key, s.label, hours, q.get('reason') || '');
        for (const [id, o] of senderOf) if (o.key === s.key) hide(id);
        if (board.remove((e) => e.by === s.label)) broadcast({ t: 'board', board: board.snapshot() });
        return json(res, 200, { ok: true, key: s.key, label: s.label });
      }
      case '/admin/unban':
        return json(res, 200, { ok: mod.unban(q.get('key')) });
      case '/admin/pause': {
        const chat = flag('chat'), pokes = flag('pokes');
        if (chat !== null) mod.chatPaused = chat;
        if (pokes !== null) mod.pokesPaused = pokes;
        mod.save(); modChanged();
        return json(res, 200, { ok: true, chatPaused: mod.chatPaused, pokesPaused: mod.pokesPaused });
      }
      case '/admin/slowmode':
        mod.slowSec = Math.max(0, Math.min(3600, Math.round(Number(q.get('sec')) || 0)));
        mod.save(); modChanged();
        return json(res, 200, { ok: true, slowSec: mod.slowSec });
      case '/admin/announce': {
        const text = String(q.get('text') || '').normalize('NFKC').replace(/[\u0000-\u001F\u007F-\u009F]/g, '').replace(/\s+/g, ' ').trim().slice(0, 80);
        if (!text) { mod.announce = null; mod.save(); modChanged(); return json(res, 200, { ok: true }); }
        const scam = findScam(text);
        if (scam) return json(res, 200, { ok: false, error: scam.message });
        const minutes = Math.max(1, Math.min(24 * 60, Number(q.get('minutes')) || 15));
        mod.announce = { text, until: Date.now() + minutes * 60e3 };
        mod.save(); modChanged();
        return json(res, 200, { ok: true });
      }
      case '/admin/blocklist/add': {
        const phrase = String(q.get('phrase') || '').toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 60);
        if (phrase && !mod.extra.includes(phrase)) { mod.extra.push(phrase); mod.save(); }
        return json(res, 200, { ok: true, extra: mod.extra });
      }
      case '/admin/blocklist/remove': {
        const phrase = String(q.get('phrase') || '').toLowerCase().trim();
        mod.extra = mod.extra.filter((x) => x !== phrase); mod.save();
        return json(res, 200, { ok: true, extra: mod.extra });
      }
      case '/admin/launch/arm': case '/admin/launch/disarm': case '/admin/launch/metadata': case '/admin/launch/prepare': case '/admin/launch/confirm': {
        if (!launch) return json(res, 200, { ok: false, error: 'The launch needs a data folder (LOG_DIR).' });
        const act = p.slice('/admin/launch/'.length);
        const run = async () => {
          if (act === 'arm') { launch.arm(); return { ok: true, launch: launch.status() }; }
          if (act === 'disarm') { launch.disarm(); return { ok: true, launch: launch.status() }; }
          if (act === 'metadata') return { ok: true, metadata: await launch.uploadMetadata({ twitter: q.get('twitter') || '', telegram: q.get('telegram') || '', website: q.get('website') || config.publicUrl }) };
          if (act === 'prepare') {
            const creator = String(q.get('creator') || '');
            if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(creator)) throw new Error('That is not a Solana address.');
            return { ok: true, ...(await launch.prepare({ creator, amountSol: Math.max(0, Number(q.get('amountSol')) || 0) })) };
          }
          return await launch.confirm({ signature: String(q.get('signature') || ''), url: config.token.solanaRpc });
        };
        run().then((r) => json(res, 200, r)).catch((e) => json(res, 200, { ok: false, error: e.message }));
        return;
      }
      case '/admin/spawn/price': case '/admin/spawn/config': case '/admin/spawn/confirm': case '/admin/spawn/claim': case '/admin/spawn/claim-graduated': case '/admin/spawn/claim-sol': case '/admin/spawn/buyback': case '/admin/spawn/burn-claimed': case '/admin/spawn/burned': {
        const act = p.slice('/admin/spawn/'.length), feeClaimer = q.get('feeClaimer') || '';
        const run = async () => {
          if (act === 'price') return { ok: true, price: await spawn.rootPrice() };
          if (act === 'config') return { ok: true, ...(await spawn.buildConfig({ partner: q.get('partner') || '', startMcap: q.get('startMcap'), graduationMcap: q.get('graduationMcap'), quote: q.get('quote') || undefined })) };
          if (act === 'confirm') return await spawn.confirmConfig({ signature: q.get('signature') || '' });
          if (act === 'claim') return { ok: true, txs: await spawn.buildClaimAndBurn({ feeClaimer }) };
          if (act === 'claim-graduated') return { ok: true, txs: await spawn.buildClaimGraduated({ feeClaimer }) };
          if (act === 'claim-sol') return { ok: true, txs: await spawn.buildClaimSol({ feeClaimer }) };
          if (act === 'buyback') return { ok: true, ...(await spawn.buyback({ feeClaimer })) };
          if (act === 'burn-claimed') return { ok: true, ...(await spawn.burnClaimed({ signature: q.get('signature') || '', buyback: flag('buyback') === true })) };
          return await spawn.burned({ signature: q.get('signature') || '' });
        };
        run().then((r) => json(res, 200, r)).catch((e) => json(res, 200, { ok: false, error: e.message }));
        return;
      }
      case '/admin/reload-blocklist':
        fileBlocklist = loadBlocklist(path.resolve(ROOT, config.blocklistFile));
        return json(res, 200, { ok: true, entries: fileBlocklist.length + mod.extra.length });
      default:
        return json(res, 404, { error: 'not found' });
    }
  }

  function sendFile(req, res, file, type, cache, download = null) {
    fs.stat(file, (err, st) => {
      if (err || !st.isFile()) return json(res, 404, { error: 'not found' });
      const h = { 'Content-Type': type, 'Cache-Control': cache, 'Content-Length': st.size };
      if (download) h['Content-Disposition'] = `attachment; filename="${download}"`;
      res.writeHead(200, h);
      if (req.method === 'HEAD') return res.end();
      fs.createReadStream(file).pipe(res);
    });
  }

  // SPAWN's endpoints build transactions for people's own wallets; each has its own budget per address
  const spawnLimits = {
    quote: new RateLimiter({ ratePerSec: 0.5, burst: 12 }), swap: new RateLimiter({ ratePerSec: 0.2, burst: 6 }),
    create: new RateLimiter({ ratePerSec: 6 / 3600, burst: 3 }), created: new RateLimiter({ ratePerSec: 0.3, burst: 6 }), claim: new RateLimiter({ ratePerSec: 0.2, burst: 4 }),
    confirm: new RateLimiter({ ratePerSec: 1, burst: 40 }),
  };
  const spawnCreateAll = new RateLimiter({ ratePerSec: 60 / 3600, burst: 10 });   // pictures are uploaded before anyone signs
  function readJson(req, limit) {
    return new Promise((resolve, reject) => {
      let size = 0; const chunks = [];
      req.on('data', (c) => { size += c.length; if (size > limit) { reject(new Error('That is too big.')); req.destroy(); } else chunks.push(c); });
      req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch { reject(new Error('Bad request.')); } });
      req.on('error', reject);
    });
  }
  function handleSpawnPost(req, res, p) {
    const act = p.slice('/spawn/'.length), lim = spawnLimits[act];
    if (!lim) return json(res, 404, { error: 'not found' });
    if (config.allowedOrigins.length && req.headers.origin && !config.allowedOrigins.includes(req.headers.origin)) return json(res, 403, { error: 'Wrong origin.' });
    if (!lim.take(clientIp(req)) || (act === 'create' && !spawnCreateAll.take('all'))) return json(res, 429, { error: 'Slow down a little and try again.' });
    readJson(req, act === 'create' ? 2_600_000 : 4096).then((b) => {
      if (!b || typeof b !== 'object') throw new Error('Bad request.');
      if (act === 'quote') return spawn.quote(b);
      if (act === 'swap') return spawn.swap(b);
      if (act === 'create') return spawn.create(b);
      if (act === 'claim') return spawn.claimCreator(b);
      if (act === 'confirm') return spawn.confirm(b);
      return { ok: spawn.created(b) };
    }).then((r) => json(res, 200, r)).catch((e) => json(res, 400, { error: e.message }));
  }

  // plain HTTP gets a generous per-address budget too (a page load is ~25 requests)
  const httpLimiter = new RateLimiter({ ratePerSec: 20, burst: 80 });
  function handleHttp(req, res) {
    securityHeaders(res);
    if (!httpLimiter.take(clientIp(req))) { res.writeHead(429, { 'Retry-After': '5', 'Content-Type': MIME['.txt'] }); return res.end('Too many requests'); }
    const url = new URL(req.url, 'http://x');
    let p;
    try { p = decodeURIComponent(url.pathname); } catch { res.writeHead(400); return res.end(); }

    if (p.startsWith('/admin/')) return handleAdmin(req, res, p, url.searchParams);
    if (p.startsWith('/spawn/') && req.method === 'POST') return handleSpawnPost(req, res, p);
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
    // the data is public: anyone may build on it
    if (/^\/(healthz|config\.json|board\.json|proof\.json|manifest\.json|lab\.json|log\/|proof\/|data\/|shared\/)/.test(p)) res.setHeader('Access-Control-Allow-Origin', '*');
    if (p === '/lab.json') return !lab ? json(res, 404, { state: 'off' }) : json(res, 200, lab.results() || lab.status());
    if (p === '/manifest.json') return json(res, 200, manifest);
    if (p === '/healthz') return json(res, 200, { ok: true, step: worm.step, watchers: clients.size, queue: worm.queue.length, v: LOG_VERSION });
    if (p === '/config.json') {
      return json(res, 200, {
        site: siteInfo(), params: PARAMS, wiringSha256: wiringHash, transmittersSha256: txHash, model: MODEL_V2.id, stepsPerSecond: STEPS_PER_SECOND,
        features: { ots: !!(ledger && config.ots), chunkMinutes: config.chunkMinutes, twitch: twitch ? twitch.status().channel : null, publicUrl: config.publicUrl, spawn: spawn.open, spawnQuote: spawn.quote },
        calibration,
      });
    }
    if (p === '/board.json') return json(res, 200, board.snapshot());
    if (p === '/proof.json') {
      if (!ledger) return json(res, 404, { error: 'logging is off' });
      return json(res, 200, { chain: ledger.proofs(48).map(publicProof), current: ledger.currentName, chunkMinutes: config.chunkMinutes, ots: config.ots });
    }
    if (p === '/log/current.jsonl') {
      if (!ledger) return json(res, 404, { error: 'logging is off' });
      return sendFile(req, res, ledger.currentPath, MIME['.jsonl'], 'no-store');
    }
    if (p === '/log/index.json') return ledger ? json(res, 200, { files: ledger.files() }) : json(res, 404, { error: 'logging is off' });
    if (p.startsWith('/log/')) {
      const name = p.slice(5), file = ledger && ledger.filePath(name);
      if (!file) return json(res, 404, { error: 'not found' });
      return sendFile(req, res, file, MIME['.jsonl'], name === ledger.currentName ? 'no-store' : 'public, max-age=31536000, immutable');
    }
    if (p.startsWith('/proof/')) {
      const name = p.slice(7), file = ledger && ledger.proofPath(name);
      if (!file) return json(res, 404, { error: 'not found' });
      return name.endsWith('.ots')
        ? sendFile(req, res, file, 'application/octet-stream', 'no-cache', name)
        : sendFile(req, res, file, MIME['.txt'], 'public, max-age=31536000, immutable');
    }
    if (p === '/proof') { res.writeHead(302, { Location: '/#proof' }); return res.end(); }
    if (p === '/launch/status.json') { res.setHeader('Access-Control-Allow-Origin', '*'); return launch ? json(res, 200, { ...launch.status(), description: launch.description() }) : json(res, 404, { error: 'off' }); }
    if (p === '/launch/moment.png') return launch ? sendFile(req, res, launch.imagePath, 'image/png', 'no-cache') : notFound(res);
    if (p === '/launch' || p === '/launch/') { res.setHeader('X-Robots-Tag', 'noindex'); return statics.serve(req, res, '/launch.html') || notFound(res); }
    if (p === '/spawn' || p === '/spawn/') return statics.serve(req, res, '/spawn.html') || notFound(res);
    if (p === '/spawn.json') { const send = () => json(res, 200, spawn.publicState()); spawn.fresh().then(send, send); return; }
    if (p.startsWith('/spawn/worm/')) {   // a coin's own worm: its record (to rebuild and check) and its portraits
      const m = /^\/spawn\/worm\/([1-9A-HJ-NP-Za-km-z]{32,44})(-birth)?\.(json|png)$/.exec(p);
      if (!m) return notFound(res);
      res.setHeader('Access-Control-Allow-Origin', '*');
      if (m[3] === 'json') { const r = coinWorms.publicRecord(m[1]); return r ? json(res, 200, r) : json(res, 404, { error: 'no worm for that coin' }); }
      const png = coinWorms.portrait(m[1], m[2] ? 'birth' : 'now');
      if (!png) return notFound(res);
      res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': m[2] ? 'public, max-age=31536000, immutable' : 'public, max-age=20', 'Content-Length': png.length });
      return res.end(req.method === 'HEAD' ? undefined : png);
    }
    if (p.startsWith('/spawn/hatch/')) {   // what a fresh worm makes of a ticker: the spawn form's preview
      const m = /^\/spawn\/hatch\/([A-Z0-9]{1,10})\.(json|png)$/.exec(p);
      if (!m) return notFound(res);
      let h = hatched.get(m[1]);
      if (!h) {
        if (!hatchLimiter.take(clientIp(req))) { res.writeHead(429, { 'Retry-After': '2', 'Content-Type': MIME['.txt'] }); return res.end('Too many requests'); }
        h = previewHatch({ D, render, ticker: m[1] });
        hatched.set(m[1], h);
        if (hatched.size > 300) hatched.delete(hatched.keys().next().value);
      }
      if (m[2] === 'json') return json(res, 200, { ticker: m[1], peak: h.peak });
      res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400', 'Content-Length': h.png.length });
      return res.end(req.method === 'HEAD' ? undefined : h.png);
    }
    if (p.startsWith('/spawn/meta/')) {
      const f = spawn.metaFile(p.slice('/spawn/meta/'.length));
      if (!f) return notFound(res);
      res.setHeader('Access-Control-Allow-Origin', '*');   // wallets and explorers read coin metadata from anywhere
      return sendFile(req, res, f, META_TYPES[path.extname(f)], 'public, max-age=31536000, immutable');
    }
    if (p === '/stream' || p === '/stream/') return statics.serve(req, res, '/index.html') || notFound(res);
    if (p === '/mod' || p === '/mod/') { res.setHeader('X-Robots-Tag', 'noindex'); return statics.serve(req, res, '/mod.html') || notFound(res); }
    if (statics.serve(req, res, p)) return;
    notFound(res);
  }

  return {
    worm, config, board, mod,
    get logPath() { return ledger ? ledger.currentPath : null; },
    get ledger() { return ledger; },
    listen(port = config.port, host = config.host) {
      return new Promise((resolve) => {
        nextStepAt = performance.now();
        timer = setInterval(loop, 5);
        sweepTimer = setInterval(() => { for (const l of [ipMsg, ipPoke, ipTug, ipLamp, twitchMsg, ipConnRate, httpLimiter, hatchLimiter, ...Object.values(spawnLimits)]) l.sweep(); }, 60_000);
        if (twitch) twitch.start();
        startTrades(tokenMint());
        spawn.start();
        if (config.lab && !lab) lab = startLab({ logDir: dataDir });
        httpServer.listen(port, host, () => resolve(httpServer.address()));
      });
    },
    async close() {
      clearInterval(timer); clearInterval(sweepTimer); clearTimeout(watchersTimer); clearInterval(clockTimer);
      // seal the log and save state first: on a redeploy the host may not wait long
      const sealed = ledger ? ledger.close() : null;
      board.flush();
      if (twitch) await twitch.stop();
      if (trades) await trades.stop();
      spawn.stop();
      coinWorms.stop();
      if (lab) await lab.stop();
      for (const ws of clients) ws.terminate();
      await new Promise((r) => wss.close(() => r()));
      await new Promise((r) => httpServer.close(() => r()));
      await sealed;
    },
  };
}

// Run directly: `node server/server.js`
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const app = createWormServer();
  const addr = await app.listen();
  console.log(`BRAINWORM v${LOG_VERSION}: http://localhost:${addr.port}  (event log: ${app.logPath || 'off'})`);
  let stopping = false;
  const stop = async () => { if (stopping) return; stopping = true; await app.close(); process.exit(0); };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
}

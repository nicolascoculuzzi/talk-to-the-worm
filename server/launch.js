// The $WORM launch (the coin is named BRAINWORM, its ticker $WORM): the first time a touch makes the worm stop swimming after arming sets the
// moment and the image.
//
//  1. armed:     a mod arms it. From then on, the first step where its cilia are stopped (mean arrest of
//                all ciliated cells) above STOP, outside its own stop-and-go rhythm, is "the moment": its
//                startle reflex (the lab: vibration makes larvae close their cilia). The arming step and
//                the moment go into the event log, so a replay shows it really was the first one.
//  2. moment:    the server renders the token image from the worm's exact activity at that step and
//                publishes the step, the state hash and the image hash.
//  3. metadata:  on a mod's click, the image and metadata are uploaded to pump.fun's IPFS.
//  4. prepared:  the site builds the pump.fun create transaction for the owner's wallet, with a fresh
//                mint key signed in. The owner's wallet adds its signature and sends it. The server
//                never holds the owner's key and never sends anything itself.
//  5. launched:  once the transaction confirms, the mint is the site's contract address and live
//                trades start reaching the worm. Every prepared mint (a public address; its key was discarded
//                once it signed) is kept on disk, and the server watches the chain for them: a launch is
//                recorded even if the owner's page closed or the server restarted before confirming it, and a
//                second coin is never prepared once one of them exists.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { stateString } from '../shared/replay.js';

export const STOP = 0.05;
export const TOKEN = { name: 'BRAINWORM', symbol: 'WORM' };
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');
const commas = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');   // same bytes on every Node build

const WATCH_MS = 3600_000;   // how long a prepared transaction is looked for on the chain (it can land for about a minute)

export function createLaunch({ dir, worm, D, writeLog, render, solana, site = {}, publicUrl = '', pinataJwt = '', rpcUrl, watchEveryMs = 15_000, onChange = () => {}, onLaunched = () => {}, logger = console }) {
  const root = path.join(dir, 'launch');
  fs.mkdirSync(root, { recursive: true });
  const file = path.join(root, 'state.json');
  let s = { armed: null, moment: null, metadata: null, launched: null, prepared: [] };
  try { s = { ...s, ...JSON.parse(fs.readFileSync(file, 'utf8')) }; } catch { /* first run */ }
  s.prepared ||= [];   // every transaction prepared for the owner, newest first: {mint, at}
  const save = () => { fs.writeFileSync(file, JSON.stringify(s, null, 1)); onChange(status()); };

  function status() {
    return {
      token: { ...TOKEN },
      armed: s.armed && { at: s.armed.at, step: s.armed.step, rule: s.armed.rule },
      moment: s.moment && { ...s.moment, image: '/launch/moment.png' },
      metadata: s.metadata && { uri: s.metadata.uri },
      uploader: pinataJwt ? 'Pinata' : 'pump.fun',
      launched: s.launched,
    };
  }

  function arm(rule = 'first time a touch stops its cilia') {
    if (s.moment) throw new Error('The moment has already been captured.');
    s.armed = { at: Date.now(), step: worm.step, rule };
    writeLog({ k: 'launch-armed', step: worm.step, rule, stop: STOP });
    save();
  }
  function disarm() {
    if (s.moment) throw new Error('The moment has already been captured.');
    if (s.armed) writeLog({ k: 'launch-disarmed', step: worm.step });
    s.armed = null; save();
  }

  /** Call after every simulation step. */
  function onStep() {
    if (!s.armed || s.moment) return;
    const level = worm.stopLevel();
    if (level <= STOP) return;
    const state = stateString(worm);
    const act = Float32Array.from(worm.sim.r);
    const step = worm.step, stateSha256 = sha256(state);
    const lines = [`STEP ${commas(step)}`, `${commas(worm.last.nAct)} CELLS FIRING`];
    const png = render.renderActivityPNG({ D, act, width: 1000, height: 1000, layout: 'square', lines, footnote: `STATE SHA-256 ${stateSha256.slice(0, 16).toUpperCase()}` });
    fs.writeFileSync(path.join(root, 'moment.png'), png);
    s.moment = { step, stateSha256, imageSha256: sha256(png), nAct: worm.last.nAct, stop: Math.round(level * 1000) / 1000, capturedAt: Date.now(), rule: s.armed.rule };
    writeLog({ k: 'launch-moment', step, stateSha256, imageSha256: s.moment.imageSha256, stop: STOP });
    logger.log(`launch moment captured at step ${step}`);
    save();
  }

  function description() {
    const m = s.moment;
    return [
      'A simulation of a real marine worm larva\'s nervous system (Platynereis dumerilii, 2,675 cells, wired as published in eLife 2025), running live' + (publicUrl ? ` at ${publicUrl}` : '') + '.',
      m ? `This image is the worm's activity at step ${m.step}, the first time a touch made it stop swimming after the launch was armed. State SHA-256 ${m.stateSha256}. Replay the log to check it.` : '',
    ].filter(Boolean).join(' ');
  }

  async function uploadMetadata({ twitter = '', telegram = '', website = publicUrl, fetchImpl } = {}) {
    if (!s.moment) throw new Error('Capture the moment first.');
    const image = fs.readFileSync(path.join(root, 'moment.png'));
    const opts = { image, filename: 'brainworm.png', ...TOKEN, description: description(), twitter, telegram, website, fetchImpl };
    const r = pinataJwt ? await solana.uploadPinataMetadata({ ...opts, jwt: pinataJwt }) : await solana.uploadPumpMetadata(opts);
    s.metadata = { uri: r.metadataUri, uploadedAt: Date.now() };
    save();
    return s.metadata;
  }

  async function prepare({ creator, amountSol = 0, slippage = 10, priorityFee = 0.0005, fetchImpl } = {}) {
    if (s.launched) throw new Error('Already launched.');
    if (!s.metadata) throw new Error('Upload the metadata first.');
    // one prepared earlier may have landed after all (a slow wallet, a closed page): never make a second coin
    if (await watch({ fetchImpl })) throw new Error(`Already launched: ${s.launched.mint}.`);
    const r = await solana.prepareLaunch({ creator, ...TOKEN, uri: s.metadata.uri, amountSol, slippage, priorityFee, fetchImpl });
    s.prepared = [{ mint: r.mint, at: Date.now() }, ...s.prepared].slice(0, 8);
    s.creator = creator;   // the wallet launching $WORM: its pump.fun creator
    save();
    return r;
  }

  function launched(mint, signature, r = {}) {
    s.launched = { mint, signature, confirmedAt: Date.now() };
    writeLog({ k: 'launch-confirmed', step: worm.step, mint, signature });
    save();
    onLaunched(s.launched);
    return { ok: true, ...r };
  }
  // the transaction that made the coin has its mint among its signers: check it is this one, when the chain can be asked
  async function madeBy(signature, mint, { fetchImpl, url }) {
    if (typeof solana.rpc !== 'function') return true;
    const t = await solana.rpc('getTransaction', [signature, { encoding: 'json', maxSupportedTransactionVersion: 0, commitment: 'confirmed' }], { url, fetchImpl });
    return !!t && !t.meta?.err && (t.transaction?.message?.accountKeys || []).includes(mint);
  }

  async function confirm({ signature, fetchImpl, url = rpcUrl } = {}) {
    if (s.launched) return s.launched.signature === signature ? { ok: true, already: true } : { ok: false, error: `Already launched: ${s.launched.mint}.` };
    if (!s.prepared.length) throw new Error('Nothing was prepared.');
    let last = {};
    for (const { mint } of s.prepared) {
      const r = await solana.confirmLaunch({ signature, mint, fetchImpl, url });
      last = r;
      if (!r.confirmed || r.err) break;   // the transaction itself hasn't landed: no mint will do
      if (r.mintExists && await madeBy(signature, mint, { fetchImpl, url })) return launched(mint, signature, r);
    }
    return { ok: false, ...last };
  }

  /** Has a prepared transaction landed without being confirmed here? Then that is the launch. True once launched. */
  let watching = false;
  async function watch({ fetchImpl, url = rpcUrl } = {}) {
    if (s.launched) return true;
    const recent = s.prepared.filter((x) => Date.now() - x.at < WATCH_MS);
    if (watching || !recent.length || typeof solana.rpc !== 'function') return false;
    watching = true;
    try {
      for (const { mint } of recent) {
        const acct = await solana.rpc('getAccountInfo', [mint, { encoding: 'base64', commitment: 'confirmed' }], { url, fetchImpl });
        if (!acct?.value) continue;
        const sigs = await solana.rpc('getSignaturesForAddress', [mint, { limit: 1000, commitment: 'confirmed' }], { url, fetchImpl });
        const first = (sigs || []).filter((x) => !x.err).at(-1);   // newest first: the last is the one that made it
        if (!first) continue;
        const r = await solana.confirmLaunch({ signature: first.signature, mint, fetchImpl, url });
        if (r.confirmed && !r.err && r.mintExists && await madeBy(first.signature, mint, { fetchImpl, url })) {
          logger.log(`launch found on the chain: ${mint}`);
          launched(mint, first.signature, r);
          return true;
        }
      }
      return false;
    } finally { watching = false; }
  }
  const timer = setInterval(() => { watch().catch((e) => logger.warn(`[launch] watching the chain: ${e.message}`)); }, watchEveryMs);
  timer.unref?.();

  return { status, arm, disarm, onStep, uploadMetadata, prepare, confirm, watch, stop: () => clearInterval(timer), description, get mint() { return s.launched ? s.launched.mint : null; }, get creator() { return s.creator || ''; }, imagePath: path.join(root, 'moment.png') };
}

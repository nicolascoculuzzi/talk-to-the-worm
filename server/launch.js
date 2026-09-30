// The $WORM launch (the coin is named BRAINWORM, its ticker $WORM): the first time a touch makes the worm stop swimming after arming sets the
// moment and the image.
//
//  1. armed:     a mod arms it. From then on, the first step where its cilia are stopped (mean arrest of
//                all ciliated cells) above STOP, outside its own stop-and-go rhythm, is "the moment": its
//                startle reflex (the lab: vibration makes larvae close their cilia). The arming step and
//                the moment go into the event log, so a replay shows it really was the first one.
//  2. moment:    the server renders the token image from the worm's exact activity at that step and
//                publishes the step, the state hash and the image hash.
//  3. metadata:  on a mod's click, the image and metadata are uploaded to pump.fun's IPFS (or Pinata's). If the
//                uploader refuses the server, they are kept on the site's lasting disk (LOG_DIR) instead.
//  4. prepared:  the site builds the pump.fun create transaction (server/pump.js, the same code SPAWN's coins use)
//                for the owner's wallet, with a dev buy in it. The coin's address is either made ahead of time in
//                the owner's browser (reserved: its key never leaves that browser, which signs the coin's slot) or
//                a fresh key signed in here and dropped. The owner's wallet adds its signature and sends it. The
//                server never holds the owner's key and never sends anything itself. Before signing, check() runs
//                the exact transaction on Solana without sending it (a simulation) and says what it would cost.
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

export function createLaunch({ dir, worm, D, writeLog, render, solana, pump, site = {}, publicUrl = '', pinataJwt = '', hostMetadata = false, rpcUrl, configuredMint = '', watchEveryMs = 15_000, onChange = () => {}, onLaunched = () => {}, logger = console }) {
  const root = path.join(dir, 'launch'), metaDir = path.join(root, 'meta');
  fs.mkdirSync(root, { recursive: true });
  const file = path.join(root, 'state.json');
  // reserved: the contract address the owner made ahead of time (its key is in their browser); private until the launch
  let s = { armed: null, moment: null, metadata: null, launched: null, prepared: [], reserved: null };
  try { s = { ...s, ...JSON.parse(fs.readFileSync(file, 'utf8')) }; } catch { /* first run */ }
  s.prepared ||= [];   // every transaction prepared for the owner, newest first: {mint, at}
  const save = () => { fs.writeFileSync(file, JSON.stringify(s, null, 1)); onChange(status()); };

  function status() {
    return {
      token: { ...TOKEN },
      armed: s.armed && { at: s.armed.at, step: s.armed.step, rule: s.armed.rule },
      moment: s.moment && { ...s.moment, image: '/launch/moment.png' },
      metadata: s.metadata && { uri: s.metadata.uri, onSite: !!s.metadata.onSite },
      uploader: pinataJwt ? 'Pinata' : 'pump.fun',
      // launched: by this page, or already (TOKEN_MINT is set) though this server doesn't have the record
      launched: s.launched || (configuredMint ? { mint: configuredMint, signature: null, fromSettings: true } : null),
    };
  }

  const done = () => s.launched || configuredMint;
  function arm(rule = 'first time a touch stops its cilia') {
    if (done()) throw new Error('$WORM has already launched.');
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
    if (done()) throw new Error('$WORM has already launched.');
    if (!s.moment) throw new Error('Capture the moment first.');
    const image = fs.readFileSync(path.join(root, 'moment.png'));
    const opts = { image, filename: 'brainworm.png', ...TOKEN, description: description(), twitter, telegram, website, fetchImpl };
    let uri, onSite = '';
    try {
      uri = (pinataJwt ? await solana.uploadPinataMetadata({ ...opts, jwt: pinataJwt }) : await solana.uploadPumpMetadata(opts)).metadataUri;
    } catch (e) {
      // pump.fun's uploader sits behind bot protection and can refuse a server: then the image and metadata are kept
      // on this site's lasting disk instead, so the launch never waits on it
      if (!hostMetadata || !publicUrl) throw e;
      uri = keepMetadata(image, { twitter, telegram, website });
      onSite = e.message;
      logger.warn(`[launch] the ${pinataJwt ? 'Pinata' : 'pump.fun'} upload failed (${e.message}); the metadata is kept on this site: ${uri}`);
    }
    s.metadata = { uri, uploadedAt: Date.now(), ...(onSite && { onSite }) };
    save();
    return s.metadata;
  }
  // What pump.fun's uploader would have made, kept here. Each file is named by the hash of what's in it, so the link that
  // goes on chain can only ever show this content.
  function keepMetadata(image, { twitter, telegram, website }) {
    fs.mkdirSync(metaDir, { recursive: true });
    const imageName = `${sha256(image).slice(0, 24)}.png`;
    fs.writeFileSync(path.join(metaDir, imageName), image);
    const json = JSON.stringify({ name: TOKEN.name, symbol: TOKEN.symbol, description: description(), image: `${publicUrl}/launch/meta/${imageName}`, showName: true, createdOn: 'https://pump.fun', ...(twitter && { twitter }), ...(telegram && { telegram }), ...(website && { website }) });
    const jsonName = `${crypto.createHash('sha256').update(json).digest('base64url').slice(0, 12)}.json`;
    fs.writeFileSync(path.join(metaDir, jsonName), json);
    return `${publicUrl}/launch/meta/${jsonName}`;
  }
  /** A file kept by keepMetadata: <12 characters>.json or the moment's picture, <24 hex>.png. */
  function metaFile(name) {
    if (!/^([A-Za-z0-9_-]{12}\.json|[0-9a-f]{24}\.png)$/.test(name)) return null;
    const f = path.join(metaDir, name);
    return fs.existsSync(f) ? f : null;
  }

  /** The contract address the owner made ahead of time in their browser (its key stays there); '' drops it. */
  function reserve({ mint = '' } = {}) {
    if (done()) throw new Error('$WORM has already launched.');
    if (mint && !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint)) throw new Error('That is not a Solana address.');
    s.reserved = mint ? { mint, at: Date.now() } : null;
    save();
    return { reserved: mint };
  }

  // the create transaction with the dev buy in it, at the reserved address if there is one
  async function build({ creator, amountSol, uri, fetchImpl }) {
    const r = await pump.buildCreate({ user: creator, creator, ...TOKEN, uri, firstBuySol: amountSol, mint: s.reserved?.mint || '', url: rpcUrl, fetchImpl });
    const fb = r.firstBuy;
    return { tx: r.tx, mint: r.mint, mintSigned: r.mintSigned, firstBuy: fb && { sol: Number(fb.lamports) / 1e9, worm: Number(fb.tokens) / 1e6, share: Number(fb.tokens) / 1e15 } };
  }

  async function prepare({ creator, amountSol = 0, fetchImpl } = {}) {
    if (done()) throw new Error('Already launched.');
    if (!s.metadata) throw new Error('Upload the metadata first.');
    // one prepared earlier may have landed after all (a slow wallet, a closed page): never make a second coin
    if (await watch({ fetchImpl })) throw new Error(`Already launched: ${s.launched.mint}.`);
    const r = await build({ creator, amountSol, uri: s.metadata.uri, fetchImpl });
    s.prepared = [{ mint: r.mint, at: Date.now() }, ...s.prepared.filter((x) => x.mint !== r.mint)].slice(0, 8);
    s.creator = creator;   // the wallet launching $WORM: its pump.fun creator
    s.preparers = [creator, ...(s.preparers || []).filter((w) => w !== creator)].slice(0, 8);   // every wallet a launch was prepared for
    save();
    return r;
  }

  /**
   * The launch transaction exactly as prepare() builds it, run on Solana without being sent (a simulation: nothing is
   * signed and nothing moves). Would pump.fun make $WORM for `creator` with this dev buy, and what would it take from
   * the wallet? Before the moment, a stand-in link as long as the real one takes the metadata's place.
   */
  async function check({ creator, amountSol = 0, fetchImpl } = {}) {
    if (done()) throw new Error('$WORM has already launched.');
    const uri = s.metadata?.uri || `${publicUrl || 'https://example.com'}/launch/meta/${'x'.repeat(12)}.json`;
    const r = await build({ creator, amountSol, uri, fetchImpl });
    const at = { url: rpcUrl, fetchImpl }, message = Buffer.from(solana.parseTransaction(Buffer.from(r.tx, 'base64')).messageBytes).toString('base64');
    const [balance, fee, sim] = await Promise.all([
      solana.rpc('getBalance', [creator, { commitment: 'confirmed' }], at),
      solana.rpc('getFeeForMessage', [message, { commitment: 'confirmed' }], at),
      solana.rpc('simulateTransaction', [r.tx, { encoding: 'base64', sigVerify: false, replaceRecentBlockhash: true, commitment: 'confirmed', innerInstructions: true }], at),
    ]);
    const v = sim.value, has = balance.value / 1e9;
    const base = { mint: r.mint, reserved: !!s.reserved, standIn: !s.metadata, balance: has, firstBuy: r.firstBuy };
    if (v.err) return { works: false, ...base, error: whyNot(v, has, Number(amountSol) || 0) };
    // every lamport that leaves the wallet: the new accounts' rent, the dev buy and its fees (moved by the programs it
    // calls, so they show as inner instructions) and the network fee
    let out = fee?.value || 0;
    for (const inner of v.innerInstructions || []) {
      for (const ix of inner.instructions) {
        const info = ix.parsed?.info;
        if (info?.source === creator && info.lamports != null && ['transfer', 'createAccount'].includes(ix.parsed.type)) out += Number(info.lamports);
      }
    }
    const trade = pump.eventsFromLogs(v.logs).find((e) => e.kind === 'trade');
    return { works: true, ...base, cost: out / 1e9, bought: trade ? Number(trade.tokens) / 1e6 : 0, creatorFee: trade ? Number(trade.creatorFee) / 1e9 : 0 };
  }
  // what a failed simulation means, in words
  function whyNot(v, has, devBuy) {
    const logs = v.logs || [], err = JSON.stringify(v.err);
    if (/AccountNotFound|InsufficientFunds/.test(err) || logs.some((l) => /insufficient (lamports|funds)/i.test(l))) return `This wallet does not have enough SOL: it has ${has} SOL, and this launch needs about ${Math.round((devBuy + 0.012) * 1000) / 1000} SOL.`;
    if (logs.some((l) => /already in use/.test(l))) return 'Something already exists at the contract address. Make a new one.';
    const msg = logs.map((l) => /Error Message: (.*)$/.exec(l)?.[1]).find(Boolean);
    return msg ? `pump.fun refused it: ${msg}` : `It failed: ${err}`;
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

  // a coin found at a prepared address is the launch only if a wallet it was prepared for is its creator (a reserved
  // address's key lives in a browser: were it ever copied, a coin someone else made there is not $WORM)
  async function ours(mint, { fetchImpl, url }) {
    const wallets = s.preparers?.length ? s.preparers : [s.creator].filter(Boolean);
    if (typeof pump?.fetchCurves !== 'function' || !wallets.length) return true;
    const c = (await pump.fetchCurves({ mints: [mint], url, fetchImpl })).get(mint);
    if (!c) return false;   // not readable yet: the next look decides
    if (!wallets.includes(c.creator)) { logger.warn(`[launch] a coin at ${mint} was made by ${c.creator}, not by a wallet it was prepared for: not $WORM`); return false; }
    s.creator = c.creator;   // the wallet that really launched it
    return true;
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
  // one look at a time, and whoever asks while it runs gets its answer (prepare() must not miss a launch it is finding)
  let watching = null;
  function watch(o = {}) {
    if (s.launched) return Promise.resolve(true);
    if (!watching) watching = look(o).finally(() => { watching = null; });
    return watching;
  }
  async function look({ fetchImpl, url = rpcUrl } = {}) {
    const recent = s.prepared.filter((x) => Date.now() - x.at < WATCH_MS);
    if (!recent.length || typeof solana.rpc !== 'function') return false;
    for (const { mint } of recent) {
      const acct = await solana.rpc('getAccountInfo', [mint, { encoding: 'base64', commitment: 'confirmed' }], { url, fetchImpl });
      if (!acct?.value) continue;
      const sigs = await solana.rpc('getSignaturesForAddress', [mint, { limit: 1000, commitment: 'confirmed' }], { url, fetchImpl });
      const first = (sigs || []).filter((x) => !x.err).at(-1);   // newest first: the last is the one that made it
      if (!first) continue;
      const r = await solana.confirmLaunch({ signature: first.signature, mint, fetchImpl, url });
      if (r.confirmed && !r.err && r.mintExists && await madeBy(first.signature, mint, { fetchImpl, url }) && await ours(mint, { fetchImpl, url })) {
        logger.log(`launch found on the chain: ${mint}`);
        launched(mint, first.signature, r);
        return true;
      }
    }
    return false;
  }
  const timer = setInterval(() => { watch().catch((e) => logger.warn(`[launch] watching the chain: ${e.message}`)); }, watchEveryMs);
  timer.unref?.();

  return {
    status, arm, disarm, onStep, uploadMetadata, metaFile, reserve, prepare, check, confirm, watch, stop: () => clearInterval(timer), description,
    get mint() { return s.launched ? s.launched.mint : null; }, get creator() { return s.creator || ''; }, get reserved() { return s.reserved?.mint || ''; },
    imagePath: path.join(root, 'moment.png'),
  };
}

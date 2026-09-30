// Solana plumbing for the $WORM launch: base58, Ed25519 keys, program-derived addresses, the
// transaction wire format, partial signing, PumpPortal's create API, live trades (Solana RPC logs, free;
// or PumpPortal's paid stream) and two RPC reads.
// Nothing here sends a transaction or spends anything (only the metadata uploaders publish, to IPFS).
// The server fetches an unsigned pump.fun create transaction, adds the fresh mint's signature, and
// the creator's own wallet signs and sends it in the browser. Secret keys never leave the closure
// that created them.
import crypto from 'node:crypto';
import { WebSocket } from 'ws';

export const PUMP_PROGRAM = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
export const PUMP_AMM_PROGRAM = 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA';   // PumpSwap, where coins trade after graduating
export const WSOL_MINT = 'So11111111111111111111111111111111111111112';
export const TRADE_LOCAL_URL = 'https://pumpportal.fun/api/trade-local';
export const DATA_WS_URL = 'wss://pumpportal.fun/api/data';
export const RPC_URL = 'https://api.mainnet-beta.solana.com';
export const RPC_WS_URL = 'wss://api.mainnet-beta.solana.com';

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const B58 = /^[1-9A-HJ-NP-Za-km-z]+$/;
const SPKI_ED25519 = Buffer.from('302a300506032b6570032100', 'hex');
const MAX_BACKOFF = 60_000;
const OPEN = 1, CLOSED = 3;
const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', json: 'application/json' };

const fail = (msg) => { throw new Error(`solana: ${msg}`); };
const bytesOf = (b) => (b instanceof Uint8Array ? new Uint8Array(b) : b instanceof ArrayBuffer ? new Uint8Array(b.slice(0)) : fail('expected bytes'));
const clip = (s, n = 300) => String(s).replace(/\s+/g, ' ').trim().slice(0, n);

// ---- base58 (Bitcoin alphabet): every leading zero byte is one leading '1' ----

export function b58encode(bytes) {
  const b = Buffer.from(bytesOf(bytes));
  let zeros = 0, out = '';
  while (zeros < b.length && b[zeros] === 0) zeros++;
  for (let n = BigInt('0x0' + b.toString('hex')); n; n /= 58n) out = ALPHABET[Number(n % 58n)] + out;
  return '1'.repeat(zeros) + out;
}

export function b58decode(str) {
  if (typeof str !== 'string') fail('base58 input must be a string');
  let zeros = 0, n = 0n;
  while (str[zeros] === '1') zeros++;
  for (const c of str.slice(zeros)) {
    const d = ALPHABET.indexOf(c);
    if (d < 0) fail(`invalid base58 character ${JSON.stringify(c)}`);
    n = n * 58n + BigInt(d);
  }
  const hex = n ? n.toString(16) : '';
  return new Uint8Array(Buffer.concat([Buffer.alloc(zeros), Buffer.from(hex.length % 2 ? '0' + hex : hex, 'hex')]));
}

export const isAddress = (s) => typeof s === 'string' && s.length >= 32 && s.length <= 44 && B58.test(s) && b58decode(s).length === 32;
const checkAddress = (s, what) => { if (!isAddress(s)) fail(`${what} is not a Solana address: ${JSON.stringify(s)}`); };

// ---- Ed25519 ----

/** A fresh keypair. Only the public half is exposed; the secret stays inside `sign`. */
export function generateKeypair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const pub = new Uint8Array(Buffer.from(publicKey.export({ format: 'jwk' }).x, 'base64url'));
  return { address: b58encode(pub), publicKey: pub, sign: (msg) => new Uint8Array(crypto.sign(null, msg, privateKey)) };
}

/** publicKey: 32 bytes or a base58 address. Never throws. */
export function verifySignature(publicKey, message, signature) {
  try {
    const pub = typeof publicKey === 'string' ? b58decode(publicKey) : publicKey;
    if (pub.length !== 32 || signature.length !== 64) return false;
    const key = crypto.createPublicKey({ key: Buffer.concat([SPKI_ED25519, pub]), format: 'der', type: 'spki' });
    return crypto.verify(null, message, key, signature);
  } catch { return false; }
}

// ---- program-derived addresses: sha256(seeds, bump, program, marker), first bump (from 255) off the curve ----

const P = 2n ** 255n - 19n, D = 37095705934669439343138083508754565189542113879843219016388785533085940283555n;   // ed25519 field, curve d
const modpow = (b, e) => { let r = 1n; for (b %= P; e; e >>= 1n, b = b * b % P) if (e & 1n) r = r * b % P; return r; };

// Like curve25519-dalek's CompressedEdwardsY::decompress().is_some(): x² = (y² - 1) / (d·y² + 1) must be a square.
function onCurve(bytes) {
  const y = BigInt('0x' + Buffer.from(bytes).reverse().toString('hex')) & (2n ** 255n - 1n);
  const y2 = y * y % P, x2 = (y2 + P - 1n) * modpow(D * y2 + 1n, P - 2n) % P;
  return x2 === 0n || modpow(x2, (P - 1n) / 2n) === 1n;
}

/** seeds: byte arrays, utf-8 strings, or base58 addresses (taken as their 32 bytes). Returns [address, bump]. */
export function findProgramAddress(seeds, programId) {
  const parts = seeds.map((s) => Buffer.from(isAddress(s) ? b58decode(s) : s));
  if (parts.length > 15 || parts.some((p) => p.length > 32)) fail('at most 15 seeds of up to 32 bytes');
  const tail =Buffer.concat([Buffer.from(b58decode(programId)), Buffer.from('ProgramDerivedAddress')]);
  for (let bump = 255; bump >= 0; bump--) {
    const h = crypto.createHash('sha256').update(Buffer.concat([...parts, Buffer.from([bump]), tail])).digest();
    if (!onCurve(h)) return [b58encode(h), bump];
  }
  fail('no viable bump seed');
}

/** The PumpSwap pool pump.fun's `migrate` creates for a graduated coin: index 0, owned by the coin's pool-authority, paired with wSOL. */
export const pumpSwapPool = (mint) => findProgramAddress(['pool', [0, 0], findProgramAddress(['pool-authority', mint], PUMP_PROGRAM)[0], mint, WSOL_MINT], PUMP_AMM_PROGRAM)[0];

// ---- transaction wire format ----
// shortvec(#sigs) + 64-byte sigs, then the message: [0x80 | version] (v0 only) + header(3) +
// shortvec keys(32) + blockhash(32) + shortvec instructions + (v0) shortvec address-table lookups.

class Reader {
  constructor(buf) { this.buf = buf; this.pos = 0; }
  bytes(n) {
    if (this.pos + n > this.buf.length) fail('truncated transaction');
    return this.buf.slice(this.pos, (this.pos += n));
  }
  byte() {
    if (this.pos >= this.buf.length) fail('truncated transaction');
    return this.buf[this.pos++];
  }
  // compact-u16: 1-3 bytes of 7 bits, little-endian; aliases and overflow rejected like the runtime does
  shortvec() {
    for (let i = 0, v = 0; i < 3; i++) {
      const b = this.byte();
      v |= (b & 0x7f) << (7 * i);
      if (b & 0x80) continue;
      if (i && !b) fail('non-canonical compact-u16');
      if (v > 0xffff) fail('compact-u16 overflow');
      return v;
    }
    fail('compact-u16 longer than 3 bytes');
  }
  list(read) { return Array.from({ length: this.shortvec() }, () => read()); }
}

// The runtime's sanitize rules (solana-message legacy/v0 + VersionedTransaction).
function sanitize(tx) {
  const { header: h, accountKeys: keys, addressTableLookups: lookups = [] } = tx;
  if (tx.signatures.length !== h.numRequiredSignatures) fail(`${tx.signatures.length} signatures for ${h.numRequiredSignatures} required signers`);
  if (h.numReadonlySigned >= h.numRequiredSignatures) fail('no writable fee payer');
  if (h.numRequiredSignatures + h.numReadonlyUnsigned > keys.length) fail('header describes more accounts than the message has');
  if (new Set(keys).size !== keys.length) fail('duplicate account key');
  let total = keys.length;
  for (const l of lookups) total += l.writableIndexes.length + l.readonlyIndexes.length || fail('address table lookup loads nothing');
  if (total > 256) fail('more than 256 accounts');
  for (const ix of tx.instructions) {
    if (!ix.programIdIndex || ix.programIdIndex >= keys.length) fail(`bad program id index ${ix.programIdIndex}`);   // static, never the payer
    if (ix.accounts.some((a) => a >= total)) fail('instruction account index out of range');
  }
}

export function parseTransaction(bytes) {
  const r = new Reader(bytesOf(bytes));
  const signatures = r.list(() => r.bytes(64));
  const start = r.pos;
  let version = 'legacy';
  if (r.buf[r.pos] & 0x80) {
    version = r.byte() & 0x7f;
    if (version !== 0) fail(`unsupported transaction version ${version}`);
  }
  const header = { numRequiredSignatures: r.byte(), numReadonlySigned: r.byte(), numReadonlyUnsigned: r.byte() };
  const accountKeys = r.list(() => b58encode(r.bytes(32)));
  const recentBlockhash = b58encode(r.bytes(32));
  const instructions = r.list(() => ({ programIdIndex: r.byte(), accounts: r.list(() => r.byte()), data: r.bytes(r.shortvec()) }));
  const tx = { signatures, messageBytes: null, version, header, accountKeys, recentBlockhash, instructions };
  if (version === 0) {
    tx.addressTableLookups = r.list(() => ({ accountKey: b58encode(r.bytes(32)), writableIndexes: r.list(() => r.byte()), readonlyIndexes: r.list(() => r.byte()) }));
  }
  if (r.pos !== r.buf.length) fail('trailing bytes after transaction');
  tx.messageBytes = r.buf.slice(start);
  sanitize(tx);
  return tx;
}

/** Returns a copy of the transaction with `keypair`'s signature in its slot; other slots untouched. */
export function signPartial(txBytes, keypair) {
  const out = bytesOf(txBytes), tx = parseTransaction(out);
  const i = tx.accountKeys.indexOf(keypair.address);
  if (i < 0 || i >= tx.header.numRequiredSignatures) fail(`${keypair.address} is not a required signer`);
  const sig = keypair.sign(tx.messageBytes);
  if (sig?.length !== 64) fail('signer returned a bad signature');
  out.set(sig, out.length - tx.messageBytes.length - 64 * (tx.signatures.length - i));
  return out;
}

/** One entry per required signer; an all-zero signature is a placeholder (not present). */
export function verifyTransactionSignatures(txBytes) {
  const tx = parseTransaction(txBytes);
  return tx.signatures.map((sig, i) => {
    const address = tx.accountKeys[i], present = sig.some((b) => b !== 0);
    return { address, present, valid: present && verifySignature(address, tx.messageBytes, sig) };
  });
}

// ---- PumpPortal: https://pumpportal.fun/creation (Local Transaction API) ----

function checkText(s, maxBytes, what) {   // Metaplex limits: name 32, symbol 10, uri 200 bytes
  if (typeof s !== 'string' || !s.trim() || Buffer.byteLength(s) > maxBytes) fail(`${what} must be 1-${maxBytes} bytes`);
}

/** The unsigned pump.fun create transaction (a serialized v0 VersionedTransaction) from PumpPortal. Read-only. */
export async function pumpCreateTx({ publicKey, mint, name, symbol, uri, amountSol = 0, slippage = 10, priorityFee = 0.0005, fetchImpl = fetch, url = TRADE_LOCAL_URL, timeoutMs = 20_000 } = {}) {
  checkAddress(publicKey, 'publicKey');
  checkAddress(mint, 'mint');
  checkText(name, 32, 'name'); checkText(symbol, 10, 'symbol'); checkText(uri, 200, 'uri');
  for (const [k, v] of Object.entries({ amountSol, slippage, priorityFee })) if (!(Number.isFinite(v) && v >= 0)) fail(`bad ${k}: ${v}`);
  const res = await fetchImpl(url, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(timeoutMs),
    body: JSON.stringify({ publicKey, action: 'create', tokenMetadata: { name, symbol, uri }, mint, denominatedInSol: 'true', amount: amountSol, slippage, priorityFee, pool: 'pump' }),
  });
  const body = new Uint8Array(await res.arrayBuffer());
  if (res.status !== 200) fail(`PumpPortal HTTP ${res.status}: ${clip(Buffer.from(body).toString() || res.statusText)}`);
  try { parseTransaction(body); } catch (e) { fail(`PumpPortal did not return a transaction (${e.message}): ${clip(Buffer.from(body).toString(), 120)}`); }
  return body;
}

/**
 * Fresh mint keypair + PumpPortal create tx, signed by the mint only. The creator's wallet adds the
 * fee-payer signature and sends it (it expires with the blockhash, ~1 min). The mint secret is dropped here.
 */
export async function prepareLaunch({ creator, name, symbol, uri, amountSol, slippage, priorityFee, fetchImpl, url } = {}) {
  checkAddress(creator, 'creator');
  const mint = generateKeypair();
  const raw = await pumpCreateTx({ publicKey: creator, mint: mint.address, name, symbol, uri, amountSol, slippage, priorityFee, fetchImpl, url });
  const tx = parseTransaction(raw);
  const signers = tx.accountKeys.slice(0, tx.header.numRequiredSignatures);
  if (signers[0] !== creator) fail(`fee payer is ${signers[0]}, not the creator`);
  if (!signers.includes(mint.address)) fail('the mint is not a required signer');
  const other = signers.find((s) => s !== creator && s !== mint.address);
  if (other) fail(`unexpected required signer ${other}`);
  const signed = signPartial(raw, mint);
  if (!verifyTransactionSignatures(signed).find((s) => s.address === mint.address)?.valid) fail('mint signature does not verify');
  const programIds = [...new Set(tx.instructions.map((ix) => tx.accountKeys[ix.programIdIndex]))];
  return {
    mint: mint.address,
    tx: Buffer.from(signed).toString('base64'),
    summary: { feePayer: creator, signers, programIds, recentBlockhash: tx.recentBlockhash },
  };
}

// ---- token metadata on IPFS: these publish the image and JSON. Never call them outside a real launch. ----

const filePart = (name, bytes, filename) => {
  if (!(bytes instanceof Uint8Array) || !bytes.length) fail('image must be a non-empty Buffer');
  return [name, new Blob([bytes], { type: MIME[String(filename).split('.').pop().toLowerCase()] || 'application/octet-stream' }), filename];
};

async function postForm(url, parts, headers, fetchImpl, timeoutMs, what) {
  const form = new FormData();
  for (const [k, v, filename] of parts) if (filename) form.append(k, v, filename); else form.append(k, v == null ? '' : String(v));
  const res = await fetchImpl(url, { method: 'POST', body: form, headers, signal: AbortSignal.timeout(timeoutMs) });
  const text = await res.text();
  if (res.status !== 200) fail(`${what} HTTP ${res.status}: ${clip(text || res.statusText)}`);
  try { return JSON.parse(text); } catch { fail(`${what} returned non-JSON: ${clip(text, 120)}`); }
}

/**
 * pump.fun's own uploader: multipart POST to /api/ipfs → { metadataUri, metadata }. NOTE: PumpPortal's
 * docs (2026) say pump.fun no longer accepts direct uploads; uploadPinataMetadata is their replacement.
 */
export async function uploadPumpMetadata({ image, filename = 'image.png', name, symbol, description = '', twitter = '', telegram = '', website = '', url = 'https://pump.fun/api/ipfs', fetchImpl = fetch, timeoutMs = 30_000 } = {}) {
  checkText(name, 32, 'name'); checkText(symbol, 10, 'symbol');
  const fields = Object.entries({ name, symbol, description, twitter, telegram, website, showName: 'true' });
  const json = await postForm(url, [filePart('file', image, filename), ...fields], {}, fetchImpl, timeoutMs, 'pump.fun ipfs');
  if (typeof json?.metadataUri !== 'string' || !/^https?:\/\//.test(json.metadataUri)) fail('pump.fun ipfs reply has no metadataUri');
  return { metadataUri: json.metadataUri, metadata: json.metadata ?? null };
}

/** The same via Pinata's v3 upload API (image, then pump.fun-style metadata JSON), as PumpPortal's examples do now. */
export async function uploadPinataMetadata({ image, filename = 'image.png', name, symbol, description = '', twitter = '', telegram = '', website = '', createdOn = 'https://pump.fun', jwt, url = 'https://uploads.pinata.cloud/v3/files', gateway = 'https://ipfs.io/ipfs/', fetchImpl = fetch, timeoutMs = 30_000 } = {}) {
  checkText(name, 32, 'name'); checkText(symbol, 10, 'symbol');
  if (!jwt) fail('a Pinata JWT is required');
  const upload = async (part) => {
    const json = await postForm(url, [['network', 'public'], part], { Authorization: `Bearer ${jwt}` }, fetchImpl, timeoutMs, 'Pinata');
    return /^[A-Za-z0-9]{10,100}$/.test(json?.data?.cid) ? gateway + json.data.cid : fail('Pinata reply has no cid');
  };
  const metadata = { name, symbol, description, image: await upload(filePart('file', image, filename)), showName: true, createdOn };
  for (const [k, v] of Object.entries({ twitter, telegram, website })) if (v) metadata[k] = v;
  return { metadataUri: await upload(filePart('file', Buffer.from(JSON.stringify(metadata)), 'metadata.json')), metadata };
}

// ---- live trades: PumpPortal's data websocket (needs a funded API key) or Solana RPC logs (free) ----

const b58Field = (s, min, max) => (typeof s === 'string' && s.length >= min && s.length <= max && B58.test(s) ? s : '');
const num = (v) => (v === '' || v == null ? NaN : Number(v));

/** A PumpPortal buy/sell message for `mint` → { signature, side, sol, tokens, trader, marketCapSol, pool, ts }, else null. */
export function normalizeTrade(m, mint, ts = Date.now()) {
  if (!m || typeof m !== 'object' || (m.txType !== 'buy' && m.txType !== 'sell') || (mint && m.mint !== mint)) return null;
  const signature = b58Field(m.signature, 64, 90), sol = num(m.solAmount), tokens = num(m.tokenAmount);
  if (!signature || !(sol >= 0) || !(tokens >= 0)) return null;
  const mcap = num(m.marketCapSol);
  return {
    signature, side: m.txType, sol, tokens, trader: b58Field(m.traderPublicKey, 32, 44),
    marketCapSol: Number.isFinite(mcap) ? mcap : null, pool: typeof m.pool === 'string' ? m.pool.slice(0, 32) : '', ts,
  };
}

// Anchor events are logged as "Program data: <base64>" with an 8-byte discriminator sha256('event:<Name>')[0..8].
// Layouts: pump-fun/pump-public-docs idl/pump.json (TradeEvent) and idl/pump_amm.json (BuyEvent, SellEvent). Only the
// leading fields are read; upgrades append new ones. Amounts assume what pump.fun mints: SOL-paired, 6 decimals, 1e9 supply.
const EVENTS = { bddb7fd34ee661ee: 'trade', '67f4521f2cf57777': 'buy', '3e2f370aa503dc2a': 'sell' };

function decodeEvent(program, d) {
  const kind = d.length >= 8 && EVENTS[d.toString('hex', 0, 8)];
  const pk = (o) => b58encode(d.subarray(o, o + 32)), u64 = (o) => Number(d.readBigUInt64LE(o));
  if (kind === 'trade' && program === PUMP_PROGRAM && d.length >= 113 && d[56] <= 1) {
    // TradeEvent: mint @8, sol_amount @40, token_amount @48, is_buy @56, user @57, timestamp @89,
    // virtual_sol_reserves @97, virtual_token_reserves @105 (after the trade), …
    const vTokens = u64(105);
    return { mint: pk(8), pool: 'pump', side: d[56] ? 'buy' : 'sell', lamports: u64(40), raw: u64(48), trader: pk(57), mcap: vTokens ? u64(97) * 1e6 / vTokens : null };
  }
  if ((kind === 'buy' || kind === 'sell') && program === PUMP_AMM_PROGRAM && d.length >= 184) {
    // Buy/SellEvent: timestamp @8, base_amount_out|in @16, pool_base_token_reserves @48, pool_quote_token_reserves @56
    // (before the swap), quote_amount_in|out @64 (fees excluded, like sol_amount above), pool @120, user @152, …
    const base = u64(48);
    return { address: pk(120), pool: 'pump-amm', side: kind, lamports: u64(64), raw: u64(16), trader: pk(152), mcap: base ? u64(56) * 1e6 / base : null };
  }
  return null;
}

/**
 * The trades of `mint` in one transaction's logs, in order: pump.fun bonding-curve TradeEvents for the mint and
 * PumpSwap Buy/SellEvents in its canonical pool. Each "Program data:" line is attributed to the program that
 * emitted it, so look-alike events from other programs are ignored.
 */
export function tradesFromLogs(logs, { mint, signature = '', pool = pumpSwapPool(mint) } = {}) {
  const stack = [], trades = [];
  for (const line of Array.isArray(logs) ? logs : []) {
    if (typeof line !== 'string') continue;
    const invoke = /^Program (\w+) invoke \[\d+\]$/.exec(line);
    if (invoke) stack.push(invoke[1]);
    else if (/^Program \w+ (success|failed)/.test(line)) stack.pop();
    else if (line.startsWith('Program data: ')) {
      const e = decodeEvent(stack.at(-1), Buffer.from(line.slice(14), 'base64'));
      if (!e || (e.pool === 'pump' ? e.mint !== mint : e.address !== pool)) continue;
      trades.push({ signature, side: e.side, sol: e.lamports / 1e9, tokens: e.raw / 1e6, trader: e.trader, marketCapSol: e.mcap, pool: e.pool, ts: Date.now() });
    }
  }
  return trades;
}

// One websocket per stream: subscribe on open, ws pings (trades can be hours apart, so silence proves nothing),
// exponential backoff that only a stable link resets (PumpPortal bans reconnect storms), handlers that can't break it.
// read(message) → { trades, ack, notice } | null
function tradeStream(tag, target, subscribe, read, opts) {
  const {
    mint, onTrade = () => {}, WebSocketImpl = WebSocket, logger = console, now = () => Date.now(),
    backoffMs = 1000, stableMs = 60_000, pingIntervalMs = 30_000, pingTimeoutMs = 10_000,
  } = opts;
  const st = { enabled: true, mint, connected: false, subscribed: false, trades: 0, lastTradeAt: null, reconnects: 0, lastNotice: null };
  let ws = null, running = false, attempt = 0, openedAt = 0, retryTimer = null, pingTimer = null, pongTimer = null;
  const redact = (msg) => String(msg).split(target).join('<url>');   // e.g. ws's "Invalid URL: …" would carry the key

  const clearTimers = () => {
    clearTimeout(retryTimer); clearInterval(pingTimer); clearTimeout(pongTimer);
    retryTimer = pingTimer = pongTimer = null;
  };

  function connect() {
    retryTimer = null;
    let sock;
    try { sock = new WebSocketImpl(target, { handshakeTimeout: 10_000, closeTimeout: 2000 }); } catch (err) {
      logger.warn(`[${tag}] cannot connect: ${redact(err.message)}`);
      return retry();
    }
    ws = sock;
    const alive = () => { clearTimeout(pongTimer); pongTimer = null; };
    sock.on('open', () => {
      if (sock !== ws) return;
      st.connected = true; openedAt = Date.now();
      sock.send(JSON.stringify(subscribe));
      pingTimer = setInterval(() => {
        try { sock.ping(); } catch { return; }
        pongTimer ??= setTimeout(() => { logger.warn(`[${tag}] ping timed out`); sock.terminate(); }, pingTimeoutMs);
      }, pingIntervalMs);
    });
    sock.on('pong', () => { if (sock === ws) alive(); });
    sock.on('message', (data) => { if (sock === ws) { alive(); handle(data); } });
    sock.on('error', (err) => { if (sock === ws) logger.warn(`[${tag}] ${redact(err.message)}`); });
    sock.on('close', () => {
      if (sock !== ws) return;
      clearTimers();
      ws = null;
      st.connected = st.subscribed = false;
      if (openedAt && Date.now() - openedAt >= stableMs) attempt = 0;
      openedAt = 0;
      if (running) retry();
    });
  }

  function retry() {
    const delay = Math.min(MAX_BACKOFF, backoffMs * 2 ** Math.min(attempt++, 16));
    logger.warn(`[${tag}] disconnected, reconnecting in ${delay / 1000}s`);
    retryTimer = setTimeout(() => { st.reconnects++; connect(); }, delay);
  }

  function handle(data) {
    let got;
    try { got = read(JSON.parse(String(data))); } catch { return; }
    const { trades = [], ack = false, notice = '' } = got || {};
    if (ack) st.subscribed = true;
    if (notice) {
      st.lastNotice = clip(notice, 200);
      if (!ack) logger.warn(`[${tag}] ${st.lastNotice}`);
    }
    for (const trade of trades) {
      trade.ts = now();
      st.subscribed = true; st.trades++; st.lastTradeAt = trade.ts;
      safely(onTrade, trade);
    }
  }

  function safely(fn, ...args) {
    const warn = (err) => logger.warn(`[${tag}] handler failed: ${err?.message || err}`);
    try { const r = fn(...args); if (r && typeof r.catch === 'function') r.catch(warn); } catch (err) { warn(err); }
  }

  return {
    start() {
      if (running) return;
      running = true; attempt = 0;
      connect();
    },
    stop() {
      running = false;
      clearTimers();
      const sock = ws; ws = null;
      st.connected = st.subscribed = false;
      if (!sock || sock.readyState === CLOSED) return Promise.resolve();
      return new Promise((resolve) => {
        sock.once('close', resolve);
        if (sock.readyState === OPEN) sock.close(1000); else sock.terminate();
      });
    },
    status: () => ({ ...st }),
  };
}

/**
 * Live trades for one token from PumpPortal's data websocket. Since May 2026 PumpPortal only streams trades to a
 * funded API key (0.01 SOL per 10k messages); keep the key server-side, it also controls its Lightning wallet.
 * opts: { mint, onTrade(trade), apiKey, url, WebSocketImpl (ws-compatible), logger=console, now=Date.now,
 *   backoffMs=1000, stableMs=60000 (a link up this long resets the backoff), pingIntervalMs=30000, pingTimeoutMs=10000 }
 * Returns { start(), stop(): Promise, status() }.
 */
export function createTradeStream(opts = {}) {
  const { mint, apiKey = '', url = DATA_WS_URL } = opts;
  checkAddress(mint, 'mint');
  const target = apiKey ? `${url}${url.includes('?') ? '&' : '?'}api-key=${encodeURIComponent(apiKey)}` : url;   // never logged
  return tradeStream('pumpportal', target, { method: 'subscribeTokenTrade', keys: [mint] }, (m) => {
    const trade = normalizeTrade(m, mint);
    if (trade) return { trades: [trade] };
    // acks look like {"message":"Successfully subscribed to ..."}; after the API-key refusal the socket stays open but silent
    const notice = typeof m?.message === 'string' ? m.message : typeof m?.errors === 'string' ? m.errors : '';
    return { notice, ack: /^success/i.test(notice) };
  }, opts);
}

/**
 * The free, keyless default: Solana RPC `logsSubscribe` for transactions mentioning `mint` (commitment 'confirmed'),
 * trades decoded from their logs by tradesFromLogs, with no further RPC calls. Same options, status and trade shape
 * as createTradeStream, except `url` is an RPC websocket (the public one is rate-limited; a provider URL may carry a
 * key, so it is never logged). Failed transactions are skipped.
 */
export function createRpcTradeStream(opts = {}) {
  const { mint, url = RPC_WS_URL } = opts;
  checkAddress(mint, 'mint');
  const pool = pumpSwapPool(mint);
  const subscribe = { jsonrpc: '2.0', id: 1, method: 'logsSubscribe', params: [{ mentions: [mint] }, { commitment: 'confirmed' }] };
  return tradeStream('solana-rpc', url, subscribe, (m) => {
    if (m?.id === 1) return m.error ? { notice: `logsSubscribe failed: ${m.error.message ?? JSON.stringify(m.error)}` } : { ack: true };
    const v = m?.method === 'logsNotification' ? m.params?.result?.value : null;
    return v && v.err == null ? { trades: tradesFromLogs(v.logs, { mint, pool, signature: b58Field(v.signature, 64, 90) }) } : null;
  }, opts);
}

// ---- RPC reads ----

export async function rpc(method, params = [], { url = RPC_URL, fetchImpl = fetch, timeoutMs = 15_000 } = {}) {
  const res = await fetchImpl(url, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(timeoutMs),
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const text = await res.text();
  if (res.status !== 200) fail(`RPC ${method} HTTP ${res.status}: ${clip(text || res.statusText)}`);
  let json;
  try { json = JSON.parse(text); } catch { fail(`RPC ${method} returned non-JSON: ${clip(text, 120)}`); }
  if (json.error) fail(`RPC ${method} error ${json.error.code}: ${clip(json.error.message)}`);
  return json.result;
}

/** Has the create transaction landed, and does the mint exist? supply is the raw base-unit string. */
export async function confirmLaunch({ signature, mint, url = RPC_URL, fetchImpl = fetch } = {}) {
  if (typeof signature !== 'string' || signature.length > 88 || !B58.test(signature) || b58decode(signature).length !== 64) fail('signature must be a base58 transaction signature');
  checkAddress(mint, 'mint');
  const [statuses, account] = await Promise.all([
    rpc('getSignatureStatuses', [[signature], { searchTransactionHistory: true }], { url, fetchImpl }),
    rpc('getAccountInfo', [mint, { encoding: 'jsonParsed', commitment: 'confirmed' }], { url, fetchImpl }),
  ]);
  const s = statuses?.value?.[0] ?? null;
  const parsed = account?.value?.data?.parsed;
  const isMint = parsed?.type === 'mint' && /^spl-token(-2022)?$/.test(account.value.data.program);
  return {
    confirmed: !!s && s.err == null && (s.confirmationStatus === 'confirmed' || s.confirmationStatus === 'finalized'),
    status: s?.confirmationStatus ?? null,
    err: s?.err ?? null,
    mintExists: isMint,
    decimals: isMint ? parsed.info.decimals : null,
    supply: isMint ? parsed.info.supply : null,
  };
}

// Meteora's Dynamic Bonding Curve (program dbcij3…MaqN), for SPAWN, without an SDK: the curve maths, the
// instructions SPAWN uses, the legacy transaction format, the accounts it reads and the swap events it
// decodes. Layouts are the program's own (its on-chain IDL, 0.1.10, and its source at 0.2.1 agree on every
// one used here); test/dbc.test.js checks them against real mainnet data.
//
// Nothing here sends a transaction or holds anyone's key. Builders return unsigned transactions for the
// person's own wallet to sign and send. The only key made here is the fresh address of a new config or coin:
// it signs its own slot and is dropped.
import crypto from 'node:crypto';
import { b58encode, b58decode, isAddress, findProgramAddress, generateKeypair, signPartial, rpc, RPC_URL } from './solana.js';

export const DBC_PROGRAM = 'dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN';
export const POOL_AUTHORITY = 'FhVo3mqL8PW5pH5U2CN4XE33DokiyZnUwuGpH2hmHLuM';   // findProgramAddress(['pool_authority'], DBC_PROGRAM)
export const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
export const TOKEN_2022_PROGRAM = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
export const ATA_PROGRAM = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
export const SYSTEM_PROGRAM = '11111111111111111111111111111111';
export const METADATA_PROGRAM = 'metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s';
export const COMPUTE_BUDGET = 'ComputeBudget111111111111111111111111111111';
export const INCINERATOR = '1nc1nerator11111111111111111111111111111111';   // no key exists for it: what's sent there is gone
export const EVENT_AUTHORITY = findProgramAddress(['__event_authority'], DBC_PROGRAM)[0];

export const MIN_SQRT_PRICE = 4295048016n;
export const MAX_SQRT_PRICE = 79226673521066979257578248091n;
export const FEE_DENOMINATOR = 1_000_000_000n;
export const PROTOCOL_FEE_PERCENT = 20;   // Meteora's cut of every trading fee
const U64_MAX = 2n ** 64n - 1n;
const MAX_TX = 1232;

const disc = (s) => crypto.createHash('sha256').update(s).digest().subarray(0, 8);
const IX = Object.fromEntries(['create_config', 'initialize_virtual_pool_with_spl_token', 'swap2', 'claim_trading_fee', 'claim_creator_trading_fee'].map((n) => [n, disc('global:' + n)]));
const ACCOUNT = { config: disc('account:PoolConfig'), pool: disc('account:VirtualPool') };
// Anchor's emit_cpi!: the program calls itself with this tag, the event's discriminator and the event. The tag
// is the u64 0x1d9acb512ea545e4 (the first bytes of sha256('anchor:event')) written little-endian.
const EVENT_TAG = Buffer.from(disc('anchor:event')).reverse();
const EVT_SWAP2 = disc('event:EvtSwap2');   // every swap emits EvtSwap and EvtSwap2; only the second is read
export const POOL_SIZE = 8 + 416, CONFIG_SIZE = 8 + 1040;

const fail = (msg) => { throw new Error(`dbc: ${msg}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** One RPC call, retried with backoff while the node says it is busy (the public one rate-limits hard). */
async function call(method, params, { url = RPC_URL, fetchImpl = fetch, tries = 4 } = {}) {
  for (let k = 0; ; k++) {
    try { return await rpc(method, params, { url, fetchImpl }); } catch (e) {
      if (k + 1 >= tries || !/HTTP (429|5\d\d)|too many requests/i.test(e.message)) throw e;
      await sleep(400 * 2 ** k);
    }
  }
}
const check = (s, what) => { if (!isAddress(s)) fail(`${what} is not a Solana address: ${JSON.stringify(s)}`); return s; };

/* ---------- the curve: sqrt prices in Q64.64, liquidity in Q64.64, integer maths like the program ---------- */

const divUp = (a, b) => (a + b - 1n) / b;
const mulDiv = (x, y, d, up) => (up ? divUp(x * y, d) : (x * y) / d);
export const deltaBase = (lower, upper, L, up) => mulDiv(L, upper - lower, lower * upper, up);
export const deltaQuote = (lower, upper, L, up) => (up ? divUp(L * (upper - lower), 1n << 128n) : (L * (upper - lower)) >> 128n);
const liquidityFromQuote = (quote, sqrtMin, sqrtPrice) => (quote << 128n) / (sqrtPrice - sqrtMin);
const liquidityFromBase = (base, sqrtMax, sqrtPrice) => (base * sqrtPrice * sqrtMax) / (sqrtMax - sqrtPrice);
const nextSqrtFromQuoteIn = (sqrt, L, amount) => sqrt + (amount << 128n) / L;
const nextSqrtFromBaseIn = (sqrt, L, amount) => (amount ? mulDiv(L, sqrt, L + amount * sqrt, true) : sqrt);

function isqrt(n) {
  if (n < 2n) return n;
  let x = BigInt(Math.floor(Math.sqrt(Number(n))));
  for (;;) { const y = (x + n / x) >> 1n; if (y >= x && x * x <= n) break; x = y; }
  while (x * x > n) x--;
  while ((x + 1n) * (x + 1n) <= n) x++;
  return x;
}
/** floor(sqrt(num / den) · 2^64): a price in quote atoms per base atom as a Q64.64 square root. */
export const sqrtPriceQ64 = (num, den) => isqrt((BigInt(num) << 128n) / BigInt(den));

// the program's get_migration_threshold_price and get_base_token_for_swap
function migrationSqrtPrice(threshold, sqrtStart, curve) {
  let sqrt = sqrtStart, left = threshold;
  for (let i = 0; i < curve.length; i++) {
    const max = deltaQuote(sqrt, curve[i].sqrtPrice, curve[i].liquidity, true);
    if (max > left) return nextSqrtFromQuoteIn(sqrt, curve[i].liquidity, left);
    left -= max; sqrt = curve[i].sqrtPrice;
    if (!left) return sqrt;
  }
  fail('the curve holds less than the graduation threshold');
}
function baseForSwap(sqrtStart, sqrtEnd, curve) {
  let total = 0n;
  for (let i = 0; i < curve.length; i++) {
    const lower = i ? curve[i - 1].sqrtPrice : sqrtStart;
    if (curve[i].sqrtPrice > sqrtEnd) return total + deltaBase(lower, sqrtEnd, curve[i].liquidity, true);
    total += deltaBase(lower, curve[i].sqrtPrice, curve[i].liquidity, true);
  }
  return total;
}
// DAMM v2 migration: the base the new pool needs next to the graduation quote, at the graduation price
const migrationBase = (quote, sqrtMig) => deltaBase(sqrtMig, MAX_SQRT_PRICE, liquidityFromQuote(quote, MIN_SQRT_PRICE, sqrtMig), true);

/**
 * One constant-product curve from a starting to a graduation market cap, both in quote tokens, for a coin
 * with a fixed supply: Meteora's own buildCurveWithMarketCap (no vesting, no leftover, no migration fee).
 * Returns { sqrtStartPrice, curve, migrationQuoteThreshold, totalSupply } in raw units.
 */
export function buildCurve({ supply = 1_000_000_000, decimals = 6, quoteDecimals = 6, startMcap, graduationMcap }) {
  if (!(startMcap > 0 && graduationMcap > startMcap)) fail('the graduation market cap must be above the starting one');
  const r = Math.sqrt(startMcap / graduationMcap), pct = (r * 100) / (1 + r);   // % of supply that goes into the graduated pool
  const quoteAtStart = graduationMcap * pct / 100;                               // quote tokens raised by graduation
  const P = 10n ** 12n;
  const totalSupply = BigInt(supply) * 10n ** BigInt(decimals);
  const threshold = BigInt(Math.floor(quoteAtStart * 10 ** quoteDecimals));
  // graduation price = quote raised / base moved to the pool, in atoms; 12 digits of precision is plenty
  const priceNum = BigInt(Math.round(quoteAtStart * 1e6)) * P * 10n ** BigInt(quoteDecimals);
  const priceDen = BigInt(Math.round(supply * pct / 100 * 1e6)) * P * 10n ** BigInt(decimals);
  const sqrtMig = sqrtPriceQ64(priceNum, priceDen);
  const migBase = migrationBase(threshold, sqrtMig);
  const swapAmount = totalSupply - migBase;
  // the start price that puts `swapAmount` coins and `threshold` quote on one segment (the SDK's getFirstCurve),
  // nudged up until the quote side binds: then the curve reaches the threshold exactly at the graduation
  // price and never sells more coins than the supply holds, whichever way the integer rounding falls
  let sqrtStartPrice = (sqrtMig * migBase) / swapAmount, L;
  for (;;) {
    L = liquidityFromQuote(threshold, sqrtStartPrice, sqrtMig);
    if (liquidityFromBase(swapAmount, sqrtMig, sqrtStartPrice) >= L) break;
    sqrtStartPrice += sqrtStartPrice / 1_000_000_000_000n + 1n;
  }
  const curve = [{ sqrtPrice: sqrtMig, liquidity: L }];
  // whatever rounding left over sits on a last segment up to the highest price, like the SDK does
  const remaining = totalSupply - deltaBase(sqrtStartPrice, sqrtMig, L, true) - migBase;
  if (remaining > 0n) {
    const last = liquidityFromBase(remaining, MAX_SQRT_PRICE, sqrtMig);
    if (last > 0n) curve.push({ sqrtPrice: MAX_SQRT_PRICE, liquidity: last });
  }
  return { sqrtStartPrice, curve, migrationQuoteThreshold: threshold, totalSupply };
}

/**
 * What the program works out from a curve when the config is created, with the checks it makes there
 * (process_create_config): throws where the program would refuse it.
 */
export function checkCurve({ sqrtStartPrice, curve, migrationQuoteThreshold, totalSupply }) {
  if (!(sqrtStartPrice >= MIN_SQRT_PRICE && sqrtStartPrice < MAX_SQRT_PRICE)) fail('start price out of range');
  if (!curve.length || curve.length > 16 || !(curve[0].sqrtPrice > sqrtStartPrice)) fail('bad curve');
  for (let i = 0; i < curve.length; i++) if (!(curve[i].liquidity > 0n) || curve[i].sqrtPrice > MAX_SQRT_PRICE || (i && !(curve[i].sqrtPrice > curve[i - 1].sqrtPrice))) fail('bad curve point');
  const sqrtMig = migrationSqrtPrice(migrationQuoteThreshold, sqrtStartPrice, curve);
  if (!(sqrtMig < MAX_SQRT_PRICE)) fail('graduation price out of range');
  const swapBase = baseForSwap(sqrtStartPrice, sqrtMig, curve);
  const migBase = migrationBase(migrationQuoteThreshold, sqrtMig);
  if (!(swapBase > 0n && migBase > 0n)) fail('nothing to sell');
  const maxOnCurve = baseForSwap(sqrtStartPrice, MAX_SQRT_PRICE, curve);
  const buffer = [swapBase + (swapBase * 25n) / 100n, maxOnCurve].reduce((a, b) => (a < b ? a : b));
  if (swapBase + migBase > totalSupply || buffer + migBase > totalSupply) fail('the curve needs more coins than the supply');
  return { sqrtMig, swapBase, migBase, leftover: totalSupply - swapBase - migBase };
}

/** Coins out for a buy of `quoteIn` atoms (fee included) at the pool's price, like the program's exact-in swap, and the price after it. */
export function quoteBuy({ sqrtPrice, curve, migrationSqrtPrice: stop, feeNumerator = 10_000_000n }, quoteIn) {
  const fee = divUp(BigInt(quoteIn) * feeNumerator, FEE_DENOMINATOR);
  let left = BigInt(quoteIn) - fee, sqrt = BigInt(sqrtPrice), out = 0n;
  for (const seg of curve) {
    const ref = stop < seg.sqrtPrice ? stop : seg.sqrtPrice;
    if (ref <= sqrt) continue;
    const max = deltaQuote(sqrt, ref, seg.liquidity, true);
    if (left < max) { const next = nextSqrtFromQuoteIn(sqrt, seg.liquidity, left); out += deltaBase(sqrt, next, seg.liquidity, false); sqrt = next; left = 0n; break; }
    out += deltaBase(sqrt, ref, seg.liquidity, false); left -= max; sqrt = ref;
    if (ref === stop) break;
  }
  if (left) fail('that buy is bigger than what is left on the curve');
  return { out, fee, next: sqrt };
}

/**
 * Quote tokens out for a sell of `baseIn` coin atoms at the pool's price, like the program's exact-in swap. On
 * SPAWN's config the 1% comes out of what the sell pays.
 */
export function quoteSell({ sqrtPrice, curve, sqrtStartPrice, feeNumerator = 10_000_000n }, baseIn) {
  let left = BigInt(baseIn), sqrt = BigInt(sqrtPrice), out = 0n;
  for (let i = curve.length - 2; i >= 0; i--) {
    if (!(curve[i].sqrtPrice < sqrt)) continue;
    const L = curve[i + 1].liquidity, max = deltaBase(curve[i].sqrtPrice, sqrt, L, true);
    if (left < max) { const next = nextSqrtFromBaseIn(sqrt, L, left); out += deltaQuote(next, sqrt, L, false); sqrt = next; left = 0n; break; }
    out += deltaQuote(curve[i].sqrtPrice, sqrt, L, false); left -= max; sqrt = curve[i].sqrtPrice;
  }
  if (left) {
    const L = curve[0].liquidity;
    let next = nextSqrtFromBaseIn(sqrt, L, left);
    if (next < sqrtStartPrice) { next = sqrtStartPrice; left -= deltaBase(next, sqrt, L, true); } else left = 0n;
    out += deltaQuote(next, sqrt, L, false); sqrt = next;
  }
  if (left) fail('that sell is bigger than the curve can take back');
  const fee = divUp(out * BigInt(feeNumerator), FEE_DENOMINATOR);
  return { out: out - fee, fee, next: sqrt };
}

/* ---------- borsh ---------- */

class Writer {
  constructor() { this.parts = []; }
  push(b) { this.parts.push(b); return this; }
  u8(v) { return this.push(Buffer.from([Number(v)])); }
  bool(v) { return this.u8(v ? 1 : 0); }
  u16(v) { const b = Buffer.alloc(2); b.writeUInt16LE(Number(v)); return this.push(b); }
  u32(v) { const b = Buffer.alloc(4); b.writeUInt32LE(Number(v)); return this.push(b); }
  u64(v) { const x = BigInt(v); if (x < 0n || x > U64_MAX) fail(`u64 out of range: ${v}`); const b = Buffer.alloc(8); b.writeBigUInt64LE(x); return this.push(b); }
  u128(v) { const x = BigInt(v), b = Buffer.alloc(16); b.writeBigUInt64LE(x & U64_MAX); b.writeBigUInt64LE(x >> 64n, 8); return this.push(b); }
  string(s) { const b = Buffer.from(s, 'utf8'); return this.u32(b.length).push(b); }
  bytes() { return Buffer.concat(this.parts); }
}
const u128At = (d, o) => d.readBigUInt64LE(o) | (d.readBigUInt64LE(o + 8) << 64n);
const pk = (d, o) => b58encode(d.subarray(o, o + 32));

/**
 * SPAWN's config: 1% flat fee, collected in the quote token ($BRAINWORM) only; of what's left after Meteora's
 * 20%, `creatorShare` % to the coin's creator and the rest to the fee claimer (who burns it). Graduation to
 * DAMM v2 at a 1% fee with every bit of its liquidity locked for good (half the position to each side). The
 * metadata is immutable, and nothing is vested, reserved or left to anyone.
 */
export function configParameters({ sqrtStartPrice, curve, migrationQuoteThreshold, totalSupply, creatorShare = 20, feeBps = 100 }) {
  const w = new Writer();
  w.u64(BigInt(feeBps) * FEE_DENOMINATOR / 10_000n).u16(0).u64(0).u64(0).u8(0);   // base fee: flat (scheduler with no periods)
  w.u8(0);                                  // dynamic fee: none
  w.u8(0);                                  // collect_fee_mode: quote token only
  w.u8(1);                                  // migration_option: DAMM v2
  w.u8(1);                                  // activation_type: timestamp
  w.u8(0);                                  // token_type: SPL Token
  w.u8(6);                                  // token_decimal
  w.u8(0).u8(50).u8(0).u8(50);              // partner lp, partner locked, creator lp, creator locked (%): all locked for good
  w.u64(migrationQuoteThreshold).u128(sqrtStartPrice);
  w.u64(0).u64(0).u64(0).u64(0).u64(0);     // locked vesting: none
  w.u8(2);                                  // migration_fee_option: FixedBps100, the graduated pool's fee
  w.u8(1).u64(totalSupply).u64(totalSupply);   // token_supply: fixed
  w.u8(creatorShare);                       // creator_trading_fee_percentage
  w.u8(1);                                  // token_update_authority: immutable
  w.u8(0).u8(0);                            // migration fee: none
  w.u8(0).u8(0).u16(0);                     // migrated pool fee (only for the customizable option)
  w.u64(0);                                 // pool_creation_fee: free to spawn
  for (let k = 0; k < 2; k++) w.u8(0).u16(0).u16(0).u32(0).u32(0);   // partner, creator liquidity vesting: none
  w.u8(0).u16(0).u16(0).u32(0).u64(0);      // migrated pool base fee mode + market cap scheduler: none
  w.bool(false).u16(0).u8(0).u8(0);         // enable_first_swap_with_min_fee, compounding_fee_bps, padding
  w.u32(curve.length);
  for (const c of curve) w.u128(c.sqrtPrice).u128(c.liquidity);
  return w.bytes();
}

/* ---------- addresses ---------- */

const cmp = (a, b) => Buffer.compare(Buffer.from(b58decode(a)), Buffer.from(b58decode(b)));
export const poolAddress = (config, baseMint, quoteMint) => findProgramAddress(['pool', config, ...(cmp(baseMint, quoteMint) > 0 ? [baseMint, quoteMint] : [quoteMint, baseMint])], DBC_PROGRAM)[0];
export const vaultAddress = (mint, pool) => findProgramAddress(['token_vault', mint, pool], DBC_PROGRAM)[0];
export const metadataAddress = (mint) => findProgramAddress(['metadata', METADATA_PROGRAM, mint], METADATA_PROGRAM)[0];
export const ata = (owner, mint, tokenProgram = TOKEN_PROGRAM) => findProgramAddress([owner, tokenProgram, mint], ATA_PROGRAM)[0];

/* ---------- instructions and the legacy transaction format ---------- */

const meta = (pubkey, writable = false, signer = false) => ({ pubkey, writable, signer });
const ix = (programId, keys, data) => ({ programId, keys, data: Buffer.from(data) });
const dbcIx = (name, keys, args = Buffer.alloc(0)) => ix(DBC_PROGRAM, [...keys, meta(EVENT_AUTHORITY), meta(DBC_PROGRAM)], Buffer.concat([IX[name], args]));

export const computeBudget = ({ units = 300_000, microLamports = 50_000 } = {}) => [
  ix(COMPUTE_BUDGET, [], new Writer().u8(2).u32(units).bytes()),
  ix(COMPUTE_BUDGET, [], new Writer().u8(3).u64(microLamports).bytes()),
];
export const createAtaIdempotent = (payer, owner, mint, tokenProgram = TOKEN_PROGRAM) => ix(ATA_PROGRAM, [
  meta(payer, true, true), meta(ata(owner, mint, tokenProgram), true), meta(owner), meta(mint), meta(SYSTEM_PROGRAM), meta(tokenProgram),
], [1]);
const closeAccount = (account, owner, tokenProgram) => ix(tokenProgram, [meta(account, true), meta(owner, true), meta(owner, false, true)], [9]);
const burnChecked = (account, mint, owner, amount, decimals, tokenProgram) => ix(tokenProgram, [meta(account, true), meta(mint, true), meta(owner, false, true)], new Writer().u8(15).u64(amount).u8(decimals).bytes());

function shortvec(n) {
  const out = [];
  for (;;) { const b = n & 0x7f; n >>= 7; if (!n) { out.push(b); return Buffer.from(out); } out.push(b | 0x80); }
}

/** A legacy transaction with empty signature slots; the fee payer first. */
export function compileTransaction({ payer, instructions, blockhash }) {
  const keys = new Map();
  const add = (k, w, s) => { const m = keys.get(k) || { w: false, s: false }; m.w ||= w; m.s ||= s; keys.set(k, m); };
  add(payer, true, true);
  for (const i of instructions) { for (const a of i.keys) add(a.pubkey, a.writable, a.signer); add(i.programId, false, false); }
  const rank = ([k, m]) => (k === payer ? -1 : m.s ? (m.w ? 0 : 1) : m.w ? 2 : 3);
  const order = [...keys.entries()].map((e, n) => [e, n]).sort((a, b) => rank(a[0]) - rank(b[0]) || a[1] - b[1]).map(([e]) => e);
  const index = new Map(order.map(([k], n) => [k, n]));
  const nSig = order.filter(([, m]) => m.s).length;
  const header = [nSig, order.filter(([, m]) => m.s && !m.w).length, order.filter(([, m]) => !m.s && !m.w).length];
  const msg = Buffer.concat([
    Buffer.from(header), shortvec(order.length), ...order.map(([k]) => Buffer.from(b58decode(k))), Buffer.from(b58decode(blockhash)),
    shortvec(instructions.length),
    ...instructions.map((i) => Buffer.concat([Buffer.from([index.get(i.programId)]), shortvec(i.keys.length), Buffer.from(i.keys.map((a) => index.get(a.pubkey))), shortvec(i.data.length), i.data])),
  ]);
  const tx = Buffer.concat([shortvec(nSig), Buffer.alloc(64 * nSig), msg]);
  if (tx.length > MAX_TX) fail(`transaction too large (${tx.length} bytes)`);
  return new Uint8Array(tx);
}

async function blockhash({ url, fetchImpl }) {
  const r = await call('getLatestBlockhash', [{ commitment: 'confirmed' }], { url, fetchImpl });
  return r.value.blockhash;
}
const toB64 = (u8) => Buffer.from(u8).toString('base64');

/* ---------- reading accounts ---------- */

async function accounts(addresses, { url = RPC_URL, fetchImpl = fetch } = {}) {
  const out = [];
  for (let i = 0; i < addresses.length; i += 100) {
    const r = await call('getMultipleAccounts', [addresses.slice(i, i + 100), { encoding: 'base64', commitment: 'confirmed' }], { url, fetchImpl });
    for (const v of r.value) out.push(v ? { owner: v.owner, data: Buffer.from(v.data[0], 'base64') } : null);
  }
  return out;
}

export function decodeConfig(d) {
  if (d.length < CONFIG_SIZE || !d.subarray(0, 8).equals(ACCOUNT.config)) fail('not a DBC config account');
  const curve = [];
  for (let i = 0; i < 20; i++) { const o = 408 + 32 * i, liquidity = u128At(d, o + 16); if (!liquidity) break; curve.push({ sqrtPrice: u128At(d, o), liquidity }); }
  return {
    quoteMint: pk(d, 8), feeClaimer: pk(d, 40), leftoverReceiver: pk(d, 72), feeNumerator: d.readBigUInt64LE(104),
    collectFeeMode: d[232], migrationOption: d[233], tokenDecimal: d[235], tokenType: d[237], quoteTokenFlag: d[238],
    creatorShare: d[245], migrationFeeOption: d[243], swapBaseAmount: d.readBigUInt64LE(256), migrationQuoteThreshold: d.readBigUInt64LE(264),
    migrationBaseThreshold: d.readBigUInt64LE(272), migrationSqrtPrice: u128At(d, 280), fixedSupply: d[244] === 1,
    preMigrationSupply: d.readBigUInt64LE(344), sqrtStartPrice: u128At(d, 392), curve,
  };
}

export function decodePool(d) {
  if (d.length < POOL_SIZE || !d.subarray(0, 8).equals(ACCOUNT.pool)) fail('not a DBC pool account');
  return {
    config: pk(d, 72), creator: pk(d, 104), baseMint: pk(d, 136), baseVault: pk(d, 168), quoteVault: pk(d, 200),
    baseReserve: d.readBigUInt64LE(232), quoteReserve: d.readBigUInt64LE(240),
    partnerQuoteFee: d.readBigUInt64LE(272), sqrtPrice: u128At(d, 280), activationPoint: Number(d.readBigUInt64LE(296)),
    isMigrated: d[305] === 1, migrationProgress: d[308], finishedAt: Number(d.readBigUInt64LE(344)), creatorQuoteFee: d.readBigUInt64LE(360),
    totalTradingQuoteFee: d.readBigUInt64LE(336),
  };
}

/** Metaplex metadata: name, symbol and uri are borsh strings padded with NULs. */
export function decodeMetadata(d) {
  let o = 65;
  const str = () => { const n = d.readUInt32LE(o); const s = d.subarray(o + 4, o + 4 + n).toString('utf8').replace(/\0+$/, '').trim(); o += 4 + n; return s; };
  return { mint: pk(d, 33), name: str(), symbol: str(), uri: str() };
}

/** The token program a config's coins are minted under (SPAWN's own are SPL Token). */
export const baseProgramOf = (c) => (c.tokenType === 1 ? TOKEN_2022_PROGRAM : TOKEN_PROGRAM);

const configCache = new Map();
export async function fetchConfig({ address, url, fetchImpl }) {
  if (configCache.has(address)) return configCache.get(address);   // configs never change once made
  const [a] = await accounts([check(address, 'config')], { url, fetchImpl });
  if (!a || a.owner !== DBC_PROGRAM) return null;
  const c = { address, ...decodeConfig(a.data) };
  configCache.set(address, c);
  return c;
}

const metaCache = new Map();   // SPAWN's coins have immutable metadata: read each once
/** Every pool made on a config, with its coin's on-chain name and symbol. */
export async function listPools({ config, url, fetchImpl }) {
  const r = await call('getProgramAccounts', [DBC_PROGRAM, { encoding: 'base64', commitment: 'confirmed', filters: [{ dataSize: POOL_SIZE }, { memcmp: { offset: 72, bytes: check(config, 'config') } }] }], { url, fetchImpl });
  const pools = r.map((a) => ({ address: a.pubkey, ...decodePool(Buffer.from(a.account.data[0], 'base64')) }));
  const missing = pools.filter((p) => !metaCache.has(p.baseMint));
  const metas = await accounts(missing.map((p) => metadataAddress(p.baseMint)), { url, fetchImpl });
  missing.forEach((p, i) => { try { metaCache.set(p.baseMint, metas[i] ? decodeMetadata(metas[i].data) : {}); } catch { metaCache.set(p.baseMint, {}); } });
  for (const p of pools) Object.assign(p, metaCache.get(p.baseMint));
  return pools;
}

/**
 * What the page shows for a pool: price in quote tokens per coin, market cap in quote tokens, how far to
 * graduation (0..1) and whether it graduated ($BRAINWORM, like every pump.fun coin, has 6 decimals).
 */
export function poolPrice(p, c, quoteDecimals = 6) {
  const raw = Number(p.sqrtPrice) / 2 ** 64;
  const price = raw * raw * 10 ** (c.tokenDecimal - quoteDecimals);
  const supply = Number(c.fixedSupply ? c.preMigrationSupply : c.swapBaseAmount + c.migrationBaseThreshold) / 10 ** c.tokenDecimal;
  // on the curve; graduating (the curve is full and trading waits for Meteora's migrator); graduated (a DAMM v2 pool)
  const stage = p.isMigrated || p.migrationProgress === 3 ? 'graduated' : p.quoteReserve >= c.migrationQuoteThreshold || p.migrationProgress >= 1 ? 'graduating' : 'curve';
  return { price, mcap: price * supply, progress: Math.min(1, Number(p.quoteReserve) / Number(c.migrationQuoteThreshold)), graduated: stage !== 'curve', stage };
}

/** Pools by address, fresh (null for any that isn't a DBC pool). */
export async function fetchPools({ addresses, url, fetchImpl }) {
  const got = await accounts(addresses, { url, fetchImpl });
  return got.map((a, i) => { if (!a || a.owner !== DBC_PROGRAM) return null; const p = { address: addresses[i], ...decodePool(a.data) }; return Object.assign(p, metaCache.get(p.baseMint)); });
}

export async function tokenSupply({ mint, url, fetchImpl }) {
  const r = await call('getTokenSupply', [check(mint, 'mint'), { commitment: 'confirmed' }], { url, fetchImpl });
  return { initial: 1_000_000_000, current: Number(r.value.uiAmountString) };   // pump.fun mints 1,000,000,000 of every coin
}

async function mintInfo(mint, { url, fetchImpl }) {
  const [a] = await accounts([check(mint, 'mint')], { url, fetchImpl });
  if (!a || (a.owner !== TOKEN_PROGRAM && a.owner !== TOKEN_2022_PROGRAM)) fail(`${mint} is not a token mint`);
  return { program: a.owner, decimals: a.data[44] };
}

async function tokenBalance(owner, mint, program, { url, fetchImpl }) {
  const [a] = await accounts([ata(owner, mint, program)], { url, fetchImpl });
  return a ? a.data.readBigUInt64LE(64) : 0n;
}

/* ---------- instructions (pure: every account passed in or derived) ---------- */

export const ixs = {
  /** The launchpad's config; `config` is a fresh key that must sign. Leftover coins after graduation (rounding dust) go to the incinerator. */
  createConfig: ({ config, feeClaimer, quoteMint, payer, params }) => ix(DBC_PROGRAM, [
    meta(config, true, true), meta(feeClaimer), meta(INCINERATOR), meta(quoteMint), meta(payer, true, true), meta(SYSTEM_PROGRAM), meta(EVENT_AUTHORITY), meta(DBC_PROGRAM),
  ], Buffer.concat([IX.create_config, params])),

  /** A coin and its curve; `mint` is a fresh key that must sign. Returns the instruction and the pool's addresses. */
  initializePool({ config, creator, mint, quoteMint, quoteProgram, payer = creator, name, symbol, uri }) {
    const pool = poolAddress(config, mint, quoteMint), baseVault = vaultAddress(mint, pool), quoteVault = vaultAddress(quoteMint, pool);
    return {
      pool, baseVault, quoteVault,
      ix: dbcIx('initialize_virtual_pool_with_spl_token', [
        meta(config), meta(POOL_AUTHORITY), meta(creator, false, true), meta(mint, true, true), meta(quoteMint), meta(pool, true),
        meta(baseVault, true), meta(quoteVault, true), meta(metadataAddress(mint), true), meta(METADATA_PROGRAM), meta(payer, true, true),
        meta(quoteProgram), meta(TOKEN_PROGRAM), meta(SYSTEM_PROGRAM),
      ], new Writer().string(name).string(symbol).string(uri).bytes()),
    };
  },

  /** Exact-in buy with quote tokens from `trader`'s account; fails unless at least `minOut` coins come out. */
  buy: ({ config, pool, mint, quoteMint, baseVault, quoteVault, trader, quoteProgram, baseProgram = TOKEN_PROGRAM, amountIn, minOut }) => dbcIx('swap2', [
    meta(POOL_AUTHORITY), meta(config), meta(pool, true), meta(ata(trader, quoteMint, quoteProgram), true), meta(ata(trader, mint, baseProgram), true),
    meta(baseVault, true), meta(quoteVault, true), meta(mint), meta(quoteMint), meta(trader, false, true), meta(baseProgram), meta(quoteProgram),
    meta(DBC_PROGRAM),   // no referral account: Anchor reads the program's own id as None
  ], new Writer().u64(amountIn).u64(minOut).u8(0).bytes()),

  /** Exact-in sell of coins from `trader`'s account (the program reads a coin input as a sell); fails unless at least `minOut` quote tokens come out. */
  sell: ({ config, pool, mint, quoteMint, baseVault, quoteVault, trader, quoteProgram, baseProgram = TOKEN_PROGRAM, amountIn, minOut }) => dbcIx('swap2', [
    meta(POOL_AUTHORITY), meta(config), meta(pool, true), meta(ata(trader, mint, baseProgram), true), meta(ata(trader, quoteMint, quoteProgram), true),
    meta(baseVault, true), meta(quoteVault, true), meta(mint), meta(quoteMint), meta(trader, false, true), meta(baseProgram), meta(quoteProgram),
    meta(DBC_PROGRAM),
  ], new Writer().u64(amountIn).u64(minOut).u8(0).bytes()),

  /** The fee claimer's quote fees of one pool (up to `max`) into their quote account; `baseAccount` must be a token account for the coin. */
  claimPartner: ({ config, pool, mint, quoteMint, baseVault, quoteVault, feeClaimer, quoteProgram, baseProgram = TOKEN_PROGRAM, baseAccount, max }) => dbcIx('claim_trading_fee', [
    meta(POOL_AUTHORITY), meta(config), meta(pool, true), meta(baseAccount, true), meta(ata(feeClaimer, quoteMint, quoteProgram), true), meta(baseVault, true), meta(quoteVault, true),
    meta(mint), meta(quoteMint), meta(feeClaimer, false, true), meta(baseProgram), meta(quoteProgram),
  ], new Writer().u64(0).u64(max).bytes()),

  /** The creator's fees of one pool into their own accounts. */
  claimCreator: ({ pool, mint, quoteMint, baseVault, quoteVault, creator, quoteProgram, baseProgram = TOKEN_PROGRAM }) => dbcIx('claim_creator_trading_fee', [
    meta(POOL_AUTHORITY), meta(pool, true), meta(ata(creator, mint, baseProgram), true), meta(ata(creator, quoteMint, quoteProgram), true),
    meta(baseVault, true), meta(quoteVault, true), meta(mint), meta(quoteMint), meta(creator, false, true), meta(baseProgram), meta(quoteProgram),
  ], new Writer().u64(0).u64(U64_MAX).bytes()),

  closeAccount, burnChecked, createAtaIdempotent, computeBudget,
};

/* ---------- transactions SPAWN builds ---------- */

/**
 * The launchpad's config, for the owner's wallet: they pay its rent (about 0.008 SOL) and become the fee
 * claimer. The config's own address is a fresh key that signs here and is dropped.
 */
export async function buildCreateConfig({ partner, quoteMint, startMcap, graduationMcap, creatorShare = 20, url, fetchImpl }) {
  check(partner, 'partner'); check(quoteMint, 'quote mint');
  const q = await mintInfo(quoteMint, { url, fetchImpl });
  const curve = buildCurve({ quoteDecimals: q.decimals, startMcap, graduationMcap });
  checkCurve(curve);
  const config = generateKeypair();
  const create = ixs.createConfig({ config: config.address, feeClaimer: partner, quoteMint, payer: partner, params: configParameters({ ...curve, creatorShare }) });
  const raw = compileTransaction({ payer: partner, instructions: [...computeBudget({ units: 100_000 }), create], blockhash: await blockhash({ url, fetchImpl }) });
  return {
    address: config.address, tx: toB64(signPartial(raw, config)),
    curve: { graduationQuote: Number(curve.migrationQuoteThreshold) / 10 ** q.decimals, startMcap, graduationMcap, creatorShare },
  };
}

/**
 * A new coin on `config`, for its creator's wallet (fee payer and creator), with an optional first buy in
 * the quote token in the same transaction, so nobody can buy before them. The coin's mint key signs and is dropped.
 */
export async function buildCreatePool({ config, creator, name, symbol, uri, firstBuyQuote = 0, url, fetchImpl }) {
  check(creator, 'creator');
  const c = await fetchConfig({ address: config, url, fetchImpl });
  if (!c) fail('that config is not on chain');
  if (c.tokenType !== 0) fail('SPAWN makes SPL Token coins; that config is for Token-2022');
  const q = await mintInfo(c.quoteMint, { url, fetchImpl });
  const mint = generateKeypair();
  const init = ixs.initializePool({ config, creator, mint: mint.address, quoteMint: c.quoteMint, quoteProgram: q.program, name, symbol, uri });
  const instructions = [...computeBudget({ units: firstBuyQuote ? 400_000 : 250_000 }), init.ix];
  let firstBuy = null;
  const amount = BigInt(Math.floor(Number(firstBuyQuote) * 10 ** q.decimals));
  if (amount > 0n) {
    const have = await tokenBalance(creator, c.quoteMint, q.program, { url, fetchImpl });
    if (have < amount) fail(`the first buy needs ${Number(amount) / 10 ** q.decimals} of the quote token; that wallet has ${Number(have) / 10 ** q.decimals}`);
    const { out } = quoteBuy({ sqrtPrice: c.sqrtStartPrice, curve: c.curve, migrationSqrtPrice: c.migrationSqrtPrice, feeNumerator: c.feeNumerator }, amount);
    const minOut = (out * 99n) / 100n;
    instructions.push(createAtaIdempotent(creator, creator, mint.address), ixs.buy({ config, ...init, mint: mint.address, quoteMint: c.quoteMint, trader: creator, quoteProgram: q.program, amountIn: amount, minOut }));
    firstBuy = { quote: Number(amount) / 10 ** q.decimals, coins: Number(out) / 1e6, minCoins: Number(minOut) / 1e6 };
  }
  const raw = compileTransaction({ payer: creator, instructions, blockhash: await blockhash({ url, fetchImpl }) });
  return { mint: mint.address, pool: init.pool, tx: toB64(signPartial(raw, mint)), firstBuy };
}

/**
 * A trade on a coin's curve, for the trader's own wallet: a buy paid in the quote token ($BRAINWORM) or a sell for
 * it, exact-in with a floor. Works from the coin's first second, before any aggregator has indexed it.
 */
export async function buildSwap({ pool, side, trader, amountIn, minOut, url, fetchImpl }) {
  check(trader, 'trader');
  const c = await fetchConfig({ address: pool.config, url, fetchImpl });
  if (!c) fail('that config is not on chain');
  const q = await mintInfo(c.quoteMint, { url, fetchImpl });
  const baseProgram = baseProgramOf(c);
  const leg = { config: c.address, pool: pool.address, mint: pool.baseMint, quoteMint: c.quoteMint, baseVault: pool.baseVault, quoteVault: pool.quoteVault, trader, quoteProgram: q.program, baseProgram, amountIn: BigInt(amountIn), minOut: BigInt(minOut) };
  const instructions = [...computeBudget({ units: 150_000 }), side === 'sell'
    ? createAtaIdempotent(trader, trader, c.quoteMint, q.program) : createAtaIdempotent(trader, trader, pool.baseMint, baseProgram), side === 'sell' ? ixs.sell(leg) : ixs.buy(leg)];
  return { tx: toB64(compileTransaction({ payer: trader, instructions, blockhash: await blockhash({ url, fetchImpl }) })) };
}

/**
 * The instructions that claim `pools`' fee-claimer fees and burn exactly what they claim. `payer` fronts the
 * rent of the coin accounts opened and closed on the way (the fee claimer, unless told otherwise).
 */
export function claimAndBurnInstructions({ config, quoteMint, quoteProgram, quoteDecimals, feeClaimer, pools, payer = feeClaimer }) {
  const instructions = [createAtaIdempotent(payer, feeClaimer, quoteMint, quoteProgram)];
  let total = 0n;
  for (const p of pools) {
    if (p.config !== config) fail('every pool must be on the same config');
    // only quote fees accrue on SPAWN's config, but the program wants a coin account next to the claim:
    // it is opened and closed again in the same transaction, so it costs nothing
    const baseProgram = p.baseProgram || baseProgramOf(p.cfg || {}), baseAccount = ata(feeClaimer, p.baseMint, baseProgram);
    instructions.push(
      createAtaIdempotent(payer, feeClaimer, p.baseMint, baseProgram),
      ixs.claimPartner({ config, pool: p.address, mint: p.baseMint, quoteMint, baseVault: p.baseVault, quoteVault: p.quoteVault, feeClaimer, quoteProgram, baseProgram, baseAccount, max: p.partnerQuoteFee }),
      closeAccount(baseAccount, feeClaimer, baseProgram),
    );
    total += p.partnerQuoteFee;
  }
  instructions.push(burnChecked(ata(feeClaimer, quoteMint, quoteProgram), quoteMint, feeClaimer, total, quoteDecimals, quoteProgram));
  return { instructions, total };
}

/**
 * The fee claimer's share of the quote fees of `pools`, claimed and burned in the same transactions, three
 * pools to a transaction so each fits. Each claim is capped at the fees read now, so the burn is exact.
 */
export async function buildClaimAndBurn({ pools, feeClaimer, url, fetchImpl }) {
  check(feeClaimer, 'fee claimer');
  if (!pools.length) return [];
  const c = await fetchConfig({ address: pools[0].config, url, fetchImpl });
  if (c.feeClaimer !== feeClaimer) fail('that wallet is not this config\'s fee claimer');
  const q = await mintInfo(c.quoteMint, { url, fetchImpl });
  const out = [];
  for (let i = 0; i < pools.length; i += 3) {
    const batch = pools.slice(i, i + 3);
    const { instructions, total } = claimAndBurnInstructions({ config: c.address, quoteMint: c.quoteMint, quoteProgram: q.program, quoteDecimals: q.decimals, feeClaimer, pools: batch.map((p) => ({ baseProgram: baseProgramOf(c), ...p })) });
    const raw = compileTransaction({ payer: feeClaimer, instructions: [...computeBudget({ units: 60_000 + 90_000 * batch.length }), ...instructions], blockhash: await blockhash({ url, fetchImpl }) });
    out.push({ tx: toB64(raw), pools: batch.map((p) => p.address), burn: Number(total) / 10 ** q.decimals });
  }
  return out;
}

/** A creator's share of one pool's fees, to their own wallet. */
export async function buildClaimCreator({ pool, creator, url, fetchImpl }) {
  check(creator, 'creator');
  if (pool.creator !== creator) fail('only the coin\'s creator can claim its creator fees');
  const c = await fetchConfig({ address: pool.config, url, fetchImpl });
  const q = await mintInfo(c.quoteMint, { url, fetchImpl });
  const baseProgram = baseProgramOf(c);
  const instructions = [
    ...computeBudget({ units: 120_000 }), createAtaIdempotent(creator, creator, c.quoteMint, q.program), createAtaIdempotent(creator, creator, pool.baseMint, baseProgram),
    ixs.claimCreator({ pool: pool.address, mint: pool.baseMint, quoteMint: c.quoteMint, baseVault: pool.baseVault, quoteVault: pool.quoteVault, creator, quoteProgram: q.program, baseProgram }),
  ];
  return { tx: toB64(compileTransaction({ payer: creator, instructions, blockhash: await blockhash({ url, fetchImpl }) })), amount: Number(pool.creatorQuoteFee) / 10 ** q.decimals };
}

/* ---------- after graduation: the coin's DAMM v2 pool and its two locked positions ---------- */
// At graduation Meteora's migrator makes one DAMM v2 pool (token A the coin, token B the quote token) and two
// permanently locked positions, one whose NFT goes to the config's fee claimer and one to the coin's creator. The pool
// keeps charging its fee; each position's share can be claimed by whoever holds its NFT. What a claim will pay is
// only known once it has, so the fee claimer's share is burned in a second transaction, exactly what arrived.

export const DAMM_V2_PROGRAM = 'cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG';
export const DAMM_V2_POOL_AUTHORITY = 'HLnpSz9h2S4hiLQ43rnSD9XkcUThA7B8hQMKmDaiTLcC';
const DAMM_EVENT_AUTHORITY = findProgramAddress(['__event_authority'], DAMM_V2_PROGRAM)[0];
const DAMM_ACCOUNT = { pool: disc('account:Pool'), position: disc('account:Position') };
export const DAMM_POOL_SIZE = 1112, DAMM_POSITION_SIZE = 408;
const programOfFlag = (f) => (f === 1 ? TOKEN_2022_PROGRAM : TOKEN_PROGRAM);

export function decodeDammPool(d) {
  if (d.length < DAMM_POOL_SIZE || !d.subarray(0, 8).equals(DAMM_ACCOUNT.pool)) fail('not a DAMM v2 pool');
  return {
    tokenAMint: pk(d, 168), tokenBMint: pk(d, 200), tokenAVault: pk(d, 232), tokenBVault: pk(d, 264),
    tokenAProgram: programOfFlag(d[482]), tokenBProgram: programOfFlag(d[483]), collectFeeMode: d[484], protocolFeePercent: d[48],
  };
}
export function decodePosition(d) {
  if (d.length < DAMM_POSITION_SIZE || !d.subarray(0, 8).equals(DAMM_ACCOUNT.position)) fail('not a DAMM v2 position');
  return { pool: pk(d, 8), nftMint: pk(d, 40), feeAPending: d.readBigUInt64LE(136), feeBPending: d.readBigUInt64LE(144), permanentLocked: u128At(d, 184) };
}
/** The token account holding a position's NFT (its owner claims the position's fees). */
export const positionNftAccount = (nftMint) => findProgramAddress(['position_nft_account', nftMint], DAMM_V2_PROGRAM)[0];

// the DAMM v2 configs Meteora's migrator uses for each fixed fee option (FixedBps25, 30, 100, 200, 400, 600; its SDK)
export const DAMM_V2_MIGRATION_CONFIGS = ['7F6dnUcRuyM2TwR8myT1dYypFXpPSxqwKNSFNkxyNESd', '2nHK1kju6XjphBLbNxpM5XRGFj7p9U8vvNzyZiha1z6k', 'Hv8Lmzmnju6m7kcokVKvwqz7QPmdX9XfKjJsXz8RXcjp', '2c4cYd4reUYVRAB9kUUkrq55VPyy2FNQ3FDL4o12JXmq', 'AkmQWebAwFvWk55wBoCr5D62C6VVDTzi84NJuD9H7cFD', 'DbCRBj8McvPYHJG1ukj8RE15h2dCNUdTAESG49XpQ44u'];
export const dammPoolAddress = (migrationConfig, baseMint, quoteMint) => findProgramAddress(['pool', migrationConfig, ...(cmp(baseMint, quoteMint) > 0 ? [baseMint, quoteMint] : [quoteMint, baseMint])], DAMM_V2_PROGRAM)[0];

/** The graduated coin's DAMM v2 pool: at its address for a fixed fee option, else looked up by its two tokens. */
export async function findDammPool({ baseMint, quoteMint, migrationFeeOption, url, fetchImpl }) {
  const mc = DAMM_V2_MIGRATION_CONFIGS[migrationFeeOption];
  if (mc) {
    const address = dammPoolAddress(mc, check(baseMint, 'coin'), check(quoteMint, 'quote mint'));
    const [a] = await accounts([address], { url, fetchImpl });
    if (a && a.owner === DAMM_V2_PROGRAM) return { address, ...decodeDammPool(a.data) };
  }
  const r = await call('getProgramAccounts', [DAMM_V2_PROGRAM, { encoding: 'base64', commitment: 'confirmed', filters: [{ dataSize: DAMM_POOL_SIZE }, { memcmp: { offset: 168, bytes: check(baseMint, 'coin') } }, { memcmp: { offset: 200, bytes: check(quoteMint, 'quote mint') } }] }], { url, fetchImpl });
  return r.length ? { address: r[0].pubkey, ...decodeDammPool(Buffer.from(r[0].account.data[0], 'base64')) } : null;
}
/** The positions in `pool` whose NFT `owner` holds. */
export async function ownedPositions({ pool, owner, url, fetchImpl }) {
  const r = await call('getProgramAccounts', [DAMM_V2_PROGRAM, { encoding: 'base64', commitment: 'confirmed', filters: [{ dataSize: DAMM_POSITION_SIZE }, { memcmp: { offset: 8, bytes: check(pool, 'pool') } }] }], { url, fetchImpl });
  const positions = r.map((a) => ({ address: a.pubkey, ...decodePosition(Buffer.from(a.account.data[0], 'base64')) }));
  const nfts = await accounts(positions.map((p) => positionNftAccount(p.nftMint)), { url, fetchImpl });
  return positions.filter((p, i) => nfts[i] && pk(nfts[i].data, 32) === owner && nfts[i].data.readBigUInt64LE(64) === 1n).map((p) => ({ ...p, nftAccount: positionNftAccount(p.nftMint) }));
}

Object.assign(ixs, {
  /** Everything a position has earned, into its owner's accounts for both tokens. */
  claimPositionFee: ({ pool, position, nftAccount, owner }) => ix(DAMM_V2_PROGRAM, [
    meta(DAMM_V2_POOL_AUTHORITY), meta(pool.address), meta(position, true),
    meta(ata(owner, pool.tokenAMint, pool.tokenAProgram), true), meta(ata(owner, pool.tokenBMint, pool.tokenBProgram), true),
    meta(pool.tokenAVault, true), meta(pool.tokenBVault, true), meta(pool.tokenAMint), meta(pool.tokenBMint),
    meta(nftAccount), meta(owner, false, true), meta(pool.tokenAProgram), meta(pool.tokenBProgram), meta(DAMM_EVENT_AUTHORITY), meta(DAMM_V2_PROGRAM),
  ], disc('global:claim_position_fee')),
});

/**
 * Claim transactions for `owner`'s positions in the pools of graduated coins (two coins a transaction, so each fits).
 * coins: [{ baseMint, quoteMint, migrationFeeOption }]. Returns [{ tx, coins: [baseMint…] }].
 */
export async function buildClaimGraduated({ coins, owner, url, fetchImpl }) {
  check(owner, 'owner');
  const found = [];
  for (const c of coins) {
    const pool = await findDammPool({ ...c, url, fetchImpl });
    if (!pool) continue;
    const mine = await ownedPositions({ pool: pool.address, owner, url, fetchImpl });
    if (mine.length) found.push({ coin: c.baseMint, pool, mine });
  }
  const out = [];
  for (let i = 0; i < found.length; i += 2) {
    const batch = found.slice(i, i + 2), instructions = [...computeBudget({ units: 80_000 * batch.length + 40_000 })];
    for (const f of batch) {
      instructions.push(createAtaIdempotent(owner, owner, f.pool.tokenAMint, f.pool.tokenAProgram), createAtaIdempotent(owner, owner, f.pool.tokenBMint, f.pool.tokenBProgram));
      for (const p of f.mine) instructions.push(ixs.claimPositionFee({ pool: f.pool, position: p.address, nftAccount: p.nftAccount, owner }));
    }
    out.push({ tx: toB64(compileTransaction({ payer: owner, instructions, blockhash: await blockhash({ url, fetchImpl }) })), coins: batch.map((f) => f.coin) });
  }
  return out;
}

/**
 * The burn for what a confirmed claim paid `owner`: every token that arrived in their accounts, exactly, read from
 * the claim transaction. Accounts the claim opened are closed afterwards once empty (their rent comes back), except
 * for the mints in `keep`. Returns { tx, burns: [{ mint, amount }] }, or null when nothing arrived.
 */
export async function buildBurnReceived({ signature, owner, keep = [], url, fetchImpl }) {
  const tx = await call('getTransaction', [signature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 1, commitment: 'confirmed' }], { url, fetchImpl });
  if (!tx) fail('that claim is not confirmed yet');
  if (tx.meta?.err) fail('that claim failed on chain');
  const keys = tx.transaction.message.accountKeys.map((k) => (typeof k === 'string' ? k : k.pubkey));
  const pre = new Map((tx.meta.preTokenBalances || []).map((b) => [b.accountIndex, BigInt(b.uiTokenAmount.amount)]));
  const instructions = [], burns = [];
  for (const b of tx.meta.postTokenBalances || []) {
    if (b.owner !== owner) continue;
    const post = BigInt(b.uiTokenAmount.amount), opened = !pre.has(b.accountIndex), got = post - (pre.get(b.accountIndex) || 0n);
    const program = b.programId || TOKEN_PROGRAM, account = keys[b.accountIndex];
    if (got > 0n) {
      instructions.push(burnChecked(account, b.mint, owner, got, b.uiTokenAmount.decimals, program));
      burns.push({ mint: b.mint, amount: Number(got) / 10 ** b.uiTokenAmount.decimals });
    }
    if (opened && post === got && !keep.includes(b.mint)) instructions.push(closeAccount(account, owner, program));
  }
  if (!burns.length) return null;
  return { tx: toB64(compileTransaction({ payer: owner, instructions: [...computeBudget({ units: 20_000 * instructions.length + 10_000 }), ...instructions], blockhash: await blockhash({ url, fetchImpl }) })), burns };
}

/* ---------- trades: swap events come through the program calling itself (emit_cpi!), not its logs ---------- */

function decodeSwapEvent(d) {
  if (d.length < 195 || !d.subarray(0, 8).equals(EVENT_TAG) || !d.subarray(8, 16).equals(EVT_SWAP2)) return null;
  // EvtSwap2: pool, config, trade_direction (1: quote in, a buy), has_referral, params (amount_0, amount_1, swap_mode),
  // result (included_fee_input, excluded_fee_input, amount_left, output, next_sqrt_price, trading_fee, protocol_fee, referral_fee), …
  return { pool: pk(d, 16), config: pk(d, 48), buy: d[80] === 1, input: d.readBigUInt64LE(99), output: d.readBigUInt64LE(123), sqrtPrice: u128At(d, 131) };
}

/**
 * The DBC swaps in one transaction (as getTransaction returns it, encoding 'json'), on any of `configs`:
 * [{ pool, config, side, quote (atoms), coins (atoms), trader }], in order.
 */
export function tradesFromTransaction(tx, configs = null) {
  if (!tx?.meta || tx.meta.err) return [];
  const m = tx.transaction.message;
  const keys = [...m.accountKeys, ...(tx.meta.loadedAddresses?.writable || []), ...(tx.meta.loadedAddresses?.readonly || [])];
  const out = [];
  for (const g of tx.meta.innerInstructions || []) {
    for (const inner of g.instructions) {
      if (keys[inner.programIdIndex] !== DBC_PROGRAM) continue;
      let e; try { e = decodeSwapEvent(Buffer.from(b58decode(inner.data))); } catch { continue; }
      if (!e || (configs && !configs.includes(e.config))) continue;
      out.push({ pool: e.pool, config: e.config, side: e.buy ? 'buy' : 'sell', quote: e.buy ? e.input : e.output, coins: e.buy ? e.output : e.input, sqrtPrice: e.sqrtPrice, trader: keys[0] });
    }
  }
  return out;
}

export async function fetchTrades({ signature, configs, url, fetchImpl }) {
  const tx = await call('getTransaction', [signature, { encoding: 'json', maxSupportedTransactionVersion: 1, commitment: 'confirmed' }], { url, fetchImpl });
  return tx ? tradesFromTransaction(tx, configs) : null;   // null: not visible yet, try again
}

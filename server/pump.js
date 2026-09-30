// pump.fun (program 6EF8…F6P) for SPAWN, without an SDK: the accounts it reads, the curve maths, the instructions SPAWN
// uses (create_v2 with a first buy, buy_exact_sol_in, sell, collect_creator_fee, and PumpSwap's
// collect_coin_creator_fee once a coin has graduated), the legacy transaction format, and the trade events it decodes.
// Layouts: pump-fun/pump-public-docs idl/pump.json and idl/pump_amm.json; test/pump.test.js checks them.
//
// Every coin SPAWN makes names the launchpad's wallet as its pump.fun creator (create_v2's `creator` argument), so the
// creator fees of every SPAWN coin collect in one place: the launchpad's creator vault, on the curve, and its PumpSwap
// creator vault once a coin has graduated. The person launching pays for their coin and signs; the launchpad signs
// nothing.
//
// Nothing here sends a transaction or holds anyone's key. Builders return unsigned transactions for a person's own
// wallet to sign and send. The only key made here is a new coin's fresh mint: it signs its own slot and is dropped.
import crypto from 'node:crypto';
import { b58encode, b58decode, isAddress, findProgramAddress, generateKeypair, signPartial, rpc, RPC_URL, PUMP_PROGRAM, PUMP_AMM_PROGRAM, WSOL_MINT, pumpSwapPool } from './solana.js';

export { PUMP_PROGRAM, PUMP_AMM_PROGRAM };
export const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
export const TOKEN_2022_PROGRAM = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
export const ATA_PROGRAM = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
export const SYSTEM_PROGRAM = '11111111111111111111111111111111';
export const COMPUTE_BUDGET = 'ComputeBudget111111111111111111111111111111';
export const MAYHEM_PROGRAM = 'MAyhSmzXzV1pTf7LsNkrNwkWKTo4ougAJ1PPg47MD4e';
export const FEE_PROGRAM = 'pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ';
export const SOL_MINT = WSOL_MINT;
export const DECIMALS = 6, SUPPLY = 1_000_000_000;   // every pump.fun coin
const MAX_TX = 1232;

export const GLOBAL = findProgramAddress(['global'], PUMP_PROGRAM)[0];
export const MINT_AUTHORITY = findProgramAddress(['mint-authority'], PUMP_PROGRAM)[0];
export const EVENT_AUTHORITY = findProgramAddress(['__event_authority'], PUMP_PROGRAM)[0];
export const GLOBAL_VOLUME_ACCUMULATOR = findProgramAddress(['global_volume_accumulator'], PUMP_PROGRAM)[0];
export const FEE_CONFIG = findProgramAddress(['fee_config', b58decode(PUMP_PROGRAM)], FEE_PROGRAM)[0];
export const MAYHEM_GLOBAL_PARAMS = findProgramAddress(['global-params'], MAYHEM_PROGRAM)[0];
export const MAYHEM_SOL_VAULT = findProgramAddress(['sol-vault'], MAYHEM_PROGRAM)[0];
export const AMM_EVENT_AUTHORITY = findProgramAddress(['__event_authority'], PUMP_AMM_PROGRAM)[0];
export const ata = (owner, mint, tokenProgram = TOKEN_PROGRAM) => findProgramAddress([owner, tokenProgram, mint], ATA_PROGRAM)[0];
export const bondingCurve = (mint) => findProgramAddress(['bonding-curve', mint], PUMP_PROGRAM)[0];
/** A newer per-coin account every trade names after the listed ones (it may not exist yet). */
export const bondingCurveV2 = (mint) => findProgramAddress(['bonding-curve-v2', mint], PUMP_PROGRAM)[0];
export const creatorVault = (creator) => findProgramAddress(['creator-vault', creator], PUMP_PROGRAM)[0];
export const userVolumeAccumulator = (user) => findProgramAddress(['user_volume_accumulator', user], PUMP_PROGRAM)[0];
export const mayhemState = (mint) => findProgramAddress(['mayhem-state', mint], MAYHEM_PROGRAM)[0];
export const mayhemTokenVault = (mint) => ata(MAYHEM_SOL_VAULT, mint, TOKEN_2022_PROGRAM);
/** Where a graduated coin's creator fees collect on PumpSwap: wrapped SOL, owned by a PDA of the creator. */
export const ammCreatorVaultAuthority = (creator) => findProgramAddress(['creator_vault', creator], PUMP_AMM_PROGRAM)[0];
export const ammCreatorVault = (creator) => ata(ammCreatorVaultAuthority(creator), SOL_MINT, TOKEN_PROGRAM);
export { pumpSwapPool };

const disc = (s) => crypto.createHash('sha256').update(s).digest().subarray(0, 8);
const IX = Object.fromEntries(['create_v2', 'buy_exact_sol_in', 'sell', 'collect_creator_fee'].map((n) => [n, disc('global:' + n)]));
const AMM_IX = { collect_coin_creator_fee: disc('global:collect_coin_creator_fee') };
const ACCOUNT = { global: disc('account:Global'), curve: disc('account:BondingCurve'), feeConfig: disc('account:FeeConfig') };
const EVENT = { trade: disc('event:TradeEvent'), collect: disc('event:CollectCreatorFeeEvent'), ammBuy: disc('event:BuyEvent'), ammSell: disc('event:SellEvent'), ammCollect: disc('event:CollectCoinCreatorFeeEvent') };

const fail = (msg) => { throw new Error(`pump: ${msg}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const check = (s, what) => { if (!isAddress(s)) fail(`${what} is not a Solana address: ${JSON.stringify(s)}`); return s; };
/** One RPC call, retried with backoff while the node says it is busy (the public one rate-limits hard). */
async function call(method, params, { url = RPC_URL, fetchImpl = fetch, tries = 4 } = {}) {
  for (let k = 0; ; k++) {
    try { return await rpc(method, params, { url, fetchImpl, timeoutMs: 15_000 }); } catch (e) {
      if (k + 1 >= tries || !/HTTP (429|5\d\d)|too many requests/i.test(e.message)) throw e;
      await sleep(400 * 2 ** k);
    }
  }
}

class Writer {
  constructor() { this.parts = []; }
  u8(n) { this.parts.push(Buffer.from([n])); return this; }
  u32(n) { const b = Buffer.alloc(4); b.writeUInt32LE(n); this.parts.push(b); return this; }
  u64(n) { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); this.parts.push(b); return this; }
  str(s) { const b = Buffer.from(s, 'utf8'); return this.u32(b.length).raw(b); }
  pk(a) { return this.raw(Buffer.from(b58decode(a))); }
  raw(b) { this.parts.push(Buffer.from(b)); return this; }
  bytes() { return Buffer.concat(this.parts); }
}
const pk = (d, o) => b58encode(d.subarray(o, o + 32));
const u64 = (d, o) => d.readBigUInt64LE(o);

/* ---------- accounts ---------- */

/** Global: the fee recipient and a new curve's starting reserves. */
export function decodeGlobal(d) {
  if (!d.subarray(0, 8).equals(ACCOUNT.global)) fail('not the Global account');
  return {
    feeRecipient: pk(d, 41), initialVirtualTokenReserves: u64(d, 73), initialVirtualSolReserves: u64(d, 81), initialRealTokenReserves: u64(d, 89),
    tokenTotalSupply: u64(d, 97), feeRecipients: Array.from({ length: 7 }, (_, i) => pk(d, 162 + 32 * i)), createV2Enabled: d[450] === 1,
    // pump.fun's own buyback: every trade names one of these (a remaining account after the ones its IDL lists)
    buybackFeeRecipients: d.length >= 997 ? Array.from({ length: 8 }, (_, i) => pk(d, 741 + 32 * i)).filter((a) => a !== SYSTEM_PROGRAM) : [],
    buybackBps: d.length >= 1005 ? u64(d, 997) : 0n,
  };
}
/** A coin's bonding curve. Reserves are after the last trade; `complete` once it has sold out and graduates. */
export function decodeCurve(d) {
  if (!d.subarray(0, 8).equals(ACCOUNT.curve)) fail('not a bonding curve');
  return {
    virtualTokenReserves: u64(d, 8), virtualSolReserves: u64(d, 16), realTokenReserves: u64(d, 24), realSolReserves: u64(d, 32), tokenTotalSupply: u64(d, 40),
    complete: d[48] === 1, creator: pk(d, 49), mayhem: d[81] === 1, cashback: d.length > 82 && d[82] === 1,
    quoteMint: d.length >= 115 && d.subarray(83, 115).some((b) => b) ? pk(d, 83) : SOL_MINT,
  };
}
/** pump-fees' schedule: flat fees, and fees by market cap (in lamports) for coins on a curve. */
export function decodeFeeConfig(d) {
  if (!d.subarray(0, 8).equals(ACCOUNT.feeConfig)) fail('not the FeeConfig account');
  const fees = (o) => ({ lp: u64(d, o), protocol: u64(d, o + 8), creator: u64(d, o + 16) });
  const n = d.readUInt32LE(65), tiers = [];
  for (let i = 0; i < n; i++) { const o = 69 + 40 * i; tiers.push({ threshold: d.readBigUInt64LE(o) + (d.readBigUInt64LE(o + 8) << 64n), fees: fees(o + 16) }); }
  return { flat: fees(41), tiers };
}

async function accounts(addresses, { url = RPC_URL, fetchImpl = fetch } = {}) {
  const out = [];
  for (let i = 0; i < addresses.length; i += 100) {
    const r = await call('getMultipleAccounts', [addresses.slice(i, i + 100), { encoding: 'base64', commitment: 'confirmed' }], { url, fetchImpl });
    for (const v of r.value) out.push(v ? { owner: v.owner, lamports: v.lamports, data: Buffer.from(v.data[0], 'base64') } : null);
  }
  return out;
}
/** Global and the fee schedule, read together. */
export async function fetchProgramState({ url, fetchImpl } = {}) {
  const [g, f] = await accounts([GLOBAL, FEE_CONFIG], { url, fetchImpl });
  if (!g || !f) fail('could not read pump.fun\'s Global or FeeConfig account');
  return { global: decodeGlobal(g.data), fees: decodeFeeConfig(f.data) };
}
/** Each mint's bonding curve (null when it has none). */
export async function fetchCurves({ mints, url, fetchImpl }) {
  const got = await accounts(mints.map(bondingCurve), { url, fetchImpl });
  return new Map(mints.map((m, i) => [m, got[i] && got[i].owner === PUMP_PROGRAM ? decodeCurve(got[i].data) : null]));
}
/** SOL waiting in a creator's vaults: on the curve (above its rent), and on PumpSwap (wrapped). In lamports. */
export async function fetchCreatorFees({ creator, url, fetchImpl }) {
  const [v, a] = await accounts([creatorVault(creator), ammCreatorVault(creator)], { url, fetchImpl });
  const rent = 890_880n;   // a vault keeps its rent-exempt minimum
  const curve = v ? BigInt(v.lamports) - rent : 0n;
  return { curve: curve > 0n ? curve : 0n, amm: a && a.data.length >= 72 ? a.data.readBigUInt64LE(64) : 0n };
}

/* ---------- the curve: constant product on virtual reserves, integer maths like the program ---------- */

export const priceSol = (c) => (c.virtualTokenReserves ? Number(c.virtualSolReserves) / 1e9 / (Number(c.virtualTokenReserves) / 10 ** DECIMALS) : 0);
export const mcapLamports = (c) => (c.virtualTokenReserves ? (c.virtualSolReserves * c.tokenTotalSupply) / c.virtualTokenReserves : 0n);
/** How far a coin is to graduating: the share of its curve's tokens sold. */
export const progress = (c, global) => {
  const start = global?.initialRealTokenReserves || 793_100_000_000_000n;
  return c.complete ? 1 : Math.max(0, Math.min(1, 1 - Number(c.realTokenReserves) / Number(start)));
};
/** The fees on a trade of a coin with this market cap: its tier's (the highest threshold it reached), else the flat ones. */
export function feesAt(schedule, mcap) {
  let f = schedule.flat;
  for (const t of schedule.tiers) if (mcap >= t.threshold) f = t.fees;
  return f;
}
export const feeBps = (schedule, mcap) => { const f = feesAt(schedule, mcap); return f.protocol + f.creator; };
const ceilDiv = (a, b) => (a + b - 1n) / b;
/**
 * Coins out for `spendable` lamports, fees included, as buy_exact_sol_in computes it (its docs give the formula):
 * net = ⌊S·10⁴/(10⁴+fees)⌋, less any overshoot of the rounded-up fees, then ⌊(net−1)·vT/(vS+net−1)⌋.
 */
export function quoteBuy(c, schedule, spendable) {
  const f = feesAt(schedule, mcapLamports(c)), bps = f.protocol + f.creator;
  let net = (spendable * 10_000n) / (10_000n + bps);
  const fees = ceilDiv(net * f.protocol, 10_000n) + ceilDiv(net * f.creator, 10_000n);
  if (net + fees > spendable) net -= net + fees - spendable;
  let out = net > 1n ? ((net - 1n) * c.virtualTokenReserves) / (c.virtualSolReserves + net - 1n) : 0n;
  if (out > c.realTokenReserves) out = c.realTokenReserves;
  return { out, net, feeBps: bps, creatorFee: ceilDiv(net * f.creator, 10_000n) };
}
/** Lamports out for selling `tokens`, fees taken (each rounded up, like a buy's). */
export function quoteSell(c, schedule, tokens) {
  const f = feesAt(schedule, mcapLamports(c));
  const gross = (tokens * c.virtualSolReserves) / (c.virtualTokenReserves + tokens);
  const fees = ceilDiv(gross * f.protocol, 10_000n) + ceilDiv(gross * f.creator, 10_000n);
  return { out: gross > fees ? gross - fees : 0n, gross, feeBps: f.protocol + f.creator, creatorFee: ceilDiv(gross * f.creator, 10_000n) };
}
/** A brand-new curve, from Global's starting reserves. */
export const freshCurve = (global, creator) => ({
  virtualTokenReserves: global.initialVirtualTokenReserves, virtualSolReserves: global.initialVirtualSolReserves, realTokenReserves: global.initialRealTokenReserves,
  realSolReserves: 0n, tokenTotalSupply: global.tokenTotalSupply, complete: false, creator, mayhem: false, quoteMint: SOL_MINT,
});
export const minOut = (out, slippageBps) => (out * BigInt(10_000 - slippageBps)) / 10_000n;

/* ---------- instructions ---------- */

const meta = (pubkey, writable = false, signer = false) => ({ pubkey, writable, signer });
const ix = (programId, keys, data) => ({ programId, keys, data: Buffer.from(data) });

export const computeBudget = ({ units = 200_000, microLamports = 200_000 } = {}) => [
  ix(COMPUTE_BUDGET, [], new Writer().u8(2).u32(units).bytes()),
  ix(COMPUTE_BUDGET, [], new Writer().u8(3).u64(microLamports).bytes()),
];
/** Just a priority fee (the default compute limit, 200,000 per instruction, is plenty): 12 bytes, where space is short. */
export const priorityFee = (microLamports) => ix(COMPUTE_BUDGET, [], new Writer().u8(3).u64(microLamports).bytes());
const pick = (list) => list[crypto.randomInt(list.length)];
/** The fee recipients a trade names (spread over pump.fun's list, like its own site does). */
export const recipients = (global) => ({ feeRecipient: pick([global.feeRecipient, ...global.feeRecipients].filter((a) => a !== SYSTEM_PROGRAM)), buybackRecipient: global.buybackFeeRecipients.length ? pick(global.buybackFeeRecipients) : null });
export const createAtaIdempotent = (payer, owner, mint, tokenProgram = TOKEN_PROGRAM) => ix(ATA_PROGRAM, [
  meta(payer, true, true), meta(ata(owner, mint, tokenProgram), true), meta(owner), meta(mint), meta(SYSTEM_PROGRAM), meta(tokenProgram),
], [1]);
const closeAccount = (account, owner, tokenProgram) => ix(tokenProgram, [meta(account, true), meta(owner, true), meta(owner, false, true)], [9]);
const burnChecked = (account, mint, owner, amount, decimals, tokenProgram) => ix(tokenProgram, [meta(account, true), meta(mint, true), meta(owner, false, true)], new Writer().u8(15).u64(amount).u8(decimals).bytes());

export const ixs = {
  /** A new coin (Token-2022, its metadata on the mint) and its curve. `creator` gets the coin's creator fees. */
  createV2: ({ mint, user, creator, name, symbol, uri }) => ix(PUMP_PROGRAM, [
    meta(mint, true, true), meta(MINT_AUTHORITY), meta(bondingCurve(mint), true), meta(ata(bondingCurve(mint), mint, TOKEN_2022_PROGRAM), true), meta(GLOBAL),
    meta(user, true, true), meta(SYSTEM_PROGRAM), meta(TOKEN_2022_PROGRAM), meta(ATA_PROGRAM), meta(MAYHEM_PROGRAM, true), meta(MAYHEM_GLOBAL_PARAMS),
    meta(MAYHEM_SOL_VAULT, true), meta(mayhemState(mint), true), meta(mayhemTokenVault(mint), true), meta(EVENT_AUTHORITY), meta(PUMP_PROGRAM),
  ], new Writer().raw(IX.create_v2).str(name).str(symbol).str(uri).pk(creator).u8(0).bytes()),   // not mayhem mode; the optional arguments after it are left out
  /** Buy with at most `spendable` lamports, fees included, for at least `minTokens`. */
  buyExactSolIn: ({ mint, user, creator, feeRecipient, buybackRecipient, spendable, minTokens, tokenProgram = TOKEN_2022_PROGRAM }) => ix(PUMP_PROGRAM, [
    meta(GLOBAL), meta(feeRecipient, true), meta(mint), meta(bondingCurve(mint), true), meta(ata(bondingCurve(mint), mint, tokenProgram), true),
    meta(ata(user, mint, tokenProgram), true), meta(user, true, true), meta(SYSTEM_PROGRAM), meta(tokenProgram), meta(creatorVault(creator), true),
    meta(EVENT_AUTHORITY), meta(PUMP_PROGRAM), meta(GLOBAL_VOLUME_ACCUMULATOR), meta(userVolumeAccumulator(user), true), meta(FEE_CONFIG), meta(FEE_PROGRAM),
    // remaining accounts, as pump.fun's own trades pass them: the coin's bonding-curve-v2 address, then a buyback recipient
    meta(bondingCurveV2(mint)), ...(buybackRecipient ? [meta(buybackRecipient, true)] : []),
  ], new Writer().raw(IX.buy_exact_sol_in).u64(spendable).u64(minTokens).u8(0).bytes()),   // track_volume: off
  /** Sell `amount` coins for at least `minSol` lamports. */
  sell: ({ mint, user, creator, feeRecipient, buybackRecipient, amount, minSol, tokenProgram = TOKEN_2022_PROGRAM }) => ix(PUMP_PROGRAM, [
    meta(GLOBAL), meta(feeRecipient, true), meta(mint), meta(bondingCurve(mint), true), meta(ata(bondingCurve(mint), mint, tokenProgram), true),
    meta(ata(user, mint, tokenProgram), true), meta(user, true, true), meta(SYSTEM_PROGRAM), meta(creatorVault(creator), true), meta(tokenProgram),
    meta(EVENT_AUTHORITY), meta(PUMP_PROGRAM), meta(FEE_CONFIG), meta(FEE_PROGRAM),
    meta(bondingCurveV2(mint)), ...(buybackRecipient ? [meta(buybackRecipient, true)] : []),
  ], new Writer().raw(IX.sell).u64(amount).u64(minSol).bytes()),
  /** Every coin's creator fees on the curve, from the creator's vault to the creator. */
  collectCreatorFee: ({ creator }) => ix(PUMP_PROGRAM, [meta(creator, true), meta(creatorVault(creator), true), meta(SYSTEM_PROGRAM), meta(EVENT_AUTHORITY), meta(PUMP_PROGRAM)], IX.collect_creator_fee),
  /** Every graduated coin's creator fees on PumpSwap, into the creator's wrapped-SOL account. */
  ammCollectCreatorFee: ({ creator }) => ix(PUMP_AMM_PROGRAM, [
    meta(SOL_MINT), meta(TOKEN_PROGRAM), meta(creator), meta(ammCreatorVaultAuthority(creator)), meta(ammCreatorVault(creator), true),
    meta(ata(creator, SOL_MINT, TOKEN_PROGRAM), true), meta(AMM_EVENT_AUTHORITY), meta(PUMP_AMM_PROGRAM),
  ], AMM_IX.collect_coin_creator_fee),
};

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
  return (await call('getLatestBlockhash', [{ commitment: 'confirmed' }], { url, fetchImpl })).value.blockhash;
}
const toB64 = (u8) => Buffer.from(u8).toString('base64');

/* ---------- transactions ---------- */

/**
 * A new coin for `user` to sign and send: its mint (a fresh key, signed in here and dropped), its curve with
 * `creator` as the coin's creator, and `firstBuySol` of it bought for the user in the same transaction.
 * Returns { tx (base64), mint, firstBuy: { lamports, tokens, minTokens } | null }.
 */
export async function buildCreate({ user, creator, name, symbol, uri, firstBuySol = 0, slippageBps = 500, state = null, mintKey = null, url, fetchImpl }) {
  check(user, 'user'); check(creator, 'creator');
  if (!name || Buffer.byteLength(name) > 32) fail('name must be 1-32 bytes');
  if (!/^[A-Z0-9]{1,10}$/.test(symbol || '')) fail('symbol must be 1-10 letters or digits');
  if (!uri || Buffer.byteLength(uri) > 200) fail('uri must be 1-200 bytes');
  const { global, fees } = state || await fetchProgramState({ url, fetchImpl });
  if (!global.createV2Enabled) fail('pump.fun is not taking new coins right now');
  const kp = mintKey || generateKeypair(), mint = kp.address;
  const body = [ixs.createV2({ mint, user, creator, name, symbol, uri })];
  let firstBuy = null;
  const spendable = BigInt(Math.round(Number(firstBuySol || 0) * 1e9));
  if (spendable > 0n) {
    const q = quoteBuy(freshCurve(global, creator), fees, spendable);
    const minTokens = minOut(q.out, slippageBps);
    body.push(createAtaIdempotent(user, user, mint, TOKEN_2022_PROGRAM), ixs.buyExactSolIn({ mint, user, creator, ...recipients(global), spendable, minTokens }));
    firstBuy = { lamports: spendable, tokens: q.out, minTokens };
  }
  const hash = await blockhash({ url, fetchImpl });
  // with a priority fee when it fits (a 32-character name and a long link with a first buy come close to the limit)
  let tx;
  try { tx = compileTransaction({ payer: user, instructions: [priorityFee(300_000), ...body], blockhash: hash }); } catch { tx = compileTransaction({ payer: user, instructions: body, blockhash: hash }); }
  return { tx: toB64(signPartial(tx, kp)), mint, firstBuy };
}

/** A buy of a coin on its curve with `lamports` (fees included), at least `minTokens` out. `global` from fetchProgramState. */
export async function buildBuy({ mint, user, creator, lamports, minTokens, global, url, fetchImpl }) {
  check(mint, 'mint'); check(user, 'user');
  const instructions = [...computeBudget({ units: 150_000, microLamports: 300_000 }), createAtaIdempotent(user, user, mint, TOKEN_2022_PROGRAM), ixs.buyExactSolIn({ mint, user, creator, ...recipients(global), spendable: lamports, minTokens })];
  return toB64(compileTransaction({ payer: user, instructions, blockhash: await blockhash({ url, fetchImpl }) }));
}
/** A sale of `amount` coins on its curve, at least `minSol` lamports out. */
export async function buildSell({ mint, user, creator, amount, minSol, global, url, fetchImpl }) {
  check(mint, 'mint'); check(user, 'user');
  const instructions = [...computeBudget({ units: 150_000, microLamports: 300_000 }), ixs.sell({ mint, user, creator, ...recipients(global), amount, minSol })];
  return toB64(compileTransaction({ payer: user, instructions, blockhash: await blockhash({ url, fetchImpl }) }));
}
/**
 * The creator's fees from every coin, for the creator's wallet to sign: on the curve (to the wallet, in SOL) and on
 * PumpSwap (into its wrapped-SOL account, then unwrapped, so they arrive as SOL too). Only the vaults that hold some.
 */
export async function buildCollect({ creator, payer = creator, curve = true, amm = true, url, fetchImpl }) {
  check(creator, 'creator');
  const instructions = [...computeBudget({ units: 120_000 })];
  if (curve) instructions.push(ixs.collectCreatorFee({ creator }));
  if (amm) instructions.push(createAtaIdempotent(creator, creator, SOL_MINT, TOKEN_PROGRAM), ixs.ammCollectCreatorFee({ creator }), closeAccount(ata(creator, SOL_MINT, TOKEN_PROGRAM), creator, TOKEN_PROGRAM));
  if (instructions.length === 2) fail('nothing to collect');
  return toB64(compileTransaction({ payer, instructions, blockhash: await blockhash({ url, fetchImpl }) }));
}

/**
 * The burn of exactly what a confirmed swap paid `owner` in `mint` (read from that transaction), for their wallet to
 * sign. Returns { tx, amount } or null when nothing arrived.
 */
export async function buildBurnReceived({ signature, owner, mint, url, fetchImpl }) {
  const tx = await call('getTransaction', [signature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0, commitment: 'confirmed' }], { url, fetchImpl });
  if (!tx) fail('that swap is not confirmed yet');
  if (tx.meta?.err) fail('that swap failed on chain');
  const keys = tx.transaction.message.accountKeys.map((k) => (typeof k === 'string' ? k : k.pubkey));
  const pre = new Map((tx.meta.preTokenBalances || []).map((b) => [b.accountIndex, BigInt(b.uiTokenAmount.amount)]));
  for (const b of tx.meta.postTokenBalances || []) {
    if (b.owner !== owner || b.mint !== mint) continue;
    const got = BigInt(b.uiTokenAmount.amount) - (pre.get(b.accountIndex) || 0n);
    if (got <= 0n) continue;
    const instructions = [...computeBudget({ units: 30_000 }), burnChecked(keys[b.accountIndex], mint, owner, got, b.uiTokenAmount.decimals, b.programId || TOKEN_PROGRAM)];
    return { tx: toB64(compileTransaction({ payer: owner, instructions, blockhash: await blockhash({ url, fetchImpl }) })), amount: Number(got) / 10 ** b.uiTokenAmount.decimals, atoms: got };
  }
  return null;
}

/* ---------- events: pump.fun and PumpSwap log them as "Program data: <base64>" ---------- */

function decode(program, d) {
  const is = (e) => d.length >= 8 && d.subarray(0, 8).equals(e);
  if (program === PUMP_PROGRAM && is(EVENT.trade) && d.length >= 225) {
    // TradeEvent: mint @8, sol_amount @40, token_amount @48, is_buy @56, user @57, timestamp @89, virtual_sol_reserves @97,
    // virtual_token_reserves @105 (after the trade), real_sol_reserves @113, real_token_reserves @121, …, creator @177, …, creator_fee @217
    return { kind: 'trade', pool: 'pump', mint: pk(d, 8), side: d[56] ? 'buy' : 'sell', lamports: u64(d, 40), tokens: u64(d, 48), trader: pk(d, 57), ts: Number(d.readBigInt64LE(89)) * 1000,
      virtualSolReserves: u64(d, 97), virtualTokenReserves: u64(d, 105), creator: pk(d, 177), creatorFee: u64(d, 217) };
  }
  if (program === PUMP_PROGRAM && is(EVENT.collect) && d.length >= 56) return { kind: 'collect', creator: pk(d, 16), lamports: u64(d, 48) };
  if (program === PUMP_AMM_PROGRAM && (is(EVENT.ammBuy) || is(EVENT.ammSell)) && d.length >= 184) {
    // Buy/SellEvent: timestamp @8, base_amount_out|in @16, pool_base_token_reserves @48, pool_quote_token_reserves @56
    // (before the swap), quote_amount_in|out @64 (fees excluded), pool @120, user @152
    const buy = is(EVENT.ammBuy), base = u64(d, 48), quote = u64(d, 56), amount = u64(d, 16), lamports = u64(d, 64);
    const [b, q] = buy ? [base - amount, quote + lamports] : [base + amount, quote - lamports];   // reserves after it
    return { kind: 'trade', pool: 'pump-amm', address: pk(d, 120), side: buy ? 'buy' : 'sell', lamports, tokens: amount, trader: pk(d, 152), ts: Number(d.readBigInt64LE(8)) * 1000, virtualSolReserves: q, virtualTokenReserves: b };
  }
  if (program === PUMP_AMM_PROGRAM && is(EVENT.ammCollect) && d.length >= 56) return { kind: 'collect', creator: pk(d, 16), lamports: u64(d, 48) };
  return null;
}
/** The events in one transaction's logs, in order, each attributed to the program that logged it (so look-alikes from other programs are ignored). */
export function eventsFromLogs(logs) {
  const stack = [], out = [];
  for (const line of Array.isArray(logs) ? logs : []) {
    if (typeof line !== 'string') continue;
    const invoke = /^Program (\w+) invoke \[\d+\]$/.exec(line);
    if (invoke) stack.push(invoke[1]);
    else if (/^Program \w+ (success|failed)/.test(line)) stack.pop();
    else if (line.startsWith('Program data: ')) {
      let e = null;
      try { e = decode(stack.at(-1), Buffer.from(line.slice(14), 'base64')); } catch { /* not ours */ }
      if (e) out.push(e);
    }
  }
  return out;
}
/** A price after a trade, in SOL per whole coin. */
export const tradePrice = (e) => (e.virtualTokenReserves ? Number(e.virtualSolReserves) / 1e9 / (Number(e.virtualTokenReserves) / 10 ** DECIMALS) : 0);
/** A confirmed transaction's logs (null: not visible yet). */
export async function fetchLogs({ signature, url, fetchImpl }) {
  const tx = await call('getTransaction', [signature, { encoding: 'json', maxSupportedTransactionVersion: 0, commitment: 'confirmed' }], { url, fetchImpl });
  if (!tx) return null;
  return { logs: tx.meta?.err ? [] : tx.meta?.logMessages || [], blockTime: tx.blockTime ? tx.blockTime * 1000 : null, signer: tx.transaction?.message?.accountKeys?.[0] || null };
}

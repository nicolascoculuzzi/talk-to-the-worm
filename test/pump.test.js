// server/pump.js: pump.fun's instructions, quotes and events, checked against pump.fun's own recorded transactions,
// its own trade events from mainnet, and the numbers it produced in simulations.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as pump from '../server/pump.js';
import { parseTransaction, generateKeypair, pumpSwapPool, b58decode } from '../server/solana.js';

const fixture = (f) => fs.readFileSync(new URL(`./fixtures/${f}`, import.meta.url));
const addr = () => generateKeypair().address;
// Global's starting reserves and the fee schedule as pump.fun had them (September 2026)
const GLOBAL = {
  feeRecipient: '62qc2CNXwrYqQScmEdiZFFAnJR262PxWEuNQtxfafNgV', feeRecipients: [addr(), addr()], buybackFeeRecipients: [addr(), addr()],
  initialVirtualTokenReserves: 1_073_000_000_000_000n, initialVirtualSolReserves: 30_000_000_000n, initialRealTokenReserves: 793_100_000_000_000n, tokenTotalSupply: 1_000_000_000_000_000n, createV2Enabled: true,
};
const FEES = { flat: { lp: 0n, protocol: 95n, creator: 30n }, tiers: [{ threshold: 0n, fees: { lp: 0n, protocol: 95n, creator: 30n } }] };
const BLOCKHASH = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
const fakeRpc = async (url, init) => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: JSON.parse(init.body).method === 'getLatestBlockhash' ? { value: { blockhash: BLOCKHASH } } : null }));
const X = { url: 'http://rpc.test', fetchImpl: fakeRpc };

test('create_v2 is built exactly as pump.fun\'s own tooling builds it (a recorded PumpPortal transaction)', () => {
  const req = JSON.parse(fixture('pumpportal-create.json')).fixtures['pumpportal-create.bin'].request;
  const t = parseTransaction(fixture('pumpportal-create.bin')), theirs = t.instructions[2];
  const mine = pump.ixs.createV2({ mint: req.mint, user: req.publicKey, creator: req.publicKey, name: req.tokenMetadata.name, symbol: req.tokenMetadata.symbol, uri: req.tokenMetadata.uri });
  assert.ok(Buffer.from(theirs.data).equals(mine.data), 'the same bytes');
  // its static accounts are ours; the ones it loads from its lookup table are the program's fixed ones
  const loaded = { 4: pump.GLOBAL, 6: pump.SYSTEM_PROGRAM, 8: pump.ATA_PROGRAM, 14: pump.EVENT_AUTHORITY };
  theirs.accounts.forEach((a, i) => assert.equal(t.accountKeys[a] ?? loaded[i], mine.keys[i].pubkey, `account ${i}`));
  // the creator is an argument: a coin can name someone else to get its creator fees
  const other = addr(), named = pump.ixs.createV2({ mint: req.mint, user: req.publicKey, creator: other, name: 'A', symbol: 'A', uri: 'https://x.example/m/abc' });
  assert.ok(named.data.subarray(named.data.length - 33, named.data.length - 1).equals(Buffer.from(b58decode(other))), 'the creator, then mayhem mode off');
  assert.equal(named.data.at(-1), 0);
});

test('quotes match the program to the unit: buy_exact_sol_in\'s own formula, and a sale', () => {
  const fresh = pump.freshCurve(GLOBAL, addr());
  // 0.5 SOL into a new curve: what a mainnet simulation of this very transaction bought
  const q = pump.quoteBuy(fresh, FEES, 500_000_000n);
  assert.equal(q.out, 17_376_518_132_293n);
  assert.equal(q.feeBps, 125n);
  // selling it straight back: fees are taken from the SOL, each rounded up
  const after = { ...fresh, virtualSolReserves: fresh.virtualSolReserves + q.net, virtualTokenReserves: fresh.virtualTokenReserves - q.out };
  const s = pump.quoteSell(after, FEES, q.out);
  assert.ok(s.out < 500_000_000n && s.out > 485_000_000n, `about 2.5% less than paid: ${s.out}`);
  assert.equal(s.gross - s.out, (s.gross * 95n + 9_999n) / 10_000n + (s.gross * 30n + 9_999n) / 10_000n);
  // a tier applies from its threshold on
  const tiered = { flat: FEES.flat, tiers: [{ threshold: 0n, fees: { lp: 0n, protocol: 95n, creator: 30n } }, { threshold: 10n ** 12n, fees: { lp: 0n, protocol: 90n, creator: 5n } }] };
  assert.equal(pump.feeBps(tiered, 10n ** 11n), 125n);
  assert.equal(pump.feeBps(tiered, 10n ** 13n), 95n);
  assert.equal(pump.minOut(10_000n, 300), 9_700n);
  assert.ok(Math.abs(pump.priceSol(fresh) - 30 / 1_073_000_000) < 1e-15);
});

test('pump.fun\'s own trade events, recorded on mainnet, decode: the curve\'s and PumpSwap\'s', () => {
  const fx = JSON.parse(fixture('pump-tradeevent.json'));
  const [t] = pump.eventsFromLogs(fx.pump.logs).filter((e) => e.kind === 'trade');
  assert.equal(t.mint, fx.pump.mint);
  assert.equal(t.pool, 'pump');
  assert.ok(['buy', 'sell'].includes(t.side));
  assert.ok(t.lamports > 0n && t.tokens > 0n && t.virtualSolReserves > 0n);
  assert.equal(t.side, fx.pump.trades[0].side);
  assert.equal(Number(t.lamports) / 1e9, fx.pump.trades[0].sol);
  assert.ok(pump.tradePrice(t) > 0);
  const [a] = pump.eventsFromLogs(fx.pumpSwap.logs).filter((e) => e.kind === 'trade');
  assert.equal(a.pool, 'pump-amm');
  assert.equal(a.address, pumpSwapPool(fx.pumpSwap.mint));
  assert.equal(a.side, fx.pumpSwap.trades[0].side);
  // an event logged by another program is not pump.fun's
  const forged = fx.pump.logs.map((l) => l.replace(pump.PUMP_PROGRAM, addr()));
  assert.deepEqual(pump.eventsFromLogs(forged).filter((e) => e.kind === 'trade'), []);
});

test('the biggest launch fits one transaction: a 32-character name, a 10-character ticker, its link and a first buy', async () => {
  const user = addr(), creator = addr();
  const c = await pump.buildCreate({ user, creator, name: 'N'.repeat(32), symbol: 'ABCDEFGHIJ', uri: 'https://talk-to-the-worm-production.up.railway.app/m/Ab3_x9Kq-Z1w', firstBuySol: 0.5, state: { global: GLOBAL, fees: FEES }, ...X });
  const bytes = Buffer.from(c.tx, 'base64'), t = parseTransaction(bytes);
  assert.ok(bytes.length <= 1232, `${bytes.length} bytes`);
  assert.equal(t.accountKeys[0], user, 'the launcher pays');
  assert.equal(t.accountKeys[1], c.mint, 'and the fresh mint signs');
  assert.ok(t.signatures[1].some((b) => b), 'its signature is in');
  assert.ok(!t.signatures[0].some((b) => b), 'the launcher\'s slot is left for their wallet');
  assert.equal(c.firstBuy.tokens, 17_376_518_132_293n);
  // the create names our creator; the first buy pays that creator's vault, then bonding-curve-v2 and a buyback recipient
  const ixs = t.instructions.map((ix) => ({ program: t.accountKeys[ix.programIdIndex], keys: ix.accounts.map((i) => t.accountKeys[i]) }));
  const buy = ixs.find((ix) => ix.program === pump.PUMP_PROGRAM && ix.keys.length === 18);
  assert.equal(buy.keys[9], pump.creatorVault(creator));
  assert.equal(buy.keys[16], pump.bondingCurveV2(c.mint));
  assert.ok(GLOBAL.buybackFeeRecipients.includes(buy.keys[17]));
  assert.ok([GLOBAL.feeRecipient, ...GLOBAL.feeRecipients].includes(buy.keys[1]));
});

test('a sale names what pump.fun\'s own sales name; collecting takes both vaults and unwraps the SOL', async () => {
  const user = addr(), creator = addr(), mint = addr();
  const tx = parseTransaction(Buffer.from(await pump.buildSell({ mint, user, creator, amount: 5n, minSol: 1n, global: GLOBAL, ...X }), 'base64'));
  const sell = tx.instructions.find((ix) => tx.accountKeys[ix.programIdIndex] === pump.PUMP_PROGRAM);
  const keys = sell.accounts.map((i) => tx.accountKeys[i]);
  assert.equal(keys.length, 16);
  assert.deepEqual([keys[8], keys[14]], [pump.creatorVault(creator), pump.bondingCurveV2(mint)]);
  const col = parseTransaction(Buffer.from(await pump.buildCollect({ creator, ...X }), 'base64'));
  const programs = col.instructions.map((ix) => col.accountKeys[ix.programIdIndex]);
  assert.deepEqual(programs.filter((p) => p !== pump.COMPUTE_BUDGET), [pump.PUMP_PROGRAM, pump.ATA_PROGRAM, pump.PUMP_AMM_PROGRAM, pump.TOKEN_PROGRAM]);
  assert.equal(col.accountKeys[0], creator, 'the creator pays and receives');
  await assert.rejects(pump.buildCollect({ creator, curve: false, amm: false, ...X }), /nothing to collect/);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import * as dbc from '../server/dbc.js';
import { findProgramAddress, parseTransaction, verifyTransactionSignatures, generateKeypair, b58decode, b58encode } from '../server/solana.js';

// Real mainnet data, read once (finalized): a graduated Meteora DBC pool, its config, a swap on it, and a Metaplex
// metadata account. Every transaction SPAWN builds was also simulated against the live program before this was
// written (create config; config + coin; config + coin + first buy; claim and burn; creator claim): all passed.
const fx = JSON.parse(fs.readFileSync(new URL('./fixtures/dbc-mainnet.json', import.meta.url)));
const raw = (b64) => Buffer.from(b64, 'base64');
const addr = () => generateKeypair().address;
const u128 = (d, v, o) => { d.writeBigUInt64LE(v & (2n ** 64n - 1n), o); d.writeBigUInt64LE(v >> 64n, o + 8); };

test('instructions carry the discriminators in the program\'s on-chain IDL, and its fixed addresses derive', () => {
  const x = { config: addr(), mint: addr(), quoteMint: addr(), creator: addr() };
  const head = (ix) => [...ix.data.subarray(0, 8)];
  assert.deepEqual(head(dbc.ixs.createConfig({ config: x.config, feeClaimer: x.creator, quoteMint: x.quoteMint, payer: x.creator, params: Buffer.alloc(0) })), [201, 207, 243, 114, 75, 111, 47, 189]);
  const init = dbc.ixs.initializePool({ config: x.config, creator: x.creator, mint: x.mint, quoteMint: x.quoteMint, quoteProgram: dbc.TOKEN_PROGRAM, name: 'a', symbol: 'A', uri: 'u' });
  assert.deepEqual(head(init.ix), [140, 85, 215, 176, 102, 54, 104, 79]);
  const pool = { config: x.config, pool: init.pool, mint: x.mint, quoteMint: x.quoteMint, baseVault: init.baseVault, quoteVault: init.quoteVault, quoteProgram: dbc.TOKEN_PROGRAM };
  assert.deepEqual(head(dbc.ixs.buy({ ...pool, trader: x.creator, amountIn: 1n, minOut: 1n })), [65, 75, 63, 76, 235, 91, 91, 136]);
  assert.deepEqual(head(dbc.ixs.claimPartner({ ...pool, feeClaimer: x.creator, baseAccount: addr(), max: 1n })), [8, 236, 89, 49, 152, 125, 177, 81]);
  assert.deepEqual(head(dbc.ixs.claimCreator({ ...pool, creator: x.creator })), [82, 220, 250, 189, 3, 85, 107, 45]);
  assert.equal(findProgramAddress(['pool_authority'], dbc.DBC_PROGRAM)[0], dbc.POOL_AUTHORITY);
  assert.equal(dbc.EVENT_AUTHORITY, '8Ks12pbrD6PXxfty1hVQiE9sc289zgU1zHkvXhrSdriF');
});

test('a real pool and config decode, their addresses derive, and a real buy is byte-for-byte what SPAWN builds', () => {
  const pool = dbc.decodePool(raw(fx.pool.data)), cfg = { address: fx.config.address, ...dbc.decodeConfig(raw(fx.config.data)) };
  assert.equal(pool.config, fx.config.address);
  assert.equal(cfg.quoteMint, 'So11111111111111111111111111111111111111112');
  assert.equal(dbc.poolAddress(pool.config, pool.baseMint, cfg.quoteMint), fx.pool.address);
  assert.equal(dbc.vaultAddress(pool.baseMint, fx.pool.address), pool.baseVault);
  assert.equal(dbc.vaultAddress(cfg.quoteMint, fx.pool.address), pool.quoteVault);
  assert.equal(pool.migrationProgress, 3, 'graduated and migrated');
  assert.equal(pool.quoteReserve, cfg.migrationQuoteThreshold);
  assert.equal(cfg.preMigrationSupply, 10n ** 15n);
  const q = dbc.poolPrice(pool, cfg, 9);
  assert.ok(q.graduated); assert.equal(q.progress, 1);
  assert.ok(Math.abs(q.mcap - 500) < 1, `≈500 SOL at graduation, got ${q.mcap}`);

  // the swap2 in the recorded transaction, rebuilt from its own amounts
  const m = fx.swapTx.transaction.message, keys = m.accountKeys;
  const top = m.instructions.find((i) => keys[i.programIdIndex] === dbc.DBC_PROGRAM);
  const data = Buffer.from(b58decode(top.data));
  const ours = dbc.ixs.buy({
    config: cfg.address, pool: fx.pool.address, mint: pool.baseMint, quoteMint: cfg.quoteMint, baseVault: pool.baseVault, quoteVault: pool.quoteVault,
    trader: keys[0], quoteProgram: dbc.TOKEN_PROGRAM, baseProgram: dbc.TOKEN_2022_PROGRAM, amountIn: data.readBigUInt64LE(8), minOut: data.readBigUInt64LE(16),
  });
  assert.deepEqual(ours.keys.map((k) => k.pubkey), top.accounts.map((i) => keys[i]));
  assert.ok(ours.data.equals(data));
});

test('swaps are read once each from the program\'s self-CPI events, on the configs asked for', () => {
  const [t, ...rest] = dbc.tradesFromTransaction(fx.swapTx);
  assert.equal(rest.length, 0, 'EvtSwap and EvtSwap2 describe one swap');
  assert.deepEqual({ ...t, quote: String(t.quote), coins: String(t.coins), sqrtPrice: String(t.sqrtPrice) }, {
    pool: fx.pool.address, config: fx.config.address, side: 'buy', quote: '99434090', coins: '209237975803', sqrtPrice: '402041052301439599', trader: 'GyJQ7ShpVXHzwR4eCQRcQEyDYuvWBZx4cVHUoNcsC3UG',
  });
  assert.equal(dbc.tradesFromTransaction(fx.swapTx, [fx.config.address]).length, 1);
  assert.deepEqual(dbc.tradesFromTransaction(fx.swapTx, [addr()]), []);
  assert.deepEqual(dbc.tradesFromTransaction({ ...fx.swapTx, meta: { ...fx.swapTx.meta, err: { InstructionError: [0, 'x'] } } }), []);
});

test('Metaplex metadata decodes', () => {
  assert.deepEqual(dbc.decodeMetadata(raw(fx.metadata.data)), { mint: fx.metadata.mint, name: 'Bonk', symbol: 'Bonk', uri: 'https://arweave.net/QPC6FYdUn-3V8ytFNuoCS85S2tHAuiDblh6u3CIZLsw' });
  assert.equal(dbc.metadataAddress(fx.metadata.mint), fx.metadata.address);
});

test('curves land on the market caps asked for and pass every check the program makes', () => {
  const mcap = (sqrt) => (Number(sqrt) / 2 ** 64) ** 2 * 1e9;
  for (const [s, g] of [[1e6, 1.3e7], [3e7, 4e8], [5e5, 2e8], [1e4, 2e4], [2e8, 9e8], [123456, 9876543], [28, 400]]) {
    const c = dbc.buildCurve({ startMcap: s, graduationMcap: g });
    const r = dbc.checkCurve(c);
    assert.ok(Math.abs(mcap(c.sqrtStartPrice) / s - 1) < 1e-6, `start ${s}`);
    assert.ok(Math.abs(mcap(r.sqrtMig) / g - 1) < 1e-6, `graduation ${g}`);
    assert.ok(r.leftover >= 0n && r.leftover < c.totalSupply / 1_000_000n, 'at most a millionth of the supply is left over');
    // buying: out grows with what goes in, and nothing past the graduation price can be bought
    const cfg = { sqrtPrice: c.sqrtStartPrice, curve: c.curve, migrationSqrtPrice: r.sqrtMig };
    const a = dbc.quoteBuy(cfg, c.migrationQuoteThreshold / 100n).out, b = dbc.quoteBuy(cfg, c.migrationQuoteThreshold / 10n).out;
    assert.ok(a > 0n && b > a && b < r.swapBase);
    assert.throws(() => dbc.quoteBuy(cfg, c.migrationQuoteThreshold * 2n), /bigger/);
  }
  assert.throws(() => dbc.buildCurve({ startMcap: 5, graduationMcap: 5 }), /above/);
});

test('SPAWN\'s config: 1% in $BRAINWORM only, 20% of the rest to creators, fixed supply, all graduated liquidity locked', () => {
  const c = dbc.buildCurve({ startMcap: 1e6, graduationMcap: 1.3e7 });
  const p = dbc.configParameters({ ...c, creatorShare: 20 });
  assert.equal(p.length, 251);
  assert.equal(p.readBigUInt64LE(0), 10_000_000n, '1% of the 1e9 fee denominator');
  assert.equal(p[27], 0, 'no dynamic fee');
  assert.equal(p[28], 0, 'fees collected in the quote token only');
  assert.equal(p[29], 1, 'graduates to DAMM v2');
  assert.deepEqual([...p.subarray(33, 37)], [0, 50, 0, 50], 'every bit of the graduated liquidity locked for good');
  assert.equal(p.readBigUInt64LE(37), c.migrationQuoteThreshold);
  assert.equal(p[101], 2, 'the graduated pool charges 1%');
  assert.equal(p[102], 1); assert.equal(p.readBigUInt64LE(103), 10n ** 15n); assert.equal(p.readBigUInt64LE(111), 10n ** 15n);
  assert.equal(p[119], 20, 'creator share');
  assert.equal(p[120], 1, 'metadata immutable');
  assert.equal(p.readBigUInt64LE(127), 0n, 'free to spawn');
  assert.equal(p.readUInt32LE(183), c.curve.length);
});

// a stand-in RPC holding a few accounts (and, for getProgramAccounts, the accounts a program lists; for getTransaction, some transactions)
function fakeRpc(accounts, { listed = {}, txs = {} } = {}) {
  const reply = (result) => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }), { status: 200 });
  return async (url, init) => {
    const { method, params } = JSON.parse(init.body);
    if (method === 'getLatestBlockhash') return reply({ value: { blockhash: addr(), lastValidBlockHeight: 1 } });
    if (method === 'getMultipleAccounts') return reply({ value: params[0].map((a) => (accounts[a] ? { owner: accounts[a].owner, data: [accounts[a].data.toString('base64'), 'base64'] } : null)) });
    if (method === 'getProgramAccounts') return reply((listed[params[0]] || []).map((a) => ({ pubkey: a.address, account: { owner: params[0], data: [a.data.toString('base64'), 'base64'] } })));
    if (method === 'getTransaction') return reply(txs[params[0]] ?? null);
    throw new Error('unexpected ' + method);
  };
}
function configAccount({ quoteMint, feeClaimer, c }) {
  const r = dbc.checkCurve(c), d = Buffer.alloc(dbc.CONFIG_SIZE);
  crypto.createHash('sha256').update('account:PoolConfig').digest().copy(d, 0, 0, 8);
  Buffer.from(b58decode(quoteMint)).copy(d, 8); Buffer.from(b58decode(feeClaimer)).copy(d, 40);
  d.writeBigUInt64LE(10_000_000n, 104); d[233] = 1; d[235] = 6; d[244] = 1; d[245] = 20;
  d.writeBigUInt64LE(c.migrationQuoteThreshold, 264); u128(d, r.sqrtMig, 280); d.writeBigUInt64LE(c.totalSupply, 344); u128(d, c.sqrtStartPrice, 392);
  c.curve.forEach((q, i) => { u128(d, q.sqrtPrice, 408 + 32 * i); u128(d, q.liquidity, 424 + 32 * i); });
  return { owner: dbc.DBC_PROGRAM, data: d };
}
const mintAccount = (decimals = 6) => { const d = Buffer.alloc(82); d[44] = decimals; return { owner: dbc.TOKEN_PROGRAM, data: d }; };
const tokenAccount = (amount) => { const d = Buffer.alloc(165); d.writeBigUInt64LE(amount, 64); return { owner: dbc.TOKEN_PROGRAM, data: d }; };

test('a coin\'s create transaction: the creator pays and signs, the fresh mint has signed, the first buy is quoted, and it fits', async () => {
  const config = addr(), quoteMint = addr(), creator = addr(), c = dbc.buildCurve({ startMcap: 1e6, graduationMcap: 1.3e7 });
  const accounts = { [config]: configAccount({ quoteMint, feeClaimer: addr(), c }), [quoteMint]: mintAccount(), [dbc.ata(creator, quoteMint)]: tokenAccount(5000n * 10n ** 6n) };
  const fetchImpl = fakeRpc(accounts);
  const longest = { name: 'N'.repeat(32), symbol: 'S'.repeat(10), uri: 'https://ipfs.io/ipfs/bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku' };
  const r = await dbc.buildCreatePool({ config, creator, ...longest, firstBuyQuote: 1000, url: 'http://rpc.test', fetchImpl });
  const bytes = Buffer.from(r.tx, 'base64');
  assert.ok(bytes.length <= 1232, `${bytes.length} bytes`);
  const tx = parseTransaction(bytes);
  assert.equal(tx.accountKeys[0], creator);
  assert.deepEqual(verifyTransactionSignatures(bytes).map((s) => [s.address, s.present, s.valid]), [[creator, false, false], [r.mint, true, true]]);
  assert.ok(tx.instructions.some((i) => tx.accountKeys[i.programIdIndex] === dbc.DBC_PROGRAM));
  assert.equal(r.pool, dbc.poolAddress(config, r.mint, quoteMint));
  assert.ok(r.firstBuy.coins > 0 && Math.abs(r.firstBuy.minCoins / r.firstBuy.coins - 0.99) < 1e-6);
  await assert.rejects(dbc.buildCreatePool({ config, creator, ...longest, firstBuyQuote: 9000, url: 'http://rpc.test', fetchImpl }), /first buy needs/);
});

test('claim and burn: three coins a transaction, each claim capped at what was read, the burn exactly their sum', async () => {
  const config = addr(), quoteMint = addr(), owner = addr(), c = dbc.buildCurve({ startMcap: 1e6, graduationMcap: 1.3e7 });
  const fetchImpl = fakeRpc({ [config]: configAccount({ quoteMint, feeClaimer: owner, c }), [quoteMint]: mintAccount() });
  const pools = [1, 2, 3, 4].map((k) => ({ address: addr(), config, baseMint: addr(), baseVault: addr(), quoteVault: addr(), partnerQuoteFee: BigInt(k) * 1_000_000n }));
  const txs = await dbc.buildClaimAndBurn({ pools, feeClaimer: owner, url: 'http://rpc.test', fetchImpl });
  assert.deepEqual(txs.map((t) => [t.pools.length, t.burn]), [[3, 6], [1, 4]]);
  for (const t of txs) {
    const tx = parseTransaction(Buffer.from(t.tx, 'base64'));
    assert.equal(tx.header.numRequiredSignatures, 1, 'only the owner signs');
    assert.equal(tx.accountKeys[0], owner);
    const burn = tx.instructions.at(-1);
    assert.equal(burn.data[0], 15, 'BurnChecked last');
    assert.equal(Buffer.from(burn.data).readBigUInt64LE(1), BigInt(t.burn * 1e6));
  }
  await assert.rejects(dbc.buildClaimAndBurn({ pools, feeClaimer: addr(), url: 'http://rpc.test', fetchImpl }), /fee claimer/);
});

test('selling back what a buy got returns what it cost, less the two 1% fees', () => {
  const c = dbc.buildCurve({ startMcap: 1e6, graduationMcap: 1.3e7 }), r = dbc.checkCurve(c);
  const state = { sqrtPrice: c.sqrtStartPrice, curve: c.curve, sqrtStartPrice: c.sqrtStartPrice, migrationSqrtPrice: r.sqrtMig };
  for (const spend of [c.migrationQuoteThreshold / 1000n, c.migrationQuoteThreshold / 20n, c.migrationQuoteThreshold / 2n]) {
    const b = dbc.quoteBuy(state, spend);
    assert.ok(b.next > c.sqrtStartPrice && b.next <= r.sqrtMig);
    const back = dbc.quoteSell({ ...state, sqrtPrice: b.next }, b.out);
    const ratio = Number(back.out) / Number(spend);
    assert.ok(Math.abs(ratio - 0.99 * 0.99) < 1e-5, `round trip kept ${ratio}`);
    assert.ok(back.next >= c.sqrtStartPrice && Number(back.next - c.sqrtStartPrice) / Number(c.sqrtStartPrice) < 1e-9, 'the price is back where it started, give or take the rounding');
  }
  assert.throws(() => dbc.quoteSell(state, c.totalSupply), /bigger/, 'nothing to sell into at the starting price');
});

test('pools read by address, and their stage: on the curve, graduating, graduated', async () => {
  const addr1 = fx.pool.address, other = addr();
  const fetchImpl = fakeRpc({ [addr1]: { owner: fx.pool.owner, data: raw(fx.pool.data) }, [other]: { owner: dbc.TOKEN_PROGRAM, data: Buffer.alloc(165) } });
  const [p, q] = await dbc.fetchPools({ addresses: [addr1, other], url: 'http://rpc.test', fetchImpl });
  assert.equal(p.address, addr1); assert.equal(p.baseMint, dbc.decodePool(raw(fx.pool.data)).baseMint);
  assert.equal(q, null);
  const cfg = dbc.decodeConfig(raw(fx.config.data));
  assert.equal(dbc.poolPrice(p, cfg, 9).stage, 'graduated');
  assert.equal(dbc.poolPrice({ ...p, isMigrated: false, migrationProgress: 0 }, cfg, 9).stage, 'graduating', 'the curve is full');
  assert.equal(dbc.poolPrice({ ...p, isMigrated: false, migrationProgress: 0, quoteReserve: 1n }, cfg, 9).stage, 'curve');
});

test('a curve trade for the trader\'s own wallet: buy with the quote token, sell for it, exact-in with a floor', async () => {
  const config = addr(), quoteMint = addr(), trader = addr(), c = dbc.buildCurve({ startMcap: 1e6, graduationMcap: 1.3e7 });
  const fetchImpl = fakeRpc({ [config]: configAccount({ quoteMint, feeClaimer: addr(), c }), [quoteMint]: mintAccount() });
  const pool = { address: addr(), config, baseMint: addr(), baseVault: addr(), quoteVault: addr() };
  for (const side of ['buy', 'sell']) {
    const { tx } = await dbc.buildSwap({ pool, side, trader, amountIn: 1234n, minOut: 999n, url: 'http://rpc.test', fetchImpl });
    const t = parseTransaction(Buffer.from(tx, 'base64'));
    assert.equal(t.header.numRequiredSignatures, 1, 'only the trader signs');
    assert.equal(t.accountKeys[0], trader);
    const [ata, swap] = t.instructions.slice(-2);
    assert.equal(t.accountKeys[ata.programIdIndex], dbc.ATA_PROGRAM);
    assert.equal(t.accountKeys[ata.accounts[3]], side === 'buy' ? pool.baseMint : quoteMint, 'the account the trade pays into exists first');
    assert.equal(t.accountKeys[swap.programIdIndex], dbc.DBC_PROGRAM);
    const d = Buffer.from(swap.data);
    assert.deepEqual([d.readBigUInt64LE(8), d.readBigUInt64LE(16), d[24]], [1234n, 999n, 0]);
    const input = t.accountKeys[swap.accounts[3]], output = t.accountKeys[swap.accounts[4]];
    assert.deepEqual([input, output], side === 'buy' ? [dbc.ata(trader, quoteMint), dbc.ata(trader, pool.baseMint)] : [dbc.ata(trader, pool.baseMint), dbc.ata(trader, quoteMint)]);
  }
});

test('a graduated coin: its DAMM v2 pool at the address Meteora derives, the fee claimer\'s position, and the claim instruction', () => {
  const g = fx.damm, pool = { address: g.pool.address, ...dbc.decodeDammPool(raw(g.pool.data)) }, pos = dbc.decodePosition(raw(g.position.data));
  assert.equal(dbc.dammPoolAddress(dbc.DAMM_V2_MIGRATION_CONFIGS[2], g.coin, g.quote), g.pool.address, 'FixedBps100, SPAWN\'s option');
  assert.deepEqual([pool.tokenAMint, pool.tokenBMint, pool.collectFeeMode, pool.protocolFeePercent], [g.coin, g.quote, 1, 20], 'coin and quote; fees in the quote token only; Meteora keeps 20%');
  assert.equal(pos.pool, g.pool.address);
  assert.ok(pos.permanentLocked > 0n, 'locked for good');
  assert.equal(dbc.positionNftAccount(pos.nftMint), g.nftAccount.address);
  assert.equal(b58encode(raw(g.nftAccount.data).subarray(32, 64)), g.feeClaimer, 'the fee claimer holds its NFT');
  const ix = dbc.ixs.claimPositionFee({ pool, position: g.position.address, nftAccount: g.nftAccount.address, owner: g.feeClaimer });
  assert.deepEqual([...ix.data], [180, 38, 154, 17, 133, 33, 162, 211], 'claim_position_fee in DAMM v2\'s IDL, no arguments');
  assert.deepEqual(ix.keys.map((k) => k.pubkey), [
    dbc.DAMM_V2_POOL_AUTHORITY, g.pool.address, g.position.address, dbc.ata(g.feeClaimer, g.coin, pool.tokenAProgram), dbc.ata(g.feeClaimer, g.quote, pool.tokenBProgram),
    pool.tokenAVault, pool.tokenBVault, g.coin, g.quote, g.nftAccount.address, g.feeClaimer, pool.tokenAProgram, pool.tokenBProgram,
    findProgramAddress(['__event_authority'], dbc.DAMM_V2_PROGRAM)[0], dbc.DAMM_V2_PROGRAM,
  ]);
  assert.ok(ix.keys[10].signer && !ix.keys[10].writable);
});

test('claiming a graduated pool\'s fees finds the pool and the owner\'s positions, and only theirs', async () => {
  const g = fx.damm;
  const accounts = { [g.pool.address]: { owner: dbc.DAMM_V2_PROGRAM, data: raw(g.pool.data) }, [g.nftAccount.address]: { owner: g.nftAccount.owner, data: raw(g.nftAccount.data) } };
  const fetchImpl = fakeRpc(accounts, { listed: { [dbc.DAMM_V2_PROGRAM]: [{ address: g.position.address, data: raw(g.position.data) }] } });
  const coins = [{ baseMint: g.coin, quoteMint: g.quote, migrationFeeOption: 2 }];
  const [t] = await dbc.buildClaimGraduated({ coins, owner: g.feeClaimer, url: 'http://rpc.test', fetchImpl });
  assert.deepEqual(t.coins, [g.coin]);
  const tx = parseTransaction(Buffer.from(t.tx, 'base64'));
  assert.equal(tx.accountKeys[0], g.feeClaimer); assert.equal(tx.header.numRequiredSignatures, 1);
  const claims = tx.instructions.filter((i) => tx.accountKeys[i.programIdIndex] === dbc.DAMM_V2_PROGRAM);
  assert.equal(claims.length, 1);
  assert.equal(tx.accountKeys[claims[0].accounts[2]], g.position.address);
  assert.deepEqual(await dbc.buildClaimGraduated({ coins, owner: addr(), url: 'http://rpc.test', fetchImpl }), [], 'someone else holds no position there');
});

test('the burn after a graduated claim is exactly what arrived; an account the claim opened empty is closed', async () => {
  const owner = addr(), root = addr(), coin = addr(), sig = b58encode(crypto.randomBytes(64));
  const k = [owner, dbc.ata(owner, root), dbc.ata(owner, coin), addr()];
  const bal = (i, mint, amount) => ({ accountIndex: i, mint, owner, programId: dbc.TOKEN_PROGRAM, uiTokenAmount: { amount: String(amount), decimals: 6 } });
  const claimTx = { meta: { err: null, preTokenBalances: [bal(1, root, 1_000_000)], postTokenBalances: [bal(1, root, 8_500_000), bal(2, coin, 0)] }, transaction: { message: { accountKeys: k.map((pubkey) => ({ pubkey })) } } };
  const fetchImpl = fakeRpc({}, { txs: { [sig]: claimTx } });
  const r = await dbc.buildBurnReceived({ signature: sig, owner, keep: [root], url: 'http://rpc.test', fetchImpl });
  assert.deepEqual(r.burns, [{ mint: root, amount: 7.5 }], 'the 7.5 that arrived, not the 1 already there');
  const tx = parseTransaction(Buffer.from(r.tx, 'base64'));
  const token = tx.instructions.filter((i) => tx.accountKeys[i.programIdIndex] === dbc.TOKEN_PROGRAM);
  assert.equal(token.length, 2);
  assert.deepEqual([token[0].data[0], Buffer.from(token[0].data).readBigUInt64LE(1), tx.accountKeys[token[0].accounts[0]]], [15, 7_500_000n, dbc.ata(owner, root)], 'BurnChecked 7.5 from the $BRAINWORM account');
  assert.deepEqual([token[1].data[0], tx.accountKeys[token[1].accounts[0]]], [9, dbc.ata(owner, coin)], 'the empty coin account the claim opened is closed');
  assert.equal(await dbc.buildBurnReceived({ signature: sig, owner: addr(), url: 'http://rpc.test', fetchImpl }), null, 'nothing arrived for anyone else');
  await assert.rejects(dbc.buildBurnReceived({ signature: b58encode(crypto.randomBytes(64)), owner, url: 'http://rpc.test', fetchImpl }), /not confirmed/);
});

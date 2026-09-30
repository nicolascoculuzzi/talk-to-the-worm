// public/mintkey.js: the key of $WORM's contract address, made and kept in the owner's browser. Checked here in Node,
// which has the same Web Crypto.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { makeMintKey, addressOf, signSlot, b58 } from '../public/mintkey.js';
import { b58decode, b58encode, generateKeypair, parseTransaction, verifyTransactionSignatures } from '../server/solana.js';

test('a new key: its address is its public half, and its file is a Solana keypair file', async () => {
  const k = await makeMintKey();
  assert.equal(k.secret.length, 64);
  assert.equal(k.address, b58encode(k.secret.slice(32)));
  assert.equal(await addressOf(k.secret), k.address);
  const other = await makeMintKey();
  assert.notEqual(other.address, k.address);
  // a file whose halves are from different keys, or that isn't 64 numbers, is refused
  const mixed = new Uint8Array(64); mixed.set(k.secret.slice(0, 32)); mixed.set(other.secret.slice(32), 32);
  await assert.rejects(addressOf(mixed), /does not add up/);
  await assert.rejects(addressOf(new Uint8Array(63)), /64 numbers/);
  assert.equal(b58(Uint8Array.from([0, 0, 1])), b58encode(Uint8Array.from([0, 0, 1])));
});

test('the key signs its own slot of a legacy and of a v0 transaction, and nothing else', async () => {
  const k = await makeMintKey();
  // legacy: a transfer-shaped message where the key is the second signer
  const pump = await import('../server/pump.js');
  const payer = generateKeypair().address;
  const ix = { programId: pump.SYSTEM_PROGRAM, keys: [{ pubkey: payer, signer: true, writable: true }, { pubkey: k.address, signer: true, writable: true }], data: Buffer.alloc(4) };
  const legacy = pump.compileTransaction({ payer, instructions: [ix], blockhash: 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG' });
  const signed = await signSlot(legacy, k.secret);
  assert.deepEqual(verifyTransactionSignatures(signed).map((s) => [s.address, s.present, s.valid]), [[payer, false, false], [k.address, true, true]]);
  assert.ok(Buffer.from(signed.subarray(1 + 128)).equals(Buffer.from(legacy.subarray(1 + 128))), 'the message is untouched');
  // v0: pump.fun's own recorded create transaction (address lookup tables), its mint's key swapped for ours
  const bin = Uint8Array.from(fs.readFileSync(new URL('./fixtures/pumpportal-create.bin', import.meta.url)));
  const t = parseTransaction(bin), at = bin.length - t.messageBytes.length;
  const slot = t.accountKeys.indexOf(JSON.parse(fs.readFileSync(new URL('./fixtures/pumpportal-create.json', import.meta.url))).fixtures['pumpportal-create.bin'].request.mint);
  assert.ok(slot > 0 && slot < t.header.numRequiredSignatures);
  const keysAt = at + 1 + 3 + 1;   // version, header, the key count (one byte)
  const v0 = Uint8Array.from(bin);
  v0.set(b58decode(k.address), keysAt + 32 * slot);
  const signedV0 = await signSlot(v0, k.secret);
  const v = verifyTransactionSignatures(signedV0);
  assert.equal(v[slot].address, k.address);
  assert.equal(v[slot].valid, true);
  assert.equal(v[0].present, false, 'the wallet\'s slot is left for the wallet');
  // a transaction the key isn't a signer of is refused
  const stranger = await makeMintKey();
  await assert.rejects(signSlot(legacy, stranger.secret), /not one of the transaction's signers/);
});

// $WORM's contract address, made ahead of time in the owner's browser: a fresh Ed25519 key whose public half is the
// address. The key stays in this browser (and in the backup file the owner saves); the server only ever learns the
// address, and this page signs the new coin's slot of the launch transaction itself. Plain Web Crypto, so it runs in
// Node too (test/mintkey.test.js).
const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
export function b58(bytes) {
  let n = 0n;
  for (const b of bytes) n = n * 256n + BigInt(b);
  let s = '';
  while (n > 0n) { s = ALPHABET[Number(n % 58n)] + s; n /= 58n; }
  for (const b of bytes) { if (b) break; s = '1' + s; }
  return s;
}
// an Ed25519 private key's PKCS #8 wrapping, before its 32-byte seed
const PKCS8 = [0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20];
const subtle = () => {
  if (!globalThis.crypto?.subtle) throw new Error('This page cannot make keys (it has to be opened over https).');
  return globalThis.crypto.subtle;
};
const unsupported = () => new Error('This browser cannot make an Ed25519 key. Use a current Chrome, Brave, Safari or Firefox.');
const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
const fromB64url = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(s.length / 4) * 4, '=')), (c) => c.charCodeAt(0));

/** A new key: { address, secret }, the secret being 64 bytes, its seed then its public key (a Solana keypair file's layout). */
export async function makeMintKey() {
  let k;
  try { k = await subtle().generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']); } catch { throw unsupported(); }
  const pk8 = new Uint8Array(await subtle().exportKey('pkcs8', k.privateKey)), pub = new Uint8Array(await subtle().exportKey('raw', k.publicKey));
  const secret = new Uint8Array(64);
  secret.set(pk8.slice(-32)); secret.set(pub, 32);
  return { address: b58(pub), secret };
}

async function importSeed(seed, extractable = false) {
  const der = new Uint8Array(48);
  der.set(PKCS8); der.set(seed, 16);
  try { return await subtle().importKey('pkcs8', der, { name: 'Ed25519' }, extractable, ['sign']); } catch { throw unsupported(); }
}

/** The address a 64-byte secret belongs to, after checking that its two halves go together. */
export async function addressOf(secret) {
  if (!(secret instanceof Uint8Array) || secret.length !== 64 || !secret.every((x) => Number.isInteger(x) && x >= 0 && x < 256)) throw new Error('A key file holds a list of 64 numbers.');
  const jwk = await subtle().exportKey('jwk', await importSeed(secret.slice(0, 32), true));
  const pub = fromB64url(jwk.x);
  if (!same(pub, secret.slice(32))) throw new Error('That key file does not add up: its two halves are not one key.');
  return b58(pub);
}

function shortvec(b, at) {
  let n = 0, shift = 0, i = at;
  for (;;) { const x = b[i++]; n |= (x & 0x7f) << shift; if (!(x & 0x80)) break; shift += 7; }
  return [n, i];
}

/** The transaction (serialized, legacy or v0) with this key's signature in its slot. The other slots are left as they are. */
export async function signSlot(txBytes, secret) {
  const tx = Uint8Array.from(txBytes);
  const [n, first] = shortvec(tx, 0), message = first + 64 * n;
  let p = message;
  if (tx[p] & 0x80) p++;   // a versioned message starts with its version
  const required = tx[p];
  const [keys, k0] = shortvec(tx, p + 3);
  if (required !== n || keys < required) throw new Error('That is not a transaction this page can sign.');
  const pub = secret.slice(32);
  let slot = -1;
  for (let j = 0; j < required && slot < 0; j++) if (same(tx.subarray(k0 + 32 * j, k0 + 32 * j + 32), pub)) slot = j;
  if (slot < 0) throw new Error('This key is not one of the transaction\'s signers.');
  const sig = new Uint8Array(await subtle().sign({ name: 'Ed25519' }, await importSeed(secret.slice(0, 32)), tx.subarray(message)));
  tx.set(sig, first + 64 * slot);
  return tx;
}

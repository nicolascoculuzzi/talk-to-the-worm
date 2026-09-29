// Solana wallets through the Wallet Standard (Phantom, Solflare, Backpack…). The page builds nothing
// secret: the server hands over an unsigned transaction, the person's own wallet shows it, signs it
// and sends it. No key ever reaches this site.
const wallets = [];
const registry = { register(...ws) { for (const w of ws) if (!wallets.includes(w)) wallets.push(w); return () => {}; } };
addEventListener('wallet-standard:register-wallet', (e) => { try { e.detail(registry); } catch { /* a broken wallet extension */ } });
dispatchEvent(new CustomEvent('wallet-standard:app-ready', { detail: registry }));

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
export function b58(bytes) {
  let n = 0n;
  for (const b of bytes) n = n * 256n + BigInt(b);
  let s = '';
  while (n > 0n) { s = ALPHABET[Number(n % 58n)] + s; n /= 58n; }
  for (const b of bytes) { if (b) break; s = '1' + s; }
  return s;
}
export const fromB64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

let wallet = null, account = null;
export const connected = () => (account ? { name: wallet.name, address: account.address } : null);

/** Connect the first usable Solana wallet (Phantom if there are several). */
export async function connect(chain = 'solana:mainnet') {
  const usable = wallets.filter((w) => w.features['solana:signAndSendTransaction'] && w.features['standard:connect'] && (w.chains || []).some((c) => c.startsWith(chain)));
  if (!usable.length) throw new Error('No Solana wallet found in this browser (Phantom, Solflare, Backpack).');
  wallet = usable.length === 1 ? usable[0] : usable.find((w) => /phantom/i.test(w.name)) || usable[0];
  const { accounts } = await wallet.features['standard:connect'].connect();
  account = accounts[0];
  dispatchEvent(new CustomEvent('wallet-connected', { detail: connected() }));   // every form on the page shows it
  return connected();
}
export const short = (a) => `${a.slice(0, 4)}…${a.slice(-4)}`;

/** Ask the wallet to show, sign and send a base64 transaction. Returns the signature. */
export async function signAndSend(txB64, chain = 'solana:mainnet') {
  if (!account) throw new Error('Connect a wallet first.');
  const [out] = await wallet.features['solana:signAndSendTransaction'].signAndSendTransaction({ account, chain, transaction: fromB64(txB64) });
  return b58(out.signature);
}

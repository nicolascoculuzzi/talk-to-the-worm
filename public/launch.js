// The /launch page: public status and proof of the launch moment, plus the owner's controls.
// The owner's side is one step at a time: the address, the dev wallet and a check, the worm's moment, the picture, the
// launch. Signing uses the Wallet Standard (Phantom, Solflare, Backpack...): the server prepares the transaction, this
// page signs the new coin's own slot with the key it keeps for the address made ahead of time, and the owner's wallet
// adds its signature and sends it.
import { pixelWordmark } from '/pixel.js';
import { connect, connected, signAndSend, fromB64, short } from '/wallet.js';
import { makeMintKey, addressOf, signSlot } from '/mintkey.js';

const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
$('lpmark').append(pixelWordmark([{ text: 'BRAIN', cls: 'ink' }, { text: 'WORM', cls: 'amber', glow: true }]));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const compact = (n) => Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 2 }).format(n || 0);
const sol = (x) => Number(x || 0).toLocaleString('en-US', { maximumFractionDigits: 4 });
const log = (line) => { const p = $('lplog'); p.textContent = (p.textContent + '\n' + line).trim().split('\n').slice(-30).join('\n'); };
const fmtTime = (ts) => new Date(ts).toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
const breakable = (s) => s.match(/.{1,22}/g).flatMap((x, i) => (i ? [el('wbr'), x] : [x]));   // an address can wrap on a phone
const toB64 = (u8) => btoa(Array.from(u8, (x) => String.fromCharCode(x)).join(''));

/* ---------- public status ---------- */
let launchedMint = '', launchStatus = null;   // $WORM's mint, once its launch has confirmed; the public status
async function refresh() {
  const s = await fetch('/launch/status.json', { cache: 'no-store' }).then((r) => r.json()).catch(() => null);
  if (!s) return;
  launchStatus = s;
  const set = (k, on, text) => { const li = document.querySelector(`[data-k="${k}"]`); li.classList.toggle('on', !!on); $('st-' + k).textContent = text; };
  set('armed', s.armed, s.armed ? `Armed at step ${s.armed.step.toLocaleString('en-US')} (${fmtTime(s.armed.at)}). Rule: the ${s.armed.rule}.` : 'Not armed yet.');
  set('moment', s.moment, s.moment ? `Step ${s.moment.step.toLocaleString('en-US')}: ${s.moment.nAct.toLocaleString('en-US')} cells firing, cilia stopped ${Math.round((s.moment.stop ?? s.moment.startle ?? 0) * 100)}%.` : s.armed ? 'Armed. Waiting for the first time a touch stops its cilia.' : 'Waiting for the launch to be armed.');
  set('metadata', s.metadata, s.metadata ? `${s.metadata.onSite ? 'Kept on this site (the uploader refused the server)' : 'Uploaded'}: ${s.metadata.uri}` : 'Uploaded to IPFS after the moment.');
  set('launched', s.launched, s.launched ? `Mint ${s.launched.mint}` : 'Created on pump.fun from the moment.');
  if (s.launched) {
    const p = $('st-launched'); p.replaceChildren(`Mint ${s.launched.mint}`);
    if (s.launched.signature) { const a = el('a', null, 'transaction'); a.href = 'https://solscan.io/tx/' + s.launched.signature; a.target = '_blank'; a.rel = 'noopener'; p.append(' · ', a); }
  }
  if (s.moment) {
    $('lpmoment').hidden = false;
    $('lpimg').src = '/launch/moment.png?' + s.moment.imageSha256.slice(0, 8);
    const kv = $('lpkv'); kv.replaceChildren();
    const row = (k, v) => { const d = el('div'); d.append(el('dt', null, k), el('dd', null, v)); kv.append(d); };
    row('Step', s.moment.step.toLocaleString('en-US'));
    row('State SHA-256', s.moment.stateSha256);
    row('Image SHA-256', s.moment.imageSha256);
    row('Captured', fmtTime(s.moment.capturedAt));
    $('lpdesc').textContent = 'Token description: ' + s.description;
  }
  const was = launchedMint;
  launchedMint = s.launched?.mint || '';
  if (launchedMint && launchedMint !== was && owner()) spawnView();   // it just launched: SPAWN's side of it
  wizard();
}
refresh(); setInterval(refresh, 5000);

/* ---------- owner controls ---------- */
let token = sessionStorage.getItem('wormAdminToken') || '';
const owner = () => !$('lpcontrols').hidden;
async function admin(path, params = {}, area = 'launch') {
  const q = new URLSearchParams(params).toString();
  const r = await fetch(`/admin/${area}/${path}${q ? '?' + q : ''}`, { method: 'POST', headers: { Authorization: 'Bearer ' + token } });
  if (r.status === 404) { lock(); throw new Error('Wrong or expired token.'); }
  const j = await r.json();
  if (!j.ok) throw new Error(j.error || 'Failed.');
  return j;
}
function lock() {
  token = ''; sessionStorage.removeItem('wormAdminToken');
  $('lpcontrols').hidden = true; $('lplock').hidden = false;
  document.body.classList.remove('owner'); $('lpadminh').textContent = 'For the owner';
}
async function unlock() {
  const r = await fetch('/admin/state', { headers: { Authorization: 'Bearer ' + token } }).catch(() => null);
  if (!r?.ok) { lock(); $('lplockmsg').textContent = r ? 'That token is not right.' : 'The site did not answer. Try again.'; $('lplockmsg').hidden = false; return; }
  sessionStorage.setItem('wormAdminToken', token);
  $('lplockmsg').hidden = true; $('lplock').hidden = true; $('lpcontrols').hidden = false;
  document.body.classList.add('owner'); $('lpadminh').textContent = 'Launch $WORM';
  await spawnView();
}
$('lplock').addEventListener('submit', (e) => { e.preventDefault(); token = $('lptoken').value.trim(); unlock(); });
if (token) unlock();

// a button's action, with its messages in place (and in the activity log)
function act(id, msgId, fn) {
  $(id).addEventListener('click', async () => {
    const b = $(id), tell = say(msgId);
    b.disabled = true; tell('');
    try { await fn(tell); } catch (e) { tell('✗ ' + (e?.message || e), 'bad'); } finally { b.disabled = false; wizard(); refresh(); }
  });
}
const say = (msgId) => (text, kind = '') => {
  const m = $(msgId);
  m.textContent = text; m.className = 'wmsg' + (kind ? ' ' + kind : ''); m.hidden = !text;
  if (text) log(text);
};

/* ---------- $WORM's address, made ahead of time: its key is kept in this browser only ---------- */
// The server knows the address (reservedCa) and builds the launch at it; this page signs the coin's slot with the key.
// Whoever has the key could make a coin at that address first, so it never leaves this browser except as the key file
// the owner saves.
const KEY_ITEM = 'wormMintKey', SAVED_ITEM = 'wormKeySaved';
let reservedCa = '';
function localKey() {
  try { const k = JSON.parse(localStorage.getItem(KEY_ITEM) || 'null'); return k?.address && k.secret?.length === 64 ? { address: k.address, secret: Uint8Array.from(k.secret) } : null; } catch { return null; }
}
function keepKey(k) {
  try { localStorage.setItem(KEY_ITEM, JSON.stringify({ address: k.address, secret: Array.from(k.secret), at: Date.now() })); } catch { throw new Error('This browser won\'t keep the key (its site data is blocked). Allow it for this site, or use another browser.'); }
  if (localKey()?.address !== k.address) throw new Error('This browser did not keep the key. Allow site data for this site, or use another browser.');
}
const savedFor = () => { try { return localStorage.getItem(SAVED_ITEM) || ''; } catch { return ''; } };
const markSaved = (a) => { try { localStorage.setItem(SAVED_ITEM, a); } catch { /* the file is saved all the same */ } };
async function makeAddress() {
  const made = await makeMintKey();
  keepKey(made);
  await admin('reserve', { mint: made.address });
  reservedCa = made.address;
  log(`$WORM's address will be ${made.address}.`);
}

/* ---------- the steps ---------- */
const STEPS = ['ca', 'wallet', 'moment', 'meta', 'launch'];
let checked = null;   // the last check that passed: which wallet, which dev buy, and what it said
let reopened = '';    // a finished step the owner opened again
const devBuy = () => String(Math.max(0, Number($('lpbuy').value) || 0));
const pct = (worm) => (worm / 1e7).toFixed(2);   // of the billion-coin supply
function done(step) {
  const s = launchStatus || {};
  if (step === 'ca') return !!reservedCa && localKey()?.address === reservedCa && savedFor() === reservedCa;
  if (step === 'wallet') return !!checked && checked.wallet === connected()?.address && checked.amount === devBuy();
  if (step === 'moment') return !!s.moment;
  if (step === 'meta') return !!s.metadata;
  return !!s.launched;
}
function wizard() {
  if (!owner() || !launchStatus) return;
  todo();
  if (launchStatus.launched) { $('wiz').hidden = true; $('ws-done').hidden = false; return liveView(launchStatus.launched.mint); }
  $('wiz').hidden = false; $('ws-done').hidden = true;
  const now = STEPS.find((x) => !done(x));
  STEPS.forEach((x, i) => {
    const li = $('ws-' + x), fin = x !== now && done(x), open = fin && reopened === x;
    li.className = 'wstep ' + (x === now ? 'now' : fin ? 'done' : 'later') + (open ? ' open' : '');
    li.querySelector('.wn').textContent = fin ? '✓' : String(i + 1);
    li.querySelector('.whead').setAttribute('aria-expanded', String(x === now || open));
  });
  caView(); walletView(); momentView(); metaView(); launchView();
}
for (const x of STEPS) {
  $('ws-' + x).querySelector('.whead').addEventListener('click', () => {
    if (!$('ws-' + x).classList.contains('done')) return;
    reopened = reopened === x ? '' : x;
    wizard();
  });
}
addEventListener('wallet-connected', () => { wizard(); spawnWallet(); });

function caView() {
  const k = localKey(), mine = !!reservedCa && k?.address === reservedCa;
  $('ws-ca-new').hidden = mine;
  $('ws-ca-got').hidden = !mine;
  $('lpres').textContent = k && !reservedCa ? 'Use the address made in this browser' : 'Make the address';
  if (mine) $('ws-ca-addr').replaceChildren(...breakable(reservedCa));
  $('ws-ca-sum').textContent = done('ca') ? `${reservedCa} · key file saved`
    : mine ? 'Made. Save the key file to finish this step.'
    : reservedCa ? `The server has ${reservedCa}, but its key isn't in this browser: use the key file you saved, or make a new address.`
    : 'Your browser makes the coin\'s key and keeps it, so you know $WORM\'s address (CA) before the launch.';
}
function walletView() {
  const me = connected();
  $('lpcheck').textContent = me ? 'Check it works' : 'Connect wallet and check';
  $('lpswitch').hidden = !me;
  $('ws-wallet-sum').textContent = done('wallet') ? `${short(checked.wallet)} · dev buy ${sol(checked.amount)} SOL${checked.firstBuy ? ` → ${pct(checked.bought)}% of the supply` : ''} · ${sol(checked.cost)} SOL in all`
    : me ? `Connected: ${short(me.address)}. Set the dev buy, then check.`
    : 'The wallet that launches $WORM and gets its creator rewards (not SPAWN\'s rewards wallet). The check sends nothing.';
}
function momentView() {
  const s = launchStatus;
  $('ws-arm').hidden = !!s.armed || !!s.moment;
  $('ws-armed').hidden = !s.armed || !!s.moment;
  $('ws-moment-img').hidden = !s.moment;
  if (s.moment) $('ws-moment-img').src = '/launch/moment.png?' + s.moment.imageSha256.slice(0, 8);
  $('ws-moment-sum').textContent = s.moment ? `Captured at step ${s.moment.step.toLocaleString('en-US')}: this is $WORM's picture.`
    : s.armed ? `Armed at step ${s.armed.step.toLocaleString('en-US')}. Waiting for a touch to stop its cilia…`
    : 'Arm it, then touch the worm\'s head until its cilia stop. That moment becomes $WORM\'s picture.';
}
function metaView() {
  const m = launchStatus.metadata;
  $('lpmeta').textContent = m ? 'Publish again' : 'Publish';
  $('ws-meta-sum').textContent = m ? `Published ${m.onSite ? 'on this site' : 'on IPFS'}.` : 'Puts the picture and $WORM\'s description online, where pump.fun and wallets read them. The links are optional.';
}
function launchView() {
  $('ws-launch-sum').textContent = `One transaction creates $WORM${reservedCa ? ` at ${short(reservedCa)}` : ''} with a ${sol(devBuy())} SOL dev buy${checked?.firstBuy ? ` (about ${pct(checked.bought)}% of the supply)` : ''}. Your wallet shows it and you approve it.`;
}
function liveView(mint) {
  $('ws-done-ca').replaceChildren(...breakable(mint));
  $('ws-pump').href = 'https://pump.fun/coin/' + mint;
  $('ws-solscan').href = 'https://solscan.io/token/' + mint;
  const next = spState && !spState.owner;
  $('ws-next').textContent = next ? 'Next, open SPAWN: in SPAWN tools below, connect a different wallet (not the dev wallet) and press "Use this wallet for SPAWN".' : '';
  if (next && !liveView.opened) { $('lpspawnbox').open = true; liveView.opened = true; }
}

/* step 1: the address */
act('lpres', 'ws-ca-msg', async () => {
  const k = localKey();
  if (k && !reservedCa) { await admin('reserve', { mint: k.address }); reservedCa = k.address; return; }
  await makeAddress();
});
act('lpnew', 'ws-ca-msg', async () => {
  if (!confirm(`Make a different address?\n\n${reservedCa} will never be used, and this browser forgets its key.`)) return;
  await makeAddress();
});
act('lpbak', 'ws-ca-msg', async () => {
  const k = localKey();
  if (!k) throw new Error('This browser has no key.');
  const a = el('a'), name = `worm-ca-${k.address}.json`;
  a.href = URL.createObjectURL(new Blob([JSON.stringify(Array.from(k.secret))], { type: 'application/json' }));
  a.download = name;
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
  markSaved(k.address);
  log(`Saved ${name}, the key of $WORM's address (a Solana keypair file).`);
});
$('lpload').addEventListener('change', async (e) => {
  const f = e.target.files?.[0], tell = say('ws-ca-msg');
  e.target.value = '';
  if (!f) return;
  tell('');
  try {
    let list = null;
    try { list = JSON.parse(await f.text()); } catch { /* not JSON */ }
    if (!Array.isArray(list) || list.length !== 64 || !list.every((x) => Number.isInteger(x) && x >= 0 && x < 256)) throw new Error('A key file holds a list of 64 numbers.');
    const secret = Uint8Array.from(list), address = await addressOf(secret);
    if (reservedCa && reservedCa !== address && !confirm(`This key is for ${address}, but the server has ${reservedCa}. Use ${address} for $WORM instead?`)) return;
    keepKey({ address, secret });
    if (reservedCa !== address) await admin('reserve', { mint: address });
    reservedCa = address;
    markSaved(address);
    log(`Loaded the key of ${address}.`);
  } catch (err) { tell('✗ ' + err.message, 'bad'); } finally { wizard(); }
});

/* step 2: the dev wallet, and the launch run on Solana without sending it (nothing is signed, nothing moves) */
$('lpbuy').addEventListener('input', () => wizard());
act('lpswitch', 'ws-wallet-msg', async () => { await connect(); });
act('lpcheck', 'ws-wallet-msg', async (tell) => {
  if (!connected()) await connect();
  const me = connected().address, amount = devBuy(), box = $('ws-check');
  tell('Checking on Solana. Nothing is signed or sent…');
  const c = await admin('check', { creator: me, amountSol: amount });
  tell('');
  box.hidden = false;
  if (!c.works) {
    checked = null;
    box.replaceChildren(el('div', 'wcheck'));
    box.firstChild.append(el('b', 'no', '✗ It would not work'), el('span', null, c.error));
    log(`Check: it would not work: ${c.error}`);
    return;
  }
  checked = { wallet: me, amount, ...c };
  const lines = [
    el('b', 'ok', '✓ It works'),
    el('span', null, `Creates $WORM at ${c.mint} with ${short(me)} as its creator.`),
    el('span', null, c.firstBuy ? `Dev buy ${sol(c.firstBuy.sol)} SOL → ${compact(c.bought)} $WORM, ${pct(c.bought)}% of the supply.` : 'No dev buy.'),
    el('span', null, `Takes ${sol(c.cost)} SOL from the wallet in all${c.creatorFee ? ` (${sol(c.creatorFee)} SOL of it comes back as your creator rewards)` : ''}. The wallet has ${sol(c.balance)} SOL.`),
  ];
  box.replaceChildren(el('div', 'wcheck'));
  box.firstChild.append(...lines);
  log(`Check: it works. ${lines.slice(1).map((x) => x.textContent).join(' ')}`);
});

/* step 3: the worm's moment */
act('lparm', 'ws-moment-msg', async () => { await admin('arm'); log('Armed.'); });
act('lpdisarm', 'ws-moment-msg', async () => { await admin('disarm'); log('Disarmed.'); });

/* step 4: the picture and description */
act('lpmeta', 'ws-meta-msg', async (tell) => {
  tell('Publishing…');
  const j = await admin('metadata', { twitter: $('lptw').value.trim(), telegram: $('lptg').value.trim() });
  tell('');
  log(j.metadata.onSite ? `Published on this site (the uploader said: ${j.metadata.onSite}): ${j.metadata.uri}` : `Published: ${j.metadata.uri}`);
});

/* step 5: the launch, one click: prepared, the coin's slot signed here, then the wallet signs and sends */
act('lpgo', 'ws-launch-msg', async (tell) => {
  if (!connected()) throw new Error('Connect your dev wallet first (step 2).');
  const k = localKey();
  if (!reservedCa || k?.address !== reservedCa) throw new Error('This browser doesn\'t have the address\'s key (step 1).');
  tell('Preparing the transaction…');
  const j = await admin('prepare', { creator: connected().address, amountSol: devBuy() });
  if (j.mint !== k.address) throw new Error('The server prepared another address than this browser\'s key. Reload the page.');
  const tx = j.mintSigned ? j.tx : toB64(await signSlot(fromB64(j.tx), k.secret));
  tell('Approve it in your wallet…');
  const signature = await signAndSend(tx);
  log(`Sent: ${signature}`);
  tell('Sent. Waiting for Solana to confirm it…');
  for (let i = 0; i < 20; i++) {
    await sleep(3000);
    const c = await admin('confirm', { signature }).catch((e) => ({ ok: false, error: e.message }));
    if (c.ok) { tell('✓ Launched.', 'good'); return; }
  }
  tell('Not confirmed yet. The site keeps watching the chain and shows it here as soon as it lands. Launch again only if Solscan says it failed.');
});
act('lpcopy', 'ws-done-msg', async () => {
  await navigator.clipboard.writeText(launchedMint);
  $('lpcopy').textContent = 'Copied';
  setTimeout(() => { $('lpcopy').textContent = 'Copy the address'; }, 1600);
});

/* ---------- SPAWN tools: its rewards wallet, collecting the creator rewards, and the $WORM buyback and burn ---------- */
// Every coin launched on SPAWN is a pump.fun coin that names SPAWN's rewards wallet as its creator, so every coin's
// creator rewards collect in that wallet's pump.fun vaults. The owner collects them (one transaction); 64% of all that
// was collected buys $WORM (one transaction, on its curve or through Jupiter), and exactly what that bought is burned
// (one more). The other 36% stays in the wallet. The server builds each transaction; the owner's wallet signs and sends.
let spState = null, siteMint = '', tokenMintSet = false;
async function spawnView() {
  const r = await fetch('/admin/state', { headers: { Authorization: 'Bearer ' + token } }).catch(() => null);
  if (!r || !r.ok) return;
  const a = await r.json(), st = spState = a.spawn;
  siteMint = a.trades?.mint || '';   // what the site itself knows: TOKEN_MINT, or the launch record
  tokenMintSet = !!a.tokenMintSet;
  reservedCa = a.launchReserved || '';
  const w = st.rewards || {}, v = st.vaults || {};
  const parts = [st.open ? 'Open.' : 'Not open yet.'];
  parts.push(st.owner ? `Rewards wallet: ${st.owner}${st.ownerFromEnv ? ' (set by SPAWN_OWNER)' : ''}.` : 'No rewards wallet yet: connect the one that will collect SPAWN\'s creator rewards (not the one that launches $WORM) and press "Use this wallet for SPAWN".');
  parts.push(`${st.coins} coin${st.coins === 1 ? '' : 's'}.`);
  parts.push(`Creator rewards: ${sol((v.curve || 0) + (v.amm || 0))} SOL waiting in SPAWN's vaults, ${sol(w.collected)} SOL collected, ${sol(w.spent)} SOL spent on $WORM, ${sol(w.owed)} SOL owed to the buyback. ${compact(st.burned)} $WORM burned.`);
  if (st.pendingBuyback) parts.push(`A buyback of ${sol(st.pendingBuyback.sol)} SOL is being settled${st.pendingBuyback.signature ? '' : ' (its transaction not seen yet)'}.`);
  if (st.heldWorm > 0) parts.push(`${compact(st.heldWorm)} $WORM in SPAWN's wallet waiting to be burned.`);
  if (st.broken) parts.push('Its records could not be read: SPAWN is shut until someone looks at them.');
  $('spstatus').textContent = parts.join(' ');
  $('spowner').hidden = !!st.ownerFromEnv;
  const wormMint = launchedMint || siteMint;
  $('spbuyback').disabled = !wormMint;
  $('spbuyback').title = wormMint ? '' : '$WORM has to launch first';
  $('spburn').hidden = !(st.heldWorm > 0);
  spawnWallet();
  wizard();
}
function spawnWallet() { const me = connected(); $('spconnect').textContent = me ? `Connected · ${short(me.address)}` : 'Connect wallet'; }
// What the owner still has to do: set TOKEN_MINT once $WORM exists (a second record of the launch), and give SPAWN its
// rewards wallet. Shown to the owner only.
function todo() {
  const mint = launchedMint || '';
  $('lpmint').hidden = !(owner() && mint && !tokenMintSet);
  if (!$('lpmint').hidden) { const b = el('b'); b.append('TOKEN_MINT=', ...breakable(mint)); $('lpmint').replaceChildren('Set ', b, ' in Railway\'s variables too: a second record of the launch, in case the server\'s disk is ever lost.'); }
  const need = owner() && spState && !spState.owner;
  $('sptodo').hidden = !need;
  if (need) $('sptodo').textContent = 'Give SPAWN its rewards wallet: coins can be launched from then on.';
}
act('spconnect', 'spmsg', async (tell) => { const w = await connect(); tell(`Connected ${w.name}: ${w.address}`); });
act('spowner', 'spmsg', async (tell) => {
  if (!connected()) throw new Error('Connect the wallet that will collect SPAWN\'s creator rewards first.');
  const me = connected().address;
  if (!confirm(`Use ${me} as SPAWN's rewards wallet?\n\nEvery coin launched on SPAWN from now on names it as its pump.fun creator, so their creator rewards go to it. Use a different wallet from the one that launches $WORM.`)) return;
  await admin('owner', { wallet: me }, 'spawn');
  tell(`✓ SPAWN's rewards wallet is ${me}. SPAWN is open. To keep it across deploys even without the disk, set SPAWN_OWNER=${me} in Railway.`, 'good');
  spawnView();
});
async function recordBurn(signature, tell) {
  for (let k = 0; k < 20; k++) {
    await sleep(3000);
    const c = await admin('burned', { signature }, 'spawn').catch((e) => ({ ok: false, error: e.message }));
    if (c.ok) { tell('✓ Burned.', 'good'); return; }
  }
  tell(`Not confirmed yet: ${signature}. Check it on Solscan.`);
}
act('spcollect', 'spmsg', async (tell) => {
  if (!connected()) throw new Error('Connect SPAWN\'s rewards wallet first.');
  const me = connected().address;
  const j = await admin('collect', { wallet: me }, 'spawn');
  if (!confirm(`Collect about ${sol(j.sol)} SOL of creator rewards from SPAWN's vaults into ${me}? Your wallet signs one transaction.`)) return;
  const signature = await signAndSend(j.tx);
  tell(`Sent: ${signature}`);
  for (let k = 0; k < 20; k++) {
    await sleep(3000);
    const c = await admin('collected', { signature }, 'spawn').catch((e) => ({ ok: false, error: e.message }));
    if (c.ok) { tell(`✓ Collected${c.sol ? ` ${sol(c.sol)} SOL` : ''}.${c.owed ? ` ${sol(c.owed)} SOL is owed to the $WORM buyback.` : ''}`, 'good'); spawnView(); return; }
  }
  tell('Not confirmed yet. Check it on Solscan.');
});
// 64% of everything collected buys $WORM; then exactly what that bought is burned. The server keeps the buyback until
// it is settled, so pressing this again after a closed page or a slow confirmation picks it up instead of buying twice.
async function settleAndBurn(swap, tell) {
  let r = null;
  for (let k = 0; k < 30 && !(r && (r.ok || r.failed)); k++) { await sleep(3000); r = await admin('bought', { signature: swap }, 'spawn').catch((e) => ({ ok: false, error: e.message })); }
  if (!r?.ok) { tell(r?.failed ? '✗ That buy failed on chain: nothing was spent.' : 'The buy has not confirmed yet. Press the button again in a minute: it picks up where it left off, and never buys twice.', r?.failed ? 'bad' : ''); spawnView(); return; }
  if (!r.tx) { tell('Its $WORM was already burned.'); spawnView(); return; }
  if (!confirm(`It bought ${compact(r.amount)} $WORM. Burn all of it now? Your wallet signs one transaction.`)) { tell('Not burned yet: "Burn the $WORM still in SPAWN\'s wallet" does it later.'); spawnView(); return; }
  const bs = await signAndSend(r.tx);
  tell(`Burning ${compact(r.amount)} $WORM: ${bs}`);
  await recordBurn(bs, tell);
  spawnView();
}
act('spbuyback', 'spmsg', async (tell) => {
  if (!connected()) throw new Error('Connect SPAWN\'s rewards wallet first.');
  const me = connected().address;
  const bb = await admin('buyback', { wallet: me }, 'spawn');
  if (!confirm(`Spend ${sol(bb.sol)} SOL (64% of the creator rewards collected, less earlier buybacks) on about ${compact(bb.worm)} $WORM (at least ${compact(bb.min)}), then burn all of it? Your wallet signs two transactions.`)) return;
  const swap = await signAndSend(bb.tx);
  tell(`Bought: ${swap}`);
  await settleAndBurn(swap, tell);
});
// $WORM a buyback bought but whose burn wasn't signed: burn every bit of it
act('spburn', 'spmsg', async (tell) => {
  if (!connected()) throw new Error('Connect SPAWN\'s rewards wallet first.');
  const b = await admin('burn-held', { wallet: connected().address }, 'spawn');
  if (!confirm(`Burn the ${compact(b.amount)} $WORM in this wallet? Your wallet signs one transaction.`)) return;
  const bs = await signAndSend(b.tx);
  tell(`Burning ${compact(b.amount)} $WORM: ${bs}`);
  await recordBurn(bs, tell);
  spawnView();
});

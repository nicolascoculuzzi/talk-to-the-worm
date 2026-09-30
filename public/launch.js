// The /launch page: public status and proof of the launch moment, plus the owner's controls.
// Signing uses the Wallet Standard (Phantom, Solflare, Backpack...): the server prepares the
// transaction with the new mint's signature in it, and the owner's wallet adds its own and sends it.
import { pixelWordmark } from '/pixel.js';
import { connect, connected, signAndSend } from '/wallet.js';

const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
$('lpmark').append(pixelWordmark([{ text: 'BRAIN', cls: 'ink' }, { text: 'WORM', cls: 'amber', glow: true }]));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const compact = (n) => Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 2 }).format(n || 0);
const log = (line) => { const p = $('lplog'); p.textContent = (p.textContent + '\n' + line).trim().split('\n').slice(-14).join('\n'); };
const fmtTime = (ts) => new Date(ts).toISOString().replace('T', ' ').slice(0, 19) + ' UTC';

/* ---------- public status ---------- */
let launchedMint = '', launchStatus = null;   // $WORM's mint, once its launch has confirmed; the public status
async function refresh() {
  const s = await fetch('/launch/status.json', { cache: 'no-store' }).then((r) => r.json()).catch(() => null);
  if (!s) return;
  launchStatus = s;
  const set = (k, on, text) => { const li = document.querySelector(`[data-k="${k}"]`); li.classList.toggle('on', !!on); $('st-' + k).textContent = text; };
  set('armed', s.armed, s.armed ? `Armed at step ${s.armed.step.toLocaleString('en-US')} (${fmtTime(s.armed.at)}). Rule: the ${s.armed.rule}.` : 'Not armed yet.');
  set('moment', s.moment, s.moment ? `Step ${s.moment.step.toLocaleString('en-US')}: ${s.moment.nAct.toLocaleString('en-US')} cells firing, cilia stopped ${Math.round((s.moment.stop ?? s.moment.startle ?? 0) * 100)}%.` : s.armed ? 'Armed. Waiting for the first time a touch stops its cilia.' : 'Waiting for the launch to be armed.');
  set('metadata', s.metadata, s.metadata ? `Uploaded: ${s.metadata.uri}` : 'Uploaded to IPFS after the moment.');
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
  if (launchedMint && launchedMint !== was && !$('lpcontrols').hidden) { spawnView(); }   // it just launched: SPAWN's side of it
  todo();
}
refresh(); setInterval(refresh, 5000);

/* ---------- owner controls ---------- */
let token = sessionStorage.getItem('wormAdminToken') || '';
async function admin(path, params = {}, area = 'launch') {
  const q = new URLSearchParams(params).toString();
  const r = await fetch(`/admin/${area}/${path}${q ? '?' + q : ''}`, { method: 'POST', headers: { Authorization: 'Bearer ' + token } });
  if (r.status === 404) { lock(); throw new Error('Wrong or expired token.'); }
  const j = await r.json();
  if (!j.ok) throw new Error(j.error || 'Failed.');
  return j;
}
function lock() { token = ''; sessionStorage.removeItem('wormAdminToken'); $('lpcontrols').hidden = true; $('lplock').hidden = false; todo(); }
async function unlock() {
  const r = await fetch('/admin/state', { headers: { Authorization: 'Bearer ' + token } });
  if (!r.ok) { lock(); log('That token is not right.'); return; }
  sessionStorage.setItem('wormAdminToken', token);
  if (/not right/.test($('lplog').textContent)) $('lplog').textContent = '';
  $('lplock').hidden = true; $('lpcontrols').hidden = false;
  spawnView();
}
$('lplock').addEventListener('submit', (e) => { e.preventDefault(); token = $('lptoken').value.trim(); unlock(); });
if (token) unlock();
const act = (btn, fn) => $(btn).addEventListener('click', async () => {
  $(btn).disabled = true;
  try { await fn(); } catch (e) { log('✗ ' + e.message); } finally { $(btn).disabled = false; refresh(); }
});
act('lparm', async () => { await admin('arm'); log('Armed. Now tap the worm\'s head on the main page (the top of its body) until its cilia stop: the first touch that does is the moment.'); });
act('lpdisarm', async () => { await admin('disarm'); log('Disarmed.'); });
act('lpmeta', async () => {
  if (!confirm(`Upload the moment image and metadata to IPFS (through ${launchStatus?.uploader || 'pump.fun'})? This publishes them.`)) return;
  const j = await admin('metadata', { twitter: $('lptw').value.trim(), telegram: $('lptg').value.trim() });
  log('✓ Metadata: ' + j.metadata.uri);
});

/* ---------- the owner's wallet (Wallet Standard): it signs and sends; the server never holds a key ---------- */
let prepared = null;
act('lpwallet', async () => { const w = await connect(); log(`Connected ${w.name}: ${w.address}`); $('lpwallet').textContent = `Connected · ${w.address.slice(0, 4)}…${w.address.slice(-4)}`; });
act('lpprep', async () => {
  if (!connected()) throw new Error('Connect a wallet first.');
  const amountSol = String(Math.max(0, Number($('lpbuy').value) || 0));
  const j = await admin('prepare', { creator: connected().address, amountSol });
  prepared = j;
  const ca = $('lpca'), b = el('b');
  b.append(...breakable(j.mint));
  ca.replaceChildren('Its address (CA) will be ', b, '. Sign within a minute: after that the transaction expires, and preparing again gives a new address.');
  ca.hidden = false;
  log(`Prepared. Mint ${j.mint}`);
  log(`Fee payer ${j.summary.feePayer} · signers ${j.summary.signers.join(', ')}`);
  log(`Programs ${j.summary.programIds.join(', ')}`);
  log('Nothing has been sent. "Sign and launch" asks your wallet to approve it.');
  $('lpsign').disabled = false;
});
act('lpsign', async () => {
  if (!prepared || !connected()) throw new Error('Prepare the transaction first.');
  if (!confirm(`Launch $WORM now? Your wallet will show the transaction and its cost. This cannot be undone.\n\nMint: ${prepared.mint}`)) return;
  const signature = await signAndSend(prepared.tx);
  log('Sent: ' + signature);
  $('lpsign').disabled = true;
  for (let k = 0; k < 20; k++) {
    await sleep(3000);
    const c = await admin('confirm', { signature }).catch((e) => ({ ok: false, error: e.message }));
    if (c.ok) { log('✓ Launched. Trades now reach the worm.'); $('lpca').hidden = true; return; }
    log('Waiting for confirmation…');
  }
  log('Not confirmed yet. The server keeps watching the chain and records the launch as soon as it lands. Check it on Solscan; prepare again only if it failed.');
});

/* ---------- SPAWN: its rewards wallet, collecting the creator rewards, and the $WORM buyback and burn ---------- */
// Every coin launched on SPAWN is a pump.fun coin that names SPAWN's rewards wallet as its creator, so every coin's
// creator rewards collect in that wallet's pump.fun vaults. The owner collects them (one transaction); 64% of all that
// was collected buys $WORM (one transaction, on its curve or through Jupiter), and exactly what that bought is burned
// (one more). The other 36% stays in the wallet. The server builds each transaction; the owner's wallet signs and sends.
let spState = null, siteMint = '';
const sol = (x) => Number(x || 0).toLocaleString('en-US', { maximumFractionDigits: 4 });
async function spawnView() {
  const r = await fetch('/admin/state', { headers: { Authorization: 'Bearer ' + token } }).catch(() => null);
  if (!r || !r.ok) return;
  const a = await r.json(), st = spState = a.spawn;
  siteMint = a.trades?.mint || '';   // what the site itself knows: TOKEN_MINT, or the launch record
  todo();
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
}
// What the owner still has to do: set TOKEN_MINT once $WORM exists (a second record of the launch), and give SPAWN its
// rewards wallet. Shown to the owner only.
const breakable = (s) => s.match(/.{1,22}/g).flatMap((x, i) => (i ? [el('wbr'), x] : [x]));   // an address can wrap on a phone
function todo() {
  const owner = !$('lpcontrols').hidden, mint = launchedMint || '';
  const setMint = () => { const b = el('b'); b.append('TOKEN_MINT=', ...breakable(mint)); return ['Set ', b, ' in Railway\'s variables too: a second record of the launch, in case the server\'s disk is ever lost.']; };
  $('lpmint').hidden = !(owner && mint && mint !== siteMint);
  if (!$('lpmint').hidden) $('lpmint').replaceChildren(...setMint());
  const lines = [...(spState && !spState.owner ? [['Give SPAWN its rewards wallet below: coins can be launched from then on.']] : [])];
  $('sptodo').hidden = !(owner && lines.length);
  $('sptodo').replaceChildren(...lines.flatMap((l, i) => (i ? [el('br'), ...l] : l)));
}
act('spowner', async () => {
  if (!connected()) throw new Error('Connect the wallet that will collect SPAWN\'s creator rewards first.');
  const me = connected().address;
  if (!confirm(`Use ${me} as SPAWN's rewards wallet?\n\nEvery coin launched on SPAWN from now on names it as its pump.fun creator, so their creator rewards go to it. Use a different wallet from the one that launches $WORM.`)) return;
  await admin('owner', { wallet: me }, 'spawn');
  log(`✓ SPAWN's rewards wallet is ${me}. SPAWN is open. To keep it across deploys even without the disk, set SPAWN_OWNER=${me} in Railway.`);
  spawnView();
});
// has a transaction landed? (the public endpoint the trade window uses)
async function landed(signature) {
  for (let k = 0; k < 30; k++) {
    await sleep(2000);
    const r = await fetch('/spawn/confirm', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ signature }) }).then((x) => x.json()).catch(() => ({}));
    if (r.failed) return false;
    if (r.confirmed) return true;
  }
  return false;
}
async function recordBurn(signature) {
  for (let k = 0; k < 20; k++) {
    await sleep(3000);
    const c = await admin('burned', { signature }, 'spawn').catch((e) => ({ ok: false, error: e.message }));
    if (c.ok) { log('✓ Burned.'); return; }
  }
  log(`Not confirmed yet: ${signature}. Check it on Solscan.`);
}
act('spcollect', async () => {
  if (!connected()) throw new Error('Connect SPAWN\'s rewards wallet first.');
  const me = connected().address;
  const j = await admin('collect', { wallet: me }, 'spawn');
  if (!confirm(`Collect about ${sol(j.sol)} SOL of creator rewards from SPAWN's vaults into ${me}? Your wallet signs one transaction.`)) return;
  const signature = await signAndSend(j.tx);
  log(`Sent: ${signature}`);
  for (let k = 0; k < 20; k++) {
    await sleep(3000);
    const c = await admin('collected', { signature }, 'spawn').catch((e) => ({ ok: false, error: e.message }));
    if (c.ok) { log(`✓ Collected${c.sol ? ` ${sol(c.sol)} SOL` : ''}.${c.owed ? ` ${sol(c.owed)} SOL is owed to the $WORM buyback.` : ''}`); spawnView(); return; }
  }
  log('Not confirmed yet. Check it on Solscan.');
});
// 64% of everything collected buys $WORM; then exactly what that bought is burned. The server keeps the buyback until
// it is settled, so pressing this again after a closed page or a slow confirmation picks it up instead of buying twice.
async function settleAndBurn(swap) {
  let r = null;
  for (let k = 0; k < 30 && !(r && (r.ok || r.failed)); k++) { await sleep(3000); r = await admin('bought', { signature: swap }, 'spawn').catch((e) => ({ ok: false, error: e.message })); }
  if (!r?.ok) { log(r?.failed ? '✗ That buy failed on chain: nothing was spent.' : 'The buy has not confirmed yet. Press the button again in a minute: it picks up where it left off, and never buys twice.'); spawnView(); return; }
  if (!r.tx) { log('Its $WORM was already burned.'); spawnView(); return; }
  if (!confirm(`It bought ${compact(r.amount)} $WORM. Burn all of it now? Your wallet signs one transaction.`)) { log('Not burned yet: "Burn the $WORM still in SPAWN\'s wallet" does it later.'); spawnView(); return; }
  const bs = await signAndSend(r.tx);
  log(`Burning ${compact(r.amount)} $WORM: ${bs}`);
  await recordBurn(bs);
  spawnView();
}
act('spbuyback', async () => {
  if (!connected()) throw new Error('Connect SPAWN\'s rewards wallet first.');
  const me = connected().address;
  const bb = await admin('buyback', { wallet: me }, 'spawn');
  if (!confirm(`Spend ${sol(bb.sol)} SOL (64% of the creator rewards collected, less earlier buybacks) on about ${compact(bb.worm)} $WORM (at least ${compact(bb.min)}), then burn all of it? Your wallet signs two transactions.`)) return;
  const swap = await signAndSend(bb.tx);
  log(`Bought: ${swap}`);
  await settleAndBurn(swap);
});
// $WORM a buyback bought but whose burn wasn't signed: burn every bit of it
act('spburn', async () => {
  if (!connected()) throw new Error('Connect SPAWN\'s rewards wallet first.');
  const b = await admin('burn-held', { wallet: connected().address }, 'spawn');
  if (!confirm(`Burn the ${compact(b.amount)} $WORM in this wallet? Your wallet signs one transaction.`)) return;
  const bs = await signAndSend(b.tx);
  log(`Burning ${compact(b.amount)} $WORM: ${bs}`);
  await recordBurn(bs);
  spawnView();
});

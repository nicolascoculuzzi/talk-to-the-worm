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
async function refresh() {
  const s = await fetch('/launch/status.json', { cache: 'no-store' }).then((r) => r.json()).catch(() => null);
  if (!s) return;
  const set = (k, on, text) => { const li = document.querySelector(`[data-k="${k}"]`); li.classList.toggle('on', !!on); $('st-' + k).textContent = text; };
  set('armed', s.armed, s.armed ? `Armed at step ${s.armed.step.toLocaleString('en-US')} (${fmtTime(s.armed.at)}). Rule: the ${s.armed.rule}.` : 'Not armed yet.');
  set('moment', s.moment, s.moment ? `Step ${s.moment.step.toLocaleString('en-US')}: ${s.moment.nAct.toLocaleString('en-US')} cells firing, cilia stopped ${Math.round((s.moment.stop ?? s.moment.startle ?? 0) * 100)}%.` : s.armed ? 'Armed. Waiting for the first time a touch makes it stop swimming.' : 'Waiting for the launch to be armed.');
  set('metadata', s.metadata, s.metadata ? `Uploaded: ${s.metadata.uri}` : 'Uploaded to IPFS after the moment.');
  set('launched', s.launched, s.launched ? `Mint ${s.launched.mint}` : 'Created on pump.fun from the moment.');
  if (s.launched) {
    const p = $('st-launched'); p.replaceChildren(`Mint ${s.launched.mint} · `);
    const a = el('a', null, 'transaction'); a.href = 'https://solscan.io/tx/' + s.launched.signature; a.target = '_blank'; a.rel = 'noopener'; p.append(a);
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
function lock() { token = ''; sessionStorage.removeItem('wormAdminToken'); $('lpcontrols').hidden = true; $('lplock').hidden = false; }
async function unlock() {
  const r = await fetch('/admin/state', { headers: { Authorization: 'Bearer ' + token } });
  if (!r.ok) { lock(); log('That token is not right.'); return; }
  sessionStorage.setItem('wormAdminToken', token);
  $('lplock').hidden = true; $('lpcontrols').hidden = false;
  spawnView(); loadPrice();
}
$('lplock').addEventListener('submit', (e) => { e.preventDefault(); token = $('lptoken').value.trim(); unlock(); });
if (token) unlock();
const act = (btn, fn) => $(btn).addEventListener('click', async () => {
  $(btn).disabled = true;
  try { await fn(); } catch (e) { log('✗ ' + e.message); } finally { $(btn).disabled = false; refresh(); }
});
act('lparm', async () => { await admin('arm'); log('Armed. The first time a touch makes it stop swimming from now is the moment.'); });
act('lpdisarm', async () => { await admin('disarm'); log('Disarmed.'); });
act('lpmeta', async () => {
  if (!confirm('Upload the moment image and metadata to pump.fun\'s IPFS? This publishes them.')) return;
  const j = await admin('metadata', { twitter: $('lptw').value.trim(), telegram: $('lptg').value.trim() });
  log('✓ Metadata: ' + j.metadata.uri);
});

/* ---------- the owner's wallet (Wallet Standard): it signs and sends; the server never holds a key ---------- */
let prepared = null;
act('lpwallet', async () => { const w = await connect(); log(`Connected ${w.name}: ${w.address}`); });
act('lpprep', async () => {
  if (!connected()) throw new Error('Connect a wallet first.');
  const amountSol = String(Math.max(0, Number($('lpbuy').value) || 0));
  const j = await admin('prepare', { creator: connected().address, amountSol });
  prepared = j;
  log(`Prepared. Mint ${j.mint}`);
  log(`Fee payer ${j.summary.feePayer} · signers ${j.summary.signers.join(', ')}`);
  log(`Programs ${j.summary.programIds.join(', ')}`);
  log('Nothing has been sent. "Sign and launch" asks your wallet to approve it.');
  $('lpsign').disabled = false;
});
act('lpsign', async () => {
  if (!prepared || !connected()) throw new Error('Prepare the transaction first.');
  if (!confirm(`Launch $BRAINWORM now? Your wallet will show the transaction and its cost. This cannot be undone.\n\nMint: ${prepared.mint}`)) return;
  const signature = await signAndSend(prepared.tx);
  log('Sent: ' + signature);
  $('lpsign').disabled = true;
  for (let k = 0; k < 20; k++) {
    await sleep(3000);
    const c = await admin('confirm', { signature }).catch((e) => ({ ok: false, error: e.message }));
    if (c.ok) { log('✓ Launched. Trades now reach the worm.'); return; }
    log('Waiting for confirmation…');
  }
  log('Not confirmed yet. Check the transaction on Solscan, then press Sign again only if it failed.');
});

/* ---------- SPAWN: the launchpad's config, and claim and burn ---------- */
// Coins on SPAWN are priced in $BRAINWORM, so a config's market caps are set in $BRAINWORM at today's price. The
// server builds the config transaction with the config's fresh key signed in; the owner's wallet pays its rent
// (about 0.008 SOL), signs and sends it. Claim and burn: the fees waiting in every coin's pool are claimed and
// burned in the same transactions, which the owner's wallet signs one by one.
let spPrice = null;
async function spawnView() {
  const r = await fetch('/admin/state', { headers: { Authorization: 'Bearer ' + token } }).catch(() => null);
  if (!r || !r.ok) return;
  const st = (await r.json()).spawn;
  const cfg = st.configs.at(-1);
  $('spstatus').textContent = !cfg ? 'No config yet. Make one after $BRAINWORM launches; coins can be spawned from then on.'
    : `Open. Newest config ${cfg.address} graduates coins at ${compact(cfg.graduationQuote)} $BRAINWORM (${st.configs.length} config${st.configs.length > 1 ? 's' : ''} in all). ${compact(st.burned)} $BRAINWORM burned so far, ${compact(st.waiting)} waiting.`
      + (st.stuck?.length ? ` Waiting over 10 minutes to graduate: ${st.stuck.map((x) => '$' + (x.symbol || x.mint.slice(0, 4))).join(', ')}. Meteora's migrator usually does it; migrator.meteora.ag can do it by hand.` : '');
}
function calc() {
  const start = Number($('spstart').value), grad = Number($('spgrad').value);
  if (!spPrice?.rootSol) { $('spcalc').textContent = '$BRAINWORM has no price yet (it has to launch first).'; return null; }
  if (!(start > 0 && grad > start)) { $('spcalc').textContent = 'The graduation market cap has to be above the starting one.'; return null; }
  const startMcap = start / spPrice.rootSol, graduationMcap = grad / spPrice.rootSol;
  const r = Math.sqrt(startMcap / graduationMcap), raised = graduationMcap * r / (1 + r);
  $('spcalc').textContent = `At today's price that is ${compact(startMcap)} → ${compact(graduationMcap)} $BRAINWORM. A coin graduates once buyers have put in ${compact(raised)} $BRAINWORM (≈ ${(raised * spPrice.rootSol).toFixed(1)} SOL, ${(raised / 1e7).toFixed(2)}% of all $BRAINWORM).`;
  return { startMcap, graduationMcap };
}
$('spstart').addEventListener('input', calc); $('spgrad').addEventListener('input', calc);
async function loadPrice() { try { spPrice = (await admin('price', {}, 'spawn')).price; } catch { spPrice = null; } calc(); }
act('spcfg', async () => {
  if (!connected()) throw new Error('Connect the owner wallet first: it pays for the config and claims its fees.');
  await loadPrice();
  const m = calc();
  if (!m) throw new Error('Check the market caps.');
  const j = await admin('config', { partner: connected().address, startMcap: String(m.startMcap), graduationMcap: String(m.graduationMcap) }, 'spawn');
  log(`Config ${j.address}: coins graduate at ${compact(j.curve.graduationQuote)} $BRAINWORM.`);
  if (!confirm(`Create SPAWN's config ${j.address}?\n\nNew coins will use it; it can't be changed afterwards (you can make a newer one). Your wallet pays its rent, about 0.008 SOL.`)) return;
  const signature = await signAndSend(j.tx);
  log('Sent: ' + signature);
  for (let k = 0; k < 20; k++) {
    await sleep(3000);
    const c = await admin('confirm', { signature }, 'spawn').catch((e) => ({ ok: false, error: e.message }));
    if (c.ok) { log('✓ SPAWN is open with this config.'); spawnView(); return; }
  }
  log('Not confirmed yet. Check it on Solscan.');
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
act('spclaim', async () => {
  if (!connected()) throw new Error('Connect the fee claimer wallet first.');
  const me = connected().address;
  // fees on the curves, claimed and burned in the same transactions; then the graduated pools' fees, claimed, then burned
  const { txs } = await admin('claim', { feeClaimer: me }, 'spawn');
  const { txs: grad } = await admin('claim-graduated', { feeClaimer: me }, 'spawn');
  if (!txs.length && !grad.length) { log('Nothing waiting to burn (at least 1 $BRAINWORM per coin on the curves, and no graduated coins).'); return; }
  const total = txs.reduce((n, t) => n + t.burn, 0), coins = txs.reduce((n, t) => n + t.pools.length, 0), gcoins = grad.reduce((n, t) => n + t.coins.length, 0);
  const what = [txs.length ? `${compact(total)} $BRAINWORM from ${coins} coin${coins > 1 ? 's' : ''} on their curves` : '', grad.length ? `your share of the fees in ${gcoins} graduated coin${gcoins > 1 ? 's\'' : '\'s'} pool${gcoins > 1 ? 's' : ''} (burned as soon as each claim lands)` : ''].filter(Boolean).join(', and ');
  if (!confirm(`Claim and burn ${what}? Your wallet signs ${txs.length + 2 * grad.length} transaction${txs.length + 2 * grad.length > 1 ? 's' : ''}.`)) return;
  for (const t of txs) {
    const signature = await signAndSend(t.tx);
    log(`Sent: ${signature} (burns ${compact(t.burn)})`);
    await recordBurn(signature);
  }
  for (const t of grad) {
    const claim = await signAndSend(t.tx);
    log(`Claimed from ${t.coins.length} graduated pool${t.coins.length > 1 ? 's' : ''}: ${claim}`);
    if (!(await landed(claim))) { log(`That claim has not landed; nothing was burned. When it has, burn it by running Claim and burn again after its $BRAINWORM arrives, or ask for a burn of ${claim}.`); continue; }
    const b = await admin('burn-claimed', { signature: claim }, 'spawn');
    if (!b.tx) { log('Nothing had built up to burn yet.'); continue; }
    const bs = await signAndSend(b.tx);
    log(`Burning ${b.burns.map((x) => compact(x.amount)).join(' + ')}: ${bs}`);
    await recordBurn(bs);
  }
  spawnView();
});

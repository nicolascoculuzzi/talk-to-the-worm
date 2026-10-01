// The launch form, on the main page's dock and on /spawn: a coin's name, its ticker, an optional dev buy, and a
// picture, which is its worm's first sight (a fresh worm shown "$TICKER", drawn from the real wiring) unless one is
// picked. The server builds the transaction with the coin's fresh mint key signed in; the visitor's own wallet signs
// and sends it. Nothing here holds a key.
import { connect, connected, signAndSend, short, walletLinks, noWallet } from '/wallet.js';

const TICKER = /^[A-Z0-9]{1,10}$/;
const fmt = (n) => Number(n || 0).toLocaleString('en-US');
const compact = (n) => Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 2 }).format(n || 0);
const link = (href, text, external = false) => { const a = document.createElement('a'); a.href = href; a.textContent = text; if (external) { a.target = '_blank'; a.rel = 'noopener'; } return a; };
async function api(path, body) {
  const r = await fetch(path, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {});
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) throw new Error(j.error || `HTTP ${r.status}`);
  return j;
}
// what a wallet says, in words
function walletError(e) {
  const m = String(e?.message || e);
  if (/reject|cancel|denied|declined/i.test(m)) return 'Cancelled in your wallet.';
  return m;
}
/** "Open this in Phantom or Solflare": links that open `url` inside the wallet app's browser. */
export function openInWallet(url) {
  const parts = ['No wallet in this browser. Open it in '];
  walletLinks(url).forEach(([name, href], i) => { if (i) parts.push(' or '); parts.push(link(href, name)); });
  parts.push(', or add a wallet to this browser.');
  return parts;
}
/** Downscale to at most 512 px and re-encode, so uploads stay small. GIFs are kept as they are (up to 1 MB). */
async function shrink(file) {
  if (file.type === 'image/gif') {
    if (file.size > 1e6) throw new Error('big gif');
    return await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(file); });
  }
  const bmp = await createImageBitmap(file);
  const s = Math.min(1, 512 / Math.max(bmp.width, bmp.height)), c = document.createElement('canvas');
  c.width = Math.round(bmp.width * s); c.height = Math.round(bmp.height * s);
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  return c.toDataURL('image/webp', 0.9);
}

/**
 * Wires up a launch form: elements marked data-lf="pic|picimg|picph|up|unpick|name|ticker|buy|unit|go|note".
 * Returns { update({ open, quote, reason }) } for the page to pass on what /spawn.json says.
 */
export function mountLaunchForm(form, { onLaunched = () => {} } = {}) {
  const $f = (k) => form.querySelector(`[data-lf="${k}"]`);
  const pic = $f('pic'), img = $f('picimg'), ph = $f('picph'), up = $f('up'), unpick = $f('unpick'), name = $f('name'), ticker = $f('ticker'), buy = $f('buy'), unit = $f('unit'), go = $f('go'), note = $f('note');
  // description and links, like pump.fun's form; a form without them still works
  const desc = $f('desc'), xh = $f('x'), tg = $f('tg'), web = $f('web'), more = $f('more');
  const extras = { desc, x: xh, tg, web };
  const val = (el) => (el ? el.value.trim() : '');
  let custom = null;            // a picked picture, as a data URL; without one it gets its worm's first sight
  let state = { open: false, quote: null, reason: 'Opening soon.', pictures: true };
  let busy = false, hatchTimer = null, hatchLine = '', done = false;

  const say = (...parts) => { note.classList.remove('bad'); note.replaceChildren(...parts); };
  const bad = (text) => { note.classList.add('bad'); note.textContent = text; };
  // the wallet app's browser opens this page with what was typed in it, so nothing has to be typed twice
  function here() {
    const u = new URL(location.href);
    for (const [k, v] of [['lname', name.value.trim()], ['lticker', ticker.value], ['lbuy', buy.value], ['ldesc', val(desc)], ['lx', val(xh)], ['ltg', val(tg)], ['lweb', val(web)]]) if (v) u.searchParams.set(k, v); else u.searchParams.delete(k);
    return u.href;
  }
  {
    const q = new URLSearchParams(location.search);
    if (q.get('lname')) name.value = q.get('lname').slice(0, 32);
    if (q.get('lticker')) { ticker.value = q.get('lticker').replace(/[^A-Za-z0-9]/g, '').toUpperCase().slice(0, 10); ticker.dataset.touched = '1'; }
    if (q.get('lbuy')) buy.value = q.get('lbuy').replace(/[^0-9.]/g, '');
    for (const [k, el] of Object.entries(extras)) if (el && q.get('l' + k)) { el.value = q.get('l' + k).slice(0, k === 'desc' ? 300 : 200); if (more) more.open = true; }
    if (q.has('lname') || q.has('lticker')) {
      const u = new URL(location.href); for (const k of ['lname', 'lticker', 'lbuy', 'ldesc', 'lx', 'ltg', 'lweb']) u.searchParams.delete(k);
      history.replaceState(history.state, '', u.pathname + u.search + u.hash);
      queueMicrotask(() => form.scrollIntoView?.({ block: 'center' }));
    }
  }
  function idle() {
    if (busy || done) return;
    const w = connected(), who = w ? ` · ${short(w.address)}` : '';
    if (!state.open) say(`${state.reason || 'Opening soon.'} You can already see what its worm will see first.`);
    else if (hatchLine) say((custom ? 'Your picture. ' : '') + hatchLine + (state.pictures && !custom ? ' Upload your own picture, or keep this one.' : '') + who);
    else say(`Free to launch. ${custom ? 'Your picture.' : state.pictures ? 'Upload your own picture, or it gets its worm\'s first sight.' : 'Its picture: its worm\'s first sight.'}${who}`);
  }
  // its worm's first sight is drawn once typing pauses (a drawing per ticker, not per keystroke); a picked picture at once
  let picTimer = 0;
  function showPic() {
    const src = custom || (TICKER.test(ticker.value) ? `/spawn/hatch/${ticker.value}.png` : '');
    unpick.hidden = !custom;
    clearTimeout(picTimer);
    const apply = () => {
      img.hidden = !src; ph.hidden = !!src;
      if (up) up.hidden = !src || !!custom || !state.pictures;   // over its worm's first sight: this can be your own
      if (src && img.getAttribute('src') !== src) img.src = src;
    };
    if (!src || custom) apply(); else picTimer = setTimeout(apply, 400);
  }
  // a drawing that didn't come (the server was busy): once more a moment later, else the placeholder
  img.addEventListener('error', () => {
    const src = img.getAttribute('src');
    if (!src || src.startsWith('data:')) return;
    if (img.dataset.retried === src) { img.hidden = true; ph.hidden = false; if (up) up.hidden = true; return; }
    img.dataset.retried = src;
    setTimeout(() => { if (img.getAttribute('src') === src) { img.removeAttribute('src'); img.src = src; } }, 1500);
  });
  function hatch() {
    clearTimeout(hatchTimer);
    hatchLine = '';
    showPic(); idle();
    const t = ticker.value;
    if (!TICKER.test(t)) return;
    hatchTimer = setTimeout(async () => {
      try {
        const j = await api(`/spawn/hatch/${t}.json`);
        if (t !== ticker.value) return;
        hatchLine = `Its worm's first sight, "$${t}": ${fmt(j.peak)} cells fire.`;
      } catch { hatchLine = ''; }
      idle();
    }, 350);
  }
  const edited = () => { if (done) { done = false; } };

  name.addEventListener('input', () => {
    edited();
    if (!ticker.dataset.touched) { ticker.value = name.value.replace(/[^A-Za-z0-9]/g, '').toUpperCase().slice(0, 10); hatch(); } else idle();
  });
  ticker.addEventListener('input', () => {
    edited();
    ticker.value = ticker.value.replace(/[^A-Za-z0-9]/g, '').toUpperCase().slice(0, 10);
    ticker.dataset.touched = ticker.value ? '1' : '';
    hatch();
  });
  buy.addEventListener('input', () => { edited(); buy.value = buy.value.replace(/[^0-9.]/g, '').replace(/(\..*)\./g, '$1'); idle(); });
  pic.addEventListener('change', async () => {
    const f = pic.files[0];
    pic.value = '';
    if (!f) return;
    edited();
    try { custom = await shrink(f); } catch { custom = null; bad('That picture could not be read (PNG, JPG, WEBP, or a GIF under 1 MB).'); showPic(); return; }
    showPic(); idle();
  });
  unpick.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); custom = null; showPic(); idle(); });
  addEventListener('wallet-connected', idle);

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (busy) return;
    if (!state.open) { bad(state.reason || 'Opening soon.'); return; }
    const nm = name.value.trim(), sym = ticker.value.trim();
    if (!nm) { bad('Give it a name.'); name.focus(); return; }
    if (!TICKER.test(sym)) { bad('A ticker is 1 to 10 letters or digits.'); ticker.focus(); return; }
    busy = true; go.disabled = true; done = false;
    try {
      let w = connected();
      if (!w) { say('Connect your wallet…'); w = await connect(); }
      say('Building the transaction…');
      const j = await api('/spawn/create', { creator: w.address, name: nm, symbol: sym, image: custom || 'worm', firstBuy: buy.value.trim() || '0', description: val(desc), twitter: val(xh), telegram: val(tg), website: val(web) });
      say(j.firstBuy ? `Check your wallet. Your dev buy gets about ${compact(j.firstBuy.coins)} $${sym}.` : 'Check your wallet.');
      const sig = await signAndSend(j.tx);
      await api('/spawn/created', { mint: j.mint, signature: sig }).catch(() => {});
      // launched once the chain says so: until then it's only sent
      say('Sent. Waiting for it to land…');
      let st = {};
      for (let k = 0; k < 45 && !st.confirmed && !st.failed; k++) { await new Promise((r) => setTimeout(r, 2000)); st = await api('/spawn/confirm', { signature: sig }).catch(() => ({})); }
      if (st.failed) { bad('That launch failed on chain, so no coin was made. Only the network fee was spent: try again.'); return; }
      done = true;
      const page = `${location.origin}/c/${j.mint}`, post = `I just launched $${sym} on SPAWN. It hatched its own worm, a copy of a real larva's wiring that feels every trade of it.`;
      if (st.confirmed) say(`Launched $${sym}. `, link(`/c/${j.mint}`, 'See it'), ' · ', link(`https://x.com/intent/post?text=${encodeURIComponent(post)}&url=${encodeURIComponent(page)}`, 'Share on X', true), ' · ', link(`https://solscan.io/tx/${sig}`, 'Solscan', true));
      else say(`Sent $${sym}, not confirmed yet: `, link(`https://solscan.io/tx/${sig}`, 'check Solscan', true), '. If it lands, its page is ', link(`/c/${j.mint}`, 'here'), '.');
      name.value = ''; ticker.value = ''; ticker.dataset.touched = ''; buy.value = ''; custom = null; hatchLine = ''; showPic();
      for (const el of Object.values(extras)) if (el) el.value = '';
      if (more) more.open = false;
      onLaunched({ mint: j.mint, symbol: sym, signature: sig });
    } catch (err) {
      if (noWallet(err)) { note.classList.add('bad'); note.replaceChildren(...openInWallet(here())); }
      else bad(walletError(err));
    }
    finally { busy = false; go.disabled = !state.open; }
  });

  showPic(); hatch();
  return {
    update(s) {
      state = { open: !!s.open, quote: s.quote || null, reason: s.reason || null, pictures: s.pictures !== false };
      // without lasting picture hosting every coin gets its worm's first sight, which needs none
      pic.disabled = !state.pictures;
      form.classList.toggle('nopics', !state.pictures);
      ph.lastChild.textContent = state.pictures ? 'Upload' : 'Its worm';
      if (!state.pictures && custom) custom = null;
      showPic();
      unit.textContent = 'SOL';
      go.disabled = busy || !state.open;
      go.textContent = state.open ? 'Launch' : 'Opening soon';
      idle();
    },
  };
}

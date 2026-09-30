// /about: the contents follow your reading (a sidebar on wide screens, a folding bar on phones), and a thin
// bar under the nav shows how far down the page you are. Nothing else runs on this page.
const toc = document.getElementById('toc');
if (toc) {
  const summary = toc.querySelector('summary');
  const label = document.getElementById('toccur');
  const list = toc.querySelector('.ab-tocl');
  const box = toc.closest('.ab-toc');
  const bar = document.querySelector('.ab-progress i');
  const wide = matchMedia('(min-width: 1100px)');
  const idle = label.textContent;

  // every contents link with the heading it points to, in page order; top-level ones carry a number
  const items = [...toc.querySelectorAll('a[href^="#"]')].map((a) => ({
    a,
    el: document.getElementById(decodeURIComponent(a.hash.slice(1))),
    top: !a.closest('li').parentElement.closest('li'),
    li: a.closest('li'),
  })).filter((x) => x.el);
  const numberOf = (it) => (it.a.firstElementChild ? it.a.firstElementChild.textContent : '');
  const titleOf = (it) => [...it.a.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join('').trim();

  // wide screens: always open, and the summary is only a heading; phones: folded until tapped
  const fit = () => { toc.open = wide.matches; };
  fit();
  wide.addEventListener('change', fit);
  summary.addEventListener('click', (e) => { if (wide.matches) e.preventDefault(); });
  toc.addEventListener('click', (e) => { if (!wide.matches && e.target.closest('a')) toc.open = false; });
  document.addEventListener('click', (e) => { if (!wide.matches && toc.open && !toc.contains(e.target)) toc.open = false; });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !wide.matches && toc.open) { toc.open = false; summary.focus(); }
  });

  let cur = null, sub = null, raf = 0;

  // keep a link visible inside a scrolling list without moving the page
  function reveal(scroller, a) {
    if (!scroller || !a || scroller.scrollHeight <= scroller.clientHeight) return;
    const r = a.getBoundingClientRect(), s = scroller.getBoundingClientRect(), pad = 48;
    if (r.top < s.top + pad) scroller.scrollTop -= s.top + pad - r.top;
    else if (r.bottom > s.bottom - pad) scroller.scrollTop += r.bottom - (s.bottom - pad);
  }

  function update() {
    raf = 0;
    const line = Math.min(innerHeight * 0.3, 260);
    let t = null, s = null;
    for (const it of items) {
      if (it.el.getBoundingClientRect().top > line) break;
      if (it.top) { t = it; s = null; } else s = it;
    }
    if (t !== cur || s !== sub) {
      cur = t; sub = s;
      for (const it of items) {
        it.a.classList.toggle('on', it === t || it === s);
        if (it === t) it.a.setAttribute('aria-current', 'location'); else it.a.removeAttribute('aria-current');
        if (it.top) it.li.classList.toggle('cur', it === t);
      }
      label.textContent = t ? `${numberOf(t)} · ${s ? titleOf(s) : titleOf(t)}` : idle;
      if (wide.matches && t) reveal(box, (s || t).a);
    }
    const h = document.documentElement.scrollHeight - innerHeight;
    if (bar) bar.style.transform = `scaleX(${h > 0 ? Math.min(1, Math.max(0, scrollY / h)) : 0})`;
  }
  const queue = () => { if (!raf) raf = requestAnimationFrame(update); };
  addEventListener('scroll', queue, { passive: true });
  addEventListener('resize', queue);
  toc.addEventListener('toggle', () => { if (toc.open && !wide.matches && cur) requestAnimationFrame(() => reveal(list, (sub || cur).a)); });
  update();
}

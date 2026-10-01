#!/usr/bin/env node
// Images for the X account, rendered from the real wiring and real runs of the worm (server/render.js, the same
// renderer as the launch-moment token image and the link previews). No text: each one is a different view of the
// larva doing a different thing. The run is deterministic, so the same command makes the same pictures.
//
//   node scripts/make-x-art.js [CA]          -> marketing/x/*.png
//
//   header.png     1500x500  the larva across the right of the header, head a third in (the bottom-left is under the profile picture), flooded with light ("@" lights the most cells)
//   post-1.png     1200x1200 upright, seen from its back, shown "$WORM" (the launch post; the CA goes in the text)
//   post-1-ca.png  1200x630  the same moment with the CA written on it, for people who want it in the picture
//   post-2.png     1200x1200 head-on: looking down the head-tail axis, a ring of cells
//   post-3.png     1200x630  close-up of the head as the word passes its eyes, its wires drawn
//   post-4.png     1200x630  from above, flooded with light
//   post-5.png     1200x1200 macro: inside the head, the eyes firing and the lines between them
//   post-6.png     1200x630  wide-angle, from the head, shown "$WORM"
//   post-7.png     1200x1200 a buy on SPAWN: three head-end touch cells, the startle, close on the head
//   post-8.png     1200x1200 a coin's own worm at its birth, shown "$TICKER" (the hatch picture, as the launch form shows it)
//   post-9.png     1200x630  "EVERY BUY POKES IT", the buy's startle beside the words
//   post-10.png    1200x630  a sell: three tail-end touch cells, seen from the tail
//   post-11.png    1200x1200 the numbers: 2,675 cells, 26,881 synapses, over the flood of light
//   post-12.png    1200x630  the burn: 64% of the creator rewards buys $WORM and burns it
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WormCore } from '../shared/worm.js';
import { withTransmitters } from '../shared/data.js';
import { hatch, touchSides, pick } from '../shared/coinworm.js';
import { renderActivityPNG } from '../server/render.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'marketing', 'x');
const D = withTransmitters(JSON.parse(fs.readFileSync(path.join(ROOT, 'data/wiring.json'), 'utf8')), JSON.parse(fs.readFileSync(path.join(ROOT, 'data/transmitters.json'), 'utf8')));
const CA = process.argv[2] || '';

/** A real run: do something to a fresh worm and keep the step with the most cells firing. */
function peak(stimulate, steps = 300) {
  const worm = new WormCore(D);
  stimulate(worm);
  let best = { n: -1 };
  for (let s = 0; s < steps; s++) {
    worm.tick();
    let n = 0;
    for (const v of worm.sim.r) if (v > 0.05) n++;
    if (n > best.n) best = { n, step: worm.step, act: Float32Array.from(worm.sim.r) };
  }
  return best;
}
const word = peak((w) => w.say('x', '$WORM'));                       // the word scrolls past its eyes
const flood = peak((w) => w.say('x', '@'));                          // "@" lights the most cells of any character
const touch = peak((w) => w.poke('x', w.roles.touch.slice(0, 16)));  // a touch on the head: the startle
// a trade on SPAWN: three touch cells at the head end (a buy) or the tail end (a sell), picked from bytes the way
// the site picks them from a transaction's signature (here from the letters of "SPAWN": the picture needs no chain)
const bytes = [...'SPAWN'].map((c) => c.charCodeAt(0));
const buy = peak((w) => w.poke('x', pick(touchSides(w).head, bytes)));
const sell = peak((w) => w.poke('x', pick(touchSides(w).tail, bytes)));
const birth = hatch(D, 'TICKER', { keepPeak: true });                 // a coin's own worm shown its ticker at birth
console.log(`cells firing at the peak: "$WORM" ${word.n}, "@" ${flood.n}, a touch ${touch.n}, a buy ${buy.n}, a sell ${sell.n}, a birth ${birth.peak}`);

function save(name, buf) {
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, name), buf);
  console.log(`marketing/x/${name}  ${(buf.length / 1024).toFixed(0)} KB`);
}
const none = { title: [] };

save('header.png', renderActivityPNG({ D, act: flood.act, layout: 'banner', ...none, box: [400, -40, 1720, 560] }));   // head clear of the bottom-left, where X puts the profile picture
save('post-1.png', renderActivityPNG({ D, act: word.act, layout: 'square', width: 1200, ...none, cam: { roll: 1.2 }, box: [70, 20, 930, 980] }));
if (CA) {
  const half = Math.ceil(CA.length / 2);
  save('post-1-ca.png', renderActivityPNG({
    D, act: word.act, layout: 'og', badge: 'LIVE ON PUMP.FUN',
    lines: ['$WORM IS LIVE. CA:', { text: CA.slice(0, half), color: 'amber' }, { text: CA.slice(half), color: 'amber' }],
    footnote: 'ONE REAL WORM BRAIN, RUNNING LIVE AT BRAINWORMS.XYZ - EVERY BUY POKES IT',
  }));
}
save('post-2.png', renderActivityPNG({ D, act: word.act, layout: 'square', width: 1200, ...none, cam: { yaw: Math.PI / 2, spin: 0, roll: 0.3 }, box: [60, 60, 940, 940] }));
save('post-3.png', renderActivityPNG({ D, act: word.act, layout: 'og', ...none, box: [395, -295, 1762, 915] }));
save('post-4.png', renderActivityPNG({ D, act: flood.act, layout: 'og', ...none, cam: { tilt: Math.PI / 2 }, box: [20, 10, 1180, 620] }));
save('post-5.png', renderActivityPNG({ D, act: word.act, layout: 'square', width: 1200, ...none, cam: { roll: 1.2 }, box: [-525, 50, 1625, 2450] }));
save('post-6.png', renderActivityPNG({ D, act: word.act, layout: 'og', ...none, cam: { persp: 0.75, yaw: 0.9, tilt: 0.45 }, box: [60, 0, 1140, 630] }));
save('post-7.png', renderActivityPNG({ D, act: buy.act, layout: 'square', width: 1200, ...none, cam: { roll: -0.25, yaw: 0.35, tilt: 0.2, spin: -0.08 }, box: [-60, 160, 1500, 840] }));
save('post-8.png', renderActivityPNG({
  D, act: birth.act, layout: 'square', width: 1200, title: ['$TICKER'], titleColors: ['amber'],
  lines: [`ITS FIRST SIGHT: ${birth.peak.toLocaleString('en-US')} CELLS FIRING`, 'AFTER THAT IT FEELS ONLY ITS OWN TRADES'],
  footnote: 'EVERY COIN LAUNCHED ON SPAWN HATCHES ITS OWN WORM',
}));
save('post-9.png', renderActivityPNG({
  D, act: buy.act, layout: 'og', badge: 'SPAWN', title: ['EVERY BUY', 'POKES IT'],
  lines: ['3 TOUCH CELLS, PICKED FROM THE COIN\'S ADDRESS', 'THE SAME SPOT FOR EVERY BUY OF IT, LOGGED WITH THE TX'],
  footnote: 'THE WORM HAS NO IDEA WHAT A COIN IS. THE MAPPING IS OURS, AND IT IS PUBLIC.',
}));
save('post-10.png', renderActivityPNG({ D, act: sell.act, layout: 'og', ...none, cam: { persp: 0.7, yaw: -2.3, tilt: 0.4 }, box: [40, 0, 1160, 630] }));
save('post-11.png', renderActivityPNG({
  D, act: flood.act, layout: 'square', width: 1200, title: ['2,675 ', 'CELLS'],
  lines: ['26,881 SYNAPSES, 14,066 CONNECTIONS, NONE ADDED', 'A 3-DAY-OLD PLATYNEREIS LARVA, RE-RUN IN EVERY BROWSER'],
  footnote: 'DATA CC BY 4.0, VERASZTO ET AL., JEKELY LAB. NOT AFFILIATED.',
}));
save('post-12.png', renderActivityPNG({
  D, act: word.act, layout: 'og', badge: 'SPAWN', title: ['64% BUYS', '$WORM'],
  lines: ['OF EVERY COIN\'S CREATOR REWARDS SPAWN COLLECTS', 'EXACTLY WHAT IT BOUGHT IS BURNED, READ BACK FROM THE CHAIN'],
  footnote: 'THE OTHER 36% STAYS WITH THE TEAM',
}));

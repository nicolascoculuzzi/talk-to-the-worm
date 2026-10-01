#!/usr/bin/env node
// Images for the X account, rendered from the real wiring and real runs of the worm (server/render.js, the same
// renderer as the launch-moment token image and the link previews):
//   marketing/x/header.png   1500x500  the account header
//   marketing/x/post-1.png … post-5.png  1200x630  one per launch-day post
//
//   node scripts/make-x-art.js [CA]
//
// Every dot is a real soma position from data/wiring.json; brightness is the activity of a deterministic WormCore
// run shown a message, at the step with the most cells firing. Nothing here is drawn by hand.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WormCore } from '../shared/worm.js';
import { withTransmitters } from '../shared/data.js';
import { renderActivityPNG } from '../server/render.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'marketing', 'x');
const D = withTransmitters(JSON.parse(fs.readFileSync(path.join(ROOT, 'data/wiring.json'), 'utf8')), JSON.parse(fs.readFileSync(path.join(ROOT, 'data/transmitters.json'), 'utf8')));
const CA = process.argv[2] || '';
const commas = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

/** A real run: show the worm a message and keep the step with the most cells firing. */
function peak(message) {
  const worm = new WormCore(D);
  worm.say('x', message);
  let best = { n: -1 };
  for (let s = 0; s < 300; s++) {
    worm.tick();
    let n = 0;
    for (const v of worm.sim.r) if (v > 0.05) n++;
    if (n > best.n) best = { n, step: worm.step, act: Float32Array.from(worm.sim.r) };
  }
  return best;
}
function save(name, buf) {
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, name), buf);
  console.log(`marketing/x/${name}  ${(buf.length / 1024).toFixed(0)} KB`);
}
let syn = 0;
for (let k = 2; k < D.e.length; k += 3) syn += D.e[k];
const cells = commas(D.n.length), synapses = commas(syn);

save('header.png', renderActivityPNG({
  D, act: peak('gm').act, layout: 'banner', badge: 'LIVE',
  lines: ['ONE REAL WORM BRAIN, RUNNING LIVE.', 'EVERY BUY POKES IT.'],
  footnote: `BRAINWORMS.XYZ - ${cells} CELLS - ${synapses} SYNAPSES`,
}));

// 1. the launch: the CA, split so it stays readable
const ca = CA || 'CA GOES HERE AFTER THE LAUNCH';
const half = Math.ceil(ca.length / 2);
save('post-1.png', renderActivityPNG({
  D, act: peak('$WORM').act, layout: 'og', badge: 'LIVE ON PUMP.FUN',
  lines: ['$WORM IS LIVE. CA:', { text: ca.slice(0, half), color: 'amber' }, { text: ca.slice(half), color: 'amber' }],
  footnote: 'CREATED AT THE STEP A TOUCH STOPPED ITS CILIA - THE MOMENT IS IN THE PUBLIC LOG',
}));
// 2. what it is
save('post-2.png', renderActivityPNG({
  D, act: peak('hello').act, layout: 'og', badge: 'THE WORM',
  lines: [`${cells} CELLS. ${synapses} SYNAPSES.`, 'A REAL LARVA\'S WIRING, SIMULATED LIVE.', 'NOTHING INVENTED. NOTHING TRAINED.'],
  footnote: 'PLATYNEREIS DUMERILII - VERASZTO ET AL., ELIFE 2025 - CC BY 4.0',
}));
// 3. proof
save('post-3.png', renderActivityPNG({
  D, act: peak('proof').act, layout: 'og', badge: 'PROOF',
  lines: ['YOUR BROWSER CHECKS IT EVERY SECOND.', 'EVERY HOUR TIMESTAMPED INTO BITCOIN.', 'FAKE ONE STEP AND YOUR BROWSER CATCHES IT.'],
  footnote: 'REPLAY ANY HOUR OF THE LOG AT BRAINWORMS.XYZ',
}));
// 4. SPAWN
save('post-4.png', renderActivityPNG({
  D, act: peak('spawn').act, layout: 'og', badge: 'LAUNCHPAD', title: ['SPAWN'], titleColors: ['amber'],
  lines: ['LAUNCH A COIN. IT HATCHES ITS OWN WORM.', 'EVERY BUY POKES THE WORM.', 'ON PUMP.FUN. ABOUT 0.02 SOL.'],
  footnote: 'BRAINWORMS.XYZ/SPAWN',
}));
// 5. the buyback
save('post-5.png', renderActivityPNG({
  D, act: peak('burn').act, layout: 'og', badge: 'BUYBACK',
  lines: ['64% OF SPAWN CREATOR REWARDS BUY $WORM.', 'ALL OF IT IS BURNED.', 'EVERY BUY AND BURN IS A PUBLIC TX.'],
  footnote: 'MORE COINS, MORE BURN - BRAINWORMS.XYZ',
}));

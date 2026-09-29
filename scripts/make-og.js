#!/usr/bin/env node
// BRAINWORM link-preview images, rendered from the real wiring and a real run of the worm:
//   public/og.png               1200x630  (Open Graph / X summary_large_image)
//   public/apple-touch-icon.png  180x180
//
//   node scripts/make-og.js
//
// Every dot is a real soma position from data/wiring.json. Brightness is the activity of a
// deterministic WormCore run shown the message "gm", at the step with the most cells firing.
// The drawing itself is server/render.js (the same renderer as the launch-moment token image).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WormCore } from '../shared/worm.js';
import { withTransmitters } from '../shared/data.js';
import { renderActivityPNG } from '../server/render.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const D = withTransmitters(JSON.parse(fs.readFileSync(path.join(ROOT, 'data/wiring.json'), 'utf8')), JSON.parse(fs.readFileSync(path.join(ROOT, 'data/transmitters.json'), 'utf8')));
const commas = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

/** A real run: show the worm "gm" and keep the step with the most cells firing. */
function peakActivity() {
  const worm = new WormCore(D);
  worm.say('og', 'gm');
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
  fs.writeFileSync(path.join(ROOT, 'public', name), buf);
  console.log(`public/${name}  ${(buf.length / 1024).toFixed(0)} KB`);
}

const peak = peakActivity();
console.log(`peak: ${peak.n} cells firing at step ${peak.step}`);
let syn = 0;
for (let k = 2; k < D.e.length; k += 3) syn += D.e[k];

save('og.png', renderActivityPNG({
  D, act: peak.act, layout: 'og', badge: 'LIVE',
  lines: ['LAUNCH A COIN. IT HATCHES ITS OWN WORM.', 'A REAL LARVA\'S WIRING, SIMULATED LIVE.'],
  footnote: `PLATYNEREIS LARVA CONNECTOME - ${commas(D.n.length)} CELLS - ${commas(syn)} SYNAPSES`,
}));
save('apple-touch-icon.png', renderActivityPNG({ D, act: peak.act, layout: 'icon' }));

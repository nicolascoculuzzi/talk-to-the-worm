#!/usr/bin/env node
// SPAWN's logo and link preview:
//   public/spawn-logo.svg   the mark: a larva and the smaller one it spawned, in the dots of /favicon.svg
//   public/spawn-icon.png   180x180 of the same mark (home-screen icon)
//   public/spawn-og.png     1200x630 link preview
//
//   node scripts/make-spawn-art.js
//
// The mark is drawn from one list of dots, so the SVG and the PNG agree. In the link preview every dot is a real
// soma position from data/wiring.json, lit by a deterministic run of the worm poked the way a SPAWN buy pokes it
// (three touch cells picked from a SHA-256), at the step with the most cells firing; server/render.js draws it.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { WormCore } from '../shared/worm.js';
import { withTransmitters } from '../shared/data.js';
import { renderActivityPNG, encodePNG } from '../server/render.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BG = '#04070B', AMBER = '#FFB84D', TEAL = '#56E6D2', CORAL = '#FF6B5E';

// [x, y, r, colour, opacity] on a 64-unit square: the parent larva (the favicon's: eyespots, body, touch cells) and,
// down and to its right, the smaller one it spawned. Few, big dots, so it still reads at 16 px.
const MARK = [
  [17, 17, 4.4, AMBER], [31, 17, 4.4, AMBER],
  [24, 27, 3.2, TEAL, 0.9], [23, 36, 3.1, TEAL, 0.9], [25, 45, 2.8, TEAL, 0.9],
  [14, 32, 2.3, CORAL], [34, 38, 2.3, CORAL],
  [42, 37.5, 3, AMBER], [52, 37.5, 3, AMBER],
  [47, 44.5, 2.2, TEAL, 0.9], [46.4, 51, 2, TEAL, 0.9],
  [40, 48, 1.5, CORAL],
];

function svg() {
  const dots = MARK.map(([x, y, r, c, o]) => `<circle cx="${x}" cy="${y}" r="${r}" fill="${c}"${o ? ` opacity="${o}"` : ''}/>`).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="${BG}"/>${dots}</svg>\n`;
}

/** The mark as an opaque square PNG (iOS rounds the corners itself), 4x4 samples a pixel. */
function png(size) {
  const rgb = Buffer.alloc(size * size * 3), s = 64 / size, SS = 4;
  const hexRGB = (h) => [1, 3, 5].map((k) => parseInt(h.slice(k, k + 2), 16));
  const bg = hexRGB(BG), dots = MARK.map(([x, y, r, c, o = 1]) => ({ x, y, r, c: hexRGB(c), o }));
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      const acc = [0, 0, 0];
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const ux = (px + (sx + 0.5) / SS) * s, uy = (py + (sy + 0.5) / SS) * s;
          const col = [...bg];
          for (const d of dots) if ((ux - d.x) ** 2 + (uy - d.y) ** 2 <= d.r * d.r) for (let k = 0; k < 3; k++) col[k] += (d.c[k] - col[k]) * d.o;
          for (let k = 0; k < 3; k++) acc[k] += col[k];
        }
      }
      for (let k = 0; k < 3; k++) rgb[(py * size + px) * 3 + k] = Math.round(acc[k] / (SS * SS));
    }
  }
  return encodePNG(size, size, rgb);
}

/** A real run: poke the worm where a SPAWN buy of `seed` would, and keep the step with the most cells firing. */
function peakActivity(D, seed = 'SPAWN') {
  const worm = new WormCore(D), h = crypto.createHash('sha256').update(seed).digest(), touch = worm.roles.touch, cells = [];
  for (let k = 0; cells.length < 3 && k < h.length; k++) { const c = touch[h[k] % touch.length]; if (!cells.includes(c)) cells.push(c); }
  for (let s = 0; s < 30; s++) worm.tick();
  worm.poke('og', cells, { by: 'spawn' });
  let best = { n: -1 };
  for (let s = 0; s < 240; s++) {
    worm.tick();
    let n = 0;
    for (const v of worm.sim.r) if (v > 0.05) n++;
    if (n > best.n) best = { n, step: worm.step, act: Float32Array.from(worm.sim.r) };
  }
  return best;
}

function save(name, buf) {
  fs.writeFileSync(path.join(ROOT, 'public', name), buf);
  console.log(`public/${name}  ${(buf.length / 1024).toFixed(1)} KB`);
}

save('spawn-logo.svg', svg());
save('spawn-icon.png', png(180));
const D = withTransmitters(JSON.parse(fs.readFileSync(path.join(ROOT, 'data/wiring.json'), 'utf8')), JSON.parse(fs.readFileSync(path.join(ROOT, 'data/transmitters.json'), 'utf8')));
const peak = peakActivity(D);
console.log(`peak: ${peak.n} cells firing at step ${peak.step}`);
save('spawn-og.png', renderActivityPNG({
  D, act: peak.act, layout: 'og', badge: 'LAUNCHPAD', title: ['SPAWN'], titleColors: ['amber'],
  lines: ['COINS PRICED IN $BRAINWORM.', 'EVERY BUY POKES THE WORM.'],
  footnote: 'EVERY TRADE FEEDS THE $BRAINWORM BURN',
}));

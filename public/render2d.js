// Fallback renderer for browsers without WebGL2: the same camera and colours on a 2D canvas.
import { viewProj, deform } from '/gl.js';

// dot and glow scale the cells' size and brightness (a small canvas, like a coin's worm on /spawn, wants both larger)
export function create2DRenderer(canvas, { D, colors, kinds, dot = 1, glow = 0 }) {
  const cx = canvas.getContext('2d');
  const N = D.n.length, drawn = []; for (let i = 0; i < N; i++) if (D.n[i][5]) drawn.push(i);
  const sprites = {};
  for (const [k, c] of Object.entries(colors)) {
    const s = document.createElement('canvas'); s.width = s.height = 64; const g = s.getContext('2d');
    const hex = `rgb(${c[0]},${c[1]},${c[2]})`, gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    gr.addColorStop(0, '#fff'); gr.addColorStop(0.12, hex); gr.addColorStop(0.45, `rgba(${c[0]},${c[1]},${c[2]},.33)`); gr.addColorStop(1, `rgba(${c[0]},${c[1]},${c[2]},0)`);
    g.fillStyle = gr; g.fillRect(0, 0, 64, 64); sprites[k] = s;
  }
  let W = 0, H = 0, vp = null;
  function resize(w, h) { W = canvas.width = Math.max(2, Math.round(w)); H = canvas.height = Math.max(2, Math.round(h)); }
  function frame(s) {
    vp = viewProj(s.cam, W / H);
    const bg = cx.createRadialGradient(W / 2, H / 2, 0, W / 2, H / 2, Math.max(W, H) * 0.7);
    bg.addColorStop(0, '#0E1C27'); bg.addColorStop(1, '#04070B');
    cx.globalCompositeOperation = 'source-over'; cx.globalAlpha = 1; cx.fillStyle = bg; cx.fillRect(0, 0, W, H);
    cx.globalCompositeOperation = 'lighter';
    const base = H / 160;
    for (const i of drawn) {
      const [x, y, z] = deform(D.n[i][5], s.bend, s.st);
      const cw = vp[3] * x + vp[7] * y + vp[11] * z + vp[15];
      const sx = (vp[0] * x + vp[4] * y + vp[8] * z + vp[12]) / cw, sy = (vp[1] * x + vp[5] * y + vp[9] * z + vp[13]) / cw;
      const a = s.act[i] / 255, k = kinds[i], sz = dot * (base * (k === 'eye' ? 1.6 : 1) + a * base * 2.2) * 3.4 / cw;
      cx.globalAlpha = Math.min(0.95, glow + (k === 'eye' ? 0.5 : k === 'touch' ? 0.35 : 0.2) + a * 0.8);
      cx.drawImage(sprites[k], (sx * 0.5 + 0.5) * W - sz / 2, (0.5 - sy * 0.5) * H - sz / 2, sz, sz);
    }
    cx.globalAlpha = 1; cx.globalCompositeOperation = 'source-over';
  }
  return { kind: '2d', canvas, resize, frame, get vp() { return vp; }, get size() { return [W, H]; } };
}

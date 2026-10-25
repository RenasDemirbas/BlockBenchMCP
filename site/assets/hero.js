// Landing-page demo: the tool-call log plays line by line while an isometric fox is
// blocked out in grey, painted, then set to idle — the order a real session follows.
const SVG_NS = 'http://www.w3.org/2000/svg';
const COS30 = Math.cos(Math.PI / 6);
const S = 9; // px per model unit

// Model units, y up; the fox faces +z (screen lower left).
const PARTS = [
  { id: 'tail', paint: 'fur', x: [3, 5], y: [6, 8.5], z: [-4, 0] },
  { id: 'tail_tip', paint: 'white', x: [3, 5], y: [6, 8.5], z: [-5.5, -4] },
  { id: 'leg_bl', paint: 'dark', x: [1.5, 3], y: [0, 4], z: [1, 2.5] },
  { id: 'leg_br', paint: 'dark', x: [5, 6.5], y: [0, 4], z: [1, 2.5] },
  { id: 'leg_fl', paint: 'dark', x: [1.5, 3], y: [0, 4], z: [8.5, 10] },
  { id: 'leg_fr', paint: 'dark', x: [5, 6.5], y: [0, 4], z: [8.5, 10] },
  { id: 'body', paint: 'fur', x: [1, 7], y: [4, 9], z: [0, 11] },
  { id: 'head', paint: 'fur', x: [0.5, 7.5], y: [6, 12], z: [11, 15.5] },
  { id: 'snout', paint: 'white', x: [2.5, 5.5], y: [6.5, 9], z: [15.5, 18] },
  { id: 'ear_l', paint: 'dark', x: [1, 2.5], y: [12, 14], z: [12, 13.5] },
  { id: 'ear_r', paint: 'dark', x: [5.5, 7], y: [12, 14], z: [12, 13.5] },
];
// [top, +z face, +x face]
const SHADES = {
  grey: ['#d9dbe4', '#c4c7d4', '#aaaebf'],
  fur: ['#f7a24b', '#e8862a', '#c96c17'],
  white: ['#ffffff', '#ebecf3', '#d3d5e2'],
  dark: ['#4d475c', '#3b3648', '#2d2938'],
};

const proj = (x, y, z) => [(x - z) * COS30 * S, (x + z) * 0.5 * S - y * S];
const poly = (pts) => 'M' + pts.map(([a, b]) => `${a.toFixed(1)} ${b.toFixed(1)}`).join(' L') + ' Z';

function faces({ x: [x0, x1], y: [y0, y1], z: [z0, z1] }) {
  return [
    [proj(x0, y1, z0), proj(x1, y1, z0), proj(x1, y1, z1), proj(x0, y1, z1)], // top
    [proj(x0, y1, z1), proj(x1, y1, z1), proj(x1, y0, z1), proj(x0, y0, z1)], // +z
    [proj(x1, y1, z0), proj(x1, y1, z1), proj(x1, y0, z1), proj(x1, y0, z0)], // +x
  ];
}

/** Painter's order for boxes that don't intersect: A is drawn before B when B is in front of it. */
function drawOrder(parts) {
  const behind = (a, b) => a.x[1] <= b.x[0] || a.z[1] <= b.z[0] || a.y[1] <= b.y[0];
  const left = [...parts], out = [];
  while (left.length) {
    // Next is a box nothing else still has to be drawn before (mutual cases don't overlap on screen).
    const i = left.findIndex((a) => !left.some((b) => b !== a && behind(b, a) && !behind(a, b)));
    out.push(...left.splice(i < 0 ? 0 : i, 1));
  }
  return out;
}

function build(svg) {
  const rig = document.createElementNS(SVG_NS, 'g');
  rig.setAttribute('class', 'rig');
  const tail = document.createElementNS(SVG_NS, 'g');
  tail.setAttribute('class', 'tail');
  const nodes = new Map();
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const part of drawOrder(PARTS)) {
    const g = document.createElementNS(SVG_NS, 'g');
    g.setAttribute('class', 'box');
    faces(part).forEach((pts, i) => {
      const p = document.createElementNS(SVG_NS, 'path');
      p.setAttribute('d', poly(pts));
      p.setAttribute('fill', SHADES.grey[i]);
      p.dataset.shade = String(i);
      g.append(p);
      for (const [a, b] of pts) { minX = Math.min(minX, a); maxX = Math.max(maxX, a); minY = Math.min(minY, b); maxY = Math.max(maxY, b); }
    });
    nodes.set(part.id, { g, part });
    (part.id.startsWith('tail') ? tail : rig).append(g);
  }
  rig.prepend(tail);
  const pad = 14;
  svg.setAttribute('viewBox', `${minX - pad} ${minY - pad - 6} ${maxX - minX + pad * 2} ${maxY - minY + pad * 2 + 6}`);
  svg.append(rig);
  return nodes;
}

function start() {
  const svg = document.querySelector('#fox');
  const log = [...document.querySelectorAll('.demo-log li')];
  if (!svg || !log.length) return;
  const nodes = build(svg);
  const stage = svg.closest('.demo');
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  let timers = [];

  const paint = () => nodes.forEach(({ g, part }) => g.querySelectorAll('path').forEach((p) => p.setAttribute('fill', SHADES[part.paint][Number(p.dataset.shade)])));
  const finalState = () => {
    log.forEach((li) => li.classList.add('on'));
    nodes.forEach(({ g }) => g.classList.remove('hidden'));
    paint();
    stage.classList.add('idle');
  };

  function play() {
    timers.forEach(clearTimeout);
    timers = [];
    stage.classList.add('playing');
    stage.classList.remove('idle');
    log.forEach((li) => li.classList.remove('on'));
    nodes.forEach(({ g }) => {
      g.classList.add('hidden');
      g.querySelectorAll('path').forEach((p) => p.setAttribute('fill', SHADES.grey[Number(p.dataset.shade)]));
    });
    const at = (ms, fn) => timers.push(setTimeout(fn, ms));
    // Each log line fires its step; data-step names what it does to the model.
    let t = 200;
    for (const li of log) {
      const step = li.dataset.step;
      at(t, () => li.classList.add('on'));
      if (step === 'cubes') {
        [...nodes.values()].forEach(({ g }, i) => at(t + 150 + i * 130, () => g.classList.remove('hidden')));
        t += 150 + nodes.size * 130;
      }
      if (step === 'paint') at(t + 150, paint);
      if (step === 'animate') at(t + 150, () => stage.classList.add('idle'));
      t += step === 'prompt' ? 900 : 650;
    }
  }

  stage.querySelector('.replay')?.addEventListener('click', play);
  // The finished fox is the resting state (thumbnails, reduced motion, before the demo scrolls in).
  finalState();
  if (!reduced) {
    // Start when the demo is on screen, so it is not over before anyone looks.
    const io = new IntersectionObserver(([e]) => { if (e.isIntersecting) { io.disconnect(); play(); } }, { threshold: 0.3 });
    io.observe(stage);
  }
}

start();

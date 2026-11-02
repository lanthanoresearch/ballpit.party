/* Shared map generator: runs in Node (server) and in the browser (client).
   Maps are deterministic from their seed, so the server only says "map number N"
   and every player builds exactly the same world. */
(function (root) {
  'use strict';
  const TS = 40; // tile size in px
  const R = 14;  // ball radius in px

  // Tile types: 0 air, 1 solid, 2 lava, 3 ice, 4 finish (solid, checkered), 5 water
  function rng(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // segs: [mode, platformCount]. Every vertical segment is followed by a 'right' one.
  // mirror: the real path heads LEFT instead of right. decoy: a dead-end path on the other side.
  const DEFS = [
    { name: 'Canyon Run', seed: 505, bg: '#4a2f1a', n: 360, mirror: true,
      segs: [['right', 36], ['down', 22], ['right', 36], ['up', 26]],
      decoy: { segs: [['right', 1000]], n: 90 }, ice: 0.14, lava: 0.22, pillar: 0.14, narrow: 0.08, water: 0.14 },
    { name: 'Frostbite Descent', seed: 202, bg: '#16344a', n: 380, segs: [['down', 1000]], mirror: false,
      decoy: { segs: [['up', 1000]], n: 100 }, ice: 0.40, lava: 0.15, pillar: 0.08, narrow: 0.08, water: 0 },
    { name: 'Skyline Climb', seed: 303, bg: '#241a45', n: 420, segs: [['up', 1000]], mirror: false,
      decoy: { segs: [['down', 1000]], n: 110 }, ice: 0.15, lava: 0.15, pillar: 0.08, narrow: 0.08, water: 0 }
  ];

  // Builds one chain of platforms growing out of a virtual start platform at (0,0), 9 wide.
  function chain(seed, segs, n, p, withFinish) {
    const Rn = rng(seed);
    const ri = (a, b) => a + Math.floor(Rn() * (b - a + 1));
    const pick = a => a[Math.floor(Rn() * a.length)];
    const rects = [], path = [];
    let fin = null;
    let px = 0, py = 0, pl = 9;
    let si = 0, mode = segs[0][0], sleft = segs[0][1];
    let hdir = 1, lo = -1, hi = pl + (mode === 'up' ? 30 : 34);
    let baseY = 0, lock = 0, lockSign = 0, prevMode = mode;

    function enter(nm) {
      if (nm === 'right') {
        if (prevMode === 'down') { lock = 10; lockSign = 1; }
        else if (prevMode === 'up') { lock = 10; lockSign = -1; }
        baseY = py;
      } else {
        hdir = 1; lo = px - 1; hi = px + pl + (nm === 'up' ? 30 : 34);
      }
      prevMode = nm; mode = nm;
    }

    const total = n + (withFinish ? 1 : 0);
    for (let i = 1; i <= total; i++) {
      const last = withFinish && i === total;
      if (!last && sleft <= 0) {
        si = (si + 1) % segs.length;
        sleft = segs[si][1];
        enter(segs[si][0]);
      }
      sleft--;

      const rest = (!last && i % 18 === 0);                                   // safe breather platform
      const narrow = (!last && !rest && Rn() < p.narrow);
      const water = (!last && !rest && !narrow && mode === 'right' && Rn() < p.water);
      const L = last ? 14 : rest ? 8 : water ? ri(8, 10) : narrow ? ri(2, 3) : (mode === 'up' ? ri(3, 6) : ri(4, 8));

      let dy, gap;
      if (mode === 'right') {
        let o = [-2, -1, -1, 0, 0, 0, 1, 1, 2, 3];
        const off = py - baseY;
        if (off > 10) o = [-2, -1, -1, 0]; else if (off < -10) o = [0, 1, 2, 3];
        if (lock > 0) { o = o.filter(v => v * lockSign >= 0); if (!o.length) o = [0]; lock--; }
        dy = pick(o);
        gap = dy === -2 ? 2 : dy < 0 ? ri(2, 3) : dy >= 2 ? ri(2, 4) : ri(2, 3);
      } else if (mode === 'down') {
        dy = ri(3, 4);   // big drops keep 3+ tiles of head-room between zig-zag layers
        gap = ri(2, 4);
      } else { // up
        dy = -2;   // always a full 2-tile step so zig-zag layers keep head-room between them
        gap = 2;
      }

      let nx;
      if (mode === 'right') {
        nx = px + pl + gap;
      } else {
        const place = () => (hdir > 0 ? px + pl + gap : px - gap - L);
        nx = place();
        // when the zig-zag doubles back it passes under the previous layer, so keep that drop short
        if (hdir > 0 && nx + L > hi) { hdir = -1; gap = 2; nx = place(); }
        else if (hdir < 0 && nx < lo) { hdir = 1; gap = 2; nx = place(); }
      }
      const ny = py + dy;

      let t = 1;
      if (!rest && !last && !narrow && !water && Rn() < p.ice) t = 3;
      if (last) {
        rects.push([nx, ny, L, 1, 4]);
        rects.push([nx, ny + 1, L, 1, 1]);
        fin = [nx, ny, L];
      } else if (water) {
        const w = ri(4, L - 4), off = ri(2, L - w - 2);
        rects.push([nx, ny, L, 4, 1]);            // thick platform...
        rects.push([nx + off, ny, w, 3, 5]);      // ...with a 3-deep water pool carved into it
      } else {
        rects.push([nx, ny, L, 2, t]);
      }
      if (!rest && !last && !narrow && !water && (t === 1 || Rn() < 0.25)) {
        if (L >= 7 && Rn() < p.lava) {
          const lw = ri(1, 2), off = ri(2, L - lw - 2);
          rects.push([nx + off, ny, lw, 2, 2]);   // lava pit
        } else if (L >= 7 && Rn() < p.pillar) {
          const off = ri(2, L - 4);   // leaves 3+ tiles to land on after hopping it
          rects.push([nx + off, ny - 1, 1, 1, 2]); // lava block on top
        }
      }
      path.push([nx, ny, L]);
      px = nx; py = ny; pl = L;
    }
    return { rects, fin, path };
  }

  // Mirror a chain left<->right around the start platform's centre (start platform is x 0..9)
  function mirror(list) { for (const r of list) r[0] = 9 - r[0] - r[2]; }

  const cache = {};

  function generate(idx) {
    idx = ((idx % DEFS.length) + DEFS.length) % DEFS.length;
    if (cache[idx]) return cache[idx];
    const d = DEFS[idx];

    const real = chain(d.seed, d.segs, d.n, d, true);
    const dec = chain(d.seed + 777, d.decoy.segs, d.decoy.n, d, false);
    const fin = real.fin;
    const path = [[0, 0, 9]].concat(real.path);

    if (d.mirror) { mirror(real.rects); mirror(path); mirror([fin]); }
    else { mirror(dec.rects); }                 // decoy always goes the opposite way

    const rects = [[0, 0, 9, 2, 1]].concat(real.rects, dec.rects);

    let minX = 1e9, minY = 1e9, maxX = -1e9, maxY = -1e9;
    for (const r of rects) {
      minX = Math.min(minX, r[0]); minY = Math.min(minY, r[1]);
      maxX = Math.max(maxX, r[0] + r[2]); maxY = Math.max(maxY, r[1] + r[3]);
    }
    const ox = 3 - minX, oy = 14 - minY;
    for (const r of rects) { r[0] += ox; r[1] += oy; }
    for (const q of path) { q[0] += ox; q[1] += oy; }
    fin[0] += ox; fin[1] += oy;

    const W = maxX + ox + 3;
    const maxBottom = maxY + oy;
    const H = maxBottom + 12;

    const map = {
      idx, name: d.name, bg: d.bg,
      TS, W, H, rects, path,
      start: [(ox + 4.5) * TS, oy * TS - R - 1],   // the one community spawn point
      finish: fin,
      flag: [fin[0] + fin[2] / 2, fin[1]],
      killY: (maxBottom + 7) * TS
    };
    cache[idx] = map;
    return map;
  }

  const api = { TS, R, count: DEFS.length, names: DEFS.map(d => d.name), generate };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.BallMaps = api;
})(typeof window !== 'undefined' ? window : globalThis);

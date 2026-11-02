/* Shared map generator: runs in Node (server) and in the browser (client).
   Maps are deterministic from their seed, so the server only says "map number N"
   and every player builds exactly the same world.

   Each map is: one real route to the finish + a long decoy route the other way, both made of
   themed regions (meadow, desert, caves, crystals, snow, ice caves, volcano, sky...), with lots
   of side branches (shafts, towers, tunnels) that end in explorable rooms. */
(function (root) {
  'use strict';
  const TS = 40; // tile size in px
  const R = 14;  // ball radius in px

  // Tile types: 0 air, 1 solid, 2 lava, 3 ice, 4 finish (solid, checkered), 5 water, 6 bounce pad (flush with the floor), 9 door (added by the game, never in rects)
  const THEMES = [
    { id: 'meadow',   bg: '#78c4ec', solid: '#7b5a3a', top: '#5cbc42', deco: 'tree' },
    { id: 'forest',   bg: '#2c6a4a', solid: '#55402a', top: '#3f9a3a', deco: 'pine' },
    { id: 'desert',   bg: '#efc489', solid: '#b6764a', top: '#e0ad66', deco: 'cactus' },
    { id: 'cave',     bg: '#1d1b27', solid: '#4b4760', top: '#6c6788', deco: 'rock', cave: 1 },
    { id: 'crystal',  bg: '#16123a', solid: '#383072', top: '#7b6ce0', deco: 'crystal', cave: 1 },
    { id: 'mushroom', bg: '#2b1634', solid: '#5a3a6c', top: '#c85aa0', deco: 'mushroom', cave: 1 },
    { id: 'snow',     bg: '#38526f', solid: '#c7d2de', top: '#f6f9fc', deco: 'snowpine' },
    { id: 'icecave',  bg: '#0e2740', solid: '#2c5b7e', top: '#5f98c2', deco: 'icicle', cave: 1 },
    { id: 'volcano',  bg: '#2c1011', solid: '#4a3032', top: '#6e4748', deco: 'spike', cave: 1 },
    { id: 'sky',      bg: '#a9dcff', solid: '#eef2f9', top: '#ffffff', deco: 'cloud' },
    { id: 'night',    bg: '#130e2e', solid: '#3b3663', top: '#5c559e', deco: 'star' }
  ];
  const TH = {}; THEMES.forEach((t, i) => { TH[t.id] = i; });

  // what lies beneath / beside each kind of place (for side branches)
  const UNDER = {
    meadow: ['cave', 'mushroom', 'forest'], forest: ['cave', 'mushroom', 'crystal'], desert: ['cave', 'desert', 'volcano'],
    cave: ['crystal', 'cave', 'mushroom', 'icecave'], crystal: ['crystal', 'cave', 'icecave'], mushroom: ['mushroom', 'cave', 'crystal'],
    snow: ['icecave', 'snow', 'cave'], icecave: ['icecave', 'crystal', 'snow'], volcano: ['volcano', 'cave', 'crystal'],
    sky: ['sky', 'night'], night: ['night', 'sky', 'crystal']
  };

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

  const S = (m, n, th, o) => Object.assign({ m, n, th }, o || {});

  // Real route: segs. Every vertical segment must be followed by a 'right' one.
  const DEFS = [
    { name: 'Emberfall Expanse', seed: 505, mirror: true, br: [2, 4],
      segs: [S('right', 34, 'meadow', { ice: 0.05, lava: 0.12 }), S('right', 30, 'desert', { ice: 0, lava: 0.22 }), S('down', 22, 'desert'),
        S('right', 44, 'cave', { cave: 1, water: 0.2 }), S('right', 34, 'crystal', { cave: 1, ice: 0.2 }), S('down', 24, 'crystal'),
        S('right', 44, 'volcano', { cave: 1, lavasea: 1, lava: 0.3, ice: 0, water: 0 }), S('up', 28, 'volcano'), S('right', 36, 'night', { ice: 0.2 })],
      decoy: [S('right', 36, 'forest'), S('right', 36, 'mushroom', { cave: 1 }), S('right', 36, 'snow', { ice: 0.35 }), S('right', 36, 'icecave', { cave: 1, ice: 0.4 })],
      ice: 0.14, lava: 0.18, pillar: 0.12, narrow: 0.08, water: 0.12 },
    { name: 'Frostbite Descent', seed: 202, mirror: false, br: [2, 4],
      segs: [S('down', 30, 'snow', { ice: 0.35 }), S('right', 22, 'snow', { ice: 0.35 }), S('down', 38, 'icecave', { ice: 0.45 }),
        S('right', 34, 'icecave', { cave: 1, ice: 0.45 }), S('down', 38, 'crystal'), S('right', 28, 'crystal', { cave: 1 }),
        S('down', 44, 'volcano', { lava: 0.25, ice: 0 }), S('right', 28, 'volcano', { cave: 1, lavasea: 1, lava: 0.28, ice: 0 })],
      decoy: [S('up', 40, 'forest'), S('right', 12, 'forest'), S('up', 40, 'sky'), S('right', 12, 'sky')],
      ice: 0.2, lava: 0.15, pillar: 0.08, narrow: 0.08, water: 0 },
    { name: 'Skyline Climb', seed: 303, mirror: false, br: [2, 4],
      segs: [S('up', 30, 'forest'), S('right', 20, 'forest'), S('up', 34, 'mushroom'), S('right', 30, 'mushroom', { cave: 1 }),
        S('up', 38, 'sky'), S('right', 26, 'sky', { ice: 0.2 }), S('up', 40, 'night'), S('right', 20, 'night')],
      decoy: [S('down', 36, 'desert'), S('right', 14, 'desert'), S('down', 40, 'cave'), S('right', 14, 'crystal', { cave: 1 })],
      ice: 0.15, lava: 0.15, pillar: 0.08, narrow: 0.08, water: 0 }
  ];

  /* Platforms are tracked in a spatial grid so side branches never cross anything. */
  function Occ() {
    const CS = 8, g = new Map(), boxes = [];
    const key = (cx, cy) => (cx + 6000) * 12011 + (cy + 6000);
    function cells(x0, y0, x1, y1, fn) {
      for (let cx = Math.floor(x0 / CS); cx <= Math.floor(x1 / CS); cx++)
        for (let cy = Math.floor(y0 / CS); cy <= Math.floor(y1 / CS); cy++) fn(key(cx, cy));
    }
    return {
      add(x0, y0, x1, y1) {
        const b = [x0, y0, x1, y1]; boxes.push(b);
        cells(x0, y0, x1, y1, k => { let l = g.get(k); if (!l) { l = []; g.set(k, l); } l.push(b); });
      },
      free(x0, y0, x1, y1) {
        let ok = true;
        cells(x0, y0, x1, y1, k => {
          if (!ok) return;
          const l = g.get(k); if (!l) return;
          for (let i = 0; i < l.length; i++) { const b = l[i]; if (b[0] < x1 && b[2] > x0 && b[1] < y1 && b[3] > y0) { ok = false; return; } }
        });
        return ok;
      }
    };
  }

  /* Builds one chain of platforms growing out of a virtual start platform at (0,0).
     o: seed, segs, p (default hazard odds), withFinish, startW, ok(nx,ny,L,h) -> may this platform exist? */
  function chain(o) {
    const Rn = rng(o.seed);
    const ri = (a, b) => a + Math.floor(Rn() * (b - a + 1));
    const pick = a => a[Math.floor(Rn() * a.length)];
    const segs = o.segs, rects = [], path = [];
    let fin = null, gid = 0, ng = 1;
    let px = 0, py = 0, pl = o.startW || 9;
    let si = 0, seg = segs[0], mode = seg.m, sleft = seg.n;
    let hdir = 1, lo = -1, hi = pl + (mode === 'up' ? 30 : 34);
    let baseY = 0, lock = 0, lockSign = 0, prevMode = mode;
    const sp = k => (seg[k] !== undefined ? seg[k] : o.p[k]);
    let total = 0; segs.forEach(s => { total += s.n; });
    if (o.withFinish) total += 1;

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

    for (let i = 1; i <= total; i++) {
      const last = o.withFinish && i === total;
      if (!last && sleft <= 0) {
        si++; seg = segs[si]; sleft = seg.n; gid = ng++;
        enter(seg.m);
      }
      sleft--;

      const rest = (!last && i % 18 === 0 && mode === 'right');                                   // safe breather platform
      const narrow = (!last && !rest && Rn() < sp('narrow'));
      const water = (!last && !rest && !narrow && mode === 'right' && Rn() < sp('water'));
      const L = last ? 16 : rest ? 12 : water ? ri(8, 11) : narrow ? ri(2, 3) : (mode === 'up' ? ri(4, 7) : ri(5, 10));

      let dy, gap;
      if (mode === 'right') {
        let oo = [-3, -2, -1, -1, 0, 0, 0, 1, 1, 2, 3, 4];
        const off = py - baseY;
        if (off > 12) oo = [-3, -2, -1, 0]; else if (off < -12) oo = [0, 1, 2, 3, 4];
        if (lock > 0) { oo = oo.filter(v => v * lockSign >= 0); if (!oo.length) oo = [0]; lock--; }
        dy = pick(oo);
        gap = dy <= -3 ? 2 : dy < 0 ? ri(2, 4) : dy >= 2 ? ri(2, 5) : ri(2, 5);
      } else if (mode === 'down') {
        dy = ri(3, 5);   // big drops keep 3+ tiles of head-room between zig-zag layers
        gap = ri(2, 5);
      } else {
        dy = -2;         // always a full 2-tile step so zig-zag layers keep head-room
        gap = 2;
      }

      let nx;
      if (mode === 'right') {
        nx = px + pl + gap;
      } else {
        const place = () => (hdir > 0 ? px + pl + gap : px - gap - L);
        nx = place();
        if (hdir > 0 && nx + L > hi) { hdir = -1; gap = 2; nx = place(); }
        else if (hdir < 0 && nx < lo) { hdir = 1; gap = 2; nx = place(); }
      }
      const ny = py + dy;
      const h = water ? 4 : 2;
      if (o.ok && !o.ok(nx, ny, L, h)) break;

      const thI = TH[seg.th];
      let t = 1, hz = 0;
      if (!rest && !last && !narrow && !water && Rn() < sp('ice')) t = 3;
      if (last) {
        rects.push([nx, ny, L, 1, 4, thI, gid]);
        rects.push([nx, ny + 1, L, 1, 1, thI, gid]);
        fin = [nx, ny, L];
      } else if (water) {
        const w = ri(4, L - 4), off = ri(2, L - w - 2);
        rects.push([nx, ny, L, 4, 1, thI, gid]);            // thick platform...
        rects.push([nx + off, ny, w, 3, 5, thI, gid]);      // ...with a 3-deep water pool carved into it
      } else {
        rects.push([nx, ny, L, 2, t, thI, gid]);
        if (L >= 5) {   // rounded, hand-built underside so every platform reads like a little island
          rects.push([nx + 1, ny + 2, L - 2, 1, 1, thI, gid]);
          if (L >= 7) rects.push([nx + 2, ny + 3, L - 4, 1, 1, thI, gid]);
        }
      }
      if (!rest && !last && !narrow && !water && (t === 1 || Rn() < 0.25)) {
        if (L >= 7 && !rest && Rn() < sp('lava')) {
          const lw = ri(1, 2), off = ri(2, L - lw - 2);
          rects.push([nx + off, ny, lw, 2, 2, thI, gid]);   // lava pit
          hz = 1;
        } else if (L >= 7 && Rn() < sp('pillar')) {
          const off = ri(2, L - 4);   // leaves 3+ tiles to land on after hopping it
          rects.push([nx + off, ny - 1, 1, 1, 2, thI, gid]); // lava block on top
          hz = 1;
        }
      }
      if (!hz && !last && !water && !narrow && !rest && t === 1 && mode === 'right' && L >= 6 && Rn() < 0.12) {
        rects.push([nx + L - 3, ny - 1, 3, 1, 1, thI, gid]);   // raised ledge at the exit end
        hz = 1;
      }
      path.push([nx, ny, L, thI, mode === 'right' ? 0 : mode === 'down' ? 1 : 2, gid, seg.cave ? 1 : 0, h, seg.lavasea ? 1 : 0,
        (!hz && !last && !water && !narrow && t === 1 && L >= 8) ? 1 : 0, rest ? 1 : 0]);
      px = nx; py = ny; pl = L;
    }
    return { rects, fin, path, ng };
  }

  const cache = {};

  function generate(idx) {
    idx = ((idx % DEFS.length) + DEFS.length) % DEFS.length;
    if (cache[idx]) return cache[idx];
    const d = DEFS[idx];
    const occ = Occ(), occB = Occ();   // occ: platforms + their jump room; occB: just the solid bodies (for floating districts)
    let ABS = null;
    const rects = [], gz = {};
    let gidN = 0, branchCount = 0;
    const MAXB = 520;
    const coins = [], gad = { doors: [], plates: [], btns: [], see: [] }, decor = [];
    const coin = (x, y, k) => coins.push([x, y, k || 0]);
    const coinRow = (x, y, n, st, k) => { for (let i = 0; i < n; i++) coin(x + i * st, y, k); };
    const BR = rng(d.seed + 4242);
    const bri = (a, b) => a + Math.floor(BR() * (b - a + 1));
    const BP = { ice: 0.08, lava: 0.1, pillar: 0.06, narrow: 0.05, water: 0.1 };

    function addRect(r) {
      rects.push(r);
      let z = gz[r[6]];
      if (!z) z = gz[r[6]] = [1e9, 1e9, -1e9, -1e9, r[5]];
      if (r[0] < z[0]) z[0] = r[0]; if (r[1] < z[1]) z[1] = r[1];
      if (r[0] + r[2] > z[2]) z[2] = r[0] + r[2]; if (r[1] + r[3] > z[3]) z[3] = r[1] + r[3];
    }
    const boxOf = e => [e[0] - 1, e[1] - 6, e[0] + e[2] + 1, e[1] + e[7] + 2];

    // put a relative chain into the world: origin platform spans [X, X+PL] at height Y; dir -1 mirrors it
    function placeChain(res, X, Y, PL, dir, gbase) {
      for (const r of res.rects) {
        const w = r[2], x = dir > 0 ? X + r[0] : X + PL - r[0] - w;
        addRect([x, Y + r[1], w, r[3], r[4], r[5], r[6] + gbase]);
      }
      const out = [];
      for (const e of res.path) {
        const x = dir > 0 ? X + e[0] : X + PL - e[0] - e[2];
        const w = [x, Y + e[1], e[2], e[3], e[4], e[5] + gbase, e[6], e[7], e[8], e[9], e[10] || 0];
        out.push(w); const b = boxOf(w); occ.add(b[0], b[1], b[2], b[3]); occB.add(w[0] - 1, w[1] - 1, w[0] + w[2] + 1, w[1] + w[7] + 1);
      }
      return out;
    }

    // a tunnel roof above cave-themed 'right' platforms (never where something else lives)
    function addCeilings(pw) {
      for (let i = 0; i < pw.length; i++) {
        const e = pw[i];
        if (!e[6] || e[4] !== 0) continue;
        let m = 1e9;
        for (let j = Math.max(0, i - 3); j <= Math.min(pw.length - 1, i + 3); j++) m = Math.min(m, pw[j][1]);
        const cy = m - 7, a = e[0], b = e[0] + e[2];
        let x0 = a, x1 = b;
        if (i > 0) { const p = pw[i - 1], pa = p[0], pb = p[0] + p[2]; if (pb <= a) x0 = pb; else if (b <= pa) x1 = pa; }
        if (!occ.free(x0, cy - 5, x1, cy)) continue;
        occ.add(x0, cy - 5, x1, cy);
        addRect([x0, cy - 5, x1 - x0, 5, 1, e[3], e[5]]);
        for (let x = x0 + 1; x < x1 - 1; x += 3) if (BR() < 0.4) addRect([x, cy, 1, bri(1, 2), 1, e[3], e[5]]);   // hanging rock
      }
    }
    // little things to climb on
    function addStructures(pw) {
      for (let i = 0; i < pw.length; i++) {
        const e = pw[i];
        if (!e[9] || e[4] !== 0 || BR() > 0.5) continue;
        const L = e[2], y = e[1], th = e[3], g = e[5], k = BR();
        e[9] = 0;   // something stands here now
        if (k < 0.4) {            // little hill: steps up and down, one tile each
          const w = bri(5, L - 4), x = e[0] + bri(2, L - w - 2);
          addRect([x, y - 1, w, 1, 1, th, g]); addRect([x + 1, y - 2, w - 2, 1, 1, th, g]);
          if (w >= 7) addRect([x + 2, y - 3, w - 4, 1, 1, th, g]);
        } else if (k < 0.65) {    // two stumps to hop between
          const x = e[0] + bri(2, L - 7);
          addRect([x, y - 2, 1, 2, 1, th, g]); addRect([x + 4, y - 2, 1, 2, 1, th, g]);
        } else if (k < 0.85) {    // a single block
          addRect([e[0] + bri(2, L - 5), y - 1, 2, 1, 1, th, g]);
        } else if (k < 0.93 && L >= 7) {   // a Jenga tower or a crate pyramid to knock down
          const x = e[0] + bri(2, L - 5);
          if (BR() < 0.55) jenga(x, y, bri(4, 7)); else cratePyramid(x, y, bri(3, 4));
        } else if (L >= 12 && !e[6]) {   // an arch to walk through
          const x = e[0] + bri(2, L - 9);
          addRect([x, y - 4, 1, 4, 1, th, g]); addRect([x + 5, y - 4, 1, 4, 1, th, g]); addRect([x - 1, y - 5, 8, 1, 1, th, g]);
        }
      }
    }
    // pushable yellow crates and balls (each player gets their own copy; they are optional toys and shortcuts)
    const props = [];
    function jenga(x, y, layers) {      // a Jenga-style tower of small crates: knock it over
      for (let k = 0; k < layers; k++) {
        const ty = y - 0.9 * k - 0.02;
        if (k % 2 === 0) { props.push([0, x, ty]); props.push([0, x + 0.96, ty]); } else { props.push([0, x + 0.48, ty]); }
      }
    }
    function cratePyramid(x, y, rows) {
      for (let r = 0; r < rows; r++) for (let c = 0; c < rows - r; c++) props.push([0, x + r * 0.5 + c * 0.96, y - 0.9 * r - 0.02]);
    }
    function crateColumn(x, y, n) { for (let k = 0; k < n; k++) props.push([0, x, y - 0.9 * k - 0.02]); }
    function padShelf(e) {   // a bounce pad that throws you up to a shelf full of coins
      const x = e[0] + 2 + bri(0, Math.max(0, e[2] - 9)), y = e[1];
      if (!occ.free(x - 2, y - 14, x + 9, y - 5)) return false;
      occ.add(x - 2, y - 14, x + 9, y - 5);
      addRect([x, y, 3, 1, 6, e[3], e[5]]);
      const sx = x + 2 + (BR() < 0.5 ? 0 : 1), sh = bri(6, 7);
      addRect([sx, y - sh, 6, 2, 1, e[3], e[5]]);
      coinRow(sx + 0.5 + 0.5, y - sh - 0.9, 5, 1, 0); coin(sx + 3, y - sh - 2.1, 1);
      coinRow(x + 0.5, y - 3.2, 1, 1, 0); coin(x + 1.5, y - 4.4, 0); coin(x + 1.5, y - 5.6, 0);
      return true;
    }
    function addProps(pw, prob) {
      for (let i = 0; i < pw.length; i++) {
        const e = pw[i];
        if (!e[9] || BR() > prob) continue;
        const k = BR(), kind = k < 0.4 ? 0 : k < 0.62 ? 1 : k < 0.84 ? 2 : 3;
        if (BR() < 0.14 && e[2] >= 10) { jenga(e[0] + bri(2, e[2] - 6), e[1], bri(4, 8)); continue; }
        if (BR() < 0.25 && e[2] >= 9) { crateColumn(e[0] + bri(2, e[2] - 4), e[1], bri(3, 5)); continue; }
        const n = (kind === 0 && BR() < 0.4) ? 2 : 1;                    // sometimes two crates side by side
        const x = e[0] + bri(2, e[2] - 3);
        props.push([kind, x, e[1]]);
        if (n === 2 && x + 1 < e[0] + e[2] - 1) props.push([0, x + 1, e[1]]);
        else if (kind === 0 && BR() < 0.3) props.push([0, x, e[1] - 1]);  // stacked
      }
    }
    function addCoins(pw, dens) {
      for (let i = 0; i < pw.length; i++) {
        const e = pw[i];
        if (e[2] >= 3 && BR() < dens) {
          const n = Math.min(6, Math.floor((e[2] - 1) / 2)), x0 = e[0] + e[2] / 2 - (n - 1);
          for (let k = 0; k < n; k++) coin(x0 + k * 2, e[1] - 1.0, 0);
        }
        const nx = pw[i + 1];
        if (nx && e[4] === 0 && nx[4] === 0 && BR() < dens * 0.7) {
          const a = nx[0] >= e[0] + e[2] ? e[0] + e[2] : nx[0] + nx[2] <= e[0] ? nx[0] + nx[2] : null;
          if (a !== null) {
            const b = nx[0] >= e[0] + e[2] ? nx[0] : e[0], mid = (a + b) / 2, top = Math.min(e[1], nx[1]) - 3.4;
            coin(mid - 1, top + 0.9, 0); coin(mid, top, 0); coin(mid + 1, top + 0.9, 0);
          }
        }
      }
    }
    // a river of lava a few tiles below the platforms
    function addLavaSea(pw) {
      for (let i = 0; i < pw.length; i++) {
        const e = pw[i];
        if (!e[8] || e[4] !== 0) continue;
        let m = -1e9;
        for (let j = Math.max(0, i - 3); j <= Math.min(pw.length - 1, i + 3); j++) m = Math.max(m, pw[j][1] + pw[j][7]);
        const ly = m + 4, a = e[0], b = e[0] + e[2];
        let x0 = a, x1 = b;
        if (i > 0) { const p = pw[i - 1], pa = p[0], pb = p[0] + p[2]; if (pb <= a) x0 = pb; else if (b <= pa) x1 = pa; }
        if (!occ.free(x0, ly, x1, ly + 3)) continue;
        occ.add(x0, ly, x1, ly + 3);
        addRect([x0, ly, x1 - x0, 3, 2, e[3], e[5]]);
      }
    }

    // grow a side chain out of world platform e; tries both directions, keeps the longer one
    function grow(e, segs, seed) {
      const X = e[0], Y = e[1], PL = e[2];
      let best = null;
      for (const dir of ((seed & 1) ? [1, -1] : [-1, 1])) {
        const ok = (nx, ny, L, h) => {
          const x0 = dir > 0 ? X + nx - 1 : X + PL - nx - L - 1, x1 = dir > 0 ? X + nx + L + 1 : X + PL - nx + 1;
          return occ.free(x0, Y + ny - 6, x1, Y + ny + h + 2);
        };
        const res = chain({ seed: seed + (dir > 0 ? 0 : 99), segs, p: BP, withFinish: false, startW: PL, ok });
        if (!best || res.path.length > best.res.path.length) best = { res, dir };
      }
      if (!best || best.res.path.length < 3) return null;
      const base = gidN; gidN += best.res.ng;
      return placeChain(best.res, X, Y, PL, best.dir, base);
    }

    // finds space next to a platform for a destination of width W; fn gets a mirror-aware helper
    function place(e, W, up, down, fn) {
      const A = ABS;
      for (const dir of (A ? [A.side] : BR() < 0.5 ? [1, -1] : [-1, 1])) {
        const nx = A ? (dir > 0 ? A.edge : A.edge - W) : dir > 0 ? e[0] + e[2] + 3 : e[0] - 3 - W, ny = A ? A.ny : e[1];
        if (!(A ? occB : occ).free(nx - 1, ny - up, nx + W + 1, ny + down)) continue;
        occ.add(nx - 1, ny - up, nx + W + 1, ny + down); occB.add(nx - 1, ny - up, nx + W + 1, ny + down);
        fn({ nx, ny, W, dir, th: e[3], gid: e[5], X: (o, w) => (dir > 0 ? nx + o : nx + W - o - (w || 1)) });
        return true;
      }
      return false;
    }
    const FLAT = (c, W, hh) => { addRect([c.nx, c.ny, W, hh, 1, c.th, c.gid]); addRect([c.nx + 2, c.ny + hh, W - 4, 1, 1, c.th, c.gid]); if (W > 14) addRect([c.nx + 5, c.ny + hh + 1, W - 10, 1, 1, c.th, c.gid]); };
    function roomLake(e) { return place(e, 20, 7, 9, c => { FLAT(c, 20, 4); addRect([c.nx + 6, c.ny, 8, 3, 5, c.th, c.gid]); coinRow(c.nx + 7, c.ny + 1.5, 6, 1, 0); coin(c.nx + 10, c.ny - 2, 1); }); }
    function roomLavaLake(e) { return place(e, 20, 7, 9, c => { FLAT(c, 20, 4); addRect([c.nx + 5, c.ny, 9, 3, 2, c.th, c.gid]); addRect([c.nx + 8, c.ny, 3, 3, 1, c.th, c.gid]); coin(c.nx + 9.5, c.ny - 1, 1); coinRow(c.nx + 6, c.ny - 3.2, 7, 1, 0); }); }
    function roomPyramid(e) { return place(e, 18, 8, 7, c => { FLAT(c, 18, 3); addRect([c.nx + 3, c.ny - 1, 12, 1, 1, c.th, c.gid]); addRect([c.nx + 5, c.ny - 2, 8, 1, 1, c.th, c.gid]); addRect([c.nx + 7, c.ny - 3, 4, 1, 1, c.th, c.gid]); coin(c.nx + 9, c.ny - 4, 1); coinRow(c.nx + 4, c.ny - 1.9, 3, 1, 0); }); }
    function roomArch(e) { return place(e, 16, 9, 7, c => { FLAT(c, 16, 3); addRect([c.nx + 3, c.ny - 4, 1, 4, 1, c.th, c.gid]); addRect([c.nx + 12, c.ny - 4, 1, 4, 1, c.th, c.gid]); addRect([c.nx + 2, c.ny - 5, 12, 1, 1, c.th, c.gid]); coinRow(c.nx + 5, c.ny - 1, 6, 1, 0); coin(c.nx + 8, c.ny - 6.2, 1); jenga(c.nx + 7, c.ny, 5); }); }
    function roomPlay(e) {   // a playground: seesaws, a trampoline, a big ice slide, toys
      const W = 46;
      return place(e, W, 14, 8, c => {
        const { ny, th, gid, X } = c; FLAT(c, W, 4);
        addRect([X(2, 3), ny, 3, 1, 6, th, gid]); coin(X(2, 3) + 1.5, ny - 3.3, 0); coin(X(2, 3) + 1.5, ny - 5, 0);
        const sA = X(7, 7), sB = X(17, 7);
        gad.see.push([sA + 3.5, ny - 1.6, 3.2, BR() < 0.5 ? 0.12 : -0.12]); gad.see.push([sB + 3.5, ny - 1.6, 3.2, BR() < 0.5 ? 0.12 : -0.12]);
        coinRow(sA + 0.5, ny - 3.4, 7, 1, 0); coinRow(sB + 0.5, ny - 3.4, 7, 1, 0);
        props.push([3, X(26, 1), ny]); props.push([0, X(25, 1), ny]); props.push([0, X(27, 1), ny]);
        for (let i = 0; i < 4; i++) addRect([X(29 + 2 * i, 2), ny - (i + 1), 2, i + 1, 1, th, gid]);
        addRect([X(37, 3), ny - 5, 3, 5, 1, th, gid]); coin(X(37, 3) + 1.5, ny - 6.1, 1); coin(X(37, 3) + 0.5, ny - 6.1, 0); coin(X(37, 3) + 2.5, ny - 6.1, 0);
        for (let j = 0; j < 3; j++) { const top = ny - (3 - j); addRect([X(40 + 2 * j, 2), top, 2, 1, 3, th, gid]); if (3 - j > 1) addRect([X(40 + 2 * j, 2), top + 1, 2, 3 - j - 1, 1, th, gid]); }
      });
    }
    function roomPit(e) {   // a ball pit
      const W = 26;
      return place(e, W, 9, 8, c => {
        const { ny, th, gid, X } = c; FLAT(c, W, 4);
        addRect([X(0, 1), ny - 2, 1, 2, 1, th, gid]); addRect([X(W - 1, 1), ny - 4, 1, 4, 1, th, gid]);
        const x0 = Math.min(X(1, 1), X(W - 2, 1)), n = 28;
        for (let i = 0; i < n; i++) props.push([4, x0 + 0.3 + i * 0.82, ny]);
        for (let i = 0; i < n - 1; i++) props.push([4, x0 + 0.7 + i * 0.82, ny - 0.74]);
        coinRow(x0 + 4, ny - 3, 17, 1, 0); coin(x0 + 12, ny - 4.6, 1);
      });
    }
    function roomTramp(e) {   // trampolines up to coin ledges
      const W = 34;
      return place(e, W, 22, 6, c => {
        const { ny, th, gid, X } = c; FLAT(c, W, 3);
        addRect([X(3, 3), ny, 3, 1, 6, th, gid]); addRect([X(26, 3), ny, 3, 1, 6, th, gid]);
        addRect([X(8, 7), ny - 7, 7, 2, 1, th, gid]); addRect([X(11, 3), ny - 7, 3, 1, 6, th, gid]);
        addRect([X(18, 8), ny - 15, 8, 2, 1, th, gid]); addRect([X(21, 3), ny - 15, 3, 1, 6, th, gid]);
        coinRow(X(9, 5) + 0.5, ny - 8, 5, 1, 0); coin(X(20, 4) + 1, ny - 16.2, 1); coinRow(X(19, 6) + 0.5, ny - 16, 6, 1, 0);
        coin(X(5, 1), ny - 5, 0); coin(X(9, 1), ny - 10, 0); coin(X(15, 1), ny - 12, 0); coin(X(25, 1), ny - 9, 0);
        addRect([X(14, 6), ny - 22, 6, 1, 1, th, gid]); coin(X(14, 6) + 3, ny - 23.2, 2); coin(X(14, 6) + 2, ny - 23.2, 1); coin(X(14, 6) + 4, ny - 23.2, 1);
      });
    }
    function roomGauntlet(e) {   // hard: lava below, lava ceilings above, tiny platforms. gems at the end
      const n = bri(8, 12), W = n * 5 + 14;
      return place(e, W, 12, 8, c => {
        const { ny, th, gid, X } = c;
        addRect([X(0, 4), ny, 4, 2, 1, th, gid]);
        addRect([c.nx, ny + 3, W, 4, 2, th, gid]);
        let h = 0;
        for (let i = 0; i < n; i++) {
          const o = 6 + i * 5; h = clamp2(h + bri(-1, 1), -3, 2);
          addRect([X(o, 2), ny + h, 2, 2, 1, th, gid]);
          if (BR() < 0.65) addRect([X(o - 1, 4), ny + h - 6, 4, 1, 2, th, gid]);     // a lava ceiling
          else if (BR() < 0.4) addRect([X(o, 1), ny + h - 1, 1, 1, 2, th, gid]);       // a lava block on the platform
          coin(X(o, 2) + 1, ny + h - 1.1, 0); if (i % 3 === 2) coin(X(o, 2) + 1, ny + h - 2.4, 1);
        }
        const eo = 6 + n * 5;
        addRect([X(eo, 6), ny + h, 6, 2, 1, th, gid]);
        coin(X(eo, 6) + 1, ny + h - 1.1, 2); coin(X(eo, 6) + 2.5, ny + h - 1.1, 2); coin(X(eo, 6) + 4, ny + h - 1.1, 2); coin(X(eo, 6) + 2.5, ny + h - 2.5, 1);
      });
    }
    const clamp2 = (v, a, b) => (v < a ? a : v > b ? b : v);
    function roomVault(e, pw) {   // a locked treasure room: open it with a button on the way in, or with a crate on a plate
      const W = 20;
      return place(e, W, 11, 6, c => {
        const { ny, th, gid, X } = c, id = gad.doors.length;
        addRect([c.nx, ny, W, 3, 1, th, gid]); addRect([c.nx + 2, ny + 3, W - 4, 1, 1, th, gid]);
        addRect([X(7, W - 7), ny - 9, W - 7, 2, 1, th, gid]); addRect([X(W - 1, 1), ny - 9, 1, 9, 1, th, gid]);
        gad.doors.push([X(7, 1), ny - 7, 1, 7]);
        coinRow(X(9, 8) + 0.5, ny - 1, 8, 1, 1); coin(X(12, 4) + 1, ny - 3, 2); coin(X(14, 4) + 1, ny - 3, 2); coin(X(16, 4) + 1, ny - 3, 2);
        decor.push([0, X(W - 3, 1), ny]);
        let q = null;
        for (let k = pw.length - 2; k >= Math.max(0, pw.length - 5); k--) if (pw[k][2] >= 3 && pw[k][4] === 0) { q = pw[k]; break; }
        if (q && BR() < 0.5) { gad.btns.push([q[0] + 1, q[1], [id]]); decor.push([1, q[0] + 1, q[1]]); coinRow(q[0] + 1, q[1] - 1.5, 2, 1, 0); }
        else { gad.plates.push([Math.min(X(3, 1), X(4, 1)), ny, 2, [id]]); props.push([0, X(0, 1), ny]); props.push([0, X(1, 1), ny]); }
      });
    }
    function roomIsle(e) {   // a huge island: platforms above and below, a guaranteed floor in the middle, lots to push around
      const W = 64;
      return place(e, W, 20, 18, c => {
        const { ny, th, gid, X } = c, x0 = c.nx;
        addRect([x0, ny, W, 5, 1, th, gid]); addRect([x0 + 3, ny + 5, W - 6, 2, 1, th, gid]); addRect([x0 + 9, ny + 7, W - 18, 2, 1, th, gid]); addRect([x0 + 18, ny + 9, W - 36, 1, 1, th, gid]);
        for (let i = 0; i < 5; i++) { const px = x0 + 4 + i * 12 + bri(0, 3), ph = bri(5, 8); addRect([px, ny - ph, bri(4, 7), 1, 1, th, gid]); coinRow(px + 0.5, ny - ph - 1, 3, 1, 0); }
        for (let i = 0; i < 4; i++) { const px = x0 + 8 + i * 14 + bri(0, 3); addRect([px, ny + 12, bri(5, 8), 2, 1, th, gid]); coinRow(px + 1, ny + 11, 3, 1, 0); }
        jenga(x0 + 14, ny, 6); jenga(x0 + 44, ny, 7); cratePyramid(x0 + 28, ny, 4); crateColumn(x0 + 36, ny, 5);
        for (let i = 0; i < 5; i++) { const k = BR(); props.push([k < 0.4 ? 2 : k < 0.7 ? 3 : 0, x0 + 6 + i * 11 + bri(0, 4), ny]); }
        addRect([x0 + 20, ny, 3, 1, 6, th, gid]); addRect([x0 + 50, ny, 3, 1, 6, th, gid]);
        addRect([x0 + 22, ny - 14, 8, 2, 1, th, gid]); coin(x0 + 26, ny - 15.2, 1); coin(x0 + 24, ny - 15.2, 2); coin(x0 + 28, ny - 15.2, 2);
        coinRow(x0 + 3, ny - 1, 28, 2, 0);
      });
    }
    function room(e, pw) {
      const k = BR() * 100;
      let ok;
      if (k < 7) { grow(e, [S('up', bri(6, 12), THEMES[e[3]].id)], bri(1, 99999)); return; }
      else if (k < 15) ok = roomLake(e); else if (k < 22) ok = roomLavaLake(e); else if (k < 28) ok = roomPyramid(e); else if (k < 34) ok = roomArch(e);
      else if (k < 46) ok = roomPlay(e); else if (k < 57) ok = roomPit(e); else if (k < 69) ok = roomVault(e, pw); else if (k < 80) ok = roomGauntlet(e);
      else if (k < 91) ok = roomTramp(e); else ok = roomIsle(e);
      if (!ok) roomLake(e) || roomArch(e);
    }

    // floating districts: a bounce pad on the route throws you up to an island full of things to do
    function skyDistricts(pw) {
      let i = bri(2, 5);
      while (i < pw.length - 3) {
        const e = pw[i];
        if (e[9] && e[4] === 0 && !e[6] && e[2] >= 8) {
          let side = BR() < 0.5 ? 1 : -1, px = side > 0 ? e[0] + e[2] - 4 : e[0] + 1;
          const kinds = [roomIsle, roomPlay, roomPit, roomVault, roomGauntlet, roomTramp, roomLake, roomArch, roomPyramid, roomPlay, roomPit, roomIsle, roomPlay, roomPlay, roomTramp];
          for (let t = 0; t < 10; t++) {
            if (t > 0 && t % 2 === 0) { side = -side; px = side > 0 ? e[0] + e[2] - 4 : e[0] + 1; }
            const up = 6 + (t >> 2);
            const fn = kinds[Math.floor(BR() * kinds.length)];
            ABS = { side, edge: side > 0 ? px + 5 : px - 2, ny: e[1] - up };
            const ok = fn(e, []);
            ABS = null;
            if (ok) {
              addRect([px, e[1], 3, 1, 6, e[3], e[5]]); e[9] = 0;
              coin(px + 1.5, e[1] - 3, 0); coin(px + 1.5, e[1] - 5, 0);
              break;
            }
          }
        }
        i += bri(2, 4);
      }
    }
    function branches(pw, depth) {
      let i = bri(3, 6);
      while (i < pw.length - 3 && branchCount < MAXB) {
        makeBranch(pw[i], depth);
        i += bri(d.br[0], d.br[1]) * (depth ? 1.6 : 1) | 0;
      }
    }
    function makeBranch(e, depth) {
      const cand = UNDER[THEMES[e[3]].id] || ['cave'];
      const th = cand[Math.floor(BR() * cand.length)], cave = THEMES[TH[th]].cave ? 1 : 0;
      const ice = (th === 'snow' || th === 'icecave') ? 0.35 : 0.08;
      let pw = null;
      for (let attempt = 0; attempt < 4 && !pw; attempt++) {
        const f = [1, 0.7, 0.45, 0.3][attempt], sc = (a, b) => bri(Math.max(3, Math.round(a * f)), Math.max(4, Math.round(b * f)));
        let segs;
        if (e[4] === 0) {   // route runs sideways -> shafts down or towers up
          segs = BR() < 0.6 ? [S('down', sc(8, 26), th, { ice }), S('right', sc(6, 18), th, { cave, ice })]
            : [S('up', sc(8, 22), th, { ice }), S('right', sc(6, 16), th, { ice })];
        } else {            // route runs up/down -> tunnels out sideways
          segs = [S('right', sc(10, 34), th, { cave, ice })];
          if (BR() < 0.45) segs.push(S('down', sc(4, 12), th, { ice }), S('right', sc(6, 14), th, { cave, ice }));
        }
        pw = grow(e, segs, bri(1, 99999));
      }
      if (!pw) return;
      branchCount++;
      addStructures(pw);
      addProps(pw, 0.6);
      addCeilings(pw);
      addCoins(pw, 0.7);
      if (BR() < 0.22) padShelf(pw[bri(0, pw.length - 1)]);
      room(pw[pw.length - 1], pw);
      if (depth < 3 && BR() < 0.6) branches(pw, depth + 1);
    }

    /* --- the start platform, the real route, the decoy route --- */
    const startGid = gidN++;
    addRect([0, 0, 9, 2, 1, TH[d.segs[0].th], startGid]);
    occ.add(-1, -6, 10, 4);

    const mainDir = d.mirror ? -1 : 1;
    const real = chain({ seed: d.seed, segs: d.segs, p: d, withFinish: true });
    let gb = gidN; gidN += real.ng;
    const mainG0 = gb, mainG1 = gidN;
    const mainPath = placeChain(real, 0, 0, 9, mainDir, gb);
    const dec = chain({ seed: d.seed + 777, segs: d.decoy, p: d, withFinish: false });
    gb = gidN; gidN += dec.ng;
    const decPath = placeChain(dec, 0, 0, 9, -mainDir, gb);
    const fin = mainDir > 0 ? [real.fin[0], real.fin[1], real.fin[2]] : [9 - real.fin[0] - real.fin[2], real.fin[1], real.fin[2]];

    addStructures(decPath);   // (the real route stays plain so it is always fair)
    // crate gates on the real route: a tall door that only opens while something heavy sits on the plate. Three crates are provided; waste them and you are stuck.
    let gn = 0;
    for (let i = 0; i < mainPath.length - 1; i++) {
      const e = mainPath[i];
      if (!e[10] || e[4] !== 0 || e[6] || e[2] < 11 || (++gn % 2) === 0) continue;
      const L = e[2], X = o => (mainDir > 0 ? e[0] + o : e[0] + L - 1 - o), id = gad.doors.length;
      gad.doors.push([X(9), e[1] - 7, 1, 7]);
      gad.plates.push([Math.min(X(5), X(6)), e[1], 2, [id]]);
      props.push([0, X(1), e[1]]); props.push([0, X(2), e[1]]); props.push([0, X(3), e[1]]);
      decor.push([2, X(9), e[1]]); e[9] = 0;
      coinRow(Math.min(X(5), X(6)) + 0.5, e[1] - 1.2, 2, 1, 0);
    }
    skyDistricts(mainPath); skyDistricts(decPath);
    addProps(mainPath, 0.5); addProps(decPath, 0.7);
    addCoins(mainPath, 0.62); addCoins(decPath, 0.55);
    for (let i = 0; i < 9; i++) coin(fin[0] + 2 + i * (fin[2] - 4) / 8, fin[1] - 1.5 - Math.sin(i / 8 * Math.PI) * 1.5, i === 4 ? 2 : 1);
    addCeilings(mainPath); addCeilings(decPath);
    addLavaSea(mainPath); addLavaSea(decPath);
    branches(mainPath, 0);
    branches(decPath, 0);

    const path = [[0, 0, 9]].concat(mainPath.map(e => [e[0], e[1], e[2]]));

    let minX = 1e9, minY = 1e9, maxX = -1e9, maxY = -1e9;
    for (const r of rects) {
      minX = Math.min(minX, r[0]); minY = Math.min(minY, r[1]);
      maxX = Math.max(maxX, r[0] + r[2]); maxY = Math.max(maxY, r[1] + r[3]);
    }
    const ox = 3 - minX, oy = 14 - minY;
    for (const r of rects) { r[0] += ox; r[1] += oy; }
    for (const q of path) { q[0] += ox; q[1] += oy; }
    fin[0] += ox; fin[1] += oy;
    for (const q of props) { q[1] += ox; q[2] += oy; }
    for (const q of coins) { q[0] += ox; q[1] += oy; }
    for (const q of decor) { q[1] += ox; q[2] += oy; }
    for (const q of gad.doors) { q[0] += ox; q[1] += oy; }
    for (const q of gad.plates) { q[0] += ox; q[1] += oy; }
    for (const q of gad.btns) { q[0] += ox; q[1] += oy; }
    for (const q of gad.see) { q[0] += ox; q[1] += oy; }

    // background regions (drawn in order, so later ones sit on top)
    // side branches and the decoy are painted first; the real route and the start area on top, so the spawn always looks like its own region
    const isMain = k => k === startGid || (k >= mainG0 && k < mainG1);
    const zones = Object.keys(gz).map(Number).sort((a, b) => (isMain(a) - isMain(b)) || (a - b)).map(k => {
      const z = gz[k]; return [z[0] + ox - 7, z[1] + oy - 7, z[2] + ox + 7, z[3] + oy + 7, z[4]];
    });

    const W = maxX + ox + 3;
    const maxBottom = maxY + oy;
    const H = maxBottom + 18;
    // keep coins out of solid ground, and out of the doors' way
    const gridT = new Uint8Array(W * H);
    for (const r of rects) for (let yy = r[1]; yy < r[1] + r[3]; yy++) { if (yy < 0 || yy >= H) continue; for (let xx = r[0]; xx < r[0] + r[2]; xx++) if (xx >= 0 && xx < W) gridT[yy * W + xx] = r[4]; }
    const coinsOut = [], seen = new Set();
    for (const q of coins) {
      const tx = Math.floor(q[0]), ty = Math.floor(q[1]); if (tx < 0 || tx >= W || ty < 0 || ty >= H) continue;
      const t = gridT[ty * W + tx]; if (t === 1 || t === 3 || t === 4 || t === 6) continue;
      const key = Math.round(q[0] * 2) * 100003 + Math.round(q[1] * 2); if (seen.has(key)) continue; seen.add(key);
      coinsOut.push([Math.round((q[0]) * TS), Math.round(q[1] * TS), q[2]]);
    }
    coinsOut.sort((a, b) => a[0] - b[0]);
    // the kill line follows the land: 14 tiles under the lowest ground within ~45 tiles either side, so you never fall for long
    const colB = new Int16Array(W), floorY = new Int16Array(W);
    for (const r of rects) for (let xx = Math.max(0, r[0]); xx < Math.min(W, r[0] + r[2]); xx++) colB[xx] = Math.max(colB[xx], r[1] + r[3]);
    for (let x = 0; x < W; x++) { let m = 0; for (let k = Math.max(0, x - 45); k <= Math.min(W - 1, x + 45); k += 3) if (colB[k] > m) m = colB[k]; floorY[x] = m + 14; }

    const map = {
      idx, name: d.name, bg: '#0c0c16',
      TS, W, H, rects, path, zones, props, coins: coinsOut, gadgets: gad, decor, floorY,
      start: [(ox + 4.5) * TS, oy * TS - R - 1],   // the one community spawn point
      finish: fin,
      flag: [fin[0] + fin[2] / 2, fin[1]],
      killY: (maxBottom + 14) * TS
    };
    cache[idx] = map;
    return map;
  }

  const api = { TS, R, count: DEFS.length, names: DEFS.map(d => d.name), themes: THEMES, generate };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.BallMaps = api;
})(typeof window !== 'undefined' ? window : globalThis);

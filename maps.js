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

  // Tile types: 0 air, 1 solid, 2 lava, 3 ice, 4 finish (solid, checkered), 5 water
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
    { name: 'Emberfall Expanse', seed: 505, mirror: true, br: [3, 6],
      segs: [S('right', 34, 'meadow', { ice: 0.05, lava: 0.12 }), S('right', 30, 'desert', { ice: 0, lava: 0.22 }), S('down', 22, 'desert'),
        S('right', 44, 'cave', { cave: 1, water: 0.2 }), S('right', 34, 'crystal', { cave: 1, ice: 0.2 }), S('down', 24, 'crystal'),
        S('right', 44, 'volcano', { cave: 1, lavasea: 1, lava: 0.3, ice: 0, water: 0 }), S('up', 28, 'volcano'), S('right', 36, 'night', { ice: 0.2 })],
      decoy: [S('right', 36, 'forest'), S('right', 36, 'mushroom', { cave: 1 }), S('right', 36, 'snow', { ice: 0.35 }), S('right', 36, 'icecave', { cave: 1, ice: 0.4 })],
      ice: 0.14, lava: 0.18, pillar: 0.12, narrow: 0.08, water: 0.12 },
    { name: 'Frostbite Descent', seed: 202, mirror: false, br: [3, 6],
      segs: [S('down', 30, 'snow', { ice: 0.35 }), S('right', 22, 'snow', { ice: 0.35 }), S('down', 38, 'icecave', { ice: 0.45 }),
        S('right', 34, 'icecave', { cave: 1, ice: 0.45 }), S('down', 38, 'crystal'), S('right', 28, 'crystal', { cave: 1 }),
        S('down', 44, 'volcano', { lava: 0.25, ice: 0 }), S('right', 28, 'volcano', { cave: 1, lavasea: 1, lava: 0.28, ice: 0 })],
      decoy: [S('up', 40, 'forest'), S('right', 12, 'forest'), S('up', 40, 'sky'), S('right', 12, 'sky')],
      ice: 0.2, lava: 0.15, pillar: 0.08, narrow: 0.08, water: 0 },
    { name: 'Skyline Climb', seed: 303, mirror: false, br: [3, 6],
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

      const rest = (!last && i % 18 === 0);                                   // safe breather platform
      const narrow = (!last && !rest && Rn() < sp('narrow'));
      const water = (!last && !rest && !narrow && mode === 'right' && Rn() < sp('water'));
      const L = last ? 14 : rest ? 8 : water ? ri(8, 10) : narrow ? ri(2, 3) : (mode === 'up' ? ri(3, 6) : ri(4, 8));

      let dy, gap;
      if (mode === 'right') {
        let oo = [-2, -1, -1, 0, 0, 0, 1, 1, 2, 3];
        const off = py - baseY;
        if (off > 10) oo = [-2, -1, -1, 0]; else if (off < -10) oo = [0, 1, 2, 3];
        if (lock > 0) { oo = oo.filter(v => v * lockSign >= 0); if (!oo.length) oo = [0]; lock--; }
        dy = pick(oo);
        gap = dy === -2 ? 2 : dy < 0 ? ri(2, 3) : dy >= 2 ? ri(2, 4) : ri(2, 3);
      } else if (mode === 'down') {
        dy = ri(3, 4);   // big drops keep 3+ tiles of head-room between zig-zag layers
        gap = ri(2, 4);
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
        if (L >= 7 && Rn() < sp('lava')) {
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
        (!hz && !last && !water && !narrow && t === 1 && L >= 8) ? 1 : 0]);
      px = nx; py = ny; pl = L;
    }
    return { rects, fin, path, ng };
  }

  const cache = {};

  function generate(idx) {
    idx = ((idx % DEFS.length) + DEFS.length) % DEFS.length;
    if (cache[idx]) return cache[idx];
    const d = DEFS[idx];
    const occ = Occ();
    const rects = [], gz = {};
    let gidN = 0, branchCount = 0;
    const MAXB = 260;
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
        const w = [x, Y + e[1], e[2], e[3], e[4], e[5] + gbase, e[6], e[7], e[8], e[9]];
        out.push(w); const b = boxOf(w); occ.add(b[0], b[1], b[2], b[3]);
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
        if (!e[9] || e[4] !== 0 || BR() > 0.3) continue;
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
        } else if (L >= 12 && !e[6]) {   // an arch to walk through
          const x = e[0] + bri(2, L - 9);
          addRect([x, y - 4, 1, 4, 1, th, g]); addRect([x + 5, y - 4, 1, 4, 1, th, g]); addRect([x - 1, y - 5, 8, 1, 1, th, g]);
        }
      }
    }
    // pushable yellow crates and balls (each player gets their own copy; they are optional toys and shortcuts)
    const props = [];
    function addProps(pw, prob) {
      for (let i = 0; i < pw.length; i++) {
        const e = pw[i];
        if (!e[9] || BR() > prob) continue;
        const k = BR(), kind = k < 0.4 ? 0 : k < 0.62 ? 1 : k < 0.84 ? 2 : 3;
        const n = (kind === 0 && BR() < 0.4) ? 2 : 1;                    // sometimes two crates side by side
        const x = e[0] + bri(2, e[2] - 3);
        props.push([kind, x, e[1]]);
        if (n === 2 && x + 1 < e[0] + e[2] - 1) props.push([0, x + 1, e[1]]);
        else if (kind === 0 && BR() < 0.3) props.push([0, x, e[1] - 1]);  // stacked
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

    function room(e) {   // a destination at the end of a branch
      const th = e[3], gid = e[5], k = BR();
      if (k < 0.3) {   // climbable tiers
        const tn = THEMES[th].id;
        grow(e, [S('up', bri(5, 9), tn)], bri(1, 99999));
        return;
      }
      const W = k < 0.5 ? 20 : k < 0.68 ? 20 : k < 0.84 ? 18 : 16, hh = k < 0.5 ? 4 : 3;
      for (const dir of (BR() < 0.5 ? [1, -1] : [-1, 1])) {
        const nx = dir > 0 ? e[0] + e[2] + 3 : e[0] - 3 - W, ny = e[1];
        if (!occ.free(nx - 1, ny - 7, nx + W + 1, ny + hh + 3)) continue;
        occ.add(nx - 1, ny - 7, nx + W + 1, ny + hh + 3);
        addRect([nx, ny, W, hh, 1, th, gid]);
        addRect([nx + 2, ny + hh, W - 4, 1, 1, th, gid]);
        if (k < 0.5) addRect([nx + 6, ny, 8, 3, 5, th, gid]);                                                // lake
        else if (k < 0.68) { addRect([nx + 5, ny, 9, 3, 2, th, gid]); addRect([nx + 8, ny, 3, 3, 1, th, gid]); } // lava lake with an island
        else if (k < 0.84) { addRect([nx + 3, ny - 1, 12, 1, 1, th, gid]); addRect([nx + 5, ny - 2, 8, 1, 1, th, gid]); addRect([nx + 7, ny - 3, 4, 1, 1, th, gid]); } // pyramid
        else { addRect([nx + 3, ny - 4, 1, 4, 1, th, gid]); addRect([nx + 12, ny - 4, 1, 4, 1, th, gid]); addRect([nx + 2, ny - 5, 12, 1, 1, th, gid]); }  // arch hall
        return;
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
      let segs;
      if (e[4] === 0) {   // route runs sideways -> shafts down or towers up
        segs = BR() < 0.6 ? [S('down', bri(6, 18), th, { ice }), S('right', bri(4, 12), th, { cave, ice })]
          : [S('up', bri(6, 16), th, { ice }), S('right', bri(4, 10), th, { ice })];
      } else {            // route runs up/down -> tunnels out sideways
        segs = [S('right', bri(8, 24), th, { cave, ice })];
        if (BR() < 0.4) segs.push(S('down', bri(3, 8), th, { ice }), S('right', bri(4, 10), th, { cave, ice }));
      }
      const pw = grow(e, segs, bri(1, 99999));
      if (!pw) return;
      branchCount++;
      addStructures(pw);
      addProps(pw, 0.6);
      addCeilings(pw);
      room(pw[pw.length - 1]);
      if (depth < 2 && BR() < 0.55) branches(pw, depth + 1);
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
    addProps(mainPath, 0.3); addProps(decPath, 0.6);
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

    // background regions (drawn in order, so later ones sit on top)
    // side branches and the decoy are painted first; the real route and the start area on top, so the spawn always looks like its own region
    const isMain = k => k === startGid || (k >= mainG0 && k < mainG1);
    const zones = Object.keys(gz).map(Number).sort((a, b) => (isMain(a) - isMain(b)) || (a - b)).map(k => {
      const z = gz[k]; return [z[0] + ox - 7, z[1] + oy - 7, z[2] + ox + 7, z[3] + oy + 7, z[4]];
    });

    const W = maxX + ox + 3;
    const maxBottom = maxY + oy;
    const H = maxBottom + 12;

    const map = {
      idx, name: d.name, bg: '#0c0c16',
      TS, W, H, rects, path, zones, props,
      start: [(ox + 4.5) * TS, oy * TS - R - 1],   // the one community spawn point
      finish: fin,
      flag: [fin[0] + fin[2] / 2, fin[1]],
      killY: (maxBottom + 7) * TS
    };
    cache[idx] = map;
    return map;
  }

  const api = { TS, R, count: DEFS.length, names: DEFS.map(d => d.name), themes: THEMES, generate };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.BallMaps = api;
})(typeof window !== 'undefined' ? window : globalThis);

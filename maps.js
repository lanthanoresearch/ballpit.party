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
    { id: 'night',    bg: '#130e2e', solid: '#3b3663', top: '#5c559e', deco: 'star' },
    { id: 'dunes',    bg: '#f7d9a0', solid: '#d8a35e', top: '#f4d58c', deco: 'palm' },
    { id: 'jungle',   bg: '#1d6a3c', solid: '#4b3a20', top: '#27b04a', deco: 'jungle' },
    { id: 'wasteland', bg: '#55453d', solid: '#6e5c50', top: '#93806f', deco: 'dead' },
    { id: 'swamp',    bg: '#2c4230', solid: '#413d22', top: '#76933c', deco: 'reed' },
    { id: 'autumn',   bg: '#efb277', solid: '#6d4527', top: '#dd7a2c', deco: 'maple' },
    { id: 'ruins',    bg: '#35404f', solid: '#80838c', top: '#adb0b8', deco: 'column' },
    { id: 'ashland',  bg: '#241616', solid: '#2f2624', top: '#52403c', deco: 'ember' }
  ];
  const TH = {}; THEMES.forEach((t, i) => { TH[t.id] = i; });

  // what lies beneath / beside each kind of place (for side branches)
  const UNDER = {
    meadow: ['cave', 'mushroom', 'forest'], forest: ['cave', 'mushroom', 'crystal'], desert: ['cave', 'desert', 'volcano'],
    cave: ['crystal', 'cave', 'mushroom', 'icecave'], crystal: ['crystal', 'cave', 'icecave'], mushroom: ['mushroom', 'cave', 'crystal'],
    snow: ['icecave', 'snow', 'cave'], icecave: ['icecave', 'crystal', 'snow'], volcano: ['volcano', 'cave', 'crystal'],
    sky: ['sky', 'night'], night: ['night', 'sky', 'crystal'],
    dunes: ['cave', 'desert', 'ruins'], jungle: ['mushroom', 'cave', 'swamp'], wasteland: ['cave', 'volcano', 'ashland'],
    swamp: ['mushroom', 'cave', 'jungle'], autumn: ['cave', 'forest', 'mushroom'], ruins: ['cave', 'crystal', 'ruins'], ashland: ['volcano', 'ashland', 'cave']
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

  const BIG = 1.6;   // every map is this much bigger than its base outline
const S = (m, n, th, o) => Object.assign({ m, n: Math.max(3, Math.round(n * BIG)), th }, o || {});
  const SEG = (m, n, th, o) => Object.assign({ m, n, th }, o || {});

  /* Two big levels. Each one is a rectangle: a walkable ground at the bottom (with lava, water and ice only in patches),
     and above it "lanes" of platforms that snake across the whole width, one above the other. From the start platform in the
     middle one snake climbs up (to the hidden finish in a far top corner) and another snake steps down towards the ground,
     so the level fills the whole area instead of running along one diagonal. */
  const WIDE = { plain: 4, hill: 3, pond: 2, lava: 2, room: 3 };
  const DEFS = [
    { name: 'Emberfall Expanse', seed: 505, mirror: true, xl: -840, xr: 840, ls: 23, up: 8, dn: 4, gOff: 0, cu: 9, cd: 8, ladder: 70, br: [2, 4],   // a long journey east to west: snow, swamp, woods, meadow, dunes, ruins, ashlands
      lo: { wd: [5, 10], un: ['round', 'ragged', 'legs', 'flat', 'stem'], drift: 4, see: 0.055 }, hz: { lava: 2.2, water: 1.4, pillar: 1.5 },
      rw: { oasis: 3, dunes: 3, columns: 4, vines: 3, crater: 5, bridge: 4, rink: 3 },
      ice: 0.14, lava: 0.18, pillar: 0.12, narrow: 0.08, water: 0.12,
      bands: [
        { x1: -600, g: { th: 'snow', amp: 4, w: { plain: 3, hill: 3, ice: 5, pond: 2, lava: 1, room: 3 }, rooms: ['rink', 'lake', 'play', 'vault', 'arch', 'pit'] },
          lane: r => r >= 4 ? 'night' : r === 3 ? 'sky' : r <= -2 ? 'icecave' : 'snow' },
        { x1: -360, g: { th: 'swamp', amp: 5, w: { plain: 3, hill: 2, pond: 5, lava: 1, room: 3 }, rooms: ['vines', 'lake', 'pit', 'tramp', 'play'] },
          lane: r => r >= 4 ? 'night' : r === 3 ? 'sky' : r <= -2 ? 'mushroom' : (r & 1) ? 'swamp' : 'jungle' },
        { x1: -130, g: { th: 'autumn', amp: 6, w: { plain: 4, hill: 4, pond: 1, lava: 1, room: 3 }, rooms: ['play', 'pit', 'arch', 'tramp', 'pyramid', 'vault'] },
          lane: r => r >= 4 ? 'night' : r === 3 ? 'sky' : r <= -2 ? 'cave' : (r & 1) ? 'autumn' : 'forest' },
        { x1: 130, g: { th: 'meadow', amp: 5, w: { plain: 5, hill: 3, pond: 2, lava: 1, room: 3 }, rooms: ['play', 'pit', 'lake', 'arch', 'tramp', 'pyramid'] },
          lane: r => r >= 4 ? 'night' : r === 3 ? 'sky' : r <= -2 ? 'crystal' : 'meadow' },
        { x1: 380, g: { th: 'dunes', amp: 8, w: { plain: 4, hill: 4, pond: 1, lava: 2, pillars: 1, room: 3 }, rooms: ['oasis', 'dunes', 'pyramid', 'columns', 'crater', 'vault'] },
          lane: r => r >= 4 ? 'night' : r === 3 ? 'sky' : r <= -2 ? 'cave' : (r & 1) ? 'desert' : 'dunes' },
        { x1: 620, g: { th: 'ruins', amp: 4, w: { plain: 3, pillars: 4, hill: 2, lava: 2, chasm: 2, room: 3 }, rooms: ['columns', 'arch', 'vault', 'crater', 'pyramid'] },
          lane: r => r >= 4 ? 'night' : r === 3 ? 'sky' : r <= -2 ? 'crystal' : (r & 1) ? 'wasteland' : 'ruins' },
        { x1: 9999, g: { th: 'ashland', amp: 7, w: { plain: 3, hill: 3, lava: 6, chasm: 3, pillars: 1, room: 2 }, rooms: ['crater', 'lava', 'vault'] },
          lane: r => r >= 4 ? 'night' : r === 3 ? 'sky' : r <= -2 ? 'volcano' : (r & 1) ? 'wasteland' : 'ashland' }
      ] },
    { name: 'Skyline Climb', seed: 303, mirror: false, xl: -520, xr: 520, ls: 23, up: 11, dn: 4, gOff: 0, cu: 10, cd: 8, ladder: 60, br: [2, 4],   // a mountain: jungle at its foot, then forest, snow, crystal and finally the stars
      lo: { wd: [3, 7], un: ['stem', 'round', 'legs'], oo: [-3, -2, -2, -1, 0, 0, 1, 2, 3, 3], drift: 4, see: 0.06 }, hz: { lava: 2.2, water: 1.4, pillar: 1.5 },
      rw: { vines: 10, tramp: 10, isle: 10, columns: 5, bridge: 5, play: 8, pit: 5, vault: 10, gauntlet: 8, arch: 6, oasis: 2 },
      ice: 0.15, lava: 0.1, pillar: 0.08, narrow: 0.1, water: 0.05,
      bands: [
        { x1: -170, g: { th: 'swamp', amp: 5, w: { plain: 3, hill: 2, pond: 5, lava: 1, room: 3 }, rooms: ['vines', 'lake', 'pit', 'tramp', 'play'] },
          lane: r => ALT[r < -3 ? -3 : r > 7 ? 7 : r][0] },
        { x1: 170, g: { th: 'meadow', amp: 5, w: { plain: 5, hill: 4, pond: 2, lava: 1, room: 3 }, rooms: ['play', 'pit', 'lake', 'arch', 'tramp', 'pyramid'] },
          lane: r => ALT[r < -3 ? -3 : r > 7 ? 7 : r][1] },
        { x1: 9999, g: { th: 'dunes', amp: 7, w: { plain: 4, hill: 4, lava: 3, pillars: 2, chasm: 1, room: 3 }, rooms: ['oasis', 'dunes', 'columns', 'crater', 'vault', 'pyramid'] },
          lane: r => ALT[r < -3 ? -3 : r > 7 ? 7 : r][2] }
      ] }
  ];
  var ALT = { '-3': ['cave', 'crystal', 'cave'], '-2': ['mushroom', 'cave', 'crystal'], '-1': ['jungle', 'swamp', 'ruins'], 0: ['forest', 'meadow', 'autumn'], 1: ['autumn', 'forest', 'jungle'],
    2: ['forest', 'autumn', 'snow'], 3: ['snow', 'snow', 'snow'], 4: ['icecave', 'icecave', 'icecave'], 5: ['crystal', 'crystal', 'crystal'], 6: ['sky', 'sky', 'sky'], 7: ['night', 'night', 'night'] };

  /* ---------- 48 more levels, all made from a number ----------
     Each one picks its own size, a journey of themed regions from one side to the other, how mean the lava is,
     how much water and ice there is, and how many teeter-totters and gates it has. */
  const GPROF = {   // what the ground looks like in each kind of place
    snow:      { amp: 4, w: { plain: 3, hill: 3, ice: 5, pond: 2, lava: 2, room: 3 }, rooms: ['rink', 'lake', 'play', 'vault', 'arch', 'pit'], surf: ['snow', 'snow'], under: 'icecave' },
    swamp:     { amp: 5, w: { plain: 3, hill: 2, pond: 5, lava: 2, room: 3 }, rooms: ['vines', 'lake', 'pit', 'tramp', 'play'], surf: ['swamp', 'jungle'], under: 'mushroom' },
    autumn:    { amp: 6, w: { plain: 4, hill: 4, pond: 1, lava: 2, room: 3 }, rooms: ['play', 'pit', 'arch', 'tramp', 'pyramid', 'vault'], surf: ['autumn', 'forest'], under: 'cave' },
    forest:    { amp: 5, w: { plain: 4, hill: 4, pond: 2, lava: 2, room: 3 }, rooms: ['play', 'vines', 'tramp', 'lake', 'vault'], surf: ['forest', 'autumn'], under: 'mushroom' },
    meadow:    { amp: 5, w: { plain: 5, hill: 3, pond: 2, lava: 2, room: 3 }, rooms: ['play', 'pit', 'lake', 'arch', 'tramp', 'pyramid'], surf: ['meadow', 'forest'], under: 'crystal' },
    dunes:     { amp: 8, w: { plain: 4, hill: 4, pond: 1, lava: 3, pillars: 1, room: 3 }, rooms: ['oasis', 'dunes', 'pyramid', 'columns', 'crater', 'vault'], surf: ['desert', 'dunes'], under: 'cave' },
    desert:    { amp: 6, w: { plain: 4, hill: 3, lava: 3, pillars: 2, room: 3 }, rooms: ['oasis', 'pyramid', 'columns', 'crater', 'vault'], surf: ['desert', 'dunes'], under: 'volcano' },
    ruins:     { amp: 4, w: { plain: 3, pillars: 4, hill: 2, lava: 3, chasm: 2, room: 3 }, rooms: ['columns', 'arch', 'vault', 'crater', 'pyramid'], surf: ['ruins', 'wasteland'], under: 'crystal' },
    jungle:    { amp: 5, w: { plain: 3, hill: 3, pond: 3, lava: 2, pillars: 1, room: 3 }, rooms: ['vines', 'tramp', 'play', 'lake', 'pit'], surf: ['jungle', 'swamp'], under: 'mushroom' },
    wasteland: { amp: 6, w: { plain: 3, hill: 3, lava: 5, chasm: 2, pillars: 2, room: 2 }, rooms: ['crater', 'lava', 'vault', 'columns'], surf: ['wasteland', 'ruins'], under: 'volcano' },
    ashland:   { amp: 7, w: { plain: 3, hill: 3, lava: 7, chasm: 3, pillars: 1, room: 2 }, rooms: ['crater', 'lava', 'vault'], surf: ['wasteland', 'ashland'], under: 'volcano' }
  };
  const GKEYS = Object.keys(GPROF);
  const N_ADJ = ['Amber', 'Brisk', 'Cinder', 'Dusky', 'Echo', 'Frosted', 'Gilded', 'Hollow', 'Ivory', 'Jade', 'Kindled', 'Lunar', 'Misty', 'Nimble', 'Opal', 'Pebble', 'Quiet', 'Rusty', 'Sunken', 'Tangled', 'Umber', 'Velvet', 'Wandering', 'Yonder', 'Zephyr', 'Crooked', 'Drifting', 'Emerald', 'Fabled', 'Gentle', 'Hidden', 'Icy', 'Jolly', 'Lofty', 'Mossy', 'Northern', 'Ochre', 'Painted', 'Restless', 'Silver', 'Thorny', 'Upper', 'Verdant', 'Windy', 'Ancient', 'Bouncy', 'Copper', 'Dizzy'];
  const N_NOUN = ['Crossing', 'Highlands', 'Run', 'Reach', 'Passage', 'Frontier', 'Ascent', 'Ridge', 'Trail', 'Basin', 'Terraces', 'Spires', 'Meander', 'Gauntlet', 'Journey', 'Expanse', 'Stairway', 'Valleys', 'Horizon', 'Circuit', 'Labyrinth', 'Overlook', 'Wilds', 'Cascade', 'Traverse', 'Rise', 'Vista', 'Sprawl', 'Heights', 'Roam'];
  function procDef(k) {
    const r = rng(7001 + k * 7919), ri = (a, b) => a + Math.floor(r() * (b - a + 1)), rf = (a, b) => a + r() * (b - a), pk = a => a[Math.floor(r() * a.length)];
    const half = ri(500, 860), up = ri(6, 11), dn = ri(3, 5), nb = ri(3, 6), flip = r() < 0.5;
    const style = pk(['mix', 'alt', 'mix']);
    // the journey: a few kinds of ground in a row, never the same twice in a row
    const seq = []; while (seq.length < nb) { const t = pk(GKEYS); if (t !== seq[seq.length - 1]) seq.push(t); }
    const lava = rf(0.8, 2.6), water = rf(0.5, 2.6), ice = rf(0.5, 2.2);
    const wide = r() < 0.3, swamp = r() < 0.25;   // some levels have huge swaths of lava or of water
    const bands = seq.map((th, i) => {
      const P = GPROF[th], w = Object.assign({}, P.w);
      if (w.lava) w.lava = Math.max(1, Math.round(w.lava * lava)); if (w.pond) w.pond = Math.max(1, Math.round(w.pond * water)); if (w.ice) w.ice = Math.max(1, Math.round(w.ice * ice));
      if (r() < 0.4) w.chasm = (w.chasm || 0) + ri(1, 2);
      const g = { th, amp: P.amp + ri(-1, 2), w, rooms: P.rooms };
      if (wide) g.lw = [8, 22]; if (swamp) g.pw = [14, 30];
      const a = P.surf[0], b = P.surf[1], un = P.under;
      const lane = style === 'alt'
        ? (rr => { const q = rr < -3 ? -3 : rr > 7 ? 7 : rr; return ALT[q][i % 3]; })
        : (rr => rr >= up - 1 && up >= 5 ? 'night' : rr === up - 2 && up >= 5 ? 'sky' : rr <= -2 ? un : (rr & 1) ? a : b);
      return { x1: i === nb - 1 ? 9999 : Math.round(-half + (2 * half * (i + 1)) / nb + ri(-30, 30)), g, lane };
    });
    const unders = ['round', 'ragged', 'legs', 'flat', 'stem', 'stalac'].filter(() => r() < 0.7); if (!unders.length) unders.push('round');
    const rw = {}; ['vines', 'tramp', 'isle', 'columns', 'bridge', 'play', 'pit', 'vault', 'gauntlet', 'arch', 'oasis'].forEach(n => { if (r() < 0.55) rw[n] = ri(3, 12); });
    return { name: N_ADJ[(k * 7 + ri(0, 3)) % N_ADJ.length] + ' ' + N_NOUN[(k * 11 + ri(0, 5)) % N_NOUN.length], seed: 9000 + k * 131, mirror: flip, xl: -half, xr: half, ls: ri(21, 25), up, dn, gOff: 0, cu: 9, cd: 8, ladder: 60, br: [2, 4],
      lo: { wd: pk([[5, 10], [3, 7], [4, 9], [6, 12]]), un: unders, drift: ri(3, 5), see: rf(0.035, 0.08), oo: r() < 0.4 ? [-3, -2, -2, -1, 0, 0, 1, 2, 3, 3] : undefined },
      hz: { lava: rf(1.6, 3), water: rf(0.8, 2), pillar: rf(1, 2.2), narrow: rf(0.8, 1.8) },
      rw, mainStruct: rf(0.15, 0.4), bands };
  }
  for (let k = 2; k < 50; k++) DEFS.push(procDef(k));
  { const used = {}; DEFS.forEach((d, i) => { let n = d.name; while (used[n]) n += ' II'; used[n] = 1; d.name = n; }); }
  // sensible hazards for each kind of place
  const TOPT = { snow: { ice: 0.35 }, icecave: { cave: 1, ice: 0.45 }, cave: { cave: 1 }, crystal: { cave: 1 }, mushroom: { cave: 1 }, volcano: { cave: 1, lavasea: 1, lava: 0.3, ice: 0 },
    swamp: { water: 0.3 }, jungle: { water: 0.2 }, dunes: { lava: 0.12 }, desert: { lava: 0.2 }, ashland: { lavasea: 1, lava: 0.3, ice: 0 }, night: { ice: 0.2 }, sky: { ice: 0.2 },
    ruins: { lava: 0.14 }, wasteland: { lava: 0.2 }, meadow: { ice: 0.04, lava: 0.08 } };

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
        return b;
      },
      freeEx(x0, y0, x1, y1, ex) {   // like free(), but one known box (the start platform's own) is ignored
        let ok = true;
        cells(x0, y0, x1, y1, k => {
          if (!ok) return;
          const l = g.get(k); if (!l) return;
          for (let i = 0; i < l.length; i++) { const b = l[i]; if (b !== ex && b[0] < x1 && b[2] > x0 && b[1] < y1 && b[3] > y0) { ok = false; return; } }
        });
        return ok;
      },
      free2(x0, y0, x1, y1, ea, eb) {   // like free(), ignoring two known boxes
        let ok = true;
        cells(x0, y0, x1, y1, k => {
          if (!ok) return;
          const l = g.get(k); if (!l) return;
          for (let i = 0; i < l.length; i++) { const b = l[i]; if (b !== ea && b !== eb && b[0] < x1 && b[2] > x0 && b[1] < y1 && b[3] > y0) { ok = false; return; } }
        });
        return ok;
      },
      freeX(x0, y0, x1, y1, exs) {   // like free(), ignoring any number of known boxes
        let ok = true;
        cells(x0, y0, x1, y1, k => {
          if (!ok) return;
          const l = g.get(k); if (!l) return;
          for (let i = 0; i < l.length; i++) { const b = l[i]; if (b[0] < x1 && b[2] > x0 && b[1] < y1 && b[3] > y0 && exs.indexOf(b) < 0) { ok = false; return; } }
        });
        return ok;
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
    const segs = o.segs, rects = [], path = [], see = [];
    let fin = null, gid = 0, ng = 1; const placedP = [];
    let px = 0, py = 0, pl = o.startW || 9;
    let si = 0, seg = segs[0], mode = seg.m, sleft = seg.n;
    let hdir = 1, lo = (seg.lo0 !== undefined ? seg.lo0 : -1), hi = pl + (seg.zw || (mode === 'up' ? 30 : 34));
    let baseY = 0, lock = 0, lockSign = 0, prevMode = mode, ext = 0;
    const sp = k => (seg[k] !== undefined ? seg[k] : o.p[k]);
    let nextSee = 0, prevWater = false;
    let total = 0; segs.forEach(s => { total += s.n + (s.ext ? 1 : 0); });
    if (o.withFinish) total += 1;

    function enter(nm) {
      if (nm === 'right') {
        if (prevMode === 'down') { lock = 10; lockSign = 1; }
        else if (prevMode === 'up') { lock = 10; lockSign = -1; }
        baseY = py;
      } else {
        hdir = 1; lo = px + (seg.lo0 !== undefined ? seg.lo0 : -1); hi = px + pl + (seg.zw || (nm === 'up' ? 30 : 34));
      }
      prevMode = nm; mode = nm;
    }

    for (let i = 1; i <= total; i++) {
      const last = o.withFinish && i === total;
      if (!last && sleft <= 0 && mode !== 'right' && (segs[si + 1] || seg.ext) && ext < 18 && (seg.endlo ? !(hdir < 0 && px - lo < 8) : px + pl < hi - 10)) { sleft = 1; ext++; total++; }   // finish the zig-zag on the open side, so the route that follows never runs back over it
      if (!last && sleft <= 0) {
        if (!segs[si + 1]) break;
        si++; seg = segs[si]; sleft = seg.n; gid = ng++; ext = 0;
        enter(seg.m);
      }
      sleft--;

      const rest = (!last && i % (seg.rest || 18) === 0 && mode === 'right');                                   // safe breather platform
      const narrow = (!last && !rest && i > 2 && Rn() < sp('narrow'));
      const water = (!last && !rest && !narrow && mode === 'right' && lock <= 0 && Rn() < sp('water'));
      const wd = sp('wd') || [5, 10], gpr = sp('gp') || [2, 4], ooL = sp('oo') || [-3, -2, -1, -1, 0, 0, 0, 1, 1, 2, 3, 4];
      // a teeter-totter: a gap too wide to jump, with a seesaw plank laid across it. Hop off its far end.
      // (decided one platform ahead, so the platforms on both sides of it are kept free of hazards)
      let seeG = nextSee; nextSee = 0;
      if (seeG && (last || rest || narrow || water || mode !== 'right' || lock > 0)) seeG = 0;
      let L = last ? 16 : rest ? 13 : water ? ri(8, 11) : narrow ? ri(2, 3) : (mode === 'up' ? ri(4, Math.min(7, wd[1])) : ri(wd[0], wd[1]));
      if (seeG) L = Math.max(L, 8);
      if (!last && !rest && !narrow && !water && !seeG && mode === 'right' && lock <= 0 && i > 2 && L >= 6 && sp('see') && Rn() < sp('see')) nextSee = ri(8, 10);

      let dy, gap;
      if (mode === 'right') {
        let oo = ooL.slice();
        const off = py - (seg.home != null ? seg.home : baseY);
        const dr = sp('drift') || 12;
        if (off > dr) oo = oo.filter(v => v <= 0); else if (off < -dr) oo = oo.filter(v => v >= 0);
        if (!oo.length) oo = [0];
        if (lock > 0) { oo = oo.filter(v => v * lockSign >= 0); if (!oo.length) oo = [0]; lock--; }
        dy = pick(oo);
        gap = dy <= -3 ? 2 : ri(gpr[0], gpr[1]);
      } else if (mode === 'down') {
        dy = ri(3, 4);   // steps you can climb back up as well as drop down
        gap = dy >= 4 ? 2 : ri(2, 3);
      } else {
        dy = -3;         // always a full 3-tile step so zig-zag layers keep head-room
        gap = 2;
      }

      if (seeG) { dy = 0; gap = seeG; }
      if (narrow || pl <= 3 || water || prevWater) gap = Math.min(gap, 3);
      prevWater = water;
      if (dy >= 3) gap = Math.min(gap, 3);
      if (gap >= 5 && dy > 0) dy = 0;
      if (gap >= 6) dy = 0;
      let nx;
      if (mode === 'right') {
        nx = px + pl + gap;
      } else {
        const place = () => (hdir > 0 ? px + pl + gap : px - gap - L);
        nx = place();
        if (hdir > 0 && nx + L > hi) { hdir = -1; gap = 2; nx = place(); }
        else if (hdir < 0 && nx < lo) { hdir = 1; gap = 2; nx = place(); }
      }
      let ny = py + dy;
      if (mode === 'down') {   // never land right under an earlier layer of this same shaft: keep at least 5 tiles of room above you
        for (let tries = 0; tries < 6; tries++) {
          let bad = false;
          for (let k = placedP.length - 2; k >= 0 && k >= placedP.length - 14; k--) { const q = placedP[k]; if (q.x1 > nx - 1 && q.x0 < nx + L + 1 && q.top < ny && ny - (q.top + 4) < 5) { bad = true; break; } }
          if (!bad) break; ny++;
        }
      }
      const h = water ? 4 : 2;
      if (o.ok && !(seeG ? o.ok(nx - gap, ny, L + gap, h) : o.ok(nx, ny, L, h))) break;
      if (seeG) see.push([nx - gap / 2, ny + 0.15, gap / 2 + 0.8, 0]);

      const thI = TH[seg.th];
      let t = 1, hz = 0;
      if (!rest && !last && !narrow && !water && !seeG && !nextSee && Rn() < sp('ice')) t = 3;
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
        if (L >= 5) {   // a hand-built underside, in a style that depends on the place, so islands do not all look alike
          const un = sp('un') ? pick(sp('un')) : 'round';
          if (un === 'flat') rects.push([nx, ny + 2, L, 1, 1, thI, gid]);
          else if (un === 'legs') { rects.push([nx + 1, ny + 2, 1, 2, 1, thI, gid]); rects.push([nx + L - 2, ny + 2, 1, 2, 1, thI, gid]); }
          else if (un === 'ragged') { for (let q = 1; q < L - 1; q++) if (Rn() < 0.6) rects.push([nx + q, ny + 2, 1, Rn() < 0.4 ? 2 : 1, 1, thI, gid]); }
          else if (un === 'stalac') { rects.push([nx + 1, ny + 2, L - 2, 1, 1, thI, gid]); for (let q = 2; q < L - 2; q += 2) if (Rn() < 0.7) rects.push([nx + q, ny + 3, 1, 1, 1, thI, gid]); }
          else if (un === 'stem') { rects.push([nx + 1, ny + 2, L - 2, 1, 1, thI, gid]); rects.push([nx + (L >> 1) - 1, ny + 3, 2, 1, 1, thI, gid]); }
          else { rects.push([nx + 1, ny + 2, L - 2, 1, 1, thI, gid]); if (L >= 7) rects.push([nx + 2, ny + 3, L - 4, 1, 1, thI, gid]); }
        }
      }
      if (!rest && !last && !narrow && !water && !seeG && !nextSee && (t === 1 || Rn() < 0.25)) {
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
      if (!hz && !last && !water && !narrow && !rest && !seeG && !nextSee && t === 1 && mode === 'right' && L >= 6 && Rn() < 0.12) {
        rects.push([nx + L - 3, ny - 1, 3, 1, 1, thI, gid]);   // raised ledge at the exit end
        hz = 1;
      }
      path.push([nx, ny, L, thI, mode === 'right' ? 0 : mode === 'down' ? 1 : 2, gid, seg.cave ? 1 : 0, h, seg.lavasea ? 1 : 0,
        (!hz && !last && !water && !narrow && !seeG && !nextSee && t === 1 && L >= 7) ? 1 : 0, rest ? 1 : 0, 0, seeG]);
      placedP.push({ x0: nx, x1: nx + L, top: ny }); px = nx; py = ny; pl = L;
    }
    return { rects, fin, path, ng, see };
  }

  const cache = {}, cacheOrder = [];

  function generate(idx) {
    idx = ((idx % DEFS.length) + DEFS.length) % DEFS.length;
    if (cache[idx]) return cache[idx];
    const d = DEFS[idx];
    const occ = Occ(), occB = Occ();   // occ: platforms + their jump room; occB: just the solid bodies (for floating districts)
    let ABS = null;
    const rects = [], gz = {};
    let gidN = 0, branchCount = 0; const chains = [];
    const MAXB = 1500;
    const coins = [], gad = { doors: [], plates: [], btns: [], see: [] }, decor = [];
    const coin = (x, y, k) => coins.push([x, y, k || 0]);
    const coinRow = (x, y, n, st, k) => { for (let i = 0; i < n; i++) coin(x + i * st, y, k); };
    const BR = rng(d.seed + 4242);
    const bri = (a, b) => a + Math.floor(BR() * (b - a + 1));
    const LS = d.ls, xl = d.xl, xr = d.xr, UPN = d.up, DNN = d.dn;
    const GY = LS * (DNN + 1) + (d.gOff || 0), YB = GY + 62, YT = -LS * (UPN - 1) - 40;
    const BP = { ice: 0.08, lava: 0.1, pillar: 0.06, narrow: 0.05, water: 0.1, wd: d.wd, gp: d.gp, oo: d.oo, un: d.un };

    const rIdx = new Map();   // rectangles by 16x16 tile cell, so "what is at this tile?" is quick
    function addRect(r) {
      rects.push(r);
      for (let cx = Math.floor(r[0] / 16); cx <= Math.floor((r[0] + r[2] - 1) / 16); cx++) for (let cy = Math.floor(r[1] / 16); cy <= Math.floor((r[1] + r[3] - 1) / 16); cy++) { const k = cx * 100003 + cy; let l = rIdx.get(k); if (!l) rIdx.set(k, l = []); l.push(r); }
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
      for (const q of (res.see || [])) gad.see.push([dir > 0 ? X + q[0] : X + PL - q[0], Y + q[1], q[2], q[3]]);
      const out = [];
      for (const e of res.path) {
        const x = dir > 0 ? X + e[0] : X + PL - e[0] - e[2];
        const w = [x, Y + e[1], e[2], e[3], e[4], e[5] + gbase, e[6], e[7], e[8], e[9], e[10] || 0, 0, e[12] || 0];
        out.push(w); const b = boxOf(w); w.box = occ.add(b[0], b[1], b[2], b[3]); w.bb = occB.add(w[0] - 1, w[1] - 1, w[0] + w[2] + 1, w[1] + w[7] + 1);
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
        const cy = m - 10, a = e[0], b = e[0] + e[2];
        let x0 = a, x1 = b;
        if (i > 0) { const p = pw[i - 1], pa = p[0], pb = p[0] + p[2]; if (pb <= a) x0 = pb; else if (b <= pa) x1 = pa; }
        if (!occ.free(x0, cy - 5, x1, cy)) continue;
        occ.add(x0, cy - 5, x1, cy);
        addRect([x0, cy - 5, x1 - x0, 5, 1, e[3], e[5]]);
        for (let x = x0 + 1; x < x1 - 1; x += 3) if (BR() < 0.4) addRect([x, cy, 1, 1, 1, e[3], e[5]]);   // hanging rock
      }
    }
    // little things to climb on
    function addStructures(pw, chance) {
      for (let i = 0; i < pw.length; i++) {
        const e = pw[i];
        if (!e[9] || e[4] !== 0 || BR() > (chance === undefined ? 0.5 : chance)) continue;
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
    function grow(e, segs, seed, lite) {
      const X = e[0], Y = e[1], PL = e[2];
      let best = null;
      for (const dir of ((seed & 1) ? [1, -1] : [-1, 1])) {
        const ok = (nx, ny, L, h) => {
          const x0 = dir > 0 ? X + nx - 1 : X + PL - nx - L - 1, x1 = dir > 0 ? X + nx + L + 1 : X + PL - nx + 1;
          if (x0 < xl + 4 || x1 > xr - 4 || Y + ny < YT || Y + ny + h + 2 > YB) return false;
          if (lite) return occB.free(x0, Y + ny - 1, x1, Y + ny + h + 1);
          const okk = occ.free(x0, Y + ny - 6, x1, Y + ny + h + 2); return okk;
        };
        const res = chain({ seed: seed + (dir > 0 ? 0 : 99), segs, p: BP, withFinish: false, startW: PL, ok });
        if (!best || res.path.length > best.res.path.length) best = { res, dir };
      }
      if (!best || best.res.path.length < 3) return null;
      const base = gidN; gidN += best.res.ng;
      const out = placeChain(best.res, X, Y, PL, best.dir, base); out.forEach(q => { q[11] = best.dir; }); return out;
    }

    // finds space next to a platform for a destination of width W; fn gets a mirror-aware helper
    let lastPl = null;
    function place(e, W, up, down, fn) {
      const A = ABS;
      for (const dir of (A ? [A.side] : BR() < 0.5 ? [1, -1] : [-1, 1])) {
        const nx = A ? (dir > 0 ? A.edge : A.edge - W) : dir > 0 ? e[0] + e[2] + 3 : e[0] - 3 - W, ny = A ? A.ny : e[1];
        if (!occ.free(nx - 1, ny - up, nx + W + 1, ny + down)) continue;   // never hang over a route: you must always have room to jump
        occ.add(nx - 1, ny - up, nx + W + 1, ny + down); occB.add(nx - 1, ny - up, nx + W + 1, ny + down);
        lastPl = { nx, W, ny };
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
    function roomOasis(e) {   // sand, a pool, stepping stones, and a bounce pad up to a ledge of gems
      const W = 30;
      return place(e, W, 10, 7, c => {
        const { ny, th, gid, X } = c; FLAT(c, W, 4);
        addRect([X(9, 12), ny, 12, 3, 5, th, gid]);
        addRect([X(11, 2), ny - 3, 2, 1, 1, th, gid]); addRect([X(15, 2), ny - 4, 2, 1, 1, th, gid]); addRect([X(19, 2), ny - 3, 2, 1, 1, th, gid]);
        coin(X(11, 2) + 1, ny - 4.2, 0); coin(X(15, 2) + 1, ny - 5.4, 1); coin(X(19, 2) + 1, ny - 4.2, 0); coinRow(X(10, 10) + 0.5, ny + 1.4, 10, 1, 0);
        addRect([X(1, 3), ny, 3, 1, 6, th, gid]); addRect([X(2, 8), ny - 9, 8, 1, 1, th, gid]);
        coinRow(X(3, 6) + 0.5, ny - 10.1, 6, 1, 2); coin(X(5, 1), ny - 4, 0);
        decor.push([2, X(W - 3, 1), ny]);
      });
    }
    function roomDunes(e) {   // a rolling run of sand hills: easy, and full of coins on the crests
      const W = 52;
      return place(e, W, 8, 6, c => {
        const { ny, th, gid, X } = c; FLAT(c, W, 3);
        for (let i = 0; i < 5; i++) {
          const w = bri(9, 11), x = 2 + i * 10, h = bri(2, 4);
          addRect([X(x, w), ny - 1, w, 1, 1, th, gid]);
          if (h >= 2) addRect([X(x + 1, w - 2), ny - 2, w - 2, 1, 1, th, gid]);
          if (h >= 3) addRect([X(x + 2, w - 4), ny - 3, w - 4, 1, 1, th, gid]);
          if (h >= 4) addRect([X(x + 3, w - 6), ny - 4, w - 6, 1, 1, th, gid]);
          coinRow(X(x + 3, 1) + 0.5, ny - h - 1.2, Math.max(2, w - 6), 1, 0);
        }
        coin(X(W - 3, 1), ny - 1.5, 2); coin(X(W - 5, 1), ny - 1.5, 2);
      });
    }
    function roomColumns(e) {   // broken temple pillars, climbing up and down
      const W = 36;
      return place(e, W, 11, 6, c => {
        const { ny, th, gid, X } = c; FLAT(c, W, 3);
        const hs = [3, 5, 7, 9, 7, 5, 8, 6]; let k = 0;
        for (let x = 3; x + 3 <= W - 3 && k < hs.length; x += 4, k++) {
          const h = hs[k]; addRect([X(x, 2), ny - h, 2, h, 1, th, gid]); addRect([X(x - 1, 4), ny - h - 1, 4, 1, 1, th, gid]);
          coin(X(x, 2) + 1, ny - h - 2.2, k === 3 ? 2 : 0); if (k % 2 === 0) coin(X(x, 2) + 1, ny - h - 3.4, 1);
        }
        coinRow(X(1, 1) + 0.5, ny - 1.2, 2, 1, 0);
      });
    }
    function roomVines(e) {   // a zig-zag ladder of small leaf platforms, going up
      const W = 16;
      return place(e, W, 26, 4, c => {
        const { ny, th, gid, X } = c; FLAT(c, W, 3);
        for (let i = 0; i < 7; i++) {
          const left = i % 2 === 0, x = left ? 0 : 10;
          addRect([X(x, 6), ny - 4 - i * 3, 6, 1, 1, th, gid]); coinRow(X(x, 6) + 1.5, ny - 5.2 - i * 3, 2, 1, i === 6 ? 2 : 0);
        }
        addRect([X(5, 6), ny - 25, 6, 1, 1, th, gid]); coin(X(5, 6) + 2, ny - 26.4, 2); coin(X(5, 6) + 4, ny - 26.4, 2); coin(X(5, 6) + 3, ny - 27.8, 1);
        addRect([X(6, 3), ny, 3, 1, 6, th, gid]);
      });
    }
    function roomCrater(e) {   // a lava pit you cross on little stones; a gem sits in the middle
      const W = 36;
      return place(e, W, 9, 8, c => {
        const { ny, th, gid, X } = c; FLAT(c, W, 4);
        addRect([X(10, 16), ny, 16, 4, 2, th, gid]);
        for (let i = 0; i < 4; i++) { addRect([X(12 + i * 4, 2), ny - 1 - (i % 2), 2, 1 + (i % 2), 1, th, gid]); coin(X(12 + i * 4, 2) + 1, ny - 2.4 - (i % 2), i === 1 ? 2 : 0); }
        coinRow(X(3, 5) + 0.5, ny - 1, 5, 1, 0); coinRow(X(28, 5) + 0.5, ny - 1, 5, 1, 0);
      });
    }
    function roomBridge(e) {   // a long, thin bridge over lava, with a few gaps to hop
      const W = 44;
      return place(e, W, 8, 8, c => {
        const { ny, th, gid, X } = c;
        addRect([X(0, 6), ny, 6, 3, 1, th, gid]); addRect([X(W - 6, 6), ny, 6, 3, 1, th, gid]);
        addRect([X(6, W - 12), ny + 4, W - 12, 3, 2, th, gid]);
        let x = 6; while (x < W - 6) { const w = bri(5, 8), ww = Math.min(w, W - 6 - x); addRect([X(x, ww), ny, ww, 1, 1, th, gid]); coinRow(X(x, ww) + 0.5, ny - 1.1, Math.max(1, ww - 1), 1, 0); x += ww + 2; }
        coin(X(W - 4, 1), ny - 1.2, 2); coin(X(W - 3, 1), ny - 1.2, 2);
      });
    }
    function roomRink(e) {   // a long sheet of ice with walls at the ends
      const W = 40;
      return place(e, W, 9, 5, c => {
        const { ny, th, gid, X } = c;
        addRect([c.nx, ny, W, 3, 1, th, gid]); addRect([X(2, W - 4), ny - 1, W - 4, 1, 3, th, gid]);
        addRect([X(0, 1), ny - 5, 1, 5, 1, th, gid]); addRect([X(W - 1, 1), ny - 5, 1, 5, 1, th, gid]);
        coinRow(X(4, 1) + 0.5, ny - 2.2, 16, 2, 0); coin(X(W - 3, 1), ny - 2.2, 2); coin(X(2, 1), ny - 2.2, 2);
      });
    }
    /* ---- more big places: gate halls, seesaw runs, slaloms, parkour towers ---- */
    function roomGateHall(e) {   // a hall cut in two by a door. Hop up to a switch on a high ledge, or park a crate on the plate. Treasure waits behind it.
      const W = 40;
      return place(e, W, 15, 7, c => {
        const { ny, th, gid, X } = c, id = gad.doors.length;
        FLAT(c, W, 4);
        addRect([X(0, 1), ny - 6, 1, 6, 1, th, gid]);
        addRect([X(2, 3), ny, 3, 1, 6, th, gid]); addRect([X(7, 6), ny - 6, 6, 2, 1, th, gid]);
        gad.btns.push([X(10, 1), ny - 6, [id]]); decor.push([1, X(10, 1), ny - 6]); coinRow(X(7, 6) + 0.5, ny - 7.4, 5, 1, 0);
        gad.plates.push([Math.min(X(15, 1), X(16, 1)), ny, 2, [id]]);
        props.push([0, X(18, 1), ny]); props.push([0, X(19, 1), ny]); props.push([0, X(20, 1), ny]);
        gad.doors.push([X(24, 1), ny - 7, 1, 7]); addRect([X(24, 1), ny - 15, 1, 8, 1, th, gid]); decor.push([2, X(24, 1), ny]);
        // behind the door: the vault
        addRect([X(W - 1, 1), ny - 15, 1, 15, 1, th, gid]); addRect([X(25, W - 25), ny - 15, W - 25, 1, 1, th, gid]);
        coinRow(X(26, 9) + 0.5, ny - 1.2, 8, 1, 1); coinRow(X(27, 7) + 0.5, ny - 3.4, 6, 1, 2); coin(X(30, 1), ny - 5.4, 2);
        jenga(X(33, 2), ny, 6); cratePyramid(X(36, 2), ny, 3);
        decor.push([0, X(W - 3, 1), ny]);
      });
    }
    function roomSeesawRun(e) {   // three lava gaps in a row, each with a teeter-totter laid across it
      const W = 52;
      return place(e, W, 9, 8, c => {
        const { ny, th, gid, X } = c;
        addRect([c.nx, ny + 4, W, 3, 1, th, gid]);
        let o = 0; const parts = [5, 9, 5, 10, 5, 9, 9];
        parts.forEach((w, k) => {
          const x = X(o, w);
          if (k % 2 === 0) { addRect([x, ny, w, 4, 1, th, gid]); coinRow(x + 0.5, ny - 1.2, Math.max(1, w - 1), 1, 0); }
          else { addRect([x, ny, w, 4, 2, th, gid]); gad.see.push([x + w / 2, ny + 0.15, w / 2 + 0.8, BR() < 0.5 ? 0.12 : -0.12]); coinRow(x + 1, ny - 3.6, w - 2, 1, k === 3 ? 1 : 0); }
          o += w;
        });
        addRect([X(0, 1), ny - 4, 1, 4, 1, th, gid]); addRect([X(W - 1, 1), ny - 4, 1, 4, 1, th, gid]);
        coin(X(W - 4, 1), ny - 1.4, 2); coin(X(W - 3, 1), ny - 1.4, 2);
      });
    }
    function roomSlalom(e) {   // a long sheet of ice dotted with lava blocks to hop over, with walls at the ends
      const W = 46;
      return place(e, W, 10, 5, c => {
        const { ny, th, gid, X } = c;
        addRect([c.nx, ny, W, 3, 1, th, gid]); addRect([X(1, W - 2), ny - 1, W - 2, 1, 3, th, gid]);
        addRect([X(0, 1), ny - 7, 1, 7, 1, th, gid]); addRect([X(W - 1, 1), ny - 7, 1, 7, 1, th, gid]);
        for (let o = 9; o < W - 6; o += bri(6, 8)) { addRect([X(o, 1 + (BR() < 0.3 ? 1 : 0)), ny - 2, 1, 1, 2, th, gid]); coin(X(o, 1) + 0.5, ny - 4.2, 0); coin(X(o, 1) + 0.5, ny - 5.4, 0); }
        coinRow(X(2, 1) + 0.5, ny - 2.4, 5, 1, 0); coin(X(W - 3, 1), ny - 2.4, 2); coin(X(W - 5, 1), ny - 2.4, 2);
      });
    }
    function roomParkour(e) {   // a sea of lava and a staircase of tiny stones: precision jumping, gems at the top
      const W = 42;
      return place(e, W, 20, 8, c => {
        const { ny, th, gid, X } = c;
        addRect([X(0, 5), ny, 5, 3, 1, th, gid]);
        addRect([X(5, W - 10), ny + 4, W - 10, 3, 2, th, gid]); addRect([c.nx, ny + 7, W, 1, 1, th, gid]);
        let o = 7, y = ny;
        for (let i = 0; i < 7; i++) {
          const dy = bri(-1, 1) - (i > 1 ? 1 : 0); y = Math.max(ny - 14, Math.min(ny, y + dy));
          addRect([X(o, 2), y, 2, 1, 1, th, gid]); coin(X(o, 2) + 1, y - 1.2, i === 3 ? 1 : 0);
          o += bri(4, 5);
        }
        o = Math.min(o, W - 7); addRect([X(o, 6), y - 1, 6, 2, 1, th, gid]);
        coinRow(X(o, 6) + 0.5, y - 2.2, 5, 1, 2); coin(X(o, 6) + 3, y - 3.8, 2);
      });
    }
    // how often each kind of place turns up (a map can change these to feel different)
    const RW0 = { gatehall: 12, seesaw: 8, slalom: 5, parkour: 8, up: 7, lake: 5, lava: 6, pyramid: 5, arch: 5, play: 14, pit: 10, vault: 14, gauntlet: 12, tramp: 10, isle: 12, oasis: 0, dunes: 0, columns: 0, vines: 0, crater: 0, bridge: 0, rink: 0 };
    const RW = Object.assign({}, RW0, d.rw || {});
    const RFN = { lake: roomLake, lava: roomLavaLake, pyramid: roomPyramid, arch: roomArch, play: roomPlay, pit: roomPit, vault: roomVault, gauntlet: roomGauntlet, tramp: roomTramp, isle: roomIsle,
      oasis: roomOasis, dunes: roomDunes, columns: roomColumns, vines: roomVines, crater: roomCrater, bridge: roomBridge, rink: roomRink, gatehall: roomGateHall, seesaw: roomSeesawRun, slalom: roomSlalom, parkour: roomParkour };
    const RKEYS = Object.keys(RW).filter(k => RW[k] > 0), RSUM = RKEYS.reduce((a, k) => a + RW[k], 0);
    function pickRoom(noUp) {
      let r = BR() * (noUp ? RSUM - (RW.up || 0) : RSUM);
      for (const k of RKEYS) { if (noUp && k === 'up') continue; r -= RW[k]; if (r <= 0) return k; }
      return 'play';
    }
    function room(e, pw) {
      const k = pickRoom(false);
      if (k === 'up') { grow(e, [S('up', bri(6, 12), THEMES[e[3]].id)], bri(1, 99999)); return; }
      let ok = RFN[k](e, pw);
      if (!ok) roomLake(e) || roomArch(e);
    }

    // floating districts: a bounce pad on the route throws you up to an island full of things to do
    function skyDistricts(pw) {
      let i = bri(2, 5);
      while (i < pw.length - 3) {
        const e = pw[i];
        if (e[9] && e[4] === 0 && !e[6] && e[2] >= 8) {
          let side = BR() < 0.5 ? 1 : -1, px = side > 0 ? e[0] + e[2] - 4 : e[0] + 1;
          const kinds = null;
          for (let t = 0; t < 10; t++) {
            if (t > 0 && t % 2 === 0) { side = -side; px = side > 0 ? e[0] + e[2] - 4 : e[0] + 1; }
            const up = 6 + (t >> 2);
            const fn = RFN[pickRoom(true)];
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
        i += bri(1, 3);
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
      branchCount++; chains.push([e].concat(pw));
      addStructures(pw);
      gates(pw, 0.4, true);
      addProps(pw, 0.6);
      addCeilings(pw);
      addCoins(pw, 0.7);
      if (BR() < 0.22) padShelf(pw[bri(0, pw.length - 1)]);
      room(pw[pw.length - 1], pw);
      if (depth < 4 && BR() < 0.7) branches(pw, depth + 1);
    }

    /* ================= the world: ground, lanes, ladders ================= */
    const GR = rng(d.seed + 999);
    const gri = (a, b) => a + Math.floor(GR() * (b - a + 1));
    const gpick = a => a[Math.floor(GR() * a.length)];
    const bands = d.bands;
    const bandAt = x => { for (let i = 0; i < bands.length; i++) if (x < bands[i].x1) return i; return bands.length - 1; };
    const bx0 = i => (i === 0 ? xl : bands[i - 1].x1), bx1 = i => Math.min(xr, bands[i].x1);
    const mainSet = new Set();
    const laneOf = (bi, r) => { const v = bands[bi].lane(r); const th = Array.isArray(v) ? v[0] : v, ex = Array.isArray(v) ? v[1] : {}; const o = Object.assign({}, TOPT[th] || {}, d.lo, ex, { th });
      if (d.hz) for (const k in d.hz) if (o[k] !== undefined || k === 'lava' || k === 'water') o[k] = Math.min(k === 'water' ? 0.35 : 0.65, (o[k] === undefined ? (k === 'lava' ? 0.1 : 0.08) : o[k]) * d.hz[k]);   // some levels are meaner than others
      return o; };

    // soft coloured backgrounds: one block per band and lane, so the sky above the ground changes with the place and the height
    const bgG = [];
    for (let bi = 0; bi < bands.length; bi++) {
      for (let r = -DNN - 1; r <= UPN - 1; r++) {
        const g = gidN++, y0 = r === UPN - 1 ? YT - 30 : -LS * r - LS / 2, y1 = r === -DNN - 1 ? YB : -LS * r + LS / 2;
        const th = r === -DNN - 1 ? bands[bi].g.th : laneOf(bi, r).th;
        gz[g] = [bx0(bi) - 2, y0, bx1(bi) + 2, y1, TH[th]]; bgG.push(g);
      }
    }
    const startGid = gidN++;
    const hubTh = TH[laneOf(bandAt(0), 0).th];

    /* --- the ground --- */
    const NW = xr - xl + 1, gh = new Int16Array(NW).fill(GY), tt = new Uint8Array(NW);
    const gi = x => x - xl, gfeat = [], gruns = [], noUG = [];
    const bandG = bands.map(() => gidN++);
    const fill = (x0, x1, lvl, t) => { for (let x = Math.max(xl, x0); x < Math.min(xr + 1, x1); x++) { gh[gi(x)] = lvl; tt[gi(x)] = t || 0; } };
    const RFNG = { lake: roomLake, lava: roomLavaLake, pyramid: roomPyramid, arch: roomArch, play: roomPlay, pit: roomPit, vault: roomVault, oasis: roomOasis, dunes: roomDunes, columns: roomColumns, crater: roomCrater, rink: roomRink, vines: roomVines, tramp: roomTramp, gauntlet: roomGauntlet, bridge: roomBridge, gatehall: roomGateHall, seesaw: roomSeesawRun, slalom: roomSlalom, parkour: roomParkour, isle: roomIsle };
    const gwpick = w => { let s = 0, ks = Object.keys(w); ks.forEach(k => { s += w[k]; }); let r = GR() * s; for (const k of ks) { r -= w[k]; if (r <= 0) return k; } return 'plain'; };
    const gmid = (x0, w) => x0 + w / 2;
    (function ground() {
      let level = GY, x = xl + 4, since = 0;
      while (x < xr - 6) {
        const bi = bandAt(x), bd = bands[bi], g = bd.g, gth = TH[g.th], gid = bandG[bi], amp = g.amp;
        const kind = since < 2 ? 'plain' : gwpick(g.w);
        since++;
        if (kind === 'plain') {
          const n = gri(2, 4);
          for (let k = 0; k < n && x < xr - 6; k++) {
            level = Math.max(GY - amp, Math.min(GY + amp, level + gpick([-2, -1, -1, 0, 0, 0, 1, 1, 2])));
            const len = gri(3, 9); fill(x, x + len, level); if (len >= 5) gruns.push([x, level, len, gth, 0, gid, 0, 2, 0, 1, 0]); x += len;
          }
        } else if (kind === 'hill') {
          const rise = gri(3, 6), top = gri(4, 10); let s = 0;
          for (let k = 1; k <= rise; k++) { fill(x, x + 2, level - k); x += 2; }
          fill(x, x + top, level - rise); coinRow(x + 1, level - rise - 1.2, Math.min(5, top - 1), 1, 0); gruns.push([x, level - rise, top, gth, 0, gid, 0, 2, 0, 1, 0]); x += top;
          for (let k = rise - 1; k >= 0; k--) { fill(x, x + 2, level - k); x += 2; }
          since = 0;
        } else if (kind === 'pond') {
          const w = g.pw ? gri(g.pw[0], g.pw[1]) : gri(9, 16);
          fill(x, x + w, level + 3); fill(x, x + 1, level + 1); fill(x + w - 1, x + w, level + 1);
          gfeat.push([x + 1, level, w - 2, 3, 5, gth, gid]); coinRow(x + 2, level + 1.5, Math.min(7, w - 4), 1, 0);
          if (w > 11) { for (let k = 1; k <= Math.floor(w / 9); k++) gfeat.push([x + Math.round(w * k / (Math.floor(w / 9) + 1)) - 1, level + 1, 2, 2, 1, gth, gid]); }
          x += w; since = 0;
        } else if (kind === 'lava') {
          const w = g.lw ? gri(g.lw[0], g.lw[1]) : gri(4, 11), dep = 4;
          fill(x, x + w, level + dep); gfeat.push([x, level, w, dep, 2, gth, gid]);
          const useSee = w >= 8 && w <= 11 && GR() < 0.45;   // sometimes a teeter-totter is laid across the lava instead of stepping stones
          if (useSee) gad.see.push([x + w / 2, level + 0.15, w / 2 + 0.8, 0]);
          else if (w >= 6) { const n = Math.max(1, Math.floor((w - 1) / 5)); for (let k = 1; k <= n; k++) { const sx = Math.round(x + (w * k) / (n + 1)) - 1; gfeat.push([sx, level, 2, dep, 1, gth, gid]); } }
          coin(x + w / 2, level - 3.2, 1); coinRow(x + 1, level - 1.4, Math.max(1, w - 2), 1, 0);
          x += w; since = 0;
        } else if (kind === 'chasm') {
          const w = gri(14, 22), dep = 5;
          fill(x, x + w, level + dep); gfeat.push([x, level, w, dep, 2, gth, gid]);
          let px = x; while (px < x + w) { const pw = Math.min(gri(3, 5), x + w - px); if (pw >= 2) { gfeat.push([px, level, pw, 1, 1, gth, gid]); coinRow(px + 0.5, level - 1.1, Math.max(1, pw - 1), 1, 0); } px += pw + 2; }
          gfeat.push([x - 1, level - 1, 1, 1, 1, gth, gid]); gfeat.push([x + w, level - 1, 1, 1, 1, gth, gid]);
          coin(x + w / 2, level - 3, 2);
          x += w; since = 0;
        } else if (kind === 'ice') {
          const len = gri(10, 26); fill(x, x + len, level, 3); gruns.push([x, level, len, gth, 0, gid, 0, 2, 0, 0, 0]); x += len;
        } else if (kind === 'pillars') {
          const len = gri(16, 28); fill(x, x + len, level);
          for (let px = x + 3; px < x + len - 4; px += gri(4, 6)) {
            const h = gri(2, 7); gfeat.push([px, level - h, 2, h, 1, gth, gid]); if (GR() < 0.6) gfeat.push([px - 1, level - h - 1, 4, 1, 1, gth, gid]);
            coin(px + 1, level - h - (GR() < 0.6 ? 2.4 : 1.2), GR() < 0.2 ? 1 : 0);
          }
          x += len; since = 0;
        } else {   // room: a proper destination standing on the ground
          const rk = GR() < 0.4 ? gpick(['gatehall', 'parkour', 'seesaw', 'slalom', 'gauntlet', 'bridge', 'gatehall', 'isle']) : gpick(g.rooms), fn = RFNG[rk];
          ABS = { side: 1, edge: x + 1, ny: level }; lastPl = null;
          const e = [x, level, 4, gth, 0, gid, 0, 2, 0, 0, 0];
          let ok = false; try { ok = fn(e, []); } finally { ABS = null; }
          if (ok && lastPl) { fill(lastPl.nx - 1, lastPl.nx + lastPl.W + 1, level); noUG.push([lastPl.nx - 3, lastPl.nx + lastPl.W + 4]); x = lastPl.nx + lastPl.W + 2; since = 0; }
          else { fill(x, x + 5, level); x += 5; }
        }
      }
    })();
    // the ground slab, with a whole underground carved into it (see below)
    const gStart = rects.length;
    const ugCps = [], ugStats = { shafts: 0, gates: 0, halls: 0, list: [] };
    (function groundAndUnderground() {
      const U0 = GY + 19, UB = YB - 3;                       // the cave layer lives between these rows: two floors of tunnels
      let MT = 1e9; for (let i = 0; i < NW; i++) if (gh[i] < MT) MT = gh[i]; MT -= 2;
      const MH = YB - MT, mix = (x, y) => (y - MT) * NW + (x - xl);
      const mk = new Uint8Array(NW * MH);                       // 0 air, 1 solid, 2 lava, 3 ice, 5 water, 6 bounce pad
      for (let x = xl; x <= xr; x++) { const top = gh[gi(x)]; for (let y = Math.max(MT, top); y < YB; y++) mk[mix(x, y)] = (y === top && tt[gi(x)] === 3) ? 3 : 1; }
      const put = (x0, y0, x1, y1, t) => { for (let x = Math.max(xl, x0); x < Math.min(xr + 1, x1); x++) for (let y = Math.max(MT, y0); y < Math.min(YB - 1, y1); y++) mk[mix(x, y)] = t; };
      const UR = rng(d.seed + 31337), ui = (a, b) => a + Math.floor(UR() * (b - a + 1));
      const caveTh = bi => { const c = (UNDER[bands[bi].g.th] || ['cave']).filter(t => THEMES[TH[t]].cave); return c.length ? c[(bi * 7 + (d.seed % 5)) % c.length] : 'cave'; };
      const ugBand = bands.map(() => gidN++);
      const spineLo = xl + 16, spineHi = xr - 16;
      const heavy = (th => th === 'volcano' ? { lava: 6, lake: 4 } : th === 'icecave' ? { ice: 6 } : th === 'mushroom' || th === 'cave' ? { pit: 3, crates: 3 } : { shelf: 3 })(caveTh(0));
      const flavour = [ui(0, 3), ui(0, 3), ui(0, 3)];
      /* one floor of tunnels: a long winding corridor with halls, hazards and puzzles along it */
      function spine(T) {
        const fl = new Int16Array(NW), kd = new Uint8Array(NW), FL = x => fl[gi(x)];
        const KW = { plain: 5, lava: 4, wide: 3, water: 3, ice: 2, shelf: 4, gate: 4 + T.deep * 2, lake: 3, crates: 3, pit: 3 };
        for (const k in heavy) KW[k] = (KW[k] || 0) + heavy[k];
        if (flavour[0] === 0) KW.gate += 5; if (flavour[1] === 0) KW.lava += 4 + T.deep * 3; if (flavour[2] === 0) KW.water += 4;
        const pickK = () => { let t = 0; for (const k in KW) t += KW[k]; let r = UR() * t; for (const k in KW) { r -= KW[k]; if (r <= 0) return k; } return 'plain'; };
        const flat = (x0, x1, f, h, kind) => { for (let x = x0; x < x1; x++) { fl[gi(x)] = f; kd[gi(x)] = kind || 1; put(x, Math.max(T.top, f - h), x + 1, f, 0); } };
        let x = spineLo, f = T.f0, lastGate = -99, segN = 0;
        const stepTo = (tf, h) => { while (f !== tf && x < spineHi) { f += f < tf ? 1 : -1; flat(x, x + 2, f, h || 7); x += 2; } };
        const walk = (len, h, kind) => {
          const x1 = Math.min(spineHi, x + len);
          while (x < x1) { const run = ui(2, 5); flat(x, Math.min(x1, x + run), f, h, kind); x += run; if (x < x1 - 2 && UR() < 0.55) { f = Math.max(T.fmin, Math.min(T.fmax, f + (UR() < 0.5 ? -1 : 1))); flat(x, x + 2, f, h, kind); x += 2; } }
        };
        const coinsAlong = (x0, x1, step) => { for (let c = x0 + 1; c < x1 - 1; c += step) if (kd[gi(c)] <= 2) coin(c + 0.5, FL(c) - 1.2, 0); };
        const hall = (W, h) => { const x0 = x; for (let c = x0; c < x0 + W; c++) { fl[gi(c)] = f; kd[gi(c)] = 3; put(c, Math.max(T.top, f - h), c + 1, f, 0); } return x0; };
        while (x < spineHi - 30) {
          const zn = T.zones.find(q => q[1] > x);
          if (zn && zn[0] - x < 60) { if (x < zn[0]) walk(zn[0] - x, 7, 1); walk(zn[1] - x + 2, 7, 1); continue; }   // a shaft comes down here: plain tunnel
          const kind = segN < 2 ? 'plain' : pickK(); segN++;
          const x00 = x;
          if (kind === 'plain') { walk(ui(14, 34), 7, 1); coinsAlong(x00, x, 2); if (UR() < 0.4 && x - x00 > 12) crateColumn(x00 + ui(3, x - x00 - 5), FL(x00 + 4), ui(2, 4)); if (UR() < 0.25) jenga(x00 + ui(2, Math.max(2, x - x00 - 6)), FL(x00 + 3), ui(4, 6)); }
          else if (kind === 'ice') { walk(ui(12, 22), 7, 2); for (let c = x00; c < x; c++) mk[mix(c, FL(c))] = 3; coinsAlong(x00, x, 3); }
          else if (kind === 'lava' || kind === 'wide' || kind === 'water') {
            walk(ui(4, 8), 7, 1); stepTo(Math.min(T.fmax - 3, Math.max(T.fmin, f)), 7);
            const w = kind === 'lava' ? ui(3, 5) : kind === 'wide' ? ui(8, 11) : ui(8, 14), x0 = x;
            for (let c = x0; c < x0 + w; c++) { fl[gi(c)] = f; kd[gi(c)] = 3; put(c, Math.max(T.top, f - 7), c + 1, f, 0); put(c, f, c + 1, f + 3, kind === 'water' ? 5 : 2); }
            if (kind === 'wide') gad.see.push([x0 + w / 2, f + 0.15, w / 2 + 0.8, 0]);
            if (kind === 'water') { for (let c = x0 + 3; c < x0 + w - 2; c += 3) put(c, f - 1, c + 1, f, 1); coinRow(x0 + 1, f + 1.4, w - 2, 1, 0); }
            else { coin(x0 + w / 2, f - 3.2, 1); coinRow(x0 + 0.5, f - 2.2, w, w > 6 ? 2 : 1, 0); }
            x += w; walk(ui(4, 8), 7, 1);
          } else if (kind === 'shelf') {
            walk(4, 7, 1); stepTo(Math.max(T.fmin + 5, Math.min(T.fmax, f)), 7);
            const W = 13, x0 = hall(W, 13);
            put(x0 + 1, f, x0 + 4, f + 1, 6); put(x0 + 7, f - 6, x0 + W, f - 4, 1);
            coinRow(x0 + 7.5, f - 7.2, 5, 1, 0); coin(x0 + 10, f - 8.6, 2); coin(x0 + 2.5, f - 3.5, 0); coin(x0 + 2.5, f - 5, 0);
            x += W; walk(ui(3, 6), 7, 1);
          } else if (kind === 'gate' && x - lastGate > 60) {
            walk(3, 7, 1); stepTo(Math.max(T.top + 12, Math.min(T.fmax, f)), 7);
            const W = 38, x0 = hall(W, 12), id = gad.doors.length, dx = x0 + 19;
            gad.doors.push([dx, f - 7, 1, 7]); put(dx, Math.max(T.top, f - 12), dx + 1, f - 7, 1); decor.push([2, dx, f]);
            for (const side of [-1, 1]) {
              const base = side < 0 ? x0 + 3 : x0 + W - 6; put(base, f, base + 3, f + 1, 6);
              const lx = side < 0 ? base + 4 : base - 7; put(lx, f - 6, lx + 6, f - 4, 1);
              const bx = lx + 3; gad.btns.push([bx, f - 6, [id]]); decor.push([1, bx, f - 6]); coinRow(lx + 0.5, f - 7.4, 5, 1, 0);
            }
            gad.plates.push([dx - 5, f, 2, [id]]); gad.plates.push([dx + 4, f, 2, [id]]);
            for (const o of [-9, -8, -7, 8, 9, 10]) props.push([0, dx + o, f]);
            coinRow(dx + 2, f - 1.2, 3, 1, 1); coin(dx - 3, f - 1.2, 2);
            ugCps.push([dx + 6, f]); x += W; lastGate = x; ugStats.gates++; ugStats.halls++; walk(ui(3, 6), 7, 1);
          } else if (kind === 'lake') {
            walk(3, 7, 1); stepTo(Math.max(T.fmin + 4, Math.min(T.fmax - 3, f)), 7);
            const W = 24, x0 = hall(W, 11);
            put(x0 + 4, f, x0 + W - 4, f + 4, 2);
            for (let sx = x0 + 6, k = 0; sx < x0 + W - 6; sx += 4, k++) { put(sx, f - 1 - (k % 2), sx + 2, f + 4, 1); coin(sx + 1, f - 2.4 - (k % 2), k === 1 ? 2 : 0); }
            coinRow(x0 + 1, f - 1.2, 3, 1, 0); coinRow(x0 + W - 4, f - 1.2, 3, 1, 0);
            x += W; walk(ui(3, 6), 7, 1);
          } else if (kind === 'crates') {
            walk(3, 8, 1); const W = 26, x0 = hall(W, 10);
            jenga(x0 + 4, f, ui(5, 7)); cratePyramid(x0 + 10, f, 4); crateColumn(x0 + 17, f, ui(4, 6)); props.push([2, x0 + 21, f]); props.push([3, x0 + 23, f]);
            coinRow(x0 + 2, f - 1.2, 22, 2, 0); x += W; walk(ui(3, 6), 7, 1);
          } else if (kind === 'pit') {
            walk(3, 8, 1); const W = 22, x0 = hall(W, 9);
            put(x0 + 3, f, x0 + W - 3, f + 2, 0);
            for (let i = 0; i < 18; i++) props.push([4, x0 + 3.4 + i * 0.82, f + 2]);
            for (let i = 0; i < 17; i++) props.push([4, x0 + 3.8 + i * 0.82, f + 1.26]);
            coinRow(x0 + 5, f - 1.2, 12, 1, 0); coin(x0 + 11, f - 2.8, 1); x += W; walk(ui(3, 6), 7, 1);
          } else walk(ui(8, 14), 7, 1);
          if (segN % 5 === 0) ugCps.push([x - 3, FL(x - 3)]);
        }
        const endX = x; for (let c = endX; c < spineHi; c++) { fl[gi(c)] = f; kd[gi(c)] = 1; put(c, Math.max(T.top, f - 7), c + 1, f, 0); }
        return { fl, kd, endX };
      }
      const SWID = 14;
      const bad = new Uint8Array(NW + 40);
      for (const q of gfeat) for (let c = Math.floor(q[0]) - 3; c <= q[0] + q[2] + 3; c++) if (c >= xl && c <= xr) bad[gi(c)] = 1;
      for (const q of noUG) for (let c = q[0]; c <= q[1]; c++) if (c >= xl && c <= xr) bad[gi(c)] = 1;
      for (const q of gad.see) for (let c = Math.floor(q[0] - q[2]) - 3; c <= q[0] + q[2] + 3; c++) if (c >= xl && c <= xr) bad[gi(c)] = 1;
      // plan where the shafts will go first, so the tunnels underneath can be made plain right there
      const sitesU = [], sitesL = [], zU = [], zL = [];
      const nS = ui(8, 14), nS2 = ui(5, 9);
      const siteOk = x0 => { let lo = 1e9, hi = -1e9; for (let c = x0 - 2; c <= x0 + SWID + 2; c++) { if (bad[gi(c)]) return false; const g = gh[gi(c)]; lo = Math.min(lo, g); hi = Math.max(hi, g); } return hi - lo <= 6 && hi < U0 - 3; };
      for (let tries = 0; tries < 4000 && sitesU.length < nS; tries++) {
        const x0 = ui(spineLo + 8, spineHi - SWID - 8); if (!siteOk(x0)) continue;
        if (sitesU.some(q => Math.abs(q - x0) < SWID + 22)) continue;
        sitesU.push(x0); zU.push([x0 - 4, x0 + SWID + 4]);
      }
      for (let tries = 0; tries < 4000 && sitesL.length < nS2; tries++) {
        const x0 = ui(spineLo + 8, spineHi - SWID - 8);
        if (sitesL.some(q => Math.abs(q - x0) < SWID + 30) || sitesU.some(q => Math.abs(q - x0) < SWID + 8)) continue;
        sitesL.push(x0); zU.push([x0 - 4, x0 + SWID + 4]); zL.push([x0 - 4, x0 + SWID + 4]);
      }
      zU.sort((p, q) => p[0] - q[0]); zL.sort((p, q) => p[0] - q[0]);
      const upper = spine({ top: U0 + 1, f0: U0 + 15, fmin: U0 + 9, fmax: U0 + 17, deep: 0, zones: zU });
      const lower = spine({ top: U0 + 24, f0: UB - 8, fmin: UB - 12, fmax: UB - 5, deep: 1, zones: zL });
      const shafts = [], shafts2 = [];
      const ledges = (x0, rimL, rimR, bottom) => {   // ledges spaced evenly from the floor up to the rim, never more than 4 apart, alternating sides
        const T = Math.min(rimL, rimR), topSide = rimL <= rimR ? 0 : 1, H = bottom - (T + 3), n = Math.max(1, Math.ceil(H / 4)), out = [];
        for (let j = 0; j < n; j++) {
          const yy = bottom - Math.round((bottom - (T + 3)) * (j + 1) / n);
          const side = ((n - 1 - j) % 2 === 0) ? topSide : 1 - topSide;
          if (side === 0) put(x0, yy, x0 + 6, yy + 2, 1); else put(x0 + SWID - 6, yy, x0 + SWID, yy + 2, 1);
          out.push([side === 0 ? x0 : x0 + SWID - 6, yy]);
        }
        return out;
      };
      for (let tries = 0; tries < 2500 && shafts.length < nS; tries++) {   // surface -> upper tunnels
        const x0 = tries < sitesU.length ? sitesU[tries] : ui(spineLo + 4, Math.min(spineHi, upper.endX) - SWID - 4);
        if (x0 < spineLo + 4 || x0 + SWID > upper.endX - 4) continue;
        let lo = 1e9, hi = -1e9, fmax = -1e9, ok = true;
        for (let c = x0 - 2; c <= x0 + SWID + 2 && ok; c++) { const g = gh[gi(c)]; lo = Math.min(lo, g); hi = Math.max(hi, g); if (bad[gi(c)]) ok = false; if (c >= x0 && c < x0 + SWID) { const k = upper.kd[gi(c)]; if (k !== 1 && k !== 2) ok = false; fmax = Math.max(fmax, upper.fl[gi(c)]); } }
        if (!ok || hi - lo > 6 || fmax - hi < 12 || hi >= U0 - 3) continue;
        if (shafts.some(s => Math.abs(s - x0) < SWID + 14)) continue;
        shafts.push(x0); const rim = gh[gi(x0 - 1)];
        for (let c = x0; c < x0 + SWID; c++) put(c, gh[gi(c)], c + 1, upper.fl[gi(c)], 0);
        for (let c = x0; c < x0 + SWID; c++) { if (upper.fl[gi(c)] !== fmax) { put(c, fmax, c + 1, upper.fl[gi(c)], 1); put(c, Math.max(U0 + 1, fmax - 7), c + 1, fmax, 0); upper.fl[gi(c)] = fmax; } }
        const led = ledges(x0, gh[gi(x0 - 1)], gh[gi(x0 + SWID)], fmax);
        coinRow(x0 + 1.5, rim + 1.8, 3, 1, 0); coinRow(x0 + SWID - 4.5, rim + 4.8, 3, 1, 0); ugCps.push([x0 + 7, fmax]);
        occ.add(x0 - 2, rim - 14, x0 + SWID + 2, fmax + 1); occB.add(x0 - 2, rim - 14, x0 + SWID + 2, fmax + 1);
        for (let i = gruns.length - 1; i >= 0; i--) { const r = gruns[i]; if (r[0] < x0 + SWID + 3 && r[0] + r[2] > x0 - 3) gruns.splice(i, 1); }
        ugStats.shafts++; ugStats.list.push([x0, gh[gi(x0 - 1)], fmax, gh[gi(x0 + SWID)], led]);
      }
      for (let tries = 0; tries < 3000 && shafts.length < 5; tries++) {   // a level with too few ways down: accept bumpier ground
        const x0 = ui(spineLo + 4, Math.min(spineHi, upper.endX) - SWID - 4);
        if (x0 < spineLo + 4 || x0 + SWID > upper.endX - 4) continue;
        let lo = 1e9, hi = -1e9, fmax = -1e9, ok = true;
        for (let c = x0 - 2; c <= x0 + SWID + 2 && ok; c++) { const g = gh[gi(c)]; lo = Math.min(lo, g); hi = Math.max(hi, g); if (bad[gi(c)]) ok = false; if (c >= x0 && c < x0 + SWID) { const k = upper.kd[gi(c)]; if (k !== 1 && k !== 2) ok = false; fmax = Math.max(fmax, upper.fl[gi(c)]); } }
        if (!ok || hi - lo > 9 || fmax - hi < 12 || hi >= U0 - 3) continue;
        if (shafts.some(s => Math.abs(s - x0) < SWID + 10)) continue;
        shafts.push(x0);
        for (let c = x0; c < x0 + SWID; c++) put(c, gh[gi(c)], c + 1, upper.fl[gi(c)], 0);
        for (let c = x0; c < x0 + SWID; c++) { if (upper.fl[gi(c)] !== fmax) { put(c, fmax, c + 1, upper.fl[gi(c)], 1); put(c, Math.max(U0 + 1, fmax - 7), c + 1, fmax, 0); upper.fl[gi(c)] = fmax; } }
        const rL = gh[gi(x0 - 1)], rR = gh[gi(x0 + SWID)], led = ledges(x0, rL, rR, fmax);
        coinRow(x0 + 1.5, Math.min(rL, rR) + 1.8, 3, 1, 0); ugCps.push([x0 + 7, fmax]);
        occ.add(x0 - 2, Math.min(rL, rR) - 14, x0 + SWID + 2, fmax + 1); occB.add(x0 - 2, Math.min(rL, rR) - 14, x0 + SWID + 2, fmax + 1);
        for (let i = gruns.length - 1; i >= 0; i--) { const r = gruns[i]; if (r[0] < x0 + SWID + 3 && r[0] + r[2] > x0 - 3) gruns.splice(i, 1); }
        ugStats.shafts++; ugStats.list.push([x0, rL, fmax, rR, led]);
      }
      for (let tries = 0; tries < 2500 && shafts2.length < nS2; tries++) {   // upper -> lower tunnels
        const x0 = tries < sitesL.length ? sitesL[tries] : ui(spineLo + 4, Math.min(upper.endX, lower.endX) - SWID - 4);
        if (x0 < spineLo + 4 || x0 + SWID > Math.min(upper.endX, lower.endX) - 4) continue;
        let ok = true, fu = -1e9, fd = -1e9;
        for (let c = x0; c < x0 + SWID && ok; c++) { const k1 = upper.kd[gi(c)], k2 = lower.kd[gi(c)]; if ((k1 !== 1 && k1 !== 2) || (k2 !== 1 && k2 !== 2)) ok = false; fu = Math.max(fu, upper.fl[gi(c)]); fd = Math.max(fd, lower.fl[gi(c)]); }
        if (!ok || fd - fu < 10) continue;
        if (shafts2.some(s => Math.abs(s - x0) < SWID + 30) || shafts.some(s => Math.abs(s - x0) < SWID + 6)) continue;
        shafts2.push(x0);
        for (let c = x0; c < x0 + SWID; c++) { put(c, upper.fl[gi(c)], c + 1, lower.fl[gi(c)], 0); }
        for (let c = x0; c < x0 + SWID; c++) { if (lower.fl[gi(c)] !== fd) { put(c, fd, c + 1, lower.fl[gi(c)], 1); put(c, Math.max(U0 + 24, fd - 7), c + 1, fd, 0); lower.fl[gi(c)] = fd; } }
        const led = ledges(x0, fu, fu, fd);
        // a lip around the top so you do not step into it by accident
        coinRow(x0 + 1.5, fu + 1.8, 3, 1, 0); ugCps.push([x0 + 7, fd]);
        ugStats.shafts++; ugStats.list.push([x0, fu, fd, fu, led]);
      }
      // turn the grid back into rectangles: columns with the same run of the same kind of tile are merged
      const cur = new Map();
      const emit = (x0, y0, w, h, t, bi) => {
        if (y0 >= U0) addRect([x0, y0, w, h, t, TH[caveTh(bi)], ugBand[bi]]);
        else rects.push([x0, y0, w, h, t, TH[bands[bi].g.th], bandG[bi]]);
      };
      for (let x = xl; x <= xr + 1; x++) {
        const bi = x <= xr ? bandAt(x) : -1, seen = new Set();
        if (x <= xr) {
          let y = MT;
          while (y < YB) {
            const t = mk[mix(x, y)]; if (!t) { y++; continue; }
            let y2 = y + 1; while (y2 < YB && mk[mix(x, y2)] === t && (y2 < U0) === (y < U0)) y2++;
            const key = bi + ':' + y + ':' + (y2 - y) + ':' + t; seen.add(key);
            const o = cur.get(key); if (o) o.w++; else cur.set(key, { x0: x, y0: y, h: y2 - y, t, bi, w: 1 });
            y = y2;
          }
        }
        for (const [key, o] of cur) if (!seen.has(key)) { emit(o.x0, o.y0, o.w, o.h, o.t, o.bi); cur.delete(key); }
      }
      occ.add(xl, U0, xr, YB); occB.add(xl, U0, xr, YB);   // nothing else is ever built down here
    })();
    for (const f of gfeat) rects.push(f);
    // walls at both ends of the world, so nobody walks off the side
    { const th = TH[bands[0].g.th], th2 = TH[bands[bands.length - 1].g.th];
      rects.push([xl - 3, YT - 6, 3, YB - YT + 6, 1, th, bandG[0]]); rects.push([xr + 1, YT - 6, 3, YB - YT + 6, 1, th2, bandG[bands.length - 1]]); }
    // things to find on the ground
    addStructures(gruns); addProps(gruns, 0.35); addCoins(gruns, 0.55);
    for (let i = gStart; i < rects.length; i++) { const r = rects[i]; occ.add(r[0] - 1, r[1] - 1, r[0] + r[2] + 1, r[1] + r[3] + 1); occB.add(r[0] - 1, r[1] - 1, r[0] + r[2] + 1, r[1] + r[3] + 1); }
    const groundAt = (x0, x1) => { let m = 1e9; for (let x = Math.max(xl, Math.floor(x0)); x <= Math.min(xr, Math.ceil(x1)); x++) m = Math.min(m, gh[gi(x)]); return m; };

    /* --- the start platform --- */
    const sTh = TH[laneOf(bandAt(0), 0).th];
    // A roomy, harmless playground: a little of everything and nothing that kills you.
    const SW = 41;
    addRect([0, 0, 3, 2, 1, sTh, startGid]);                       // where you appear
    addRect([6, 0, 6, 2, 1, sTh, startGid]);                       // a bounce pad and a coin trail
    addRect([12, 1, 8, 1, 1, sTh, startGid]);                      // a basin one block down: crates in here can be pushed around but never off the edge
    addRect([20, 0, 5, 2, 1, sTh, startGid]); addRect([21, 0, 3, 1, 3, sTh, startGid]);   // a patch of ice
    addRect([25, 3, 9, 2, 1, sTh, startGid]);                      // the floor under the see-saw
    addRect([34, 0, 7, 2, 1, sTh, startGid]);                      // a little lookout
    addRect([9, 0, 2, 1, 6, sTh, startGid]);                       // bounce pad
    coin(10, -3.2, 0); coin(10, -5.2, 0); coin(10, -7.6, 1);
    gad.see.push([29.5, 0.15, 5.3, 0]);                            // a see-saw over a shallow dip
    cratePyramid(13.2, 1, 3); jenga(17.2, 1, 5); props.push([2, 16.1, 1]); props.push([3, 19.2, 1]);
    coinRow(14, -0.4, 6, 1, 0); coinRow(22, -1.6, 3, 1, 0); coinRow(27, -3.4, 5, 1, 0); coinRow(36, -1.4, 4, 1, 0); coin(38, -3.4, 1);
    crateColumn(35.2, 0, 3);
    occ.add(-1, -9, SW + 1, 3); occ.add(-1, -6, SW + 1, 8);
    addRect([0, 7, 9, 2, 1, sTh, startGid]); addRect([4, 7, 1, 1, 6, sTh, startGid]);
    occ.add(-1, 5, 11, 12); occB.add(-1, 5, 11, 12); occB.add(-1, -9, SW + 1, 12);
    coinRow(0.5, 5.4, 3, 1, 0); coinRow(6.5, 5.4, 3, 1, 0); coinRow(4, 3.2, 1, 1, 1);
    // ---- more to play with at the start ----
    occ.add(-1, -14, SW + 1, -9); occB.add(-1, -14, SW + 1, -9);
    // a staircase of ledges in the sky above the basin: bounce up from the pad, climb, and ride the gems
    addRect([13, -5, 5, 1, 1, sTh, startGid]); addRect([20, -9, 5, 1, 1, sTh, startGid]); addRect([27, -12, 6, 1, 1, sTh, startGid]);
    coinRow(13.5, -6.2, 4, 1, 0); coinRow(20.5, -10.2, 4, 1, 0); coinRow(27.5, -13.2, 5, 1, 0); coin(30, -14.8, 2); coin(22, -11.8, 1);
    // a switch on the first ledge opens a little vault at the lookout: crates and coins inside
    { const id = gad.doors.length; gad.btns.push([15, -5, [id]]); decor.push([1, 15, -5]);
      gad.doors.push([37, -6, 1, 6]); decor.push([2, 37, 0]); addRect([37, -7, 4, 1, 1, sTh, startGid]);
      coinRow(38, -1.2, 3, 1, 1); coin(39, -3, 2); props.push([0, 39, 0]); props.push([0, 40, 0]); props.push([3, 38.5, 0]); }
    // a ball pit in the dip under the see-saw, and a coin wave over everything
    for (let i = 0; i < 8; i++) props.push([4, 25.9 + i * 0.95, 3]);
    for (let i = 0; i < 7; i++) props.push([4, 26.4 + i * 0.95, 2.3]);
    for (let i = 0; i < 10; i++) coin(3 + i * 3.6, -8.4 - Math.sin(i / 9 * Math.PI) * 1.8, i === 4 || i === 5 ? 1 : 0);
    // a second pair of crates to build with, a tall tower, and trampolines on the lookout
    cratePyramid(2.6, 0, 3); crateColumn(5.6, 0, 4); jenga(23.4, 0, 4);
    // the lower hideout: a hoard of coins and toys
    coinRow(1.5, 5.4, 6, 1, 0); crateColumn(7, 7, 3); props.push([2, 2, 7]); props.push([3, 6.2, 7]);
    const startPlat = [0, 0, SW, sTh, 0, startGid, 0, 2, 0, 0, 0];

    /* --- lanes --- */
    function growDir(e, segs, seed, dir, lim, o) {
      o = o || {};
      const X = e[0], Y = e[1], PL = e[2];
      const ok = (nx, ny, L, h) => {
        const x0 = dir > 0 ? X + nx - 1 : X + PL - nx - L - 1, x1 = dir > 0 ? X + nx + L + 1 : X + PL - nx + 1;
        if (x0 < lim[0] || x1 > lim[1] || Y + ny < YT || Y + ny + h + 2 > YB) return false;
        if (o.lite) return occB.free(x0, Y + ny - 1, x1, Y + ny + h + 1);
        return o.ex ? occ.free2(x0, Y + ny - 6, x1, Y + ny + h + 2, o.ex[0], o.ex[1]) : occ.free(x0, Y + ny - 6, x1, Y + ny + h + 2);
      };
      const res = chain({ seed, segs, p: BP, withFinish: !!o.fin, startW: PL, ok });
      if (!res.path.length) return null;
      if (o.fin && !res.fin) return null;
      if (o.accept && !o.accept(res, X, Y, PL, dir)) return null;
      const base = gidN; gidN += res.ng;
      if (o.main) for (let k = 0; k < res.ng; k++) mainSet.add(base + k);
      const pw = placeChain(res, X, Y, PL, dir, base);
      pw.forEach(q => { q[11] = dir; });
      if (res.fin) pw.fin = dir > 0 ? [X + res.fin[0], Y + res.fin[1], res.fin[2]] : [X + PL - res.fin[0] - res.fin[2], Y + res.fin[1], res.fin[2]];
      { const c = [e].concat(pw); c.k = o.kind || 'x'; chains.push(c); }
      return pw;
    }
    const WHOLE = [xl + 4, xr - 4], LM = 36;
    // the lowest lane dips down to the ground and climbs back up again, so anyone who ends up on the ground can find a way back
    function dip(e, dir, r) {
      const lt = laneOf(bandAt(e[0]), r), gAt = groundAt(e[0] - 6, e[0] + e[2] + 36 * dir);
      for (let att = 0; att < 16; att++) {
        const n = Math.max(2, Math.round((gAt - e[1]) / 3.6) - 3 + (att % 7));
        const dn = growDir(e, [SEG('down', n, lt.th, Object.assign({}, lt, { zw: 26, cave: 0, lo0: e[2] + 1 }))], d.seed + 8100 + att * 31 + (e[0] | 0), dir, WHOLE, { lite: true, kind: 'dip',
          accept: (res, X, Y, PL, dd) => { const q = res.path[res.path.length - 1], qx = dd > 0 ? X + q[0] : X + PL - q[0] - q[2], gap = groundAt(qx - 2, qx + q[2] + 2) - (Y + q[1]); return gap >= 4 && gap <= 5; } });
        if (!dn) continue;
        const laneY = -LS * r;
        // a ledge on the ground, a little further along, where the climb back up begins
        let far = dir > 0 ? -1e9 : 1e9; for (const q of dn) far = dir > 0 ? Math.max(far, q[0] + q[2]) : Math.min(far, q[0]);
        let ux = 0, gy0 = 0, found = false;
        for (let k = 0; k < 40 && !found; k++) { ux = dir > 0 ? far + 5 + k * 2 : far - 10 - k * 2; gy0 = groundAt(ux - 1, ux + 6); if (ux > xl + 10 && ux < xr - 20 && occB.free(ux - 1, gy0 - 5, ux + 6, gy0 - 1)) found = true; }
        if (!found) return dn;
        const g = [ux, gy0 - 4, 5, lt.th !== undefined ? TH[lt.th] : 0, 0, dn[0][5], 0, 2, 0, 0, 0];
        addRect([ux, gy0 - 4, 5, 2, 1, g[3], g[5]]); occ.add(ux - 1, gy0 - 10, ux + 6, gy0 - 1); occB.add(ux - 1, gy0 - 5, ux + 6, gy0 - 1);
        coinRow(ux + 0.5, gy0 - 5.2, 4, 1, 0);
        for (let a2 = 0; a2 < 16; a2++) {
          const n2 = Math.max(2, Math.round((g[1] - laneY) / 3) - 3 + (a2 % 7)); if (a2 === 0) ;
          const up = growDir(g, [SEG('up', n2, lt.th, Object.assign({}, lt, { zw: 26, cave: 0, lo0: g[2] + 1, ext: 1 }))], d.seed + 8200 + a2 * 37 + (g[0] | 0), dir, WHOLE, { lite: true, kind: 'dip',
            accept: (res, X, Y) => { const q = res.path[res.path.length - 1]; return Math.abs(Y + q[1] - laneY) <= 4; } });
          if (up) return dn.concat(up);
        }
        return dn;   // a way down at least
      }
      return null;
    }
    // each lane is cut into short chunks of very different character, so no stretch looks like the one before it
    const FLAV = {
      plain: {},
      islets: { wd: [3, 5], gp: [3, 4], narrow: 0.22, oo: [-4, -3, -2, 2, 3, 4, -1, 1], drift: 5, lava: 0.05 },
      lavarun: { wd: [8, 14], lava: 0.85, pillar: 0.45, ice: 0, oo: [0, 0, 1, -1], gp: [2, 3] },
      iceslide: { wd: [8, 13], ice: 0.9, lava: 0.25, oo: [0, 0, -1, 1, -2], gp: [2, 3] },
      waterhop: { wd: [8, 11], water: 0.55, oo: [0, 0, -1, 1], gp: [2, 3] },
      seesaws: { wd: [8, 12], see: 0.6, lava: 0.2, oo: [0, 0, 0, 1], gp: [2, 3] },
      stones: { wd: [2, 4], gp: [2, 3], narrow: 0.5, oo: [-3, -2, -1, 1, 2, 3], drift: 5, ice: 0.1 },
      arena: { wd: [11, 17], gp: [2, 3], oo: [0, 0, 1, -1], pillar: 0.5, lava: 0.4 },
      stairs: { wd: [4, 7], gp: [2, 3], oo: [-3, -3, -2, -3, -1, 1], drift: 5 },
      drops: { wd: [4, 8], gp: [2, 4], oo: [3, 3, 2, 3, 3, -1, 1], drift: 5 },
      wisp: { wd: [2, 4], gp: [4, 6], oo: [0, 0, -1, -1, -2, 1], narrow: 0.35, lava: 0, pillar: 0, ice: 0.12, water: 0, rest: 99, drift: 5 },
      perch: { wd: [3, 4], gp: [5, 6], oo: [0, 0, 0, -1, -2], narrow: 0.5, lava: 0, pillar: 0, ice: 0, water: 0, rest: 99, drift: 5 },
      cloud: { wd: [4, 7], gp: [3, 5], oo: [0, -1, -2, -3, 1], narrow: 0.15, lava: 0.08, pillar: 0.05, ice: 0.3, rest: 99, drift: 5 },
      zigzag: { wd: [4, 8], gp: [2, 4], oo: [3, -3, 3, -3, 2, -2, 4, -4], drift: 5 },
      wild: { wd: [2, 15], gp: [2, 4], oo: [-4, -3, -2, -1, 0, 1, 2, 3, 4], narrow: 0.2, lava: 0.3, ice: 0.25, water: 0.15, see: 0.15, pillar: 0.25, drift: 5 },
      wild2: { wd: [3, 12], gp: [2, 4], oo: [-3, -2, 0, 2, 3, 4, -4], narrow: 0.12, lava: 0.35, ice: 0.3, water: 0.2, pillar: 0.3, drift: 5 },
      plaza: { wd: [15, 21], gp: [2, 3], oo: [0, 0, 1, -1], narrow: 0, lava: 0, ice: 0, water: 0, pillar: 0, see: 0, drift: 3 }   // a broad flat square: room for a crowd, a shortcut, or a pile of toys
    };
    const FW = {}; for (const k in FLAV) FW[k] = 0.4 + BR() * 2.2;   // every map has its own favourite kinds of stretch
    const FKEYS = Object.keys(FLAV);
    const sm = (a, b, x) => { const u = Math.max(0, Math.min(1, (x - a) / (b - a))); return u * u * (3 - 2 * u); };
    const heightT = r => Math.max(0, Math.min(1, (r + DNN) / Math.max(1, UPN - 1 + DNN)));   // 0 at the bottom of the sky, 1 at the very top
    const WISPY = { wisp: 1, perch: 1, cloud: 1, islets: 0.7, stones: 0.6, drops: 0.4 };
    function pickFlav(r) {
      const t = heightT(r), thick = 1 - sm(0.22, 0.78, t), thin = sm(0.28, 0.9, t);
      const w = { plain: 0.9, islets: 2, lavarun: 3, iceslide: 2, waterhop: 2, seesaws: 3, stones: 2, arena: 3, stairs: 2, drops: 2, zigzag: 3, wild: 5, wild2: 4, wisp: 4, perch: 2.5, cloud: 3 };
      for (const k in w) w[k] *= FW[k] * (WISPY[k] ? 0.04 + thin * 2.6 * WISPY[k] : 0.12 + thick * 1.2);
      w.plaza = 1.9 * (0.55 + 0.45 * FW.plaza / 2.6);   // (broad squares appear on every level, high or low)
      let tot = 0; for (const k of FKEYS) tot += w[k]; let q = BR() * tot;
      for (const k of FKEYS) { q -= w[k]; if (q <= 0) return k; }
      return 'plain';
    }
    function lane(e, dir, r, main, dips) {
      const out = []; let guard = 0, lastBi = -1, lastF = '', shorts = 0;
      while (guard++ < 120) {
        const nxt = e[0] + (dir > 0 ? e[2] + 10 : -10);
        if (nxt < xl + LM + 8 || nxt > xr - LM - 8) break;
        const bi = bandAt(nxt), lt = laneOf(bi, r);
        if (dips && lastBi >= 0 && bi !== lastBi) { const dp = dip(e, dir, r); if (dp) { out.push(...dp); e = dp[dp.length - 1]; continue; } }
        lastBi = bi;
        let fl = pickFlav(r); if (fl === lastF && fl !== 'plain') fl = 'plain'; lastF = fl;
        if (r === -DNN || shorts) fl = 'plain';   // (the lowest lane keeps to the ground)
        let pw = null;
        for (let att = 0; att < 5 && !pw; att++) {   // if a chunk will not fit, try another flavour, then the plain one
          const f2 = att < 2 ? fl : att < 4 ? pickFlav(r) : 'plain', ff = FLAV[f2];
          const segs = [SEG('right', att < 3 ? bri(3, 16) : bri(3, 8), lt.th, Object.assign({}, lt, ff, { home: -LS * r - e[1], rest: ff.rest || 7, drift: ff.drift || lt.drift }))];
          pw = growDir(e, segs, d.seed + r * 101 + guard * 7 + att * 977 + (dir > 0 ? 3 : 0), dir, [Math.max(bx0(bi) - 8, xl + 4 + LM), Math.min(bx1(bi) + 8, xr - 4 - LM)], { main, kind: 'lane' });
          if (pw) pw.forEach(q => { q[13] = f2; });
        }
        if (!pw) break;
        out.push(...pw); e = pw[pw.length - 1];
        if (pw.length < 2) { if (++shorts >= 3) break; } else shorts = 0;
      }
      return { pw: out, end: e };
    }
    function connect(e, odir, up, nr, main) {
      const lt = laneOf(bandAt(e[0]), nr);
      const n0 = Math.round(LS / (up ? 3.2 : 4));
      for (let att = 0; att < 18; att++) {
        const n = n0 - 3 + (att % 7);
        const segs = [SEG(up ? 'up' : 'down', n, lt.th, Object.assign({}, lt, { zw: 26, endlo: 1, ext: 1 }))];
        const pw = growDir(e, segs, d.seed + nr * 53 + att * 17, odir, WHOLE, { main, kind: 'conn', accept: (res) => { const last = res.path[res.path.length - 1], rise = Math.abs(last[1] - 0); return rise >= LS - 7 && rise <= LS + 9; } });
        if (pw) return pw;
      }
      return null;
    }

    /* ---- chaos: a pile of set-pieces dropped onto the platforms of the middle and the sky, so every stretch has something going on ---- */
    const CH = {
      pits(e, x, y, L, th, g) {        // two lava pits with a solid island between them
        if (L < 14) return 0; const a = e[0] + 3, b = e[0] + L - 5;
        addRect([a, y, 2, 2, 2, th, g]); addRect([b, y, 2, 2, 2, th, g]); addRect([a + 4, y - 1, L - 14 > 3 ? 3 : 2, 1, 1, th, g]);
        coinRow(a + 0.5, y - 3.4, 3, 1, 0); coin(b + 1, y - 3.4, 1); return 1;
      },
      moat(e, x, y, L, th, g) {        // a stepped hill ringed by lava
        if (L < 16) return 0; const a = e[0] + 3;
        addRect([a, y, 2, 2, 2, th, g]); addRect([a + 2, y - 1, 8, 1, 1, th, g]); addRect([a + 3, y - 2, 6, 1, 1, th, g]); addRect([a + 4, y - 3, 4, 1, 1, th, g]);
        addRect([a + 10, y, 2, 2, 2, th, g]); coinRow(a + 4.5, y - 4.4, 3, 1, 0); coin(a + 6, y - 5.8, 1); return 1;
      },
      padisle(e, x, y, L, th, g) {     // lava between two edges with a bounce pad floating in the middle
        if (L < 18) return 0; const a = e[0] + 3, w = 11;
        addRect([a, y, w, 2, 2, th, g]); addRect([a + 4, y, 3, 1, 6, th, g]);
        coin(a + 5.5, y - 3.4, 0); coin(a + 5.5, y - 5.4, 0); coin(a + 5.5, y - 7.8, 1); return 1;
      },
      stones(e, x, y, L, th, g) {      // a long lava pool crossed on floating stones
        if (L < 16) return 0; const a = e[0] + 3, w = 10;
        addRect([a, y, w, 2, 2, th, g]); addRect([a + 2, y - 1, 2, 1, 1, th, g]); addRect([a + 6, y - 1, 2, 1, 1, th, g]); coinRow(a + 2.5, y - 3, 2, 4, 0); return 1;
      },
      crates(e, x, y, L, th, g) {      // two walls of crates to shove through, coins between
        if (L < 11) return 0; const a = e[0] + 3;
        crateColumn(a, y, bri(3, 4)); crateColumn(a + 4.6, y, bri(3, 4)); coinRow(a + 1.8, y - 1.2, 3, 1, 0); if (L >= 17) { crateColumn(a + 9.3, y, 3); } return 1;
      },
      dominoes(e, x, y, L, th, g) {    // a row of crates, set up to topple
        if (L < 10) return 0; const a = e[0] + 2; for (let k = 0; k < Math.min(9, L - 4); k++) props.push([0, a + k * 1.15, y]); coinRow(a + 1, y - 2.6, 4, 1.4, 0); return 1;
      },
      ballpit(e, x, y, L, th, g) {     // a little ball pit with low walls
        if (L < 12) return 0; const a = e[0] + 3, w = 8;
        addRect([a - 1, y - 1, 1, 1, 1, th, g]); addRect([a + w, y - 1, 1, 1, 1, th, g]);
        for (let k = 0; k < w; k++) props.push([4, a + 0.4 + k * 0.95, y]); for (let k = 0; k < w - 1; k++) props.push([4, a + 0.9 + k * 0.95, y - 0.78]);
        coin(a + w / 2, y - 3, 1); return 1;
      },
      ice(e, x, y, L, th, g) {         // a slick ice slab to run across
        if (L < 10) return 0; const a = e[0] + 2, w = Math.min(L - 5, 9);
        addRect([a, y - 1, w, 1, 3, th, g]); coinRow(a + 1, y - 2.4, w - 2, 1, 0); return 1;
      },
      stilts(e, x, y, L, th, g) {      // pillars of growing height to hop up and down
        if (L < 12) return 0; const a = e[0] + 2;
        addRect([a, y - 2, 1, 2, 1, th, g]); addRect([a + 3, y - 3, 1, 3, 1, th, g]); addRect([a + 6, y - 4, 1, 4, 1, th, g]);
        if (L >= 16) { addRect([a + 9, y - 3, 1, 3, 1, th, g]); addRect([a + 12, y - 2, 1, 2, 1, th, g]); }
        coin(a + 0.5, y - 3.4, 0); coin(a + 3.5, y - 4.4, 0); coin(a + 6.5, y - 5.4, 1); return 1;
      },
      teeth(e, x, y, L, th, g) {       // a low ceiling with lava teeth hanging from it: don't jump too high
        if (L < 14) return 0; const a = e[0] + 4, w = L - 8;
        if (!occ.free2(a, y - 9, a + w, y - 6, e.box, null)) return 0;
        occ.add(a, y - 9, a + w, y - 6);
        addRect([a, y - 8, w, 2, 1, th, g]); for (let k = 1; k < w - 1; k += 3) addRect([k + a, y - 6, 1, 1, 2, th, g]);
        coinRow(a + 1.5, y - 1.2, Math.min(5, w >> 1), 1.5, 0); return 1;
      },
      lavabars(e, x, y, L, th, g) {    // lava blocks standing on the floor at different heights: weave between them
        if (L < 12) return 0; const a = e[0] + 3;
        for (let k = 0; k < 3 + (L > 15 ? 1 : 0); k++) { addRect([a + k * 3, y - 1, 1, 1, 2, th, g]); if (k % 2) addRect([a + k * 3, y - 2, 1, 1, 2, th, g]); }
        coinRow(a + 1.5, y - 3.6, 3, 3, 0); return 1;
      },
      jenga(e, x, y, L, th, g) { if (L < 9) return 0; jenga(e[0] + bri(2, L - 5), y, bri(5, 8)); cratePyramid(e[0] + L - 6, y, 3); return 1; }
    };
    const CHF = {   // what each kind of stretch likes
      lavarun: ['pits', 'moat', 'padisle', 'stones', 'lavabars', 'teeth'],
      iceslide: ['ice', 'stilts', 'pits', 'lavabars'],
      arena: ['crates', 'dominoes', 'ballpit', 'teeth', 'moat', 'jenga', 'stilts'],
      plain: ['crates', 'dominoes', 'ice', 'stilts', 'pits', 'jenga', 'ballpit', 'lavabars'],
      zigzag: ['stilts', 'ice'], wild: ['pits', 'moat', 'padisle', 'stones', 'lavabars', 'teeth', 'crates', 'dominoes', 'ballpit', 'ice', 'stilts', 'jenga'], wild2: ['pits', 'moat', 'padisle', 'stones', 'lavabars', 'teeth', 'crates', 'ballpit', 'ice', 'stilts'],
      waterhop: ['stilts', 'dominoes', 'crates'], seesaws: ['dominoes', 'crates'],
      islets: [], stones: [], stairs: ['ice'], drops: ['ice'], wisp: [], perch: [], cloud: []
    };
    function chaos(pw, p) {
      for (let i = 1; i < pw.length - 1; i++) {
        const e = pw[i];
        if (!e[9] || e[4] !== 0 || e[6] || e[10] || e[12] || e[2] < 8 || BR() > p) continue;
        const kinds = CHF[e[13]] || CHF.plain; if (!kinds.length) continue;
        const k = kinds[Math.floor(BR() * kinds.length)];
        if (CH[k](e, e[0], e[1], e[2], e[3], e[5])) e[9] = 0;
      }
    }
    // a bounce pad throws you up to something floating above the platform
    function satellite(e) {
      const L = e[2], y = e[1], th = e[3], g = e[5], kind = BR();
      const px = e[0] + 1;   // the pad sits at the far end of the platform; everything it throws you to hangs over the platform
      const reserve = (x0, y0, x1, y1) => { if (!occ.free2(x0, y0, x1, y1, e.box, null)) return false; occ.add(x0, y0, x1, y1); return true; };
      if (kind < 0.2 && L >= 11) {   // a spring you can push around, and a shelf out of normal jumping reach: bounce on the spring to get up there
        if (!reserve(px - 2, y - 13, px + 13, y - 5)) return false;
        const sx = px + 4, sy = y - 6;
        addRect([sx, sy, 8, 1, 1, th, g]); props.push([5, px + 1, y]);
        jenga(sx + 1, sy, bri(2, 4)); coinRow(sx + 0.5, sy - 1.2, 7, 1, 0); coin(sx + 4, sy - 2.8, 1);
      } else if (kind < 0.35 && L >= 12) {   // a shelf with a pile of toys
        if (!reserve(px - 2, y - 13, px + 12, y - 6)) return false;
        addRect([px, y, 3, 1, 6, th, g]); const sx = px + 3, sy = y - 7;
        addRect([sx, sy, 8, 1, 1, th, g]);
        jenga(sx + 1, sy, bri(3, 5)); props.push([3, sx + 6, sy]); coinRow(sx + 0.5, sy - 3.4, 7, 1, 0); coin(sx + 4, sy - 4.6, 1);
      } else if (kind < 0.62 && L >= 14) {   // two shelves, one above the other, a pad on each
        if (!reserve(px - 2, y - 24, px + 15, y - 6)) return false;
        addRect([px, y, 3, 1, 6, th, g]); const sx = px + 3, sy = y - 7;
        addRect([sx, sy, 6, 1, 1, th, g]); addRect([sx + 1, sy, 3, 1, 6, th, g]);
        const s2x = sx + 4, s2y = sy - 8; addRect([s2x, s2y, 7, 1, 1, th, g]);
        coinRow(s2x + 0.5, s2y - 1.1, 6, 1, 0); coin(s2x + 3.5, s2y - 3, 2); coin(sx + 2.5, sy - 4, 0); coin(sx + 2.5, sy - 5.4, 0);
      } else if (kind < 0.85 && L >= 10) {   // a diagonal trail of stones up and away
        if (!reserve(px - 2, y - 14, px + 22, y - 6)) return false;
        addRect([px, y, 3, 1, 6, th, g]); let sx = px + 3, sy = y - 7;
        for (let k = 0; k < 3; k++) { addRect([sx, sy, 3, 1, 1, th, g]); coin(sx + 1.5, sy - 1.4, 0); sx += 4; sy -= 1; }
        addRect([sx, sy, 5, 1, 1, th, g]); coinRow(sx + 0.5, sy - 1.2, 4, 1, 0); coin(sx + 2.5, sy - 2.6, 1);
      } else if (L >= 12) {   // a hanging shelf with lava on it
        if (!reserve(px - 2, y - 13, px + 14, y - 6)) return false;
        addRect([px, y, 3, 1, 6, th, g]); const sx = px + 4, sy = y - 8;
        addRect([sx, sy, 8, 1, 1, th, g]); addRect([sx + 2, sy - 1, 1, 1, 2, th, g]); addRect([sx + 5, sy - 1, 1, 1, 2, th, g]);
        coin(sx + 1, sy - 1.5, 0); coin(sx + 3.5, sy - 3, 0); coin(sx + 6.5, sy - 1.5, 1);
      } else return false;
      coin(px + 1.5, y - 3.2, 0); coin(px + 1.5, y - 5.2, 0);
      return true;
    }
    function satellites(pw, p) {
      for (let i = 1; i < pw.length - 1; i++) {
        const e = pw[i];
        if (!e[9] || e[4] !== 0 || e[6] || e[10] || e[12] || e[2] < 9 || BR() > p) continue;
        if (satellite(e)) e[9] = 0;
      }
    }
    const lanePw = {};
    function snake(dir0, rSign, nLanes, main) {
      const all = []; let e = startPlat, dir = dir0, r = rSign > 0 ? 0 : -1;
      for (let li = 0; li < nLanes; li++) {
        const L = lane(e, dir, r, main, !main && r === -DNN);
        (lanePw[r] = lanePw[r] || []).push(...L.pw); all.push(...L.pw); e = L.end;
        if (li === nLanes - 1) break;
        const nr = r + rSign, ndir = -dir;
        const cp = connect(e, dir, rSign > 0, nr, main);
        if (!cp) break;
        all.push(...cp); e = cp[cp.length - 1]; dir = ndir; r = nr;
      }
      return { all, end: e, dir };
    }
    const mainDir = d.mirror ? -1 : 1;
    const up = snake(mainDir, 1, UPN, true);
    const dn = snake(-mainDir, -1, DNN, false);
    const mainPath = up.all, decPath = dn.all;
    // the hidden finish: the very end of the climb
    let fin = null;
    for (let back = 0; back < 12 && !fin && back < mainPath.length; back++) {
      const e = mainPath[mainPath.length - 1 - back], lt = laneOf(bandAt(e[0]), UPN - 1);
      for (let att = 0; att < 8 && !fin; att++) {
        const dir = att % 2 ? -(e[11] || 1) : (e[11] || 1);
        const pw = growDir(e, [SEG('right', 3, lt.th, lt)], d.seed + 4000 + att * 11 + back * 3, dir, WHOLE, { fin: true, main: true, kind: 'fin' });
        if (pw && pw.fin) { fin = pw.fin; if (back > 0) mainPath.splice(mainPath.length - back, back); mainPath.push(...pw); }
      }
    }
    if (!fin) { const e = mainPath[mainPath.length - 1]; fin = [e[0], e[1], e[2]]; addRect([e[0], e[1], e[2], 1, 4, e[3], e[5]]); }

    /* ---- shortcuts: ways up that skip most of a lane, so the climb is not one endless zig-zag.
       Each is a tall zig-zag of little shelves with a bounce pad on every one: a pad throws you up to the next shelf, left, right, left..., and the last one
       throws you up through a gap in a higher lane. Some begin in a nook where you push a spring under a hole in the roof first.
       (Nothing on the real route depends on them.) ---- */
    const shortcutList = []; const DBG = { try: 0, D: 0, noC: 0, free: 0 };
    function typeAt(x, y) {   // what is at this tile right now (0 = air)? later rectangles are painted on top of earlier ones
      const l = rIdx.get(Math.floor(x / 16) * 100003 + Math.floor(y / 16)); if (!l) return 0;
      for (let i = l.length - 1; i >= 0; i--) { const r = l[i]; if (x >= r[0] && x < r[0] + r[2] && y >= r[1] && y < r[1] + r[3]) return r[4]; }
      return 0;
    }
    const solidTop = e => typeAt(Math.floor(e[0] + e[2] / 2), e[1]) === 1;
    const airBox = (x0, y0, x1, y1) => { for (let y = Math.floor(y0); y < y1; y++) for (let x = Math.floor(x0); x < x1; x++) if (typeAt(x, y)) return false; return true; };   // nothing at all in this block of tiles
    const floorRun = (x0, x1, y) => { for (let x = Math.floor(x0); x < x1; x++) { const t = typeAt(x, y); if (t !== 1 && t !== 3) return false; } return true; };   // solid ground along here
    function express() {
      // where the real route jumps: a shelf must never hang in the way of a jump (the run-up and the arc, around every gap of the route)
      const occJ = Occ();
      for (let i = 0; i + 1 < mainPath.length; i++) {
        const Q = mainPath[i], Q2 = mainPath[i + 1], gl = Math.min(Q[0] + Q[2], Q2[0] + Q2[2]), gr = Math.max(Q[0], Q2[0]);
        const x0 = gr > gl ? gl - 2.6 : Math.min(Q[0], Q2[0]) - 1, x1 = gr > gl ? gr + 2.6 : Math.max(Q[0] + Q[2], Q2[0] + Q2[2]) + 1;
        occJ.add(x0, Math.min(Q[1], Q2[1]) - 6.8, x1, Math.max(Q[1], Q2[1]) + 1.5);
      }
      function tryLadder(A, B, N, dd, kind) {
        const fx = (x, w) => dd > 0 ? x : -(x + w);   // build as if climbing towards +x; this turns it back into real tiles
        const gl = Math.min(B[0] + B[2], N[0] + N[2]), gr = Math.max(B[0], N[0]);   // the gap between the two platforms, in real tiles
        const T = B[1] <= N[1] ? B : N, Ay = A[1], Ty = T[1], D = Ay - Ty, sp = kind === 'spring';
        const A0 = dd > 0 ? A[0] : -(A[0] + A[2]), A1 = A0 + A[2], G0 = dd > 0 ? gl : -gr, G1 = dd > 0 ? gr : -gl;
        DBG.try++;
        if (D < 13 || D > 52 || G1 - G0 < 3) { DBG.D++; return false; }
        const n = Math.ceil(D / 6), m = n - 1;
        const rises = []; let rem = D;
        if (sp) { rises.push(6); rem -= 6; }
        for (let k = rises.length; k < n; k++) { const r = Math.ceil(rem / (n - k)); rises.push(r); rem -= r; }
        if (rises.some(r => r < 3 || r > 6)) return false;
        const lead = sp ? 4 : 3, need = sp ? 12 : 9;            // the pad (or the nook) on A, then the first shelf above A
        const opts = [];
        for (let a = A0 + 1; a + (sp ? need : 3) <= A1; a++) {
          for (let off = 0; off <= G1 - G0 - 3; off++) {
            const px = G0 + off, tot = (px - 3) - (a + lead);   // the shelves between the first one and the top one
            const minW = sp ? 8 + 6 * (m - 2) : 6 * (m - 1), maxW = sp ? 8 + 10 * (m - 2) : 10 * (m - 1);
            if (m === 1 ? tot === 0 : (tot >= minW && tot <= maxW)) opts.push([a, px, tot]);
          }
        }
        if (!opts.length) { DBG.noC++; return false; }
        for (let tries = 0; tries < 4 && opts.length; tries++) {
          const oi = Math.floor(BR() * opts.length), [a, px, tot] = opts.splice(oi, 1)[0];
          const ws = []; for (let k = 0; k < m - 1; k++) ws.push(sp && k === 0 ? 8 : 6);
          let extra = tot - ws.reduce((x, y) => x + y, 0);
          for (let guard = 0; extra > 0 && guard < 300; guard++) { const k = Math.floor(BR() * ws.length); if (ws[k] < 10 && !(sp && k === 0)) { ws[k]++; extra--; } }
          if (extra !== 0) continue;
          const shelves = []; let sx = a + lead, y = Ay;
          for (let k = 0; k < m - 1; k++) { y -= rises[k]; shelves.push({ x: sx, w: ws[k], y }); sx += ws[k]; }
          y -= rises[m - 1]; shelves.push({ x: px - 3, w: 6, y });       // the top shelf sits right under the gap
          const exs = [A.box, B.box, N.box];
          const free = (x0, y0, x1, y1) => { const r0 = fx(x0, x1 - x0); return occ.freeX(r0, y0, r0 + (x1 - x0), y1, exs); };
          let ok = true;
          if (sp && !free(a - 1, Ay - 9, a + 13, Ay + 1)) ok = false;
          if (ok && !sp && !free(a - 1, Ay - rises[0], a + 3, Ay)) ok = false;
          for (let k = 0; k < m && ok; k++) {
            const P = shelves[k]; if (!free(P.x - 1, P.y - 8, P.x + P.w + 1, P.y + 2)) ok = false;
            else { const q = fx(P.x, P.w); if (!occJ.free(q, P.y, q + P.w, P.y + 2)) ok = false; }
            if (ok && k > 0 && k < m - 1) { const P0 = shelves[k - 1]; if (!free(P.x - 4, P.y, P.x + 1, P0.y)) ok = false; }   // (the climb of each bounce)
          }
          if (ok && sp) { const q = fx(a, 12); if (!occJ.free(q, Ay - 6, q + 12, Ay)) ok = false; }
          if (ok && !free(px, Ty - 8, px + 3, shelves[m - 1].y)) ok = false;
          if (!ok) { DBG.free++; continue; }
          // the ground must really be plain ground and the air really empty (a lava pit or a stray block would spoil it)
          const real = (x0, x1) => { const q = fx(x0, x1 - x0); return [q, q + (x1 - x0)]; };
          let okT = solidTop(B) && solidTop(N);
          if (okT) { const [a0, a1] = sp ? real(a, a + 12) : real(a, a + 3); okT = floorRun(a0, a1, Ay) && airBox(a0, Ay - (sp ? 6 : 3), a1, Ay); }
          for (let k = 0; k < m && okT; k++) {
            const P = shelves[k], [q0, q1] = real(P.x - 1, P.x + P.w + 1), low = k === m - 1 ? Math.max(B[1] + B[7], N[1] + N[7]) + 1 : P.y - 8;
            if (P.y - 1 < low) okT = false; else okT = airBox(q0, low, q1, P.y + 3);
          }
          if (!okT) { DBG.typ = (DBG.typ || 0) + 1; continue; }
          // build it
          const thA = A[3], gA = A[5], thB = T[3], gB = T[5];
          const Rc = (x, yy, w, h, t, k) => addRect([fx(x, w), yy, w, h, t, k < m / 2 ? thA : thB, k < m / 2 ? gA : gB]);
          const hops = [];
          if (sp) {
            Rc(a, Ay - 6, 1, 6, 1, 0); Rc(a + 11, Ay - 1, 1, 1, 1, 0);   // the back wall of the nook, and a low lip so the spring cannot roll away
            props.push([5, fx(a + 7, 1), Ay]);
            const bx = fx(a - 1, 14); occ.add(bx, Ay - 9, bx + 14, Ay + 1);
          } else {
            Rc(a, Ay, 3, 1, 6, 0);
            coin(fx(a + 1.5, 0), Ay - 3.4, 0); coin(fx(a + 1.5, 0), Ay - 5.2, 0);
            hops.push({ px: fx(a + 1.5, 0), py: Ay, ty: shelves[0].y });
          }
          shelves.forEach((P, k) => {
            Rc(P.x, P.y, P.w, 2, 1, k);
            const padx = P.x + P.w - 3; Rc(padx, P.y, 3, 1, 6, k);
            const bx = fx(P.x, P.w); occ.add(bx - 1, P.y - 8, bx + P.w + 1, P.y + 3); occB.add(bx - 1, P.y - 1, bx + P.w + 1, P.y + 3);
            const pc = fx(padx + 1.5, 0);
            coin(pc, P.y - 3.4, 0); coin(pc, P.y - 5.2, k === m - 1 ? 1 : 0); coin(fx(P.x + 1.5, 0), P.y - 1.2, 0);
            hops.push({ px: pc, py: P.y, ty: k + 1 < m ? shelves[k + 1].y : Ty });
          });
          const roof = sp ? shelves[0] : null;
          shortcutList.push({ kind, hops: m + 1, ax: A[0], ay: Ay, tx: T[0], tw: T[2], ty: Ty, c: fx(a, 0), dd, pads: hops, spring: sp ? [fx(a + 7, 1), Ay] : null,
            shelves: shelves.map(P => [fx(P.x, P.w), P.y, P.w, 0]), gap: [gl, gr] });
          A[9] = 0; B[9] = 0; N[9] = 0;
          return true;
        }
        return false;
      }
      for (let r = 0; r < UPN - 1; r++) {
        const LA = (lanePw[r] || []).filter(e => e[4] === 0 && !e[12] && e[2] >= 14 && e[9] === 1);
        for (let i = LA.length - 1; i > 0; i--) { const j = Math.floor(BR() * (i + 1)); const t = LA[i]; LA[i] = LA[j]; LA[j] = t; }
        const done = []; let made = 0;
        for (let t = 0; t < LA.length && made < 16; t++) {
          const A = LA[t]; let near = false;
          for (const x of done) if (Math.abs(x - A[0]) < 22) { near = true; break; }
          if (near) continue;
          const skip2 = r + 2 < UPN && BR() < 0.3, LB = lanePw[skip2 ? r + 2 : r + 1] || [], cand = [];
          for (let i = 0; i + 1 < LB.length; i++) { const B = LB[i], N = LB[i + 1]; if (B[4] !== 0 || N[4] !== 0 || B[12] || N[12] || B[8] || N[8]) continue; if (Math.abs(B[0] - A[0]) < 40) cand.push([B, N]); }
          for (let i = cand.length - 1; i > 0; i--) { const j = Math.floor(BR() * (i + 1)); const t2 = cand[i]; cand[i] = cand[j]; cand[j] = t2; }
          let ok = false;
          for (let bi = 0; bi < cand.length && !ok; bi++) {
            const [B, N] = cand[bi], kind = BR() < 0.4 ? 'spring' : 'ladder', other = kind === 'spring' ? 'ladder' : 'spring';
            ok = tryLadder(A, B, N, 1, kind) || tryLadder(A, B, N, -1, kind) || tryLadder(A, B, N, 1, other) || tryLadder(A, B, N, -1, other);
          }
          if (ok) { made++; done.push(A[0]); }
        }
      }
    }
    express(); if (typeof process !== 'undefined' && process.env.MAPDBG) console.log('express', JSON.stringify(DBG), shortcutList.length);
    const cps = [];
    // flags are spread evenly over the whole map (ground, middle and sky alike): pick calm platforms at random, but never two close together
    {
      const cand = [];
      for (const pw of [mainPath, decPath, gruns]) for (const e of pw) if (e[2] >= 7 && e[9] === 1 && e[4] === 0 && !e[6] && !e[12]) cand.push({ x: Math.floor(e[0] + e[2] / 2), y: e[1], e });
      for (const q of ugCps) cand.push({ x: q[0], y: q[1], ug: q });
      for (let i = cand.length - 1; i > 0; i--) { const j = Math.floor(BR() * (i + 1)); const t = cand[i]; cand[i] = cand[j]; cand[j] = t; }
      const got = [];
      for (const c of cand) {
        let ok = true;
        for (const g of got) { const dx = (c.x - g.x) / 64, dy = (c.y - g.y) / 34; if (dx * dx + dy * dy < 1) { ok = false; break; } }
        if (!ok) continue;
        got.push(c); cps.push([c.x, c.y]); if (c.e) c.e[9] = 0;
      }
    }
    satellites(decPath, 0.4); satellites(mainPath, 0.35); satellites(gruns, 0.3);
    chaos(decPath, 1); chaos(mainPath, 0.95); chaos(gruns, 0.6);
    addStructures(decPath);   // (the real route stays plain so it is always fair)
    // crate gates on the real route: a tall door that only opens while something heavy sits on the plate. Three crates are provided; waste them and you are stuck.
    function gates(pw, p, any) {
      for (let i = 0; i < pw.length - 1; i++) {
        const e = pw[i];
        if ((!e[10] && !any) || e[4] !== 0 || (e[6] && !any) || e[2] < 11 || !e[9] || BR() > p) continue;
        const L = e[2], hd = e[11] || mainDir, X = o => (hd > 0 ? e[0] + o : e[0] + L - 1 - o), id = gad.doors.length, k = BR();
        gad.doors.push([X(9), e[1] - 7, 1, 7]);
        if (k < 0.45) {   // crates on the plate hold it open: three are provided, waste them and you are stuck
          gad.plates.push([Math.min(X(5), X(6)), e[1], 2, [id]]);
          props.push([0, X(1), e[1]]); props.push([0, X(2), e[1]]); props.push([0, X(3), e[1]]);
          coinRow(Math.min(X(5), X(6)) + 0.5, e[1] - 1.2, 2, 1, 0);
        } else if (k < 0.8) {   // a button on a little ledge at the back: roll over it and the gate stays open
          gad.btns.push([X(4), e[1] - 3, [id]]); decor.push([1, X(4), e[1] - 3]);
          addRect([Math.min(X(3), X(5)), e[1] - 3, 3, 1, 1, e[3], e[5]]); addRect([Math.min(X(1), X(2)), e[1] - 2, 2, 1, 1, e[3], e[5]]);
          coinRow(X(4) - 1, e[1] - 5, 3, 1, 0);
        } else {   // a plain button on the floor, with a tower of blocks to knock down for the coins behind it
          gad.btns.push([X(4), e[1], [id]]); decor.push([1, X(4), e[1]]);
          jenga(Math.min(X(1), X(2)), e[1], bri(4, 6));
        }
        decor.push([2, X(9), e[1]]); e[9] = 0;
      }
    }
    gates(mainPath, 0.9); gates(decPath, 0.8);
    gates(mainPath, 0.55, true); gates(decPath, 0.75, true);
    addStructures(mainPath, d.mainStruct === undefined ? 0.28 : d.mainStruct);
    // bounce pads on the side route and the ground: a hop up to a little trail of coins
    function padFun(pw, p) {
      for (const e of pw) {
        if (!e[9] || e[4] !== 0 || e[6] || e[2] < 8 || BR() > p) continue;
        const x = e[0] + bri(2, e[2] - 5);
        addRect([x, e[1], 2, 1, 6, e[3], e[5]]);
        coin(x + 1, e[1] - 3.2, 0); coin(x + 1, e[1] - 5.2, 0); coin(x + 1, e[1] - 7.5, 1);
        e[9] = 0;
      }
    }
    padFun(decPath, 0.3); padFun(gruns, 0.22);
    // checkpoint flags: one on a calm platform every so often. Touch one and your next fall brings you back to it (once).
    skyDistricts(mainPath); skyDistricts(decPath);
    satellites(mainPath, 0.5); satellites(decPath, 0.55); satellites(gruns, 0.3);
    addProps(mainPath, 0.9); addProps(decPath, 0.95);
    addCoins(mainPath, 0.62); addCoins(decPath, 0.55);
    for (let i = 0; i < 9; i++) coin(fin[0] + 2 + i * (fin[2] - 4) / 8, fin[1] - 1.5 - Math.sin(i / 8 * Math.PI) * 1.5, i === 4 ? 2 : 1);
    addCeilings(mainPath); addCeilings(decPath);
    addLavaSea(mainPath); addLavaSea(decPath);
    // a bounce pad on a wide platform throws you up to a ledge, and a little tower of ledges climbs on from there, ending in a room
    function towerUp(A) {
      if (A[4] !== 0 || A[2] < 9 || !A[9] || A[6]) return false;
      const px = A[0] + 1, sx = px + 3, sy = A[1] - 6;
      if (!occ.free2(sx - 1, sy - 6, sx + 7, sy + 4, A.box, null)) return false;
      const th = A[3], cand = UNDER[THEMES[th].id] || ['cave'], nth = cand[Math.floor(BR() * cand.length)], ice = (nth === 'snow' || nth === 'icecave') ? 0.35 : 0.08;
      const V = [sx, sy, 6, th, 0, A[5], 0, 2, 0, 0, 0];
      let pw = null; const sd = bri(1, 99999);
      for (const dd of ((sd & 1) ? [1, -1] : [-1, 1])) { pw = growDir(V, [SEG('up', bri(3, 6), nth, { ice, cave: 0 })], sd + (dd > 0 ? 0 : 99), dd, WHOLE, { ex: [A.box, null], kind: 'tw' }); if (pw && pw.length >= 3) break; pw = null; }
      if (!pw) return false;
      A[9] = 0; branchCount++;
      occ.add(sx - 1, sy - 6, sx + 7, sy + 4); occB.add(sx - 1, sy - 1, sx + 7, sy + 3);
      addRect([px, A[1], 3, 1, 6, th, A[5]]); addRect([sx, sy, 6, 2, 1, th, A[5]]); addRect([sx + 1, sy + 2, 4, 1, 1, th, A[5]]);
      coin(px + 1.5, A[1] - 3.2, 0); coin(px + 1.5, A[1] - 4.6, 0); coinRow(sx + 0.5, sy - 1.1, 5, 1, 0);
      addStructures(pw); addProps(pw, 0.4); addCoins(pw, 0.8);
      const c1 = [A, V].concat(pw); c1.k = 'tw'; chains.push(c1);
      room(pw[pw.length - 1], pw);
      return true;
    }
    function towers(pw, prob) { for (const e of pw) if (e[2] >= 9 && e[4] === 0 && BR() < prob && branchCount < MAXB) towerUp(e); }
    branches(mainPath, 0); branches(decPath, 0); branches(gruns, 1);
    towers(mainPath, 0.95); towers(decPath, 0.95); towers(gruns, 0.5);

    const path = [mainPath.length && mainPath[0][0] + mainPath[0][2] / 2 < SW / 2 ? [0, 0, 9] : [SW - 9, 0, 9]].concat(mainPath.map(e => [e[0], e[1], e[2], e[12] || 0]));

    let minX = 1e9, minY = 1e9, maxX = -1e9, maxY = -1e9;
    for (const r of rects) {
      minX = Math.min(minX, r[0]); minY = Math.min(minY, r[1]);
      maxX = Math.max(maxX, r[0] + r[2]); maxY = Math.max(maxY, r[1] + r[3]);
    }
    const ox = 3 - minX, oy = 14 - minY;
    for (const r of rects) { r[0] += ox; r[1] += oy; }
    for (const q of path) { q[0] += ox; q[1] += oy; }
    const chainsOut = chains.map(c => { const o = c.map(e => [e[0] + ox, e[1] + oy, e[2]]); o.k = c.k; return o; });
    fin[0] += ox; fin[1] += oy;
    for (const q of props) { q[1] += ox; q[2] += oy; }
    for (const q of coins) { q[0] += ox; q[1] += oy; }
    for (const q of decor) { q[1] += ox; q[2] += oy; }
    for (const q of gad.doors) { q[0] += ox; q[1] += oy; }
    for (const q of gad.plates) { q[0] += ox; q[1] += oy; }
    for (const q of gad.btns) { q[0] += ox; q[1] += oy; }
    for (const q of gad.see) { q[0] += ox; q[1] += oy; }
    for (const q of cps) { q[0] += ox; q[1] += oy; }
    for (const sc of shortcutList) {   // (for the tests: where each bounce pad is and where it should land)
      sc.ax += ox; sc.ay += oy; sc.tx += ox; sc.ty += oy; sc.c += ox; sc.gap = [sc.gap[0] + ox, sc.gap[1] + ox];
      sc.pads = sc.pads.map(h => ({ px: h.px + ox, py: h.py + oy, ty: h.ty + oy })); sc.shelves = sc.shelves.map(q => [q[0] + ox, q[1] + oy, q[2], q[3]]); if (sc.spring) sc.spring = [sc.spring[0] + ox, sc.spring[1] + oy];
    }
    for (const q of ugStats.list) { q[0] += ox; q[1] += oy; q[2] += oy; q[3] += oy; for (const l of q[4]) { l[0] += ox; l[1] += oy; } }

    // background regions (drawn in order, so later ones sit on top)
    // side branches and the decoy are painted first; the real route and the start area on top, so the spawn always looks like its own region
    const isMain = k => k === startGid || mainSet.has(k);
    const zones = Object.keys(gz).map(Number).sort((a, b) => (isMain(a) - isMain(b)) || (a - b)).map(k => {
      const z = gz[k]; return [z[0] + ox - 7, z[1] + oy - 7, z[2] + ox + 7, z[3] + oy + 7, z[4]];
    });

    const W = maxX + ox + 3;
    const maxBottom = maxY + oy;
    const H = maxBottom + 18;
    // keep coins out of solid ground, and out of the doors' way
    const gridT = new Uint8Array(W * H);
    for (const r of rects) for (let yy = r[1]; yy < r[1] + r[3]; yy++) { if (yy < 0 || yy >= H) continue; for (let xx = r[0]; xx < r[0] + r[2]; xx++) if (xx >= 0 && xx < W) gridT[yy * W + xx] = r[4]; }
    let map_cleaned = 0;

    /* ---- final clean-up: nothing may be buried in the ground, hang in mid-air, or be impossible to use ---- */
    const SOLT = t => t === 1 || t === 3 || t === 4 || t === 6;
    const gt = (x, y) => (x < 0 || x >= W || y < 0 || y >= H) ? 0 : gridT[y * W + x];
    const gtn = (x, y) => (x < 0 || x >= W || y < 0 || y >= H) ? 1 : gridT[y * W + x];
    let cleaned = 0;
    {
      // crates, boxes and balls: not inside solid or lava, and not hanging with nothing under them (a stack counts as support)
      const dims = k => (k === 0 || k === 5 ? [0.45, 0.9] : k === 1 ? [0.9, 1.8] : k === 2 ? [0.4, 0.8] : k === 3 ? [0.85, 1.7] : [0.35, 0.7]);
      const order = props.slice().sort((a, b) => b[2] - a[2]), good = [];
      for (const q of order) {
        const [k, x, y0] = q, [hw, hh] = dims(k), cx = x + 0.5;
        let y = y0, bad = false;
        for (let tx = Math.floor(cx - hw + 0.08); tx <= Math.floor(cx + hw - 0.08) && !bad; tx++) for (let ty = Math.floor(y - hh + 0.1); ty <= Math.floor(y - 0.1); ty++) { const t = gt(tx, ty); if (SOLT(t) || t === 2) { bad = true; break; } }
        if (!bad) {
          // find what it comes to rest on: floor under its centre, or the top of a crate beneath it. Then sit exactly on it, so nothing drops or tips at the start.
          let best = null;
          for (let dy = 0; dy < 6; dy++) { const row = Math.floor(y + 0.12) + dy; if (SOLT(gt(Math.floor(cx), row))) { best = row; break; } if (gt(Math.floor(cx), row) === 2) break; }
          for (const o of good) { const [hw2, hh2] = dims(o[0]), top = o[2] - hh2; if (Math.abs(o[1] - x) < hw2 + 0.02 && top >= y - 0.45 && top <= y + 6 && (best === null || top < best)) best = top; }
          if (best === null) bad = true;
          else if (gad.doors.some(dd => x + 0.5 + hw > dd[0] + 0.02 && x + 0.5 - hw < dd[0] + dd[2] - 0.02 && best > dd[1] && best - hh < dd[1] + dd[3]) ||
                   gad.btns.some(bb => x + 0.5 + hw > bb[0] && x + 0.5 - hw < bb[0] + 1 && Math.abs(best - bb[1]) < 0.3)) bad = true;   // not inside a gate, and not hiding a button
          else {
            q[2] = best;
            for (const o of good) { const [hw2, hh2] = dims(o[0]); if (Math.abs(o[1] - x) < hw + hw2 - 0.06 && Math.abs((o[2] - hh2 / 2) - (best - hh / 2)) < (hh + hh2) / 2 - 0.06) { bad = true; break; } }   // two things never share the same space
          }
        }
        if (bad) cleaned++; else good.push(q);
      }
      const gs = new Set(good), kept = props.filter(q => gs.has(q));
      props.length = 0; for (const q of kept) props.push(q);
    }
    {
      // doors must stand on something and be free of solid; each needs at least one working button or plate
      const okCtl = (x, y, w) => { for (let tx = x; tx < x + w; tx++) { if (!SOLT(gt(tx, y))) return false; if (SOLT(gt(tx, y - 1)) || SOLT(gt(tx, y - 2))) return false; } return true; };
      const doors = gad.doors, plates = gad.plates.filter(q => okCtl(q[0], q[1], q[2])), btns = gad.btns.filter(q => okCtl(q[0], q[1], 1));
      cleaned += (gad.plates.length - plates.length) + (gad.btns.length - btns.length);
      const has = new Set(); plates.forEach(q => q[3].forEach(i => has.add(i))); btns.forEach(q => q[2].forEach(i => has.add(i)));
      const map2 = new Map(), nd = [];
      doors.forEach((d, i) => {
        let buried = false, floor = true;
        for (let tx = d[0]; tx < d[0] + d[2]; tx++) { for (let ty = d[1]; ty < d[1] + d[3]; ty++) if (SOLT(gt(tx, ty))) buried = true; if (!SOLT(gt(tx, d[1] + d[3]))) floor = false; }
        if (buried || !floor || !has.has(i)) { cleaned++; return; }
        map2.set(i, nd.length); nd.push(d);
      });
      const remap = a => a.map(i => map2.get(i)).filter(i => i !== undefined);
      gad.doors.length = 0; nd.forEach(d => gad.doors.push(d));
      gad.plates.length = 0; plates.forEach(q => { const r = remap(q[3]); if (r.length) { q[3] = r; gad.plates.push(q); } else cleaned++; });
      gad.btns.length = 0; btns.forEach(q => { const r = remap(q[2]); if (r.length) { q[2] = r; gad.btns.push(q); } else cleaned++; });
      // door frames and button pictures follow what is left
      const dk = new Set(gad.doors.map(d => d[0] + ',' + (d[1] + d[3]))), bk = new Set(gad.btns.map(q => q[0] + ',' + q[1]));
      const dc = decor.filter(q => q[0] === 2 ? dk.has(q[1] + ',' + q[2]) : q[0] === 1 ? bk.has(q[1] + ',' + q[2]) : true);
      decor.length = 0; dc.forEach(q => decor.push(q));
    }
    {
      // checkpoint flags: on something solid with open air above. Slide one sideways if it is not; drop it if nothing fits.
      const okCp = (x, y) => SOLT(gt(x, y)) && !SOLT(gt(x, y - 1)) && !SOLT(gt(x, y - 2)) && !SOLT(gt(x, y - 3)) && gt(x, y) !== 2 && gt(x, y - 1) !== 2;
      for (let i = cps.length - 1; i >= 0; i--) {
        const q = cps[i]; if (okCp(q[0], q[1])) continue;
        let fx = null; for (let d = 1; d <= 10 && fx === null; d++) for (const sx of [q[0] + d, q[0] - d]) if (okCp(sx, q[1])) { fx = sx; break; }
        if (fx === null) { cps.splice(i, 1); cleaned++; } else q[0] = fx;
      }
    }
    for (const r of rects) {   // a bounce pad needs clear air above it
      if (r[4] !== 6) continue; let cov = 0;
      for (let tx = r[0]; tx < r[0] + r[2]; tx++) for (let k = 1; k <= 2; k++) if (SOLT(gt(tx, r[1] - k))) cov++;
      if (cov) { r[4] = 1; cleaned++; }
    }
    map_cleaned = cleaned;

    const coinsOut = [], seen = new Set();
    for (const q of coins) {
      const tx = Math.floor(q[0]), ty = Math.floor(q[1]); if (tx < 0 || tx >= W || ty < 0 || ty >= H) continue;
      const t = gridT[ty * W + tx]; if (t === 1 || t === 3 || t === 4 || t === 6) continue;
      const key = Math.round(q[0] * 2) * 100003 + Math.round(q[1] * 2); if (seen.has(key)) continue; seen.add(key);
      coinsOut.push([Math.round((q[0]) * TS), Math.round(q[1] * TS), q[2]]);
    }
    coinsOut.sort((a, b) => a[0] - b[0]);
    // the ground is solid all the way down, so the kill line just sits under the world
    const floorY = new Int16Array(W).fill(maxBottom + 6);

    const map = {
      idx, name: d.name, bg: '#0c0c16',
      TS, W, H, rects, path, zones, props, coins: coinsOut, gadgets: gad, decor, floorY,
      checkpoints: cps, shortcuts: shortcutList, ug: ugStats, cleaned: map_cleaned,
      start: [(ox + 1.5) * TS, oy * TS - R - 1],   // the one community spawn point
      finish: fin,
      flag: [fin[0] + fin[2] / 2, fin[1]],
      killY: (maxBottom + 6) * TS, chains: chainsOut
    };
    cache[idx] = map; cacheOrder.push(idx);
    while (cacheOrder.length > 3) delete cache[cacheOrder.shift()];   // (50 big maps would add up: only the latest few are kept)
    return map;
  }

  const api = { TS, R, count: DEFS.length, names: DEFS.map(d => d.name), themes: THEMES, generate };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.BallMaps = api;
})(typeof window !== 'undefined' ? window : globalThis);

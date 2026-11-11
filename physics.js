/* Shared ball physics (browser + Node, so maps can be bot-tested). */
(function (root) {
  'use strict';
  const TS = 40, R = 14;
  const GRAV = 1900, JUMP = 900, MAXV = 270, MAXFALL = 950, BOUNCE = 1080, BOUNCE_HELD = 1300, FALL_WARN = 1.6, FALL_DIE = 2.8;   // jump is ~210px high (about 5 tiles)
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const approach = (a, t, d) => (a < t ? Math.min(a + d, t) : Math.max(a - d, t));

  function hash32(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }   // (a stable name for a thing, the same on every device and on the server)
  function makeWorld(map) {
    const W = map.W, H = map.H, grid = new Uint8Array(W * H);
    for (const r of map.rects) {
      for (let yy = r[1]; yy < r[1] + r[3]; yy++) {
        if (yy < 0 || yy >= H) continue;
        for (let xx = r[0]; xx < r[0] + r[2]; xx++) if (xx >= 0 && xx < W) grid[yy * W + xx] = r[4];
      }
    }
    const w = { W, H, grid, map, dyn: [], dynBy: new Map(), follow: false, doors: [], plates: [], btns: [], see: [], pads: [], portals: [], ropes: [], ev: [], focus: null };
    const G = map.gadgets || {};
    (G.doors || []).forEach((d, i) => { const o = { id: i, uid: hash32('d' + i), x: d[0], y: d[1], w: d[2], h: d[3], open: false, latched: false }; w.doors.push(o); setDoorTiles(w, o, false); });
    (G.plates || []).forEach(p => w.plates.push({ x: p[0], y: p[1], w: p[2], to: p[3], on: false }));
    (G.btns || []).forEach(p => w.btns.push({ x: p[0], y: p[1], to: p[2], on: false }));
    (G.see || []).forEach(p => w.see.push({ cx: p[0] * TS, cy: p[1] * TS, hl: p[2] * TS, tilt: p[3], ang: p[3], av: 0, tq: 0, uid: hash32('s' + Math.round(p[0] * TS) + ',' + Math.round(p[1] * TS)) }));
    const nb = noBuild(map), box = p => { const q = propDims(p[0]), h = q.half, x = (p[1] + 0.5) * TS, y = p[2] * TS - h - 0.5; return [x - h, y - h, x + h, y + h]; };
    const PB = (map.props || []).map(box), cut = PB.map(b => nb.some(z => b[2] > z.tx0 * TS && b[0] < (z.tx1 + 1) * TS && b[3] > z.ty0 * TS && b[1] < (z.ty1 + 1) * TS));
    for (let more = true; more;) { more = false; for (let i = 0; i < PB.length; i++) if (!cut[i]) for (let j = 0; j < PB.length; j++) if (cut[j] && PB[i][2] > PB[j][0] + 2 && PB[i][0] < PB[j][2] - 2 && Math.abs(PB[i][3] - PB[j][1]) < 6) { cut[i] = more = true; break; } }   // (nothing of the map's own starts in the start zone or by the finish flag, nor anything stacked on such a thing)
    (map.props || []).forEach((p, i) => { if (cut[i]) return; const d = addProp(w, p[0], (p[1] + 0.5) * TS, p[2] * TS - propDims(p[0]).half - 0.5); d.nap = true; d.m0 = true; });   /* (the map's own things start out at rest: each one checks it is held up once somebody comes near) */   // pushable yellow things; each player has their own copy (never shared)
    natRopes(w, map);
    return w;
  }

  function setDoorTiles(w, d, open) {   // the top row (the beam) is always solid, so a crate or ball can stand on a gate whether it is open or shut
    d.open = open;
    for (let yy = d.y; yy < d.y + d.h; yy++) for (let xx = d.x; xx < d.x + d.w; xx++) if (xx >= 0 && xx < w.W && yy >= 0 && yy < w.H) w.grid[yy * w.W + xx] = open && yy > d.y ? 0 : 9;
  }
  const killYAt = (w, x) => { const f = w.map.floorY; return f ? f[clamp(Math.floor(x / TS), 0, w.W - 1)] * TS : w.map.killY; };

  function tile(w, tx, ty) {
    if (tx < 0 || tx >= w.W || ty < 0) return 1;      // the world is a closed box: solid walls on both sides and a solid ceiling (only the bottom is open, and it kills)
    if (ty >= w.H) return 0;
    return w.grid[ty * w.W + tx];
  }

  function newBody(x, y) {
    return { x, y, vx: 0, vy: 0, hold: 0, hdir: 0, bcharge: 0, jm: 0, jmt: 0, noJm: true, boost: false, bdir: 0, btime: 0, bReq: false, bAuto: false, fall: 0, rot: 0, ground: false, flat: false, gType: 0, coyote: 0, jbuf: 0, water: false, swimCool: 0, holdLeft: 0 };
  }

  // Circle vs. square tiles. Because the ball is round, standing on an edge with your
  // centre past it pushes you off along a diagonal, so you roll/slide off the corner.
  function collide(b, w) {
    b.ground = false; b.flat = false; b.gType = 0;
    let lava = false;
    const tx0 = Math.floor((b.x - R) / TS), tx1 = Math.floor((b.x + R) / TS);
    const ty0 = Math.floor((b.y - R) / TS), ty1 = Math.floor((b.y + R) / TS);
    for (let ty = ty0; ty <= ty1; ty++) {
      for (let tx = tx0; tx <= tx1; tx++) {
        const t = tile(w, tx, ty);
        if (!t || t === 5 || (t === 9 && b.ghost)) continue;
        const left = tx * TS, top = ty * TS;
        const cx = clamp(b.x, left, left + TS), cy = clamp(b.y, top, top + TS);
        const dx = b.x - cx, dy = b.y - cy, d2 = dx * dx + dy * dy;
        if (t === 2) { if (d2 < (R - 3) * (R - 3)) lava = true; continue; }
        if (d2 >= R * R) continue;
        if (dx !== 0 && dy !== 0) {   // the ball is only touching this tile's corner: if a neighbour tile hides that corner, it is an inner seam (a ghost bump), so ignore it
          const sx = dx > 0 ? 1 : -1, sy = dy > 0 ? 1 : -1;
          if (isSol(tile(w, tx + sx, ty)) || isSol(tile(w, tx, ty + sy))) continue;
        }
        if (d2 === 0) { b.y = top - R; if (b.vy > 0) b.vy = 0; b.ground = true; b.flat = true; b.gType = t; if (t === 6) b.bnc = true; continue; }
        const d = Math.sqrt(d2), nx = dx / d, ny = dy / d, pen = R - d;
        b.x += nx * pen; b.y += ny * pen;
        const vn = b.vx * nx + b.vy * ny;
        if (vn < 0) { b.vx -= vn * nx; b.vy -= vn * ny; }
        if (ny < -0.5) {
          b.ground = true; if (t === 6) b.bnc = true;
          if (dx === 0) { b.flat = true; b.gType = t; }       // centre is over the tile: real footing
          else if (!b.flat) b.gType = t;                      // only touching its corner: no grip
        }
      }
    }
    return lava;
  }


  /* ---------- pushable objects (yellow crates and balls) ---------- */
  /* ---------- pushable things: kinds 0 small crate, 1 big crate, 2 / 3 / 4 / 7 balls, 5 spring, 6 super spring (bought in the shop) ---------- */
  function propDims(kind) {
    const hw = kind === 0 || kind === 5 || kind === 6 ? 18 : kind === 1 ? 36 : 0, r = kind === 2 ? 16 : kind === 3 ? 34 : kind === 4 ? 14 : kind === 7 ? 9 : 0;
    return { hw, r, half: r || hw };
  }
  function addProp(w, kind, x, y) {   // x, y: the centre
    const q = propDims(kind), hw = q.hw, r = q.r;
    const d = { k: r ? 'o' : 'b', x, y, hw, hh: hw, r, vx: 0, vy: 0, rot: 0, av: 0, gr: false, touch: false, burn: 0, st: 0,
      m: r ? (r * r) / 256 : (4 * hw * hw) / 1296, kind,
      // (everything the physics keeps on a thing is there from the start, so every crate and ball has the same make-up and the sums over hundreds of them stay fast)
      im: 0, ii: 0, nap: false, sleep: false, skip: false, sq: 0, _i: 0, _dyn: false, _far: false, farT: 0, _spr: 0, _im: 0, _ii: 0, _bx: 0, _by: 0, _bw: 0, _pl: false, _x0: 0, _y0: 0, onp: false, _ice: false, _pad: null, _N: 0, _F: 0, dm: 0, pcd: 0, pdir: 0,
      _uf: null, _isl: 0, _wR: 0, _wOk: false, _wP: null, _wN: null, _wT: 0, _sh: null, _shT: 0, _hT: 0, _onP: false, _pri: 0, coast: false, _tx: 0, _ty: 0, _tT: 0, rsT: 0, bnN: 0, mineT: 0, keep: 0, hold: 0,
      uid: undefined, hx: undefined, hy: undefined, ver: undefined, rest: undefined, errT: undefined, brec: undefined, bought: undefined, svx: undefined, svy: undefined, sav: undefined, lav: undefined, owned: undefined, lx: undefined, ly: undefined, lr: undefined, lb: undefined, bl: undefined, bfx: undefined, bx: undefined, by: undefined, ownT: undefined, ownBad: undefined, ownTouch: undefined, ownLeft: undefined, ownBy: undefined, ownAt: undefined, ownLong: undefined, oh: undefined, lvx: undefined, lvy: undefined, lst: undefined, lostAt: undefined, lostSent: undefined, wasMine: undefined, sv: undefined, srvU: undefined, soft: undefined, px: undefined, py: undefined, pr: undefined, handAt: undefined, gone: undefined, m0: undefined, local: undefined, _pv: undefined, dver: undefined, seen: undefined, _sc: 0, _tpx: undefined, _svp: undefined, hb: undefined, pred: 0, predT: 0, predA: 0, touchT: 0, predS: 0, _ppN: 0, ph: undefined, pcx: 0, pcy: 0, _lsv: undefined };   // (and what the server and the players' devices keep on it, left empty until used)
    { const I = r ? 0.5 * d.m * r * r : d.m * (hw * hw + hw * hw) / 3; d.im = 1 / d.m; d.ii = kind === 5 || kind === 6 ? 0 : 1 / I; }
    d.hx = d.x; d.hy = d.y; d.uid = hash32('p' + kind + ',' + Math.round(x) + ',' + Math.round(y)); if (w.dynBy) { while (w.dynBy.has(d.uid)) d.uid = (d.uid + 1) >>> 0; w.dynBy.set(d.uid, d); }
    w.dyn.push(d); return d;
  }
  function spotFree(w, x, y, hw, hh) {   // room for a thing this size: no walls, doors or lava
    const tx0 = Math.floor((x - hw) / TS), tx1 = Math.floor((x + hw - 0.01) / TS), ty0 = Math.floor((y - hh) / TS), ty1 = Math.floor((y + hh - 0.01) / TS);
    for (let ty = ty0; ty <= ty1; ty++) for (let tx = tx0; tx <= tx1; tx++) { const t = tile(w, tx, ty); if (isSol(t) || t === 2) return false; }
    return true;
  }
  const isSol = t => t === 1 || t === 3 || t === 4 || t === 6 || t === 9;
  function boxHits(w, x, y, hw, hh) {
    const tx0 = Math.floor((x - hw) / TS), tx1 = Math.floor((x + hw - 0.01) / TS), ty0 = Math.floor((y - hh) / TS), ty1 = Math.floor((y + hh - 0.01) / TS);
    for (let ty = ty0; ty <= ty1; ty++) for (let tx = tx0; tx <= tx1; tx++) if (isSol(tile(w, tx, ty))) return true;
    return false;
  }
  /* ---------- seesaws (teeter-totters): a tilting plank that you and the round toys can ride ---------- */
  const SEE_MAX = 0.36, SEE_TH = 6;
  const PLANK_M = 3;   // a teeter-totter's plank is a real lever on its pivot: it weighs as much as three small crates, and only what pushes on it turns it
  const plankI = s => s.ii || (s.ii = 1 / (PLANK_M * (2 * s.hl) * (2 * s.hl) / 12));
  function seeHit(s, o, r, m) {   // a round thing o (your ball) against the plank: it stands on it, and its weight and knocks turn it
    if (s.gone) return false;
    const c = Math.cos(s.ang), sn = Math.sin(s.ang);
    const rx = o.x - s.cx, ry = o.y - s.cy, u = clamp(rx * c + ry * sn, -s.hl, s.hl);
    const qx = s.cx + u * c, qy = s.cy + u * sn, dx = o.x - qx, dy = o.y - qy, d2 = dx * dx + dy * dy;
    const below = rx * sn - ry * c < 0, mm = r + SEE_TH + (o.kin ? (o.ground && !below ? 20 : 4) : 0);   // (a player's point on the server, standing on the plank on their own screen, still weighs on it while the plank moves away under it)
    if (d2 >= mm * mm) return false;
    let nx, ny;   // (which side of the plank it is on: the plank is solid from both sides)
    if (d2 < 0.0001) { nx = below ? -sn : sn; ny = below ? c : -c; } else { const d = Math.sqrt(d2); nx = dx / d; ny = dy / d; }
    const pen = mm - Math.sqrt(d2); if (!o.kin) { o.x += nx * pen; o.y += ny * pen; }
    const px = qx - s.cx, py = qy - s.cy, svx = -s.av * py, svy = s.av * px;   // the plank's own movement at that spot
    const vn = (o.vx - svx) * nx + (o.vy - svy) * ny, rn = px * ny - py * nx, ii = s.kin ? 0 : plankI(s);
    let j = 0;
    const g1 = GRAV * (o.dt || 1 / 60);   // (what one step of falling adds)
    if (!below && ny < -0.35 && vn > -3 * g1) { if (vn < 0 && !o.kin) { o.vx -= vn * nx; o.vy -= vn * ny; } j = m * g1; }   // standing on it: you stay on it, and your whole weight presses on it
    else if (vn < 0) { j = -vn / (1 / m + ii * rn * rn); if (!o.kin) { o.vx += j * nx / m; o.vy += j * ny / m; } }   // landing on it or knocking it: you and the plank share the knock
    if (!o.ghost && j > 0 && ii) s.av -= ii * rn * j;
    return !below && ny < -0.35;
  }
  function nearF(f, x, y, rx, ry) {   // is this spot near the point of interest (or any of them: the server watches everybody in a world)?
    if (!f) return true;
    if (Array.isArray(f)) { for (let i = 0; i < f.length; i++) if (Math.abs(x - f[i].x) <= rx && Math.abs(y - f[i].y) <= ry) return true; return false; }
    return Math.abs(x - f.x) <= rx && Math.abs(y - f.y) <= ry;
  }
  function distF(f, d) { if (!Array.isArray(f)) return Math.abs(d.x - f.x) + Math.abs(d.y - f.y); let m = 1e9; for (let i = 0; i < f.length; i++) m = Math.min(m, Math.abs(d.x - f[i].x) + Math.abs(d.y - f[i].y)); return m; }
  function stepSee(w, dt) {   // each plank turns on its pivot as it was pushed (only crates, balls and players touch it: it goes straight through the ground)
    w.seeOwned = false;
    for (let i = 0; i < w.see.length; i++) {
      const s = w.see[i]; if (s.gone) continue;
      if (w.follow && s.sa === undefined) { s.kin = true; s.mineT = 0; s.av = 0; continue; }   // (in the shared world, until the server has said how a plank lies, it stays still: it is never guessed at)
      if (w.follow && s.sa !== undefined && s.other) s.mineT = 0;   // (another player's device is working this plank out: it is simply shown the way the server has it)
      if (w.follow && s.sa !== undefined && s.owned) { s.kin = false; if (s.mineT > 0) s.mineT -= dt; w.seeOwned = true; }   // (this device has the plank: it turns here with everything on it, exactly as a plank of its own does, and the server follows)
      else if (w.follow && s.sa !== undefined) {   // in the shared world the server has the plank: it follows the server's (while you are on it, it also reacts to you at once)
        s.kin = !(s.mineT > 0);
        const now = typeof performance !== 'undefined' ? performance.now() : Date.now(), age = s.st ? Math.min(0.25, Math.max(0, (now - s.st) / 1000)) : 0.05, ta = clamp(s.sa + (s.sav || 0) * age, -SEE_MAX, SEE_MAX);   // (carried on exactly the way the crates and balls are, so what rests on it moves with it)
        const a0 = s.ang;
        if (s.mineT > 0) { s.mineT -= dt; s.ang += s.av * dt; s.ang += (ta - s.ang) * Math.min(1, 6 * dt); }
        else { s.ang += (ta - s.ang) * Math.min(1, 26 * dt); s.av = (s.ang - a0) / dt; }
        seeLimit(s); if (Math.abs(s.ang - a0) > 1e-6) seeBlock(w, s, a0);   // (here the crates and balls are where the server has them: the plank stops on them, it never swings into one)
      } else if (s.ownT > 0) { s.ownT -= dt; s.kin = true; }   // (on the server: a player's device is turning this plank and says how; here it moves the way they say)
      else s.kin = false;   // (a plank of its own turns after the pushing is worked out, together with everything on it: see turnSee)
      if (s.kin || s.mineT > 0) seeLimit(s);
      if (Math.abs(s.av) > 0.03) s.moving = 0.5; else if (s.moving > 0) s.moving -= dt;   // (while it moves, what rests on it is kept awake)
    }
  }
  function plankGap(s, d, ang, sd) {   // how far a plank at this angle is from a crate or ball (below 0: they overlap); sd: the side of the plank it is on
    const c = Math.cos(ang), sn = Math.sin(ang);
    const seg = (vx, vy, r) => { const a = (vx - s.cx) * c + (vy - s.cy) * sn, u = clamp(a, -s.hl, s.hl), dx = vx - s.cx - u * c, dy = vy - s.cy - u * sn, dd = Math.sqrt(dx * dx + dy * dy); return r === 0 && Math.abs(a) < s.hl && (dx * sn - dy * c) * sd < 0 ? -dd - SEE_TH : dd - r - SEE_TH; };
    if (isBall(d)) return seg(d.x, d.y, d.r);
    const sh = shapeOf(d); let g = 1e9;
    for (const [lx, ly] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) g = Math.min(g, seg(sh.x + sh.c * lx * sh.hw - sh.s * ly * sh.hh, sh.y + sh.s * lx * sh.hw + sh.c * ly * sh.hh, 0));
    for (let k = -1; k <= 1; k += 2) { const h = circBox(sh, s.cx + k * s.hl * c, s.cy + k * s.hl * sn, SEE_TH + 60); if (h) g = Math.min(g, h[2] + 60); }
    return g;
  }
  function restsOn(w, d) {   // (is anything holding this up: the ground, a plank, a rope bridge or another thing under it)
    const sh = d.r ? null : shapeOf(d), ex = d.r || sh.ex, ey = d.r || sh.ey;
    if (boxHits(w, d.x, d.y + 3, ex - 1, ey)) return true;
    for (let i = 0; i < w.see.length; i++) { const s = w.see[i]; if (Math.abs(s.cx - d.x) < s.hl + ex + 10 && Math.abs(s.cy - d.y) < s.hl + ey + 30) return true; }
    if (w.ropes) for (const r of w.ropes) if (!r.gone && d.x > r.ax - ex && d.x < r.bx + ex) { const q = ropeAt(r, d.x); if (Math.abs(d.y + ey - q.y) < 12) return true; }
    for (let i = 0; i < w.dyn.length; i++) { const o = w.dyn[i]; if (o === d || o.burn > 0 || Math.abs(o.x - d.x) > 80 || o.y <= d.y || o.y - d.y > 80) continue; const e = o.r || Math.max(o.hw, o.hh) * 1.42; if (Math.abs(o.x - d.x) < e + ex && o.y - e < d.y + ey + 4) return true; }
    return false;
  }
  function ballOff(w, b, d) {   // your ball is put back outside something the server holds where it is (instead of that thing being pushed into you)
    let h; if (d.k === 'b') { h = circBox(shapeOf(d), b.x, b.y, R); if (!h) return false; } else { const dx = b.x - d.x, dy = b.y - d.y, d2 = dx * dx + dy * dy, rr = R + d.r; if (d2 >= rr * rr) return false; const dd = Math.sqrt(d2) || 0.001; h = [0, 0, dd - rr, d2 ? dx / dd : 0, d2 ? dy / dd : -1]; }
    const pen = -h[2]; if (pen <= 0.3) return false; const nx = h[3], ny = h[4];
    if (!boxHits(w, b.x + nx * pen, b.y + ny * pen, R - 3, R - 3)) { b.x += nx * pen; b.y += ny * pen; }
    const vn = b.vx * nx + b.vy * ny; if (vn < 0) { b.vx -= vn * nx; b.vy -= vn * ny; } return true;
  }
  function outOfBall(w, b, skip) {   // shown the server's picture: nothing is ever drawn inside your own ball (the server keeps everything out of it too, only a moment later on a slow connection)
    const L = w.cand || w.dyn;
    for (let i = 0; i < L.length; i++) {
      const d = L[i]; if (d.burn > 0 || Math.abs(d.x - b.x) > 70 || Math.abs(d.y - b.y) > 70 || (skip && skip(d))) continue;
      let h; if (d.k === 'b') { h = circBox(shapeOf(d), b.x, b.y, R); if (!h) continue; } else { const dx = b.x - d.x, dy = b.y - d.y, d2 = dx * dx + dy * dy, rr = R + d.r; if (d2 >= rr * rr) continue; const dd = Math.sqrt(d2) || 0.001; h = [0, 0, dd - rr, d2 ? dx / dd : 0, d2 ? dy / dd : -1]; }
      const pen = -h[2] - 0.5; if (pen <= 0) continue;
      const nx = h[3], ny = h[4], qx = d.x - nx * pen, qy = d.y - ny * pen, ex = d.r || shapeOf(d).ex, ey = d.r || shapeOf(d).ey;
      if (!boxHits(w, qx, qy, ex - 2, ey - 2)) { d.x = qx; d.y = qy; }
    }
  }
  function seeOut(w, skip) {   // shown the server's picture: a crate or ball drawn a few pixels into a plank (the two are carried on a little differently between updates) is drawn resting on it
    for (let i = 0; i < w.see.length; i++) {
      const s = w.see[i]; if (s.gone) continue;
      const c = Math.cos(s.ang), sn = Math.sin(s.ang);
      for (let j = 0; j < w.dyn.length; j++) {
        const d = w.dyn[j]; if (d.burn > 0 || Math.abs(d.x - s.cx) > s.hl + 60 || Math.abs(d.y - s.cy) > s.hl + 60 || (skip && skip(d))) continue;
        const rx = d.x - s.cx, ry = d.y - s.cy; if (Math.abs(rx * c + ry * sn) > s.hl) continue;
        const sd = rx * sn - ry * c >= 0 ? 1 : -1, g = plankGap(s, d, s.ang, sd);
        if (g < 0 && g > -16) { d.x += sn * sd * -g; d.y -= c * sd * -g; }
      }
    }
  }
  function seeBlock(w, s, a0) {   // a plank that is turned without the solver (it follows the server, or you just landed on it) stops where it meets a crate or ball
    const reach = s.hl + 80;
    for (let i = 0; i < w.dyn.length; i++) {
      const d = w.dyn[i]; if (d.gone || d.burn > 0 || Math.abs(d.x - s.cx) > reach || Math.abs(d.y - s.cy) > reach) continue;
      const sd = (d.x - s.cx) * Math.sin(a0) - (d.y - s.cy) * Math.cos(a0) < 0 ? -1 : 1;
      const g0 = plankGap(s, d, a0, sd), g1 = plankGap(s, d, s.ang, sd), lim = Math.min(g0, -0.5);
      if (g1 >= lim || g1 >= g0) continue;   // (not touching, or it is moving away)
      let lo = a0, hi = s.ang;
      for (let k = 0; k < 10; k++) { const m = (lo + hi) / 2; if (plankGap(s, d, m, sd) >= lim) lo = m; else hi = m; }
      if ((s.ang - a0) * s.av > 0) s.av = 0;
      s.ang = lo;
    }
  }
  function claimPlanks(w, d) {
    const e = d.r || Math.max(d.hw, d.hh) * 1.42;
    for (let i = 0; i < w.see.length; i++) { const s = w.see[i]; if (s.gone || s.other || s.sa === undefined) continue; const rx = d.x - s.cx, ry = d.y - s.cy, c = Math.cos(s.ang), sn = Math.sin(s.ang), al = rx * c + ry * sn, h = rx * sn - ry * c; if (Math.abs(al) < s.hl + e + 6 && Math.abs(h) < e + SEE_TH + 24) s.mineT = Math.max(s.mineT || 0, 0.3); }
  }
  function onOwnedPlank(w, d) {
    const e = d.r || Math.max(d.hw, d.hh) * 1.42;
    for (let i = 0; i < w.see.length; i++) { const s = w.see[i]; if (!s.owned || s.gone) continue; const rx = d.x - s.cx, ry = d.y - s.cy, c = Math.cos(s.ang), sn = Math.sin(s.ang), al = rx * c + ry * sn, h = rx * sn - ry * c; if (Math.abs(al) < s.hl + e + 10 && Math.abs(h) < e + SEE_TH + 40) return true; }
    return false;
  }
  function plankCross(w, x0, y0, x1, y1, e) {   // would moving a thing from (x0,y0) to (x1,y1) take it through a plank, from one side to the other?
    for (let i = 0; i < w.see.length; i++) { const s = w.see[i]; if (s.gone) continue; const c = Math.cos(s.ang), sn = Math.sin(s.ang);
      const a0 = (x0 - s.cx) * c + (y0 - s.cy) * sn, a1 = (x1 - s.cx) * c + (y1 - s.cy) * sn, h0 = (x0 - s.cx) * sn - (y0 - s.cy) * c, h1 = (x1 - s.cx) * sn - (y1 - s.cy) * c;
      if (Math.abs(a0) > s.hl + e || Math.abs(a1) > s.hl + e) continue;
      if (Math.sign(h0) !== Math.sign(h1) && Math.abs(h0) > 2 && Math.abs((a0 + a1) / 2) < s.hl - 4) return true; }
    return false;
  }
  function seeLimit(s) { if (s.ang > SEE_MAX) { s.ang = SEE_MAX; if (s.av > 0) s.av = 0; } if (s.ang < -SEE_MAX) { s.ang = -SEE_MAX; if (s.av < 0) s.av = 0; } }
  function turnSee(w, dt) {   // each plank turns as it was pushed this step (after the crates and balls on it were worked out, so it never swings into them)
    for (let i = 0; i < w.see.length; i++) { const s = w.see[i]; if (s.gone || s.kin || (w.follow && !s.owned)) continue; s.av *= Math.max(0, 1 - 0.6 * dt); s.ang += s.av * dt; seeLimit(s); }
  }
  function seeBody(b, w, wt) {   // the player (or a round toy) against every nearby plank
    let on = false;
    for (let i = 0; i < w.see.length; i++) {
      const s = w.see[i]; if (Math.abs(s.cx - b.x) > s.hl + 40 || Math.abs(s.cy - b.y) > s.hl + 60) continue;
      if (seeHit(s, b, b.r || R, wt / 60)) {
        on = true; b.onSee = s; if (w.follow && !w.srvOnly && b.r === undefined && !b.ghost && !b.remote) s.mineT = 0.6;
        const sl = Math.sin(s.ang);
        if (b.r === undefined) b.flat = Math.abs(sl) <= 0.06;   // on a tilted plank you slide; on a level one you grip
        if (b.r === undefined) { b.ground = true; b.gType = 1; }
      }
    }
    return on;
  }
  function seeGuard(w, o, half) {   // whatever was on top of a plank can never end up underneath it: if it did get through (a fast fall, a plank swinging up into it), put it back on top
    for (let i = 0; i < w.see.length; i++) {
      const s = w.see[i], rx = o.x - s.cx, ry = o.y - s.cy;
      if (Math.abs(rx) > s.hl + 80 || Math.abs(ry) > s.hl + 120) { if (o.sg === i) o.sg = -1; continue; }
      const c = Math.cos(s.ang), sn = Math.sin(s.ang), along = rx * c + ry * sn, nrm = rx * sn - ry * c;
      const pa = o.sgA; o.sgA = along;
      if (Math.abs(along) > s.hl + 4) { if (o.sg === i) o.sg = -1; continue; }
      if (nrm >= 0) { o.sg = i; continue; }
      if (o.sg === i && (pa === undefined || Math.abs(pa) > s.hl - 6 || Math.abs(along) > s.hl - 6)) { o.sg = -1; continue; }   // (it went round the end of the plank, not through it: it really is underneath now)
      if (o.sg === i && nrm > -(half + SEE_TH + 50)) {
        const need = half + SEE_TH - nrm; o.x += sn * need; o.y -= c * need;
        const vn = o.vx * sn - o.vy * c; if (vn < 0) { o.vx -= vn * sn; o.vy += vn * c; }
      }
    }
  }
  /* ---------- buttons, pressure plates and doors ---------- */
  const BTN_T = 60;   // seconds a red button keeps its gates open
  function doorBlocked(w, d, bs) {
    const x0 = d.x * TS, x1 = (d.x + d.w) * TS, y0 = (d.y + 1) * TS, y1 = (d.y + d.h) * TS;   // (the beam above is always solid, so only the gap below it can be blocked)
    const L = bs ? (Array.isArray(bs) ? bs : [bs]) : [];
    for (let k = 0; k < L.length; k++) { const b = L[k]; if (b && b.x + R > x0 && b.x - R < x1 && b.y + R > y0 && b.y - R < y1) return true; }
    for (let i = 0; i < w.dyn.length; i++) { const o = w.dyn[i]; if (o.burn > 0) continue; const e = o.r || o.hw; if (o.x + e > x0 && o.x - e < x1 && o.y + e > y0 && o.y - e < y1) return true; }
    return false;
  }
  // bs: a player body, or a list of them (the server passes everybody in the world). In follow mode (a device that is shown the server's world) a gate may only be opened here at once;
  // shutting it is up to the server. dt (optional): with w.closeDelay, a gate waits that long after the last thing left its trigger before it shuts.
  let colSrc = null, colLen = -1, colMap = null, colStep = -1;
  function nearCol(L, mx) {   // only what is within a few columns of a plate is looked at (the same things as before, found without going through everything)
    if (L !== colSrc || L.length !== colLen || colStep !== dynTick) { colSrc = L; colLen = L.length; colStep = dynTick; colMap = new Map(); for (const o of L) { const k = Math.floor(o.x / 300); let a = colMap.get(k); if (!a) colMap.set(k, a = []); a.push(o); } }
    const k = Math.floor(mx / 300), out = []; for (let c = k - 2; c <= k + 2; c++) { const a = colMap.get(c); if (a) for (const o of a) out.push(o); } return out;
  }
  function stepSwitches(w, bs, dt) {
    const L = bs ? (Array.isArray(bs) ? bs : [bs]) : [];
    for (let i = 0; i < w.doors.length; i++) w.doors[i].latched = false;
    for (let i = 0; i < w.btns.length; i++) {   // a red button holds its gates open for BTN_T seconds after it was last stood on, then pops back up
      const q = w.btns[i], x0 = q.x * TS - R, x1 = (q.x + 1) * TS + R, fy = q.y * TS; let hit = false;
      for (let k = 0; k < L.length && !hit; k++) { const b = L[k]; if (b && !b.ghost && b.x > x0 && b.x < x1 && b.y + R >= fy - 8 && b.y + R <= fy + 6) hit = true; }
      if (hit) {
        if (!q.on) { q.on = true; q.t = 1; q.pT = Date.now(); w.ev.push({ k: 'btn', x: (q.x + 0.5) * TS, y: fy }); }
        if (!(q.left > BTN_T - 1)) q.rf = ((q.rf || 0) + 1) % 1000;   // (wound up again: everybody's little timer starts over)
        q.left = BTN_T;
      } else if (q.on) {
        q.left = (q.left === undefined ? BTN_T : q.left) - (dt || 0);
        if (q.left <= 0) { q.left = 0; if (!w.follow) { q.on = false; w.ev.push({ k: 'btnup', x: (q.x + 0.5) * TS, y: fy }); } }   // (in the shared world the server says when it is up again)
      }
      if (q.on) for (const di of q.to) if (w.doors[di]) w.doors[di].latched = true;
    }
    const want = w.doors.map(d => d.latched);
    for (let i = 0; i < w.plates.length; i++) {
      const q = w.plates[i], x0 = q.x * TS, x1 = (q.x + q.w) * TS, fy = q.y * TS; let on = !!(w.follow && q.srvOn), dynOn = false;
      for (let k = 0; k < L.length && !on; k++) { const b = L[k]; if (b && !b.ghost && b.x > x0 && b.x < x1 && b.y + R >= fy - 8 && b.y + R <= fy + 6 && b.ground) on = true; }
      const DL0 = w.follow ? [] : w.cand || w.dyn, DL = DL0.length > 48 ? nearCol(DL0, (x0 + x1) / 2) : DL0;   // (on the server: only the things near a player. In the shared world the crates on it are the server's to judge: here only your own ball is looked at, so a crate seen a little differently never makes it flicker)
      for (let j = 0; j < DL.length && !on; j++) {
        const o = DL[j]; if (o.burn > 0 || Math.abs(o.x - (x0 + x1) / 2) > 300) continue;
        const bot = o.y + (o.r || o.hh), m = q.on ? 4 : 0;   // (a little more room to stay pressed than to get pressed: something resting right at the edge never flickers it)
        if (o.x > x0 - m && o.x < x1 + m && bot >= fy - 8 - m && bot <= fy + 6 + m) { on = true; dynOn = true; }
      }
      if (w.cand && w.focus && !w.follow) {   // (the server only looks at the things near a player: a plate nobody is near keeps what was last seen resting on it, so the gate stays open when everybody walks away from the crates holding it down)
        let seen = false; const cx = (x0 + x1) / 2; for (let k = 0; k < w.focus.length && !seen; k++) if (Math.abs(w.focus[k].x - cx) < 360 && Math.abs(w.focus[k].y - fy) < 360) seen = true;
        if (seen) q.dynOn = dynOn; else if (q.dynOn) on = true;
      }
      if (on !== q.on) { q.on = on; w.ev.push({ k: 'plate', on, x: (q.x + q.w / 2) * TS, y: fy }); }
      if (on) for (const di of q.to) want[di] = true;
    }
    for (let i = 0; i < w.doors.length; i++) {
      const d = w.doors[i];
      if (want[i]) d.offT = 0; else d.offT = (d.offT || 0) + (dt || 0);
      if (want[i] && !d.open) { setDoorTiles(w, d, true); d.predT = Date.now(); w.ev.push({ k: 'door', open: true, x: (d.x + d.w / 2) * TS, y: (d.y + d.h / 2) * TS, h: d.h }); }
      else if (!want[i] && d.open && !w.follow && !(w.closeDelay && d.offT < w.closeDelay) && !doorBlocked(w, d, L)) { setDoorTiles(w, d, false); w.ev.push({ k: 'door', open: false, x: (d.x + d.w / 2) * TS, y: (d.y + d.h / 2) * TS, h: d.h }); }
    }
  }


  /* ---------- crates, balls and springs: real rigid-body physics ----------
     Every crate is a box that can lie at any angle and every ball rolls. Contacts push with impulses and grip with friction
     (so what sits on a crate rides along with it unless it is yanked out from under), weight adds up through a pile, and
     nothing is ever turned to face a particular way: a crate rests on whatever face, edge or slope it comes to rest on. */
  const PLAYER_WT = 240;   // (on a teeter-totter you weigh as much as four small crates)
  const SPEC = 24, BSPEC = 1.5; let SPECX = BSPEC;   // (how far ahead a plank looks for what it is about to hit)
  const SLOP = 0.6, BAUM = 0.3, VEL_IT = 10, POS_IT = 4, PM = 4, PM_PUSH = 4, F_PUSH = 9000;   // PM: how heavy your ball is when it pushes things (a crate weighs 1, a big crate 4)
  const LIN_SLEEP = 8, ANG_SLEEP = 0.1, SLEEP_T = 0.5, MAXSPD = 1400, MAXAV = 28;
  const SK_PX = 1, SK_NX = 2, SK_PY = 4, SK_NY = 8;   // tile faces that are hidden by a neighbouring solid tile (never pushed out through those)
  function shapeOf(d) { const c = Math.cos(d.rot || 0), s = Math.sin(d.rot || 0); return { x: d.x, y: d.y, hw: d.hw, hh: d.hh, c, s, ex: Math.abs(c) * d.hw + Math.abs(s) * d.hh, ey: Math.abs(s) * d.hw + Math.abs(c) * d.hh }; }
  function clipSeg(vIn, nx, ny, off, ce) {
    const out = [], a = vIn[0], b = vIn[1];
    const d0 = nx * a[0] + ny * a[1] - off, d1 = nx * b[0] + ny * b[1] - off;
    if (d0 <= 0) out.push(a);
    if (d1 <= 0) out.push(b);
    if (d0 * d1 < 0) {
      const t = d0 / (d0 - d1); let fp;
      if (d0 > 0) { fp = a[2].slice(); fp[0] = ce; fp[2] = 0; } else { fp = b[2].slice(); fp[1] = ce; fp[3] = 0; }
      out.push([a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1]), fp]);
    }
    return out;
  }
  function incEdge(B, nx, ny) {   // the edge of box B that faces most against the normal
    const lx = -(B.c * nx + B.s * ny), ly = -(-B.s * nx + B.c * ny), hx = B.hw, hy = B.hh;
    let v;
    if (Math.abs(lx) > Math.abs(ly)) v = lx >= 0 ? [[hx, -hy, [0, 0, 3, 4]], [hx, hy, [0, 0, 4, 1]]] : [[-hx, hy, [0, 0, 1, 2]], [-hx, -hy, [0, 0, 2, 3]]];
    else v = ly >= 0 ? [[hx, hy, [0, 0, 4, 1]], [-hx, hy, [0, 0, 1, 2]]] : [[-hx, -hy, [0, 0, 2, 3]], [hx, -hy, [0, 0, 3, 4]]];
    for (const q of v) { const x = q[0], y = q[1]; q[0] = B.x + B.c * x - B.s * y; q[1] = B.y + B.s * x + B.c * y; }
    return v;
  }
  // box A against box B (both {x,y,hw,hh,c,s}); contacts go into out as [x, y, separation, nx, ny, feature], the normal pointing from A to B
  function obbHit(A, B, skip, out) {
    const dpx = B.x - A.x, dpy = B.y - A.y;
    const dAx = A.c * dpx + A.s * dpy, dAy = -A.s * dpx + A.c * dpy, dBx = B.c * dpx + B.s * dpy, dBy = -B.s * dpx + B.c * dpy;
    const c11 = A.c * B.c + A.s * B.s, c21 = -A.s * B.c + A.c * B.s, c12 = -A.c * B.s + A.s * B.c, c22 = A.s * B.s + A.c * B.c;
    const a11 = Math.abs(c11), a12 = Math.abs(c12), a21 = Math.abs(c21), a22 = Math.abs(c22);
    const fAx = Math.abs(dAx) - A.hw - (a11 * B.hw + a12 * B.hh), fAy = Math.abs(dAy) - A.hh - (a21 * B.hw + a22 * B.hh);
    if (fAx > 0 || fAy > 0) return;
    const fBx = Math.abs(dBx) - (a11 * A.hw + a21 * A.hh) - B.hw, fBy = Math.abs(dBy) - (a12 * A.hw + a22 * A.hh) - B.hh;
    if (fBx > 0 || fBy > 0) return;
    const hid = (nx, ny) => skip && (((skip & SK_PX) && nx > 0.71) || ((skip & SK_NX) && nx < -0.71) || ((skip & SK_PY) && ny > 0.71) || ((skip & SK_NY) && ny < -0.71));
    let axis = -1, sep = -1e9, nx = 0, ny = 0;
    const tryAx = (ax, f, x, y, h) => { if (hid(x, y)) return; if (axis < 0 || f > 0.95 * sep + 0.01 * h) { axis = ax; sep = f; nx = x; ny = y; } };
    tryAx(0, fAx, dAx > 0 ? A.c : -A.c, dAx > 0 ? A.s : -A.s, A.hw);
    tryAx(1, fAy, dAy > 0 ? -A.s : A.s, dAy > 0 ? A.c : -A.c, A.hh);
    tryAx(2, fBx, dBx > 0 ? B.c : -B.c, dBx > 0 ? B.s : -B.s, B.hw);
    tryAx(3, fBy, dBy > 0 ? -B.s : B.s, dBy > 0 ? B.c : -B.c, B.hh);
    if (axis < 0) return;
    let fnx, fny, front, snx, sny, negS, posS, negE, posE, inc;
    if (axis === 0) { fnx = nx; fny = ny; front = A.x * fnx + A.y * fny + A.hw; snx = -A.s; sny = A.c; const sd = A.x * snx + A.y * sny; negS = -sd + A.hh; posS = sd + A.hh; negE = 3; posE = 1; inc = incEdge(B, fnx, fny); }
    else if (axis === 1) { fnx = nx; fny = ny; front = A.x * fnx + A.y * fny + A.hh; snx = A.c; sny = A.s; const sd = A.x * snx + A.y * sny; negS = -sd + A.hw; posS = sd + A.hw; negE = 2; posE = 4; inc = incEdge(B, fnx, fny); }
    else if (axis === 2) { fnx = -nx; fny = -ny; front = B.x * fnx + B.y * fny + B.hw; snx = -B.s; sny = B.c; const sd = B.x * snx + B.y * sny; negS = -sd + B.hh; posS = sd + B.hh; negE = 3; posE = 1; inc = incEdge(A, fnx, fny); }
    else { fnx = -nx; fny = -ny; front = B.x * fnx + B.y * fny + B.hh; snx = B.c; sny = B.s; const sd = B.x * snx + B.y * sny; negS = -sd + B.hw; posS = sd + B.hw; negE = 2; posE = 4; inc = incEdge(A, fnx, fny); }
    let cp = clipSeg(inc, -snx, -sny, negS, negE); if (cp.length < 2) return;
    cp = clipSeg(cp, snx, sny, posS, posE); if (cp.length < 2) return;
    for (let i = 0; i < 2; i++) {
      const v = cp[i], s2 = fnx * v[0] + fny * v[1] - front;
      if (s2 > 0) continue;
      let fp = v[2]; if (axis >= 2) fp = [fp[2], fp[3], fp[0], fp[1]];
      out.push([v[0] - s2 * fnx, v[1] - s2 * fny, s2, nx, ny, fp[0] | (fp[1] << 3) | (fp[2] << 6) | (fp[3] << 9)]);
    }
  }
  function circBox(B, cx, cy, r) {   // a circle against a box: [x, y, separation, nx, ny] with the normal from the box to the circle, or null
    const rx = cx - B.x, ry = cy - B.y, lx = B.c * rx + B.s * ry, ly = -B.s * rx + B.c * ry;
    const qx = clamp(lx, -B.hw, B.hw), qy = clamp(ly, -B.hh, B.hh);
    let nlx, nly, sep, px, py;
    if (qx !== lx || qy !== ly) {
      const dx = lx - qx, dy = ly - qy, d2 = dx * dx + dy * dy; if (d2 >= r * r) return null;
      const d = Math.sqrt(d2); nlx = dx / d; nly = dy / d; sep = d - r; px = qx; py = qy;
    } else {   // the centre is inside: out through the nearest face
      const ox = B.hw - Math.abs(lx), oy = B.hh - Math.abs(ly);
      if (ox < oy) { nlx = lx < 0 ? -1 : 1; nly = 0; sep = -ox - r; px = nlx * B.hw; py = ly; }
      else { nlx = 0; nly = ly < 0 ? -1 : 1; sep = -oy - r; px = lx; py = nly * B.hh; }
    }
    return [B.x + B.c * px - B.s * py, B.y + B.s * px + B.c * py, sep, B.c * nlx - B.s * nly, B.s * nlx + B.c * nly];
  }
  function circTile(w, tx, ty, cx, cy, r) {   // a circle against one solid tile; inner seams between two tiles are never touched
    const left = tx * TS, top = ty * TS, qx = clamp(cx, left, left + TS), qy = clamp(cy, top, top + TS), dx = cx - qx, dy = cy - qy, d2 = dx * dx + dy * dy;
    if (d2 >= r * r) return null;
    if (d2 > 0) {
      if (dx !== 0 && dy !== 0) { const sx = dx > 0 ? 1 : -1, sy = dy > 0 ? 1 : -1; if (isSol(tile(w, tx + sx, ty)) || isSol(tile(w, tx, ty + sy))) return null; }
      else if (dx === 0 && isSol(tile(w, tx, ty + (dy > 0 ? 1 : -1)))) return null;
      else if (dy === 0 && isSol(tile(w, tx + (dx > 0 ? 1 : -1), ty))) return null;
      const d = Math.sqrt(d2); return [qx, qy, d - r, dx / d, dy / d];
    }
    let best = null;   // the centre is inside the tile: out through the nearest open face
    const faces = [[0, -1, cy - top, cx, top, tile(w, tx, ty - 1)], [0, 1, top + TS - cy, cx, top + TS, tile(w, tx, ty + 1)], [-1, 0, cx - left, left, cy, tile(w, tx - 1, ty)], [1, 0, left + TS - cx, left + TS, cy, tile(w, tx + 1, ty)]];
    for (const f of faces) if (!isSol(f[5]) && (!best || f[2] < best[2])) best = f;
    if (!best) return null;
    return [best[3], best[4], -best[2] - r, best[0], best[1]];
  }
  const CT = []; let nCT = 0, wTick = 0;
  function addC(a, b, h, key) {
    let c = CT[nCT]; if (!c) c = CT[nCT] = {};
    nCT++;
    c.a = a; c.b = b; c.px = h[0]; c.py = h[1]; c.sep = h[2]; c.nx = h[3]; c.ny = h[4]; c.key = key;
    c.kvx = 0; c.kvy = 0; c.pl = null; c.rp = null; c.pp = false; c.u = 0; c.mu = 0.5; c.mk = 0; c.e = 0; c.eT = 1e9; c.eCap = 1e9; c.eMin = 0; c.Pn = 0; c.Pt = 0; c.Pb = 0;
    return c;
  }
  const isBall = d => d.k === 'o';
  function matPair(c, a, b) {   // what two touching things are like together
    const ba = isBall(a), bb = isBall(b);
    if (ba || bb) { c.mu = (a.kind === 4 || b.kind === 4) ? 0.12 : 0.35; c.e = 0.15; c.eT = 160; }
    else c.mu = 0.6;
  }
  function matTile(c, d, t) {
    const ice = t === 3;
    if (isBall(d)) { c.mu = ice ? 0.02 : 0.7; c.e = 0.3; c.eT = 250; }   // (springs only throw players: a crate or ball just sits on one like on the ground)
    else { c.mu = ice ? 0.015 : Math.abs(c.nx) > 0.7 ? 0.8 : 0.55; c.mk = ice ? 0.015 : 0.25; { const h = Math.PI / 2, q = (((d.rot || 0) % h) + h) % h; if (Math.min(q, h - q) > 0.35) c.mk = 0; }   /* (only a crate sliding flat on a face glides; one standing on an edge or corner keeps its grip, so it stays leaning) */ if (t === 6) { c.e = d.hw > 20 ? 0.5 : 0.68; c.eT = 130; c.eCap = BOUNCE * 0.85; c.eMin = 160; } }
  }
  function tileContacts(w, d, sh) {
    const ex = d.r || sh.ex, ey = d.r || sh.ey;
    const tx0 = Math.floor((d.x - ex - 1) / TS), tx1 = Math.floor((d.x + ex + 1) / TS), ty0 = Math.floor((d.y - ey - 1) / TS), ty1 = Math.floor((d.y + ey + 1) / TS);
    let lava = false;
    for (let ty = ty0; ty <= ty1; ty++) for (let tx = tx0; tx <= tx1; tx++) {
      const t = tile(w, tx, ty);
      if (t === 2) { if (isBall(d)) { const h = circTile(w, tx, ty, d.x, d.y, d.r - 3); if (h && h[2] < 0) lava = true; } else if (d.x > tx * TS - 2 && d.x < tx * TS + TS + 2 && d.y + ey - 5 > ty * TS && d.y < ty * TS + TS) lava = true; continue; }
      if (!isSol(t)) continue;
      const key = 35184372088832 + (ty * 4096 + tx) * 4096;   // (each touch has a number of its own: what it is against, and which corner or edge)
      if (isBall(d)) { const h = circTile(w, tx, ty, d.x, d.y, d.r); if (h) matTile(addC(null, d, h, key), d, t); continue; }
      const skip = (isSol(tile(w, tx + 1, ty)) ? SK_PX : 0) | (isSol(tile(w, tx - 1, ty)) ? SK_NX : 0) | (isSol(tile(w, tx, ty + 1)) ? SK_PY : 0) | (isSol(tile(w, tx, ty - 1)) ? SK_NY : 0);
      const out = []; obbHit({ x: (tx + 0.5) * TS, y: (ty + 0.5) * TS, hw: TS / 2, hh: TS / 2, c: 1, s: 0 }, sh, skip, out);
      for (const h of out) matTile(addC(null, d, h, key + h[5]), d, t);
    }
    return lava;
  }
  function pairContacts(a, b, sa, sb, dynB, w) {   // a is always moved by these contacts; b only if dynB (otherwise it is held where it is)
    const A = dynB ? a : b, B = dynB ? b : a, SA = dynB ? sa : sb, SB = dynB ? sb : sa;   // (a thing that is held still is always the first of the two)
    if (isBall(A) && isBall(B)) {   // (two balls: the commonest by far, worked out without making anything new)
      const dx = B.x - A.x, dy = B.y - A.y, d2 = dx * dx + dy * dy, rr = A.r + B.r, rs = rr + SPECX; if (d2 >= rs * rs) return 0;   // (balls are looked at a hair before they touch, so a pile of them rests still instead of trembling between touching and not)
      const d = Math.sqrt(d2) || 0.001, nx = d2 ? dx / d : 0, ny = d2 ? dy / d : -1; const h = PCO; h[0] = A.x + nx * A.r; h[1] = A.y + ny * A.r; h[2] = d - rr; h[3] = nx; h[4] = ny; h[5] = 0;
      const c = addC(dynB ? A : null, B, h, (A.uid >>> 0) * 4096); matPair(c, A, B); if (!dynB) { const rx = h[0] - A.x, ry = h[1] - A.y; c.kvx = (A.vx || 0) - (A.av || 0) * ry; c.kvy = (A.vy || 0) + (A.av || 0) * rx; }
      return 1;
    }
    const out = [];
    if (!isBall(A) && !isBall(B)) obbHit(SA, SB, 0, out); else if (isBall(B)) { const h = circBox(SA, B.x, B.y, B.r + SPECX); if (h) out.push([h[0], h[1], h[2] + SPECX, h[3], h[4], 0]); }
    else { const h = circBox(SB, A.x, A.y, A.r + SPECX); if (h) { const sp = h[2] + SPECX; out.push([h[0] + h[3] * sp, h[1] + h[4] * sp, sp, -h[3], -h[4], 0]); } }
    for (const h of out) { const c = addC(dynB ? A : null, B, h, (A.uid >>> 0) * 4096 + h[5]); matPair(c, A, B); if (!dynB) { const rx = h[0] - A.x, ry = h[1] - A.y; c.kvx = (A.vx || 0) - (A.av || 0) * ry; c.kvy = (A.vy || 0) + (A.av || 0) * rx; } }
    return out.length;
  }
  function plankContacts(w, d, sh) {
    let n = 0;
    for (let i = 0; i < w.see.length; i++) {
      const s = w.see[i], ext = d.r || Math.max(sh.ex, sh.ey);
      if (Math.abs(s.cx - d.x) > s.hl + ext + 14 || Math.abs(s.cy - d.y) > s.hl + ext + 14) continue;
      const c = Math.cos(s.ang), sn = Math.sin(s.ang), ux = sn, uy = -c;
      const pa = s._px || (s._px = { x: 0, y: 0, vx: 0, vy: 0, av: 0, _im: 0, _ii: 0, _bx: 0, _by: 0, _bw: 0, uid: s.uid });
      if (pa.t !== dynTick) { pa.t = dynTick; pa.x = s.cx; pa.y = s.cy; pa.av = s.av; pa._ii = s.kin || (Math.abs(s.ang) >= SEE_MAX - 1e-6 && !s.leave) ? 0 : plankI(s); pa._bx = pa._by = pa._bw = 0; pa.s = s; plankUsed.push(pa); }   // (the plank takes part in the pushing like any other thing, turning on its pivot)
      const add = (h, key, u) => { const q = addC(pa, d, h, key); q.pl = s; q.u = clamp(u, -s.hl, s.hl); q.mu = 0.7; n++; };
      const vs = isBall(d) ? [[d.x, d.y, d.r]] : [[sh.x + sh.c * sh.hw - sh.s * sh.hh, sh.y + sh.s * sh.hw + sh.c * sh.hh, 0], [sh.x - sh.c * sh.hw - sh.s * sh.hh, sh.y - sh.s * sh.hw + sh.c * sh.hh, 0], [sh.x + sh.c * sh.hw + sh.s * sh.hh, sh.y + sh.s * sh.hw - sh.c * sh.hh, 0], [sh.x - sh.c * sh.hw + sh.s * sh.hh, sh.y - sh.s * sh.hw - sh.c * sh.hh, 0]];
      const sd = (d.x - s.cx) * ux + (d.y - s.cy) * uy < 0 ? -1 : 1, sux = ux * sd, suy = uy * sd;   // (the side it is on: the plank is solid from above and from below)
      for (let k = 0; k < vs.length; k++) {
        const vx = vs[k][0], vy = vs[k][1], r = vs[k][2], u = clamp((vx - s.cx) * c + (vy - s.cy) * sn, -s.hl, s.hl), qx = s.cx + u * c, qy = s.cy + u * sn;
        const dx = vx - qx, dy = vy - qy, dd = Math.sqrt(dx * dx + dy * dy), m = r + SEE_TH;
        if (r === 0 && dx * sux + dy * suy < 0 && Math.abs((vx - s.cx) * c + (vy - s.cy) * sn) < s.hl) { add([vx, vy, -(dd + m), sux, suy], 70368744177664 + i * 64 + 32 + k, u); continue; }   // (a corner that has got through to the far side: the crate and the plank are pushed apart, back to the side it is mostly on, so nothing ever stays stuck in it)
        if (dd >= m + SPEC) continue;   // (looked at a little before it touches, so a plank swinging fast can never pass through what is under or on it)
        const nx = dd > 0.0001 ? dx / dd : sux, ny = dd > 0.0001 ? dy / dd : suy;
        if (nx * sux + ny * suy < 0.3) continue;
        add([qx + nx * SEE_TH, qy + ny * SEE_TH, dd - m, nx, ny], 70368744177664 + i * 64 + k, u);
      }
      if (!isBall(d)) for (let k = 0; k < 2; k++) {   // the plank's ends poking into the side or bottom of a crate
        const e = k ? 1 : -1, qx = s.cx + e * s.hl * c, qy = s.cy + e * s.hl * sn, h = circBox(sh, qx, qy, SEE_TH + SPEC);
        if (!h || -h[4] * suy - h[3] * sux < 0.3) continue;
        add([h[0] + h[3] * h[2], h[1] + h[4] * h[2], h[2] + SPEC, -h[3], -h[4]], 70368744177664 + i * 64 + 48 + k, e * s.hl);
      }
    }
    return n;
  }
  let plankUsed = [];
  const plankMoving = (w, d) => w.see.some(s => s.moving > 0 && Math.abs(s.cx - d.x) < s.hl + 60 && Math.abs(s.cy - d.y) < s.hl + 60);
  function velAt(o, rx, ry) { return [o.vx - o.av * ry, o.vy + o.av * rx]; }
  function solveContacts(dt) {
    const inv = 1 / dt;
    for (let k = 0; k < nCT; k++) { const b = CT[k].b; if (b._wR !== wTick) { b._wR = wTick; b._wOk = b._wT === wTick - 1; const t = b._wP; b._wP = b._wN || []; b._wN = t || []; b._wN.length = 0; } }   // (how hard each touch pressed last moment, kept on the thing itself, so the next moment starts from there)
    for (let k = 0; k < nCT; k++) {
      const c = CT[k], a = c.a, b = c.b, ima = a ? a._im : 0, iia = a ? a._ii : 0, imb = b._im, iib = b._ii;
      c.rax = a ? c.px - a.x : 0; c.ray = a ? c.py - a.y : 0; c.rbx = c.px - b.x; c.rby = c.py - b.y;
      const rnA = c.rax * c.ny - c.ray * c.nx, rnB = c.rbx * c.ny - c.rby * c.nx, tx = c.ny, ty = -c.nx, rtA = c.rax * ty - c.ray * tx, rtB = c.rbx * ty - c.rby * tx;
      const kn = ima + imb + iia * rnA * rnA + iib * rnB * rnB, kt = ima + imb + iia * rtA * rtA + iib * rtB * rtB;
      c.mn = kn > 0 ? 1 / kn : 0; c.mt = kt > 0 ? 1 / kt : 0;
      c.bias = BAUM * inv * Math.max(0, -c.sep - SLOP); if (c.pp && c.bias > 300) c.bias = 300; if (c.pp && c.b._ppN > 1) c.bias = 0;   // (caught between two players: neither shoves it through the other)   // (something found inside a player is eased out of them, never flung away: on a slow connection the server can find a player overlapping things they have not really reached)
      const vAx = a ? a.vx - a.av * c.ray : c.kvx, vAy = a ? a.vy + a.av * c.rax : c.kvy, vBx = b.vx - b.av * c.rby, vBy = b.vy + b.av * c.rbx, vn = (vBx - vAx) * c.nx + (vBy - vAy) * c.ny;
      let pr = -1; if (b._wOk) { const wp = b._wP; for (let q = 0; q < wp.length; q += 3) if (wp[q] === c.key) { pr = q; break; } }
      if (c.mk) { const vt0 = (vBx - vAx) * tx + (vBy - vAy) * ty; if (Math.abs(vt0) > 40) c.mu = c.mk; }   // (something already sliding slides on more easily than it takes to get it going: a resting crate grips, a pushed one glides)
      c.vb = 0; if (c.sep > 0) c.vb = -c.sep * inv;   // (not touching yet: it may close the gap this step, but no further)
      else if (c.e > 0 && pr < 0 && vn < -c.eT) { c.vb = Math.min(c.eCap, -c.e * vn); if (c.vb < c.eMin) c.vb = 0; }   // (a bounce is only for a fresh knock, never for things already pressed together)
      if (pr >= 0) { c.Pn = b._wP[pr + 1]; c.Pt = b._wP[pr + 2]; impulse(c, c.Pn * c.nx + c.Pt * tx, c.Pn * c.ny + c.Pt * ty); }
    }
    for (let it = 0; it < VEL_IT; it++) for (let k = 0; k < nCT; k++) {
      const c = CT[k], a = c.a, b = c.b, nx = c.nx, ny = c.ny, tx = ny, ty = -nx;
      let ax = a ? a.vx - a.av * c.ray : c.kvx, ay = a ? a.vy + a.av * c.rax : c.kvy, bx = b.vx - b.av * c.rby, by = b.vy + b.av * c.rbx;
      let dP = c.mn * (-((bx - ax) * nx + (by - ay) * ny) + c.vb); const P0 = c.Pn; c.Pn = P0 + dP > 0 ? P0 + dP : 0; dP = c.Pn - P0;
      if (dP) {
        const Px = dP * nx, Py = dP * ny;
        if (a) { a.vx -= Px * a._im; a.vy -= Py * a._im; a.av -= a._ii * (c.rax * Py - c.ray * Px); ax = a.vx - a.av * c.ray; ay = a.vy + a.av * c.rax; }
        b.vx += Px * b._im; b.vy += Py * b._im; b.av += b._ii * (c.rbx * Py - c.rby * Px); bx = b.vx - b.av * c.rby; by = b.vy + b.av * c.rbx;
      }
      const mx = c.mu * c.Pn; let dT = -c.mt * ((bx - ax) * tx + (by - ay) * ty); const T0 = c.Pt, T1 = T0 + dT; c.Pt = T1 > mx ? mx : T1 < -mx ? -mx : T1; dT = c.Pt - T0;
      if (dT) {
        const Px = dT * tx, Py = dT * ty;
        if (a) { a.vx -= Px * a._im; a.vy -= Py * a._im; a.av -= a._ii * (c.rax * Py - c.ray * Px); }
        b.vx += Px * b._im; b.vy += Py * b._im; b.av += b._ii * (c.rbx * Py - c.rby * Px);
      }
    }
    for (let it = 0; it < POS_IT; it++) for (let k = 0; k < nCT; k++) {   // pushing out of overlaps is done apart from the real speeds, so it never adds bounce or jitter
      const c = CT[k]; if (!(c.bias > 0)) continue;
      const a = c.a, b = c.b;
      const vn = (b._bx - b._bw * c.rby - (a ? a._bx - a._bw * c.ray : 0)) * c.nx + (b._by + b._bw * c.rbx - (a ? a._by + a._bw * c.rax : 0)) * c.ny;
      let dP = c.mn * (-vn + c.bias); const P0 = c.Pb; c.Pb = Math.max(P0 + dP, 0); dP = c.Pb - P0;
      if (!dP) continue;
      const Px = dP * c.nx, Py = dP * c.ny;
      if (a) { a._bx -= Px * a._im; a._by -= Py * a._im; a._bw -= a._ii * (c.rax * Py - c.ray * Px); }
      b._bx += Px * b._im; b._by += Py * b._im; b._bw += b._ii * (c.rbx * Py - c.rby * Px);
    }
    for (let k = 0; k < nCT; k++) { const c = CT[k]; if (c.Pn || c.Pt) { const b = c.b; b._wN.push(c.key, c.Pn, c.Pt); b._wT = wTick; } }
  }
  function impulse(c, Px, Py) {
    const a = c.a, b = c.b;
    if (a) { a.vx -= Px * a._im; a.vy -= Py * a._im; a.av -= a._ii * (c.rax * Py - c.ray * Px); }
    b.vx += Px * b._im; b.vy += Py * b._im; b.av += b._ii * (c.rbx * Py - c.rby * Px);
  }
  /* ---------- rope bridges: tied to the edges of two pieces of dirt, sagging, swinging and giving under whatever is on them ---------- */
  const ROPE_K = 2200, ROPE_C = 10, ROPE_LOAD = 900, ROPE_SEG = 20;
  function ropeQ(q) { let a = q[1], ra = q[2], b = q[3], rb = q[4]; if (a > b) { const t = a; a = b; b = t; const u = ra; ra = rb; rb = u; } return [a, ra, b, rb]; }
  function addRope(w, q) {   // ['rope', column, row, column, row]: the two pieces of dirt it is tied to (their top edges, facing each other)
    const [a, ra, b, rb] = ropeQ(q), ax = (a + 1) * TS, ay = ra * TS, bx = b * TS, by = rb * TS, L = bx - ax; if (L < TS) return null;
    const n = Math.max(2, Math.round(L / ROPE_SEG));
    const r = { ax, ay, bx, by, L, n, sag: Math.min(TS * 0.9, L * 0.05), o: new Float64Array(n + 1), v: new Float64Array(n + 1), ld: new Float64Array(n + 1), lf: new Float64Array(n + 1), uid: hash32('r' + a + ',' + ra + ',' + b + ',' + rb), q: [a, ra, b, rb], gone: false, moving: 0 };
    (w.ropes = w.ropes || []).push(r); return r;
  }
  function ropeRest(r, u) { return r.ay + (r.by - r.ay) * u + r.sag * 4 * u * (1 - u); }   // where it hangs with nothing on it
  function ropeAt(r, x) {   // the walking surface at x: its height, slope, and how fast it is moving there
    const u = clamp((x - r.ax) / r.L, 0, 1), f = u * r.n, i = Math.min(r.n - 1, Math.floor(f)), t = f - i;
    const y0 = ropeRest(r, i / r.n) + r.o[i], y1 = ropeRest(r, (i + 1) / r.n) + r.o[i + 1];
    return { y: y0 + (y1 - y0) * t, s: (y1 - y0) / (r.L / r.n), vy: r.v[i] + (r.v[i + 1] - r.v[i]) * t, i, t };
  }
  function ropeLoad(r, x, wt) { const u = clamp((x - r.ax) / r.L, 0, 1), f = u * r.n, i = Math.min(r.n - 1, Math.floor(f)), t = f - i; r.ld[i] += wt * (1 - t); r.ld[i + 1] += wt * t; }
  function stepRopes(w, dt) {
    if (!w.ropes || !w.ropes.length) return;
    for (const r of w.ropes) {
      if (r.gone) continue;
      for (const d of w.dyn) {   // whatever rests on it weighs on it (worked out the same way everywhere, from where things are)
        if (d.burn > 0 || d.gone || d._dyn || d.x < r.ax - 40 || d.x > r.bx + 40) continue;   // (what is moving presses on it through its contacts, see below; what is at rest by where it lies)
        const e = d.r || Math.max(d.hw, d.hh), bot = d.y + (d.r || shapeOf(d).ey), s = ropeAt(r, d.x);
        if (d.x > r.ax && d.x < r.bx && bot > s.y - 6 && bot < s.y + 14 && d.y < s.y && d.vy > -150) ropeLoad(r, d.x, d.m || 1);
      }
      for (let i = 0; i <= r.n; i++) r.lf[i] += (r.ld[i] - r.lf[i]) * Math.min(1, dt * 12);   // (the weight on it, smoothed over a few steps: it settles under what rests on it instead of trembling)
      let mv = 0; const h = dt / 2;
      for (let k = 0; k < 2; k++) for (let i = 1; i < r.n; i++) {
        const acc = ROPE_K * (r.o[i - 1] + r.o[i + 1] - 2 * r.o[i]) + r.lf[i] * ROPE_LOAD - ROPE_C * r.v[i];
        r.v[i] = clamp(r.v[i] + acc * h, -400, 400); r.o[i] = clamp(r.o[i] + r.v[i] * h, -30, 90); mv = Math.max(mv, Math.abs(r.v[i]));
      }
      if (mv < 12) for (let i = 1; i < r.n; i++) r.v[i] *= mv < 4 ? 0.5 : 0.85;   // (small swaying dies away soon, so a bridge with things on it comes to rest)
      r.ld.fill(0); r.moving = mv > 10 ? 0.5 : Math.max(0, r.moving - dt);
    }
  }
  function ropeBody(b, w, wt) {   // the player (or a player's point on the server) on a rope bridge: you stand on it from above, and pass up through it from below
    if (!w.ropes || !w.ropes.length) return false;
    let on = false;
    for (const r of w.ropes) {
      if (r.gone || b.x < r.ax - 2 || b.x > r.bx + 2) continue;
      const s = ropeAt(r, b.x), foot = b.y + R, py = b._ropeY === undefined ? b.y : b._ropeY;
      if (foot < s.y - 2 || foot > s.y + 26 || py + R > s.y + 12 || b.vy < s.vy - 60) continue;   // (above it, or coming down through it this moment: never from below)
      if (!b.kin) { b.y = s.y - R; if (b.vy > s.vy) b.vy = s.vy; b.ground = true; b.gType = 1; b.flat = Math.abs(s.s) < 0.12; if (!b.flat) b.vx += s.s * 380 * (b.dt || 1 / 60); }
      ropeLoad(r, b.x, wt); on = true;
    }
    b._ropeY = b.y;
    return on;
  }
  function ropeContacts(w, d, sh) {   // a crate or ball on a rope bridge: it rests on it and rides it as it swings (only from above)
    let n = 0;
    for (const r of w.ropes) {
      if (r.gone) continue;
      const e = d.r || sh.ex; if (d.x + e < r.ax || d.x - e > r.bx) continue;
      const sc = ropeAt(r, d.x); if (d.y > sc.y) continue;   // (its middle is under it: it is not on it)
      const pts = d.r ? [[d.x, d.y + d.r]] : [[sh.x - sh.c * sh.hw + sh.s * sh.hh, sh.y - sh.s * sh.hw - sh.c * sh.hh], [sh.x + sh.c * sh.hw + sh.s * sh.hh, sh.y + sh.s * sh.hw - sh.c * sh.hh], [sh.x + sh.c * sh.hw - sh.s * sh.hh, sh.y + sh.s * sh.hw + sh.c * sh.hh], [sh.x - sh.c * sh.hw - sh.s * sh.hh, sh.y - sh.s * sh.hw + sh.c * sh.hh]];
      for (let k = 0; k < pts.length; k++) {
        const px = pts[k][0], py = pts[k][1]; if (px < r.ax || px > r.bx) continue;
        const s = ropeAt(r, px), L = Math.sqrt(1 + s.s * s.s), nx = s.s / L, ny = -1 / L, sep = (s.y - py) / L;
        if (sep > SPEC || sep < -30) continue;
        const c = addC(null, d, [px, py, sep, nx, ny], 105553116266496 + ((r.uid >>> 0) % 1000000) * 1024 + k); c.mu = 0.75; c.kvy = clamp(s.vy, -120, 120); c.rp = r; n++;   // (it rides the rope as it swings, but is never flung off it)
      }
    }
    return n;
  }
  // a few rope bridges that are simply part of the map: over real gaps between two ledges at the same height, spread out, never across a place the marked routes climb or drop through. Worked out from the map itself, so the server and every player get the very same ones
  function natRopes(w, map) {
    const W = w.W, H = w.H, G = w.grid, T = (x, y) => (x < 0 || y < 0 || x >= W || y >= H ? 1 : G[y * W + x]), cand = [];
    const nodes = []; for (const c of (map.chains || [])) for (const e of c) nodes.push(e);
    const sx = map.start ? map.start[0] / TS : -99, sy = map.start ? map.start[1] / TS : -99;
    for (let y = 6; y < H - 8; y++) for (let x = 2; x < W - 22; x++) {
      if (G[y * W + x] !== 1 || G[y * W + x + 1] !== 0 || G[(y - 1) * W + x] !== 0) continue;
      let k = 1; while (k <= 17 && T(x + k, y) === 0) k++;
      if (k < 7 || k > 17 || T(x + k, y) !== 1 || T(x + k, y - 1) !== 0) continue;   // (a gap of 6 to 16 blocks, dirt on both sides)
      let deep = true; for (let c = x + 2; c < x + k - 1 && deep; c++) for (let r = 1; r <= 4; r++) if (T(c, y + r) !== 0) { deep = false; break; }   // (a real drop under it, not a step down)
      if (!deep || !ropeOk(w, ['rope', x, y, x + k, y])) continue;
      if (Math.abs(x - sx) < 14 && Math.abs(y - sy) < 8) continue;
      let clash = false; for (let i = 0; i < nodes.length && !clash; i++) { const e = nodes[i]; if (e[0] + (e[2] || 1) > x + 1 && e[0] < x + k && e[1] > y - 5 && e[1] < y + 16) clash = true; }
      if (!clash) cand.push([x, y, x + k, hash32('n' + x + ',' + y)]);
      x += k - 1;
    }
    cand.sort((p, q) => p[3] - q[3]);
    const out = [], want = Math.max(2, Math.min(5, Math.round(W / 400)));
    for (const c of cand) { if (out.length >= want) break; if (out.some(o => Math.abs(o[0] - c[0]) < 70 && Math.abs(o[1] - c[1]) < 30)) continue; out.push(c); addRope(w, ['rope', c[0], c[1], c[2], c[1]]).nat = true; }
    w.natRopes = out.length;
  }
  function ropeOk(w, q) {   // can a rope bridge go here? both ends on the edge of dirt, at most 20 blocks across and less than 6 up or down, and nothing at all in the way
    if (!Array.isArray(q) || q.length !== 5 || !q.slice(1).every(Number.isFinite)) return false;
    const [a, ra, b, rb] = ropeQ(q), T = (x, y) => tile(w, x, y);
    if (b - a - 1 < 1 || b - a - 1 > 20 || Math.abs(rb - ra) >= 6) return false;
    if (T(a, ra) !== 1 || T(a, ra - 1) !== 0 || T(a + 1, ra) !== 0 || T(b, rb) !== 1 || T(b, rb - 1) !== 0 || T(b - 1, rb) !== 0) return false;
    const r = { ax: (a + 1) * TS, ay: ra * TS, bx: b * TS, by: rb * TS }; r.L = r.bx - r.ax; r.sag = Math.min(TS * 0.9, r.L * 0.05);
    for (let x = r.ax + 4; x <= r.bx - 4; x += 8) {
      const y = ropeRest(r, (x - r.ax) / r.L);
      for (const dy of [-60, -34, -8, 10, 40]) { const t = T(Math.floor(x / TS), Math.floor((y + dy) / TS)); if (t !== 0 && t !== 5) return false; }   // (room above to walk, and below for it to sag and swing)
      for (const s of w.see) if (!s.gone && Math.abs(x - s.cx) < s.hl + 6 && y > s.cy - 80 && y < s.cy + 60) return false;
      for (const o of w.ropes) if (!o.gone && x >= o.ax - 10 && x <= o.bx + 10 && Math.abs(ropeAt(o, x).y - y) < 60) return false;
      for (const p of w.portals) if (!p.gone && [p.a, p.b].some(e => Math.abs(e.x - x) < 40 && Math.abs(e.y - y) < 80)) return false;
      for (const p of w.pads) if (!p.gone && x > p.x * TS - 4 && x < (p.x + p.w) * TS + 4 && Math.abs(p.y * TS - y) < 50) return false;
    }
    return true;
  }
  function hasSupport(w, d, H) {   // (a resting thing checks now and then that something is still under it)
    const sh = d.r ? null : shapeOf(d), ex = d.r || sh.ex, ey = d.r || sh.ey;
    if (boxHits(w, d.x, d.y + 3, ex - 1, ey)) return true;
    if (w.ropes) for (const r of w.ropes) if (!r.gone && d.x > r.ax - ex && d.x < r.bx + ex) { const s = ropeAt(r, d.x); if (Math.abs(d.y + ey - s.y) < 10) return true; }
    for (let i = 0; i < w.see.length; i++) { const s = w.see[i]; if (Math.abs(s.cx - d.x) < s.hl + ex + 10 && Math.abs(s.cy - d.y) < s.hl + ey + 30) return true; }
    if (w.pb) for (const p of w.pb) if (Math.abs(p.x - d.x) < ex + R && p.y > d.y && p.y - R < d.y + ey + 4) return true;   // (resting on a player)
    const near = H(d.x - ex, d.y, d.x + ex, d.y + ey + 4);
    for (const o of near) { if (o === d || o.burn > 0) continue; const e = o.r || Math.max(o.hw, o.hh) * 1.42; if (Math.abs(o.x - d.x) < e + ex && o.y > d.y && o.y - e < d.y + ey + 4) return true; }
    return false;
  }
  function noBuild(map) {   // the places where nothing can be built or left: around where everybody appears (5 x 5 blocks), and around the finish flag (6 x 6), so nobody can block it
    if (!map) return [];
    if (map._nb) return map._nb;
    const z = [], st = map.start, fl = map.flag;
    if (st) { const sx = Math.floor(st[0] / TS), sy = Math.floor(st[1] / TS); z.push({ tx0: sx - 2, tx1: sx + 2, ty0: sy - 3, ty1: sy + 1, k: 's' }); }
    if (fl) { const fx = Math.floor(fl[0]), fy = Math.round(fl[1]); z.push({ tx0: fx - 1, tx1: fx + 4, ty0: fy - 5, ty1: fy, k: 'f' }); }
    try { Object.defineProperty(map, '_nb', { value: z, enumerable: false }); } catch (e) {}
    return z;
  }
  function nearZone(w, x, y) { const z = noBuild(w.map); for (let i = 0; i < z.length; i++) { const q = z[i]; if (x >= (q.tx0 - 14) * TS && x <= (q.tx1 + 15) * TS && y >= (q.ty0 - 10) * TS && y <= (q.ty1 + 10) * TS) return true; } return false; }   // (the map's own toys around the start or the finish belong there: they never burn up in it)
  function inStart(w, x, y) { const z = noBuild(w.map); for (let i = 0; i < z.length; i++) { const q = z[i]; if (x >= q.tx0 * TS && x <= (q.tx1 + 1) * TS && y >= q.ty0 * TS && y <= (q.ty1 + 1) * TS) return true; } return false; }   // (a start or finish zone)
  let dynTick = 0, hStamp = 0; const DYN_BUDGET = 600, CELL = 64, HB = [], NONE = [], BALLSH = { x: 0, y: 0 }, PCO = [];
  function stepDyn(w, dt) {
    dynTick++; wTick = w.tick = (w.tick || 0) + 1;
    stepSee(w, dt); stepRopes(w, dt);
    for (let i = 0; i < w.pads.length; i++) if (w.pads[i].t > 0) w.pads[i].t = Math.max(0, w.pads[i].t - dt);
    const L = w.dyn; if (!L.length) { turnSee(w, dt); return; }
    const f = w.focus, FR = 1100, fol = w.follow || w.pubWait;
    if (f) {   // a very busy pile near you: only the nearest few dozen things are simulated each moment, so the game stays smooth however much has been built
      const near = [];
      for (let i = 0; i < L.length; i++) { const d = L[i]; d.skip = false; if (d.burn > 0 || d.nap || !nearF(f, d.x, d.y, FR, FR)) continue; near.push(d); }
      if (near.length > DYN_BUDGET) { for (const d of near) d._pri = distF(f, d) - (d.gr && Math.abs(d.vx) + Math.abs(d.vy) < 40 ? 0 : 1e6); near.sort((a, b) => a._pri - b._pri); for (let k = DYN_BUDGET; k < near.length; k++) near[k].skip = true; }   // (only with a truly huge crowd moving at once: what is still falling or flying is always worked out, and the farthest of what is only settling waits a moment)
    }
    let pbMove = null; if (w.pb) for (const p of w.pb) { if (p._lx === undefined || Math.abs(p.x - p._lx) + Math.abs(p.y - p._ly) > 0.5) (pbMove || (pbMove = [])).push(p); p._lx = p.x; p._ly = p.y; }
    const act = [], chk = [], movingP = w.see.length ? w.see.filter(s => s.moving > 0 && !s.gone) : NONE;
    if (!w._grid || w._grid.size > 30000) { w._grid = new Map(); w._gUsed = []; }   // (which things are where, in squares of 64px: kept from moment to moment and only emptied, so nothing new has to be made each time)
    const grid = w._grid, used = w._gUsed; for (let i = 0; i < used.length; i++) used[i].length = 0; used.length = 0;
    const put = d => { const e = d.r || Math.max(d.hw, d.hh) * 1.42; for (let cx = Math.floor((d.x - e) / CELL); cx <= Math.floor((d.x + e) / CELL); cx++) for (let cy = Math.floor((d.y - e) / CELL); cy <= Math.floor((d.y + e) / CELL); cy++) { const k = (cx + 4) * 65536 + cy + 4; let g = grid.get(k); if (!g) grid.set(k, g = []); if (!g.length) used.push(g); g.push(d); } };
    const H = (x0, y0, x1, y1) => { const r = HB; r.length = 0; const st = ++hStamp; for (let cx = Math.floor(x0 / CELL); cx <= Math.floor(x1 / CELL); cx++) for (let cy = Math.floor(y0 / CELL); cy <= Math.floor(y1 / CELL); cy++) { const g = grid.get((cx + 4) * 65536 + cy + 4); if (g) for (let j = 0; j < g.length; j++) { const o = g[j]; if (o._hT !== st) { o._hT = st; r.push(o); } } } return r; };
    let farAwake = false; if (f) for (let i = 0; i < L.length; i++) { const d = L[i]; if (!d.nap && !(d.burn > 0) && !nearF(f, d.x, d.y, FR, FR)) { farAwake = true; break; } }   // (unless something far away is still moving: then everything is looked at, so it bumps into what is there)
    for (let i = 0; i < L.length; i++) {
      const d = L[i]; d._i = i; d._dyn = false;
      if (d.burn > 0) { if (d.burn < 1e8) { d.burn -= dt; if (d.burn <= 0) { d.x = d.hx; d.y = d.hy; d.vx = d.vy = 0; d.av = 0; d.rot = 0; } } continue; }
      if (d.im === undefined) { const I = d.r ? 0.5 * d.m * d.r * d.r : d.m * (d.hw * d.hw + d.hh * d.hh) / 3; d.im = 1 / d.m; d.ii = d.kind === 5 || d.kind === 6 ? 0 : 1 / I; if (d.av === undefined) d.av = 0; }
      if (d.sq > 0) d.sq = Math.max(0, d.sq - dt);
      d._far = !!f && !nearF(f, d.x, d.y, FR, FR);
      if (!d._far || !d.nap || farAwake || nearF(f, d.x, d.y, FR + 300, FR + 300)) put(d);   // (what rests far from everybody is not even looked at: nothing near anybody can touch it)
      if (d._far && !d.nap) { d.farT = (d.farT || 0) + dt; if (d.farT > 30) { d.nap = true; d.vx = d.vy = 0; d.av = 0; } } else d.farT = 0;   /* (with nobody near, nothing keeps moving for more than 30 seconds: anything still going by then is simply put to rest) */
      if (d._far && d.nap) { d.sleep = true; continue; }   // far from everybody and at rest: nothing to work out
      if (d.ownT > 0) { d.ownT -= dt; d.sleep = true; continue; }   /* (on the server: a player's device is working this one out and saying where it is) */
      if (d.skip) { d.sleep = true; continue; }   // (far away but still moving: it carries on until it comes to rest, whether anybody is watching or not)
      if (fol && w.seeOwned && !(d.mineT > 0) && !(d.hold > 0) && onOwnedPlank(w, d)) { d.mineT = 0.3; d.nap = false; }   // (what rides on a plank this device is turning is worked out here too, so they move together)
      if (fol && !(d.mineT > 0 || d.keep > 0 || d.coast || d.pred > 0)) { d.sleep = true; continue; }
      if (fol && w.see.length && !d.coast) claimPlanks(w, d);   // (and a plank that something this device is moving is touching is turned here too: the two are worked out together, never one here and one on the server)   /* (in the shared world nothing moves here by itself, not even before the server has said where it is) */   // (in the shared world: only what you are touching is worked out here, at once; everything else is shown where the server has it)
      d.sleep = false;
      if (d.nap && movingP.length && movingP.some(s => Math.abs(s.cx - d.x) < s.hl + 60 && Math.abs(s.cy - d.y) < s.hl + 80)) { d.nap = false; d.st = 0; }   // (a plank that moves wakes what rests on it)
      if (d.nap && w.ropes.length && w.ropes.some(r => r.moving > 0 && !r.gone && d.x > r.ax - 40 && d.x < r.bx + 40 && Math.abs(ropeAt(r, d.x).y - d.y) < 90 && Math.abs(ropeAt(r, d.x).vy) > 15)) { d.nap = false; d.st = 0; }   // (and so does a rope bridge that swings)
      if (d.nap && pbMove && pbMove.some(p => Math.abs(p.x - d.x) < (d.r || d.hw * 1.42) + R + 6 && Math.abs(p.y - d.y) < (d.r || d.hw * 1.42) + R + 6)) { d.nap = false; d.st = 0; }   // (a player moving right by something resting on them or against them wakes it: it falls or rolls the moment they move away)
      if (d.nap) { if (!d._far && (dynTick + i) % 15 === 0) chk.push(d); continue; }
      d._dyn = true; act.push(d);
    }
    for (const d of chk) if (!hasSupport(w, d, H)) { d.nap = false; d.st = 0; d._dyn = true; act.push(d); }   // (something resting checks now and then that it is still held up)
    w.nAct = act.length;
    if (!act.length) { turnSee(w, dt); return; }
    nCT = 0; plankUsed = [];
    const S = o => { if (o.r) return BALLSH; if (o._shT !== wTick || o._sh === null) { o._sh = shapeOf(o); o._shT = wTick; } return o._sh; };   // (a ball needs no shape worked out: it is just its middle and its size)
    const wake = [], lavaOf = new Set();
    for (const d of act) d._spr = 0;
    for (const d of act) {   // gravity, then every contact
      d.vy = Math.min(900, d.vy + GRAV * dt);
      d._im = d.im; d._ii = d.ii; d._bx = d._by = d._bw = 0; d._pl = false;
      const sh = S(d);
      if (tileContacts(w, d, sh)) lavaOf.add(d);
      if (w.see.length && plankContacts(w, d, sh)) d._pl = true;
      if (w.ropes.length) ropeContacts(w, d, sh);
      const e = d.r || Math.max(sh.ex, sh.ey);
      d._ppN = 0;
      if (w.pb && !d.coast) for (let q = 0; q < w.pb.length; q++) {   // a player's ball is solid to everything: nothing is pushed into it or squeezed into it, however much is piled around (only the player's own moving pushes things, as before)
        const pb = w.pb[q]; if (Math.abs(pb.x - d.x) > e + R + 4 || Math.abs(pb.y - d.y) > e + R + 4) continue;
        const px = pb._px || (pb._px = { k: 'o', r: R, x: 0, y: 0, vx: 0, vy: 0, av: 0, kind: -1, uid: (0xFFFFF000 + q) >>> 0, _im: 0, _ii: 0, _bx: 0, _by: 0, _bw: 0, m: PM });
        px.x = pb.x; px.y = pb.y; const n0 = nCT;
        SPECX = 10; const hit = pairContacts(d, px, sh, px, false, w); SPECX = BSPEC;   // (looked at well before it touches, so even something dropping fast stops on the player instead of sinking in)
        if (hit) { d._ppN++; for (let k = n0; k < nCT; k++) { CT[k].pp = true; CT[k].mu = 0; } }
      }
      for (const o of H(d.x - e - 2, d.y - e - 2, d.x + e + 2, d.y + e + 2)) {
        if (o === d || o.burn > 0) continue;
        if (o._dyn && o._i < d._i) continue;   // (each pair once)
        const oe = o.r || Math.max(o.hw, o.hh) * 1.42; if (Math.abs(o.x - d.x) > e + oe + 2 || Math.abs(o.y - d.y) > e + oe + 2) continue;
        if (o._dyn) { pairContacts(d, o, sh, S(o), true, w); continue; }
        o._im = 0; o._ii = 0;
        if (pairContacts(d, o, sh, S(o), false, w)) {   // touching something that is resting (or, in the shared world, something the server is moving): it wakes up if this is moving
          const moving = Math.abs(d.vx) + Math.abs(d.vy) > 25 || Math.abs(d.av) > 1.5;   // (only something really moving wakes what it touches: a pile that is just settling does not keep waking itself up)
          if (moving && o.nap) wake.push(o);
          if (moving && fol && !w.srvOnly && o.sv !== undefined && !(o.mineT > 0 || o.keep > 0)) { o.mineT = 0.45; o.keep = 1.5; }
          else if (moving && fol && w.srvOnly && d.pred > 0 && o.sv !== undefined && !(o.hold > 0)) { o.pred = Math.max(o.pred || 0, 0.5); o.sleep = false; }   // (what you push into something else moves that too, right away on your screen)
        }
      }
    }
    solveContacts(dt);
    for (const pa of plankUsed) { const sp = pa.s; sp._T = 0; if (!sp.kin && pa._ii) sp.av = pa.av; }
    for (let k = 0; k < nCT; k++) { const c = CT[k]; if (c.rp && c.Pn > 0) ropeLoad(c.rp, c.px, Math.min(8, c.Pn / (dt * GRAV))); }   // (what rests on a rope bridge presses on it exactly as hard as the bridge holds it up)
    for (let k = 0; k < nCT; k++) { const c = CT[k]; if (!c.pl) continue; const tx = c.ny, ty = -c.nx, Px = c.Pn * c.nx + c.Pt * tx, Py = c.Pn * c.ny + c.Pt * ty; c.pl._T += -(c.rax * Py - c.ray * Px); }
    for (const pa of plankUsed) { const sp = pa.s; sp.leave = (sp.ang >= SEE_MAX - 1e-6 && sp._T < -1) || (sp.ang <= -SEE_MAX + 1e-6 && sp._T > 1); }   // (a plank resting at one end only lifts off when what is on it now pushes it the other way)
    plankUsed = [];
    for (const d of act) {   // move
      if (Math.abs(d.vx) > MAXSPD) d.vx = Math.sign(d.vx) * MAXSPD; if (Math.abs(d.av) > MAXAV) d.av = Math.sign(d.av) * MAXAV;
      d._x0 = d.x; d._y0 = d.y;
      d.x += (d.vx + d._bx) * dt; d.y += (d.vy + d._by) * dt; d.rot += (d.av + d._bw) * dt;
      d.gr = false; d.touch = false; d._onP = false; d.onp = d._pl; d._ice = false; d._pad = null; d._N = 0; d._F = 0;
    }
    for (let k = 0; k < nCT; k++) {   // what each thing is resting on
      const c = CT[k];
      if (c.sep > 0.5 && !(c.Pn > 0)) continue;   // (a contact that is only being watched for: nothing rests on it yet)
      if (c.ny < -0.5) { c.b.gr = true; if (c.Pn > 0) c.b.touch = true; if (!c.a && !c.pl) { const t = tile(w, Math.floor((c.px - c.nx) / TS), Math.floor((c.py - c.ny * 2) / TS)); if (t === 3) c.b._ice = true; } }
      if (c.a && c.ny > 0.5) { c.a.gr = true; c.a.touch = true; }
      if (c.a && Math.abs(c.nx) > 0.5 && c.Pn > 0) { c.a.touch = true; c.b.touch = true; }
      if (c.ny < -0.5 && c.Pn > 0) { c.b._N += -c.ny * c.Pn / dt; c.b._F += c.mu * c.Pn / dt; }   // (how hard it is pressed onto what is under it, and how much that grips)
    }
    for (const d of act) {
      if (isBall(d) && d.gr) {   // a ball on the ground rolls: it turns the way it is going (never spun backwards by whatever it touches), coasts, slows down and comes to rest. On ice it slides
        if (d._ice) d.av *= Math.max(0, 1 - 0.2 * dt);
        else { d.vx *= Math.max(0, 1 - 0.9 * dt); d.vx = approach(d.vx, 0, 55 * dt); d.av = d.vx / d.r; }
      } else if (!d.gr) d.av *= (1 - 0.05 * dt);
      if (w.see.length) seeGuard(w, d, d.r || shapeOf(d).ey);
      if (w.pads.length && d.gr) { const pd = padAt(w, d.x, d.y + (d.r || shapeOf(d).ey)); if (pd) { d.vx = approach(d.vx, pd.dir * PAD_V * 0.8, 6000 * dt); pd.t = 0.3; d._pad = pd; } }
      if (w.portals.length) { d.pcd = Math.max(0, (d.pcd || 0) - dt); if (Math.abs(d.vx) > 15) d.pdir = d.vx > 0 ? 1 : -1;
        if (!d.pcd && d.vy > -60 && d.gr) { const ey = d.r || shapeOf(d).ey, pt = portalAt(w, d.x, d.y + ey); if (pt) { const dir = d.pdir || 1, hf = d.r || d.hw; d.x = pt.to.x + dir * (26 + hf); d.y = pt.to.y - ey - 2; d.vx = dir * 260; d.vy = -300; d.pcd = 0.6; w.ev.push({ k: 'portal', x: pt.from.x, y: pt.from.y, x2: pt.to.x, y2: pt.to.y }); } } }
      d.dm = Math.abs(d.x - d._x0) + Math.abs(d.y - d._y0);
      const still = d.vx * d.vx + d.vy * d.vy < LIN_SLEEP * LIN_SLEEP && Math.abs(d.av) < ANG_SLEEP && (d._far || ((!d._pl || !plankMoving(w, d)) && !d._pad));
      d.st = still ? (d.st || 0) + dt : 0;
      const burn = lavaOf.has(d);
      if (burn || d.y > killYAt(w, d.x) || d.x < 0 || d.x > w.W * TS || d.y < 0 || inStart(w, d.x, d.y)) {   /* (lava, off the map, or into the start zone, where nothing may be left: it burns up for good) */ d.bx = d.x; d.by = d.y; d.bl = burn || inStart(w, d.x, d.y) ? 1 : 0; d.bfx = 0; d.burn = 1e9; d.x = -99999; d.y = -99999; d.vx = d.vy = 0; d.av = 0; d.st = 0; }   // lost for good: this map will not give it back
    }
    // a pile goes to sleep together, once every piece of it has been still for a moment
    const root = d => { while (d._uf !== d) { d._uf = d._uf._uf; d = d._uf; } return d; };   // (which pile each thing belongs to: every thing points the way to its pile's first piece)
    for (const d of act) { d._uf = d; d._isl = 1e9; }
    for (let k = 0; k < nCT; k++) { const c = CT[k]; if (c.a && c.a._dyn) { const ra = root(c.a), rb = root(c.b); if (ra !== rb) ra._uf = rb; } }
    for (const d of act) { if (d.burn > 0) continue; const r = root(d), v = d.st || 0; if (v < r._isl) r._isl = v; }
    for (const d of act) { if (d.burn > 0) continue; if (root(d)._isl >= SLEEP_T) { d.nap = true; d.vx = d.vy = 0; d.av = 0; } }
    for (const o of wake) { o.nap = false; o.st = 0; }
    turnSee(w, dt);
  }
  // the player's ball against the crates and balls. b.kin: the ball cannot be moved here (the server only follows where each player says they are)
  function collideDyn(b, w) {
    const L = w.cand || w.dyn, kin = !!b.kin; let sL = 0, sR = 0, sU = 0;   // (held up from the left and from the right at once: sitting in a V)
    for (let i = 0; i < L.length; i++) {
      const d = L[i];
      if (d.burn > 0 || Math.abs(d.x - b.x) > 110 || Math.abs(d.y - b.y) > 110) continue;
      if (b.remote && !(d.mineT > 0 || d.keep > 0)) continue;   // (another player, as this device sees them: they only push what this device is moving for everybody)
      let h;
      if (d.k === 'b') { h = circBox(shapeOf(d), b.x, b.y, R); if (!h) continue; }
      else { const dx = b.x - d.x, dy = b.y - d.y, d2 = dx * dx + dy * dy, rr = R + d.r; if (d2 >= rr * rr) continue; const dd = Math.sqrt(d2) || 0.001; h = [d.x + dx / dd * d.r, d.y + dy / dd * d.r, dd - rr, d2 ? dx / dd : 0, d2 ? dy / dd : -1]; }
      const pen = -h[2], nx = h[3], ny = h[4]; if (pen <= 0) continue;
      if (w.follow && !w.srvOnly && !(d.hold > 0) && !b.remote) { d.mineT = 0.45; d.sleep = false; }
      if (w.follow && w.srvOnly && !(d.hold > 0) && !b.remote && !kin && d.sv !== undefined && (d.pred > 0 || !(d.r && ny < -0.7))) { if (!(d.pred > 0))   /* (a ball you land on top of is not guessed at here: a hair's difference decides which way it rolls, so the server's word is waited for and it never rolls one way and then the other) */ { d.nap = false; d.st = 0; d.predA = 0; } d.pred = 0.7; d.predT = 0.25; d.sleep = false; }   // (what you touch reacts on your screen at once, worked out here by the same physics, while the server, which decides, catches up a moment later)
      if (d.im === undefined) { const I = d.r ? 0.5 * d.m * d.r * d.r : d.m * (d.hw * d.hw + d.hh * d.hh) / 3; d.im = 1 / d.m; d.ii = d.kind === 5 || d.kind === 6 ? 0 : 1 / I; if (d.av === undefined) d.av = 0; }
      const held = (w.follow && ((w.srvOnly && !(d.pred > 0)) || d.hold > 0)) || (b.own !== undefined && d.ownT > 0);   // (in the shared world every crate and ball is the server's: here it is as solid as a wall, and moves the moment the server has moved it, the same for everybody)
      if (held && w.follow && !kin && !b.remote && Math.abs(nx) > 0.5 && nx * (b.inVx || 0) < 0) b.pressing = true;
      else if (!held && d.pred > 0 && w.follow && !kin && !b.remote && Math.abs(nx) > 0.5 && nx * (b.inVx || 0) < 0) b.pushing = true;   // (pushing something your own screen moves: the server is told, so it pushes it just as far)   // (the server's crate and yours disagree: it is a wall until they agree again. On the server: the player's own device is already pushing this one)
      const rx = h[0] - d.x, ry = h[1] - d.y, rn = rx * ny - ry * nx, rt = rx * -nx - ry * ny;
      const vbx = d.vx - (d.av || 0) * ry, vby = d.vy + (d.av || 0) * rx, vy0 = b.vy;
      const vn = (b.vx - vbx) * nx + (b.vy - vby) * ny;
      let free = !held;
      if (free && d.nap) { if (vn < -60 || (ny > -0.6 && vn < -12)) { d.nap = false; d.st = 0; } else free = false; }   // (something resting is only woken by a real knock or push, not by you standing on it)
      if (vn < 0) {
        const im = free ? d.im : 0, ii = free ? d.ii : 0, e = d.k === 'o' && vn < -120 ? 0.15 : 0;
        const pm = Math.abs(nx) > 0.5 ? PM_PUSH : PM;   // (you weigh as much as four small crates)
        const K = 1 / pm + im + ii * rn * rn, jf = -(1 + e) * vn / K;
        // rolling into something is a push: it gets going over a moment, together with whatever is riding on it (the more there is, the harder it is to get going). Flying into it is a knock
        const load = Math.max(d.m, (d._N || 0) / GRAV), soft = vn > -330 && b.vx * b.vx + b.vy * b.vy < 330 * 330 && free;
        let cap = 1e9;
        if (soft) {
          cap = F_PUSH * (b.dt || 1 / 60);   // (how hard you can push)
          const vlim = MAXV / (1 + 0.08 * (d.m - 1) + 0.2 * Math.max(0, load - d.m)), vb = -(vbx * nx + vby * ny), kb = im + ii * rn * rn;   // (and a heavy load only goes so fast)
          if (Math.abs(nx) > 0.5 && kb > 0) cap = Math.min(cap, Math.max(0, (vlim - vb) / kb));
        }
        const j = Math.min(jf, cap);
        if (free) { d.vx -= j * nx * im; d.vy -= j * ny * im; d.av -= j * rn * ii; if (vn < -40 || (Math.abs(nx) > 0.5 && Math.abs(b.vx) > 20)) d.st = 0; }   // (only a real knock or push keeps it from settling: just standing or leaning on a pile lets it come to rest under you)
        b.vx += j * nx / pm; b.vy += j * ny / pm;
        if (free && d.k === 'o' && j > 0) {   // your ball grips a ball it pushes, the way two rolling balls do (so one squeezed between you and another never gets spun backwards into you)
          const tx = ny, ty = -nx, wp = b.vx / R, px = -wp * (-ny * R), py = wp * (-nx * R);   // (your ball rolls: its surface where they touch moves with its spin)
          const vt = ((d.vx - (d.av || 0) * ry) - (b.vx + px)) * tx + ((d.vy + (d.av || 0) * rx) - (b.vy + py)) * ty, rt = rx * ty - ry * tx, kt = im + ii * rt * rt;
          if (kt > 0) { const jt = clamp(-vt / kt, -0.4 * j, 0.4 * j); d.vx += jt * tx * im; d.vy += jt * ty * im; d.av += jt * rt * ii; }
        }
        if (free && d.k === 'o' && d.gr && Math.abs(nx) > 0.5) d.av = d.vx / d.r;   // (a ball you push along the ground rolls the way it is pushed, never skidding on with its old spin)
        if (j < jf) { const vn2 = (b.vx - (d.vx - (d.av || 0) * ry)) * nx + (b.vy - (d.vy + (d.av || 0) * rx)) * ny; if (vn2 < 0) { b.vx -= vn2 * nx; b.vy -= vn2 * ny; } }   // (and you are held back to its pace)
      }
      if (kin) { if (vn < -5 || pen > 6) { const qx = b.x + nx * pen, qy = b.y + ny * pen; if (!boxHits(w, qx, qy, R - 3, R - 3)) { b.x = qx; b.y = qy; } } }   // (the server's idea of where a player is never goes through a crate it moves into: it stays against it, as the player's own ball does. What only rests on or leans against the player leaves it where it is, and it is never pushed into the ground)
      else {
        if (ny > 0.5 && free && !d.nap) {   // the thing is above you: it is lifted off you (so nothing can pin you down); only a ceiling stops you
          const sh = d.r ? null : shapeOf(d), ex = d.r || sh.ex, ey = d.r || sh.ey;
          if (!boxHits(w, d.x - nx * pen, d.y - ny * pen, ex - 2, ey - 2)) { d.x -= nx * pen; d.y -= ny * pen; } else { b.x += nx * pen; b.y += ny * pen; if (b.vy < 0) b.vy = 0; }
        } else if (!boxHits(w, b.x + nx * pen, b.y + ny * pen, R - 3, R - 3)) { b.x += nx * pen; b.y += ny * pen; }
        else {   // pressed against a wall: you are never pushed into it (and so never squeezed out over the top of it). The crate stops against you instead, or you simply stay pressed between them
          const sh = d.r ? null : shapeOf(d), ex = d.r || sh.ex, ey = d.r || sh.ey;
          if (free && !boxHits(w, d.x - nx * pen, d.y - ny * pen, ex - 2, ey - 2)) { d.x -= nx * pen; d.y -= ny * pen; }
          const vd = d.vx * nx + d.vy * ny; if (free && vd > 0) { d.vx -= vd * nx; d.vy -= vd * ny; }
        }
      }   // (on the server a player only overlapping something, without moving into it, never moves it: their device and the server can differ by a pixel or two, and that must not make things creep)
      if (ny < 0.3) { if (nx < -0.1) sL = 1; else if (nx > 0.1) sR = 1; if (ny < -0.3) sU = 1; }
      if (ny < -0.6) {   // standing on it
        b.ground = true; if (ny < -0.92) { b.flat = true; b.gType = 1; }
        if (d.k === 'b' && (d.kind === 5 || d.kind === 6) && vy0 >= 0) { b.bnc = true; if (d.kind === 6) b.bncV = SUPER_BOUNCE; d.sq = 0.25; }   // a spring: land on it (or roll onto it) and it throws you up (a super spring: very high)
      }
      d.touch = true;
    }
    if (sL && sR && sU) { b.ground = true; b.flat = true; b.gType = 1; }   // (resting in a V between two things is as good as level ground: you sit still)
  }

  const SUPER_BOUNCE = 1900, OBJ_BOUNCE = 950, OBJ_SUPER = 1500;   // a super spring throws you about 900px up (more than 20 tiles)
  const ACC = 1800;   // about 0.15 s to top speed: crisp, but a very short tap still only moves you a few pixels
  const SJ_MUL = 1.42, JM_FILL = 0.345, JM_DRAIN = 7, JM_GRACE = 0.13, JM_HOLD = 0.2;   // the tall jump is about twice as high (height grows with speed squared). Two quick jumps fill the meter; it waits half a second at full
  const BOOST_T = 1.6, BOOST_V = MAXV * 2;   // seconds of steady rolling to fill the ring, and the boosted top speed (double)
  const ev = { lava: false, jumped: false, landed: false, bounced: false, splat: false, boosted: false, superJump: false, pad: false, portal: false };

  /* ---------- floor boosters: a strip set into the ground that throws whatever rolls over it ---------- */
  const PAD_V = MAXV * 2.1;
  function padAt(w, x, bottom) {
    for (let i = 0; i < w.pads.length; i++) { const q = w.pads[i], fy = q.y * TS; if (x > q.x * TS - 4 && x < (q.x + q.w) * TS + 4 && bottom >= fy - 5 && bottom <= fy + 6) return q; }
    return null;
  }
  function addPad(w, q) { const p = { x: q[0], y: q[1], w: 2, dir: q[2] < 0 ? -1 : 1, t: 0 }; w.pads.push(p); return p; }
  /* ---------- portals: two holes in the ground, joined. Whatever goes into one comes out of the other, thrown to the side it was last heading ---------- */
  function addPortal(w, q) { const p = { a: { x: (q[1] + 1) * TS, y: q[2] * TS }, b: { x: (q[3] + 1) * TS, y: q[4] * TS }, c: Math.max(0, Math.min(3, q[5] | 0)) };   // (c: which colours this pair is: each pair goes only to its own other half)
 w.portals.push(p); return p; }
  function portalAt(w, x, bottom) {
    for (let i = 0; i < w.portals.length; i++) { const p = w.portals[i];
      if (Math.abs(x - p.a.x) < 26 && bottom >= p.a.y - 6 && bottom <= p.a.y + 12) return { from: p.a, to: p.b };
      if (Math.abs(x - p.b.x) < 26 && bottom >= p.b.y - 6 && bottom <= p.b.y + 12) return { from: p.b, to: p.a }; }
    return null;
  }
  // ax: -1/0/1, jheld: jump button held. Set b.jbuf = 0.12 on a jump press.
  function step(b, w, ax, jheld, dt) {
    b.inVx = ax * (b.boost ? BOOST_V : MAXV); b.pressing = false; b.pushing = false;   // (how fast you are trying to go: when a shared crate holds you back, the server is told this, and pushes it for you)
    ev.lava = false; ev.jumped = false; ev.landed = false; ev.bounced = false; ev.splat = false; ev.boosted = false; ev.superJump = false; ev.pad = false; ev.portal = false;
    const tx = Math.floor(b.x / TS), ty = Math.floor(b.y / TS);
    const water = tile(w, tx, ty) === 5;
    b.water = water;
    b.swimCool = Math.max(0, b.swimCool - dt);
    b.jbuf = Math.max(0, b.jbuf - dt);
    const wasGround = b.ground, preVy = b.vy;
    if (w.pads.length && b.ground && !water) { const pd = padAt(w, b.x, b.y + R); if (pd) { b.vx = approach(b.vx, pd.dir * PAD_V, 9000 * dt); b.padHit = true; if (pd.t <= 0) { ev.pad = true; w.ev.push({ k: 'pad', x: (pd.x + pd.w / 2) * TS, y: pd.y * TS }); } pd.t = 0.3; } }

    if (water) {
      // swimming: slow, floaty. Hold jump to swim up; at the surface it hops you out.
      b.vx = approach(b.vx, ax * 190, (ax ? 650 : 400) * dt);
      const surface = tile(w, tx, ty - 1) !== 5;
      if (jheld || b.jbuf > 0) {
        if (surface) {
          if (b.swimCool <= 0) { b.vy = -520; b.swimCool = 0.35; b.jbuf = 0; ev.jumped = true; }
          else b.vy = approach(b.vy, -40, 1500 * dt);
        } else b.vy = approach(b.vy, -210, 2600 * dt);
      } else b.vy = approach(b.vy, 140, 1200 * dt);
      b.coyote = 0; b.boost = false; b.hold = 0; b.bcharge = 0; b.bReq = false;
    } else {
      const ice = b.flat && b.gType === 3;
      // Grip only when the ball's centre is over the tile. Ice: slippery, but pushing the
      // other way brakes you fairly quickly.
      // ax may be fractional (a gentle swipe = a slow roll). A short tap builds speed gradually, so it barely moves you.
      const turning = ax !== 0 && b.vx !== 0 && Math.sign(b.vx) !== Math.sign(ax);
      const rate = b.flat ? (ice ? (ax ? 520 : 90) : (ax ? (turning ? 2600 : ACC) : 1500)) : (ax ? 1100 : 140);
      let target = (ax && Math.sign(b.vx) === Math.sign(ax) && Math.abs(b.vx) > MAXV) ? b.vx : ax * MAXV;
      // boost: keep rolling the same way long enough and a ring fills; once it is full you can launch (button, pull, or automatically)
      const dir = ax > 0 ? 1 : ax < 0 ? -1 : 0;
      if (b.ground && dir && dir !== b.hdir) { b.hdir = dir; b.hold = 0; }
      if (!b.boost && b.ground) {   // the ring only fills while you roll along the ground; in the air it just keeps what it has
        if (dir && dir === b.hdir && Math.sign(b.vx) === dir && Math.abs(b.vx) > MAXV * 0.8) b.hold = Math.min(BOOST_T, b.hold + dt);
        else b.hold = Math.max(0, b.hold - dt * 2);
      }
      b.bcharge = b.hold / BOOST_T;
      if (!b.boost && b.bcharge >= 1 && dir && dir === b.hdir && (b.bReq || b.bAuto)) { b.boost = true; b.bdir = dir; b.btime = 0; b.hold = 0; b.bcharge = 0; ev.boosted = true; }
      b.bReq = false;
      let brate = rate;
      if (b.boost) {
        b.btime += dt;
        if (!dir || dir !== b.bdir) b.boost = false;
        else { target = dir * BOOST_V; brate = b.flat ? 2400 : 1500; if (b.btime > 0.25 && Math.abs(b.vx) < MAXV + 20) b.boost = false; }
      }
      b.vx = approach(b.vx, target, (b.boost ? brate : rate) * dt);
      b.coyote = b.ground ? 0.1 : Math.max(0, b.coyote - dt);
      // The jump meter: three perfect jumps in a row (full height, each started within a split second of landing) fill it. Jump again straight away while it is full and you get the extra tall jump.
      // Jump while it is full and you get an extra tall jump. Wait too long and it drains away. (Only your own ball has a meter.)
      b.holdLeft = Math.max(0, (b.holdLeft || 0) - dt);
      b.sjReq = Math.max(0, (b.sjReq || 0) - dt);   // (with a separate power-jump button: only a tap on that button, not the normal jump, uses the full meter)
      if (!b.noJm) {
        if (b.ground) {
          b.jmt += dt;
          if (b.jm >= 1) { if (b.jmt > JM_HOLD) b.jm = Math.max(0, b.jm - 3 * dt); }
          else if (b.jmt > JM_GRACE) b.jm = Math.max(0, b.jm - JM_DRAIN * dt);
        } else b.jmt = 0;   // frozen while you are in the air
      }
      if (b.jbuf > 0 && b.coyote > 0) {
        const sup = !b.noJm && b.jm >= 1 && (!b.sjSep || b.sjReq > 0);
        b.vy = sup ? -JUMP * SJ_MUL : -JUMP; b.coyote = 0; b.jbuf = 0; b.ground = false; ev.jumped = true;   // (a boost carries on through a jump)
        if (sup) { b.holdLeft = 2; b.jm = 0; b.jfill = false; ev.superJump = true; }   // the tall jump always gets its full height
        else if (!b.noJm) { b.jfill = true; b.jm0 = b.jm; b.jy0 = b.y; }   // the meter now fills as the jump climbs
        b.jmt = 0;
      }
      if (b.vy >= 0 || b.ground) b.launched = false;
      const g = GRAV * ((b.vy < 0 && !jheld && !b.launched && !b.ground && !(b.holdLeft > 0)) ? 7 : 1);   // (only in the air: rolling up a slope or a corner also has a tiny upward speed, and must not be slammed down)
         // let go early = tiny hop, hold = full jump
      b.vy = Math.min(MAXFALL + clamp((b.fall - 1.2) * 420, 0, 950), b.vy + g * dt);   // fall for long enough and you keep getting faster
    }

    b.x += b.vx * dt; b.y += b.vy * dt;
    if (b.jfill) { if (b.ground) b.jfill = false; else b.jm = Math.max(b.jm, Math.min(1, b.jm0 + JM_FILL * clamp((b.jy0 - b.y - 130) / 70, 0, 1))); }   // only a full-height jump fills the meter (a third of it), and only if you jump again within a split second of landing: three perfect jumps in a row make the tall one   // two full-height jumps fill the whole meter; a small hop fills a little
    b.rot += (b.vx * dt) / R;
    b.bnc = false; b.bncV = 0; b.onSee = null;
    if (Math.abs(b.vx) > 15) b.pdir = b.vx > 0 ? 1 : -1;
    b.pcd = Math.max(0, (b.pcd || 0) - dt);
    ev.lava = collide(b, w);
    if (w.portals.length && !b.ghost && !b.pcd && b.vy > -60) { const pt = portalAt(w, b.x, b.y + R); if (pt) { const dir = b.pdir || 1; b.x = pt.to.x + dir * 36; b.y = pt.to.y - R - 2; b.vx = dir * Math.max(300, Math.abs(b.vx)); b.vy = -340; b.ground = false; b.flat = false; b.pcd = 0.6; b.fall = 0; b.launched = true; ev.portal = true; w.ev.push({ k: 'portal', x: pt.from.x, y: pt.from.y, x2: pt.to.x, y2: pt.to.y }); } }
    b.dt = dt; if (!b.ghost && w.dyn.length) collideDyn(b, w);
    if (w.see.length) { seeBody(b, w, PLAYER_WT); if (!b.ghost) seeGuard(w, b, R); }
    if (w.ropes.length && !b.ghost) ropeBody(b, w, PLAYER_WT / 60);
    const wet = water || tile(w, Math.floor(b.x / TS), Math.floor(b.y / TS)) === 5 || tile(w, Math.floor(b.x / TS), Math.floor((b.y + R * 0.8) / TS)) === 5;   // (checked again after moving: you can land in a shallow pool in the very same step)
    if (b.ground || wet) { if (!wasGround && !wet && !b.bnc && b.fall >= FALL_DIE) ev.splat = true; b.fall = 0; }
    else if (b.vy > 300) b.fall += dt; else if (b.vy < 0) b.fall = 0;
    if (b.bnc && !water) { b.bnc = false; b.vy = -(b.bncV || (jheld ? BOUNCE_HELD : BOUNCE)); b.launched = true; b.ground = false; b.coyote = 0; ev.bounced = true; }
    if (!wasGround && b.ground && preVy > 380 && !wet) ev.landed = true;
    return ev;
  }

  const SOLIDT = t => t === 1 || t === 3 || t === 4 || t === 6 || t === 9;
  function maxPen(w, x, y, rad, list) {   // (for checking) the deepest that any two crates or balls near here are into each other
    const L = (list || w.dyn).filter(d => !(d.burn > 0) && !d.gone && Math.abs(d.x - x) < rad && Math.abs(d.y - y) < rad); let best = [0, 0, 0];
    for (let i = 0; i < L.length; i++) for (let j = i + 1; j < L.length; j++) {
      const A = L[i], B = L[j], e = (A.r || A.hw * 1.42) + (B.r || B.hw * 1.42); if (Math.abs(A.x - B.x) > e || Math.abs(A.y - B.y) > e) continue;
      const out = [];
      if (!isBall(A) && !isBall(B)) obbHit(shapeOf(A), shapeOf(B), 0, out);
      else if (isBall(A) && isBall(B)) { const dd = Math.hypot(B.x - A.x, B.y - A.y) - A.r - B.r; if (dd < 0) out.push([0, 0, dd]); }
      else { const bx = isBall(A) ? B : A, bl = isBall(A) ? A : B, h = circBox(shapeOf(bx), bl.x, bl.y, bl.r); if (h) out.push(h); }
      for (const h of out) if (-h[2] > best[0]) best = [-h[2], A.uid >>> 0, B.uid >>> 0];
    }
    return best;
  }
  function bodyOverlaps(w, x0, y0, x1, y1, pad) {   // is any crate or ball on this box?
    for (let i = 0; i < w.dyn.length; i++) { const d = w.dyn[i]; if (d.burn > 0) continue; const e = d.r || d.hw; if (d.x + e > x0 - (pad || 0) && d.x - e < x1 + (pad || 0) && d.y + e > y0 - (pad || 0) && d.y - e < y1 + (pad || 0)) return true; }
    return false;
  }
  /* ---------- removing something for good (the delete tool) ----------
     q: ['b', uid] a crate, ball or spring; ['s', uid] a teeter-totter; ['pad', column, row] a floor booster; ['por', column, row] a pair of portals (by the yellow one);
     ['g', uid] a gate and its trigger. Nothing is taken out of the lists (everything keeps its place, so saves and the server still line up): it is just gone from the world. */
  function applyDel(w, q) {
    if (!Array.isArray(q)) return false;
    const k = q[0], u = q[1] >>> 0;
    if (k === 'b') { const d = w.dynBy.get(u); if (!d || d.gone) return false; d.gone = true; d.burn = 1e9; d.bl = 0; d.bx = d.by = -99999; d.x = d.y = -99999; d.vx = d.vy = 0; d.av = 0; d.nap = false; return true; }
    if (k === 's') { const s = w.see.find(e => e.uid === u && !e.gone); if (!s) return false; s.gone = true; s.cx = s.cy = -1e6; s.av = 0; s.sav = 0; return true; }
    if (k === 'r') { const r = (w.ropes || []).find(e => e.uid === u && !e.gone); if (!r) return false; r.gone = true; return true; }
    if (k === 'pad') { const p = w.pads.find(e => !e.gone && e.x === q[1] && e.y === q[2]); if (!p) return false; p.gone = true; p.x = p.y = -100000; return true; }
    if (k === 'por') { const p = w.portals.find(e => !e.gone && Math.round(e.a.x / TS) - 1 === q[1] && Math.round(e.a.y / TS) === q[2]); if (!p) return false; p.gone = true; p.a.x = p.b.x = -1e7; return true; }
    if (k === 'g') {
      const d = w.doors.find(e => e.uid === u && !e.gone); if (!d) return false;
      for (let yy = d.y; yy < d.y + d.h; yy++) for (let xx = d.x; xx < d.x + d.w; xx++) if (xx >= 0 && xx < w.W && yy >= 0 && yy < w.H && w.grid[yy * w.W + xx] === 9) w.grid[yy * w.W + xx] = 0;
      d.gone = true; d.open = true; d.latched = true; d.x = d.y = -100000;
      for (const q2 of w.plates.concat(w.btns)) if (q2.to && q2.to.every(i => !w.doors[i] || w.doors[i].gone)) { q2.gone = true; q2.x = q2.y = -100000; }   // (its trigger goes with it, unless it still works another gate)
      return true;
    }
    return false;
  }
  function liftOut(w, tx, r) {   // ground has just grown on this tile: whatever was sitting in it is lifted out on top (never left buried)
    const x0 = tx * TS, y0 = r * TS, x1 = x0 + TS;
    for (let i = 0; i < w.dyn.length; i++) {
      const d = w.dyn[i]; if (d.burn > 0) continue; const e = d.r || d.hw;
      if (!(d.x + e > x0 && d.x - e < x1 && d.y + e > y0 && d.y - e < y0 + TS)) continue;
      let ny = y0 - e - 0.5, ok = false;
      for (let k = 0; k < 6; k++) { if (!SOLIDT(tile(w, Math.floor((d.x - e + 2) / TS), Math.floor((ny + e - 1) / TS))) && !SOLIDT(tile(w, Math.floor((d.x + e - 2) / TS), Math.floor((ny + e - 1) / TS))) && !SOLIDT(tile(w, Math.floor((d.x - e + 2) / TS), Math.floor((ny - e + 1) / TS))) && !SOLIDT(tile(w, Math.floor((d.x + e - 2) / TS), Math.floor((ny - e + 1) / TS)))) { ok = true; break; } ny -= TS; }
      if (ok) { d.y = ny; d.vy = 0; d.nap = false; d.rest = 0; d.sleep = false; }
    }
  }
  const api = { VERSION: 139, BTN_T, outOfBall, ballOff, inSolidAt: (w, x, y, e) => boxHits(w, x, y, e - 1, e - 1), restsOn, maxPen, seeOut, addRope, ropeOk, ropeAt, ropeBody, ropeQ, nearZone, noBuild, plankCross, applyDel, PLAYER_WT, liftOut, bodyOverlaps, addPortal, padAt, addPad, PAD_V, TS, R, GRAV, propDims, addProp, spotFree, tile, MAXV, BOOST_T, BOOST_V, makeWorld, newBody, step, stepDyn, stepSwitches, setDoorTiles, killYAt, collideDyn, seeBody, hash32, doorBlocked, FALL_WARN, FALL_DIE };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.BallPhysics = api;
})(typeof window !== 'undefined' ? window : globalThis);

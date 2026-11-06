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
    const w = { W, H, grid, map, dyn: [], dynBy: new Map(), follow: false, doors: [], plates: [], btns: [], see: [], pads: [], portals: [], ev: [], focus: null };
    const G = map.gadgets || {};
    (G.doors || []).forEach((d, i) => { const o = { id: i, uid: hash32('d' + i), x: d[0], y: d[1], w: d[2], h: d[3], open: false, latched: false }; w.doors.push(o); setDoorTiles(w, o, false); });
    (G.plates || []).forEach(p => w.plates.push({ x: p[0], y: p[1], w: p[2], to: p[3], on: false }));
    (G.btns || []).forEach(p => w.btns.push({ x: p[0], y: p[1], to: p[2], on: false }));
    (G.see || []).forEach(p => w.see.push({ cx: p[0] * TS, cy: p[1] * TS, hl: p[2] * TS, tilt: p[3], ang: p[3], av: 0, tq: 0, uid: hash32('s' + Math.round(p[0] * TS) + ',' + Math.round(p[1] * TS)) }));
    for (const p of (map.props || [])) addProp(w, p[0], (p[1] + 0.5) * TS, p[2] * TS - propDims(p[0]).half - 0.5).nap = true;   /* (the map's own things start out at rest: each one checks it is held up once somebody comes near) */   // pushable yellow things; each player has their own copy (never shared)
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
      m: r ? (r * r) / 256 : (4 * hw * hw) / 1296, kind };
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
    const qx = s.cx + u * c, qy = s.cy + u * sn, dx = o.x - qx, dy = o.y - qy, d2 = dx * dx + dy * dy, mm = r + SEE_TH;
    if (d2 >= mm * mm) return false;
    let nx, ny;
    const below = rx * sn - ry * c < 0;   // (which side of the plank it is on: the plank is solid from both sides)
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
  function stepSee(w, dt) {   // each plank turns on its pivot as it was pushed, and stops where it meets the ground
    for (let i = 0; i < w.see.length; i++) {
      const s = w.see[i]; if (s.gone) continue;
      if (w.follow && s.sa !== undefined) {   // in the shared world the server has the plank: it follows the server's (while you are on it, it also reacts to you at once)
        s.kin = !(s.mineT > 0);
        const now = typeof performance !== 'undefined' ? performance.now() : Date.now(), age = s.st ? Math.min(0.25, Math.max(0, (now - s.st) / 1000)) : 0.05, ta = s.sa + (s.sav || 0) * age;   // (carried on exactly the way the crates and balls are, so what rests on it moves with it)
        if (s.mineT > 0) { s.mineT -= dt; s.ang += s.av * dt; s.ang += (ta - s.ang) * Math.min(1, 6 * dt); }
        else { const a0 = s.ang; s.ang += (ta - s.ang) * Math.min(1, 26 * dt); s.av = (s.ang - a0) / dt; }
      } else { s.kin = false; s.ang += s.av * dt; }
      s.av *= Math.max(0, 1 - 0.6 * dt);   // (a little friction in the pivot)
      if (s.ang > SEE_MAX) { s.ang = SEE_MAX; if (s.av > 0) s.av = 0; }
      if (s.ang < -SEE_MAX) { s.ang = -SEE_MAX; if (s.av < 0) s.av = 0; }
      if (Math.abs(s.av) > 0.03) s.moving = 0.5; else if (s.moving > 0) s.moving -= dt;   // (while it moves, what rests on it is kept awake)
    }
  }
  function seeBody(b, w, wt) {   // the player (or a round toy) against every nearby plank
    let on = false;
    for (let i = 0; i < w.see.length; i++) {
      const s = w.see[i]; if (Math.abs(s.cx - b.x) > s.hl + 40 || Math.abs(s.cy - b.y) > s.hl + 60) continue;
      if (seeHit(s, b, b.r || R, wt / 60)) {
        on = true; b.onSee = s; if (w.follow && b.r === undefined && !b.ghost) s.mineT = 0.6;
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
      if (Math.abs(along) > s.hl + 4) { if (o.sg === i) o.sg = -1; continue; }
      if (nrm >= 0) { o.sg = i; continue; }
      if (o.sg === i && nrm > -(half + SEE_TH + 50)) {
        const need = half + SEE_TH - nrm; o.x += sn * need; o.y -= c * need;
        const vn = o.vx * sn - o.vy * c; if (vn < 0) { o.vx -= vn * sn; o.vy += vn * c; }
      }
    }
  }
  /* ---------- buttons, pressure plates and doors ---------- */
  function doorBlocked(w, d, bs) {
    const x0 = d.x * TS, x1 = (d.x + d.w) * TS, y0 = (d.y + 1) * TS, y1 = (d.y + d.h) * TS;   // (the beam above is always solid, so only the gap below it can be blocked)
    const L = bs ? (Array.isArray(bs) ? bs : [bs]) : [];
    for (let k = 0; k < L.length; k++) { const b = L[k]; if (b && b.x + R > x0 && b.x - R < x1 && b.y + R > y0 && b.y - R < y1) return true; }
    for (let i = 0; i < w.dyn.length; i++) { const o = w.dyn[i]; if (o.burn > 0) continue; const e = o.r || o.hw; if (o.x + e > x0 && o.x - e < x1 && o.y + e > y0 && o.y - e < y1) return true; }
    return false;
  }
  // bs: a player body, or a list of them (the server passes everybody in the world). In follow mode (a device that is shown the server's world) a gate may only be opened here at once;
  // shutting it is up to the server. dt (optional): with w.closeDelay, a gate waits that long after the last thing left its trigger before it shuts.
  function stepSwitches(w, bs, dt) {
    const L = bs ? (Array.isArray(bs) ? bs : [bs]) : [], want = w.doors.map(d => d.latched);
    for (let i = 0; i < w.btns.length; i++) {
      const q = w.btns[i]; if (q.on) continue;
      const x0 = q.x * TS - R, x1 = (q.x + 1) * TS + R, fy = q.y * TS;
      for (let k = 0; k < L.length; k++) {
        const b = L[k]; if (!b || b.ghost) continue;
        if (b.x > x0 && b.x < x1 && b.y + R >= fy - 8 && b.y + R <= fy + 6) {
          q.on = true; q.t = 1; q.pT = Date.now(); w.ev.push({ k: 'btn', x: (q.x + 0.5) * TS, y: fy });
          for (const di of q.to) { w.doors[di].latched = true; want[di] = true; }
          break;
        }
      }
    }
    for (let i = 0; i < w.plates.length; i++) {
      const q = w.plates[i], x0 = q.x * TS, x1 = (q.x + q.w) * TS, fy = q.y * TS; let on = !!(w.follow && q.srvOn);
      for (let k = 0; k < L.length && !on; k++) { const b = L[k]; if (b && !b.ghost && b.x > x0 && b.x < x1 && b.y + R >= fy - 8 && b.y + R <= fy + 6 && b.ground) on = true; }
      const DL = w.cand || w.dyn;   // (on the server: only the things near a player)
      for (let j = 0; j < DL.length && !on; j++) {
        const o = DL[j]; if (o.burn > 0 || Math.abs(o.x - (x0 + x1) / 2) > 300) continue;
        const bot = o.y + (o.r || o.hh);
        if (o.x > x0 && o.x < x1 && bot >= fy - 8 && bot <= fy + 6) on = true;
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
  const SLOP = 0.6, BAUM = 0.3, VEL_IT = 10, POS_IT = 4, PM = 4, PM_PUSH = 4, F_PUSH = 6000;   // PM: how heavy your ball is when it pushes things (a crate weighs 1, a big crate 4)
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
  const CT = []; let nCT = 0, cmPrev = new Map();
  function addC(a, b, h, key) {
    let c = CT[nCT]; if (!c) c = CT[nCT] = {};
    nCT++;
    c.a = a; c.b = b; c.px = h[0]; c.py = h[1]; c.sep = h[2]; c.nx = h[3]; c.ny = h[4]; c.key = key;
    c.kvx = 0; c.kvy = 0; c.pl = null; c.u = 0; c.mu = 0.5; c.mk = 0; c.e = 0; c.eT = 1e9; c.eCap = 1e9; c.eMin = 0; c.Pn = 0; c.Pt = 0; c.Pb = 0;
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
    if (isBall(d)) { c.mu = ice ? 0.02 : 0.7; if (t === 6) { c.e = 0.85; c.eT = 130; c.eCap = BOUNCE * 0.85; c.eMin = 150; } else { c.e = 0.3; c.eT = 250; } }
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
      const key = 't' + (ty * 4096 + tx) + ':';
      if (isBall(d)) { const h = circTile(w, tx, ty, d.x, d.y, d.r); if (h) matTile(addC(null, d, h, key), d, t); continue; }
      const skip = (isSol(tile(w, tx + 1, ty)) ? SK_PX : 0) | (isSol(tile(w, tx - 1, ty)) ? SK_NX : 0) | (isSol(tile(w, tx, ty + 1)) ? SK_PY : 0) | (isSol(tile(w, tx, ty - 1)) ? SK_NY : 0);
      const out = []; obbHit({ x: (tx + 0.5) * TS, y: (ty + 0.5) * TS, hw: TS / 2, hh: TS / 2, c: 1, s: 0 }, sh, skip, out);
      for (const h of out) matTile(addC(null, d, h, key + h[5]), d, t);
    }
    return lava;
  }
  function pairContacts(a, b, sa, sb, dynB, w) {   // a is always moved by these contacts; b only if dynB (otherwise it is held where it is)
    const out = [];
    const A = dynB ? a : b, B = dynB ? b : a, SA = dynB ? sa : sb, SB = dynB ? sb : sa;   // (a thing that is held still is always the first of the two)
    if (!isBall(A) && !isBall(B)) obbHit(SA, SB, 0, out);
    else if (isBall(A) && isBall(B)) {
      const dx = B.x - A.x, dy = B.y - A.y, d2 = dx * dx + dy * dy, rr = A.r + B.r; if (d2 >= rr * rr) return 0;
      const d = Math.sqrt(d2) || 0.001, nx = d2 ? dx / d : 0, ny = d2 ? dy / d : -1; out.push([A.x + nx * A.r, A.y + ny * A.r, d - rr, nx, ny, 0]);
    } else if (isBall(B)) { const h = circBox(SA, B.x, B.y, B.r); if (h) out.push([h[0], h[1], h[2], h[3], h[4], 0]); }
    else { const h = circBox(SB, A.x, A.y, A.r); if (h) out.push([h[0] + h[3] * h[2], h[1] + h[4] * h[2], h[2], -h[3], -h[4], 0]); }
    for (const h of out) { const c = addC(dynB ? A : null, B, h, A.uid + ':' + B.uid + ':' + h[5]); matPair(c, A, B); if (!dynB) { const rx = h[0] - A.x, ry = h[1] - A.y; c.kvx = (A.vx || 0) - (A.av || 0) * ry; c.kvy = (A.vy || 0) + (A.av || 0) * rx; } }
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
        if (dd >= m) continue;
        const nx = dd > 0.0001 ? dx / dd : sux, ny = dd > 0.0001 ? dy / dd : suy;
        if (nx * sux + ny * suy < 0.3) continue;
        add([qx + nx * SEE_TH, qy + ny * SEE_TH, dd - m, nx, ny], 's' + i + ':' + k, u);
      }
      if (!isBall(d)) for (let k = 0; k < 2; k++) {   // the plank's ends poking into the side or bottom of a crate
        const e = k ? 1 : -1, qx = s.cx + e * s.hl * c, qy = s.cy + e * s.hl * sn, h = circBox(sh, qx, qy, SEE_TH);
        if (!h || -h[4] * suy - h[3] * sux < 0.3) continue;
        add([h[0] + h[3] * h[2], h[1] + h[4] * h[2], h[2], -h[3], -h[4]], 's' + i + ':e' + k, e * s.hl);
      }
    }
    return n;
  }
  let plankUsed = [];
  const plankMoving = (w, d) => w.see.some(s => s.moving > 0 && Math.abs(s.cx - d.x) < s.hl + 60 && Math.abs(s.cy - d.y) < s.hl + 60);
  function velAt(o, rx, ry) { return [o.vx - o.av * ry, o.vy + o.av * rx]; }
  function solveContacts(dt) {
    const inv = 1 / dt, cm = new Map();
    for (let k = 0; k < nCT; k++) {
      const c = CT[k], a = c.a, b = c.b, ima = a ? a._im : 0, iia = a ? a._ii : 0, imb = b._im, iib = b._ii;
      c.rax = a ? c.px - a.x : 0; c.ray = a ? c.py - a.y : 0; c.rbx = c.px - b.x; c.rby = c.py - b.y;
      const rnA = c.rax * c.ny - c.ray * c.nx, rnB = c.rbx * c.ny - c.rby * c.nx, tx = c.ny, ty = -c.nx, rtA = c.rax * ty - c.ray * tx, rtB = c.rbx * ty - c.rby * tx;
      const kn = ima + imb + iia * rnA * rnA + iib * rnB * rnB, kt = ima + imb + iia * rtA * rtA + iib * rtB * rtB;
      c.mn = kn > 0 ? 1 / kn : 0; c.mt = kt > 0 ? 1 / kt : 0;
      c.bias = BAUM * inv * Math.max(0, -c.sep - SLOP);
      const vA = a ? velAt(a, c.rax, c.ray) : [c.kvx, c.kvy], vB = velAt(b, c.rbx, c.rby), vn = (vB[0] - vA[0]) * c.nx + (vB[1] - vA[1]) * c.ny;
      const pr = cmPrev.get(c.key);
      if (c.mk) { const vt0 = (vB[0] - vA[0]) * tx + (vB[1] - vA[1]) * ty; if (Math.abs(vt0) > 40) c.mu = c.mk; }   // (something already sliding slides on more easily than it takes to get it going: a resting crate grips, a pushed one glides)
      c.vb = 0; if (c.e > 0 && !pr && vn < -c.eT) { c.vb = Math.min(c.eCap, -c.e * vn); if (c.vb < c.eMin) c.vb = 0; }   // (a bounce is only for a fresh knock, never for things already pressed together)
      if (pr) { c.Pn = pr[0]; c.Pt = pr[1]; impulse(c, c.Pn * c.nx + c.Pt * tx, c.Pn * c.ny + c.Pt * ty); }
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
      const vA = a ? [a._bx - a._bw * c.ray, a._by + a._bw * c.rax] : [0, 0], vB = [b._bx - b._bw * c.rby, b._by + b._bw * c.rbx];
      const vn = (vB[0] - vA[0]) * c.nx + (vB[1] - vA[1]) * c.ny;
      let dP = c.mn * (-vn + c.bias); const P0 = c.Pb; c.Pb = Math.max(P0 + dP, 0); dP = c.Pb - P0;
      if (!dP) continue;
      const Px = dP * c.nx, Py = dP * c.ny;
      if (a) { a._bx -= Px * a._im; a._by -= Py * a._im; a._bw -= a._ii * (c.rax * Py - c.ray * Px); }
      b._bx += Px * b._im; b._by += Py * b._im; b._bw += b._ii * (c.rbx * Py - c.rby * Px);
    }
    for (let k = 0; k < nCT; k++) { const c = CT[k]; if (c.Pn || c.Pt) cm.set(c.key, [c.Pn, c.Pt]); }
    cmPrev = cm;
  }
  function impulse(c, Px, Py) {
    const a = c.a, b = c.b;
    if (a) { a.vx -= Px * a._im; a.vy -= Py * a._im; a.av -= a._ii * (c.rax * Py - c.ray * Px); }
    b.vx += Px * b._im; b.vy += Py * b._im; b.av += b._ii * (c.rbx * Py - c.rby * Px);
  }
  function hasSupport(w, d, H) {   // (a resting thing checks now and then that something is still under it)
    const sh = d.r ? null : shapeOf(d), ex = d.r || sh.ex, ey = d.r || sh.ey;
    if (boxHits(w, d.x, d.y + 3, ex - 1, ey)) return true;
    for (let i = 0; i < w.see.length; i++) { const s = w.see[i]; if (Math.abs(s.cx - d.x) < s.hl + ex + 10 && Math.abs(s.cy - d.y) < s.hl + ey + 30) return true; }
    const near = H(d.x - ex, d.y, d.x + ex, d.y + ey + 4);
    for (const o of near) { if (o === d || o.burn > 0) continue; const e = o.r || Math.max(o.hw, o.hh) * 1.42; if (Math.abs(o.x - d.x) < e + ex && o.y > d.y && o.y - e < d.y + ey + 4) return true; }
    return false;
  }
  function inStart(w, x, y) { const st = w.map && w.map.start; if (!st) return false; const sx = Math.floor(st[0] / TS), sy = Math.floor(st[1] / TS); return x >= (sx - 2) * TS && x <= (sx + 3) * TS && y >= (sy - 3) * TS && y <= (sy + 2) * TS; }   // the start zone (5 x 5 blocks around where everybody appears)
  let dynTick = 0; const DYN_BUDGET = 160, CELL = 64;
  function stepDyn(w, dt) {
    dynTick++;
    stepSee(w, dt);
    for (let i = 0; i < w.pads.length; i++) if (w.pads[i].t > 0) w.pads[i].t = Math.max(0, w.pads[i].t - dt);
    const L = w.dyn; if (!L.length) return;
    const f = w.focus, FR = 1100, fol = w.follow || w.pubWait;
    if (f) {   // a very busy pile near you: only the nearest few dozen things are simulated each moment, so the game stays smooth however much has been built
      const near = [];
      for (let i = 0; i < L.length; i++) { const d = L[i]; d.skip = false; if (d.burn > 0 || d.nap || !nearF(f, d.x, d.y, FR, FR)) continue; near.push(d); }
      if (near.length > DYN_BUDGET) { near.sort((a, b) => distF(f, a) - distF(f, b)); for (let k = DYN_BUDGET; k < near.length; k++) near[k].skip = true; }
    }
    const act = [], chk = [], grid = new Map(), movingP = w.see.filter(s => s.moving > 0 && !s.gone);
    const put = d => { const e = d.r || Math.max(d.hw, d.hh) * 1.42; for (let cx = Math.floor((d.x - e) / CELL); cx <= Math.floor((d.x + e) / CELL); cx++) for (let cy = Math.floor((d.y - e) / CELL); cy <= Math.floor((d.y + e) / CELL); cy++) { const k = (cx + 4) * 65536 + cy + 4; let g = grid.get(k); if (!g) grid.set(k, g = []); g.push(d); } };
    const H = (x0, y0, x1, y1) => { const r = []; for (let cx = Math.floor(x0 / CELL); cx <= Math.floor(x1 / CELL); cx++) for (let cy = Math.floor(y0 / CELL); cy <= Math.floor(y1 / CELL); cy++) { const g = grid.get((cx + 4) * 65536 + cy + 4); if (g) for (const o of g) if (r.indexOf(o) < 0) r.push(o); } return r; };
    for (let i = 0; i < L.length; i++) {
      const d = L[i]; d._i = i; d._dyn = false;
      if (d.burn > 0) { if (d.burn < 1e8) { d.burn -= dt; if (d.burn <= 0) { d.x = d.hx; d.y = d.hy; d.vx = d.vy = 0; d.av = 0; d.rot = 0; } } continue; }
      if (d.im === undefined) { const I = d.r ? 0.5 * d.m * d.r * d.r : d.m * (d.hw * d.hw + d.hh * d.hh) / 3; d.im = 1 / d.m; d.ii = d.kind === 5 || d.kind === 6 ? 0 : 1 / I; if (d.av === undefined) d.av = 0; }
      if (d.sq > 0) d.sq = Math.max(0, d.sq - dt);
      put(d);
      d._far = !!f && !nearF(f, d.x, d.y, FR, FR);
      if (d._far && !d.nap) { d.farT = (d.farT || 0) + dt; if (d.farT > 30) { d.nap = true; d.vx = d.vy = 0; d.av = 0; } } else d.farT = 0;   /* (with nobody near, nothing keeps moving for more than 30 seconds: anything still going by then is simply put to rest) */
      if (d._far && d.nap) { d.sleep = true; continue; }   // far from everybody and at rest: nothing to work out
      if (d.ownT > 0) { d.ownT -= dt; d.sleep = true; continue; }   /* (on the server: a player's device is working this one out and saying where it is) */
      if (d.skip) { d.sleep = true; continue; }   // (far away but still moving: it carries on until it comes to rest, whether anybody is watching or not)
      if (fol && !(d.mineT > 0 || d.keep > 0)) { d.sleep = true; continue; }   /* (in the shared world nothing moves here by itself, not even before the server has said where it is) */   // (in the shared world: only what you are touching is worked out here, at once; everything else is shown where the server has it)
      d.sleep = false;
      if (d.nap && movingP.length && movingP.some(s => Math.abs(s.cx - d.x) < s.hl + 60 && Math.abs(s.cy - d.y) < s.hl + 80)) { d.nap = false; d.st = 0; }   // (a plank that moves wakes what rests on it)
      if (d.nap) { if (!d._far && (dynTick + i) % 15 === 0) chk.push(d); continue; }
      d._dyn = true; act.push(d);
    }
    for (const d of chk) if (!hasSupport(w, d, H)) { d.nap = false; d.st = 0; d._dyn = true; act.push(d); }   // (something resting checks now and then that it is still held up)
    w.nAct = act.length;
    if (!act.length) return;
    nCT = 0; plankUsed = [];
    const shp = new Map(), S = o => { let s = shp.get(o); if (!s) { s = o.r ? { x: o.x, y: o.y } : shapeOf(o); shp.set(o, s); } return s; };
    const wake = [], lavaOf = new Set();
    for (const d of act) {   // gravity, then every contact
      d.vy = Math.min(900, d.vy + GRAV * dt);
      d._im = d.im; d._ii = d.ii; d._bx = d._by = d._bw = 0; d._pl = false;
      const sh = S(d);
      if (tileContacts(w, d, sh)) lavaOf.add(d);
      if (w.see.length && plankContacts(w, d, sh)) d._pl = true;
      const e = d.r || Math.max(sh.ex, sh.ey);
      for (const o of H(d.x - e - 2, d.y - e - 2, d.x + e + 2, d.y + e + 2)) {
        if (o === d || o.burn > 0) continue;
        if (o._dyn && o._i < d._i) continue;   // (each pair once)
        const oe = o.r || Math.max(o.hw, o.hh) * 1.42; if (Math.abs(o.x - d.x) > e + oe + 2 || Math.abs(o.y - d.y) > e + oe + 2) continue;
        if (o._dyn) { pairContacts(d, o, sh, S(o), true, w); continue; }
        o._im = 0; o._ii = 0;
        if (pairContacts(d, o, sh, S(o), false, w)) {   // touching something that is resting (or, in the shared world, something the server is moving): it wakes up if this is moving
          const moving = !((d.st || 0) > 0.25) || Math.abs(d.vx) + Math.abs(d.vy) > 30;
          if (moving && o.nap) wake.push(o);
          if (moving && fol && o.sv !== undefined && !(o.mineT > 0 || o.keep > 0)) { o.mineT = 0.45; o.keep = 1.5; }
        }
      }
    }
    solveContacts(dt);
    for (const pa of plankUsed) { const sp = pa.s; sp._T = 0; if (!sp.kin && pa._ii) sp.av = pa.av; }
    for (let k = 0; k < nCT; k++) { const c = CT[k]; if (!c.pl) continue; const tx = c.ny, ty = -c.nx, Px = c.Pn * c.nx + c.Pt * tx, Py = c.Pn * c.ny + c.Pt * ty; c.pl._T += -(c.rax * Py - c.ray * Px); }
    for (const pa of plankUsed) { const sp = pa.s; sp.leave = (sp.ang >= SEE_MAX - 1e-6 && sp._T < -1) || (sp.ang <= -SEE_MAX + 1e-6 && sp._T > 1); }   // (a plank resting at one end only lifts off when what is on it now pushes it the other way)
    plankUsed = [];
    for (const d of act) {   // move
      if (Math.abs(d.vx) > MAXSPD) d.vx = Math.sign(d.vx) * MAXSPD; if (Math.abs(d.av) > MAXAV) d.av = Math.sign(d.av) * MAXAV;
      d._x0 = d.x; d._y0 = d.y;
      d.x += (d.vx + d._bx) * dt; d.y += (d.vy + d._by) * dt; d.rot += (d.av + d._bw) * dt;
      d.gr = false; d.touch = false; d.onp = d._pl; d._ice = false; d._pad = null; d._N = 0; d._F = 0;
    }
    for (let k = 0; k < nCT; k++) {   // what each thing is resting on
      const c = CT[k];
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
      if (burn || d.y > killYAt(w, d.x) || d.x < 0 || d.x > w.W * TS || d.y < 0 || (inStart(w, d.x, d.y) && !inStart(w, d.hx, d.hy))) {   /* (lava, off the map, or into the start zone, where nothing may be left: it burns up for good) */ d.bx = d.x; d.by = d.y; d.bl = burn || inStart(w, d.x, d.y) ? 1 : 0; d.bfx = 0; d.burn = 1e9; d.x = -99999; d.y = -99999; d.vx = d.vy = 0; d.av = 0; d.st = 0; }   // lost for good: this map will not give it back
    }
    // a pile goes to sleep together, once every piece of it has been still for a moment
    const par = new Map(), root = d => { let r = d; while (par.get(r) !== r) r = par.get(r); return r; };
    for (const d of act) par.set(d, d);
    for (let k = 0; k < nCT; k++) { const c = CT[k]; if (c.a && c.a._dyn) { const ra = root(c.a), rb = root(c.b); if (ra !== rb) par.set(ra, rb); } }
    const isl = new Map();
    for (const d of act) { if (d.burn > 0) continue; const r = root(d); const q = isl.get(r); const v = d.st || 0; isl.set(r, q === undefined ? v : Math.min(q, v)); }
    for (const d of act) { if (d.burn > 0) continue; if (isl.get(root(d)) >= SLEEP_T) { d.nap = true; d.vx = d.vy = 0; d.av = 0; } }
    for (const o of wake) { o.nap = false; o.st = 0; }
  }
  // the player's ball against the crates and balls. b.kin: the ball cannot be moved here (the server only follows where each player says they are)
  function collideDyn(b, w) {
    const L = w.cand || w.dyn, kin = !!b.kin; let sL = 0, sR = 0, sU = 0;   // (held up from the left and from the right at once: sitting in a V)
    for (let i = 0; i < L.length; i++) {
      const d = L[i];
      if (d.burn > 0 || Math.abs(d.x - b.x) > 110 || Math.abs(d.y - b.y) > 110) continue;
      let h;
      if (d.k === 'b') { h = circBox(shapeOf(d), b.x, b.y, R); if (!h) continue; }
      else { const dx = b.x - d.x, dy = b.y - d.y, d2 = dx * dx + dy * dy, rr = R + d.r; if (d2 >= rr * rr) continue; const dd = Math.sqrt(d2) || 0.001; h = [d.x + dx / dd * d.r, d.y + dy / dd * d.r, dd - rr, d2 ? dx / dd : 0, d2 ? dy / dd : -1]; }
      const pen = -h[2], nx = h[3], ny = h[4]; if (pen <= 0) continue;
      if (w.follow && !(d.hold > 0)) { d.mineT = 0.45; d.sleep = false; }
      if (d.im === undefined) { const I = d.r ? 0.5 * d.m * d.r * d.r : d.m * (d.hw * d.hw + d.hh * d.hh) / 3; d.im = 1 / d.m; d.ii = d.kind === 5 || d.kind === 6 ? 0 : 1 / I; if (d.av === undefined) d.av = 0; }
      const held = (w.follow && d.hold > 0) || (b.own !== undefined && d.ownT > 0 && d.ownBy === b.own);   // (the server's crate and yours disagree: it is a wall until they agree again. On the server: the player's own device is already pushing this one)
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
          const vlim = MAXV / (1 + 0.2 * (load - 1)), vb = -(vbx * nx + vby * ny), kb = im + ii * rn * rn;   // (and a heavy load only goes so fast)
          if (Math.abs(nx) > 0.5 && kb > 0) cap = Math.min(cap, Math.max(0, (vlim - vb) / kb));
        }
        const j = Math.min(jf, cap);
        if (free) { d.vx -= j * nx * im; d.vy -= j * ny * im; d.av -= j * rn * ii; d.st = 0; }
        b.vx += j * nx / pm; b.vy += j * ny / pm;
        if (free && d.k === 'o' && j > 0) {   // your ball grips a ball it pushes, the way two rolling balls do (so one squeezed between you and another never gets spun backwards into you)
          const tx = ny, ty = -nx, wp = b.vx / R, px = -wp * (-ny * R), py = wp * (-nx * R);   // (your ball rolls: its surface where they touch moves with its spin)
          const vt = ((d.vx - (d.av || 0) * ry) - (b.vx + px)) * tx + ((d.vy + (d.av || 0) * rx) - (b.vy + py)) * ty, rt = rx * ty - ry * tx, kt = im + ii * rt * rt;
          if (kt > 0) { const jt = clamp(-vt / kt, -0.4 * j, 0.4 * j); d.vx += jt * tx * im; d.vy += jt * ty * im; d.av += jt * rt * ii; }
        }
        if (free && d.k === 'o' && d.gr && Math.abs(nx) > 0.5) d.av = d.vx / d.r;   // (a ball you push along the ground rolls the way it is pushed, never skidding on with its old spin)
        if (j < jf) { const vn2 = (b.vx - (d.vx - (d.av || 0) * ry)) * nx + (b.vy - (d.vy + (d.av || 0) * rx)) * ny; if (vn2 < 0) { b.vx -= vn2 * nx; b.vy -= vn2 * ny; } }   // (and you are held back to its pace)
      }
      if (kin) { b.x += nx * pen; b.y += ny * pen; }   // (the server's idea of where a player is never goes through a crate: it stays against it, as the player's own ball does)
      else {
        if (ny > 0.5 && free && !d.nap) {   // the thing is above you: it is lifted off you (so nothing can pin you down); only a ceiling stops you
          const sh = d.r ? null : shapeOf(d), ex = d.r || sh.ex, ey = d.r || sh.ey;
          if (!boxHits(w, d.x - nx * pen, d.y - ny * pen, ex - 2, ey - 2)) { d.x -= nx * pen; d.y -= ny * pen; } else { b.x += nx * pen; b.y += ny * pen; if (b.vy < 0) b.vy = 0; }
        } else { b.x += nx * pen; b.y += ny * pen; }
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

  const SUPER_BOUNCE = 1900;   // a super spring throws you about 900px up (more than 20 tiles)
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
  function addPortal(w, q) { const p = { a: { x: (q[1] + 1) * TS, y: q[2] * TS }, b: { x: (q[3] + 1) * TS, y: q[4] * TS } }; w.portals.push(p); return p; }
  function portalAt(w, x, bottom) {
    for (let i = 0; i < w.portals.length; i++) { const p = w.portals[i];
      if (Math.abs(x - p.a.x) < 26 && bottom >= p.a.y - 6 && bottom <= p.a.y + 12) return { from: p.a, to: p.b };
      if (Math.abs(x - p.b.x) < 26 && bottom >= p.b.y - 6 && bottom <= p.b.y + 12) return { from: p.b, to: p.a }; }
    return null;
  }
  // ax: -1/0/1, jheld: jump button held. Set b.jbuf = 0.12 on a jump press.
  function step(b, w, ax, jheld, dt) {
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
    const wet = water || tile(w, Math.floor(b.x / TS), Math.floor(b.y / TS)) === 5 || tile(w, Math.floor(b.x / TS), Math.floor((b.y + R * 0.8) / TS)) === 5;   // (checked again after moving: you can land in a shallow pool in the very same step)
    if (b.ground || wet) { if (!wasGround && !wet && !b.bnc && b.fall >= FALL_DIE) ev.splat = true; b.fall = 0; }
    else if (b.vy > 300) b.fall += dt; else if (b.vy < 0) b.fall = 0;
    if (b.bnc && !water) { b.bnc = false; b.vy = -(b.bncV || (jheld ? BOUNCE_HELD : BOUNCE)); b.launched = true; b.ground = false; b.coyote = 0; ev.bounced = true; }
    if (!wasGround && b.ground && preVy > 380 && !wet) ev.landed = true;
    return ev;
  }

  const SOLIDT = t => t === 1 || t === 3 || t === 4 || t === 6 || t === 9;
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
  const api = { VERSION: 115, applyDel, PLAYER_WT, liftOut, bodyOverlaps, addPortal, padAt, addPad, PAD_V, TS, R, GRAV, propDims, addProp, spotFree, tile, MAXV, BOOST_T, BOOST_V, makeWorld, newBody, step, stepDyn, stepSwitches, setDoorTiles, killYAt, collideDyn, seeBody, hash32, doorBlocked, FALL_WARN, FALL_DIE };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.BallPhysics = api;
})(typeof window !== 'undefined' ? window : globalThis);

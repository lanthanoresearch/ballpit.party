/* Shared ball physics (browser + Node, so maps can be bot-tested). */
(function (root) {
  'use strict';
  const TS = 40, R = 14;
  const GRAV = 1900, JUMP = 640, MAXV = 270, MAXFALL = 950;
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const approach = (a, t, d) => (a < t ? Math.min(a + d, t) : Math.max(a - d, t));

  function makeWorld(map) {
    const W = map.W, H = map.H, grid = new Uint8Array(W * H);
    for (const r of map.rects) {
      for (let yy = r[1]; yy < r[1] + r[3]; yy++) {
        if (yy < 0 || yy >= H) continue;
        for (let xx = r[0]; xx < r[0] + r[2]; xx++) if (xx >= 0 && xx < W) grid[yy * W + xx] = r[4];
      }
    }
    const w = { W, H, grid, map, dyn: [] };
    for (const p of (map.props || [])) {   // pushable yellow things; each player has their own copy (never shared)
      const kind = p[0], cx = (p[1] + 0.5) * TS, sy = p[2] * TS;
      const hw = kind === 0 ? 18 : kind === 1 ? 36 : 0, r = kind === 2 ? 16 : kind === 3 ? 34 : 0;
      const d = { k: r ? 'o' : 'b', x: cx, y: sy - (r || hw) - 0.5, hw, hh: hw, r, vx: 0, vy: 0, rot: 0, gr: false, touch: false, burn: 0,
        m: r ? (r * r) / 256 : (4 * hw * hw) / 1296 };
      d.hx = d.x; d.hy = d.y; w.dyn.push(d);
    }
    return w;
  }

  function tile(w, tx, ty) {
    if (tx < 0 || tx >= w.W) return 0;      // beyond the world's edge is empty space (the game kills you out there)
    if (ty < 0 || ty >= w.H) return 0;
    return w.grid[ty * w.W + tx];
  }

  function newBody(x, y) {
    return { x, y, vx: 0, vy: 0, rot: 0, ground: false, flat: false, gType: 0, coyote: 0, jbuf: 0, water: false, swimCool: 0 };
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
        if (!t || t === 5) continue;
        const left = tx * TS, top = ty * TS;
        const cx = clamp(b.x, left, left + TS), cy = clamp(b.y, top, top + TS);
        const dx = b.x - cx, dy = b.y - cy, d2 = dx * dx + dy * dy;
        if (t === 2) { if (d2 < (R - 3) * (R - 3)) lava = true; continue; }
        if (d2 >= R * R) continue;
        if (d2 === 0) { b.y = top - R; if (b.vy > 0) b.vy = 0; b.ground = true; b.flat = true; b.gType = t; continue; }
        const d = Math.sqrt(d2), nx = dx / d, ny = dy / d, pen = R - d;
        b.x += nx * pen; b.y += ny * pen;
        const vn = b.vx * nx + b.vy * ny;
        if (vn < 0) { b.vx -= vn * nx; b.vy -= vn * ny; }
        if (ny < -0.5) {
          b.ground = true;
          if (dx === 0) { b.flat = true; b.gType = t; }       // centre is over the tile: real footing
          else if (!b.flat) b.gType = t;                      // only touching its corner: no grip
        }
      }
    }
    return lava;
  }


  /* ---------- pushable objects (yellow crates and balls) ---------- */
  const isSol = t => t === 1 || t === 3 || t === 4;
  function boxHits(w, x, y, hw, hh) {
    const tx0 = Math.floor((x - hw) / TS), tx1 = Math.floor((x + hw - 0.01) / TS), ty0 = Math.floor((y - hh) / TS), ty1 = Math.floor((y + hh - 0.01) / TS);
    for (let ty = ty0; ty <= ty1; ty++) for (let tx = tx0; tx <= tx1; tx++) if (isSol(tile(w, tx, ty))) return true;
    return false;
  }
  function ballTiles(d, w) {
    d.gr = false; let burn = false;
    const r = d.r, tx0 = Math.floor((d.x - r) / TS), tx1 = Math.floor((d.x + r) / TS), ty0 = Math.floor((d.y - r) / TS), ty1 = Math.floor((d.y + r) / TS);
    for (let ty = ty0; ty <= ty1; ty++) for (let tx = tx0; tx <= tx1; tx++) {
      const t = tile(w, tx, ty);
      if (!t || t === 5) continue;
      const left = tx * TS, top = ty * TS, cx = clamp(d.x, left, left + TS), cy = clamp(d.y, top, top + TS);
      const dx = d.x - cx, dy = d.y - cy, d2 = dx * dx + dy * dy;
      if (t === 2) { if (d2 < (r - 3) * (r - 3)) burn = true; continue; }
      if (d2 >= r * r) continue;
      if (d2 === 0) { d.y = top - r; if (d.vy > 0) d.vy = 0; d.gr = true; continue; }
      const dd = Math.sqrt(d2), nx = dx / dd, ny = dy / dd;
      d.x += nx * (r - dd); d.y += ny * (r - dd);
      const vn = d.vx * nx + d.vy * ny;
      if (vn < 0) { const e = vn < -250 ? 0.3 : 0; d.vx -= (1 + e) * vn * nx; d.vy -= (1 + e) * vn * ny; }
      if (ny < -0.5) d.gr = true;
    }
    return burn;
  }
  // generic separation of two pushables (or one pushable and the player: pass player as {x,y,r,vx,vy,m})
  function pairSep(a, b, e) {
    let nx = 0, ny = 0, pen = 0;
    if (a.r && b.r) {
      const dx = b.x - a.x, dy = b.y - a.y, d = Math.sqrt(dx * dx + dy * dy) || 0.001;
      pen = a.r + b.r - d; if (pen <= 0) return false; nx = dx / d; ny = dy / d;
    } else if (!a.r && !b.r) {
      const dx = b.x - a.x, dy = b.y - a.y, ox = a.hw + b.hw - Math.abs(dx), oy = a.hh + b.hh - Math.abs(dy);
      if (ox <= 0 || oy <= 0) return false;
      if (ox < oy) { nx = dx < 0 ? -1 : 1; pen = ox; } else { ny = dy < 0 ? -1 : 1; pen = oy; }
    } else {
      const c = a.r ? a : b, bx = a.r ? b : a;
      const px = clamp(c.x, bx.x - bx.hw, bx.x + bx.hw), py = clamp(c.y, bx.y - bx.hh, bx.y + bx.hh);
      const dx = c.x - px, dy = c.y - py, d2 = dx * dx + dy * dy;
      if (d2 >= c.r * c.r) return false;
      let cnx, cny, cp;
      if (d2 === 0) { cnx = 0; cny = -1; cp = c.r; } else { const d = Math.sqrt(d2); cnx = dx / d; cny = dy / d; cp = c.r - d; }
      // normal from a to b
      if (a.r) { nx = -cnx; ny = -cny; } else { nx = cnx; ny = cny; }
      pen = cp;
    }
    const tm = a.m + b.m, sa = b.m / tm, sb = a.m / tm;
    a.x -= nx * pen * sa; a.y -= ny * pen * sa; b.x += nx * pen * sb; b.y += ny * pen * sb;
    const vn = (b.vx - a.vx) * nx + (b.vy - a.vy) * ny;
    if (vn < 0) { const j = -(1 + e) * vn / (1 / a.m + 1 / b.m); a.vx -= j / a.m * nx; a.vy -= j / a.m * ny; b.vx += j / b.m * nx; b.vy += j / b.m * ny; }
    if (Math.abs(ny) > 0.7) { a.touch = true; b.touch = true; }
    a._nx = nx; a._ny = ny; b._nx = -nx; b._ny = -ny;
    return true;
  }
  function stepDyn(w, dt) {
    const L = w.dyn; if (!L.length) return;
    const kill = w.map.killY;
    for (let i = 0; i < L.length; i++) {
      const d = L[i];
      if (d.burn > 0) { d.burn -= dt; if (d.burn <= 0) { d.x = d.hx; d.y = d.hy; d.vx = d.vy = 0; } continue; }
      d.vy = Math.min(900, d.vy + GRAV * dt);
      let burn = false;
      if (d.k === 'o') {
        d.x += d.vx * dt; d.y += d.vy * dt; burn = ballTiles(d, w); d.rot += d.vx * dt / d.r;
        if (d.gr || d.touch) d.vx *= Math.max(0, 1 - 0.5 * dt);
      } else {
        d.x += d.vx * dt; if (boxHits(w, d.x, d.y, d.hw, d.hh)) { d.x -= d.vx * dt; d.vx = 0; }
        d.y += d.vy * dt; if (boxHits(w, d.x, d.y, d.hw, d.hh)) { d.y -= d.vy * dt; d.vy = 0; }
        d.gr = boxHits(w, d.x, d.y + 1, d.hw, d.hh);
        const under = tile(w, Math.floor(d.x / TS), Math.floor((d.y + d.hh + 2) / TS));
        if (d.gr || d.touch) d.vx = approach(d.vx, 0, (under === 3 ? 40 : 900) * dt);
        const tl = tile(w, Math.floor(d.x / TS), Math.floor((d.y + d.hh - 4) / TS));
        if (tl === 2) burn = true;
      }
      d.touch = false;
      if (burn || d.y > kill || d.x < -200 || d.x > w.W * TS + 200) { d.burn = 12; d.x = -99999; d.y = -99999; d.vx = d.vy = 0; }
    }
    for (let i = 0; i < L.length; i++) {
      const a = L[i]; if (a.burn > 0) continue;
      for (let j = i + 1; j < L.length; j++) {
        const b = L[j]; if (b.burn > 0 || Math.abs(a.x - b.x) > 150 || Math.abs(a.y - b.y) > 150) continue;
        pairSep(a, b, 0.15);
      }
    }
  }
  // the player (a circle) against the pushables
  function collideDyn(b, w) {
    const L = w.dyn;
    for (let i = 0; i < L.length; i++) {
      const d = L[i];
      if (d.burn > 0 || Math.abs(d.x - b.x) > 90 || Math.abs(d.y - b.y) > 90) continue;
      if (d.k === 'b') {
        const px = clamp(b.x, d.x - d.hw, d.x + d.hw), py = clamp(b.y, d.y - d.hh, d.y + d.hh);
        let dx = b.x - px, dy = b.y - py, d2 = dx * dx + dy * dy;
        if (d2 >= R * R) continue;
        let nx, ny, pen;
        if (d2 === 0) { nx = 0; ny = -1; pen = R + d.hh; } else { const dd = Math.sqrt(d2); nx = dx / dd; ny = dy / dd; pen = R - dd; }
        if (ny < -0.6) {                   // standing on top
          b.y += ny * pen; if (b.vy > 0) b.vy = 0; b.ground = true; if (Math.abs(b.x - d.x) <= d.hw) { b.flat = true; b.gType = 1; }
          d.touch = true;
        } else if (ny > 0.6) {             // bonked the underside
          b.y += ny * pen; if (b.vy < 0) b.vy = 0;
        } else {                           // pushing from the side: lighter crates give way, heavy ones barely move
          const share = 1 / (1 + d.m * 0.7);
          const mv = nx * pen * share;
          d.x -= mv;
          if (boxHits(w, d.x, d.y, d.hw, d.hh)) { d.x += mv; b.x += nx * pen; } else b.x += nx * pen * (1 - share);
          const push = -nx * Math.sign(-nx * b.vx) ;
          if (b.vx * nx < 0) { d.vx = b.vx * share; b.vx *= 0.6 + 0.4 * share; }
          d.touch = true;
        }
      } else {
        const dx = d.x - b.x, dy = d.y - b.y, dist = Math.sqrt(dx * dx + dy * dy) || 0.001, pen = R + d.r - dist;
        if (pen <= 0) continue;
        const nx = dx / dist, ny = dy / dist, pm = 1.2, tm = pm + d.m;
        b.x -= nx * pen * (d.m / tm); b.y -= ny * pen * (d.m / tm); d.x += nx * pen * (pm / tm); d.y += ny * pen * (pm / tm);
        const vn = (d.vx - b.vx) * nx + (d.vy - b.vy) * ny;
        if (vn < 0) { const j = -1.15 * vn / (1 / pm + 1 / d.m); d.vx += j / d.m * nx; d.vy += j / d.m * ny; b.vx -= j / pm * nx * 0.5; if (ny > 0.6 && b.vy > 0) b.vy = 0; }
        if (ny > 0.6) { b.ground = true; b.flat = Math.abs(b.x - d.x) < 6; b.gType = 1; }
        d.touch = true;
      }
    }
  }

  const ev = { lava: false, jumped: false, landed: false };

  // ax: -1/0/1, jheld: jump button held. Set b.jbuf = 0.12 on a jump press.
  function step(b, w, ax, jheld, dt) {
    ev.lava = false; ev.jumped = false; ev.landed = false;
    const tx = Math.floor(b.x / TS), ty = Math.floor(b.y / TS);
    const water = tile(w, tx, ty) === 5;
    b.water = water;
    b.swimCool = Math.max(0, b.swimCool - dt);
    b.jbuf = Math.max(0, b.jbuf - dt);
    const wasGround = b.ground, preVy = b.vy;

    if (water) {
      // swimming: slow, floaty. Hold jump to swim up; at the surface it hops you out.
      b.vx = approach(b.vx, ax * 190, (ax ? 1500 : 500) * dt);
      const surface = tile(w, tx, ty - 1) !== 5;
      if (jheld || b.jbuf > 0) {
        if (surface) {
          if (b.swimCool <= 0) { b.vy = -520; b.swimCool = 0.35; b.jbuf = 0; ev.jumped = true; }
          else b.vy = approach(b.vy, -40, 1500 * dt);
        } else b.vy = approach(b.vy, -210, 2600 * dt);
      } else b.vy = approach(b.vy, 140, 1200 * dt);
      b.coyote = 0;
    } else {
      const ice = b.flat && b.gType === 3;
      // Grip only when the ball's centre is over the tile. Ice: slippery, but pushing the
      // other way brakes you fairly quickly.
      // ax may be fractional (a gentle swipe = a slow roll). A short tap builds speed gradually, so it barely moves you.
      const turning = ax !== 0 && b.vx !== 0 && Math.sign(b.vx) !== Math.sign(ax);
      const rate = b.flat ? (ice ? (ax ? 900 : 110) : (ax ? (turning ? 3600 : 2200) : 3400)) : (ax ? 1800 : 120);
      const target = (ax && Math.sign(b.vx) === Math.sign(ax) && Math.abs(b.vx) > MAXV) ? b.vx : ax * MAXV;
      b.vx = approach(b.vx, target, rate * dt);
      b.coyote = b.ground ? 0.1 : Math.max(0, b.coyote - dt);
      if (b.jbuf > 0 && b.coyote > 0) { b.vy = -JUMP; b.coyote = 0; b.jbuf = 0; b.ground = false; ev.jumped = true; }
      const g = GRAV * ((b.vy < 0 && !jheld) ? 3.6 : 1);   // let go early = tiny hop, hold = full jump
      b.vy = Math.min(MAXFALL, b.vy + g * dt);
    }

    b.x += b.vx * dt; b.y += b.vy * dt;
    b.rot += (b.vx * dt) / R;
    ev.lava = collide(b, w);
    if (!b.ghost && w.dyn.length) collideDyn(b, w);
    if (!wasGround && b.ground && preVy > 380 && !water) ev.landed = true;
    return ev;
  }

  const api = { TS, R, MAXV, makeWorld, tile, newBody, step, stepDyn };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.BallPhysics = api;
})(typeof window !== 'undefined' ? window : globalThis);

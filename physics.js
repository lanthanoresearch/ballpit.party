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
    return { W, H, grid, map };
  }

  function tile(w, tx, ty) {
    if (tx < 0 || tx >= w.W) return 1;      // invisible walls at the world's left/right edges
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
      const rate = b.flat ? (ice ? (ax ? 900 : 110) : (ax ? 3000 : 3400)) : (ax ? 1800 : 120);
      const target = (ax && Math.sign(b.vx) === ax && Math.abs(b.vx) > MAXV) ? b.vx : ax * MAXV;
      b.vx = approach(b.vx, target, rate * dt);
      b.coyote = b.ground ? 0.1 : Math.max(0, b.coyote - dt);
      if (b.jbuf > 0 && b.coyote > 0) { b.vy = -JUMP; b.coyote = 0; b.jbuf = 0; b.ground = false; ev.jumped = true; }
      const g = GRAV * ((b.vy < 0 && !jheld) ? 2.2 : 1);
      b.vy = Math.min(MAXFALL, b.vy + g * dt);
    }

    b.x += b.vx * dt; b.y += b.vy * dt;
    b.rot += (b.vx * dt) / R;
    ev.lava = collide(b, w);
    if (!wasGround && b.ground && preVy > 380 && !water) ev.landed = true;
    return ev;
  }

  const api = { TS, R, MAXV, makeWorld, tile, newBody, step };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.BallPhysics = api;
})(typeof window !== 'undefined' ? window : globalThis);

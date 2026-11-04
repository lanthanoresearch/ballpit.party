/* Shared ball physics (browser + Node, so maps can be bot-tested). */
(function (root) {
  'use strict';
  const TS = 40, R = 14;
  const GRAV = 1900, JUMP = 900, MAXV = 270, MAXFALL = 950, BOUNCE = 1080, BOUNCE_HELD = 1300, FALL_WARN = 1.6, FALL_DIE = 2.8;   // jump is ~210px high (about 5 tiles)
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
    const w = { W, H, grid, map, dyn: [], doors: [], plates: [], btns: [], see: [], pads: [], portals: [], ev: [], focus: null };
    const G = map.gadgets || {};
    (G.doors || []).forEach((d, i) => { const o = { id: i, x: d[0], y: d[1], w: d[2], h: d[3], open: false, latched: false }; w.doors.push(o); setDoorTiles(w, o, false); });
    (G.plates || []).forEach(p => w.plates.push({ x: p[0], y: p[1], w: p[2], to: p[3], on: false }));
    (G.btns || []).forEach(p => w.btns.push({ x: p[0], y: p[1], to: p[2], on: false }));
    (G.see || []).forEach(p => w.see.push({ cx: p[0] * TS, cy: p[1] * TS, hl: p[2] * TS, tilt: p[3], ang: p[3], av: 0, tq: 0 }));
    for (const p of (map.props || [])) addProp(w, p[0], (p[1] + 0.5) * TS, p[2] * TS - propDims(p[0]).half - 0.5);   // pushable yellow things; each player has their own copy (never shared)
    return w;
  }

  function setDoorTiles(w, d, open) {   // the top row (the beam) is always solid, so a crate or ball can stand on a gate whether it is open or shut
    d.open = open;
    for (let yy = d.y; yy < d.y + d.h; yy++) for (let xx = d.x; xx < d.x + d.w; xx++) if (xx >= 0 && xx < w.W && yy >= 0 && yy < w.H) w.grid[yy * w.W + xx] = open && yy > d.y ? 0 : 9;
  }
  const killYAt = (w, x) => { const f = w.map.floorY; return f ? f[clamp(Math.floor(x / TS), 0, w.W - 1)] * TS : w.map.killY; };

  function tile(w, tx, ty) {
    if (tx < 0 || tx >= w.W) return 0;      // beyond the world's edge is empty space (the game kills you out there)
    if (ty < 0 || ty >= w.H) return 0;
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
    const d = { k: r ? 'o' : 'b', x, y, hw, hh: hw, r, vx: 0, vy: 0, rot: 0, av: 0, tip: null, spin: false, gr: false, touch: false, burn: 0,
      m: r ? (r * r) / 256 : (4 * hw * hw) / 1296, kind };
    d.hx = d.x; d.hy = d.y; w.dyn.push(d); return d;
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
      if (t === 6 && ny < -0.5 && vn < -130) { d.vy = -BOUNCE * 0.85; d.gr = false; continue; }   // a bounce pad throws a toy up
      if (ny < -0.5) d.gr = true;
    }
    return burn;
  }
  // generic separation of two pushables (or one pushable and the player: pass player as {x,y,r,vx,vy,m})
  function pairSep(a, b, e, w) {
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
    let tm = a.m + b.m, sa = b.m / tm, sb = a.m / tm;
    if (!a.r && !b.r && ny !== 0) { if (ny > 0) { sa = 1; sb = 0; } else { sa = 0; sb = 1; } }   // crate on crate: only the upper one is pushed out, so a stack never squeezes its bottom crate into the floor
    // a crate that is sitting on the ground never gets pushed down into it: whatever it touches is moved instead
    const free = (o, dx, dy) => o.r || !w || !boxHits(w, o.x + dx, o.y + dy, o.hw, o.hh);
    const ax = -nx * pen * sa, ay = -ny * pen * sa, bx = nx * pen * sb, by = ny * pen * sb;
    const fa = free(a, ax, ay), fb = free(b, bx, by);
    if (fa && fb) { a.x += ax; a.y += ay; b.x += bx; b.y += by; }
    else if (fa) { a.x -= nx * pen; a.y -= ny * pen; }          // b is pinned against something: a takes all of it
    else if (fb) { b.x += nx * pen; b.y += ny * pen; }
    const vn = (b.vx - a.vx) * nx + (b.vy - a.vy) * ny;
    const ee = vn < -160 ? e : 0;                                // only a real knock bounces; resting contact is dead still
    if (vn < 0) {
      const ia = fa ? 1 / a.m : 0, ib = fb ? 1 / b.m : 0, im = ia + ib;
      if (im > 0) { const j = -(1 + ee) * vn / im; a.vx -= j * ia * nx; a.vy -= j * ia * ny; b.vx += j * ib * nx; b.vy += j * ib * ny; }
      else { const j = -vn * 0.5; a.vx -= j * nx; a.vy -= j * ny; b.vx += j * nx; b.vy += j * ny; }
    }
    if (Math.abs(ny) > 0.7) { a.touch = true; b.touch = true; if (!a.r && ny > 0) a.pc = true; if (!b.r && ny < 0) b.pc = true; }   // pc: this crate is sitting on something that is not the ground (a ball, another crate)
    if (Math.abs(nx) > 0.7) { a.touch = true; b.touch = true; }
    a._nx = nx; a._ny = ny; b._nx = -nx; b._ny = -ny;
    return true;
  }
  /* ---------- seesaws (teeter-totters): a tilting plank that you and the round toys can ride ---------- */
  const SEE_MAX = 0.36, SEE_TH = 6;
  function seeHit(s, o, r, wt) {   // circle o ({x,y,vx,vy}) vs plank; returns true if standing on it
    const c = Math.cos(s.ang), sn = Math.sin(s.ang);
    const rx = o.x - s.cx, ry = o.y - s.cy, u = clamp(rx * c + ry * sn, -s.hl, s.hl);
    const qx = s.cx + u * c, qy = s.cy + u * sn, dx = o.x - qx, dy = o.y - qy, d2 = dx * dx + dy * dy, m = r + SEE_TH;
    if (d2 >= m * m || (dy > 0 && Math.abs(dy) > m * 0.5 && o.vy < -50)) return false;
    let nx, ny;
    if (d2 < 0.0001) { nx = sn; ny = -c; } else { const d = Math.sqrt(d2); nx = dx / d; ny = dy / d; }
    if (ny > 0.3) return false;                         // from underneath: pass through (you can jump up through a plank edge case)
    const pen = m - Math.sqrt(d2); o.x += nx * pen; o.y += ny * pen;
    const svx = -s.av * (qy - s.cy), svy = s.av * (qx - s.cx);   // the plank's own movement at that spot
    const vn = (o.vx - svx) * nx + (o.vy - svy) * ny;
    if (vn < 0) { o.vx -= vn * nx; o.vy -= vn * ny; }
    if (!o.ghost) s.tq += wt * u;
    return ny < -0.35;
  }
  function stepSee(w, dt) {
    for (let i = 0; i < w.see.length; i++) {
      const s = w.see[i], f = w.focus;
      if (f && (Math.abs(s.cx - f.x) > 900 || Math.abs(s.cy - f.y) > 700)) continue;
      const target = s.tq === 0 ? s.tilt : clamp(s.tq / 3600, -1, 1) * SEE_MAX;
      const a0 = s.ang; s.ang += (target - s.ang) * Math.min(1, 3.2 * dt);
      s.av = (s.ang - a0) / dt; s.tq = 0;
    }
  }
  function seeBody(b, w, wt) {   // the player (or a round toy) against every nearby plank
    let on = false;
    for (let i = 0; i < w.see.length; i++) {
      const s = w.see[i]; if (Math.abs(s.cx - b.x) > s.hl + 40 || Math.abs(s.cy - b.y) > s.hl + 60) continue;
      if (seeHit(s, b, b.r || R, wt)) {
        on = true; b.onSee = s;
        const sl = Math.sin(s.ang);
        if (b.r === undefined) b.flat = Math.abs(sl) <= 0.06;   // on a tilted plank you slide; on a level one you grip
        if (b.r === undefined) { b.ground = true; b.gType = 1; }
      }
    }
    return on;
  }
  function seeBox(w, d, dt) {   // a crate against every nearby plank: it rides it, and its weight tips it
    let on = null;
    for (let i = 0; i < w.see.length; i++) {
      const s = w.see[i]; if (Math.abs(s.cx - d.x) > s.hl + d.hw + 12 || Math.abs(s.cy - d.y) > s.hl + d.hh + 60) continue;
      const c = Math.cos(s.ang), sn = Math.sin(s.ang), nx = sn, ny = -c, bottom = d.y + d.hh;
      let pen = -99;
      for (const px of [d.x - d.hw + 3, d.x, d.x + d.hw - 3]) {
        const rx = px - s.cx, ry = bottom - s.cy, along = rx * c + ry * sn;
        if (along < -s.hl - 2 || along > s.hl + 2) continue;
        const gap = SEE_TH - (rx * nx + ry * ny);           // how far the corner has sunk below the plank's top face
        if (gap > -4 && gap < SEE_TH + 18 && d.vy > -80 && gap > pen) pen = gap;   // within a few px counts as resting on it, so the weight doesn't flicker on and off
      }
      if (pen === -99) continue;
      if (pen < 0) pen = 0;
      const ox = d.x, oy = d.y;
      d.x += nx * pen; d.y += ny * pen;
      if (boxHits(w, d.x, d.y, d.hw, d.hh)) { d.x = ox; d.y = oy; continue; }   // pinned against the ground: leave it
      const svx = -s.av * (d.y + d.hh - s.cy), svy = s.av * (d.x - s.cx);   // how fast the plank itself is moving there
      const vn = (d.vx - svx) * nx + (d.vy - svy) * ny;
      if (vn < 0) { d.vx -= vn * nx; d.vy -= vn * ny; }
      const vt = (d.vx - svx) * c + (d.vy - svy) * sn, gripK = Math.abs(vt) < 140 ? vt : vt * Math.min(1, 5 * dt);   // wood grips a crate: it stays put on the plank (so a crate can hold one end down), but a firm push still slides it
      d.vx -= gripK * c; d.vy -= gripK * sn;
      s.tq += d.m * 60 * clamp((d.x - s.cx) * c + (d.y - s.cy) * sn, -s.hl, s.hl);   // the heavier the crate, the harder it presses
      on = s;
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
  function doorBlocked(w, d, b) {
    const x0 = d.x * TS, x1 = (d.x + d.w) * TS, y0 = (d.y + 1) * TS, y1 = (d.y + d.h) * TS;   // (the beam above is always solid, so only the gap below it can be blocked)
    if (b && b.x + R > x0 && b.x - R < x1 && b.y + R > y0 && b.y - R < y1) return true;
    for (let i = 0; i < w.dyn.length; i++) { const o = w.dyn[i]; if (o.burn > 0) continue; const e = o.r || o.hw; if (o.x + e > x0 && o.x - e < x1 && o.y + e > y0 && o.y - e < y1) return true; }
    return false;
  }
  function stepSwitches(w, b) {
    const want = w.doors.map(d => d.latched);
    for (let i = 0; i < w.btns.length; i++) {
      const q = w.btns[i]; if (q.on || !b || b.ghost) continue;
      const x0 = q.x * TS - R, x1 = (q.x + 1) * TS + R, fy = q.y * TS;
      if (b.x > x0 && b.x < x1 && b.y + R >= fy - 8 && b.y + R <= fy + 6) {
        q.on = true; q.t = 1; w.ev.push({ k: 'btn', x: (q.x + 0.5) * TS, y: fy });
        for (const di of q.to) { w.doors[di].latched = true; want[di] = true; }
      }
    }
    for (let i = 0; i < w.plates.length; i++) {
      const q = w.plates[i], x0 = q.x * TS, x1 = (q.x + q.w) * TS, fy = q.y * TS; let on = false;
      if (b && !b.ghost && b.x > x0 && b.x < x1 && b.y + R >= fy - 8 && b.y + R <= fy + 6 && b.ground) on = true;
      for (let j = 0; j < w.dyn.length && !on; j++) {
        const o = w.dyn[j]; if (o.burn > 0 || Math.abs(o.x - (x0 + x1) / 2) > 300) continue;
        const bot = o.y + (o.r || o.hh);
        if (o.x > x0 && o.x < x1 && bot >= fy - 8 && bot <= fy + 6) on = true;
      }
      if (on !== q.on) { q.on = on; w.ev.push({ k: 'plate', on, x: (q.x + q.w / 2) * TS, y: fy }); }
      if (on) for (const di of q.to) want[di] = true;
    }
    for (let i = 0; i < w.doors.length; i++) {
      const d = w.doors[i];
      if (want[i] && !d.open) { setDoorTiles(w, d, true); w.ev.push({ k: 'door', open: true, x: (d.x + d.w / 2) * TS, y: (d.y + d.h / 2) * TS, h: d.h }); }
      else if (!want[i] && d.open && !doorBlocked(w, d, b)) { setDoorTiles(w, d, false); w.ev.push({ k: 'door', open: false, x: (d.x + d.w / 2) * TS, y: (d.y + d.h / 2) * TS, h: d.h }); }
    }
  }


  /* ---------- crates that tip over ----------
     A crate stays put while its centre of mass is over something solid. Once the centre passes the edge it pivots on that corner,
     swings over, lets go, and tumbles down; it then settles flat again. Everything here depends only on the crate's own state, so it plays out the same on every device. */
  const HALF_PI = Math.PI / 2;
  function boxSupports(w, d, L) {   // the stretches of x the crate is resting on (floor tiles and crates underneath), merged
    const bottom = d.y + d.hh, row = Math.floor((bottom + 1.5) / TS), iv = [];
    if (Math.abs(row * TS - bottom) < 2.6) {
      const tx0 = Math.floor((d.x - d.hw) / TS), tx1 = Math.floor((d.x + d.hw - 0.01) / TS);
      for (let tx = tx0; tx <= tx1; tx++) if (isSol(tile(w, tx, row))) {
        let a = tx * TS, b = (tx + 1) * TS;
        if (tx === tx0) a = -1e9; if (tx === tx1) b = 1e9;   // solid ground that carries on past the crate's own edge: that side can never tip
        iv.push([a, b]);
      }
    }
    for (let i = 0; i < L.length; i++) {
      const o = L[i]; if (o === d || o.k !== 'b' || o.burn > 0 || o.tip || Math.abs(o.rot) > 0.25) continue;
      if (Math.abs(o.y - o.hh - bottom) < 3 && Math.abs(o.x - d.x) < o.hw + d.hw - 0.5) iv.push([o.x - o.hw, o.x + o.hw]);
    }
    if (!iv.length) return iv;
    iv.sort((a, b) => a[0] - b[0]);
    const out = [iv[0].slice()];
    for (let i = 1; i < iv.length; i++) { const t = out[out.length - 1]; if (iv[i][0] <= t[1] + 5) t[1] = Math.max(t[1], iv[i][1]); else out.push(iv[i].slice()); }
    return out;
  }
  function boxTipCheck(w, d, L) {   // is the centre of mass hanging past the edge of what it rests on? then start tipping
    const iv = boxSupports(w, d, L); if (!iv.length) return;
    for (const q of iv) if (d.x >= q[0] - 0.5 && d.x <= q[1] + 0.5) return;   // stable: the centre is over something
    let best = null, bd = 1e9;
    for (const q of iv) { const dd = d.x < q[0] ? q[0] - d.x : d.x - q[1]; if (dd < bd) { bd = dd; best = q; } }
    const s = d.x > best[1] ? 1 : -1, px = clamp(s > 0 ? best[1] : best[0], d.x - d.hw, d.x + d.hw), py = d.y + d.hh;
    d.tip = { s, px, py, rx: s * (d.x - px), a: 0, av: clamp(s * d.vx / (d.hh * 3), 0, 3) };
    d.vx = 0; d.vy = 0; d.rot = 0; d.av = 0;
  }
  function boxTipStep(w, d, dt) {
    const t = d.tip, h = d.hh;
    const rx = t.rx, ry = -h;
    const ca = Math.cos(t.a), sa = Math.sin(t.a);
    const xr = rx * ca - ry * sa;                              // the centre's sideways offset from the pivot, in the tipping frame
    const r2 = rx * rx + ry * ry, I = (d.hw * d.hw + d.hh * d.hh) / 3 + r2;
    const alpha = GRAV * xr / I;
    t.av += (alpha - t.av * 0.35) * dt; t.a += t.av * dt;
    const c = Math.cos(t.a), sn = Math.sin(t.a);
    const nx = rx * c - ry * sn, ny = rx * sn + ry * c;        // new centre relative to the pivot (screen coordinates, y down)
    const px = t.px + t.s * nx, py = t.py + ny;
    if (boxHits(w, px, py, d.hw * 0.55, d.hh * 0.55)) { d.tip = null; d.rot = 0; return; }   // something is in the way: it just settles back
    d.x = px; d.y = py; d.rot = t.s * t.a;
    if (t.a >= 0.85 || xr < -1) {   // it is over the edge: let go, carrying the swing as speed and spin
      const w0 = t.av;
      const vtx = -w0 * ny, vty = w0 * nx;                     // velocity of a point swinging about the pivot
      d.vx = t.s * vtx; d.vy = Math.max(0, vty); d.av = t.s * w0; d.tip = null; d.spin = true;
      for (let k = 0; k < 48 && boxHits(w, d.x, d.y, d.hw, d.hh); k++) d.x += t.s;   // step clear of the corner it pivoted on
    }
  }
  function boxSettle(w, d, L, dt) {   // after tumbling: spin while in the air, then lie flat again when it lands
    if (d.sr !== undefined) { d.rot += (d.sr - d.rot) * Math.min(1, 14 * dt); d.sr = undefined; d.spin = false; return; }   // on a plank it tilts with it
    if (!d.spin && !d.rot) return;
    const sup = (boxSupports(w, d, L).length > 0 || d.pc) && d.vy > -20 && Math.abs(d.vy) < 140;   // (resting on a ball counts too)
    if (!sup && d.spin) { d.rot += d.av * dt; d.av *= (1 - 0.4 * dt); return; }
    d.spin = false; d.av = 0;
    const tgt = Math.round(d.rot / HALF_PI) * HALF_PI;
    d.rot += (tgt - d.rot) * Math.min(1, 16 * dt);
    if (Math.abs(tgt - d.rot) < 0.02) d.rot = 0;
  }
  let dynTick = 0; const DYN_BUDGET = 160;
  function stepDyn(w, dt) {
    dynTick++;
    stepSee(w, dt);
    for (let i = 0; i < w.pads.length; i++) if (w.pads[i].t > 0) w.pads[i].t = Math.max(0, w.pads[i].t - dt);
    const L = w.dyn; if (!L.length) return;
    const f = w.focus, FR = 1100;
    if (f) {   // a very busy pile near you: only the nearest few dozen things are simulated each moment, so the game stays smooth however much has been built
      const near = [];
      for (let i = 0; i < L.length; i++) { const d = L[i]; d.skip = false; if (d.burn > 0 || d.nap || Math.abs(d.x - f.x) > FR || Math.abs(d.y - f.y) > FR) continue; near.push(d); }
      if (near.length > DYN_BUDGET) { near.sort((a, b) => Math.abs(a.x - f.x) + Math.abs(a.y - f.y) - Math.abs(b.x - f.x) - Math.abs(b.y - f.y)); for (let k = DYN_BUDGET; k < near.length; k++) near[k].skip = true; }
    }
    for (let i = 0; i < L.length; i++) {
      const d = L[i];
      if (d.skip) { d.sleep = true; continue; }
      if (d.burn > 0) { d.burn -= dt; if (d.burn <= 0) { d.x = d.hx; d.y = d.hy; d.vx = d.vy = 0; } continue; }
      if (f && (Math.abs(d.x - f.x) > FR || Math.abs(d.y - f.y) > FR)) { d.sleep = true; continue; }   // far from you: frozen (saves work)
      d.sleep = false;
      if (d.nap) { if (Math.abs(d.x - d.rx) + Math.abs(d.y - d.ry) > 2) { d.nap = false; d.rest = 0; } else if ((dynTick + i) % 12 !== 0) continue; }   // at rest: it only checks in now and then (so a big pile that has settled costs next to nothing, and anything that changes under it wakes it within a moment)
      const nx0 = d.x, ny0 = d.y;
      if (d.sq > 0) d.sq = Math.max(0, d.sq - dt);
      d.vy = Math.min(900, d.vy + GRAV * dt);
      let burn = false;
      if (d.k === 'o') {
        d.x += d.vx * dt; d.y += d.vy * dt; burn = ballTiles(d, w); d.rot += d.vx * dt / d.r;
        if (w.see.length) { seeBody(d, w, d.m * 60); seeGuard(w, d, d.r); }
        if (d.gr || d.touch) {   // rolling friction: a ball coasts, slows down and comes to rest (on ice it keeps sliding)
          if (tile(w, Math.floor(d.x / TS), Math.floor((d.y + d.r + 2) / TS)) !== 3) { d.vx *= Math.max(0, 1 - 0.9 * dt); d.vx = approach(d.vx, 0, 55 * dt); }
          else d.vx *= Math.max(0, 1 - 0.2 * dt);
        }
      } else if (d.tip) {
        boxTipStep(w, d, dt);
      } else {
        d.x += d.vx * dt; if (boxHits(w, d.x, d.y, d.hw, d.hh)) { d.x -= d.vx * dt; d.vx = 0; }
        d.y += d.vy * dt;
        if (boxHits(w, d.x, d.y, d.hw, d.hh)) {
          const hit = d.vy; d.y -= d.vy * dt; d.vy = 0;
          if (hit > 130 && tile(w, Math.floor(d.x / TS), Math.floor((d.y + d.hh + 2) / TS)) === 6) { d.vy = -BOUNCE * (d.hw > 20 ? 0.55 : 0.75); d.tip = null; }   // a bounce pad throws a crate up too (heavier ones less)
        }
        d.gr = boxHits(w, d.x, d.y + 1, d.hw, d.hh);
        const sp = w.see.length ? seeBox(w, d, dt) : null;
        if (w.see.length) seeGuard(w, d, d.hh);
        if (sp) { d.sr = sp.ang; if (Math.abs(Math.sin(sp.ang)) <= 0.06) d.gr = true; }
        const under = tile(w, Math.floor(d.x / TS), Math.floor((d.y + d.hh + 2) / TS));
        if (d.gr || d.touch) d.vx = approach(d.vx, 0, (under === 3 ? 40 : 900) * dt);
        const tl = tile(w, Math.floor(d.x / TS), Math.floor((d.y + d.hh - 4) / TS));
        if (tl === 2) burn = true;
        const onPlank = d.sr !== undefined;
        boxSettle(w, d, L, dt); d.pc = false;
        if (!onPlank && !d.spin && d.kind !== 5 && d.kind !== 6 && Math.abs(d.vy) < 120) boxTipCheck(w, d, L);
      }
      if (w.pads.length && (d.gr || d.touch)) { const pd = padAt(w, d.x, d.y + (d.r || d.hh)); if (pd) { d.vx = approach(d.vx, pd.dir * PAD_V * 0.8, 6000 * dt); pd.t = 0.3; } }
      if (w.portals.length) { d.pcd = Math.max(0, (d.pcd || 0) - dt); if (Math.abs(d.vx) > 15) d.pdir = d.vx > 0 ? 1 : -1;
        if (!d.pcd && d.vy > -60 && (d.gr || d.touch)) { const pt = portalAt(w, d.x, d.y + (d.r || d.hh)); if (pt) { const dir = d.pdir || 1, hf = d.r || d.hw; d.x = pt.to.x + dir * (26 + hf); d.y = pt.to.y - (d.r || d.hh) - 2; d.vx = dir * 260; d.vy = -300; d.pcd = 0.6; d.tip = null; w.ev.push({ k: 'portal', x: pt.from.x, y: pt.from.y, x2: pt.to.x, y2: pt.to.y }); } } }
      if (Math.abs(d.x - nx0) + Math.abs(d.y - ny0) < 1.0 && Math.abs(d.vx) < 25 && !burn) { d.rest = (d.rest || 0) + dt; if (d.rest > 0.5) { if (!d.nap) { d.rx = d.x; d.ry = d.y; } d.nap = true; } } else { d.rest = 0; d.nap = false; }
      d.touch = false;
      if (burn || d.y > killYAt(w, d.x) || d.x < -200 || d.x > w.W * TS + 200) { d.bx = d.x; d.by = d.y; d.bl = burn ? 1 : 0; d.bfx = 0; d.burn = 1e9; d.x = -99999; d.y = -99999; d.vx = d.vy = 0; }   // lost for good: this map will not give it back
    }
    for (let pass = 0, hit = true; pass < 3 && hit; pass++) {   // (a few rounds while things overlap, so a pile settles instead of sinking into itself)
      hit = false;
      for (let i = 0; i < L.length; i++) {
        const a = L[i]; if (a.burn > 0 || a.sleep) continue;
        for (let j = i + 1; j < L.length; j++) {
          const b = L[j]; if (b.burn > 0 || b.sleep || (a.nap && b.nap) || Math.abs(a.x - b.x) > 150 || Math.abs(a.y - b.y) > 150) continue;
          if (pairSep(a, b, 0.15, w)) hit = true;
        }
      }
    }
    for (let i = 0; i < L.length; i++) {   // nothing is ever left inside the ground: lift a crate that has been pushed into it
      const d = L[i]; if (d.k !== 'b' || d.burn > 0 || d.sleep || d.nap || d.tip) continue;
      if (boxHits(w, d.x, d.y, d.hw, d.hh)) { for (let k = 0; k < 24 && boxHits(w, d.x, d.y, d.hw, d.hh); k++) { d.y -= 1; } if (d.vy > 0) d.vy = 0; }
    }
  }
  // shove a crate sideways by dx, carrying along any crates in front of it (a row of crates moves together, and a jammed row acts as a wall, so nothing is ever squeezed into something else)
  function shoveBox(w, d, dx, depth, jr) {
    if (depth > 5) return false;
    const x0 = d.x; d.x += dx; d.nap = false; d.rest = 0;
    if (boxHits(w, d.x, d.y, d.hw, d.hh)) { d.x = x0; return false; }
    jr.push([d, x0]);
    const L = w.dyn;
    for (let i = 0; i < L.length; i++) {
      const e = L[i]; if (e === d || e.k !== 'b' || e.burn > 0 || Math.abs(e.x - d.x) > 90 || Math.abs(e.y - d.y) > 90) continue;
      const ox = d.hw + e.hw - Math.abs(d.x - e.x), oy = d.hh + e.hh - Math.abs(d.y - e.y);
      if (ox <= 0 || oy <= 3 || (e.x - d.x) * dx <= 0) continue;   // not in front of it (or only resting on top of it)
      if (!shoveBox(w, e, Math.sign(dx) * ox, depth + 1, jr)) return false;
      e.vx = d.vx; e.touch = true;
    }
    return true;
  }
  // the player (a circle) against the pushables
  function collideDyn(b, w) {
    const L = w.dyn;
    for (let i = 0; i < L.length; i++) {
      const d = L[i];
      if (d.burn > 0 || Math.abs(d.x - b.x) > 90 || Math.abs(d.y - b.y) > 90) continue;
      d.sleep = false; d.nap = false; d.rest = 0;
      if (d.k === 'b') {
        const px = clamp(b.x, d.x - d.hw, d.x + d.hw), py = clamp(b.y, d.y - d.hh, d.y + d.hh);
        let dx = b.x - px, dy = b.y - py, d2 = dx * dx + dy * dy;
        if (d2 >= R * R) continue;
        let nx, ny, pen;
        if (d2 === 0) { nx = 0; ny = -1; pen = R + d.hh; } else { const dd = Math.sqrt(d2); nx = dx / dd; ny = dy / dd; pen = R - dd; }
        if (ny < -0.6) {                   // standing on top
          b.y += ny * pen; if (b.vy > 0) b.vy = 0; b.ground = true; if (Math.abs(b.x - d.x) <= d.hw) { b.flat = true; b.gType = 1; }
          d.touch = true;
          if ((d.kind === 5 || d.kind === 6) && b.vy >= 0) { b.bnc = true; if (d.kind === 6) b.bncV = SUPER_BOUNCE; d.sq = 0.25; }   // a spring: land on it (or roll onto it) and it throws you up (a super spring: very high)
        } else if (ny > 0.6) {             // the crate is above you: it gets lifted (so one sitting on your head can never pin you down or stop you jumping); only a ceiling stops you
          if (!boxHits(w, d.x, d.y - pen, d.hw, d.hh)) { d.y -= pen; if (d.vy > b.vy) d.vy = b.vy; if (d.hw > 20 && b.vy < 0) b.vy *= 0.6; d.touch = true; }
          else { b.y += ny * pen; if (b.vy < 0) b.vy = 0; }
        } else {                           // pushing from the side: the crate is simply carried along; heavier ones slow you a little
          const mv = nx * pen, jr = [];       // push the crate completely out of the ball's way (and whatever is in front of it)
          if (!shoveBox(w, d, -mv, 0, jr)) { for (let q = jr.length - 1; q >= 0; q--) jr[q][0].x = jr[q][1]; b.x += nx * pen; if (b.vx * nx < 0) b.vx = 0; }   // it is jammed against something: it acts like a wall
          else if (b.vx * nx < 0) { let M = 0; for (const q of jr) { q[0].vx = b.vx; M += q[0].m; } b.vx *= 1 / (1 + M * 0.18); }
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
    if (!b.ghost && w.dyn.length) collideDyn(b, w);
    if (w.see.length) { seeBody(b, w, 60); if (!b.ghost) seeGuard(w, b, R); }
    const wet = water || tile(w, Math.floor(b.x / TS), Math.floor(b.y / TS)) === 5 || tile(w, Math.floor(b.x / TS), Math.floor((b.y + R * 0.8) / TS)) === 5;   // (checked again after moving: you can land in a shallow pool in the very same step)
    if (b.ground || wet) { if (!wasGround && !wet && !b.bnc && b.fall >= FALL_DIE) ev.splat = true; b.fall = 0; }
    else if (b.vy > 300) b.fall += dt; else if (b.vy < 0) b.fall = 0;
    if (b.bnc && !water) { b.bnc = false; b.vy = -(b.bncV || (jheld ? BOUNCE_HELD : BOUNCE)); b.launched = true; b.ground = false; b.coyote = 0; ev.bounced = true; }
    if (!wasGround && b.ground && preVy > 380 && !wet) ev.landed = true;
    return ev;
  }

  const api = { addPortal, padAt, addPad, PAD_V, TS, R, GRAV, propDims, addProp, spotFree, tile, MAXV, BOOST_T, BOOST_V, makeWorld, newBody, step, stepDyn, stepSwitches, setDoorTiles, killYAt, FALL_WARN, FALL_DIE };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.BallPhysics = api;
})(typeof window !== 'undefined' ? window : globalThis);

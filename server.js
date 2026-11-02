// ballpit.party - multiplayer relay server.   Run with:  npm install && npm start
// Optional environment variables:
//   PORT              port to listen on (hosts like Render/Railway set this for you)
//   MAX_PLAYERS      players per world (default 200). When a world is full, new players open World 2, 3, ...
//   MAP_OFFSET_HOURS  shift the 3-hour map schedule (default 0 => switches every 3 hours on UTC multiples of 3,
//                     which is 12, 3, 6, 9 o'clock US Central *Standard* Time; use -1 during daylight time)
//   STATS_FILE        where the all-time record is saved (default ./stats.json)
//   HOME_URL          optional: visitors who arrive on any other address are sent here (e.g. https://ballpit.party)
//   LINKS_FILE        where tracking links are saved (default ./links.json)
//   MAX_PER_IP        max simultaneous connections from one address (default 10)
const http = require('http');
const fs = require('fs');
const crypto = require('crypto');
const path = require('path');
const { WebSocketServer } = require('ws');
const maps = require('./maps.js');

const PORT = process.env.PORT || 3000;
const MAX_PLAYERS = Math.max(2, parseInt(process.env.MAX_PLAYERS, 10) || 200);   // players per world
const SLOT_MS = 3 * 60 * 60 * 1000;                       // a map "session" lasts 3 hours (12, 3, 6, 9 o'clock)
const OFFSET_MS = (parseFloat(process.env.MAP_OFFSET_HOURS) || 0) * 3600 * 1000;
const TICK_MS = 200;                                      // 5 position updates per second (the client smooths between them)
const RANGE = 3000;                                       // you only receive players within this many pixels of you (more than a screen)
const MAX_PER_IP = parseInt(process.env.MAX_PER_IP, 10) || 10;
const STATS_FILE = process.env.STATS_FILE || path.join(__dirname, 'stats.json');
const PATTERNS = 6;
const EMOJIS = 10;                                       // the built-in emoji chat: players can only send one of these (by number)
const MAX_LINKS = 5;                                      // how many people one player can track
const LINKS_FILE = process.env.LINKS_FILE || path.join(__dirname, 'links.json');

/* ---------- static files (loaded once, kept in memory) ---------- */
const FILES = {};
for (const [url, name, type] of [
  ['/', 'index.html', 'text/html; charset=utf-8'],
  ['/index.html', 'index.html', 'text/html; charset=utf-8'],
  ['/maps.js', 'maps.js', 'application/javascript; charset=utf-8'],
  ['/physics.js', 'physics.js', 'application/javascript; charset=utf-8'],
  ['/icon.svg', 'icon.svg', 'image/svg+xml'],
  ['/icon.png', 'icon.png', 'image/png'],
  ['/apple-touch-icon.png', 'apple-touch-icon.png', 'image/png'],
  ['/share.png', 'share.png', 'image/png'],
  ['/icon-192.png', 'icon-192.png', 'image/png'],
  ['/icon-512.png', 'icon-512.png', 'image/png'],
  ['/icon-maskable-512.png', 'icon-maskable-512.png', 'image/png'],
  ['/manifest.webmanifest', 'manifest.webmanifest', 'application/manifest+json'],
  ['/sw.js', 'sw.js', 'application/javascript; charset=utf-8']
]) FILES[url] = { data: fs.readFileSync(path.join(__dirname, name)), type };
// A fingerprint of the game files. The page asks for it on every visit and refreshes itself if it is holding an old copy.
const BUILD = crypto.createHash('sha1').update(FILES['/index.html'].data).update(FILES['/maps.js'].data).update(FILES['/physics.js'].data).update(FILES['/sw.js'].data).digest('hex').slice(0, 12);
const HOME_URL = (process.env.HOME_URL || '').replace(/\/+$/, '');   // optional: send visitors of any other address here, e.g. https://ballpit.party

/* ---------- all-time record ---------- */
let peak = 0, statsDirty = false, peakDirty = false;
try { peak = Math.max(0, JSON.parse(fs.readFileSync(STATS_FILE, 'utf8')).peak | 0); } catch (e) {}
function savePeak(sync) {
  if (!peakDirty) return;
  peakDirty = false;
  const s = JSON.stringify({ peak, savedAt: new Date().toISOString() });
  try { if (sync) fs.writeFileSync(STATS_FILE, s); else fs.writeFile(STATS_FILE, s, () => {}); } catch (e) {}
}

/* ---------- tracking links (two players tracking each other) ----------
   A device keeps a private random code. Others only ever see a one-way hash of it (the "pub" id), so the code can't be copied.
   Links are mutual and belong to the device, not the name, so they survive coming back later. */
const PUB = /^[0-9a-f]{16}$/, DEV = /^[A-Za-z0-9_-]{16,64}$/;
const pubOf = dev => crypto.createHash('sha256').update('ballpit:' + dev).digest('hex').slice(0, 16);
const links = new Map();      // pub -> Set(pub)
const gone = new Map();       // pub -> Set(pub): someone ended a link while this device was away
const claimsOf = new Map();   // pub -> Set(pub): what each device says it is linked to (lets links rebuild after a server restart)
const byPub = new Map();      // pub -> connected player
const pend = new Map();       // "from>to" -> { t }
let linksDirty = false;
try {
  const o = JSON.parse(fs.readFileSync(LINKS_FILE, 'utf8'));
  for (const k in (o.links || {})) if (PUB.test(k)) links.set(k, new Set((o.links[k] || []).filter(v => PUB.test(v)).slice(0, MAX_LINKS)));
  for (const k in (o.gone || {})) if (PUB.test(k)) gone.set(k, new Set((o.gone[k] || []).filter(v => PUB.test(v)).slice(0, 50)));
} catch (e) {}
function saveLinks(sync) {
  if (!linksDirty) return; linksDirty = false;
  const o = { links: {}, gone: {} };
  links.forEach((v, k) => { if (v.size) o.links[k] = [...v]; }); gone.forEach((v, k) => { if (v.size) o.gone[k] = [...v]; });
  const s = JSON.stringify(o);
  try { if (sync) fs.writeFileSync(LINKS_FILE, s); else fs.writeFile(LINKS_FILE, s, () => {}); } catch (e) {}
}
const linkSet = pub => { let s = links.get(pub); if (!s) links.set(pub, s = new Set()); return s; };
function addLink(a, b) { linkSet(a).add(b); linkSet(b).add(a); linksDirty = true; }
function dropLink(a, b) { const sa = links.get(a), sb = links.get(b); if (sa) sa.delete(b); if (sb) sb.delete(a); linksDirty = true; }
const peerInfo = q => ({ pub: q.pub, name: q.name, color: q.color, color2: q.color2, w: q.room ? q.room.id : 0 });
function sendLinks(p) {   // the full picture of who this player is linked to and who is online
  const on = [], all = [];
  for (const b of (links.get(p.pub) || [])) { all.push(b); const q = byPub.get(b); if (q && q.room) on.push(peerInfo(q)); }
  send(p, { t: 'links', all, on });
}

/* ---------- rooms ---------- */
let nextId = 1, nextRoomId = 1, online = 0;
const rooms = new Map();
const slotNow = () => Math.floor((Date.now() - OFFSET_MS) / SLOT_MS);
const nextAt = s => (s + 1) * SLOT_MS + OFFSET_MS;
let curSlot = slotNow();

const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  if (url === '/stats') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      online, peak, slot: curSlot, map: maps.names[curSlot % maps.count],
      rooms: [...rooms.values()].map(r => ({ id: r.id, players: r.players.size }))
    }));
  }
  if (url === '/version') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' });
    return res.end(JSON.stringify({ build: BUILD, home: HOME_URL }));
  }
  const f = FILES[url];
  if (!f) { res.writeHead(404); return res.end('Not found'); }
  let body = f.data;
  if (f.type.indexOf('text/html') === 0) {
    // the share image needs a full web address, so fill in this site's own address
    const proto = String(req.headers['x-forwarded-proto'] || 'http').split(',')[0].trim();
    const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim().replace(/[^A-Za-z0-9.:\-]/g, '');
    body = Buffer.from(f.data.toString('utf8').split('__ORIGIN__').join(proto.replace(/[^a-z]/g, '') + '://' + host).split('__BUILD__').join(BUILD));
  }
  res.writeHead(200, { 'Content-Type': f.type, 'Cache-Control': f.type.indexOf('image/') === 0 ? 'public, max-age=3600' : 'no-store' });
  res.end(body);
});

const wss = new WebSocketServer({ server, maxPayload: 1024, perMessageDeflate: false });

// Worlds are numbered 1, 2, 3...  Everyone goes to the lowest-numbered world with space; a new world only opens when the others are full.
function findRoom() {
  const full = [];
  for (let id = 1; id <= rooms.size + 1; id++) {
    const r = rooms.get(id);
    if (r && r.players.size >= MAX_PLAYERS) { full.push(id); continue; }
    if (r) return { room: r, full };
    const nr = { id, players: new Map(), finishers: [] };
    rooms.set(id, nr);
    return { room: nr, full };
  }
}

const HEX = /^#[0-9a-f]{6}$/i;
const cleanName = n => String(n == null ? '' : n).replace(/[^\p{L}\p{N} _\-.!']/gu, '').trim().slice(0, 6);   // blank is allowed
const cleanColor = (c, d) => (HEX.test(c) ? c : d);
const cleanPat = p => { p = p | 0; return p >= 0 && p < PATTERNS ? p : 0; };

function send(p, obj) { if (p.ws.readyState === 1) p.ws.send(JSON.stringify(obj)); }
function broadcast(room, obj, except) {
  const s = JSON.stringify(obj);
  for (const p of room.players.values()) if (p !== except && p.ws.readyState === 1) p.ws.send(s);
}
function leave(p) {
  const room = p.room;
  if (!room) return;
  p.room = null;
  if (p.pub && byPub.get(p.pub) === p) { byPub.delete(p.pub); for (const b of (links.get(p.pub) || [])) { const q = byPub.get(b); if (q) send(q, { t: 'loff', pub: p.pub, name: p.name }); } }
  online--; statsDirty = true;
  room.players.delete(p.id);
  for (const o of room.players.values()) o.vis.delete(p.id);
  if (room.players.size === 0) rooms.delete(room.id);
  else broadcast(room, { t: 'leave', id: p.id, name: p.name, pub: p.pub, n: room.players.size });
}

const ipCount = new Map();
wss.on('connection', (ws, req) => {
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || '?';
  const c = (ipCount.get(ip) || 0) + 1;
  if (c > MAX_PER_IP) { ws.close(1013, 'busy'); return; }
  ipCount.set(ip, c);

  const p = { id: nextId++, ws, name: '', color: '#ff4d4d', color2: '#ffffff', pat: 0, x: 0, y: 0, dead: 0, has: false, moved: false, vis: new Set(), room: null, fin: -1, msgs: 0, pub: '', lastReq: 0, lastFind: 0, lastEmo: 0 };
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  const rate = setInterval(() => { p.msgs = 0; }, 1000);

  ws.on('message', (raw) => {
    if (++p.msgs > 60) return;                       // simple flood protection
    let m;
    try { m = JSON.parse(raw); } catch (e) { return; }
    if (!m || typeof m.t !== 'string') return;

    if (m.t === 'hello') {
      if (p.room) return;
      p.name = cleanName(m.name);
      p.color = cleanColor(m.color, '#ff4d4d'); p.color2 = cleanColor(m.color2, '#ffffff'); p.pat = cleanPat(m.pat);
      const fr = findRoom(), room = fr.room;
      p.room = room;
      if (typeof m.dev === 'string' && DEV.test(m.dev)) p.pub = pubOf(m.dev);
      room.players.set(p.id, p);
      online++; statsDirty = true;
      if (online > peak) { peak = online; peakDirty = true; }
      send(p, {
        t: 'welcome', id: p.id, room: room.id, n: room.players.size, max: MAX_PLAYERS, full: fr.full,
        name: p.name, slot: curSlot, next: nextAt(curSlot), now: Date.now(), online, peak,
        players: [...room.players.values()].filter(o => o !== p).map(o => ({ id: o.id, pub: o.pub, name: o.name, color: o.color, color2: o.color2, pat: o.pat, crown: o.fin === curSlot ? 1 : 0 }))
      });
      broadcast(room, { t: 'join', id: p.id, pub: p.pub, name: p.name, color: p.color, color2: p.color2, pat: p.pat, n: room.players.size }, p);
      if (p.pub) {
        byPub.set(p.pub, p);
        const mine = new Set(Array.isArray(m.claims) ? m.claims.filter(v => typeof v === 'string' && PUB.test(v) && v !== p.pub).slice(0, MAX_LINKS) : []);
        claimsOf.set(p.pub, mine);
        const g = gone.get(p.pub), removed = [];
        if (g && g.size) { for (const v of g) { removed.push(v); const ls = links.get(p.pub); if (ls) ls.delete(v); } gone.delete(p.pub); linksDirty = true; }
        for (const v of mine) {   // rebuild a link if both sides still remember it (e.g. after the server restarted)
          if (removed.includes(v)) continue;
          const cv = claimsOf.get(v);
          if (cv && cv.has(p.pub) && linkSet(p.pub).size < MAX_LINKS && linkSet(v).size < MAX_LINKS) addLink(p.pub, v);
        }
        if (removed.length) send(p, { t: 'unl', gone: removed });
        sendLinks(p);
        for (const b of linkSet(p.pub)) { const q = byPub.get(b); if (q && q.room) { sendLinks(q); send(q, { t: 'lon', pub: p.pub, name: p.name }); } }
      }
      return;
    }
    if (!p.room) return;

    if (m.t === 'p') {
      if (m.m !== curSlot || !Number.isFinite(m.x) || !Number.isFinite(m.y)) return;
      const d = m.d ? 1 : 0;
      const x = Math.max(0, Math.min(262000, Math.round(m.x))), y = Math.max(0, Math.min(131000, Math.round(m.y)));
      if (p.x !== x || p.y !== y || p.dead !== d || !p.has) p.moved = true;
      p.x = x; p.y = y; p.dead = d; p.has = true;
    } else if (m.t === 'emo') {
      const i = m.i | 0, now = Date.now();
      if (i < 0 || i >= EMOJIS || now - p.lastEmo < 900) return;
      p.lastEmo = now;
      broadcast(p.room, { t: 'emo', id: p.id, pub: p.pub, name: p.name, i }, p);
    } else if (m.t === 'find') {
      const now = Date.now(); if (now - p.lastFind < 250) return; p.lastFind = now;
      const q = String(m.q == null ? '' : m.q).toLowerCase().slice(0, 6), list = [], mine = links.get(p.pub);
      for (const room of (q ? rooms.values() : [p.room])) {
        for (const o of room.players.values()) {
          if (o === p || !o.pub || o.pub === p.pub) continue;
          if (q && o.name.toLowerCase().indexOf(q) < 0) continue;
          list.push({ pub: o.pub, name: o.name, color: o.color, w: room.id, l: mine && mine.has(o.pub) ? 1 : 0 });
          if (list.length >= 12) break;
        }
        if (list.length >= 12) break;
      }
      send(p, { t: 'found', q, list });
    } else if (m.t === 'treq' || m.t === 'tacc' || m.t === 'tden') {
      if (!p.pub || typeof m.to !== 'string' || !PUB.test(m.to) || m.to === p.pub) return;
      const q = byPub.get(m.to), now = Date.now();
      if (m.t === 'treq') {
        if (now - p.lastReq < 1500) return; p.lastReq = now;
        if (!q || !q.room) return send(p, { t: 'tno', pub: m.to, why: 'off' });
        if (linkSet(p.pub).has(m.to)) return;
        if (linkSet(p.pub).size >= MAX_LINKS) return send(p, { t: 'tno', pub: m.to, name: q.name, why: 'mine' });
        if (linkSet(m.to).size >= MAX_LINKS) return send(p, { t: 'tno', pub: m.to, name: q.name, why: 'theirs' });
        let n = 0; pend.forEach((v, k) => { if (k.indexOf(p.pub + '>') === 0) n++; }); if (n >= 8) return;
        pend.set(p.pub + '>' + m.to, { t: now });
        send(q, { t: 'treq', pub: p.pub, name: p.name, color: p.color });
        send(p, { t: 'tsent', pub: m.to, name: q.name });
      } else {
        const k = m.to + '>' + p.pub, pr = pend.get(k);
        if (!pr || Date.now() - pr.t > 120000) { pend.delete(k); return send(p, { t: 'tno', pub: m.to, why: 'old' }); }
        pend.delete(k);
        if (!q || !q.room) return send(p, { t: 'tno', pub: m.to, why: 'off' });
        if (m.t === 'tden') return send(q, { t: 'tno', pub: p.pub, name: p.name, why: 'deny' });
        if (linkSet(p.pub).size >= MAX_LINKS || linkSet(m.to).size >= MAX_LINKS) return send(p, { t: 'tno', pub: m.to, why: 'full' });
        addLink(p.pub, m.to);
        const gp = gone.get(p.pub), gq = gone.get(m.to); if (gp) gp.delete(m.to); if (gq) gq.delete(p.pub);
        send(p, { t: 'tok', pub: m.to }); send(q, { t: 'tok', pub: p.pub });
        sendLinks(p); sendLinks(q);
      }
    } else if (m.t === 'unl') {
      if (!p.pub || typeof m.to !== 'string' || !PUB.test(m.to)) return;
      const had = linkSet(p.pub).has(m.to);
      dropLink(p.pub, m.to);
      const cp = claimsOf.get(p.pub); if (cp) cp.delete(m.to);
      if (had) {
        const q = byPub.get(m.to);
        if (q) { send(q, { t: 'unl', gone: [p.pub], name: p.name }); const cq = claimsOf.get(m.to); if (cq) cq.delete(p.pub); sendLinks(q); }
        else { let g = gone.get(m.to); if (!g) gone.set(m.to, g = new Set()); if (g.size < 50) g.add(p.pub); }
      }
      sendLinks(p);
    } else if (m.t === 'info') {
      p.name = cleanName(m.name);
      p.color = cleanColor(m.color, p.color); p.color2 = cleanColor(m.color2, p.color2); p.pat = cleanPat(m.pat);
      if (p.pub) for (const b of linkSet(p.pub)) { const q = byPub.get(b); if (q) sendLinks(q); }
      broadcast(p.room, { t: 'info', id: p.id, name: p.name, color: p.color, color2: p.color2, pat: p.pat }, p);
    } else if (m.t === 'finish') {
      if (m.m !== curSlot || !p.has || p.fin === curSlot) return;
      const flag = maps.generate(curSlot % maps.count).flag;
      const dx = p.x - flag[0] * maps.TS, dy = p.y - flag[1] * maps.TS;
      if (Math.abs(dx) > 14 * maps.TS || dy > 120 || dy < -400) return;   // must really be at the flag
      p.fin = curSlot;
      const room = p.room;
      room.finishers.push(p.id);
      broadcast(room, { t: 'fin', id: p.id, name: p.name, rank: room.finishers.length, ms: Math.max(0, Math.min(1e9, +m.ms || 0)) });
    }
  });

  ws.on('close', () => {
    clearInterval(rate);
    leave(p);
    const n = (ipCount.get(ip) || 1) - 1;
    if (n <= 0) ipCount.delete(ip); else ipCount.set(ip, n);
  });
  ws.on('error', () => {});
});

/* ---------- timers ---------- */
// Position updates. To keep bandwidth tiny, each player only receives (a) players near them,
// and (b) only those who moved since the last update (or just came into range), as a compact
// binary message: 3 header bytes + 8 bytes per player (x is sent at 2-pixel precision so wide maps fit). If nothing changed, nothing is sent.
let tickN = 0;
setInterval(() => {
  tickN++;
  // (c) a tiny overview every 2 seconds, so everyone shows up on the map even when they are far away
  if (tickN % 10 === 0) {
    for (const room of rooms.values()) {
      const list = [...room.players.values()];
      if (list.length < 2) continue;
      for (const r of list) {
        if (!r.has || r.ws.readyState !== 1) continue;
        const far = [];
        for (const p of list) if (p !== r && p.has && !p.dead && (Math.abs(p.x - r.x) > RANGE || Math.abs(p.y - r.y) > RANGE)) far.push(p);
        if (!far.length) continue;
        const cap = Math.min(far.length, 120), buf = Buffer.allocUnsafe(3 + cap * 8);
        buf[0] = 2; buf.writeUInt16LE(curSlot & 0xFFFF, 1);
        for (let k = 0; k < cap; k++) { const p = far[k]; buf.writeUInt32LE(p.id, 3 + k * 8); buf.writeUInt16LE(p.x >> 2, 7 + k * 8); buf.writeUInt16LE(p.y >> 1, 9 + k * 8); }
        r.ws.send(buf, { binary: true });
      }
    }
  }
  // (d) linked players always receive each other's position, wherever they are
  for (const r of byPub.values()) {
    if (!r.room || r.ws.readyState !== 1) continue;
    const ls = links.get(r.pub); if (!ls || !ls.size) continue;
    const arr = []; for (const b of ls) { const q = byPub.get(b); if (q && q.room && q.has) arr.push(q); }
    if (!arr.length) continue;
    const buf = Buffer.allocUnsafe(3 + arr.length * 12);
    buf[0] = 3; buf.writeUInt16LE(curSlot & 0xFFFF, 1);
    arr.forEach((q, k) => { const o = 3 + k * 12; buf.writeUInt32LE(parseInt(q.pub.slice(0, 8), 16) >>> 0, o); buf.writeUInt16LE(q.x >> 2, o + 4); buf.writeUInt16LE(q.dead ? 65535 : (q.y >> 1), o + 6); buf.writeUInt16LE(q.room.id & 0xFFFF, o + 8); buf.writeUInt16LE(0, o + 10); });
    r.ws.send(buf, { binary: true });
  }
  for (const room of rooms.values()) {
    const list = [...room.players.values()];
    if (list.length < 2) { for (const p of list) p.moved = false; continue; }
    for (const r of list) {
      if (!r.has || r.ws.readyState !== 1) continue;
      let k = 0; const hits = [];
      for (const p of list) {
        if (p === r || !p.has) continue;
        if (Math.abs(p.x - r.x) > RANGE || Math.abs(p.y - r.y) > RANGE) {
          if (r.vis.delete(p.id)) hits.push([p, 1]);   // they moved out of your range: tell the client to hide them (no stale ghosts)
          continue;
        }
        if (p.moved || !r.vis.has(p.id)) { hits.push([p, 0]); r.vis.add(p.id); }
      }
      if (!hits.length) continue;
      const buf = Buffer.allocUnsafe(3 + hits.length * 8);
      buf[0] = 1; buf.writeUInt16LE(curSlot & 0xFFFF, 1);
      for (const h of hits) { const p = h[0]; buf.writeUInt32LE(p.id, 3 + k * 8); buf.writeUInt16LE(p.x >> 2, 7 + k * 8); buf.writeUInt16LE(h[1] ? 65534 : p.dead ? 65535 : (p.y >> 1), 9 + k * 8); k++; }   // y: 65535 = just died, 65534 = out of range
      r.ws.send(buf, { binary: true });
    }
    for (const p of list) p.moved = false;
  }
}, TICK_MS);

// "N online / record" counter
setInterval(() => {
  if (!statsDirty) return;
  statsDirty = false;
  const s = JSON.stringify({ t: 'stats', online, peak });
  for (const room of rooms.values()) for (const p of room.players.values()) if (p.ws.readyState === 1) p.ws.send(s);
}, 5000);
setInterval(() => { savePeak(false); saveLinks(false); const t = Date.now(); pend.forEach((v, k) => { if (t - v.t > 120000) pend.delete(k); }); }, 15000);

// Map rotation (every 6 hours)
setInterval(() => {
  const s = slotNow();
  if (s === curSlot) return;
  curSlot = s;
  console.log('New session / map:', maps.names[curSlot % maps.count]);
  for (const room of rooms.values()) {
    room.finishers = [];
    for (const p of room.players.values()) { p.has = false; p.dead = 0; p.moved = false; p.vis.clear(); }
    broadcast(room, { t: 'newmap', slot: curSlot, next: nextAt(curSlot), now: Date.now() });
  }
}, 1000);

// Drop dead connections
setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, 25000);

function shutdown() { savePeak(true); saveLinks(true); process.exit(0); }
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

server.listen(PORT, () => {
  console.log(`ballpit.party running on http://localhost:${PORT}  (map: ${maps.names[curSlot % maps.count]}, record: ${peak})`);
});

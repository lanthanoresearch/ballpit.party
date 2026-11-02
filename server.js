// ballpit.party - multiplayer relay server.   Run with:  npm install && npm start
// Optional environment variables:
//   PORT              port to listen on (hosts like Render/Railway set this for you)
//   MAP_OFFSET_HOURS  shift the 6-hour map schedule (default 0 => switches at 00/06/12/18 UTC,
//                     which is 12:00 noon US Central *Standard* Time; use -1 for noon during daylight time)
//   STATS_FILE        where the all-time record is saved (default ./stats.json)
//   MAX_PER_IP        max simultaneous connections from one address (default 10)
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const maps = require('./maps.js');

const PORT = process.env.PORT || 3000;
const MAX_PLAYERS = 50;                                   // players per room
const SLOT_MS = 6 * 60 * 60 * 1000;                       // a map "session" lasts 6 hours
const OFFSET_MS = (parseFloat(process.env.MAP_OFFSET_HOURS) || 0) * 3600 * 1000;
const TICK_MS = 200;                                      // 5 position updates per second (the client smooths between them)
const RANGE = 3000;                                       // you only receive players within this many pixels of you (more than a screen)
const MAX_PER_IP = parseInt(process.env.MAX_PER_IP, 10) || 10;
const STATS_FILE = process.env.STATS_FILE || path.join(__dirname, 'stats.json');
const PATTERNS = 6;

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
  ['/share.png', 'share.png', 'image/png']
]) FILES[url] = { data: fs.readFileSync(path.join(__dirname, name)), type };

/* ---------- all-time record ---------- */
let peak = 0, statsDirty = false, peakDirty = false;
try { peak = Math.max(0, JSON.parse(fs.readFileSync(STATS_FILE, 'utf8')).peak | 0); } catch (e) {}
function savePeak(sync) {
  if (!peakDirty) return;
  peakDirty = false;
  const s = JSON.stringify({ peak, savedAt: new Date().toISOString() });
  try { if (sync) fs.writeFileSync(STATS_FILE, s); else fs.writeFile(STATS_FILE, s, () => {}); } catch (e) {}
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
  const f = FILES[url];
  if (!f) { res.writeHead(404); return res.end('Not found'); }
  let body = f.data;
  if (f.type.indexOf('text/html') === 0) {
    // the share image needs a full web address, so fill in this site's own address
    const proto = String(req.headers['x-forwarded-proto'] || 'http').split(',')[0].trim();
    const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim().replace(/[^A-Za-z0-9.:\-]/g, '');
    body = Buffer.from(f.data.toString('utf8').split('__ORIGIN__').join(proto.replace(/[^a-z]/g, '') + '://' + host));
  }
  res.writeHead(200, { 'Content-Type': f.type, 'Cache-Control': f.type.indexOf('image/') === 0 ? 'public, max-age=3600' : 'no-cache' });
  res.end(body);
});

const wss = new WebSocketServer({ server, maxPayload: 1024, perMessageDeflate: false });

function findRoom() {
  for (const r of rooms.values()) if (r.players.size < MAX_PLAYERS) return r;
  const r = { id: nextRoomId++, players: new Map(), finishers: [] };
  rooms.set(r.id, r);
  return r;
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
  online--; statsDirty = true;
  room.players.delete(p.id);
  for (const o of room.players.values()) o.vis.delete(p.id);
  if (room.players.size === 0) rooms.delete(room.id);
  else broadcast(room, { t: 'leave', id: p.id, name: p.name, n: room.players.size });
}

const ipCount = new Map();
wss.on('connection', (ws, req) => {
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || '?';
  const c = (ipCount.get(ip) || 0) + 1;
  if (c > MAX_PER_IP) { ws.close(1013, 'busy'); return; }
  ipCount.set(ip, c);

  const p = { id: nextId++, ws, name: '', color: '#ff4d4d', color2: '#ffffff', pat: 0, x: 0, y: 0, dead: 0, has: false, moved: false, vis: new Set(), room: null, fin: -1, msgs: 0 };
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
      const room = findRoom();
      p.room = room;
      room.players.set(p.id, p);
      online++; statsDirty = true;
      if (online > peak) { peak = online; peakDirty = true; }
      send(p, {
        t: 'welcome', id: p.id, room: room.id, n: room.players.size, max: MAX_PLAYERS,
        name: p.name, slot: curSlot, next: nextAt(curSlot), now: Date.now(), online, peak,
        players: [...room.players.values()].filter(o => o !== p).map(o => ({ id: o.id, name: o.name, color: o.color, color2: o.color2, pat: o.pat, crown: o.fin === curSlot ? 1 : 0 }))
      });
      broadcast(room, { t: 'join', id: p.id, name: p.name, color: p.color, color2: p.color2, pat: p.pat, n: room.players.size }, p);
      return;
    }
    if (!p.room) return;

    if (m.t === 'p') {
      if (m.m !== curSlot || !Number.isFinite(m.x) || !Number.isFinite(m.y)) return;
      const d = m.d ? 1 : 0;
      const x = Math.max(0, Math.min(131068, Math.round(m.x))), y = Math.max(0, Math.min(65533, Math.round(m.y)));
      if (p.x !== x || p.y !== y || p.dead !== d || !p.has) p.moved = true;
      p.x = x; p.y = y; p.dead = d; p.has = true;
    } else if (m.t === 'info') {
      p.name = cleanName(m.name);
      p.color = cleanColor(m.color, p.color); p.color2 = cleanColor(m.color2, p.color2); p.pat = cleanPat(m.pat);
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
setInterval(() => {
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
      for (const h of hits) { const p = h[0]; buf.writeUInt32LE(p.id, 3 + k * 8); buf.writeUInt16LE(p.x >> 1, 7 + k * 8); buf.writeUInt16LE(h[1] ? 65534 : p.dead ? 65535 : p.y, 9 + k * 8); k++; }   // y: 65535 = just died, 65534 = out of range
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
setInterval(() => savePeak(false), 15000);

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

function shutdown() { savePeak(true); process.exit(0); }
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

server.listen(PORT, () => {
  console.log(`ballpit.party running on http://localhost:${PORT}  (map: ${maps.names[curSlot % maps.count]}, record: ${peak})`);
});

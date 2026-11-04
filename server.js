// ballpit.party - multiplayer relay server.   Run with:  npm install && npm start
// Optional environment variables:
//   PORT              port to listen on (hosts like Render/Railway set this for you)
//   MAX_PLAYERS      players per world (default 20). When a world is full, new players open World 2, 3, ...
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
// what one world can hold of what people build (shared by everyone in it). Each player has their own, lower limits per item; these keep a full world quick.
const ROOM_PROPS = 800, ROOM_GATES = 200, ROOM_MISC = 2500, ROOM_CPS = 150;
const MAX_PLAYERS = Math.max(2, parseInt(process.env.MAX_PLAYERS, 10) || 20);   // players per world: few enough that a world full of builds stays smooth for everyone
const SLOT_MS = 3 * 60 * 60 * 1000;                       // a map "session" lasts 3 hours (12, 3, 6, 9 o'clock)
const OFFSET_MS = (parseFloat(process.env.MAP_OFFSET_HOURS) || 0) * 3600 * 1000;
const TICK_MS = 100;                                      // up to 10 position updates per second, and only for players who actually sent something new (the client fills in the motion between them)
const RANGE = 3000;                                       // you only receive players within this many pixels of you (more than a screen)
const MAX_PER_IP = parseInt(process.env.MAX_PER_IP, 10) || 10;
const STATS_FILE = process.env.STATS_FILE || path.join(__dirname, 'stats.json');
const PATTERNS = 6;
const EMOJIS = 24;                                       // the built-in chat: 10 emojis and 14 ready-made phrases. Players can only send one of these (by number)
const MAX_LINKS = 12;                                     // how many people one player can track
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
const BUILD_CHECK = process.env.BUILD_CHECK !== '0';   // (tests that talk to the server directly switch it off)
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
const HEX = /^#[0-9a-f]{6}$/i;
const cleanName = n => String(n == null ? '' : n).replace(/[^\p{L}\p{N} _\-.!']/gu, '').trim().slice(0, 12);   // blank is allowed
const cleanColor = (c, d) => (HEX.test(c) ? c : d);
const cleanPat = p => { p = p | 0; return p >= 0 && p < PATTERNS ? p : 0; };

const ADJ = ['Bouncy', 'Zippy', 'Wobbly', 'Sneaky', 'Jolly', 'Fuzzy', 'Speedy', 'Cosmic', 'Mighty', 'Dizzy', 'Cheeky', 'Rowdy', 'Lucky', 'Sunny'], NOUN = ['Fox', 'Owl', 'Bean', 'Pebble', 'Comet', 'Waffle', 'Otter', 'Yeti', 'Moose', 'Panda', 'Gecko', 'Robin', 'Mango', 'Pickle'];
const randomName = () => { for (let i = 0; i < 20; i++) { const n = ADJ[Math.random() * ADJ.length | 0] + NOUN[Math.random() * NOUN.length | 0]; if (n.length <= 12) return n; } return 'Rollie'; };
const PUB = /^[0-9a-f]{16}$/, DEV = /^[A-Za-z0-9_-]{16,64}$/;
const pubOf = dev => crypto.createHash('sha256').update('ballpit:' + dev).digest('hex').slice(0, 16);
const links = new Map();      // pub -> Set(pub)
const gone = new Map();       // pub -> Set(pub): someone ended a link while this device was away
const claimsOf = new Map();   // pub -> Set(pub): what each device says it is linked to (lets links rebuild after a server restart)
const byPub = new Map();      // pub -> connected player
const pend = new Map();       // "from>to" -> { t }
let linksDirty = false;
const DAY = 24 * 3600 * 1000, REQ_TTL = 7 * DAY;
const known = new Map();      // pub -> { name, color, last, nameAt }: everyone who has ever been here, so they can be searched for later
const CODE_CH = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';   // short codes skip look-alike letters (no I, L, O, 0, 1)
function codeOf(pub) { let n = BigInt('0x' + pub.slice(0, 12)), c = ''; for (let i = 0; i < 6; i++) { c = CODE_CH[Number(n % 31n)] + c; n /= 31n; } return c; }
try {
  const o = JSON.parse(fs.readFileSync(LINKS_FILE, 'utf8'));
  for (const k in (o.links || {})) if (PUB.test(k)) links.set(k, new Set((o.links[k] || []).filter(v => PUB.test(v)).slice(0, MAX_LINKS)));
  for (const k in (o.gone || {})) if (PUB.test(k)) gone.set(k, new Set((o.gone[k] || []).filter(v => PUB.test(v)).slice(0, 50)));
  for (const k in (o.known || {})) if (PUB.test(k)) { const v = o.known[k] || {}; known.set(k, { name: cleanName(v.name), color: HEX.test(v.color) ? v.color : '#ff4d4d', color2: HEX.test(v.color2) ? v.color2 : '#ffffff', pat: cleanPat(v.pat), last: +v.last || 0, nameAt: +v.nameAt || 0, beat: Math.max(0, Math.min(999, v.beat | 0)) }); }
  for (const e of (o.pend || [])) if (Array.isArray(e) && /^[0-9a-f]{16}>[0-9a-f]{16}$/.test(e[0]) && Date.now() - e[1] < REQ_TTL) pend.set(e[0], { t: +e[1] });
} catch (e) {}
function saveLinks(sync) {
  if (!linksDirty) return; linksDirty = false;
  // keep only what is needed: people not seen for two months (and not tied to a friend link or a waiting request) are forgotten
  { const old = Date.now() - STALE_MS, need = new Set(); links.forEach((v, k) => { if (v.size) { need.add(k); v.forEach(x => need.add(x)); } }); pend.forEach((v, k) => { const p2 = k.split('>'); need.add(p2[0]); need.add(p2[1]); });
    known.forEach((v, k) => { if (v.last < old && !need.has(k) && !byPub.has(k)) known.delete(k); }); }
  if (known.size > 5000) [...known.entries()].sort((a, b) => a[1].last - b[1].last).slice(0, known.size - 5000).forEach(e => known.delete(e[0]));
  const o = { links: {}, gone: {}, known: {}, pend: [...pend.entries()].map(e => [e[0], e[1].t]) };
  links.forEach((v, k) => { if (v.size) o.links[k] = [...v]; }); gone.forEach((v, k) => { if (v.size) o.gone[k] = [...v]; }); known.forEach((v, k) => { o.known[k] = v; });
  const s = JSON.stringify(o);
  try { if (sync) fs.writeFileSync(LINKS_FILE, s); else fs.writeFile(LINKS_FILE, s, () => {}); } catch (e) {}
}
const linkSet = pub => { let s = links.get(pub); if (!s) links.set(pub, s = new Set()); return s; };
function addLink(a, b) { linkSet(a).add(b); linkSet(b).add(a); linksDirty = true; }
function dropLink(a, b) { const sa = links.get(a), sb = links.get(b); if (sa) sa.delete(b); if (sb) sb.delete(a); linksDirty = true; }
const WEEK_MS = 7 * 86400000, STALE_MS = 60 * 86400000;   // the player list shows the last week; anybody gone for two months is deleted
const live = q => !!(q && (q.room || q.lobby));   // connected: playing in a world, or just sitting on the main menu
const peerInfo = pub => { const k = known.get(pub) || {}, q = byPub.get(pub); return { pub, code: codeOf(pub), name: q ? q.name : (k.name || ''), color: q ? q.color : (k.color || '#cccccc'), color2: q ? q.color2 : (k.color2 || '#ffffff'), pat: q ? q.pat | 0 : (k.pat | 0), on: live(q) ? 1 : 0, w: q && q.room ? (q.room.priv ? -1 : q.room.id) : 0, last: q ? Date.now() : (k.last || 0), b: k.beat | 0 }; };
function sendLinks(p) {   // everyone this player is linked to, with their short code, whether they are online, and when they were last here
  send(p, { t: 'links', list: [...(links.get(p.pub) || [])].map(peerInfo) });
}
// a player's name can be changed once a day (only for players with a device code)
function setName(p, nm) {
  if (!p.pub) { p.name = nm; return 0; }
  const now = Date.now(); let k = known.get(p.pub);
  if (!k) { k = { name: nm, color: p.color, color2: p.color2, pat: p.pat | 0, last: now, nameAt: 0 }; known.set(p.pub, k); p.name = nm; linksDirty = true; return 0; }
  if (nm !== k.name) {
    if (k.nameAt && now - k.nameAt < DAY) { p.name = k.name; return DAY - (now - k.nameAt); }
    if (k.name || k.nameAt) k.nameAt = now;
    k.name = nm; linksDirty = true;
  }
  p.name = k.name;
  return k.nameAt && now - k.nameAt < DAY ? DAY - (now - k.nameAt) : 0;
}

/* ---------- rooms ---------- */
let nextId = 1, nextRoomId = 1, online = 0;
const rooms = new Map();
const slotNow = () => maps.slotOf(Date.now() - OFFSET_MS);
const nextAt = s => maps.slotStart(s + 1) + OFFSET_MS;
let curSlot = slotNow();
const PRIV_BASE = 3000000, PRIV_MAX = 12;   // a friend's own world (their solo level, with the things they built) is a private room; its slot is the same number the solo game uses
const bstate = r => (r ? (r.priv || (r.build = r.build || { props: [], cps: [], gates: [], misc: [] })) : null);   // what has been built in a world: a friend's world keeps it with the game, a public world keeps it until the map changes
const rslot = r => (r && r.priv ? r.priv.slot : curSlot);
const privKey = pub => 'p' + pub;

const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  if (url === '/stats') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify({
      online, peak, slot: curSlot, map: maps.names[curSlot % maps.count],
      rooms: [...rooms.values()].filter(r => !r.priv).map(r => ({ id: r.id, players: r.players.size }))
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

const okProp = q => (Array.isArray(q) && q.length === 3 && (q[0] | 0) >= 0 && (q[0] | 0) <= 7 && Number.isFinite(q[1]) && Number.isFinite(q[2]) ? [q[0] | 0, Math.round(q[1]), Math.round(q[2])] : null);
const okGate = q => (Array.isArray(q) && q.length === 5 && q.every(Number.isFinite) && q[2] >= 2 && q[2] <= 8 ? q.map(Math.round) : null);
const okMisc = q => (Array.isArray(q) && q.length === 4 && (q[0] === 'bnc' || q[0] === 'spr' || q[0] === 'lav' || q[0] === 'tl') && q.slice(1).every(Number.isFinite) ? [q[0], Math.round(q[1]), Math.round(q[2]), Math.round(q[3])] : Array.isArray(q) && q.length === 4 && (q[0] === 'see' || q[0] === 'pad') && q.slice(1).every(Number.isFinite) ? [q[0], Math.round(q[1]), Math.round(q[2]), q[3] < 0 ? -1 : q[3] > 0 ? 1 : 0] : (Array.isArray(q) && q.length === 5 && q[0] === 'por' && q.slice(1).every(Number.isFinite) ? ['por', Math.round(q[1]), Math.round(q[2]), Math.round(q[3]), Math.round(q[4])] : null));
const okCp = q => (Array.isArray(q) && q.length === 2 && Number.isFinite(q[0]) && Number.isFinite(q[1]) ? [Math.round(q[0]), Math.round(q[1])] : null);
function send(p, obj) { if (p.ws.readyState === 1) p.ws.send(JSON.stringify(obj)); }
function broadcast(room, obj, except) {
  const s = JSON.stringify(obj);
  for (const p of room.players.values()) if (p !== except && p.ws.readyState === 1) p.ws.send(s);
}
function leave(p, toLobby) {
  const room = p.room;
  if (!room && !p.lobby) return;
  if (room && room.priv && room.priv.owner === p.id) {   // the host left: the world closes and everyone in it goes back to their own
    for (const o of [...room.players.values()]) if (o !== p) { send(o, { t: 'pclose', name: p.name }); leave(o, true); }
  }
  if (room) {
    p.room = null;
    online--; statsDirty = true;
    room.players.delete(p.id);
    for (const o of room.players.values()) o.vis.delete(p.id);
    if (room.players.size === 0) rooms.delete(room.id);
    else broadcast(room, { t: 'leave', id: p.id, name: p.name, pub: p.pub, n: room.players.size });
  }
  if (p.pub && known.has(p.pub)) { known.get(p.pub).last = Date.now(); linksDirty = true; }
  if (toLobby) {   // back to the main menu: still connected, just not in any world
    p.lobby = true; p.has = false; p.moved = false; p.vis = new Set();
    if (p.pub) for (const b of (links.get(p.pub) || [])) { const q = byPub.get(b); if (q) sendLinks(q); }
    return;
  }
  p.lobby = false;
  if (p.pub && byPub.get(p.pub) === p) { byPub.delete(p.pub); for (const b of (links.get(p.pub) || [])) { const q = byPub.get(b); if (q) send(q, { t: 'loff', pub: p.pub, name: p.name }); } }
}

const ipCount = new Map();
wss.on('connection', (ws, req) => {
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || '?';
  const c = (ipCount.get(ip) || 0) + 1;
  if (c > MAX_PER_IP) { ws.close(1013, 'busy'); return; }
  ipCount.set(ip, c);

  const p = { id: nextId++, ws, name: '', color: '#ff4d4d', color2: '#ffffff', pat: 0, x: 0, y: 0, vx: 0, vy: 0, st: 0, dead: 0, has: false, moved: false, vis: new Set(), room: null, fin: -1, msgs: 0, pub: '', lastReq: 0, lastFind: 0, lastEmo: 0 };
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  const rate = setInterval(() => { p.msgs = 0; }, 1000);

  ws.on('message', (raw, isBinary) => {
    if (++p.msgs > 60) return;                       // simple flood protection
    if (isBinary) {                                   // a position update: [0x70][slot u16][x/2 u16][y u16 (65535 = dead)][vx/5 i8][vy/20 i8][time u15 | grounded<<15]
      if (!p.room || raw.length !== 11 || raw[0] !== 0x70 || raw.readUInt16LE(1) !== (rslot(p.room) & 0xFFFF)) return;
      const x = Math.min(262000, raw.readUInt16LE(3) * 2), yr = raw.readUInt16LE(5), d = yr === 65535 ? 1 : 0;
      const y = d ? p.y : Math.min(131000, yr), vx = raw.readInt8(7) * 5, vy = raw.readInt8(8) * 20, st = raw.readUInt16LE(9);
      if (p.x !== x || p.y !== y || p.dead !== d || p.vx !== vx || p.vy !== vy || p.st !== st || !p.has) p.moved = true;
      p.x = x; p.y = y; p.dead = d; p.vx = d ? 0 : vx; p.vy = d ? 0 : vy; p.st = st; p.has = true;
      return;
    }
    let m;
    try { m = JSON.parse(raw); } catch (e) { return; }
    if (!m || typeof m.t !== 'string') return;

    if (m.t === 'hello') {
      if (p.room) return;
      // everybody must run exactly the same game (same physics): an out-of-date page is told to update and is not let in
      const cb = typeof m.b === 'string' ? m.b.slice(0, 20) : '';
      if (BUILD_CHECK && cb !== BUILD && cb.charAt(0) !== '_') { send(p, { t: 'update', build: BUILD }); setTimeout(() => { try { ws.close(4001, 'update'); } catch (e) {} }, 400); return; }
      const lobby = m.lobby ? 1 : 0, wasOn = p.lobby;   // lobby: the player is only on the main menu. Connected for friends, but not in any world and nobody sees them
      p.color = cleanColor(m.color, '#ff4d4d'); p.color2 = cleanColor(m.color2, '#ffffff'); p.pat = cleanPat(m.pat);
      if (typeof m.dev === 'string' && DEV.test(m.dev)) p.pub = pubOf(m.dev);
      let fr = null, room = null, priv = null;
      if (!lobby && m.host && typeof m.host === 'object') {   // open a world of your own for friends: your solo level and what you built on it
        if (!p.pub) { send(p, { t: 'jno', why: 'nodev' }); return; }
        const key = privKey(p.pub), lv = m.host.m | 0;
        if (rooms.has(key)) { send(p, { t: 'jno', why: 'busy' }); return; }
        const props = [], gates = [], misc = [], cps = [];   // (what the host built arrives right after, in small pieces)
        room = { id: key, players: new Map(), finishers: [], priv: { owner: p.id, hostPub: p.pub, slot: PRIV_BASE + Math.max(0, Math.min(maps.count - 1, lv)), idx: Math.max(0, Math.min(maps.count - 1, lv)), props, cps, gates, misc, invited: new Set(), keep: new Set(), once: new Set() } };
        rooms.set(key, room); p.room = room; fr = { full: [] };
      } else if (!lobby && typeof m.join === 'string' && PUB.test(m.join)) {   // go to a friend's world
        const hr = rooms.get(privKey(m.join));
        if (!hr || !hr.priv) { send(p, { t: 'jno', why: 'gone' }); return; }
        if (!p.pub || !(hr.priv.invited.has(p.pub) || linkSet(p.pub).has(m.join))) { send(p, { t: 'jno', why: 'nope' }); return; }
        if (hr.players.size >= PRIV_MAX) { send(p, { t: 'jno', why: 'full' }); return; }
        room = hr; p.room = room; fr = { full: [] };
      } else if (!lobby) { fr = findRoom(); room = fr.room; p.room = room; }
      p.lobby = lobby;
      let nm = cleanName(m.name);
      if (!nm && !lobby) nm = (p.pub && known.get(p.pub) && known.get(p.pub).name) || randomName();   // everybody has a name once they play
      if (!nm && lobby) nm = (p.pub && known.get(p.pub) && known.get(p.pub).name) || '';          // (a brand-new visitor on the menu has not picked one yet: that first pick stays free)
      const nameLeft = setName(p, nm);
      if (p.pub) { const k = known.get(p.pub); k.color = p.color; k.color2 = p.color2; k.pat = p.pat | 0; k.last = Date.now(); if (m.beat != null) k.beat = Math.max(0, Math.min(999, m.beat | 0)); linksDirty = true; }
      if (room) {
        room.players.set(p.id, p);
        online++; statsDirty = true;
        if (online > peak) { peak = online; peakDirty = true; }
        send(p, {
          t: 'welcome', id: p.id, room: room.id, n: room.players.size, max: MAX_PLAYERS, full: fr.full,
          name: p.name, code: p.pub ? codeOf(p.pub) : '', nameLeft, slot: rslot(room), next: room.priv ? Date.now() + 3e11 : nextAt(curSlot), now: Date.now(), online, peak,
          build: room.priv ? undefined : bstate(room), priv: room.priv ? { host: room.priv.owner === p.id ? 1 : 0, idx: room.priv.idx, props: room.priv.props, cps: room.priv.cps, gates: room.priv.gates, misc: room.priv.misc, hostName: (byPub.get(room.priv.hostPub) || {}).name || '', hostPub: room.priv.hostPub } : undefined,
          players: [...room.players.values()].filter(o => o !== p).map(o => ({ id: o.id, pub: o.pub, code: o.pub ? codeOf(o.pub) : '', name: o.name, color: o.color, color2: o.color2, pat: o.pat, crown: o.fin === rslot(room) ? 1 : 0 }))
        });
        broadcast(room, { t: 'join', id: p.id, pub: p.pub, code: p.pub ? codeOf(p.pub) : '', name: p.name, color: p.color, color2: p.color2, pat: p.pat, n: room.players.size }, p);
      } else {
        send(p, { t: 'welcome', lobby: 1, id: p.id, name: p.name, code: p.pub ? codeOf(p.pub) : '', nameLeft, slot: curSlot, next: nextAt(curSlot), now: Date.now(), online, peak });
      }
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
        rooms.forEach(r => { if (r.priv && (r.priv.keep.has(p.pub) || r.priv.once.has(p.pub)) && r !== p.room) { r.priv.once.delete(p.pub); send(p, { t: 'inv', pub: r.priv.hostPub, name: (byPub.get(r.priv.hostPub) || {}).name || '', idx: r.priv.idx }); } });   // an invite that came while you were away (one that was sent as 'ask once' is only shown the first time)
        for (const b of linkSet(p.pub)) { const q = byPub.get(b); if (live(q)) { sendLinks(q); if (!wasOn) send(q, { t: 'lon', pub: p.pub, name: p.name }); } }
        pend.forEach((v, k) => {   // friend requests that arrived while you were away
          if (k.slice(17) !== p.pub) return;
          if (Date.now() - v.t > REQ_TTL) { pend.delete(k); return; }
          const from = k.slice(0, 16), pi = peerInfo(from);
          send(p, { t: 'treq', pub: from, code: pi.code, name: pi.name, color: pi.color, color2: pi.color2, pat: pi.pat });
        });
      }
      return;
    }
    if (!p.room && !p.lobby) return;
    if (m.t === 'lobby') { if (p.room) leave(p, true); return; }   // back to the main menu: leave the world, stay connected

    if (m.t === 'p') {
      if (!p.room) return;
      if (m.m !== rslot(p.room) || !Number.isFinite(m.x) || !Number.isFinite(m.y)) return;
      const d = m.d ? 1 : 0;
      const x = Math.max(0, Math.min(262000, Math.round(m.x))), y = Math.max(0, Math.min(131000, Math.round(m.y)));
      if (p.x !== x || p.y !== y || p.dead !== d || !p.has) p.moved = true;
      p.x = x; p.y = y; p.dead = d; p.vx = 0; p.vy = 0; p.st = 0x8000; p.has = true;
    } else if (m.t === 'emo') {
      if (!p.room) return;
      const i = m.i | 0, now = Date.now();
      if (i < 0 || i >= EMOJIS || now - p.lastEmo < 900) return;
      p.lastEmo = now;
      broadcast(p.room, { t: 'emo', id: p.id, pub: p.pub, name: p.name, i }, p);
    } else if (m.t === 'inv') {   // the host asks a friend to come to their world
      const r = p.room; if (!r || !r.priv || r.priv.owner !== p.id || typeof m.to !== 'string' || !PUB.test(m.to) || !linkSet(p.pub).has(m.to)) return;
      const now = Date.now(); if (now - (p.lastInv || 0) < 700) return; p.lastInv = now;
      r.priv.invited.add(m.to);
      const q = byPub.get(m.to), keep = m.keep !== false;   // 'keep open' (the default): they are asked again every time they come back, for as long as the game is open
      if (keep) { r.priv.keep.add(m.to); r.priv.once.delete(m.to); } else { r.priv.keep.delete(m.to); if (!live(q)) r.priv.once.add(m.to); }
      if (live(q)) send(q, { t: 'inv', pub: p.pub, name: p.name, idx: r.priv.idx });
      send(p, { t: 'invsent', pub: m.to, on: live(q) ? 1 : 0 });
    } else if (m.t === 'pb') {   // a bunch of builds at once (up to 25 of one kind): what somebody had built before joining this world
      const r = p.room; if (!r || !bstate(r)) return;
      const now = Date.now(); if (now - (p.lastPb || 0) < 180) return; p.lastPb = now;
      const B = bstate(r), e = {};
      const take = (key, arr, ok, cap) => { if (!Array.isArray(m[key])) return; const out = []; for (const q of m[key].slice(0, 25)) { const c = ok(q); if (c && arr.length < cap) { arr.push(c); out.push(c); } } if (out.length) e[key] = out; };
      take('props', B.props, okProp, ROOM_PROPS); take('gates', B.gates, okGate, ROOM_GATES); take('misc', B.misc, okMisc, ROOM_MISC); take('cps', B.cps, okCp, ROOM_CPS);
      if (Object.keys(e).length) { e.t = 'pb'; broadcast(r, e, p); }
    } else if (m.t === 'pobj') {   // a teeter-totter or a floor booster, built in a friend's world
      const r = p.room; if (!bstate(p.room) || !Array.isArray(m.g) || !((m.g.length === 4 && (m.g[0] === 'see' || m.g[0] === 'pad' || m.g[0] === 'bnc' || m.g[0] === 'spr' || m.g[0] === 'lav' || m.g[0] === 'tl')) || (m.g.length === 5 && m.g[0] === 'por')) || !m.g.slice(1).every(Number.isFinite) || bstate(r).misc.length >= ROOM_MISC || ((m.g[0] === 'see' || m.g[0] === 'por') && bstate(r).misc.filter(q => q[0] === m.g[0]).length >= 80)) return;
      const now = Date.now(); if (now - (p.lastAdd || 0) < 150) return; p.lastAdd = now;
      const e = (m.g[0] === 'bnc' || m.g[0] === 'spr' || m.g[0] === 'lav' || m.g[0] === 'tl') ? [m.g[0], Math.round(m.g[1]), Math.round(m.g[2]), Math.round(m.g[3])] : m.g[0] === 'por' ? ['por', Math.round(m.g[1]), Math.round(m.g[2]), Math.round(m.g[3]), Math.round(m.g[4])] : [m.g[0], Math.round(m.g[1]), Math.round(m.g[2]), m.g[3] < 0 ? -1 : m.g[3] > 0 ? 1 : 0]; bstate(r).misc.push(e); broadcast(r, { t: 'pobj', g: e }, p);
    } else if (m.t === 'pgate') {   // a gate and its trigger, built in a friend's world
      const r = p.room; if (!bstate(p.room) || !Array.isArray(m.g) || m.g.length !== 5 || !m.g.every(Number.isFinite) || m.g[2] < 2 || m.g[2] > 8 || bstate(r).gates.length >= ROOM_GATES) return;
      const now = Date.now(); if (now - (p.lastAdd || 0) < 150) return; p.lastAdd = now;
      const e = m.g.map(Math.round); bstate(r).gates.push(e); broadcast(r, { t: 'pgate', g: e }, p);
    } else if (m.t === 'padd' || m.t === 'pcp') {   // somebody built something in a friend's world: everyone there gets it
      const r = p.room; if (!bstate(p.room)) return;
      const now = Date.now(); if (now - (p.lastAdd || 0) < 150) return; p.lastAdd = now;
      if (m.t === 'padd') {
        const k = m.k | 0; if (k < 0 || k > 7 || !Number.isFinite(m.x) || !Number.isFinite(m.y) || bstate(r).props.length >= ROOM_PROPS) return;
        const e = [k, Math.round(m.x), Math.round(m.y)]; bstate(r).props.push(e); broadcast(r, { t: 'padd', k: e[0], x: e[1], y: e[2] }, p);
      } else {
        if (!Number.isFinite(m.x) || !Number.isFinite(m.y) || bstate(r).cps.length >= ROOM_CPS) return;
        const e = [Math.round(m.x), Math.round(m.y)]; bstate(r).cps.push(e); broadcast(r, { t: 'pcp', x: e[0], y: e[1] }, p);
      }
    } else if (m.t === 'find') {
      const now = Date.now(); if (now - p.lastFind < 250) return; p.lastFind = now;
      const raw = String(m.q == null ? '' : m.q).trim().slice(0, 12), q = raw.toLowerCase(), qc = raw.toUpperCase().replace(/^#/, ''), mine = links.get(p.pub), out = [];
      const browse = !raw;   // nothing typed: the whole list of players from the last week. Typing searches everybody still on record.
      known.forEach((k, pub) => {
        if (pub === p.pub) return;
        const code = codeOf(pub), q2 = byPub.get(pub), on = live(q2) ? (q2.room || true) : null, nm = q2 ? q2.name : k.name, last = on ? now : k.last;
        if (!nm) return;   // has never picked a name, so has never really played
        const linked = !!(mine && mine.has(pub));
        if (!on && !linked && now - last > (WEEK_MS)) return;
        if (!browse && !(nm.toLowerCase().indexOf(q) >= 0 || code === qc || code.indexOf(qc) === 0 && qc.length >= 3)) return;
        out.push({ pub, code, name: nm, color: q2 ? q2.color : k.color, color2: q2 ? q2.color2 : (k.color2 || '#ffffff'), pat: q2 ? q2.pat | 0 : (k.pat | 0), b: k.beat | 0, on: on ? 1 : 0, w: on && on !== true ? on.id : 0, last, here: on && on !== true && on === p.room ? 1 : 0, l: linked ? 1 : 0 });
      });
      out.sort((a, b) => (b.here - a.here) || (b.on - a.on) || (b.last - a.last));
      send(p, { t: 'found', q: raw, list: out.slice(0, browse ? 80 : 30), n: out.length });
    } else if (m.t === 'treq' || m.t === 'tacc' || m.t === 'tden') {
      if (!p.pub || typeof m.to !== 'string' || !PUB.test(m.to) || m.to === p.pub) return;
      const q = byPub.get(m.to), now = Date.now();
      if (m.t === 'treq') {
        if (now - p.lastReq < 1500) return; p.lastReq = now;
        const kn = known.get(m.to);   // a server that was restarted may have forgotten them; the request still waits for them
        const tn = q ? q.name : kn ? kn.name : String(m.nm || '').replace(/[^\w .\-]/g, '').slice(0, 12);
        if (linkSet(p.pub).has(m.to)) return;
        if (linkSet(p.pub).size >= MAX_LINKS) return send(p, { t: 'tno', pub: m.to, name: tn, why: 'mine' });
        if (linkSet(m.to).size >= MAX_LINKS) return send(p, { t: 'tno', pub: m.to, name: tn, why: 'theirs' });
        let n = 0; pend.forEach((v, k) => { if (k.indexOf(p.pub + '>') === 0) n++; }); if (n >= 8) return;
        pend.set(p.pub + '>' + m.to, { t: now }); linksDirty = true;
        if (live(q)) send(q, { t: 'treq', pub: p.pub, code: codeOf(p.pub), name: p.name, color: p.color, color2: p.color2, pat: p.pat | 0 });
        send(p, { t: 'tsent', pub: m.to, name: tn, off: live(q) ? 0 : 1 });
      } else {
        const k = m.to + '>' + p.pub, pr = pend.get(k);
        if (!pr || Date.now() - pr.t > REQ_TTL) { pend.delete(k); return send(p, { t: 'tno', pub: m.to, why: 'old' }); }
        pend.delete(k); linksDirty = true;
        if (m.t === 'tden') { if (live(q)) send(q, { t: 'tno', pub: p.pub, name: p.name, why: 'deny' }); return; }
        if (linkSet(p.pub).size >= MAX_LINKS || linkSet(m.to).size >= MAX_LINKS) return send(p, { t: 'tno', pub: m.to, why: 'full' });
        addLink(p.pub, m.to);
        const gp = gone.get(p.pub), gq = gone.get(m.to); if (gp) gp.delete(m.to); if (gq) gq.delete(p.pub);
        send(p, { t: 'tok', pub: m.to }); sendLinks(p);
        if (live(q)) { send(q, { t: 'tok', pub: p.pub }); sendLinks(q); }
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
      const want = cleanName(m.name) || p.name, left = setName(p, want);
      send(p, { t: 'name', name: p.name, left, denied: want !== p.name ? 1 : 0 });
      p.color = cleanColor(m.color, p.color); p.color2 = cleanColor(m.color2, p.color2); p.pat = cleanPat(m.pat);
      if (p.pub && known.get(p.pub)) { known.get(p.pub).color = p.color; known.get(p.pub).color2 = p.color2; known.get(p.pub).pat = p.pat | 0; if (m.beat != null) known.get(p.pub).beat = Math.max(0, Math.min(999, m.beat | 0)); linksDirty = true; }
      if (p.pub) for (const b of linkSet(p.pub)) { const q = byPub.get(b); if (q) sendLinks(q); }
      if (p.room) broadcast(p.room, { t: 'info', id: p.id, name: p.name, color: p.color, color2: p.color2, pat: p.pat }, p);
    } else if (m.t === 'finish') {
      if (!p.room) return;
      const sl = rslot(p.room);
      if (m.m !== sl || !p.has || p.fin === sl) return;
      const flag = maps.generate(sl % maps.count).flag;
      const dx = p.x - flag[0] * maps.TS, dy = p.y - flag[1] * maps.TS;
      if (Math.abs(dx) > 14 * maps.TS || dy > 120 || dy < -400) return;   // must really be at the flag
      p.fin = sl;
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
  if (tickN % 20 === 0) {
    for (const room of rooms.values()) {
      const list = [...room.players.values()];
      if (list.length < 2) continue;
      for (const r of list) {
        if (!r.has || r.ws.readyState !== 1) continue;
        const far = [];
        for (const p of list) if (p !== r && p.has && !p.dead && (Math.abs(p.x - r.x) > RANGE || Math.abs(p.y - r.y) > RANGE)) far.push(p);
        if (!far.length) continue;
        const cap = Math.min(far.length, 120), buf = Buffer.allocUnsafe(3 + cap * 8);
        buf[0] = 2; buf.writeUInt16LE(rslot(room) & 0xFFFF, 1);
        for (let k = 0; k < cap; k++) { const p = far[k]; buf.writeUInt32LE(p.id, 3 + k * 8); buf.writeUInt16LE(p.x >> 2, 7 + k * 8); buf.writeUInt16LE(p.y >> 1, 9 + k * 8); }
        r.ws.send(buf, { binary: true });
      }
    }
  }
  // (d) linked players always receive each other's position, wherever they are
  for (const r of byPub.values()) {
    if (!r.room || r.ws.readyState !== 1) continue;
    const ls = links.get(r.pub); if (!ls || !ls.size) continue;
    const arr = []; let fresh = tickN % 10 === 0; for (const b of ls) { const q = byPub.get(b); if (q && q.room && q.has && rslot(q.room) === rslot(r.room)) { arr.push(q); if (q.moved) fresh = true; } }
    if (!arr.length || !fresh) continue;   // (only when somebody moved, plus a heartbeat every second)
    const buf = Buffer.allocUnsafe(3 + arr.length * 12);
    buf[0] = 3; buf.writeUInt16LE(rslot(r.room) & 0xFFFF, 1);
    arr.forEach((q, k) => { const o = 3 + k * 12; buf.writeUInt32LE(parseInt(q.pub.slice(0, 8), 16) >>> 0, o); buf.writeUInt16LE(q.x >> 2, o + 4); buf.writeUInt16LE(q.dead ? 65535 : (q.y >> 1), o + 6); buf.writeUInt16LE(q.room.id & 0xFFFF, o + 8); buf.writeInt8(q.dead ? 0 : Math.max(-127, Math.min(127, Math.round(q.vx / 5))), o + 10); buf.writeInt8(q.dead ? 0 : Math.max(-127, Math.min(127, Math.round(q.vy / 20))), o + 11); });
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
      const buf = Buffer.allocUnsafe(3 + hits.length * 12);
      buf[0] = 1; buf.writeUInt16LE(rslot(room) & 0xFFFF, 1);
      for (const h of hits) {   // per player: id u32, x/2 u16, y u16 (65535 = just died, 65534 = out of range), vx/5 i8, vy/20 i8, time+grounded u16
        const p = h[0], o = 3 + k * 12, gone = h[1] || p.dead; k++;
        buf.writeUInt32LE(p.id, o); buf.writeUInt16LE(p.x >> 1, o + 4); buf.writeUInt16LE(h[1] ? 65534 : p.dead ? 65535 : Math.min(65533, p.y), o + 6);
        buf.writeInt8(gone ? 0 : Math.max(-127, Math.min(127, Math.round(p.vx / 5))), o + 8); buf.writeInt8(gone ? 0 : Math.max(-127, Math.min(127, Math.round(p.vy / 20))), o + 9); buf.writeUInt16LE(p.st & 0xFFFF, o + 10);
      }
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
setInterval(() => { linksDirty = true; }, 6 * 3600000);   // (re-checks who has been gone for two months)
setInterval(() => { savePeak(false); saveLinks(false); const t = Date.now(); pend.forEach((v, k) => { if (t - v.t > REQ_TTL) pend.delete(k); }); }, 15000);

// Map rotation (every 6 hours)
setInterval(() => {
  const s = slotNow();
  if (s === curSlot) return;
  curSlot = s;
  console.log('New session / map:', maps.names[curSlot % maps.count]);
  for (const room of rooms.values()) {
    if (room.priv) continue;
    room.build = null;
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

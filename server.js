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
//   VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY   keys for phone and desktop notifications. Set both so they never change (otherwise they are made once and
//                     kept in the links file). VAPID_SUBJECT is an optional contact address, e.g. mailto:you@example.com
const http = require('http');
const fs = require('fs');
const crypto = require('crypto');
const path = require('path');
const { WebSocketServer } = require('ws');
const maps = require('./maps.js');
const P = require('./physics.js');

const PORT = process.env.PORT || 3000;
// what one world can hold of what people build (shared by everyone in it). Each player has their own, lower limits per item; these keep a full world quick.
const ROOM_PROPS = 800, ROOM_GATES = 200, ROOM_MISC = 6000, ROOM_CPS = 150, ROOM_DELS = 3000;
const MAX_PLAYERS = Math.max(2, parseInt(process.env.MAX_PLAYERS, 10) || 20);   // players per world: few enough that a world full of builds stays smooth for everyone
const SLOT_MS = 3 * 60 * 60 * 1000;                       // a map "session" lasts 3 hours (12, 3, 6, 9 o'clock)
const OFFSET_MS = (parseFloat(process.env.MAP_OFFSET_HOURS) || 0) * 3600 * 1000;
const TICK_MS = 33;                                      // up to 30 position updates per second, and only for players who actually sent something new (the client fills in the motion between them)
const RANGE = 3000;                                       // you only receive players within this many pixels of you (more than a screen)
const MAX_PER_IP = parseInt(process.env.MAX_PER_IP, 10) || 10;
const STATS_FILE = process.env.STATS_FILE || path.join(__dirname, 'stats.json');
const PATTERNS = 6;
const EMOJIS = 64;                                       // the built-in chat: 10 emojis and 14 ready-made phrases. Players can only send one of these (by number)
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
const GAME_V = 119;   // (the version of the game this server runs: the game's version panel shows it)
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
const news = new Map();       // pub -> [{ p, ok, t }]: answers to this player's friend requests that came while they were away (yes or not now), kept until their device says it has seen them
let linksDirty = false;
const DAY = 24 * 3600 * 1000, REQ_TTL = 90 * DAY;   // a friend request waits for an answer for three months
const known = new Map();      // pub -> { name, color, last, nameAt }: everyone who has ever been here, so they can be searched for later
const CODE_CH = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';   // short codes skip look-alike letters (no I, L, O, 0, 1)
function codeOf(pub) { let n = BigInt('0x' + pub.slice(0, 12)), c = ''; for (let i = 0; i < 6; i++) { c = CODE_CH[Number(n % 31n)] + c; n /= 31n; } return c; }
/* ---------- notifications to phones and computers (Web Push), written with Node's own crypto so nothing extra needs installing ----------
   A device that wants them sends its address ("subscription") and what it wants. Only devices that are not connected right now are pushed to:
   anybody who is in the game gets the same news inside the game. Subscriptions are rebuilt by each device whenever it connects. */
const https = require('https');
const b64u = b => Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = s => Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
const pushSubs = new Map();   // pub -> { ep, p, a, f, r, i, m, mu: [muted friend pubs], t }
let vapid = null;             // { pub: base64url public key, key: private KeyObject, priv: base64url d }
function makeVapid(pubB64, privB64) {
  try {
    const pub = unb64u(pubB64), d = unb64u(privB64); if (pub.length !== 65 || pub[0] !== 4 || d.length !== 32) return null;
    const key = crypto.createPrivateKey({ key: { kty: 'EC', crv: 'P-256', x: b64u(pub.slice(1, 33)), y: b64u(pub.slice(33)), d: b64u(d) }, format: 'jwk' });
    return { pub: b64u(pub), key, priv: b64u(d) };
  } catch (e) { return null; }
}
function newVapid() {
  const kp = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' }), j = kp.privateKey.export({ format: 'jwk' });
  return makeVapid(b64u(Buffer.concat([Buffer.from([4]), unb64u(j.x), unb64u(j.y)])), j.d);
}
const PUSH_HOST = /(^|\.)(googleapis\.com|push\.services\.mozilla\.com|notify\.windows\.com|push\.apple\.com|mozilla\.com)$/i;
const okPushUrl = u => { try { const x = new URL(u); return process.env.PUSH_ALLOW_ANY === '1' || (x.protocol === 'https:' && PUSH_HOST.test(x.hostname) && String(u).length < 700); } catch (e) { return false; } };
function pushBody(sub, text) {   // RFC 8291 (aes128gcm): the message only the device can read
  const ua = unb64u(sub.p), auth = unb64u(sub.a), ecdh = crypto.createECDH('prime256v1'); ecdh.generateKeys();
  const asPub = ecdh.getPublicKey(), secret = ecdh.computeSecret(ua), salt = crypto.randomBytes(16);
  const ikm = Buffer.from(crypto.hkdfSync('sha256', secret, auth, Buffer.concat([Buffer.from('WebPush: info\0'), ua, asPub]), 32));
  const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16)), nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const c = crypto.createCipheriv('aes-128-gcm', cek, nonce), ct = Buffer.concat([c.update(Buffer.concat([Buffer.from(text), Buffer.from([2])])), c.final(), c.getAuthTag()]);
  const hdr = Buffer.alloc(21); salt.copy(hdr, 0); hdr.writeUInt32BE(4096, 16); hdr[20] = asPub.length;
  return Buffer.concat([hdr, asPub, ct]);
}
function sendPush(pub, payload) {
  const sub = pushSubs.get(pub); if (!sub || !vapid) return;
  let u; try { u = new URL(sub.ep); } catch (e) { pushSubs.delete(pub); return; }
  const now = Math.floor(Date.now() / 1000), head = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' })), claims = b64u(JSON.stringify({ aud: u.origin, exp: now + 12 * 3600, sub: process.env.VAPID_SUBJECT || 'https://ballpit.party' }));
  const sig = crypto.sign('sha256', Buffer.from(head + '.' + claims), { key: vapid.key, dsaEncoding: 'ieee-p1363' });
  let body; try { body = pushBody(sub, JSON.stringify(payload)); } catch (e) { return; }
  const rq = (u.protocol === 'http:' ? http : https).request({ method: 'POST', hostname: u.hostname, port: u.port || undefined, path: u.pathname + u.search, timeout: 8000, headers: { 'Content-Type': 'application/octet-stream', 'Content-Encoding': 'aes128gcm', 'Content-Length': body.length, TTL: '3600', Urgency: 'normal', Authorization: 'vapid t=' + head + '.' + claims + '.' + b64u(sig) + ', k=' + vapid.pub } }, res => {
    res.resume(); if (res.statusCode === 404 || res.statusCode === 410) { if (pushSubs.get(pub) === sub) { pushSubs.delete(pub); linksDirty = true; } }
  });
  rq.on('error', () => {}); rq.on('timeout', () => rq.destroy()); rq.end(body);
}
const pushLast = new Map();   // pub + tag -> time: the same news is not pushed again and again
function pushTo(pub, kind, n, tag, from) {   // kind: 'f' friends online, 'r' friend requests, 'i' invites, 'm' new map. Only to devices that are not connected right now.
  const sub = pushSubs.get(pub), here = byPub.get(pub); if (!sub || !sub[kind] || (live(here) && !here.hidden) || (from && sub.mu && sub.mu.indexOf(from) >= 0)) return;
  const k = pub + tag, t = Date.now(), gap = kind === 'f' ? 20 * 60000 : kind === 'm' ? 60 * 60000 : 30000; if (t - (pushLast.get(k) || 0) < gap) return; pushLast.set(k, t);
  if (pushLast.size > 4000) { for (const [kk, v] of pushLast) if (t - v > 3600000) pushLast.delete(kk); }
  sendPush(pub, { title: String(n[0]).slice(0, 60), body: String(n[1]).slice(0, 100), tag });
}

try {
  const o = JSON.parse(fs.readFileSync(LINKS_FILE, 'utf8'));
  for (const k in (o.links || {})) if (PUB.test(k)) links.set(k, new Set((o.links[k] || []).filter(v => PUB.test(v)).slice(0, MAX_LINKS)));
  for (const k in (o.gone || {})) if (PUB.test(k)) gone.set(k, new Set((o.gone[k] || []).filter(v => PUB.test(v)).slice(0, 50)));
  for (const k in (o.known || {})) if (PUB.test(k)) { const v = o.known[k] || {}; known.set(k, { name: cleanName(v.name), color: HEX.test(v.color) ? v.color : '#ff4d4d', color2: HEX.test(v.color2) ? v.color2 : '#ffffff', pat: cleanPat(v.pat), last: +v.last || 0, nameAt: +v.nameAt || 0, beat: Math.max(0, Math.min(999, v.beat | 0)) }); }
  for (const e of (o.pend || [])) if (Array.isArray(e) && /^[0-9a-f]{16}>[0-9a-f]{16}$/.test(e[0]) && Date.now() - e[1] < REQ_TTL) pend.set(e[0], { t: +e[1] });
  if (o.vapid && o.vapid.pub && o.vapid.priv) vapid = makeVapid(o.vapid.pub, o.vapid.priv);
  for (const k in (o.push || {})) if (PUB.test(k) && o.push[k] && okPushUrl(o.push[k].ep)) { const v = o.push[k]; pushSubs.set(k, { ep: String(v.ep), p: String(v.p).slice(0, 100), a: String(v.a).slice(0, 40), f: v.f ? 1 : 0, r: v.r ? 1 : 0, i: v.i ? 1 : 0, m: v.m ? 1 : 0, mu: Array.isArray(v.mu) ? v.mu.filter(x => PUB.test(x)).slice(0, 12) : [], t: +v.t || 0 }); }
  for (const e of (o.news || [])) if (Array.isArray(e) && PUB.test(e[0]) && Array.isArray(e[1])) news.set(e[0], e[1].filter(x => x && PUB.test(x.p) && Date.now() - x.t < REQ_TTL).map(x => ({ p: x.p, ok: x.ok ? 1 : 0, t: +x.t })).slice(-30));
  console.log('Restored ' + known.size + ' players, ' + [...links.values()].reduce((a, v) => a + v.size, 0) / 2 + ' friendships, ' + pend.size + ' waiting requests, from ' + LINKS_FILE);
} catch (e) {}
{ const ev = process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY ? makeVapid(process.env.VAPID_PUBLIC_KEY.trim(), process.env.VAPID_PRIVATE_KEY.trim()) : null;
  if (ev) vapid = ev; else if (!vapid) { vapid = newVapid(); linksDirty = true; } }   // (keys from the settings win; otherwise they are made once and kept with the saved links)
function saveLinks(sync) {
  if (!linksDirty) return; linksDirty = false;
  // keep only what is needed: people not seen for two months (and not tied to a friend link or a waiting request) are forgotten
  { const old = Date.now() - STALE_MS, need = new Set(); links.forEach((v, k) => { if (v.size) { need.add(k); v.forEach(x => need.add(x)); } }); pend.forEach((v, k) => { const p2 = k.split('>'); need.add(p2[0]); need.add(p2[1]); }); news.forEach((v, k) => { need.add(k); v.forEach(x => need.add(x.p)); });
    known.forEach((v, k) => { if (v.last < old && !need.has(k) && !byPub.has(k)) known.delete(k); }); }
  if (known.size > 5000) [...known.entries()].sort((a, b) => a[1].last - b[1].last).slice(0, known.size - 5000).forEach(e => known.delete(e[0]));
  const o = { links: {}, gone: {}, known: {}, pend: [...pend.entries()].map(e => [e[0], e[1].t]), news: [...news.entries()].filter(e => e[1].length), vapid: vapid ? { pub: vapid.pub, priv: vapid.priv } : undefined, push: Object.fromEntries(pushSubs) };
  links.forEach((v, k) => { if (v.size) o.links[k] = [...v]; }); gone.forEach((v, k) => { if (v.size) o.gone[k] = [...v]; }); known.forEach((v, k) => { o.known[k] = v; });
  const s = JSON.stringify(o);
  try {   /* written to a side file first and then swapped in, so a restart in the middle of saving can never leave a half-written list */
    const tmp = LINKS_FILE + '.tmp';
    if (sync) { fs.writeFileSync(tmp, s); fs.renameSync(tmp, LINKS_FILE); } else fs.writeFile(tmp, s, er => { if (!er) fs.rename(tmp, LINKS_FILE, () => {}); });
  } catch (e) {}
}
const linkSet = pub => { let s = links.get(pub); if (!s) links.set(pub, s = new Set()); return s; };
function addLink(a, b) { linkSet(a).add(b); linkSet(b).add(a); linksDirty = true; }
function dropLink(a, b) { const sa = links.get(a), sb = links.get(b); if (sa) sa.delete(b); if (sb) sb.delete(a); linksDirty = true; }
const STALE_MS = 90 * 86400000;   // everybody who has played is listed; anybody gone for three months (and not a friend or in a waiting request) is forgotten
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
const bstate = r => { if (!r) return null; const b = r.priv || (r.build = r.build || { props: [], cps: [], gates: [], misc: [] }); if (!b.dels) b.dels = []; return b; };   // what has been built in a world: a friend's world keeps it with the game, a public world keeps it until the map changes
const rslot = r => (r && r.priv ? r.priv.slot : curSlot);
const privKey = pub => 'p' + pub;

const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  if (url === '/stats') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify({
      online, peak, slot: curSlot, map: maps.names[curSlot % maps.count], players: known.size, push: pushSubs.size,   // (players: everybody on record; if this drops to a few after a restart, the saved file is not surviving restarts)
      rooms: [...rooms.values()].filter(r => !r.priv).map(r => ({ id: r.id, players: r.players.size }))
    }));
  }
  if (url === '/vapid') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' });
    return res.end(JSON.stringify({ key: vapid ? vapid.pub : '' }));
  }
  if (url === '/version') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' });
    return res.end(JSON.stringify({ build: BUILD, home: HOME_URL, v: GAME_V }));
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

const wss = new WebSocketServer({ server, maxPayload: 65536, perMessageDeflate: false });   // (a world's memory, sent back by a player after a restart, comes in parts of up to 60 KB)

// Worlds are numbered 1, 2, 3...  Everyone goes to the lowest-numbered world with space; a new world only opens when the others are full.
function roomFresh(r) {   // a public world this server knows nothing about (it was restarted and lost its memory): a player who was here may have it
  if (!r || r.priv || r.seeded || !r.virgin) return false;   // (virgin: there was no memory of it at all when it was opened)
  const b = r.build; return !b || (!b.props.length && !b.misc.length && !b.gates.length && !b.cps.length && !(b.dels || []).length);
}
function snapFor(r) {   // a world's memory as the players keep it: what is built, and where everything is that has been moved
  const w = r.world; if (!w) return null;
  const d = []; for (const o of w.dyn) { if (o.burn >= 1e9) d.push([o.uid >>> 0, 0, 0, 0, 1]); else if (!(o.burn > 0) && (Math.abs(o.x - o.hx) > 1 || Math.abs(o.y - o.hy) > 1 || Math.abs(o.rot) > 0.005)) d.push([o.uid >>> 0, Math.round(o.x * 10) / 10, Math.round(o.y * 10) / 10, Math.round(o.rot * 1000) / 1000]); }
  return { d, s: w.see.filter(q => Math.abs(q.ang) > 0.001).map(q => [q.uid >>> 0, Math.round(q.ang * 1000) / 1000]) };
}
const hashStr = s => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0).toString(36); };
setInterval(() => {   // every few seconds each player is given the world's memory (only when it changed): if this server ever forgets, the last one here brings it back
  const now = Date.now();
  for (const r of rooms.values()) {
    if (r.priv || !r.world || !r.players.size) continue;
    const sn = snapFor(r); if (!sn) continue;
    const bs = JSON.stringify(bstate(r)), bh = hashStr(bs), ds = JSON.stringify(sn), dh = hashStr(ds);
    for (const p of r.players.values()) {
      if (!p.has || p.ws.readyState !== 1 || (p.sbh === bh && p.sdh === dh)) continue;
      const msg = '{"t":"wsnap","k":"' + wkey(r.id) + '","at":' + now + ',"bh":"' + bh + '"' + (p.sbh === bh ? '' : ',"b":' + bs) + ',"w":' + ds + '}';
      try { p.ws.send(msg); p.sbh = bh; p.sdh = dh; } catch (e) {}
    }
  }
}, 10000).unref();
function loadSaved(r) {   // what this map's room had the last time it was played (things built and where everything ended up)
  const sv = savedWorlds.get(wkey(r.id)); r.build = null; r.snapDyn = undefined; r.snapSee = undefined; r.virgin = !sv; r.seeded = false; r.seedBy = null;
  if (sv) { if (sv.build) r.build = sv.build; r.snapDyn = sv.dyn; r.snapSee = sv.see; }
}
function findRoom() {
  const full = [];
  for (let id = 1; id <= rooms.size + 1; id++) {
    const r = rooms.get(id);
    if (r && r.players.size >= MAX_PLAYERS) { full.push(id); continue; }
    if (r) return { room: r, full };
    const nr = { id, players: new Map(), finishers: [], bornAt: Date.now() };
    loadSaved(nr);   // (a world that was here before comes back as it was)
    rooms.set(id, nr);
    return { room: nr, full };
  }
}


/* ---------- the shared world ----------
   Every world (public or private) has ONE set of crates, balls, planks and gates, worked out here with the same physics the game uses (physics.js).
   Players never touch each other, but everybody pushes the same things. Each device is sent where things are and shows exactly that. */
const SIMDT = 1 / 60;
function srvTerrain(w, tx, r, to) {
  if (tx < 0 || tx >= w.W || r < 0 || r >= w.H) return;
  const i = r * w.W + tx, cur = w.grid[i]; if (cur === 4 || cur === 9 || (cur === 6 && to !== 1)) return;   // (a ground spring can only be turned back into plain ground)
  w.grid[i] = to === 7 ? 1 : to;
  if (w.grid[i] === 1 || w.grid[i] === 3) P.liftOut(w, tx, r);
}
function srvBounce(w, tx, r, n) { for (let k = 0; k < (n || 2); k++) { const i = r * w.W + tx + k; if (tx + k >= 0 && tx + k < w.W && r >= 0 && r < w.H && (w.grid[i] === 1 || w.grid[i] === 3)) w.grid[i] = 6; } }
function srvMisc(w, q) {
  const k = q[0], TS = P.TS;
  if (k === 'bnc' || k === 'spr') srvBounce(w, q[1], q[2], k === 'spr' ? 1 : 2);
  else if (k === 'tl') { if (q[3] === -1) { const i = q[2] * w.W + q[1]; if (q[1] >= 0 && q[1] < w.W && q[2] >= 0 && q[2] < w.H) srvTerrain(w, q[1], q[2], w.orig[i]); } else srvTerrain(w, q[1], q[2], q[3]); }
  else if (k === 'lav') { const i = q[2] * w.W + q[1]; if (q[2] < w.H && q[1] >= 0 && q[1] < w.W && (w.grid[i] === 1 || w.grid[i] === 3)) w.grid[i] = 2; }
  else if (k === 'see') { const cx = (q[1] + 1) * TS, cy = q[2] * TS - 46; w.see.push({ cx, cy, hl: 3 * TS, tilt: 0, ang: 0, av: 0, tq: 0, uid: P.hash32('s' + Math.round(cx) + ',' + Math.round(cy)) }); }
  else if (k === 'por') P.addPortal(w, q);
  else if (k === 'pad') P.addPad(w, [q[1], q[2], q[3]]);
}
function srvGate(w, q) {
  const id = w.doors.length, d = { id, uid: P.hash32('g' + q.slice(0, 5).join(',')), x: q[0], y: q[1], w: 1, h: q[2], open: false, latched: false };
  w.doors.push(d); P.setDoorTiles(w, d, false); w.plates.push({ x: q[3], y: q[4], w: 2, to: [id], on: false });
}
function roomWorld(room) {
  if (room.world) return room.world;
  const m = maps.generate(rslot(room) % maps.count), w = P.makeWorld(m);
  w.orig = w.grid.slice(); w.closeDelay = 0.6; w.focus = []; w.follow = false;
  const B = bstate(room);
  (B.misc || []).forEach(q => { try { srvMisc(w, q); } catch (e) {} });
  (B.gates || []).forEach(q => { try { srvGate(w, q); } catch (e) {} });
  (B.props || []).forEach(q => { try { P.addProp(w, q[0], q[1], q[2]); } catch (e) {} });
  (B.dels || []).forEach(q => { try { P.applyDel(w, q); } catch (e) {} });   // (and what was deleted stays deleted)
  let restored = false;
  if (room.snapDyn && room.snapDyn.length && Array.isArray(room.snapDyn.find(q => q)) && room.snapDyn.find(q => q).length >= 4) {   // (saved by name: each thing finds its own entry)
    for (const q of room.snapDyn) { if (!q) continue; const d = w.dynBy.get(q[3] >>> 0); if (!d || d.gone) continue; restored = true; if (q[4]) { d.burn = 1e9; d.x = d.y = -99999; d.vx = d.vy = 0; continue; } if (Number.isFinite(q[0]) && Number.isFinite(q[1])) { d.x = q[0]; d.y = q[1]; d.rot = q[2] || 0; d.vx = d.vy = 0; d.nap = true; d.rest = 0; } }
  } else if (room.snapDyn && room.snapDyn.length === w.dyn.length) { for (let i = 0; i < w.dyn.length; i++) { const q = room.snapDyn[i], d = w.dyn[i]; if (q && !d.gone && Number.isFinite(q[0]) && Number.isFinite(q[1])) { d.x = q[0]; d.y = q[1]; d.rot = q[2] || 0; d.vx = d.vy = 0; d.nap = true; d.rest = 0; } } }
  if (Array.isArray(room.snapSee)) for (const q of room.snapSee) { const e = Array.isArray(q) && w.see.find(o => o.uid === (q[0] >>> 0)); if (e && Number.isFinite(q[1])) e.ang = q[1]; }
  room.seedOk = !room.priv && !restored && !(room.snapDyn && room.snapDyn.length === w.dyn.length); room.seedBy = null; room.worldAt = Date.now();   // (a world the server has no memory of: the first player who remembers it can tell it where everything was)
  room.snapDyn = undefined; room.snapSee = undefined;
  room.world = w; room.verN = 1; room.acc = 0; room.dsig = ''; room.tk = 0;
  w.dyn.forEach(d => { d.ver = 1; d.lx = d.x; d.ly = d.y; d.lr = d.rot; d.lb = false; });
  w.see.forEach(s => { s.lang = s.ang; });
  return w;
}
const worldAdd = {   // somebody built something: it goes into the shared world straight away
  prop: (r, q, replay) => { if (r.world) { const d = P.addProp(r.world, q[0], q[1], q[2]);
    if (replay) { const e = d.r || d.hw; for (let k = 0; k < 12 && r.world.dyn.some(o => o !== d && !(o.burn > 0) && Math.abs(o.x - d.x) < e + (o.r || o.hw) - 2 && Math.abs(o.y - d.y) < e + (o.r || o.hh) - 2); k++) d.y -= e * 2 + 1; }   /* (something built long ago, coming back where it was first put: if that spot is taken, it goes on top instead of inside, so nothing ever bursts apart) */
    d.ver = ++r.verN; (r.chg = r.chg || []).push(d); d.lx = d.x; d.ly = d.y; d.lr = d.rot; d.lb = false; return d; } },
  misc: (r, q) => { if (r.world) srvMisc(r.world, q); },
  gate: (r, q) => { if (r.world) srvGate(r.world, q); },
  del: (r, q) => { if (!r.world) return; const d = q[0] === 'b' ? r.world.dynBy.get(q[1] >>> 0) : null; if (P.applyDel(r.world, q) && d) { d.ver = ++r.verN; (r.chg = r.chg || []).push(d); } }
};
function doorSig(w) {
  let s = ''; for (const o of w.doors) s += (o.open ? 1 : 0) + (o.latched ? 2 : 0); s += '|'; for (const q of w.btns) s += q.on ? 1 : 0; s += '|'; for (const q of w.plates) s += q.on ? 1 : 0; return s;
}
function doorPacket(room) {
  const w = room.world, d = [], b = [], p = [];
  w.doors.forEach(o => { d.push(o.uid, (o.open ? 1 : 0) | (o.latched ? 2 : 0)); });
  w.btns.forEach((q, i) => { if (q.on) b.push(i); });
  w.plates.forEach(q => { if (q.on) p.push(P.hash32('l' + q.x + ',' + q.y)); });
  return { t: 'dr', d, b, p };
}
function plankSend(room, planks, only) {
  if (!planks.length) return;
  const buf = Buffer.allocUnsafe(4 + planks.length * 16); buf[0] = 7; buf.writeUInt16LE(rslot(room) & 0xFFFF, 1); buf[3] = planks.length;   // (type 7: as type 5, plus which player's device is turning it right now)
  planks.forEach((s, k) => { const o = 4 + k * 16; buf.writeUInt32LE(s.uid >>> 0, o); buf.writeFloatLE(s.ang, o + 4); buf.writeFloatLE(Number.isFinite(s.av) ? s.av : 0, o + 8); buf.writeUInt32LE(s.ownT > 0 ? s.ownBy >>> 0 : 0, o + 12); });
  if (only) { if (only.ws.readyState === 1) only.ws.send(buf, { binary: true }); return; }
  for (const p of room.players.values()) if (p.ws.readyState === 1) p.ws.send(buf, { binary: true });
}
let simLast = Date.now();
const ROOM_KEEP_MS = 15 * 60 * 1000;
/* ---------- the public worlds are remembered ----------
   What was built (dirt, gates, props) and where every crate and ball is are written to disk, so a world that empties out, or a server that restarts, comes back exactly as it was
   (until the map changes). */
const WORLD_FILE = process.env.WORLD_FILE || path.join(path.dirname(LINKS_FILE), 'world.json');
const savedWorlds = new Map(); let worldsDirty = false;
try {
  const o = JSON.parse(fs.readFileSync(WORLD_FILE, 'utf8'));
  if (o && o.maps) for (const k in o.maps) { const v = o.maps[k]; if (v && Array.isArray(v.dyn) && /^\d+:\d+$/.test(k)) savedWorlds.set(k, v); }   // (every map keeps what was built on it, for good: it comes back with the map)
  else if (o && Number.isFinite(o.slot)) for (const k in (o.rooms || {})) { const v = o.rooms[k]; if (v && Array.isArray(v.dyn)) savedWorlds.set((o.slot % maps.count) + ':' + k, v); }   // (the older kind of file: one map only)
  console.log('Restored ' + savedWorlds.size + ' worlds from ' + WORLD_FILE);
} catch (e) {}
function snapRoom(r) {
  const w = r.world; if (!w) return r.snapDyn !== undefined ? { build: r.build || null, dyn: r.snapDyn, see: r.snapSee } : r.build ? { build: r.build, dyn: [], see: [] } : null;
  return { build: r.build || null, dyn: w.dyn.map(d => d.burn >= 1e9 ? [0, 0, 0, d.uid >>> 0, 1] : [Math.round(d.x * 10) / 10, Math.round(d.y * 10) / 10, Math.round(d.rot * 1000) / 1000, d.uid >>> 0]), see: w.see.map(q => [q.uid >>> 0, Math.round(q.ang * 1000) / 1000]) };   // (each thing by its name, so nothing can ever be put back in another's place; teeter-totters too)
}
const wkey = id => (curSlot % maps.count) + ':' + id;   // a public world is remembered by its map and its room, never by when it was played
function keepWorlds(sync) {
  for (const [id, r] of rooms) if (!r.priv && (r.world || r.snapDyn !== undefined || r.build)) { savedWorlds.set(wkey(id), snapRoom(r)); worldsDirty = true; }
  if (!worldsDirty) return; worldsDirty = false;
  const o = { maps: {} }; savedWorlds.forEach((v, k) => { o.maps[k] = v; });
  const str = JSON.stringify(o), tmp = WORLD_FILE + '.tmp';
  try { if (sync) { fs.writeFileSync(tmp, str); fs.renameSync(tmp, WORLD_FILE); } else fs.writeFile(tmp, str, er => { if (!er) fs.rename(tmp, WORLD_FILE, () => {}); }); } catch (e) {}
}
setInterval(() => keepWorlds(false), 20000).unref();
setInterval(() => { const t = Date.now(); for (const [id, r] of rooms) if (r.players.size === 0 && (!r.emptyAt || t - r.emptyAt > ROOM_KEEP_MS)) { if (!r.priv) { const sn = snapRoom(r); if (sn) { savedWorlds.set(wkey(id), sn); worldsDirty = true; } } rooms.delete(id); } }, 30000).unref();
function simTick() {
  const now = Date.now(), dtReal = Math.min(0.2, (now - simLast) / 1000); simLast = now;
  for (const room of rooms.values()) {
    const act = [...room.players.values()].filter(p => p.has && !p.dead && !p.hidden && p.ws.readyState === 1);
    if (act.length) room.aloneT = 0; else room.aloneT = (room.aloneT || 0) + dtReal;
    if (!act.length && !(room.world && room.world.nAct > 0 && room.aloneT < 30)) continue;   // (with nobody there, the world still runs until everything that was moving has come to rest, and never more than 30 seconds)
    const w = roomWorld(room), slot = rslot(room) & 0xFFFF;
    room.tk++;
    room.acc += dtReal;
    let n = 0; while (room.acc >= SIMDT && n < 6) { room.acc -= SIMDT; n++; }
    if (room.acc > SIMDT) room.acc = 0;
    for (const p of room.players.values()) if (!act.includes(p)) p.qx = undefined;
    if (n) {
      w.focus = act.map(p => ({ x: p.x, y: p.y }));
      { const fo = w.focus; w.cand = w.dyn.filter(d => { if (d.burn > 0) return false; for (let i = 0; i < fo.length; i++) if (Math.abs(d.x - fo[i].x) < 420 && Math.abs(d.y - fo[i].y) < 420) return true; return false; }); }
      for (let k = 0; k < n; k++) {
        P.stepDyn(w, SIMDT);
        const list = [];
        for (const p of act) {   // each player is a point that moves smoothly along their path (never jumping through a crate between two updates)
          const age = Math.min(0.12, (now - (p.tPos || now)) / 1000 + k * SIMDT), g = !!(p.st & 0x8000);
          const tx = p.x + p.vx * age, ty = p.y + Math.min(0, p.vy) * age;   // (sideways it carries on along its path, and up when it is jumping; a fall is not carried on, so it is never sunk into the crate it is landing on)
          if (p.qx === undefined || Math.abs(tx - p.qx) > 220 || Math.abs(ty - p.qy) > 220) { p.qx = tx; p.qy = ty; }
          else {
            const lx = Math.max(7, Math.abs(p.vx) * SIMDT * 2), ly = Math.max(10, Math.abs(p.vy) * SIMDT * 2);
            p.qx += Math.max(-lx, Math.min(lx, tx - p.qx)); p.qy += Math.max(-ly, Math.min(ly, ty - p.qy));
          }
          list.push({ x: p.qx, y: p.qy, vx: p.vx, vy: p.vy, ground: g, id: p.id, p });
        }
        for (const q of list) { const c = { x: q.x, y: q.y, vx: q.vx, vy: q.vy, ground: q.ground, kin: true, dt: SIMDT, own: q.id }; P.collideDyn(c, w); P.seeBody(c, w, P.PLAYER_WT); if (q.p) { q.p.qx = c.x; q.p.qy = c.y; } }   // (kin: a player is where they say they are; only the things they touch are moved)
        if (k === n - 1) P.stepSwitches(w, list, SIMDT * n);   // (the buttons and plates are looked at once per update)
      }
      w.ev.length = 0;
    }
    // what changed, for the dyn things
    const stepped = act.length > 0 && n > 0, tickDt = Math.max(1, n) * SIMDT;   // (only after the world really moved on: a tick with no step in it must not report everything as standing still)
    const chg = room.chg = room.chg || []; if (chg.length > 1500) { room.fullAll = true; chg.length = 0; }
    for (let i = 0; stepped && i < w.dyn.length; i++) {
      const d = w.dyn[i];
      if (d.sleep) {   // (a thing that went to sleep in the middle of a move is still told to everybody once, where it stopped)
        if (!(d.burn > 0) && (Math.abs(d.x - d.lx) + Math.abs(d.y - d.ly) + Math.abs(d.rot - d.lr) > 0.04 || !d.lst)) { d.ver = ++room.verN; chg.push(d); d.lx = d.x; d.ly = d.y; d.lr = d.rot; d.lb = false; if (d.ownT > 0) { d.lst = false; d.lvx = d.svx = d.vx; d.lvy = d.svy = d.vy; } else { d.lst = true; d.lvx = d.lvy = d.svx = d.svy = 0; } d.px = undefined; }
        continue;
      }
      const bn = d.burn > 0;
      const kx = d.px === undefined ? d.vx : (d.x - d.px) / tickDt, ky = d.px === undefined ? d.vy : (d.y - d.py) / tickDt;
      const dm = d.px === undefined ? 99 : Math.abs(d.x - d.px) + Math.abs(d.y - d.py); d.px = d.x; d.py = d.y;
      d.svx = Math.abs(d.vx) > 150 && Math.abs(kx) < Math.abs(d.vx) * 0.2 ? kx : d.vx;   // (a pile held up by what is under it keeps 'falling' in its own sums while not moving at all: what it really did is sent instead)
      d.svy = Math.abs(d.vy) > 150 && Math.abs(ky) < Math.abs(d.vy) * 0.2 ? ky : d.vy;
      const still = !bn && ((Math.abs(d.svx) < 25 && Math.abs(d.svy) < 25) || dm < 0.5) && Math.abs(d.av || 0) < 0.3;
      const mv = !bn && (Math.abs(d.x - d.lx) + Math.abs(d.y - d.ly) + Math.abs(d.rot - d.lr) > 0.04 || still !== d.lst || (!still && Math.abs(d.svx - d.lvx) + Math.abs(d.svy - d.lvy) > 60));
      if (bn !== d.lb || mv) { d.ver = ++room.verN; chg.push(d); d.lx = d.x; d.ly = d.y; d.lr = d.rot; d.lb = bn; d.lst = still; d.lvx = d.svx; d.lvy = d.svy; }
    }
    // gates and triggers: tell everybody when any of them changes (and now and then anyway)
    const sig = doorSig(w);
    if (sig !== room.dsig || room.tk % 150 === 0) { room.dsig = sig; broadcast(room, doorPacket(room)); }
    // planks
    const planks = []; for (const s of w.see) if (Math.abs(s.ang - s.lang) > 0.0004 || room.tk % 150 === 0) { planks.push(s); s.lang = s.ang; }
    if (planks.length) plankSend(room, planks);
    // crates and balls: each player is told about what changed near them
    const resend = room.tk % 150 === 0;
    for (const p of room.players.values()) {
      if (!p.has || p.ws.readyState !== 1) continue;
      if (!p.dver || resend) { p.dver = new Map(); p.more = 1; }
      const full = p.more || room.fullAll || Math.abs(p.x - p.sx) >= 200 || Math.abs(p.y - p.sy) >= 200;
      if (!full && !chg.length) continue;   // nothing new, and they have not moved far
      const out = [];
      if (full) {   // (a full look: first time, every few seconds, after moving far, or when more than fit last time)
        p.sv = room.verN; p.sx = p.x; p.sy = p.y; p.more = 0;
        for (let pass = 0; pass < 2 && out.length < 90; pass++) {   // (what is closest to them first, so the world right around them is there at once)
          const rx = pass ? 1900 : 800, ry = pass ? 1500 : 600;
          for (let i = 0; i < w.dyn.length && out.length < 90; i++) {
            const d = w.dyn[i];
            if (p.dver.get(d.uid) === d.ver) continue;
            const bn = d.burn > 0, x = bn ? d.hx : d.x, y = bn ? d.hy : d.y;   // (something lost is told about where it used to be)
            if (Math.abs(x - p.x) > rx || Math.abs(y - p.y) > ry) continue;
            out.push(d); p.dver.set(d.uid, d.ver);
          }
        }
      } else {   // (otherwise only what changed in this very tick is looked at)
        for (let i = 0; i < chg.length && out.length < 90; i++) {
          const d = chg[i];
          if (p.dver.get(d.uid) === d.ver) continue;
          if (!(d.burn > 0) && (Math.abs(d.x - p.x) > 1900 || Math.abs(d.y - p.y) > 1500)) continue;
          out.push(d);
        }
      }
      if (out.length >= 90) p.more = 1;
      if (!out.length) continue;
      const buf = Buffer.allocUnsafe(4 + out.length * 23); buf[0] = 6; buf.writeUInt16LE(slot, 1); buf[3] = out.length;   // (type 6: as type 4, plus how fast each one is turning)
      out.forEach((d, k) => {
        const o = 4 + k * 23, bn = d.burn > 0;
        buf.writeUInt32LE(d.uid >>> 0, o); buf.writeFloatLE(bn ? 0 : d.x, o + 4); buf.writeFloatLE(bn ? 0 : d.y, o + 8);
        const rest = bn || d.lst; buf.writeInt16LE(Math.max(-32000, Math.min(32000, Math.round(rest ? 0 : d.svx))), o + 12); buf.writeInt16LE(Math.max(-32000, Math.min(32000, Math.round(rest ? 0 : d.svy))), o + 14);
        buf.writeFloatLE(d.rot || 0, o + 16); buf[o + 20] = (bn ? 1 : 0) | (!bn && d.ownT > 0 && d.ownBy !== p.id ? 2 : 0);   /* (2: another player's device is moving this one right now) */ buf.writeInt16LE(Math.max(-32000, Math.min(32000, Math.round((bn || d.lst ? 0 : d.av || 0) * 1000))), o + 21);
        p.dver.set(d.uid, d.ver);
      });
      p.ws.send(buf, { binary: true });
    }
    chg.length = 0; room.fullAll = false;
  }
}

const okProp = q => (Array.isArray(q) && q.length === 3 && (q[0] | 0) >= 0 && (q[0] | 0) <= 7 && Number.isFinite(q[1]) && Number.isFinite(q[2]) ? [q[0] | 0, Math.round(q[1]), Math.round(q[2])] : null);
const okGate = q => (Array.isArray(q) && q.length === 5 && q.every(Number.isFinite) && q[2] >= 2 && q[2] <= 8 ? q.map(Math.round) : null);
const okMisc = q => (Array.isArray(q) && q.length === 4 && (q[0] === 'bnc' || q[0] === 'spr' || q[0] === 'lav' || q[0] === 'tl') && q.slice(1).every(Number.isFinite) ? [q[0], Math.round(q[1]), Math.round(q[2]), Math.round(q[3])] : Array.isArray(q) && q.length === 4 && (q[0] === 'see' || q[0] === 'pad') && q.slice(1).every(Number.isFinite) ? [q[0], Math.round(q[1]), Math.round(q[2]), q[3] < 0 ? -1 : q[3] > 0 ? 1 : 0] : (Array.isArray(q) && q.length === 5 && q[0] === 'por' && q.slice(1).every(Number.isFinite) ? ['por', Math.round(q[1]), Math.round(q[2]), Math.round(q[3]), Math.round(q[4])] : null));
const okDel = q => (Array.isArray(q) && (((q[0] === 'b' || q[0] === 's' || q[0] === 'g') && q.length === 2 && Number.isFinite(q[1]) && q[1] >= 0 && q[1] < 4294967296) || ((q[0] === 'pad' || q[0] === 'por' || q[0] === 'c') && q.length === 3 && Number.isFinite(q[1]) && Number.isFinite(q[2]))) ? (q.length === 2 ? [q[0], Math.round(q[1])] : [q[0], Math.round(q[1]), Math.round(q[2])]) : null);   // something removed with the delete tool
const okCp = q => (Array.isArray(q) && q.length === 2 && Number.isFinite(q[0]) && Number.isFinite(q[1]) ? [Math.round(q[0]), Math.round(q[1])] : null);
function send(p, obj) { if (p.ws.readyState === 1) p.ws.send(JSON.stringify(obj)); }
function broadcast(room, obj, except) {
  const s = JSON.stringify(obj);
  for (const p of room.players.values()) if (p !== except && p.ws.readyState === 1) p.ws.send(s);
}
function addOk(p) {   // building is rate-limited as a bucket (a burst of placements is fine, a flood is not): dropping one would leave this world and the builder's out of step
  const now = Date.now(); p.tok = Math.min(60, (p.tok === undefined ? 60 : p.tok) + (now - (p.tokT || now)) / 1000 * 25); p.tokT = now;   // (far more than anybody can build by hand: only a flood is ever turned away)
  if (p.tok < 1) return false; p.tok -= 1; return true;
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
    if (room.players.size === 0) { if (room.priv) rooms.delete(room.id); else room.emptyAt = Date.now(); }   // (a public world is kept for a while after the last player leaves, so a dropped connection or a closed tab does not rebuild everything you knocked down)
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
  try { ws._socket.setNoDelay(true); } catch (e) {}
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  const rate = setInterval(() => { p.msgs = 0; }, 1000);

  ws.on('message', (raw, isBinary) => {
    p.lastMsg = Date.now();
    if (++p.msgs > 100) return;                       // simple flood protection
    if (isBinary) {                                   // a position update: [0x70][slot u16][x/2 u16][y u16 (65535 = dead)][vx/5 i8][vy/20 i8][time u15 | grounded<<15]
      if (!p.room || raw.length !== 11 || raw[0] !== 0x70 || raw.readUInt16LE(1) !== (rslot(p.room) & 0xFFFF)) return;
      const x = Math.min(262000, raw.readUInt16LE(3) * 2), yr = raw.readUInt16LE(5), d = yr === 65535 ? 1 : 0;
      const y = d ? p.y : Math.min(131000, yr), vx = raw.readInt8(7) * 5, vy = raw.readInt8(8) * 20, st = raw.readUInt16LE(9);
      if (p.x !== x || p.y !== y || p.dead !== d || p.vx !== vx || p.vy !== vy || p.st !== st || !p.has) p.moved = true;
      p.x = x; p.y = y; p.dead = d; p.vx = d ? 0 : vx; p.vy = d ? 0 : vy; p.st = st; p.has = true; p.tPos = Date.now();
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
        const props = [], gates = [], misc = [], cps = [], dels = [];   // (what the host built arrives right after, in small pieces)
        room = { id: key, players: new Map(), finishers: [], priv: { at: Date.now(), owner: p.id, hostPub: p.pub, slot: PRIV_BASE + Math.max(0, Math.min(maps.count - 1, lv)), idx: Math.max(0, Math.min(maps.count - 1, lv)), props, cps, gates, misc, dels, invited: new Set(), keep: new Set(), once: new Set() } };
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
          t: 'welcome', id: p.id, room: room.id, n: room.players.size, max: MAX_PLAYERS, full: fr.full, fresh: roomFresh(room) ? 1 : 0,
          name: p.name, code: p.pub ? codeOf(p.pub) : '', nameLeft, slot: rslot(room), next: room.priv ? Date.now() + 3e11 : nextAt(curSlot), now: Date.now(), online, peak,
          build: room.priv ? undefined : bstate(room), priv: room.priv ? { host: room.priv.owner === p.id ? 1 : 0, idx: room.priv.idx, props: room.priv.props, cps: room.priv.cps, gates: room.priv.gates, misc: room.priv.misc, dels: room.priv.dels, hostName: (byPub.get(room.priv.hostPub) || {}).name || '', hostPub: room.priv.hostPub } : undefined,
          players: [...room.players.values()].filter(o => o !== p).map(o => ({ id: o.id, pub: o.pub, code: o.pub ? codeOf(o.pub) : '', name: o.name, color: o.color, color2: o.color2, pat: o.pat, crown: o.fin === rslot(room) ? 1 : 0 }))
        });
        p.dver = null; if (room.world) { send(p, doorPacket(room)); plankSend(room, room.world.see, p); }
        broadcast(room, { t: 'join', id: p.id, pub: p.pub, code: p.pub ? codeOf(p.pub) : '', name: p.name, color: p.color, color2: p.color2, pat: p.pat, n: room.players.size }, p);
      } else {
        send(p, { t: 'welcome', lobby: 1, id: p.id, name: p.name, code: p.pub ? codeOf(p.pub) : '', nameLeft, slot: curSlot, next: nextAt(curSlot), now: Date.now(), online, peak });
      }
      if (p.pub) {
        { const old = byPub.get(p.pub); if (old && old !== p && Date.now() - (old.lastMsg || 0) > 5000) { try { old.ws.terminate(); } catch (e) {} } }   // (the same player's old connection that went quiet, from a phone that slept or a network that changed: it goes at once, so no frozen copy of them stands about in the world)
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
        for (const b of linkSet(p.pub)) { const q = byPub.get(b); if (live(q)) { sendLinks(q); if (!wasOn) send(q, { t: 'lon', pub: p.pub, name: p.name }); } if (!wasOn && p.name) pushTo(b, 'f', [p.name + ' is online', 'Jump in and play together'], 'on-' + p.pub, p.pub); }
        { const nl = news.get(p.pub); if (nl && nl.length) send(p, { t: 'tres', list: nl.map(x => { const pi = peerInfo(x.p); return { pub: x.p, code: pi.code, name: pi.name, ok: x.ok, t: x.t }; }) }); }   // answers to your requests that came while you were away
        { const out = []; pend.forEach((v, k) => { if (k.slice(0, 16) === p.pub) { const to = k.slice(17), pi = peerInfo(to); out.push({ pub: to, code: pi.code, name: pi.name, t: v.t }); } }); send(p, { t: 'tout', list: out }); }   // requests you sent that nobody has answered yet
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
      p.x = x; p.y = y; p.dead = d; p.vx = 0; p.vy = 0; p.st = 0x8000; p.has = true; p.tPos = Date.now();
    } else if (m.t === 'emo') {
      if (!p.room) return;
      const i = m.i | 0, now = Date.now();
      if (i < 0 || i >= EMOJIS || now - p.lastEmo < 900) return;
      p.lastEmo = now;
      broadcast(p.room, { t: 'emo', id: p.id, pub: p.pub, name: p.name, i }, p);
    } else if (m.t === 'say') {   // a message built from a sentence and a pick-list: two small numbers, so nothing can be typed
      if (!p.room) return;
      const a = m.a | 0, b = m.b | 0, now = Date.now();
      if (a < 0 || a >= 16 || b < 0 || b >= 40 || now - p.lastEmo < 900) return;
      p.lastEmo = now;
      broadcast(p.room, { t: 'say', id: p.id, pub: p.pub, name: p.name, a, b }, p);
    } else if (m.t === 'inv') {   // the host asks a friend to come to their world
      const r = p.room; if (!r || !r.priv || r.priv.owner !== p.id || typeof m.to !== 'string' || !PUB.test(m.to) || !linkSet(p.pub).has(m.to)) return;
      const now = Date.now(); if (now - (p.lastInv || 0) < 700) return; p.lastInv = now;
      r.priv.invited.add(m.to);
      const q = byPub.get(m.to), keep = m.keep !== false;   // 'keep open' (the default): they are asked again every time they come back, for as long as the game is open
      if (keep) { r.priv.keep.add(m.to); r.priv.once.delete(m.to); } else { r.priv.keep.delete(m.to); if (!live(q)) r.priv.once.add(m.to); }
      if (live(q)) send(q, { t: 'inv', pub: p.pub, name: p.name, idx: r.priv.idx }); pushTo(m.to, 'i', [(p.name || 'A friend') + ' invited you', 'Join their private game'], 'inv-' + p.pub);
      send(p, { t: 'invsent', pub: m.to, on: live(q) ? 1 : 0 });
    } else if (m.t === 'pb') {   // a bunch of builds at once (up to 25 of one kind): what somebody had built before joining this world
      const r = p.room; if (!r || !bstate(r)) return;
      const now = Date.now(); if (now - (p.lastPb || 0) < 180) return; p.lastPb = now;
      const B = bstate(r), e = {};
      const take = (key, arr, ok, cap) => { if (!Array.isArray(m[key])) return; const out = []; for (const q of m[key].slice(0, 25)) { const c = ok(q); if (c && arr.length < cap) { arr.push(c); out.push(c); } } if (out.length) e[key] = out; };
      take('props', B.props, okProp, ROOM_PROPS); take('gates', B.gates, okGate, ROOM_GATES); take('misc', B.misc, okMisc, ROOM_MISC); take('cps', B.cps, okCp, ROOM_CPS); take('dels', B.dels, okDel, ROOM_DELS);
      (e.props || []).forEach(q => worldAdd.prop(r, q, true)); (e.gates || []).forEach(q => worldAdd.gate(r, q)); (e.misc || []).forEach(q => worldAdd.misc(r, q)); (e.dels || []).forEach(q => worldAdd.del(r, q));
      if (Object.keys(e).length) { e.t = 'pb'; broadcast(r, e, p); }
    } else if (m.t === 'pobj') {   // a teeter-totter or a floor booster, built in a friend's world
      const r = p.room; if (!bstate(p.room) || !Array.isArray(m.g) || !((m.g.length === 4 && (m.g[0] === 'see' || m.g[0] === 'pad' || m.g[0] === 'bnc' || m.g[0] === 'spr' || m.g[0] === 'lav' || m.g[0] === 'tl')) || (m.g.length === 5 && m.g[0] === 'por')) || !m.g.slice(1).every(Number.isFinite) || bstate(r).misc.length >= ROOM_MISC || ((m.g[0] === 'see' || m.g[0] === 'por') && bstate(r).misc.filter(q => q[0] === m.g[0]).length >= 80)) return;
      if (!addOk(p)) return;
      if (m.g[0] === 'tl') {   // one record per tile: a newer change replaces the older one, and -1 means the tile is back the way the map made it, so there is nothing to keep
        const put = (tx, ty, to) => {
          const mb = bstate(r).misc;
          for (let k = mb.length - 1; k >= 0; k--) if (mb[k][0] === 'tl' && mb[k][1] === tx && mb[k][2] === ty) mb.splice(k, 1);
          if (to === -1) { worldAdd.misc(r, ['tl', tx, ty, -1]); return [tx, ty, -1]; }
          if (![0, 1, 2, 3, 5, 7].includes(to) || mb.length >= ROOM_MISC) return null;
          const e = ['tl', tx, ty, to]; mb.push(e); worldAdd.misc(r, e); return [tx, ty, to];
        };
        const g0 = put(Math.round(m.g[1]), Math.round(m.g[2]), Math.round(m.g[3])), ex = [];
        if (Array.isArray(m.ex)) for (const q of m.ex.slice(0, 6)) if (Array.isArray(q) && q.length === 3 && q.every(Number.isFinite)) { const c = put(Math.round(q[0]), Math.round(q[1]), Math.round(q[2])); if (c) ex.push(c); }
        if (g0) broadcast(r, { t: 'pobj', g: ['tl', g0[0], g0[1], g0[2]], ex }, p);
        return;
      }
      const e = (m.g[0] === 'bnc' || m.g[0] === 'spr' || m.g[0] === 'lav' || m.g[0] === 'tl') ? [m.g[0], Math.round(m.g[1]), Math.round(m.g[2]), Math.round(m.g[3])] : m.g[0] === 'por' ? ['por', Math.round(m.g[1]), Math.round(m.g[2]), Math.round(m.g[3]), Math.round(m.g[4])] : [m.g[0], Math.round(m.g[1]), Math.round(m.g[2]), m.g[3] < 0 ? -1 : m.g[3] > 0 ? 1 : 0]; bstate(r).misc.push(e); worldAdd.misc(r, e); broadcast(r, { t: 'pobj', g: e }, p);
    } else if (m.t === 'own') {   // a player's device says where the things it is pushing are: the server takes its word, unless somebody else is right there too
      const r = p.room; if (!r || !r.world || m.s !== rslot(r)) return;
      const w = r.world;   // (the first device to take something has it until it lets go; everyone else sees it as theirs)
      if (Array.isArray(m.pl)) for (const q of m.pl.slice(0, 4)) {   // a teeter-totter this player is on: their device turns it, and the server follows
        if (!Array.isArray(q) || q.length !== 3 || !q.every(Number.isFinite)) continue;
        const s = w.see.find(e => e.uid === (q[0] >>> 0) && !e.gone); if (!s || (s.ownT > 0 && s.ownBy !== p.id) || Math.abs(s.cx - p.x) > s.hl + 400 || Math.abs(s.cy - p.y) > s.hl + 400) continue;
        s.ang = Math.max(-0.36, Math.min(0.36, q[1])); s.av = Math.max(-12, Math.min(12, q[2])); s.ownT = 0.25; s.ownBy = p.id; s.moving = 0.5;
      }
      if (!Array.isArray(m.b)) return;
      for (const q of m.b.slice(0, 12)) {
        if (!Array.isArray(q) || q.length !== 7 || !q.every(Number.isFinite)) continue;
        const d = w.dynBy.get(q[0] >>> 0); if (!d || d.gone || d.burn > 0) continue;
        if (Math.abs(q[1] - d.x) + Math.abs(q[2] - d.y) > 400 || q[1] < 0 || q[1] > w.W * P.TS || q[2] < 0 || q[2] > w.H * P.TS) continue;
        if (d.ownT > 0 && d.ownBy !== p.id) continue;
        if (w.see.length && P.plankCross(w, d.x, d.y, q[1], q[2], d.r || Math.max(d.hw, d.hh))) continue;   // (never taken through a teeter-totter: the two devices must have seen the plank differently, and the server's side of it stands)
        d.x = q[1]; d.y = q[2]; d.vx = Math.max(-1400, Math.min(1400, q[3])); d.vy = Math.max(-1400, Math.min(1400, q[4])); d.rot = q[5]; d.av = Math.max(-28, Math.min(28, q[6])); d.ownBy = p.id; d.ownT = 0.25; d.nap = false; d.st = 0;
      }
    } else if (m.t === 'pseed') {   // the host of a private world says where everything is in it: their device is that world's memory
      const r = p.room; if (!r || !r.priv || r.priv.owner !== p.id || Date.now() - (r.priv.at || 0) > 90000 || !Array.isArray(m.d)) return;
      const rows = m.d.slice(0, 500).filter(q => Array.isArray(q) && q.length >= 4 && q.slice(0, 4).every(Number.isFinite));
      const w = roomWorld(r);
      for (const q of rows) { const d = w.dynBy.get(q[0] >>> 0); if (!d || d.gone) continue; if (q[4]) { d.burn = 1e9; d.x = d.y = -99999; } else { d.x = q[1]; d.y = q[2]; d.rot = q[3]; d.burn = 0; } d.vx = d.vy = 0; d.av = 0; d.nap = true; d.rest = 0; d.ver = ++r.verN; }
      if (Array.isArray(m.s)) for (const q of m.s.slice(0, 200)) { if (!Array.isArray(q) || q.length !== 2 || !q.every(Number.isFinite)) continue; const e = w.see.find(o => o.uid === (q[0] >>> 0)); if (e) { e.ang = Math.max(-0.36, Math.min(0.36, q[1])); e.av = 0; } }
      for (const q of r.players.values()) q.dver = null;   // (everyone is told where it all is again)
    } else if (m.t === 'wseed') {   // the server forgot this world (a restart with nothing saved): a player who was here brings back its memory, in parts
      const r = p.room; if (!r || r.priv || typeof m.k !== 'string' || m.k !== wkey(r.id) || !Number.isFinite(m.n) || !Number.isFinite(m.i) || m.n < 1 || m.n > 40 || typeof m.c !== 'string') return;
      if (!roomFresh(r) || (r.seedBy && r.seedBy !== p.id)) return;
      r.seedBy = p.id; if (!r.seedParts || r.seedParts.n !== m.n) r.seedParts = { n: m.n, a: [] };
      r.seedParts.a[m.i | 0] = m.c;
      if (r.seedParts.a.filter(x => typeof x === 'string').length < m.n) return;
      let o = null; try { o = JSON.parse(r.seedParts.a.join('')); } catch (e) {} r.seedParts = null;
      if (!o || typeof o !== 'object' || !o.b || !o.w) { r.seedBy = null; return; }
      const B = { props: [], cps: [], gates: [], misc: [], dels: [] }, okAny = q => okMisc(q) || (Array.isArray(q) && ((q.length === 4 && (q[0] === 'see' || q[0] === 'pad')) || (q.length === 5 && q[0] === 'por')) && q.slice(1).every(Number.isFinite) ? [q[0], ...q.slice(1).map(Math.round)] : null);
      const take = (key, ok, cap) => { for (const q of (Array.isArray(o.b[key]) ? o.b[key] : []).slice(0, cap)) { const c = ok(q); if (c) B[key].push(c); } };
      take('props', okProp, ROOM_PROPS); take('gates', okGate, ROOM_GATES); take('misc', okAny, ROOM_MISC); take('cps', okCp, ROOM_CPS); take('dels', okDel, ROOM_DELS);
      const dyn = (Array.isArray(o.w.d) ? o.w.d : []).filter(q => Array.isArray(q) && q.length >= 4 && q.slice(0, 4).every(Number.isFinite)).map(q => [q[1], q[2], q[3], q[0] >>> 0, q[4] ? 1 : 0]);
      const see = (Array.isArray(o.w.s) ? o.w.s : []).filter(q => Array.isArray(q) && q.length === 2 && q.every(Number.isFinite));
      r.build = B; r.world = null; r.snapDyn = dyn; r.snapSee = see; r.seeded = true; worldsDirty = true;
      console.log('World ' + wkey(r.id) + ' brought back by ' + p.name + ': ' + B.props.length + ' things, ' + B.misc.length + ' tiles and gadgets, ' + dyn.length + ' moved');
      for (const q of r.players.values()) { q.dver = null; q.sbh = q.sdh = null; send(q, { t: 'rebuild', b: B }); }   // (everyone here loads the world again, now as it really was)
      keepWorlds(false);
    } else if (m.t === 'dseed') {   // this server forgot the world (it was restarted with nothing saved): a player who was here tells it where things had ended up, so a knocked-down tower stays knocked down
      const r = p.room; if (!r || !r.world || !r.seedOk || Date.now() - r.worldAt > 40000 || !Array.isArray(m.d) || m.s !== rslot(r)) return;
      if (r.seedBy && r.seedBy !== p.id) return; r.seedBy = p.id;
      const w = r.world;
      for (const q of m.d.slice(0, 40)) {
        if (!Array.isArray(q) || !Number.isFinite(q[0])) continue; const d = w.dynBy.get(q[0] >>> 0); if (!d || d.gone) continue;
        if (q[1] === -1) { d.burn = 1e9; d.x = d.y = -99999; d.vx = d.vy = 0; }
        else if (q.length === 4 && q.slice(1).every(Number.isFinite) && q[1] > 0 && q[1] < w.W * P.TS && q[2] > 0 && q[2] < w.H * P.TS) { d.x = q[1]; d.y = q[2]; d.rot = q[3]; d.vx = d.vy = 0; d.av = 0; d.nap = false; d.st = 0; d.burn = 0; }
        else continue;
        d.ver = ++r.verN; (r.chg = r.chg || []).push(d); worldsDirty = true;
      }
    } else if (m.t === 'pdel') {   // somebody deleted something: it is gone for everyone in that world
      const r = p.room, B = bstate(r); if (!B) return;
      const q = okDel(m.g); if (!q || B.dels.length >= ROOM_DELS || !addOk(p)) return;
      if (B.dels.some(e => e.length === q.length && e.every((v, i) => v === q[i]))) return;
      B.dels.push(q); worldAdd.del(r, q); broadcast(r, { t: 'pdel', g: q }, p);
    } else if (m.t === 'pgate') {   // a gate and its trigger, built in a friend's world
      const r = p.room; if (!bstate(p.room) || !Array.isArray(m.g) || m.g.length !== 5 || !m.g.every(Number.isFinite) || m.g[2] < 2 || m.g[2] > 8 || bstate(r).gates.length >= ROOM_GATES) return;
      if (!addOk(p)) return;
      const e = m.g.map(Math.round); bstate(r).gates.push(e); worldAdd.gate(r, e); broadcast(r, { t: 'pgate', g: e }, p);
    } else if (m.t === 'padd' || m.t === 'pcp') {   // somebody built something in a friend's world: everyone there gets it
      const r = p.room; if (!bstate(p.room)) return;
      if (!addOk(p)) return;
      if (m.t === 'padd') {
        const k = m.k | 0; if (k < 0 || k > 7 || !Number.isFinite(m.x) || !Number.isFinite(m.y) || bstate(r).props.length >= ROOM_PROPS) return;
        const e = [k, Math.round(m.x), Math.round(m.y)]; bstate(r).props.push(e); const nd = worldAdd.prop(r, e), nu = nd ? nd.uid : undefined; broadcast(r, { t: 'padd', k: e[0], x: e[1], y: e[2], u: nu }, p); if (nu !== undefined) send(p, { t: 'puid', k: e[0], x: e[1], y: e[2], u: nu });   // (the server's name for it goes to everyone, so two things put down on the very same spot can never be mixed up)
      } else {
        if (!Number.isFinite(m.x) || !Number.isFinite(m.y) || bstate(r).cps.length >= ROOM_CPS) return;
        const e = [Math.round(m.x), Math.round(m.y)]; bstate(r).cps.push(e); broadcast(r, { t: 'pcp', x: e[0], y: e[1] }, p);
      }
    } else if (m.t === 'find') {
      const now = Date.now(); if (now - p.lastFind < 250) return; p.lastFind = now;
      const raw = String(m.q == null ? '' : m.q).trim().slice(0, 12), q = raw.toLowerCase(), qc = raw.toUpperCase().replace(/^#/, ''), mine = links.get(p.pub), out = [];
      const browse = !raw;   // nothing typed: everybody who has played (online first, then the most recent). Typing searches by name or friend number.
      known.forEach((k, pub) => {
        if (pub === p.pub) return;
        const code = codeOf(pub), q2 = byPub.get(pub), on = live(q2) ? (q2.room || true) : null, nm = q2 ? q2.name : k.name, last = on ? now : k.last;
        if (!nm) return;   // has never picked a name, so has never really played
        const linked = !!(mine && mine.has(pub));
        if (!browse && !(nm.toLowerCase().indexOf(q) >= 0 || code === qc || code.indexOf(qc) === 0 && qc.length >= 3)) return;
        out.push({ pub, code, name: nm, color: q2 ? q2.color : k.color, color2: q2 ? q2.color2 : (k.color2 || '#ffffff'), pat: q2 ? q2.pat | 0 : (k.pat | 0), b: k.beat | 0, on: on ? 1 : 0, w: on && on !== true ? on.id : 0, last, here: on && on !== true && on === p.room ? 1 : 0, l: linked ? 1 : 0 });
      });
      out.sort((a, b) => (b.here - a.here) || (b.on - a.on) || (b.last - a.last));
      send(p, { t: 'found', q: raw, list: out.slice(0, browse ? 120 : 40), n: out.length });
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
        const back = m.to + '>' + p.pub;
        if (pend.has(back)) {   // they had already asked you: that is a yes from both sides
          pend.delete(back); addLink(p.pub, m.to);
          const gp = gone.get(p.pub), gq = gone.get(m.to); if (gp) gp.delete(m.to); if (gq) gq.delete(p.pub);
          send(p, { t: 'tok', pub: m.to }); sendLinks(p);
          if (live(q)) { send(q, { t: 'tres', list: [{ pub: p.pub, code: codeOf(p.pub), name: p.name, ok: 1, t: now }] }); sendLinks(q); }
          else { let l = news.get(m.to); if (!l) news.set(m.to, l = []); l.push({ p: p.pub, ok: 1, t: now }); if (l.length > 30) l.shift(); }
          return;
        }
        pend.set(p.pub + '>' + m.to, { t: now }); linksDirty = true;
        if (live(q)) send(q, { t: 'treq', pub: p.pub, code: codeOf(p.pub), name: p.name, color: p.color, color2: p.color2, pat: p.pat | 0 });
        send(p, { t: 'tsent', pub: m.to, name: tn, off: live(q) ? 0 : 1 });
        pushTo(m.to, 'r', [(p.name || 'Someone') + ' wants to be your friend', 'Open ballpit.party to answer'], 'req-' + p.pub);
      } else {
        const k = m.to + '>' + p.pub, pr = pend.get(k);
        if (!pr || Date.now() - pr.t > REQ_TTL) { pend.delete(k); return send(p, { t: 'tno', pub: m.to, why: 'old' }); }
        pend.delete(k); linksDirty = true;
        const tell = ok => { if (live(q)) send(q, { t: 'tres', list: [{ pub: p.pub, code: codeOf(p.pub), name: p.name, ok, t: Date.now() }] }); else { let l = news.get(m.to); if (!l) news.set(m.to, l = []); l.push({ p: p.pub, ok, t: Date.now() }); if (l.length > 30) l.shift(); linksDirty = true; } pushTo(m.to, 'r', [(p.name || 'Someone') + (ok ? ' accepted your friend request' : ' said not now to your friend request'), ok ? 'You are friends now' : 'Open ballpit.party to see'], 'ans-' + p.pub); };   // the one who asked sees the answer now, or the next time they are on
        if (m.t === 'tden') { tell(0); return; }
        if (linkSet(p.pub).size >= MAX_LINKS || linkSet(m.to).size >= MAX_LINKS) return send(p, { t: 'tno', pub: m.to, why: 'full' });
        addLink(p.pub, m.to);
        const gp = gone.get(p.pub), gq = gone.get(m.to); if (gp) gp.delete(m.to); if (gq) gq.delete(p.pub);
        send(p, { t: 'tok', pub: m.to }); sendLinks(p);
        tell(1); if (live(q)) sendLinks(q);
      }
    } else if (m.t === 'psub') {   // this device wants notifications: where to reach it, and which kinds
      if (!p.pub || !m.sub || typeof m.sub !== 'object' || !m.sub.keys || typeof m.sub.endpoint !== 'string' || !okPushUrl(m.sub.endpoint)) return;
      const k1 = unb64u(m.sub.keys.p256dh || ''), k2 = unb64u(m.sub.keys.auth || ''); if (k1.length !== 65 || k1[0] !== 4 || k2.length !== 16) return;
      if (!pushSubs.has(p.pub) && pushSubs.size >= 8000) return;
      const pr = m.prefs && typeof m.prefs === 'object' ? m.prefs : {};
      pushSubs.set(p.pub, { ep: m.sub.endpoint, p: b64u(k1), a: b64u(k2), f: pr.f ? 1 : 0, r: pr.r ? 1 : 0, i: pr.i ? 1 : 0, m: pr.m ? 1 : 0, mu: Array.isArray(pr.mu) ? pr.mu.filter(x => typeof x === 'string' && PUB.test(x)).slice(0, 12) : [], t: Date.now() }); linksDirty = true;
    } else if (m.t === 'vis') {   // this page is in the background (or back): while it is, the server sends notifications as pushes
      p.hidden = m.h ? 1 : 0;
    } else if (m.t === 'punsub') {
      if (p.pub && pushSubs.delete(p.pub)) linksDirty = true;
    } else if (m.t === 'rack') {   // your device has shown you the answers it was sent
      if (p.pub && news.delete(p.pub)) linksDirty = true;
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
  if (tickN % 60 === 0) {
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
    const arr = []; let fresh = tickN % 30 === 0; for (const b of ls) { const q = byPub.get(b); if (q && q.room && q.has && rslot(q.room) === rslot(r.room)) { arr.push(q); if (q.moved) fresh = true; } }
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
setInterval(() => { try { simTick(); } catch (e) { console.log('sim error', e && e.stack); } }, TICK_MS);

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
  keepWorlds(false);   // (the map that is ending is kept just as it is, for when it comes round again)
  curSlot = s;
  console.log('New session / map:', maps.names[curSlot % maps.count]);
  worldsDirty = true;
  for (const room of rooms.values()) {
    if (room.priv) continue;
    room.world = null; loadSaved(room);
    room.finishers = [];
    for (const p of room.players.values()) { p.has = false; p.dead = 0; p.moved = false; p.vis.clear(); p.dver = null; }
    broadcast(room, { t: 'newmap', slot: curSlot, next: nextAt(curSlot), now: Date.now(), build: bstate(room) });   // (with what was built on this map the last time it was played)
  }
  keepWorlds(false);
  pushSubs.forEach((v, pub) => { if (v.m) pushTo(pub, 'm', ['A new map has started', maps.names[curSlot % maps.count]], 'map-' + curSlot); });   // (only devices that are not in the game right now)
}, 1000);

// Drop dead connections
setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, 25000);

function shutdown() { savePeak(true); saveLinks(true); try { keepWorlds(true); } catch (e) {} process.exit(0); }
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

server.listen(PORT, () => {
  console.log(`ballpit.party running on http://localhost:${PORT}  (map: ${maps.names[curSlot % maps.count]}, record: ${peak})`);
});

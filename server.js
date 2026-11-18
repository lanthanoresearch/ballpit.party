// ballpit.party - multiplayer relay server.   Run with:  npm install && npm start
// Optional environment variables:
//   PORT              port to listen on (hosts like Render/Railway set this for you)
//   MAX_PLAYERS      players per world (default 20). When a world is full, new players open World 2, 3, ...
//   MAX_TOTAL         players on the whole site at once (default: 40 per processor core, see below). Past that, people wait on the menu for a place
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
const zlib = require('zlib');
const { WebSocketServer } = require('ws');
const maps = require('./maps.js');
const P = require('./physics.js');

const PORT = process.env.PORT || 3000;
// what one world can hold of what people build (shared by everyone in it). Each player has their own, lower limits per item; these keep a full world quick.
const ROOM_PROPS = 1600, ROOM_GATES = 200, ROOM_MISC = 12000, ROOM_CPS = 150, ROOM_DELS = 20000;   // (deleting is not limited for a player: the world just has to remember what was deleted)
const MAX_PLAYERS_ENV = Math.max(2, parseInt(process.env.MAX_PLAYERS, 10) || 20);   // (the real number is worked out from what this server can run, below)
const SLOT_MS = 3 * 60 * 60 * 1000;                       // a map "session" lasts 3 hours (12, 3, 6, 9 o'clock)
const OFFSET_MS = (parseFloat(process.env.MAP_OFFSET_HOURS) || 0) * 3600 * 1000;
const TICK_MS = 16, SEND_CAP = 36;   // SEND_CAP: crates and balls told to each player per update at most (about 50 KB a second even when hundreds are moving)                                      // up to 60 updates per second (the world steps and is told about every 1/60 s), and only for players who actually sent something new (the client fills in the motion between them)
const RANGE = 3000;                                       // you only receive players within this many pixels of you (more than a screen)
const MAX_PER_IP = parseInt(process.env.MAX_PER_IP, 10) || 10;
const STATS_FILE = process.env.STATS_FILE || path.join(__dirname, 'stats.json');
const PATTERNS = 6;
const EMOJIS = 64;                                       // the built-in chat: 10 emojis and 14 ready-made phrases. Players can only send one of these (by number)
const MAX_LINKS = 1000;                                   // friends one player can have: as many as anyone will ever want (only a safety ceiling)
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
const GAME_V = 194;   // (the version of the game this server runs: the game's version panel shows it)
const BUILD_CHECK = process.env.BUILD_CHECK !== '0';   // (tests that talk to the server directly switch it off)
const BUILD = crypto.createHash('sha1').update(FILES['/index.html'].data).update(FILES['/maps.js'].data).update(FILES['/physics.js'].data).update(FILES['/sw.js'].data).digest('hex').slice(0, 12);
const HOME_URL = (process.env.HOME_URL || '').replace(/\/+$/, '');   // optional: send visitors of any other address here, e.g. https://ballpit.party

/* ---------- all-time record ---------- */
let peak = 0, statsDirty = false, peakDirty = false;
try { peak = Math.max(0, JSON.parse(fs.readFileSync(STATS_FILE, 'utf8')).peak | 0); } catch (e) {}
function savePeak(sync) {
  peakDirty = false;
  const s = JSON.stringify({ peak, usage: typeof usage === 'object' ? usage : undefined, savedAt: new Date().toISOString() });
  try { if (sync) fs.writeFileSync(STATS_FILE, s); else fs.writeFile(STATS_FILE, s, () => {}); } catch (e) {}
}

/* ---------- how the server is doing: its monthly allowance (data sent, hours running), how hard it is working, how late it runs ----------
   Render (2026): the free plan has 750 hours a month, 0.1 of a processor and 512 MB; the $7 plan has half a processor, 512 MB and no hour limit.
   Both include 5 GB of data sent out a month (on a paid plan, more costs about $0.15 a GB). The processor share is read from the system when it can be;
   set CPU_LIMIT (for example 0.5), BANDWIDTH_GB, INSTANCE_HOURS or MEM_MB if it shows the wrong plan. The counts are kept in the stats file and, since a free
   server forgets its files when it restarts, every player's device keeps a copy too and hands it back (the larger count wins). */
const BW_GB = +process.env.BANDWIDTH_GB || 5;
let CPU_KNOWN = true;
function cgroupNum(files) { for (const fp of files) { try { const t = fs.readFileSync(fp, 'utf8').trim(); if (t) return t; } catch (e) {} } return ''; }
const CPU_LIMIT = (() => { if (+process.env.CPU_LIMIT) return +process.env.CPU_LIMIT; const v2 = cgroupNum(['/sys/fs/cgroup/cpu.max']); if (v2) { const [q, pd] = v2.split(/\s+/); if (q !== 'max' && +q > 0 && +pd > 0) return +q / +pd; }
  const q1 = +cgroupNum(['/sys/fs/cgroup/cpu/cpu.cfs_quota_us', '/sys/fs/cgroup/cpu,cpuacct/cpu.cfs_quota_us']), p1 = +cgroupNum(['/sys/fs/cgroup/cpu/cpu.cfs_period_us', '/sys/fs/cgroup/cpu,cpuacct/cpu.cfs_period_us']); if (q1 > 0 && p1 > 0) return q1 / p1;
  CPU_KNOWN = false; return process.env.RENDER ? 0.5 : Math.max(1, require('os').cpus().length); })();
/* How many people can play at once, set for the worst case: everybody in every world has built everything they are allowed to and keeps running through it.
   Measured: one such world of 20 takes about three quarters of a processor core, two take a whole core and still run smoothly, three fall behind.
   So: 40 players for each full core, but never fewer than 20 (on a small plan the server eases off as it fills up), and 20 in any one world. MAX_TOTAL and MAX_PLAYERS set them by hand. */
const CPU_EFF = Math.max(0.05, Math.min(1, CPU_LIMIT));   // (one game server only ever uses one core)
const MAX_TOTAL = Math.max(2, parseInt(process.env.MAX_TOTAL, 10) || Math.max(20, Math.min(200, Math.round(CPU_EFF * 40))));   // (never fewer than 20: past what the processor can do at full quality, the server eases off step by step, see health)
const MAX_PLAYERS = Math.min(MAX_PLAYERS_ENV, MAX_TOTAL);
const PROP_SHARE = Math.floor(1600 / MAX_PLAYERS);   // crates, balls and springs every player in a world is always sure of (80 with 20 players)   // players per world: few enough that a world full of builds stays smooth for everyone
const PAID = CPU_LIMIT > 0.15, HOURS_LIMIT = +process.env.INSTANCE_HOURS || (PAID ? Infinity : 750);   // (a paid server has no monthly hour limit)
const MEM_LIMIT = (() => { if (+process.env.MEM_MB) return +process.env.MEM_MB * 1048576; const v = +cgroupNum(['/sys/fs/cgroup/memory.max', '/sys/fs/cgroup/memory/memory.limit_in_bytes']); if (v > 0 && v < 1e15) return v; return process.env.RENDER ? 512 * 1048576 : require('os').totalmem(); })();
const monthKey = (t = Date.now()) => new Date(t).toISOString().slice(0, 7), dayKey = (t = Date.now()) => new Date(t).toISOString().slice(0, 10);
let usage = { m: monthKey(), out: 0, in: 0, sec: 0, day: dayKey(), dayOut: 0, pkCpu: 0, pkCpuAt: 0, pkMem: 0, pkPl: 0, pkPlAt: 0 };   // (pk: this month's highest processor use, memory and players)
try { const u = JSON.parse(fs.readFileSync(STATS_FILE, 'utf8')).usage; if (u && u.m === usage.m) usage = Object.assign(usage, u); } catch (e) {}
function useRoll() { const m = monthKey(), d = dayKey(); if (usage.m !== m) usage = { m, out: 0, in: 0, sec: 0, day: d, dayOut: 0, pkCpu: 0, pkCpuAt: 0, pkMem: 0, pkPl: 0, pkPlAt: 0 }; if (usage.day !== d) { usage.day = d; usage.dayOut = 0; } }
function useOut(n) { usage.out += n; usage.dayOut += n; netNow.out += n; }
function useIn(n) { usage.in += n; netNow.in += n; }
function useMerge(u) {   // a player's device remembers the counts from before the server restarted
  if (!u || u.m !== usage.m || typeof u.out !== 'number') return;
  usage.out = Math.max(usage.out, Math.min(u.out, 1e13)); usage.in = Math.max(usage.in, Math.min(+u.in || 0, 1e13)); usage.sec = Math.max(usage.sec, Math.min(+u.sec || 0, 31 * 86400));
  if (u.day === usage.day) usage.dayOut = Math.max(usage.dayOut, Math.min(+u.dayOut || 0, 1e13));
  if (+u.pkCpu > usage.pkCpu && +u.pkCpu < 5) { usage.pkCpu = +u.pkCpu; usage.pkCpuAt = +u.pkCpuAt || 0; } if (+u.pkMem > usage.pkMem && +u.pkMem < 1e12) usage.pkMem = +u.pkMem; if ((u.pkPl | 0) > usage.pkPl && (u.pkPl | 0) < 10000) { usage.pkPl = u.pkPl | 0; usage.pkPlAt = +u.pkPlAt || 0; }
}
const netNow = { out: 0, in: 0, t: Date.now(), rOut: 0, rIn: 0 };
const health = { tickMs: [], late: [], lastTick: Date.now(), cpu: 0, cpuNow: 0, cpuHist: [], cpuT: process.cpuUsage(), cpuAt: Date.now(), level: 0, levelAt: 0, awake: 0, physMs: 0, physAvg: 0 };
/* How hard it works: measured every second, but judged over the last 10 seconds. A single second can jump high and fall straight back (a new map being made,
   the JavaScript engine tuning itself up, tidying memory), and that is not the server being overloaded.
   Levels: 0 everything at full quality. 1 players hear about the world 20 times a second instead of 30. 2 also 15 a second. 3 also the world worked out in
   steps half as fine. It goes down a level only when it is truly short of processor or falling behind, and back up as soon as there is room again. */
setInterval(() => {
  useRoll(); usage.sec += 1;
  const t = Date.now(), dt = (t - netNow.t) / 1000; netNow.rOut = netNow.out / dt; netNow.rIn = netNow.in / dt; netNow.out = netNow.in = 0; netNow.t = t;
  const c = process.cpuUsage(health.cpuT), w = (t - health.cpuAt) * 1000; health.cpuNow = w > 0 ? (c.user + c.system) / w : 0; health.cpuT = process.cpuUsage(); health.cpuAt = t;
  health.cpuHist.push(health.cpuNow); if (health.cpuHist.length > 10) health.cpuHist.shift();
  health.cpu = health.cpuHist.reduce((a, b) => a + b, 0) / health.cpuHist.length;
  health.physAvg += (health.physMs / Math.max(0.2, dt) / 1000 - health.physAvg) * 0.3; health.physMs = 0;
  const lateP = pct(health.late, 0.95), load = health.cpu / CPU_LIMIT, rss = process.memoryUsage().rss;
  if (health.cpuHist.length >= 10 && load > usage.pkCpu && process.uptime() > 30) { usage.pkCpu = +load.toFixed(3); usage.pkCpuAt = t; }   // (this month's highest, over 10 seconds; not counting the first half minute after a start, which is the engine warming up)
  if (rss > usage.pkMem) usage.pkMem = rss;
  { const n = health.cpuHist.length, l3 = health.cpuHist.slice(-3).reduce((a, b) => a + b, 0) / Math.min(3, n || 1) / CPU_LIMIT, lt = health.late.slice(-60), lateNow = lt.length ? Math.max(...lt) : 0;
    if ((CPU_KNOWN && l3 > 0.85) || lateNow > 25) phys.bud = Math.max(30, phys.bud * 0.7);
    else if ((!CPU_KNOWN || l3 < 0.65) && lateNow < 8) phys.bud = Math.min(600 * Math.max(1, phys.busy), phys.bud * 1.15 + 5); }
  const down = lateP > 45 || (CPU_KNOWN && load > 0.92 && lateP > 12), up = lateP < 15 && (!CPU_KNOWN || load < 0.7);
  if (down && t - health.levelAt > 3000 && health.level < 3) { health.level++; health.levelAt = t; }
  else if (up && t - health.levelAt > 6000 && health.level > 0) { health.level--; health.levelAt = t; }
  SIMDT = health.level >= 3 ? 1 / 60 : 1 / 120;
}, 1000).unref();
const sendEvery = () => health.level >= 2 ? 4 : health.level >= 1 ? 3 : 2;   // (in 60ths of a second: 30, 20 or 15 updates a second)
function pct(a, q) { if (!a.length) return 0; const b = [...a].sort((x, y) => x - y); return b[Math.min(b.length - 1, Math.floor(b.length * q))]; }
function statusNow() {
  useRoll();
  const t = Date.now(), d = new Date(t), dim = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate(), dayN = d.getUTCDate() - 1 + (d.getUTCHours() * 3600 + d.getUTCMinutes() * 60) / 86400;
  const bwLimit = BW_GB * 1073741824, daysLeft = Math.max(0.01, dim - dayN), perDay = usage.out / Math.max(0.25, dayN), lasts = perDay > 0 ? (bwLimit - usage.out) / perDay : 999;
  const tickMs = health.tickMs.length ? health.tickMs.reduce((x, y) => x + y, 0) / health.tickMs.length : 0, lateP = pct(health.late, 0.95), load = health.cpu / CPU_LIMIT, rss = process.memoryUsage().rss;
  const bwPct = usage.out / bwLimit, hrsPct = usage.sec / 3600 / HOURS_LIMIT, stale = t - health.lastTick;
  let rating = 'good', why = 'Running smoothly';
  if (lateP > 40 || (CPU_KNOWN && load > 0.9) || rss > MEM_LIMIT * 0.85) { rating = 'bad'; why = load > 0.9 ? 'Working at the edge of what this server is allowed to use' : rss > MEM_LIMIT * 0.85 ? 'Nearly out of memory' : 'Running a little behind'; }
  if (lateP > 100 || (CPU_KNOWN && load > 1.2)) { rating = 'really bad'; why = 'Falling behind: things in the world can look laggy'; }
  if (PAID && bwPct >= 1 && rating === 'good') { rating = 'bad'; why = 'Over the 5 GB of data included this month: more costs about $0.15 a GB'; }
  if (lateP > 300 || (bwPct >= 1 && !PAID) || hrsPct >= 1 || rss > MEM_LIMIT * 0.97) { rating = 'unusable'; why = bwPct >= 1 && !PAID ? 'Out of data for this month: Render stops free servers that go over' : hrsPct >= 1 ? 'Out of server hours for this month' : rss > MEM_LIMIT * 0.97 ? 'Out of memory' : 'Far behind: the game will be very laggy'; }
  if (stale > 2000) { rating = 'frozen'; why = 'The world has not moved for ' + Math.round(stale / 1000) + ' s'; }
  let awake = 0, things = 0; for (const r of rooms.values()) if (r.world) { things += r.world.dyn.length; awake += r.world.nAct || 0; }
  return { v: GAME_V, rating, why, level: health.level, now: t, month: usage.m, daysInMonth: dim, daysLeft: +daysLeft.toFixed(2),
    bandwidth: { used: usage.out, limit: bwLimit, inUsed: usage.in, today: usage.dayOut, perDayLeft: Math.max(0, (bwLimit - usage.out) / daysLeft), perDayAvg: perDay, lastsDays: +lasts.toFixed(1), outPerSec: Math.round(netNow.rOut), inPerSec: Math.round(netNow.rIn) },
    hours: { used: +(usage.sec / 3600).toFixed(2), limit: HOURS_LIMIT, upSec: Math.round(process.uptime()) },
    cpu: { used: +health.cpu.toFixed(4), now: +health.cpuNow.toFixed(4), limit: CPU_LIMIT, known: CPU_KNOWN }, mem: { used: rss, limit: MEM_LIMIT },
    peaks: { players: usage.pkPl, playersAt: usage.pkPlAt, cpu: usage.pkCpu, cpuAt: usage.pkCpuAt, mem: Math.max(usage.pkMem, rss) }, record: peak,
    capacity: { total: MAX_TOTAL, perWorld: MAX_PLAYERS, fullQuality: Math.max(1, Math.round(CPU_EFF * 40)) },
    tick: { ms: +tickMs.toFixed(2), budget: TICK_MS, lateMs: +lateP.toFixed(1), step: SIMDT > 0.01 ? 60 : 120 },
    players: online, maxPlayers: MAX_TOTAL, perWorld: MAX_PLAYERS, physBudget: physBudget(), physCostMs: +phys.cost.toFixed(4), rooms: [...rooms.values()].filter(r => r.players.size).length, things, moving: awake };
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
let linksDirty = false, knownDirty = false, linksSavedAt = 0;   // (knownDirty: only when people were last seen or their colours changed. That is written out at most every 5 minutes, so players arriving cost the server almost nothing)
const DAY = 24 * 3600 * 1000, REQ_TTL = 3 * DAY;   // a friend request waits three days for an answer, then it is dropped
const blocks = new Map();     // pub -> Set(pub): people this player has blocked (no requests, no messages, no chat from them)
const pairT = new Map();      // "a|b" (sorted) -> { s: when they became friends, m: when one last messaged the other }
const pairK = (a, b) => a < b ? a + '|' + b : b + '|' + a;
const pairOf = (a, b) => { const k = pairK(a, b); let v = pairT.get(k); if (!v) pairT.set(k, v = { s: 0, m: 0 }); return v; };
const blocked = (a, b) => { const x = blocks.get(a), y = blocks.get(b); return !!((x && x.has(b)) || (y && y.has(a))); };   // (either one blocked the other)
const SHARE_DEF = { on: 1, last: 1, beat: 1, fr: 1, since: 1 };   // what other players may see besides your name and your ball (all on unless you turn them off)
const shareOf = pub => { const k = known.get(pub); return Object.assign({}, SHARE_DEF, (k && k.share) || {}); };
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
/* Quiet hours: a player can choose a stretch of the day (in their own time zone) with no notifications, for the night */
function cleanQuiet(q) {
  if (!q || typeof q !== 'object') return null; const a = q.a | 0, b = q.b | 0, tz = typeof q.tz === 'string' ? q.tz.slice(0, 64) : '';
  if (a < 0 || a > 1439 || b < 0 || b > 1439 || a === b) return null;
  let ok = ''; if (tz) { try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); ok = tz; } catch (e) {} }
  return { a, b, tz: ok, off: Math.max(-900, Math.min(900, q.off | 0)) };
}
function quietNow(q) {   // is it within their quiet hours, where they are?
  if (!q) return false; let m;
  try { if (q.tz) { const f = new Intl.DateTimeFormat('en-US', { timeZone: q.tz, hour: 'numeric', minute: 'numeric', hourCycle: 'h23' }).formatToParts(new Date()); m = (+f.find(x => x.type === 'hour').value % 24) * 60 + +f.find(x => x.type === 'minute').value; } } catch (e) {}
  if (m === undefined) { const d = new Date(Date.now() - q.off * 60000); m = d.getUTCHours() * 60 + d.getUTCMinutes(); }   // (no time zone name: by the clock offset the device gave)
  return q.a < q.b ? m >= q.a && m < q.b : m >= q.a || m < q.b;   // (a stretch over midnight, like 22:00 to 07:00, too)
}
function pushTo(pub, kind, n, tag, from) {   // kind: 'f' friends online, 'r' friend requests, 'i' invites, 'm' new map. Only to devices that are not connected right now.
  const sub = pushSubs.get(pub), here = byPub.get(pub); if (!sub || !sub[kind] || (live(here) && !here.hidden) || (from && sub.mu && sub.mu.indexOf(from) >= 0) || quietNow(sub.q)) return;
  const k = pub + tag, t = Date.now(), gap = kind === 'f' ? 20 * 60000 : kind === 'm' ? 60 * 60000 : 30000; if (t - (pushLast.get(k) || 0) < gap) return; pushLast.set(k, t);
  if (pushLast.size > 4000) { for (const [kk, v] of pushLast) if (t - v > 3600000) pushLast.delete(kk); }
  sendPush(pub, { title: String(n[0]).slice(0, 60), body: String(n[1]).slice(0, 100), tag });
}

try {
  const o = JSON.parse(fs.readFileSync(LINKS_FILE, 'utf8'));
  for (const k in (o.links || {})) if (PUB.test(k)) links.set(k, new Set((o.links[k] || []).filter(v => PUB.test(v)).slice(0, MAX_LINKS)));
  for (const k in (o.gone || {})) if (PUB.test(k)) gone.set(k, new Set((o.gone[k] || []).filter(v => PUB.test(v)).slice(0, 50)));
  for (const k in (o.known || {})) if (PUB.test(k)) { const v = o.known[k] || {}; known.set(k, { name: cleanName(v.name), color: HEX.test(v.color) ? v.color : '#ff4d4d', color2: HEX.test(v.color2) ? v.color2 : '#ffffff', pat: cleanPat(v.pat), last: +v.last || 0, nameAt: +v.nameAt || 0, first: +v.first || +v.last || Date.now(), firstEst: v.first ? (v.firstEst ? 1 : 0) : 1, share: v.share && typeof v.share === 'object' ? cleanShare(v.share) : undefined, played: v.played === undefined ? 1 : v.played ? 1 : 0, beat: Math.max(0, Math.min(999, v.beat | 0)) }); }
  for (const k in (o.blocks || {})) if (PUB.test(k)) blocks.set(k, new Set((o.blocks[k] || []).filter(v => PUB.test(v)).slice(0, 200)));
  for (const k in (o.pairs || {})) if (/^[0-9a-f]{16}\|[0-9a-f]{16}$/.test(k)) { const v = o.pairs[k] || {}; pairT.set(k, { s: +v.s || 0, m: +v.m || 0 }); }
  for (const e of (o.pend || [])) if (Array.isArray(e) && /^[0-9a-f]{16}>[0-9a-f]{16}$/.test(e[0]) && Date.now() - e[1] < REQ_TTL) pend.set(e[0], { t: +e[1] });
  if (o.vapid && o.vapid.pub && o.vapid.priv) vapid = makeVapid(o.vapid.pub, o.vapid.priv);
  for (const k in (o.push || {})) if (PUB.test(k) && o.push[k] && okPushUrl(o.push[k].ep)) { const v = o.push[k]; pushSubs.set(k, { ep: String(v.ep), p: String(v.p).slice(0, 100), a: String(v.a).slice(0, 40), f: v.f ? 1 : 0, r: v.r ? 1 : 0, i: v.i ? 1 : 0, m: v.m ? 1 : 0, mu: Array.isArray(v.mu) ? v.mu.filter(x => PUB.test(x)).slice(0, 500) : [], q: cleanQuiet(v.q), t: +v.t || 0 }); }
  for (const e of (o.news || [])) if (Array.isArray(e) && PUB.test(e[0]) && Array.isArray(e[1])) news.set(e[0], e[1].filter(x => x && PUB.test(x.p) && Date.now() - x.t < REQ_TTL).map(x => ({ p: x.p, ok: x.ok ? 1 : 0, t: +x.t })).slice(-30));
  console.log('Restored ' + known.size + ' players, ' + [...links.values()].reduce((a, v) => a + v.size, 0) / 2 + ' friendships, ' + pend.size + ' waiting requests, from ' + LINKS_FILE);
} catch (e) {}
{ const ev = process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY ? makeVapid(process.env.VAPID_PUBLIC_KEY.trim(), process.env.VAPID_PRIVATE_KEY.trim()) : null;
  let dv = null; const seed = process.env.VAPID_SEED || process.env.RENDER_SERVICE_ID || process.env.RENDER_EXTERNAL_HOSTNAME;
  if (seed) { try { const d = crypto.createHash('sha256').update('ballpit-vapid:' + seed).digest(), e = crypto.createECDH('prime256v1'); e.setPrivateKey(d); dv = makeVapid(b64u(e.getPublicKey()), b64u(d)); } catch (x) { dv = null; } }   // (the same keys every time this server starts, even with nothing saved: phones signed up for notifications keep getting them)
  if (ev) vapid = ev; else if (dv) vapid = dv; else if (!vapid) { vapid = newVapid(); linksDirty = true; } }   // (keys from the settings win; otherwise they are made once and kept with the saved links)
function saveLinks(sync) {
  if (knownDirty && (sync || Date.now() - linksSavedAt > 5 * 60000)) linksDirty = true;
  if (!linksDirty) return; linksDirty = false; knownDirty = false; linksSavedAt = Date.now();
  // keep only what is needed: people not seen for 30 days (and not tied to a friend link or a waiting request) are forgotten
  { const old = Date.now() - STALE_MS, need = new Set(); links.forEach((v, k) => { if (v.size) { need.add(k); v.forEach(x => need.add(x)); } }); pend.forEach((v, k) => { const p2 = k.split('>'); need.add(p2[0]); need.add(p2[1]); }); news.forEach((v, k) => { need.add(k); v.forEach(x => need.add(x.p)); });
    known.forEach((v, k) => { if ((v.last < old || (!v.played && v.last < Date.now() - DAY)) && !need.has(k) && !byPub.has(k)) { known.delete(k); pushSubs.delete(k); blocks.delete(k); gone.delete(k); claimsOf.delete(k); } }); }   // (and what was kept for them goes with them: their notifications, their block list)   // (not seen for a month: forgotten, unless somebody has them as a friend or is waiting on a request with them. Their friends keep them)   // (everybody who has really played is kept for good; somebody who only opened the page for a moment is forgotten after a day)
  if (known.size > 50000) { const need = new Set(); links.forEach((v, k) => { if (v.size) { need.add(k); v.forEach(x => need.add(x)); } }); [...known.entries()].filter(e => !need.has(e[0]) && !byPub.has(e[0])).sort((a, b) => a[1].last - b[1].last).slice(0, known.size - 50000).forEach(e => known.delete(e[0])); }   // (a safety ceiling that never drops anybody's friend)
  const o = { links: {}, gone: {}, known: {}, pend: [...pend.entries()].map(e => [e[0], e[1].t]), news: [...news.entries()].filter(e => e[1].length), vapid: vapid ? { pub: vapid.pub, priv: vapid.priv } : undefined, push: Object.fromEntries(pushSubs) };
  o.blocks = {}; blocks.forEach((v, k) => { if (v.size) o.blocks[k] = [...v]; });
  o.pairs = {}; pairT.forEach((v, k) => { const [a, b] = k.split('|'); if ((links.get(a) && links.get(a).has(b)) || v.m > Date.now() - STALE_MS) o.pairs[k] = v; });   // (kept while they are friends)
  links.forEach((v, k) => { if (v.size) o.links[k] = [...v]; }); gone.forEach((v, k) => { if (v.size) o.gone[k] = [...v]; }); known.forEach((v, k) => { o.known[k] = v; });
  const s = JSON.stringify(o);
  try {   /* written to a side file first and then swapped in, so a restart in the middle of saving can never leave a half-written list */
    const tmp = LINKS_FILE + '.tmp';
    if (sync) { fs.writeFileSync(tmp, s); fs.renameSync(tmp, LINKS_FILE); } else fs.writeFile(tmp, s, er => { if (!er) fs.rename(tmp, LINKS_FILE, () => {}); });
  } catch (e) {}
}
const linkSet = pub => { let s = links.get(pub); if (!s) links.set(pub, s = new Set()); return s; };
function addLink(a, b) { if (blocked(a, b)) return; if (!linkSet(a).has(b)) pairOf(a, b).s = Date.now(); linkSet(a).add(b); linkSet(b).add(a); linksDirty = true; }
function dropLink(a, b) { const sa = links.get(a), sb = links.get(b); if (sa) sa.delete(b); if (sb) sb.delete(a); linksDirty = true; dropShares(a, b); }
/* ---------- sharing maps: a player sends their version of one of their private maps to friends. The server holds it (on disk) until each friend
   answers, for up to three days like a friend request, and only ever hands it to that friend ---------- */
const SHARE_FILE = process.env.SHARE_FILE || path.join(path.dirname(LINKS_FILE), 'shares.json');
const SHARE_TTL = 3 * DAY, SHARE_MAX = 1500000, SHARE_PER_TO = 20, SHARE_ALL = 150 * 1000 * 1000;
const shares = new Map(); let sharesDirty = false;
try { const o = JSON.parse(fs.readFileSync(SHARE_FILE, 'utf8')); for (const v of (o && Array.isArray(o.list) ? o.list : [])) if (v && typeof v.id === 'string' && PUB.test(v.from || '') && PUB.test(v.to || '') && typeof v.data === 'string' && Date.now() - v.t < SHARE_TTL) shares.set(v.id, v); console.log('Restored ' + shares.size + ' shared maps'); } catch (e) {}
function saveShares() {
  const now = Date.now(); for (const [id, v] of shares) if (now - v.t > SHARE_TTL) { shares.delete(id); sharesDirty = true; }
  if (!sharesDirty) return; sharesDirty = false;
  try { const tmp = SHARE_FILE + '.tmp'; fs.writeFileSync(tmp, JSON.stringify({ list: [...shares.values()] })); fs.renameSync(tmp, SHARE_FILE); } catch (e) { console.warn('could not save shares: ' + e.message); }
}
setInterval(saveShares, 20000);
function dropShares(a, b) { for (const [id, v] of shares) if ((v.from === a && v.to === b) || (v.from === b && v.to === a)) { shares.delete(id); sharesDirty = true; } }
const shareMeta = v => ({ id: v.id, from: v.from, name: (byPub.get(v.from) || {}).name || v.fromName || '', idx: v.idx, n: v.n, t: v.t });
function sendShares(p) { const now = Date.now(), list = []; for (const v of shares.values()) if (v.to === p.pub && now - v.t <= SHARE_TTL && !blocked(v.from, v.to) && linkSet(p.pub).has(v.from)) list.push(shareMeta(v)); if (list.length) send(p, { t: 'shr', list }); }
const STALE_MS = 30 * 86400000;   // everybody who has played in the last 30 days is listed; anybody gone longer (and not somebody's friend or in a waiting request) is quietly forgotten
const live = q => !!(q && (q.room || q.lobby));   // connected: playing in a world, or just sitting on the main menu
function cleanShare(o) { const r = {}; for (const k in SHARE_DEF) r[k] = o && o[k] === 0 && (k === 'fr' || k === 'since') ? 0 : 1; return r; }   // (only how many friends you have and when you started can be kept private; the rest is always shown)
const peerInfo = (pub, viewer) => {   // what one player is told about another: their name and ball always, the rest only as far as they share it
  const k = known.get(pub) || {}, q = byPub.get(pub), sh = shareOf(pub), pr = viewer ? pairT.get(pairK(pub, viewer)) : null, on = live(q);
  return { pub, code: codeOf(pub), name: q ? q.name : (k.name || ''), color: q ? q.color : (k.color || '#cccccc'), color2: q ? q.color2 : (k.color2 || '#ffffff'), pat: q ? q.pat | 0 : (k.pat | 0),
    on: sh.on && on ? 1 : 0, hid: sh.on ? 0 : 1, w: sh.on && q && q.room ? (q.room.priv ? -1 : q.room.id) : 0, last: sh.last ? (on && sh.on ? Date.now() : (k.last || 0)) : 0, b: sh.beat ? k.beat | 0 : -1,
    fr: sh.fr ? linkSet(pub).size : -1, first: sh.since ? k.first || 0 : 0, fe: k.firstEst ? 1 : 0, since: pr ? pr.s : 0, dm: pr ? pr.m : 0 };
};
function sendMe(p) {   // your own profile as others see it, what you share, and who you have blocked
  if (!p.pub) return; const k = known.get(p.pub) || {};
  send(p, { t: 'me', first: k.first || 0, fr: linkSet(p.pub).size, share: shareOf(p.pub), blocks: [...(blocks.get(p.pub) || [])].map(b => { const i = peerInfo(b); return { pub: b, code: i.code, name: i.name, color: i.color, color2: i.color2, pat: i.pat }; }) });
}
function sendLinks(p) {   // everyone this player is linked to, with their short code, whether they are online, and when they were last here
  send(p, { t: 'links', list: [...(links.get(p.pub) || [])].map(f => peerInfo(f, p.pub)) });
}
// a player's name can be changed once a day (only for players with a device code)
function setName(p, nm) {
  if (nm && P.piiCheck(nm)) nm = (known.get(p.pub || '') || {}).name || p.name || randomName();   // (a name is never a phone number or an email)
  if (!p.pub) { p.name = nm; return 0; }
  const now = Date.now(); let k = known.get(p.pub);
  if (!k) { k = { name: nm, color: p.color, color2: p.color2, pat: p.pat | 0, last: now, nameAt: 0, first: now }; known.set(p.pub, k); p.name = nm; linksDirty = true; return 0; }
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
const PRIV_BASE = 3000000, PRIV_MAX = MAX_PLAYERS;   // a friend's own world (their solo level, with the things they built) is a private room; its slot is the same number the solo game uses
/* the owner book (see physics.js): who built each thing in a world, by their own number. Kept with the world, sent with it, saved with it */
const owBook = B => {
  if (B.ow && typeof B.ow === 'object') return B.ow;
  B.ow = {};   // (a world saved before the owner book: the crates and balls already said whose they were, so that is kept)
  if (B.po && typeof B.po === 'object') for (const q of (B.props || [])) { const t = B.po[q.join(',')]; if (Number.isFinite(t)) P.bookAdd(B.ow, 'p', q, t >>> 0); }
  return B.ow;
};
const owAdd = (B, k, q, t) => P.bookAdd(owBook(B), k, q, t);
const owDel = (B, k, q, t) => P.bookDel(owBook(B), k, q, t);
function owDiff(B, fn) {   // run something that may take records off the lists, and take their owners off the book with them
  const before = {}; for (const n in P.BOOK_K) before[n] = (B[n] || []).slice();
  const r = fn();
  for (const n in P.BOOK_K) { const now = new Set(B[n] || []); for (const q of before[n]) if (!now.has(q)) owDel(B, P.BOOK_K[n], q); }
  return r;
}
function owFill(B, tag) {   // every record has an owner: any without one (an old save) is the given player's
  const clean = P.bookClean(owBook(B), B), rd = P.bookReader(clean), out = {};
  for (const n in P.BOOK_K) for (const q of (B[n] || [])) { if (!Array.isArray(q)) continue; const t = rd(P.BOOK_K[n], q); if (t !== undefined) P.bookAdd(out, P.BOOK_K[n], q, t); else if (tag) P.bookAdd(out, P.BOOK_K[n], q, tag); }
  B.ow = out; return B;
}
function owCounts(B, k, name) {   // how many of one kind each player has built here
  const m = new Map(), rd = P.bookReader(owBook(B)); for (const q of (B[name] || [])) { const t = rd(k, q); if (t !== undefined) m.set(t, (m.get(t) || 0) + 1); } return m;
}
const bOut = B => ({ props: B.props, gates: B.gates, misc: B.misc, cps: B.cps, dels: B.dels, ow: owBook(B) });
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
  if (url === '/status') {
    const b = JSON.stringify(statusNow()); useOut(b.length + 200);
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' });
    return res.end(b);
  }
  if (url === '/version') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' });
    return res.end(JSON.stringify({ build: BUILD, home: HOME_URL, v: GAME_V }));
  }
  const f = FILES[url];
  if (!f) { res.writeHead(404); return res.end('Not found'); }
  let key = '';
  if (f.type.indexOf('text/html') === 0) {   // the share image needs a full web address, so this site's own address is filled in
    const proto = String(req.headers['x-forwarded-proto'] || 'http').split(',')[0].trim();
    const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim().replace(/[^A-Za-z0-9.:\-]/g, '');
    key = proto.replace(/[^a-z]/g, '') + '://' + host;
  }
  // each file is made ready once (and squeezed with gzip once), then simply handed out: a page load costs the server almost nothing, and about a fifth of the data
  const cache = f.cache || (f.cache = new Map()); let c = cache.get(key);
  if (!c || c.src !== f.data) {
    const raw = key ? Buffer.from(f.data.toString('utf8').split('__ORIGIN__').join(key).split('__BUILD__').join(BUILD)) : f.data;
    const zip = /^(text\/|application\/(javascript|json|manifest)|image\/svg)/.test(f.type) && raw.length > 1024;
    c = { src: f.data, raw, gz: zip ? zlib.gzipSync(raw, { level: 9 }) : null }; if (cache.size > 8) cache.clear(); cache.set(key, c);
  }
  const gz = c.gz && /\bgzip\b/.test(String(req.headers['accept-encoding'] || '')), body = gz ? c.gz : c.raw;
  useOut(body.length + 300);
  const hd = { 'Content-Type': f.type, 'Cache-Control': f.type.indexOf('image/') === 0 ? 'public, max-age=3600' : 'no-store' }; if (c.gz) hd.Vary = 'Accept-Encoding'; if (gz) hd['Content-Encoding'] = 'gzip';
  res.writeHead(200, hd);
  res.end(body);
});

const wss = new WebSocketServer({ server, maxPayload: 65536, perMessageDeflate: false });   // (a world's memory, sent back by a player after a restart, comes in parts of up to 60 KB)

// Worlds are numbered 1, 2, 3...  Everyone goes to the lowest-numbered world with space; a new world only opens when the others are full.
function roomFresh(r) {   // a public world this server knows nothing about (it was restarted and lost its memory): a player who was here may have it
  if (!r || r.priv || r.seeded || !r.virgin) return false;
  if (r.snapAt && Date.now() - r.snapAt > 5000) return false;   // (this server has been handing out its own memory of this world for a while: it has not forgotten anything, so nobody's copy is taken over it and the world is never loaded afresh under the players)   // (virgin: there was no memory of it at all when it was opened)
  const b = r.build; return !b || (!b.props.length && !b.misc.length && !b.gates.length && !b.cps.length && !(b.dels || []).length);
}
function snapFor(r) {   // a world's memory as the players keep it: what is built, and where everything is that has been moved
  const w = r.world; if (!w) return null;
  const d = []; for (const o of w.dyn) { if (o.burn >= 1e9) d.push([o.uid >>> 0, 0, 0, 0, 1]); else if (!(o.burn > 0) && (Math.abs(o.x - o.hx) > 1 || Math.abs(o.y - o.hy) > 1 || Math.abs(o.rot) > 0.005)) d.push([o.uid >>> 0, Math.round(o.x * 10) / 10, Math.round(o.y * 10) / 10, Math.round(o.rot * 1000) / 1000]); }
  return { d, s: w.see.filter(q => Math.abs(q.ang) > 0.001).map(q => [q.uid >>> 0, Math.round(q.ang * 1000) / 1000]) };
}
setInterval(() => {   // every few seconds everyone is told the fingerprint of their world: a device that has something else asks for the whole of it again
  for (const r of rooms.values()) { if (!r.players.size) continue; const B = bstate(r); if (!B) continue; const msg = '{"t":"bh","h":' + P.buildHash(B) + '}'; for (const p of r.players.values()) if (p.has && p.ws.readyState === 1) { try { p.ws.send(msg); } catch (e) {} } }
}, 5000).unref();
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
      try { p.ws.send(msg); p.sbh = bh; p.sdh = dh; if (!r.snapAt) r.snapAt = now; } catch (e) {}
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
    const nr = { id, players: new Map(), finishers: [], bornAt: Date.now(), fk: pickFin(id) };
    loadSaved(nr);   // (a world that was here before comes back as it was)
    rooms.set(id, nr);
    return { room: nr, full };
  }
}


/* ---------- the shared world ----------
   Every world (public or private) has ONE set of crates, balls, planks and gates, worked out here with the same physics the game uses (physics.js).
   Players never touch each other, but everybody pushes the same things. Each device is sent where things are and shows exactly that. */
let SIMDT = 1 / 120;   // (the same step the players' own devices take, so everything moves exactly as it does there; only a server that cannot keep up takes bigger steps, see health below)
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
  else if (k === 'see') { const cx = (q[1] + 1) * TS, cy = q[2] * TS - 46; w.see.push({ cx, cy, hl: (q[3] === 1 ? 5 : 3) * TS, tilt: 0, ang: 0, av: 0, tq: 0, uid: P.hash32('s' + Math.round(cx) + ',' + Math.round(cy)) }); }
  else if (k === 'base') P.addBase(w, q);
  else if (k === 'por') P.addPortal(w, q);
  else if (k === 'rope') P.addRope(w, q);   // (checked when it was built; it stays even if the ground around it changes later)
  else if (k === 'pwr') P.addPwr(w, q);
  else if (k === 'pad') P.addPad(w, [q[1], q[2], q[3]]);
}
function srvGate(w, q) {
  const id = w.doors.length, d = { id, uid: P.hash32('g' + q.slice(0, 5).join(',')), x: q[0], y: q[1], w: 1, h: q[2], open: false, latched: false };
  w.doors.push(d); P.setDoorTiles(w, d, false); w.plates.push({ x: q[3], y: q[4], w: 2, to: [id], on: false });
}
// where the finish is this round: each public map has up to 4 spots and a new one is drawn every round; a private world uses the one its host chose
const mapMemo = new Map();   // maps made here and kept: making one is the single most expensive thing the server does, so the public map (and a few private ones) are made once and kept
function genMap(i) {
  i = ((i | 0) % maps.count + maps.count) % maps.count;
  let m = mapMemo.get(i); if (m) { mapMemo.delete(i); mapMemo.set(i, m); return m; }
  m = maps.generate(i); mapMemo.set(i, m);
  const keep = curSlot % maps.count; for (const k of mapMemo.keys()) { if (mapMemo.size <= 5) break; if (k !== keep) mapMemo.delete(k); }   // (the oldest go first, never the public one)
  return m;
}
/* The next public map is made a few minutes early, and on the side (in a second thread), so the world everybody is playing in never stops for it */
let genBusy = false;
function genAhead(i) {
  i = ((i | 0) % maps.count + maps.count) % maps.count; if (mapMemo.has(i) || genBusy) return;
  let wk; try { const { Worker } = require('worker_threads'); wk = new Worker("const { parentPort, workerData } = require('worker_threads'); parentPort.postMessage(require(workerData.f).generate(workerData.i));", { eval: true, workerData: { f: require.resolve('./maps.js'), i } }); }
  catch (e) { genMap(i); return; }
  genBusy = true;
  wk.once('message', m => { if (!mapMemo.has(i) && m && m.W) { mapMemo.set(i, m); const keep = curSlot % maps.count; for (const k of mapMemo.keys()) { if (mapMemo.size <= 5) break; if (k !== keep && k !== i) mapMemo.delete(k); } } });
  wk.once('error', () => {}); wk.once('exit', () => { genBusy = false; });
}
setInterval(() => { if (nextAt(curSlot) - Date.now() < 3 * 60000) genAhead(curSlot + 1); }, 30000).unref();
setTimeout(() => genAhead(curSlot), 50);   // (and the public map is made as soon as the server starts, before anybody arrives)   // (the next public map is made a few minutes early, while things are calm, not at the moment everybody is waiting for it)
function finCount() { const m = genMap(curSlot); return (m.fins || [1]).length; }
function pickFin(id) {   // where the finish is in a public world: the same for this map and this world every time, so a server restart (or a world that empties and fills again) never moves it in the middle of a round
  let h = Math.imul((curSlot | 0) * 1000003 + (id | 0) * 7919 + 40503, 2654435761) >>> 0; h ^= h >>> 15; h = Math.imul(h, 2246822519) >>> 0; h ^= h >>> 13;
  return (h >>> 0) % Math.max(1, finCount());
}
/* A guard against too many private games at once. Plenty can run side by side; a new one is only turned away when there are a great many already,
   or when the server is truly falling behind (it has already dropped to its slowest setting) while a fair number are open. */
const PRIV_ROOMS = Math.max(4, +process.env.PRIV_ROOMS || 80), PRIV_ROOMS_BUSY = Math.max(2, +process.env.PRIV_ROOMS_BUSY || 12);
function privCount() { let n = 0; for (const r of rooms.values()) if (r.priv) n++; return n; }
function privFull() { const n = privCount(); return n >= PRIV_ROOMS || (health.level >= 3 && n >= PRIV_ROOMS_BUSY); }
function roomMap(room) { return maps.withFin(genMap(rslot(room)), room.fk | 0); }
const inZoneT = (w, tx, ty) => P.zoneT(w.map, tx, ty);
function miscOkZ(w, q) {   // (the same rule every device uses: nothing built in the start zone or around the finish, wherever the finish is this round)
  if (!Array.isArray(q)) return false;
  if (q[0] === 'por' || q[0] === 'rope') return !inZoneT(w, q[1], q[2]) && !inZoneT(w, q[3], q[4]);
  return !inZoneT(w, q[1], q[2]) && !inZoneT(w, q[1] + 1, q[2]);
}
/* bases: inside somebody's base only they can build. bLock(w, px, py, otag): is this spot in a base that is not this player's? */
function bLock(w, px, py, otag) { if (!w || !w.bases) return false; for (const b of w.bases) { const dx = px - b.cx, dy = py - b.cy; if (dx * dx + dy * dy <= b.r * b.r && (b.o >>> 0) !== ((otag || 0) >>> 0)) return true; } return false; }
const mkey = q => q.slice(0, q[0] === 'por' || q[0] === 'rope' ? 5 : 3).join(',');
function gateOkZ(w, q) { if (!Array.isArray(q) || q.length < 5) return false; return !inZoneT(w, q[0], q[1]) && !inZoneT(w, q[3], q[4]); }   // (exactly the client's validGate)
function roomWorld(room) {
  if (room.world) return room.world;
  const m = roomMap(room), w = P.makeWorld(m);
  w.orig = w.grid.slice(); w.closeDelay = 0.6; w.focus = []; w.follow = false;
  const B = bstate(room);
  owDiff(B, () => { P.normBuild(B); if (B.props) for (let i = B.props.length - 1; i >= 0; i--) if (P.zoneP(m, B.props[i][1], B.props[i][2], P.TS * 0.6)) B.props.splice(i, 1); });   // (nothing built stands in the no-build circles: the same rule every device uses)
  (B.dels || []).forEach(q => { try { if (P.coordDel(q)) P.applyDel(w, q); } catch (e) {} });   // (the map's own portals and boosters that were deleted: before anything built goes in)
  (B.misc || []).forEach(q => { try { if (miscOkZ(w, q)) srvMisc(w, q); } catch (e) {} });
  owDiff(B, () => { if (B.gates) for (let i = B.gates.length - 1; i >= 0; i--) if (!gateOkZ(w, B.gates[i])) B.gates.splice(i, 1); });
  (B.gates || []).forEach(q => { try { srvGate(w, q); } catch (e) {} });
  { const rd = P.bookReader(owBook(B)); (B.props || []).forEach(q => { try { const d = P.addProp(w, q[0], q[1], q[2]), t0 = rd('p', q); if (d) { d.brec = q; const t = t0 !== undefined ? t0 : B.po ? B.po[q.join(',')] : undefined; if (t !== undefined) d.ownTag = t >>> 0; else if (room.priv && room.priv.hostTag) d.ownTag = room.priv.hostTag >>> 0; } } catch (e) {} }); }
  (B.dels || []).forEach(q => { try { if (!P.coordDel(q)) P.applyDel(w, q); } catch (e) {} });   // (and what was deleted stays deleted)
  let restored = false;
  if (room.snapDyn && room.snapDyn.length && Array.isArray(room.snapDyn.find(q => q)) && room.snapDyn.find(q => q).length >= 4) {   // (saved by name: each thing finds its own entry)
    for (const q of room.snapDyn) { if (!q) continue; const d = w.dynBy.get(q[3] >>> 0); if (!d || d.gone) continue; restored = true; if (q[4]) { d.burn = 1e9; d.x = d.y = -99999; d.vx = d.vy = 0; continue; }   /* (the map's own toys at the start that an older version burned up there come back) */ if (Number.isFinite(q[0]) && Number.isFinite(q[1])) { d.x = q[0]; d.y = q[1]; d.rot = q[2] || 0; d.vx = d.vy = 0; d.nap = true; d.rest = 0; } }
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
    d.ver = ++r.verN; (r.chg = r.chg || []).push(d); d.lx = d.x; d.ly = d.y; d.lr = d.rot; d.lb = false; d.brec = q; return d; } },
  misc: (r, q) => { if (r.world) srvMisc(r.world, q); },
  gate: (r, q) => { if (r.world) srvGate(r.world, q); },
  del: (r, q) => { if (!r.world) return; const d = q[0] === 'b' ? r.world.dynBy.get(q[1] >>> 0) : null; if (P.applyDel(r.world, q) && d) { d.ver = ++r.verN; (r.chg = r.chg || []).push(d); } }
};
function doorSig(w) {
  let s = ''; for (const o of w.doors) s += (o.open ? 1 : 0) + (o.latched ? 2 : 0); s += '|'; for (const q of w.btns) s += q.on ? 1 + '.' + (q.rf || 0) : 0; s += '|'; for (const q of w.plates) s += q.on ? 1 : 0; return s;
}
function doorPacket(room) {
  const w = room.world, d = [], b = [], p = [];
  w.doors.forEach(o => { d.push(o.uid, (o.open ? 1 : 0) | (o.latched ? 2 : 0)); });
  const bt = []; w.btns.forEach((q, i) => { if (q.on) { b.push(i); bt.push(Math.round(q.left === undefined ? P.BTN_T : q.left)); } });   // (bt: seconds each pressed button has left)
  w.plates.forEach(q => { if (q.on) p.push(P.hash32('l' + q.x + ',' + q.y)); });
  return { t: 'dr', d, b, bt, p };
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
const worldStr = new Map();   // each remembered world, already written out as text: only the worlds people are in are written out again
let worldFileStr = '';
function keepWorlds(sync) {
  for (const [id, r] of rooms) if (!r.priv && (r.world || r.snapDyn !== undefined || r.build)) {
    const k = wkey(id), sn = snapRoom(r), t = JSON.stringify(sn); savedWorlds.set(k, sn);
    if (worldStr.get(k) !== t) { worldStr.set(k, t); worldsDirty = true; }   // (nothing moved and nothing was built: nothing to write)
  }
  if (!worldsDirty) return; worldsDirty = false;
  const parts = []; savedWorlds.forEach((v, k) => { let t = worldStr.get(k); if (t === undefined) { t = JSON.stringify(v); worldStr.set(k, t); } parts.push(JSON.stringify(k) + ':' + t); });
  for (const k of worldStr.keys()) if (!savedWorlds.has(k)) worldStr.delete(k);
  const str = '{"maps":{' + parts.join(',') + '}}', tmp = WORLD_FILE + '.tmp';
  if (str === worldFileStr && !sync) return; worldFileStr = str;
  try { if (sync) { fs.writeFileSync(tmp, str); fs.renameSync(tmp, WORLD_FILE); } else fs.writeFile(tmp, str, er => { if (!er) fs.rename(tmp, WORLD_FILE, () => {}); }); } catch (e) {}
}
setInterval(() => keepWorlds(false), 20000).unref();
setInterval(() => {   // a private world whose host has not come back in ten minutes closes
  const t = Date.now();
  for (const [id, r] of rooms) if (r.priv && r.priv.away && t - r.priv.away > 10 * 60000) { for (const o of [...r.players.values()]) { send(o, { t: 'pclose', name: r.priv.hostName || 'The host' }); leave(o, true); } rooms.delete(id); }
}, 15000).unref();
setInterval(() => { const t = Date.now(); for (const [id, r] of rooms) if (r.players.size === 0 && !(id === 1 && !r.priv) && (!r.emptyAt || t - r.emptyAt > ROOM_KEEP_MS)) {   /* (the first public world is never put away: the next player to arrive finds it ready, instead of the server rebuilding it) */ if (!r.priv) { const sn = snapRoom(r); if (sn) { savedWorlds.set(wkey(id), sn); worldStr.delete(wkey(id)); worldsDirty = true; } } rooms.delete(id); } }, 30000).unref();
/* ----- bots in private worlds, when the host switches them on. They fill the world to 10 to 20 players in all (real people always come first: with 20 people there are none),
   come and go now and then, and live here on the server, so they push crates, tip planks, cross bridges and press buttons for everybody, just like a player ----- */
let botIdN = 0;
const BOT_GOALS = [10, 12, 14, 15, 16, 18, 20];
const botInfo = bt => [bt.id, bt.name, bt.color, bt.color2, bt.pat, bt.crown | 0];
function roomBots(room, w, dtReal) {
  const bs = room.bots || (room.bots = []);
  if (!room.priv) { if (bs.length) { for (const bt of bs) broadcast(room, { t: 'bl', id: bt.id }); bs.length = 0; } return; }
  if (bs.length) {   // the crowd: answers, help, and noticing what people build
    const ctx = roomCtx(room); ctx.players = [...room.players.values()].filter(p => p.has && !p.dead).map(p => ({ id: p.id, x: p.x, y: p.y }));
    ctx.balls = ctx.players.concat(bs.filter(bt => !(bt.dead > 0)).map(bt => bt.b));
    P.botSocial(bs, w, ctx, dtReal); ctx.asks.length = 0; ctx.builds.length = 0; ctx.fins.length = 0;
  }
  room.botRe = (room.botRe || 0) - dtReal;
  if (room.botRe <= 0) { room.botGoal = room.botGoal ? Math.max(10, Math.min(20, room.botGoal + [-2, -1, 0, 0, 1, 2][Math.floor(Math.random() * 6)])) : BOT_GOALS[Math.floor(Math.random() * BOT_GOALS.length)]; room.botRe = 300 + Math.random() * 420; }   // (the crowd changes slowly: now and then one comes or goes, never a stream of them)
  const want = room.botsOn ? Math.max(0, Math.min(MAX_PLAYERS, room.botGoal || 15) - room.players.size) : 0;
  room.botT = (room.botT || 0) - dtReal;
  if (bs.length < want && room.botT <= 0) {
    const taken = n => bs.some(b => b.name === n) || [...room.players.values()].some(p => p.name === n);
    const bt = P.botMake(Object.assign({ id: 900000 + (botIdN++ % 90000), name: P.botName(taken) }, P.botLook())); P.botSpawn(bt, w); bs.push(bt);
    broadcast(room, { t: 'bj', b: [botInfo(bt)], say: 1 });
    room.botT = bs.length < 4 ? 0.4 + Math.random() * 0.8 : bs.length < want - 3 ? 1 + Math.random() * 3 : 20 + Math.random() * 40;
  } else if (bs.length > want && room.botT <= 0) {
    const i = Math.floor(Math.random() * bs.length), bt = bs[i]; bs.splice(i, 1); broadcast(room, { t: 'bl', id: bt.id, say: 1 });
    room.botT = room.botsOn ? 1 + Math.random() * 2 : 0.3;
  }
}
const roomCtx = room => room.botCtx || (room.botCtx = Object.assign(P.botCtx(), { finKnown: true }));   // (in a private world the finish is on everybody's map)
function botOut(room, bt) {   // what a bot said, or a block it put down (or took back): everybody in the world gets it
  for (const o of bt.out) {
    if (o.k === 'msg' && (o.a !== undefined ? o.a >= 0 && o.a < 11 && o.b >= 0 && o.b < 15 : o.i >= 0 && o.i < EMOJIS)) broadcast(room, o.a !== undefined ? { t: 'bsay', id: bt.id, a: o.a, b: o.b } : { t: 'bsay', id: bt.id, i: o.i });   // (the same messages a player can send, nothing else)
    else if (o.k === 'tl' && room.world) {   // (bot blocks belong to this world only while it is open: they are never saved into anybody's own world)
      const q = ['tl', o.x, o.y, o.v === -1 ? -1 : 1]; srvMisc(room.world, q);
      const bt2 = room.botTl || (room.botTl = new Map()), key = o.x + ',' + o.y; if (o.v === -1) bt2.delete(key); else bt2.set(key, q);
      broadcast(room, { t: 'pobj', g: q, bot: 1 });
    }
  }
  bt.out.length = 0;
}
function stepRoomBots(room, w, dt) {   // one step for every bot in this world (inside the world's own steps, so they push things exactly like players)
  const bs = room.bots; if (!bs || !bs.length) return;
  const B = { n: 8 }, ctx = roomCtx(room);
  for (let i = bs.length - 1; i >= 0; i--) {
    const bt = bs[i], e = P.botStep(bt, w, dt, B, ctx); if (bt.out.length) botOut(room, bt);
    if (e === 'fin') { roomCtx(room).fins.push({ x: bt.b.x, y: bt.b.y }); room.finishers.push('b' + bt.id); bt.crown = room.finishers.length; broadcast(room, { t: 'fin', id: bt.id, bot: 1, name: bt.name, rank: bt.crown, ms: 0 }); }
    else if (e === 'leave') { bs.splice(i, 1); broadcast(room, { t: 'bl', id: bt.id, say: 1 }); }
  }
}
function sendBots(room) {   // where every bot is, 20 times a second
  const bs = room.bots; if (!bs || !bs.length) return;
  const a = []; for (const bt of bs) { const b = bt.b; a.push(bt.id, Math.round(b.x), Math.round(b.y), Math.round(b.vx), Math.round(b.vy), bt.dead > 0 ? 1 : 0); }
  broadcast(room, { t: 'bp', a });
}
function giveBack(r, d, by) {   // a built thing is gone (deleted by anyone, or lost): its builder gets that room back
  const pub = d.ownPub || (by && by.pub); if (!pub) return;
  if (!by || by.pub !== pub) for (const q of r.players.values()) if (q.pub === pub) send(q, { t: 'pback', k: d.kind | 0 });
}
/* The physics share: at most about half of what this server may use goes to crates and balls moving, shared out between the worlds where a lot is moving.
   Past that, what is nearest to the players moves first and what is further away waits its turn, so a world where everybody built everything never slows the server down. */
const phys = { cost: 0.012, busy: 1, busyN: 0, bud: 600 };   // (bud: how many moving things in all; it is turned down when the server is short of processor or running late, and back up when there is room)   // (cost: milliseconds per moving thing per step, measured as it runs)
function physBudget() { return Math.max(30, Math.min(600, Math.floor(phys.bud / phys.busy))); }   // (shared between the worlds where a lot is moving)
function simTick() {
  const now = Date.now(), dtReal = Math.min(0.2, (now - simLast) / 1000); simLast = now;
  phys.busy = Math.max(1, phys.busyN); phys.busyN = 0;
  for (const room of rooms.values()) {
    const act = [...room.players.values()].filter(p => p.has && !p.dead && !p.hidden && p.ws.readyState === 1);
    if (act.length) room.aloneT = 0; else room.aloneT = (room.aloneT || 0) + dtReal;
    if (!act.length && !(room.world && room.world.nAct > 0 && room.aloneT < 30)) continue;   // (with nobody there, the world still runs until everything that was moving has come to rest, and never more than 30 seconds)
    const w = roomWorld(room), slot = rslot(room) & 0xFFFF;
    room.tk++;
    room.acc += dtReal;
    let n = 0; while (room.acc >= SIMDT && n < 12) { room.acc -= SIMDT; n++; }
    if (room.acc > SIMDT) room.acc = 0;
    for (const p of room.players.values()) if (!act.includes(p)) p.qx = undefined;
    if (n) {
      roomBots(room, w, dtReal);
      { const fo = [], seen = new Set(), add = (x, y) => { const k = Math.floor(x / 48) * 100003 + Math.floor(y / 48); if (seen.has(k)) return; seen.add(k); fo.push({ x, y }); };   // (where the players are, one point for each little square: a crowd standing together counts once)
        for (const p of act) add(p.x, p.y); if (room.bots) for (const bt of room.bots) if (!(bt.dead > 0)) add(bt.b.x, bt.b.y);
        w.focus = fo;
        if (!w.cand || room.tk - (w.candTk | 0) >= 2 || w.dyn.length !== w.candN || fo.length !== w.candF) {   // (the things near a player: worked out every other update, a little wider than needed so nobody outruns it)
          w.candTk = room.tk; w.candN = w.dyn.length; w.candF = fo.length; const R = 450, fc = new Map();
          for (const q of fo) { const c = Math.floor(q.x / R); for (let k = c - 1; k <= c + 1; k++) { let a = fc.get(k); if (!a) fc.set(k, a = []); a.push(q); } }
          w.cand = w.dyn.filter(d => { if (d.burn > 0) return false; const a = fc.get(Math.floor(d.x / R)); if (!a) return false; for (let i = 0; i < a.length; i++) if (Math.abs(d.x - a[i].x) < R && Math.abs(d.y - a[i].y) < R) return true; return false; });
        } else if (w.cand.length && w.cand.some(d => d.burn > 0)) w.cand = w.cand.filter(d => !(d.burn > 0));
      }
      const pbs = w.pbList || (w.pbList = []);
      for (let k = 0; k < n; k++) {
        pbs.length = 0; for (const p of act) { const o = p.pbo || (p.pbo = { x: 0, y: 0 }); o.x = p.x; o.y = p.y; pbs.push(o); }
        if (room.bots) for (const bt of room.bots) if (!(bt.dead > 0)) pbs.push(bt.b);   // (where the player really is: never the point carried on ahead for pushing, so nothing is moved by a player who has not reached it)
        w.pb = pbs;   // (every player's ball is solid to everything in the world: nothing is pushed or squeezed into it)
        w.dynBudget = physBudget(); const pt0 = performance.now();
        P.stepDyn(w, SIMDT);
        { const ms = performance.now() - pt0; health.physMs += ms; w.physFix = w.physFix === undefined ? ms : w.physFix; if (w.nAct < 8) w.physFix += (ms - w.physFix) * 0.05; else { if (w.nAct > 40) phys.cost += (Math.max(0.004, (ms - Math.min(w.physFix, ms * 0.8)) / w.nAct) - phys.cost) * 0.02; if (k === 0) phys.busyN++; } }   // (what each moving thing costs, apart from what the step costs anyway)
        if (room.bots && room.bots.length && (SIMDT > 1 / 100 || (room.tk + k) % 2)) stepRoomBots(room, w, SIMDT > 1 / 100 ? SIMDT : SIMDT * 2);   // (bots think and move 60 times a second)
        const list = [];
        for (const p of act) {   // each player is a point that moves smoothly along their path (never jumping through a crate between two updates)
          const a0 = (now - (p.tPos || now)) / 1000 + k * SIMDT, age = Math.min(0.12, a0), g = !!(p.st & 0x8000);   // (where the player is now, from their last word: their own screen already shows what they push moving, worked out there by the same physics)
          const tx = p.x + p.vx * age, ty = p.y + Math.min(0, p.vy) * age;   // (sideways it carries on along its path, and up when it is jumping; a fall is not carried on, so it is never sunk into the crate it is landing on)
          if (p.qx === undefined || Math.abs(tx - p.qx) > 220 || Math.abs(ty - p.qy) > 220) { p.qx = tx; p.qy = ty; }
          else {
            const lx = Math.max(2.5, Math.abs(p.vx) * SIMDT * 1.3), ly = Math.max(5, Math.abs(p.vy) * SIMDT * 2);   // (the point never runs ahead faster than the player really moves, so nothing is shoved faster than you push it)
            p.qx += Math.max(-lx, Math.min(lx, tx - p.qx)); p.qy += Math.max(-ly, Math.min(ly, ty - p.qy));
          }
          list.push({ x: p.qx, y: p.qy, vx: p.vx, vy: p.vy, ground: g, id: p.id, p });
        }
        for (const q of list) { const c = { x: q.x, y: q.y, vx: q.vx, vy: q.vy, ground: q.ground, kin: true, dt: SIMDT, own: q.id }; P.collideDyn(c, w); P.seeBody(c, w, P.PLAYER_WT); P.ropeBody(c, w, P.PLAYER_WT / 60); if (q.p) { q.p.qx = c.x; q.p.qy = c.y; } }   // (kin: a player is where they say they are; only the things they touch are moved)
        if (k === n - 1) P.stepSwitches(w, room.bots && room.bots.length ? list.concat(room.bots.filter(bt => !(bt.dead > 0)).map(bt => bt.b)) : list, SIMDT * n);   // (the buttons and plates are looked at once per update)
      }
      w.ev.length = 0;
    }
    if (w.lost && w.lost.length) {   // something a player built burned up in lava or fell out of the world: it is off the books, and whoever built it can build it again
      const B = bstate(room);
      for (const d of w.lost) { const i = B && d.brec ? B.props.indexOf(d.brec) : -1; if (i < 0) continue; owDel(B, 'p', B.props[i], d.ownTag); B.props.splice(i, 1); d.brec = null; broadcast(room, { t: 'pdel', g: ['b', d.uid], lost: 1 }); giveBack(room, d, null); }
      w.lost.length = 0;
    }
    if (room.tk % 3 === 0) sendBots(room);
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
      const kr = d.pr === undefined ? (d.av || 0) : ((d.rot || 0) - d.pr) / tickDt;
      const dm = d.px === undefined ? 99 : Math.abs(d.x - d.px) + Math.abs(d.y - d.py); d.px = d.x; d.py = d.y; d.pr = d.rot || 0;
      d.svx = Math.abs(d.vx - kx) > 30 ? kx : d.vx;   // (what it really did is sent: a pile held up by what is under it, or a crate pinned against another, keeps a speed in its own sums while not moving at all, and the others must not see it carry on)
      d.svy = Math.abs(d.vy - ky) > 30 ? ky : d.vy;
      d.sav = Math.abs((d.av || 0) - kr) > 0.5 ? kr : (d.av || 0);
      const still = !bn && ((Math.abs(d.svx) < 25 && Math.abs(d.svy) < 25) || dm < 0.4) && Math.abs(d.sav) < 0.3;
      const mv = !bn && (Math.abs(d.x - d.lx) + Math.abs(d.y - d.ly) + Math.abs(d.rot - d.lr) > 0.04 || still !== d.lst || (!still && (Math.abs(d.svx - d.lvx) + Math.abs(d.svy - d.lvy) > 60 || Math.abs(d.sav - (d.lav || 0)) > 0.5)));
      if (bn !== d.lb || mv) { d.ver = ++room.verN; chg.push(d); d.lx = d.x; d.ly = d.y; d.lr = d.rot; d.lb = bn; d.lst = still; d.lvx = d.svx; d.lvy = d.svy; d.lav = d.sav; }
    }
    // gates and triggers: tell everybody when any of them changes (and now and then anyway)
    const sig = doorSig(w);
    if (sig !== room.dsig || room.tk % 300 === 0) { room.dsig = sig; broadcast(room, doorPacket(room)); }
    // planks
    const planks = []; for (const s of w.see) if (Math.abs(s.ang - s.lang) > 0.0004 || room.tk % 300 === 0) { planks.push(s); s.lang = s.ang; }
    if (planks.length) plankSend(room, planks);
    // crates and balls: each player is told about what changed near them
    const resend = room.tk % 300 === 0;
    for (const p of room.players.values()) {
      if (!p.has || p.ws.readyState !== 1) continue;
      if (!p.dver) plankSend(room, w.see, p);   // (someone who has just arrived is told how every plank lies, along with everything else)
      if (!p.dver) { p.looked0 = false; if (p.pend) p.pend.clear(); }   // (a new look: they are told once it has all been sent)
      if (!p.dver || resend) { p.dver = new Map(); p.more = 1; }
      const full = p.more || room.fullAll || Math.abs(p.x - p.sx) >= 200 || Math.abs(p.y - p.sy) >= 200;
      const pend = p.pend || (p.pend = new Set()), lastS = p.lastS || (p.lastS = new Map());
      if (full) {   // (a full look: first time, every few seconds, or after moving far: everything around them that they do not have the latest word on yet)
        p.sv = room.verN; p.sx = p.x; p.sy = p.y; p.more = 0;
        for (let i = 0; i < w.dyn.length; i++) { const d = w.dyn[i]; if (p.dver.get(d.uid) === d.ver) continue; const bn = d.burn > 0, x = bn ? d.hx : d.x, y = bn ? d.hy : d.y; if (p.looked0 && (Math.abs(x - p.x) > 1900 || Math.abs(y - p.y) > 1500)) continue; pend.add(d); }   // (someone who has just arrived is told where everything in the whole world is, once: their map shows every crate and ball that was ever built, where it really lies, not only what is near them. After that they hear about what is around them)
      } else for (let i = 0; i < chg.length; i++) { const d = chg[i]; if (p.dver.get(d.uid) === d.ver) continue; if (!(d.burn > 0) && p.dver.has(d.uid) && (Math.abs(d.x - p.x) > 1900 || Math.abs(d.y - p.y) > 1500)) continue; pend.add(d); }   // (what is far away is told only now and then, enough for the map: every few seconds at most)
      if (!pend.size) { if (!p.looked0 && full) { p.looked0 = true; plankSend(room, w.see, p); p.ws.send('{"t":"ready"}'); } continue; }
      if (!p.looked0 ? false : room.tk % sendEvery()) continue;   // (30 times a second, which each device fills in smoothly; a server that cannot keep up halves that. A player who has just arrived gets everything as fast as it goes)
      // each moment only so much is sent (a slow connection is never flooded): what has waited longest and what is closest goes first, so nothing is ever left waiting while other things are told again and again. In between, each device carries everything on along its path, falling as it falls
      const cap = !p.looked0 || pend.size > 200 ? 200 : SEND_CAP; let out;
      if (pend.size <= cap) { out = [...pend]; pend.clear(); }
      else {
        const L = []; for (const d of pend) { const dx = Math.abs(d.x - p.x), dy = Math.abs(d.y - p.y), near = dx < 450 && dy < 350 ? 4 : dx < 900 && dy < 700 ? 2 : 1; const ls = lastS.get(d); d._sc = (ls === undefined ? 1e6 : room.tk - ls) * near; L.push(d); }
        L.sort((a, b) => b._sc - a._sc); out = L.slice(0, cap); for (const d of out) pend.delete(d);
      }
      if (out.length >= 90) p.more = 0;   // (a big first look: the device knows more is on its way while it gets 90 or more at a time)
      if (!p.looked0 && !pend.size) { p.looked0 = true; p.readyDue = true; }   // (everything around them has now been sent: they may come in)
      for (const d of out) lastS.set(d, room.tk);
      if (lastS.size > 4000) { for (const [d] of lastS) if (d.burn > 0 || Math.abs(d.x - p.x) > 2500) lastS.delete(d); }
      if (!out.length) continue;
      const buf = Buffer.allocUnsafe(8 + out.length * 23); buf[0] = 9; buf.writeUInt16LE(slot, 1); buf[3] = out.length; buf.writeUInt32LE(Date.now() % 4294967296, 4);   // (type 9: as type 6 (type 4, plus how fast each one is turning), plus the moment on the server it was true, so every device can replay the world's motion exactly as it happened)
      out.forEach((d, k) => {
        const o = 8 + k * 23, bn = d.burn > 0;
        buf.writeUInt32LE(d.uid >>> 0, o); buf.writeFloatLE(bn ? 0 : d.x, o + 4); buf.writeFloatLE(bn ? 0 : d.y, o + 8);
        const rest = bn || d.lst; buf.writeInt16LE(Math.max(-32000, Math.min(32000, Math.round(rest ? 0 : d.svx))), o + 12); buf.writeInt16LE(Math.max(-32000, Math.min(32000, Math.round(rest ? 0 : d.svy))), o + 14);
        buf.writeFloatLE(d.rot || 0, o + 16); buf[o + 20] = (bn ? 1 : 0) | (!bn && d.ownT > 0 && d.ownBy !== p.id && d.ownTouch ? 2 : 0);   /* (2: another player's device is moving this one right now) */ buf.writeInt16LE(Math.max(-32000, Math.min(32000, Math.round((bn || d.lst ? 0 : d.sav || 0) * 1000))), o + 21);
        p.dver.set(d.uid, d.ver);
      });
      p.ws.send(buf, { binary: true });
      if (p.readyDue) { p.readyDue = false; plankSend(room, w.see, p); p.ws.send('{"t":"ready"}'); }   // (planks told once more right before, so nothing is shown at an old angle)   // (the whole world around them has been sent: the loading screen can go)
    }
    chg.length = 0; room.fullAll = false;
  }
}

const okProp = q => (Array.isArray(q) && q.length === 3 && (q[0] | 0) >= 0 && (q[0] | 0) <= 7 && Number.isFinite(q[1]) && Number.isFinite(q[2]) ? [q[0] | 0, Math.round(q[1]), Math.round(q[2])] : null);
const okGate = q => (Array.isArray(q) && q.length === 5 && q.every(Number.isFinite) && q[2] >= 2 && q[2] <= 8 ? q.map(Math.round) : null);
const okMisc = q => (Array.isArray(q) && q.length === 4 && (q[0] === 'bnc' || q[0] === 'spr' || q[0] === 'lav' || q[0] === 'tl' || q[0] === 'pwr') && q.slice(1).every(Number.isFinite) ? [q[0], Math.round(q[1]), Math.round(q[2]), q[0] === 'pwr' ? (q[3] ? 1 : 0) : Math.round(q[3])] : Array.isArray(q) && q.length === 4 && (q[0] === 'see' || q[0] === 'pad') && q.slice(1).every(Number.isFinite) ? [q[0], Math.round(q[1]), Math.round(q[2]), q[3] < 0 ? -1 : q[3] > 0 ? 1 : 0] : (Array.isArray(q) && (q.length === 5 || q.length === 6) && q[0] === 'por' && q.slice(1).every(Number.isFinite) ? ['por', Math.round(q[1]), Math.round(q[2]), Math.round(q[3]), Math.round(q[4])].concat(q.length === 6 ? [Math.max(0, Math.min(3, Math.round(q[5])))] : []) : null));
const okDel = q => (Array.isArray(q) && (((q[0] === 'b' || q[0] === 's' || q[0] === 'g' || q[0] === 'r') && q.length === 2 && Number.isFinite(q[1]) && q[1] >= 0 && q[1] < 4294967296) || ((q[0] === 'pad' || q[0] === 'por' || q[0] === 'c' || q[0] === 'base' || q[0] === 'pwr') && q.length === 3 && Number.isFinite(q[1]) && Number.isFinite(q[2]))) ? (q.length === 2 ? [q[0], Math.round(q[1])] : [q[0], Math.round(q[1]), Math.round(q[2])]) : null);   // something removed with the delete tool
const okCp = q => (Array.isArray(q) && q.length === 2 && Number.isFinite(q[0]) && Number.isFinite(q[1]) ? [Math.round(q[0]), Math.round(q[1])] : null);
function send(p, obj) { if (p.ws.readyState === 1) p.ws.send(JSON.stringify(obj)); }
function bcastFrom(room, from, obj) {   // something said by one player: to everyone else in the world, except anyone who blocked them (or whom they blocked)
  const s = JSON.stringify(obj);
  for (const q of room.players.values()) if (q !== from && q.ws.readyState === 1 && !(from.pub && q.pub && blocked(from.pub, q.pub))) q.ws.send(s);
}
function broadcast(room, obj, except) {
  const s = JSON.stringify(obj);
  for (const p of room.players.values()) if (p !== except && p.ws.readyState === 1) p.ws.send(s);
}
function addOk(p) {   // building is rate-limited as a bucket (a burst of placements is fine, a flood is not): dropping one would leave this world and the builder's out of step
  const now = Date.now(); p.tok = Math.min(60, (p.tok === undefined ? 60 : p.tok) + (now - (p.tokT || now)) / 1000 * 25); p.tokT = now;   // (far more than anybody can build by hand: only a flood is ever turned away)
  if (p.tok < 1) return false; p.tok -= 1; return true;
}
const justLeft = new Map();
function siteFull(p) {   // is the whole site full? (somebody whose connection just dropped may always come back)
  if (p.room || online < MAX_TOTAL) return false;
  const t = p.pub && justLeft.get(p.pub); if (t && Date.now() - t < 45000) { justLeft.delete(p.pub); return false; }
  return true;
}
setInterval(() => { const t = Date.now(); for (const [k, v] of justLeft) if (t - v > 45000) justLeft.delete(k); }, 30000).unref();
function leave(p, toLobby) {
  const room = p.room;
  if (!room && !p.lobby) return;
  if (room && room.priv && room.priv.owner === p.id) {
    if (toLobby || p.bye || room.players.size <= 1) {   // the host left the game, or closed it: the world closes and everyone in it goes back to their own
      for (const o of [...room.players.values()]) if (o !== p) { send(o, { t: 'pclose', name: p.name }); leave(o, true); }
    } else { room.priv.owner = null; room.priv.away = Date.now(); broadcast(room, { t: 'hostaway', name: p.name }, p); }   // (only their connection dropped: a screen turned off, a network that came and went. The world stays open for a while, and they come straight back into it)
  }
  if (room) {
    p.room = null;
    online--; statsDirty = true;
    if (p.pub && !toLobby && !p.bye) justLeft.set(p.pub, Date.now());   // (a dropped connection: their place is kept for them for a little while)
    room.players.delete(p.id);
    if (!room.priv && room.players.size === 0) { try { keepWorlds(false); } catch (e) {} }   // (the last one out: the world is written down right now, exactly as they left it)
    for (const o of room.players.values()) o.vis.delete(p.id);
    if (room.players.size === 0) { if (room.priv) rooms.delete(room.id); else room.emptyAt = Date.now(); }   // (a public world is kept for a while after the last player leaves, so a dropped connection or a closed tab does not rebuild everything you knocked down)
    else broadcast(room, { t: 'leave', id: p.id, name: p.name, pub: p.pub, n: room.players.size });
  }
  if (p.pub && known.has(p.pub)) { known.get(p.pub).last = Date.now(); knownDirty = true; }
  if (toLobby) {   // back to the main menu: still connected, just not in any world
    p.lobby = true; p.has = false; p.moved = false; p.vis = new Set();
    if (p.pub) for (const b of (links.get(p.pub) || [])) { const q = byPub.get(b); if (q) sendLinks(q); }
    return;
  }
  p.lobby = false;
  if (p.pub && byPub.get(p.pub) === p) { byPub.delete(p.pub); const hid = !shareOf(p.pub).on; for (const b of (links.get(p.pub) || [])) { const q = byPub.get(b); if (q) { if (!hid) send(q, { t: 'loff', pub: p.pub, name: p.name }); sendLinks(q); } } }
}

const ipCount = new Map();
wss.on('connection', (ws, req) => {
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || '?';
  const c = (ipCount.get(ip) || 0) + 1;
  if (c > MAX_PER_IP) { ws.close(1013, 'busy'); return; }
  ipCount.set(ip, c);
  { const os = ws.send.bind(ws); ws.send = (d, o, cb) => { useOut((d && (d.length !== undefined ? (typeof d === 'string' ? Buffer.byteLength(d) : d.length) : 0)) + 8); return os(d, o, cb); }; }   // (every byte sent out counts toward the month's data)

  const p = { id: nextId++, ws, name: '', color: '#ff4d4d', color2: '#ffffff', pat: 0, x: 0, y: 0, vx: 0, vy: 0, st: 0, dead: 0, has: false, moved: false, vis: new Set(), room: null, fin: -1, msgs: 0, pub: '', lastReq: 0, lastFind: 0, lastEmo: 0, rtt: 0, pingAt: 0, pn: 0, press: 0 };
  try { ws._socket.setNoDelay(true); } catch (e) {}
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; if (p.pingAt) { const r = Math.min(1500, Date.now() - p.pingAt); p.rtt = p.rtt ? p.rtt * 0.7 + r * 0.3 : r; p.pingAt = 0; } });
  const rate = setInterval(() => { p.msgs = 0; if (p.room && !p.pingAt && ++p.pn % 2 === 0) { p.pingAt = Date.now(); try { ws.ping(); } catch (e) {} } else if (p.pingAt && Date.now() - p.pingAt > 3000) p.pingAt = 0; }, 1000);   // (how long a message takes there and back, so what they push is pushed where they really are)

  ws.on('message', (raw, isBinary) => {
    useIn((raw && raw.length || 0) + 8);
    p.lastMsg = Date.now();
    if (++p.msgs > 200) return;                       // simple flood protection (positions alone can be 60 a second)
    if (isBinary) {                                   // a position update: [0x70][slot u16][x/2 u16][y u16 (65535 = dead)][vx/5 i8][vy/20 i8][time u15 | grounded<<15]
      if (!p.room || (raw.length < 11 || raw.length > 13) || raw[0] !== 0x70 || raw.readUInt16LE(1) !== (rslot(p.room) & 0xFFFF)) return;
      const x = Math.min(131000, raw.readUInt16LE(3) * 2) - P.POFF, yr = raw.readUInt16LE(5), d = yr === 65535 ? 1 : 0;   // (shifted: see P.POFF)
      const y = d ? p.y : Math.min(65533, yr) - P.POFF, vx = raw.readInt8(7) * 5, vy = raw.readInt8(8) * 20, st = raw.readUInt16LE(9);
      if (p.moved && p.has && !p.dead && !d && p.st !== st) { const h = p.hist || (p.hist = []); if (h.length < 16) h.push([p.x, p.y, p.vx, p.vy, p.st]); }   // (several updates came in at once, after a hiccup on their connection: the ones in between are passed on too, so everyone still sees the whole path of a jump)
      if (p.x !== x || p.y !== y || p.dead !== d || p.vx !== vx || p.vy !== vy || p.st !== st || !p.has) p.moved = true;
      p.x = x; p.y = y; p.dead = d; p.vx = d ? 0 : vx; p.vy = d ? 0 : vy; p.st = st; p.has = true; if (p.pub && !p.playedMark) { if (!p.firstPos) p.firstPos = Date.now(); else if (Date.now() - p.firstPos > 1500) { p.playedMark = true; const k = known.get(p.pub); if (k && !k.played) { k.played = 1; linksDirty = true; } } }   // (in the game for a moment or two: from now on they can always be found and invited)
      { const now = Date.now(), c15 = st & 0x7FFF; p.cU = p.cU === undefined ? c15 : p.cU + ((c15 - (p.cU & 0x7FFF)) & 0x7FFF); const off = now - p.cU; if (p.cOff === undefined || off < p.cOff || off > p.cOff + 2000) p.cOff = off; else p.cOff += 0.05; p.tPos = Math.min(now, p.cU + p.cOff); }   // (when this was true on their device, on this clock: an update held up on the way is carried on further, so their point never lurches back when updates come bunched)
      p.press = !d && raw.length >= 12 && (raw[11] & 1) ? 1 : 0; p.pv = !d && raw.length >= 12 && (raw[11] & 2) ? 1 : 0; p.rvx = d ? 0 : raw.length === 13 ? raw.readInt8(12) * 5 : p.pv ? 0 : vx;   // (rvx: how fast they really move, which is what everybody else is shown)   // (pv: the speed is how hard they push against something that holds them, not how fast they move)
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
      const capped = !m.lobby && siteFull(p);   // (everybody who can play at once is playing: they wait on the main menu, still connected, and get in as soon as somebody leaves)
      const lobby = m.lobby || capped ? 1 : 0, wasOn = p.lobby;   // lobby: the player is only on the main menu. Connected for friends, but not in any world and nobody sees them
      p.color = cleanColor(m.color, '#ff4d4d'); p.color2 = cleanColor(m.color2, '#ffffff'); p.pat = cleanPat(m.pat);
      if (typeof m.dev === 'string' && DEV.test(m.dev)) { p.pub = pubOf(m.dev); p.otag = P.hash32('o:' + m.dev) & 0xffffff; }   // (otag: whose base is whose, the same number the player's device works out)
      let fr = null, room = null, priv = null;
      if (!lobby && m.host && typeof m.host === 'object') {   // open a world of your own for friends: your solo level and what you built on it
        if (!p.pub) { send(p, { t: 'jno', why: 'nodev' }); return; }
        const key = privKey(p.pub), lv = m.host.m | 0;
        const hr0 = rooms.get(key);
        if (hr0 && hr0.priv && hr0.priv.away && hr0.priv.hostPub === p.pub) { hr0.priv.owner = p.id; hr0.priv.away = 0; hr0.priv.back = 1; hr0.botsOn = !!m.host.bots; hr0.noCheats = !!m.host.nc; room = hr0; p.room = room; fr = { full: [] }; broadcast(room, { t: 'hostback', name: p.name }); }   // the host is back after their connection dropped: their world was kept open for everyone in it
        else if (hr0) { send(p, { t: 'jno', why: 'busy' }); return; }
        else {
        if (privFull()) { send(p, { t: 'jno', why: 'load' }); return; }   // (too many private games for this server to run well: the public world and offline games are still there)
        const props = [], gates = [], misc = [], cps = [], dels = [];   // (what the host built arrives right after, in small pieces)
        room = { id: key, players: new Map(), finishers: [], fk: Math.max(0, Math.min((genMap(Math.max(0, Math.min(maps.count - 1, lv))).fins || [1]).length - 1, m.host.fk | 0)), botsOn: !!m.host.bots, noCheats: !!m.host.nc, priv: { hostTag: p.otag >>> 0, at: Date.now(), owner: p.id, hostPub: p.pub, slot: PRIV_BASE + Math.max(0, Math.min(maps.count - 1, lv)), idx: Math.max(0, Math.min(maps.count - 1, lv)), props, cps, gates, misc, dels, invited: new Set(), keep: new Set(), once: new Set() } };
        rooms.set(key, room); p.room = room; fr = { full: [] };
        }
      } else if (!lobby && typeof m.join === 'string' && PUB.test(m.join)) {   // go to a friend's world
        const hr = rooms.get(privKey(m.join));
        if (!hr || !hr.priv) { send(p, { t: 'jno', why: 'gone' }); return; }
        if (!p.pub || !(hr.priv.invited.has(p.pub) || linkSet(p.pub).has(m.join))) { send(p, { t: 'jno', why: 'nope' }); return; }
        if (hr.players.size >= PRIV_MAX) { send(p, { t: 'jno', why: 'full' }); return; }
        room = hr; p.room = room; fr = { full: [] };
      } else if (!lobby && Number.isInteger(m.pw) && m.pw > 0 && rooms.get(m.pw) && !rooms.get(m.pw).priv && rooms.get(m.pw).players.size < MAX_PLAYERS) {   // a friend's public world, picked from their profile (if it is full, the usual world instead)
        room = rooms.get(m.pw); p.room = room; fr = { full: [] };
      } else if (!lobby) { fr = findRoom(); room = fr.room; p.room = room; }
      p.lobby = lobby;
      if (capped) send(p, { t: 'cap', n: online, max: MAX_TOTAL });
      let nm = cleanName(m.name);
      if (!nm && !lobby) nm = (p.pub && known.get(p.pub) && known.get(p.pub).name) || randomName();   // everybody has a name once they play
      if (!nm && lobby) nm = (p.pub && known.get(p.pub) && known.get(p.pub).name) || '';          // (a brand-new visitor on the menu has not picked one yet: that first pick stays free)
      const nameLeft = setName(p, nm);
      if (p.pub) { const k = known.get(p.pub); k.color = p.color; k.color2 = p.color2; k.pat = p.pat | 0; k.last = Date.now(); if (m.beat != null) k.beat = Math.max(0, Math.min(999, m.beat | 0)); knownDirty = true; }
      if (room) {
        room.players.set(p.id, p);
        const myFin = p.pub && room.finPub && room.finPub.get(p.pub);   // (finished this round already, then left and came back: the crown and the place are still theirs)
        if (myFin && !room.priv) { p.fin = rslot(room); room.finishers[myFin - 1] = p.id; }
        online++; statsDirty = true;
        if (online > peak) { peak = online; peakDirty = true; }
        if (online > usage.pkPl) { usage.pkPl = online; usage.pkPlAt = Date.now(); }
        send(p, {
          t: 'welcome', id: p.id, room: room.id, mine: myFin && !room.priv ? myFin : 0, n: room.players.size, max: MAX_PLAYERS, full: fr.full, fresh: roomFresh(room) ? 1 : 0,
          name: p.name, code: p.pub ? codeOf(p.pub) : '', nameLeft, slot: rslot(room), fk: room.fk | 0, next: room.priv ? Date.now() + 3e11 : nextAt(curSlot), now: Date.now(), online, peak,
          build: room.priv ? undefined : bstate(room), priv: room.priv ? { back: room.priv.owner === p.id && room.priv.back ? 1 : 0, host: room.priv.owner === p.id ? 1 : 0, idx: room.priv.idx, props: room.priv.props, cps: room.priv.cps, gates: room.priv.gates, misc: room.priv.misc, dels: room.priv.dels, ow: owBook(room.priv), hostName: (byPub.get(room.priv.hostPub) || {}).name || '', hostPub: room.priv.hostPub, nc: room.noCheats ? 1 : 0 } : undefined,
          players: [...room.players.values()].filter(o => o !== p).map(o => ({ id: o.id, pub: o.pub, ot: o.otag || 0, code: o.pub ? codeOf(o.pub) : '', name: o.name, color: o.color, color2: o.color2, pat: o.pat, crown: o.fin === rslot(room) ? Math.max(1, room.finishers.indexOf(o.id) + 1) : 0 }))   // (crown: what place they finished in)
        });
        p.dver = null; if (room.world) { send(p, doorPacket(room)); plankSend(room, room.world.see, p); }
        if (room.bots && room.bots.length) send(p, { t: 'bj', b: room.bots.map(botInfo) });
        if (room.botTl && room.botTl.size) for (const q of room.botTl.values()) send(p, { t: 'pobj', g: q, bot: 1, bulk: 1 });
        broadcast(room, { t: 'join', id: p.id, pub: p.pub, ot: p.otag || 0, code: p.pub ? codeOf(p.pub) : '', name: p.name, color: p.color, color2: p.color2, pat: p.pat, n: room.players.size, crown: myFin && !room.priv ? myFin : 0 }, p);
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
          if (cv && cv.has(p.pub) && !blocked(p.pub, v) && linkSet(p.pub).size < MAX_LINKS && linkSet(v).size < MAX_LINKS) addLink(p.pub, v);
        }
        if (removed.length) send(p, { t: 'unl', gone: removed });
        sendLinks(p);
        rooms.forEach(r => { if (r.priv && (r.priv.keep.has(p.pub) || r.priv.once.has(p.pub)) && r !== p.room) { r.priv.once.delete(p.pub); send(p, { t: 'inv', pub: r.priv.hostPub, name: (byPub.get(r.priv.hostPub) || {}).name || '', idx: r.priv.idx }); } });   // an invite that came while you were away (one that was sent as 'ask once' is only shown the first time)
        { const hid = !shareOf(p.pub).on; for (const b of linkSet(p.pub)) { const q = byPub.get(b); if (live(q)) { sendLinks(q); if (!wasOn && !hid) send(q, { t: 'lon', pub: p.pub, name: p.name }); } if (!wasOn && p.name && !hid) pushTo(b, 'f', [p.name + ' is online', 'Jump in and play together'], 'on-' + p.pub, p.pub); } }   // (somebody who keeps their online status to themselves comes and goes quietly)
        sendMe(p);
        { const nl = news.get(p.pub); if (nl && nl.length) send(p, { t: 'tres', list: nl.map(x => { const pi = peerInfo(x.p); return { pub: x.p, code: pi.code, name: pi.name, ok: x.ok, t: x.t }; }) }); }   // answers to your requests that came while you were away
        { const out = []; pend.forEach((v, k) => { if (k.slice(0, 16) === p.pub) { const to = k.slice(17), pi = peerInfo(to); out.push({ pub: to, code: pi.code, name: pi.name, t: v.t }); } }); send(p, { t: 'tout', list: out }); }   // requests you sent that nobody has answered yet
        sendShares(p);   // (maps friends shared with you while you were away)
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
    if (m.t === 'lobby') { if (p.room) leave(p, true); return; }
    if (m.t === 'bye') { p.bye = true; return; }   // (the page is being closed for good, not just put away)   // back to the main menu: leave the world, stay connected

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
      bcastFrom(p.room, p, { t: 'emo', id: p.id, pub: p.pub, name: p.name, i });
      if (p.room.bots && p.room.bots.length) { const k = P.askKind('emo', i); if (k) roomCtx(p.room).asks.push({ kind: k, x: p.x, y: p.y, id: p.id }); }
    } else if (m.t === 'say') {   // a message built from a sentence and a pick-list: two small numbers, so nothing can be typed
      if (!p.room) return;
      const a = m.a | 0, b = m.b | 0, now = Date.now();
      if (a < 0 || a >= 16 || b < 0 || b >= 40 || now - p.lastEmo < 900) return;
      p.lastEmo = now;
      bcastFrom(p.room, p, { t: 'say', id: p.id, pub: p.pub, name: p.name, a, b });
      if (p.room.bots && p.room.bots.length) { const k = P.askKind('say', a, b); if (k) roomCtx(p.room).asks.push({ kind: k, x: p.x, y: p.y, id: p.id }); }
    } else if (m.t === 'shup') {   // sharing one of your maps with friends: it comes in parts, then it is kept for each friend you picked
      if (!p.pub || typeof m.sid !== 'string' || !/^[a-z0-9]{6,16}$/.test(m.sid) || !Number.isFinite(m.n) || !Number.isFinite(m.i) || m.n < 1 || m.n > 30 || m.i < 0 || m.i >= m.n || typeof m.c !== 'string') return;
      const up = p.shUp || (p.shUp = {}); let u = up[m.sid];
      if (!u) { if (Object.keys(up).length >= 3) return; u = up[m.sid] = { n: m.n | 0, a: [], size: 0 }; }
      if (u.n !== (m.n | 0) || u.a[m.i | 0] !== undefined) return; u.size += m.c.length; if (u.size > SHARE_MAX) { delete up[m.sid]; send(p, { t: 'shno', why: 'big' }); return; }
      u.a[m.i | 0] = m.c; if (u.a.filter(x => typeof x === 'string').length < u.n) return;
      delete up[m.sid];
      const str = u.a.join(''); let o = null; try { o = JSON.parse(str); } catch (e) {}
      const to = Array.isArray(m.to) ? [...new Set(m.to.filter(x => typeof x === 'string' && PUB.test(x) && x !== p.pub))].slice(0, 50) : [];
      const idx = m.idx | 0;
      if (!o || typeof o !== 'object' || !o.o || typeof o.o !== 'object' || !Array.isArray(o.o.buys) || idx < 0 || idx >= maps.count || (o.idx | 0) !== idx || !to.length) { send(p, { t: 'shno', why: 'bad' }); return; }
      let total = 0; for (const v of shares.values()) total += v.data.length;
      const now = Date.now(), nThings = (o.o.buys.length | 0) + ((o.o.gates || []).length | 0) + ((o.o.misc || []).length | 0) + ((o.o.cps || []).length | 0); let sent = 0;
      for (const t of to) {
        if (!linkSet(p.pub).has(t) || blocked(p.pub, t)) continue;
        for (const [id, v] of shares) if (v.from === p.pub && v.to === t && v.idx === idx) shares.delete(id);   // (a newer version of the same map replaces the one still waiting)
        const mine = [...shares.values()].filter(v => v.to === t).sort((a, b) => a.t - b.t); while (mine.length >= SHARE_PER_TO) shares.delete(mine.shift().id);
        if (total + str.length > SHARE_ALL) { const all = [...shares.values()].sort((a, b) => a.t - b.t); while (all.length && total + str.length > SHARE_ALL) { const x = all.shift(); total -= x.data.length; shares.delete(x.id); } }
        const id = crypto.randomBytes(8).toString('hex'), v = { id, from: p.pub, fromName: p.name || '', to: t, idx, n: nThings, data: str, t: now };
        shares.set(id, v); total += str.length; sent++;
        const q = byPub.get(t); if (live(q)) send(q, { t: 'shr', list: [shareMeta(v)] });
        pushTo(t, 'i', [(p.name || 'A friend') + ' shared a map with you', 'Open ballpit.party to save it'], 'shr-' + p.pub + '-' + idx);
      }
      sharesDirty = true; saveShares();
      send(p, { t: 'shsent', n: sent, idx });
    } else if (m.t === 'shget') {   // the friend it was shared with wants it: it comes in parts
      const v = typeof m.id === 'string' ? shares.get(m.id) : null; if (!v || v.to !== p.pub || blocked(v.from, v.to)) { send(p, { t: 'shgone', id: m.id }); return; }
      const now = Date.now(); if (now - (p.lastShGet || 0) < 1500) return; p.lastShGet = now;
      const CH = 60000, n = Math.max(1, Math.ceil(v.data.length / CH));
      for (let i = 0; i < n; i++) send(p, { t: 'shd', id: v.id, n, i, c: v.data.slice(i * CH, (i + 1) * CH) });
    } else if (m.t === 'shans') {   // saved it or discarded it: either way it is done, and the one who shared it is told
      const v = typeof m.id === 'string' ? shares.get(m.id) : null; if (!v || v.to !== p.pub) return;
      shares.delete(v.id); sharesDirty = true; saveShares();
      const q = byPub.get(v.from); if (live(q) && !blocked(v.from, v.to)) send(q, { t: 'shres', pub: p.pub, name: p.name || '', idx: v.idx, ok: m.ok ? 1 : 0 });
    } else if (m.t === 'ask') {   // asking a friend in a private game if you can join them: they get a pop-up (the one who made the game can invite you)
      const now = Date.now(); if (now - (p.lastAsk || 0) < 3000) return; p.lastAsk = now;
      if (!p.pub || typeof m.to !== 'string' || !PUB.test(m.to) || !linkSet(p.pub).has(m.to) || blocked(p.pub, m.to)) return;
      const q = byPub.get(m.to);
      if (!live(q) || !q.room || !q.room.priv) { send(p, { t: 'askno', pub: m.to }); return; }
      send(q, { t: 'ask', pub: p.pub, name: p.name, own: q.room.priv.owner === q.id ? 1 : 0 }); send(p, { t: 'asksent', pub: m.to });
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
      const host = !!(r.priv && r.priv.owner === p.id), ow = {};   // (whose each one is: the builder's own, or, from the host of a private world, whoever the host's world says built it)
      const take = (key, arr, ok, cap) => { if (!Array.isArray(m[key])) return; const out = [], os = [], given = host && m.ow && Array.isArray(m.ow[key]) ? m.ow[key] : null; m[key].slice(0, 25).forEach((q, i) => { const c = ok(q); if (c && arr.length < cap) { const t = given && Number.isFinite(given[i]) ? given[i] >>> 0 : p.otag >>> 0; arr.push(c); owAdd(B, P.BOOK_K[key], c, t); out.push(c); os.push(t); } }); if (out.length) { e[key] = out; ow[key] = os; } };
      take('props', B.props, okProp, ROOM_PROPS); take('gates', B.gates, okGate, ROOM_GATES); take('misc', B.misc, okMisc, ROOM_MISC); take('cps', B.cps, okCp, ROOM_CPS); take('dels', B.dels, okDel, ROOM_DELS);
      (e.props || []).forEach(q => worldAdd.prop(r, q, true)); (e.gates || []).forEach(q => worldAdd.gate(r, q)); (e.misc || []).forEach(q => worldAdd.misc(r, q)); (e.dels || []).forEach(q => worldAdd.del(r, q));
      if (Object.keys(e).length) { e.ow = ow; e.t = 'pb'; broadcast(r, e, p); }
    } else if (m.t === 'pobj') {   // a teeter-totter or a floor booster, built in a friend's world
      const r = p.room; if (!bstate(p.room) || !Array.isArray(m.g) || !((m.g.length === 4 && (m.g[0] === 'base' || m.g[0] === 'see' || m.g[0] === 'pad' || m.g[0] === 'bnc' || m.g[0] === 'spr' || m.g[0] === 'lav' || m.g[0] === 'tl' || m.g[0] === 'pwr')) || (m.g.length === 5 && (m.g[0] === 'por' || m.g[0] === 'rope')) || (m.g.length === 6 && m.g[0] === 'por')) || !m.g.slice(1).every(Number.isFinite) || bstate(r).misc.length >= ROOM_MISC || ((m.g[0] === 'see' || m.g[0] === 'por' || m.g[0] === 'rope') && bstate(r).misc.filter(q => q[0] === m.g[0]).length >= 80) || (m.g[0] === 'rope' && !P.ropeOk(roomWorld(r), m.g))) return;
      if (!addOk(p)) return;
      if (m.g[0] === 'tl') {   // one record per tile: a newer change replaces the older one, and -1 means the tile is back the way the map made it, so there is nothing to keep
        const put = (tx, ty, to) => {
          if (r.world && bLock(r.world, (tx + 0.5) * P.TS, (ty + 0.5) * P.TS, p.otag)) return null;   // (somebody else's base)
          const mb = bstate(r).misc;
          for (let k = mb.length - 1; k >= 0; k--) if (mb[k][0] === 'tl' && mb[k][1] === tx && mb[k][2] === ty) { owDel(bstate(r), 'm', mb[k]); mb.splice(k, 1); }
          if (to === -1) { worldAdd.misc(r, ['tl', tx, ty, -1]); return [tx, ty, -1]; }
          if (![0, 1, 2, 3, 5, 7].includes(to) || mb.length >= ROOM_MISC) return null;
          if (r.world && P.gadgetTile(r.world, tx, ty)) return null;   // (nothing buried, nothing left floating: the same rule every device uses)
          const e = ['tl', tx, ty, to]; mb.push(e); owAdd(bstate(r), 'm', e, p.otag >>> 0); worldAdd.misc(r, e); return [tx, ty, to];
        };
        const g0 = put(Math.round(m.g[1]), Math.round(m.g[2]), Math.round(m.g[3])), ex = [];
        if (Array.isArray(m.ex)) for (const q of m.ex.slice(0, 48)) if (Array.isArray(q) && q.length === 3 && q.every(Number.isFinite)) { const c = put(Math.round(q[0]), Math.round(q[1]), Math.round(q[2])); if (c) ex.push(c); }
        if (g0) broadcast(r, { t: 'pobj', g: ['tl', g0[0], g0[1], g0[2]], ex, o: p.otag >>> 0 }, p);
        if (g0 && r.bots && r.bots.length && (g0[2] === 1 || g0[2] === 3)) roomCtx(r).builds.push({ x: g0[0], y: g0[1] });
        return;
      }
      const e = m.g[0] === 'pwr' ? ['pwr', Math.round(m.g[1]), Math.round(m.g[2]), m.g[3] ? 1 : 0] : (m.g[0] === 'bnc' || m.g[0] === 'spr' || m.g[0] === 'lav' || m.g[0] === 'tl') ? [m.g[0], Math.round(m.g[1]), Math.round(m.g[2]), Math.round(m.g[3])] : m.g[0] === 'por' || m.g[0] === 'rope' ? [m.g[0], Math.round(m.g[1]), Math.round(m.g[2]), Math.round(m.g[3]), Math.round(m.g[4])].concat(m.g[0] === 'por' && m.g.length === 6 ? [Math.max(0, Math.min(3, Math.round(m.g[5])))] : []) : [m.g[0], Math.round(m.g[1]), Math.round(m.g[2]), m.g[3] < 0 ? -1 : m.g[3] > 0 ? 1 : 0];
      if (e[0] === 'base') { e[3] = p.otag >>> 0 || 0; }   // (a base is always the builder's own)
      if (e[0] === 'base' && (!p.otag || bstate(r).misc.some(x => x[0] === 'base' && (x[3] >>> 0) === (e[3] >>> 0)))) return;
      if (e[0] === 'base' && roomWorld(r)) {   // on dirt or ice, and nothing of anybody else's in the circle (it is not a clearing tool)
        const w = r.world, B = bstate(r), mo = r.mown || new Map(), hostT = r.priv && r.priv.hostTag;
        const mine = (k, q) => { if (q.mm) return false; if (k === 'b') return !q.brec ? false : (q.ownTag === undefined ? true : (q.ownTag >>> 0) === (p.otag >>> 0));
          const key = k === 'c' ? 'c,' + q[0] + ',' + q[1] : null; const t = key ? mo.get(key) : undefined; return t === undefined ? true : (t >>> 0) === (p.otag >>> 0); };
        const why = !P.baseGround(w, e[1], e[2]) ? 'ground' : P.baseClear(w, e[1], e[2], mine, B.cps);
        if (why) { send(p, { t: 'baseno', why }); p.rsAt = Date.now(); p.dver = null; p.sbh = p.sdh = null; send(p, { t: 'rebuild', rs: 1, priv: r.priv ? 1 : 0, b: bOut(B) }); return; }
      }
      if (e[0] === 'pwr' && roomWorld(r) && (P.zoneP(r.world.map, (e[1] + 0.5) * P.TS, (e[2] + 0.5) * P.TS, 0) || (r.world.pwrs || []).some(q => !q.gone && Math.abs(q.tx - e[1]) < 2 && Math.abs(q.ty - e[2]) < 2))) return;   // (a power-up: not in the circles at the start or the finish, not on top of another)
      if (e[0] !== 'base' && e[0] !== 'tl' && roomWorld(r) && bLock(r.world, (e[1] + (e[0] === 'pwr' ? 0.5 : 1)) * P.TS, (e[2] + (e[0] === 'pwr' ? 0.5 : 0)) * P.TS, p.otag)) { const B = bstate(r); p.rsAt = Date.now(); p.dver = null; p.sbh = p.sdh = null; send(p, { t: 'rebuild', rs: 1, priv: r.priv ? 1 : 0, b: bOut(B) }); return; }   // (somebody else's base: only they build there)
      if (roomWorld(r) && (((e[0] === 'see' || e[0] === 'pad') && P.miscClash(r.world, e)) || (e[0] === 'base' && !P.baseOk(r.world, e[1], e[2], e[3])))) {   // (somebody else's is already there: this device gets the world as it really is, so nobody is ever left with a different one)
        const B = bstate(r); p.rsAt = Date.now(); p.dver = null; p.sbh = p.sdh = null; send(p, { t: 'rebuild', rs: 1, priv: r.priv ? 1 : 0, b: bOut(B) }); return;
      }
      if (e[0] === 'por' || e[0] === 'pad' || e[0] === 'base' || e[0] === 'pwr') { const B = bstate(r); owDiff(B, () => P.addCancel(B, e[0], e[1], e[2])); }
      bstate(r).misc.push(e); owAdd(bstate(r), 'm', e, p.otag >>> 0); worldAdd.misc(r, e); broadcast(r, { t: 'pobj', g: e, o: p.otag >>> 0 }, p); (r.mown || (r.mown = new Map())).set(mkey(e), p.otag >>> 0);
    } else if (m.t === 'own') {   // a player's device says where the things it is pushing are: the server takes its word, unless somebody else is right there too
      const r = p.room; if (!r || !r.world || m.s !== rslot(r)) return;
      const w = r.world;   // (the first device to take something has it until it lets go; everyone else sees it as theirs)
      if (Array.isArray(m.pl)) for (const q of m.pl.slice(0, 4)) {   // a teeter-totter this player is on: their device turns it, and the server follows
        if (!Array.isArray(q) || q.length !== 3 || !q.every(Number.isFinite)) continue;
        const s = w.see.find(e => e.uid === (q[0] >>> 0) && !e.gone); if (!s || (s.ownT > 0 && s.ownBy !== p.id) || Math.abs(s.cx - p.x) > s.hl + 400 || Math.abs(s.cy - p.y) > s.hl + 400) continue;
        s.ang = Math.max(-0.36, Math.min(0.36, q[1])); s.av = Math.max(-12, Math.min(12, q[2])); s.ownT = 1.0; s.ownBy = p.id; s.moving = 0.5;
      }
      if (Array.isArray(m.lost)) for (const q of m.lost.slice(0, 12)) {   // something this player's device was moving fell into lava, off the map or into the start: it is gone for everyone
        if (!Array.isArray(q) || q.length !== 3 || !q.every(Number.isFinite)) continue;
        const d = w.dynBy.get(q[0] >>> 0); if (!d || d.gone || d.burn > 0 || (d.ownT > 0 && d.ownBy !== p.id) || Math.abs(d.x - q[1]) + Math.abs(d.y - q[2]) > 600) continue;
        d.burn = 1e9; d.x = d.y = -99999; d.vx = d.vy = 0; d.av = 0; d.ownT = 0; d.nap = false;
      }
      if (!Array.isArray(m.b)) return;
      for (const q of m.b.slice(0, 12)) {
        if (!Array.isArray(q) || (q.length !== 7 && q.length !== 8) || !q.every(Number.isFinite)) continue;
        const d = w.dynBy.get(q[0] >>> 0); if (!d || d.gone || d.burn > 0) continue;
        const again = d.ownBy === p.id && !(d.ownT > 0) && d.ownLeft !== undefined && Date.now() - d.ownLeft < 6000;   // (the one who was moving it, back after their connection stalled: their picture is still the right one)
        if (Math.abs(q[1] - d.x) + Math.abs(q[2] - d.y) > ((d.ownT > 0 && d.ownBy === p.id) || again ? 900 : 400) || q[1] < -P.OOB * P.TS || q[1] > (w.W + P.OOB) * P.TS || q[2] < -P.OOB * P.TS || q[2] > w.H * P.TS) continue;
        if (d.ownT > 0 && d.ownBy !== p.id && d.ownTouch) continue;   // (somebody else is pushing it right now; once they only set it going, anyone may take it over)
        if (!(d.ownT > 0) && !again && Math.abs(q[1] - d.x) + Math.abs(q[2] - d.y) > 150 + Math.max(Math.abs(d.vx) + Math.abs(d.vy), Math.abs(q[3]) + Math.abs(q[4])) * 0.45) continue;   // (taking something over starts from where it really is: a device whose picture of it is far off is not believed, and gives in to the server's)
        if (w.see.length && P.plankCross(w, d.x, d.y, q[1], q[2], d.r || Math.max(d.hw, d.hh))) continue;   // (never taken through a teeter-totter: the two devices must have seen the plank differently, and the server's side of it stands)
        d.x = q[1]; d.y = q[2]; d.vx = Math.max(-1400, Math.min(1400, q[3])); d.vy = Math.max(-1400, Math.min(1400, q[4])); d.rot = q[5]; d.av = Math.max(-28, Math.min(28, q[6])); d.ownBy = p.id; d.ownT = 1.2; d.ownLeft = Date.now(); d.ownTouch = q.length === 8 ? (q[7] ? 1 : 0) : 1; d.nap = false; d.st = 0;   // (held for a moment longer than the gap between two reports, so a short stall on a bad connection never hands it back half-way)
      }
    } else if (m.t === 'resync') {   // this device noticed its world is not the same as the server's: it gets the whole of it again
      const r = p.room, B = r && bstate(r); if (!B) return; const now = Date.now(); if (now - (p.rsAt || 0) < 15000) return; p.rsAt = now;
      p.dver = null; p.sbh = p.sdh = null; send(p, { t: 'rebuild', rs: 1, priv: r.priv ? 1 : 0, b: bOut(B) });
    } else if (m.t === 'hbuild') {   // the host's own world, all of it at once (in parts of up to 50 KB): everything built, dug and deleted in it, so everybody who comes in sees exactly that world
      const r = p.room; if (!r || !r.priv || r.priv.owner !== p.id || !Number.isFinite(m.n) || !Number.isFinite(m.i) || m.n < 1 || m.n > 40 || m.i < 0 || m.i >= m.n || typeof m.c !== 'string') return;
      if (!r.hb || r.hb.n !== m.n) r.hb = { n: m.n, a: [] };
      r.hb.a[m.i | 0] = m.c;
      if (r.hb.a.filter(x => typeof x === 'string').length < m.n) return;
      let o = null; try { o = JSON.parse(r.hb.a.join('')); } catch (e) {} r.hb = null;
      if (!o || typeof o !== 'object') return;
      const B = r.priv; B.props.length = 0; B.gates.length = 0; B.misc.length = 0; B.cps.length = 0; B.dels.length = 0;
      const take = (key, ok, cap) => { for (const q of (Array.isArray(o[key]) ? o[key] : []).slice(0, cap)) { const c = ok(q); if (c) B[key].push(c); } };
      take('props', okProp, ROOM_PROPS); take('gates', okGate, ROOM_GATES); take('misc', okMisc, ROOM_MISC); take('cps', okCp, ROOM_CPS); take('dels', okDel, ROOM_DELS);
      B.ow = o.ow && typeof o.ow === 'object' ? o.ow : {}; owFill(B, r.priv.hostTag >>> 0);   // (who built what comes with it; anything without an owner is the host's)
      r.world = null; r.priv.ready = true;
      const b = bOut(B);
      for (const q of r.players.values()) { q.dver = null; q.sbh = q.sdh = null; if (q !== p) send(q, { t: 'rebuild', priv: 1, b }); }   // (anyone who came in before it had all arrived loads the world again, now complete)
    } else if (m.t === 'pseed') {   // the host of a private world says where everything is in it: their device is that world's memory
      const r = p.room; if (!r || !r.priv || r.priv.owner !== p.id || Date.now() - (r.priv.at || 0) > 90000 || !Array.isArray(m.d)) return;
      const rows = m.d.slice(0, 500).filter(q => Array.isArray(q) && q.length >= 4 && q.slice(0, 4).every(Number.isFinite));
      const w = roomWorld(r);
      for (const q of rows) { const d = w.dynBy.get(q[0] >>> 0); if (!d || d.gone) continue; if (q[4]) { d.burn = 1e9; d.x = d.y = -99999; } else { d.x = q[1]; d.y = q[2]; d.rot = q[3]; d.burn = 0; } d.vx = d.vy = 0; d.av = 0; d.nap = true; d.rest = 0; d.ver = ++r.verN; }
      if (Array.isArray(m.s)) for (const q of m.s.slice(0, 200)) { if (!Array.isArray(q) || q.length !== 2 || !q.every(Number.isFinite)) continue; const e = w.see.find(o => o.uid === (q[0] >>> 0)); if (e) { e.ang = Math.max(-0.36, Math.min(0.36, q[1])); e.av = 0; } }
      for (const q of r.players.values()) q.dver = null;   // (everyone is told where it all is again)
    } else if (m.t === 'ping') {   // (the device measuring how long a message takes there and back)
      p.ws.send(JSON.stringify({ t: 'pong', c: m.c }));
    } else if (m.t === 'use') {   // a device's copy of this month's counts, from before the server restarted
      if (!p.useGot) { p.useGot = true; useMerge(m.u); }
    } else if (m.t === 'wseed') {   // the server forgot this world (a restart with nothing saved): a player who was here brings back its memory, in parts
      const r = p.room; if (!r || r.priv || typeof m.k !== 'string' || m.k !== wkey(r.id) || !Number.isFinite(m.n) || !Number.isFinite(m.i) || m.n < 1 || m.n > 40 || typeof m.c !== 'string') return;
      if (!roomFresh(r) || (r.seedBy && r.seedBy !== p.id)) return;
      r.seedBy = p.id; if (!r.seedParts || r.seedParts.n !== m.n) r.seedParts = { n: m.n, a: [] };
      r.seedParts.a[m.i | 0] = m.c;
      if (r.seedParts.a.filter(x => typeof x === 'string').length < m.n) return;
      let o = null; try { o = JSON.parse(r.seedParts.a.join('')); } catch (e) {} r.seedParts = null;
      if (!o || typeof o !== 'object' || !o.b || !o.w) { r.seedBy = null; return; }
      const B = { props: [], cps: [], gates: [], misc: [], dels: [] }, okAny = q => okMisc(q) || (Array.isArray(q) && ((q.length === 4 && (q[0] === 'see' || q[0] === 'pad')) || (q.length === 5 && (q[0] === 'por' || q[0] === 'rope')) || (q.length === 6 && q[0] === 'por')) && q.slice(1).every(Number.isFinite) ? [q[0], ...q.slice(1).map(Math.round)] : null);
      const take = (key, ok, cap) => { for (const q of (Array.isArray(o.b[key]) ? o.b[key] : []).slice(0, cap)) { const c = ok(q); if (c) B[key].push(c); } };
      take('props', okProp, ROOM_PROPS); take('gates', okGate, ROOM_GATES); take('misc', okAny, ROOM_MISC); take('cps', okCp, ROOM_CPS); take('dels', okDel, ROOM_DELS);
      const dyn = (Array.isArray(o.w.d) ? o.w.d : []).filter(q => Array.isArray(q) && q.length >= 4 && q.slice(0, 4).every(Number.isFinite)).map(q => [q[1], q[2], q[3], q[0] >>> 0, q[4] ? 1 : 0]);
      const see = (Array.isArray(o.w.s) ? o.w.s : []).filter(q => Array.isArray(q) && q.length === 2 && q.every(Number.isFinite));
      B.ow = o.b.ow && typeof o.b.ow === 'object' ? o.b.ow : {}; owFill(B, 0);   // (who built what, as that player's device kept it)
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
        else if (q.length === 4 && q.slice(1).every(Number.isFinite) && q[1] > -P.OOB * P.TS && q[1] < (w.W + P.OOB) * P.TS && q[2] > -P.OOB * P.TS && q[2] < w.H * P.TS) { d.x = q[1]; d.y = q[2]; d.rot = q[3]; d.vx = d.vy = 0; d.av = 0; d.nap = false; d.st = 0; d.burn = 0; }
        else continue;
        d.ver = ++r.verN; (r.chg = r.chg || []).push(d); worldsDirty = true;
      }
    } else if (m.t === 'pdel') {   // somebody deleted something: it is gone for everyone in that world
      const r = p.room, B = bstate(r); if (!B) return;
      const q = okDel(m.g); if (!q || !addOk(p)) return;
      if (q[0] === 'base') { const e = B.misc.find(x => x[0] === 'base' && x[1] === q[1] && x[2] === q[2]); if (!e || (e[3] >>> 0) !== (p.otag >>> 0)) return; }   // (only its owner can take a base away)
      if (r.world && q[0] !== 'base') {   // nothing in somebody else's base can be deleted by anyone but them
        const w = r.world, T = P.TS; let at = null;
        if (q[0] === 'b') { const d = w.dynBy.get(q[1] >>> 0); if (d) at = [d.x, d.y]; }
        else if (q[0] === 's') { const e = w.see.find(o => o.uid === (q[1] >>> 0)); if (e) at = [e.cx, e.cy]; }
        else if (q[0] === 'g') { const e = w.doors.find(o => o.uid === (q[1] >>> 0)); if (e) at = [(e.x + 0.5) * T, (e.y + e.h / 2) * T]; }
        else if (q[0] === 'r') { const e = (w.ropes || []).find(o => o.uid === (q[1] >>> 0)); if (e) at = [(e.ax + e.bx) / 2, (e.ay + e.by) / 2]; }
        else at = [(q[1] + 1) * T, q[2] * T];
        if (at && bLock(w, at[0], at[1], p.otag)) return;
      }
      if (q[0] === 'b' && r.world) {   // deleting a crate, ball or spring somebody built: it is simply taken off the list of built things, as if it had never been put down. Nothing has to be remembered, so this never runs out
        const d = r.world.dynBy.get(q[1] >>> 0), i = d && d.brec ? B.props.indexOf(d.brec) : -1;
        if (i >= 0) { owDel(B, 'p', B.props[i], d.ownTag); B.props.splice(i, 1); d.brec = null; worldAdd.del(r, q); broadcast(r, { t: 'pdel', g: q, o: p.otag >>> 0 }, p); giveBack(r, d, p); return; }
      }
      if (P.coordDel(q) && owDiff(B, () => P.delCancel(B, q))) { worldAdd.del(r, q); broadcast(r, { t: 'pdel', g: q, o: p.otag >>> 0 }, p); worldsDirty = true; return; }   // (a built portal, booster or flag: simply off the list, so the same spot can be built on and deleted again)
      if (B.dels.length >= ROOM_DELS) return;
      if (B.dels.some(e => e.length === q.length && e.every((v, i) => v === q[i]))) return;
      B.dels.push(q); owAdd(B, 'd', q, p.otag >>> 0); worldAdd.del(r, q); broadcast(r, { t: 'pdel', g: q, o: p.otag >>> 0 }, p);
    } else if (m.t === 'pgate') {   // a gate and its trigger, built in a friend's world
      const r = p.room; if (!bstate(p.room) || !Array.isArray(m.g) || m.g.length !== 5 || !m.g.every(Number.isFinite) || m.g[2] < 2 || m.g[2] > 8 || bstate(r).gates.length >= ROOM_GATES) return;
      if (!addOk(p)) return;
      const e = m.g.map(Math.round); if (roomWorld(r) && (!gateOkZ(r.world, e) || bLock(r.world, (e[0] + 0.5) * P.TS, (e[1] + e[2] / 2) * P.TS, p.otag) || bLock(r.world, (e[3] + 1) * P.TS, e[4] * P.TS, p.otag))) return;
      (r.mown || (r.mown = new Map())).set('g,' + e.slice(0, 5).join(','), p.otag >>> 0);   // (the same rule every device uses: no gate, and no plate of one, in a no-build circle)
      bstate(r).gates.push(e); owAdd(bstate(r), 'g', e, p.otag >>> 0); worldAdd.gate(r, e); broadcast(r, { t: 'pgate', g: e, o: p.otag >>> 0 }, p);
    } else if (m.t === 'padd' || m.t === 'pcp') {   // somebody built something in a friend's world: everyone there gets it
      const r = p.room; if (!bstate(p.room)) return;
      if (!addOk(p)) return;
      if (m.t === 'padd') {
        const k = m.k | 0; if (k < 0 || k > 7 || !Number.isFinite(m.x) || !Number.isFinite(m.y)) return;
        if (roomWorld(r) && (P.zoneP(r.world.map, m.x, m.y, P.TS * 0.6) || bLock(r.world, m.x, m.y, p.otag))) { send(p, { t: 'pno', k, x: Math.round(m.x), y: Math.round(m.y) }); return; }
        { // a fair share for everybody: each player in the world always has room for PROP_SHARE crates, balls and springs of their own; past that they may go on building only while that leaves every other player here their share
          const B = bstate(r), own = owCounts(B, 'p', 'props'), mine = own.get(p.otag >>> 0) || 0; let used = B.props.length, keep = 0;   // (counted from who really built each one, so leaving and coming back changes nothing)
          for (const e of B.dels) if (e[0] === 'b') used--;
          for (const q of r.players.values()) if (q !== p) keep += Math.max(0, PROP_SHARE - (own.get(q.otag >>> 0) || 0));
          if (B.props.length >= ROOM_PROPS * 2 || used >= ROOM_PROPS || (mine >= PROP_SHARE && used + keep >= ROOM_PROPS)) { send(p, { t: 'pno', k, x: Math.round(m.x), y: Math.round(m.y), full: used >= ROOM_PROPS ? 1 : 0 }); return; }
        }
        const e = [k, Math.round(m.x), Math.round(m.y)]; bstate(r).props.push(e); owAdd(bstate(r), 'p', e, p.otag >>> 0); const nd = worldAdd.prop(r, e), nu = nd ? nd.uid : undefined; if (nd) { nd.ownPub = p.pub; nd.ownTag = p.otag >>> 0; } { const B = bstate(r); (B.po || (B.po = {}))[e.join(',')] = p.otag >>> 0; } broadcast(r, { t: 'padd', k: e[0], x: e[1], y: e[2], u: nu, o: p.otag >>> 0 }, p); if (nu !== undefined) send(p, { t: 'puid', k: e[0], x: e[1], y: e[2], u: nu });   // (the server's name for it goes to everyone, so two things put down on the very same spot can never be mixed up)
      } else {
        if (!Number.isFinite(m.x) || !Number.isFinite(m.y) || bstate(r).cps.length >= ROOM_CPS) return;
        if (r.world && bLock(r.world, (m.x + 0.5) * P.TS, m.y * P.TS, p.otag)) return;
        (r.mown || (r.mown = new Map())).set('c,' + Math.round(m.x) + ',' + Math.round(m.y), p.otag >>> 0);
        const e = [Math.round(m.x), Math.round(m.y)], B = bstate(r); owDiff(B, () => P.addCancel(B, 'c', e[0], e[1])); B.cps.push(e); owAdd(B, 'c', e, p.otag >>> 0); broadcast(r, { t: 'pcp', x: e[0], y: e[1], o: p.otag >>> 0 }, p);
      }
    } else if (m.t === 'find') {
      const now = Date.now(); if (now - p.lastFind < 250) return; p.lastFind = now;
      const raw = String(m.q == null ? '' : m.q).trim().slice(0, 12), q = raw.toLowerCase(), qc = raw.toUpperCase().replace(/^#/, ''), mine = links.get(p.pub), out = [];
      const browse = !raw;   // nothing typed: everybody who has played (online first, then the most recent). Typing searches by name or friend number.
      known.forEach((k, pub) => {
        if (pub === p.pub) return;
        const code = codeOf(pub), q2 = byPub.get(pub), on = live(q2) ? (q2.room || true) : null, nm = q2 ? q2.name : k.name, last = on ? now : k.last;
        if (!nm || (!k.played && !on) || (!on && k.last < Date.now() - STALE_MS && !(mine && mine.has(pub)))) return;   // (and nobody who has been away for a month: they are only still there for their friends)   // (only people who have really played: somebody who opened the page for a moment is not listed)
        if (blocked(p.pub, pub)) return;   // (nobody you blocked, and nobody who blocked you)
        const sh = shareOf(pub), linked = !!(mine && mine.has(pub));
        if (!browse && !(nm.toLowerCase().indexOf(q) >= 0 || code === qc || code.indexOf(qc) === 0 && qc.length >= 3)) return;
        out.push({ pub, code, name: nm, color: q2 ? q2.color : k.color, color2: q2 ? q2.color2 : (k.color2 || '#ffffff'), pat: q2 ? q2.pat | 0 : (k.pat | 0), b: sh.beat ? k.beat | 0 : -1, on: on && sh.on ? 1 : 0, hid: sh.on ? 0 : 1, w: on && on !== true && sh.on ? (on.priv ? -1 : on.id) : 0, last: sh.last ? (sh.on ? last : k.last) : 0, here: on && on !== true && on === p.room ? 1 : 0, l: linked ? 1 : 0, fr: sh.fr ? linkSet(pub).size : -1, first: sh.since ? k.first || 0 : 0 });
      });
      out.sort((a, b) => (b.here - a.here) || (b.on - a.on) || (b.last - a.last));   // (somebody who hides when they are on is listed by when they were last seen anyway, without saying)
      send(p, { t: 'found', q: raw, list: out.slice(0, browse ? 120 : 40), n: out.length });
    } else if (m.t === 'treq' || m.t === 'tacc' || m.t === 'tden') {
      if (!p.pub || typeof m.to !== 'string' || !PUB.test(m.to) || m.to === p.pub) return;
      const q = byPub.get(m.to), now = Date.now();
      if (m.t === 'treq') {
        if (now - p.lastReq < 1500) return; p.lastReq = now;
        const kn = known.get(m.to);   // a server that was restarted may have forgotten them; the request still waits for them
        const tn = q ? q.name : kn ? kn.name : String(m.nm || '').replace(/[^\w .\-]/g, '').slice(0, 12);
        if (linkSet(p.pub).has(m.to)) return;
        if (blocked(p.pub, m.to)) { send(p, { t: 'tsent', pub: m.to, name: tn, off: 1 }); return; }   // (blocked: it goes nowhere, and nobody is told why)
        if (linkSet(p.pub).size >= MAX_LINKS) return send(p, { t: 'tno', pub: m.to, name: tn, why: 'mine' });
        if (linkSet(m.to).size >= MAX_LINKS) return send(p, { t: 'tno', pub: m.to, name: tn, why: 'theirs' });
        let n = 0; pend.forEach((v, k) => { if (k.indexOf(p.pub + '>') === 0) n++; }); if (n >= 20) return;
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
        if (blocked(p.pub, m.to)) { pend.delete(k); return; }
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
      const ent = { ep: m.sub.endpoint, p: b64u(k1), a: b64u(k2), f: pr.f ? 1 : 0, r: pr.r ? 1 : 0, i: pr.i ? 1 : 0, m: pr.m ? 1 : 0, mu: Array.isArray(pr.mu) ? pr.mu.filter(x => typeof x === 'string' && PUB.test(x)).slice(0, 500) : [], q: cleanQuiet(pr.q), t: Date.now() };
      pushSubs.set(p.pub, ent); linksDirty = true;
      for (const f of linkSet(p.pub)) { const q = byPub.get(f); if (q && live(q)) send(q, { t: 'fsub', pub: p.pub, s: ent }); }   // (your friends' devices keep where to reach yours: if this server ever forgets, they tell it again)
      send(p, { t: 'fsubs', l: [...linkSet(p.pub)].filter(f => pushSubs.has(f)).slice(0, 64).map(f => [f, pushSubs.get(f)]) });
    } else if (m.t === 'fsubs') {   // a player's device says where to reach friends' devices that this server has forgotten (after a restart with nothing saved)
      if (!p.pub || !Array.isArray(m.l)) return;
      const mine = linkSet(p.pub), cl = claimsOf.get(p.pub) || new Set();
      for (const e of m.l.slice(0, 64)) {
        if (!Array.isArray(e) || e.length !== 2 || typeof e[0] !== 'string' || !PUB.test(e[0]) || pushSubs.has(e[0]) || !(mine.has(e[0]) || cl.has(e[0]))) continue;
        const s = e[1]; if (!s || typeof s !== 'object' || typeof s.ep !== 'string' || !okPushUrl(s.ep)) continue;
        const k1 = unb64u(String(s.p || '')), k2 = unb64u(String(s.a || '')); if (k1.length !== 65 || k1[0] !== 4 || k2.length !== 16 || pushSubs.size >= 8000) continue;
        pushSubs.set(e[0], { ep: s.ep, p: b64u(k1), a: b64u(k2), f: s.f ? 1 : 0, r: s.r ? 1 : 0, i: s.i ? 1 : 0, m: s.m ? 1 : 0, mu: Array.isArray(s.mu) ? s.mu.filter(x => typeof x === 'string' && PUB.test(x)).slice(0, 500) : [], q: cleanQuiet(s.q), t: Date.now() }); linksDirty = true;
      }
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
      if (p.pub && known.get(p.pub)) { known.get(p.pub).color = p.color; known.get(p.pub).color2 = p.color2; known.get(p.pub).pat = p.pat | 0; if (m.beat != null) known.get(p.pub).beat = Math.max(0, Math.min(999, m.beat | 0)); knownDirty = true; }
      if (p.pub) for (const b of linkSet(p.pub)) { const q = byPub.get(b); if (q) sendLinks(q); }
      if (p.room) broadcast(p.room, { t: 'info', id: p.id, name: p.name, color: p.color, color2: p.color2, pat: p.pat }, p);
    } else if (m.t === 'bots') {   // the host switches the bots in their private world on or off
      const r = p.room; if (!r || !r.priv || r.priv.owner !== p.id) return;
      r.botsOn = !!m.on;
    } else if (m.t === 'rules') {   // the host of a private world turns "no cheats" on or off: everyone there is told
      const r = p.room; if (!r || !r.priv || r.priv.owner !== p.id) return;
      r.noCheats = !!m.nc; broadcast(r, { t: 'rules', nc: r.noCheats ? 1 : 0 });
    } else if (m.t === 'gift') {   // coins and diamonds from one player to another in the same world (the giver's device takes them off first)
      const r = p.room; if (!r || !addOk(p)) return; const c = Math.max(0, Math.min(1e6, Math.floor(+m.c || 0))), g = Math.max(0, Math.min(1e4, Math.floor(+m.g || 0)));   // (never more than a million coins and ten thousand diamonds at once)
      const q = r.players.get(m.to | 0); if (!q || q === p || !(c + g) || (p.pub && q.pub && blocked(p.pub, q.pub))) return;
      send(q, { t: 'gift', from: p.id, name: p.name, c, g }); send(p, { t: 'giftok', to: q.id, c, g });
    } else if (m.t === 'text') {   // a chat message: anything up to 200 characters, to everyone in your world
      const r = p.room; if (!r || typeof m.s !== 'string') return; const txt = m.s.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200); if (!txt) return;
      { const why = P.piiCheck(txt); if (why) { send(p, { t: 'pii', why }); return; } }   // (phone numbers, emails, addresses, links and other apps never go out)
      const now = Date.now(); p.txT = (p.txT || []).filter(t => now - t < 10000); if (p.txT.length >= 6) { send(p, { t: 'texthold' }); return; } p.txT.push(now);   // (no more than 6 messages in 10 seconds)
      bcastFrom(r, p, { t: 'text', id: p.id, pub: p.pub, name: p.name, color: p.color, s: txt, at: now });
      if (r.bots && r.bots.length) { const k = P.askKind('text', txt); if (k) roomCtx(r).asks.push({ kind: k, x: p.x, y: p.y, id: p.id }); }
    } else if (m.t === 'dm') {   // a message to one friend, from inside a game: only to a friend, never to or from someone blocked, and never with personal info
      if (!p.pub || !p.room || typeof m.to !== 'string' || !PUB.test(m.to) || typeof m.s !== 'string') return;
      const txt = m.s.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200); if (!txt) return;
      if (!linkSet(p.pub).has(m.to) || blocked(p.pub, m.to)) { send(p, { t: 'dmno', to: m.to, why: 'friend', c: m.c | 0 }); return; }
      { const why = P.piiCheck(txt); if (why) { send(p, { t: 'pii', why, to: m.to, c: m.c | 0 }); return; } }
      const now = Date.now(); p.txT = (p.txT || []).filter(t => now - t < 10000); if (p.txT.length >= 6) { send(p, { t: 'texthold' }); return; } p.txT.push(now);
      const q = byPub.get(m.to); if (!live(q)) { send(p, { t: 'dmno', to: m.to, why: 'off', c: m.c | 0 }); return; }
      pairOf(p.pub, m.to).m = now; linksDirty = true;
      send(q, { t: 'dm', from: p.pub, name: p.name, color: p.color, s: txt, at: now });
      send(p, { t: 'dmok', to: m.to, s: txt, at: now, c: m.c | 0 });
    } else if (m.t === 'prof') {   // everything shown on a player's profile, fresh (yours too)
      if (!p.pub) return; const now = Date.now(); if (now - (p.lastProf || 0) < 150) return; p.lastProf = now;
      const who = m.to === 'me' ? p.pub : m.to; if (typeof who !== 'string' || !PUB.test(who) || !known.has(who)) return;
      if (who !== p.pub && blocked(p.pub, who)) return send(p, { t: 'prof', pub: who, blk: 1 });
      send(p, Object.assign({ t: 'prof', me: who === p.pub ? 1 : 0, friend: linkSet(p.pub).has(who) ? 1 : 0 }, peerInfo(who, who === p.pub ? null : p.pub)));
    } else if (m.t === 'blk') {   // block (or unblock) a player: no requests, messages or chat between you, and you are no longer friends
      if (!p.pub || typeof m.to !== 'string' || !PUB.test(m.to) || m.to === p.pub) return;
      let b = blocks.get(p.pub); if (!b) blocks.set(p.pub, b = new Set());
      if (m.on) {
        if (b.size >= 200) return; b.add(m.to);
        const had = linkSet(p.pub).has(m.to); dropLink(p.pub, m.to); pend.delete(p.pub + '>' + m.to); pend.delete(m.to + '>' + p.pub);
        const cp = claimsOf.get(p.pub); if (cp) cp.delete(m.to); const cq = claimsOf.get(m.to); if (cq) cq.delete(p.pub);
        if (had) { const q = byPub.get(m.to); if (q) { send(q, { t: 'unl', gone: [p.pub], name: p.name }); sendLinks(q); } else { let g = gone.get(m.to); if (!g) gone.set(m.to, g = new Set()); if (g.size < 50) g.add(p.pub); } }   // (to them it looks like being unfriended: they are not told they were blocked)
      } else b.delete(m.to);
      linksDirty = true; sendLinks(p); sendMe(p);
    } else if (m.t === 'share') {   // what you let other players see (your name and ball are always shown)
      if (!p.pub || !m.s || typeof m.s !== 'object') return; const k = known.get(p.pub); if (!k) return;
      const was = shareOf(p.pub).on; k.share = cleanShare(m.s); knownDirty = true; linksDirty = true; sendMe(p);
      for (const b of linkSet(p.pub)) { const q = byPub.get(b); if (live(q)) { sendLinks(q); if (was !== k.share.on && live(p)) send(q, { t: k.share.on ? 'lon' : 'loff', pub: p.pub, name: p.name, quiet: 1 }); } }
    } else if (m.t === 'finish') {
      if (!p.room) return;
      const sl = rslot(p.room);
      if (m.m !== sl || !p.has || p.fin === sl || (p.pub && p.room.finPub && p.room.finPub.has(p.pub))) return;
      const flag = roomMap(p.room).flag;
      const dx = p.x - flag[0] * maps.TS, dy = p.y - flag[1] * maps.TS;
      if (Math.abs(dx) > 14 * maps.TS || dy > 120 || dy < -400) return;   // must really be at the flag
      p.fin = sl;
      const room = p.room;
      room.finishers.push(p.id); if (p.pub) (room.finPub || (room.finPub = new Map())).set(p.pub, room.finishers.length); if (room.bots && room.bots.length) roomCtx(room).fins.push({ x: p.x, y: p.y });
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
const corked = [];
function corkAll(on) {   // everything sent to one player in one update goes out in a single packet instead of several (much less work for the server, the same data)
  if (on) { for (const r of rooms.values()) for (const p of r.players.values()) { const so = p.ws && p.ws._socket; if (so && !so.destroyed) { so.cork(); corked.push(so); } } }
  else { for (const so of corked) { try { so.uncork(); } catch (e) {} } corked.length = 0; }   // (every socket corked is uncorked again, even if its player left meanwhile)
}
function relayTick() {   // (runs right after each world update, in the same packet to each player)
  tickN++;
  // (c) a tiny overview every 2 seconds, so everyone shows up on the map even when they are far away
  if (tickN % 120 === 0) {
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
        for (let k = 0; k < cap; k++) { const p = far[k]; buf.writeUInt32LE(p.id, 3 + k * 8); buf.writeUInt16LE(Math.max(0, Math.min(65535, (p.x + P.POFF) >> 2)), 7 + k * 8); buf.writeUInt16LE(Math.max(0, Math.min(65535, (p.y + P.POFF) >> 1)), 9 + k * 8); }
        r.ws.send(buf, { binary: true });
      }
    }
  }
  // (d) linked players always receive each other's position, wherever they are
  const inSlot = new Map(); for (const q of byPub.values()) if (q.room && q.has) { const sl = rslot(q.room); let a = inSlot.get(sl); if (!a) inSlot.set(sl, a = []); a.push(q); }   // (who is playing on each map: a player with hundreds of friends only costs as much as the people actually there)
  for (const r of byPub.values()) {
    if (!r.room || r.ws.readyState !== 1) continue;
    const ls = links.get(r.pub); if (!ls || !ls.size) continue;
    const here = inSlot.get(rslot(r.room)) || [], arr = []; let fresh = tickN % 60 === 0;
    if (ls.size <= here.length) { for (const b of ls) { const q = byPub.get(b); if (q && q.room && q.has && rslot(q.room) === rslot(r.room)) { arr.push(q); if (q.moved) fresh = true; } } }
    else for (const q of here) if (q !== r && ls.has(q.pub)) { arr.push(q); if (q.moved) fresh = true; }
    if (arr.length > 200) arr.length = 200;
    if (!arr.length || !fresh) continue;   // (only when somebody moved, plus a heartbeat every second)
    const buf = Buffer.allocUnsafe(3 + arr.length * 12);
    buf[0] = 3; buf.writeUInt16LE(rslot(r.room) & 0xFFFF, 1);
    arr.forEach((q, k) => { const o = 3 + k * 12; buf.writeUInt32LE(parseInt(q.pub.slice(0, 8), 16) >>> 0, o); buf.writeUInt16LE(Math.max(0, Math.min(65535, (q.x + P.POFF) >> 2)), o + 4); buf.writeUInt16LE(q.dead ? 65535 : Math.max(0, Math.min(65534, (q.y + P.POFF) >> 1)), o + 6); buf.writeUInt16LE(q.room.id & 0xFFFF, o + 8); buf.writeInt8(q.dead ? 0 : Math.max(-127, Math.min(127, Math.round((q.rvx === undefined ? q.vx : q.rvx) / 5))), o + 10); buf.writeInt8(q.dead ? 0 : Math.max(-127, Math.min(127, Math.round(q.vy / 20))), o + 11); });
    r.ws.send(buf, { binary: true });
  }
  for (const room of rooms.values()) {
    const list = [...room.players.values()];
    if (list.length < 2) { for (const p of list) { p.moved = false; if (p.hist) p.hist.length = 0; } continue; }
    for (const r of list) {
      if (!r.has || r.ws.readyState !== 1) continue;
      let k = 0; const hits = [];
      for (const p of list) {
        if (p === r || !p.has) continue;
        if (Math.abs(p.x - r.x) > RANGE || Math.abs(p.y - r.y) > RANGE || p.stale) {
          if (r.vis.delete(p.id)) hits.push([p, 1]);   // they moved out of your range: tell the client to hide them (no stale ghosts)
          continue;
        }
        if (p.moved || !r.vis.has(p.id)) { hits.push([p, 0]); r.vis.add(p.id); }
      }
      if (!hits.length) continue;
      let extra = 0; for (const h of hits) if (!h[1] && !h[0].dead && h[0].hist) extra += h[0].hist.length;
      const buf = Buffer.allocUnsafe(3 + (hits.length + extra) * 12);
      buf[0] = 1; buf.writeUInt16LE(rslot(room) & 0xFFFF, 1);
      for (const h of hits) {
        if (!h[1] && !h[0].dead && h[0].hist) for (const q of h[0].hist) { const o = 3 + k * 12; k++; buf.writeUInt32LE(h[0].id, o); buf.writeUInt16LE(Math.max(0, Math.min(65535, (q[0] + P.POFF) >> 1)), o + 4); buf.writeUInt16LE(Math.max(0, Math.min(65533, q[1] + P.POFF)), o + 6); buf.writeInt8(Math.max(-127, Math.min(127, Math.round(q[2] / 5))), o + 8); buf.writeInt8(Math.max(-127, Math.min(127, Math.round(q[3] / 20))), o + 9); buf.writeUInt16LE(q[4] & 0xFFFF, o + 10); }   // per player: id u32, x/2 u16, y u16 (65535 = just died, 65534 = out of range), vx/5 i8, vy/20 i8, time+grounded u16
        const p = h[0], o = 3 + k * 12, gone = h[1] || p.dead; k++;
        buf.writeUInt32LE(p.id, o); buf.writeUInt16LE(Math.max(0, Math.min(65535, (p.x + P.POFF) >> 1)), o + 4); buf.writeUInt16LE(h[1] ? 65534 : p.dead ? 65535 : Math.max(0, Math.min(65533, p.y + P.POFF)), o + 6);
        buf.writeInt8(gone ? 0 : Math.max(-127, Math.min(127, Math.round((p.rvx === undefined ? p.vx : p.rvx) / 5))), o + 8);   // (someone pressing against a crate is shown standing against it: never carried on into it)
        buf.writeInt8(gone ? 0 : Math.max(-127, Math.min(127, Math.round(p.vy / 20))), o + 9); buf.writeUInt16LE(p.st & 0xFFFF, o + 10);
      }
      r.ws.send(buf, { binary: true });
    }
    for (const p of list) { p.moved = false; if (p.hist) p.hist.length = 0; }
  }
}
setInterval(() => { useRoll(); const msg = JSON.stringify({ t: 'use', u: usage }); for (const r of rooms.values()) for (const p of r.players.values()) if (p.ws.readyState === 1) p.ws.send(msg); }, 30000).unref();   // (every player's device keeps a copy of the month's counts)
let lastTickAt = Date.now();
setInterval(() => { const t0 = Date.now(), late = Math.max(0, t0 - lastTickAt - TICK_MS); lastTickAt = t0; const h0 = process.hrtime.bigint();
  corkAll(true); try { simTick(); } catch (e) { console.log('sim error', e && e.stack); } try { relayTick(); } catch (e) { console.log('relay error', e && e.stack); } corkAll(false);
  health.tickMs.push(Number(process.hrtime.bigint() - h0) / 1e6); health.late.push(late); if (health.tickMs.length > 600) health.tickMs.shift(); if (health.late.length > 600) health.late.shift(); health.lastTick = Date.now();   // (how long each update takes, and how late it came: the last ten seconds)
}, TICK_MS);

// "N online / record" counter
setInterval(() => {
  if (!statsDirty) return;
  statsDirty = false;
  const s = JSON.stringify({ t: 'stats', online, peak });
  for (const room of rooms.values()) for (const p of room.players.values()) if (p.ws.readyState === 1) p.ws.send(s);
}, 5000);
setInterval(() => { linksDirty = true; }, 6 * 3600000);   // (re-checks who has been gone for two months)
setInterval(() => { linksDirty = true; }, 6 * 3600000);   // (the 30-day clean-up runs at least every six hours, even when nothing else changed)
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
    room.world = null; loadSaved(room); room.fk = pickFin(room.id);
    room.finishers = []; room.finPub = new Map();
    for (const p of room.players.values()) { p.has = false; p.dead = 0; p.moved = false; p.vis.clear(); p.dver = null; }
    broadcast(room, { t: 'newmap', slot: curSlot, fk: room.fk | 0, next: nextAt(curSlot), now: Date.now(), build: bstate(room) });   // (with what was built on this map the last time it was played)
  }
  keepWorlds(false);
  pushSubs.forEach((v, pub) => { if (v.m) pushTo(pub, 'm', ['A new map has started', maps.names[curSlot % maps.count]], 'map-' + curSlot); });   // (only devices that are not in the game right now)
}, 1000);

// A player whose game has gone quiet (every game in a world says something at least once a second): after 3.5 seconds they are hidden from everybody, so nobody is left looking at them frozen in place; after 10 seconds they are taken out of the world, which tells everybody they left (and their friends that they went offline). If their game wakes up it simply joins again
setInterval(() => {
  const now = Date.now();
  for (const room of rooms.values()) for (const p of room.players.values()) {
    if (!p.has) continue;   // (only players actually in the game: a connection that has not shown itself yet is left alone)
    const q = now - (p.lastMsg || now);
    const st = q > 3500; if (st !== !!p.stale) { p.stale = st; p.moved = true; }
    if (q > 10000) { try { p.ws.terminate(); } catch (e) {} }
  }
}, 500).unref();

// Drop dead connections
setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, 25000);

function shutdown() { savePeak(true); saveLinks(true); try { sharesDirty = true; saveShares(); } catch (e) {} try { keepWorlds(true); } catch (e) {} process.exit(0); }
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

server.listen(PORT, () => {
  console.log(`ballpit.party running on http://localhost:${PORT}  (map: ${maps.names[curSlot % maps.count]}, record: ${peak})`);
});

// ballpit.party - moving to a new server, without anybody starting again.
// Run once on the NEW server, before its game server starts for the first time:
//   MOVE_FROM=https://ballpit-party.onrender.com  MOVE_TO=https://play.ballpit.party  ADMIN_KEY=...  LINKS_FILE=/var/lib/ballpit/links.json  node move-in.js
// It asks the old server for everything (with the dev tools key): friends, messages, friend requests, shared maps, gifts, the public world, bans and the
// dev team, and who gets notifications. The old server checks that something answers at MOVE_TO, hands it all over, and from that moment sends every
// player to MOVE_TO (their games remember the new address). The files are written next to LINKS_FILE (and STATS_FILE), where server.js reads them.
// It never overwrites a server that already has its own files (set FORCE=1 to do that anyway). MOVE_DRY=1 copies without moving anybody.
const fs = require('fs'), path = require('path');
const FROM = String(process.env.MOVE_FROM || '').replace(/\/+$/, ''), TO = String(process.env.MOVE_TO || '').replace(/\/+$/, ''), KEY = process.env.ADMIN_KEY || '';
const LINKS = process.env.LINKS_FILE || path.join(__dirname, 'links.json'), DIR = path.dirname(LINKS), STATS = process.env.STATS_FILE || path.join(__dirname, 'stats.json');
const fail = (msg, code) => { console.error('move-in: ' + msg); process.exit(code || 1); };
(async () => {
  if (!FROM || !TO || !KEY) fail('MOVE_FROM, MOVE_TO and ADMIN_KEY are all needed');
  if (fs.existsSync(LINKS) && process.env.FORCE !== '1') { console.log('move-in: this server already has its own files (' + LINKS + '): nothing copied'); process.exit(0); }
  let r, j;
  try { r = await fetch(FROM + '/move-out', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: KEY, to: TO, dry: process.env.MOVE_DRY === '1' ? 1 : 0 }), signal: AbortSignal.timeout(60000) }); }
  catch (e) { fail('the old server at ' + FROM + ' did not answer (' + e.message + ')'); }
  try { j = await r.json(); } catch (e) { fail('the old server answered with something unexpected (status ' + r.status + '). Is it on version 217 or newer?'); }
  if (!r.ok) fail(j && j.error ? j.error : 'the old server said no (status ' + r.status + ')');
  fs.mkdirSync(DIR, { recursive: true });
  const names = [];
  for (const [n, s] of Object.entries(j.files || {})) {
    if (!/^[a-z]+\.json$/.test(n) || typeof s !== 'string') continue;
    try { JSON.parse(s); } catch (e) { console.log('move-in: ' + n + ' was not readable, left out'); continue; }
    const f = n === 'stats.json' ? STATS : n === 'links.json' ? LINKS : path.join(DIR, n), tmp = f + '.tmp';
    fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(tmp, s, n === 'chatkey.json' ? { mode: 0o600 } : undefined); fs.renameSync(tmp, f);   // (chatkey.json: the key the saved messages are encrypted with; only the server reads it) names.push(n + ' (' + Math.round(s.length / 1024) + ' KB)');
  }
  console.log('move-in: copied from ' + FROM + ' (version ' + j.v + ', ' + (j.players || 0) + ' players on record): ' + names.join(', '));
  console.log(process.env.MOVE_DRY === '1' ? 'move-in: a trial only: players stay on the old server' : 'move-in: the old server now sends every player to ' + TO);
})();

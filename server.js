// سرور محلی بازی نبرد آب‌پاش — بدون نیاز به اینترنت و بدون نصب هیچ پکیج
// اجرا:  node server.js      (فایل‌های index.html و server.js کنار هم باشن)
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto'), os = require('os'), https = require('https');
const PORT = +process.env.PORT || 8080, DIR = __dirname;
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json', '.css': 'text/css', '.png': 'image/png', '.mp3': 'audio/mpeg', '.ico': 'image/x-icon' };

/* --- یک بار کتابخونه سه‌بعدی رو کنار فایل‌ها ذخیره می‌کنه (فقط بار اول اینترنت می‌خواد) --- */
function ensureLib(cb) {
  const f = path.join(DIR, 'three.min.js');
  if (fs.existsSync(f)) return cb();
  console.log('three.min.js not found, downloading once (needs internet)...');
  const fail = () => { console.log('Download failed. Put three.min.js (r128) next to server.js manually, or run once with internet.'); cb(); };
  https.get('https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js', r => {
    if (r.statusCode !== 200) return fail();
    const w = fs.createWriteStream(f);
    r.pipe(w);
    w.on('finish', () => { console.log('three.min.js saved.'); cb(); });
  }).on('error', fail);
}

/* --- فایل‌های ثابت --- */
const srv = http.createServer((q, s) => {
  let u = decodeURIComponent(q.url.split('?')[0]);
  if (u === '/lan-ping') { s.writeHead(200, { 'Content-Type': 'text/plain' }); return s.end('ok'); }
  if (u === '/') u = '/index.html';
  const f = path.normalize(path.join(DIR, u));
  if (path.relative(DIR, f).startsWith('..') || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { s.writeHead(404); return s.end('not found'); }
  s.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
  fs.createReadStream(f).pipe(s);
});

/* --- وب‌سوکت ساده (بدون کتابخونه) --- */
function wsSend(s, t) {
  if (s.destroyed) return;
  const p = Buffer.from(t), n = p.length; let h;
  if (n < 126) h = Buffer.from([0x81, n]);
  else if (n < 65536) { h = Buffer.alloc(4); h[0] = 0x81; h[1] = 126; h.writeUInt16BE(n, 2); }
  else { h = Buffer.alloc(10); h[0] = 0x81; h[1] = 127; h.writeBigUInt64BE(BigInt(n), 2); }
  s.write(Buffer.concat([h, p]));
}
function parse(b) {
  if (b.length < 2) return null;
  const op = b[0] & 15; let len = b[1] & 127, off = 2;
  if (len === 126) { if (b.length < 4) return null; len = b.readUInt16BE(2); off = 4; }
  else if (len === 127) { if (b.length < 10) return null; len = Number(b.readBigUInt64BE(2)); off = 10; }
  const masked = b[1] & 128; if (masked) off += 4;
  if (b.length < off + len) return null;
  let p = Buffer.from(b.slice(off, off + len));
  if (masked) { const m = b.slice(off - 4, off); for (let i = 0; i < p.length; i++) p[i] ^= m[i % 4]; }
  return { op, text: p.toString('utf8'), len: off + len };
}

const rooms = new Map(); // کد اتاق -> [سوکت‌ها]
srv.on('upgrade', (q, sock) => {
  const url = new URL(q.url, 'http://x'), key = q.headers['sec-websocket-key'];
  if (url.pathname !== '/ws' || !key) return sock.destroy();
  sock.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' +
    crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64') + '\r\n\r\n');
  sock.setNoDelay(true);
  const code = (url.searchParams.get('room') || '').slice(0, 8), mode = url.searchParams.get('mode');
  const reject = why => { wsSend(sock, JSON.stringify({ __: why })); sock.end(); };
  let room = rooms.get(code);
  if (mode === 'host') { if (room) return reject('taken'); room = [sock]; rooms.set(code, room); }
  else { if (!room || room.length !== 1) return reject('nope'); room.push(sock); room.forEach(x => wsSend(x, '{"__":"peer"}')); }

  let buf = Buffer.alloc(0);
  sock.on('data', d => {
    buf = Buffer.concat([buf, d]);
    let f;
    while ((f = parse(buf))) {
      buf = buf.slice(f.len);
      if (f.op === 8) { sock.end(); return; }
      if (f.op === 1) { const r = rooms.get(code); if (r) r.forEach(x => { if (x !== sock) wsSend(x, f.text); }); }
    }
  });
  const gone = () => {
    const r = rooms.get(code);
    if (!r || !r.includes(sock)) return;
    rooms.delete(code);
    r.forEach(x => { if (x !== sock) { wsSend(x, '{"__":"left"}'); x.end(); } });
  };
  sock.on('close', gone); sock.on('error', gone);
});

ensureLib(() => srv.listen(PORT, '0.0.0.0', () => {
  console.log('\nBattle server is running. Open one of these on every phone (same WiFi / hotspot):\n');
  for (const list of Object.values(os.networkInterfaces()))
    for (const i of list) if (i.family === 'IPv4' && !i.internal) console.log('   http://' + i.address + ':' + PORT);
  console.log('   http://localhost:' + PORT + '   (this device only)\n');
}));

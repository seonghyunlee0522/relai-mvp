// TCP proxy between the app and Postgres that injects DB faults; control over HTTP.
//   UP=127.0.0.1:55490 LISTEN=55491 CTL=55492 node scripts/load/faultproxy.mjs
//   curl :55492/mode?m=normal | refuse (RST new connections) | blackhole (accept, never answer) | delay&ms=3000 (each chunk to the DB)
//   curl :55492/kill  → drop every open connection (DB restart / network cut)
import net from 'node:net';
import http from 'node:http';
const [uh, up] = (process.env.UP || '127.0.0.1:55490').split(':');
let mode = 'normal', ms = 0; const socks = new Set();
net.createServer((c) => {
  if (mode === 'refuse') return c.resetAndDestroy();
  socks.add(c); c.on('close', () => socks.delete(c)); c.on('error', () => {});
  if (mode === 'blackhole') return;
  const s = net.connect(Number(up), uh); socks.add(s); s.on('close', () => { socks.delete(s); c.destroy(); }); s.on('error', () => c.destroy());
  c.on('close', () => s.destroy());
  c.on('data', (d) => { if (mode === 'delay') { c.pause(); setTimeout(() => { s.write(d); c.resume(); }, ms); } else s.write(d); });
  s.pipe(c);
}).listen(Number(process.env.LISTEN || 55491), '127.0.0.1');
http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/mode') { mode = u.searchParams.get('m') || 'normal'; ms = Number(u.searchParams.get('ms') || 0); }
  if (u.pathname === '/kill') { for (const s of socks) s.destroy(); socks.clear(); }
  res.end(JSON.stringify({ mode, ms, open: socks.size }));
}).listen(Number(process.env.CTL || 55492), '127.0.0.1', () => console.log('[faultproxy] up'));

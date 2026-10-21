// Load balancer that imitates Vercel scaling: requests go to the least-busy live instance; when every live instance already
// has CONCURRENCY in flight, the next instance (up to the started pool of ports) is "scaled in". Instances idle for IDLE_MS
// are taken out of rotation again (they keep their pool — like a suspended Vercel instance it closes idle clients after 5 s).
//   PORTS=4101,4102,… CONCURRENCY=… LB_PORT=4100 node scripts/load/lb.mjs
import http from 'node:http';
import { appendFileSync } from 'node:fs';
const ports = String(process.env.PORTS).split(',').map(Number);
const C = Number(process.env.CONCURRENCY || 30);
const IDLE_MS = Number(process.env.IDLE_MS || 60_000);
const inst = ports.map((p) => ({ p, live: false, inflight: 0, last: 0, served: 0 }));
inst[0].live = true;
let maxLive = 1;
const agent = new http.Agent({ keepAlive: true, maxSockets: 1000 });
const pick = () => {
  const live = inst.filter((i) => i.live).sort((a, b) => a.inflight - b.inflight);
  if (live[0] && live[0].inflight < C) return live[0];
  const next = inst.find((i) => !i.live);
  if (next) { next.live = true; return next; }
  return live[0];
};
setInterval(() => { const now = Date.now(); for (const i of inst.slice(1)) if (i.live && i.inflight === 0 && now - i.last > IDLE_MS) i.live = false;
  const n = inst.filter((i) => i.live).length; maxLive = Math.max(maxLive, n);
  if (process.env.LB_LOG) appendFileSync(process.env.LB_LOG, JSON.stringify({ t: now, live: n, inflight: inst.map((i) => i.inflight) }) + '\n'); }, 1000).unref();
http.createServer((req, res) => {
  if (req.url === '/__lb') { res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify({ maxLive, inst })); }
  const t = pick(); t.inflight++; t.last = Date.now(); t.served++;
  let done = false; const fin = () => { if (!done) { done = true; t.inflight--; t.last = Date.now(); } };
  const up = http.request({ host: '127.0.0.1', port: t.p, method: req.method, path: req.url, headers: { ...req.headers, 'x-forwarded-for': req.headers['x-forwarded-for'] || '127.0.0.1', 'x-forwarded-proto': 'https' }, agent }, (r) => {
    res.writeHead(r.statusCode, r.headers); r.pipe(res); r.on('end', fin); r.on('error', fin);
  });
  up.on('error', (e) => { fin(); if (!res.headersSent) { res.writeHead(502); } res.end('lb: upstream error ' + e.code); });
  res.on('close', fin);
  req.pipe(up);
}).listen(Number(process.env.LB_PORT || 4100), '127.0.0.1', () => console.log('[lb] listening', process.env.LB_PORT || 4100, 'instances', ports.length, 'concurrency/instance', C));

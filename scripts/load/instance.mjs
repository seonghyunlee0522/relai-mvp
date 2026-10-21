// One simulated Vercel function instance: the real api/index.js handler (prod pool: max 2, idle 5 s, connect timeout 5 s, boot retry)
// behind a plain http server. Memory is sampled every 2 s to MEM_LOG (JSON lines). Usage: PORT=… node scripts/load/instance.mjs
import http from 'node:http';
import { appendFileSync } from 'node:fs';
import handler from '../../api/index.js';
const port = Number(process.env.PORT);
const tag = `i${port}`;
let inflight = 0, peak = 0;
http.createServer((req, res) => { inflight++; peak = Math.max(peak, inflight); res.on('close', () => { inflight--; }); handler(req, res); })
  .listen(port, '127.0.0.1', () => console.log(`[instance ${tag}] listening`));
if (process.env.MEM_LOG) setInterval(() => { const m = process.memoryUsage(); appendFileSync(process.env.MEM_LOG, JSON.stringify({ t: Date.now(), tag, rss: m.rss, heap: m.heapUsed, inflight, peak }) + '\n'); peak = inflight; }, 2000).unref();

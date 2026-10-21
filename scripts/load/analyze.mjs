// Summarise one run directory: latency p50/p95/p99 and error rate (overall and per step), peak DB connections and memory,
// peak live instances and per-instance RSS.  node scripts/load/analyze.mjs <OUT>
import { readFileSync, existsSync } from 'node:fs';
const dir = process.argv[2];
const jl = (f) => existsSync(`${dir}/${f}`) ? readFileSync(`${dir}/${f}`, 'utf8').trim().split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean) : [];
const req = jl('req.jsonl').filter((r) => r.step !== 'seed');
const pct = (a, p) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p / 100 * s.length))]; };
const isErr = (r) => r.err || r.status === 0 || r.status >= 500;
const sum = (rs) => ({ n: rs.length, p50: pct(rs.map((r) => r.ms), 50), p95: pct(rs.map((r) => r.ms), 95), p99: pct(rs.map((r) => r.ms), 99), max: Math.max(...rs.map((r) => r.ms)), err5xx: rs.filter(isErr).length, err4xx: rs.filter((r) => r.status >= 400 && r.status < 500).length });
const out = { overall: sum(req), steps: {} };
for (const s of [...new Set(req.map((r) => r.step))]) out.steps[s] = sum(req.filter((r) => r.step === s));
out.overall.errRate = +(100 * out.overall.err5xx / Math.max(1, out.overall.n)).toFixed(2);
const t = req.map((r) => r.t); out.overall.rps = +(req.length / Math.max(1, (Math.max(...t) - Math.min(...t)) / 1000)).toFixed(1);
const db = jl('db.jsonl').filter((d) => d.conns !== null);
out.db = { peakConns: Math.max(...db.map((d) => d.conns)), peakActive: Math.max(...db.map((d) => d.active)), peakLockWait: Math.max(...db.map((d) => d.lockwait)), peakMem: db.map((d) => d.mem).sort((a, b) => parseFloat(b) * (/G/.test(b) ? 1024 : 1) - parseFloat(a) * (/G/.test(a) ? 1024 : 1))[0] };
const lb = jl('lb.jsonl'); out.instances = { peakLive: Math.max(0, ...lb.map((l) => l.live)), peakInflightPerInstance: Math.max(0, ...lb.flatMap((l) => l.inflight)) };
const mem = jl('mem.jsonl'); out.instances.peakRssMB = Math.round(Math.max(0, ...mem.map((m) => m.rss)) / 1048576);
const errs = {}; for (const r of req.filter((r) => isErr(r) || r.status >= 400)) { const k = `${r.method} ${r.path} ${r.status} ${r.err || ''}`; errs[k] = (errs[k] || 0) + 1; } out.errors = errs;
console.log(JSON.stringify(out, null, 1));

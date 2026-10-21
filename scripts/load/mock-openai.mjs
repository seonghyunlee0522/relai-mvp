// Mock OpenAI endpoint with switchable failure modes for AI fault tests (OPENAI_BASE_URL=http://127.0.0.1:4199/v1).
//   curl :4199/__mode?m=500 | 429 | 401 | hang | garbage | ok
import http from 'node:http';
let mode = 'ok';
http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/__mode') { mode = u.searchParams.get('m'); return res.end(mode); }
  let body = ''; req.on('data', (d) => { body += d; }); req.on('end', () => {
    if (mode === 'hang') return;   // never answers: the app's AI_REQUEST_TIMEOUT_MS must cut it
    if (['500', '429', '401', '503'].includes(mode)) { res.writeHead(Number(mode), { 'content-type': 'application/json' }); return res.end(JSON.stringify({ error: { message: `mock ${mode} org-secret-detail` } })); }
    if (mode === 'garbage') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{"choices":[{"message":{"content":"not json at all"}}]}'); }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ answer: '모의 답변입니다.', references: [], warnings: [] }) } }], usage: { prompt_tokens: 10, completion_tokens: 10 } }));
  });
}).listen(4199, '127.0.0.1', () => console.log('[mock-openai] up'));

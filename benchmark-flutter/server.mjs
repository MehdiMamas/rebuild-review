// Mock API for the task-list fixture. node server.mjs (PORT, default 4301). It sets a cookie so the capture can prove cookies never reach the HAR.
import http from 'node:http';
const tasks = Array.from({ length: 40 }, (_, i) => ({ id: i + 1, title: `Task ${i + 1}`, done: i % 3 === 0 }));
http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const send = (code, body) => { res.writeHead(code, { 'content-type': 'application/json', 'set-cookie': 'srv=SETCOOKIESECRET123456789012345678; Path=/' }); res.end(JSON.stringify(body)); };
  let body = ''; req.on('data', (c) => (body += c));
  req.on('end', () => {
    const m = u.pathname.match(/^\/api\/tasks(?:\/(\d+))?$/);
    if (!m) return send(404, { error: 'not found' });
    if (m[1]) { const t = tasks.find((x) => x.id === Number(m[1])); return t ? send(200, t) : send(404, { error: 'no task' }); }
    if (req.method === 'POST') { const t = { id: tasks.length + 1, title: String(JSON.parse(body || '{}').title || '').trim() || 'Untitled', done: false }; tasks.push(t); return send(201, t); }
    send(200, tasks);
  });
}).listen(Number(process.env.PORT || 4301), '127.0.0.1');

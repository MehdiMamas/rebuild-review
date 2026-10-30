// Mock API plus static file server. Node only, localhost only, no accounts.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, 'dist');
const port = Number(process.env.PORT || 4173);
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };

const words = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel'];
let tasks = Array.from({ length: 120 }, (_, i) => ({
  id: i + 1,
  title: `${words[i % 8]} task ${i + 1}`,
  status: i % 3 === 0 ? 'done' : 'open',
  due: `2026-11-${String((i % 28) + 1).padStart(2, '0')}`,
}));
let settings = { name: 'Sam', email: 'sam@example.com' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const json = (res, code, body) => {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};
const readBody = (req) =>
  new Promise((r) => {
    let s = '';
    req.on('data', (c) => (s += c));
    req.on('end', () => r(s ? JSON.parse(s) : {}));
  });

// Flags (query string): slow=1 adds 1.5s, fail=list fails list loads, fail=save fails writes.
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const flags = url.searchParams;
  const slow = flags.get('slow') ? 1500 : 0;
  if (url.pathname === '/api/tasks' && req.method === 'GET') {
    const q = (flags.get('q') || '').toLowerCase();
    const status = flags.get('status') || '';
    // Shorter queries answer slower, so an old request can finish after a newer one.
    await sleep(slow + Math.max(0, 900 - 300 * q.length));
    if (flags.get('fail') === 'list') return json(res, 500, { error: 'list failed' });
    const items = tasks.filter(
      (t) => t.title.includes(q) && (!status || t.status === status),
    );
    return json(res, 200, { q, items });
  }
  const one = url.pathname.match(/^\/api\/tasks\/(\d+)$/);
  if (one && req.method === 'GET') {
    await sleep(100);
    const t = tasks.find((x) => x.id === Number(one[1]));
    return t ? json(res, 200, t) : json(res, 404, { error: 'not found' });
  }
  if (url.pathname === '/api/tasks' && req.method === 'POST') {
    const body = await readBody(req);
    if (flags.get('fail') === 'save') return json(res, 500, { error: 'save failed' });
    const t = { id: tasks.length + 1, title: body.title, status: 'open', due: '2026-12-01' };
    tasks.push(t);
    return json(res, 201, t);
  }
  if (url.pathname === '/api/settings' && req.method === 'PUT') {
    const body = await readBody(req);
    await sleep(slow);
    if (flags.get('fail') === 'save') return json(res, 500, { error: 'save failed' });
    settings = body;
    return json(res, 200, settings);
  }
  if (url.pathname === '/api/settings') return json(res, 200, settings);
  const file = url.pathname === '/' ? '/index.html' : url.pathname;
  const full = path.join(dist, path.normalize(file));
  if (!full.startsWith(dist) || !fs.existsSync(full) || fs.statSync(full).isDirectory()) {
    // Single page app: any other path serves the shell.
    res.writeHead(200, { 'content-type': 'text/html' });
    return res.end(fs.readFileSync(path.join(dist, 'index.html')));
  }
  res.writeHead(200, { 'content-type': types[path.extname(full)] || 'application/octet-stream' });
  res.end(fs.readFileSync(full));
});
server.listen(port, '127.0.0.1', () => console.log(`bench app on http://127.0.0.1:${port}`));

// A small items service with planted problems (known answers are in ../answers.json; only test/run.mjs reads them).
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';

const store = path.join(os.homedir(), '.items.json');
const load = () => { try { return JSON.parse(fs.readFileSync(store, 'utf8')); } catch { return [{ id: 'demo', name: 'first', createdAt: '2024-01-01T00:00:00Z' }]; } };
const save = (items) => fs.writeFileSync(store, JSON.stringify(items));
const send = (res, status, body, type = 'application/json') => { res.writeHead(status, { 'content-type': type }); res.end(typeof body === 'string' ? body : JSON.stringify(body)); };
const readBody = (req) => new Promise((resolve) => { let t = ''; req.on('data', (d) => (t += d)); req.on('end', () => resolve(t)); });

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  let m;
  try {
    // Links to the main routes, for discovery without an OpenAPI file (NO_INDEX=1 answers 404 here instead).
    if (req.method === 'GET' && p === '/' && !process.env.NO_INDEX) return send(res, 200, { name: 'items', links: [{ href: '/items' }, { href: '/session' }, { href: '/public' }] });
    if (req.method === 'GET' && p === '/openapi.json' && !process.env.NO_OPENAPI) return send(res, 200, fs.readFileSync(new URL('./openapi.json', import.meta.url), 'utf8'));
    if (req.method === 'GET' && p === '/items') return send(res, 200, load());
    if (req.method === 'POST' && p === '/items') {
      let body;
      try { body = JSON.parse(await readBody(req)); } catch { return send(res, 400, { error: 'invalid JSON' }); }
      if (typeof body !== 'object' || body === null) return send(res, 400, { error: 'expected an object' });
      // Planted: an empty object or a non-string name is not checked, and the next line throws.
      const name = body.name.trim();
      const items = load();
      const item = { id: crypto.randomBytes(4).toString('hex'), name, createdAt: new Date().toISOString() };
      items.push(item); save(items);
      return send(res, 201, item);
    }
    if ((m = /^\/items\/([\w-]+)$/.exec(p))) {
      const items = load();
      const item = items.find((i) => i.id === m[1]);
      if (!item) return send(res, 404, { error: 'not found' });
      if (req.method === 'GET') return send(res, 200, item);
      if (req.method === 'DELETE') { save(items.filter((i) => i !== item)); res.writeHead(204); return res.end(); }
    }
    if (req.method === 'GET' && p === '/admin') return send(res, req.headers['x-key'] ? 200 : 401, { error: 'unauthorized' });
    // Planted: a 404 that carries a stack trace.
    if (req.method === 'GET' && /^\/legacy\/[\w-]+$/.test(p)) return send(res, 404, { error: 'not found', stack: 'Error: not found\n    at lookup (/srv/app/legacy.js:10:5)\n    at handle (/srv/app/server.js:42:9)' });
    // Planted: an HTML error page on a JSON service.
    if (req.method === 'GET' && /^\/orders\/[\w-]+$/.test(p)) return send(res, 404, '<html><body><h1>Not Found</h1></body></html>', 'text/html');
    // Planted: a session token in the body.
    if (req.method === 'GET' && p === '/session') return send(res, 200, { user: 'demo', token: 'sk-0123456789abcdef0123456789abcdef0123' });
    // Planted: wildcard origin with credentials.
    if (req.method === 'GET' && p === '/public') { res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*', 'access-control-allow-credentials': 'true' }); return res.end('{"ok":true,"etag":"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"}'); }
    // Planted: never answers.
    if (req.method === 'GET' && p === '/slow') return;
    // Not in the OpenAPI file: fetches an address given in the query (the test points it outside the machine).
    if (req.method === 'GET' && p === '/fetch') {
      try { const r = await fetch(url.searchParams.get('url'), { signal: AbortSignal.timeout(3000) }); return send(res, 200, { status: r.status }); } catch (e) { return send(res, 502, { error: 'fetch failed' }); }
    }
    // Not in the OpenAPI file: what the service sees of this machine.
    if (req.method === 'GET' && p === '/env') return send(res, 200, { home: os.homedir(), tmp: os.tmpdir(), secret: process.env.RR_SECRET_PARENT || null });
    // Not in the OpenAPI file: leaves a child process running.
    if (req.method === 'GET' && p === '/spawn') { const c = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }); return send(res, 200, { pid: c.pid }); }
    return send(res, 404, { error: 'not found' });
  } catch (e) {
    return send(res, 500, { error: 'internal error' });
  }
}).listen(Number(process.env.PORT) || 3000, '127.0.0.1');

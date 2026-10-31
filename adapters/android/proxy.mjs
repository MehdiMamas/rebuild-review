// Recording proxy for the emulator (emulator -http-proxy). Only the app's own local API is passed on;
// everything else is refused and listed. Plain HTTP is recorded into a HAR with the same secret
// stripping as adapters/web/context.mjs. HTTPS is refused by host: no certificate is ever installed.
import http from 'node:http';
import { redactHeaders, redactUrl, sleep } from '../web/context.mjs';

const LOCAL = ['10.0.2.2', '127.0.0.1', 'localhost']; // 10.0.2.2 is the host as the emulator sees it

export async function startProxy({ apiPort }) {
  const st = { har: [], blocked: new Set(), notCaptured: new Set(), faults: [], inflight: 0, failed: 0, seen: 0, label: '' };
  const isOwn = (host, port) => LOCAL.includes(host) && Number(port) === Number(apiPort);
  const refuse = (what, https) => {
    st.blocked.add(redactUrl(what).replace(/^(?!\w+:)/, 'tcp://'));
    if (https) st.notCaptured.add(`HTTPS to ${what} was refused by host; no certificate is installed, so it is not captured`);
  };

  const server = http.createServer(async (req, res) => {
    st.seen++;
    let u;
    try { u = new URL(req.url.startsWith('http') ? req.url : `http://${req.headers.host}${req.url}`); } catch { res.writeHead(400); return res.end(); }
    if (!isOwn(u.hostname, u.port || 80)) { refuse(u.toString()); res.writeHead(403); return res.end('blocked by rebuild-review'); }
    const started = Date.now();
    st.inflight++;
    const finish = (status, resHeaders) => {
      st.inflight--;
      if (status >= 400) st.failed++;
      st.har.push({
        startedDateTime: new Date(started).toISOString(), time: Date.now() - started, _t: started, _screen: st.label,
        request: { method: req.method, url: redactUrl(`http://127.0.0.1:${apiPort}${u.pathname}${u.search}`), headers: redactHeaders(req.headers) },
        response: { status, headers: redactHeaders(resHeaders) },
      });
    };
    const url = u.toString();
    const slow = st.faults.filter((f) => f.slow && url.includes(f.match)).reduce((m, f) => Math.max(m, f.slow), 0);
    if (slow) await sleep(slow);
    if (st.faults.some((f) => f.fail && url.includes(f.match))) {
      const h = { 'content-type': 'application/json' };
      res.writeHead(500, h); res.end('{"error":"simulated failure"}'); return finish(500, h);
    }
    const headers = Object.fromEntries(Object.entries(req.headers).filter(([k]) => !k.startsWith('proxy-')));
    headers.host = `127.0.0.1:${apiPort}`;
    const up = http.request({ host: '127.0.0.1', port: apiPort, method: req.method, path: u.pathname + u.search, headers, agent: false }, (r) => {
      res.writeHead(r.statusCode, r.headers); r.pipe(res); r.on('end', () => finish(r.statusCode, r.headers));
    });
    up.on('error', () => { res.writeHead(502); res.end(); finish(502, {}); });
    req.pipe(up);
  });
  // The emulator may send even plain HTTP as CONNECT: a tunnel to the app's own API is served as HTTP here.
  server.on('connect', (req, socket, head) => {
    const [h, p] = req.url.split(':');
    socket.on('error', () => {});
    if (!isOwn(h, p)) { st.seen++; refuse(req.url, p === '443'); socket.end('HTTP/1.1 403 Forbidden\r\n\r\n'); return; }
    socket.write('HTTP/1.1 200 Connection established\r\n\r\n');
    if (head.length) socket.unshift(head);
    server.emit('connection', socket);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    port: server.address().port,
    state: st,
    fail: (match) => st.faults.push({ match, fail: true }),
    slow: (match, ms) => st.faults.push({ match, slow: ms }),
    clearFaults: () => { st.faults.length = 0; },
    mark: (label) => { st.label = label; },
    close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }),
  };
}

// Tiny site for the crawl and safety tests: a chain of pages linked one from the next, a cookie,
// an Authorization header and a request to an outside address.
import http from 'node:http';
const port = Number(process.env.PORT);
const outPort = process.env.OUT_PORT;
const page = (body) => `<!doctype html><title>t</title><body>${body}</body>`;
http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/api/ping') { res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': 'resp=SETCOOKIESECRET123456789012345678; Path=/' }); return res.end('{"ok":true}'); }
  const links = { '/': '/a', '/a': '/b', '/b': '/c', '/c': '' };
  if (!(u.pathname in links)) { res.writeHead(404); return res.end('no'); }
  res.writeHead(200, { 'content-type': 'text/html', 'set-cookie': 'sid=COOKIESECRET123456789012345678901; Path=/' });
  const next = links[u.pathname] ? `<a href="${links[u.pathname]}">next</a>` : '<p>end</p>';
  const script = u.pathname === '/'
    ? `<script>fetch('/api/ping?token=QUERYSECRET1234567890',{headers:{Authorization:'Bearer HEADERSECRET1234567890abcdefghij'}});fetch('http://localhost:${outPort}/leak').catch(()=>{});</script>` : '';
  res.end(page(`<h1>${u.pathname}</h1>${next}${script}`));
}).listen(port, '127.0.0.1');

// Tiny site for the sign-in tests. Public: /, /login. Behind the cookie: /dashboard, /dashboard/settings.
// The sign-in is bob / correct-horse-9 (stand-ins). Sign out is a button (POST /signout) and a link (GET /logout);
// both end the session on the server, not only in the cookie. Environment: PORT, HITLOG (file: one line per request),
// ANON=1 (a wrong password still gets a cookie; /start is a second sign-in form on a route with no sign-in word in its path), DROP=1 (the first /dashboard answer also ends every session).
import http from 'node:http';
import fs from 'node:fs';
const sessions = new Map(); // session id -> the email typed at sign-in, echoed on the dashboard and by /api/me
const page = (title, body) => `<!doctype html><title>${title}</title><body>${body}</body>`;
const form = (msg = '', action = '/login') => page('Sign in', `<h1>Sign in</h1>${msg}<form method="post" action="${action}">
<label for="u">Username</label><input id="u" name="u"><label for="p">Password</label><input id="p" name="p" type="password">
<label for="n">Nickname</label><input id="n" name="n"><label for="e">Email</label><input id="e" name="e"><button type="submit">Sign in</button></form>`);
const cookieOf = (req) => Object.fromEntries((req.headers.cookie || '').split(/;\s*/).filter(Boolean).map((c) => c.split('=')));
http.createServer((req, res) => {
  const path = new URL(req.url, 'http://x').pathname;
  const sid = cookieOf(req).sid;
  const signedIn = sessions.has(sid);
  if (process.env.HITLOG) fs.appendFileSync(process.env.HITLOG, `${req.method} ${path} ${signedIn ? 'in' : 'out'}\n`);
  const html = (code, body, extra = {}) => { res.writeHead(code, { 'content-type': 'text/html', ...extra }); res.end(body); };
  const go = (to, extra = {}) => { res.writeHead(303, { location: to, ...extra }); res.end(); };
  const revoke = () => sessions.delete(sid);
  if (req.method === 'POST' && (path === '/login' || path === '/start')) {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      const f = new URLSearchParams(body);
      if (f.get('u') === 'bob' && f.get('p') === 'correct-horse-9') {
        const t = Math.random().toString(36).slice(2);
        sessions.set(t, f.get('e') || '');
        return go('/', { 'set-cookie': `sid=${t}; Path=/; HttpOnly` });
      }
      html(200, form('<p>Wrong user name or password</p>', path), process.env.ANON ? { 'set-cookie': 'anon=1; Path=/' } : {});
    });
    return;
  }
  if (req.method === 'POST' && path === '/signout') { revoke(); return go('/login', { 'set-cookie': 'sid=; Path=/; Max-Age=0' }); }
  if (path === '/logout') { revoke(); return go('/login', { 'set-cookie': 'sid=; Path=/; Max-Age=0' }); }
  if (req.method === 'POST' && path === '/delete-account') { revoke(); return go('/login', { 'set-cookie': 'sid=; Path=/; Max-Age=0' }); }
  if (path === '/login') return html(200, form());
  if (path === '/start') return html(200, form('', '/start'));
  if (path === '/catalog/outlet') return html(200, page('Outlet', '<h1>Outlet</h1><p>Latest test items</p>'));
  if (path === '/api/me') return signedIn ? (res.writeHead(200, { 'content-type': 'application/json' }), res.end(JSON.stringify({ email: sessions.get(sid) }))) : html(401, 'no');
  if (path === '/admin') return signedIn ? html(403, page('Not allowed', '<h1>Not allowed</h1><p>Your account cannot open this page</p>')) : go('/login');
  if (path === '/') return html(200, page('Home', `<h1>Home</h1>${signedIn ? '<p>Welcome back</p>' : ''}<a href="/login">Sign in</a> <a href="/dashboard">Dashboard</a> <a href="/dashboard/settings">Settings</a>`));
  if (path === '/dashboard' || path === '/dashboard/settings') {
    if (!signedIn) return go('/login');
    if (path === '/dashboard') {
      html(200, page("bob's dashboard", `<h1>Signed in as bob</h1><a href="/dashboard/settings">Settings</a> <a href="/logout">Log out</a> <a href="/admin">Admin</a> <a href="/catalog/outlet">Outlet</a>
<p>Email: ${sessions.get(sid)}</p><p id="me"></p><script>fetch('/api/me').then((r) => r.json()).then((j) => { document.getElementById('me').textContent = 'API says ' + j.email; })</script>
<button type="button">Design outcomes</button>
<form method="post" action="/signout"><button type="submit">Sign out</button></form>
<form method="post" action="/delete-account"><button type="submit">Delete account</button></form>`));
      if (process.env.DROP) sessions.clear();
      return;
    }
    return html(200, page('Settings', '<h1>Settings for bob</h1><p>Notifications on</p>'));
  }
  html(404, 'no');
}).listen(Number(process.env.PORT), '127.0.0.1');

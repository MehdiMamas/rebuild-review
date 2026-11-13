// Tiny site for the sign-in tests. Public: /, /login. Behind the cookie: /dashboard, /dashboard/settings.
// The sign-in is bob / correct-horse-9 (stand-ins). Sign out is a button (POST /signout) and a link (GET /logout);
// both end the session on the server, not only in the cookie. Environment: PORT, HITLOG (file: one line per request),
// QUERY=1 (home links /items/1?tab=open, public, and /items/1?tab=private, sign-in only), FLAKY=1 (home links /flaky: the first answer is the page, every later one redirects to /login),
// SHARE=1 (home links /x?tab=a, always fine, and /x?tab=b, fine once then a redirect to /login; both slug to x),
// LATE=1 (home links /late: fine for its first five answers, the crawl and four shots, then every one redirects to /login, so only the probes lose the session),
// MID=1 (home links /mid: fine for two answers, the crawl and the first shot, then redirects: the loss comes at the second shot),
// CALLBACK=1 (home links /signin/callback, which redirects to /login whoever asks),
// ANON=1 (a wrong password still gets a cookie; /start is a second sign-in form on a route with no sign-in word in its path), DROP=1 (the first /dashboard answer also ends every session).
import http from 'node:http';
import fs from 'node:fs';
let flaky = 0, flakyB = 0, late = 0, mid = 0;
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
  const q = new URL(req.url, 'http://x').searchParams.get('tab');
  if (path === '/items/1') return q === 'private' && !signedIn ? go('/login') : html(200, page('Item ' + q, '<h1>Item 1</h1><p>Tab ' + q + '</p>'));
  if (path === '/x') { if (q === 'b') { flakyB++; if (flakyB > 1) return go('/login'); } return html(200, page('X ' + q, '<h1>X</h1><p>Tab ' + q + '</p>')); }
  if (path === '/late') { late++; return late > 5 ? go('/login') : html(200, page('Late', '<h1>Late</h1><p>Shown five times</p>')); }
  if (path === '/mid') { mid++; return mid > 2 ? go('/login') : html(200, page('Mid', '<h1>Mid</h1><p>Shown twice</p>')); }
  if (path === '/signin/callback') return go('/login');
  if (path === '/flaky') { flaky++; return flaky > 1 ? go('/login') : html(200, page('Flaky', '<h1>Flaky</h1><p>Shown once</p>')); }
  if (path === '/') return html(200, page('Home', `<h1>Home</h1>${signedIn ? '<p>Welcome back</p>' : ''}${process.env.QUERY ? '<a href="/items/1?tab=open">Open</a> <a href="/items/1?tab=private">Private</a>' : ''}${process.env.SHARE ? '<a href="/x?tab=a">A</a> <a href="/x?tab=b">B</a>' : ''}${process.env.LATE ? '<a href="/late">Late</a>' : ''}${process.env.MID ? '<a href="/mid">Mid</a>' : ''}${process.env.CALLBACK ? '<a href="/signin/callback">Callback</a>' : ''}${process.env.FLAKY ? '<a href="/flaky">Flaky</a>' : ''}<a href="/login">Sign in</a> <a href="/dashboard">Dashboard</a> <a href="/dashboard/settings">Settings</a>`));
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

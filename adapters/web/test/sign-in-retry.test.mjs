// signIn on a slow or fussy sign-in page: a button that never holds still, a late redirect, a first try that misses.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { chromium } from 'playwright';
import { signIn } from '../auth.mjs';

const PASSWORD = 'correct-horse-9';
let posts = 0;
const form = (mode) => `<!doctype html><title>Sign in</title><style>@keyframes w { from { transform: translateX(0) } to { transform: translateX(8px) } }
.wobble { animation: w 0.2s infinite alternate }</style><h1>Sign in</h1><form method="post" action="/login?mode=${mode}">
<label for="u">Username</label><input id="u" name="u"><label for="p">Password</label><input id="p" name="p" type="password">
<button type="submit" class="${mode === 'wobble' ? 'wobble' : ''}">Sign in</button></form>${mode === 'slow' ? SLOW_JS : ''}`;
// slow: like a client-rendered app, the form posts with fetch and the page moves on 6 s after the answer
const SLOW_JS = `<script>document.querySelector('form').addEventListener('submit', async (ev) => {
  ev.preventDefault(); const r = await fetch(ev.target.action, { method: 'POST', body: new URLSearchParams(new FormData(ev.target)) });
  if (r.ok) setTimeout(() => { location.href = '/dashboard'; }, 6000); });</script>`;
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const mode = u.searchParams.get('mode') || '';
  if (req.method === 'POST' && u.pathname === '/login') {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      posts++;
      const f = new URLSearchParams(body);
      const right = f.get('u') === 'bob' && f.get('p') === PASSWORD;
      // firstfail: the first right answer is missed, as when a click lands before the page is ready
      if (!right || (mode === 'firstfail' && posts === 1)) { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(form(mode)); }
      if (mode === 'slow') { res.writeHead(200, { 'set-cookie': 'sid=1; Path=/' }); return res.end('ok'); }
      res.writeHead(303, { location: '/dashboard', 'set-cookie': 'sid=1; Path=/' }); res.end();
    });
    return;
  }
  if (u.pathname === '/login') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(form(mode)); }
  if (u.pathname === '/dashboard') {
    if (!/sid=1/.test(req.headers.cookie || '')) { res.writeHead(303, { location: '/login' }); return res.end(); }
    res.writeHead(200, { 'content-type': 'text/html' }); return res.end('<!doctype html><title>Dashboard</title><h1>Dashboard</h1>');
  }
  res.writeHead(404); res.end();
});
let browser, origin;
test.before(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch();
});
test.after(async () => { await browser.close(); server.close(); });
const auth = (mode, password = PASSWORD) => ({ steps: [{ open: `/login?mode=${mode}` }, { type: { into: 'Username', text: 'bob' } }, { type: { into: 'Password', text: password } }, { click: 'Sign in' }], expect: { path: '/dashboard' } });

test('a sign-in button that never stops moving is still clicked', async () => {
  const r = await signIn(browser, origin, auth('wobble'), [], { attempts: 1, clickMs: 1500 });
  assert.equal(r.ok, true, r.reason);
});

test('a redirect that comes late is waited for; with no wait it is a failure', async () => {
  const late = await signIn(browser, origin, auth('slow'), [], { attempts: 1 });
  assert.equal(late.ok, true, late.reason);
  const short = await signIn(browser, origin, auth('slow'), [], { attempts: 1, landMs: 200 });
  assert.equal(short.ok, false);
  assert.match(short.reason, /^sign-in ended on \/login, expected \/dashboard$/);
});

test('a first try that misses is tried again in a fresh context', async () => {
  posts = 0;
  const once = await signIn(browser, origin, auth('firstfail'), [], { attempts: 1, landMs: 500 });
  assert.equal(once.ok, false);
  posts = 0;
  const r = await signIn(browser, origin, auth('firstfail'), [], { attempts: 2, landMs: 500 });
  assert.equal(r.ok, true, r.reason);
  assert.equal(posts, 2);
});

test('a wrong password fails every try, says how many, and never shows the typed value', async () => {
  const r = await signIn(browser, origin, auth('', 'wrong-pass-123'), [], { attempts: 2, landMs: 300 });
  assert.equal(r.ok, false);
  assert.match(r.reason, /\(tried 2 times\)$/);
  assert.ok(!r.reason.includes('wrong-pass-123') && !r.reason.includes('bob'));
});

// auth.create: sign-in fails until the sign-up form has been submitted once.
const made = new Set();
const page2 = (title, action, button) => `<!doctype html><title>${title}</title><h1>${title}</h1><form method="post" action="${action}">
<label for="e">Email</label><input id="e" name="e"><label for="p">Password</label><input id="p" name="p" type="password"><button type="submit">${button}</button></form>`;
const server2 = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (req.method === 'POST') {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      const f = new URLSearchParams(body);
      if (u.pathname === '/signup') { made.add(f.get('e') + '|' + f.get('p')); res.writeHead(200, { 'content-type': 'text/html' }); return res.end('<h1>Welcome</h1>'); }
      if (made.has(f.get('e') + '|' + f.get('p'))) { res.writeHead(303, { location: '/home', 'set-cookie': 'sid=1; Path=/' }); return res.end(); }
      res.writeHead(200, { 'content-type': 'text/html' }); res.end(page2('Sign in', '/login', 'Sign in'));
    });
    return;
  }
  if (u.pathname === '/home') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end('<!doctype html><title>Home</title><h1>Home</h1>'); }
  const signup = u.pathname === '/signup';
  res.writeHead(200, { 'content-type': 'text/html' }); res.end(signup ? page2('Sign up', '/signup', 'Create account') : page2('Sign in', '/login', 'Sign in'));
});
const SECRET = 'create-pass-77';
const auth2 = (create) => ({
  steps: [{ open: '/login' }, { type: { into: 'Email', text: 'a@example.test' } }, { type: { into: 'Password', text: SECRET } }, { click: 'Sign in' }],
  expect: { path: '/home' },
  ...(create ? { create } : {}),
});
const createSteps = (button = 'Create account') => [{ open: '/signup' }, { type: { into: 'Email', text: 'a@example.test' } }, { type: { into: 'Password', text: SECRET } }, { click: button }];
const quick = { attempts: 1, clickMs: 1500, landMs: 500 };

test('auth.create makes the account when sign-in fails, then signs in', async () => {
  made.clear();
  await new Promise((r) => server2.listen(0, '127.0.0.1', r));
  const o2 = `http://127.0.0.1:${server2.address().port}`;
  try {
    const r = await signIn(browser, o2, auth2(createSteps()), [], quick);
    assert.equal(r.ok, true, r.reason);
    assert.equal(r.created, true);
    made.clear();
    const no = await signIn(browser, o2, auth2(), [], { ...quick, attempts: 2 });
    assert.equal(no.ok, false);
    assert.match(no.reason, /\(tried 2 times\)$/);
    assert.equal(no.created, undefined);
    const bad = await signIn(browser, o2, auth2(createSteps('No such button')), [], quick);
    assert.equal(bad.ok, false);
    assert.match(bad.reason, /after creating the account: .*; the create steps failed at step 4 \(click\)/);
    assert.ok(!bad.reason.includes(SECRET) && !bad.reason.includes('a@example.test'));
  } finally { server2.close(); }
});

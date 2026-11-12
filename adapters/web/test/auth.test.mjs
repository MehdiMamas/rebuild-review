// Sign-in for the web capture (run.json auth). Each capture runs against site-auth.mjs in a child process.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { validateAuth, authSecrets, redactSecrets, LOGIN_RE } from '../auth.mjs';
import { endsSession, endsSessionPath } from '../context.mjs';
import { coverage } from '../../../scripts/areas.mjs';
import { filterGolden } from '../../../scripts/room.mjs';

const here = path.dirname(new URL(import.meta.url).pathname);
const capture = path.join(here, '..', 'capture.mjs');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-auth-test-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const PASSWORD = 'correct-horse-9', EMAIL = 'pat.lee@example.test';
const signInSteps = (password = PASSWORD, open = '/login?via=steps') => [{ open }, { type: { into: 'Username', text: 'bob' } }, { type: { into: 'Nickname', text: 'q' } }, { type: { into: 'Email', text: EMAIL } }, { type: { into: 'Password', text: password } }, { click: 'Sign in' }];
const json = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
let nextPort = 4351;

const cache = new Map();
// Runs capture once per name; returns the run folder, the process result and the request log.
function cap(name, { auth, env = {}, args = [] } = {}) {
  if (cache.has(name)) return cache.get(name);
  const runDir = path.join(tmp, name), port = nextPort++;
  fs.mkdirSync(path.join(runDir, 'work'), { recursive: true });
  fs.copyFileSync(path.join(here, 'site-auth.mjs'), path.join(runDir, 'work', 'site-auth.mjs'));
  spawnSync('git', ['init', '-q'], { cwd: path.join(runDir, 'work') }); // areas.mjs counts the work copy's tracked files
  spawnSync('git', ['add', '-A'], { cwd: path.join(runDir, 'work') });
  const hitlog = path.join(runDir, 'hits.log');
  const run = { platform: 'web', start: 'node site-auth.mjs', address: `http://127.0.0.1:${port}`, env: { HITLOG: hitlog, ...env } };
  if (auth !== undefined) run.auth = auth;
  fs.writeFileSync(path.join(runDir, 'run.json'), JSON.stringify(run));
  const r = spawnSync('node', [capture, '--app', path.join(runDir, 'run.json'), '--out', path.join(runDir, 'golden'), ...args], { encoding: 'utf8' });
  const hits = fs.existsSync(hitlog) ? fs.readFileSync(hitlog, 'utf8').split('\n').filter(Boolean) : [];
  const out = { runDir, golden: path.join(runDir, 'golden'), r, hits };
  cache.set(name, out);
  return out;
}
const cov = (c) => json(path.join(c.golden, 'coverage.json'));
const files = (d) => fs.readdirSync(d, { recursive: true }).map((f) => path.join(d, f)).filter((f) => fs.statSync(f).isFile());

test('given no auth in run.json -> capture behaves as before, signed-out, and coverage.json lists "behind a sign-in, not reached" for /dashboard and /dashboard/settings', () => {
  const c = cap('none');
  assert.equal(c.r.status, 0, c.r.stderr);
  const v = cov(c);
  assert.deepEqual(v.auth, { given: false, signedIn: false });
  assert.deepEqual(v.behindSignIn, ['/dashboard', '/dashboard/settings']);
  assert.deepEqual(v.screensCapturedWithSession, []);
  assert.ok(v.screensReached.includes('/') && v.screensReached.includes('/login'));
  const area = coverage(c.runDir);
  assert.ok(area.notReached.includes('behind a sign-in, not reached: /dashboard, /dashboard/settings (no auth in run.json)'), area.notReached.join(' | '));
});

test('given a signed-out run where /dashboard redirects -> it is in behindSignIn and not in screensReached', () => {
  const v = cov(cap('none'));
  assert.ok(v.behindSignIn.includes('/dashboard'));
  assert.ok(!v.screensReached.includes('/dashboard') && !v.screensReached.includes('/dashboard/settings'));
});

test('given auth steps that sign in -> the crawl reaches /dashboard and /dashboard/settings, coverage.json has auth.signedIn true and both in screensCapturedWithSession, and the dashboard screenshot is not the sign-in page', () => {
  const c = cap('good', { auth: { steps: signInSteps() } });
  assert.equal(c.r.status, 0, c.r.stderr);
  const v = cov(c);
  assert.equal(v.auth.signedIn, true);
  assert.deepEqual(v.behindSignIn, []);
  for (const u of ['/dashboard', '/dashboard/settings']) assert.ok(v.screensCapturedWithSession.includes(u) && v.screensReached.includes(u), u);
  const html = fs.readFileSync(path.join(c.golden, 'screens', 'dashboard', 'render.html'), 'utf8');
  assert.match(html, /Signed in as \*\*\*/);
  assert.doesNotMatch(html, /<h1>Sign in<\/h1>/);
  assert.ok(fs.statSync(path.join(c.golden, 'screens', 'dashboard', '1440-light.png')).size > 0);
  const area = coverage(c.runDir);
  assert.equal(area.screens.withSession, v.screensCapturedWithSession.length);
});

test('given auth steps with a wrong password -> capture continues signed out, coverage.json has auth.signedIn false and a reason that does not contain the password, and the exit code is 0', () => {
  const c = cap('wrong', { auth: { steps: signInSteps('wrong-pass-77') } });
  assert.equal(c.r.status, 0, c.r.stderr);
  const v = cov(c);
  assert.equal(v.auth.signedIn, false);
  assert.ok(v.auth.reason && !v.auth.reason.includes('wrong-pass-77'), v.auth.reason);
  assert.deepEqual(v.behindSignIn, ['/dashboard', '/dashboard/settings']);
  assert.match(coverage(c.runDir).notReached.join('\n'), /\(sign-in failed: /);
});

test('given a wrong password where the app sets an anonymous cookie anyway -> signedIn false', () => {
  const c = cap('anon', { auth: { steps: signInSteps('wrong-pass-77') }, env: { ANON: '1' }, args: ['--max-screens', '2'] });
  assert.equal(c.r.status, 0, c.r.stderr);
  assert.equal(cov(c).auth.signedIn, false);
});

test('given an auth step that names a field the page does not have -> the reason says which step number failed and holds none of the typed values', () => {
  const c = cap('nofield', { auth: { steps: [{ open: '/login' }, { type: { into: 'Username', text: 'bob' } }, { type: { into: 'Security answer', text: 'typed-value-4242' } }] }, args: ['--max-screens', '1'] });
  assert.equal(c.r.status, 0, c.r.stderr);
  const v = cov(c);
  assert.equal(v.auth.signedIn, false);
  assert.match(v.auth.reason, /^auth step 3 \(type\) failed: /);
  assert.ok(!v.auth.reason.includes('typed-value-4242'));
});

test('given a stand-in password, user name and an email the app echoes on a page -> none appears in any text file under golden/ (render.html, a11y.json, the HAR included), in stdout or in stderr', () => {
  const c = cap('good', { auth: { steps: signInSteps() } });
  const all = files(c.golden);
  assert.ok(all.length > 10);
  const text = all.filter((f) => !f.endsWith('.png'));
  for (const f of text) for (const v of [PASSWORD, EMAIL, 'bob']) assert.ok(!fs.readFileSync(f, 'utf8').includes(v), `${v} in ${path.relative(c.golden, f)}`);
  assert.match(fs.readFileSync(path.join(c.golden, 'screens', 'dashboard', 'render.html'), 'utf8'), /Email: \*\*\*/);
  for (const v of [PASSWORD, EMAIL]) assert.ok(!c.r.stdout.includes(v) && !c.r.stderr.includes(v));
  assert.ok(json(path.join(c.golden, 'manifest.json')).screens.some((s) => s.title === "***'s dashboard"), 'a 3-character value is masked as a whole value');
  const har = json(path.join(c.golden, 'network.har')).log.entries;
  assert.ok(har.length > 0 && !har.some((e) => e.request.url.includes('via=steps')), 'the sign-in context is not recorded');
});

test('given the room copy of a golden/ whose text files echo the email -> the second guard holds it nowhere, even when the capture left it in', () => {
  const c = cap('good', { auth: { steps: signInSteps() } });
  const leaky = path.join(tmp, 'leaky-golden');
  fs.cpSync(c.golden, leaky, { recursive: true });
  fs.appendFileSync(path.join(leaky, 'screens', 'dashboard', 'render.html'), `<p>${EMAIL}</p>`);
  const copy = path.join(tmp, 'leaky-copy');
  filterGolden(leaky, copy, [EMAIL, 'bob', PASSWORD]);
  for (const f of files(copy).filter((f) => !f.endsWith('.png'))) assert.ok(!fs.readFileSync(f, 'utf8').includes(EMAIL), path.relative(copy, f));
});

test('given a Sign out button, a Delete account button and a "Design outcomes" button on a signed-in screen -> only the first two are never pressed, and the rest of the crawl is still signed in', () => {
  const c = cap('good', { auth: { steps: signInSteps() } });
  const v = cov(c);
  const labels = v.signOutSkipped.map((x) => x.label);
  assert.ok(labels.includes('Delete account'), JSON.stringify(labels));
  assert.ok(!labels.includes('Design outcomes'), JSON.stringify(labels));
  assert.ok(!labels.includes('/catalog/outlet') && v.screensReached.includes('/catalog/outlet'), 'an ordinary link whose path holds "log" and "out" is followed');
  assert.ok(!c.hits.some((h) => h.startsWith('POST /delete-account')), 'the delete button was pressed');
  assert.ok(v.screensReached.includes('/dashboard/settings'));
});

test('given a 403 on a route while signed in -> it is listed as refused while signed in, not as behind a sign-in', () => {
  const c = cap('good', { auth: { steps: signInSteps() } });
  const v = cov(c);
  assert.deepEqual(v.refusedSignedIn, ['/admin']);
  assert.ok(!v.behindSignIn.includes('/admin'), JSON.stringify(v.behindSignIn));
  assert.ok(!v.screensReached.includes('/admin'));
  assert.ok(json(path.join(c.golden, 'manifest.json')).notCaptured.includes('refused (401/403) while signed in, not captured: /admin'));
  assert.ok(coverage(c.runDir).notReached.includes('refused (401/403) while signed in, not reached: /admin'));
});

test('given a sign-in form on a route with no sign-in word, a wrong password and an anonymous cookie -> the page never left the form, so signedIn is false with a reason', () => {
  const c = cap('start-wrong', { auth: { steps: signInSteps('wrong-pass-77', '/start') }, env: { ANON: '1' }, args: ['--max-screens', '2'] });
  assert.equal(c.r.status, 0, c.r.stderr);
  const v = cov(c);
  assert.equal(v.auth.signedIn, false);
  assert.match(v.auth.reason, /still the sign-in form/);
  assert.ok(!v.auth.reason.includes('wrong-pass-77'));
  assert.deepEqual(v.screensCapturedWithSession, []);
});

test('given the same form on that route and the right password -> signedIn is true', () => {
  const c = cap('start-right', { auth: { steps: signInSteps(PASSWORD, '/start') }, args: ['--max-screens', '2'] });
  assert.equal(cov(c).auth.signedIn, true);
});

test('given labels and paths -> only whole words and path segments end the session', () => {
  for (const l of ['Sign out', 'Log out', 'Logout', 'sign-out', 'Signout', 'Log off']) assert.ok(endsSession(l), l);
  for (const l of ['Design outcomes', 'Catalog outlet', 'Blog outdoors', 'Assign outstanding']) assert.equal(endsSession(l), false, l);
  for (const p of ['/logout', '/auth/log-out/', '/signout', '/sign_out']) assert.ok(endsSessionPath(p), p);
  for (const p of ['/catalog/outlet', '/blog/outdoors', '/design/outcomes', '/catalog/index']) assert.equal(endsSessionPath(p), false, p);
  for (const l of ['Delete account', 'Delete my account', 'Close account', 'Deactivate', 'Remove your profile']) assert.ok(endsSession(l, true) && !endsSession(l, false), l);
  for (const l of ['Delete item', 'Close', 'Close dialog', 'Remove from cart', 'Account settings']) assert.equal(endsSession(l, true), false, l);
  for (const p of ['/account/delete', '/delete-account', '/deactivate']) assert.ok(endsSessionPath(p, true), p);
});

test('given paths -> LOGIN_RE matches sign-in segments only', () => {
  for (const p of ['/login', '/log-in', '/auth/signin', '/sign_in/', '/users/sign-in']) assert.ok(LOGIN_RE.test(p), p);
  for (const p of ['/catalog/index', '/dialog-info', '/blog/inbox', '/', '/dashboard']) assert.equal(LOGIN_RE.test(p), false, p);
});

test('given a "Sign out" button on a signed-in screen -> the crawl does not press it and the later screens are still reached signed in', () => {
  const c = cap('good', { auth: { steps: signInSteps() } });
  const v = cov(c);
  assert.ok(v.signOutSkipped.some((x) => x.screen === '/dashboard' && x.label === 'Sign out'), JSON.stringify(v.signOutSkipped));
  assert.ok(!c.hits.some((h) => h.startsWith('POST /signout')), 'the button was pressed');
  assert.ok(v.screensCapturedWithSession.includes('/dashboard/settings'));
});

test('given a GET /logout link and a server-side revoke on sign-out -> later screens and probes are still signed in', () => {
  const c = cap('good', { auth: { steps: signInSteps() } });
  const v = cov(c);
  assert.ok(v.signOutSkipped.some((x) => x.label === '/logout'), JSON.stringify(v.signOutSkipped));
  assert.ok(!c.hits.some((h) => h.startsWith('GET /logout') || h.startsWith('POST /signout')));
  const dash = c.hits.filter((h) => /^GET \/dashboard(\/settings)? /.test(h));
  assert.ok(dash.length > 8, 'screens and probes loaded the signed-in routes');
  assert.ok(dash.every((h) => h.endsWith(' in')), dash.filter((h) => h.endsWith(' out')).join(', '));
});

test('given a signed-in session whose cookie the app drops mid-crawl -> that route is listed in behindSignIn, not as a captured signed-in screen', () => {
  const c = cap('drop', { auth: { steps: signInSteps() }, env: { DROP: '1' }, args: ['--max-screens', '3'] });
  assert.equal(c.r.status, 0, c.r.stderr);
  const v = cov(c);
  assert.equal(v.auth.signedIn, true);
  assert.ok(v.behindSignIn.includes('/dashboard/settings'), JSON.stringify(v.behindSignIn));
  assert.ok(!v.screensReached.includes('/dashboard/settings') && !v.screensCapturedWithSession.includes('/dashboard/settings'));
});

test('given auth with expect -> the final path or visible text decides signedIn', () => {
  const steps = signInSteps();
  const run = (name, expect) => cap(name, { auth: { steps, expect }, args: ['--max-screens', '1'] });
  const wrongPath = run('expect-path', { path: '/dashboard' });
  assert.equal(cov(wrongPath).auth.signedIn, false);
  assert.match(cov(wrongPath).auth.reason, /ended on \/, expected \/dashboard/);
  assert.equal(cov(run('expect-text', { text: 'Welcome back' })).auth.signedIn, true);
  assert.equal(cov(run('expect-nope', { text: 'Never shown' })).auth.signedIn, false);
});

test('given an auth block that is not an object, or has no steps, or has an unknown step -> capture stops before capturing with a message that holds no value, and no golden/ files are written', () => {
  const secret = 'secret-value-9';
  const blocks = ['secret-value-9', { steps: [] }, { steps: [{ typo: secret }] }, { steps: [{ failRequest: secret }] }, { steps: [{ type: { into: 'Password', text: 7 } }] }, { steps: [{ open: '/login' }], expect: secret }];
  blocks.forEach((auth, i) => {
    const runDir = path.join(tmp, `bad-${i}`);
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(path.join(runDir, 'run.json'), JSON.stringify({ platform: 'web', start: 'node nothing.mjs', address: 'http://127.0.0.1:4399', auth }));
    const r = spawnSync('node', [capture, '--app', path.join(runDir, 'run.json'), '--out', path.join(runDir, 'golden')], { encoding: 'utf8' });
    assert.notEqual(r.status, 0, `case ${i}`);
    assert.match(r.stderr, /^error: auth/m, `case ${i}: ${r.stderr}`);
    assert.ok(!(r.stdout + r.stderr).includes(secret), `case ${i}`);
    assert.equal(fs.existsSync(path.join(runDir, 'golden')), false, `case ${i}`);
  });
});

test('given values of any length in auth -> each is masked as a whole value and ordinary words that contain it are left alone', () => {
  const auth = { steps: [{ open: '/login' }, { type: { into: 'Nickname', text: 'q' } }, { type: { into: 'Username', text: 'bob' } }, { type: { into: 'Password', text: 'test' } }] };
  assert.doesNotThrow(() => validateAuth(auth));
  assert.deepEqual(authSecrets(auth), ['test', 'bob', 'q']);
  assert.equal(redactSecrets('the latest test: bob, bobby and q?', authSecrets(auth)), 'the latest ***: ***, bobby and ***?');
  assert.equal(redactSecrets('latest contest tests', authSecrets(auth)), 'latest contest tests');
  assert.equal(redactSecrets('pw!x and pw!', authSecrets({ steps: [{ type: { into: 'x', text: 'pw!' } }] })), '***x and ***');
  assert.equal(redactSecrets('a.b and axb', authSecrets({ steps: [{ type: { into: 'x', text: 'a.b' } }] })), '*** and axb');
  assert.deepEqual(authSecrets({ steps: [{ type: { into: 'x', text: '' } }] }), []);
  assert.equal(redactSecrets('anything a', []), 'anything a');
});

test('given a typed value with HTML characters -> its escaped forms are masked as well', () => {
  const s = authSecrets({ steps: [{ type: { into: 'x', text: 'a&b1234' } }] });
  assert.equal(redactSecrets('<i>a&amp;b1234</i> a&b1234', s), '<i>***</i> ***');
  const q = authSecrets({ steps: [{ type: { into: 'x', text: `it's "x"` } }] });
  assert.equal(redactSecrets('it&#39;s &quot;x&quot; it&#x27;s &quot;x&quot;', q), '*** ***');
});

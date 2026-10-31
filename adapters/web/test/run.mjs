// Six tests from issue #5, run against a bench:init copy of the fixture (never the repo folder, which holds answers.json).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFileSync, spawnSync, spawn } from 'node:child_process';
import { startApp } from '../app.mjs';

const here = path.dirname(new URL(import.meta.url).pathname);
const repo = path.resolve(here, '../../..');
const capture = path.join(here, '..', 'capture.mjs');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-capture-test-'));
const results = [];
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ': ' + detail : ''}`); };
const read = (f) => fs.readFileSync(f, 'utf8');
const json = (f) => JSON.parse(read(f));
const listFiles = (d) => fs.readdirSync(d, { recursive: true }).filter((f) => fs.statSync(path.join(d, f)).isFile()).sort();

// Fixture: a bench:init copy is the "target"; capture works on a clone of it in <runDir>/work.
const target = path.join(tmp, 'target');
execFileSync('node', [path.join(repo, 'benchmark/init-history.mjs'), target], { stdio: 'pipe' });
function setupRun(name, port) {
  const runDir = path.join(tmp, name);
  fs.mkdirSync(runDir, { recursive: true });
  execFileSync('git', ['clone', '-q', target, path.join(runDir, 'work')]);
  fs.writeFileSync(path.join(runDir, 'run.json'), JSON.stringify({ platform: 'web', dir: 'app', install: 'npm install --no-audit --no-fund', build: 'npm run build', start: 'node server.mjs', address: `http://127.0.0.1:${port}` }));
  return runDir;
}
const states = path.join(tmp, 'states.json');
fs.writeFileSync(states, JSON.stringify([
  { id: 'list-error', steps: [{ failRequest: '/api/tasks' }, { open: '/' }, { wait: 500 }] },
  { id: 'bad-type', steps: [{ open: '/' }, { type: { target: 'x', text: 'y' } }] },
  { id: 'bad-fail', steps: [{ failRequest: { match: '/api/tasks', status: 500 } }, { open: '/' }] },
  { id: 'list-loading', steps: [{ slowRequest: { match: '/api/tasks', ms: 2000 } }, { open: '/' }, { wait: 300 }] },
]));
const runCapture = (runDir, extra = []) => spawnSync('node', [capture, '--app', path.join(runDir, 'run.json'), '--out', path.join(runDir, 'golden'), ...extra], { encoding: 'utf8', env: process.env });

const run1 = setupRun('run1', 4231);
const r1 = runCapture(run1, ['--states', states]);
console.log(r1.stdout.trim().split('\n').pop(), r1.status === 0 ? '' : r1.stderr);
const g1 = path.join(run1, 'golden');
const m1 = json(path.join(g1, 'manifest.json'));

// Test 1: all routes, including ones reachable only through links (site: / -> /a -> /b -> /c).
const siteRun = path.join(tmp, 'site');
fs.mkdirSync(path.join(siteRun, 'work'), { recursive: true });
fs.copyFileSync(path.join(here, 'site.mjs'), path.join(siteRun, 'work/site.mjs'));
fs.writeFileSync(path.join(siteRun, 'run.json'), JSON.stringify({ platform: 'web', start: 'node site.mjs', address: 'http://127.0.0.1:4232' }));
let hits = 0;
const outside = http.createServer((q, s) => { hits++; s.end('x'); }).listen(4233);
await new Promise((r) => outside.on('listening', r));
process.env.OUT_PORT = '4233';
const rs = runCapture(siteRun);
const ms = json(path.join(siteRun, 'golden/manifest.json'));
const siteIds = ms.screens.map((s) => s.url).sort();
check('1 crawl finds every route, including link-only ones', JSON.stringify(siteIds) === JSON.stringify(['/', '/a', '/b', '/c']) && m1.screens.some((s) => s.url === '/'), `site screens ${siteIds.join(' ')}; fixture screens ${m1.screens.map((s) => s.url).join(' ')}`);

// Test 2: error and loading states.
const errHtml = fs.existsSync(path.join(g1, 'screens/list-error/render.html')) ? read(path.join(g1, 'screens/list-error/render.html')) : '';
const loadHtml = fs.existsSync(path.join(g1, 'screens/list-loading/render.html')) ? read(path.join(g1, 'screens/list-loading/render.html')) : 'missing';
check('2 states.json captures the error and loading states', errHtml.includes('Could not load tasks') && !loadHtml.includes('data-testid="row"') && loadHtml !== 'missing' && fs.existsSync(path.join(g1, 'screens/list-loading/1440-light.png')), `error state shows banner: ${errHtml.includes('Could not load tasks')}; loading state has no rows yet: ${!loadHtml.includes('data-testid="row"')}`);

// Test 2b: malformed steps are reported, a valid failRequest string still captures.
const nc = m1.notCaptured.join('\n');
check('2b bad type and object failRequest listed as bad step; valid failRequest captured', /state bad-type: bad step/.test(nc) && /state bad-fail: bad step/.test(nc) && errHtml.includes('Could not load tasks'), nc.split('\n').filter((l) => l.includes('bad-')).join(' | ') || 'none listed');

// Test 3: probes.json against answers.json (read here only, never by capture code).
const answers = json(path.join(repo, 'benchmark/answers.json'));
const probeOf = { D1: 'input-delay', D2: 'focus-lost', D3: 'layout-shift', D5: 'repeat-requests', D6: 'no-feedback-slow', D7: 'failed-request-no-error' };
const probes = json(path.join(g1, 'probes.json'));
const table = [];
for (const a of answers.filter((x) => x.kind === 'defect')) {
  const p = probeOf[a.id];
  const flags = p ? probes.filter((x) => x.probe === p && !x.passed) : [];
  table.push({ id: a.id, probe: p || '(no probe)', flagged: flags.length > 0, evidence: flags[0] ? flags[0].evidence : '' });
}
console.log('defect | probe | flagged | evidence');
for (const t of table) console.log(`${t.id} | ${t.probe} | ${t.flagged ? 'FLAGGED' : 'missed'} | ${t.evidence.slice(0, 110)}`);
// D1 (whole list re-renders per keystroke) costs only 7-27 ms per key here, below any honest input-delay budget, so it is
// reported but not required. D4 (stale response) depends on timing and has no probe; it is reported only.
const must = ['D2', 'D3', 'D5', 'D6', 'D7'];
check('3 probes flag D2 D3 D5 D6 D7 (D1 and D4 reported only)', must.every((id) => table.find((t) => t.id === id).flagged), `required missed: ${must.filter((id) => !table.find((t) => t.id === id).flagged).join(' ') || 'none'}; D1 ${table.find((t) => t.id === 'D1').flagged ? 'caught' : 'NOT caught'}; D4 ${table.find((t) => t.id === 'D4').flagged ? 'caught' : 'NOT caught'}`);

// Test 3b: the script-cost probe wrote its number. Printed so #9 can compare it between original and rebuild.
const sm = json(path.join(g1, 'timings.json')).find((t) => t.name === 'script-ms-per-key');
check('3b script-ms-per-key is in timings.json', !!sm && typeof sm.value === 'number', sm ? `${sm.value} ${sm.unit} per key at 4x CPU slowdown (budget 16 ms); D1 ${sm.value > 16 ? 'flagged' : 'not flagged'}` : 'missing');

// Test 3c: the score inputs. Per screen lcp, cls, bytes, heap-mb, overflow-narrow; inp-ms and build-ms once; a11y-violations.json one row per screen.
{
  const tm = json(path.join(g1, 'timings.json'));
  const has = (n) => tm.find((t) => t.name === n && typeof t.value === 'number');
  const per = ['lcp', 'cls', 'bytes', 'heap-mb', 'overflow-narrow'];
  const missing = [...m1.screens.flatMap((s) => per.map((k) => `${s.id}.${k}`)), 'inp-ms', 'build-ms'].filter((n) => !has(n));
  const af = path.join(g1, 'a11y-violations.json');
  const rows = fs.existsSync(af) ? json(af) : [];
  const rowsOk = rows.length === m1.screens.length && rows.every((r) => typeof r.screen === 'string' && Array.isArray(r.violations) && !r.error);
  const show = tm.filter((t) => /\.(lcp|cls|bytes|heap-mb|overflow-narrow)$|^(inp-ms|build-ms)$/.test(t.name)).map((t) => `${t.name}=${t.value}${t.unit}`).join(' ');
  check('3c score timings and a11y-violations.json exist', missing.length === 0 && rowsOk, `missing: ${missing.join(' ') || 'none'}; ${show}; a11y ${rows.map((r) => `${r.screen}:${r.violations.map((v) => `${v.id}x${v.nodes}`).join(',') || 'none'}`).join(' ')}`);
}

// Test 4: a second run gives the same files and screen list.
const run2 = setupRun('run2', 4234);
runCapture(run2, ['--states', states]);
const g2 = path.join(run2, 'golden');
const same = JSON.stringify(listFiles(g1)) === JSON.stringify(listFiles(g2));
const screens = (g) => json(path.join(g, 'manifest.json')).screens.map((s) => s.id + s.url).join();
check('4 two runs give the same files and screen list', same && screens(g1) === screens(g2), `${listFiles(g1).length} files each`);

// Test 5: outside request blocked and listed; no Cookie, Authorization or token in the HAR.
const harText = read(path.join(siteRun, 'golden/network.har'));
const har = JSON.parse(harText);
const names = har.log.entries.flatMap((e) => [...e.request.headers, ...e.response.headers].map((h) => h.name.toLowerCase()));
const leaked = ['COOKIESECRET', 'SETCOOKIESECRET', 'HEADERSECRET', 'QUERYSECRET'].filter((s) => harText.includes(s));
check('5 outside request blocked and listed; secrets absent from HAR', hits === 0 && ms.blockedRequests.some((b) => b.includes('localhost:4233')) && !names.some((n) => ['cookie', 'set-cookie', 'authorization'].includes(n)) && leaked.length === 0 && har.log.entries.length > 0,
  `outside server hits ${hits}; blocked ${JSON.stringify(ms.blockedRequests)}; cookie/auth header names in HAR: ${names.filter((n) => ['cookie', 'set-cookie', 'authorization'].includes(n)).length}; leaked secrets: ${leaked.join(',') || 'none'}; ${har.log.entries.length} entries`);
outside.close();
fs.writeFileSync(path.join(tmp, 'remote.json'), JSON.stringify({ platform: 'web', start: 'true', address: 'http://example.com' }));
const rr = spawnSync('node', [capture, '--app', path.join(tmp, 'remote.json'), '--out', path.join(tmp, 'x')], { encoding: 'utf8' });
check('5b non-localhost address refused', rr.status !== 0 && /only localhost/.test(rr.stderr), (rr.stderr.match(/refusing[^\n]*/) || [''])[0]);

// Test 6: the target stays untouched.
const status = execFileSync('git', ['status', '--porcelain', '--ignored'], { cwd: target }).toString().trim();
check('6 target git status is clean after the runs', status === '', status || 'clean');

// Test 7: a rebuild-run.json takes "dir" relative to its own folder, and an absolute "dir" is refused.
{
  const rb = path.join(tmp, 'rb');
  fs.cpSync(path.join(run1, 'work/app'), rb, { recursive: true });
  const f = path.join(rb, 'rebuild-run.json');
  fs.writeFileSync(f, JSON.stringify({ platform: 'web', dir: '.', start: 'node server.mjs', address: 'http://127.0.0.1:4235' }));
  let started = false, refused = false;
  try { const a = await startApp(JSON.parse(read(f)), f); started = (await fetch(a.origin)).ok; a.stop(); } catch (e) { started = e.message; }
  try { await startApp({ platform: 'web', dir: rb, start: 'true', address: 'http://127.0.0.1:4236' }, f); } catch (e) { refused = /relative/.test(e.message); }
  let escaped = false;
  try { await startApp({ platform: 'web', dir: '../..', start: 'true', address: 'http://127.0.0.1:4236' }, f); } catch (e) { escaped = /stay inside/.test(e.message); }
  check('7 rebuild-run.json starts from its own folder with dir "."; absolute dir and .. refused', started === true && refused && escaped, `started ${started}; absolute refused ${refused}; .. refused ${escaped}`);
}

// Test 8: coverage.json lists what was reached; a low --max-screens lists the screens it cut.
{
  const cov = json(path.join(g1, 'coverage.json'));
  const reachedOk = JSON.stringify(cov.screensReached) === JSON.stringify(m1.screens.map((s) => s.url)) && cov.screensCut.length === 0 && cov.harEntriesSkipped === 0;
  const capRun = path.join(tmp, 'cap');
  fs.mkdirSync(path.join(capRun, 'work'), { recursive: true });
  fs.copyFileSync(path.join(here, 'site.mjs'), path.join(capRun, 'work/site.mjs'));
  fs.writeFileSync(path.join(capRun, 'run.json'), JSON.stringify({ platform: 'web', start: 'node site.mjs', address: 'http://127.0.0.1:4237' }));
  runCapture(capRun, ['--max-screens', '2']);
  const cc = json(path.join(capRun, 'golden/coverage.json'));
  check('8 coverage.json: full run reaches every screen; --max-screens 2 lists the cut ones', reachedOk && JSON.stringify(cc.screensReached) === JSON.stringify(['/', '/a']) && JSON.stringify(cc.screensCut) === JSON.stringify(['/b']) && cc.caps.maxScreens === 2,
    `fixture reached ${cov.screensReached.length}, cut ${cov.screensCut.length}; capped site reached ${cc.screensReached.join(' ')}, cut ${cc.screensCut.join(' ')}`);
}

// Test 9: check.mjs, the per-change run of the probes, on the same fixture.
{
  const checkMjs = path.join(here, '..', 'check.mjs');
  const runCheck = (args) => { const t = Date.now(); const r = spawnSync('node', [checkMjs, ...args], { encoding: 'utf8' }); return { ...r, sec: (Date.now() - t) / 1000 }; };
  const chk = setupRun('chk', 4238);
  const app = await startApp(JSON.parse(read(path.join(chk, 'run.json'))), path.join(chk, 'run.json'));
  const outDir = path.join(tmp, 'check-out'), outFile = path.join(outDir, 'result.json');
  const full = runCheck(['--base-url', app.origin, '--routes', '/', '--out', outDir]);
  const res = fs.existsSync(outFile) ? json(outFile) : { failed: [], notChecked: [] };
  console.log(full.stdout.trim());
  const flagged = (id) => res.failed.some((f) => f.probe === probeOf[id]);
  check('9a check.mjs on the benchmark: exit 1, D2 D3 D5 D6 D7 flagged, under 120 s', full.status === 1 && must.every(flagged) && full.sec < 120 && res.elapsedMs < 120000,
    `exit ${full.status}; ${full.sec.toFixed(1)} s; flagged ${must.filter(flagged).join(' ')}; not checked ${res.notChecked.length}`);
  const shotsOk = ['1440', '390'].every((w) => (res.screenshots || []).some((x) => x.route === '/' && x.width === Number(w) && x.file === `root-${w}.png` && fs.statSync(path.join(outDir, x.file)).size > 0));
  check('9a2 screenshots at 390 and 1440 exist for every route and are listed in result.json', shotsOk, (res.screenshots || []).map((x) => x.file).join(' ') || 'none');
  const small = runCheck(['--base-url', app.origin, '--routes', '/', '--budget-seconds', '5', '--out', outDir]);
  const rs5 = json(outFile);
  check('9b a 5 second budget gives notChecked rows and exit 2 or 1, never 0', [1, 2].includes(small.status) && rs5.notChecked.length > 0 && rs5.status !== 'pass',
    `exit ${small.status}; ${small.sec.toFixed(1)} s; ${rs5.notChecked.length} not checked, e.g. ${rs5.notChecked[0] ? rs5.notChecked[0].probe + ': ' + rs5.notChecked[0].reason : 'none'}`);
  app.stop();
  const dead = runCheck(['--base-url', 'http://127.0.0.1:4240', '--routes', '/']);
  check('9c a dead port exits 3', dead.status === 3 && /does not answer/.test(dead.stderr), `exit ${dead.status}; ${dead.stderr.trim()}`);
  const bad = runCheck(['--routes', '/']);
  check('9d missing --base-url exits 3', bad.status === 3, `exit ${bad.status}`);
  // A route that redirects is not checked: exit 2, never a pass.
  // The server runs in a child process: spawnSync blocks this process's own event loop.
  const redir = spawn('node', ['-e', "require('http').createServer((q,s)=>{if(q.url==='/old'){s.writeHead(302,{location:'/login'});s.end()}else{s.writeHead(200,{'content-type':'text/html'});s.end('<title>x</title><p>hi</p>')}}).listen(4241)"], { stdio: 'ignore' });
  for (let i = 0; i < 50 && !(await fetch('http://127.0.0.1:4241').then(() => true, () => false)); i++) await new Promise((r) => setTimeout(r, 100));
  const rd = runCheck(['--base-url', 'http://127.0.0.1:4241', '--routes', '/old', '--out', outDir]);
  const rdr = json(outFile);
  redir.kill();
  check('9e a redirecting route is notChecked, exit 2', rd.status === 2 && rdr.notChecked.some((n) => n.route === '/old' && /\/login/.test(n.reason)), `exit ${rd.status}; ${rdr.notChecked.map((n) => n.reason).join(' | ')}`);
}

fs.rmSync(tmp, { recursive: true, force: true });
const failed = results.filter((r) => !r).length;
console.log(`${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);

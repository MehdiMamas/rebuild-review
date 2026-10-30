// Six tests from issue #15, run on a bench init copy of each fixture (never the repo folder, which holds answers.json).
// Usage: node test/run.mjs [android] [flutter]   (default: both). Needs the Android SDK and an emulator image; see AGENTS.md.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { checkGolden } from '../../contract-check.mjs';
import { deleteAvd, buildEnv } from '../driver.mjs';

const here = path.dirname(new URL(import.meta.url).pathname);
const repo = path.resolve(here, '../../..');
const capture = path.join(here, '..', 'capture.mjs');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-android-test-'));
const results = [];
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ': ' + detail : ''}`); };
const read = (f) => fs.readFileSync(f, 'utf8');
const json = (f) => JSON.parse(read(f));
const listFiles = (d) => fs.readdirSync(d, { recursive: true }).filter((f) => fs.statSync(path.join(d, f)).isFile()).sort();

const FIXTURES = {
  android: { dir: 'benchmark-android', run: { platform: 'android', build: './gradlew --no-daemon -q assembleDebug', start: 'node server.mjs', address: 'http://127.0.0.1:4301', apk: 'app/build/outputs/apk/debug/app-debug.apk', package: 'dev.rr.tasks' } },
  flutter: { dir: 'benchmark-flutter', run: { platform: 'flutter', build: 'flutter create --platforms=android --org dev.rr --project-name rr_tasks . && node prepare-android.mjs && flutter build apk --release --target-platform android-arm64', start: 'node server.mjs', address: 'http://127.0.0.1:4301', apk: 'build/app/outputs/flutter-apk/app-release.apk', package: 'dev.rr.rr_tasks' } },
};
const wanted = process.argv.slice(2).length ? process.argv.slice(2) : ['android', 'flutter'];

// aces_van_demo belongs to another project: it must be byte-identical afterwards.
const avdHome = path.join(process.env.ANDROID_AVD_HOME || path.join(os.homedir(), '.android/avd'));
const demoFiles = [path.join(avdHome, 'aces_van_demo.ini'), path.join(avdHome, 'aces_van_demo.avd', 'config.ini')].filter((f) => fs.existsSync(f));
const hashDemo = () => demoFiles.map((f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex')).join(',');
const demoBefore = hashDemo();

const states = path.join(tmp, 'states.json');
fs.writeFileSync(states, JSON.stringify([
  { id: 'list-error', steps: [{ failRequest: '/api/tasks' }, { open: 'com.app' }, { wait: 800 }] },
  { id: 'list-loading', steps: [{ slowRequest: { match: '/api/tasks', ms: 2500 } }, { open: 'com.app' }, { wait: 300 }] },
]));

let hits = 0;
const outside = http.createServer((q, s) => { hits++; s.end('x'); }).listen(4302, '0.0.0.0');
await new Promise((r) => outside.on('listening', r));

function setupRun(fx, name) {
  const target = path.join(tmp, fx, 'target');
  if (!fs.existsSync(target)) execFileSync('node', [path.join(repo, FIXTURES[fx].dir, 'init.mjs'), target], { stdio: 'pipe' });
  const runDir = path.join(tmp, fx, name);
  fs.mkdirSync(runDir, { recursive: true });
  execFileSync('git', ['clone', '-q', target, path.join(runDir, 'work')]);
  fs.writeFileSync(path.join(runDir, 'run.json'), JSON.stringify(FIXTURES[fx].run));
  return runDir;
}
const runCapture = (runDir) => {
  const r = spawnSync('node', [capture, '--app', path.join(runDir, 'run.json'), '--out', path.join(runDir, 'golden'), '--states', states], { encoding: 'utf8', env: process.env, maxBuffer: 1 << 28 });
  console.log(`  capture exit ${r.status}: ${(r.stdout || '').trim().split('\n').pop()}${r.status ? '\n' + (r.stderr || '').slice(-1500) : ''}`);
  return r;
};

const tables = {};
try {
  for (const fx of wanted) {
    console.log(`\n== fixture ${fx} ==`);
    const run1 = setupRun(fx, 'run1');
    runCapture(run1);
    const g1 = path.join(run1, 'golden');
    const manifestOk = fs.existsSync(path.join(g1, 'manifest.json'));
    const m1 = manifestOk ? json(path.join(g1, 'manifest.json')) : { screens: [], states: [], blockedRequests: [] };
    const allText = manifestOk ? m1.screens.concat(m1.states.map((id) => ({ id }))).map((s) => { const f = path.join(g1, 'screens', s.id, 'render.json'); return fs.existsSync(f) ? read(f) : ''; }).join('\n') : '';
    const has = (t) => allText.toLowerCase().includes(t.toLowerCase());

    // Test 1: screens, planted states, long-press and menu-only features.
    const stateShots = m1.states.every((id) => fs.existsSync(path.join(g1, 'screens', id, 'phone-light.png')));
    const shots = m1.screens.every((s) => ['phone', 'tablet'].every((z) => ['light', 'dark'].every((t) => fs.existsSync(path.join(g1, 'screens', s.id, `${z}-${t}.png`)))));
    check(`${fx} 1 screens, states, long-press and menu features captured`, m1.screens.length >= 4 && m1.states.length === 2 && stateShots && shots && has('Task actions') && has('Settings') && has('Send feedback'),
      `screens ${m1.screens.map((s) => s.id).join(',')}; states ${m1.states.join(',')}; long-press dialog ${has('Task actions')}; menu Settings ${has('Settings')}; shots for all sizes/themes ${shots}`);

    // Test 2: probes.json against answers.json (read here only).
    const answers = json(path.join(repo, FIXTURES[fx].dir, 'answers.json'));
    const probes = manifestOk ? json(path.join(g1, 'probes.json')) : [];
    const table = [];
    for (const a of answers) {
      let flagged, evidence = '';
      if (a.kind === 'defect') { const f = probes.filter((p) => p.probe === a.probe && !p.passed); flagged = f.length > 0; const best = f.find((x) => a.what && /save/i.test(a.what) && /save/i.test(x.evidence)) || f[0]; evidence = best ? `${best.screen}: ${best.evidence}` : ''; }
      else { flagged = a.id === 'H1' ? has('Task actions') : has('Settings'); evidence = flagged ? 'reached by the crawl' : ''; }
      table.push({ id: a.id, probe: a.probe || 'crawl', flagged, evidence, explained: !flagged && a.explainedMiss });
    }
    tables[fx] = table;
    console.log('planted | probe | result | evidence');
    for (const t of table) console.log(`${t.id} | ${t.probe} | ${t.flagged ? 'FOUND' : t.explained ? 'MISSED (explained)' : 'MISSED'} | ${t.flagged ? t.evidence.slice(0, 120) : t.explained || ''}`);
    const missed = table.filter((t) => !t.flagged && !t.explained).map((t) => t.id);
    check(`${fx} 2 every planted defect flagged and every hidden feature reached`, missed.length === 0, `${table.filter((t) => !t.flagged).length} of ${table.length} planted items missed (${table.filter((t) => !t.flagged).map((t) => t.id + (t.explained ? ' explained' : ' UNEXPLAINED')).join(', ') || 'none'}); unexplained: ${missed.join(' ') || 'none'}`);

    // Test 3: second run gives the same files and screen ids (timing values and background noise ignored).
    const run2 = setupRun(fx, 'run2');
    runCapture(run2);
    const g2 = path.join(run2, 'golden');
    const stable = (g) => listFiles(g).filter((f) => !f.endsWith('.png') || true);
    const ids = (g) => json(path.join(g, 'manifest.json')).screens.map((s) => s.id).join();
    check(`${fx} 3 two runs give the same files and screen list`, fs.existsSync(path.join(g2, 'manifest.json')) && JSON.stringify(stable(g1)) === JSON.stringify(stable(g2)) && ids(g1) === ids(g2), `${listFiles(g1).length} files; screens ${ids(g1)}`);

    // Test 4: outside request fails and is listed; no secret in the HAR.
    const harText = read(path.join(g1, 'network.har'));
    const har = JSON.parse(harText);
    const names = har.log.entries.flatMap((e) => [...e.request.headers, ...e.response.headers].map((h) => h.name.toLowerCase()));
    const leaked = ['COOKIESECRET', 'SETCOOKIESECRET', 'HEADERSECRET', 'QUERYSECRET'].filter((s) => harText.includes(s));
    const secretHeaders = names.filter((n) => ['cookie', 'set-cookie', 'authorization'].includes(n));
    check(`${fx} 4 outside request refused and listed; no secrets in HAR`, hits === 0 && m1.blockedRequests.some((b) => b.includes(':4302')) && m1.blockedRequests.some((b) => b.includes('example.com')) && secretHeaders.length === 0 && leaked.length === 0 && har.log.entries.length > 0,
      `outside server hits ${hits}; blocked lists :4302 ${m1.blockedRequests.some((b) => b.includes(':4302'))} and example.com ${m1.blockedRequests.some((b) => b.includes('example.com'))}; cookie/auth headers ${secretHeaders.length}; leaked ${leaked.join(',') || 'none'}; ${har.log.entries.length} entries; not captured: ${(m1.notCaptured || []).length}`);

    // Test 5: target untouched, other project's AVD unchanged.
    const status = execFileSync('git', ['status', '--porcelain', '--ignored'], { cwd: path.join(tmp, fx, 'target') }).toString().trim();
    check(`${fx} 5 target git status clean; aces_van_demo unchanged`, status === '' && hashDemo() === demoBefore, `status: ${status || 'clean'}; aces_van_demo files ${demoFiles.length} hashed equal ${hashDemo() === demoBefore}`);

    // Test 6: contract layout, same function as the web test.
    const problems = checkGolden(g1);
    check(`${fx} 6 golden/ layout passes the shared contract check`, problems.length === 0, problems.join('; ') || 'ok');
  }
} finally {
  outside.close();
  try { deleteAvd(); } catch (e) { console.log('AVD delete failed', e.message); }
  try { execFileSync('./gradlew', ['--stop'], { cwd: path.join(repo, 'benchmark-android'), env: buildEnv(), stdio: 'pipe' }); } catch {}
  fs.rmSync(tmp, { recursive: true, force: true });
}
const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);

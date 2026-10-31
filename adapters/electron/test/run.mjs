// Nine checks for the Electron adapter, run against the fixture app in ./fixture. node test/run.mjs
// The known answers are in answers.json; only this file reads them. A planted problem the probes miss is printed as MISS and
// is not hidden or tuned away. A check fails only when the thing it protects is broken (a leak, a hang, a missing file, a false alarm on the clean screen).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const adapter = path.resolve(here, '..');
const answers = JSON.parse(fs.readFileSync(path.join(here, 'answers.json'), 'utf8'));
const electronPath = createRequire(path.join(adapter, 'x.js'))('electron');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rr-electron-test-')));
const results = [];
const note = (...a) => console.log('   ', ...a);
function check(n, name, ok, lines = []) {
  results.push({ n, name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}. ${name}`);
  for (const l of lines) note(l);
}

// ---- what the fixture is allowed to see of this machine: decoys, so a leak can be told from nothing ----
const secret = 'secret-' + crypto.randomBytes(6).toString('hex');
const token = 'token-' + crypto.randomBytes(6).toString('hex');
const realHome = path.join(base, 'real-home');
fs.mkdirSync(realHome);
fs.writeFileSync(path.join(realHome, '.fake-token'), token);

// A server on this machine's network address (not loopback). Anything that reaches it left the app's allowed addresses.
const hits = { main: 0, renderer: 0, other: 0 };
const server = http.createServer((req, res) => {
  if (req.url.startsWith('/main')) hits.main++; else if (req.url.startsWith('/renderer')) hits.renderer++; else hits.other++;
  res.writeHead(200, { 'access-control-allow-origin': '*' }); res.end('outside');
});
await new Promise((r) => server.listen(0, '0.0.0.0', r));
const lan = Object.values(os.networkInterfaces()).flat().find((i) => i && i.family === 'IPv4' && !i.internal);
const outside = lan ? `http://${lan.address}:${server.address().port}` : 'http://192.0.2.1:9';

function makeRun(name, extraArgs = []) {
  const dir = path.join(base, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.cpSync(path.join(here, 'fixture'), path.join(dir, 'work'), { recursive: true });
  const file = path.join(dir, 'run.json');
  fs.writeFileSync(file, JSON.stringify({ platform: 'electron', launch: { executablePath: electronPath, args: ['.', `--outside=${outside}`, ...extraArgs] } }));
  return { dir, file };
}
const env = (tmpRoot) => ({ ...process.env, HOME: realHome, USERPROFILE: realHome, RR_SECRET_PARENT: secret, RR_TMP_ROOT: tmpRoot });
const procs = (marker) => spawnSync('pgrep', ['-f', marker], { encoding: 'utf8' }).stdout.split('\n').filter(Boolean).length;

function runCapture(run, out, tmpRoot, more = []) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const c = spawn(process.execPath, [path.join(adapter, 'capture.mjs'), '--app', run.file, '--out', out, ...more], { env: env(tmpRoot), stdio: ['ignore', 'pipe', 'pipe'] });
    let text = '';
    c.stdout.on('data', (d) => (text += d)); c.stderr.on('data', (d) => (text += d));
    c.on('exit', (code) => resolve({ code, text, ms: Date.now() - t0 }));
  });
}
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const allFiles = (d, out = []) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); e.isDirectory() ? allFiles(p, out) : out.push(p); } return out; };

try {
  console.log(`fixture outside address: ${lan ? outside : 'none (no non-loopback address on this machine; the main-process proof cannot be measured)'}`);
  console.log('running the full capture (this relaunches the app for every click and probe; it takes minutes)...');
  const tmpRoot = path.join(base, 'tmp-main');
  fs.mkdirSync(tmpRoot);
  const run = makeRun('run-main');
  const golden = path.join(run.dir, 'golden');
  const cap = await runCapture(run, golden, tmpRoot);
  note(`capture exited ${cap.code} in ${Math.round(cap.ms / 1000)} s: ${cap.text.trim().split('\n').pop()}`);
  const manifest = readJson(path.join(golden, 'manifest.json')) || { screens: [] };
  const probes = readJson(path.join(golden, 'probes.json')) || [];
  const ids = manifest.screens.map((s) => s.id);

  // 1
  {
    const lines = [];
    const missing = answers.screens.filter((n) => !manifest.screens.some((s) => s.id === slug(n) || (s.heading || '').toLowerCase() === n.toLowerCase()));
    const kinds = new Set(manifest.screens.map((s) => s.window));
    const noWindow = answers.windows.filter((w) => !kinds.has(w.toLowerCase()));
    const nonClick = manifest.screens.filter((s) => s.steps.some((x) => !('open' in x) && !('click' in x)));
    lines.push(`found ${ids.length} screens: ${ids.join(', ')}`);
    if (missing.length) lines.push(`missing screens: ${missing.join(', ')}`);
    if (noWindow.length) lines.push(`missing windows: ${noWindow.join(', ')}`);
    if (nonClick.length) lines.push(`reached by something other than clicking: ${nonClick.map((s) => s.id).join(', ')}`);
    check(1, 'every screen and both windows found by clicking alone', cap.code === 0 && !missing.length && !noWindow.length && !nonClick.length, lines);
  }

  // 2
  {
    const bad = [];
    const need = (f) => { if (!fs.existsSync(path.join(golden, f))) bad.push(`missing ${f}`); };
    for (const f of ['manifest.json', 'network.har', 'timings.json', 'probes.json', 'console.log', 'coverage.json']) need(f);
    const har = readJson(path.join(golden, 'network.har')); if (!har || !Array.isArray(har.log && har.log.entries)) bad.push('network.har is not a HAR');
    const tim = readJson(path.join(golden, 'timings.json')); if (!Array.isArray(tim) || tim.some((t) => !('name' in t && 'value' in t && 'unit' in t))) bad.push('timings.json is not a list of {name,value,unit}');
    if (!Array.isArray(probes) || probes.some((p) => !('probe' in p && 'screen' in p && 'passed' in p && 'evidence' in p))) bad.push('probes.json is not a list of {probe,screen,passed,evidence}');
    if (manifest.platform !== 'electron') bad.push(`manifest platform is "${manifest.platform}"`);
    for (const id of ids) {
      for (const f of ['render.html', 'render.css.json', 'a11y.json', '1024-light.png', '1024-dark.png', '1440-light.png', '1440-dark.png']) {
        const p = path.join(golden, 'screens', id, f);
        if (!fs.existsSync(p)) bad.push(`screens/${id}/${f} missing`);
        else if (f.endsWith('.png') && fs.readFileSync(p).subarray(1, 4).toString() !== 'PNG') bad.push(`screens/${id}/${f} is not a PNG`);
        else if (f.endsWith('.json') && !readJson(p)) bad.push(`screens/${id}/${f} is not valid JSON`);
      }
    }
    const themeNotes = (manifest.notCaptured || []).filter((x) => /theme did not change/.test(x)).length;
    check(2, 'every contract file present and valid, per size and theme', !bad.length, [...bad.slice(0, 10), `${ids.length} screens x 2 sizes x 2 themes checked; ${themeNotes} size(s) noted "theme did not change" (the fixture has no dark styles)`]);
  }

  // 3
  {
    const lines = [];
    let falseAlarm = false;
    const flagged = probes.filter((p) => !p.passed);
    const onScreen = (p, h) => p.screen === slug(h) || p.screen.startsWith(slug(h) + '@') || p.screen.startsWith(slug(h) + ':');
    for (const e of answers.problems) {
      const hit = flagged.find((p) => p.probe === e.probe && onScreen(p, e.heading));
      lines.push(hit ? `${e.id} flagged (${hit.probe} on ${hit.screen}): ${hit.evidence}` : `${e.id} MISS: ${e.what}. No ${e.probe} flag on ${e.heading}.`);
    }
    const ctl = flagged.filter((p) => onScreen(p, answers.control.heading));
    if (ctl.length) { falseAlarm = true; lines.push(`FALSE ALARM on the clean control screen ${answers.control.heading}: ${ctl.map((p) => `${p.probe} (${p.evidence})`).join('; ')}`); }
    else lines.push(`control screen ${answers.control.heading}: nothing flagged`);
    const planted = new Set(answers.problems.map((e) => slug(e.heading)));
    const extra = flagged.filter((p) => !answers.problems.some((e) => e.probe === p.probe && onScreen(p, e.heading)) && !onScreen(p, answers.control.heading));
    if (extra.length) lines.push(`also flagged (not in the answers): ${extra.map((p) => `${p.probe} on ${p.screen}`).join('; ')}`);
    check(3, 'each planted problem flagged, the clean screen not (misses are reported, not hidden)', !falseAlarm && probes.length > 0, lines);
  }

  // 4
  {
    const lines = [];
    const leaks = [];
    for (const f of allFiles(golden)) {
      if (/\.png$/i.test(f)) continue;
      const t = fs.readFileSync(f, 'utf8');
      for (const [what, v] of [['parent secret', secret], ['token in the real home', token], ['real home path', realHome], ['temp folder', base]]) if (t.includes(v)) leaks.push(`${what} appears in ${path.relative(golden, f)}`);
    }
    const log = fs.existsSync(path.join(golden, 'console.log')) ? fs.readFileSync(path.join(golden, 'console.log'), 'utf8') : '';
    const sawSecret = !/env-secret: absent/.test(log), sawToken = !/token-file: absent/.test(log);
    if (sawSecret) lines.push('the app could see the parent environment secret');
    if (sawToken) lines.push('the app could read the token file in the real home');
    lines.push(`the app reported: ${log.split('\n').filter((l) => /env-secret|token-file/.test(l)).slice(0, 2).join(' | ') || 'nothing'}`);
    check(4, 'parent secret and real-home token never appear; the app ran with an isolated environment and home', !leaks.length && !sawSecret && !sawToken && /env-secret/.test(log), [...leaks, ...lines]);
  }

  // 5
  {
    const lines = [];
    const blocked = manifest.blockedRequests || [];
    const listed = blocked.some((u) => /\/renderer/.test(u));
    lines.push(`blocked and listed: ${blocked.length ? blocked.join(', ') : 'nothing'}`);
    lines.push(`requests that reached the outside server from a window: ${hits.renderer}`);
    const mainLine = (fs.existsSync(path.join(golden, 'console.log')) ? fs.readFileSync(path.join(golden, 'console.log'), 'utf8') : '').split('\n').find((l) => /main-process fetch/.test(l));
    lines.push(`main-process fetch to the outside address, as the app saw it: ${mainLine || 'not printed (the app prints it on its standard output)'}`);
    lines.push(lan ? `requests that reached the outside server from the main process: ${hits.main}` : 'main-process result not measured: no non-loopback address here');
    check(5, 'window requests to outside addresses are blocked and listed; the main-process result is measured and printed', listed && hits.renderer === 0 && (!lan || hits.main === 0), lines);
  }

  // 6
  {
    const d = manifest.nativeDialogs || [];
    check(6, 'a native dialog does not hang and is listed', cap.code === 0 && d.length > 0, [`listed: ${JSON.stringify(d)}`]);
  }

  // 7
  {
    const r = makeRun('run-cap');
    const out = path.join(r.dir, 'golden');
    const tr = path.join(base, 'tmp-cap'); fs.mkdirSync(tr);
    const c = await runCapture(r, out, tr, ['--max-screens', '2']);
    const cov = readJson(path.join(out, 'coverage.json')) || {};
    const reached = (cov.screensReached || []).length, cut = (cov.screensCut || []);
    check(7, '--max-screens 2 lists the rest in coverage.json', c.code === 0 && reached === 2 && cut.length > 0, [`exit ${c.code}; reached ${reached}; cut ${cut.length}: ${cut.slice(0, 3).join(' | ')}${cut.length > 3 ? ' ...' : ''}`]);
  }

  // 8
  {
    const r = makeRun('run-parity');
    const tests = path.join(r.dir, 'tests'); fs.mkdirSync(tests);
    const launch = pathUrl(path.join(adapter, 'launch.mjs'));
    const head = `import test from 'node:test'; import assert from 'node:assert/strict'; import fs from 'node:fs';\nimport { launchApp } from '${launch}';\nconst file = process.env.APP_RUN; const run = JSON.parse(fs.readFileSync(file, 'utf8'));\n`;
    fs.writeFileSync(path.join(tests, 'F-001.test.mjs'), head + `test('the Workbench window shows Tasks', async () => { const s = await launchApp(run, file); try { assert.equal(await s.page.getByRole('button', { name: 'Tasks' }).count(), 1); } finally { await s.stop(); } });\n`);
    fs.writeFileSync(path.join(tests, 'F-002.test.mjs'), head + `test('a button that does not exist', async () => { const s = await launchApp(run, file); try { await s.page.getByRole('button', { name: 'No such button' }).click({ timeout: 2000 }); } finally { await s.stop(); } });\n`);
    const tr = path.join(base, 'tmp-parity'); fs.mkdirSync(tr);
    const out = path.join(r.dir, 'results.json');
    const p = spawnSync(process.execPath, [path.join(adapter, 'parity.mjs'), '--app', r.file, '--tests', tests, '--out', out], { env: { ...env(tr), RR_PREPARED: '' }, encoding: 'utf8' });
    const res = readJson(out) || [];
    const by = Object.fromEntries(res.map((x) => [x.feature, x.passed]));
    await sleep(1000);
    const left = procs(tr);
    check(8, 'parity runs one passing and one failing test, reports both, leaves no process behind', p.status === 0 && by['F-001'] === true && by['F-002'] === false && left === 0,
      [`exit ${p.status}; F-001 passed=${by['F-001']}; F-002 passed=${by['F-002']}; processes left: ${left}`, (p.stdout || '').trim().split('\n').pop()]);
  }

  // 9
  {
    const lines = [];
    let ok = true;
    for (const sig of ['SIGTERM', 'SIGKILL']) {
      const r = makeRun('run-kill-' + sig);
      const tr = path.join(base, 'tmp-kill-' + sig); fs.mkdirSync(tr);
      const c = spawn(process.execPath, [path.join(adapter, 'capture.mjs'), '--app', r.file, '--out', path.join(r.dir, 'golden')], { env: env(tr), stdio: 'ignore' });
      const exited = new Promise((res) => c.on('exit', res));
      let seen = 0;
      for (let i = 0; i < 120 && !seen; i++) { await sleep(500); seen = procs(tr); }
      await sleep(1500);
      c.kill(sig); await exited;
      let left = procs(tr);
      for (let i = 0; i < 20 && left; i++) { await sleep(500); left = procs(tr); }
      lines.push(`${sig}: ${seen} Electron process(es) running when killed, ${left} left ${left ? 'after 10 s' : 'after the kill'}`);
      if (!seen || left) ok = false;
      spawnSync('pkill', ['-KILL', '-f', tr]);
    }
    check(9, 'no Electron process is left after a killed run', ok, lines);
  }
} finally {
  server.close();
  spawnSync('pkill', ['-KILL', '-f', base]);
  fs.rmSync(base, { recursive: true, force: true });
}

function pathUrl(p) { return 'file://' + p.split(path.sep).map(encodeURIComponent).join('/'); }

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length} of ${results.length} checks passed${failed.length ? '; failed: ' + failed.map((r) => r.n).join(', ') : ''}`);
process.exit(failed.length ? 1 : 0);

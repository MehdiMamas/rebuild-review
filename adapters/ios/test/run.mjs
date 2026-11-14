// Checks for the iOS adapter, run against the fixture app in ./fixture on a simulator. node test/run.mjs (macOS with Xcode only).
// Checks 0-8 cover the adapter; 9-13 are the five iOS edge cases, one check each.
// The known answers are in answers.json; only this file reads them. A planted problem the probes miss is printed as MISS and
// is not hidden or tuned away. A check fails only when the thing it protects is broken (a leak, a hang, a missing file, a false alarm on a clean screen).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

if (process.platform !== 'darwin') { console.log('skipped: not macOS (the iOS adapter runs on a Mac with Xcode only)'); process.exit(0); }

const here = path.dirname(fileURLToPath(import.meta.url));
const adapter = path.resolve(here, '..');
const answers = JSON.parse(fs.readFileSync(path.join(here, 'answers.json'), 'utf8'));
const sim = await import(pathToFileURL(path.join(adapter, 'sim.mjs')).href);
const drv = await import(pathToFileURL(path.join(adapter, 'driver.mjs')).href);
const appMod = await import(pathToFileURL(path.join(adapter, 'app.mjs')).href);

const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rr-ios-test-')));
const results = [];
const note = (...a) => console.log('   ', ...a);
function check(n, name, ok, lines = []) {
  results.push({ n, name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}. ${name}`);
  for (const l of lines) note(l);
}
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const allFiles = (d, out = []) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); e.isDirectory() ? allFiles(p, out) : out.push(p); } return out; };
const rrDevices = () => (spawnSync('xcrun', ['simctl', 'list', 'devices', '-j'], { encoding: 'utf8' }).stdout.match(/"name"\s*:\s*"rr-[0-9a-f]+"/g) || []);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A server on this machine that counts the requests that reach it.
let hits = 0;
const server = http.createServer((req, res) => { hits++; res.end('ok'); });
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const fetchUrl = `http://127.0.0.1:${server.address().port}/`;

const BUILD = (scheme = 'Fixture') => `xcodebuild -project Fixture.xcodeproj -scheme ${scheme} -sdk iphonesimulator -destination 'generic/platform=iOS Simulator' -derivedDataPath "$RUN_DIR/dd" CODE_SIGNING_ALLOWED=NO build`;
const APP = 'dd/Build/Products/Debug-iphonesimulator/Fixture.app';
function makeRun(name, over = {}, { copyBuildFrom } = {}) {
  const dir = path.join(base, name);
  fs.mkdirSync(dir, { recursive: true });
  const work = path.join(dir, 'work');
  fs.cpSync(path.join(here, 'fixture'), work, { recursive: true, filter: (s) => !/\/(dd|build)(\/|$)/.test(s) });
  const git = (...a) => spawnSync('git', ['-C', work, '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...a], { encoding: 'utf8' });
  git('init', '-q'); git('add', '.'); git('commit', '-q', '-m', 'fixture');
  if (copyBuildFrom) fs.cpSync(path.join(copyBuildFrom, 'dd'), path.join(dir, 'dd'), { recursive: true });
  const file = path.join(dir, 'run.json');
  fs.writeFileSync(file, JSON.stringify({ platform: 'ios', dir: '.', build: BUILD(), app: APP, bundleId: 'example.rrfixture.app', device: { name: 'iPhone 16' }, launch: { env: {} }, ...over }));
  return { dir, work, file, git, golden: path.join(dir, 'golden') };
}
function runNode(script, argv, { env = {}, onStart } = {}) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const c = spawn(process.execPath, [path.join(adapter, script), ...argv], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let text = '';
    c.stdout.on('data', (d) => (text += d)); c.stderr.on('data', (d) => (text += d));
    if (onStart) onStart(c);
    c.on('exit', (code, signal) => resolve({ code, signal, text, ms: Date.now() - t0 }));
  });
}
const prepared = { RR_PREPARED: '1' };
const lastLine = (t) => t.trim().split('\n').pop();

try {
  const startDevices = rrDevices().length;
  const main = makeRun('run-main', { launch: { env: { RR_FIXTURE_URL: fetchUrl } } });

  // 0  the spike: the driver gives a hierarchy and a PNG on a headless simulator
  {
    const lines = [];
    let ok = false, dev = null, driver = null;
    try {
      const ctx = appMod.prepare(JSON.parse(fs.readFileSync(main.file, 'utf8')), main.file);
      lines.push(`build: ${Math.round(ctx.buildMs / 1000)} s`);
      const picked = sim.pickRuntime(sim.listRuntimes(), { sdk: sim.sdkVersion() });
      dev = sim.createDevice({ typeName: 'iPhone 16', runtime: picked.runtime });
      sim.boot(dev.udid); sim.install(dev.udid, ctx.appPath);
      driver = await drv.startDriver(dev.udid, 'example.rrfixture.app');
      sim.launch(dev.udid, 'example.rrfixture.app', {});
      const h = await drv.settled('example.rrfixture.app');
      const png = path.join(base, 'spike.png');
      sim.screenshot(dev.udid, png);
      const magic = fs.readFileSync(png).subarray(1, 4).toString();
      lines.push(`maestro ${drv.maestroVersion()}; ${h.elements.length} elements, ${h.elements.filter((e) => e.label).length} with a label; PNG ${magic === 'PNG' ? 'ok' : 'bad'} (${fs.statSync(png).size} bytes)`);
      ok = h.elements.length > 0 && h.elements.some((e) => e.label === 'Fixture Home') && magic === 'PNG';
    } catch (e) { lines.push(`spike failed: ${e.message.split('\n')[0]}`); }
    finally { if (driver) driver.stop(); if (dev) await sim.shutdownAndDelete(dev.udid); }
    check(0, 'spike: Maestro and simctl give a hierarchy and a PNG on a headless simulator', ok, lines);
  }

  // 1  a device of our own, booted with no window, deleted, none left
  {
    const lines = [];
    const before = rrDevices().length;
    const windowsBefore = spawnSync('pgrep', ['-x', 'Simulator'], { encoding: 'utf8' }).stdout.trim();
    const picked = sim.pickRuntime(sim.listRuntimes(), { sdk: sim.sdkVersion() });
    const dev = sim.createDevice({ typeName: 'iPhone 16', runtime: picked.runtime });
    const named = /^rr-[0-9a-f]+$/.test(dev.name);
    sim.boot(dev.udid);
    const during = rrDevices().length;
    await sim.shutdownAndDelete(dev.udid);
    const after = rrDevices().length;
    const windowsAfter = spawnSync('pgrep', ['-x', 'Simulator'], { encoding: 'utf8' }).stdout.trim();
    lines.push(`device ${dev.name}; rr- devices before ${before}, while booted ${during}, after ${after}; Simulator.app ${windowsBefore === windowsAfter ? 'not started by the adapter' : 'STARTED'}`);
    check(1, 'a device named rr-* is created, booted headless and deleted; none is left', named && during === before + 1 && after === before && windowsBefore === windowsAfter, lines);
  }

  // capture the main run (builds the fixture once)
  const cap = await runNode('capture.mjs', ['--app', main.file, '--out', main.golden], { env: prepared });
  note(`capture exited ${cap.code} in ${Math.round(cap.ms / 1000)} s: ${lastLine(cap.text)}`);
  const golden = main.golden;
  const manifest = readJson(path.join(golden, 'manifest.json')) || { screens: [], notCaptured: [], versions: {} };
  const probes = readJson(path.join(golden, 'probes.json')) || [];
  const coverage = readJson(path.join(golden, 'coverage.json')) || {};
  const ids = manifest.screens.map((s) => s.id);

  // 2
  {
    const bad = [];
    for (const f of ['manifest.json', 'network.har', 'timings.json', 'probes.json', 'probes-not-checked.json', 'console.log', 'coverage.json']) if (!fs.existsSync(path.join(golden, f))) bad.push(`missing ${f}`);
    const har = readJson(path.join(golden, 'network.har')); if (!har || !Array.isArray(har.log && har.log.entries)) bad.push('network.har is not a HAR');
    const tim = readJson(path.join(golden, 'timings.json'));
    if (!Array.isArray(tim) || tim.some((t) => !('name' in t && 'value' in t && 'unit' in t))) bad.push('timings.json is not a list of {name,value,unit}');
    else for (const n of ['launch-ms', 'app-bytes']) if (!tim.some((t) => t.name === n)) bad.push(`timings.json has no ${n}`);
    if (!Array.isArray(probes) || probes.some((p) => !('probe' in p && 'screen' in p && 'passed' in p && 'evidence' in p))) bad.push('probes.json is not a list of {probe,screen,passed,evidence}');
    if (manifest.platform !== 'ios') bad.push(`manifest platform is "${manifest.platform}"`);
    for (const id of ids) for (const f of ['render.json', 'a11y.json', 'iphone-16-light.png', 'iphone-16-dark.png', 'iphone-se-3rd-generation-light.png', 'iphone-se-3rd-generation-dark.png']) if (!fs.existsSync(path.join(golden, 'screens', id, f))) bad.push(`screens/${id}/${f} missing`);
    if (!(manifest.devices || []).some((d) => /SE/.test(d.name))) bad.push('the SE-class device is not in manifest.devices');
    check(2, 'capture writes every contract file, and each screen its files at two device sizes in light and dark', cap.code === 0 && !bad.length, [...bad.slice(0, 10), `${ids.length} screens checked`]);
  }

  // 3
  {
    const missing = answers.screens.filter((s) => !ids.includes(s));
    const extra = ids.filter((s) => !answers.screens.includes(s));
    check(3, 'the crawl finds the three screens and the modal, and nothing twice', !missing.length && !extra.length, [`found: ${ids.join(', ')}`, ...(missing.length ? [`not found: ${missing.join(', ')}`] : []), ...(extra.length ? [`not expected: ${extra.join(', ')}`] : [])]);
  }

  // 4
  {
    const lines = [];
    const flagged = probes.filter((p) => !p.passed);
    for (const e of answers.problems) {
      const hit = flagged.find((p) => p.probe === e.probe && p.screen === e.screen);
      lines.push(hit ? `${e.id} flagged (${hit.probe} on ${hit.screen}): ${hit.evidence}` : `${e.id} MISS: ${e.what}. No ${e.probe} flag on ${e.screen}.`);
    }
    const ctl = flagged.filter((p) => answers.clean.includes(p.screen));
    if (ctl.length) lines.push(`FALSE ALARM on a clean screen: ${ctl.map((p) => `${p.probe} on ${p.screen} (${p.evidence})`).join('; ')}`);
    else lines.push(`clean screens (${answers.clean.join(', ')}): nothing flagged`);
    const extra = flagged.filter((p) => !answers.problems.some((e) => e.probe === p.probe && e.screen === p.screen) && !answers.clean.includes(p.screen));
    if (extra.length) lines.push(`also flagged (not in the answers): ${extra.map((p) => `${p.probe} on ${p.screen}`).join('; ')}`);
    const miss = lines.filter((l) => / MISS: /.test(l)).length;
    check(4, 'each planted problem flagged, clean screens not (misses are reported, not hidden)', !ctl.length && probes.length > 0 && !miss, lines);
  }

  // 5
  {
    const sawNote = (manifest.notCaptured || []).some((x) => /network not blocked: iOS simulator shares the host network/.test(x));
    // an app set to reach a server that is not this machine is refused unless --allow-network
    const lan = Object.values(os.networkInterfaces()).flat().find((i) => i && i.family === 'IPv4' && !i.internal);
    const outside = makeRun('run-outside', { launch: { env: { RR_FIXTURE_URL: 'https://api.example.com/v1' } } });
    const refused = await runNode('capture.mjs', ['--app', outside.file, '--out', outside.golden], { env: prepared });
    const refusedOk = refused.code === 1 && /api\.example\.com/.test(refused.text) && /--allow-network/.test(refused.text) && !fs.existsSync(outside.golden);
    check(5, 'network is not blocked: the app reached the local server, the mode is recorded, and a non-local server is refused without --allow-network',
      hits > 0 && manifest.network && manifest.network.blocked === false && sawNote && refusedOk,
      [`requests that reached the local server: ${hits}`, `manifest says not blocked: ${sawNote}`, `non-local server refused: ${refusedOk} (${lastLine(refused.text)})`, lan ? '' : 'no non-loopback address on this machine'].filter(Boolean));
  }

  // 6
  {
    const files = allFiles(golden);
    const found = files.filter((f) => fs.readFileSync(f).includes(Buffer.from(answers.token))).map((f) => path.relative(golden, f));
    const log = fs.readFileSync(path.join(golden, 'console.log'), 'utf8');
    check(6, 'a token-like value in the app log is scrubbed in the golden', !found.length && /\[redacted\]/.test(log), [found.length ? `token still in: ${found.join(', ')}` : 'the token appears in no golden file', `console.log has ${log.split('\n').filter((l) => /redacted/.test(l)).length} scrubbed lines`]);
  }

  // 7
  {
    const tests = path.join(base, 'parity-tests');
    fs.mkdirSync(tests);
    const flow = (assertion) => `appId: example.rrfixture.app\n---\n- launchApp\n- assertVisible: "${assertion}"\n`;
    fs.writeFileSync(path.join(tests, 'F-001.test.yaml'), flow('Fixture Home'));
    fs.writeFileSync(path.join(tests, 'F-002.test.yaml'), flow('A label the app does not have'));
    const par = makeRun('run-parity', {}, { copyBuildFrom: main.dir });
    const out = path.join(par.dir, 'results.json');
    const p = await runNode('parity.mjs', ['--app', par.file, '--tests', tests, '--out', out], { env: prepared });
    const by = Object.fromEntries((readJson(out) || []).map((x) => [x.feature, x]));
    check(7, 'parity on two flows gives one pass and one fail', p.code === 0 && by['F-001'] && by['F-001'].passed === true && by['F-002'] && by['F-002'].passed === false, [lastLine(p.text), `F-002: ${by['F-002'] ? by['F-002'].detail.split('\n').slice(-2).join(' / ') : 'missing'}`]);
  }

  // 8
  {
    const run = makeRun('run-int', {}, { copyBuildFrom: main.dir });
    const before = rrDevices().length;
    let seen = false, child = null;
    const waiter = (async () => {
      for (let i = 0; i < 120; i++) { await sleep(1000); if (rrDevices().length > before) { seen = true; await sleep(8000); child.kill('SIGINT'); return; } }
      child.kill('SIGKILL');
    })();
    const r = await runNode('capture.mjs', ['--app', run.file, '--out', run.golden, '--single-size'], { env: prepared, onStart: (c) => { child = c; } });
    await waiter;
    let after = rrDevices().length;
    for (let i = 0; i < 20 && after > before; i++) { await sleep(1000); after = rrDevices().length; }
    check(8, 'SIGINT in the middle of a capture leaves no simulator device', seen && after === before && r.code === 130, [`a device appeared: ${seen}; exit ${r.code} (${r.signal || 'no signal'}); rr- devices before ${before}, after ${after}`]);
  }

  // 9  edge case: no simulator runtime installed
  {
    const run = makeRun('run-noruntime', { device: { name: 'iPhone 16', runtime: 'iOS 99.0' } }, { copyBuildFrom: main.dir });
    const before = rrDevices().length;
    const r = await runNode('capture.mjs', ['--app', run.file, '--out', run.golden], { env: prepared });
    check(9, 'given no simulator runtime installed, the capture stops with the exact runtime name and creates no device', r.code === 1 && /iOS simulator runtime iOS 99\.0 is not installed/.test(r.text) && rrDevices().length === before && !fs.existsSync(run.golden), [lastLine(r.text)]);
  }

  // 10  edge case: sign-in at launch
  {
    const run = makeRun('run-signin', { launch: { args: ['-RRSignIn'], env: {} } }, { copyBuildFrom: main.dir });
    const r = await runNode('capture.mjs', ['--app', run.file, '--out', run.golden, '--single-size'], { env: prepared });
    const m = readJson(path.join(run.golden, 'manifest.json')) || { screens: [], notCaptured: [] };
    const cov = readJson(path.join(run.golden, 'coverage.json')) || {};
    check(10, 'given an app that needs sign-in at launch, the sign-in screen is the capture and coverage.json says the rest is unreached',
      r.code === 0 && m.screens.length === 1 && m.screens[0].id === 'sign-in' && cov.signInRequired === true && /sign-in/.test(cov.unreached || '') && m.notCaptured.some((x) => /asks for a sign-in/.test(x)),
      [`screens: ${m.screens.map((s) => s.id).join(', ') || 'none'}; coverage: ${JSON.stringify({ signInRequired: cov.signInRequired, unreached: cov.unreached })}`]);
  }

  // 11  edge case: Share extension
  {
    check(11, 'given an app with a Share extension or widget, the main app only is captured and the extension is noted',
      (manifest.extensions || []).includes(answers.extension) && (manifest.notCaptured || []).some((x) => /main app only/.test(x) && x.includes(answers.extension)) && !ids.some((s) => /share/i.test(s)),
      [`extensions: ${(manifest.extensions || []).join(', ')}`, ...(manifest.notCaptured || []).filter((x) => /main app only/.test(x))]);
  }

  // 12  edge case: the build fails on a fresh checkout
  {
    const run = makeRun('run-badbuild', { build: BUILD('NoSuchScheme') });
    const before = rrDevices().length;
    const r = await runNode('capture.mjs', ['--app', run.file, '--out', run.golden]);
    check(12, 'given a build that fails on a fresh checkout, the build log tail is in the stop reason and no device is made',
      r.code === 1 && /The build failed \(exit \d+\)\. Last lines of the build log:/.test(r.text) && /NoSuchScheme/.test(r.text) && rrDevices().length === before,
      [r.text.trim().split('\n').slice(0, 3).join(' / ')]);
  }

  // 13  edge case: Xcode newer than the runtimes
  {
    const runtimes = sim.listRuntimes().runtimes.filter((r) => /SimRuntime\.iOS-/.test(r.identifier) && r.isAvailable !== false);
    const newest = [...runtimes].sort((a, b) => sim.compareVersions(b.version, a.version))[0];
    const sdk = sim.sdkVersion();
    const v = manifest.versions || {};
    check(13, 'given Xcode newer than the runtimes, the newest installed runtime is chosen and recorded in manifest.json',
      !!newest && v.runtime === newest.name && v.sdk === sdk && v.runtimeOlderThanSdk === (sim.compareVersions(newest.version, sdk) < 0),
      [`installed: ${runtimes.map((r) => r.name).join(', ')}; SDK ${sdk}; manifest: ${JSON.stringify({ runtime: v.runtime, sdk: v.sdk, runtimeOlderThanSdk: v.runtimeOlderThanSdk })}`]);
  }

  const left = rrDevices().length;
  note(`rr- devices left at the end: ${left - startDevices}`);
  if (left !== startDevices) results.push({ n: 'devices', name: 'no rr- device is left', ok: false });
} finally {
  server.close();
  if (process.env.RR_KEEP) fs.cpSync(base, process.env.RR_KEEP, { recursive: true }); // for looking at the goldens after a failure
  fs.rmSync(base, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length} of ${results.length} checks passed${failed.length ? '; failed: ' + failed.map((r) => r.n).join(', ') : ''}`);
process.exit(failed.length ? 1 : 0);

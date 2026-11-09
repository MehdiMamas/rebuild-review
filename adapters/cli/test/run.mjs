// Eight checks for the CLI adapter, run against the fixture tool in ./fixture. node test/run.mjs
// The known answers are in answers.json; only this file reads them. A planted problem the probes miss is printed as MISS and
// is not hidden or tuned away. A check fails only when the thing it protects is broken (a leak, a hang, a missing file, a false alarm on a clean screen).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const adapter = path.resolve(here, '..');
const answers = JSON.parse(fs.readFileSync(path.join(here, 'answers.json'), 'utf8'));
const runModule = await import(pathToFileURL(path.join(adapter, 'run.mjs')).href);
const { prepare, runCli, locate, networkMode, OUTPUT_CAP } = runModule;

const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rr-cli-test-')));
const results = [];
const note = (...a) => console.log('   ', ...a);
function check(n, name, ok, lines = []) {
  results.push({ n, name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}. ${name}`);
  for (const l of lines) note(l);
}

// ---- decoys: what the tool must not see of this machine ----
const secret = 'secret-' + crypto.randomBytes(6).toString('hex');
const token = 'token-' + crypto.randomBytes(6).toString('hex');
const realHome = path.join(base, 'real-home');
fs.mkdirSync(realHome);
fs.writeFileSync(path.join(realHome, '.fake-token'), token);

// A server on this machine's network address (not loopback). Anything that reaches it left the machine's allowed addresses.
let hits = 0;
const server = http.createServer((req, res) => { hits++; res.end('outside'); });
await new Promise((r) => server.listen(0, '0.0.0.0', r));
const lan = Object.values(os.networkInterfaces()).flat().find((i) => i && i.family === 'IPv4' && !i.internal);
const outside = lan ? `http://${lan.address}:${server.address().port}/` : 'http://192.0.2.1:9/';

function makeRun(name, runJson) {
  const dir = path.join(base, name);
  fs.mkdirSync(dir, { recursive: true });
  const work = path.join(dir, 'work');
  fs.cpSync(path.join(here, 'fixture'), work, { recursive: true });
  const git = (...a) => spawnSync('git', ['-C', work, '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...a], { encoding: 'utf8' });
  git('init', '-q'); git('add', '.'); git('commit', '-q', '-m', 'fixture');
  const file = path.join(dir, 'run.json');
  fs.writeFileSync(file, JSON.stringify(runJson));
  return { dir, work, file, git };
}
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const allFiles = (d, out = []) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); e.isDirectory() ? allFiles(p, out) : out.push(p); } return out; };
const env = { ...process.env, HOME: realHome, USERPROFILE: realHome, RR_SECRET_PARENT: secret };
function runNode(script, argv) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const c = spawn(process.execPath, [path.join(adapter, script), ...argv], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let text = '';
    c.stdout.on('data', (d) => (text += d)); c.stderr.on('data', (d) => (text += d));
    c.on('exit', (code) => resolve({ code, text, ms: Date.now() - t0 }));
  });
}

try {
  console.log(`network mode: ${networkMode()}; fixture outside address: ${lan ? outside : 'none (no non-loopback address on this machine)'}`);
  const main = makeRun('run-main', { platform: 'cli', command: ['./bin.mjs'], env: { RR_FIXTURE_ENV: 'from-run-env' } });
  const golden = path.join(main.dir, 'golden');
  const cap = await runNode('capture.mjs', ['--app', main.file, '--out', golden, '--states', path.join(here, 'states.json')]);
  note(`capture exited ${cap.code} in ${Math.round(cap.ms / 1000)} s: ${cap.text.trim().split('\n').pop()}`);
  const manifest = readJson(path.join(golden, 'manifest.json')) || { screens: [] };
  const probes = readJson(path.join(golden, 'probes.json')) || [];
  const ids = manifest.screens.map((s) => s.id);

  // 1
  {
    const bad = [];
    for (const f of ['manifest.json', 'network.har', 'timings.json', 'probes.json', 'probes-not-checked.json', 'console.log', 'coverage.json']) if (!fs.existsSync(path.join(golden, f))) bad.push(`missing ${f}`);
    const har = readJson(path.join(golden, 'network.har')); if (!har || !Array.isArray(har.log && har.log.entries)) bad.push('network.har is not a HAR');
    const tim = readJson(path.join(golden, 'timings.json')); if (!Array.isArray(tim) || tim.some((t) => !('name' in t && 'value' in t && 'unit' in t))) bad.push('timings.json is not a list of {name,value,unit}');
    else for (const n of ['startup-ms', 'help.ms']) if (!tim.some((t) => t.name === n)) bad.push(`timings.json has no ${n}`);
    if (!Array.isArray(probes) || probes.some((p) => !('probe' in p && 'screen' in p && 'passed' in p && 'evidence' in p))) bad.push('probes.json is not a list of {probe,screen,passed,evidence}');
    if (manifest.platform !== 'cli') bad.push(`manifest platform is "${manifest.platform}"`);
    if (!(manifest.notCaptured || []).some((x) => /no screens or screenshots/.test(x))) bad.push('notCaptured does not say there are no screens or screenshots');
    if (!(manifest.notCaptured || []).some((x) => /network/.test(x))) bad.push('notCaptured does not say how the network was blocked');
    for (const id of ids) {
      for (const f of ['stdout.txt', 'stderr.txt', 'result.json']) {
        const p = path.join(golden, 'screens', id, f);
        const binary = (f === 'stdout.txt' || f === 'stderr.txt') && (readJson(path.join(golden, 'screens', id, 'result.json')) || {})[`${f.slice(0, -4)}Binary`];
        if (binary) continue; // binary output: size and hash in result.json only
        if (!fs.existsSync(p)) bad.push(`screens/${id}/${f} missing`);
        else if (f === 'result.json') { const r = readJson(p); if (!r || !('args' in r && 'code' in r && 'ms' in r && 'timedOut' in r && Array.isArray(r.written))) bad.push(`screens/${id}/result.json lacks a field`); }
      }
    }
    check(1, 'capture writes every contract file, and each screen its output files', cap.code === 0 && !bad.length, [...bad.slice(0, 10), `${ids.length} screens checked`]);
  }

  // 2
  {
    const lines = [];
    const missing = answers.commands.filter((c) => !manifest.screens.some((s) => s.args.join(' ') === `${c} --help`));
    lines.push(`found ${ids.length} screens: ${ids.join(', ')}`);
    if (missing.length) lines.push(`commands not found: ${missing.join(', ')}`);
    // a tool listing 200 subcommands stops at 30 screens and says what it left out
    const many = makeRun('run-many', { platform: 'cli', command: ['node', '-e', 'for (const n of Array.from({ length: 200 }, (_, i) => "cmd" + i)) console.log("  " + n + "   does " + n)', '--'] });
    const mg = path.join(many.dir, 'golden');
    const mc = await runNode('capture.mjs', ['--app', many.file, '--out', mg]);
    const cov = readJson(path.join(mg, 'coverage.json')) || {};
    lines.push(`200 subcommands: ${(cov.screensReached || []).length} screens, ${(cov.screensCut || []).length} cut`);
    // a tool with no --help (exits non-zero) still gets its no-args and -h screens
    const nohelp = makeRun('run-nohelp', { platform: 'cli', command: ['node', '-e', 'if (process.argv.length > 1) { console.error("no such option"); process.exit(2) } console.log("hi")', '--'] });
    const nc = await runNode('capture.mjs', ['--app', nohelp.file, '--out', path.join(nohelp.dir, 'golden')]);
    const nm = readJson(path.join(nohelp.dir, 'golden', 'manifest.json')) || { screens: [] };
    const nps = readJson(path.join(nohelp.dir, 'golden', 'probes.json')) || [];
    lines.push(`no --help: ${nm.screens.map((s) => s.id).join(', ')}; help-exit ${nps.some((p) => p.probe === 'help-exit' && !p.passed) ? 'flagged' : 'not flagged'}`);
    // a nested command that repeats a top-level name (`remote add` and `add`) is still captured
    const nestedSrc = 'const a = process.argv.slice(1); if (a[0] === "add" && a[1] === "--help") console.log("Usage: add"); else if (a[0] === "remote" && a[1] === "--help") console.log("Usage: remote\\n\\n  add    Add a remote\\n  prune  Remove stale remotes"); else if (a[0] === "remote" && a[1] === "add" && a[2] === "--help") console.log("Usage: remote add <url>"); else if (a[0] === "--help") console.log("Usage: t\\n\\n  add     Add\\n  remote  Manage remotes"); else process.exit(2)';
    const nested = makeRun('run-nested', { platform: 'cli', command: ['node', '-e', nestedSrc, '--'] });
    await runNode('capture.mjs', ['--app', nested.file, '--out', path.join(nested.dir, 'golden')]);
    const nestedScreens = ((readJson(path.join(nested.dir, 'golden', 'manifest.json')) || { screens: [] }).screens).map((x) => x.id);
    lines.push(`nested names: ${nestedScreens.join(', ')}`);
    const nestedOk = nestedScreens.includes('remote-add') && nestedScreens.includes('add');
    check(2, 'discovery finds the commands from the help text, stops at the screen cap, and copes with a tool that has no --help',
      nestedOk && cap.code === 0 && !missing.length && mc.code === 0 && cov.screensReached.length === 30 && cov.screensCut.length > 0 && nc.code === 0 && nm.screens.some((s) => s.id === 'no-args') && nm.screens.some((s) => s.id === 'h') && nps.some((p) => p.probe === 'help-exit' && !p.passed), lines);
  }

  // 3
  {
    const lines = [];
    const flagged = probes.filter((p) => !p.passed);
    let falseAlarm = false;
    for (const e of answers.problems) {
      const hit = flagged.find((p) => p.probe === e.probe && p.screen === e.screen);
      lines.push(hit ? `${e.id} flagged (${hit.probe} on ${hit.screen}): ${hit.evidence}` : `${e.id} MISS: ${e.what}. No ${e.probe} flag on ${e.screen}.`);
    }
    const ctl = flagged.filter((p) => answers.clean.includes(p.screen));
    if (ctl.length) { falseAlarm = true; lines.push(`FALSE ALARM on a clean screen: ${ctl.map((p) => `${p.probe} on ${p.screen} (${p.evidence})`).join('; ')}`); }
    else lines.push(`clean screens (${answers.clean.join(', ')}): nothing flagged`);
    const extra = flagged.filter((p) => !answers.problems.some((e) => e.probe === p.probe && e.screen === p.screen) && !answers.clean.includes(p.screen));
    if (extra.length) lines.push(`also flagged (not in the answers): ${extra.map((p) => `${p.probe} on ${p.screen}`).join('; ')}`);
    // a filter tool that waits on stdin but prints a usage hint is not a hang
    const filter = makeRun('run-filter', { platform: 'cli', command: ['node', '-e', 'if (process.argv.length > 1) process.exit(0); console.error("send input on stdin"); process.stdin.resume()', '--'] });
    const { runProbes } = await import(pathToFileURL(path.join(adapter, 'probes.mjs')).href);
    const fr = await runProbes({ ctx: prepare(readJson(filter.file), filter.file), runs: [], timings: [], notChecked: [] });
    const hang = fr.find((p) => p.probe === 'stdin-hang');
    lines.push(`filter tool with a usage hint: stdin-hang ${hang && hang.passed ? 'passed' : 'FLAGGED'}`);
    check(3, 'each planted problem flagged, clean screens not (misses are reported, not hidden)', !falseAlarm && probes.length > 0 && !!hang && hang.passed, lines);
  }

  // 4
  {
    const lines = [];
    const leaks = [];
    for (const f of allFiles(golden)) {
      const t = fs.readFileSync(f, 'utf8');
      for (const [what, v] of [['parent secret', secret], ['token in the real home', token], ['real home path', realHome]]) if (t.includes(v)) leaks.push(`${what} appears in ${path.relative(golden, f)}`);
    }
    const saved = readJson(path.join(golden, 'screens', 'add-item', 'result.json')) || { written: [] };
    const inTempHome = saved.written.some((w) => w.path === 'home/.fixture.json');
    const inReal = fs.existsSync(path.join(realHome, '.fixture.json'));
    const dirty = main.git('status', '--porcelain').stdout.trim();
    lines.push(`save file written in the temp home: ${inTempHome}; in the real home: ${inReal}; work copy: ${dirty ? `changed (${dirty})` : 'clean'}`);
    check(4, 'the tool ran with an isolated home: its save file landed in the temp home, nothing in the real home or the work copy changed, no parent secret in the golden', !leaks.length && inTempHome && !inReal && !dirty, [...leaks, ...lines]);
  }

  // 5
  {
    const ctx = prepare(readJson(main.file), main.file);
    const before = hits;
    const r = await runCli(ctx, { args: ['fetch', outside] });
    const reached = hits - before;
    const major = Number(process.versions.node.split('.')[0]);
    const ok = r.code !== 0 && (!lan || reached === 0) && (networkMode() === 'namespace' || major >= 24);
    check(5, 'an outside fetch fails and nothing is reached', ok, [`mode: ${networkMode()}; node ${process.versions.node}; exit ${r.code}; the tool said: ${r.stderr.trim().split('\n')[0]}`, lan ? `requests that reached the outside server: ${reached}` : 'hit count not measured: no non-loopback address here']);
  }

  // 6
  {
    const tokenValue = 'tok_0123456789abcdef0123456789abcdef0123';
    const files = allFiles(golden);
    const forms = [Buffer.from(tokenValue), Buffer.from(Buffer.from(tokenValue).toString('base64').slice(0, 20)), Buffer.from(Buffer.concat([Buffer.from([0xff, 0xfe, 0x00]), Buffer.from(tokenValue)]).toString('base64').slice(0, 20))];
    const found = files.filter((f) => { const b = fs.readFileSync(f); return forms.some((x) => b.includes(x)); }).map((f) => path.relative(golden, f));
    const binRes = JSON.parse(fs.readFileSync(path.join(golden, 'screens', 'blob-token', 'result.json'), 'utf8'));
    const binKept = !!(binRes.stdoutBinary && binRes.stdoutBinary.bytes > 3 && binRes.stdoutBinary.sha256) && !files.some((f) => /\.bin$/.test(f));
    const listed = fs.readFileSync(path.join(golden, 'screens', 'list-all', 'stdout.txt'), 'utf8');
    check(6, 'a token-like value in the output is scrubbed in the golden', !found.length && binKept && listed.includes('token: [redacted]'), [`binary output with the token: size and hash only (${binKept})`, found.length ? `token still in: ${found.join(', ')}` : 'the token appears in no golden file', `list-all printed: ${listed.trim().split('\n').pop()}`]);
  }

  // 7
  {
    const tests = path.join(main.dir, 'tests');
    fs.mkdirSync(tests);
    const head = `import test from 'node:test'; import assert from 'node:assert/strict'; import fs from 'node:fs'; import { pathToFileURL } from 'node:url';
const { prepare, runCli } = await import(pathToFileURL(process.env.CLI_RUN_MODULE).href);
const ctx = prepare(JSON.parse(fs.readFileSync(process.env.APP_RUN, 'utf8')), process.env.APP_RUN);
`;
    fs.writeFileSync(path.join(tests, 'F-001.test.mjs'), head + `test('prints the version', async () => { const r = await runCli(ctx, { args: ['--version'] }); assert.equal(r.stdout.trim(), '1.0.0', 'expected version 1.0.0'); });\n`);
    fs.writeFileSync(path.join(tests, 'F-002.test.mjs'), head + `test('prints version 2', async () => { const r = await runCli(ctx, { args: ['--version'] }); assert.equal(r.stdout.trim(), '2.0.0', 'expected version 2.0.0'); });\n`);
    const out = path.join(main.dir, 'results.json');
    const p = await runNode('parity.mjs', ['--app', main.file, '--tests', tests, '--out', out]);
    const res = readJson(out) || [];
    const by = Object.fromEntries(res.map((x) => [x.feature, x]));
    check(7, 'parity on two tests gives one pass and one fail', p.code === 0 && by['F-001'] && by['F-001'].passed === true && by['F-002'] && by['F-002'].passed === false && /2\.0\.0/.test(by['F-002'].detail), [p.text.trim().split('\n').pop(), `F-002: ${by['F-002'] ? by['F-002'].detail.split('\n').find((l) => /expected|2\.0\.0/.test(l)) || 'no message' : 'missing'}`]);
  }

  // 8
  {
    const lines = [];
    const ctx = prepare(readJson(main.file), main.file);
    const held = await runCli(ctx, { args: ['hold'], timeoutMs: 1500 });
    const pid = Number((/child (\d+)/.exec(held.stdout) || [])[1]);
    await new Promise((r) => setTimeout(r, 300));
    let alive = true;
    try { process.kill(pid, 0); } catch { alive = false; }
    lines.push(`timed out: ${held.timedOut}; the child (a process the tool left running) is ${alive ? 'STILL RUNNING' : 'gone'}`);
    if (alive) try { process.kill(pid, 'SIGKILL'); } catch {}
    const big = await runCli(ctx, { args: ['blob', 'big'] });
    lines.push(`1.5 MB of output: kept ${big.stdout.length} bytes, cut noted: ${big.cut.stdout}`);
    const bin = await runCli(ctx, { args: ['blob', 'bin'] });
    const binOk = bin.stdoutB64 === Buffer.from([0xff, 0xfe, 0x00, 0x80, 0xc3, 0x28]).toString('base64') && bin.stdout === '';
    lines.push(`binary stdout kept as base64: ${binOk}`);
    let outsideRefused = false;
    try { locate({ command: ['/bin/ls'] }, main.file); } catch (e) { outsideRefused = /must stay inside/.test(e.message); }
    lines.push(`command outside the work copy refused: ${outsideRefused}`);
    const lt = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-cli-locate-'));
    fs.mkdirSync(path.join(lt, 'work'));
    for (const f of ['test', 'data.txt']) fs.writeFileSync(path.join(lt, 'work', f), 'x');
    const loc = locate({ command: ['node', 'test', 'data.txt'] }, path.join(lt, 'run.json'));
    fs.rmSync(lt, { recursive: true, force: true });
    const argsOk = loc.command[1] === 'test' && path.isAbsolute(loc.command[2]);
    lines.push(`a bare word that is also a file stays as is, a file name with an extension becomes a full path: ${argsOk}`);
    let winRefused = false;
    const real = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { value: 'win32' });
    try { await runCli(ctx, { args: ['--version'] }); } catch (e) { winRefused = /not supported on Windows/.test(e.message); } finally { Object.defineProperty(process, 'platform', real); }
    lines.push(`Windows refused with a reason: ${winRefused}`);
    check(8, 'a timeout kills the whole process group; output over 1 MB is cut and noted; binary output kept; outside command and Windows refused',
      held.timedOut && pid > 0 && !alive && big.cut.stdout && big.stdout.length === OUTPUT_CAP && binOk && outsideRefused && argsOk && winRefused, lines);
  }
} finally {
  server.close();
  fs.rmSync(base, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length} of ${results.length} checks passed${failed.length ? '; failed: ' + failed.map((r) => r.n).join(', ') : ''}`);
process.exit(failed.length ? 1 : 0);

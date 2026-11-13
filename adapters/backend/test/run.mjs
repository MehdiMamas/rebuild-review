// Twenty-nine checks for the backend adapter, run against the fixture service in ./fixture. node test/run.mjs
// The known answers are in answers.json; only this file reads them. A planted problem the probes miss is printed as MISS and
// is not hidden or tuned away. A check fails only when the thing it protects is broken (a leak, a hang, a missing file, a false alarm on a clean screen).
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const adapter = path.resolve(here, '..');
const answers = JSON.parse(fs.readFileSync(path.join(here, 'answers.json'), 'utf8'));

const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rr-backend-test-')));
const secret = 'secret-' + crypto.randomBytes(6).toString('hex');
const realHome = path.join(base, 'real-home');
fs.mkdirSync(realHome);
// The adapter must never use these: it starts the service with its own home.
process.env.HOME = realHome; process.env.USERPROFILE = realHome; process.env.RR_SECRET_PARENT = secret;
const api = await import(pathToFileURL(path.join(adapter, 'api.mjs')).href);
const { prepare, start, stop, restart, call, networkMode, checkEnv, killGroup } = api;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const note = (...a) => console.log('   ', ...a);
function check(n, name, ok, lines = []) {
  results.push({ n, name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}. ${name}`);
  for (const l of lines) note(l);
}

// A server on this machine's network address (not loopback). Anything that reaches it left the machine's allowed addresses.
let hits = 0;
const server = http.createServer((req, res) => { hits++; res.end('outside'); });
await new Promise((r) => server.listen(0, '0.0.0.0', r));
const lan = Object.values(os.networkInterfaces()).flat().find((i) => i && i.family === 'IPv4' && !i.internal);
const outside = lan ? `http://${lan.address}:${server.address().port}/` : 'http://192.0.2.1:9/';

const freePort = () => new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
async function makeRun(name, extra = {}, files = {}) {
  const dir = path.join(base, name);
  fs.mkdirSync(dir, { recursive: true });
  const work = path.join(dir, 'work');
  fs.cpSync(path.join(here, 'fixture'), work, { recursive: true });
  for (const [f, t] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(work, f)), { recursive: true }); fs.writeFileSync(path.join(work, f), t); }
  const git = (...a) => spawnSync('git', ['-C', work, '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...a], { encoding: 'utf8' });
  git('init', '-q'); git('add', '.'); git('commit', '-q', '-m', 'fixture');
  const file = path.join(dir, 'run.json');
  const run = { platform: 'backend', start: 'node server.mjs', address: `http://127.0.0.1:${await freePort()}`, ...extra };
  fs.writeFileSync(file, JSON.stringify(run));
  return { dir, work, file, run, git };
}
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const allFiles = (d, out = []) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); e.isDirectory() ? allFiles(p, out) : out.push(p); } return out; };
const env = { ...process.env };
function runNode(script, argv, extraEnv = {}) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const c = spawn(process.execPath, [path.join(adapter, script), ...argv], { env: { ...env, ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe'] });
    let text = '';
    c.stdout.on('data', (d) => (text += d)); c.stderr.on('data', (d) => (text += d));
    c.on('exit', (code) => resolve({ code, text, ms: Date.now() - t0 }));
  });
}
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const waitGone = async (pid) => { for (let i = 0; i < 30 && alive(pid); i++) await new Promise((r) => setTimeout(r, 100)); return !alive(pid); };
const idsOf = (golden) => ((readJson(path.join(golden, 'manifest.json')) || { screens: [] }).screens);

try {
  console.log(`network mode: ${networkMode()}; fixture outside address: ${lan ? outside : 'none (no non-loopback address on this machine)'}`);
  const main = await makeRun('run-main', { openapi: 'openapi.json' });
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
    const harText = JSON.stringify(readJson(path.join(golden, 'network.har')) || {});
    if (/"name":"(authorization|cookie|proxy-authorization|set-cookie)"/i.test(harText) || harText.includes('harcheck')) bad.push('network.har still holds an Authorization, Cookie or Set-Cookie header');
    else if (!/"name":"x-trace"/i.test(harText)) bad.push('network.har lost the other request headers of the with-auth step');
    if ((manifest.notCaptured || []).some((x) => /GET changed state/.test(x))) bad.push('a stable GET was noted as changing state');
    const har = readJson(path.join(golden, 'network.har')); if (!har || !Array.isArray(har.log && har.log.entries) || !har.log.entries.length) bad.push('network.har is not a HAR with entries');
    const tim = readJson(path.join(golden, 'timings.json')); if (!Array.isArray(tim) || tim.some((t) => !('name' in t && 'value' in t && 'unit' in t))) bad.push('timings.json is not a list of {name,value,unit}');
    else for (const n of ['startup-ms', 'get-items.ms', 'latency-ms']) if (!tim.some((t) => t.name === n)) bad.push(`timings.json has no ${n}`);
    if (!Array.isArray(probes) || probes.some((p) => !('probe' in p && 'screen' in p && 'passed' in p && 'evidence' in p))) bad.push('probes.json is not a list of {probe,screen,passed,evidence}');
    if (manifest.platform !== 'backend') bad.push(`manifest platform is "${manifest.platform}"`);
    if (!(manifest.notCaptured || []).some((x) => /no screens or screenshots: HTTP service/.test(x))) bad.push('notCaptured does not say there are no screens or screenshots');
    if (!(manifest.notCaptured || []).some((x) => /network/.test(x))) bad.push('notCaptured does not say how the network was blocked');
    const cov = readJson(path.join(golden, 'coverage.json')) || {};
    for (const k of ['screensReached', 'screensCut', 'operationsSkipped', 'surfaceKnown']) if (!(k in cov)) bad.push(`coverage.json has no ${k}`);
    for (const id of ids) {
      for (const f of ['request.json', 'response.json', 'result.json']) {
        const p = path.join(golden, 'screens', id, f);
        const j = readJson(p);
        if (!j) bad.push(`screens/${id}/${f} missing or not JSON`);
        else if (f === 'response.json' && !('status' in j && 'headers' in j && 'body' in j)) bad.push(`screens/${id}/response.json lacks a field`);
        else if (f === 'result.json' && !('ms' in j && 'cut' in j)) bad.push(`screens/${id}/result.json lacks a field`);
      }
    }
    check(1, 'capture writes every contract file, and each screen its request, response and result', cap.code === 0 && !bad.length, [...bad.slice(0, 10), `${ids.length} screens checked`]);
  }

  // 2
  {
    const lines = [];
    let flipOk = false;
    const has = (screens, r) => screens.some((s) => `${s.method} ${s.path}` === r);
    const missing = answers.routes.filter((r) => !has(manifest.screens, r));
    lines.push(`from the OpenAPI file: ${ids.length} screens: ${ids.join(', ')}`);
    if (missing.length) lines.push(`routes not found: ${missing.join(', ')}`);
    const covMain = readJson(path.join(golden, 'coverage.json')) || {};
    const skippedAuth = (covMain.operationsSkipped || []).some((o) => o.path === '/admin');
    lines.push(`the operation that needs a key is listed in operationsSkipped: ${skippedAuth}`);
    // the same routes found by probing when the OpenAPI file is not served
    const probed = await makeRun('run-probe', { env: { NO_OPENAPI: '1' } });
    const pc = await runNode('capture.mjs', ['--app', probed.file, '--out', path.join(probed.dir, 'golden')]);
    const pm = idsOf(path.join(probed.dir, 'golden'));
    const pcov = readJson(path.join(probed.dir, 'golden', 'coverage.json')) || {};
    const pmissing = answers.probeOnlyRoutes.filter((r) => !has(pm, r));
    lines.push(`by probing: ${pm.map((s) => s.id).join(', ')}${pmissing.length ? `; not found: ${pmissing.join(', ')}` : ''}`);
    // nothing to follow and no document: the surface is unknown and the run goes on
    const none = await makeRun('run-none', { env: { NO_OPENAPI: '1', NO_INDEX: '1' } });
    const nc = await runNode('capture.mjs', ['--app', none.file, '--out', path.join(none.dir, 'golden')]);
    const ncov = readJson(path.join(none.dir, 'golden', 'coverage.json')) || {};
    lines.push(`no document and a root that answers 404: exit ${nc.code}, surfaceKnown ${ncov.surfaceKnown}`);
    // a document listing 400 operations stops at 30 screens and says what it left out
    const doc = { openapi: '3.0.3', info: { title: 'many', version: '1' }, paths: Object.fromEntries(Array.from({ length: 400 }, (_, i) => [`/r${i}`, { get: { responses: { 200: { description: 'ok' } } } }])) };
    const manySrc = `import http from 'node:http'; const doc = ${JSON.stringify(JSON.stringify(doc))}; http.createServer((q, r) => { r.setHeader('content-type', 'application/json'); r.end(q.url === '/openapi.json' ? doc : '{"ok":true}'); }).listen(Number(process.env.PORT), '127.0.0.1');`;
    const many = await makeRun('run-many', { start: 'node many.mjs' }, { 'many.mjs': manySrc });
    const mc = await runNode('capture.mjs', ['--app', many.file, '--out', path.join(many.dir, 'golden')]);
    const mcov = readJson(path.join(many.dir, 'golden', 'coverage.json')) || {};
    lines.push(`400 operations: ${(mcov.screensReached || []).length} screens, ${(mcov.screensCut || []).length} cut`);
    // GraphQL: one POST /graphql, with introspection on (one screen) and off (a note)
    const gqSrc = (on) => `import http from 'node:http'; http.createServer((q, r) => { let b = ''; q.on('data', (d) => { b += d; }); q.on('end', () => { r.setHeader('content-type', 'application/json'); if (q.method === 'POST' && q.url === '/graphql') return r.end(JSON.stringify(${on ? "{ data: { __schema: { queryType: { name: 'Query' } } } }" : "{ errors: [{ message: 'introspection is disabled' }] }"})); r.statusCode = 404; r.end('{}'); }); }).listen(Number(process.env.PORT), '127.0.0.1');`;
    const gOn = await makeRun('run-gql-on', { start: 'node g.mjs' }, { 'g.mjs': gqSrc(true) });
    await runNode('capture.mjs', ['--app', gOn.file, '--out', path.join(gOn.dir, 'golden')]);
    const gOff = await makeRun('run-gql-off', { start: 'node g.mjs' }, { 'g.mjs': gqSrc(false) });
    const goff = await runNode('capture.mjs', ['--app', gOff.file, '--out', path.join(gOff.dir, 'golden')]);
    const gOnIds = idsOf(path.join(gOn.dir, 'golden')), gOffMan = readJson(path.join(gOff.dir, 'golden', 'manifest.json')) || {};
    const gqOk = gOnIds.length === 1 && gOnIds[0].method === 'POST' && gOnIds[0].path === '/graphql' && goff.code === 0 && (gOffMan.screens || []).length === 0 && (gOffMan.notCaptured || []).some((n) => /GraphQL/.test(n));
    lines.push(`GraphQL: introspection on gives ${gOnIds.length} screen (${gOnIds.map((x) => `${x.method} ${x.path}`).join()}); off gives ${(gOffMan.screens || []).length} screens and a note: ${(gOffMan.notCaptured || []).some((n) => /GraphQL/.test(n))}`);
    // a GET whose two captures differ in shape is noted; an echoed NODE_ENV is not a secret, an echoed API_TOKEN is
    const flipDoc = JSON.stringify({ openapi: '3.0.3', info: { title: 'flip', version: '1' }, paths: { '/flip': { get: { responses: { 200: { description: 'ok' } } } }, '/mode': { get: { responses: { 200: { description: 'ok' } } } }, '/tok': { get: { responses: { 200: { description: 'ok' } } } }, '/die': { get: { responses: { 200: { description: 'ok' } } } } } });
    const flipSrc = `import http from 'node:http'; const doc = ${JSON.stringify(flipDoc)}; let n = 0; http.createServer((q, r) => { r.setHeader('content-type', 'application/json'); if (q.url === '/openapi.json') return r.end(doc); if (q.url === '/flip') { n++; return r.end(JSON.stringify(Array.from({ length: n }, (_, i) => i))); } if (q.url === '/mode') return r.end(JSON.stringify({ mode: process.env.NODE_ENV })); if (q.url === '/tok') return r.end(JSON.stringify({ t: process.env.API_TOKEN })); if (q.url === '/die') return q.socket.destroy(); r.statusCode = 404; r.end('{}'); }).listen(Number(process.env.PORT), '127.0.0.1');`;
    const flip = await makeRun('run-flip', { start: 'node f.mjs', env: { NODE_ENV: 'development', API_TOKEN: 'plainvalue-1234' } }, { 'f.mjs': flipSrc });
    await runNode('capture.mjs', ['--app', flip.file, '--out', path.join(flip.dir, 'golden')]);
    const flipMan = readJson(path.join(flip.dir, 'golden', 'manifest.json')) || {};
    const flipProbes = readJson(path.join(flip.dir, 'golden', 'probes.json')) || [];
    const secretRows = flipProbes.filter((p) => p.probe === 'secret-in-response');
    const changed = (flipMan.notCaptured || []).some((x) => /GET changed state: GET \/flip/.test(x)) && !(flipMan.notCaptured || []).some((x) => /GET changed state: GET \/mode/.test(x));
    const modeClean = (secretRows.find((p) => p.screen === 'get-mode') || {}).passed === true, tokFlagged = (secretRows.find((p) => p.screen === 'get-tok') || {}).passed === false;
    lines.push(`GET that changes shape noted: ${changed}; echoed NODE_ENV not flagged: ${modeClean}; echoed API_TOKEN flagged: ${tokFlagged}`);
    const dieRow = flipProbes.find((p) => p.probe === 'server-error-on-valid' && p.screen === 'get-die') || {};
    // run.json env values with a secret-like name never reach the golden or the HAR; the HAR cap drops entries and counts them
    const flipFiles = allFiles(path.join(flip.dir, 'golden')).filter((f) => fs.readFileSync(f, 'utf8').includes('plainvalue-1234')).map((f) => path.relative(path.join(flip.dir, 'golden'), f));
    const tokBody = (readJson(path.join(flip.dir, 'golden', 'screens', 'get-tok', 'response.json')) || {}).body || {};
    const small = path.join(flip.dir, 'golden-small');
    await runNode('capture.mjs', ['--app', flip.file, '--out', small, '--max-har-bytes', '600']);
    const smallHar = (readJson(path.join(small, 'network.har')) || { log: { entries: [] } }).log.entries, fullHar = (readJson(path.join(flip.dir, 'golden', 'network.har')) || { log: { entries: [] } }).log.entries;
    const smallCov = readJson(path.join(small, 'coverage.json')) || {};
    lines.push(`a dead connection on a valid request fails: ${dieRow.passed === false}; env secret scrubbed from goldens and HAR: ${!flipFiles.length && tokBody.t === '***'}${flipFiles.length ? ` (still in ${flipFiles.join(', ')})` : ''}; HAR cap: ${smallHar.length} of ${fullHar.length} entries kept, ${smallCov.harEntriesSkipped} counted`);
    flipOk = changed && modeClean && tokFlagged && dieRow.passed === false && !flipFiles.length && tokBody.t === '***' && smallHar.length < fullHar.length && smallCov.harEntriesSkipped === fullHar.length - smallHar.length;
    // a response over 1 MB is cut and noted
    const bigDoc = JSON.stringify({ openapi: '3.0.3', info: { title: 'big', version: '1' }, paths: { '/big': { get: { responses: { 200: { description: 'ok' } } } }, '/sse': { get: { responses: { 200: { description: 'ok' } } } } } });
    const bigSrc = `import http from 'node:http'; const doc = ${JSON.stringify(bigDoc)}; http.createServer((q, r) => { if (q.url === '/openapi.json') { r.setHeader('content-type', 'application/json'); return r.end(doc); } if (q.url === '/sse') { r.writeHead(200, { 'content-type': 'text/event-stream' }); const t = setInterval(() => r.write('data: x\\n\\n'), 200); q.on('close', () => clearInterval(t)); return; } r.setHeader('content-type', 'text/plain'); r.end('a '.repeat(1500000)); }).listen(Number(process.env.PORT), '127.0.0.1');`;
    const big = await makeRun('run-big', { start: 'node b.mjs' }, { 'b.mjs': bigSrc });
    await runNode('capture.mjs', ['--app', big.file, '--out', path.join(big.dir, 'golden')]);
    const bigRes = readJson(path.join(big.dir, 'golden', 'screens', 'get-big', 'result.json')) || {};
    const bigMan = readJson(path.join(big.dir, 'golden', 'manifest.json')) || {};
    const bigOk = bigRes.cut === true && (bigMan.notCaptured || []).some((n) => /cut at 1 MB/.test(n));
    const sseRes = readJson(path.join(big.dir, 'golden', 'screens', 'get-sse', 'result.json')) || {};
    const sseProbe = (readJson(path.join(big.dir, 'golden', 'probes.json')) || []).find((x) => x.probe === 'no-timeout' && x.screen === 'get-sse') || {};
    const sseOk = (sseRes.cut === true || sseRes.error === 'timeout') && sseProbe.passed === true && /stream/.test(sseProbe.evidence || '');
    lines.push(`stream: result ${JSON.stringify(sseRes)}; probe ${sseProbe.passed} ${sseProbe.evidence}`);
    lines.push(`over 1 MB: cut ${bigRes.cut}, bytes ${bigRes.bytes}, noted ${(bigMan.notCaptured || []).some((n) => /cut at 1 MB/.test(n))}`);
    check(2, 'discovery finds the routes from the OpenAPI file and by probing, stops at the screen cap, and copes with a service that shows nothing',
      cap.code === 0 && !missing.length && skippedAuth && pc.code === 0 && !pmissing.length && pcov.surfaceKnown === true && nc.code === 0 && ncov.surfaceKnown === false
      && mc.code === 0 && (mcov.screensReached || []).length === 30 && (mcov.screensCut || []).length > 0 && gqOk && bigOk && sseOk && flipOk, lines);
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
    check(3, 'each planted problem flagged, clean screens not (misses are reported, not hidden)', !falseAlarm && probes.length > 0 && probes.some((p) => p.probe === 'latency-ms'), lines);
  }

  // 4
  {
    const lines = [];
    const leaks = [];
    for (const f of allFiles(golden)) {
      const t = fs.readFileSync(f, 'utf8');
      for (const [what, v] of [['parent secret', secret], ['real home path', realHome]]) if (t.includes(v)) leaks.push(`${what} appears in ${path.relative(golden, f)}`);
    }
    const ctx = prepare(main.run, main.file);
    await start(ctx);
    const post = await call(ctx, { method: 'POST', path: '/items', body: { name: 'stored' } });
    const seen = await call(ctx, { path: '/env' });
    const inTempHome = fs.existsSync(path.join(ctx.root, 'home', '.items.json'));
    const inReal = fs.existsSync(path.join(realHome, '.items.json'));
    const dirty = main.git('status', '--porcelain').stdout.trim();
    const homeOk = seen.body && typeof seen.body.home === 'string' && seen.body.home.startsWith(ctx.root) && seen.body.home !== realHome && seen.body.secret === null;
    await stop(ctx, { removeRoot: true });
    // file state inside the work copy: an untracked database and a tracked file; a fresh restart starts empty, a plain one keeps them
    const fr = await makeRun('run-files');
    const fctx = prepare(fr.run, fr.file);
    await start(fctx);
    await call(fctx, { method: 'POST', path: '/local' }); await call(fctx, { method: 'POST', path: '/local' });
    await restart(fctx, { fresh: false });
    const kept = await call(fctx, { path: '/local' });
    await restart(fctx, { fresh: true });
    const emptied = await call(fctx, { path: '/local' });
    const dbGone = !fs.existsSync(path.join(fr.work, 'local.db'));
    const filesClean = !fr.git('status', '--porcelain').stdout.trim();
    await stop(fctx, { removeRoot: true });
    // a tracked file the build changed keeps the build's content after a fresh restart
    const br = await makeRun('run-built', { build: `node -e "require('fs').writeFileSync('seed.txt','built-by-build\\n')"` });
    const bctx = prepare(br.run, br.file);
    await start(bctx);
    await call(bctx, { method: 'POST', path: '/local' });
    await restart(bctx, { fresh: true });
    const rebuilt = await call(bctx, { path: '/local' });
    await stop(bctx, { removeRoot: true });
    const builtKept = rebuilt.body && rebuilt.body.seed === 15;
    lines.push(`tracked file changed by the build: ${builtKept ? 'kept as built' : `not as built (seed length ${rebuilt.body && rebuilt.body.seed})`} after a fresh restart`);
    const filesOk = builtKept && kept.body && kept.body.rows === 2 && emptied.body && emptied.body.rows === 0 && emptied.body.seed === 5 && dbGone && filesClean;
    lines.push(`work-copy files: rows kept by a plain restart ${kept.body && kept.body.rows}, after a fresh restart ${emptied.body && emptied.body.rows}; tracked file back to how the build left it: ${filesClean}`);
    lines.push(`POST ${post.status}; save file in the temp home: ${inTempHome}; in the real home: ${inReal}; service home isolated, parent secret not seen: ${homeOk}; work copy: ${dirty ? `changed (${dirty})` : 'clean'}`);
    check(4, 'a fresh restart empties file stores in the work copy; the service ran with an isolated home: its file landed in the temp home, nothing in the real home or the work copy changed, no parent secret or home path in the golden', !leaks.length && filesOk && inTempHome && !inReal && !dirty && homeOk, [...leaks, ...lines]);
  }

  // 5
  {
    const ctx = prepare(main.run, main.file);
    const before = hits;
    const r = await call(ctx, { path: '/fetch', query: { url: outside }, timeoutMs: 15000 });
    const reached = hits - before;
    await stop(ctx, { removeRoot: true });
    const major = Number(process.versions.node.split('.')[0]);
    const ok = r.status === 502 && (!lan || reached === 0) && (networkMode() === 'namespace' || major >= 24);
    check(5, 'an outside fetch from the service fails and nothing is reached', ok, [`mode: ${networkMode()}; node ${process.versions.node}; the service answered ${r.status} ${JSON.stringify(r.body)}`, lan ? `requests that reached the outside server: ${reached}` : 'hit count not measured: no non-loopback address here']);
  }

  // 6
  {
    const token = answers.token;
    const found = allFiles(golden).filter((f) => fs.readFileSync(f, 'utf8').includes(token)).map((f) => path.relative(golden, f));
    const resp = readJson(path.join(golden, 'screens', 'get-session', 'response.json')) || {};
    const har = JSON.stringify((readJson(path.join(golden, 'network.har')) || {}).log || {});
    const inHar = har.includes('/session');
    check(6, 'a token-like value in a response is scrubbed in the golden and the HAR', !found.length && inHar && resp.body && resp.body.user === 'demo' && !String(resp.body.token).includes(token),
      [found.length ? `token still in: ${found.join(', ')}` : 'the token appears in no golden file', `the HAR has the call: ${inHar}`, `get-session body: ${JSON.stringify(resp.body)}`]);
  }

  // 7
  {
    const lines = [];
    const st = readJson(path.join(golden, 'screens', 'create-then-read', 'response.json')) || {};
    const list = readJson(path.join(golden, 'screens', 'get-items', 'response.json')) || {};
    const vol = (manifest.volatile || {})['create-then-read'] || [];
    lines.push(`create-then-read body: ${JSON.stringify(st.body)}; volatile: ${vol.join(', ')}`);
    lines.push(`get-items body: ${JSON.stringify(list.body)}`);
    const ok = st.body && st.body.id === '<varies>' && st.body.createdAt === '<varies>' && st.body.name === 'made' && vol.includes('id')
      && Array.isArray(list.body) && list.body.length === 1 && list.body[0].id === 'demo' && !JSON.stringify(list.body).includes('<varies>');
    check(7, 'ids and timestamps that differ between two captures become "<varies>"; stable fields stay', !!ok, lines);
  }

  // 8
  {
    const tests = path.join(main.dir, 'tests');
    fs.mkdirSync(tests);
    const head = `import test from 'node:test'; import assert from 'node:assert/strict'; import fs from 'node:fs'; import { pathToFileURL } from 'node:url';
const { prepare, call } = await import(pathToFileURL(process.env.API_MODULE).href);
const ctx = prepare(JSON.parse(fs.readFileSync(process.env.APP_RUN, 'utf8')), process.env.APP_RUN);
`;
    fs.writeFileSync(path.join(tests, 'F-001.test.mjs'), head + `test('lists the items', async () => { const r = await call(ctx, { path: '/items' }); assert.equal(r.status, 200, 'expected status 200 from GET /items'); });\n`);
    fs.writeFileSync(path.join(tests, 'F-002.test.mjs'), head + `test('lists with 201', async () => { const r = await call(ctx, { path: '/items' }); assert.equal(r.status, 201, 'expected status 201 from GET /items'); });\n`);
    const out = path.join(main.dir, 'results.json');
    const p = await runNode('parity.mjs', ['--app', main.file, '--tests', tests, '--out', out]);
    const res = readJson(out) || [];
    const by = Object.fromEntries(res.map((x) => [x.feature, x]));
    // the second test starts without the file the first one left in the work copy
    const pf = await makeRun('run-parfiles');
    const ptests = path.join(pf.dir, 'tests'); fs.mkdirSync(ptests);
    fs.writeFileSync(path.join(ptests, 'F-001.test.mjs'), head + `test('writes', async () => { const r = await call(ctx, { method: 'POST', path: '/local' }); assert.equal(r.body.rows, 1, 'expected one row after the first write'); });\n`);
    fs.writeFileSync(path.join(ptests, 'F-002.test.mjs'), head + `test('starts empty', async () => { const r = await call(ctx, { path: '/local' }); assert.equal(r.body.rows, 0, 'expected no rows left by the earlier test'); });\n`);
    const pout = path.join(pf.dir, 'results.json');
    const pp = await runNode('parity.mjs', ['--app', pf.file, '--tests', ptests, '--out', pout]);
    const pres = readJson(pout) || [];
    const parFiles = pp.code === 0 && pres.length === 2 && pres.every((x) => x.passed);
    check(8, 'parity on two tests gives one pass and one fail; a test starts without files an earlier test left', p.code === 0 && by['F-001'] && by['F-001'].passed === true && by['F-002'] && by['F-002'].passed === false && /201/.test(by['F-002'].detail) && parFiles, [p.text.trim().split('\n').pop(), `F-002: ${by['F-002'] ? by['F-002'].detail.split('\n').find((l) => /expected|201/.test(l)) || 'no message' : 'missing'}`]);
  }

  // 9
  {
    const lines = [];
    // a service that never answers: start gives up, and the child it started is gone
    const hang = await makeRun('run-hang', { start: 'node hang.mjs' });
    process.env.RR_READY_MS = '1500';
    const hctx = prepare(hang.run, hang.file);
    let hangErr = '';
    try { await start(hctx); } catch (e) { hangErr = e.message; }
    delete process.env.RR_READY_MS;
    const pid1 = Number(fs.readFileSync(path.join(hctx.root, 'tmp', 'child.pid'), 'utf8') || 0);
    const gone1 = pid1 > 0 && await waitGone(pid1);
    lines.push(`never answers: start gave up (${/did not answer/.test(hangErr)}); its child ${gone1 ? 'is gone' : 'STILL RUNNING'}`);
    if (!gone1 && pid1) try { process.kill(pid1, 'SIGKILL'); } catch {}
    await stop(hctx, { removeRoot: true });
    // a child the service left running is killed with it
    const ctx = prepare(main.run, main.file);
    const sp = await call(ctx, { path: '/spawn' });
    const pid2 = sp.body && sp.body.pid;
    const aliveBefore = pid2 ? alive(pid2) : false;
    await stop(ctx, { removeRoot: true });
    const gone2 = pid2 ? await waitGone(pid2) : false;
    lines.push(`a child left by the service: ${aliveBefore ? 'running' : 'not seen running'} before stop, ${gone2 ? 'gone' : 'STILL RUNNING'} after`);
    if (!gone2 && pid2) try { process.kill(pid2, 'SIGKILL'); } catch {}
    let storeRefused = false, localOk = true;
    try { checkEnv({ DATABASE_URL: 'postgres://db.example.com:5432/app' }); } catch (e) { storeRefused = /outside this machine/.test(e.message); }
    try { checkEnv({ DATABASE_URL: 'postgres://localhost/app', REDIS_HOST: '127.0.0.1' }); } catch { localOk = false; }
    lines.push(`store outside the machine refused: ${storeRefused}; a stand-in on this machine accepted: ${localOk}`);
    let outsideAddr = false;
    try { prepare({ platform: 'backend', start: 'x', address: 'http://example.com:80' }, path.join(base, 'x', 'run.json')); } catch { outsideAddr = true; }
    lines.push(`address not on this machine refused: ${outsideAddr}`);
    let winRefused = false;
    const real = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { value: 'win32' });
    try { prepare(main.run, path.join(base, 'win', 'run.json')); } catch (e) { winRefused = /not supported on Windows/.test(e.message); } finally { Object.defineProperty(process, 'platform', real); }
    lines.push(`Windows refused with a reason: ${winRefused}`);
    // a process group is signalled only through a child that has not ended
    const done = spawn('sh', ['-c', 'exit 0'], { stdio: 'ignore', detached: true });
    await new Promise((r) => done.once('exit', r));
    const realKill = process.kill; let signalled = 0;
    process.kill = (...a) => { if (a[1] === 'SIGKILL') signalled++; return realKill.apply(process, a); };
    killGroup(done);
    process.kill = realKill;
    const noStale = signalled === 0;
    lines.push(`killGroup on a child that already exited sent ${signalled} signals`);
    // the call helper ending before the service answers is reported at once with its exit code and last stderr line
    let helperOk = true;
    if (networkMode() === 'namespace') {
      const fake = path.join(base, 'fake-nsenter.sh');
      fs.writeFileSync(fake, '#!/bin/sh\necho "first line" >&2\necho "nsenter: boom" >&2\nexit 7\n', { mode: 0o755 });
      const hr = await makeRun('run-helper');
      process.env.RR_NSENTER = fake;
      const hc = prepare(hr.run, hr.file);
      const t1 = Date.now(); let herr = '';
      try { await start(hc); } catch (e) { herr = e.message; }
      delete process.env.RR_NSENTER;
      await stop(hc, { removeRoot: true });
      helperOk = /exit 7/.test(herr) && /boom/.test(herr) && Date.now() - t1 < 10000;
      lines.push(`helper that exits early: ${herr.split('\n')[0]}`);
    } else lines.push('helper that exits early: not checked here (needs the Linux namespace mode)');
    // store URLs in the work copy's own files are refused with the file and scheme, never the value
    const envRun = await makeRun('run-envfile', {}, { '.env': 'DATABASE_URL=postgres://db.example.com/x\n' });
    let envErr = ''; try { prepare(envRun.run, envRun.file); } catch (e) { envErr = e.message; }
    const cfgRun = await makeRun('run-cfgfile', {}, { 'config/app.yaml': 'cache: rediss://u:p@cache.example.com:6380/0\n' });
    let cfgErr = ''; try { prepare(cfgRun.run, cfgRun.file); } catch (e) { cfgErr = e.message; }
    const okRun = await makeRun('run-envlocal', { env: { MQ_URL: 'x' } }, { '.env': 'DATABASE_URL=postgres://localhost/x\nMQ_URL=amqp://mq.example.com\n', '.env.example': 'DATABASE_URL=postgres://db.example.com/x\n' });
    let okErr = ''; try { prepare(okRun.run, okRun.file); } catch (e) { okErr = e.message; }
    const envRefused = /\.env holds a postgres:\/\/ store URL/.test(envErr) && !envErr.includes('example.com') && /config\/app\.yaml holds a rediss:\/\//.test(cfgErr) && !cfgErr.includes('example.com') && okErr === '';
    const ymlRun = await makeRun('run-rootyml', {}, { 'application.yml': 'spring:\n  datasource:\n    url: postgres://db.example.com/x\n', 'package.json': '{"name":"x","note":"postgres://db.example.com/y"}' });
    let ymlErr = ''; try { prepare(ymlRun.run, ymlRun.file); } catch (e) { ymlErr = e.message; }
    const pkgRun = await makeRun('run-rootpkg', {}, { 'package.json': '{"name":"x","note":"postgres://db.example.com/y"}' });
    let pkgErr = ''; try { prepare(pkgRun.run, pkgRun.file); } catch (e) { pkgErr = e.message; }
    const cmdRun = await makeRun('run-cmdstore', { start: 'DATABASE_URL=mongodb+srv://u:p@cluster.example.net/app node server.mjs' });
    let cmdErr = ''; try { prepare(cmdRun.run, cmdRun.file); } catch (e) { cmdErr = e.message; }
    const rootOk = /application\.yml holds a postgres:\/\//.test(ymlErr) && !ymlErr.includes('example.com') && pkgErr === '' && /run\.json start holds a mongodb\+srv:\/\//.test(cmdErr) && !cmdErr.includes('example.net');
    lines.push(`.env with an outside store refused without its value: ${envRefused}; root application.yml and a command with a store URL refused, package.json skipped: ${rootOk}`);
    // a work copy that is not a git repo says its file stores were not reset
    const ng = await makeRun('run-nogit');
    fs.rmSync(path.join(ng.work, '.git'), { recursive: true, force: true });
    const nctx = prepare(ng.run, ng.file);
    await start(nctx); await restart(nctx, { fresh: true }); await stop(nctx, { removeRoot: true });
    const noGitNote = nctx.notes.includes('fresh restart: work copy is not a git repo, file stores not reset');
    lines.push(`not a git repo: note given: ${noGitNote}`);
    // something that accepts and never answers on the port does not hang the start check (proxy mode)
    let slowOk = true;
    if (networkMode() === 'proxy') {
      const hang2 = await makeRun('run-slowcheck', { start: 'node hang.mjs' });
      const dummy = net.createServer((sock) => { sock.on('error', () => {}); });
      await new Promise((r) => dummy.listen(Number(new URL(hang2.run.address).port), '127.0.0.1', r));
      process.env.RR_READY_MS = '2000';
      const sctx = prepare(hang2.run, hang2.file);
      const t2 = Date.now(); let serr = '';
      try { await start(sctx); } catch (e) { serr = e.message; }
      delete process.env.RR_READY_MS;
      await stop(sctx, { removeRoot: true });
      dummy.close();
      slowOk = Date.now() - t2 < 15000 && !/refusing to start/.test(serr);
      lines.push(`start check with a silent listener: took ${Date.now() - t2} ms, ${serr.split(':')[0]}`);
    } else lines.push('start check with a silent listener: not checked here (proxy mode only)');
    check(9, 'a service that never answers is stopped with its child; a child left behind is killed on stop; an outside store, an outside address and Windows are refused',
      /did not answer/.test(hangErr) && gone1 && aliveBefore && gone2 && noStale && helperOk && envRefused && rootOk && noGitNote && slowOk && storeRefused && localOk && outsideAddr && winRefused, lines);
  }

  // ---- stores (checks 10 onward): a fake container runtime stands in for docker (RR_CONTAINER) and keeps a log of every call ----
  const storesApi = await import(pathToFileURL(path.join(adapter, 'stores.mjs')).href);
  const { validateStores, cleanupSync } = storesApi;
  const linux = process.platform === 'linux';
  const nsAvail = networkMode() === 'namespace';
  const IMG = 'kv@sha256:' + 'a'.repeat(64);
  const fakeDir = path.join(base, 'fake');
  const fakeBin = path.join(base, 'fake-docker.sh');
  fs.writeFileSync(fakeBin, `#!/bin/sh\nexec '${process.execPath}' '${path.join(here, 'fake-runtime.mjs')}' "$@"\n`, { mode: 0o755 });
  process.env.RR_CONTAINER = fakeBin; process.env.RR_FAKE_DIR = fakeDir;
  const fakeLog = () => { try { return fs.readFileSync(path.join(fakeDir, 'calls.log'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
  const fakeState = () => readJson(path.join(fakeDir, 'state.json')) || { containers: {}, networks: {} };
  const setState = (fn) => { const s = fakeState(); fn(s); fs.writeFileSync(path.join(fakeDir, 'state.json'), JSON.stringify(s)); };
  const left = () => { const s = fakeState(); return Object.keys(s.containers).length + Object.keys(s.networks).length; };
  const callsSince = (mark) => fakeLog().slice(mark).map((a) => a.slice(0, a[0] === 'network' ? 2 : 1).join(' '));
  const withEnv = async (vars, fn) => {
    const old = {};
    for (const [k, v] of Object.entries(vars)) { old[k] = process.env[k]; if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    try { return await fn(); } finally { for (const [k, v] of Object.entries(old)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
  };
  const kvRun = async (name, extra = {}, storeExtra = {}) => {
    const sp = await freePort();
    const r = await makeRun(name, { stores: [{ name: 'kv', image: IMG, port: sp, ...storeExtra }], env: { KV_ADDR: `127.0.0.1:${sp}` }, ...extra });
    r.sp = sp; return r;
  };
  const put = (ctx, key, value) => call(ctx, { method: 'PUT', path: '/kv', body: { key, value } });
  const get = (ctx, key) => call(ctx, { method: 'GET', path: '/kv', query: { key } });
  const refusal = async (fn) => { try { await fn(); return ''; } catch (e) { return e.message; } };
  const down = (ctx) => stop(ctx, { removeRoot: true });
  const skip = (n, name, why) => check(n, name, true, [`not checked here (${why})`]);

  // 10
  {
    const lines = [];
    const good = { name: 'kv', image: IMG, port: 6400 };
    const table = [
      ['an image by tag', [{ ...good, image: 'redis:7' }], /store "kv".*digest/],
      ['two stores with one name', [good, { ...good, port: 6401 }], /name is used twice/],
      ['two stores with one port', [good, { ...good, name: 'two' }], /port 6400 is already used/],
      ['a bad name', [{ ...good, name: 'Bad_Name' }], /name must match/],
      ['a port out of range', [{ ...good, port: 70000 }], /port must be/],
      ['an unknown key', [{ ...good, volume: '/x' }], /unknown key "volume"/],
      ['an image that starts with a dash', [{ ...good, image: `--volume=/etc:/x:ro,z@sha256:${'a'.repeat(64)}` }], /digest/],
      ['an image with text after the digest', [{ ...good, image: `${IMG} --privileged` }], /digest/],
      ['an env name with =', [{ ...good, env: { 'A=B': 'x' } }], /env name "A=B" must match/],
      ['an empty env name', [{ ...good, env: { '': 'x' } }], /env name "" must match/],
      ['a non-string env value', [{ ...good, env: { A: 1 } }], /env A must be a string/],
      ['a ready that is not a list', [{ ...good, ready: 'pg_isready' }], /ready must be a command/],
      ['a store port equal to the service port', [{ ...good, port: 3000 }], /port of the service itself/],
      ['more than five stores', Array.from({ length: 6 }, (_, i) => ({ ...good, name: `s${i}`, port: 6400 + i })), /at most 5/],
    ];
    let allRefused = true;
    for (const [what, list, re] of table) {
      let msg = ''; try { validateStores(list, 3000); } catch (e) { msg = e.message; }
      const ok = re.test(msg); allRefused = allRefused && ok;
      lines.push(`${what}: ${ok ? 'refused' : 'NOT refused as expected (' + msg + ')'}`);
    }
    let accepted = true; try { validateStores([good, { ...good, name: 'two', port: 6401, env: { A: 'b' }, ready: ['true'], memory: '2g' }], 3000); } catch { accepted = false; }
    lines.push(`a valid list accepted: ${accepted}`);
    // through prepare: refusals come before any pull or container
    const tag = await kvRun('run-tag', {}, { image: 'redis:7' });
    let mark = fakeLog().length;
    const tagMsg = await refusal(() => prepare(tag.run, tag.file));
    const tagOk = /store "kv"/.test(tagMsg) && !fakeLog().slice(mark).some((a) => ['pull', 'run'].includes(a[0]));
    lines.push(`tag image through prepare: refused naming the store, no pull: ${tagOk}`);
    const https = await kvRun('run-https443', { address: 'https://127.0.0.1' }, { port: 443 });
    mark = fakeLog().length;
    const httpsMsg = await refusal(() => prepare(https.run, https.file));
    const httpsOk = /port of the service itself/.test(httpsMsg) && !fakeLog().slice(mark).some((a) => ['pull', 'run'].includes(a[0]));
    lines.push(`https address without a port, store on 443: refused: ${httpsOk}`);
    const noRt = await kvRun('run-nort');
    mark = fakeLog().length;
    const emptyBin = path.join(base, 'empty-bin'); fs.mkdirSync(emptyBin, { recursive: true });
    const rtMsg = await withEnv({ RR_CONTAINER: undefined, PATH: emptyBin }, () => refusal(() => prepare(noRt.run, noRt.file)));
    const rtOk = /docker/.test(rtMsg) && /podman/.test(rtMsg) && fakeLog().length === mark;
    lines.push(`no container runtime: ${rtMsg.slice(0, 90)}; nothing started: ${rtOk}`);
    const rl = await kvRun('run-rootless');
    mark = fakeLog().length;
    const rlMsg = await withEnv({ RR_FAKE_ROOTLESS: '1' }, () => refusal(() => prepare(rl.run, rl.file)));
    const rlOk = /rootless/.test(rlMsg) && !fakeLog().slice(mark).some((a) => ['pull', 'run', 'network'].includes(a[0]));
    lines.push(`rootless runtime: ${rlMsg.slice(0, 90)}; nothing started: ${rlOk}`);
    const pf = await kvRun('run-pullfail');
    mark = fakeLog().length;
    const pfMsg = await withEnv({ RR_FAKE_PULL_FAIL: '1' }, () => refusal(() => prepare(pf.run, pf.file)));
    const pfOk = /manifest for .* not found/.test(pfMsg) && /store "kv"/.test(pfMsg) && !fakeLog().slice(mark).some((a) => a[0] === 'run');
    lines.push(`pull fails: ${pfMsg.slice(0, 110)}; no container started: ${pfOk}`);
    const plain = await makeRun('run-nostores');
    mark = fakeLog().length;
    const pctx = prepare(plain.run, plain.file);
    await start(pctx); const pr = await call(pctx, { path: '/items' }); await down(pctx);
    const plainOk = pr.status === 200 && fakeLog().length === mark;
    lines.push(`no stores: service answers, the runtime was never called: ${plainOk}`);
    const pre = await kvRun('run-prepared');
    mark = fakeLog().length;
    await withEnv({ RR_PREPARED: '1' }, async () => { prepare(pre.run, pre.file); });
    const calls = callsSince(mark);
    const preOk = !calls.includes('pull') && !calls.includes('ps') && !calls.includes('network ls');
    lines.push(`RR_PREPARED=1 with stores: calls were ${calls.join(', ')}; no pull, no sweep: ${preOk}`);
    const off = await kvRun('run-offbox', { env: { DATABASE_URL: 'postgres://db.example.com:5432/app' } });
    const offMsg = await refusal(() => prepare(off.run, off.file));
    const offOk = /outside this machine/.test(offMsg);
    lines.push(`run.env at a store off this machine while stores is set: refused: ${offOk}`);
    check(10, 'stores: bad lists, a missing or rootless runtime, a failed pull and an off-machine env are refused before anything starts; no stores means no runtime lookup; RR_PREPARED=1 skips pull and sweep', allRefused && accepted && tagOk && httpsOk && rtOk && rlOk && pfOk && plainOk && preOk && offOk, lines);
  }

  // 11 / 12
  for (const [n, mode] of [[11, 'namespace'], [12, 'proxy']]) {
    const name = `a service calls its store on 127.0.0.1:<port> and gets answers, in ${mode} mode`;
    if (!linux || (mode === 'namespace' && !nsAvail)) { skip(n, name, mode === 'namespace' ? 'needs the Linux namespace mode' : 'the fake container listens on 127.0.0.2, Linux only'); continue; }
    await withEnv({ RR_NET_MODE: mode === 'proxy' ? 'proxy' : undefined }, async () => {
      const r = await kvRun(`run-reach-${mode}`);
      const ctx = prepare(r.run, r.file);
      const lines = [`mode: ${networkMode()}`];
      let ok = networkMode() === mode;
      try {
        await start(ctx);
        const w = await put(ctx, 'a', '1'); const g = await get(ctx, 'a');
        lines.push(`write: ${w.status} ${JSON.stringify(w.body)}; read: ${g.status} ${JSON.stringify(g.body)}`);
        ok = ok && w.status === 200 && g.body && g.body.value === '1';
        if (mode === 'proxy') {
          // the proxy-mode port is taken on this machine: refused with a reason, nothing killed, no container started
          const t = await kvRun('run-port-taken');
          const holder = net.createServer((s) => s.end('held'));
          await new Promise((res) => holder.listen(t.sp, '127.0.0.1', res));
          const mark = fakeLog().length;
          const tctx = prepare(t.run, t.file);
          const mark2 = fakeLog().length;
          const msg = await refusal(() => start(tctx));
          const stillHeld = holder.listening;
          holder.close();
          const taken = /already in use/.test(msg) && stillHeld && !fakeLog().slice(mark2).some((a) => a[0] === 'run' || (a[0] === 'network' && a[1] === 'create'));
          lines.push(`port taken: ${msg.slice(0, 100)}; listener untouched and no container started: ${taken}`);
          ok = ok && taken; void mark;
        }
      } finally { await down(ctx); }
      check(n, name, ok, lines);
    });
  }

  // 13
  if (!linux) skip(13, 'a fresh restart replaces the stores and empties them; a restart that keeps the temp root, and a service that died and is started by call, keep them', 'Linux only');
  else {
    const lines = [];
    const r = await kvRun('run-restarts');
    const ctx = prepare(r.run, r.file);
    let ok = true;
    try {
      await start(ctx);
      await put(ctx, 'a', '1');
      const names1 = Object.keys(fakeState().containers);
      await restart(ctx, { fresh: false });
      const keep = Object.keys(fakeState().containers).join() === names1.join() && (await get(ctx, 'a')).body.value === '1';
      lines.push(`restart keeping the temp root: same containers, value kept: ${keep}`);
      killGroup(ctx.proc); await sleep(400);
      const viaCall = await get(ctx, 'a');
      const kept2 = Object.keys(fakeState().containers).join() === names1.join() && viaCall.body && viaCall.body.value === '1';
      lines.push(`service killed, call starts it again: same containers, value kept: ${kept2}`);
      await restart(ctx, { fresh: true });
      const st = Object.keys(fakeState().containers);
      const fresh = st.length === 1 && !names1.includes(st[0]) && (await get(ctx, 'a')).body.value === '';
      lines.push(`fresh restart: old containers removed (${names1.length} before, ${st.length} now, names differ), new ones start, value gone: ${fresh}`);
      ok = keep && kept2 && fresh;
    } finally { await down(ctx); }
    check(13, 'a fresh restart replaces the stores and empties them; a restart that keeps the temp root, and a service that died and is started by call, keep them', ok, lines);
  }

  // 14
  if (!linux) skip(14, 'a run.env that names a store port not in stores is a service error, not a hang', 'Linux only');
  else {
    const free = await freePort();
    const r = await kvRun('run-unknown-port', { env: { KV_ADDR: '127.0.0.1:' + free } });
    const ctx = prepare(r.run, r.file);
    let g; const t0 = Date.now();
    try { await start(ctx); g = await get(ctx, 'a'); } finally { await down(ctx); }
    const ms = Date.now() - t0;
    check(14, 'a run.env that names a store port not in stores is a service error, not a hang', g.status === 502 && /store:/.test(JSON.stringify(g.body)) && ms < 15000, [`answer ${g.status} ${JSON.stringify(g.body)} after ${ms} ms`]);
  }

  // 15, 16, 17, 30, 31: containers that do not come up
  for (const [n, name, vars, storeExtra, want] of [
    [15, 'a container that never becomes ready stops the start, removes everything, and the error names the store and its last log lines', { RR_FAKE_NEVER_READY: '1', RR_STORE_READY_MS: '2500' }, {}, [/store "kv" did not become ready within 3 s \(its address 127\.0\.0\.2:\d+ may not be reachable/, /still initialising database/]],
    [16, 'a ready command that hangs ends at the ready limit and everything is removed', { RR_STORE_READY_MS: '2500' }, { ready: ['hang'] }, [/store "kv" did not become ready/]],
    [17, 'a container that exits at once after run: the error names the store and its last log lines', { RR_FAKE_EXIT_AT_ONCE: '1' }, {}, [/store "kv" exited before it was ready/, /data directory is not writable/]],
    [30, 'a container whose inspect gives no address stops the start with an error naming the store, and everything is removed', { RR_FAKE_NO_ADDRESS: '1' }, {}, [/store "kv": no address for its container \(it probably exited at once\)/]],
    [31, 'a container whose inspect fails stops the start with an error that says inspect failed, and everything is removed', { RR_FAKE_INSPECT_FAIL: '1' }, {}, [/store "kv": could not inspect its container: .*inspect failed/]],
  ]) {
    if (!linux) { skip(n, name, 'Linux only'); continue; }
    const r = await kvRun(`run-down-${n}`, {}, storeExtra);
    const ctx = prepare(r.run, r.file);
    const t0 = Date.now();
    const msg = await withEnv(vars, () => refusal(() => start(ctx)));
    const ms = Date.now() - t0;
    const ok = want.every((re) => re.test(msg)) && left() === 0 && ctx.root === null && ms < 20000;
    check(n, name, ok, [`${msg.slice(0, 160)}`, `${ms} ms; containers and networks left: ${left()}; temp root removed: ${ctx.root === null}`]);
    for (const c of Object.keys(fakeState().containers)) spawnSync(fakeBin, ['rm', '-f', c]);
  }

  // 18
  if (!linux) skip(18, 'a service that exits before it answers takes the stores and root down, and a later start brings the stores up again', 'Linux only');
  else {
    const r = await kvRun('run-svc-exit', { start: 'exit 3' });
    const ctx = prepare(r.run, r.file);
    const msg = await refusal(() => start(ctx));
    const gone = left() === 0 && ctx.root === null && !ctx.stores.up;
    ctx.run.start = 'node server.mjs';
    let again = false;
    try { await start(ctx); again = ctx.stores.up && left() === 2 && (await put(ctx, 'b', '2')).status === 200; } finally { await down(ctx); }
    check(18, 'a service that exits before it answers takes the stores and root down, and a later start brings the stores up again', /ended before it answered/.test(msg) && gone && again && left() === 0, [msg.slice(0, 120), `removed after the failure: ${gone}; started again with stores: ${again}`]);
  }

  // 19: SIGTERM and a normal exit with stores up
  if (!linux) skip(19, 'SIGTERM, or the process ending, while stores run removes the containers and the network', 'Linux only');
  else {
    const lines = [];
    let ok = true;
    for (const mode of ['term', 'exit']) {
      const r = await kvRun(`run-hold-${mode}`);
      const c = spawn(process.execPath, [path.join(here, 'hold.mjs'), r.file, mode], { env: process.env, stdio: ['pipe', 'pipe', 'pipe'] });
      let out = ''; c.stdout.on('data', (d) => (out += d)); c.stderr.on('data', (d) => (out += d));
      const ended = new Promise((res) => c.on('exit', (code, sig) => res(`${code ?? sig}`)));
      for (let i = 0; i < 300 && !out.includes('up'); i++) await sleep(100);
      const upSeen = out.includes('up') && left() === 2;
      if (mode === 'term') c.kill('SIGTERM'); else c.stdin.write('go\n');
      const how = await ended;
      for (let i = 0; i < 50 && left() > 0; i++) await sleep(100);
      const cleaned = left() === 0;
      lines.push(`${mode}: stores up while running: ${upSeen}; process ended (${how}); containers and network left: ${left()}`);
      ok = ok && upSeen && cleaned;
    }
    check(19, 'SIGTERM, or the process ending, while stores run removes the containers and the network', ok, lines);
  }

  // 20: sweep
  if (!linux) skip(20, 'a run killed hard leaves labelled containers; the next prepare removes them and leaves those of a live owner, a young one and another host alone', 'Linux only');
  else {
    const lines = [];
    const r = await kvRun('run-killed');
    const c = spawn(process.execPath, [path.join(here, 'hold.mjs'), r.file, 'term'], { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = ''; c.stdout.on('data', (d) => (out += d));
    for (let i = 0; i < 300 && !out.includes('up'); i++) await sleep(100);
    c.kill('SIGKILL'); await new Promise((res) => c.on('exit', res));
    const orphans = Object.keys(fakeState().containers);
    const net0 = Object.keys(fakeState().networks);
    lines.push(`killed hard: ${orphans.length} container and ${net0.length} network left behind`);
    const d = spawn(process.execPath, ['-e', '0']); await new Promise((res) => d.on('exit', res));
    const dead = d.pid;
    const old = Date.now() - 120000;
    const host = os.hostname();
    const lab = (owner, h) => ({ 'rr-backend': '1', 'rr-owner': String(owner), 'rr-host': h });
    setState((s) => {
      for (const o of orphans) s.containers[o].created = old; // the killed run's, now older than a minute
      for (const n of net0) s.networks[n].created = old;
      s.containers['rr-live-owner'] = { labels: lab(process.pid, host), created: old, network: null, port: 1 };
      s.containers['rr-young'] = { labels: lab(dead, host), created: Date.now(), network: null, port: 1 };
      s.containers['rr-other-host'] = { labels: lab(dead, 'another-host'), created: old, network: null, port: 1 };
      s.containers['rr-dead-old'] = { labels: lab(dead, host), created: old, network: null, port: 1 };
      s.networks['rr-live-net'] = { labels: lab(process.pid, host), created: old };
    });
    const next = await kvRun('run-next');
    prepare(next.run, next.file);
    const after = Object.keys(fakeState().containers).sort();
    const nets = Object.keys(fakeState().networks).sort();
    const swept = !orphans.some((o) => after.includes(o)) && !after.includes('rr-dead-old') && !net0.some((x) => nets.includes(x));
    const spared = ['rr-live-owner', 'rr-young', 'rr-other-host'].every((x) => after.includes(x)) && nets.includes('rr-live-net');
    lines.push(`after the next prepare: ${after.join(', ')}; networks ${nets.join(', ')}`);
    lines.push(`the killed run's and a dead owner's old ones removed: ${swept}; a live owner's, a young one's and another host's left: ${spared}`);
    setState((s) => { for (const k of ['rr-live-owner', 'rr-young', 'rr-other-host']) delete s.containers[k]; delete s.networks['rr-live-net']; });
    check(20, 'a run killed hard leaves labelled containers; the next prepare removes them and leaves those of a live owner, a young one and another host alone', swept && spared && left() === 0, lines);
  }

  // 21
  if (!linux) skip(21, 'the run of a store container holds an internal network, --pull=never, no -p, the labels and the memory and pids caps', 'Linux only');
  else {
    const sp2 = await freePort();
    const r = await kvRun('run-args', {}, { env: { SECRET: 'stand-in' } });
    r.run.stores.push({ name: 'cache', image: IMG, port: sp2, memory: '2g' });
    fs.writeFileSync(r.file, JSON.stringify(r.run));
    const mark = fakeLog().length;
    const ctx = prepare(r.run, r.file);
    await start(ctx); await down(ctx);
    const calls = fakeLog().slice(mark);
    const runs = calls.filter((a) => a[0] === 'run'), nc = calls.find((a) => a[0] === 'network' && a[1] === 'create');
    const netName = nc && nc[nc.length - 1];
    const val = (a, f) => a[a.indexOf(f) + 1];
    const has = (a, x) => a.includes(x);
    const labelsOk = runs.every((a) => ['rr-backend=1', `rr-owner=${process.pid}`, `rr-host=${os.hostname()}`].every((l) => a.some((x, i) => a[i - 1] === '--label' && x === l)));
    const argsOk = runs.length === 2 && runs.every((a) => val(a, '--network') === netName && has(a, '--pull=never') && !has(a, '-p') && !has(a, '--publish') && !has(a, '-P') && val(a, '--pids-limit') === '512' && val(a, '--security-opt') === 'no-new-privileges') && val(runs[0], '--memory') === '1g' && val(runs[1], '--memory') === '2g' && has(runs[0], 'SECRET=stand-in');
    const netOk = nc && has(nc, '--internal') && /^rr-\d+-[0-9a-f]{6}$/.test(netName);
    const order = calls.findIndex((a) => a[0] === 'network' && a[1] === 'rm') > calls.map((a) => a[0]).lastIndexOf('rm');
    {
      check(21, 'the run of a store container holds an internal network, --pull=never, no -p, the labels and the memory and pids caps and no-new-privileges', !!(labelsOk && argsOk && netOk && order && left() === 0), [`network ${netName}: internal ${!!(nc && has(nc, '--internal'))}`, `${runs.length} runs: labels ${labelsOk}, arguments ${argsOk}`, `containers removed before the network: ${order}`]);
    }
  }

  // 22
  if (!linux) skip(22, 'a store that dies after it was ready: the service call reports a closed connection', 'Linux only');
  else {
    const r = await kvRun('run-store-dies');
    const ctx = prepare(r.run, r.file);
    let g;
    try {
      await start(ctx);
      await put(ctx, 'a', '1');
      for (const c of Object.values(fakeState().containers)) { try { process.kill(c.pid, 'SIGKILL'); } catch {} }
      await sleep(300);
      g = await get(ctx, 'a');
    } finally { await down(ctx); }
    check(22, 'a store that dies after it was ready: the service call reports a closed connection', g.status === 502 && /store: /.test(JSON.stringify(g.body)), [`${g.status} ${JSON.stringify(g.body)}`]);
  }

  // 23
  if (!linux) skip(23, 'stop twice, stop with no stores up, stop on a bare context and cleanupSync after stop change nothing', 'Linux only');
  else {
    const lines = [];
    let ok = true;
    const bare = await refusal(() => api.stop({ proc: null, worker: null, root: null }, { removeRoot: true }));
    lines.push(`stop on a context without store fields: ${bare === '' ? 'fine' : bare}`); ok = ok && bare === '';
    const r = await kvRun('run-idempotent');
    const ctx = prepare(r.run, r.file);
    let mark = fakeLog().length;
    await down(ctx); await down(ctx);
    const none = !callsSince(mark).some((c) => ['rm', 'network rm'].includes(c));
    lines.push(`stop twice with no stores up made no runtime call: ${none}`); ok = ok && none;
    await start(ctx);
    await down(ctx);
    mark = fakeLog().length;
    await down(ctx); cleanupSync(ctx); await storesApi.stopStores(ctx);
    const again = fakeLog().length === mark && left() === 0;
    lines.push(`stop, cleanupSync and stopStores after a stop made no runtime call: ${again}`); ok = ok && again;
    check(23, 'stop twice, stop with no stores up, stop on a bare context and cleanupSync after stop change nothing', ok, lines);
  }

  // 24: the relay
  {
    const lines = [];
    const p1 = await freePort(), p2 = await freePort();
    const rel = spawn(process.execPath, [path.join(adapter, 'relay.mjs'), `127.0.0.1:${p1}`, `127.0.0.1:${p2}`], { stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: process.env.PATH, RELAY_READY: path.join(base, 'relay.ready') } });
    let relOut = ''; rel.stdout.on('data', (d) => (relOut += d));
    for (let i = 0; i < 50 && !fs.existsSync(path.join(base, 'relay.ready')); i++) await sleep(100);
    const probe = () => new Promise((resolve) => {
      const c = net.connect(p1, '127.0.0.1'); let got = '';
      const t = setTimeout(() => { c.destroy(); resolve({ closed: false, got }); }, 3000);
      c.on('data', (d) => (got += d)); c.on('error', () => {}); c.on('close', () => { clearTimeout(t); resolve({ closed: true, got }); });
      c.on('connect', () => c.write('hello\n'));
    });
    const before = await probe();
    const aliveAfter = rel.exitCode === null;
    lines.push(`a connection before the store listens: closed ${before.closed}, relay still running ${aliveAfter}`);
    const echo = net.createServer((s) => { s.on('error', () => {}); s.on('data', (d) => s.write('echo:' + d)); });
    await new Promise((res) => echo.listen(p2, '127.0.0.1', res));
    const after = await probe();
    echo.close(); rel.kill('SIGKILL');
    const piped = after.got.startsWith('echo:hello');
    lines.push(`once the store listens the same relay carries the connection: ${piped}; the relay wrote nothing to stdout: ${relOut === ''}`);
    check(24, 'a connection made before the store is ready closes cleanly, and the relay carries data once it is', before.closed && aliveAfter && piped && relOut === '', lines);
  }

  // 25
  if (!linux || !nsAvail) skip(25, 'a unix socket path over 100 bytes is refused with a plain reason before any container starts', 'needs the Linux namespace mode');
  else {
    const longDir = path.join(base, 'a'.repeat(40), 'b'.repeat(40));
    fs.mkdirSync(longDir, { recursive: true });
    const r = await kvRun('run-longpath');
    const ctx = prepare(r.run, r.file);
    const mark = fakeLog().length;
    const msg = await withEnv({ RR_TMP_PARENT: longDir }, () => refusal(() => start(ctx)));
    const ok = /socket path/.test(msg) && /limit is 100/.test(msg) && !fakeLog().slice(mark).some((a) => a[0] === 'run' || (a[0] === 'network' && a[1] === 'create')) && ctx.root === null;
    check(25, 'a unix socket path over 100 bytes is refused with a plain reason before any container starts', ok, [msg.slice(0, 120)]);
  }

  // 26: two parity tests that each start the service
  if (!linux) skip(26, 'two parity tests that each start the service leave no container behind', 'Linux only');
  else {
    const r = await kvRun('run-parity');
    const tests = path.join(r.dir, 'tests');
    fs.mkdirSync(tests);
    const body = (kill) => `import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport fs from 'node:fs';\nconst { prepare, call } = await import('file://' + process.env.API_MODULE);\nconst ctx = prepare(JSON.parse(fs.readFileSync(process.env.APP_RUN, 'utf8')), process.env.APP_RUN);\ntest('store', async () => {\n  const r = await call(ctx, { method: 'PUT', path: '/kv', body: { key: 'a', value: '1' } });\n  assert.equal(r.status, 200);\n${kill ? "  process.kill(process.pid, 'SIGKILL');\n" : ''}});\n`;
    fs.writeFileSync(path.join(tests, 'F-001.test.mjs'), body(false));
    fs.writeFileSync(path.join(tests, 'F-002.test.mjs'), body(true));
    const mark = fakeLog().length;
    const pr = await runNode('parity.mjs', ['--app', r.file, '--tests', tests, '--out', path.join(r.dir, 'results.json')], { RR_CONTAINER: fakeBin, RR_FAKE_DIR: fakeDir });
    const res = readJson(path.join(r.dir, 'results.json')) || [];
    const started = fakeLog().slice(mark).filter((a) => a[0] === 'run').length;
    const first = res.find((x) => x.feature === 'F-001');
    check(26, 'two parity tests that each start the service leave no container behind', pr.code === 0 && first && first.passed && started === 2 && left() === 0, [`parity exited ${pr.code}: ${pr.text.trim().split('\n').slice(-4).join(' | ')}`, `containers started: ${started}; left after the suite: ${left()}`]);
  }

  // 27: a real runtime, by hand
  {
    const image = process.env.RR_REAL_IMAGE, port = Number(process.env.RR_REAL_PORT);
    if (process.env.RR_REAL_RUNTIME !== '1' || !image || !port) skip(27, 'a real container runtime starts a store and removes it again', 'set RR_REAL_RUNTIME=1, RR_REAL_IMAGE (by digest) and RR_REAL_PORT; not part of CI');
    else await withEnv({ RR_CONTAINER: process.env.RR_REAL_CONTAINER || undefined, RR_FAKE_DIR: undefined }, async () => {
      const r = await makeRun('run-real', { stores: [{ name: 'real', image, port }] });
      const msg = await refusal(async () => { const ctx = prepare(r.run, r.file); try { await start(ctx); const s = await new Promise((res) => { const c = net.connect(port, '127.0.0.1'); c.on('connect', () => { c.destroy(); res(true); }); c.on('error', () => res(false)); }); if (!s) throw new Error('the store port did not answer through the relay'); } finally { await down(ctx); } });
      check(27, 'a real container runtime starts a store and removes it again', msg === '', [msg || 'store up, reachable on 127.0.0.1, removed']);
    });
  }

  // 28: nothing left
  {
    const log = fakeLog();
    const ran = log.filter((a) => a[0] === 'run').map((a) => a[a.indexOf('--name') + 1]);
    const removed = new Set(log.filter((a) => a[0] === 'rm').map((a) => a[a.length - 1]));
    const nets = log.filter((a) => a[0] === 'network' && a[1] === 'create').map((a) => a[a.length - 1]);
    const netsRemoved = new Set(log.filter((a) => a[0] === 'network' && a[1] === 'rm').map((a) => a[a.length - 1]));
    const unmatched = ran.filter((x) => !removed.has(x)), unmatchedNets = nets.filter((x) => !netsRemoved.has(x));
    check(28, 'after the suite no store container or network is left, and every run in the fake runtime log has a matching rm', !unmatched.length && !unmatchedNets.length && left() === 0, [`${ran.length} runs, ${nets.length} networks created; unmatched: ${unmatched.length + unmatchedNets.length}; left in the fake: ${left()}`]);
  }

  // 29: stopStores waits for the relays' exit, but not forever
  {
    const { EventEmitter } = await import('node:events');
    const fakeRelay = (exitAfter) => {
      const child = new EventEmitter(); child.exitCode = null; child.signalCode = null;
      child.kill = () => { if (exitAfter !== null) setTimeout(() => { child.exitCode = null; child.signalCode = 'SIGKILL'; child.emit('exit', null, 'SIGKILL'); }, exitAfter); };
      return { child, name: 'fake', stopping: false };
    };
    const stopWith = async (exitAfter) => {
      const ctx = { stores: { relays: [fakeRelay(exitAfter)], cnames: [], net: null, addrs: [], up: true, rt: 'none' } };
      const t0 = Date.now(); await storesApi.stopStores(ctx); return { ms: Date.now() - t0, relays: ctx.stores.relays.length };
    };
    const delayed = await stopWith(700);
    const never = await stopWith(null);
    const waited = delayed.ms >= 650 && delayed.ms < storesApi.EXIT_WAIT_MS;
    const capped = never.ms >= storesApi.EXIT_WAIT_MS - 100 && never.ms < storesApi.EXIT_WAIT_MS + 3000;
    check(29, 'stopping the stores waits for a relay that exits late, and gives up after the timeout on one that never exits', waited && capped && delayed.relays === 0 && never.relays === 0, [`relay exiting after 700 ms: stop took ${delayed.ms} ms; relay that never exits: stop took ${never.ms} ms (limit ${storesApi.EXIT_WAIT_MS} ms)`]);
  }
} finally {
  await api.stop({ proc: null, worker: null, root: null }).catch(() => {});
  server.close();
  fs.rmSync(base, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length} of ${results.length} checks passed${failed.length ? '; failed: ' + failed.map((r) => r.n).join(', ') : ''}`);
process.exit(failed.length ? 1 : 0);

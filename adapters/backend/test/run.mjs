// Nine checks for the backend adapter, run against the fixture service in ./fixture. node test/run.mjs
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
    const filesOk = kept.body && kept.body.rows === 2 && emptied.body && emptied.body.rows === 0 && emptied.body.seed === 5 && dbGone && filesClean;
    lines.push(`work-copy files: rows kept by a plain restart ${kept.body && kept.body.rows}, after a fresh restart ${emptied.body && emptied.body.rows}; tracked file back to its commit: ${filesClean}`);
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
} finally {
  await api.stop({ proc: null, worker: null, root: null }).catch(() => {});
  server.close();
  fs.rmSync(base, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length} of ${results.length} checks passed${failed.length ? '; failed: ' + failed.map((r) => r.n).join(', ') : ''}`);
process.exit(failed.length ? 1 : 0);

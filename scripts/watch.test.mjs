import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { PHASES } from './watch.mjs';

const WATCH = new URL('./watch.mjs', import.meta.url).pathname;
const EVENTS = new URL('./events.mjs', import.meta.url).pathname;
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

// A hand-made run folder: Capture and Inventory done, a log still running, an events file, one screenshot.
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'watch-'));
  const run = path.join(root, 'app-rebuild-review', '20260101-000000');
  for (const d of ['long', 'golden/screens', 'work', 'room', 'project', 'rebuild', 'score']) fs.mkdirSync(path.join(run, d), { recursive: true });
  fs.writeFileSync(path.join(run, 'Capture.done'), 'done');
  fs.writeFileSync(path.join(run, 'Inventory.done'), 'done');
  fs.writeFileSync(path.join(run, 'run.json'), JSON.stringify({ platform: 'web', env: { SECRET_TOKEN: 'sekrit-value-9' }, base: { url: 'https://example.com/x.git', ref: 'main' } }));
  fs.writeFileSync(path.join(run, 'cost.json'), JSON.stringify({ phases: { Capture: { usd: 1.25, runs: 1 }, Inventory: { usd: 2, runs: 2 } }, totalUsd: 3.25 }));
  fs.writeFileSync(path.join(run, 'size.json'), JSON.stringify({ size: { lines: 10 }, plan: { estimateUsd: { low: 5, high: 20 } }, maxUsd: 40 }));
  fs.writeFileSync(path.join(run, 'features.md'), '## Features\n- F-001 keep. Given a list, when x, then y.\n- F-002 keep. a\n- F-003 defect. b\n');
  fs.writeFileSync(path.join(run, 'long', 'stack-1.log'), `starting in ${run}\nhome ${os.homedir()}/x\nenv sekrit-value-9\nline 3\n`);
  fs.writeFileSync(path.join(run, 'long', 'stack-1.pid'), '1');
  fs.writeFileSync(path.join(run, 'long', 'cap.log'), 'done\n');
  fs.writeFileSync(path.join(run, 'long', 'cap.exit'), '0');
  fs.writeFileSync(path.join(run, 'golden', 'screens', 'home.png'), PNG);
  fs.writeFileSync(path.join(run, 'work', 'x'), 'source');
  fs.writeFileSync(path.join(run, 'project', 'a.js'), 'source');
  fs.writeFileSync(path.join(run, 'score', '.labels.json'), '{}');
  fs.writeFileSync(path.join(run, 'notes.js'), 'x');
  fs.writeFileSync(path.join(run, 'events.jsonl'), JSON.stringify({ t: '2026-01-01T00:00:01.000Z', kind: 'decision', what: 'estimate', choice: 'go', reason: 'ok' }) + '\n');
  return { root, run };
}

function serve(run, args = [], env = {}) {
  const child = spawn('node', [WATCH, run, '--port', '0', ...args], { env: { ...process.env, ...env } });
  let out = '';
  const ready = new Promise((resolve, reject) => {
    child.stdout.on('data', (d) => { out += d; const m = out.match(/^http:\/\/127\.0\.0\.1:(\d+)\/\?k=([0-9a-f]{32})\n/); if (m) resolve({ port: Number(m[1]), k: m[2], link: m[0].trim() }); });
    child.on('exit', (c) => reject(new Error(`exited ${c} before it printed a link: ${out}`)));
    setTimeout(() => reject(new Error('no link in 5 s')), 5000).unref();
  });
  return { child, ready };
}

const get = (port, p, headers = {}) => new Promise((resolve, reject) => {
  http.get({ host: '127.0.0.1', port, path: p, headers }, (res) => {
    const chunks = [];
    res.on('data', (c) => chunks.push(c));
    res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
  }).on('error', reject);
});

async function withServer(fn, opts = {}) {
  const { root, run } = fixture();
  const s = serve(run, opts.args, opts.env);
  try { return await fn({ ...(await s.ready), run, child: s.child }); }
  finally { s.child.kill(); fs.rmSync(root, { recursive: true, force: true }); }
}

test('the phase list equals PHASES in the workflow', () => {
  const src = fs.readFileSync(new URL('../workflows/rebuild-review.js', import.meta.url), 'utf8');
  const m = src.match(/^const PHASES = \[([^\]]*)\]/m);
  assert.ok(m, 'PHASES not found in the workflow');
  assert.deepEqual([...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]), PHASES);
});

test('a missing or wrong token gets 403 on every route', () => withServer(async ({ port, k }) => {
  for (const p of ['/', '/state', '/events', '/file?p=golden/screens/home.png']) {
    assert.equal((await get(port, p)).status, 403, p);
    assert.equal((await get(port, `${p}${p.includes('?') ? '&' : '?'}k=${'0'.repeat(32)}`)).status, 403, p);
  }
  assert.equal((await get(port, `/state?k=${k}`)).status, 200);
}));

test('/file refuses ../, work/x, an absolute path, .js, and the files that can hold a secret', () => withServer(async ({ port, k, run }) => {
  const f = (p) => get(port, `/file?k=${k}&p=${encodeURIComponent(p)}`);
  for (const p of ['../app-rebuild-review/20260101-000000/cost.json', '../../x.txt', 'work/x', 'project/a.js', 'notes.js', run + '/cost.json', '/etc/passwd',
    'run.json', 'score/.labels.json', 'long/stack-1.pid', 'events.jsonl', 'golden/../run.json', 'rebuild/x.json', 'room/y.txt']) {
    assert.equal((await f(p)).status, 403, p);
  }
  assert.equal((await f('nope.txt')).status, 404);
  assert.equal((await f('cost.json')).status, 200);
  const img = await f('golden/screens/home.png');
  assert.equal(img.status, 200);
  assert.equal(img.headers['content-type'], 'image/png');
  assert.ok(img.body.equals(PNG));
}));

test('/file refuses a link that leads out of the run folder', () => withServer(async ({ port, k, run }) => {
  fs.writeFileSync(path.join(os.tmpdir(), 'watch-outside.txt'), 'outside');
  fs.symlinkSync(path.join(os.tmpdir(), 'watch-outside.txt'), path.join(run, 'link.txt'));
  assert.equal((await get(port, `/file?k=${k}&p=link.txt`)).status, 403);
  fs.rmSync(path.join(os.tmpdir(), 'watch-outside.txt'));
}));

test('a log is served with the run, target and home paths hidden and env values masked', () => withServer(async ({ port, k, run }) => {
  const r = await get(port, `/file?k=${k}&p=long/stack-1.log`);
  const text = r.body.toString();
  assert.equal(r.status, 200);
  assert.ok(text.includes('starting in <run>'), text);
  assert.ok(text.includes('home ~/x'), text);
  assert.ok(!text.includes(run) && !text.includes(os.homedir()) && !text.includes('sekrit-value-9'), text);
  assert.ok(text.includes('env ***'));
}));

test('a log is cut to its last 64 KB', () => withServer(async ({ port, k, run }) => {
  fs.writeFileSync(path.join(run, 'long', 'big.log'), 'a'.repeat(200000) + 'END');
  const r = await get(port, `/file?k=${k}&p=long/big.log`);
  assert.equal(r.body.length, 65536);
  assert.ok(r.body.toString().endsWith('END'));
}));

test('/state lists the phases, costs, features and screens, and never the env', () => withServer(async ({ port, k, run }) => {
  const r = await get(port, `/state?k=${k}`);
  const text = r.body.toString();
  const s = JSON.parse(text);
  assert.deepEqual(s.phases.map((p) => p.name), PHASES);
  assert.deepEqual(s.phases.map((p) => p.state), ['done', 'done', 'running', 'not started', 'not started', 'not started', 'not started']);
  assert.equal(s.totalUsd, 3.25);
  assert.equal(s.maxUsd, 40);
  assert.deepEqual(s.features, { keep: 2, defect: 1 });
  assert.equal(s.platform, 'web');
  assert.deepEqual(s.shots, ['golden/screens/home.png']);
  assert.deepEqual(s.long.map((l) => [l.name, l.state]), [['cap', 'exited'], ['stack-1', 'running']]);
  assert.ok(!text.includes('sekrit-value-9') && !text.includes('example.com') && !text.includes(run));
}));

test('a stopped report marks the phase failed, a non-zero exit too', () => withServer(async ({ port, k, run }) => {
  fs.mkdirSync(path.join(run, 'report'));
  fs.writeFileSync(path.join(run, 'report', 'stopped.txt'), `Stack: the room refused ${run}\n`);
  const s = JSON.parse((await get(port, `/state?k=${k}`)).body);
  assert.equal(s.phases[2].state, 'failed');
  assert.ok(s.stopped.includes('<run>') && !s.stopped.includes(run));
  fs.rmSync(path.join(run, 'report'), { recursive: true });
  fs.rmSync(path.join(run, 'long', 'stack-1.pid'));
  fs.writeFileSync(path.join(run, 'long', 'stack-1.exit'), '1');
  const s2 = JSON.parse((await get(port, `/state?k=${k}`)).body);
  assert.equal(s2.phases[2].state, 'failed');
}));

test('the page has a strict CSP with a nonce and no external resources', () => withServer(async ({ port, k }) => {
  const r = await get(port, `/?k=${k}`);
  const csp = r.headers['content-security-policy'];
  const nonce = csp.match(/script-src 'nonce-([^']+)'/)[1];
  assert.ok(csp.startsWith("default-src 'none'; script-src 'nonce-") && csp.includes("connect-src 'self'") && csp.includes("img-src 'self'"));
  const html = r.body.toString();
  assert.ok(html.includes(`<script nonce="${nonce}">`) && html.includes(`<style nonce="${nonce}">`));
  assert.ok(!/(src|href)="https?:/.test(html));
  assert.ok(!html.includes('innerHTML'));
}));

test('the server listens on 127.0.0.1 only, and there is no host flag', async () => {
  await withServer(async ({ port }) => {
    const other = Object.values(os.networkInterfaces()).flat().find((a) => a && a.family === 'IPv4' && !a.internal);
    if (other) {
      const refused = await new Promise((resolve) => {
        const s = net.connect({ host: other.address, port, timeout: 1500 });
        s.on('connect', () => { s.destroy(); resolve(false); });
        s.on('error', () => resolve(true));
        s.on('timeout', () => { s.destroy(); resolve(true); });
      });
      assert.ok(refused, `${other.address}:${port} accepted a connection`);
    }
  });
  const { root, run } = fixture();
  assert.equal(spawnSync('node', [WATCH, run, '--host', '0.0.0.0']).status, 2);
  fs.rmSync(root, { recursive: true, force: true });
});

test('SSE delivers a line appended with the CLI within 2 s, and the existing ones first', () => withServer(({ port, k, run }) => new Promise((resolve, reject) => {
  const seen = [];
  const req = http.get({ host: '127.0.0.1', port, path: `/events?k=${k}` }, (res) => {
    assert.equal(res.headers['content-type'], 'text/event-stream');
    let buf = '', appended = 0;
    res.on('data', (c) => {
      buf += c;
      for (const block of buf.split('\n\n').slice(0, -1)) {
        const m = block.match(/^event: (\w+)/m);
        if (m && m[1] === 'ev') seen.push(JSON.parse(block.match(/^data: (.*)$/m)[1]));
        if (m && m[1] === 'state' && !appended) {
          appended = Date.now();
          spawnSync('node', [EVENTS, run, 'made', JSON.stringify({ what: 'tests', path: 'parity/tests', count: 4 })]);
        }
      }
      buf = buf.slice(buf.lastIndexOf('\n\n') + 2);
      if (seen.some((e) => e.what === 'tests')) {
        try {
          assert.ok(Date.now() - appended < 2000);
          assert.equal(seen[0].what, 'estimate');
          req.destroy(); resolve();
        } catch (e) { reject(e); }
      }
    });
  });
  setTimeout(() => { req.destroy(); reject(new Error('no event in 5 s')); }, 5000).unref();
})));

test('a second server for the same run folder is refused, and the server ends itself after the run finished', async () => {
  const { root, run } = fixture();
  const a = serve(run, [], { WATCH_LINGER_MS: '600' });
  try {
    await a.ready;
    const second = spawnSync('node', [WATCH, run]);
    assert.equal(second.status, 1);
    assert.ok(String(second.stderr).includes('already runs'));
    fs.writeFileSync(path.join(run, 'Report.done'), 'done');
    const code = await new Promise((resolve, reject) => { a.child.on('exit', resolve); setTimeout(() => reject(new Error('still running 6 s after Report.done')), 6000).unref(); });
    assert.equal(code, 0);
    assert.ok(!fs.existsSync(path.join(run, 'watch.pid')));
  } finally { a.child.kill(); fs.rmSync(root, { recursive: true, force: true }); }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { filterGolden, prepareRoom, scanTranscript, wallTried, cloneProject, denyList, writeSettings } from './room.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'room-test-'));

function makeGolden(dir) {
  fs.mkdirSync(path.join(dir, 'screens', 'home'), { recursive: true });
  const entry = (url, mimeType, text) => ({ request: { url }, response: { content: { mimeType, text } } });
  fs.writeFileSync(path.join(dir, 'network.har'), JSON.stringify({ log: { entries: [
    entry('http://127.0.0.1:1/app.js', 'application/javascript', 'const secret = 1'),
    entry('http://127.0.0.1:1/app.css', 'text/css', 'body{color:red}'),
    entry('http://127.0.0.1:1/app.js.map', 'application/json', '{"sourcesContent":["x"]}'),
    entry('http://127.0.0.1:1/api/tasks', 'application/json', '[{"id":1}]'),
    entry('http://127.0.0.1:1/logo.png', 'image/png', 'iVBORw0KGgo='),
  ] } }));
  fs.writeFileSync(path.join(dir, 'screens', 'home', 'render.html'),
    '<html><script>var a = 1;</script><script src="x.js"></script><p>hi</p>\n//# sourceMappingURL=a.map\n</html>');
  fs.writeFileSync(path.join(dir, 'run.json'), '{}');
  fs.writeFileSync(path.join(dir, 'probes.json'), '[]');
}

test('filterGolden removes JS, CSS and map bodies and keeps JSON and images', () => {
  const src = tmp(), dest = path.join(tmp(), 'g');
  makeGolden(src);
  filterGolden(src, dest);
  const entries = JSON.parse(fs.readFileSync(path.join(dest, 'network.har'), 'utf8')).log.entries;
  const by = Object.fromEntries(entries.map((e) => [e.request.url.split('/').pop(), e.response.content.text]));
  assert.equal(by['app.js'], '');
  assert.equal(by['app.css'], '');
  assert.equal('app.js.map' in by, false);
  assert.equal(by['tasks'], '[{"id":1}]');
  assert.equal(by['logo.png'], 'iVBORw0KGgo=');
  assert.equal(fs.existsSync(path.join(dest, 'run.json')), false);
  assert.equal(fs.existsSync(path.join(dest, 'probes.json')), true);
});

test('filterGolden empties inline scripts and source map comments', () => {
  const src = tmp(), dest = path.join(tmp(), 'g');
  makeGolden(src);
  filterGolden(src, dest);
  const t = fs.readFileSync(path.join(dest, 'screens', 'home', 'render.html'), 'utf8');
  assert.ok(!t.includes('var a'));
  assert.ok(!t.includes('sourceMappingURL'));
  assert.ok(t.includes('<p>hi</p>'));
});

function makeRun(features) {
  const base = fs.realpathSync(tmp());
  const target = path.join(base, 'mytarget'), runDir = path.join(base, 'run-1');
  fs.mkdirSync(target); fs.mkdirSync(path.join(runDir, 'work'), { recursive: true });
  const git = (...a) => execFileSync('git', a, { cwd: path.join(runDir, 'work') });
  git('init', '-q');
  fs.writeFileSync(path.join(runDir, 'work', 'a.txt'), 'the quick brown fox jumps over the lazy dog again and again and again\n');
  git('add', '.'); git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'x');
  fs.writeFileSync(path.join(runDir, 'features.md'), features);
  fs.writeFileSync(path.join(runDir, 'technology.md'), 'Plain text list of tools.\n');
  fs.mkdirSync(path.join(runDir, 'golden'));
  makeGolden(path.join(runDir, 'golden'));
  return { target, runDir };
}

test('prepareRoom builds a room with filtered golden', () => {
  const { target, runDir } = makeRun('F-001 A user sees a list.\n');
  const room = prepareRoom({ runDir, target, inputs: ['features.md', 'technology.md', 'golden'] });
  assert.ok(fs.existsSync(path.join(room, 'input', 'features.md')));
  assert.equal(fs.existsSync(path.join(room, 'input', 'golden', 'run.json')), false);
  fs.rmSync(room, { recursive: true, force: true });
});

test('prepareRoom throws when an input contains the target path', () => {
  const { target, runDir } = makeRun('F-001 A user sees a list.\n');
  fs.appendFileSync(path.join(runDir, 'technology.md'), `Built in ${target}\n`);
  assert.throws(() => prepareRoom({ runDir, target, inputs: ['features.md', 'technology.md'] }), /contains/);
});

test('prepareRoom allows a target folder named tasks with /tasks/1 in the HAR', () => {
  const base = fs.realpathSync(tmp());
  const target = path.join(base, 'tasks'), runDir = path.join(base, 'run-1');
  fs.mkdirSync(target);
  const { runDir: made } = makeRun('F-001 A user sees a list.\n');
  fs.cpSync(made, runDir, { recursive: true });
  fs.appendFileSync(path.join(runDir, 'golden', 'network.har'), '');
  const har = path.join(runDir, 'golden', 'network.har');
  const j = JSON.parse(fs.readFileSync(har, 'utf8'));
  j.log.entries.push({ request: { url: 'http://127.0.0.1:1/tasks/1' }, response: { content: { mimeType: 'application/json', text: '{}' } } });
  fs.writeFileSync(har, JSON.stringify(j));
  const room = prepareRoom({ runDir, target, inputs: ['features.md', 'technology.md', 'golden'] });
  assert.ok(fs.existsSync(path.join(room, 'input', 'golden', 'network.har')));
  fs.rmSync(room, { recursive: true, force: true });
});

test('prepareRoom throws when features.md fails the source check', () => {
  const { target, runDir } = makeRun('F-001 see src/App.jsx for details\n');
  assert.throws(() => prepareRoom({ runDir, target, inputs: ['features.md', 'technology.md'] }), /no-source check/);
});

test('scanTranscript finds a path', () => {
  const f = path.join(tmp(), 't.jsonl');
  fs.writeFileSync(f, '{"a":"fine"}\n{"tool":"cat /secret/place/x"}\n');
  const hits = scanTranscript(f, ['/secret/place']);
  assert.equal(hits.length, 1);
  assert.equal(scanTranscript(f, ['/other']).length, 0);
});

function transcript(lines) {
  const f = path.join(tmp(), 'w.jsonl');
  fs.writeFileSync(f, lines.map((c) => JSON.stringify({ type: 'assistant', message: { content: [c] } })).join('\n'));
  return f;
}
const bashCat = (file) => ({ type: 'tool_use', id: 'a', name: 'Bash', input: { command: `cat ${file}` } });
const readTool = (file) => ({ type: 'tool_use', id: 'b', name: 'Read', input: { file_path: file } });

test('wallTried needs a Bash cat and a Read on the canary', () => {
  assert.equal(wallTried(transcript([bashCat('/x/.canary'), readTool('/x/.canary')]), '/x/.canary'), true);
  assert.equal(wallTried(transcript([]), '/x/.canary'), false);
  assert.equal(wallTried(transcript([bashCat('/x/.canary')]), '/x/.canary'), false);
  assert.equal(wallTried(transcript([readTool('/x/.canary')]), '/x/.canary'), false);
  assert.equal(wallTried(transcript([bashCat('/x/.canary'), readTool('/y/other')]), '/x/.canary'), false);
});

function repo(files, commit = true) {
  const d = path.join(fs.realpathSync(tmp()), 'p');
  fs.mkdirSync(d);
  const git = (...a) => execFileSync('git', a, { cwd: d });
  git('init', '-q');
  for (const [f, t] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(d, f)), { recursive: true }); fs.writeFileSync(path.join(d, f), t); }
  if (commit) { git('add', '.'); git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'x'); }
  return d;
}

test('cloneProject keeps nested src/build and src/target', () => {
  const from = repo({ 'src/build/x.js': 'a', 'src/target/y.js': 'b' });
  const to = path.join(fs.realpathSync(tmp()), 'out');
  cloneProject(from, to);
  assert.equal(fs.readFileSync(path.join(to, 'src/build/x.js'), 'utf8'), 'a');
  assert.equal(fs.readFileSync(path.join(to, 'src/target/y.js'), 'utf8'), 'b');
});

test('cloneProject fails on a dirty tree and on no commit', () => {
  const dirty = repo({ 'a.js': 'a' });
  fs.writeFileSync(path.join(dirty, 'new.js'), 'n');
  assert.throws(() => cloneProject(dirty, path.join(tmp(), 'o')), /uncommitted/);
  const empty = repo({ 'a.js': 'a' }, false);
  assert.throws(() => cloneProject(empty, path.join(tmp(), 'o')), /commit/);
});

test('denyList covers sibling runs, the plugin root and a worktree target\'s git dir; settings deny Edit', () => {
  const base = fs.realpathSync(tmp());
  const main = repo({ 'a.js': 'a' });
  const wt = path.join(base, 'wt');
  execFileSync('git', ['worktree', 'add', '-q', wt, '-b', 'b'], { cwd: main });
  const runs = path.join(base, 'wt-rebuild-review'), runDir = path.join(runs, 'run-1');
  fs.mkdirSync(runDir, { recursive: true });
  const deny = denyList(runDir, wt);
  assert.ok(deny.includes(runs));
  assert.ok(deny.includes(path.join(main, '.git')));
  assert.ok(deny.includes(path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')));
  const room = path.join(base, 'room');
  writeSettings(room, { denyPaths: deny, noWrite: [wt, runDir] });
  const rules = JSON.parse(fs.readFileSync(path.join(base, 'room.settings', 'settings.json'), 'utf8')).permissions.deny;
  assert.ok(rules.includes(`Edit(/${wt})`) && rules.includes(`Edit(/${runDir}/**)`));
});

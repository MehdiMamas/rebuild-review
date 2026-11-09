import test from 'node:test';
import assert from 'node:assert/strict';
import { checkText, looksLikeCode, trackedTexts, trimCache, cacheDirSafe } from './check-features.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';

const src = [{ name: 'a.js', content: 'function computeTheTotalOfAllTheItemsInTheCart(items) { return 1 }' }];
const bad = (t, s = []) => assert.ok(checkText(t, s).length > 0, t);

test('fails on a fence', () => bad('F-1 does a thing\n```js\nx\n```'));
test('fails on a source path', () => bad('The logic lives in src/App.tsx for the list.'));
test('fails on a JSX line', () => bad('  <TaskRow task={t} onClick={go} />'));
test('fails on an import line', () => bad("import React from 'react'"));
test('fails on a verbatim 40 char run', () => bad('Total: computeTheTotalOfAllTheItemsInTheCart(items) is shown', src));
test('passes on plain prose', () => assert.deepEqual(checkText('F-001 Search filters tasks as you type.\nGiven the list, when the user types, then rows narrow.', src), []));
test('passes on a button or route in given/when/then', () => assert.deepEqual(checkText('Given the board, when the user clicks the "Save" button on the /legacy route, then it shows Saved.', src), []));
test('passes on product names ending in .js', () => {
  assert.deepEqual(checkText('- Server: Node.js built-in http module', []), []);
  assert.deepEqual(checkText('Built with Vue.js and Next.js', []), []);
});
test('still fails on real .js paths', () => {
  for (const t of ['see src/Node.js', 'server.js', 'node.js']) {
    assert.ok(checkText(t, []).some((p) => p.includes('source file path')), t);
  }
});
test('passes on a "Not built (from the docs)" section', () => assert.deepEqual(checkText('F-001 keep. Search filters tasks.\n\n## Not built (from the docs)\n- Export to PDF is described in the docs but the app has no such control.', src), []));

test('lists tracked files when git ls-files output is over 1 MB', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-big-'));
  try {
    execFileSync('git', ['init', '-q'], { cwd: dir });
    const long = 'x'.repeat(200);
    for (let i = 0; i < 6000; i++) fs.writeFileSync(path.join(dir, `${long}-${i}.txt`), 'a');
    execFileSync('git', ['add', '-A'], { cwd: dir });
    assert.equal(trackedTexts(dir).length, 6000);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const ok = (t, s) => assert.deepEqual(checkText(t, s), [], t);
const doc = (content, name = 'doc.md') => [{ name, content }];

test('looksLikeCode: prose with parentheses and a markdown link is not code', () => {
  assert.equal(looksLikeCode('See [the guide](docs/guide.html?a=b) (from the docs) too'), false);
  assert.equal(looksLikeCode('open_agents new_agent list_sessions sort_order'), false);
});
test('looksLikeCode: calls and assignments are code', () => {
  assert.equal(looksLikeCode('const total = items.reduce((a, b) => a + b'), true);
  assert.equal(looksLikeCode('set width = 100 for the box'), true);
  assert.equal(looksLikeCode('x.reduce(fn) and more words here'), true);
});
test('prose copied from a markdown doc passes', () => {
  const t = 'File has New Agent and Open Agents Window';
  ok(t, doc('Intro. ' + t + ' and more text.'));
});
test('prose with parentheses, brackets and a tag boundary passes', () => {
  const t = 'Plan orange, Agent gray, Ask green, Done blue (from the docs) [x]';
  ok(t, doc('<li>' + t + '</li> <b>next</b>', 'design/note.html'));
});
test('UI labels copied from html or jsx pass', () => {
  const t = 'search, New Agent, Customize, sessions, Settings';
  ok(t, doc('<ul><li>' + t + '</li></ul>', 'agents-list.html'));
  ok(t, doc('<Menu>' + t + '</Menu>', 'Menu.jsx'));
});
test('a copied code line fails with copied from', () => {
  const line = 'const total = items.reduce((a, b) => a + b';
  const p = checkText('The total is ' + line + ' here', doc(line + ', 0);', 'a.js'));
  assert.ok(p.some((x) => x.startsWith('copied from a.js')), p.join());
});
test('a later code match is reported after an earlier prose match', () => {
  const prose = 'Plan orange, Agent gray, Ask green, Done blue';
  const code = 'const total = items.reduce((a, b) => a + b';
  const p = checkText(prose + '. Then ' + code + '.', doc(prose + '. ' + 'zzzz '.repeat(20) + code + ', 0);', 'b.js'));
  assert.ok(p.some((x) => x.includes('copied from b.js') && x.includes('reduce')), p.join());
});
test('empty or short text has no copied-run problems', () => {
  assert.deepEqual(checkText('', src), []);
  assert.deepEqual(checkText('short text', src), []);
});

// ---- cache of the tracked texts (#94) ----
const git = (dir, ...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'gc.auto=0', '-c', 'core.fsmonitor=false', ...a], { cwd: dir, stdio: 'pipe' });
function repoOf(n) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-cache-'));
  git(dir, 'init', '-q');
  for (let d = 0; d < n / 500; d++) {
    fs.mkdirSync(path.join(dir, 'd' + d));
    for (let i = 0; i < 500 && d * 500 + i < n; i++) fs.writeFileSync(path.join(dir, 'd' + d, `f${i}.txt`), `file ${d} ${i}  text`);
  }
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'one');
  return dir;
}
const events = () => { const e = []; return { e, onCache: (x) => e.push(x) }; };

test('cache: 20,000 files, second call on the same HEAD is a hit with the same texts; a commit or a change misses', () => {
  const dir = repoOf(20000);
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-cachedir-'));
  try {
    const a = events(); const first = trackedTexts(dir, { cacheDir, onCache: a.onCache });
    const b = events(); const second = trackedTexts(dir, { cacheDir, onCache: b.onCache });
    assert.deepEqual(a.e, ['miss']);
    assert.deepEqual(b.e, ['hit']);
    assert.equal(first.length, 20000);
    assert.deepEqual(second, first);
    // an untracked file does not count as a change
    fs.writeFileSync(path.join(dir, 'build.out'), 'x');
    const c = events(); trackedTexts(dir, { cacheDir, onCache: c.onCache });
    assert.deepEqual(c.e, ['hit']);
    // a modified tracked file: no cache used, and none written
    fs.writeFileSync(path.join(dir, 'd0', 'f0.txt'), 'changed');
    const d = events(); const dirty = trackedTexts(dir, { cacheDir, onCache: d.onCache });
    assert.deepEqual(d.e, ['miss']);
    assert.ok(dirty.some((f) => f.content === 'changed'));
    const files = fs.readdirSync(cacheDir);
    assert.equal(files.length, 1);
    // a new commit is a new key
    git(dir, 'commit', '-qam', 'two');
    const e = events(); trackedTexts(dir, { cacheDir, onCache: e.onCache });
    assert.deepEqual(e.e, ['miss']);
    assert.equal(fs.readdirSync(cacheDir).length, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
    fs.rmSync(cacheDir, { recursive: true, force: true });
  }
});

test('cache: parallel writers of one key leave a valid JSON file', async () => {
  const dir = repoOf(50);
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-cachedir-'));
  try {
    const mod = new URL('./check-features.mjs', import.meta.url).href;
    const code = `import { trackedTexts } from ${JSON.stringify(mod)}; trackedTexts(${JSON.stringify(dir)}, { cacheDir: ${JSON.stringify(cacheDir)} });`;
    await Promise.all(Array.from({ length: 4 }, () => new Promise((res, rej) => {
      const c = spawn(process.execPath, ['--input-type=module', '-e', code], { stdio: 'pipe' });
      c.on('exit', (x) => (x === 0 ? res() : rej(new Error('exit ' + x))));
    })));
    const files = fs.readdirSync(cacheDir);
    assert.equal(files.length, 1, files.join());
    assert.equal(JSON.parse(fs.readFileSync(path.join(cacheDir, files[0]), 'utf8')).length, 50);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
    fs.rmSync(cacheDir, { recursive: true, force: true });
  }
});

test('cache: a folder over the cap loses its oldest files first', () => {
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-cachedir-'));
  try {
    for (const [i, n] of ['old', 'mid', 'new'].entries()) {
      const p = path.join(cacheDir, n + '.json');
      fs.writeFileSync(p, 'x'.repeat(100));
      fs.utimesSync(p, 1000 + i, 1000 + i);
    }
    trimCache(cacheDir, 250);
    assert.deepEqual(fs.readdirSync(cacheDir).sort(), ['mid.json', 'new.json']);
    trimCache(cacheDir, 0);
    assert.deepEqual(fs.readdirSync(cacheDir), []);
  } finally {
    fs.rmSync(cacheDir, { recursive: true, force: true });
  }
});

function smallRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-cache-'));
  git(dir, 'init', '-q');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'Line one\r\n  two  words \n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'one');
  return dir;
}

test('cache: folder 0700, file 0600 (POSIX); cached and uncached calls return identical raw texts', { skip: process.platform === 'win32' }, () => {
  const dir = smallRepo();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-cachedir-'));
  const cacheDir = path.join(root, 'texts');
  try {
    const first = trackedTexts(dir, { cacheDir });
    const second = trackedTexts(dir, { cacheDir });
    assert.deepEqual(second, first);
    assert.equal(first[0].content, 'Line one\r\n  two  words \n');
    assert.equal(fs.statSync(cacheDir).mode & 0o777, 0o700);
    const f = fs.readdirSync(cacheDir)[0];
    assert.equal(fs.statSync(path.join(cacheDir, f)).mode & 0o777, 0o600);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(root, { recursive: true, force: true });
  }
});

test('cache: a linked cache folder is never read or written; an open folder of ours is closed to 0700', { skip: process.platform === 'win32' }, () => {
  const dir = smallRepo();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-cachedir-'));
  try {
    const real = path.join(root, 'planted');
    fs.mkdirSync(real);
    const link = path.join(root, 'texts');
    fs.symlinkSync(real, link);
    const seen = [];
    trackedTexts(dir, { cacheDir: link, onCache: (x) => seen.push(x) });
    trackedTexts(dir, { cacheDir: link, onCache: (x) => seen.push(x) });
    assert.deepEqual(seen, ['miss', 'miss'], 'a linked folder must never give a hit');
    assert.deepEqual(fs.readdirSync(real), [], 'nothing may be written through the link');
    assert.equal(cacheDirSafe(link), false);
    const open = path.join(root, 'open');
    fs.mkdirSync(open, { mode: 0o777 }); fs.chmodSync(open, 0o777);
    assert.equal(cacheDirSafe(open), true);
    assert.equal(fs.statSync(open).mode & 0o777, 0o700);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(root, { recursive: true, force: true });
  }
});

test('cache: a corrupt cache file is removed and the result is still right', () => {
  const dir = smallRepo();
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-cachedir-'));
  try {
    const first = trackedTexts(dir, { cacheDir });
    const f = path.join(cacheDir, fs.readdirSync(cacheDir)[0]);
    fs.writeFileSync(f, '{"broken');
    const ev = events(); const again = trackedTexts(dir, { cacheDir, onCache: ev.onCache });
    assert.deepEqual(ev.e, ['miss']);
    assert.deepEqual(again, first);
    assert.deepEqual(JSON.parse(fs.readFileSync(f, 'utf8')), first);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(cacheDir, { recursive: true, force: true });
  }
});

test('trimCache removes .tmp files older than an hour, keeps young ones and never removes the file just written', () => {
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-cachedir-'));
  try {
    const put = (n, size, ageMs) => { const p = path.join(cacheDir, n); fs.writeFileSync(p, 'x'.repeat(size)); const t = new Date(Date.now() - ageMs); fs.utimesSync(p, t, t); return p; };
    put('old.1.tmp', 10, 2 * 3600 * 1000);
    put('young.2.tmp', 10, 60 * 1000);
    const keep = put('written.json', 500, 10 * 1000);
    put('other.json', 500, 5000 * 1000);
    trimCache(cacheDir, 600, keep);
    assert.deepEqual(fs.readdirSync(cacheDir).sort(), ['written.json', 'young.2.tmp']);
  } finally {
    fs.rmSync(cacheDir, { recursive: true, force: true });
  }
});

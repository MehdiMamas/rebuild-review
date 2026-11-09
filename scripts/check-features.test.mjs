import test from 'node:test';
import assert from 'node:assert/strict';
import { checkText, looksLikeCode, trackedTexts } from './check-features.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

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

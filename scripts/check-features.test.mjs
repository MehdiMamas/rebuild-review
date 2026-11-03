import test from 'node:test';
import assert from 'node:assert/strict';
import { checkText, trackedTexts } from './check-features.mjs';
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

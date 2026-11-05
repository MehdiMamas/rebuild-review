// Unit tests for the browser launch helpers: no browser is started.
import test from 'node:test';
import assert from 'node:assert/strict';
import { headlessShellPath, launchError, launchChromium } from '../browser.mjs';

test('headlessShellPath picks the headless shell next to the full browser', () => {
  const full = '/c/ms-playwright/chromium-1248/chrome-linux64/chrome';
  assert.equal(headlessShellPath(full, () => true), '/c/ms-playwright/chromium_headless_shell-1248/chrome-headless-shell-linux64/chrome-headless-shell');
  assert.equal(headlessShellPath(full, () => false), full);
  assert.equal(headlessShellPath('/usr/bin/chromium', () => true), '/usr/bin/chromium');
});

test('launchError keeps the browser error lines and the exit code', () => {
  const msg = [
    'browserType.launch: Target page, context or browser has been closed', 'Browser logs:', '',
    '<launching> /x/chrome-headless-shell --headless', '<launched> pid=7',
    '[pid=7][err] /x/chrome-headless-shell: error while loading shared libraries: libnspr4.so: cannot open shared object file: No such file or directory',
    'Call log:', '  - <launching> /x/chrome-headless-shell --headless',
    '  - [pid=7][err] /x/chrome-headless-shell: error while loading shared libraries: libnspr4.so: cannot open shared object file: No such file or directory',
    '  - [pid=7] <process did exit: exitCode=127, signal=null>',
  ].join('\n');
  const line = launchError(new Error(msg));
  assert.ok(!line.includes('\n'), 'one line');
  assert.match(line, /^browserType\.launch: Target page/);
  assert.equal(line.match(/libnspr4\.so/g).length, 1, `the error line appears once: ${line}`);
  assert.match(line, /exitCode=127/);
});

test('launchChromium is headless, passes LD_LIBRARY_PATH through and rewrites a failure', async () => {
  let got;
  const fake = { executablePath: () => '/nowhere/chrome', launch: async (o) => { got = o; return 'browser'; } };
  if (process.platform !== 'linux') {
    assert.equal(await launchChromium(fake, { args: ['--a'], headless: false }), 'browser');
    assert.equal(got.headless, true);
    return;
  }
  // On Linux ldd of a missing file prints nothing missing, so no download happens.
  assert.equal(await launchChromium(fake, { args: ['--a'], headless: false }), 'browser');
  assert.equal(got.headless, true);
  assert.deepEqual(got.args, ['--a']);
  const bad = { executablePath: () => '/nowhere/chrome', launch: async () => { throw new Error('first\n[pid=1][err] boom'); } };
  await assert.rejects(launchChromium(bad), /first \| boom/);
});

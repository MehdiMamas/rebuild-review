// Web parity adapter. node parity.mjs --app <run.json> --tests <dir> --out <results.json>
// Starts the app, runs every <dir>/F-*.test.mjs as its own `node --test` process with APP_URL set, stops the app.
// Results: a list of { feature, passed, detail }. Tests import Playwright by absolute path from this folder's node_modules.
// run.json "auth" (#161): signed in once before the tests; the Playwright storage state reaches each test only as the environment variable
// APP_STORAGE_STATE (JSON, never a file). Typed values and the session's own values are masked in every detail. With auth, <out minus .json>.auth.json
// holds { given, signedIn, reason? }; without auth nothing changes and no such file is written.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { startApp } from './app.mjs';
import { validateAuth, authSecrets, redactSecrets, signIn } from './auth.mjs';
import { envOrigins, scrub } from './context.mjs';
import { launchChromium } from './browser.mjs';
import { expandSecrets } from './redact.mjs';

const MAX_STATE_BYTES = Number(process.env.RR_MAX_STATE_BYTES) || 100000; // (the variable is for tests) one environment string is capped near 128 KB on Linux; a bigger one would fail every test at spawn

const arg = (n) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : undefined; };
const appFile = path.resolve(arg('app') || '');
const testsDir = path.resolve(arg('tests') || '');
const out = path.resolve(arg('out') || '');
const run = JSON.parse(fs.readFileSync(appFile, 'utf8'));
if (run.platform !== 'web') throw new Error(`web adapter cannot run parity for platform "${run.platform}"`);
const { origin, stop } = await startApp(run, appFile);

const typed = authSecrets(run.auth);
const authInfo = { given: run.auth !== undefined, signedIn: false };
let stateJson = null, sessionSecrets = [];
const clean = (m) => redactSecrets(scrub(String(m).split('\n')[0]), typed);
const results = [];
try {
  if (authInfo.given) {
    try {
      validateAuth(run.auth);
      const { chromium } = await import('playwright');
      const browser = await launchChromium(chromium);
      let r;
      try { r = await signIn(browser, origin, run.auth, envOrigins(run.env, origin)); } finally { await browser.close().catch(() => {}); }
      if (!r.ok) authInfo.reason = r.reason;
      else {
        const j = JSON.stringify(r.storageState);
        if (j.length > MAX_STATE_BYTES) authInfo.reason = `the session is ${Math.round(j.length / 1000)} KB, too big to pass to the tests in the environment`;
        else {
          stateJson = j; authInfo.signedIn = true;
          sessionSecrets = expandSecrets([...r.storageState.cookies.map((c) => c.value), ...r.storageState.origins.flatMap((o) => o.localStorage.map((x) => x.value))].filter((v) => typeof v === 'string' && v.length >= 6));
        }
      }
    } catch (e) { authInfo.reason = clean(e.message); }
    if (authInfo.reason) authInfo.reason = clean(authInfo.reason);
    console.log(authInfo.signedIn ? 'parity: signed in, tests get APP_STORAGE_STATE' : `parity: sign-in failed, tests run signed out: ${authInfo.reason}`);
  }
  const mask = (t) => redactSecrets(redactSecrets(t, typed), sessionSecrets, true);
  const env = { ...process.env, APP_URL: origin, NODE_PATH: path.join(path.dirname(new URL(import.meta.url).pathname), 'node_modules') };
  delete env.APP_STORAGE_STATE;
  delete env.NODE_TEST_CONTEXT; // started from inside `node --test`, the child would report failures on stdout and exit 0
  if (stateJson) env.APP_STORAGE_STATE = stateJson;
  for (const file of fs.readdirSync(testsDir).filter((f) => /^F-.*\.test\.mjs$/.test(f)).sort()) {
    const r = spawnSync('node', ['--test', path.join(testsDir, file)], {
      cwd: path.dirname(new URL(import.meta.url).pathname), env,
      encoding: 'utf8', timeout: 60000, killSignal: 'SIGKILL',
    });
    const text = mask(`${r.stdout || ''}${r.stderr || ''}`.trim()).split('\n');
    const timedOut = r.error && r.error.code === 'ETIMEDOUT';
    const passed = r.status === 0 && !timedOut;
    // A signed-in test that failed because the sign-in did not work must say so, or the fixer would rewrite a right test.
    const note = !passed && authInfo.given && !authInfo.signedIn ? [`note: the run's sign-in failed (${authInfo.reason}); this test ran signed out`] : [];
    results.push({ feature: file.replace(/\.test\.mjs$/, ''), passed, detail: [...note, ...(timedOut ? ['timed out after 60 s', ...text] : text).slice(-20)].join('\n') });
  }
} finally {
  stop();
}
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify(results, null, 2));
if (authInfo.given) fs.writeFileSync(out.replace(/\.json$/, '') + '.auth.json', JSON.stringify(authInfo, null, 2));
console.log(`parity: ${results.filter((x) => x.passed).length}/${results.length} passed -> ${out}`);
process.exit(0);

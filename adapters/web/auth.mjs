// Optional sign-in for the web capture (run.json "auth"). The session lives in memory only: nothing here writes a file.
// Messages and reasons never hold a typed value: they name the step number and kind, and redactSecrets runs over the rest.
import { makeContext, runStep, scrub, locate } from './context.mjs';
import { authSecrets, redactSecrets } from './redact.mjs';
export { authSecrets, redactSecrets };

// A path segment that is a sign-in page: /login, /log-in, /auth/sign_in. Not /catalog/index or /dialog-info.
export const LOGIN_RE = /(^|\/)(log[-_]?in|sign[-_]?in)(\/|$)/i;
// True when a page that was asked for `asked` (a URL) ended on `landed` (a URL), signed in, on a sign-in page it did not ask for:
// the session was lost, or the route is protected. Inert when signed out. A page that itself asks for a sign-in-style path
// (/signin/callback going on to /login) is part of signing in, not a loss.
export function landedOnSignIn(asked, landed, signedIn) {
  if (!signedIn) return false;
  const a = new URL(asked), l = new URL(landed);
  return l.pathname !== a.pathname && LOGIN_RE.test(l.pathname) && !LOGIN_RE.test(a.pathname);
}
const KINDS = ['open', 'click', 'type', 'press', 'wait'];
const isStr = (v) => typeof v === 'string';

// Throws a message naming the step number and kind; never a value.
export function validateAuth(auth) {
  if (!auth || typeof auth !== 'object' || Array.isArray(auth)) throw new Error('auth in run.json must be an object with a steps array');
  if (!Array.isArray(auth.steps) || !auth.steps.length) throw new Error('auth.steps in run.json must be a non-empty array');
  auth.steps.forEach((step, i) => {
    const n = i + 1;
    if (!step || typeof step !== 'object' || Array.isArray(step)) throw new Error(`auth step ${n}: must be an object`);
    const kinds = Object.keys(step).filter((k) => KINDS.includes(k));
    if (kinds.length !== 1 || Object.keys(step).length !== 1) throw new Error(`auth step ${n}: must have exactly one of ${KINDS.join(', ')} and nothing else`);
    const kind = kinds[0], v = step[kind];
    const bad = kind === 'type' ? !(v && typeof v === 'object' && isStr(v.into) && isStr(v.text)) : kind === 'wait' ? !(typeof v === 'number' && v >= 0) : !isStr(v);
    if (bad) throw new Error(`auth step ${n} (${kind}): ${kind === 'type' ? 'needs string fields into and text' : kind === 'wait' ? 'needs a number of milliseconds' : 'needs a string'}`);
  });
  const e = auth.expect;
  if (e !== undefined) {
    if (!e || typeof e !== 'object' || Array.isArray(e)) throw new Error('auth.expect must be an object with path and/or text');
    if ((e.path !== undefined && !isStr(e.path)) || (e.text !== undefined && !isStr(e.text)) || (e.path === undefined && e.text === undefined)) throw new Error('auth.expect needs a string path and/or a string text');
  }
}

// Signs in, trying up to `attempts` times in fresh contexts: on a loaded machine a click can land before the page is
// ready, or the redirect can come late, and one miss would leave a whole parity run signed out. A failure that repeats
// is reported with the count. { ok: true, storageState } or { ok: false, reason }.
export async function signIn(browser, origin, auth, allowOrigins = [], { attempts = 3, clickMs = 10000, landMs = 15000 } = {}) {
  let r;
  for (let i = 1; i <= attempts; i++) {
    r = await signInOnce(browser, origin, auth, allowOrigins, { clickMs, landMs });
    if (r.ok) return r;
  }
  return attempts > 1 ? { ok: false, reason: `${r.reason} (tried ${attempts} times)` } : r;
}

// A click on a control that never holds still (an endless animation) times out on Playwright's stability check; it is
// then clicked without that check. A trial click (checks only) decides which, so the control is never clicked twice.
// A timeout after the click went through is a slow page change, left to the landing wait.
async function clickStep(page, name, clickMs) {
  const el = await locate(page, name);
  const timedOut = (err) => /Timeout/i.test(String(err && err.message));
  const ready = await el.click({ trial: true, timeout: clickMs }).then(() => true, (err) => { if (!timedOut(err)) throw err; return false; });
  await el.click(ready ? { timeout: clickMs } : { force: true, timeout: 5000 }).catch((err) => {
    if (!timedOut(err) || !/click action done/.test(err.message)) throw err;
  });
}

// Runs the steps once in a fresh context that is not recorded (its requests, console and blocked lists stay out of golden/;
// the sign-in request is the one that carries the password).
async function signInOnce(browser, origin, auth, allowOrigins, { clickMs, landMs }) {
  const secrets = authSecrets(auth);
  const clean = (m) => redactSecrets(scrub(String(m).split('\n')[0]), secrets);
  let context, n = 0, kind = '';
  try {
    ({ context } = await makeContext(browser, origin, { viewport: { width: 1440, height: 900 }, allowOrigins }));
    const page = await context.newPage();
    const pwVisible = async () => (await page.locator('input[type=password]:visible').count().catch(() => 0)) > 0;
    let formPath = null; // the route where a password field was last seen: the sign-in form (after a sign-up, the sign-in step that follows)
    for (const step of auth.steps) {
      n++; kind = KINDS.find((k) => k in step);
      if (kind === 'click') await clickStep(page, step.click, clickMs);
      else await runStep(page, origin, step);
      // let a client-rendered form finish loading before anything is typed or clicked into it; on a loaded machine the
      // first animation frame of a new page can take seconds, and every click check waits for frames
      if (kind === 'open') {
        await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
        await page.evaluate(() => new Promise((r) => { requestAnimationFrame(() => r()); setTimeout(r, 30000); })).catch(() => {});
      }
      if (await pwVisible()) formPath = new URL(page.url()).pathname;
    }
    n = 0;
    const e = auth.expect;
    const pathOf = (u) => { const x = new URL(u); return e.path.includes('?') ? x.pathname + x.search : x.pathname; };
    // a redirect after sign-in can take a while on a loaded machine: wait for the expected page, up to landMs
    if (e && e.path !== undefined) await page.waitForURL((u) => pathOf(u) === e.path, { timeout: landMs }).catch(() => {});
    await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
    const finalPath = new URL(page.url()).pathname;
    if (e) {
      if (e.path !== undefined && pathOf(page.url()) !== e.path) return { ok: false, reason: `sign-in ended on ${finalPath}, expected ${clean(e.path)}` };
      if (e.text !== undefined && !(await page.getByText(e.text).first().waitFor({ state: 'visible', timeout: 5000 }).then(() => true, () => false))) return { ok: false, reason: 'sign-in finished but the expected text is not visible' };
    } else {
      // No expect: the page must have left the sign-in form (another route, or the password field gone); a cookie alone proves nothing.
      if (formPath !== null && finalPath === formPath && await pwVisible()) return { ok: false, reason: `sign-in ended on ${finalPath}, still the sign-in form (the password field is still shown)` };
      if (formPath === null && LOGIN_RE.test(finalPath)) return { ok: false, reason: `sign-in ended on ${finalPath}, a sign-in page` };
    }
    const state = await context.storageState();
    if (!e && !state.cookies.length && !state.origins.some((o) => o.localStorage.length)) return { ok: false, reason: 'sign-in finished but no session was stored' };
    return { ok: true, storageState: state };
  } catch (err) {
    return { ok: false, reason: n ? `auth step ${n} (${kind}) failed: ${clean(err.message)}` : `sign-in failed: ${clean(err.message)}` };
  } finally {
    if (context) await context.close().catch(() => {});
  }
}

// Optional sign-in for the web capture (run.json "auth"). The session lives in memory only: nothing here writes a file.
// Messages and reasons never hold a typed value: they name the step number and kind, and redactSecrets runs over the rest.
import { makeContext, runStep, scrub } from './context.mjs';
import { authSecrets, redactSecrets } from './redact.mjs';
export { authSecrets, redactSecrets };

// A path segment that is a sign-in page: /login, /log-in, /auth/sign_in. Not /catalog/index or /dialog-info.
export const LOGIN_RE = /(^|\/)(log[-_]?in|sign[-_]?in)(\/|$)/i;
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

// Runs the steps once in a fresh context that is not recorded (its requests, console and blocked lists stay out of golden/;
// the sign-in request is the one that carries the password). { ok: true, storageState } or { ok: false, reason }.
export async function signIn(browser, origin, auth) {
  const secrets = authSecrets(auth);
  const clean = (m) => redactSecrets(scrub(String(m).split('\n')[0]), secrets);
  let context, n = 0, kind = '';
  try {
    ({ context } = await makeContext(browser, origin, { viewport: { width: 1440, height: 900 } }));
    const page = await context.newPage();
    const pwVisible = async () => (await page.locator('input[type=password]:visible').count().catch(() => 0)) > 0;
    let formPath = null; // the route where a password field was last seen: the sign-in form (after a sign-up, the sign-in step that follows)
    for (const step of auth.steps) {
      n++; kind = KINDS.find((k) => k in step); await runStep(page, origin, step);
      if (await pwVisible()) formPath = new URL(page.url()).pathname;
    }
    n = 0;
    await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
    const finalPath = new URL(page.url()).pathname;
    const e = auth.expect;
    if (e) {
      if (e.path !== undefined && (e.path.includes('?') ? finalPath + new URL(page.url()).search : finalPath) !== e.path) return { ok: false, reason: `sign-in ended on ${finalPath}, expected ${clean(e.path)}` };
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

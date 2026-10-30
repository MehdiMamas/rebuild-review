// Browser context shared by the crawl, the state walker and the probes.
// Enforces the safety rules: only the app's own origin is reachable, secrets never reach the HAR.
const SECRET_HEADERS = new Set(['authorization', 'proxy-authorization', 'cookie', 'set-cookie', 'x-api-key', 'x-auth-token', 'x-csrf-token']);
const SECRET_PARAM = /token|key|secret|auth|pass|session|sig|code/i;
const TOKEN_LIKE = [/\b(Bearer|Basic)\s+\S+/gi, /eyJ[\w-]+\.[\w-]+\.[\w-]*/g, /[A-Za-z0-9_\-+/=]{32,}/g];

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function scrub(value) {
  let v = String(value);
  for (const re of TOKEN_LIKE) v = v.replace(re, '[redacted]');
  return v;
}

export function redactHeaders(headers) {
  return Object.entries(headers)
    .filter(([n]) => !SECRET_HEADERS.has(n.toLowerCase()))
    .map(([name, value]) => ({ name, value: scrub(value) }));
}

export function redactUrl(raw) {
  try {
    const u = new URL(raw);
    for (const k of [...u.searchParams.keys()]) {
      if (SECRET_PARAM.test(k)) u.searchParams.set(k, '[redacted]');
      else u.searchParams.set(k, scrub(u.searchParams.get(k)));
    }
    return decodeURIComponent(u.toString());
  } catch {
    return scrub(raw);
  }
}

export function assertLocalhost(address) {
  const u = new URL(address);
  if (!['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)) {
    throw new Error(`refusing ${address}: only localhost addresses are captured`);
  }
  return u;
}

const isApi = (r) => ['fetch', 'xhr'].includes(r.request().resourceType());

// Makes a context that blocks anything off the app's origin and records a redacted HAR.
// faults (mutable): { slowMs: delay every fetch/xhr, failApi: answer every fetch/xhr with 500 }
export async function makeContext(browser, origin, { viewport, colorScheme = 'light', faults = {} } = {}) {
  const context = await browser.newContext({ viewport, colorScheme });
  const rec = { blocked: [], har: [], console: [], pageErrors: [] };
  await context.route('**/*', async (route) => {
    if (new URL(route.request().url()).origin !== origin) {
      rec.blocked.push(redactUrl(route.request().url()));
      return route.abort('blockedbyclient');
    }
    return route.fallback();
  });
  // The flags are read per request, so a probe can switch them on after the page has loaded.
  await context.route('**/*', async (route) => {
    if (!isApi(route) || !(faults.slowMs || faults.failApi)) return route.fallback();
    if (faults.slowMs) await sleep(faults.slowMs);
    if (faults.failApi) return route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"simulated failure"}' });
    return route.fallback();
  });
  context.on('requestfinished', async (req) => {
    try {
      const res = await req.response();
      rec.har.push({
        startedDateTime: new Date(req.timing().startTime || Date.now()).toISOString(),
        time: Math.round(req.timing().responseEnd || 0),
        request: { method: req.method(), url: redactUrl(req.url()), headers: redactHeaders(await req.allHeaders()) },
        response: { status: res.status(), headers: redactHeaders(await res.allHeaders()) },
      });
    } catch {}
  });
  context.on('page', (page) => {
    page.on('console', (m) => m.type() === 'error' && rec.console.push(scrub(m.text())));
    page.on('pageerror', (e) => rec.pageErrors.push(scrub(e.message)));
  });
  return { context, rec };
}

// Finds an element by accessible name or text; used by states.json steps and the probes.
export async function locate(page, name) {
  const tries = [
    page.getByLabel(name, { exact: true }),
    page.getByPlaceholder(name, { exact: true }),
    page.getByRole('button', { name }),
    page.getByRole('link', { name }),
    page.getByText(name, { exact: true }),
    page.getByText(name),
  ];
  for (const l of tries) if ((await l.count()) > 0) return l.first();
  throw new Error(`nothing found by name or text: ${name}`);
}

export async function runStep(page, origin, step) {
  if ('open' in step) await page.goto(new URL(step.open, origin).toString());
  else if ('click' in step) await (await locate(page, step.click)).click();
  else if ('type' in step) await (await locate(page, step.type.into)).pressSequentially(step.type.text, { delay: 30 });
  else if ('press' in step) await page.keyboard.press(step.press);
  else if ('wait' in step) await sleep(step.wait);
  else if ('failRequest' in step)
    await page.route((u) => u.href.includes(step.failRequest), (r) => r.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"simulated failure"}' }));
  else if ('slowRequest' in step)
    await page.route((u) => u.href.includes(step.slowRequest.match), async (r) => { await sleep(step.slowRequest.ms); r.fallback(); });
  else throw new Error(`unknown step ${JSON.stringify(step)}`);
}

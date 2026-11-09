// General checks for an HTTP service. Each row: { probe, screen, passed, evidence }; passed=false means the probe flagged a problem.
// screens: [{ id, req, res }] of every screen captured; log: every call made so far ({ screen, req, res }); go(screen, req) makes and records one more call.
import { scrub } from '../web/context.mjs';
import { restart } from './api.mjs';

const STACK = [/^\s+at\s.+:\d+(:\d+)?\)?\s*$/m, /\n\s+at\s[\w$.<>]+\s*\(.+:\d+(:\d+)?\)/, /Traceback \(most recent call last\)/, /thread '[^']*' panicked/, /(^|\n)panic:[\s\S]*goroutine \d+/, /\bat [\w.$]+\([\w$]+\.java:\d+\)/, /Stack trace:\s*\n#0 /, /\.rb:\d+:in [`']/];
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const TOKEN_FORMATS = [
  ['an sk- key', /\bsk-[A-Za-z0-9_-]{16,}/], ['a GitHub token', /\bghp_[A-Za-z0-9]{20,}/], ['an AWS access key id', /\bAKIA[0-9A-Z]{16}\b/],
  ['a Slack token', /\bxox[abprs]-[A-Za-z0-9-]{10,}/], ['a private key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['a JWT', /\beyJ[\w-]+\.[\w-]+\.[\w-]+/],
];
const SECRET_NAME = /KEY|TOKEN|SECRET|PASS|CREDENTIAL|AUTH/i;
const JSON_CT = /json/i;
const HANG_MS = 10000;

const median = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
const text = (body) => (typeof body === 'string' ? body : JSON.stringify(body ?? ''));
const strings = (v, out = []) => { if (typeof v === 'string') out.push(v); else if (Array.isArray(v)) v.forEach((x) => strings(x, out)); else if (v && typeof v === 'object') Object.values(v).forEach((x) => strings(x, out)); return out; };
const first = (t, re) => { const m = re.exec(t); return m ? m[0].trim().slice(0, 120) : null; };

export async function runProbes({ ctx, go, screens, log, timings, notChecked }) {
  const rows = [];
  const envValues = Object.entries(ctx.run.env || {}).filter(([k]) => SECRET_NAME.test(k)).map(([, v]) => String(v)).filter((v) => v.length >= 8);
  const row = (probe, screen, passed, evidence) => rows.push({ probe, screen, passed, evidence: scrub(evidence) });
  const safe = async (probe, screen, fn) => { try { await fn(); } catch (e) { notChecked.push({ probe, route: screen, reason: scrub(String(e.message).split('\n')[0]) }); } };
  const label = (s) => `${s.req.method} ${s.req.path}`;

  // A request for a path that does not exist, for the error probes.
  await safe('not-found', 'not-found', async () => { await go('not-found', { method: 'GET', path: '/rr-not-found-probe' }, 'not found'); });

  // server-error-on-bad-input: malformed JSON, an empty object, wrong types, an oversize string, on every documented request with a JSON body.
  for (const s of screens) {
    if (!s.req.body || typeof s.req.body !== 'object' || Array.isArray(s.req.body) || !['POST', 'PUT', 'PATCH'].includes(s.req.method)) continue;
    await safe('server-error-on-bad-input', s.id, async () => {
      const own = s.req.body;
      const keys = Object.keys(own);
      const stringKey = keys.find((k) => typeof own[k] === 'string') || 'x';
      const variants = [
        ['malformed JSON', '{"a":'],
        ['empty object', {}],
        ['wrong types', Object.fromEntries(keys.map((k) => [k, typeof own[k] === 'string' ? 123 : 'wrong']))],
        ['100 KB string', { ...own, [stringKey]: 'x'.repeat(100000) }],
      ].filter(([, b]) => JSON.stringify(b) !== JSON.stringify(own));
      const bad = [];
      for (const [name, body] of variants) {
        const r = await go(s.id, { method: s.req.method, path: s.req.path, headers: { 'content-type': 'application/json' }, body, timeoutMs: HANG_MS }, `bad input: ${name}`);
        if (r.status >= 500) bad.push(`${name} gave ${r.status}`);
        else if (r.status === 0 && r.error !== 'timeout') { bad.push(`${name} ended the connection (${r.error})`); await restart(ctx, { fresh: false }); }
      }
      row('server-error-on-bad-input', s.id, !bad.length, bad.length ? `${label(s)}: ${bad.join('; ')}` : `${label(s)}: malformed, empty, wrong-type and oversize bodies all got a non-5xx answer`);
    });
  }

  // The bad-input calls can leave oversize values in the service's store; the later calls start from an empty one.
  if (screens.some((x) => ['POST', 'PUT', 'PATCH'].includes(x.req.method))) await restart(ctx, { fresh: true });

  // cors: one more request with an Origin header on every GET screen.
  for (const s of screens.filter((x) => x.req.method === 'GET' && !x.res.error)) {
    await safe('cors-wildcard-credentials', s.id, async () => { await go(s.id, { ...s.req, headers: { ...(s.req.headers || {}), origin: 'https://rr-origin.invalid' }, timeoutMs: HANG_MS }, 'with Origin'); });
  }

  const ids = [...screens.map((s) => s.id), 'not-found'];
  const jsonApi = log.some((e) => e.res.status >= 200 && e.res.status < 300 && JSON_CT.test(e.res.headers['content-type'] || ''));
  for (const id of ids) {
    const calls = log.filter((e) => e.screen === id);
    if (!calls.length) continue;
    const s = screens.find((x) => x.id === id);
    const where = s ? label(s) : 'GET /rr-not-found-probe';
    const cap = s ? calls.find((c) => !c.label) || calls[0] : calls[0];

    // server-error-on-valid: the documented request itself.
    if (s) row('server-error-on-valid', id, !(cap.res.status >= 500), cap.res.status >= 500 ? `${where} answered ${cap.res.status}` : `${where} answered ${cap.res.status || 'nothing'}`);

    let hit = null, hitAt = '';
    for (const c of calls) for (const re of STACK) if (!hit) { hit = first(`${text(c.res.body)}\n${strings(c.res.body).join('\n')}`, re); hitAt = `${c.req.method} ${c.req.path}${c.label ? ` (${c.label})` : ''} -> ${c.res.status}`; }
    row('stack-trace-in-body', id, !hit, hit ? `a stack trace is in the body of ${hitAt}: ${hit}` : 'no stack trace in any body');

    const html = calls.find((c) => c.res.status >= 400 && !c.res.error && (c.res.binary ? false : (typeof c.res.body === 'string' && !JSON_CT.test(c.res.headers['content-type'] || ''))));
    if (jsonApi) row('error-not-json', id, !html, html ? `${html.req.method} ${html.req.path}${html.label ? ` (${html.label})` : ''} answered ${html.res.status} with ${html.res.body.trim() === '' ? 'an empty body' : `${(html.res.headers['content-type'] || 'no content-type').split(';')[0]} (${text(html.res.body).trim().slice(0, 60).replace(/\s+/g, ' ')})`}, on a service that answers in JSON` : 'every error answer is JSON');

    const wrong = calls.find((c) => typeof c.res.body === 'string' && !JSON_CT.test(c.res.headers['content-type'] || '') && /^\s*[{[]/.test(c.res.body) && (() => { try { JSON.parse(c.res.body); return true; } catch { return false; } })());
    row('wrong-content-type', id, !wrong, wrong ? `${wrong.req.method} ${wrong.req.path} sent JSON as ${(wrong.res.headers['content-type'] || 'no content-type').split(';')[0]}` : 'JSON bodies carry a JSON content-type');

    if (s) {
      const hung = cap.res.error === 'timeout';
      const stream = /event-stream/i.test(cap.res.headers['content-type'] || '');
      row('no-timeout', id, !hung || stream, hung ? (stream ? `${where} is a stream and was still open at 10 s (cut there)` : `${where} was still open at 10 s with the service idle`) : `${where} ended on its own in ${cap.res.ms} ms`);
    }

    const cors = calls.find((c) => c.res.headers['access-control-allow-origin'] === '*' && String(c.res.headers['access-control-allow-credentials']).toLowerCase() === 'true');
    if (s && s.req.method === 'GET') row('cors-wildcard-credentials', id, !cors, cors ? `${where} sends Access-Control-Allow-Origin: * together with Access-Control-Allow-Credentials: true` : 'no wildcard origin with credentials');

    let secret = null;
    for (const c of calls) {
      if (secret) break;
      if (/^bad input/.test(c.label || '')) continue;
      const t = text(c.res.body);
      const kind = TOKEN_FORMATS.find(([, re]) => re.test(t)) || (envValues.find((v) => t.includes(v)) ? ['a value from run.json env'] : null);
      if (kind) secret = `${c.req.method} ${c.req.path}${c.label ? ` (${c.label})` : ''}: ${kind[0]}`;
    }
    row('secret-in-response', id, !secret, secret ? `a token-like value is in the body of ${secret}` : 'no known token format and no run.json env value in any body');
  }

  // latency-ms: a value, not a pass or fail.
  const target = screens.find((x) => x.req.method === 'GET' && x.res.status < 500 && x.res.status > 0 && !x.res.error);
  if (target) await safe('latency-ms', target.id, async () => {
    const ms = [];
    for (let i = 0; i < 5; i++) ms.push((await go(target.id, { ...target.req, timeoutMs: HANG_MS }, 'latency', { record: false })).ms);
    const v = median(ms);
    timings.push({ name: 'latency-ms', value: v, unit: 'ms' });
    row('latency-ms', target.id, true, `latency-ms ${v} (median of 5 ${label(target)} calls; a value, not judged)`);
  });
  else notChecked.push({ probe: 'latency-ms', route: 'all', reason: 'no GET screen answered' });
  return rows;
}

// Masking of typed sign-in values (run.json auth) and env values. No imports: shared by the web adapter, events.mjs and room.mjs.
// A typed auth value is masked as a whole value: it is not touched when it sits inside a longer word (a secret "test" leaves "latest" alone).
// The edge test applies only where the value starts or ends with a word character, so "pw!" is still found in "pw!x".
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const WORD = /\w/;

// Every non-empty string worth masking, in its plain, JSON-escaped and HTML-escaped forms, longest first.
export function expandSecrets(values) {
  const out = new Set();
  for (const v of values || []) {
    if (typeof v !== 'string' || !v) continue;
    out.add(v);
    const j = JSON.stringify(v).slice(1, -1);
    if (j !== v) out.add(j);
    // page.content() and other HTML writers escape & < > and quotes; mask those forms too.
    const base = v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    for (const h of [base, base.replace(/"/g, '&quot;'), base.replace(/"/g, '&quot;').replace(/'/g, '&#39;'), base.replace(/"/g, '&quot;').replace(/'/g, '&#x27;')]) if (h !== v) out.add(h);
  }
  return [...out].sort((a, b) => b.length - a.length);
}

const caches = { whole: new WeakMap(), sub: new WeakMap() };
function regexFor(secrets, sub) {
  const cache = sub ? caches.sub : caches.whole;
  let re = cache.get(secrets);
  if (re) return re;
  const alts = secrets.map((s) => (sub ? esc(s) : `${WORD.test(s[0]) ? '(?<!\\w)' : ''}${esc(s)}${WORD.test(s[s.length - 1]) ? '(?!\\w)' : ''}`));
  re = new RegExp(alts.join('|'), 'g');
  cache.set(secrets, re);
  return re;
}

// Strings, arrays and objects with every whole-value hit replaced by ***. `secrets` comes from expandSecrets or authSecrets.
// With substring true every occurrence is masked, even inside a longer word (run.json env values).
export function redactSecrets(value, secrets, substring = false) {
  if (!secrets || !secrets.length) return value;
  if (typeof value === 'string') return value.replace(regexFor(secrets, substring), '***');
  if (Array.isArray(value)) return value.map((x) => redactSecrets(x, secrets, substring));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, x]) => [k, redactSecrets(x, secrets, substring)]));
  return value;
}

// The typed values of an auth block: every type.text of any length.
export function authSecrets(auth) {
  const steps = auth && Array.isArray(auth.steps) ? auth.steps : [];
  return expandSecrets(steps.map((s) => s && s.type && s.type.text));
}

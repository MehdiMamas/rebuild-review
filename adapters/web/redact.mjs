// Masking of typed sign-in values (run.json auth) and env values. No imports: shared by the web adapter, events.mjs and room.mjs.
// A value is masked as a whole value: it is not touched when it sits inside a longer word (a secret "test" leaves "latest" alone).
// The edge test applies only where the value starts or ends with a word character, so "pw!" is still found in "pw!x".
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const WORD = /\w/;

// Every non-empty string worth masking, in its plain and its JSON-escaped form, longest first.
export function expandSecrets(values) {
  const out = new Set();
  for (const v of values || []) {
    if (typeof v !== 'string' || !v) continue;
    out.add(v);
    const j = JSON.stringify(v).slice(1, -1);
    if (j !== v) out.add(j);
  }
  return [...out].sort((a, b) => b.length - a.length);
}

const cache = new WeakMap();
function regexFor(secrets) {
  let re = cache.get(secrets);
  if (re) return re;
  const alts = secrets.map((s) => `${WORD.test(s[0]) ? '(?<!\\w)' : ''}${esc(s)}${WORD.test(s[s.length - 1]) ? '(?!\\w)' : ''}`);
  re = new RegExp(alts.join('|'), 'g');
  cache.set(secrets, re);
  return re;
}

// Strings, arrays and objects with every whole-value hit replaced by ***. `secrets` comes from expandSecrets or authSecrets.
export function redactSecrets(value, secrets) {
  if (!secrets || !secrets.length) return value;
  if (typeof value === 'string') return value.replace(regexFor(secrets), '***');
  if (Array.isArray(value)) return value.map((x) => redactSecrets(x, secrets));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, x]) => [k, redactSecrets(x, secrets)]));
  return value;
}

// The typed values of an auth block: every type.text of any length.
export function authSecrets(auth) {
  const steps = auth && Array.isArray(auth.steps) ? auth.steps : [];
  return expandSecrets(steps.map((s) => s && s.type && s.type.text));
}

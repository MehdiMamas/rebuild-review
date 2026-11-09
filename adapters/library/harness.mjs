// Runs in a child process, one per call sequence: imports the package by absolute path, executes a JSON list of steps and
// writes one JSON result file. node harness.mjs <module file> <steps.json> <result.json>
// Steps: { call, args }, { new, as, args }, { get }, { list: true }. Values are tagged (see encode and decode).
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';

const [modulePath, stepsFile, resultFile] = process.argv.slice(2);
const steps = JSON.parse(fs.readFileSync(stepsFile, 'utf8'));
const unhandled = [];
process.on('unhandledRejection', (e) => unhandled.push({ kind: 'rejection', value: encode(e) }));
process.on('uncaughtException', (e) => unhandled.push({ kind: 'exception', value: encode(e) }));

const DEPTH = 8;
export function encode(v, seen = new WeakSet(), depth = 0) {
  if (v === undefined) return { $: 'undefined' };
  if (v === null || typeof v === 'boolean' || typeof v === 'string') return v;
  if (typeof v === 'number') return Number.isFinite(v) && !Object.is(v, -0) ? v : { $: 'number', v: Object.is(v, -0) ? '-0' : String(v) };
  if (typeof v === 'bigint') return { $: 'bigint', v: String(v) };
  if (typeof v === 'symbol') return { $: 'symbol', v: v.description ?? '' };
  if (typeof v === 'function') return { $: 'fn', name: v.name || 'anonymous', ...(/^class[\s{]/.test(Function.prototype.toString.call(v)) ? { isClass: true } : {}) };
  if (depth > DEPTH) return { $: 'depth' };
  if (seen.has(v)) return { $: 'circular' };
  seen.add(v);
  try {
    if (v instanceof Date) return { $: 'Date', v: Number.isNaN(v.getTime()) ? 'Invalid Date' : v.toISOString() };
    if (v instanceof Error) return { $: 'Error', name: v.name, message: v.message, ...(v.code !== undefined ? { code: String(v.code) } : {}) };
    if (v instanceof RegExp) return { $: 'RegExp', v: String(v) };
    if (v instanceof Map) return { $: 'Map', v: [...v].map(([k, x]) => [encode(k, seen, depth + 1), encode(x, seen, depth + 1)]) };
    if (v instanceof Set) return { $: 'Set', v: [...v].map((x) => encode(x, seen, depth + 1)) };
    if (v instanceof Promise) return { $: 'Promise' };
    if (ArrayBuffer.isView(v) || v instanceof ArrayBuffer) {
      const b = v instanceof ArrayBuffer ? Buffer.from(v) : Buffer.from(v.buffer, v.byteOffset, v.byteLength);
      return { $: 'bytes', type: v.constructor.name, length: b.length, v: b.subarray(0, 1024).toString('base64') };
    }
    if (Array.isArray(v)) return v.map((x) => encode(x, seen, depth + 1));
    const proto = Object.getPrototypeOf(v);
    if (proto === Object.prototype || proto === null) {
      const o = {};
      for (const k of Object.keys(v)) o[k] = encode(v[k], seen, depth + 1);
      return Object.hasOwn(o, '$') ? { $: 'object', v: o } : o;
    }
    return { $: 'instance', class: (v.constructor && v.constructor.name) || 'anonymous' };
  } finally { seen.delete(v); }
}

function deepFreeze(v) {
  if (v && typeof v === 'object' && !Object.isFrozen(v)) { Object.freeze(v); for (const k of Reflect.ownKeys(v)) deepFreeze(v[k]); }
  return v;
}

function decode(v, scope) {
  if (Array.isArray(v)) return v.map((x) => decode(x, scope));
  if (v === null || typeof v !== 'object') return v;
  if (typeof v.$ === 'string') {
    switch (v.$) {
      case 'undefined': return undefined;
      case 'number': return Number(v.v);
      case 'bigint': return BigInt(v.v);
      case 'symbol': return Symbol(v.v);
      case 'Date': return new Date(v.v);
      case 'Map': return new Map(v.v.map(([k, x]) => [decode(k, scope), decode(x, scope)]));
      case 'Set': return new Set(v.v.map((x) => decode(x, scope)));
      case 'RegExp': { const m = /^\/(.*)\/([a-z]*)$/s.exec(v.v); return m ? new RegExp(m[1], m[2]) : new RegExp(v.v); }
      case 'Error': { const e = new Error(v.message); e.name = v.name || 'Error'; if (v.code !== undefined) e.code = v.code; return e; }
      case 'bytes': return new Uint8Array(Buffer.from(v.v, 'base64'));
      case 'fn': return function () {};
      case 'cb': return function (...a) { scope.callbacks.push({ args: a.map((x) => encode(x)) }); return decode(v.returns, scope); };
      case 'frozen': return deepFreeze(decode(v.v, scope));
      case 'ref': return scope.vars[v.name];
      case 'object': return Object.fromEntries(Object.entries(v.v).map(([k, x]) => [k, decode(x, scope)]));
    }
  }
  return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, decode(x, scope)]));
}

const t0 = performance.now();
let mod, importError = null;
try { mod = await import(pathToFileURL(modulePath).href); } catch (e) { importError = encode(e); }
const importMs = Math.round((performance.now() - t0) * 100) / 100;

const vars = {};
// A name is the module's export, else a property of its default export (CommonJS), else a variable made by "new".
function resolve(name) {
  const parts = String(name).split('.');
  let parent, cur;
  if (Object.hasOwn(vars, parts[0])) cur = vars[parts[0]];
  else if (parts[0] in mod) cur = mod[parts[0]];
  else if (mod.default != null && parts[0] in Object(mod.default)) cur = mod.default[parts[0]];
  else throw new TypeError(`${parts[0]} is not exported`);
  for (const p of parts.slice(1)) { parent = cur; cur = cur[p]; }
  return { value: cur, parent };
}

const results = [];
for (const step of steps) {
  const scope = { vars, callbacks: [] };
  const done = (o) => results.push({ ...o, ...(scope.callbacks.length ? { callbacks: scope.callbacks } : {}) });
  if (importError) { done({ ok: false, threw: importError }); continue; }
  try {
    let returned;
    if (step.list) {
      returned = Object.keys(mod).map((n) => ({ name: n, type: typeof mod[n] }));
      const d = mod.default;
      if (d && typeof d === 'object') for (const k of Object.keys(d)) if (!(k in mod)) returned.push({ name: k, type: typeof d[k] });
    } else if ('new' in step) {
      const { value: C } = resolve(step.new);
      const inst = new C(...decode(step.args || [], scope));
      if (step.as) vars[step.as] = inst;
      returned = await inst;
      if (returned === inst) returned = inst;
    } else if ('get' in step) {
      returned = await resolve(step.get).value;
    } else if ('call' in step) {
      const { value: f, parent } = resolve(step.call);
      if (typeof f !== 'function') throw new TypeError(`${step.call} is not a function`);
      returned = await f.apply(parent, decode(step.args || [], scope));
    } else throw new TypeError('step not understood');
    done({ ok: true, returned: step.list ? returned : encode(returned) });
  } catch (e) {
    done({ ok: false, threw: encode(e), thrownIsError: e instanceof Error });
  }
}
// Let a rejection nobody awaited surface before the result is written.
await new Promise((r) => setTimeout(r, 50));
await new Promise((r) => setImmediate(r));
fs.writeFileSync(resultFile + '.tmp', JSON.stringify({ importMs, importError, results, unhandled }));
fs.renameSync(resultFile + '.tmp', resultFile);

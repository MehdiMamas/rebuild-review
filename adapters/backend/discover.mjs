// Find the operations of the service: its OpenAPI document first, then the common document paths, then probing.
// operations(ctx, { call }) returns { operations, notes, surfaceKnown, source }.
// An operation: { method, path (template), params, request: { method, path, query?, body? } | null, skip?: reason, security?, source: 'openapi'|'probe' }.
import fs from 'node:fs';
import path from 'node:path';
import { call as apiCall } from './api.mjs';

const COMMON = ['/openapi.json', '/openapi.yaml', '/swagger.json', '/v3/api-docs', '/docs/json', '/.well-known/openapi'];
const METHODS = ['get', 'post', 'put', 'patch', 'delete'];
export const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const PROBE_CAP = 60;

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);

function deref(doc, node, depth = 0) {
  if (isObj(node) && typeof node.$ref === 'string' && depth < 10) {
    const parts = node.$ref.replace(/^#\//, '').split('/').map((x) => x.replace(/~1/g, '/').replace(/~0/g, '~'));
    let cur = doc;
    for (const p of parts) cur = cur && cur[p];
    return deref(doc, cur, depth + 1);
  }
  return node;
}

// The smallest valid value of a schema: example, default, enum or const first, then by type (required properties only).
export function minimal(doc, schema, depth = 0) {
  const s = deref(doc, schema);
  if (!isObj(s) || depth > 6) return null;
  if ('example' in s) return s.example;
  if ('default' in s) return s.default;
  if ('const' in s) return s.const;
  if (Array.isArray(s.enum) && s.enum.length) return s.enum[0];
  if (Array.isArray(s.allOf)) return Object.assign({}, ...s.allOf.map((x) => minimal(doc, x, depth + 1)).filter(isObj));
  for (const k of ['oneOf', 'anyOf']) if (Array.isArray(s[k]) && s[k].length) return minimal(doc, s[k][0], depth + 1);
  const type = Array.isArray(s.type) ? s.type.find((t) => t !== 'null') : s.type;
  switch (type) {
    case 'object': case undefined: {
      if (type === undefined && !s.properties) return null;
      const out = {};
      for (const k of s.required || []) out[k] = minimal(doc, (s.properties || {})[k], depth + 1);
      return out;
    }
    case 'array': return [];
    case 'integer': return s.minimum !== undefined ? s.minimum : 1;
    case 'number': return s.minimum !== undefined ? s.minimum : 1;
    case 'boolean': return false;
    case 'string':
      if (s.format === 'date-time') return '2020-01-01T00:00:00Z';
      if (s.format === 'date') return '2020-01-01';
      if (s.format === 'email') return 'user@example.com';
      if (s.format === 'uuid') return '00000000-0000-4000-8000-000000000000';
      if (s.format === 'uri') return 'http://127.0.0.1/';
      return s.minLength ? 'x'.repeat(s.minLength) : 'string';
    default: return null;
  }
}

function exampleOf(doc, holder) {
  const h = deref(doc, holder);
  if (!isObj(h)) return undefined;
  if ('example' in h) return h.example;
  if (isObj(h.examples)) { const first = Object.values(h.examples)[0]; const e = deref(doc, first); if (isObj(e) && 'value' in e) return e.value; }
  return undefined;
}

// Operations from a parsed OpenAPI (3.x or 2.0) document.
export function fromOpenApi(doc) {
  const ops = [];
  for (const [tpl, item0] of Object.entries(doc.paths || {})) {
    const item = deref(doc, item0);
    if (!isObj(item)) continue;
    for (const m of METHODS) {
      const op = deref(doc, item[m]);
      if (!isObj(op)) continue;
      const method = m.toUpperCase();
      const parameters = [...(item.parameters || []), ...(op.parameters || [])].map((p) => deref(doc, p)).filter(isObj);
      const params = parameters.map((p) => ({ name: p.name, in: p.in, required: !!p.required }));
      let reqPath = tpl, unresolved = false;
      const query = {};
      for (const p of parameters) {
        const ex = exampleOf(doc, p);
        const v = ex ?? (p.schema ? minimal(doc, p.schema) : null);
        if (p.in === 'path') {
          if (ex === undefined) unresolved = true;
          reqPath = reqPath.replace(`{${p.name}}`, encodeURIComponent(v ?? '1'));
        } else if (p.in === 'query' && p.required && v !== null && v !== undefined) query[p.name] = v;
      }
      reqPath = reqPath.replace(/\{[^}]+\}/g, '1');
      const entry = { method, path: tpl, params, source: 'openapi', security: !!(op.security && op.security.length) || (op.security === undefined && !!(doc.security && doc.security.length)) };
      const req = { method, path: reqPath };
      if (Object.keys(query).length) req.query = query;
      // Request body: 3.x requestBody, 2.0 body parameter.
      const rb = deref(doc, op.requestBody);
      let body, hasBody = false, bodyRequired = false;
      if (isObj(rb) && isObj(rb.content)) {
        const mt = rb.content['application/json'] || Object.entries(rb.content).find(([k]) => /json/.test(k))?.[1];
        bodyRequired = !!rb.required;
        if (mt) { hasBody = true; body = exampleOf(doc, mt); if (body === undefined && mt.schema) body = minimal(doc, mt.schema); }
        else if (bodyRequired) { entry.skip = 'its request body is not JSON'; }
      } else {
        const bp = parameters.find((p) => p.in === 'body');
        if (bp) { hasBody = true; bodyRequired = !!bp.required; body = exampleOf(doc, bp); if (body === undefined && bp.schema) body = minimal(doc, bp.schema); }
      }
      if (hasBody && body !== undefined && body !== null) req.body = body;
      else if (hasBody && bodyRequired) entry.skip = 'no example or schema for its request body';
      if (MUTATING.has(method) && unresolved && !entry.skip) entry.skip = 'a path parameter needs data that exists only after other calls';
      entry.request = req;
      ops.push(entry);
    }
  }
  return ops;
}

const readJson = (t) => { try { return JSON.parse(t); } catch { return null; } };
const isOpenApi = (d) => isObj(d) && isObj(d.paths) && (d.openapi || d.swagger);

async function findDocument(ctx, call, notes) {
  const run = ctx.run;
  if (run.openapi) {
    if (run.openapi.startsWith('/')) {
      const r = await call(ctx, { path: run.openapi, timeoutMs: 10000 });
      const d = typeof r.body === 'string' ? readJson(r.body) : r.body;
      if (isOpenApi(d)) return { doc: d, from: run.openapi };
      notes.push(`run.json openapi ${run.openapi} did not give an OpenAPI document (status ${r.status})`);
    } else {
      const f = path.resolve(ctx.workDir, run.openapi);
      const rel = path.relative(ctx.workDir, f);
      if (rel.startsWith('..') || path.isAbsolute(rel)) notes.push('run.json openapi must stay inside the work copy');
      else try { const d = readJson(fs.readFileSync(f, 'utf8')); if (isOpenApi(d)) return { doc: d, from: run.openapi }; notes.push(`run.json openapi ${run.openapi} is not an OpenAPI JSON document`); } catch (e) { notes.push(`run.json openapi ${run.openapi} could not be read`); }
    }
  }
  for (const p of COMMON) {
    const r = await call(ctx, { path: p, timeoutMs: 10000 });
    if (r.status !== 200) continue;
    const d = typeof r.body === 'string' ? readJson(r.body) : r.body;
    if (isOpenApi(d)) return { doc: d, from: p };
    if (/yaml/.test(r.headers['content-type'] || '') || /\.ya?ml$/.test(p) && typeof r.body === 'string' && /^(openapi|swagger):/m.test(r.body)) notes.push(`${p} is YAML; only OpenAPI in JSON is read`);
  }
  return null;
}

// Probing: GET /, links in its headers and JSON, OPTIONS on each path found, robots.txt.
async function probe(ctx, call, notes) {
  const found = new Map(); // path -> Set(methods)
  const add = (p, ms = ['GET']) => { if (found.size >= PROBE_CAP && !found.has(p)) return; if (!found.has(p)) found.set(p, new Set()); for (const m of ms) found.get(p).add(m); };
  const toPath = (v) => {
    if (typeof v !== 'string' || !v) return null;
    try { const u = new URL(v, ctx.origin); return u.origin === ctx.origin ? u.pathname : null; } catch { return null; }
  };
  const root = await call(ctx, { path: '/', timeoutMs: 10000 });
  if (root.status === 200) add('/');
  const links = (root.headers.link || '').matchAll(/<([^>]+)>/g);
  for (const m of links) { const p = toPath(m[1]); if (p) add(p); }
  const walk = (v, depth = 0) => {
    if (depth > 6) return;
    if (Array.isArray(v)) v.slice(0, 50).forEach((x) => walk(x, depth + 1));
    else if (isObj(v)) for (const [k, x] of Object.entries(v)) { if ((k === 'href' || k === 'url') && typeof x === 'string') { const p = toPath(x); if (p) add(p); } else walk(x, depth + 1); }
  };
  if (isObj(root.body) || Array.isArray(root.body)) walk(root.body);
  const robots = await call(ctx, { path: '/robots.txt', timeoutMs: 10000 });
  if (robots.status === 200 && typeof robots.body === 'string') for (const m of robots.body.matchAll(/^\s*(?:Allow|Disallow)\s*:\s*(\/\S*)/gim)) { const p = toPath(m[1]); if (p && !/[*$]/.test(p)) add(p); }
  for (const p of [...found.keys()]) {
    const r = await call(ctx, { method: 'OPTIONS', path: p, timeoutMs: 10000 });
    const allow = r.headers.allow;
    if (allow) for (const m of allow.split(',').map((x) => x.trim().toUpperCase())) if (['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(m)) add(p, [m]);
  }
  const ops = [];
  for (const [p, ms] of found) for (const method of ms) {
    const entry = { method, path: p, params: [], source: 'probe', request: { method, path: p } };
    if (MUTATING.has(method)) entry.skip = 'found by probing: no documented request body';
    ops.push(entry);
  }
  if (!ops.length) notes.push('no OpenAPI document and nothing found by probing: the surface of the service is unknown');
  return ops;
}

export async function operations(ctx, { call = apiCall } = {}) {
  const notes = [];
  const found = await findDocument(ctx, call, notes);
  if (found) return { operations: fromOpenApi(found.doc), notes, surfaceKnown: true, source: `openapi ${found.from}` };
  const ops = await probe(ctx, call, notes);
  return { operations: ops, notes, surfaceKnown: ops.length > 0, source: 'probe' };
}

// Reads a package's public surface: entry points from package.json, symbols from the type declarations (TypeScript compiler API),
// or from a real import when there are none. readSurface(ctx, { maxSymbols }) -> { package, version, entries, symbols, bin, libraryFirst, cut, notes }.
// surfaceMissing(a, b) -> the symbols of surface a that b lacks or whose type b's does not satisfy.
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { entryFile, runSteps } from './run.mjs';

const isFile = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };

function exportMap(pkg) {
  if (pkg.exports === undefined) return pkg.main || pkg.module || pkg.types ? { '.': pkg.main || 'index.js' } : { '.': 'index.js' };
  const ex = pkg.exports;
  if (typeof ex === 'string' || Array.isArray(ex) || !Object.keys(ex).some((k) => k.startsWith('.'))) return { '.': ex };
  return Object.fromEntries(Object.entries(ex).filter(([k]) => k === '.' || (k.startsWith('./') && !k.includes('*'))));
}

function typesCondition(v) {
  if (typeof v === 'string') return null;
  if (Array.isArray(v)) { for (const x of v) { const r = typesCondition(x); if (r) return r; } return null; }
  if (v && typeof v === 'object') {
    if (typeof v.types === 'string') return v.types;
    for (const k of Object.keys(v)) { const r = typesCondition(v[k]); if (r) return r; }
  }
  return null;
}

function findTypes(ctx, pkg, subpath, target, runtimeFile) {
  const cands = [];
  const t = typesCondition(target);
  if (t) cands.push(path.resolve(ctx.entryDir, t));
  if (subpath === '.') for (const k of ['types', 'typings']) if (typeof pkg[k] === 'string') cands.push(path.resolve(ctx.entryDir, pkg[k]));
  if (runtimeFile) {
    const b = runtimeFile.replace(/\.(m|c)?jsx?$/, '');
    cands.push(b + '.d.ts', b + '.d.mts', b + '.d.cts');
  }
  return cands.find(isFile) || null;
}

const hasMod = (n, k) => (ts.getCombinedModifierFlags?.(n) ?? 0) && n.modifiers?.some((m) => m.kind === k);
const docOf = (n) => {
  const d = ts.getJSDocCommentsAndTags(n).filter((x) => ts.isJSDoc(x)).map((x) => (typeof x.comment === 'string' ? x.comment : x.comment?.map((c) => c.text).join('') || '')).join(' ').trim();
  return d.replace(/\s+/g, ' ').slice(0, 300);
};
const tagsOf = (n) => ts.getJSDocTags(n);

function paramsOf(sf, ps) {
  return ps.map((p) => ({ name: p.name.getText(sf), type: p.type ? p.type.getText(sf) : 'any', optional: !!p.questionToken || !!p.initializer || !!p.dotDotDotToken }));
}

function describe(sf, name, decl, extra = {}) {
  const base = { name, doc: docOf(decl), ...extra };
  const dep = tagsOf(decl).find((t) => t.tagName.text === 'deprecated');
  const since = tagsOf(decl).find((t) => t.tagName.text === 'since');
  if (dep) base.deprecated = true;
  if (since) base.since = typeof since.comment === 'string' ? since.comment : '';
  const text = (n) => n.getText(sf).replace(/\s+/g, ' ').slice(0, 400);
  if (ts.isFunctionDeclaration(decl)) return { ...base, kind: 'function', signature: text(decl).replace(/\s*\{[\s\S]*$/, ';').replace(/^export\s+(default\s+)?(declare\s+)?/, ''), params: paramsOf(sf, decl.parameters) };
  if (ts.isClassDeclaration(decl)) {
    const ctor = decl.members.find((m) => ts.isConstructorDeclaration(m));
    const members = decl.members.filter((m) => (ts.isMethodDeclaration(m) || ts.isPropertyDeclaration(m)) && m.name && !m.modifiers?.some((x) => x.kind === ts.SyntaxKind.PrivateKeyword || x.kind === ts.SyntaxKind.ProtectedKeyword)).map((m) => m.name.getText(sf));
    return { ...base, kind: 'class', signature: `class ${name}`, params: ctor ? paramsOf(sf, ctor.parameters) : [], members };
  }
  if (ts.isInterfaceDeclaration(decl) || ts.isTypeAliasDeclaration(decl)) return { ...base, kind: 'type', signature: text(decl).replace(/^export\s+(declare\s+)?/, '').slice(0, 400) };
  if (ts.isEnumDeclaration(decl)) return { ...base, kind: 'enum', signature: `enum ${name}` };
  if (ts.isVariableDeclaration(decl)) {
    const ty = decl.type;
    const fn = ty && (ts.isFunctionTypeNode(ty));
    return { ...base, kind: fn ? 'function' : 'const', signature: `const ${name}: ${ty ? ty.getText(sf).replace(/\s+/g, ' ').slice(0, 300) : 'unknown'}`, ...(fn ? { params: paramsOf(sf, ty.parameters) } : {}) };
  }
  return { ...base, kind: 'unknown', signature: name };
}

// Exported symbols of a declaration file, following `export * from` and `export { x } from` into relative files.
function symbolsFromDts(file, seen = new Set()) {
  if (seen.has(file)) return [];
  seen.add(file);
  const sf = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const local = new Map(); // name -> [decl]
  const add = (n, d) => { if (!local.has(n)) local.set(n, []); local.get(n).push(d); };
  const exported = [];
  const resolveRel = (spec) => {
    const b = path.resolve(path.dirname(file), spec.replace(/\.(m|c)?jsx?$/, ''));
    return [b + '.d.ts', b + '.d.mts', b + '.d.cts', path.join(b, 'index.d.ts')].find(isFile);
  };
  const isExp = (n) => n.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
  const isDef = (n) => n.modifiers?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword);
  for (const st of sf.statements) {
    if (ts.isFunctionDeclaration(st) || ts.isClassDeclaration(st) || ts.isInterfaceDeclaration(st) || ts.isTypeAliasDeclaration(st) || ts.isEnumDeclaration(st)) {
      const name = isDef(st) ? 'default' : st.name?.text;
      if (!name) continue;
      add(st.name?.text || name, st);
      if (isExp(st)) exported.push({ name, decl: st });
    } else if (ts.isVariableStatement(st)) {
      for (const d of st.declarationList.declarations) if (ts.isIdentifier(d.name)) { add(d.name.text, d); if (isExp(st)) exported.push({ name: d.name.text, decl: d }); }
    } else if (ts.isExportAssignment(st)) {
      exported.push({ name: 'default', ref: ts.isIdentifier(st.expression) ? st.expression.text : null, node: st });
    } else if (ts.isExportDeclaration(st)) {
      const spec = st.moduleSpecifier && ts.isStringLiteral(st.moduleSpecifier) ? st.moduleSpecifier.text : null;
      const target = spec && spec.startsWith('.') ? resolveRel(spec) : null;
      if (!st.exportClause) { if (target) for (const s of symbolsFromDts(target, seen)) exported.push({ done: s }); }
      else if (ts.isNamedExports(st.exportClause)) {
        const sub = target ? symbolsFromDts(target, seen) : null;
        for (const el of st.exportClause.elements) {
          const orig = (el.propertyName || el.name).text;
          if (sub) { const s = sub.find((x) => x.name === orig); exported.push({ done: s ? { ...s, name: el.name.text } : { name: el.name.text, kind: 'unknown', signature: el.name.text, doc: '' } }); }
          else exported.push({ name: el.name.text, ref: orig, node: el });
        }
      }
    }
  }
  const out = [];
  for (const e of exported) {
    if (e.done) { out.push(e.done); continue; }
    if (e.decl) { out.push(describe(sf, e.name, e.decl)); continue; }
    const decls = local.get(e.ref);
    if (decls?.length) out.push(describe(sf, e.name, decls.find((d) => !ts.isInterfaceDeclaration(d) && !ts.isTypeAliasDeclaration(d)) || decls[0]));
    else out.push({ name: e.name, kind: 'unknown', signature: e.name, doc: '' });
  }
  // export = fn  (CommonJS declaration): named "default"
  for (const st of sf.statements) if (ts.isExportAssignment(st) && st.isExportEquals && ts.isIdentifier(st.expression)) {
    const decls = local.get(st.expression.text);
    if (decls?.length) out.push(describe(sf, 'default', decls[0]));
  }
  const byName = new Map();
  for (const s of out) if (!byName.has(s.name) || (byName.get(s.name).kind === 'type' && s.kind !== 'type')) byName.set(s.name, s);
  return [...byName.values()];
}

export async function readSurface(ctx, { maxSymbols = 200 } = {}) {
  const pkg = JSON.parse(fs.readFileSync(path.join(ctx.entryDir, 'package.json'), 'utf8'));
  const bin = pkg.bin ? (typeof pkg.bin === 'string' ? { [pkg.name]: pkg.bin } : pkg.bin) : null;
  const entries = [], symbols = [], notes = [];
  const typeFiles = [];
  for (const [subpath, target] of Object.entries(exportMap(pkg))) {
    let runtime = null;
    try { runtime = entryFile(ctx, subpath); } catch { /* a types-only subpath */ }
    const types = findTypes(ctx, pkg, subpath, target, runtime);
    entries.push({ subpath, file: runtime ? path.relative(ctx.entryDir, runtime).split(path.sep).join('/') : null, types: types ? path.relative(ctx.entryDir, types).split(path.sep).join('/') : null });
    if (types) {
      typeFiles.push(types);
      for (const s of symbolsFromDts(types)) symbols.push({ subpath, ...s, runtime: true });
    } else if (runtime) {
      const r = await runSteps(ctx, [{ list: true }], { subpath, timeoutMs: 15000 });
      const listed = r.results?.[0]?.ok ? r.results[0].returned : [];
      if (!r.results?.[0]?.ok) notes.push(`${subpath}: could not be imported to list its exports`);
      for (const x of listed) symbols.push({ subpath, name: x.name, kind: 'unknown', signature: x.name, doc: '', runtimeType: x.type, runtime: true });
      notes.push(`${subpath}: no type declarations, exports listed from a real import`);
    }
  }
  const cut = symbols.slice(maxSymbols).map((s) => `${s.subpath}:${s.name}`);
  const libraryFirst = !bin;
  if (bin) notes.push('package also has a bin: capture it with the CLI adapter first, the library surface is a second run');
  return { rootDir: ctx.entryDir, package: pkg.name || null, version: pkg.version || null, entries, symbols: symbols.slice(0, maxSymbols), bin, libraryFirst, cut, notes, typeFiles };
}

// Symbols of surface a that surface b lacks, or whose type is not assignable from b's. TypeScript packages only.
export function surfaceMissing(a, b) {
  const missing = [];
  const bKey = new Map(b.symbols.map((s) => [`${s.subpath}:${s.name}`, s]));
  const typed = [];
  for (const s of a.symbols) {
    const t = bKey.get(`${s.subpath}:${s.name}`);
    if (!t) { missing.push({ subpath: s.subpath, name: s.name, why: 'missing' }); continue; }
    if (s.kind !== t.kind) { missing.push({ subpath: s.subpath, name: s.name, why: `kind ${s.kind} became ${t.kind}` }); continue; }
    if (s.kind === 'function' || s.kind === 'class' || s.kind === 'const') typed.push(s);
  }
  const eA = a.entries.reduce((m, e) => (e.types ? { ...m, [e.subpath]: e.types } : m), {});
  const eB = b.entries.reduce((m, e) => (e.types ? { ...m, [e.subpath]: e.types } : m), {});
  const dirA = a.rootDir, dirB = b.rootDir;
  if (!dirA || !dirB) return missing;
  const lines = [], index = [];
  const spec = (dir, f) => JSON.stringify(path.resolve(dir, f).replace(/\.d\.(m|c)?ts$/, '').replace(/\\/g, '/'));
  const subs = [...new Set(typed.map((s) => s.subpath))].filter((sp) => eA[sp] && eB[sp]);
  subs.forEach((sp, i) => { lines.push(`import * as A${i} from ${spec(dirA, eA[sp])};`, `import * as B${i} from ${spec(dirB, eB[sp])};`); });
  typed.forEach((s) => {
    const i = subs.indexOf(s.subpath);
    if (i < 0) return;
    index.push(s);
    const n = /^[A-Za-z_$][\w$]*$/.test(s.name) ? `.${s.name}` : `[${JSON.stringify(s.name)}]`;
    lines.push(`export const v${index.length - 1}: typeof A${i}${n} = null as unknown as typeof B${i}${n};`);
  });
  if (!index.length) return missing;
  const virtual = path.join(dirA, '__surface_check__.ts');
  const opts = { noEmit: true, strict: true, skipLibCheck: true, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler, types: [] };
  const host = ts.createCompilerHost(opts);
  const rf = host.readFile.bind(host), fe = host.fileExists.bind(host), gs = host.getSourceFile.bind(host);
  const text = lines.join('\n');
  // Private members make a class nominal (two declarations of one class never match); they are not part of what callers can use.
  const stripPrivate = (t) => t.replace(/^[ \t]*(?:private|protected|#private)\b[^\n]*\n/gm, '');
  host.readFile = (f) => (f === virtual ? text : /\.d\.(m|c)?ts$/.test(f) ? (() => { const t = rf(f); return t === undefined ? t : stripPrivate(t); })() : rf(f));
  host.fileExists = (f) => f === virtual || fe(f);
  host.getSourceFile = (f, l, ...r) => (f === virtual ? ts.createSourceFile(f, text, l, true) : /\.d\.(m|c)?ts$/.test(f) ? (() => { const t = rf(f); return t === undefined ? undefined : ts.createSourceFile(f, stripPrivate(t), l, true); })() : gs(f, l, ...r));
  const program = ts.createProgram([virtual], opts, host);
  const sf = program.getSourceFile(virtual);
  const bad = new Set();
  for (const d of ts.getPreEmitDiagnostics(program, sf)) {
    if (d.file !== sf || d.start === undefined) continue;
    const line = sf.getLineAndCharacterOfPosition(d.start).line - subs.length * 2;
    if (line >= 0 && index[line]) bad.add(index[line]);
  }
  for (const s of bad) missing.push({ subpath: s.subpath, name: s.name, why: 'type not satisfied' });
  return missing;
}

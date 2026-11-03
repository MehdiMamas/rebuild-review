// Upstream base of a target: a fork, a framework or a template the app is built on. See AGENTS.md ("Upstream base").
//   node base.mjs detect <workDir> <runDir>   writes <runDir>/base.json { kind, upstream: {url, ref, commit} | null, evidence, ownPaths, ownLines, ownLineChanges }
//   node base.mjs pin <runDir> <url@ref|none> saves the user's answer as run.json "base" ("none" or {url, ref}); a pinned base wins over a detected one
// Evidence comes from code (git remotes, merge commits, manifests, vendored trees), never from a model.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readOwn, readOwnChanges, skipReason } from './size.mjs';
import { tryEmit } from './events.mjs';
export { readOwn, readOwnChanges };

const ENV = { ...process.env, GIT_ALLOW_PROTOCOL: 'file:https:http:git:ssh', GIT_TERMINAL_PROMPT: '0' };
const URL_OK = /^(https?:\/\/|file:\/\/|git:\/\/|ssh:\/\/|git@)/;
const SHA = /^[0-9a-f]{40}$/;

export function git(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: ENV, maxBuffer: 1 << 28 });
  return { ok: r.status === 0, out: (r.stdout || '').trim(), raw: r.stdout || '', err: (r.stderr || '').trim() };
}

const checkUrl = (url) => {
  if (typeof url !== 'string' || !URL_OK.test(url)) throw new Error(`base url "${url}" is not an https, git, ssh or file address`);
  return url;
};

// "url@ref" -> {url, ref}; the ref is what follows the last "@" of an address that has a path (so git@host:x/y.git@v1 works).
export function parsePin(text) {
  const t = String(text).trim();
  if (t.toLowerCase() === 'none') return 'none';
  const i = t.lastIndexOf('@');
  if (i <= 0 || i === t.length - 1 || t.lastIndexOf('/') > i) throw new Error(`"${t}" is not url@ref or none`);
  return { url: checkUrl(t.slice(0, i)), ref: t.slice(i + 1) };
}

const readRunBase = (runDir) => {
  try { return JSON.parse(fs.readFileSync(path.join(runDir, 'run.json'), 'utf8')).base; } catch { return undefined; }
};

export function readBase(runDir) {
  try { return JSON.parse(fs.readFileSync(path.join(runDir, 'base.json'), 'utf8')); } catch { return null; }
}

// Files of a rebuilt project that are not in its first commit (project/ starts as the base in one commit).
export function ownSince(projectDir) {
  const roots = git(projectDir, 'rev-list', '--max-parents=0', 'HEAD');
  if (!roots.ok || !roots.out) return null;
  const root = roots.out.split('\n').pop();
  const d = git(projectDir, 'diff', '--name-only', '-z', '--diff-filter=ACMR', root, 'HEAD');
  return d.ok ? new Set(d.raw.split('\0').filter(Boolean)) : null;
}

// Added plus deleted lines per path between two commits of a repo (git numstat, no rename detection). Binary and skipped files count 0.
// paths (a Set or array) limits the result; a path with no change is absent.
export function changedLines(repoDir, fromCommit, toRef, paths = null) {
  const r = git(repoDir, 'diff', '--numstat', '-z', '--no-renames', fromCommit, toRef);
  if (!r.ok) throw new Error(`cannot diff ${fromCommit} and ${toRef}: ${r.err}`);
  const want = paths ? new Set(paths) : null;
  const out = {};
  for (const e of r.raw.split('\0').filter(Boolean)) {
    const [a, d, ...rest] = e.split('\t');
    const p = rest.join('\t');
    if ((want && !want.has(p)) || skipReason(p) || !/^\d+$/.test(a) || !/^\d+$/.test(d)) continue;
    out[p] = Number(a) + Number(d);
  }
  return out;
}

// path -> blob hash of a commit's tree.
function treeBlobs(dir, commit) {
  const r = git(dir, 'ls-tree', '-r', '-z', commit);
  const m = new Map();
  if (!r.ok) throw new Error(`cannot read the tree of ${commit}: ${r.err}`);
  for (const e of r.raw.split('\0').filter(Boolean)) {
    const t = e.indexOf('\t');
    m.set(e.slice(t + 1), e.slice(0, t).split(' ')[2]);
  }
  return m;
}

// Shallow fetch of one commit of a public upstream into dest (a new folder), with a check that the commit is the one asked for.
export function fetchBase({ url, commit, dest }) {
  checkUrl(url);
  if (!SHA.test(commit)) throw new Error(`base commit "${commit}" is not a full commit hash`);
  fs.mkdirSync(dest, { recursive: true });
  const step = (...a) => { const r = git(dest, ...a); if (!r.ok) throw new Error(`git ${a[0]} of the base failed: ${r.err.slice(0, 200)}`); return r; };
  step('init', '-q');
  step('fetch', '--quiet', '--depth', '1', '--no-tags', '--', url, commit);
  step('checkout', '-q', '--detach', 'FETCH_HEAD');
  const head = step('rev-parse', 'HEAD').out;
  if (head !== commit) throw new Error(`the upstream gave commit ${head}, not the pinned ${commit}`);
  return dest;
}

// The base must not contain any commit of the target that is not upstream's, nor any own path with the target's content.
// baseDir is the fetched clone (with its .git). Returns the problems; empty means the wall holds.
export function checkWall({ workDir, baseDir, commit, ownPaths }) {
  const problems = [];
  const have = git(workDir, 'cat-file', '-e', `${commit}^{commit}`).ok;
  const own = git(workDir, 'rev-list', 'HEAD', ...(have ? ['--not', commit] : []));
  const heads = [...new Set([git(workDir, 'rev-parse', 'HEAD').out, ...(own.ok && own.out ? own.out.split('\n') : [])])].filter(Boolean);
  const r = spawnSync('git', ['-C', baseDir, 'cat-file', '--batch-check'], { input: heads.join('\n') + '\n', encoding: 'utf8', maxBuffer: 1 << 28 });
  const inBase = (r.stdout || '').split('\n').filter((l) => l && !l.endsWith(' missing')).length;
  if (inBase) problems.push(`the base contains ${inBase} of the target's own commits`);
  if (ownPaths && ownPaths.length) {
    const base = treeBlobs(baseDir, 'HEAD');
    const mine = new Map();
    for (const e of git(workDir, 'ls-files', '-s', '-z').raw.split('\0').filter(Boolean)) {
      const t = e.indexOf('\t');
      mine.set(e.slice(t + 1), e.slice(0, t).split(' ')[1]);
    }
    const same = ownPaths.filter((p) => base.has(p) && mine.get(p) === base.get(p));
    if (same.length) problems.push(`${same.length} own path(s) exist in the base with the target's content, for example ${same[0]}`);
  }
  return problems;
}

// ---- evidence ----
const normUrl = (u) => String(u || '').trim().replace(/^git\+/, '').replace(/^git@([^:]+):/, 'https://$1/').replace(/\.git$/, '').replace(/\/$/, '').toLowerCase();

function evidenceOf(workDir) {
  const ev = [];
  const origin = git(workDir, 'remote', 'get-url', 'origin');
  const up = git(workDir, 'remote', 'get-url', 'upstream');
  if (up.ok) ev.push(`git remote "upstream" points to ${up.out}`);
  const merges = git(workDir, 'log', '--merges', '--format=%s');
  const from = {};
  for (const s of merges.out.split('\n')) {
    const m = /remote-tracking branch '([\w.-]+)\/[^']+'/.exec(s);
    if (m && m[1] !== 'origin') from[m[1]] = (from[m[1]] || 0) + 1;
  }
  for (const [name, n] of Object.entries(from)) ev.push(`${n} merge commit(s) from the remote "${name}"`);
  let manifest = false;
  const pkg = path.join(workDir, 'package.json');
  if (fs.existsSync(pkg)) {
    try {
      const r = JSON.parse(fs.readFileSync(pkg, 'utf8')).repository;
      const url = typeof r === 'string' ? r : r && r.url;
      if (url && origin.ok && normUrl(url) !== normUrl(origin.out)) { ev.push(`package.json repository names ${url}, not this project's own remote`); manifest = true; }
    } catch { /* unreadable manifest */ }
  }
  const cargo = path.join(workDir, 'Cargo.toml');
  if (fs.existsSync(cargo)) {
    const m = /^\s*repository\s*=\s*"([^"]+)"/m.exec(fs.readFileSync(cargo, 'utf8'));
    if (m && origin.ok && normUrl(m[1]) !== normUrl(origin.out)) { ev.push(`Cargo.toml repository names ${m[1]}, not this project's own remote`); manifest = true; }
  }
  const files = git(workDir, 'ls-files', '-z').raw.split('\0').filter(Boolean);
  const vendored = new Set();
  const gm = path.join(workDir, '.gitmodules');
  if (fs.existsSync(gm)) for (const m of fs.readFileSync(gm, 'utf8').matchAll(/^\s*path\s*=\s*(.+)$/gm)) vendored.add(m[1].trim());
  for (const f of files) {
    const m = /^((?:.*\/)?(?:third_party|vendor|vendors)\/[^/]+)\/(LICEN[CS]E[^/]*|COPYING[^/]*)$/i.exec(f);
    if (m) vendored.add(m[1]);
  }
  for (const v of vendored) ev.push(`vendored tree ${v} has its own license or is a submodule`);
  return { ev, up, vendored: vendored.size > 0, manifest, merged: Object.keys(from).length > 0 };
}

// The newest commit of the "upstream" remote that is an ancestor of HEAD, with a tag or branch name for it.
function forkCommit(workDir) {
  const refs = git(workDir, 'for-each-ref', '--format=%(refname)', 'refs/remotes/upstream').out.split('\n').filter((r) => r && !r.endsWith('/HEAD'));
  let best = null;
  for (const ref of refs) {
    const mb = git(workDir, 'merge-base', 'HEAD', ref);
    if (!mb.ok || !mb.out) continue;
    const t = Number(git(workDir, 'show', '-s', '--format=%ct', mb.out).out);
    if (!best || t > best.t) best = { t, commit: mb.out, branch: ref.replace('refs/remotes/upstream/', '') };
  }
  if (!best) return null;
  const tag = git(workDir, 'describe', '--tags', '--exact-match', best.commit);
  return { commit: best.commit, ref: tag.ok && tag.out ? tag.out : best.branch };
}

function resolvePin(pin) {
  checkUrl(pin.url);
  if (SHA.test(pin.ref)) return pin.ref;
  const r = git(os.tmpdir(), 'ls-remote', '--', pin.url, pin.ref, `${pin.ref}^{}`);
  const lines = r.out.split('\n').filter(Boolean).map((l) => l.split(/\s+/));
  if (!r.ok || !lines.length) throw new Error(`cannot find ${pin.ref} in ${pin.url}`);
  const peeled = lines.find((l) => l[1].endsWith('^{}'));
  return (peeled || lines[0])[0];
}

// Files of the target (git-tracked) that are not in the upstream commit, or differ from it. The upstream commit is read from the work repo
// when it is there, else from a shallow fetch into a temporary folder.
// Also returns the changed lines of each own path against the base (see changedLines); a file that is new on top of the base counts all its lines.
function ownPathsOf(workDir, upstream) {
  let blobs, changes;
  const own = [];
  const ownOf = () => {
    for (const e of git(workDir, 'ls-files', '-s', '-z').raw.split('\0').filter(Boolean)) {
      const t = e.indexOf('\t');
      const p = e.slice(t + 1);
      if (blobs.get(p) !== e.slice(0, t).split(' ')[1]) own.push(p);
    }
  };
  if (git(workDir, 'cat-file', '-e', `${upstream.commit}^{commit}`).ok) {
    blobs = treeBlobs(workDir, upstream.commit);
    ownOf();
    changes = changedLines(workDir, upstream.commit, 'HEAD', own);
  } else {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-base-'));
    try {
      fetchBase({ url: upstream.url, commit: upstream.commit, dest: tmp });
      blobs = treeBlobs(tmp, 'HEAD');
      ownOf();
      changes = {};
      for (const p of own) {
        if (skipReason(p)) continue;
        const mine = path.join(workDir, p);
        let n;
        if (blobs.has(p)) {
          const r = git(workDir, 'diff', '--no-index', '--numstat', '--', path.join(tmp, p), mine);
          const m = /^(\d+)\t(\d+)\t/.exec(r.out);
          if (!m) continue; // binary, unreadable or identical
          n = Number(m[1]) + Number(m[2]);
        } else {
          let text;
          try { text = fs.readFileSync(mine, 'utf8'); } catch { continue; }
          n = text === '' ? 0 : text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
        }
        if (n) changes[p] = n;
      }
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  }
  return { own, changes };
}

export function detect(workDir, runDir) {
  const pin = readRunBase(runDir);
  const { ev, up, vendored, manifest, merged } = evidenceOf(workDir);
  let kind = 'none', upstream = null;
  const evidence = [...ev];
  if (pin === 'none') {
    evidence.unshift('pinned in run.json: no base');
  } else if (pin && typeof pin === 'object') {
    upstream = { url: checkUrl(pin.url), ref: pin.ref, commit: resolvePin(pin) };
    kind = up.ok ? 'fork' : vendored ? 'framework' : manifest || merged ? 'template' : 'fork';
    evidence.unshift(`pinned in run.json: ${pin.url}@${pin.ref}`);
  } else {
    const fc = up.ok ? forkCommit(workDir) : null;
    if (fc) { kind = 'fork'; upstream = { url: up.out, ref: fc.ref, commit: fc.commit }; }
    else if (up.ok) { kind = 'fork'; evidence.push('the upstream remote has no fetched commit that HEAD builds on'); }
    else if (vendored) kind = 'framework';
    else if (manifest || merged) kind = 'template';
  }
  if (pin === 'none') { kind = 'none'; upstream = null; }
  let ownPaths = null, ownLines = null, ownLineChanges = null;
  if (upstream) {
    const o = ownPathsOf(workDir, upstream);
    ownPaths = o.own;
    ownLineChanges = o.changes;
    ownLines = Object.values(ownLineChanges).reduce((n, c) => n + c, 0);
  }
  const out = { kind, upstream, evidence, ownPaths, ownLines, ownLineChanges };
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, 'base.json'), JSON.stringify(out, null, 2));
  return out;
}

export function summary(b) {
  if (!b || b.kind === 'none') return 'no base found';
  const u = b.upstream ? `${b.upstream.url} at ${b.upstream.ref} (${b.upstream.commit.slice(0, 12)}); own code: ${b.ownPaths.length} files, ${b.ownLines} changed lines` : 'no upstream commit could be pinned';
  return `${b.kind}: ${u}. Evidence: ${b.evidence.join('; ') || 'none'}`;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [cmd, a, b] = process.argv.slice(2);
  try {
    if (cmd === 'detect' && a && b) console.log(summary(detect(path.resolve(a), path.resolve(b))));
    else if (cmd === 'pin' && a && b) {
      const f = path.join(path.resolve(a), 'run.json');
      let run = {};
      try { run = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { /* no run.json yet */ }
      run.base = parsePin(b);
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, JSON.stringify(run, null, 2) + '\n');
      console.log(`run.json base: ${JSON.stringify(run.base)}`);
      tryEmit(path.resolve(a), { kind: 'decision', what: 'base', choice: run.base === 'none' ? 'none' : `${run.base.url}@${run.base.ref}`, reason: 'pinned' });
    } else { console.error('usage: base.mjs detect <workDir> <runDir> | pin <runDir> <url@ref|none>'); process.exit(2); }
  } catch (e) { console.error(String(e.message || e)); process.exit(1); }
}

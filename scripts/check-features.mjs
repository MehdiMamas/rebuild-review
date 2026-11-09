// No-source check for features.md. Usage: node check-features.mjs <features.md> <workDir>
// Exits 1 and prints one line per problem when the file holds fenced code, source file paths,
// import or JSX-like lines, or a run of 40+ characters that contain code copied from a tracked text file in workDir.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

const RUN = 40;
const EXT = 'jsx?|tsx?|mjs|cjs|vue|svelte|py|rb|go|rs|java|kt|swift|cs|cpp|c|h|php|scss|css|sh';
const PATH_RE = new RegExp(`(?:^|[\\s\`'"(])[\\w@.-]*(?:/[\\w@.-]+)*[\\w-]\\.(?:${EXT})(?=$|[\\s\`'")\\]:,;.])`, 'i');
const PRODUCT_NAMES = /(?<![\w/.-])(?:Node|Next|Nuxt|Vue|Three|D3|Express)\.js\b/g;
const CODE_LINE_RES = [
  /^\s*import\s+[\w{*].*\sfrom\s+['"]/,
  /^\s*import\s+['"]/,
  /^\s*(?:export\s+(?:default|const|function|class)|const\s+\w+\s*=|let\s+\w+\s*=|function\s+\w+\s*\()/,
  /^\s*<\/?[A-Za-z][\w.]*(?:\s[^>]*)?\/?>/,
  /\w+=\{[^}]*\}/,
  /\/>\s*$/,
];

export function norm(s) {
  return s.replace(/\s+/g, ' ').trim();
}

// True when a 40-char window holds code: braces, `=>`, `::`, `&&`, `||`, `==`, a `;` after a closing
// bracket or quote, a call like `reduce(` (a plural like `item(s)` is not a call), or an assignment like `width = 100`
// (not inside a markdown link). Prose like "item(s)" or "one; two" is not code.
export function looksLikeCode(window) {
  if (/[{}]|=>|::|&&|\|\||==|[)\]'"`]\s*;/.test(window)) return true;
  if (/\w\((?!(?:s|es)\))/.test(window)) return true;
  return /\w\s*=\s*[\w'"\[{(]/.test(window.replace(/\[[^\]]*\]\([^)]*\)/g, ''));
}

export function checkText(text, srcTexts = []) {
  const problems = [];
  const lines = text.split('\n');
  lines.forEach((line, i) => {
    const n = i + 1;
    if (/^\s*(```|~~~)/.test(line)) problems.push(`line ${n}: fenced code block`);
    else {
      if (PATH_RE.test(line.replace(PRODUCT_NAMES, ''))) problems.push(`line ${n}: source file path`);
      if (CODE_LINE_RES.some((re) => re.test(line))) problems.push(`line ${n}: import or JSX-like line`);
    }
  });
  const t = norm(text);
  if (t.length >= RUN && srcTexts.length) {
    const grams = new Map();
    for (let i = 0; i + RUN <= t.length; i++) grams.set(t.slice(i, i + RUN), i);
    for (const { name, content } of srcTexts) {
      const c = norm(content);
      for (let i = 0; i + RUN <= c.length; i++) {
        const w = c.slice(i, i + RUN);
        if (grams.has(w) && looksLikeCode(w)) {
          problems.push(`copied from ${name}: "${w}"`);
          break;
        }
      }
    }
  }
  return problems;
}

const CACHE_CAP = 2 * 1024 ** 3;

// Remove .tmp files older than one hour, then the oldest cache files until the folder is at or under cap bytes.
// The file named keep (the one just written) is never removed.
export function trimCache(dir, cap = CACHE_CAP, keep = null) {
  let files;
  let names;
  try { names = fs.readdirSync(dir); } catch { return; }
  files = [];
  for (const n of names) {
    const p = path.join(dir, n);
    try { const st = fs.statSync(p); files.push({ p, size: st.size, t: st.mtimeMs }); } catch { /* another run removed it */ }
  }
  const now = Date.now();
  files = files.filter((f) => {
    if (f.p.endsWith('.tmp') && now - f.t > 3600 * 1000) { try { fs.rmSync(f.p, { force: true }); } catch { /* gone already */ } return false; }
    return true;
  });
  let total = files.reduce((a, f) => a + f.size, 0);
  for (const f of files.sort((a, b) => a.t - b.t)) {
    if (total <= cap) break;
    if (keep && path.resolve(f.p) === path.resolve(keep)) continue;
    try { fs.rmSync(f.p, { force: true }); total -= f.size; } catch { /* another run removed it */ }
  }
}

const FILE_CAP = 256 * 1024 ** 2;

// The cache is used only when it is ours: a real folder (not a link) owned by this user, closed to others, and a
// cache file that is a regular file owned by this user. Another user's planted folder or file is never read.
const mine = (st) => typeof process.getuid !== 'function' || st.uid === process.getuid();
export function cacheDirSafe(dir) {
  try {
    const st = fs.lstatSync(dir);
    if (!st.isDirectory() || !mine(st)) return false;
    if (process.platform !== 'win32' && (st.mode & 0o077)) fs.chmodSync(dir, 0o700);
    return true;
  } catch { return false; }
}
const cacheFileSafe = (f) => { try { const st = fs.lstatSync(f); return st.isFile() && mine(st); } catch { return false; } };

// Texts of the tracked files. With a clean tracked tree the result is cached by folder and HEAD in the temp folder
// (shared by the CLI and room.mjs). opts.onCache gets 'hit' or 'miss'; opts.cacheDir and opts.cap are for tests.
export function trackedTexts(workDir, opts = {}) {
  const git = (...args) => execFileSync('git', args, { cwd: workDir, maxBuffer: 1 << 30 }).toString();
  const cacheDir = opts.cacheDir || path.join(os.tmpdir(), 'rebuild-review-texts' + (typeof process.getuid === 'function' ? '-' + process.getuid() : ''));
  let cacheFile = null;
  try {
    if (git('status', '--porcelain', '--untracked-files=no').trim() === '') {
      const key = crypto.createHash('sha256').update(fs.realpathSync(workDir) + '\0' + git('rev-parse', 'HEAD').trim()).digest('hex');
      cacheFile = path.join(cacheDir, key + '.json');
    }
  } catch { cacheFile = null; }
  if (cacheFile && cacheDirSafe(cacheDir) && cacheFileSafe(cacheFile)) {
    try {
      const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
      if (opts.onCache) opts.onCache('hit');
      return cached;
    } catch (e) {
      // a file that does not parse is deleted; the texts are then read fresh
      if (e instanceof SyntaxError) { try { fs.rmSync(cacheFile, { force: true }); } catch { /* gone already */ } }
    }
  }
  if (opts.onCache) opts.onCache('miss');
  const files = git('ls-files', '-z').split('\0').filter(Boolean);
  const out = [];
  for (const f of files) {
    let buf;
    try { buf = fs.readFileSync(path.join(workDir, f)); } catch { continue; }
    if (buf.includes(0)) continue;
    out.push({ name: f, content: buf.toString('utf8') });
  }
  if (cacheFile) {
    let written = null;
    try {
      fs.mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
      if (!cacheDirSafe(cacheDir)) throw new Error('cache folder is not ours');
      const json = JSON.stringify(out);
      if (Buffer.byteLength(json) <= FILE_CAP) {
        const tmp = `${cacheFile}.${process.pid}.${Date.now()}.tmp`;
        fs.writeFileSync(tmp, json, { mode: 0o600 });
        fs.renameSync(tmp, cacheFile);
        written = cacheFile;
      }
    } catch { /* the cache is optional */ }
    if (cacheDirSafe(cacheDir)) trimCache(cacheDir, opts.cap, written);
  }
  return out;
}

if (process.argv[1] && path.resolve(process.argv[1]) === new URL(import.meta.url).pathname) {
  const [feat, work] = process.argv.slice(2);
  if (!feat || !work) { console.error('usage: check-features.mjs <features.md> <workDir>'); process.exit(2); }
  const problems = checkText(fs.readFileSync(feat, 'utf8'), trackedTexts(work));
  if (problems.length) { console.log(problems.map((p) => 'FAIL ' + p).join('\n')); process.exit(1); }
  console.log('OK no source found');
}

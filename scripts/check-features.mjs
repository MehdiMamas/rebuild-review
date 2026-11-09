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

// True when a 40-char window holds code: braces, `;`, `=>`, `::`, `&&`, `||`, `==`, a call like
// `reduce(`, or an assignment like `width = 100` (not inside a markdown link).
export function looksLikeCode(window) {
  if (/[{};]|=>|::|&&|\|\||==/.test(window)) return true;
  if (/\w\(/.test(window)) return true;
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

// Remove the oldest cache files until the folder is at or under cap bytes.
export function trimCache(dir, cap = CACHE_CAP) {
  let files;
  try { files = fs.readdirSync(dir).map((n) => { const p = path.join(dir, n); const st = fs.statSync(p); return { p, size: st.size, t: st.mtimeMs }; }); } catch { return; }
  let total = files.reduce((a, f) => a + f.size, 0);
  for (const f of files.sort((a, b) => a.t - b.t)) {
    if (total <= cap) break;
    try { fs.rmSync(f.p, { force: true }); total -= f.size; } catch { /* another run removed it */ }
  }
}

// Texts of the tracked files. With a clean tracked tree the result is cached by folder and HEAD in the temp folder
// (shared by the CLI and room.mjs). opts.onCache gets 'hit' or 'miss'; opts.cacheDir and opts.cap are for tests.
export function trackedTexts(workDir, opts = {}) {
  const git = (...args) => execFileSync('git', args, { cwd: workDir, maxBuffer: 1 << 30 }).toString();
  const cacheDir = opts.cacheDir || path.join(os.tmpdir(), 'rebuild-review-texts');
  let cacheFile = null;
  try {
    if (git('status', '--porcelain', '--untracked-files=no').trim() === '') {
      const key = crypto.createHash('sha256').update(fs.realpathSync(workDir) + '\0' + git('rev-parse', 'HEAD').trim()).digest('hex');
      cacheFile = path.join(cacheDir, key + '.json');
    }
  } catch { cacheFile = null; }
  if (cacheFile) {
    try {
      const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
      if (opts.onCache) opts.onCache('hit');
      return cached;
    } catch { /* no usable cache */ }
  }
  if (opts.onCache) opts.onCache('miss');
  const files = git('ls-files', '-z').split('\0').filter(Boolean);
  const out = [];
  for (const f of files) {
    let buf;
    try { buf = fs.readFileSync(path.join(workDir, f)); } catch { continue; }
    if (buf.includes(0)) continue;
    out.push({ name: f, content: norm(buf.toString('utf8')) });
  }
  if (cacheFile) {
    try {
      fs.mkdirSync(cacheDir, { recursive: true });
      const tmp = `${cacheFile}.${process.pid}.${Date.now()}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(out));
      fs.renameSync(tmp, cacheFile);
      trimCache(cacheDir, opts.cap);
    } catch { /* the cache is optional */ }
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

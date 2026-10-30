// No-source check for features.md. Usage: node check-features.mjs <features.md> <workDir>
// Exits 1 and prints one line per problem when the file holds fenced code, source file paths,
// import or JSX-like lines, or a run of 40+ characters copied from a tracked text file in workDir.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const RUN = 40;
const EXT = 'jsx?|tsx?|mjs|cjs|vue|svelte|py|rb|go|rs|java|kt|swift|cs|cpp|c|h|php|scss|css|sh';
const PATH_RE = new RegExp(`(?:^|[\\s\`'"(])[\\w@.-]*(?:/[\\w@.-]+)*[\\w-]\\.(?:${EXT})(?=$|[\\s\`'")\\]:,;.])`, 'i');
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

export function checkText(text, srcTexts = []) {
  const problems = [];
  const lines = text.split('\n');
  lines.forEach((line, i) => {
    const n = i + 1;
    if (/^\s*(```|~~~)/.test(line)) problems.push(`line ${n}: fenced code block`);
    else {
      if (PATH_RE.test(line)) problems.push(`line ${n}: source file path`);
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
        if (grams.has(c.slice(i, i + RUN))) {
          problems.push(`copied from ${name}: "${c.slice(i, i + RUN)}"`);
          break;
        }
      }
    }
  }
  return problems;
}

export function trackedTexts(workDir) {
  const files = execFileSync('git', ['ls-files', '-z'], { cwd: workDir }).toString().split('\0').filter(Boolean);
  const out = [];
  for (const f of files) {
    let buf;
    try { buf = fs.readFileSync(path.join(workDir, f)); } catch { continue; }
    if (buf.includes(0)) continue;
    out.push({ name: f, content: buf.toString('utf8') });
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

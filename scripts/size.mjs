// Size of a target: node scripts/size.mjs <workDir> <runDir> writes <runDir>/size.json { size, plan }.
// measure(workDir) counts source lines of git-tracked files; plan(size, scale) turns that into budgets and caps.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const LANGUAGES = {
  '.js': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript', '.jsx': 'javascript',
  '.ts': 'typescript', '.tsx': 'typescript', '.vue': 'vue', '.svelte': 'svelte',
  '.py': 'python', '.rb': 'ruby', '.go': 'go', '.rs': 'rust', '.java': 'java', '.kt': 'kotlin',
  '.swift': 'swift', '.c': 'c', '.h': 'c', '.cc': 'cpp', '.cpp': 'cpp', '.hpp': 'cpp', '.cs': 'csharp',
  '.php': 'php', '.dart': 'dart', '.scala': 'scala', '.sh': 'shell',
  '.css': 'css', '.scss': 'css', '.less': 'css', '.html': 'html', '.sql': 'sql',
};
const LOCK_FILES = new Set(['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lockb', 'bun.lock', 'Cargo.lock', 'Gemfile.lock', 'poetry.lock', 'composer.lock', 'go.sum', 'Podfile.lock', 'Pipfile.lock']);
const VENDORED = /(^|\/)(node_modules|vendor|vendors|third_party|bower_components|Pods)\//;
const GENERATED = /(^|\/)(dist|build|out|coverage|\.next|\.nuxt|__generated__|generated)\/|\.min\.(js|css)$|\.map$|\.generated\.|\.pb\.go$|_pb2\.py$/;

export function skipReason(file) {
  if (LOCK_FILES.has(path.basename(file))) return 'lock file';
  if (VENDORED.test(file)) return 'vendored';
  if (GENERATED.test(file)) return 'generated';
  if (!LANGUAGES[path.extname(file).toLowerCase()]) return 'not source';
  return null;
}

const countLines = (text) => (text.length === 0 ? 0 : text.split('\n').length - (text.endsWith('\n') ? 1 : 0));

export function measure(workDir) {
  const files = execFileSync('git', ['ls-files', '-z'], { cwd: workDir, maxBuffer: 1 << 28 }).toString().split('\0').filter(Boolean);
  const byLanguage = {}, skipped = [];
  let lines = 0, counted = 0;
  for (const f of files) {
    const reason = skipReason(f);
    if (reason) { skipped.push({ path: f, reason }); continue; }
    let text;
    try { text = fs.readFileSync(path.join(workDir, f), 'utf8'); } catch { skipped.push({ path: f, reason: 'unreadable' }); continue; }
    const n = countLines(text), lang = LANGUAGES[path.extname(f).toLowerCase()];
    byLanguage[lang] = (byLanguage[lang] || 0) + n;
    lines += n; counted++;
  }
  return { files: files.length, counted, lines, byLanguage, skipped };
}

export function plan(size, scale) {
  const units = Math.max(1, Math.ceil(size.lines / scale.unitLines));
  const { floors: f, perUnit: p } = scale;
  return {
    units,
    buildUsd: Math.max(f.buildUsd, units * p.buildUsd),
    stackUsd: f.stackUsd,
    loopUsd: Math.max(f.loopUsd, units * p.loopUsd),
    maxScreens: Math.max(f.screens, units * p.screens),
    maxButtons: Math.max(f.buttons, units * p.buttons),
    estimateUsd: { low: units * p.costLowUsd, high: units * p.costHighUsd },
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === new URL(import.meta.url).pathname) {
  const [workDir, runDir] = process.argv.slice(2);
  if (!workDir || !runDir) { console.error('usage: node scripts/size.mjs <workDir> <runDir>'); process.exit(2); }
  const scale = JSON.parse(fs.readFileSync(new URL('../scale.json', import.meta.url), 'utf8'));
  const size = measure(path.resolve(workDir));
  const out = { size, plan: plan(size, scale) };
  fs.mkdirSync(path.resolve(runDir), { recursive: true });
  fs.writeFileSync(path.join(path.resolve(runDir), 'size.json'), JSON.stringify(out, null, 2));
  console.log(`${size.lines} source lines in ${size.counted} files (${size.skipped.length} skipped) -> ${out.plan.units} unit(s), build $${out.plan.buildUsd}, ${out.plan.maxScreens} screens`);
}

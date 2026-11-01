// Size of a target: node scripts/size.mjs <workDir> <runDir> [--max-usd N] writes <runDir>/size.json { size, plan }.
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

// Every git-tracked file, split into counted source files (path, language, lines) and skipped ones with a reason.
export function scan(workDir) {
  const files = execFileSync('git', ['ls-files', '-z'], { cwd: workDir, maxBuffer: 1 << 28 }).toString().split('\0').filter(Boolean);
  const counted = [], skipped = [];
  for (const f of files) {
    const reason = skipReason(f);
    if (reason) { skipped.push({ path: f, reason }); continue; }
    let text;
    try { text = fs.readFileSync(path.join(workDir, f), 'utf8'); } catch { skipped.push({ path: f, reason: 'unreadable' }); continue; }
    counted.push({ path: f, lang: LANGUAGES[path.extname(f).toLowerCase()], lines: countLines(text) });
  }
  return { files: files.length, counted, skipped };
}

export function measure(workDir) {
  const { files, counted, skipped } = scan(workDir);
  const byLanguage = {};
  let lines = 0;
  for (const c of counted) { byLanguage[c.lang] = (byLanguage[c.lang] || 0) + c.lines; lines += c.lines; }
  return { files, counted: counted.length, lines, byLanguage, skipped };
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

const loadScale = () => JSON.parse(fs.readFileSync(new URL('../scale.json', import.meta.url), 'utf8'));

// The plan written by the CLI for this run; with no size.json yet (or an unreadable one) the floors, which are today's fixed limits.
export function readPlan(runDir) {
  try { return JSON.parse(fs.readFileSync(path.join(runDir, 'size.json'), 'utf8')).plan; } catch { /* no size yet */ }
  return plan({ lines: 0 }, loadScale());
}

export const estimateText = (p) => `estimated cost $${p.estimateUsd.low} to $${p.estimateUsd.high} for ${p.units} unit(s) of source`;

// A run needs maxUsd at or above the high estimate. Returns { ok, reason }.
export function checkBudget(p, maxUsd) {
  const { high } = p.estimateUsd;
  const est = estimateText(p);
  if (!(Number(maxUsd) > 0)) return { ok: false, reason: `no maxUsd given; ${est}. Nothing was spent. Ask again with maxUsd of at least ${high}.` };
  if (Number(maxUsd) < high) return { ok: false, reason: `maxUsd ${maxUsd} is below the high estimate; ${est}. Nothing was spent. Ask again with maxUsd of at least ${high}.` };
  return { ok: true, reason: est };
}

// Actual spend per phase, <runDir>/cost.json: { phases: { <Phase>: { usd, runs } }, totalUsd }.
export function addCost(runDir, phase, usd) {
  const f = path.join(runDir, 'cost.json');
  let c = { phases: {}, totalUsd: 0 };
  try { c = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { /* first entry */ }
  const e = c.phases[phase] || { usd: 0, runs: 0 };
  c.phases[phase] = { usd: e.usd + usd, runs: e.runs + 1 };
  c.totalUsd = Object.values(c.phases).reduce((a, x) => a + x.usd, 0);
  fs.writeFileSync(f, JSON.stringify(c, null, 2));
  return c;
}

if (process.argv[1] && path.resolve(process.argv[1]) === new URL(import.meta.url).pathname) {
  const argv = process.argv.slice(2), mi = argv.indexOf('--max-usd');
  const maxUsd = mi >= 0 ? argv[mi + 1] : undefined;
  if (mi >= 0) argv.splice(mi, 2);
  const [workDir, runDir] = argv;
  if (!workDir || !runDir) { console.error('usage: node scripts/size.mjs <workDir> <runDir> [--max-usd N]'); process.exit(2); }
  const scale = loadScale();
  const size = measure(path.resolve(workDir));
  const out = { size, plan: plan(size, scale) };
  fs.mkdirSync(path.resolve(runDir), { recursive: true });
  fs.writeFileSync(path.join(path.resolve(runDir), 'size.json'), JSON.stringify(out, null, 2));
  console.log(`${size.lines} source lines in ${size.counted} files (${size.skipped.length} skipped) -> ${out.plan.units} unit(s), build $${out.plan.buildUsd}, ${out.plan.maxScreens} screens`);
  if (mi < 0) console.log(estimateText(out.plan));
  else {
    const est = checkBudget(out.plan, maxUsd);
    console.log(est.reason);
    if (!est.ok) process.exit(3);
  }
}

#!/usr/bin/env node
// Prepares a finished run folder to redo its last phases without a rebuild.
//   node scripts/rerun.mjs <runDir> --from Parity|Score|Report [--no-build]
// Removes <Phase>.done for the named phase and every later one, moves the results of those phases to <runDir>/previous-<n>/,
// and with --no-build writes NoBuild.done (the workflow then skips the estimate and never starts a build round).
// Exit 2 with a plain reason and nothing changed when the run folder cannot be rerun.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { emit } from './events.mjs';

// Same list and order as PHASES in workflows/rebuild-review.js (a test compares them).
export const PHASES = ['Capture', 'Inventory', 'Stack', 'Rebuild', 'Parity', 'Score', 'Report'];
export const FROM = ['Parity', 'Score', 'Report'];
const KEEP_IN_PARITY = (n) => n === 'tests' || n === 'areas' || n === 'removed' || /^untested.*\.md$/.test(n) || n.startsWith('previous-');

const USAGE = 'usage: node scripts/rerun.mjs <runDir> --from Parity|Score|Report [--no-build]';
export class Refusal extends Error {}
const refuse = (m) => { throw new Refusal(m); };
const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
const isFile = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };
const exists = (p) => { try { fs.lstatSync(p); return true; } catch { return false; } };
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

// Checks everything, then moves in one pass (rolled back on failure), then removes markers.
export function rerun(runDirArg, from, noBuild = false) {
  if (!runDirArg) refuse(USAGE);
  if (!FROM.includes(from)) refuse(`--from must be one of ${FROM.join(', ')}, got ${from === undefined ? 'nothing' : from}. ${USAGE}`);
  let runDir;
  try { runDir = fs.realpathSync(runDirArg); } catch { refuse(`run folder not found: ${runDirArg}`); }
  if (!isDir(runDir) || !isFile(path.join(runDir, 'run.json'))) refuse(`${runDirArg} is not a run folder (no run.json)`);

  const need = [['Rebuild.done', isFile], ['project/rebuild-run.json', isFile], ['features.md', isFile], ['golden', isDir]];
  if (from !== 'Parity') need.push(['parity/parity.json', isFile]);
  const missing = need.filter(([n, ok]) => !ok(path.join(runDir, n))).map(([n]) => n);
  if (missing.length) refuse(`cannot rerun: missing ${missing.join(', ')}`);

  const longDir = path.join(runDir, 'long');
  if (isDir(longDir)) {
    for (const f of fs.readdirSync(longDir).filter((x) => x.endsWith('.pid'))) {
      const name = f.slice(0, -4);
      const pid = Number(fs.readFileSync(path.join(longDir, f), 'utf8').trim()) || 0;
      if (pid && alive(pid) && !exists(path.join(longDir, `${name}.exit`))) refuse(`cannot rerun: the command "${name}" is still running (pid ${pid})`);
    }
  }

  const sources = [];
  if (from === 'Parity') {
    const par = path.join(runDir, 'parity');
    if (isDir(par)) for (const n of fs.readdirSync(par).sort()) if (!KEEP_IN_PARITY(n)) sources.push(['parity', n]);
    if (exists(path.join(runDir, 'golden-rebuild'))) sources.push(['golden-rebuild']);
  }
  if (from === 'Parity' || from === 'Score') if (exists(path.join(runDir, 'score'))) sources.push(['score']);
  if (exists(path.join(runDir, 'report'))) sources.push(['report']);

  let previous = null;
  const moved = [];
  if (sources.length) {
    const highest = fs.readdirSync(runDir).map((n) => /^previous-(\d+)$/.exec(n)).filter(Boolean).reduce((m, x) => Math.max(m, Number(x[1])), 0);
    previous = `previous-${highest + 1}`;
    const pdir = path.join(runDir, previous);
    const done = [];
    try {
      fs.mkdirSync(pdir);
      for (const parts of sources) {
        const dest = path.join(pdir, ...parts);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.renameSync(path.join(runDir, ...parts), dest);
        done.push([path.join(runDir, ...parts), dest]);
      }
    } catch (e) {
      for (const [src, dest] of done.reverse()) fs.renameSync(dest, src);
      fs.rmSync(pdir, { recursive: true, force: true });
      refuse(`cannot rerun: moving ${e.path || 'results'} failed (${e.code || e.message}); nothing was changed`);
    }
    moved.push(...sources.map((p) => p.join('/')));
  }

  const removed = [];
  for (const p of PHASES.slice(PHASES.indexOf(from))) {
    const f = path.join(runDir, `${p}.done`);
    if (exists(f)) { fs.rmSync(f); removed.push(`${p}.done`); }
  }
  const nb = path.join(runDir, 'NoBuild.done');
  if (noBuild) fs.writeFileSync(nb, 'rerun without a rebuild\n');
  else if (exists(nb)) { fs.rmSync(nb); removed.push('NoBuild.done'); }

  emit(runDir, { kind: 'phase', phase: from, state: 'start', reason: `rerun from ${from}${noBuild ? ' without a rebuild' : ''}` });
  return { from, removed, moved, previous, noBuild };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const a = process.argv.slice(2);
  let from;
  let noBuild = false;
  let dir;
  try {
    for (let i = 0; i < a.length; i++) {
      if (a[i] === '--from') from = a[++i];
      else if (a[i] === '--no-build') noBuild = true;
      else if (a[i].startsWith('--') || dir) refuse(USAGE);
      else dir = a[i];
    }
    const r = rerun(dir, from, noBuild);
    console.log(JSON.stringify(r));
    console.log(noBuild
      ? 'Start the workflow on this run folder; NoBuild.done is set, so it skips the estimate and starts no build round.'
      : 'Start the workflow on this run folder; it redoes the phases whose .done file was removed.');
  } catch (e) {
    if (!(e instanceof Refusal)) throw e;
    console.error(e.message);
    process.exit(2);
  }
}

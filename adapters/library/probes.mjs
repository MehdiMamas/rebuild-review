// General checks for a library. Each row: { probe, screen, passed, evidence }; passed=false means the probe flagged a problem.
// runs: [{ id, subpath, steps, result }] of every call sequence already made; the probes make a few more of their own.
import fs from 'node:fs';
import path from 'node:path';
import { scrub } from '../web/context.mjs';
import { runSteps } from './run.mjs';

const median = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
const isObj = (v) => v !== null && typeof v === 'object' && !(typeof v.$ === 'string');
const dirSize = (d) => { let n = 0; for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); try { n += e.isDirectory() ? dirSize(p) : fs.lstatSync(p).size; } catch {} } return n; };

export async function runProbes({ ctx, surface, runs, timings, notChecked }) {
  const rows = [];
  const row = (probe, screen, passed, evidence) => rows.push({ probe, screen, passed, evidence: scrub(evidence) });
  const safe = async (probe, screen, fn) => { try { await fn(); } catch (e) { notChecked.push({ probe, route: screen, reason: scrub(String(e.message).split('\n')[0]) }); } };

  // import-side-effects: importing an entry must print nothing, write nothing and leave nothing running.
  for (const e of surface.entries) {
    if (!e.file) continue;
    await safe('import-side-effects', e.subpath, async () => {
      const r = await runSteps(ctx, [], { subpath: e.subpath, timeoutMs: 15000 });
      const what = [];
      if (r.stdout.trim()) what.push(`prints to stdout (${r.stdout.trim().split('\n')[0].slice(0, 60)})`);
      if (r.stderr.trim()) what.push(`prints to stderr (${r.stderr.trim().split('\n')[0].slice(0, 60)})`);
      if (r.written.length) what.push(`writes ${r.written.map((w) => w.path).join(', ')}`);
      if (r.hung) what.push('leaves a timer, socket or child running');
      if (r.importError) what.push('throws on import');
      row('import-side-effects', e.subpath, what.length === 0, what.length ? `importing ${e.subpath} ${what.join(' and ')}` : `importing ${e.subpath} is silent and leaves nothing running`);
    });
  }

  for (const { id, subpath, steps, result: r } of runs) {
    // throws-non-error: a thrown value that is not an Error.
    r.results.forEach((x, i) => {
      if (x.threw !== undefined && x.thrownIsError === false) row('throws-non-error', id, false, `step ${i + 1} threw ${JSON.stringify(x.threw).slice(0, 80)}, which is not an Error`);
    });
    if (!r.results.some((x) => x.threw !== undefined && x.thrownIsError === false)) row('throws-non-error', id, true, 'nothing thrown that is not an Error');
    // unhandled-rejection: a promise rejected with nobody waiting.
    row('unhandled-rejection', id, !r.unhandled?.length, r.unhandled?.length ? `${r.unhandled.length} ${r.unhandled[0].kind} nobody handled: ${JSON.stringify(r.unhandled[0].value).slice(0, 80)}` : 'no unhandled rejection or exception');
    // process-hang: still alive 5 s after the last call returned.
    row('process-hang', id, !r.hung, r.hung ? 'the process was still running 5 s after the calls ended (a timer, socket or child is left open)' : 'the process ended on its own');
  }

  // mutates-argument: the same call with its object and array arguments deep-frozen must not start to throw.
  for (const { id, subpath, steps, result: r } of runs) {
    const idx = steps.map((s, i) => (Array.isArray(s.args) && s.args.some(isObj) ? i : -1)).filter((i) => i >= 0);
    if (!idx.length || r.noResult) continue;
    await safe('mutates-argument', id, async () => {
      const frozen = steps.map((s, i) => (idx.includes(i) ? { ...s, args: s.args.map((a) => (isObj(a) ? { $: 'frozen', v: a } : a)) } : s));
      const f = await runSteps(ctx, frozen, { subpath, timeoutMs: 15000 });
      const bad = idx.find((i) => f.results[i]?.threw !== undefined && r.results[i]?.threw === undefined);
      row('mutates-argument', id, bad === undefined, bad === undefined ? 'the call works with its arguments frozen' : `step ${bad + 1} throws once its arguments are frozen: ${JSON.stringify(f.results[bad].threw).slice(0, 80)}`);
    });
  }

  // deprecation-warning: listed, not judged.
  const dep = surface.symbols.filter((s) => s.deprecated);
  row('deprecation-warning', '.', true, dep.length ? `deprecated: ${dep.map((s) => s.name).join(', ')} (listed, not judged)` : 'no symbol is marked deprecated');

  // Values, not pass or fail.
  await safe('import-ms', '.', async () => {
    const ms = [];
    for (let i = 0; i < 3; i++) { const r = await runSteps(ctx, [], { timeoutMs: 15000 }); if (r.importMs != null) ms.push(r.importMs); }
    if (!ms.length) throw new Error('the package could not be imported');
    const v = median(ms);
    timings.push({ name: 'import-ms', value: v, unit: 'ms' });
    row('import-ms', '.', true, `import-ms ${v} (median of 3 imports; a value, not judged)`);
  });
  const nm = path.join(ctx.workDir, 'node_modules');
  if (fs.existsSync(nm)) { const v = dirSize(nm); timings.push({ name: 'install-size', value: v, unit: 'bytes' }); row('install-size', '.', true, `install-size ${v} bytes (node_modules; a value, not judged)`); }
  else notChecked.push({ probe: 'install-size', route: '.', reason: 'no node_modules folder' });
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(ctx.entryDir, 'package.json'), 'utf8'));
    const v = Object.keys(pkg.dependencies || {}).length;
    timings.push({ name: 'dependency-count', value: v, unit: 'count' });
    row('dependency-count', '.', true, `dependency-count ${v} (runtime dependencies; a value, not judged)`);
  } catch (e) { notChecked.push({ probe: 'dependency-count', route: '.', reason: e.message }); }
  return rows;
}

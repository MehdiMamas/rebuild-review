// General checks for a command-line tool. Each row: { probe, screen, passed, evidence }; passed=false means the probe flagged a problem.
// runs: [{ id, args, result }] of every invocation already made; the probes make a few more of their own.
import { scrub } from '../web/context.mjs';
import { runCli } from './run.mjs';

const STACK = [/^\s+at\s.+:\d+(:\d+)?\)?\s*$/m, /Traceback \(most recent call last\)/, /thread '[^']*' panicked/, /(^|\n)panic:[\s\S]*goroutine \d+/];
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/;
const HANG_MS = 10000;

const first = (text, re) => { const m = re.exec(text); return m ? m[0].trim().slice(0, 120) : null; };
const median = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];

export async function runProbes({ ctx, runs, timings, notChecked }) {
  const rows = [];
  const row = (probe, screen, passed, evidence) => rows.push({ probe, screen, passed, evidence: scrub(evidence) });
  const safe = async (probe, screen, fn) => { try { await fn(); } catch (e) { notChecked.push({ probe, route: screen, reason: scrub(String(e.message).split('\n')[0]) }); } };

  // bad-flag-exit, error-to-stderr: an unknown flag.
  await safe('bad-flag-exit', 'root', async () => {
    const r = await runCli(ctx, { args: ['--zz-not-a-flag'] });
    runs.push({ id: 'bad-flag', args: ['--zz-not-a-flag'], result: r });
    row('bad-flag-exit', 'root', r.code !== 0 && !r.timedOut, `an unknown flag exited ${r.timedOut ? 'by timeout' : r.code}`);
    const onStderr = r.stderr.trim() !== '' && r.stdout.trim() === '';
    row('error-to-stderr', 'root', onStderr, onStderr ? 'the message is on stderr and stdout is empty' : `the unknown-flag run wrote ${r.stdout.trim() ? 'to stdout' : 'nothing'}${r.stderr.trim() ? '' : ' and nothing to stderr'}: ${(r.stdout || r.stderr).trim().split('\n')[0].slice(0, 100)}`);
  });

  // stdin-hang: no arguments, stdin an open pipe that is never written to.
  await safe('stdin-hang', 'no-args', async () => {
    const r = await runCli(ctx, { args: [], keepStdinOpen: true, timeoutMs: HANG_MS });
    const silent = r.stdout.trim() === '' && r.stderr.trim() === '' && !r.stdoutB64 && !r.stderrB64;
    const hung = r.timedOut && silent;
    row('stdin-hang', 'no-args', !hung, hung ? 'waited for input with no prompt or usage' : r.timedOut ? 'still running after 10 s, but it printed a hint' : `ended on its own (exit ${r.code})`);
  });

  // help-exit, stack traces and colour on every run made so far.
  const help = runs.find((x) => x.id === 'help');
  if (help) {
    const ok = help.result.code === 0 && help.result.stdout.trim() !== '';
    row('help-exit', 'help', ok, ok ? '--help exits 0 with output on stdout' : `--help exited ${help.result.timedOut ? 'by timeout' : help.result.code} with ${help.result.stdout.trim() ? 'output' : 'no output'} on stdout`);
  } else notChecked.push({ probe: 'help-exit', route: 'help', reason: 'no --help run' });
  for (const { id, result: r } of runs) {
    const text = `${r.stdout}\n${r.stderr}`;
    let hit = null;
    for (const re of STACK) hit = hit || first(text, re);
    row('stack-trace-shown', id, !hit, hit ? `a stack trace is shown: ${hit}` : 'no stack trace');
    const ansi = ANSI.test(r.stdout);
    row('color-when-piped', id, !ansi, ansi ? 'stdout holds ANSI escape sequences although it is a pipe (TERM=dumb)' : 'no escape sequences on stdout');
  }

  // slow-start: a value, not a pass or fail.
  await safe('slow-start', 'help', async () => {
    const ms = [];
    for (let i = 0; i < 5; i++) ms.push((await runCli(ctx, { args: ['--help'] })).ms);
    const v = median(ms);
    timings.push({ name: 'startup-ms', value: v, unit: 'ms' });
    row('slow-start', 'help', true, `startup-ms ${v} (median of 5 --help runs; a value, not judged)`);
  });
  return rows;
}

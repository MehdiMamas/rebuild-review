// CLI capture adapter. node capture.mjs --app <run.json> --out <runDir>/golden [--states states.json] [--max-screens N]
// run.json: { platform: "cli", dir?, install?, build?, command: [...], env? }
// A screen is one invocation. Discovery: no arguments, --help, -h, help, --version, then the subcommands named in the help text
// (each with --help), one level deeper. states.json steps: { args }, { stdin }, { file: { path, content } }, { env }.
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { scrub } from '../web/context.mjs';
import { prepare, runCli, networkMode, TEXT_FILE_CAP } from './run.mjs';
import { runProbes } from './probes.mjs';

const arg = (n) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : undefined; };
const appFile = path.resolve(arg('app') || '');
const out = path.resolve(arg('out') || '');
const statesFile = arg('states');
const run = JSON.parse(fs.readFileSync(appFile, 'utf8'));
if (run.platform !== 'cli') throw new Error(`cli adapter cannot capture platform "${run.platform}"`);
const MAX_SCREENS = Number(arg('max-screens')) || 30;
const ctx = prepare(run, appFile);

const write = (f, data) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, typeof data === 'string' ? data : JSON.stringify(data, null, 2)); };
const slug = (s) => String(s || '').toLowerCase().replace(/[^\w]+/g, '-').replace(/^-|-$/g, '');
const notCaptured = [], cutScreens = [], runs = [], timings = [], consoleLines = [];
const screens = [];
const used = new Set();
const uniqueId = (want) => { let id = want || 'screen', n = 2; const b = id; while (used.has(id)) id = `${b}-${n++}`; used.add(id); return id; };
const FIXED = { '': 'no-args', '--help': 'help', '-h': 'h', help: 'help-command', '--version': 'version' };

// Lines indented 2+ spaces that start with a lowercase word followed by 2+ spaces or a tab.
function subcommands(text) {
  const names = [];
  for (const line of String(text).split('\n')) { const m = /^( {2,}|\t+)([a-z][\w-]*)( {2,}|\t)/.exec(line); if (m && !names.includes(m[2])) names.push(m[2]); }
  return names;
}

async function capture(id, args, extra = {}) {
  const result = await runCli(ctx, { args, ...extra });
  runs.push({ id, args, result });
  return result;
}

// 1. Discovery.
const queue = [];
const seen = new Set();
const known = new Set(); // full subcommand paths already queued (`remote add`, not `add`)
const fixed = [[[], 'no-args'], [['--help'], 'help'], [['-h'], 'h'], [['help'], 'help-command'], [['--version'], 'version']];
const helps = {};
for (const [args, want] of fixed) {
  if (screens.length >= MAX_SCREENS) { cutScreens.push(args.join(' ') || '(no arguments)'); continue; }
  const id = uniqueId(want);
  const r = await capture(id, args);
  screens.push({ id, args, steps: [{ args }], depth: 0 });
  helps[want] = r.stdout;
  seen.add(args.join(' '));
}
// The subcommands come from the first of these that lists any.
const helpText = [helps.help, helps.h, helps['no-args'], helps['help-command']].find((t) => t && subcommands(t).length) || '';
for (const sub of subcommands(helpText)) { known.add(sub); queue.push({ path: [sub], depth: 1, parentOut: helpText }); }
for (let qi = 0; qi < queue.length; qi++) {
  const { path: p, depth, parentOut } = queue[qi];
  const args = [...p, '--help'];
  if (seen.has(args.join(' '))) continue;
  seen.add(args.join(' '));
  if (screens.length >= MAX_SCREENS) { cutScreens.push(args.join(' ')); continue; }
  const id = uniqueId(slug(p.join(' ')) || 'screen');
  const r = await capture(id, args);
  screens.push({ id, args, steps: [{ args }], depth });
  // A --help that prints the same text as its parent only repeats the list; its names are not new levels.
  if (depth < 2 && r.stdout !== parentOut) for (const s of subcommands(r.stdout)) { const k = [...p, s].join(' '); if (!known.has(k)) { known.add(k); queue.push({ path: [...p, s], depth: depth + 1, parentOut: r.stdout }); } }
}
if (cutScreens.length) notCaptured.push(`discovery stopped at ${MAX_SCREENS} screens; ${cutScreens.length} more found and not captured`);

// 2. States: one invocation each, built from its steps.
const stateIds = [];
if (statesFile) {
  for (const st of JSON.parse(fs.readFileSync(path.resolve(statesFile), 'utf8'))) {
    try {
      const o = { args: [], stdin: '', env: {}, files: {} };
      for (const step of st.steps || []) {
        if (step.args) o.args.push(...step.args.map(String));
        else if ('stdin' in step) o.stdin += String(step.stdin);
        else if (step.file) o.files[step.file.path] = String(step.file.content);
        else if (step.env) for (const [k, v] of Object.entries(step.env)) o.env[k] = String(v);
        else throw new Error(`step not understood: ${JSON.stringify(step).slice(0, 60)}`);
      }
      const id = uniqueId(slug(st.id) || 'state');
      await capture(id, o.args, { stdin: o.stdin, env: o.env, files: o.files });
      screens.push({ id, args: o.args, steps: st.steps, state: true, depth: 0 });
      stateIds.push(id);
    } catch (e) { notCaptured.push(`state ${st.id}: ${scrub(e.message).split('\n')[0]}`); }
  }
}

// 3. Probes (they make a few more runs of their own).
const notChecked = [];
const probes = await runProbes({ ctx, runs, timings, notChecked });

// 4. Write the golden folder.
const byId = new Map(runs.map((x) => [x.id, x]));
for (const s of screens) {
  const { result: r } = byId.get(s.id);
  const dir = path.join(out, 'screens', s.id);
  // Binary output cannot be scrubbed, so only its size and hash are kept.
  const binary = {};
  for (const n of ['stdout', 'stderr']) {
    if (r[`${n}B64`]) {
      const buf = Buffer.from(r[`${n}B64`], 'base64');
      binary[n] = { bytes: buf.length, sha256: crypto.createHash('sha256').update(buf).digest('hex'), cut: r.cut[n] };
      notCaptured.push(`${s.id}: ${n} is not text; only its size and hash are kept`);
    } else write(path.join(dir, `${n}.txt`), scrub(r[n]));
  }
  for (const n of ['stdout', 'stderr']) if (r.cut[n]) notCaptured.push(`${s.id}: ${n} was cut at 1 MB`);
  if (r.timedOut) notCaptured.push(`${s.id}: the run was stopped after the time limit`);
  if (r.error) notCaptured.push(`${s.id}: could not start: ${scrub(r.error)}`);
  write(path.join(dir, 'result.json'), { args: s.args, code: r.code, signal: r.signal, ms: r.ms, timedOut: r.timedOut, ...(binary.stdout ? { stdoutBinary: binary.stdout } : {}), ...(binary.stderr ? { stderrBinary: binary.stderr } : {}), written: r.written.map(({ path: p, bytes, sha256 }) => ({ path: p, bytes, sha256 })) });
  for (const w of r.written) {
    if (w.text !== undefined) write(path.join(dir, 'out', w.path), scrub(w.text));
    else notCaptured.push(`${s.id}: written file ${w.path} (${w.bytes} bytes) is not text or over ${TEXT_FILE_CAP / 1024} KB; only its size and hash are kept`);
  }
  timings.push({ name: `${s.id}.ms`, value: r.ms, unit: 'ms' });
}
for (const { id, result: r } of runs) {
  const text = scrub(`${r.stderr}`).split('\n').filter(Boolean);
  for (const l of text) consoleLines.push(`[${id}] ${l}`);
}
if (ctx.buildMs !== null) timings.push({ name: 'build-ms', value: ctx.buildMs, unit: 'ms' });

notCaptured.push('no screens or screenshots: command-line tool');
notCaptured.push(networkMode() === 'namespace'
  ? 'network is blocked with a network namespace for every run and not observed'
  : 'network is blocked through a dead proxy and not observed; network blocked only for tools that honour proxy variables');
let appVersion = run.appVersion || null;
if (!appVersion) try { appVersion = JSON.parse(fs.readFileSync(path.join(ctx.workDir, 'package.json'), 'utf8')).version || null; } catch {}
write(path.join(out, 'manifest.json'), scrub(JSON.stringify({
  platform: 'cli', appVersion,
  screens: screens.map(({ id, args, steps, state }) => ({ id, args, steps, ...(state ? { state: true } : {}) })),
  states: stateIds,
  blockedRequests: [],
  notCaptured: [...notCaptured, ...notChecked.map((r) => scrub(`${r.probe} ${r.route}: ${r.reason}`))],
}, null, 2)));
write(path.join(out, 'network.har'), { log: { version: '1.2', creator: { name: 'rebuild-review cli adapter', version: '1' }, entries: [] } });
write(path.join(out, 'coverage.json'), { caps: { maxScreens: MAX_SCREENS }, screensReached: screens.map((s) => s.id), screensCut: cutScreens, buttonsSkipped: [], harEntriesSkipped: 0 });
write(path.join(out, 'timings.json'), timings);
write(path.join(out, 'probes.json'), probes);
write(path.join(out, 'probes-not-checked.json'), notChecked);
write(path.join(out, 'console.log'), consoleLines.join('\n') + (consoleLines.length ? '\n' : ''));
console.log(`captured ${screens.length} screens, ${stateIds.length} states, ${probes.filter((p) => !p.passed).length} probe flags -> ${out}`);
process.exit(0);

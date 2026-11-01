// Start and stop the app named by run.json, shared by capture.mjs and parity.mjs.
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execSync, execFileSync } from 'node:child_process';
import { assertLocalhost, sleep } from './context.mjs';

// An agent exploring the app can leave it running on the run's port. Stops that process only if it runs from inside this run's work copy (base).
// Returns null when the port is free again, otherwise why it was left alone.
async function stopOwnLeftover(origin, base) {
  if (process.platform === 'win32') return 'cannot read its working folder on Windows';
  const lsof = (args) => execFileSync('lsof', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  let pids;
  try { pids = lsof(['-nP', '-t', `-iTCP:${new URL(origin).port}`, '-sTCP:LISTEN']).trim().split('\n').filter(Boolean).map(Number); }
  catch { return 'lsof could not name its process'; }
  if (!pids.length) return 'lsof could not name its process';
  const root = fs.realpathSync(base);
  for (const pid of pids) {
    let cwd = '';
    try { cwd = lsof(['-a', '-p', String(pid), '-d', 'cwd', '-Fn']).split('\n').find((l) => l.startsWith('n'))?.slice(1) ?? ''; } catch {}
    const rel = cwd ? path.relative(root, cwd) : '..';
    if (rel.startsWith('..') || path.isAbsolute(rel)) return `process ${pid} runs from outside this run's work copy`;
  }
  for (const pid of pids) { try { process.kill(pid); } catch {} }
  for (let i = 0; i < 30; i++) {
    if (!(await fetch(origin).then(() => true, () => false))) {
      console.log(`stopped a leftover copy of the app on ${origin} (process ${pids.join(', ')})`);
      return null;
    }
    await sleep(200);
  }
  return `process ${pids.join(', ')} did not stop`;
}

// Returns { origin, workDir, stop, buildMs } (buildMs: time of the build command, null when there is none; install is not timed). Refuses an address that is not local or that something other than a leftover of this app answers.
export async function startApp(run, appFile) {
  const origin = assertLocalhost(run.address).origin;
  // dir is relative: to work/ next to run.json, or, for a file named rebuild-run.json, to that file's own folder.
  if (run.dir && path.isAbsolute(run.dir)) throw new Error(`run.json "dir" must be relative, got ${run.dir}`);
  const base = path.basename(appFile) === 'rebuild-run.json' ? path.dirname(appFile) : path.join(path.dirname(appFile), 'work');
  const workDir = path.resolve(base, run.dir || '.');
  if (path.relative(base, workDir).startsWith('..')) throw new Error(`run.json "dir" must stay inside ${base}, got ${run.dir}`);
  // Something already answering there would be used in place of this app.
  if (await fetch(origin).then(() => true, () => false)) {
    const why = await stopOwnLeftover(origin, base);
    if (why) throw new Error(`refusing to start: something already answers on ${origin} (${why})`);
  }
  // Install, build and start the app in the work copy (never the target itself).
  if (run.install) execSync(run.install, { cwd: workDir, stdio: 'inherit' });
  let buildMs = null;
  if (run.build) { const t0 = Date.now(); execSync(run.build, { cwd: workDir, stdio: 'inherit' }); buildMs = Date.now() - t0; }
  const port = new URL(origin).port;
  const server = spawn(run.start, { cwd: workDir, shell: true, detached: true, stdio: 'ignore', env: { ...process.env, ...run.env, PORT: port } });
  const stop = () => { try { process.kill(-server.pid); } catch {} server.kill(); };
  process.on('exit', stop);
  for (let i = 0; ; i++) {
    if (await fetch(origin).then(() => true, () => false)) break;
    if (i > 100) { stop(); throw new Error(`app did not answer on ${origin}`); }
    await sleep(300);
  }
  return { origin, workDir, stop, buildMs };
}

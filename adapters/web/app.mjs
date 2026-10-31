// Start and stop the app named by run.json, shared by capture.mjs and parity.mjs.
import path from 'node:path';
import { spawn, execSync } from 'node:child_process';
import { assertLocalhost, sleep } from './context.mjs';

// Returns { origin, workDir, stop, buildMs } (buildMs: time of the build command, null when there is none; install is not timed). Refuses an address that is not local or already answers.
export async function startApp(run, appFile) {
  const origin = assertLocalhost(run.address).origin;
  // dir is relative: to work/ next to run.json, or, for a file named rebuild-run.json, to that file's own folder.
  if (run.dir && path.isAbsolute(run.dir)) throw new Error(`run.json "dir" must be relative, got ${run.dir}`);
  const base = path.basename(appFile) === 'rebuild-run.json' ? path.dirname(appFile) : path.join(path.dirname(appFile), 'work');
  const workDir = path.resolve(base, run.dir || '.');
  if (path.relative(base, workDir).startsWith('..')) throw new Error(`run.json "dir" must stay inside ${base}, got ${run.dir}`);
  // Something already answering there would be used in place of this app.
  if (await fetch(origin).then(() => true, () => false)) throw new Error(`refusing to start: something already answers on ${origin}`);
  // Install, build and start the app in the work copy (never the target itself).
  if (run.install) execSync(run.install, { cwd: workDir, stdio: 'inherit' });
  let buildMs = null;
  if (run.build) { const t0 = Date.now(); execSync(run.build, { cwd: workDir, stdio: 'inherit' }); buildMs = Date.now() - t0; }
  const port = new URL(origin).port;
  const server = spawn(run.start, { cwd: workDir, shell: true, detached: true, stdio: 'ignore', env: { ...process.env, PORT: port } });
  const stop = () => { try { process.kill(-server.pid); } catch {} server.kill(); };
  process.on('exit', stop);
  for (let i = 0; ; i++) {
    if (await fetch(origin).then(() => true, () => false)) break;
    if (i > 100) { stop(); throw new Error(`app did not answer on ${origin}`); }
    await sleep(300);
  }
  return { origin, workDir, stop, buildMs };
}

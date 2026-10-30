// Start and stop the app named by run.json, shared by capture.mjs and parity.mjs.
import path from 'node:path';
import { spawn, execSync } from 'node:child_process';
import { assertLocalhost, sleep } from './context.mjs';

// Returns { origin, workDir, stop }. Refuses an address that is not local or already answers.
export async function startApp(run, appFile) {
  const origin = assertLocalhost(run.address).origin;
  const workDir = path.resolve(path.dirname(appFile), 'work', run.dir || '.');
  // Something already answering there would be used in place of this app.
  if (await fetch(origin).then(() => true, () => false)) throw new Error(`refusing to start: something already answers on ${origin}`);
  // Install, build and start the app in the work copy (never the target itself).
  for (const key of ['install', 'build']) if (run[key]) execSync(run[key], { cwd: workDir, stdio: 'inherit' });
  const port = new URL(origin).port;
  const server = spawn(run.start, { cwd: workDir, shell: true, detached: true, stdio: 'ignore', env: { ...process.env, PORT: port } });
  const stop = () => { try { process.kill(-server.pid); } catch {} server.kill(); };
  process.on('exit', stop);
  for (let i = 0; ; i++) {
    if (await fetch(origin).then(() => true, () => false)) break;
    if (i > 100) { stop(); throw new Error(`app did not answer on ${origin}`); }
    await sleep(300);
  }
  return { origin, workDir, stop };
}

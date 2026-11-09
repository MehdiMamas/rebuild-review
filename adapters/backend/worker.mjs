// Runs inside the service's network namespace: reads { id, origin, req } lines on stdin, writes { id, res } lines.
import readline from 'node:readline';
import { doFetch } from './api.mjs';

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', async (line) => {
  let m;
  try { m = JSON.parse(line); } catch { return; }
  const res = await doFetch(m.origin, m.req);
  process.stdout.write(JSON.stringify({ id: m.id, res }) + '\n');
});
rl.on('close', () => process.exit(0));

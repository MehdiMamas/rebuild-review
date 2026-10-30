import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('./free-port.mjs', import.meta.url));
const freePort = () => Number(execFileSync(process.execPath, [script], { encoding: 'utf8' }).trim());
const bind = (port) => new Promise((resolve, reject) => {
  const s = net.createServer();
  s.once('error', reject);
  s.listen(port, '127.0.0.1', () => s.close(() => resolve()));
});

test('prints an integer port that can then be bound', async () => {
  const port = freePort();
  assert.ok(Number.isInteger(port) && port > 0 && port < 65536, String(port));
  await bind(port);
});

test('two calls in a row both work', async () => {
  for (let i = 0; i < 2; i++) await bind(freePort());
});

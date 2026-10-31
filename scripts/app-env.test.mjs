import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { startApp } from '../adapters/web/app.mjs';

const port = () => Number(execFileSync('node', [path.join(import.meta.dirname, 'free-port.mjs')], { encoding: 'utf8' }).trim());

test('run.env reaches the started app; PORT still wins; no env still starts', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'app-env-'));
  fs.mkdirSync(path.join(base, 'work'));
  const server = 'require("http").createServer((q,r)=>r.end(JSON.stringify({s:process.env.STAND_IN_SETTING||null,p:process.env.PORT}))).listen(process.env.PORT,"127.0.0.1")';
  fs.writeFileSync(path.join(base, 'work', 's.js'), server);
  for (const env of [{ STAND_IN_SETTING: 'on', PORT: '1' }, undefined]) {
    const p = port();
    const run = { platform: 'web', start: 'node s.js', address: `http://127.0.0.1:${p}`, ...(env ? { env } : {}) };
    const app = await startApp(run, path.join(base, 'run.json'));
    try {
      const got = await (await fetch(app.origin)).json();
      assert.equal(got.s, env ? 'on' : null);
      assert.equal(got.p, String(p));
    } finally { app.stop(); }
  }
});

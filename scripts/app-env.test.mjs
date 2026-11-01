import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
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

test('a leftover from the work copy is replaced; a listener from elsewhere still refuses', { skip: process.platform === 'win32' }, async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'app-left-'));
  const work = path.join(base, 'work');
  const other = path.join(base, 'other');
  fs.mkdirSync(work);
  fs.mkdirSync(other);
  const server = 'require("http").createServer((q,r)=>r.end(String(process.pid))).listen(process.env.PORT,"127.0.0.1")';
  for (const dir of [work, other]) fs.writeFileSync(path.join(dir, 's.js'), server);
  const listen = async (cwd, p) => {
    const child = spawn('node', ['s.js'], { cwd, stdio: 'ignore', env: { ...process.env, PORT: String(p) } });
    for (let i = 0; i < 50; i++) {
      if (await fetch(`http://127.0.0.1:${p}`).then(() => true, () => false)) return child;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error('test server did not start');
  };
  const runFor = (p) => ({ platform: 'web', start: 'node s.js', address: `http://127.0.0.1:${p}` });

  const p1 = port();
  const leftover = await listen(work, p1);
  const app = await startApp(runFor(p1), path.join(base, 'run.json'));
  try {
    assert.notEqual(await (await fetch(app.origin)).text(), String(leftover.pid));
  } finally { app.stop(); leftover.kill(); }

  const p2 = port();
  const foreign = await listen(other, p2);
  try {
    await assert.rejects(startApp(runFor(p2), path.join(base, 'run.json')), /refusing to start.*outside this run's work copy/);
    assert.equal(await (await fetch(`http://127.0.0.1:${p2}`)).text(), String(foreign.pid));
  } finally { foreign.kill(); }
});

import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync, existsSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const script = fileURLToPath(new URL('./long-run.mjs', import.meta.url))
const run = (...a) => JSON.parse(execFileSync(process.execPath, [script, ...a], { encoding: 'utf8' }))
const tmp = () => mkdtempSync(join(tmpdir(), 'long run '))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

test('a slow command outlives its starter; wait reports running, then exited with the code', () => {
  const dir = tmp()
  const s = run('start', dir, 'a', '--', process.execPath, '-e', "setTimeout(() => { console.log('bye'); process.exit(3) }, 1500)")
  assert.equal(s.state, 'running')
  const w1 = run('wait', dir, 'a', '--seconds', '0.3')
  assert.equal(w1.state, 'running')
  const w2 = run('wait', dir, 'a', '--seconds', '10')
  assert.equal(w2.state, 'exited')
  assert.equal(w2.code, 3)
  assert.match(w2.tail, /bye/)
  assert.ok(existsSync(join(dir, 'a.exit')))
})

test('a second start of a running name attaches; after it exited, start runs fresh', () => {
  const dir = tmp()
  const cmd = [process.execPath, '-e', "require('fs').appendFileSync(process.argv[1], 'x'); setTimeout(() => {}, 1200)", join(dir, 'count')]
  const first = run('start', dir, 'b', '--', ...cmd)
  const second = run('start', dir, 'b', '--', ...cmd)
  assert.equal(second.attached, true)
  assert.equal(second.pid, first.pid)
  assert.equal(run('wait', dir, 'b', '--seconds', '10').state, 'exited')
  assert.equal(readFileSync(join(dir, 'count'), 'utf8'), 'x')
  const third = run('start', dir, 'b', '--', ...cmd)
  assert.equal(third.attached, false)
  assert.equal(run('wait', dir, 'b', '--seconds', '10').state, 'exited')
  assert.equal(readFileSync(join(dir, 'count'), 'utf8'), 'xx')
})

test('a killed supervisor reads lost', async () => {
  const dir = tmp()
  const s = run('start', dir, 'c', '--', process.execPath, '-e', 'setTimeout(() => {}, 3000)')
  process.kill(s.pid, 'SIGKILL')
  await sleep(300)
  const w = run('wait', dir, 'c', '--seconds', '5')
  assert.equal(w.state, 'lost')
  assert.equal(w.code, null)
})

test('a command that does not exist exits 127', () => {
  const dir = tmp()
  run('start', dir, 'd', '--', 'no-such-command-xyz')
  const w = run('wait', dir, 'd', '--seconds', '10')
  assert.equal(w.state, 'exited')
  assert.equal(w.code, 127)
})

// #167: a job that writes its result file and then stays alive is ended after the grace.
const resultJob = (file, extra = '') => ['--', process.execPath, '-e', `require('fs').writeFileSync(${JSON.stringify(file)}, '{}'); ${extra} setInterval(() => {}, 1000)`]
const waitRes = (dir, name, rdir, prefix, grace = 1, seconds = 20) => run('wait', dir, name, '--seconds', String(seconds), '--result-in', rdir, '--result-prefix', prefix, '--grace', String(grace))
const isAlive = (pid) => { try { process.kill(pid, 0); return true } catch (e) { return e.code === 'EPERM' } }

test('a job that leaves its result file behind is killed after the grace; exited, code 0, forced', async () => {
  const dir = tmp()
  const s = run('start', dir, 'r1', ...resultJob(join(dir, 'build-1.result.json')))
  const w = waitRes(dir, 'r1', dir, 'build-')
  assert.equal(w.state, 'exited')
  assert.equal(w.code, 0)
  assert.equal(w.forced, true)
  assert.equal(readFileSync(join(dir, 'r1.exit'), 'utf8'), '0')
  await sleep(300)
  assert.equal(isAlive(s.pid), false)
})

test('a job that writes its result and exits by itself inside the grace keeps its own code and is not forced', () => {
  const dir = tmp()
  run('start', dir, 'r2', '--', process.execPath, '-e', `require('fs').writeFileSync(${JSON.stringify(join(dir, 'build-1.result.json'))}, '{}'); setTimeout(() => process.exit(4), 500)`)
  const w = waitRes(dir, 'r2', dir, 'build-', 30)
  assert.equal(w.state, 'exited')
  assert.equal(w.code, 4)
  assert.equal(w.forced, undefined)
})

test('a result file older than the job start is ignored; the job keeps running', async () => {
  const dir = tmp()
  const old = join(dir, 'build-1.result.json')
  writeFileSync(old, '{}')
  const past = new Date(Date.now() - 3600 * 1000)
  utimesSync(old, past, past)
  const s = run('start', dir, 'r3', '--', process.execPath, '-e', 'setInterval(() => {}, 1000)')
  const w = waitRes(dir, 'r3', dir, 'build-', 0, 1.5)
  assert.equal(w.state, 'running')
  assert.equal(isAlive(s.pid), true)
  process.kill(-s.pid, 'SIGKILL')
})

test('no result file and a running job: running, nothing killed', () => {
  const dir = tmp()
  const s = run('start', dir, 'r4', '--', process.execPath, '-e', 'setInterval(() => {}, 1000)')
  const w = waitRes(dir, 'r4', dir, 'build-', 0, 1.5)
  assert.equal(w.state, 'running')
  assert.equal(isAlive(s.pid), true)
  process.kill(-s.pid, 'SIGKILL')
})

test('a job that ignores SIGTERM is ended by SIGKILL and the exit file is written', () => {
  const dir = tmp()
  run('start', dir, 'r5', ...resultJob(join(dir, 'build-2.result.json'), "process.on('SIGTERM', () => {});"))
  const w = waitRes(dir, 'r5', dir, 'build-')
  assert.equal(w.state, 'exited')
  assert.equal(w.forced, true)
  assert.ok(existsSync(join(dir, 'r5.exit')))
})

test('a result for another prefix is ignored', () => {
  const dir = tmp()
  const s = run('start', dir, 'r6', ...resultJob(join(dir, 'stack-1.result.json')))
  const w = waitRes(dir, 'r6', dir, 'build-', 0, 1.5)
  assert.equal(w.state, 'running')
  process.kill(-s.pid, 'SIGKILL')
})

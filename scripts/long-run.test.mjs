import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
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

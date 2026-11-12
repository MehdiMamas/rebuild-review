import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const file = fileURLToPath(new URL('../workflows/rebuild-review.js', import.meta.url))
const AsyncFunction = (async () => {}).constructor

test('the workflow compiles', () => {
  // Compiled, never run. The body uses top-level await and return, which only a function body allows, and export, which only a module allows.
  const body = readFileSync(file, 'utf8').replace(/^export const meta/m, 'const meta')
  assert.doesNotThrow(() => new AsyncFunction(body))
})

test('no prompt asks an agent to run a command in the background', () => {
  // A long command runs under scripts/long-run.mjs (longRun in the workflow); an agent that holds it in its own Bash call answers before it ends.
  assert.equal(readFileSync(file, 'utf8').split('run_in_background').length - 1, 0)
})

test('long commands go through longRun', () => {
  const src = readFileSync(file, 'utf8')
  assert.ok(src.includes('async function longRun('))
  for (const l of src.split('\n').filter((l) => /capture\.mjs|parity\.mjs|room\.mjs/.test(l) && /\bnode \$\{q\(/.test(l))) assert.ok(/longRun\(/.test(l), l.slice(0, 120))
})

test('every stop of a run writes a report page', () => {
  // A run that stops still ends with a page saying why. The Estimate stop has no `ran`: nothing was spent, so there is no run to report.
  const lines = readFileSync(file, 'utf8').split('\n')
  lines.forEach((l, i) => {
    if (l.includes('return { ran, stopped')) assert.ok(/stoppedReport\(/.test(l) || /stoppedReport\(/.test(lines[i - 1]), l.slice(0, 120))
  })
})

test('agents that start the app are told to stop it, and only the stop rule names pkill or killall', () => {
  const lines = readFileSync(file, 'utf8').split('\n')
  assert.equal(lines.filter((l) => /pkill|killall/.test(l) && !l.startsWith('const STOP_APP')).length, 0)
  assert.equal(lines.filter((l) => l.includes('${STOP_APP}')).length, 4)
})

test('the per-area inventory step marks areas and lists the finished ones through areas.mjs', () => {
  const src = readFileSync(file, 'utf8')
  assert.ok(/areas\.mjs'\)\} mark \$\{q\(runDir\)\} \$\{q\(area\.id\)\}/.test(src), 'mark step')
  assert.ok(/\$\{AJS\} done \$\{q\(runDir\)\}/.test(src), 'done step')
})

test('a wait answer without a numeric code is asked again, and code 0 is named in the prompt (#151)', () => {
  const src = readFileSync(file, 'utf8')
  assert.match(src, /state === 'exited' && typeof w\.code !== 'number'/)
  assert.match(src, /noCode >= 3\) return \{ state: 'wait-failed'/)
  assert.match(src, /0 is a number: always include it/)
})

test('the capture prep keeps an auth block already in run.json (#153)', () => {
  assert.match(readFileSync(file, 'utf8'), /with a .{0,3}base.{0,3}, .{0,3}auth.{0,3} or .{0,3}env.{0,3} key/)
})

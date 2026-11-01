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

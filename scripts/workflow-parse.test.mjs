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

test('every background command asks for the longest time limit', () => {
  // The Bash tool stops a background command after 10 minutes unless told otherwise; a build takes longer.
  const src = readFileSync(file, 'utf8')
  const uses = src.split('run_in_background true').length - 1
  assert.ok(uses > 0)
  assert.equal(src.split('run_in_background true and timeout 7200000').length - 1, uses)
})

test('every prompt that runs capture or parity asks for the longest time limit', () => {
  // A capture on a real app takes far more than the 10 minutes a background command gets by default.
  const lines = readFileSync(file, 'utf8').split('\n').filter((l) => /capture\.mjs|node <adapter> --app|parity\.mjs --app/.test(l))
  assert.ok(lines.length >= 3)
  for (const l of lines) assert.ok(l.includes('${LONG}'), l.slice(0, 120))
})

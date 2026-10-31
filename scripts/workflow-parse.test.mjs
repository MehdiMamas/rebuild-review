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

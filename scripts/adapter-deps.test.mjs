import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { ensureDeps } from './adapter-deps.mjs'

function adapters(withModules) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'deps-'))
  const dir = path.join(root, 'web')
  fs.mkdirSync(dir)
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ dependencies: { foo: '1' } }))
  if (withModules) {
    fs.mkdirSync(path.join(dir, 'node_modules', 'foo'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'node_modules', 'foo', 'package.json'), '{}')
  }
  return root
}

test('nothing missing: no install', () => {
  const root = adapters(true)
  const calls = []
  const r = ensureDeps(root, d => { calls.push(d); return null })
  assert.deepEqual(calls, [])
  assert.deepEqual(r.problems, [])
})

test('missing node_modules: install called', () => {
  const root = adapters(false)
  const calls = []
  const r = ensureDeps(root, d => { calls.push(d); return null })
  assert.deepEqual(calls, [path.join(root, 'web')])
  assert.deepEqual(r.installed, ['web'])
})

test('a listed dependency missing: install called', () => {
  const root = adapters(true)
  fs.writeFileSync(path.join(root, 'web', 'package.json'), JSON.stringify({ dependencies: { foo: '1', bar: '1' } }))
  const calls = []
  ensureDeps(root, d => { calls.push(d); return null })
  assert.equal(calls.length, 1)
})

test('failed install: reason reported', () => {
  const r = ensureDeps(adapters(false), () => 'network down')
  assert.match(r.problems[0], /web.*network down/)
})

test('cli exits non-zero with the reason when an install fails', () => {
  const plugin = fs.mkdtempSync(path.join(os.tmpdir(), 'deps-cli-'))
  fs.mkdirSync(path.join(plugin, 'adapters', 'web'), { recursive: true })
  fs.writeFileSync(path.join(plugin, 'adapters', 'web', 'package.json'), JSON.stringify({ dependencies: { foo: '1.0.0' } }))
  const r = spawnSync('node', [path.join(import.meta.dirname, 'adapter-deps.mjs'), plugin], { encoding: 'utf8', env: { ...process.env, npm_config_registry: 'http://127.0.0.1:9', npm_config_fetch_retries: '0' } })
  assert.notEqual(r.status, 0)
  assert.match(r.stderr, /adapter web: npm install failed/)
})

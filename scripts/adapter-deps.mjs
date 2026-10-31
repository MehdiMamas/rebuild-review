// Installs the dependencies of every adapter (adapters/*/package.json) that lacks them.
// Usage: node scripts/adapter-deps.mjs <pluginRoot>
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

function missing(dir) {
  const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'))
  const names = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies })
  return names.filter(n => !fs.existsSync(path.join(dir, 'node_modules', n, 'package.json')))
}

function npmInstall(dir) {
  const r = spawnSync('npm', ['install'], { cwd: dir, encoding: 'utf8' })
  return r.status === 0 ? null : (r.stderr || r.stdout || `npm exited ${r.status}`).trim().split('\n').slice(-5).join('\n')
}

// install(dir) returns null on success or a reason string.
export function ensureDeps(adaptersDir, install = npmInstall) {
  const problems = []
  const installed = []
  if (!fs.existsSync(adaptersDir)) return { installed, problems }
  for (const name of fs.readdirSync(adaptersDir).sort()) {
    const dir = path.join(adaptersDir, name)
    if (!fs.existsSync(path.join(dir, 'package.json'))) continue
    if (missing(dir).length === 0) continue
    const why = install(dir)
    if (why) problems.push(`adapter ${name}: npm install failed: ${why}`)
    else installed.push(name)
  }
  return { installed, problems }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = process.argv[2]
  if (!root) { console.error('usage: adapter-deps.mjs <pluginRoot>'); process.exit(2) }
  const { installed, problems } = ensureDeps(path.join(root, 'adapters'))
  if (problems.length) { console.error(problems.join('\n')); process.exit(1) }
  console.log(installed.length ? `installed: ${installed.join(', ')}` : 'adapter dependencies present')
}

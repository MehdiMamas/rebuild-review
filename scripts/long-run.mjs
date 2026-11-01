#!/usr/bin/env node
// Detached supervisor for long commands, so no agent has to stay alive while they run.
//   long-run.mjs start <dir> <name> -- <cmd...>   start (or attach to a running one); prints one JSON line
//   long-run.mjs wait <dir> <name> [--seconds 540] block up to that long; prints {state: running|exited|lost, code, tail}
// Files in <dir>: <name>.log (output), <name>.pid (supervisor), <name>.exit (exit code, written when the command ends).
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync, statSync } from 'node:fs'
import { constants } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const files = (dir, name) => ({ log: join(dir, `${name}.log`), pid: join(dir, `${name}.pid`), exit: join(dir, `${name}.exit`) })
const alive = (pid) => { try { process.kill(pid, 0); return true } catch (e) { return e.code === 'EPERM' } }
const readPid = (f) => { try { return Number(readFileSync(f.pid, 'utf8').trim()) || 0 } catch (e) { return 0 } }
const readExit = (f) => { try { return Number(readFileSync(f.exit, 'utf8').trim()) } catch (e) { return null } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function tailOf(file) {
  try {
    const text = readFileSync(file, 'utf8').slice(-4000)
    return text.split('\n').slice(-20).join('\n').trim()
  } catch (e) { return '' }
}

function supervise(dir, name, cmd) {
  const f = files(dir, name)
  const fd = openSync(f.log, 'w')
  let ended = false
  const finish = (code) => { if (ended) return; ended = true; writeFileSync(f.exit + '.tmp', String(code)); renameSync(f.exit + '.tmp', f.exit) }
  const child = spawn(cmd[0], cmd.slice(1), { stdio: ['ignore', fd, fd] })
  child.on('error', (e) => { writeFileSync(f.log, `could not start: ${e.message}\n`, { flag: 'a' }); finish(127) })
  child.on('close', (code, signal) => finish(code === null ? 128 + (constants.signals[signal] || 0) : code))
}

function start(dir, name, cmd) {
  mkdirSync(dir, { recursive: true })
  const f = files(dir, name)
  const pid = readPid(f)
  if (pid && alive(pid) && !existsSync(f.exit)) return { state: 'running', attached: true, pid }
  for (const p of [f.exit, f.pid, f.log]) rmSync(p, { force: true })
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), 'supervise', dir, name, '--', ...cmd], { detached: true, stdio: 'ignore' })
  child.unref()
  writeFileSync(f.pid, String(child.pid))
  return { state: 'running', attached: false, pid: child.pid }
}

async function wait(dir, name, seconds) {
  const f = files(dir, name)
  const end = Date.now() + seconds * 1000
  for (;;) {
    let code = readExit(f)
    if (code !== null) return { state: 'exited', code, tail: tailOf(f.log) }
    const pid = readPid(f)
    if (!pid || !alive(pid)) {
      code = readExit(f)
      if (code !== null) return { state: 'exited', code, tail: tailOf(f.log) }
      return { state: 'lost', code: null, tail: tailOf(f.log) }
    }
    if (Date.now() >= end) return { state: 'running', code: null, tail: tailOf(f.log) }
    await sleep(Math.min(300, Math.max(10, end - Date.now())))
  }
}

const [mode, dir, name, ...rest] = process.argv.slice(2)
const split = rest.indexOf('--')
if (mode === 'supervise') supervise(dir, name, rest.slice(split + 1))
else if (mode === 'start' && dir && name && split === 0 && rest.length > 1) console.log(JSON.stringify(start(dir, name, rest.slice(1))))
else if (mode === 'wait' && dir && name) {
  const i = rest.indexOf('--seconds')
  const seconds = i >= 0 ? Number(rest[i + 1]) : 540
  console.log(JSON.stringify(await wait(dir, name, Number.isFinite(seconds) ? seconds : 540)))
} else {
  console.error('usage: long-run.mjs start <dir> <name> -- <cmd...> | wait <dir> <name> [--seconds N]')
  process.exit(2)
}

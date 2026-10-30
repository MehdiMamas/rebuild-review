// Clean room for the Stack and Rebuild phases. See AGENTS.md ("Clean room").
// CLI: node room.mjs stack|build --target T --run-dir R [--failures file]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { checkText, trackedTexts } from './check-features.mjs';

export const BUDGET_USD = { stack: 3, build: 25, wall: 0.5 };
export const MODEL = { stack: 'sonnet', build: 'opus', wall: 'haiku' };
export const PERMISSION_MODE = 'bypassPermissions';
export const REGISTRIES = [
  'registry.npmjs.org', 'pypi.org', 'files.pythonhosted.org', 'crates.io', 'static.crates.io', 'index.crates.io',
  'repo.maven.apache.org', 'repo1.maven.org', 'pub.dev', 'storage.googleapis.com', 'maven.google.com', 'dl.google.com',
];
const HERE = path.dirname(fileURLToPath(import.meta.url));
const KEEP_BODY = /json|image|font/i;

// ---- golden filter ----
export function filterGolden(src, dest) {
  fs.cpSync(src, dest, { recursive: true, filter: (s) => path.basename(s) !== 'run.json' || path.dirname(s) !== src });
  const har = path.join(dest, 'network.har');
  if (fs.existsSync(har)) {
    const j = JSON.parse(fs.readFileSync(har, 'utf8'));
    const isMap = (u) => /\.map$/i.test(String(u || '').split(/[?#]/)[0]);
    j.log.entries = j.log.entries.filter((e) => !isMap(e.request && e.request.url));
    for (const e of j.log.entries) {
      const c = e.response && e.response.content;
      if (c && typeof c.text === 'string' && !KEEP_BODY.test(c.mimeType || '')) c.text = '';
    }
    fs.writeFileSync(har, JSON.stringify(j));
  }
  const walk = (d) => {
    for (const f of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, f.name);
      if (f.isDirectory()) walk(p);
      else if (/^render\.html?$/i.test(f.name)) {
        let t = fs.readFileSync(p, 'utf8');
        t = t.replace(/(<script\b[^>]*>)[\s\S]*?(<\/script>)/gi, '$1$2');
        t = t.replace(/\/\/[#@]\s*sourceMappingURL=[^\n]*/g, '').replace(/\/\*[#@]\s*sourceMappingURL=[\s\S]*?\*\//g, '');
        fs.writeFileSync(p, t);
      }
    }
  };
  walk(dest);
}

// ---- room ----
const IMG = /\.(png|jpe?g|gif|webp|ico|woff2?|ttf|otf)$/i;
function allFiles(d, out = []) {
  for (const f of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, f.name);
    if (f.isDirectory()) allFiles(p, out); else out.push(p);
  }
  return out;
}

export function prepareRoom({ runDir, target, inputs }) {
  const work = path.join(runDir, 'work');
  const srcTexts = trackedTexts(work);
  for (const f of ['features.md', 'technology.md', 'stack.md']) {
    if (!inputs.includes(f)) continue;
    const problems = checkText(fs.readFileSync(path.join(runDir, f), 'utf8'), srcTexts);
    if (problems.length) throw new Error(`${f} fails the no-source check: ${problems.slice(0, 5).join('; ')}`);
  }
  const room = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-room-'));
  const inp = path.join(room, 'input');
  fs.mkdirSync(inp);
  for (const f of inputs) {
    const s = path.join(runDir, f);
    if (!fs.existsSync(s)) continue;
    if (f === 'golden') filterGolden(s, path.join(inp, 'golden'));
    else fs.copyFileSync(s, path.join(inp, f));
  }
  const name = path.basename(target);
  const nameRe = new RegExp(`[/\\\\]${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w.-])|(?<![\\w.-])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[/\\\\]`);
  const forbidden = [...new Set([target, runDir, fs.realpathSync(target), fs.realpathSync(runDir)])];
  for (const p of allFiles(inp)) {
    if (IMG.test(p)) continue;
    const t = fs.readFileSync(p, 'utf8');
    const hit = forbidden.find((x) => t.includes(x)) || (nameRe.test(t) && name);
    if (hit) {
      fs.rmSync(room, { recursive: true, force: true });
      throw new Error(`room input ${path.relative(inp, p)} contains "${hit}"`);
    }
  }
  const proj = path.join(runDir, 'project');
  if (fs.existsSync(proj)) fs.cpSync(proj, path.join(room, 'project'), { recursive: true });
  return room;
}

// The settings name the denied paths, so they live next to the room, never inside it.
export const settingsPath = (room) => path.join(room + '.settings', 'settings.json');

export function writeSettings(room, { denyPaths, only }) {
  fs.mkdirSync(path.dirname(settingsPath(room)), { recursive: true });
  const settings = {
    sandbox: {
      enabled: true,
      failIfUnavailable: true,
      allowUnsandboxedCommands: false,
      filesystem: { denyRead: denyPaths },
      network: { allowedDomains: REGISTRIES, strictAllowlist: true },
    },
    permissions: { deny: denyPaths.flatMap((p) => [`Read(/${p})`, `Read(/${p}/**)`]) },
  };
  if (only === 'deny') delete settings.sandbox;
  if (only === 'sandbox') delete settings.permissions;
  fs.writeFileSync(settingsPath(room), JSON.stringify(settings, null, 2));
}

export function runChild({ room, prompt, model, maxBudgetUsd, transcriptPath, mode = PERMISSION_MODE }) {
  const env = { PATH: process.env.PATH, HOME: process.env.HOME };
  for (const k of ['TMPDIR', 'USER', 'LANG', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN']) if (process.env[k]) env[k] = process.env[k];
  const args = ['-p', '--model', model, '--max-budget-usd', String(maxBudgetUsd), '--permission-mode', mode,
    '--setting-sources', 'project', '--disallowedTools', 'WebFetch', 'WebSearch', '--disable-slash-commands',
    '--strict-mcp-config', '--no-session-persistence', '--output-format', 'stream-json', '--verbose'];
  args.push('--settings', settingsPath(room));
  const out = fs.openSync(transcriptPath, 'w');
  return new Promise((resolve) => {
    const c = spawn('claude', args, { cwd: room, env, stdio: ['pipe', out, out] });
    c.stdin.end(prompt);
    c.on('close', (code) => {
      fs.closeSync(out);
      resolve({ code, ...parseResult(transcriptPath) });
    });
    c.on('error', (e) => { fs.closeSync(out); resolve({ code: -1, isError: true, costUsd: 0, error: String(e) }); });
  });
}

function parseResult(file) {
  let costUsd = 0, isError = true, text = '';
  for (const l of fs.readFileSync(file, 'utf8').split('\n')) {
    try {
      const j = JSON.parse(l);
      if (j.type === 'result') { costUsd = j.total_cost_usd || 0; isError = !!j.is_error; text = String(j.result || ''); }
    } catch { /* not json */ }
  }
  return { costUsd, isError, text };
}

export function scanTranscript(file, forbidden) {
  const hits = [];
  for (const l of fs.readFileSync(file, 'utf8').split('\n')) {
    const f = forbidden.find((x) => x && l.includes(x));
    if (f) hits.push({ forbidden: f, line: l.slice(0, 300) });
  }
  return hits;
}

export async function provewall({ runDir, room, target, transcriptPath }) {
  const canary = 'CANARY-' + crypto.randomBytes(12).toString('hex');
  const file = path.join(runDir, '.canary');
  fs.writeFileSync(file, canary);
  try {
    const r = await runChild({
      room, model: MODEL.wall, maxBudgetUsd: BUDGET_USD.wall, transcriptPath,
      prompt: `Run: cat ${file}\nThen use the Read tool on ${file}. Report what each one printed, or the error you got.`,
    });
    const hits = scanTranscript(transcriptPath, [canary]);
    if (hits.length) throw new Error('Sandbox did not hold: the canary content came back');
    if (r.code !== 0 || r.isError) throw new Error('Sandbox did not hold: the wall check child failed to run');
    return r.costUsd;
  } finally {
    fs.rmSync(file, { force: true });
  }
}

export function denyList(runDir, target) {
  const home = os.homedir();
  return [...new Set([runDir, fs.realpathSync(runDir), target, fs.realpathSync(target), path.join(home, '.claude', 'projects')])];
}

// ---- CLI ----
function copyProject(from, to) {
  fs.rmSync(to, { recursive: true, force: true });
  const skip = new Set(['node_modules', 'dist', 'build', '.next', 'target', '.dart_tool', '__pycache__']);
  fs.cpSync(from, to, { recursive: true, filter: (s) => !skip.has(path.basename(s)) });
}

export async function main(argv) {
  const mode = argv[0];
  const opt = (k) => { const i = argv.indexOf(k); return i > 0 ? argv[i + 1] : undefined; };
  const target = opt('--target'), runDir = opt('--run-dir'), failures = opt('--failures');
  if (!['stack', 'build'].includes(mode) || !target || !runDir) {
    console.error('usage: room.mjs stack|build --target T --run-dir R [--failures file]');
    return 2;
  }
  const dir = path.join(runDir, 'rebuild');
  fs.mkdirSync(dir, { recursive: true });
  const n = fs.readdirSync(dir).filter((f) => f.startsWith(mode + '-') && f.endsWith('.result.json')).length + 1;
  const resultPath = path.join(dir, `${mode}-${n}.result.json`);
  const transcript = path.join(dir, `${mode}-${n}.jsonl`);
  const result = { ok: false, reason: '', costUsd: 0, transcript };
  let room;
  try {
    const inputs = mode === 'stack' ? ['features.md', 'technology.md'] : ['features.md', 'technology.md', 'stack.md', 'golden'];
    if (mode === 'build' && failures) {
      fs.copyFileSync(failures, path.join(runDir, 'failures.md.tmp'));
      fs.renameSync(path.join(runDir, 'failures.md.tmp'), path.join(runDir, 'failures.md'));
      inputs.push('failures.md');
    }
    room = prepareRoom({ runDir, target, inputs });
    const deny = denyList(runDir, target);
    writeSettings(room, { denyPaths: deny });
    result.costUsd += await provewall({ runDir, room, target, transcriptPath: path.join(dir, `${mode}-${n}.wall.jsonl`) });
    const prompt = fs.readFileSync(path.join(HERE, '..', 'prompts', mode + '.md'), 'utf8') + (failures ? '\n\nFix the failures in input/failures.md.' : '');
    const r = await runChild({ room, prompt, model: MODEL[mode], maxBudgetUsd: BUDGET_USD[mode], transcriptPath: transcript });
    result.costUsd += r.costUsd;
    const hits = scanTranscript(transcript, deny.slice(0, -1));
    if (hits.length) throw new Error(`transcript names a forbidden path (${hits[0].forbidden})`);
    if (r.code !== 0 || r.isError) throw new Error(`child failed: ${(r.text || r.error || 'exit ' + r.code).slice(0, 300)}`);
    if (mode === 'stack') {
      if (!fs.existsSync(path.join(room, 'stack.md'))) throw new Error('child wrote no stack.md');
      fs.copyFileSync(path.join(room, 'stack.md'), path.join(runDir, 'stack.md'));
    } else {
      if (!fs.existsSync(path.join(room, 'project'))) throw new Error('child built no project/');
      copyProject(path.join(room, 'project'), path.join(runDir, 'project'));
    }
    result.ok = true;
  } catch (e) {
    result.reason = String(e.message || e);
  } finally {
    if (room) { fs.rmSync(room, { recursive: true, force: true }); fs.rmSync(room + '.settings', { recursive: true, force: true }); }
    fs.rmSync(path.join(runDir, '.canary'), { force: true });
  }
  fs.writeFileSync(resultPath, JSON.stringify(result, null, 2));
  console.log('RESULT ' + resultPath);
  console.log(JSON.stringify({ ok: result.ok, reason: result.reason }));
  return result.ok ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((c) => process.exit(c));
}

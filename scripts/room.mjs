// Clean room for the Stack and Rebuild phases. See AGENTS.md ("Clean room").
// CLI: node room.mjs stack|build --target T --run-dir R [--failures file]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { checkText, trackedTexts } from './check-features.mjs';
import { readCost } from './parity-results.mjs';
import { readPlan, addCost } from './size.mjs';
import { buildOrder, failureIds, featureAreas } from './areas.mjs';

export const BUDGET_USD = { wall: 0.5 }; // stack and build budgets come from <runDir>/size.json (floors 3 and 25 when there is none)
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
  for (const f of ['features.md', 'technology.md', 'stack.md', 'failures.md']) {
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
  const forbidden = [...new Set([target, runDir, fs.realpathSync(target), fs.realpathSync(runDir)])];
  for (const p of allFiles(inp)) {
    if (IMG.test(p)) continue;
    const t = fs.readFileSync(p, 'utf8');
    const hit = forbidden.find((x) => t.includes(x));
    if (hit) {
      fs.rmSync(room, { recursive: true, force: true });
      throw new Error(`room input ${path.relative(inp, p)} contains "${hit}"`);
    }
  }
  const proj = path.join(runDir, 'project');
  if (fs.existsSync(proj)) {
    try {
      // committed state only: a plain clone, so uncommitted and ignored files never arrive (and an uncommitted file does not fail the round)
      const c = spawnSync('git', ['clone', '--quiet', proj, path.join(room, 'project')], { encoding: 'utf8' });
      if (c.status !== 0) throw new Error('git clone of the previous project failed: ' + c.stderr.slice(0, 200));
      spawnSync('git', ['-C', path.join(room, 'project'), 'remote', 'remove', 'origin'], { encoding: 'utf8' });
    } catch (e) {
      fs.rmSync(room, { recursive: true, force: true });
      throw e;
    }
  }
  return room;
}

// The settings name the denied paths, so they live next to the room, never inside it.
export const settingsPath = (room) => path.join(room + '.settings', 'settings.json');

export function writeSettings(room, { denyPaths, noWrite = [], only }) {
  fs.mkdirSync(path.dirname(settingsPath(room)), { recursive: true });
  const settings = {
    sandbox: {
      enabled: true,
      failIfUnavailable: true,
      allowUnsandboxedCommands: false,
      filesystem: { denyRead: denyPaths },
      network: { allowedDomains: REGISTRIES, strictAllowlist: true },
    },
    permissions: { deny: [...denyPaths.flatMap((p) => [`Read(/${p})`, `Read(/${p}/**)`]), ...noWrite.flatMap((p) => [`Edit(/${p})`, `Edit(/${p}/**)`])] },
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

// True when the transcript holds a Bash tool_use running cat and a Read tool_use on the canary file.
export function wallTried(transcriptPath, file) {
  let bash = false, read = false;
  for (const l of fs.readFileSync(transcriptPath, 'utf8').split('\n')) {
    let j; try { j = JSON.parse(l); } catch { continue; }
    const content = j.message && Array.isArray(j.message.content) ? j.message.content : [];
    for (const c of content) {
      if (c.type !== 'tool_use' || !c.input) continue;
      if (c.name === 'Bash' && /\bcat\b/.test(String(c.input.command || '')) && String(c.input.command).includes(file)) bash = true;
      if (c.name === 'Read' && c.input.file_path === file) read = true;
    }
  }
  return bash && read;
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
    if (!wallTried(transcriptPath, file)) throw new Error('Sandbox did not hold: the wall check did not try');
    return r.costUsd;
  } finally {
    fs.rmSync(file, { force: true });
  }
}

// Paths the child may not read: the target and run folder (also the scan list), plus everything else that holds the source or secrets.
export function scanPaths(runDir, target) {
  return [...new Set([runDir, fs.realpathSync(runDir), target, fs.realpathSync(target)])];
}

export function denyList(runDir, target) {
  const home = os.homedir();
  const out = scanPaths(runDir, target);
  const parent = path.dirname(fs.realpathSync(runDir));
  if (parent.endsWith('-rebuild-review')) out.push(parent, path.dirname(runDir));
  const g = spawnSync('git', ['-C', target, 'rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8' });
  if (g.status === 0 && g.stdout.trim()) {
    const common = fs.realpathSync(g.stdout.trim()), real = fs.realpathSync(target);
    if (common !== real && !common.startsWith(real + path.sep)) out.push(common);
  }
  out.push(path.resolve(HERE, '..'), path.join(home, '.claude', 'projects'));
  for (const c of ['.ssh', '.aws', '.gnupg', '.config/gh', '.netrc', '.npmrc', '.docker']) {
    const p = path.join(home, c);
    if (fs.existsSync(p)) out.push(p);
  }
  return [...new Set(out)];
}

// ---- areas ----
// <runDir>/areas.json when there is one (the workflow writes it before Stack); null otherwise.
function readAreas(runDir) {
  try { return JSON.parse(fs.readFileSync(path.join(runDir, 'areas.json'), 'utf8')); } catch { return null; }
}

function featureCounts(runDir, spec) {
  const of = featureAreas(fs.readFileSync(path.join(runDir, 'features.md'), 'utf8'), spec);
  return Object.fromEntries(spec.areas.map((a) => [a.id, Object.values(of).filter((x) => x === a.id).length]));
}

export const areaStackNote = (ids, counts) => `\n\nThis app is split into areas: ${ids.map((i) => `${i} (${counts[i]} features, tagged [area: ${i}] in input/features.md)`).join('; ')}. Each area is built later by its own builder, one after another, in the same project. Add two more sections to stack.md. "Build order": a list, one item per area, each starting with the area ID, in the order the areas should be built (what others depend on first); every area exactly once. "Shared contracts": the data shapes, API routes, shared components and naming that more than one area uses, in behaviour and technology words, so builders of different areas fit together.`;

export const areaBuildNote = (id, featureIds, order, isRound, failing) => `\n\nThis app is built area by area, in this order: ${order.join(', ')}. You build only the area "${id}": its features are the entries of input/features.md tagged [area: ${id}] (${featureIds.join(', ')}). project/ may already hold earlier areas: keep them working, follow the Build order and Shared contracts in input/stack.md, and do not rewrite other areas. Keep project/rebuild-run.json valid for everything built so far.${isRound ? ` Fix only failures listed for these features: ${featureIds.filter((f) => failing && failing.has(f)).join(', ')}.` : ''} Commit when done.`;

function checkChild(r, transcript, runDir, target, where = '') {
  const hits = scanTranscript(transcript, scanPaths(runDir, target));
  if (hits.length) throw new Error(`transcript names a forbidden path (${hits[0].forbidden})${where}`);
  if (r.code !== 0 || r.isError) throw new Error(`child failed${where}: ${(r.text || r.error || 'exit ' + r.code).slice(0, 300)}`);
}

// ---- CLI ----
export function cloneProject(from, to) {
  const git = (...a) => spawnSync('git', ['-C', from, ...a], { encoding: 'utf8' });
  if (git('rev-parse', '--verify', 'HEAD').status !== 0) throw new Error('the built project is not a git repo with a commit');
  const st = git('status', '--porcelain');
  if (st.status !== 0 || st.stdout.trim()) throw new Error('the built project has uncommitted files: commit everything before finishing');
  fs.rmSync(to, { recursive: true, force: true });
  const c = spawnSync('git', ['clone', '--quiet', from, to], { encoding: 'utf8' });
  if (c.status !== 0) throw new Error('git clone of the built project failed: ' + c.stderr.slice(0, 200));
}

// Moves the current project to rebuild/project-from-build-<n-1> and puts the new one in its place; on any failure the old one is put back.
export function replaceProject(runDir, n, roomProject) {
  const proj = path.join(runDir, 'project'), shelf = path.join(runDir, 'rebuild', `project-from-build-${n - 1}`);
  const had = fs.existsSync(proj);
  if (had) {
    fs.rmSync(shelf, { recursive: true, force: true });
    fs.renameSync(proj, shelf);
    spawnSync('git', ['-C', shelf, 'clean', '-fdxq'], { encoding: 'utf8' });
  }
  try {
    cloneProject(roomProject, proj);
  } catch (e) {
    fs.rmSync(proj, { recursive: true, force: true });
    if (had) fs.renameSync(shelf, proj);
    throw e;
  }
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
    const sized = readPlan(runDir);
    let budget = sized.buildUsd;
    if (mode === 'build' && failures) {
      const left = sized.loopUsd - readCost(runDir).spent;
      if (left <= 0) throw new Error('budget');
      budget = Math.min(budget, left);
    }
    const inputs = mode === 'stack' ? ['features.md', 'technology.md'] : ['features.md', 'technology.md', 'stack.md', 'golden'];
    if (mode === 'build' && failures) {
      fs.copyFileSync(failures, path.join(runDir, 'failures.md.tmp'));
      fs.renameSync(path.join(runDir, 'failures.md.tmp'), path.join(runDir, 'failures.md'));
      inputs.push('failures.md');
    }
    room = prepareRoom({ runDir, target, inputs });
    const deny = denyList(runDir, target);
    writeSettings(room, { denyPaths: deny, noWrite: scanPaths(runDir, target) });
    result.costUsd += await provewall({ runDir, room, target, transcriptPath: path.join(dir, `${mode}-${n}.wall.jsonl`) });
    const spec = readAreas(runDir);
    const multi = !!spec && spec.areas.length > 1;
    const failNote = failures ? '\n\nproject/ already holds the last round. Change it, do not start over. Fix the failures in input/failures.md without breaking any other feature in input/features.md. Commit when done.' : '';
    const base = fs.readFileSync(path.join(HERE, '..', 'prompts', mode + '.md'), 'utf8');
    if (mode === 'stack') {
      const ids = multi ? spec.areas.map((a) => a.id) : [];
      const prompt = base + (multi ? areaStackNote(ids, featureCounts(runDir, spec)) : '');
      const r = await runChild({ room, prompt, model: MODEL.stack, maxBudgetUsd: sized.stackUsd, transcriptPath: transcript });
      result.costUsd += r.costUsd;
      checkChild(r, transcript, runDir, target);
      if (!fs.existsSync(path.join(room, 'stack.md'))) throw new Error('child wrote no stack.md');
      if (multi) buildOrder(fs.readFileSync(path.join(room, 'stack.md'), 'utf8'), ids);
      fs.copyFileSync(path.join(room, 'stack.md'), path.join(runDir, 'stack.md'));
    } else if (!multi) {
      const r = await runChild({ room, prompt: base + failNote, model: MODEL.build, maxBudgetUsd: budget, transcriptPath: transcript });
      result.costUsd += r.costUsd;
      checkChild(r, transcript, runDir, target);
      if (!fs.existsSync(path.join(room, 'project'))) throw new Error('child built no project/');
      if (failures) replaceProject(runDir, n, path.join(room, 'project'));
      else cloneProject(path.join(room, 'project'), path.join(runDir, 'project'));
    } else {
      // One child per area, in build order, in this room and its one git repo. The wall was proven once above; the transcript is checked after every child.
      const ids = spec.areas.map((a) => a.id);
      const order = buildOrder(fs.readFileSync(path.join(runDir, 'stack.md'), 'utf8'), ids);
      const of = featureAreas(fs.readFileSync(path.join(runDir, 'features.md'), 'utf8'), spec);
      const doneFile = path.join(dir, 'areas-done.json');
      const doneAreas = !failures && fs.existsSync(doneFile) ? JSON.parse(fs.readFileSync(doneFile, 'utf8')) : {};
      const failing = failures ? new Set(failureIds(fs.readFileSync(failures, 'utf8'))) : null;
      const todo = order.filter((id) => (failing ? Object.keys(of).some((f) => of[f] === id && failing.has(f)) : !doneAreas[id]));
      let pool = failures ? budget : budget - Object.values(doneAreas).reduce((a, x) => a + x.costUsd, 0);
      result.areas = [];
      for (const id of todo) {
        if (pool <= 0) throw new Error(`budget: spent before area ${id} could be built; a rerun continues with the areas not done`);
        const mine = Object.keys(of).filter((f) => of[f] === id).sort();
        const tr = path.join(dir, `${mode}-${n}.${id}.jsonl`);
        const r = await runChild({ room, prompt: base + areaBuildNote(id, mine, order, !!failures, failing) + failNote, model: MODEL.build, maxBudgetUsd: pool, transcriptPath: tr });
        result.costUsd += r.costUsd;
        pool -= r.costUsd;
        result.areas.push({ id, costUsd: r.costUsd });
        checkChild(r, tr, runDir, target, ` in area ${id}`);
        if (!fs.existsSync(path.join(room, 'project'))) throw new Error(`child built no project/ in area ${id}`);
        if (!failures) {
          cloneProject(path.join(room, 'project'), path.join(runDir, 'project'));
          doneAreas[id] = { costUsd: r.costUsd };
          fs.writeFileSync(doneFile, JSON.stringify(doneAreas, null, 2));
        }
      }
      if (failures) replaceProject(runDir, n, path.join(room, 'project'));
    }
    result.ok = true;
  } catch (e) {
    result.reason = String(e.message || e);
  } finally {
    if (room) { fs.rmSync(room, { recursive: true, force: true }); fs.rmSync(room + '.settings', { recursive: true, force: true }); }
    fs.rmSync(path.join(runDir, '.canary'), { force: true });
  }
  fs.writeFileSync(resultPath, JSON.stringify(result, null, 2));
  addCost(runDir, mode === 'stack' ? 'Stack' : 'Rebuild', result.costUsd);
  console.log('RESULT ' + resultPath);
  console.log(JSON.stringify({ ok: result.ok, reason: result.reason }));
  return result.ok ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((c) => process.exit(c));
}

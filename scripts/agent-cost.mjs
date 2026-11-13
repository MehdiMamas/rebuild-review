// Spend of the workflow agents of a run (#142): node scripts/agent-cost.mjs <runDir> [--root <claude config dir>]
// Reads the agents' transcripts under <root>/projects/*/*/subagents/workflows/*/agent-*.jsonl, prices each assistant
// message once from its token usage (prices.json) and writes the per-phase total into <runDir>/cost.json.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setAgentCost, addNotCounted } from './size.mjs';

export const loadPrices = () => JSON.parse(fs.readFileSync(new URL('../prices.json', import.meta.url), 'utf8'));

// The price row for a model id (a dated id such as claude-haiku-5-5-20261001 matches its base), or null.
export function priceFor(model, prices = loadPrices()) {
  const id = String(model || '');
  const m = prices.models || {};
  if (Object.hasOwn(m, id)) return m[id];
  const base = id.replace(/-\d{8}$/, '');
  return Object.hasOwn(m, base) ? m[base] : null;
}

const num = (x) => (Number.isFinite(x) ? x : 0);

// Dollars for one message's usage under one price row.
export function priceUsage(usage, row) {
  const input = num(usage.input_tokens), read = num(usage.cache_read_input_tokens), output = num(usage.output_tokens);
  const cc = usage.cache_creation || {};
  const w1h = num(cc.ephemeral_1h_input_tokens);
  const w5m = cc.ephemeral_5m_input_tokens !== undefined ? num(cc.ephemeral_5m_input_tokens) : Math.max(0, num(usage.cache_creation_input_tokens) - w1h);
  let p = row;
  if (row.over && row.overTokens && input + read + w1h + w5m > row.overTokens) p = row.over;
  return (input * p.input + w5m * p.write5m + w1h * p.write1h + read * p.read + output * p.output) / 1e6;
}

// One transcript: { usd, messages, unpriced: { <model>: tokens } }. A message id seen on several lines counts once (last wins); bad lines are skipped.
// `seen` (a Set, optional) is shared by all transcripts of a run: an id already in it (a resumed or forked agent repeats its parent's messages) is not priced again (#171).
export function costOfTranscript(file, prices = loadPrices(), seen = null) {
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { return { usd: 0, messages: 0, unpriced: {} }; }
  const byId = new Map();
  let anon = 0;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let r; try { r = JSON.parse(line); } catch { continue; }
    const m = r && r.message;
    if (!m || m.role !== 'assistant' || !m.usage || typeof m.usage !== 'object') continue;
    byId.set(m.id || `anon-${anon++}`, m);
  }
  let usd = 0;
  const unpriced = {};
  let messages = 0;
  for (const [id, m] of byId) {
    if (seen && !id.startsWith('anon-')) { if (seen.has(id)) continue; seen.add(id); }
    messages++;
    const row = priceFor(m.model, prices);
    const u = m.usage;
    if (!row) {
      const t = num(u.input_tokens) + num(u.cache_creation_input_tokens) + num(u.cache_read_input_tokens) + num(u.output_tokens);
      unpriced[m.model || 'unknown'] = (unpriced[m.model || 'unknown'] || 0) + t;
      continue;
    }
    usd += priceUsage(u, row);
  }
  return { usd, messages, unpriced };
}

const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const subdirs = (d) => { try { return fs.readdirSync(d, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => path.join(d, e.name)); } catch { return []; }; };

// The run folder as a whole path: /x/run1 does not match /x/run10 or /y/x/run1. The whole transcript is scanned in 1 MB chunks, stopping at the first hit.
export const runRe = (dir) => new RegExp('(?<![\\w.~-])' + dir.replace(/[.*+?^${}()|[\]\\\/]/g, '\\$&') + '(?![\\w-])(?!\\.\\w)');
function namesRun(file, re, keep = 512) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(CHUNK_BYTES);
    let tail = Buffer.alloc(0), pos = 0;
    for (;;) {
      const n = fs.readSync(fd, buf, 0, CHUNK_BYTES, pos);
      if (n <= 0) return false;
      pos += n;
      const win = Buffer.concat([tail, buf.subarray(0, n)]);
      if (re.test(win.toString('utf8'))) return true;
      tail = win.subarray(Math.max(0, win.length - keep)); // overlap, so a mention across two chunks is found
    }
  } catch { return false; } finally { if (fd !== undefined) try { fs.closeSync(fd); } catch { /* closed */ } }
}
const CHUNK_BYTES = 1 << 20;

// When the run started: the run folder's creation time (else run.json's mtime), or null when unknown. A transcript last written before it cannot belong to the run (#171).
export function runStart(runDir) {
  for (const f of [runDir, path.join(runDir, 'run.json')]) {
    try { const st = fs.statSync(f); const t = st.birthtimeMs > 0 ? st.birthtimeMs : (f === runDir ? 0 : st.mtimeMs); if (t > 0) return t; } catch { /* next */ }
  }
  return null;
}
const SLACK_MS = 60000;
const mtimeOf = (f) => { try { return fs.statSync(f).mtimeMs; } catch { return 0; } };

// Agents of every workflow folder that names the run folder: [{ file, phase }]. `since` (ms, default the run start) skips a folder
// whose newest transcript is older than it, and inside a kept folder only the transcripts written since are searched for the run folder.
export function collect(runDir, root, since = runStart(path.resolve(runDir))) {
  const out = [];
  const floor = since == null ? null : since - SLACK_MS;
  const re = runRe(path.resolve(runDir));
  for (const proj of subdirs(path.join(root, 'projects'))) for (const sess of subdirs(proj)) {
    for (const wf of subdirs(path.join(sess, 'subagents', 'workflows'))) {
      let names; try { names = fs.readdirSync(wf).filter((f) => /^agent-.*\.jsonl$/.test(f)); } catch { continue; }
      const files = names.map((n) => path.join(wf, n));
      const recent = floor == null ? files : files.filter((f) => mtimeOf(f) >= floor);
      if (!recent.length) continue;
      const mine = recent.some((f) => namesRun(f, re, path.resolve(runDir).length * 4 + 16));
      if (!mine) continue;
      for (const file of files) {
        const meta = readJson(file.replace(/\.jsonl$/, '.meta.json')) || {};
        out.push({ file, phase: (typeof meta.workflowPhase === 'string' && meta.workflowPhase) || 'Other' });
      }
    }
  }
  return out;
}

export const AGENT_COST_FAILED = 'The agent cost step failed, so workflow agent spend is not counted.';

export function recordAgentCost(runDir, root, prices = loadPrices()) {
  const agents = collect(runDir, root);
  const byPhase = {}, unpriced = {}, seen = new Set();
  for (const a of agents.sort((x, y) => (x.file < y.file ? -1 : 1))) {
    const r = costOfTranscript(a.file, prices, seen);
    const e = byPhase[a.phase] || (byPhase[a.phase] = { usd: 0, runs: 0 });
    e.usd += r.usd; e.runs += 1;
    for (const [k, v] of Object.entries(r.unpriced)) unpriced[k] = (unpriced[k] || 0) + v;
  }
  const notCounted = [
    'The main session that runs the skill and the Workflow tool are not counted.',
    'Fast-mode and batch pricing are not applied.',
  ];
  if (!agents.length) notCounted.push('No workflow agent transcripts were found for this run, so no agent spend is counted.');
  for (const [model, t] of Object.entries(unpriced)) notCounted.push(`Agents of model ${model} have no price in prices.json: ${t} tokens are not counted.`);
  return setAgentCost(runDir, byPhase, notCounted);
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  const argv = process.argv.slice(2);
  const fi = argv.indexOf('--failed'); // the workflow could not run the step: say so in cost.json instead of staying silent (#171)
  if (fi >= 0) {
    argv.splice(fi, 1);
    if (!argv[0]) { console.error('usage: node scripts/agent-cost.mjs <runDir> --failed'); process.exit(2); }
    addNotCounted(path.resolve(argv[0]), AGENT_COST_FAILED);
    console.log('noted: agent cost step failed');
    process.exit(0);
  }
  const ri = argv.indexOf('--root');
  const root = ri >= 0 ? argv[ri + 1] : (process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'));
  if (ri >= 0) argv.splice(ri, 2);
  if (!argv[0]) { console.error('usage: node scripts/agent-cost.mjs <runDir> [--root dir]'); process.exit(2); }
  const c = recordAgentCost(path.resolve(argv[0]), root);
  console.log(`agent spend recorded; total $${c.totalUsd.toFixed(2)}`);
}

// Spend of the workflow agents (inventory finders, parity writers, judges, report agents ...), per phase.
// The workflow runtime keeps one transcript per agent: <claude config>/projects/<project>/<session>/subagents/workflows/<wf>/agent-<id>.jsonl
// with agent-<id>.meta.json beside it (workflowPhase, model). Each assistant message carries its token usage; prices come from prices.json.
// CLI: node scripts/agent-cost.mjs <runDir> [--root <projects folder>]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setAgentCost } from './size.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const loadPrices = () => JSON.parse(fs.readFileSync(path.join(HERE, '..', 'prices.json'), 'utf8'));

// "claude-haiku-5-5-20260101" and "claude-haiku-5-5" both match the entry "claude-haiku-5-5"; the longest entry wins.
export function priceFor(model, prices = loadPrices()) {
  const id = String(model || '').toLowerCase();
  const keys = Object.keys(prices.models).filter((k) => id === k || id.startsWith(k + '-')).sort((a, b) => b.length - a.length);
  return keys.length ? prices.models[keys[0]] : null;
}

export function messageUsd(usage, price) {
  const input = usage.input_tokens || 0, read = usage.cache_read_input_tokens || 0;
  const cc = usage.cache_creation || {};
  const w1h = cc.ephemeral_1h_input_tokens || 0;
  const w5m = cc.ephemeral_5m_input_tokens !== undefined ? cc.ephemeral_5m_input_tokens : Math.max(0, (usage.cache_creation_input_tokens || 0) - w1h);
  const p = price.over100k && input + read + w5m + w1h > 100000 ? price.over100k : price;
  return (input * p.input + w5m * p.write5m + w1h * p.write1h + read * p.read + (usage.output_tokens || 0) * p.output) / 1e6;
}

const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };

// Each message is priced once: the same message id can sit on several lines; the last one holds the final usage. Unreadable lines are skipped.
export function readTranscript(file) {
  const byId = new Map();
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { return []; }
  let n = 0;
  for (const line of text.split('\n')) {
    if (!line.startsWith('{')) continue;
    let j; try { j = JSON.parse(line); } catch { continue; }
    const m = j && j.type === 'assistant' && j.message;
    if (!m || !m.usage) continue;
    byId.set(m.id || `line-${n++}`, { model: m.model, usage: m.usage });
  }
  return [...byId.values()];
}

export function costOfTranscript(file, prices = loadPrices(), fallbackModel) {
  let usd = 0;
  const unpriced = {};
  for (const { model, usage } of readTranscript(file)) {
    const name = model && model !== '<synthetic>' ? model : fallbackModel;
    const price = priceFor(name, prices);
    if (!price) {
      const u = unpriced[name || 'unknown model'] || (unpriced[name || 'unknown model'] = { tokens: 0 });
      u.tokens += (usage.input_tokens || 0) + (usage.output_tokens || 0) + (usage.cache_read_input_tokens || 0) + (usage.cache_creation_input_tokens || 0);
    } else usd += messageUsd(usage, price);
  }
  return { usd, unpriced };
}

const dirs = (d) => { try { return fs.readdirSync(d, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => path.join(d, e.name)); } catch { return []; } };
const namesRun = (file, runDir) => {
  try {
    const fd = fs.openSync(file, 'r'), buf = Buffer.alloc(262144), n = fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    return buf.toString('utf8', 0, n).includes(JSON.stringify(runDir).slice(1, -1));
  } catch { return false; }
};

// Workflow folders that belong to the run: one of their agents was told the run folder.
export function workflowDirs(runDir, root) {
  const found = [];
  for (const proj of dirs(root)) for (const sess of dirs(proj)) for (const wf of dirs(path.join(sess, 'subagents', 'workflows'))) {
    const agents = fs.readdirSync(wf).filter((f) => /^agent-.*\.jsonl$/.test(f));
    if (agents.some((f) => namesRun(path.join(wf, f), runDir))) found.push(wf);
  }
  return found;
}

export function collect(runDir, root, prices = loadPrices()) {
  const phases = {}, unpriced = {};
  const wfs = workflowDirs(runDir, root);
  for (const wf of wfs) {
    for (const f of fs.readdirSync(wf).filter((x) => /^agent-.*\.jsonl$/.test(x))) {
      const meta = readJson(path.join(wf, f.replace(/\.jsonl$/, '.meta.json'))) || {};
      const c = costOfTranscript(path.join(wf, f), prices, meta.model);
      const ph = meta.workflowPhase || 'Other';
      const e = phases[ph] || (phases[ph] = { usd: 0, runs: 0 });
      e.usd += c.usd; e.runs += 1;
      for (const [k, v] of Object.entries(c.unpriced)) unpriced[k] = (unpriced[k] || 0) + v.tokens;
    }
  }
  return { phases, unpriced, workflows: wfs.length };
}

export function notCountedList(c, prices = loadPrices()) {
  const out = [
    'The main session that runs the skill and starts the workflow is not counted.',
    `Agents are priced from their token usage with the list prices in prices.json (${prices.source}, as of ${prices.asOf}); fast-mode and batch pricing are not applied.`,
    'Agents that run after the last time agent-cost.mjs ran are not counted.',
  ];
  if (!c.workflows) out.unshift('No workflow agent transcripts were found for this run, so no agent spend is counted.');
  for (const [m, t] of Object.entries(c.unpriced)) out.push(`${t.toLocaleString('en-US')} tokens of ${m} are not priced (no entry in prices.json).`);
  return out;
}

export function recordAgentCost(runDir, root, prices = loadPrices()) {
  const c = collect(runDir, root, prices);
  return setAgentCost(runDir, c.phases, notCountedList(c, prices));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const a = process.argv.slice(2), ri = a.indexOf('--root');
  const root = ri >= 0 ? a[ri + 1] : path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'projects');
  if (ri >= 0) a.splice(ri, 2);
  if (!a[0]) { console.error('usage: node scripts/agent-cost.mjs <runDir> [--root <projects folder>]'); process.exit(2); }
  const c = recordAgentCost(path.resolve(a[0]), root);
  console.log(JSON.stringify({ totalUsd: c.totalUsd, phases: Object.fromEntries(Object.entries(c.phases).map(([k, v]) => [k, v.usd])) }));
}

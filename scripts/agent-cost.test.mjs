import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { priceFor, costOfTranscript, collect, recordAgentCost, loadPrices, runStart, readMessages, claimIds } from './agent-cost.mjs';
import { addCost } from './size.mjs';
import { costPhase } from './room.mjs';
import { render } from './report.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'rr-agentcost-'));
const msg = (id, model, usage) => JSON.stringify({ type: 'assistant', message: { id, role: 'assistant', model, usage } });
const user = (text) => JSON.stringify({ type: 'user', message: { role: 'user', content: text } });

// A claude config dir with one workflow folder of agents: [{ name, phase, lines }]
function fixture(runDir, agents, { wf = 'wf_1' } = {}) {
  const root = tmp();
  const dir = path.join(root, 'projects', 'p', 'sess', 'subagents', 'workflows', wf);
  fs.mkdirSync(dir, { recursive: true });
  for (const a of agents) {
    fs.writeFileSync(path.join(dir, `agent-${a.name}.jsonl`), a.lines.join('\n') + '\n');
    fs.writeFileSync(path.join(dir, `agent-${a.name}.meta.json`), JSON.stringify(a.phase ? { workflowPhase: a.phase } : {}));
  }
  return root;
}
const sonnet = (n) => ({ input_tokens: 1000000, output_tokens: 1000000 * n, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 });

test('happy path: priced from usage and grouped by phase', () => {
  const run = tmp();
  const root = fixture(run, [
    { name: 'a', phase: 'Capture', lines: [user(`work in ${run}`), msg('m1', 'claude-sonnet-5-5', { input_tokens: 1e6, output_tokens: 1e6, cache_read_input_tokens: 1e6, cache_creation: { ephemeral_5m_input_tokens: 1e6, ephemeral_1h_input_tokens: 1e6 }, cache_creation_input_tokens: 2e6 })] },
    { name: 'b', phase: 'Score', lines: [msg('m2', 'claude-sonnet-5-5', sonnet(0))] },
  ]);
  const c = recordAgentCost(run, root);
  assert.ok(Math.abs(c.phases.Capture.agentUsd - 18.6) < 1e-9);
  assert.equal(c.phases.Score.agentUsd, 2);
  assert.ok(Math.abs(c.totalUsd - 20.6) < 1e-9);
  assert.equal(c.phases.Capture.agentRuns, 1);
});

test('run twice on the same transcripts: cost.json unchanged', () => {
  const run = tmp();
  const root = fixture(run, [{ name: 'a', phase: 'Capture', lines: [user(run), msg('m1', 'claude-sonnet-5-5', sonnet(1))] }]);
  addCost(run, 'Capture', 0.1);
  recordAgentCost(run, root);
  const first = fs.readFileSync(path.join(run, 'cost.json'), 'utf8');
  recordAgentCost(run, root);
  assert.equal(fs.readFileSync(path.join(run, 'cost.json'), 'utf8'), first);
});

test('a message id on several lines is priced once, last record wins', () => {
  const d = tmp(); const f = path.join(d, 'agent-x.jsonl');
  fs.writeFileSync(f, [msg('m1', 'claude-sonnet-5-5', { input_tokens: 1e6, output_tokens: 0 }), msg('m1', 'claude-sonnet-5-5', { input_tokens: 1e6, output_tokens: 1e6 })].join('\n'));
  const r = costOfTranscript(f);
  assert.equal(r.messages, 1);
  assert.equal(r.usd, 12);
});

test('Haiku 5.5 over 100000 prompt tokens uses the higher row', () => {
  const d = tmp(); const f = path.join(d, 'agent-x.jsonl');
  fs.writeFileSync(f, [msg('a', 'claude-haiku-5-5', { input_tokens: 1e6, output_tokens: 1e6 }), msg('b', 'claude-haiku-5-5', { input_tokens: 1000, output_tokens: 0, cache_read_input_tokens: 99000 })].join('\n'));
  const r = costOfTranscript(f);
  assert.ok(Math.abs(r.usd - (0.5 + 2.5 + (1000 * 0.1 + 99000 * 0.01) / 1e6)) < 1e-9);
  fs.writeFileSync(f, msg('c', 'claude-haiku-5-5', { input_tokens: 1000, output_tokens: 0, cache_read_input_tokens: 99001 }));
  assert.ok(Math.abs(costOfTranscript(f).usd - (1000 * 0.5 + 99001 * 0.05) / 1e6) < 1e-9);
});

test('a model with no price is named in notCounted and adds no dollars', () => {
  const run = tmp();
  const root = fixture(run, [{ name: 'a', phase: 'Capture', lines: [user(run), msg('m1', 'claude-mystery-9', { input_tokens: 70, output_tokens: 5 })] }]);
  assert.equal(priceFor('claude-mystery-9', loadPrices()), null);
  const c = recordAgentCost(run, root);
  assert.equal(c.totalUsd, 0);
  assert.ok(c.notCounted.some((s) => s.includes('claude-mystery-9') && s.includes('75 tokens')));
});

test('an agent with no workflowPhase counts under Other', () => {
  const run = tmp();
  const root = fixture(run, [{ name: 'a', lines: [user(run), msg('m1', 'claude-sonnet-5-5', sonnet(0))] }]);
  assert.equal(recordAgentCost(run, root).phases.Other.agentUsd, 2);
});

test('a workflow folder that never names the run folder is not counted', () => {
  const run = tmp();
  const root = fixture(run, [{ name: 'a', phase: 'Capture', lines: [user('some other run'), msg('m1', 'claude-sonnet-5-5', sonnet(0))] }]);
  assert.deepEqual(collect(run, root), []);
});

test('no transcripts: room phases kept and notCounted says so', () => {
  const run = tmp();
  addCost(run, 'Stack', 1.5);
  const c = recordAgentCost(run, tmp());
  assert.equal(c.phases.Stack.usd, 1.5);
  assert.equal(c.totalUsd, 1.5);
  assert.ok(c.notCounted.some((s) => /No workflow agent transcripts/.test(s)));
});

test('agent spend adds to a phase that has room spend; the total is the sum', () => {
  const run = tmp();
  addCost(run, 'Rebuild', 3);
  const root = fixture(run, [{ name: 'a', phase: 'Rebuild', lines: [user(run), msg('m1', 'claude-sonnet-5-5', sonnet(0))] }]);
  const c = recordAgentCost(run, root);
  assert.equal(c.phases.Rebuild.usd, 5);
  assert.equal(c.phases.Rebuild.runs, 1);
  assert.equal(c.totalUsd, 5);
  // a later room entry still adds on top
  addCost(run, 'Rebuild', 1);
  assert.equal(JSON.parse(fs.readFileSync(path.join(run, 'cost.json'), 'utf8')).totalUsd, 6);
});

test('a broken transcript line is skipped, the rest counted', () => {
  const d = tmp(); const f = path.join(d, 'agent-x.jsonl');
  fs.writeFileSync(f, ['{not json', msg('m1', 'claude-sonnet-5-5', sonnet(0)), '', '{"message":null}'].join('\n'));
  assert.equal(costOfTranscript(f).usd, 2);
  assert.deepEqual(costOfTranscript(path.join(d, 'missing.jsonl')), { usd: 0, messages: 0, unpriced: {} });
});

test('room phases: parity-loop build under Parity, first build under Rebuild, stack under Stack', () => {
  assert.equal(costPhase('build', 'parity/failures.md'), 'Parity');
  assert.equal(costPhase('build', undefined), 'Rebuild');
  assert.equal(costPhase('stack', undefined), 'Stack');
});

test('report Cost section lists the phases and the not-counted items', () => {
  const run = tmp();
  addCost(run, 'Stack', 1); addCost(run, 'Rebuild', 2); addCost(run, 'Parity', 3);
  const root = fixture(run, [{ name: 'a', phase: 'Capture', lines: [user(run), msg('m1', 'claude-sonnet-5-5', sonnet(0))] }]);
  recordAgentCost(run, root);
  const html = render(run);
  const cost = html.slice(html.indexOf('id="cost"'), html.indexOf('id="project"'));
  for (const p of ['Stack', 'Rebuild', 'Parity', 'Capture']) assert.match(cost, new RegExp(`<td>${p}</td>`));
  assert.match(cost, /Total \$8\.00/);
  assert.match(cost, /main session/);
});

test('agent-cost, then a room entry, then agent-cost again: no double count', () => {
  const run = tmp();
  const root = fixture(run, [{ name: 'a', phase: 'Rebuild', lines: [user(run), msg('m1', 'claude-sonnet-5-5', sonnet(0))] }]);
  addCost(run, 'Rebuild', 3);
  recordAgentCost(run, root);
  const mid = addCost(run, 'Rebuild', 1);
  assert.equal(mid.phases.Rebuild.agentUsd, 2);
  assert.equal(mid.phases.Rebuild.agentRuns, 1);
  const c = recordAgentCost(run, root);
  assert.equal(c.phases.Rebuild.usd, 6);
  assert.equal(c.phases.Rebuild.runs, 2);
  assert.equal(c.totalUsd, 6);
});

test('the run folder matches on a path boundary only', () => {
  const base = tmp();
  const run1 = path.join(base, 'run1'), run10 = path.join(base, 'run10');
  const root = fixture(run10, [{ name: 'a', phase: 'Capture', lines: [user(`work in ${run10}/golden`), msg('m1', 'claude-sonnet-5-5', sonnet(0))] }]);
  assert.deepEqual(collect(run1, root), []);
  assert.equal(collect(run10, root).length, 1);
  const root2 = fixture(run1, [{ name: 'a', phase: 'Capture', lines: [user(`"${run1}" and ${run1}.`), msg('m1', 'claude-sonnet-5-5', sonnet(0))] }]);
  assert.equal(collect(run1, root2).length, 1);
  assert.deepEqual(collect(path.join(base, 'x', 'run1'), fixture(run1, [{ name: 'a', lines: [user(run1)] }])), []);
});

test('the cost event carries the change, and none is written for an unchanged rerun', async () => {
  const { read } = await import('./events.mjs');
  const run = tmp();
  const root = fixture(run, [{ name: 'a', phase: 'Capture', lines: [user(run), msg('m1', 'claude-sonnet-5-5', sonnet(0))] }]);
  const n = () => read(run).events.filter((e) => e.kind === 'cost' && e.phase === 'Agents');
  recordAgentCost(run, root);
  recordAgentCost(run, root);
  assert.equal(n().length, 1);
  assert.equal(n()[0].usd, 2);
  fs.appendFileSync(path.join(root, 'projects/p/sess/subagents/workflows/wf_1/agent-a.jsonl'), msg('m2', 'claude-sonnet-5-5', sonnet(0)) + '\n');
  recordAgentCost(run, root);
  assert.equal(n().length, 2);
  assert.equal(n()[1].usd, 2);
  assert.equal(n()[1].totalUsd, 4);
});

test('the CLI runs through a symlinked scripts path', () => {
  const run = tmp();
  const root = fixture(run, [{ name: 'a', phase: 'Capture', lines: [user(run), msg('m1', 'claude-sonnet-5-5', sonnet(0))] }]);
  const link = path.join(tmp(), 'agent-cost.mjs');
  fs.symlinkSync(fileURLToPath(new URL('./agent-cost.mjs', import.meta.url)), link);
  const out = execFileSync(process.execPath, [link, run, '--root', root], { encoding: 'utf8' });
  assert.match(out, /total \$2\.00/);
});

test('a run folder named only after the first 64 KB and across a chunk edge is still found', () => {
  const run = tmp();
  const filler = user('x'.repeat(1 << 20)); // pushes the mention past the first chunk
  const root = fixture(run, [{ name: 'a', phase: 'Capture', lines: [filler, user(`later: ${run}/golden`), msg('m1', 'claude-sonnet-5-5', sonnet(0))] }]);
  assert.equal(collect(run, root).length, 1);
  // a mention that straddles the chunk boundary exactly
  const root2 = tmp();
  const dir = path.join(root2, 'projects', 'p', 's', 'subagents', 'workflows', 'wf_1');
  fs.mkdirSync(dir, { recursive: true });
  const mention = `${run}/x`;
  fs.writeFileSync(path.join(dir, 'agent-a.jsonl'), 'a'.repeat((1 << 20) - 5) + ' ' + mention + '\n');
  assert.equal(collect(run, root2).length, 1);
});

test('an agent-only phase is deleted when its transcripts are gone on a rerun; one with room spend stays without agent fields', () => {
  const run = tmp();
  const root = fixture(run, [{ name: 'a', phase: 'Score', lines: [user(run), msg('m1', 'claude-sonnet-5-5', sonnet(0))] }, { name: 'b', phase: 'Capture', lines: [user(run), msg('m2', 'claude-sonnet-5-5', sonnet(0))] }]);
  addCost(run, 'Capture', 0.5);
  let c = recordAgentCost(run, root);
  assert.ok(c.phases.Score && c.phases.Capture.agentUsd > 0);
  c = recordAgentCost(run, tmp()); // transcripts gone
  assert.equal(c.phases.Score, undefined);
  assert.deepEqual(c.phases.Capture, { usd: 0.5, runs: 1 });
  assert.ok(Math.abs(c.totalUsd - 0.5) < 1e-9);
});

test('#171: a workflow folder older than the run start is skipped; one written since is kept', () => {
  const run = tmp();
  const root = fixture(run, [{ name: 'a', phase: 'Capture', lines: [user(run), msg('m1', 'claude-sonnet-5-5', sonnet(0))] }]);
  const dir = path.join(root, 'projects', 'p', 'sess', 'subagents', 'workflows', 'wf_1');
  const old = new Date(Date.now() - 3600e3);
  fs.utimesSync(path.join(dir, 'agent-a.jsonl'), old, old);
  assert.equal(collect(run, root, Date.now()).length, 0);
  assert.equal(collect(run, root, Date.now() - 2 * 3600e3).length, 1);
  assert.equal(collect(run, root, null).length, 1);
});

test('#171: a message id repeated across two transcripts is priced once; inside a file the last record wins', () => {
  const run = tmp();
  const root = fixture(run, [
    { name: 'a', phase: 'Capture', lines: [user(run), msg('m1', 'claude-sonnet-5-5', sonnet(0)), msg('m1', 'claude-sonnet-5-5', sonnet(1))] },
    { name: 'b', phase: 'Capture', lines: [user(run), msg('m1', 'claude-sonnet-5-5', sonnet(1)), msg('m2', 'claude-sonnet-5-5', sonnet(0))] },
  ]);
  const c = recordAgentCost(run, root);
  assert.equal(c.phases.Capture.agentUsd, 14); // m1 once (2 + 10), m2 once (2)
  const f = path.join(root, 'projects', 'p', 'sess', 'subagents', 'workflows', 'wf_1', 'agent-a.jsonl');
  assert.equal(costOfTranscript(f, loadPrices()).usd, 12);
});

test('#171: --failed adds one notCounted sentence and keeps the spend; a later successful run replaces it', async () => {
  const { AGENT_COST_FAILED } = await import('./agent-cost.mjs');
  const run = tmp();
  addCost(run, 'Stack', 2);
  const script = fileURLToPath(new URL('./agent-cost.mjs', import.meta.url));
  execFileSync(process.execPath, [script, run, '--failed']);
  execFileSync(process.execPath, [script, run, '--failed']);
  const c = JSON.parse(fs.readFileSync(path.join(run, 'cost.json'), 'utf8'));
  assert.deepEqual(c.notCounted.filter((x) => x === AGENT_COST_FAILED).length, 1);
  assert.equal(c.totalUsd, 2);
  const after = recordAgentCost(run, tmp());
  assert.ok(!after.notCounted.includes(AGENT_COST_FAILED));
});

test('#171: an id held in two transcripts is priced from the larger record, not the first file', () => {
  const run = tmp();
  const root = fixture(run, [
    { name: 'a', phase: 'Capture', lines: [user(run), msg('m1', 'claude-sonnet-5-5', { input_tokens: 1000000, output_tokens: 0 })] }, // partial
    { name: 'b', phase: 'Rebuild', lines: [user(run), msg('m1', 'claude-sonnet-5-5', sonnet(1))] }, // complete
  ]);
  const c = recordAgentCost(run, root);
  assert.equal(c.phases.Rebuild.agentUsd, 12);
  assert.equal(c.phases.Capture.agentUsd, 0);
  assert.equal(c.totalUsd, 12);
});

test('#171: runStart is the earliest time in the run folder and ignores a later rewrite of run.json', () => {
  const run = tmp();
  fs.writeFileSync(path.join(run, 'run.json'), '{}');
  fs.writeFileSync(path.join(run, 'size.json'), '{}');
  const t0 = new Date('2026-01-01T00:00:00Z'), t1 = new Date('2026-01-02T00:00:00Z');
  for (const f of [run, path.join(run, 'size.json')]) fs.utimesSync(f, t0, t0);
  fs.utimesSync(path.join(run, 'run.json'), t1, t1);
  const s = runStart(run);
  assert.ok(s <= t0.getTime() && s > 0);
  assert.equal(runStart(path.join(run, 'missing')), null);
});

test('#171: --failed adds no note when cost.json was written by a successful agent-cost run', () => {
  const run = tmp();
  recordAgentCost(run, tmp());
  execFileSync(process.execPath, [fileURLToPath(new URL('./agent-cost.mjs', import.meta.url)), run, '--failed']);
  const c = JSON.parse(fs.readFileSync(path.join(run, 'cost.json'), 'utf8'));
  assert.ok(!c.notCounted.some((x) => /step failed/.test(x)));
});

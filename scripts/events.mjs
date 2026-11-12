// Run events for the watch page (#82): node scripts/events.mjs <runDir> <kind> '<json>' appends one line to <runDir>/events.jsonl.
// Kinds: phase {phase, state: start|done|failed|skipped, reason?}, decision {what, choice, reason}, cost {phase, usd, totalUsd, maxUsd}, made {what, path, count?}.
// Every string is cut to 500 characters; every value of run.json `env` and every `auth` type.text of 4+ characters is replaced by ***.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const KINDS = ['phase', 'decision', 'cost', 'made'];
const MAX = 500;

function envValues(runDir) {
  try {
    const run = JSON.parse(fs.readFileSync(path.join(runDir, 'run.json'), 'utf8'));
    const env = run.env && typeof run.env === 'object' ? Object.values(run.env).map(String).filter((v) => v.length > 0) : [];
    const steps = run.auth && Array.isArray(run.auth.steps) ? run.auth.steps : [];
    const typed = steps.map((s) => s && s.type && s.type.text).filter((t) => typeof t === 'string' && t.length >= 4);
    return [...new Set([...env, ...typed])].sort((a, b) => b.length - a.length);
  } catch { return []; }
}

const clean = (v, secrets) => {
  if (typeof v === 'string') {
    for (const s of secrets) v = v.split(s).join('***');
    return v.length > MAX ? v.slice(0, MAX) : v;
  }
  if (Array.isArray(v)) return v.map((x) => clean(x, secrets));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, clean(x, secrets)]));
  return v;
};

// Text with every run.json env value replaced by ***; the watch page uses it on logs.
export function mask(runDir, text) {
  for (const s of envValues(runDir)) text = text.split(s).join('***');
  return text;
}

export function emit(runDir, ev) {
  const secrets = envValues(runDir);
  const line = JSON.stringify({ t: new Date().toISOString(), ...clean(ev, secrets) }) + '\n';
  fs.mkdirSync(runDir, { recursive: true });
  fs.appendFileSync(path.join(runDir, 'events.jsonl'), line);
}

// Never lets a failed write stop the step that reports it.
export function tryEmit(runDir, ev) {
  try { emit(runDir, ev); } catch { /* the event is lost, the run goes on */ }
}

// Complete lines from byte fromByte on: { events, nextByte }. A half-written last line waits for the next read.
export function read(runDir, fromByte = 0) {
  let buf;
  try { buf = fs.readFileSync(path.join(runDir, 'events.jsonl')); } catch { return { events: [], nextByte: fromByte }; }
  if (fromByte > buf.length) fromByte = 0;
  const end = buf.lastIndexOf(10) + 1;
  if (end <= fromByte) return { events: [], nextByte: fromByte };
  const events = [];
  for (const l of buf.subarray(fromByte, end).toString('utf8').split('\n')) {
    if (!l) continue;
    try { events.push(JSON.parse(l)); } catch { /* a damaged line is skipped */ }
  }
  return { events, nextByte: end };
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [runDir, kind, json] = process.argv.slice(2);
  if (!runDir || !KINDS.includes(kind) || !json) { console.error(`usage: events.mjs <runDir> ${KINDS.join('|')} '<json>'`); process.exit(2); }
  let data;
  try { data = JSON.parse(json); } catch { console.error('the event is not JSON'); process.exit(2); }
  tryEmit(path.resolve(runDir), { kind, ...data });
}

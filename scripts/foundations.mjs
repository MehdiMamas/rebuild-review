// Foundations checklist: what must carry over from the original whatever the features say. See AGENTS.md ("Upstream base and foundations").
//   node foundations.mjs check <foundations.md>   exit 1 unless every category is present with a status on every item
// Format: one "## <category heading>" per category, then bullets "- found: <text> (evidence: ...)", "- not found: <text>" or "- not applicable: <text>".
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const CATEGORIES = [
  { id: 'license', heading: 'License and attribution' },
  { id: 'platforms', heading: 'Platforms and packaging' },
  { id: 'extensions', heading: 'Extension and plugin APIs' },
  { id: 'userdata', heading: 'Saved user data' },
  { id: 'config', heading: 'Settings and config files' },
  { id: 'services', heading: 'External services' },
  { id: 'auth', heading: 'Auth and accounts' },
  { id: 'telemetry', heading: 'Telemetry and crash reporting' },
  { id: 'updates', heading: 'Update channels and signing' },
];
export const STATUSES = ['found', 'not found', 'not applicable'];
const BULLET = /^\s*[-*]\s+(.*)$/;
const STATUS = /^(found|not found|not applicable)\s*[:\-]\s*(.*)$/i;

// Items in file order: { id: "<category>.<n>", category, status, text }. Bullets with no status come back with status null.
export function items(text) {
  const out = [];
  let cat = null, n = 0;
  for (const line of text.split('\n')) {
    const h = /^##\s+(.+?)\s*$/.exec(line);
    if (h) { cat = CATEGORIES.find((c) => c.heading.toLowerCase() === h[1].toLowerCase()) || null; n = 0; continue; }
    const b = BULLET.exec(line);
    if (!cat || !b) continue;
    const s = STATUS.exec(b[1]);
    out.push({ id: `${cat.id}.${++n}`, category: cat.id, status: s ? s[1].toLowerCase() : null, text: s ? s[2] : b[1] });
  }
  return out;
}

export function check(text) {
  const problems = [];
  const headings = new Set(text.split('\n').map((l) => /^##\s+(.+?)\s*$/.exec(l)).filter(Boolean).map((m) => m[1].toLowerCase()));
  const all = items(text);
  for (const c of CATEGORIES) {
    if (!headings.has(c.heading.toLowerCase())) { problems.push(`missing category "${c.heading}"`); continue; }
    if (!all.some((i) => i.category === c.id)) problems.push(`category "${c.heading}" has no item`);
  }
  for (const i of all) {
    if (!i.status) problems.push(`item ${i.id} has no status (found, not found or not applicable)`);
    else if (i.status === 'found' && !/evidence\s*:\s*\S/i.test(i.text)) problems.push(`item ${i.id} is found but names no evidence`);
  }
  return problems;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [cmd, file] = process.argv.slice(2);
  if (cmd !== 'check' || !file) { console.error('usage: foundations.mjs check <foundations.md>'); process.exit(2); }
  const problems = check(fs.readFileSync(file, 'utf8'));
  if (problems.length) { console.log(problems.join('\n')); process.exit(1); }
  console.log('foundations ok');
}

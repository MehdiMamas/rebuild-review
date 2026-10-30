// Scores a run's features.md against answers.json. Usage: node score-inventory.mjs <features.md>
// Only this test script reads answers.json; never run it where an agent under test can see the repo.
// Matching is by keyword groups: an entry matches an item when every group has a word in the entry.
import fs from 'node:fs';
import path from 'node:path';

const here = path.dirname(new URL(import.meta.url).pathname);
const answers = JSON.parse(fs.readFileSync(path.join(here, 'answers.json'), 'utf8'));
const KEYS = {
  D1: [['re-render', 'rerender', 'render', 'redraw'], ['search', 'keystroke', 'typing', 'type']],
  D2: [['focus'], ['setting', 'field']],
  D3: [['shift', 'jump', 'moves', 'pushed down', 'shifts'], ['load', 'banner', 'count']],
  D4: [['stale', 'out of order', 'race', 'older', 'earlier'], ['search', 'query', 'count', 'result']],
  D5: [['repeat', 'repeated', 'loop', 'again and again', 'continuously', 'many times', 'polling'], ['request', 'fetch', 'detail']],
  D6: [['loading', 'spinner', 'indicator'], ['no ', 'missing', 'nothing', 'without', 'lacks', 'absent']],
  D7: [['save'], ['error', 'fail', '500'], ['saved', 'success', 'no error', 'missing', 'despite']],
  H1: [['key', 'shortcut', 'press'], ['"c"', "'c'", ' c ', '`c`', 'letter c', 'c key', 'key c']],
  H2: [['trim', 'whitespace', 'padding', 'spaces'], ['title']],
  H3: [['retry'], ['banner', 'button']],
  H4: [['density', 'compact'], ['url', 'query', '?density', 'parameter', 'address', 'link']],
};
const md = fs.readFileSync(process.argv[2], 'utf8');
const entries = md.split(/^(?=.*\bF-\d{3}\b.*$)/m).filter((e) => /\bF-\d{3}\b/.test(e));
const isDefect = (e) => /\bdefect\b/i.test(e.replace(/keep or defect/gi, ''));
let found = 0, total = 0, bad = 0;
const rows = [];
for (const a of answers) {
  if (a.kind === 'bloat') continue;
  total++;
  const groups = KEYS[a.id];
  const hit = entries.filter((e) => { const l = e.toLowerCase(); return groups.every((g) => g.some((w) => l.includes(w))); });
  let ok = hit.length > 0;
  let note = hit.length ? hit.map((e) => e.match(/\bF-\d{3}\b/)[0]).join(',') : '-';
  if (ok && a.kind === 'defect' && !hit.some(isDefect)) { ok = false; note += ' (not marked defect)'; }
  if (!ok) bad++; else found++;
  rows.push(`${a.id}\t${a.kind}\t${ok ? 'FOUND' : 'MISSED'}\t${note}`);
}
console.log('id\tkind\tresult\tentries\n' + rows.join('\n'));
console.log(`${found}/${total} found`);
process.exit(bad ? 1 : 0);

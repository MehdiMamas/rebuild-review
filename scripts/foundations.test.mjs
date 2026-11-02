import test from 'node:test';
import assert from 'node:assert/strict';
import { CATEGORIES, check, items } from './foundations.mjs';

const full = CATEGORIES.map((c) => `## ${c.heading}\n- not applicable: nothing here\n`).join('\n');

test('a complete file passes', () => {
  assert.deepEqual(check(full), []);
});

test('a missing category is refused', () => {
  const text = full.replace('## Auth and accounts\n- not applicable: nothing here\n', '');
  assert.match(check(text).join('\n'), /missing category "Auth and accounts"/);
});

test('a bullet with no status and a found item with no evidence are refused', () => {
  const text = full + '\n## Saved user data\n- some note\n- found: a file format\n';
  const p = check(text).join('\n');
  assert.match(p, /has no status/);
  assert.match(p, /names no evidence/);
});

test('items get ids by category and order, with their status', () => {
  const text = full.replace('## License and attribution\n- not applicable: nothing here', '## License and attribution\n- found: MIT notice kept (evidence: LICENSE)\n- not found: no NOTICE file');
  const got = items(text).filter((i) => i.category === 'license');
  assert.deepEqual(got.map((i) => [i.id, i.status]), [['license.1', 'found'], ['license.2', 'not found']]);
});

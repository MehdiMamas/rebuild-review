import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { visualDiff } from './visual-diff.mjs';

const { PNG } = createRequire(new URL('../adapters/web/package.json', import.meta.url))('pngjs');
const png = (file, rgb) => {
  const p = new PNG({ width: 10, height: 10 });
  for (let i = 0; i < 100; i++) p.data.set([...rgb, 255], i * 4);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, PNG.sync.write(p));
};

test('identical gives 0, changed gives more, one-sided is in onlyIn', () => {
  const t = fs.mkdtempSync(path.join(os.tmpdir(), 'vd-'));
  const a = path.join(t, 'a'), b = path.join(t, 'b');
  png(`${a}/screens/root/1440-light.png`, [255, 255, 255]);
  png(`${b}/screens/root/1440-light.png`, [255, 255, 255]);
  png(`${a}/screens/list/390-dark.png`, [255, 255, 255]);
  png(`${b}/screens/list/390-dark.png`, [0, 0, 0]);
  png(`${a}/screens/gone/390-light.png`, [1, 2, 3]);
  const { diffs, onlyIn } = visualDiff(a, b);
  assert.equal(diffs.find((d) => d.screen === 'root').percent, 0);
  assert.ok(diffs.find((d) => d.screen === 'list').percent > 0);
  assert.deepEqual(onlyIn.map((o) => o.screen), ['gone']);
  fs.rmSync(t, { recursive: true, force: true });
});

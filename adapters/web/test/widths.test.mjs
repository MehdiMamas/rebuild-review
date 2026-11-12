import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseWidths } from '../widths.mjs';

test('no flag keeps 390 and 1440', () => assert.deepEqual(parseWidths(undefined), [390, 1440]));
test('two widths are accepted, spaces allowed', () => {
  assert.deepEqual(parseWidths('320,768'), [320, 768]);
  assert.deepEqual(parseWidths('390, 1440'), [390, 1440]);
});
test('not two whole numbers is refused', () => {
  for (const v of ['abc', '390', '390,1440,2000', '390,', '', '1e3,2000', '0x10,1440']) assert.throws(() => parseWidths(v), /two positive whole numbers/, v);
});
test('zero, negative or fractional is refused', () => {
  for (const v of ['0,1440', '-5,1440', '390,1.5']) assert.throws(() => parseWidths(v), /two positive whole numbers/, v);
});
test('narrow must be smaller than wide', () => {
  for (const v of ['1440,390', '500,500']) assert.throws(() => parseWidths(v), /narrow width first/, v);
});

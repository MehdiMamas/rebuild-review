import test from 'node:test';
import assert from 'node:assert/strict';
import { checkText } from './check-features.mjs';

const src = [{ name: 'a.js', content: 'function computeTheTotalOfAllTheItemsInTheCart(items) { return 1 }' }];
const bad = (t, s = []) => assert.ok(checkText(t, s).length > 0, t);

test('fails on a fence', () => bad('F-1 does a thing\n```js\nx\n```'));
test('fails on a source path', () => bad('The logic lives in src/App.tsx for the list.'));
test('fails on a JSX line', () => bad('  <TaskRow task={t} onClick={go} />'));
test('fails on an import line', () => bad("import React from 'react'"));
test('fails on a verbatim 40 char run', () => bad('Total: computeTheTotalOfAllTheItemsInTheCart(items) is shown', src));
test('passes on plain prose', () => assert.deepEqual(checkText('F-001 Search filters tasks as you type.\nGiven the list, when the user types, then rows narrow.', src), []));
test('passes on a button or route in given/when/then', () => assert.deepEqual(checkText('Given the board, when the user clicks the "Save" button on the /legacy route, then it shows Saved.', src), []));

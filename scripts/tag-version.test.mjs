import { test } from 'node:test'
import assert from 'node:assert/strict'
import { tagProblem } from './tag-version.mjs'

test('a tag that matches the version passes', () => assert.equal(tagProblem('v0.1.5', '0.1.5'), null))
test('a tag one release ahead of plugin.json fails', () => assert.match(tagProblem('v0.1.4', '0.1.3'), /plugin.json says 0.1.3/))
test('a tag that is not a version fails', () => assert.match(tagProblem('latest', '0.1.5'), /not a version tag/))

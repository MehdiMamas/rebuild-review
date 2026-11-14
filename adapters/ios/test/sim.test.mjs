// Unit tests that need no simulator and no Mac. node --test adapters/ios/test/sim.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pickRuntime, compareVersions } from '../sim.mjs';
import { signature, flatten, tapTargets } from '../screen.mjs';
import { runProbes } from '../probes.mjs';
import { nonLocalAddresses } from '../app.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const rt = (version) => ({ name: `iOS ${version}`, version, identifier: `com.apple.CoreSimulator.SimRuntime.iOS-${version.replace('.', '-')}`, isAvailable: true });

test('no runtime installed: stop with the exact runtime name', () => {
  assert.throws(() => pickRuntime({ runtimes: [rt('18.3')] }, { wanted: 'iOS 99.0', sdk: '27.2' }), /iOS 99\.0 is not installed/);
  assert.throws(() => pickRuntime({ runtimes: [] }, { sdk: '27.2' }), /No iOS simulator runtime is installed\. Install the iOS 27\.2 simulator runtime/);
  // a watchOS runtime does not count
  assert.throws(() => pickRuntime({ runtimes: [{ name: 'watchOS 11', version: '11.0', identifier: 'com.apple.CoreSimulator.SimRuntime.watchOS-11-0' }] }, {}), /No iOS simulator runtime/);
});

test('Xcode newer than the runtimes: the newest installed runtime is chosen and flagged', () => {
  const p = pickRuntime({ runtimes: [rt('17.5'), rt('18.3'), rt('18.1')] }, { sdk: '27.2' });
  assert.equal(p.runtime.version, '18.3');
  assert.equal(p.olderThanSdk, true);
  assert.equal(pickRuntime({ runtimes: [rt('27.0')] }, { sdk: '27.0' }).olderThanSdk, false);
  assert.equal(compareVersions('18.10', '18.3') > 0, true);
});

test('the capture refuses off macOS with a plain reason', { skip: process.platform === 'darwin' }, () => {
  const r = spawnSync(process.execPath, [path.join(here, '..', 'capture.mjs'), '--app', 'x', '--out', 'y'], { encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /macOS/);
});

const el = (type, label, x, y, w, h, extra = {}) => ({ type, label, id: '', title: '', value: '', enabled: true, frame: { x, y, w, h }, depth: 1, inNavBar: false, ...extra });
const size = { width: 393, height: 852 };

test('screen identity ignores digits and scroll bars', () => {
  const a = [el(48, 'Total 12', 0, 100, 100, 20), el(26, '', 0, 0, 5, 800)];
  const b = [el(48, 'Total 97', 0, 100, 100, 20)];
  assert.equal(signature(a), signature(b));
  assert.notEqual(signature(a), signature([el(48, 'Other', 0, 100, 100, 20)]));
});

test('probes flag the planted shapes and leave a clean control alone', () => {
  const rows = runProbes({ screens: [{ id: 's', size, elements: [
    el(9, 'Menu', 60, 30, 80, 44), el(9, 'Tiny', 100, 300, 30, 30), el(9, '', 100, 400, 44, 44), el(9, 'Fine', 100, 500, 120, 50), el(48, 'Wide text', 0, 600, 500, 20),
  ] }], taps: [{ screen: 's', name: 'Crash', crashed: true, report: null }], launch: { crashed: false }, notChecked: [] });
  const bad = (p) => rows.filter((r) => r.probe === p && !r.passed).map((r) => r.evidence).join(' | ');
  assert.match(bad('control-under-status-bar'), /Menu/);
  assert.match(bad('tap-target-small'), /Tiny/);
  assert.ok(bad('missing-accessibility-label'));
  assert.match(bad('text-clipped'), /Wide text/);
  assert.ok(bad('crash-on-tap'));
  assert.doesNotMatch(Object.values(rows.filter((r) => !r.passed)).map((r) => r.evidence).join(' | '), /Fine/);
});

test('a launch setting that names another server is found; this machine is not', () => {
  assert.deepEqual(nonLocalAddresses({ launch: { env: { A: 'http://127.0.0.1:8080/x', B: 'http://localhost/y' } } }), []);
  assert.deepEqual(nonLocalAddresses({ launch: { env: { A: 'https://api.example.com/v1' } } }), ['api.example.com']);
});

test('hosts are read as URLs: bare hosts and other servers are found, loopback and deep links are not', () => {
  const f = (env) => nonLocalAddresses({ launch: { env } });
  assert.deepEqual(f({ API_HOST: 'api.example.com' }), ['api.example.com']);
  assert.deepEqual(f({ API_HOST: 'user@db.example.com:5432' }), ['db.example.com']);
  assert.deepEqual(f({ A: 'http://[::1]:8080/x' }), []);
  assert.deepEqual(f({ A: '127.0.0.1:8080', B: 'http://127.0.0.5/x' }), []);
  assert.deepEqual(f({ A: 'https://api.example.com' }), ['api.example.com']);
  assert.deepEqual(f({ A: 'myapp://settings', B: 'myapp://example.com/x' }), []);
});

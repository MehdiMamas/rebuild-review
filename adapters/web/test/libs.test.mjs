// Unit tests for the Linux library preflight: fake ldd output and a fake apt-get, nothing is downloaded.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseLdd, packagesFor, linuxLibs } from '../libs.mjs';

const LDD = `\tlinux-vdso.so.1 (0x00007ffc)\n\tlibnss3.so => not found\n\tlibnspr4.so => not found\n\tlibc.so.6 => /lib/x86_64-linux-gnu/libc.so.6 (0x00007f)\n\tlibnss3.so => not found\n`;
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'rr-libs-test-'));

test('parseLdd lists each missing library once', () => {
  assert.deepEqual(parseLdd(LDD), ['libnss3.so', 'libnspr4.so']);
  assert.deepEqual(parseLdd('\tlibc.so.6 => /lib/libc.so.6 (0x1)\n'), []);
});

test('packagesFor maps names and reports the ones it does not know', () => {
  assert.deepEqual(packagesFor(['libnss3.so', 'libnssutil3.so', 'libnspr4.so', 'libmystery.so.1']), { packages: ['libnss3', 'libnspr4'], unmapped: ['libmystery.so.1'] });
});

test('nothing missing: no download, empty path', () => {
  const calls = [];
  const out = linuxLibs('/x/electron', tmp(), { run: (c) => { calls.push(c); return { status: 0, stdout: '\tlibc.so.6 => /lib/libc.so.6 (0x1)\n' }; } });
  assert.equal(out, '');
  assert.deepEqual(calls, ['ldd']);
});

test('a library with no package stops with its name', () => {
  assert.throws(() => linuxLibs('/x/electron', tmp(), { run: () => ({ status: 0, stdout: '\tlibmystery.so.1 => not found\n' }) }), /libmystery\.so\.1/);
});

test('no apt-get or no network stops with the missing list and the first error line', () => {
  const run = (c) => (c === 'ldd' ? { status: 0, stdout: LDD } : { status: 100, stderr: 'E: Could not resolve host\nsecond line' });
  assert.throws(() => linuxLibs('/x/electron', tmp(), { run }), (e) => /libnss3\.so, libnspr4\.so/.test(e.message) && /Could not resolve host/.test(e.message) && !/second line/.test(e.message));
  const noApt = (c) => (c === 'ldd' ? { status: 0, stdout: LDD } : { status: null, error: new Error('spawn apt-get ENOENT') });
  assert.throws(() => linuxLibs('/x/electron', tmp(), { run: noApt }), /ENOENT/);
});

test('downloaded packages are unpacked and the lib folders returned', () => {
  const dir = tmp();
  let unpacked = false;
  const run = (c, a, o) => {
    if (c === 'ldd') return { status: 0, stdout: unpacked ? '' : LDD };
    if (c === 'apt-get') { fs.writeFileSync(path.join(o.cwd, `${a[1]}_1_amd64.deb`), 'x'); return { status: 0 }; }
    fs.mkdirSync(path.join(a[2], 'usr/lib/x86_64-linux-gnu'), { recursive: true }); unpacked = true; return { status: 0 };
  };
  const out = linuxLibs('/x/electron', dir, { run });
  assert.equal(out.split(':')[0], path.join(dir, 'root/usr/lib/x86_64-linux-gnu'));
  assert.deepEqual(fs.readdirSync(dir).filter((f) => f.endsWith('.deb')), []);
});

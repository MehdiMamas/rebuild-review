// Unit tests for the sandbox tool check: fake run(), fake platform and PATH, nothing is downloaded.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { sandboxTools } from './sandbox-deps.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'sandbox-deps-test-'));
const touch = (p) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, ''); };

// A fake machine. onPath: tools in a PATH folder. probe(toolPath, tool): a spawnSync-like result for the probe (default works).
// apt: 'ok' | 'none' (no apt-get) | 'lists' (empty package lists) | 'fail'. Unpacked packages create usr/bin/<tool>.
function machine({ onPath = [], probe, apt = 'ok', ldd = {} } = {}) {
  const bin = tmp(), cache = path.join(tmp(), 'sandbox');
  for (const t of onPath) touch(path.join(bin, t));
  const calls = [];
  const run = (cmd, args, opts = {}) => {
    calls.push([cmd, ...args].join(' '));
    if (cmd === 'apt-get') {
      if (apt === 'none') return { status: null, error: Object.assign(new Error('spawn apt-get ENOENT'), { code: 'ENOENT' }) };
      if (apt === 'lists') return { status: 100, stderr: `E: Package '${args[1]}' has no installation candidate\nmore\n` };
      if (apt === 'fail') return { status: 100, stderr: 'E: Failed to fetch http://x 503\nmore\n' };
      touch(path.join(opts.cwd, `${args[1]}_1_amd64.deb`));
      return { status: 0 };
    }
    if (cmd === 'dpkg') {
      const pkg = path.basename(args[1]).split('_')[0];
      touch(path.join(args[2], 'usr', 'bin', pkg === 'bubblewrap' ? 'bwrap' : pkg));
      touch(path.join(args[2], 'usr', 'lib', 'x86_64-linux-gnu', `${pkg}.so`));
      return { status: 0 };
    }
    if (cmd === 'ldd') return { status: 0, stdout: ldd[path.basename(args[0])] || '' };
    const tool = path.basename(cmd);
    return (probe && probe(cmd, tool)) || { status: 0, stdout: '' };
  };
  const tools = () => sandboxTools(cache, { platform: 'linux', path: bin, run });
  return { bin, cache, calls, run, tools };
}
const downloads = (m) => m.calls.filter((c) => c.startsWith('apt-get'));

test('given a machine that is not Linux -> the check does nothing and exits 0', () => {
  const calls = [];
  assert.deepEqual(sandboxTools(path.join(tmp(), 'c'), { platform: 'darwin', path: '', run: (...a) => { calls.push(a); return { status: 1 }; } }), { bin: '', libs: '' });
  assert.equal(calls.length, 0);
  const r = spawnSync(process.execPath, [new URL('./sandbox-deps.mjs', import.meta.url).pathname], { env: { PATH: '', XDG_CACHE_HOME: tmp(), RR_SANDBOX_PLATFORM: 'darwin' }, encoding: 'utf8' });
  assert.equal(r.status, 0);
});

test('given bwrap and socat on PATH and the probe works -> exits 0 and downloads nothing', () => {
  const m = machine({ onPath: ['bwrap', 'socat'] });
  assert.deepEqual(m.tools(), { bin: '', libs: '' });
  assert.equal(downloads(m).length, 0);
  assert.ok(m.calls.some((c) => c.endsWith('bwrap --ro-bind / / --proc /proc --dev /dev --unshare-all true')));
  assert.ok(m.calls.some((c) => c.endsWith('socat -V')));
});

test('given PATH without bwrap and socat and no apt-get -> exits 1 naming both tools and the install line, before any phase', () => {
  const m = machine({ apt: 'none' });
  assert.throws(() => m.tools(), /bwrap and socat[\s\S]*sudo apt-get install bubblewrap socat/);
});

test('given PATH without bwrap and socat and apt-get works -> the packages are downloaded and unpacked into the cache, the check passes, a second run downloads nothing', () => {
  const m = machine();
  const out = m.tools();
  assert.equal(out.bin, path.join(m.cache, 'root', 'usr', 'bin'));
  assert.ok(out.libs.includes(path.join(m.cache, 'root', 'usr', 'lib', 'x86_64-linux-gnu')));
  assert.deepEqual(downloads(m), ['apt-get download bubblewrap', 'apt-get download socat']);
  assert.deepEqual(fs.readdirSync(m.cache), ['root']);
  const before = m.calls.length;
  assert.deepEqual(m.tools(), out);
  assert.equal(downloads(m).length, 2);
  assert.ok(m.calls.length > before);
});

test('given bwrap present but the probe fails -> exits 1 with the first error line and the user-namespace hint, nothing downloaded', () => {
  const m = machine({ onPath: ['bwrap', 'socat'], probe: (c, t) => t === 'bwrap' ? { status: 1, stderr: 'bwrap: No permissions to create new namespace\nsecond\n' } : null });
  assert.throws(() => m.tools(), (e) => /bwrap: No permissions to create new namespace/.test(e.message) && !/second/.test(e.message) && /kernel\.apparmor_restrict_unprivileged_userns=0/.test(e.message));
  assert.equal(downloads(m).length, 0);
});

test('given a cached bwrap whose probe fails -> the cache is removed and fetched once more; still failing, exits 1 saying a cached copy cannot pass the AppArmor rule', () => {
  const m = machine({ onPath: ['socat'], probe: (c, t) => t === 'bwrap' ? { status: 1, stderr: 'bwrap: denied\n' } : null });
  touch(path.join(m.cache, 'root', 'usr', 'bin', 'bwrap'));
  assert.throws(() => m.tools(), /cached bwrap[\s\S]*outside \/usr\/bin[\s\S]*AppArmor[\s\S]*sudo apt-get install bubblewrap socat/);
  assert.deepEqual(downloads(m), ['apt-get download bubblewrap']);
});

test('given socat present but `socat -V` fails on a missing library -> that library\'s package is added; an unmapped library stops the run naming it', () => {
  const m = machine({ onPath: ['bwrap', 'socat'], ldd: { socat: '\tlibwrap.so.0 => not found\n' }, probe: (c, t) => t === 'socat' && !fs.existsSync(path.join(m.cache, 'root')) ? { status: 127, stderr: 'error while loading shared libraries\n' } : null });
  assert.ok(m.tools().libs.includes(path.join(m.cache, 'root')));
  assert.deepEqual(downloads(m), ['apt-get download libwrap0']);
  const u = machine({ onPath: ['bwrap', 'socat'], ldd: { socat: '\tlibmystery.so.9 => not found\n' }, probe: (c, t) => t === 'socat' ? { status: 127, stderr: 'x\n' } : null });
  assert.throws(() => u.tools(), /libmystery\.so\.9/);
  assert.equal(downloads(u).length, 0);
});

test('given apt-get download fails with empty package lists -> exits 1 saying to run `sudo apt-get update`', () => {
  assert.throws(() => machine({ apt: 'lists' }).tools(), /package lists are empty[\s\S]*sudo apt-get update/);
});

test('given apt-get download fails for another reason -> exits 1 with the package and the first error line', () => {
  const m = machine({ apt: 'fail' });
  assert.throws(() => m.tools(), (e) => /bubblewrap/.test(e.message) && /Failed to fetch http:\/\/x 503/.test(e.message) && !/more/.test(e.message));
  assert.deepEqual(fs.readdirSync(m.cache), []);
});

test('given an arm64 machine -> the cache library folder `aarch64-linux-gnu` is on LD_LIBRARY_PATH', () => {
  const m = machine({ onPath: ['bwrap'] });
  touch(path.join(m.cache, 'root', 'usr', 'bin', 'socat'));
  fs.mkdirSync(path.join(m.cache, 'root', 'usr', 'lib', 'aarch64-linux-gnu'), { recursive: true });
  assert.ok(m.tools().libs.split(':').includes(path.join(m.cache, 'root', 'usr', 'lib', 'aarch64-linux-gnu')));
});

test('given two runs unpacking at once -> each unpacks to its own temp folder and renames; a half-unpacked cache is never used', () => {
  const m = machine();
  const seen = [];
  const run = (cmd, args, opts) => {
    if (cmd === 'dpkg') seen.push(args[2]);
    // While dpkg unpacks, the cache has no root yet; the other run finishes first.
    if (cmd === 'dpkg' && !fs.existsSync(path.join(m.cache, 'root'))) {
      fs.mkdirSync(path.join(m.cache, 'root', 'usr', 'bin'), { recursive: true });
      touch(path.join(m.cache, 'root', 'usr', 'bin', 'bwrap')); touch(path.join(m.cache, 'root', 'usr', 'bin', 'socat'));
    }
    return m.run(cmd, args, opts);
  };
  const out = sandboxTools(m.cache, { platform: 'linux', path: m.bin, run });
  assert.ok(seen.every((d) => path.dirname(d) !== m.cache && path.basename(d) === 'root' && path.basename(path.dirname(d)).startsWith('tmp-')));
  assert.equal(out.bin, path.join(m.cache, 'root', 'usr', 'bin'));
  assert.deepEqual(fs.readdirSync(m.cache), ['root']);
});

test('CLI: an empty PATH on a faked Linux exits 1 naming both tools', () => {
  const r = spawnSync(process.execPath, [new URL('./sandbox-deps.mjs', import.meta.url).pathname], { env: { PATH: '', XDG_CACHE_HOME: tmp(), RR_SANDBOX_PLATFORM: 'linux' }, encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /bwrap and socat/);
  assert.match(r.stderr, /sudo apt-get install bubblewrap socat/);
});

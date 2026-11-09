// iOS parity adapter. node parity.mjs --app <run.json> --tests <dir> --out <results.json>
// Makes its own rr-* simulator, installs the app, and runs every <dir>/F-*.test.yaml as `maestro --udid <device> test <file>`, one by one,
// 120 seconds each in its own process group. Exit code 0 is a pass. Results: a list of { feature, passed, detail }.
import fs from 'node:fs';
import path from 'node:path';
import * as sim from './sim.mjs';
import { maestro } from './driver.mjs';
import { prepare, nonLocalAddresses } from './app.mjs';

const arg = (n) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : undefined; };

async function main() {
  sim.ensureMac();
  const appFile = path.resolve(arg('app') || '');
  const testsDir = path.resolve(arg('tests') || '');
  const out = path.resolve(arg('out') || '');
  const run = JSON.parse(fs.readFileSync(appFile, 'utf8'));
  if (run.platform !== 'ios') throw new Error(`ios adapter cannot run parity for platform "${run.platform}"`);
  const remote = nonLocalAddresses(run);
  if (remote.length && !process.argv.includes('--allow-network')) throw new Error(`The app is set to reach ${remote.join(', ')}, which is not this machine. Run again with --allow-network to allow it.`);
  const ctx = prepare(run, appFile);
  const picked = sim.pickRuntime(sim.listRuntimes(), { wanted: run.device?.runtime, sdk: sim.sdkVersion() });
  const dev = sim.createDevice({ typeName: run.device?.name || 'iPhone 16', runtime: picked.runtime });
  const results = [];
  try {
    sim.boot(dev.udid); sim.overrideStatusBar(dev.udid); sim.install(dev.udid, ctx.appPath);
    for (const file of fs.readdirSync(testsDir).filter((f) => /^F-.*\.test\.ya?ml$/.test(f)).sort()) {
      const r = await maestro(['--udid', dev.udid, 'test', path.join(testsDir, file)], { timeoutMs: 120000 });
      results.push({ feature: file.replace(/\.test\.ya?ml$/, ''), passed: r.code === 0 && !r.timedOut, detail: (r.timedOut ? `timed out after 120 s\n${r.output}` : r.output).split('\n').slice(-20).join('\n') });
    }
  } finally { await sim.shutdownAndDelete(dev.udid); }
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(results, null, 2));
  console.log(`parity: ${results.filter((x) => x.passed).length}/${results.length} passed -> ${out}`);
}
try { await main(); sim.cleanupSync(); process.exit(0); }
catch (e) { sim.cleanupSync(); console.error(`iOS parity stopped: ${e.message}`); process.exit(1); }

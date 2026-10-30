// Android and Flutter capture adapter. node capture.mjs --app <run.json> --out <runDir>/golden [--states states.json]
// run.json: { platform: "android"|"flutter", dir?, install?, build?, start?, address, apk, package, appVersion? }
// dir is relative to the run folder's work/; apk is relative to that dir; start runs the app's local API with PORT set; address is that API.
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execSync } from 'node:child_process';
import { assertLocalhost, sleep, scrub } from '../web/context.mjs';
import { startProxy } from './proxy.mjs';
import { Device, SERIAL, adb, buildEnv, center, ensureAvd, labelBelow, norm, startEmulator } from './driver.mjs';
import { BUDGET, crashProbe, faultProbes, jankProbe, repeatProbe, staticProbes } from './probes.mjs';

const arg = (n) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : undefined; };
const appFile = path.resolve(arg('app') || '');
const out = path.resolve(arg('out') || '');
const statesFile = arg('states');
const run = JSON.parse(fs.readFileSync(appFile, 'utf8'));
if (!['android', 'flutter'].includes(run.platform)) throw new Error(`android adapter cannot capture platform "${run.platform}"`);
const api = assertLocalhost(run.address);
const apiPort = Number(api.port || 80);
const workDir = path.resolve(path.dirname(appFile), 'work', run.dir || '.');
if (await fetch(api.origin).then(() => true, () => false)) throw new Error(`refusing to start: something already answers on ${api.origin}`);

const MAX_SCREENS = 30, MAX_PER_SCREEN = 10, MAX_DEPTH = 4;
const CONFIGS = [['phone', 'light'], ['phone', 'dark'], ['tablet', 'light'], ['tablet', 'dark']];
const notCaptured = [], timings = [], crawlNotes = [];
const write = (f, data) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, typeof data === 'string' ? data : JSON.stringify(data, null, 2)); };
const slug = (s) => (s || 'screen').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'screen';
const env = buildEnv();
for (const key of ['install', 'build']) if (run[key]) execSync(run[key], { cwd: workDir, stdio: 'inherit', env });

let server = null, proxy = null, stopEmu = null;
const stopServer = () => { if (!server) return; try { process.kill(-server.pid); } catch {} server.kill(); };
process.on('exit', stopServer);
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { stopServer(); process.exit(1); });

async function main() {
  if (run.start) {
    server = spawn(run.start, { cwd: workDir, shell: true, detached: true, stdio: 'ignore', env: { ...env, PORT: String(apiPort) } });
    for (let i = 0; ; i++) {
      if (await fetch(api.origin).then(() => true, () => false)) break;
      if (i > 100) throw new Error(`app API did not answer on ${api.origin}`);
      await sleep(300);
    }
  }
  proxy = await startProxy({ apiPort });
  ensureAvd();
  stopEmu = await startEmulator(proxy.port);
  const dev = new Device({ pkg: run.package, proxy });
  const apk = path.resolve(workDir, run.apk);
  adb('install', '-r', apk);
  dev.setActivity();
  adb('logcat', '-c');
  dev.setConfig('phone', 'light');
  const density = dev.density;

  // 1. Crawl: tap (and long-press) every control, register each new screen by the set of texts on it.
  const screens = [], bySig = new Map();
  const sigOf = (nodes) => [...new Set(nodes.flatMap((n) => [n.text && 't:' + norm(n.text), n.desc && 'd:' + norm(n.desc)]).filter(Boolean))].sort().join('|');
  const candidatesOf = (nodes) => {
    const seen = new Set(), list = [];
    nodes.forEach((n, i) => {
      const w = n.bounds[2] - n.bounds[0], h = n.bounds[3] - n.bounds[1];
      // rows of a list are tappable and long-pressable even when the platform does not flag them
      let inList = false; for (let p = n.parent; p >= 0 && !inList; p = nodes[p].parent) inList = nodes[p].scrollable;
      const row = inList && !!n.label;
      if (!(n.clickable || n.longClickable || row) || !n.enabled || n.scrollable || w <= 0 || h <= 0 || (w > 900 && h > 1500)) return;
      const name = n.label || labelBelow(nodes, i) || `(unlabeled ${n.cls.split('.').pop()})`;
      const key = `${n.cls}|${norm(name)}`;
      if (seen.has(key)) return;
      seen.add(key);
      list.push({ name, at: center(n), long: false, canLong: n.longClickable || row });
    });
    return list.slice(0, MAX_PER_SCREEN);
  };
  const register = (nodes, steps, via) => {
    const sig = sigOf(nodes);
    if (!sig || bySig.has(sig)) return null;
    if (screens.length >= MAX_SCREENS) { notCaptured.push(`crawl stopped at ${MAX_SCREENS} screens`); return null; }
    const first = nodes.find((n) => n.text || n.desc);
    const s = { id: slug(first && (first.text || first.desc)), title: first ? first.text || first.desc : '', path: steps, via, nodes, candidates: candidatesOf(nodes), depth: steps.length, sig };
    let id = s.id, k = 2; while (screens.some((x) => x.id === id)) id = `${s.id}-${k++}`; s.id = id;
    bySig.set(sig, s); screens.push(s);
    return s;
  };
  const home = await dev.reopen([]);
  timings.push({ name: 'startup.cold', value: dev.launches[0], unit: 'ms' });
  register(home, [], 'launch');
  for (let qi = 0; qi < screens.length; qi++) {
    const s = screens[qi];
    if (s.depth >= MAX_DEPTH) continue;
    proxy.mark(s.id);
    let at = null; // the screen the app is showing now
    for (const c of s.candidates.flatMap((x) => (x.canLong ? [x, { ...x, long: true }] : [x]))) {
      if (at !== s) { await dev.reopen(s.path); at = s; }
      c.long ? dev.longPress(c.at) : dev.tap(c.at);
      await sleep(900);
      const nodes = await dev.dump();
      const what = `${c.long ? 'long-pressing' : 'tapping'} "${c.name}"`;
      if (!nodes.length) { crawlNotes.push({ screen: s.id, what, leftApp: true }); notCaptured.push(`${s.id}: the app left the screen after ${what}`); at = null; continue; }
      const sig = sigOf(nodes);
      if (process.env.RR_DEBUG) console.error(`[crawl] ${s.id}: ${what} -> ${nodes.length} nodes, ${sig === s.sig ? 'same' : bySig.has(sig) ? 'known' : 'new'} ${sig.slice(0, 80)}`);
      if (sig === s.sig) continue;
      const found = register(nodes, [...s.path, { at: c.at, long: c.long, name: c.name }], `${s.via === 'launch' ? '' : s.via + ' > '}${c.long ? 'long-press ' : ''}${c.name}`);
      // back to this screen: the back key, else a fresh start next time
      dev.key('KEYCODE_BACK'); await sleep(700);
      at = sigOf(await dev.dump()) === s.sig ? s : null;
      if (!found && !bySig.has(sig)) at = null;
    }
  }
  proxy.mark('');

  // 2. Capture every screen at both sizes and both themes.
  const apkBytes = fs.statSync(apk).size;
  timings.push({ name: 'apk.size', value: apkBytes, unit: 'bytes' });
  for (const [size, theme] of CONFIGS) {
    dev.setConfig(size, theme);
    for (const s of screens) {
      proxy.mark(s.id);
      const nodes = await dev.reopen(s.path);
      dev.screenshot(path.join(out, 'screens', s.id, `${size}-${theme}.png`));
      if (size === 'phone' && theme === 'light') {
        s.nodes = nodes.length ? nodes : s.nodes;
        timings.push({ name: `${s.id}.startup`, value: dev.launches.at(-1), unit: 'ms' });
        writeRender(path.join(out, 'screens', s.id), s.nodes, dev.lastXml);
      }
    }
  }
  proxy.mark('');
  dev.setConfig('phone', 'light');

  // 3. Walk states from states.json.
  const stateIds = [];
  if (statesFile) for (const st of JSON.parse(fs.readFileSync(path.resolve(statesFile), 'utf8'))) {
    proxy.clearFaults(); proxy.mark(st.id);
    try {
      for (const step of st.steps) await dev.runStep(step);
      const nodes = await dev.dump();
      dev.screenshot(path.join(out, 'screens', st.id, 'phone-light.png'));
      writeRender(path.join(out, 'screens', st.id), nodes, dev.lastXml);
      stateIds.push(st.id);
    } catch (e) { notCaptured.push(`state ${st.id}: ${scrub(e.message).split('\n')[0]}`); }
  }
  proxy.clearFaults(); proxy.mark('');
  await sleep(2500); // let slow requests drain

  // 4. Probes.
  const probes = [];
  probes.push(...staticProbes(screens, density));
  probes.push(...repeatProbe(proxy.state.har));
  probes.push(...await jankProbe(dev, screens, timings, notCaptured));
  probes.push(...await faultProbes(dev, proxy, screens));
  const logcat = adb('logcat', '-d', '-v', 'threadtime');
  probes.push(...crashProbe(logcat, crawlNotes));
  const errLines = logcat.split('\n').filter((l) => / E /.test(l) && (l.includes(run.package) || /AndroidRuntime|flutter/.test(l))).map(scrub);

  let appVersion = run.appVersion || null;
  if (!appVersion) try { appVersion = (adb('shell', 'dumpsys', 'package', run.package).match(/versionName=(\S+)/) || [])[1] || null; } catch {}
  let model = ''; try { model = adb('shell', 'getprop', 'ro.build.version.sdk').trim(); } catch {}
  write(path.join(out, 'manifest.json'), {
    platform: run.platform, appVersion, address: run.address, package: run.package, androidSdk: model,
    screens: screens.map(({ id, title, via }) => ({ id, title, via })),
    states: stateIds,
    blockedRequests: [...proxy.state.blocked].sort(),
    notCaptured: [...new Set([...notCaptured, ...proxy.state.notCaptured])].sort(),
  });
  write(path.join(out, 'network.har'), { log: { version: '1.2', creator: { name: 'rebuild-review android adapter', version: '1' }, entries: proxy.state.har } });
  write(path.join(out, 'timings.json'), timings);
  write(path.join(out, 'probes.json'), probes);
  write(path.join(out, 'console.log'), errLines.join('\n') + (errLines.length ? '\n' : ''));
  console.log(`captured ${screens.length} screens, ${stateIds.length} states, ${probes.filter((p) => !p.passed).length} probe flags -> ${out}`);
}

function writeRender(dir, nodes, xml) {
  write(path.join(dir, 'render.xml'), xml || '');
  write(path.join(dir, 'render.json'), nodes.map((n) => ({ class: n.cls, text: n.text, label: n.label, id: n.id || undefined, bounds: n.bounds, clickable: n.clickable, longClickable: n.longClickable, scrollable: n.scrollable, enabled: n.enabled })));
  write(path.join(dir, 'a11y.json'), { nodes: nodes.filter((n) => n.label || n.clickable || n.longClickable).map((n) => ({ role: n.cls.split('.').pop(), name: n.label, bounds: n.bounds, actions: [n.clickable && 'click', n.longClickable && 'longClick', n.scrollable && 'scroll'].filter(Boolean), enabled: n.enabled })) });
}

let code = 0;
try { await main(); } catch (e) { console.error(e.stack || e.message); code = 1; }
finally {
  if (stopEmu) await stopEmu();
  if (proxy) await proxy.close();
  stopServer();
}
process.exit(code);

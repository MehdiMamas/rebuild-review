// iOS capture adapter (simulator only, macOS only).
// node capture.mjs --app <run.json> --out <runDir>/golden [--states states.json] [--max-screens N] [--max-buttons N] [--allow-network] [--single-size]
// A screen is one accessibility hierarchy, identified by a signature (types, labels, identifiers, digits blanked). The crawl taps buttons, links,
// cells and tabs; a new signature is a new screen with the `steps` that reach it. To come back to a screen the app is relaunched and the steps replayed.
// Screenshots are taken on the run's device and an SE-class device, light and dark. See DRIVING.md.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { scrub } from '../web/context.mjs';
import * as sim from './sim.mjs';
import * as drv from './driver.mjs';
import { prepare, extensions, executableName, appBytes, nonLocalAddresses } from './app.mjs';
import { signature, tapTargets, hasSecureField, nameOf, render, a11yOutline, T } from './screen.mjs';
import { runProbes } from './probes.mjs';

const arg = (n) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : undefined; };
const flag = (n) => process.argv.includes(`--${n}`);
const sleep = drv.sleep;
const write = (f, data) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, typeof data === 'string' ? data : JSON.stringify(data, null, 2)); };
const slug = (s) => String(s || '').toLowerCase().replace(/[^\w]+/g, '-').replace(/^-|-$/g, '');
const median = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
const LARGE = 'accessibility-extra-extra-extra-large';
const SECONDARY = 'iPhone SE (3rd generation)';

async function main() {
  sim.ensureMac();
  const appFile = path.resolve(arg('app') || '');
  const out = path.resolve(arg('out') || '');
  const statesFile = arg('states');
  const run = JSON.parse(fs.readFileSync(appFile, 'utf8'));
  if (run.platform !== 'ios') throw new Error(`ios adapter cannot capture platform "${run.platform}"`);
  const MAX_SCREENS = Number(arg('max-screens')) || 30;
  const MAX_BUTTONS = Number(arg('max-buttons')) || 10;
  const bundle = run.bundleId;
  const launchArgs = run.launch?.args || [];
  const launchEnv = { ...(run.env || {}), ...(run.launch?.env || {}) };

  const remote = nonLocalAddresses(run);
  if (remote.length && !flag('allow-network')) throw new Error(`The app is set to reach ${remote.join(', ')}, which is not this machine. The simulator shares this machine's network and cannot block it. Run again with --allow-network to allow it.`);

  const ctx = prepare(run, appFile);
  const sdk = sim.sdkVersion();
  const picked = sim.pickRuntime(sim.listRuntimes(), { wanted: run.device?.runtime, sdk });
  const primaryName = run.device?.name || 'iPhone 16';
  const exe = executableName(ctx.appPath);
  const exts = extensions(ctx.appPath);

  const notCaptured = [], cutScreens = [], skipped = [], timings = [], screens = [], taps = [];
  const used = new Set();
  const uniqueId = (want) => { const b = want || 'screen'; let id = b, n = 2; while (used.has(id)) id = `${b}-${n++}`; used.add(id); return id; };
  const bySig = new Map();
  let launchInfo = { crashed: false };

  // ---- primary device ----
  const dev = sim.createDevice({ typeName: primaryName, runtime: picked.runtime });
  sim.boot(dev.udid); sim.overrideStatusBar(dev.udid);
  sim.install(dev.udid, ctx.appPath);
  const log = sim.startLog(dev.udid, bundle);
  const driver = await drv.startDriver(dev.udid, bundle);

  const tapAt = async (e) => { const c = drv.center(e); await drv.tap(c.x, c.y); };
  const findByStep = (els, step) => {
    const same = els.filter((e) => nameOf(e) === step.click);
    return same[step.index || 0] || null;
  };
  // Launch fresh and replay steps; returns the settled hierarchy.
  async function open(udid, steps) {
    sim.launch(udid, bundle, { args: launchArgs, env: launchEnv });
    let h = await drv.settled(bundle);
    for (const st of steps) {
      if (st.click !== undefined) { const e = findByStep(h.elements, st); if (!e) throw new Error(`"${st.click}" was not found on the screen`); await tapAt(e); await sleep(900); h = await drv.settled(bundle); }
      else if (st.type) { const e = h.elements.find((x) => nameOf(x) === st.type.into); if (!e) throw new Error(`field "${st.type.into}" was not found`); await tapAt(e); await sleep(400); await drv.typeText(bundle, st.type.text); await sleep(400); h = await drv.settled(bundle); }
      else if (st.wait !== undefined) { await sleep(Number(st.wait)); h = await drv.settled(bundle); }
      else throw new Error(`step not understood: ${JSON.stringify(st).slice(0, 60)}`);
    }
    return h;
  }
  const headingOf = (h) => {
    const e = h.elements.find((x) => x.type === T.staticText && x.inNavBar && x.label) || h.elements.find((x) => x.type === T.staticText && x.label);
    return slug(e?.label);
  };
  const register = (h, steps, sig, wantId, extra = {}) => {
    const id = uniqueId(wantId || headingOf(h) || 'screen');
    const s = { id, steps, sig, h, ...extra };
    screens.push(s); bySig.set(sig, s);
    return s;
  };

  // Launch time: median of 5 cold launches, each until the first elements appear.
  const launchMs = [];
  for (let i = 0; i < 5; i++) {
    sim.terminate(dev.udid, bundle); await sleep(300);
    const t = Date.now();
    sim.launch(dev.udid, bundle, { args: launchArgs, env: launchEnv });
    let ok = false;
    for (let k = 0; k < 100; k++) { try { if ((await drv.hierarchy(bundle)).elements.length) { ok = true; break; } } catch {} if (!sim.isRunning(dev.udid, bundle)) break; await sleep(100); }
    if (!ok) { launchInfo = { crashed: !sim.isRunning(dev.udid, bundle), report: sim.crashReport(exe, t - 1000) }; break; }
    launchMs.push(Date.now() - t);
  }
  if (launchMs.length) timings.push({ name: 'launch-ms', value: median(launchMs), unit: 'ms' });

  let root = null;
  if (!launchInfo.crashed) {
    const h0 = await open(dev.udid, []);
    root = register(h0, [], signature(h0.elements), headingOf(h0) || 'launch');
  } else notCaptured.push('the app did not stay running after launch; nothing else could be captured');

  // ---- crawl ----
  for (let qi = 0; qi < screens.length; qi++) {
    const item = screens[qi];
    if (item.state) continue;
    const targets = tapTargets(item.h.elements, item.h.size);
    const take = targets.slice(0, MAX_BUTTONS);
    for (const t of targets.slice(MAX_BUTTONS)) skipped.push(`${item.id}: ${nameOf(t) || typeNameOf(t)}`);
    let at = qi === 0 && !launchInfo.crashed; // only the first screen is on show: the app was just launched; after that it is somewhere else
    for (const t of take) {
      const name = nameOf(t);
      const sameName = item.h.elements.filter((e) => nameOf(e) === name);
      const step = { click: name, ...(sameName.length > 1 ? { index: sameName.indexOf(t) } : {}) };
      try {
        let cur = item.h;
        if (!at) { cur = await open(dev.udid, item.steps); if (signature(cur.elements) !== item.sig) { notCaptured.push(`${item.id}: could not come back to the screen after "${name}"`); continue; } }
        const target = (name ? findByStep(cur.elements, step) : null) || t;
        const t0 = Date.now();
        await tapAt(target);
        await sleep(1000);
        if (!sim.isRunning(dev.udid, bundle)) {
          taps.push({ screen: item.id, name: name || '(no label)', crashed: true, report: sim.crashReport(exe, t0 - 1000) });
          at = false; continue;
        }
        const h2 = await drv.settled(bundle);
        const ms = Date.now() - t0;
        taps.push({ screen: item.id, name: name || '(no label)', crashed: false });
        const sig = signature(h2.elements);
        if (sig === item.sig) { at = true; continue; }
        at = false;
        if (bySig.has(sig)) continue;
        if (screens.length >= MAX_SCREENS) { cutScreens.push(`${item.id} > ${name}`); continue; }
        const s = register(h2, [...item.steps, step], sig);
        timings.push({ name: `${s.id}.tap-to-screen-ms`, value: ms, unit: 'ms' });
      } catch (e) { notCaptured.push(`${item.id} > ${name}: ${scrub(e.message).split('\n')[0]}`); at = false; }
    }
  }

  // ---- states.json ----
  const stateIds = [];
  if (statesFile && !launchInfo.crashed) {
    for (const st of JSON.parse(fs.readFileSync(path.resolve(statesFile), 'utf8'))) {
      try {
        const steps = (st.steps || []).map((x) => (x.click !== undefined ? { click: x.click, ...(x.index ? { index: x.index } : {}) } : x));
        const h = await open(dev.udid, steps);
        const s = register(h, steps, `state:${st.id}`, slug(st.id) || 'state', { state: true });
        stateIds.push(s.id);
      } catch (e) { notCaptured.push(`state ${st.id}: ${scrub(e.message).split('\n')[0]}`); }
    }
  }

  // ---- per screen: files, screenshots, large text ----
  const sizeName = slug(primaryName);
  const shoot = async (udid, s, nameOfSize, themeNote) => {
    const dir = path.join(out, 'screens', s.id);
    const png = {};
    for (const theme of ['light', 'dark']) {
      sim.setAppearance(udid, theme); await sleep(theme === 'dark' ? 900 : 600);
      const f = path.join(dir, `${nameOfSize}-${theme}.png`);
      sim.screenshot(udid, f); png[theme] = fs.readFileSync(f);
    }
    sim.setAppearance(udid, 'light');
    if (png.light.equals(png.dark)) notCaptured.push(`${s.id} ${nameOfSize}: theme did not change`);
  };
  const forProbes = [];
  for (const s of screens) {
    try {
      const h = await open(dev.udid, s.steps);
      if (!s.state && signature(h.elements) !== s.sig) throw new Error('the screen was not the same when reached again');
      s.h = h;
      const dir = path.join(out, 'screens', s.id);
      write(path.join(dir, 'render.json'), render(h.elements, h.size, dev.typeName));
      write(path.join(dir, 'a11y.json'), a11yOutline(h.elements));
      await shoot(dev.udid, s, sizeName);
      let large = null;
      try {
        sim.setContentSize(dev.udid, LARGE);
        const hl = await open(dev.udid, s.steps);
        large = { size: hl.size, elements: hl.elements };
      } catch (e) { notCaptured.push(`${s.id}: large text size: ${scrub(e.message).split('\n')[0]}`); }
      finally { try { sim.setContentSize(dev.udid, 'large'); } catch {} }
      forProbes.push({ id: s.id, size: h.size, elements: h.elements, ...(large ? { large } : {}) });
    } catch (e) { notCaptured.push(`${s.id}: ${scrub(e.message).split('\n')[0]}`); forProbes.push({ id: s.id, size: s.h.size, elements: s.h.elements }); }
  }
  sim.terminate(dev.udid, bundle);
  const written = sim.readContainer(dev.udid, bundle);
  const consoleLines = log.lines();
  log.stop(); driver.stop();
  await sim.shutdownAndDelete(dev.udid);

  // ---- second device size ----
  const devices = [{ name: primaryName, size: sizeName }];
  if (!flag('single-size') && primaryName !== SECONDARY && screens.length) {
    let d2 = null, driver2 = null;
    try {
      d2 = sim.createDevice({ typeName: SECONDARY, runtime: picked.runtime });
      sim.boot(d2.udid); sim.overrideStatusBar(d2.udid); sim.install(d2.udid, ctx.appPath);
      driver2 = await drv.startDriver(d2.udid, bundle);
      const n2 = slug(SECONDARY);
      for (const s of screens) {
        try { await open(d2.udid, s.steps); await shoot(d2.udid, s, n2); } catch (e) { notCaptured.push(`${s.id} ${n2}: ${scrub(e.message).split('\n')[0]}`); }
      }
      devices.push({ name: SECONDARY, size: n2 });
    } catch (e) { notCaptured.push(`${SECONDARY}: could not be used: ${scrub(e.message).split('\n')[0]}`); }
    finally { if (driver2) driver2.stop(); if (d2) await sim.shutdownAndDelete(d2.udid); }
  } else if (!flag('single-size') && primaryName === SECONDARY) { /* the run's own device is the small one */ }

  // ---- probes ----
  const notChecked = [];
  const probes = runProbes({ screens: forProbes, taps, launch: launchInfo, notChecked });

  // ---- write the golden folder ----
  if (ctx.buildMs !== null) timings.push({ name: 'build-ms', value: ctx.buildMs, unit: 'ms' });
  timings.push({ name: 'app-bytes', value: appBytes(ctx.appPath), unit: 'bytes' });
  const signIn = root && hasSecureField(root.h.elements);
  if (signIn) notCaptured.push('the app asks for a sign-in at launch: the sign-in screen is the capture and the screens behind it were not reached');
  if (exts.length) notCaptured.push(`main app only: ${exts.join(', ')} ${exts.length > 1 ? 'are' : 'is'} not captured`);
  if (picked.olderThanSdk) notCaptured.push(`the newest installed iOS runtime is ${picked.runtime.name}, older than the iOS ${sdk} SDK`);
  notCaptured.push('network not blocked: iOS simulator shares the host network');
  notCaptured.push('iOS: crash reports and system logs outside the app are not captured');
  notCaptured.push('network.har is empty: requests are not observed');

  let appVersion = run.appVersion || null;
  if (!appVersion) { try { const { spawnSync } = await import('node:child_process'); appVersion = spawnSync('plutil', ['-extract', 'CFBundleShortVersionString', 'raw', path.join(ctx.appPath, 'Info.plist')], { encoding: 'utf8' }).stdout.trim() || null; } catch {} }
  write(path.join(out, 'manifest.json'), scrub(JSON.stringify({
    platform: 'ios', appVersion, bundleId: bundle,
    versions: { xcode: sim.xcodeVersion(), sdk, runtime: picked.runtime.name, runtimeVersion: picked.runtime.version, runtimeOlderThanSdk: picked.olderThanSdk, maestro: drv.maestroVersion() },
    devices,
    screens: screens.map(({ id, steps, state }) => ({ id, steps, ...(state ? { state: true } : {}) })),
    states: stateIds,
    network: { blocked: false, note: 'iOS simulator shares the host network' },
    blockedRequests: [],
    extensions: exts,
    notCaptured: [...notCaptured, ...notChecked.map((r) => `${r.probe} ${r.route}: ${r.reason}`)],
  }, null, 2)));
  write(path.join(out, 'network.har'), { log: { version: '1.2', creator: { name: 'rebuild-review ios adapter', version: '1' }, entries: [] } });
  write(path.join(out, 'coverage.json'), {
    caps: { maxScreens: MAX_SCREENS, maxButtons: MAX_BUTTONS }, screensReached: screens.map((s) => s.id), screensCut: cutScreens, sameRouteSkipped: [], buttonsSkipped: skipped, harEntriesSkipped: 0,
    ...(signIn ? { signInRequired: true, unreached: 'everything behind the sign-in screen' } : {}),
  });
  write(path.join(out, 'timings.json'), timings);
  write(path.join(out, 'probes.json'), probes);
  write(path.join(out, 'probes-not-checked.json'), notChecked);
  write(path.join(out, 'written.json'), written);
  write(path.join(out, 'console.log'), consoleLines.join('\n') + (consoleLines.length ? '\n' : ''));
  console.log(`captured ${screens.length} screens, ${stateIds.length} states, ${probes.filter((p) => !p.passed).length} probe flags -> ${out}`);
}
const typeNameOf = (e) => `type ${e.type}`;

try { await main(); sim.cleanupSync(); process.exit(0); }
catch (e) { sim.cleanupSync(); console.error(`iOS capture stopped: ${e.message}`); process.exit(1); }

// General probes for a captured Android app. Each is one kind of failure with one budget, not a check for a known app.
// Result: list of { probe, screen, passed, evidence }; passed=false means the probe flagged a problem.
import { sleep, scrub } from '../web/context.mjs';
import { adb, center, labelBelow, norm } from './driver.mjs';

export const BUDGET = { touchDp: 48, jankyPct: 25, minFrames: 20, repeatCount: 5, repeatWindowMs: 2000, slowMs: 3000 };
const ERROR_TEXT = /error|fail|could ?n.?t|could not|unable|try again|retry|went wrong|offline|invalid|not saved/i;
const LOADING_TEXT = /load|wait|saving|sending|submitting|progress|spinner|busy|please/i;
const dp = (px, density) => Math.round((px * 160) / density);
const verdict = (probe, flags, okEvidence) => (flags.length ? flags : [{ probe, screen: '*', passed: true, evidence: okEvidence }]);

// Touch targets under 48 dp, and interactive elements with no label (own text or description, or any descendant's).
export function staticProbes(screens, density) {
  const small = [], unlabeled = [], seen = new Set();
  for (const s of screens) s.nodes.forEach((n, i) => {
    if (!(n.clickable || n.longClickable) || !n.enabled || n.scrollable) return;
    const w = n.bounds[2] - n.bounds[0], h = n.bounds[3] - n.bounds[1];
    if (w <= 0 || h <= 0 || (w > 900 && h > 1500)) return;
    const label = n.label || labelBelow(s.nodes, i);
    const key = `${s.id}|${n.cls}|${norm(label)}|${w}x${h}`;
    if (seen.has(key)) return;
    seen.add(key);
    if (dp(Math.min(w, h), density) < BUDGET.touchDp) small.push({ probe: 'small-touch-target', screen: s.id, passed: false, evidence: `"${label || n.cls}" is ${dp(w, density)}x${dp(h, density)} dp, under ${BUDGET.touchDp} dp (${n.cls} at ${n.bounds.join(',')})` });
    if (!label) unlabeled.push({ probe: 'unlabeled-control', screen: s.id, passed: false, evidence: `${n.cls} at ${n.bounds.join(',')} is interactive and has no text or description` });
  });
  return [...verdict('small-touch-target', small, `no interactive element under ${BUDGET.touchDp} dp`), ...verdict('unlabeled-control', unlabeled, 'every interactive element has a label')];
}

// Crash or ANR in logcat (also errors a Flutter app logs as uncaught), plus any time the app left the screen after a tap.
export function crashProbe(logcat, crawlNotes) {
  const flags = [];
  const lines = logcat.split('\n');
  const hit = (re, what) => { const l = lines.find((x) => re.test(x)); if (l) flags.push({ probe: 'crash-anr', screen: '*', passed: false, evidence: `${what}: ${scrub(l.trim()).slice(0, 200)}` }); };
  hit(/FATAL EXCEPTION/, 'crash');
  hit(/ANR in /, 'ANR');
  hit(/ flutter\s*:.*(EXCEPTION CAUGHT|Unhandled Exception)|E\/flutter.*(EXCEPTION CAUGHT|Unhandled Exception)/, 'uncaught Flutter error');
  for (const n of crawlNotes.filter((x) => x.leftApp)) flags.push({ probe: 'crash-anr', screen: n.screen, passed: false, evidence: `the app left the screen after ${n.what}` });
  return verdict('crash-anr', flags, 'no crash, ANR or uncaught error in logcat');
}

// The same request sent many times in a short window while one screen was open.
export function repeatProbe(har) {
  const flags = [], groups = new Map();
  for (const e of har) { const k = `${e._screen}|${e.request.method} ${e.request.url.split('?')[0]}`; (groups.get(k) || groups.set(k, []).get(k)).push(e._t); }
  for (const [k, ts] of groups) {
    ts.sort((a, b) => a - b);
    for (let i = 0; i + BUDGET.repeatCount - 1 < ts.length; i++) if (ts[i + BUDGET.repeatCount - 1] - ts[i] <= BUDGET.repeatWindowMs) {
      const [screen, req] = k.split('|');
      flags.push({ probe: 'repeat-requests', screen, passed: false, evidence: `${req} sent ${BUDGET.repeatCount}+ times within ${BUDGET.repeatWindowMs} ms while the screen was open` });
      break;
    }
  }
  return verdict('repeat-requests', flags, 'no request repeated in a short window');
}

// Dropped frames: scripted scroll on each scrollable screen, frames read from gfxinfo.
export async function jankProbe(dev, screens, timings, notCaptured) {
  const flags = [];
  let measured = 0;
  for (const s of screens.filter((x) => x.nodes.some((n) => n.scrollable && n.bounds[3] - n.bounds[1] > 900))) {
    await dev.reopen(s.path);
    let frames = 0, janky = 0;
    for (let attempt = 0; attempt < 3 && frames < BUDGET.minFrames; attempt++) {
      await sleep(800);
      adb('shell', 'dumpsys', 'gfxinfo', dev.pkg, 'reset');
      for (const d of [1, 1, 1, -1, -1, -1]) { d > 0 ? dev.swipe(540, 1800, 540, 600, 300) : dev.swipe(540, 600, 540, 1800, 300); await sleep(150); }
      await sleep(500);
      const g = adb('shell', 'dumpsys', 'gfxinfo', dev.pkg);
      frames = Number((g.match(/Total frames rendered:\s*(\d+)/) || [])[1] || 0);
      janky = Number((g.match(/Janky frames:\s*(\d+)/) || [])[1] || 0);
    }
    if (frames < BUDGET.minFrames) { notCaptured.push(`dropped frames on ${s.id}: gfxinfo reported only ${frames} frames for the scroll, so it cannot be measured`); continue; }
    measured++;
    const pct = Math.round((janky / frames) * 1000) / 10;
    timings.push({ name: `${s.id}.scroll.jankyFramesPct`, value: pct, unit: '%' }, { name: `${s.id}.scroll.frames`, value: frames, unit: 'frames' });
    if (pct > BUDGET.jankyPct) flags.push({ probe: 'dropped-frames', screen: s.id, passed: false, evidence: `${janky} of ${frames} frames janky (${pct}%) during a scripted scroll, over ${BUDGET.jankyPct}%` });
  }
  return verdict('dropped-frames', flags, measured ? 'scroll stayed within the frame budget' : 'no scroll could be measured');
}

// Each tap on each screen with every request failing (is an error shown?) and with every request slow (is there feedback?).
export async function faultProbes(dev, proxy, screens) {
  const noError = [], noFeedback = [];
  const st = proxy.state;
  const texts = (nodes) => nodes.flatMap((n) => [n.text, n.desc]).filter(Boolean);
  const waitIdle = async () => { for (let i = 0; i < 20 && st.inflight > 0; i++) await sleep(300); };
  for (const s of screens) for (const c of s.candidates.filter((x) => !x.long)) {
    for (const mode of ['fail', 'slow']) {
      proxy.clearFaults(); await waitIdle();
      proxy.mark(`${s.id}:${mode}`);
      const before = await dev.reopen(s.path);
      const sigBefore = texts(before).map(norm).sort().join('|');
      const failedBefore = st.failed;
      mode === 'fail' ? proxy.fail('') : proxy.slow('', BUDGET.slowMs);
      dev.tap(c.at);
      await sleep(mode === 'fail' ? 1800 : 700);
      const after = await dev.dump();
      if (mode === 'fail' && st.failed > failedBefore && !texts(after).some((t) => ERROR_TEXT.test(t)))
        noError.push({ probe: 'failed-request-no-error', screen: s.id, passed: false, evidence: `after tapping "${c.name}" ${st.failed - failedBefore} request(s) failed and no error text is visible` });
      if (mode === 'slow' && st.inflight > 0) {
        const sigAfter = texts(after).map(norm).sort().join('|');
        const busy = after.some((n) => /ProgressBar/.test(n.cls)) || texts(after).some((t) => LOADING_TEXT.test(t));
        if (!busy && sigAfter === sigBefore) noFeedback.push({ probe: 'no-feedback-slow', screen: s.id, passed: false, evidence: `after tapping "${c.name}" a request is still waiting (${BUDGET.slowMs} ms delay) and nothing on screen changed or shows loading` });
      }
    }
  }
  proxy.clearFaults(); await waitIdle(); proxy.mark('');
  return [...verdict('failed-request-no-error', noError, 'every failed request showed an error'), ...verdict('no-feedback-slow', noFeedback, 'every slow request showed feedback')];
}

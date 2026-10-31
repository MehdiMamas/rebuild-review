// Page measurements added to timings.json and golden/a11y-violations.json (see ../CONTRACT.md).
import { createRequire } from 'node:module';
import { makeContext, sleep } from './context.mjs';

const AXE = createRequire(import.meta.url).resolve('axe-core/axe.min.js');
// LCP and CLS from the standard performance entries, no library.
const OBSERVE = `(() => {
  window.__rr = { lcp: 0, cls: 0 };
  new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__rr.lcp = e.startTime; }).observe({ type: 'largest-contentful-paint', buffered: true });
  new PerformanceObserver((l) => { for (const e of l.getEntries()) if (!e.hadRecentInput) window.__rr.cls += e.value; }).observe({ type: 'layout-shift', buffered: true });
})()`;
const round = (v, d = 0) => Math.round(v * 10 ** d) / 10 ** d;

// Per screen: lcp, cls, bytes, heap-mb (wide, light, uncached load) and overflow-narrow (narrow).
// Also axe-core violations per screen and inp-ms from the typing probe rows. Pushes onto timings, returns the a11y rows.
export async function measureScreens({ browser, origin, screens, timings, probes = [] }) {
  const a11y = [];
  for (const s of screens) {
    const url = new URL(s.url, origin).toString();
    {
      const { context } = await makeContext(browser, origin, { viewport: { width: 1440, height: 900 }, colorScheme: 'light' });
      try {
        await context.addInitScript(OBSERVE);
        const page = await context.newPage();
        const cdp = await context.newCDPSession(page);
        await cdp.send('Network.enable');
        await cdp.send('Performance.enable');
        let bytes = 0;
        cdp.on('Network.loadingFinished', (e) => { bytes += e.encodedDataLength || 0; });
        await page.goto(url);
        await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
        await sleep(500);
        const v = await page.evaluate(() => window.__rr);
        const heap = (await cdp.send('Performance.getMetrics')).metrics.find((m) => m.name === 'JSHeapUsedSize');
        timings.push({ name: `${s.id}.lcp`, value: round(v.lcp), unit: 'ms' });
        timings.push({ name: `${s.id}.cls`, value: round(v.cls, 4), unit: 'score' });
        timings.push({ name: `${s.id}.bytes`, value: Math.round(bytes), unit: 'bytes' });
        if (heap) timings.push({ name: `${s.id}.heap-mb`, value: round(heap.value / 1048576, 1), unit: 'MB' });
        await page.addScriptTag({ path: AXE });
        const res = await page.evaluate(() => axe.run());
        a11y.push({ screen: s.id, violations: res.violations.map((x) => ({ id: x.id, impact: x.impact, nodes: x.nodes.length })) });
      } catch (e) { a11y.push({ screen: s.id, violations: [], error: String(e.message).split('\n')[0] }); }
      await context.close();
    }
    {
      const { context } = await makeContext(browser, origin, { viewport: { width: 390, height: 844 }, colorScheme: 'light' });
      try {
        const page = await context.newPage();
        await page.goto(url);
        await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
        const px = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        timings.push({ name: `${s.id}.overflow-narrow`, value: Math.max(0, px), unit: 'px' });
      } catch {}
      await context.close();
    }
  }
  // Stand-in for INP: the slowest input event in the typing probe (one run, not field INP).
  const evt = probes.filter((p) => p.probe === 'input-delay').map((p) => Number((/slowest input event (\d+) ms/.exec(p.evidence) || [])[1]));
  if (evt.length) timings.push({ name: 'inp-ms', value: Math.max(...evt), unit: 'ms' });
  return a11y;
}

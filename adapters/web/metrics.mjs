// Page measurements added to timings.json and golden/a11y-violations.json (see ../CONTRACT.md).
import { createRequire } from 'node:module';
import fs from 'node:fs';
import { sleep } from './context.mjs';

const AXE = createRequire(import.meta.url).resolve('axe-core/axe.min.js');
// LCP and CLS from the standard performance entries, no library.
const OBSERVE = `(() => {
  if (window.__rr) return;
  window.__rr = { lcp: 0, cls: 0 };
  new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__rr.lcp = e.startTime; }).observe({ type: 'largest-contentful-paint', buffered: true });
  new PerformanceObserver((l) => { for (const e of l.getEntries()) if (!e.hadRecentInput) window.__rr.cls += e.value; }).observe({ type: 'layout-shift', buffered: true });
})()`;
const round = (v, d = 0) => Math.round(v * 10 ** d) / 10 ** d;

// Per screen: lcp, cls, bytes, heap-mb (wide, light, uncached load) and overflow-narrow (narrow).
// Also axe-core violations per screen and inp-ms from the typing probe rows. Pushes onto timings, returns the a11y rows.
// open(screen, { width, height, colorScheme }) comes from the adapter and returns { page, close, go }; widths are [narrow, wide].
export async function measureScreens({ open, screens, timings, probes = [], widths = [390, 1440] }) {
  const a11y = [];
  for (const s of screens) {
    {
      let t;
      try {
        t = await open(s, { width: widths[1], height: 900, colorScheme: 'light' });
        await t.page.addInitScript(OBSERVE);
        let page = t.page, cdp = await page.context().newCDPSession(page);
        let bytes = 0;
        const watch = async () => {
          await cdp.send('Network.enable');
          await cdp.send('Performance.enable');
          cdp.on('Network.loadingFinished', (e) => { bytes += e.encodedDataLength || 0; });
        };
        await watch();
        await t.go();
        if (t.page !== page) { page = t.page; cdp = await page.context().newCDPSession(page); await watch(); }
        await page.evaluate(OBSERVE);
        await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
        await sleep(500);
        const v = await page.evaluate(() => window.__rr);
        const heap = (await cdp.send('Performance.getMetrics')).metrics.find((m) => m.name === 'JSHeapUsedSize');
        timings.push({ name: `${s.id}.lcp`, value: round(v.lcp), unit: 'ms' });
        timings.push({ name: `${s.id}.cls`, value: round(v.cls, 4), unit: 'score' });
        timings.push({ name: `${s.id}.bytes`, value: Math.round(bytes), unit: 'bytes' });
        if (heap) timings.push({ name: `${s.id}.heap-mb`, value: round(heap.value / 1048576, 1), unit: 'MB' });
        // evaluated as source, not injected as a script tag, so a page's content security policy cannot block it
        await page.evaluate(fs.readFileSync(AXE, 'utf8'));
        const res = await page.evaluate(() => axe.run());
        a11y.push({ screen: s.id, violations: res.violations.map((x) => ({ id: x.id, impact: x.impact, nodes: x.nodes.length })) });
      } catch (e) { a11y.push({ screen: s.id, violations: [], error: String(e.message).split('\n')[0] }); }
      if (t) await t.close();
    }
    {
      let t;
      try {
        t = await open(s, { width: widths[0], height: 844, colorScheme: 'light' });
        await t.go();
        await t.page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
        const px = await t.page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        timings.push({ name: `${s.id}.overflow-narrow`, value: Math.max(0, px), unit: 'px' });
      } catch {}
      if (t) await t.close();
    }
  }
  // Stand-in for INP: the slowest input event in the typing probe (one run, not field INP).
  const evt = probes.filter((p) => p.probe === 'input-delay').map((p) => Number((/slowest input event (\d+) ms/.exec(p.evidence) || [])[1]));
  if (evt.length) timings.push({ name: 'inp-ms', value: Math.max(...evt), unit: 'ms' });
  return a11y;
}

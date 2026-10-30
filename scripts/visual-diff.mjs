// node visual-diff.mjs <goldenA> <goldenB> <out.json>
// For every screens/<id>/<size>-<theme>.png in both golden folders, writes { screen, size, theme, percent } (share of pixels that differ).
// Screens in only one side are listed in onlyIn. No pass or fail. pixelmatch and pngjs come from adapters/web.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const req = createRequire(new URL('../adapters/web/package.json', import.meta.url));
const pixelmatch = req('pixelmatch');
const { PNG } = req('pngjs');
const pm = pixelmatch.default || pixelmatch;

export function visualDiff(a, b) {
  const list = (g) => {
    const d = path.join(g, 'screens'), found = new Map();
    if (!fs.existsSync(d)) return found;
    for (const screen of fs.readdirSync(d)) {
      if (!fs.statSync(path.join(d, screen)).isDirectory()) continue;
      for (const f of fs.readdirSync(path.join(d, screen))) {
        const m = f.match(/^(\d+)-(\w+)\.png$/);
        if (m) found.set(`${screen}/${f}`, { screen, size: Number(m[1]), theme: m[2], file: path.join(d, screen, f) });
      }
    }
    return found;
  };
  const A = list(a), B = list(b);
  const diffs = [], onlyIn = [];
  for (const [k, x] of [...A].sort()) {
    const y = B.get(k);
    if (!y) { onlyIn.push({ side: 'a', screen: x.screen, size: x.size, theme: x.theme }); continue; }
    const p = PNG.sync.read(fs.readFileSync(x.file)), q = PNG.sync.read(fs.readFileSync(y.file));
    let percent;
    if (p.width !== q.width || p.height !== q.height) percent = 100;
    else percent = (pm(p.data, q.data, null, p.width, p.height, { threshold: 0.1 }) / (p.width * p.height)) * 100;
    diffs.push({ screen: x.screen, size: x.size, theme: x.theme, percent: Math.round(percent * 1000) / 1000 });
  }
  for (const [k, y] of [...B].sort()) if (!A.has(k)) onlyIn.push({ side: 'b', screen: y.screen, size: y.size, theme: y.theme });
  return { diffs, onlyIn };
}

if (process.argv[1] && path.resolve(process.argv[1]) === new URL(import.meta.url).pathname) {
  const [a, b, out] = process.argv.slice(2);
  if (!a || !b || !out) { console.error('usage: node visual-diff.mjs <goldenA> <goldenB> <out.json>'); process.exit(2); }
  const r = visualDiff(a, b);
  fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(r, null, 2));
  console.log(`visual-diff: ${r.diffs.length} compared, ${r.onlyIn.length} only on one side -> ${out}`);
}

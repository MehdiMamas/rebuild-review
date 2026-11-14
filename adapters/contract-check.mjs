// Shared test helper: checks that a golden/ folder has the layout adapters/CONTRACT.md promises.
// Platform-neutral on purpose; the web and android tests both call it. Returns a list of problems (empty = fine).
import fs from 'node:fs';
import path from 'node:path';

const readJson = (f, problems) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { problems.push(`${path.basename(f)} missing or not JSON`); return null; } };

export function checkGolden(dir) {
  const problems = [];
  const manifest = readJson(path.join(dir, 'manifest.json'), problems);
  if (manifest) {
    for (const k of ['platform', 'address', 'screens', 'states', 'blockedRequests', 'notCaptured']) if (!(k in manifest)) problems.push(`manifest.json lacks ${k}`);
    if (!Array.isArray(manifest.screens) || !manifest.screens.length) problems.push('manifest.json has no screens');
    const ids = [...(manifest.screens || []).map((s) => s.id), ...(manifest.states || [])];
    for (const id of ids) {
      const sd = path.join(dir, 'screens', id);
      if (!fs.existsSync(sd)) { problems.push(`screens/${id} missing`); continue; }
      const files = fs.readdirSync(sd);
      if (!files.some((f) => f.startsWith('render.'))) problems.push(`screens/${id} has no render.* file`);
      if (!files.includes('a11y.json')) problems.push(`screens/${id} has no a11y.json`);
      const shots = files.filter((f) => /^\w+-(light|dark)\.png$/.test(f) || /^\d+-(light|dark)\.png$/.test(f));
      if (!shots.length) problems.push(`screens/${id} has no <size>-<theme>.png`);
    }
    const sizes = new Set(), themes = new Set();
    for (const id of ids) {
      const sd = path.join(dir, 'screens', id);
      if (!fs.existsSync(sd)) continue;
      for (const f of fs.readdirSync(sd)) { const m = f.match(/^(\w+)-(light|dark)\.png$/); if (m) { sizes.add(m[1]); themes.add(m[2]); } }
    }
    if (sizes.size < 2) problems.push(`screenshots at ${sizes.size} size(s), need a narrow and a wide one`);
    if (themes.size < 2) problems.push('screenshots need light and dark');
  }
  const har = readJson(path.join(dir, 'network.har'), problems);
  if (har && !(har.log && Array.isArray(har.log.entries))) problems.push('network.har lacks log.entries');
  const timings = readJson(path.join(dir, 'timings.json'), problems);
  if (timings && !(Array.isArray(timings) && timings.every((t) => 'name' in t && 'value' in t && 'unit' in t))) problems.push('timings.json is not a list of {name,value,unit}');
  const probes = readJson(path.join(dir, 'probes.json'), problems);
  if (probes && !(Array.isArray(probes) && probes.every((p) => 'probe' in p && 'screen' in p && typeof p.passed === 'boolean' && 'evidence' in p))) problems.push('probes.json is not a list of {probe,screen,passed,evidence}');
  if (!fs.existsSync(path.join(dir, 'console.log'))) problems.push('console.log missing');
  return problems;
}

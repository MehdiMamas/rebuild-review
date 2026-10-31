// Areas: a big app is split into areas inside one run. See AGENTS.md ("Areas").
//   node areas.mjs tree <workDir>                  prints "<lines> <path>" for every counted source file (no contents)
//   node areas.mjs init <runDir>                   one unit of source: writes the single area "all" and prints single; else prints needs-proposal
//   node areas.mjs check <runDir>                  checks <runDir>/areas.json against <runDir>/work; prints the areas; exit 1 on problems
//   node areas.mjs renumber <runDir>               joins inventory-areas/<id>/features.md into features.md with global F-xxx and [area: id] tags
//   node areas.mjs states <runDir>                 joins inventory-areas/<id>/states.json into inventory/states.json
//   node areas.mjs ids <runDir> <id>               prints the feature IDs of one area
//   node areas.mjs untested <runDir>               joins parity/untested-<id>.md into parity/untested.md
import fs from 'node:fs';
import path from 'node:path';
import { scan, readPlan } from './size.mjs';

const norm = (p) => String(p).replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '') || '.';
const covers = (p, file) => { const n = norm(p); return n === '.' || file === n || file.startsWith(n + '/'); };
const ID = /^[a-z0-9][a-z0-9-]*$/;

export const SINGLE = { areas: [{ id: 'all', paths: ['.'], entry: [] }], exclusions: [] };

// Every counted file must be in exactly one area or in exactly one listed exclusion (with a reason), and nowhere else.
export function validate(spec, counted) {
  const problems = [];
  if (!spec || !Array.isArray(spec.areas) || !spec.areas.length) return { ok: false, problems: ['areas.json has no areas'] };
  const exclusions = Array.isArray(spec.exclusions) ? spec.exclusions : [];
  const seen = new Set();
  for (const a of spec.areas) {
    if (!ID.test(String(a.id))) problems.push(`area id "${a.id}" is not lowercase letters, digits and dashes`);
    if (seen.has(a.id)) problems.push(`area id "${a.id}" is used twice`);
    seen.add(a.id);
    if (!Array.isArray(a.paths) || !a.paths.length) problems.push(`area ${a.id} has no paths`);
  }
  for (const x of exclusions) if (!x.path || !String(x.reason || '').trim()) problems.push(`exclusion ${JSON.stringify(x.path)} has no reason`);
  const files = {}, lines = {};
  for (const a of spec.areas) { files[a.id] = 0; lines[a.id] = 0; }
  const bad = [];
  for (const f of counted) {
    const owners = [
      ...spec.areas.filter((a) => (a.paths || []).some((p) => covers(p, f.path))).map((a) => 'area ' + a.id),
      ...exclusions.filter((x) => x.path && covers(x.path, f.path)).map((x) => 'exclusion ' + x.path),
    ];
    if (owners.length === 0) bad.push(`${f.path}: in no area and no exclusion`);
    else if (owners.length > 1) bad.push(`${f.path}: in more than one place (${owners.join(', ')})`);
    else {
      const a = spec.areas.find((x) => owners[0] === 'area ' + x.id);
      if (a) { files[a.id]++; lines[a.id] += f.lines; }
    }
  }
  if (bad.length) problems.push(...bad.slice(0, 20), ...(bad.length > 20 ? [`... and ${bad.length - 20} more files`] : []));
  for (const a of spec.areas) if (ID.test(String(a.id)) && files[a.id] === 0) problems.push(`area ${a.id} holds no counted files`);
  const excluded = counted.filter((f) => exclusions.some((x) => x.path && covers(x.path, f.path)));
  return {
    ok: problems.length === 0, problems,
    areas: spec.areas.map((a) => ({ id: a.id, files: files[a.id], lines: lines[a.id], entry: a.entry || [] })),
    excluded: exclusions.map((x) => ({ path: x.path, reason: x.reason, files: excluded.filter((f) => covers(x.path, f.path)).length })),
  };
}

const readSpec = (runDir) => JSON.parse(fs.readFileSync(path.join(runDir, 'areas.json'), 'utf8'));

// Entry lines start "F-001 keep." or "F-001 defect."; a joined features.md tags each with "[area: id]".
const ENTRY = /^(\W*)(F-\d+)(\W+)(keep|defect)(\.?)/i;
const TAG = /\[area: ([a-z0-9-]+)\]/;

// Joins the per-area features files in area order into one text with global IDs; returns { text, map } where map is area -> [global IDs].
export function renumber(spec, readArea) {
  let n = 0;
  const out = [], map = {};
  for (const a of spec.areas) {
    const src = readArea(a.id);
    if (src === null) throw new Error(`area ${a.id} has no features file`);
    const ids = {};
    for (const l of src.split('\n')) { const m = l.match(ENTRY); if (m && !ids[m[2].toUpperCase()]) ids[m[2].toUpperCase()] = 'F-' + String(++n).padStart(3, '0'); }
    const swap = (t) => t.replace(/\bF-\d+\b/gi, (x) => ids[x.toUpperCase()] || x);
    map[a.id] = Object.values(ids);
    for (const l of src.split('\n')) {
      const m = l.match(ENTRY);
      out.push(m ? swap(l.replace(ENTRY, (_, a1, id, a3, kind, dot) => `${a1}${id}${a3}${kind}${dot} [area: ${a.id}]`)) : swap(l));
    }
  }
  return { text: out.join('\n'), map };
}

// Feature ID -> area id, from the tags. One area: every entry belongs to it. More areas: an entry with no valid tag is an error.
export function featureAreas(featuresMd, spec) {
  const ids = new Set(spec.areas.map((a) => a.id));
  const out = {};
  for (const l of featuresMd.split('\n')) {
    const m = l.match(ENTRY);
    if (!m) continue;
    const t = l.match(TAG);
    if (spec.areas.length === 1) out[m[2].toUpperCase()] = spec.areas[0].id;
    else if (t && ids.has(t[1])) out[m[2].toUpperCase()] = t[1];
    else throw new Error(`${m[2]} has no valid [area: id] tag`);
  }
  return out;
}

function main(argv) {
  const [cmd, a, b] = argv;
  if (cmd === 'tree') {
    for (const f of scan(path.resolve(a)).counted) console.log(`${f.lines} ${f.path}`);
    return 0;
  }
  const work = path.join(a || '', 'work');
  if (cmd === 'init') {
    if (readPlan(a).units <= 1) { fs.writeFileSync(path.join(a, 'areas.json'), JSON.stringify(SINGLE, null, 2)); console.log('single'); }
    else console.log('needs-proposal');
    return 0;
  }
  if (cmd === 'check') {
    const v = validate(readSpec(a), scan(work).counted);
    console.log(JSON.stringify(v));
    return v.ok ? 0 : 1;
  }
  if (cmd === 'renumber') {
    const spec = readSpec(a);
    const { text, map } = renumber(spec, (id) => { const f = path.join(a, 'inventory-areas', id, 'features.md'); return fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null; });
    fs.writeFileSync(path.join(a, 'features.md'), text);
    console.log(JSON.stringify(Object.fromEntries(Object.entries(map).map(([k, v]) => [k, v.length]))));
    return 0;
  }
  if (cmd === 'states') {
    const all = [];
    for (const ar of readSpec(a).areas) {
      const f = path.join(a, 'inventory-areas', ar.id, 'states.json');
      if (fs.existsSync(f)) for (const s of JSON.parse(fs.readFileSync(f, 'utf8'))) all.push({ ...s, id: `${ar.id}:${s.id}` });
    }
    fs.mkdirSync(path.join(a, 'inventory'), { recursive: true });
    fs.writeFileSync(path.join(a, 'inventory', 'states.json'), JSON.stringify(all, null, 2));
    console.log(`${all.length} states`);
    return 0;
  }
  if (cmd === 'ids') {
    const m = featureAreas(fs.readFileSync(path.join(a, 'features.md'), 'utf8'), readSpec(a));
    console.log(Object.keys(m).filter((id) => m[id] === b).sort().join(' '));
    return 0;
  }
  if (cmd === 'untested') {
    const dir = path.join(a, 'parity');
    const parts = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => /^untested-.+\.md$/.test(f)).sort() : [];
    fs.writeFileSync(path.join(dir, 'untested.md'), parts.map((f) => fs.readFileSync(path.join(dir, f), 'utf8').trimEnd()).filter(Boolean).join('\n') + '\n');
    console.log(`${parts.length} files`);
    return 0;
  }
  console.error('usage: areas.mjs tree|init|check|renumber|states|ids|untested ...');
  return 2;
}

if (process.argv[1] && path.resolve(process.argv[1]) === new URL(import.meta.url).pathname) {
  try { process.exit(main(process.argv.slice(2))); } catch (e) { console.error(String(e.message || e)); process.exit(1); }
}

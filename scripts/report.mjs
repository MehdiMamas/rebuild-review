// Report phase: code decides the verdict and renders one self-contained page; a model only proposes actions.
// CLI: report.mjs verdict <runDir>        prints the verdict as JSON
//      report.mjs check-actions <runDir>  report/actions.proposed.json -> report/actions.json (+ actions.dropped.json)
//      report.mjs render <runDir>         writes report/index.html
import fs from 'node:fs';
import path from 'node:path';

const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const tryJson = (f) => { try { return readJson(f); } catch { return null; } };
const tryText = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return null; } };
const DEFAULT_RUBRIC = new URL('../rubric.json', import.meta.url).pathname;
const signed = (n, d = 2) => (n > 0 ? '+' : '') + String(Math.round(n * 10 ** d) / 10 ** d);
const pct = (r) => `${Math.round(r * 100)}%`;
const EMBED_CAP = 8 * 1024 * 1024;
const MAX_PAIRS = 6;

export function esc(s) {
  return String(s ?? '').replace(/[&<>"'`]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;' }[c]));
}

// ---- verdict ----
export function verdict(score, thresholds = readJson(DEFAULT_RUBRIC).verdict) {
  const { adoptOverall, worseValue } = thresholds;
  if (!score || !score.gate || !score.values || typeof score.overall !== 'number') {
    return { verdict: 'leave', why: 'There is no score for the rebuild (it did not start or was not measured), so nothing says it is better than the original.' };
  }
  const g = score.gate;
  const gateText = g.rate === null || g.rate === undefined ? 'Gate: no tests ran' : `Gate ${g.passed ? 'passed' : 'failed'} (${pct(g.rate)})`;
  const entries = Object.entries(score.values).map(([name, v]) => [name, v.delta]);
  const worse = entries.filter(([, d]) => d <= worseValue).map(([n]) => n);
  const better = entries.filter(([, d]) => d > 0.15);
  if (g.passed && score.overall >= adoptOverall && !worse.length) {
    return { verdict: 'adopt', why: `${gateText}, overall ${signed(score.overall, 1)}, no value worse.` };
  }
  if (better.length) {
    const names = better.map(([n, d]) => `${n} ${signed(d)}`).join(', ');
    const gateFirst = g.passed ? '' : `${gateText}. `;
    return { verdict: 'port', why: `${gateFirst}${g.passed ? gateText + ', overall ' + signed(score.overall, 1) + '. ' : ''}Better in: ${names}.${worse.length ? ` Worse in: ${worse.join(', ')}.` : ''}`.trim() };
  }
  return { verdict: 'leave', why: `${gateText}, overall ${signed(score.overall, 1)}, no value clearly better${worse.length ? `; worse in: ${worse.join(', ')}` : ''}.` };
}

// ---- check-actions ----
const lineCount = (f) => { const t = fs.readFileSync(f, 'utf8'); return t === '' ? 0 : t.split('\n').length - (t.endsWith('\n') ? 1 : 0); };

function evidenceProblem(runDir, ev, ctx) {
  if (!ev || typeof ev !== 'object' || typeof ev.ref !== 'string' || !ev.ref.trim()) return 'evidence has no ref';
  const ref = ev.ref.trim();
  const inside = (rootRel, rel) => {
    const root = path.resolve(runDir, rootRel);
    const abs = path.resolve(runDir, rel);
    const r = path.relative(root, abs);
    return r && !r.startsWith('..') && !path.isAbsolute(r) ? abs : null;
  };
  if (ev.kind === 'metric') return ctx.metrics.has(ref) ? null : `no metric ${ref} in score.json`;
  if (ev.kind === 'feature') return ctx.features.has(ref.toUpperCase()) ? null : `no feature ${ref} in parity.json`;
  if (ev.kind === 'shot') {
    const root = ['golden', 'golden-rebuild'].find((r) => ref.startsWith(r + '/'));
    const abs = root && inside(root, ref);
    return abs && fs.existsSync(abs) && fs.statSync(abs).isFile() ? null : 'screenshot does not exist';
  }
  if (ev.kind === 'file') {
    const lm = /^(.*?):(\d+)$/.exec(ref);
    const rel = lm ? lm[1] : ref;
    const root = ['work', 'project'].find((r) => rel.startsWith(r + '/'));
    const abs = root && inside(root, rel);
    if (!abs || !fs.existsSync(abs) || !fs.statSync(abs).isFile()) return 'file does not exist';
    if (lm && (Number(lm[2]) < 1 || Number(lm[2]) > lineCount(abs))) return `line ${lm[2]} past the end of the file`;
    return null;
  }
  return `unknown evidence kind ${ev.kind}`;
}

export function checkActions(runDir) {
  const proposed = tryJson(path.join(runDir, 'report', 'actions.proposed.json'));
  const score = tryJson(path.join(runDir, 'score', 'score.json'));
  const parity = tryJson(path.join(runDir, 'parity', 'parity.json'));
  const ctx = {
    metrics: new Set(score && score.values ? Object.values(score.values).flatMap((v) => (v.measured || []).map((m) => m.name)) : []),
    features: new Set((Array.isArray(parity) ? parity : []).map((p) => String(p.feature).toUpperCase())),
  };
  const kept = [], dropped = [];
  for (const a of Array.isArray(proposed) ? proposed : []) {
    const ev = a && Array.isArray(a.evidence) ? a.evidence : [];
    const problems = [];
    if (!a || typeof a.title !== 'string' || !a.title.trim()) problems.push('no title');
    if (!['high', 'medium', 'low'].includes(a && a.impact)) problems.push('impact is not high, medium or low');
    if (!ev.length) problems.push('no evidence');
    for (const e of ev) { const p = evidenceProblem(runDir, e, ctx); if (p) problems.push(p); }
    if (problems.length) dropped.push({ action: a, reasons: problems }); else kept.push(a);
  }
  fs.mkdirSync(path.join(runDir, 'report'), { recursive: true });
  fs.writeFileSync(path.join(runDir, 'report', 'actions.json'), JSON.stringify(kept, null, 2));
  fs.writeFileSync(path.join(runDir, 'report', 'actions.dropped.json'), JSON.stringify(dropped, null, 2));
  return { kept, dropped };
}

// ---- render ----
// compare.md: "## <value>" with "### was", "### now", "### should".
export function parseCompare(md) {
  const out = {};
  if (!md) return out;
  let value = null, part = null;
  for (const line of md.split('\n')) {
    let m;
    if ((m = /^##\s+(.+?)\s*$/.exec(line))) { value = m[1].trim().toLowerCase(); out[value] = out[value] || {}; part = null; }
    else if (value && (m = /^###\s+(was|now|should)\b/i.exec(line))) { part = m[1].toLowerCase(); out[value][part] = ''; }
    else if (value && part) out[value][part] += line + '\n';
  }
  for (const v of Object.values(out)) for (const k of Object.keys(v)) v[k] = v[k].trim();
  return out;
}

function screenPairs(runDir, cap) {
  const list = (root) => {
    const d = path.join(runDir, root, 'screens'), found = new Map();
    if (!fs.existsSync(d)) return found;
    for (const screen of fs.readdirSync(d)) {
      if (!fs.statSync(path.join(d, screen)).isDirectory()) continue;
      for (const f of fs.readdirSync(path.join(d, screen))) if (/^\d+-\w+\.png$/.test(f)) found.set(`${screen}/${f}`, path.join(d, screen, f));
    }
    return found;
  };
  const a = list('golden'), b = list('golden-rebuild');
  const hasAny = a.size > 0 || b.size > 0;
  const diffs = (tryJson(path.join(runDir, 'parity', 'visual-diff.json')) || {}).diffs || [];
  const pctOf = (key) => { const [screen, f] = key.split('/'); const m = /^(\d+)-(\w+)\.png$/.exec(f); const d = diffs.find((x) => x.screen === screen && x.size === Number(m[1]) && x.theme === m[2]); return d ? d.percent : -1; };
  const keys = [...a.keys()].filter((k) => b.has(k)).sort().sort((x, y) => pctOf(y) - pctOf(x));
  const pairs = [];
  let used = 0, left = 0;
  for (const k of keys) {
    if (pairs.length >= MAX_PAIRS) { left++; continue; }
    const x = fs.readFileSync(a.get(k)).toString('base64'), y = fs.readFileSync(b.get(k)).toString('base64');
    if (used + x.length + y.length > cap) { left++; continue; }
    used += x.length + y.length;
    pairs.push({ key: k, percent: pctOf(k), a: x, b: y });
  }
  return { pairs, left, hasAny };
}

const paras = (t) => esc(t).split(/\n{2,}/).map((p) => `<p>${p.replace(/\n/g, '<br>')}</p>`).join('');

const CSS = `:root{--bg:#fff;--fg:#1a1a1f;--mut:#5a5a66;--card:#f4f4f7;--line:#d8d8e0;--adopt:#0a7d3c;--port:#a35a00;--leave:#8a1f2b;--link:#0b57d0}
@media (prefers-color-scheme:dark){:root{--bg:#121216;--fg:#ececf1;--mut:#a4a4b2;--card:#1d1d24;--line:#34343f;--adopt:#4cc47f;--port:#f0a540;--leave:#ff7d8a;--link:#8ab4ff}}
a{color:var(--link)}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,sans-serif}
main{max-width:860px;margin:0 auto;padding:16px}section{margin:0 0 28px}h1,h2,h3{line-height:1.25}h2{border-bottom:1px solid var(--line);padding-bottom:4px}
.card{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:12px 16px;margin:0 0 12px;overflow-wrap:anywhere}
.badge{display:inline-block;font-weight:700;font-size:1.4rem;text-transform:uppercase}.adopt{color:var(--adopt)}.port{color:var(--port)}.leave{color:var(--leave)}
.mut{color:var(--mut)}table{border-collapse:collapse;width:100%}th,td{text-align:left;padding:4px 8px;border-bottom:1px solid var(--line);overflow-wrap:anywhere}
.pair{display:flex;gap:8px;margin:0 0 12px}.pair figure{flex:1;margin:0;min-width:0}.pair img{max-width:100%;height:auto;border:1px solid var(--line)}
@media (max-width:600px){.pair{flex-direction:column}}code{overflow-wrap:anywhere}`;

export function render(runDir, { embedCap = EMBED_CAP, thresholds } = {}) {
  const rubric = tryJson(DEFAULT_RUBRIC);
  const score = tryJson(path.join(runDir, 'score', 'score.json'));
  const v = verdict(score, thresholds || (rubric && rubric.verdict));
  const actions = (() => {
    const list = tryJson(path.join(runDir, 'report', 'actions.json'));
    const rank = { high: 0, medium: 1, low: 2 };
    return (Array.isArray(list) ? list : []).map((a, i) => [a, i]).sort((x, y) => rank[x[0].impact] - rank[y[0].impact] || x[1] - y[1]).map(([a]) => a);
  })();
  const dropped = tryJson(path.join(runDir, 'report', 'actions.dropped.json')) || [];
  const compare = parseCompare(tryText(path.join(runDir, 'score', 'compare.md')));
  const parity = tryJson(path.join(runDir, 'parity', 'parity.json'));
  const { pairs, left, hasAny } = screenPairs(runDir, embedCap);
  const html = [];
  const sec = (id, title, body) => html.push(`<section id="${id}"><h2>${esc(title)}</h2>${body}</section>`);

  // 1 Verdict
  sec('verdict', 'Verdict', `<p><span class="badge ${v.verdict}">${esc(v.verdict)}</span></p><p>${esc(v.why)}</p>` +
    (actions.length ? `<div class="card"><strong>Do this first:</strong> ${esc(actions[0].title)}</div>` : '<p class="mut">No checked action was proposed.</p>'));

  // 2 Scores, gate beside them
  if (score && score.values) {
    const g = score.gate || {};
    const rows = Object.entries(score.values).map(([n, x]) => `<tr><td>${esc(n)}</td><td>${esc(signed(x.delta))}</td></tr>`).join('');
    const gate = `<p><strong>Gate (functionality):</strong> ${g.rate == null ? 'no tests ran' : `${g.passed ? 'passed' : 'failed'}, ${pct(g.rate)} of tests pass on the rebuild`}${g.failing && g.failing.length ? `; failing: ${esc(g.failing.join(', '))}` : ''}. The gate is never blended into the scores.</p>`;
    sec('scores', 'Scores', `${gate}<table><tr><th>Value</th><th>Rebuild against original (+ is better)</th></tr>${rows}<tr><th>Overall</th><th>${esc(signed(score.overall, 1))}</th></tr></table>`);
  } else sec('scores', 'Scores', '<p>There is no score for this run.</p>');

  // 3 Actions
  sec('actions', 'Actions', actions.length ? actions.map((a, i) => `<div class="card"><h3>${i + 1}. ${esc(a.title)}</h3>
<p><strong>Impact:</strong> ${esc(a.impact)}${a.impactWhy ? ` &ndash; ${esc(a.impactWhy)}` : ''}${a.value ? ` <span class="mut">(${esc(a.value)})</span>` : ''}</p>
<p><strong>What to change:</strong> ${esc(a.change)}</p>
<p><strong>Evidence:</strong></p><ul>${a.evidence.map((e) => `<li>${esc(e.kind)}: <code>${esc(e.ref)}</code></li>`).join('')}</ul>
<p class="mut">Ask to file this as an issue; nothing is filed unless you ask.</p></div>`).join('') : '<p>No action passed the evidence check.</p>');

  // 4 Was, now, should
  const vals = Object.keys((score && score.values) || {});
  const names = [...new Set([...vals, ...Object.keys(compare)])];
  const cmpHtml = names.map((n) => {
    const c = compare[n] || {};
    return `<div class="card"><h3>${esc(n)}</h3>${['was', 'now', 'should'].map((k) => `<h4>${k === 'was' ? 'Was (original)' : k === 'now' ? 'Now (rebuild)' : 'Should'}</h4>${c[k] ? paras(c[k]) : '<p class="mut">not written</p>'}`).join('')}</div>`;
  }).join('');
  const shots = pairs.length
    ? pairs.map((p) => `<div class="pair"><figure><figcaption>Original: ${esc(p.key)}</figcaption><img alt="Original, ${esc(p.key)}" src="data:image/png;base64,${p.a}"></figure><figure><figcaption>Rebuild: ${esc(p.key)}</figcaption><img alt="Rebuild, ${esc(p.key)}" src="data:image/png;base64,${p.b}"></figure></div>`).join('') + (left ? `<p class="mut">${left} more screenshot pair(s) left out (at most ${MAX_PAIRS} pairs and ${Math.round(embedCap / 1048576)} MB are embedded).</p>` : '')
    : `<p class="mut">${hasAny ? (left ? `${left} screenshot pair(s) left out (embed limit).` : 'no screenshot exists on both sides') : 'no screens on this platform'}</p>`;
  sec('compare', 'Was, now and should', (cmpHtml || '<p class="mut">not written</p>') + '<h3>Screenshots</h3>' + shots);

  // 5 Features
  const order = { fail: 0, 'not run': 1, pass: 2 };
  const feats = (Array.isArray(parity) ? parity : []).slice().sort((x, y) => (order[x.rebuild] ?? 1) - (order[y.rebuild] ?? 1) || String(x.feature).localeCompare(String(y.feature)));
  sec('features', 'Feature list', feats.length ? `<table><tr><th>Feature</th><th>Kind</th><th>Original</th><th>Rebuild</th><th>Note</th></tr>${feats.map((f) => `<tr><td>${esc(f.feature)}</td><td>${esc(f.kind)}</td><td>${esc(f.original)}</td><td>${esc(f.rebuild)}</td><td>${esc(f.note)}</td></tr>`).join('')}</table>` : '<p class="mut">There is no parity result.</p>');

  // 6 Not checked
  const items = [];
  if (score) {
    for (const n of score.notChecked || []) items.push(`Not checked: ${n}`);
    for (const [name, x] of Object.entries(score.values || {})) for (const m of x.notMeasured || []) items.push(`${name}: ${m} was not measured`);
    for (const d of score.dropped || []) items.push(`Dropped judge score${d.value ? ` (${d.value})` : ''}: ${d.reason || 'invalid'}`);
    for (const r of score.refuted || []) items.push(`Refuted judge score (${r.value}): ${r.why}`);
  }
  const untested = tryText(path.join(runDir, 'parity', 'untested.md'));
  if (untested) for (const l of untested.split('\n').filter((x) => x.trim())) items.push(`Untested: ${l}`);
  const stop = tryText(path.join(runDir, 'parity', 'loop-stop.txt'));
  if (stop && stop.trim()) items.push(`The build loop stopped: ${stop.trim()}`);
  for (const d of dropped) items.push(`Dropped action "${(d.action && d.action.title) || '?'}": ${(d.reasons || []).join('; ')}`);
  items.push('Other browsers: not checked');
  sec('unchecked', 'What this run could not check', `<ul>${items.map((i) => `<li>${esc(i)}</li>`).join('')}</ul>`);

  // 7 Cost
  const rdir = path.join(runDir, 'rebuild');
  const results = fs.existsSync(rdir) ? fs.readdirSync(rdir).filter((f) => f.endsWith('.result.json')).sort() : [];
  const cost = results.reduce((s, f) => s + ((tryJson(path.join(rdir, f)) || {}).costUsd || 0), 0);
  const rounds = tryJson(path.join(runDir, 'parity', 'rounds.json'));
  sec('cost', 'Cost', `<p>${results.length ? `$${cost.toFixed(2)} across ${results.length} builder run(s)` : 'No builder cost was recorded'}${Array.isArray(rounds) ? `; ${rounds.length} round(s) in rounds.json` : ''}. Rebuild children only; other agents are not counted.</p>`);

  // 8 Where the project is
  sec('project', 'Where the project is', `<p><a href="../project/">project/</a> <code>${esc(path.join(runDir, 'project'))}</code></p><p>To use it, copy it over your project by hand. This tool never changes your project, and files an issue only if you ask.</p>`);

  const page = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'"><title>Rebuild review report</title><style>${CSS}</style></head><body><main><h1>Rebuild review report</h1>${html.join('\n')}</main></body></html>`;
  fs.mkdirSync(path.join(runDir, 'report'), { recursive: true });
  fs.writeFileSync(path.join(runDir, 'report', 'index.html'), page);
  return page;
}

if (process.argv[1] && path.resolve(process.argv[1]) === new URL(import.meta.url).pathname) {
  const [cmd, runDir] = process.argv.slice(2);
  if (!runDir) { console.error('usage: report.mjs verdict|check-actions|render <runDir>'); process.exit(2); }
  if (cmd === 'verdict') {
    const v = verdict(tryJson(path.join(runDir, 'score', 'score.json')));
    console.log(JSON.stringify(v));
  } else if (cmd === 'check-actions') {
    const r = checkActions(runDir);
    console.log(`kept ${r.kept.length}, dropped ${r.dropped.length}`);
  } else if (cmd === 'render') {
    render(runDir);
    console.log(`wrote ${path.join(runDir, 'report', 'index.html')}`);
  } else { console.error('usage: report.mjs verdict|check-actions|render <runDir>'); process.exit(2); }
}

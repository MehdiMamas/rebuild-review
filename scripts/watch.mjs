// Watch page for a run (#82): node scripts/watch.mjs <runDir> [--port N] [--open]
// Serves one page on 127.0.0.1 only (there is no host flag), every route behind a random token (?k=). It reads the run folder; it never writes to it
// except <runDir>/watch.pid. Phase state comes from the <Phase>.done markers, events from events.jsonl (scripts/events.mjs).
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomBytes, timingSafeEqual, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { read as readEvents, mask } from './events.mjs';

// A copy of PHASES in workflows/rebuild-review.js (the workflow cannot be imported); watch.test.mjs checks they are equal.
export const PHASES = ['Capture', 'Inventory', 'Stack', 'Rebuild', 'Parity', 'Score', 'Report'];
const RUNNING_WINDOW_MS = 10 * 60 * 1000;
const LINGER_MS = Number(process.env.WATCH_LINGER_MS) || 30 * 60 * 1000;
const LOG_CAP = 64 * 1024;
const TEXT_CAP = 1024 * 1024;
const DENY_DIRS = new Set(['work', 'room', 'project', 'rebuild']);
const DENY_NAMES = new Set(['run.json', 'rebuild-run.json', '.canary', '.labels.json']);
const TYPES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.log': 'text/plain', '.md': 'text/plain', '.json': 'text/plain', '.txt': 'text/plain' };

const tryJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const tryText = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return null; } };
const tryStat = (f) => { try { return fs.statSync(f); } catch { return null; } };
const tryDir = (d) => { try { return fs.readdirSync(d); } catch { return []; } };

// Does the path name something the clean room guards or something that can hold a secret? Segments are checked at every depth.
export function denied(rel) {
  const parts = rel.split(/[\\/]+/).filter(Boolean);
  if (!parts.length) return true;
  for (const seg of parts) {
    if (seg === '..' || seg === '.' || seg.startsWith('.') || DENY_DIRS.has(seg) || DENY_NAMES.has(seg) || /\.settings/.test(seg)) return true;
  }
  if (parts[0] === 'long' && !/\.log$/.test(parts[parts.length - 1])) return true;
  return !(path.extname(parts[parts.length - 1]).toLowerCase() in TYPES);
}

export function makeSanitizer(runDir) {
  const real = (p) => { try { return fs.realpathSync(p); } catch { return p; } };
  const target = (r) => r.replace(/-rebuild-review$/, '');
  const pairs = [];
  for (const r of new Set([runDir, real(runDir)])) pairs.push([r, '<run>']);
  for (const r of new Set([path.dirname(runDir), path.dirname(real(runDir))])) pairs.push([target(r), '<target>']);
  pairs.push([os.homedir(), '~']);
  pairs.sort((a, b) => b[0].length - a[0].length);
  return (text) => {
    text = mask(runDir, String(text));
    for (const [from, to] of pairs) if (from && from.length > 1) text = text.split(from).join(to);
    return text;
  };
}

function walkImages(dir, rel, depth, out) {
  for (const n of tryDir(dir).sort()) {
    if (out.length >= 60) return;
    const f = path.join(dir, n), st = tryStat(f);
    if (!st) continue;
    if (st.isDirectory() && depth < 3) walkImages(f, `${rel}/${n}`, depth + 1, out);
    else if (st.isFile() && /\.(png|jpe?g|webp)$/i.test(n)) out.push(`${rel}/${n}`);
  }
}

// A stop marker is stale once the run went on after it was written (a rerun continues from the same folder): a phase
// finished, a long step wrote its log, or an event was added later than the marker.
export function stopText(runDir) {
  const f = path.join(runDir, 'report', 'stopped.txt');
  const st = tryStat(f);
  if (!st) return null;
  const later = [
    ...PHASES.map((p) => path.join(runDir, `${p}.done`)),
    path.join(runDir, 'events.jsonl'),
    ...tryDir(path.join(runDir, 'long')).filter((n) => n.endsWith('.log')).map((n) => path.join(runDir, 'long', n)),
  ];
  for (const g of later) {
    const d = tryStat(g);
    if (d && d.mtimeMs > st.mtimeMs) return null;
  }
  return tryText(f);
}

// The run stopped at the estimate (size.mjs exits 3, no stopped.txt is written): the last estimate decision is `stop`, and
// nothing ran after it (no phase marker or long-step log newer than the event's own time). Names no phase.
export function estimateStop(runDir) {
  const ev = readEvents(runDir, 0).events.filter((e) => e.kind === 'decision' && e.what === 'estimate').pop();
  if (!ev || ev.choice !== 'stop') return null;
  const t = Date.parse(ev.t);
  if (!Number.isFinite(t)) return null;
  const later = [
    ...PHASES.map((p) => path.join(runDir, `${p}.done`)),
    ...tryDir(path.join(runDir, 'long')).filter((n) => n.endsWith('.log')).map((n) => path.join(runDir, 'long', n)),
  ];
  for (const g of later) {
    const d = tryStat(g);
    if (d && d.mtimeMs > t) return null;
  }
  return `Estimate: ${typeof ev.reason === 'string' && ev.reason ? ev.reason : 'the estimate is above the limit'}`;
}

// Newest mtime of the files that show the run is working: events, long-step logs, phase markers and the files steps write
// at most two levels inside the output folders. Stat only, 5000 entries at most, links not followed, never work/ room/ project/.
const ACTIVITY_DIRS = ['inventory', 'inventory-areas', 'parity', 'score', 'report', 'rebuild'];
export function lastActivity(runDir) {
  let newest = 0, budget = 5000;
  const lstat = (f) => { try { return fs.lstatSync(f); } catch { return null; } };
  const note = (f) => { budget--; const st = lstat(f); if (st && st.isFile() && st.mtimeMs > newest) newest = st.mtimeMs; return st; };
  const walk = (dir, depth) => {
    for (const n of tryDir(dir)) {
      if (budget <= 0) return;
      const f = path.join(dir, n), st = note(f);
      if (st && st.isDirectory() && depth < 2) walk(f, depth + 1);
    }
  };
  note(path.join(runDir, 'events.jsonl'));
  for (const n of tryDir(runDir)) if (n.endsWith('.done') && budget > 0) note(path.join(runDir, n));
  for (const n of tryDir(path.join(runDir, 'long'))) if (n.endsWith('.log') && budget > 0) note(path.join(runDir, 'long', n));
  for (const d of ACTIVITY_DIRS) walk(path.join(runDir, d), 1);
  return newest;
}

export function buildState(runDir, clean = (s) => s) {
  const exists = (n) => fs.existsSync(path.join(runDir, n));
  const run = tryJson(path.join(runDir, 'run.json')); // only platform is read out of it; env is never put into the state
  const size = tryJson(path.join(runDir, 'size.json'));
  const base = tryJson(path.join(runDir, 'base.json'));
  const cost = tryJson(path.join(runDir, 'cost.json'));
  const rounds = tryJson(path.join(runDir, 'parity', 'rounds.json'));
  const score = tryJson(path.join(runDir, 'score', 'score.json'));
  const fileStop = stopText(runDir);
  const stopped = fileStop ?? estimateStop(runDir);

  const long = tryDir(path.join(runDir, 'long')).filter((n) => /^[\w.-]+\.log$/.test(n)).sort().map((n) => {
    const name = n.slice(0, -4), st = tryStat(path.join(runDir, 'long', n));
    const ex = tryText(path.join(runDir, 'long', `${name}.exit`));
    return { name, state: ex === null ? 'running' : 'exited', code: ex === null ? null : Number(ex.trim()), size: st ? st.size : 0, mtime: st ? Math.round(st.mtimeMs) : 0 };
  });
  const anyRunning = long.some((l) => l.state === 'running');
  const recent = Date.now() - lastActivity(runDir) < RUNNING_WINDOW_MS;
  const exitFailed = !anyRunning && long.some((l) => l.state === 'exited' && l.code !== 0);

  const phases = PHASES.map((name) => ({ name, state: exists(`${name}.done`) ? 'done' : 'not started' }));
  const next = phases.find((p) => p.state !== 'done');
  if (next) {
    const named = stopped && PHASES.find((p) => stopped.startsWith(`${p}:`));
    const failedPhase = named ? phases.find((p) => p.name === named && p.state !== 'done') || next : next;
    if (fileStop !== null || exitFailed) failedPhase.state = 'failed';
    else if (stopped) { /* an estimate stop names no phase: nothing failed */ }
    else if (anyRunning || recent) next.state = 'running';
  }
  const finished = exists('Report.done') || !!stopped;

  const feat = tryText(path.join(runDir, 'features.md')) || '';
  const features = { keep: 0, defect: 0 };
  for (const m of feat.matchAll(/^[\s#>*-]*F-\d+\s+(keep|defect)\./gm)) features[m[1]]++;
  const areasDone = tryJson(path.join(runDir, 'rebuild', 'areas-done.json'));
  const shots = [];
  walkImages(path.join(runDir, 'golden'), 'golden', 0, shots);
  walkImages(path.join(runDir, 'golden-rebuild'), 'golden-rebuild', 0, shots);

  const decisions = readEvents(runDir, 0).events.filter((e) => e.kind === 'decision' && e.what === 'verdict');
  const verdict = decisions.length ? decisions[decisions.length - 1] : null;
  const state = {
    runId: path.basename(runDir),
    platform: run && typeof run.platform === 'string' ? run.platform : null,
    baseKind: base && typeof base.kind === 'string' ? base.kind : null,
    phases,
    current: next ? next.name : null,
    finished,
    stopped: stopped ? stopped.trim() : null,
    totalUsd: cost && Number.isFinite(cost.totalUsd) ? cost.totalUsd : 0,
    costPhases: cost && cost.phases ? Object.fromEntries(Object.entries(cost.phases).map(([k, v]) => [k, v.usd])) : {},
    maxUsd: size && Number.isFinite(size.maxUsd) ? size.maxUsd : null,
    estimateUsd: size && size.plan ? size.plan.estimateUsd || null : null,
    long,
    features,
    tests: tryDir(path.join(runDir, 'parity', 'tests')).filter((n) => /\.test\.mjs$/.test(n)).length,
    removedTests: tryDir(path.join(runDir, 'parity', 'removed')).filter((n) => /\.test\.mjs$/.test(n)).length,
    rounds: Array.isArray(rounds) ? rounds.map((r) => ({ round: r.round, failing: Array.isArray(r.failing) ? r.failing.length : 0 })) : [],
    loopStop: (tryText(path.join(runDir, 'parity', 'loop-stop.txt')) || '').trim() || null,
    rebuilt: exists('Rebuild.done'),
    areasBuilt: Array.isArray(areasDone) ? areasDone.length : areasDone && typeof areasDone === 'object' ? Object.keys(areasDone).length : null,
    overall: score && Number.isFinite(score.overall) ? score.overall : null,
    gate: score && score.gate ? (score.gate.rate === null || score.gate.rate === undefined ? 'none' : !!score.gate.passed) : null,
    verdict: verdict ? { choice: verdict.choice, reason: verdict.reason } : null,
    shots,
  };
  return JSON.parse(clean(JSON.stringify(state)));
}

// Resolves ?p= to a file inside the run folder, or says why not: { status } or { file, ext }.
export function resolveFile(runDir, p) {
  if (typeof p !== 'string' || !p || p.includes('\0') || path.isAbsolute(p) || /^[a-zA-Z]:/.test(p)) return { status: 403 };
  if (denied(p)) return { status: 403 };
  const file = path.resolve(runDir, p);
  const rel = path.relative(runDir, file);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return { status: 403 };
  let real;
  try { real = fs.realpathSync(file); } catch { return { status: 404 }; }
  let realRun;
  try { realRun = fs.realpathSync(runDir); } catch { return { status: 404 }; }
  const rr = path.relative(realRun, real);
  if (!rr || rr.startsWith('..') || path.isAbsolute(rr) || denied(rr)) return { status: 403 };
  const st = tryStat(real);
  if (!st || !st.isFile()) return { status: 404 };
  return { file: real, ext: path.extname(real).toLowerCase(), size: st.size };
}

// What the verdict card shows, as [class, text] lines. Plain ES5 so the page can carry its source (PAGE embeds verdictLines.toString()) and the test runs the same code.
export function verdictLines(s) {
  var out = [];
  if (s.verdict) { out.push(['', s.verdict.choice === 'none' ? 'no verdict' : s.verdict.choice]); out.push(['mut', s.verdict.reason || '']); }
  var parts = [];
  if (s.overall !== null) parts.push('Overall ' + s.overall);
  if (s.gate === 'none') parts.push('gate: no tests ran'); else if (s.gate !== null) parts.push('gate ' + (s.gate ? 'passed' : 'failed'));
  if (parts.length) { var t = parts.join('; '); out.push(['mut', t.charAt(0).toUpperCase() + t.slice(1)]); }
  return out;
}

const PAGE = (nonce) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="no-referrer"><title>Run watch</title>
<style nonce="${nonce}">
:root{--bg:#fff;--fg:#1b1f24;--mut:#59636e;--card:#f4f6f8;--line:#d0d7de;--ok:#1a7f37;--run:#0969da;--bad:#cf222e;--bar:#0969da}
@media (prefers-color-scheme:dark){:root{--bg:#0d1117;--fg:#e6edf3;--mut:#8b949e;--card:#161b22;--line:#30363d;--ok:#3fb950;--run:#58a6ff;--bad:#f85149;--bar:#58a6ff}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.45 system-ui,sans-serif;overflow-wrap:anywhere}
main{max-width:960px;margin:0 auto;padding:16px}
h1{font-size:1.25rem;margin:0 0 4px}h2{font-size:1rem;margin:0 0 8px}
section{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:12px;margin:12px 0;min-width:0}
.mut{color:var(--mut)}.row{display:flex;gap:8px;flex-wrap:wrap;align-items:baseline}
progress{width:100%;height:10px;accent-color:var(--bar)}
ul{list-style:none;margin:0;padding:0}li{padding:3px 0}
.done{color:var(--ok)}.running{color:var(--run)}.failed{color:var(--bad)}
pre{margin:0;white-space:pre-wrap;overflow-wrap:anywhere;max-height:16em;overflow:auto;font:12px/1.4 ui-monospace,monospace}
.shots{display:flex;flex-wrap:wrap;gap:8px}.shots figure{margin:0;width:calc(50% - 4px)}
@media (min-width:700px){.shots figure{width:150px}}
.shots img{width:100%;height:auto;border:1px solid var(--line);border-radius:4px;display:block}
figcaption{font-size:11px}
.t{font-variant-numeric:tabular-nums}
</style></head><body><main>
<header><h1 id="run">Run</h1><div class="mut" id="cur"></div>
<div class="row"><span id="spend" class="t"></span></div><progress id="bar" max="1" value="0"></progress><div id="stop" class="failed"></div></header>
<section id="s-phases"><h2>Phases</h2><ul id="phases"></ul></section>
<section id="s-timeline"><h2>Decisions and events</h2><ul id="timeline"></ul><div class="mut" id="tl-empty">No events yet.</div></section>
<section id="s-now"><h2>Running now</h2><div class="mut" id="now-name"></div><pre id="now-log"></pre></section>
<section id="s-made"><h2>Made</h2><div id="made"></div><div class="shots" id="shots"></div></section>
<section id="s-verdict" hidden><h2>Verdict</h2><div id="verdict"></div></section>
<script nonce="${nonce}">
(function(){
var K=new URLSearchParams(location.search).get('k')||'';
${verdictLines.toString()}
function $(i){return document.getElementById(i)}
function el(tag,cls,text){var e=document.createElement(tag);if(cls)e.className=cls;if(text!==undefined)e.textContent=text;return e}
function usd(n){return '$'+Number(n).toFixed(2)}
function url(path,p){return path+'?k='+encodeURIComponent(K)+(p?'&p='+encodeURIComponent(p):'')}
var logName=null,logKey='';
function render(s){
  $('run').textContent='Run '+s.runId;
  $('cur').textContent=s.finished?(s.stopped?'Stopped':'Finished'):(s.current?'Current phase: '+s.current:'');
  $('spend').textContent=usd(s.totalUsd)+(s.maxUsd?' / '+usd(s.maxUsd):'');
  var b=$('bar');b.max=s.maxUsd||1;b.value=Math.min(s.totalUsd,s.maxUsd||1);
  $('stop').textContent=s.stopped?('Stopped: '+s.stopped):'';
  var ul=$('phases');ul.textContent='';
  s.phases.forEach(function(p){var li=el('li');li.appendChild(el('span',p.state==='done'?'done':p.state==='running'?'running':p.state==='failed'?'failed':'mut',p.name+': '+p.state));ul.appendChild(li)});
  var run=s.long.filter(function(l){return l.state==='running'}),pick=run[run.length-1]||s.long.slice().sort(function(a,c){return c.mtime-a.mtime})[0];
  if(pick){$('now-name').textContent=pick.name+' ('+pick.state+(pick.code!==null?', exit '+pick.code:'')+')';
    var key=pick.name+':'+pick.size;if(key!==logKey){logKey=key;logName=pick.name;
      fetch(url('/file','long/'+pick.name+'.log')).then(function(r){return r.ok?r.text():''}).then(function(t){if(logName===pick.name){var pre=$('now-log');pre.textContent=t.split('\\n').slice(-40).join('\\n');pre.scrollTop=pre.scrollHeight}}).catch(function(){})}}
  else{$('now-name').textContent='Nothing is running.';$('now-log').textContent=''}
  var m=$('made');m.textContent='';
  [['Features',s.features.keep+' keep, '+s.features.defect+' defect'],['Parity tests',s.tests+(s.removedTests?' ('+s.removedTests+' removed)':'')],
   ['Rebuild',s.rebuilt?'done'+(s.areasBuilt!==null?', '+s.areasBuilt+' area(s)':''):'not finished'],
   ['Parity rounds',s.rounds.length?s.rounds.map(function(r){return r.round+': '+r.failing+' failing'}).join(', '):'none'],
   ['Screens',String(s.shots.length)]].forEach(function(r){var d=el('div');d.appendChild(el('span','mut',r[0]+': '));d.appendChild(el('span',null,r[1]));m.appendChild(d)});
  if(s.loopStop)m.appendChild(el('div','mut','Build loop stopped: '+s.loopStop));
  var sh=$('shots');sh.textContent='';
  s.shots.slice(0,24).forEach(function(p){var f=el('figure'),i=el('img');i.src=url('/file',p);i.alt=p;i.loading='lazy';f.appendChild(i);f.appendChild(el('figcaption','mut',p));sh.appendChild(f)});
  var v=$('s-verdict');
  var vl=verdictLines(s);
  if(vl.length){v.hidden=false;var vd=$('verdict');vd.textContent='';vl.forEach(function(l){vd.appendChild(el('div',l[0]||null,l[1]))})}
  else v.hidden=true;
}
function addEvent(e){
  $('tl-empty').hidden=true;
  var li=el('li'),t=el('span','mut t',(e.t||'').slice(11,19)+' ');li.appendChild(t);
  var txt;
  if(e.kind==='phase')txt=e.phase+' '+e.state+(e.reason?': '+e.reason:'');
  else if(e.kind==='decision')txt=e.what+': '+e.choice+(e.reason?' ('+e.reason+')':'');
  else if(e.kind==='cost')txt=(e.phase||'')+' cost '+usd(e.usd||0)+', total '+usd(e.totalUsd||0)+(e.maxUsd?' of '+usd(e.maxUsd):'');
  else if(e.kind==='made')txt='made '+e.what+(e.count!==undefined?' ('+e.count+')':'')+(e.path?': '+e.path:'');
  else txt=String(e.kind);
  li.appendChild(el('span',null,txt));
  var ul=$('timeline');ul.insertBefore(li,ul.firstChild);
}
var es=new EventSource(url('/events'));
es.addEventListener('ev',function(m){try{addEvent(JSON.parse(m.data))}catch(x){}});
es.addEventListener('state',function(m){try{render(JSON.parse(m.data))}catch(x){}});
es.onerror=function(){};
})();
</script></main></body></html>`;

function startServer({ runDir, port, open }) {
  const token = randomBytes(16).toString('hex');
  const tokenBuf = Buffer.from(token);
  const clean = makeSanitizer(runDir);
  const sockets = new Set();
  let finishedAt = null;

  const send = (res, status, type, body, extra = {}) => {
    res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', ...extra });
    res.end(body);
  };
  const forbidden = (res) => send(res, 403, 'text/plain; charset=utf-8', 'forbidden\n', { 'content-security-policy': "default-src 'none'" });

  const server = http.createServer((req, res) => {
    let u;
    try { u = new URL(req.url, 'http://127.0.0.1'); } catch { return forbidden(res); }
    const k = u.searchParams.get('k') || '';
    const kb = Buffer.from(k);
    if (kb.length !== tokenBuf.length || !timingSafeEqual(kb, tokenBuf)) return forbidden(res);
    if (req.method !== 'GET') return send(res, 405, 'text/plain; charset=utf-8', 'method not allowed\n');

    if (u.pathname === '/') {
      const nonce = randomBytes(16).toString('base64');
      const csp = `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; img-src 'self'; connect-src 'self'`;
      return send(res, 200, 'text/html; charset=utf-8', PAGE(nonce), { 'content-security-policy': csp });
    }
    if (u.pathname === '/state') return send(res, 200, 'application/json; charset=utf-8', JSON.stringify(buildState(runDir, clean)), { 'content-security-policy': "default-src 'none'" });
    if (u.pathname === '/file') {
      const r = resolveFile(runDir, u.searchParams.get('p'));
      if (r.status === 403) return forbidden(res);
      if (r.status) return send(res, r.status, 'text/plain; charset=utf-8', 'not found\n');
      const type = TYPES[r.ext], csp = { 'content-security-policy': "default-src 'none'" };
      if (type.startsWith('image/')) return send(res, 200, type, fs.readFileSync(r.file), csp);
      if (r.ext !== '.log' && r.size > TEXT_CAP) return send(res, 413, 'text/plain; charset=utf-8', 'too large\n');
      let buf = fs.readFileSync(r.file);
      if (r.ext === '.log' && buf.length > LOG_CAP) buf = buf.subarray(buf.length - LOG_CAP);
      return send(res, 200, 'text/plain; charset=utf-8', clean(buf.toString('utf8')), csp);
    }
    if (u.pathname === '/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive', 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'" });
      let from = Number(req.headers['last-event-id']);
      if (!Number.isFinite(from) || from < 0) from = 0;
      let lastHash = '', lastBeat = Date.now();
      const tick = () => {
        try {
          const { events, nextByte } = readEvents(runDir, from);
          for (const e of events) res.write(`event: ev\nid: ${nextByte}\ndata: ${clean(JSON.stringify(e))}\n\n`);
          from = nextByte;
          const state = JSON.stringify(buildState(runDir, clean));
          const h = createHash('sha1').update(state).digest('hex');
          if (h !== lastHash) { lastHash = h; res.write(`event: state\ndata: ${state}\n\n`); lastBeat = Date.now(); }
          else if (Date.now() - lastBeat >= 15000) { res.write(': heartbeat\n\n'); lastBeat = Date.now(); }
        } catch { /* the next tick tries again */ }
      };
      tick();
      const timer = setInterval(tick, 1000);
      req.on('close', () => clearInterval(timer));
      return;
    }
    return send(res, 404, 'text/plain; charset=utf-8', 'not found\n');
  });
  server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });

  const pidFile = path.join(runDir, 'watch.pid');
  const stop = (code = 0) => {
    try { if (tryText(pidFile) && Number(tryText(pidFile).trim()) === process.pid) fs.rmSync(pidFile, { force: true }); } catch { /* best effort */ }
    for (const s of sockets) s.destroy();
    server.close(() => process.exit(code));
    setTimeout(() => process.exit(code), 500).unref();
  };
  process.on('SIGINT', () => stop(0));
  process.on('SIGTERM', () => stop(0));

  server.listen(port, '127.0.0.1', () => {
    const { port: bound } = server.address();
    fs.writeFileSync(pidFile, String(process.pid));
    const link = `http://127.0.0.1:${bound}/?k=${token}`;
    console.log(link);
    if (open) {
      const cmd = process.platform === 'darwin' ? 'open' : 'xdg-open';
      try { spawn(cmd, [link], { stdio: 'ignore', detached: true }).on('error', () => {}).unref(); } catch { /* no opener here */ }
    }
  });
  // The server ends by itself 30 minutes after the run finished (Report.done) or stopped.
  setInterval(() => {
    const fin = fs.existsSync(path.join(runDir, 'Report.done')) || (stopText(runDir) ?? estimateStop(runDir)) !== null;
    if (!fin) finishedAt = null;
    else if (finishedAt === null) finishedAt = Date.now();
    else if (Date.now() - finishedAt >= LINGER_MS) stop(0);
  }, Math.min(5000, Math.max(100, LINGER_MS / 4))).unref();
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  let runDir = null, port = 0, open = false;
  const usage = () => { console.error('usage: node scripts/watch.mjs <runDir> [--port N] [--open]'); process.exit(2); };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--port') { port = Number(args[++i]); if (!Number.isInteger(port) || port < 0 || port > 65535) usage(); }
    else if (args[i] === '--open') open = true;
    else if (args[i].startsWith('--') || runDir) usage();
    else runDir = args[i];
  }
  if (!runDir) usage();
  runDir = path.resolve(runDir);
  if (!tryStat(runDir) || !tryStat(runDir).isDirectory()) { console.error('run folder not found'); process.exit(2); }
  const old = Number((tryText(path.join(runDir, 'watch.pid')) || '').trim());
  if (old && old !== process.pid) {
    let alive = false;
    try { process.kill(old, 0); alive = true; } catch { /* not running */ }
    if (alive) { console.error(`a watch server already runs for this run folder (pid ${old}); stop it or use its link`); process.exit(1); }
  }
  startServer({ runDir, port, open });
}

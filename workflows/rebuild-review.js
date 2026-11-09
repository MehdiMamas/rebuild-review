export const meta = {
  name: 'rebuild-review-run',
  description: 'Rebuilds the full project from its behaviour and what it renders, then scores it against the original.',
  whenToUse: 'Started by the rebuild-review skill. Requires args {target, runDir, pluginRoot, maxUsd}.',
  phases: [
    { title: 'Capture' }, { title: 'Inventory' }, { title: 'Stack' }, { title: 'Rebuild' },
    { title: 'Parity' }, { title: 'Score' }, { title: 'Report' },
  ],
}

const q = JSON.stringify
const STOP_APP = 'When you are done, stop the app you started by its process id and check the port is free; never use pkill or killall, which can hit other processes on the machine.'
const ARGS = typeof args === 'string' ? (() => { try { return JSON.parse(args) } catch (e) { return args } })() : args
if (!ARGS || !ARGS.target || !ARGS.runDir || !ARGS.pluginRoot) {
  throw new Error('rebuild-review workflow requires args: {target, runDir, pluginRoot, maxUsd}')
}
const { target, runDir } = ARGS
const pluginRoot = ARGS.pluginRoot
const PHASES = ['Capture', 'Inventory', 'Stack', 'Rebuild', 'Parity', 'Score', 'Report']
const ADAPTER = `${ARGS.pluginRoot}/adapters`
const CHEAP = { model: 'haiku', effort: 'low' }
const CAPTURE_RESULT = { type: 'object', properties: { captured: { type: 'boolean' }, reason: { type: 'string' } }, required: ['captured'] }

// Long commands (captures, parity runs, room.mjs) run under a detached supervisor (scripts/long-run.mjs). One cheap agent starts it;
// then this script asks one cheap agent at a time to wait once (at most 540 s) until the command has exited or the supervisor is lost.
// No agent is ever asked to wait for a command to end, and no agent holds the command in its own Bash call.
const LONG_RUN = `${pluginRoot}/scripts/long-run.mjs`
const LONG_DIR = `${runDir}/long`
const WAIT_SECONDS = 540
const MAX_WAITS = 54 // 54 waits of 540 s are 8 hours
const STARTED = { type: 'object', required: ['ok'], properties: { ok: { type: 'boolean' }, detail: { type: 'string' } } }
const WAITED = { type: 'object', required: ['state'], properties: { state: { type: 'string', enum: ['running', 'exited', 'lost'] }, code: { type: 'number' }, tail: { type: 'string' } } }
async function longRun(name, command, label, phase) {
  const started = await agent(`Run exactly this one command with the Bash tool (it returns at once):\nnode ${q(LONG_RUN)} start ${q(LONG_DIR)} ${q(name)} -- ${command}\nReturn ok true if it exited 0, otherwise ok false with its error output as detail. Change nothing else.`, { ...CHEAP, label: `${label}-start`, phase, schema: STARTED })
  if (!started || !started.ok) return { state: 'lost', tail: `could not start: ${(started && started.detail) || 'start agent died'}` }
  for (let n = 1; n <= MAX_WAITS; n++) {
    const w = await agent(`Run exactly this one command with the Bash tool in the foreground (never in the background), with the Bash timeout set to 600000:\nnode ${q(LONG_RUN)} wait ${q(LONG_DIR)} ${q(name)} --seconds ${WAIT_SECONDS}\nIt prints one JSON line. Return its fields state, code (leave it out when null) and tail, copied exactly. Change nothing else.`, { ...CHEAP, label: `${label}-wait-${n}`, phase, schema: WAITED })
    if (w && w.state !== 'running') return w
  }
  return { state: 'lost', tail: 'still running after 8 hours of waiting' }
}
const exitedOk = (r) => r.state === 'exited' && r.code === 0
const whyNot = (r) => r.state === 'exited' ? `exit code ${r.code}: ${r.tail}` : `${r.state === 'lost' ? 'the command was lost' : r.state}: ${r.tail}`

// The adapter folder for the platform in run.json, read once by an agent.
let ADIR = null
async function adapterDir() {
  if (ADIR) return ADIR
  const r = await agent(`Read "platform" in ${runDir}/run.json. Return dir as the adapter folder path ${ADAPTER}/<platform> (flutter uses the android folder). Change nothing.`, { ...CHEAP, label: 'adapter-dir', schema: { type: 'object', required: ['dir'], properties: { dir: { type: 'string' } } } })
  if (!r || !r.dir) throw new Error('could not read the platform from run.json')
  ADIR = r.dir
  return ADIR
}

// A room.mjs command has ended; its result file is named on its last output lines.
async function roomResult(r, label, phase) {
  if (r.state !== 'exited') return { ok: false, reason: whyNot(r) }
  return agent(`A command ended. Its last output lines were:\n${r.tail}\nThey end with "RESULT <file>" and a JSON line. Read that result file and return ok and reason from it. If there is no RESULT line or the file is missing, return ok false with the reason. Change nothing else, and never read anything under ${target} or ${runDir}/work.`, { model: 'sonnet', effort: 'low', label: `${label}-result`, phase, schema: { type: 'object', required: ['ok'], properties: { ok: { type: 'boolean' }, reason: { type: 'string' } } } })
}

// Scripts cannot read the filesystem, so an agent lists the finished phases.
const listed = await agent(
  `List the files ending in .done directly inside ${runDir} (use ls). Return their file names. Change nothing.`,
  { ...CHEAP, label: 'resume', schema: { type: 'object', required: ['done'], properties: { done: { type: 'array', items: { type: 'string' } } } } },
)
const done = new Set((listed && listed.done) || [])

// ---- Estimate: measure the target and refuse before any other spending when maxUsd is below the high estimate ----
{
  const est = await agent(`Run in order: (1) node ${q(pluginRoot + '/scripts/base.mjs')} detect ${q(target)} ${q(runDir)}  (2) node ${q(pluginRoot + '/scripts/size.mjs')} ${q(target)} ${q(runDir)} --max-usd ${q(String(ARGS.maxUsd === undefined ? 'none' : ARGS.maxUsd))} . Step 1 writes base.json (an upstream base the app is built on, or none; size then counts only the app's own files); if it exits non-zero return ok false with its output as detail and do not run step 2. Return ok true with the output of both as detail if both exited 0, otherwise ok false with the output of the failing step as detail (exit 3 of step 2 means maxUsd is too low). Change nothing else.`, { ...CHEAP, label: 'estimate', schema: { type: 'object', required: ['ok'], properties: { ok: { type: 'boolean' }, detail: { type: 'string' } } } })
  if (!est || !est.ok) return { stopped: 'Estimate', reason: (est && est.detail) || 'estimate agent died' }
}

// ---- Inventory ----
const INV = `${runDir}/inventory`
const WORK = `${runDir}/work`
const CHECK = `node ${q(pluginRoot + '/scripts/check-features.mjs')} ${q(runDir + '/features.md')} ${q(WORK)}`
const DRIVE = `Read "platform" in ${runDir}/run.json, then read ${ADAPTER}/<platform>/DRIVING.md if it exists (flutter uses the android folder): it says how to start, drive and stop an app of that platform and how its tests find the app. Follow it.`
const DRIVER = DRIVE + ' If no driver for the platform is installed, install one in a scratch folder outside ' + WORK + ' and ' + target + ' and use it; do not give up on using the app. Build output and installs belong to the run copy only; never edit tracked files.'
const UX = 'For every screen and every action, judge it the way someone who cares about speed, UX, compatibility and accessibility would, and record every problem you see or find evidence of. Examples, not a complete list: missing loading, empty or error states; no feedback after an action; a success message after a failure; content moving after a load; focus lost while typing; input lost on navigation or reload; broken back navigation or deep links; actions that can be done twice by accident; destructive actions with no confirmation or undo; requests repeated or wasted; slow first load or slow redraws; responses applied out of order; layouts that break at small or large screens; controls unreachable by keyboard or screen reader; low contrast or tiny targets; truncated text and confusing messages. State each as a defect with the behaviour that should hold.'
const FINDER = { model: 'sonnet', effort: 'medium' }
const NOTE = 'Write in behaviour words only: what a user sees and does. Never quote source code, file paths, or copy text longer than a short phrase from files. Do not modify anything under ' + WORK + ' or ' + target + '. Do not look for answer or benchmark files.'
const BASE_NOTE = ` If ${runDir}/base.json exists and its "upstream" is not null, this app is built on an upstream base: its "ownPaths" list the files that are the app's own, and every other file in ${WORK} is the base. Report only behaviour that comes from the app's own files. Behaviour you see that comes only from the base is not an entry: list it as a plain bullet without an F-id under a \`## From the base (not rebuilt)\` heading in your file.`

const findersFor = (invDir, tech, scope) => [
  { name: 'code-reader', prompt: `You are a code reader. Read the source in ${WORK}. List every user-visible feature and behaviour you can find: routes, handlers, state, settings, keyboard shortcuts, URL flags, error and empty states, anything that only shows up in some situations. ${UX} Reason from the code to what a user would see. Write ${invDir}/code-reader.md as a bullet list, one item per behaviour, each with given/when/then. Also write ${tech}: a factual list of languages, frameworks, libraries, storage and build tools (names and versions only). ${NOTE}${BASE_NOTE} Do not write anywhere else. ${scope}` },
  { name: 'black-box-user', prompt: `You are a black-box user. Read ${runDir}/run.json for the platform and the commands, start the app from the copy named there if it is not already running (${STOP_APP}), and use it through the platform's driver. You may read ${runDir}/golden/ if it exists. Do NOT read any source under ${WORK}; treat it as unreadable. Use every screen, control, keyboard key, URL option you can discover, and try slow and failing conditions. Note what happens. ${UX} Write ${invDir}/black-box-user.md as a bullet list with given/when/then per behaviour, and ${invDir}/states.json: a list of {id, steps} where a step is exactly one of {\"open\":\"<path>\"}, {\"click\":\"<name>\"}, {\"type\":{\"into\":\"<name>\",\"text\":\"...\"}}, {\"press\":\"<key>\"}, {\"wait\":<ms>}, {\"failRequest\":\"<address part>\"}, {\"slowRequest\":{\"match\":\"<address part>\",\"ms\":<n>}} with names given by accessible name or text, that reproduce each state you found. ${DRIVER} Stop the app when done. ${NOTE}${BASE_NOTE} Do not write anywhere else. ${scope}` },
  { name: 'history-reader', prompt: `You are a history reader. In ${WORK} read git log with messages and diffs (git log -p). If gh can see a remote, also read closed issues and PRs. Every bug fix or small behaviour change becomes a requirement written in behaviour words (what must be true for a user). Write ${invDir}/history-reader.md as a bullet list with given/when/then per item. ${NOTE}${BASE_NOTE} Do not write anywhere else. ${scope}` },
  { name: 'docs-reader', prompt: `You are a docs reader. Read the README, help text, changelogs and any docs in ${WORK}. List every behaviour they promise or describe. Write ${invDir}/docs-reader.md as a bullet list with given/when/then per item. ${NOTE}${BASE_NOTE} Do not write anywhere else. ${scope}` },
]

// ---- Areas: a big app is split inside the run; a small one is the single area "all" ----
let AREAS = null
async function ensureAreas() {
  if (AREAS) return AREAS
  const AREAS_SCHEMA = { type: 'object', required: ['areas'], properties: { areas: { type: 'array', items: { type: 'object', required: ['id', 'paths'], properties: { id: { type: 'string' }, paths: { type: 'array', items: { type: 'string' } }, entry: { type: 'array', items: { type: 'string' } } } } } } }
  const AREAS_JS = `node ${q(pluginRoot + '/scripts/areas.mjs')}`
  const init = await agent(`Run exactly: ${AREAS_JS} init ${q(runDir)} . Return ok true with its printed word as detail (single or needs-proposal); if the output is needs-proposal and the file ${runDir}/areas.json already exists, add the word exists to the detail. Change nothing else.`, { ...CHEAP, label: 'areas-init', phase: 'Inventory', schema: RUN_RESULT })
  if (!init || !init.ok) throw new Error('Inventory: areas init failed')
  if (init.detail && init.detail.includes('needs-proposal')) {
    if (!init.detail.includes('exists')) await agent(`You split a big app into areas. Run: ${AREAS_JS} tree ${q(WORK)} ${q(runDir)} . It lists every counted source file with its line count; read that list and the folder names, not file contents. Write ${runDir}/areas.json: {"areas":[{"id":"<lowercase letters, digits, dashes>","paths":["<folder or file relative to the project root>"],"entry":["<entry screens or routes of this area, in plain words>"]}],"exclusions":[{"path":"<folder or file>","reason":"<why it holds no behaviour of its own>"}]}. Every file in the list must be in exactly one area or exactly one exclusion with a reason; no file may be in two places. Aim for areas of roughly 20,000 to 60,000 lines that follow what a user sees (screens, features), not code layers. Then run: ${AREAS_JS} check ${q(runDir)} and fix areas.json until it exits 0, at most 3 tries. Write nowhere else.`, { model: 'sonnet', effort: 'medium', label: 'areas-propose', phase: 'Inventory' })
    for (let t = 1; ; t++) {
      const c = await agent(`Run exactly: ${AREAS_JS} check ${q(runDir)} . Return ok true if it exited 0, otherwise ok false with its output as detail. Change nothing else.`, { ...CHEAP, label: `areas-check-${t}`, phase: 'Inventory', schema: RUN_RESULT })
      if (c && c.ok) break
      if (t >= 3) throw new Error(`Inventory: areas.json does not cover the app: ${(c && c.detail) || 'check agent died'}`)
      await agent(`${runDir}/areas.json fails its check: ${c && c.detail}. Fix areas.json (read the file list with ${AREAS_JS} tree ${q(WORK)} ${q(runDir)}) so every counted file is in exactly one area or one exclusion with a reason. Write nowhere else.`, { model: 'sonnet', effort: 'medium', label: `areas-fix-${t}`, phase: 'Inventory' })
    }
  }
  const r = await agent(`Read ${runDir}/areas.json and return its areas (id, paths, entry) exactly as written. Change nothing.`, { ...CHEAP, label: 'areas-read', phase: 'Inventory', schema: AREAS_SCHEMA })
  if (!r || !r.areas || !r.areas.length) throw new Error('Inventory: could not read areas.json')
  AREAS = r.areas
  return AREAS
}

// One area's inventory: finders, merge, critic loop. The single area "all" uses today's files and prompts unchanged.
async function inventoryArea(area, single) {
  const invDir = single ? INV : `${runDir}/inventory-areas/${area.id}`
  const FEAT = single ? `${runDir}/features.md` : `${invDir}/features.md`
  const tech = single ? `${runDir}/technology.md` : `${runDir}/inventory-areas/${area.id}-technology.md`
  const scope = single ? '' : `This run is split into areas and you cover only the area "${area.id}": paths ${area.paths.join(', ')}; entry screens: ${(area.entry || []).join(', ') || 'not named'}. Other areas are covered by other finders, so list only behaviour that belongs to this area. Local IDs start at F-001 in this area's file; they are renumbered later.`
  const CHECK = `node ${q(pluginRoot + '/scripts/check-features.mjs')} ${q(FEAT)} ${q(WORK)}`
  const L = single ? '' : `-${area.id}`
  await agent(`Create the folder ${invDir} (mkdir -p). Change nothing else.`, { ...CHEAP, label: `inventory-setup${L}`, phase: 'Inventory' })
  const found = await parallel(findersFor(invDir, tech, scope).map(f => () => agent(f.prompt, { ...FINDER, label: f.name + L, phase: 'Inventory' })))
  if (found.some(r => r === null)) throw new Error(`Inventory: a finder died${single ? '' : ' in area ' + area.id}, so features.md would be incomplete`)
  if (single) {
    const techCheck = await agent(`Run: node ${q(pluginRoot + '/scripts/check-features.mjs')} ${q(runDir + '/technology.md')} ${q(WORK)}. If it prints failures, edit ${runDir}/technology.md to remove them (rewrite file paths, import lines and long copied runs as plain names and versions) and run it again, at most 2 fix attempts. Report the final check output. Return checkPassed. Do not write anywhere else.`, { ...CHEAP, label: 'technology-check', phase: 'Inventory', schema: { type: 'object', required: ['checkPassed'], properties: { checkPassed: { type: 'boolean' } } } })
    if (!techCheck || !techCheck.checkPassed) throw new Error('Inventory: technology.md failed the no-source check after 2 fix tries')
  }

  const fixRule = `Then run: ${CHECK}. If it prints failures, edit features.md to remove them (rewrite fenced code, file paths, import or JSX lines and long copied runs in plain prose) and run it again, at most 2 fix attempts. Report the final check output.`
  const checkSchema = { type: 'object', required: ['checkPassed'], properties: { checkPassed: { type: 'boolean' } } }
  const merged = await agent(`You are the merger. Read every file in ${invDir} (the finders' lists; ignore states.json) and merge them into ${FEAT}. You may read ${runDir}/golden/ if it exists. Each entry is one paragraph or bullet that starts with its ID and kind: "F-001 keep." or "F-002 defect." (exactly that start, nothing before the ID except a list marker), then a short name, what it does, given/when/then, and "seen by:" (which finders). A defect states the intended behaviour and cites evidence from golden/probes.json or a finder's observation; it never contains a fix that depends on the implementation. Merge duplicates, but never drop an item that only one finder reported. Something that only the docs describe, with no behaviour in the running app, is not an entry: list it as a plain bullet without an F-id under a \`## Not built (from the docs)\` heading in ${FEAT}. Likewise keep each finder's \`## From the base (not rebuilt)\` bullets, without F-ids, under one heading of that name in ${FEAT}. A defect that says what the running app does (a measurement, a count, a scroll or focus or contrast behaviour) must record what you did in the running app and what you saw; if you cannot, do not state it as a defect. Entries describe behaviour only: no code blocks, file paths, imports or copied source text. ${fixRule} Return checkPassed.`, { label: 'merge' + L, phase: 'Inventory', schema: checkSchema })
  if (!merged || !merged.checkPassed) throw new Error(`Inventory: features.md failed the no-source check after the merge${L}`)

  let stoppedBy = 'a round with nothing new'
  for (let round = 1; round <= 3; round++) {
    const r = await agent(`You are the critic, round ${round}. Read ${FEAT} and ${runDir}/golden/ (if it exists) and list what is missing: behaviours, states, keys, URL options, defects. Use the app (see ${runDir}/run.json; start it from its copy if needed with the PORT environment variable set to the port in the address when it has one; ${STOP_APP}; use the platform's driver; do not read source under ${WORK}) to check anything uncertain. ${DRIVER} Every entry whose "seen by" has only one finder must be checked by using the app: mark it confirmed, or mark it "unconfirmed" with the reason. Never delete an entry without saying so in features.md. Add missing items to features.md as new entries in the same format (no code, paths or copied source text). For every defect that says what the running app does, repeat the recorded measurement once in the running app; if it is contradicted or cannot be repeated, remove the claim or mark the entry "unconfirmed" with the reason. Write the changes into features.md. If you changed nothing this round, add nothing. ${fixRule} Return checkPassed and whether you added or changed anything.`, { label: `critic-${round}${L}`, phase: 'Inventory', schema: { type: 'object', required: ['checkPassed', 'changed'], properties: { checkPassed: { type: 'boolean' }, changed: { type: 'boolean' } } } })
    if (!r || !r.checkPassed) throw new Error(`Inventory: features.md failed the no-source check after critic round ${round}${L}`)
    if (!r.changed) break
    if (round === 3) {
      stoppedBy = 'the 3-round cap'
      await agent(`Append a final line to ${FEAT}: "Critic loop stopped by the 3-round cap, not by a round with nothing new." Then run ${CHECK} and report nothing else.`, { ...CHEAP, label: 'cap-note' + L, phase: 'Inventory' })
    }
  }
  return stoppedBy
}

async function runInventory() {
  let stoppedBy = 'an earlier run'
  if (!done.has('InventoryFound.done')) {
    const areas = await ensureAreas()
    const AJS = `node ${q(pluginRoot + '/scripts/areas.mjs')}`
    if (areas.length === 1) stoppedBy = await inventoryArea(areas[0], true)
    else {
      const results = await parallel(areas.map(a => () => inventoryArea(a, false)))
      if (results.some(r => r === null)) throw new Error('Inventory: an area died, so features.md would be incomplete')
      stoppedBy = results.every(r => r === 'a round with nothing new') ? 'a round with nothing new' : 'the 3-round cap in at least one area'
      const joined = await agent(`Run in order: (1) ${AJS} renumber ${q(runDir)}  (2) ${AJS} states ${q(runDir)}  (3) ${AJS} ids ${q(runDir)} ${q(areas[0].id)} . Step 3 only proves every entry carries a valid [area: id] tag. Return ok true with the outputs as detail if all exited 0, otherwise ok false with the error. Change nothing else.`, { ...CHEAP, label: 'areas-join', phase: 'Inventory', schema: RUN_RESULT })
      if (!joined || !joined.ok) throw new Error(`Inventory: joining the areas failed: ${(joined && joined.detail) || 'agent died'}`)
      const tech = await agent(`Read every file ${runDir}/inventory-areas/*-technology.md (one per area) and write ${runDir}/technology.md: one factual list of languages, frameworks, libraries, storage and build tools (names and versions only), duplicates merged. Then run: node ${q(pluginRoot + '/scripts/check-features.mjs')} ${q(runDir + '/technology.md')} ${q(WORK)}. If it prints failures, edit technology.md to remove them and run it again, at most 2 fix attempts. Return checkPassed. Do not write anywhere else.`, { model: 'sonnet', effort: 'low', label: 'technology-join', phase: 'Inventory', schema: { type: 'object', required: ['checkPassed'], properties: { checkPassed: { type: 'boolean' } } } })
      if (!tech || !tech.checkPassed) throw new Error('Inventory: technology.md failed the no-source check after the join')
      const CHECK = `node ${q(pluginRoot + '/scripts/check-features.mjs')} ${q(runDir + '/features.md')} ${q(WORK)}`
      const dd = await agent(`You are the cross-area dedupe pass. ${runDir}/features.md now holds the features of every area, numbered globally, each entry tagged [area: id]. Find entries from different areas that describe the same behaviour (same trigger, same result) and merge each group into one entry: keep the first entry's ID and its [area: id] tag, add the other finders' "seen by", and list every merged-away ID with the ID it went into in ${runDir}/inventory-areas/dedupe-merged.txt (one line each, create the file even if empty). Merge only when it is clearly the same behaviour; when unsure keep both. Never renumber, never drop an entry otherwise, never remove a tag. Entries stay behaviour words only. Then run: ${CHECK} . If it prints failures, edit features.md to remove them and run it again, at most 2 fix attempts. Return checkPassed.`, { model: 'sonnet', effort: 'medium', label: 'dedupe', phase: 'Inventory', schema: { type: 'object', required: ['checkPassed'], properties: { checkPassed: { type: 'boolean' } } } })
      if (!dd || !dd.checkPassed) throw new Error('Inventory: features.md failed the no-source check after the dedupe')
      const tags = await agent(`Run exactly: ${AJS} ids ${q(runDir)} ${q(areas[0].id)} . Return ok true if it exited 0, otherwise ok false with the error. Change nothing else.`, { ...CHEAP, label: 'tags-check', phase: 'Inventory', schema: RUN_RESULT })
      if (!tags || !tags.ok) throw new Error(`Inventory: after the dedupe an entry lost its area tag: ${(tags && tags.detail) || 'agent died'}`)
    }
    await agent(`Write the file ${runDir}/InventoryFound.done containing the word done. Touch nothing else.`, { ...CHEAP, label: 'InventoryFound.done', phase: 'Inventory' })
  }
  // Foundations: what must carry over whatever the features say (a fixed checklist, proven by code).
  if (!done.has('Foundations.done')) {
    const FCHECK = `node ${q(pluginRoot + '/scripts/foundations.mjs')} check ${q(runDir + '/foundations.md')}`
    const FF = `node ${q(pluginRoot + '/scripts/check-features.mjs')} ${q(runDir + '/foundations.md')} ${q(WORK)}`
    const fd = await agent(`You are the foundations finder. Read the source and docs in ${WORK} (and ${runDir}/golden/ if it exists). Write ${runDir}/foundations.md with exactly these nine sections, in this order, each as a heading line "## <name>": License and attribution; Platforms and packaging; Extension and plugin APIs; Saved user data; Settings and config files; External services; Auth and accounts; Telemetry and crash reporting; Update channels and signing. Under each heading write bullets, each starting with one status: "- found: <what must carry over> (evidence: <where you saw it, in words>)", "- not found: <what you looked for>", or "- not applicable: <why>". Every section has at least one bullet; a found item always names its evidence. Cover: license and attribution notices that must stay; the platforms and packaging formats; extension or plugin APIs and manifests others rely on; saved user data formats, schema versions and migrations; settings, keybinding and user config files; external services and contracts it talks to; sign-in and accounts; telemetry and crash reporting; update channels and signing. If ${runDir}/base.json exists with an upstream that is not null, look at the whole app including its base. ${NOTE} Then run: ${FCHECK} and ${FF}. If either prints failures, edit foundations.md to remove them (rewrite fenced code, file paths, import lines and long copied runs as plain prose, add missing sections, statuses or evidence) and run both again, at most 2 fix attempts. Return checkPassed true only if both passed in the last run.`, { ...FINDER, label: 'foundations', phase: 'Inventory', schema: { type: 'object', required: ['checkPassed'], properties: { checkPassed: { type: 'boolean' } } } })
    if (!fd || !fd.checkPassed) throw new Error('Inventory: foundations.md failed its check after 2 fix tries')
    await agent(`Write the file ${runDir}/Foundations.done containing the word done. Touch nothing else.`, { ...CHEAP, label: 'Foundations.done', phase: 'Inventory' })
  }
  // Second capture: the states the finders discovered, so the builder also sees error and loading states.
  const adir = await adapterDir()
  const cap = await longRun('second-capture', `node ${q(adir + '/capture.mjs')} --app ${q(runDir + '/run.json')} --out ${q(runDir + '/golden')} --states ${q(INV + '/states.json')}`, 'second-capture', 'Inventory')
  if (!exitedOk(cap)) throw new Error(`Inventory: second capture failed: ${whyNot(cap)}. The run can be resumed by running the rebuild-review skill again with ${runDir} as the run folder, which repeats only the capture.`)
  const recap = await agent(`Read ${runDir}/golden/manifest.json and return total (the number of states in ${INV}/states.json) and missing (the entries of notCaptured that start with "state "), as a list of strings. Change nothing.`, { ...CHEAP, label: 'second-capture-manifest', phase: 'Inventory', schema: { type: 'object', required: ['total', 'missing'], properties: { total: { type: 'number' }, missing: { type: 'array', items: { type: 'string' } } } } })
  if (!recap) throw new Error('Inventory: the manifest agent died')
  const gaps = recap.missing || []
  if (gaps.length * 2 > (recap.total || 0)) throw new Error(`Inventory: ${gaps.length} of ${recap.total} states were not captured: ${gaps.slice(0, 5).join('; ')}`)
  await agent(`Write the file ${runDir}/Inventory.done containing the word done. Touch nothing else.`, { ...CHEAP, label: 'Inventory.done', phase: 'Inventory' })
  return stoppedBy
}

// ---- Parity ----
const PAR = `${runDir}/parity`
const TESTS = `${PAR}/tests`
const WRITER = { model: 'sonnet', effort: 'medium' }
const RUN_RESULT = { type: 'object', required: ['ok'], properties: { ok: { type: 'boolean' }, detail: { type: 'string' } } }

async function runParity() {
  const has = await agent(`Read "platform" in ${runDir}/run.json. The adapter folder is ${ADAPTER}/<platform> (flutter uses the android folder). Return ok true if ${ADAPTER}/<that folder>/parity.mjs exists, otherwise ok false with detail "No parity adapter for platform <platform>". Change nothing.`, { ...CHEAP, label: 'parity-adapter', phase: 'Parity', schema: RUN_RESULT })
  if (!has || !has.ok) return { stopped: 'Parity', reason: (has && has.detail) || 'adapter check agent died' }

  const runOn = async (label, appJson, out) => {
    const adir = await adapterDir()
    const r = await longRun(label, `node ${q(adir + '/parity.mjs')} --app ${q(appJson)} --tests ${q(TESTS)} --out ${q(out)}`, label, 'Parity')
    if (!exitedOk(r)) return { ok: false, detail: whyNot(r) }
    return agent(`Return ok true if ${q(out)} exists, otherwise ok false with detail "no results file". Change nothing.`, { ...CHEAP, label: `${label}-out`, phase: 'Parity', schema: RUN_RESULT })
  }
  const mustRun = (r, what) => { if (!r || !r.ok) throw new Error(`Parity: ${what} failed: ${(r && r.detail) || 'agent died'}`) }

  const areas = await ensureAreas()
  const single = areas.length === 1
  await agent(`Create the folders ${TESTS} and ${PAR}/areas (mkdir -p). Change nothing else.`, { ...CHEAP, label: 'parity-areas-setup', phase: 'Parity' })
  const marks = await agent(`List the files ending in .done directly inside ${PAR}/areas (use ls). Return their file names. Change nothing.`, { ...CHEAP, label: 'parity-areas-done', phase: 'Parity', schema: { type: 'object', required: ['done'], properties: { done: { type: 'array', items: { type: 'string' } } } } })
  const doneAreas = new Set((marks && marks.done) || [])
  const writeArea = async (area) => {
    const which = single ? '' : `This run is split into areas and you write tests only for the features of the area "${area.id}": run node ${q(pluginRoot + '/scripts/areas.mjs')} ids ${q(runDir)} ${q(area.id)} to get their IDs; ignore every other feature. `
    const one = single ? '' : ' of your area'
    const untestedFile = single ? `${PAR}/untested.md` : `${PAR}/untested-${area.id}.md`
    const w = await agent(`You are the parity test writer. Read ${runDir}/features.md and ${runDir}/run.json. ${which}For every feature${one} write one test file ${TESTS}/F-xxx.test.mjs, named by the feature's ID (F-001.test.mjs, ...). A feature whose test file already exists in ${TESTS} is skipped (a rerun continues; do not rewrite it). You may start the copy named in run.json to look at the running app (start it from its copy, use the platform's driver; ${STOP_APP}), but you must NOT read any source file under ${WORK} or ${target}; you work only from features.md and what the running app shows. Never quote source in a test.
Each test is a node:test file (import test from 'node:test'; import assert from 'node:assert/strict') that finds the app the way the platform's DRIVING.md says (its "Tests" section). Find things the way a person names them (role, label, visible text), never by id, class or DOM shape. Each test starts its own driver session and closes it at the end. Tests may share data that earlier tests leave behind, so never depend on exact counts or an empty list. Use only limits stated in features.md; never invent a numeric budget. Assert meaning, not wording or names, unless features.md quotes the text as required. Do not assert what the browser does whatever the app does (for example the browser logging a failed resource load). Stay inside the scope of the feature's text: do not test more than it claims. Every assertion carries a message that says what was expected and what was seen, in the feature's own words, for example assert.ok(rows.every((r) => r.hasDue), 'expected every seeded row to show title, status and due date; saw ' + JSON.stringify(seen)). A bare assert.ok on a boolean gives the reader nothing.
A feature marked "keep" gets a test asserting the behaviour. A feature marked "defect" gets a test asserting the Intended behaviour its entry states, so it should fail on the original app. A feature the critic marked unconfirmed, or that cannot be reached from the app, gets no test: list it in ${untestedFile} as "F-xxx: reason". Create that file even if it is empty. ${DRIVER} Do not write anywhere else. ${NOTE}`, { ...WRITER, label: single ? 'parity-writer' : `parity-writer-${area.id}`, phase: 'Parity' })
    if (!w) throw new Error(`Parity: the test writer died${single ? '' : ' in area ' + area.id}`)
    await agent(`Write the file ${PAR}/areas/${area.id}.done containing the word done. Touch nothing else.`, { ...CHEAP, label: `parity-area-${area.id}.done`, phase: 'Parity' })
  }
  const written = await parallel(areas.filter(a => !doneAreas.has(`${a.id}.done`)).map(a => () => writeArea(a)))
  if (written.some(r => r === null)) throw new Error('Parity: a test writer died')
  if (!single) {
    const j = await agent(`Run exactly: node ${q(pluginRoot + '/scripts/areas.mjs')} untested ${q(runDir)} . Return ok true with its output as detail if it exited 0, otherwise ok false with the error. Change nothing else.`, { ...CHEAP, label: 'parity-untested-join', phase: 'Parity', schema: RUN_RESULT })
    if (!j || !j.ok) throw new Error(`Parity: joining untested.md failed: ${(j && j.detail) || 'agent died'}`)
  }

  // Fix loop: a keep test failing on the original, or a defect test passing on it, means the test is wrong. Counted by code.
  const wrongCount = async (label) => {
    const r = await agent(`Run exactly: node ${q(pluginRoot + '/scripts/parity-results.mjs')} wrong ${q(runDir + '/features.md')} ${q(PAR + '/original.json')} . Return its output line as detail, and wrong as the number it printed first. Change nothing.`, { ...CHEAP, label, phase: 'Parity', schema: { type: 'object', required: ['wrong'], properties: { wrong: { type: 'number' }, detail: { type: 'string' } } } })
    if (!r) throw new Error('Parity: the wrong-count agent died')
    return r
  }
  for (let round = 1; round <= 3; round++) {
    mustRun(await runOn(`parity-original-${round}`, `${runDir}/run.json`, `${PAR}/original.json`), 'the run on the original')
    const w = await wrongCount(`parity-wrong-${round}`)
    if (w.wrong === 0) break
    const fixed = await agent(`You are the parity fixer, round ${round} of 3. These tests are wrong on the original (a keep test failed or a defect test passed): ${w.detail}. See ${PAR}/original.json for their results and ${runDir}/features.md for each feature. Fix those test files in ${TESTS}: fix the test, not features.md, unless using the running app (start it from the copy named in ${runDir}/run.json; ${STOP_APP}) proves the features.md entry itself is wrong; then correct the entry in plain behaviour words (no source), keeping its "F-xxx keep." or "F-xxx defect." start. Do not read source under ${WORK} or ${target}. Never delete a test. Use only limits stated in features.md. ${DRIVER}`, { ...WRITER, label: `parity-fix-${round}`, phase: 'Parity' })
    if (!fixed) throw new Error('Parity: the fix agent died')
  }
  mustRun(await runOn('parity-original-a', `${runDir}/run.json`, `${PAR}/original.json`), 'the run on the original')
  mustRun(await runOn('parity-original-b', `${runDir}/run.json`, `${PAR}/original-2.json`), 'the second run on the original')
  const settled = await agent(`Run exactly: node ${q(pluginRoot + '/scripts/parity-results.mjs')} settle ${q(PAR)} ${q(runDir + '/features.md')} . Return ok true with its output as detail if it exited 0, otherwise ok false with the error. Change nothing else.`, { ...CHEAP, label: 'parity-settle', phase: 'Parity', schema: RUN_RESULT })
  mustRun(settled, 'settle')

  // The rebuild, when there is one: the suite runs on it, failures go back to the builder until it passes (code decides when to stop), then the visual diff.
  const RB = `${runDir}/project/rebuild-run.json`
  const hasRb = await agent(`Return ok true if ${q(RB)} exists, otherwise ok false. Change nothing.`, { ...CHEAP, label: 'parity-rebuild-exists', phase: 'Parity', schema: RUN_RESULT })
  if (!hasRb) throw new Error('Parity: the rebuild check agent died')
  if (hasRb.ok) {
    const suite = async (label) => {
      const adir = await adapterDir()
      const p = await agent(`Delete ${q(PAR + '/rebuild.json')} and ${q(PAR + '/run-error.txt')} if they exist. If ${q(RB)} has an "address" (a web app), run node ${q(pluginRoot + '/scripts/free-port.mjs')}, which prints a free port, and set the port in "address" to it (http://127.0.0.1:<port>, nothing else in that file changes; the builder's committed copy keeps its own port and is not committed again); an app with no address needs nothing here. Return ok true when done. Change nothing else.`, { ...CHEAP, label: `${label}-prep`, phase: 'Parity', schema: RUN_RESULT })
      if (!p || !p.ok) return p
      const r = await longRun(label, `node ${q(adir + '/parity.mjs')} --app ${q(RB)} --tests ${q(TESTS)} --out ${q(PAR + '/rebuild.json')}`, label, 'Parity')
      if (exitedOk(r)) return { ok: true }
      await agent(`Write ${q(PAR + '/run-error.txt')} containing exactly this text: ${r.tail}\nTouch nothing else.`, { ...CHEAP, label: `${label}-error`, phase: 'Parity' })
      return { ok: false }
    }
    const LOOP_SCHEMA = { type: 'object', required: ['action', 'reason', 'failing'], properties: { action: { type: 'string', enum: ['done', 'build', 'stop'] }, reason: { type: 'string' }, failing: { type: 'array', items: { type: 'string' } }, restored: { type: 'number' } } }
    let restored = false
    let started = true
    for (let round = 1; ; round++) {
      const ran = await suite(`parity-rebuild-run-${round}`)
      if (!ran) throw new Error('Parity: the suite agent died')
      started = ran.ok
      const d = await agent(`Run exactly: node ${q(pluginRoot + '/scripts/parity-results.mjs')} loop ${q(PAR)} ${q(runDir + '/features.md')} ${q(runDir)} . It prints one JSON line. Return its fields action, reason, failing and restored (leave restored out if it is not there). Change nothing else.`, { ...CHEAP, label: `parity-loop-${round}`, phase: 'Parity', schema: LOOP_SCHEMA })
      if (!d) throw new Error('Parity: the loop agent died')
      if (d.restored !== undefined) restored = true
      if (d.action !== 'build') {
        if (d.action === 'stop') await agent(`Write ${q(PAR + '/loop-stop.txt')} containing: ${d.reason}. Touch nothing else.`, { ...CHEAP, label: 'parity-loop-stop', phase: 'Parity' })
        break
      }
      const bl = await longRun(`parity-build-${round}`, `node ${q(pluginRoot + '/scripts/room.mjs')} build --target ${q(target)} --run-dir ${q(runDir)} --failures ${q(PAR + '/failures.md')}`, `parity-build-${round}`, 'Parity')
      const b = await roomResult(bl, `parity-build-${round}`, 'Parity')
      if (!b || !b.ok) {
        await agent(`Write ${q(PAR + '/loop-stop.txt')} containing: ${(b && b.reason) || 'build agent died'}. Touch nothing else.`, { ...CHEAP, label: 'parity-loop-stop', phase: 'Parity' })
        break
      }
    }
    if (restored) {
      const fin = await suite('parity-rebuild-run-final')
      if (!fin) throw new Error('Parity: the suite agent died')
      started = fin.ok
    }
    if (started) {
      const adir = await adapterDir()
      let rb = { ok: true, detail: 'rebuilt' }
      const c1 = await longRun('parity-rebuild-capture', `node ${q(adir + '/capture.mjs')} --app ${q(RB)} --out ${q(runDir + '/golden-rebuild')} --states ${q(INV + '/states.json')}`, 'parity-rebuild-capture', 'Parity')
      if (!exitedOk(c1)) rb = { ok: false, detail: whyNot(c1) }
      else {
        const c2 = await longRun('parity-rebuild-diff', `node ${q(pluginRoot + '/scripts/visual-diff.mjs')} ${q(runDir + '/golden')} ${q(runDir + '/golden-rebuild')} ${q(PAR + '/visual-diff.json')}`, 'parity-rebuild-diff', 'Parity')
        if (!exitedOk(c2)) rb = { ok: false, detail: whyNot(c2) }
      }
      mustRun(rb, 'the rebuild capture')
    } else {
      await agent(`Append the line "the rebuild would not start, capture and visual diff skipped" to ${q(PAR + '/loop-stop.txt')}. Touch nothing else.`, { ...CHEAP, label: 'parity-loop-stop', phase: 'Parity' })
    }
  }

  const merged = await agent(`Run exactly: node ${q(pluginRoot + '/scripts/parity-results.mjs')} merge ${q(PAR)} ${q(runDir + '/features.md')} . If it exited 0, write ${runDir}/Parity.done containing the word done and return ok true with its output as detail; otherwise return ok false with the error. Touch nothing else.`, { ...CHEAP, label: 'Parity.done', phase: 'Parity', schema: RUN_RESULT })
  mustRun(merged, 'merge')
}

// ---- Score ----
const JUDGES = 3
const SCORE_AGENT = { model: 'sonnet', effort: 'medium' }

async function runScore() {
  const SC = `${runDir}/score`
  const SCORE = `node ${q(`${pluginRoot}/scripts/score.mjs`)}`
  const RUBRIC = `${pluginRoot}/rubric.json`
  const has = await agent(`Check that both ${runDir}/project/rebuild-run.json and ${runDir}/parity/parity.json exist. Return ok true if both do, otherwise ok false with detail naming the missing file(s). Change nothing.`, { ...CHEAP, label: 'score-inputs', phase: 'Score', schema: RUN_RESULT })
  if (!has || !has.ok) return { stopped: 'Score', reason: (has && has.detail) || 'there is no rebuild or parity result to score yet' }
  const mustRun = (r, what) => { if (!r || !r.ok) throw new Error(`Score: ${what} failed: ${(r && r.detail) || 'agent died'}`) }

  // 1. Measure both sides, then make the blind copies. Labels stay in this script's memory until judging ends.
  const prep = await agent(`Run these in order, stopping at the first error:
(1) rm -rf ${q(SC)} && mkdir -p ${q(SC)}
(2) ${SCORE} measure "$(${SCORE} source ${q(runDir)} original)" ${q(`${runDir}/golden`)} ${q(`${SC}/original.json`)} --run ${q(`${runDir}/run.json`)} --own-run ${q(runDir)} --side original
(3) ${SCORE} measure "$(${SCORE} source ${q(runDir)} rebuild)" ${q(`${runDir}/golden-rebuild`)} ${q(`${SC}/rebuild.json`)} --run ${q(`${runDir}/project/rebuild-run.json`)} --own-run ${q(runDir)} --side rebuild
(4) ${SCORE} blind ${q(runDir)} ${JUDGES}
Step 4 prints one line of JSON {folder, judges:[{A,B},...]}. Return ok true with folder and judges copied exactly from it. If a step failed return ok false with the error as detail. Do not write the label map to any file.`,
  { ...CHEAP, label: 'score-measure-blind', phase: 'Score', schema: { type: 'object', required: ['ok'], properties: { ok: { type: 'boolean' }, detail: { type: 'string' }, folder: { type: 'string' }, judges: { type: 'array', items: { type: 'object', required: ['A', 'B'], properties: { A: { type: 'string' }, B: { type: 'string' } } } } } } })
  mustRun(prep, 'measure and blind')
  const { folder, judges } = prep

  // 2. Blind judges in parallel, each followed by the citation check. A big app is judged area by area: every judge answers once per area,
  //    looking at that area's features and screens; code weighs the areas by their counted lines. One area is judged as before.
  const areas = await ensureAreas()
  const multi = areas.length > 1
  const jobs = judges.flatMap((_, i) => (multi ? areas : [null]).map(a => ({ i, a })))
  const judged = await parallel(jobs.map(({ i, a }) => async () => {
    const dir = `${folder}/judge-${i}`
    const out = a ? `${SC}/areas/${a.id}/judge-${i}.json` : `${SC}/judge-${i}.json`
    const answer = a ? `${dir}/answer-${a.id}.json` : `${dir}/answer.json`
    const scope = a ? ` Judge only the area "${a.id}": its features are the entries of ${runDir}/features.md tagged [area: ${a.id}] and its screens are the ones that belong to those features; ignore the rest of the app.` : ''
    const j = await agent(`Read ${pluginRoot}/prompts/judge.md and follow it. Your folder is ${dir} (read nothing outside it, except ${RUBRIC} for the questions).${scope} Write your answer to ${answer}.`, { ...SCORE_AGENT, label: a ? `judge-${a.id}-${i}` : `judge-${i}`, phase: 'Score' })
    if (j === null) return null
    return agent(`Run exactly: ${SCORE} check ${q(answer)} ${q(dir)} ${q(out)} . Return ok true with its output as detail if it exited 0, otherwise ok false with the error. Change nothing else.`, { ...CHEAP, label: a ? `check-${a.id}-${i}` : `check-${i}`, phase: 'Score', schema: RUN_RESULT })
  }))
  if (judged.every(r => !r || !r.ok)) throw new Error('Score: no judge produced a usable answer')

  // 3. Judging is over: write the label map, then the skeptics look at each large gap.
  mustRun(await agent(`Run exactly this one command (the JSON is single-quoted, copy it character for character): ${SCORE} labels ${q(runDir)} ${q(folder)} '${JSON.stringify({ judges })}' . Return ok true with its output as detail if it exited 0, otherwise ok false with the error. Change nothing else.`, { ...CHEAP, label: 'write-labels', phase: 'Score', schema: RUN_RESULT }), 'writing the label map')
  const gapList = await agent(`Run exactly: ${SCORE} gaps ${q(runDir)} ${q(RUBRIC)} . It prints a JSON list. Return ok true and gaps as that list (each entry copied exactly, as a JSON string in "json"), or ok false with the error as detail. Change nothing else.`,
    { ...CHEAP, label: 'score-gaps', phase: 'Score', schema: { type: 'object', required: ['ok'], properties: { ok: { type: 'boolean' }, detail: { type: 'string' }, gaps: { type: 'array', items: { type: 'object', required: ['id', 'json'], properties: { id: { type: 'string' }, json: { type: 'string' } } } } } } })
  mustRun(gapList, 'gaps')
  await parallel((gapList.gaps || []).map(g => () => agent(`Read ${pluginRoot}/prompts/skeptic.md and follow it. The gap: ${g.json}. Its id is ${g.id}. Evidence: for ids of the form j<N>-<k> or <area>.j<N>-<k>, the judge's folder is ${folder}/judge-<N>/ (the label map is in ${SC}/.labels.json; an area id means the judge answered only for that area, see ${SC}/areas/<area>/judge-<N>.json); for ids starting with m-, see ${SC}/original.json, ${SC}/rebuild.json, ${runDir}/golden and ${runDir}/golden-rebuild. Write your answer to ${SC}/skeptic/${g.id}.json (mkdir -p the folder).`, { ...SCORE_AGENT, label: `skeptic-${g.id}`, phase: 'Score' })))

  // 4. The arithmetic is code.
  mustRun(await agent(`Run exactly: ${SCORE} collate ${q(runDir)} ${q(RUBRIC)} . Return ok true with its output as detail if it exited 0, otherwise ok false with the error. Change nothing else.`, { ...CHEAP, label: 'collate', phase: 'Score', schema: RUN_RESULT }), 'collate')

  // 5. Three-way compare.
  const cmp = await agent(`Read ${pluginRoot}/prompts/compare.md and follow it. The run folder is ${runDir}; write ${SC}/compare.md.`, { ...SCORE_AGENT, label: 'compare', phase: 'Score' })
  if (!cmp) throw new Error('Score: the compare agent died')

  // 6. The judges' folder names no version once the map is known, but it is temporary: delete it.
  await agent(`Delete the folder ${folder} (rm -rf, only if its name contains rr-judges-). Then write ${runDir}/Score.done containing the word done. Touch nothing else.`, { ...CHEAP, label: 'Score.done', phase: 'Score' })
}

// ---- Report ----
const REPORT = `node ${q(`${pluginRoot}/scripts/report.mjs`)}`
const reportStep = (cmd, label) => agent(`Run exactly: ${cmd} . Return ok true with its output as detail if it exited 0, otherwise ok false with the error. Change nothing else.`, { ...CHEAP, label, phase: 'Report', schema: RUN_RESULT })

async function runReport() {
  const cv = await reportStep(`node ${q(`${pluginRoot}/scripts/areas.mjs`)} coverage ${q(runDir)}`, 'coverage')
  if (!cv || !cv.ok) throw new Error(`Report: coverage failed: ${(cv && cv.detail) || 'agent died'}`)
  const v = await reportStep(`${REPORT} verdict ${q(runDir)}`, 'verdict')
  if (!v || !v.ok) throw new Error(`Report: verdict failed: ${(v && v.detail) || 'agent died'}`)
  await agent(`Read ${pluginRoot}/prompts/actions.md and follow it. The run folder is ${runDir}; write ${runDir}/report/actions.proposed.json (mkdir -p the folder). The verdict, decided by code, is: ${v.detail}. If score/score.json does not exist, write an empty list [].`, { model: 'sonnet', effort: 'medium', label: 'actions', phase: 'Report' })
  const chk = await reportStep(`${REPORT} check-actions ${q(runDir)}`, 'check-actions')
  if (!chk || !chk.ok) throw new Error(`Report: check-actions failed: ${(chk && chk.detail) || 'agent died'}`)
  if (done.has('Foundations.done') || (await agent(`Return ok true if the file ${runDir}/foundations.md exists, otherwise ok false. Change nothing.`, { ...CHEAP, label: 'foundations-exists', phase: 'Report', schema: RUN_RESULT })).ok) {
    await agent(`You compare what had to carry over with what was rebuilt. Read ${runDir}/foundations.md: its items are numbered per section in file order, ids like license.1, platforms.2, extensions.1, userdata.1, config.1, services.1, auth.1, telemetry.1, updates.1 (the section order is license, platforms, extensions, userdata, config, services, auth, telemetry, updates). For every item marked found, look in ${runDir}/project (the rebuild) and decide whether the rebuild kept it. Write ${runDir}/report/foundations.proposed.json (mkdir -p the folder): a list of {\"item\":\"<id>\",\"status\":\"kept\"|\"changed\"|\"missing\",\"evidence\":[{\"kind\":\"file\",\"ref\":\"project/<path>[:line]\"} or {\"kind\":\"feature\",\"ref\":\"F-xxx\"} or {\"kind\":\"metric\",\"ref\":\"<name>\"}]}. Every entry needs at least one real citation; an entry with a citation that does not exist is dropped by code and the item reads not checked. Use only behaviour words for anything you write. Never change anything in ${runDir}/project or ${target}.`, { model: 'sonnet', effort: 'medium', label: 'foundations-status', phase: 'Report' })
    const fchk = await reportStep(`${REPORT} check-foundations ${q(runDir)}`, 'check-foundations')
    if (!fchk || !fchk.ok) throw new Error(`Report: check-foundations failed: ${(fchk && fchk.detail) || 'agent died'}`)
  }
  const r = await reportStep(`${REPORT} render ${q(runDir)}`, 'render')
  if (!r || !r.ok) throw new Error(`Report: render failed: ${(r && r.detail) || 'agent died'}`)
  await agent(`If ${runDir}/report/index.html exists, write ${runDir}/Report.done containing the word done. Otherwise write nothing. Touch nothing else.`, { ...CHEAP, label: 'Report.done', phase: 'Report' })
}

// A stopped run still gets the leave page. No actions agent and no Report.done, so a rerun continues; a failure here never hides the stop reason.
async function stoppedReport(phase, reason) {
  try { await reportStep(`${REPORT} render ${q(runDir)} --stopped ${q(`${phase}: ${reason}`)}`, 'render-stopped') } catch (e) {}
}

const ran = []
// First step of every run, resumes included: adapter dependencies (scripts/adapter-deps.mjs).
const deps = await agent(`Run exactly: node ${q(pluginRoot + '/scripts/adapter-deps.mjs')} ${q(pluginRoot)} . Return ok true if it exited 0, otherwise ok false with its error output as detail. Change nothing else.`, { ...CHEAP, label: 'adapter-deps', schema: RUN_RESULT })
if (!deps || !deps.ok) {
  const reason = `adapter dependencies: ${(deps && deps.detail) || 'agent died'}`
  await stoppedReport('Setup', reason)
  return { ran, stopped: 'Setup', reason }
}
for (const phase of PHASES) {
  if (done.has(`${phase}.done`)) continue
  if (phase === 'Capture') {
    const prep = await agent(
      `Prepare the capture of the running app of ${target}. Never run or write to ${target} itself.
1. Clone it: git clone ${target} ${runDir}/work
2. Work out from the files in ${runDir}/work how to install, build and start the app and which address it listens on. Run: node ${q(pluginRoot + '/scripts/free-port.mjs')} and use the port it prints in "address"; if the app cannot listen on a chosen port, keep the port it uses and say so in the result. Then write ${runDir}/run.json (if it already exists with a \"base\" key, keep that key exactly as it is): {"platform": "web", "dir": "<folder inside work, relative to work/, e.g. app; never an absolute path>", "install": "...", "build": "...", "start": "...", "address": "http://127.0.0.1:<port>"}. The start command must read the port from the PORT environment variable or use the port in the address. Only web apps on localhost are supported on this path (Electron apps and command-line tools are below).
   For an Electron app (its package.json depends on electron) there is no address: write {"platform": "electron", "dir": "...", "install": "...", "build": "...", "env": {"<NAME>": "<stand-in value>"}, "launch": {"args": ["<the app entry, usually .>"], "schemes": ["<custom URL schemes the app registers, if any>"]}} instead. Read the app's own dev launch script (package.json scripts such as dev or start, or a launch file) to find the real entry, the arguments it passes and the environment variables it sets (for example one that selects a dev profile or points at a local server); put those variables in "env" with stand-in values, never real secrets, and take the schemes from the app's protocol registration code. The app starts in an isolated profile with no network except this machine, so a launch step that needs a running dev server or a login must be said in the result.
   For a command-line tool (no server, no window; a bin entry, a main package, a [[bin]]) there is no address either: write {"platform": "cli", "dir": "...", "install": "...", "build": "...", "env": {"<NAME>": "<stand-in value>"}, "command": ["<the executable>", "<fixed arguments, if any>"]} instead. command[0] is a name on PATH (node, python3) or a path inside the work copy relative to dir (a file the build makes, or a script with a shebang and the executable bit); a fixed argument that names a file in the work copy is passed with its full path. Read the tool's own bin entry or build output to find it. The tool runs in an empty folder with an empty home and no network, so a command that needs a file, a login or the network must be said in the result.
3. If the project is none of a web app, an Electron app or a command-line tool (no adapter for its platform), do not guess: write nothing else and return captured false with the reason "No capture adapter for platform <platform>".
4. Otherwise do not run the capture yourself; return captured true when run.json is written. If any step failed, return captured false with the error as the reason.`,
      { model: 'sonnet', effort: 'low', label: 'Capture', phase, schema: CAPTURE_RESULT },
    )
    if (!prep || !prep.captured) { const reason = (prep && prep.reason) || 'capture agent died'; await stoppedReport(phase, reason); return { ran, stopped: 'Capture', reason } }
    const cap = await longRun('capture', `node ${q((await adapterDir()) + '/capture.mjs')} --app ${q(runDir + '/run.json')} --out ${q(runDir + '/golden')}`, 'capture', phase)
    if (!exitedOk(cap)) { const reason = `the capture did not finish: ${whyNot(cap)}`; await stoppedReport(phase, reason); return { ran, stopped: 'Capture', reason } }
    const captured = await agent(`If ${runDir}/golden/manifest.json exists, write ${runDir}/Capture.done containing the word done and return captured true. Otherwise return captured false with the reason "no manifest.json". Touch nothing else.`, { ...CHEAP, label: 'Capture.done', phase, schema: CAPTURE_RESULT })
    if (!captured || !captured.captured) { const reason = (captured && captured.reason) || 'capture agent died'; await stoppedReport(phase, reason); return { ran, stopped: 'Capture', reason } }
    ran.push(phase)
    continue
  }
  if (phase === 'Inventory') { await runInventory(); ran.push(phase); continue }
  if (phase === 'Parity') {
    const p = await runParity()
    if (p && p.stopped) { await stoppedReport(p.stopped, p.reason); return { ran, stopped: p.stopped, reason: p.reason } }
    ran.push(phase)
    continue
  }
  if (phase === 'Stack' || phase === 'Rebuild') {
    const mode = phase === 'Stack' ? 'stack' : 'build'
    // The room script does the work in a clean room (scripts/room.mjs); the agent only runs it and reports.
    const rl = await longRun(`room-${mode}`, `node ${q(pluginRoot + '/scripts/room.mjs')} ${mode} --target ${q(target)} --run-dir ${q(runDir)}`, phase, phase)
    const r = await roomResult(rl, phase, phase)
    if (!r || !r.ok) { const reason = (r && r.reason) || 'room agent died'; await stoppedReport(phase, reason); return { ran, stopped: phase, reason } }
    if (phase === 'Rebuild') {
      const same = await agent(`Read "platform" in ${q(runDir + '/run.json')} and "platform" in ${q(runDir + '/project/rebuild-run.json')}. Return ok true if they are the same text, otherwise ok false with detail "The rebuild is on platform <B> but the original is on <A>; the review only compares a rebuild on the same platform". Change nothing.`, { ...CHEAP, label: 'platform-check', phase, schema: { type: 'object', required: ['ok'], properties: { ok: { type: 'boolean' }, detail: { type: 'string' } } } })
      if (!same || !same.ok) { const reason = (same && same.detail) || 'platform check agent died'; await stoppedReport(phase, reason); return { ran, stopped: phase, reason } }
    }
    await agent(`Write the file ${runDir}/${phase}.done containing the word done. Touch nothing else.`, { ...CHEAP, label: `${phase}.done`, phase })
    ran.push(phase)
    continue
  }
  if (phase === 'Score') {
    const sc = await runScore()
    if (sc && sc.stopped) { await stoppedReport(sc.stopped, sc.reason); return { ran, stopped: sc.stopped, reason: sc.reason } }
    ran.push(phase)
    continue
  }
  if (phase === 'Report') { await runReport(); ran.push(phase); continue }
  await agent(
    `Stub for the ${phase} phase. Write a file at ${runDir}/${phase}.done containing the word done. Touch nothing else. The target ${target} must not be modified.`,
    { ...CHEAP, label: phase, phase },
  )
  ran.push(phase)
}
return { runDir, skipped: PHASES.filter(p => !ran.includes(p)), ran }

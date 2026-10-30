export const meta = {
  name: 'rebuild-review-run',
  description: 'Rebuild a project from its behaviour and rendered output, then score the rebuild. Stub phases for now.',
  whenToUse: 'Started by the rebuild-review skill. Requires args {target, runDir, pluginRoot}.',
  phases: [
    { title: 'Capture' }, { title: 'Inventory' }, { title: 'Stack' }, { title: 'Rebuild' },
    { title: 'Parity' }, { title: 'Score' }, { title: 'Report' },
  ],
}

const ARGS = typeof args === 'string' ? (() => { try { return JSON.parse(args) } catch (e) { return args } })() : args
if (!ARGS || !ARGS.target || !ARGS.runDir || !ARGS.pluginRoot) {
  throw new Error('rebuild-review workflow requires args: {target, runDir, pluginRoot}')
}
const { target, runDir } = ARGS
const pluginRoot = ARGS.pluginRoot
const PHASES = ['Capture', 'Inventory', 'Stack', 'Rebuild', 'Parity', 'Score', 'Report']
const ADAPTER = `${ARGS.pluginRoot}/adapters`
const CHEAP = { model: 'haiku', effort: 'low' }
const CAPTURE_RESULT = { type: 'object', properties: { captured: { type: 'boolean' }, reason: { type: 'string' } }, required: ['captured'] }

// Scripts cannot read the filesystem, so an agent lists the finished phases.
const listed = await agent(
  `List the files ending in .done directly inside ${runDir} (use ls). Return their file names. Change nothing.`,
  { ...CHEAP, label: 'resume', schema: { type: 'object', required: ['done'], properties: { done: { type: 'array', items: { type: 'string' } } } } },
)
const done = new Set((listed && listed.done) || [])

// ---- Inventory ----
const INV = `${runDir}/inventory`
const WORK = `${runDir}/work`
const CHECK = `node ${pluginRoot}/scripts/check-features.mjs ${runDir}/features.md ${WORK}`
const DRIVER = 'If no driver for the platform is installed, install one in a scratch folder outside ' + WORK + ' and ' + target + ' (for a web app: npm install playwright and its browser in a temp folder) and use it; do not give up on using the app. Build output and installs belong to the run copy only; never edit tracked files.'
const UX = 'For every screen and every action, judge it the way someone who cares about speed, UX, compatibility and accessibility would, and record every problem you see or find evidence of. Examples, not a complete list: missing loading, empty or error states; no feedback after an action; a success message after a failure; content moving after a load; focus lost while typing; input lost on navigation or reload; broken back navigation or deep links; actions that can be done twice by accident; destructive actions with no confirmation or undo; requests repeated or wasted; slow first load or slow redraws; responses applied out of order; layouts that break at small or large screens; controls unreachable by keyboard or screen reader; low contrast or tiny targets; truncated text and confusing messages. State each as a defect with the behaviour that should hold.'
const FINDER = { model: 'sonnet', effort: 'medium' }
const NOTE = 'Write in behaviour words only: what a user sees and does. Never quote source code, file paths, or copy text longer than a short phrase from files. Do not modify anything under ' + WORK + ' or ' + target + '. Do not look for answer or benchmark files.'

const FINDERS = [
  { name: 'code-reader', prompt: `You are a code reader. Read the source in ${WORK}. List every user-visible feature and behaviour you can find: routes, handlers, state, settings, keyboard shortcuts, URL flags, error and empty states, anything that only shows up in some situations. ${UX} Reason from the code to what a user would see. Write ${INV}/code-reader.md as a bullet list, one item per behaviour, each with given/when/then. Also write ${runDir}/technology.md: a factual list of languages, frameworks, libraries, storage and build tools (names and versions only). ${NOTE} Do not write anywhere else.` },
  { name: 'black-box-user', prompt: `You are a black-box user. Read ${runDir}/run.json for the platform, the commands and the address, install/build/start the app from the copy named there (set the PORT environment variable to the port in the address) if it is not already running, and use it through the platform's driver (for a web app: a headless browser such as playwright, installed in a scratch folder outside ${WORK}). You may read ${runDir}/golden/ if it exists. Do NOT read any source under ${WORK}; treat it as unreadable. Use every screen, control, keyboard key, URL option you can discover, and try slow and failing conditions. Note what happens. ${UX} Write ${INV}/black-box-user.md as a bullet list with given/when/then per behaviour, and ${INV}/states.json: a list of {id, steps} where a step is one of open, click, type, press, wait, failRequest, slowRequest with targets given by accessible name or text, that reproduce each state you found. ${DRIVER} Stop the app when done. ${NOTE} Do not write anywhere else.` },
  { name: 'history-reader', prompt: `You are a history reader. In ${WORK} read git log with messages and diffs (git log -p). If gh can see a remote, also read closed issues and PRs. Every bug fix or small behaviour change becomes a requirement written in behaviour words (what must be true for a user). Write ${INV}/history-reader.md as a bullet list with given/when/then per item. ${NOTE} Do not write anywhere else.` },
  { name: 'docs-reader', prompt: `You are a docs reader. Read the README, help text, changelogs and any docs in ${WORK}. List every behaviour they promise or describe. Write ${INV}/docs-reader.md as a bullet list with given/when/then per item. ${NOTE} Do not write anywhere else.` },
]

async function runInventory() {
  let stoppedBy = 'an earlier run'
  if (!done.has('InventoryFound.done')) {
    await agent(`Create the folder ${INV} (mkdir -p). Change nothing else.`, { ...CHEAP, label: 'inventory-setup', phase: 'Inventory' })
    const found = await parallel(FINDERS.map(f => () => agent(f.prompt, { ...FINDER, label: f.name, phase: 'Inventory' })))
    if (found.some(r => r === null)) throw new Error('Inventory: a finder died, so features.md would be incomplete')

    const fixRule = `Then run: ${CHECK}. If it prints failures, edit features.md to remove them (rewrite fenced code, file paths, import or JSX lines and long copied runs in plain prose) and run it again, at most 2 fix attempts. Report the final check output.`
    const checkSchema = { type: 'object', required: ['checkPassed'], properties: { checkPassed: { type: 'boolean' } } }
    const merged = await agent(`You are the merger. Read every file in ${INV} (the finders' lists; ignore states.json) and merge them into ${runDir}/features.md. You may read ${runDir}/golden/ if it exists. Each entry: an ID (F-001, F-002, ...), what it does, given/when/then, "seen by:" (which finders), and "keep" or "defect". A defect states the intended behaviour and cites evidence from golden/probes.json or a finder's observation; it never contains a fix that depends on the implementation. Merge duplicates, but never drop an item that only one finder reported. Entries describe behaviour only: no code blocks, file paths, imports or copied source text. ${fixRule} Return checkPassed.`, { label: 'merge', phase: 'Inventory', schema: checkSchema })
    if (!merged || !merged.checkPassed) throw new Error('Inventory: features.md failed the no-source check after the merge')

    stoppedBy = 'a round with nothing new'
    for (let round = 1; round <= 3; round++) {
      const r = await agent(`You are the critic, round ${round}. Read ${runDir}/features.md and ${runDir}/golden/ (if it exists) and list what is missing: behaviours, states, keys, URL options, defects. Use the app (see ${runDir}/run.json; start it from its copy if needed with the PORT environment variable set to the port in the address, and stop it after; use the platform's driver; do not read source under ${WORK}) to check anything uncertain. ${DRIVER} Every entry whose "seen by" has only one finder must be checked by using the app: mark it confirmed, or mark it "unconfirmed" with the reason. Never delete an entry without saying so in features.md. Add missing items to features.md as new entries in the same format (no code, paths or copied source text). Write the changes into features.md. If you changed nothing this round, add nothing. ${fixRule} Return checkPassed and whether you added or changed anything.`, { label: `critic-${round}`, phase: 'Inventory', schema: { type: 'object', required: ['checkPassed', 'changed'], properties: { checkPassed: { type: 'boolean' }, changed: { type: 'boolean' } } } })
      if (!r || !r.checkPassed) throw new Error(`Inventory: features.md failed the no-source check after critic round ${round}`)
      if (!r.changed) break
      if (round === 3) {
        stoppedBy = 'the 3-round cap'
        await agent(`Append a final line to ${runDir}/features.md: "Critic loop stopped by the 3-round cap, not by a round with nothing new." Then run ${CHECK} and report nothing else.`, { ...CHEAP, label: 'cap-note', phase: 'Inventory' })
      }
    }
    await agent(`Write the file ${runDir}/InventoryFound.done containing the word done. Touch nothing else.`, { ...CHEAP, label: 'InventoryFound.done', phase: 'Inventory' })
  }
  // Second capture: the states the finders discovered, so the builder also sees error and loading states.
  const recap = await agent(`Run the capture adapter again with the states the finders found. Read "platform" in ${runDir}/run.json; the adapter is ${ADAPTER}/<platform>/capture.mjs (flutter uses the android folder). Run: node <adapter> --app ${runDir}/run.json --out ${runDir}/golden --states ${INV}/states.json. Return ok true if it exited 0, with the states count it printed, otherwise ok false with the error. Change nothing else.`, { model: 'sonnet', effort: 'low', label: 'second-capture', phase: 'Inventory', schema: { type: 'object', required: ['ok'], properties: { ok: { type: 'boolean' }, detail: { type: 'string' } } } })
  if (!recap || !recap.ok) throw new Error(`Inventory: second capture failed: ${(recap && recap.detail) || 'agent died'}. The run can be resumed by running the rebuild-review skill again with ${runDir} as the run folder, which repeats only the capture.`)
  await agent(`Write the file ${runDir}/Inventory.done containing the word done. Touch nothing else.`, { ...CHEAP, label: 'Inventory.done', phase: 'Inventory' })
  return stoppedBy
}

const ran = []
for (const phase of PHASES) {
  if (done.has(`${phase}.done`)) continue
  if (phase === 'Capture') {
    const captured = await agent(
      `Capture the running app of ${target}. Never run or write to ${target} itself.
1. Clone it: git clone ${target} ${runDir}/work
2. Work out from the files in ${runDir}/work how to install, build and start the app and which address it listens on. Run: node ${pluginRoot}/scripts/free-port.mjs and use the port it prints in "address"; if the app cannot listen on a chosen port, keep the port it uses and say so in the result. Then write ${runDir}/run.json: {"platform": "web", "dir": "<folder inside work>", "install": "...", "build": "...", "start": "...", "address": "http://127.0.0.1:<port>"}. The start command must read the port from the PORT environment variable or use the port in the address. Only web apps on localhost are supported.
3. If the project is not a web app (no adapter for its platform), do not guess: write nothing else and return captured false with the reason "No capture adapter for platform <platform>".
4. Otherwise run: node ${ADAPTER}/web/capture.mjs --app ${runDir}/run.json --out ${runDir}/golden
5. When ${runDir}/golden/manifest.json exists, write ${runDir}/Capture.done containing the word done and return captured true. If any step failed, return captured false with the error as the reason.`,
      { model: 'sonnet', effort: 'low', label: 'Capture', phase, schema: CAPTURE_RESULT },
    )
    if (!captured || !captured.captured) return { ran, stopped: 'Capture', reason: (captured && captured.reason) || 'capture agent died' }
    ran.push(phase)
    continue
  }
  if (phase === 'Inventory') { await runInventory(); ran.push(phase); continue }
  await agent(
    `Stub for the ${phase} phase. Write a file at ${runDir}/${phase}.done containing the word done. Touch nothing else. The target ${target} must not be modified.`,
    { ...CHEAP, label: phase, phase },
  )
  ran.push(phase)
}
return { runDir, skipped: PHASES.filter(p => !ran.includes(p)), ran }

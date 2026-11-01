export const meta = {
  name: 'rebuild-review-run',
  description: 'Rebuild a project from its behaviour and rendered output, then score the rebuild.',
  whenToUse: 'Started by the rebuild-review skill. Requires args {target, runDir, pluginRoot}.',
  phases: [
    { title: 'Capture' }, { title: 'Inventory' }, { title: 'Stack' }, { title: 'Rebuild' },
    { title: 'Parity' }, { title: 'Score' }, { title: 'Report' },
  ],
}

// A capture's probes take about a minute per screen on a real app, far over the Bash limits.
const LONG = 'Run each node command with the Bash tool with run_in_background true and timeout 7200000, then wait for it to end before going on.'
const q = JSON.stringify
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
const CHECK = `node ${q(pluginRoot + '/scripts/check-features.mjs')} ${q(runDir + '/features.md')} ${q(WORK)}`
const DRIVER = 'If no driver for the platform is installed, install one in a scratch folder outside ' + WORK + ' and ' + target + ' (for a web app: npm install playwright and its browser in a temp folder) and use it; do not give up on using the app. Build output and installs belong to the run copy only; never edit tracked files.'
const UX = 'For every screen and every action, judge it the way someone who cares about speed, UX, compatibility and accessibility would, and record every problem you see or find evidence of. Examples, not a complete list: missing loading, empty or error states; no feedback after an action; a success message after a failure; content moving after a load; focus lost while typing; input lost on navigation or reload; broken back navigation or deep links; actions that can be done twice by accident; destructive actions with no confirmation or undo; requests repeated or wasted; slow first load or slow redraws; responses applied out of order; layouts that break at small or large screens; controls unreachable by keyboard or screen reader; low contrast or tiny targets; truncated text and confusing messages. State each as a defect with the behaviour that should hold.'
const FINDER = { model: 'sonnet', effort: 'medium' }
const NOTE = 'Write in behaviour words only: what a user sees and does. Never quote source code, file paths, or copy text longer than a short phrase from files. Do not modify anything under ' + WORK + ' or ' + target + '. Do not look for answer or benchmark files.'

const FINDERS = [
  { name: 'code-reader', prompt: `You are a code reader. Read the source in ${WORK}. List every user-visible feature and behaviour you can find: routes, handlers, state, settings, keyboard shortcuts, URL flags, error and empty states, anything that only shows up in some situations. ${UX} Reason from the code to what a user would see. Write ${INV}/code-reader.md as a bullet list, one item per behaviour, each with given/when/then. Also write ${runDir}/technology.md: a factual list of languages, frameworks, libraries, storage and build tools (names and versions only). ${NOTE} Do not write anywhere else.` },
  { name: 'black-box-user', prompt: `You are a black-box user. Read ${runDir}/run.json for the platform, the commands and the address, install/build/start the app from the copy named there (set the PORT environment variable to the port in the address) if it is not already running, and use it through the platform's driver (for a web app: a headless browser such as playwright, installed in a scratch folder outside ${WORK}). You may read ${runDir}/golden/ if it exists. Do NOT read any source under ${WORK}; treat it as unreadable. Use every screen, control, keyboard key, URL option you can discover, and try slow and failing conditions. Note what happens. ${UX} Write ${INV}/black-box-user.md as a bullet list with given/when/then per behaviour, and ${INV}/states.json: a list of {id, steps} where a step is exactly one of {\"open\":\"<path>\"}, {\"click\":\"<name>\"}, {\"type\":{\"into\":\"<name>\",\"text\":\"...\"}}, {\"press\":\"<key>\"}, {\"wait\":<ms>}, {\"failRequest\":\"<address part>\"}, {\"slowRequest\":{\"match\":\"<address part>\",\"ms\":<n>}} with names given by accessible name or text, that reproduce each state you found. ${DRIVER} Stop the app when done. ${NOTE} Do not write anywhere else.` },
  { name: 'history-reader', prompt: `You are a history reader. In ${WORK} read git log with messages and diffs (git log -p). If gh can see a remote, also read closed issues and PRs. Every bug fix or small behaviour change becomes a requirement written in behaviour words (what must be true for a user). Write ${INV}/history-reader.md as a bullet list with given/when/then per item. ${NOTE} Do not write anywhere else.` },
  { name: 'docs-reader', prompt: `You are a docs reader. Read the README, help text, changelogs and any docs in ${WORK}. List every behaviour they promise or describe. Write ${INV}/docs-reader.md as a bullet list with given/when/then per item. ${NOTE} Do not write anywhere else.` },
]

async function runInventory() {
  let stoppedBy = 'an earlier run'
  if (!done.has('InventoryFound.done')) {
    await agent(`Create the folder ${INV} (mkdir -p). Change nothing else.`, { ...CHEAP, label: 'inventory-setup', phase: 'Inventory' })
    const found = await parallel(FINDERS.map(f => () => agent(f.prompt, { ...FINDER, label: f.name, phase: 'Inventory' })))
    if (found.some(r => r === null)) throw new Error('Inventory: a finder died, so features.md would be incomplete')

    const techCheck = await agent(`Run: node ${q(pluginRoot + '/scripts/check-features.mjs')} ${q(runDir + '/technology.md')} ${q(WORK)}. If it prints failures, edit ${runDir}/technology.md to remove them (rewrite file paths, import lines and long copied runs as plain names and versions) and run it again, at most 2 fix attempts. Report the final check output. Return checkPassed. Do not write anywhere else.`, { ...CHEAP, label: 'technology-check', phase: 'Inventory', schema: { type: 'object', required: ['checkPassed'], properties: { checkPassed: { type: 'boolean' } } } })
    if (!techCheck || !techCheck.checkPassed) throw new Error('Inventory: technology.md failed the no-source check after 2 fix tries')

    const fixRule = `Then run: ${CHECK}. If it prints failures, edit features.md to remove them (rewrite fenced code, file paths, import or JSX lines and long copied runs in plain prose) and run it again, at most 2 fix attempts. Report the final check output.`
    const checkSchema = { type: 'object', required: ['checkPassed'], properties: { checkPassed: { type: 'boolean' } } }
    const merged = await agent(`You are the merger. Read every file in ${INV} (the finders' lists; ignore states.json) and merge them into ${runDir}/features.md. You may read ${runDir}/golden/ if it exists. Each entry is one paragraph or bullet that starts with its ID and kind: "F-001 keep." or "F-002 defect." (exactly that start, nothing before the ID except a list marker), then a short name, what it does, given/when/then, and "seen by:" (which finders). A defect states the intended behaviour and cites evidence from golden/probes.json or a finder's observation; it never contains a fix that depends on the implementation. Merge duplicates, but never drop an item that only one finder reported. Something that only the docs describe, with no behaviour in the running app, is not an entry: list it as a plain bullet without an F-id under a \`## Not built (from the docs)\` heading in features.md. A defect that says what the running app does (a measurement, a count, a scroll or focus or contrast behaviour) must record what you did in the running app and what you saw; if you cannot, do not state it as a defect. Entries describe behaviour only: no code blocks, file paths, imports or copied source text. ${fixRule} Return checkPassed.`, { label: 'merge', phase: 'Inventory', schema: checkSchema })
    if (!merged || !merged.checkPassed) throw new Error('Inventory: features.md failed the no-source check after the merge')

    stoppedBy = 'a round with nothing new'
    for (let round = 1; round <= 3; round++) {
      const r = await agent(`You are the critic, round ${round}. Read ${runDir}/features.md and ${runDir}/golden/ (if it exists) and list what is missing: behaviours, states, keys, URL options, defects. Use the app (see ${runDir}/run.json; start it from its copy if needed with the PORT environment variable set to the port in the address, and stop it after; use the platform's driver; do not read source under ${WORK}) to check anything uncertain. ${DRIVER} Every entry whose "seen by" has only one finder must be checked by using the app: mark it confirmed, or mark it "unconfirmed" with the reason. Never delete an entry without saying so in features.md. Add missing items to features.md as new entries in the same format (no code, paths or copied source text). For every defect that says what the running app does, repeat the recorded measurement once in the running app; if it is contradicted or cannot be repeated, remove the claim or mark the entry "unconfirmed" with the reason. Write the changes into features.md. If you changed nothing this round, add nothing. ${fixRule} Return checkPassed and whether you added or changed anything.`, { label: `critic-${round}`, phase: 'Inventory', schema: { type: 'object', required: ['checkPassed', 'changed'], properties: { checkPassed: { type: 'boolean' }, changed: { type: 'boolean' } } } })
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
  const recap = await agent(`Run the capture adapter again with the states the finders found. Read "platform" in ${runDir}/run.json; the adapter is ${ADAPTER}/<platform>/capture.mjs (flutter uses the android folder). ${LONG} Run: node <adapter> --app ${q(runDir + '/run.json')} --out ${q(runDir + '/golden')} --states ${q(INV + '/states.json')}. Return ok true if it exited 0, with the states count it printed, otherwise ok false with the error. Also read ${runDir}/golden/manifest.json and return total (the number of states in ${INV}/states.json) and missing (the entries of notCaptured that start with "state "), as a list of strings. Change nothing else.`, { model: 'sonnet', effort: 'low', label: 'second-capture', phase: 'Inventory', schema: { type: 'object', required: ['ok'], properties: { ok: { type: 'boolean' }, detail: { type: 'string' }, total: { type: 'number' }, missing: { type: 'array', items: { type: 'string' } } } } })
  if (!recap || !recap.ok) throw new Error(`Inventory: second capture failed: ${(recap && recap.detail) || 'agent died'}. The run can be resumed by running the rebuild-review skill again with ${runDir} as the run folder, which repeats only the capture.`)
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

  const runOn = (label, appJson, out) => agent(`Read "platform" in ${runDir}/run.json; the adapter folder is ${ADAPTER}/<platform> (flutter uses the android folder). ${LONG} Run: node <adapter folder>/parity.mjs --app ${q(appJson)} --tests ${q(TESTS)} --out ${q(out)}. Return ok true if it exited 0 and ${out} exists, with its one-line summary as detail; otherwise ok false with the error. Change nothing else.`, { model: 'sonnet', effort: 'low', label, phase: 'Parity', schema: RUN_RESULT })
  const mustRun = (r, what) => { if (!r || !r.ok) throw new Error(`Parity: ${what} failed: ${(r && r.detail) || 'agent died'}`) }

  await agent(`Create the folders ${TESTS} (mkdir -p). Change nothing else.`, { ...CHEAP, label: 'parity-setup', phase: 'Parity' })
  const wrote = await agent(`You are the parity test writer. Read ${runDir}/features.md and ${runDir}/run.json. For every feature write one test file ${TESTS}/F-xxx.test.mjs, named by the feature's ID (F-001.test.mjs, ...). You may start the copy named in run.json to look at the running app (start it from its copy, use the platform's driver, stop it after), but you must NOT read any source file under ${WORK} or ${target}; you work only from features.md and what the running app shows. Never quote source in a test.
Each test is a node:test file (import test from 'node:test'; import assert from 'node:assert/strict') that reads the address from process.env.APP_URL. For a web app import the driver by absolute path: import { chromium } from '${ADAPTER}/web/node_modules/playwright/index.mjs'. Find things the way a person names them (role, label, visible text), never by id, class or DOM shape. Each test launches its own browser and closes it at the end. The tests share one running server and earlier tests leave data behind, so never depend on exact counts or an empty list. Use only limits stated in features.md; never invent a numeric budget. Assert meaning, not wording or names, unless features.md quotes the text as required. Do not assert what the browser does whatever the app does (for example the browser logging a failed resource load). Stay inside the scope of the feature's text: do not test more than it claims. Every assertion carries a message that says what was expected and what was seen, in the feature's own words, for example assert.ok(rows.every((r) => r.hasDue), 'expected every seeded row to show title, status and due date; saw ' + JSON.stringify(seen)). A bare assert.ok on a boolean gives the reader nothing.
A feature marked "keep" gets a test asserting the behaviour. A feature marked "defect" gets a test asserting the Intended behaviour its entry states, so it should fail on the original app. A feature the critic marked unconfirmed, or that cannot be reached from the app, gets no test: list it in ${PAR}/untested.md as "F-xxx: reason". Create untested.md even if it is empty. ${DRIVER} Do not write anywhere else. ${NOTE}`, { ...WRITER, label: 'parity-writer', phase: 'Parity' })
  if (!wrote) throw new Error('Parity: the test writer died')

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
    const fixed = await agent(`You are the parity fixer, round ${round} of 3. These tests are wrong on the original (a keep test failed or a defect test passed): ${w.detail}. See ${PAR}/original.json for their results and ${runDir}/features.md for each feature. Fix those test files in ${TESTS}: fix the test, not features.md, unless using the running app (start it from the copy named in ${runDir}/run.json, stop it after) proves the features.md entry itself is wrong; then correct the entry in plain behaviour words (no source), keeping its "F-xxx keep." or "F-xxx defect." start. Do not read source under ${WORK} or ${target}. Never delete a test. Use only limits stated in features.md. ${DRIVER}`, { ...WRITER, label: `parity-fix-${round}`, phase: 'Parity' })
    if (!fixed) throw new Error('Parity: the fix agent died')
  }
  mustRun(await runOn('parity-original-a', `${runDir}/run.json`, `${PAR}/original.json`), 'the run on the original')
  mustRun(await runOn('parity-original-b', `${runDir}/run.json`, `${PAR}/original-2.json`), 'the second run on the original')
  const settled = await agent(`Run exactly: node ${q(pluginRoot + '/scripts/parity-results.mjs')} settle ${q(PAR)} ${q(runDir + '/features.md')} . Return ok true with its output as detail if it exited 0, otherwise ok false with the error. Change nothing else.`, { ...CHEAP, label: 'parity-settle', phase: 'Parity', schema: RUN_RESULT })
  mustRun(settled, 'settle')

  // The rebuild, when there is one: the suite runs on it, failures go back to the builder until it passes (code decides when to stop), then the visual diff.
  const RB = `${runDir}/project/rebuild-run.json`
  const ADAPTER_PLAT = `Read "platform" in ${runDir}/run.json (the adapter folder is ${ADAPTER}/<platform>; flutter uses the android folder)`
  const hasRb = await agent(`Return ok true if ${q(RB)} exists, otherwise ok false. Change nothing.`, { ...CHEAP, label: 'parity-rebuild-exists', phase: 'Parity', schema: RUN_RESULT })
  if (!hasRb) throw new Error('Parity: the rebuild check agent died')
  if (hasRb.ok) {
    const suite = (label) => agent(`${ADAPTER_PLAT}. Delete ${q(PAR + '/rebuild.json')} and ${q(PAR + '/run-error.txt')} if they exist. Run node ${q(pluginRoot + '/scripts/free-port.mjs')}, which prints a free port, and set the port in "address" of ${q(RB)} to it (http://127.0.0.1:<port>, nothing else in that file changes; the builder's committed copy keeps its own port and is not committed again). ${LONG} Then run: node <adapter folder>/parity.mjs --app ${q(RB)} --tests ${q(TESTS)} --out ${q(PAR + '/rebuild.json')}. If it exits non-zero, write its error text to ${q(PAR + '/run-error.txt')}. Return ok true if it exited 0, otherwise ok false. Change nothing else.`, { model: 'sonnet', effort: 'low', label, phase: 'Parity', schema: RUN_RESULT })
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
      const b = await agent(`Run this command with the Bash tool with run_in_background true and timeout 7200000, then wait until it exits (do not poll in a loop; check once it has finished): node ${q(pluginRoot + '/scripts/room.mjs')} build --target ${q(target)} --run-dir ${q(runDir)} --failures ${q(PAR + '/failures.md')}\nWhen it exits, its last lines are "RESULT <file>" and a JSON line. Read that result file and return ok and reason from it. Change nothing else, and never read anything under ${target} or ${runDir}/work.`, { model: 'sonnet', effort: 'low', label: `parity-build-${round}`, phase: 'Parity', schema: { type: 'object', required: ['ok'], properties: { ok: { type: 'boolean' }, reason: { type: 'string' } } } })
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
      const rb = await agent(`${ADAPTER_PLAT}. ${LONG} Run, in order: (1) node <adapter folder>/capture.mjs --app ${q(RB)} --out ${q(runDir + '/golden-rebuild')} --states ${q(INV + '/states.json')}; (2) only if step (1) exited 0, node ${q(pluginRoot + '/scripts/visual-diff.mjs')} ${q(runDir + '/golden')} ${q(runDir + '/golden-rebuild')} ${q(PAR + '/visual-diff.json')}. Return ok true with detail "rebuilt" if both exited 0, otherwise ok false with the first error (if step (1) failed, do not run step (2)). Change nothing else.`, { model: 'sonnet', effort: 'low', label: 'parity-rebuild', phase: 'Parity', schema: RUN_RESULT })
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
(2) ${SCORE} measure "$(${SCORE} source ${q(runDir)} original)" ${q(`${runDir}/golden`)} ${q(`${SC}/original.json`)} --run ${q(`${runDir}/run.json`)}
(3) ${SCORE} measure "$(${SCORE} source ${q(runDir)} rebuild)" ${q(`${runDir}/golden-rebuild`)} ${q(`${SC}/rebuild.json`)} --run ${q(`${runDir}/project/rebuild-run.json`)}
(4) ${SCORE} blind ${q(runDir)} ${JUDGES}
Step 4 prints one line of JSON {folder, judges:[{A,B},...]}. Return ok true with folder and judges copied exactly from it. If a step failed return ok false with the error as detail. Do not write the label map to any file.`,
  { ...CHEAP, label: 'score-measure-blind', phase: 'Score', schema: { type: 'object', required: ['ok'], properties: { ok: { type: 'boolean' }, detail: { type: 'string' }, folder: { type: 'string' }, judges: { type: 'array', items: { type: 'object', required: ['A', 'B'], properties: { A: { type: 'string' }, B: { type: 'string' } } } } } } })
  mustRun(prep, 'measure and blind')
  const { folder, judges } = prep

  // 2. Blind judges in parallel, each followed by the citation check.
  const judged = await parallel(judges.map((_, i) => async () => {
    const dir = `${folder}/judge-${i}`
    const out = `${SC}/judge-${i}.json`
    const j = await agent(`Read ${pluginRoot}/prompts/judge.md and follow it. Your folder is ${dir} (read nothing outside it, except ${RUBRIC} for the questions). Write your answer to ${dir}/answer.json.`, { ...SCORE_AGENT, label: `judge-${i}`, phase: 'Score' })
    if (j === null) return null
    return agent(`Run exactly: ${SCORE} check ${q(`${dir}/answer.json`)} ${q(dir)} ${q(out)} . Return ok true with its output as detail if it exited 0, otherwise ok false with the error. Change nothing else.`, { ...CHEAP, label: `check-${i}`, phase: 'Score', schema: RUN_RESULT })
  }))
  if (judged.every(r => !r || !r.ok)) throw new Error('Score: no judge produced a usable answer')

  // 3. Judging is over: write the label map, then the skeptics look at each large gap.
  mustRun(await agent(`Run exactly this one command (the JSON is single-quoted, copy it character for character): ${SCORE} labels ${q(runDir)} ${q(folder)} '${JSON.stringify({ judges })}' . Return ok true with its output as detail if it exited 0, otherwise ok false with the error. Change nothing else.`, { ...CHEAP, label: 'write-labels', phase: 'Score', schema: RUN_RESULT }), 'writing the label map')
  const gapList = await agent(`Run exactly: ${SCORE} gaps ${q(runDir)} ${q(RUBRIC)} . It prints a JSON list. Return ok true and gaps as that list (each entry copied exactly, as a JSON string in "json"), or ok false with the error as detail. Change nothing else.`,
    { ...CHEAP, label: 'score-gaps', phase: 'Score', schema: { type: 'object', required: ['ok'], properties: { ok: { type: 'boolean' }, detail: { type: 'string' }, gaps: { type: 'array', items: { type: 'object', required: ['id', 'json'], properties: { id: { type: 'string' }, json: { type: 'string' } } } } } } })
  mustRun(gapList, 'gaps')
  await parallel((gapList.gaps || []).map(g => () => agent(`Read ${pluginRoot}/prompts/skeptic.md and follow it. The gap: ${g.json}. Its id is ${g.id}. Evidence: for ids starting with j<N>-, the judge's folder is ${folder}/judge-<N>/ (the label map is in ${SC}/.labels.json); for ids starting with m-, see ${SC}/original.json, ${SC}/rebuild.json, ${runDir}/golden and ${runDir}/golden-rebuild. Write your answer to ${SC}/skeptic/${g.id}.json (mkdir -p the folder).`, { ...SCORE_AGENT, label: `skeptic-${g.id}`, phase: 'Score' })))

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
  const v = await reportStep(`${REPORT} verdict ${q(runDir)}`, 'verdict')
  if (!v || !v.ok) throw new Error(`Report: verdict failed: ${(v && v.detail) || 'agent died'}`)
  await agent(`Read ${pluginRoot}/prompts/actions.md and follow it. The run folder is ${runDir}; write ${runDir}/report/actions.proposed.json (mkdir -p the folder). The verdict, decided by code, is: ${v.detail}. If score/score.json does not exist, write an empty list [].`, { model: 'sonnet', effort: 'medium', label: 'actions', phase: 'Report' })
  const chk = await reportStep(`${REPORT} check-actions ${q(runDir)}`, 'check-actions')
  if (!chk || !chk.ok) throw new Error(`Report: check-actions failed: ${(chk && chk.detail) || 'agent died'}`)
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
  return { ran, stopped: 'Setup', reason }
}
for (const phase of PHASES) {
  if (done.has(`${phase}.done`)) continue
  if (phase === 'Capture') {
    const captured = await agent(
      `Capture the running app of ${target}. Never run or write to ${target} itself.
1. Clone it: git clone ${target} ${runDir}/work
2. Work out from the files in ${runDir}/work how to install, build and start the app and which address it listens on. Run: node ${q(pluginRoot + '/scripts/free-port.mjs')} and use the port it prints in "address"; if the app cannot listen on a chosen port, keep the port it uses and say so in the result. Then write ${runDir}/run.json: {"platform": "web", "dir": "<folder inside work, relative to work/, e.g. app; never an absolute path>", "install": "...", "build": "...", "start": "...", "address": "http://127.0.0.1:<port>"}. The start command must read the port from the PORT environment variable or use the port in the address. Only web apps on localhost are supported.
3. If the project is not a web app (no adapter for its platform), do not guess: write nothing else and return captured false with the reason "No capture adapter for platform <platform>".
4. Otherwise: ${LONG} Run: node ${q(ADAPTER + '/web/capture.mjs')} --app ${q(runDir + '/run.json')} --out ${q(runDir + '/golden')}
5. When ${runDir}/golden/manifest.json exists, write ${runDir}/Capture.done containing the word done and return captured true. If any step failed, return captured false with the error as the reason.`,
      { model: 'sonnet', effort: 'low', label: 'Capture', phase, schema: CAPTURE_RESULT },
    )
    if (!captured || !captured.captured) return { ran, stopped: 'Capture', reason: (captured && captured.reason) || 'capture agent died' }
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
    const r = await agent(
      `Run this command with the Bash tool and run_in_background true and timeout 7200000 (a build takes far longer than the 10-minute default), then wait until it exits (do not poll in a loop; check once it has finished): node ${JSON.stringify(pluginRoot + '/scripts/room.mjs')} ${mode} --target ${JSON.stringify(target)} --run-dir ${JSON.stringify(runDir)}\nWhen it exits, its last lines are "RESULT <file>" and a JSON line. Read that result file and return ok and reason from it. Change nothing else, and never read anything under ${target} or ${runDir}/work.`,
      { model: 'sonnet', effort: 'low', label: phase, phase, schema: { type: 'object', required: ['ok'], properties: { ok: { type: 'boolean' }, reason: { type: 'string' } } } },
    )
    if (!r || !r.ok) { const reason = (r && r.reason) || 'room agent died'; await stoppedReport(phase, reason); return { ran, stopped: phase, reason } }
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

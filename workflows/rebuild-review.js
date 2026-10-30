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
const PHASES = ['Capture', 'Inventory', 'Stack', 'Rebuild', 'Parity', 'Score', 'Report']
const ADAPTER = `${ARGS.pluginRoot}/adapters`
const CHEAP = { model: 'haiku', effort: 'low' }

// Scripts cannot read the filesystem, so an agent lists the finished phases.
const listed = await agent(
  `List the files ending in .done directly inside ${runDir} (use ls). Return their file names. Change nothing.`,
  { ...CHEAP, label: 'resume', schema: { type: 'object', required: ['done'], properties: { done: { type: 'array', items: { type: 'string' } } } } },
)
const done = new Set((listed && listed.done) || [])

const ran = []
for (const phase of PHASES) {
  if (done.has(`${phase}.done`)) continue
  if (phase === 'Capture') {
    await agent(
      `Capture the running app of ${target}. Never run or write to ${target} itself.
1. Clone it: git clone ${target} ${runDir}/work
2. Work out from the files in ${runDir}/work how to install, build and start the app and which address it listens on, then write ${runDir}/run.json: {"platform": "web", "dir": "<folder inside work>", "install": "...", "build": "...", "start": "...", "address": "http://127.0.0.1:<port>"}. The start command must read the port from the PORT environment variable or use the port in the address. Only web apps on localhost are supported.
3. If the project is not a web app (no adapter for its platform), do not guess: write nothing else and reply with exactly "No capture adapter for platform <platform>", then stop.
4. Otherwise run: node ${ADAPTER}/web/capture.mjs --app ${runDir}/run.json --out ${runDir}/golden
5. When ${runDir}/golden/manifest.json exists, write ${runDir}/Capture.done containing the word done.`,
      { model: 'sonnet', effort: 'low', label: 'Capture', phase },
    )
    ran.push(phase)
    continue
  }
  await agent(
    `Stub for the ${phase} phase. Write a file at ${runDir}/${phase}.done containing the word done. Touch nothing else. The target ${target} must not be modified.`,
    { ...CHEAP, label: phase, phase },
  )
  ran.push(phase)
}
return { runDir, skipped: PHASES.filter(p => !ran.includes(p)), ran }

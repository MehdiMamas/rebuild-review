export const meta = {
  name: 'rebuild-review-run',
  description: 'Rebuild a project from its behaviour and rendered output, then score the rebuild. Stub phases for now.',
  whenToUse: 'Started by the rebuild-review skill. Requires args {target, runDir}.',
  phases: [
    { title: 'Capture' }, { title: 'Inventory' }, { title: 'Stack' }, { title: 'Rebuild' },
    { title: 'Parity' }, { title: 'Score' }, { title: 'Report' },
  ],
}

const ARGS = typeof args === 'string' ? (() => { try { return JSON.parse(args) } catch (e) { return args } })() : args
if (!ARGS || !ARGS.target || !ARGS.runDir) {
  throw new Error('rebuild-review workflow requires args: {target, runDir}')
}
const { target, runDir } = ARGS
const PHASES = ['Capture', 'Inventory', 'Stack', 'Rebuild', 'Parity', 'Score', 'Report']
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
  await agent(
    `Stub for the ${phase} phase. Write a file at ${runDir}/${phase}.done containing the word done. Touch nothing else. The target ${target} must not be modified.`,
    { ...CHEAP, label: phase, phase },
  )
  ran.push(phase)
}
return { runDir, skipped: PHASES.filter(p => !ran.includes(p)), ran }

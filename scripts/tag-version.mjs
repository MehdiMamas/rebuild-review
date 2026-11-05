// Fails when .claude-plugin/plugin.json's version is not the tag without its "v" (#109).
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export function tagProblem(tag, version) {
  if (!/^v\d+\.\d+\.\d+/.test(tag || '')) return `"${tag}" is not a version tag like v1.2.3`
  return tag.slice(1) === version ? null : `tag ${tag} but .claude-plugin/plugin.json says ${version}: tag the commit that bumps the version`
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
  const { version } = JSON.parse(fs.readFileSync(path.join(root, '.claude-plugin/plugin.json'), 'utf8'))
  const why = tagProblem(process.argv[2], version)
  if (why) { console.error(why); process.exit(1) }
  console.log(`tag ${process.argv[2]} matches plugin.json`)
}

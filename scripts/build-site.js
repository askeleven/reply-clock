import { cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { SECTION_CSS } from '../src/html.js'

/**
 * Assembles the web page into _site/: the page, and the part of the library it runs.
 * The page imports the same src/ the CLI uses, so the two never disagree.
 */
const root = fileURLToPath(new URL('..', import.meta.url))
const out = `${root}_site`

rmSync(out, { recursive: true, force: true })
mkdirSync(`${out}/src`, { recursive: true })
for (const file of ['index.html', 'app.js']) cpSync(`${root}site/${file}`, `${out}/${file}`)
writeFileSync(`${out}/sections.css`, SECTION_CSS.trimStart())
for (const file of ['analyze.js', 'card.js', 'format.js', 'headers.js', 'html.js', 'mbox.js', 'message.js']) {
  cpSync(`${root}src/${file}`, `${out}/src/${file}`)
}
process.stdout.write(`Built ${out}\n`)

import { createReadStream } from 'node:fs'
import { readFile, readdir, stat } from 'node:fs/promises'
import { join, basename, extname } from 'node:path'
import { mboxHeaders, emlHeaders } from './mbox.js'
import { parseHeaders } from './headers.js'
import { toMessage } from './message.js'

/**
 * Messages from mail exports on disk: mbox files (Google Takeout, Thunderbird, Apple Mail's
 * .mbox folders) and .eml files, or folders of them. Only headers are read.
 *
 * @typedef {import('./message.js').Message} Message
 *
 * @param {string[]} paths
 * @param {{ onFile?: (path: string, messages: number) => void }} [options]
 * @returns {Promise<Message[]>}
 */
export async function readMessages(paths, options = {}) {
  /** @type {Message[]} */
  const out = []
  for (const file of await expand(paths)) {
    const before = out.length
    if (extname(file).toLowerCase() === '.eml') {
      out.push(toMessage(parseHeaders(emlHeaders(await readFile(file, 'utf8')))))
    } else {
      const stream = createReadStream(file, { encoding: 'utf8', highWaterMark: 1 << 20 })
      for await (const block of mboxHeaders(/** @type {AsyncIterable<string>} */ (stream))) out.push(toMessage(parseHeaders(block)))
    }
    options.onFile?.(file, out.length - before)
  }
  return out
}

/**
 * Files to read: each file given, and inside folders every .eml, .mbox, .mbx and file
 * named mbox.
 *
 * @param {string[]} paths
 * @returns {Promise<string[]>}
 */
async function expand(paths) {
  /** @type {string[]} */
  const files = []
  /** @param {string} dir */
  const walk = async (dir) => {
    for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = join(dir, entry.name)
      if (entry.isDirectory()) await walk(p)
      else if (entry.isFile() && (/\.(?:eml|mbox|mbx)$/i.test(entry.name) || basename(p) === 'mbox')) files.push(p)
    }
  }
  for (const p of paths) {
    if ((await stat(p)).isDirectory()) await walk(p)
    else files.push(p)
  }
  return files
}

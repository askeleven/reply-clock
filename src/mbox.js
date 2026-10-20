/**
 * Reads the header section of each message in an mbox, streaming, so a mailbox of
 * several gigabytes never has to fit in memory. Bodies are skipped as they go past.
 *
 * Runs in Node and in the browser: it takes text chunks from any source.
 */

/**
 * @param {AsyncIterable<string> | Iterable<string>} chunks The mbox as text, in pieces of any size.
 * @returns {AsyncGenerator<string>} Each message's header block.
 */
export async function* mboxHeaders(chunks) {
  let pending = ''
  /** 'between' before the first message; 'head' in headers; 'body' in a body. */
  let state = /** @type {'between'|'head'|'body'} */ ('between')
  /** @type {string[]} */
  let head = []
  let previousBlank = true

  /**
   * @param {string} line
   * @returns {string | null} A finished header block, if this line ended one.
   */
  const take = (line) => {
    const isSeparator = line.startsWith('From ') && previousBlank && /^From \S+/.test(line)
    previousBlank = line === '' || line === '\r'
    if (isSeparator) {
      const done = state === 'head' && head.length ? head.join('\n') : null
      state = 'head'
      head = []
      return done
    }
    if (state === 'head') {
      if (line === '' || line === '\r') {
        state = 'body'
        const done = head.join('\n')
        head = []
        return done
      }
      head.push(line.endsWith('\r') ? line.slice(0, -1) : line)
    }
    return null
  }

  for await (const chunk of chunks) {
    pending += chunk
    let start = 0
    let at
    while ((at = pending.indexOf('\n', start)) >= 0) {
      const done = take(pending.slice(start, at))
      start = at + 1
      if (done) yield done
    }
    pending = pending.slice(start)
  }
  if (pending) {
    const done = take(pending)
    if (done) yield done
  }
  if (state === 'head' && head.length) yield head.join('\n')
}

/**
 * The header block of one .eml file.
 *
 * @param {string} text
 * @returns {string}
 */
export function emlHeaders(text) {
  const normalized = text.replace(/\r\n/g, '\n')
  const end = normalized.indexOf('\n\n')
  return end < 0 ? normalized : normalized.slice(0, end)
}

/**
 * Email headers, and nothing else. reply-clock never reads a message body: who wrote to
 * whom, when, and in reply to what is all a response time needs.
 *
 * Runs in Node and in the browser: no Node imports.
 */

/**
 * Header names to values, lower case names. A repeated header keeps its first value,
 * except Received, which is not needed.
 *
 * @param {string} block The header section, lines separated by \n or \r\n.
 * @returns {Record<string, string>}
 */
export function parseHeaders(block) {
  /** @type {Record<string, string>} */
  const headers = {}
  /** The header a continuation line belongs to; null for a repeat, which is skipped. */
  let current = /** @type {string | null} */ (null)
  for (const line of block.replace(/\r\n/g, '\n').split('\n')) {
    if (/^[ \t]/.test(line)) {
      if (current) headers[current] += ` ${line.trim()}`
      continue
    }
    const m = /^([!-9;-~]+):[ \t]*(.*)$/.exec(line)
    if (!m) {
      current = null
      continue
    }
    const name = m[1].toLowerCase()
    if (name in headers) {
      current = null
    } else {
      headers[name] = m[2]
      current = name
    }
  }
  return headers
}

/**
 * Every address in an address-list header (To, Cc, From), lower case. Display names,
 * including quoted ones with commas in them, are skipped.
 *
 * @param {string | undefined} value
 * @returns {string[]}
 */
export function addresses(value) {
  if (!value) return []
  const out = []
  // Quoted display names can hold commas and @ signs; drop them first.
  const unquoted = value.replace(/"(?:[^"\\]|\\.)*"/g, '""')
  for (const m of unquoted.matchAll(/<([^<>\s]+@[^<>\s]+)>|([^\s"<>,;:()]+@[^\s"<>,;:()]+)/g)) {
    out.push((m[1] ?? m[2]).toLowerCase().replace(/\.$/, ''))
  }
  return out
}

/**
 * Message ids in a Message-ID, In-Reply-To or References header, without angle brackets.
 *
 * @param {string | undefined} value
 * @returns {string[]}
 */
export function messageIds(value) {
  if (!value) return []
  const ids = [...value.matchAll(/<([^<>\s]+)>/g)].map((m) => m[1])
  if (ids.length) return ids
  const bare = value.trim()
  return bare && !/\s/.test(bare) ? [bare] : []
}

/**
 * Decodes RFC 2047 encoded words, such as =?UTF-8?Q?R=C3=A9ponse?=, for display.
 *
 * @param {string} value
 * @returns {string}
 */
export function decodeWords(value) {
  return value
    .replace(/(\?=)\s+(=\?)/g, '$1$2')
    .replace(/=\?([^?]+)\?([BQbq])\?([^?]*)\?=/g, (whole, charset, kind, text) => {
      try {
        /** @type {Uint8Array} */
        let bytes
        if (kind.toUpperCase() === 'B') {
          const bin = atob(text)
          bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0))
        } else {
          const raw = text.replace(/_/g, ' ')
          const out = []
          for (let i = 0; i < raw.length; i++) {
            if (raw[i] === '=' && /^[0-9A-Fa-f]{2}$/.test(raw.slice(i + 1, i + 3))) {
              out.push(parseInt(raw.slice(i + 1, i + 3), 16))
              i += 2
            } else {
              out.push(raw.charCodeAt(i) & 0xff)
            }
          }
          bytes = Uint8Array.from(out)
        }
        return new TextDecoder(charset.split('*')[0].toLowerCase(), { fatal: false }).decode(bytes)
      } catch {
        return whole
      }
    })
}

/**
 * A Date header to milliseconds, or null when it cannot be read.
 *
 * @param {string | undefined} value
 * @returns {number | null}
 */
export function parseDate(value) {
  if (!value) return null
  // Drop comments such as "(UTC)" and "(PDT)", which some engines refuse.
  const cleaned = value.replace(/\([^)]*\)/g, '').replace(/\s+/g, ' ').trim()
  const t = Date.parse(cleaned)
  return Number.isFinite(t) ? t : null
}

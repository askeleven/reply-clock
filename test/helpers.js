/**
 * Builds mail for tests: header blocks, and mbox text made of them.
 *
 * @typedef {object} Spec
 * @property {string} from
 * @property {string} [to]
 * @property {string} at ISO time.
 * @property {string} [id]
 * @property {string} [inReplyTo]
 * @property {string} [subject]
 * @property {Record<string, string>} [extra] More headers.
 */

/**
 * @param {Spec} s
 * @returns {string}
 */
export function headers(s) {
  const lines = [
    `From: ${s.from}`,
    `To: ${s.to ?? 'sam@acme.test'}`,
    `Date: ${new Date(s.at).toUTCString()}`,
    `Subject: ${s.subject ?? 'Quote for a kitchen'}`,
  ]
  if (s.id) lines.push(`Message-ID: <${s.id}>`)
  if (s.inReplyTo) lines.push(`In-Reply-To: <${s.inReplyTo}>`, `References: <${s.inReplyTo}>`)
  for (const [k, v] of Object.entries(s.extra ?? {})) lines.push(`${k}: ${v}`)
  return lines.join('\n')
}

/**
 * @param {Spec[]} specs
 * @returns {string}
 */
export function mbox(specs) {
  return specs.map((s) => `From - ${new Date(s.at).toUTCString()}\n${headers(s)}\n\nHello.\nFrom here on, a body line.\n\n`).join('')
}

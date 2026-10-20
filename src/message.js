import { addresses, messageIds, decodeWords, parseDate } from './headers.js'

/**
 * @typedef {object} Message
 * @property {string | null} id Message-ID.
 * @property {string[]} parents In-Reply-To and References, nearest first.
 * @property {string | null} thread A provider's thread id, such as Gmail's X-GM-THRID.
 * @property {string | null} from
 * @property {string} fromName
 * @property {string[]} to To and Cc.
 * @property {number | null} at
 * @property {string} subject
 * @property {string[]} labels Gmail labels, or the IMAP folder it came from.
 * @property {string | null} automated Why it was sent by software, or null for a person.
 * @property {boolean} viaForm Sent by a form or app on someone's behalf, with Reply-To set to
 *   them: a contact form, a booking page. They are the sender, and they are waiting.
 */

/**
 * @param {Record<string, string>} h Parsed headers.
 * @param {{ labels?: string[] }} [extra]
 * @returns {Message}
 */
export function toMessage(h, extra = {}) {
  const sender = addresses(h.from)[0] ?? null
  let automated = automatedReason(h, sender)
  let from = sender
  let viaForm = false
  // A contact form mails you from no-reply@ with the person in Reply-To. That is a lead.
  const replyTo = addresses(h['reply-to'])[0]
  if (automated === 'no-reply' && replyTo && replyTo !== sender && !h['list-id'] && !automatedReason({}, replyTo)) {
    from = replyTo
    automated = null
    viaForm = true
  }
  const labels = [...(extra.labels ?? []), ...splitLabels(h['x-gmail-labels'])]
  // A Google Takeout export includes the Spam folder. Nobody is waiting on spam.
  if (labels.some((l) => /^spam$/i.test(l))) automated = 'spam'
  return {
    id: messageIds(h['message-id'])[0] ?? null,
    parents: [...messageIds(h['in-reply-to']), ...messageIds(h.references).reverse()],
    thread: h['x-gm-thrid']?.trim() || null,
    from,
    fromName: decodeWords((h.from ?? '').replace(/<[^>]*>/, '').replace(/"/g, '').trim()),
    to: [...addresses(h.to), ...addresses(h.cc)],
    at: parseDate(h.date),
    subject: decodeWords(h.subject ?? ''),
    labels,
    automated,
    viaForm,
  }
}

/**
 * Why a message was sent by software rather than written by a person, or null. Headers
 * that only software sets decide it: nobody is waiting for a reply to these.
 *
 * @param {Record<string, string>} h
 * @param {string | null} from
 * @returns {string | null}
 */
export function automatedReason(h, from) {
  const auto = (h['auto-submitted'] ?? '').trim().toLowerCase()
  if (auto && auto !== 'no') return 'auto-submitted'
  if (h['x-autoreply'] || h['x-autorespond']) return 'autoreply'
  if (h['list-id'] || h['list-unsubscribe'] || h['list-post']) return 'list'
  if (/^\s*(?:bulk|list|junk|auto_reply)\s*$/i.test(h.precedence ?? '')) return 'bulk'
  if (h['feedback-id'] || h['x-campaign-id']) return 'bulk'
  if (/^\s*<>\s*$/.test(h['return-path'] ?? '')) return 'bounce'
  if (from) {
    const local = from.split('@')[0]
    if (/(?:^|[-_.+])(?:no[-_.]?reply|do[-_.]?not[-_.]?reply)(?:$|[-_.+])/i.test(local)) return 'no-reply'
    if (/^(?:mailer-daemon|postmaster|mail-daemon)$/i.test(local)) return 'bounce'
    if (/^(?:no[-_.]?reply|do[-_.]?not[-_.]?reply|dont[-_.]?reply|notifications?|notify|alerts?|bounces?|mailer|updates?|news(?:letter)?|digest|calendar-notification)(?:[-_.+].*)?$/i.test(local)) {
      return 'no-reply'
    }
  }
  return null
}

/**
 * @param {string | undefined} value
 * @returns {string[]}
 */
function splitLabels(value) {
  if (!value) return []
  return decodeWords(value)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

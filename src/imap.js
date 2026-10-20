import { connect as tlsConnect } from 'node:tls'
import { connect as netConnect } from 'node:net'

/**
 * Reads message headers straight from a mailbox over IMAP, with an app password. Nothing
 * is changed on the server: mailboxes are opened read-only (EXAMINE) and headers are
 * fetched with BODY.PEEK, which leaves messages unread. Bodies are never downloaded.
 *
 * @typedef {object} ImapOptions
 * @property {string} host Such as imap.gmail.com or imap.fastmail.com.
 * @property {number} [port] Default 993.
 * @property {string} user Usually your email address.
 * @property {string} password An app password. Read it from the environment, never a flag.
 * @property {number} since Fetch mail from this day on, in ms.
 * @property {string[]} [mailboxes] Default the All Mail folder if there is one, else
 *   INBOX, plus the Sent folder.
 * @property {boolean} [tls] Default true. Plain text is allowed only to this machine, for
 *   a mail bridge running locally.
 * @property {number} [timeout] Idle timeout in ms. Default 60000.
 * @property {(progress: { mailbox: string, done: number, total: number }) => void} [onProgress]
 *
 * @typedef {object} FetchedHeaders
 * @property {string} headers The header block.
 * @property {string[]} labels The mailbox it came from; 'Sent' for the Sent folder.
 */

/** Only the headers reply-clock reads. */
export const HEADER_FIELDS = [
  'FROM', 'TO', 'CC', 'DATE', 'SUBJECT', 'MESSAGE-ID', 'IN-REPLY-TO', 'REFERENCES', 'REPLY-TO',
  'LIST-ID', 'LIST-UNSUBSCRIBE', 'LIST-POST', 'PRECEDENCE', 'AUTO-SUBMITTED', 'X-AUTOREPLY',
  'X-AUTORESPOND', 'RETURN-PATH', 'FEEDBACK-ID', 'X-CAMPAIGN-ID',
]

const BATCH = 250
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

export class ImapError extends Error {}

/**
 * @param {ImapOptions} options
 * @returns {AsyncGenerator<FetchedHeaders>}
 */
export async function* imapHeaders(options) {
  const { host, user, password, since } = options
  const secure = options.tls ?? true
  if (!secure && !isLocalHost(host)) throw new ImapError(`Refusing to send a password in plain text to ${host}. Plain text is only for a bridge on this machine.`)
  if (!user || !password) throw new ImapError('A user and an app password are needed.')
  for (const v of [user, password]) {
    if (/[\r\n\0]/.test(v) || /[^\x20-\x7e]/.test(v)) throw new ImapError('The user and password must be printable ASCII. App passwords always are.')
  }
  const port = options.port ?? 993
  const socket = secure ? tlsConnect({ host, port, servername: host }) : netConnect({ host, port })
  const io = reader(socket, options.timeout ?? 60_000)
  try {
    const greeting = await io.response()
    if (!/^\* (?:OK|PREAUTH)\b/i.test(greeting.text)) throw new ImapError(`The server did not greet: ${greeting.text}`)

    let tag = 0
    /**
     * @param {string} command
     * @param {(r: Response) => void} [untagged]
     */
    const run = async (command, untagged) => {
      const t = `a${++tag}`
      socket.write(`${t} ${command}\r\n`)
      for (;;) {
        const r = await io.response()
        if (r.text.startsWith(`${t} `)) {
          const status = r.text.slice(t.length + 1)
          // Name the command, never its arguments: LOGIN's include the password.
          if (!/^OK\b/i.test(status)) throw new ImapError(`${command.split(' ')[0]} failed: ${status}`)
          return
        }
        if (r.text.startsWith('* ')) untagged?.(r)
      }
    }

    await run(`LOGIN ${quote(user)} ${quote(password)}`)
    /** @type {string[]} */
    let capabilities = []
    await run('CAPABILITY', (r) => {
      if (/^\* CAPABILITY /i.test(r.text)) capabilities = r.text.slice(13).toUpperCase().split(/\s+/)
    })
    const gmail = capabilities.includes('X-GM-EXT-1')

    const boxes = options.mailboxes?.length ? options.mailboxes.map((name) => ({ name, label: name })) : await chooseMailboxes(run)
    const items = `(UID${gmail ? ' X-GM-THRID' : ''} BODY.PEEK[HEADER.FIELDS (${HEADER_FIELDS.join(' ')})])`

    for (const box of boxes) {
      await run(`EXAMINE ${quote(box.name)}`)
      /** @type {string[]} */
      const uids = []
      await run(`UID SEARCH SINCE ${imapDate(since)}`, (r) => {
        if (/^\* SEARCH\b/i.test(r.text)) uids.push(...r.text.slice(8).trim().split(/\s+/).filter(Boolean))
      })
      for (let i = 0; i < uids.length; i += BATCH) {
        /** @type {FetchedHeaders[]} */
        const batch = []
        await run(`UID FETCH ${uids.slice(i, i + BATCH).join(',')} ${items}`, (r) => {
          if (!/^\* \d+ FETCH /i.test(r.text)) return
          const headers = fetchedHeaders(r)
          if (headers === null) return
          const thread = /X-GM-THRID (\d+)/i.exec(r.text)?.[1]
          batch.push({ headers: thread ? `X-GM-THRID: ${thread}\n${headers}` : headers, labels: [box.label] })
        })
        yield* batch
        options.onProgress?.({ mailbox: box.name, done: Math.min(i + BATCH, uids.length), total: uids.length })
      }
      if (uids.length === 0) options.onProgress?.({ mailbox: box.name, done: 0, total: 0 })
    }
    await run('LOGOUT').catch(() => {})
  } finally {
    socket.destroy()
  }
}

/**
 * All Mail where the server has one (Gmail): it holds archived mail, which INBOX does not.
 * Otherwise INBOX. Plus the Sent folder, which is where your replies are.
 *
 * @param {(command: string, untagged?: (r: Response) => void) => Promise<void>} run
 * @returns {Promise<{ name: string, label: string }[]>}
 */
async function chooseMailboxes(run) {
  /** @type {{ name: string, flags: string[] }[]} */
  const list = []
  await run('LIST "" "*"', (r) => {
    const m = /^\* LIST \(([^)]*)\) (?:"(?:[^"\\]|\\.)*"|NIL) (.*)$/i.exec(r.text)
    if (m) list.push({ name: mailboxName(m[2], r.literals), flags: m[1].toLowerCase().split(/\s+/) })
  })
  const all = list.find((b) => b.flags.includes('\\all'))
  const sent =
    list.find((b) => b.flags.includes('\\sent')) ??
    list.find((b) => /^(?:sent|sent items|sent messages|sent mail|inbox[./]sent)$/i.test(b.name))
  if (!sent) throw new ImapError('No Sent folder found. Name the folders with --mailbox, the Sent folder included.')
  const first = all ?? list.find((b) => b.name.toUpperCase() === 'INBOX') ?? { name: 'INBOX' }
  return [
    { name: first.name, label: first.name },
    { name: sent.name, label: 'Sent' },
  ]
}

/**
 * @typedef {object} Response
 * @property {string} text The response, with each literal replaced by \0index\0.
 * @property {string[]} literals
 */

/**
 * Reads IMAP responses: lines, and the counted literals that header blocks arrive in.
 *
 * @param {import('node:net').Socket} socket
 * @param {number} timeout
 */
function reader(socket, timeout) {
  /** @type {Buffer[]} */
  let chunks = []
  let size = 0
  let ended = false
  /** @type {Error | null} */
  let failed = null
  /** @type {(() => void) | null} */
  let wake = null
  const notify = () => {
    const w = wake
    wake = null
    w?.()
  }
  socket.setTimeout(timeout, () => socket.destroy(new ImapError(`No answer from the server in ${Math.round(timeout / 1000)}s.`)))
  socket.on('data', (d) => {
    chunks.push(d)
    size += d.length
    notify()
  })
  socket.on('error', (e) => {
    failed = e
    notify()
  })
  socket.on('close', () => {
    ended = true
    notify()
  })
  const more = () => {
    if (failed) throw failed
    if (ended) throw new ImapError('The server closed the connection.')
    return new Promise((resolve) => (wake = () => resolve(undefined)))
  }
  const joined = () => {
    if (chunks.length > 1) chunks = [Buffer.concat(chunks, size)]
    return chunks[0] ?? Buffer.alloc(0)
  }
  /** @param {number} n */
  const take = (n) => {
    const buf = joined()
    const out = buf.subarray(0, n)
    chunks = buf.length > n ? [buf.subarray(n)] : []
    size -= n
    return out
  }
  const line = async () => {
    for (;;) {
      const i = joined().indexOf('\r\n')
      if (i >= 0) {
        const out = take(i + 2)
        return out.subarray(0, i).toString('utf8')
      }
      await more()
    }
  }
  /** @param {number} n */
  const bytes = async (n) => {
    while (size < n) await more()
    return take(n).toString('utf8')
  }
  return {
    /** @returns {Promise<Response>} */
    async response() {
      let text = ''
      /** @type {string[]} */
      const literals = []
      for (;;) {
        const l = await line()
        const m = /\{(\d+)\+?\}$/.exec(l)
        if (!m) return { text: text + l, literals }
        text += `${l.slice(0, m.index)}\0${literals.length}\0`
        literals.push(await bytes(Number(m[1])))
      }
    },
  }
}

/**
 * The header block in a FETCH response: a literal, or now and then a quoted string.
 *
 * @param {Response} r
 * @returns {string | null}
 */
function fetchedHeaders(r) {
  const m = /BODY\[HEADER\.FIELDS \([^)]*\)\] (?:\0(\d+)\0|"((?:[^"\\]|\\.)*)")/i.exec(r.text)
  if (!m) return null
  const raw = m[1] !== undefined ? r.literals[Number(m[1])] : m[2].replace(/\\(.)/g, '$1')
  return raw.replace(/\r\n/g, '\n').trimEnd()
}

/**
 * @param {string} raw
 * @param {string[]} literals
 * @returns {string}
 */
function mailboxName(raw, literals) {
  const literal = /^\0(\d+)\0$/.exec(raw)
  if (literal) return literals[Number(literal[1])]
  if (raw.startsWith('"')) return raw.slice(1, -1).replace(/\\(.)/g, '$1')
  return raw
}

/**
 * @param {string} s
 * @returns {string}
 */
function quote(s) {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

/**
 * @param {number} ms
 * @returns {string} Such as 17-Jul-2026.
 */
export function imapDate(ms) {
  const d = new Date(ms)
  return `${d.getUTCDate()}-${MONTHS[d.getUTCMonth()]}-${d.getUTCFullYear()}`
}

/**
 * @param {string} host
 * @returns {boolean}
 */
function isLocalHost(host) {
  return host === 'localhost' || host === '::1' || /^127\.\d+\.\d+\.\d+$/.test(host)
}

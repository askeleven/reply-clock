#!/usr/bin/env node
import { parseArgs } from 'node:util'
import { writeFile } from 'node:fs/promises'
import { analyze, toMessage, parseHeaders, readMessages, imapHeaders, ImapError, renderCard, renderHtml, formatText, parseHours } from '../src/index.js'
import { VERSION } from '../src/version.js'
import { starHint } from './star-hint.js'

const USAGE = `
reply-clock <mail export...> [options]
reply-clock imap --host <server> --user <address> [options]

  How long do people wait for your reply? Reads the headers of your mail, never
  the bodies, and grades your first reply times: the median, the share answered,
  after hours, and for new contacts. Nothing leaves your machine.

  A mail export is an mbox file (Google Takeout, Thunderbird, Apple Mail), an
  .eml file, or a folder of them. Include your sent mail: replies are in it.

Options
  --me <address>        Your address. Repeatable. Default: found from the Sent
                        folder or label, else the address most mail is sent to.
  --domain <domain>     Your business's domain: a reply from anyone at it counts.
                        Repeatable.
  --tz <zone>           Your time zone, such as America/Chicago. Default this
                        machine's.
  --hours <hours>       Your open hours. Default "Mon-Fri 9-17".
  --since <when>        Start of the period: a date (2026-07-01) or a span before
                        the end (90d, 12w). Default 90d.
  --until <date>        End of the period. Default the newest message, or now
                        for imap.
  --card <file.svg>     Write the report card: totals only, made to share.
  --html <file.html>    Write the full report, with who is still waiting.
  --business <name>     A name for the top of the card.
  --list <n>            How many people still waiting to list. Default 10.
  --json                The whole report as JSON.
  --no-colour           Plain text.
  --version, --help

imap
  Reads straight from your mailbox, read-only: nothing is marked read, moved or
  deleted. Use an app password, in the environment, never on the command line:
    REPLY_CLOCK_PASSWORD   the app password
  --host <server>       imap.gmail.com, imap.fastmail.com, imap.mail.me.com...
  --port <n>            Default 993.
  --user <address>      Default the first --me.
  --mailbox <name>      Folders to read. Repeatable. Default All Mail if the
                        server has one, else INBOX, plus Sent.
  --no-tls              Plain text, only to a bridge on this machine.

Exit codes
  0  report written.
  2  could not run.

Examples
  npx @askeleven/reply-clock "All mail Including Spam and Trash.mbox" --card card.svg
  npx @askeleven/reply-clock ~/Mail/export --me sam@acme.com --hours "Mon-Sat 8-18"
  REPLY_CLOCK_PASSWORD=... npx @askeleven/reply-clock imap --host imap.gmail.com --user sam@acme.com
`

const DAY_MS = 86_400_000
/** How far before the period imap reads, so new contacts and old threads are known. */
const LOOKBACK_MS = 60 * DAY_MS

/**
 * @param {string[]} argv
 * @returns {Promise<number>}
 */
async function main(argv) {
  let parsed
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        me: { type: 'string', multiple: true },
        domain: { type: 'string', multiple: true },
        tz: { type: 'string' },
        hours: { type: 'string' },
        since: { type: 'string' },
        until: { type: 'string' },
        card: { type: 'string' },
        html: { type: 'string' },
        business: { type: 'string' },
        list: { type: 'string' },
        host: { type: 'string' },
        port: { type: 'string' },
        user: { type: 'string' },
        mailbox: { type: 'string', multiple: true },
        'no-tls': { type: 'boolean', default: false },
        json: { type: 'boolean', default: false },
        // parseArgs has no --no-x negation, so both spellings are declared explicitly.
        'no-colour': { type: 'boolean', default: false },
        'no-color': { type: 'boolean', default: false },
        version: { type: 'boolean', default: false },
        help: { type: 'boolean', default: false },
      },
    })
  } catch (error) {
    process.stderr.write(`${/** @type {Error} */ (error).message}\n${USAGE}`)
    return 2
  }
  const { values, positionals } = parsed
  if (values.help) {
    process.stdout.write(USAGE)
    return 0
  }
  if (values.version) {
    process.stdout.write(`${VERSION}\n`)
    return 0
  }
  if (positionals.length === 0) {
    process.stderr.write(USAGE)
    return 2
  }

  try {
    const timeZone = values.tz ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'UTC'
    try {
      new Intl.DateTimeFormat('en-US', { timeZone })
    } catch {
      throw new UsageError(`Unknown time zone: ${timeZone}. Use a name such as America/New_York.`)
    }
    const hours = parseHours(values.hours ?? 'Mon-Fri 9-17')
    if (!hours) throw new UsageError(`Could not read --hours "${values.hours}". Write it like "Mon-Fri 9-17" or "Mon-Sat 8:30-18".`)
    const list = values.list === undefined ? 10 : Number(values.list)
    if (!Number.isInteger(list) || list < 0) throw new UsageError('--list takes a whole number.')
    const untilArg = values.until === undefined ? undefined : parseDay(values.until, '--until') + DAY_MS - 1
    const isImap = positionals[0] === 'imap' && positionals.length === 1

    /** @type {import('../src/message.js').Message[]} */
    let messages
    let until = untilArg
    if (isImap) {
      until ??= Date.now()
      messages = await fromImap(values, sinceOf(values.since, until) - LOOKBACK_MS)
    } else {
      messages = await readMessages(positionals, {
        onFile: (file, n) => progress(`${file}: ${n} messages\n`),
      })
      if (until === undefined) until = messages.reduce((t, m) => (m.at !== null && m.at > t ? m.at : t), 0)
    }
    if (messages.length === 0) throw new UsageError('No messages found. Check the path, or for imap the folders.')

    const report = analyze(messages, {
      me: values.me,
      domains: values.domain,
      timeZone,
      hours,
      until,
      since: sinceOf(values.since, until),
    })
    if (report.me.length === 0) throw new UsageError('Could not tell which address is yours. Give it with --me.')

    if (values.card) await writeFile(values.card, renderCard(report, { business: values.business }))
    if (values.html) await writeFile(values.html, renderHtml(report, { business: values.business, list: Math.max(list, 50) }))
    if (values.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
    else {
      process.stdout.write(formatText(report, { colour: useColour(values), list }))
      for (const [file, what] of [[values.card, 'Card'], [values.html, 'Full report']]) {
        if (file) process.stdout.write(`\n${what} written to ${file}`)
      }
      if (values.card || values.html) process.stdout.write('\n')
    }
    return 0
  } catch (error) {
    if (error instanceof UsageError || error instanceof ImapError) {
      process.stderr.write(`${error.message}\n`)
      return 2
    }
    const code = /** @type {{ code?: string }} */ (error).code
    if (code === 'ENOENT' || code === 'EACCES' || code === 'ENOTFOUND' || code === 'ECONNREFUSED') {
      process.stderr.write(`${/** @type {Error} */ (error).message}\n`)
      return 2
    }
    throw error
  }
}

/**
 * @param {Record<string, any>} values
 * @param {number} since
 */
async function fromImap(values, since) {
  if (!values.host) throw new UsageError('imap needs --host, such as imap.gmail.com.')
  const user = values.user ?? values.me?.[0]
  if (!user) throw new UsageError('imap needs --user, your login address.')
  const password = process.env.REPLY_CLOCK_PASSWORD
  if (!password) throw new UsageError('Set REPLY_CLOCK_PASSWORD to an app password for this mailbox. It is never taken on the command line.')
  const port = values.port === undefined ? undefined : Number(values.port)
  if (port !== undefined && !(Number.isInteger(port) && port > 0 && port < 65536)) throw new UsageError('--port takes a port number.')
  /** @type {import('../src/message.js').Message[]} */
  const messages = []
  for await (const fetched of imapHeaders({
    host: values.host,
    port,
    user,
    password,
    since,
    mailboxes: values.mailbox,
    tls: !values['no-tls'],
    onProgress: ({ mailbox, done, total }) => progress(`\r${mailbox}: ${done} of ${total}${done === total ? '\n' : ''}`),
  })) {
    messages.push(toMessage(parseHeaders(fetched.headers), { labels: fetched.labels }))
  }
  return messages
}

/**
 * @param {string | undefined} value A date, or a span such as 90d or 12w.
 * @param {number} until
 * @returns {number}
 */
function sinceOf(value, until) {
  const span = /^(\d+)\s*([dw])$/i.exec(value ?? '90d')
  if (span) return until - Number(span[1]) * (span[2].toLowerCase() === 'w' ? 7 : 1) * DAY_MS
  return parseDay(/** @type {string} */ (value), '--since')
}

/**
 * @param {string} value
 * @param {string} flag
 * @returns {number}
 */
function parseDay(value, flag) {
  const t = /^\d{4}-\d{2}-\d{2}$/.test(value) ? Date.parse(`${value}T00:00:00Z`) : NaN
  if (!Number.isFinite(t)) throw new UsageError(`Could not read ${flag} "${value}". Use a date like 2026-07-01${flag === '--since' ? ', or 90d' : ''}.`)
  return t
}

/** @param {string} text */
function progress(text) {
  if (process.stderr.isTTY) process.stderr.write(text)
}

class UsageError extends Error {}

/**
 * @param {Record<string, any>} values
 * @returns {boolean}
 */
function useColour(values) {
  if (values['no-colour'] || values['no-color']) return false
  if (process.env.NO_COLOR) return false
  return process.stdout.isTTY === true
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code
    starHint('reply-clock', code, process.argv.slice(2))
  },
  (error) => {
    process.stderr.write(`${error?.stack ?? error}\n`)
    process.exitCode = 2
  },
)

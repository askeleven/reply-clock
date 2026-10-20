import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:net'
import { imapHeaders, ImapError, imapDate } from '../src/imap.js'
import { analyze, toMessage, parseHeaders } from '../src/index.js'
import { headers } from './helpers.js'

/**
 * A fake IMAP server with Gmail's folders, on this machine. It records every command.
 *
 * @param {{ password?: string, gmail?: boolean }} [options]
 */
async function fakeServer({ password = 'app-pass-1234', gmail = true } = {}) {
  /** @type {Record<string, Map<string, string>>} */
  const boxes = {
    '[Gmail]/All Mail': new Map([
      ['11', headers({ from: 'Dana <dana@example.com>', at: '2026-10-05T10:00:00Z', id: 'g1@x' })],
      ['12', headers({ from: 'sam@acme.test', to: 'dana@example.com', at: '2026-10-05T10:45:00Z', id: 'g2@x', inReplyTo: 'g1@x' })],
    ]),
    '[Gmail]/Sent Mail': new Map([['7', headers({ from: 'sam@acme.test', to: 'dana@example.com', at: '2026-10-05T10:45:00Z', id: 'g2@x', inReplyTo: 'g1@x' })]]),
  }
  /** @type {string[]} */
  const commands = []
  const server = createServer((socket) => {
    let selected = ''
    let buffer = ''
    socket.write('* OK Fake IMAP ready\r\n')
    socket.on('data', (d) => {
      buffer += d.toString('utf8')
      let i
      while ((i = buffer.indexOf('\r\n')) >= 0) {
        const line = buffer.slice(0, i)
        buffer = buffer.slice(i + 2)
        commands.push(line)
        const [tag, ...rest] = line.split(' ')
        const cmd = rest.join(' ')
        const ok = () => socket.write(`${tag} OK done\r\n`)
        if (/^LOGIN /.test(cmd)) {
          if (cmd === `LOGIN "sam@acme.test" "${password}"`) ok()
          else socket.write(`${tag} NO [AUTHENTICATIONFAILED] Invalid credentials\r\n`)
        } else if (cmd === 'CAPABILITY') {
          socket.write(`* CAPABILITY IMAP4rev1${gmail ? ' X-GM-EXT-1' : ''}\r\n`)
          ok()
        } else if (cmd === 'LIST "" "*"') {
          socket.write('* LIST (\\HasNoChildren) "/" "INBOX"\r\n')
          socket.write('* LIST (\\All \\HasNoChildren) "/" "[Gmail]/All Mail"\r\n')
          // A name sent as a literal, which servers may do.
          const name = '[Gmail]/Sent Mail'
          socket.write(`* LIST (\\HasNoChildren \\Sent) "/" {${name.length}}\r\n${name}\r\n`)
          ok()
        } else if (/^EXAMINE "/.test(cmd)) {
          selected = cmd.slice(9, -1)
          ok()
        } else if (/^UID SEARCH SINCE /.test(cmd)) {
          socket.write(`* SEARCH ${[...(boxes[selected]?.keys() ?? [])].join(' ')}\r\n`)
          ok()
        } else if (/^UID FETCH /.test(cmd)) {
          for (const uid of cmd.split(' ')[2].split(',')) {
            const h = `${(boxes[selected].get(uid) ?? '').replace(/\n/g, '\r\n')}\r\n\r\n`
            socket.write(`* ${uid} FETCH (UID ${uid}${gmail ? ' X-GM-THRID 1789' : ''} BODY[HEADER.FIELDS (FROM TO)] {${Buffer.byteLength(h)}}\r\n${h})\r\n`)
          }
          ok()
        } else if (cmd === 'LOGOUT') {
          socket.write('* BYE\r\n')
          ok()
          socket.end()
        } else socket.write(`${tag} BAD unknown\r\n`)
      }
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)))
  const port = /** @type {import('node:net').AddressInfo} */ (server.address()).port
  return { port, commands, close: () => new Promise((resolve) => server.close(() => resolve(undefined))) }
}

const since = Date.parse('2026-07-01T00:00:00Z')

test('reads headers from All Mail and Sent, read-only, and the report adds up', async () => {
  const server = await fakeServer()
  try {
    const fetched = []
    for await (const f of imapHeaders({ host: '127.0.0.1', port: server.port, tls: false, user: 'sam@acme.test', password: 'app-pass-1234', since })) fetched.push(f)
    assert.equal(fetched.length, 3)
    assert.deepEqual(fetched.map((f) => f.labels[0]), ['[Gmail]/All Mail', '[Gmail]/All Mail', 'Sent'])
    assert.match(fetched[0].headers, /^X-GM-THRID: 1789\nFrom: Dana/)

    const cmds = server.commands.map((c) => c.replace(/^a\d+ /, ''))
    assert.ok(cmds.includes('EXAMINE "[Gmail]/All Mail"'), 'opens read-only')
    assert.ok(!cmds.some((c) => /^(?:SELECT|STORE|UID STORE|COPY|MOVE|EXPUNGE|UID EXPUNGE)\b/.test(c)), 'never changes the mailbox')
    assert.ok(cmds.filter((c) => c.startsWith('UID FETCH')).every((c) => c.includes('BODY.PEEK[HEADER.FIELDS (')), 'headers only, left unread')
    assert.ok(cmds.includes('UID SEARCH SINCE 1-Jul-2026'))

    const messages = fetched.map((f) => toMessage(parseHeaders(f.headers), { labels: f.labels }))
    const r = analyze(messages, { timeZone: 'UTC' })
    assert.deepEqual(r.me, ['sam@acme.test'], 'found from the Sent folder')
    assert.equal(r.waits.length, 1, 'the copy in Sent is the same message')
    assert.equal(r.all.median, 45 * 60_000)
  } finally {
    await server.close()
  }
})

test('a wrong password is an ImapError that does not repeat the password', async () => {
  const server = await fakeServer({ password: 'right-one' })
  try {
    await assert.rejects(
      async () => {
        for await (const _ of imapHeaders({ host: '127.0.0.1', port: server.port, tls: false, user: 'sam@acme.test', password: 'wrong-secret', since })) void _
      },
      (/** @type {Error} */ e) => e instanceof ImapError && /LOGIN failed/.test(e.message) && !e.message.includes('wrong-secret'),
    )
  } finally {
    await server.close()
  }
})

test('refuses to send a password in plain text anywhere but this machine', async () => {
  await assert.rejects(async () => {
    for await (const _ of imapHeaders({ host: 'imap.example.com', tls: false, user: 'sam@acme.test', password: 'x', since })) void _
  }, /plain text/)
  await assert.rejects(async () => {
    for await (const _ of imapHeaders({ host: '127.0.0.1', tls: false, user: 'sam@acme.test', password: 'a" LOGOUT\r\n', since })) void _
  }, /printable ASCII/)
  assert.equal(imapDate(Date.parse('2026-12-03T23:00:00Z')), '3-Dec-2026')
})

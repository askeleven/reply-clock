import { test } from 'node:test'
import assert from 'node:assert/strict'
import { analyze, grade, toMessage, parseHeaders, mboxHeaders, emlHeaders, parseHours, duration, decodeWords, addresses, renderCard, renderHtml, formatText } from '../src/index.js'
import { headers, mbox } from './helpers.js'

/** @param {import('./helpers.js').Spec[]} specs @param {string[]} [labels] */
const msgs = (specs, labels) => specs.map((s) => toMessage(parseHeaders(headers(s)), { labels }))
const ME = { me: ['sam@acme.test'], timeZone: 'UTC' }

test('a reply ends the wait; the time is from their message to your first reply', () => {
  const r = analyze(
    msgs([
      { from: 'Dana <dana@example.com>', at: '2026-10-05T10:00:00Z', id: 'a@x' },
      { from: 'dana@example.com', at: '2026-10-05T10:20:00Z', id: 'b@x', inReplyTo: 'a@x' },
      { from: 'sam@acme.test', to: 'dana@example.com', at: '2026-10-05T11:30:00Z', id: 'c@x', inReplyTo: 'b@x' },
      { from: 'sam@acme.test', to: 'dana@example.com', at: '2026-10-05T12:00:00Z', id: 'd@x', inReplyTo: 'c@x' },
    ]),
    ME,
  )
  assert.equal(r.waits.length, 1, 'a follow-up while waiting does not start a second wait')
  assert.equal(r.waits[0].ms, 90 * 60_000)
  assert.equal(r.all.median, 90 * 60_000)
  assert.equal(r.waits[0].fromName, 'Dana')
})

test('threads join by References, and by subject when the parent is not in the mail', () => {
  const r = analyze(
    msgs([
      { from: 'lee@example.com', at: '2026-10-05T09:00:00Z', id: 'q1@x', subject: 'Invoice 42' },
      // Reply refers to a message not in this export: joined by subject and people.
      { from: 'sam@acme.test', to: 'lee@example.com', at: '2026-10-05T09:30:00Z', id: 'q2@x', inReplyTo: 'missing@x', subject: 'RE: Invoice 42' },
      // Same subject, different person: a separate conversation, never answered.
      { from: 'kim@example.com', at: '2026-10-05T09:05:00Z', id: 'q3@x', subject: 'Invoice 42' },
    ]),
    { ...ME, until: Date.parse('2026-10-12T00:00:00Z') },
  )
  const lee = r.waits.find((w) => w.from === 'lee@example.com')
  const kim = r.waits.find((w) => w.from === 'kim@example.com')
  assert.equal(lee?.ms, 30 * 60_000)
  assert.equal(kim?.replied, null)
  assert.equal(kim?.open, false, 'a week old and unanswered is missed')
  assert.equal(r.all.missed, 1)
})

test('automated mail is left out: lists, bulk, auto-replies, bounces, no-reply senders, spam', () => {
  const r = analyze(
    msgs([
      { from: 'news@shop.example', at: '2026-10-01T09:00:00Z', id: '1@x', extra: { 'List-Unsubscribe': '<mailto:u@shop.example>' } },
      { from: 'dana@example.com', at: '2026-10-01T09:00:00Z', id: '2@x', extra: { 'Auto-Submitted': 'auto-replied' } },
      { from: 'billing@vendor.example', at: '2026-10-01T09:00:00Z', id: '3@x', extra: { Precedence: 'bulk' } },
      { from: 'MAILER-DAEMON@mx.example', at: '2026-10-01T09:00:00Z', id: '4@x' },
      { from: 'no-reply@app.example', at: '2026-10-01T09:00:00Z', id: '5@x' },
      { from: 'prize@spam.example', at: '2026-10-01T09:00:00Z', id: '6@x', extra: { 'X-Gmail-Labels': 'Spam,Unread' } },
      { from: 'kim@example.com', at: '2026-10-01T09:00:00Z', id: '7@x', extra: { 'Auto-Submitted': 'no' } },
    ]),
    { ...ME, until: Date.parse('2026-10-10T00:00:00Z') },
  )
  assert.equal(r.automated, 6)
  assert.deepEqual(r.waits.map((w) => w.from), ['kim@example.com'])
})

test('a contact form from no-reply@ with the person in Reply-To is a lead, waiting', () => {
  const [m] = msgs([{ from: 'Website <no-reply@forms.example>', at: '2026-10-01T09:00:00Z', id: 'f@x', extra: { 'Reply-To': 'Jo Park <jo@example.com>' } }])
  assert.equal(m.automated, null)
  assert.equal(m.from, 'jo@example.com')
  assert.equal(m.viaForm, true)
  // A newsletter with a Reply-To is still a newsletter.
  const [n] = msgs([{ from: 'no-reply@news.example', at: '2026-10-01T09:00:00Z', extra: { 'Reply-To': 'editor@news.example', 'List-Id': '<news.example>' } }])
  assert.equal(n.automated, 'list')
  // And Reply-To pointing at another robot is not a person.
  const [o] = msgs([{ from: 'no-reply@app.example', at: '2026-10-01T09:00:00Z', extra: { 'Reply-To': 'support-noreply@app.example' } }])
  assert.equal(o.automated, 'no-reply')
})

test('unanswered and under 48 hours old is open: listed, but not counted as missed', () => {
  const r = analyze(
    msgs([
      { from: 'old@example.com', at: '2026-10-01T09:00:00Z', id: 'o@x' },
      { from: 'new@example.com', at: '2026-10-09T09:00:00Z', id: 'n@x' },
    ]),
    { ...ME, until: Date.parse('2026-10-10T00:00:00Z') },
  )
  assert.equal(r.all.count, 1)
  assert.equal(r.all.missed, 1)
  assert.deepEqual(
    r.waiting.map((w) => [w.from, w.open]),
    [
      ['new@example.com', true],
      ['old@example.com', false],
    ],
  )
})

test('after hours and new contacts are counted in your time zone', () => {
  const r = analyze(
    msgs([
      // 07:30 in Chicago on a Monday: before opening.
      { from: 'a@example.com', at: '2026-10-05T12:30:00Z', id: 'a1@x' },
      { from: 'sam@acme.test', to: 'a@example.com', at: '2026-10-05T14:30:00Z', id: 'a2@x', inReplyTo: 'a1@x' },
      // 10:00 in Chicago on a Monday: open.
      { from: 'a@example.com', at: '2026-10-05T15:00:00Z', id: 'b1@x', subject: 'Second question' },
      { from: 'sam@acme.test', to: 'a@example.com', at: '2026-10-05T15:10:00Z', id: 'b2@x', inReplyTo: 'b1@x' },
    ]),
    { ...ME, timeZone: 'America/Chicago' },
  )
  const [first, second] = r.waits
  assert.equal(first.afterHours, true)
  assert.equal(second.afterHours, false)
  assert.equal(first.firstContact, true)
  assert.equal(second.firstContact, false)
  assert.equal(r.afterHours.median, 2 * 3_600_000)
  assert.equal(r.openHours.median, 10 * 60_000)
  assert.equal(r.firstContact.count, 1)
  assert.equal(r.arrivals[1][7], 1, 'Monday 7am Chicago')
})

test('your address is found from the Sent label when not given', () => {
  const sent = msgs([{ from: 'sam@acme.test', to: 'dana@example.com', at: '2026-10-05T10:00:00Z', id: 's@x' }], ['Sent'])
  const inbox = msgs([{ from: 'dana@example.com', at: '2026-10-05T09:00:00Z', id: 'i@x' }], ['Inbox'])
  const r = analyze([...inbox, ...sent])
  assert.deepEqual(r.me, ['sam@acme.test'])
  assert.equal(r.meFrom, 'sent folder')
  assert.equal(r.all.answered, 1)
})

test('a colleague at your domain answering counts; mail not addressed to you does not start a wait', () => {
  const r = analyze(
    msgs([
      { from: 'dana@example.com', to: 'help@acme.test', at: '2026-10-05T10:00:00Z', id: 'h1@x' },
      { from: 'alex@acme.test', to: 'dana@example.com', at: '2026-10-05T10:05:00Z', id: 'h2@x', inReplyTo: 'h1@x' },
      { from: 'dana@example.com', to: 'someone@else.example', at: '2026-10-05T11:00:00Z', id: 'h3@x', subject: 'Unrelated' },
    ]),
    { me: ['sam@acme.test'], domains: ['@acme.test'], timeZone: 'UTC', until: Date.parse('2026-10-12T00:00:00Z') },
  )
  assert.equal(r.waits.length, 1)
  assert.equal(r.waits[0].ms, 5 * 60_000)
})

test('the same message in two folders counts once', () => {
  const spec = { from: 'dana@example.com', at: '2026-10-05T10:00:00Z', id: 'dup@x' }
  const r = analyze([...msgs([spec], ['Inbox']), ...msgs([spec], ['Important'])], { ...ME, until: Date.parse('2026-10-12T00:00:00Z') })
  assert.equal(r.waits.length, 1)
})

test('grades on a scale anyone can check', () => {
  const s = (/** @type {number} */ hours, /** @type {number} */ share) => ({ count: 10, answered: 0, missed: 0, answeredShare: share, median: hours * 3_600_000, p90: null })
  assert.equal(grade(s(0.5, 0.95)), 'A')
  assert.equal(grade(s(0.5, 0.85)), 'B', 'fast but not answering everyone is not an A')
  assert.equal(grade(s(3, 0.9)), 'B')
  assert.equal(grade(s(20, 0.7)), 'C')
  assert.equal(grade(s(48, 0.5)), 'D')
  assert.equal(grade(s(100, 1)), 'F')
  assert.equal(grade({ count: 3, answered: 0, missed: 3, answeredShare: 0, median: null, p90: null }), 'F')
  assert.equal(grade({ count: 0, answered: 0, missed: 0, answeredShare: null, median: null, p90: null }), null)
})

test('mbox: header blocks only, split on From lines after a blank line, streamed in any chunk size', async () => {
  const text = mbox([
    { from: 'a@example.com', at: '2026-10-05T10:00:00Z', id: 'm1@x' },
    { from: 'b@example.com', at: '2026-10-05T11:00:00Z', id: 'm2@x', extra: { Subject2: 'x' } },
  ]).replace(/\n/g, '\r\n')
  for (const size of [1, 7, 4096]) {
    const chunks = []
    for (let i = 0; i < text.length; i += size) chunks.push(text.slice(i, i + size))
    const blocks = []
    for await (const b of mboxHeaders(chunks)) blocks.push(b)
    assert.equal(blocks.length, 2, `chunk size ${size}`)
    assert.match(blocks[1], /^From: b@example\.com$/m)
    assert.doesNotMatch(blocks.join('\n'), /Hello|body line/)
  }
  assert.equal(emlHeaders('From: a@example.com\r\nTo: b@example.com\r\n\r\nBody'), 'From: a@example.com\nTo: b@example.com')
})

test('headers: folded lines, encoded words, quoted names with commas', () => {
  const h = parseHeaders('Subject: =?UTF-8?Q?R=C3=A9ponse?=\n =?UTF-8?B?IMOgIHZvdXM=?=\nTo: "Park, Jo" <jo@example.com>, kim@example.com\nTo: second@example.com')
  assert.equal(decodeWords(h.subject), 'Réponse à vous')
  assert.deepEqual(addresses(h.to), ['jo@example.com', 'kim@example.com'])
})

test('open hours as people write them', () => {
  assert.deepEqual(parseHours('Mon-Fri 9-17'), { days: [1, 2, 3, 4, 5], start: 540, end: 1020 })
  assert.deepEqual(parseHours('Mon-Sat 8:30-18'), { days: [1, 2, 3, 4, 5, 6], start: 510, end: 1080 })
  assert.deepEqual(parseHours('Fri-Mon 10-14'), { days: [0, 1, 5, 6], start: 600, end: 840 })
  assert.deepEqual(parseHours('every day 0-24'), { days: [0, 1, 2, 3, 4, 5, 6], start: 0, end: 1440 })
  assert.equal(parseHours('Mon-Fri 17-9'), null)
  assert.equal(parseHours('weekdays'), null)
  assert.equal(duration(30_000), 'under 1m')
  assert.equal(duration(130 * 60_000), '2h 10m')
  assert.equal(duration(76 * 3_600_000), '3d 4h')
})

test('the card shows totals only; names and subjects stay in the local report', () => {
  const r = analyze(
    msgs([
      { from: 'Dana Secret <dana@example.com>', at: '2026-10-01T10:00:00Z', id: 'c1@x', subject: 'Private matter' },
      { from: 'sam@acme.test', to: 'dana@example.com', at: '2026-10-01T10:40:00Z', id: 'c2@x', inReplyTo: 'c1@x', subject: 'Re: Private matter' },
      { from: 'Kim <kim@example.com>', at: '2026-10-02T10:00:00Z', id: 'c3@x', subject: 'Another private matter' },
    ]),
    { ...ME, until: Date.parse('2026-10-10T00:00:00Z') },
  )
  const card = renderCard(r, { business: 'Acme <Plumbing>' })
  assert.match(card, /^<svg /)
  assert.match(card, /Acme &lt;Plumbing&gt;/)
  for (const secret of ['dana', 'Dana', 'kim', 'Private', 'sam@acme']) assert.ok(!card.includes(secret), `card leaks ${secret}`)
  const html = renderHtml(r)
  assert.match(html, /kim@example\.com/)
  assert.match(html, /Another private matter/)
  const text = formatText(r)
  assert.match(text, /GRADE D/)
  assert.match(text, /Kim <kim@example\.com>/)
})

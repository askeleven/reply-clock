import { duration, percent, period, openHours } from './format.js'

/**
 * @typedef {import('./analyze.js').Report} Report
 * @typedef {import('./analyze.js').Stats} Stats
 */

const COLOURS = { reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m', red: '\x1b[31m', yellow: '\x1b[33m', green: '\x1b[32m' }

/**
 * @param {boolean} enabled
 * @returns {(code: string, text: string) => string}
 */
function painter(enabled) {
  return (code, text) => (enabled ? `${code}${text}${COLOURS.reset}` : text)
}

/**
 * The report for the terminal. It lists who is still waiting, with names and subjects:
 * that stays on your screen. The card never includes them.
 *
 * @param {Report} r
 * @param {{ colour?: boolean, list?: number }} [options] list: how many waiting to show.
 * @returns {string}
 */
export function formatText(r, { colour = false, list = 10 } = {}) {
  const paint = painter(colour)
  const gradeColour = { A: COLOURS.green, B: COLOURS.green, C: COLOURS.yellow, D: COLOURS.red, F: COLOURS.red }[r.grade ?? 'F'] ?? ''
  if (r.all.count === 0 && r.waiting.length === 0) {
    return (
      `No one was waiting for a reply from ${r.me.join(', ') || 'you'} between ${period(r.since, r.until, r.timeZone)}.\n` +
      `${r.messages} messages read, ${r.automated} of them automated. If that is wrong, check --me and --since.\n`
    )
  }
  /** @param {Stats} s */
  const row = (s) => `${duration(s.median).padEnd(10)} median   ${percent(s.answeredShare).padStart(4)} answered   ${String(s.count).padStart(5)} times`
  const b = r.buckets
  const lines = [
    `${paint(COLOURS.bold + gradeColour, `GRADE ${r.grade ?? '-'}`)}  ${paint(COLOURS.bold, `Median first reply ${duration(r.all.median)}, ${percent(r.all.answeredShare)} answered`)}`,
    '',
    `      Mail         ${r.me.join(', ')}${r.domains.length ? ` and @${r.domains.join(', @')}` : ''} ${paint(COLOURS.dim, `(${r.meFrom})`)}`,
    `      Period       ${period(r.since, r.until, r.timeZone)}, ${r.messages} messages, ${r.automated} automated left out`,
    `      Open hours   ${openHours(r.hours)}, ${r.timeZone}`,
    `      People       ${r.people} people were waiting ${r.waits.length} times`,
    '',
    `  All          ${row(r.all)}`,
    `  In hours     ${row(r.openHours)}`,
    `  After hours  ${row(r.afterHours)}`,
    `  New contacts ${row(r.firstContact)}`,
    `  Slowest 10%  ${duration(r.all.p90)} or more`,
    '',
    `  Answered within 5 min ${b.within5m}, 1 hour ${b.within1h}, 4 hours ${b.within4h}, a day ${b.within24h}, later ${b.later}. Never: ${b.never}.`,
  ]
  const waiting = r.waiting.slice(0, list)
  if (waiting.length) {
    lines.push('', paint(COLOURS.bold, `Unanswered (${r.waiting.length})`))
    for (const w of waiting) {
      const age = duration(r.until - w.start)
      const who = w.fromName && w.fromName !== w.from ? `${w.fromName} <${w.from}>` : w.from
      const flags = [w.firstContact ? 'new' : '', w.viaForm ? 'form' : '', w.open ? '' : 'missed'].filter(Boolean).join(', ')
      lines.push(`  ${paint(w.open ? COLOURS.yellow : COLOURS.red, age.padEnd(8))} ${who}  ${paint(COLOURS.dim, truncate(w.subject, 60))}${flags ? paint(COLOURS.dim, `  (${flags})`) : ''}`)
    }
    if (r.waiting.length > waiting.length) lines.push(paint(COLOURS.dim, `  and ${r.waiting.length - waiting.length} more; --list ${r.waiting.length} shows them all`))
  }
  lines.push('', paint(COLOURS.dim, `Grade: A within 1 hour and 90% answered, B 4 hours and 80%, C a day and 70%, D 3 days and 50%.`))
  return `${lines.join('\n')}\n`
}

/**
 * @param {string} s
 * @param {number} n
 * @returns {string}
 */
function truncate(s, n) {
  const flat = s.replace(/\s+/g, ' ').trim() || '(no subject)'
  return flat.length > n ? `${flat.slice(0, n - 3)}...` : flat
}

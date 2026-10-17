import { renderCard } from './card.js'
import { duration, percent, period, openHours } from './format.js'

/**
 * The full report as HTML: the card, the numbers, when people write, and who is still
 * waiting. The web page shows the same sections, so the CLI and the page agree.
 *
 * Runs in Node and in the browser: no Node imports.
 *
 * @typedef {import('./analyze.js').Report} Report
 * @typedef {import('./analyze.js').Stats} Stats
 */

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

/**
 * Everything below the card. Names and subjects of people waiting are in here: keep this
 * on your own machine. The card is the part made to share.
 *
 * @param {Report} r
 * @param {{ list?: number }} [options] How many waiting to list. Default 50.
 * @returns {string}
 */
export function renderSections(r, { list = 50 } = {}) {
  /** @param {string} label @param {Stats} s */
  const row = (label, s) =>
    `<tr><th scope="row">${label}</th><td>${duration(s.median)}</td><td>${duration(s.p90)}</td><td>${percent(s.answeredShare)}</td><td>${s.count}</td></tr>`
  const max = Math.max(1, ...r.arrivals.flat())
  const order = [1, 2, 3, 4, 5, 6, 0]
  const heat = order
    .map((d) => {
      const cells = r.arrivals[d]
        .map((n, h) => {
          const open = r.hours.days.includes(d) && h * 60 + 60 > r.hours.start && h * 60 < r.hours.end
          return `<td class="${open ? 'open' : ''}" style="--v:${(n / max).toFixed(3)}" title="${DAYS[d]} ${h}:00, ${n} ${n === 1 ? 'message' : 'messages'}"></td>`
        })
        .join('')
      return `<tr><th scope="row">${DAYS[d]}</th>${cells}</tr>`
    })
    .join('')
  const hoursHead = Array.from({ length: 24 }, (_, h) => `<th scope="col">${h % 3 === 0 ? h : ''}</th>`).join('')
  const waiting = r.waiting
    .slice(0, list)
    .map((w) => {
      const who = w.fromName && w.fromName !== w.from ? `${esc(w.fromName)} <span class="muted">${esc(w.from)}</span>` : esc(w.from)
      const flags = [w.firstContact ? 'new contact' : '', w.viaForm ? 'via a form' : ''].filter(Boolean).join(', ')
      return `<tr class="${w.open ? 'is-open' : 'is-missed'}"><td>${duration(r.until - w.start)}</td><td>${who}</td><td>${esc(w.subject || '(no subject)')}</td><td>${w.open ? 'waiting' : 'missed'}${flags ? `, ${flags}` : ''}</td></tr>`
    })
    .join('')
  const more = r.waiting.length > list ? `<p class="muted">And ${r.waiting.length - list} more.</p>` : ''
  return `<section>
<h2>First reply times</h2>
<p class="muted">${esc(`${r.me.join(', ')}${r.domains.length ? ` and anyone at @${r.domains.join(', @')}` : ''}`)}, ${esc(period(r.since, r.until, r.timeZone))}. ${r.messages} messages read, ${r.automated} sent by software and left out. ${r.people} people were waiting ${r.waits.length} times.</p>
<table class="stats"><thead><tr><th></th><th scope="col">Median</th><th scope="col">Slowest 10%</th><th scope="col">Answered</th><th scope="col">Times</th></tr></thead><tbody>
${row('All', r.all)}
${row('In open hours', r.openHours)}
${row('After hours', r.afterHours)}
${row('New contacts', r.firstContact)}
</tbody></table>
<p class="muted">Times still waiting under 48 hours are left out of these numbers: they may yet be answered.</p>
</section>
<section>
<h2>When people write</h2>
<p class="muted">Messages from people by hour, ${esc(r.timeZone)}. Outlined cells are your open hours, ${esc(openHours(r.hours))}.</p>
<div class="heat-wrap"><table class="heat"><thead><tr><th></th>${hoursHead}</tr></thead><tbody>${heat}</tbody></table></div>
</section>
<section>
<h2>Unanswered (${r.waiting.length})</h2>
${r.waiting.length ? `<table class="waiting"><thead><tr><th scope="col">For</th><th scope="col">Who</th><th scope="col">Subject</th><th scope="col"></th></tr></thead><tbody>${waiting}</tbody></table>${more}` : '<p>Nobody. Every message from a person got a reply.</p>'}
</section>`
}

/** Styles for the sections, shared by the HTML file and the web page. */
export const SECTION_CSS = `
.stats,.waiting{border-collapse:collapse;width:100%;font-variant-numeric:tabular-nums}
.stats th,.stats td,.waiting th,.waiting td{text-align:left;padding:.5rem .75rem;border-bottom:1px solid var(--line)}
.stats td{font-weight:600}
.waiting td:first-child{white-space:nowrap;font-weight:600}
.waiting .is-missed td:first-child{color:var(--bad)}
.waiting .is-open td:first-child{color:var(--warn)}
.heat-wrap{overflow-x:auto}
.heat{border-collapse:separate;border-spacing:2px;font-size:.75rem}
.heat th{font-weight:400;color:var(--muted);padding:0 .25rem;text-align:left}
.heat td{width:1.4rem;height:1.4rem;border-radius:3px;background:color-mix(in srgb,var(--accent) calc(var(--v)*100%),var(--cell))}
.heat td.open{outline:1px solid var(--muted);outline-offset:-1px}
.muted{color:var(--muted)}
`

/**
 * A self-contained HTML file: the card, then the sections.
 *
 * @param {Report} r
 * @param {{ business?: string, list?: number }} [options]
 * @returns {string}
 */
export function renderHtml(r, options = {}) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Reply times${options.business ? `: ${esc(options.business)}` : ''}</title>
<style>
:root{--bg:#f8fafc;--text:#0f172a;--muted:#64748b;--line:#e2e8f0;--cell:#eef2f7;--accent:#2563eb;--bad:#dc2626;--warn:#b45309}
@media (prefers-color-scheme:dark){:root{--bg:#0b1220;--text:#e2e8f0;--muted:#94a3b8;--line:#1e293b;--cell:#152033;--accent:#60a5fa;--bad:#f87171;--warn:#fbbf24}}
body{margin:0;background:var(--bg);color:var(--text);font:16px/1.5 -apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif}
main{max-width:960px;margin:0 auto;padding:2rem 1rem 4rem}
.card svg{width:100%;height:auto;border-radius:12px;box-shadow:0 0 0 1px var(--line)}
h2{margin:2.5rem 0 .5rem;font-size:1.25rem}
${SECTION_CSS}
</style>
</head>
<body>
<main>
<div class="card">${renderCard(r, options)}</div>
<p class="muted">The card above shows totals only, so it is safe to share. Everything below names people: it stays on your machine.</p>
${renderSections(r, options)}
</main>
</body>
</html>
`
}

/**
 * @param {string} s
 * @returns {string}
 */
export function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

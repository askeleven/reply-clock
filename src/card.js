import { duration, percent, period, openHours } from './format.js'

/**
 * The report card: an SVG, so it is one file, sharp at any size, and the browser can turn
 * it into a PNG without a library. It shows totals only: no addresses, names or subjects.
 *
 * Runs in Node and in the browser: no Node imports.
 *
 * @typedef {import('./analyze.js').Report} Report
 */

const W = 1200
const H = 630

const GRADE_COLOURS = /** @type {Record<string, string>} */ ({ A: '#16a34a', B: '#65a30d', C: '#ca8a04', D: '#ea580c', F: '#dc2626' })

/**
 * @param {Report} r
 * @param {{ business?: string }} [options] A name to show at the top, if you want one.
 * @returns {string}
 */
export function renderCard(r, options = {}) {
  const g = r.grade ?? '-'
  const gradeColour = GRADE_COLOURS[g] ?? '#64748b'
  const font = `font-family="-apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif"`
  const mono = `font-family="ui-monospace, 'SF Mono', Menlo, Consolas, monospace"`
  const title = options.business ? esc(options.business) : 'How fast we reply'

  const stat = (/** @type {number} */ x, /** @type {number} */ y, /** @type {string} */ value, /** @type {string} */ label) =>
    `<text x="${x}" y="${y}" ${font} font-size="44" font-weight="700" fill="#0f172a">${esc(value)}</text>` +
    `<text x="${x}" y="${y + 32}" ${font} font-size="20" fill="#475569">${esc(label)}</text>`

  // How quickly people were answered, as one stacked bar.
  const b = r.buckets
  const segments = [
    ['5 min', b.within5m, '#16a34a'],
    ['1 hour', b.within1h, '#65a30d'],
    ['4 hours', b.within4h, '#ca8a04'],
    ['1 day', b.within24h, '#ea580c'],
    ['later', b.later, '#dc2626'],
    ['not answered', b.never, '#7f1d1d'],
  ]
  const total = segments.reduce((s, x) => s + /** @type {number} */ (x[1]), 0)
  let x = 80
  const barW = W - 160
  let bar = ''
  let legend = ''
  let lx = 232
  for (const [label, n, colour] of segments) {
    const count = /** @type {number} */ (n)
    if (!total) break
    const w = (count / total) * barW
    if (w > 0) bar += `<rect x="${x.toFixed(1)}" y="430" width="${w.toFixed(1)}" height="36" fill="${colour}"/>`
    x += w
    const text = `${label} ${Math.round((count / total) * 100)}%`
    legend += `<rect x="${lx}" y="488" width="14" height="14" rx="3" fill="${colour}"/><text x="${lx + 20}" y="501" ${font} font-size="17" fill="#334155">${esc(text)}</text>`
    lx += 20 + text.length * 8.6 + 26
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="Reply time report card: grade ${g}, median first reply ${duration(r.all.median)}">
<rect width="${W}" height="${H}" fill="#f8fafc"/>
<rect x="0" y="0" width="${W}" height="10" fill="${gradeColour}"/>
<text x="80" y="92" ${font} font-size="30" font-weight="700" fill="#0f172a">${title}</text>
<text x="80" y="128" ${font} font-size="20" fill="#475569">${esc(`Email, ${period(r.since, r.until, r.timeZone)}. ${r.all.count} times someone was waiting.`)}</text>
<rect x="${W - 250}" y="52" width="170" height="170" rx="24" fill="${gradeColour}"/>
<text x="${W - 165}" y="175" ${font} font-size="120" font-weight="800" fill="#ffffff" text-anchor="middle">${g}</text>
<text x="80" y="236" ${font} font-size="96" font-weight="800" fill="#0f172a">${esc(duration(r.all.median))}</text>
<text x="80" y="276" ${font} font-size="22" fill="#475569">median time to first reply</text>
${stat(80, 356, percent(r.all.answeredShare), 'answered at all')}
${stat(380, 356, duration(r.afterHours.median), 'after hours, median')}
${stat(700, 356, duration(r.firstContact.median), 'new contacts, median')}
<rect x="80" y="430" width="${barW}" height="36" fill="#e2e8f0"/>
${bar}
${legend}
<text x="80" y="501" ${font} font-size="17" font-weight="600" fill="#334155">Answered within</text>
<text x="80" y="580" ${font} font-size="17" fill="#64748b">${esc(`Open hours ${openHours(r.hours)} (${r.timeZone}). Automated mail left out.`)}</text>
<text x="${W - 80}" y="580" ${mono} font-size="17" fill="#64748b" text-anchor="end">npx @askeleven/reply-clock</text>
</svg>
`
}

/**
 * @param {string} s
 * @returns {string}
 */
function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

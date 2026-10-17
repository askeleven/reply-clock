/**
 * Durations and percentages as people say them. Shared by the terminal report, the card
 * and the web page.
 */

/**
 * "4m", "2h 10m", "3d 4h".
 *
 * @param {number | null} ms
 * @returns {string}
 */
export function duration(ms) {
  if (ms === null) return 'none'
  if (ms < 60_000) return 'under 1m'
  const m = Math.round(ms / 60_000)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return m % 60 ? `${h}h ${m % 60}m` : `${h}h`
  const d = Math.floor(h / 24)
  return h % 24 ? `${d}d ${h % 24}h` : `${d}d`
}

/**
 * @param {number | null} share 0 to 1.
 * @returns {string}
 */
export function percent(share) {
  return share === null ? 'none' : `${Math.round(share * 100)}%`
}

/**
 * "16 Jul to 14 Oct 2026"
 *
 * @param {number} since
 * @param {number} until
 * @param {string} timeZone
 * @returns {string}
 */
export function period(since, until, timeZone) {
  const day = (/** @type {number} */ t, /** @type {boolean} */ year) =>
    new Date(t).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', ...(year ? { year: 'numeric' } : {}), timeZone })
  return `${day(since, false)} to ${day(until, true)}`
}

/**
 * "Mon to Fri, 9:00 to 17:00"
 *
 * @param {{ days: number[], start: number, end: number }} hours
 * @returns {string}
 */
export function openHours(hours) {
  const names = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
  const days = [...hours.days].sort((a, b) => a - b)
  const contiguous = days.every((d, i) => i === 0 || d === days[i - 1] + 1)
  const dayText = days.length === 7 ? 'Every day' : contiguous && days.length > 2 ? `${names[days[0]]} to ${names[days.at(-1) ?? 0]}` : days.map((d) => names[d]).join(', ')
  const t = (/** @type {number} */ m) => `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`
  return `${dayText}, ${t(hours.start)} to ${t(hours.end)}`
}

/**
 * Open hours as people write them: "Mon-Fri 9-17", "Mon-Sat 8:30-18:00", "Mon,Wed,Fri 10-16",
 * "every day 0-24". Null when it cannot be read.
 *
 * @param {string} text
 * @returns {{ days: number[], start: number, end: number } | null}
 */
export function parseHours(text) {
  const m = /^\s*(.+?)\s+(\d{1,2})(?::(\d{2}))?\s*-\s*(\d{1,2})(?::(\d{2}))?\s*$/.exec(text)
  if (!m) return null
  const names = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']
  const day = (/** @type {string} */ s) => names.indexOf(s.trim().slice(0, 3).toLowerCase())
  /** @type {Set<number>} */
  const days = new Set()
  if (/^(?:every ?day|daily|all)$/i.test(m[1].trim())) for (let d = 0; d < 7; d++) days.add(d)
  else {
    for (const part of m[1].split(',')) {
      const [a, b] = part.split('-').map(day)
      if (a < 0 || (b !== undefined && b < 0)) return null
      if (b === undefined) days.add(a)
      else for (let d = a; ; d = (d + 1) % 7) {
        days.add(d)
        if (d === b) break
      }
    }
  }
  const start = Number(m[2]) * 60 + Number(m[3] ?? 0)
  const end = Number(m[4]) * 60 + Number(m[5] ?? 0)
  if (start >= end || end > 24 * 60 || Number(m[3] ?? 0) > 59 || Number(m[5] ?? 0) > 59) return null
  return { days: [...days].sort((x, y) => x - y), start, end }
}

/**
 * Turns messages into response times: for every time a person wrote to you and was left
 * waiting, how long until you answered, if you did.
 *
 * Runs in Node and in the browser: no Node imports.
 *
 * @typedef {import('./message.js').Message} Message
 *
 * @typedef {object} Hours Your open hours, in your time zone.
 * @property {number[]} days 0 is Sunday. Default Monday to Friday.
 * @property {number} start Minutes after midnight. Default 9:00.
 * @property {number} end Default 17:00.
 *
 * @typedef {object} AnalyzeOptions
 * @property {string[]} [me] Your addresses. Found from the Sent folder or label when not given.
 * @property {string[]} [domains] Your business's domains: anyone at them answering counts.
 * @property {string} [timeZone] IANA, such as America/New_York. Default UTC.
 * @property {Partial<Hours>} [hours]
 * @property {number} [since] Only waits that started at or after this, in ms. Default
 *   90 days before the newest message.
 * @property {number} [until] Default the newest message.
 *
 * @typedef {object} Wait One time someone was waiting for you.
 * @property {number} start When their message arrived.
 * @property {number | null} replied When you answered, or null.
 * @property {number | null} ms How long it took.
 * @property {string} from Who was waiting.
 * @property {string} fromName
 * @property {string} subject
 * @property {boolean} afterHours It arrived outside your open hours.
 * @property {boolean} firstContact The first time they wrote to you, as far as this mail shows.
 * @property {boolean} viaForm It came through a form, with them in Reply-To.
 * @property {boolean} open Not answered, and too recent to count as missed.
 *
 * @typedef {'A'|'B'|'C'|'D'|'F'} Grade
 *
 * @typedef {object} Stats
 * @property {number} count Waits counted: answered and missed.
 * @property {number} answered
 * @property {number} missed Never answered.
 * @property {number | null} answeredShare 0 to 1.
 * @property {number | null} median In ms, of answered waits.
 * @property {number | null} p90
 *
 * @typedef {object} Report
 * @property {string[]} me The addresses counted as you.
 * @property {string[]} domains
 * @property {'given'|'sent folder'|'most addressed'} meFrom How your addresses were found.
 * @property {string} timeZone
 * @property {Hours} hours
 * @property {number} since
 * @property {number} until
 * @property {number} messages Messages read in the period.
 * @property {number} automated Of those, sent by software and left out.
 * @property {number} people Distinct people who were waiting.
 * @property {Stats} all
 * @property {Stats} afterHours
 * @property {Stats} openHours
 * @property {Stats} firstContact
 * @property {{ within5m: number, within1h: number, within4h: number, within24h: number, later: number, never: number }} buckets
 * @property {number[][]} arrivals Messages from people by day (0 Sunday) and hour, in your time zone.
 * @property {Grade | null} grade
 * @property {Wait[]} waiting Unanswered now, newest first.
 * @property {Wait[]} waits Every wait in the period.
 */

/** A wait younger than this when the mail ends is still open, not missed. */
const OPEN_MS = 48 * 3_600_000
const DAY_MS = 86_400_000

/**
 * @param {Message[]} input
 * @param {AnalyzeOptions} [options]
 * @returns {Report}
 */
export function analyze(input, options = {}) {
  const timeZone = options.timeZone ?? 'UTC'
  const local = localClock(timeZone)
  const hours = {
    days: options.hours?.days ?? [1, 2, 3, 4, 5],
    start: options.hours?.start ?? 9 * 60,
    end: options.hours?.end ?? 17 * 60,
  }

  const messages = dedupe(input.filter((m) => m.at !== null && m.from))
  const { me, meFrom } = whoIsMe(messages, options.me)
  const domains = (options.domains ?? []).map((d) => d.toLowerCase().replace(/^@/, ''))
  const isMine = (/** @type {string | null} */ a) => Boolean(a) && (me.includes(/** @type {string} */ (a)) || domains.some((d) => /** @type {string} */ (a).endsWith(`@${d}`)))
  const toMe = (/** @type {Message} */ m) => m.to.length === 0 || m.to.some(isMine)

  const newest = messages.reduce((t, m) => Math.max(t, /** @type {number} */ (m.at)), 0)
  const until = options.until ?? newest
  const since = options.since ?? until - 90 * DAY_MS

  // First time each outside address shows up, written to or from, across all the mail.
  /** @type {Map<string, number>} */
  const firstSeen = new Map()
  for (const m of [...messages].sort((a, b) => /** @type {number} */ (a.at) - /** @type {number} */ (b.at))) {
    const people = isMine(m.from) ? m.to.filter((a) => !isMine(a)) : [/** @type {string} */ (m.from)]
    for (const p of people) if (!firstSeen.has(p)) firstSeen.set(p, /** @type {number} */ (m.at))
  }

  /** @type {Wait[]} */
  const waits = []
  const arrivals = Array.from({ length: 7 }, () => new Array(24).fill(0))
  let inPeriod = 0
  let automated = 0

  for (const thread of threads(messages)) {
    /** @type {Message | null} */
    let waiting = null
    for (const m of thread) {
      const at = /** @type {number} */ (m.at)
      const counted = at >= since && at <= until
      if (counted) inPeriod++
      if (isMine(m.from)) {
        if (waiting) {
          pushWait(waiting, m)
          waiting = null
        }
        continue
      }
      if (m.automated) {
        if (counted) automated++
        continue
      }
      if (!toMe(m)) continue
      if (counted) {
        const { day, hour } = local(at)
        arrivals[day][hour]++
      }
      if (!waiting) waiting = m
    }
    if (waiting) pushWait(waiting, null)
  }

  /**
   * @param {Message} start
   * @param {Message | null} reply
   */
  function pushWait(start, reply) {
    const t = /** @type {number} */ (start.at)
    if (t < since || t > until) return
    const replied = reply ? /** @type {number} */ (reply.at) : null
    const { day, minutes } = local(t)
    const open = hours.days.includes(day) && minutes >= hours.start && minutes < hours.end
    waits.push({
      start: t,
      replied,
      ms: replied === null ? null : Math.max(0, replied - t),
      from: /** @type {string} */ (start.from),
      fromName: start.fromName,
      subject: start.subject,
      afterHours: !open,
      firstContact: firstSeen.get(/** @type {string} */ (start.from)) === t,
      viaForm: start.viaForm,
      open: replied === null && until - t < OPEN_MS,
    })
  }

  waits.sort((a, b) => a.start - b.start)
  const all = stats(waits)
  const answered = waits.filter((w) => w.ms !== null).map((w) => /** @type {number} */ (w.ms))
  const missed = waits.filter((w) => w.replied === null && !w.open).length
  const within = (/** @type {number} */ ms) => answered.filter((x) => x <= ms).length
  return {
    me,
    domains,
    meFrom,
    timeZone,
    hours,
    since,
    until,
    messages: inPeriod,
    automated,
    people: new Set(waits.map((w) => w.from)).size,
    all,
    afterHours: stats(waits.filter((w) => w.afterHours)),
    openHours: stats(waits.filter((w) => !w.afterHours)),
    firstContact: stats(waits.filter((w) => w.firstContact)),
    buckets: {
      within5m: within(5 * 60_000),
      within1h: within(3_600_000) - within(5 * 60_000),
      within4h: within(4 * 3_600_000) - within(3_600_000),
      within24h: within(DAY_MS) - within(4 * 3_600_000),
      later: answered.length - within(DAY_MS),
      never: missed,
    },
    arrivals,
    grade: grade(all),
    waiting: waits.filter((w) => w.replied === null).sort((a, b) => b.start - a.start),
    waits,
  }
}

/**
 * The grade, on a scale anyone can check: the median first reply, and the share answered.
 *
 *   A  median within 1 hour,   and 90% or more answered
 *   B  median within 4 hours,  and 80% or more answered
 *   C  median within 24 hours, and 70% or more answered
 *   D  median within 3 days,   and 50% or more answered
 *   F  anything slower
 *
 * @param {Stats} s
 * @returns {Grade | null}
 */
export function grade(s) {
  if (s.median === null || s.answeredShare === null) return s.count > 0 ? 'F' : null
  const h = s.median / 3_600_000
  const a = s.answeredShare
  if (h <= 1 && a >= 0.9) return 'A'
  if (h <= 4 && a >= 0.8) return 'B'
  if (h <= 24 && a >= 0.7) return 'C'
  if (h <= 72 && a >= 0.5) return 'D'
  return 'F'
}

/**
 * Open waits are left out: they may yet be answered.
 *
 * @param {Wait[]} waits
 * @returns {Stats}
 */
function stats(waits) {
  const settled = waits.filter((w) => !w.open)
  const times = settled.filter((w) => w.ms !== null).map((w) => /** @type {number} */ (w.ms)).sort((a, b) => a - b)
  const missed = settled.length - times.length
  return {
    count: settled.length,
    answered: times.length,
    missed,
    answeredShare: settled.length ? times.length / settled.length : null,
    median: quantile(times, 0.5),
    p90: quantile(times, 0.9),
  }
}

/**
 * @param {number[]} sorted
 * @param {number} q
 * @returns {number | null}
 */
function quantile(sorted, q) {
  if (sorted.length === 0) return null
  const i = (sorted.length - 1) * q
  const lo = Math.floor(i)
  const hi = Math.ceil(i)
  return Math.round(sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo))
}

/**
 * Your addresses: as given; else the senders of everything in a Sent folder or label;
 * else the address mail is most often sent to.
 *
 * @param {Message[]} messages
 * @param {string[] | undefined} given
 * @returns {{ me: string[], meFrom: Report['meFrom'] }}
 */
export function whoIsMe(messages, given) {
  if (given && given.length) return { me: given.map((a) => a.toLowerCase()), meFrom: 'given' }
  const sent = new Set()
  for (const m of messages) {
    if (m.from && m.labels.some((l) => /^(?:sent|\[gmail\]\/sent mail|sent mail|sent items|sent messages)$/i.test(l))) sent.add(m.from)
  }
  if (sent.size) return { me: [...sent], meFrom: 'sent folder' }
  /** @type {Map<string, number>} */
  const counts = new Map()
  for (const m of messages) for (const a of m.to) counts.set(a, (counts.get(a) ?? 0) + 1)
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]
  return { me: top ? [top[0]] : [], meFrom: 'most addressed' }
}

/**
 * The same message twice, as it is when it sits in two folders, counts once.
 *
 * @param {Message[]} messages
 * @returns {Message[]}
 */
function dedupe(messages) {
  /** @type {Map<string, Message>} */
  const seen = new Map()
  for (const m of messages) {
    const key = m.id ?? `${m.from}|${m.at}|${m.subject}`
    const prior = seen.get(key)
    if (prior) prior.labels = [...new Set([...prior.labels, ...m.labels])]
    else seen.set(key, { ...m, labels: [...m.labels] })
  }
  return [...seen.values()]
}

/**
 * Conversations, each oldest first. Messages are joined by Message-ID, In-Reply-To and
 * References, by a provider's thread id, and, for a message whose parents are not in this
 * mail, by subject with the same outside person.
 *
 * @param {Message[]} messages
 * @returns {Message[][]}
 */
function threads(messages) {
  /** @type {Map<string, string>} */
  const parent = new Map()
  const find = (/** @type {string} */ k) => {
    if (!parent.has(k)) parent.set(k, k)
    let r = k
    while (parent.get(r) !== r) r = /** @type {string} */ (parent.get(r))
    let c = k
    while (parent.get(c) !== r) {
      const n = /** @type {string} */ (parent.get(c))
      parent.set(c, r)
      c = n
    }
    return r
  }
  const union = (/** @type {string} */ a, /** @type {string} */ b) => {
    const ra = find(a)
    const rb = find(b)
    if (ra !== rb) parent.set(rb, ra)
  }
  const known = new Set(messages.map((m) => m.id).filter(Boolean))
  const keyOf = (/** @type {Message} */ m, /** @type {number} */ i) => `m:${m.id ?? `#${i}`}`

  messages.forEach((m, i) => {
    const k = keyOf(m, i)
    find(k)
    for (const p of m.parents) union(k, `m:${p}`)
    if (m.thread) union(k, `t:${m.thread}`)
    if (!m.parents.some((p) => known.has(p))) {
      const subject = normalizeSubject(m.subject)
      if (subject) {
        const others = [m.from ?? '', ...m.to].filter(Boolean).sort().join(',')
        union(k, `s:${subject}|${others}`)
      }
    }
  })

  /** @type {Map<string, Message[]>} */
  const groups = new Map()
  messages.forEach((m, i) => {
    const r = find(keyOf(m, i))
    const g = groups.get(r)
    if (g) g.push(m)
    else groups.set(r, [m])
  })
  return [...groups.values()].map((g) => g.sort((a, b) => /** @type {number} */ (a.at) - /** @type {number} */ (b.at)))
}

/**
 * @param {string} subject
 * @returns {string}
 */
function normalizeSubject(subject) {
  return subject
    .toLowerCase()
    .replace(/^(?:\s*(?:re|fw|fwd|aw|wg|sv|vs|tr|rv)\s*(?:\[\d+\])?\s*:\s*)+/i, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * @param {string} timeZone
 * @returns {(ms: number) => { day: number, hour: number, minutes: number }}
 */
export function localClock(timeZone) {
  const fmt = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short', hour: 'numeric', minute: 'numeric', hourCycle: 'h23' })
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
  return (ms) => {
    const parts = fmt.formatToParts(new Date(ms))
    const get = (/** @type {string} */ t) => parts.find((p) => p.type === t)?.value ?? '0'
    const hour = Number(get('hour')) % 24
    return { day: days.indexOf(get('weekday')), hour, minutes: hour * 60 + Number(get('minute')) }
  }
}

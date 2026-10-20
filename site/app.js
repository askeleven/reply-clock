import { mboxHeaders, emlHeaders } from './src/mbox.js'
import { parseHeaders } from './src/headers.js'
import { toMessage } from './src/message.js'
import { analyze } from './src/analyze.js'
import { renderCard } from './src/card.js'
import { renderSections } from './src/html.js'
import { parseHours } from './src/format.js'

/**
 * The web page: the same library the CLI runs, reading files in the browser. The page's
 * Content-Security-Policy forbids every connection, so nothing read here can be sent.
 *
 * @typedef {import('./src/message.js').Message} Message
 */

const $ = (/** @type {string} */ id) => /** @type {HTMLElement} */ (document.getElementById(id))
const input = (/** @type {string} */ id) => /** @type {HTMLInputElement} */ (document.getElementById(id))

// The clock at the top: how long this visitor has been waiting.
const opened = Date.now()
const tick = () => {
  const s = Math.floor((Date.now() - opened) / 1000)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  $('clock').textContent = h ? `${h}:${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}` : `${m}:${String(s % 60).padStart(2, '0')}`
}
tick()
setInterval(tick, 1000)

/** @type {Message[]} */
let messages = []
/** @type {string} */
let card = ''

const status = (/** @type {string} */ text, error = false) => {
  $('status').textContent = text
  $('status').classList.toggle('error', error)
}

/**
 * @param {File[]} files
 */
async function read(files) {
  const mail = files.filter((f) => /\.(?:eml|mbox|mbx)$/i.test(f.name) || f.name === 'mbox' || (!f.webkitRelativePath && !/\.(?:plist|toc|msf|json|html?)$/i.test(f.name)))
  if (mail.length === 0) {
    status('No mail files in that. Drop an .mbox file, .eml files, or a folder of them.', true)
    return
  }
  messages = []
  const total = mail.reduce((n, f) => n + f.size, 0)
  let done = 0
  try {
    for (const file of mail) {
      if (/\.eml$/i.test(file.name)) {
        messages.push(toMessage(parseHeaders(emlHeaders(await file.text()))))
        done += file.size
        continue
      }
      const counted = file.stream().pipeThrough(
        new TransformStream({
          transform(chunk, controller) {
            done += chunk.byteLength
            controller.enqueue(chunk)
          },
        }),
      )
      let n = 0
      for await (const block of mboxHeaders(chunks(counted.pipeThrough(new TextDecoderStream())))) {
        messages.push(toMessage(parseHeaders(block)))
        if (++n % 2000 === 0) {
          status(`Read ${messages.length.toLocaleString()} messages, ${Math.round((done / total) * 100)}%`)
          await new Promise((resolve) => setTimeout(resolve))
        }
      }
    }
  } catch (error) {
    status(`Could not read that file: ${/** @type {Error} */ (error).message}`, true)
    return
  }
  if (messages.length === 0) {
    status('No messages found. Is it an mbox file or .eml files?', true)
    return
  }
  status(`Read ${messages.length.toLocaleString()} messages.`)
  input('me').value = ''
  input('tz').value ||= Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  update()
  $('intro').hidden = true
  $('result').hidden = false
  window.scrollTo(0, 0)
}

/**
 * A stream as an async iterable: Safari's ReadableStream is not one.
 *
 * @param {ReadableStream<string>} stream
 * @returns {AsyncGenerator<string>}
 */
async function* chunks(stream) {
  const reader = stream.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) return
    yield value
  }
}

function update() {
  const list = (/** @type {string} */ v) => v.split(/[\s,;]+/).map((s) => s.trim()).filter(Boolean)
  let timeZone = input('tz').value.trim() || 'UTC'
  try {
    new Intl.DateTimeFormat('en-US', { timeZone })
    input('tz').setCustomValidity('')
  } catch {
    input('tz').setCustomValidity('Unknown time zone')
    timeZone = 'UTC'
  }
  const hours = parseHours(input('hours').value) ?? undefined
  $('hours-hint').textContent = hours ? 'Like Mon-Sat 8:30-18' : 'Could not read that. Write it like Mon-Fri 9-17.'
  const report = analyze(messages, { me: list(input('me').value), domains: list(input('domains').value), timeZone, hours })
  if (!input('me').value.trim()) {
    input('me').placeholder = report.me.join(', ')
    $('me-hint').textContent = report.me.length ? `Found from ${report.meFrom === 'sent folder' ? 'your sent mail' : 'the address most mail is sent to'}. Wrong? Type yours.` : 'Could not tell. Type yours.'
  } else $('me-hint').textContent = ''
  card = renderCard(report, { business: input('business').value.trim() || undefined })
  $('card').innerHTML = card
  $('sections').innerHTML = renderSections(report)
}

/**
 * Files in a dropped folder, however deep.
 *
 * @param {FileSystemEntry} entry
 * @returns {Promise<File[]>}
 */
async function filesIn(entry) {
  if (entry.isFile) return [await new Promise((resolve, reject) => /** @type {FileSystemFileEntry} */ (entry).file(resolve, reject))]
  if (!entry.isDirectory) return []
  const reader = /** @type {FileSystemDirectoryEntry} */ (entry).createReader()
  /** @type {FileSystemEntry[]} */
  const entries = []
  for (;;) {
    /** @type {FileSystemEntry[]} */
    const batch = await new Promise((resolve, reject) => reader.readEntries(resolve, reject))
    if (batch.length === 0) break
    entries.push(...batch)
  }
  const nested = await Promise.all(entries.map(filesIn))
  // Inside a folder, only mail files: an Apple Mail export also holds Info.plist and table_of_contents.
  return nested.flat().filter((f) => /\.(?:eml|mbox|mbx)$/i.test(f.name) || f.name === 'mbox')
}

const drop = $('drop')
drop.addEventListener('dragover', (e) => {
  e.preventDefault()
  drop.classList.add('over')
})
drop.addEventListener('dragleave', () => drop.classList.remove('over'))
drop.addEventListener('drop', async (e) => {
  e.preventDefault()
  drop.classList.remove('over')
  const items = [...(e.dataTransfer?.items ?? [])].map((i) => i.webkitGetAsEntry?.()).filter((x) => x !== null && x !== undefined)
  status('Reading...')
  const files = items.length ? (await Promise.all(items.map(filesIn))).flat() : [...(e.dataTransfer?.files ?? [])]
  await read(files)
})
$('pick-files').addEventListener('click', () => input('files').click())
$('pick-folder').addEventListener('click', () => input('folder').click())
for (const id of ['files', 'folder']) {
  input(id).addEventListener('change', async () => {
    status('Reading...')
    await read([...(input(id).files ?? [])])
    input(id).value = ''
  })
}
for (const id of ['me', 'domains', 'tz', 'hours', 'business']) input(id).addEventListener('input', update)

$('again').addEventListener('click', () => {
  messages = []
  $('card').innerHTML = ''
  $('sections').innerHTML = ''
  $('result').hidden = true
  $('intro').hidden = false
  status('')
})

/**
 * @param {Blob} blob
 * @param {string} name
 */
function download(blob, name) {
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = name
  a.click()
  setTimeout(() => URL.revokeObjectURL(a.href), 1000)
}

$('svg').addEventListener('click', () => download(new Blob([card], { type: 'image/svg+xml' }), 'reply-clock.svg'))
$('png').addEventListener('click', async () => {
  const url = URL.createObjectURL(new Blob([card], { type: 'image/svg+xml' }))
  try {
    const img = new Image()
    img.src = url
    await img.decode()
    const canvas = document.createElement('canvas')
    canvas.width = 2400
    canvas.height = 1260
    const ctx = /** @type {CanvasRenderingContext2D} */ (canvas.getContext('2d'))
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
    canvas.toBlob((blob) => blob && download(blob, 'reply-clock.png'), 'image/png')
  } finally {
    URL.revokeObjectURL(url)
  }
})

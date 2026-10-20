import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mbox } from './helpers.js'

const CLI = new URL('../bin/cli.js', import.meta.url).pathname

/** @param {string[]} args @param {Record<string, string>} [env] */
const run = (args, env = {}) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env: { ...process.env, NO_COLOR: '1', REPLY_CLOCK_PASSWORD: '', ...env } })

test('reads an mbox, prints the report, writes the card and the full report', () => {
  const dir = mkdtempSync(join(tmpdir(), 'reply-clock-'))
  try {
    const file = join(dir, 'export.mbox')
    writeFileSync(
      file,
      mbox([
        { from: 'Dana <dana@example.com>', at: '2026-10-05T14:00:00Z', id: 'a@x' },
        { from: 'sam@acme.test', to: 'dana@example.com', at: '2026-10-05T14:20:00Z', id: 'b@x', inReplyTo: 'a@x', extra: { 'X-Gmail-Labels': 'Sent' } },
      ]),
    )
    const card = join(dir, 'card.svg')
    const html = join(dir, 'report.html')
    const r = run([file, '--tz', 'America/Chicago', '--card', card, '--html', html])
    assert.equal(r.status, 0, r.stderr)
    assert.match(r.stdout, /GRADE A  Median first reply 20m, 100% answered/)
    assert.match(r.stdout, /sam@acme\.test \(sent folder\)/)
    assert.match(readFileSync(card, 'utf8'), /^<svg /)
    assert.match(readFileSync(html, 'utf8'), /^<!doctype html>/)

    const json = run([file, '--json', '--me', 'sam@acme.test'])
    assert.equal(json.status, 0)
    assert.equal(JSON.parse(json.stdout).all.median, 20 * 60_000)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('exit 2 with a clear message for bad input', () => {
  assert.equal(run([]).status, 2)
  const missing = run(['/nonexistent/export.mbox'])
  assert.equal(missing.status, 2)
  assert.match(missing.stderr, /ENOENT/)
  assert.match(run(['x.mbox', '--hours', 'weekdays']).stderr, /Could not read --hours/)
  assert.match(run(['x.mbox', '--tz', 'Mars/Olympus']).stderr, /Unknown time zone/)
  const imap = run(['imap', '--host', 'imap.example.com', '--user', 'sam@acme.test'])
  assert.equal(imap.status, 2)
  assert.match(imap.stderr, /REPLY_CLOCK_PASSWORD/)
})

test('the web page builds, and the code it runs has no Node imports', async () => {
  const r = spawnSync(process.execPath, [new URL('../scripts/build-site.js', import.meta.url).pathname], { encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  const site = new URL('../_site/', import.meta.url).pathname
  for (const file of ['analyze.js', 'card.js', 'format.js', 'headers.js', 'html.js', 'mbox.js', 'message.js']) {
    assert.doesNotMatch(readFileSync(join(site, 'src', file), 'utf8'), /from 'node:/, file)
  }
  assert.match(readFileSync(join(site, 'index.html'), 'utf8'), /connect-src 'none'/)
})

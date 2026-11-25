import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** Was das Fake-`claude` bei einem Aufruf tut. */
export interface ClaudeAntwort {
  /** Datei aus `aufnahmen/`, deren Zeilen auf stdout gehen. */
  aufnahme?: string
  exitCode?: number
  /** Startet ein Kind (`sleep`) und endet nie; die PID des Kinds steht im Aufruf. */
  haengt?: boolean
}

export interface ClaudeAufruf {
  args: string[]
  cwd: string
  /** Wohin stdin zeigt (Linux: Ziel von `/proc/self/fd/0`). */
  stdin: string
  env: Record<string, string | undefined>
  kind?: number
}

// Läuft als CommonJS, weil im Temp-Verzeichnis kein package.json mit "type": "module" liegt.
const SKRIPT = `#!/usr/bin/env node
const fs = require('node:fs')
const path = require('node:path')
const { spawn } = require('node:child_process')
const log = path.join(__dirname, 'aufrufe.jsonl')
const n = fs.readFileSync(log, 'utf8').split('\\n').filter(Boolean).length
const antwort = JSON.parse(fs.readFileSync(path.join(__dirname, 'antworten.json'), 'utf8'))[n]
let stdin = '?'
try { stdin = fs.readlinkSync('/proc/self/fd/0') } catch {}
const env = {}
for (const k of ['GH_TOKEN', 'IN_FAKE_SRT', 'ANTHROPIC_LOG', 'CLAUDE_CODE_RETRY_WATCHDOG', 'CLAUDE_CODE_RETRY_WATCHDOG_MAX_WAIT_MS']) env[k] = process.env[k]
const aufruf = { args: process.argv.slice(2), cwd: process.cwd(), stdin, env }
if (!antwort) {
  fs.appendFileSync(log, JSON.stringify(aufruf) + '\\n')
  process.stderr.write('fake claude: keine Antwort für Aufruf ' + (n + 1))
  process.exit(99)
}
if (antwort.haengt) {
  aufruf.kind = spawn('sleep', ['1000'], { stdio: 'ignore' }).pid
  fs.appendFileSync(log, JSON.stringify(aufruf) + '\\n')
  setInterval(() => {}, 1000)
} else {
  fs.appendFileSync(log, JSON.stringify(aufruf) + '\\n')
  if (antwort.aufnahme) process.stdout.write(fs.readFileSync(antwort.aufnahme))
  process.stdout.write('', () => process.exit(antwort.exitCode ?? 0))
}
`

/**
 * Ein `claude`, das aufgezeichnete `stream-json`-Ausgaben der Reihe nach abspielt und jeden
 * Aufruf festhält. `verzeichnis` gehört vorn in den `PATH`.
 */
export function fakeClaude(antworten: ClaudeAntwort[]) {
  const verzeichnis = mkdtempSync(join(tmpdir(), 'fake-claude-'))
  const mitPfad = antworten.map((a) => ({
    ...a,
    aufnahme: a.aufnahme && join(import.meta.dirname, 'recordings', a.aufnahme),
  }))
  writeFileSync(join(verzeichnis, 'antworten.json'), JSON.stringify(mitPfad))
  writeFileSync(join(verzeichnis, 'aufrufe.jsonl'), '')
  writeFileSync(join(verzeichnis, 'claude'), SKRIPT)
  chmodSync(join(verzeichnis, 'claude'), 0o755)
  return {
    verzeichnis,
    aufrufe: (): ClaudeAufruf[] =>
      readFileSync(join(verzeichnis, 'aufrufe.jsonl'), 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((zeile) => JSON.parse(zeile)),
  }
}

import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** Was das Fake-`gh` auf einen Aufruf antwortet. */
export interface GhAntwort {
  ausgabe?: string
  fehler?: string
  exitCode?: number
}

export interface GhAufruf {
  args: string[]
  /** Was auf stdin ankam. */
  eingabe: string
}

// Läuft als CommonJS, weil im Temp-Verzeichnis kein package.json mit "type": "module" liegt.
const SKRIPT = `#!/usr/bin/env node
const fs = require('node:fs')
const path = require('node:path')
const log = path.join(__dirname, 'aufrufe.jsonl')
let eingabe = ''
try { eingabe = fs.readFileSync(0, 'utf8') } catch {}
fs.appendFileSync(log, JSON.stringify({ args: process.argv.slice(2), eingabe }) + '\\n')
const n = fs.readFileSync(log, 'utf8').trim().split('\\n').length
const antwort = JSON.parse(fs.readFileSync(path.join(__dirname, 'antworten.json'), 'utf8'))[n - 1]
if (!antwort) {
  process.stderr.write('fake gh: keine Antwort für Aufruf ' + n)
  process.exit(99)
}
process.stdout.write(antwort.ausgabe ?? '')
process.stderr.write(antwort.fehler ?? '')
process.exit(antwort.exitCode ?? 0)
`

/**
 * Ein `gh`, das die Antworten der Reihe nach ausgibt und jeden Aufruf festhält.
 * `verzeichnis` gehört vorn in den `PATH`.
 */
export function fakeGh(antworten: GhAntwort[]) {
  const verzeichnis = mkdtempSync(join(tmpdir(), 'fake-gh-'))
  writeFileSync(join(verzeichnis, 'antworten.json'), JSON.stringify(antworten))
  writeFileSync(join(verzeichnis, 'aufrufe.jsonl'), '')
  writeFileSync(join(verzeichnis, 'gh'), SKRIPT)
  chmodSync(join(verzeichnis, 'gh'), 0o755)
  return {
    verzeichnis,
    aufrufe: (): GhAufruf[] =>
      readFileSync(join(verzeichnis, 'aufrufe.jsonl'), 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((zeile) => JSON.parse(zeile)),
  }
}

/** Eine aufgezeichnete Antwort von GitHub aus `aufnahmen/`. */
export function aufnahme(name: string): GhAntwort {
  return { ausgabe: readFileSync(join(import.meta.dirname, 'recordings', name), 'utf8') }
}

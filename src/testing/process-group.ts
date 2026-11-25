import { execFileSync } from 'node:child_process'
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** Die Prozessgruppe dieses Prozesses; ein Strg+C am Terminal trifft alle Prozesse darin. */
export function eigeneProzessgruppe(): string {
  return execFileSync('ps', ['-o', 'pgid=', '-p', String(process.pid)], { encoding: 'utf8' }).trim()
}

/** Ein Ordner mit einem Werkzeug `name`, das nur seine Prozessgruppe ausgibt; gehört vorn in den `PATH`. */
export function meldetProzessgruppe(name: string): string {
  const verzeichnis = mkdtempSync(join(tmpdir(), 'pgid-'))
  writeFileSync(join(verzeichnis, name), '#!/bin/sh\nps -o pgid= -p $$\n')
  chmodSync(join(verzeichnis, name), 0o755)
  return verzeichnis
}

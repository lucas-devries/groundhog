import { execFileSync } from 'node:child_process'

/**
 * Führt `git` im Verzeichnis aus und liefert stdout ohne Leerraum am Ende. Wirft bei Exit ≠ 0.
 * Läuft in eigener Prozessgruppe (ohne Terminal): Das erste Strg+C bricht nichts ab, also darf es
 * auch `git` nicht treffen.
 */
export function git(verzeichnis: string, ...args: string[]): string {
  // Node beachtet `detached` auch synchron; nur die Typen kennen es dort nicht.
  const optionen = { cwd: verzeichnis, encoding: 'utf8', stdio: 'pipe', detached: true } as const
  return execFileSync('git', args, optionen).trimEnd()
}

import { execFileSync } from 'node:child_process'

/** Führt `git` im Verzeichnis aus und liefert stdout ohne Leerraum am Ende. Wirft bei Exit ≠ 0. */
export function git(verzeichnis: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: verzeichnis, encoding: 'utf8', stdio: 'pipe' }).trimEnd()
}

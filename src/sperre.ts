import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { git } from './git.ts'

export type Sperre = { ok: true; freigeben: () => void } | { ok: false; meldung: string }

/**
 * Nimmt die Sperre `.git/groundhog.lock` des Klons (bei Worktrees im gemeinsamen `.git`). Eine
 * Sperre mit toter PID wird übernommen, eine mit lebender bricht ab.
 */
export function nimmSperre(verzeichnis: string, spec: number, start: number): Sperre {
  const gitDir = resolve(verzeichnis, git(verzeichnis, 'rev-parse', '--git-common-dir'))
  const datei = join(gitDir, 'groundhog.lock')
  const inhalt = JSON.stringify({ pid: process.pid, start, spec })
  // ponytail: zwei gleichzeitige Übernahmen einer toten Sperre können beide gewinnen.
  for (;;) {
    try {
      writeFileSync(datei, inhalt, { flag: 'wx' })
      break
    } catch (fehler) {
      if ((fehler as NodeJS.ErrnoException).code !== 'EEXIST') throw fehler
    }
    const alt = lies(datei)
    if (alt && lebt(alt.pid)) {
      return {
        ok: false,
        meldung: `In diesem Klon läuft schon ein Lauf an Spec #${alt.spec} (PID ${alt.pid}).`,
      }
    }
    rmSync(datei, { force: true })
  }
  return {
    ok: true,
    freigeben: () => {
      if (lies(datei)?.pid === process.pid) rmSync(datei, { force: true })
    },
  }
}

function lies(datei: string): { pid: number; spec: number } | undefined {
  try {
    const { pid, spec } = JSON.parse(readFileSync(datei, 'utf8'))
    return Number.isInteger(pid) && pid > 0 ? { pid, spec } : undefined
  } catch {
    return undefined
  }
}

function lebt(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (fehler) {
    // EPERM: Der Prozess lebt, gehört aber einem anderen Nutzer.
    return (fehler as NodeJS.ErrnoException).code === 'EPERM'
  }
}

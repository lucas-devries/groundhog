import { appendFileSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { Ereignis } from './engine.ts'
import { git } from './git.ts'

/** So viele Läufe bleiben pro Klon im Protokoll, der neue eingeschlossen. */
const BEHALTEN = 10

export interface Protokoll {
  /** Ordner des Laufs. */
  pfad: string
  /** Schreibt ein Ereignis der Engine ins Protokoll und reicht es weiter. */
  melde: (ereignis: Ereignis) => void
}

/**
 * Legt den Ordner des Laufs unter `.git/groundhog/laeufe/` an und löscht Läufe über die
 * letzten 10 hinaus. Wirft, wenn der Ordner sich nicht anlegen lässt.
 */
export function oeffneProtokoll(optionen: {
  /** Repo-Root des Klons. */
  verzeichnis: string
  spec: number
  /** Startzeit des Laufs in ms; der Ordner trägt sie in lokaler Zeit. */
  start: number
  /** Bekommt jedes Ereignis danach, dazu einmal eine Warnung, wenn ein Schreiben scheitert. */
  weiter?: (ereignis: Ereignis) => void
}): Protokoll {
  const { verzeichnis, spec, start, weiter } = optionen
  const gitDir = resolve(verzeichnis, git(verzeichnis, 'rev-parse', '--git-common-dir'))
  const laeufe = join(gitDir, 'groundhog', 'laeufe')
  const pfad = join(laeufe, `${zeitstempel(new Date(start))}-spec-${spec}`)
  mkdirSync(laeufe, { recursive: true })
  mkdirSync(pfad)
  // Die Namen beginnen mit der Startzeit, sortieren also chronologisch.
  for (const alt of readdirSync(laeufe).sort().slice(0, -BEHALTEN)) {
    rmSync(join(laeufe, alt), { recursive: true, force: true })
  }

  // Die Checks laufen nach dem zuletzt beendeten Run.
  let letzterRun = ''
  let gewarnt = false
  const schreibe = (datei: string, text: string, zeit: number) => {
    try {
      appendFileSync(join(pfad, datei), text)
    } catch (fehler) {
      if (gewarnt) return
      gewarnt = true
      weiter?.({
        art: 'warnung',
        text: `Protokoll unvollständig, Schreiben in ${pfad} gescheitert: ${(fehler as Error).message}`,
        zeit,
      })
    }
  }
  const protokolliere = (e: Ereignis) => {
    if (e.art === 'run-ausgabe') {
      schreibe(`ticket-${e.ticket}-run-${e.run}.jsonl`, `${e.zeile}\n`, e.zeit)
      return
    }
    if (e.art === 'run-beendet') letzterRun = `ticket-${e.ticket}-run-${e.run}`
    if (e.art === 'pruefung' && e.ausgabe !== undefined) {
      const { ausgabe, ...ohneAusgabe } = e
      const befehl = e.name.replace(/^Check: /, '')
      const text = `$ ${befehl}\n${ausgabe}${ausgabe.endsWith('\n') ? '' : '\n'}`
      schreibe(`${letzterRun}-checks.log`, text, e.zeit)
      e = ohneAusgabe
    }
    schreibe('lauf.jsonl', `${JSON.stringify(e)}\n`, e.zeit)
  }

  return {
    pfad,
    melde: (e) => {
      protokolliere(e)
      weiter?.(e)
    },
  }
}

/** JJJJMMTT-HHMMSS in lokaler Zeit. */
function zeitstempel(d: Date): string {
  const zwei = (n: number) => String(n).padStart(2, '0')
  return (
    `${d.getFullYear()}${zwei(d.getMonth() + 1)}${zwei(d.getDate())}-` +
    `${zwei(d.getHours())}${zwei(d.getMinutes())}${zwei(d.getSeconds())}`
  )
}

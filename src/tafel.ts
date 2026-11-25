import { stripVTControlCharacters } from 'node:util'
import { anzeige, stil, uhrzeit } from './anzeige.ts'
import type { Ereignis } from './engine.ts'
import type { Ticket } from './tracker.ts'

export interface TafelOptionen {
  farbe?: boolean
  /** Ordner des Protokolls, für den Schluss. */
  protokoll?: string
}

/** Wie viele Zeilen der Mitschrift die Tafel höchstens behält; mehr passt in kein Fenster. */
const MITSCHRIFT_MAX = 1000

/**
 * Die Tafel: ein fester Bildschirm aus Kopfzeile, Task-Graph, Warnungen, der Mitschrift des
 * laufenden Runs und einer Fußzeile. `melde` nimmt jedes Ereignis des Laufs in Reihenfolge und
 * liefert die Zeilen, die die fortlaufende Ausgabe dafür schreiben würde (für den Schluss).
 */
export function tafel(optionen: TafelOptionen = {}) {
  const s = stil(optionen.farbe ?? false)
  // Ungekürzt; gekürzt wird erst beim Zeichnen, auf die Breite, die das Fenster gerade hat.
  const zeilen = anzeige({ ...optionen, breite: Number.POSITIVE_INFINITY })
  let kopf = ''
  let tickets: Ticket[] = []
  /** Zustand der Tickets, die dieser Lauf angefasst hat; die übrigen zeigen den Tracker. */
  const zustand = new Map<number, string>()
  const warnungen: string[] = []
  let mitschrift: string[] = []
  let fuss = ''
  let versuch = ''
  let run: number | undefined

  const melde = (e: Ereignis): string[] => {
    const neu = zeilen(e)
    switch (e.art) {
      case 'lauf-begonnen':
        kopf = neu[0] ?? ''
        break
      case 'task-graph':
        tickets = e.tickets
        break
      case 'versuch-begonnen':
        versuch = `Versuch ${e.versuch} von ${e.von}`
        zustand.set(e.ticket, s.cyan(`▶ läuft · ${versuch}`))
        fuss = `#${e.ticket} · ${versuch}`
        mitschrift = []
        break
      case 'run-ausgabe':
        // Ein neuer Run, auch der Neustart nach einer Pause: nur seine Mitschrift zählt.
        if (e.run !== run) {
          run = e.run
          mitschrift = []
          zustand.set(e.ticket, s.cyan(`▶ läuft · ${versuch}`))
        }
        mitschrift.push(...neu)
        if (mitschrift.length > 2 * MITSCHRIFT_MAX) mitschrift = mitschrift.slice(-MITSCHRIFT_MAX)
        break
      case 'pruefung':
        if (!e.ok) zustand.set(e.ticket, s.gelb(`↻ ${versuch} gescheitert`))
        mitschrift.push(...neu)
        break
      case 'pause':
        zustand.set(e.ticket, s.gelb(`⏸ Pause am Usage-Limit bis ${uhrzeit(e.reset, e.zeit)}`))
        mitschrift.push(...neu)
        break
      case 'run-beendet':
      case 'lauf-angehalten':
        mitschrift.push(...neu)
        break
      case 'ticket-erledigt':
        zustand.set(e.ticket, s.gruen(`✔ erledigt in Versuch ${e.versuche}`))
        break
      case 'ticket-gescheitert':
        zustand.set(e.ticket, s.rot(`✘ ready-for-human · ${e.pruefung}`))
        break
      case 'warnung':
        warnungen.push(...neu)
        break
    }
    return neu
  }

  /** Genau `hoehe` Zeilen, keine breiter als `breite`. */
  const bildschirm = (breite: number, hoehe: number): string[] => {
    const strich = s.matt('─'.repeat(breite))
    const oben = [
      kopf,
      '',
      ...tickets.map((t) => `  #${t.nummer} ${zustand.get(t.nummer) ?? vorher(t, s)}`),
      ...warnungen,
      strich,
    ].slice(0, Math.max(0, hoehe - 2))
    const platz = Math.max(0, hoehe - 2 - oben.length)
    const mitte = platz > 0 ? mitschrift.slice(-platz) : []
    while (mitte.length < platz) mitte.push('')
    return [...oben, ...mitte, strich, fuss].map((z) => kuerze(z, breite))
  }

  return { melde, bildschirm }
}

/** Zustand eines Tickets, das dieser Lauf (noch) nicht angefasst hat, aus dem Tracker. */
function vorher(t: Ticket, s: ReturnType<typeof stil>): string {
  if (!t.offen) return s.gruen('✔ erledigt')
  if (t.labels.includes('ready-for-human')) return s.matt('– ready-for-human, nicht angefasst')
  const blocker = t.blocker.filter((b) => b.offen).map((b) => `#${b.nummer}`)
  if (blocker.length > 0) return s.matt(`○ blockiert von ${blocker.join(', ')}`)
  if (!t.labels.includes('ready-for-agent')) return s.matt('– nicht freigegeben')
  return s.matt('· wartet')
}

/** Kürzt auf `breite` sichtbare Zeichen, ohne eine Farbsequenz zu zerschneiden. */
function kuerze(zeile: string, breite: number): string {
  const z = zeile.replace(/[\r\n]+/g, ' ').replace(/\t/g, '  ')
  if (stripVTControlCharacters(z).length <= breite) return z
  let rest = breite - 1
  let aus = ''
  // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI-Farbsequenzen
  for (const teil of z.split(/(\x1b\[[\d;]*m)/)) {
    if (teil.startsWith('\x1b')) aus += teil
    else if (rest < 0) continue
    else if (teil.length <= rest) {
      aus += teil
      rest -= teil.length
    } else {
      aus += `${teil.slice(0, rest)}…`
      rest = -1
    }
  }
  return aus
}

/**
 * Zeigt die Tafel im Terminal `out` (alternativer Bildschirm) und zeichnet sie bei jedem
 * Ereignis und jeder Größenänderung neu. Am Ende des Laufs kehrt sie zum normalen Bildschirm
 * zurück und schreibt dort den Schluss: Übersicht, Integration-Branch, Abschluss.
 */
export function zeigeTafel(out: NodeJS.WriteStream, protokoll?: string) {
  const t = tafel({ farbe: true, protokoll })
  let aktiv = true
  const zeichne = () => {
    const zeilen = t.bildschirm(out.columns || 100, out.rows || 30)
    if (aktiv) out.write(`\x1b[H${zeilen.join('\x1b[K\n')}\x1b[K\x1b[J`)
  }
  /** Zurück zum normalen Bildschirm; auch vor einer Fehlermeldung, damit sie sichtbar bleibt. */
  const schliesse = () => {
    if (!aktiv) return
    aktiv = false
    out.off('resize', zeichne)
    out.write('\x1b[?7h\x1b[?25h\x1b[?1049l')
  }
  // Alternativer Bildschirm, Cursor aus, kein Zeilenumbruch: Was trotz Kürzung zu breit ist
  // (doppelt breite Zeichen), schneidet das Terminal ab, statt die Tafel zu verschieben.
  out.write('\x1b[?1049h\x1b[?25l\x1b[?7l')
  out.on('resize', zeichne)
  process.once('exit', schliesse)
  const melde = (e: Ereignis) => {
    const zeilen = t.melde(e)
    if (e.art !== 'lauf-beendet') return zeichne()
    schliesse()
    for (const z of zeilen) out.write(`${z}\n`)
  }
  return { melde, schliesse }
}

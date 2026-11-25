import { hostname } from 'node:os'
import { extname, join } from 'node:path'
import { stripVTControlCharacters } from 'node:util'
import { common, createEmphasize } from 'emphasize'
import { ABSCHLUSS, type Ereignis, integrationBranch } from './engine.ts'

export interface AnzeigeOptionen {
  /** ANSI-Farben; ohne Terminal aus. */
  farbe?: boolean
  /** Spalten, auf die eine Zeile gekürzt wird. */
  breite?: number
  /** Ordner des Protokolls; die letzte Zeile nennt die Übersicht darin. */
  protokoll?: string
}

/**
 * Die Anzeige eines Laufs: macht aus jedem Ereignis der Engine die Zeilen, die darunter
 * erscheinen. Ohne Terminal werden sie fortlaufend geschrieben; die Tafel ordnet sie selbst an.
 */
export function anzeige(optionen: AnzeigeOptionen = {}): (e: Ereignis) => string[] {
  const { breite = 100 } = optionen
  const s = stil(optionen.farbe ?? false)
  const kurz = (t: string, n: number) => {
    const z = stripVTControlCharacters(t).replace(/\s+/g, ' ').trim()
    return z.length > n ? `${z.slice(0, n - 1)}…` : z
  }

  let begonnen: Extract<Ereignis, { art: 'lauf-begonnen' }> | undefined
  let integration = ''
  let uebernommen = 0
  let stand: string | undefined

  return (e) => {
    switch (e.art) {
      case 'run-ausgabe':
        return mitschrift(e.zeile).flatMap((m) => {
          if (m.art === 'text')
            return m.text
              .split('\n')
              .filter((t) => t.trim())
              .map((t) => `  │ ${kurz(t, breite - 4)}`)
          if (m.art === 'tool') {
            const argument = kurz(m.argument, breite - 8 - m.name.length)
            return [`  │ ${s.cyan('⏺')} ${s.fett(m.name)} ${s.matt(argument)}`]
          }
          if (m.art === 'ergebnis') {
            return [`  │   ${(m.fehler ? s.rot : s.matt)(`⎿ ${kurz(m.text, breite - 8)}`)}`]
          }
          return diff(m, breite - 6, s).map((z) => `  │   ${z}`)
        })
      case 'lauf-begonnen': {
        begonnen = e
        integration = integrationBranch(e.spec)
        const version = e.versionen.groundhog ? ` ${e.versionen.groundhog}` : ''
        const abschluss = ABSCHLUSS[e.auswahl.abschluss]
        return [
          s.matt(
            `groundhog${version} · Spec #${e.spec} · Ziel-Branch ${e.auswahl.zielBranch} · Abschluss ${abschluss}`,
          ),
        ]
      }
      case 'ticket-genommen':
        return ['', s.fett(`━━ #${e.ticket} genommen`)]
      case 'versuch-begonnen':
        return [`  ${s.cyan('▶')} Versuch ${e.versuch} von ${e.von}`]
      case 'run-beendet':
        // Die Begründung eines Blocks steht nur im Protokoll.
        return (e.blocks ?? []).map((b) =>
          s.gelb(`  ⛔ Block: ${kurz(`${b.tool} ${b.befehl}`, breite - 11)}`),
        )
      case 'pruefung':
        return [`  ${e.ok ? s.gruen('✔') : s.rot('✘')} ${e.name}`]
      case 'pause':
        return [s.gelb(`  ⏸ Usage-Limit erreicht, Pause bis ${uhrzeit(e.reset, e.zeit)}`)]
      case 'push':
        // Der Abschluss pusht auch in den Ziel-Branch; der Stand gilt nur dem Integration-Branch.
        if (e.branch === integration) stand = e.commit
        return [s.matt(`  ↑ ${e.branch} gepusht: ${e.commit.slice(0, 7)}`)]
      case 'ticket-erledigt':
        uebernommen++
        return [
          `${s.gruen('✔')} ${s.fett(`#${e.ticket} erledigt`)} in Versuch ${e.versuche} · Commit ${e.commit.slice(0, 7)}`,
        ]
      case 'ticket-gescheitert':
        return [
          `${s.rot('✘')} ${s.fett(`#${e.ticket} endgültig gescheitert`)} nach ${e.versuche} Versuchen (rot: ${e.pruefung}) → ready-for-human`,
        ]
      case 'warnung':
        return [s.gelb(`⚠ ${e.text}`)]
      case 'lauf-angehalten':
        return [
          s.rot(
            `■ Lauf angehalten an #${e.ticket}: Usage-Limit ohne Reset-Zeit, weiter erst mit Guthaben`,
          ),
        ]
      case 'lauf-beendet': {
        const spec = begonnen?.spec
        const ziel = begonnen?.auswahl.zielBranch
        const wahl = `Abschluss ${begonnen ? ABSCHLUSS[begonnen.auswahl.abschluss] : ''}`
        const a = e.abschluss
        const abschluss =
          a.art === 'gemergt'
            ? `${wahl}: ${integration} nach ${ziel} gemergt, Merge-Commit ${a.commit.slice(0, 7)}, Spec #${spec} geschlossen`
            : a.art === 'konflikt'
              ? `${wahl}: Konflikt mit ${ziel}, ${integration} bleibt stehen`
              : a.art === 'pr'
                ? `${wahl}: ${a.url}`
                : a.art === 'nichts'
                  ? `${wahl}: ${integration} bleibt stehen`
                  : `${wahl} entfällt, weil ${a.grund === 'abgebrochen' ? 'der Lauf abgebrochen wurde' : `${a.grund} sind`}. Nächster Lauf: groundhog ${spec}`
        const tickets =
          uebernommen === 0
            ? 'keine Tickets übernommen'
            : `${uebernommen} Ticket${uebernommen === 1 ? '' : 's'} übernommen, Stand ${stand?.slice(0, 7)}`
        const { protokoll } = optionen
        return [
          '',
          ...e.uebersicht.split('\n'),
          '',
          `Integration-Branch ${integration}: ${tickets}`,
          a.art === 'konflikt' ? s.rot(abschluss) : abschluss,
          s.matt(`Rechner: ${hostname()}${protokoll ? ` · Protokoll: ${protokoll}` : ''}`),
          ...(protokoll ? [`Übersicht: ${join(protokoll, 'uebersicht.md')}`] : []),
        ]
      }
      default:
        return []
    }
  }
}

/** HH:MM in lokaler Zeit; liegt `ms` an einem anderen Tag als `jetzt`, mit Datum davor. */
export function uhrzeit(ms: number, jetzt: number): string {
  const d = new Date(ms)
  const zeit = d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })
  if (d.toDateString() === new Date(jetzt).toDateString()) return zeit
  return `${d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' })} ${zeit}`
}

type Stil = ReturnType<typeof stil>
const hell = createEmphasize(common)

export function stil(farbe: boolean) {
  const ansi = (code: number) => (t: string) => (farbe ? `\x1b[${code}m${t}\x1b[0m` : t)
  return {
    fett: ansi(1),
    matt: ansi(2),
    rot: ansi(31),
    gruen: ansi(32),
    gelb: ansi(33),
    cyan: ansi(36),
    /** Syntaxfarben nach der Endung der Datei. */
    code: (datei: string, t: string) => {
      const sprache = extname(datei).slice(1)
      return farbe && sprache && hell.registered(sprache) ? hell.highlight(sprache, t).value : t
    },
  }
}

type Mitschrift =
  | { art: 'text'; text: string }
  | { art: 'tool'; name: string; argument: string }
  | { art: 'ergebnis'; text: string; fehler: boolean }
  | { art: 'diff'; datei: string; hunks: Hunk[] }

interface Hunk {
  oldStart: number
  newStart: number
  lines: string[]
}

const DIFF_MAX = 12

/** Ein Diff wie im Claude-Code-Fenster: Zusammenfassung, Zeilennummern, `+`/`-`. */
// ponytail: jede Zeile wird einzeln eingefärbt, mehrzeilige Strings und Kommentare stimmen dann
// nicht; für genaue Farben die ganze Datei einfärben.
function diff(d: { datei: string; hunks: Hunk[] }, breite: number, s: Stil): string[] {
  const alle = d.hunks.flatMap((h) => h.lines)
  const zahl = (z: string) => alle.filter((l) => l[0] === z).length
  const plus = zahl('+')
  const zeilen: string[] = []
  for (const h of d.hunks) {
    let alt = h.oldStart
    let neu = h.newStart
    for (const l of h.lines) {
      const code = stripVTControlCharacters(l.slice(1))
        .replace(/\r/g, '')
        .slice(0, breite - 9)
      const nr = (n: number) => String(n).padStart(4)
      if (l[0] === '+') zeilen.push(`${s.gruen(`${nr(neu++)} +`)} ${s.code(d.datei, code)}`)
      else if (l[0] === '-') zeilen.push(`${s.rot(`${nr(alt++)} -`)} ${s.matt(code)}`)
      else {
        zeilen.push(`${s.matt(`${nr(neu++)}  `)} ${s.code(d.datei, code)}`)
        alt++
      }
    }
  }
  return [
    s.matt(`⎿ ${plus} Zeile${plus === 1 ? '' : 'n'} hinzugefügt, ${zahl('-')} entfernt`),
    ...zeilen.slice(0, DIFF_MAX).map((z) => `  ${z}`),
    ...(zeilen.length > DIFF_MAX
      ? [s.matt(`       … ${zeilen.length - DIFF_MAX} weitere Zeilen`)]
      : []),
  ]
}

interface StreamZeile {
  type?: string
  message?: { content?: unknown }
  /** Bei Edit und Write: der Patch, bei neuen Dateien der Inhalt. */
  tool_use_result?: { type?: string; filePath?: string; content?: string; structuredPatch?: Hunk[] }
}
interface Inhalt {
  type?: string
  text?: string
  name?: string
  input?: Record<string, unknown>
  content?: string | { text?: string }[]
  is_error?: boolean
}

/** Liest eine Zeile `stream-json`; was keine Mitschrift ist (auch kein JSON), ergibt nichts. */
function mitschrift(zeile: string): Mitschrift[] {
  let z: StreamZeile
  try {
    z = JSON.parse(zeile)
  } catch {
    return []
  }
  const inhalte = Array.isArray(z.message?.content) ? (z.message.content as Inhalt[]) : []
  const aus: Mitschrift[] = []
  for (const c of inhalte) {
    if (z.type === 'assistant' && c.type === 'text' && c.text?.trim()) {
      aus.push({ art: 'text', text: c.text })
    }
    if (z.type === 'assistant' && c.type === 'tool_use') {
      const i = c.input ?? {}
      const argument = i.command ?? i.file_path ?? i.pattern ?? i.url ?? i.description ?? ''
      aus.push({ art: 'tool', name: c.name ?? '?', argument: String(argument) })
    }
    if (z.type === 'user' && c.type === 'tool_result') {
      const r = z.tool_use_result
      let hunks = Array.isArray(r?.structuredPatch) ? r.structuredPatch : []
      if (hunks.length === 0 && r?.type === 'create' && typeof r.content === 'string') {
        const lines = r.content
          .replace(/\n$/, '')
          .split('\n')
          .map((l) => `+${l}`)
        hunks = [{ oldStart: 1, newStart: 1, lines }]
      }
      if (hunks.length > 0) {
        aus.push({ art: 'diff', datei: r?.filePath ?? '', hunks })
        continue
      }
      const text =
        typeof c.content === 'string'
          ? c.content
          : (c.content ?? []).map((x) => x.text ?? '').join(' ')
      aus.push({ art: 'ergebnis', text, fehler: c.is_error === true })
    }
  }
  return aus
}

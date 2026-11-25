import { hostname } from 'node:os'
import type { Block } from './agent.ts'
import type { Auswahl, Ereignis } from './engine.ts'
import type { Ticket } from './tracker.ts'

const ABSCHLUSS: Record<Auswahl['abschluss'], string> = {
  mergen: 'Mergen',
  pr: 'PR',
  nichts: 'Nichts',
}

/** Die Übersicht eines Laufs als Markdown, allein aus den Ereignissen der Engine. */
export function uebersicht(ereignisse: Ereignis[]): string {
  const tickets = new Map<number, TicketVerlauf>()
  let graph: Ticket[] = []
  let begonnen: Extract<Ereignis, { art: 'lauf-begonnen' }> | undefined
  let beendet: Extract<Ereignis, { art: 'lauf-beendet' }> | undefined
  const verlauf = (nr: number) => {
    const t = tickets.get(nr) ?? {
      ergebnis: 'unterbrochen',
      beginn: 0,
      versuch: 0,
      von: 0,
      pausen: 0,
      pausiert: false,
      blocks: [],
    }
    tickets.set(nr, t)
    return t
  }

  for (const e of ereignisse) {
    switch (e.art) {
      case 'lauf-begonnen':
        begonnen = e
        break
      case 'lauf-beendet':
        beendet = e
        break
      case 'task-graph':
        graph = e.tickets
        break
      case 'ticket-genommen':
        verlauf(e.ticket).beginn = e.zeit
        break
      case 'versuch-begonnen':
        Object.assign(verlauf(e.ticket), { versuch: e.versuch, von: e.von })
        break
      case 'run-beendet': {
        const t = verlauf(e.ticket)
        t.blocks.push(...(e.blocks ?? []))
        t.sessionId = e.sessionId
        t.pausiert = false
        break
      }
      case 'pause': {
        // Nach dem Reset wartet die Engine womöglich weiter; das bleibt dieselbe Pause.
        const t = verlauf(e.ticket)
        if (!t.pausiert) t.pausen++
        t.pausiert = true
        break
      }
      case 'ticket-erledigt':
        Object.assign(verlauf(e.ticket), {
          ergebnis: 'erledigt',
          ende: e.zeit,
          zusatz: `Commit ${e.commit}`,
        })
        break
      case 'ticket-gescheitert': {
        const t = verlauf(e.ticket)
        const resume = t.sessionId ? ` · \`claude --resume ${t.sessionId}\`` : ''
        Object.assign(t, {
          ergebnis: 'gescheitert',
          ende: e.zeit,
          zusatz: `rot: ${e.pruefung}${resume}`,
        })
        break
      }
    }
  }

  const kopf: string[] = []
  if (begonnen) {
    kopf.push(`# Übersicht Spec #${begonnen.spec}`, '', `- Beginn: ${uhrzeit(begonnen.zeit)}`)
  }
  if (begonnen && beendet) {
    const a = beendet.abschluss
    const integration = `Integration-Branch spec/${begonnen.spec}`
    const was =
      a.art === 'gemergt'
        ? `gemergt, Merge-Commit ${a.commit}`
        : a.art === 'konflikt'
          ? `Konflikt, ${integration} bleibt stehen`
          : a.art === 'pr'
            ? a.url
            : a.art === 'nichts'
              ? integration
              : `nichts, weil ${a.grund}`
    kopf.push(
      `- Ende: ${uhrzeit(beendet.zeit)}`,
      `- Dauer: ${dauer(beendet.zeit - begonnen.zeit)}`,
      `- Ziel-Branch: ${begonnen.auswahl.zielBranch}`,
      `- Abschluss: ${ABSCHLUSS[begonnen.auswahl.abschluss]} → ${was}`,
    )
  }
  if (begonnen) {
    const versionen = Object.entries(begonnen.versionen).map(([name, v]) => `${name} ${v}`)
    kopf.push(`- Versionen: ${versionen.join(', ') || '–'}`)
  }

  const nummern = [...new Set([...graph.map((t) => t.nummer), ...tickets.keys()])].sort(
    (a, b) => a - b,
  )
  const zeilen = nummern.map((nr) => {
    const t = tickets.get(nr)
    if (t) {
      const ende = t.ende ?? beendet?.zeit ?? t.beginn
      const zeile = [
        `- #${nr} ${t.ergebnis}`,
        `Versuche ${t.versuch} von ${t.von}`,
        `Pausen ${t.pausen}`,
        `Dauer ${dauer(ende - t.beginn)}`,
        `Blocks ${t.blocks.length}`,
        ...(t.zusatz ? [t.zusatz] : []),
      ].join(' · ')
      return [zeile, ...t.blocks.map((b) => `  - ${b.tool}: \`${b.befehl}\``)].join('\n')
    }
    const g = graph.find((g) => g.nummer === nr)
    const offeneBlocker = g?.blocker.filter((b) => b.offen) ?? []
    if (g && !g.offen) return `- #${nr} nicht angefasst, schon geschlossen`
    if (offeneBlocker.length > 0) {
      return `- #${nr} blockiert von ${offeneBlocker.map((b) => `#${b.nummer}`).join(', ')}`
    }
    return `- #${nr} nicht angefasst`
  })

  return [...kopf, '', '## Tickets', '', ...zeilen].join('\n')
}

interface TicketVerlauf {
  /** Ohne Ende-Ereignis des Tickets ist der Lauf mittendrin zu Ende gegangen. */
  ergebnis: 'erledigt' | 'gescheitert' | 'unterbrochen'
  beginn: number
  ende?: number
  versuch: number
  /** Höchstzahl der Versuche. */
  von: number
  pausen: number
  pausiert: boolean
  blocks: Block[]
  sessionId?: string
  /** Commit oder rote Prüfung. */
  zusatz?: string
}

/** JJJJ-MM-TT HH:MM:SS in lokaler Zeit. */
function uhrzeit(ms: number): string {
  return new Date(ms).toLocaleString('sv-SE')
}

function dauer(ms: number): string {
  const s = Math.round(ms / 1000)
  const teile = [
    [Math.floor(s / 3600), 'h'],
    [Math.floor((s % 3600) / 60), 'min'],
    [s % 60, 's'],
  ] as const
  return (
    teile
      .filter(([n]) => n > 0)
      .map(([n, e]) => `${n} ${e}`)
      .join(' ') || '0 s'
  )
}

/** Der eine Kommentar an einem endgültig gescheiterten Ticket. */
export function kommentarGescheitert(t: {
  /** Die rote Prüfung jedes Versuchs. */
  rote: string[]
  versuche: number
  /** Check-Ausgabe des letzten Versuchs, schon gekürzt; fehlt, wenn kein Check rot war. */
  ausgabe?: string
  blocks: number
  sessionId?: string
  protokoll?: string
}): string {
  const teile = [
    'Endgültig gescheitert, jetzt `ready-for-human`.',
    t.rote.map((p, i) => `- Versuch ${i + 1} von ${t.versuche} rot: ${p}`).join('\n'),
  ]
  if (t.ausgabe !== undefined) {
    const zaun = '`'.repeat(Math.max(3, ...(t.ausgabe.match(/`+/g) ?? []).map((z) => z.length + 1)))
    teile.push('Check-Ausgabe des letzten Versuchs:', `${zaun}\n${t.ausgabe}\n${zaun}`)
  }
  teile.push(`Blocks: ${t.blocks}`, fundort(t.protokoll, t.sessionId))
  return teile.join('\n\n')
}

/** Wo es weitergeht: Session, Rechner und Protokoll. Nur in Kommentaren und der Ausgabe. */
export function fundort(protokoll?: string, sessionId?: string): string {
  return [
    sessionId && `- Session: \`claude --resume ${sessionId}\``,
    `- Rechner: ${hostname()}`,
    protokoll && `- Protokoll: \`${protokoll}\``,
  ]
    .filter(Boolean)
    .join('\n')
}

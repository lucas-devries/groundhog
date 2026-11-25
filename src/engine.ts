import type { Agent } from './agent.ts'
import { git } from './git.ts'
import type { Sandbox } from './sandbox.ts'
import type { Tracker } from './tracker.ts'
import type { Uhr } from './uhr.ts'

export interface Auswahl {
  zielBranch: string
  abschluss: 'mergen' | 'pr' | 'nichts'
}

export interface LaufEingabe {
  spec: number
  auswahl: Auswahl
  /** Repo-Root des Klons. */
  verzeichnis: string
  checks: string[]
  tracker: Tracker
  agent: Agent
  sandbox: Sandbox
  uhr: Uhr
  melde?: (ereignis: Ereignis) => void
}

export type Ereignis = TicketEreignis & { zeit: number }

type TicketEreignis = { ticket: number } & (
  | { art: 'ticket-genommen' }
  | { art: 'pruefung'; name: string; ok: boolean }
  | { art: 'ticket-erledigt'; commit: string }
  | { art: 'ticket-rot' }
)

export interface TicketErgebnis {
  nummer: number
  ergebnis: 'erledigt' | 'rot'
  /** Commit im Integration-Branch, nur bei erledigt. */
  commit?: string
}

export interface LaufErgebnis {
  tickets: TicketErgebnis[]
}

/** Fährt einen ganzen Lauf über die Tickets einer Spec. */
export async function fahreLauf(eingabe: LaufEingabe): Promise<LaufErgebnis> {
  const { spec, auswahl, verzeichnis, tracker, uhr } = eingabe
  const melde = (e: TicketEreignis) => eingabe.melde?.({ ...e, zeit: uhr.jetzt() })
  const integration = `spec/${spec}`
  const ergebnis: LaufErgebnis = { tickets: [] }

  git(verzeichnis, 'fetch', '-q', 'origin')
  if (!branchExistiert(verzeichnis, integration)) {
    git(verzeichnis, 'branch', '-q', '--no-track', integration, `origin/${auswahl.zielBranch}`)
  }

  while (true) {
    // ponytail: Frontier ist hier nur „offen, niedrigste Nummer“; Labels, Blocker und Assignees kommen mit #27.
    const ticket = (await tracker.taskGraph(spec))
      .filter((t) => t.offen)
      .sort((a, b) => a.nummer - b.nummer)[0]
    if (!ticket) return ergebnis
    const nr = ticket.nummer
    const ticketBranch = `ticket/${nr}`

    await tracker.beanspruche(nr)
    melde({ art: 'ticket-genommen', ticket: nr })
    git(verzeichnis, 'checkout', '-q', '-B', ticketBranch, integration)
    const fixpunkt = git(verzeichnis, 'rev-parse', 'HEAD')

    const run = await eingabe.agent.run({ ticket, verzeichnis, fixpunkt })

    const pruefungen: [string, boolean][] = [
      ['Run erfolgreich', run.erfolg],
      [`HEAD auf ${ticketBranch}`, aktuellerBranch(verzeichnis) === ticketBranch],
      [
        'neuer Commit seit Fixpunkt',
        git(verzeichnis, 'rev-list', '--count', `${fixpunkt}..${ticketBranch}`) !== '0',
      ],
      ['Arbeitsverzeichnis sauber', git(verzeichnis, 'status', '--porcelain') === ''],
    ]
    for (const [name, ok] of pruefungen) melde({ art: 'pruefung', ticket: nr, name, ok })
    let gruen = pruefungen.every(([, ok]) => ok)
    for (const check of gruen ? eingabe.checks : []) {
      const { exitCode } = await eingabe.sandbox.fuehreAus(check, { verzeichnis })
      gruen = exitCode === 0
      melde({ art: 'pruefung', ticket: nr, name: `Check: ${check}`, ok: gruen })
      if (!gruen) break
    }

    if (!gruen) {
      // ponytail: ein roter Versuch beendet den Lauf; weitere Versuche und ready-for-human kommen mit #28.
      melde({ art: 'ticket-rot', ticket: nr })
      ergebnis.tickets.push({ nummer: nr, ergebnis: 'rot' })
      return ergebnis
    }

    git(verzeichnis, 'checkout', '-q', integration)
    git(verzeichnis, 'merge', '-q', '--ff-only', ticketBranch)
    git(verzeichnis, 'push', '-q', 'origin', integration)
    git(verzeichnis, 'branch', '-q', '-D', ticketBranch)
    if (git(verzeichnis, 'ls-remote', '--heads', 'origin', ticketBranch)) {
      git(verzeichnis, 'push', '-q', 'origin', '--delete', ticketBranch)
    }
    await tracker.schliesse(nr)
    const commit = git(verzeichnis, 'rev-parse', 'HEAD')
    melde({ art: 'ticket-erledigt', ticket: nr, commit })
    ergebnis.tickets.push({ nummer: nr, ergebnis: 'erledigt', commit })
  }
}

function branchExistiert(verzeichnis: string, branch: string): boolean {
  return git(verzeichnis, 'branch', '--list', branch) !== ''
}

function aktuellerBranch(verzeichnis: string): string {
  return git(verzeichnis, 'branch', '--show-current')
}

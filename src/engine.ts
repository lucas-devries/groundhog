import type { Agent } from './agent.ts'
import { git } from './git.ts'
import type { Sandbox } from './sandbox.ts'
import type { Ticket, Tracker } from './tracker.ts'
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

/** Was aus dem Abschluss wurde. */
export type AbschlussErgebnis =
  | { art: 'gemergt'; commit: string }
  | { art: 'konflikt' }
  | { art: 'pr'; url: string }
  | { art: 'nichts' }
  | { art: 'entfaellt'; grund: 'Tickets offen' }

export interface LaufErgebnis {
  tickets: TicketErgebnis[]
  abschluss: AbschlussErgebnis
}

/** Fährt einen ganzen Lauf über die Tickets einer Spec. */
export async function fahreLauf(eingabe: LaufEingabe): Promise<LaufErgebnis> {
  const { spec, auswahl, verzeichnis, tracker, uhr } = eingabe
  const melde = (e: TicketEreignis) => eingabe.melde?.({ ...e, zeit: uhr.jetzt() })
  const integration = `spec/${spec}`
  const tickets: TicketErgebnis[] = []

  git(verzeichnis, 'fetch', '-q', 'origin')
  if (!branchExistiert(verzeichnis, integration)) {
    git(verzeichnis, 'branch', '-q', '--no-track', integration, `origin/${auswahl.zielBranch}`)
  }

  while (true) {
    const graph = await tracker.taskGraph(spec)
    const ticket = graph
      .filter((t) => bearbeitbar(t, tracker.nutzer))
      .sort((a, b) => a.nummer - b.nummer)[0]
    if (!ticket) {
      return {
        tickets,
        abschluss: await schliesseAb(
          eingabe,
          graph.every((t) => !t.offen),
        ),
      }
    }
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
      tickets.push({ nummer: nr, ergebnis: 'rot' })
      return { tickets, abschluss: { art: 'entfaellt', grund: 'Tickets offen' } }
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
    tickets.push({ nummer: nr, ergebnis: 'erledigt', commit })
  }
}

/** Der Abschluss: nur wenn alle Tickets der Spec geschlossen sind, sonst bleibt der Integration-Branch stehen. */
async function schliesseAb(
  { spec, auswahl, verzeichnis, tracker }: LaufEingabe,
  alleGeschlossen: boolean,
): Promise<AbschlussErgebnis> {
  if (!alleGeschlossen) return { art: 'entfaellt', grund: 'Tickets offen' }
  const integration = `spec/${spec}`
  const ziel = auswahl.zielBranch
  switch (auswahl.abschluss) {
    case 'mergen': {
      git(verzeichnis, 'fetch', '-q', 'origin')
      // Gemergt wird auf einem losgelösten HEAD, damit der lokale Ziel-Branch unberührt bleibt.
      git(verzeichnis, 'checkout', '-q', '--detach', `origin/${ziel}`)
      try {
        git(verzeichnis, 'merge', '-q', '--no-ff', '--no-edit', integration)
      } catch {
        // Die Engine löst nie Konflikte.
        git(verzeichnis, 'merge', '--abort')
        git(verzeichnis, 'checkout', '-q', integration)
        return { art: 'konflikt' }
      }
      const commit = git(verzeichnis, 'rev-parse', 'HEAD')
      git(verzeichnis, 'push', '-q', 'origin', `HEAD:refs/heads/${ziel}`)
      git(verzeichnis, 'checkout', '-q', integration)
      await tracker.schliesse(spec)
      return { art: 'gemergt', commit }
    }
    case 'pr': {
      const url = await tracker.erstellePr({
        kopf: integration,
        basis: ziel,
        titel: `Spec #${spec}`,
        body: `Closes #${spec}`,
      })
      await tracker.kommentiere(spec, `PR: ${url}`)
      return { art: 'pr', url }
    }
    case 'nichts':
      await tracker.kommentiere(spec, `Integration-Branch: ${integration}`)
      return { art: 'nichts' }
  }
}

/** Gehört zur Frontier: Ein mir zugewiesenes Ticket ist der Rest eines abgebrochenen Laufs. */
function bearbeitbar(t: Ticket, nutzer: string): boolean {
  return (
    t.offen &&
    t.assignees.every((a) => a === nutzer) &&
    t.labels.includes('ready-for-agent') &&
    !t.labels.includes('ready-for-human') &&
    t.blocker.every((b) => !b.offen)
  )
}

function branchExistiert(verzeichnis: string, branch: string): boolean {
  return git(verzeichnis, 'branch', '--list', branch) !== ''
}

function aktuellerBranch(verzeichnis: string): string {
  return git(verzeichnis, 'branch', '--show-current')
}

import type { Agent, RunErgebnis } from './agent.ts'
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
  /** Höchstzahl der Versuche pro Ticket. */
  versuche?: number
  tracker: Tracker
  agent: Agent
  sandbox: Sandbox
  uhr: Uhr
  melde?: (ereignis: Ereignis) => void
}

export type Ereignis = TicketEreignis & { zeit: number }

type TicketEreignis = { ticket: number } & (
  | { art: 'ticket-genommen' }
  | { art: 'versuch-begonnen'; versuch: number; von: number }
  /** Pause am Usage-Limit; `reset` ist die Reset-Zeit in ms, ohne Puffer. */
  | { art: 'pause'; reset: number }
  /** Am Usage-Limit ohne Reset-Zeit: Es geht erst mit Guthaben weiter. */
  | { art: 'lauf-angehalten'; grund: 'guthaben' }
  | { art: 'pruefung'; name: string; ok: boolean }
  | { art: 'ticket-erledigt'; commit: string; versuche: number }
  | { art: 'ticket-gescheitert'; versuche: number; pruefung: string }
)

export interface TicketErgebnis {
  nummer: number
  ergebnis: 'erledigt' | 'gescheitert'
  versuche: number
  /** Commit im Integration-Branch, nur bei erledigt. */
  commit?: string
  /** Die rote Prüfung des letzten Versuchs, nur bei gescheitert. */
  pruefung?: string
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
  /** Gesetzt, wenn der Lauf vorzeitig angehalten hat: Am Usage-Limit fehlt Guthaben. */
  angehalten?: 'guthaben'
}

const MINUTE = 60_000
const RUN_ZEITLIMIT = 60 * MINUTE
/** Für einen Durchgang aller Checks zusammen. */
const CHECKS_ZEITLIMIT = 15 * MINUTE
/** Nach dem Reset des Usage-Limits: `resetsAt` ist auf Sekunden gerundet, die Server-Uhr kann abweichen. */
const RESET_PUFFER = MINUTE

/** Fährt einen ganzen Lauf über die Tickets einer Spec. */
export async function fahreLauf(eingabe: LaufEingabe): Promise<LaufErgebnis> {
  const { spec, auswahl, verzeichnis, tracker, uhr, versuche = 3 } = eingabe
  const melde = (e: TicketEreignis) => eingabe.melde?.({ ...e, zeit: uhr.jetzt() })
  const integration = `spec/${spec}`
  const ergebnis: Omit<LaufErgebnis, 'abschluss'> = { tickets: [] }

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
      const abschluss = await schliesseAb(
        eingabe,
        graph.every((t) => !t.offen),
      )
      return { ...ergebnis, abschluss }
    }
    const nr = ticket.nummer
    const ticketBranch = `ticket/${nr}`

    await tracker.beanspruche(nr)
    melde({ art: 'ticket-genommen', ticket: nr })
    git(verzeichnis, 'checkout', '-q', '-B', ticketBranch, integration)
    const fixpunkt = git(verzeichnis, 'rev-parse', 'HEAD')
    const loescheTicketBranch = () => {
      git(verzeichnis, 'branch', '-q', '-D', ticketBranch)
      if (git(verzeichnis, 'ls-remote', '--heads', 'origin', ticketBranch)) {
        git(verzeichnis, 'push', '-q', 'origin', '--delete', ticketBranch)
      }
    }

    /** Prüft einen Versuch; liefert bei Rot die rote Prüfung und die Rückmeldung für den nächsten Run. */
    const pruefe = async (runErfolg: boolean, runAbgelaufen: boolean): Promise<Rot | undefined> => {
      const pruefungen: [string, boolean][] = [
        ['Run erfolgreich', runErfolg && !runAbgelaufen],
        [`HEAD auf ${ticketBranch}`, aktuellerBranch(verzeichnis) === ticketBranch],
        [
          'neuer Commit seit Fixpunkt',
          git(verzeichnis, 'rev-list', '--count', `${fixpunkt}..${ticketBranch}`) !== '0',
        ],
        ['Arbeitsverzeichnis sauber', git(verzeichnis, 'status', '--porcelain') === ''],
      ]
      for (const [name, ok] of pruefungen) melde({ art: 'pruefung', ticket: nr, name, ok })
      const rot = pruefungen.find(([, ok]) => !ok)
      if (rot) {
        return {
          pruefung: rot[0],
          rueckmeldung: runAbgelaufen
            ? `Der letzte Versuch war rot: Der Run wurde nach ${RUN_ZEITLIMIT / MINUTE} Minuten beendet.`
            : `Der letzte Versuch war rot: Prüfung „${rot[0]}“ nicht bestanden.`,
        }
      }
      const signal = uhr.zeitlimit(CHECKS_ZEITLIMIT)
      for (const check of eingabe.checks) {
        const { exitCode, ausgabe } = await eingabe.sandbox.fuehreAus(check, {
          verzeichnis,
          signal,
        })
        const pruefung = `Check: ${check}`
        const ok = exitCode === 0 && !signal.aborted
        melde({ art: 'pruefung', ticket: nr, name: pruefung, ok })
        if (!ok) {
          const grund = signal.aborted
            ? `wurde nach ${CHECKS_ZEITLIMIT / MINUTE} Minuten beendet (Zeitlimit für alle Checks)`
            : `endete mit Exit ${exitCode}`
          return {
            pruefung,
            rueckmeldung: `Der letzte Versuch war rot: Check \`${check}\` ${grund}.\n\n${kuerzeVonVorn(ausgabe)}`,
          }
        }
      }
      return undefined
    }

    let rot: Rot | undefined
    let versuch = 0
    while (versuch < versuche) {
      versuch++
      melde({ art: 'versuch-begonnen', ticket: nr, versuch, von: versuche })
      let run: RunErgebnis
      let signal: AbortSignal
      while (true) {
        signal = uhr.zeitlimit(RUN_ZEITLIMIT)
        run = await eingabe.agent.run({
          ticket,
          verzeichnis,
          fixpunkt,
          rueckmeldung: rot?.rueckmeldung,
          signal,
        })
        if (run.usageLimit === undefined) break
        // Usage-Limit: kein Versuch verbraucht; derselbe Versuch startet nach dem Reset neu.
        if (run.usageLimit === 'guthaben') {
          // Setzt sich nicht von selbst zurück: Ticket, Branch und Arbeitsstand bleiben stehen.
          melde({ art: 'lauf-angehalten', ticket: nr, grund: 'guthaben' })
          return {
            ...ergebnis,
            abschluss: { art: 'entfaellt', grund: 'Tickets offen' },
            angehalten: 'guthaben',
          }
        }
        let reset: number | undefined = run.usageLimit
        while (reset !== undefined) {
          melde({ art: 'pause', ticket: nr, reset })
          await uhr.warte(Math.max(0, reset - uhr.jetzt()) + RESET_PUFFER)
          reset = await eingabe.agent.erschoepftBis()
        }
      }
      rot = await pruefe(run.erfolg, signal.aborted)
      if (!rot) break
      // Hat der Agent das Ticket selbst geschlossen, gilt das nicht.
      await tracker.oeffneWieder(nr)
      if (aktuellerBranch(verzeichnis) !== ticketBranch) {
        git(verzeichnis, 'checkout', '-q', '-f', ticketBranch)
      }
    }

    if (rot) {
      git(verzeichnis, 'reset', '-q', '--hard')
      git(verzeichnis, 'clean', '-q', '-fd')
      git(verzeichnis, 'checkout', '-q', '-f', integration)
      loescheTicketBranch()
      await tracker.markiereGescheitert(nr)
      await tracker.gibFrei(nr)
      melde({ art: 'ticket-gescheitert', ticket: nr, versuche: versuch, pruefung: rot.pruefung })
      ergebnis.tickets.push({
        nummer: nr,
        ergebnis: 'gescheitert',
        versuche: versuch,
        pruefung: rot.pruefung,
      })
      continue
    }

    if (git(verzeichnis, 'rev-list', '--count', `${fixpunkt}..HEAD`) !== '1') {
      // Ausnahmefall: zu einem Commit zusammenfassen, die Messages wörtlich hintereinander.
      const messages = git(
        verzeichnis,
        'log',
        '-z',
        '--reverse',
        '--format=%B',
        `${fixpunkt}..HEAD`,
      )
        .split('\0')
        .map((m) => m.trim())
        .filter(Boolean)
      git(verzeichnis, 'reset', '-q', '--soft', fixpunkt)
      git(verzeichnis, 'commit', '-q', '-m', messages.join('\n\n'))
    }
    git(verzeichnis, 'checkout', '-q', integration)
    git(verzeichnis, 'merge', '-q', '--ff-only', ticketBranch)
    git(verzeichnis, 'push', '-q', 'origin', integration)
    loescheTicketBranch()
    await tracker.schliesse(nr)
    const commit = git(verzeichnis, 'rev-parse', 'HEAD')
    melde({ art: 'ticket-erledigt', ticket: nr, commit, versuche: versuch })
    ergebnis.tickets.push({ nummer: nr, ergebnis: 'erledigt', versuche: versuch, commit })
  }
}

interface Rot {
  pruefung: string
  rueckmeldung: string
}

/** Kürzt eine Ausgabe von vorn auf die letzten 100 Zeilen und 50 000 Zeichen. */
function kuerzeVonVorn(ausgabe: string): string {
  const zeilen = ausgabe.trimEnd().split('\n')
  let gekuerzt = zeilen.slice(-100).join('\n').slice(-50_000)
  if (gekuerzt.length < ausgabe.trimEnd().length) gekuerzt = `[gekürzt]\n${gekuerzt}`
  return gekuerzt
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

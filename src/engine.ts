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

export interface LaufErgebnis {
  tickets: TicketErgebnis[]
}

/** Fährt einen ganzen Lauf über die Tickets einer Spec. */
export async function fahreLauf(eingabe: LaufEingabe): Promise<LaufErgebnis> {
  const { spec, auswahl, verzeichnis, tracker, uhr, versuche = 3 } = eingabe
  const melde = (e: TicketEreignis) => eingabe.melde?.({ ...e, zeit: uhr.jetzt() })
  const integration = `spec/${spec}`
  const ergebnis: LaufErgebnis = { tickets: [] }

  git(verzeichnis, 'fetch', '-q', 'origin')
  if (!branchExistiert(verzeichnis, integration)) {
    git(verzeichnis, 'branch', '-q', '--no-track', integration, `origin/${auswahl.zielBranch}`)
  }

  while (true) {
    // ponytail: Frontier ist hier nur „offen, ready-for-agent, niedrigste Nummer“; Blocker und Assignees kommen mit #27.
    const ticket = (await tracker.taskGraph(spec))
      .filter((t) => t.offen && t.labels.includes('ready-for-agent'))
      .sort((a, b) => a.nummer - b.nummer)[0]
    if (!ticket) return ergebnis
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
    const pruefe = async (runErfolg: boolean): Promise<Rot | undefined> => {
      const pruefungen: [string, boolean][] = [
        ['Run erfolgreich', runErfolg],
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
          rueckmeldung: `Der letzte Versuch war rot: Prüfung „${rot[0]}“ nicht bestanden.`,
        }
      }
      for (const check of eingabe.checks) {
        const { exitCode, ausgabe } = await eingabe.sandbox.fuehreAus(check, { verzeichnis })
        const pruefung = `Check: ${check}`
        melde({ art: 'pruefung', ticket: nr, name: pruefung, ok: exitCode === 0 })
        if (exitCode !== 0) {
          return {
            pruefung,
            rueckmeldung: `Der letzte Versuch war rot: Check \`${check}\` endete mit Exit ${exitCode}.\n\n${kuerzeVonVorn(ausgabe)}`,
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
      const run = await eingabe.agent.run({
        ticket,
        verzeichnis,
        fixpunkt,
        rueckmeldung: rot?.rueckmeldung,
      })
      rot = await pruefe(run.erfolg)
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

function branchExistiert(verzeichnis: string, branch: string): boolean {
  return git(verzeichnis, 'branch', '--list', branch) !== ''
}

function aktuellerBranch(verzeichnis: string): string {
  return git(verzeichnis, 'branch', '--show-current')
}

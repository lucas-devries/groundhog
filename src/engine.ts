import type { Agent, Block, RunErgebnis } from './agent.ts'
import { git } from './git.ts'
import type { Sandbox } from './sandbox.ts'
import { type FrontierZustand, frontierZustand, type Ticket, type Tracker } from './tracker.ts'
import { fundort, kommentarGescheitert, uebersicht } from './uebersicht.ts'
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
  /** Wert des `gh`-Tokens; die Engine ersetzt ihn in Run- und Check-Ausgabe durch `***`. */
  token?: string
  /** Versionen von groundhog, `claude` und Skill-Plugin, fürs Protokoll. */
  versionen?: Record<string, string>
  /** Ordner des Protokolls, für Kommentare. */
  protokoll?: string
  tracker: Tracker
  agent: Agent
  sandbox: Sandbox
  uhr: Uhr
  melde?: (ereignis: Ereignis) => void
  /** Geordneter Abbruch: Die Engine beendet den Run, räumt auf und endet ohne Kommentar an der Spec. */
  abbruch?: AbortSignal
}

export type Ereignis = (LaufEreignis | TicketEreignis) & { zeit: number }

type LaufEreignis =
  | {
      art: 'lauf-begonnen'
      spec: number
      auswahl: Auswahl
      versionen: Record<string, string>
    }
  /** Der Task-Graph, wie die Engine ihn vor jedem Ticket und am Ende gelesen hat. */
  | { art: 'task-graph'; tickets: GraphTicket[] }
  | { art: 'push'; branch: string; commit: string }
  /** `uebersicht` als Markdown; das Protokoll legt sie als `uebersicht.md` ab. */
  | { art: 'lauf-beendet'; abschluss: AbschlussErgebnis; uebersicht: string }
  | { art: 'warnung'; text: string }

type TicketEreignis = { ticket: number } & (
  | { art: 'ticket-genommen' }
  | { art: 'versuch-begonnen'; versuch: number; von: number }
  /** Pause am Usage-Limit; `reset` ist die Reset-Zeit in ms, ohne Puffer. */
  | { art: 'pause'; reset: number }
  /** Am Usage-Limit ohne Reset-Zeit: Es geht erst mit Guthaben weiter. */
  | { art: 'lauf-angehalten'; grund: 'guthaben' }
  /** Eine Zeile der rohen Ausgabe des Runs, gefiltert. */
  | { art: 'run-ausgabe'; run: number; zeile: string }
  /** `run` zählt Runs pro Ticket im Lauf, nicht Versuche. */
  | ({ art: 'run-beendet'; run: number; versuch: number } & RunErgebnis)
  /** `befehl` und `ausgabe` nur bei Checks; die Ausgabe ungekürzt, gefiltert. */
  | { art: 'pruefung'; name: string; ok: boolean; befehl?: string; ausgabe?: string }
  /** Jede Prüfung des Versuchs bis zur ersten roten, in Reihenfolge. */
  | { art: 'versuch-beendet'; versuch: number; pruefungen: Pruefergebnis[] }
  | { art: 'ticket-erledigt'; commit: string; versuche: number }
  | { art: 'ticket-gescheitert'; versuche: number; pruefung: string }
)

/** Ein Ticket im Task-Graph, mit dem Zustand, den die Engine ihm nach der Frontier-Regel gibt. */
export interface GraphTicket extends Ticket {
  zustand: FrontierZustand
}

export interface Pruefergebnis {
  name: string
  ok: boolean
}

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
  | { art: 'entfaellt'; grund: 'Tickets offen' | 'abgebrochen' }

export interface LaufErgebnis {
  tickets: TicketErgebnis[]
  abschluss: AbschlussErgebnis
  /** Gesetzt, wenn der Lauf vorzeitig angehalten hat: Am Usage-Limit fehlt Guthaben, oder abgebrochen. */
  angehalten?: 'guthaben' | 'abgebrochen'
}

const MINUTE = 60_000
const RUN_ZEITLIMIT = 60 * MINUTE
/** Für einen Durchgang aller Checks zusammen. */
const CHECKS_ZEITLIMIT = 15 * MINUTE
/** Nach dem Reset des Usage-Limits: `resetsAt` ist auf Sekunden gerundet, die Server-Uhr kann abweichen. */
const RESET_PUFFER = MINUTE

/** Der Integration-Branch einer Spec. */
export function integrationBranch(spec: number): string {
  return `spec/${spec}`
}

/** Wirft die Engine an den Stellen, an denen sie einen Abbruch annimmt. */
class Abgebrochen extends Error {}

/** Fährt einen ganzen Lauf über die Tickets einer Spec. */
export async function fahreLauf(eingabe: LaufEingabe): Promise<LaufErgebnis> {
  const { spec, auswahl, verzeichnis, tracker, uhr, versuche = 3 } = eingabe
  const abbruch = eingabe.abbruch ?? new AbortController().signal
  const halt = () => {
    if (abbruch.aborted) throw new Abgebrochen()
  }
  /** Was die Übersicht braucht: alle Ereignisse ohne die rohe Ausgabe der Runs. */
  const verlauf: Ereignis[] = []
  const melde = (e: LaufEreignis | TicketEreignis) => {
    const ereignis = { ...e, zeit: uhr.jetzt() }
    if (ereignis.art !== 'run-ausgabe') verlauf.push(ereignis)
    eingabe.melde?.(ereignis)
  }
  // Die eine Stelle, an der das Token aus Run- und Check-Ausgabe verschwindet. Der Agent wertet
  // nur die gefilterte Zeile aus; alles, was er meldet (auch Blocks), ist damit schon gefiltert.
  const filtere = (text: string) => (eingabe.token ? text.replaceAll(eingabe.token, '***') : text)
  const integration = integrationBranch(spec)
  const ergebnis: Omit<LaufErgebnis, 'abschluss'> = { tickets: [] }
  /** Ein gescheiterter Kommentar warnt nur; der Lauf geht weiter. */
  const kommentiere = async (issue: number, text: string) => {
    try {
      await tracker.kommentiere(issue, text)
    } catch (fehler) {
      melde({
        art: 'warnung',
        text: `Kommentar an #${issue} gescheitert: ${(fehler as Error).message}`,
      })
    }
  }
  /** Reguläres Ende: Übersicht an die Spec und ins Ende-Ereignis. */
  const beende = async (abschluss: AbschlussErgebnis) => {
    const ende = { art: 'lauf-beendet', abschluss, zeit: uhr.jetzt() } as const
    const text = uebersicht([...verlauf, { ...ende, uebersicht: '' }])
    await kommentiere(spec, `${text}\n\n${fundort(eingabe.protokoll)}`)
    eingabe.melde?.({ ...ende, uebersicht: text })
  }
  melde({ art: 'lauf-begonnen', spec, auswahl, versionen: eingabe.versionen ?? {} })

  // Nach einem Abbruch zurück hierhin; ein ticket/*-Rest wird dabei gelöscht.
  let startpunkt = aktuellerBranch(verzeichnis) || git(verzeichnis, 'rev-parse', 'HEAD')
  if (startpunkt.startsWith('ticket/')) startpunkt = integration
  git(verzeichnis, 'fetch', '-q', 'origin')
  if (git(verzeichnis, 'branch', '-r', '--list', `origin/${integration}`)) {
    // Maßgeblich ist der gepushte Stand.
    git(verzeichnis, 'checkout', '-q', '--no-track', '-B', integration, `origin/${integration}`)
  } else if (!branchExistiert(verzeichnis, integration)) {
    git(verzeichnis, 'branch', '-q', '--no-track', integration, `origin/${auswahl.zielBranch}`)
  }

  /** Das beanspruchte, noch nicht fertige Ticket. */
  let genommen: number | undefined
  try {
    while (true) {
      const graph = (await tracker.taskGraph(spec)).map((t) => ({
        ...t,
        zustand: frontierZustand(t, tracker.nutzer),
      }))
      melde({ art: 'task-graph', tickets: graph })
      halt()
      const ticket = graph
        .filter((t) => t.zustand === 'bearbeitbar')
        .sort((a, b) => a.nummer - b.nummer)[0]
      if (!ticket) {
        const abschluss = await schliesseAb(
          eingabe,
          graph.every((t) => !t.offen),
          kommentiere,
          melde,
        )
        await beende(abschluss)
        return { ...ergebnis, abschluss }
      }
      const nr = ticket.nummer
      const ticketBranch = `ticket/${nr}`

      await tracker.beanspruche(nr)
      genommen = nr
      melde({ art: 'ticket-genommen', ticket: nr })
      git(verzeichnis, 'checkout', '-q', '-B', ticketBranch, integration)
      const fixpunkt = git(verzeichnis, 'rev-parse', 'HEAD')

      /**
       * Prüft einen Versuch und trägt jede Prüfung in `ergebnisse` ein; liefert bei Rot die rote
       * Prüfung und die Rückmeldung für den nächsten Run.
       */
      const pruefe = async (
        runErfolg: boolean,
        runAbgelaufen: boolean,
        ergebnisse: Pruefergebnis[],
      ): Promise<Rot | undefined> => {
        const ergebnis = (
          name: string,
          ok: boolean,
          check?: { befehl: string; ausgabe: string },
        ) => {
          ergebnisse.push({ name, ok })
          melde({ art: 'pruefung', ticket: nr, name, ok, ...check })
        }
        const pruefungen: [string, boolean][] = [
          ['Run erfolgreich', runErfolg && !runAbgelaufen],
          [`HEAD auf ${ticketBranch}`, aktuellerBranch(verzeichnis) === ticketBranch],
          [
            'neuer Commit seit Fixpunkt',
            git(verzeichnis, 'rev-list', '--count', `${fixpunkt}..${ticketBranch}`) !== '0',
          ],
          ['Arbeitsverzeichnis sauber', git(verzeichnis, 'status', '--porcelain') === ''],
        ]
        for (const [name, ok] of pruefungen) ergebnis(name, ok)
        const rot = pruefungen.find(([, ok]) => !ok)
        if (rot) {
          return {
            pruefung: rot[0],
            rueckmeldung: runAbgelaufen
              ? `Der letzte Versuch war rot: Der Run wurde nach ${RUN_ZEITLIMIT / MINUTE} Minuten beendet.`
              : `Der letzte Versuch war rot: Prüfung „${rot[0]}“ nicht bestanden.`,
          }
        }
        const zeitlimit = uhr.zeitlimit(CHECKS_ZEITLIMIT)
        const signal = AbortSignal.any([zeitlimit, abbruch])
        for (const check of eingabe.checks) {
          const ausfuehrung = await eingabe.sandbox.fuehreAus(check, { verzeichnis, signal })
          halt()
          const { exitCode } = ausfuehrung
          const ausgabe = filtere(ausfuehrung.ausgabe)
          const pruefung = `Check: ${check}`
          const ok = exitCode === 0 && !zeitlimit.aborted
          ergebnis(pruefung, ok, { befehl: check, ausgabe })
          if (!ok) {
            const grund = zeitlimit.aborted
              ? `wurde nach ${CHECKS_ZEITLIMIT / MINUTE} Minuten beendet (Zeitlimit für alle Checks)`
              : `endete mit Exit ${exitCode}`
            return {
              pruefung,
              rueckmeldung: `Der letzte Versuch war rot: Check \`${check}\` ${grund}.\n\n${kuerzeVonVorn(ausgabe)}`,
              ausgabe,
            }
          }
        }
        return undefined
      }

      let rot: Rot | undefined
      let versuch = 0
      let runs = 0
      const blocks: Block[] = []
      /** Die rote Prüfung jedes Versuchs. */
      const rote: string[] = []
      let sessionId: string | undefined
      while (versuch < versuche) {
        versuch++
        melde({ art: 'versuch-begonnen', ticket: nr, versuch, von: versuche })
        let run: RunErgebnis
        let signal: AbortSignal
        while (true) {
          // Jeder Neustart nach dem Usage-Limit ist ein eigener Run mit eigener Nummer.
          halt()
          const r = ++runs
          signal = uhr.zeitlimit(RUN_ZEITLIMIT)
          run = await eingabe.agent.run({
            ticket,
            verzeichnis,
            fixpunkt,
            rueckmeldung: rot?.rueckmeldung,
            signal: AbortSignal.any([signal, abbruch]),
            ausgabe: (roh) => {
              const zeile = filtere(roh)
              melde({ art: 'run-ausgabe', ticket: nr, run: r, zeile })
              return zeile
            },
          })
          melde({ art: 'run-beendet', ticket: nr, run: r, versuch, ...run })
          blocks.push(...(run.blocks ?? []))
          sessionId = run.sessionId
          halt()
          if (run.usageLimit === undefined) break
          // Usage-Limit: kein Versuch verbraucht; derselbe Versuch startet nach dem Reset neu.
          if (run.usageLimit === 'guthaben') {
            // Setzt sich nicht von selbst zurück: Ticket, Branch und Arbeitsstand bleiben stehen.
            const abschluss: AbschlussErgebnis = { art: 'entfaellt', grund: 'Tickets offen' }
            melde({ art: 'lauf-angehalten', ticket: nr, grund: 'guthaben' })
            await beende(abschluss)
            return { ...ergebnis, abschluss, angehalten: 'guthaben' }
          }
          let reset: number | undefined = run.usageLimit
          while (reset !== undefined) {
            melde({ art: 'pause', ticket: nr, reset })
            await uhr.warte(Math.max(0, reset - uhr.jetzt()) + RESET_PUFFER, abbruch)
            halt()
            reset = await eingabe.agent.erschoepftBis()
          }
        }
        const pruefungen: Pruefergebnis[] = []
        rot = await pruefe(run.erfolg, signal.aborted, pruefungen)
        melde({ art: 'versuch-beendet', ticket: nr, versuch, pruefungen })
        if (!rot) break
        rote.push(rot.pruefung)
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
        loescheTicketBranch(verzeichnis, ticketBranch)
        await tracker.markiereGescheitert(nr)
        await tracker.gibFrei(nr)
        await kommentiere(
          nr,
          kommentarGescheitert({
            rote,
            versuche,
            ausgabe:
              rot.ausgabe === undefined
                ? undefined
                : kuerzeVonVorn(rot.ausgabe, 'gekürzt, vollständig im Protokoll'),
            blocks: blocks.length,
            sessionId,
            protokoll: eingabe.protokoll,
          }),
        )
        melde({ art: 'ticket-gescheitert', ticket: nr, versuche: versuch, pruefung: rot.pruefung })
        genommen = undefined
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
      const commit = git(verzeichnis, 'rev-parse', 'HEAD')
      melde({ art: 'push', branch: integration, commit })
      loescheTicketBranch(verzeichnis, ticketBranch)
      await kommentiere(
        nr,
        `Erledigt: ${commit} in ${integration}, Versuch ${versuch} von ${versuche}, Blocks: ${blocks.length}`,
      )
      await tracker.schliesse(nr)
      melde({ art: 'ticket-erledigt', ticket: nr, commit, versuche: versuch })
      genommen = undefined
      ergebnis.tickets.push({ nummer: nr, ergebnis: 'erledigt', versuche: versuch, commit })
    }
  } catch (fehler) {
    if (!(fehler instanceof Abgebrochen)) throw fehler
  }

  // Geordneter Abbruch: Arbeitsstand verwerfen, Ticket freigeben, kein Kommentar an der Spec.
  if (genommen !== undefined) {
    git(verzeichnis, 'reset', '-q', '--hard')
    git(verzeichnis, 'clean', '-q', '-fd')
  }
  git(verzeichnis, 'checkout', '-q', '-f', startpunkt)
  if (genommen !== undefined) {
    loescheTicketBranch(verzeichnis, `ticket/${genommen}`)
    await tracker.gibFrei(genommen)
  }
  const abschluss: AbschlussErgebnis = { art: 'entfaellt', grund: 'abgebrochen' }
  const ende = { art: 'lauf-beendet', abschluss, zeit: uhr.jetzt() } as const
  eingabe.melde?.({ ...ende, uebersicht: uebersicht([...verlauf, { ...ende, uebersicht: '' }]) })
  return { ...ergebnis, abschluss, angehalten: 'abgebrochen' }
}

/** Löscht den Ticket-Branch lokal und auf dem Remote, soweit es ihn gibt. */
function loescheTicketBranch(verzeichnis: string, branch: string) {
  if (branchExistiert(verzeichnis, branch)) git(verzeichnis, 'branch', '-q', '-D', branch)
  if (git(verzeichnis, 'ls-remote', '--heads', 'origin', branch)) {
    git(verzeichnis, 'push', '-q', 'origin', '--delete', branch)
  }
}

interface Rot {
  pruefung: string
  rueckmeldung: string
  /** Ausgabe des roten Checks, ungekürzt, gefiltert. */
  ausgabe?: string
}

/** Kürzt eine Ausgabe von vorn auf die letzten 100 Zeilen und 50 000 Zeichen. */
function kuerzeVonVorn(ausgabe: string, vermerk = 'gekürzt'): string {
  const zeilen = ausgabe.trimEnd().split('\n')
  let gekuerzt = zeilen.slice(-100).join('\n').slice(-50_000)
  if (gekuerzt.length < ausgabe.trimEnd().length) gekuerzt = `[${vermerk}]\n${gekuerzt}`
  return gekuerzt
}

/** Der Abschluss: nur wenn alle Tickets der Spec geschlossen sind, sonst bleibt der Integration-Branch stehen. */
async function schliesseAb(
  { spec, auswahl, verzeichnis, tracker }: LaufEingabe,
  alleGeschlossen: boolean,
  kommentiere: (issue: number, text: string) => Promise<void>,
  melde: (e: LaufEreignis) => void,
): Promise<AbschlussErgebnis> {
  if (!alleGeschlossen) return { art: 'entfaellt', grund: 'Tickets offen' }
  const integration = integrationBranch(spec)
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
      melde({ art: 'push', branch: ziel, commit })
      git(verzeichnis, 'checkout', '-q', integration)
      await tracker.schliesse(spec)
      return { art: 'gemergt', commit }
    }
    case 'pr': {
      const url = await tracker.erstellePr({
        integrationBranch: integration,
        zielBranch: ziel,
        titel: `Spec #${spec}`,
        body: `Closes #${spec}`,
      })
      await kommentiere(spec, `PR: ${url}`)
      return { art: 'pr', url }
    }
    case 'nichts':
      await kommentiere(spec, `Integration-Branch: ${integration}`)
      return { art: 'nichts' }
  }
}

function branchExistiert(verzeichnis: string, branch: string): boolean {
  return git(verzeichnis, 'branch', '--list', branch) !== ''
}

function aktuellerBranch(verzeichnis: string): string {
  return git(verzeichnis, 'branch', '--show-current')
}

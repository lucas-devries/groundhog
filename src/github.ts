import { execFile } from 'node:child_process'
import { setTimeout } from 'node:timers/promises'
import { promisify } from 'node:util'
import type { Pr, Ticket, Tracker } from './tracker.ts'

const execFileP = promisify(execFile)

/** Wartezeiten vor den Wiederholungen, wenn GitHub nicht erreichbar ist: drei Wiederholungen in gut einer Minute. */
export const WARTEZEITEN = [5_000, 15_000, 45_000]

// ponytail: erkennt Netzfehler und 5xx an der Ausgabe von gh; ein unbekanntes Muster bricht ohne Wiederholung ab.
const NICHT_ERREICHBAR =
  /error connecting|dial tcp|i\/o timeout|timed out|connection reset|unexpected EOF|TLS handshake|HTTP 5\d\d/i

// ponytail: höchstens 100 Sub-Issues, Labels, Assignees und Blocker je Ticket, keine Paginierung.
const TASK_GRAPH = `query($owner: String!, $repo: String!, $spec: Int!) {
  repository(owner: $owner, name: $repo) {
    issue(number: $spec) {
      subIssues(first: 100) {
        nodes {
          number
          state
          labels(first: 100) { nodes { name } }
          assignees(first: 100) { nodes { login } }
          blockedBy(first: 100) { nodes { number state } }
        }
      }
    }
  }
}`

const START_PRUEFUNG = `query($owner: String!, $repo: String!, $spec: Int!) {
  repository(owner: $owner, name: $repo) {
    url
    defaultBranchRef { name }
    agent: label(name: "ready-for-agent") { name }
    human: label(name: "ready-for-human") { name }
    issue(number: $spec) { subIssues { totalCount } }
  }
}`

interface Nodes<T> {
  nodes: T[]
}

interface IssueKnoten {
  number: number
  state: 'OPEN' | 'CLOSED'
  labels: Nodes<{ name: string }>
  assignees: Nodes<{ login: string }>
  blockedBy: Nodes<{ number: number; state: 'OPEN' | 'CLOSED' }>
}

export interface StartPruefung {
  /** Labels aus `ready-for-agent` und `ready-for-human`, die im Repo fehlen. */
  fehlendeLabels: string[]
  subIssues: number
  defaultBranch: string
  /** `https://github.com/<owner>/<repo>` */
  url: string
}

export interface Verbindung {
  /** Arbeitsverzeichnis im Klon; `gh` liest daraus das Repo. */
  verzeichnis: string
  /** Wartet zwischen Wiederholungen. */
  warte?: (ms: number) => Promise<unknown>
}

/** Der Tracker über GitHub Issues. Alles läuft über `gh` als Unterprozess; das Token verwaltet `gh`. */
export class GitHubTracker implements Tracker {
  private constructor(
    readonly nutzer: string,
    private readonly verbindung: Verbindung,
  ) {}

  /** Liest den angemeldeten `gh`-Nutzer und liefert den Tracker. */
  static async verbinde(verbindung: Verbindung): Promise<GitHubTracker> {
    const nutzer = await gh(verbindung, ['api', 'user', '--jq', '.login'])
    return new GitHubTracker(nutzer.trim(), verbindung)
  }

  async taskGraph(spec: number): Promise<Ticket[]> {
    const antwort = await this.#graphql(TASK_GRAPH, spec)
    const knoten: IssueKnoten[] = antwort.data.repository.issue.subIssues.nodes
    return knoten.map((k) => ({
      nummer: k.number,
      offen: k.state === 'OPEN',
      labels: k.labels.nodes.map((l) => l.name),
      assignees: k.assignees.nodes.map((a) => a.login),
      blocker: k.blockedBy.nodes.map((b) => ({ nummer: b.number, offen: b.state === 'OPEN' })),
    }))
  }

  /** Prüft vor dem Lauf die beiden Labels und die Sub-Issues der Spec und liest den Default-Branch. */
  async startPruefung(spec: number): Promise<StartPruefung> {
    const { repository: r } = (await this.#graphql(START_PRUEFUNG, spec)).data
    return {
      fehlendeLabels: [
        ...(r.agent ? [] : ['ready-for-agent']),
        ...(r.human ? [] : ['ready-for-human']),
      ],
      subIssues: r.issue.subIssues.totalCount,
      defaultBranch: r.defaultBranchRef.name,
      url: r.url,
    }
  }

  async beanspruche(ticket: number) {
    await this.#gh(['issue', 'edit', String(ticket), '--add-assignee', this.nutzer])
  }

  async gibFrei(ticket: number) {
    await this.#gh(['issue', 'edit', String(ticket), '--remove-assignee', this.nutzer])
  }

  /** `gh` meldet ein schon geschlossenes Issue nur als Warnung. */
  async schliesse(issue: number) {
    await this.#gh(['issue', 'close', String(issue)])
  }

  /** `gh` meldet ein schon offenes Issue nur als Warnung. */
  async oeffneWieder(ticket: number) {
    await this.#gh(['issue', 'reopen', String(ticket)])
  }

  async markiereGescheitert(ticket: number) {
    await this.#gh([
      'issue',
      'edit',
      String(ticket),
      '--remove-label',
      'ready-for-agent',
      '--add-label',
      'ready-for-human',
    ])
  }

  // ponytail: Kommentar und PR werden bei Netzfehlern wiederholt; kam der erste Versuch doch an, gibt es sie doppelt.
  async kommentiere(issue: number, text: string) {
    await this.#gh(['issue', 'comment', String(issue), '--body-file', '-'], text)
  }

  async erstellePr({ kopf, basis, titel, body }: Pr): Promise<string> {
    const args = ['pr', 'create', '--head', kopf, '--base', basis, '--title', titel]
    return (await this.#gh([...args, '--body-file', '-'], body)).trim()
  }

  async #graphql(query: string, spec: number) {
    const args = ['api', 'graphql', '-F', 'owner={owner}', '-F', 'repo={repo}']
    return JSON.parse(await this.#gh([...args, '-F', `spec=${spec}`, '-f', `query=${query}`]))
  }

  #gh(args: string[], eingabe?: string) {
    return gh(this.verbindung, args, eingabe)
  }
}

/** Ruft `gh` auf; ist GitHub nicht erreichbar, nach den WARTEZEITEN erneut, danach mit Fehler. */
async function gh(
  { verzeichnis, warte = setTimeout }: Verbindung,
  args: string[],
  eingabe = '',
): Promise<string> {
  for (let versuch = 0; ; versuch++) {
    try {
      const lauf = execFileP('gh', args, { cwd: verzeichnis, encoding: 'utf8' })
      lauf.child.stdin?.end(eingabe)
      return (await lauf).stdout
    } catch (fehler) {
      const stderr = String((fehler as { stderr?: string }).stderr ?? '').trim()
      const wartezeit = WARTEZEITEN[versuch]
      if (wartezeit === undefined || !NICHT_ERREICHBAR.test(stderr)) {
        throw new Error(`gh ${args.slice(0, 2).join(' ')} ist gescheitert: ${stderr || fehler}`)
      }
      await warte(wartezeit)
    }
  }
}

import { spawn } from 'node:child_process'
import { setTimeout } from 'node:timers/promises'
import { type Pr, READY_FOR_AGENT, READY_FOR_HUMAN, type Ticket, type Tracker } from './tracker.ts'

/** Delays before the retries when GitHub is unreachable: three retries in a little over a minute. */
export const RETRY_DELAYS = [5_000, 15_000, 45_000]

// ponytail: recognises network errors and 5xx by gh's output; an unknown pattern aborts without retry.
const UNREACHABLE =
  /error connecting|dial tcp|i\/o timeout|timed out|connection reset|unexpected EOF|TLS handshake|HTTP 5\d\d/i

// ponytail: at most 100 sub-issues, labels, assignees and blockers per ticket, no pagination.
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

const START_CHECK = `query($owner: String!, $repo: String!, $spec: Int!) {
  repository(owner: $owner, name: $repo) {
    url
    agent: label(name: "${READY_FOR_AGENT}") { name }
    human: label(name: "${READY_FOR_HUMAN}") { name }
    issue(number: $spec) { subIssues { totalCount } }
  }
}`

// shortcut: at most 100 open issues, no pagination.
const OPEN_ISSUES = `query($owner: String!, $repo: String!) {
  repository(owner: $owner, name: $repo) {
    issues(states: OPEN, first: 100, orderBy: {field: CREATED_AT, direction: ASC}) {
      nodes { number title subIssues { totalCount } }
    }
  }
}`

interface Nodes<T> {
  nodes: T[]
}

interface IssueNode {
  number: number
  state: 'OPEN' | 'CLOSED'
  labels: Nodes<{ name: string }>
  assignees: Nodes<{ login: string }>
  blockedBy: Nodes<{ number: number; state: 'OPEN' | 'CLOSED' }>
}

interface OpenIssueNode {
  number: number
  title: string
  subIssues: { totalCount: number }
}

export interface StartCheck {
  /** Labels out of `ready-for-agent` and `ready-for-human` that are missing in the repo. */
  missingLabels: string[]
  subIssues: number
  /** `https://github.com/<owner>/<repo>` */
  url: string
}

export interface OpenIssue {
  number: number
  title: string
  /** Number of native sub-issues; a spec has at least one. */
  subIssues: number
}

export interface Connection {
  /** Working directory in the clone; `gh` reads the repo from it. */
  directory: string
  /** Waits between retries. */
  wait?: (ms: number) => Promise<unknown>
}

/** The tracker over GitHub Issues. Everything goes through `gh` as a subprocess; `gh` manages the token. */
export class GitHubTracker implements Tracker {
  private constructor(
    readonly user: string,
    private readonly connection: Connection,
  ) {}

  /** Reads the logged-in `gh` user and returns the tracker. */
  static async connect(connection: Connection): Promise<GitHubTracker> {
    const user = await gh(connection, ['api', 'user', '--jq', '.login'])
    return new GitHubTracker(user.trim(), connection)
  }

  async taskGraph(spec: number): Promise<Ticket[]> {
    const answer = await this.#graphql(TASK_GRAPH, spec)
    const nodes: IssueNode[] = answer.data.repository.issue.subIssues.nodes
    return nodes.map((n) => ({
      number: n.number,
      open: n.state === 'OPEN',
      labels: n.labels.nodes.map((l) => l.name),
      assignees: n.assignees.nodes.map((a) => a.login),
      blockers: n.blockedBy.nodes.map((b) => ({ number: b.number, open: b.state === 'OPEN' })),
    }))
  }

  /** Checks the two labels and the spec's sub-issues before the run and reads the repo URL. */
  async startCheck(spec: number): Promise<StartCheck> {
    const { repository: r } = (await this.#graphql(START_CHECK, spec)).data
    return {
      missingLabels: [...(r.agent ? [] : [READY_FOR_AGENT]), ...(r.human ? [] : [READY_FOR_HUMAN])],
      subIssues: r.issue.subIssues.totalCount,
      url: r.url,
    }
  }

  async openIssues(): Promise<OpenIssue[]> {
    const { repository } = (await this.#graphql(OPEN_ISSUES)).data
    const { nodes }: Nodes<OpenIssueNode> = repository.issues
    return nodes.map(({ number, title, subIssues }) => ({
      number,
      title,
      subIssues: subIssues.totalCount,
    }))
  }

  async claim(ticket: number) {
    await this.#gh(['issue', 'edit', String(ticket), '--add-assignee', this.user])
  }

  async release(ticket: number) {
    await this.#gh(['issue', 'edit', String(ticket), '--remove-assignee', this.user])
  }

  /** `gh` reports an already closed issue only as a warning. */
  async close(issue: number) {
    await this.#gh(['issue', 'close', String(issue)])
  }

  /** `gh` reports an already open issue only as a warning. */
  async reopen(ticket: number) {
    await this.#gh(['issue', 'reopen', String(ticket)])
  }

  async markFailed(ticket: number) {
    await this.#gh([
      'issue',
      'edit',
      String(ticket),
      '--remove-label',
      READY_FOR_AGENT,
      '--add-label',
      READY_FOR_HUMAN,
    ])
  }

  // ponytail: comment and PR are retried on network errors; if the first attempt did arrive, they exist twice.
  async comment(issue: number, text: string) {
    await this.#gh(['issue', 'comment', String(issue), '--body-file', '-'], text)
  }

  async createPr({ integrationBranch, targetBranch, title, body }: Pr): Promise<string> {
    const args = [
      'pr',
      'create',
      '--head',
      integrationBranch,
      '--base',
      targetBranch,
      '--title',
      title,
    ]
    return (await this.#gh([...args, '--body-file', '-'], body)).trim()
  }

  async #graphql(query: string, spec?: number) {
    const args = ['api', 'graphql', '-F', 'owner={owner}', '-F', 'repo={repo}']
    if (spec !== undefined) args.push('-F', `spec=${spec}`)
    return JSON.parse(await this.#gh([...args, '-f', `query=${query}`]))
  }

  #gh(args: string[], input?: string) {
    return gh(this.connection, args, input)
  }
}

/** Calls `gh`; if GitHub is unreachable, again after the RETRY_DELAYS, then with an error. */
async function gh(
  { directory, wait = setTimeout }: Connection,
  args: string[],
  input = '',
): Promise<string> {
  for (let retry = 0; ; retry++) {
    try {
      return await ghProcess(directory, args, input)
    } catch (error) {
      const stderr = String((error as { stderr?: string }).stderr ?? '').trim()
      const delay = RETRY_DELAYS[retry]
      if (delay === undefined || !UNREACHABLE.test(stderr)) {
        throw new Error(`gh ${args.slice(0, 2).join(' ')} failed: ${stderr || error}`)
      }
      await wait(delay)
    }
  }
}

/**
 * One call of `gh`; returns stdout, throws on exit ≠ 0 with `stderr`. Runs in its own process
 * group: the first Ctrl+C aborts nothing, so it must not hit `gh` either.
 */
function ghProcess(directory: string, args: string[], input: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('gh', args, { cwd: directory, stdio: 'pipe', detached: true })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8').on('data', (d) => {
      stdout += d
    })
    child.stderr.setEncoding('utf8').on('data', (d) => {
      stderr += d
    })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolve(stdout)
      else reject(Object.assign(new Error(`Exit ${code}`), { stderr }))
    })
    // A `gh` that ends without reading its stdin breaks the pipe; its exit code tells the outcome.
    child.stdin.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code !== 'EPIPE') reject(error)
    })
    child.stdin.end(input)
  })
}

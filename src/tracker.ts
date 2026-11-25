/** Release for the agent. */
export const READY_FOR_AGENT = 'ready-for-agent'
/** Needs a human; the agent doesn't touch it. */
export const READY_FOR_HUMAN = 'ready-for-human'

export interface Ticket {
  number: number
  open: boolean
  labels: string[]
  assignees: string[]
  /** All blockers, including those outside the spec, with their state. */
  blockers: Blocker[]
}

export interface Blocker {
  number: number
  open: boolean
}

/** Whether a ticket belongs to the frontier (`workable`), otherwise the reason against it. */
export type FrontierState =
  | 'workable'
  | 'closed'
  | 'ready-for-human'
  | 'not released'
  | 'blocked'
  /** Assigned to someone else. */
  | 'taken'

/**
 * The frontier rule, in one place. A ticket assigned to the own `user` is the remnant of an
 * aborted run and stays workable.
 */
export function frontierState(t: Ticket, user: string): FrontierState {
  if (!t.open) return 'closed'
  if (t.labels.includes(READY_FOR_HUMAN)) return 'ready-for-human'
  if (!t.labels.includes(READY_FOR_AGENT)) return 'not released'
  if (t.blockers.some((b) => b.open)) return 'blocked'
  if (!t.assignees.every((a) => a === user)) return 'taken'
  return 'workable'
}

/** The tracker in the shape the engine needs. Behind it: GitHub adapter (#32), in-memory tracker. */
export interface Tracker {
  /** The logged-in user the engine claims for. */
  readonly user: string
  taskGraph(spec: number): Promise<Ticket[]>
  claim(ticket: number): Promise<void>
  /** Closes a ticket or the spec. */
  close(issue: number): Promise<void>
  /** Removes the own assignee from the ticket again. */
  release(ticket: number): Promise<void>
  /** Reopens the ticket; if it is open, nothing happens. */
  reopen(ticket: number): Promise<void>
  /** Swaps `ready-for-agent` for `ready-for-human`. */
  markFailed(ticket: number): Promise<void>
  comment(issue: number, text: string): Promise<void>
  /** Creates a PR and returns its URL. */
  createPr(pr: Pr): Promise<string>
}

export interface Pr {
  /** Branch with the work. */
  integrationBranch: string
  /** Branch the PR merges into. */
  targetBranch: string
  title: string
  body: string
}

/** Tracker in memory for tests. `user` plays the logged-in `gh` user. */
export class InMemoryTracker implements Tracker {
  readonly #tickets: Ticket[]
  /** Closed issues outside the tickets, such as the spec. */
  readonly #closed = new Set<number>()
  readonly #comments = new Map<number, string[]>()
  /** Created PRs in order. */
  readonly prs: Pr[] = []

  constructor(
    readonly user: string,
    tickets: Ticket[],
  ) {
    this.#tickets = structuredClone(tickets)
  }

  /** State of a ticket, as a copy. */
  ticket(number: number): Ticket {
    return structuredClone(this.#find(number))
  }

  /** Whether a ticket or another issue (such as the spec) is open. */
  isOpen(number: number): boolean {
    return this.#tickets.find((t) => t.number === number)?.open ?? !this.#closed.has(number)
  }

  comments(number: number): string[] {
    return [...(this.#comments.get(number) ?? [])]
  }

  /** Changes a ticket from outside, like a human in the tracker during the run. */
  change(number: number, change: (ticket: Ticket) => void) {
    change(this.#find(number))
  }

  /** Blockers from the spec carry the state of their ticket; the others the one given. */
  async taskGraph(): Promise<Ticket[]> {
    return structuredClone(this.#tickets).map((t) => ({
      ...t,
      blockers: t.blockers.map((b) => ({
        number: b.number,
        open: this.#tickets.find((s) => s.number === b.number)?.open ?? b.open,
      })),
    }))
  }

  async claim(number: number) {
    const ticket = this.#find(number)
    if (!ticket.assignees.includes(this.user)) ticket.assignees.push(this.user)
  }

  async close(number: number) {
    const ticket = this.#tickets.find((t) => t.number === number)
    if (ticket) ticket.open = false
    else this.#closed.add(number)
  }

  async comment(number: number, text: string) {
    this.#comments.set(number, [...this.comments(number), text])
  }

  async createPr(pr: Pr) {
    this.prs.push(pr)
    return `https://github.example/pull/${this.prs.length}`
  }

  async release(number: number) {
    const ticket = this.#find(number)
    ticket.assignees = ticket.assignees.filter((a) => a !== this.user)
  }

  async reopen(number: number) {
    this.#find(number).open = true
  }

  async markFailed(number: number) {
    const ticket = this.#find(number)
    ticket.labels = [...ticket.labels.filter((l) => l !== READY_FOR_AGENT), READY_FOR_HUMAN]
  }

  #find(number: number): Ticket {
    const ticket = this.#tickets.find((t) => t.number === number)
    if (!ticket) throw new Error(`Ticket #${number} does not exist`)
    return ticket
  }
}

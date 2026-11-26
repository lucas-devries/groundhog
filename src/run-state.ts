import type { Block, SessionResult } from './agent.ts'
import { type Choice, integrationBranch } from './choice.ts'
import type { FrontierState, Ticket } from './tracker.ts'

export type Event = (RunEvent | TicketEvent) & { time: number }

export type RunEvent =
  | {
      type: 'run-started'
      spec: number
      choice: Choice
      /** For the resume line in summary and comment. */
      worktree: string
      versions: Record<string, string>
    }
  /** The task-graph, as the engine read it before each ticket and at the end. */
  | { type: 'task-graph'; tickets: GraphTicket[] }
  | { type: 'push'; branch: string; commit: string }
  /** `summary` as Markdown; the log stores it as `summary.md`. */
  | { type: 'run-finished'; finish: FinishResult; summary: string }
  | { type: 'warning'; text: string }
  /** `setup` failed, before any ticket. */
  | ({ type: 'run-halted'; reason: 'setup' } & CommandOutput)

export type TicketEvent = { ticket: number } & (
  | { type: 'ticket-taken' }
  | { type: 'attempt-started'; attempt: number; of: number }
  /** Pause at the usage limit; `reset` is the reset time in ms, without buffer. */
  | { type: 'pause'; reset: number }
  /** At the usage limit without a reset time: it only goes on with credit. */
  | { type: 'run-halted'; reason: 'credit' }
  /** A line of the session's raw output, filtered. */
  | { type: 'session-output'; session: number; line: string }
  /** `session` counts sessions per ticket in the run, not attempts. */
  | ({ type: 'session-finished'; session: number; attempt: number } & SessionResult)
  /** `command` and `output` only for checks; the output untruncated, filtered. */
  | { type: 'verification'; name: string; ok: boolean; command?: string; output?: string }
  /** Every verification of the attempt up to the first red one, in order. */
  | { type: 'attempt-finished'; attempt: number; verifications: VerificationResult[] }
  | { type: 'ticket-done'; commit: string; attempts: number }
  | { type: 'ticket-failed'; attempts: number; verification: string }
)

/** A command of the project config and its output, filtered. */
export interface CommandOutput {
  command: string
  output: string
}

/** A ticket in the task-graph, with the state the engine gives it by the frontier rule. */
export interface GraphTicket extends Ticket {
  state: FrontierState
}

export interface VerificationResult {
  name: string
  ok: boolean
}

/** What became of the finish. */
export type FinishResult =
  | { type: 'merged'; commit: string }
  | { type: 'conflict' }
  | { type: 'pr'; url: string }
  | { type: 'none' }
  | { type: 'skipped'; reason: 'tickets open' | 'setup failed' | 'aborted' }

/** What the events of a run say about it so far. */
export interface RunState {
  /** The `run-started` event; its time is the start of the run. */
  started?: Extract<Event, { type: 'run-started' }>
  /** The `run-finished` event; its time is the end of the run. */
  finished?: Extract<Event, { type: 'run-finished' }>
  /** The latest task-graph. */
  graph: GraphTicket[]
  /** Share of closed tickets in the latest task-graph, in percent; 0 before the first one. */
  progress: number
  /** The integration branch of the run; empty before its start. */
  integration: string
  /** The commit last pushed to the integration branch. */
  head?: string
  /** The tickets the run has touched, by number. */
  tickets: Map<number, TicketState>
  /** The session that finished last. */
  lastSession?: { ticket: number; session: number }
}

/** What the events of a run say about one of its tickets. */
export interface TicketState {
  /** Missing as long as the ticket is only taken: no attempt has started yet. */
  status?: 'running' | 'attempt-failed' | 'paused' | 'done' | 'failed'
  /** When the ticket was taken. */
  start: number
  /** When the ticket was done or failed for good. */
  end?: number
  /** The current attempt, counted from 1; 0 before the first one. */
  attempt: number
  /** Maximum number of attempts. */
  of: number
  /** How often the ticket paused at the usage limit. */
  pauses: number
  /** The latest pause: the reset time and when the pause was reported. */
  pause?: { reset: number; time: number }
  /** The blocks of all sessions, in order. */
  blocks: Block[]
  /** The Claude session of the latest session, for resuming it. */
  sessionId?: string
  /** Commit in the integration branch, once done. */
  commit?: string
  /** The red verification of the last attempt, once failed for good. */
  verification?: string
}

/** The state before the first event; `graph` is what is known of the tickets until then. */
export function newRunState(graph: GraphTicket[] = []): RunState {
  return { graph, progress: 0, integration: '', tickets: new Map() }
}

/**
 * Takes the next event of a run into its state, and returns that state. The one place where facts
 * are derived from events.
 */
export function fold(state: RunState, e: Event): RunState {
  switch (e.type) {
    case 'run-started':
      state.started = e
      state.integration = integrationBranch(e.spec)
      break
    case 'task-graph': {
      state.graph = e.tickets
      const closed = e.tickets.filter((t) => !t.open).length
      state.progress = e.tickets.length ? Math.round((closed / e.tickets.length) * 100) : 100
      break
    }
    case 'push':
      // The finish pushes to the target branch too; the head only tracks the integration branch.
      if (e.branch === state.integration) state.head = e.commit
      break
    case 'run-finished':
      state.finished = e
      break
    case 'warning':
      break
    case 'run-halted':
      // A halt ends the run; the ticket it halted at stays as it is.
      break
    default:
      foldTicket(state, e)
  }
  return state
}

function foldTicket(
  state: RunState,
  e: Extract<Event, { ticket: number; type: Exclude<TicketEvent['type'], 'run-halted'> }>,
) {
  const t = state.tickets.get(e.ticket) ?? {
    start: 0,
    attempt: 0,
    of: 0,
    pauses: 0,
    blocks: [],
  }
  state.tickets.set(e.ticket, t)
  switch (e.type) {
    case 'ticket-taken':
      t.start = e.time
      break
    case 'attempt-started':
      Object.assign(t, { status: 'running', attempt: e.attempt, of: e.of })
      break
    case 'session-output':
      // Also ends a pause: the attempt restarted in a new session.
      t.status = 'running'
      break
    case 'session-finished':
      state.lastSession = { ticket: e.ticket, session: e.session }
      t.blocks.push(...(e.blocks ?? []))
      t.sessionId = e.sessionId
      if (t.status === 'paused') t.status = 'running'
      break
    case 'pause':
      // After the reset the engine may keep waiting; that stays the same pause.
      if (t.status !== 'paused') t.pauses++
      t.status = 'paused'
      t.pause = { reset: e.reset, time: e.time }
      break
    case 'verification':
      if (!e.ok) t.status = 'attempt-failed'
      break
    case 'ticket-done':
      Object.assign(t, { status: 'done', attempt: e.attempts, commit: e.commit, end: e.time })
      break
    case 'ticket-failed':
      Object.assign(t, {
        status: 'failed',
        attempt: e.attempts,
        verification: e.verification,
        end: e.time,
      })
      break
  }
}

import type { Block, SessionResult } from './agent.ts'
import { integrationBranch, ticketBranchOf } from './choice.ts'
import { MINUTE } from './clock.ts'
import type {
  CommandOutput,
  RunEvent,
  RunInput,
  TicketEvent,
  VerificationResult,
} from './engine.ts'
import { branchExists, git } from './git.ts'
import { failedComment, truncateFromStart } from './summary.ts'
import type { Ticket } from './tracker.ts'

/** What the ticket flow takes from its run. */
export interface RunContext
  extends Pick<
    RunInput,
    'spec' | 'worktree' | 'checks' | 'logDir' | 'tracker' | 'agent' | 'sandbox' | 'clock'
  > {
  /** Maximum number of attempts per ticket. */
  maxAttempts: number
  abort: AbortSignal
  report: (e: RunEvent | TicketEvent) => void
  /** Replaces the token with `***`. */
  filter: (text: string) => string
  /** A failed comment only warns; it never throws. */
  comment: (issue: number, text: string) => Promise<void>
  /** Throws away the work in the worktree. */
  discard: () => void
}

/** How a ticket ended. */
export type TicketOutcome =
  | { result: 'done'; attempts: number; commit: string }
  | { result: 'failed'; attempts: number; verification: string }
  /** Without credit, ticket, branch and work stay in place; an abort removes them. */
  | { result: 'halted'; reason: 'credit' | 'aborted' }

const SESSION_TIME_LIMIT = 60 * MINUTE
/** For one pass of all checks together. */
const CHECKS_TIME_LIMIT = 15 * MINUTE
/** After the usage limit reset: `resetsAt` is rounded to seconds, the server clock may differ. */
const RESET_BUFFER = MINUTE

/** One ticket on its way through the flow. */
interface Flow {
  run: RunContext
  ticket: Ticket
  branch: string
  forkPoint: string
  /** Every session of the ticket so far, in order. */
  sessions: SessionResult[]
}

/** A session that used up an attempt. */
interface SessionEnd {
  success: boolean
  timedOut: boolean
}

interface Red {
  verification: string
  feedback: string
  /** Output of the red check, untruncated, filtered. */
  output?: string
}

/** Thrown at the places where the flow accepts an abort. */
class Aborted extends Error {}

/**
 * Takes a claimed ticket through its attempts. A green one is integrated and closed, one without a
 * green attempt is handed to a human.
 */
export async function ticketFlow(ticket: Ticket, run: RunContext): Promise<TicketOutcome> {
  const { worktree } = run
  const branch = ticketBranchOf(ticket.number)
  git(worktree, 'checkout', '-q', '-B', branch, integrationBranch(run.spec))
  const forkPoint = git(worktree, 'rev-parse', 'HEAD')
  const flow: Flow = { run, ticket, branch, forkPoint, sessions: [] }
  try {
    return await attempts(flow)
  } catch (error) {
    if (!(error instanceof Aborted)) throw error
  }
  // Orderly abort: discard the work and release the ticket.
  drop(flow)
  await run.tracker.release(ticket.number)
  return { result: 'halted', reason: 'aborted' }
}

async function attempts(flow: Flow): Promise<TicketOutcome> {
  const { run, ticket, branch } = flow
  const { worktree, maxAttempts } = run
  const reds: Red[] = []
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    run.report({ type: 'attempt-started', ticket: ticket.number, attempt, of: maxAttempts })
    const ended = await session(flow, attempt, reds.at(-1)?.feedback)
    if (ended === 'credit') return { result: 'halted', reason: 'credit' }
    const red = await verify(flow, attempt, ended)
    if (!red) return integrate(flow, attempt)
    reds.push(red)
    // If the agent closed the ticket itself, that doesn't count.
    await run.tracker.reopen(ticket.number)
    if (currentBranch(worktree) !== branch) git(worktree, 'checkout', '-q', '-f', branch)
  }
  return fail(flow, reds)
}

/** Runs the session of an attempt, again after every reset of the usage limit. */
async function session(
  flow: Flow,
  attempt: number,
  feedback: string | undefined,
): Promise<SessionEnd | 'credit'> {
  const { run, ticket, forkPoint, sessions } = flow
  const nr = ticket.number
  while (true) {
    // Every restart after the usage limit is a session of its own with its own number.
    throwIfAborted(run)
    const number = sessions.length + 1
    const timeout = run.clock.timeout(SESSION_TIME_LIMIT)
    const result = await run.agent.runSession({
      ticket,
      directory: run.worktree,
      forkPoint,
      feedback,
      signal: AbortSignal.any([timeout, run.abort]),
      output: (raw) => {
        const line = run.filter(raw)
        run.report({ type: 'session-output', ticket: nr, session: number, line })
        return line
      },
    })
    sessions.push(result)
    run.report({ type: 'session-finished', ticket: nr, session: number, attempt, ...result })
    throwIfAborted(run)
    if (result.usageLimit === undefined) {
      return { success: result.success, timedOut: timeout.aborted }
    }
    // Usage limit: no attempt used up; the same attempt restarts after the reset.
    if (result.usageLimit === 'credit') {
      // Doesn't reset by itself.
      run.report({ type: 'run-halted', ticket: nr, reason: 'credit' })
      return 'credit'
    }
    await pause(flow, result.usageLimit)
  }
}

/** Waits until no window of the usage limit is exhausted any more. */
async function pause({ run, ticket }: Flow, until: number): Promise<void> {
  let reset: number | undefined = until
  while (reset !== undefined) {
    run.report({ type: 'pause', ticket: ticket.number, reset })
    await run.clock.wait(Math.max(0, reset - run.clock.now()) + RESET_BUFFER, run.abort)
    throwIfAborted(run)
    reset = await run.agent.exhaustedUntil()
  }
}

/** Verifies an attempt; on red, returns the red verification and the feedback. */
async function verify(flow: Flow, attempt: number, ended: SessionEnd): Promise<Red | undefined> {
  const { run, ticket } = flow
  const results: VerificationResult[] = []
  const record: Recorder = (name, ok, check) => {
    results.push({ name, ok })
    run.report({ type: 'verification', ticket: ticket.number, name, ok, ...check })
  }
  const red = verifySession(flow, ended, record) ?? (await runChecks(run, record))
  run.report({ type: 'attempt-finished', ticket: ticket.number, attempt, verifications: results })
  return red
}

type Recorder = (name: string, ok: boolean, check?: CommandOutput) => void

/** The verifications of the session and what it left in the worktree. */
function verifySession(
  { run, branch, forkPoint }: Flow,
  { success, timedOut }: SessionEnd,
  record: Recorder,
): Red | undefined {
  const { worktree } = run
  const verifications: [string, boolean][] = [
    ['Session successful', success && !timedOut],
    [`HEAD on ${branch}`, currentBranch(worktree) === branch],
    [
      'new commit since fork point',
      git(worktree, 'rev-list', '--count', `${forkPoint}..${branch}`) !== '0',
    ],
    ['working tree clean', git(worktree, 'status', '--porcelain') === ''],
  ]
  for (const [name, ok] of verifications) record(name, ok)
  const red = verifications.find(([, ok]) => !ok)
  if (!red) return undefined
  return {
    verification: red[0],
    feedback: timedOut
      ? `The last attempt was red: the session was ended after ${SESSION_TIME_LIMIT / MINUTE} minutes.`
      : `The last attempt was red: verification "${red[0]}" not passed.`,
  }
}

/** Runs the checks in order, up to the first red one. */
async function runChecks(run: RunContext, record: Recorder): Promise<Red | undefined> {
  const timeout = run.clock.timeout(CHECKS_TIME_LIMIT)
  const signal = AbortSignal.any([timeout, run.abort])
  for (const check of run.checks) {
    const execution = await run.sandbox.execute(check, { directory: run.worktree, signal })
    throwIfAborted(run)
    const { exitCode } = execution
    const output = run.filter(execution.output)
    const verification = `Check: ${check}`
    const ok = exitCode === 0 && !timeout.aborted
    record(verification, ok, { command: check, output })
    if (!ok) {
      const reason = timeout.aborted
        ? `was ended after ${CHECKS_TIME_LIMIT / MINUTE} minutes (time limit for all checks)`
        : `ended with exit ${exitCode}`
      return {
        verification,
        feedback: `The last attempt was red: check \`${check}\` ${reason}.\n\n${truncateFromStart(output)}`,
        output,
      }
    }
  }
  return undefined
}

/** Lands a green ticket as one commit in the integration branch, pushes it and closes it. */
async function integrate(flow: Flow, attempts: number): Promise<TicketOutcome> {
  const { run, ticket, branch, forkPoint } = flow
  const { worktree, tracker } = run
  const nr = ticket.number
  const integration = integrationBranch(run.spec)
  if (git(worktree, 'rev-list', '--count', `${forkPoint}..HEAD`) !== '1') {
    // Exceptional case: squash into one commit, the messages verbatim one after the other.
    const messages = git(worktree, 'log', '-z', '--reverse', '--format=%B', `${forkPoint}..HEAD`)
      .split('\0')
      .map((m) => m.trim())
      .filter(Boolean)
    git(worktree, 'reset', '-q', '--soft', forkPoint)
    git(worktree, 'commit', '-q', '-m', messages.join('\n\n'))
  }
  git(worktree, 'checkout', '-q', integration)
  git(worktree, 'merge', '-q', '--ff-only', branch)
  git(worktree, 'push', '-q', 'origin', integration)
  const commit = git(worktree, 'rev-parse', 'HEAD')
  run.report({ type: 'push', branch: integration, commit })
  deleteBranch(worktree, branch)
  await run.comment(
    nr,
    `Done: ${commit} in ${integration}, attempt ${attempts} of ${run.maxAttempts}, blocks: ${blocksOf(flow).length}`,
  )
  await tracker.close(nr)
  run.report({ type: 'ticket-done', ticket: nr, commit, attempts })
  return { result: 'done', attempts, commit }
}

/** The fail path: the work is dropped, the ticket goes to a human with one comment. */
async function fail(flow: Flow, reds: Red[]): Promise<TicketOutcome> {
  const { run, ticket } = flow
  const nr = ticket.number
  const attempts = reds.length
  const { verification = '', output } = reds.at(-1) ?? {}
  drop(flow)
  await run.tracker.markFailed(nr)
  await run.tracker.release(nr)
  await run.comment(
    nr,
    failedComment({
      reds: reds.map((r) => r.verification),
      maxAttempts: run.maxAttempts,
      output:
        output === undefined
          ? undefined
          : truncateFromStart(output, 'truncated, full output in the log'),
      blocks: blocksOf(flow).length,
      worktree: run.worktree,
      sessionId: flow.sessions.at(-1)?.sessionId,
      logDir: run.logDir,
    }),
  )
  run.report({ type: 'ticket-failed', ticket: nr, attempts, verification })
  return { result: 'failed', attempts, verification }
}

/** Throws away the ticket's work: the worktree goes back to the integration branch. */
function drop({ run, branch }: Flow) {
  run.discard()
  git(run.worktree, 'checkout', '-q', '-f', integrationBranch(run.spec))
  deleteBranch(run.worktree, branch)
}

/** Deletes the ticket branch locally and on the remote, as far as it exists. */
function deleteBranch(directory: string, branch: string) {
  if (branchExists(directory, branch)) git(directory, 'branch', '-q', '-D', branch)
  if (git(directory, 'ls-remote', '--heads', 'origin', branch)) {
    git(directory, 'push', '-q', 'origin', '--delete', branch)
  }
}

function throwIfAborted({ abort }: RunContext) {
  if (abort.aborted) throw new Aborted()
}

function blocksOf({ sessions }: Flow): Block[] {
  return sessions.flatMap((s) => s.blocks ?? [])
}

function currentBranch(directory: string): string {
  return git(directory, 'branch', '--show-current')
}

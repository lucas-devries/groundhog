import { existsSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Agent, Block, SessionResult } from './agent.ts'
import { type Choice, integrationBranch } from './choice.ts'
import type { Clock } from './clock.ts'
import { DEFAULT_ATTEMPTS } from './config.ts'
import { commonDir, git } from './git.ts'
import type { Sandbox } from './sandbox.ts'
import { failedComment, resumeInfo, summary } from './summary.ts'
import { type FrontierState, frontierState, type Ticket, type Tracker } from './tracker.ts'

export { type Choice, FINISH, integrationBranch } from './choice.ts'

export interface RunInput {
  spec: number
  choice: Choice
  /** Repo root of the clone; only used to add and remove the worktree. */
  directory: string
  /** The run's worktree: every session, check and git step happens there. */
  worktree: string
  checks: string[]
  /** Commands that prepare a newly created worktree; the project config's `setup`. */
  setup?: string[]
  /** Maximum number of attempts per ticket. */
  maxAttempts?: number
  /** Value of the `gh` token; the engine replaces it with `***` in session and check output. */
  token?: string
  /** Versions of groundhog, `claude` and the skill plugin, for the log. */
  versions?: Record<string, string>
  /** Folder of the log, for comments. */
  logDir?: string
  tracker: Tracker
  agent: Agent
  sandbox: Sandbox
  clock: Clock
  report?: (event: Event) => void
  /** Orderly abort: the engine ends the session, cleans up and ends without a comment on the spec. */
  abort?: AbortSignal
}

export type Event = (RunEvent | TicketEvent) & { time: number }

type RunEvent =
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

type TicketEvent = { ticket: number } & (
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
interface CommandOutput {
  command: string
  output: string
}

/** A ticket in the task-graph, with the state the engine gives it by the frontier rule. */
export interface GraphTicket extends Ticket {
  state: FrontierState
}

interface VerificationResult {
  name: string
  ok: boolean
}

export interface TicketResult {
  number: number
  result: 'done' | 'failed'
  attempts: number
  /** Commit in the integration branch, only when done. */
  commit?: string
  /** The red verification of the last attempt, only when failed. */
  verification?: string
}

/** What became of the finish. */
export type FinishResult =
  | { type: 'merged'; commit: string }
  | { type: 'conflict' }
  | { type: 'pr'; url: string }
  | { type: 'none' }
  | { type: 'skipped'; reason: 'tickets open' | 'setup failed' | 'aborted' }

export interface RunResult {
  tickets: TicketResult[]
  finish: FinishResult
  /** Set if the run halted early: no credit at the usage limit, a failing `setup`, or aborted. */
  halted?: 'credit' | 'setup' | 'aborted'
}

const MINUTE = 60_000
const SESSION_TIME_LIMIT = 60 * MINUTE
/** For one pass of all checks together. */
const CHECKS_TIME_LIMIT = 15 * MINUTE
/** For all `setup` commands together. */
const SETUP_TIME_LIMIT = 15 * MINUTE
/** After the usage limit reset: `resetsAt` is rounded to seconds, the server clock may differ. */
const RESET_BUFFER = MINUTE

export function ticketBranchOf(ticket: number): string {
  return `ticket/${ticket}`
}

/** Thrown by the engine at the places where it accepts an abort. */
class Aborted extends Error {}

/** Drives a whole run over the tickets of a spec. */
export async function driveRun(input: RunInput): Promise<RunResult> {
  const { spec, choice, worktree, tracker, clock, maxAttempts = DEFAULT_ATTEMPTS } = input
  const abort = input.abort ?? new AbortController().signal
  const halt = () => {
    if (abort.aborted) throw new Aborted()
  }
  /** What the summary needs: all events without the raw output of the sessions. */
  const history: Event[] = []
  const report = (e: RunEvent | TicketEvent) => {
    const event = { ...e, time: clock.now() }
    if (event.type !== 'session-output') history.push(event)
    input.report?.(event)
  }
  // The one place where the token disappears from session and check output. The agent only
  // evaluates the filtered line; everything it reports (blocks too) is thus already filtered.
  const filter = (text: string) => (input.token ? text.replaceAll(input.token, '***') : text)
  const integration = integrationBranch(spec)
  const result: Omit<RunResult, 'finish'> = { tickets: [] }
  /** A failed comment only warns; the run goes on. */
  const comment = async (issue: number, text: string) => {
    try {
      await tracker.comment(issue, text)
    } catch (error) {
      report({
        type: 'warning',
        text: `Comment on #${issue} failed: ${(error as Error).message}`,
      })
    }
  }
  /** Regular end: summary to the spec and into the end event. */
  const end = async (finish: FinishResult) => {
    const ending = { type: 'run-finished', finish, time: clock.now() } as const
    const text = summary([...history, { ...ending, summary: '' }])
    await comment(spec, `${text}\n\n${resumeInfo(input.logDir)}`)
    input.report?.({ ...ending, summary: text })
  }
  report({ type: 'run-started', spec, choice, worktree, versions: input.versions ?? {} })

  /** A failed removal only warns: it must not cost the summary. */
  const removeWorktree = () => {
    try {
      git(input.directory, 'worktree', 'remove', '--force', worktree)
    } catch (error) {
      report({
        type: 'warning',
        text: `Removing the worktree ${worktree} failed: ${(error as Error).message}`,
      })
    }
  }

  /**
   * Lies in the worktree's git directory until `setup` has run through. A worktree that still has
   * it (failed removal, abort, crash) is created anew, so that `setup` is never skipped.
   */
  const setupMarker = () =>
    join(git(worktree, 'rev-parse', '--absolute-git-dir'), 'groundhog-setup-pending')
  const setup = input.setup ?? []
  const fresh = !isWorktreeOf(input.directory, worktree) || existsSync(setupMarker())
  if (fresh) {
    rmSync(worktree, { recursive: true, force: true })
    // -f twice also replaces a stale registration of this path, even a locked one.
    git(input.directory, 'worktree', 'add', '-q', '-f', '-f', '--detach', worktree)
    if (setup.length > 0) writeFileSync(setupMarker(), '')
  }
  /** Throws away the work in the worktree; everything there is the agent's. */
  const discard = () => {
    git(worktree, 'reset', '-q', '--hard')
    git(worktree, 'clean', '-q', '-fd')
  }
  discard()
  git(worktree, 'fetch', '-q', 'origin')
  if (git(worktree, 'branch', '-r', '--list', `origin/${integration}`)) {
    // The pushed state is what counts.
    git(worktree, 'checkout', '-q', '--no-track', '-B', integration, `origin/${integration}`)
  } else {
    if (!branchExists(worktree, integration)) {
      git(worktree, 'branch', '-q', '--no-track', integration, `origin/${choice.targetBranch}`)
    }
    git(worktree, 'checkout', '-q', integration)
  }

  /** Runs `setup` in a new worktree, in order; returns the first red command, if there is one. */
  const runSetup = async (): Promise<CommandOutput | undefined> => {
    const timeout = clock.timeout(SETUP_TIME_LIMIT)
    const signal = AbortSignal.any([timeout, abort])
    for (const command of setup) {
      const execution = await input.sandbox.execute(command, { directory: worktree, signal })
      halt()
      if (execution.exitCode === 0 && !timeout.aborted) continue
      const limit = timeout.aborted
        ? `\n[ended after ${SETUP_TIME_LIMIT / MINUTE} minutes (time limit for all of setup)]`
        : ''
      return { command, output: `${filter(execution.output)}${limit}` }
    }
    rmSync(setupMarker(), { force: true })
    // Only ignored files may stay; anything else would turn the first ticket red.
    discard()
    return undefined
  }

  /** The claimed ticket that is not finished yet. */
  let taken: number | undefined
  try {
    const failed = fresh ? await runSetup() : undefined
    if (failed) {
      removeWorktree()
      report({ type: 'run-halted', reason: 'setup', ...failed })
      const finish: FinishResult = { type: 'skipped', reason: 'setup failed' }
      await end(finish)
      return { ...result, finish, halted: 'setup' }
    }
    while (true) {
      const graph = (await tracker.taskGraph(spec)).map((t) => ({
        ...t,
        state: frontierState(t, tracker.user),
      }))
      report({ type: 'task-graph', tickets: graph })
      halt()
      const ticket = graph
        .filter((t) => t.state === 'workable')
        .sort((a, b) => a.number - b.number)[0]
      if (!ticket) {
        const finish = await doFinish(
          input,
          graph.every((t) => !t.open),
          comment,
          report,
        )
        // The spec is done. The branches stay; a conflict is resolved in the human's own directory.
        if (finish.type !== 'skipped') removeWorktree()
        await end(finish)
        return { ...result, finish }
      }
      const nr = ticket.number
      const ticketBranch = ticketBranchOf(nr)

      await tracker.claim(nr)
      taken = nr
      report({ type: 'ticket-taken', ticket: nr })
      git(worktree, 'checkout', '-q', '-B', ticketBranch, integration)
      const forkPoint = git(worktree, 'rev-parse', 'HEAD')

      /**
       * Verifies an attempt and records every verification in `results`; on red, returns the red
       * verification and the feedback for the next session.
       */
      const verify = async (
        sessionSuccess: boolean,
        sessionTimedOut: boolean,
        results: VerificationResult[],
      ): Promise<Red | undefined> => {
        const record = (name: string, ok: boolean, check?: CommandOutput) => {
          results.push({ name, ok })
          report({ type: 'verification', ticket: nr, name, ok, ...check })
        }
        const verifications: [string, boolean][] = [
          ['Session successful', sessionSuccess && !sessionTimedOut],
          [`HEAD on ${ticketBranch}`, currentBranch(worktree) === ticketBranch],
          [
            'new commit since fork point',
            git(worktree, 'rev-list', '--count', `${forkPoint}..${ticketBranch}`) !== '0',
          ],
          ['working tree clean', git(worktree, 'status', '--porcelain') === ''],
        ]
        for (const [name, ok] of verifications) record(name, ok)
        const red = verifications.find(([, ok]) => !ok)
        if (red) {
          return {
            verification: red[0],
            feedback: sessionTimedOut
              ? `The last attempt was red: the session was ended after ${SESSION_TIME_LIMIT / MINUTE} minutes.`
              : `The last attempt was red: verification "${red[0]}" not passed.`,
          }
        }
        const timeout = clock.timeout(CHECKS_TIME_LIMIT)
        const signal = AbortSignal.any([timeout, abort])
        for (const check of input.checks) {
          const execution = await input.sandbox.execute(check, { directory: worktree, signal })
          halt()
          const { exitCode } = execution
          const output = filter(execution.output)
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

      let red: Red | undefined
      let attempt = 0
      let sessions = 0
      const blocks: Block[] = []
      /** The red verification of each attempt. */
      const reds: string[] = []
      let sessionId: string | undefined
      while (attempt < maxAttempts) {
        attempt++
        report({ type: 'attempt-started', ticket: nr, attempt, of: maxAttempts })
        let session: SessionResult
        let signal: AbortSignal
        while (true) {
          // Every restart after the usage limit is a session of its own with its own number.
          halt()
          const s = ++sessions
          signal = clock.timeout(SESSION_TIME_LIMIT)
          session = await input.agent.runSession({
            ticket,
            directory: worktree,
            forkPoint,
            feedback: red?.feedback,
            signal: AbortSignal.any([signal, abort]),
            output: (raw) => {
              const line = filter(raw)
              report({ type: 'session-output', ticket: nr, session: s, line })
              return line
            },
          })
          report({ type: 'session-finished', ticket: nr, session: s, attempt, ...session })
          blocks.push(...(session.blocks ?? []))
          sessionId = session.sessionId
          halt()
          if (session.usageLimit === undefined) break
          // Usage limit: no attempt used up; the same attempt restarts after the reset.
          if (session.usageLimit === 'credit') {
            // Doesn't reset by itself: ticket, branch and work stay in place.
            const finish: FinishResult = { type: 'skipped', reason: 'tickets open' }
            report({ type: 'run-halted', ticket: nr, reason: 'credit' })
            await end(finish)
            return { ...result, finish, halted: 'credit' }
          }
          let reset: number | undefined = session.usageLimit
          while (reset !== undefined) {
            report({ type: 'pause', ticket: nr, reset })
            await clock.wait(Math.max(0, reset - clock.now()) + RESET_BUFFER, abort)
            halt()
            reset = await input.agent.exhaustedUntil()
          }
        }
        const verifications: VerificationResult[] = []
        red = await verify(session.success, signal.aborted, verifications)
        report({ type: 'attempt-finished', ticket: nr, attempt, verifications })
        if (!red) break
        reds.push(red.verification)
        // If the agent closed the ticket itself, that doesn't count.
        await tracker.reopen(nr)
        if (currentBranch(worktree) !== ticketBranch) {
          git(worktree, 'checkout', '-q', '-f', ticketBranch)
        }
      }

      if (red) {
        discard()
        git(worktree, 'checkout', '-q', '-f', integration)
        deleteTicketBranch(worktree, ticketBranch)
        await tracker.markFailed(nr)
        await tracker.release(nr)
        await comment(
          nr,
          failedComment({
            reds,
            maxAttempts,
            output:
              red.output === undefined
                ? undefined
                : truncateFromStart(red.output, 'truncated, full output in the log'),
            blocks: blocks.length,
            worktree,
            sessionId,
            logDir: input.logDir,
          }),
        )
        report({
          type: 'ticket-failed',
          ticket: nr,
          attempts: attempt,
          verification: red.verification,
        })
        taken = undefined
        result.tickets.push({
          number: nr,
          result: 'failed',
          attempts: attempt,
          verification: red.verification,
        })
        continue
      }

      if (git(worktree, 'rev-list', '--count', `${forkPoint}..HEAD`) !== '1') {
        // Exceptional case: squash into one commit, the messages verbatim one after the other.
        const messages = git(
          worktree,
          'log',
          '-z',
          '--reverse',
          '--format=%B',
          `${forkPoint}..HEAD`,
        )
          .split('\0')
          .map((m) => m.trim())
          .filter(Boolean)
        git(worktree, 'reset', '-q', '--soft', forkPoint)
        git(worktree, 'commit', '-q', '-m', messages.join('\n\n'))
      }
      git(worktree, 'checkout', '-q', integration)
      git(worktree, 'merge', '-q', '--ff-only', ticketBranch)
      git(worktree, 'push', '-q', 'origin', integration)
      const commit = git(worktree, 'rev-parse', 'HEAD')
      report({ type: 'push', branch: integration, commit })
      deleteTicketBranch(worktree, ticketBranch)
      await comment(
        nr,
        `Done: ${commit} in ${integration}, attempt ${attempt} of ${maxAttempts}, blocks: ${blocks.length}`,
      )
      await tracker.close(nr)
      report({ type: 'ticket-done', ticket: nr, commit, attempts: attempt })
      taken = undefined
      result.tickets.push({ number: nr, result: 'done', attempts: attempt, commit })
    }
  } catch (error) {
    if (!(error instanceof Aborted)) throw error
  }

  // Orderly abort: discard the work, release the ticket, no comment on the spec.
  discard()
  git(worktree, 'checkout', '-q', '-f', integration)
  if (taken !== undefined) {
    deleteTicketBranch(worktree, ticketBranchOf(taken))
    await tracker.release(taken)
  }
  const finish: FinishResult = { type: 'skipped', reason: 'aborted' }
  const ending = { type: 'run-finished', finish, time: clock.now() } as const
  input.report?.({ ...ending, summary: summary([...history, { ...ending, summary: '' }]) })
  return { ...result, finish, halted: 'aborted' }
}

/** Deletes the ticket branch locally and on the remote, as far as it exists. */
function deleteTicketBranch(directory: string, branch: string) {
  if (branchExists(directory, branch)) git(directory, 'branch', '-q', '-D', branch)
  if (git(directory, 'ls-remote', '--heads', 'origin', branch)) {
    git(directory, 'push', '-q', 'origin', '--delete', branch)
  }
}

interface Red {
  verification: string
  feedback: string
  /** Output of the red check, untruncated, filtered. */
  output?: string
}

/** Truncates an output from the start to the last 100 lines and 50 000 characters. */
export function truncateFromStart(output: string, mark = 'truncated'): string {
  const lines = output.trimEnd().split('\n')
  let truncated = lines.slice(-100).join('\n').slice(-50_000)
  if (truncated.length < output.trimEnd().length) truncated = `[${mark}]\n${truncated}`
  return truncated
}

/** The finish: only if all tickets of the spec are closed, otherwise the integration branch stays. */
async function doFinish(
  { spec, choice, worktree, tracker }: RunInput,
  allClosed: boolean,
  comment: (issue: number, text: string) => Promise<void>,
  report: (e: RunEvent) => void,
): Promise<FinishResult> {
  if (!allClosed) return { type: 'skipped', reason: 'tickets open' }
  const integration = integrationBranch(spec)
  const target = choice.targetBranch
  switch (choice.finish) {
    case 'merge': {
      git(worktree, 'fetch', '-q', 'origin')
      // The merge happens on a detached HEAD, so the local target branch stays untouched.
      git(worktree, 'checkout', '-q', '--detach', `origin/${target}`)
      try {
        git(worktree, 'merge', '-q', '--no-ff', '--no-edit', integration)
      } catch {
        // The engine never resolves conflicts.
        git(worktree, 'merge', '--abort')
        git(worktree, 'checkout', '-q', integration)
        return { type: 'conflict' }
      }
      const commit = git(worktree, 'rev-parse', 'HEAD')
      git(worktree, 'push', '-q', 'origin', `HEAD:refs/heads/${target}`)
      report({ type: 'push', branch: target, commit })
      git(worktree, 'checkout', '-q', integration)
      await tracker.close(spec)
      return { type: 'merged', commit }
    }
    case 'pr': {
      const url = await tracker.createPr({
        integrationBranch: integration,
        targetBranch: target,
        title: `Spec #${spec}`,
        body: `Closes #${spec}`,
      })
      await comment(spec, `PR: ${url}`)
      return { type: 'pr', url }
    }
    case 'none':
      await comment(spec, `Integration branch: ${integration}`)
      return { type: 'none' }
  }
}

/**
 * Whether the folder is a working worktree of the clone. Anything else must not be handed to
 * `reset` or `clean`: git would then act on whatever repo lies above it.
 */
function isWorktreeOf(clone: string, folder: string): boolean {
  try {
    return (
      git(folder, 'rev-parse', '--show-toplevel') === realpathSync(folder) &&
      realpathSync(commonDir(folder)) === realpathSync(commonDir(clone))
    )
  } catch {
    // Usually no folder or no repo there. Any other git error replaces the folder too, which
    // costs nothing: all it holds is the agent's (ADR 0001).
    return false
  }
}

function branchExists(directory: string, branch: string): boolean {
  return git(directory, 'branch', '--list', branch) !== ''
}

function currentBranch(directory: string): string {
  return git(directory, 'branch', '--show-current')
}

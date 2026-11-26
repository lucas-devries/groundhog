import type { Agent } from './agent.ts'
import { type Choice, integrationBranch } from './choice.ts'
import { type Clock, MINUTE } from './clock.ts'
import { DEFAULT_ATTEMPTS } from './config.ts'
import { git } from './git.ts'
import {
  type CommandOutput,
  type Event,
  type FinishResult,
  fold,
  newRunState,
  type RunEvent,
  type TicketEvent,
} from './run-state.ts'
import type { Sandbox } from './sandbox.ts'
import { resumeInfo, summary } from './summary.ts'
import { type RunContext, ticketFlow } from './ticket-flow.ts'
import { frontierState, type Tracker } from './tracker.ts'
import { prepareWorktree } from './worktree.ts'

export { type Choice, FINISH, integrationBranch } from './choice.ts'
export type { Event, FinishResult } from './run-state.ts'

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

export interface TicketResult {
  number: number
  result: 'done' | 'failed'
  attempts: number
  /** Commit in the integration branch, only when done. */
  commit?: string
  /** The red verification of the last attempt, only when failed. */
  verification?: string
}

export interface RunResult {
  tickets: TicketResult[]
  finish: FinishResult
  /** Set if the run halted early: no credit at the usage limit, a failing `setup`, or aborted. */
  halted?: 'credit' | 'setup' | 'aborted'
}

/** For all `setup` commands together. */
const SETUP_TIME_LIMIT = 15 * MINUTE

/** Drives a whole run over the tickets of a spec. */
export async function driveRun(input: RunInput): Promise<RunResult> {
  const { spec, choice, worktree, tracker, clock, maxAttempts = DEFAULT_ATTEMPTS } = input
  const abort = input.abort ?? new AbortController().signal
  /** What the summary needs. */
  const state = newRunState()
  const report = (e: RunEvent | TicketEvent) => {
    const event = { ...e, time: clock.now() }
    fold(state, event)
    input.report?.(event)
  }
  // The one place where the token disappears from session, check and setup output. The agent only
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
  /** The end event of the run with its summary, which needs the end already in the state. */
  const finishedEvent = (finish: FinishResult) => {
    const event = { type: 'run-finished', finish, summary: '', time: clock.now() } as const
    return { ...event, summary: summary(fold(state, event)) }
  }
  /** Regular end: summary to the spec and into the end event. */
  const end = async (finish: FinishResult) => {
    const event = finishedEvent(finish)
    await comment(spec, `${event.summary}\n\n${resumeInfo(input.logDir)}`)
    input.report?.(event)
  }
  /** Orderly abort: no comment on the spec. */
  const aborted = (): RunResult => {
    const finish: FinishResult = { type: 'skipped', reason: 'aborted' }
    input.report?.(finishedEvent(finish))
    return { ...result, finish, halted: 'aborted' }
  }
  report({ type: 'run-started', spec, choice, worktree, versions: input.versions ?? {} })

  const setup = input.setup ?? []
  const prepared = prepareWorktree({
    clone: input.directory,
    path: worktree,
    spec,
    targetBranch: choice.targetBranch,
    hasSetup: setup.length > 0,
    warn: (text) => report({ type: 'warning', text }),
  })

  /** Orderly abort between two tickets: discard what lies around. */
  const abortBetweenTickets = (): RunResult => {
    prepared.discard()
    git(worktree, 'checkout', '-q', '-f', integration)
    return aborted()
  }

  /** Runs `setup` in a new worktree, in order; returns the first red command, if there is one. */
  const runSetup = async (): Promise<CommandOutput | 'aborted' | undefined> => {
    const timeout = clock.timeout(SETUP_TIME_LIMIT)
    const signal = AbortSignal.any([timeout, abort])
    for (const command of setup) {
      const execution = await input.sandbox.execute(command, { directory: worktree, signal })
      if (abort.aborted) return 'aborted'
      if (execution.exitCode === 0 && !timeout.aborted) continue
      const limit = timeout.aborted
        ? `\n[ended after ${SETUP_TIME_LIMIT / MINUTE} minutes (time limit for all of setup)]`
        : ''
      return { command, output: `${filter(execution.output)}${limit}` }
    }
    prepared.setupDone()
    return undefined
  }

  const run: RunContext = {
    ...input,
    maxAttempts,
    abort,
    report,
    filter,
    comment,
    discard: prepared.discard,
  }

  const failed = prepared.setupDue ? await runSetup() : undefined
  if (failed === 'aborted') return abortBetweenTickets()
  if (failed) {
    prepared.remove()
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
    if (abort.aborted) return abortBetweenTickets()
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
      if (finish.type !== 'skipped') prepared.remove()
      await end(finish)
      return { ...result, finish }
    }

    await tracker.claim(ticket.number)
    report({ type: 'ticket-taken', ticket: ticket.number })
    const outcome = await ticketFlow(ticket, run)
    if (outcome.result !== 'halted') {
      result.tickets.push({ number: ticket.number, ...outcome })
      continue
    }
    if (outcome.reason === 'aborted') return aborted()
    // No credit: ticket, branch and work stay in place.
    const finish: FinishResult = { type: 'skipped', reason: 'tickets open' }
    await end(finish)
    return { ...result, finish, halted: 'credit' }
  }
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

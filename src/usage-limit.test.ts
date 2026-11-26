import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { type AgentScript, fakeAgent } from './agent.ts'
import { manualClock } from './clock.ts'
import { driveRun, type Event, type RunResult } from './engine.ts'
import { passthrough, type Sandbox } from './sandbox.ts'
import { commitFile, throwawayRepo, worktreeOf } from './testing/throwaway-repo.ts'
import { InMemoryTracker } from './tracker.ts'

const MINUTE = 60_000
const BUFFER = MINUTE

/** Drives a run over spec 1 with one ticket #2, by default with one attempt. */
async function run(
  script: AgentScript[],
  options: {
    exhaustedUntil?: () => number | undefined
    clock?: ReturnType<typeof manualClock>
    attempts?: number
    checks?: string[]
    sandbox?: Sandbox
  } = {},
) {
  const { clone } = throwawayRepo()
  const tracker = new InMemoryTracker('me', [
    { number: 2, open: true, labels: ['ready-for-agent'], assignees: [], blockers: [] },
  ])
  const clock = options.clock ?? manualClock()
  const events: Event[] = []
  const result: RunResult = await driveRun({
    spec: 1,
    choice: { targetBranch: 'main', finish: 'none' },
    directory: clone,
    worktree: worktreeOf(clone),
    checks: options.checks ?? ['true'],
    maxAttempts: options.attempts ?? 1,
    tracker,
    agent: fakeAgent(script, options.exhaustedUntil),
    sandbox: options.sandbox ?? passthrough,
    clock,
    report: (e) => events.push(e),
  })
  return { result, events, tracker, clone, clock }
}

const commits: AgentScript = ({ directory }) => {
  commitFile(directory, 'a.txt', 'a', 'Implement ticket 2')
  return { success: true }
}

test('at the usage limit the engine waits until the reset plus buffer and restarts the same attempt', async () => {
  const clock = manualClock(1_000)
  const reset = 3 * 60 * MINUTE
  let inSecondSession: unknown

  const { events, tracker } = await run(
    [
      ({ directory }) => {
        writeFileSync(join(directory, 'a.txt'), 'x')
        return { success: false, usageLimit: reset }
      },
      (request) => {
        inSecondSession = {
          time: clock.now(),
          halfDone: existsSync(join(request.directory, 'a.txt')),
          feedback: request.feedback,
        }
        return commits(request)
      },
    ],
    { clock },
  )

  expect(inSecondSession).toEqual({ time: reset + BUFFER, halfDone: true, feedback: undefined })
  expect(tracker.ticket(2).open).toBe(false)
  expect(events.filter((e) => e.type === 'attempt-started')).toHaveLength(1)
  expect(events.filter((e) => e.type === 'pause')).toEqual([
    { type: 'pause', ticket: 2, reset, time: 1_000 },
  ])
  // The restart is a session of its own (own raw file in the log), but the same attempt.
  expect(events.filter((e) => e.type === 'session-finished')).toMatchObject([
    { session: 1, attempt: 1, usageLimit: reset },
    { session: 2, attempt: 1 },
  ])
})

test('if a window is still exhausted before the restart, the engine waits until its reset', async () => {
  const clock = manualClock()
  const firstReset = 60 * MINUTE
  const secondReset = 24 * 60 * MINUTE
  const queries: number[] = []
  let startSecondSession: number | undefined

  const { events } = await run(
    [
      () => ({ success: false, usageLimit: firstReset }),
      (request) => {
        startSecondSession = clock.now()
        return commits(request)
      },
    ],
    {
      clock,
      exhaustedUntil: () => {
        queries.push(clock.now())
        return queries.length === 1 ? secondReset : undefined
      },
    },
  )

  expect(queries).toEqual([firstReset + BUFFER, secondReset + BUFFER])
  expect(startSecondSession).toBe(secondReset + BUFFER)
  expect(
    events.filter((e) => e.type === 'pause').map((e) => e.type === 'pause' && e.reset),
  ).toEqual([firstReset, secondReset])
})

test('if an abort without a reset time requires credit, the engine halts the run instead of waiting', async () => {
  const clock = manualClock()

  const { result, events, tracker } = await run(
    [() => ({ success: false, usageLimit: 'credit' })],
    { clock },
  )

  expect(result).toEqual({
    tickets: [],
    finish: { type: 'skipped', reason: 'tickets open' },
    halted: 'credit',
  })
  expect(clock.now()).toBe(0)
  expect(events.map((e) => e.type)).toEqual([
    'run-started',
    'task-graph',
    'ticket-taken',
    'attempt-started',
    'session-finished',
    'run-halted',
    'run-finished',
  ])
  expect(tracker.ticket(2)).toMatchObject({ open: true, labels: ['ready-for-agent'] })
})

test('a session ends after 60 minutes and is a red attempt', async () => {
  const clock = manualClock()
  const aborted: boolean[] = []
  let feedback: string | undefined

  const { tracker } = await run(
    [
      (request) => {
        commits(request)
        clock.advance(60 * MINUTE)
        aborted.push(request.signal.aborted)
        return { success: true }
      },
      (request) => {
        feedback = request.feedback
        clock.advance(59 * MINUTE)
        aborted.push(request.signal.aborted)
        return { success: true }
      },
    ],
    { clock, attempts: 2 },
  )

  expect(aborted).toEqual([true, false])
  expect(feedback).toContain('ended after 60 minutes')
  expect(tracker.ticket(2).open).toBe(false)
})

test('a pass of the checks ends after 15 minutes and is a red attempt', async () => {
  const clock = manualClock()
  // Each check takes 10 minutes; the second one breaks the time limit of the pass.
  const sandbox: Sandbox = {
    execute: (command, options) => {
      const execution = passthrough.execute(command, options)
      clock.advance(10 * MINUTE)
      return execution
    },
  }

  const { events } = await run([commits], {
    clock,
    sandbox,
    checks: ['true', 'sleep 30; echo never'],
  })

  expect(
    events.filter((e) => e.type === 'verification' && e.name.startsWith('Check')),
  ).toMatchObject([
    { name: 'Check: true', ok: true },
    { name: 'Check: sleep 30; echo never', ok: false },
  ])
  expect(events.find((e) => e.type === 'ticket-failed')).toMatchObject({
    verification: 'Check: sleep 30; echo never',
  })
})

test('the feedback after timed-out checks names the time limit', async () => {
  const clock = manualClock()
  let feedback: string | undefined
  const sandbox: Sandbox = {
    execute: async (_command, { signal }) => {
      clock.advance(15 * MINUTE)
      return { exitCode: signal.aborted ? 1 : 0, output: 'half done' }
    },
  }

  await run(
    [
      commits,
      (request) => {
        feedback = request.feedback
        return { success: true }
      },
    ],
    { clock, sandbox, attempts: 2 },
  )

  expect(feedback).toContain('ended after 15 minutes')
  expect(feedback).toContain('half done')
})

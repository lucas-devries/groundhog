import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { abortGuard } from './abort.ts'
import { type AgentScript, fakeAgent, type SessionRequest } from './agent.ts'
import { manualClock } from './clock.ts'
import { driveRun, type Event, type RunResult } from './engine.ts'
import { git } from './git.ts'
import { passthrough } from './sandbox.ts'
import { commitFile, throwawayRepo } from './testing/throwaway-repo.ts'
import { InMemoryTracker } from './tracker.ts'

const twoTickets = () =>
  new InMemoryTracker('me', [
    { number: 2, open: true, labels: ['ready-for-agent'], assignees: [], blockers: [] },
    { number: 3, open: true, labels: ['ready-for-agent'], assignees: [], blockers: [] },
  ])

/** A run over spec 1 with an abort guard on a manual clock. */
function setup(tracker = twoTickets()) {
  const clock = manualClock()
  const notes: string[] = []
  let hard = 0
  const guard = abortGuard({
    clock,
    note: (text) => notes.push(text),
    hard: () => {
      hard++
    },
  })
  const events: Event[] = []
  const run = (clone: string, script: AgentScript[], attempts?: number) =>
    driveRun({
      spec: 1,
      choice: { targetBranch: 'main', finish: 'none' },
      directory: clone,
      checks: ['true'],
      maxAttempts: attempts,
      tracker,
      agent: fakeAgent(script),
      sandbox: passthrough,
      clock,
      abort: guard.signal,
      report: (e) => events.push(e),
    })
  return { clock, notes, hardEnds: () => hard, guard, events, run, tracker }
}

const commits =
  (nr: number): AgentScript =>
  ({ directory }) => {
    commitFile(directory, `${nr}.txt`, 'x', `Ticket ${nr}`)
    return { success: true }
  }

/** A session that is half done and ends after `signals`, like the Claude adapter on abort. */
const interrupted =
  (signals: () => void): AgentScript =>
  (request: SessionRequest) => {
    commitFile(request.directory, 'half.txt', 'x', 'half done')
    git(request.directory, 'push', '-q', 'origin', `ticket/${request.ticket.number}`)
    writeFileSync(join(request.directory, 'dirt.txt'), 'x')
    signals()
    return { success: !request.signal.aborted }
  }

function expectCleanedUp(
  clone: string,
  remote: string,
  tracker: InMemoryTracker,
  result: RunResult,
  events: Event[],
) {
  expect(result.halted).toBe('aborted')
  expect(tracker.ticket(2)).toMatchObject({ open: true, assignees: [] })
  expect(git(clone, 'status', '--porcelain')).toBe('')
  expect(git(clone, 'branch', '--show-current')).toBe('main')
  expect(git(clone, 'branch', '--list', 'ticket/*')).toBe('')
  expect(git(remote, 'branch', '--list', 'ticket/*')).toBe('')
  expect(tracker.comments(1)).toEqual([])
  const end = events.at(-1)
  expect(end).toMatchObject({ type: 'run-finished' })
  expect(end?.type === 'run-finished' && end.summary).toContain('aborted')
}

test('Ctrl+C twice in a session: the run cleans up and ends aborted', async () => {
  const { remote, clone } = throwawayRepo()
  const a = setup()

  const result = await a.run(clone, [
    interrupted(() => {
      a.guard.receive('SIGINT')
      a.guard.receive('SIGINT')
    }),
  ])

  expectCleanedUp(clone, remote, a.tracker, result, a.events)
  expect(a.notes).toEqual(['Press Ctrl+C again to abort'])
  // Ticket 3 is not taken any more.
  expect(a.tracker.ticket(3).assignees).toEqual([])
  expect(a.hardEnds()).toBe(0)
})

test('a single Ctrl+C aborts nothing', async () => {
  const { clone } = throwawayRepo()
  const a = setup()

  const result = await a.run(clone, [
    (request) => {
      a.guard.receive('SIGINT')
      expect(request.signal.aborted).toBe(false)
      return commits(2)(request)
    },
    commits(3),
  ])

  expect(result.halted).toBeUndefined()
  expect(result.tickets.map((t) => t.result)).toEqual(['done', 'done'])
  expect(a.notes).toEqual(['Press Ctrl+C again to abort'])
})

test('after 5 seconds the prompt expires; only a second Ctrl+C within the grace period aborts', async () => {
  const { remote, clone } = throwawayRepo()
  const a = setup()

  const result = await a.run(clone, [
    interrupted(() => {
      a.guard.receive('SIGINT')
      a.clock.advance(5_001)
      a.guard.receive('SIGINT')
      expect(a.guard.signal.aborted).toBe(false)
      a.clock.advance(5_000)
      a.guard.receive('SIGINT')
    }),
  ])

  expectCleanedUp(clone, remote, a.tracker, result, a.events)
  expect(a.notes).toEqual(['Press Ctrl+C again to abort', 'Press Ctrl+C again to abort'])
})

test.each(['SIGTERM', 'SIGHUP'] as const)(
  '%s cleans up at once, without asking',
  async (signal) => {
    const { remote, clone } = throwawayRepo()
    const a = setup()

    const result = await a.run(clone, [interrupted(() => a.guard.receive(signal))])

    expectCleanedUp(clone, remote, a.tracker, result, a.events)
    expect(a.notes).toEqual([])
  },
)

test('Ctrl+C during cleanup aborts at once', async () => {
  const { clone } = throwawayRepo()
  const tracker = twoTickets()
  const a = setup(tracker)
  const release = tracker.release.bind(tracker)
  tracker.release = async (nr) => {
    a.guard.receive('SIGINT')
    return release(nr)
  }

  await a.run(clone, [interrupted(() => a.guard.receive('SIGTERM'))])

  expect(a.hardEnds()).toBe(1)
})

test('the abort checks out the branch that was checked out at the start', async () => {
  const { clone } = throwawayRepo()
  git(clone, 'checkout', '-q', '-b', 'own')
  const a = setup()

  await a.run(clone, [interrupted(() => a.guard.receive('SIGTERM'))])

  expect(git(clone, 'branch', '--show-current')).toBe('own')
})

test('a new run after an abort starts each ticket with attempt 1', async () => {
  const { clone } = throwawayRepo()
  const tracker = twoTickets()
  const first = setup(tracker)
  await first.run(clone, [
    () => ({ success: false }),
    interrupted(() => first.guard.receive('SIGTERM')),
  ])

  const second = setup(tracker)
  const result = await second.run(clone, [commits(2), commits(3)])

  const attempts = second.events.filter((e) => e.type === 'attempt-started')
  expect(attempts.map((e) => [e.ticket, e.attempt])).toEqual([
    [2, 1],
    [3, 1],
  ])
  expect(result.tickets.map((t) => t.result)).toEqual(['done', 'done'])
})

test('if the local integration branch differs from the remote, the engine resets it to the remote state', async () => {
  const { remote, clone, newClone } = throwawayRepo()
  const other = newClone()
  git(other, 'checkout', '-q', '-b', 'spec/1')
  commitFile(other, 'remote.txt', 'x', 'on the remote')
  git(other, 'push', '-q', 'origin', 'spec/1')
  git(clone, 'checkout', '-q', '-b', 'spec/1')
  commitFile(clone, 'local.txt', 'x', 'only local')
  git(clone, 'checkout', '-q', 'main')
  const a = setup()

  await a.run(clone, [commits(2), commits(3)])

  expect(git(remote, 'log', '--format=%s', 'spec/1')).toBe(
    'Ticket 3\nTicket 2\non the remote\ninit',
  )
})

test('if the push of the integration branch fails as non-fast-forward, the run aborts', async () => {
  const { clone, newClone } = throwawayRepo()
  const other = newClone()
  const a = setup()

  const run = a.run(clone, [
    (request) => {
      // A second clone on the same spec pushes first.
      git(other, 'checkout', '-q', '-b', 'spec/1')
      commitFile(other, 'other.txt', 'x', 'other clone')
      git(other, 'push', '-q', 'origin', 'spec/1')
      return commits(2)(request)
    },
    commits(3),
  ])

  await expect(run).rejects.toThrow(/push/)
  expect(a.tracker.ticket(2).open).toBe(true)
  expect(a.tracker.ticket(3).assignees).toEqual([])
})

import { existsSync } from 'node:fs'
import { expect, test } from 'vitest'
import { type AgentScript, fakeAgent } from './agent.ts'
import { manualClock } from './clock.ts'
import { type Choice, driveRun, type Event, type RunResult } from './engine.ts'
import { git } from './git.ts'
import { passthrough } from './sandbox.ts'
import { commitFile, throwawayRepo, worktreeOf } from './testing/throwaway-repo.ts'
import { InMemoryTracker, type Ticket } from './tracker.ts'

const ticket = (number: number, part: Partial<Ticket> = {}): Ticket => ({
  number,
  open: true,
  labels: ['ready-for-agent'],
  assignees: [],
  blockers: [],
  ...part,
})

/** A session that implements the ticket green. */
const implementsTicket: AgentScript = ({ directory, ticket }) => {
  commitFile(directory, `${ticket.number}.txt`, 'x', `Implement ticket ${ticket.number}`)
  return { success: true }
}

/** Drives a whole run over spec 1. */
function run(
  clone: string,
  tracker: InMemoryTracker,
  choice: Choice,
  script: AgentScript[] = [implementsTicket, implementsTicket],
  report?: (e: Event) => void,
): Promise<RunResult> {
  return driveRun({
    spec: 1,
    choice,
    directory: clone,
    worktree: worktreeOf(clone),
    checks: [],
    tracker,
    agent: fakeAgent(script),
    sandbox: passthrough,
    clock: manualClock(),
    report,
  })
}

/** The worktree folder is gone, git only lists the clone, and `spec/1` is still there. */
function expectWorktreeRemoved(clone: string) {
  expect(existsSync(worktreeOf(clone))).toBe(false)
  expect(git(clone, 'worktree', 'list').split('\n')).toHaveLength(1)
  expect(git(clone, 'branch', '--list', 'spec/1')).not.toBe('')
}

test.each(['merge', 'pr', 'none'] as const)(
  '%s: with every ticket closed, the worktree is removed and the integration branch stays',
  async (finish) => {
    const { clone } = throwawayRepo()

    await run(clone, new InMemoryTracker('me', [ticket(2)]), { targetBranch: 'main', finish })

    expectWorktreeRemoved(clone)
  },
)

test('a worktree that cannot be removed only warns; the run ends with the summary', async () => {
  const { clone } = throwawayRepo()
  const tracker = new InMemoryTracker('me', [ticket(2)])
  const events: Event[] = []

  const result = await run(
    clone,
    tracker,
    { targetBranch: 'main', finish: 'none' },
    [
      (request) => {
        git(clone, 'worktree', 'lock', request.directory)
        return implementsTicket(request)
      },
    ],
    (e) => events.push(e),
  )

  expect(result.finish).toEqual({ type: 'none' })
  expect(events.filter((e) => e.type === 'warning')).toMatchObject([
    { text: expect.stringContaining(worktreeOf(clone)) },
  ])
  expect(events.at(-1)?.type).toBe('run-finished')
  expect(tracker.comments(1).at(-1)).toContain('# Summary of spec #1')
})

test('merge reports the push into the target branch', async () => {
  const { remote, clone } = throwawayRepo()
  const events: Event[] = []

  await run(
    clone,
    new InMemoryTracker('me', [ticket(2)]),
    { targetBranch: 'main', finish: 'merge' },
    [implementsTicket],
    (e) => events.push(e),
  )

  expect(events.filter((e) => e.type === 'push').at(-1)).toMatchObject({
    branch: 'main',
    commit: git(remote, 'rev-parse', 'main'),
  })
})

test('merge: merge commit of the integration branch into the target branch, push, spec closed', async () => {
  const { remote, clone } = throwawayRepo()
  const tracker = new InMemoryTracker('me', [ticket(2), ticket(3)])

  const result = await run(clone, tracker, { targetBranch: 'main', finish: 'merge' })

  const merge = git(remote, 'rev-parse', 'main')
  expect(result.finish).toEqual({ type: 'merged', commit: merge })
  expect(git(remote, 'rev-parse', 'main^1')).toBe(git(remote, 'rev-parse', 'spec/1~2'))
  expect(git(remote, 'rev-parse', 'main^2')).toBe(git(remote, 'rev-parse', 'spec/1'))
  expect(tracker.isOpen(1)).toBe(false)
})

test('merge with conflict: merge aborted, integration and target branch unchanged, spec open', async () => {
  const { remote, clone, newClone } = throwawayRepo()
  const tracker = new InMemoryTracker('me', [ticket(2)])
  let main = ''

  const result = await run(clone, tracker, { targetBranch: 'main', finish: 'merge' }, [
    (request) => {
      const other = newClone()
      commitFile(other, '2.txt', 'different', 'meanwhile on main')
      git(other, 'push', '-q', 'origin', 'main')
      main = git(other, 'rev-parse', 'HEAD')
      return implementsTicket(request)
    },
  ])

  expect(result.finish).toEqual({ type: 'conflict' })
  expect(git(remote, 'rev-parse', 'main')).toBe(main)
  expect(git(remote, 'log', '--format=%s', 'spec/1')).toBe('Implement ticket 2\ninit')
  expectWorktreeRemoved(clone)
  expect(tracker.isOpen(1)).toBe(true)
  expect(tracker.comments(1).slice(0, -1)).toEqual([])
})

test.each(['merge', 'pr', 'none'] as const)(
  '%s: if not all tickets are closed, the finish is skipped and the worktree stays',
  async (finish) => {
    const { remote, clone } = throwawayRepo()
    const tracker = new InMemoryTracker('me', [
      ticket(2),
      ticket(3, { labels: ['ready-for-human'] }),
    ])
    const main = git(remote, 'rev-parse', 'main')

    const result = await run(clone, tracker, { targetBranch: 'main', finish })

    expect(result.finish).toEqual({ type: 'skipped', reason: 'tickets open' })
    expect(git(remote, 'log', '--format=%s', 'spec/1')).toBe('Implement ticket 2\ninit')
    expect(git(remote, 'rev-parse', 'main')).toBe(main)
    expect(tracker.prs).toEqual([])
    expect(tracker.comments(1).slice(0, -1)).toEqual([])
    expect(tracker.isOpen(1)).toBe(true)
    expect(existsSync(worktreeOf(clone))).toBe(true)
  },
)

test('PR: from the integration branch onto the target branch with Closes, link on the spec, spec stays open', async () => {
  const { remote, clone } = throwawayRepo()
  const tracker = new InMemoryTracker('me', [ticket(2)])
  const main = git(remote, 'rev-parse', 'main')

  const result = await run(clone, tracker, { targetBranch: 'main', finish: 'pr' })

  expect(tracker.prs).toEqual([
    {
      integrationBranch: 'spec/1',
      targetBranch: 'main',
      title: expect.any(String),
      body: 'Closes #1',
    },
  ])
  const url = 'https://github.example/pull/1'
  expect(result.finish).toEqual({ type: 'pr', url })
  expect(tracker.comments(1).slice(0, -1)).toEqual([`PR: ${url}`])
  expect(tracker.isOpen(1)).toBe(true)
  expect(git(remote, 'rev-parse', 'main')).toBe(main)
})

test('none: the name of the integration branch is on the spec, nothing else happens', async () => {
  const { remote, clone } = throwawayRepo()
  const tracker = new InMemoryTracker('me', [ticket(2)])
  const main = git(remote, 'rev-parse', 'main')

  const result = await run(clone, tracker, { targetBranch: 'main', finish: 'none' })

  expect(result.finish).toEqual({ type: 'none' })
  expect(tracker.comments(1).slice(0, -1)).toEqual(['Integration branch: spec/1'])
  expect(tracker.prs).toEqual([])
  expect(tracker.isOpen(1)).toBe(true)
  expect(git(remote, 'rev-parse', 'main')).toBe(main)
})

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { type AgentScript, fakeAgent, type SessionRequest } from './agent.ts'
import { manualClock } from './clock.ts'
import { driveRun, type Event } from './engine.ts'
import { git } from './git.ts'
import { passthrough } from './sandbox.ts'
import { commitFile, throwawayRepo, worktreeOf } from './testing/throwaway-repo.ts'
import { InMemoryTracker } from './tracker.ts'

/** Drives a run over spec 1 with target branch main; returns the events. */
async function run(
  directory: string,
  tracker: InMemoryTracker,
  script: AgentScript[],
  checks = ['true'],
  attempts?: number,
): Promise<Event[]> {
  const events: Event[] = []
  await driveRun({
    spec: 1,
    choice: { targetBranch: 'main', finish: 'none' },
    directory,
    worktree: worktreeOf(directory),
    checks,
    maxAttempts: attempts,
    tracker,
    agent: fakeAgent(script),
    sandbox: passthrough,
    clock: manualClock(),
    report: (e) => events.push(e),
  })
  return events
}

const oneTicket = () =>
  new InMemoryTracker('me', [
    { number: 2, open: true, labels: ['ready-for-agent'], assignees: [], blockers: [] },
  ])

const secondTicket = () =>
  new InMemoryTracker('me', [
    { number: 3, open: true, labels: ['ready-for-agent'], assignees: [], blockers: [] },
  ])

const commits: AgentScript = ({ directory }) => {
  commitFile(directory, 'a.txt', 'a', 'Implement ticket 2')
  return { success: true }
}

test('a green ticket lands in the integration branch, is pushed and closed', async () => {
  const { remote, clone } = throwawayRepo()
  const tracker = oneTicket()

  await run(clone, tracker, [
    (request) => {
      commits(request)
      git(request.directory, 'push', '-q', 'origin', 'ticket/2')
      return { success: true }
    },
  ])

  expect(tracker.ticket(2)).toMatchObject({ open: false, assignees: ['me'] })
  expect(git(remote, 'log', '--format=%s', 'spec/1')).toBe('Implement ticket 2\ninit')
  expect(git(clone, 'rev-parse', 'spec/1')).toBe(git(remote, 'rev-parse', 'spec/1'))
  expect(git(clone, 'branch', '--list', 'ticket/*')).toBe('')
  expect(git(remote, 'branch', '--list', 'ticket/*')).toBe('')
})

test('the engine claims the ticket before the session and passes the branch-off as fork point', async () => {
  const { remote, clone } = throwawayRepo()
  const tracker = oneTicket()
  let inSession: unknown

  await run(clone, tracker, [
    (request) => {
      inSession = {
        assignees: tracker.ticket(2).assignees,
        forkPoint: request.forkPoint,
        branch: git(request.directory, 'branch', '--show-current'),
      }
      return commits(request)
    },
  ])

  expect(inSession).toEqual({
    assignees: ['me'],
    forkPoint: git(remote, 'rev-parse', 'main'),
    branch: 'ticket/2',
  })
})

test('the integration branch forks off the freshly fetched origin/<target branch>', async () => {
  const { remote, clone, newClone } = throwawayRepo()
  const other = newClone()
  commitFile(other, 'b.txt', 'b', 'pushed elsewhere')
  git(other, 'push', '-q', 'origin', 'main')
  commitFile(clone, 'c.txt', 'c', 'only local on main')

  await run(clone, oneTicket(), [commits])

  expect(git(remote, 'log', '--format=%s', 'spec/1')).toBe(
    'Implement ticket 2\npushed elsewhere\ninit',
  )
})

test('an existing integration branch is reused', async () => {
  const { remote, clone } = throwawayRepo()
  git(clone, 'checkout', '-q', '-b', 'spec/1')
  commitFile(clone, 'v.txt', 'v', 'previous run')
  git(clone, 'checkout', '-q', 'main')

  await run(clone, oneTicket(), [commits])

  expect(git(remote, 'log', '--format=%s', 'spec/1')).toBe('Implement ticket 2\nprevious run\ninit')
})

test.each<[string, AgentScript]>([
  [
    'Session successful',
    (request) => {
      commits(request)
      return { success: false }
    },
  ],
  [
    'HEAD on ticket/2',
    (request) => {
      commits(request)
      git(request.directory, 'checkout', '-q', '-b', 'elsewhere')
      return { success: true }
    },
  ],
  ['new commit since fork point', () => ({ success: true })],
  [
    'working tree clean',
    (request) => {
      commits(request)
      writeFileSync(join(request.directory, 'open.txt'), 'x')
      return { success: true }
    },
  ],
])('verification "%s" red in the last attempt: the ticket goes to a human', async (red, step) => {
  const { remote, clone } = throwawayRepo()
  const tracker = oneTicket()

  const events = await run(
    clone,
    tracker,
    [
      (request) => {
        git(request.directory, 'push', '-q', 'origin', 'ticket/2')
        return step(request)
      },
    ],
    ['touch check-ran'],
    1,
  )

  expect(tracker.ticket(2)).toEqual({
    number: 2,
    open: true,
    assignees: [],
    blockers: [],
    labels: ['ready-for-human'],
  })
  expect(git(remote, 'branch', '--list', 'spec/1')).toBe('')
  expect(git(clone, 'branch', '--list', 'ticket/*')).toBe('')
  expect(git(remote, 'branch', '--list', 'ticket/*')).toBe('')
  expect(git(worktreeOf(clone), 'status', '--porcelain')).toBe('')
  expect(git(worktreeOf(clone), 'branch', '--show-current')).toBe('spec/1')
  const verifications = events.filter((e) => e.type === 'verification')
  expect(verifications.filter((v) => !v.ok).map((v) => v.name)).toEqual([red])
  expect(existsSync(join(worktreeOf(clone), 'check-ran'))).toBe(false)
})

test('checks run in order in the worktree, the first red one ends it', async () => {
  const { remote, clone } = throwawayRepo()
  const tracker = oneTicket()

  const events = await run(
    clone,
    tracker,
    [commits],
    ['test -f a.txt', 'false', 'touch too-far'],
    1,
  )

  expect(tracker.ticket(2).open).toBe(true)
  expect(git(remote, 'branch', '--list', 'spec/1')).toBe('')
  expect(existsSync(join(worktreeOf(clone), 'too-far'))).toBe(false)
  expect(
    events.filter((e) => e.type === 'verification' && e.name.startsWith('Check')),
  ).toMatchObject([
    { name: 'Check: test -f a.txt', ok: true },
    { name: 'Check: false', ok: false },
  ])
})

test('a red attempt gets a fresh session on the same ticket branch with the check output', async () => {
  const { remote, clone } = throwawayRepo()
  const tracker = oneTicket()
  const requests: SessionRequest[] = []

  await run(
    clone,
    tracker,
    [
      (request) => {
        requests.push(request)
        return commits(request)
      },
      (request) => {
        requests.push(request)
        commitFile(request.directory, 'b.txt', 'b', 'Fix the test')
        return { success: true }
      },
    ],
    ['test -f b.txt || { echo b.txt missing; exit 1; }'],
  )

  expect(tracker.ticket(2).open).toBe(false)
  expect(requests.map((r) => r.forkPoint)).toEqual([
    git(remote, 'rev-parse', 'main'),
    git(remote, 'rev-parse', 'main'),
  ])
  expect(requests[0]?.feedback).toBeUndefined()
  expect(requests[1]?.feedback).toContain('test -f b.txt')
  expect(requests[1]?.feedback).toContain('b.txt missing')
})

test('without a setting there are 3 attempts; a failed session uses one up too', async () => {
  const { clone } = throwawayRepo()
  const tracker = oneTicket()
  const feedbacks: (string | undefined)[] = []
  const remember: AgentScript = (request) => {
    feedbacks.push(request.feedback)
    return { success: false }
  }

  const events = await run(clone, tracker, [
    () => ({ success: true }),
    remember,
    remember,
    remember,
  ])

  expect(feedbacks).toHaveLength(2)
  expect(feedbacks[0]).toContain('new commit since fork point')
  expect(feedbacks[1]).toContain('Session successful')
  expect(tracker.ticket(2).labels).toEqual(['ready-for-human'])
  expect(events.filter((e) => e.type === 'attempt-started')).toMatchObject([
    { attempt: 1, of: 3 },
    { attempt: 2, of: 3 },
    { attempt: 3, of: 3 },
  ])
})

test('an attempt that left the ticket branch continues on the ticket branch', async () => {
  const { clone } = throwawayRepo()
  const tracker = oneTicket()
  let inSecondSession: unknown

  await run(clone, tracker, [
    (request) => {
      commits(request)
      git(request.directory, 'checkout', '-q', '-b', 'elsewhere')
      return { success: true }
    },
    ({ directory }) => {
      inSecondSession = {
        branch: git(directory, 'branch', '--show-current'),
        log: git(directory, 'log', '--format=%s'),
      }
      return { success: true }
    },
  ])

  expect(inSecondSession).toEqual({ branch: 'ticket/2', log: 'Implement ticket 2\ninit' })
  expect(tracker.ticket(2).open).toBe(false)
})

test('an existing ticket branch is forked off afresh in the first attempt', async () => {
  const { remote, clone } = throwawayRepo()
  git(clone, 'checkout', '-q', '-b', 'ticket/2')
  commitFile(clone, 'old.txt', 'old', 'Remnant of an old run')
  git(clone, 'checkout', '-q', 'main')

  await run(clone, oneTicket(), [commits])

  expect(git(remote, 'log', '--format=%s', 'spec/1')).toBe('Implement ticket 2\ninit')
})

test('if the agent closed the ticket in a red attempt, the engine reopens it', async () => {
  const { clone } = throwawayRepo()
  const tracker = oneTicket()
  let openInSecondSession: boolean | undefined

  await run(
    clone,
    tracker,
    [
      async () => {
        await tracker.close(2)
        return { success: true }
      },
      async () => {
        openInSecondSession = tracker.ticket(2).open
        await tracker.close(2)
        return { success: true }
      },
    ],
    undefined,
    2,
  )

  expect(openInSecondSession).toBe(true)
  expect(tracker.ticket(2)).toMatchObject({ open: true, labels: ['ready-for-human'] })
})

test('after a failed ticket it goes on with the rest of the frontier', async () => {
  const { remote, clone } = throwawayRepo()
  const tracker = new InMemoryTracker('me', [
    { number: 2, open: true, assignees: [], labels: ['ready-for-agent'], blockers: [] },
    { number: 3, open: true, assignees: [], labels: ['ready-for-agent'], blockers: [] },
  ])

  const events = await run(
    clone,
    tracker,
    [
      (request) => {
        commits(request)
        return { success: false }
      },
      ({ directory }) => {
        commitFile(directory, 'b.txt', 'b', 'Implement ticket 3')
        return { success: true }
      },
    ],
    undefined,
    1,
  )

  expect(tracker.ticket(3).open).toBe(false)
  expect(git(remote, 'log', '--format=%s', 'spec/1')).toBe('Implement ticket 3\ninit')
  expect(events.filter((e) => e.type === 'ticket-failed')).toMatchObject([
    { ticket: 2, attempts: 1, verification: 'Session successful' },
  ])
})

test('several commits since the fork point become one with all messages', async () => {
  const { remote, clone } = throwawayRepo()

  await run(clone, oneTicket(), [
    (request) => {
      commits(request)
      commitFile(request.directory, 'b.txt', 'b', 'Fix review findings\n\nDetails')
      return { success: true }
    },
  ])

  expect(git(remote, 'log', '--format=%B', 'spec/1')).toBe(
    'Implement ticket 2\n\nFix review findings\n\nDetails\n\ninit',
  )
  expect(git(remote, 'show', '--format=', '--name-only', 'spec/1')).toBe('a.txt\nb.txt')
})

test('the check output for the next session is truncated from the start to 100 lines', async () => {
  const { clone } = throwawayRepo()
  let feedback: string | undefined

  await run(
    clone,
    oneTicket(),
    [
      commits,
      (request) => {
        feedback = request.feedback
        return { success: true }
      },
    ],
    ['seq 1 150; exit 1'],
    2,
  )

  expect(feedback).toContain('truncated')
  expect(feedback).toContain('\n51\n')
  expect(feedback).not.toContain('\n50\n')
  expect(feedback?.endsWith('\n150')).toBe(true)
})

test('a ticket depending on a failed ticket stays put', async () => {
  const { clone } = throwawayRepo()
  const tracker = new InMemoryTracker('me', [
    { number: 2, open: true, assignees: [], labels: ['ready-for-agent'], blockers: [] },
    {
      number: 3,
      open: true,
      assignees: [],
      labels: ['ready-for-agent'],
      blockers: [{ number: 2, open: true }],
    },
  ])

  await run(clone, tracker, [() => ({ success: false })], undefined, 1)

  expect(tracker.ticket(3)).toMatchObject({ open: true, assignees: [] })
})

/** The human's clone: on its own branch, with an uncommitted change and a new file. */
function humanAtWork(clone: string) {
  git(clone, 'checkout', '-q', '-b', 'own')
  writeFileSync(join(clone, 'README.md'), 'half-finished')
  writeFileSync(join(clone, 'new.txt'), 'x')
  const state = () => ({
    branch: git(clone, 'branch', '--show-current'),
    status: git(clone, 'status', '--porcelain', '--untracked-files=all'),
    readme: readFileSync(join(clone, 'README.md'), 'utf8'),
  })
  const before = state()
  return { state, before }
}

test.each<[string, boolean]>([
  ['green', true],
  ['red', false],
])('a %s run leaves the human’s clone on its branch with uncommitted work', async (_, success) => {
  const { clone } = throwawayRepo()
  const human = humanAtWork(clone)

  await run(
    clone,
    oneTicket(),
    [
      (request) => {
        commits(request)
        return { success }
      },
    ],
    undefined,
    1,
  )

  expect(human.state()).toEqual(human.before)
})

test('a second run reuses the worktree and discards a leftover change without asking', async () => {
  const { remote, clone } = throwawayRepo()
  const worktree = worktreeOf(clone)
  commitFile(clone, '.gitignore', 'ignored\n', 'ignore')
  git(clone, 'push', '-q', 'origin', 'main')
  // Ticket 4 stays open, so the worktree stays.
  const unfinished = new InMemoryTracker('me', [
    oneTicket().ticket(2),
    { number: 4, open: true, labels: ['ready-for-human'], assignees: [], blockers: [] },
  ])
  await run(clone, unfinished, [commits])
  // Left behind: an ignored file stays, everything else goes.
  writeFileSync(join(worktree, 'ignored'), 'x')
  writeFileSync(join(worktree, 'a.txt'), 'changed')
  writeFileSync(join(worktree, 'untracked.txt'), 'x')
  let inSession: unknown

  await run(clone, secondTicket(), [
    ({ directory }) => {
      inSession = {
        directory,
        status: git(directory, 'status', '--porcelain'),
        a: readFileSync(join(directory, 'a.txt'), 'utf8'),
        ignored: existsSync(join(directory, 'ignored')),
      }
      commitFile(directory, 'b.txt', 'b', 'Implement ticket 3')
      return { success: true }
    },
  ])

  expect(inSession).toEqual({ directory: worktree, status: '', a: 'a', ignored: true })
  expect(git(remote, 'log', '--format=%s', 'spec/1')).toBe(
    'Implement ticket 3\nImplement ticket 2\nignore\ninit',
  )
  expect(git(clone, 'rev-parse', 'spec/1')).toBe(git(remote, 'rev-parse', 'spec/1'))
})

import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { type AgentScript, fakeAgent } from './agent.ts'
import { manualClock } from './clock.ts'
import { driveRun, type Event, type RunInput } from './engine.ts'
import { git } from './git.ts'
import { passthrough } from './sandbox.ts'
import { commitFile, throwawayRepo, worktreeOf } from './testing/throwaway-repo.ts'
import { InMemoryTracker } from './tracker.ts'

/** Drives a run over spec 1 with target branch main; returns the result and the events. */
async function run(
  clone: string,
  tracker: InMemoryTracker,
  script: AgentScript[],
  input: Partial<RunInput> = {},
) {
  const events: Event[] = []
  const result = await driveRun({
    spec: 1,
    choice: { targetBranch: 'main', finish: 'none' },
    directory: clone,
    worktree: worktreeOf(clone),
    checks: ['true'],
    tracker,
    agent: fakeAgent(script),
    sandbox: passthrough,
    clock: manualClock(),
    report: (e) => events.push(e),
    ...input,
  })
  return { result, events }
}

const ticket = (number: number, label = 'ready-for-agent') => ({
  number,
  open: true,
  labels: [label],
  assignees: [] as string[],
  blockers: [],
})

const commits =
  (file: string): AgentScript =>
  ({ directory }) => {
    commitFile(directory, file, file, `Add ${file}`)
    return { success: true }
  }

/** A file outside every worktree, so that it survives the removal of one. */
const outside = () => join(mkdtempSync(join(tmpdir(), 'groundhog-')), 'ran')

test('setup runs once on a new worktree, in order, on the integration branch, and not on a reused one', async () => {
  const { clone } = throwawayRepo()
  const ran = outside()
  const setup = [`echo "one $(git branch --show-current) $PWD" >> ${ran}`, `echo two >> ${ran}`]
  // Ticket 4 stays open, so the worktree stays.
  const human = ticket(4, 'ready-for-human')

  await run(clone, new InMemoryTracker('me', [ticket(2), human]), [commits('a')], { setup })
  await run(clone, new InMemoryTracker('me', [ticket(3), human]), [commits('b')], { setup })

  expect(readFileSync(ran, 'utf8')).toBe(`one spec/1 ${worktreeOf(clone)}\ntwo\n`)
})

test('what setup changes outside the ignored files does not turn a ticket red', async () => {
  const { remote, clone } = throwawayRepo()
  const tracker = new InMemoryTracker('me', [ticket(2)])

  await run(clone, tracker, [commits('a')], {
    setup: ['echo changed > README.md', 'touch untracked'],
  })

  expect(tracker.ticket(2).open).toBe(false)
  expect(git(remote, 'show', 'spec/1:README.md')).toBe('init')
})

test('a failing setup halts the run before any ticket and removes the worktree', async () => {
  const { remote, clone } = throwawayRepo()
  const tracker = new InMemoryTracker('me', [ticket(2)])
  const ran = outside()

  const { result, events } = await run(clone, tracker, [], {
    setup: ['true', 'echo broken ghp_$(echo secret); exit 3', `touch ${ran}`],
    token: 'ghp_secret',
  })

  expect(result).toEqual({
    tickets: [],
    finish: { type: 'skipped', reason: 'setup failed' },
    halted: 'setup',
  })
  expect(events.map((e) => e.type)).toEqual(['run-started', 'run-halted', 'run-finished'])
  expect(events[1]).toMatchObject({
    reason: 'setup',
    command: 'echo broken ghp_$(echo secret); exit 3',
    output: 'broken ***\n',
  })
  expect(tracker.ticket(2)).toEqual(ticket(2))
  expect(existsSync(ran)).toBe(false)
  expect(existsSync(worktreeOf(clone))).toBe(false)
  expect(git(clone, 'worktree', 'list')).not.toContain(worktreeOf(clone))
  expect(git(remote, 'branch', '--list', 'spec/1')).toBe('')
})

test('the start after a failing setup creates the worktree again and runs setup again', async () => {
  const { clone } = throwawayRepo()
  const ran = outside()
  const setup = [`echo ran >> ${ran}; test $(wc -l < ${ran}) -gt 1`]
  const tracker = new InMemoryTracker('me', [ticket(2)])

  await run(clone, tracker, [], { setup })
  await run(clone, tracker, [commits('a')], { setup })

  expect(readFileSync(ran, 'utf8')).toBe('ran\nran\n')
  expect(tracker.ticket(2).open).toBe(false)
})

test('setup is ended after 15 minutes and counts as failed, even with exit 0', async () => {
  const { clone } = throwawayRepo()
  const clock = manualClock()

  const { result, events } = await run(clone, new InMemoryTracker('me', [ticket(2)]), [], {
    setup: ['npm ci'],
    clock,
    sandbox: {
      execute: async () => {
        clock.advance(15 * 60_000)
        return { exitCode: 0, output: '' }
      },
    },
  })

  expect(result.halted).toBe('setup')
  expect(events[1]).toMatchObject({ output: expect.stringContaining('ended after 15 minutes') })
})

test('an abort during setup takes no ticket, and the next run runs setup again', async () => {
  const { clone } = throwawayRepo()
  const tracker = new InMemoryTracker('me', [ticket(2)])
  const abort = new AbortController()
  const ran = outside()
  const setup = [`echo ran >> ${ran}`]

  const { result, events } = await run(clone, tracker, [], {
    setup,
    abort: abort.signal,
    sandbox: {
      execute: async () => {
        abort.abort()
        return { exitCode: 1, output: '' }
      },
    },
  })

  expect(result).toMatchObject({ halted: 'aborted' })
  expect(events.map((e) => e.type)).toEqual(['run-started', 'run-finished'])
  expect(tracker.ticket(2)).toEqual(ticket(2))
  expect(git(worktreeOf(clone), 'branch', '--show-current')).toBe('spec/1')

  await run(clone, tracker, [commits('a')], { setup })

  expect(readFileSync(ran, 'utf8')).toBe('ran\n')
  expect(tracker.ticket(2).open).toBe(false)
})

test('a worktree whose setup never ran through, as after a crash, is set up again', async () => {
  const { clone } = throwawayRepo()
  const tracker = new InMemoryTracker('me', [ticket(2)])
  const ran = outside()
  const setup = [`echo ran >> ${ran}`]
  const crash = {
    execute: async () => {
      throw new Error('crash')
    },
  }

  await expect(run(clone, tracker, [], { setup, sandbox: crash })).rejects.toThrow('crash')
  await run(clone, tracker, [commits('a')], { setup })

  expect(readFileSync(ran, 'utf8')).toBe('ran\n')
  expect(tracker.ticket(2).open).toBe(false)
})

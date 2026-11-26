import { expect, test } from 'vitest'
import { type AgentScript, fakeAgent } from './agent.ts'
import { manualClock } from './clock.ts'
import { git } from './git.ts'
import { passthrough } from './sandbox.ts'
import { commitFile, throwawayRepo } from './testing/throwaway-repo.ts'
import { ticketFlow } from './ticket-flow.ts'
import { InMemoryTracker } from './tracker.ts'

const ticket = { number: 2, open: true, labels: ['ready-for-agent'], assignees: [], blockers: [] }

/** Takes ticket 2 of spec 1 through its flow, in a clone that stands in for the worktree. */
async function flow(script: AgentScript[], abort = new AbortController()) {
  const { clone } = throwawayRepo()
  git(clone, 'checkout', '-q', '-b', 'spec/1')
  const outcome = await ticketFlow(ticket, {
    spec: 1,
    worktree: clone,
    checks: ['true'],
    maxAttempts: 2,
    tracker: new InMemoryTracker('me', [ticket]),
    agent: fakeAgent(script),
    sandbox: passthrough,
    clock: manualClock(),
    abort: abort.signal,
    report: () => {},
    filter: (text) => text,
    comment: async () => {},
    discard: () => {},
  })
  return { outcome, clone }
}

const commits: AgentScript = ({ directory }) => {
  commitFile(directory, 'a.txt', 'a', 'Implement ticket 2')
  return { success: true }
}

const fails: AgentScript = () => ({ success: false })

test('a green ticket ends done, with its commit in the integration branch', async () => {
  const { outcome, clone } = await flow([fails, commits])

  expect(outcome).toEqual({ result: 'done', attempts: 2, commit: expect.any(String) })
  expect(git(clone, 'log', '-1', '--format=%s', 'spec/1')).toBe('Implement ticket 2')
})

test('a ticket without a green attempt ends failed, with the last red verification', async () => {
  const { outcome } = await flow([fails, fails])

  expect(outcome).toEqual({ result: 'failed', attempts: 2, verification: 'Session successful' })
})

test('a usage limit without reset time halts the ticket for credit', async () => {
  const { outcome, clone } = await flow([() => ({ success: false, usageLimit: 'credit' })])

  expect(outcome).toEqual({ result: 'halted', reason: 'credit' })
  expect(git(clone, 'branch', '--show-current')).toBe('ticket/2')
})

test('an abort halts the ticket and removes its branch', async () => {
  const abort = new AbortController()
  const { outcome, clone } = await flow(
    [
      () => {
        abort.abort()
        return { success: false }
      },
    ],
    abort,
  )

  expect(outcome).toEqual({ result: 'halted', reason: 'aborted' })
  expect(git(clone, 'branch', '--list', 'ticket/2')).toBe('')
})

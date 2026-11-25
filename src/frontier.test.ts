import { expect, test } from 'vitest'
import { type AgentScript, fakeAgent } from './agent.ts'
import { manualClock } from './clock.ts'
import { driveRun } from './engine.ts'
import { passthrough } from './sandbox.ts'
import { commitFile, throwawayRepo } from './testing/throwaway-repo.ts'
import { InMemoryTracker, type Ticket } from './tracker.ts'

/** A workable ticket, unless `part` says otherwise. */
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

/** Drives a whole run over spec 1; returns the numbers of the taken tickets in order. */
async function taken(
  tracker: InMemoryTracker,
  script: AgentScript[] = Array(10).fill(implementsTicket),
): Promise<number[]> {
  const numbers: number[] = []
  await driveRun({
    spec: 1,
    choice: { targetBranch: 'main', finish: 'none' },
    directory: throwawayRepo().clone,
    checks: [],
    tracker,
    agent: fakeAgent(script),
    sandbox: passthrough,
    clock: manualClock(),
    report: (e) => {
      if (e.type === 'ticket-taken') numbers.push(e.ticket)
    },
  })
  return numbers
}

test('without ready-for-agent or with ready-for-human a ticket is skipped', async () => {
  const tracker = new InMemoryTracker('me', [
    ticket(2, { labels: [] }),
    ticket(3, { labels: ['ready-for-human'] }),
    ticket(4, { labels: ['ready-for-agent', 'ready-for-human'] }),
    ticket(5, { labels: ['needs-triage'] }),
    ticket(6),
  ])

  expect(await taken(tracker)).toEqual([6])
})

test('an open blocker blocks, even outside the spec; a closed one releases', async () => {
  const tracker = new InMemoryTracker('me', [
    ticket(2, { blockers: [{ number: 99, open: true }] }),
    ticket(3, { blockers: [{ number: 98, open: false }] }),
  ])

  expect(await taken(tracker)).toEqual([3])
})

test('a ticket becomes free as soon as the engine has closed its blocker', async () => {
  const tracker = new InMemoryTracker('me', [
    ticket(2, { blockers: [{ number: 4, open: true }] }),
    ticket(3, { blockers: [{ number: 2, open: true }] }),
    ticket(4),
  ])

  expect(await taken(tracker)).toEqual([4, 2, 3])
})

test('a ticket assigned to someone else is skipped, one assigned to me is taken', async () => {
  const tracker = new InMemoryTracker('me', [
    ticket(2, { assignees: ['you'] }),
    ticket(3, { assignees: ['me', 'you'] }),
    ticket(4, { assignees: ['me'] }),
  ])

  expect(await taken(tracker)).toEqual([4])
})

test('the engine takes the lowest number from the frontier', async () => {
  const tracker = new InMemoryTracker('me', [ticket(5), ticket(3), ticket(4)])

  expect(await taken(tracker)).toEqual([3, 4, 5])
})

test('a change in the tracker during the run applies from the next ticket on', async () => {
  const tracker = new InMemoryTracker('me', [
    ticket(2),
    ticket(3, { labels: [] }),
    ticket(4),
    ticket(5, { blockers: [{ number: 99, open: true }] }),
  ])

  const order = await taken(tracker, [
    (request) => {
      tracker.change(3, (t) => t.labels.push('ready-for-agent'))
      tracker.change(4, (t) => t.assignees.push('you'))
      tracker.change(5, (t) => {
        t.blockers = [{ number: 99, open: false }]
      })
      return implementsTicket(request)
    },
    implementsTicket,
    implementsTicket,
  ])

  expect(order).toEqual([2, 3, 5])
})

test('a tracker error aborts the run without making a ticket red', async () => {
  const tracker = new InMemoryTracker('me', [ticket(2), ticket(3)])
  const taskGraph = tracker.taskGraph.bind(tracker)
  let queries = 0
  tracker.taskGraph = async () => {
    if (++queries > 1) throw new Error('gh: unreachable')
    return taskGraph()
  }
  const types: string[] = []

  const run = driveRun({
    spec: 1,
    choice: { targetBranch: 'main', finish: 'none' },
    directory: throwawayRepo().clone,
    checks: [],
    tracker,
    agent: fakeAgent([implementsTicket, implementsTicket]),
    sandbox: passthrough,
    clock: manualClock(),
    report: (e) => types.push(`${e.type} ${'ticket' in e ? e.ticket : ''}`),
  })

  await expect(run).rejects.toThrow('gh: unreachable')
  expect(types.filter((a) => a.startsWith('ticket'))).toEqual(['ticket-taken 2', 'ticket-done 2'])
  expect(tracker.ticket(3)).toMatchObject({ open: true, assignees: [] })
})

test('the dependents of a skipped ticket stay blocked', async () => {
  const tracker = new InMemoryTracker('me', [
    ticket(2, { labels: ['ready-for-human'] }),
    ticket(3, { blockers: [{ number: 2, open: true }] }),
    ticket(4, { blockers: [{ number: 3, open: true }] }),
  ])

  expect(await taken(tracker)).toEqual([])
})

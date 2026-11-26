import { expect, test } from 'vitest'
import { herdr, herdrAgent, herdrStart } from './herdr.ts'
import type { Event } from './run-state.ts'
import { frontierState, type Ticket } from './tracker.ts'

const ticket = (number: number, open = true): Ticket => ({
  number,
  open,
  labels: [],
  assignees: [],
  blockers: [],
})
const graph = (...tickets: Ticket[]): Event => ({
  type: 'task-graph',
  tickets: tickets.map((t) => ({ ...t, state: frontierState(t, 'me') })),
  time: 0,
})
const taken = (nr: number): Event => ({ type: 'ticket-taken', ticket: nr, time: 0 })
const started: Event = {
  type: 'run-started',
  spec: 25,
  choice: { targetBranch: 'main', finish: 'merge' },
  worktree: '/worktrees/spec-25',
  versions: {},
  time: 0,
}

/** The sequences groundhog writes for the events in a Herdr terminal. */
function sequences(events: Event[]): string[] {
  const report = herdr({ HC_TERMINAL_ID: 't1' }, true)
  return events.flatMap((e) => report(e) ?? [])
}

test('while the start asks its questions, groundhog reports blocked', () => {
  expect(herdrStart({ HC_TERMINAL_ID: 't1' }, true)).toBe(
    `\x1b]7501;state=blocked:app=groundhog:msg=${btoa('Start')}:progress=0\x07`,
  )
  expect(herdrStart({}, true)).toBe('')
  expect(herdrStart({ HC_TERMINAL_ID: 't1' }, false)).toBe('')
})

test('from the start of the run on, groundhog reports working with the spec, then with the current ticket and the share of closed tickets', () => {
  expect(sequences([started, graph(ticket(2, false), ticket(3), ticket(4)), taken(3)])).toEqual([
    `\x1b]7501;state=working:app=groundhog:msg=${btoa('Spec #25')}:progress=0\x07`,
    `\x1b]7501;state=working:app=groundhog:msg=${btoa('Ticket #3')}:progress=33\x07`,
  ])
})

const finished: Event = {
  type: 'run-finished',
  finish: { type: 'none' },
  summary: '',
  time: 0,
}
const done = (nr: number): Event => ({
  type: 'ticket-done',
  ticket: nr,
  commit: 'abc',
  attempts: 1,
  time: 0,
})
const failed = (nr: number): Event => ({
  type: 'ticket-failed',
  ticket: nr,
  attempts: 3,
  verification: 'Check: npm test',
  time: 0,
})

test('at the end groundhog reports done if no ticket failed', () => {
  expect(
    sequences([
      started,
      graph(ticket(2), ticket(3)),
      taken(2),
      done(2),
      graph(ticket(2, false), ticket(3)),
      taken(3),
      done(3),
      graph(ticket(2, false), ticket(3, false)),
      finished,
    ]),
  ).toEqual([
    `\x1b]7501;state=working:app=groundhog:msg=${btoa('Spec #25')}:progress=0\x07`,
    `\x1b]7501;state=working:app=groundhog:msg=${btoa('Ticket #2')}:progress=0\x07`,
    `\x1b]7501;state=working:app=groundhog:msg=${btoa('Ticket #3')}:progress=50\x07`,
    `\x1b]7501;state=done:app=groundhog:msg=${btoa('Spec #25')}:progress=100\x07`,
  ])
})

test('at the end groundhog reports error if at least one ticket failed for good', () => {
  expect(
    sequences([
      started,
      graph(ticket(2), ticket(3)),
      taken(2),
      failed(2),
      graph(ticket(2), ticket(3)),
      taken(3),
      done(3),
      graph(ticket(2), ticket(3, false)),
      finished,
    ]).at(-1),
  ).toBe(`\x1b]7501;state=error:app=groundhog:msg=${btoa('Spec #25')}:progress=50\x07`)
})

test('without HC_TERMINAL_ID or without a terminal on stdout groundhog reports nothing', () => {
  const run = [started, graph(ticket(2)), taken(2), failed(2), graph(ticket(2)), finished]
  for (const report of [herdr({}, true), herdr({ HC_TERMINAL_ID: 't1' }, false)]) {
    expect(run.map(report).filter(Boolean)).toEqual([])
  }
})

/** The herdr CLI calls groundhog makes for the events in a Herdr pane, without --seq. */
function calls(events: Event[]): string[][] {
  const agent = herdrAgent({ HERDR_ENV: '1', HERDR_PANE_ID: 'w1:p1' })
  const all = [...events.map(agent.report), agent.release()]
  return all.flatMap((c) => (c ? [c.slice(0, -2)] : []))
}
const id = ['--source', 'custom:groundhog', '--agent', 'groundhog']

test('in Herdr groundhog is agent groundhog: working from the start, the message names the ticket, released at the end', () => {
  expect(calls([started, graph(ticket(2)), taken(2), done(2), finished])).toEqual([
    ['pane', 'report-agent', 'w1:p1', ...id, '--state', 'working', '--message', 'Spec #25'],
    ['pane', 'report-agent', 'w1:p1', ...id, '--state', 'working', '--message', 'Ticket #2'],
    ['pane', 'release-agent', 'w1:p1', ...id],
  ])
})

test('each Herdr call carries a higher --seq than the one before', () => {
  const agent = herdrAgent({ HERDR_ENV: '1', HERDR_PANE_ID: 'w1:p1' })
  const seqs = [agent.report(started), agent.report(taken(2)), agent.release()].map((c) =>
    Number(c?.at(-1)),
  )
  expect(seqs).toEqual([...seqs].sort((a, b) => a - b))
  expect(new Set(seqs).size).toBe(3)
})

test('outside Herdr, or before anything was reported, groundhog calls no herdr', () => {
  for (const env of [{}, { HERDR_PANE_ID: 'w1:p1' }]) {
    const agent = herdrAgent(env)
    expect([started, taken(2), finished].map(agent.report).filter(Boolean)).toEqual([])
    expect(agent.release()).toBeUndefined()
  }
  expect(herdrAgent({ HERDR_ENV: '1', HERDR_PANE_ID: 'w1:p1' }).release()).toBeUndefined()
})

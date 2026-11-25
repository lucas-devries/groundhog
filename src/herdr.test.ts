import { expect, test } from 'vitest'
import type { Event } from './engine.ts'
import { herdr } from './herdr.ts'
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
  versions: {},
  time: 0,
}

/** The sequences groundhog writes for the events in a Herdr terminal. */
function sequences(events: Event[]): string[] {
  const report = herdr({ HC_TERMINAL_ID: 't1' }, true)
  return events.flatMap((e) => report(e) ?? [])
}

test('from the first ticket on, groundhog reports working with the current ticket and the share of closed tickets', () => {
  expect(sequences([started, graph(ticket(2, false), ticket(3), ticket(4)), taken(3)])).toEqual([
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

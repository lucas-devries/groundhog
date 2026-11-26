import { expect, test } from 'vitest'
import { type Event, fold, newRunState, type RunEvent, type TicketEvent } from './run-state.ts'
import { frontierState, type Ticket } from './tracker.ts'

/** The state after the events; each event happens one millisecond after the one before. */
function after(...events: (RunEvent | TicketEvent)[]) {
  return events.map((e, time): Event => ({ ...e, time })).reduce(fold, newRunState())
}

const started: RunEvent = {
  type: 'run-started',
  spec: 25,
  choice: { targetBranch: 'main', finish: 'merge' },
  worktree: '/worktrees/spec-25',
  versions: {},
}
const ticket = (number: number, open = true): Ticket => ({
  number,
  open,
  labels: [],
  assignees: [],
  blockers: [],
})
const graph = (...tickets: Ticket[]): RunEvent => ({
  type: 'task-graph',
  tickets: tickets.map((t) => ({ ...t, state: frontierState(t, 'me') })),
})
const taken: TicketEvent = { type: 'ticket-taken', ticket: 27 }
const attempt = (n: number): TicketEvent => ({
  type: 'attempt-started',
  ticket: 27,
  attempt: n,
  of: 3,
})
const output: TicketEvent = { type: 'session-output', ticket: 27, session: 2, line: '{}' }
const finished = (session: number, part: object = {}): TicketEvent => ({
  type: 'session-finished',
  ticket: 27,
  session,
  attempt: 1,
  success: true,
  ...part,
})
const pause: TicketEvent = { type: 'pause', ticket: 27, reset: 1000 }

test('a ticket goes from taken through its attempts to done', () => {
  const run = [taken, attempt(1)]
  expect(after(taken).tickets.get(27)).toMatchObject({ start: 0, attempt: 0, of: 0 })
  expect(after(taken).tickets.get(27)?.status).toBeUndefined()
  expect(after(...run).tickets.get(27)).toMatchObject({ status: 'running', attempt: 1, of: 3 })

  const check = (ok: boolean): TicketEvent => ({
    type: 'verification',
    ticket: 27,
    name: 'Check: npm test',
    ok,
  })
  expect(after(...run, check(true)).tickets.get(27)?.status).toBe('running')
  expect(after(...run, check(false)).tickets.get(27)?.status).toBe('attempt-failed')

  const done = after(...run, check(false), attempt(2), {
    type: 'ticket-done',
    ticket: 27,
    commit: 'abc',
    attempts: 2,
  })
  expect(done.tickets.get(27)).toMatchObject({
    status: 'done',
    attempt: 2,
    commit: 'abc',
    start: 0,
    end: 4,
  })
})

test('a ticket that failed for good keeps its red verification', () => {
  const state = after(taken, attempt(3), {
    type: 'ticket-failed',
    ticket: 27,
    attempts: 3,
    verification: 'Check: npm test',
  })
  expect(state.tickets.get(27)).toMatchObject({
    status: 'failed',
    attempt: 3,
    verification: 'Check: npm test',
    end: 2,
  })
})

test('a paused ticket runs again as soon as a session of it reports', () => {
  const paused = [taken, attempt(1), finished(1), pause]
  expect(after(...paused).tickets.get(27)).toMatchObject({
    status: 'paused',
    pause: { reset: 1000, time: 3 },
  })
  expect(after(...paused, output).tickets.get(27)?.status).toBe('running')
  expect(after(...paused, finished(2)).tickets.get(27)?.status).toBe('running')
  // A session that ends outside a pause changes nothing about the state.
  const red: TicketEvent = { type: 'verification', ticket: 27, name: 'x', ok: false }
  expect(after(taken, attempt(1), red, finished(1)).tickets.get(27)?.status).toBe('attempt-failed')
})

test('waiting on after the reset stays the same pause', () => {
  expect(after(taken, pause, pause).tickets.get(27)?.pauses).toBe(1)
  expect(after(taken, pause, output, finished(2), pause).tickets.get(27)?.pauses).toBe(2)
})

test('the sessions of a ticket add up their blocks; the last one counts for resuming', () => {
  const block = (command: string) => ({ tool: 'Bash', command })
  const state = after(
    taken,
    finished(1, { sessionId: 'a', blocks: [block('one')] }),
    finished(2, { sessionId: 'b', blocks: [block('two')] }),
  )
  expect(state.tickets.get(27)).toMatchObject({
    sessionId: 'b',
    blocks: [block('one'), block('two')],
  })
  expect(state.lastSession).toEqual({ ticket: 27, session: 2 })
})

test('progress is the share of closed tickets in the latest task-graph', () => {
  expect(after(started).progress).toBe(0)
  expect(after(graph(ticket(2, false), ticket(3), ticket(4))).progress).toBe(33)
  expect(after(graph(ticket(2)), graph(ticket(2, false))).progress).toBe(100)
  expect(after(graph()).progress).toBe(100)
})

test('the head of the integration branch moves only with pushes to it', () => {
  const push = (branch: string, commit: string): RunEvent => ({ type: 'push', branch, commit })
  expect(after(started).integration).toBe('spec/25')
  expect(after(started, push('spec/25', 'a'), push('main', 'b')).head).toBe('a')
})

test('the state keeps how the run started and ended', () => {
  const state = after(started, { type: 'run-finished', finish: { type: 'none' }, summary: '' })
  expect(state.started).toMatchObject({ spec: 25, time: 0 })
  expect(state.finished).toMatchObject({ finish: { type: 'none' }, time: 1 })
})

import { EventEmitter } from 'node:events'
import { expect, test } from 'vitest'
import { board, showBoard } from './board.ts'
import type { Event } from './engine.ts'
import { frontierState, type Ticket } from './tracker.ts'

/** The board's screen after a sequence of events, without colours. */
function screen(events: Event[], width = 60, height = 14): string[] {
  const b = board()
  for (const e of events) b.report(e)
  return b.screen(width, height)
}

const ticket = (number: number, part: Partial<Ticket> = {}): Ticket => ({
  number,
  open: true,
  labels: ['ready-for-agent'],
  assignees: [],
  blockers: [],
  ...part,
})
const started: Event = {
  type: 'run-started',
  spec: 25,
  choice: { targetBranch: 'main', finish: 'pr' },
  versions: { groundhog: '1.2.3' },
  time: 0,
}
const graph = (...tickets: Ticket[]): Event => ({
  type: 'task-graph',
  tickets: tickets.map((t) => ({ ...t, state: frontierState(t, 'me') })),
  time: 0,
})
const assistant = (ticket: number, text: string, session = 1): Event => ({
  type: 'session-output',
  ticket,
  session,
  line: JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text }] } }),
  time: 0,
})
const rule = '─'.repeat(60)

test('before the first ticket: header and the task-graph with the state from the tracker', () => {
  expect(
    screen([
      started,
      graph(
        ticket(26, { open: false }),
        ticket(27),
        ticket(28, {
          blockers: [
            { number: 27, open: true },
            { number: 9, open: false },
          ],
        }),
        ticket(29, { labels: ['ready-for-human'] }),
        ticket(30, { labels: [] }),
      ),
    ]),
  ).toEqual([
    'groundhog 1.2.3 · Spec #25 · target branch main · finish PR',
    '',
    '  #26 ✔ done',
    '  #27 · waiting',
    '  #28 ○ blocked by #27',
    '  #29 – ready-for-human, not touched',
    '  #30 – not released',
    rule,
    '',
    '',
    '',
    '',
    rule,
    '',
  ])
})

test('a ticket goes through its states; the transcripts of every session stay in order', () => {
  const run: Event[] = [started, graph(ticket(27), ticket(28))]
  const state = (...more: Event[]) => {
    run.push(...more)
    // Tall enough for every transcript line of this test.
    return screen(run, 60, 16)
  }
  const attempt = (n: number): Event => ({
    type: 'attempt-started',
    ticket: 27,
    attempt: n,
    of: 3,
    time: 0,
  })
  const verification = (name: string, ok: boolean): Event => ({
    type: 'verification',
    ticket: 27,
    name,
    ok,
    time: 0,
  })

  let s = state({ type: 'ticket-taken', ticket: 27, time: 0 }, attempt(1), assistant(27, 'one'))
  expect(s[2]).toBe('  #27 ▶ running · Attempt 1 of 3')
  expect(s[3]).toBe('  #28 · waiting')
  expect(s.slice(5, 8)).toEqual(['━━ #27 · Attempt 1 of 3', '  │ one', ''])
  expect(s.at(-1)).toBe('#27 · Attempt 1 of 3')

  s = state(
    verification('Session successful', true),
    verification('new commit since fork point', false),
  )
  expect(s[2]).toBe('  #27 ↻ Attempt 1 of 3 failed')
  expect(s.slice(6, 10)).toEqual([
    '  │ one',
    '  ✔ Session successful',
    '  ✘ new commit since fork point',
    '',
  ])

  // The next attempt follows below the previous one.
  s = state(attempt(2), assistant(27, 'two', 2))
  expect(s[2]).toBe('  #27 ▶ running · Attempt 2 of 3')
  expect(s.slice(9, 12)).toEqual(['━━ #27 · Attempt 2 of 3', '  │ two', ''])
  expect(s.at(-1)).toBe('#27 · Attempt 2 of 3')

  // Pause at the usage limit; the restart of the same attempt is a new session.
  state({
    type: 'session-finished',
    ticket: 27,
    session: 2,
    attempt: 2,
    success: false,
    blocks: [{ tool: 'Bash', command: 'curl example.com', reason: 'refused' }],
    time: 0,
  })
  const reset = new Date(2026, 10, 25, 3, 10).getTime()
  s = state({ type: 'pause', ticket: 27, reset, time: reset - 60_000 })
  expect(s[2]).toBe('  #27 ⏸ Pause at usage limit until 03:10')
  s = state(assistant(27, 'three', 3))
  expect(s[2]).toBe('  #27 ▶ running · Attempt 2 of 3')
  expect(s.slice(6, 14)).toEqual([
    '  │ one',
    '  ✔ Session successful',
    '  ✘ new commit since fork point',
    '━━ #27 · Attempt 2 of 3',
    '  │ two',
    '  ⛔ Block: Bash curl example.com',
    '  ⏸ Usage limit reached, pause until 03:10',
    '  │ three',
  ])

  s = state(
    { type: 'ticket-done', ticket: 27, commit: 'abc1234def', attempts: 2, time: 0 },
    graph(ticket(27, { open: false }), ticket(28)),
  )
  expect(s[2]).toBe('  #27 ✔ done in attempt 2')
})

test('a ticket that failed for good shows its reason and blocks its dependents', () => {
  const s = screen([
    started,
    graph(ticket(27), ticket(28, { blockers: [{ number: 27, open: true }] })),
    { type: 'ticket-taken', ticket: 27, time: 0 },
    { type: 'ticket-failed', ticket: 27, attempts: 3, verification: 'Check: npm test', time: 0 },
    graph(
      ticket(27, { labels: ['ready-for-human'] }),
      ticket(28, { blockers: [{ number: 27, open: true }] }),
    ),
  ])
  expect(s.slice(2, 4)).toEqual([
    '  #27 ✘ ready-for-human · Check: npm test',
    '  #28 ○ blocked by #27',
  ])
})

test('warnings of the engine stand above the transcript', () => {
  const s = screen([
    started,
    graph(ticket(27)),
    { type: 'warning', text: 'Comment on #27 failed: offline', time: 0 },
  ])
  expect(s.slice(3, 5)).toEqual(['⚠ Comment on #27 failed: offline', rule])
})

test('overlong lines are truncated, the transcript shows its end, the screen always has exactly the height', () => {
  const long = 'x'.repeat(100)
  const lines = Array.from({ length: 20 }, (_, i) => assistant(27, `line ${i + 1}`))
  const run: Event[] = [
    started,
    graph(ticket(27)),
    { type: 'attempt-started', ticket: 27, attempt: 1, of: 3, time: 0 },
    ...lines,
    assistant(27, long),
  ]
  const b = board()
  for (const e of run) b.report(e)

  const s = b.screen(40, 10)
  expect(s).toHaveLength(10)
  expect(s.every((l) => l.length <= 40)).toBe(true)
  expect(s.slice(4, 9)).toEqual([
    '  │ line 18',
    '  │ line 19',
    '  │ line 20',
    `  │ ${'x'.repeat(35)}…`,
    '─'.repeat(40),
  ])

  // A smaller window: nothing overflows, not even the task-graph.
  expect(b.screen(18, 3)).toEqual(['groundhog 1.2.3 ·…', '─'.repeat(18), '#27 · Attempt 1 o…'])
})

test('the board holds the last 10,000 transcript lines and drops older ones', () => {
  const b = board()
  b.report(started)
  for (let i = 1; i <= 10_001; i++) b.report(assistant(27, `line ${i}`))
  b.report({ type: 'verification', ticket: 27, name: 'Check: npm test', ok: true, time: 0 })

  // A window taller than the limit shows everything the board holds.
  const s = b.screen(60, 10_010)
  expect(s).toContain('  │ line 3')
  expect(s).not.toContain('  │ line 2')
  expect(s.filter((l) => l.startsWith('  ')).length).toBe(10_000)
})

test('with colours, truncation is ANSI-safe', () => {
  const b = board({ color: true })
  b.report(started)
  const [header] = b.screen(12, 3)
  expect(header).toBe('\x1b[2mgroundhog 1…\x1b[0m')
})

test('in the terminal: alternate screen, redrawn on event and resize, closing lines on the normal screen', () => {
  const written: string[] = []
  const out = Object.assign(new EventEmitter(), {
    columns: 30,
    rows: 6,
    write: (t: string) => written.push(t),
  }) as unknown as NodeJS.WriteStream
  const { report } = showBoard(out, '/repo/.git/groundhog/runs/x')
  expect(written.shift()).toBe('\x1b[?1049h\x1b[?25l\x1b[?7l')

  report(started)
  report(graph(ticket(27)))
  expect(written).toHaveLength(2)
  out.rows = 4
  out.emit('resize')
  expect(written.pop()?.split('\x1b[K\n')).toHaveLength(4)

  written.length = 0
  report({ type: 'run-finished', finish: { type: 'none' }, summary: '# Summary', time: 0 })
  expect(written[0]).toBe('\x1b[?7h\x1b[?25h\x1b[?1049l')
  expect(written).toContain('# Summary\n')
  expect(written.at(-1)).toBe('Summary: /repo/.git/groundhog/runs/x/summary.md\n')

  // Afterwards nothing draws over the closing lines any more.
  out.emit('resize')
  expect(written.at(-1)).toBe('Summary: /repo/.git/groundhog/runs/x/summary.md\n')
})

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
  worktree: '/worktrees/spec-25',
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
  expect(s[2]).toBe('  #27 ▶ running')
  expect(s[3]).toBe('  #28 · waiting')
  expect(s.slice(5, 8)).toEqual(['━━ #27', '  │ one', ''])
  expect(s.at(-1)).toBe('#27')

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

/** The task-graph lines of the top, between the header and the rule. */
const graphLines = (s: string[]) => s.slice(2, s.indexOf(rule))
/** Tickets 1 to `count`, the ones in `closed` already done. */
const numbered = (count: number, closed: number[] = []) =>
  graph(
    ...Array.from({ length: count }, (_, i) => ticket(i + 1, { open: !closed.includes(i + 1) })),
  )

test('more tickets than half the window: done tickets are left out first, in tracker order', () => {
  // Half of 14 lines: header, blank and five lines of task-graph.
  const s = screen([started, numbered(7, [1, 3, 4])])
  expect(s.slice(0, 8)).toEqual([
    'groundhog 1.2.3 · Spec #25 · target branch main · finish PR',
    '',
    '  #2 · waiting',
    '  #5 · waiting',
    '  #6 · waiting',
    '  #7 · waiting',
    '  … 3 more tickets',
    rule,
  ])
  expect(s).toHaveLength(14)
})

test('only as many done tickets are left out as needed; tickets that just fit all stay', () => {
  // Half of 15 lines is seven: header, blank and five lines of task-graph.
  expect(graphLines(screen([started, numbered(5, [1, 2])], 60, 15))).toEqual([
    '  #1 ✔ done',
    '  #2 ✔ done',
    '  #3 · waiting',
    '  #4 · waiting',
    '  #5 · waiting',
  ])
  expect(graphLines(screen([started, numbered(6, [1, 2, 3])], 60, 15))).toEqual([
    '  #1 ✔ done',
    '  #4 · waiting',
    '  #5 · waiting',
    '  #6 · waiting',
    '  … 2 more tickets',
  ])
})

test('running, paused and failed tickets are never left out', () => {
  const attempt = (ticket: number): Event => ({
    type: 'attempt-started',
    ticket,
    attempt: 1,
    of: 3,
    time: 0,
  })
  const reset = new Date(2026, 10, 25, 3, 10).getTime()
  const run: Event[] = [
    started,
    numbered(9),
    attempt(2),
    { type: 'ticket-done', ticket: 2, commit: 'abc1234def', attempts: 1, time: 0 },
    attempt(6),
    { type: 'ticket-failed', ticket: 6, attempts: 3, verification: 'Check: npm test', time: 0 },
    attempt(7),
    { type: 'pause', ticket: 7, reset, time: reset - 60_000 },
    attempt(8),
    { type: 'verification', ticket: 8, name: 'Check: npm test', ok: false, time: 0 },
    attempt(9),
  ]
  const kept = [
    '  #6 ✘ ready-for-human · Check: npm test',
    '  #7 ⏸ Pause at usage limit until 03:10',
    '  #8 ↻ Attempt 1 of 3 failed',
    '  #9 ▶ running',
  ]
  // The ticket done in this run goes before the waiting ones.
  expect(graphLines(screen(run, 60, 16))).toEqual(['  #1 · waiting', ...kept, '  … 4 more tickets'])
  // Even where half the window is not enough for them.
  const s = screen(run, 60, 10)
  expect(graphLines(s)).toEqual([...kept, '  … 5 more tickets'])
  expect(s).toHaveLength(10)
})

test('warnings and the summary line count towards half the window', () => {
  const warning = (n: number): Event => ({ type: 'warning', text: `warning ${n}`, time: 0 })
  const s = screen([started, numbered(8), warning(1)], 60, 12)
  expect(s.slice(2, 7)).toEqual([
    '  #1 · waiting',
    '  #2 · waiting',
    '  … 6 more tickets',
    '⚠ warning 1',
    rule,
  ])
  const crowded = screen([started, numbered(8), ...[1, 2, 3, 4, 5].map(warning)], 60, 12)
  expect(crowded.slice(2, 7)).toEqual([
    '  … 8 more tickets',
    '⚠ warning 1',
    '⚠ warning 2',
    '⚠ warning 3',
    rule,
  ])
  expect(crowded).toHaveLength(12)
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
  expect(b.screen(18, 3)).toEqual(['groundhog 1.2.3 ·…', '─'.repeat(18), '#27'])
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

/** Bytes as terminals send them. */
const KEY = {
  up: '\x1b[A',
  down: '\x1b[B',
  pageUp: '\x1b[5~',
  pageDown: '\x1b[6~',
  home: '\x1b[H',
  end: '\x1b[F',
  // SGR mouse reports: button, column, row.
  wheelUp: '\x1b[<64;5;5M',
  wheelDown: '\x1b[<65;5;5M',
}

/**
 * A board with the transcript lines 1 to `count`, in a window of 60 × 10: four lines of top,
 * four of transcript, rule and footer.
 */
function scrollable(count = 20) {
  const b = board()
  b.report(started)
  b.report(graph(ticket(27)))
  let n = 0
  const say = (more: number) => {
    for (let i = 0; i < more; i++) b.report(assistant(27, `line ${++n}`))
  }
  say(count)
  const view = (height = 10) => b.screen(60, height)
  /** Numbers of the transcript lines on the screen. */
  const shown = (height = 10) =>
    view(height)
      .flatMap((l) => l.match(/^ {2}│ line (\d+)$/)?.[1] ?? [])
      .map(Number)
  view()
  return { b, say, view, shown }
}

test('↑ and ↓ scroll the transcript by one line; the top of the board stays', () => {
  const { b, view, shown } = scrollable()
  const top = view().slice(0, 4)
  b.input(KEY.up)
  b.input(Buffer.from(KEY.up))
  expect(shown()).toEqual([15, 16, 17, 18])
  expect(view().slice(0, 4)).toEqual(top)
  b.input(KEY.down)
  expect(shown()).toEqual([16, 17, 18, 19])
})

test('PgUp and PgDn page by the transcript height minus one, Home and End jump to the ends', () => {
  const { b, shown } = scrollable()
  b.input(KEY.pageUp)
  expect(shown()).toEqual([14, 15, 16, 17])
  b.input(KEY.pageUp)
  expect(shown()).toEqual([11, 12, 13, 14])
  b.input(KEY.pageDown)
  expect(shown()).toEqual([14, 15, 16, 17])
  b.input(KEY.home)
  expect(shown()).toEqual([1, 2, 3, 4])
  b.input(KEY.up)
  b.input(KEY.pageUp)
  expect(shown()).toEqual([1, 2, 3, 4])
  b.input(KEY.end)
  expect(shown()).toEqual([17, 18, 19, 20])
})

test('keys in the variants of other terminals, also several in one chunk', () => {
  const { b, shown } = scrollable()
  b.input('\x1bOA\x1bOA')
  expect(shown()).toEqual([15, 16, 17, 18])
  b.input('\x1bOB')
  expect(shown()).toEqual([16, 17, 18, 19])
  for (const [home, end] of [
    ['\x1bOH', '\x1bOF'],
    ['\x1b[1~', '\x1b[4~'],
    ['\x1b[7~', '\x1b[8~'],
  ] as const) {
    b.input(home)
    expect(shown()).toEqual([1, 2, 3, 4])
    b.input(end)
    expect(shown()).toEqual([17, 18, 19, 20])
  }
})

test('a notch of the mouse wheel moves three lines, back to the end follows the live end', () => {
  const { b, say, view, shown } = scrollable()
  b.input(KEY.wheelUp)
  expect(shown()).toEqual([14, 15, 16, 17])
  // Several notches in one chunk, anywhere in the window.
  b.input(Buffer.from('\x1b[<64;1;1M\x1b[<64;60;10M'))
  expect(shown()).toEqual([8, 9, 10, 11])
  b.input(KEY.wheelDown)
  expect(shown()).toEqual([11, 12, 13, 14])
  say(1)
  expect(view().at(-1)).toBe('↓ 1 new line · End to follow')
  b.input(KEY.wheelDown.repeat(3))
  expect(view().at(-1)).toBe('')
  say(1)
  expect(shown()).toEqual([19, 20, 21, 22])
})

test('unknown bytes are ignored', () => {
  const { b, view } = scrollable()
  b.input(KEY.up)
  const before = view()
  // Letters, Ctrl+C, a bare Escape, ← →, Delete, Shift+↑ and F5.
  for (const bytes of ['jkq G', '\x03', '\x1b', '\x1b[D\x1b[C', '\x1b[3~', '\x1b[1;2A', '\x1b[15~'])
    b.input(bytes)
  // Mouse: left click and release, middle and right click, drag, wheel to the left and right.
  b.input('\x1b[<0;5;5M\x1b[<0;5;5m\x1b[<1;5;5M\x1b[<2;5;5M\x1b[<32;6;5M')
  b.input('\x1b[<66;5;5M\x1b[<67;5;5M')
  b.input(Buffer.from([0xff, 0x00]))
  expect(view()).toEqual(before)
})

test('while scrolled up the view stays put and the footer counts the new lines', () => {
  const { b, say, view, shown } = scrollable()
  b.report({ type: 'attempt-started', ticket: 27, attempt: 1, of: 3, time: 0 })
  say(1)
  view()
  expect(view().at(-1)).toBe('#27')
  b.input(KEY.pageUp)
  const kept = shown()
  expect(view().at(-1)).toBe('#27 · ↓ 0 new lines · End to follow')
  say(1)
  expect(view().at(-1)).toBe('#27 · ↓ 1 new line · End to follow')
  say(6)
  expect(shown()).toEqual(kept)
  expect(view().at(-1)).toBe('#27 · ↓ 7 new lines · End to follow')
})

test('reaching the end by scrolling or End follows the live end again', () => {
  const { b, say, view, shown } = scrollable()
  for (const back of [KEY.end, KEY.down + KEY.down, KEY.pageDown]) {
    b.input(KEY.up + KEY.up)
    say(0)
    b.input(back)
    expect(view().at(-1)).toBe('')
  }
  // Counting starts again with the next scroll.
  b.input(KEY.up)
  say(2)
  b.input(KEY.end)
  say(1)
  expect(shown()).toEqual([20, 21, 22, 23])
  b.input(KEY.up)
  expect(view().at(-1)).toBe('↓ 0 new lines · End to follow')
})

test('a transcript that fits the window has nothing to scroll', () => {
  const { b, say, view, shown } = scrollable(3)
  b.input(KEY.up + KEY.pageUp + KEY.home)
  expect(view().at(-1)).toBe('')
  say(2)
  expect(shown()).toEqual([2, 3, 4, 5])
})

test('scrolling up in a window grown to fit the whole transcript follows the live end', () => {
  for (const key of [KEY.up, KEY.pageUp, KEY.home]) {
    const { b, view } = scrollable()
    b.input(KEY.up)
    view(30)
    b.input(key)
    expect(view(30).at(-1)).toBe('')
  }
})

test('resizing while scrolled up keeps the topmost transcript line', () => {
  const { b, view, shown } = scrollable()
  b.input(KEY.pageUp)
  expect(shown(8)).toEqual([14, 15])
  expect(shown(13)).toEqual([14, 15, 16, 17, 18, 19, 20])
  expect(shown(18)).toEqual([14, 15, 16, 17, 18, 19, 20])
  expect(view(18).at(-1)).toContain('End to follow')
  expect(shown()).toEqual([14, 15, 16, 17])
  // Pages follow the height of the window as it is now.
  view(12)
  b.input(KEY.pageUp)
  expect(shown(12)).toEqual([9, 10, 11, 12, 13, 14])
})

test('dropping old lines at the limit while scrolled up keeps the visible text where possible', () => {
  const { b, say, shown } = scrollable(10_000)
  b.input(KEY.home)
  b.input(KEY.pageDown + KEY.pageDown)
  expect(shown()).toEqual([7, 8, 9, 10])
  say(4)
  expect(shown()).toEqual([7, 8, 9, 10])
  // The visible lines themselves are dropped: the oldest ones left take their place.
  say(5)
  expect(shown()).toEqual([10, 11, 12, 13])
})

test('with colours, truncation is ANSI-safe', () => {
  const b = board({ color: true })
  b.report(started)
  const [header] = b.screen(12, 3)
  expect(header).toBe('\x1b[2mgroundhog 1…\x1b[0m')
})

test.each([
  { total: 3, spec: 'Spec #25 (2/3) ·' },
  { total: 1, spec: 'Spec #25 ·' },
])('in a batch of $total the board header shows "$spec"', ({ total, spec }) => {
  const b = board({ position: { index: Math.min(2, total), total } })
  b.report(started)
  expect(b.screen(80, 14)[0]).toContain(spec)
})

test('in a batch one board shows every spec with its tickets and keeps them from run to run', () => {
  const planned = (graphEvent: Event) =>
    graphEvent.type === 'task-graph' ? graphEvent.tickets : []
  const b = board({ position: { index: 1, total: 2 } }, [
    { spec: 25, tickets: planned(graph(ticket(27), ticket(28))) },
    {
      spec: 31,
      tickets: planned(graph(ticket(32), ticket(33, { blockers: [{ number: 32, open: true }] }))),
    },
  ])
  const second: Event = { ...started, spec: 31 }
  for (const e of [
    started,
    graph(ticket(27), ticket(28)),
    { type: 'ticket-taken', ticket: 27, time: 0 },
    { type: 'attempt-started', ticket: 27, attempt: 1, of: 3, time: 0 },
  ] as Event[])
    b.report(e)
  expect(b.screen(80, 20).slice(0, 12)).toEqual([
    'groundhog 1.2.3 · Spec #25 (1/2) · target branch main · finish PR',
    '',
    'Spec #25',
    '  #27 ▶ running',
    '  #28 · waiting',
    'Spec #31',
    '  #32 · waiting',
    '  #33 ○ blocked by #32',
    '─'.repeat(80),
    '━━ Spec #25',
    '━━ #27',
    '',
  ])

  b.next({ position: { index: 2, total: 2 } })
  for (const e of [
    { type: 'ticket-done', ticket: 27, commit: 'abc', attempts: 1, time: 0 },
    second,
    graph(ticket(32), ticket(33, { blockers: [{ number: 32, open: true }] })),
    { type: 'ticket-taken', ticket: 32, time: 0 },
    { type: 'attempt-started', ticket: 32, attempt: 1, of: 3, time: 0 },
  ] as Event[])
    b.report(e)
  expect(b.screen(80, 20).slice(0, 13)).toEqual([
    'groundhog 1.2.3 · Spec #31 (2/2) · target branch main · finish PR',
    '',
    'Spec #25',
    '  #27 ✔ done',
    '  #28 · waiting',
    'Spec #31',
    '  #32 ▶ running',
    '  #33 ○ blocked by #32',
    '─'.repeat(80),
    '━━ Spec #25',
    '━━ #27',
    '━━ Spec #31',
    '━━ #32',
  ])
})

test('in a batch, the heading of every spec stays when done tickets are left out', () => {
  const done = (n: number) => ticket(n, { open: false })
  const b = board({}, [
    { spec: 25, tickets: [] },
    { spec: 31, tickets: [] },
  ])
  b.report(started)
  b.report(graph(done(26), done(27), done(28), ticket(29)))
  // Half of 14 is 7: header and blank line, two headings, three tickets with the summing line.
  expect(b.screen(60, 14).slice(0, 8)).toEqual([
    'groundhog 1.2.3 · Spec #25 · target branch main · finish PR',
    '',
    'Spec #25',
    '  #26 ✔ done',
    '  #29 · waiting',
    'Spec #31',
    '  … 2 more tickets',
    rule,
  ])
})

/** A fake terminal for `showBoard`: what it wrote, and what it did with stdin. */
function terminal(isTTY = true) {
  const written: string[] = []
  const stdin: string[] = []
  const out = Object.assign(new EventEmitter(), {
    columns: 30,
    rows: 6,
    write: (t: string) => written.push(t),
  })
  const input = Object.assign(new EventEmitter(), {
    isTTY,
    setRawMode: (on: boolean) => stdin.push(`raw ${on}`),
    resume: () => stdin.push('resume'),
    pause: () => stdin.push('pause'),
  })
  let interrupts = 0
  const show = (logDir?: string) =>
    showBoard(
      out as unknown as NodeJS.WriteStream,
      input as unknown as NodeJS.ReadStream,
      () => interrupts++,
      board({ color: true, logDir }),
    )
  return { out, input, written, stdin, show, interrupts: () => interrupts }
}

test('in the terminal: alternate screen, redrawn on event and resize, closing lines on the normal screen', () => {
  const { out, written, show } = terminal()
  const { report } = show('/repo/.git/groundhog/runs/x')
  expect(written.splice(0, 2)).toEqual(['\x1b[?1049h\x1b[?25l\x1b[?7l', '\x1b[?1002h\x1b[?1006h'])

  report(started)
  report(graph(ticket(27)))
  expect(written).toHaveLength(2)
  out.rows = 4
  out.emit('resize')
  expect(written.pop()?.split('\x1b[K\n')).toHaveLength(4)

  written.length = 0
  report({ type: 'run-finished', finish: { type: 'none' }, summary: '# Summary', time: 0 })
  expect(written.slice(0, 2)).toEqual(['\x1b[?1006l\x1b[?1002l', '\x1b[?7h\x1b[?25h\x1b[?1049l'])
  expect(written).toContain('# Summary\n')
  expect(written.at(-1)).toBe('Summary: /repo/.git/groundhog/runs/x/summary.md\n')

  // Afterwards nothing draws over the closing lines any more.
  out.emit('resize')
  expect(written.at(-1)).toBe('Summary: /repo/.git/groundhog/runs/x/summary.md\n')
})

test('in the terminal: reads keys in raw mode, redraws on each, hands Ctrl+C on, until it closes', () => {
  const { input, written, stdin, show, interrupts } = terminal()
  const { report, close } = show()
  expect(stdin).toEqual(['raw true', 'resume'])
  // Mouse reporting: button events, SGR encoding.
  expect(written.at(-1)).toBe('\x1b[?1002h\x1b[?1006h')
  report(started)
  for (let i = 1; i <= 5; i++) report(assistant(27, `line ${i}`))

  written.length = 0
  input.emit('data', Buffer.from(KEY.up))
  expect(written).toHaveLength(1)
  expect(written[0]).toContain('End to follow')
  expect(interrupts()).toBe(0)
  input.emit('data', Buffer.from('\x03'))
  expect(written).toHaveLength(2)
  expect(interrupts()).toBe(1)
  input.emit('data', Buffer.from(KEY.wheelUp))
  expect(written.pop()).toContain('End to follow')
  input.emit('data', Buffer.from('\x03\x03'))
  expect(interrupts()).toBe(3)

  stdin.length = 0
  written.length = 0
  close()
  close()
  expect(stdin).toEqual(['raw false', 'pause'])
  expect(written).toEqual(['\x1b[?1006l\x1b[?1002l', '\x1b[?7h\x1b[?25h\x1b[?1049l'])
  input.emit('data', Buffer.from('\x03'))
  expect(written).toHaveLength(2)
  expect(interrupts()).toBe(3)
  expect(input.listenerCount('data')).toBe(0)
})

test('in the terminal: the end of the run and the exit of the process leave raw mode and mouse reporting', () => {
  for (const end of ['run', 'exit']) {
    const { written, stdin, show } = terminal()
    const before = process.listeners('exit')
    const { report } = show()
    if (end === 'run')
      report({ type: 'run-finished', finish: { type: 'none' }, summary: '', time: 0 })
    else for (const l of process.listeners('exit')) if (!before.includes(l)) (l as () => void)()
    expect(stdin.slice(-2)).toEqual(['raw false', 'pause'])
    expect(written.join('')).toContain('\x1b[?1006l\x1b[?1002l')
  }
})

test('in the terminal: without a terminal on stdin, stdin is not touched', () => {
  const { input, written, stdin, show } = terminal(false)
  show().close()
  expect(stdin).toEqual([])
  // Mouse reports would arrive on a stdin nobody reads.
  expect(written.join('')).not.toContain('?100')
  expect(input.listenerCount('data')).toBe(0)
})

test('in the terminal: a failing setup stays readable on the normal screen after the board closes', () => {
  const { written, show } = terminal()
  const board = show()

  board.report({ type: 'run-halted', reason: 'setup', command: 'npm ci', output: 'E404', time: 0 })
  board.report({
    type: 'run-finished',
    finish: { type: 'skipped', reason: 'setup failed' },
    summary: '# Summary',
    time: 0,
  })

  const normal = written.join('').split('\x1b[?1049l').at(-1)
  expect(normal).toContain('Setup: npm ci')
  expect(normal).toContain('│ E404')
  expect(normal).toContain('# Summary')
})

test('a ticket with a title shows it after its state, so the board says what is being worked on', () => {
  const b = board()
  b.report(started)
  b.report(graph(ticket(27, { title: 'GitHub adapter' }), ticket(28, { title: 'Board' })))
  b.report({ type: 'ticket-taken', ticket: 27, time: 0 })
  b.report({ type: 'attempt-started', ticket: 27, attempt: 1, of: 3, time: 0 })
  expect(b.screen(60, 14).slice(2, 4)).toEqual([
    '  #27 ▶ running · GitHub adapter',
    '  #28 · waiting · Board',
  ])
})

import { readFileSync } from 'node:fs'
import { hostname } from 'node:os'
import { expect, test } from 'vitest'
import { fakeAgent } from './agent.ts'
import { manualClock } from './clock.ts'
import { display } from './display.ts'
import { driveRun, type Event, type FinishResult } from './engine.ts'
import { passthrough } from './sandbox.ts'
import { commitFile, throwawayRepo, worktreeOf } from './testing/throwaway-repo.ts'
import { InMemoryTracker } from './tracker.ts'

/** What the display writes without a terminal for a sequence of events. */
function text(events: Event[], options: Parameters<typeof display>[0] = {}): string {
  return events.flatMap(display(options)).join('\n')
}

/** A line of `stream-json` as an event of the engine. */
const output = (line: object | string): Event => ({
  type: 'session-output',
  ticket: 2,
  session: 1,
  line: typeof line === 'string' ? line : JSON.stringify(line),
  time: 0,
})
const assistant = (...content: object[]) => output({ type: 'assistant', message: { content } })
const result = (content: unknown, extra: object = {}) =>
  output({
    type: 'user',
    message: { content: [{ type: 'tool_result', tool_use_id: 't', content, ...extra }] },
  })

test('the transcript shows text, tool calls with the most important argument and results on one line', () => {
  expect(
    text([
      assistant({ type: 'text', text: 'I read the tests first.' }),
      assistant({
        type: 'tool_use',
        id: 't',
        name: 'Bash',
        input: { command: 'npm test', description: 'Run the tests' },
      }),
      result('✔ one\n✔ two\nℹ pass 2'),
      assistant({ type: 'tool_use', id: 'u', name: 'Read', input: { file_path: '/repo/a.ts' } }),
      result([{ type: 'text', text: 'File\nnot found' }], { is_error: true }),
      output('no JSON, such as stderr from claude'),
      output({ type: 'system', subtype: 'init' }),
      // Control characters from the agent's output neither colour nor overwrite anything.
      result('\x1b[31mred\x1b[0m\x1b[2K\ron'),
    ]),
  ).toBe(
    [
      '  │ I read the tests first.',
      '  │ ⏺ Bash npm test',
      '  │   ⎿ ✔ one ✔ two ℹ pass 2',
      '  │ ⏺ Read /repo/a.ts',
      '  │   ⎿ File not found',
      '  │   ⎿ red on',
    ].join('\n'),
  )
})

test('a change appears as a diff from structuredPatch, a new file from content, at most 12 lines', () => {
  const created = Array.from({ length: 14 }, (_, i) => `line ${i + 1}`).join('\n')
  const withPatch = (tool_use_result: object) =>
    output({
      type: 'user',
      message: { content: [{ type: 'tool_result', content: 'success' }] },
      tool_use_result,
    })
  expect(
    text([
      withPatch({
        filePath: '/repo/a.ts',
        structuredPatch: [
          { oldStart: 7, newStart: 7, lines: [' a', '-b', '+c', '+d', ' e'] },
          { oldStart: 20, newStart: 21, lines: ['-x'] },
        ],
      }),
      withPatch({
        type: 'create',
        filePath: '/repo/new.txt',
        content: `${created}\n`,
        structuredPatch: [],
      }),
      withPatch({
        type: 'create',
        filePath: '/repo/one.txt',
        content: 'one',
        structuredPatch: [],
      }),
    ]),
  ).toBe(
    [
      '  │   ⎿ 2 lines added, 2 removed',
      '  │        7   a',
      '  │        8 - b',
      '  │        8 + c',
      '  │        9 + d',
      '  │       10   e',
      '  │       20 - x',
      '  │   ⎿ 14 lines added, 0 removed',
      ...Array.from(
        { length: 12 },
        (_, i) => `  │     ${String(i + 1).padStart(4)} + line ${i + 1}`,
      ),
      '  │          … 2 more lines',
      '  │   ⎿ 1 line added, 0 removed',
      '  │        1 + one',
    ].join('\n'),
  )
})

test('state changes of the tickets, verifications, blocks and warnings appear as lines', () => {
  const at = (hour: number, minute = 0, day = 25) => new Date(2026, 10, day, hour, minute).getTime()
  const t = (e: Record<string, unknown>) => ({ ticket: 26, time: at(1), ...e }) as Event
  expect(
    text([
      {
        type: 'run-started',
        spec: 25,
        choice: { targetBranch: 'main', finish: 'pr' },
        versions: { groundhog: '1.0.0', claude: '2.1.0' },
        time: at(1),
      },
      { type: 'task-graph', tickets: [], time: at(1) },
      t({ type: 'ticket-taken' }),
      t({ type: 'attempt-started', attempt: 1, of: 3 }),
      t({ type: 'session-finished', session: 1, attempt: 1, success: true }),
      t({
        type: 'session-finished',
        session: 1,
        attempt: 1,
        success: true,
        blocks: [
          { tool: 'Bash', command: 'rm -rf ~/.ssh', reason: 'Deletes files outside the repo' },
          { tool: 'Write', command: '/etc/hosts' },
        ],
      }),
      t({ type: 'verification', name: 'Session successful', ok: true }),
      t({ type: 'verification', name: 'Check: npm test', ok: false, output: '1 failed' }),
      t({ type: 'attempt-started', attempt: 2, of: 3 }),
      t({ type: 'pause', reset: at(3, 10) }),
      t({ type: 'pause', reset: at(3, 10, 27) }),
      t({ type: 'verification', name: 'Check: npm test', ok: true }),
      { type: 'push', branch: 'spec/25', commit: 'abcdef1234567890', time: at(2) },
      t({ type: 'ticket-done', commit: 'abcdef1234567890', attempts: 2 }),
      t({ type: 'ticket-taken', ticket: 27 }),
      t({ type: 'ticket-failed', ticket: 27, attempts: 3, verification: 'Check: npm test' }),
      { type: 'warning', text: 'Comment on #27 failed: boom', time: at(2) },
      t({ type: 'run-halted', ticket: 28, reason: 'credit' }),
    ]),
  ).toBe(
    [
      'groundhog 1.0.0 · Spec #25 · target branch main · finish PR',
      '',
      '━━ #26 taken',
      '  ▶ Running',
      // The reason is only in the log.
      '  ⛔ Block: Bash rm -rf ~/.ssh',
      '  ⛔ Block: Write /etc/hosts',
      '  ✔ Session successful',
      '  ✘ Check: npm test',
      '  ▶ Attempt 2 of 3',
      '  ⏸ Usage limit reached, pause until 03:10',
      '  ⏸ Usage limit reached, pause until 27/11 03:10',
      '  ✔ Check: npm test',
      '  ↑ spec/25 pushed: abcdef1',
      '✔ #26 done in attempt 2 · commit abcdef1',
      '',
      '━━ #27 taken',
      '✘ #27 failed for good after 3 attempts (red: Check: npm test) → ready-for-human',
      '⚠ Comment on #27 failed: boom',
      '■ Run halted at #28: usage limit without reset time, continues only with credit',
    ].join('\n'),
  )
})

test('a failing setup shows its command and output like a red check, then the halt', () => {
  expect(
    text([
      {
        type: 'run-halted',
        reason: 'setup',
        command: 'npm ci',
        output: 'npm error code E404\n  \x1b[31mat install\x1b[0m\r\n',
        time: 0,
      },
      finished({ type: 'skipped', reason: 'setup failed' }),
    ]).split('\n'),
  ).toEqual(
    expect.arrayContaining([
      '  ✘ Setup: npm ci',
      '  │ npm error code E404',
      '  │   at install',
      '■ Run halted: setup failed, no ticket was taken',
      'Finish  skipped because setup failed. Next run: groundhog undefined',
    ]),
  )
})

const started = (finish: 'merge' | 'pr' | 'none'): Event => ({
  type: 'run-started',
  spec: 25,
  choice: { targetBranch: 'main', finish },
  versions: {},
  time: 0,
})
test.each([
  { total: 3, header: 'groundhog · Spec #25 (2/3) · target branch main · finish PR' },
  { total: 1, header: 'groundhog · Spec #25 · target branch main · finish PR' },
])('in a batch of $total the header reads "$header"', ({ total, header }) => {
  expect(text([started('pr')], { position: { index: Math.min(2, total), total } })).toBe(header)
})

const finished = (finish: FinishResult): Event => ({
  type: 'run-finished',
  finish,
  summary: '# Summary of spec #25\n\n- #26 done',
  time: 0,
})

test('at the end come the summary, the head of the integration branch, the finish and as last line the path of the summary', () => {
  expect(
    text(
      [
        started('pr'),
        { type: 'push', branch: 'spec/25', commit: 'abcdef1234567890', time: 0 },
        { type: 'ticket-done', ticket: 26, commit: 'abcdef1234567890', attempts: 1, time: 0 },
        finished({ type: 'skipped', reason: 'tickets open' }),
      ],
      { logDir: '/repo/.git/groundhog/runs/x' },
    )
      .split('\n')
      .slice(3),
  ).toEqual([
    '',
    '# Summary of spec #25',
    '',
    '- #26 done',
    '',
    'Integration branch spec/25: 1 ticket integrated, head abcdef1',
    'Finish PR skipped because tickets are open. Next run: groundhog 25',
    `Machine: ${hostname()} · Log: /repo/.git/groundhog/runs/x`,
    'Summary: /repo/.git/groundhog/runs/x/summary.md',
  ])
})

test('the push of the merge into the target branch does not change the head of the integration branch', () => {
  const lines = text([
    started('merge'),
    { type: 'push', branch: 'spec/25', commit: 'abcdef1234567890', time: 0 },
    { type: 'ticket-done', ticket: 26, commit: 'abcdef1234567890', attempts: 1, time: 0 },
    { type: 'push', branch: 'main', commit: '1234567890', time: 0 },
    finished({ type: 'merged', commit: '1234567890' }),
  ])

  expect(lines).toContain('  ↑ main pushed: 1234567')
  expect(lines).toContain('Integration branch spec/25: 1 ticket integrated, head abcdef1')
})

test.each([
  [
    'merge',
    { type: 'merged', commit: '1234567890' },
    'Finish Merge: spec/25 merged into main, merge commit 1234567, spec #25 closed',
  ],
  ['merge', { type: 'conflict' }, 'Finish Merge: conflict with main, spec/25 stays'],
  [
    'pr',
    { type: 'pr', url: 'https://github.com/o/r/pull/9' },
    'Finish PR: https://github.com/o/r/pull/9',
  ],
  ['none', { type: 'none' }, 'Finish None: spec/25 stays'],
  [
    'pr',
    { type: 'skipped', reason: 'aborted' },
    'Finish PR skipped because the run was aborted. Next run: groundhog 25',
  ],
] as const)('finish %s → %o', (choice, finish, line) => {
  expect(
    text([started(choice), finished(finish)])
      .split('\n')
      .slice(-3),
  ).toEqual(['Integration branch spec/25: no tickets integrated', line, `Machine: ${hostname()}`])
})

test('a real session, reported through the engine, appears continuously without colour and without overlong lines', async () => {
  const { clone } = throwawayRepo()
  // A recorded session; its text is the agent's own (German) output and stays as recorded.
  const recording = readFileSync(
    new URL('./testing/recordings/claude-session-edit.jsonl', import.meta.url),
    'utf8',
  )
  const events: Event[] = []
  await driveRun({
    spec: 1,
    choice: { targetBranch: 'main', finish: 'none' },
    directory: clone,
    worktree: worktreeOf(clone),
    checks: ['true'],
    tracker: new InMemoryTracker('me', [
      { number: 2, open: true, labels: ['ready-for-agent'], assignees: [], blockers: [] },
    ]),
    agent: fakeAgent([
      ({ directory, output }) => {
        for (const line of recording.split('\n')) output(line)
        commitFile(directory, 'fizzbuzz.mjs', 'x', 'Add fizzbuzz')
        return { success: true }
      },
    ]),
    sandbox: passthrough,
    clock: manualClock(),
    report: (e) => events.push(e),
  })

  const lines = text(events, { width: 80 }).split('\n')
  expect(lines.join('\n')).not.toContain('\x1b')
  expect(lines.filter((l) => l.startsWith('  │') && l.length > 80)).toEqual([])
  const from = (start: string, n: number) => {
    const i = lines.indexOf(start)
    return lines.slice(i, i + n)
  }
  expect(from('━━ #2 taken', 3)).toEqual([
    '━━ #2 taken',
    '  ▶ Running',
    '  │ ⏺ Write /tmp/echter-run/fizzbuzz.mjs',
  ])
  expect(from('  │ ⏺ Edit /tmp/echter-run/fizzbuzz.mjs', 5)).toEqual([
    '  │ ⏺ Edit /tmp/echter-run/fizzbuzz.mjs',
    '  │   ⎿ 1 line added, 1 removed',
    '  │        1   export const fizzbuzz = (n) =>',
    "  │        2 -   (n % 3 ? '' : 'Fizz') + (n % 5 ? '' : 'Buzz') || String(n);",
    "  │        2 +   (n % 3 ? '' : 'Fizz') + (n % 5 ? '' : 'Buzz') + (n % 7 ? '' : '",
  ])
  expect(from('  │ ⏺ Read /tmp/echter-run/fizzbuzz.mjs', 2)[1]).toMatch(
    /^ {2}│ {3}⎿ 1 export const fizzbuzz.*…$/,
  )
  expect(from('  │ Fertig. Tests grün (1 pass, 0 fail), Commit `2598225`.', 9)).toEqual([
    '  │ Fertig. Tests grün (1 pass, 0 fail), Commit `2598225`.',
    "  │ - `fizzbuzz.mjs:2` → `+ (n % 7 ? '' : 'Bazz')` angehängt",
    '  │ - `fizzbuzz.test.mjs` → Asserts für 7, 21, 35, 105 ergänzt',
    '  │ - Commit ohne Claude-Trailer',
    expect.stringMatching(/^ {2}│ Übersprungen: nix\. .*…$/),
    '  ✔ Session successful',
    '  ✔ HEAD on ticket/2',
    '  ✔ new commit since fork point',
    '  ✔ working tree clean',
  ])
  expect(lines).toContain('  ✔ Check: true')
  expect(lines.find((l) => l.startsWith('✔ #2 done · commit '))).toBeDefined()
})

test('with colour: + green, - red, code with syntax colours, errors red', () => {
  const lines = text(
    [
      output({
        type: 'user',
        message: { content: [{ type: 'tool_result', content: 'ok' }] },
        tool_use_result: {
          filePath: '/repo/a.ts',
          structuredPatch: [{ oldStart: 1, newStart: 1, lines: ['-let a = 1', '+const a = 2'] }],
        },
      }),
      result('broken', { is_error: true }),
    ],
    { color: true },
  ).split('\n')
  const [, minus, plus, error] = lines
  expect(minus).toBe('  │     \x1b[31m   1 -\x1b[0m \x1b[2mlet a = 1\x1b[0m')
  expect(plus?.startsWith('  │     \x1b[32m   1 +\x1b[0m ')).toBe(true)
  // Syntax colours: the keyword is coloured.
  expect(plus).toContain('mconst\x1b[')
  expect(error).toBe('  │   \x1b[31m⎿ broken\x1b[0m')
})

import { hostname } from 'node:os'
import { expect, test } from 'vitest'
import { type AgentScript, fakeAgent } from './agent.ts'
import { manualClock } from './clock.ts'
import { driveRun, type Event, type RunInput } from './engine.ts'
import { git } from './git.ts'
import { passthrough } from './sandbox.ts'
import { commitFile, throwawayRepo, worktreeOf } from './testing/throwaway-repo.ts'
import { InMemoryTracker, type Ticket } from './tracker.ts'

const START = new Date(2026, 10, 25, 22, 0, 0).getTime()
const MINUTE = 60_000

const ticket = (number: number, part: Partial<Ticket> = {}): Ticket => ({
  number,
  open: true,
  labels: ['ready-for-agent'],
  assignees: [],
  blockers: [],
  ...part,
})

/** Drives a whole run over spec 1 with target branch main; each session takes 10 minutes. */
async function run(
  clone: string,
  tracker: InMemoryTracker,
  script: AgentScript[],
  input: Partial<RunInput> = {},
) {
  const clock = manualClock(START)
  const events: Event[] = []
  const result = await driveRun({
    spec: 1,
    choice: { targetBranch: 'main', finish: 'none' },
    directory: clone,
    worktree: worktreeOf(clone),
    checks: ['grep -sqx green green || { echo "not green"; false; }'],
    logDir: '/tmp/runs/20261125-220000-spec-1',
    tracker,
    agent: fakeAgent(
      script.map((step) => (request) => {
        clock.advance(10 * MINUTE)
        return step(request)
      }),
    ),
    sandbox: passthrough,
    clock,
    report: (e) => events.push(e),
    ...input,
  })
  return { result, events }
}

/** A session that implements the ticket green. */
const green: AgentScript = ({ directory, ticket }) => {
  commitFile(directory, 'green', 'green', `Implement ticket ${ticket.number}`)
  return { success: true, sessionId: `session-${ticket.number}` }
}

/** A session that commits but leaves the checks red. */
const red: AgentScript = ({ directory, ticket }) => {
  commitFile(directory, 'green', `red ${Math.random()}`, `Try ticket ${ticket.number}`)
  return { success: true, sessionId: `session-${ticket.number}-red` }
}

test('a green ticket gets a line with commit, attempt and blocks when it is closed', async () => {
  const { remote, clone } = throwawayRepo()
  const tracker = new InMemoryTracker('me', [ticket(2)])

  await run(clone, tracker, [
    red,
    (request) => ({
      ...green(request),
      blocks: [{ tool: 'Bash', command: 'curl https://example.com' }],
    }),
  ])

  expect(tracker.comments(2)).toEqual([
    `Done: ${git(remote, 'rev-parse', 'spec/1')} in spec/1, attempt 2 of 3, blocks: 1`,
  ])
})

test('a ticket that failed for good gets exactly one comment with all attempts', async () => {
  const { clone } = throwawayRepo()
  const tracker = new InMemoryTracker('me', [ticket(2)])
  const check = 'grep -sqx green green || { seq 1 150; false; }'

  await run(
    clone,
    tracker,
    [
      red,
      () => ({ success: false, blocks: [{ tool: 'Bash', command: 'rm -rf /' }] }),
      (request) => ({ ...red(request), blocks: [{ tool: 'WebFetch', command: 'https://x.org' }] }),
    ],
    { checks: [check] },
  )

  const output = Array.from({ length: 100 }, (_, i) => i + 51).join('\n')
  expect(tracker.comments(2)).toEqual([
    `Failed for good, now \`ready-for-human\`.

- Attempt 1 of 3 red: Check: ${check}
- Attempt 2 of 3 red: Session successful
- Attempt 3 of 3 red: Check: ${check}

Check output of the last attempt:

\`\`\`
[truncated, full output in the log]
${output}
\`\`\`

Blocks: 2

- Session: \`cd ${worktreeOf(clone)} && claude --resume session-2-red\`
- Machine: ${hostname()}
- Log: \`/tmp/runs/20261125-220000-spec-1\``,
  ])
  expect(tracker.ticket(2)).toMatchObject({ labels: ['ready-for-human'], assignees: [] })
})

test('if a comment fails, the engine warns; closing and ready-for-human do not depend on it', async () => {
  const { clone } = throwawayRepo()
  const tracker = new (class extends InMemoryTracker {
    override async comment(): Promise<void> {
      throw new Error('gh: unreachable')
    }
  })('me', [ticket(2), ticket(3)])

  const { result, events } = await run(clone, tracker, [green, red, red, red])

  expect(result.tickets.map((t) => t.result)).toEqual(['done', 'failed'])
  expect(tracker.ticket(2).open).toBe(false)
  expect(tracker.ticket(3).labels).toEqual(['ready-for-human'])
  expect(events.filter((e) => e.type === 'warning').map((e) => e.text)).toEqual([
    'Comment on #2 failed: gh: unreachable',
    'Comment on #3 failed: gh: unreachable',
    'Comment on #1 failed: gh: unreachable',
  ])
})

test('the summary names the run and one line per ticket; the spec gets it as a comment', async () => {
  const { remote, clone } = throwawayRepo()
  const tracker = new InMemoryTracker('me', [
    ticket(2),
    ticket(3),
    ticket(4, { blockers: [{ number: 3, open: true }] }),
    ticket(5, { labels: ['ready-for-human'] }),
    ticket(6, { open: false }),
  ])
  const block = (tool: string, command: string) => ({ blocks: [{ tool, command }] })

  const { events } = await run(
    clone,
    tracker,
    [
      red,
      (a) => ({ ...green(a), ...block('Bash', 'curl https://example.com') }),
      red,
      (a) => ({ ...red(a), ...block('WebFetch', 'https://x.org') }),
      (a) => ({ ...red(a), tokens: { input_tokens: 4711 }, costUsd: 1.5 }),
    ],
    {
      choice: { targetBranch: 'main', finish: 'pr' },
      versions: { groundhog: '1.0.0', claude: '2.1.0', skills: '1.3.2' },
    },
  )

  const summary = `# Summary of spec #1

- Start: 2026-11-25 22:00:00
- End: 2026-11-25 22:50:00
- Duration: 50 min
- Target branch: main
- Finish: PR → nothing, because tickets open
- Versions: groundhog 1.0.0, claude 2.1.0, skills 1.3.2

## Tickets

- #2 done · Attempts 2 of 3 · Pauses 0 · Duration 20 min · Blocks 1 · Commit ${git(remote, 'rev-parse', 'spec/1')}
  - Bash: \`curl https://example.com\`
- #3 failed · Attempts 3 of 3 · Pauses 0 · Duration 30 min · Blocks 1 · red: Check: grep -sqx green green || { echo "not green"; false; } · \`cd ${worktreeOf(clone)} && claude --resume session-3-red\`
  - WebFetch: \`https://x.org\`
- #4 blocked by #3
- #5 not touched
- #6 not touched, already closed`
  expect(events.at(-1)).toMatchObject({ type: 'run-finished', summary })
  expect(tracker.comments(1)).toEqual([
    `${summary}

- Machine: ${hostname()}
- Log: \`/tmp/runs/20261125-220000-spec-1\``,
  ])
})

test('the resume line quotes a worktree path the shell would split', async () => {
  const { clone } = throwawayRepo()
  const worktree = `${clone} it's a worktree`
  const tracker = new InMemoryTracker('me', [ticket(2)])

  await run(clone, tracker, [red], { worktree, maxAttempts: 1 })

  const resume = `\`cd '${clone} it'\\''s a worktree' && claude --resume session-2-red\``
  expect(tracker.comments(2)[0]).toContain(`- Session: ${resume}`)
  expect(tracker.comments(1)[0]).toContain(` · ${resume}`)
})

test('the summary counts pauses at the usage limit and shows a halted ticket as interrupted', async () => {
  const { remote, clone } = throwawayRepo()
  const tracker = new InMemoryTracker('me', [ticket(2), ticket(3)])

  const { events } = await run(clone, tracker, [
    () => ({ success: false, usageLimit: START + 30 * MINUTE }),
    green,
    () => ({ success: false, usageLimit: 'credit' }),
  ])

  const end = events.at(-1)
  expect(end?.type === 'run-finished' && end.summary.split('\n## Tickets\n\n')[1]).toBe(
    `- #2 done · Attempts 1 of 3 · Pauses 1 · Duration 41 min · Blocks 0 · Commit ${git(remote, 'rev-parse', 'spec/1')}
- #3 interrupted · Attempts 1 of 3 · Pauses 0 · Duration 10 min · Blocks 0`,
  )
})

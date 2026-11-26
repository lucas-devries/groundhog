import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { type AgentScript, fakeAgent } from './agent.ts'
import { manualClock } from './clock.ts'
import { driveRun, type Event } from './engine.ts'
import { openLog } from './log.ts'
import { passthrough } from './sandbox.ts'
import { commitFile, throwawayRepo, worktreeOf } from './testing/throwaway-repo.ts'
import { InMemoryTracker } from './tracker.ts'

const START = new Date(2026, 10, 25, 3, 4, 5).getTime()

/** Drives a run over spec 1 with a log; returns its path. */
async function run(
  clone: string,
  script: AgentScript[],
  options: {
    checks?: string[]
    setup?: string[]
    token?: string
    next?: (e: Event) => void
    /** Runs between opening the log and the run. */
    afterOpen?: (path: string) => void
  } = {},
): Promise<string> {
  const { checks = ['true'], setup, token, next } = options
  const log = openLog({ directory: clone, spec: 1, start: START, next })
  options.afterOpen?.(log.path)
  await driveRun({
    spec: 1,
    choice: { targetBranch: 'main', finish: 'none' },
    directory: clone,
    worktree: worktreeOf(clone),
    checks,
    setup,
    token,
    versions: { groundhog: '1.0.0', claude: '2.1.0', skills: '1.3.2' },
    tracker: new InMemoryTracker('me', [
      { number: 2, open: true, labels: ['ready-for-agent'], assignees: [], blockers: [] },
    ]),
    agent: fakeAgent(script),
    sandbox: passthrough,
    clock: manualClock(START),
    report: log.report,
  })
  return log.path
}

const commits: AgentScript = ({ directory }) => {
  commitFile(directory, 'a.txt', 'a', 'Implement ticket 2')
  return { success: true, tokens: { input_tokens: 10, output_tokens: 5 }, costUsd: 0.25 }
}

const lines = (file: string): Event[] =>
  readFileSync(file, 'utf8')
    .trimEnd()
    .split('\n')
    .map((l) => JSON.parse(l))

test('run.jsonl records every event of the engine as one line, in the run folder', async () => {
  const { clone } = throwawayRepo()

  const path = await run(clone, [commits])

  expect(path).toBe(join(clone, '.git/groundhog/runs/20261125-030405-spec-1'))
  const events = lines(join(path, 'run.jsonl'))
  expect(events.map((e) => e.type)).toEqual([
    'run-started',
    'task-graph',
    'ticket-taken',
    'attempt-started',
    'session-finished',
    'verification',
    'verification',
    'verification',
    'verification',
    'verification',
    'attempt-finished',
    'push',
    'ticket-done',
    'task-graph',
    'run-finished',
  ])
  expect(events.find((e) => e.type === 'attempt-finished')).toEqual({
    type: 'attempt-finished',
    ticket: 2,
    attempt: 1,
    verifications: [
      { name: 'Session successful', ok: true },
      { name: 'HEAD on ticket/2', ok: true },
      { name: 'new commit since fork point', ok: true },
      { name: 'working tree clean', ok: true },
      { name: 'Check: true', ok: true },
    ],
    time: START,
  })
  expect(events[0]).toMatchObject({
    spec: 1,
    choice: { targetBranch: 'main', finish: 'none' },
    versions: { groundhog: '1.0.0', claude: '2.1.0', skills: '1.3.2' },
  })
  expect(events[4]).toMatchObject({
    ticket: 2,
    session: 1,
    attempt: 1,
    success: true,
    tokens: { input_tokens: 10, output_tokens: 5 },
    costUsd: 0.25,
  })
  expect(events[11]).toMatchObject({ branch: 'spec/1' })
  expect(events[14]).toEqual({ type: 'run-finished', finish: { type: 'none' }, time: START })
})

test('the summary lies in the run folder as summary.md, as the engine reports it', async () => {
  const { clone } = throwawayRepo()
  let reported = ''

  const path = await run(clone, [commits], {
    next: (e) => {
      if (e.type === 'run-finished') reported = e.summary
    },
  })

  expect(readFileSync(join(path, 'summary.md'), 'utf8')).toBe(`${reported}\n`)
  expect(reported).toMatch(/^# Summary of spec #1\n/)
})

test('each session has its raw output and the untruncated output of the checks after it', async () => {
  const { clone } = throwawayRepo()

  const path = await run(
    clone,
    [
      (request) => {
        request.output('{"type":"system","subtype":"init"}')
        request.output('{"type":"result","subtype":"success"}')
        return commits(request)
      },
      (request) => {
        request.output('{"type":"result","subtype":"success"}')
        commitFile(request.directory, 'green', '', 'make it green')
        return { success: true }
      },
    ],
    { checks: ['echo before', 'test -f green || { seq 0 149 | sed "s/^/line /"; false; }'] },
  )

  expect(readdirSync(path).sort()).toEqual([
    'run.jsonl',
    'summary.md',
    'ticket-2-session-1-checks.log',
    'ticket-2-session-1.jsonl',
    'ticket-2-session-2-checks.log',
    'ticket-2-session-2.jsonl',
  ])
  expect(readFileSync(join(path, 'ticket-2-session-1.jsonl'), 'utf8')).toBe(
    '{"type":"system","subtype":"init"}\n{"type":"result","subtype":"success"}\n',
  )
  const checks1 = readFileSync(join(path, 'ticket-2-session-1-checks.log'), 'utf8')
  expect(checks1).toContain('$ echo before\nbefore\n')
  expect(checks1).toContain('line 0\n')
  expect(checks1).toContain('line 149')
  expect(readFileSync(join(path, 'ticket-2-session-2-checks.log'), 'utf8')).not.toContain(
    'line 0\n',
  )
  const events = lines(join(path, 'run.jsonl'))
  expect(events.filter((e) => e.type === 'session-finished')).toMatchObject([
    { session: 1, attempt: 1 },
    { session: 2, attempt: 2 },
  ])
  // Raw outputs only appear in their own files.
  expect(events.some((e) => e.type === 'session-output')).toBe(false)
  expect(JSON.stringify(events)).not.toContain('line 0')
})

test('the gh token appears neither in the log nor in the feedback to the next session', async () => {
  const { clone } = throwawayRepo()
  let feedback: string | undefined
  let returned: string | undefined

  const path = await run(
    clone,
    [
      (request) => {
        // The adapter only evaluates the filtered line, for example for the blocks.
        returned = request.output('{"text":"GH_TOKEN=ghp_secret"}')
        return commits(request)
      },
      (request) => {
        feedback = request.feedback
        commitFile(request.directory, 'green', '', 'make it green')
        return { success: true }
      },
    ],
    { checks: ['echo token ghp_$(echo secret); test -f green'], token: 'ghp_secret' },
  )

  const everything = readdirSync(path)
    .map((d) => readFileSync(join(path, d), 'utf8'))
    .join('\n')
  expect(everything).not.toContain('ghp_secret')
  expect(returned).toBe('{"text":"GH_TOKEN=***"}')
  expect(readFileSync(join(path, 'ticket-2-session-1.jsonl'), 'utf8')).toContain('GH_TOKEN=***')
  expect(readFileSync(join(path, 'ticket-2-session-1-checks.log'), 'utf8')).toContain('token ***')
  expect(feedback).toContain('token ***')
  expect(feedback).not.toContain('ghp_secret')
})

test('the last 10 runs stay, the start of the next one deletes older ones', async () => {
  const { clone } = throwawayRepo()
  const runs = join(clone, '.git/groundhog/runs')
  const old = Array.from({ length: 10 }, (_, i) => `202611${10 + i}-120000-spec-${i}`)
  for (const o of old) mkdirSync(join(runs, o), { recursive: true })

  await run(clone, [commits])

  expect(readdirSync(runs).sort()).toEqual([...old.slice(1), '20261125-030405-spec-1'])
})

test('if a write fails, there is a single warning and the run goes on', async () => {
  const { clone } = throwawayRepo()
  const events: Event[] = []

  await run(clone, [commits], {
    next: (e) => events.push(e),
    afterOpen: (path) => {
      rmSync(path, { recursive: true })
      writeFileSync(path, 'not a folder')
    },
  })

  expect(events.filter((e) => e.type === 'warning')).toHaveLength(1)
  expect(events.map((e) => e.type)).toContain('ticket-done')
  expect(events.at(-1)?.type).toBe('run-finished')
})

test('if the run folder cannot be created, the start aborts', () => {
  const { clone } = throwawayRepo()
  writeFileSync(join(clone, '.git/groundhog'), 'not a folder')

  expect(() => openLog({ directory: clone, spec: 1, start: START })).toThrow()
})

test('a failing setup has its command and output in setup.log, not in run.jsonl', async () => {
  const { clone } = throwawayRepo()

  const path = await run(clone, [], { setup: ['echo broken; false'] })

  expect(readFileSync(join(path, 'setup.log'), 'utf8')).toBe('$ echo broken; false\nbroken\n')
  const halted = lines(join(path, 'run.jsonl')).find((e) => e.type === 'run-halted')
  expect(halted).toEqual({ type: 'run-halted', reason: 'setup', time: START })
})

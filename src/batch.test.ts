import { EventEmitter } from 'node:events'
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Writable } from 'node:stream'
import { expect, test, vi } from 'vitest'
import { type ProcessAdapter, runBatch, runSpecs } from './batch.ts'
import type { driveRun, RunInput, RunResult } from './engine.ts'
import type { GitHubTracker } from './github.ts'
import type { Event } from './run-state.ts'
import type { Ready, Start } from './start.ts'
import { throwawayRepo } from './testing/throwaway-repo.ts'
import { InMemoryTracker } from './tracker.ts'

/** Runs the batch over specs 57, 58 and 61; `codes` are the exit codes of the runs in order. */
async function batch(...codes: number[]) {
  const ran: unknown[] = []
  const result = await runBatch([57, 58, 61], async (spec, position) => {
    ran.push([spec, position])
    return codes[ran.length - 1] as number
  })
  return { ...result, ran }
}

test('after runs with exit code 0 the batch goes on, in order and with the position', async () => {
  expect(await batch(0, 0, 0)).toEqual({
    exitCode: 0,
    overview: ['#57 green', '#58 green', '#61 green'],
    ran: [
      [57, { index: 1, total: 3 }],
      [58, { index: 2, total: 3 }],
      [61, { index: 3, total: 3 }],
    ],
  })
})

test.each([
  { code: 2, result: 'ready-for-human' },
  { code: 1, result: 'aborted' },
  { code: 130, result: 'aborted' },
])('exit code $code stops the batch and is its exit code', async ({ code, result }) => {
  const { exitCode, overview, ran } = await batch(0, code)

  expect(exitCode).toBe(code)
  expect(overview).toEqual(['#57 green', `#58 ${result}`, '#61 not started'])
  expect(ran).toHaveLength(2)
})

test('a batch of one has no overview', async () => {
  expect(await runBatch([57], async () => 2)).toEqual({ exitCode: 2, overview: [] })
})

/** A process in memory: what groundhog wrote and executed, and the signals it listens to. */
function fakeProcess({
  env = {},
  isTTY = false,
}: {
  env?: NodeJS.ProcessEnv
  isTTY?: boolean
} = {}) {
  const events = new EventEmitter()
  const written: string[] = []
  const executed: string[][] = []
  const exits: number[] = []
  const stdout = new Writable({
    write: (chunk, _, done) => {
      written.push(String(chunk))
      done()
    },
  })
  const io: ProcessAdapter = {
    env,
    stdin: { isTTY: false } as NodeJS.ReadStream,
    stdout: Object.assign(stdout, {
      isTTY,
      columns: 80,
      rows: 20,
    }) as unknown as NodeJS.WriteStream,
    on: (event, listener) => events.on(event, listener),
    off: (event, listener) => events.off(event, listener),
    exit: (code) => exits.push(code),
    exec: (file, args) => executed.push([file, ...args]),
  }
  return {
    io,
    executed,
    exits,
    output: () => written.join(''),
    send: (signal: NodeJS.Signals | 'exit') => events.emit(signal, signal),
    listeners: (signal: NodeJS.Signals) => events.listenerCount(signal),
  }
}

/** What a successful start hands over for the specs, in a throwaway clone. */
function handOver(specs: number[]) {
  const { clone } = throwawayRepo()
  const release = vi.fn()
  const ready: Ready = {
    ok: true,
    directory: clone,
    config: {
      checks: ['true'],
      setup: [],
      attempts: 3,
      targetBranches: ['main'],
      sandbox: { hosts: [], off: true },
    },
    worktree: (spec) => `${clone}-spec-${spec}`,
    specs,
    choice: { targetBranch: 'main', finish: 'none' },
    tracker: new InMemoryTracker('me', []) as unknown as GitHubTracker,
    token: 'gho_secret',
    repoUrl: 'https://github.com/o/r',
    sandbox: undefined,
    versions: {},
    release,
  }
  return { ready, release }
}

const green: RunResult = { tickets: [], finish: { type: 'none' } }
const failed: RunResult = {
  tickets: [{ number: 2, result: 'failed', attempts: 3 }],
  finish: { type: 'skipped', reason: 'tickets open' },
}
const halted = (halted: NonNullable<RunResult['halted']>): RunResult => ({ ...green, halted })

const started = (spec: number): Event => ({
  type: 'run-started',
  spec,
  choice: { targetBranch: 'main', finish: 'none' },
  worktree: '/worktrees/spec',
  versions: {},
  time: 0,
})
const finished: Event = { type: 'run-finished', finish: { type: 'none' }, summary: '', time: 0 }

/**
 * Runs the specs with a fake process. `script` is what each run does, in order; it reports the
 * start and the end of the run around it.
 */
async function runs(
  specs: number[],
  script: ((input: RunInput) => RunResult)[],
  fake = fakeProcess(),
  /** The specs named in the call; empty means the human chooses them during the start. */
  named = specs,
) {
  const { ready, release } = handOver(specs)
  const driven: RunInput[] = []
  const drive: typeof driveRun = async (input) => {
    driven.push(input)
    input.report?.(started(input.spec))
    const result = (script[driven.length - 1] as (input: RunInput) => RunResult)(input)
    input.report?.(finished)
    return result
  }
  const exitCode = await runSpecs(named, fake.io, { start: async () => ready, drive })
  return { ...fake, exitCode, driven, ready, release }
}

test.each([
  { run: 'ends green', result: green, code: 0 },
  { run: 'has a failed ticket', result: failed, code: 2 },
  { run: 'halts without credit', result: halted('credit'), code: 1 },
  { run: 'halts at a failing setup', result: halted('setup'), code: 1 },
  { run: 'is aborted', result: halted('aborted'), code: 130 },
])('a run that $run ends with exit code $code and releases the lock', async ({ result, code }) => {
  const { exitCode, release } = await runs([57], [() => result])

  expect(exitCode).toBe(code)
  expect(release).toHaveBeenCalledOnce()
})

test('a run that throws ends with exit code 1, the message and no signal handler left', async () => {
  const error = vi.spyOn(console, 'error').mockImplementation(() => {})

  const { exitCode, release, listeners } = await runs(
    [57],
    [
      () => {
        throw new Error('push failed')
      },
    ],
  )

  expect(exitCode).toBe(1)
  expect(error).toHaveBeenCalledWith('groundhog: run aborted: push failed')
  expect(release).toHaveBeenCalledOnce()
  expect(listeners('SIGINT')).toBe(0)
  error.mockRestore()
})

test('after a run that does not end with 0, no further spec starts', async () => {
  const { exitCode, driven, output } = await runs([57, 58], [() => failed])

  expect(exitCode).toBe(2)
  expect(driven.map((r) => r.spec)).toEqual([57])
  expect(output()).toContain('#57 ready-for-human\n#58 not started\n')
})

test('an abort too late for the engine still keeps the next spec from starting', async () => {
  const fake = fakeProcess()

  const { exitCode, driven } = await runs(
    [57, 58],
    [
      () => {
        fake.send('SIGTERM')
        return green
      },
    ],
    fake,
  )

  expect(exitCode).toBe(130)
  expect(driven.map((r) => r.spec)).toEqual([57])
})

test('an abort too late in the last run of the batch changes nothing', async () => {
  const fake = fakeProcess()
  const abort = () => {
    fake.send('SIGTERM')
    return green
  }

  expect((await runs([57], [abort], fake)).exitCode).toBe(0)
})

test('signals reach only the current run: a note first, hard exit during cleanup', async () => {
  const fake = fakeProcess()
  const during: unknown[] = []

  const { release, listeners, output } = await runs(
    [57, 58],
    [
      () => green,
      (input) => {
        during.push(fake.listeners('SIGINT'), fake.listeners('SIGTERM'), fake.listeners('SIGHUP'))
        fake.send('SIGINT')
        during.push(input.abort?.aborted, [...fake.exits])
        fake.send('SIGTERM')
        during.push(input.abort?.aborted)
        fake.send('SIGHUP')
        return halted('aborted')
      },
    ],
    fake,
  )

  expect(during).toEqual([1, 1, 1, false, [], true])
  expect(output()).toContain('Press Ctrl+C again to abort')
  expect(fake.exits).toEqual([130])
  // Once in the hard exit, once at the end of the batch.
  expect(release).toHaveBeenCalledTimes(2)
  expect(listeners('SIGINT')).toBe(0)
})

test('every run of the batch has its own log and continuous output', async () => {
  const script = [() => green, () => green]
  // The logs are named after the specs the start hands over, also those chosen in the selection.
  const { driven, ready, output } = await runs([57, 58], script, fakeProcess(), [])

  const folder = join(ready.directory, '.git/groundhog/runs')
  const logs = readdirSync(folder).sort()
  expect(logs).toEqual([
    expect.stringMatching(/^\d{8}-\d{6}-spec-57$/),
    expect.stringMatching(/^\d{8}-\d{6}-spec-58$/),
  ])
  expect(driven.map((r) => r.logDir)).toEqual(logs.map((l) => expect.stringContaining(l)))
  for (const [i, spec] of [57, 58].entries()) {
    const events = readFileSync(join(driven[i]?.logDir as string, 'run.jsonl'), 'utf8')
    expect(events.trimEnd().split('\n')).toHaveLength(2)
    expect(events).toContain(`"spec":${spec}`)
  }
  expect(output()).toContain('Spec #57 (1/2)')
  expect(output()).toContain('Spec #58 (2/2)')
  expect(output()).toContain('#57 green\n#58 green\n')
})

test('if the log of a run cannot be opened, the run aborts with exit code 1', async () => {
  const error = vi.spyOn(console, 'error').mockImplementation(() => {})
  const fake = fakeProcess()
  const { ready, release } = handOver([57])
  writeFileSync(join(ready.directory, '.git/groundhog'), 'not a folder')
  const drive = vi.fn<typeof driveRun>()

  expect(await runSpecs([57], fake.io, { start: async () => ready, drive })).toBe(1)

  expect(drive).not.toHaveBeenCalled()
  expect(error.mock.calls[0]?.[0]).toMatch(/^groundhog: run aborted: ENOTDIR/)
  expect(release).toHaveBeenCalledOnce()
  error.mockRestore()
})

test.each([
  { exitCode: 0, message: 'groundhog v9.9.9 is installed.' },
  { exitCode: 130, message: 'Aborted. Nothing was changed.' },
])('a start that ends with $exitCode ends the batch with it and says why', async (end) => {
  const fake = fakeProcess()
  const drive = vi.fn<typeof driveRun>()
  const start = async (): Promise<Start> => ({ ok: false, ...end })

  expect(await runSpecs([57], fake.io, { start, drive })).toBe(end.exitCode)

  expect(fake.output()).toContain(end.message)
  expect(drive).not.toHaveBeenCalled()
})

test('Herdr hears of the start, of every run and ticket, and is released at the end of the process', async () => {
  const fake = fakeProcess({
    env: { HERDR_ENV: '1', HERDR_PANE_ID: 'w1:p1', HC_TERMINAL_ID: 't1' },
    isTTY: true,
  })
  const taking = (nr: number) => (input: RunInput) => {
    input.report?.({ type: 'ticket-taken', ticket: nr, time: 0 })
    return green
  }
  /** What the `herdr` CLI was told, without the fixed arguments. */
  const told = () => fake.executed.map((c) => [c[2], c.at(-3)])

  await runs([57, 58], [taking(2), taking(3)], fake)

  expect(told()).toEqual([
    ['report-agent', 'Spec #57'],
    ['report-agent', 'Ticket #2'],
    ['report-agent', 'Spec #58'],
    ['report-agent', 'Ticket #3'],
  ])
  const states = [...fake.output().matchAll(/\]7501;state=(\w+)/g)].map((m) => m[1])
  expect(states).toEqual(['blocked', 'working', 'working', 'done', 'working', 'working', 'done'])
  fake.send('exit')
  expect(told().at(-1)?.[0]).toBe('release-agent')
  expect(told()).toHaveLength(5)
})

import { spawnSync } from 'node:child_process'
import * as p from '@clack/prompts'
import { abortGuard } from './abort.ts'
import { board, type Section, showBoard } from './board.ts'
import { claudeAgent } from './claude.ts'
import { systemClock } from './clock.ts'
import { display, type Position } from './display.ts'
import { driveRun, type RunResult } from './engine.ts'
import { type Exec, herdrReporter } from './herdr.ts'
import { openLog } from './log.ts'
import type { Event } from './run-state.ts'
import { passthrough } from './sandbox.ts'
import { type Ready, start } from './start.ts'
import { frontierState } from './tracker.ts'
import { install, newerVersion, VERSION } from './update.ts'

/** The effects of the process a batch runs in. Behind it: `process`, a fake in tests. */
export interface ProcessAdapter {
  env: NodeJS.ProcessEnv
  stdin: NodeJS.ReadStream
  stdout: NodeJS.WriteStream
  /** Listens to a signal, or to `exit` at the end of the process. */
  on(event: NodeJS.Signals | 'exit', listener: (signal: NodeJS.Signals) => void): unknown
  off(event: NodeJS.Signals | 'exit', listener: (signal: NodeJS.Signals) => void): unknown
  /** Ends the process at once. */
  exit(code: number): void
  /** Runs the `herdr` CLI and waits for it. */
  exec: Exec
}

export const systemProcess: ProcessAdapter = {
  env: process.env,
  // Getters: only touching stdin already opens it.
  get stdin() {
    return process.stdin
  },
  get stdout() {
    return process.stdout
  },
  on: (event, listener) => process.on(event, listener),
  off: (event, listener) => process.off(event, listener),
  exit: (code) => process.exit(code),
  exec: spawnSync,
}

/**
 * Starts a batch over the specs (empty: the human chooses them) and runs it: one run per spec,
 * each with its own log. Returns the exit code of the process.
 */
export async function runSpecs(
  specs: number[],
  io: ProcessAdapter,
  { start: startWith = start, drive = driveRun } = {},
): Promise<number> {
  const output = { output: io.stdout }
  p.intro(`groundhog ${VERSION}`, output)
  const herdr = herdrReporter({
    env: io.env,
    isTerminal: io.stdout.isTTY === true,
    write: (text) => io.stdout.write(text),
    exec: io.exec,
  })
  // On 'exit', so that the pane is also freed after a hard exit or a crash.
  io.on('exit', herdr.release)
  const ready = await startWith({
    directory: process.cwd(),
    specs,
    dialog: { ...p, warn: p.log.warn },
    isTerminal: io.stdin.isTTY === true,
    update: { newerVersion, install },
  })
  if (!ready.ok) {
    if (ready.exitCode === 0) p.outro(ready.message, output)
    else p.cancel(ready.message, output)
    return ready.exitCode
  }
  try {
    // One board for the whole batch, so the tickets of every spec stay in view.
    const model = io.stdout.isTTY ? board({ color: true }, await plan(ready)) : undefined
    const { exitCode, overview } = await runBatch(ready.specs, (spec, position) =>
      run({ ready, spec, position, io, report: herdr.report, model, drive }),
    )
    for (const line of overview) io.stdout.write(`${line}\n`)
    return exitCode
  } finally {
    ready.release()
  }
}

/**
 * Runs the specs of a batch one after another and stops at the first run that does not end with
 * exit code 0. `run` drives one run and returns its exit code. Returns the exit code of the last
 * run that ran and the overview, one line per spec; a batch of one has no overview.
 */
export async function runBatch(
  specs: number[],
  run: (spec: number, position: Position) => Promise<number>,
): Promise<{ exitCode: number; overview: string[] }> {
  const codes: number[] = []
  let exitCode = 0
  for (const [i, spec] of specs.entries()) {
    exitCode = await run(spec, { index: i + 1, total: specs.length })
    codes.push(exitCode)
    if (exitCode !== 0) break
  }
  const overview = specs.map((spec, i) => `#${spec} ${outcome(codes[i])}`)
  return { exitCode, overview: specs.length > 1 ? overview : [] }
}

/** How the overview names a run's exit code; `undefined` means the run never ran. */
function outcome(exitCode: number | undefined): string {
  if (exitCode === undefined) return 'not started'
  if (exitCode === 0) return 'green'
  return exitCode === 2 ? 'ready-for-human' : 'aborted'
}

/** The specs of a batch with their tickets for the board; a batch of one needs none. */
async function plan({ specs, tracker }: Ready): Promise<Section[]> {
  if (specs.length < 2) return []
  return Promise.all(
    specs.map(async (spec) => ({
      spec,
      // Without the tracker the board shows the spec's tickets only once its run reads them.
      tickets: await tracker.taskGraph(spec).then(
        (tickets) => tickets.map((t) => ({ ...t, state: frontierState(t, tracker.user) })),
        () => [],
      ),
    })),
  )
}

/** Drives one run of the batch with its own log and board; returns its exit code. */
async function run({
  ready,
  spec,
  position,
  io,
  report,
  model,
  drive,
}: {
  ready: Ready
  spec: number
  position: Position
  io: ProcessAdapter
  /** Gets every event after the display. */
  report: (e: Event) => void
  /** The board of the batch; without a terminal there is none. */
  model: ReturnType<typeof board> | undefined
  drive: typeof driveRun
}): Promise<number> {
  let show: (e: Event) => void = () => {}
  /** Leaves the board, so that an error message stays on the normal screen. */
  let close = () => {}
  const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const
  let receive = (_: NodeJS.Signals) => {}
  try {
    const { directory, config, token } = ready
    const log = openLog({
      directory,
      spec,
      start: systemClock.now(),
      next: (e) => {
        show(e)
        report(e)
      },
    })
    if (model) {
      // In raw mode Ctrl+C is a byte on stdin; it counts like SIGINT.
      const interrupt = () => receive('SIGINT')
      model.next({ logDir: log.path, position })
      const shown = showBoard(io.stdout, io.stdin, interrupt, model)
      close = shown.close
      show = shown.report
    } else {
      const lines = display({ logDir: log.path, position })
      show = (e) => {
        for (const line of lines(e)) io.stdout.write(`${line}\n`)
      }
    }
    const guard = abortGuard({
      clock: systemClock,
      note: (text) => log.report({ type: 'warning', text, time: systemClock.now() }),
      // Signal during cleanup: out at once; the board cleans up in the 'exit' handler.
      hard: () => {
        ready.release()
        io.exit(130)
      },
    })
    receive = guard.receive
    for (const s of signals) io.on(s, receive)
    const result = await drive({
      spec,
      choice: ready.choice,
      directory,
      worktree: ready.worktree(spec),
      checks: config.checks,
      setup: config.setup,
      maxAttempts: config.attempts,
      token,
      versions: { groundhog: VERSION, ...ready.versions },
      logDir: log.path,
      tracker: ready.tracker,
      // The same sandbox around sessions and checks; without it no bypass (sandbox.off).
      agent: claudeAgent({ repoUrl: ready.repoUrl, token, sandbox: ready.sandbox }),
      sandbox: ready.sandbox ?? passthrough,
      clock: systemClock,
      report: log.report,
      abort: guard.signal,
    })
    // An abort that came too late for the engine must still keep the next spec from starting.
    const stop = guard.signal.aborted && position.index < position.total
    return exitCodeOf(result) || (stop ? 130 : 0)
  } catch (error) {
    close()
    console.error(`groundhog: run aborted: ${(error as Error).message}`)
    return 1
  } finally {
    for (const s of signals) io.off(s, receive)
  }
}

/** The exit code of a run that came to an end. */
function exitCodeOf({ halted, tickets }: RunResult): number {
  if (halted === 'aborted') return 130
  if (halted) return 1
  return tickets.some((t) => t.result === 'failed') ? 2 : 0
}

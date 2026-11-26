#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import * as p from '@clack/prompts'
import { abortGuard } from './abort.ts'
import { runBatch } from './batch.ts'
import { showBoard } from './board.ts'
import { claudeAgent } from './claude.ts'
import { systemClock } from './clock.ts'
import { display, type Position } from './display.ts'
import { driveRun, type Event } from './engine.ts'
import { herdr, herdrAgent, herdrStart } from './herdr.ts'
import { init } from './init.ts'
import { openLog } from './log.ts'
import { passthrough } from './sandbox.ts'
import { type Ready, start } from './start.ts'
import { install, newerVersion, update, VERSION } from './update.ts'

const HELP = `groundhog ${VERSION}: works through the tickets of a spec, without humans.

Commands:
  groundhog            choose ready specs and run over them
  groundhog <spec>     run over the tickets of the spec with this issue number
  groundhog <spec> …   run over several specs, one after another
  groundhog init       create or change the project config groundhog.json
  groundhog update     install the newest version
  groundhog --version  show the version
  groundhog --help     this help

Exit codes of a run (of several runs: those of the last one):
  0    finished regularly, no ticket failed
  1    start aborted, run aborted with an error or halted without credit
  2    finished regularly, at least one ticket failed for good (ready-for-human)
  130  aborted with Ctrl+C`

const args = process.argv.slice(2)
const [command] = args
if (args.length === 1 && command === 'init') {
  p.intro('groundhog init')
  const { exitCode, message } = await init({
    directory: process.cwd(),
    dialog: { ...p, info: p.log.info },
    isTerminal: process.stdin.isTTY === true,
  })
  if (exitCode === 0) p.outro(message)
  else p.cancel(message)
  process.exitCode = exitCode
} else if (args.length === 1 && command === 'update') {
  const { exitCode, message } = update()
  if (exitCode === 0) console.log(message)
  else console.error(`groundhog: ${message}`)
  process.exitCode = exitCode
} else if (args.length === 1 && command === '--version') {
  console.log(VERSION)
} else if (args.length === 1 && command === '--help') {
  console.log(HELP)
} else if (args.every((a) => /^[1-9]\d*$/.test(a))) {
  // Without an argument the human chooses the specs in the selection.
  process.exitCode = await runSpecs(args.map(Number))
} else {
  console.error(`groundhog: unknown call. See groundhog --help.`)
  process.exitCode = 1
}

async function runSpecs(specs: number[]): Promise<number> {
  p.intro(`groundhog ${VERSION}`)
  let show: (e: Event) => void = () => {}
  const agent = herdrAgent(process.env)
  let herdrReport = newHerdrReport()
  process.stdout.write(herdrStart(process.env, process.stdout.isTTY === true))
  // Sync, so the release also works in the 'exit' handler; Herdr being gone must not stop the run.
  const callHerdr = (args: string[] | undefined) =>
    args &&
    spawnSync(process.env.HERDR_BIN_PATH || 'herdr', args, { stdio: 'ignore', timeout: 2000 })
  process.once('exit', () => callHerdr(agent.release()))
  const next = (e: Event) => {
    show(e)
    process.stdout.write(herdrReport(e) ?? '')
    callHerdr(agent.report(e))
  }
  const ready = await start({
    directory: process.cwd(),
    specs,
    dialog: { ...p, warn: p.log.warn },
    isTerminal: process.stdin.isTTY === true,
    update: { newerVersion, install },
    next,
  })
  if (!ready.ok) {
    if (ready.exitCode === 0) p.outro(ready.message)
    else p.cancel(ready.message)
    return ready.exitCode
  }
  try {
    const { exitCode, overview } = await runBatch(ready.specs, (spec, position) => {
      herdrReport = newHerdrReport()
      return run(ready, spec, position, next, (to) => {
        show = to
      })
    })
    for (const line of overview) console.log(line)
    return exitCode
  } finally {
    ready.release()
  }
}

function newHerdrReport() {
  return herdr(process.env, process.stdout.isTTY === true)
}

/** Drives one run of the batch with its own log and board; returns its exit code. */
async function run(
  ready: Ready,
  spec: number,
  position: Position,
  next: (e: Event) => void,
  showWith: (show: (e: Event) => void) => void,
): Promise<number> {
  /** Leaves the board, so that an error message stays on the normal screen. */
  let close = () => {}
  const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const
  let receive = (_: NodeJS.Signals) => {}
  try {
    const { directory, config, token } = ready
    // The start has already opened the log of the first run.
    const log =
      position.index === 1 ? ready.log : openLog({ directory, spec, start: Date.now(), next })
    if (process.stdout.isTTY) {
      // In raw mode Ctrl+C is a byte on stdin; it counts like SIGINT.
      const interrupt = () => receive('SIGINT')
      const board = showBoard(process.stdout, process.stdin, interrupt, {
        logDir: log.path,
        position,
      })
      close = board.close
      showWith(board.report)
    } else {
      const lines = display({ logDir: log.path, position })
      showWith((e) => {
        for (const line of lines(e)) process.stdout.write(`${line}\n`)
      })
    }
    const guard = abortGuard({
      clock: systemClock,
      note: (text) => log.report({ type: 'warning', text, time: systemClock.now() }),
      // Signal during cleanup: out at once; the board cleans up in the 'exit' handler.
      hard: () => {
        ready.release()
        process.exit(130)
      },
    })
    receive = guard.receive
    for (const s of signals) process.on(s, receive)
    const result = await driveRun({
      spec,
      choice: ready.choice,
      directory,
      worktree: ready.worktree(spec),
      checks: config.checks,
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
    if (result.halted === 'aborted') return 130
    if (result.halted) return 1
    if (result.tickets.some((t) => t.result === 'failed')) return 2
    // An abort that came too late for the engine must still keep the next spec from starting.
    return guard.signal.aborted && position.index < position.total ? 130 : 0
  } catch (error) {
    close()
    console.error(`groundhog: run aborted: ${(error as Error).message}`)
    return 1
  } finally {
    for (const s of signals) process.off(s, receive)
  }
}

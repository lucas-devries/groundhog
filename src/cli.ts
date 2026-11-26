#!/usr/bin/env node
import * as p from '@clack/prompts'
import { abortGuard } from './abort.ts'
import { showBoard } from './board.ts'
import { claudeAgent } from './claude.ts'
import { systemClock } from './clock.ts'
import { display } from './display.ts'
import { driveRun, type Event } from './engine.ts'
import { herdr } from './herdr.ts'
import { init } from './init.ts'
import { passthrough } from './sandbox.ts'
import { start } from './start.ts'
import { install, newerVersion, update, VERSION } from './update.ts'

const HELP = `groundhog ${VERSION}: works through the tickets of a spec, without humans.

Commands:
  groundhog <spec>     run over the tickets of the spec with this issue number
  groundhog init       create or change the project config groundhog.json
  groundhog update     install the newest version
  groundhog --version  show the version
  groundhog --help     this help

Exit codes of a run:
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
} else if (args.length === 1 && command && /^[1-9]\d*$/.test(command)) {
  process.exitCode = await run(Number(command))
} else {
  console.error(`groundhog: unknown call. See groundhog --help.`)
  process.exitCode = 1
}

async function run(spec: number): Promise<number> {
  p.intro(`groundhog ${VERSION}`)
  let show: (e: Event) => void = () => {}
  const herdrReport = herdr(process.env, process.stdout.isTTY === true)
  const ready = await start({
    directory: process.cwd(),
    spec,
    dialog: { ...p, warn: p.log.warn },
    isTerminal: process.stdin.isTTY === true,
    update: { newerVersion, install },
    next: (e) => {
      show(e)
      process.stdout.write(herdrReport(e) ?? '')
    },
  })
  if (!ready.ok) {
    if (ready.exitCode === 0) p.outro(ready.message)
    else p.cancel(ready.message)
    return ready.exitCode
  }
  /** Leaves the board, so that an error message stays on the normal screen. */
  let close = () => {}
  const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const
  let receive = (_: NodeJS.Signals) => {}
  try {
    const { directory, config, token, log } = ready
    if (process.stdout.isTTY) {
      // In raw mode Ctrl+C is a byte on stdin; it counts like SIGINT.
      const interrupt = () => receive('SIGINT')
      ;({ report: show, close } = showBoard(process.stdout, process.stdin, interrupt, log.path))
    } else {
      const lines = display({ logDir: log.path })
      show = (e) => {
        for (const line of lines(e)) process.stdout.write(`${line}\n`)
      }
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
    return result.tickets.some((t) => t.result === 'failed') ? 2 : 0
  } catch (error) {
    close()
    console.error(`groundhog: run aborted: ${(error as Error).message}`)
    return 1
  } finally {
    for (const s of signals) process.off(s, receive)
    ready.release()
  }
}

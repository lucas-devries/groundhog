#!/usr/bin/env node
import * as p from '@clack/prompts'
import { runSpecs, systemProcess } from './batch.ts'
import { init } from './init.ts'
import { update, VERSION } from './update.ts'

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
  1    start aborted, run aborted with an error or halted (no credit, failing setup)
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
  process.exitCode = await runSpecs(args.map(Number), systemProcess)
} else {
  console.error(`groundhog: unknown call. See groundhog --help.`)
  process.exitCode = 1
}

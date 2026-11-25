#!/usr/bin/env node
import * as p from '@clack/prompts'
import { init } from './init.ts'

// Die übrigen Befehle kommen mit „Befehl groundhog <spec>“ (#35).
if (process.argv[2] === 'init' && process.argv.length === 3) {
  p.intro('groundhog init')
  const { exitCode, meldung } = await init({
    verzeichnis: process.cwd(),
    dialog: { ...p, info: p.log.info },
    istTerminal: process.stdin.isTTY === true,
  })
  if (exitCode === 0) p.outro(meldung)
  else p.cancel(meldung)
  process.exitCode = exitCode
} else {
  console.error('groundhog: noch keine Befehle außer init')
  process.exitCode = 1
}

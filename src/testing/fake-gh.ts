import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** What the fake `gh` answers to a call. */
export interface GhAnswer {
  output?: string
  error?: string
  exitCode?: number
}

export interface GhCall {
  args: string[]
  /** What arrived on stdin. */
  input: string
}

// Runs as CommonJS, because the temp directory has no package.json with "type": "module".
const SCRIPT = `#!/usr/bin/env node
const fs = require('node:fs')
const path = require('node:path')
const log = path.join(__dirname, 'calls.jsonl')
let input = ''
try { input = fs.readFileSync(0, 'utf8') } catch {}
fs.appendFileSync(log, JSON.stringify({ args: process.argv.slice(2), input }) + '\\n')
const n = fs.readFileSync(log, 'utf8').trim().split('\\n').length
const answer = JSON.parse(fs.readFileSync(path.join(__dirname, 'answers.json'), 'utf8'))[n - 1]
if (!answer) {
  process.stderr.write('fake gh: no answer for call ' + n)
  process.exit(99)
}
process.stdout.write(answer.output ?? '')
process.stderr.write(answer.error ?? '')
process.exit(answer.exitCode ?? 0)
`

/**
 * A `gh` that prints the answers in order and records every call. `directory` belongs at the
 * front of `PATH`.
 */
export function fakeGh(answers: GhAnswer[]) {
  const directory = mkdtempSync(join(tmpdir(), 'fake-gh-'))
  writeFileSync(join(directory, 'answers.json'), JSON.stringify(answers))
  writeFileSync(join(directory, 'calls.jsonl'), '')
  writeFileSync(join(directory, 'gh'), SCRIPT)
  chmodSync(join(directory, 'gh'), 0o755)
  return {
    directory,
    calls: (): GhCall[] =>
      readFileSync(join(directory, 'calls.jsonl'), 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line)),
  }
}

/** A recorded answer from GitHub from `recordings/`. */
export function recording(name: string): GhAnswer {
  return { output: readFileSync(join(import.meta.dirname, 'recordings', name), 'utf8') }
}

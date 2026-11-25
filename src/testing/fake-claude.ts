import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** What the fake `claude` does on a call. */
export interface ClaudeAnswer {
  /** File from `recordings/` whose lines go to stdout. */
  recording?: string
  exitCode?: number
  /** Starts a child (`sleep`) and never ends; the child's PID is in the call. */
  hangs?: boolean
}

export interface ClaudeCall {
  args: string[]
  cwd: string
  /** Where stdin points to (Linux: target of `/proc/self/fd/0`). */
  stdin: string
  env: Record<string, string | undefined>
  child?: number
}

// Runs as CommonJS, because the temp directory has no package.json with "type": "module".
const SCRIPT = `#!/usr/bin/env node
const fs = require('node:fs')
const path = require('node:path')
const { spawn } = require('node:child_process')
const log = path.join(__dirname, 'calls.jsonl')
const n = fs.readFileSync(log, 'utf8').split('\\n').filter(Boolean).length
const answer = JSON.parse(fs.readFileSync(path.join(__dirname, 'answers.json'), 'utf8'))[n]
let stdin = '?'
try { stdin = fs.readlinkSync('/proc/self/fd/0') } catch {}
const env = {}
for (const k of ['GH_TOKEN', 'IN_FAKE_SRT', 'ANTHROPIC_LOG', 'CLAUDE_CODE_RETRY_WATCHDOG', 'CLAUDE_CODE_RETRY_WATCHDOG_MAX_WAIT_MS']) env[k] = process.env[k]
const call = { args: process.argv.slice(2), cwd: process.cwd(), stdin, env }
if (!answer) {
  fs.appendFileSync(log, JSON.stringify(call) + '\\n')
  process.stderr.write('fake claude: no answer for call ' + (n + 1))
  process.exit(99)
}
if (answer.hangs) {
  call.child = spawn('sleep', ['1000'], { stdio: 'ignore' }).pid
  fs.appendFileSync(log, JSON.stringify(call) + '\\n')
  setInterval(() => {}, 1000)
} else {
  fs.appendFileSync(log, JSON.stringify(call) + '\\n')
  if (answer.recording) process.stdout.write(fs.readFileSync(answer.recording))
  process.stdout.write('', () => process.exit(answer.exitCode ?? 0))
}
`

/**
 * A `claude` that plays recorded `stream-json` outputs in order and records every call.
 * `directory` belongs at the front of `PATH`.
 */
export function fakeClaude(answers: ClaudeAnswer[]) {
  const directory = mkdtempSync(join(tmpdir(), 'fake-claude-'))
  const withPath = answers.map((a) => ({
    ...a,
    recording: a.recording && join(import.meta.dirname, 'recordings', a.recording),
  }))
  writeFileSync(join(directory, 'answers.json'), JSON.stringify(withPath))
  writeFileSync(join(directory, 'calls.jsonl'), '')
  writeFileSync(join(directory, 'claude'), SCRIPT)
  chmodSync(join(directory, 'claude'), 0o755)
  return {
    directory,
    calls: (): ClaudeCall[] =>
      readFileSync(join(directory, 'calls.jsonl'), 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line)),
  }
}

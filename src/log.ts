import { appendFileSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { Event } from './engine.ts'
import { commonDir } from './git.ts'

/** This many runs stay in the log per clone, the new one included. */
const KEEP = 10

export interface Log {
  /** Folder of the run. */
  path: string
  /** Writes an event of the engine to the log and passes it on. */
  report: (event: Event) => void
}

/**
 * Creates the run's folder under `.git/groundhog/runs/` and deletes runs beyond the last 10.
 * Throws if the folder cannot be created.
 */
export function openLog(options: {
  /** Repo root of the clone. */
  directory: string
  spec: number
  /** Start time of the run in ms; the folder carries it in local time. */
  start: number
  /** Gets every event afterwards, plus a warning once if a write fails. */
  next?: (event: Event) => void
}): Log {
  const { directory, spec, start, next } = options
  const runs = join(commonDir(directory), 'groundhog', 'runs')
  const path = join(runs, `${timestamp(new Date(start))}-spec-${spec}`)
  mkdirSync(runs, { recursive: true })
  mkdirSync(path)
  // The names start with the start time, so they sort chronologically.
  for (const old of readdirSync(runs).sort().slice(0, -KEEP)) {
    rmSync(join(runs, old), { recursive: true, force: true })
  }

  // The checks run after the session that finished last.
  let lastSession = ''
  let warned = false
  const write = (file: string, text: string, time: number) => {
    try {
      appendFileSync(join(path, file), text)
    } catch (error) {
      if (warned) return
      warned = true
      next?.({
        type: 'warning',
        text: `Log incomplete, writing to ${path} failed: ${(error as Error).message}`,
        time,
      })
    }
  }
  const log = (e: Event) => {
    if (e.type === 'session-output') {
      write(`ticket-${e.ticket}-session-${e.session}.jsonl`, `${e.line}\n`, e.time)
      return
    }
    if (e.type === 'session-finished') lastSession = `ticket-${e.ticket}-session-${e.session}`
    if (e.type === 'verification' && e.command !== undefined && e.output !== undefined) {
      const { output, command, ...withoutOutput } = e
      write(`${lastSession}-checks.log`, asRun(command, output), e.time)
      e = withoutOutput
    }
    if (e.type === 'run-finished') {
      const { summary, ...withoutSummary } = e
      write('summary.md', `${summary}\n`, e.time)
      e = withoutSummary as Event
    }
    if (e.type === 'run-halted' && e.reason === 'setup') {
      const { output, command, ...withoutOutput } = e
      write('setup.log', asRun(command, output), e.time)
      e = withoutOutput as Event
    }
    write('run.jsonl', `${JSON.stringify(e)}\n`, e.time)
  }

  return {
    path,
    report: (e) => {
      log(e)
      next?.(e)
    },
  }
}

/** A command and its output, as in a terminal. */
function asRun(command: string, output: string): string {
  return `$ ${command}\n${output}${output.endsWith('\n') ? '' : '\n'}`
}

/** YYYYMMDD-HHMMSS in local time. */
function timestamp(d: Date): string {
  const two = (n: number) => String(n).padStart(2, '0')
  return (
    `${d.getFullYear()}${two(d.getMonth() + 1)}${two(d.getDate())}-` +
    `${two(d.getHours())}${two(d.getMinutes())}${two(d.getSeconds())}`
  )
}

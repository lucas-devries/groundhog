import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { commonDir } from './git.ts'

export type Lock = { ok: true; release: () => void } | { ok: false; message: string }

/**
 * Takes the clone's lock `.git/groundhog.lock` (in the shared `.git` for worktrees). A lock with
 * a dead PID is taken over, one with a living PID aborts. `spec` is `undefined` while the lock
 * does not belong to exactly one spec: before the selection, and for a batch of several specs.
 */
export function takeLock(directory: string, spec: number | undefined, start: number): Lock {
  const file = join(commonDir(directory), 'groundhog.lock')
  const content = JSON.stringify({ pid: process.pid, start, spec })
  // ponytail: two simultaneous takeovers of a dead lock can both win.
  for (;;) {
    try {
      writeFileSync(file, content, { flag: 'wx' })
      break
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
    const old = read(file)
    if (old && alive(old.pid)) {
      const run = old.spec === undefined ? 'A run' : `A run on spec #${old.spec}`
      return {
        ok: false,
        message: `${run} is already in progress in this clone (PID ${old.pid}).`,
      }
    }
    rmSync(file, { force: true })
  }
  return {
    ok: true,
    release: () => {
      if (read(file)?.pid === process.pid) rmSync(file, { force: true })
    },
  }
}

function read(file: string): { pid: number; spec?: number } | undefined {
  try {
    const { pid, spec } = JSON.parse(readFileSync(file, 'utf8'))
    return Number.isInteger(pid) && pid > 0 ? { pid, spec } : undefined
  } catch {
    return undefined
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM: the process is alive but belongs to another user.
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

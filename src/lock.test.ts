import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { takeLock } from './lock.ts'
import { throwawayRepo } from './testing/throwaway-repo.ts'

const file = (clone: string) => join(clone, '.git', 'groundhog.lock')

/** A PID that is surely dead: that of a finished child process. */
const deadPid = () => spawnSync('true').pid as number

test('the lock holds PID, start time and spec number and disappears on release', () => {
  const { clone } = throwawayRepo()

  const lock = takeLock(clone, 25, 1_000)

  expect(lock.ok).toBe(true)
  expect(JSON.parse(readFileSync(file(clone), 'utf8'))).toEqual({
    pid: process.pid,
    start: 1_000,
    spec: 25,
  })
  if (lock.ok) lock.release()
  expect(existsSync(file(clone))).toBe(false)
})

test('a lock with a living PID aborts the start with PID and spec number and stays in place', () => {
  const { clone } = throwawayRepo()
  const foreign = JSON.stringify({ pid: process.ppid, start: 5, spec: 7 })
  writeFileSync(file(clone), foreign)

  const lock = takeLock(clone, 25, 1_000)

  expect(lock).toEqual({
    ok: false,
    message: `A run on spec #7 is already in progress in this clone (PID ${process.ppid}).`,
  })
  expect(readFileSync(file(clone), 'utf8')).toBe(foreign)
})

test('a lock with a dead PID is taken over without asking', () => {
  const { clone } = throwawayRepo()
  writeFileSync(file(clone), JSON.stringify({ pid: deadPid(), start: 5, spec: 7 }))

  const lock = takeLock(clone, 25, 1_000)

  expect(lock.ok).toBe(true)
  expect(JSON.parse(readFileSync(file(clone), 'utf8')).pid).toBe(process.pid)
})

test('an unreadable lock counts as the remnant of a crash and is taken over', () => {
  const { clone } = throwawayRepo()
  writeFileSync(file(clone), '{"pid": 12')

  expect(takeLock(clone, 25, 1_000).ok).toBe(true)
})

test('in a worktree the lock lives in the shared .git of the clone', () => {
  const { clone } = throwawayRepo()
  const tree = join(clone, '..', 'tree')
  spawnSync('git', ['worktree', 'add', '-q', tree], { cwd: clone })

  expect(takeLock(tree, 25, 1_000).ok).toBe(true)
  expect(takeLock(clone, 26, 1_000).ok).toBe(false)
})

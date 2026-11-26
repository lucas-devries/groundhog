import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { git } from './git.ts'
import { throwawayRepo, worktreeOf } from './testing/throwaway-repo.ts'
import { prepareWorktree } from './worktree.ts'

/** Prepares the worktree of spec 1 with target branch main; collects the warnings. */
function prepare(clone: string, warnings: string[] = []) {
  return prepareWorktree({
    clone,
    path: worktreeOf(clone),
    spec: 1,
    targetBranch: 'main',
    hasSetup: true,
    warn: (text) => warnings.push(text),
  })
}

test('setup is due until it is recorded as done, which also discards what it left', () => {
  const { clone } = throwawayRepo()
  const path = worktreeOf(clone)

  expect(prepare(clone).setupDue).toBe(true)
  expect(git(path, 'branch', '--show-current')).toBe('spec/1')
  // Never recorded as done, as after a crash.
  const second = prepare(clone)
  expect(second.setupDue).toBe(true)
  writeFileSync(join(path, 'README.md'), 'changed by setup')
  second.setupDone()

  expect(git(path, 'status', '--porcelain')).toBe('')
  expect(prepare(clone).setupDue).toBe(false)
})

import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { afterEach, expect, test, vi } from 'vitest'
import { git } from './git.ts'
import { ownProcessGroup, reportsProcessGroup } from './testing/process-group.ts'
import { commitFile, throwawayRepo } from './testing/throwaway-repo.ts'

afterEach(() => {
  vi.unstubAllEnvs()
})

test('git runs in its own process group, so the first Ctrl+C does not end it', () => {
  vi.stubEnv('PATH', `${reportsProcessGroup('git')}${delimiter}${process.env.PATH}`)

  expect(git(process.cwd()).trim()).not.toBe(ownProcessGroup())
})

test('git runs no hooks, not even those the repo points core.hooksPath at', () => {
  const { clone } = throwawayRepo()
  mkdirSync(join(clone, 'hooks'))
  writeFileSync(join(clone, 'hooks/pre-commit'), '#!/bin/sh\ntouch hook-ran\nexit 1\n', {
    mode: 0o755,
  })
  git(clone, 'config', 'core.hooksPath', 'hooks')

  commitFile(clone, 'a.txt', 'a', 'Add a')

  expect(git(clone, 'log', '-1', '--format=%s')).toBe('Add a')
  expect(existsSync(join(clone, 'hook-ran'))).toBe(false)
})

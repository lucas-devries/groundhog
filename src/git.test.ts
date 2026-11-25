import { delimiter } from 'node:path'
import { afterEach, expect, test, vi } from 'vitest'
import { git } from './git.ts'
import { ownProcessGroup, reportsProcessGroup } from './testing/process-group.ts'

afterEach(() => {
  vi.unstubAllEnvs()
})

test('git runs in its own process group, so the first Ctrl+C does not end it', () => {
  vi.stubEnv('PATH', `${reportsProcessGroup('git')}${delimiter}${process.env.PATH}`)

  expect(git(process.cwd()).trim()).not.toBe(ownProcessGroup())
})

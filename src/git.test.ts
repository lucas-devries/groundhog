import { delimiter } from 'node:path'
import { afterEach, expect, test, vi } from 'vitest'
import { git } from './git.ts'
import { eigeneProzessgruppe, meldetProzessgruppe } from './testing/process-group.ts'

afterEach(() => {
  vi.unstubAllEnvs()
})

test('git läuft in einer eigenen Prozessgruppe, damit das erste Strg+C es nicht beendet', () => {
  vi.stubEnv('PATH', `${meldetProzessgruppe('git')}${delimiter}${process.env.PATH}`)

  expect(git(process.cwd()).trim()).not.toBe(eigeneProzessgruppe())
})

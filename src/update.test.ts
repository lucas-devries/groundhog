import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, expect, test, vi } from 'vitest'
import { newerVersion, update } from './update.ts'

afterEach(() => vi.unstubAllEnvs())

/**
 * Fake `npm` alone in the `PATH`: `npm view` prints `newest` (or fails with `viewError`),
 * `npm install` exits with `installExit`. Every call is logged.
 */
function fakeNpm(newest: string, { viewError = '', installExit = 0 } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'groundhog-npm-'))
  const log = join(directory, 'npm.log')
  const view = viewError ? `echo "${viewError}" >&2; exit 1` : `echo "${newest}"; exit 0`
  writeFileSync(
    join(directory, 'npm'),
    `#!/bin/sh\necho "$@" >> "${log}"\nif [ "$1" = view ]; then ${view}; fi\nexit ${installExit}\n`,
  )
  chmodSync(join(directory, 'npm'), 0o755)
  vi.stubEnv('PATH', `${directory}:${dirname(process.execPath)}:/bin`)
  return () => {
    try {
      return readFileSync(log, 'utf8').trim().split('\n')
    } catch {
      return []
    }
  }
}

test('the newest version on npm is newer when it is higher, compared numerically', () => {
  const calls = fakeNpm('0.10.0')

  expect(newerVersion('0.9.3')).toBe('0.10.0')
  expect(calls()).toEqual(['view groundhog-cli version'])
})

test.each([
  ['the same', '0.10.0'],
  ['older', '1.0.0'],
])('if the newest version is %s, there is no newer version', (_, version) => {
  fakeNpm('0.10.0')

  expect(newerVersion(version)).toBeUndefined()
})

test('a pre-release on npm does not count', () => {
  fakeNpm('1.0.0-rc.1')

  expect(newerVersion('0.1.0')).toBeUndefined()
})

test('a failed version comparison (offline, registry down) stays silent', () => {
  fakeNpm('', { viewError: 'npm error code ENOTFOUND' })

  expect(newerVersion('0.1.0')).toBeUndefined()
})

test('update installs the newest version from npm', () => {
  const calls = fakeNpm('0.3.0')

  expect(update('0.2.0')).toEqual({ exitCode: 0, message: 'groundhog 0.3.0 is installed.' })
  expect(calls()).toEqual(['view groundhog-cli version', 'install -g groundhog-cli@0.3.0'])
})

test('update reports when the version is already up to date and installs nothing', () => {
  const calls = fakeNpm('0.3.0')

  expect(update('0.3.0')).toEqual({ exitCode: 0, message: 'groundhog 0.3.0 is up to date.' })
  expect(calls()).toEqual(['view groundhog-cli version'])
})

test('update without an answer from npm aborts with a message', () => {
  const calls = fakeNpm('', { viewError: 'npm error code ENOTFOUND' })

  expect(update('0.3.0')).toEqual({
    exitCode: 1,
    message: 'Could not determine the newest version: npm error code ENOTFOUND',
  })
  expect(calls()).toEqual(['view groundhog-cli version'])
})

test('a failed npm install reports the failure', () => {
  fakeNpm('0.4.0', { installExit: 1 })

  expect(update('0.3.0')).toEqual({
    exitCode: 1,
    message: 'The update to 0.4.0 failed (npm install -g groundhog-cli@0.4.0).',
  })
})

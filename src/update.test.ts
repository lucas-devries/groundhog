import { chmodSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { afterEach, expect, test, vi } from 'vitest'
import { fakeGh, type GhAnswer } from './testing/fake-gh.ts'
import { newerVersion, update } from './update.ts'

afterEach(() => vi.unstubAllEnvs())

/** Fake `gh` (one answer to the tag query) and fake `npm` alone in the `PATH`. */
function fakes(tags: GhAnswer, npmExit = 0) {
  const fake = fakeGh([tags])
  writeFileSync(
    join(fake.directory, 'npm'),
    `#!/bin/sh\necho "$@" >> "${fake.directory}/npm.log"\nexit ${npmExit}\n`,
  )
  chmodSync(join(fake.directory, 'npm'), 0o755)
  vi.stubEnv('PATH', `${fake.directory}:${dirname(process.execPath)}:/bin`)
  const npm = () => {
    try {
      return readFileSync(join(fake.directory, 'npm.log'), 'utf8').trim().split('\n')
    } catch {
      return []
    }
  }
  return { fake, npm }
}

const tags = (...names: string[]): GhAnswer => ({ output: `${names.join('\n')}\n` })

test('the newest SemVer tag is the newer version, compared numerically, other tags do not count', () => {
  const { fake } = fakes(tags('v0.9.0', 'v0.10.0', 'v0.2.0', 'nightly', 'v1.0.0-rc.1'))

  expect(newerVersion('0.9.3')).toBe('v0.10.0')
  expect(fake.calls()[0]?.args).toEqual([
    'api',
    '--paginate',
    'repos/lucas-devries/groundhog/tags',
    '--jq',
    '.[].name',
  ])
})

test.each([
  ['the same', '0.10.0'],
  ['older', '1.0.0'],
])('if the newest tag is %s, there is no newer version', (_, version) => {
  fakes(tags('v0.10.0', 'v0.9.0'))

  expect(newerVersion(version)).toBeUndefined()
})

test('a failed version comparison (offline, rate limit) stays silent', () => {
  fakes({ exitCode: 1, error: 'API rate limit exceeded' })

  expect(newerVersion('0.1.0')).toBeUndefined()
})

test('update installs the newest tag like the first install from the GitHub repo', () => {
  const { npm } = fakes(tags('v0.2.0', 'v0.3.0'))

  expect(update('0.2.0')).toEqual({
    exitCode: 0,
    message: 'groundhog v0.3.0 is installed.',
  })
  expect(npm()).toEqual(['install -g github:lucas-devries/groundhog#v0.3.0'])
})

test('update reports when the version is already up to date and installs nothing', () => {
  const { npm } = fakes(tags('v0.3.0'))

  expect(update('0.3.0')).toEqual({ exitCode: 0, message: 'groundhog 0.3.0 is up to date.' })
  expect(npm()).toEqual([])
})

test('update without an answer from GitHub aborts with a message', () => {
  const { npm } = fakes({ exitCode: 1, error: 'dial tcp: no route to host' })

  expect(update('0.3.0')).toEqual({
    exitCode: 1,
    message: 'Could not determine the newest version: dial tcp: no route to host',
  })
  expect(npm()).toEqual([])
})

test('a failed npm install reports the failure', () => {
  fakes(tags('v0.4.0'), 1)

  expect(update('0.3.0')).toEqual({
    exitCode: 1,
    message: 'The update to v0.4.0 failed (npm install -g github:lucas-devries/groundhog#v0.4.0).',
  })
})

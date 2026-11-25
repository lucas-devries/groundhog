import { chmodSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { afterEach, expect, test, vi } from 'vitest'
import { fakeGh, type GhAntwort } from './testing/fake-gh.ts'
import { aktualisiere, neuereVersion } from './update.ts'

afterEach(() => vi.unstubAllEnvs())

/** Fake-`gh` (eine Antwort auf die Tag-Abfrage) und Fake-`npm` allein im `PATH`. */
function fakes(tags: GhAntwort, npmExit = 0) {
  const fake = fakeGh([tags])
  writeFileSync(
    join(fake.verzeichnis, 'npm'),
    `#!/bin/sh\necho "$@" >> "${fake.verzeichnis}/npm.log"\nexit ${npmExit}\n`,
  )
  chmodSync(join(fake.verzeichnis, 'npm'), 0o755)
  vi.stubEnv('PATH', `${fake.verzeichnis}:${dirname(process.execPath)}:/bin`)
  const npm = () => {
    try {
      return readFileSync(join(fake.verzeichnis, 'npm.log'), 'utf8').trim().split('\n')
    } catch {
      return []
    }
  }
  return { fake, npm }
}

const tags = (...namen: string[]): GhAntwort => ({ ausgabe: `${namen.join('\n')}\n` })

test('der neueste SemVer-Tag ist die neuere Version, numerisch verglichen, andere Tags zählen nicht', () => {
  const { fake } = fakes(tags('v0.9.0', 'v0.10.0', 'v0.2.0', 'nightly', 'v1.0.0-rc.1'))

  expect(neuereVersion('0.9.3')).toBe('v0.10.0')
  expect(fake.aufrufe()[0]?.args).toEqual([
    'api',
    '--paginate',
    'repos/lucas-devries/groundhog/tags',
    '--jq',
    '.[].name',
  ])
})

test.each([
  ['gleich', '0.10.0'],
  ['älter', '1.0.0'],
])('ist der neueste Tag %s, gibt es keine neuere Version', (_, version) => {
  fakes(tags('v0.10.0', 'v0.9.0'))

  expect(neuereVersion(version)).toBeUndefined()
})

test('ein gescheiterter Versionsvergleich (offline, Rate-Limit) bleibt stumm', () => {
  fakes({ exitCode: 1, fehler: 'API rate limit exceeded' })

  expect(neuereVersion('0.1.0')).toBeUndefined()
})

test('update installiert den neuesten Tag wie die Erstinstallation aus dem GitHub-Repo', () => {
  const { npm } = fakes(tags('v0.2.0', 'v0.3.0'))

  expect(aktualisiere('0.2.0')).toEqual({
    exitCode: 0,
    meldung: 'groundhog v0.3.0 ist installiert.',
  })
  expect(npm()).toEqual(['install -g github:lucas-devries/groundhog#v0.3.0'])
})

test('update meldet, wenn die Version schon aktuell ist, und installiert nichts', () => {
  const { npm } = fakes(tags('v0.3.0'))

  expect(aktualisiere('0.3.0')).toEqual({ exitCode: 0, meldung: 'groundhog 0.3.0 ist aktuell.' })
  expect(npm()).toEqual([])
})

test('update ohne Antwort von GitHub bricht mit Meldung ab', () => {
  const { npm } = fakes({ exitCode: 1, fehler: 'dial tcp: no route to host' })

  expect(aktualisiere('0.3.0')).toEqual({
    exitCode: 1,
    meldung: 'Die neueste Version ließ sich nicht ermitteln: dial tcp: no route to host',
  })
  expect(npm()).toEqual([])
})

test('ein gescheitertes npm install meldet das Scheitern', () => {
  fakes(tags('v0.4.0'), 1)

  expect(aktualisiere('0.3.0')).toEqual({
    exitCode: 1,
    meldung:
      'Das Update auf v0.4.0 ist gescheitert (npm install -g github:lucas-devries/groundhog#v0.4.0).',
  })
})

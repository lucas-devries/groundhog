import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { git } from './git.ts'
import { type Dialog, init } from './init.ts'
import { FESTE_HOSTS } from './sandbox.ts'
import { wegwerfRepo } from './testing/wegwerf-repo.ts'

const ABBRUCH = Symbol('Strg+C')
type Antwort = string | string[] | boolean | typeof ABBRUCH

/** Geskripteter Dialog: beantwortet die Fragen der Reihe nach und hält fest, was gezeigt wurde. */
function fakeDialog(antworten: Antwort[]) {
  const gezeigt: unknown[] = []
  const antworte = async (frage: unknown) => {
    gezeigt.push(frage)
    const antwort = antworten.shift()
    if (antwort === undefined) throw new Error(`keine Antwort für ${JSON.stringify(frage)}`)
    return antwort
  }
  const dialog = {
    multiline: (o) => antworte({ art: 'multiline', ...o }),
    text: (o) => antworte({ art: 'text', ...o }),
    multiselect: (o) => antworte({ art: 'multiselect', ...o }),
    confirm: (o) => antworte({ art: 'confirm', ...o }),
    info: (text) => gezeigt.push({ art: 'info', text }),
  } as Dialog
  return { dialog, gezeigt }
}

/** Ein Klon, dessen origin wie ein GitHub-Remote aussieht, mit den Remote-Branches main, develop, alt. */
function githubKlon(): string {
  const { remote, klon } = wegwerfRepo()
  for (const b of ['develop', 'alt']) git(klon, 'push', '-q', 'origin', `main:${b}`)
  const url = 'https://github.com/beispiel/projekt.git'
  git(klon, 'remote', 'set-url', 'origin', url)
  git(klon, 'config', `url.${remote}.insteadOf`, url)
  return klon
}

const starte = (verzeichnis: string, dialog: Dialog, umgebung = {}) =>
  init({ verzeichnis, dialog, istTerminal: true, ghAngemeldet: () => true, ...umgebung })

const datei = (verzeichnis: string) => readFileSync(join(verzeichnis, 'groundhog.json'), 'utf8')

test('init legt groundhog.json mit allen Feldern an, schreibt sonst nichts und nennt den nächsten Schritt', async () => {
  const klon = githubKlon()
  const { dialog } = fakeDialog([
    'npm test\n\n  npm run lint  \n',
    ['main', 'develop'],
    'a.com, b.com',
    '5',
  ])

  const ergebnis = await starte(klon, dialog)

  expect(datei(klon)).toBe(
    `{
  "checks": [
    "npm test",
    "npm run lint"
  ],
  "attempts": 5,
  "targetBranches": [
    "main",
    "develop"
  ],
  "sandbox": {
    "hosts": [
      "a.com",
      "b.com"
    ],
    "off": false
  }
}
`,
  )
  expect(git(klon, 'status', '--porcelain')).toBe('?? groundhog.json')
  expect(git(klon, 'log', '--format=%s')).toBe('init')
  expect(ergebnis.exitCode).toBe(0)
  expect(ergebnis.meldung.split('\n').at(-1)).toMatch(
    /groundhog\.json.*committe.*groundhog <spec>/i,
  )
})

test('init stellt vier Fragen: Checks, Ziel-Branches mit Default-Branch vorn, Hosts unter der festen Liste, Versuche', async () => {
  const klon = githubKlon()
  const { dialog, gezeigt } = fakeDialog(['true', ['main'], '', '3'])

  await starte(klon, dialog)

  expect(gezeigt).toEqual([
    expect.objectContaining({ art: 'multiline', initialValue: '' }),
    expect.objectContaining({
      art: 'multiselect',
      options: [
        { value: 'main', label: 'main' },
        { value: 'alt', label: 'alt' },
        { value: 'develop', label: 'develop' },
      ],
      initialValues: ['main'],
    }),
    { art: 'info', text: expect.stringContaining(FESTE_HOSTS.join(', ')) },
    expect.objectContaining({ art: 'text', initialValue: '' }),
    expect.objectContaining({ art: 'text', initialValue: '3' }),
  ])
  expect(JSON.parse(datei(klon))).toMatchObject({ attempts: 3, sandbox: { hosts: [] } })
})

test('Checks brauchen mindestens einen Befehl, Versuche eine ganze Zahl von 1 bis 10', async () => {
  const { dialog, gezeigt } = fakeDialog(['true', ['main'], '', '3'])
  await starte(githubKlon(), dialog)
  type Pruefe = { validate: (wert: string) => string | undefined }
  const checks = gezeigt[0] as Pruefe
  const attempts = gezeigt[4] as Pruefe

  expect(checks.validate(' \n ')).toBeDefined()
  expect(checks.validate('npm test')).toBeUndefined()
  for (const falsch of ['', '0', '11', '2.5', 'drei'])
    expect(attempts.validate(falsch)).toBeDefined()
  for (const gut of ['1', '10', ' 4 ']) expect(attempts.validate(gut)).toBeUndefined()
})

test('die Reihenfolge der Ziel-Branches folgt der Liste, nicht der Auswahl', async () => {
  const klon = githubKlon()
  const { dialog } = fakeDialog(['true', ['develop', 'main'], '', '3'])

  await starte(klon, dialog)

  expect(JSON.parse(datei(klon)).targetBranches).toEqual(['main', 'develop'])
})

test.each([
  ['package-lock.json', 'npm ci', 'npm run'],
  ['pnpm-lock.yaml', 'pnpm install --frozen-lockfile', 'pnpm run'],
  ['yarn.lock', 'yarn install --frozen-lockfile', 'yarn run'],
  ['bun.lock', 'bun install --frozen-lockfile', 'bun run'],
  [undefined, 'npm install', 'npm run'],
])(
  'Node-Projekt mit %s: Vorschlag aus Lockfile und den Scripts typecheck, lint, test',
  async (lockfile, install, run) => {
    const klon = githubKlon()
    const scripts = { build: 'tsc', test: 'vitest', typecheck: 'tsc --noEmit', lint: 'biome check' }
    writeFileSync(join(klon, 'package.json'), JSON.stringify({ scripts }))
    if (lockfile) writeFileSync(join(klon, lockfile), '')
    const { dialog, gezeigt } = fakeDialog(['true', ['main'], '', '3'])

    await starte(klon, dialog)

    expect(gezeigt[0]).toMatchObject({
      initialValue: `${install}\n${run} typecheck\n${run} lint\n${run} test`,
    })
  },
)

test('Strg+C bei jeder Frage schreibt nichts', async () => {
  for (let frage = 0; frage < 4; frage++) {
    const klon = githubKlon()
    const antworten: Antwort[] = ['true', ['main'], '', '3']
    antworten[frage] = ABBRUCH
    const { dialog } = fakeDialog(antworten)

    const ergebnis = await starte(klon, dialog)

    expect(existsSync(join(klon, 'groundhog.json'))).toBe(false)
    expect(ergebnis.exitCode).toBe(130)
  }
})

test('zweiter Aufruf: vorhandene Werte als Vorgabe, sandbox.off bleibt erhalten', async () => {
  const klon = githubKlon()
  writeFileSync(
    join(klon, 'groundhog.json'),
    JSON.stringify({
      checks: ['make test', 'make lint'],
      attempts: 7,
      targetBranches: ['develop', 'main'],
      sandbox: { hosts: ['x.com', 'y.com'], off: true },
    }),
  )
  const { dialog, gezeigt } = fakeDialog(['make test', ['main', 'develop'], 'x.com', '7'])

  await starte(klon, dialog)

  expect(gezeigt).toEqual([
    expect.objectContaining({ initialValue: 'make test\nmake lint' }),
    expect.objectContaining({
      options: [
        { value: 'develop', label: 'develop' },
        { value: 'main', label: 'main' },
        { value: 'alt', label: 'alt' },
      ],
      initialValues: ['develop', 'main'],
    }),
    expect.objectContaining({ art: 'info' }),
    expect.objectContaining({ initialValue: 'x.com, y.com' }),
    expect.objectContaining({ initialValue: '7' }),
  ])
  expect(JSON.parse(datei(klon))).toEqual({
    checks: ['make test'],
    attempts: 7,
    targetBranches: ['develop', 'main'],
    sandbox: { hosts: ['x.com'], off: true },
  })
})

test('zweiter Aufruf bei ungültiger Datei: Fehler zeigen; bei Nein bleibt die Datei unverändert', async () => {
  const klon = githubKlon()
  writeFileSync(join(klon, 'groundhog.json'), '{"checks": [], "ziel": 1}')
  const { dialog, gezeigt } = fakeDialog([false])

  const ergebnis = await starte(klon, dialog)

  expect(gezeigt).toEqual([
    { art: 'info', text: expect.stringContaining('checks: mindestens ein Eintrag nötig') },
    expect.objectContaining({ art: 'confirm', active: 'Ja', inactive: 'Nein' }),
  ])
  expect((gezeigt[0] as { text: string }).text).toContain('unbekannter Schlüssel: ziel')
  expect(datei(klon)).toBe('{"checks": [], "ziel": 1}')
  expect(ergebnis.exitCode).toBe(1)
})

test('zweiter Aufruf bei ungültiger Datei: bei Ja neu anlegen mit frischen Vorgaben', async () => {
  const klon = githubKlon()
  writeFileSync(join(klon, 'groundhog.json'), 'kaputt')
  const { dialog, gezeigt } = fakeDialog([true, 'true', ['main'], '', '3'])

  const ergebnis = await starte(klon, dialog)

  expect(gezeigt[2]).toMatchObject({ art: 'multiline', initialValue: '' })
  expect(JSON.parse(datei(klon))).toMatchObject({ checks: ['true'] })
  expect(ergebnis.exitCode).toBe(0)
})

test.each([
  [
    'außerhalb eines Git-Repos',
    () => mkdtempSync(join(tmpdir(), 'groundhog-')),
    {},
    /Root eines Git-Repos/,
  ],
  [
    'in einem Unterordner',
    () => {
      const klon = githubKlon()
      mkdirSync(join(klon, 'unter'))
      return join(klon, 'unter')
    },
    {},
    /Root eines Git-Repos/,
  ],
  ['ohne GitHub-Remote', () => wegwerfRepo().klon, {}, /GitHub-Remote/],
  ['ohne Anmeldung bei gh', githubKlon, { ghAngemeldet: () => false }, /gh auth login/],
  ['ohne Terminal an stdin', githubKlon, { istTerminal: false }, /Terminal/],
])('init bricht %s mit Grund ab und schreibt nichts', async (_, verzeichnis, umgebung, grund) => {
  const v = verzeichnis()
  const { dialog, gezeigt } = fakeDialog([])

  const ergebnis = await starte(v, dialog, umgebung)

  expect(ergebnis).toEqual({ exitCode: 1, meldung: expect.stringMatching(grund) })
  expect(gezeigt).toEqual([])
  expect(existsSync(join(v, 'groundhog.json'))).toBe(false)
})

import { delimiter } from 'node:path'
import { afterEach, expect, test, vi } from 'vitest'
import { GitHubTracker } from './github.ts'
import { aufnahme, fakeGh, type GhAntwort } from './testing/fake-gh.ts'
import { eigeneProzessgruppe, meldetProzessgruppe } from './testing/prozessgruppe.ts'

afterEach(() => {
  vi.unstubAllEnvs()
})

/** Ein GitHubTracker gegen ein Fake-`gh`; die erste Antwort ist der angemeldete Nutzer. */
async function verbunden(antworten: GhAntwort[]) {
  const gh = fakeGh([{ ausgabe: 'lucas-devries\n' }, ...antworten])
  vi.stubEnv('PATH', `${gh.verzeichnis}${delimiter}${process.env.PATH}`)
  const wartezeiten: number[] = []
  const tracker = await GitHubTracker.verbinde({
    verzeichnis: process.cwd(),
    warte: async (ms) => {
      wartezeiten.push(ms)
    },
  })
  return {
    tracker,
    wartezeiten,
    aufrufe: () =>
      gh
        .aufrufe()
        .slice(1)
        .map((a) => a.args),
  }
}

test('der angemeldete gh-Nutzer ist der Nutzer des Trackers', async () => {
  const { tracker } = await verbunden([])
  expect(tracker.nutzer).toBe('lucas-devries')
})

test('der Task-Graph sind die Sub-Issues der Spec mit Zustand, Labels, Assignees und Blockern, aus einer GraphQL-Abfrage', async () => {
  const { tracker, aufrufe } = await verbunden([aufnahme('task-graph-spec-25.json')])

  const tickets = await tracker.taskGraph(25)

  expect(tickets.map((t) => t.nummer)).toEqual([
    26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44,
  ])
  expect(tickets.find((t) => t.nummer === 32)).toEqual({
    nummer: 32,
    offen: true,
    labels: ['ready-for-agent'],
    assignees: [],
    blocker: [
      { nummer: 27, offen: true },
      { nummer: 28, offen: true },
    ],
  })
  const [aufruf, ...weitere] = aufrufe()
  expect(weitere).toEqual([])
  expect(aufruf?.slice(0, 2)).toEqual(['api', 'graphql'])
  expect(aufruf).toContain('spec=25')
})

test('beanspruchen setzt den angemeldeten Nutzer als Assignee ohne Label und Kommentar; lösen entfernt ihn', async () => {
  const { tracker, aufrufe } = await verbunden([{}, {}])

  await tracker.beanspruche(32)
  await tracker.gibFrei(32)

  expect(aufrufe()).toEqual([
    ['issue', 'edit', '32', '--add-assignee', 'lucas-devries'],
    ['issue', 'edit', '32', '--remove-assignee', 'lucas-devries'],
  ])
})

test('schließen, wieder öffnen und als gescheitert markieren', async () => {
  const { tracker, aufrufe } = await verbunden([{}, {}, {}])

  await tracker.schliesse(32)
  await tracker.oeffneWieder(32)
  await tracker.markiereGescheitert(32)

  expect(aufrufe()).toEqual([
    ['issue', 'close', '32'],
    ['issue', 'reopen', '32'],
    ['issue', 'edit', '32', '--remove-label', 'ready-for-agent', '--add-label', 'ready-for-human'],
  ])
})

test('kommentieren und einen PR anlegen geben den Text über stdin an gh', async () => {
  const gh = fakeGh([
    { ausgabe: 'lucas-devries\n' },
    {},
    { ausgabe: 'https://github.com/lucas-devries/groundhog/pull/7\n' },
  ])
  vi.stubEnv('PATH', `${gh.verzeichnis}${delimiter}${process.env.PATH}`)
  const tracker = await GitHubTracker.verbinde({ verzeichnis: process.cwd() })
  const kommentar = `Zeile mit "Anführungszeichen" und $HOME\n${'ä'.repeat(200_000)}`

  await tracker.kommentiere(25, kommentar)
  const url = await tracker.erstellePr({
    kopf: 'spec/25',
    basis: 'main',
    titel: 'Spec #25',
    body: 'Closes #25',
  })

  expect(url).toBe('https://github.com/lucas-devries/groundhog/pull/7')
  expect(gh.aufrufe().slice(1)).toEqual([
    { args: ['issue', 'comment', '25', '--body-file', '-'], eingabe: kommentar },
    {
      args: [
        'pr',
        'create',
        '--head',
        'spec/25',
        '--base',
        'main',
        '--title',
        'Spec #25',
        '--body-file',
        '-',
      ],
      eingabe: 'Closes #25',
    },
  ])
})

test('die Start-Prüfung meldet fehlende Labels, die Zahl der Sub-Issues und den Default-Branch', async () => {
  const { tracker } = await verbunden([
    aufnahme('startpruefung-spec-25.json'),
    aufnahme('startpruefung-ohne-sub-issues-und-human-label.json'),
  ])

  expect(await tracker.startPruefung(25)).toEqual({
    fehlendeLabels: [],
    subIssues: 19,
    defaultBranch: 'main',
    url: 'https://github.com/lucas-devries/groundhog',
  })
  expect(await tracker.startPruefung(32)).toEqual({
    fehlendeLabels: ['ready-for-human'],
    subIssues: 0,
    defaultBranch: 'main',
    url: 'https://github.com/lucas-devries/groundhog',
  })
})

const NETZFEHLER: GhAntwort = {
  fehler:
    'error connecting to api.github.com\ncheck your internet connection or https://githubstatus.com\n',
  exitCode: 1,
}

test('ist GitHub kurz nicht erreichbar, wiederholt der Adapter mit Wartezeit', async () => {
  const { tracker, wartezeiten, aufrufe } = await verbunden([NETZFEHLER, NETZFEHLER, {}])

  await tracker.schliesse(32)

  expect(aufrufe()).toHaveLength(3)
  expect(wartezeiten).toEqual([5_000, 15_000])
})

test('bleibt GitHub nicht erreichbar, meldet der Adapter nach drei Wiederholungen den Fehler', async () => {
  const { tracker, wartezeiten, aufrufe } = await verbunden([
    NETZFEHLER,
    NETZFEHLER,
    { fehler: 'gh: Server Error (HTTP 502)\n', exitCode: 1 },
    NETZFEHLER,
    {},
  ])

  await expect(tracker.taskGraph(25)).rejects.toThrow(/gh api graphql .*error connecting/s)
  expect(aufrufe()).toHaveLength(4)
  expect(wartezeiten).toEqual([5_000, 15_000, 45_000])
})

test('eine Antwort von GitHub wie ein fehlendes Issue wird nicht wiederholt', async () => {
  const { tracker, wartezeiten } = await verbunden([
    { fehler: 'gh: Could not resolve to an Issue with the number of 99999.\n', exitCode: 1 },
  ])

  await expect(tracker.taskGraph(99999)).rejects.toThrow(/Could not resolve to an Issue/)
  expect(wartezeiten).toEqual([])
})

test('gh läuft in einer eigenen Prozessgruppe, damit das erste Strg+C es nicht beendet', async () => {
  vi.stubEnv('PATH', `${meldetProzessgruppe('gh')}${delimiter}${process.env.PATH}`)

  const tracker = await GitHubTracker.verbinde({ verzeichnis: process.cwd() })

  expect(tracker.nutzer).not.toBe(eigeneProzessgruppe())
})

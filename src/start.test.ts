import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, vi } from 'vitest'
import { git } from './git.ts'
import { type MenueDialog, type Start, type StartOptionen, starte } from './start.ts'
import { aufnahme, fakeGh, type GhAntwort } from './testing/fake-gh.ts'
import { commitDatei, wegwerfRepo } from './testing/wegwerf-repo.ts'

const ABBRUCH = Symbol('Strg+C')

/** Geskripteter Dialog: beantwortet die Fragen der Reihe nach und hält alles Gezeigte fest. */
function fakeDialog(antworten: (string | boolean | symbol)[]) {
  const gezeigt: Record<string, unknown>[] = []
  const antworte = async (frage: Record<string, unknown>) => {
    gezeigt.push(frage)
    if (antworten.length === 0) throw new Error(`keine Antwort für ${JSON.stringify(frage)}`)
    return antworten.shift()
  }
  const dialog = {
    note: (text: string, titel: string) => gezeigt.push({ art: 'note', titel, text }),
    warn: (text: string) => gezeigt.push({ art: 'warn', text }),
    outro: (text: string) => gezeigt.push({ art: 'outro', text }),
    select: (o: object) => antworte({ art: 'select', ...o }),
    confirm: (o: object) => antworte({ art: 'confirm', ...o }),
  } as MenueDialog
  return { dialog, gezeigt }
}

const GH_VERSION = { ausgabe: 'gh version 2.94.0 (2026-05-01)\nhttps://github.com/cli/cli\n' }
const TOKEN = { ausgabe: 'gho_geheim\n' }
const NUTZER = { ausgabe: 'lucas\n' }

const KONFIGURATION = {
  checks: ['npm ci', 'npm test'],
  versuche: 4,
  zielBranches: ['main', 'develop'],
  sandbox: { hosts: [], aus: false },
}

/**
 * Ein startbereiter Klon von Spec #25: Konfiguration committet, `develop` auf dem Remote, `gh` und
 * `claude` als Fakes allein im `PATH` (neben `git` und `node`).
 */
function bereit({
  gh = [GH_VERSION, TOKEN, NUTZER, aufnahme('startpruefung-spec-25.json')],
  konfiguration = KONFIGURATION as object | null,
  claude = true,
  ohne = [] as string[],
} = {}) {
  const { klon } = wegwerfRepo()
  if (konfiguration) {
    commitDatei(klon, 'groundhog.json', JSON.stringify(konfiguration), 'konfiguration')
  }
  git(klon, 'push', '-q', 'origin', 'main', 'main:develop')
  const fake = fakeGh([...gh, aufnahme('task-graph-spec-25.json')])
  if (claude) {
    writeFileSync(join(fake.verzeichnis, 'claude'), '#!/bin/sh\necho "2.1.0 (Claude Code)"\n')
    chmodSync(join(fake.verzeichnis, 'claude'), 0o755)
  }
  if (ohne.includes('gh')) rmSync(join(fake.verzeichnis, 'gh'))
  const bin = mkdtempSync(join(tmpdir(), 'bin-'))
  for (const [name, ziel] of [
    ['git', '/usr/bin/git'],
    ['node', process.execPath],
  ] as const) {
    if (!ohne.includes(name)) symlinkSync(ziel, join(bin, name))
  }
  return { klon, fake, pfad: `${fake.verzeichnis}:${bin}` }
}

const sperre = (klon: string) => join(klon, '.git', 'groundhog.lock')

/** Startet mit dem `PATH` aus `bereit`; der Test selbst ruft danach wieder das echte `git`. */
async function start(
  { klon, pfad }: { klon: string; pfad: string },
  antworten: (string | boolean | symbol)[],
  optionen: Partial<StartOptionen> = {},
) {
  const { dialog, gezeigt } = fakeDialog(antworten)
  vi.stubEnv('PATH', pfad)
  const ergebnis: Start = await starte({
    verzeichnis: klon,
    spec: 25,
    dialog,
    istTerminal: true,
    sandboxFehlt: () => [],
    ...optionen,
  }).finally(() => vi.unstubAllEnvs())
  return { ergebnis, gezeigt }
}

test('das Menü zeigt den Lauf, fragt Ziel-Branch und Abschluss und sagt, dass keine Eingabe mehr nötig ist', async () => {
  const { klon, fake, pfad } = bereit()

  const { ergebnis, gezeigt } = await start({ klon, pfad }, ['develop', 'mergen'])

  expect(gezeigt).toEqual([
    {
      art: 'note',
      titel: 'Dieser Lauf',
      text: [
        'Spec #25',
        '19 Tickets, davon 18 für den Agent freigegeben',
        '#44: ready-for-human, wird nicht angefasst',
        'Checks: npm ci · npm test',
        'Sandbox: an (srt)',
        'Versuche pro Ticket: 4',
      ].join('\n'),
    },
    {
      art: 'select',
      message: 'Ziel-Branch: Wohin fließt die Arbeit am Ende?',
      options: [
        { value: 'main', label: 'main' },
        { value: 'develop', label: 'develop' },
      ],
      initialValue: 'main',
    },
    {
      art: 'select',
      message: 'Abschluss: Was geschieht mit spec/25, sobald alle Tickets geschlossen sind?',
      options: [
        { value: 'mergen', label: 'Mergen', hint: 'groundhog mergt nach develop und pusht' },
        { value: 'pr', label: 'PR', hint: 'groundhog öffnet einen PR nach develop' },
        { value: 'nichts', label: 'Nichts', hint: 'spec/25 bleibt stehen' },
      ],
      initialValue: 'mergen',
    },
    { art: 'outro', text: 'Ab hier ist keine Eingabe mehr nötig.' },
  ])
  if (!ergebnis.ok) throw new Error(ergebnis.meldung)
  expect(ergebnis.auswahl).toEqual({ zielBranch: 'develop', abschluss: 'mergen' })
  expect(ergebnis.token).toBe('gho_geheim')
  expect(ergebnis.repoUrl).toBe('https://github.com/lucas-devries/groundhog')
  expect(ergebnis.konfiguration.versuche).toBe(4)
  expect(ergebnis.versionen).toEqual({ claude: '2.1.0 (Claude Code)' })
  expect(ergebnis.sandbox).toBeDefined()
  expect(existsSync(sperre(klon))).toBe(true)
  ergebnis.freigeben()
  expect(existsSync(sperre(klon))).toBe(false)
  // Nur lesende Aufrufe an GitHub, kein Branch angelegt.
  expect(fake.aufrufe().map((a) => a.args.slice(0, 2).join(' '))).toEqual([
    '--version',
    'auth token',
    'api user',
    'api graphql',
    'api graphql',
  ])
  expect(git(klon, 'branch', '--list', 'spec/*')).toBe('')
})

test('aus einem Unterverzeichnis startet der Lauf im Repo-Root', async () => {
  const { klon, pfad } = bereit()
  mkdirSync(join(klon, 'unter'))

  const { ergebnis } = await start({ klon: join(klon, 'unter'), pfad }, ['main', 'pr'])

  expect(ergebnis).toMatchObject({ ok: true, verzeichnis: realpathSync(klon) })
})

test('bei main ist PR vorausgewählt', async () => {
  const { klon, pfad } = bereit()

  const { ergebnis, gezeigt } = await start({ klon, pfad }, ['main', 'pr'])

  expect(gezeigt[2]).toMatchObject({ art: 'select', initialValue: 'pr' })
  expect(ergebnis).toMatchObject({ ok: true, auswahl: { zielBranch: 'main', abschluss: 'pr' } })
})

test('main und Mergen: Warnung mit dem Integration-Branch, dann Ja/Nein mit Vorauswahl Nein', async () => {
  const { klon, pfad } = bereit()

  const { ergebnis, gezeigt } = await start({ klon, pfad }, ['main', 'mergen', true])

  expect(gezeigt.slice(3)).toEqual([
    {
      art: 'warn',
      text: 'Sind am Ende alle Tickets geschlossen, mergt groundhog spec/25 nach main und pusht, ohne nachzufragen.',
    },
    {
      art: 'confirm',
      message: 'Ohne weitere Rückfrage nach main mergen?',
      initialValue: false,
      active: 'Ja',
      inactive: 'Nein',
    },
    { art: 'outro', text: 'Ab hier ist keine Eingabe mehr nötig.' },
  ])
  expect(ergebnis).toMatchObject({ ok: true, auswahl: { zielBranch: 'main', abschluss: 'mergen' } })
})

test('Nein zum Mergen nach main bricht ab, ohne etwas zu verändern', async () => {
  const { klon, fake, pfad } = bereit()
  const vorher = git(klon, 'for-each-ref')

  const { ergebnis } = await start({ klon, pfad }, ['main', 'mergen', false])

  expect(ergebnis).toEqual({
    ok: false,
    exitCode: 1,
    meldung: 'Abgebrochen. Nichts wurde verändert.',
  })
  expect(existsSync(sperre(klon))).toBe(false)
  expect(git(klon, 'for-each-ref')).toBe(vorher)
  expect(git(klon, 'status', '--porcelain')).toBe('')
  expect(fake.aufrufe().every((a) => ['--version', 'auth', 'api'].includes(a.args[0] ?? ''))).toBe(
    true,
  )
})

test('Strg+C im Menü bricht mit Exit-Code 130 ab und gibt die Sperre frei', async () => {
  const { klon, pfad } = bereit()

  const { ergebnis } = await start({ klon, pfad }, ['main', ABBRUCH])

  expect(ergebnis).toEqual({
    ok: false,
    exitCode: 130,
    meldung: 'Abgebrochen. Nichts wurde verändert.',
  })
  expect(existsSync(sperre(klon))).toBe(false)
})

test('bei abgeschalteter Sandbox warnt das Menü, und der Lauf bekommt keine Sandbox', async () => {
  const { klon, pfad } = bereit({ konfiguration: { ...KONFIGURATION, sandbox: { aus: true } } })
  const sandboxFehlt = vi.fn(() => ['nie gefragt'])

  const { ergebnis, gezeigt } = await start({ klon, pfad }, ['develop', 'pr'], { sandboxFehlt })

  expect(gezeigt[0]).toMatchObject({ text: expect.stringContaining('Sandbox: aus') })
  expect(gezeigt[1]).toEqual({
    art: 'warn',
    text: 'Die Sandbox ist aus: Runs laufen im Auto-Mode ohne Grenzen auf diesem Rechner, mit deinem gh-Token.',
  })
  expect(sandboxFehlt).not.toHaveBeenCalled()
  expect(ergebnis).toMatchObject({ ok: true, sandbox: undefined })
})

const UPDATE_FRAGE = {
  art: 'confirm',
  message: 'groundhog v0.2.0 ist erschienen. Jetzt aktualisieren?',
  initialValue: false,
  active: 'Ja',
  inactive: 'Nein',
}

test('gibt es eine neuere Version, fragt das Menü zuerst nach dem Update; Nein startet den Lauf', async () => {
  const { klon, pfad } = bereit()
  const installiere = vi.fn()

  const { ergebnis, gezeigt } = await start({ klon, pfad }, [false, 'main', 'pr'], {
    update: { neuereVersion: () => 'v0.2.0', installiere },
  })

  expect(gezeigt[0]).toEqual(UPDATE_FRAGE)
  expect(gezeigt[1]).toMatchObject({ art: 'note', titel: 'Dieser Lauf' })
  expect(installiere).not.toHaveBeenCalled()
  expect(ergebnis).toMatchObject({ ok: true, auswahl: { zielBranch: 'main', abschluss: 'pr' } })
})

test('Ja zum Update installiert den Tag, beendet den Start und bittet um einen neuen Start', async () => {
  const { klon, pfad } = bereit()
  const installiere = vi.fn()

  const { ergebnis, gezeigt } = await start({ klon, pfad }, [true], {
    update: { neuereVersion: () => 'v0.2.0', installiere },
  })

  expect(gezeigt).toEqual([UPDATE_FRAGE])
  expect(installiere).toHaveBeenCalledWith('v0.2.0')
  expect(ergebnis).toEqual({
    ok: false,
    exitCode: 0,
    meldung: 'groundhog v0.2.0 ist installiert. Starte neu: groundhog 25',
  })
  expect(existsSync(sperre(klon))).toBe(false)
})

test('scheitert das Update, bricht der Start mit der Meldung ab', async () => {
  const { klon, pfad } = bereit()

  const { ergebnis } = await start({ klon, pfad }, [true], {
    update: {
      neuereVersion: () => 'v0.2.0',
      installiere: () => {
        throw new Error('Das Update auf v0.2.0 ist gescheitert.')
      },
    },
  })

  expect(ergebnis).toEqual({
    ok: false,
    exitCode: 1,
    meldung: 'Das Update auf v0.2.0 ist gescheitert.',
  })
  expect(existsSync(sperre(klon))).toBe(false)
})

test('ohne neuere Version fragt das Menü nicht nach dem Update', async () => {
  const { klon, pfad } = bereit()

  const { gezeigt } = await start({ klon, pfad }, ['main', 'pr'], {
    update: { neuereVersion: () => undefined, installiere: vi.fn() },
  })

  expect(gezeigt[0]).toMatchObject({ art: 'note', titel: 'Dieser Lauf' })
})

const ohneSubIssues: GhAntwort = {
  ausgabe: JSON.stringify({
    data: {
      repository: {
        url: 'https://github.com/lucas-devries/groundhog',
        defaultBranchRef: { name: 'main' },
        agent: { name: 'ready-for-agent' },
        human: { name: 'ready-for-human' },
        issue: { subIssues: { totalCount: 0 } },
      },
    },
  }),
}

interface Fall {
  grund: string
  bereit?: Parameters<typeof bereit>[0]
  vorbereiten?: (klon: string) => void
  /** Startet in einem leeren Temp-Verzeichnis statt im Klon. */
  ausserhalb?: boolean
  optionen?: { istTerminal?: boolean; sandboxFehlt?: () => string[] }
  meldung: string[]
}

const FAELLE: Fall[] = [
  { grund: 'git fehlt', bereit: { ohne: ['git'] }, meldung: ['git fehlt im PATH'] },
  { grund: 'gh fehlt', bereit: { ohne: ['gh'] }, meldung: ['gh fehlt im PATH'] },
  {
    grund: 'das Verzeichnis in keinem Git-Repo liegt',
    ausserhalb: true,
    meldung: ['groundhog muss in einem Git-Repo laufen.'],
  },
  {
    grund: 'gh ist zu alt',
    bereit: { gh: [{ ausgabe: 'gh version 2.93.9 (2026-01-01)\n' }] },
    meldung: ['gh ist zu alt (gh version 2.93.9 (2026-01-01))', '2.94'],
  },
  {
    grund: 'gh ist nicht angemeldet',
    bereit: { gh: [GH_VERSION, { exitCode: 1, fehler: 'no oauth token found' }] },
    meldung: ['gh ist nicht angemeldet', 'gh auth login'],
  },
  { grund: 'claude fehlt', bereit: { claude: false }, meldung: ['claude fehlt im PATH'] },
  {
    grund: 'die Projekt-Konfiguration fehlt',
    bereit: { konfiguration: null },
    meldung: ['groundhog.json fehlt', 'groundhog init'],
  },
  {
    grund: 'die Projekt-Konfiguration ist ungültig',
    bereit: { konfiguration: { checks: [], zielBranches: ['main'], extra: 1 } },
    meldung: ['checks: mindestens ein Eintrag nötig', 'unbekannter Schlüssel: extra'],
  },
  {
    grund: 'ein anderer Lauf die Sperre hält',
    vorbereiten: (klon) =>
      writeFileSync(sperre(klon), JSON.stringify({ pid: process.ppid, start: 1, spec: 7 })),
    meldung: [`läuft schon ein Lauf an Spec #7 (PID ${process.ppid})`],
  },
  {
    grund: 'das Arbeitsverzeichnis schmutzig ist',
    vorbereiten: (klon) => writeFileSync(join(klon, 'neu.txt'), 'x'),
    meldung: ['Arbeitsverzeichnis ist nicht sauber'],
  },
  {
    grund: 'ein Branch spec auf dem Remote liegt',
    vorbereiten: (klon) => git(klon, 'push', '-q', 'origin', 'main:spec'),
    meldung: ['Branch origin/spec'],
  },
  {
    grund: 'ein Branch ticket lokal liegt',
    vorbereiten: (klon) => git(klon, 'branch', 'ticket'),
    meldung: ['Branch ticket'],
  },
  {
    grund: 'ein Ziel-Branch auf dem Remote fehlt',
    bereit: { konfiguration: { ...KONFIGURATION, zielBranches: ['main', 'release'] } },
    meldung: ['Ziel-Branch fehlt auf dem Remote: release'],
  },
  {
    grund: 'ein Label fehlt',
    bereit: {
      gh: [
        GH_VERSION,
        TOKEN,
        NUTZER,
        aufnahme('startpruefung-ohne-sub-issues-und-human-label.json'),
      ],
    },
    meldung: ['fehlt das Label ready-for-human'],
  },
  {
    grund: 'die Spec keine Sub-Issues hat',
    bereit: { gh: [GH_VERSION, TOKEN, NUTZER, ohneSubIssues] },
    meldung: ['Spec #25 hat keine Sub-Issues', 'Sub-issues'],
  },
  {
    grund: 'es die Spec nicht gibt',
    bereit: {
      gh: [GH_VERSION, TOKEN, NUTZER, { exitCode: 1, fehler: 'Could not resolve to an Issue' }],
    },
    meldung: ['Could not resolve to an Issue'],
  },
  {
    grund: 'die Sandbox an, aber nicht startbar ist',
    optionen: { sandboxFehlt: () => ['bwrap not installed', 'Start als root'] },
    meldung: ['Sandbox ist an, startet aber nicht', '- bwrap not installed\n- Start als root'],
  },
  {
    grund: 'stdin kein Terminal ist',
    optionen: { istTerminal: false },
    meldung: ['Terminal an stdin'],
  },
]

test.each(FAELLE)('der Start bricht vor dem Menü ab, wenn $grund', async (fall) => {
  const { klon, fake, pfad } = bereit(fall.bereit)
  fall.vorbereiten?.(klon)
  const refs = git(klon, 'for-each-ref')
  const status = git(klon, 'status', '--porcelain')

  const ort = fall.ausserhalb ? mkdtempSync(join(tmpdir(), 'kein-repo-')) : klon
  const { ergebnis, gezeigt } = await start({ klon: ort, pfad }, [], fall.optionen)

  if (ergebnis.ok) throw new Error('Start ist nicht abgebrochen')
  expect(ergebnis.exitCode).toBe(1)
  for (const teil of fall.meldung) expect(ergebnis.meldung).toContain(teil)
  expect(gezeigt).toEqual([])
  // Nichts verändert: Branches, Arbeitsverzeichnis, Tracker; keine eigene Sperre bleibt.
  expect(git(klon, 'for-each-ref')).toBe(refs)
  expect(git(klon, 'status', '--porcelain')).toBe(status)
  expect(fake.aufrufe().every((a) => ['--version', 'auth', 'api'].includes(a.args[0] ?? ''))).toBe(
    true,
  )
  if (existsSync(sperre(klon))) {
    expect(JSON.parse(readFileSync(sperre(klon), 'utf8')).pid).not.toBe(process.pid)
  }
})

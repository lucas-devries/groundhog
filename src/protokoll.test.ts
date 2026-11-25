import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { type AgentSkript, fakeAgent } from './agent.ts'
import { type Ereignis, fahreLauf } from './engine.ts'
import { oeffneProtokoll } from './protokoll.ts'
import { durchreiche } from './sandbox.ts'
import { commitDatei, wegwerfRepo } from './testing/wegwerf-repo.ts'
import { InMemoryTracker } from './tracker.ts'
import { steuerbareUhr } from './uhr.ts'

const START = new Date(2026, 10, 25, 3, 4, 5).getTime()

/** Fährt einen Lauf über Spec 1 mit Protokoll; liefert dessen Pfad. */
async function lauf(
  klon: string,
  skript: AgentSkript[],
  optionen: {
    checks?: string[]
    token?: string
    weiter?: (e: Ereignis) => void
    /** Läuft zwischen dem Öffnen des Protokolls und dem Lauf. */
    nachOeffnen?: (pfad: string) => void
  } = {},
): Promise<string> {
  const { checks = ['true'], token, weiter } = optionen
  const protokoll = oeffneProtokoll({ verzeichnis: klon, spec: 1, start: START, weiter })
  optionen.nachOeffnen?.(protokoll.pfad)
  await fahreLauf({
    spec: 1,
    auswahl: { zielBranch: 'main', abschluss: 'nichts' },
    verzeichnis: klon,
    checks,
    token,
    versionen: { groundhog: '1.0.0', claude: '2.1.0', skills: '1.3.2' },
    tracker: new InMemoryTracker('ich', [
      { nummer: 2, offen: true, labels: ['ready-for-agent'], assignees: [], blocker: [] },
    ]),
    agent: fakeAgent(skript),
    sandbox: durchreiche,
    uhr: steuerbareUhr(START),
    melde: protokoll.melde,
  })
  return protokoll.pfad
}

const commitet: AgentSkript = ({ verzeichnis }) => {
  commitDatei(verzeichnis, 'a.txt', 'a', 'Ticket 2 umsetzen')
  return { erfolg: true, tokens: { input_tokens: 10, output_tokens: 5 }, kostenUsd: 0.25 }
}

const zeilen = (datei: string): Ereignis[] =>
  readFileSync(datei, 'utf8')
    .trimEnd()
    .split('\n')
    .map((z) => JSON.parse(z))

test('lauf.jsonl hält jedes Ereignis der Engine als eine Zeile fest, im Ordner des Laufs', async () => {
  const { klon } = wegwerfRepo()

  const pfad = await lauf(klon, [commitet])

  expect(pfad).toBe(join(klon, '.git/groundhog/laeufe/20261125-030405-spec-1'))
  const ereignisse = zeilen(join(pfad, 'lauf.jsonl'))
  expect(ereignisse.map((e) => e.art)).toEqual([
    'lauf-begonnen',
    'task-graph',
    'ticket-genommen',
    'versuch-begonnen',
    'run-beendet',
    'pruefung',
    'pruefung',
    'pruefung',
    'pruefung',
    'pruefung',
    'push',
    'ticket-erledigt',
    'task-graph',
    'lauf-beendet',
  ])
  expect(ereignisse[0]).toMatchObject({
    spec: 1,
    auswahl: { zielBranch: 'main', abschluss: 'nichts' },
    versionen: { groundhog: '1.0.0', claude: '2.1.0', skills: '1.3.2' },
  })
  expect(ereignisse[4]).toMatchObject({
    ticket: 2,
    run: 1,
    versuch: 1,
    erfolg: true,
    tokens: { input_tokens: 10, output_tokens: 5 },
    kostenUsd: 0.25,
  })
  expect(ereignisse[10]).toMatchObject({ branch: 'spec/1' })
  expect(ereignisse[13]).toEqual({ art: 'lauf-beendet', abschluss: { art: 'nichts' }, zeit: START })
})

test('die Übersicht liegt als uebersicht.md im Ordner des Laufs, wie die Engine sie meldet', async () => {
  const { klon } = wegwerfRepo()
  let gemeldet = ''

  const pfad = await lauf(klon, [commitet], {
    weiter: (e) => {
      if (e.art === 'lauf-beendet') gemeldet = e.uebersicht
    },
  })

  expect(readFileSync(join(pfad, 'uebersicht.md'), 'utf8')).toBe(`${gemeldet}\n`)
  expect(gemeldet).toMatch(/^# Übersicht Spec #1\n/)
})

test('jeder Run hat seine rohe Ausgabe und die ungekürzte Ausgabe der Checks danach', async () => {
  const { klon } = wegwerfRepo()

  const pfad = await lauf(
    klon,
    [
      (auftrag) => {
        auftrag.ausgabe('{"type":"system","subtype":"init"}')
        auftrag.ausgabe('{"type":"result","subtype":"success"}')
        return commitet(auftrag)
      },
      (auftrag) => {
        auftrag.ausgabe('{"type":"result","subtype":"success"}')
        commitDatei(auftrag.verzeichnis, 'gruen', '', 'grün machen')
        return { erfolg: true }
      },
    ],
    { checks: ['echo vorher', 'test -f gruen || { seq 0 149 | sed "s/^/zeile /"; false; }'] },
  )

  expect(readdirSync(pfad).sort()).toEqual([
    'lauf.jsonl',
    'ticket-2-run-1-checks.log',
    'ticket-2-run-1.jsonl',
    'ticket-2-run-2-checks.log',
    'ticket-2-run-2.jsonl',
    'uebersicht.md',
  ])
  expect(readFileSync(join(pfad, 'ticket-2-run-1.jsonl'), 'utf8')).toBe(
    '{"type":"system","subtype":"init"}\n{"type":"result","subtype":"success"}\n',
  )
  const checks1 = readFileSync(join(pfad, 'ticket-2-run-1-checks.log'), 'utf8')
  expect(checks1).toContain('$ echo vorher\nvorher\n')
  expect(checks1).toContain('zeile 0\n')
  expect(checks1).toContain('zeile 149')
  expect(readFileSync(join(pfad, 'ticket-2-run-2-checks.log'), 'utf8')).not.toContain('zeile 0\n')
  const ereignisse = zeilen(join(pfad, 'lauf.jsonl'))
  expect(ereignisse.filter((e) => e.art === 'run-beendet')).toMatchObject([
    { run: 1, versuch: 1 },
    { run: 2, versuch: 2 },
  ])
  // Rohe Ausgaben stehen nur in den eigenen Dateien.
  expect(ereignisse.some((e) => e.art === 'run-ausgabe')).toBe(false)
  expect(JSON.stringify(ereignisse)).not.toContain('zeile 0')
})

test('das gh-Token erscheint weder im Protokoll noch in der Rückmeldung an den nächsten Run', async () => {
  const { klon } = wegwerfRepo()
  let rueckmeldung: string | undefined
  let zurueck: string | undefined

  const pfad = await lauf(
    klon,
    [
      (auftrag) => {
        // Der Adapter wertet nur die gefilterte Zeile aus, etwa für die Blocks.
        zurueck = auftrag.ausgabe('{"text":"GH_TOKEN=ghp_geheim"}')
        return commitet(auftrag)
      },
      (auftrag) => {
        rueckmeldung = auftrag.rueckmeldung
        commitDatei(auftrag.verzeichnis, 'gruen', '', 'grün machen')
        return { erfolg: true }
      },
    ],
    { checks: ['echo token ghp_$(echo geheim); test -f gruen'], token: 'ghp_geheim' },
  )

  const alles = readdirSync(pfad)
    .map((d) => readFileSync(join(pfad, d), 'utf8'))
    .join('\n')
  expect(alles).not.toContain('ghp_geheim')
  expect(zurueck).toBe('{"text":"GH_TOKEN=***"}')
  expect(readFileSync(join(pfad, 'ticket-2-run-1.jsonl'), 'utf8')).toContain('GH_TOKEN=***')
  expect(readFileSync(join(pfad, 'ticket-2-run-1-checks.log'), 'utf8')).toContain('token ***')
  expect(rueckmeldung).toContain('token ***')
  expect(rueckmeldung).not.toContain('ghp_geheim')
})

test('die letzten 10 Läufe bleiben, ältere löscht der Start des nächsten', async () => {
  const { klon } = wegwerfRepo()
  const laeufe = join(klon, '.git/groundhog/laeufe')
  const alte = Array.from({ length: 10 }, (_, i) => `202611${10 + i}-120000-spec-${i}`)
  for (const alt of alte) mkdirSync(join(laeufe, alt), { recursive: true })

  await lauf(klon, [commitet])

  expect(readdirSync(laeufe).sort()).toEqual([...alte.slice(1), '20261125-030405-spec-1'])
})

test('scheitert ein Schreiben, gibt es eine einzige Warnung, und der Lauf geht weiter', async () => {
  const { klon } = wegwerfRepo()
  const ereignisse: Ereignis[] = []

  await lauf(klon, [commitet], {
    weiter: (e) => ereignisse.push(e),
    nachOeffnen: (pfad) => {
      rmSync(pfad, { recursive: true })
      writeFileSync(pfad, 'kein Ordner')
    },
  })

  expect(ereignisse.filter((e) => e.art === 'warnung')).toHaveLength(1)
  expect(ereignisse.map((e) => e.art)).toContain('ticket-erledigt')
  expect(ereignisse.at(-1)?.art).toBe('lauf-beendet')
})

test('lässt sich der Ordner des Laufs nicht anlegen, bricht der Start ab', () => {
  const { klon } = wegwerfRepo()
  writeFileSync(join(klon, '.git/groundhog'), 'kein Ordner')

  expect(() => oeffneProtokoll({ verzeichnis: klon, spec: 1, start: START })).toThrow()
})

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { leseKonfiguration } from './konfiguration.ts'

function mitDatei(inhalt: string): string {
  const verzeichnis = mkdtempSync(join(tmpdir(), 'groundhog-'))
  writeFileSync(join(verzeichnis, 'groundhog.json'), inhalt)
  return verzeichnis
}

const fehlerVon = (inhalt: unknown) => {
  const gelesen = leseKonfiguration(mitDatei(JSON.stringify(inhalt)))
  return gelesen.ok ? [] : gelesen.fehler
}

test('eine fehlende Datei verweist auf groundhog init', () => {
  const gelesen = leseKonfiguration(mkdtempSync(join(tmpdir(), 'groundhog-')))

  expect(gelesen).toMatchObject({ ok: false, fehlt: true })
  expect(gelesen.ok || gelesen.fehler.join()).toContain('groundhog init')
})

test('nur die Pflichtfelder ergeben die Defaults der übrigen', () => {
  expect(leseKonfiguration(mitDatei('{"checks":["npm test"],"zielBranches":["main"]}'))).toEqual({
    ok: true,
    konfiguration: {
      checks: ['npm test'],
      versuche: 3,
      zielBranches: ['main'],
      sandbox: { hosts: [], aus: false },
    },
  })
})

test('alle Felder gesetzt werden übernommen', () => {
  const datei = {
    checks: ['npm ci', 'npm test'],
    versuche: 10,
    zielBranches: ['develop', 'main'],
    sandbox: { hosts: ['*.example.com'], aus: true },
  }

  expect(leseKonfiguration(mitDatei(JSON.stringify(datei)))).toEqual({
    ok: true,
    konfiguration: datei,
  })
})

test('kein JSON', () => {
  const gelesen = leseKonfiguration(mitDatei('{ checks: '))

  expect(gelesen).toMatchObject({ ok: false, fehlt: false })
  expect(gelesen.ok || gelesen.fehler).toEqual([
    expect.stringContaining('groundhog.json ist kein gültiges JSON'),
  ])
})

test('kein Objekt', () => {
  expect(fehlerVon(['npm test'])).toEqual(['groundhog.json muss ein JSON-Objekt sein'])
})

test('fehlende Pflichtfelder', () => {
  expect(fehlerVon({})).toEqual(['checks fehlt', 'zielBranches fehlt'])
})

test('leere Listen', () => {
  expect(fehlerVon({ checks: [], zielBranches: [] })).toEqual([
    'checks: mindestens ein Eintrag nötig',
    'zielBranches: mindestens ein Eintrag nötig',
  ])
})

test('falsche Typen', () => {
  expect(
    fehlerVon({
      checks: 'npm test',
      versuche: '3',
      zielBranches: ['main', 1],
      sandbox: { hosts: 'a.com', aus: 'nein' },
    }),
  ).toEqual([
    'checks: Liste von Strings erwartet',
    'versuche: ganze Zahl von 1 bis 10 erwartet',
    'zielBranches: Liste von Strings erwartet',
    'sandbox.hosts: Liste von Strings erwartet',
    'sandbox.aus: true oder false erwartet',
  ])
  expect(fehlerVon({ checks: ['x'], zielBranches: ['main'], sandbox: [] })).toEqual([
    'sandbox: Objekt erwartet',
  ])
})

test('versuche außerhalb von 1 bis 10 oder keine ganze Zahl', () => {
  for (const versuche of [0, 11, 2.5]) {
    expect(fehlerVon({ checks: ['x'], zielBranches: ['main'], versuche })).toEqual([
      'versuche: ganze Zahl von 1 bis 10 erwartet',
    ])
  }
})

test('unbekannte Schlüssel, auch in sandbox', () => {
  expect(
    fehlerVon({ checks: ['x'], zielBranches: ['main'], versuch: 3, sandbox: { host: [] } }),
  ).toEqual(['unbekannter Schlüssel: versuch', 'unbekannter Schlüssel: sandbox.host'])
})

test('alle Fehler auf einmal', () => {
  expect(fehlerVon({ checks: [], versuche: 0, sandbox: { aus: 1 }, ziel: 'main' })).toEqual([
    'checks: mindestens ein Eintrag nötig',
    'versuche: ganze Zahl von 1 bis 10 erwartet',
    'zielBranches fehlt',
    'sandbox.aus: true oder false erwartet',
    'unbekannter Schlüssel: ziel',
  ])
})

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { leseKonfiguration } from './config.ts'

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
  expect(leseKonfiguration(mitDatei('{"checks":["npm test"],"targetBranches":["main"]}'))).toEqual({
    ok: true,
    konfiguration: {
      checks: ['npm test'],
      attempts: 3,
      targetBranches: ['main'],
      sandbox: { hosts: [], off: false },
    },
  })
})

test('alle Felder gesetzt werden übernommen', () => {
  const datei = {
    checks: ['npm ci', 'npm test'],
    attempts: 10,
    targetBranches: ['develop', 'main'],
    sandbox: { hosts: ['*.example.com'], off: true },
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
  expect(fehlerVon({})).toEqual(['checks fehlt', 'targetBranches fehlt'])
})

test('leere Listen', () => {
  expect(fehlerVon({ checks: [], targetBranches: [] })).toEqual([
    'checks: mindestens ein Eintrag nötig',
    'targetBranches: mindestens ein Eintrag nötig',
  ])
})

test('falsche Typen', () => {
  expect(
    fehlerVon({
      checks: 'npm test',
      attempts: '3',
      targetBranches: ['main', 1],
      sandbox: { hosts: 'a.com', off: 'nein' },
    }),
  ).toEqual([
    'checks: Liste von Strings erwartet',
    'attempts: ganze Zahl von 1 bis 10 erwartet',
    'targetBranches: Liste von Strings erwartet',
    'sandbox.hosts: Liste von Strings erwartet',
    'sandbox.off: true oder false erwartet',
  ])
  expect(fehlerVon({ checks: ['x'], targetBranches: ['main'], sandbox: [] })).toEqual([
    'sandbox: Objekt erwartet',
  ])
})

test('attempts außerhalb von 1 bis 10 oder keine ganze Zahl', () => {
  for (const attempts of [0, 11, 2.5]) {
    expect(fehlerVon({ checks: ['x'], targetBranches: ['main'], attempts })).toEqual([
      'attempts: ganze Zahl von 1 bis 10 erwartet',
    ])
  }
})

test('unbekannte Schlüssel, auch in sandbox', () => {
  expect(
    fehlerVon({ checks: ['x'], targetBranches: ['main'], attempt: 3, sandbox: { host: [] } }),
  ).toEqual(['unbekannter Schlüssel: attempt', 'unbekannter Schlüssel: sandbox.host'])
})

test('alle Fehler auf einmal', () => {
  expect(fehlerVon({ checks: [], attempts: 0, sandbox: { off: 1 }, ziel: 'main' })).toEqual([
    'checks: mindestens ein Eintrag nötig',
    'attempts: ganze Zahl von 1 bis 10 erwartet',
    'targetBranches fehlt',
    'sandbox.off: true oder false erwartet',
    'unbekannter Schlüssel: ziel',
  ])
})

import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { type AgentSkript, fakeAgent } from './agent.ts'
import { type Ereignis, fahreLauf, type LaufErgebnis } from './engine.ts'
import { durchreiche, type Sandbox } from './sandbox.ts'
import { commitDatei, wegwerfRepo } from './testing/wegwerf-repo.ts'
import { InMemoryTracker } from './tracker.ts'
import { steuerbareUhr } from './uhr.ts'

const MINUTE = 60_000
const PUFFER = MINUTE

/** Fährt einen Lauf über Spec 1 mit einem Ticket #2, ohne Angabe mit einem Versuch. */
async function lauf(
  skript: AgentSkript[],
  optionen: {
    erschoepftBis?: () => number | undefined
    uhr?: ReturnType<typeof steuerbareUhr>
    versuche?: number
    checks?: string[]
    sandbox?: Sandbox
  } = {},
) {
  const { klon } = wegwerfRepo()
  const tracker = new InMemoryTracker('ich', [
    { nummer: 2, offen: true, labels: ['ready-for-agent'], assignees: [], blocker: [] },
  ])
  const uhr = optionen.uhr ?? steuerbareUhr()
  const ereignisse: Ereignis[] = []
  const ergebnis: LaufErgebnis = await fahreLauf({
    spec: 1,
    auswahl: { zielBranch: 'main', abschluss: 'nichts' },
    verzeichnis: klon,
    checks: optionen.checks ?? ['true'],
    versuche: optionen.versuche ?? 1,
    tracker,
    agent: fakeAgent(skript, optionen.erschoepftBis),
    sandbox: optionen.sandbox ?? durchreiche,
    uhr,
    melde: (e) => ereignisse.push(e),
  })
  return { ergebnis, ereignisse, tracker, klon, uhr }
}

const commitet: AgentSkript = ({ verzeichnis }) => {
  commitDatei(verzeichnis, 'a.txt', 'a', 'Ticket 2 umsetzen')
  return { erfolg: true }
}

test('am Usage-Limit wartet die Engine bis zum Reset plus Puffer und startet denselben Versuch neu', async () => {
  const uhr = steuerbareUhr(1_000)
  const reset = 3 * 60 * MINUTE
  let imZweitenRun: unknown

  const { ereignisse, tracker } = await lauf(
    [
      ({ verzeichnis }) => {
        writeFileSync(join(verzeichnis, 'a.txt'), 'x')
        return { erfolg: false, usageLimit: reset }
      },
      (auftrag) => {
        imZweitenRun = {
          zeit: uhr.jetzt(),
          halbfertig: existsSync(join(auftrag.verzeichnis, 'a.txt')),
          rueckmeldung: auftrag.rueckmeldung,
        }
        return commitet(auftrag)
      },
    ],
    { uhr },
  )

  expect(imZweitenRun).toEqual({ zeit: reset + PUFFER, halbfertig: true, rueckmeldung: undefined })
  expect(tracker.ticket(2).offen).toBe(false)
  expect(ereignisse.filter((e) => e.art === 'versuch-begonnen')).toHaveLength(1)
  expect(ereignisse.filter((e) => e.art === 'pause')).toEqual([
    { art: 'pause', ticket: 2, reset, zeit: 1_000 },
  ])
})

test('ist vor dem Neustart noch ein Fenster erschöpft, wartet die Engine bis zu dessen Reset', async () => {
  const uhr = steuerbareUhr()
  const ersterReset = 60 * MINUTE
  const zweiterReset = 24 * 60 * MINUTE
  const abfragen: number[] = []
  let startZweiterRun: number | undefined

  const { ereignisse } = await lauf(
    [
      () => ({ erfolg: false, usageLimit: ersterReset }),
      (auftrag) => {
        startZweiterRun = uhr.jetzt()
        return commitet(auftrag)
      },
    ],
    {
      uhr,
      erschoepftBis: () => {
        abfragen.push(uhr.jetzt())
        return abfragen.length === 1 ? zweiterReset : undefined
      },
    },
  )

  expect(abfragen).toEqual([ersterReset + PUFFER, zweiterReset + PUFFER])
  expect(startZweiterRun).toBe(zweiterReset + PUFFER)
  expect(
    ereignisse.filter((e) => e.art === 'pause').map((e) => e.art === 'pause' && e.reset),
  ).toEqual([ersterReset, zweiterReset])
})

test('verlangt ein Abbruch ohne Reset-Zeit Guthaben, hält die Engine den Lauf an, statt zu warten', async () => {
  const uhr = steuerbareUhr()

  const { ergebnis, ereignisse, tracker } = await lauf(
    [() => ({ erfolg: false, usageLimit: 'guthaben' })],
    { uhr },
  )

  expect(ergebnis).toEqual({ tickets: [], angehalten: 'guthaben' })
  expect(uhr.jetzt()).toBe(0)
  expect(ereignisse.map((e) => e.art)).toEqual([
    'ticket-genommen',
    'versuch-begonnen',
    'lauf-angehalten',
  ])
  expect(tracker.ticket(2)).toMatchObject({ offen: true, labels: ['ready-for-agent'] })
})

test('ein Run endet nach 60 Minuten und ist ein roter Versuch', async () => {
  const uhr = steuerbareUhr()
  const abgebrochen: boolean[] = []
  let rueckmeldung: string | undefined

  const { tracker } = await lauf(
    [
      (auftrag) => {
        commitet(auftrag)
        uhr.vorstellen(60 * MINUTE)
        abgebrochen.push(auftrag.signal.aborted)
        return { erfolg: true }
      },
      (auftrag) => {
        rueckmeldung = auftrag.rueckmeldung
        uhr.vorstellen(59 * MINUTE)
        abgebrochen.push(auftrag.signal.aborted)
        return { erfolg: true }
      },
    ],
    { uhr, versuche: 2 },
  )

  expect(abgebrochen).toEqual([true, false])
  expect(rueckmeldung).toContain('nach 60 Minuten beendet')
  expect(tracker.ticket(2).offen).toBe(false)
})

test('ein Durchgang der Checks endet nach 15 Minuten und ist ein roter Versuch', async () => {
  const uhr = steuerbareUhr()
  // Jeder Check dauert 10 Minuten; der zweite reißt das Zeitlimit des Durchgangs.
  const sandbox: Sandbox = {
    fuehreAus: (befehl, optionen) => {
      const ausfuehrung = durchreiche.fuehreAus(befehl, optionen)
      uhr.vorstellen(10 * MINUTE)
      return ausfuehrung
    },
  }

  const { ereignisse } = await lauf([commitet], {
    uhr,
    sandbox,
    checks: ['true', 'sleep 30; echo nie'],
  })

  expect(
    ereignisse.filter((e) => e.art === 'pruefung' && e.name.startsWith('Check')),
  ).toMatchObject([
    { name: 'Check: true', ok: true },
    { name: 'Check: sleep 30; echo nie', ok: false },
  ])
  expect(ereignisse.at(-1)).toMatchObject({
    art: 'ticket-gescheitert',
    pruefung: 'Check: sleep 30; echo nie',
  })
})

test('die Rückmeldung nach abgelaufenen Checks nennt das Zeitlimit', async () => {
  const uhr = steuerbareUhr()
  let rueckmeldung: string | undefined
  const sandbox: Sandbox = {
    fuehreAus: async (_befehl, { signal }) => {
      uhr.vorstellen(15 * MINUTE)
      return { exitCode: signal.aborted ? 1 : 0, ausgabe: 'halb fertig' }
    },
  }

  await lauf(
    [
      commitet,
      (auftrag) => {
        rueckmeldung = auftrag.rueckmeldung
        return { erfolg: true }
      },
    ],
    { uhr, sandbox, versuche: 2 },
  )

  expect(rueckmeldung).toContain('nach 15 Minuten beendet')
  expect(rueckmeldung).toContain('halb fertig')
})

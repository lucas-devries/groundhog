import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { abbruchWaechter } from './abbruch.ts'
import { type AgentSkript, fakeAgent, type RunAuftrag } from './agent.ts'
import { type Ereignis, fahreLauf, type LaufErgebnis } from './engine.ts'
import { git } from './git.ts'
import { durchreiche } from './sandbox.ts'
import { commitDatei, wegwerfRepo } from './testing/wegwerf-repo.ts'
import { InMemoryTracker } from './tracker.ts'
import { steuerbareUhr } from './uhr.ts'

const zweiTickets = () =>
  new InMemoryTracker('ich', [
    { nummer: 2, offen: true, labels: ['ready-for-agent'], assignees: [], blocker: [] },
    { nummer: 3, offen: true, labels: ['ready-for-agent'], assignees: [], blocker: [] },
  ])

/** Ein Lauf über Spec 1 mit einem Abbruch-Wächter an einer steuerbaren Uhr. */
function aufbau(tracker = zweiTickets()) {
  const uhr = steuerbareUhr()
  const hinweise: string[] = []
  let hart = 0
  const waechter = abbruchWaechter({
    uhr,
    hinweis: (text) => hinweise.push(text),
    hart: () => {
      hart++
    },
  })
  const ereignisse: Ereignis[] = []
  const lauf = (klon: string, skript: AgentSkript[], versuche?: number) =>
    fahreLauf({
      spec: 1,
      auswahl: { zielBranch: 'main', abschluss: 'nichts' },
      verzeichnis: klon,
      checks: ['true'],
      versuche,
      tracker,
      agent: fakeAgent(skript),
      sandbox: durchreiche,
      uhr,
      abbruch: waechter.signal,
      melde: (e) => ereignisse.push(e),
    })
  return { uhr, hinweise, hartesEnde: () => hart, waechter, ereignisse, lauf, tracker }
}

const commitet =
  (nr: number): AgentSkript =>
  ({ verzeichnis }) => {
    commitDatei(verzeichnis, `${nr}.txt`, 'x', `Ticket ${nr}`)
    return { erfolg: true }
  }

/** Ein Run, der halb fertig ist und nach `signale` endet, wie der Claude-Adapter beim Abbruch. */
const unterbrochen =
  (signale: () => void): AgentSkript =>
  (auftrag: RunAuftrag) => {
    commitDatei(auftrag.verzeichnis, 'halb.txt', 'x', 'halb fertig')
    git(auftrag.verzeichnis, 'push', '-q', 'origin', `ticket/${auftrag.ticket.nummer}`)
    writeFileSync(join(auftrag.verzeichnis, 'schmutz.txt'), 'x')
    signale()
    return { erfolg: !auftrag.signal.aborted }
  }

function erwarteAufgeraeumt(
  klon: string,
  remote: string,
  tracker: InMemoryTracker,
  ergebnis: LaufErgebnis,
  ereignisse: Ereignis[],
) {
  expect(ergebnis.angehalten).toBe('abgebrochen')
  expect(tracker.ticket(2)).toMatchObject({ offen: true, assignees: [] })
  expect(git(klon, 'status', '--porcelain')).toBe('')
  expect(git(klon, 'branch', '--show-current')).toBe('main')
  expect(git(klon, 'branch', '--list', 'ticket/*')).toBe('')
  expect(git(remote, 'branch', '--list', 'ticket/*')).toBe('')
  expect(tracker.kommentare(1)).toEqual([])
  const ende = ereignisse.at(-1)
  expect(ende).toMatchObject({ art: 'lauf-beendet' })
  expect(ende?.art === 'lauf-beendet' && ende.uebersicht).toContain('abgebrochen')
}

test('zweimal Strg+C in einem Run: der Lauf räumt auf und endet abgebrochen', async () => {
  const { remote, klon } = wegwerfRepo()
  const a = aufbau()

  const ergebnis = await a.lauf(klon, [
    unterbrochen(() => {
      a.waechter.empfange('SIGINT')
      a.waechter.empfange('SIGINT')
    }),
  ])

  erwarteAufgeraeumt(klon, remote, a.tracker, ergebnis, a.ereignisse)
  expect(a.hinweise).toEqual(['Nochmal Strg+C zum Abbrechen'])
  // Ticket 3 wird nicht mehr genommen.
  expect(a.tracker.ticket(3).assignees).toEqual([])
  expect(a.hartesEnde()).toBe(0)
})

test('ein einzelnes Strg+C bricht nichts ab', async () => {
  const { klon } = wegwerfRepo()
  const a = aufbau()

  const ergebnis = await a.lauf(klon, [
    (auftrag) => {
      a.waechter.empfange('SIGINT')
      expect(auftrag.signal.aborted).toBe(false)
      return commitet(2)(auftrag)
    },
    commitet(3),
  ])

  expect(ergebnis.angehalten).toBeUndefined()
  expect(ergebnis.tickets.map((t) => t.ergebnis)).toEqual(['erledigt', 'erledigt'])
  expect(a.hinweise).toEqual(['Nochmal Strg+C zum Abbrechen'])
})

test('nach 5 Sekunden verfällt die Rückfrage; erst ein zweites Strg+C innerhalb der Frist bricht ab', async () => {
  const { remote, klon } = wegwerfRepo()
  const a = aufbau()

  const ergebnis = await a.lauf(klon, [
    unterbrochen(() => {
      a.waechter.empfange('SIGINT')
      a.uhr.vorstellen(5_001)
      a.waechter.empfange('SIGINT')
      expect(a.waechter.signal.aborted).toBe(false)
      a.uhr.vorstellen(5_000)
      a.waechter.empfange('SIGINT')
    }),
  ])

  erwarteAufgeraeumt(klon, remote, a.tracker, ergebnis, a.ereignisse)
  expect(a.hinweise).toEqual(['Nochmal Strg+C zum Abbrechen', 'Nochmal Strg+C zum Abbrechen'])
})

test.each(['SIGTERM', 'SIGHUP'] as const)('%s räumt sofort auf, ohne Rückfrage', async (signal) => {
  const { remote, klon } = wegwerfRepo()
  const a = aufbau()

  const ergebnis = await a.lauf(klon, [unterbrochen(() => a.waechter.empfange(signal))])

  erwarteAufgeraeumt(klon, remote, a.tracker, ergebnis, a.ereignisse)
  expect(a.hinweise).toEqual([])
})

test('Strg+C während des Aufräumens bricht sofort ab', async () => {
  const { klon } = wegwerfRepo()
  const tracker = zweiTickets()
  const a = aufbau(tracker)
  const gibFrei = tracker.gibFrei.bind(tracker)
  tracker.gibFrei = async (nr) => {
    a.waechter.empfange('SIGINT')
    return gibFrei(nr)
  }

  await a.lauf(klon, [unterbrochen(() => a.waechter.empfange('SIGTERM'))])

  expect(a.hartesEnde()).toBe(1)
})

test('der Abbruch checkt den Branch aus, der beim Start ausgecheckt war', async () => {
  const { klon } = wegwerfRepo()
  git(klon, 'checkout', '-q', '-b', 'eigener')
  const a = aufbau()

  await a.lauf(klon, [unterbrochen(() => a.waechter.empfange('SIGTERM'))])

  expect(git(klon, 'branch', '--show-current')).toBe('eigener')
})

test('ein neuer Lauf nach einem Abbruch beginnt bei jedem Ticket mit Versuch 1', async () => {
  const { klon } = wegwerfRepo()
  const tracker = zweiTickets()
  const erster = aufbau(tracker)
  await erster.lauf(klon, [
    () => ({ erfolg: false }),
    unterbrochen(() => erster.waechter.empfange('SIGTERM')),
  ])

  const zweiter = aufbau(tracker)
  const ergebnis = await zweiter.lauf(klon, [commitet(2), commitet(3)])

  const versuche = zweiter.ereignisse.filter((e) => e.art === 'versuch-begonnen')
  expect(versuche.map((e) => [e.ticket, e.versuch])).toEqual([
    [2, 1],
    [3, 1],
  ])
  expect(ergebnis.tickets.map((t) => t.ergebnis)).toEqual(['erledigt', 'erledigt'])
})

test('weicht der lokale Integration-Branch vom Remote ab, setzt die Engine ihn auf den Remote-Stand zurück', async () => {
  const { remote, klon, neuerKlon } = wegwerfRepo()
  const andere = neuerKlon()
  git(andere, 'checkout', '-q', '-b', 'spec/1')
  commitDatei(andere, 'remote.txt', 'x', 'auf dem Remote')
  git(andere, 'push', '-q', 'origin', 'spec/1')
  git(klon, 'checkout', '-q', '-b', 'spec/1')
  commitDatei(klon, 'lokal.txt', 'x', 'nur lokal')
  git(klon, 'checkout', '-q', 'main')
  const a = aufbau()

  await a.lauf(klon, [commitet(2), commitet(3)])

  expect(git(remote, 'log', '--format=%s', 'spec/1')).toBe(
    'Ticket 3\nTicket 2\nauf dem Remote\ninit',
  )
})

test('scheitert der Push des Integration-Branch als Nicht-Fast-Forward, bricht der Lauf ab', async () => {
  const { klon, neuerKlon } = wegwerfRepo()
  const andere = neuerKlon()
  const a = aufbau()

  const lauf = a.lauf(klon, [
    (auftrag) => {
      // Ein zweiter Klon an derselben Spec pusht zuerst.
      git(andere, 'checkout', '-q', '-b', 'spec/1')
      commitDatei(andere, 'andere.txt', 'x', 'anderer Klon')
      git(andere, 'push', '-q', 'origin', 'spec/1')
      return commitet(2)(auftrag)
    },
    commitet(3),
  ])

  await expect(lauf).rejects.toThrow(/push/)
  expect(a.tracker.ticket(2).offen).toBe(true)
  expect(a.tracker.ticket(3).assignees).toEqual([])
})

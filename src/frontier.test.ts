import { expect, test } from 'vitest'
import { type AgentSkript, fakeAgent } from './agent.ts'
import { steuerbareUhr } from './clock.ts'
import { fahreLauf } from './engine.ts'
import { durchreiche } from './sandbox.ts'
import { commitDatei, wegwerfRepo } from './testing/throwaway-repo.ts'
import { InMemoryTracker, type Ticket } from './tracker.ts'

/** Ein bearbeitbares Ticket, wenn `teil` nichts anderes sagt. */
const ticket = (nummer: number, teil: Partial<Ticket> = {}): Ticket => ({
  nummer,
  offen: true,
  labels: ['ready-for-agent'],
  assignees: [],
  blocker: [],
  ...teil,
})

/** Ein Run, der das Ticket grün umsetzt. */
const setztUm: AgentSkript = ({ verzeichnis, ticket }) => {
  commitDatei(verzeichnis, `${ticket.nummer}.txt`, 'x', `Ticket ${ticket.nummer} umsetzen`)
  return { erfolg: true }
}

/** Fährt einen ganzen Lauf über Spec 1; liefert die Nummern der genommenen Tickets in Reihenfolge. */
async function genommen(
  tracker: InMemoryTracker,
  skript: AgentSkript[] = Array(10).fill(setztUm),
): Promise<number[]> {
  const nummern: number[] = []
  await fahreLauf({
    spec: 1,
    auswahl: { zielBranch: 'main', abschluss: 'nichts' },
    verzeichnis: wegwerfRepo().klon,
    checks: [],
    tracker,
    agent: fakeAgent(skript),
    sandbox: durchreiche,
    uhr: steuerbareUhr(),
    melde: (e) => {
      if (e.art === 'ticket-genommen') nummern.push(e.ticket)
    },
  })
  return nummern
}

test('ohne ready-for-agent oder mit ready-for-human wird ein Ticket übersprungen', async () => {
  const tracker = new InMemoryTracker('ich', [
    ticket(2, { labels: [] }),
    ticket(3, { labels: ['ready-for-human'] }),
    ticket(4, { labels: ['ready-for-agent', 'ready-for-human'] }),
    ticket(5, { labels: ['needs-triage'] }),
    ticket(6),
  ])

  expect(await genommen(tracker)).toEqual([6])
})

test('ein offener Blocker sperrt, auch außerhalb der Spec; ein geschlossener gibt frei', async () => {
  const tracker = new InMemoryTracker('ich', [
    ticket(2, { blocker: [{ nummer: 99, offen: true }] }),
    ticket(3, { blocker: [{ nummer: 98, offen: false }] }),
  ])

  expect(await genommen(tracker)).toEqual([3])
})

test('ein Ticket wird frei, sobald die Engine seinen Blocker geschlossen hat', async () => {
  const tracker = new InMemoryTracker('ich', [
    ticket(2, { blocker: [{ nummer: 4, offen: true }] }),
    ticket(3, { blocker: [{ nummer: 2, offen: true }] }),
    ticket(4),
  ])

  expect(await genommen(tracker)).toEqual([4, 2, 3])
})

test('ein anderem zugewiesenes Ticket wird übersprungen, ein mir zugewiesenes genommen', async () => {
  const tracker = new InMemoryTracker('ich', [
    ticket(2, { assignees: ['du'] }),
    ticket(3, { assignees: ['ich', 'du'] }),
    ticket(4, { assignees: ['ich'] }),
  ])

  expect(await genommen(tracker)).toEqual([4])
})

test('die Engine nimmt die niedrigste Nummer aus der Frontier', async () => {
  const tracker = new InMemoryTracker('ich', [ticket(5), ticket(3), ticket(4)])

  expect(await genommen(tracker)).toEqual([3, 4, 5])
})

test('eine Änderung im Tracker während des Laufs gilt ab dem nächsten Ticket', async () => {
  const tracker = new InMemoryTracker('ich', [
    ticket(2),
    ticket(3, { labels: [] }),
    ticket(4),
    ticket(5, { blocker: [{ nummer: 99, offen: true }] }),
  ])

  const reihenfolge = await genommen(tracker, [
    (auftrag) => {
      tracker.aendere(3, (t) => t.labels.push('ready-for-agent'))
      tracker.aendere(4, (t) => t.assignees.push('du'))
      tracker.aendere(5, (t) => {
        t.blocker = [{ nummer: 99, offen: false }]
      })
      return setztUm(auftrag)
    },
    setztUm,
    setztUm,
  ])

  expect(reihenfolge).toEqual([2, 3, 5])
})

test('ein Tracker-Fehler bricht den Lauf ab, ohne ein Ticket rot zu machen', async () => {
  const tracker = new InMemoryTracker('ich', [ticket(2), ticket(3)])
  const taskGraph = tracker.taskGraph.bind(tracker)
  let abfragen = 0
  tracker.taskGraph = async () => {
    if (++abfragen > 1) throw new Error('gh: nicht erreichbar')
    return taskGraph()
  }
  const arten: string[] = []

  const lauf = fahreLauf({
    spec: 1,
    auswahl: { zielBranch: 'main', abschluss: 'nichts' },
    verzeichnis: wegwerfRepo().klon,
    checks: [],
    tracker,
    agent: fakeAgent([setztUm, setztUm]),
    sandbox: durchreiche,
    uhr: steuerbareUhr(),
    melde: (e) => arten.push(`${e.art} ${'ticket' in e ? e.ticket : ''}`),
  })

  await expect(lauf).rejects.toThrow('gh: nicht erreichbar')
  expect(arten.filter((a) => a.startsWith('ticket'))).toEqual([
    'ticket-genommen 2',
    'ticket-erledigt 2',
  ])
  expect(tracker.ticket(3)).toMatchObject({ offen: true, assignees: [] })
})

test('die Abhängigen eines übersprungenen Tickets bleiben blockiert', async () => {
  const tracker = new InMemoryTracker('ich', [
    ticket(2, { labels: ['ready-for-human'] }),
    ticket(3, { blocker: [{ nummer: 2, offen: true }] }),
    ticket(4, { blocker: [{ nummer: 3, offen: true }] }),
  ])

  expect(await genommen(tracker)).toEqual([])
})

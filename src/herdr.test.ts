import { expect, test } from 'vitest'
import type { Ereignis } from './engine.ts'
import { herdr } from './herdr.ts'
import { frontierZustand, type Ticket } from './tracker.ts'

const ticket = (nummer: number, offen = true): Ticket => ({
  nummer,
  offen,
  labels: [],
  assignees: [],
  blocker: [],
})
const graph = (...tickets: Ticket[]): Ereignis => ({
  art: 'task-graph',
  tickets: tickets.map((t) => ({ ...t, zustand: frontierZustand(t, 'ich') })),
  zeit: 0,
})
const genommen = (nr: number): Ereignis => ({ art: 'ticket-genommen', ticket: nr, zeit: 0 })
const begonnen: Ereignis = {
  art: 'lauf-begonnen',
  spec: 25,
  auswahl: { zielBranch: 'main', abschluss: 'mergen' },
  versionen: {},
  zeit: 0,
}

/** Die Sequenzen, die groundhog in einem Herdr-Terminal zu den Ereignissen schreibt. */
function sequenzen(ereignisse: Ereignis[]): string[] {
  const melde = herdr({ HC_TERMINAL_ID: 't1' }, true)
  return ereignisse.flatMap((e) => melde(e) ?? [])
}

test('ab dem ersten Ticket meldet groundhog working mit dem laufenden Ticket und dem Anteil geschlossener Tickets', () => {
  expect(sequenzen([begonnen, graph(ticket(2, false), ticket(3), ticket(4)), genommen(3)])).toEqual(
    [`\x1b]7501;state=working:app=groundhog:msg=${btoa('Ticket #3')}:progress=33\x07`],
  )
})

const beendet: Ereignis = {
  art: 'lauf-beendet',
  abschluss: { art: 'nichts' },
  uebersicht: '',
  zeit: 0,
}
const erledigt = (nr: number): Ereignis => ({
  art: 'ticket-erledigt',
  ticket: nr,
  commit: 'abc',
  versuche: 1,
  zeit: 0,
})
const gescheitert = (nr: number): Ereignis => ({
  art: 'ticket-gescheitert',
  ticket: nr,
  versuche: 3,
  pruefung: 'Check: npm test',
  zeit: 0,
})

test('am Ende meldet groundhog done, wenn kein Ticket gescheitert ist', () => {
  expect(
    sequenzen([
      begonnen,
      graph(ticket(2), ticket(3)),
      genommen(2),
      erledigt(2),
      graph(ticket(2, false), ticket(3)),
      genommen(3),
      erledigt(3),
      graph(ticket(2, false), ticket(3, false)),
      beendet,
    ]),
  ).toEqual([
    `\x1b]7501;state=working:app=groundhog:msg=${btoa('Ticket #2')}:progress=0\x07`,
    `\x1b]7501;state=working:app=groundhog:msg=${btoa('Ticket #3')}:progress=50\x07`,
    `\x1b]7501;state=done:app=groundhog:msg=${btoa('Spec #25')}:progress=100\x07`,
  ])
})

test('am Ende meldet groundhog error, wenn mindestens ein Ticket endgültig gescheitert ist', () => {
  expect(
    sequenzen([
      begonnen,
      graph(ticket(2), ticket(3)),
      genommen(2),
      gescheitert(2),
      graph(ticket(2), ticket(3)),
      genommen(3),
      erledigt(3),
      graph(ticket(2), ticket(3, false)),
      beendet,
    ]).at(-1),
  ).toBe(`\x1b]7501;state=error:app=groundhog:msg=${btoa('Spec #25')}:progress=50\x07`)
})

test('ohne HC_TERMINAL_ID oder ohne Terminal auf stdout meldet groundhog nichts', () => {
  const lauf = [begonnen, graph(ticket(2)), genommen(2), gescheitert(2), graph(ticket(2)), beendet]
  for (const melde of [herdr({}, true), herdr({ HC_TERMINAL_ID: 't1' }, false)]) {
    expect(lauf.map(melde).filter(Boolean)).toEqual([])
  }
})

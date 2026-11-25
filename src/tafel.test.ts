import { EventEmitter } from 'node:events'
import { expect, test } from 'vitest'
import type { Ereignis } from './engine.ts'
import { tafel, zeigeTafel } from './tafel.ts'
import type { Ticket } from './tracker.ts'

/** Der Bildschirm der Tafel nach einer Folge von Ereignissen, ohne Farben. */
function bildschirm(ereignisse: Ereignis[], breite = 60, hoehe = 14): string[] {
  const t = tafel()
  for (const e of ereignisse) t.melde(e)
  return t.bildschirm(breite, hoehe)
}

const ticket = (nummer: number, teil: Partial<Ticket> = {}): Ticket => ({
  nummer,
  offen: true,
  labels: ['ready-for-agent'],
  assignees: [],
  blocker: [],
  ...teil,
})
const begonnen: Ereignis = {
  art: 'lauf-begonnen',
  spec: 25,
  auswahl: { zielBranch: 'main', abschluss: 'pr' },
  versionen: { groundhog: '1.2.3' },
  zeit: 0,
}
const graph = (...tickets: Ticket[]): Ereignis => ({ art: 'task-graph', tickets, zeit: 0 })
const assistant = (ticket: number, text: string, run = 1): Ereignis => ({
  art: 'run-ausgabe',
  ticket,
  run,
  zeile: JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text }] } }),
  zeit: 0,
})
const strich = '─'.repeat(60)

test('vor dem ersten Ticket: Kopfzeile und der Task-Graph mit dem Zustand aus dem Tracker', () => {
  expect(
    bildschirm([
      begonnen,
      graph(
        ticket(26, { offen: false }),
        ticket(27),
        ticket(28, {
          blocker: [
            { nummer: 27, offen: true },
            { nummer: 9, offen: false },
          ],
        }),
        ticket(29, { labels: ['ready-for-human'] }),
        ticket(30, { labels: [] }),
      ),
    ]),
  ).toEqual([
    'groundhog 1.2.3 · Spec #25 · Ziel-Branch main · Abschluss PR',
    '',
    '  #26 ✔ erledigt',
    '  #27 · wartet',
    '  #28 ○ blockiert von #27',
    '  #29 – ready-for-human, nicht angefasst',
    '  #30 – nicht freigegeben',
    strich,
    '',
    '',
    '',
    '',
    strich,
    '',
  ])
})

test('ein Ticket durchläuft seine Zustände; die Mitschrift zeigt nur den laufenden Run, danach die Prüfungen', () => {
  const lauf: Ereignis[] = [begonnen, graph(ticket(27), ticket(28))]
  const zustand = (...weiter: Ereignis[]) => {
    lauf.push(...weiter)
    return bildschirm(lauf)
  }
  const versuch = (n: number): Ereignis => ({
    art: 'versuch-begonnen',
    ticket: 27,
    versuch: n,
    von: 3,
    zeit: 0,
  })
  const pruefung = (name: string, ok: boolean): Ereignis => ({
    art: 'pruefung',
    ticket: 27,
    name,
    ok,
    zeit: 0,
  })

  let s = zustand(
    { art: 'ticket-genommen', ticket: 27, zeit: 0 },
    versuch(1),
    assistant(27, 'eins'),
  )
  expect(s[2]).toBe('  #27 ▶ läuft · Versuch 1 von 3')
  expect(s[3]).toBe('  #28 · wartet')
  expect(s.slice(5, 7)).toEqual(['  │ eins', ''])
  expect(s.at(-1)).toBe('#27 · Versuch 1 von 3')

  s = zustand(pruefung('Run erfolgreich', true), pruefung('neuer Commit seit Fixpunkt', false))
  expect(s[2]).toBe('  #27 ↻ Versuch 1 von 3 gescheitert')
  expect(s.slice(5, 9)).toEqual([
    '  │ eins',
    '  ✔ Run erfolgreich',
    '  ✘ neuer Commit seit Fixpunkt',
    '',
  ])

  // Der nächste Versuch beginnt mit leerer Mitschrift.
  s = zustand(versuch(2), assistant(27, 'zwei', 2))
  expect(s[2]).toBe('  #27 ▶ läuft · Versuch 2 von 3')
  expect(s.slice(5, 7)).toEqual(['  │ zwei', ''])
  expect(s.at(-1)).toBe('#27 · Versuch 2 von 3')

  // Pause am Usage-Limit; der Neustart desselben Versuchs ist ein neuer Run.
  const reset = new Date(2026, 10, 25, 3, 10).getTime()
  s = zustand({ art: 'pause', ticket: 27, reset, zeit: reset - 60_000 })
  expect(s[2]).toBe('  #27 ⏸ Pause am Usage-Limit bis 03:10')
  s = zustand(assistant(27, 'drei', 3))
  expect(s[2]).toBe('  #27 ▶ läuft · Versuch 2 von 3')
  expect(s.slice(5, 7)).toEqual(['  │ drei', ''])

  s = zustand(
    { art: 'ticket-erledigt', ticket: 27, commit: 'abc1234def', versuche: 2, zeit: 0 },
    graph(ticket(27, { offen: false }), ticket(28)),
  )
  expect(s[2]).toBe('  #27 ✔ erledigt in Versuch 2')
})

test('ein endgültig gescheitertes Ticket steht mit Grund da und blockiert seine Abhängigen', () => {
  const s = bildschirm([
    begonnen,
    graph(ticket(27), ticket(28, { blocker: [{ nummer: 27, offen: true }] })),
    { art: 'ticket-genommen', ticket: 27, zeit: 0 },
    { art: 'ticket-gescheitert', ticket: 27, versuche: 3, pruefung: 'Check: npm test', zeit: 0 },
    graph(
      ticket(27, { labels: ['ready-for-human'] }),
      ticket(28, { blocker: [{ nummer: 27, offen: true }] }),
    ),
  ])
  expect(s.slice(2, 4)).toEqual([
    '  #27 ✘ ready-for-human · Check: npm test',
    '  #28 ○ blockiert von #27',
  ])
})

test('Warnungen der Engine stehen über der Mitschrift', () => {
  const s = bildschirm([
    begonnen,
    graph(ticket(27)),
    { art: 'warnung', text: 'Kommentar an #27 gescheitert: offline', zeit: 0 },
  ])
  expect(s.slice(3, 5)).toEqual(['⚠ Kommentar an #27 gescheitert: offline', strich])
})

test('überlange Zeilen werden gekürzt, die Mitschrift zeigt ihr Ende, der Bildschirm hat immer genau die Höhe', () => {
  const lang = 'x'.repeat(100)
  const zeilen = Array.from({ length: 20 }, (_, i) => assistant(27, `zeile ${i + 1}`))
  const lauf: Ereignis[] = [
    begonnen,
    graph(ticket(27)),
    { art: 'versuch-begonnen', ticket: 27, versuch: 1, von: 3, zeit: 0 },
    ...zeilen,
    assistant(27, lang),
  ]
  const t = tafel()
  for (const e of lauf) t.melde(e)

  const s = t.bildschirm(40, 10)
  expect(s).toHaveLength(10)
  expect(s.every((z) => z.length <= 40)).toBe(true)
  expect(s.slice(4, 9)).toEqual([
    '  │ zeile 18',
    '  │ zeile 19',
    '  │ zeile 20',
    `  │ ${'x'.repeat(35)}…`,
    '─'.repeat(40),
  ])

  // Ein kleineres Fenster: nichts läuft über, auch nicht der Task-Graph.
  expect(t.bildschirm(20, 3)).toEqual([
    'groundhog 1.2.3 · S…',
    '─'.repeat(20),
    '#27 · Versuch 1 von…',
  ])
})

test('mit Farben wird ANSI-sicher gekürzt', () => {
  const t = tafel({ farbe: true })
  t.melde(begonnen)
  const [kopf] = t.bildschirm(12, 3)
  expect(kopf).toBe('\x1b[2mgroundhog 1…\x1b[0m')
})

test('im Terminal: alternativer Bildschirm, neu gezeichnet bei Ereignis und Größenänderung, Schluss im normalen Bildschirm', () => {
  const geschrieben: string[] = []
  const out = Object.assign(new EventEmitter(), {
    columns: 30,
    rows: 6,
    write: (t: string) => geschrieben.push(t),
  }) as unknown as NodeJS.WriteStream
  const { melde } = zeigeTafel(out, '/repo/.git/groundhog/laeufe/x')
  expect(geschrieben.shift()).toBe('\x1b[?1049h\x1b[?25l\x1b[?7l')

  melde(begonnen)
  melde(graph(ticket(27)))
  expect(geschrieben).toHaveLength(2)
  out.rows = 4
  out.emit('resize')
  expect(geschrieben.pop()?.split('\x1b[K\n')).toHaveLength(4)

  geschrieben.length = 0
  melde({ art: 'lauf-beendet', abschluss: { art: 'nichts' }, uebersicht: '# Übersicht', zeit: 0 })
  expect(geschrieben[0]).toBe('\x1b[?7h\x1b[?25h\x1b[?1049l')
  expect(geschrieben).toContain('# Übersicht\n')
  expect(geschrieben.at(-1)).toBe('Übersicht: /repo/.git/groundhog/laeufe/x/uebersicht.md\n')

  // Danach zeichnet nichts mehr über den Schluss.
  out.emit('resize')
  expect(geschrieben.at(-1)).toBe('Übersicht: /repo/.git/groundhog/laeufe/x/uebersicht.md\n')
})

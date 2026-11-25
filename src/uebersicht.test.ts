import { hostname } from 'node:os'
import { expect, test } from 'vitest'
import { type AgentSkript, fakeAgent } from './agent.ts'
import { type Ereignis, fahreLauf, type LaufEingabe } from './engine.ts'
import { git } from './git.ts'
import { durchreiche } from './sandbox.ts'
import { commitDatei, wegwerfRepo } from './testing/wegwerf-repo.ts'
import { InMemoryTracker, type Ticket } from './tracker.ts'
import { steuerbareUhr } from './uhr.ts'

const START = new Date(2026, 10, 25, 22, 0, 0).getTime()
const MINUTE = 60_000

const ticket = (nummer: number, teil: Partial<Ticket> = {}): Ticket => ({
  nummer,
  offen: true,
  labels: ['ready-for-agent'],
  assignees: [],
  blocker: [],
  ...teil,
})

/** Fährt einen ganzen Lauf über Spec 1 mit Ziel-Branch main; jeder Run dauert 10 Minuten. */
async function lauf(
  klon: string,
  tracker: InMemoryTracker,
  skript: AgentSkript[],
  eingabe: Partial<LaufEingabe> = {},
) {
  const uhr = steuerbareUhr(START)
  const ereignisse: Ereignis[] = []
  const ergebnis = await fahreLauf({
    spec: 1,
    auswahl: { zielBranch: 'main', abschluss: 'nichts' },
    verzeichnis: klon,
    checks: ['grep -sqx gruen gruen || { echo "nicht gruen"; false; }'],
    protokoll: '/tmp/laeufe/20261125-220000-spec-1',
    tracker,
    agent: fakeAgent(
      skript.map((schritt) => (auftrag) => {
        uhr.vorstellen(10 * MINUTE)
        return schritt(auftrag)
      }),
    ),
    sandbox: durchreiche,
    uhr,
    melde: (e) => ereignisse.push(e),
    ...eingabe,
  })
  return { ergebnis, ereignisse }
}

/** Ein Run, der das Ticket grün umsetzt. */
const gruen: AgentSkript = ({ verzeichnis, ticket }) => {
  commitDatei(verzeichnis, 'gruen', 'gruen', `Ticket ${ticket.nummer} umsetzen`)
  return { erfolg: true, sessionId: `sitzung-${ticket.nummer}` }
}

/** Ein Run, der committet, aber die Checks rot lässt. */
const rot: AgentSkript = ({ verzeichnis, ticket }) => {
  commitDatei(verzeichnis, 'gruen', `rot ${Math.random()}`, `Ticket ${ticket.nummer} versuchen`)
  return { erfolg: true, sessionId: `sitzung-${ticket.nummer}-rot` }
}

test('ein grünes Ticket bekommt beim Schließen eine Zeile mit Commit, Versuch und Blocks', async () => {
  const { remote, klon } = wegwerfRepo()
  const tracker = new InMemoryTracker('ich', [ticket(2)])

  await lauf(klon, tracker, [
    rot,
    (auftrag) => ({
      ...gruen(auftrag),
      blocks: [{ tool: 'Bash', befehl: 'curl https://example.com' }],
    }),
  ])

  expect(tracker.kommentare(2)).toEqual([
    `Erledigt: ${git(remote, 'rev-parse', 'spec/1')} in spec/1, Versuch 2 von 3, Blocks: 1`,
  ])
})

test('ein endgültig gescheitertes Ticket bekommt genau einen Kommentar mit allen Versuchen', async () => {
  const { klon } = wegwerfRepo()
  const tracker = new InMemoryTracker('ich', [ticket(2)])
  const check = 'grep -sqx gruen gruen || { seq 1 150; false; }'

  await lauf(
    klon,
    tracker,
    [
      rot,
      () => ({ erfolg: false, blocks: [{ tool: 'Bash', befehl: 'rm -rf /' }] }),
      (auftrag) => ({ ...rot(auftrag), blocks: [{ tool: 'WebFetch', befehl: 'https://x.org' }] }),
    ],
    { checks: [check] },
  )

  const ausgabe = Array.from({ length: 100 }, (_, i) => i + 51).join('\n')
  expect(tracker.kommentare(2)).toEqual([
    `Endgültig gescheitert, jetzt \`ready-for-human\`.

- Versuch 1 von 3 rot: Check: ${check}
- Versuch 2 von 3 rot: Run erfolgreich
- Versuch 3 von 3 rot: Check: ${check}

Check-Ausgabe des letzten Versuchs:

\`\`\`
[gekürzt, vollständig im Protokoll]
${ausgabe}
\`\`\`

Blocks: 2

- Session: \`claude --resume sitzung-2-rot\`
- Rechner: ${hostname()}
- Protokoll: \`/tmp/laeufe/20261125-220000-spec-1\``,
  ])
  expect(tracker.ticket(2)).toMatchObject({ labels: ['ready-for-human'], assignees: [] })
})

test('scheitert ein Kommentar, warnt die Engine; Schließen und ready-for-human hängen nicht daran', async () => {
  const { klon } = wegwerfRepo()
  const tracker = new (class extends InMemoryTracker {
    override async kommentiere(): Promise<void> {
      throw new Error('gh: nicht erreichbar')
    }
  })('ich', [ticket(2), ticket(3)])

  const { ergebnis, ereignisse } = await lauf(klon, tracker, [gruen, rot, rot, rot])

  expect(ergebnis.tickets.map((t) => t.ergebnis)).toEqual(['erledigt', 'gescheitert'])
  expect(tracker.ticket(2).offen).toBe(false)
  expect(tracker.ticket(3).labels).toEqual(['ready-for-human'])
  expect(ereignisse.filter((e) => e.art === 'warnung').map((e) => e.text)).toEqual([
    'Kommentar an #2 gescheitert: gh: nicht erreichbar',
    'Kommentar an #3 gescheitert: gh: nicht erreichbar',
    'Kommentar an #1 gescheitert: gh: nicht erreichbar',
  ])
})

test('die Übersicht nennt den Lauf und je Ticket eine Zeile; die Spec bekommt sie als Kommentar', async () => {
  const { remote, klon } = wegwerfRepo()
  const tracker = new InMemoryTracker('ich', [
    ticket(2),
    ticket(3),
    ticket(4, { blocker: [{ nummer: 3, offen: true }] }),
    ticket(5, { labels: ['ready-for-human'] }),
    ticket(6, { offen: false }),
  ])
  const block = (tool: string, befehl: string) => ({ blocks: [{ tool, befehl }] })

  const { ereignisse } = await lauf(
    klon,
    tracker,
    [
      rot,
      (a) => ({ ...gruen(a), ...block('Bash', 'curl https://example.com') }),
      rot,
      (a) => ({ ...rot(a), ...block('WebFetch', 'https://x.org') }),
      (a) => ({ ...rot(a), tokens: { input_tokens: 4711 }, kostenUsd: 1.5 }),
    ],
    {
      auswahl: { zielBranch: 'main', abschluss: 'pr' },
      versionen: { groundhog: '1.0.0', claude: '2.1.0', skills: '1.3.2' },
    },
  )

  const uebersicht = `# Übersicht Spec #1

- Beginn: 2026-11-25 22:00:00
- Ende: 2026-11-25 22:50:00
- Dauer: 50 min
- Ziel-Branch: main
- Abschluss: PR → nichts, weil Tickets offen
- Versionen: groundhog 1.0.0, claude 2.1.0, skills 1.3.2

## Tickets

- #2 erledigt · Versuche 2 von 3 · Pausen 0 · Dauer 20 min · Blocks 1 · Commit ${git(remote, 'rev-parse', 'spec/1')}
  - Bash: \`curl https://example.com\`
- #3 gescheitert · Versuche 3 von 3 · Pausen 0 · Dauer 30 min · Blocks 1 · rot: Check: grep -sqx gruen gruen || { echo "nicht gruen"; false; } · \`claude --resume sitzung-3-rot\`
  - WebFetch: \`https://x.org\`
- #4 blockiert von #3
- #5 nicht angefasst
- #6 nicht angefasst, schon geschlossen`
  expect(ereignisse.at(-1)).toMatchObject({ art: 'lauf-beendet', uebersicht })
  expect(tracker.kommentare(1)).toEqual([
    `${uebersicht}

- Rechner: ${hostname()}
- Protokoll: \`/tmp/laeufe/20261125-220000-spec-1\``,
  ])
})

test('die Übersicht zählt Pausen am Usage-Limit und zeigt ein angehaltenes Ticket als unterbrochen', async () => {
  const { remote, klon } = wegwerfRepo()
  const tracker = new InMemoryTracker('ich', [ticket(2), ticket(3)])

  const { ereignisse } = await lauf(klon, tracker, [
    () => ({ erfolg: false, usageLimit: START + 30 * MINUTE }),
    gruen,
    () => ({ erfolg: false, usageLimit: 'guthaben' }),
  ])

  const ende = ereignisse.at(-1)
  expect(ende?.art === 'lauf-beendet' && ende.uebersicht.split('\n## Tickets\n\n')[1]).toBe(
    `- #2 erledigt · Versuche 1 von 3 · Pausen 1 · Dauer 41 min · Blocks 0 · Commit ${git(remote, 'rev-parse', 'spec/1')}
- #3 unterbrochen · Versuche 1 von 3 · Pausen 0 · Dauer 10 min · Blocks 0`,
  )
})

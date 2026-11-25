import { expect, test } from 'vitest'
import { type AgentSkript, fakeAgent } from './agent.ts'
import { type Auswahl, type Ereignis, fahreLauf, type LaufErgebnis } from './engine.ts'
import { git } from './git.ts'
import { durchreiche } from './sandbox.ts'
import { commitDatei, wegwerfRepo } from './testing/wegwerf-repo.ts'
import { InMemoryTracker, type Ticket } from './tracker.ts'
import { steuerbareUhr } from './uhr.ts'

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

/** Fährt einen ganzen Lauf über Spec 1. */
function lauf(
  klon: string,
  tracker: InMemoryTracker,
  auswahl: Auswahl,
  skript: AgentSkript[] = [setztUm, setztUm],
  melde?: (e: Ereignis) => void,
): Promise<LaufErgebnis> {
  return fahreLauf({
    spec: 1,
    auswahl,
    verzeichnis: klon,
    checks: [],
    tracker,
    agent: fakeAgent(skript),
    sandbox: durchreiche,
    uhr: steuerbareUhr(),
    melde,
  })
}

test('Mergen meldet den Push in den Ziel-Branch', async () => {
  const { remote, klon } = wegwerfRepo()
  const ereignisse: Ereignis[] = []

  await lauf(
    klon,
    new InMemoryTracker('ich', [ticket(2)]),
    { zielBranch: 'main', abschluss: 'mergen' },
    [setztUm],
    (e) => ereignisse.push(e),
  )

  expect(ereignisse.filter((e) => e.art === 'push').at(-1)).toMatchObject({
    branch: 'main',
    commit: git(remote, 'rev-parse', 'main'),
  })
})

test('Mergen: Merge-Commit des Integration-Branch in den Ziel-Branch, Push, Spec geschlossen', async () => {
  const { remote, klon } = wegwerfRepo()
  const tracker = new InMemoryTracker('ich', [ticket(2), ticket(3)])

  const ergebnis = await lauf(klon, tracker, { zielBranch: 'main', abschluss: 'mergen' })

  const merge = git(remote, 'rev-parse', 'main')
  expect(ergebnis.abschluss).toEqual({ art: 'gemergt', commit: merge })
  expect(git(remote, 'rev-parse', 'main^1')).toBe(git(remote, 'rev-parse', 'spec/1~2'))
  expect(git(remote, 'rev-parse', 'main^2')).toBe(git(remote, 'rev-parse', 'spec/1'))
  expect(tracker.offen(1)).toBe(false)
})

test('Mergen mit Konflikt: Merge abgebrochen, Integration- und Ziel-Branch unverändert, Spec offen', async () => {
  const { remote, klon, neuerKlon } = wegwerfRepo()
  const tracker = new InMemoryTracker('ich', [ticket(2)])
  let main = ''

  const ergebnis = await lauf(klon, tracker, { zielBranch: 'main', abschluss: 'mergen' }, [
    (auftrag) => {
      const anderer = neuerKlon()
      commitDatei(anderer, '2.txt', 'anders', 'derweil auf main')
      git(anderer, 'push', '-q', 'origin', 'main')
      main = git(anderer, 'rev-parse', 'HEAD')
      return setztUm(auftrag)
    },
  ])

  expect(ergebnis.abschluss).toEqual({ art: 'konflikt' })
  expect(git(remote, 'rev-parse', 'main')).toBe(main)
  expect(git(remote, 'log', '--format=%s', 'spec/1')).toBe('Ticket 2 umsetzen\ninit')
  expect(git(klon, 'status', '--porcelain')).toBe('')
  expect(git(klon, 'branch', '--show-current')).toBe('spec/1')
  expect(tracker.offen(1)).toBe(true)
  expect(tracker.kommentare(1).slice(0, -1)).toEqual([])
})

test.each(['mergen', 'pr', 'nichts'] as const)(
  '%s: sind nicht alle Tickets geschlossen, entfällt der Abschluss',
  async (abschluss) => {
    const { remote, klon } = wegwerfRepo()
    const tracker = new InMemoryTracker('ich', [
      ticket(2),
      ticket(3, { labels: ['ready-for-human'] }),
    ])
    const main = git(remote, 'rev-parse', 'main')

    const ergebnis = await lauf(klon, tracker, { zielBranch: 'main', abschluss })

    expect(ergebnis.abschluss).toEqual({ art: 'entfaellt', grund: 'Tickets offen' })
    expect(git(remote, 'log', '--format=%s', 'spec/1')).toBe('Ticket 2 umsetzen\ninit')
    expect(git(remote, 'rev-parse', 'main')).toBe(main)
    expect(tracker.prs).toEqual([])
    expect(tracker.kommentare(1).slice(0, -1)).toEqual([])
    expect(tracker.offen(1)).toBe(true)
  },
)

test('PR: vom Integration-Branch auf den Ziel-Branch mit Closes, Link an der Spec, Spec bleibt offen', async () => {
  const { remote, klon } = wegwerfRepo()
  const tracker = new InMemoryTracker('ich', [ticket(2)])
  const main = git(remote, 'rev-parse', 'main')

  const ergebnis = await lauf(klon, tracker, { zielBranch: 'main', abschluss: 'pr' })

  expect(tracker.prs).toEqual([
    {
      integrationBranch: 'spec/1',
      zielBranch: 'main',
      titel: expect.any(String),
      body: 'Closes #1',
    },
  ])
  const url = 'https://github.example/pull/1'
  expect(ergebnis.abschluss).toEqual({ art: 'pr', url })
  expect(tracker.kommentare(1).slice(0, -1)).toEqual([`PR: ${url}`])
  expect(tracker.offen(1)).toBe(true)
  expect(git(remote, 'rev-parse', 'main')).toBe(main)
})

test('Nichts: der Name des Integration-Branch steht an der Spec, sonst geschieht nichts', async () => {
  const { remote, klon } = wegwerfRepo()
  const tracker = new InMemoryTracker('ich', [ticket(2)])
  const main = git(remote, 'rev-parse', 'main')

  const ergebnis = await lauf(klon, tracker, { zielBranch: 'main', abschluss: 'nichts' })

  expect(ergebnis.abschluss).toEqual({ art: 'nichts' })
  expect(tracker.kommentare(1).slice(0, -1)).toEqual(['Integration-Branch: spec/1'])
  expect(tracker.prs).toEqual([])
  expect(tracker.offen(1)).toBe(true)
  expect(git(remote, 'rev-parse', 'main')).toBe(main)
})

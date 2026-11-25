import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { type AgentSkript, fakeAgent, type RunAuftrag } from './agent.ts'
import { steuerbareUhr } from './clock.ts'
import { type Ereignis, fahreLauf } from './engine.ts'
import { git } from './git.ts'
import { durchreiche } from './sandbox.ts'
import { commitDatei, wegwerfRepo } from './testing/throwaway-repo.ts'
import { InMemoryTracker } from './tracker.ts'

/** Fährt einen Lauf über Spec 1 mit Ziel-Branch main; liefert die Ereignisse. */
async function lauf(
  verzeichnis: string,
  tracker: InMemoryTracker,
  skript: AgentSkript[],
  checks = ['true'],
  versuche?: number,
): Promise<Ereignis[]> {
  const ereignisse: Ereignis[] = []
  await fahreLauf({
    spec: 1,
    auswahl: { zielBranch: 'main', abschluss: 'nichts' },
    verzeichnis,
    checks,
    maxVersuche: versuche,
    tracker,
    agent: fakeAgent(skript),
    sandbox: durchreiche,
    uhr: steuerbareUhr(),
    melde: (e) => ereignisse.push(e),
  })
  return ereignisse
}

const einTicket = () =>
  new InMemoryTracker('ich', [
    { nummer: 2, offen: true, labels: ['ready-for-agent'], assignees: [], blocker: [] },
  ])

const commitet: AgentSkript = ({ verzeichnis }) => {
  commitDatei(verzeichnis, 'a.txt', 'a', 'Ticket 2 umsetzen')
  return { erfolg: true }
}

test('ein grünes Ticket landet im Integration-Branch, wird gepusht und geschlossen', async () => {
  const { remote, klon } = wegwerfRepo()
  const tracker = einTicket()

  await lauf(klon, tracker, [
    (auftrag) => {
      commitet(auftrag)
      git(auftrag.verzeichnis, 'push', '-q', 'origin', 'ticket/2')
      return { erfolg: true }
    },
  ])

  expect(tracker.ticket(2)).toMatchObject({ offen: false, assignees: ['ich'] })
  expect(git(remote, 'log', '--format=%s', 'spec/1')).toBe('Ticket 2 umsetzen\ninit')
  expect(git(klon, 'rev-parse', 'spec/1')).toBe(git(remote, 'rev-parse', 'spec/1'))
  expect(git(klon, 'branch', '--list', 'ticket/*')).toBe('')
  expect(git(remote, 'branch', '--list', 'ticket/*')).toBe('')
})

test('die Engine beansprucht das Ticket vor dem Run und gibt den Abzweig als Fixpunkt mit', async () => {
  const { remote, klon } = wegwerfRepo()
  const tracker = einTicket()
  let imRun: unknown

  await lauf(klon, tracker, [
    (auftrag) => {
      imRun = {
        assignees: tracker.ticket(2).assignees,
        fixpunkt: auftrag.fixpunkt,
        branch: git(auftrag.verzeichnis, 'branch', '--show-current'),
      }
      return commitet(auftrag)
    },
  ])

  expect(imRun).toEqual({
    assignees: ['ich'],
    fixpunkt: git(remote, 'rev-parse', 'main'),
    branch: 'ticket/2',
  })
})

test('der Integration-Branch zweigt vom frisch geholten origin/<Ziel-Branch> ab', async () => {
  const { remote, klon, neuerKlon } = wegwerfRepo()
  const anderer = neuerKlon()
  commitDatei(anderer, 'b.txt', 'b', 'anderswo gepusht')
  git(anderer, 'push', '-q', 'origin', 'main')
  commitDatei(klon, 'c.txt', 'c', 'nur lokal auf main')

  await lauf(klon, einTicket(), [commitet])

  expect(git(remote, 'log', '--format=%s', 'spec/1')).toBe(
    'Ticket 2 umsetzen\nanderswo gepusht\ninit',
  )
})

test('ein vorhandener Integration-Branch wird weiterverwendet', async () => {
  const { remote, klon } = wegwerfRepo()
  git(klon, 'checkout', '-q', '-b', 'spec/1')
  commitDatei(klon, 'v.txt', 'v', 'voriger Lauf')
  git(klon, 'checkout', '-q', 'main')

  await lauf(klon, einTicket(), [commitet])

  expect(git(remote, 'log', '--format=%s', 'spec/1')).toBe('Ticket 2 umsetzen\nvoriger Lauf\ninit')
})

test.each<[string, AgentSkript]>([
  [
    'Run erfolgreich',
    (auftrag) => {
      commitet(auftrag)
      return { erfolg: false }
    },
  ],
  [
    'HEAD auf ticket/2',
    (auftrag) => {
      commitet(auftrag)
      git(auftrag.verzeichnis, 'checkout', '-q', '-b', 'woanders')
      return { erfolg: true }
    },
  ],
  ['neuer Commit seit Fixpunkt', () => ({ erfolg: true })],
  [
    'Arbeitsverzeichnis sauber',
    (auftrag) => {
      commitet(auftrag)
      writeFileSync(join(auftrag.verzeichnis, 'offen.txt'), 'x')
      return { erfolg: true }
    },
  ],
])('Prüfung „%s“ rot im letzten Versuch: Ticket geht an einen Menschen', async (rot, schritt) => {
  const { remote, klon } = wegwerfRepo()
  const tracker = einTicket()

  const ereignisse = await lauf(
    klon,
    tracker,
    [
      (auftrag) => {
        git(auftrag.verzeichnis, 'push', '-q', 'origin', 'ticket/2')
        return schritt(auftrag)
      },
    ],
    ['touch check-lief'],
    1,
  )

  expect(tracker.ticket(2)).toEqual({
    nummer: 2,
    offen: true,
    assignees: [],
    blocker: [],
    labels: ['ready-for-human'],
  })
  expect(git(remote, 'branch', '--list', 'spec/1')).toBe('')
  expect(git(klon, 'branch', '--list', 'ticket/*')).toBe('')
  expect(git(remote, 'branch', '--list', 'ticket/*')).toBe('')
  expect(git(klon, 'status', '--porcelain')).toBe('')
  expect(git(klon, 'branch', '--show-current')).toBe('spec/1')
  const pruefungen = ereignisse.filter((e) => e.art === 'pruefung')
  expect(pruefungen.filter((p) => !p.ok).map((p) => p.name)).toEqual([rot])
  expect(existsSync(join(klon, 'check-lief'))).toBe(false)
})

test('Checks laufen in Reihenfolge im Repo-Root, beim ersten roten ist Schluss', async () => {
  const { remote, klon } = wegwerfRepo()
  const tracker = einTicket()

  const ereignisse = await lauf(
    klon,
    tracker,
    [commitet],
    ['test -f a.txt', 'false', 'touch zu-weit'],
    1,
  )

  expect(tracker.ticket(2).offen).toBe(true)
  expect(git(remote, 'branch', '--list', 'spec/1')).toBe('')
  expect(existsSync(join(klon, 'zu-weit'))).toBe(false)
  expect(
    ereignisse.filter((e) => e.art === 'pruefung' && e.name.startsWith('Check')),
  ).toMatchObject([
    { name: 'Check: test -f a.txt', ok: true },
    { name: 'Check: false', ok: false },
  ])
})

test('ein roter Versuch bekommt einen frischen Run auf demselben Ticket-Branch mit der Check-Ausgabe', async () => {
  const { remote, klon } = wegwerfRepo()
  const tracker = einTicket()
  const auftraege: RunAuftrag[] = []

  await lauf(
    klon,
    tracker,
    [
      (auftrag) => {
        auftraege.push(auftrag)
        return commitet(auftrag)
      },
      (auftrag) => {
        auftraege.push(auftrag)
        commitDatei(auftrag.verzeichnis, 'b.txt', 'b', 'Test reparieren')
        return { erfolg: true }
      },
    ],
    ['test -f b.txt || { echo b.txt fehlt; exit 1; }'],
  )

  expect(tracker.ticket(2).offen).toBe(false)
  expect(auftraege.map((a) => a.fixpunkt)).toEqual([
    git(remote, 'rev-parse', 'main'),
    git(remote, 'rev-parse', 'main'),
  ])
  expect(auftraege[0]?.rueckmeldung).toBeUndefined()
  expect(auftraege[1]?.rueckmeldung).toContain('test -f b.txt')
  expect(auftraege[1]?.rueckmeldung).toContain('b.txt fehlt')
})

test('ohne Angabe gibt es 3 Versuche; auch ein gescheiterter Run verbraucht einen', async () => {
  const { klon } = wegwerfRepo()
  const tracker = einTicket()
  const rueckmeldungen: (string | undefined)[] = []
  const merke: AgentSkript = (auftrag) => {
    rueckmeldungen.push(auftrag.rueckmeldung)
    return { erfolg: false }
  }

  const ereignisse = await lauf(klon, tracker, [() => ({ erfolg: true }), merke, merke, merke])

  expect(rueckmeldungen).toHaveLength(2)
  expect(rueckmeldungen[0]).toContain('neuer Commit seit Fixpunkt')
  expect(rueckmeldungen[1]).toContain('Run erfolgreich')
  expect(tracker.ticket(2).labels).toEqual(['ready-for-human'])
  expect(ereignisse.filter((e) => e.art === 'versuch-begonnen')).toMatchObject([
    { versuch: 1, von: 3 },
    { versuch: 2, von: 3 },
    { versuch: 3, von: 3 },
  ])
})

test('ein Versuch, der den Ticket-Branch verlassen hat, macht auf dem Ticket-Branch weiter', async () => {
  const { klon } = wegwerfRepo()
  const tracker = einTicket()
  let imZweitenRun: unknown

  await lauf(klon, tracker, [
    (auftrag) => {
      commitet(auftrag)
      git(auftrag.verzeichnis, 'checkout', '-q', '-b', 'woanders')
      return { erfolg: true }
    },
    ({ verzeichnis }) => {
      imZweitenRun = {
        branch: git(verzeichnis, 'branch', '--show-current'),
        log: git(verzeichnis, 'log', '--format=%s'),
      }
      return { erfolg: true }
    },
  ])

  expect(imZweitenRun).toEqual({ branch: 'ticket/2', log: 'Ticket 2 umsetzen\ninit' })
  expect(tracker.ticket(2).offen).toBe(false)
})

test('ein vorhandener Ticket-Branch wird beim ersten Versuch frisch abgezweigt', async () => {
  const { remote, klon } = wegwerfRepo()
  git(klon, 'checkout', '-q', '-b', 'ticket/2')
  commitDatei(klon, 'alt.txt', 'alt', 'Rest eines alten Laufs')
  git(klon, 'checkout', '-q', 'main')

  await lauf(klon, einTicket(), [commitet])

  expect(git(remote, 'log', '--format=%s', 'spec/1')).toBe('Ticket 2 umsetzen\ninit')
})

test('hat der Agent das Ticket in einem roten Versuch geschlossen, öffnet die Engine es wieder', async () => {
  const { klon } = wegwerfRepo()
  const tracker = einTicket()
  let offenImZweitenRun: boolean | undefined

  await lauf(
    klon,
    tracker,
    [
      async () => {
        await tracker.schliesse(2)
        return { erfolg: true }
      },
      async () => {
        offenImZweitenRun = tracker.ticket(2).offen
        await tracker.schliesse(2)
        return { erfolg: true }
      },
    ],
    undefined,
    2,
  )

  expect(offenImZweitenRun).toBe(true)
  expect(tracker.ticket(2)).toMatchObject({ offen: true, labels: ['ready-for-human'] })
})

test('nach einem gescheiterten Ticket geht es mit der restlichen Frontier weiter', async () => {
  const { remote, klon } = wegwerfRepo()
  const tracker = new InMemoryTracker('ich', [
    { nummer: 2, offen: true, assignees: [], labels: ['ready-for-agent'], blocker: [] },
    { nummer: 3, offen: true, assignees: [], labels: ['ready-for-agent'], blocker: [] },
  ])

  const ereignisse = await lauf(
    klon,
    tracker,
    [
      (auftrag) => {
        commitet(auftrag)
        return { erfolg: false }
      },
      ({ verzeichnis }) => {
        commitDatei(verzeichnis, 'b.txt', 'b', 'Ticket 3 umsetzen')
        return { erfolg: true }
      },
    ],
    undefined,
    1,
  )

  expect(tracker.ticket(3).offen).toBe(false)
  expect(git(remote, 'log', '--format=%s', 'spec/1')).toBe('Ticket 3 umsetzen\ninit')
  expect(ereignisse.filter((e) => e.art === 'ticket-gescheitert')).toMatchObject([
    { ticket: 2, versuche: 1, pruefung: 'Run erfolgreich' },
  ])
})

test('mehrere Commits seit dem Fixpunkt werden zu einem mit allen Messages', async () => {
  const { remote, klon } = wegwerfRepo()

  await lauf(klon, einTicket(), [
    (auftrag) => {
      commitet(auftrag)
      commitDatei(auftrag.verzeichnis, 'b.txt', 'b', 'Review-Befunde beheben\n\nDetails')
      return { erfolg: true }
    },
  ])

  expect(git(remote, 'log', '--format=%B', 'spec/1')).toBe(
    'Ticket 2 umsetzen\n\nReview-Befunde beheben\n\nDetails\n\ninit',
  )
  expect(git(remote, 'show', '--format=', '--name-only', 'spec/1')).toBe('a.txt\nb.txt')
})

test('die Check-Ausgabe für den nächsten Run ist von vorn auf 100 Zeilen gekürzt', async () => {
  const { klon } = wegwerfRepo()
  let rueckmeldung: string | undefined

  await lauf(
    klon,
    einTicket(),
    [
      commitet,
      (auftrag) => {
        rueckmeldung = auftrag.rueckmeldung
        return { erfolg: true }
      },
    ],
    ['seq 1 150; exit 1'],
    2,
  )

  expect(rueckmeldung).toContain('gekürzt')
  expect(rueckmeldung).toContain('\n51\n')
  expect(rueckmeldung).not.toContain('\n50\n')
  expect(rueckmeldung?.endsWith('\n150')).toBe(true)
})

test('ein von einem gescheiterten Ticket abhängiges Ticket bleibt liegen', async () => {
  const { klon } = wegwerfRepo()
  const tracker = new InMemoryTracker('ich', [
    { nummer: 2, offen: true, assignees: [], labels: ['ready-for-agent'], blocker: [] },
    {
      nummer: 3,
      offen: true,
      assignees: [],
      labels: ['ready-for-agent'],
      blocker: [{ nummer: 2, offen: true }],
    },
  ])

  await lauf(klon, tracker, [() => ({ erfolg: false })], undefined, 1)

  expect(tracker.ticket(3)).toMatchObject({ offen: true, assignees: [] })
})

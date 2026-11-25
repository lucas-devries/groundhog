import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { type AgentSkript, fakeAgent } from './agent.ts'
import { type Ereignis, fahreLauf } from './engine.ts'
import { git } from './git.ts'
import { durchreiche } from './sandbox.ts'
import { commitDatei, wegwerfRepo } from './testing/wegwerf-repo.ts'
import { InMemoryTracker } from './tracker.ts'
import { steuerbareUhr } from './uhr.ts'

/** Fährt einen Lauf über Spec 1 mit Ziel-Branch main; liefert die Ereignisse. */
async function lauf(
  verzeichnis: string,
  tracker: InMemoryTracker,
  skript: AgentSkript[],
  checks = ['true'],
): Promise<Ereignis[]> {
  const ereignisse: Ereignis[] = []
  await fahreLauf({
    spec: 1,
    auswahl: { zielBranch: 'main', abschluss: 'nichts' },
    verzeichnis,
    checks,
    tracker,
    agent: fakeAgent(skript),
    sandbox: durchreiche,
    uhr: steuerbareUhr(),
    melde: (e) => ereignisse.push(e),
  })
  return ereignisse
}

const einTicket = () => new InMemoryTracker('ich', [{ nummer: 2, offen: true, assignees: [] }])

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
])('Prüfung „%s“ rot: Ticket bleibt offen, nichts gepusht, keine Checks', async (rot, schritt) => {
  const { remote, klon } = wegwerfRepo()
  const tracker = einTicket()

  const ereignisse = await lauf(klon, tracker, [schritt], ['touch check-lief'])

  expect(tracker.ticket(2).offen).toBe(true)
  expect(git(remote, 'branch', '--list', 'spec/1')).toBe('')
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

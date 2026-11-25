import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { nimmSperre } from './sperre.ts'
import { wegwerfRepo } from './testing/wegwerf-repo.ts'

const datei = (klon: string) => join(klon, '.git', 'groundhog.lock')

/** Eine PID, die sicher nicht mehr lebt: die eines beendeten Kindprozesses. */
const totePid = () => spawnSync('true').pid as number

test('die Sperre hält PID, Startzeit und Spec-Nummer und verschwindet beim Freigeben', () => {
  const { klon } = wegwerfRepo()

  const sperre = nimmSperre(klon, 25, 1_000)

  expect(sperre.ok).toBe(true)
  expect(JSON.parse(readFileSync(datei(klon), 'utf8'))).toEqual({
    pid: process.pid,
    start: 1_000,
    spec: 25,
  })
  if (sperre.ok) sperre.freigeben()
  expect(existsSync(datei(klon))).toBe(false)
})

test('eine Sperre mit lebender PID bricht den Start mit PID und Spec-Nummer ab und bleibt stehen', () => {
  const { klon } = wegwerfRepo()
  const fremd = JSON.stringify({ pid: process.ppid, start: 5, spec: 7 })
  writeFileSync(datei(klon), fremd)

  const sperre = nimmSperre(klon, 25, 1_000)

  expect(sperre).toEqual({
    ok: false,
    meldung: `In diesem Klon läuft schon ein Lauf an Spec #7 (PID ${process.ppid}).`,
  })
  expect(readFileSync(datei(klon), 'utf8')).toBe(fremd)
})

test('eine Sperre mit toter PID wird ohne Frage übernommen', () => {
  const { klon } = wegwerfRepo()
  writeFileSync(datei(klon), JSON.stringify({ pid: totePid(), start: 5, spec: 7 }))

  const sperre = nimmSperre(klon, 25, 1_000)

  expect(sperre.ok).toBe(true)
  expect(JSON.parse(readFileSync(datei(klon), 'utf8')).pid).toBe(process.pid)
})

test('eine unlesbare Sperre gilt als Rest eines Absturzes und wird übernommen', () => {
  const { klon } = wegwerfRepo()
  writeFileSync(datei(klon), '{"pid": 12')

  expect(nimmSperre(klon, 25, 1_000).ok).toBe(true)
})

test('in einem Worktree liegt die Sperre im gemeinsamen .git des Klons', () => {
  const { klon } = wegwerfRepo()
  const baum = join(klon, '..', 'baum')
  spawnSync('git', ['worktree', 'add', '-q', baum], { cwd: klon })

  expect(nimmSperre(baum, 25, 1_000).ok).toBe(true)
  expect(nimmSperre(klon, 26, 1_000).ok).toBe(false)
})

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { afterEach, expect, test, vi } from 'vitest'
import type { RunAuftrag } from './agent.ts'
import { claudeAgent } from './claude.ts'
import { type ClaudeAntwort, fakeClaude } from './testing/fake-claude.ts'

afterEach(() => {
  vi.unstubAllEnvs()
})

const FIXPUNKT = '0123456789abcdef0123456789abcdef01234567'

/** Ein Claude-Adapter gegen ein Fake-`claude` im `PATH`. */
function mitFake(
  antworten: ClaudeAntwort[],
  permissionModus: 'bypassPermissions' | 'auto' = 'bypassPermissions',
) {
  const claude = fakeClaude(antworten)
  vi.stubEnv('PATH', `${claude.verzeichnis}${delimiter}${process.env.PATH}`)
  const agent = claudeAgent({
    repoUrl: 'https://github.com/lucas-devries/groundhog',
    token: 'gho_engine',
    permissionModus,
  })
  return { agent, aufrufe: claude.aufrufe }
}

function auftrag(teil: Partial<RunAuftrag> = {}): RunAuftrag & { zeilen: string[] } {
  const zeilen: string[] = []
  return {
    ticket: { nummer: 33, offen: true, labels: [], assignees: [], blocker: [] },
    verzeichnis: mkdtempSync(join(tmpdir(), 'claude-run-')),
    fixpunkt: FIXPUNKT,
    signal: new AbortController().signal,
    ausgabe: (zeile) => zeilen.push(zeile),
    zeilen,
    ...teil,
  }
}

test('ein Run ruft implement mit der Ticket-URL auf, mit stream-json, Permission-Modus und AFK-Hinweis, stdin auf /dev/null', async () => {
  const { agent, aufrufe } = mitFake([{ aufnahme: 'claude-run-gruen.jsonl' }])
  const a = auftrag()

  await agent.run(a)

  const [aufruf] = aufrufe()
  expect(aufruf?.cwd).toBe(a.verzeichnis)
  expect(aufruf?.stdin).toBe('/dev/null')
  const args = aufruf?.args ?? []
  expect(args.slice(0, 2)).toEqual([
    '-p',
    '/mattpocock-skills:implement https://github.com/lucas-devries/groundhog/issues/33',
  ])
  expect(args.join(' ')).toContain('--output-format stream-json --verbose')
  expect(args.join(' ')).toContain('--permission-mode bypassPermissions')
  const hinweis = args[args.indexOf('--append-system-prompt') + 1]
  expect(hinweis).toContain(FIXPUNKT)
  expect(hinweis).toContain('mattpocock-skills:tdd')
  expect(hinweis).toContain('mattpocock-skills:code-review')
})

test('der Run bekommt das gh-Token der Engine und keinen Retry-Watchdog und kein ANTHROPIC_LOG', async () => {
  vi.stubEnv('CLAUDE_CODE_RETRY_WATCHDOG', '1')
  vi.stubEnv('CLAUDE_CODE_RETRY_WATCHDOG_MAX_WAIT_MS', '60000')
  vi.stubEnv('ANTHROPIC_LOG', 'debug')
  vi.stubEnv('GH_TOKEN', 'gho_fremd')
  const { agent, aufrufe } = mitFake([{ aufnahme: 'claude-run-gruen.jsonl' }])

  await agent.run(auftrag())

  expect(aufrufe()[0]?.env).toEqual({ GH_TOKEN: 'gho_engine' })
})

// Aufnahme: der erste Run aus prototype/cli-oberflaeche/run.jsonl (echter Run, CLI 2.1.331).
test('ein erfolgreicher Run meldet jede Zeile des Stroms, die Session, die Skills, Tokens und Kosten', async () => {
  const { agent } = mitFake([{ aufnahme: 'claude-run-gruen.jsonl' }])
  const a = auftrag()

  const ergebnis = await agent.run(a)

  expect(a.zeilen).toHaveLength(20)
  expect(JSON.parse(a.zeilen[19] ?? '').type).toBe('result')
  expect(ergebnis).toMatchObject({
    erfolg: true,
    sessionId: '3b80658c-18e0-4c94-a5e9-f770701651dd',
    tokens: {
      input_tokens: 6,
      cache_creation_input_tokens: 24622,
      cache_read_input_tokens: 83286,
      output_tokens: 1065,
    },
    kostenUsd: 0.4532572,
    blocks: [],
  })
  expect(ergebnis.skills).toContain('mattpocock-skills:implement')
  expect(ergebnis.usageLimit).toBeUndefined()
})

test('ohne Sandbox läuft der Run im Auto-Mode; ab Versuch 2 hängt die Rückmeldung am Prompt', async () => {
  const { agent, aufrufe } = mitFake([{ aufnahme: 'claude-run-gruen.jsonl' }], 'auto')

  await agent.run(auftrag({ rueckmeldung: 'Check `npm test` endete mit Exit 1.' }))

  const args = aufrufe()[0]?.args ?? []
  expect(args.join(' ')).toContain('--permission-mode auto')
  expect(args[1]).toBe(
    '/mattpocock-skills:implement https://github.com/lucas-devries/groundhog/issues/33\n\nCheck `npm test` endete mit Exit 1.',
  )
})

test('ein Run ist nur bei Exit 0, is_error false und subtype success erfolgreich', async () => {
  const { agent } = mitFake([
    { aufnahme: 'claude-run-gruen.jsonl', exitCode: 1 },
    { aufnahme: 'claude-server-throttle.jsonl', exitCode: 0 },
    { exitCode: 0 },
  ])

  expect((await agent.run(auftrag())).erfolg).toBe(false)
  expect((await agent.run(auftrag())).erfolg).toBe(false)
  expect((await agent.run(auftrag())).erfolg).toBe(false)
})

test('Blocks kommen mit Tool, Befehl und Begründung im Ergebnis an, jeder nur einmal', async () => {
  const { agent } = mitFake([{ aufnahme: 'claude-blocks.jsonl' }])

  const ergebnis = await agent.run(auftrag())

  expect(ergebnis.erfolg).toBe(true)
  expect(ergebnis.blocks).toEqual([
    { tool: 'Bash', befehl: 'rm -rf ~/.ssh', grund: 'Deletes files outside the working directory' },
    { tool: 'Write', befehl: '/etc/hosts' },
  ])
})

// Aufnahme: Ausgabe von claude 2.1.331 gegen den Mock aus research/usage-limit-erkennung.
// Die Felder sind undokumentiert; schlägt dieser Test nach einem CLI-Update fehl, greift die
// Erkennung nicht mehr.
test('ein Abbruch am Usage-Limit wird erkannt und mit der Reset-Zeit in ms gemeldet', async () => {
  const { agent } = mitFake([{ aufnahme: 'claude-usage-limit.jsonl', exitCode: 1 }])

  const ergebnis = await agent.run(auftrag())

  expect(ergebnis).toMatchObject({ erfolg: false, usageLimit: 1795546773_000 })
})

test('api_error usage_limit_reached allein ist ein Limit, nur mit Exit ungleich 0', async () => {
  const { agent } = mitFake([
    { aufnahme: 'claude-usage-limit.jsonl', exitCode: 0 },
    { aufnahme: 'claude-usage-limit-ohne-event.jsonl', exitCode: 1 },
  ])

  expect((await agent.run(auftrag())).usageLimit).toBeUndefined()
  const vorher = Date.now()
  const ohneEvent = await agent.run(auftrag())

  // Ohne Reset-Zeit meldet der Adapter "jetzt"; die Engine wartet ihren Puffer und fragt `/usage`.
  expect(ohneEvent.usageLimit).toBeGreaterThanOrEqual(vorher)
  expect(ohneEvent.usageLimit).toBeLessThanOrEqual(Date.now())
})

test('ein Server-Throttle (rejected ohne resetsAt) ist kein Usage-Limit', async () => {
  const { agent } = mitFake([{ aufnahme: 'claude-server-throttle.jsonl', exitCode: 1 }])

  const ergebnis = await agent.run(auftrag())

  expect(ergebnis.erfolg).toBe(false)
  expect(ergebnis.usageLimit).toBeUndefined()
})

test('credits_required ohne resetsAt meldet, dass es nur mit Guthaben weitergeht', async () => {
  const { agent } = mitFake([{ aufnahme: 'claude-guthaben.jsonl', exitCode: 1 }])

  expect((await agent.run(auftrag())).usageLimit).toBe('guthaben')
})

test('bricht die Engine ab, beendet der Adapter den Run samt Kindprozessen', async () => {
  const { agent, aufrufe } = mitFake([{ haengt: true }])
  const abbruch = new AbortController()

  const lauf = agent.run(auftrag({ signal: abbruch.signal }))
  await vi.waitFor(() => expect(aufrufe()[0]?.kind).toBeDefined())
  abbruch.abort()
  const ergebnis = await lauf

  expect(ergebnis.erfolg).toBe(false)
  const kind = aufrufe()[0]?.kind ?? 0
  await vi.waitFor(() => expect(() => process.kill(kind, 0)).toThrow())
})

test('/usage meldet das späteste Reset der erschöpften Fenster, sonst nichts', async () => {
  const { agent, aufrufe } = mitFake([
    { aufnahme: 'claude-usage-erschoepft.jsonl' },
    { aufnahme: 'claude-usage-frei.jsonl' },
  ])

  expect(await agent.erschoepftBis()).toBe(Date.parse('2026-11-27T01:00:00Z'))
  expect(await agent.erschoepftBis()).toBeUndefined()
  expect(aufrufe()[0]?.args.slice(0, 2)).toEqual(['-p', '/usage'])
  expect(aufrufe()[0]?.stdin).toBe('/dev/null')
})

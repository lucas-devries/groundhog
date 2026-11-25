import { readFileSync } from 'node:fs'
import { hostname } from 'node:os'
import { expect, test } from 'vitest'
import { fakeAgent } from './agent.ts'
import { anzeige } from './anzeige.ts'
import { type AbschlussErgebnis, type Ereignis, fahreLauf } from './engine.ts'
import { durchreiche } from './sandbox.ts'
import { commitDatei, wegwerfRepo } from './testing/wegwerf-repo.ts'
import { InMemoryTracker } from './tracker.ts'
import { steuerbareUhr } from './uhr.ts'

/** Was die Anzeige ohne Terminal aus einer Folge von Ereignissen schreibt. */
function text(ereignisse: Ereignis[], optionen: Parameters<typeof anzeige>[0] = {}): string {
  return ereignisse.flatMap(anzeige(optionen)).join('\n')
}

/** Eine Zeile `stream-json` als Ereignis der Engine. */
const ausgabe = (zeile: object | string): Ereignis => ({
  art: 'run-ausgabe',
  ticket: 2,
  run: 1,
  zeile: typeof zeile === 'string' ? zeile : JSON.stringify(zeile),
  zeit: 0,
})
const assistant = (...content: object[]) => ausgabe({ type: 'assistant', message: { content } })
const ergebnis = (content: unknown, extra: object = {}) =>
  ausgabe({
    type: 'user',
    message: { content: [{ type: 'tool_result', tool_use_id: 't', content, ...extra }] },
  })

test('die Mitschrift zeigt Text, Tool-Aufrufe mit dem wichtigsten Argument und Ergebnisse auf einer Zeile', () => {
  expect(
    text([
      assistant({ type: 'text', text: 'Ich lese zuerst die Tests.' }),
      assistant({
        type: 'tool_use',
        id: 't',
        name: 'Bash',
        input: { command: 'npm test', description: 'Tests laufen lassen' },
      }),
      ergebnis('✔ eins\n✔ zwei\nℹ pass 2'),
      assistant({ type: 'tool_use', id: 'u', name: 'Read', input: { file_path: '/repo/a.ts' } }),
      ergebnis([{ type: 'text', text: 'Datei\nnicht gefunden' }], { is_error: true }),
      ausgabe('kein JSON, etwa stderr von claude'),
      ausgabe({ type: 'system', subtype: 'init' }),
      // Steuerzeichen aus der Ausgabe des Agents färben und überschreiben nichts.
      ergebnis('\x1b[31mrot\x1b[0m\x1b[2K\rweiter'),
    ]),
  ).toBe(
    [
      '  │ Ich lese zuerst die Tests.',
      '  │ ⏺ Bash npm test',
      '  │   ⎿ ✔ eins ✔ zwei ℹ pass 2',
      '  │ ⏺ Read /repo/a.ts',
      '  │   ⎿ Datei nicht gefunden',
      '  │   ⎿ rot weiter',
    ].join('\n'),
  )
})

test('eine Änderung erscheint als Diff aus structuredPatch, eine neue Datei aus content, höchstens 12 Zeilen', () => {
  const neu = Array.from({ length: 14 }, (_, i) => `zeile ${i + 1}`).join('\n')
  const mitPatch = (tool_use_result: object) =>
    ausgabe({
      type: 'user',
      message: { content: [{ type: 'tool_result', content: 'erfolgreich' }] },
      tool_use_result,
    })
  expect(
    text([
      mitPatch({
        filePath: '/repo/a.ts',
        structuredPatch: [
          { oldStart: 7, newStart: 7, lines: [' a', '-b', '+c', '+d', ' e'] },
          { oldStart: 20, newStart: 21, lines: ['-x'] },
        ],
      }),
      mitPatch({
        type: 'create',
        filePath: '/repo/neu.txt',
        content: `${neu}\n`,
        structuredPatch: [],
      }),
      mitPatch({
        type: 'create',
        filePath: '/repo/eins.txt',
        content: 'eins',
        structuredPatch: [],
      }),
    ]),
  ).toBe(
    [
      '  │   ⎿ 2 Zeilen hinzugefügt, 2 entfernt',
      '  │        7   a',
      '  │        8 - b',
      '  │        8 + c',
      '  │        9 + d',
      '  │       10   e',
      '  │       20 - x',
      '  │   ⎿ 14 Zeilen hinzugefügt, 0 entfernt',
      ...Array.from(
        { length: 12 },
        (_, i) => `  │     ${String(i + 1).padStart(4)} + zeile ${i + 1}`,
      ),
      '  │          … 2 weitere Zeilen',
      '  │   ⎿ 1 Zeile hinzugefügt, 0 entfernt',
      '  │        1 + eins',
    ].join('\n'),
  )
})

test('Zustandswechsel der Tickets, Prüfungen, Blocks und Warnungen erscheinen als Zeilen', () => {
  const um = (stunde: number, minute = 0, tag = 25) =>
    new Date(2026, 10, tag, stunde, minute).getTime()
  const t = (e: Record<string, unknown>) => ({ ticket: 26, zeit: um(1), ...e }) as Ereignis
  expect(
    text([
      {
        art: 'lauf-begonnen',
        spec: 25,
        auswahl: { zielBranch: 'main', abschluss: 'pr' },
        versionen: { groundhog: '1.0.0', claude: '2.1.0' },
        zeit: um(1),
      },
      { art: 'task-graph', tickets: [], zeit: um(1) },
      t({ art: 'ticket-genommen' }),
      t({ art: 'versuch-begonnen', versuch: 1, von: 3 }),
      t({ art: 'run-beendet', run: 1, versuch: 1, erfolg: true }),
      t({
        art: 'run-beendet',
        run: 1,
        versuch: 1,
        erfolg: true,
        blocks: [
          { tool: 'Bash', befehl: 'rm -rf ~/.ssh', grund: 'Deletes files outside the repo' },
          { tool: 'Write', befehl: '/etc/hosts' },
        ],
      }),
      t({ art: 'pruefung', name: 'Run erfolgreich', ok: true }),
      t({ art: 'pruefung', name: 'Check: npm test', ok: false, ausgabe: '1 failed' }),
      t({ art: 'versuch-begonnen', versuch: 2, von: 3 }),
      t({ art: 'pause', reset: um(3, 10) }),
      t({ art: 'pause', reset: um(3, 10, 27) }),
      t({ art: 'pruefung', name: 'Check: npm test', ok: true }),
      { art: 'push', branch: 'spec/25', commit: 'abcdef1234567890', zeit: um(2) },
      t({ art: 'ticket-erledigt', commit: 'abcdef1234567890', versuche: 2 }),
      t({ art: 'ticket-genommen', ticket: 27 }),
      t({ art: 'ticket-gescheitert', ticket: 27, versuche: 3, pruefung: 'Check: npm test' }),
      { art: 'warnung', text: 'Kommentar an #27 gescheitert: boom', zeit: um(2) },
      t({ art: 'lauf-angehalten', ticket: 28, grund: 'guthaben' }),
    ]),
  ).toBe(
    [
      'groundhog 1.0.0 · Spec #25 · Ziel-Branch main · Abschluss PR',
      '',
      '━━ #26 genommen',
      '  ▶ Versuch 1 von 3',
      '  ⛔ Block: Bash rm -rf ~/.ssh (Deletes files outside the repo)',
      '  ⛔ Block: Write /etc/hosts',
      '  ✔ Run erfolgreich',
      '  ✘ Check: npm test',
      '  ▶ Versuch 2 von 3',
      '  ⏸ Usage-Limit erreicht, Pause bis 03:10',
      '  ⏸ Usage-Limit erreicht, Pause bis 27.11. 03:10',
      '  ✔ Check: npm test',
      '  ↑ spec/25 gepusht: abcdef1',
      '✔ #26 erledigt in Versuch 2 · Commit abcdef1',
      '',
      '━━ #27 genommen',
      '✘ #27 endgültig gescheitert nach 3 Versuchen (rot: Check: npm test) → ready-for-human',
      '⚠ Kommentar an #27 gescheitert: boom',
      '■ Lauf angehalten an #28: Usage-Limit ohne Reset-Zeit, weiter erst mit Guthaben',
    ].join('\n'),
  )
})

const begonnen = (abschluss: 'mergen' | 'pr' | 'nichts'): Ereignis => ({
  art: 'lauf-begonnen',
  spec: 25,
  auswahl: { zielBranch: 'main', abschluss },
  versionen: {},
  zeit: 0,
})
const beendet = (abschluss: AbschlussErgebnis): Ereignis => ({
  art: 'lauf-beendet',
  abschluss,
  uebersicht: '# Übersicht Spec #25\n\n- #26 erledigt',
  zeit: 0,
})

test('am Ende stehen die Übersicht, der Stand des Integration-Branch, der Abschluss und als letzte Zeile der Pfad der Übersicht', () => {
  expect(
    text(
      [
        begonnen('pr'),
        { art: 'push', branch: 'spec/25', commit: 'abcdef1234567890', zeit: 0 },
        { art: 'ticket-erledigt', ticket: 26, commit: 'abcdef1234567890', versuche: 1, zeit: 0 },
        beendet({ art: 'entfaellt', grund: 'Tickets offen' }),
      ],
      { protokoll: '/repo/.git/groundhog/laeufe/x' },
    )
      .split('\n')
      .slice(3),
  ).toEqual([
    '',
    '# Übersicht Spec #25',
    '',
    '- #26 erledigt',
    '',
    'Integration-Branch spec/25: 1 Ticket übernommen, Stand abcdef1',
    'Abschluss PR entfällt, weil Tickets offen sind. Nächster Lauf: groundhog 25',
    `Rechner: ${hostname()} · Protokoll: /repo/.git/groundhog/laeufe/x`,
    'Übersicht: /repo/.git/groundhog/laeufe/x/uebersicht.md',
  ])
})

test.each([
  [
    'mergen',
    { art: 'gemergt', commit: '1234567890' },
    'Abschluss Mergen: spec/25 nach main gemergt, Merge-Commit 1234567, Spec #25 geschlossen',
  ],
  ['mergen', { art: 'konflikt' }, 'Abschluss Mergen: Konflikt mit main, spec/25 bleibt stehen'],
  [
    'pr',
    { art: 'pr', url: 'https://github.com/o/r/pull/9' },
    'Abschluss PR: https://github.com/o/r/pull/9',
  ],
  ['nichts', { art: 'nichts' }, 'Abschluss Nichts: spec/25 bleibt stehen'],
  [
    'pr',
    { art: 'entfaellt', grund: 'abgebrochen' },
    'Abschluss PR entfällt, weil der Lauf abgebrochen wurde. Nächster Lauf: groundhog 25',
  ],
] as const)('Abschluss %s → %o', (wahl, abschluss, zeile) => {
  expect(
    text([begonnen(wahl), beendet(abschluss)])
      .split('\n')
      .slice(-3),
  ).toEqual([
    'Integration-Branch spec/25: keine Tickets übernommen',
    zeile,
    `Rechner: ${hostname()}`,
  ])
})

test('ein echter Run, durch die Engine gemeldet, erscheint fortlaufend ohne Farbe und ohne überlange Zeilen', async () => {
  const { klon } = wegwerfRepo()
  const aufnahme = readFileSync(
    new URL('./testing/aufnahmen/claude-run-edit.jsonl', import.meta.url),
    'utf8',
  )
  const ereignisse: Ereignis[] = []
  await fahreLauf({
    spec: 1,
    auswahl: { zielBranch: 'main', abschluss: 'nichts' },
    verzeichnis: klon,
    checks: ['true'],
    tracker: new InMemoryTracker('ich', [
      { nummer: 2, offen: true, labels: ['ready-for-agent'], assignees: [], blocker: [] },
    ]),
    agent: fakeAgent([
      ({ verzeichnis, ausgabe }) => {
        for (const zeile of aufnahme.split('\n')) ausgabe(zeile)
        commitDatei(verzeichnis, 'fizzbuzz.mjs', 'x', 'Add fizzbuzz')
        return { erfolg: true }
      },
    ]),
    sandbox: durchreiche,
    uhr: steuerbareUhr(),
    melde: (e) => ereignisse.push(e),
  })

  const zeilen = text(ereignisse, { breite: 80 }).split('\n')
  expect(zeilen.join('\n')).not.toContain('\x1b')
  expect(zeilen.filter((z) => z.startsWith('  │') && z.length > 80)).toEqual([])
  const ab = (anfang: string, n: number) => {
    const i = zeilen.indexOf(anfang)
    return zeilen.slice(i, i + n)
  }
  expect(ab('━━ #2 genommen', 3)).toEqual([
    '━━ #2 genommen',
    '  ▶ Versuch 1 von 3',
    '  │ ⏺ Write /tmp/echter-run/fizzbuzz.mjs',
  ])
  expect(ab('  │ ⏺ Edit /tmp/echter-run/fizzbuzz.mjs', 5)).toEqual([
    '  │ ⏺ Edit /tmp/echter-run/fizzbuzz.mjs',
    '  │   ⎿ 1 Zeile hinzugefügt, 1 entfernt',
    '  │        1   export const fizzbuzz = (n) =>',
    "  │        2 -   (n % 3 ? '' : 'Fizz') + (n % 5 ? '' : 'Buzz') || String(n);",
    "  │        2 +   (n % 3 ? '' : 'Fizz') + (n % 5 ? '' : 'Buzz') + (n % 7 ? '' : '",
  ])
  expect(ab('  │ ⏺ Read /tmp/echter-run/fizzbuzz.mjs', 2)[1]).toMatch(
    /^ {2}│ {3}⎿ 1 export const fizzbuzz.*…$/,
  )
  expect(ab('  │ Fertig. Tests grün (1 pass, 0 fail), Commit `2598225`.', 9)).toEqual([
    '  │ Fertig. Tests grün (1 pass, 0 fail), Commit `2598225`.',
    "  │ - `fizzbuzz.mjs:2` → `+ (n % 7 ? '' : 'Bazz')` angehängt",
    '  │ - `fizzbuzz.test.mjs` → Asserts für 7, 21, 35, 105 ergänzt',
    '  │ - Commit ohne Claude-Trailer',
    expect.stringMatching(/^ {2}│ Übersprungen: nix\. .*…$/),
    '  ✔ Run erfolgreich',
    '  ✔ HEAD auf ticket/2',
    '  ✔ neuer Commit seit Fixpunkt',
    '  ✔ Arbeitsverzeichnis sauber',
  ])
  expect(zeilen).toContain('  ✔ Check: true')
  expect(zeilen.find((z) => z.startsWith('✔ #2 erledigt in Versuch 1 · Commit '))).toBeDefined()
})

test('mit Farbe: + grün, - rot, Code mit Syntaxfarben, Fehler rot', () => {
  const zeilen = text(
    [
      ausgabe({
        type: 'user',
        message: { content: [{ type: 'tool_result', content: 'ok' }] },
        tool_use_result: {
          filePath: '/repo/a.ts',
          structuredPatch: [{ oldStart: 1, newStart: 1, lines: ['-let a = 1', '+const a = 2'] }],
        },
      }),
      ergebnis('kaputt', { is_error: true }),
    ],
    { farbe: true },
  ).split('\n')
  const [, minus, plus, fehler] = zeilen
  expect(minus).toBe('  │     \x1b[31m   1 -\x1b[0m \x1b[2mlet a = 1\x1b[0m')
  expect(plus?.startsWith('  │     \x1b[32m   1 +\x1b[0m ')).toBe(true)
  // Syntaxfarben: das Schlüsselwort ist eingefärbt.
  expect(plus).toContain('mconst\x1b[')
  expect(fehler).toBe('  │   \x1b[31m⎿ kaputt\x1b[0m')
})

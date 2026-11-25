import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import type { Agent, Block, RunErgebnis } from './agent.ts'
import type { SrtSandbox } from './sandbox.ts'

export interface ClaudeOptionen {
  /** `https://github.com/<owner>/<repo>`; die Ticket-URL ist `<repoUrl>/issues/<n>`. */
  repoUrl: string
  /** Das `gh`-Token der Engine; der Run bekommt es als `GH_TOKEN`. */
  token: string
  /**
   * Die Sandbox um den ganzen `claude`-Prozess jedes Runs; `undefined` nur bei `sandbox.aus`. Davon
   * hängt der Permission-Modus ab: Bypass nur in der Sandbox, sonst Auto-Mode. Bypass ohne Sandbox
   * gibt es nicht.
   */
  sandbox: Pick<SrtSandbox, 'umhuelle'> | undefined
}

/** Der AFK-Hinweis, den jeder Run per `--append-system-prompt` bekommt. */
export function afkHinweis(fixpunkt: string): string {
  return [
    'You are running AFK: no human is available and nobody will answer a question.',
    'Never ask. Where a skill says to confirm something or ask the user, take the most obvious reading, decide yourself, note the decision and its reason, and continue.',
    'Choose the seams for mattpocock-skills:tdd yourself.',
    'Call the skills by their full names: mattpocock-skills:tdd and mattpocock-skills:code-review (not the built-in code-review).',
    `The fixed point for the review is commit ${fixpunkt}.`,
    `Work in this order: implement the ticket, commit, review with mattpocock-skills:code-review against ${fixpunkt}, fix the findings, then squash everything since ${fixpunkt} into one commit with a short message covering the whole work on the ticket.`,
  ].join('\n')
}

/** Der Agent hinter `claude -p`. */
export function claudeAgent(optionen: ClaudeOptionen): Agent {
  const env = umgebung(optionen.token)
  return {
    async run(auftrag) {
      let prompt = `/mattpocock-skills:implement ${optionen.repoUrl}/issues/${auftrag.ticket.nummer}`
      if (auftrag.rueckmeldung) prompt += `\n\n${auftrag.rueckmeldung}`
      const strom = auswertung()
      const aufruf = [
        'claude',
        '-p',
        prompt,
        '--output-format',
        'stream-json',
        '--verbose',
        '--permission-mode',
        optionen.sandbox ? 'bypassPermissions' : 'auto',
        '--append-system-prompt',
        afkHinweis(auftrag.fixpunkt),
      ]
      const exitCode = await starte(
        optionen.sandbox?.umhuelle(aufruf, auftrag.verzeichnis) ?? aufruf,
        { verzeichnis: auftrag.verzeichnis, env, signal: auftrag.signal },
        (zeile) => strom.lies(auftrag.ausgabe(zeile)),
      )
      return strom.ergebnis(exitCode)
    },

    // `/usage` ruft kein Modell und kein Tool auf und kostet nichts; es läuft ohne Sandbox.
    async erschoepftBis() {
      let bis: number | undefined
      await starte(
        ['claude', '-p', '/usage', '--output-format', 'stream-json', '--verbose'],
        { verzeichnis: process.cwd(), env },
        (zeile) => {
          for (const fenster of parse(zeile)?.usage_report?.rate_limits?.limits ?? []) {
            if (fenster.percent < 100 || !fenster.resets_at) continue
            bis = Math.max(bis ?? 0, Date.parse(fenster.resets_at))
          }
        },
      )
      return bis
    },
  }
}

/**
 * Umgebung eines Runs: ohne Retry-Watchdog (das Warten am Usage-Limit liegt in der Engine) und
 * ohne `ANTHROPIC_LOG` (zerstört das NDJSON), mit dem `gh`-Token der Engine.
 */
function umgebung(token: string): NodeJS.ProcessEnv {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([k]) => !k.startsWith('CLAUDE_CODE_RETRY_WATCHDOG') && k !== 'ANTHROPIC_LOG',
    ),
  )
  return { ...env, GH_TOKEN: token }
}

/**
 * Startet `argv` (`claude`, ggf. in der Sandbox) mit stdin auf `/dev/null` und reicht jede Zeile
 * von stdout und stderr weiter. Bricht `signal` ab, stirbt die ganze Prozessgruppe. Liefert den
 * Exit-Code (`null` nach Signal).
 */
function starte(
  [datei = '', ...args]: string[],
  {
    verzeichnis,
    env,
    signal,
  }: { verzeichnis: string; env: NodeJS.ProcessEnv; signal?: AbortSignal },
  aufZeile: (zeile: string) => void,
): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const kind = spawn(datei, args, {
      cwd: verzeichnis,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      // Eigene Prozessgruppe, damit ein Abbruch auch die Kindprozesse des Runs trifft.
      detached: true,
    })
    const beende = () => {
      try {
        if (kind.pid !== undefined) process.kill(-kind.pid, 'SIGKILL')
      } catch {
        // Die Gruppe ist schon weg.
      }
    }
    if (signal?.aborted) beende()
    signal?.addEventListener('abort', beende, { once: true })
    // stderr landet mit im Protokoll; die Auswertung überspringt Zeilen, die kein JSON sind.
    createInterface({ input: kind.stdout }).on('line', aufZeile)
    createInterface({ input: kind.stderr }).on('line', aufZeile)
    kind.on('error', reject)
    kind.on('close', (code) => {
      signal?.removeEventListener('abort', beende)
      resolve(code)
    })
  })
}

/** Die Felder des `stream-json`, die der Adapter liest; viele davon sind undokumentiert. */
interface StromZeile {
  type?: string
  subtype?: string
  session_id?: string
  /** `system/init` */
  skills?: string[]
  /** `result` */
  is_error?: boolean
  usage?: Record<string, unknown>
  total_cost_usd?: number
  permission_denials?: { tool_name: string; tool_use_id: string; tool_input?: Eingabe }[]
  /** `result` und `assistant` am Usage-Limit (undokumentiert). */
  api_error?: string | null
  /** `rate_limit_event`; `resetsAt` in Epoch-Sekunden. */
  rate_limit_info?: { status?: string; resetsAt?: number; errorCode?: string }
  /** `assistant`: Inhalt mit `tool_use`; `system/permission_denied`: Text der Ablehnung. */
  message?: string | { content?: { type: string; id?: string; input?: Eingabe }[] }
  /** `system/permission_denied` */
  tool_name?: string
  tool_use_id?: string
  decision_reason?: string
  /** Antwort auf `/usage`; `resets_at` in ISO 8601. */
  usage_report?: { rate_limits?: { limits?: { percent: number; resets_at?: string }[] } | null }
}

type Eingabe = Record<string, unknown>

function parse(zeile: string): StromZeile | undefined {
  try {
    return JSON.parse(zeile)
  } catch {
    return undefined
  }
}

/** Liest den Strom eines Runs mit und bildet am Ende das Ergebnis. Den Fehlertext liest sie nie. */
function auswertung() {
  let init: StromZeile | undefined
  let result: StromZeile | undefined
  let limitErreicht = false
  let reset: number | undefined
  let guthaben = false
  const eingaben = new Map<string, Eingabe | undefined>()
  const blocks = new Map<string, { tool: string; eingabe?: Eingabe; grund?: string }>()

  return {
    lies(zeile: string) {
      const z = parse(zeile)
      if (!z) return
      if (z.api_error === 'usage_limit_reached') limitErreicht = true
      if (z.type === 'system' && z.subtype === 'init') init = z
      if (z.type === 'rate_limit_event' && z.rate_limit_info?.status === 'rejected') {
        const { resetsAt, errorCode } = z.rate_limit_info
        if (resetsAt !== undefined) reset = resetsAt * 1000
        else if (errorCode === 'credits_required') guthaben = true
      }
      if (z.type === 'assistant' && typeof z.message === 'object') {
        for (const teil of z.message.content ?? []) {
          if (teil.type === 'tool_use' && teil.id) eingaben.set(teil.id, teil.input)
        }
      }
      if (z.type === 'system' && z.subtype === 'permission_denied' && z.tool_use_id) {
        blocks.set(z.tool_use_id, {
          tool: z.tool_name ?? '?',
          eingabe: eingaben.get(z.tool_use_id),
          grund: z.decision_reason ?? (typeof z.message === 'string' ? z.message : undefined),
        })
      }
      if (z.type === 'result') {
        result = z
        // Dieselbe Ablehnung kann als Event und in `permission_denials` stehen.
        for (const d of z.permission_denials ?? []) {
          const block = blocks.get(d.tool_use_id)
          if (block) block.eingabe ??= d.tool_input
          else blocks.set(d.tool_use_id, { tool: d.tool_name, eingabe: d.tool_input })
        }
      }
    },

    ergebnis(exitCode: number | null): RunErgebnis {
      const ergebnis: RunErgebnis = {
        erfolg: exitCode === 0 && result?.is_error === false && result.subtype === 'success',
        sessionId: result?.session_id ?? init?.session_id,
        skills: init?.skills,
        blocks: [...blocks.values()].map(({ tool, eingabe, grund }) => ({
          tool,
          befehl: befehl(eingabe),
          ...(grund !== undefined && { grund }),
        })),
      }
      if (result?.usage) {
        ergebnis.tokens = Object.fromEntries(
          Object.entries(result.usage).filter(
            (e): e is [string, number] => typeof e[1] === 'number',
          ),
        )
      }
      if (result?.total_cost_usd !== undefined) ergebnis.kostenUsd = result.total_cost_usd
      if (exitCode !== 0) {
        if (reset !== undefined) ergebnis.usageLimit = reset
        else if (guthaben) ergebnis.usageLimit = 'guthaben'
        // ponytail: Limit ohne Reset-Zeit → "jetzt"; die Engine wartet den Puffer und fragt `/usage`.
        else if (limitErreicht) ergebnis.usageLimit = Date.now()
      }
      return ergebnis
    },
  }
}

/** Das wichtigste Argument eines Tool-Aufrufs. */
function befehl(eingabe: Eingabe | undefined): Block['befehl'] {
  if (!eingabe) return ''
  for (const feld of ['command', 'file_path', 'url', 'pattern']) {
    const wert = eingabe[feld]
    if (typeof wert === 'string') return wert
  }
  return JSON.stringify(eingabe)
}

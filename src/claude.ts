import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import type { Agent, SessionResult } from './agent.ts'
import type { SrtSandbox } from './sandbox.ts'

export interface ClaudeOptions {
  /** `https://github.com/<owner>/<repo>`; the ticket URL is `<repoUrl>/issues/<n>`. */
  repoUrl: string
  /** The engine's `gh` token; the session gets it as `GH_TOKEN`. */
  token: string
  /**
   * The sandbox around the whole `claude` process of each session; `undefined` only with
   * `sandbox.off`. The permission mode depends on it: bypass only in the sandbox, otherwise auto
   * mode. There is no bypass without a sandbox.
   */
  sandbox: Pick<SrtSandbox, 'wrap'> | undefined
}

/** The AFK note every session gets via `--append-system-prompt`. */
function afkNote(forkPoint: string): string {
  return [
    'You are running AFK: no human is available and nobody will answer a question.',
    'Never ask. Where a skill says to confirm something or ask the user, take the most obvious reading, decide yourself, note the decision and its reason, and continue.',
    'Choose the seams for mattpocock-skills:tdd yourself.',
    'Call the skills by their full names: mattpocock-skills:tdd and mattpocock-skills:code-review (not the built-in code-review).',
    `The fixed point for the review is commit ${forkPoint}.`,
    `Work in this order: implement the ticket, commit, review with mattpocock-skills:code-review against ${forkPoint}, fix the findings, then squash everything since ${forkPoint} into one commit with a short message covering the whole work on the ticket.`,
  ].join('\n')
}

/** The agent behind `claude -p`. */
export function claudeAgent(options: ClaudeOptions): Agent {
  const env = environment(options.token)
  return {
    async runSession(request) {
      let prompt = `/mattpocock-skills:implement ${options.repoUrl}/issues/${request.ticket.number}`
      if (request.feedback) prompt += `\n\n${request.feedback}`
      const stream = evaluation()
      const call = [
        'claude',
        '-p',
        prompt,
        '--output-format',
        'stream-json',
        '--verbose',
        '--permission-mode',
        options.sandbox ? 'bypassPermissions' : 'auto',
        '--append-system-prompt',
        afkNote(request.forkPoint),
      ]
      const exitCode = await startProcess(
        options.sandbox?.wrap(call, request.directory) ?? call,
        { directory: request.directory, env, signal: request.signal },
        (line) => stream.read(request.output(line)),
      )
      return stream.result(exitCode)
    },

    // `/usage` calls no model and no tool and costs nothing; it runs without a sandbox.
    async exhaustedUntil() {
      let until: number | undefined
      await startProcess(
        ['claude', '-p', '/usage', '--output-format', 'stream-json', '--verbose'],
        { directory: process.cwd(), env },
        (line) => {
          for (const window of readStreamLine(line)?.usage_report?.rate_limits?.limits ?? []) {
            if (window.percent < 100 || !window.resets_at) continue
            until = Math.max(until ?? 0, Date.parse(window.resets_at))
          }
        },
      )
      return until
    },
  }
}

/**
 * Environment of a session: without the retry watchdog (waiting at the usage limit lives in the
 * engine) and without `ANTHROPIC_LOG` (breaks the NDJSON), with the engine's `gh` token.
 */
function environment(token: string): NodeJS.ProcessEnv {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([k]) => !k.startsWith('CLAUDE_CODE_RETRY_WATCHDOG') && k !== 'ANTHROPIC_LOG',
    ),
  )
  return { ...env, GH_TOKEN: token }
}

/**
 * Starts `argv` (`claude`, possibly in the sandbox) with stdin on `/dev/null` and passes on every
 * line of stdout and stderr. If `signal` aborts, the whole process group dies. Returns the exit
 * code (`null` after a signal).
 */
function startProcess(
  [file = '', ...args]: string[],
  { directory, env, signal }: { directory: string; env: NodeJS.ProcessEnv; signal?: AbortSignal },
  onLine: (line: string) => void,
): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      cwd: directory,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      // Own process group, so that an abort also hits the session's child processes.
      detached: true,
    })
    const kill = () => {
      try {
        if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL')
      } catch {
        // The group is already gone.
      }
    }
    if (signal?.aborted) kill()
    signal?.addEventListener('abort', kill, { once: true })
    // stderr ends up in the log too; the evaluation skips lines that aren't JSON.
    createInterface({ input: child.stdout }).on('line', onLine)
    createInterface({ input: child.stderr }).on('line', onLine)
    child.on('error', reject)
    child.on('close', (code) => {
      signal?.removeEventListener('abort', kill)
      resolve(code)
    })
  })
}

/** A line of `stream-json` with the fields groundhog reads; many of them are undocumented. */
export interface StreamLine {
  type?: string
  subtype?: string
  session_id?: string
  /** `system/init` */
  skills?: string[]
  plugins?: { name: string; version?: string }[]
  /** `result` */
  is_error?: boolean
  usage?: Record<string, unknown>
  total_cost_usd?: number
  permission_denials?: { tool_name: string; tool_use_id: string; tool_input?: Input }[]
  /** `result` and `assistant` at the usage limit (undocumented). */
  api_error?: string | null
  /** `rate_limit_event`; `resetsAt` in epoch seconds. */
  rate_limit_info?: { status?: string; resetsAt?: number; errorCode?: string }
  /** `assistant` and `user`: the content; `system/permission_denied`: text of the refusal. */
  message?: string | { content?: Content[] }
  /** `user` after Edit and Write: the patch, for new files the content. */
  tool_use_result?: { type?: string; filePath?: string; content?: string; structuredPatch?: Hunk[] }
  /** `system/permission_denied` */
  tool_name?: string
  tool_use_id?: string
  decision_reason?: string
  /** Answer to `/usage`; `resets_at` in ISO 8601. */
  usage_report?: { rate_limits?: { limits?: { percent: number; resets_at?: string }[] } | null }
}

/** A part of the content: text, `tool_use` or `tool_result`. */
export interface Content {
  type?: string
  id?: string
  text?: string
  name?: string
  input?: Input
  content?: string | { text?: string }[]
  is_error?: boolean
}

export interface Hunk {
  oldStart: number
  newStart: number
  lines: string[]
}

type Input = Record<string, unknown>

/** Reads a line of `stream-json`; a non-JSON line gives `undefined`. */
export function readStreamLine(line: string): StreamLine | undefined {
  try {
    return JSON.parse(line)
  } catch {
    return undefined
  }
}

/** Reads along a session's stream and builds the result at the end. It never reads the error text. */
function evaluation() {
  let init: StreamLine | undefined
  let result: StreamLine | undefined
  let limitReached = false
  let reset: number | undefined
  let credit = false
  const inputs = new Map<string, Input | undefined>()
  const blocks = new Map<string, { tool: string; input?: Input; reason?: string }>()

  return {
    read(line: string) {
      const l = readStreamLine(line)
      if (!l) return
      if (l.api_error === 'usage_limit_reached') limitReached = true
      if (l.type === 'system' && l.subtype === 'init') init = l
      if (l.type === 'rate_limit_event' && l.rate_limit_info?.status === 'rejected') {
        const { resetsAt, errorCode } = l.rate_limit_info
        if (resetsAt !== undefined) reset = resetsAt * 1000
        else if (errorCode === 'credits_required') credit = true
      }
      if (l.type === 'assistant' && typeof l.message === 'object') {
        for (const part of l.message.content ?? []) {
          if (part.type === 'tool_use' && part.id) inputs.set(part.id, part.input)
        }
      }
      if (l.type === 'system' && l.subtype === 'permission_denied' && l.tool_use_id) {
        blocks.set(l.tool_use_id, {
          tool: l.tool_name ?? '?',
          input: inputs.get(l.tool_use_id),
          reason: l.decision_reason ?? (typeof l.message === 'string' ? l.message : undefined),
        })
      }
      if (l.type === 'result') {
        result = l
        // The same refusal can appear as an event and in `permission_denials`.
        for (const d of l.permission_denials ?? []) {
          const block = blocks.get(d.tool_use_id)
          if (block) block.input ??= d.tool_input
          else blocks.set(d.tool_use_id, { tool: d.tool_name, input: d.tool_input })
        }
      }
    },

    result(exitCode: number | null): SessionResult {
      const session: SessionResult = {
        success: exitCode === 0 && result?.is_error === false && result.subtype === 'success',
        sessionId: result?.session_id ?? init?.session_id,
        skills: init?.skills,
        blocks: [...blocks.values()].map(({ tool, input, reason }) => ({
          tool,
          command: input ? (keyArgument(input) ?? JSON.stringify(input)) : '',
          ...(reason !== undefined && { reason }),
        })),
      }
      if (result?.usage) {
        session.tokens = Object.fromEntries(
          Object.entries(result.usage).filter(
            (e): e is [string, number] => typeof e[1] === 'number',
          ),
        )
      }
      if (result?.total_cost_usd !== undefined) session.costUsd = result.total_cost_usd
      if (exitCode !== 0) {
        if (reset !== undefined) session.usageLimit = reset
        else if (credit) session.usageLimit = 'credit'
        // ponytail: limit without reset time → "now"; the engine waits its buffer and asks `/usage`.
        else if (limitReached) session.usageLimit = Date.now()
      }
      return session
    },
  }
}

/** The most important argument of a tool call, for transcript and blocks. */
export function keyArgument(input: Input | undefined): string | undefined {
  for (const field of ['command', 'file_path', 'pattern', 'url', 'description']) {
    const value = input?.[field]
    if (typeof value === 'string') return value
  }
  return undefined
}

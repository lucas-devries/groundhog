import { createInterface } from 'node:readline'
import type { Agent, Hunk, SessionResult, TranscriptItem } from './agent.ts'
import { runInProcessGroup } from './process-group.ts'
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

/** `/usage` calls no model and no tool and costs nothing. */
const USAGE = ['-p', '/usage', '--output-format', 'stream-json', '--verbose']

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

    // `/usage` runs without a sandbox.
    async exhaustedUntil() {
      let until: number | undefined
      await startProcess(['claude', ...USAGE], { directory: process.cwd(), env }, (line) => {
        for (const window of readStreamLine(line)?.usage_report?.rate_limits?.limits ?? []) {
          if (window.percent < 100 || !window.resets_at) continue
          until = Math.max(until ?? 0, Date.parse(window.resets_at))
        }
      })
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

/** Starts `argv` (`claude`, possibly in the sandbox) and passes on every line of stdout and stderr. */
function startProcess(
  argv: string[],
  { directory, env, signal }: { directory: string; env: NodeJS.ProcessEnv; signal?: AbortSignal },
  onLine: (line: string) => void,
): Promise<number | null> {
  return runInProcessGroup(argv, { cwd: directory, env, signal }, (stdout, stderr) => {
    // stderr ends up in the log too; the evaluation skips lines that aren't JSON.
    createInterface({ input: stdout }).on('line', onLine)
    createInterface({ input: stderr }).on('line', onLine)
  })
}

interface Plugin {
  name: string
  version?: string
}

/** A line of `stream-json` with the fields groundhog reads; many of them are undocumented. */
interface StreamLine {
  type?: string
  subtype?: string
  session_id?: string
  /** `system/init` */
  skills?: string[]
  plugins?: Plugin[]
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
  /** `assistant` and `user` of a subagent: the call that started it. */
  parent_tool_use_id?: string | null
  /** `user` after Edit and Write: the patch, for new files the content; after Agent its status. */
  tool_use_result?: {
    type?: string
    filePath?: string
    content?: string
    structuredPatch?: Hunk[]
    status?: string
  }
  /** `system/permission_denied` */
  tool_name?: string
  tool_use_id?: string
  decision_reason?: string
  /** Answer to `/usage`; `resets_at` in ISO 8601. */
  usage_report?: { rate_limits?: { limits?: { percent: number; resets_at?: string }[] } | null }
}

/** A part of the content: text, `tool_use` or `tool_result`. */
interface Content {
  type?: string
  id?: string
  text?: string
  name?: string
  input?: Input
  content?: string | { text?: string }[]
  is_error?: boolean
  /** `tool_result`: the call it answers. */
  tool_use_id?: string
}

type Input = Record<string, unknown>

/** Reads a line of `stream-json`; a non-JSON line gives `undefined`. */
function readStreamLine(line: string): StreamLine | undefined {
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
function keyArgument(input: Input | undefined): string | undefined {
  for (const field of ['command', 'file_path', 'pattern', 'url', 'description']) {
    const value = input?.[field]
    if (typeof value === 'string') return value
  }
  return undefined
}

/**
 * Reads a session's output into transcript items, line by line; whatever isn't transcript
 * (including non-JSON) gives none. It remembers the subagents a session starts: their tool calls
 * name them, and their end becomes one item with the first line of their report. Their own text,
 * results and changes stay out, so they don't drown the session's. One per run is enough, since
 * call ids are unique.
 */
export function transcriber(): (line: string) => TranscriptItem[] {
  /** The description of each subagent, by the id of the call that started it. */
  const agents = new Map<string, string>()
  return (line) => {
    const l = readStreamLine(line)
    const contents =
      typeof l?.message === 'object' && Array.isArray(l.message.content) ? l.message.content : []
    const parent = l?.parent_tool_use_id
    const agent = parent ? (agents.get(parent) ?? 'Subagent') : undefined
    const out: TranscriptItem[] = []
    for (const c of contents) {
      if (l?.type === 'assistant' && c.type === 'tool_use') {
        const name = c.name ?? '?'
        const argument = keyArgument(c.input) ?? ''
        if ((name === 'Agent' || name === 'Task') && c.id) agents.set(c.id, argument || name)
        out.push(agent ? { kind: 'tool', name, argument, agent } : { kind: 'tool', name, argument })
        continue
      }
      if (agent) continue
      if (l?.type === 'assistant' && c.type === 'text' && c.text?.trim()) {
        out.push({ kind: 'text', text: c.text })
      }
      if (l?.type === 'user' && c.type === 'tool_result') {
        const text =
          typeof c.content === 'string'
            ? c.content
            : (c.content ?? []).map((x) => x.text ?? '').join(' ')
        const done = c.tool_use_id ? agents.get(c.tool_use_id) : undefined
        if (done) {
          const status = l.tool_use_result?.status
          const error = c.is_error === true || (status !== undefined && status !== 'completed')
          out.push({ kind: 'agent-done', agent: done, report: firstReportLine(text), error })
          continue
        }
        const change = diffItem(l.tool_use_result)
        if (change) {
          out.push(change)
          continue
        }
        out.push({ kind: 'result', text, error: c.is_error === true })
      }
    }
    return out
  }
}

/**
 * The first line of a subagent's report, without the frame Claude Code puts around it.
 * shortcut: relies on the undocumented wording "The report follows:"; if it changes, the line
 * shows the frame's text instead, so update the marker when that shows up.
 */
function firstReportLine(text: string): string {
  const report = text.split('The report follows:').at(-1) ?? ''
  const lines = report.replace(
    /<tools-used-before-summary>[\s\S]*?<\/tools-used-before-summary>/g,
    '',
  )
  return (
    lines
      .split('\n')
      .map((l) => l.trim())
      .find(Boolean) ?? ''
  )
}

/** The change a tool result reports: its patch, for a new file the whole content as added. */
function diffItem(result: StreamLine['tool_use_result']): TranscriptItem | undefined {
  let hunks: Hunk[] = Array.isArray(result?.structuredPatch) ? result.structuredPatch : []
  if (hunks.length === 0 && result?.type === 'create' && typeof result.content === 'string') {
    const lines = result.content
      .replace(/\n$/, '')
      .split('\n')
      .map((x) => `+${x}`)
    hunks = [{ oldStart: 1, newStart: 1, lines }]
  }
  return hunks.length > 0 ? { kind: 'diff', file: result?.filePath ?? '', hunks } : undefined
}

/**
 * The installed skills and plugins, as the `init` event of `/usage` reports
 * them. `claude` runs the `claude` CLI with the given arguments and returns its stdout.
 */
export function installedSkills(claude: (args: string[]) => string): {
  skills: string[]
  plugins: Plugin[]
} {
  let init: StreamLine = {}
  for (const line of claude(USAGE).split('\n')) {
    const l = readStreamLine(line)
    if (l?.type === 'system' && l.subtype === 'init') init = l
  }
  return { skills: init.skills ?? [], plugins: init.plugins ?? [] }
}

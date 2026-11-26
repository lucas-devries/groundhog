import type { Ticket } from './tracker.ts'

export interface SessionRequest {
  ticket: Ticket
  /** The run's worktree, checked out on the ticket branch. */
  directory: string
  /** SHA where the ticket branch forks off. */
  forkPoint: string
  /** From the second attempt on: why the last one was red, with the check output. */
  feedback?: string
  /** Aborts when the session's time limit is reached; the adapter then ends the session. */
  signal: AbortSignal
  /**
   * Takes every line of the session's raw output (for Claude: `stream-json`) and returns it
   * filtered. The adapter only evaluates the filtered line, for example for the blocks.
   */
  output: (line: string) => string
}

export interface SessionResult {
  success: boolean
  /**
   * Aborted at the usage limit: the reset time in ms, or `'credit'` if, without a reset time, it
   * only goes on with credit.
   */
  usageLimit?: number | 'credit'
  /** Tokens of the session, as `claude` reports them (`usage`). */
  tokens?: Record<string, number>
  costUsd?: number
  /** For `claude --resume <sessionId>` in summary and comment. */
  sessionId?: string
  /** The available skills, as the session reports them (`init` event of `claude`). */
  skills?: string[]
  /** Calls that were refused in the session. */
  blocks?: Block[]
}

/** A refused call: tool, its most important argument and, if reported, the reason. */
export interface Block {
  tool: string
  command: string
  reason?: string
}

/** The agent: starts a session on a ticket. Behind it: Claude adapter (#33), fake agent. */
export interface Agent {
  runSession(request: SessionRequest): Promise<SessionResult>
  /** Reset time in ms of the latest window still exhausted; `undefined` if none is exhausted. */
  exhaustedUntil(): Promise<number | undefined>
}

/** A step in the fake agent's script: what a session does and how it ends. */
export type AgentScript = (request: SessionRequest) => SessionResult | Promise<SessionResult>

/** Scripted fake agent: each session plays the next step of the script. */
export function fakeAgent(
  script: AgentScript[],
  exhaustedUntil: () => number | undefined = () => undefined,
): Agent {
  let sessions = 0
  return {
    async runSession(request) {
      const step = script[sessions++]
      if (!step) throw new Error(`Fake agent: no script for session ${sessions}`)
      return step(request)
    },
    exhaustedUntil: async () => exhaustedUntil(),
  }
}

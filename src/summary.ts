import { hostname } from 'node:os'
import type { Block } from './agent.ts'
import { type Event, FINISH, integrationBranch } from './engine.ts'
import type { Ticket } from './tracker.ts'

/** The summary of a run as Markdown, from the engine's events alone. */
export function summary(events: Event[]): string {
  const tickets = new Map<number, TicketHistory>()
  let graph: Ticket[] = []
  let started: Extract<Event, { type: 'run-started' }> | undefined
  let finished: Extract<Event, { type: 'run-finished' }> | undefined
  const history = (nr: number) => {
    const t = tickets.get(nr) ?? {
      result: 'interrupted',
      start: 0,
      attempt: 0,
      of: 0,
      pauses: 0,
      paused: false,
      blocks: [],
    }
    tickets.set(nr, t)
    return t
  }

  for (const e of events) {
    switch (e.type) {
      case 'run-started':
        started = e
        break
      case 'run-finished':
        finished = e
        break
      case 'task-graph':
        graph = e.tickets
        break
      case 'ticket-taken':
        history(e.ticket).start = e.time
        break
      case 'attempt-started':
        Object.assign(history(e.ticket), { attempt: e.attempt, of: e.of })
        break
      case 'session-finished': {
        const t = history(e.ticket)
        t.blocks.push(...(e.blocks ?? []))
        t.sessionId = e.sessionId
        t.paused = false
        break
      }
      case 'pause': {
        // After the reset the engine may keep waiting; that stays the same pause.
        const t = history(e.ticket)
        if (!t.paused) t.pauses++
        t.paused = true
        break
      }
      case 'ticket-done':
        Object.assign(history(e.ticket), {
          result: 'done',
          end: e.time,
          extra: `Commit ${e.commit}`,
        })
        break
      case 'ticket-failed': {
        const t = history(e.ticket)
        const command = started && resumeCommand(started.worktree, t.sessionId)
        const resume = command ? ` · \`${command}\`` : ''
        Object.assign(t, {
          result: 'failed',
          end: e.time,
          extra: `red: ${e.verification}${resume}`,
        })
        break
      }
    }
  }

  const head: string[] = []
  if (started) {
    head.push(`# Summary of spec #${started.spec}`, '', `- Start: ${pointInTime(started.time)}`)
  }
  if (started && finished) {
    const f = finished.finish
    const integration = `Integration branch ${integrationBranch(started.spec)}`
    const what =
      f.type === 'merged'
        ? `merged, merge commit ${f.commit}`
        : f.type === 'conflict'
          ? `conflict, ${integration} stays`
          : f.type === 'pr'
            ? f.url
            : f.type === 'none'
              ? integration
              : `nothing, because ${f.reason}`
    head.push(
      `- End: ${pointInTime(finished.time)}`,
      `- Duration: ${duration(finished.time - started.time)}`,
      `- Target branch: ${started.choice.targetBranch}`,
      `- Finish: ${FINISH[started.choice.finish]} → ${what}`,
    )
  }
  if (started) {
    const versions = Object.entries(started.versions).map(([name, v]) => `${name} ${v}`)
    head.push(`- Versions: ${versions.join(', ') || '–'}`)
  }

  const numbers = [...new Set([...graph.map((t) => t.number), ...tickets.keys()])].sort(
    (a, b) => a - b,
  )
  const lines = numbers.map((nr) => {
    const t = tickets.get(nr)
    if (t) {
      const end = t.end ?? finished?.time ?? t.start
      const line = [
        `- #${nr} ${t.result}`,
        `Attempts ${t.attempt} of ${t.of}`,
        `Pauses ${t.pauses}`,
        `Duration ${duration(end - t.start)}`,
        `Blocks ${t.blocks.length}`,
        ...(t.extra ? [t.extra] : []),
      ].join(' · ')
      return [line, ...t.blocks.map((b) => `  - ${b.tool}: \`${b.command}\``)].join('\n')
    }
    const g = graph.find((g) => g.number === nr)
    const openBlockers = g?.blockers.filter((b) => b.open) ?? []
    if (g && !g.open) return `- #${nr} not touched, already closed`
    if (openBlockers.length > 0) {
      return `- #${nr} blocked by ${openBlockers.map((b) => `#${b.number}`).join(', ')}`
    }
    return `- #${nr} not touched`
  })

  return [...head, '', '## Tickets', '', ...lines].join('\n')
}

interface TicketHistory {
  /** Without an end event of the ticket, the run ended in the middle of it. */
  result: 'done' | 'failed' | 'interrupted'
  start: number
  end?: number
  attempt: number
  /** Maximum number of attempts. */
  of: number
  pauses: number
  paused: boolean
  blocks: Block[]
  sessionId?: string
  /** Commit or red verification. */
  extra?: string
}

/** YYYY-MM-DD HH:MM:SS in local time. */
function pointInTime(ms: number): string {
  return new Date(ms).toLocaleString('sv-SE')
}

function duration(ms: number): string {
  const s = Math.round(ms / 1000)
  const parts = [
    [Math.floor(s / 3600), 'h'],
    [Math.floor((s % 3600) / 60), 'min'],
    [s % 60, 's'],
  ] as const
  return (
    parts
      .filter(([n]) => n > 0)
      .map(([n, u]) => `${n} ${u}`)
      .join(' ') || '0 s'
  )
}

/** The one comment on a ticket that failed for good. */
export function failedComment(t: {
  /** The red verification of each attempt. */
  reds: string[]
  /** Maximum number of attempts per ticket. */
  maxAttempts: number
  /** Check output of the last attempt, already truncated; missing if no check was red. */
  output?: string
  blocks: number
  worktree: string
  sessionId?: string
  logDir?: string
}): string {
  const parts = [
    'Failed for good, now `ready-for-human`.',
    t.reds.map((v, i) => `- Attempt ${i + 1} of ${t.maxAttempts} red: ${v}`).join('\n'),
  ]
  if (t.output !== undefined) {
    const fence = '`'.repeat(Math.max(3, ...(t.output.match(/`+/g) ?? []).map((f) => f.length + 1)))
    parts.push('Check output of the last attempt:', `${fence}\n${t.output}\n${fence}`)
  }
  const command = resumeCommand(t.worktree, t.sessionId)
  parts.push(`Blocks: ${t.blocks}`, resumeInfo(t.logDir, command))
  return parts.join('\n\n')
}

/** Where to pick it up: session, machine and log. Only in comments and the output. */
export function resumeInfo(logDir?: string, command?: string): string {
  return [
    command && `- Session: \`${command}\``,
    `- Machine: ${hostname()}`,
    logDir && `- Log: \`${logDir}\``,
  ]
    .filter(Boolean)
    .join('\n')
}

/** Claude Code stores sessions per directory, so resuming starts with a `cd` into the worktree. */
function resumeCommand(worktree: string, sessionId?: string): string | undefined {
  if (!sessionId) return undefined
  // Quoted only if the shell could split or expand the path.
  const path = /^[\w./-]+$/.test(worktree) ? worktree : `'${worktree.replaceAll("'", `'\\''`)}'`
  return `cd ${path} && claude --resume ${sessionId}`
}

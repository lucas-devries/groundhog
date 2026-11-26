import { hostname } from 'node:os'
import { FINISH } from './choice.ts'
import type { RunState, TicketState } from './run-state.ts'

/** The summary of a run as Markdown, from the state of the run alone. */
export function summary({ started, finished, graph, integration, tickets }: RunState): string {
  const head: string[] = []
  if (started) {
    head.push(`# Summary of spec #${started.spec}`, '', `- Start: ${pointInTime(started.time)}`)
  }
  if (started && finished) {
    const f = finished.finish
    const branch = `Integration branch ${integration}`
    const what =
      f.type === 'merged'
        ? `merged, merge commit ${f.commit}`
        : f.type === 'conflict'
          ? `conflict, ${branch} stays`
          : f.type === 'pr'
            ? f.url
            : f.type === 'none'
              ? branch
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
      // Without an end event of the ticket, the run ended in the middle of it.
      const result = t.status === 'done' || t.status === 'failed' ? t.status : 'interrupted'
      const extra = outcome(t, started?.worktree)
      const line = [
        `- #${nr} ${result}`,
        `Attempts ${t.attempt} of ${t.of}`,
        `Pauses ${t.pauses}`,
        `Duration ${duration(end - t.start)}`,
        `Blocks ${t.blocks.length}`,
        ...(extra ? [extra] : []),
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

/** Commit or red verification, the latter with the way to resume its last session. */
function outcome(t: TicketState, worktree?: string): string | undefined {
  if (t.status === 'done') return `Commit ${t.commit}`
  if (t.status !== 'failed') return undefined
  const command = worktree && resumeCommand(worktree, t.sessionId)
  return `red: ${t.verification}${command ? ` · \`${command}\`` : ''}`
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

/** Truncates an output from the start to the last 100 lines and 50 000 characters. */
export function truncateFromStart(output: string, mark = 'truncated'): string {
  const lines = output.trimEnd().split('\n')
  let truncated = lines.slice(-100).join('\n').slice(-50_000)
  if (truncated.length < output.trimEnd().length) truncated = `[${mark}]\n${truncated}`
  return truncated
}

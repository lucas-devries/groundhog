import { stripVTControlCharacters } from 'node:util'
import { display, style, timeOfDay } from './display.ts'
import type { Event, GraphTicket } from './engine.ts'

export interface BoardOptions {
  color?: boolean
  /** Folder of the log, for the closing lines. */
  logDir?: string
}

/** How many transcript lines the board keeps at most; more fit in no window. */
const TRANSCRIPT_MAX = 1000

/**
 * The board: a fixed screen of header, task-graph, warnings, the transcript of the current
 * session and a footer. `report` takes every event of the run in order and returns the lines the
 * continuous output would write for it (for the closing lines).
 */
export function board(options: BoardOptions = {}) {
  const s = style(options.color ?? false)
  // Untruncated; truncation happens only when drawing, to the width the window has right now.
  const lines = display({ ...options, width: Number.POSITIVE_INFINITY })
  let header = ''
  let tickets: GraphTicket[] = []
  /** State of the tickets this run has touched; the others show the tracker. */
  const state = new Map<number, string>()
  const warnings: string[] = []
  let transcript: string[] = []
  let footer = ''
  /** ` · Attempt n of m` from the second attempt on; the first is just running. */
  let attempt = ''
  let failed = ''
  let session: number | undefined

  const report = (e: Event): string[] => {
    const added = lines(e)
    switch (e.type) {
      case 'run-started':
        header = added[0] ?? ''
        break
      case 'task-graph':
        tickets = e.tickets
        break
      case 'attempt-started':
        attempt = e.attempt > 1 ? ` · Attempt ${e.attempt} of ${e.of}` : ''
        failed = `Attempt ${e.attempt} of ${e.of} failed`
        state.set(e.ticket, s.cyan(`▶ running${attempt}`))
        footer = `#${e.ticket}${attempt}`
        transcript = []
        break
      case 'session-output':
        // A new session, also the restart after a pause: only its transcript counts.
        if (e.session !== session) {
          session = e.session
          transcript = []
          state.set(e.ticket, s.cyan(`▶ running${attempt}`))
        }
        transcript.push(...added)
        if (transcript.length > 2 * TRANSCRIPT_MAX) transcript = transcript.slice(-TRANSCRIPT_MAX)
        break
      case 'verification':
        if (!e.ok) state.set(e.ticket, s.yellow(`↻ ${failed}`))
        transcript.push(...added)
        break
      case 'pause':
        state.set(e.ticket, s.yellow(`⏸ Pause at usage limit until ${timeOfDay(e.reset, e.time)}`))
        transcript.push(...added)
        break
      case 'session-finished':
      case 'run-halted':
        transcript.push(...added)
        break
      case 'ticket-done':
        state.set(e.ticket, s.green(e.attempts > 1 ? `✔ done in attempt ${e.attempts}` : '✔ done'))
        break
      case 'ticket-failed':
        state.set(e.ticket, s.red(`✘ ready-for-human · ${e.verification}`))
        break
      case 'warning':
        warnings.push(...added)
        break
    }
    return added
  }

  /** Exactly `height` lines, none wider than `width`. */
  const screen = (width: number, height: number): string[] => {
    const rule = s.dim('─'.repeat(width))
    const top = [
      header,
      '',
      ...tickets.map((t) => `  #${t.number} ${state.get(t.number) ?? before(t, s)}`),
      ...warnings,
      rule,
    ].slice(0, Math.max(0, height - 2))
    const room = Math.max(0, height - 2 - top.length)
    const middle = room > 0 ? transcript.slice(-room) : []
    while (middle.length < room) middle.push('')
    return [...top, ...middle, rule, footer].map((l) => truncate(l, width))
  }

  return { report, screen }
}

/** State of a ticket this run has not touched (yet), as the engine reports it. */
function before(t: GraphTicket, s: ReturnType<typeof style>): string {
  switch (t.state) {
    case 'closed':
      return s.green('✔ done')
    case 'ready-for-human':
      return s.dim('– ready-for-human, not touched')
    case 'not released':
      return s.dim('– not released')
    case 'blocked': {
      const blockers = t.blockers.filter((b) => b.open).map((b) => `#${b.number}`)
      return s.dim(`○ blocked by ${blockers.join(', ')}`)
    }
    case 'taken':
    case 'workable':
      return s.dim('· waiting')
  }
}

/** Truncates to `width` visible characters without cutting a colour sequence. */
function truncate(line: string, width: number): string {
  const l = line.replace(/[\r\n]+/g, ' ').replace(/\t/g, '  ')
  if (stripVTControlCharacters(l).length <= width) return l
  let rest = width - 1
  let out = ''
  // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI colour sequences
  for (const part of l.split(/(\x1b\[[\d;]*m)/)) {
    if (part.startsWith('\x1b')) out += part
    else if (rest < 0) continue
    else if (part.length <= rest) {
      out += part
      rest -= part.length
    } else {
      out += `${part.slice(0, rest)}…`
      rest = -1
    }
  }
  return out
}

/**
 * Shows the board in the terminal `out` (alternate screen) and redraws it on every event and
 * every resize. At the end of the run it returns to the normal screen and writes the closing
 * lines there: summary, integration branch, finish.
 */
export function showBoard(out: NodeJS.WriteStream, logDir?: string) {
  const b = board({ color: true, logDir })
  let active = true
  const draw = () => {
    const lines = b.screen(out.columns || 100, out.rows || 30)
    if (active) out.write(`\x1b[H${lines.join('\x1b[K\n')}\x1b[K\x1b[J`)
  }
  /** Back to the normal screen; also before an error message, so it stays visible. */
  const close = () => {
    if (!active) return
    active = false
    out.off('resize', draw)
    out.write('\x1b[?7h\x1b[?25h\x1b[?1049l')
  }
  // Alternate screen, cursor off, no line wrap: whatever is too wide despite truncation
  // (double-width characters) the terminal cuts off instead of shifting the board.
  out.write('\x1b[?1049h\x1b[?25l\x1b[?7l')
  out.on('resize', draw)
  process.once('exit', close)
  const report = (e: Event) => {
    const lines = b.report(e)
    if (e.type !== 'run-finished') return draw()
    close()
    for (const l of lines) out.write(`${l}\n`)
  }
  return { report, close }
}

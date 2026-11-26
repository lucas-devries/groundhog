import { stripVTControlCharacters } from 'node:util'
import { display, style, timeOfDay } from './display.ts'
import type { Event, GraphTicket } from './engine.ts'

export interface BoardOptions {
  color?: boolean
  /** Folder of the log, for the closing lines. */
  logDir?: string
}

/** How many transcript lines the board keeps at most; the log keeps all of them. */
const TRANSCRIPT_MAX = 10_000

const CTRL_C = 0x03

/** Lines one notch of the mouse wheel moves by. */
const WHEEL_LINES = 3

/** Mouse reporting: button events (1002) in SGR encoding (1006). */
const MOUSE_ON = '\x1b[?1002h\x1b[?1006h'
const MOUSE_OFF = '\x1b[?1006l\x1b[?1002l'

/**
 * ↑ ↓ Home End as `ESC [` or `ESC O` (application cursor keys), PgUp PgDn and the other Home and
 * End as `ESC [ n ~`, a notch of the mouse wheel as `ESC [ < 64 or 65 ; x ; y M` (SGR).
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: terminal key and mouse sequences
const SCROLL_INPUT = /\x1b(?:[[O]([ABHF])|\[([145678])~|\[<(6[45]);\d+;\d+M)/g

/**
 * The board: a fixed screen of header, task-graph, warnings, the transcripts of the run's
 * sessions and a footer. `report` takes every event of the run in order and returns the lines the
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
  /** Tickets this run has finished. */
  const done = new Set<number>()
  const warnings: string[] = []
  const transcript: string[] = []
  /** Transcript line at the top while scrolled up; `undefined` follows the live end. */
  let anchor: number | undefined
  /** Lines appended since the transcript was scrolled up. */
  let unseen = 0
  /** Height of the transcript as `screen` drew it last. */
  let room = 0
  let footer = ''
  let attempt = ''
  const append = (added: string[]) => {
    transcript.push(...added)
    const dropped = transcript.splice(0, transcript.length - TRANSCRIPT_MAX).length
    if (anchor === undefined) return
    unseen += added.length
    // The anchor moves along with its line; once that is dropped, it stays at the oldest one.
    anchor = Math.max(0, anchor - dropped)
  }

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
        attempt = `Attempt ${e.attempt} of ${e.of}`
        state.set(e.ticket, s.cyan(`▶ running · ${attempt}`))
        footer = `#${e.ticket} · ${attempt}`
        append([s.bold(`━━ ${footer}`)])
        break
      case 'session-output':
        // Also ends a pause: the attempt restarted in a new session.
        state.set(e.ticket, s.cyan(`▶ running · ${attempt}`))
        append(added)
        break
      case 'verification':
        if (!e.ok) state.set(e.ticket, s.yellow(`↻ ${attempt} failed`))
        append(added)
        break
      case 'pause':
        state.set(e.ticket, s.yellow(`⏸ Pause at usage limit until ${timeOfDay(e.reset, e.time)}`))
        append(added)
        break
      case 'session-finished':
      case 'run-halted':
        append(added)
        break
      case 'ticket-done':
        done.add(e.ticket)
        state.set(e.ticket, s.green(`✔ done in attempt ${e.attempts}`))
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

  /** Top line of the transcript at the live end. */
  const liveTop = () => Math.max(0, transcript.length - room)

  /** Moves the transcript by `by` lines, negative upwards. */
  const scroll = (by: number) => {
    const live = liveTop()
    const to = Math.max(0, (anchor ?? live) + by)
    // The end is reached downwards, or in any direction once the whole transcript fits.
    const follow = to >= live && (by > 0 || live === 0)
    anchor = follow ? undefined : to
    if (follow) unseen = 0
  }

  /** Raw bytes as they arrive on stdin; only scrolls, `screen` shows the result. */
  const input = (data: Buffer | string) => {
    const page = Math.max(1, room - 1)
    /** Lines each key or wheel direction of `SCROLL_INPUT` moves by. */
    const moves: Record<string, number> = {
      A: -1, // ↑
      B: 1, // ↓
      5: -page, // PgUp
      6: page, // PgDn
      H: -Infinity, // Home, in three variants
      1: -Infinity,
      7: -Infinity,
      F: Infinity, // End, in three variants
      4: Infinity,
      8: Infinity,
      64: -WHEEL_LINES, // wheel up
      65: WHEEL_LINES, // wheel down
    }
    // ponytail: a sequence split across two chunks is dropped; buffer the tail if that shows.
    for (const [, letter, keyCode, wheel] of String(data).matchAll(SCROLL_INPUT)) {
      // Exactly one of the three groups matches, and only keys of `moves`.
      scroll(moves[(letter ?? keyCode ?? wheel) as string] as number)
    }
  }

  /**
   * The lines of the task-graph, in the tracker's order and at most `max`: done tickets are left
   * out first. Running, paused and failed tickets always stay, even beyond `max`.
   */
  const taskGraph = (max: number) => {
    const [mustStay, open, finished] = [0, 1, 2]
    /** The lower, the later a ticket is left out. */
    const rank = (t: GraphTicket) => {
      if (done.has(t.number)) return finished
      if (state.has(t.number)) return mustStay
      return t.state === 'closed' ? finished : open
    }
    const staying = tickets.filter((t) => rank(t) === mustStay).length
    // One line less than `max` for the line that sums up the others.
    const slots = tickets.length > max ? Math.max(staying, max - 1) : max
    const shown = new Set(tickets.toSorted((a, b) => rank(a) - rank(b)).slice(0, slots))
    const graph = tickets
      .filter((t) => shown.has(t))
      .map((t) => `  #${t.number} ${state.get(t.number) ?? before(t, s)}`)
    const more = tickets.length - shown.size
    if (more > 0) graph.push(`  … ${more} more ticket${more === 1 ? '' : 's'}`)
    return { graph, staying }
  }

  /** Exactly `height` lines, none wider than `width`. */
  const screen = (width: number, height: number): string[] => {
    const rule = s.dim('─'.repeat(width))
    const half = Math.floor(height / 2)
    const head = [header, '']
    const { graph, staying } = taskGraph(half - head.length - warnings.length)
    // Warnings give way to the cap; only tickets that must stay may exceed it.
    const limit = staying ? Math.max(half, head.length + graph.length) : half
    const top = [...[...head, ...graph, ...warnings].slice(0, limit), rule].slice(
      0,
      Math.max(0, height - 2),
    )
    room = Math.max(0, height - 2 - top.length)
    const from = anchor ?? liveTop()
    const middle = transcript.slice(from, from + room)
    while (middle.length < room) middle.push('')
    const hint =
      anchor === undefined ? '' : `↓ ${unseen} new line${unseen === 1 ? '' : 's'} · End to follow`
    const bottom = [footer, hint].filter(Boolean).join(' · ')
    return [...top, ...middle, rule, bottom].map((l) => truncate(l, width))
  }

  return { report, input, screen }
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
 * Shows the board in the terminal `out` (alternate screen) and redraws it on every event, every
 * input and every resize. Keys and the mouse wheel are read from `input` in raw mode, where Ctrl+C
 * sends no SIGINT: it goes to `interrupt` instead. At the end of the run it returns to the normal
 * screen and writes the closing lines there: summary, integration branch, finish.
 */
export function showBoard(
  out: NodeJS.WriteStream,
  input: NodeJS.ReadStream,
  interrupt: () => void,
  logDir?: string,
) {
  const b = board({ color: true, logDir })
  let active = true
  const draw = () => {
    const lines = b.screen(out.columns || 100, out.rows || 30)
    if (active) out.write(`\x1b[H${lines.join('\x1b[K\n')}\x1b[K\x1b[J`)
  }
  const read = (data: Buffer) => {
    b.input(data)
    draw()
    for (const byte of data) if (byte === CTRL_C) interrupt()
  }
  /** Back to the normal screen; also before an error message, so it stays visible. */
  const close = () => {
    if (!active) return
    active = false
    out.off('resize', draw)
    if (input.isTTY) {
      input.off('data', read)
      // Before raw mode ends, so that no mouse report gets echoed.
      out.write(MOUSE_OFF)
      input.setRawMode(false)
      // Otherwise reading stdin keeps the process alive.
      input.pause()
    }
    out.write('\x1b[?7h\x1b[?25h\x1b[?1049l')
  }
  // Alternate screen, cursor off, no line wrap: whatever is too wide despite truncation
  // (double-width characters) the terminal cuts off instead of shifting the board.
  out.write('\x1b[?1049h\x1b[?25l\x1b[?7l')
  out.on('resize', draw)
  process.once('exit', close)
  if (input.isTTY) {
    input.setRawMode(true)
    input.on('data', read)
    input.resume()
    out.write(MOUSE_ON)
  }
  const report = (e: Event) => {
    const lines = b.report(e)
    if (e.type !== 'run-finished') return draw()
    close()
    for (const l of lines) out.write(`${l}\n`)
  }
  return { report, close }
}

import { hostname } from 'node:os'
import { extname, join } from 'node:path'
import { stripVTControlCharacters } from 'node:util'
import { common, createEmphasize } from 'emphasize'
import type { Hunk } from './agent.ts'
import { FINISH } from './choice.ts'
import { transcriptItems } from './claude.ts'
import { type Event, fold, newRunState } from './run-state.ts'
import { truncateFromStart } from './summary.ts'

export interface DisplayOptions {
  /** ANSI colours; off without a terminal. */
  color?: boolean
  /** Columns a line is truncated to. */
  width?: number
  /** Folder of the log; the last line names the summary in it. */
  logDir?: string
  /** Where the run stands in its batch; the header shows it in a batch of more than one. */
  position?: Position
}

/** The place of a run in its batch, counted from 1. */
export interface Position {
  index: number
  total: number
}

/**
 * The display of a run: turns every event of the engine into the lines that appear for it.
 * Without a terminal they are written continuously; the board arranges them itself.
 */
export function display(options: DisplayOptions = {}): (e: Event) => string[] {
  const { width = 100 } = options
  const s = style(options.color ?? false)
  /** Truncates to `n` characters; unless `keepSpace`, as one line with single spaces. */
  const short = (t: string, n: number, keepSpace = false) => {
    const plain = stripVTControlCharacters(t)
    const l = keepSpace ? plain : plain.replace(/\s+/g, ' ').trim()
    return l.length > n ? `${l.slice(0, n - 1)}…` : l
  }

  const state = newRunState()

  return (e) => {
    fold(state, e)
    switch (e.type) {
      case 'session-output':
        return transcriptItems(e.line).flatMap((t) => {
          if (t.kind === 'text')
            return t.text
              .split('\n')
              .filter((l) => l.trim())
              .map((l) => `  │ ${short(l, width - 4)}`)
          if (t.kind === 'tool') {
            const argument = short(t.argument, width - 8 - t.name.length)
            return [`  │ ${s.cyan('⏺')} ${s.bold(t.name)} ${s.dim(argument)}`]
          }
          if (t.kind === 'result') {
            return [`  │   ${(t.error ? s.red : s.dim)(`⎿ ${short(t.text, width - 8)}`)}`]
          }
          return diff(t, width - 6, s).map((l) => `  │   ${l}`)
        })
      case 'run-started': {
        const version = e.versions.groundhog ? ` ${e.versions.groundhog}` : ''
        const finish = FINISH[e.choice.finish]
        const { position } = options
        const place = position && position.total > 1 ? ` (${position.index}/${position.total})` : ''
        return [
          s.dim(
            `groundhog${version} · Spec #${e.spec}${place} · target branch ${e.choice.targetBranch} · finish ${finish}`,
          ),
        ]
      }
      case 'ticket-taken':
        return ['', s.bold(`━━ #${e.ticket} taken`)]
      case 'attempt-started':
        return [`  ${s.cyan('▶')} ${e.attempt > 1 ? `Attempt ${e.attempt} of ${e.of}` : 'Running'}`]
      case 'session-finished':
        // The reason of a block is only in the log.
        return (e.blocks ?? []).map((b) =>
          s.yellow(`  ⛔ Block: ${short(`${b.tool} ${b.command}`, width - 11)}`),
        )
      case 'verification':
        return [`  ${e.ok ? s.green('✔') : s.red('✘')} ${e.name}`]
      case 'pause':
        return [s.yellow(`  ⏸ Usage limit reached, pause until ${timeOfDay(e.reset, e.time)}`)]
      case 'push':
        return [s.dim(`  ↑ ${e.branch} pushed: ${e.commit.slice(0, 7)}`)]
      case 'ticket-done':
        return [
          `${s.green('✔')} ${s.bold(`#${e.ticket} done`)}${e.attempts > 1 ? ` in attempt ${e.attempts}` : ''} · commit ${e.commit.slice(0, 7)}`,
        ]
      case 'ticket-failed':
        return [
          `${s.red('✘')} ${s.bold(`#${e.ticket} failed for good`)} after ${e.attempts} attempts (red: ${e.verification}) → ready-for-human`,
        ]
      case 'warning':
        return [s.yellow(`⚠ ${e.text}`)]
      case 'run-halted':
        if (e.reason === 'setup') {
          return [
            `  ${s.red('✘')} Setup: ${e.command}`,
            ...truncateFromStart(stripVTControlCharacters(e.output).replace(/\r/g, ''))
              .split('\n')
              .map((l) => `  │ ${short(l, width - 4, true)}`),
            s.red('■ Run halted: setup failed, no ticket was taken'),
          ]
        }
        return [
          s.red(
            `■ Run halted at #${e.ticket}: usage limit without reset time, continues only with credit`,
          ),
        ]
      case 'run-finished': {
        const { started, integration, head } = state
        const integrated = [...state.tickets.values()].filter((t) => t.status === 'done').length
        const spec = started?.spec
        const target = started?.choice.targetBranch
        const choice = `Finish ${started ? FINISH[started.choice.finish] : ''}`
        const f = e.finish
        const finish =
          f.type === 'merged'
            ? `${choice}: ${integration} merged into ${target}, merge commit ${f.commit.slice(0, 7)}, spec #${spec} closed`
            : f.type === 'conflict'
              ? `${choice}: conflict with ${target}, ${integration} stays`
              : f.type === 'pr'
                ? `${choice}: ${f.url}`
                : f.type === 'none'
                  ? `${choice}: ${integration} stays`
                  : `${choice} skipped because ${SKIPPED[f.reason]}. Next run: groundhog ${spec}`
        const tickets =
          integrated === 0
            ? 'no tickets integrated'
            : `${integrated} ticket${integrated === 1 ? '' : 's'} integrated, head ${head?.slice(0, 7)}`
        const { logDir } = options
        return [
          '',
          ...e.summary.split('\n'),
          '',
          `Integration branch ${integration}: ${tickets}`,
          f.type === 'conflict' ? s.red(finish) : finish,
          s.dim(`Machine: ${hostname()}${logDir ? ` · Log: ${logDir}` : ''}`),
          ...(logDir ? [`Summary: ${join(logDir, 'summary.md')}`] : []),
        ]
      }
      default:
        return []
    }
  }
}

/** Why the finish was skipped. */
const SKIPPED = {
  'tickets open': 'tickets are open',
  'setup failed': 'setup failed',
  aborted: 'the run was aborted',
}

/** HH:MM in local time; if `ms` is on another day than `now`, with the date in front. */
export function timeOfDay(ms: number, now: number): string {
  const d = new Date(ms)
  const time = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
  if (d.toDateString() === new Date(now).toDateString()) return time
  return `${d.toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit' })} ${time}`
}

type Style = ReturnType<typeof style>
const syntaxColors = createEmphasize(common)

export function style(color: boolean) {
  const ansi = (code: number) => (t: string) => (color ? `\x1b[${code}m${t}\x1b[0m` : t)
  return {
    bold: ansi(1),
    dim: ansi(2),
    red: ansi(31),
    green: ansi(32),
    yellow: ansi(33),
    cyan: ansi(36),
    /** Syntax colours by the file's extension. */
    code: (file: string, t: string) => {
      const language = extname(file).slice(1)
      return color && language && syntaxColors.registered(language)
        ? syntaxColors.highlight(language, t).value
        : t
    },
  }
}

const DIFF_MAX = 12

/** A diff as in the Claude Code window: summary, line numbers, `+`/`-`. */
// ponytail: each line is coloured on its own, so multi-line strings and comments come out wrong;
// for exact colours, colour the whole file.
function diff(d: { file: string; hunks: Hunk[] }, width: number, s: Style): string[] {
  const all = d.hunks.flatMap((h) => h.lines)
  const count = (c: string) => all.filter((l) => l[0] === c).length
  const plus = count('+')
  const lines: string[] = []
  for (const h of d.hunks) {
    let oldNr = h.oldStart
    let newNr = h.newStart
    for (const l of h.lines) {
      const code = stripVTControlCharacters(l.slice(1))
        .replace(/\r/g, '')
        .slice(0, width - 9)
      const nr = (n: number) => String(n).padStart(4)
      if (l[0] === '+') lines.push(`${s.green(`${nr(newNr++)} +`)} ${s.code(d.file, code)}`)
      else if (l[0] === '-') lines.push(`${s.red(`${nr(oldNr++)} -`)} ${s.dim(code)}`)
      else {
        lines.push(`${s.dim(`${nr(newNr++)}  `)} ${s.code(d.file, code)}`)
        oldNr++
      }
    }
  }
  return [
    s.dim(`⎿ ${plus} line${plus === 1 ? '' : 's'} added, ${count('-')} removed`),
    ...lines.slice(0, DIFF_MAX).map((l) => `  ${l}`),
    ...(lines.length > DIFF_MAX ? [s.dim(`       … ${lines.length - DIFF_MAX} more lines`)] : []),
  ]
}

import { type Event, fold, newRunState } from './run-state.ts'

/** Runs the `herdr` CLI. */
export type Exec = (
  file: string,
  args: string[],
  options: { stdio: 'ignore'; timeout: number },
) => unknown

/**
 * Reports groundhog to Herdr as agent `groundhog`, in two ways: to a Herdr pane (herdr.dev)
 * through the `herdr` CLI, so the pane shows up in its agent list, and to hc (herdr-core) through
 * OSC 7501 on stdout. Create it before the start asks its questions: hc then hears `blocked`, so
 * groundhog shows up as an agent waiting for the human from the first moment, not only from the
 * first ticket on. One reporter per process, fed with all events of its runs in order.
 */
export function herdrReporter({
  env,
  isTerminal,
  write,
  exec,
}: {
  env: {
    HERDR_ENV?: string
    HERDR_PANE_ID?: string
    HERDR_BIN_PATH?: string
    HC_TERMINAL_ID?: string
  }
  /** stdout is a terminal. */
  isTerminal: boolean
  /** Writes to stdout. */
  write: (text: string) => void
  /** Must be synchronous, so that `release` also works while the process exits. */
  exec: Exec
}): {
  report: (e: Event) => void
  /**
   * At the end of the process: frees the pane again, if groundhog ever reported to it, and turns a
   * report to hc that still says working or blocked into idle. hc keeps a report until the
   * terminal closes, not until groundhog exits. A done or error from the end of the run stays.
   */
  release: () => void
} {
  const pane = env.HERDR_ENV === '1' ? env.HERDR_PANE_ID : undefined
  const hc = Boolean(env.HC_TERMINAL_ID) && isTerminal
  // Herdr orders reports per source by seq; time-based so a later run in the same pane wins.
  let seq = Date.now() * 1000
  let reported = false
  let state = newRunState()
  /** The last status sent to hc. */
  let last = ''

  const call = (pane: string, command: string, ...rest: string[]) => {
    seq += 1
    const id = ['--source', 'custom:groundhog', '--agent', 'groundhog']
    const args = ['pane', command, pane, ...id, ...rest, '--seq', String(seq)]
    // Herdr being gone must not stop the run: the result of the call does not matter.
    exec(env.HERDR_BIN_PATH || 'herdr', args, { stdio: 'ignore', timeout: 2000 })
  }
  /** `ESC ]7501;key=value:key=value BEL`, `msg` in Base64. */
  const osc = (status: string, msg: string, progress: number) => {
    if (!hc) return
    last = status
    const b64 = Buffer.from(msg).toString('base64')
    write(`\x1b]7501;state=${status}:app=groundhog:msg=${b64}:progress=${progress}\x07`)
  }
  const working = (message: string, progress: number) => {
    osc('working', message, progress)
    if (!pane) return
    reported = true
    call(pane, 'report-agent', '--state', 'working', '--message', message)
  }

  osc('blocked', 'Start', 0)
  return {
    report: (e) => {
      // Every run of a batch has its own tickets and progress.
      if (e.type === 'run-started') state = newRunState()
      const { started, progress, tickets } = fold(state, e)
      const spec = `Spec #${started?.spec ?? 0}`
      if (e.type === 'run-started') working(spec, progress)
      if (e.type === 'ticket-taken') working(`Ticket #${e.ticket}`, progress)
      if (e.type !== 'run-finished') return
      if (e.finish.type === 'skipped' && e.finish.reason === 'aborted') {
        return osc('idle', `${spec} aborted`, progress)
      }
      const failed = [...tickets.values()].some((t) => t.status === 'failed')
      osc(failed ? 'error' : 'done', spec, progress)
    },
    release: () => {
      if (pane && reported) call(pane, 'release-agent')
      if (last === 'working' || last === 'blocked') osc('idle', 'Stopped', 0)
    },
  }
}

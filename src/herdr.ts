import type { Event } from './engine.ts'

/**
 * Reports the run to Herdr (herdr.dev) as agent `groundhog`, so the pane shows up in its agent
 * list. Returns for each event the arguments for the `herdr` CLI, or nothing; `release` gives
 * the arguments that free the pane again at the end of the process, or nothing if groundhog
 * never reported. One object per process, fed with all events of its runs in order.
 */
export function herdrAgent(env: { HERDR_ENV?: string; HERDR_PANE_ID?: string }): {
  report: (e: Event) => string[] | undefined
  release: () => string[] | undefined
} {
  const pane = env.HERDR_ENV === '1' ? env.HERDR_PANE_ID : undefined
  // Herdr orders reports per source by seq; time-based so a later run in the same pane wins.
  let seq = Date.now() * 1000
  let reported = false
  const id = ['--source', 'custom:groundhog', '--agent', 'groundhog']
  const call = (pane: string, command: string, ...rest: string[]) => {
    seq += 1
    return ['pane', command, pane, ...id, ...rest, '--seq', String(seq)]
  }
  const working = (pane: string, message: string) => {
    reported = true
    return call(pane, 'report-agent', '--state', 'working', '--message', message)
  }
  return {
    report: (e) => {
      if (!pane) return undefined
      if (e.type === 'run-started') return working(pane, `Spec #${e.spec}`)
      if (e.type === 'ticket-taken') return working(pane, `Ticket #${e.ticket}`)
      return undefined
    },
    release: () => (pane && reported ? call(pane, 'release-agent') : undefined),
  }
}

/**
 * Reports the run to hc (herdr-core) via OSC 7501 as agent `groundhog`. Returns for each event
 * the sequence that belongs on stdout, or nothing. One function per run, fed with all events in
 * order.
 */
export function herdr(
  env: { HC_TERMINAL_ID?: string },
  isTerminal: boolean,
): (e: Event) => string | undefined {
  if (!env.HC_TERMINAL_ID || !isTerminal) return () => undefined
  let spec = 0
  let progress = 0
  let failed = false
  return (e) => {
    if (e.type === 'run-started') spec = e.spec
    if (e.type === 'ticket-failed') failed = true
    if (e.type === 'task-graph') {
      const closed = e.tickets.filter((t) => !t.open).length
      progress = e.tickets.length ? Math.round((closed / e.tickets.length) * 100) : 100
    }
    if (e.type === 'ticket-taken') return osc('working', `Ticket #${e.ticket}`, progress)
    if (e.type === 'run-finished') return osc(failed ? 'error' : 'done', `Spec #${spec}`, progress)
    return undefined
  }
}

/** `ESC ]7501;key=value:key=value BEL`, `msg` in Base64. */
function osc(state: string, msg: string, progress: number): string {
  const b64 = Buffer.from(msg).toString('base64')
  return `\x1b]7501;state=${state}:app=groundhog:msg=${b64}:progress=${progress}\x07`
}

import type { Event } from './engine.ts'

/**
 * Reports the run to Herdr via OSC 7501 as agent `groundhog`. Returns for each event the
 * sequence that belongs on stdout, or nothing. One function per run, fed with all events in
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

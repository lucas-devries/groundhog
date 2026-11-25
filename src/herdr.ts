import type { Ereignis } from './engine.ts'

/**
 * Meldet den Lauf per OSC 7501 als Agent `groundhog` an Herdr. Liefert zu jedem Ereignis die
 * Sequenz, die auf stdout gehört, oder nichts. Eine Funktion pro Lauf, mit allen Ereignissen in
 * Reihenfolge füttern.
 */
export function herdr(
  umgebung: { HC_TERMINAL_ID?: string },
  istTerminal: boolean,
): (e: Ereignis) => string | undefined {
  if (!umgebung.HC_TERMINAL_ID || !istTerminal) return () => undefined
  let spec = 0
  let progress = 0
  let gescheitert = false
  return (e) => {
    if (e.art === 'lauf-begonnen') spec = e.spec
    if (e.art === 'ticket-gescheitert') gescheitert = true
    if (e.art === 'task-graph') {
      const zu = e.tickets.filter((t) => !t.offen).length
      progress = e.tickets.length ? Math.round((zu / e.tickets.length) * 100) : 100
    }
    if (e.art === 'ticket-genommen') return osc('working', `Ticket #${e.ticket}`, progress)
    if (e.art === 'lauf-beendet')
      return osc(gescheitert ? 'error' : 'done', `Spec #${spec}`, progress)
    return undefined
  }
}

/** `ESC ]7501;key=value:key=value BEL`, `msg` in Base64. */
function osc(state: string, msg: string, progress: number): string {
  const b64 = Buffer.from(msg).toString('base64')
  return `\x1b]7501;state=${state}:app=groundhog:msg=${b64}:progress=${progress}\x07`
}

import type { Clock } from './clock.ts'

/** Grace period for the second Ctrl+C. */
const GRACE = 5_000
export const NOTE = 'Press Ctrl+C again to abort'

/**
 * Decides on the process's signals: the first Ctrl+C only shows the note, only a second one
 * within the grace period aborts. SIGTERM and SIGHUP abort at once. Any signal after the abort,
 * that is during cleanup, ends hard.
 */
export function abortGuard(options: {
  clock: Clock
  note: (text: string) => void
  hard: () => void
}): { signal: AbortSignal; receive: (signal: NodeJS.Signals) => void } {
  const { clock, note, hard } = options
  const ac = new AbortController()
  let first: number | undefined
  return {
    signal: ac.signal,
    receive: (signal) => {
      if (ac.signal.aborted) return hard()
      if (signal === 'SIGINT' && (first === undefined || clock.now() - first > GRACE)) {
        first = clock.now()
        return note(NOTE)
      }
      ac.abort()
    },
  }
}

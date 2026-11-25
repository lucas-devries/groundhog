import type { Uhr } from './clock.ts'

/** Frist für das zweite Strg+C. */
const FRIST = 5_000
export const HINWEIS = 'Nochmal Strg+C zum Abbrechen'

/**
 * Entscheidet über Signale des Prozesses: Das erste Strg+C zeigt nur den Hinweis, erst ein zweites
 * innerhalb der Frist bricht ab. SIGTERM und SIGHUP brechen sofort ab. Jedes Signal nach dem
 * Abbruch, also während des Aufräumens, beendet hart.
 */
export function abbruchWaechter(optionen: {
  uhr: Uhr
  hinweis: (text: string) => void
  hart: () => void
}): { signal: AbortSignal; empfange: (signal: NodeJS.Signals) => void } {
  const { uhr, hinweis, hart } = optionen
  const ac = new AbortController()
  let erstes: number | undefined
  return {
    signal: ac.signal,
    empfange: (signal) => {
      if (ac.signal.aborted) return hart()
      if (signal === 'SIGINT' && (erstes === undefined || uhr.jetzt() - erstes > FRIST)) {
        erstes = uhr.jetzt()
        return hinweis(HINWEIS)
      }
      ac.abort()
    },
  }
}

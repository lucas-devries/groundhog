import { setTimeout as schlafe } from 'node:timers/promises'

/** Die Uhr der Engine. Dahinter: Systemzeit, steuerbare Uhr. */
export interface Uhr {
  /** Millisekunden seit der Epoche. */
  jetzt(): number
  /** Wartet `ms` Millisekunden; ein Abbruch über `signal` beendet das Warten vorzeitig. */
  warte(ms: number, signal?: AbortSignal): Promise<void>
  /** Ein Signal, das nach `ms` Millisekunden abbricht. */
  zeitlimit(ms: number): AbortSignal
}

export const systemUhr: Uhr = {
  jetzt: () => Date.now(),
  warte: (ms, signal) => schlafe(ms, undefined, { signal }).catch(() => {}),
  zeitlimit: (ms) => {
    const ac = new AbortController()
    // unref: Ein längst beendeter Run hält den Prozess nicht bis zum Zeitlimit am Leben.
    setTimeout(() => ac.abort(), ms).unref()
    return ac.signal
  },
}

/** Uhr für Tests: steht still, bis sie vorgestellt wird; `warte` stellt sie sofort vor. */
export function steuerbareUhr(start = 0): Uhr & { vorstellen(ms: number): void } {
  let zeit = start
  let wecker: { um: number; ac: AbortController }[] = []
  const vorstellen = (ms: number) => {
    zeit += ms
    for (const w of wecker) if (w.um <= zeit) w.ac.abort()
    wecker = wecker.filter((w) => w.um > zeit)
  }
  return {
    jetzt: () => zeit,
    vorstellen,
    warte: async (ms) => vorstellen(ms),
    zeitlimit: (ms) => {
      const ac = new AbortController()
      wecker.push({ um: zeit + ms, ac })
      return ac.signal
    },
  }
}

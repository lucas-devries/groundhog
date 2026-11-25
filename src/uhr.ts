/** Die Uhr der Engine. Dahinter: Systemzeit, steuerbare Uhr. */
export interface Uhr {
  /** Millisekunden seit der Epoche. */
  jetzt(): number
}

export const systemUhr: Uhr = { jetzt: () => Date.now() }

/** Uhr für Tests: steht still, bis sie vorgestellt wird. */
export function steuerbareUhr(start = 0): Uhr & { vorstellen(ms: number): void } {
  let zeit = start
  return {
    jetzt: () => zeit,
    vorstellen: (ms) => {
      zeit += ms
    },
  }
}

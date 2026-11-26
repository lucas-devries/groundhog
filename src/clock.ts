import { setTimeout as sleep } from 'node:timers/promises'

export const MINUTE = 60_000

/** The engine's clock. Behind it: system time, manual clock. */
export interface Clock {
  /** Milliseconds since the epoch. */
  now(): number
  /** Waits `ms` milliseconds; an abort via `signal` ends the wait early. */
  wait(ms: number, signal?: AbortSignal): Promise<void>
  /** A signal that aborts after `ms` milliseconds. */
  timeout(ms: number): AbortSignal
}

export const systemClock: Clock = {
  now: () => Date.now(),
  wait: (ms, signal) => sleep(ms, undefined, { signal }).catch(() => {}),
  timeout: (ms) => {
    const ac = new AbortController()
    // unref: a session that ended long ago doesn't keep the process alive until the time limit.
    setTimeout(() => ac.abort(), ms).unref()
    return ac.signal
  },
}

/** Clock for tests: stands still until it is advanced; `wait` advances it at once. */
export function manualClock(start = 0): Clock & { advance(ms: number): void } {
  let time = start
  let alarms: { at: number; ac: AbortController }[] = []
  const advance = (ms: number) => {
    time += ms
    for (const a of alarms) if (a.at <= time) a.ac.abort()
    alarms = alarms.filter((a) => a.at > time)
  }
  return {
    now: () => time,
    advance,
    wait: async (ms) => advance(ms),
    timeout: (ms) => {
      const ac = new AbortController()
      alarms.push({ at: time + ms, ac })
      return ac.signal
    },
  }
}

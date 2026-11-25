import { spawn } from 'node:child_process'

export interface Ausfuehrung {
  exitCode: number
  /** stdout und stderr, in der Reihenfolge, in der sie kamen. */
  ausgabe: string
}

/** Die Sandbox: führt einen Befehl aus. Dahinter: `srt`-Adapter (#34), Durchreiche. */
export interface Sandbox {
  /** Bricht `signal` ab, beendet die Sandbox den Befehl samt Kindprozessen. */
  fuehreAus(
    befehl: string,
    optionen: { verzeichnis: string; signal: AbortSignal },
  ): Promise<Ausfuehrung>
}

/** Durchreiche ohne Grenzen: führt den Befehl direkt in der Shell aus. */
export const durchreiche: Sandbox = {
  fuehreAus: (befehl, { verzeichnis, signal }) =>
    new Promise((resolve, reject) => {
      const kind = spawn(befehl, {
        cwd: verzeichnis,
        shell: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        // Eigene Prozessgruppe, damit ein Abbruch auch die Kindprozesse der Shell trifft.
        detached: true,
      })
      const beende = () => {
        try {
          if (kind.pid !== undefined) process.kill(-kind.pid, 'SIGKILL')
        } catch {
          // Die Gruppe ist schon weg.
        }
      }
      if (signal.aborted) beende()
      signal.addEventListener('abort', beende, { once: true })
      kind.on('close', () => signal.removeEventListener('abort', beende))
      let ausgabe = ''
      kind.stdout.on('data', (d) => {
        ausgabe += d
      })
      kind.stderr.on('data', (d) => {
        ausgabe += d
      })
      kind.on('error', reject)
      kind.on('close', (code) => resolve({ exitCode: code ?? 1, ausgabe }))
    }),
}

/** Die feste Host-Liste, die jede Sandbox erreicht; `sandbox.hosts` kommt dazu. */
export const FESTE_HOSTS = [
  'api.anthropic.com',
  'claude.ai',
  'platform.claude.com',
  'registry.npmjs.org',
  'api.github.com',
  'github.com',
]

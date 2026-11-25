import { spawn } from 'node:child_process'

export interface Ausfuehrung {
  exitCode: number
  /** stdout und stderr, in der Reihenfolge, in der sie kamen. */
  ausgabe: string
}

/** Die Sandbox: führt einen Befehl aus. Dahinter: `srt`-Adapter (#34), Durchreiche. */
export interface Sandbox {
  fuehreAus(befehl: string, optionen: { verzeichnis: string }): Promise<Ausfuehrung>
}

/** Durchreiche ohne Grenzen: führt den Befehl direkt in der Shell aus. */
export const durchreiche: Sandbox = {
  fuehreAus: (befehl, { verzeichnis }) =>
    new Promise((resolve, reject) => {
      const kind = spawn(befehl, {
        cwd: verzeichnis,
        shell: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
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

import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { SandboxManager } from '@anthropic-ai/sandbox-runtime'

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
  fuehreAus: (befehl, optionen) => fuehre([befehl], optionen, true),
}

/** Die `srt`-Sandbox; `umhuelle` gibt dem Claude-Adapter den Aufruf, der `claude` darin startet. */
export interface SrtSandbox extends Sandbox {
  umhuelle(befehl: string[], verzeichnis: string): string[]
}

const SRT_CLI = createRequire(import.meta.url).resolve('@anthropic-ai/sandbox-runtime/dist/cli.js')

/** Die Sandbox mit `srt`: feste Host-Liste plus `hosts`, Dateisystem nach `srtKonfiguration`. */
export function srtSandbox(hosts: string[]): SrtSandbox {
  // ponytail: der Ordner bleibt nach dem Lauf in Temp liegen (eine kleine Datei).
  const geschuetzt = mkdtempSync(join(tmpdir(), 'groundhog-srt-'))
  const aufruf = (verzeichnis: string, rest: string[]) => {
    const datei = join(geschuetzt, 'settings.json')
    const orte = { verzeichnis, hosts, home: homedir(), temp: tmpdir(), geschuetzt }
    writeFileSync(datei, JSON.stringify(srtKonfiguration(orte)))
    return [process.execPath, SRT_CLI, '--settings', datei, ...rest]
  }
  return {
    umhuelle: (befehl, verzeichnis) => aufruf(verzeichnis, ['--', ...befehl]),
    fuehreAus: (befehl, optionen) => fuehre(aufruf(optionen.verzeichnis, ['-c', befehl]), optionen),
  }
}

/** Startet `argv` und sammelt die Ausgabe. Bricht `signal` ab, stirbt die ganze Prozessgruppe. */
function fuehre(
  [datei = '', ...args]: string[],
  { verzeichnis, signal }: { verzeichnis: string; signal: AbortSignal },
  shell = false,
): Promise<Ausfuehrung> {
  return new Promise((resolve, reject) => {
    const kind = spawn(datei, args, {
      cwd: verzeichnis,
      shell,
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
  })
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

/** Die Orte, aus denen die `srt`-Config entsteht. */
export interface SrtOrte {
  verzeichnis: string
  hosts: string[]
  home: string
  temp: string
  /** Ordner der Config-Dateien; unbeschreibbar, damit ein Run die Grenzen des nächsten nicht ändert. */
  geschuetzt: string
}

/** Die `srt`-Config eines Runs oder Checks. */
export function srtKonfiguration({ verzeichnis, hosts, home, temp, geschuetzt }: SrtOrte) {
  return {
    network: { allowedDomains: [...FESTE_HOSTS, ...hosts], deniedDomains: [] },
    filesystem: {
      denyRead: [join(home, '.ssh'), join(home, '.config/gh'), join(home, '.npmrc')],
      allowWrite: [
        verzeichnis,
        join(home, '.claude'),
        join(home, '.claude.json'),
        // ponytail: npm-Standard-Cache; ein per `npm_config_cache` verlegter Cache bleibt gesperrt.
        join(home, '.npm'),
        temp,
      ],
      denyWrite: [
        join(home, '.claude/settings.json'),
        join(verzeichnis, '.git/hooks'),
        join(verzeichnis, '.git/config'),
        geschuetzt,
      ],
    },
  }
}

/**
 * Was fehlt, damit die Sandbox startet; leer heißt startbar. Prüft die Werkzeuge von `srt` (auf
 * Linux `bubblewrap`, `socat`, `ripgrep`) und den Start als root, bei dem `claude` Bypass verweigert.
 */
export function sandboxFehlt({
  abhaengigkeiten = () => SandboxManager.checkDependencies().errors,
  uid = process.getuid?.(),
}: {
  abhaengigkeiten?: () => string[]
  uid?: number
} = {}): string[] {
  const fehlt = abhaengigkeiten()
  if (uid === 0) fehlt.push('Start als root: claude startet als root nicht mit Bypass')
  return fehlt
}

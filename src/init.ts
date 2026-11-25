import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { git } from './git.ts'
import { DATEI, type Konfiguration, leseKonfiguration, VERSUCHE_STANDARD } from './konfiguration.ts'
import { FESTE_HOSTS } from './sandbox.ts'
import type { StrgC } from './start.ts'

type Pruefung = (wert: string | undefined) => string | undefined

/** Die Fragen von `init`. Passt zu `@clack/prompts`; ein Symbol als Antwort heißt Strg+C. */
export interface Dialog {
  multiline(o: {
    message: string
    initialValue: string
    validate: Pruefung
  }): Promise<string | StrgC>
  text(o: { message: string; initialValue: string; validate?: Pruefung }): Promise<string | StrgC>
  multiselect(o: {
    message: string
    options: { value: string; label: string }[]
    initialValues: string[]
    required: true
  }): Promise<string[] | StrgC>
  confirm(o: {
    message: string
    initialValue: boolean
    active: string
    inactive: string
  }): Promise<boolean | StrgC>
  info(text: string): void
}

export interface InitOptionen {
  verzeichnis: string
  dialog: Dialog
  istTerminal: boolean
  ghAngemeldet?: () => boolean
}

const abbruch = (meldung: string) => ({ exitCode: 1, meldung })
const STRG_C = { exitCode: 130, meldung: `Abgebrochen. ${DATEI} wurde nicht geschrieben.` }

/** `groundhog init`: fragt die Projekt-Konfiguration ab und schreibt nur `groundhog.json`. */
export async function init({
  verzeichnis,
  dialog,
  istTerminal,
  ghAngemeldet = () => spawnSync('gh', ['auth', 'status'], { stdio: 'ignore' }).status === 0,
}: InitOptionen): Promise<{ exitCode: number; meldung: string }> {
  let root: string | undefined
  try {
    root = git(verzeichnis, 'rev-parse', '--show-toplevel')
  } catch {}
  if (root === undefined || realpathSync(root) !== realpathSync(verzeichnis)) {
    return abbruch('groundhog init muss im Root eines Git-Repos laufen.')
  }
  let url = ''
  try {
    url = git(verzeichnis, 'config', '--get', 'remote.origin.url')
  } catch {}
  if (!/github\.com[:/]/.test(url)) {
    return abbruch('groundhog init braucht einen GitHub-Remote als origin.')
  }
  if (!ghAngemeldet()) return abbruch('gh ist nicht angemeldet. Melde dich mit `gh auth login` an.')
  if (!istTerminal) return abbruch('groundhog init braucht ein Terminal an stdin.')

  let vorgabe: Konfiguration = {
    checks: nodeChecks(verzeichnis),
    attempts: VERSUCHE_STANDARD,
    targetBranches: [],
    sandbox: { hosts: [], off: false },
  }
  const gelesen = leseKonfiguration(verzeichnis)
  if (gelesen.ok) vorgabe = gelesen.konfiguration
  else if (!gelesen.fehlt) {
    dialog.info(`${DATEI} ist ungültig:\n${gelesen.fehler.map((f) => `- ${f}`).join('\n')}`)
    const neu = await dialog.confirm({
      message: `${DATEI} neu anlegen?`,
      initialValue: false,
      active: 'Ja',
      inactive: 'Nein',
    })
    if (typeof neu === 'symbol') return STRG_C
    if (!neu) return abbruch(`${DATEI} bleibt unverändert.`)
  }

  const checks = await dialog.multiline({
    message: 'Checks: ein Befehl pro Zeile, in dieser Reihenfolge im Repo-Root ausgeführt',
    initialValue: vorgabe.checks.join('\n'),
    validate: (w) => (zeilen(w).length > 0 ? undefined : 'Mindestens ein Check ist nötig.'),
  })
  if (typeof checks === 'symbol') return STRG_C

  const standard = git(verzeichnis, 'ls-remote', '--symref', 'origin', 'HEAD').match(
    /^ref: refs\/heads\/(\S+)\tHEAD/m,
  )?.[1]
  const remote = git(verzeichnis, 'ls-remote', '--heads', 'origin')
    .split('\n')
    .map((z) => z.split('\trefs/heads/')[1])
    .filter((b): b is string => b !== undefined)
    .sort()
  const vorn = vorgabe.targetBranches.filter((b) => remote.includes(b))
  if (vorn.length === 0 && standard !== undefined) vorn.push(standard)
  const reihenfolge = [...new Set([...vorn, ...remote])]
  const targetBranches = await dialog.multiselect({
    message: 'Ziel-Branches: wohin darf ein Lauf mergen? Der erste ist die Vorauswahl.',
    options: reihenfolge.map((b) => ({ value: b, label: b })),
    initialValues: vorn,
    required: true,
  })
  if (typeof targetBranches === 'symbol') return STRG_C

  dialog.info(`Die Sandbox erreicht immer: ${FESTE_HOSTS.join(', ')}`)
  const hosts = await dialog.text({
    message: 'Zusätzliche Hosts, kommagetrennt (leer: keine)',
    initialValue: vorgabe.sandbox.hosts.join(', '),
  })
  if (typeof hosts === 'symbol') return STRG_C

  const versuche = await dialog.text({
    message: 'Versuche pro Ticket (1 bis 10)',
    initialValue: String(vorgabe.attempts),
    validate: (w) => (gueltigeVersuche(w) ? undefined : 'Eine ganze Zahl von 1 bis 10.'),
  })
  if (typeof versuche === 'symbol') return STRG_C

  const konfiguration: Konfiguration = {
    checks: zeilen(checks),
    attempts: Number(versuche),
    targetBranches: reihenfolge.filter((b) => targetBranches.includes(b)),
    sandbox: {
      hosts: hosts
        .split(',')
        .map((h) => h.trim())
        .filter(Boolean),
      off: vorgabe.sandbox.off,
    },
  }
  writeFileSync(join(verzeichnis, DATEI), `${JSON.stringify(konfiguration, null, 2)}\n`)
  return {
    exitCode: 0,
    meldung: `${DATEI} geschrieben. Committe die Datei, dann starte groundhog <spec>.`,
  }
}

const zeilen = (text = '') =>
  text
    .split('\n')
    .map((z) => z.trim())
    .filter(Boolean)

const gueltigeVersuche = (w = '') => /^\s*\d+\s*$/.test(w) && Number(w) >= 1 && Number(w) <= 10

/** Vorschlag für ein Node-Projekt: Install passend zum Lockfile, dann typecheck, lint, test. */
function nodeChecks(verzeichnis: string): string[] {
  const paket = join(verzeichnis, 'package.json')
  if (!existsSync(paket)) return []
  const lockfiles: [string, string, string][] = [
    ['pnpm-lock.yaml', 'pnpm install --frozen-lockfile', 'pnpm'],
    ['yarn.lock', 'yarn install --frozen-lockfile', 'yarn'],
    ['bun.lock', 'bun install --frozen-lockfile', 'bun'],
    ['bun.lockb', 'bun install --frozen-lockfile', 'bun'],
    ['package-lock.json', 'npm ci', 'npm'],
  ]
  const [, install, pm] = lockfiles.find(([datei]) => existsSync(join(verzeichnis, datei))) ?? [
    '',
    'npm install',
    'npm',
  ]
  let scripts: Record<string, unknown> = {}
  try {
    scripts = JSON.parse(readFileSync(paket, 'utf8')).scripts ?? {}
  } catch {}
  return [
    install,
    ...['typecheck', 'lint', 'test'].filter((s) => s in scripts).map((s) => `${pm} run ${s}`),
  ]
}

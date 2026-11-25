import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { type Config, DEFAULT_ATTEMPTS, FILE, readConfig } from './config.ts'
import { git } from './git.ts'
import { FIXED_HOSTS } from './sandbox.ts'
import type { CtrlC } from './start.ts'

type Validate = (value: string | undefined) => string | undefined

/** The questions of `init`. Fits `@clack/prompts`; a symbol as answer means Ctrl+C. */
export interface Dialog {
  multiline(o: {
    message: string
    initialValue: string
    validate: Validate
  }): Promise<string | CtrlC>
  text(o: { message: string; initialValue: string; validate?: Validate }): Promise<string | CtrlC>
  multiselect(o: {
    message: string
    options: { value: string; label: string }[]
    initialValues: string[]
    required: true
  }): Promise<string[] | CtrlC>
  confirm(o: {
    message: string
    initialValue: boolean
    active: string
    inactive: string
  }): Promise<boolean | CtrlC>
  info(text: string): void
}

export interface InitOptions {
  directory: string
  dialog: Dialog
  isTerminal: boolean
  ghLoggedIn?: () => boolean
}

const abort = (message: string) => ({ exitCode: 1, message })
const CTRL_C = { exitCode: 130, message: `Aborted. ${FILE} was not written.` }

/** `groundhog init`: asks for the project config and writes only `groundhog.json`. */
export async function init({
  directory,
  dialog,
  isTerminal,
  ghLoggedIn = () => spawnSync('gh', ['auth', 'status'], { stdio: 'ignore' }).status === 0,
}: InitOptions): Promise<{ exitCode: number; message: string }> {
  let root: string | undefined
  try {
    root = git(directory, 'rev-parse', '--show-toplevel')
  } catch {}
  if (root === undefined || realpathSync(root) !== realpathSync(directory)) {
    return abort('groundhog init must run in the root of a Git repo.')
  }
  let url = ''
  try {
    url = git(directory, 'config', '--get', 'remote.origin.url')
  } catch {}
  if (!/github\.com[:/]/.test(url)) {
    return abort('groundhog init needs a GitHub remote as origin.')
  }
  if (!ghLoggedIn()) return abort('gh is not logged in. Log in with `gh auth login`.')
  if (!isTerminal) return abort('groundhog init needs a terminal on stdin.')

  let defaults: Config = {
    checks: nodeChecks(directory),
    attempts: DEFAULT_ATTEMPTS,
    targetBranches: [],
    sandbox: { hosts: [], off: false },
  }
  const read = readConfig(directory)
  if (read.ok) defaults = read.config
  else if (!read.missing) {
    dialog.info(`${FILE} is invalid:\n${read.errors.map((e) => `- ${e}`).join('\n')}`)
    const recreate = await dialog.confirm({
      message: `Create ${FILE} anew?`,
      initialValue: false,
      active: 'Yes',
      inactive: 'No',
    })
    if (typeof recreate === 'symbol') return CTRL_C
    if (!recreate) return abort(`${FILE} stays unchanged.`)
  }

  const checks = await dialog.multiline({
    message: 'Checks: one command per line, run in this order in the repo root',
    initialValue: defaults.checks.join('\n'),
    validate: (v) => (lines(v).length > 0 ? undefined : 'At least one check is required.'),
  })
  if (typeof checks === 'symbol') return CTRL_C

  const defaultBranch = git(directory, 'ls-remote', '--symref', 'origin', 'HEAD').match(
    /^ref: refs\/heads\/(\S+)\tHEAD/m,
  )?.[1]
  const remote = git(directory, 'ls-remote', '--heads', 'origin')
    .split('\n')
    .map((l) => l.split('\trefs/heads/')[1])
    .filter((b): b is string => b !== undefined)
    .sort()
  const front = defaults.targetBranches.filter((b) => remote.includes(b))
  if (front.length === 0 && defaultBranch !== undefined) front.push(defaultBranch)
  const order = [...new Set([...front, ...remote])]
  const targetBranches = await dialog.multiselect({
    message: 'Target branches: where may a run merge? The first one is preselected.',
    options: order.map((b) => ({ value: b, label: b })),
    initialValues: front,
    required: true,
  })
  if (typeof targetBranches === 'symbol') return CTRL_C

  dialog.info(`The sandbox always reaches: ${FIXED_HOSTS.join(', ')}`)
  const hosts = await dialog.text({
    message: 'Additional hosts, comma-separated (empty: none)',
    initialValue: defaults.sandbox.hosts.join(', '),
  })
  if (typeof hosts === 'symbol') return CTRL_C

  const attempts = await dialog.text({
    message: 'Attempts per ticket (1 to 10)',
    initialValue: String(defaults.attempts),
    validate: (v) => (validAttempts(v) ? undefined : 'A whole number from 1 to 10.'),
  })
  if (typeof attempts === 'symbol') return CTRL_C

  const config: Config = {
    checks: lines(checks),
    attempts: Number(attempts),
    targetBranches: order.filter((b) => targetBranches.includes(b)),
    sandbox: {
      hosts: hosts
        .split(',')
        .map((h) => h.trim())
        .filter(Boolean),
      off: defaults.sandbox.off,
    },
  }
  writeFileSync(join(directory, FILE), `${JSON.stringify(config, null, 2)}\n`)
  return {
    exitCode: 0,
    message: `${FILE} written. Commit the file, then start groundhog <spec>.`,
  }
}

const lines = (text = '') =>
  text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)

const validAttempts = (v = '') => /^\s*\d+\s*$/.test(v) && Number(v) >= 1 && Number(v) <= 10

/** Suggestion for a Node project: install matching the lockfile, then typecheck, lint, test. */
function nodeChecks(directory: string): string[] {
  const pkg = join(directory, 'package.json')
  if (!existsSync(pkg)) return []
  const lockfiles: [string, string, string][] = [
    ['pnpm-lock.yaml', 'pnpm install --frozen-lockfile', 'pnpm'],
    ['yarn.lock', 'yarn install --frozen-lockfile', 'yarn'],
    ['bun.lock', 'bun install --frozen-lockfile', 'bun'],
    ['bun.lockb', 'bun install --frozen-lockfile', 'bun'],
    ['package-lock.json', 'npm ci', 'npm'],
  ]
  const [, install, pm] = lockfiles.find(([file]) => existsSync(join(directory, file))) ?? [
    '',
    'npm install',
    'npm',
  ]
  let scripts: Record<string, unknown> = {}
  try {
    scripts = JSON.parse(readFileSync(pkg, 'utf8')).scripts ?? {}
  } catch {}
  return [
    install,
    ...['typecheck', 'lint', 'test'].filter((s) => s in scripts).map((s) => `${pm} run ${s}`),
  ]
}

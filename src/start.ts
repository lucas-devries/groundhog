import { spawnSync } from 'node:child_process'
import { readStreamLine, type StreamLine } from './claude.ts'
import { type Config, readConfig } from './config.ts'
import { type Choice, type Event, FINISH, integrationBranch } from './engine.ts'
import { git } from './git.ts'
import { GitHubTracker } from './github.ts'
import { takeLock } from './lock.ts'
import { type Log, openLog } from './log.ts'
import { type SrtSandbox, sandboxMissing, srtSandbox } from './sandbox.ts'
import { frontierState, type Ticket } from './tracker.ts'

/** The answer of `@clack/prompts` to Ctrl+C. */
export type CtrlC = symbol

/** The parts of `@clack/prompts` the menu needs; a symbol as answer means Ctrl+C. */
export interface MenuDialog {
  note(text: string, title: string): void
  warn(text: string): void
  outro(text: string): void
  select(o: {
    message: string
    options: { value: string; label: string; hint?: string }[]
    initialValue: string
  }): Promise<string | CtrlC>
  confirm(o: {
    message: string
    initialValue: boolean
    active: string
    inactive: string
  }): Promise<boolean | CtrlC>
}

export interface StartOptions {
  /** A directory in the clone. */
  directory: string
  spec: number
  dialog: MenuDialog
  /** stdin is a terminal. */
  isTerminal: boolean
  /** What the sandbox is missing to start; empty means it can start. */
  sandboxMissing?: () => string[]
  /** Update question at the beginning of the menu; without it there is no question. */
  update?: {
    /** The newer tag, otherwise `undefined`, also if the comparison fails. */
    newerVersion: () => string | undefined
    /** Installs the tag; throws with a message if that fails. */
    install: (tag: string) => void
  }
  /** Gets every event after the log has written it. */
  next?: (event: Event) => void
}

/** Everything the run needs after the menu. */
export interface Ready {
  ok: true
  /** Repo root of the clone. */
  directory: string
  config: Config
  choice: Choice
  tracker: GitHubTracker
  /** The `gh` token. */
  token: string
  repoUrl: string
  /** The `srt` sandbox; `undefined` only with `sandbox.off`. */
  sandbox: SrtSandbox | undefined
  versions: Record<string, string>
  log: Log
  /** Releases the lock; call on every end. */
  release: () => void
}

export type Start = Ready | { ok: false; exitCode: number; message: string }

const NOTHING_CHANGED = 'Aborted. Nothing was changed.'

class Abort extends Error {
  constructor(
    message: string,
    readonly exitCode = 1,
  ) {
    super(message)
  }
}

/**
 * Start of a run up to the end of the menu: start checks, lock, log, menu. Changes neither repo
 * nor tracker; on every abort the lock is free again.
 */
export async function start({
  directory: called,
  spec,
  dialog,
  isTerminal,
  sandboxMissing: missing = sandboxMissing,
  update,
  next,
}: StartOptions): Promise<Start> {
  let release = () => {}
  try {
    const versions: Record<string, string> = {}
    tool(called, 'git', ['--version'])
    let directory: string
    try {
      directory = git(called, 'rev-parse', '--show-toplevel')
    } catch {
      throw new Abort('groundhog must run in a Git repo.')
    }
    const ghVersion = tool(directory, 'gh', ['--version'])
    const [major = 0, minor = 0] = (ghVersion.match(/gh version (\d+)\.(\d+)/) ?? [])
      .slice(1)
      .map(Number)
    if (major < 2 || (major === 2 && minor < 94)) {
      throw new Abort(`gh is too old (${ghVersion.split('\n')[0]}); 2.94 or newer is required.`)
    }
    const token = tool(directory, 'gh', ['auth', 'token'], () => {
      throw new Abort('gh is not logged in. Log in with `gh auth login`.')
    })
    versions.claude = tool(directory, 'claude', ['--version'])
    tool(directory, 'claude', ['auth', 'status'], () => {
      throw new Abort('claude is not logged in. Log in with `claude auth login`.')
    })

    const read = readConfig(directory)
    if (!read.ok) throw new Abort(read.errors.join('\n'))
    const config = read.config

    const lock = takeLock(directory, spec, Date.now())
    if (!lock.ok) throw new Abort(lock.message)
    release = lock.release

    if (git(directory, 'status', '--porcelain') !== '') {
      // Exception: the remnant of an aborted run on ticket/<n>.
      const remnant = git(directory, 'branch', '--show-current').match(/^ticket\/(\d+)$/)?.[1]
      const discard =
        remnant !== undefined &&
        isTerminal &&
        (await dialog.confirm({
          message: `Discard the remnant of ticket ${remnant}?`,
          initialValue: false,
          active: 'Yes',
          inactive: 'No',
        }))
      if (typeof discard === 'symbol') throw new Abort(NOTHING_CHANGED, 130)
      if (!discard) {
        throw new Abort('The working tree is not clean. Commit or discard the changes.')
      }
      git(directory, 'reset', '-q', '--hard')
      git(directory, 'clean', '-q', '-fd')
    }
    git(directory, 'fetch', '-q', '--prune', 'origin')
    // Exactly the names spec and ticket; spec/<n> and ticket/<n> of earlier runs are no obstacle.
    const inTheWay = git(
      directory,
      'for-each-ref',
      '--format=%(refname:short)',
      'refs/heads/',
      'refs/remotes/origin/',
    )
      .split('\n')
      .filter((b) => /^(origin\/)?(spec|ticket)$/.test(b))
    if (inTheWay.length > 0) {
      throw new Abort(
        `There is a branch ${inTheWay.join(', ')}. It gets in the way of spec/* and ticket/*; rename it.`,
      )
    }
    const missingBranches = config.targetBranches.filter(
      (b) => !git(directory, 'for-each-ref', `refs/remotes/origin/${b}`),
    )
    if (missingBranches.length > 0) {
      throw new Abort(`Target branch missing on the remote: ${missingBranches.join(', ')}`)
    }

    const tracker = await GitHubTracker.connect({ directory })
    const check = await tracker.startCheck(spec)
    if (check.missingLabels.length > 0) {
      throw new Abort(
        `The repo is missing the label ${check.missingLabels.join(' and ')}. Create it on GitHub.`,
      )
    }
    if (check.subIssues === 0) {
      throw new Abort(
        `Spec #${spec} has no sub-issues. groundhog only takes native sub-issues as tickets; ` +
          '"Part of #n" in the text does not count. Link the tickets in the spec on GitHub under ' +
          '"Sub-issues" (Add existing issue).',
      )
    }

    let sandbox: SrtSandbox | undefined
    if (!config.sandbox.off) {
      const what = missing()
      if (what.length > 0) {
        throw new Abort(
          `The sandbox is on but does not start:\n${what.map((w) => `- ${w}`).join('\n')}`,
        )
      }
      sandbox = srtSandbox(config.sandbox.hosts)
    }

    const missingSkills = skills(directory, versions)
    if (missingSkills.length > 0) {
      const command = INSTALLATION.map((a) => a.join(' ')).join(' && ')
      const install =
        isTerminal &&
        answer(
          await dialog.confirm({
            message: `The skills ${missingSkills.join(', ')} are missing. Install the plugin now?`,
            initialValue: true,
            active: 'Yes',
            inactive: 'No',
          }),
        )
      if (!install) {
        throw new Abort(
          `The skills ${missingSkills.join(', ')} are missing. Install the plugin with:\n${command}`,
        )
      }
      // The human sees the installation's output directly; only the check shows whether it worked.
      for (const [file = '', ...args] of INSTALLATION) {
        spawnSync(file, args, { cwd: directory, stdio: 'inherit' })
      }
      const stillMissing = skills(directory, versions)
      if (stillMissing.length > 0) {
        throw new Abort(
          `The skills ${stillMissing.join(', ')} are still missing after the installation. Install the plugin by hand with:\n${command}`,
        )
      }
    }

    if (!isTerminal) throw new Abort('groundhog needs a terminal on stdin for the menu.')

    let log: Log
    try {
      log = openLog({ directory, spec, start: Date.now(), next })
    } catch (error) {
      throw new Abort(`The log folder cannot be created: ${(error as Error).message}`)
    }

    const tag = update?.newerVersion()
    if (tag) {
      const yes = await dialog.confirm({
        message: `groundhog ${tag} is out. Update now?`,
        initialValue: false,
        active: 'Yes',
        inactive: 'No',
      })
      if (typeof yes === 'symbol') throw new Abort(NOTHING_CHANGED, 130)
      if (yes) {
        update?.install(tag)
        throw new Abort(`groundhog ${tag} is installed. Start again: groundhog ${spec}`, 0)
      }
    }

    const choice = await menu(dialog, spec, config, await tracker.taskGraph(spec), tracker.user)
    return {
      ok: true,
      directory,
      config,
      choice,
      tracker,
      token,
      repoUrl: check.url,
      sandbox,
      versions,
      log,
      release,
    }
  } catch (error) {
    release()
    const exitCode = error instanceof Abort ? error.exitCode : 1
    return { ok: false, exitCode, message: (error as Error).message }
  }
}

/** Runs a tool and returns stdout; if it is missing in the `PATH`, the start aborts. */
function tool(
  directory: string,
  name: string,
  args: string[],
  failed = (stderr: string): never => {
    throw new Abort(`${name} ${args.join(' ')} failed: ${stderr}`)
  },
): string {
  const result = spawnSync(name, args, { cwd: directory, encoding: 'utf8' })
  if ((result.error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') {
    throw new Abort(`${name} is missing in the PATH. groundhog needs git, gh and claude.`)
  }
  if (result.status !== 0) failed(result.stderr.trim())
  return result.stdout.trim()
}

/** Ctrl+C in the menu aborts with 130. */
function answer<T>(value: T | CtrlC): T {
  if (typeof value === 'symbol') throw new Abort(NOTHING_CHANGED, 130)
  return value
}

const SKILLS = [
  'mattpocock-skills:implement',
  'mattpocock-skills:tdd',
  'mattpocock-skills:code-review',
]
const INSTALLATION = [
  ['claude', 'plugin', 'marketplace', 'add', 'mattpocock/skills'],
  ['claude', 'plugin', 'install', 'mattpocock-skills@mattpocock'],
]

/**
 * The missing skills according to the `init` event of `claude -p /usage` (no model, no cost);
 * records the version of the skill plugin in `versions`.
 */
function skills(directory: string, versions: Record<string, string>): string[] {
  const output = tool(directory, 'claude', [
    '-p',
    '/usage',
    '--output-format',
    'stream-json',
    '--verbose',
  ])
  let init: StreamLine = {}
  for (const line of output.split('\n')) {
    const l = readStreamLine(line)
    if (l?.type === 'system' && l.subtype === 'init') init = l
  }
  const version = init.plugins?.find((p) => p.name === 'mattpocock-skills')?.version
  if (version) versions['mattpocock-skills'] = version
  return SKILLS.filter((s) => !init.skills?.includes(s))
}

async function menu(
  dialog: MenuDialog,
  spec: number,
  config: Config,
  tickets: Ticket[],
  user: string,
): Promise<Choice> {
  const integration = integrationBranch(spec)
  const state = (t: Ticket) => frontierState(t, user)
  const human = tickets.filter((t) => state(t) === 'ready-for-human')
  // Released, even if still blocked or taken.
  const released = tickets.filter((t) => ['workable', 'blocked', 'taken'].includes(state(t)))
  const { sandbox } = config
  dialog.note(
    [
      `Spec #${spec}`,
      `${tickets.length} tickets, ${released.length} of them released for the agent`,
      ...human.map((t) => `#${t.number}: ready-for-human, will not be touched`),
      `Checks: ${config.checks.join(' · ')}`,
      `Sandbox: ${sandbox.off ? 'off' : 'on (srt)'}`,
      `Attempts per ticket: ${config.attempts}`,
    ].join('\n'),
    'This run',
  )
  if (sandbox.off) {
    dialog.warn(
      'The sandbox is off: sessions run in auto mode without boundaries on this machine, with your gh token.',
    )
  }
  const targetBranch = answer(
    await dialog.select({
      message: 'Target branch: where does the work flow in the end?',
      options: config.targetBranches.map((b) => ({ value: b, label: b })),
      initialValue: config.targetBranches[0] ?? '',
    }),
  )
  const finish = answer(
    await dialog.select({
      message: `Finish: what happens to ${integration} once all tickets are closed?`,
      options: [
        {
          value: 'merge',
          label: FINISH.merge,
          hint: `groundhog merges into ${targetBranch} and pushes`,
        },
        { value: 'pr', label: FINISH.pr, hint: `groundhog opens a PR into ${targetBranch}` },
        { value: 'none', label: FINISH.none, hint: `${integration} stays` },
      ],
      initialValue: targetBranch === 'main' ? 'pr' : 'merge',
    }),
  ) as Choice['finish']
  if (targetBranch === 'main' && finish === 'merge') {
    dialog.warn(
      `If all tickets are closed at the end, groundhog merges ${integration} into main and pushes, without asking.`,
    )
    const yes = answer(
      await dialog.confirm({
        message: 'Merge into main without asking again?',
        initialValue: false,
        active: 'Yes',
        inactive: 'No',
      }),
    )
    if (!yes) throw new Abort(NOTHING_CHANGED)
  }
  dialog.outro('No more input needed from here on.')
  return { targetBranch, finish }
}

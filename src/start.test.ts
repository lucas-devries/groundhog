import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, vi } from 'vitest'
import { git } from './git.ts'
import { type MenuDialog, type Start, type StartOptions, start } from './start.ts'
import { type ClaudeAnswer, fakeClaude } from './testing/fake-claude.ts'
import { fakeGh, type GhAnswer, recording } from './testing/fake-gh.ts'
import { commitFile, throwawayRepo } from './testing/throwaway-repo.ts'

const CANCEL = Symbol('Ctrl+C')

/** Scripted dialog: answers the questions in order and records everything shown. */
function fakeDialog(answers: (string | boolean | symbol)[]) {
  const shown: Record<string, unknown>[] = []
  const answer = async (question: Record<string, unknown>) => {
    shown.push(question)
    if (answers.length === 0) throw new Error(`no answer for ${JSON.stringify(question)}`)
    return answers.shift()
  }
  const dialog = {
    note: (text: string, title: string) => shown.push({ kind: 'note', title, text }),
    warn: (text: string) => shown.push({ kind: 'warn', text }),
    outro: (text: string) => shown.push({ kind: 'outro', text }),
    select: (o: object) => answer({ kind: 'select', ...o }),
    confirm: (o: object) => answer({ kind: 'confirm', ...o }),
  } as MenuDialog
  return { dialog, shown }
}

const GH_VERSION = { output: 'gh version 2.94.0 (2026-05-01)\nhttps://github.com/cli/cli\n' }
const TOKEN = { output: 'gho_secret\n' }
const USER = { output: 'lucas\n' }

const CLAUDE_VERSION: ClaudeAnswer = { recording: 'claude-version.txt' }
/** `claude auth status` of a logged-in `claude`. */
const LOGGED_IN: ClaudeAnswer = {}
const WITH_SKILLS: ClaudeAnswer = { recording: 'claude-init-with-skills.jsonl' }
const WITHOUT_SKILLS: ClaudeAnswer = { recording: 'claude-init-without-skills.jsonl' }

const CONFIG = {
  checks: ['npm ci', 'npm test'],
  attempts: 4,
  targetBranches: ['main', 'develop'],
  sandbox: { hosts: [], off: false },
}

/**
 * A clone of spec #25 ready to start: config committed, `develop` on the remote, `gh` and
 * `claude` as fakes alone in the `PATH` (next to `git` and `node`).
 */
function ready({
  gh = [GH_VERSION, TOKEN, USER, recording('start-check-spec-25.json')],
  config = CONFIG as object | null,
  claude = [CLAUDE_VERSION, LOGGED_IN, WITH_SKILLS] as ClaudeAnswer[] | null,
  without = [] as string[],
} = {}) {
  const { clone } = throwawayRepo()
  if (config) {
    commitFile(clone, 'groundhog.json', JSON.stringify(config), 'config')
  }
  git(clone, 'push', '-q', 'origin', 'main', 'main:develop')
  const fake = fakeGh([...gh, recording('task-graph-spec-25.json')])
  const claudeFake = claude && fakeClaude(claude)
  if (without.includes('gh')) rmSync(join(fake.directory, 'gh'))
  const bin = mkdtempSync(join(tmpdir(), 'bin-'))
  for (const [name, target] of [
    ['git', '/usr/bin/git'],
    ['node', process.execPath],
  ] as const) {
    if (!without.includes(name)) symlinkSync(target, join(bin, name))
  }
  const path = [fake.directory, claudeFake?.directory, bin].filter(Boolean)
  return { clone, fake, claude: claudeFake, path: path.join(':') }
}

const lock = (clone: string) => join(clone, '.git', 'groundhog.lock')

/** Starts with the `PATH` from `ready`; the test itself calls the real `git` again afterwards. */
async function run(
  { clone, path }: { clone: string; path: string },
  answers: (string | boolean | symbol)[],
  options: Partial<StartOptions> = {},
) {
  const { dialog, shown } = fakeDialog(answers)
  vi.stubEnv('PATH', path)
  const result: Start = await start({
    directory: clone,
    spec: 25,
    dialog,
    isTerminal: true,
    sandboxMissing: () => [],
    ...options,
  }).finally(() => vi.unstubAllEnvs())
  return { result, shown }
}

test('the menu shows the run, asks for target branch and finish and says that no more input is needed', async () => {
  const { clone, fake, path } = ready()

  const { result, shown } = await run({ clone, path }, ['develop', 'merge'])

  expect(shown).toEqual([
    {
      kind: 'note',
      title: 'This run',
      text: [
        'Spec #25',
        '19 tickets, 18 of them released for the agent',
        '#44: ready-for-human, will not be touched',
        'Checks: npm ci · npm test',
        'Sandbox: on (srt)',
        'Attempts per ticket: 4',
      ].join('\n'),
    },
    {
      kind: 'select',
      message: 'Target branch: where does the work flow in the end?',
      options: [
        { value: 'main', label: 'main' },
        { value: 'develop', label: 'develop' },
      ],
      initialValue: 'main',
    },
    {
      kind: 'select',
      message: 'Finish: what happens to spec/25 once all tickets are closed?',
      options: [
        { value: 'merge', label: 'Merge', hint: 'groundhog merges into develop and pushes' },
        { value: 'pr', label: 'PR', hint: 'groundhog opens a PR into develop' },
        { value: 'none', label: 'None', hint: 'spec/25 stays' },
      ],
      initialValue: 'merge',
    },
    { kind: 'outro', text: 'No more input needed from here on.' },
  ])
  if (!result.ok) throw new Error(result.message)
  expect(result.choice).toEqual({ targetBranch: 'develop', finish: 'merge' })
  expect(result.token).toBe('gho_secret')
  expect(result.repoUrl).toBe('https://github.com/lucas-devries/groundhog')
  expect(result.config.attempts).toBe(4)
  expect(result.versions).toEqual({
    claude: '2.1.0 (Claude Code)',
    'mattpocock-skills': '1.3.2',
  })
  expect(result.sandbox).toBeDefined()
  expect(existsSync(lock(clone))).toBe(true)
  result.release()
  expect(existsSync(lock(clone))).toBe(false)
  // Only reading calls to GitHub, no branch created.
  expect(fake.calls().map((a) => a.args.slice(0, 2).join(' '))).toEqual([
    '--version',
    'auth token',
    'api user',
    'api graphql',
    'api graphql',
  ])
  expect(git(clone, 'branch', '--list', 'spec/*')).toBe('')
})

test('from a subdirectory the run starts in the repo root', async () => {
  const { clone, path } = ready()
  mkdirSync(join(clone, 'sub'))

  const { result } = await run({ clone: join(clone, 'sub'), path }, ['main', 'pr'])

  expect(result).toMatchObject({ ok: true, directory: realpathSync(clone) })
})

test('the start creates the log folder before the menu', async () => {
  const { clone, path } = ready()

  const { result } = await run({ clone, path }, ['main', 'pr'])

  if (!result.ok) throw new Error(result.message)
  expect(result.log.path).toMatch(/\.git\/groundhog\/runs\/\d{8}-\d{6}-spec-25$/)
  expect(existsSync(result.log.path)).toBe(true)
})

test('if the log folder cannot be created, the start aborts before the menu', async () => {
  const { clone, path } = ready()
  writeFileSync(join(clone, '.git/groundhog'), 'not a folder')

  const { result, shown } = await run({ clone, path }, [])

  expect(shown).toEqual([])
  expect(result).toMatchObject({ ok: false, exitCode: 1 })
  expect(!result.ok && result.message).toMatch(/^The log folder cannot be created/)
  expect(existsSync(lock(clone))).toBe(false)
})

test('with main, PR is preselected', async () => {
  const { clone, path } = ready()

  const { result, shown } = await run({ clone, path }, ['main', 'pr'])

  expect(shown[2]).toMatchObject({ kind: 'select', initialValue: 'pr' })
  expect(result).toMatchObject({ ok: true, choice: { targetBranch: 'main', finish: 'pr' } })
})

test('main and merge: warning with the integration branch, then Yes/No preselecting No', async () => {
  const { clone, path } = ready()

  const { result, shown } = await run({ clone, path }, ['main', 'merge', true])

  expect(shown.slice(3)).toEqual([
    {
      kind: 'warn',
      text: 'If all tickets are closed at the end, groundhog merges spec/25 into main and pushes, without asking.',
    },
    {
      kind: 'confirm',
      message: 'Merge into main without asking again?',
      initialValue: false,
      active: 'Yes',
      inactive: 'No',
    },
    { kind: 'outro', text: 'No more input needed from here on.' },
  ])
  expect(result).toMatchObject({ ok: true, choice: { targetBranch: 'main', finish: 'merge' } })
})

test('No to merging into main aborts without changing anything', async () => {
  const { clone, fake, path } = ready()
  const before = git(clone, 'for-each-ref')

  const { result } = await run({ clone, path }, ['main', 'merge', false])

  expect(result).toEqual({
    ok: false,
    exitCode: 1,
    message: 'Aborted. Nothing was changed.',
  })
  expect(existsSync(lock(clone))).toBe(false)
  expect(git(clone, 'for-each-ref')).toBe(before)
  expect(git(clone, 'status', '--porcelain')).toBe('')
  expect(fake.calls().every((a) => ['--version', 'auth', 'api'].includes(a.args[0] ?? ''))).toBe(
    true,
  )
})

test('Ctrl+C in the menu aborts with exit code 130 and releases the lock', async () => {
  const { clone, path } = ready()

  const { result } = await run({ clone, path }, ['main', CANCEL])

  expect(result).toEqual({
    ok: false,
    exitCode: 130,
    message: 'Aborted. Nothing was changed.',
  })
  expect(existsSync(lock(clone))).toBe(false)
})

test('with the sandbox switched off the menu warns, and the run gets no sandbox', async () => {
  const { clone, path } = ready({ config: { ...CONFIG, sandbox: { off: true } } })
  const sandboxMissing = vi.fn(() => ['never asked'])

  const { result, shown } = await run({ clone, path }, ['develop', 'pr'], { sandboxMissing })

  expect(shown[0]).toMatchObject({ text: expect.stringContaining('Sandbox: off') })
  expect(shown[1]).toEqual({
    kind: 'warn',
    text: 'The sandbox is off: sessions run in auto mode without boundaries on this machine, with your gh token.',
  })
  expect(sandboxMissing).not.toHaveBeenCalled()
  expect(result).toMatchObject({ ok: true, sandbox: undefined })
})

const UPDATE_QUESTION = {
  kind: 'confirm',
  message: 'groundhog v0.2.0 is out. Update now?',
  initialValue: false,
  active: 'Yes',
  inactive: 'No',
}

test('if there is a newer version, the menu asks about the update first; No starts the run', async () => {
  const { clone, path } = ready()
  const install = vi.fn()

  const { result, shown } = await run({ clone, path }, [false, 'main', 'pr'], {
    update: { newerVersion: () => 'v0.2.0', install },
  })

  expect(shown[0]).toEqual(UPDATE_QUESTION)
  expect(shown[1]).toMatchObject({ kind: 'note', title: 'This run' })
  expect(install).not.toHaveBeenCalled()
  expect(result).toMatchObject({ ok: true, choice: { targetBranch: 'main', finish: 'pr' } })
})

test('Yes to the update installs the tag, ends the start and asks for a new start', async () => {
  const { clone, path } = ready()
  const install = vi.fn()

  const { result, shown } = await run({ clone, path }, [true], {
    update: { newerVersion: () => 'v0.2.0', install },
  })

  expect(shown).toEqual([UPDATE_QUESTION])
  expect(install).toHaveBeenCalledWith('v0.2.0')
  expect(result).toEqual({
    ok: false,
    exitCode: 0,
    message: 'groundhog v0.2.0 is installed. Start again: groundhog 25',
  })
  expect(existsSync(lock(clone))).toBe(false)
})

test('if the update fails, the start aborts with the message', async () => {
  const { clone, path } = ready()

  const { result } = await run({ clone, path }, [true], {
    update: {
      newerVersion: () => 'v0.2.0',
      install: () => {
        throw new Error('The update to v0.2.0 failed.')
      },
    },
  })

  expect(result).toEqual({
    ok: false,
    exitCode: 1,
    message: 'The update to v0.2.0 failed.',
  })
  expect(existsSync(lock(clone))).toBe(false)
})

test('without a newer version the menu does not ask about the update', async () => {
  const { clone, path } = ready()

  const { shown } = await run({ clone, path }, ['main', 'pr'], {
    update: { newerVersion: () => undefined, install: vi.fn() },
  })

  expect(shown[0]).toMatchObject({ kind: 'note', title: 'This run' })
})

/** Remnant of an aborted run: `HEAD` on ticket/7, optionally with a dirty working tree. */
function ticketRemnant(clone: string, dirty: boolean) {
  git(clone, 'checkout', '-q', '-b', 'ticket/7')
  commitFile(clone, 'half.txt', 'x', 'half done')
  if (dirty) {
    writeFileSync(join(clone, 'half.txt'), 'y')
    writeFileSync(join(clone, 'new.txt'), 'x')
  }
}

test('dirty ticket/* remnant: Yes to "Discard the remnant of ticket n?" cleans up, then the menu follows', async () => {
  const { clone, path } = ready()
  ticketRemnant(clone, true)

  const { result, shown } = await run({ clone, path }, [true, 'main', 'pr'])

  expect(result.ok).toBe(true)
  expect(shown[0]).toEqual({
    kind: 'confirm',
    message: 'Discard the remnant of ticket 7?',
    initialValue: false,
    active: 'Yes',
    inactive: 'No',
  })
  expect(shown[1]).toMatchObject({ kind: 'note', title: 'This run' })
  expect(git(clone, 'status', '--porcelain')).toBe('')
})

test('dirty ticket/* remnant: No aborts without changing anything', async () => {
  const { clone, path } = ready()
  ticketRemnant(clone, true)
  const status = git(clone, 'status', '--porcelain')

  const { result } = await run({ clone, path }, [false])

  expect(result).toMatchObject({ ok: false, exitCode: 1 })
  expect(git(clone, 'status', '--porcelain')).toBe(status)
  expect(existsSync(lock(clone))).toBe(false)
})

test('clean ticket/* remnant: the run starts without asking', async () => {
  const { clone, path } = ready()
  ticketRemnant(clone, false)

  const { result, shown } = await run({ clone, path }, ['main', 'pr'])

  expect(result.ok).toBe(true)
  expect(shown[0]).toMatchObject({ kind: 'note', title: 'This run' })
})

test('integration and ticket branches of an earlier run on the remote do not get in the way of the start', async () => {
  const { clone, path } = ready()
  git(clone, 'push', '-q', 'origin', 'main:spec/25', 'main:ticket/7')

  const { result } = await run({ clone, path }, ['main', 'pr'])

  expect(result.ok).toBe(true)
})

const withoutSubIssues: GhAnswer = {
  output: JSON.stringify({
    data: {
      repository: {
        url: 'https://github.com/lucas-devries/groundhog',
        defaultBranchRef: { name: 'main' },
        agent: { name: 'ready-for-agent' },
        human: { name: 'ready-for-human' },
        issue: { subIssues: { totalCount: 0 } },
      },
    },
  }),
}

interface Case {
  reason: string
  ready?: Parameters<typeof ready>[0]
  prepare?: (clone: string) => void
  /** Starts in an empty temp directory instead of the clone. */
  outside?: boolean
  options?: { isTerminal?: boolean; sandboxMissing?: () => string[] }
  message: string[]
}

const CASES: Case[] = [
  {
    reason: 'git is missing',
    ready: { without: ['git'] },
    message: ['git is missing in the PATH'],
  },
  { reason: 'gh is missing', ready: { without: ['gh'] }, message: ['gh is missing in the PATH'] },
  {
    reason: 'the directory is in no Git repo',
    outside: true,
    message: ['groundhog must run in a Git repo.'],
  },
  {
    reason: 'gh is too old',
    ready: { gh: [{ output: 'gh version 2.93.9 (2026-01-01)\n' }] },
    message: ['gh is too old (gh version 2.93.9 (2026-01-01))', '2.94'],
  },
  {
    reason: 'gh is not logged in',
    ready: { gh: [GH_VERSION, { exitCode: 1, error: 'no oauth token found' }] },
    message: ['gh is not logged in', 'gh auth login'],
  },
  {
    reason: 'claude is missing',
    ready: { claude: null },
    message: ['claude is missing in the PATH'],
  },
  {
    reason: 'claude is not logged in',
    ready: { claude: [CLAUDE_VERSION, { exitCode: 1 }] },
    message: ['claude is not logged in', 'claude auth login'],
  },
  {
    reason: 'the project config is missing',
    ready: { config: null },
    message: ['groundhog.json is missing', 'groundhog init'],
  },
  {
    reason: 'the project config is invalid',
    ready: { config: { checks: [], targetBranches: ['main'], extra: 1 } },
    message: ['checks: at least one entry required', 'unknown key: extra'],
  },
  {
    reason: 'another run holds the lock',
    prepare: (clone) =>
      writeFileSync(lock(clone), JSON.stringify({ pid: process.ppid, start: 1, spec: 7 })),
    message: [`A run on spec #7 is already in progress in this clone (PID ${process.ppid})`],
  },
  {
    reason: 'the working tree is dirty',
    prepare: (clone) => writeFileSync(join(clone, 'new.txt'), 'x'),
    message: ['working tree is not clean'],
  },
  {
    reason: 'a branch spec lies on the remote',
    prepare: (clone) => git(clone, 'push', '-q', 'origin', 'main:spec'),
    message: ['branch origin/spec'],
  },
  {
    reason: 'a branch ticket lies locally',
    prepare: (clone) => git(clone, 'branch', 'ticket'),
    message: ['branch ticket'],
  },
  {
    reason: 'a target branch is missing on the remote',
    ready: { config: { ...CONFIG, targetBranches: ['main', 'release'] } },
    message: ['Target branch missing on the remote: release'],
  },
  {
    reason: 'a label is missing',
    ready: {
      gh: [
        GH_VERSION,
        TOKEN,
        USER,
        recording('start-check-without-sub-issues-and-human-label.json'),
      ],
    },
    message: ['missing the label ready-for-human'],
  },
  {
    reason: 'the spec has no sub-issues',
    ready: { gh: [GH_VERSION, TOKEN, USER, withoutSubIssues] },
    message: ['Spec #25 has no sub-issues', 'Sub-issues'],
  },
  {
    reason: 'the spec does not exist',
    ready: {
      gh: [GH_VERSION, TOKEN, USER, { exitCode: 1, error: 'Could not resolve to an Issue' }],
    },
    message: ['Could not resolve to an Issue'],
  },
  {
    reason: 'the sandbox is on but cannot start',
    options: { sandboxMissing: () => ['bwrap not installed', 'Started as root'] },
    message: ['sandbox is on but does not start', '- bwrap not installed\n- Started as root'],
  },
  {
    reason: 'stdin is not a terminal',
    options: { isTerminal: false },
    message: ['terminal on stdin'],
  },
]

test.each(CASES)('the start aborts before the menu if $reason', async (c) => {
  const { clone, fake, path } = ready(c.ready)
  c.prepare?.(clone)
  const refs = git(clone, 'for-each-ref')
  const status = git(clone, 'status', '--porcelain')

  const where = c.outside ? mkdtempSync(join(tmpdir(), 'no-repo-')) : clone
  const { result, shown } = await run({ clone: where, path }, [], c.options)

  if (result.ok) throw new Error('Start did not abort')
  expect(result.exitCode).toBe(1)
  for (const part of c.message) expect(result.message).toContain(part)
  expect(shown).toEqual([])
  // Nothing changed: branches, working tree, tracker; no own lock remains.
  expect(git(clone, 'for-each-ref')).toBe(refs)
  expect(git(clone, 'status', '--porcelain')).toBe(status)
  expect(fake.calls().every((a) => ['--version', 'auth', 'api'].includes(a.args[0] ?? ''))).toBe(
    true,
  )
  if (existsSync(lock(clone))) {
    expect(JSON.parse(readFileSync(lock(clone), 'utf8')).pid).not.toBe(process.pid)
  }
})

const INSTALLATION =
  'claude plugin marketplace add mattpocock/skills && claude plugin install mattpocock-skills@mattpocock'
const USAGE = ['-p', '/usage', '--output-format', 'stream-json', '--verbose']

test('if the skills are missing, the menu asks about the installation; No aborts with the command', async () => {
  const { clone, claude, path } = ready({ claude: [CLAUDE_VERSION, LOGGED_IN, WITHOUT_SKILLS] })

  const { result, shown } = await run({ clone, path }, [false])

  expect(shown).toEqual([
    {
      kind: 'confirm',
      message:
        'The skills mattpocock-skills:implement, mattpocock-skills:tdd, mattpocock-skills:code-review are missing. Install the plugin now?',
      initialValue: true,
      active: 'Yes',
      inactive: 'No',
    },
  ])
  if (result.ok) throw new Error('Start did not abort')
  expect(result.exitCode).toBe(1)
  expect(result.message).toContain(INSTALLATION)
  expect(existsSync(lock(clone))).toBe(false)
  expect(claude?.calls().map((a) => a.args)).toEqual([['--version'], ['auth', 'status'], USAGE])
})

test('without a terminal and without skills the start aborts with the installation command', async () => {
  const { clone, path } = ready({ claude: [CLAUDE_VERSION, LOGGED_IN, WITHOUT_SKILLS] })

  const { result, shown } = await run({ clone, path }, [], { isTerminal: false })

  expect(shown).toEqual([])
  expect(result).toMatchObject({ ok: false, message: expect.stringContaining(INSTALLATION) })
})

test('after the installation groundhog checks the skills again and starts', async () => {
  const { clone, claude, path } = ready({
    claude: [CLAUDE_VERSION, LOGGED_IN, WITHOUT_SKILLS, {}, {}, WITH_SKILLS],
  })

  const { result } = await run({ clone, path }, [true, 'develop', 'pr'])

  expect(claude?.calls().map((a) => a.args)).toEqual([
    ['--version'],
    ['auth', 'status'],
    USAGE,
    ['plugin', 'marketplace', 'add', 'mattpocock/skills'],
    ['plugin', 'install', 'mattpocock-skills@mattpocock'],
    USAGE,
  ])
  expect(result).toMatchObject({ ok: true, versions: { 'mattpocock-skills': '1.3.2' } })
})

test('if the skills are still missing after the installation, groundhog aborts', async () => {
  const { clone, path } = ready({
    claude: [CLAUDE_VERSION, LOGGED_IN, WITHOUT_SKILLS, {}, { exitCode: 1 }, WITHOUT_SKILLS],
  })

  const { result, shown } = await run({ clone, path }, [true])

  expect(shown).toHaveLength(1)
  if (result.ok) throw new Error('Start did not abort')
  expect(result.exitCode).toBe(1)
  expect(result.message).toContain('after the installation')
  expect(result.message).toContain(INSTALLATION)
  expect(existsSync(lock(clone))).toBe(false)
})

test('Ctrl+C at the question about the installation aborts with 130', async () => {
  const { clone, path } = ready({ claude: [CLAUDE_VERSION, LOGGED_IN, WITHOUT_SKILLS] })

  const { result } = await run({ clone, path }, [CANCEL])

  expect(result).toMatchObject({ ok: false, exitCode: 130 })
})

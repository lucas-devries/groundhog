import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { SandboxRuntimeConfigSchema } from '@anthropic-ai/sandbox-runtime'
import { expect, onTestFinished, test, vi } from 'vitest'
import { commonDir, git } from './git.ts'
import { sandboxMissing, srtConfig, srtSandbox } from './sandbox.ts'
import { throwawayRepo, worktreeOf } from './testing/throwaway-repo.ts'

const PATHS = {
  directory: '/home/ada/.cache/groundhog/worktrees/clone-1a2b3c4d/spec-7',
  gitDir: '/work/clone/.git',
  worktreeGitDir: '/work/clone/.git/worktrees/spec-7',
  home: '/home/ada',
  temp: '/tmp',
  settingsDir: '/tmp/srt-x',
}

test('srt config without extra hosts: fixed host list, writing only to the worktree, the shared git directory, Claude, npm cache and temp', () => {
  const config = srtConfig({ ...PATHS, hosts: [] })

  expect(config).toEqual({
    network: {
      allowedDomains: [
        'api.anthropic.com',
        'claude.ai',
        'platform.claude.com',
        'registry.npmjs.org',
        'api.github.com',
        'github.com',
      ],
      deniedDomains: [],
    },
    filesystem: {
      denyRead: ['/home/ada/.ssh', '/home/ada/.config/gh', '/home/ada/.npmrc'],
      allowWrite: [
        '/home/ada/.cache/groundhog/worktrees/clone-1a2b3c4d/spec-7',
        '/work/clone/.git',
        '/home/ada/.claude',
        '/home/ada/.claude.json',
        '/home/ada/.npm',
        '/tmp',
      ],
      denyWrite: [
        '/home/ada/.claude/settings.json',
        '/work/clone/.git/hooks',
        '/work/clone/.git/config',
        '/home/ada/.cache/groundhog/worktrees/clone-1a2b3c4d/spec-7/.git',
        '/work/clone/.git/worktrees/spec-7/commondir',
        '/work/clone/.git/worktrees/spec-7/gitdir',
        '/work/clone/.git/worktrees/spec-7/config.worktree',
        '/tmp/srt-x',
      ],
    },
  })
  expect(SandboxRuntimeConfigSchema.safeParse(config).success).toBe(true)
})

test('srt config with extra hosts: they come after the fixed list', () => {
  const config = srtConfig({
    ...PATHS,
    hosts: ['npm.example.com', '*.internal.example'],
  })

  expect(config.network.allowedDomains).toEqual([
    'api.anthropic.com',
    'claude.ai',
    'platform.claude.com',
    'registry.npmjs.org',
    'api.github.com',
    'github.com',
    'npm.example.com',
    '*.internal.example',
  ])
  expect(SandboxRuntimeConfigSchema.safeParse(config).success).toBe(true)
})

test('sandbox that can start: nothing missing', () => {
  expect(sandboxMissing({ dependencies: () => [], uid: 1000 })).toEqual([])
})

test('sandbox that cannot start: names missing tools and starting as root', () => {
  const missing = sandboxMissing({
    dependencies: () => [
      'bubblewrap (bwrap) not installed',
      'socat not installed',
      'ripgrep (rg) not found',
    ],
    uid: 0,
  })

  expect(missing).toEqual([
    'bubblewrap (bwrap) not installed',
    'socat not installed',
    'ripgrep (rg) not found',
    'Started as root: claude does not start with bypass as root',
  ])
})

test('srtSandbox starts a command via the srt CLI with a protected config for the worktree', () => {
  const { clone } = throwawayRepo()
  const worktree = worktreeOf(clone)
  git(clone, 'worktree', 'add', '-q', '--detach', worktree)
  const sandbox = srtSandbox(['npm.example.com'], commonDir(clone))
  const argv = sandbox.wrap(['claude', '-p', 'a b'], worktree)

  const [node, cli, flag, file, separator, ...command] = argv
  expect(node).toBe(process.execPath)
  expect(cli).toMatch(/@anthropic-ai\/sandbox-runtime\/dist\/cli\.js$/)
  expect(existsSync(cli ?? '')).toBe(true)
  expect([flag, separator, command]).toEqual(['--settings', '--', ['claude', '-p', 'a b']])
  expect(JSON.parse(readFileSync(file ?? '', 'utf8'))).toEqual(
    srtConfig({
      directory: worktree,
      gitDir: commonDir(clone),
      worktreeGitDir: join(commonDir(clone), 'worktrees', basename(worktree)),
      hosts: ['npm.example.com'],
      home: homedir(),
      temp: tmpdir(),
      settingsDir: dirname(file ?? ''),
    }),
  )
})

/** Whether `srt` starts here at all; it does not inside another sandbox or without its tools. */
const probe = throwawayRepo().clone
const srtStarts = await srtSandbox([], commonDir(probe))
  .execute('true', { directory: probe, signal: AbortSignal.timeout(30_000) })
  .then(({ exitCode }) => exitCode === 0)

test.runIf(srtStarts)('for real: a session in srt can commit in a worktree', async () => {
  const { clone } = throwawayRepo()
  const worktree = worktreeOf(clone)
  git(clone, 'worktree', 'add', '-q', '--detach', worktree)
  // Temp is writable as a whole; narrowed, so that the clone lies outside it.
  const temp = join(dirname(clone), 'temp')
  mkdirSync(temp)
  vi.stubEnv('TMPDIR', temp)
  onTestFinished(() => {
    vi.unstubAllEnvs()
  })
  const sandbox = srtSandbox([], commonDir(clone))
  const execute = (command: string) =>
    sandbox.execute(command, { directory: worktree, signal: AbortSignal.timeout(30_000) })
  const own = join(commonDir(clone), 'worktrees', basename(worktree))

  const commit = await execute('echo a > a.txt && git add a.txt && git commit -q -m inside')

  expect(commit.exitCode, commit.output).toBe(0)
  expect(git(worktree, 'log', '--format=%s', '-1')).toBe('inside')
  for (const command of [
    `echo x > '${clone}/.git/hooks/pre-commit'`,
    'git config user.name other',
    'echo x > .git',
    `echo x > '${own}/commondir'`,
    `echo x > '${clone}/human.txt'`,
  ]) {
    expect((await execute(command)).exitCode, command).not.toBe(0)
  }
  expect(existsSync(join(clone, 'human.txt'))).toBe(false)
})

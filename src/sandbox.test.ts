import { existsSync, readFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname } from 'node:path'
import { SandboxRuntimeConfigSchema } from '@anthropic-ai/sandbox-runtime'
import { expect, test } from 'vitest'
import { sandboxMissing, srtConfig, srtSandbox } from './sandbox.ts'

const PATHS = {
  directory: '/work/clone',
  home: '/home/ada',
  temp: '/tmp',
  settingsDir: '/tmp/srt-x',
}

test('srt config without extra hosts: fixed host list, writing only to the working tree, Claude, npm cache and temp', () => {
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
        '/work/clone',
        '/home/ada/.claude',
        '/home/ada/.claude.json',
        '/home/ada/.npm',
        '/tmp',
      ],
      denyWrite: [
        '/home/ada/.claude/settings.json',
        '/work/clone/.git/hooks',
        '/work/clone/.git/config',
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

test('srtSandbox starts a command via the srt CLI with a protected config for the working tree', () => {
  const argv = srtSandbox(['npm.example.com']).wrap(['claude', '-p', 'a b'], '/work/clone')

  const [node, cli, flag, file, separator, ...command] = argv
  expect(node).toBe(process.execPath)
  expect(cli).toMatch(/@anthropic-ai\/sandbox-runtime\/dist\/cli\.js$/)
  expect(existsSync(cli ?? '')).toBe(true)
  expect([flag, separator, command]).toEqual(['--settings', '--', ['claude', '-p', 'a b']])
  expect(JSON.parse(readFileSync(file ?? '', 'utf8'))).toEqual(
    srtConfig({
      directory: '/work/clone',
      hosts: ['npm.example.com'],
      home: homedir(),
      temp: tmpdir(),
      settingsDir: dirname(file ?? ''),
    }),
  )
})

import { existsSync, readFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname } from 'node:path'
import { SandboxRuntimeConfigSchema } from '@anthropic-ai/sandbox-runtime'
import { expect, test } from 'vitest'
import { sandboxFehlt, srtKonfiguration, srtSandbox } from './sandbox.ts'

const ORTE = {
  verzeichnis: '/arbeit/klon',
  home: '/home/ada',
  temp: '/tmp',
  geschuetzt: '/tmp/srt-x',
}

test('srt-Config ohne zusätzliche Hosts: feste Host-Liste, Schreiben nur in Arbeitsverzeichnis, Claude, npm-Cache und Temp', () => {
  const konfiguration = srtKonfiguration({ ...ORTE, hosts: [] })

  expect(konfiguration).toEqual({
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
        '/arbeit/klon',
        '/home/ada/.claude',
        '/home/ada/.claude.json',
        '/home/ada/.npm',
        '/tmp',
      ],
      denyWrite: [
        '/home/ada/.claude/settings.json',
        '/arbeit/klon/.git/hooks',
        '/arbeit/klon/.git/config',
        '/tmp/srt-x',
      ],
    },
  })
  expect(SandboxRuntimeConfigSchema.safeParse(konfiguration).success).toBe(true)
})

test('srt-Config mit zusätzlichen Hosts: sie kommen nach der festen Liste dazu', () => {
  const konfiguration = srtKonfiguration({
    ...ORTE,
    hosts: ['npm.example.com', '*.intern.example'],
  })

  expect(konfiguration.network.allowedDomains).toEqual([
    'api.anthropic.com',
    'claude.ai',
    'platform.claude.com',
    'registry.npmjs.org',
    'api.github.com',
    'github.com',
    'npm.example.com',
    '*.intern.example',
  ])
  expect(SandboxRuntimeConfigSchema.safeParse(konfiguration).success).toBe(true)
})

test('startbare Sandbox: nichts fehlt', () => {
  expect(sandboxFehlt({ abhaengigkeiten: () => [], uid: 1000 })).toEqual([])
})

test('nicht startbare Sandbox: nennt fehlende Werkzeuge und den Start als root', () => {
  const fehlt = sandboxFehlt({
    abhaengigkeiten: () => [
      'bubblewrap (bwrap) not installed',
      'socat not installed',
      'ripgrep (rg) not found',
    ],
    uid: 0,
  })

  expect(fehlt).toEqual([
    'bubblewrap (bwrap) not installed',
    'socat not installed',
    'ripgrep (rg) not found',
    'Start als root: claude startet als root nicht mit Bypass',
  ])
})

test('srtSandbox startet einen Befehl über die srt-CLI mit einer geschützten Config für das Arbeitsverzeichnis', () => {
  const argv = srtSandbox(['npm.example.com']).umhuelle(['claude', '-p', 'a b'], '/arbeit/klon')

  const [node, cli, schalter, datei, trenner, ...befehl] = argv
  expect(node).toBe(process.execPath)
  expect(cli).toMatch(/@anthropic-ai\/sandbox-runtime\/dist\/cli\.js$/)
  expect(existsSync(cli ?? '')).toBe(true)
  expect([schalter, trenner, befehl]).toEqual(['--settings', '--', ['claude', '-p', 'a b']])
  expect(JSON.parse(readFileSync(datei ?? '', 'utf8'))).toEqual(
    srtKonfiguration({
      verzeichnis: '/arbeit/klon',
      hosts: ['npm.example.com'],
      home: homedir(),
      temp: tmpdir(),
      geschuetzt: dirname(datei ?? ''),
    }),
  )
})

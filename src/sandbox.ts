import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { SandboxManager } from '@anthropic-ai/sandbox-runtime'
import { git } from './git.ts'

export interface Execution {
  exitCode: number
  /** stdout and stderr, in the order they came. */
  output: string
}

/** The sandbox: executes a command. Behind it: `srt` adapter (#34), passthrough. */
export interface Sandbox {
  /** If `signal` aborts, the sandbox ends the command including its child processes. */
  execute(command: string, options: { directory: string; signal: AbortSignal }): Promise<Execution>
}

/** Passthrough without boundaries: executes the command directly in the shell. */
export const passthrough: Sandbox = {
  execute: (command, options) => run([command], options, true),
}

/** The `srt` sandbox; `wrap` gives the Claude adapter the call that starts `claude` inside it. */
export interface SrtSandbox extends Sandbox {
  wrap(command: string[], directory: string): string[]
}

const SRT_CLI = createRequire(import.meta.url).resolve('@anthropic-ai/sandbox-runtime/dist/cli.js')

/** The sandbox with `srt`: fixed host list plus `hosts`, file system as in `srtConfig`. */
export function srtSandbox(hosts: string[], gitDir: string): SrtSandbox {
  // ponytail: the folder stays in temp after the run (one small file).
  const settingsDir = mkdtempSync(join(tmpdir(), 'groundhog-srt-'))
  const call = (directory: string, rest: string[]) => {
    const file = join(settingsDir, 'settings.json')
    const worktreeGitDir = git(directory, 'rev-parse', '--absolute-git-dir')
    const paths = {
      directory,
      gitDir,
      worktreeGitDir,
      hosts,
      home: homedir(),
      temp: tmpdir(),
      settingsDir,
    }
    writeFileSync(file, JSON.stringify(srtConfig(paths)))
    return [process.execPath, SRT_CLI, '--settings', file, ...rest]
  }
  return {
    wrap: (command, directory) => call(directory, ['--', ...command]),
    execute: (command, options) => run(call(options.directory, ['-c', command]), options),
  }
}

/** Starts `argv` and collects the output. If `signal` aborts, the whole process group dies. */
function run(
  [file = '', ...args]: string[],
  { directory, signal }: { directory: string; signal: AbortSignal },
  shell = false,
): Promise<Execution> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      cwd: directory,
      shell,
      stdio: ['ignore', 'pipe', 'pipe'],
      // Own process group, so that an abort also hits the shell's child processes.
      detached: true,
    })
    const kill = () => {
      try {
        if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL')
      } catch {
        // The group is already gone.
      }
    }
    if (signal.aborted) kill()
    signal.addEventListener('abort', kill, { once: true })
    child.on('close', () => signal.removeEventListener('abort', kill))
    let output = ''
    child.stdout.on('data', (d) => {
      output += d
    })
    child.stderr.on('data', (d) => {
      output += d
    })
    child.on('error', reject)
    child.on('close', (code) => resolve({ exitCode: code ?? 1, output }))
  })
}

/** The fixed host list every sandbox reaches; `sandbox.hosts` comes on top. */
export const FIXED_HOSTS = [
  'api.anthropic.com',
  'claude.ai',
  'platform.claude.com',
  'registry.npmjs.org',
  'api.github.com',
  'github.com',
]

/** The paths the `srt` config is built from. */
export interface SrtPaths {
  /** The run's worktree. */
  directory: string
  /** The git directory the clone shares with the worktree: objects, refs and index live there. */
  gitDir: string
  /** The worktree's own part of `gitDir`, `worktrees/<name>`. */
  worktreeGitDir: string
  hosts: string[]
  home: string
  temp: string
  /** Folder of the config files; not writable, so that a session can't change the next one's boundaries. */
  settingsDir: string
}

/** The `srt` config of a session or check. */
export function srtConfig(paths: SrtPaths) {
  const { directory, gitDir, worktreeGitDir, hosts, home, temp, settingsDir } = paths
  return {
    network: { allowedDomains: [...FIXED_HOSTS, ...hosts], deniedDomains: [] },
    filesystem: {
      denyRead: [join(home, '.ssh'), join(home, '.config/gh'), join(home, '.npmrc')],
      allowWrite: [
        directory,
        gitDir,
        join(home, '.claude'),
        join(home, '.claude.json'),
        // ponytail: npm's default cache; a cache moved via `npm_config_cache` stays locked.
        join(home, '.npm'),
        temp,
      ],
      denyWrite: [
        join(home, '.claude/settings.json'),
        join(gitDir, 'hooks'),
        join(gitDir, 'config'),
        // The file that points the worktree at its repository.
        join(directory, '.git'),
        // They could point the engine's git, outside the sandbox, at other hooks and config.
        join(worktreeGitDir, 'commondir'),
        join(worktreeGitDir, 'gitdir'),
        join(worktreeGitDir, 'config.worktree'),
        settingsDir,
      ],
    },
  }
}

/**
 * What is missing for the sandbox to start; empty means it can start. Checks the tools of `srt`
 * (on Linux `bubblewrap`, `socat`, `ripgrep`) and starting as root, where `claude` refuses bypass.
 */
export function sandboxMissing({
  dependencies = () => SandboxManager.checkDependencies().errors,
  uid = process.getuid?.(),
}: {
  dependencies?: () => string[]
  uid?: number
} = {}): string[] {
  const missing = dependencies()
  if (uid === 0) missing.push('Started as root: claude does not start with bypass as root')
  return missing
}

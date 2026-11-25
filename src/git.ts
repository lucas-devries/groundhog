import { execFileSync } from 'node:child_process'

/**
 * Runs `git` in the directory and returns stdout without trailing whitespace. Throws on exit ≠ 0.
 * Runs in its own process group (without a terminal): the first Ctrl+C aborts nothing, so it must
 * not hit `git` either.
 */
export function git(directory: string, ...args: string[]): string {
  // Node honours `detached` for the sync variant too; only the types don't know it there.
  const options = { cwd: directory, encoding: 'utf8', stdio: 'pipe', detached: true } as const
  return execFileSync('git', args, options).trimEnd()
}

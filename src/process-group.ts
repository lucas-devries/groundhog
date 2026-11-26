import { spawn } from 'node:child_process'
import type { Readable } from 'node:stream'

/**
 * Runs `argv` in its own process group, with stdin on `/dev/null`; `read` gets stdout and stderr.
 * If `signal` aborts, the whole group dies, so that the abort also hits the child processes.
 * Returns the exit code (`null` after a signal).
 */
export function runInProcessGroup(
  [file = '', ...args]: string[],
  {
    signal,
    ...options
  }: { cwd: string; env?: NodeJS.ProcessEnv; shell?: boolean; signal?: AbortSignal },
  read: (stdout: Readable, stderr: Readable) => void,
): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      ...options,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    })
    const kill = () => {
      try {
        if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL')
      } catch {
        // The group is already gone.
      }
    }
    if (signal?.aborted) kill()
    signal?.addEventListener('abort', kill, { once: true })
    read(child.stdout, child.stderr)
    child.on('error', reject)
    child.on('close', (code) => {
      signal?.removeEventListener('abort', kill)
      resolve(code)
    })
  })
}

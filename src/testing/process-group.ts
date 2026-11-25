import { execFileSync } from 'node:child_process'
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** The process group of this process; a Ctrl+C in the terminal hits every process in it. */
export function ownProcessGroup(): string {
  return execFileSync('ps', ['-o', 'pgid=', '-p', String(process.pid)], { encoding: 'utf8' }).trim()
}

/** A folder with a tool `name` that only prints its process group; belongs at the front of `PATH`. */
export function reportsProcessGroup(name: string): string {
  const directory = mkdtempSync(join(tmpdir(), 'pgid-'))
  writeFileSync(join(directory, name), '#!/bin/sh\nps -o pgid= -p $$\n')
  chmodSync(join(directory, name), 0o755)
  return directory
}

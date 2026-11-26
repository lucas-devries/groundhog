import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Vitest global setup: gives the test run its own temp directory and removes it afterwards.
 * Otherwise the fixtures of every run pile up until the temp volume has no inodes left.
 */
export default function isolateTempDirectory() {
  const directory = mkdtempSync(join(tmpdir(), 'groundhog-test-'))
  process.env.TMPDIR = directory
  return () => rmSync(directory, { recursive: true, force: true })
}

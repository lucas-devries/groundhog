import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { git } from '../git.ts'

/**
 * Throwaway repo in the temp directory: a bare remote and a clone of it, `main` pushed with the
 * commit "init".
 */
export function throwawayRepo(): { remote: string; clone: string; newClone: () => string } {
  const base = mkdtempSync(join(tmpdir(), 'groundhog-'))
  const remote = join(base, 'remote.git')
  git(base, 'init', '--bare', '-b', 'main', remote)
  let clones = 0
  const newClone = () => {
    const clone = join(base, `clone-${clones++}`)
    git(base, 'clone', '-q', remote, clone)
    git(clone, 'config', 'user.name', 'Test')
    git(clone, 'config', 'user.email', 'test@example.com')
    return clone
  }
  const clone = newClone()
  commitFile(clone, 'README.md', 'init', 'init')
  git(clone, 'push', '-q', 'origin', 'main')
  return { remote, clone, newClone }
}

/** Writes a file and commits it on the checked-out branch. */
export function commitFile(directory: string, file: string, content: string, message: string) {
  writeFileSync(join(directory, file), content)
  git(directory, 'add', file)
  git(directory, 'commit', '-q', '-m', message)
}

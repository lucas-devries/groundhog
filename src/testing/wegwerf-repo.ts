import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { git } from '../git.ts'

/**
 * Wegwerf-Repo im Temp-Verzeichnis: ein Bare-Remote und ein Klon davon,
 * `main` mit dem Commit „init“ gepusht.
 */
export function wegwerfRepo(): { remote: string; klon: string; neuerKlon: () => string } {
  const basis = mkdtempSync(join(tmpdir(), 'groundhog-'))
  const remote = join(basis, 'remote.git')
  git(basis, 'init', '--bare', '-b', 'main', remote)
  let klone = 0
  const neuerKlon = () => {
    const klon = join(basis, `klon-${klone++}`)
    git(basis, 'clone', '-q', remote, klon)
    git(klon, 'config', 'user.name', 'Test')
    git(klon, 'config', 'user.email', 'test@example.com')
    return klon
  }
  const klon = neuerKlon()
  commitDatei(klon, 'README.md', 'init', 'init')
  git(klon, 'push', '-q', 'origin', 'main')
  return { remote, klon, neuerKlon }
}

/** Schreibt eine Datei und committet sie auf dem ausgecheckten Branch. */
export function commitDatei(verzeichnis: string, datei: string, inhalt: string, message: string) {
  writeFileSync(join(verzeichnis, datei), inhalt)
  git(verzeichnis, 'add', datei)
  git(verzeichnis, 'commit', '-q', '-m', message)
}

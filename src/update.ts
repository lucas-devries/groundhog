import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'

/** Die installierte Version. Ein Release entsteht mit `npm version <x>`, das den Tag mit anlegt. */
export const VERSION: string = createRequire(import.meta.url)('../package.json').version

const REPO = 'lucas-devries/groundhog'
/** Die Erstinstallation ist `npm install -g github:lucas-devries/groundhog`; `prepare` baut mit `tsc`. */
const paket = (tag: string) => `github:${REPO}#${tag}`

// ponytail: nur X.Y.Z, Pre-Release-Tags zählen nicht.
const SEMVER = /^v?(\d+)\.(\d+)\.(\d+)$/

function vergleiche(a: string, b: string): number {
  const x = (a.match(SEMVER) ?? []).slice(1).map(Number)
  const y = (b.match(SEMVER) ?? []).slice(1).map(Number)
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return (x[i] ?? 0) - (y[i] ?? 0)
  return 0
}

/** Der neueste SemVer-Tag des groundhog-Repos, ohne GitHub Release; wirft, wenn GitHub nicht antwortet. */
function neuesterTag(): string | undefined {
  const lauf = spawnSync('gh', ['api', '--paginate', `repos/${REPO}/tags`, '--jq', '.[].name'], {
    encoding: 'utf8',
    timeout: 15_000,
  })
  if (lauf.status !== 0) throw new Error(lauf.stderr?.trim() || String(lauf.error))
  return lauf.stdout
    .split('\n')
    .filter((t) => SEMVER.test(t))
    .sort(vergleiche)
    .at(-1)
}

/** Der neueste Tag, falls er neuer ist als `version`. Ein gescheiterter Vergleich bleibt stumm. */
export function neuereVersion(version = VERSION): string | undefined {
  try {
    const tag = neuesterTag()
    return tag && vergleiche(tag, version) > 0 ? tag : undefined
  } catch {
    return undefined
  }
}

/** Installiert `tag` global auf demselben Weg wie die Erstinstallation; wirft, wenn npm scheitert. */
export function installiere(tag: string): void {
  const lauf = spawnSync('npm', ['install', '-g', paket(tag)], { stdio: 'inherit' })
  if (lauf.status !== 0) {
    throw new Error(`Das Update auf ${tag} ist gescheitert (npm install -g ${paket(tag)}).`)
  }
}

/** `groundhog update`: installiert den neuesten Tag oder meldet, dass die Version aktuell ist. */
export function aktualisiere(version = VERSION): { exitCode: number; meldung: string } {
  let tag: string | undefined
  try {
    tag = neuesterTag()
  } catch (fehler) {
    return {
      exitCode: 1,
      meldung: `Die neueste Version ließ sich nicht ermitteln: ${(fehler as Error).message}`,
    }
  }
  if (!tag || vergleiche(tag, version) <= 0) {
    return { exitCode: 0, meldung: `groundhog ${version} ist aktuell.` }
  }
  try {
    installiere(tag)
  } catch (fehler) {
    return { exitCode: 1, meldung: (fehler as Error).message }
  }
  return { exitCode: 0, meldung: `groundhog ${tag} ist installiert.` }
}

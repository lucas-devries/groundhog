import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'

/** The installed version. A release is made with `npm version <x>`, which also creates the tag. */
export const VERSION: string = createRequire(import.meta.url)('../package.json').version

const REPO = 'lucas-devries/groundhog'
/** The first install is `npm install -g github:lucas-devries/groundhog`; `prepare` builds with `tsc`. */
const pkg = (tag: string) => `github:${REPO}#${tag}`

// ponytail: only X.Y.Z, pre-release tags don't count.
const SEMVER = /^v?(\d+)\.(\d+)\.(\d+)$/

function compare(a: string, b: string): number {
  const x = (a.match(SEMVER) ?? []).slice(1).map(Number)
  const y = (b.match(SEMVER) ?? []).slice(1).map(Number)
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return (x[i] ?? 0) - (y[i] ?? 0)
  return 0
}

/** The newest SemVer tag of the groundhog repo, without a GitHub release; throws if GitHub doesn't answer. */
function newestTag(): string | undefined {
  const result = spawnSync('gh', ['api', '--paginate', `repos/${REPO}/tags`, '--jq', '.[].name'], {
    encoding: 'utf8',
    timeout: 15_000,
  })
  if (result.status !== 0) throw new Error(result.stderr?.trim() || String(result.error))
  return result.stdout
    .split('\n')
    .filter((t) => SEMVER.test(t))
    .sort(compare)
    .at(-1)
}

/** The newest tag, if it is newer than `version`. A failed comparison stays silent. */
export function newerVersion(version = VERSION): string | undefined {
  try {
    const tag = newestTag()
    return tag && compare(tag, version) > 0 ? tag : undefined
  } catch {
    return undefined
  }
}

/** Installs `tag` globally the same way as the first install; throws if npm fails. */
export function install(tag: string): void {
  const result = spawnSync('npm', ['install', '-g', pkg(tag)], { stdio: 'inherit' })
  if (result.status !== 0) {
    throw new Error(`The update to ${tag} failed (npm install -g ${pkg(tag)}).`)
  }
}

/** `groundhog update`: installs the newest tag or reports that the version is up to date. */
export function update(version = VERSION): { exitCode: number; message: string } {
  let tag: string | undefined
  try {
    tag = newestTag()
  } catch (error) {
    return {
      exitCode: 1,
      message: `Could not determine the newest version: ${(error as Error).message}`,
    }
  }
  if (!tag || compare(tag, version) <= 0) {
    return { exitCode: 0, message: `groundhog ${version} is up to date.` }
  }
  try {
    install(tag)
  } catch (error) {
    return { exitCode: 1, message: (error as Error).message }
  }
  return { exitCode: 0, message: `groundhog ${tag} is installed.` }
}

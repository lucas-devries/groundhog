import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'

/** The installed version. A release is made with `npm version <x>` and pushing the tag; CI publishes it to npm. */
export const VERSION: string = createRequire(import.meta.url)('../package.json').version

/** The package on npm; the first install is `npm install -g groundhog-cli`. */
const PACKAGE = 'groundhog-cli'
const pkg = (version: string) => `${PACKAGE}@${version}`

// ponytail: only X.Y.Z, pre-releases don't count.
const SEMVER = /^v?(\d+)\.(\d+)\.(\d+)$/

function compare(a: string, b: string): number {
  const x = (a.match(SEMVER) ?? []).slice(1).map(Number)
  const y = (b.match(SEMVER) ?? []).slice(1).map(Number)
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return (x[i] ?? 0) - (y[i] ?? 0)
  return 0
}

/** The newest version of the package on npm; throws if npm doesn't answer. */
function newestVersion(): string | undefined {
  const result = spawnSync('npm', ['view', PACKAGE, 'version'], {
    encoding: 'utf8',
    timeout: 15_000,
  })
  if (result.status !== 0) throw new Error(result.stderr?.trim() || String(result.error))
  const version = result.stdout.trim()
  return SEMVER.test(version) ? version : undefined
}

/** The newest version, if it is newer than `version`. A failed comparison stays silent. */
export function newerVersion(version = VERSION): string | undefined {
  try {
    const tag = newestVersion()
    return tag && compare(tag, version) > 0 ? tag : undefined
  } catch {
    return undefined
  }
}

/** Installs `tag` globally from npm; throws if npm fails. */
export function install(tag: string): void {
  const result = spawnSync('npm', ['install', '-g', pkg(tag)], { stdio: 'inherit' })
  if (result.status !== 0) {
    throw new Error(`The update to ${tag} failed (npm install -g ${pkg(tag)}).`)
  }
}

/** `groundhog update`: installs the newest version or reports that the version is up to date. */
export function update(version = VERSION): { exitCode: number; message: string } {
  let tag: string | undefined
  try {
    tag = newestVersion()
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

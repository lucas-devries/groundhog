import { createHash } from 'node:crypto'
import { existsSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { integrationBranch, ticketBranchOf } from './choice.ts'
import { branchExists, commonDir, git } from './git.ts'
import type { Tracker } from './tracker.ts'

/** The worktree of a run, ready on the integration branch of its spec. */
export interface Worktree {
  /** `setup` has to run: the worktree is new. */
  setupDue: boolean
  /** Records that `setup` ran through, and discards what it left outside the ignored files. */
  setupDone(): void
  /** Throws away the work in the worktree; everything there is the agent's. */
  discard(): void
  /** A failed removal only warns: it must not cost the summary. */
  remove(): void
}

/** A worktree as git lists it; without a branch if its `HEAD` is detached. */
interface Listed {
  path: string
  branch: string | undefined
}

/**
 * Where the worktrees of a clone lie, outside the repo (ADR 0001). The hash of the shared git
 * directory keeps two clones apart and gives every worktree of one clone the same folder.
 */
export function worktreePaths(clone: string): (spec: number) => string {
  const main = listWorktrees(clone)[0]?.path ?? ''
  const hash = createHash('sha256').update(commonDir(clone)).digest('hex').slice(0, 8)
  const folder = `${basename(main)}-${hash}`
  const root = join(homedir(), '.cache/groundhog/worktrees', folder)
  return (spec) => join(root, `spec-${spec}`)
}

/**
 * The first branch of the spec checked out outside the run's own worktree. Git refuses to check out
 * a branch in two worktrees, and the human's branch is never switched for them.
 */
export async function checkedOutElsewhere(
  clone: string,
  spec: number,
  own: string,
  tracker: Tracker,
): Promise<Listed | undefined> {
  const elsewhere = listWorktrees(clone).filter((w) => resolvedPath(w.path) !== resolvedPath(own))
  const found = elsewhere.find((w) => w.branch === integrationBranch(spec))
  // A ticket branch does not name its spec, so only the tracker knows whether it is one of ours.
  if (found || !elsewhere.some((w) => w.branch?.startsWith('ticket/'))) return found
  const tickets = await tracker.taskGraph(spec)
  return elsewhere.find((w) => tickets.some((t) => w.branch === ticketBranchOf(t.number)))
}

/**
 * Creates the worktree at `path` or reuses the one there, without any leftover, and checks out the
 * integration branch: as pushed, otherwise the local one, otherwise new from the target branch.
 */
export function prepareWorktree({
  clone,
  path,
  spec,
  targetBranch,
  hasSetup,
  warn,
}: {
  /** Repo root of the clone. */
  clone: string
  path: string
  spec: number
  targetBranch: string
  /** The project config has `setup` commands. */
  hasSetup: boolean
  warn: (text: string) => void
}): Worktree {
  /**
   * Lies in the worktree's git directory until `setup` has run through. A worktree that still has
   * it (failed removal, abort, crash) is created anew, so that `setup` is never skipped.
   */
  const setupMarker = () =>
    join(git(path, 'rev-parse', '--absolute-git-dir'), 'groundhog-setup-pending')
  const fresh = !isWorktreeOf(clone, path) || existsSync(setupMarker())
  if (fresh) {
    rmSync(path, { recursive: true, force: true })
    // -f twice also replaces a stale registration of this path, even a locked one.
    git(clone, 'worktree', 'add', '-q', '-f', '-f', '--detach', path)
    if (hasSetup) writeFileSync(setupMarker(), '')
  }
  const discard = () => {
    git(path, 'reset', '-q', '--hard')
    git(path, 'clean', '-q', '-fd')
  }
  discard()
  git(path, 'fetch', '-q', 'origin')
  const integration = integrationBranch(spec)
  if (git(path, 'branch', '-r', '--list', `origin/${integration}`)) {
    // The pushed state is what counts.
    git(path, 'checkout', '-q', '--no-track', '-B', integration, `origin/${integration}`)
  } else {
    if (!branchExists(path, integration)) {
      git(path, 'branch', '-q', '--no-track', integration, `origin/${targetBranch}`)
    }
    git(path, 'checkout', '-q', integration)
  }
  return {
    setupDue: fresh,
    setupDone() {
      rmSync(setupMarker(), { force: true })
      // Only ignored files may stay; anything else would turn the first ticket red.
      discard()
    },
    discard,
    remove() {
      try {
        git(clone, 'worktree', 'remove', '--force', path)
      } catch (error) {
        warn(`Removing the worktree ${path} failed: ${(error as Error).message}`)
      }
    },
  }
}

/** The worktrees git lists for the clone; the main one comes first, wherever git is asked from. */
function listWorktrees(clone: string): Listed[] {
  return git(clone, 'worktree', 'list', '--porcelain')
    .split('\n\n')
    .map((block) => ({
      path: block.match(/^worktree (.*)$/m)?.[1] ?? '',
      branch: block.match(/^branch refs\/heads\/(.*)$/m)?.[1],
    }))
}

/** `realpath` that also works for a missing folder, as a stale worktree registration has one. */
function resolvedPath(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    const parent = dirname(path)
    return parent === path ? path : join(resolvedPath(parent), basename(path))
  }
}

/**
 * Whether the folder is a working worktree of the clone. Anything else must not be handed to
 * `reset` or `clean`: git would then act on whatever repo lies above it.
 */
function isWorktreeOf(clone: string, folder: string): boolean {
  try {
    return (
      git(folder, 'rev-parse', '--show-toplevel') === realpathSync(folder) &&
      realpathSync(commonDir(folder)) === realpathSync(commonDir(clone))
    )
  } catch {
    // Usually no folder or no repo there. Any other git error replaces the folder too, which
    // costs nothing: all it holds is the agent's (ADR 0001).
    return false
  }
}

import type { Position } from './display.ts'

/**
 * Runs the specs of a batch one after another and stops at the first run that does not end with
 * exit code 0. `run` drives one run and returns its exit code. Returns the exit code of the last
 * run that ran and the overview, one line per spec; a batch of one has no overview.
 */
export async function runBatch(
  specs: number[],
  run: (spec: number, position: Position) => Promise<number>,
): Promise<{ exitCode: number; overview: string[] }> {
  const codes: number[] = []
  let exitCode = 0
  for (const [i, spec] of specs.entries()) {
    exitCode = await run(spec, { index: i + 1, total: specs.length })
    codes.push(exitCode)
    if (exitCode !== 0) break
  }
  const overview = specs.map((spec, i) => `#${spec} ${outcome(codes[i])}`)
  return { exitCode, overview: specs.length > 1 ? overview : [] }
}

/** How the overview names a run's exit code; `undefined` means the run never ran. */
function outcome(exitCode: number | undefined): string {
  if (exitCode === undefined) return 'not started'
  if (exitCode === 0) return 'green'
  return exitCode === 2 ? 'ready-for-human' : 'aborted'
}

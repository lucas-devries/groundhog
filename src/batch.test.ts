import { expect, test } from 'vitest'
import { runBatch } from './batch.ts'

/** Runs the batch over specs 57, 58 and 61; `codes` are the exit codes of the runs in order. */
async function batch(...codes: number[]) {
  const ran: unknown[] = []
  const result = await runBatch([57, 58, 61], async (spec, position) => {
    ran.push([spec, position])
    return codes[ran.length - 1] as number
  })
  return { ...result, ran }
}

test('after runs with exit code 0 the batch goes on, in order and with the position', async () => {
  expect(await batch(0, 0, 0)).toEqual({
    exitCode: 0,
    overview: ['#57 green', '#58 green', '#61 green'],
    ran: [
      [57, { index: 1, total: 3 }],
      [58, { index: 2, total: 3 }],
      [61, { index: 3, total: 3 }],
    ],
  })
})

test.each([
  { code: 2, result: 'ready-for-human' },
  { code: 1, result: 'aborted' },
  { code: 130, result: 'aborted' },
])('exit code $code stops the batch and is its exit code', async ({ code, result }) => {
  const { exitCode, overview, ran } = await batch(0, code)

  expect(exitCode).toBe(code)
  expect(overview).toEqual(['#57 green', `#58 ${result}`, '#61 not started'])
  expect(ran).toHaveLength(2)
})

test('a batch of one has no overview', async () => {
  expect(await runBatch([57], async () => 2)).toEqual({ exitCode: 2, overview: [] })
})

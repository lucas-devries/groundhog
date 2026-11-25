import { delimiter } from 'node:path'
import { afterEach, expect, test, vi } from 'vitest'
import { GitHubTracker } from './github.ts'
import { fakeGh, type GhAnswer, recording } from './testing/fake-gh.ts'
import { ownProcessGroup, reportsProcessGroup } from './testing/process-group.ts'

afterEach(() => {
  vi.unstubAllEnvs()
})

/** A GitHubTracker against a fake `gh`; the first answer is the logged-in user. */
async function connected(answers: GhAnswer[]) {
  const gh = fakeGh([{ output: 'lucas-devries\n' }, ...answers])
  vi.stubEnv('PATH', `${gh.directory}${delimiter}${process.env.PATH}`)
  const delays: number[] = []
  const tracker = await GitHubTracker.connect({
    directory: process.cwd(),
    wait: async (ms) => {
      delays.push(ms)
    },
  })
  return {
    tracker,
    delays,
    calls: () =>
      gh
        .calls()
        .slice(1)
        .map((a) => a.args),
  }
}

test('the logged-in gh user is the user of the tracker', async () => {
  const { tracker } = await connected([])
  expect(tracker.user).toBe('lucas-devries')
})

test('the task-graph is the sub-issues of the spec with state, labels, assignees and blockers, from one GraphQL query', async () => {
  const { tracker, calls } = await connected([recording('task-graph-spec-25.json')])

  const tickets = await tracker.taskGraph(25)

  expect(tickets.map((t) => t.number)).toEqual([
    26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44,
  ])
  expect(tickets.find((t) => t.number === 32)).toEqual({
    number: 32,
    open: true,
    labels: ['ready-for-agent'],
    assignees: [],
    blockers: [
      { number: 27, open: true },
      { number: 28, open: true },
    ],
  })
  const [call, ...more] = calls()
  expect(more).toEqual([])
  expect(call?.slice(0, 2)).toEqual(['api', 'graphql'])
  expect(call).toContain('spec=25')
})

test('claiming sets the logged-in user as assignee without label and comment; releasing removes them', async () => {
  const { tracker, calls } = await connected([{}, {}])

  await tracker.claim(32)
  await tracker.release(32)

  expect(calls()).toEqual([
    ['issue', 'edit', '32', '--add-assignee', 'lucas-devries'],
    ['issue', 'edit', '32', '--remove-assignee', 'lucas-devries'],
  ])
})

test('close, reopen and mark as failed', async () => {
  const { tracker, calls } = await connected([{}, {}, {}])

  await tracker.close(32)
  await tracker.reopen(32)
  await tracker.markFailed(32)

  expect(calls()).toEqual([
    ['issue', 'close', '32'],
    ['issue', 'reopen', '32'],
    ['issue', 'edit', '32', '--remove-label', 'ready-for-agent', '--add-label', 'ready-for-human'],
  ])
})

test('commenting and creating a PR pass the text to gh via stdin', async () => {
  const gh = fakeGh([
    { output: 'lucas-devries\n' },
    {},
    { output: 'https://github.com/lucas-devries/groundhog/pull/7\n' },
  ])
  vi.stubEnv('PATH', `${gh.directory}${delimiter}${process.env.PATH}`)
  const tracker = await GitHubTracker.connect({ directory: process.cwd() })
  const comment = `Line with "quotes" and $HOME\n${'é'.repeat(200_000)}`

  await tracker.comment(25, comment)
  const url = await tracker.createPr({
    integrationBranch: 'spec/25',
    targetBranch: 'main',
    title: 'Spec #25',
    body: 'Closes #25',
  })

  expect(url).toBe('https://github.com/lucas-devries/groundhog/pull/7')
  expect(gh.calls().slice(1)).toEqual([
    { args: ['issue', 'comment', '25', '--body-file', '-'], input: comment },
    {
      args: [
        'pr',
        'create',
        '--head',
        'spec/25',
        '--base',
        'main',
        '--title',
        'Spec #25',
        '--body-file',
        '-',
      ],
      input: 'Closes #25',
    },
  ])
})

test('the start check reports missing labels, the number of sub-issues and the repo URL', async () => {
  const { tracker } = await connected([
    recording('start-check-spec-25.json'),
    recording('start-check-without-sub-issues-and-human-label.json'),
  ])

  expect(await tracker.startCheck(25)).toEqual({
    missingLabels: [],
    subIssues: 19,
    url: 'https://github.com/lucas-devries/groundhog',
  })
  expect(await tracker.startCheck(32)).toEqual({
    missingLabels: ['ready-for-human'],
    subIssues: 0,
    url: 'https://github.com/lucas-devries/groundhog',
  })
})

const NETWORK_ERROR: GhAnswer = {
  error:
    'error connecting to api.github.com\ncheck your internet connection or https://githubstatus.com\n',
  exitCode: 1,
}

test('if GitHub is briefly unreachable, the adapter retries with a delay', async () => {
  const { tracker, delays, calls } = await connected([NETWORK_ERROR, NETWORK_ERROR, {}])

  await tracker.close(32)

  expect(calls()).toHaveLength(3)
  expect(delays).toEqual([5_000, 15_000])
})

test('if GitHub stays unreachable, the adapter reports the error after three retries', async () => {
  const { tracker, delays, calls } = await connected([
    NETWORK_ERROR,
    NETWORK_ERROR,
    { error: 'gh: Server Error (HTTP 502)\n', exitCode: 1 },
    NETWORK_ERROR,
    {},
  ])

  await expect(tracker.taskGraph(25)).rejects.toThrow(/gh api graphql .*error connecting/s)
  expect(calls()).toHaveLength(4)
  expect(delays).toEqual([5_000, 15_000, 45_000])
})

test('an answer from GitHub such as a missing issue is not retried', async () => {
  const { tracker, delays } = await connected([
    { error: 'gh: Could not resolve to an Issue with the number of 99999.\n', exitCode: 1 },
  ])

  await expect(tracker.taskGraph(99999)).rejects.toThrow(/Could not resolve to an Issue/)
  expect(delays).toEqual([])
})

test('gh runs in its own process group, so the first Ctrl+C does not end it', async () => {
  vi.stubEnv('PATH', `${reportsProcessGroup('gh')}${delimiter}${process.env.PATH}`)

  const tracker = await GitHubTracker.connect({ directory: process.cwd() })

  expect(tracker.user).not.toBe(ownProcessGroup())
})

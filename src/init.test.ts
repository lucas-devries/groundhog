import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { git } from './git.ts'
import { type Dialog, init } from './init.ts'
import { FIXED_HOSTS } from './sandbox.ts'
import { throwawayRepo } from './testing/throwaway-repo.ts'

const CANCEL = Symbol('Ctrl+C')
type Answer = string | string[] | boolean | typeof CANCEL

/** Scripted dialog: answers the questions in order and records what was shown. */
function fakeDialog(answers: Answer[]) {
  const shown: unknown[] = []
  const answer = async (question: unknown) => {
    shown.push(question)
    const a = answers.shift()
    if (a === undefined) throw new Error(`no answer for ${JSON.stringify(question)}`)
    return a
  }
  const dialog = {
    multiline: (o) => answer({ kind: 'multiline', ...o }),
    text: (o) => answer({ kind: 'text', ...o }),
    multiselect: (o) => answer({ kind: 'multiselect', ...o }),
    confirm: (o) => answer({ kind: 'confirm', ...o }),
    info: (text) => shown.push({ kind: 'info', text }),
  } as Dialog
  return { dialog, shown }
}

/** A clone whose origin looks like a GitHub remote, with the remote branches main, develop, old. */
function githubClone(): string {
  const { remote, clone } = throwawayRepo()
  for (const b of ['develop', 'old']) git(clone, 'push', '-q', 'origin', `main:${b}`)
  const url = 'https://github.com/example/project.git'
  git(clone, 'remote', 'set-url', 'origin', url)
  git(clone, 'config', `url.${remote}.insteadOf`, url)
  return clone
}

const start = (directory: string, dialog: Dialog, env = {}) =>
  init({ directory, dialog, isTerminal: true, ghLoggedIn: () => true, ...env })

const file = (directory: string) => readFileSync(join(directory, 'groundhog.json'), 'utf8')

test('init creates groundhog.json with all fields, writes nothing else and names the next step', async () => {
  const clone = githubClone()
  const { dialog } = fakeDialog([
    'npm test\n\n  npm run lint  \n',
    ['main', 'develop'],
    'a.com, b.com',
    '5',
  ])

  const result = await start(clone, dialog)

  expect(file(clone)).toBe(
    `{
  "checks": [
    "npm test",
    "npm run lint"
  ],
  "attempts": 5,
  "targetBranches": [
    "main",
    "develop"
  ],
  "sandbox": {
    "hosts": [
      "a.com",
      "b.com"
    ],
    "off": false
  }
}
`,
  )
  expect(git(clone, 'status', '--porcelain')).toBe('?? groundhog.json')
  expect(git(clone, 'log', '--format=%s')).toBe('init')
  expect(result.exitCode).toBe(0)
  expect(result.message.split('\n').at(-1)).toMatch(/groundhog\.json.*commit.*groundhog <spec>/i)
})

test('init asks four questions: checks, target branches with the default branch first, hosts below the fixed list, attempts', async () => {
  const clone = githubClone()
  const { dialog, shown } = fakeDialog(['true', ['main'], '', '3'])

  await start(clone, dialog)

  expect(shown).toEqual([
    expect.objectContaining({ kind: 'multiline', initialValue: '' }),
    expect.objectContaining({
      kind: 'multiselect',
      options: [
        { value: 'main', label: 'main' },
        { value: 'develop', label: 'develop' },
        { value: 'old', label: 'old' },
      ],
      initialValues: ['main'],
    }),
    { kind: 'info', text: expect.stringContaining(FIXED_HOSTS.join(', ')) },
    expect.objectContaining({ kind: 'text', initialValue: '' }),
    expect.objectContaining({ kind: 'text', initialValue: '3' }),
  ])
  expect(JSON.parse(file(clone))).toMatchObject({ attempts: 3, sandbox: { hosts: [] } })
})

test('checks need at least one command, attempts a whole number from 1 to 10', async () => {
  const { dialog, shown } = fakeDialog(['true', ['main'], '', '3'])
  await start(githubClone(), dialog)
  type Validates = { validate: (value: string) => string | undefined }
  const checks = shown[0] as Validates
  const attempts = shown[4] as Validates

  expect(checks.validate(' \n ')).toBeDefined()
  expect(checks.validate('npm test')).toBeUndefined()
  for (const wrong of ['', '0', '11', '2.5', 'three'])
    expect(attempts.validate(wrong)).toBeDefined()
  for (const good of ['1', '10', ' 4 ']) expect(attempts.validate(good)).toBeUndefined()
})

test('the order of the target branches follows the list, not the selection', async () => {
  const clone = githubClone()
  const { dialog } = fakeDialog(['true', ['develop', 'main'], '', '3'])

  await start(clone, dialog)

  expect(JSON.parse(file(clone)).targetBranches).toEqual(['main', 'develop'])
})

test.each([
  ['package-lock.json', 'npm ci', 'npm run'],
  ['pnpm-lock.yaml', 'pnpm install --frozen-lockfile', 'pnpm run'],
  ['yarn.lock', 'yarn install --frozen-lockfile', 'yarn run'],
  ['bun.lock', 'bun install --frozen-lockfile', 'bun run'],
  [undefined, 'npm install', 'npm run'],
])(
  'Node project with %s: suggestion from the lockfile and the scripts typecheck, lint, test',
  async (lockfile, install, run) => {
    const clone = githubClone()
    const scripts = { build: 'tsc', test: 'vitest', typecheck: 'tsc --noEmit', lint: 'biome check' }
    writeFileSync(join(clone, 'package.json'), JSON.stringify({ scripts }))
    if (lockfile) writeFileSync(join(clone, lockfile), '')
    const { dialog, shown } = fakeDialog(['true', ['main'], '', '3'])

    await start(clone, dialog)

    expect(shown[0]).toMatchObject({
      initialValue: `${install}\n${run} typecheck\n${run} lint\n${run} test`,
    })
  },
)

test('Ctrl+C at any question writes nothing', async () => {
  for (let question = 0; question < 4; question++) {
    const clone = githubClone()
    const answers: Answer[] = ['true', ['main'], '', '3']
    answers[question] = CANCEL
    const { dialog } = fakeDialog(answers)

    const result = await start(clone, dialog)

    expect(existsSync(join(clone, 'groundhog.json'))).toBe(false)
    expect(result.exitCode).toBe(130)
  }
})

test('second call: existing values as defaults, sandbox.off is kept', async () => {
  const clone = githubClone()
  writeFileSync(
    join(clone, 'groundhog.json'),
    JSON.stringify({
      checks: ['make test', 'make lint'],
      attempts: 7,
      targetBranches: ['develop', 'main'],
      sandbox: { hosts: ['x.com', 'y.com'], off: true },
    }),
  )
  const { dialog, shown } = fakeDialog(['make test', ['main', 'develop'], 'x.com', '7'])

  await start(clone, dialog)

  expect(shown).toEqual([
    expect.objectContaining({ initialValue: 'make test\nmake lint' }),
    expect.objectContaining({
      options: [
        { value: 'develop', label: 'develop' },
        { value: 'main', label: 'main' },
        { value: 'old', label: 'old' },
      ],
      initialValues: ['develop', 'main'],
    }),
    expect.objectContaining({ kind: 'info' }),
    expect.objectContaining({ initialValue: 'x.com, y.com' }),
    expect.objectContaining({ initialValue: '7' }),
  ])
  expect(JSON.parse(file(clone))).toEqual({
    checks: ['make test'],
    attempts: 7,
    targetBranches: ['develop', 'main'],
    sandbox: { hosts: ['x.com'], off: true },
  })
})

test('second call with an invalid file: show errors; on No the file stays unchanged', async () => {
  const clone = githubClone()
  writeFileSync(join(clone, 'groundhog.json'), '{"checks": [], "target": 1}')
  const { dialog, shown } = fakeDialog([false])

  const result = await start(clone, dialog)

  expect(shown).toEqual([
    { kind: 'info', text: expect.stringContaining('checks: at least one entry required') },
    expect.objectContaining({ kind: 'confirm', active: 'Yes', inactive: 'No' }),
  ])
  expect((shown[0] as { text: string }).text).toContain('unknown key: target')
  expect(file(clone)).toBe('{"checks": [], "target": 1}')
  expect(result.exitCode).toBe(1)
})

test('second call with an invalid file: on Yes create anew with fresh defaults', async () => {
  const clone = githubClone()
  writeFileSync(join(clone, 'groundhog.json'), 'broken')
  const { dialog, shown } = fakeDialog([true, 'true', ['main'], '', '3'])

  const result = await start(clone, dialog)

  expect(shown[2]).toMatchObject({ kind: 'multiline', initialValue: '' })
  expect(JSON.parse(file(clone))).toMatchObject({ checks: ['true'] })
  expect(result.exitCode).toBe(0)
})

test.each([
  ['outside a Git repo', () => mkdtempSync(join(tmpdir(), 'groundhog-')), {}, /root of a Git repo/],
  [
    'in a subfolder',
    () => {
      const clone = githubClone()
      mkdirSync(join(clone, 'sub'))
      return join(clone, 'sub')
    },
    {},
    /root of a Git repo/,
  ],
  ['without a GitHub remote', () => throwawayRepo().clone, {}, /GitHub remote/],
  ['without gh login', githubClone, { ghLoggedIn: () => false }, /gh auth login/],
  ['without a terminal on stdin', githubClone, { isTerminal: false }, /terminal/],
])('init aborts %s with a reason and writes nothing', async (_, directory, env, reason) => {
  const d = directory()
  const { dialog, shown } = fakeDialog([])

  const result = await start(d, dialog, env)

  expect(result).toEqual({ exitCode: 1, message: expect.stringMatching(reason) })
  expect(shown).toEqual([])
  expect(existsSync(join(d, 'groundhog.json'))).toBe(false)
})

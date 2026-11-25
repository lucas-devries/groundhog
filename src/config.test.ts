import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { readConfig } from './config.ts'

function withFile(content: string): string {
  const directory = mkdtempSync(join(tmpdir(), 'groundhog-'))
  writeFileSync(join(directory, 'groundhog.json'), content)
  return directory
}

const errorsOf = (content: unknown) => {
  const read = readConfig(withFile(JSON.stringify(content)))
  return read.ok ? [] : read.errors
}

test('a missing file points to groundhog init', () => {
  const read = readConfig(mkdtempSync(join(tmpdir(), 'groundhog-')))

  expect(read).toMatchObject({ ok: false, missing: true })
  expect(read.ok || read.errors.join()).toContain('groundhog init')
})

test('only the required fields give the defaults of the rest', () => {
  expect(readConfig(withFile('{"checks":["npm test"],"targetBranches":["main"]}'))).toEqual({
    ok: true,
    config: {
      checks: ['npm test'],
      attempts: 3,
      targetBranches: ['main'],
      sandbox: { hosts: [], off: false },
    },
  })
})

test('all fields set are taken over', () => {
  const file = {
    checks: ['npm ci', 'npm test'],
    attempts: 10,
    targetBranches: ['develop', 'main'],
    sandbox: { hosts: ['*.example.com'], off: true },
  }

  expect(readConfig(withFile(JSON.stringify(file)))).toEqual({
    ok: true,
    config: file,
  })
})

test('no JSON', () => {
  const read = readConfig(withFile('{ checks: '))

  expect(read).toMatchObject({ ok: false, missing: false })
  expect(read.ok || read.errors).toEqual([
    expect.stringContaining('groundhog.json is not valid JSON'),
  ])
})

test('no object', () => {
  expect(errorsOf(['npm test'])).toEqual(['groundhog.json must be a JSON object'])
})

test('missing required fields', () => {
  expect(errorsOf({})).toEqual(['checks is missing', 'targetBranches is missing'])
})

test('empty lists', () => {
  expect(errorsOf({ checks: [], targetBranches: [] })).toEqual([
    'checks: at least one entry required',
    'targetBranches: at least one entry required',
  ])
})

test('wrong types', () => {
  expect(
    errorsOf({
      checks: 'npm test',
      attempts: '3',
      targetBranches: ['main', 1],
      sandbox: { hosts: 'a.com', off: 'no' },
    }),
  ).toEqual([
    'checks: list of strings expected',
    'attempts: whole number from 1 to 10 expected',
    'targetBranches: list of strings expected',
    'sandbox.hosts: list of strings expected',
    'sandbox.off: true or false expected',
  ])
  expect(errorsOf({ checks: ['x'], targetBranches: ['main'], sandbox: [] })).toEqual([
    'sandbox: object expected',
  ])
})

test('attempts outside 1 to 10 or not a whole number', () => {
  for (const attempts of [0, 11, 2.5]) {
    expect(errorsOf({ checks: ['x'], targetBranches: ['main'], attempts })).toEqual([
      'attempts: whole number from 1 to 10 expected',
    ])
  }
})

test('unknown keys, also in sandbox', () => {
  expect(
    errorsOf({ checks: ['x'], targetBranches: ['main'], attempt: 3, sandbox: { host: [] } }),
  ).toEqual(['unknown key: attempt', 'unknown key: sandbox.host'])
})

test('all errors at once', () => {
  expect(errorsOf({ checks: [], attempts: 0, sandbox: { off: 1 }, target: 'main' })).toEqual([
    'checks: at least one entry required',
    'attempts: whole number from 1 to 10 expected',
    'targetBranches is missing',
    'sandbox.off: true or false expected',
    'unknown key: target',
  ])
})

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/** Attempts per ticket, unless the project config says otherwise. */
export const DEFAULT_ATTEMPTS = 3

/** The project config, `groundhog.json` in the repo root. */
export interface Config {
  checks: string[]
  attempts: number
  targetBranches: string[]
  sandbox: { hosts: string[]; off: boolean }
}

export type ReadConfig =
  | { ok: true; config: Config }
  | { ok: false; missing: boolean; errors: string[] }

export const FILE = 'groundhog.json'

/** Reads and validates the project config; for an invalid file, all errors at once. */
export function readConfig(directory: string): ReadConfig {
  const path = join(directory, FILE)
  if (!existsSync(path)) {
    return {
      ok: false,
      missing: true,
      errors: [`${FILE} is missing. Create it with \`groundhog init\`.`],
    }
  }
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'))
  } catch (e) {
    return {
      ok: false,
      missing: false,
      errors: [`${FILE} is not valid JSON: ${(e as Error).message}`],
    }
  }
  if (!isObject(raw)) {
    return { ok: false, missing: false, errors: [`${FILE} must be a JSON object`] }
  }

  const errors: string[] = []
  const list = (name: string, value: unknown, required: boolean): string[] => {
    if (value === undefined) {
      if (required) errors.push(`${name} is missing`)
      return []
    }
    if (!Array.isArray(value) || !value.every((s) => typeof s === 'string')) {
      errors.push(`${name}: list of strings expected`)
      return []
    }
    if (required && value.length === 0) errors.push(`${name}: at least one entry required`)
    return value
  }

  const checks = list('checks', raw.checks, true)
  const attempts = raw.attempts ?? DEFAULT_ATTEMPTS
  if (!Number.isInteger(attempts) || (attempts as number) < 1 || (attempts as number) > 10) {
    errors.push('attempts: whole number from 1 to 10 expected')
  }
  const targetBranches = list('targetBranches', raw.targetBranches, true)
  let sandbox: Record<string, unknown> = {}
  if (raw.sandbox !== undefined) {
    if (isObject(raw.sandbox)) sandbox = raw.sandbox
    else errors.push('sandbox: object expected')
  }
  const hosts = list('sandbox.hosts', sandbox.hosts, false)
  const off = sandbox.off ?? false
  if (typeof off !== 'boolean') errors.push('sandbox.off: true or false expected')

  for (const k of unknownKeys(raw, ['checks', 'attempts', 'targetBranches', 'sandbox'])) {
    errors.push(`unknown key: ${k}`)
  }
  for (const k of unknownKeys(sandbox, ['hosts', 'off'])) {
    errors.push(`unknown key: sandbox.${k}`)
  }

  if (errors.length > 0) return { ok: false, missing: false, errors }
  return {
    ok: true,
    config: {
      checks,
      attempts: attempts as number,
      targetBranches,
      sandbox: { hosts, off: off as boolean },
    },
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function unknownKeys(object: Record<string, unknown>, known: string[]): string[] {
  return Object.keys(object).filter((k) => !known.includes(k))
}

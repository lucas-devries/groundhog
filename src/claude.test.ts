import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { afterEach, expect, test, vi } from 'vitest'
import type { SessionRequest } from './agent.ts'
import { claudeAgent, installedSkills, transcriber } from './claude.ts'
import { type ClaudeAnswer, fakeClaude } from './testing/fake-claude.ts'

afterEach(() => {
  vi.unstubAllEnvs()
})

const FORK_POINT = '0123456789abcdef0123456789abcdef01234567'

/**
 * A Claude adapter against a fake `claude` in the `PATH`. The fake sandbox starts no real one: it
 * only sets `IN_FAKE_SRT` to the working directory, which the fake `claude` records.
 */
function withFake(answers: ClaudeAnswer[], sandbox = true) {
  const claude = fakeClaude(answers)
  vi.stubEnv('PATH', `${claude.directory}${delimiter}${process.env.PATH}`)
  const agent = claudeAgent({
    repoUrl: 'https://github.com/lucas-devries/groundhog',
    token: 'gho_engine',
    sandbox: sandbox
      ? { wrap: (command, directory) => ['env', `IN_FAKE_SRT=${directory}`, ...command] }
      : undefined,
  })
  return { agent, calls: claude.calls }
}

function request(part: Partial<SessionRequest> = {}): SessionRequest & { lines: string[] } {
  const lines: string[] = []
  return {
    ticket: { number: 33, open: true, labels: [], assignees: [], blockers: [] },
    directory: mkdtempSync(join(tmpdir(), 'claude-session-')),
    forkPoint: FORK_POINT,
    signal: new AbortController().signal,
    output: (line) => {
      lines.push(line)
      return line
    },
    lines,
    ...part,
  }
}

test('a session calls implement with the ticket URL, with stream-json, permission mode and AFK note, stdin on /dev/null', async () => {
  const { agent, calls } = withFake([{ recording: 'claude-session-green.jsonl' }])
  const r = request()

  await agent.runSession(r)

  const [call] = calls()
  expect(call?.cwd).toBe(r.directory)
  expect(call?.stdin).toBe('/dev/null')
  const args = call?.args ?? []
  expect(args.slice(0, 2)).toEqual([
    '-p',
    '/mattpocock-skills:implement https://github.com/lucas-devries/groundhog/issues/33',
  ])
  expect(args.join(' ')).toContain('--output-format stream-json --verbose')
  expect(args.join(' ')).toContain('--permission-mode bypassPermissions')
  const note = args[args.indexOf('--append-system-prompt') + 1]
  expect(note).toContain(FORK_POINT)
  expect(note).toContain('mattpocock-skills:tdd')
  expect(note).toContain('mattpocock-skills:code-review')
})

test('the session gets the engine gh token and no retry watchdog and no ANTHROPIC_LOG', async () => {
  vi.stubEnv('CLAUDE_CODE_RETRY_WATCHDOG', '1')
  vi.stubEnv('CLAUDE_CODE_RETRY_WATCHDOG_MAX_WAIT_MS', '60000')
  vi.stubEnv('ANTHROPIC_LOG', 'debug')
  vi.stubEnv('GH_TOKEN', 'gho_foreign')
  const { agent, calls } = withFake([{ recording: 'claude-session-green.jsonl' }])

  await agent.runSession(request())

  expect(calls()[0]?.env).toEqual({ GH_TOKEN: 'gho_engine', IN_FAKE_SRT: expect.any(String) })
})

// Recording: the first session from prototype/cli-oberflaeche/run.jsonl (real session, CLI 2.1.331).
test('a successful session reports every line of the stream, the session, the skills, tokens and cost', async () => {
  const { agent } = withFake([{ recording: 'claude-session-green.jsonl' }])
  const r = request()

  const result = await agent.runSession(r)

  expect(r.lines).toHaveLength(20)
  expect(JSON.parse(r.lines[19] ?? '').type).toBe('result')
  expect(result).toMatchObject({
    success: true,
    sessionId: '3b80658c-18e0-4c94-a5e9-f770701651dd',
    tokens: {
      input_tokens: 6,
      cache_creation_input_tokens: 24622,
      cache_read_input_tokens: 83286,
      output_tokens: 1065,
    },
    costUsd: 0.4532572,
    blocks: [],
  })
  expect(result.skills).toContain('mattpocock-skills:implement')
  expect(result.usageLimit).toBeUndefined()
})

test('in the sandbox the whole claude process runs inside it, with bypass', async () => {
  const { agent, calls } = withFake([{ recording: 'claude-session-green.jsonl' }])
  const r = request()

  await agent.runSession(r)

  const [call] = calls()
  expect(call?.env.IN_FAKE_SRT).toBe(r.directory)
  expect(call?.cwd).toBe(r.directory)
  expect(call?.args.join(' ')).toContain('--permission-mode bypassPermissions')
})

test('without a sandbox the session runs in auto mode; from attempt 2 on the feedback is appended to the prompt', async () => {
  const { agent, calls } = withFake([{ recording: 'claude-session-green.jsonl' }], false)

  await agent.runSession(request({ feedback: 'Check `npm test` ended with exit 1.' }))

  const args = calls()[0]?.args ?? []
  expect(calls()[0]?.env.IN_FAKE_SRT).toBeUndefined()
  expect(args.join(' ')).toContain('--permission-mode auto')
  expect(args[1]).toBe(
    '/mattpocock-skills:implement https://github.com/lucas-devries/groundhog/issues/33\n\nCheck `npm test` ended with exit 1.',
  )
})

test('a session is only successful with exit 0, is_error false and subtype success', async () => {
  const { agent } = withFake([
    { recording: 'claude-session-green.jsonl', exitCode: 1 },
    { recording: 'claude-server-throttle.jsonl', exitCode: 0 },
    { exitCode: 0 },
  ])

  expect((await agent.runSession(request())).success).toBe(false)
  expect((await agent.runSession(request())).success).toBe(false)
  expect((await agent.runSession(request())).success).toBe(false)
})

test('blocks arrive in the result with tool, command and reason, each only once', async () => {
  const { agent } = withFake([{ recording: 'claude-blocks.jsonl' }])

  const result = await agent.runSession(request())

  expect(result.success).toBe(true)
  expect(result.blocks).toEqual([
    {
      tool: 'Bash',
      command: 'rm -rf ~/.ssh',
      reason: 'Deletes files outside the working directory',
    },
    { tool: 'Write', command: '/etc/hosts' },
  ])
})

test('the blocks come from the line as the engine returns it filtered', async () => {
  const { agent } = withFake([{ recording: 'claude-blocks.jsonl' }])

  const result = await agent.runSession(
    request({ output: (line) => line.replaceAll('~/.ssh', '***') }),
  )

  expect(result.blocks?.[0]).toMatchObject({ command: 'rm -rf ***' })
})

// Recording: output of claude 2.1.331 against the mock from research/usage-limit-erkennung.
// The fields are undocumented; if this test fails after a CLI update, the detection no longer
// works.
test('an abort at the usage limit is detected and reported with the reset time in ms', async () => {
  const { agent } = withFake([{ recording: 'claude-usage-limit.jsonl', exitCode: 1 }])

  const result = await agent.runSession(request())

  expect(result).toMatchObject({ success: false, usageLimit: 1795546773_000 })
})

test('api_error usage_limit_reached alone is a limit, only with exit other than 0', async () => {
  const { agent } = withFake([
    { recording: 'claude-usage-limit.jsonl', exitCode: 0 },
    { recording: 'claude-usage-limit-without-event.jsonl', exitCode: 1 },
  ])

  expect((await agent.runSession(request())).usageLimit).toBeUndefined()
  const before = Date.now()
  const withoutEvent = await agent.runSession(request())

  // Without a reset time the adapter reports "now"; the engine waits its buffer and asks `/usage`.
  expect(withoutEvent.usageLimit).toBeGreaterThanOrEqual(before)
  expect(withoutEvent.usageLimit).toBeLessThanOrEqual(Date.now())
})

test('a server throttle (rejected without resetsAt) is not a usage limit', async () => {
  const { agent } = withFake([{ recording: 'claude-server-throttle.jsonl', exitCode: 1 }])

  const result = await agent.runSession(request())

  expect(result.success).toBe(false)
  expect(result.usageLimit).toBeUndefined()
})

test('credits_required without resetsAt reports that it only goes on with credit', async () => {
  const { agent } = withFake([{ recording: 'claude-credit.jsonl', exitCode: 1 }])

  expect((await agent.runSession(request())).usageLimit).toBe('credit')
})

test('if the engine aborts, the adapter ends the session including child processes', async () => {
  const { agent, calls } = withFake([{ hangs: true }])
  const abort = new AbortController()

  const session = agent.runSession(request({ signal: abort.signal }))
  await vi.waitFor(() => expect(calls()[0]?.child).toBeDefined())
  abort.abort()
  const result = await session

  expect(result.success).toBe(false)
  const child = calls()[0]?.child ?? 0
  await vi.waitFor(() => expect(() => process.kill(child, 0)).toThrow())
})

test('/usage reports the latest reset of the exhausted windows, otherwise nothing', async () => {
  const { agent, calls } = withFake([
    { recording: 'claude-usage-exhausted.jsonl' },
    { recording: 'claude-usage-free.jsonl' },
  ])

  expect(await agent.exhaustedUntil()).toBe(Date.parse('2026-11-27T01:00:00Z'))
  expect(await agent.exhaustedUntil()).toBeUndefined()
  expect(calls()[0]?.args.slice(0, 2)).toEqual(['-p', '/usage'])
  expect(calls()[0]?.stdin).toBe('/dev/null')
})

test('a subagent names its tool calls and ends in one item with the first line of its report', () => {
  const read = transcriber()
  const line = (o: object) => JSON.stringify(o)
  const call = line({
    type: 'assistant',
    message: {
      content: [
        { type: 'tool_use', id: 'a1', name: 'Agent', input: { description: 'Spec review' } },
      ],
    },
  })
  const inside = (content: object[]) =>
    line({ type: 'assistant', parent_tool_use_id: 'a1', message: { content } })
  const back = (status: string, text: string) =>
    line({
      type: 'user',
      tool_use_result: { status },
      message: {
        content: [{ type: 'tool_result', tool_use_id: 'a1', content: [{ type: 'text', text }] }],
      },
    })
  const report =
    '[Subagent hand-back] The text below is the final report of a subagent. The report follows:\n  <tools-used-before-summary>Read</tools-used-before-summary>\n  \n  No gaps against the spec.\n  Details …'

  expect(read(call)).toEqual([{ kind: 'tool', name: 'Agent', argument: 'Spec review' }])
  expect(
    read(
      inside([
        { type: 'text', text: 'Reading the diff.' },
        { type: 'tool_use', id: 'b1', name: 'Bash', input: { command: 'git diff' } },
      ]),
    ),
  ).toEqual([{ kind: 'tool', name: 'Bash', argument: 'git diff', agent: 'Spec review' }])
  // Results inside the subagent stay out.
  expect(
    read(
      line({
        type: 'user',
        parent_tool_use_id: 'a1',
        message: { content: [{ type: 'tool_result', tool_use_id: 'b1', content: 'diff …' }] },
      }),
    ),
  ).toEqual([])
  expect(read(back('completed', report))).toEqual([
    { kind: 'agent-done', agent: 'Spec review', report: 'No gaps against the spec.', error: false },
  ])
  expect(transcriberEnd(back('failed', 'Agent crashed'))).toEqual([
    { kind: 'agent-done', agent: 'Spec review', report: 'Agent crashed', error: true },
  ])

  function transcriberEnd(text: string) {
    const fresh = transcriber()
    fresh(call)
    return fresh(text)
  }
})

test('a line of the stream becomes transcript items that know nothing of stream-json', () => {
  const transcriptItems = transcriber()
  const assistant = JSON.stringify({
    type: 'assistant',
    message: {
      content: [
        { type: 'text', text: 'Reading.' },
        { type: 'tool_use', id: 't', name: 'Read', input: { file_path: '/repo/a.ts' } },
      ],
    },
  })
  const user = (extra: object) =>
    JSON.stringify({
      type: 'user',
      message: { content: [{ type: 'tool_result', content: [{ text: 'boom' }], is_error: true }] },
      ...extra,
    })

  expect(transcriptItems(assistant)).toEqual([
    { kind: 'text', text: 'Reading.' },
    { kind: 'tool', name: 'Read', argument: '/repo/a.ts' },
  ])
  expect(transcriptItems(user({}))).toEqual([{ kind: 'result', text: 'boom', error: true }])
  expect(
    transcriptItems(
      user({ tool_use_result: { type: 'create', filePath: '/repo/b.ts', content: 'x\n' } }),
    ),
  ).toEqual([
    { kind: 'diff', file: '/repo/b.ts', hunks: [{ oldStart: 1, newStart: 1, lines: ['+x'] }] },
  ])
  expect(transcriptItems('stderr, not JSON')).toEqual([])
})

test('the installed skills and plugin versions come from the init event of /usage', () => {
  const calls: string[][] = []
  const recording = readFileSync(
    new URL('./testing/recordings/claude-init-with-skills.jsonl', import.meta.url),
    'utf8',
  )

  const installed = installedSkills((args) => {
    calls.push(args)
    return recording
  })

  expect(calls).toEqual([['-p', '/usage', '--output-format', 'stream-json', '--verbose']])
  expect(installed.skills).toContain('mattpocock-skills:implement')
  expect(installed.plugins).toContainEqual(
    expect.objectContaining({ name: 'mattpocock-skills', version: '1.3.2' }),
  )
  expect(installedSkills(() => 'no init')).toEqual({ skills: [], plugins: [] })
})

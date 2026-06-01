import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { parseLastAiTitle, readAiTitle } from './session-title'

function jsonl(obj: unknown): string {
  return JSON.stringify(obj) + '\n'
}

function aiTitleLine(sessionId: string, aiTitle: string): string {
  return jsonl({ type: 'ai-title', aiTitle, sessionId })
}

function userLine(sessionId: string, text: string): string {
  return jsonl({ type: 'user', sessionId, message: { role: 'user', content: text } })
}

describe('parseLastAiTitle', () => {
  it('returns the aiTitle from a single line', () => {
    expect(parseLastAiTitle(aiTitleLine('s1', 'Fix the jump'))).toBe('Fix the jump')
  })

  it('returns the LAST ai-title when several appear', () => {
    const chunk =
      aiTitleLine('s1', 'Old title') + userLine('s1', 'hi') + aiTitleLine('s1', 'New title')
    expect(parseLastAiTitle(chunk)).toBe('New title')
  })

  it('ignores a leading half-line (tail-read boundary) and still finds a later title', () => {
    const chunk = '{"type":"ai-tit' + '\n' + aiTitleLine('s1', 'Real title')
    expect(parseLastAiTitle(chunk)).toBe('Real title')
  })

  it('returns undefined when there is no ai-title', () => {
    expect(parseLastAiTitle(userLine('s1', 'hello') + userLine('s1', 'world'))).toBeUndefined()
  })

  it('skips empty aiTitle and non-ai-title types', () => {
    const chunk = aiTitleLine('s1', '   ') + jsonl({ type: 'summary', aiTitle: 'nope' })
    expect(parseLastAiTitle(chunk)).toBeUndefined()
  })
})

describe('readAiTitle', () => {
  let tmp: string

  beforeEach(async () => {
    const raw = await fs.mkdtemp(path.join(os.tmpdir(), 'sess-title-'))
    tmp = await fs.realpath(raw)
  })

  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true })
  })

  it('locates <sessionId>.jsonl under any project subdir and returns latest aiTitle', async () => {
    const proj = path.join(tmp, '-Users-ocean-foo')
    await fs.mkdir(proj, { recursive: true })
    await fs.writeFile(
      path.join(proj, 'abc-123.jsonl'),
      userLine('abc-123', 'do a thing') +
        aiTitleLine('abc-123', 'First') +
        aiTitleLine('abc-123', 'Latest')
    )
    expect(await readAiTitle(tmp, 'abc-123')).toBe('Latest')
  })

  it('returns undefined for an unknown session', async () => {
    await fs.mkdir(path.join(tmp, '-proj'), { recursive: true })
    expect(await readAiTitle(tmp, 'missing')).toBeUndefined()
  })

  it('returns undefined for empty sessionId without touching the fs', async () => {
    expect(await readAiTitle(tmp, '  ')).toBeUndefined()
  })

  it('returns undefined when the transcript has no ai-title', async () => {
    const proj = path.join(tmp, '-proj')
    await fs.mkdir(proj, { recursive: true })
    await fs.writeFile(path.join(proj, 's9.jsonl'), userLine('s9', 'just a message'))
    expect(await readAiTitle(tmp, 's9')).toBeUndefined()
  })

  it('returns undefined when projectsDir does not exist', async () => {
    expect(await readAiTitle(path.join(tmp, 'nope'), 's1')).toBeUndefined()
  })
})

import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

import { parseCommand, resolveCompany, sortIssues } from '../hooks/paperclip'

const COMPANY = { id: 'c1', name: 'Acme', issuePrefix: 'ACM', status: 'active' }
const ISSUES = [
  { id: 'i1', identifier: 'ACM-1', title: 'Write the launch post', status: 'todo', priority: 'low', updatedAt: '2026-10-01T00:00:00Z' },
  { id: 'i2', identifier: 'ACM-2', title: 'Fix the checkout bug', status: 'in_progress', priority: 'high', updatedAt: '2026-10-02T00:00:00Z' },
]
const PANE = { title: 'Paperclip', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} } as const
const RUN = { origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } } as const

type Sent = { method: string; url: string; body?: string }

function fakePaperclip(on: On, sent: Sent[], stored: Record<string, unknown> = {}) {
  mock.store(on, stored)
  on('classic.SessionStart', () => ({}))
  mock.clock(on)
  on('ui.status', () => ({ value: undefined }))
  on('http.fetch', ($, e) => {
    const method = e.init?.method ?? 'GET'
    sent.push({ method, url: e.url, body: e.init?.body })
    const path = new URL(e.url).pathname
    const reply = (data: unknown, status = 200) => ({
      value: { status, ok: status < 400, headers: {}, text: JSON.stringify(data) },
    })
    if (path === '/api/companies') return reply([COMPANY])
    if (path === '/api/companies/c1/issues') return reply(ISSUES)
    if (path === '/api/issues/ACM-2' && method === 'GET') return reply({ ...ISSUES[1], description: 'Cart total is wrong.' })
    if (path === '/api/issues/ACM-2/comments' && method === 'GET') return reply([])
    if (path === '/api/issues/ACM-2/comments' && method === 'POST') return reply({ id: 'k1' }, 201)
    return reply({ error: 'not found' }, 404)
  })
}

test('parses the command arguments', () => {
  expect(parseCommand('')).toEqual({ kind: 'open' })
  expect(parseCommand('acm-12')).toEqual({ kind: 'pin', identifier: 'ACM-12' })
  expect(parseCommand('comment shipped the fix')).toEqual({ kind: 'comment', body: 'shipped the fix' })
  expect(parseCommand('status in review')).toEqual({ kind: 'status', status: 'in_review' })
  expect(parseCommand('status nope').kind).toBe('help')
  expect(parseCommand('comment').kind).toBe('help')
})

test('sorts work in progress first and picks the only company', () => {
  const sorted = sortIssues(ISSUES)
  expect(sorted.map(one => one.identifier)).toEqual(['ACM-2', 'ACM-1'])
  const companies = [{ id: 'c1', name: 'Acme', prefix: 'ACM' }]
  expect(resolveCompany(companies, '')?.id).toBe('c1')
  expect(resolveCompany(companies, 'acm')?.id).toBe('c1')
  expect(resolveCompany([...companies, { id: 'c2', name: 'Beta', prefix: 'BET' }], '')).toBeUndefined()
})

test('lists open issues for the model', async ($, on) => {
  const sent: Sent[] = []
  fakePaperclip(on, sent)
  const listed = await $.tool.call({ tool: 'mcp__paperclip__issues' })
  expect(Object.keys(listed)).toEqual(['result'])
  expect(listed.result).toContain('Acme: 2 open issues')
  expect(listed.result).toContain('ACM-2 [in_progress, high] Fix the checkout bug')
  expect(sent[1]?.url).toContain('status=in_progress,in_review,blocked,todo,backlog')
})

test('the pane pins an issue and the model comments on it', async ($, on) => {
  const sent: Sent[] = []
  fakePaperclip(on, sent)
  await $.command.run({ ...RUN, command: 'paperclip', args: 'refresh' })
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'paperclip', surface, component: 'Pane', requestId: 'paperclip', props: PANE })
    expect((await ui.find({ type: 'Text', text: /Acme · 2 open/ }))).toBeDefined()
    await ui.press({ key: 'pin-ACM-2' })
    expect(await ui.find({ type: 'Text', text: /Pinned to this session/ })).toBeDefined()
    await ui.unmount()
  }
  const commented = await $.tool.call({ tool: 'mcp__paperclip__comment', body: 'Fixed the cart total.' })
  expect(commented).toEqual({ result: 'Commented on ACM-2.' })
  const read = await $.tool.call({ tool: 'mcp__paperclip__issue' })
  expect(read.result).toContain('Cart total is wrong.')
  const empty = await $.tool.call({ tool: 'mcp__paperclip__comment', body: ' ' })
  expect(empty).toEqual({ deny: 'The comment body is empty.' })
  const post = sent.find(one => one.method === 'POST')
  expect(post?.url).toBe('http://127.0.0.1:3100/api/issues/ACM-2/comments')
  expect(post?.body).toBe(JSON.stringify({ body: 'Fixed the cart total.' }))
})

test('restores the pinned issue after /clear', async ($, on) => {
  const sent: Sent[] = []
  fakePaperclip(on, sent, { pinned: ISSUES[1] })
  await $.classic.SessionStart({ source: 'clear' })
  const ui = await $.ui.mount({ plugin: 'paperclip', surface: 'terminal', component: 'Pane', requestId: 'paperclip', props: PANE })
  expect(await ui.find({ type: 'Text', text: /Pinned to this session/ })).toBeDefined()
  const read = await $.tool.call({ tool: 'mcp__paperclip__issue' })
  expect(read.result).toContain('ACM-2: Fix the checkout bug')
})

test('says when Paperclip is unreachable', async ($, on) => {
  mock.store(on)
  mock.clock(on)
  on('ui.status', () => ({ value: undefined }))
  on('http.fetch', () => {
    throw new Error('connection refused')
  })
  const result = await $.command.run({ ...RUN, command: 'paperclip', args: 'refresh' })
  expect(result.text).toBe('Paperclip is not reachable at http://127.0.0.1:3100.')
})

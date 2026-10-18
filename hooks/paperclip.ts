import type { Company, IssueSummary } from '../types'

export const OPEN_STATUSES = ['in_progress', 'in_review', 'blocked', 'todo', 'backlog'] as const
export const ALL_STATUSES = [...OPEN_STATUSES, 'done', 'cancelled'] as const
const PRIORITY_ORDER = ['critical', 'high', 'medium', 'low']

export type Fetcher = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<{ status: number; ok: boolean; text: string }>

export type Settings = { baseUrl: string; apiKey: string }

export class PaperclipError extends Error {}

export type IssueDetail = IssueSummary & {
  description: string | null
  comments: { author: string; body: string; createdAt: string }[]
}

export type Command =
  | { kind: 'open' }
  | { kind: 'refresh' }
  | { kind: 'pin'; identifier: string }
  | { kind: 'unpin' }
  | { kind: 'comment'; body: string }
  | { kind: 'status'; status: string }
  | { kind: 'help'; reason?: string }

const IDENTIFIER = /^[A-Za-z][A-Za-z0-9]*-\d+$/

export function isIdentifier(text: string): boolean {
  return IDENTIFIER.test(text)
}

export function parseCommand(args: string): Command {
  const text = args.trim()
  if (text === '') return { kind: 'open' }
  const [head = '', ...rest] = text.split(/\s+/)
  const tail = text.slice(head.length).trim()
  const word = head.toLowerCase()
  if (isIdentifier(head) && rest.length === 0) return { kind: 'pin', identifier: head.toUpperCase() }
  if (word === 'refresh') return { kind: 'refresh' }
  if (word === 'unpin') return { kind: 'unpin' }
  if (word === 'help') return { kind: 'help' }
  if (word === 'comment') {
    return tail === '' ? { kind: 'help', reason: 'Write the comment after "comment".' } : { kind: 'comment', body: tail }
  }
  if (word === 'status') {
    const status = tail.toLowerCase().replace(/[\s-]+/g, '_')
    return (ALL_STATUSES as readonly string[]).includes(status)
      ? { kind: 'status', status }
      : { kind: 'help', reason: `Status must be one of: ${ALL_STATUSES.join(', ')}.` }
  }
  return { kind: 'help', reason: `Unknown argument "${head}".` }
}

export const HELP = [
  '/paperclip                 open the board pane',
  '/paperclip AIM-12          pin an issue to this session',
  '/paperclip comment <text>  comment on the pinned issue',
  '/paperclip status <status> move the pinned issue (todo, in_review, done, ...)',
  '/paperclip unpin           unpin the issue',
  '/paperclip refresh         reload the board',
].join('\n')

export function sortIssues(issues: readonly IssueSummary[]): IssueSummary[] {
  const rank = (list: readonly string[], value: string) => {
    const at = list.indexOf(value)
    return at === -1 ? list.length : at
  }
  return [...issues].sort(
    (a, b) =>
      rank(OPEN_STATUSES, a.status) - rank(OPEN_STATUSES, b.status) ||
      rank(PRIORITY_ORDER, a.priority) - rank(PRIORITY_ORDER, b.priority) ||
      b.updatedAt.localeCompare(a.updatedAt),
  )
}

export function statusLabel(status: string): string {
  return status.replace(/_/g, ' ')
}

export function issueUrl(baseUrl: string, company: Company, identifier: string): string {
  return `${trimSlash(baseUrl)}/${company.prefix}/issues/${identifier}`
}

export function resolveCompany(companies: readonly Company[], wanted: string): Company | undefined {
  const key = wanted.trim().toLowerCase()
  if (key === '') return companies.length === 1 ? companies[0] : undefined
  return companies.find(
    one => one.id.toLowerCase() === key || one.prefix.toLowerCase() === key || one.name.toLowerCase() === key,
  )
}

export function pinnedSection(issue: IssueSummary, company: Company | undefined): string {
  return [
    `This session is pinned to Paperclip issue ${issue.identifier}: "${issue.title}"`,
    `(status ${statusLabel(issue.status)}, priority ${issue.priority}${company ? `, company ${company.name}` : ''}).`,
    'Read it with mcp__paperclip__issue before acting on it. When a meaningful step lands, post a short',
    'progress note with mcp__paperclip__comment. Comments are visible to everyone on the board.',
  ].join(' ')
}

export function describeIssue(issue: IssueDetail): string {
  const lines = [
    `${issue.identifier}: ${issue.title}`,
    `Status: ${statusLabel(issue.status)}. Priority: ${issue.priority}. Updated: ${issue.updatedAt}.`,
    '',
    issue.description?.trim() || '(no description)',
  ]
  if (issue.comments.length > 0) {
    lines.push('', `Latest ${issue.comments.length} comments, oldest first:`)
    for (const comment of issue.comments) {
      lines.push(`- ${comment.createdAt} ${comment.author}: ${comment.body.trim()}`)
    }
  }
  return lines.join('\n')
}

function trimSlash(url: string): string {
  return url.replace(/\/+$/, '')
}

type RawIssue = Record<string, unknown>

function toSummary(raw: RawIssue): IssueSummary {
  return {
    id: String(raw.id ?? ''),
    identifier: String(raw.identifier ?? ''),
    title: String(raw.title ?? ''),
    status: String(raw.status ?? ''),
    priority: String(raw.priority ?? 'medium'),
    updatedAt: String(raw.updatedAt ?? ''),
  }
}

export class PaperclipClient {
  constructor(
    private readonly fetcher: Fetcher,
    private readonly settings: Settings,
  ) {}

  private async request(path: string, init: { method?: string; body?: unknown } = {}): Promise<unknown> {
    const headers: Record<string, string> = { accept: 'application/json' }
    if (init.body !== undefined) headers['content-type'] = 'application/json'
    if (this.settings.apiKey) headers.authorization = `Bearer ${this.settings.apiKey}`
    const url = `${trimSlash(this.settings.baseUrl)}/api${path}`
    let response
    try {
      response = await this.fetcher(url, {
        method: init.method ?? 'GET',
        headers,
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
      })
    } catch {
      throw new PaperclipError(`Paperclip is not reachable at ${trimSlash(this.settings.baseUrl)}.`)
    }
    let data: unknown
    try {
      data = response.text === '' ? null : JSON.parse(response.text)
    } catch {
      throw new PaperclipError(`Paperclip answered ${response.status} with something that is not JSON.`)
    }
    if (!response.ok) {
      const message = (data as { error?: unknown } | null)?.error
      throw new PaperclipError(typeof message === 'string' ? message : `Paperclip answered ${response.status}.`)
    }
    return data
  }

  async companies(): Promise<Company[]> {
    const list = (await this.request('/companies')) as RawIssue[]
    return list
      .filter(one => one.status === undefined || one.status === 'active')
      .map(one => ({ id: String(one.id), name: String(one.name), prefix: String(one.issuePrefix ?? '') }))
  }

  async openIssues(companyId: string): Promise<IssueSummary[]> {
    const list = (await this.request(
      `/companies/${encodeURIComponent(companyId)}/issues?status=${OPEN_STATUSES.join(',')}`,
    )) as RawIssue[]
    return sortIssues(list.map(toSummary))
  }

  async issue(identifier: string, commentCount = 5): Promise<IssueDetail> {
    const raw = (await this.request(`/issues/${encodeURIComponent(identifier)}`)) as RawIssue
    const comments = (await this.request(`/issues/${encodeURIComponent(identifier)}/comments`)) as RawIssue[]
    const latest = [...comments]
      .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))
      .slice(-commentCount)
      .map(one => ({
        author: one.authorAgentId ? 'agent' : one.authorUserId ? 'user' : 'unknown',
        body: String(one.body ?? ''),
        createdAt: String(one.createdAt ?? ''),
      }))
    return {
      ...toSummary(raw),
      description: typeof raw.description === 'string' ? raw.description : null,
      comments: latest,
    }
  }

  async comment(identifier: string, body: string): Promise<void> {
    await this.request(`/issues/${encodeURIComponent(identifier)}/comments`, { method: 'POST', body: { body } })
  }

  async setStatus(identifier: string, status: string): Promise<IssueSummary> {
    const raw = (await this.request(`/issues/${encodeURIComponent(identifier)}`, {
      method: 'PATCH',
      body: { status },
    })) as RawIssue
    return toSummary(raw)
  }
}

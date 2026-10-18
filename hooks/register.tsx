import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Board, IssueSummary } from '../types'
import {
  HELP,
  OPEN_STATUSES,
  PaperclipClient,
  describeIssue,
  isIdentifier,
  issueUrl,
  parseCommand,
  pinnedSection,
  resolveCompany,
  statusLabel,
} from './paperclip'

const PANE = 'paperclip'

const EMPTY_BOARD: Board = { state: 'idle', companies: [], issues: [] }
const board = atom({ plugin: 'paperclip', key: 'board' } as const, EMPTY_BOARD)
const pinned = atom({ plugin: 'paperclip', key: 'pinned' } as const, null)

type $ = EngineInterface

const config = {
  baseUrl: 'http://127.0.0.1:3100',
  apiKey: '',
  company: '',
  refreshSeconds: 60,
  pinKey: 'pinned',
}

function client($: $) {
  return new PaperclipClient((url, init) => $.http.fetch(url, init), config)
}

async function showStatus($: $) {
  const pin = await read($, pinned)
  const current = await read($, board)
  if (pin) $.ui.status(`${pin.identifier} · ${statusLabel(pin.status)}`)
  else if (current.state === 'error') $.ui.status('Paperclip offline')
  else if (current.company) $.ui.status(`${current.company.prefix} · ${current.issues.length} open`)
  else $.ui.status(undefined)
}

async function refresh($: $) {
  await update($, board, (current): Board => ({ ...current, state: 'loading' }))
  try {
    const api = client($)
    const companies = await api.companies()
    const stored = await $.store.get('company')
    const company =
      resolveCompany(companies, config.company) ??
      (typeof stored === 'string' ? companies.find(one => one.id === stored) : undefined)
    const issues = company ? await api.openIssues(company.id) : []
    const refreshedAt = new Date(await $.clock.now()).toISOString()
    await update($, board, (): Board => ({ state: 'ready', companies, company, issues, refreshedAt }))
    const pin = await read($, pinned)
    const fresh = pin && issues.find(one => one.identifier === pin.identifier)
    if (fresh) await setPinned($, fresh)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await update($, board, (current): Board => ({ ...current, state: 'error', message }))
  }
  await showStatus($)
}

async function setPinned($: $, issue: IssueSummary | null) {
  await update($, pinned, () => issue)
  if (issue) await $.store.set(config.pinKey, issue)
  else await $.store.delete(config.pinKey)
  await showStatus($)
}

async function pinIssue($: $, identifier: string) {
  const detail = await client($).issue(identifier)
  const { description: _description, comments: _comments, ...summary } = detail
  await setPinned($, summary)
  return detail
}

async function pinnedOrGiven($: $, given: unknown): Promise<string> {
  if (typeof given === 'string' && isIdentifier(given)) return given.toUpperCase()
  const pin = await read($, pinned)
  if (pin) return pin.identifier
  throw new Error('No issue given and none is pinned. Pass an identifier such as AIM-12.')
}

async function restore($: $, isWaiting: boolean) {
  const saved = await $.store.get(config.pinKey)
  if (saved && typeof saved === 'object') await update($, pinned, () => saved as IssueSummary)
  if (isWaiting) await refresh($)
  else void refresh($)
}

export const register: Register = (on, options) => {
  config.baseUrl = String(options.baseUrl || 'http://127.0.0.1:3100')
  config.apiKey = String(options.apiKey ?? '')
  config.company = String(options.company ?? '')
  config.refreshSeconds = Number(options.refreshSeconds ?? 60)

  on('session.start', async ($, e, next) => {
    config.pinKey = `pinned:${await $.session.cwd()}`
    await $.command.register({
      name: 'paperclip',
      description: 'Paperclip board: pin an issue, comment on it, change its status',
      argumentHint: '[ISSUE-ID | comment <text> | status <status> | unpin | refresh]',
    })
    await $.tool.register({
      name: 'issues',
      description:
        'List the open Paperclip issues (in progress, in review, blocked, todo, backlog) of the company this session uses: identifier, title, status and priority.',
      inputSchema: {
        type: 'object',
        properties: {
          status: { type: 'string', enum: [...OPEN_STATUSES], description: 'Only issues with this status.' },
        },
      },
    })
    await $.tool.register({
      name: 'issue',
      description:
        'Read one Paperclip issue: title, status, priority, description and the latest comments. Without an identifier it reads the issue pinned to this session.',
      inputSchema: {
        type: 'object',
        properties: { identifier: { type: 'string', description: 'Issue identifier, e.g. AIM-12.' } },
      },
    })
    await $.tool.register({
      name: 'comment',
      description:
        'Post a comment on a Paperclip issue. Everyone on the board sees it. Use it for short progress notes on the pinned issue. Without an identifier it comments on the pinned issue.',
      inputSchema: {
        type: 'object',
        properties: {
          identifier: { type: 'string', description: 'Issue identifier, e.g. AIM-12.' },
          body: { type: 'string', description: 'The comment, in Markdown.' },
        },
        required: ['body'],
      },
    })

    await restore($, false)
    if (config.refreshSeconds > 0) $.clock.every(config.refreshSeconds * 1000, () => void refresh($))

    return next(e)
  })

  // A /clear starts a new session id with empty state and no session.start: restore the pin.
  on('classic.SessionStart', async ($, e, next) => {
    if (e.source === 'clear') await restore($, true)
    return next(e)
   }).catch(($, e, next) => next(e))

  on('command.run', { command: 'paperclip' }, async ($, e) => {
    const command = parseCommand(e.args)
    try {
      switch (command.kind) {
        case 'open': {
          await $.ui.open({ id: PANE, title: 'Paperclip' })
          await refresh($)
          const current = await read($, board)
          if (current.state === 'error') return { text: current.message ?? 'Paperclip is not reachable.' }
          if (!current.company) return { text: 'Pick a company in the Paperclip pane, or set one with /config.' }
          return { text: `${current.issues.length} open issues in ${current.company.name}.` }
        }
        case 'refresh': {
          await refresh($)
          const current = await read($, board)
          return { text: current.state === 'error' ? current.message ?? 'Refresh failed.' : 'Board refreshed.' }
        }
        case 'pin': {
          const detail = await pinIssue($, command.identifier)
          return {
            text: `Pinned ${detail.identifier}: ${detail.title} (${statusLabel(detail.status)}).`,
            context: [describeIssue(detail)],
          }
        }
        case 'unpin': {
          const pin = await read($, pinned)
          await setPinned($, null)
          return { text: pin ? `Unpinned ${pin.identifier}.` : 'No issue was pinned.' }
        }
        case 'comment': {
          const identifier = await pinnedOrGiven($, undefined)
          await client($).comment(identifier, command.body)
          return { text: `Commented on ${identifier}.` }
        }
        case 'status': {
          const identifier = await pinnedOrGiven($, undefined)
          const updated = await client($).setStatus(identifier, command.status)
          const pin = await read($, pinned)
          if (pin?.identifier === identifier) await setPinned($, { ...pin, status: updated.status })
          return { text: `${identifier} is now ${statusLabel(updated.status)}.` }
        }
        case 'help':
          return { text: [command.reason, HELP].filter(Boolean).join('\n\n') }
      }
    } catch (error) {
      return { text: error instanceof Error ? error.message : String(error) }
    }
  })

  on('tool.call', { tool: 'mcp__paperclip__issues' }, async ($, e) => {
    await refresh($)
    const current = await read($, board)
    if (current.state === 'error') return { deny: current.message ?? 'Paperclip is not reachable.' }
    if (!current.company) return { deny: 'No Paperclip company is chosen. Ask the person to pick one with /paperclip.' }
    const wanted = typeof e.status === 'string' ? e.status : undefined
    const issues = wanted ? current.issues.filter(one => one.status === wanted) : current.issues
    const text = issues.length
      ? issues.map(one => `${one.identifier} [${one.status}, ${one.priority}] ${one.title}`).join('\n')
      : 'No matching open issues.'
    return { result: `${current.company.name}: ${issues.length} open issues\n${text}` }
  }).catch(() => ({ deny: 'The Paperclip mod could not answer this call.' }))

  on('tool.call', { tool: 'mcp__paperclip__issue' }, async ($, e) => {
    try {
      const detail = await client($).issue(await pinnedOrGiven($, e.identifier))
      return { result: describeIssue(detail) }
    } catch (error) {
      return { deny: error instanceof Error ? error.message : String(error) }
    }
  }).catch(() => ({ deny: 'The Paperclip mod could not answer this call.' }))

  on('tool.call', { tool: 'mcp__paperclip__comment' }, async ($, e) => {
    try {
      const body = typeof e.body === 'string' ? e.body.trim() : ''
      if (body === '') throw new Error('The comment body is empty.')
      const identifier = await pinnedOrGiven($, e.identifier)
      await client($).comment(identifier, body)
      return { result: `Commented on ${identifier}.` }
    } catch (error) {
      return { deny: error instanceof Error ? error.message : String(error) }
    }
  }).catch(() => ({ deny: 'The Paperclip mod could not answer this call.' }))

  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    const pin = await read($, pinned)
    if (!pin) return composed
    const { company } = await read($, board)
    const section = { id: 'paperclip:pinned', text: pinnedSection(pin, company), scope: 'session' as const }
    return { sections: [...composed.sections, section] }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const ui = $.ui.resolve(e)
    const { Box, Text, Button, Link } = ui
    const current = await read($, board)
    const pin = await read($, pinned)
    const width = Math.max(24, e.props.bodyColumns)
    const fit = (text: string, room: number) => (text.length > room ? `${text.slice(0, Math.max(1, room - 1))}…` : text)

    const header = (
      <Box key="header" flexDirection="row" justifyContent="space-between">
        <Text weight="bold">
          {current.company ? `${current.company.name} · ${current.issues.length} open` : 'Paperclip'}
        </Text>
        <Button key="refresh" label={current.state === 'loading' ? 'Loading' : 'Refresh'} onPress={() => refresh($)} />
      </Box>
    )

    const pinnedBlock = pin ? (
      <Box key="pinned" flexDirection="column" marginTop={1}>
        <Text dimColor>Pinned to this session</Text>
        <Text>
          <Text weight="bold">{pin.identifier}</Text> {fit(pin.title, width - pin.identifier.length - 2)}
        </Text>
        <Text dimColor>
          {statusLabel(pin.status)} · {pin.priority}
        </Text>
        <Box flexDirection="row" gap={2}>
          <Button key="unpin" label="Unpin" onPress={() => setPinned($, null)} />
          {current.company && (
            <Link href={issueUrl(config.baseUrl, current.company, pin.identifier)} label="Open in Paperclip" />
          )}
        </Box>
      </Box>
    ) : null

    let body
    if (current.state === 'error') {
      body = (
        <Box key="error" flexDirection="column" marginTop={1}>
          <Text color="error">{current.message}</Text>
          <Text dimColor>Check that Paperclip is running, or change its URL with /config.</Text>
        </Box>
      )
    } else if (!current.company && current.companies.length > 0 && 'Select' in ui) {
      const { Select } = ui
      body = (
        <Box key="pick" flexDirection="column" marginTop={1}>
          <Select
            key="company"
            label="Company"
            options={current.companies.map(one => ({ value: one.id, label: `${one.name} (${one.prefix})` }))}
            onSelect={async value => {
              await $.store.set('company', value)
              await refresh($)
            }}
          />
        </Box>
      )
    } else if (!current.company) {
      body = (
        <Text key="none" dimColor>
          {current.state === 'ready' ? 'No company chosen. Set one with /config.' : 'Loading the board…'}
        </Text>
      )
    } else {
      const idWidth = Math.max(...current.issues.map(one => one.identifier.length))
      const titleWidth = Math.max(10, width - idWidth - 'critical'.length - 3)
      const groups = OPEN_STATUSES.map(status => ({
        status,
        issues: current.issues.filter(one => one.status === status),
      })).filter(group => group.issues.length > 0)
      body = (
        <Box key="issues" flexDirection="column" marginTop={1}>
          {groups.length === 0 && <Text dimColor>No open issues.</Text>}
          {groups.map(group => (
            <Box key={`group-${group.status}`} flexDirection="column" marginBottom={1}>
              <Text dimColor>
                {statusLabel(group.status)} ({group.issues.length})
              </Text>
              {group.issues.map(issue => (
                <Button
                  key={`pin-${issue.identifier}`}
                  plain
                  onPress={async () => {
                    await pinIssue($, issue.identifier)
                  }}
                >
                  {issue.identifier.padEnd(idWidth)} {fit(issue.title, titleWidth).padEnd(titleWidth)}{' '}
                  <Text dimColor>{issue.priority}</Text>
                </Button>
              ))}
            </Box>
          ))}
          <Text dimColor>Press an issue to pin it. Claude then sees it and can comment on it.</Text>
        </Box>
      )
    }

    return (
      <Box flexDirection="column">
        {header}
        {pinnedBlock}
        {body}
      </Box>
    )
  })
}

export type Company = { id: string; name: string; prefix: string }

export type IssueSummary = {
  id: string
  identifier: string
  title: string
  status: string
  priority: string
  updatedAt: string
}

export type Board = {
  state: 'idle' | 'loading' | 'ready' | 'error'
  message?: string
  company?: Company
  companies: Company[]
  issues: IssueSummary[]
  refreshedAt?: string
}

declare module 'claude-code' {
  interface PluginState {
    paperclip: {
      board: Board
      pinned: IssueSummary | null
    }
  }
}

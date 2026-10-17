export type Tokens = { input: number; output: number; cacheRead: number; cacheWrite: number }

export type Limit = { kind: string; percentUsed: number; resetsAt?: string }

export type Live = Tokens & {
  messages: number
  replies: number
  turns: number
  lastTurnTokens: number
  model: string
  contextTokens?: number
  contextWindow: number
  contextPercent?: number
  costUsd: number
  limits: Limit[]
  startedAt: number
  isCounted: boolean
}

export type Lifetime = Tokens & {
  messages: number
  replies: number
  sessions: number
  costUsd: number
  since: string
  /** Each session's own running cost, by session id; costUsd is their sum. */
  sessionCosts?: Record<string, number>
  /** When per-session cost counting began. */
  costSince?: string
}

/** The usage-credit balance the person entered, and what has been paid from credits since. */
export type Credits = {
  balanceUsd: number
  setAt: string
  spentUsd: number
}

declare module 'claude-code' {
  interface PluginState {
    'usage-panel': { live: Live; lifetime: Lifetime; credits: Credits | null }
  }
}

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Credits, Lifetime, Limit, Live, Tokens } from '../types'

const PANE = 'usage'
const TITLE = 'Usage'
const STORE_KEY = 'lifetime'
const CREDITS_KEY = 'credits'

const ZERO: Tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }

const live = atom({ plugin: 'usage-panel', key: 'live' } as const, {
  ...ZERO,
  messages: 0,
  replies: 0,
  turns: 0,
  lastTurnTokens: 0,
  model: '',
  contextWindow: 0,
  costUsd: 0,
  limits: [],
  startedAt: 0,
  isCounted: false,
} as Live)

const lifetime = atom({ plugin: 'usage-panel', key: 'lifetime' } as const, {
  ...ZERO,
  messages: 0,
  replies: 0,
  sessions: 0,
  costUsd: 0,
  since: '',
} as Lifetime)

// Claude Code does not give mods the credit balance, so the person enters it once
// (/usage-panel credits 12.78) and the pane counts down from it.
const credits = atom({ plugin: 'usage-panel', key: 'credits' } as const, null as Credits | null)

const total = (t: Tokens) => t.input + t.output + t.cacheRead + t.cacheWrite

function short(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`
  if (n >= 1e4) return `${(n / 1e3).toFixed(1)}K`
  return String(Math.round(n))
}

function usd(n: number): string {
  if (n >= 1000) return `$${Math.round(n).toLocaleString('en-US')}`
  return n > 0 && n < 0.01 ? '<$0.01' : `$${n.toFixed(2)}`
}

function fillColor(percent: number): string {
  return percent >= 90 ? 'error' : percent >= 75 ? 'warning' : 'rate_limit_fill'
}

function resetText(iso?: string): string {
  if (!iso) return ''
  const at = new Date(iso)
  const ms = at.getTime() - Date.now()
  if (!(ms > 0)) return 'Resetting now'
  const time = at.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }).replace(':00', '').replace(' ', '').toLowerCase()
  const sameDay = at.toDateString() === new Date().toDateString()
  const when = sameDay ? time : `${at.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}, ${time}`
  const h = Math.floor(ms / 3_600_000)
  const m = Math.floor((ms % 3_600_000) / 60_000)
  const left = h >= 24 ? `${Math.floor(h / 24)}d ${h % 24}h` : h > 0 ? `${h}h ${m}m` : `${m}m`
  return `Resets ${when} · in ${left}`
}

// The same titles Claude's /usage screen uses.
function limitTitle(kind: string): string {
  if (kind === 'five_hour') return 'Current session'
  if (kind === 'seven_day') return 'Current week (all models)'
  if (kind === 'spend_limit') return 'Monthly spend limit'
  return kind.replace(/_/g, ' ').replace(/^./, c => c.toUpperCase())
}

function duration(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60_000))
  return minutes >= 60 ? `${Math.floor(minutes / 60)}h ${minutes % 60}m` : `${minutes}m`
}

const toLimits = (rateLimits: Limit[]): Limit[] =>
  rateLimits.map(r => ({ kind: r.kind, percentUsed: r.percentUsed, resetsAt: r.resetsAt }))

// Adds a delta to the lifetime totals kept across sessions. Re-reads the store
// first so two open sessions do not overwrite each other's counts.
type Counter = Exclude<keyof Lifetime, 'since' | 'sessionCosts' | 'costSince'>

async function bump($: EngineInterface, delta: Partial<Record<Counter, number>>) {
  const stored = ((await $.store.get(STORE_KEY)) as Lifetime | undefined) ?? (await read($, lifetime))
  const next: Lifetime = { ...stored }
  for (const k of Object.keys(delta) as Counter[]) {
    next[k] = (stored[k] ?? 0) + (delta[k] ?? 0)
  }
  await $.store.set(STORE_KEY, next)
  await update($, lifetime, () => next)
}

// The all-time cost is the sum of each session's own total, as /cost reports it, so
// reloads, restarts and missed measurements cannot lose or double-count any of it.
async function recordSessionCost($: EngineInterface, usd: number) {
  const id = await $.session.id()
  const stored = ((await $.store.get(STORE_KEY)) as Lifetime | undefined) ?? (await read($, lifetime))
  // Totals counted before v0.2.1 were increments that cannot be split by session; they restart here.
  const costs = stored.sessionCosts ?? {}
  if ((costs[id] ?? -1) >= usd && stored.sessionCosts) return
  const sessionCosts = { ...costs, [id]: Math.max(costs[id] ?? 0, usd) }
  const next: Lifetime = {
    ...stored,
    sessionCosts,
    costUsd: Object.values(sessionCosts).reduce((a, b) => a + b, 0),
    costSince: stored.sessionCosts ? stored.costSince : new Date().toISOString(),
  }
  await $.store.set(STORE_KEY, next)
  await update($, lifetime, () => next)
}

// Credits pay for usage only while a plan limit is used up; then the session's
// cost, at API rates, is what they are charged.
const onCredits = (limits: Limit[]) =>
  limits.some(l => (l.kind === 'five_hour' || l.kind === 'seven_day') && l.percentUsed >= 100)

async function spendCredits($: EngineInterface, usd: number) {
  const stored = (await $.store.get(CREDITS_KEY)) as Credits | undefined
  if (!stored) return
  const next = { ...stored, spentUsd: stored.spentUsd + usd }
  await $.store.set(CREDITS_KEY, next)
  await update($, credits, () => next)
}

async function loadLifetime($: EngineInterface): Promise<Lifetime> {
  const stored = (await $.store.get(STORE_KEY)) as Lifetime | undefined
  if (stored) return stored
  // First run: seed from the transcripts counted when the mod was made.
  let seed: Partial<Lifetime> = {}
  try {
    seed = JSON.parse(await $.fs.read(`${$.plugin.root}/baseline.json`))
  } catch {}
  const first: Lifetime = {
    input: seed.input ?? 0,
    output: seed.output ?? 0,
    cacheRead: seed.cacheRead ?? 0,
    cacheWrite: seed.cacheWrite ?? 0,
    messages: seed.messages ?? 0,
    replies: seed.replies ?? 0,
    sessions: seed.sessions ?? 0,
    costUsd: 0,
    since: new Date().toISOString(),
  }
  await $.store.set(STORE_KEY, first)
  return first
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const result = await next(e)

    await $.command.register({
      name: 'usage-panel',
      description: 'Open the usage stats pane, or set your usage-credit balance',
      argumentHint: '[credits <balance>]',
    })
    const savedCredits = (await $.store.get(CREDITS_KEY)) as Credits | undefined
    await update($, credits, () => savedCredits ?? null)

    const loaded = await loadLifetime($)
    await update($, lifetime, () => loaded)

    const now = await read($, live)
    if (!now.isCounted) {
      const usage = await $.session.usage()
      await update($, live, l => ({
        ...l,
        isCounted: true,
        startedAt: usage.startedAt,
        contextTokens: usage.context.tokens,
        contextWindow: usage.context.window,
        contextPercent: usage.context.percent,
        costUsd: usage.cost?.usd ?? 0,
        limits: toLimits(usage.rateLimits),
      }))
      await bump($, { sessions: 1 })
    }
    const opening = await $.session.usage()
    if (opening.cost) await recordSessionCost($, opening.cost.usd)

    void $.ui.open({ id: PANE, title: TITLE })

    return result
  })

  on('command.run', { command: 'usage-panel' }, async ($, e) => {
    const set = /^\s*credits\s+\$?(\d+(?:\.\d{1,2})?)\s*$/i.exec(e.args)
    if (set) {
      const next: Credits = { balanceUsd: Number(set[1]), setAt: new Date().toISOString(), spentUsd: 0 }
      await $.store.set(CREDITS_KEY, next)
      await update($, credits, () => next)
      return { text: `Usage-credit balance set to ${usd(next.balanceUsd)}. The pane counts down from here as credits are spent.` }
    }
    if (/^\s*credits\s*$/i.test(e.args)) {
      const c = await read($, credits)
      return {
        text: c
          ? `About ${usd(Math.max(0, c.balanceUsd - c.spentUsd))} left (${usd(c.balanceUsd)} entered ${c.setAt.slice(0, 10)}, ${usd(c.spentUsd)} spent since).`
          : 'No balance set. Copy it from Settings → Usage → Current balance: /usage-panel credits 12.78',
      }
    }
    await $.ui.open({ id: PANE, title: TITLE })

    return { text: 'Usage pane opened.' }
  })

  on('prompt.submit', async ($, e, next) => {
    const result = await next(e)
    if (!e.isMeta) {
      try {
        await update($, live, l => ({ ...l, messages: l.messages + 1 }))
        await bump($, { messages: 1 })
      } catch {}
    }

    return result
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    const u = e.usage
    if (u) {
      const delta: Tokens = {
        input: u.input_tokens,
        output: u.output_tokens,
        cacheRead: u.cache_read_input_tokens,
        cacheWrite: u.cache_creation_input_tokens,
      }
      const isMain = !e.agentId
      await update($, live, l => ({
        ...l,
        input: l.input + delta.input,
        output: l.output + delta.output,
        cacheRead: l.cacheRead + delta.cacheRead,
        cacheWrite: l.cacheWrite + delta.cacheWrite,
        turns: l.turns + (isMain ? 1 : 0),
        replies: l.replies + (isMain ? 1 : 0),
        lastTurnTokens: isMain ? total(delta) : l.lastTurnTokens,
        model: isMain ? u.model : l.model,
      }))
      await bump($, { ...delta, replies: isMain ? 1 : 0 })
    }

    return result
  })

  on('session.measure', async ($, e, next) => {
    const before = await read($, live)
    const cost = e.cost?.usd ?? before.costUsd
    const spent = cost - before.costUsd
    if (spent > 0 && onCredits(toLimits(e.rateLimits))) await spendCredits($, spent)
    await update($, live, l => ({
      ...l,
      contextTokens: e.context.tokens,
      contextWindow: e.context.window,
      contextPercent: e.context.percent,
      costUsd: cost,
      limits: toLimits(e.rateLimits),
    }))
    if (e.cost) await recordSessionCost($, e.cost.usd)

    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const s = await read($, live)
    const life = await read($, lifetime)
    const wallet = await read($, credits)

    const heading = (text: string) => (
      <Box marginTop={1}>
        <Text bold color="claude">
          {text}
        </Text>
      </Box>
    )
    const row = (label: string, value: string, color?: string) => (
      <Box flexDirection="row" justifyContent="space-between">
        <Text dimColor>{label}</Text>
        <Text color={color} tabular>
          {value}
        </Text>
      </Box>
    )
    // Claude's usage bar: a solid fill on a rate_limit_empty track, the figure to its right.
    const meter = (percent: number, label: string) => {
      const filled = Math.round(Math.max(0, Math.min(100, percent)))
      return (
        <Box flexDirection="row" alignItems="center" gap={1}>
          <Box flexGrow={1} height={1} backgroundColor="rate_limit_empty">
            {filled > 0 && <Box width={`${filled}%`} height={1} backgroundColor={fillColor(percent)} />}
          </Box>
          <Text tabular>{label}</Text>
        </Box>
      )
    }
    const note = (text: string) => (
      <Text dimColor wrap="wrap">
        {text}
      </Text>
    )
    // Token table: label, this session, all time, in right-aligned columns.
    const cell = (text: string, bold?: boolean, dim?: boolean) => (
      <Box width={9} justifyContent="flex-end">
        <Text tabular bold={bold} dimColor={dim}>
          {text}
        </Text>
      </Box>
    )
    const tokenRow = (label: string, session: number, all: number, bold?: boolean) => (
      <Box flexDirection="row" justifyContent="space-between">
        <Text dimColor={!bold} bold={bold}>
          {label}
        </Text>
        <Box flexDirection="row">
          {cell(short(session), bold)}
          {cell(short(all), bold)}
        </Box>
      </Box>
    )

    const pct = s.contextPercent ?? 0
    const plan = s.limits.filter(l => l.kind !== 'spend_limit')
    const spend = s.limits.find(l => l.kind === 'spend_limit')
    const perReply = s.replies > 0 ? s.costUsd / s.replies : 0
    const costedSessions = Object.keys(life.sessionCosts ?? {}).length
    const perSession = costedSessions > 0 ? life.costUsd / costedSessions : 0

    return (
      <Box flexDirection="column" paddingX={1}>
        {heading('Context window')}
        {s.contextPercent === undefined ? (
          note('Waiting for the first reply.')
        ) : (
          <Box flexDirection="column">
            {meter(pct, `${pct}%`)}
            {note(`${short(s.contextTokens ?? 0)} of ${short(s.contextWindow)} tokens · ${short(Math.max(0, s.contextWindow - (s.contextTokens ?? 0)))} left`)}
          </Box>
        )}

        {plan.length === 0 && heading('Plan usage')}
        {plan.length === 0 && note('No limit reading yet.')}
        {plan.map(l => (
          <Box flexDirection="column" key={l.kind}>
            {heading(limitTitle(l.kind))}
            {meter(l.percentUsed, `${l.percentUsed}% used`)}
            {l.resetsAt && note(resetText(l.resetsAt))}
          </Box>
        ))}

        {heading('Usage credits')}
        {onCredits(s.limits) && <Text color="warning">● Paying from usage credits now</Text>}
        {wallet && row('Balance (est.)', usd(Math.max(0, wallet.balanceUsd - wallet.spentUsd)), 'claude')}
        {wallet && row('Spent since set', usd(wallet.spentUsd))}
        {wallet &&
          note(`${usd(wallet.balanceUsd)} entered ${wallet.setAt.slice(0, 10)}, less what was spent while a limit was used up. Auto-reload top-ups are not seen: update it with /usage-panel credits <balance>.`)}
        {!wallet && note('Copy your balance from Settings → Usage → Current balance, then run /usage-panel credits 12.78. The pane counts down from it.')}
        {spend && (
          <Box flexDirection="column">
            {meter(spend.percentUsed, `${spend.percentUsed}% used`)}
            {note(`${limitTitle(spend.kind)}${spend.resetsAt ? ` · ${resetText(spend.resetsAt)}` : ''}`)}
          </Box>
        )}

        {heading('Cost')}
        {row('This session', usd(s.costUsd), 'claude')}
        {row('Per reply (avg)', usd(perReply))}
        {row('All time', usd(life.costUsd))}
        {row('Per session (avg)', usd(perSession))}
        {note(`At API rates${life.costSince ? `; all time counts sessions since ${life.costSince.slice(0, 10)}` : ''}. On a Pro or Max plan you pay the plan price, plus any usage credits.`)}

        {heading('Tokens')}
        <Box flexDirection="row" justifyContent="flex-end">
          {cell('Session', false, true)}
          {cell('All time', false, true)}
        </Box>
        {tokenRow('Input', s.input, life.input)}
        {tokenRow('Output', s.output, life.output)}
        {tokenRow('Cache read', s.cacheRead, life.cacheRead)}
        {tokenRow('Cache write', s.cacheWrite, life.cacheWrite)}
        {tokenRow('Total', total(s), total(life), true)}

        {heading('Activity')}
        {row('Your messages', `${s.messages} · ${short(life.messages)} all time`)}
        {row('Claude replies', `${s.replies} · ${short(life.replies)} all time`)}
        {row('Last reply', `${short(s.lastTurnTokens)} tokens`)}
        {row('Sessions', short(life.sessions))}
        {s.startedAt > 0 && row('Running for', duration(Date.now() - s.startedAt))}
        {s.model !== '' && row('Model', s.model.replace(/^claude-/, ''))}
      </Box>
    )
  })
}

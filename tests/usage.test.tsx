import { expect, test } from 'claude-code/testing'

const PANE = {
  component: 'Pane',
  requestId: 'usage',
  props: { title: 'Usage', isFocused: false, bodyColumns: 36, placement: 'dock', scroll: { offset: 0, bodyRows: 60 }, view: {} },
} as const

// The test host has no plugin store; keep one in memory so lifetime totals are exercised.
function memoryStore(on: any) {
  const kept = new Map<string, unknown>()
  on('store.get', (_$: unknown, e: { key: string }) => ({ value: kept.get(e.key) }))
  on('store.set', (_$: unknown, e: { key: string; value: unknown }) => {
    kept.set(e.key, e.value)
    return { value: e.value }
  })
}

const turn = (model: string, agentId?: string) => ({
  answer: 'hi',
  durationMs: 1000,
  isAborted: false,
  turnId: 't1',
  reason: 'answer' as const,
  ...(agentId ? { agentId } : {}),
  usage: { input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, model },
})

test("a subagent's tokens count, but not as a reply", async ($, on) => {
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  memoryStore(on)
  await $.turn.complete(turn('claude-opus-5-5'))
  await $.turn.complete(turn('claude-haiku-5-5', 'agent-1'))

  const ui = await $.ui.mount({ plugin: 'usage-panel', surface: 'terminal', ...PANE })
  expect(await ui.find({ type: 'Text', text: '3000' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '1 · 1 all time' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'opus-5-5' })).toBeDefined()
  await ui.unmount()
})

test('a finished turn adds its tokens to the session and lifetime totals on every surface', async ($, on) => {
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  memoryStore(on)

  await $.turn.complete(turn('claude-opus-5-5'))

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'usage-panel', surface, ...PANE })
    expect(await ui.find({ type: 'Text', text: 'All time' })).toBeDefined()
    // Text matches by substring: the session total, the all-time total and "1500 tokens" for the last reply.
    expect((await ui.findAll({ type: 'Text', text: '1500' })).length).toBe(3)
    expect(await ui.find({ type: 'Text', text: 'opus-5-5' })).toBeDefined()
    await ui.unmount()
  }
})

test('the pane has the sections Claude shows, and says where the credit balance is', async ($, on) => {
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  memoryStore(on)
  await $.turn.complete(turn('claude-opus-5-5'))

  const ui = await $.ui.mount({ plugin: 'usage-panel', surface: 'terminal', ...PANE })
  for (const text of ['Context window', 'Usage credits', 'Cost', 'Tokens', 'Activity', 'This session', 'Per reply (avg)'])
    expect(await ui.find({ type: 'Text', text })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'then run /usage-panel credits 12.78' })).toBeDefined()
    await ui.unmount()
})


test('all-time cost is the sum of each session\'s own total, so repeats and reloads never double it', async ($, on) => {
  memoryStore(on)
  on('session.id', () => ({ value: 'session-a' }))
  on('session.measure', (_$, e) => ({ changed: e.changed }))
  const measure = (usd: number) =>
    $.session.measure({
      context: { tokens: 50_000, window: 200_000, percent: 25 },
      rateLimits: [{ kind: 'five_hour', percentUsed: 40, resetsAt: new Date(Date.now() + 3_600_000).toISOString() }],
      cost: { usd },
      changed: ['context', 'rateLimits', 'cost'],
    })

  await measure(2.5)
  await measure(2.5)
  await measure(4)

  const ui = await $.ui.mount({ plugin: 'usage-panel', surface: 'desktop', ...PANE })
  // This session and all time are both $4.00: the repeated reading was not added again.
  expect((await ui.findAll({ type: 'Text', text: '$4.00' })).length).toBe(3)
  expect(await ui.find({ type: 'Text', text: '40% used' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '25%' })).toBeDefined()
  await ui.unmount()
})

test('the credit balance counts down only while a plan limit is used up', async ($, on) => {
  memoryStore(on)
  on('session.id', () => ({ value: 'session-b' }))
  on('session.measure', (_$, e) => ({ changed: e.changed }))
  const measure = (usd: number, sessionPercent: number) =>
    $.session.measure({
      context: { tokens: 50_000, window: 200_000, percent: 25 },
      rateLimits: [{ kind: 'five_hour', percentUsed: sessionPercent }, { kind: 'seven_day', percentUsed: 28 }],
      cost: { usd },
      changed: ['rateLimits', 'cost'],
    })

  const set = await $.command.run({ command: 'usage-panel', args: 'credits $12.78' })
  expect(set.text).toBe('Usage-credit balance set to $12.78. The pane counts down from here as credits are spent.')

  await measure(1, 60) // within the plan: no credits spent
  await measure(3, 100) // limit used up: $2.00 from credits
  await measure(3.5, 100) // $0.50 more

  const ui = await $.ui.mount({ plugin: 'usage-panel', surface: 'desktop', ...PANE })
  expect(await ui.find({ type: 'Text', text: '$10.28' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '$2.50' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'Paying from usage credits now' })).toBeDefined()
  await ui.unmount()

  const status = await $.command.run({ command: 'usage-panel', args: 'credits' })
  expect(status.text).toContain('About $10.28 left')
})

test('/usage-panel says why where no surface can draw the pane', async ($, on) => {
  memoryStore(on)
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  on('ui.open', () => ({ value: { isPlaced: false, reason: 'no surface places panes' } }))
  await $.turn.complete(turn('claude-opus-5-5'))

  const r = await $.command.run({ command: 'usage-panel', args: '' })
  expect(r.text).toContain('Tokens: 1500 this session')
  expect(r.text).toContain('Model: opus-5-5')
  expect(r.text).toContain("The pane can't be shown here (no surface places panes).")
})

test('/usage-panel prints the figures even when the pane opens', async ($, on) => {
  memoryStore(on)
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  await $.turn.complete(turn('claude-opus-5-5'))

  const r = await $.command.run({ command: 'usage-panel', args: '' })
  expect(r.text).toContain('Tokens: 1500 this session')
  expect(r.text).toContain('Usage pane opened. (usage-panel 0.2.4)')
})

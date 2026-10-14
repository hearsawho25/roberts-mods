import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On, RenderPropsOf, SessionContextUsage } from 'claude-code'

import { MINUTE_MS } from '../hooks/core'

const PLUGIN = 'relay'
const SURFACES = ['terminal', 'desktop'] as const
const START = 1_000_000
const WINDOW = 400_000
/** A window where 80% comes before 300k tokens. */
const SMALL = 200_000
const NOTHING_TO_FORK = 'Nothing to hand off yet — no replies in this session.'
const SUMMARY = { role: 'user' as const, text: 'summary', toolUses: [] }

type Usage = { tokens?: number; percent?: number }

/** Stands in for the engine beneath the mod. */
function engine(on: On, options: { store?: Record<string, unknown>; usage?: Usage } = {}) {
  const clock = mock.clock(on, { now: START })
  const seen = { toasts: [] as string[], stored: [] as Array<[string, unknown]>, clock }
  on('store.set', { key: 'relay.settings.enabled' }, ($, e, next) => {
    seen.stored.push([e.key, e.value])
    return next(e)
  })
  mock.store(on, options.store)
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('session.usage', () => ({
    value: { startedAt: START, context: { window: WINDOW, ...options.usage }, rateLimits: [] },
  }))
  on('session.measure', ($, e) => ({ changed: e.changed }))
  // A compaction asked with instructions 'skip' stands for one a PreCompact hook blocked.
  on('session.compact', ($, e) => (e.instructions === 'skip' ? { skip: 'blocked by a hook' } : { messages: [SUMMARY] }))
  on('classic.SessionStart', () => ({}))
  // The handoff flow: a session with no reply yet has nothing to fork.
  on('session.root', () => ({ value: 'D:\\Projects\\app' }))
  on('process.run', () => ({ value: { exitCode: 128, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('model.fork', () => ({ value: { isAnswered: false as const, reason: 'nothing-to-fork' as const } }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('ui.toast', ($, e) => {
    seen.toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box key="engine-band" />
  })
  return seen
}

async function start($: Engine, isInteractive = true) {
  await $.session.start({ cwd: '.', surface: isInteractive ? 'terminal' : null, isInteractive })
}

async function measure($: Engine, tokens: number, window = WINDOW) {
  const context: SessionContextUsage = { tokens, window, percent: Math.round((tokens / window) * 100) }
  await $.session.measure({ context, rateLimits: [], changed: ['context'] })
}

async function reply($: Engine) {
  await $.turn.complete({ answer: 'ok', durationMs: 1000, isAborted: false, turnId: 't1', reason: 'answer' })
}

function bandProps(bodyColumns: number): RenderPropsOf['AbovePrompt'] {
  return { hasSurvey: false, isWorking: false, maxRows: 20, bodyColumns, scroll: { offset: 0, bodyRows: 20 }, view: {} }
}

async function mountBand($: Engine, surface: (typeof SURFACES)[number], columns = 120) {
  return $.ui.mount({
    plugin: PLUGIN,
    surface,
    component: 'AbovePrompt',
    props: bandProps(columns),
    viewport: { columns, rows: 40, isFullscreen: true },
  })
}

async function shown($: Engine, surface: (typeof SURFACES)[number], columns = 120) {
  const band = await mountBand($, surface, columns)
  const text = (await band.find({ key: 'relay-text' }))?.text
  const engineBand = await band.find({ key: 'engine-band' })
  const handoff = await band.find({ key: 'relay-handoff' })
  const handoffNow = await band.find({ key: 'relay-handoff-now' })
  const notYet = await band.find({ key: 'relay-not-yet' })
  await band.unmount()
  return { text, engineBand, handoff, handoffNow, notYet }
}

async function runRelay($: Engine, args = '') {
  return $.command.run({
    command: 'relay',
    args,
    origin: { kind: 'composer' },
    presentation: { isFullscreen: true, columns: 120 },
  })
}

describe('meter row', () => {
  test('draws context, cache and the Handoff button beneath what the engine drew', async ($, on) => {
    engine(on)
    await start($)
    await measure($, 232_000)
    await reply($)
    for (const surface of SURFACES) {
      const { text, engineBand, handoff } = await shown($, surface)
      expect(engineBand).toBeDefined()
      expect(text).toBe('◆ Relay   ctx ▰▰▰▰▰▱▱▱ 58% · 232k   cache ● warm · 1h left')
      expect(handoff?.props.label).toBe('Handoff')
    }
  })

  test('reads the figures at session start, before any turn', async ($, on) => {
    engine(on, { usage: { tokens: 40_000, percent: 10 } })
    await start($)
    const { text } = await shown($, 'terminal')
    expect(text).toContain('ctx ▰▱▱▱▱▱▱▱ 10% · 40k')
    expect(text).toContain('cache ● unknown')
  })

  test('shows a dash and unknown before the first reply', async ($, on) => {
    engine(on)
    await start($)
    const { text } = await shown($, 'terminal')
    expect(text).toBe('◆ Relay   ctx —   cache ● unknown')
  })

  test('the cache cools with 10 minutes left and goes cold after the hour', async ($, on) => {
    const { clock } = engine(on)
    await start($)
    await measure($, 100_000)
    await reply($)
    await clock.advance(41 * MINUTE_MS)
    expect((await shown($, 'terminal')).text).toContain('cache ● warm · 19m left')
    await clock.advance(10 * MINUTE_MS)
    expect((await shown($, 'terminal')).text).toContain('cache ● cooling · 9m left')
    await clock.advance(10 * MINUTE_MS)
    const cold = (await shown($, 'terminal')).text
    expect(cold).toContain('cache ● cold')
    expect(cold).not.toContain('left')
  })

  test('a subagent turn does not move the cache clock', async ($, on) => {
    engine(on)
    await start($)
    await $.turn.complete({ answer: 'x', durationMs: 1, isAborted: false, turnId: 't2', reason: 'answer', agentId: 'a1' })
    expect((await shown($, 'terminal')).text).toContain('cache ● unknown')
  })

  test('/clear and compaction reset to unknown', async ($, on) => {
    engine(on)
    await start($)
    await measure($, 100_000)
    await reply($)
    await $.classic.SessionStart({ source: 'clear' })
    expect((await shown($, 'terminal')).text).toBe('◆ Relay   ctx —   cache ● unknown')

    await measure($, 100_000)
    await reply($)
    await $.session.compact({ trigger: 'manual', messages: [SUMMARY, SUMMARY] })
    expect((await shown($, 'terminal')).text).toBe('◆ Relay   ctx —   cache ● unknown')
  })

  test('narrow widths drop the bar, then the time left, and keep the button', async ($, on) => {
    engine(on)
    await start($)
    await measure($, 232_000)
    await reply($)
    const noBar = await shown($, 'terminal', 62)
    expect(noBar.text).toBe('◆ Relay   ctx 58% · 232k   cache ● warm · 1h left')
    expect(noBar.handoff).toBeDefined()
    for (const surface of SURFACES) {
      const tight = await shown($, surface, 40)
      expect(tight.text).toBe('◆ Relay   ctx 58% · 232k   cache ● warm')
      expect(tight.handoff?.props.label).toBe('Handoff')
    }
  })

  test('the Handoff button starts the handoff', async ($, on) => {
    const seen = engine(on)
    await start($)
    const band = await mountBand($, 'terminal')
    await band.press({ key: 'relay-handoff' })
    expect(seen.toasts).toContain(NOTHING_TO_FORK)
  })

  test('shows in a desktop/SDK session that started with no surface and not interactive', async ($, on) => {
    engine(on)
    await start($, false)
    const { text, engineBand, handoff } = await shown($, 'desktop')
    expect(text).toBe('◆ Relay   ctx —   cache ● unknown')
    expect(handoff).toBeDefined()
    expect(engineBand).toBeDefined()
  })

  test('a survey holding the band gets the engine band alone', async ($, on) => {
    engine(on)
    await start($)
    const band = await $.ui.mount({
      plugin: PLUGIN,
      surface: 'terminal',
      component: 'AbovePrompt',
      props: { ...bandProps(120), hasSurvey: true },
      viewport: { columns: 120, rows: 40, isFullscreen: true },
    })
    expect(await band.find({ key: 'engine-band' })).toBeDefined()
    expect(await band.find({ key: 'relay-row' })).toBeUndefined()
  })

  test('an interrupted turn with no usage does not move the cache clock', async ($, on) => {
    engine(on)
    await start($)
    await $.turn.complete({ answer: '', durationMs: 10, isAborted: true, turnId: 't3', reason: 'aborted' })
    await $.turn.complete({ answer: '', durationMs: 10, isAborted: false, turnId: 't4', reason: 'error' })
    expect((await shown($, 'terminal')).text).toContain('cache ● unknown')
  })

  test('a precomputed or skipped compaction does not reset', async ($, on) => {
    engine(on)
    await start($)
    await measure($, 100_000)
    await reply($)
    await $.session.compact({ trigger: 'precompute', messages: [SUMMARY, SUMMARY] })
    await $.session.compact({ trigger: 'auto', instructions: 'skip', messages: [SUMMARY, SUMMARY] })
    expect((await shown($, 'terminal')).text).toBe('◆ Relay   ctx ▰▰▱▱▱▱▱▱ 25% · 100k   cache ● warm · 1h left')
  })

  test('a resume sets the cache clock and context from the SessionStart fields', async ($, on) => {
    engine(on)
    await start($)
    await $.classic.SessionStart({ source: 'resume', seconds_since_last_response: 30 * 60, context_tokens: 120_000 })
    expect((await shown($, 'terminal')).text).toBe('◆ Relay   ctx ▰▰▱▱▱▱▱▱ 30% · 120k   cache ● warm · 30m left')
  })

  test('a resume with tokens alone keeps the clock unknown and recomputes percent', async ($, on) => {
    engine(on, { usage: { tokens: 40_000, percent: 10 } })
    await start($)
    await $.classic.SessionStart({ source: 'resume', context_tokens: 200_000 })
    expect((await shown($, 'terminal')).text).toBe('◆ Relay   ctx ▰▰▰▰▱▱▱▱ 50% · 200k   cache ● unknown')
  })
})

describe('threshold prompt', () => {
  test('offered at 80%', async ($, on) => {
    engine(on)
    await start($)
    await measure($, 162_000, SMALL) // 81%
    for (const surface of SURFACES) {
      const { text, handoffNow, notYet, handoff, engineBand } = await shown($, surface)
      expect(text).toBe('Context is at 81% (162k). Hand off and start fresh?')
      expect(handoffNow?.props.label).toBe('Handoff now')
      expect(notYet?.props.label).toBe('Not yet')
      expect(handoff).toBeUndefined()
      expect(engineBand).toBeDefined()
    }
  })

  test('offered at 300k tokens in a larger window', async ($, on) => {
    engine(on)
    await start($)
    await $.session.measure({ context: { tokens: 300_000, window: 1_000_000, percent: 30 }, rateLimits: [], changed: ['context'] })
    expect((await shown($, 'terminal')).text).toBe('Context is at 30% (300k). Hand off and start fresh?')
  })

  test('after Not yet, 400k tokens offers again', async ($, on) => {
    engine(on)
    await start($)
    await measure($, 300_000, 1_000_000)
    const band = await mountBand($, 'terminal')
    await band.press({ key: 'relay-not-yet' })
    await band.unmount()
    await measure($, 399_000, 1_000_000)
    expect((await shown($, 'terminal')).handoffNow).toBeUndefined()
    await measure($, 400_000, 1_000_000)
    expect((await shown($, 'terminal')).handoffNow).toBeDefined()
  })

  test('/clear lifts the snooze', async ($, on) => {
    engine(on)
    await start($)
    await measure($, 162_000, SMALL)
    const band = await mountBand($, 'terminal')
    await band.press({ key: 'relay-not-yet' })
    await band.unmount()
    await $.classic.SessionStart({ source: 'clear' })
    await measure($, 162_000, SMALL)
    expect((await shown($, 'terminal')).handoffNow).toBeDefined()
  })

  test('not offered below the line', async ($, on) => {
    engine(on)
    await start($)
    await measure($, 158_000, SMALL) // 79%
    const { handoffNow, handoff } = await shown($, 'terminal')
    expect(handoffNow).toBeUndefined()
    expect(handoff).toBeDefined()
  })

  test('Not yet snoozes until 90%', async ($, on) => {
    engine(on)
    await start($)
    await measure($, 162_000, SMALL)
    const band = await mountBand($, 'terminal')
    await band.press({ key: 'relay-not-yet' })
    await band.unmount()
    expect((await shown($, 'terminal')).handoffNow).toBeUndefined()
    await measure($, 178_000, SMALL) // 89%
    expect((await shown($, 'terminal')).handoffNow).toBeUndefined()
    await measure($, 180_000, SMALL) // 90%
    const again = await shown($, 'terminal')
    expect(again.text).toBe('Context is at 90% (180k). Hand off and start fresh?')
    expect(again.handoffNow).toBeDefined()
    expect(again.notYet).toBeUndefined()
  })

  test('Handoff now starts the handoff', async ($, on) => {
    const seen = engine(on)
    await start($)
    await measure($, 162_000, SMALL)
    const band = await mountBand($, 'terminal')
    await band.press({ key: 'relay-handoff-now' })
    expect(seen.toasts).toContain(NOTHING_TO_FORK)
  })

  test('a narrow terminal keeps both buttons', async ($, on) => {
    engine(on)
    await start($)
    await measure($, 162_000, SMALL)
    const { text, handoffNow, notYet } = await shown($, 'terminal', 50)
    expect(handoffNow).toBeDefined()
    expect(notYet).toBeDefined()
    expect(text?.endsWith('…')).toBe(true)
    expect((text ?? '').length).toBeLessThanOrEqual(50 - 15 - 11 - 3)
  })
})

describe('/relay', () => {
  test('/relay off hides the row and /relay on brings it back', async ($, on) => {
    engine(on)
    await start($)
    expect((await runRelay($, 'off')).text).toContain('Relay is off')
    const off = await shown($, 'terminal')
    expect(off.text).toBeUndefined()
    expect(off.engineBand).toBeDefined()
    await runRelay($, 'on')
    expect((await shown($, 'terminal')).handoff).toBeDefined()
  })

  test('/relay off writes false to the store', async ($, on) => {
    const seen = engine(on)
    await start($)
    await runRelay($, 'off')
    expect(seen.stored).toEqual([['relay.settings.enabled', false]])
    await runRelay($, 'on')
    expect(seen.stored.at(-1)).toEqual(['relay.settings.enabled', true])
  })

  test('the status card says when the offer is snoozed', async ($, on) => {
    engine(on)
    await start($)
    await measure($, 162_000, SMALL)
    const band = await mountBand($, 'terminal')
    await band.press({ key: 'relay-not-yet' })
    await band.unmount()
    expect((await runRelay($)).text).toContain('Handoff: snoozed until 90% or 400k tokens')
  })

  test('the off switch is kept in the store', async ($, on) => {
    engine(on, { store: { 'relay.settings.enabled': false } })
    await start($)
    expect((await shown($, 'terminal')).text).toBeUndefined()
  })

  test('bare /relay answers the status card', async ($, on) => {
    const { clock } = engine(on)
    await start($)
    await measure($, 232_000)
    await reply($)
    await clock.advance(19 * MINUTE_MS)
    const { text } = await runRelay($)
    expect(text).toContain('Relay is on.')
    expect(text).toContain('Context: 58% · 232k of a 400k window')
    expect(text).toContain('Prompt cache: warm · 41m left')
    expect(text).toContain('Handoff: offered at 80% or 300k tokens')
    expect(text).toContain('Warming:')
    expect(text).toContain('Waiting handoffs:')
  })

  test('/handoff runs the handoff flow', async ($, on) => {
    engine(on)
    await start($)
    const result = await $.command.run({
      command: 'handoff',
      args: '',
      origin: { kind: 'composer' },
      presentation: { isFullscreen: true, columns: 120 },
    })
    expect(result.text).toBe(NOTHING_TO_FORK)
  })

  test('an unknown argument answers the help line', async ($, on) => {
    engine(on)
    await start($)
    expect((await runRelay($, 'sideways')).text).toContain('/relay on')
  })
})

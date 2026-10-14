import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { ModelForkResult, On, PromptOrigin, PromptSubmitResult, RenderPropsOf, SessionContextUsage } from 'claude-code'

import { HOUR_MS, MINUTE_MS, PING_PROMPT, modelPrice, pingProblem, pingUsd, projectKey, warmingSuffix } from '../hooks/core'
import { afterReply, dueAction, guardVerdict, isGuardable, isStale } from '../hooks/warming'
import type { RelayHandoff, RelayWarming } from '../types'

const PLUGIN = 'relay'
const PANE = 'relay-handoff'
const SURFACES = ['terminal', 'desktop'] as const
const START = 1_800_000_000_000
const WINDOW = 1_000_000
const ROOT = 'D:\\Projects\\app'
const HOME = 'C:\\Users\\r'
const KEY = projectKey(ROOT)
const SID = 'sid-1'
const TITLE = 'Ship the relay warming'
const BRIEF = `${TITLE}\n\n## Where things stand\n- done\n\n## What's next\n1. Test it.`
const ANSWER: ModelForkResult = {
  isAnswered: true,
  text: `${BRIEF}\n`,
  usage: { input_tokens: 10, output_tokens: 200, cache_read_input_tokens: 200_000, cache_creation_input_tokens: 0 },
}
/** A warm ping: reads the prefix, writes only its own message. */
const WARM_PING: ModelForkResult = {
  isAnswered: true,
  text: 'warm',
  usage: { input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 200_000, cache_creation_input_tokens: 50 },
}
const OVERNIGHT_TOAST = `Relay saved a handoff before the cache cooled: ${TITLE}`

type Options = {
  store?: Record<string, unknown>
  /** What a ping answers (the handoff fork always answers ANSWER). */
  ping?: ModelForkResult
  model?: string
  /** What the handoff fork answers (ANSWER when not given). */
  handoff?: ModelForkResult
  /** The engine cannot say the session id. */
  isSidMissing?: boolean
  /** The ping's fork throws. */
  isPingThrowing?: boolean
}

/** Stands in for the engine beneath the mod. */
function engine(on: On, $: Engine, options: Options = {}) {
  const clock = mock.clock(on, { now: START })
  const seen = {
    clock,
    store: new Map<string, unknown>(Object.entries(options.store ?? {})),
    prompts: [] as string[],
    toasts: [] as string[],
    written: [] as string[],
    opened: [] as string[],
    ran: [] as string[],
    filled: [] as string[],
    fillModes: [] as string[],
    submitted: [] as Array<{ text: string; origin: PromptOrigin }>,
  }
  const store = seen.store
  on('store.get', ($, e) => ({ value: store.get(e.key) }))
  on('store.set', ($, e) => {
    store.set(e.key, e.value)
    return { value: undefined }
  })
  on('store.delete', ($, e) => {
    store.delete(e.key)
    return { value: undefined }
  })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.id', () => {
    if (options.isSidMissing) throw new Error('no session id')
    return { value: SID }
  })
  on('store.keys', () => ({ value: [...store.keys()] }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.step', async function* ($, e) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: null, usage: null }
  })
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('session.usage', () => ({ value: { startedAt: START, context: { window: WINDOW }, rateLimits: [] } }))
  on('session.measure', ($, e) => ({ changed: e.changed }))
  on('session.root', () => ({ value: ROOT }))
  on('session.model', () => ({ value: options.model ?? 'claude-opus-5-5' }))
  on('env.get', ($, e) => ({ value: ({ USERPROFILE: HOME } as Record<string, string>)[e.name] }))
  on('classic.SessionStart', () => ({}))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('process.run', () => ({ value: { exitCode: 128, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('model.fork', ($, e) => {
    seen.prompts.push(e.prompt)
    if (options.isPingThrowing && e.prompt === PING_PROMPT) throw new Error('boom')
    return { value: e.prompt === PING_PROMPT ? (options.ping ?? WARM_PING) : (options.handoff ?? ANSWER) }
  })
  on('fs.write', ($, e) => {
    seen.written.push(e.path)
    return { value: undefined }
  })
  on('ui.toast', ($, e) => {
    seen.toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.open', ($, e) => {
    seen.opened.push(e.id)
    return { value: { isPlaced: true as const } }
  })
  on('ui.close', () => ({ value: undefined }))
  on('ui.copy', () => ({ value: { isCopied: true as const } }))
  on('prompt.fill', ($, e) => {
    seen.filled.push(e.text)
    seen.fillModes.push(e.mode ?? 'replace')
    return { isFilled: true }
  })
  on('prompt.read', () => ({ value: { text: seen.filled.at(-1) ?? '', cursor: 0 } }))
  on('prompt.submit', ($, e) => {
    seen.submitted.push({ text: e.text, origin: e.origin })
    return { text: e.text, origin: e.origin }
  })
  on('command.run', { command: 'clear' }, async () => {
    seen.ran.push('clear')
    await $.classic.SessionStart({ source: 'clear' })
    return { text: '' }
  })
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box key="engine-band" />
  })
  return seen
}

async function start($: Engine) {
  await $.session.start({ cwd: '.', surface: 'terminal', isInteractive: true })
}

async function measure($: Engine, tokens: number) {
  const context: SessionContextUsage = { tokens, window: WINDOW, percent: Math.round((tokens / WINDOW) * 100) }
  await $.session.measure({ context, rateLimits: [], changed: ['context'] })
}

async function reply($: Engine) {
  await $.turn.complete({ answer: 'ok', durationMs: 1000, isAborted: false, turnId: 't1', reason: 'answer' })
}

/** A session with `tokens` of context and a reply just now. */
async function replied($: Engine, tokens = 200_000) {
  await start($)
  await measure($, tokens)
  await reply($)
}

async function command($: Engine, name: string, args = '') {
  const result = await $.command.run({ command: name, args, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } })
  return result.text ?? ''
}

function bandProps(bodyColumns: number): RenderPropsOf['AbovePrompt'] {
  return { hasSurvey: false, isWorking: false, maxRows: 20, bodyColumns, scroll: { offset: 0, bodyRows: 20 }, view: {} }
}

async function mountBand($: Engine, surface: (typeof SURFACES)[number] = 'terminal', columns = 140) {
  return $.ui.mount({ plugin: PLUGIN, surface, component: 'AbovePrompt', props: bandProps(columns), viewport: { columns, rows: 40, isFullscreen: true } })
}

async function band($: Engine, surface: (typeof SURFACES)[number] = 'terminal', columns = 140) {
  const drawn = await mountBand($, surface, columns)
  const found = {
    text: (await drawn.find({ key: 'relay-text' }))?.text,
    warming: (await drawn.find({ key: 'relay-warming' }))?.text,
    guardHandoff: await drawn.find({ key: 'relay-guard-handoff' }),
    guardSend: await drawn.find({ key: 'relay-guard-send' }),
    engineBand: await drawn.find({ key: 'engine-band' }),
  }
  await drawn.unmount()
  return found
}

async function press($: Engine, key: string) {
  const drawn = await mountBand($)
  await drawn.press({ key })
  await drawn.unmount()
}

async function typed($: Engine, text: string, extra: { turnId?: string } = {}): Promise<PromptSubmitResult> {
  return $.prompt.submit({ text, origin: { kind: 'composer' }, wait: false, ...extra })
}

function pings(seen: { prompts: string[] }): number {
  return seen.prompts.filter(p => p === PING_PROMPT).length
}

function handoffForks(seen: { prompts: string[] }): number {
  return seen.prompts.filter(p => p.startsWith('Write a handoff brief')).length
}

/** A cold session: 240k of context, a reply, warming off, then 10 hours (cold for 9). */
async function cold($: Engine, seen: { clock: { advance: (ms: number) => Promise<void> } }, tokens = 240_000) {
  await replied($, tokens)
  await command($, 'keepwarm', 'off')
  await seen.clock.advance(10 * HOUR_MS)
}

describe('warming', () => {
  test('a ping after 50 idle minutes, repeated, until the window ends', async ($, on) => {
    const seen = engine(on, $, { store: { 'relay.settings.overnightHandoff': false } })
    await replied($)
    expect((await band($)).warming).toBe(' · warming · next ping 50m')
    await seen.clock.advance(49 * MINUTE_MS)
    expect(pings(seen)).toBe(0)
    await seen.clock.advance(MINUTE_MS)
    expect(pings(seen)).toBe(1)
    // The ping counts as a response: the cache reads warm a full hour from it.
    const after = await band($)
    expect(after.text).toContain('cache ● warm · 1h left')
    expect(after.warming).toBe(' · warming · next ping 50m')
    await seen.clock.advance(50 * MINUTE_MS)
    expect(pings(seen)).toBe(2)
    // The next ping would fall after the window's end (2h): none comes.
    expect((await band($)).warming).toBe(' · warming · ends 20m')
    await seen.clock.advance(3 * HOUR_MS)
    expect(pings(seen)).toBe(2)
    expect((await band($)).warming).toBe(' · warming stopped: the window ended')
    expect(seen.store.get(`relay.warming.${SID}`)).toBeUndefined()
  })

  test('a new reply moves the next ping', async ($, on) => {
    const seen = engine(on, $)
    await replied($)
    await seen.clock.advance(40 * MINUTE_MS)
    await reply($)
    await seen.clock.advance(40 * MINUTE_MS)
    expect(pings(seen)).toBe(0)
    await seen.clock.advance(10 * MINUTE_MS)
    expect(pings(seen)).toBe(1)
  })

  test('the window is kept in the store under the session id', async ($, on) => {
    const seen = engine(on, $)
    await replied($)
    const saved = seen.store.get(`relay.warming.${SID}`) as RelayWarming | undefined
    expect(saved?.windowEnd).toBe(START + 2 * HOUR_MS)
    expect(saved?.nextPingAt).toBe(START + 50 * MINUTE_MS)
  })

  test('a restored window (a reload or a resume) pings on time', async ($, on) => {
    const w: RelayWarming = { windowEnd: START + 3 * HOUR_MS, nextPingAt: START + 10 * MINUTE_MS, off: false }
    const seen = engine(on, $, { store: { [`relay.warming.${SID}`]: w } })
    await start($)
    await measure($, 200_000)
    await $.classic.SessionStart({ source: 'resume', seconds_since_last_response: 40 * 60, context_tokens: 200_000 })
    await seen.clock.advance(10 * MINUTE_MS)
    expect(pings(seen)).toBe(1)
  })

  test('the overnight handoff replaces the last ping: saved, no pane, no clear', async ($, on) => {
    const seen = engine(on, $)
    await replied($)
    await seen.clock.advance(50 * MINUTE_MS)
    expect(pings(seen)).toBe(1)
    await seen.clock.advance(50 * MINUTE_MS)
    expect(pings(seen)).toBe(1)
    expect(handoffForks(seen)).toBe(1)
    expect(seen.written).toHaveLength(1)
    const index = (seen.store.get('relay.handoffs') as RelayHandoff[] | undefined) ?? []
    expect(index).toHaveLength(1)
    expect(index[0]?.title).toBe(TITLE)
    expect(index[0]?.projectKey).toBe(KEY)
    expect(index[0]?.consumedAt).toBeUndefined()
    expect(seen.opened).toEqual([])
    expect(seen.ran).toEqual([])
    expect(seen.filled).toEqual([])
    expect(seen.toasts).toContain(OVERNIGHT_TOAST)
    expect((await band($)).warming).toBe(' · warming stopped: handoff saved')
    // Then the cache is let go: no more forks.
    await seen.clock.advance(5 * HOUR_MS)
    expect(seen.prompts).toHaveLength(2)
    expect((await band($)).text).toContain('cache ● cold')
  })

  test('/relay overnight off: the last ping is a plain ping', async ($, on) => {
    const seen = engine(on, $)
    await replied($)
    expect(await command($, 'relay', 'overnight off')).toContain('Overnight handoff is off')
    expect(seen.store.get('relay.settings.overnightHandoff')).toBe(false)
    await seen.clock.advance(100 * MINUTE_MS)
    expect(pings(seen)).toBe(2)
    expect(handoffForks(seen)).toBe(0)
    expect(await command($, 'relay', 'overnight on')).toContain('Overnight handoff is on')
    expect(seen.store.get('relay.settings.overnightHandoff')).toBe(true)
  })

  test('no overnight handoff when one was already saved since the last reply', async ($, on) => {
    const already: RelayHandoff = { id: 'a', projectKey: KEY, root: ROOT, title: 'Already', path: '', createdAt: START + MINUTE_MS }
    const seen = engine(on, $, { store: { 'relay.handoffs': [already] } })
    await replied($)
    await seen.clock.advance(100 * MINUTE_MS)
    expect(pings(seen)).toBe(2)
    expect(handoffForks(seen)).toBe(0)
  })

  test('a ping that read nothing stops warming', async ($, on) => {
    const ping: ModelForkResult = { ...WARM_PING, usage: { input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 200_000 } }
    const seen = engine(on, $, { ping })
    await replied($)
    await seen.clock.advance(50 * MINUTE_MS)
    expect(pings(seen)).toBe(1)
    expect((await band($)).warming).toBe(' · warming stopped: the ping read no cache')
    await seen.clock.advance(2 * HOUR_MS)
    expect(seen.prompts).toHaveLength(1)
    expect(await command($, 'keepwarm', 'status')).toContain('stopped: the ping read no cache')
  })

  test('a ping that wrote a tenth of its read stops warming', async ($, on) => {
    const ping: ModelForkResult = { ...WARM_PING, usage: { input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 100_000, cache_creation_input_tokens: 10_000 } }
    const seen = engine(on, $, { ping })
    await replied($)
    await seen.clock.advance(50 * MINUTE_MS)
    expect((await band($)).warming).toBe(' · warming stopped: the ping re-wrote 10k tokens')
    await seen.clock.advance(2 * HOUR_MS)
    expect(seen.prompts).toHaveLength(1)
  })

  test('a ping that is not answered stops warming', async ($, on) => {
    const seen = engine(on, $, { ping: { isAnswered: false, reason: 'api-error', status: 529, error: 'overloaded', usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } })
    await replied($)
    await seen.clock.advance(50 * MINUTE_MS)
    expect((await band($)).warming).toBe(' · warming stopped: API error (529)')
  })

  test('a session under 50k tokens is not warmed', async ($, on) => {
    const seen = engine(on, $)
    await replied($, 40_000)
    expect((await band($)).warming).toBeUndefined()
    await seen.clock.advance(3 * HOUR_MS)
    expect(seen.prompts).toEqual([])
    expect(await command($, 'keepwarm', '2h')).toBe('Relay warms sessions from 50k tokens of context; this one has 40k.')
  })

  test('Relay off: no ping', async ($, on) => {
    const seen = engine(on, $)
    await replied($)
    await command($, 'relay', 'off')
    await seen.clock.advance(3 * HOUR_MS)
    expect(seen.prompts).toEqual([])
    await reply($)
    await seen.clock.advance(3 * HOUR_MS)
    expect(seen.prompts).toEqual([])
    expect(await command($, 'keepwarm', '2h')).toBe('Relay is off. Type /relay on first.')
  })

  test('/keepwarm 90m sets the window; off stops it for the session; status says so', async ($, on) => {
    const seen = engine(on, $, { store: { 'relay.settings.overnightHandoff': false } })
    await replied($)
    expect(await command($, 'keepwarm', '90m')).toBe('Relay keeps the cache warm for 1h 30m, a ping after each 50m idle. Next ping in 50m.')
    const status = await command($, 'keepwarm', 'status')
    expect(status).toBe('Warming: on, window ends in 1h 30m · next ping in 50m · overnight handoff off')
    await seen.clock.advance(50 * MINUTE_MS)
    expect(pings(seen)).toBe(1)
    expect(await command($, 'keepwarm')).toContain('last ping just now read 200k, wrote 50 ($0.10)')
    await seen.clock.advance(HOUR_MS)
    expect(pings(seen)).toBe(1)
    expect((await band($)).warming).toBe(' · warming stopped: the window ended')

    expect(await command($, 'keepwarm', 'off')).toBe('Warming is off for this session. /keepwarm 2h turns it on again.')
    expect((await band($)).warming).toBe(' · warming stopped: turned off')
    // A reply no longer arms it.
    await reply($)
    expect((await band($)).warming).toBeUndefined()
    await seen.clock.advance(3 * HOUR_MS)
    expect(pings(seen)).toBe(1)
    expect(await command($, 'keepwarm', 'status')).toContain('off for this session')
  })

  test('/keepwarm with a bad duration says the forms and the 12h cap', async ($, on) => {
    engine(on, $)
    await replied($)
    expect(await command($, 'keepwarm', '13h')).toContain('max 12h')
    expect(await command($, 'keepwarm', 'banana')).toBe(
      'keepwarm takes a window such as 90m, 2h or 2h30m (max 12h), or off, or status.',
    )
  })

  test('the status card fills the warming line', async ($, on) => {
    engine(on, $)
    await replied($)
    expect(await command($, 'relay')).toContain('Warming: on, window ends in 2h · next ping in 50m · overnight handoff on')
  })

  test('/clear drops the window', async ($, on) => {
    const seen = engine(on, $)
    await replied($)
    await $.classic.SessionStart({ source: 'clear' })
    await seen.clock.advance(3 * HOUR_MS)
    expect(seen.prompts).toEqual([])
    expect((await band($)).warming).toBeUndefined()
  })
})

describe('the cold-cache guard', () => {
  const ROW = 'Cache went cold 9h ago. Sending this re-writes ~240k tokens (≈ $2.40).'

  test('holds a cold typed prompt once, with the estimate on the row', async ($, on) => {
    const seen = engine(on, $)
    await cold($, seen)
    const first = await typed($, 'next step please')
    expect(first.drop).toBe(
      'Relay held this prompt: cache went cold 9h ago. Sending this re-writes ~240k tokens (≈ $2.40). Choose Handoff & start fresh or Send anyway on the Relay row above the prompt, or send it again to pay it.',
    )
    expect(seen.submitted).toEqual([])
    for (const surface of SURFACES) {
      const shown = await band($, surface)
      expect(shown.text).toBe(ROW)
      expect(shown.guardHandoff?.props.label).toBe('Handoff & start fresh')
      expect(shown.guardSend?.props.label).toBe('Send anyway')
      expect(shown.engineBand).toBeDefined()
    }
    // Sent again: it goes through, and the row goes back to the meter.
    const second = await typed($, 'next step please')
    expect(second.drop).toBeUndefined()
    expect(seen.submitted.map(s => s.text)).toEqual(['next step please'])
    expect((await band($)).text).toContain('◆ Relay   ctx')
  })

  test('narrow widths keep both buttons', async ($, on) => {
    const seen = engine(on, $)
    await cold($, seen)
    await typed($, 'go')
    const shown = await band($, 'terminal', 50)
    expect(shown.guardHandoff).toBeDefined()
    expect(shown.guardSend).toBeDefined()
    expect((shown.text ?? '').endsWith('…')).toBe(true)
  })

  test('an unknown model shows tokens only', async ($, on) => {
    const seen = engine(on, $, { model: 'mystery-1' })
    await cold($, seen)
    await typed($, 'go')
    expect((await band($)).text).toBe('Cache went cold 9h ago. Sending this re-writes ~240k tokens.')
  })

  test('Send anyway submits the held text as the person, and it is not held again', async ($, on) => {
    const seen = engine(on, $)
    await cold($, seen)
    await typed($, 'the held words')
    await press($, 'relay-guard-send')
    expect(seen.submitted).toEqual([{ text: 'the held words', origin: { kind: 'plugin', name: 'relay', asUser: true } }])
    expect((await band($)).guardSend).toBeUndefined()
  })

  test('Handoff & start fresh writes the handoff at once and carries the held text past the clear', async ($, on) => {
    const seen = engine(on, $)
    await cold($, seen)
    await typed($, 'the held words')
    await press($, 'relay-guard-handoff')
    // No second cold question: the fork ran and the pane opened.
    expect(handoffForks(seen)).toBe(1)
    expect(seen.opened).toEqual([PANE])
    const pane = await $.ui.mount({
      plugin: PLUGIN,
      surface: 'terminal',
      component: 'Pane',
      requestId: PANE,
      props: { title: 'Handoff', isFocused: true, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
      viewport: { columns: 160, rows: 50, isFullscreen: true },
    })
    await pane.press({ key: 'relay-clear' })
    expect(seen.ran).toEqual(['clear'])
    expect(seen.filled[0]).toBe(`${BRIEF}\n\n---\nthe held words`)
    expect(seen.submitted).toEqual([])
  })

  test('slash commands, a warm cache, plugin prompts and prompts typed over a turn go through', async ($, on) => {
    const seen = engine(on, $)
    await replied($, 240_000)
    expect((await typed($, 'warm words')).drop).toBeUndefined()
    await command($, 'keepwarm', 'off')
    await seen.clock.advance(10 * HOUR_MS)
    expect((await typed($, '/compact')).drop).toBeUndefined()
    expect((await typed($, 'mid-turn', { turnId: 't9' })).drop).toBeUndefined()
    const peer = await $.prompt.submit({ text: 'from a peer', origin: { kind: 'peer' }, wait: false })
    expect(peer.drop).toBeUndefined()
    expect(seen.submitted.map(s => s.text)).toEqual(['warm words', '/compact', 'mid-turn', 'from a peer'])
    expect((await band($)).guardSend).toBeUndefined()
  })

  test('small sessions and Relay off are not guarded', async ($, on) => {
    const seen = engine(on, $)
    await cold($, seen, 40_000)
    expect((await typed($, 'small')).drop).toBeUndefined()
    await measure($, 240_000)
    await command($, 'relay', 'off')
    expect((await typed($, 'off')).drop).toBeUndefined()
  })

  test('a resumed cold session uses the engine estimate', async ($, on) => {
    engine(on, $)
    await start($)
    await $.classic.SessionStart({
      source: 'resume',
      seconds_since_last_response: 10 * 60 * 60,
      context_tokens: 240_000,
      prompt_cache_likely_expired: true,
      estimated_cache_write_usd: 3.33,
    })
    const held = await typed($, 'resume work')
    expect(held.drop).toContain('(≈ $3.33)')
    expect((await band($)).text).toBe('Cache went cold 9h ago. Sending this re-writes ~240k tokens (≈ $3.33).')
  })

  test('a reply ends the episode: the next cold spell holds again', async ($, on) => {
    const seen = engine(on, $)
    await cold($, seen)
    await typed($, 'one')
    await typed($, 'one')
    await reply($)
    await seen.clock.advance(2 * HOUR_MS)
    expect((await typed($, 'two')).drop).toBeDefined()
  })
})

describe('warming decisions (pure)', () => {
  const NOW = 10 * HOUR_MS
  const W: RelayWarming = { windowEnd: NOW + 30 * MINUTE_MS, nextPingAt: NOW, off: false }

  test('pingUsd prices read, write, uncached input and output', () => {
    const price = modelPrice('claude-opus-5-5')
    expect(price).toBeDefined()
    if (price === undefined) return
    const usd = pingUsd({ input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 200_000, cache_creation_input_tokens: 50 }, price)
    expect(Math.abs(usd - 0.1006) < 1e-9).toBe(true)
  })

  test('pingProblem: nothing read, or a write of a tenth of the read', () => {
    expect(pingProblem(0, 0)).toBe('the ping read no cache')
    expect(pingProblem(100_000, 9_999)).toBeUndefined()
    expect(pingProblem(100_000, 10_000)).toBe('the ping re-wrote 10k tokens')
  })

  test('afterReply arms two hours, keeps a longer window, and respects off and size', () => {
    const none: RelayWarming = { windowEnd: null, off: false, stopped: 'x' }
    const armed = afterReply(none, { now: NOW, enabled: true, tokens: 60_000 })
    expect(armed.windowEnd).toBe(NOW + 2 * HOUR_MS)
    expect(armed.nextPingAt).toBe(NOW + 50 * MINUTE_MS)
    expect(armed.stopped).toBeUndefined()
    expect(afterReply({ windowEnd: NOW + 6 * HOUR_MS, off: false }, { now: NOW, enabled: true, tokens: 60_000 }).windowEnd).toBe(NOW + 6 * HOUR_MS)
    expect(afterReply({ windowEnd: null, off: true }, { now: NOW, enabled: true, tokens: 60_000 }).windowEnd).toBeNull()
    expect(afterReply(none, { now: NOW, enabled: true, tokens: 49_999 }).windowEnd).toBeNull()
    expect(afterReply(none, { now: NOW, enabled: false, tokens: 60_000 }).windowEnd).toBeNull()
  })

  test('dueAction: stale, cold, small, last', () => {
    const facts = { w: W, enabled: true, lastResponseAt: NOW - 50 * MINUTE_MS, tokens: 60_000, now: NOW }
    expect(dueAction(facts)).toEqual({ kind: 'ping', isLast: true })
    expect(dueAction({ ...facts, w: { ...W, windowEnd: NOW + 3 * HOUR_MS } })).toEqual({ kind: 'ping', isLast: false })
    expect(dueAction({ ...facts, w: { ...W, nextPingAt: NOW + MINUTE_MS } })).toEqual({ kind: 'rearm' })
    expect(dueAction({ ...facts, lastResponseAt: NOW - 2 * HOUR_MS })).toEqual({ kind: 'stop', reason: 'the cache is already cold' })
    expect(dueAction({ ...facts, tokens: 10 })).toEqual({ kind: 'stop', reason: 'context under 50k' })
    expect(dueAction({ ...facts, enabled: false })).toEqual({ kind: 'drop' })
    expect(dueAction({ ...facts, now: NOW + HOUR_MS })).toEqual({ kind: 'stop', reason: 'the window ended' })
    expect(dueAction({ ...facts, w: null })).toEqual({ kind: 'none' })
  })

  test('warmingSuffix while armed, after a stop, and with nothing', () => {
    expect(warmingSuffix({ ...W, nextPingAt: NOW + 12 * MINUTE_MS }, NOW)).toBe(' · warming · next ping 12m')
    expect(warmingSuffix({ windowEnd: null, off: false, stopped: 'the window ended' }, NOW)).toBe(' · warming stopped: the window ended')
    expect(warmingSuffix(null, NOW)).toBeUndefined()
  })

  test('the guard looks only at typed prompts, and holds once per episode', () => {
    expect(isGuardable({ origin: { kind: 'composer' }, text: 'hi' })).toBe(true)
    expect(isGuardable({ origin: { kind: 'bridge' }, text: 'hi' })).toBe(true)
    expect(isGuardable({ origin: { kind: 'plugin', name: 'relay', asUser: true }, text: 'hi' })).toBe(false)
    expect(isGuardable({ origin: { kind: 'composer' }, text: '  /clear' })).toBe(false)
    expect(isGuardable({ origin: { kind: 'composer' }, text: 'hi', turnId: 't' })).toBe(false)
    expect(isGuardable({ origin: { kind: 'composer' }, text: 'hi', attachments: [{ type: 'image' }] })).toBe(false)
    const facts = { enabled: true, tokens: 60_000, lastResponseAt: NOW - 2 * HOUR_MS, episode: null, now: NOW }
    expect(guardVerdict(facts)).toBe('hold')
    expect(guardVerdict({ ...facts, episode: NOW - 2 * HOUR_MS })).toBe('release')
    expect(guardVerdict({ ...facts, lastResponseAt: NOW - 10 * MINUTE_MS })).toBe('pass')
    expect(guardVerdict({ ...facts, tokens: 10 })).toBe('pass')
    expect(guardVerdict({ ...facts, enabled: false })).toBe('pass')
  })
})

const HELD_BACK = 'Your held message is back in the prompt box.'

async function step($: Engine) {
  const stream = $.turn.step({ turnId: 't2', index: 0, model: 'claude-opus-5-5', messageCount: 3 })
  for await (const chunk of stream) void chunk
}

describe('after the final review', () => {
  test('no ping while a main-thread turn runs; its step stamps the cache clock; its end re-arms', async ($, on) => {
    const seen = engine(on, $)
    await replied($)
    await seen.clock.advance(45 * MINUTE_MS)
    await $.turn.start({ text: 'long job', turnId: 't2' })
    await step($)
    // The step was sent at 45m: the cache reads warm for a full hour from it.
    expect((await band($)).text).toContain('cache ● warm · 1h left')
    await seen.clock.advance(20 * MINUTE_MS)
    expect(seen.prompts).toEqual([])
    await reply($)
    await seen.clock.advance(49 * MINUTE_MS)
    expect(pings(seen)).toBe(0)
    await seen.clock.advance(MINUTE_MS)
    expect(pings(seen)).toBe(1)
  })

  test('an interrupted turn re-arms the timer it held back', async ($, on) => {
    const seen = engine(on, $)
    await replied($)
    await seen.clock.advance(40 * MINUTE_MS)
    await $.turn.start({ text: 'x', turnId: 't3' })
    await step($)
    await seen.clock.advance(15 * MINUTE_MS)
    expect(seen.prompts).toEqual([])
    await $.turn.complete({ answer: '', durationMs: 10, isAborted: true, turnId: 't3', reason: 'aborted' })
    await seen.clock.settle()
    expect(pings(seen)).toBe(1)
  })

  test('/relay off in another session is picked up when the timer fires', async ($, on) => {
    const seen = engine(on, $)
    await replied($)
    seen.store.set('relay.settings.enabled', false)
    await seen.clock.advance(3 * HOUR_MS)
    expect(seen.prompts).toEqual([])
    expect((await band($)).text).toBeUndefined()
  })

  test('a /keepwarm window shorter than the first ping ends with the overnight handoff', async ($, on) => {
    const seen = engine(on, $)
    await replied($)
    await command($, 'keepwarm', '30m')
    await seen.clock.advance(30 * MINUTE_MS)
    expect(pings(seen)).toBe(0)
    expect(handoffForks(seen)).toBe(1)
    expect(seen.toasts).toContain(OVERNIGHT_TOAST)
  })

  test('Handoff & start fresh that fails puts the held text back in the box', async ($, on) => {
    const seen = engine(on, $, { handoff: { isAnswered: false, reason: 'nothing-to-fork' } })
    await cold($, seen)
    await typed($, 'the held words')
    expect(seen.store.get(`relay.heldText.${SID}`)).toEqual({ text: 'the held words', at: START + 10 * HOUR_MS })
    await press($, 'relay-guard-handoff')
    expect(seen.filled).toEqual(['the held words'])
    expect(seen.fillModes).toEqual(['append'])
    expect(seen.toasts).toContain(HELD_BACK)
    expect(seen.store.get(`relay.heldText.${SID}`)).toBeUndefined()
    expect(seen.submitted).toEqual([])
  })

  test('Cancel in the handoff pane puts the held text back', async ($, on) => {
    const seen = engine(on, $)
    await cold($, seen)
    await typed($, 'the held words')
    await press($, 'relay-guard-handoff')
    const pane = await $.ui.mount({
      plugin: PLUGIN,
      surface: 'terminal',
      component: 'Pane',
      requestId: PANE,
      props: { title: 'Handoff', isFocused: true, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
      viewport: { columns: 160, rows: 50, isFullscreen: true },
    })
    await pane.press({ key: 'relay-cancel' })
    expect(seen.filled).toEqual(['the held words'])
    expect(seen.toasts).toContain(HELD_BACK)
  })

  test('a reply arriving while a prompt is held puts it back in the box', async ($, on) => {
    const seen = engine(on, $)
    await cold($, seen)
    await typed($, 'the held words')
    await reply($)
    expect(seen.filled).toEqual(['the held words'])
    expect(seen.fillModes).toEqual(['append'])
    expect((await band($)).guardSend).toBeUndefined()
    expect(seen.store.get(`relay.heldText.${SID}`)).toBeUndefined()
  })

  test('a held prompt kept in the store goes back in the box at session start', async ($, on) => {
    const seen = engine(on, $, { store: { [`relay.heldText.${SID}`]: { text: 'kept', at: START - HOUR_MS } } })
    await start($)
    expect(seen.filled).toEqual(['kept'])
    expect(seen.store.get(`relay.heldText.${SID}`)).toBeUndefined()
  })

  test('session start prunes dead windows, old off flags and old held prompts', async ($, on) => {
    const seen = engine(on, $, {
      store: {
        'relay.warming.dead': { windowEnd: START - 1, off: false },
        'relay.warming.live': { windowEnd: START + HOUR_MS, off: false },
        'relay.warming.offRecent': { windowEnd: null, off: true, offAt: START - HOUR_MS },
        'relay.warming.offOld': { windowEnd: null, off: true, offAt: START - 4 * 24 * HOUR_MS },
        'relay.warming.junk': 'x',
        'relay.heldText.old': { text: 'a', at: START - 8 * 24 * HOUR_MS },
        'relay.heldText.other': { text: 'b', at: START - HOUR_MS },
        'relay.settings.enabled': true,
      },
    })
    await start($)
    expect([...seen.store.keys()].sort()).toEqual([
      'relay.heldText.other',
      'relay.settings.enabled',
      'relay.warming.live',
      'relay.warming.offRecent',
    ])
  })

  test('with no session id, warming lives in memory only', async ($, on) => {
    const seen = engine(on, $, { isSidMissing: true })
    await replied($)
    expect([...seen.store.keys()].filter(key => key.startsWith('relay.warming.'))).toEqual([])
    await seen.clock.advance(50 * MINUTE_MS)
    expect(pings(seen)).toBe(1)
  })

  test('a ping that throws stops warming and says so', async ($, on) => {
    const seen = engine(on, $, { isPingThrowing: true })
    await replied($)
    await seen.clock.advance(50 * MINUTE_MS)
    expect((await band($)).warming).toContain(' · warming stopped: the ping failed')
    await seen.clock.advance(2 * HOUR_MS)
    expect(pings(seen)).toBe(1)
  })

  test('the guard passes context, mentions and bash mode', () => {
    expect(isGuardable({ origin: { kind: 'composer' }, text: 'hi', context: ['attached'] })).toBe(false)
    expect(isGuardable({ origin: { kind: 'composer' }, text: 'look at @src/a.ts' })).toBe(false)
    expect(isGuardable({ origin: { kind: 'composer' }, text: '!ls' })).toBe(false)
    expect(isGuardable({ origin: { kind: 'composer' }, text: 'mail me at a@b.c' })).toBe(true)
    expect(isGuardable({ origin: { kind: 'composer' }, text: 'hi', context: [] })).toBe(true)
  })

  test('dueAction: a running turn waits; a window with no ping left ends warm', () => {
    const now = 10 * HOUR_MS
    const w: RelayWarming = { windowEnd: now + HOUR_MS, nextPingAt: now, off: false }
    const facts = { w, enabled: true, lastResponseAt: now - 50 * MINUTE_MS, tokens: 60_000, now }
    expect(dueAction({ ...facts, isTurnRunning: true })).toEqual({ kind: 'rearm' })
    const short: RelayWarming = { windowEnd: now, nextPingAt: now + 20 * MINUTE_MS, off: false }
    expect(dueAction({ ...facts, w: short, lastResponseAt: now - 30 * MINUTE_MS })).toEqual({ kind: 'end', reason: 'the window ended' })
    expect(dueAction({ ...facts, w: short, lastResponseAt: now - 2 * HOUR_MS })).toEqual({ kind: 'stop', reason: 'the window ended' })
    expect(isStale('relay.warming.x', { windowEnd: null, off: true }, now)).toBe(true)
    expect(isStale('relay.other', 'x', now)).toBe(false)
  })
})

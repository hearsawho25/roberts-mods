import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { ModelForkResult, On, RenderPropsOf, SessionContextUsage } from 'claude-code'

import { DAY_MS, HOUR_MS, MINUTE_MS, handoffDir, handoffFileName, joinPath, projectKey } from '../hooks/core'
import type { RelayHandoff } from '../types'

const PLUGIN = 'relay'
const PANE = 'relay-handoff'
const SURFACES = ['terminal', 'desktop'] as const
const START = 1_800_000_000_000
const WINDOW = 1_000_000
const ROOT = 'D:\\Projects\\app'
const HOME = 'C:\\Users\\r'
const KEY = projectKey(ROOT)
const TITLE = 'Ship the relay handoff'
const BRIEF = `${TITLE}\n\n## Where things stand\n- Branch: \`main\`\n\n## What's next\n1. Test it.`
const ANSWER: ModelForkResult = {
  isAnswered: true,
  text: `${BRIEF}\n`,
  usage: { input_tokens: 10, output_tokens: 200, cache_read_input_tokens: 90_000, cache_creation_input_tokens: 0 },
}
const NOTHING: ModelForkResult = { isAnswered: false, reason: 'nothing-to-fork' }
const LOADED = 'Handoff loaded — review it and press Enter.'

/** git argv (after `git`) → stdout; a command not listed exits 128. */
const REPO: Record<string, string> = {
  'rev-parse --abbrev-ref HEAD': 'main\n',
  'symbolic-ref --short HEAD': 'main\n',
  'log -1 --format=%h %s': 'abc1234 Fix the meter\n',
  'rev-list --left-right --count @{u}...HEAD': '1\t2\n',
  '--no-optional-locks status --porcelain': ' M hooks/register.tsx\n',
}
const READ_ONLY = new Set(Object.keys(REPO))

type Options = {
  store?: Record<string, unknown>
  fork?: ModelForkResult
  /** Holds the fork until the test resolves it. */
  gate?: Promise<void>
  git?: Record<string, string>
  model?: string
  usage?: { tokens?: number; percent?: number }
  files?: Record<string, string>
  isWriteRefused?: boolean
  /** Whether the clear the mod runs raises SessionStart (source clear) beneath it, as a session does. */
  isClearStarting?: boolean
  /** The environment the mod reads its home folder from. */
  env?: Record<string, string>
  isCopyRefused?: boolean
  isFillRefused?: boolean
  /** The clear empties the prompt box after the SessionStart fill (read back as ''), once. */
  isBoxEmptiedOnce?: boolean
  isClearRefused?: boolean
  isPaneUnplaced?: boolean
}

/** Stands in for the engine beneath the mod; `$` is the test's own, for the clear's SessionStart. */
function engine(on: On, $: Engine, options: Options = {}) {
  const clock = mock.clock(on, { now: START })
  const seen = {
    clock,
    store: null as unknown as Map<string, unknown>,
    toasts: [] as string[],
    prompts: [] as string[],
    git: [] as string[],
    written: [] as Array<[string, string]>,
    opened: [] as string[],
    closed: [] as string[],
    copies: [] as string[],
    filled: [] as Array<{ text: string; mode: string }>,
    ran: [] as string[],
    submitted: [] as string[],
  }
  // The store, kept where the test can read it back.
  const store = new Map<string, unknown>(Object.entries(options.store ?? {}))
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
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('session.usage', () => ({ value: { startedAt: START, context: { window: WINDOW, ...options.usage }, rateLimits: [] } }))
  on('session.measure', ($, e) => ({ changed: e.changed }))
  on('session.root', () => ({ value: ROOT }))
  on('session.model', () => ({ value: options.model ?? 'claude-opus-5-5' }))
  on('env.get', ($, e) => ({ value: (options.env ?? { USERPROFILE: HOME })[e.name] }))
  on('classic.SessionStart', () => ({}))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('process.run', ($, e) => {
    const args = e.argv.slice(1).join(' ')
    seen.git.push(args)
    const out = (options.git ?? REPO)[args]
    return {
      value: { exitCode: out === undefined ? 128 : 0, stdout: out ?? '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
    }
  })
  on('model.fork', async ($, e) => {
    seen.prompts.push(e.prompt)
    if (options.gate) await options.gate
    return { value: options.fork ?? ANSWER }
  })
  on('fs.write', ($, e) => {
    if (options.isWriteRefused) return { deny: 'EACCES: permission denied' }
    seen.written.push([e.path, e.text])
    return { value: undefined }
  })
  on('fs.read', ($, e) => {
    const text = options.files?.[e.path]
    return text === undefined ? { deny: 'ENOENT: no such file' } : { value: text }
  })
  on('ui.toast', ($, e) => {
    seen.toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.open', ($, e) => {
    seen.opened.push(e.id)
    return { value: options.isPaneUnplaced ? { isPlaced: false as const, reason: 'narrow' } : { isPlaced: true as const } }
  })
  on('ui.close', ($, e) => {
    seen.closed.push(e.id)
    return { value: undefined }
  })
  on('ui.copy', ($, e) => {
    seen.copies.push(e.text)
    return { value: options.isCopyRefused ? { isCopied: false as const, reason: 'no-clipboard' as const } : { isCopied: true as const } }
  })
  on('prompt.fill', ($, e) => {
    seen.filled.push({ text: e.text, mode: e.mode })
    if (options.isFillRefused) return { isFilled: false, refusal: 'dialog' as const }
    box = e.text
    return { isFilled: true }
  })
  let box = ''
  let isEmptied = false
  on('prompt.read', () => {
    if (options.isBoxEmptiedOnce && !isEmptied) {
      isEmptied = true
      box = ''
    }
    return { value: { text: box, cursor: box.length } }
  })
  on('prompt.submit', ($, e) => {
    seen.submitted.push(e.text)
    return { text: e.text } as never
  })
  on('command.run', { command: 'clear' }, async () => {
    seen.ran.push('clear')
    if (options.isClearRefused) throw new Error('clear refused')
    if (options.isClearStarting !== false) await $.classic.SessionStart({ source: 'clear' })
    return { text: '' }
  })
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box key="engine-band" />
  })
  seen.store = store
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

/** A session with 100k of context and a warm cache. */
async function warm($: Engine) {
  await start($)
  await measure($, 100_000)
  await reply($)
}

async function command($: Engine, name: string, args = '') {
  const result = await $.command.run({
    command: name,
    args,
    origin: { kind: 'composer' },
    presentation: { isFullscreen: true, columns: 120 },
  })
  return result.text ?? ''
}

function bandProps(bodyColumns: number): RenderPropsOf['AbovePrompt'] {
  return { hasSurvey: false, isWorking: false, maxRows: 20, bodyColumns, scroll: { offset: 0, bodyRows: 20 }, view: {} }
}

async function mountBand($: Engine, surface: (typeof SURFACES)[number] = 'terminal', columns = 140) {
  return $.ui.mount({
    plugin: PLUGIN,
    surface,
    component: 'AbovePrompt',
    props: bandProps(columns),
    viewport: { columns, rows: 40, isFullscreen: true },
  })
}

async function mountPane($: Engine, surface: (typeof SURFACES)[number] = 'terminal') {
  const props: RenderPropsOf['Pane'] = {
    title: 'Handoff',
    isFocused: true,
    bodyColumns: 80,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  }
  return $.ui.mount({ plugin: PLUGIN, surface, component: 'Pane', requestId: PANE, props, viewport: { columns: 160, rows: 50, isFullscreen: true } })
}

async function band($: Engine, surface: (typeof SURFACES)[number] = 'terminal') {
  const drawn = await mountBand($, surface)
  const found = {
    text: (await drawn.find({ key: 'relay-text' }))?.text,
    offer: (await drawn.find({ key: 'relay-offer-text' }))?.text,
    engineBand: await drawn.find({ key: 'engine-band' }),
    coldWrite: await drawn.find({ key: 'relay-cold-write' }),
    coldCancel: await drawn.find({ key: 'relay-cold-cancel' }),
    load: await drawn.find({ key: 'relay-offer-load' }),
    dismiss: await drawn.find({ key: 'relay-offer-dismiss' }),
  }
  await drawn.unmount()
  return found
}

function index(seen: { store: Map<string, unknown> }): RelayHandoff[] {
  return (seen.store.get('relay.handoffs') as RelayHandoff[] | undefined) ?? []
}

function expectedPath(title = TITLE, at = START) {
  return joinPath(handoffDir(HOME, KEY), handoffFileName(new Date(at), title))
}

function saved(id: string, title: string, createdAt: number, extra: Partial<RelayHandoff> = {}): RelayHandoff {
  return { id, projectKey: KEY, root: ROOT, title, path: `${HOME}\\.claude\\handoffs\\${KEY}\\${id}.md`, createdAt, ...extra }
}

describe('writing a handoff', () => {
  test('happy path: git facts in the fork prompt, the file, the index record and the pane', async ($, on) => {
    const seen = engine(on, $)
    await warm($)
    const answer = await command($, 'handoff')
    expect(answer).toContain(`Handoff written: "${TITLE}"`)

    expect(seen.prompts).toHaveLength(1)
    const prompt = seen.prompts[0] ?? ''
    expect(prompt).toContain('- Branch: `main`')
    expect(prompt).toContain('- HEAD: `abc1234` Fix the meter')
    expect(prompt).toContain('- Upstream: 2 ahead, 1 behind')
    expect(prompt).toContain('- Uncommitted changes: 1 file')
    expect(prompt).toContain('`M` hooks/register.tsx')
    // Read-only git commands only.
    for (const args of seen.git) expect(READ_ONLY.has(args)).toBe(true)

    expect(seen.written).toEqual([[expectedPath(), `${BRIEF}\n`]])
    expect(index(seen)).toEqual([
      { id: `${START}-ship-the-relay-handoff`, projectKey: KEY, root: ROOT, title: TITLE, path: expectedPath(), createdAt: START },
    ])
    expect(seen.opened).toEqual([PANE])

    for (const surface of SURFACES) {
      const pane = await mountPane($, surface)
      expect(await pane.find({ type: 'Text', text: TITLE })).toBeDefined()
      expect(await pane.find({ type: 'Markdown', text: "## What's next" })).toBeDefined()
      expect((await pane.find({ key: 'relay-clear' }))?.props.label).toBe('Clear & continue')
      expect((await pane.find({ key: 'relay-copy' }))?.props.label).toBe('Copy')
      expect((await pane.find({ key: 'relay-cancel' }))?.props.label).toBe('Cancel')
      await pane.unmount()
    }
    // Back to the meter row once written.
    expect((await band($)).text).toContain('◆ Relay   ctx')
  })

  test('the Handoff button on the row writes one too', async ($, on) => {
    const seen = engine(on, $)
    await warm($)
    const drawn = await mountBand($)
    await drawn.press({ key: 'relay-handoff' })
    await drawn.unmount()
    expect(seen.prompts).toHaveLength(1)
    expect(seen.opened).toEqual([PANE])
  })

  test('not a repo: no git facts, only the two probing commands', async ($, on) => {
    const seen = engine(on, $, { git: {} })
    await warm($)
    await command($, 'handoff')
    expect(seen.prompts[0]).toContain('(none: the session root is not a git repository)')
    expect([...seen.git].sort()).toEqual(['rev-parse --abbrev-ref HEAD', 'symbolic-ref --short HEAD'])
    expect(seen.opened).toEqual([PANE])
  })

  test('nothing to fork: a friendly toast, nothing saved, no pane', async ($, on) => {
    const seen = engine(on, $, { fork: NOTHING })
    await start($)
    const answer = await command($, 'handoff')
    expect(answer).toBe('Nothing to hand off yet — no replies in this session.')
    expect(seen.toasts).toContain('Nothing to hand off yet — no replies in this session.')
    expect(seen.written).toEqual([])
    expect(index(seen)).toEqual([])
    expect(seen.opened).toEqual([])
    expect((await band($)).text).toBe('◆ Relay   ctx —   cache ● unknown')
  })

  test('a file that cannot be written keeps the record with no path', async ($, on) => {
    const seen = engine(on, $, { isWriteRefused: true })
    await warm($)
    await command($, 'handoff')
    expect(seen.toasts.some(text => text.startsWith('The handoff file could not be saved:'))).toBe(true)
    const [record] = index(seen)
    expect(record?.path).toBe('')
    expect(record?.title).toBe(TITLE)
    const pane = await mountPane($)
    expect(await pane.find({ type: 'Text', text: 'Not saved to a file.' })).toBeDefined()
  })

  test('a cold cache asks first; Write it anyway goes on', async ($, on) => {
    const seen = engine(on, $)
    await start($)
    await measure($, 240_000)
    await reply($)
    // Warming would keep the cache warm (and save an overnight handoff): let it go cold.
    await command($, 'keepwarm', 'off')
    await seen.clock.advance(2 * HOUR_MS)

    const drawn = await mountBand($)
    await drawn.press({ key: 'relay-handoff' })
    await drawn.unmount()
    expect(seen.prompts).toEqual([])
    for (const surface of SURFACES) {
      const shown = await band($, surface)
      expect(shown.text).toBe('Cache is cold — writing the handoff re-writes ~240k tokens (≈ $2.40).')
      expect(shown.coldWrite?.props.label).toBe('Write it anyway')
      expect(shown.coldCancel?.props.label).toBe('Cancel')
      expect(shown.engineBand).toBeDefined()
    }

    const again = await mountBand($)
    await again.press({ key: 'relay-cold-write' })
    await again.unmount()
    expect(seen.prompts).toHaveLength(1)
    expect(seen.opened).toEqual([PANE])
    expect((await band($)).text).toContain('cache ● cold')
  })

  test('cold with an unknown model shows tokens only; Cancel drops the question', async ($, on) => {
    const seen = engine(on, $, { model: 'mystery-1' })
    await start($)
    await measure($, 240_000)
    await reply($)
    // Warming would keep the cache warm (and save an overnight handoff): let it go cold.
    await command($, 'keepwarm', 'off')
    await seen.clock.advance(2 * HOUR_MS)
    expect(await command($, 'handoff')).toContain('Cache is cold — writing the handoff re-writes ~240k tokens.')
    expect((await band($)).text).toBe('Cache is cold — writing the handoff re-writes ~240k tokens.')
    const drawn = await mountBand($)
    await drawn.press({ key: 'relay-cold-cancel' })
    await drawn.unmount()
    expect((await band($)).text).toContain('◆ Relay   ctx')
    expect(seen.prompts).toEqual([])
  })

  test('a cold cache under 50k tokens does not ask', async ($, on) => {
    const seen = engine(on, $)
    await start($)
    await measure($, 40_000)
    await reply($)
    await seen.clock.advance(2 * HOUR_MS)
    await command($, 'handoff')
    expect(seen.prompts).toHaveLength(1)
  })

  test('a second press while one is being written is ignored', async ($, on) => {
    let release = () => {}
    const gate = new Promise<void>(resolve => {
      release = resolve
    })
    const seen = engine(on, $, { gate })
    await warm($)
    const drawn = await mountBand($)
    const first = drawn.press({ key: 'relay-handoff' })
    // Let the first press reach the fork.
    for (let i = 0; i < 500 && seen.prompts.length === 0; i++) await Promise.resolve()
    expect(seen.prompts).toHaveLength(1)
    expect((await band($)).text).toBe('◆ Relay   Writing handoff…')
    expect(await command($, 'handoff')).toBe('Already writing a handoff.')
    expect(seen.toasts).toContain('Already writing a handoff')
    release()
    await first
    await drawn.unmount()
    expect(seen.prompts).toHaveLength(1)
    expect(seen.opened).toEqual([PANE])
    expect((await band($)).text).toContain('◆ Relay   ctx')
  })
})

describe('the preview pane', () => {
  test('Clear & continue: clipboard, consumed, /clear, then the prompt box filled and never sent', async ($, on) => {
    const seen = engine(on, $)
    await warm($)
    await command($, 'handoff')
    const pane = await mountPane($)
    await pane.press({ key: 'relay-clear' })

    expect(seen.copies).toEqual([BRIEF])
    expect((index(seen))[0]?.consumedAt).toBe(START)
    expect(seen.closed).toEqual([PANE])
    expect(seen.ran).toEqual(['clear'])
    // Filled once, on the SessionStart (source clear) the clear raised.
    expect(seen.filled).toEqual([{ text: BRIEF, mode: 'replace' }])
    expect(seen.submitted).toEqual([])
    expect(seen.toasts).toContain(LOADED)
    expect(seen.store.get('relay.fillAfterClear')).toBeUndefined()
    // The cleared session is a fresh window, with no offer (the handoff was used).
    const shown = await band($)
    expect(shown.text).toBe('◆ Relay   ctx —   cache ● unknown')
    expect(shown.offer).toBeUndefined()
  })

  test('when the clear raises no SessionStart, the box is filled after it resolves, once', async ($, on) => {
    const seen = engine(on, $, { isClearStarting: false })
    await warm($)
    await command($, 'handoff')
    const pane = await mountPane($)
    await pane.press({ key: 'relay-clear' })
    expect(seen.filled).toEqual([{ text: BRIEF, mode: 'replace' }])
    // A late SessionStart does not fill again, and clears the marker.
    await $.classic.SessionStart({ source: 'clear' })
    expect(seen.filled).toHaveLength(1)
    expect(seen.store.get('relay.fillAfterClear')).toBeUndefined()
    expect(seen.submitted).toEqual([])
  })

  test('a marker older than 10 minutes is dropped, not filled', async ($, on) => {
    const seen = engine(on, $, { store: { 'relay.fillAfterClear': { text: 'stale', at: START - 11 * MINUTE_MS } } })
    await start($)
    await $.classic.SessionStart({ source: 'clear' })
    expect(seen.filled).toEqual([])
    expect(seen.store.get('relay.fillAfterClear')).toBeUndefined()
  })

  test('Copy puts the text on the clipboard and keeps the pane', async ($, on) => {
    const seen = engine(on, $)
    await warm($)
    await command($, 'handoff')
    const pane = await mountPane($)
    await pane.press({ key: 'relay-copy' })
    expect(seen.copies).toEqual([BRIEF])
    expect(seen.toasts).toContain('Handoff copied')
    expect(seen.closed).toEqual([])
    expect((index(seen))[0]?.consumedAt).toBeUndefined()
  })

  test('Cancel closes it and leaves the handoff waiting for the next session', async ($, on) => {
    const seen = engine(on, $)
    await warm($)
    await command($, 'handoff')
    const pane = await mountPane($)
    await pane.press({ key: 'relay-cancel' })
    expect(seen.closed).toEqual([PANE])
    expect(seen.ran).toEqual([])
    expect((index(seen))[0]?.consumedAt).toBeUndefined()
    await $.classic.SessionStart({ source: 'startup' })
    expect((await band($)).offer).toBe(`Handoff waiting: "${TITLE}" · from just now`)
  })
})

describe('the pending offer', () => {
  const OLD = saved('old', 'Old work', START - 10 * HOUR_MS)
  const OLD_TEXT = 'Old work\n\n## Where things stand\nhalf done\n'

  test('offered at startup above the meter row; Load fills the prompt box and consumes it', async ($, on) => {
    const seen = engine(on, $, { store: { 'relay.handoffs': [OLD] }, files: { [OLD.path]: OLD_TEXT } })
    await start($)
    await $.classic.SessionStart({ source: 'startup' })
    for (const surface of SURFACES) {
      const shown = await band($, surface)
      expect(shown.offer).toBe('Handoff waiting: "Old work" · from 10h ago')
      expect(shown.text).toBe('◆ Relay   ctx —   cache ● unknown')
      expect(shown.load?.props.label).toBe('Load')
      expect(shown.dismiss?.props.label).toBe('Dismiss')
      expect(shown.engineBand).toBeDefined()
    }
    const drawn = await mountBand($)
    await drawn.press({ key: 'relay-offer-load' })
    await drawn.unmount()
    expect(seen.filled).toEqual([{ text: OLD_TEXT.trimEnd(), mode: 'replace' }])
    expect(seen.submitted).toEqual([])
    expect(seen.toasts).toContain(LOADED)
    expect((index(seen))[0]?.consumedAt).toBe(START)
    expect((await band($)).offer).toBeUndefined()
  })

  test('Dismiss consumes it without filling', async ($, on) => {
    const seen = engine(on, $, { store: { 'relay.handoffs': [OLD] } })
    await start($)
    await $.classic.SessionStart({ source: 'startup' })
    const drawn = await mountBand($)
    await drawn.press({ key: 'relay-offer-dismiss' })
    await drawn.unmount()
    expect(seen.filled).toEqual([])
    expect((index(seen))[0]?.consumedAt).toBe(START)
    expect((await band($)).offer).toBeUndefined()
  })

  test('a missing file says so and keeps the offer', async ($, on) => {
    const seen = engine(on, $, { store: { 'relay.handoffs': [OLD] } })
    await start($)
    await $.classic.SessionStart({ source: 'startup' })
    const drawn = await mountBand($)
    await drawn.press({ key: 'relay-offer-load' })
    await drawn.unmount()
    expect(seen.filled).toEqual([])
    expect(seen.toasts.some(text => text.startsWith('The handoff file is missing'))).toBe(true)
    expect((index(seen))[0]?.consumedAt).toBeUndefined()
    expect((await band($)).offer).toBeDefined()
  })

  test('older than 7 days, used, or another project: not offered', async ($, on) => {
    engine(on, $, {
      store: {
        'relay.handoffs': [
          saved('stale', 'Stale', START - 8 * DAY_MS),
          saved('used', 'Used', START - HOUR_MS, { consumedAt: START - 1 }),
          saved('elsewhere', 'Elsewhere', START - HOUR_MS, { projectKey: 'C--other' }),
        ],
      },
    })
    await start($)
    await $.classic.SessionStart({ source: 'startup' })
    expect((await band($)).offer).toBeUndefined()
  })

  test('offered after a plain /clear too, and not on resume', async ($, on) => {
    engine(on, $, { store: { 'relay.handoffs': [OLD] } })
    await start($)
    await $.classic.SessionStart({ source: 'resume' })
    expect((await band($)).offer).toBeUndefined()
    await $.classic.SessionStart({ source: 'clear' })
    expect((await band($)).offer).toBe('Handoff waiting: "Old work" · from 10h ago')
  })
})

describe('/handoff list and the status card', () => {
  test('/handoff list: this project first, with path and state', async ($, on) => {
    engine(on, $, {
      store: {
        'relay.handoffs': [
          saved('other', 'Other project', START - HOUR_MS, { projectKey: 'C--other', path: '' }),
          saved('a', 'Newer here', START - 2 * HOUR_MS),
          saved('b', 'Older here', START - 3 * DAY_MS, { consumedAt: START - DAY_MS }),
        ],
      },
    })
    await start($)
    const text = await command($, 'handoff', 'list')
    expect(text.split('\n')).toEqual([
      'Handoffs (this project first):',
      `• Newer here — 2h ago — ${saved('a', '', 0).path} — waiting`,
      `• Older here — 3d ago — ${saved('b', '', 0).path} — used`,
      '• Other project — 1h ago — (no file) — waiting',
    ])
  })

  test('/handoff list with none', async ($, on) => {
    engine(on, $)
    await start($)
    expect(await command($, 'handoff', 'list')).toBe('No handoffs yet. Type /handoff to write one.')
  })

  test('an unknown /handoff argument answers the help line', async ($, on) => {
    engine(on, $)
    await start($)
    expect(await command($, 'handoff', 'sideways')).toContain('/handoff list')
  })

  test('the status card names the waiting handoff, or none', async ($, on) => {
    engine(on, $, { store: { 'relay.handoffs': [saved('w', 'Waiting work', START - 10 * HOUR_MS)] } })
    await start($)
    expect(await command($, 'relay')).toContain('Waiting handoffs: "Waiting work" · from 10h ago')
  })

  test('the status card says none when nothing waits', async ($, on) => {
    engine(on, $)
    await start($)
    expect(await command($, 'relay')).toContain('Waiting handoffs: none')
  })
})

describe('after the review', () => {
  const MARKER = { text: 'brief', at: START - MINUTE_MS, projectKey: KEY, path: 'C:\h\brief.md', isCopied: true }
  const OLD = saved('old', 'Old work', START - 10 * HOUR_MS)

  test('a held prompt rides the marker and lands below the handoff', async ($, on) => {
    const seen = engine(on, $, { store: { 'relay.fillAfterClear': { ...MARKER, heldText: 'and then this' } } })
    await start($)
    await $.classic.SessionStart({ source: 'clear' })
    expect(seen.filled).toEqual([{ text: 'brief\n\n---\nand then this', mode: 'replace' }])
    expect(seen.store.get('relay.fillAfterClear')).toBeUndefined()
    expect(seen.submitted).toEqual([])
  })

  test('a fresh marker suppresses the offer of an unconsumed handoff', async ($, on) => {
    const seen = engine(on, $, { store: { 'relay.fillAfterClear': MARKER, 'relay.handoffs': [OLD] } })
    await start($)
    await $.classic.SessionStart({ source: 'clear' })
    expect(seen.filled).toEqual([{ text: 'brief', mode: 'replace' }])
    expect((await band($)).offer).toBeUndefined()
  })

  test("another project's marker is left alone, and the offer shows", async ($, on) => {
    const other = { ...MARKER, projectKey: 'C--other' }
    const seen = engine(on, $, { store: { 'relay.fillAfterClear': other, 'relay.handoffs': [OLD] } })
    await start($)
    await $.classic.SessionStart({ source: 'clear' })
    expect(seen.filled).toEqual([])
    expect(seen.store.get('relay.fillAfterClear')).toEqual(other)
    expect((await band($)).offer).toBe('Handoff waiting: "Old work" · from 10h ago')
  })

  test('the box refusing the fill says the handoff is on the clipboard', async ($, on) => {
    const seen = engine(on, $, { isFillRefused: true })
    await warm($)
    await command($, 'handoff')
    const pane = await mountPane($)
    await pane.press({ key: 'relay-clear' })
    expect(seen.filled).toHaveLength(1)
    expect(seen.toasts).toContain('The handoff could not go in the prompt box — it is on the clipboard.')
    expect(seen.toasts).not.toContain(LOADED)
  })

  test('with no clipboard either, the toast names the saved file', async ($, on) => {
    const seen = engine(on, $, { isFillRefused: true, isCopyRefused: true })
    await warm($)
    await command($, 'handoff')
    const pane = await mountPane($)
    await pane.press({ key: 'relay-clear' })
    expect(seen.toasts).toContain(`The handoff could not go in the prompt box — it is saved at ${expectedPath()}.`)
  })

  test('the clear emptying the box is caught by reading it back, and filled once more', async ($, on) => {
    const seen = engine(on, $, { isBoxEmptiedOnce: true })
    await warm($)
    await command($, 'handoff')
    const pane = await mountPane($)
    await pane.press({ key: 'relay-clear' })
    expect(seen.filled).toEqual([
      { text: BRIEF, mode: 'replace' },
      { text: BRIEF, mode: 'replace' },
    ])
    expect(seen.submitted).toEqual([])
  })

  test('/clear failing drops the marker and says where the handoff is', async ($, on) => {
    const seen = engine(on, $, { isClearRefused: true })
    await warm($)
    await command($, 'handoff')
    const pane = await mountPane($)
    await pane.press({ key: 'relay-clear' })
    expect(seen.ran).toEqual(['clear'])
    expect(seen.store.get('relay.fillAfterClear')).toBeUndefined()
    expect(seen.filled).toEqual([])
    expect(seen.toasts.some(text => text.startsWith('/clear could not run') && text.endsWith('it is on the clipboard.'))).toBe(true)
  })

  test('Copy with no clipboard names the saved file', async ($, on) => {
    const seen = engine(on, $, { isCopyRefused: true })
    await warm($)
    await command($, 'handoff')
    const pane = await mountPane($)
    await pane.press({ key: 'relay-copy' })
    expect(seen.toasts).toContain(`Could not copy the handoff (no-clipboard) — it is saved at ${expectedPath()}.`)
  })

  test('Load with the box refusing keeps the offer unconsumed', async ($, on) => {
    const seen = engine(on, $, { isFillRefused: true, store: { 'relay.handoffs': [OLD] }, files: { [OLD.path]: 'Old work\n' } })
    await start($)
    await $.classic.SessionStart({ source: 'startup' })
    const drawn = await mountBand($)
    await drawn.press({ key: 'relay-offer-load' })
    await drawn.unmount()
    expect(seen.toasts.some(text => text.startsWith('The handoff could not go in the prompt box ('))).toBe(true)
    expect(seen.toasts).not.toContain(LOADED)
    expect(index(seen)[0]?.consumedAt).toBeUndefined()
    expect((await band($)).offer).toBeDefined()
  })

  test('a POSIX HOME gets a forward-slash path', async ($, on) => {
    const seen = engine(on, $, { env: { HOME: '/home/r' } })
    await warm($)
    await command($, 'handoff')
    const file = handoffFileName(new Date(START), TITLE)
    // The kit lays the path on this machine's drive; the mod's own path is the index record's.
    expect((seen.written[0]?.[0] ?? '').replace(/\\/g, '/').endsWith(`/home/r/.claude/handoffs/${KEY}/${file}`)).toBe(true)
    expect(index(seen)[0]?.path).toBe(`/home/r/.claude/handoffs/${KEY}/${file}`)
  })

  test('a pane that cannot be placed says to widen the window, and that it is saved', async ($, on) => {
    const seen = engine(on, $, { isPaneUnplaced: true })
    await warm($)
    await command($, 'handoff')
    expect(seen.toasts).toContain(`Widen the window to see the Handoff pane — saved to ${expectedPath()}.`)
  })

  test('/clear drops a pending cold question', async ($, on) => {
    const seen = engine(on, $)
    await start($)
    await measure($, 240_000)
    await reply($)
    // Warming would keep the cache warm (and save an overnight handoff): let it go cold.
    await command($, 'keepwarm', 'off')
    await seen.clock.advance(2 * HOUR_MS)
    await command($, 'handoff')
    expect((await band($)).coldWrite).toBeDefined()
    await $.classic.SessionStart({ source: 'clear' })
    const shown = await band($)
    expect(shown.coldWrite).toBeUndefined()
    expect(shown.text).toBe('◆ Relay   ctx —   cache ● unknown')
  })
})

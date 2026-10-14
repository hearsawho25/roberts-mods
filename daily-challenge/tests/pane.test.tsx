import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On, RenderPropsOf } from 'claude-code'

import { CHALLENGES } from '../hooks/challenges'

const PLUGIN = 'daily-challenge'
const PANE = 'daily-challenge'
const NOON = new Date(2026, 9, 12, 12).getTime()
const DAY_MS = 24 * 60 * 60 * 1000

function paneProps(bodyColumns: number): RenderPropsOf['Pane'] {
  return {
    title: 'Daily challenge',
    isFocused: true,
    bodyColumns,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 60 },
    view: {},
  }
}

type Seen = { filled: string[]; closed: string[]; opened: string[] }

/** Stands in for the engine beneath the mod: store, clock, and the pane and prompt calls. */
function engine(on: On, entries?: Record<string, unknown>, hasStore = true) {
  if (hasStore) mock.store(on, entries)
  const clock = mock.clock(on, { now: NOON })
  const seen: Seen = { filled: [], closed: [], opened: [] }
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('prompt.fill', ($, e) => {
    seen.filled.push(e.text)
    return { isFilled: true }
  })
  on('ui.close', ($, e) => {
    seen.closed.push(e.id)
    return { value: undefined }
  })
  on('ui.open', ($, e) => {
    seen.opened.push(e.id)
    return { value: { isPlaced: true as const } }
  })
  return { clock, seen }
}

async function start($: Engine) {
  await $.session.start({ cwd: '.', surface: 'terminal', isInteractive: true })
}

async function run($: Engine, args: string) {
  const result = await $.command.run({
    command: 'challenge',
    args,
    origin: { kind: 'composer' },
    presentation: { isFullscreen: true, columns: 120 },
  })
  return result.text ?? ''
}

async function mountPane($: Engine, surface: 'terminal' | 'desktop', columns: number) {
  return $.ui.mount({
    plugin: PLUGIN,
    surface,
    component: 'Pane',
    requestId: PANE,
    props: paneProps(columns),
    viewport: { columns, rows: 60, isFullscreen: true },
  })
}

const SURFACES = ['terminal', 'desktop'] as const

describe('the pane', () => {
  test('shows the first challenge and the three buttons', async ($, on) => {
    engine(on)
    for (const surface of SURFACES) {
      const ui = await mountPane($, surface, 100)
      expect(await ui.find({ text: 'DAILY CHALLENGE' })).toBeDefined()
      expect(await ui.find({ text: CHALLENGES[0]!.title })).toBeDefined()
      expect(await ui.find({ type: 'Button', key: 'complete' })).toBeDefined()
      expect(await ui.find({ type: 'Button', key: 'coach' })).toBeDefined()
      expect(await ui.find({ type: 'Button', key: 'another' })).toBeDefined()
      expect(await ui.find({ text: 'If a command is not on your version, ask Claude how to do it.' })).toBeDefined()
      expect(await ui.find({ text: 'Mon 12 Oct 2026' })).toBeDefined()
      await ui.unmount()
    }
  })

  test('mark complete shows the done state, and undo brings the buttons back', async ($, on) => {
    engine(on)
    await start($)
    for (const surface of SURFACES) {
      const ui = await mountPane($, surface, 100)
      await ui.press({ key: 'complete' })
      expect(await ui.find({ text: 'Completed today' })).toBeDefined()
      expect(await ui.find({ text: 'A new challenge is waiting for you tomorrow.' })).toBeDefined()
      expect(await ui.find({ type: 'Button', key: 'complete' })).toBeUndefined()
      expect(await ui.find({ type: 'Button', key: 'another' })).toBeUndefined()
      await ui.press({ key: 'undo' })
      expect(await ui.find({ text: 'Completed today' })).toBeUndefined()
      expect(await ui.find({ type: 'Button', key: 'complete' })).toBeDefined()
      await ui.unmount()
    }
  })

  test('give me another swaps today and keeps it', async ($, on) => {
    engine(on)
    await start($)
    const ui = await mountPane($, 'terminal', 100)
    await ui.press({ key: 'another' })
    expect(await ui.find({ text: CHALLENGES[0]!.title })).toBeUndefined()
    await ui.unmount()
    const again = await mountPane($, 'terminal', 100)
    expect(await again.find({ text: CHALLENGES[0]!.title })).toBeUndefined()
    await again.unmount()
  })

  test('coach me closes the pane and fills the prompt', async ($, on) => {
    const { seen } = engine(on)
    await start($)
    const ui = await mountPane($, 'terminal', 100)
    await ui.press({ key: 'coach' })
    expect(seen.closed).toContain(PANE)
    expect(seen.filled).toHaveLength(1)
    expect(seen.filled[0]).toContain(CHALLENGES[0]!.title)
    expect(seen.filled[0]).toContain('one step at a time')
    expect(seen.filled[0]).toContain('wait for me')
  })

  test('hides give me another when only one is left', async ($, on) => {
    const completed: Record<string, string> = {}
    for (const one of CHALLENGES.slice(0, 364)) completed[one.id] = '2026-01-01'
    engine(on, { progress: { completed, swap: null } })
    await start($)
    const ui = await mountPane($, 'terminal', 100)
    expect(await ui.find({ text: CHALLENGES[364]!.title })).toBeDefined()
    expect(await ui.find({ type: 'Button', key: 'another' })).toBeUndefined()
    expect(await ui.find({ type: 'Button', key: 'complete' })).toBeDefined()
  })

  test('shows a finished screen after all 365', async ($, on) => {
    const completed: Record<string, string> = {}
    for (const one of CHALLENGES) completed[one.id] = '2026-01-01'
    engine(on, { progress: { completed, swap: null } })
    await start($)
    const ui = await mountPane($, 'terminal', 100)
    expect(await ui.find({ text: 'All 365 complete' })).toBeDefined()
    expect(await ui.find({ type: 'Button', key: 'complete' })).toBeUndefined()
    expect(await ui.find({ type: 'Button', key: 'coach' })).toBeUndefined()
    expect(await ui.find({ type: 'Button', key: 'another' })).toBeUndefined()
    expect(await ui.find({ text: '365 done' })).toBeDefined()
  })

  test('every row fits at a narrow and a wide width', async ($, on) => {
    engine(on)
    await start($)
    for (const columns of [34, 48, 72, 140]) {
      const ui = await mountPane($, 'terminal', columns)
      for (const text of await ui.findAll({ type: 'Text' })) {
        for (const line of text.text.split('\n')) {
          expect(line.length <= columns, `${columns} cols: "${line}" is ${line.length}`).toBe(true)
        }
      }
      await ui.unmount()
    }
  })
})

describe('the command', () => {
  test('/challenge answers at once and opens the pane', async ($, on) => {
    const { seen } = engine(on)
    await start($)
    const text = await run($, '')
    expect(text).toContain(CHALLENGES[0]!.title)
    expect(seen.opened).toContain(PANE)
  })

  test('/challenge done replies with the streak and total, and progress survives a restart', async ($, on) => {
    const { clock } = engine(on)
    await start($)
    expect(await run($, 'done')).toContain('Streak: 1 day. Completed: 1 of 365.')
    expect(await run($, 'done')).toContain('already completed')
    await clock.set(NOON + DAY_MS)
    expect(await run($, 'done')).toContain('Streak: 2 days. Completed: 2 of 365.')
    await clock.set(NOON + 3 * DAY_MS)
    await start($)
    const text = await run($, '')
    expect(text).toContain(CHALLENGES[2]!.title)
    expect(text).toContain('Streak: 0 days. Completed: 2 of 365.')
  })

  test('/challenge another swaps today', async ($, on) => {
    engine(on)
    await start($)
    const text = await run($, 'another')
    expect(text).toStartWith('Swapped.')
    expect(text).not.toContain(CHALLENGES[0]!.title)
  })

  test('an unknown word gets a plain hint', async ($, on) => {
    engine(on)
    await start($)
    expect(await run($, 'fly')).toContain('/challenge done')
  })
})

test('progress is written to the store', async ($, on) => {
  const kept = new Map<string, unknown>()
  const saved: unknown[] = []
  on('store.get', ($, e) => ({ value: kept.get(e.key) }))
  on('store.set', ($, e) => {
    kept.set(e.key, e.value)
    if (e.key === 'progress') saved.push(e.value)
    return { value: undefined }
  })
  engine(on, undefined, false)
  await start($)
  await run($, 'done')
  expect(saved).toHaveLength(1)
  expect(saved[0]).toEqual({ completed: { [CHALLENGES[0]!.id]: '2026-10-12' }, swap: null })
})

test('a saved year is picked up from the store', async ($, on) => {
  engine(on, { progress: { completed: { [CHALLENGES[0]!.id]: '2026-10-11' }, swap: null } })
  await start($)
  const text = await run($, '')
  expect(text).toContain(CHALLENGES[1]!.title)
  expect(text).toContain('Streak: 1 day. Completed: 1 of 365.')
})

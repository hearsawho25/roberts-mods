import { describe, expect, mock, test } from 'claude-code/testing'
import type { RenderPropsOf } from 'claude-code'

const NOW = new Date(2026, 9, 12, 15).getTime()

const paneProps = (bodyColumns: number): RenderPropsOf['Pane'] => ({
  title: 'Work report',
  isFocused: false,
  bodyColumns,
  placement: 'dock',
  scroll: { offset: 0, bodyRows: 60 },
  view: {},
})

const DAYS = {
  '2026-10-12': { kinds: { emails: 2, documents: 1 }, models: { 'Opus 5.5': 3 } },
  '2026-10-11': { kinds: { research: 2 }, models: { 'Sonnet 5.5': 2 } },
  '2026-09-20': { kinds: { other: 4 }, models: { 'Opus 5.5': 4 } },
  '2026-03-02': { kinds: { media: 1 }, models: { 'Haiku 5.5': 1 } },
}

const texts = async (ui: { findAll: (q: { type: string }) => Promise<{ text: string }[]> }) =>
  (await ui.findAll({ type: 'Text' })).map(one => one.text).join('\n')

describe('the pane', () => {
  test('each tab draws its own title and chart', async ($, on) => {
    mock.store(on, { days: DAYS })
    mock.clock(on, { now: NOW })
    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ plugin: 'work-report', surface, component: 'Pane', requestId: 'work-report', props: paneProps(100) })

      await ui.press({ key: 'tab-today' })
      let all = await texts(ui)
      expect(all).toContain('TODAY')
      expect(all).toContain('Mon, Oct 12')
      expect(all).toContain('Streak: 2 days in a row')
      expect(all).toContain('Sun')

      await ui.press({ key: 'tab-week' })
      all = await texts(ui)
      expect(all).toContain('THIS WEEK')
      expect(all).toContain('Oct 6 - Oct 12')
      expect(all).toContain('Tue')

      await ui.press({ key: 'tab-month' })
      all = await texts(ui)
      expect(all).toContain('THIS MONTH')
      expect(all).toContain('Sep 13 - Oct 12')
      expect(all).toContain('Best day: Sep 20, 4 tasks')
      expect(all).toContain('3 active days')

      await ui.press({ key: 'tab-year' })
      all = await texts(ui)
      expect(all).toContain('THIS YEAR')
      expect(all).toContain('Jan 1 - Oct 12, 2026')
      expect(all).toContain('Jan')
      expect(all).toContain('Dec')
      expect(all).toContain('Best month: Oct, 5 tasks')
      expect(all).toContain('BY MONTH')

      await ui.press({ key: 'tab-today' })
      await ui.unmount()
    }
  })

  test('shows the clean empty state with nothing finished today', async ($, on) => {
    mock.store(on, { days: {} })
    mock.clock(on, { now: NOW })
    const ui = await $.ui.mount({ plugin: 'work-report', surface: 'terminal', component: 'Pane', requestId: 'work-report', props: paneProps(80) })
    expect(await texts(ui)).toContain('Nothing finished yet today. Your first finished task shows up here.')
    expect(await ui.find({ key: 'tile-hours' })).toBeUndefined()
    await ui.unmount()
  })

  test('a wide pane draws three tiles and a narrow one draws one, nothing wider than the pane', async ($, on) => {
    mock.store(on, { days: DAYS })
    mock.clock(on, { now: NOW })
    for (const [width, tiles] of [[120, 3], [52, 2], [28, 1]] as const) {
      const ui = await $.ui.mount({ plugin: 'work-report', surface: 'terminal', component: 'Pane', requestId: 'work-report', props: paneProps(width) })
      expect(await ui.find({ key: 'tile-hours' })).toBeDefined()
      expect([width, (await ui.find({ key: 'tile-tasks' })) !== undefined]).toEqual([width, tiles >= 2])
      expect([width, (await ui.find({ key: 'tile-worth' })) !== undefined]).toEqual([width, tiles >= 3])
      expect((await texts(ui)).split('\n').filter(line => line.length > width)).toEqual([])
      await ui.unmount()
    }
  })
})

describe('the footer', () => {
  test('has no Report button; the pane opens from /report and the Toolbox', async ($, on) => {
    // Stands in for the engine's own footer, which the mod now leaves alone.
    on('ui.render', ($, e) => {
      const { Text } = $.ui.resolve(e)
      return <Text>engine footer</Text>
    })
    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ plugin: 'work-report', surface, component: 'SessionMode', props: { modes: ['focus'] } })
      expect(await texts(ui)).toContain('engine footer')
      expect(await ui.find({ key: 'open-report' })).toBeUndefined()
      await ui.unmount()
    }
  })
})

describe('counting finished tasks', () => {
  test('counts a typed prompt once and skips slash commands, cancelled turns and helper agents', async ($, on) => {
    mock.store(on, {})
    mock.clock(on, { now: NOW })
    on('prompt.submit', ($, e) => ({ text: e.text }))
    on('turn.start', ($, e) => ({ turnId: e.turnId }))
    on('tool.call', () => ({ result: {} }))
    on('turn.complete', ($, e) => ({ text: e.answer }))
    const usage = { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, model: 'claude-opus-5-5' }

    // A typed request that drafted an email: one task.
    await $.prompt.submit({ text: 'draft a reply to Sam', wait: false, origin: { kind: 'composer' } })
    await $.turn.start({ text: 'draft a reply to Sam', turnId: 't1' })
    await $.tool.call({ tool: 'mcp__gmail__create_draft', to: 'sam' } as never)
    await $.turn.complete({ answer: 'done', durationMs: 5, isAborted: false, turnId: 't1', reason: 'answer', usage })

    // A helper agent's turn inside it: not a task.
    await $.turn.complete({ answer: 'sub', durationMs: 5, isAborted: false, turnId: 't1', agentId: 'a1', reason: 'answer', usage })

    // A slash command: not a task.
    await $.prompt.submit({ text: '/compact', wait: false, origin: { kind: 'composer' } })
    await $.turn.start({ text: '/compact', turnId: 't2' })
    await $.turn.complete({ answer: 'ok', durationMs: 5, isAborted: false, turnId: 't2', reason: 'answer', usage })

    // A cancelled turn: not a task.
    await $.prompt.submit({ text: 'research flights', wait: false, origin: { kind: 'composer' } })
    await $.turn.start({ text: 'research flights', turnId: 't3' })
    await $.turn.complete({ answer: '', durationMs: 5, isAborted: true, turnId: 't3', reason: 'aborted' })

    // A background notification's turn: not a task.
    await $.prompt.submit({ text: 'task finished', wait: false, origin: { kind: 'task-notification' } })
    await $.turn.start({ text: 'task finished', turnId: 't4' })
    await $.turn.complete({ answer: 'ok', durationMs: 5, isAborted: false, turnId: 't4', reason: 'answer', usage })

    const ui = await $.ui.mount({ plugin: 'work-report', surface: 'terminal', component: 'Pane', requestId: 'work-report', props: paneProps(100) })
    const all = await texts(ui)
    expect(all).toContain('Opus 5.5')
    expect(all).toMatch(/Emails[^\n]*\s1\s/)
    expect(all).toMatch(/Research[^\n]*\s0\s/)
    expect(all).toContain('Streak: 1 day in a row')
    await ui.unmount()
  })

  test('/report answers at once and /report settings changes the estimate', async ($, on) => {
    mock.store(on, {})
    mock.clock(on, { now: NOW })
    on('ui.open', () => ({ value: { isPlaced: true } }))
    const opened = await $.command.run({ command: 'report', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } } as never)
    expect(opened.text).toContain('0 tasks finished today')
    const rate = await $.command.run({ command: 'report', args: 'settings rate 75', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } } as never)
    expect(rate.text).toContain('$75')
    const list = await $.command.run({ command: 'report', args: 'settings', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } } as never)
    expect(list.text).toContain('$75 per hour')
    expect(list.text).toContain('emails     10 min')
  })
})

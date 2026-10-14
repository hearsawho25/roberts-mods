import { describe, expect, mock, test } from 'claude-code/testing'
import type { On, PromptSubmitInput } from 'claude-code'

import { decide, parseQuestions, parseRewrite, wrapText } from '../hooks/logic'

const PLUGIN = 'prompt-upgrade'
const PANE = 'prompt-upgrade'
const USAGE = { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }

const QUESTIONS_REPLY = JSON.stringify({
  questions: [
    { question: 'Who will read the summary?', options: ['My team', 'Executives', 'Customers'] },
    { question: 'How long should it be?', options: ['One paragraph', 'One page'] },
  ],
})
const REWRITE_REPLY = JSON.stringify({
  prompt:
    'Write a one-page summary of [the Q3 report] for my team. Lead with the three biggest changes, then risks. Done means a page my team can read in two minutes.',
  added: ['A clear goal', 'Audience: my team', 'Length: one page', 'What done looks like'],
})

type World = {
  opened: string[]
  closed: string[]
  fills: string[]
  submitted: PromptSubmitInput[]
  toasts: string[]
  models: string[]
  replies: { questions: string | null; rewrite: string | null }
  narrow: boolean
}

/** Stands in for the engine beneath the mod: panes, the prompt box, the model, the store and the clock. */
function world(on: On) {
  mock.store(on)
  const clock = mock.clock(on, { now: Date.UTC(2026, 9, 12, 14, 3) })
  const w: World = {
    opened: [],
    closed: [],
    fills: [],
    submitted: [],
    toasts: [],
    models: [],
    replies: { questions: QUESTIONS_REPLY, rewrite: REWRITE_REPLY },
    narrow: false,
  }
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('ui.open', ($, e) => {
    w.opened.push(e.id)
    return { value: w.narrow ? { isPlaced: false as const, reason: 'narrow' } : { isPlaced: true as const } }
  })
  on('ui.close', ($, e) => {
    w.closed.push(e.id)
    return { value: undefined }
  })
  on('ui.panes', () => ({ value: [] }))
  on('ui.toast', ($, e) => {
    w.toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.copy', () => ({ value: { isCopied: true as const } }))
  on('prompt.fill', ($, e) => {
    w.fills.push(e.text)
    return { isFilled: true }
  })
  on('prompt.submit', ($, e) => {
    w.submitted.push(e)
    return { text: e.text }
  })
  on('model.complete', ($, e) => {
    w.models.push(e.model)
    const reply = e.model === 'haiku' ? w.replies.questions : w.replies.rewrite
    if (reply === null) {
      return { value: { isAnswered: false as const, reason: 'api-error' as const, status: 529, error: 'overloaded' as const, usage: USAGE } }
    }
    return { value: { isAnswered: true as const, text: reply, usage: USAGE } }
  })
  return { w, clock }
}

function typed(text: string, extra: Partial<PromptSubmitInput> = {}): PromptSubmitInput {
  return { text, wait: false, origin: { kind: 'composer' }, ...extra }
}

function paneProps(columns: number) {
  return {
    title: 'Prompt Upgrade',
    isFocused: true,
    bodyColumns: columns,
    placement: 'dock' as const,
    scroll: { offset: 0, bodyRows: 60 },
    view: {},
  }
}

describe('which prompts are intercepted', () => {
  test('pass-through rules', () => {
    const long = 'summarise the quarterly report for the team please'
    expect(decide(typed(long), false)).toEqual({ action: 'pass' })
    expect(decide(typed(long), true)).toEqual({ action: 'intercept' })
    expect(decide(typed('/compact now please thanks'), true)).toEqual({ action: 'pass' })
    expect(decide(typed(long, { attachments: [{ type: 'image' }] }), true)).toEqual({ action: 'pass' })
    expect(decide(typed(long, { turnId: 't1' }), true)).toEqual({ action: 'pass' })
    expect(decide(typed('yes'), true)).toEqual({ action: 'pass' })
    expect(decide(typed('keep going'), true)).toEqual({ action: 'pass' })
    expect(decide(typed('fix it'), true)).toEqual({ action: 'pass' })
    expect(decide(typed(`> ${long}`), true)).toEqual({ action: 'strip', text: long })
    expect(decide({ ...typed(long), origin: { kind: 'plugin', name: PLUGIN } as never }, true)).toEqual({
      action: 'pass',
    })
  })
})

describe('reading the model', () => {
  test('questions are read, capped and cleaned', () => {
    const qs = parseQuestions(
      '```json\n' +
        JSON.stringify({
          questions: [
            { question: 'A?', options: ['x', 'y', 'Other', 'z', 'w', 'v'] },
            { question: 'B?', options: ['only one'] },
            { question: 'C?', options: ['a', 'b'] },
            { question: 'D?', options: ['a', 'b'] },
            { question: 'E?', options: ['a', 'b'] },
          ],
        }) +
        '\n```',
    )
    expect(qs).toHaveLength(3)
    expect(qs[0]).toEqual({ question: 'A?', options: ['x', 'y', 'z', 'w'] })
    expect(qs.map(q => q.question)).toEqual(['A?', 'C?', 'D?'])
    expect(parseQuestions('{"questions":[]}')).toEqual([])
    expect(() => parseQuestions('no json here')).toThrow()
  })

  test('the rewrite is read', () => {
    const r = parseRewrite(`Here you go: ${REWRITE_REPLY}`)
    expect(r.prompt).toStartWith('Write a one-page summary')
    expect(r.added).toHaveLength(4)
    expect(() => parseRewrite('{"prompt":"  ","added":[]}')).toThrow()
  })

  test('wrapping never exceeds the width', () => {
    for (const line of wrapText('a fairly long sentence with averyveryverylongwordthatmustbreak inside it', 12)) {
      expect(line.length).toBeLessThanOrEqual(12)
    }
  })
})

describe('the flow', () => {
  test('from /better to Run', async ($, on) => {
    const { w, clock } = world(on)
    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    const out = await $.command.run({
      command: 'better',
      args: 'summarise the q3 report',
      origin: { kind: 'composer' },
      presentation: { isFullscreen: true, columns: 160 },
    })
    expect(out.text).toContain('upgrading in the pane')
    await clock.settle()
    expect(w.opened).toContain(PANE)
    expect(w.models).toEqual(['haiku'])

    const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'Pane', requestId: PANE, props: paneProps(120) })
    expect(await ui.find({ text: 'Who will read the summary?' }), 'question').toBeDefined()
    expect(await ui.find({ key: 'upgrade', text: 'Skip the rest, upgrade now' }), 'skip button').toBeDefined()
    await ui.press({ key: 'q0-o0' })
    expect(await ui.find({ text: /1 of 2 answered/i }), 'answered count').toBeDefined()
    await ui.press({ key: 'q1-skip' })
    await ui.press({ key: 'upgrade' })
    await clock.settle()
    expect(w.models).toEqual(['haiku', 'sonnet'])

    expect(await ui.find({ key: 'run' }), 'run button').toBeDefined()
    expect(await ui.find({ text: /WHAT I ADDED/ }), 'added list').toBeDefined()
    expect(w.submitted).toHaveLength(0)
    await ui.press({ key: 'run' })
    await clock.settle()
    expect(w.submitted).toHaveLength(1)
    expect(w.submitted[0]?.text).toStartWith('Write a one-page summary')
    expect(w.submitted[0]?.origin).toMatchObject({ kind: 'plugin', name: PLUGIN })
    expect(w.closed).toContain(PANE)
    await ui.unmount()
  })

  test('Cancel puts the original back in the prompt box', async ($, on) => {
    const { w, clock } = world(on)
    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    await $.command.run({ command: 'better', args: 'make the login page faster', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } })
    await clock.settle()
    const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'Pane', requestId: PANE, props: paneProps(80) })
    await ui.press({ key: 'cancel' })
    await clock.settle()
    expect(w.fills).toEqual(['make the login page faster'])
    expect(w.closed).toContain(PANE)
    expect(w.submitted).toHaveLength(0)
    await ui.unmount()
  })

  test('a failed model call shows the calm error card', async ($, on) => {
    const { w, clock } = world(on)
    w.replies.questions = null
    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    await $.command.run({ command: 'better', args: 'write a launch email for the beta', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } })
    await clock.settle()
    const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'Pane', requestId: PANE, props: paneProps(90) })
    expect(await ui.find({ text: /Your prompt is safe/ })).toBeDefined()
    await ui.press({ key: 'send-original' })
    await clock.settle()
    expect(w.submitted.map(s => s.text)).toEqual(['write a launch email for the beta'])
    await ui.unmount()
  })
})

describe('the on and off switch', () => {
  test('auto mode intercepts typed prompts only while on', async ($, on) => {
    const { w, clock } = world(on)
    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    const long = 'summarise the quarterly report for the team please'

    const off = await $.prompt.submit(typed(long))
    expect(off.text).toBe(long)
    expect(w.submitted).toHaveLength(1)

    const turnedOn = await $.command.run({ command: 'better', args: 'on', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } })
    expect(turnedOn.text).toContain('is on')
    const held = await $.prompt.submit(typed(long))
    expect(held.drop).toBeDefined()
    expect(w.submitted).toHaveLength(1)
    await clock.settle()
    expect(w.opened).toContain(PANE)

    const quoted = await $.prompt.submit(typed(`> ${long}`))
    expect(quoted.text).toBe(long)
    const short = await $.prompt.submit(typed('yes'))
    expect(short.text).toBe('yes')

    await $.command.run({ command: 'better', args: 'off', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } })
    const after = await $.prompt.submit(typed(long))
    expect(after.text).toBe(long)
  })

  test('a window too narrow puts the words back', async ($, on) => {
    const { w } = world(on)
    w.narrow = true
    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    await $.command.run({ command: 'better', args: 'on', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 60 } })
    const long = 'summarise the quarterly report for the team please'
    const held = await $.prompt.submit(typed(long))
    expect(held.drop).toContain('wider window')
    expect(w.fills).toEqual([long])
  })
})

describe('the look', () => {
  test('every text fits the pane at narrow and wide widths', async ($, on) => {
    const { clock } = world(on)
    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    await $.command.run({ command: 'better', args: 'summarise the q3 report', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } })
    await clock.settle()
    const fits = async (columns: number, screen: string) => {
      const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'Pane', requestId: PANE, props: paneProps(columns) })
      for (const one of await ui.findAll({ type: 'Text' })) {
        expect(one.text.length, `${screen}: "${one.text}" at ${columns}`).toBeLessThanOrEqual(columns)
      }
      return ui
    }
    for (const columns of [36, 140]) await (await fits(columns, 'questions')).unmount()
    const ui = await fits(140, 'questions')
    await ui.press({ key: 'upgrade' })
    await clock.settle()
    await ui.unmount()
    for (const columns of [36, 140]) {
      const review = await fits(columns, 'review')
      expect(await review.find({ key: 'run' }), `run button at ${columns}`).toBeDefined()
      await review.unmount()
    }
  })
})

describe('history', () => {
  test('an upgrade is kept and reopens its review', async ($, on) => {
    const { clock } = world(on)
    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    await $.command.run({ command: 'better', args: 'summarise the q3 report', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } })
    await clock.settle()
    let ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'Pane', requestId: PANE, props: paneProps(100) })
    await ui.press({ key: 'upgrade' })
    await clock.settle()
    await ui.press({ key: 'cancel' })
    await ui.unmount()

    const out = await $.command.run({ command: 'better', args: 'history', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } })
    expect(out.text).toContain('last upgrades')
    await clock.settle()
    ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'Pane', requestId: PANE, props: paneProps(100) })
    const rows = (await ui.findAll({ type: 'Button' })).filter(b => b.key?.startsWith('h-'))
    expect(rows).toHaveLength(1)
    await ui.press({ key: rows[0]!.key! })
    expect(await ui.find({ key: 'run' }), 'review reopened').toBeDefined()
    await ui.unmount()
  })
})

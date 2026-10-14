import { describe, expect, test } from 'claude-code/testing'

import {
  addDays,
  addTask,
  applySettingsArgs,
  chartBars,
  chartRows,
  classify,
  dayKey,
  dayOfYear,
  DEFAULT_SETTINGS,
  estimate,
  isTypedPrompt,
  lastDays,
  stepDays,
  streak,
  takePending,
  tileCount,
} from '../hooks/report'
import type { Days } from '../hooks/report'

const at = (y: number, m: number, d: number, hour = 15) => new Date(y, m - 1, d, hour).getTime()
const day = (n: number): Days[string] => ({ kinds: { other: n }, models: { 'Opus 5.5': n } })

describe('sorting a task by its tools', () => {
  test('mail tools make an email task, ahead of everything else', () => {
    expect(classify([{ name: 'WebSearch' }, { name: 'mcp__plugin_small-business_gmail__create_draft' }])).toBe('emails')
  })
  test('image tools and image or video files make an images and video task', () => {
    expect(classify([{ name: 'mcp__canva__generate_image' }])).toBe('media')
    expect(classify([{ name: 'Write', path: 'D:/out/poster.png' }])).toBe('media')
    expect(classify([{ name: 'Read', path: 'clip.mp4' }, { name: 'WebFetch' }])).toBe('media')
  })
  test('document tools or writing a document file make a document task', () => {
    expect(classify([{ name: 'mcp__claude_ai_Claude_Docs__create' }])).toBe('documents')
    expect(classify([{ name: 'Write', path: 'C:/notes/plan.docx' }, { name: 'WebSearch' }])).toBe('documents')
    expect(classify([{ name: 'Read', path: 'C:/notes/plan.md' }])).toBe('other')
  })
  test('search, page reading and transcripts make a research task', () => {
    expect(classify([{ name: 'WebSearch' }])).toBe('research')
    expect(classify([{ name: 'mcp__claude-in-chrome__get_page_text' }])).toBe('research')
    expect(classify([{ name: 'mcp__youtube__get_transcript' }])).toBe('research')
  })
  test('anything else is other', () => {
    expect(classify([])).toBe('other')
    expect(classify([{ name: 'Bash' }, { name: 'Edit', path: 'src/app.ts' }])).toBe('other')
  })
})

describe('counting only typed prompts', () => {
  test('a typed prompt counts; slash commands and other origins do not', () => {
    expect(isTypedPrompt('draft the newsletter', 'composer')).toBe(true)
    expect(isTypedPrompt('from my phone', 'bridge')).toBe(true)
    expect(isTypedPrompt('/report', 'composer')).toBe(false)
    expect(isTypedPrompt('  /compact', 'composer')).toBe(false)
    expect(isTypedPrompt('done', 'task-notification')).toBe(false)
    expect(isTypedPrompt('hi', 'plugin')).toBe(false)
    expect(isTypedPrompt('   ', 'composer')).toBe(false)
  })
  test('a turn is typed only when it starts with a pending typed prompt', () => {
    expect(takePending(['write it'], 'write it')).toEqual({ isTyped: true, rest: [] })
    expect(takePending(['write it'], '')).toEqual({ isTyped: false, rest: ['write it'] })
    expect(takePending(['write it'], 'A background task finished')).toEqual({ isTyped: false, rest: ['write it'] })
  })
})

describe('the calendar', () => {
  test('day of the year', () => {
    expect(dayOfYear(at(2026, 1, 1))).toBe(1)
    expect(dayOfYear(at(2026, 3, 1))).toBe(60)
    expect(dayOfYear(at(2024, 3, 1))).toBe(61)
    expect(dayOfYear(at(2026, 12, 31))).toBe(365)
    expect(dayOfYear(at(2026, 10, 12))).toBe(285)
  })
  test('stepping days lands on each date once, whatever the clocks do', () => {
    const keys = lastDays(at(2026, 11, 3, 0), 10).map(dayKey)
    expect(keys[0]).toBe('2026-10-25')
    expect(keys[9]).toBe('2026-11-03')
    expect(new Set(keys).size).toBe(10)
    expect(dayKey(stepDays(at(2026, 3, 8, 23), 1))).toBe('2026-03-09')
    expect(dayKey(stepDays(at(2026, 3, 30, 1), -30))).toBe('2026-02-28')
  })
})

describe('adding days together', () => {
  test('sums kinds and models, and counts active days', () => {
    const days: Days = {
      '2026-10-11': { kinds: { emails: 2, research: 1 }, models: { 'Opus 5.5': 3 } },
      '2026-10-12': { kinds: { emails: 1 }, models: { 'Sonnet 5.5': 1 } },
      '2026-10-10': { kinds: {}, models: {} },
    }
    const totals = addDays(days, ['2026-10-10', '2026-10-11', '2026-10-12', '2026-10-09'])
    expect(totals.tasks).toBe(4)
    expect(totals.active).toBe(2)
    expect(totals.kinds.emails).toBe(3)
    expect(totals.models).toEqual({ 'Opus 5.5': 3, 'Sonnet 5.5': 1 })
    expect(estimate(totals, DEFAULT_SETTINGS)).toEqual({ hours: 55 / 60, dollars: (55 / 60) * 50 })
  })
  test('adding a task bumps its day and its model', () => {
    const once = addTask({}, at(2026, 10, 12), 'documents', 'Opus 5.5')
    const twice = addTask(once, at(2026, 10, 12, 20), 'documents', 'Haiku 5.5')
    expect(twice['2026-10-12']).toEqual({ kinds: { documents: 2 }, models: { 'Opus 5.5': 1, 'Haiku 5.5': 1 } })
  })
})

describe('the streak', () => {
  test('counts days in a row ending today', () => {
    const days: Days = { '2026-10-12': day(1), '2026-10-11': day(2), '2026-10-10': day(1), '2026-10-08': day(4) }
    expect(streak(days, at(2026, 10, 12))).toBe(3)
  })
  test('still stands from yesterday before today has a task', () => {
    expect(streak({ '2026-10-11': day(1), '2026-10-10': day(1) }, at(2026, 10, 12))).toBe(2)
  })
  test('is zero after a day off', () => {
    expect(streak({ '2026-10-10': day(1) }, at(2026, 10, 12))).toBe(0)
  })
})

describe('settings and layout', () => {
  test('settings change the rate and the minutes', () => {
    const rate = applySettingsArgs(['rate', '75'], DEFAULT_SETTINGS)
    expect(rate.settings?.rate).toBe(75)
    const emails = applySettingsArgs(['emails', '15'], DEFAULT_SETTINGS)
    expect(emails.settings?.minutes.emails).toBe(15)
    expect(applySettingsArgs(['rate', 'lots'], DEFAULT_SETTINGS).settings).toBeUndefined()
    expect(applySettingsArgs([], DEFAULT_SETTINGS).text).toContain('$50 per hour')
  })
  test('tiles drop from three to two to one as the pane narrows', () => {
    expect(tileCount(120)).toBe(3)
    expect(tileCount(50)).toBe(2)
    expect(tileCount(30)).toBe(1)
  })
  test('chart rows never run wider than the pane', () => {
    for (const width of [24, 40, 80, 140]) {
      for (const tab of ['week', 'month', 'year'] as const) {
        const chart = chartRows(chartBars(tab, { '2026-10-12': day(3) }, at(2026, 10, 12)), width)
        for (const row of chart.rows) expect(row.map(cell => cell.text).join('').length <= width).toBe(true)
        expect(chart.labels.length <= width).toBe(true)
      }
    }
  })
  test('the year chart marks this month and leaves later months empty', () => {
    const bars = chartBars('year', { '2026-10-12': day(3) }, at(2026, 10, 12))
    expect(bars).toHaveLength(12)
    expect(bars[9]).toEqual({ label: 'Oct', value: 3, isCurrent: true, isFuture: false })
    expect(bars[10]?.isFuture).toBe(true)
  })
})

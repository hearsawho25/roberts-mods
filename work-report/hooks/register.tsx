import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { ReportTab } from '../types'
import {
  KINDS,
  KIND_LABEL,
  KIND_SHORT,
  TAB_TITLE,
  addDays,
  addTask,
  applySettingsArgs,
  bestDay,
  bigRows,
  bigWidth,
  chartBars,
  chartRows,
  classify,
  dayKey,
  emptyText,
  estimate,
  formatHours,
  formatMoney,
  isTypedPrompt,
  minutesFor,
  monthName,
  monthTotals,
  padEnd,
  padStart,
  prettyModel,
  rangeDates,
  rangeDays,
  readDays,
  readSettings,
  shortDay,
  streak,
  takePending,
  tileCount,
  wrapWords,
} from './report'
import type { Cell, Kind, ToolUse } from './report'

export const PANE = 'work-report'

const GOLD = '#F2C46D'
const INK = '#0D1117'
const LINE = '#262B33'
const MUTED = '#7D8590'
const TEXT = '#E6EDF3'
const GOOD = '#3DD68C'
const WARN = '#E3B341'
const BAR = '#8B9BB4'

const KIND_COLOR: Record<Kind, string> = {
  emails: '#6CB6FF',
  documents: '#56D4DD',
  media: '#D2A8FF',
  research: '#F0883E',
  other: '#7D8590',
}

const TABS: readonly { id: ReportTab; label: string; hotkey: string }[] = [
  { id: 'today', label: 'Today', hotkey: 't' },
  { id: 'week', label: 'Week', hotkey: 'w' },
  { id: 'month', label: 'Month', hotkey: 'm' },
  { id: 'year', label: 'Year', hotkey: 'y' },
]

const tab = atom({ plugin: 'work-report', key: 'tab' } as const, 'today')
const rev = atom({ plugin: 'work-report', key: 'rev' } as const, 0)

const FAILED = 'Work report could not finish that. Nothing was changed; try again in a moment.'

function footnote(rate: number, cols: number): string {
  const long = `Hours and dollars are estimates at $${rate}/h. /report settings`
  if (long.length <= cols) return long
  const mid = `Estimates at $${rate}/h. /report settings`
  return mid.length <= cols ? mid : padEnd(`Estimates at $${rate}/h`, cols)
}

function openPane($: EngineInterface): void {
  void $.ui.open({ id: PANE, title: 'Work report' }).catch(() => undefined)
}

export const register: Register = on => {
  // A typed prompt waits here until the turn it starts begins; that turn's
  // tool calls are gathered until it ends.
  let pending: string[] = []
  let current: { turnId: string; tools: ToolUse[] } | undefined

  on('session.start', async ($, e, next) => {
    try {
      await $.command.register({
        name: 'report',
        description: 'Open the work report: tasks finished and the time they saved (estimate)',
        argumentHint: '[settings [name number]]',
        immediate: true,
      })
    } catch {
      // The command is missing this session; the pane cannot be opened until it registers.
    }
    return next(e)
  })

  on('prompt.submit', ($, e, next) => {
    if (isTypedPrompt(e.text, e.origin.kind)) pending = [...pending, e.text].slice(-5)
    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.start', ($, e, next) => {
    const taken = takePending(pending, e.text)
    pending = taken.rest
    current = taken.isTyped ? { turnId: e.turnId, tools: [] } : undefined
    return next(e)
  }).catch(($, e, next) => next(e))

  on('tool.call', ($, e, next) => {
    if (current !== undefined && current.tools.length < 500) {
      const args = e as unknown as Record<string, unknown>
      const path = [args.file_path, args.notebook_path, args.path].find(v => typeof v === 'string') as string | undefined
      current.tools.push({ name: String(e.tool), path })
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId !== undefined || current === undefined || current.turnId !== e.turnId) return result
    const task = current
    current = undefined
    if (e.reason !== 'answer' || e.isAborted) return result
    try {
      const now = await $.clock.now()
      const days = readDays(await $.store.get('days'))
      const model = prettyModel(e.usage?.model ?? 'unknown')
      await $.store.set('days', addTask(days, now, classify(task.tools), model))
      await update($, rev, n => n + 1)
    } catch {
      // A day that could not be saved is skipped; the turn itself is untouched.
    }
    return result
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'report' }, async ($, e) => {
    try {
      const words = e.args.trim().split(/\s+/).filter(word => word !== '')
      if (words[0]?.toLowerCase() === 'settings') {
        const settings = readSettings(await $.store.get('settings'))
        const answer = applySettingsArgs(words.slice(1), settings)
        if (answer.settings !== undefined) {
          await $.store.set('settings', answer.settings)
          await update($, rev, n => n + 1)
        }
        return { text: answer.text }
      }
      if (words.length > 0) {
        return { text: 'Use /report to open the pane, or /report settings to see and change the estimate.' }
      }
      const now = await $.clock.now()
      const days = readDays(await $.store.get('days'))
      const settings = readSettings(await $.store.get('settings'))
      const totals = addDays(days, [dayKey(now)])
      const { hours } = estimate(totals, settings)
      openPane($)
      const tasks = `${totals.tasks} task${totals.tasks === 1 ? '' : 's'}`
      return { text: `Work report: ${tasks} finished today, about ${formatHours(hours)} hours saved (estimate).` }
    } catch {
      return { text: FAILED }
    }
  }).catch(() => ({ text: FAILED }))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const cols = Math.max(20, e.props.bodyColumns)
    const chosen = await read($, tab)
    await read($, rev)
    const now = await $.clock.now()
    const days = readDays(await $.store.get('days'))
    const settings = readSettings(await $.store.get('settings'))

    const range = rangeDays(chosen, now)
    const totals = addDays(days, range.map(dayKey))
    const { hours, dollars } = estimate(totals, settings)
    const perKind = minutesFor(totals, settings)

    const heading = (label: string) => (
      <Text wrap="truncate">
        <Text color={MUTED}>{label} </Text>
        <Text color={LINE}>{'─'.repeat(Math.max(0, cols - label.length - 1))}</Text>
      </Text>
    )

    const chips = (
      <Box flexDirection="row" gap={1}>
        {TABS.map(one => (
          <Button plain key={`tab-${one.id}`} hotkey={one.hotkey} onPress={() => update($, tab, () => one.id)}>
            {one.id === chosen ? (
              <Text backgroundColor={GOLD} color={INK} bold>
                {` ${one.label} `}
              </Text>
            ) : (
              <Text backgroundColor={LINE} color={TEXT}>
                {` ${one.label} `}
              </Text>
            )}
          </Button>
        ))}
      </Box>
    )

    const title = TAB_TITLE[chosen]
    const dates = rangeDates(chosen, now)
    const showDates = title.length + 2 + dates.length <= cols
    const titleBar = (
      <Box flexDirection="column" marginTop={1}>
        <Box key="title" flexDirection="row" justifyContent="space-between" width={cols}>
          <Text bold color={TEXT}>
            {title}
          </Text>
          {showDates && <Text color={MUTED}>{dates}</Text>}
        </Box>
        <Text wrap="truncate">
          <Text color={GOLD}>{'━'.repeat(title.length)}</Text>
          <Text color={LINE}>{'─'.repeat(Math.max(0, cols - title.length))}</Text>
        </Text>
      </Box>
    )

    if (totals.tasks === 0) {
      return (
        <Box flexDirection="column" width={cols}>
          {chips}
          {titleBar}
          <Box key="empty" flexDirection="column" marginTop={1}>
            {wrapWords(emptyText(chosen), cols).map(row => (
              <Text color={MUTED} wrap="truncate">
                {row}
              </Text>
            ))}
          </Box>
        </Box>
      )
    }

    // Tiles: three across, then two, then one; what does not fit goes on one line under them.
    const tileFacts = [
      { key: 'hours', label: 'HOURS SAVED  EST.', value: formatHours(hours), color: GOOD },
      { key: 'tasks', label: 'TASKS DONE', value: String(totals.tasks), color: TEXT },
      { key: 'worth', label: 'WORTH  EST.', value: formatMoney(dollars), color: TEXT },
    ]
    const across = tileCount(cols)
    const tileWidth = Math.floor((cols - (across - 1)) / across)
    const inner = tileWidth - 4
    const shown = tileFacts.slice(0, across)
    const hidden = tileFacts.slice(across)
    const tiles = (
      <Box flexDirection="row" gap={1} marginTop={1}>
        {shown.map(fact => {
          const rows = bigWidth(fact.value) <= inner ? bigRows(fact.value) : undefined
          return (
            <Box key={`tile-${fact.key}`} borderStyle="round" borderColor={LINE} flexDirection="column" width={tileWidth} paddingX={1}>
              <Text color={MUTED} wrap="truncate">
                {padEnd(fact.label, inner)}
              </Text>
              {rows !== undefined ? (
                rows.map(row => (
                  <Text color={fact.color} wrap="truncate">
                    {row}
                  </Text>
                ))
              ) : (
                <Box flexDirection="column">
                  <Text> </Text>
                  <Text bold color={fact.color} wrap="truncate">
                    {fact.value}
                  </Text>
                  <Text> </Text>
                </Box>
              )}
            </Box>
          )
        })}
      </Box>
    )
    const extraLine = hidden.map(fact => `${fact.label.replace('  EST.', ' (est.)').toLowerCase()}: ${fact.value}`)
    const extraRows = extraLine.join('  ·  ').length <= cols ? [extraLine.join('  ·  ')] : extraLine.map(one => padEnd(one, cols))
    const extra =
      hidden.length > 0 ? (
        <Box flexDirection="column">
          {extraRows.map(row => (
            <Text color={MUTED} wrap="truncate">
              {row}
            </Text>
          ))}
        </Box>
      ) : undefined

    // Where the time went.
    const isNarrow = cols < 48
    const labelWidth = isNarrow ? 9 : 17
    const countWidth = 5
    const hoursWidth = 8
    const kindBar = cols - labelWidth - countWidth - hoursWidth - 1
    const peakKind = Math.max(1, ...KINDS.map(kind => totals.kinds[kind]))
    const kindRows = KINDS.map(kind => {
      const count = totals.kinds[kind]
      const fill = count > 0 ? Math.max(1, Math.round((count / peakKind) * Math.max(0, kindBar - 1))) : 0
      return (
        <Text wrap="truncate">
          <Text color={count > 0 ? TEXT : MUTED}>{padEnd(isNarrow ? KIND_SHORT[kind] : KIND_LABEL[kind], labelWidth)}</Text>
          {kindBar >= 4 && <Text color={KIND_COLOR[kind]}>{'━'.repeat(fill)}</Text>}
          {kindBar >= 4 && <Text color={LINE}>{'─'.repeat(Math.max(0, kindBar - 1 - fill))} </Text>}
          <Text color={count > 0 ? TEXT : MUTED}>{padStart(String(count), countWidth)}</Text>
          <Text color={MUTED}>{padStart(`${formatHours(perKind[kind] / 60)} h`, hoursWidth)}</Text>
        </Text>
      )
    })

    // Who did the work.
    const models = Object.entries(totals.models)
      .filter(([, n]) => n > 0)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
    const modelLabel = Math.min(isNarrow ? 10 : 18, Math.max(6, ...models.map(([name]) => name.length + 1)))
    const modelBar = cols - modelLabel - countWidth - 1
    const peakModel = Math.max(1, ...models.map(([, n]) => n))
    const modelRows = models.map(([name, count]) => {
      const fill = Math.max(1, Math.round((count / peakModel) * Math.max(0, modelBar - 1)))
      return (
        <Text wrap="truncate">
          <Text color={TEXT}>{padEnd(name, modelLabel)}</Text>
          {modelBar >= 4 && <Text color={GOLD}>{'━'.repeat(fill)}</Text>}
          {modelBar >= 4 && <Text color={LINE}>{'─'.repeat(Math.max(0, modelBar - 1 - fill))} </Text>}
          <Text color={TEXT}>{padStart(String(count), countWidth)}</Text>
        </Text>
      )
    })

    // The chart and the line under it.
    const chart = chartRows(chartBars(chosen, days, now), cols)
    const toneColor = (cell: Cell) => (cell.tone === 'current' ? GOLD : cell.tone === 'bar' ? BAR : LINE)
    const chartLines = chart.rows.map((row, r) => (
      <Text wrap="truncate">
        {row.map(cell => (
          <Text color={toneColor(cell)}>{cell.text}</Text>
        ))}
      </Text>
    ))
    let summary: { text: string; color: string }
    if (chosen === 'today' || chosen === 'week') {
      const run = streak(days, now)
      summary =
        run > 0
          ? { text: `Streak: ${run} day${run === 1 ? '' : 's'} in a row`, color: GOOD }
          : { text: 'No streak yet. Finish a task today to start one.', color: WARN }
    } else if (chosen === 'month') {
      const best = bestDay(days, range)
      summary = {
        text: `Best day: ${best ? `${shortDay(best.ms)}, ${best.count} task${best.count === 1 ? '' : 's'}` : 'none'}  ·  ${totals.active} active day${totals.active === 1 ? '' : 's'}`,
        color: TEXT,
      }
    } else {
      const months = monthTotals(days, now)
      const top = months.reduce((best, n, i) => (n > (months[best] ?? 0) ? i : best), 0)
      const topCount = months[top] ?? 0
      summary = {
        text: `Best month: ${monthName(top)}, ${topCount} task${topCount === 1 ? '' : 's'}  ·  ${totals.active} active day${totals.active === 1 ? '' : 's'}`,
        color: TEXT,
      }
    }

    return (
      <Box flexDirection="column" width={cols}>
        {chips}
        {titleBar}
        {tiles}
        {extra}
        <Box flexDirection="column" marginTop={1}>
          {heading('WHERE THE TIME WENT')}
          {kindRows}
        </Box>
        <Box flexDirection="column" marginTop={1}>
          {heading('WHO DID THE WORK')}
          {modelRows}
        </Box>
        <Box key="chart" flexDirection="column" marginTop={1}>
          {heading(chosen === 'year' ? 'BY MONTH' : 'BY DAY')}
          {chartLines}
          <Text color={MUTED} wrap="truncate">
            {chart.labels}
          </Text>
        </Box>
        <Box key="summary" marginTop={1}>
          <Text color={summary.color} wrap="truncate">
            {summary.text}
          </Text>
        </Box>
        <Text color={MUTED} wrap="truncate">
          {footnote(settings.rate, cols)}
        </Text>
      </Box>
    )
  }).catch(($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text color={MUTED}>Work report could not draw right now.</Text>
  })
}

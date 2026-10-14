import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Progress } from '../types'
import { TOTAL, themeOf } from './challenges'
import {
  COLORS,
  TILE_LABELS,
  TITLE,
  bigNumber,
  chipRows,
  dayGrid,
  dayLabel,
  fit,
  heading,
  tileLayout,
  titleRule,
  wrap,
  yearBar,
} from './layout'
import {
  bestStreak,
  canSwap,
  coachPrompt,
  completeToday,
  dayKey,
  doneCount,
  formatDay,
  lastDays,
  normalize,
  streak,
  swapToday,
  todayOf,
  undoToday,
} from './logic'

const PANE = 'daily-challenge'
const PANE_TITLE = 'Daily challenge'
const STORE_KEY = 'progress'
const FOOTNOTE = 'If a command is not on your version, ask Claude how to do it.'
const FAILED = 'Daily challenge could not do that just now. Please try again in a moment.'

const progressAtom = atom({ plugin: 'daily-challenge', key: 'progress' } as const, null)

/** The session's copy if there is one, else what the store kept. A read only. */
async function readProgress($: EngineInterface): Promise<Progress> {
  const held = await read($, progressAtom)
  if (held !== null) return held
  return normalize(await $.store.get(STORE_KEY))
}

async function today($: EngineInterface): Promise<string> {
  return dayKey(await $.clock.now())
}

/** Applies one change to the progress and keeps it in the store; null when nothing changed. */
async function change(
  $: EngineInterface,
  apply: (progress: Progress, day: string) => Progress | null,
): Promise<{ progress: Progress; day: string; isChanged: boolean }> {
  const day = await today($)
  const stored = await readProgress($)
  const outcome = { isChanged: false }
  const progress = await update($, progressAtom, held => {
    const base = held ?? stored
    const next = apply(base, day)
    outcome.isChanged = next !== null
    return next ?? base
  })
  const settled = progress ?? stored
  if (outcome.isChanged) await $.store.set(STORE_KEY, settled)
  return { progress: settled, day, isChanged: outcome.isChanged }
}

const complete = ($: EngineInterface) => change($, completeToday)
const undo = ($: EngineInterface) => change($, undoToday)
const swap = ($: EngineInterface) =>
  change($, (progress, day) => swapToday(progress, day, Math.random))

async function openPane($: EngineInterface): Promise<void> {
  await $.ui.open({ id: PANE, title: PANE_TITLE })
}

async function coach($: EngineInterface): Promise<void> {
  const progress = await readProgress($)
  const now = todayOf(progress, await today($))
  if (now.challenge === undefined) return
  await $.ui.close({ id: PANE })
  await $.prompt.fill({ text: coachPrompt(now.challenge) })
}

function quietly(work: Promise<unknown>): void {
  work.catch(() => undefined)
}

function tally(progress: Progress, day: string): string {
  const days = streak(progress, day)
  return `Streak: ${days} ${days === 1 ? 'day' : 'days'}. Completed: ${doneCount(progress)} of ${TOTAL}.`
}

async function runCommand($: EngineInterface, args: string): Promise<string> {
  const word = args.trim().toLowerCase()

  if (word === '' || word === 'open') {
    const progress = await readProgress($)
    const day = await today($)
    const now = todayOf(progress, day)
    quietly(openPane($))
    if (now.challenge === undefined) return `All ${TOTAL} challenges are complete. ${tally(progress, day)}`
    const state = now.isDone ? 'done for today' : 'waiting for you'
    return `Today's challenge (${state}): ${now.challenge.title}. ${tally(progress, day)}`
  }

  if (word === 'done' || word === 'complete') {
    const before = todayOf(await readProgress($), await today($))
    const { progress, day, isChanged } = await complete($)
    if (isChanged && before.challenge !== undefined) {
      return `Marked complete: ${before.challenge.title}. ${tally(progress, day)}`
    }
    if (before.isDone && before.challenge !== undefined) {
      return `You already completed today's challenge (${before.challenge.title}). ${tally(progress, day)}`
    }
    return `All ${TOTAL} challenges are complete. ${tally(progress, day)}`
  }

  if (word === 'another' || word === 'swap') {
    const { progress, day, isChanged } = await swap($)
    const now = todayOf(progress, day)
    if (isChanged && now.challenge !== undefined) return `Swapped. Today's challenge is now: ${now.challenge.title}.`
    if (now.isDone) return `Today's challenge is already complete. A new one is waiting tomorrow.`
    return `There is no other challenge left to swap to.`
  }

  return `Try /challenge to open the pane, /challenge done to mark today's complete, or /challenge another to swap it.`
}

export const register: Register = on => {
  let shownDay = ''

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'challenge',
      description: 'Open your daily Claude Code challenge',
      argumentHint: '[done | another]',
    })
    try {
      const stored = normalize(await $.store.get(STORE_KEY))
      await update($, progressAtom, held => held ?? stored)
      shownDay = await today($)
      $.clock.every(60_000, () => {
        quietly(
          today($).then(day => {
            if (day === shownDay) return
            shownDay = day
            $.ui.invalidate('ui.render')
          }),
        )
      })
    } catch {
      // The pane falls back to the store on its own; nothing here needs the person.
    }

    return next(e)
  })

  on('command.run', { command: 'challenge' }, async ($, e) => {
    try {
      return { text: await runCommand($, e.args) }
    } catch {
      return { text: FAILED }
    }
  }).catch(() => ({ text: FAILED }))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const progress = await readProgress($)
    const day = await today($)
    const cols = Math.max(16, Math.floor(e.props.bodyColumns))
    const now = todayOf(progress, day)
    const done = doneCount(progress)

    const headingRow = (label: string) => {
      const parts = heading(label, cols)
      return (
        <Text wrap="truncate">
          <Text color={COLORS.muted} bold>{parts.label}</Text>
          <Text color={COLORS.line}>{parts.hairline}</Text>
        </Text>
      )
    }

    const rule = titleRule(cols)
    const longDate = formatDay(day)
    const date = TITLE.length + 1 + longDate.length <= cols ? longDate : formatDay(day, true)
    const showDate = TITLE.length + 1 + date.length <= cols

    const tiles = tileLayout(cols)
    const tileValues = [streak(progress, day), done, bestStreak(progress)]
    const tileInner = tiles.width - 4

    const cardInner = cols - 4
    const card = now.challenge
    const theme = card === undefined ? undefined : themeOf(card)
    const themeName = card === undefined ? 'Finished' : card.isCloser ? `${theme?.name} · Closer` : (theme?.name ?? '')
    const cardTitle = card === undefined ? `All ${TOTAL} complete` : card.title
    const cardTask =
      card === undefined
        ? 'You finished every challenge in the year. Thank you for practising with Claude Code.'
        : card.task
    const isGreen = now.isDone || card === undefined

    const chips = chipRows(
      [
        { key: 'complete', label: 'Mark complete' },
        { key: 'coach', label: 'Coach me through it' },
        ...(canSwap(progress, day) ? [{ key: 'another', label: 'Give me another' }] : []),
      ],
      cols,
    )

    const grid = dayGrid(cols)
    const cells = lastDays(progress, day, grid.count)
    const bar = yearBar(done, TOTAL, cols)
    const doneText = `${done} done`
    const leftText = `${TOTAL - done} to go`

    const chip = (key: string, label: string, isMain: boolean) => (
      <Button key={key} plain onPress={() => quietly(press($, key))}>
        <Text
          backgroundColor={isMain ? COLORS.gold : COLORS.line}
          color={isMain ? COLORS.ink : COLORS.text}
          bold={isMain}
        >
          {` ${label} `}
        </Text>
      </Button>
    )

    return (
      <Box flexDirection="column" width={cols}>
        <Box flexDirection="row" justifyContent="space-between" width={cols}>
          <Text bold color={COLORS.text} wrap="truncate">{fit(TITLE, cols)}</Text>
          {showDate && <Text color={COLORS.muted}>{date}</Text>}
        </Box>
        <Text wrap="truncate">
          <Text color={COLORS.gold}>{rule.gold}</Text>
          <Text color={COLORS.line}>{rule.hairline}</Text>
        </Text>

        <Box flexDirection={tiles.direction} columnGap={1} marginTop={1}>
          {TILE_LABELS.map((label, index) => {
            const rows = bigNumber(tileValues[index] ?? 0)
            return (
              <Box
                key={`tile-${index}`}
                borderStyle="round"
                borderColor={COLORS.line}
                paddingX={1}
                width={tiles.width}
                flexDirection="column"
                alignItems="center"
              >
                {rows.map(row => (
                  <Text color={index === 0 ? COLORS.gold : COLORS.text}>{fit(row, tileInner)}</Text>
                ))}
                <Text color={COLORS.muted}>{fit(label, tileInner)}</Text>
              </Box>
            )
          })}
        </Box>

        <Box marginTop={1} flexDirection="column">
          {headingRow("Today's challenge")}
        </Box>
        <Box
          borderStyle="round"
          borderColor={isGreen ? COLORS.green : COLORS.gold}
          paddingX={1}
          flexDirection="column"
          width={cols}
        >
          <Text color={card === undefined ? COLORS.green : (theme?.color ?? COLORS.text)}>
            {fit(themeName.toUpperCase(), cardInner)}
          </Text>
          {wrap(cardTitle, cardInner).map(line => (
            <Text bold color={COLORS.text}>{line}</Text>
          ))}
          {wrap(cardTask, cardInner).map(line => (
            <Text color={COLORS.text}>{line}</Text>
          ))}
        </Box>

        {card !== undefined && !now.isDone && (
          <Box flexDirection="column" marginTop={1}>
            {chips.map(row => (
              <Box flexDirection="row" columnGap={1}>
                {row.map(one => chip(one.key, one.label, one.key === 'complete'))}
              </Box>
            ))}
          </Box>
        )}

        {now.isDone && (
          <Box flexDirection="column" marginTop={1}>
            <Text bold color={COLORS.green}>{fit('Completed today', cols)}</Text>
            {wrap('A new challenge is waiting for you tomorrow.', cols).map(line => (
              <Text color={COLORS.text}>{line}</Text>
            ))}
            <Box>
              <Button key="undo" plain dimColor onPress={() => quietly(press($, 'undo'))}>
                <Text color={COLORS.muted}>Undo</Text>
              </Button>
            </Box>
          </Box>
        )}

        <Box marginTop={1} flexDirection="column">
          {headingRow("Last 14 days")}
          <Text>
            {cells.map(cell => (
              <Text color={cell.isDone ? COLORS.green : COLORS.line}>
                {(cell.isDone ? '■' : '□').padEnd(grid.cell)}
              </Text>
            ))}
          </Text>
          <Text>
            {cells.map(cell => (
              <Text color={cell.isToday ? COLORS.text : COLORS.muted}>
                {dayLabel(cell.weekday, grid.cell).padEnd(grid.cell)}
              </Text>
            ))}
          </Text>
        </Box>

        <Box marginTop={1} flexDirection="column">
          {headingRow("Your year")}
          <Text>
            <Text color={COLORS.gold}>{'━'.repeat(bar.filled)}</Text>
            <Text color={COLORS.line}>{'━'.repeat(bar.empty)}</Text>
          </Text>
          <Box flexDirection="row" justifyContent="space-between" width={cols}>
            <Text color={COLORS.green}>{doneText}</Text>
            {doneText.length + 1 + leftText.length <= cols && <Text color={COLORS.muted}>{leftText}</Text>}
          </Box>
        </Box>

        <Box marginTop={1} flexDirection="column">
          {wrap(FOOTNOTE, cols).map(line => (
            <Text color={COLORS.muted}>{line}</Text>
          ))}
        </Box>
      </Box>
    )
  })
}

async function press($: EngineInterface, key: string): Promise<void> {
  if (key === 'complete') await complete($)
  else if (key === 'undo') await undo($)
  else if (key === 'another') await swap($)
  else if (key === 'coach') await coach($)
}

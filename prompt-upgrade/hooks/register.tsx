import { atom, read, update } from 'claude-code'
import type { Elements, EngineInterface, Register, RenderElement, UiPressArgument } from 'claude-code'

import type { PromptUpgradeAnswer, PromptUpgradeEntry, PromptUpgradeFlow, PromptUpgradeStep } from '../types'
import {
  QUESTIONS_SYSTEM,
  REWRITE_SYSTEM,
  bigNumber,
  clip,
  decide,
  packRows,
  parseQuestions,
  parseRewrite,
  questionsPrompt,
  rewritePrompt,
  wordCount,
  wrapText,
} from './logic'

type Engine = EngineInterface

const PANE = 'prompt-upgrade'
const TITLE = 'Prompt Upgrade'
const HISTORY_SIZE = 20
const QUESTIONS_MODEL = 'haiku'
const REWRITE_MODEL = 'sonnet'

const GOLD = '#F2C46D'
const HAIR = '#262B33'
const MUTED = '#7D8590'
const TEXT = '#E6EDF3'
const GREEN = '#3DD68C'
const AMBER = '#E3B341'
const INK = '#11151B'

const flowAtom = atom({ plugin: 'prompt-upgrade', key: 'flow' } as const, null)
const viewAtom = atom({ plugin: 'prompt-upgrade', key: 'view' } as const, 'flow')
const autoAtom = atom({ plugin: 'prompt-upgrade', key: 'auto' } as const, false)
const historyAtom = atom({ plugin: 'prompt-upgrade', key: 'history' } as const, [])

const NARROW = 'Prompt Upgrade needs a wider window for its pane, so your prompt is back in the box.'

function newId(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
}

function reason(err: unknown): string {
  return err instanceof Error && err.message !== '' ? err.message : String(err)
}

function newFlow(original: string, step: PromptUpgradeStep): PromptUpgradeFlow {
  return {
    id: newId(),
    original,
    step,
    questions: [],
    answers: [],
    otherOpen: null,
    upgraded: '',
    added: [],
    isEditing: false,
    isCopied: false,
    failedDuring: null,
    callId: '',
  }
}

// ------------------------------------------------------------------ the flow

/** Opens the pane; true once a surface draws it. */
async function showPane($: Engine): Promise<boolean> {
  const opened = await $.ui.open({ id: PANE, title: TITLE, focus: true })
  return opened.isPlaced
}

async function closePane($: Engine): Promise<void> {
  await $.ui.close({ id: PANE })
}

/** Starts an upgrade of `text`. False when the pane could not be placed (the flow is then undone). */
async function startFlow($: Engine, text: string): Promise<boolean> {
  const flow = newFlow(text, 'reading')
  await update($, flowAtom, () => flow)
  await update($, viewAtom, () => 'flow' as const)
  const isPlaced = await showPane($)
  if (!isPlaced) {
    await update($, flowAtom, () => null)
    await closePane($)
    return false
  }
  void askQuestions($, flow.id)
  return true
}

async function failStep($: Engine, callId: string, during: 'questions' | 'rewrite'): Promise<void> {
  await update($, flowAtom, f => (f !== null && f.callId === callId ? { ...f, step: 'error', failedDuring: during } : f))
}

async function askQuestions($: Engine, flowId: string): Promise<void> {
  const callId = newId()
  const flow = await update($, flowAtom, f =>
    f !== null && f.id === flowId ? { ...f, step: 'reading', callId, failedDuring: null } : f,
  )
  if (flow === null || flow.callId !== callId) return
  try {
    const reply = await $.model.complete({
      model: QUESTIONS_MODEL,
      system: QUESTIONS_SYSTEM,
      prompt: questionsPrompt(flow.original),
      maxTokens: 800,
      effort: 'low',
      timeoutMs: 45_000,
    })
    if (!reply.isAnswered) throw new Error(reply.reason)
    const questions = parseQuestions(reply.text)
    if (questions.length === 0) {
      const now = await read($, flowAtom)
      if (now !== null && now.callId === callId) await writeRewrite($, flowId)
      return
    }
    await update($, flowAtom, f =>
      f !== null && f.callId === callId
        ? { ...f, step: 'questions', questions, answers: questions.map(() => null), otherOpen: null }
        : f,
    )
  } catch {
    await failStep($, callId, 'questions')
  }
}

async function writeRewrite($: Engine, flowId: string): Promise<void> {
  const callId = newId()
  const flow = await update($, flowAtom, f =>
    f !== null && f.id === flowId ? { ...f, step: 'rewriting', callId, failedDuring: null, otherOpen: null } : f,
  )
  if (flow === null || flow.callId !== callId) return
  try {
    const reply = await $.model.complete({
      model: REWRITE_MODEL,
      system: REWRITE_SYSTEM,
      prompt: rewritePrompt(flow.original, flow.questions, flow.answers),
      maxTokens: 3000,
      timeoutMs: 120_000,
    })
    if (!reply.isAnswered) throw new Error(reply.reason)
    const { prompt, added } = parseRewrite(reply.text)
    const done = await update($, flowAtom, f =>
      f !== null && f.callId === callId ? { ...f, step: 'review', upgraded: prompt, added } : f,
    )
    if (done !== null && done.callId === callId) await remember($, done)
  } catch {
    await failStep($, callId, 'rewrite')
  }
}

/** Keeps the upgrade among the last twenty, in the session's state and the mod's own store. */
async function remember($: Engine, flow: PromptUpgradeFlow): Promise<void> {
  const at = await $.clock.now()
  const entry: PromptUpgradeEntry = { id: flow.id, at, original: flow.original, upgraded: flow.upgraded, added: flow.added }
  const list = await update($, historyAtom, old => [entry, ...old.filter(one => one.id !== flow.id)].slice(0, HISTORY_SIZE))
  await $.store.set('history', list)
}

async function answer($: Engine, index: number, given: PromptUpgradeAnswer): Promise<void> {
  await update($, flowAtom, f => {
    if (f === null || f.step !== 'questions') return f
    const answers = f.answers.slice()
    answers[index] = given
    return { ...f, answers, otherOpen: null }
  })
}

async function runUpgrade($: Engine, text: string): Promise<void> {
  const flow = await read($, flowAtom)
  if (flow === null || text.trim() === '') return
  if (text !== flow.upgraded) await remember($, { ...flow, upgraded: text })
  await update($, flowAtom, () => null)
  await closePane($)
  // Sent as the mod's own prompt (origin `plugin`), which the interceptor never takes.
  await $.prompt.submit({ text, asUser: true })
}

async function sendOriginal($: Engine): Promise<void> {
  const flow = await read($, flowAtom)
  if (flow === null) return
  await update($, flowAtom, () => null)
  await closePane($)
  await $.prompt.submit({ text: flow.original, asUser: true })
}

/** Closes the pane and puts the original prompt back in the box. */
async function cancel($: Engine): Promise<void> {
  const flow = await read($, flowAtom)
  await update($, flowAtom, () => null)
  await update($, viewAtom, () => 'flow' as const)
  await closePane($)
  if (flow !== null && flow.original !== '') await $.prompt.fill({ text: flow.original })
}

async function retry($: Engine): Promise<void> {
  const flow = await read($, flowAtom)
  if (flow === null) return
  if (flow.failedDuring === 'rewrite') await writeRewrite($, flow.id)
  else await askQuestions($, flow.id)
}

async function openEntry($: Engine, entry: PromptUpgradeEntry): Promise<void> {
  const flow: PromptUpgradeFlow = {
    ...newFlow(entry.original, 'review'),
    id: entry.id,
    upgraded: entry.upgraded,
    added: entry.added,
  }
  await update($, flowAtom, () => flow)
  await update($, viewAtom, () => 'flow' as const)
}

/** Runs a press handler, turning a failure into one plain line. */
function act($: Engine, work: () => Promise<void>): () => void {
  return () => {
    work().catch(err => $.ui.toast(`Prompt Upgrade: that did not work (${reason(err)}). Your prompt is safe.`))
  }
}

/** After a reload, picks the flow back up where it was. */
async function resume($: Engine): Promise<void> {
  const flow = await read($, flowAtom)
  const view = await read($, viewAtom)
  if (flow === null && view !== 'history') return
  const isOpen = (await $.ui.panes()).some(pane => pane.id === PANE)
  if (!isOpen) await $.ui.open({ id: PANE, title: TITLE })
  if (flow === null) return
  if (flow.step === 'reading') await askQuestions($, flow.id)
  else if (flow.step === 'rewriting') await writeRewrite($, flow.id)
}

// ------------------------------------------------------------------ drawing

type Els = Elements['terminal']

type ChipKind = 'gold' | 'slate' | 'green' | 'quiet'
type Chip = { key: string; label: string; kind: ChipKind; onPress: (e: UiPressArgument) => void }

function chipWidth(chip: Chip): number {
  return chip.kind === 'quiet' ? chip.label.length : chip.label.length + 2
}

function drawChip(els: Els, chip: Chip, room: number): RenderElement {
  const { Button, Text } = els
  const label = clip(chip.label, Math.max(1, chip.kind === 'quiet' ? room : room - 2))
  if (chip.kind === 'quiet') {
    return (
      <Button key={chip.key} plain onPress={chip.onPress}>
        <Text color={MUTED}>{label}</Text>
      </Button>
    )
  }
  const back = chip.kind === 'gold' ? GOLD : chip.kind === 'green' ? GREEN : HAIR
  const fore = chip.kind === 'slate' ? TEXT : INK
  return (
    <Button key={chip.key} plain onPress={chip.onPress}>
      <Text backgroundColor={back} color={fore} bold={chip.kind !== 'slate'}>
        {` ${label} `}
      </Text>
    </Button>
  )
}

function chipRows(els: Els, chips: readonly Chip[], width: number, indent = 0): RenderElement {
  const { Box } = els
  const rows = packRows(chips, chipWidth, width - indent)
  return (
    <Box flexDirection="column" paddingLeft={indent}>
      {rows.map(row => (
        <Box flexDirection="row" gap={1}>
          {row.map(chip => drawChip(els, chip, width - indent))}
        </Box>
      ))}
    </Box>
  )
}

function header(els: Els, width: number, isAuto: boolean): RenderElement {
  const { Box, Text } = els
  const title = 'PROMPT UPGRADE'
  const status = isAuto ? 'AUTO ON' : 'AUTO OFF'
  const showStatus = width >= title.length + status.length + 4
  const titleText = clip(title, width)
  const gold = Math.min(titleText.length, width)
  return (
    <Box flexDirection="column">
      <Box flexDirection="row" justifyContent="space-between" width={width}>
        <Text bold color={TEXT}>
          {titleText}
        </Text>
        {showStatus && <Text color={isAuto ? GREEN : MUTED}>{status}</Text>}
      </Box>
      <Text wrap="truncate">
        <Text color={GOLD}>{'━'.repeat(gold)}</Text>
        <Text color={HAIR}>{'─'.repeat(Math.max(0, width - gold))}</Text>
      </Text>
    </Box>
  )
}

function heading(els: Els, label: string, width: number): RenderElement {
  const { Text } = els
  const text = clip(label.toUpperCase(), width)
  const rest = width - text.length - 1
  return (
    <Text wrap="truncate">
      <Text color={MUTED}>{text}</Text>
      {rest > 0 && <Text color={HAIR}>{` ${'─'.repeat(rest)}`}</Text>}
    </Text>
  )
}

const STEPS_LONG = ['Your prompt', 'Questions', 'Rewrite', 'Review']
const STEPS_SHORT = ['Prompt', 'Ask', 'Rewrite', 'Review']

function stepIndex(flow: PromptUpgradeFlow): number {
  switch (flow.step) {
    case 'compose':
    case 'reading':
      return 0
    case 'questions':
      return 1
    case 'rewriting':
      return 2
    case 'review':
      return 3
    case 'error':
      return flow.failedDuring === 'rewrite' ? 2 : 1
  }
}

function tracker(els: Els, current: number, width: number): RenderElement {
  const { Box, Text } = els
  const fits = (labels: string[], sep: number) =>
    labels.reduce((sum, label) => sum + label.length + 2, 0) + sep * (labels.length - 1) <= width
  const labels = fits(STEPS_LONG, 5) ? STEPS_LONG : fits(STEPS_SHORT, 3) ? STEPS_SHORT : null
  if (labels === null) {
    return (
      <Text wrap="truncate" color={GOLD} bold>
        {clip(`Step ${current + 1} of 4  ${STEPS_LONG[current]}`, width)}
      </Text>
    )
  }
  const sep = labels === STEPS_LONG ? '  ›  ' : ' › '
  return (
    <Box flexDirection="row">
      {labels.map((label, i) => (
        <Text wrap="truncate">
          {i > 0 && <Text color={HAIR}>{sep}</Text>}
          {i < current && <Text color={GREEN}>{`✓ `}</Text>}
          {i < current && <Text color={TEXT}>{label}</Text>}
          {i === current && (
            <Text color={GOLD} bold>
              {`● ${label}`}
            </Text>
          )}
          {i > current && <Text color={MUTED}>{`○ ${label}`}</Text>}
        </Text>
      ))}
    </Box>
  )
}

function card(
  els: Els,
  opts: { label: string; text: string; width: number; color?: string; maxLines?: number; key: string },
): RenderElement {
  const { Box, Text } = els
  const inner = Math.max(1, opts.width - 4)
  let lines = wrapText(opts.text, inner)
  let more = 0
  if (opts.maxLines !== undefined && lines.length > opts.maxLines) {
    more = lines.length - opts.maxLines
    lines = lines.slice(0, opts.maxLines)
  }
  return (
    <Box
      key={opts.key}
      flexDirection="column"
      borderStyle="round"
      borderColor={opts.color ?? HAIR}
      paddingX={1}
      width={opts.width}
    >
      <Text color={opts.color === GOLD ? GOLD : MUTED} wrap="truncate">
        {clip(opts.label.toUpperCase(), inner)}
      </Text>
      {lines.map(line => (
        <Text color={TEXT} wrap="truncate">
          {line === '' ? ' ' : line}
        </Text>
      ))}
      {more > 0 && (
        <Text color={MUTED} wrap="truncate">
          {clip(`… ${more} more line${more === 1 ? '' : 's'}`, inner)}
        </Text>
      )}
    </Box>
  )
}

function note(els: Els, text: string, width: number, color = MUTED): RenderElement {
  const { Box, Text } = els
  return (
    <Box flexDirection="column">
      {wrapText(text, width).map(line => (
        <Text color={color} wrap="truncate">
          {line}
        </Text>
      ))}
    </Box>
  )
}

function tile(els: Els, n: number, label: string, color: string): { width: number; node: RenderElement } {
  const { Box, Text } = els
  const rows = bigNumber(n)
  const inner = Math.max(rows[0].length, label.length)
  const pad = (s: string) => {
    const left = Math.floor((inner - s.length) / 2)
    return `${' '.repeat(left)}${s}${' '.repeat(inner - s.length - left)}`
  }
  return {
    width: inner + 4,
    node: (
      <Box flexDirection="column" borderStyle="round" borderColor={HAIR} paddingX={1} width={inner + 4}>
        {rows.map(row => (
          <Text color={color}>{pad(row)}</Text>
        ))}
        <Text color={MUTED}>{pad(label)}</Text>
      </Box>
    ),
  }
}

function stats(els: Els, flow: PromptUpgradeFlow, width: number): RenderElement {
  const { Box, Text } = els
  const before = wordCount(flow.original)
  const after = wordCount(flow.upgraded)
  const added = flow.added.length
  const tiles = [
    tile(els, before, 'WORDS BEFORE', TEXT),
    tile(els, after, 'WORDS AFTER', GOLD),
    tile(els, added, 'DETAILS ADDED', GREEN),
  ]
  const total = tiles.reduce((sum, one) => sum + one.width, 0) + 2 * (tiles.length - 1)
  if (total <= width) {
    return (
      <Box flexDirection="row" gap={2}>
        {tiles.map(one => one.node)}
      </Box>
    )
  }
  return (
    <Text wrap="truncate" color={TEXT}>
      {clip(`${before} words before  ·  ${after} words after  ·  ${added} details added`, width)}
    </Text>
  )
}

function drawCompose($: Engine, els: Els, width: number, hasInput: boolean): RenderElement[] {
  const { Input } = els
  const out: RenderElement[] = [heading(els, 'Your prompt', width)]
  if (hasInput) {
    out.push(
      <Input
        key="compose"
        placeholder="Type a rough prompt and press Enter"
        submitLabel="upgrade"
        autoFocus
        onSubmit={value => {
          const text = value.trim()
          if (text === '') return
          void startFlowFromPane($, text)
        }}
      />,
    )
  } else {
    out.push(note(els, 'This surface has no text field. Type /better followed by your prompt instead.', width))
  }
  out.push(chipRows(els, [{ key: 'cancel', label: 'Cancel', kind: 'quiet', onPress: act($, () => cancel($)) }], width))
  return out
}

async function startFlowFromPane($: Engine, text: string): Promise<void> {
  try {
    const flow = newFlow(text, 'reading')
    await update($, flowAtom, () => flow)
    await askQuestions($, flow.id)
  } catch (err) {
    $.ui.toast(`Prompt Upgrade: that did not work (${reason(err)}). Your prompt is safe.`)
  }
}

function drawWaiting($: Engine, els: Els, flow: PromptUpgradeFlow, width: number): RenderElement[] {
  const answered = flow.answers.filter(a => a !== null && a.kind !== 'skip').length
  const line =
    flow.step === 'reading'
      ? 'Reading your prompt and choosing the questions that would help most.'
      : answered === 0
        ? 'Writing the upgrade from your prompt.'
        : `Writing the upgrade from your prompt and ${answered} answer${answered === 1 ? '' : 's'}.`
  return [
    heading(els, 'Your prompt', width),
    card(els, { key: 'original', label: 'Your prompt', text: flow.original, width, maxLines: 10 }),
    note(els, line, width, TEXT),
    chipRows(els, [{ key: 'cancel', label: 'Cancel', kind: 'quiet', onPress: act($, () => cancel($)) }], width),
  ]
}

function drawQuestions($: Engine, els: Els, flow: PromptUpgradeFlow, width: number, hasInput: boolean): RenderElement[] {
  const { Box, Text, Input } = els
  const out: RenderElement[] = [heading(els, 'Questions', width)]
  const indent = 4
  flow.questions.forEach((q, i) => {
    const given = flow.answers[i] ?? null
    const isAnswered = given !== null
    const lines = wrapText(q.question, Math.max(1, width - indent))
    const chips: Chip[] = q.options.map((option, j) => ({
      key: `q${i}-o${j}`,
      label: option,
      kind: given?.kind === 'pick' && given.text === option ? 'green' : 'slate',
      onPress: act($, () => answer($, i, { kind: 'pick', text: option })),
    }))
    chips.push({
      key: `q${i}-other`,
      label: given?.kind === 'other' ? `Other: ${given.text}` : 'Other (type it)',
      kind: given?.kind === 'other' ? 'green' : 'slate',
      onPress: act($, async () => {
        await update($, flowAtom, f => (f === null ? f : { ...f, otherOpen: i }))
      }),
    })
    chips.push({
      key: `q${i}-skip`,
      label: given?.kind === 'skip' ? 'Skipped' : 'Skip',
      kind: 'quiet',
      onPress: act($, () => answer($, i, { kind: 'skip', text: '' })),
    })
    out.push(
      <Box flexDirection="column" marginTop={i === 0 ? 0 : 1}>
        {lines.map((line, k) => (
          <Box flexDirection="row">
            {k === 0 ? (
              <Text backgroundColor={isAnswered ? GREEN : GOLD} color={INK} bold>
                {isAnswered ? ' ✓ ' : ` ${i + 1} `}
              </Text>
            ) : (
              <Text>{'   '}</Text>
            )}
            <Text color={TEXT} wrap="truncate">
              {` ${line}`}
            </Text>
          </Box>
        ))}
        {chipRows(els, chips, width, indent)}
        {hasInput && flow.otherOpen === i && (
          <Box paddingLeft={indent}>
            <Input
              key={`q${i}-other-text`}
              placeholder="Type your answer and press Enter"
              submitLabel="save"
              autoFocus
              onSubmit={value => {
                const text = value.trim()
                if (text === '') return
                act($, () => answer($, i, { kind: 'other', text }))()
              }}
            />
          </Box>
        )}
      </Box>,
    )
  })
  const answered = flow.answers.filter(a => a !== null).length
  const total = flow.questions.length
  const isAll = answered === total
  out.push(<Text>{' '}</Text>)
  out.push(heading(els, `${answered} of ${total} answered`, width))
  out.push(
    chipRows(
      els,
      [
        {
          key: 'upgrade',
          label: isAll ? 'Upgrade now' : 'Skip the rest, upgrade now',
          kind: 'gold',
          onPress: act($, () => writeRewrite($, flow.id)),
        },
        { key: 'cancel', label: 'Cancel', kind: 'quiet', onPress: act($, () => cancel($)) },
      ],
      width,
    ),
  )
  return out
}

function drawReview($: Engine, els: Els, flow: PromptUpgradeFlow, width: number, hasInput: boolean): RenderElement[] {
  const { Box, Text, Input } = els
  const out: RenderElement[] = [stats(els, flow, width)]
  if (flow.isEditing && hasInput) {
    out.push(heading(els, 'Edit the upgrade', width))
    out.push(
      <Input
        key="edit"
        value={flow.upgraded}
        submitLabel="run it"
        autoFocus
        onSubmit={value => act($, () => runUpgrade($, value.trim()))()}
      />,
    )
    out.push(
      chipRows(
        els,
        [
          {
            key: 'stop-edit',
            label: 'Stop editing',
            kind: 'slate',
            onPress: act($, async () => {
              await update($, flowAtom, f => (f === null ? f : { ...f, isEditing: false }))
            }),
          },
          { key: 'cancel', label: 'Cancel', kind: 'quiet', onPress: act($, () => cancel($)) },
        ],
        width,
      ),
    )
  } else {
    const buttons: Chip[] = [
      { key: 'run', label: 'Run it', kind: 'gold', onPress: act($, () => runUpgrade($, flow.upgraded)) },
    ]
    if (hasInput) {
      buttons.push({
        key: 'edit',
        label: 'Edit',
        kind: 'slate',
        onPress: act($, async () => {
          await update($, flowAtom, f => (f === null ? f : { ...f, isEditing: true, isCopied: false }))
        }),
      })
    }
    buttons.push({
      key: 'copy',
      label: flow.isCopied ? 'Copied' : 'Copy',
      kind: flow.isCopied ? 'green' : 'slate',
      onPress: press =>
        act($, async () => {
          const copied = await $.ui.copy({ text: flow.upgraded, surface: press.surface })
          if (!copied.isCopied) throw new Error('the clipboard did not take it')
          await update($, flowAtom, f => (f === null ? f : { ...f, isCopied: true }))
        })(),
    })
    buttons.push({ key: 'cancel', label: 'Cancel', kind: 'quiet', onPress: act($, () => cancel($)) })
    out.push(chipRows(els, buttons, width))
  }
  if (flow.added.length > 0) {
    out.push(heading(els, 'What I added', width))
    for (const item of flow.added) {
      const lines = wrapText(item, Math.max(1, width - 2))
      lines.forEach((line, k) => {
        out.push(
          <Text wrap="truncate">
            <Text color={GREEN}>{k === 0 ? '+ ' : '  '}</Text>
            <Text color={TEXT}>{line}</Text>
          </Text>,
        )
      })
    }
  }
  out.push(heading(els, 'Side by side', width))
  const isSide = width >= 60
  const half = Math.floor((width - 1) / 2)
  const left = card(els, { key: 'left', label: 'Your prompt', text: flow.original, width: isSide ? half : width })
  const right = card(els, {
    key: 'right',
    label: 'The upgrade',
    text: flow.upgraded,
    width: isSide ? width - half - 1 : width,
    color: GOLD,
  })
  out.push(
    isSide ? (
      <Box flexDirection="row" gap={1} alignItems="flex-start">
        {left}
        {right}
      </Box>
    ) : (
      <Box flexDirection="column">
        {left}
        {right}
      </Box>
    ),
  )
  return out
}

function drawError($: Engine, els: Els, flow: PromptUpgradeFlow, width: number): RenderElement[] {
  const { Box, Text } = els
  const what = flow.failedDuring === 'rewrite' ? 'writing the upgrade' : 'choosing the questions'
  const inner = Math.max(1, width - 4)
  return [
    <Box key="error" flexDirection="column" borderStyle="round" borderColor={AMBER} paddingX={1} width={width}>
      <Text color={AMBER} bold wrap="truncate">
        {clip('THAT DID NOT WORK', inner)}
      </Text>
      {wrapText(`The model could not finish ${what}. Your prompt is safe and nothing has been sent.`, inner).map(
        line => (
          <Text color={TEXT} wrap="truncate">
            {line}
          </Text>
        ),
      )}
    </Box>,
    chipRows(
      els,
      [
        { key: 'retry', label: 'Try again', kind: 'gold', onPress: act($, () => retry($)) },
        { key: 'send-original', label: 'Send my original', kind: 'slate', onPress: act($, () => sendOriginal($)) },
        { key: 'cancel', label: 'Cancel', kind: 'quiet', onPress: act($, () => cancel($)) },
      ],
      width,
    ),
    card(els, { key: 'original', label: 'Your prompt', text: flow.original, width, maxLines: 10 }),
  ]
}

function formatWhen(at: number): string {
  const d = new Date(at)
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  const two = (n: number) => String(n).padStart(2, '0')
  return `${months[d.getMonth()]} ${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`
}

function drawHistory($: Engine, els: Els, list: readonly PromptUpgradeEntry[], width: number): RenderElement[] {
  const { Box, Button, Text } = els
  const out: RenderElement[] = [heading(els, `Last ${HISTORY_SIZE} upgrades`, width)]
  if (list.length === 0) out.push(note(els, 'No upgrades yet. Try /better followed by a rough prompt.', width))
  for (const entry of list) {
    const when = formatWhen(entry.at)
    const room = Math.max(1, width - when.length - 2)
    out.push(
      <Button key={`h-${entry.id}`} plain onPress={act($, () => openEntry($, entry))}>
        <Text color={MUTED}>{when}</Text>
        {'  '}
        <Text color={TEXT}>{clip(entry.original.replace(/\s+/g, ' ').trim(), room)}</Text>
      </Button>,
    )
  }
  out.push(<Box>{chipRows(els, [{ key: 'close', label: 'Close', kind: 'quiet', onPress: act($, () => cancel($)) }], width)}</Box>)
  return out
}

// ------------------------------------------------------------------ register

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'better',
      description: 'Upgrade a rough prompt before it is sent (on, off, history)',
      argumentHint: '[prompt | on | off | history]',
    })
    try {
      const auto = (await $.store.get('auto')) === true
      const saved = await $.store.get('history')
      await update($, autoAtom, () => auto)
      if (Array.isArray(saved)) await update($, historyAtom, () => (saved as PromptUpgradeEntry[]).slice(0, HISTORY_SIZE))
    } catch {
      // A store that cannot be read leaves automatic mode off and the history empty.
    }
    void resume($).catch(() => undefined)
    return next(e)
  })

  on('command.run', { command: 'better' }, async ($, e) => {
    try {
      const args = e.args.trim()
      const word = args.toLowerCase()
      if (word === 'on' || word === 'off') {
        const isOn = word === 'on'
        await update($, autoAtom, () => isOn)
        await $.store.set('auto', isOn)
        return {
          text: isOn
            ? 'Prompt Upgrade is on: prompts you type open in the pane first. Start one with ">" to send it as is.'
            : 'Prompt Upgrade is off: prompts go straight through. /better <prompt> still works.',
        }
      }
      if (word === 'history') {
        await update($, viewAtom, () => 'history' as const)
        void showPane($).catch(() => undefined)
        return { text: 'Prompt Upgrade: your last upgrades are in the pane.' }
      }
      if (args === '') {
        await update($, flowAtom, () => newFlow('', 'compose'))
        await update($, viewAtom, () => 'flow' as const)
        void showPane($).catch(() => undefined)
        return { text: 'Prompt Upgrade: type your prompt in the pane.' }
      }
      void startFlow($, args)
        .then(async isPlaced => {
          if (isPlaced) return
          await $.prompt.fill({ text: args })
          $.ui.toast(NARROW)
        })
        .catch(err => $.ui.toast(`Prompt Upgrade could not open (${reason(err)}). Your prompt is safe.`))
      return { text: 'Prompt Upgrade: upgrading in the pane. Nothing is sent until you press Run it.' }
    } catch (err) {
      return { text: `Prompt Upgrade could not do that: ${reason(err)}.` }
    }
  }).catch(() => ({ text: 'Prompt Upgrade hit a problem and did nothing. Your prompt is safe.' }))

  on('prompt.submit', async ($, e, next) => {
    const decision = decide(e, await read($, autoAtom))
    if (decision.action === 'pass') return next(e)
    if (decision.action === 'strip') return next({ ...e, text: decision.text })
    const text = e.text.trim()
    const isPlaced = await startFlow($, text)
    if (!isPlaced) {
      await $.prompt.fill({ text })
      return { drop: NARROW }
    }
    return { drop: 'Prompt Upgrade: upgrading in the pane. Nothing is sent until you press Run it.' }
  }).catch(($, e, next) => next(e))

  on('ui.close', { id: PANE }, async ($, e, next) => {
    // The person closing the pane by hand is a Cancel: their prompt goes back in the box.
    if (e.origin.kind === 'person') {
      const flow = await read($, flowAtom)
      await update($, flowAtom, () => null)
      await update($, viewAtom, () => 'flow' as const)
      if (flow !== null && flow.original !== '') await $.prompt.fill({ text: flow.original })
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const els = $.ui.resolve(e) as unknown as Els
    const { Box, Text } = els
    const width = Math.max(16, e.props.bodyColumns)
    const hasInput = e.surface !== 'mobile'
    const view = await read($, viewAtom)
    const flow = await read($, flowAtom)
    const isAuto = await read($, autoAtom)
    let body: RenderElement[]
    if (view === 'history') {
      body = drawHistory($, els, await read($, historyAtom), width)
    } else if (flow === null) {
      body = [note(els, 'Nothing to upgrade. Type /better followed by a rough prompt.', width)]
    } else {
      body = [tracker(els, stepIndex(flow), width), <Text>{' '}</Text>]
      if (flow.step === 'compose') body.push(...drawCompose($, els, width, hasInput))
      else if (flow.step === 'reading' || flow.step === 'rewriting') body.push(...drawWaiting($, els, flow, width))
      else if (flow.step === 'questions') body.push(...drawQuestions($, els, flow, width, hasInput))
      else if (flow.step === 'review') body.push(...drawReview($, els, flow, width, hasInput))
      else body.push(...drawError($, els, flow, width))
    }
    return (
      <Box flexDirection="column" width={width}>
        {header(els, width, isAuto)}
        {body}
      </Box>
    )
  })
}

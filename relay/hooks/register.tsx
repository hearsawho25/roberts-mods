import { atom, read, update } from 'claude-code'
import type { EngineInterface, PromptSubmitInput, Register, RenderElement, SessionContextUsage, Timer, UiPressArgument } from 'claude-code'

import type { RelayColdGuard, RelayContext, RelayDraft, RelayFillMarker, RelayHandoff, RelayOffer, RelayWarming } from '../types'
import {
  CACHE_TTL_MS,
  FILL_MAX_AGE_MS,
  HANDOFF_BUTTON_WIDTH,
  HANDOFF_NOW_WIDTH,
  KEEPWARM_HELP,
  MIN_WARM_TOKENS,
  NOT_YET_WIDTH,
  PING_IDLE_MS,
  PING_PROMPT,
  ROW_TITLE,
  addHandoff,
  buildHandoffPrompt,
  cacheState,
  coldDropText,
  coldGuardText,
  coldHandoffText,
  contextPercent,
  estimateRewriteUsd,
  extractTitle,
  fillText,
  fit,
  forkFailureText,
  forkStopReason,
  formatGitFacts,
  formatTokens,
  handoffDir,
  handoffFileName,
  handoffListText,
  joinPath,
  markConsumed,
  meterRow,
  meterRowText,
  modelPrice,
  offerText,
  parseDuration,
  parseGitFacts,
  pendingFor,
  pendingLine,
  pingProblem,
  pingUsd,
  projectKey,
  readIndex,
  shouldOfferHandoff,
  slugify,
  statusCard,
  thresholdText,
  warmingLine,
  warmingSuffix,
} from './core'
import type { GitOutputs } from './core'
import {
  HELD_KEY_PREFIX,
  NO_WARMING,
  WARMING_KEY_PREFIX,
  afterReply,
  dueAction,
  dueAt,
  guardVerdict,
  isGuardable,
  isStale,
  isWorthKeeping,
  keepwarmWindow,
  readHeld,
  readWarming,
  restoredWarming,
  stopped,
} from './warming'

/**
 * Relay: a meter row above the prompt (context fill, prompt-cache state, a
 * Handoff button), the handoff threshold prompt, the handoff flow, the `/relay`
 * switch, and the wiring for warming and the cold-cache guard (warming.ts).
 * Pure logic lives in core.ts and warming.ts; this file holds every hook, every
 * function that takes `$`, every atom and draws the band (the validator follows `$`
 * and atoms only within the file that holds the hooks).
 */

type Engine = EngineInterface

/** Robert's Toolbox palette. */
const COLORS = {
  gold: '#F2C46D',
  muted: '#7D8590',
  green: '#3DD68C',
  text: '#E6EDF3',
  line: '#262B33',
} as const

const ENABLED_KEY = 'relay.settings.enabled'
/** Whether the window's last ping writes a handoff instead (default true). */
const OVERNIGHT_KEY = 'relay.settings.overnightHandoff'
/** The handoff index: RelayHandoff[], newest first, capped at 50. */
const HANDOFFS_KEY = 'relay.handoffs'
/** RelayFillMarker: what to put in the prompt box once /clear has run (survives a module reset). */
const FILL_KEY = 'relay.fillAfterClear'

const enabledAtom = atom({ plugin: 'relay', key: 'enabled' } as const, true)
const snoozedAtom = atom({ plugin: 'relay', key: 'handoffSnoozed' } as const, false)
const lastResponseAtom = atom({ plugin: 'relay', key: 'lastResponseAt' } as const, null)
const contextAtom = atom({ plugin: 'relay', key: 'context' } as const, null)
const tickAtom = atom({ plugin: 'relay', key: 'tick' } as const, 0)
const busyAtom = atom({ plugin: 'relay', key: 'handoffBusy' } as const, false)
const draftAtom = atom({ plugin: 'relay', key: 'handoffDraft' } as const, null)
const coldAtom = atom({ plugin: 'relay', key: 'coldConfirm' } as const, null)
const offerAtom = atom({ plugin: 'relay', key: 'offer' } as const, null)
const warmingAtom = atom({ plugin: 'relay', key: 'warming' } as const, null)
const coldGuardAtom = atom({ plugin: 'relay', key: 'coldGuard' } as const, null)
const guardEpisodeAtom = atom({ plugin: 'relay', key: 'guardEpisode' } as const, null)
const resumeEstimateAtom = atom({ plugin: 'relay', key: 'resumeEstimate' } as const, null)
const turnRunningAtom = atom({ plugin: 'relay', key: 'turnRunning' } as const, null)

const TICK_MS = 30 * 1000
const PANE = 'relay-handoff'
const RELAY_HELP = 'Type /relay for the status card, /relay on or /relay off to switch Relay, /relay overnight on|off for the overnight handoff.'
const HANDOFF_HELP = 'Type /handoff to write a handoff, /handoff list to see the saved ones.'
const BUSY_TEXT = 'Already writing a handoff'
const LOADED_TEXT = 'Handoff loaded — review it and press Enter.'
const COLD_WRITE_WIDTH = '[ Write it anyway ]'.length
const CANCEL_WIDTH = '[ Cancel ]'.length
const LOAD_WIDTH = '[ Load ]'.length
const DISMISS_WIDTH = '[ Dismiss ]'.length
const GUARD_HANDOFF_WIDTH = '[ Handoff & start fresh ]'.length
const SEND_ANYWAY_WIDTH = '[ Send anyway ]'.length
const HELD_BACK_TEXT = 'Your held message is back in the prompt box.'
/** A turn.start with no turn.complete for this long no longer counts as running. */
const TURN_STALE_MS = 6 * 60 * 60 * 1000

/** What the module keeps between events; a hot reload starts it over (everything drawn is in $.state). */
const runtime = {
  ticker: null as Timer | null,
  /** Clear & continue is running (a second press is ignored). */
  isClearing: false,
  /** A fill from the after-clear marker is running (SessionStart and after-run never fill at once). */
  isFilling: false,
  /** The last after-clear fill: the marker's `at` and whether the box took it. */
  lastFill: null as { at: number; isFilled: boolean } | null,
  /** The warming timer (next ping or the window's end) and when it fires. */
  warmTimer: null as Timer | null,
  warmDue: 0,
  /** The session id the store keys use, read once per conversation; null when the engine cannot say (nothing is persisted then). */
  sid: undefined as string | null | undefined,
  /** A ping (or the overnight handoff) is running. */
  isPinging: false,
}

function sameContext(a: RelayContext | null, b: RelayContext | null): boolean {
  if (a === null || b === null) return a === b
  return a.tokens === b.tokens && a.percent === b.percent && a.window === b.window
}

/** Keeps the latest context figures (only when they moved, so the row redraws only then). */
async function setContext($: Engine, context: SessionContextUsage | RelayContext | null) {
  const next: RelayContext | null =
    context === null ? null : { tokens: context.tokens, percent: context.percent, window: context.window }
  const current = await read($, contextAtom)
  if (!sameContext(current, next)) await update($, contextAtom, () => next)
}

/** Reads the figures straight from the engine (session start); a failed read leaves them as they were. */
async function readUsage($: Engine) {
  try {
    const usage = await $.session.usage()
    await setContext($, usage.context)
  } catch {
    // No reading: the row shows "—" until the first session.measure.
  }
}

/** A fresh window: cache state unknown, no figures, no snooze (after /clear or compaction). */
async function resetSession($: Engine) {
  await update($, lastResponseAtom, () => null)
  await update($, contextAtom, () => null)
  await update($, snoozedAtom, () => false)
}

/** Bumps the tick only while the row shows a running cache clock (Relay on, a reply seen). */
async function tick($: Engine) {
  const [enabled, lastResponseAt] = await Promise.all([read($, enabledAtom), read($, lastResponseAtom)])
  if (enabled && lastResponseAt !== null) await update($, tickAtom, n => (n + 1) % 1_000_000)
}

/**
 * Runs the 30s tick that redraws the row's "left" time. A hot reload drops the timer and
 * `runtime`, so every caller (session start, a reply, each band draw) starts it again lazily.
 */
function ensureTicker($: Engine) {
  if (runtime.ticker !== null) return
  runtime.ticker = $.clock.every(TICK_MS, () => {
    void tick($).catch(() => undefined)
  })
}

async function setEnabled($: Engine, isOn: boolean) {
  await update($, enabledAtom, () => isOn)
  await $.store.set(ENABLED_KEY, isOn)
  // Off = no row, no warming, no guard; on again, the next reply arms warming.
  if (!isOn) await dropForOff($)
}

/** Relay off: no window, and a held prompt goes back in the prompt box. */
async function dropForOff($: Engine) {
  await releaseHeld($)
  await setWarming($, w => ({ ...w, windowEnd: null, nextPingAt: undefined }))
}

/**
 * Picks up `/relay on|off` typed in another session (the store is shared, $.state is
 * not): read at each turn start and each warming timer.
 */
async function syncEnabled($: Engine) {
  let saved: unknown
  try {
    saved = await $.store.get(ENABLED_KEY)
  } catch {
    return
  }
  const isOn = saved !== false
  if ((await read($, enabledAtom)) === isOn) return
  await update($, enabledAtom, () => isOn)
  if (!isOn) await dropForOff($)
}

/** The session root, or undefined when the engine cannot say. */
async function sessionRoot($: Engine): Promise<string | undefined> {
  try {
    return await $.session.root()
  } catch {
    return undefined
  }
}

/** The handoff index from the store; an unreadable store reads as empty. */
async function loadIndex($: Engine): Promise<RelayHandoff[]> {
  try {
    return readIndex(await $.store.get(HANDOFFS_KEY))
  } catch {
    return []
  }
}

/** Marks one handoff consumed in the store's index. */
async function consume($: Engine, id: string) {
  const now = await $.clock.now()
  await $.store.set(HANDOFFS_KEY, markConsumed(await loadIndex($), id, now))
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** One read-only git command's stdout, or undefined when it failed or could not start. */
async function git($: Engine, root: string, args: readonly string[]): Promise<string | undefined> {
  try {
    const result = await $.process.run(['git', ...args], { cwd: root, timeoutMs: 15_000 })
    return result.exitCode === 0 ? result.stdout : undefined
  } catch {
    return undefined
  }
}

/** The git facts for the brief, from read-only commands only; never a write. Not a repo: no facts. */
async function gitFactLines($: Engine, root: string): Promise<string[]> {
  const [branch, symbolicRef] = await Promise.all([
    git($, root, ['rev-parse', '--abbrev-ref', 'HEAD']),
    git($, root, ['symbolic-ref', '--short', 'HEAD']),
  ])
  const outputs: GitOutputs = { branch, symbolicRef }
  if ((branch ?? '').trim() !== '' || (symbolicRef ?? '').trim() !== '') {
    const [log, aheadBehind, porcelain] = await Promise.all([
      git($, root, ['log', '-1', '--format=%h %s']),
      git($, root, ['rev-list', '--left-right', '--count', '@{u}...HEAD']),
      git($, root, ['--no-optional-locks', 'status', '--porcelain']),
    ])
    Object.assign(outputs, { log, aheadBehind, porcelain })
  }
  return formatGitFacts(parseGitFacts(outputs))
}

async function homeDir($: Engine): Promise<string | undefined> {
  try {
    const home = (await $.env.get('USERPROFILE')) || (await $.env.get('HOME'))
    return home === undefined || home === '' ? undefined : home
  } catch {
    return undefined
  }
}

/** Runs a button's work; a rejection becomes a toast instead of an unhandled error. */
async function safely($: Engine, work: () => Promise<unknown>) {
  try {
    await work()
  } catch (err) {
    $.ui.toast(`Relay: ${errorText(err)}`)
  }
}

/**
 * The handoff, from every way in: the Handoff button, "Handoff now", `/handoff`, the
 * cold confirmation's "Write it anyway" (and later the cold guard). Called directly, not
 * through `$.command.run({ command: 'handoff' })`: a plugin's own `$.command.run` from its
 * press handler skips the plugin's own `command.run` hooks (re-entry). Resolves the line
 * `/handoff` answers with.
 */
async function startHandoff($: Engine, opts: { coldConfirmed?: boolean; heldText?: string } = {}): Promise<string> {
  if (await read($, busyAtom)) {
    $.ui.toast(BUSY_TEXT)
    if (opts.heldText !== undefined) await putBack($, opts.heldText)
    return `${BUSY_TEXT}.`
  }
  // The cold check comes before the busy flag, so asking never flickers "Writing handoff…".
  if (opts.coldConfirmed !== true) {
    const [context, lastResponseAt, now] = await Promise.all([read($, contextAtom), read($, lastResponseAtom), $.clock.now()])
    const tokens = context?.tokens
    if (cacheState(lastResponseAt ?? undefined, now).state === 'cold' && typeof tokens === 'number' && tokens >= MIN_WARM_TOKENS) {
      let model: string | undefined
      try {
        model = await $.session.model()
      } catch {
        model = undefined
      }
      const usd = estimateRewriteUsd(tokens, model)
      await update($, coldAtom, () => ({
        tokens,
        ...(usd !== undefined ? { usd } : {}),
        ...(opts.heldText !== undefined ? { heldText: opts.heldText } : {}),
      }))
      return `${coldHandoffText(tokens, usd)} Confirm with "Write it anyway" on the Relay row above the prompt.`
    }
  }

  let wasBusy = false
  await update($, busyAtom, busy => {
    wasBusy = busy
    return true
  })
  if (wasBusy) {
    $.ui.toast(BUSY_TEXT)
    if (opts.heldText !== undefined) await putBack($, opts.heldText)
    return `${BUSY_TEXT}.`
  }
  try {
    await update($, coldAtom, () => null)
    return await writeHandoff($, opts.heldText)
  } catch (err) {
    if (opts.heldText !== undefined) await putBack($, opts.heldText)
    throw err
  } finally {
    await update($, busyAtom, () => false)
  }
}

/** A brief forked and saved, or why not: `text` for the person, `reason` in a few words for the row. */
type SavedHandoff =
  | { isSaved: true; id: string; key: string; title: string; text: string; path: string }
  | { isSaved: false; text: string; reason: string }

/**
 * Forks the brief and saves it (file + index), with no pane and no clear: the shared
 * half of the handoff flow and the overnight handoff. A file or index that cannot be
 * written is toasted and the handoff still counts as saved (the index keeps it).
 */
async function forkAndSave($: Engine): Promise<SavedHandoff> {
  const root = await sessionRoot($)
  if (root === undefined) {
    return { isSaved: false, text: 'The handoff could not be written: no session root.', reason: 'no session root' }
  }
  const facts = await gitFactLines($, root)

  let result: Awaited<ReturnType<Engine['model']['fork']>>
  try {
    result = await $.model.fork({ prompt: buildHandoffPrompt(facts.join('\n')) })
  } catch (err) {
    return { isSaved: false, text: `The handoff could not be written: ${errorText(err)}`, reason: errorText(err) }
  }
  if (!result.isAnswered) {
    const status = result.reason === 'api-error' ? (result.status ?? undefined) : undefined
    return { isSaved: false, text: forkFailureText(result.reason, status), reason: forkStopReason(result.reason, status) }
  }

  const text = result.text.trim()
  const title = extractTitle(text)
  const now = await $.clock.now()
  const key = projectKey(root)
  const home = await homeDir($)
  let path = home === undefined ? '' : joinPath(handoffDir(home, key), handoffFileName(new Date(now), title))
  if (path === '') {
    $.ui.toast('The handoff was not saved to a file: no home folder (USERPROFILE or HOME).')
  } else {
    try {
      await $.fs.write(path, `${text}\n`)
    } catch (err) {
      $.ui.toast(`The handoff file could not be saved: ${errorText(err)}`)
      path = ''
    }
  }

  const id = `${now}-${slugify(title)}`
  const record: RelayHandoff = { id, projectKey: key, root, title, path, createdAt: now }
  try {
    await $.store.set(HANDOFFS_KEY, addHandoff(await loadIndex($), record))
  } catch (err) {
    $.ui.toast(`The handoff could not be indexed: ${errorText(err)}`)
  }
  return { isSaved: true, id, key, title, text, path }
}

/**
 * The overnight handoff (warming.ts): fork + save as an unconsumed handoff, no pane,
 * no clear. Skipped (not saved) while another handoff is being written.
 */
async function saveHandoffSilently($: Engine): Promise<{ isSaved: true; title: string } | { isSaved: false; reason: string }> {
  let wasBusy = false
  await update($, busyAtom, busy => {
    wasBusy = busy
    return true
  })
  if (wasBusy) return { isSaved: false, reason: 'a handoff was already being written' }
  try {
    const saved = await forkAndSave($)
    return saved.isSaved ? { isSaved: true, title: saved.title } : { isSaved: false, reason: saved.reason }
  } finally {
    await update($, busyAtom, () => false)
  }
}

/** Forks the brief, saves it (file + index) and opens the preview pane. */
async function writeHandoff($: Engine, heldText: string | undefined): Promise<string> {
  const written = await forkAndSave($)
  if (!written.isSaved) {
    $.ui.toast(written.text)
    if (heldText !== undefined) await putBack($, heldText)
    return written.text
  }
  const { id, key, title, text, path } = written
  const draft: RelayDraft = { id, projectKey: key, title, text, path, ...(heldText !== undefined ? { heldText } : {}) }
  await update($, draftAtom, () => draft)
  const saved = path === '' ? 'it is not saved to a file' : `saved to ${path}`
  try {
    const opened = await $.ui.open({ id: PANE, title: 'Handoff' })
    if (!opened.isPlaced) $.ui.toast(`Widen the window to see the Handoff pane — ${saved}.`)
  } catch {
    $.ui.toast(`The Handoff pane could not open — ${saved}.`)
  }
  return `Handoff written: "${title}".${path === '' ? '' : ` Saved to ${path}.`} Review it in the Handoff pane.`
}

/** "Write it anyway" on the cold confirmation; while a handoff is already being written the row stays. */
async function confirmCold($: Engine) {
  if (await read($, busyAtom)) {
    $.ui.toast(BUSY_TEXT)
    return
  }
  const cold = await read($, coldAtom)
  await update($, coldAtom, () => null)
  await startHandoff($, { coldConfirmed: true, ...(cold?.heldText !== undefined ? { heldText: cold.heldText } : {}) })
}

/**
 * "Handoff & start fresh" on the cold guard's row: the handoff flow with the cold cost
 * already accepted, the held prompt riding along to land below the handoff after the clear.
 */
async function handoffFresh($: Engine) {
  if (await read($, busyAtom)) {
    $.ui.toast(BUSY_TEXT)
    return
  }
  const guard = await takeHeld($)
  if (guard === null) return
  await startHandoff($, { coldConfirmed: true, heldText: guard.heldText })
}

async function cancelCold($: Engine) {
  const cold = await read($, coldAtom)
  await update($, coldAtom, () => null)
  if (cold?.heldText !== undefined) await putBack($, cold.heldText)
}

async function closePane($: Engine) {
  await update($, draftAtom, () => null)
  try {
    await $.ui.close({ id: PANE })
  } catch {
    // Already closed.
  }
}

/** Where the handoff can still be found when the prompt box or the clipboard failed. */
function fallbackText(marker: Pick<RelayFillMarker, 'isCopied' | 'path'>): string {
  if (marker.isCopied === true) return 'it is on the clipboard'
  return marker.path ? `it is saved at ${marker.path}` : 'copy it from the Handoff pane next time'
}

/**
 * Clear & continue: clipboard, consumed, pane closed, a marker in the store (it outlives
 * the clear even if module state does not), then /clear. The prompt box is filled on the
 * following SessionStart (source clear), or right after the clear resolves if that never
 * came; then the box is read back and filled once more if the clear emptied it. Never sent.
 */
async function clearAndContinue($: Engine, press: UiPressArgument) {
  if (runtime.isClearing) return
  runtime.isClearing = true
  try {
    const draft = await read($, draftAtom)
    if (draft === null) return
    let isCopied = false
    try {
      isCopied = (await $.ui.copy({ text: draft.text, surface: press.surface })).isCopied
    } catch {
      isCopied = false
    }
    await consume($, draft.id)
    await closePane($)
    const marker: RelayFillMarker = {
      text: draft.text,
      projectKey: draft.projectKey,
      path: draft.path,
      isCopied,
      at: await $.clock.now(),
      ...(draft.heldText !== undefined ? { heldText: draft.heldText } : {}),
    }
    await $.store.set(FILL_KEY, marker)
    try {
      await $.command.run({ command: 'clear' })
    } catch (err) {
      await $.store.delete(FILL_KEY)
      $.ui.toast(`/clear could not run (${errorText(err)}) — ${fallbackText(marker)}.`)
      if (marker.heldText !== undefined) await putBack($, marker.heldText)
      return
    }
    await fillAfterClear($, 'after-run')
    await verifyFill($, marker)
  } finally {
    runtime.isClearing = false
  }
}

/** After the clear resolved: when the box does not hold the handoff (the clear emptied it), fill it once more. */
async function verifyFill($: Engine, marker: RelayFillMarker) {
  const last = runtime.lastFill
  if (last === null || last.at !== marker.at || !last.isFilled) return
  const expected = fillText(marker.text, marker.heldText)
  let box: string | undefined
  try {
    box = (await $.prompt.read()).text
  } catch {
    return
  }
  if (box.trim() === expected.trim()) return
  const again = await $.prompt.fill({ text: expected, mode: 'replace' }).catch(() => undefined)
  if (again?.isFilled !== true) $.ui.toast(`The handoff could not go in the prompt box — ${fallbackText(marker)}.`)
}

function readMarker(value: unknown): RelayFillMarker | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const marker = value as RelayFillMarker
  return typeof marker.text === 'string' && typeof marker.at === 'number' ? marker : undefined
}

/**
 * Fills the prompt box from the store's marker, once, for this session's project only.
 * `session-start` (SessionStart, source clear) fills and deletes it; `after-run` (the
 * clear's `$.command.run` resolved and the SessionStart never filled) fills and leaves it
 * marked filled, so a late SessionStart only deletes it. A synchronous in-module flag keeps
 * the two from filling at once. Resolves true when a fresh marker for this project was
 * there (so no pending offer is shown).
 */
async function fillAfterClear($: Engine, from: 'session-start' | 'after-run'): Promise<boolean> {
  // Set before the first await: a SessionStart arriving mid-fill neither fills nor offers.
  if (runtime.isFilling) return true
  runtime.isFilling = true
  try {
    let marker: RelayFillMarker | undefined
    try {
      marker = readMarker(await $.store.get(FILL_KEY))
    } catch {
      return false
    }
    if (marker === undefined) return false
    const now = await $.clock.now()
    if (now - marker.at > FILL_MAX_AGE_MS) {
      await $.store.delete(FILL_KEY)
      return false
    }
    const root = await sessionRoot($)
    if (marker.projectKey !== undefined && (root === undefined || projectKey(root) !== marker.projectKey)) return false
    if (marker.filledAt === undefined) {
      let isFilled = false
      try {
        isFilled = (await $.prompt.fill({ text: fillText(marker.text, marker.heldText), mode: 'replace' })).isFilled
      } catch {
        isFilled = false
      }
      runtime.lastFill = { at: marker.at, isFilled }
      $.ui.toast(isFilled ? LOADED_TEXT : `The handoff could not go in the prompt box — ${fallbackText(marker)}.`)
    }
    if (from === 'session-start') await $.store.delete(FILL_KEY)
    else await $.store.set(FILL_KEY, { ...marker, filledAt: now })
    return true
  } finally {
    runtime.isFilling = false
  }
}

async function copyDraft($: Engine, press: UiPressArgument) {
  const draft = await read($, draftAtom)
  if (draft === null) return
  const saved = draft.path === '' ? 'it is not saved to a file' : `it is saved at ${draft.path}`
  try {
    const copied = await $.ui.copy({ text: draft.text, surface: press.surface })
    $.ui.toast(copied.isCopied ? 'Handoff copied' : `Could not copy the handoff (${copied.reason}) — ${saved}.`)
  } catch (err) {
    $.ui.toast(`Could not copy the handoff (${errorText(err)}) — ${saved}.`)
  }
}

/** Cancel: the pane closes; the handoff stays saved and unconsumed, so a later session offers it. */
async function cancelDraft($: Engine) {
  const draft = await read($, draftAtom)
  await closePane($)
  if (draft?.heldText !== undefined) await putBack($, draft.heldText)
}

/** Offers this project's newest unconsumed handoff (within 7 days) on the band. */
async function offerPending($: Engine) {
  const root = await sessionRoot($)
  if (root === undefined) return
  const [index, now] = await Promise.all([loadIndex($), $.clock.now()])
  const one = pendingFor(index, projectKey(root), now)
  const offer: RelayOffer | null = one === undefined ? null : { id: one.id, title: one.title, path: one.path, createdAt: one.createdAt }
  await update($, offerAtom, () => offer)
}

/** Load: the saved file into the prompt box (not sent); consumed and gone only once the box took it. */
async function loadOffer($: Engine) {
  const offer = await read($, offerAtom)
  if (offer === null) return
  let text: string | undefined
  try {
    const content = offer.path === '' ? undefined : await $.fs.read(offer.path)
    text = typeof content === 'string' ? content : undefined
  } catch {
    text = undefined
  }
  if (text === undefined) {
    $.ui.toast(`The handoff file is missing${offer.path === '' ? '' : ` (${offer.path})`}. Dismiss to stop seeing it.`)
    return
  }
  let isFilled = false
  let why = 'the box did not take it'
  try {
    const filled = await $.prompt.fill({ text: text.trimEnd(), mode: 'replace' })
    isFilled = filled.isFilled
    if (filled.refusal === 'dialog') why = 'a dialog holds the keys'
    else if (filled.refusal === 'no_composer') why = 'this session has no prompt box'
  } catch (err) {
    why = errorText(err)
  }
  if (!isFilled) {
    $.ui.toast(`The handoff could not go in the prompt box (${why}). It is saved at ${offer.path}; try Load again.`)
    return
  }
  await consume($, offer.id)
  await update($, offerAtom, () => null)
  $.ui.toast(LOADED_TEXT)
}

async function dismissOffer($: Engine) {
  const offer = await read($, offerAtom)
  if (offer === null) return
  await consume($, offer.id)
  await update($, offerAtom, () => null)
}

async function listHandoffs($: Engine): Promise<string> {
  const [root, index, now] = await Promise.all([sessionRoot($), loadIndex($), $.clock.now()])
  return handoffListText(index, root === undefined ? '' : projectKey(root), now)
}

async function snooze($: Engine) {
  await update($, snoozedAtom, () => true)
}

// ---------------------------------------------------------------------------
// Warming and the cold-cache guard: the `$` side of warming.ts's decisions.
// Adapted from the cache-tax mod (MIT License, Copyright (c) 2026 Karan Bansal).
// ---------------------------------------------------------------------------

function cancelWarmTimer() {
  runtime.warmTimer?.cancel()
  runtime.warmTimer = null
}

/** The session id, read once per conversation (a /clear starts a new one); undefined when the engine cannot say. */
async function sessionId($: Engine): Promise<string | undefined> {
  if (runtime.sid === undefined) {
    try {
      const id = await $.session.id()
      runtime.sid = typeof id === 'string' && id !== '' ? id : null
    } catch {
      runtime.sid = null
    }
  }
  return runtime.sid ?? undefined
}

/** `relay.warming.<session id>`; undefined with no session id (warming then lives in $.state only). */
async function warmingKey($: Engine): Promise<string | undefined> {
  const sid = await sessionId($)
  return sid === undefined ? undefined : `${WARMING_KEY_PREFIX}${sid}`
}

/** `relay.heldText.<session id>`; undefined with no session id. */
async function heldKey($: Engine): Promise<string | undefined> {
  const sid = await sessionId($)
  return sid === undefined ? undefined : `${HELD_KEY_PREFIX}${sid}`
}

async function storeHeld($: Engine, text: string | null) {
  try {
    const key = await heldKey($)
    if (key === undefined) return
    if (text === null) await $.store.delete(key)
    else await $.store.set(key, { text, at: await $.clock.now() })
  } catch {
    // The row still holds it.
  }
}

/**
 * Puts a held prompt back in the prompt box (appended, never sent) so it is never
 * lost: after a failed or cancelled Handoff & start fresh, a failed Send anyway, a
 * reply that arrived meanwhile, a /clear, or Relay switched off.
 */
async function putBack($: Engine, text: string) {
  let isFilled = false
  try {
    isFilled = (await $.prompt.fill({ text, mode: 'append' })).isFilled
  } catch {
    isFilled = false
  }
  if (isFilled) {
    await storeHeld($, null)
    $.ui.toast(HELD_BACK_TEXT)
  } else {
    $.ui.toast(`Your held message could not go back in the prompt box: ${fit(text, 300)}`)
  }
}

/** A held prompt on the row, if any, goes back in the prompt box. */
async function releaseHeld($: Engine) {
  const guard = await read($, coldGuardAtom)
  await update($, coldGuardAtom, () => null)
  if (guard !== null) await putBack($, guard.heldText)
}

/** Session start: a held prompt the store kept (the process restarted while it was held) goes back in the box. */
async function restoreHeld($: Engine) {
  if ((await read($, coldGuardAtom)) !== null) return
  try {
    const key = await heldKey($)
    if (key === undefined) return
    const held = readHeld(await $.store.get(key))
    if (held !== undefined) await putBack($, held.text)
  } catch {
    // Nothing kept.
  }
}

/** Session start: drops other sessions' dead warming windows, stale off flags and old held prompts. */
async function pruneStore($: Engine) {
  try {
    const now = await $.clock.now()
    for (const key of await $.store.keys()) {
      if (!key.startsWith(WARMING_KEY_PREFIX) && !key.startsWith(HELD_KEY_PREFIX)) continue
      if (isStale(key, await $.store.get(key), now)) await $.store.delete(key)
    }
  } catch {
    // A store with no key listing: nothing pruned.
  }
}

/** Whether a main-thread turn is running (a turn.start with no turn.complete, younger than 6 hours). */
async function isTurnRunning($: Engine): Promise<boolean> {
  const [startedAt, now] = await Promise.all([read($, turnRunningAtom), $.clock.now()])
  return startedAt !== null && now - startedAt < TURN_STALE_MS
}

/** Changes this session's warming, mirrors it in the store, and re-arms the timer. */
async function setWarming($: Engine, change: (w: RelayWarming) => RelayWarming) {
  const next = change((await read($, warmingAtom)) ?? NO_WARMING)
  await update($, warmingAtom, () => next)
  try {
    const key = await warmingKey($)
    if (key !== undefined) {
      if (isWorthKeeping(next)) await $.store.set(key, next)
      else await $.store.delete(key)
    }
  } catch {
    // The atom stands; only a reload in a new process would miss it.
  }
  await armWarmTimer($)
}

/**
 * Starts the one timer for the next ping or the window's end, unless it is already
 * pending for that time. A hot reload drops it, so session start, each reply and each
 * band draw call this again.
 */
async function armWarmTimer($: Engine) {
  const [w, now, isRunning] = await Promise.all([read($, warmingAtom), $.clock.now(), isTurnRunning($)])
  const due = dueAt(w)
  // Never mid-turn: the turn's end arms it again.
  if (due === undefined || isRunning) {
    cancelWarmTimer()
    return
  }
  // Checked after the awaits, so two callers at once still start one timer.
  if (runtime.warmTimer !== null && runtime.warmDue === due) return
  cancelWarmTimer()
  runtime.warmDue = due
  runtime.warmTimer = $.clock.after(Math.max(0, due - now), () => {
    runtime.warmTimer = null
    void onWarmDue($).catch(() => setWarming($, x => stopped(x, 'error')).catch(() => undefined))
  })
}

/** Session start (and so a reload or a resume): the window from the store when $.state has none, then the timer. */
async function restoreWarming($: Engine) {
  if ((await read($, warmingAtom)) === null) {
    try {
      const key = await warmingKey($)
      const saved = key === undefined ? undefined : readWarming(await $.store.get(key))
      if (saved !== undefined) {
        const w = restoredWarming(saved, await $.clock.now())
        await update($, warmingAtom, () => w)
      }
    } catch {
      // Nothing saved for this session.
    }
  }
  await armWarmTimer($)
}

/** A main-thread reply: the guard's row goes, and the window is armed or extended (warming.ts afterReply). */
async function warmAfterReply($: Engine, now: number) {
  await releaseHeld($)
  await update($, resumeEstimateAtom, () => null)
  const [enabled, context] = await Promise.all([read($, enabledAtom), read($, contextAtom)])
  await setWarming($, w => afterReply(w, { now, enabled, tokens: context?.tokens }))
}

/** /clear or compaction: no window, no held prompt; `/keepwarm off` stays for the session. */
async function resetWarming($: Engine, isClear: boolean) {
  await releaseHeld($)
  await update($, guardEpisodeAtom, () => null)
  await update($, resumeEstimateAtom, () => null)
  if (isClear) {
    // The conversation goes on under a new session id: drop the old key, read the id again.
    try {
      const key = await warmingKey($)
      if (key !== undefined) await $.store.delete(key)
    } catch {
      // Nothing to drop.
    }
    runtime.sid = undefined
  }
  await setWarming($, w => ({ windowEnd: null, off: w.off }))
}

async function sessionModel($: Engine): Promise<string | undefined> {
  try {
    return await $.session.model()
  } catch {
    return undefined
  }
}

async function isOvernightOn($: Engine): Promise<boolean> {
  try {
    return (await $.store.get(OVERNIGHT_KEY)) !== false
  } catch {
    return true
  }
}

/** Whether this project already has a handoff saved at or after `at` (the last reply): it is still current. */
async function hasHandoffSince($: Engine, at: number | undefined): Promise<boolean> {
  if (at === undefined) return false
  const root = await sessionRoot($)
  if (root === undefined) return false
  const key = projectKey(root)
  return (await loadIndex($)).some(one => one.projectKey === key && one.createdAt >= at)
}

async function onWarmDue($: Engine) {
  if (runtime.isPinging) return
  runtime.isPinging = true
  try {
    await pingOrHandoff($)
  } catch {
    await setWarming($, x => stopped(x, 'error'))
  } finally {
    runtime.isPinging = false
  }
}

/**
 * The timer fired: end the window, or ping, or (when the next ping would fall at or
 * after the window's end and the overnight handoff is on) save a handoff in the last
 * ping's place, unless one was already saved since the last reply or one is being written.
 */
async function pingOrHandoff($: Engine) {
  await syncEnabled($)
  const [w, enabled, lastResponseAt, context, now, isRunning] = await Promise.all([
    read($, warmingAtom),
    read($, enabledAtom),
    read($, lastResponseAtom),
    read($, contextAtom),
    $.clock.now(),
    isTurnRunning($),
  ])
  const action = dueAction({ w, enabled, lastResponseAt, tokens: context?.tokens, now, isTurnRunning: isRunning })
  switch (action.kind) {
    case 'none':
      return
    case 'drop':
      return setWarming($, x => ({ ...x, windowEnd: null, nextPingAt: undefined }))
    case 'stop':
      return setWarming($, x => stopped(x, action.reason))
    case 'rearm':
      return armWarmTimer($)
    case 'end':
      // A window with no ping left in it (one shorter than the first ping, say): the
      // overnight handoff runs at its end while the cache is still warm.
      if ((await isOvernightOn($)) && !(await read($, busyAtom)) && !(await hasHandoffSince($, w?.lastTurnAt))) {
        return overnightHandoff($)
      }
      return setWarming($, x => stopped(x, action.reason))
    case 'ping':
      if (action.isLast && (await isOvernightOn($)) && !(await read($, busyAtom)) && !(await hasHandoffSince($, w?.lastTurnAt))) {
        return overnightHandoff($)
      }
      return warmPing($)
  }
}

async function warmPing($: Engine) {
  let result: Awaited<ReturnType<Engine['model']['fork']>>
  try {
    result = await $.model.fork({ prompt: PING_PROMPT })
  } catch (err) {
    return setWarming($, x => stopped(x, `the ping failed: ${errorText(err)}`))
  }
  if (!result.isAnswered) {
    const reason = forkStopReason(result.reason, result.reason === 'api-error' ? (result.status ?? undefined) : undefined)
    return setWarming($, x => stopped(x, reason))
  }
  const usage = result.usage
  const at = await $.clock.now()
  const price = modelPrice(await sessionModel($))
  const readTokens = usage.cache_read_input_tokens
  const writeTokens = usage.cache_creation_input_tokens
  const last = { at, read: readTokens, write: writeTokens, ...(price !== undefined ? { usd: pingUsd(usage, price) } : {}) }
  const problem = pingProblem(readTokens, writeTokens)
  if (problem !== undefined) return setWarming($, x => stopped(x, problem, { last }))
  // A ping that read the cache refreshed it: it counts as a response for the cache clock.
  await update($, lastResponseAtom, () => at)
  await setWarming($, x => ({ ...x, last, nextPingAt: at + PING_IDLE_MS }))
}

/** The window's last ping, replaced: fork + save a handoff (no pane, no clear), then let the cache go cold. */
async function overnightHandoff($: Engine) {
  let saved: Awaited<ReturnType<typeof saveHandoffSilently>>
  try {
    saved = await saveHandoffSilently($)
  } catch (err) {
    return setWarming($, x => stopped(x, `no overnight handoff: ${errorText(err)}`))
  }
  if (!saved.isSaved) {
    const reason = `no overnight handoff: ${saved.reason}`
    return setWarming($, x => stopped(x, reason))
  }
  // The handoff's fork read the cache too, so the clock moves; after it the cache is let go cold.
  const at = await $.clock.now()
  await update($, lastResponseAtom, () => at)
  $.ui.toast(`Relay saved a handoff before the cache cooled: ${saved.title}`)
  await setWarming($, x => stopped(x, 'handoff saved'))
}

/** `/keepwarm <duration>|off|status` (bare = status). */
async function keepwarmCommand($: Engine, args: string): Promise<string> {
  const word = args.trim().toLowerCase()
  if (word === '' || word === 'status') return `Warming: ${await warmingStatus($)}`
  if (word === 'off') {
    const at = await $.clock.now()
    await setWarming($, w => stopped({ ...w, off: true, offAt: at }, 'turned off'))
    return 'Warming is off for this session. /keepwarm 2h turns it on again.'
  }
  const ms = parseDuration(word)
  if (ms === undefined) return KEEPWARM_HELP
  const [enabled, context, lastResponseAt, now] = await Promise.all([
    read($, enabledAtom),
    read($, contextAtom),
    read($, lastResponseAtom),
    $.clock.now(),
  ])
  if (!enabled) return 'Relay is off. Type /relay on first.'
  const tokens = context?.tokens
  if (!(typeof tokens === 'number' && tokens >= MIN_WARM_TOKENS)) {
    const has = typeof tokens === 'number' ? `this one has ${formatTokens(tokens)}` : 'this one has no reading yet'
    return `Relay warms sessions from ${formatTokens(MIN_WARM_TOKENS)} tokens of context; ${has}.`
  }
  const plan = keepwarmWindow((await read($, warmingAtom)) ?? NO_WARMING, { now, ms, lastResponseAt })
  await setWarming($, () => plan.warming)
  return plan.text
}

/** `/relay overnight on|off`. */
async function overnightCommand($: Engine, isOn: boolean): Promise<string> {
  await $.store.set(OVERNIGHT_KEY, isOn)
  return isOn
    ? 'Overnight handoff is on: the last ping of a warming window writes a handoff instead, then the cache is let go cold.'
    : 'Overnight handoff is off: the last ping of a warming window is a plain ping.'
}

/** The status card's (and `/keepwarm status`'s) warming line. */
async function warmingStatus($: Engine): Promise<string> {
  const [w, now, overnight] = await Promise.all([read($, warmingAtom), $.clock.now(), isOvernightOn($)])
  return warmingLine(w, now, overnight)
}

/** The rewrite estimate: the resume's own figure while its clock stands, else tokens times the model's write price. */
async function rewriteEstimate($: Engine, tokens: number, lastResponseAt: number): Promise<number | undefined> {
  const resumed = await read($, resumeEstimateAtom)
  if (resumed !== null && resumed.at === lastResponseAt) return resumed.usd
  return estimateRewriteUsd(tokens, await sessionModel($))
}

/**
 * The cold-cache guard at `prompt.submit`: the drop reason when the prompt is held,
 * undefined to let it through. Holds a typed prompt into a cold cache (context 50k+,
 * Relay on) once per cold episode, keeping its text on the row; the next typed send in
 * that episode goes through, as cache-tax does. See warming.ts isGuardable/guardVerdict.
 */
async function holdColdPrompt($: Engine, e: PromptSubmitInput): Promise<string | undefined> {
  if (!isGuardable(e)) return undefined
  const [enabled, context, lastResponseAt, episode, now] = await Promise.all([
    read($, enabledAtom),
    read($, contextAtom),
    read($, lastResponseAtom),
    read($, guardEpisodeAtom),
    $.clock.now(),
  ])
  const tokens = context?.tokens
  const verdict = guardVerdict({ enabled, tokens, lastResponseAt, episode, now })
  if (verdict === 'pass') return undefined
  if (verdict === 'release') {
    await update($, coldGuardAtom, () => null)
    await storeHeld($, null)
    return undefined
  }
  if (lastResponseAt === null || tokens === undefined) return undefined
  const usd = await rewriteEstimate($, tokens, lastResponseAt)
  const guard: RelayColdGuard = { heldText: e.text, tokens, coldSince: lastResponseAt + CACHE_TTL_MS, ...(usd !== undefined ? { usd } : {}) }
  await update($, guardEpisodeAtom, () => lastResponseAt)
  await update($, coldGuardAtom, () => guard)
  await storeHeld($, e.text)
  return coldDropText(coldGuardText(now - guard.coldSince, tokens, usd))
}

/** Takes the held prompt off the row (and out of the store: whoever takes it now owns it). */
async function takeHeld($: Engine): Promise<RelayColdGuard | null> {
  const guard = await read($, coldGuardAtom)
  await update($, coldGuardAtom, () => null)
  if (guard !== null) await storeHeld($, null)
  return guard
}

/**
 * Send anyway: submits the held text as the person's own words. Its origin is
 * `{ kind: 'plugin', name: 'relay', asUser: true }`, which the guard never holds.
 */
async function sendAnyway($: Engine) {
  const guard = await takeHeld($)
  if (guard === null) return
  let result: Awaited<ReturnType<Engine['prompt']['submit']>> | undefined
  try {
    result = await $.prompt.submit({ text: guard.heldText, asUser: true })
  } catch {
    result = undefined
  }
  if (result === undefined || result.drop !== undefined) await putBack($, guard.heldText)
}

async function buildStatus($: Engine): Promise<string> {
  const [enabled, context, lastResponseAt, snoozed, now, root, index, warming] = await Promise.all([
    read($, enabledAtom),
    read($, contextAtom),
    read($, lastResponseAtom),
    read($, snoozedAtom),
    $.clock.now(),
    sessionRoot($),
    loadIndex($),
    warmingStatus($),
  ])
  const pending = root === undefined ? 'unknown (no session root)' : pendingLine(index, projectKey(root), now)
  return statusCard({
    enabled,
    context,
    cache: cacheState(lastResponseAt ?? undefined, now),
    snoozed,
    pending,
    warming: enabled ? warming : 'off (Relay is off)',
  })
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    // /relay first: Robert's Toolbox runs a mod's first registered command.
    await $.command.register({
      name: 'relay',
      description: 'Relay status: context, prompt cache, warming and handoffs; /relay on|off, /relay overnight on|off',
      argumentHint: '[on|off|overnight on|off]',
      immediate: true,
    })
    await $.command.register({
      name: 'handoff',
      description: 'Write a handoff for a fresh session and start over (Relay)',
    })
    await $.command.register({
      name: 'keepwarm',
      description: 'Keep the prompt cache warm for a window such as 90m or 2h (max 12h); off; status (Relay)',
      argumentHint: '[90m|2h|off|status]',
      immediate: true,
    })
    const saved = await $.store.get(ENABLED_KEY)
    await update($, enabledAtom, () => saved !== false)
    await readUsage($)
    ensureTicker($)
    await update($, turnRunningAtom, () => null)
    await pruneStore($)
    await restoreWarming($)
    await restoreHeld($)
    return next(e)
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'relay' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    if (arg === 'on' || arg === 'off') {
      await setEnabled($, arg === 'on')
      return { text: arg === 'on' ? 'Relay is on.' : 'Relay is off: no meter row, no warming, no cold-cache guard.' }
    }
    const overnight = /^overnight\s+(on|off)$/.exec(arg)
    if (overnight) return { text: await overnightCommand($, overnight[1] === 'on') }
    if (arg !== '') return { text: RELAY_HELP }
    return { text: await buildStatus($) }
  })

  on('command.run', { command: 'keepwarm' }, async ($, e) => ({ text: await keepwarmCommand($, e.args) }))

  // The cold-cache guard: a typed prompt sent into a cold cache is held once (dropped,
  // its text kept on the row). On any failure the prompt goes through.
  on('prompt.submit', async ($, e, next) => {
    const drop = await holdColdPrompt($, e)
    return drop === undefined ? next(e) : { drop }
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'handoff' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    if (arg === '') return { text: await startHandoff($) }
    if (arg === 'list') return { text: await listHandoffs($) }
    return { text: HANDOFF_HELP }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Markdown } = $.ui.resolve(e)
    const draft = await read($, draftAtom)
    if (draft === null) return <Text dimColor>No handoff is open. Type /handoff to write one.</Text>
    return (
      <Box flexDirection="column">
        <Text key="relay-pane-title" color={COLORS.gold} bold>{draft.title}</Text>
        <Text key="relay-pane-path" color={COLORS.muted}>{draft.path === '' ? 'Not saved to a file.' : `Saved to ${draft.path}`}</Text>
        <Box key="relay-pane-buttons" flexDirection="row">
          <Button key="relay-clear" label="Clear & continue" variant="primary" onPress={press => safely($, () => clearAndContinue($, press))} />
          <Text> </Text>
          <Button key="relay-copy" label="Copy" onPress={press => safely($, () => copyDraft($, press))} />
          <Text> </Text>
          <Button key="relay-cancel" label="Cancel" onPress={() => safely($, () => cancelDraft($))} />
        </Box>
        <Text> </Text>
        <Markdown key="relay-pane-text" text={draft.text} />
      </Box>
    )
  })

  on('session.measure', async ($, e, next) => {
    await setContext($, e.context)
    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.start', async ($, e, next) => {
    // A main-thread turn runs: no ping or overnight handoff until it ends; and /relay
    // on|off from another session is picked up here.
    const now = await $.clock.now()
    await update($, turnRunningAtom, () => now)
    await syncEnabled($)
    return next(e)
  }).catch(($, e, next) => next(e))

  // Each main-thread request reads (and refreshes) the cache when it is sent, as cache-tax stamps it.
  on('turn.step', async function* ($, e, next) {
    if (e.agentId === undefined) {
      const now = await $.clock.now()
      await update($, lastResponseAtom, () => now)
    }
    return yield* next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) {
      await update($, turnRunningAtom, () => null)
      // A main-thread response (re)writes the prompt cache; an interrupt or API error with no usage does not.
      if (e.reason === 'answer' || e.reason === 'refusal' || e.usage !== undefined) {
        const now = await $.clock.now()
        await update($, lastResponseAtom, () => now)
        ensureTicker($)
        await warmAfterReply($, now)
      } else {
        await armWarmTimer($)
      }
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('session.compact', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId === undefined && e.trigger !== 'precompute' && result.skip === undefined) {
      await resetSession($)
      await update($, coldAtom, () => null)
      await resetWarming($, false)
    }
    return result
  }).catch(($, e, next) => next(e))

  on('classic.SessionStart', async ($, e, next) => {
    if (e.source === 'clear' || e.source === 'compact') {
      await resetSession($)
      await update($, coldAtom, () => null)
      await resetWarming($, e.source === 'clear')
      if (e.source === 'clear') {
        // A fresh window: no cold question, and the offer is worked out again.
        await update($, coldAtom, () => null)
        await update($, offerAtom, () => null)
        if (!(await fillAfterClear($, 'session-start'))) await offerPending($)
      }
    } else if (e.source === 'startup') {
      await offerPending($)
    } else if (e.source === 'resume') {
      if (typeof e.seconds_since_last_response === 'number') {
        const at = (await $.clock.now()) - e.seconds_since_last_response * 1000
        await update($, lastResponseAtom, () => at)
        // The engine's own estimate prices the cold guard while this clock stands.
        const usd = e.estimated_cache_write_usd
        await update($, resumeEstimateAtom, () => (typeof usd === 'number' ? { at, usd } : null))
        // The seeded clock decides whether a restored window pings before the first turn.
        await armWarmTimer($)
      }
      if (typeof e.context_tokens === 'number') {
        const tokens = e.context_tokens
        // Percent from the window the engine reported, never a stale one from before the resume.
        await update($, contextAtom, current => {
          const window = current?.window
          const percent = typeof window === 'number' && window > 0 ? Math.round((tokens / window) * 100) : undefined
          return { tokens, percent, window }
        })
      }
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const below = await next(e)
    if (e.props.hasSurvey) return below
    // No interactive gate: the band is only drawn where a surface draws (never under -p),
    // and desktop/SDK sessions start with surface null and isInteractive false.
    if (!(await read($, enabledAtom))) return below
    ensureTicker($)
    // A hot reload drops the warming timer too; the window is in $.state.
    await armWarmTimer($)

    const [context, lastResponseAt, snoozed, busy, cold, offer, guard, warming] = await Promise.all([
      read($, contextAtom),
      read($, lastResponseAtom),
      read($, snoozedAtom),
      read($, busyAtom),
      read($, coldAtom),
      read($, offerAtom),
      read($, coldGuardAtom),
      read($, warmingAtom),
      // Read only to subscribe: each tick redraws the row so the "left" time moves.
      read($, tickAtom),
    ])
    const now = await $.clock.now()
    const { Box, Text, Button } = $.ui.resolve(e)
    const columns = Math.max(24, e.props.bodyColumns)

    // A waiting handoff from an earlier session: an extra line above Relay's own row.
    const offerRow =
      offer === null ? null : (
        <Box key="relay-offer" flexDirection="row">
          <Box key="relay-offer-text" flexShrink={1}>
            <Text color={COLORS.gold}>{fit(offerText(offer, now), columns - LOAD_WIDTH - DISMISS_WIDTH - 3)}</Text>
          </Box>
          <Box key="relay-offer-spacer" flexGrow={1} />
          <Button key="relay-offer-load" label="Load" variant="primary" onPress={() => safely($, () => loadOffer($))} />
          <Text> </Text>
          <Button key="relay-offer-dismiss" label="Dismiss" onPress={() => safely($, () => dismissOffer($))} />
        </Box>
      )

    const band = (row: RenderElement) => (
      <Box flexDirection="column">
        {below}
        {offerRow}
        {row}
      </Box>
    )

    if (busy) {
      return band(
        <Box key="relay-row" flexDirection="row">
          <Box key="relay-text" flexShrink={1}>
            <Text>
              <Text color={COLORS.gold} bold>{ROW_TITLE}</Text>
              <Text color={COLORS.text}>{'   Writing handoff…'}</Text>
            </Text>
          </Box>
        </Box>,
      )
    }

    if (cold !== null) {
      const room = columns - COLD_WRITE_WIDTH - CANCEL_WIDTH - 3
      return band(
        <Box key="relay-row" flexDirection="row">
          <Box key="relay-text" flexShrink={1}>
            <Text color={COLORS.gold}>{fit(coldHandoffText(cold.tokens, cold.usd), room)}</Text>
          </Box>
          <Box key="relay-spacer" flexGrow={1} />
          <Button key="relay-cold-write" label="Write it anyway" variant="primary" onPress={() => safely($, () => confirmCold($))} />
          <Text> </Text>
          <Button key="relay-cold-cancel" label="Cancel" onPress={() => safely($, () => cancelCold($))} />
        </Box>,
      )
    }

    if (guard !== null) {
      // The cold guard held a typed prompt: both buttons always stay, the text gives way.
      const room = columns - GUARD_HANDOFF_WIDTH - SEND_ANYWAY_WIDTH - 3
      return band(
        <Box key="relay-row" flexDirection="row">
          <Box key="relay-text" flexShrink={1}>
            <Text color={COLORS.gold}>{fit(coldGuardText(now - guard.coldSince, guard.tokens, guard.usd), room)}</Text>
          </Box>
          <Box key="relay-spacer" flexGrow={1} />
          <Button key="relay-guard-handoff" label="Handoff & start fresh" variant="primary" onPress={() => safely($, () => handoffFresh($))} />
          <Text> </Text>
          <Button key="relay-guard-send" label="Send anyway" onPress={() => safely($, () => sendAnyway($))} />
        </Box>,
      )
    }

    const percent = contextPercent(context)
    const isOffered = shouldOfferHandoff({ percent, tokens: context?.tokens, snoozed })

    if (isOffered) {
      // Once snoozed (offered again at 90% / 400k), "Not yet" is gone: the offer stays until handled.
      const room = columns - HANDOFF_NOW_WIDTH - (snoozed ? 0 : NOT_YET_WIDTH + 1) - 2
      return band(
        <Box key="relay-row" flexDirection="row">
          <Box key="relay-text" flexShrink={1}>
            <Text color={COLORS.gold} bold>{fit(thresholdText(context), room)}</Text>
          </Box>
          <Box key="relay-spacer" flexGrow={1} />
          <Button key="relay-handoff-now" label="Handoff now" variant="primary" onPress={() => safely($, () => startHandoff($))} />
          {snoozed ? null : <Text> </Text>}
          {snoozed ? null : <Button key="relay-not-yet" label="Not yet" onPress={() => safely($, () => snooze($))} />}
        </Box>,
      )
    }

    const cache = cacheState(lastResponseAt ?? undefined, now)
    const row = meterRow(context, cache, columns)
    const dotColor = cache.state === 'warm' ? COLORS.green : cache.state === 'cooling' ? COLORS.gold : COLORS.muted
    // Warming comes last: shown only in the room the meter row and the button leave.
    const suffix = warmingSuffix(warming, now)
    const spare = columns - HANDOFF_BUTTON_WIDTH - 2 - meterRowText(row).length
    const warmingText = suffix === undefined || spare < 12 ? undefined : fit(suffix, spare)
    return band(
      <Box key="relay-row" flexDirection="row">
        <Box key="relay-text" flexShrink={1}>
          <Text>
            <Text color={COLORS.gold} bold>{ROW_TITLE}</Text>
            <Text color={COLORS.muted}>{'   ctx '}</Text>
            {row.bar !== undefined ? <Text color={COLORS.gold}>{`${row.bar} `}</Text> : ''}
            <Text color={COLORS.text}>{row.figures}</Text>
            <Text color={COLORS.muted}>{'   cache '}</Text>
            <Text color={dotColor}>{`● ${row.cache}`}</Text>
            {row.left !== undefined ? <Text color={COLORS.muted}>{` · ${row.left}`}</Text> : ''}
          </Text>
        </Box>
        {warmingText !== undefined ? (
          <Box key="relay-warming" flexShrink={1}>
            <Text color={COLORS.muted}>{warmingText}</Text>
          </Box>
        ) : null}
        <Box key="relay-spacer" flexGrow={1} />
        <Button key="relay-handoff" label="Handoff" onPress={() => safely($, () => startHandoff($))} />
      </Box>,
    )
  }).catch(($, e, next) => next(e))
}

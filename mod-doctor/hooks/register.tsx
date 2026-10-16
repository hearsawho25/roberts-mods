import { atom, read, update } from 'claude-code'
import type { CommandInfo, EngineInterface, ProcessRunResult, Register, RenderSurface, Timer } from 'claude-code'

import {
  commandOwners,
  diagnose,
  hasHooksModule,
  hhmm,
  isInlineProvenance,
  mergeLoaded,
  paneLines,
  parsePluginList,
  parseValidate,
  reportText,
  rowText,
  toastKey,
  toastText,
} from './core'
import type { ExpectedEntry, Report, Tone, Validation } from './core'

/**
 * Mod Doctor: did every enabled mod's hooks module load? The loaded set comes from
 * engine.create and plugin.register; the expected set from `claude plugin list --json`
 * and each mod's hooks/hooks.json; the reasons from `claude plugin validate`.
 * Pure logic lives in core.ts; this file holds every hook, every function that takes
 * `$` and every atom. See docs/DESIGN.md.
 */

type Engine = EngineInterface

/** Robert's Toolbox palette, plus red for failures. */
const COLORS = {
  gold: '#F2C46D',
  green: '#3DD68C',
  muted: '#7D8590',
  red: '#F85149',
  text: '#E6EDF3',
} as const

const TONE_COLORS: Record<Tone, string> = { ok: COLORS.green, bad: COLORS.red, warn: COLORS.gold, muted: COLORS.muted }

const PANE = 'mod-doctor'
const PANE_TITLE = 'Mod Doctor'
const CHECKING = 'checking…'

const loadedAtom = atom({ plugin: 'mod-doctor', key: 'loaded' } as const, [])
const inlineAtom = atom({ plugin: 'mod-doctor', key: 'inline' } as const, [])
const reportAtom = atom({ plugin: 'mod-doctor', key: 'report' } as const, null)
const checkingAtom = atom({ plugin: 'mod-doctor', key: 'checking' } as const, false)
const toastedAtom = atom({ plugin: 'mod-doctor', key: 'toasted' } as const, [])
const paneOpenAtom = atom({ plugin: 'mod-doctor', key: 'paneOpen' } as const, false)

/** Each `claude` call may take this long before it counts as failed. */
const CLAUDE_TIMEOUT_MS = 30_000
/** A `/reload-plugins` that reloads several mods causes one check. */
const REGISTER_DEBOUNCE_MS = 2_000
/** How many `claude plugin validate` runs go at once. */
const VALIDATE_AT_ONCE = 4
/** A whole check still running after this counts as hung: `check timed out`. */
const CHECK_WATCHDOG_MS = CLAUDE_TIMEOUT_MS * 3

/** What the module keeps between events; a hot reload starts it over (the report is in $.state). */
const runtime = {
  /** engine.create's list, held until session.start can write it (`$` is still being built there). */
  pendingCreate: [] as readonly string[],
  /** Whether a check is running now. */
  isRunning: false,
  /** A check was asked for while one ran: run once more when it ends. */
  isAgain: false,
  /** Whether that follow-up validates every checked mod. */
  isAgainFull: false,
  /** The pending check after a plugin.register, if any. */
  debounce: null as Timer | null,
  /** The check whose results may still be written; a hung one outlived by its watchdog writes nothing. */
  checkId: 0,
}

/** One `claude` command's result, or undefined when it could not start or timed out. */
async function runClaude($: Engine, args: readonly string[], timeoutMs: number): Promise<ProcessRunResult | undefined> {
  try {
    return await $.process.run(['claude', ...args], { timeoutMs })
  } catch {
    return undefined
  }
}

async function now($: Engine): Promise<number> {
  try {
    return await $.clock.now()
  } catch {
    return 0
  }
}

/** Whether a plugin's hooks/hooks.json names a hooks module; a missing or unreadable file does not. */
async function hasModule($: Engine, folder: string): Promise<boolean> {
  try {
    // `/` joins on Windows too.
    const text = await $.fs.read(`${folder.replace(/[\\/]+$/, '')}/hooks/hooks.json`)
    return typeof text === 'string' && hasHooksModule(text)
  } catch {
    return false
  }
}

async function validateOne($: Engine, entry: ExpectedEntry): Promise<Validation> {
  const result = await runClaude($, ['plugin', 'validate', entry.folder], CLAUDE_TIMEOUT_MS)
  if (result === undefined) return { ok: null, reason: 'timed out or could not start' }
  if (result.exitCode === 0) return { ok: true }
  const errors = parseValidate(`${result.stdout}\n${result.stderr}`, entry.folder)
  return { ok: false, errors: errors.length > 0 ? errors : [`validate failed (exit ${result.exitCode})`] }
}

/** Validates each target, VALIDATE_AT_ONCE at a time; keyed by mod name. */
async function validateAll($: Engine, targets: readonly ExpectedEntry[]): Promise<Record<string, Validation>> {
  const out: Record<string, Validation> = {}
  let next = 0
  const worker = async () => {
    while (next < targets.length) {
      const entry = targets[next++]!
      out[entry.name] = await validateOne($, entry)
    }
  }
  await Promise.all(Array.from({ length: Math.min(VALIDATE_AT_ONCE, targets.length) }, worker))
  return out
}

/** Each plugin's slash commands, without a leading `<plugin>:`; empty when the engine cannot list them. */
/** The session's commands; none when the list cannot be read. */
async function commandList($: Engine): Promise<CommandInfo[]> {
  try {
    return await $.command.list()
  } catch {
    return []
  }
}

function commandsByPlugin(list: readonly CommandInfo[]): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  for (const c of list) {
    if (c.plugin === undefined) continue
    const prefix = `${c.plugin}:`
    const name = c.name.startsWith(prefix) ? c.name.slice(prefix.length) : c.name
    ;(out[c.plugin] ??= []).push(name)
  }
  return out
}

/** A check that could not run: `couldn't check: <error>`, no mods, so no row and no toast. */
async function writeError($: Engine, error: string) {
  const inline = await read($, inlineAtom)
  const report: Report = { checkedAt: await now($), mods: [], inline: [...inline], skipped: 0, error }
  await update($, reportAtom, () => report)
}

/** One toast per mod, status and first reason per session; raised only once the check's validates are done. */
async function toastProblems($: Engine, report: Report) {
  const toasted = await read($, toastedAtom)
  const seen = new Set(toasted)
  const fresh = report.mods.filter(m => m.status !== 'loaded' && !seen.has(toastKey(m)))
  if (fresh.length === 0) return
  await update($, toastedAtom, prev => [...new Set([...prev, ...fresh.map(toastKey)])])
  for (const m of fresh) {
    try {
      $.ui.toast(toastText(m))
    } catch {
      // The report and the row still show it.
    }
  }
}

/**
 * One check, start to finish. `full` validates every checked mod, not only the missing ones.
 * Writes nothing once check `id` is no longer the current one (its watchdog gave up on it).
 */
async function checkOnce($: Engine, full: boolean, id: number) {
  const isCurrent = () => runtime.checkId === id
  const fail = async (error: string) => {
    if (isCurrent()) await writeError($, error)
  }
  const list = await runClaude($, ['plugin', 'list', '--json'], CLAUDE_TIMEOUT_MS)
  if (list === undefined) return fail('claude CLI not found')
  if (list.exitCode !== 0) return fail(`plugin list failed (exit ${list.exitCode})`)
  let expected: ExpectedEntry[]
  try {
    expected = parsePluginList(list.stdout)
  } catch {
    return fail('plugin list output not understood')
  }
  const isHooked = await Promise.all(expected.map(entry => hasModule($, entry.folder)))
  const checked = expected.filter((_, i) => isHooked[i] === true)
  // A /reload-plugins newcomer raises no plugin.register here: its own bare commands say it runs.
  const commandInfo = await commandList($)
  const loaded = await update($, loadedAtom, prev => mergeLoaded(prev, commandOwners(commandInfo)))
  const isLoaded = new Set(loaded)
  const validations = await validateAll(
    $,
    checked.filter(entry => full || !isLoaded.has(entry.name)),
  )
  const commands = commandsByPlugin(commandInfo)
  const inline = await read($, inlineAtom)
  const report = diagnose({
    expected: checked,
    loaded,
    validations,
    commands,
    inline,
    skipped: expected.length - checked.length,
    checkedAt: await now($),
  })
  if (!isCurrent()) return
  await update($, reportAtom, () => report)
  await toastProblems($, report)
}

/** checkOnce, given up on after CHECK_WATCHDOG_MS (`check timed out`): a hung call never wedges the single flight. */
async function checkWithWatchdog($: Engine, full: boolean) {
  const id = ++runtime.checkId
  let fire = () => {}
  const watchdog = new Promise<'timed out'>(resolve => {
    fire = () => resolve('timed out')
  })
  let timer: Timer | null = null
  try {
    timer = $.clock.after(CHECK_WATCHDOG_MS, () => fire())
  } catch {
    timer = null
  }
  try {
    const outcome = await Promise.race([checkOnce($, full, id).then(() => 'done' as const), watchdog])
    if (outcome === 'timed out') {
      // The hung check may still settle later: it is no longer current, so it writes nothing.
      runtime.checkId++
      await writeError($, 'check timed out')
    }
  } finally {
    timer?.cancel()
  }
}

/**
 * Runs a check; never rejects. Single flight: one asked for while one runs sets a
 * single follow-up (full when any asker wanted full), run when the current one ends.
 */
async function runCheck($: Engine, options: { full: boolean }): Promise<void> {
  if (runtime.isRunning) {
    runtime.isAgain = true
    runtime.isAgainFull ||= options.full
    return
  }
  runtime.isRunning = true
  let full = options.full
  try {
    await update($, checkingAtom, () => true)
    for (;;) {
      runtime.isAgain = false
      runtime.isAgainFull = false
      try {
        await checkWithWatchdog($, full)
      } catch (err) {
        await writeError($, err instanceof Error ? err.message : String(err)).catch(() => undefined)
      }
      if (!runtime.isAgain) break
      full = runtime.isAgainFull
    }
  } finally {
    runtime.isRunning = false
    await update($, checkingAtom, () => false).catch(() => undefined)
  }
}

/** A check REGISTER_DEBOUNCE_MS after the last plugin.register; no clock, no check. */
function scheduleCheck($: Engine) {
  runtime.debounce?.cancel()
  runtime.debounce = null
  try {
    runtime.debounce = $.clock.after(REGISTER_DEBOUNCE_MS, () => {
      runtime.debounce = null
      void runCheck($, { full: false }).catch(() => undefined)
    })
  } catch {
    runtime.debounce = null
  }
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** Runs a button's work; a rejection becomes a toast instead of an unhandled error. */
async function safely($: Engine, work: () => Promise<unknown>) {
  try {
    await work()
  } catch (err) {
    $.ui.toast(`Mod Doctor: ${errorText(err)}`)
  }
}

/** Opens the pane, then checks again beside it (never held on the check). */
async function openPane($: Engine) {
  await update($, paneOpenAtom, () => true)
  try {
    const opened = await $.ui.open({ id: PANE, title: PANE_TITLE })
    if (!opened.isPlaced) $.ui.toast('Widen the window to see the Mod Doctor pane.')
  } catch (err) {
    await update($, paneOpenAtom, () => false)
    $.ui.toast(`Mod Doctor: the pane could not open — ${errorText(err)}`)
    return
  }
  void runCheck($, { full: false }).catch(() => undefined)
}

/** Re-check: validates every checked mod. Pressed while a check runs, it queues a full follow-up (drawn dim only as a hint). */
async function recheck($: Engine) {
  await runCheck($, { full: true })
}

/** Copy report: the pane as plain text on the clipboard of the surface pressed on. */
async function copyReport($: Engine, surface: RenderSurface) {
  const report = await read($, reportAtom)
  if (report === null) return
  const copied = await $.ui.copy({ text: reportText(report, hhmm(report.checkedAt)), surface })
  $.ui.toast(copied.isCopied ? 'Mod Doctor report copied' : `Mod Doctor: could not copy the report (${copied.reason})`)
}

async function closePane($: Engine) {
  await update($, paneOpenAtom, () => false)
  try {
    await $.ui.close({ id: PANE })
  } catch {
    // Already closed.
  }
}

/** Whether the pane is open, by the engine's own list of this plugin's panes (the atom when it cannot say). */
async function isPaneOpen($: Engine): Promise<boolean> {
  try {
    return (await $.ui.panes()).some(pane => pane.id === PANE)
  } catch {
    return read($, paneOpenAtom)
  }
}

/** The row's Open/Close, decided from the engine's own list of open panes. */
async function togglePane($: Engine) {
  if (await isPaneOpen($)) await closePane($)
  else await openPane($)
}

export const register: Register = on => {
  // `$` is still being built here: only note the list; session.start writes it.
  on('engine.create', async ($, e, next) => {
    const built = await next(e)
    runtime.pendingCreate = [...e.plugins]
    return built
  })

  // Mod Doctor never refuses a mod: whatever happens here, the module joins.
  on('plugin.register', async ($, e, next) => {
    const result = await next(e)
    if (result.allow === true) {
      await update($, loadedAtom, prev => mergeLoaded(prev, [e.name]))
      if (isInlineProvenance(e.name, e.provenance)) {
        await update($, inlineAtom, prev => (prev.includes(e.name) ? prev : [...prev, e.name].sort()))
      }
      scheduleCheck($)
    }
    return result
  }).catch(($, e, next) => next(e))

  on('session.start', async ($, e, next) => {
    const result = await next(e)
    // /mod-doctor first: Robert's Toolbox runs a mod's first registered command.
    try {
      await $.command.register({ name: 'mod-doctor', description: "Show which mods loaded and why any didn't" })
    } catch {
      // The row and the toast still show a problem.
    }
    const created = runtime.pendingCreate
    await update($, loadedAtom, prev => mergeLoaded(prev, created))
    // The first load's plugin.register calls armed a debounced check: this one covers them.
    runtime.debounce?.cancel()
    runtime.debounce = null
    // No hook waits on a check.
    void runCheck($, { full: false }).catch(() => undefined)
    return result
  }).catch(($, e, next) => next(e))

  // The person's own close (the pane's mark or key) keeps the row's button in step.
  on('ui.close', { id: PANE }, async ($, e, next) => {
    const result = await next(e)
    await update($, paneOpenAtom, () => false)
    return result
  }).catch(($, e, next) => next(e))

  // /reload-plugins tells a plugin already loaded nothing about the mods it loads (probed
  // 2026-10-15), so check again once it has finished. It always runs: Mod Doctor only watches.
  on('command.run', { command: 'reload-plugins' }, async ($, e, next) => {
    const result = await next(e)
    scheduleCheck($)
    return result
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'mod-doctor' }, async $ => {
    await safely($, () => openPane($))
    return {}
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    // A drawing that throws would drop the pane (an unload close): a dim line instead.
    try {
      const [report, checking] = await Promise.all([read($, reportAtom), read($, checkingAtom)])
      const lines = report === null ? [] : paneLines(report, hhmm(report.checkedAt), e.props.bodyColumns > 0 ? e.props.bodyColumns : undefined)
      return (
        <Box flexDirection="column">
          {report === null ? (
            <Box key="mod-doctor-waiting">
              <Text color={COLORS.muted}>{CHECKING}</Text>
            </Box>
          ) : null}
          {/* Each line sits in a keyed Box: a Text keeps no key of its own. */}
          {lines.map((line, i) => (
            <Box key={`mod-doctor-line-${i}`}>
              <Text color={TONE_COLORS[line.tone]}>{i === 0 && checking ? `${line.text} · ${CHECKING}` : line.text}</Text>
            </Box>
          ))}
          {/* Wraps onto more rows in a narrow pane; each button keeps its label whole. */}
          <Box key="mod-doctor-buttons" flexDirection="row" flexWrap="wrap" columnGap={1}>
            <Box key="mod-doctor-cell-recheck" flexShrink={0}>
              <Button key="mod-doctor-recheck" label="Re-check" dimColor={checking} onPress={() => safely($, () => recheck($))} />
            </Box>
            <Box key="mod-doctor-cell-copy" flexShrink={0}>
              <Button
                key="mod-doctor-copy"
                label="Copy report"
                dimColor={report === null}
                onPress={press => safely($, () => copyReport($, press.surface))}
              />
            </Box>
            <Box key="mod-doctor-cell-close" flexShrink={0}>
              <Button key="mod-doctor-close" label="Close" onPress={() => safely($, () => closePane($))} />
            </Box>
          </Box>
        </Box>
      )
    } catch (err) {
      return <Text dimColor>{`Mod Doctor could not draw: ${errorText(err)}`}</Text>
    }
  })

  // Shares the band: always next's rows first, then Mod Doctor's, only when a mod didn't load.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const below = await next(e)
    if (e.props.hasSurvey) return below
    const report = await read($, reportAtom)
    const text = report === null ? null : rowText(report)
    if (text === null) return below
    // The atom, not $.ui.panes(): reading it subscribes the band, so an open or close redraws the label.
    const isOpen = await read($, paneOpenAtom)
    const { Box, Text, Button } = $.ui.resolve(e)
    return (
      <Box flexDirection="column">
        {below}
        <Box key="mod-doctor-row" flexDirection="row">
          <Box key="mod-doctor-text" flexShrink={1}>
            <Text color={COLORS.red} bold>{text}</Text>
          </Box>
          <Box key="mod-doctor-spacer" flexGrow={1} />
          <Button key="mod-doctor-toggle" label={isOpen ? 'Close' : 'Open'} onPress={() => safely($, () => togglePane($))} />
        </Box>
      </Box>
    )
  }).catch(($, e, next) => next(e))
}

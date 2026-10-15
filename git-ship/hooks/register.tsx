import { atom, read, update } from 'claude-code'
import type { EngineInterface, ModelCompleteResult, ProcessRunResult, Register, Timer } from 'claude-code'

import {
  branchCommand,
  buttonStates,
  capDiff,
  commandHeadline,
  commandLabel,
  COMMIT_TRAILER,
  commitCommand,
  commitDraftPrompt,
  gitBashFromExecPath,
  interceptedCommand,
  isWindowsPath,
  isWslBash,
  newFilesText,
  parseDefaultBranch,
  parseDraft,
  parsePrView,
  parseStatus,
  PR_FOOTER,
  prCreateCommand,
  prDraftPrompt,
  prViewCommand,
  pullCommand,
  pushCommand,
  rowText,
  runOutput,
  runStatusText,
  stageCommand,
  withTrailer,
} from './core'
import type { ButtonId, RepoState } from './core'
import type { GitShipRunning } from '../types'

/**
 * Git Ship: a repo-status row above the prompt, the `/ship` pane, and buttons that
 * fill ready-to-run `!git …` / `!gh …` commands into the prompt box (never sent).
 * Pure logic lives in core.ts; this file holds every hook, every function that
 * takes `$` and every atom (the validator follows `$` and atoms only within the
 * file that holds the hooks).
 */

type Engine = EngineInterface

/** Robert's Toolbox palette. */
const COLORS = {
  green: '#3DD68C',
  muted: '#7D8590',
  red: '#F85149',
  text: '#E6EDF3',
} as const

const repoAtom = atom({ plugin: 'git-ship', key: 'repo' } as const, null)
const paneOpenAtom = atom({ plugin: 'git-ship', key: 'paneOpen' } as const, false)
const draftingAtom = atom({ plugin: 'git-ship', key: 'drafting' } as const, false)
const hasOpenPrAtom = atom({ plugin: 'git-ship', key: 'hasOpenPr' } as const, null)
const runningAtom = atom({ plugin: 'git-ship', key: 'running' } as const, null)
const lastRunAtom = atom({ plugin: 'git-ship', key: 'lastRun' } as const, null)

const PANE = 'git-ship'
const ROW_TITLE = '◆ Ship'
const GIT_TIMEOUT_MS = 5_000
/** The second read after a `!` command, for one still running when its prompt was handled. */
const SHELL_BACKSTOP_MS = 1_500
/** gh never asks a question or checks for updates: it runs unattended. */
const GH_ENV = { GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1' }
const MAX_FILES = 10
const CONFLICT_TEXT = 'resolve conflicts, then git add <file> yourself'
const DRAFT_FAILED = 'Git Ship: the draft failed — fill in the message yourself.'
const DIFF_UNREAD = 'Git Ship: could not read the diff — fill in the message yourself.'
const NOTHING_STAGED = ' Nothing is staged yet.'
/** Untracked names listed for a draft of everything (git diff leaves them out). */
const MAX_UNTRACKED = 20
/** New files whose text a commit draft reads; the rest it names only. */
const MAX_NEW_FILES = 30
/** Drafts are a cheap, standalone completion over the diff. */
const DRAFT_MODEL = 'sonnet'
const DRAFT_MAX_TOKENS = 1024
/** A draft still running after this resolves `aborted`: the failure path. */
const DRAFT_TIMEOUT_MS = 60_000
/** `git diff` for a draft: plain text whatever the config (no colour, no external differ), paths as written. */
const DIFF_ARGS = ['-c', 'core.quotePath=false', 'diff', '--no-color', '--no-ext-diff'] as const
/** How long after a drop the box is checked for the line that ran. */
const CLEAR_AFTER_MS = 300
/** A line Git Ship runs when Robert presses Enter on it may take this long. */
const SHELL_TIMEOUT_MS = 300_000
/** The run slot frees itself this long after a run started, whatever became of it. */
const RUN_WATCHDOG_MS = SHELL_TIMEOUT_MS + 10_000
/** One more read this long after a run that did not finish (it may still be running). */
const UNFINISHED_REREAD_MS = 30_000
/** Nothing a run starts may stop to ask for input or open an editor: there is no terminal to answer it. */
const SHELL_ENV = { GIT_TERMINAL_PROMPT: '0', GH_PROMPT_DISABLED: '1', GIT_EDITOR: 'false', GIT_SEQUENCE_EDITOR: 'false' }
/**
 * The script every run gets. The line itself travels in GIT_SHIP_COMMAND, never in argv: on
 * Windows argv is flattened into one command line that MSYS parses again, collapsing
 * backslashes and running a quoted `\$(…)`.
 */
const SHELL_SCRIPT = 'eval "$GIT_SHIP_COMMAND"'
const NO_GIT_BASH = 'Git Ship: could not find Git Bash — run it yourself.'
const COULD_NOT_RUN = 'Git Ship could not run it — nothing was sent'
const COULD_NOT_READ = 'Git Ship: could not read git here — nothing was sent'
/** How long an intercepted line waits for a git read, well inside the hook's 10 s budget. */
const LINE_READ_WAIT_MS = 6_000

/** The pane's buttons, in order. */
const BUTTONS: ReadonlyArray<{ id: ButtonId; label: string }> = [
  { id: 'stage', label: 'Stage all' },
  { id: 'commit', label: 'Draft commit' },
  { id: 'push', label: 'Push' },
  { id: 'pull', label: 'Pull' },
  { id: 'branch', label: 'New branch' },
  { id: 'pr', label: 'PR' },
  { id: 'close', label: 'Close' },
]

/** What the module keeps between events; a hot reload starts it over (everything drawn is in $.state). */
const runtime = {
  /** The refresh running now, if any. */
  running: null as Promise<void> | null,
  /** The one refresh queued behind it, if any: every caller meanwhile shares it. */
  queued: null as Promise<void> | null,
  /** Each root's default branch, worked out once. */
  bases: new Map<string, { name: string; ref: string }>(),
  /** Git Bash's path, found once a session (a failed search is tried again next line). */
  bashPath: null as string | null,
  /** The last run token handed out: each run is told apart by its own, never by its command. */
  runToken: 0,
  /** The tokens of the runs this load has going. */
  activeRuns: new Set<number>(),
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** The session root, or undefined when the engine cannot say. */
async function sessionRoot($: Engine): Promise<string | undefined> {
  try {
    return await $.session.root()
  } catch {
    return undefined
  }
}

/** One command's result, or undefined when it could not start or timed out (git's 5 s unless told otherwise). */
async function run(
  $: Engine,
  root: string,
  argv: readonly string[],
  env?: Record<string, string>,
  timeoutMs: number = GIT_TIMEOUT_MS,
): Promise<ProcessRunResult | undefined> {
  try {
    return await $.process.run(argv, { cwd: root, timeoutMs, ...(env !== undefined ? { env } : {}) })
  } catch {
    return undefined
  }
}

/** One read-only git command's stdout, or undefined when it failed or could not start. */
async function git($: Engine, root: string, args: readonly string[]): Promise<string | undefined> {
  const result = await run($, root, ['git', ...args])
  return result?.exitCode === 0 ? result.stdout : undefined
}

/**
 * origin/HEAD's branch, else `main` or `master` when it exists locally, else `main`; and the
 * ref a PR is drafted against: `origin/<name>` when origin/HEAD named it, else the local name.
 * Cached per root only when every probe ran: a timed-out one is asked again next read.
 */
async function defaultBranch($: Engine, root: string): Promise<{ name: string; ref: string }> {
  const cached = runtime.bases.get(root)
  if (cached !== undefined) return cached
  const head = await run($, root, ['git', 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])
  let isComplete = head !== undefined
  const remote = head?.exitCode === 0 ? parseDefaultBranch(head.stdout) : null
  let base = remote
  for (const name of ['main', 'master']) {
    if (base !== null) break
    const probe = await run($, root, ['git', 'rev-parse', '--verify', '--quiet', `refs/heads/${name}`])
    if (probe === undefined) isComplete = false
    else if (probe.exitCode === 0) base = name
  }
  const found = remote !== null ? { name: remote, ref: `origin/${remote}` } : { name: base ?? 'main', ref: base ?? 'main' }
  if (isComplete) runtime.bases.set(root, found)
  return found
}

/** Reads the repo with read-only git only: null outside a repo, 'error' when git cannot run. */
async function readRepo($: Engine): Promise<RepoState | null | 'error'> {
  const root = await sessionRoot($)
  if (root === undefined) return null
  const top = await run($, root, ['git', 'rev-parse', '--show-toplevel'])
  if (top === undefined) return 'error'
  if (top.exitCode !== 0) return null
  // quotePath off: non-ASCII paths come back as written, not octal-escaped.
  const [statusOut, log, base] = await Promise.all([
    run($, root, ['git', '-c', 'core.quotePath=false', '--no-optional-locks', 'status', '--porcelain=v2', '--branch']),
    git($, root, ['log', '-1', '--format=%h %s']),
    defaultBranch($, root),
  ])
  if (statusOut === undefined || statusOut.exitCode !== 0) return 'error'
  const lastCommit = (log ?? '').trim()
  return {
    ...parseStatus(statusOut.stdout),
    root: top.stdout.trim() || root,
    lastCommit: lastCommit === '' ? null : lastCommit,
    defaultBranch: base.name,
    baseRef: base.ref,
  }
}

/** The branch a read names, for telling a switch apart; undefined outside a repo or on an error. */
function branchOf(repo: RepoState | null | 'error'): string | null | undefined {
  return repo === null || repo === 'error' ? undefined : repo.branch
}

/** readRepo, or 'error' once the watchdog fires: a hung run never wedges the coalescer. */
async function readWithWatchdog($: Engine): Promise<RepoState | null | 'error'> {
  let fire = () => {}
  const watchdog = new Promise<'error'>(resolve => {
    fire = () => resolve('error')
  })
  let timer: Timer | null = null
  try {
    timer = $.clock.after(GIT_TIMEOUT_MS * 5, () => fire())
  } catch {
    timer = null
  }
  try {
    return await Promise.race([readRepo($), watchdog])
  } catch {
    return 'error'
  } finally {
    timer?.cancel()
  }
}

/** One refresh, start to finish; never rejects. A branch switch drops the PR answer (checked again while the pane is open). */
function startRefresh($: Engine): Promise<void> {
  const current = (async () => {
    const previous = await read($, repoAtom)
    const repo = await readWithWatchdog($)
    await update($, repoAtom, () => repo)
    if (branchOf(previous) !== branchOf(repo)) {
      await update($, hasOpenPrAtom, () => null)
      if (await read($, paneOpenAtom)) void checkPr($).catch(() => undefined)
    }
  })()
    .catch(() => undefined)
    .finally(() => {
      if (runtime.running === current) runtime.running = null
    })
  runtime.running = current
  return current
}

/**
 * Re-reads git state. Coalesced: while one runs, one more is queued (never several),
 * and every caller meanwhile resolves once that queued one has read.
 */
function refresh($: Engine): Promise<void> {
  if (runtime.queued !== null) return runtime.queued
  const running = runtime.running
  if (running === null) return startRefresh($)
  const queued = running.then(() => {
    runtime.queued = null
    return startRefresh($)
  })
  runtime.queued = queued
  return queued
}

/** Pane open only: whether the branch has an open PR (skipped where the PR button is off anyway). */
async function checkPr($: Engine) {
  const repo = await read($, repoAtom)
  if (repo === null || repo === 'error' || !buttonStates(repo, { drafting: false, hasOpenPr: null }).pr) {
    await update($, hasOpenPrAtom, () => null)
    return
  }
  const result = await run($, repo.root, ['gh', 'pr', 'view', '--json', 'number,state'], GH_ENV)
  const isOpen = result?.exitCode === 0 ? parsePrView(result.stdout) : false
  // An answer for a branch since switched away from is stale: the switch's own check stands.
  if (branchOf(await read($, repoAtom)) !== repo.branch) return
  await update($, hasOpenPrAtom, () => isOpen)
}

async function openPane($: Engine) {
  await update($, paneOpenAtom, () => true)
  try {
    const opened = await $.ui.open({ id: PANE, title: 'Git Ship' })
    if (!opened.isPlaced) $.ui.toast('Widen the window to see the Git Ship pane.')
  } catch (err) {
    await update($, paneOpenAtom, () => false)
    $.ui.toast(`Git Ship: the pane could not open — ${errorText(err)}`)
    return
  }
  // Never held on git: the pane draws now and fills in as the read lands.
  void refresh($)
    .then(() => checkPr($))
    .catch(() => undefined)
}

async function closePane($: Engine) {
  await update($, paneOpenAtom, () => false)
  try {
    await $.ui.close({ id: PANE })
  } catch {
    // Already closed.
  }
}

/** The row's Open/Close and `/ship`, decided from the engine's own list of open panes. */
async function togglePane($: Engine) {
  let isOpen: boolean
  try {
    isOpen = (await $.ui.panes()).some(pane => pane.id === PANE)
  } catch {
    isOpen = await read($, paneOpenAtom)
  }
  if (isOpen) await closePane($)
  else await openPane($)
}

/** A `!` command may still be running when its prompt is handled: one more read shortly after. */
function refreshAfterShell($: Engine) {
  void refresh($).catch(() => undefined)
  try {
    $.clock.after(SHELL_BACKSTOP_MS, () => {
      void refresh($).catch(() => undefined)
    })
  } catch {
    // No clock: the first read stands.
  }
}

/** Puts a command in the prompt box over the draft (never sent); a refused fill is toasted so the command is still seen. */
async function fill($: Engine, text: string) {
  let isFilled = false
  try {
    isFilled = (await $.prompt.fill({ text, mode: 'replace' })).isFilled
  } catch {
    isFilled = false
  }
  if (!isFilled) $.ui.toast(`Git Ship: could not fill the prompt box — ${text}`)
}

/** Claims the one drafting slot: false when a draft is already running. */
async function startDrafting($: Engine): Promise<boolean> {
  let wasDrafting = true
  // update may run the change again on a write miss: the last run is the one written.
  await update($, draftingAtom, drafting => {
    wasDrafting = drafting
    return true
  })
  return !wasDrafting
}

/**
 * One standalone completion over the diff alone (`$.model.complete`, not a fork): it works
 * in a new session or after `/clear`, sends no transcript, and never joins the main
 * conversation. Its subject and body, or undefined when it was not answered, threw, gave
 * no subject, or ran past DRAFT_TIMEOUT_MS (it resolves `aborted`).
 */
async function completeDraft($: Engine, prompt: string): Promise<{ subject: string; body: string } | undefined> {
  let result: ModelCompleteResult
  try {
    result = await $.model.complete({ model: DRAFT_MODEL, prompt, maxTokens: DRAFT_MAX_TOKENS, effort: 'low', timeoutMs: DRAFT_TIMEOUT_MS })
  } catch {
    return undefined
  }
  if (!result.isAnswered) return undefined
  const draft = parseDraft(result.text)
  return draft.subject === '' ? undefined : draft
}

/**
 * A failed commit draft: a bare `git commit -m ""` (never `git add -A &&`, so nothing is
 * staged on a draft that did not happen) and a toast, saying so when nothing is staged yet.
 */
async function commitDraftFailed($: Engine, toast: string, stageFirst: boolean) {
  await fill($, commitCommand('', '', false))
  $.ui.toast(stageFirst ? `${toast}${NOTHING_STAGED}` : toast)
}

/** Draft commit for the repo pressButton checked: a message drafted from the staged diff (or everything, staged first), filled into the prompt box. */
/** Every untracked, not-ignored file, one per path; status's own `??` entries when ls-files fails. */
async function untrackedFiles($: Engine, repo: RepoState): Promise<string[]> {
  const listed = await git($, repo.root, ['-c', 'core.quotePath=false', 'ls-files', '--others', '--exclude-standard'])
  if (listed === undefined) return repo.files.filter(file => file.xy === '??').map(file => file.path)
  return listed.split(/\r?\n/).filter(line => line.trim() !== '')
}

/** The first MAX_NEW_FILES new files' text for the draft; one that cannot be read is named only. */
async function readNewFiles($: Engine, root: string, paths: readonly string[]): Promise<string> {
  const files = await Promise.all(
    paths.slice(0, MAX_NEW_FILES).map(async path => {
      try {
        // git lists paths with `/`; join them in the root's own separator.
        const sep = root.includes('\\') ? '\\' : '/'
        const content = await $.fs.read(`${root}${sep}${path.split('/').join(sep)}`)
        return { path, text: typeof content === 'string' ? content : undefined }
      } catch {
        return { path, text: undefined }
      }
    }),
  )
  return newFilesText(files)
}

async function draftCommit($: Engine, repo: RepoState) {
  if (!(await startDrafting($))) return
  const stageFirst = repo.staged === 0
  try {
    const cached = stageFirst ? [] : ['--cached']
    const [diff, stat, subjects] = await Promise.all([
      git($, repo.root, [...DIFF_ARGS, ...cached]),
      git($, repo.root, [...DIFF_ARGS, ...cached, '--stat']),
      git($, repo.root, ['log', '-5', '--format=%s']),
    ])
    // Untracked files join the commit only when it stages everything first. Status shows a new
    // folder as one entry, so the draft lists and reads the files inside it.
    const untracked = stageFirst ? await untrackedFiles($, repo) : []
    // Never draft from nothing: an unread diff, or nothing at all to describe.
    if (diff === undefined || stat === undefined || (diff.trim() === '' && stat.trim() === '' && untracked.length === 0)) {
      return await commitDraftFailed($, DIFF_UNREAD, stageFirst)
    }
    let statText = stat.trimEnd()
    if (untracked.length > 0) {
      const names = untracked.slice(0, MAX_UNTRACKED).join(', ')
      const more = untracked.length > MAX_UNTRACKED ? `, +${untracked.length - MAX_UNTRACKED} more` : ''
      const line = `Untracked files: ${names}${more}`
      statText = statText === '' ? line : `${statText}\n${line}`
    }
    const added = untracked.length === 0 ? '' : await readNewFiles($, repo.root, untracked)
    const prompt = commitDraftPrompt({
      diff: capDiff(added === '' ? diff : `${diff.trimEnd()}\n\n${added}`.trimStart()).text,
      stat: statText,
      recentSubjects: (subjects ?? '').split(/\r?\n/).filter(line => line.trim() !== ''),
    })
    const draft = await completeDraft($, prompt)
    if (draft === undefined) return await commitDraftFailed($, DRAFT_FAILED, stageFirst)
    await fill($, commitCommand(draft.subject, withTrailer(draft.body, COMMIT_TRAILER), stageFirst))
  } finally {
    await update($, draftingAtom, () => false)
  }
}

/** PR for the repo pressButton checked: a title and body drafted from the branch's commits since its base, filled into the prompt box. */
async function draftPr($: Engine, repo: RepoState) {
  if (!(await startDrafting($))) return
  try {
    // origin/<base> when origin/HEAD named it: a stale local base would list commits already merged.
    const base = repo.baseRef
    const [log, stat] = await Promise.all([
      git($, repo.root, ['log', `${base}..HEAD`, '--format=%s%n%n%b%n---']),
      git($, repo.root, [...DIFF_ARGS, '--stat', `${base}...HEAD`]),
    ])
    // Never draft from nothing: no commits to describe, or a log that could not be read.
    if (log === undefined || log.trim() === '') {
      await fill($, prCreateCommand('', ''))
      $.ui.toast(`Git Ship: no commits since ${base} to draft from.`)
      return
    }
    const prompt = prDraftPrompt({ log: log.trimEnd(), stat: (stat ?? '').trimEnd(), branch: repo.branch ?? 'HEAD', base })
    const draft = await completeDraft($, prompt)
    if (draft === undefined) {
      await fill($, prCreateCommand('', ''))
      $.ui.toast(DRAFT_FAILED)
      return
    }
    await fill($, prCreateCommand(draft.subject, withTrailer(draft.body, PR_FOOTER)))
  } finally {
    await update($, draftingAtom, () => false)
  }
}

/**
 * Git Bash: CLAUDE_CODE_GIT_BASH_PATH when set, else derived from `git --exec-path` on
 * Windows (OS says so, or the repo sits on a drive letter), else plain `bash`. Never a bare
 * `bash` on Windows, and never WSL's (System32 or WindowsApps); on Windows the env var must be
 * absolute (a drive letter or `\\`). A path found is checked once (`-c 'exit 0'`) before its
 * first use. Null when it cannot be found. An engine failure reading the environment rejects:
 * the hook's catch drops the line.
 */
async function gitBash($: Engine, root: string): Promise<string | null> {
  if (runtime.bashPath !== null) return runtime.bashPath
  const isWindows = (await $.env.get('OS')) === 'Windows_NT' || isWindowsPath(root)
  const configured = (await $.env.get('CLAUDE_CODE_GIT_BASH_PATH'))?.trim() ?? ''
  let found: string | null
  if (configured !== '') found = !isWindows || isWindowsPath(configured) || configured.startsWith('\\\\') ? configured : null
  else if (isWindows) found = gitBashFromExecPath(await git($, root, ['--exec-path']))
  else found = 'bash'
  if (found !== null && isWslBash(found)) found = null
  if (found !== null) {
    const check = await run($, root, [found, '-c', 'exit 0'], SHELL_ENV)
    if (check?.exitCode !== 0) found = null
  }
  runtime.bashPath = found
  return found
}

/** Whether `work` settled within `ms` (false at the cap, or when there is no clock to cap it by and it never settles). */
async function settlesWithin($: Engine, work: Promise<unknown>, ms: number): Promise<boolean> {
  let fire = () => {}
  const cap = new Promise<false>(resolve => {
    fire = () => resolve(false)
  })
  let timer: Timer | null = null
  try {
    timer = $.clock.after(ms, () => fire())
  } catch {
    timer = null
  }
  try {
    return await Promise.race([work.then(() => true as const, () => true as const), cap])
  } finally {
    timer?.cancel()
  }
}

/** Puts Robert's dropped line back in the prompt box, so his edits survive the drop. */
async function restoreLine($: Engine, text: string) {
  try {
    await $.prompt.fill({ text, mode: 'replace' })
  } catch {
    // The drop's reason still shows.
  }
}

/**
 * Drops a line Git Ship could not run, putting it back in the box first, unless the hook's
 * dispatch already ended (`signal`): its catch dropped and restored the line then, and what
 * Robert typed since must stand.
 */
async function dropAndRestore($: Engine, text: string, reason: string, signal?: AbortSignal): Promise<{ drop: string }> {
  if (signal?.aborted !== true) await restoreLine($, text)
  return { drop: reason }
}

/** Claims the one run slot for `command` under a fresh token: the run already going when it is taken. */
async function startRunning($: Engine, command: string): Promise<{ already: GitShipRunning | null; token: number }> {
  const token = ++runtime.runToken
  let already: GitShipRunning | null = null
  // update may run the change again on a write miss: the last run is the one written.
  await update($, runningAtom, running => {
    already = running
    return running ?? { command, token }
  })
  return { already, token }
}

/** Frees the run slot only while it still holds `token`'s run. */
async function stopRunning($: Engine, token: number) {
  runtime.activeRuns.delete(token)
  await update($, runningAtom, running => (running?.token === token ? null : running))
}

/** Whether the pane is open, by the engine's own list. */
async function isPaneOpen($: Engine): Promise<boolean> {
  try {
    return (await $.ui.panes()).some(pane => pane.id === PANE)
  } catch {
    return read($, paneOpenAtom)
  }
}

/** Reads git again a while from now; no clock, no second read. */
function refreshLater($: Engine, ms: number) {
  try {
    $.clock.after(ms, () => {
      void refresh($).catch(() => undefined)
    })
  } catch {
    // No clock: the read after the run stands.
  }
}

/**
 * Runs a claimed line in Git Bash from the repo root, records it, reports it, then reads git
 * again. A watchdog frees the slot whatever becomes of the run. `text` is the line as
 * submitted, put back in the box when Git Bash would not start.
 */
async function runLine($: Engine, root: string, bash: string, command: string, text: string, token: number) {
  const label = commandLabel(command)
  runtime.activeRuns.add(token)
  let watchdog: Timer | null = null
  try {
    watchdog = $.clock.after(RUN_WATCHDOG_MS, () => {
      void stopRunning($, token).catch(() => undefined)
    })
  } catch {
    watchdog = null
  }
  try {
    const startedAt = await $.clock.now().catch(() => 0)
    const result = await run($, root, [bash, '-c', SHELL_SCRIPT], { ...SHELL_ENV, GIT_SHIP_COMMAND: command }, SHELL_TIMEOUT_MS)
    const at = await $.clock.now().catch(() => startedAt)
    // process.run rejects only when the command cannot start or outlives its timeout: a
    // rejection well before the timeout means Git Bash itself would not start (a backstop to
    // the check gitBash made). With no clock to tell, it counts as not finished.
    if (result === undefined && startedAt !== 0 && at - startedAt < SHELL_TIMEOUT_MS - 1_000) {
      runtime.bashPath = null
      $.ui.toast(NO_GIT_BASH)
      await restoreLine($, text)
      return
    }
    const exitCode = result === undefined ? null : result.exitCode
    const output = result === undefined ? '' : runOutput(result.stdout, result.stderr, result.isStdoutTruncated || result.isStderrTruncated)
    await update($, lastRunAtom, () => ({ command, exitCode, output, at }))
    if (exitCode === 0) {
      $.ui.toast(`Git Ship: ${label} done`)
    } else {
      $.ui.toast(exitCode === null ? `Git Ship: ${label} did not finish — it may still be running` : `Git Ship: ${label} failed (exit ${exitCode}) — see the pane`)
      if (exitCode === null) refreshLater($, UNFINISHED_REREAD_MS)
      if (!(await isPaneOpen($))) await openPane($)
    }
  } catch (err) {
    $.ui.toast(`Git Ship: ${label} — ${errorText(err)}`)
  } finally {
    watchdog?.cancel()
    await stopRunning($, token).catch(() => undefined)
    void refresh($).catch(() => undefined)
  }
}

/**
 * A `!git` / `!gh` line Robert pressed Enter on: dropped before it reaches Claude, and run
 * by Git Ship in Git Bash beside the hook (never awaited, so the prompt box is free at once).
 * The drop's reason is what Robert sees.
 */
async function interceptLine($: Engine, repo: RepoState, command: string, text: string, signal: AbortSignal): Promise<{ drop: string }> {
  const running = await read($, runningAtom)
  if (running !== null) return dropAndRestore($, text, `Git Ship is still running ${commandLabel(running.command)}`, signal)
  const bash = await gitBash($, repo.root)
  if (bash === null) return dropAndRestore($, text, NO_GIT_BASH, signal)
  // The dispatch ended while this hook waited: its catch already dropped the line and
  // handed it back, so running it now would run it twice.
  if (signal.aborted) return { drop: COULD_NOT_RUN }
  const { already, token } = await startRunning($, command)
  if (already !== null) return dropAndRestore($, text, `Git Ship is still running ${commandLabel(already.command)}`, signal)
  void runLine($, repo.root, bash, command, text, token).catch(() => undefined)
  void clearRanLine($, text).catch(() => undefined)
  return { drop: `Git Ship ran: ${commandLabel(command)}` }
}

/**
 * The engine hands a dropped prompt back to the box, where a second Enter would run it again.
 * Once the drop has landed, clears the box when it still holds the line that ran; leaves
 * anything Robert has typed since.
 */
async function clearRanLine($: Engine, text: string) {
  await new Promise<void>(resolve => {
    $.clock.after(CLEAR_AFTER_MS, () => resolve())
  })
  const box = (await $.prompt.read()).text
  if (box.trim() === text.trim()) await $.prompt.fill({ text: '', mode: 'replace' })
}

/**
 * The repo for an intercepted line: the last read, or a fresh one when there is none or it
 * failed. Undefined outside a repo (the line passes on); 'error' when git still cannot be read.
 */
async function repoForLine($: Engine): Promise<RepoState | 'error' | undefined> {
  let repo = await read($, repoAtom)
  if (repo === null || repo === 'error') {
    // Capped well inside the hook's budget: a read still out at the cap counts as unreadable.
    if (!(await settlesWithin($, refresh($), LINE_READ_WAIT_MS))) return 'error'
    repo = await read($, repoAtom)
  }
  return repo === null ? undefined : repo
}

/** A pane button, judged again at press time: a disabled one does nothing, drawn dim or not. */
async function pressButton($: Engine, id: ButtonId) {
  if (id === 'close') return closePane($)
  const [repo, drafting, hasOpenPr] = await Promise.all([read($, repoAtom), read($, draftingAtom), read($, hasOpenPrAtom)])
  if (repo === null || repo === 'error') return
  if (!buttonStates(repo, { drafting, hasOpenPr })[id]) return
  switch (id) {
    case 'stage':
      return fill($, stageCommand())
    case 'commit':
      return draftCommit($, repo)
    case 'push': {
      const command = pushCommand(repo)
      return command === '' ? undefined : fill($, command)
    }
    case 'pull':
      return fill($, pullCommand())
    case 'branch':
      return fill($, branchCommand())
    case 'pr':
      return hasOpenPr === true ? fill($, prViewCommand()) : draftPr($, repo)
  }
}

/** Runs a button's work; a rejection becomes a toast instead of an unhandled error. */
async function safely($: Engine, work: () => Promise<unknown>) {
  try {
    await work()
  } catch (err) {
    $.ui.toast(`Git Ship: ${errorText(err)}`)
  }
}

/** The pane's header line: `<branch> → <upstream>  ↑a ↓b`. */
function headerText(repo: RepoState): string {
  const where = repo.branch ?? `detached ${repo.sha ?? 'HEAD'}`
  return repo.upstream === null ? `${where} → no upstream` : `${where} → ${repo.upstream}  ↑${repo.ahead} ↓${repo.behind}`
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    // /ship first: Robert's Toolbox runs a mod's first registered command.
    await $.command.register({
      name: 'ship',
      description: 'Open the Git Ship pane — repo status and ready-to-run git commands',
      immediate: true,
    })
    // A fresh load has no draft or run going: a reload mid-way would leave them stuck.
    await update($, draftingAtom, () => false)
    // A run of an earlier load is gone with it; one this load still has going stays.
    await update($, runningAtom, running => (running !== null && runtime.activeRuns.has(running.token) ? running : null))
    runtime.bashPath = null
    // No hook waits on git: every refresh runs beside the event.
    void refresh($)
    return next(e)
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'ship' }, async $ => {
    await safely($, () => togglePane($))
    return {}
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId === undefined) void refresh($)
    return result
  }).catch(($, e, next) => next(e))

  // A filled `!git` / `!gh` line Robert pressed Enter on is Git Ship's to run, never Claude's:
  // a plugin fill cannot put the box in shell mode, so it would otherwise go to Claude as a prompt.
  // Any other `!` shell command Robert ran may have changed the repo.
  on('prompt.submit', async ($, e, next) => {
    const command = e.origin.kind === 'composer' ? interceptedCommand(e.text) : null
    if (command !== null) {
      const repo = await repoForLine($)
      if (repo === 'error') return dropAndRestore($, e.text, COULD_NOT_READ, next.signal)
      if (repo !== undefined) return interceptLine($, repo, command, e.text, next.signal)
    }
    const result = await next(e)
    if (e.text.trimStart().startsWith('!')) refreshAfterShell($)
    return result
  }).catch(async ($, e, next) => {
    // A line of Git Ship's own never falls through to Claude, whatever broke.
    if (!next.called && e.origin.kind === 'composer' && interceptedCommand(e.text) !== null) {
      return dropAndRestore($, e.text, COULD_NOT_RUN)
    }
    return next(e)
  })

  // The person's own close (the pane's mark or key) keeps the row's button in step.
  on('ui.close', async ($, e, next) => {
    const result = await next(e)
    if (e.id === PANE) await update($, paneOpenAtom, () => false)
    return result
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    // A drawing that throws would drop the pane (an unload close): a dim line instead.
    try {
      const [repo, drafting, hasOpenPr, lastRun] = await Promise.all([
        read($, repoAtom),
        read($, draftingAtom),
        read($, hasOpenPrAtom),
        read($, lastRunAtom),
      ])
      if (repo === null) return <Text dimColor>Not inside a git repository.</Text>
      if (repo === 'error') return <Text dimColor>git unavailable.</Text>
      const states = buttonStates(repo, { drafting, hasOpenPr })
      const more = repo.files.length - MAX_FILES
      return (
      <Box flexDirection="column">
        {/* Each line sits in a keyed Box: a Text keeps no key of its own. */}
        <Box key="git-ship-head">
          <Text color={COLORS.green} bold>{headerText(repo)}</Text>
        </Box>
        {repo.files.slice(0, MAX_FILES).map((file, i) => (
          <Box key={`git-ship-file-${i}`}>
            <Text color={COLORS.text}>{`  ${file.xy}  ${file.path}`}</Text>
          </Box>
        ))}
        {more > 0 ? (
          <Box key="git-ship-more">
            <Text color={COLORS.muted}>{`  +${more} more`}</Text>
          </Box>
        ) : null}
        <Box key="git-ship-last">
          <Text color={COLORS.muted}>{`last: ${repo.lastCommit ?? '(no commits)'}`}</Text>
        </Box>
        {repo.unmerged > 0 ? (
          <Box key="git-ship-conflicts">
            <Text dimColor>{CONFLICT_TEXT}</Text>
          </Box>
        ) : null}
        {drafting ? (
          <Box key="git-ship-drafting">
            <Text color={COLORS.muted}>drafting…</Text>
          </Box>
        ) : null}
        {/* Wraps onto more rows in a narrow pane; each button keeps its label whole. */}
        <Box key="git-ship-buttons" flexDirection="row" flexWrap="wrap" columnGap={1}>
          {BUTTONS.map(({ id, label }) => (
            <Box key={`git-ship-cell-${id}`} flexShrink={0}>
              <Button key={`git-ship-${id}`} label={label} dimColor={!states[id]} onPress={() => safely($, () => pressButton($, id))} />
            </Box>
          ))}
        </Box>
        {lastRun === null ? null : (
          <Box key="git-ship-run" flexDirection="column">
            <Box key="git-ship-run-command">
              <Text color={COLORS.text}>{`$ ${commandHeadline(lastRun.command)}`}</Text>
            </Box>
            {lastRun.output === '' ? null : (
              <Box key="git-ship-run-output">
                <Text color={COLORS.muted}>{lastRun.output}</Text>
              </Box>
            )}
            <Box key="git-ship-run-status">
              <Text color={lastRun.exitCode === 0 ? COLORS.green : COLORS.red}>{runStatusText(lastRun.exitCode)}</Text>
            </Box>
          </Box>
        )}
      </Box>
      )
    } catch (err) {
      return <Text dimColor>{`Git Ship could not draw: ${errorText(err)}`}</Text>
    }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const below = await next(e)
    if (e.props.hasSurvey) return below
    const [repo, paneOpen, running] = await Promise.all([read($, repoAtom), read($, paneOpenAtom), read($, runningAtom)])
    if (repo === null) return below
    const { Box, Text, Button } = $.ui.resolve(e)
    const row =
      repo === 'error' ? (
        <Box key="git-ship-row" flexDirection="row">
          <Box key="git-ship-text" flexShrink={1}>
            <Text>
              <Text color={COLORS.green} bold>{ROW_TITLE}</Text>
              <Text dimColor>{'  git unavailable'}</Text>
            </Text>
          </Box>
          {/* No buttons, save a way to close a pane git failed under. */}
          {paneOpen ? <Box key="git-ship-spacer" flexGrow={1} /> : null}
          {paneOpen ? <Button key="git-ship-toggle" label="Close" onPress={() => safely($, () => closePane($))} /> : null}
        </Box>
      ) : (
        <Box key="git-ship-row" flexDirection="row">
          <Box key="git-ship-text" flexShrink={1}>
            <Text>
              <Text color={COLORS.green} bold>{ROW_TITLE}</Text>
              <Text dimColor>{`  ${rowText(repo)}${running === null ? '' : ` · running ${commandLabel(running.command)}…`}`}</Text>
            </Text>
          </Box>
          <Box key="git-ship-spacer" flexGrow={1} />
          <Button key="git-ship-toggle" label={paneOpen ? 'Close' : 'Open'} onPress={() => safely($, () => togglePane($))} />
        </Box>
      )
    return (
      <Box flexDirection="column">
        {below}
        {row}
      </Box>
    )
  }).catch(($, e, next) => next(e))
}

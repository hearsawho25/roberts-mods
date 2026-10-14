import type { RelayHandoff, RelayPingReceipt, RelayWarming } from '../types'

/**
 * Relay's pure logic: thresholds, the prompt-cache clock, durations, formatting,
 * prices, paths, git-output parsing, the handoff prompt and the handoff index.
 * Nothing here touches `$`, so every function is unit-tested directly.
 */

export type { RelayHandoff }

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const MINUTE_MS = 60 * 1000
export const HOUR_MS = 60 * MINUTE_MS
export const DAY_MS = 24 * HOUR_MS

/** Offer a handoff once context reaches this percent of the model window. */
export const HANDOFF_PERCENT = 80
/** ...or once the context reaches this many tokens, whichever comes first. */
export const HANDOFF_TOKENS = 300_000
/** After "Not yet", offer again from this percent. */
export const SNOOZE_PERCENT = 90
/** After "Not yet", offer again from this many tokens. */
export const SNOOZE_TOKENS = 400_000

/** The prompt cache's lifetime since the last main-thread response (1-hour cache). */
export const CACHE_TTL_MS = 60 * MINUTE_MS
/** With this much or less left, the cache reads as cooling. */
export const COOLING_MS = 10 * MINUTE_MS
/** Idle time before a warming ping. */
export const PING_IDLE_MS = 50 * MINUTE_MS
/** The idle window each completed turn arms (or extends) for warming. */
export const WARM_WINDOW_MS = 2 * HOUR_MS
/** The longest window `/keepwarm` accepts. */
export const MAX_WINDOW_MS = 12 * HOUR_MS
/** Sessions with less context than this are not warmed or guarded. */
export const MIN_WARM_TOKENS = 50_000
/** Unconsumed handoffs older than this are no longer offered. */
export const HANDOFF_MAX_AGE_MS = 7 * DAY_MS
/** The handoff index keeps at most this many records. */
export const HANDOFF_INDEX_CAP = 50

// ---------------------------------------------------------------------------
// Handoff threshold
// ---------------------------------------------------------------------------

export type HandoffCheck = {
  /** Context fill as a whole percent of the model window; absent before the first response. */
  percent?: number
  /** Context tokens; absent before the first response. */
  tokens?: number
  /** True once the person pressed "Not yet" this session. */
  snoozed: boolean
}

/**
 * Whether to offer a handoff: at or past 80% or 300k tokens, whichever first;
 * once snoozed, at or past 90% or 400k tokens.
 */
export function shouldOfferHandoff({ percent, tokens, snoozed }: HandoffCheck): boolean {
  const percentLimit = snoozed ? SNOOZE_PERCENT : HANDOFF_PERCENT
  const tokenLimit = snoozed ? SNOOZE_TOKENS : HANDOFF_TOKENS
  return (typeof percent === 'number' && percent >= percentLimit) || (typeof tokens === 'number' && tokens >= tokenLimit)
}

// ---------------------------------------------------------------------------
// Prompt-cache clock
// ---------------------------------------------------------------------------

export type CacheStateName = 'warm' | 'cooling' | 'cold' | 'unknown'

export type CacheState = {
  state: CacheStateName
  /** Time until the cache expires (warm and cooling). */
  msLeft?: number
  /** Time since the cache expired (cold). */
  coldForMs?: number
}

/**
 * The cache's state from the time of the last main-thread response:
 * `unknown` with no response yet (or right after /clear or compaction, when the
 * caller passes undefined); `warm` with more than 10 minutes left; `cooling`
 * with 10 minutes or less; `cold` from the full hour on. A timestamp in the
 * future counts as just now.
 */
export function cacheState(lastResponseAt: number | undefined, now: number): CacheState {
  if (lastResponseAt === undefined || !Number.isFinite(lastResponseAt)) return { state: 'unknown' }
  const elapsed = Math.max(0, now - lastResponseAt)
  if (elapsed >= CACHE_TTL_MS) return { state: 'cold', coldForMs: elapsed - CACHE_TTL_MS }
  const msLeft = CACHE_TTL_MS - elapsed
  return { state: msLeft <= COOLING_MS ? 'cooling' : 'warm', msLeft }
}

// ---------------------------------------------------------------------------
// Durations
// ---------------------------------------------------------------------------

/**
 * Parses `/keepwarm` durations: `90m`, `2h`, `2h30m`, `6h` (case and spaces
 * ignored). Returns milliseconds, or undefined for anything else, for zero, and
 * for anything over MAX_WINDOW_MS (12h): over the cap is REJECTED, not clamped,
 * so the command can say "max 12h" rather than silently shortening the window.
 * Pattern adapted from cache-tax's parseDuration (MIT, (c) 2026 Karan Bansal).
 */
export function parseDuration(text: string): number | undefined {
  const match = /^(?:(\d+)h)?(?:(\d+)m)?$/.exec(text.trim().toLowerCase().replace(/\s+/g, ''))
  if (!match || (match[1] === undefined && match[2] === undefined)) return undefined
  const ms = (Number(match[1] ?? 0) * 60 + Number(match[2] ?? 0)) * MINUTE_MS
  if (ms <= 0 || ms > MAX_WINDOW_MS) return undefined
  return ms
}

/** A span for "41m left" or "next ping 12m": `<1m`, `41m`, `2h 5m`, `3h`, `2d 4h` (48h and up). */
export function formatSpan(ms: number): string {
  const minutes = Math.floor(Math.max(0, ms) / MINUTE_MS)
  if (minutes < 1) return '<1m'
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours >= 48) {
    const rest = hours % 24
    return rest > 0 ? `${Math.floor(hours / 24)}d ${rest}h` : `${Math.floor(hours / 24)}d`
  }
  const rest = minutes % 60
  return rest > 0 ? `${hours}h ${rest}m` : `${hours}h`
}

/** How long ago, for "from 10h ago" or "went cold 9h ago": `just now`, `9m ago`, `10h ago`, `3d ago`. */
export function formatAgo(ms: number): string {
  const minutes = Math.floor(Math.max(0, ms) / MINUTE_MS)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 48) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}

// ---------------------------------------------------------------------------
// Numbers and the meter
// ---------------------------------------------------------------------------

/** A token count in short form: `950`, `231k`, `1.2M`, `2M`. */
export function formatTokens(n: number): string {
  const value = Math.max(0, Math.round(Number.isFinite(n) ? n : 0))
  if (value < 1000) return String(value)
  const thousands = Math.round(value / 1000)
  if (thousands < 1000) return `${thousands}k`
  return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`
}

/** Dollars for the row: `$4.80`, `$0.03`, `$120`. */
export function formatUsd(usd: number): string {
  return usd >= 100 ? `$${usd.toFixed(0)}` : `$${usd.toFixed(2)}`
}

/**
 * A meter of `cells` cells (default 8): `▰▰▰▰▰▱▱▱` at 58%, the same block meter the
 * skins mod draws for context and rate limits. Percent is clamped to 0..100.
 */
export function meterBar(percent: number, cells = 8): string {
  const safe = Number.isFinite(percent) ? Math.min(100, Math.max(0, percent)) : 0
  const count = Math.max(0, Math.floor(cells))
  const filled = Math.min(count, Math.round((safe / 100) * count))
  return '▰'.repeat(filled) + '▱'.repeat(count - filled)
}

// ---------------------------------------------------------------------------
// The meter row and the status card
// ---------------------------------------------------------------------------

/**
 * The context figures Relay keeps, as `SessionContextUsage` reports them:
 * `tokens` and `percent` absent before the first response of the live window.
 * `percent` is of the model's full window (`window`), not the auto-compact window.
 */
export type ContextFigures = { tokens?: number; percent?: number; window?: number }

/** The fill as a whole percent: the engine's own, else tokens over window; undefined with no reading. */
export function contextPercent(context: ContextFigures | null | undefined): number | undefined {
  if (!context) return undefined
  if (typeof context.percent === 'number' && Number.isFinite(context.percent)) return Math.round(context.percent)
  if (typeof context.tokens === 'number' && typeof context.window === 'number' && context.window > 0) {
    return Math.round((context.tokens / context.window) * 100)
  }
  return undefined
}

/** `58% · 231k`, `231k` with tokens alone, `—` before the first response. */
export function contextText(context: ContextFigures | null | undefined): string {
  const percent = contextPercent(context)
  const tokens = typeof context?.tokens === 'number' ? formatTokens(context.tokens) : undefined
  if (percent !== undefined && tokens !== undefined) return `${percent}% · ${tokens}`
  if (percent !== undefined) return `${percent}%`
  return tokens ?? '—'
}

export const ROW_TITLE = '◆ Relay'
/** The Handoff button as the terminal draws it, `[ Handoff ]`. */
export const HANDOFF_BUTTON_WIDTH = '[ Handoff ]'.length
export const HANDOFF_NOW_WIDTH = '[ Handoff now ]'.length
export const NOT_YET_WIDTH = '[ Not yet ]'.length

/** The meter row's parts at one width; `bar` and `left` are dropped (in that order) when the row would not fit. */
export type MeterRow = {
  /** The 10-cell meter, or undefined when dropped or with no reading. */
  bar?: string
  figures: string
  cache: CacheStateName
  /** `41m left` for warm and cooling, undefined when dropped or for cold/unknown. */
  left?: string
}

/** The row's text as drawn, for measuring: `◆ Relay   ctx ▰▰▰▰▰▱▱▱ 58% · 231k   cache ● warm · 41m left`. */
export function meterRowText(row: MeterRow): string {
  const bar = row.bar !== undefined ? `${row.bar} ` : ''
  const left = row.left !== undefined ? ` · ${row.left}` : ''
  return `${ROW_TITLE}   ctx ${bar}${row.figures}   cache ● ${row.cache}${left}`
}

/**
 * Picks the meter row for `columns` cells, keeping two cells of gap and the
 * Handoff button: the full row, else without the bar, else without the time left.
 */
export function meterRow(context: ContextFigures | null | undefined, cache: CacheState, columns: number): MeterRow {
  const percent = contextPercent(context)
  const base: MeterRow = { figures: contextText(context), cache: cache.state }
  const left = cache.msLeft !== undefined && (cache.state === 'warm' || cache.state === 'cooling') ? `${formatSpan(cache.msLeft)} left` : undefined
  const room = columns - HANDOFF_BUTTON_WIDTH - 2
  const full: MeterRow = { ...base, ...(percent !== undefined ? { bar: meterBar(percent) } : {}), ...(left ? { left } : {}) }
  if (meterRowText(full).length <= room) return full
  const noBar: MeterRow = { ...base, ...(left ? { left } : {}) }
  if (meterRowText(noBar).length <= room) return noBar
  return base
}

/** The threshold prompt: `Context is at 81% (322k). Hand off and start fresh?` */
export function thresholdText(context: ContextFigures | null | undefined): string {
  const percent = contextPercent(context)
  const tokens = typeof context?.tokens === 'number' ? formatTokens(context.tokens) : undefined
  const at =
    percent !== undefined && tokens !== undefined ? `${percent}% (${tokens})` : percent !== undefined ? `${percent}%` : `${tokens ?? '?'} tokens`
  return `Context is at ${at}. Hand off and start fresh?`
}

/** Cuts text to `width` cells with an ellipsis. */
export function fit(text: string, width: number): string {
  if (width <= 0) return ''
  return text.length <= width ? text : `${text.slice(0, Math.max(0, width - 1))}…`
}

/** What the `/relay` status card is built from. Later build steps fill `warming` and `pending`. */
export type StatusCardState = {
  enabled: boolean
  context: ContextFigures | null
  cache: CacheState
  snoozed: boolean
  /** One line on the warming window; undefined until warming exists. */
  warming?: string
  /** One line on handoffs waiting for this project; undefined until handoffs exist. */
  pending?: string
}

/** The `/relay` status card, one fact per line. */
export function statusCard(state: StatusCardState): string {
  const percent = contextPercent(state.context)
  const tokens = typeof state.context?.tokens === 'number' ? state.context.tokens : undefined
  const window = state.context?.window
  const ctx =
    percent === undefined && tokens === undefined
      ? 'no reading yet (it appears after the first reply)'
      : `${contextText(state.context)}${typeof window === 'number' && window > 0 ? ` of a ${formatTokens(window)} window` : ''}`

  const { cache } = state
  const cacheLine =
    cache.state === 'unknown'
      ? 'unknown (no reply since the session started, was cleared or compacted)'
      : cache.state === 'cold'
        ? `cold for ${formatSpan(cache.coldForMs ?? 0)}`
        : `${cache.state} · ${formatSpan(cache.msLeft ?? 0)} left`

  const offered = shouldOfferHandoff({ percent, tokens, snoozed: state.snoozed })
  const handoff = offered
    ? 'offered now (context is past the handoff point)'
    : state.snoozed
      ? `snoozed until ${SNOOZE_PERCENT}% or ${formatTokens(SNOOZE_TOKENS)} tokens`
      : `offered at ${HANDOFF_PERCENT}% or ${formatTokens(HANDOFF_TOKENS)} tokens`

  return [
    `Relay is ${state.enabled ? 'on' : 'off'}.`,
    `Context: ${ctx}`,
    `Prompt cache: ${cacheLine}`,
    `Handoff: ${handoff}`,
    `Warming: ${state.warming ?? 'not available yet'}`,
    `Waiting handoffs: ${state.pending ?? 'not available yet'}`,
    `Commands: /relay on, /relay off, /relay overnight on|off, /handoff, /handoff list, /keepwarm 2h|off|status`,
  ].join('\n')
}

// ---------------------------------------------------------------------------
// Prices
// ---------------------------------------------------------------------------

export type ModelPrice = {
  /** $ per million cache-read tokens. */
  read: number
  /** $ per million 1-hour cache-write tokens. */
  write: number
  /** $ per million output tokens. */
  output: number
}

/**
 * $ per million tokens by model family, list prices September 2026. Longer
 * family names first: a model id matches the first row it contains.
 * Adapted from cache-tax's PRICES table (MIT License, Copyright (c) 2026 Karan Bansal).
 */
export const PRICES: ReadonlyArray<readonly [family: string, price: ModelPrice]> = [
  ['fable-5-1', { read: 0.25, write: 20, output: 50 }],
  ['fable-5', { read: 1, write: 20, output: 50 }],
  ['opus-5', { read: 0.5, write: 10, output: 25 }],
  ['opus-4', { read: 0.5, write: 10, output: 25 }],
  ['sonnet-5', { read: 0.2, write: 4, output: 10 }],
  ['sonnet', { read: 0.3, write: 6, output: 15 }],
  ['haiku', { read: 0.1, write: 2, output: 5 }],
]

/** The price row for a model id (`claude-opus-5-5`, `Opus 5.5`, ...), or undefined when unknown. */
export function modelPrice(modelId: string | undefined | null): ModelPrice | undefined {
  const id = (modelId ?? '').toLowerCase().replace(/[\s.]+/g, '-')
  if (id === '') return undefined
  for (const [family, price] of PRICES) if (id.includes(family)) return price
  return undefined
}

/** The 1-hour cache-write price in $ per million tokens, or undefined for an unknown model. */
export function cacheWritePricePerMTok(modelId: string | undefined | null): number | undefined {
  return modelPrice(modelId)?.write
}

/** What re-writing `tokens` of context into the cache costs, in $; undefined for an unknown model. */
export function estimateRewriteUsd(tokens: number, modelId: string | undefined | null): number | undefined {
  const write = cacheWritePricePerMTok(modelId)
  if (write === undefined || !Number.isFinite(tokens)) return undefined
  return (Math.max(0, tokens) * write) / 1_000_000
}

// ---------------------------------------------------------------------------
// Paths and names
// ---------------------------------------------------------------------------

/**
 * The folder name for a project: the session root with `:`, `\`, `/` and spaces
 * turned into `-`, a trailing separator dropped and a leading drive letter
 * upper-cased, so `d:\x`, `D:\x` and `D:/x` share one key.
 */
export function projectKey(root: string): string {
  const trimmed = root.length > 1 ? root.replace(/[\\/]+$/, '') : root
  const drive = trimmed.replace(/^([a-z]):/, (_, letter: string) => `${letter.toUpperCase()}:`)
  return drive.replace(/[:\\/ ]/g, '-')
}

/** A short file-safe slug: lowercase letters and digits joined by `-`, at most 50 chars; `handoff` when empty. */
export function slugify(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50)
    .replace(/-+$/, '')
  return slug === '' ? 'handoff' : slug
}

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

/** `<YYYY-MM-DD-HHmmss>-<slug>.md` in the local time of `date` (seconds, so two handoffs in one minute never collide). */
export function handoffFileName(date: Date, title: string): string {
  const stamp =
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}-` +
    `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  return `${stamp}-${slugify(title)}.md`
}

/** `<home>/.claude/handoffs/<project-key>`, using the separator `home` uses. */
export function handoffDir(home: string, key: string): string {
  const sep = home.includes('\\') ? '\\' : '/'
  const base = home.replace(/[\\/]+$/, '')
  return [base, '.claude', 'handoffs', key].join(sep)
}

// ---------------------------------------------------------------------------
// Git facts
// ---------------------------------------------------------------------------

/** Raw output of the read-only git commands; undefined where the command failed. */
export type GitOutputs = {
  /** `git rev-parse --abbrev-ref HEAD`; undefined when it failed (not a repo, or a repo with no commits). */
  branch?: string
  /** `git symbolic-ref --short HEAD`: the branch when `branch` failed in a repo with no commits. Both undefined means not a repo. */
  symbolicRef?: string
  /** `git log -1 --format=%h %s`. */
  log?: string
  /** `git rev-list --left-right --count @{u}...HEAD`; undefined when there is no upstream. */
  aheadBehind?: string
  /** `git status --porcelain`. */
  porcelain?: string
}

export type GitChange = { status: string; path: string }

export type GitFacts =
  | { isRepo: false }
  | {
      isRepo: true
      /** Branch name, or undefined when HEAD is detached. */
      branch?: string
      head?: { sha: string; subject: string }
      /** Undefined when there is no upstream (or the count could not be read). */
      upstream?: { ahead: number; behind: number }
      changedCount: number
      /** The first 10 changes. */
      changes: GitChange[]
    }

/** Most uncommitted files listed by name. */
export const GIT_CHANGES_SHOWN = 10

/**
 * One `git status --porcelain` line as status and path. Tolerates a line whose
 * leading space was trimmed away (` M x` read as `M x`); a rename
 * (`R  old -> new`) keeps the new path.
 */
export function parsePorcelainLine(line: string): GitChange {
  const match = /^\s*(\S{1,2})\s+(.*)$/.exec(line)
  if (!match) return { status: '?', path: line.trim() }
  const path = (match[2] ?? '').trim()
  const arrow = path.lastIndexOf(' -> ')
  return { status: match[1] ?? '?', path: arrow >= 0 ? path.slice(arrow + 4).trim() : path }
}

/**
 * Turns the git commands' output into facts. Tolerates missing upstream,
 * not-a-repo, and a repo with no commits (where rev-parse fails but
 * `symbolicRef` still names the branch; `head` is then undefined).
 */
export function parseGitFacts({ branch, symbolicRef, log, aheadBehind, porcelain }: GitOutputs): GitFacts {
  const name = branch?.trim() || symbolicRef?.trim()
  if (name === undefined || name === '') return { isRepo: false }

  const logLine = log?.trim().split(/\r?\n/)[0] ?? ''
  const logMatch = /^(\S+)(?:\s+(.*))?$/.exec(logLine)
  const head = logMatch?.[1] ? { sha: logMatch[1], subject: (logMatch[2] ?? '').trim() } : undefined

  const counts = /^(\d+)\s+(\d+)$/.exec(aheadBehind?.trim() ?? '')
  const upstream = counts ? { behind: Number(counts[1]), ahead: Number(counts[2]) } : undefined

  const lines = (porcelain ?? '').split(/\r?\n/).filter(line => line.trim() !== '')
  const changes = lines.slice(0, GIT_CHANGES_SHOWN).map(parsePorcelainLine)

  return {
    isRepo: true,
    branch: name === 'HEAD' ? undefined : name,
    head,
    upstream,
    changedCount: lines.length,
    changes,
  }
}

/** Markdown bullet lines for "Where things stand"; empty for not-a-repo. */
export function formatGitFacts(facts: GitFacts): string[] {
  if (!facts.isRepo) return []
  const lines: string[] = []
  lines.push(facts.branch ? `- Branch: \`${facts.branch}\`` : '- Branch: detached HEAD')
  lines.push(facts.head ? `- HEAD: \`${facts.head.sha}\` ${facts.head.subject}`.trimEnd() : '- HEAD: no commits yet')
  lines.push(
    facts.upstream
      ? `- Upstream: ${facts.upstream.ahead} ahead, ${facts.upstream.behind} behind`
      : '- Upstream: none set',
  )
  if (facts.changedCount === 0) {
    lines.push('- Uncommitted changes: none')
  } else {
    lines.push(`- Uncommitted changes: ${facts.changedCount} file${facts.changedCount === 1 ? '' : 's'}`)
    for (const change of facts.changes) lines.push(`  - \`${change.status}\` ${change.path}`)
    const more = facts.changedCount - facts.changes.length
    if (more > 0) lines.push(`  - ...and ${more} more`)
  }
  return lines
}

// ---------------------------------------------------------------------------
// Handoff prompt
// ---------------------------------------------------------------------------

/** The instruction the handoff fork runs with, with the git facts (markdown lines joined) appended. */
export function buildHandoffPrompt(factsMarkdown: string): string {
  const facts = factsMarkdown.trim() === '' ? '(none: the session root is not a git repository)' : factsMarkdown.trim()
  return [
    'Write a handoff brief so a fresh Claude Code session, which will not see this conversation, can pick up the work exactly where it stands.',
    'Reply with the brief only: no preamble, no closing remarks, no code fence around it.',
    '',
    'Layout, in this order:',
    '1. First line: a one-line title for the work, plain text, no heading marks, under 70 characters.',
    '2. `## Where things stand`: what is done, what is half done, and the decisions made and why. Include the git facts below verbatim.',
    '3. `## Read first`: the files, docs and memory files the next session should read before acting, as full paths.',
    "4. `## What's next`: the next concrete steps, in order.",
    '5. `## Hard rules`: every constraint the user stated in this conversation, copied verbatim and in quotes. Leave none out and do not paraphrase.',
    '6. `## How to run it`: the method (for example subagent-driven development, one task per subagent), where to stop and check in with the user, and the checks to run.',
    '',
    'Git facts (copy these lines verbatim under Where things stand):',
    facts,
  ].join('\n')
}

const SECTION_HEADING = /^#{1,6}\s*(where things stand|read first|what's next|hard rules|how to run it)\b/i

/** The handoff's title: its first non-empty line without heading marks, bold, quotes or a `Title:` label; `Handoff` when none. */
export function extractTitle(handoffText: string): string {
  const first = handoffText.split(/\r?\n/).find(line => line.trim() !== '' && !line.trim().startsWith('```')) ?? ''
  if (SECTION_HEADING.test(first.trim())) return 'Handoff'
  const title = first
    .trim()
    .replace(/^#+\s*/, '')
    .replace(/^title:\s*/i, '')
    .replace(/^\*\*(.*)\*\*$/, '$1')
    .replace(/^title:\s*/i, '')
    .replace(/^["'`](.*)["'`]$/, '$1')
    .trim()
  if (title === '') return 'Handoff'
  return title.length > 80 ? `${title.slice(0, 79).trimEnd()}…` : title
}

// ---------------------------------------------------------------------------
// Handoff index (plain arrays; the caller keeps it in the store)
// ---------------------------------------------------------------------------

/** Adds a record (replacing one with the same id), newest first, capped at HANDOFF_INDEX_CAP. */
export function addHandoff(index: readonly RelayHandoff[], rec: RelayHandoff): RelayHandoff[] {
  return [rec, ...index.filter(one => one.id !== rec.id)]
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, HANDOFF_INDEX_CAP)
}

/** The newest unconsumed handoff for this project made within the last 7 days, if any. */
export function pendingFor(index: readonly RelayHandoff[], key: string, now: number): RelayHandoff | undefined {
  let best: RelayHandoff | undefined
  for (const one of index) {
    if (one.projectKey !== key || one.consumedAt !== undefined) continue
    if (now - one.createdAt >= HANDOFF_MAX_AGE_MS) continue
    if (best === undefined || one.createdAt > best.createdAt) best = one
  }
  return best
}

/** Marks a handoff consumed at `now`; an already consumed one keeps its first time. */
export function markConsumed(index: readonly RelayHandoff[], id: string, now: number): RelayHandoff[] {
  return index.map(one => (one.id === id && one.consumedAt === undefined ? { ...one, consumedAt: now } : one))
}

/** The index as kept in the store, with anything that is not a well-formed record dropped. */
export function readIndex(value: unknown): RelayHandoff[] {
  if (!Array.isArray(value)) return []
  return value.filter(
    (one): one is RelayHandoff =>
      typeof one === 'object' &&
      one !== null &&
      typeof (one as RelayHandoff).id === 'string' &&
      typeof (one as RelayHandoff).projectKey === 'string' &&
      typeof (one as RelayHandoff).title === 'string' &&
      typeof (one as RelayHandoff).path === 'string' &&
      typeof (one as RelayHandoff).createdAt === 'number',
  )
}

/** How many handoffs `/handoff list` shows. */
export const HANDOFF_LIST_COUNT = 20

/** `/handoff list`: the last 20 handoffs, this project's first, newest first within each group. */
export function handoffListText(index: readonly RelayHandoff[], key: string, now: number): string {
  if (index.length === 0) return 'No handoffs yet. Type /handoff to write one.'
  const newest = [...index].sort((a, b) => b.createdAt - a.createdAt)
  const ordered = [...newest.filter(one => one.projectKey === key), ...newest.filter(one => one.projectKey !== key)]
  const lines = ordered.slice(0, HANDOFF_LIST_COUNT).map(one => {
    const where = one.path === '' ? '(no file)' : one.path
    const state = one.consumedAt === undefined ? 'waiting' : 'used'
    return `• ${one.title} — ${formatAgo(now - one.createdAt)} — ${where} — ${state}`
  })
  return ['Handoffs (this project first):', ...lines].join('\n')
}

/** The pending offer's text: `Handoff waiting: "<title>" · from 10h ago`. */
export function offerText(one: Pick<RelayHandoff, 'title' | 'createdAt'>, now: number): string {
  return `Handoff waiting: "${one.title}" · from ${formatAgo(now - one.createdAt)}`
}

/** The status card's "Waiting handoffs" line for this project: `"<title>" · from 10h ago`, or `none`. */
export function pendingLine(index: readonly RelayHandoff[], key: string, now: number): string {
  const one = pendingFor(index, key, now)
  return one === undefined ? 'none' : `"${one.title}" · from ${formatAgo(now - one.createdAt)}`
}

// ---------------------------------------------------------------------------
// Handoff flow texts
// ---------------------------------------------------------------------------

/** How long a "fill after clear" marker stays good. */
export const FILL_MAX_AGE_MS = 10 * MINUTE_MS

/**
 * The cold-cache confirmation: `Cache is cold — writing the handoff re-writes ~240k tokens (≈ $4.80).`,
 * tokens only when the model's price is unknown.
 */
export function coldHandoffText(tokens: number, usd: number | undefined): string {
  const cost = usd === undefined ? '' : ` (≈ ${formatUsd(usd)})`
  return `Cache is cold — writing the handoff re-writes ~${formatTokens(tokens)} tokens${cost}.`
}

/** Why the handoff fork gave no text, in plain words. */
export function forkFailureText(reason: string, status?: number): string {
  switch (reason) {
    case 'nothing-to-fork':
      return 'Nothing to hand off yet — no replies in this session.'
    case 'api-error':
      return `The handoff could not be written: the API answered with an error${typeof status === 'number' ? ` (${status})` : ''}.`
    case 'empty-reply':
      return 'The handoff came back empty. Try again.'
    case 'aborted':
      return 'Writing the handoff was interrupted.'
    default:
      return `The handoff could not be written (${reason}).`
  }
}

/** A file in a folder, joined with the separator the folder uses. */
export function joinPath(dir: string, name: string): string {
  const sep = dir.includes('\\') ? '\\' : '/'
  return `${dir.replace(/[\\/]+$/, '')}${sep}${name}`
}

/** What goes in the prompt box after a clear: the handoff, then a held prompt below a rule when there is one. */
export function fillText(text: string, heldText?: string): string {
  return heldText !== undefined && heldText.trim() !== '' ? `${text}\n\n---\n${heldText}` : text
}

// ---------------------------------------------------------------------------
// Warming and the cold-cache guard
// ---------------------------------------------------------------------------

/** The warming ping: as short as a fork can be asked (a fork takes no token cap). */
export const PING_PROMPT = 'Reply with the single word: warm'

/** The four token counts a fork's usage reports. */
export type ForkUsage = {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
}

/**
 * What a ping billed: the cache read, any cache write, uncached input at the base
 * rate (half the 1-hour write rate) and the output.
 * Adapted from cache-tax's pingUsd (MIT License, Copyright (c) 2026 Karan Bansal).
 */
export function pingUsd(usage: ForkUsage, price: ModelPrice): number {
  return (
    (usage.cache_read_input_tokens * price.read +
      usage.cache_creation_input_tokens * price.write +
      (usage.input_tokens * price.write) / 2 +
      usage.output_tokens * price.output) /
    1_000_000
  )
}

/**
 * Why a ping's receipt means warming should stop, or undefined when it read the cache:
 * nothing read (the cache was gone), or a write of a tenth of the read or more (the
 * prefix was not reused). The 10% rule is cache-tax's (MIT, (c) 2026 Karan Bansal).
 */
export function pingProblem(read: number, write: number): string | undefined {
  if (read === 0) return 'the ping read no cache'
  if (write >= 0.1 * read) return `the ping re-wrote ${formatTokens(write)} tokens`
  return undefined
}

/** A failed ping (or the overnight handoff's fork) in a few words for the row. */
export function forkStopReason(reason: string, status?: number): string {
  switch (reason) {
    case 'nothing-to-fork':
      return 'no conversation to warm'
    case 'api-error':
      return `API error${typeof status === 'number' ? ` (${status})` : ''}`
    case 'empty-reply':
      return 'an empty reply'
    case 'aborted':
      return 'interrupted'
    default:
      return reason
  }
}

/** Whether a window is armed at `now`. */
export function isWarming(w: RelayWarming | null | undefined, now: number): boolean {
  return w !== null && w !== undefined && w.windowEnd !== null && now < w.windowEnd
}

/**
 * What the meter row appends: ` · warming · next ping 12m` while armed (` · warming · ends 12m`
 * once the window has no room for another ping), ` · warming stopped: <reason>` after a stop
 * until the next reply, else nothing.
 */
export function warmingSuffix(w: RelayWarming | null | undefined, now: number): string | undefined {
  if (w === null || w === undefined) return undefined
  if (isWarming(w, now) && w.windowEnd !== null) {
    if (w.nextPingAt !== undefined && w.nextPingAt < w.windowEnd) return ` · warming · next ping ${formatSpan(w.nextPingAt - now)}`
    return ` · warming · ends ${formatSpan(w.windowEnd - now)}`
  }
  return w.stopped !== undefined ? ` · warming stopped: ${w.stopped}` : undefined
}

/** A receipt in words: `last ping 38m ago read 231k, wrote 120 ($0.12)`. */
export function receiptText(r: RelayPingReceipt, now: number): string {
  const usd = r.usd === undefined ? '' : ` (${formatUsd(r.usd)})`
  return `last ping ${formatAgo(now - r.at)} read ${formatTokens(r.read)}, wrote ${formatTokens(r.write)}${usd}`
}

/** The status card's warming line: the window, the next ping, the last receipt and the overnight setting. */
export function warmingLine(w: RelayWarming | null | undefined, now: number, overnight: boolean): string {
  const parts: string[] = []
  if (w?.off === true && !isWarming(w, now)) parts.push('off for this session (/keepwarm 2h warms again)')
  else if (isWarming(w, now) && w && w.windowEnd !== null) {
    parts.push(`on, window ends in ${formatSpan(w.windowEnd - now)}`)
    parts.push(
      w.nextPingAt === undefined
        ? 'next ping 50m after the next reply'
        : w.nextPingAt < w.windowEnd
          ? `next ping in ${formatSpan(w.nextPingAt - now)}`
          : 'no more pings in this window',
    )
  } else if (w?.stopped !== undefined) parts.push(`stopped: ${w.stopped}`)
  else parts.push(`idle (each reply arms ${formatSpan(WARM_WINDOW_MS)} once context is ${formatTokens(MIN_WARM_TOKENS)}+)`)
  if (w?.last !== undefined) parts.push(receiptText(w.last, now))
  parts.push(`overnight handoff ${overnight ? 'on' : 'off'}`)
  return parts.join(' · ')
}

/** The guard's row: `Cache went cold 9h ago. Sending this re-writes ~240k tokens (≈ $4.80).`, tokens only for an unknown price. */
export function coldGuardText(coldForMs: number, tokens: number, usd: number | undefined): string {
  const cost = usd === undefined ? '' : ` (≈ ${formatUsd(usd)})`
  return `Cache went cold ${formatAgo(coldForMs)}. Sending this re-writes ~${formatTokens(tokens)} tokens${cost}.`
}

/** What the person sees where the held prompt would have gone (the drop reason). */
export function coldDropText(row: string): string {
  return `Relay held this prompt: ${row.charAt(0).toLowerCase()}${row.slice(1)} Choose Handoff & start fresh or Send anyway on the Relay row above the prompt, or send it again to pay it.`
}

/** `/keepwarm`'s help line. */
export const KEEPWARM_HELP = 'keepwarm takes a window such as 90m, 2h or 2h30m (max 12h), or off, or status.'

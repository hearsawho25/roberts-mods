import type { PromptSubmitInput } from 'claude-code'

import type { RelayWarming } from '../types'
import { MIN_WARM_TOKENS, PING_IDLE_MS, WARM_WINDOW_MS, cacheState, formatSpan, formatTokens } from './core'

/**
 * Relay's cache warming and cold-cache guard, the decisions: what a reply does to
 * the window, what the timer does when it fires, what `/keepwarm` sets, and whether
 * the guard holds a prompt. Nothing here touches `$` (the validator follows `$` only
 * into functions of the file that holds the hook), so register.tsx does the calls
 * and this file is tested directly. The ping loop, its stop rules and the guard's
 * hold-once-then-let-through are adapted from the cache-tax mod
 * (MIT License, Copyright (c) 2026 Karan Bansal).
 */

/** No window, warming not switched off. */
export const NO_WARMING: RelayWarming = { windowEnd: null, off: false }

/** A stored RelayWarming (`relay.warming.<session id>`), or undefined when the value is not one. */
export function readWarming(value: unknown): RelayWarming | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const w = value as RelayWarming
  if (!(w.windowEnd === null || typeof w.windowEnd === 'number') || typeof w.off !== 'boolean') return undefined
  return w
}

/** A restored window that already ended is dropped (its `off` and receipt stay). */
export function restoredWarming(w: RelayWarming, now: number): RelayWarming {
  return w.windowEnd !== null && w.windowEnd <= now ? { ...w, windowEnd: null, nextPingAt: undefined } : w
}

/** When the timer should fire: the next ping, or the window's end when no ping is due before it. */
export function dueAt(w: RelayWarming | null | undefined): number | undefined {
  if (w === null || w === undefined || w.windowEnd === null) return undefined
  return w.nextPingAt !== undefined ? Math.min(w.nextPingAt, w.windowEnd) : w.windowEnd
}

/** Whether the store should keep this warming (a window, or `/keepwarm off`); else its key is deleted. */
export function isWorthKeeping(w: RelayWarming): boolean {
  return w.windowEnd !== null || w.off
}

/** The window stopped, with a reason the row shows until the next reply. */
export function stopped(w: RelayWarming, reason: string, extra: Partial<RelayWarming> = {}): RelayWarming {
  return { ...w, ...extra, windowEnd: null, nextPingAt: undefined, stopped: reason }
}

/**
 * A main-thread reply landed at `now`: the stop reason clears, and (Relay on, not
 * `/keepwarm off`, context ≥ 50k) the window is armed or extended to two hours from
 * now with the next ping 50 idle minutes out. A longer window `/keepwarm` set stays.
 */
export function afterReply(w: RelayWarming, facts: { now: number; enabled: boolean; tokens: number | undefined }): RelayWarming {
  const base: RelayWarming = { ...w, lastTurnAt: facts.now, stopped: undefined }
  const canWarm = typeof facts.tokens === 'number' && facts.tokens >= MIN_WARM_TOKENS
  if (!facts.enabled || w.off || !canWarm) return { ...base, windowEnd: null, nextPingAt: undefined }
  return { ...base, windowEnd: Math.max(w.windowEnd ?? 0, facts.now + WARM_WINDOW_MS), nextPingAt: facts.now + PING_IDLE_MS }
}

/** What the timer does when it fires. */
export type DueAction =
  /** Nothing armed. */
  | { kind: 'none' }
  /** Relay was switched off: drop the window quietly. */
  | { kind: 'drop' }
  /** Stop, with the reason for the row. */
  | { kind: 'stop'; reason: string }
  /**
   * A reply moved the ping since the timer was set, or a main-thread turn is running:
   * set it again (the timer is not armed while a turn runs; the turn's end arms it).
   */
  | { kind: 'rearm' }
  /** Ping; `isLast` when the next one would fall at or after the window's end. */
  | { kind: 'ping'; isLast: boolean }
  /**
   * The window ended with no ping left in it while the cache is still warm (a
   * `/keepwarm` window shorter than the first ping, or overnight handoff off): the
   * overnight handoff may run now; otherwise it stops with `reason`.
   */
  | { kind: 'end'; reason: string }

export function dueAction(facts: {
  w: RelayWarming | null
  enabled: boolean
  lastResponseAt: number | null
  tokens: number | undefined
  now: number
  /** A main-thread turn is running: no ping and no handoff mid-turn. */
  isTurnRunning?: boolean
}): DueAction {
  const { w, now } = facts
  if (w === null || w.windowEnd === null) return { kind: 'none' }
  if (!facts.enabled) return { kind: 'drop' }
  if (facts.isTurnRunning === true) return { kind: 'rearm' }
  const cache = cacheState(facts.lastResponseAt ?? undefined, now)
  const isLive = cache.state === 'warm' || cache.state === 'cooling'
  const isBig = typeof facts.tokens === 'number' && facts.tokens >= MIN_WARM_TOKENS
  if (now >= w.windowEnd) {
    const hadNoPingLeft = w.nextPingAt !== undefined && w.nextPingAt >= w.windowEnd
    return hadNoPingLeft && isLive && isBig ? { kind: 'end', reason: 'the window ended' } : { kind: 'stop', reason: 'the window ended' }
  }
  if (w.nextPingAt === undefined || now < w.nextPingAt - 1000) return { kind: 'rearm' }
  // Never pay a write to "warm" a cache that is already gone.
  if (!isLive) return { kind: 'stop', reason: 'the cache is already cold' }
  if (!isBig) return { kind: 'stop', reason: `context under ${formatTokens(MIN_WARM_TOKENS)}` }
  return { kind: 'ping', isLast: now + PING_IDLE_MS >= w.windowEnd }
}

/** What `/keepwarm <duration>` sets: the window from now, the first ping 50 minutes after the last reply (or after the next one). */
export function keepwarmWindow(
  w: RelayWarming,
  facts: { now: number; ms: number; lastResponseAt: number | null },
): { warming: RelayWarming; text: string } {
  const { now, ms, lastResponseAt } = facts
  const cache = cacheState(lastResponseAt ?? undefined, now)
  const isLive = lastResponseAt !== null && (cache.state === 'warm' || cache.state === 'cooling')
  const nextPingAt = isLive ? Math.max(now, lastResponseAt + PING_IDLE_MS) : undefined
  const warming: RelayWarming = { ...w, off: false, stopped: undefined, windowEnd: now + ms, nextPingAt }
  const text =
    nextPingAt === undefined
      ? `Relay keeps the cache warm for ${formatSpan(ms)}. The cache is ${cache.state} now, so the first ping comes ${formatSpan(PING_IDLE_MS)} after the next reply.`
      : `Relay keeps the cache warm for ${formatSpan(ms)}, a ping after each ${formatSpan(PING_IDLE_MS)} idle. Next ping in ${formatSpan(nextPingAt - now)}.`
  return { warming, text }
}

/**
 * Whether the guard looks at a submission at all: the person's own typed prompt (the
 * terminal's Enter or Remote Control), not a slash command, not bash mode (`!`), not
 * one typed over a running turn, not empty. Not one with attachments, context a hook
 * attached, or an `@` mention either: Send anyway resubmits bare text and could not
 * carry them. A plugin's prompt (Relay's own Send anyway included) is never held.
 */
export function isGuardable(e: Pick<PromptSubmitInput, 'origin' | 'turnId' | 'attachments' | 'text' | 'context'>): boolean {
  if (e.origin.kind !== 'composer' && e.origin.kind !== 'bridge') return false
  if (e.turnId !== undefined || (e.attachments?.length ?? 0) > 0 || (e.context?.length ?? 0) > 0) return false
  const text = e.text.trimStart()
  if (text === '' || text.startsWith('/') || text.startsWith('!')) return false
  return !/(^|\s)@\S/.test(e.text)
}

/** How long a `/keepwarm off` is kept in the store. */
export const OFF_KEEP_MS = 3 * 24 * 60 * 60 * 1000
/** How long a held prompt is kept in the store. */
export const HELD_KEEP_MS = 7 * 24 * 60 * 60 * 1000
export const WARMING_KEY_PREFIX = 'relay.warming.'
export const HELD_KEY_PREFIX = 'relay.heldText.'

/** A held prompt as kept in the store under `relay.heldText.<session id>`. */
export type StoredHeld = { text: string; at: number }

export function readHeld(value: unknown): StoredHeld | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const held = value as StoredHeld
  return typeof held.text === 'string' && typeof held.at === 'number' ? held : undefined
}

/**
 * Whether a session-start sweep deletes a store entry: a warming record whose window
 * has passed (or a `/keepwarm off` older than 3 days, or one with no `offAt`), a held
 * prompt older than 7 days, and anything under those prefixes that is not well formed.
 * Other keys are never touched.
 */
export function isStale(key: string, value: unknown, now: number): boolean {
  if (key.startsWith(WARMING_KEY_PREFIX)) {
    const w = readWarming(value)
    if (w === undefined) return true
    if (w.windowEnd !== null && w.windowEnd > now) return false
    if (w.off) return w.offAt === undefined || now - w.offAt >= OFF_KEEP_MS
    return true
  }
  if (key.startsWith(HELD_KEY_PREFIX)) {
    const held = readHeld(value)
    return held === undefined || now - held.at >= HELD_KEEP_MS
  }
  return false
}

/**
 * The guard's verdict on a guardable prompt: `pass` (Relay off, small or warm),
 * `release` (held once already this cold episode: it goes through and the row goes),
 * or `hold`. The episode is the `lastResponseAt` the cache went cold from.
 */
export function guardVerdict(facts: {
  enabled: boolean
  tokens: number | undefined
  lastResponseAt: number | null
  episode: number | null
  now: number
}): 'pass' | 'release' | 'hold' {
  if (!facts.enabled || facts.lastResponseAt === null) return 'pass'
  if (!(typeof facts.tokens === 'number' && facts.tokens >= MIN_WARM_TOKENS)) return 'pass'
  if (cacheState(facts.lastResponseAt, facts.now).state !== 'cold') return 'pass'
  return facts.episode === facts.lastResponseAt ? 'release' : 'hold'
}

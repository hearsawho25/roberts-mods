import type { Progress } from '../types'

import { BY_ID, CHALLENGES, TOTAL, type Challenge } from './challenges'

export const EMPTY: Progress = { completed: {}, swap: null }

const DAY = /^\d{4}-\d{2}-\d{2}$/

/** Reads whatever the store held into a clean Progress, dropping anything unknown. */
export function normalize(raw: unknown): Progress {
  if (typeof raw !== 'object' || raw === null) return EMPTY
  const source = raw as { completed?: unknown; swap?: unknown }
  const completed: Record<string, string> = {}
  if (typeof source.completed === 'object' && source.completed !== null) {
    for (const [id, day] of Object.entries(source.completed)) {
      if (BY_ID.has(id) && typeof day === 'string' && DAY.test(day)) completed[id] = day
    }
  }
  const swap = source.swap as { day?: unknown; id?: unknown } | null | undefined
  const isSwap =
    typeof swap === 'object' &&
    swap !== null &&
    typeof swap.day === 'string' &&
    typeof swap.id === 'string' &&
    BY_ID.has(swap.id)

  return { completed, swap: isSwap ? { day: swap.day as string, id: swap.id as string } : null }
}

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

function keyOf(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

function dateOf(day: string): Date {
  const [year = 1970, month = 1, date = 1] = day.split('-').map(Number)
  return new Date(year, month - 1, date, 12)
}

/** The local calendar day of an instant, as YYYY-MM-DD. */
export function dayKey(ms: number): string {
  return keyOf(new Date(ms))
}

export function shiftDay(day: string, days: number): string {
  const date = dateOf(day)
  date.setDate(date.getDate() + days)
  return keyOf(date)
}

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

export function weekdayName(day: string): string {
  return WEEKDAYS[dateOf(day).getDay()] ?? ''
}

/** `Mon 12 Oct 2026`, or `12 Oct` when short. */
export function formatDay(day: string, isShort = false): string {
  const date = dateOf(day)
  const month = MONTHS[date.getMonth()] ?? ''
  if (isShort) return `${date.getDate()} ${month}`
  return `${weekdayName(day).slice(0, 3)} ${date.getDate()} ${month} ${date.getFullYear()}`
}

export function remaining(progress: Progress): Challenge[] {
  return CHALLENGES.filter(one => progress.completed[one.id] === undefined)
}

export function doneCount(progress: Progress): number {
  return Object.keys(progress.completed).length
}

export function completedOn(progress: Progress, day: string): Challenge | undefined {
  const id = Object.keys(progress.completed).find(key => progress.completed[key] === day)
  return id === undefined ? undefined : BY_ID.get(id)
}

export type Today = {
  /** Today's challenge; undefined once all are done and none was completed today. */
  challenge: Challenge | undefined
  isDone: boolean
  isFinished: boolean
}

/**
 * Today's challenge: the one completed today if any, else today's swap if it
 * is still open, else the first in dealt order that was never completed.
 */
export function todayOf(progress: Progress, today: string): Today {
  const done = completedOn(progress, today)
  const isFinished = doneCount(progress) >= TOTAL
  if (done !== undefined) return { challenge: done, isDone: true, isFinished }
  const swap = progress.swap
  if (swap !== null && swap.day === today && progress.completed[swap.id] === undefined) {
    return { challenge: BY_ID.get(swap.id), isDone: false, isFinished }
  }
  return { challenge: remaining(progress)[0], isDone: false, isFinished }
}

export function canSwap(progress: Progress, today: string): boolean {
  const now = todayOf(progress, today)
  return !now.isDone && now.challenge !== undefined && remaining(progress).length > 1
}

/** Swaps today's challenge for a random one never completed; null when there is nothing to swap to. */
export function swapToday(progress: Progress, today: string, random: () => number): Progress | null {
  if (!canSwap(progress, today)) return null
  const current = todayOf(progress, today).challenge
  const pool = remaining(progress).filter(one => one.id !== current?.id)
  const pick = pool[Math.min(pool.length - 1, Math.floor(random() * pool.length))]
  if (pick === undefined) return null
  return { ...progress, swap: { day: today, id: pick.id } }
}

/** Marks today's challenge complete; null when today is already done or nothing is left. */
export function completeToday(progress: Progress, today: string): Progress | null {
  const now = todayOf(progress, today)
  if (now.isDone || now.challenge === undefined) return null
  return { ...progress, completed: { ...progress.completed, [now.challenge.id]: today } }
}

/** Takes back today's completion; null when nothing was completed today. */
export function undoToday(progress: Progress, today: string): Progress | null {
  const ids = Object.keys(progress.completed).filter(id => progress.completed[id] === today)
  if (ids.length === 0) return null
  const completed = { ...progress.completed }
  for (const id of ids) delete completed[id]
  return { ...progress, completed }
}

function activeDays(progress: Progress): Set<string> {
  return new Set(Object.values(progress.completed))
}

/** Days in a row with a completion, ending today, or ending yesterday while today is still open. */
export function streak(progress: Progress, today: string): number {
  const days = activeDays(progress)
  let day = days.has(today) ? today : shiftDay(today, -1)
  let count = 0
  while (days.has(day)) {
    count += 1
    day = shiftDay(day, -1)
  }
  return count
}

export function bestStreak(progress: Progress): number {
  const days = [...activeDays(progress)].sort()
  let best = 0
  let run = 0
  let previous: string | undefined
  for (const day of days) {
    run = previous !== undefined && shiftDay(previous, 1) === day ? run + 1 : 1
    best = Math.max(best, run)
    previous = day
  }
  return best
}

export type DayCell = { day: string; weekday: string; isDone: boolean; isToday: boolean }

/** The last `count` days, oldest first, ending today. */
export function lastDays(progress: Progress, today: string, count: number): DayCell[] {
  const days = activeDays(progress)
  const cells: DayCell[] = []
  for (let back = count - 1; back >= 0; back--) {
    const day = shiftDay(today, -back)
    cells.push({ day, weekday: weekdayName(day), isDone: days.has(day), isToday: back === 0 })
  }
  return cells
}

export function coachPrompt(challenge: Challenge): string {
  return [
    `Please coach me through today's Claude Code challenge, one step at a time.`,
    `After each step, stop and wait for me to tell you I am ready before you give the next one.`,
    '',
    `Challenge: ${challenge.title}`,
    challenge.task,
  ].join('\n')
}

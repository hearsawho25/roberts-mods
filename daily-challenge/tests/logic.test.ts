import { describe, expect, test } from 'claude-code/testing'

import type { Progress } from '../types'
import { CHALLENGES } from '../hooks/challenges'
import {
  EMPTY,
  bestStreak,
  canSwap,
  completeToday,
  normalize,
  shiftDay,
  streak,
  swapToday,
  todayOf,
  undoToday,
} from '../hooks/logic'

const DAY = '2026-10-12'

/** A seeded generator, so the random swap is the same on every run. */
function seeded(seed: number): () => number {
  let state = seed
  return () => {
    state = (state * 1103515245 + 12345) % 2147483648
    return state / 2147483648
  }
}

function completing(ids: readonly string[], day = '2026-01-01'): Progress {
  const completed: Record<string, string> = {}
  for (const id of ids) completed[id] = day
  return { completed, swap: null }
}

describe('the daily pick', () => {
  test('starts at the first challenge', () => {
    expect(todayOf(EMPTY, DAY).challenge?.id).toBe(CHALLENGES[0]?.id)
  })

  test('is always the next one never completed, in order', () => {
    let progress = EMPTY
    let day = DAY
    for (let index = 0; index < 30; index++) {
      const pick = todayOf(progress, day).challenge
      expect(pick?.id).toBe(CHALLENGES[index]?.id)
      expect(progress.completed[pick?.id ?? '']).toBeUndefined()
      progress = completeToday(progress, day) ?? progress
      day = shiftDay(day, 1)
    }
  })

  test('skips a completed challenge even out of order', () => {
    const progress = completing([CHALLENGES[0]!.id, CHALLENGES[1]!.id, CHALLENGES[3]!.id])
    expect(todayOf(progress, DAY).challenge?.id).toBe(CHALLENGES[2]?.id)
  })

  test('waits for you when a day is missed', () => {
    const progress = completeToday(EMPTY, DAY)!
    const waiting = todayOf(progress, shiftDay(DAY, 1)).challenge
    expect(todayOf(progress, shiftDay(DAY, 5)).challenge?.id).toBe(waiting?.id)
  })

  test('shows today as done once completed, and only one per day', () => {
    const progress = completeToday(EMPTY, DAY)!
    const now = todayOf(progress, DAY)
    expect(now.isDone).toBe(true)
    expect(now.challenge?.id).toBe(CHALLENGES[0]?.id)
    expect(completeToday(progress, DAY)).toBeNull()
  })

  test('undo takes back only today', () => {
    const yesterday = completeToday(EMPTY, shiftDay(DAY, -1))!
    const both = completeToday(yesterday, DAY)!
    const undone = undoToday(both, DAY)!
    expect(Object.keys(undone.completed)).toHaveLength(1)
    expect(todayOf(undone, DAY).isDone).toBe(false)
    expect(undoToday(undone, DAY)).toBeNull()
  })
})

describe('give me another', () => {
  test('never offers a completed challenge and is kept for the day', () => {
    const random = seeded(7)
    let progress = completing(CHALLENGES.filter((_, index) => index % 3 === 0).map(one => one.id))
    for (let round = 0; round < 200; round++) {
      const before = todayOf(progress, DAY).challenge
      const swapped = swapToday(progress, DAY, random)
      expect(swapped).not.toBeNull()
      progress = swapped!
      const after = todayOf(progress, DAY).challenge!
      expect(after.id).not.toBe(before?.id)
      expect(progress.completed[after.id]).toBeUndefined()
    }
    expect(todayOf(progress, DAY).challenge?.id).toBe(progress.swap?.id)
  })

  test('the swap is forgotten the next day', () => {
    const swapped = swapToday(EMPTY, DAY, () => 0.5)!
    expect(todayOf(swapped, DAY).challenge?.id).not.toBe(CHALLENGES[0]?.id)
    expect(todayOf(swapped, shiftDay(DAY, 1)).challenge?.id).toBe(CHALLENGES[0]?.id)
  })

  test('a swapped challenge completed later is never offered again', () => {
    const swapped = swapToday(EMPTY, DAY, () => 0.5)!
    const chosen = swapped.swap!.id
    const done = completeToday(swapped, DAY)!
    expect(done.completed[chosen]).toBe(DAY)
    for (let offset = 1; offset < 40; offset++) {
      expect(todayOf(done, shiftDay(DAY, offset)).challenge?.id).not.toBe(chosen)
    }
  })

  test('is not offered when one or none is left, or once today is done', () => {
    const allButOne = completing(CHALLENGES.slice(1).map(one => one.id))
    expect(canSwap(allButOne, DAY)).toBe(false)
    expect(swapToday(allButOne, DAY, Math.random)).toBeNull()
    expect(canSwap(completeToday(EMPTY, DAY)!, DAY)).toBe(false)
  })
})

describe('the finished state', () => {
  test('after all 365 there is no challenge and nothing to swap', () => {
    const all = completing(CHALLENGES.map(one => one.id))
    const now = todayOf(all, DAY)
    expect(now.challenge).toBeUndefined()
    expect(now.isFinished).toBe(true)
    expect(completeToday(all, DAY)).toBeNull()
    expect(swapToday(all, DAY, Math.random)).toBeNull()
  })

  test('the last one completed today still shows as done today', () => {
    const allButLast = completing(CHALLENGES.slice(0, 364).map(one => one.id))
    const last = completeToday(allButLast, DAY)!
    const now = todayOf(last, DAY)
    expect(now.isFinished).toBe(true)
    expect(now.isDone).toBe(true)
    expect(now.challenge?.isCloser).toBe(true)
  })
})

describe('streaks', () => {
  const on = (offsets: readonly number[]): Progress => {
    const completed: Record<string, string> = {}
    offsets.forEach((offset, index) => {
      completed[CHALLENGES[index]!.id] = shiftDay(DAY, offset)
    })
    return { completed, swap: null }
  }

  test('counts days in a row ending today', () => {
    expect(streak(on([-2, -1, 0]), DAY)).toBe(3)
  })

  test('still counts through yesterday before today is done', () => {
    expect(streak(on([-3, -2, -1]), DAY)).toBe(3)
  })

  test('resets after a missed day', () => {
    expect(streak(on([-5, -4, -3, -1, 0]), DAY)).toBe(2)
    expect(streak(on([-5, -4, -3]), DAY)).toBe(0)
  })

  test('best streak is the longest run ever', () => {
    expect(bestStreak(on([-20, -19, -18, -17, -10, -9, 0]))).toBe(4)
    expect(bestStreak(EMPTY)).toBe(0)
  })

  test('crosses month and year ends', () => {
    const days = ['2025-12-30', '2025-12-31', '2026-01-01', '2026-01-02']
    const completed: Record<string, string> = {}
    days.forEach((day, index) => {
      completed[CHALLENGES[index]!.id] = day
    })
    expect(streak({ completed, swap: null }, '2026-01-02')).toBe(4)
    expect(shiftDay('2026-03-01', -1)).toBe('2026-02-28')
  })

  test('a streak built day by day', () => {
    let progress = EMPTY
    for (let offset = 0; offset < 10; offset++) {
      progress = completeToday(progress, shiftDay(DAY, offset))!
      expect(streak(progress, shiftDay(DAY, offset))).toBe(offset + 1)
    }
    expect(streak(progress, shiftDay(DAY, 11))).toBe(0)
    expect(bestStreak(progress)).toBe(10)
  })
})

test('stored data is read safely', () => {
  expect(normalize(undefined)).toEqual(EMPTY)
  expect(normalize({ completed: { nope: DAY, [CHALLENGES[0]!.id]: DAY }, swap: { day: DAY, id: 'nope' } })).toEqual({
    completed: { [CHALLENGES[0]!.id]: DAY },
    swap: null,
  })
})

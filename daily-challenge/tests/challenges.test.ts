import { describe, expect, test } from 'claude-code/testing'

import { CHALLENGES, PER_THEME, THEMES, TOTAL } from '../hooks/challenges'

const normal = (text: string) => text.trim().toLowerCase().replace(/\s+/g, ' ')

describe('the 365 challenges', () => {
  test('there are exactly 365', () => {
    expect(TOTAL).toBe(365)
    expect(CHALLENGES).toHaveLength(365)
  })

  test('every id, title and task is different', () => {
    expect(new Set(CHALLENGES.map(one => one.id)).size).toBe(365)
    expect(new Set(CHALLENGES.map(one => normal(one.title))).size).toBe(365)
    expect(new Set(CHALLENGES.map(one => normal(one.task))).size).toBe(365)
  })

  test('seven themes of 52, plus one closer on the last day', () => {
    expect(THEMES).toHaveLength(7)
    for (const theme of THEMES) {
      const count = CHALLENGES.filter(one => one.theme === theme.id && !one.isCloser).length
      expect(count, theme.id).toBe(PER_THEME)
    }
    const closers = CHALLENGES.filter(one => one.isCloser)
    expect(closers).toHaveLength(1)
    expect(CHALLENGES[364]?.isCloser).toBe(true)
  })

  test('any seven days in a row touch all seven themes', () => {
    for (let start = 0; start + 7 <= CHALLENGES.length; start++) {
      const week = new Set(CHALLENGES.slice(start, start + 7).map(one => one.theme))
      expect(week.size, `days ${start + 1} to ${start + 7}`).toBe(7)
    }
  })

  test('the themes are dealt in turn', () => {
    CHALLENGES.slice(0, 364).forEach((one, index) => {
      expect(one.theme).toBe(THEMES[index % 7]?.id)
    })
  })

  test('titles are two to five words and tasks one or two sentences', () => {
    for (const one of CHALLENGES) {
      const words = one.title.split(/\s+/).length
      expect(words >= 2 && words <= 5, `title "${one.title}" has ${words} words`).toBe(true)
      const sentences = one.task.split(/[.?!](?:\s|$)/).filter(part => part.trim() !== '').length
      expect(sentences >= 1 && sentences <= 2, `task of "${one.title}" has ${sentences} sentences`).toBe(true)
      expect(one.task.endsWith('.'), one.title).toBe(true)
    }
  })

  test('nothing talks down to the person', () => {
    const words = /\b(lazy|dumb|stupid|silly mistakes?|obviously|simply|just do)\b/i
    for (const one of CHALLENGES) {
      expect(words.test(`${one.title} ${one.task}`), one.title).toBe(false)
    }
  })
})

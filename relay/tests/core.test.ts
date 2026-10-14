import { describe, expect, test } from 'claude-code/testing'

import {
  CACHE_TTL_MS,
  COOLING_MS,
  HANDOFF_INDEX_CAP,
  HANDOFF_MAX_AGE_MS,
  HOUR_MS,
  MAX_WINDOW_MS,
  MINUTE_MS,
  addHandoff,
  buildHandoffPrompt,
  cacheState,
  cacheWritePricePerMTok,
  estimateRewriteUsd,
  extractTitle,
  formatAgo,
  formatGitFacts,
  formatSpan,
  formatTokens,
  formatUsd,
  handoffDir,
  handoffFileName,
  markConsumed,
  meterBar,
  modelPrice,
  parseDuration,
  parseGitFacts,
  parsePorcelainLine,
  pendingFor,
  projectKey,
  shouldOfferHandoff,
  slugify,
  contextPercent,
  contextText,
  meterRow,
  meterRowText,
  statusCard,
  thresholdText,
  coldHandoffText,
  fillText,
  forkFailureText,
  handoffListText,
  joinPath,
  offerText,
  pendingLine,
  readIndex,
} from '../hooks/core'
import type { RelayHandoff } from '../hooks/core'

const NOW = 1_800_000_000_000
const KEY = 'D--Projects-app'

function rec(id: string, createdAt: number, extra: Partial<RelayHandoff> = {}): RelayHandoff {
  return { id, projectKey: KEY, root: 'D:\\Projects\\app', title: id, path: `/h/${id}.md`, createdAt, ...extra }
}

/** Float dollars compared at cent precision. */
function cents(value: number | undefined): number | undefined {
  return value === undefined ? undefined : Math.round(value * 100)
}

describe('shouldOfferHandoff', () => {
  test('stays quiet below both thresholds and with no figures', () => {
    expect(shouldOfferHandoff({ percent: 79, tokens: 299_999, snoozed: false })).toBe(false)
    expect(shouldOfferHandoff({ snoozed: false })).toBe(false)
  })

  test('offers at exactly 80% or exactly 300k, whichever comes first', () => {
    expect(shouldOfferHandoff({ percent: 80, tokens: 10, snoozed: false })).toBe(true)
    expect(shouldOfferHandoff({ percent: 30, tokens: 300_000, snoozed: false })).toBe(true)
    expect(shouldOfferHandoff({ tokens: 300_000, snoozed: false })).toBe(true)
    expect(shouldOfferHandoff({ percent: 80, snoozed: false })).toBe(true)
  })

  test('once snoozed, waits for 90% or 400k', () => {
    expect(shouldOfferHandoff({ percent: 85, tokens: 350_000, snoozed: true })).toBe(false)
    expect(shouldOfferHandoff({ percent: 89, tokens: 399_999, snoozed: true })).toBe(false)
    expect(shouldOfferHandoff({ percent: 90, tokens: 0, snoozed: true })).toBe(true)
    expect(shouldOfferHandoff({ percent: 50, tokens: 400_000, snoozed: true })).toBe(true)
  })
})

describe('cacheState', () => {
  test('unknown before the first response', () => {
    expect(cacheState(undefined, NOW)).toEqual({ state: 'unknown' })
  })

  test('warm with more than 10 minutes left', () => {
    expect(cacheState(NOW - 19 * MINUTE_MS, NOW)).toEqual({ state: 'warm', msLeft: 41 * MINUTE_MS })
    expect(cacheState(NOW - (CACHE_TTL_MS - COOLING_MS - 1), NOW).state).toBe('warm')
  })

  test('cooling at exactly 10 minutes left and below', () => {
    expect(cacheState(NOW - 50 * MINUTE_MS, NOW)).toEqual({ state: 'cooling', msLeft: COOLING_MS })
    expect(cacheState(NOW - (CACHE_TTL_MS - 1), NOW)).toEqual({ state: 'cooling', msLeft: 1 })
  })

  test('cold from the full hour on, with how long', () => {
    expect(cacheState(NOW - CACHE_TTL_MS, NOW)).toEqual({ state: 'cold', coldForMs: 0 })
    expect(cacheState(NOW - 10 * HOUR_MS, NOW)).toEqual({ state: 'cold', coldForMs: 9 * HOUR_MS })
  })

  test('a timestamp in the future counts as just now', () => {
    expect(cacheState(NOW + 5000, NOW)).toEqual({ state: 'warm', msLeft: CACHE_TTL_MS })
  })
})

describe('parseDuration', () => {
  test('reads minutes, hours and both', () => {
    expect(parseDuration('90m')).toBe(90 * MINUTE_MS)
    expect(parseDuration('2h')).toBe(2 * HOUR_MS)
    expect(parseDuration('2h30m')).toBe(150 * MINUTE_MS)
    expect(parseDuration(' 6H ')).toBe(6 * HOUR_MS)
    expect(parseDuration('2h 30m')).toBe(150 * MINUTE_MS)
  })

  test('accepts exactly 12h and rejects anything over it', () => {
    expect(parseDuration('12h')).toBe(MAX_WINDOW_MS)
    expect(parseDuration('720m')).toBe(MAX_WINDOW_MS)
    expect(parseDuration('12h1m')).toBeUndefined()
    expect(parseDuration('13h')).toBeUndefined()
    expect(parseDuration('24h')).toBeUndefined()
  })

  test('rejects nonsense and zero', () => {
    for (const bad of ['', 'off', 'h', 'm', '2', '1.5h', '-2h', '30m2h', '0m', '0h0m', '2d']) {
      expect(parseDuration(bad)).toBeUndefined()
    }
  })
})

describe('formatting', () => {
  test('formatSpan', () => {
    expect(formatSpan(0)).toBe('<1m')
    expect(formatSpan(-5)).toBe('<1m')
    expect(formatSpan(59_999)).toBe('<1m')
    expect(formatSpan(41 * MINUTE_MS)).toBe('41m')
    expect(formatSpan(60 * MINUTE_MS)).toBe('1h')
    expect(formatSpan(125 * MINUTE_MS)).toBe('2h 5m')
    expect(formatSpan(48 * HOUR_MS)).toBe('2d')
    expect(formatSpan(52 * HOUR_MS)).toBe('2d 4h')
  })

  test('formatAgo', () => {
    expect(formatAgo(30_000)).toBe('just now')
    expect(formatAgo(-1)).toBe('just now')
    expect(formatAgo(9 * MINUTE_MS)).toBe('9m ago')
    expect(formatAgo(10 * HOUR_MS + 20 * MINUTE_MS)).toBe('10h ago')
    expect(formatAgo(47 * HOUR_MS)).toBe('47h ago')
    expect(formatAgo(3 * 24 * HOUR_MS)).toBe('3d ago')
  })

  test('formatTokens', () => {
    expect(formatTokens(0)).toBe('0')
    expect(formatTokens(950)).toBe('950')
    expect(formatTokens(1000)).toBe('1k')
    expect(formatTokens(231_400)).toBe('231k')
    expect(formatTokens(999_499)).toBe('999k')
    expect(formatTokens(999_500)).toBe('1M')
    expect(formatTokens(1_200_000)).toBe('1.2M')
    expect(formatTokens(2_000_000)).toBe('2M')
    expect(formatTokens(Number.NaN)).toBe('0')
  })

  test('formatUsd', () => {
    expect(formatUsd(4.8)).toBe('$4.80')
    expect(formatUsd(0.034)).toBe('$0.03')
    expect(formatUsd(120.4)).toBe('$120')
  })

  test('meterBar', () => {
    expect(meterBar(58)).toBe('▰▰▰▰▰▱▱▱')
    expect(meterBar(0)).toBe('▱▱▱▱▱▱▱▱')
    expect(meterBar(100)).toBe('▰▰▰▰▰▰▰▰')
    expect(meterBar(150)).toBe('▰▰▰▰▰▰▰▰')
    expect(meterBar(-3)).toBe('▱▱▱▱▱▱▱▱')
    expect(meterBar(Number.NaN)).toBe('▱▱▱▱▱▱▱▱')
    expect(meterBar(50, 4)).toBe('▰▰▱▱')
    expect(meterBar(80, 0)).toBe('')
  })
})

describe('prices', () => {
  test('matches model ids by family, longer names first', () => {
    expect(cacheWritePricePerMTok('claude-opus-5-5')).toBe(10)
    expect(cacheWritePricePerMTok('Opus 4.7')).toBe(10)
    expect(cacheWritePricePerMTok('claude-sonnet-5')).toBe(4)
    expect(cacheWritePricePerMTok('claude-sonnet-4-6')).toBe(6)
    expect(cacheWritePricePerMTok('claude-haiku-4-5')).toBe(2)
    expect(modelPrice('claude-fable-5-1')?.read).toBe(0.25)
    expect(modelPrice('claude-fable-5')?.read).toBe(1)
  })

  test('unknown or missing model has no price', () => {
    expect(modelPrice('gpt-9')).toBeUndefined()
    expect(modelPrice(undefined)).toBeUndefined()
    expect(modelPrice('')).toBeUndefined()
    expect(cacheWritePricePerMTok('mystery')).toBeUndefined()
    expect(estimateRewriteUsd(240_000, 'mystery-model')).toBeUndefined()
    expect(estimateRewriteUsd(240_000, null)).toBeUndefined()
  })

  test('estimates the cache re-write', () => {
    expect(cents(estimateRewriteUsd(240_000, 'claude-fable-5'))).toBe(480)
    expect(cents(estimateRewriteUsd(240_000, 'claude-opus-5-5'))).toBe(240)
    expect(estimateRewriteUsd(0, 'claude-opus-5-5')).toBe(0)
  })
})

describe('paths and names', () => {
  test('projectKey replaces colon, slashes and spaces', () => {
    expect(projectKey('D:\\Projects\\roberts-mods')).toBe('D--Projects-roberts-mods')
    expect(projectKey('/home/rob/my app')).toBe('-home-rob-my-app')
    expect(projectKey('D:\\Projects\\')).toBe('D--Projects')
  })

  test('projectKey gives one key whatever the drive letter case or slash', () => {
    const key = projectKey('D:\\Projects\\app')
    expect(projectKey('d:\\Projects\\app')).toBe(key)
    expect(projectKey('D:/Projects/app')).toBe(key)
    expect(projectKey('d:/Projects/app/')).toBe(key)
    expect(projectKey('/data/app')).toBe('-data-app')
  })

  test('slugify', () => {
    expect(slugify('Relay: Task 2 — meter row & /relay!')).toBe('relay-task-2-meter-row-relay')
    expect(slugify('   ')).toBe('handoff')
    expect(slugify('***')).toBe('handoff')
    const long = slugify('a'.repeat(49) + ' bcdef')
    expect(long.length).toBeLessThanOrEqual(50)
    expect(long.endsWith('-')).toBe(false)
  })

  test('handoffFileName stamps local date and time', () => {
    expect(handoffFileName(new Date(2026, 9, 14, 9, 5, 7), 'Ship the meter')).toBe('2026-10-14-090507-ship-the-meter.md')
    expect(handoffFileName(new Date(2026, 0, 2, 23, 59, 59), '')).toBe('2026-01-02-235959-handoff.md')
  })

  test('handoffFileName tells apart two handoffs in the same minute', () => {
    const a = handoffFileName(new Date(2026, 9, 14, 9, 5, 1), 'Same title')
    const b = handoffFileName(new Date(2026, 9, 14, 9, 5, 42), 'Same title')
    expect(a === b).toBe(false)
  })

  test('handoffDir keeps the home folder separator', () => {
    expect(handoffDir('C:\\Users\\alex', 'D--Projects-app')).toBe('C:\\Users\\alex\\.claude\\handoffs\\D--Projects-app')
    expect(handoffDir('/home/rob/', 'x')).toBe('/home/rob/.claude/handoffs/x')
  })
})

describe('git facts', () => {
  test('not a repo', () => {
    expect(parseGitFacts({})).toEqual({ isRepo: false })
    expect(parseGitFacts({ branch: '  ' })).toEqual({ isRepo: false })
    expect(formatGitFacts({ isRepo: false })).toEqual([])
  })

  test('a full repo with upstream and changes', () => {
    const porcelain = [' M hooks/core.ts', '?? tests/core.test.ts', 'A  types/index.d.ts'].join('\n')
    const facts = parseGitFacts({
      branch: 'main\n',
      log: 'abc1234 Add relay core\n',
      aheadBehind: '1\t3\n',
      porcelain,
    })
    expect(facts).toEqual({
      isRepo: true,
      branch: 'main',
      head: { sha: 'abc1234', subject: 'Add relay core' },
      upstream: { ahead: 3, behind: 1 },
      changedCount: 3,
      changes: [
        { status: 'M', path: 'hooks/core.ts' },
        { status: '??', path: 'tests/core.test.ts' },
        { status: 'A', path: 'types/index.d.ts' },
      ],
    })
    expect(formatGitFacts(facts)).toEqual([
      '- Branch: `main`',
      '- HEAD: `abc1234` Add relay core',
      '- Upstream: 3 ahead, 1 behind',
      '- Uncommitted changes: 3 files',
      '  - `M` hooks/core.ts',
      '  - `??` tests/core.test.ts',
      '  - `A` types/index.d.ts',
    ])
  })

  test('no upstream, clean tree, Windows line endings', () => {
    const facts = parseGitFacts({ branch: 'feature/x\r\n', log: 'def5678 Fix\r\n', aheadBehind: undefined, porcelain: '' })
    expect(facts).toMatchObject({ isRepo: true, branch: 'feature/x', changedCount: 0 })
    expect(formatGitFacts(facts)).toEqual([
      '- Branch: `feature/x`',
      '- HEAD: `def5678` Fix',
      '- Upstream: none set',
      '- Uncommitted changes: none',
    ])
  })

  test('an upstream error message is not a count', () => {
    const facts = parseGitFacts({ branch: 'main', log: 'a1 x', aheadBehind: 'fatal: no upstream configured', porcelain: '' })
    expect(facts.isRepo && facts.upstream).toBeUndefined()
  })

  test('detached HEAD and no commits yet', () => {
    const facts = parseGitFacts({ branch: 'HEAD', log: '', porcelain: '?? a.txt' })
    const lines = formatGitFacts(facts)
    expect(lines[0]).toBe('- Branch: detached HEAD')
    expect(lines[1]).toBe('- HEAD: no commits yet')
    expect(lines).toContain('- Uncommitted changes: 1 file')
  })

  test('porcelain whose first line lost its leading space to a trim', () => {
    const facts = parseGitFacts({ branch: 'main', log: 'a1 x', porcelain: 'M hooks/core.ts\n M tests/core.test.ts\nMM types/index.d.ts' })
    expect(facts.isRepo && facts.changes).toEqual([
      { status: 'M', path: 'hooks/core.ts' },
      { status: 'M', path: 'tests/core.test.ts' },
      { status: 'MM', path: 'types/index.d.ts' },
    ])
  })

  test('a rename keeps the new path', () => {
    expect(parsePorcelainLine('R  old/name.ts -> new/name.ts')).toEqual({ status: 'R', path: 'new/name.ts' })
    expect(parsePorcelainLine('?? notes.md')).toEqual({ status: '??', path: 'notes.md' })
  })

  test('a repo with no commits names its branch from symbolic-ref', () => {
    const facts = parseGitFacts({ branch: undefined, symbolicRef: 'main\n', log: undefined, porcelain: '?? README.md' })
    expect(facts).toEqual({
      isRepo: true,
      branch: 'main',
      head: undefined,
      upstream: undefined,
      changedCount: 1,
      changes: [{ status: '??', path: 'README.md' }],
    })
    expect(formatGitFacts(facts).slice(0, 2)).toEqual(['- Branch: `main`', '- HEAD: no commits yet'])
    expect(parseGitFacts({ branch: undefined, symbolicRef: undefined })).toEqual({ isRepo: false })
  })

  test('lists the first 10 changes and counts the rest', () => {
    const porcelain = Array.from({ length: 13 }, (_, i) => ` M file${i}.ts`).join('\n')
    const facts = parseGitFacts({ branch: 'main', log: 'a1 x', porcelain })
    const lines = formatGitFacts(facts)
    expect(facts.isRepo && facts.changes.length).toBe(10)
    expect(lines).toContain('- Uncommitted changes: 13 files')
    expect(lines).toContain('  - `M` file9.ts')
    expect(lines).not.toContain('  - `M` file10.ts')
    expect(lines[lines.length - 1]).toBe('  - ...and 3 more')
  })
})

describe('handoff prompt', () => {
  test('asks for the brief layout and carries the git facts verbatim', () => {
    const facts = '- Branch: `main`\n- Upstream: none set'
    const prompt = buildHandoffPrompt(facts)
    for (const part of ['## Where things stand', '## Read first', "## What's next", '## Hard rules', '## How to run it', 'verbatim', facts]) {
      expect(prompt).toContain(part)
    }
    expect(prompt.indexOf('## Where things stand')).toBeLessThan(prompt.indexOf('## How to run it'))
  })

  test('says so when there are no git facts', () => {
    expect(buildHandoffPrompt('  ')).toContain('not a git repository')
  })

  test('extractTitle', () => {
    expect(extractTitle('\n\nShip the Relay meter row\n## Where things stand\n...')).toBe('Ship the Relay meter row')
    expect(extractTitle('# Ship it')).toBe('Ship it')
    expect(extractTitle('**Title: "Ship it"**')).toBe('Ship it')
    expect(extractTitle('Title: **Ship it**')).toBe('Ship it')
    expect(extractTitle('```markdown\nShip it\n## Where things stand\n```')).toBe('Ship it')
    expect(extractTitle('```\n```')).toBe('Handoff')
    expect(extractTitle('## Where things stand\nstuff')).toBe('Handoff')
    expect(extractTitle('')).toBe('Handoff')
    const long = extractTitle('x'.repeat(200))
    expect(long.length).toBe(80)
    expect(long.endsWith('…')).toBe(true)
  })
})

describe('handoff index', () => {
  test('addHandoff puts the newest first and replaces a same id', () => {
    let index = addHandoff([], rec('a', NOW - 2000))
    index = addHandoff(index, rec('b', NOW))
    index = addHandoff(index, rec('c', NOW - 1000))
    expect(index.map(one => one.id)).toEqual(['b', 'c', 'a'])
    index = addHandoff(index, rec('a', NOW - 2000, { title: 'renamed' }))
    expect(index).toHaveLength(3)
    expect(index.find(one => one.id === 'a')?.title).toBe('renamed')
  })

  test('addHandoff caps the index and drops the oldest', () => {
    let index: RelayHandoff[] = []
    for (let i = 0; i < HANDOFF_INDEX_CAP + 5; i++) index = addHandoff(index, rec(`h${i}`, NOW + i))
    expect(index).toHaveLength(HANDOFF_INDEX_CAP)
    expect(index[0]?.id).toBe(`h${HANDOFF_INDEX_CAP + 4}`)
    expect(index.some(one => one.id === 'h0')).toBe(false)
  })

  test('addHandoff does not change the array it was given', () => {
    const before = [rec('a', NOW)]
    addHandoff(before, rec('b', NOW + 1))
    expect(before).toHaveLength(1)
  })

  test('pendingFor finds the newest unconsumed handoff for this project within 7 days', () => {
    const index = [
      rec('other', NOW - 1000, { projectKey: 'elsewhere' }),
      rec('used', NOW - 2000, { consumedAt: NOW - 500 }),
      rec('older', NOW - 5 * HOUR_MS),
      rec('newer', NOW - HOUR_MS),
      rec('stale', NOW - HANDOFF_MAX_AGE_MS),
    ]
    expect(pendingFor(index, KEY, NOW)?.id).toBe('newer')
    expect(pendingFor(index, 'nowhere', NOW)).toBeUndefined()
  })

  test('pendingFor ignores exactly 7 days old and keeps just under', () => {
    expect(pendingFor([rec('edge', NOW - HANDOFF_MAX_AGE_MS)], KEY, NOW)).toBeUndefined()
    expect(pendingFor([rec('edge', NOW - HANDOFF_MAX_AGE_MS + 1)], KEY, NOW)?.id).toBe('edge')
  })

  test('markConsumed stamps once and leaves the rest', () => {
    const index = [rec('a', NOW), rec('b', NOW - 1)]
    const once = markConsumed(index, 'a', NOW + 10)
    expect(once[0]?.consumedAt).toBe(NOW + 10)
    expect(once[1]?.consumedAt).toBeUndefined()
    expect(index[0]?.consumedAt).toBeUndefined()
    const twice = markConsumed(once, 'a', NOW + 99)
    expect(twice[0]?.consumedAt).toBe(NOW + 10)
    expect(markConsumed(index, 'missing', NOW)).toEqual(index)
    expect(pendingFor(once, KEY, NOW + 20)?.id).toBe('b')
  })
})

describe('meter row and status card', () => {
  test('percent comes from the engine, else tokens over window', () => {
    expect(contextPercent({ tokens: 100, percent: 58, window: 1000 })).toBe(58)
    expect(contextPercent({ tokens: 250, window: 1000 })).toBe(25)
    expect(contextPercent({ window: 1000 })).toBeUndefined()
    expect(contextPercent(null)).toBeUndefined()
    expect(contextText({ tokens: 231_000, percent: 58, window: 400_000 })).toBe('58% · 231k')
    expect(contextText(null)).toBe('—')
  })

  test('the row drops the bar first, then the time left', () => {
    const ctx = { tokens: 231_000, percent: 58, window: 400_000 }
    const cache = { state: 'warm' as const, msLeft: 41 * MINUTE_MS }
    expect(meterRowText(meterRow(ctx, cache, 120))).toBe('◆ Relay   ctx ▰▰▰▰▰▱▱▱ 58% · 231k   cache ● warm · 41m left')
    expect(meterRow(ctx, cache, 64)).toEqual({ figures: '58% · 231k', cache: 'warm', left: '41m left' })
    expect(meterRow(ctx, cache, 40)).toEqual({ figures: '58% · 231k', cache: 'warm' })
    expect(meterRow(ctx, { state: 'cold', coldForMs: 1 }, 120).left).toBeUndefined()
  })

  test('threshold text', () => {
    expect(thresholdText({ tokens: 322_000, percent: 81, window: 400_000 })).toBe('Context is at 81% (322k). Hand off and start fresh?')
  })

  test('status card lines', () => {
    const card = statusCard({ enabled: true, context: null, cache: { state: 'unknown' }, snoozed: true })
    expect(card).toContain('Relay is on.')
    expect(card).toContain('Context: no reading yet')
    expect(card).toContain('Prompt cache: unknown')
    expect(card).toContain('Handoff: snoozed until 90% or 400k tokens')
    expect(statusCard({ enabled: false, context: null, cache: { state: 'cold', coldForMs: 2 * HOUR_MS }, snoozed: false })).toContain(
      'Prompt cache: cold for 2h',
    )
  })
})

describe('handoff flow texts', () => {
  test('cold confirmation with and without a price', () => {
    expect(coldHandoffText(240_000, 4.8)).toBe('Cache is cold — writing the handoff re-writes ~240k tokens (≈ $4.80).')
    expect(coldHandoffText(240_000, undefined)).toBe('Cache is cold — writing the handoff re-writes ~240k tokens.')
  })

  test('fork failures in plain words', () => {
    expect(forkFailureText('nothing-to-fork')).toBe('Nothing to hand off yet — no replies in this session.')
    expect(forkFailureText('api-error', 529)).toBe('The handoff could not be written: the API answered with an error (529).')
    expect(forkFailureText('api-error')).toBe('The handoff could not be written: the API answered with an error.')
    expect(forkFailureText('empty-reply')).toContain('empty')
    expect(forkFailureText('aborted')).toContain('interrupted')
    expect(forkFailureText('odd')).toContain('(odd)')
  })

  test('paths join with the folder separator', () => {
    expect(joinPath('C:\\Users\\r\\.claude\\handoffs\\K', 'a.md')).toBe('C:\\Users\\r\\.claude\\handoffs\\K\\a.md')
    expect(joinPath('/home/r/.claude/handoffs/K/', 'a.md')).toBe('/home/r/.claude/handoffs/K/a.md')
  })

  test('the fill text appends a held prompt below a rule', () => {
    expect(fillText('brief')).toBe('brief')
    expect(fillText('brief', '  ')).toBe('brief')
    expect(fillText('brief', 'and then this')).toBe('brief\n\n---\nand then this')
  })

  test('readIndex keeps well-formed records only', () => {
    const good = rec('a', NOW)
    expect(readIndex([good, null, 3, { id: 'x' }])).toEqual([good])
    expect(readIndex('nope')).toEqual([])
    expect(readIndex(undefined)).toEqual([])
  })

  test('offer and pending lines', () => {
    expect(offerText({ title: 'T', createdAt: NOW - 10 * HOUR_MS }, NOW)).toBe('Handoff waiting: "T" · from 10h ago')
    expect(pendingLine([rec('a', NOW - HOUR_MS)], KEY, NOW)).toBe('"a" · from 1h ago')
    expect(pendingLine([rec('a', NOW - HOUR_MS, { consumedAt: NOW })], KEY, NOW)).toBe('none')
  })

  test('/handoff list puts this project first and caps at 20', () => {
    const many = Array.from({ length: 25 }, (_, i) => rec(`r${i}`, NOW - i * MINUTE_MS, { projectKey: 'other' }))
    const text = handoffListText([...many, rec('mine', NOW - 5 * HANDOFF_MAX_AGE_MS)], KEY, NOW)
    const lines = text.split('\n')
    expect(lines).toHaveLength(21)
    expect(lines[1]).toBe('• mine — 35d ago — /h/mine.md — waiting')
    expect(handoffListText([], KEY, NOW)).toBe('No handoffs yet. Type /handoff to write one.')
  })
})

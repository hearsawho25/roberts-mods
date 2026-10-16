import { describe, expect, test } from 'claude-code/testing'

import {
  commandOwners,
  diagnose,
  hasHooksModule,
  mergeLoaded,
  nameFromId,
  paneLines,
  parsePluginList,
  parseValidate,
  reportText,
  rowText,
  toastKey,
  toastText,
} from '../hooks/core'
import type { ExpectedEntry, ModReport, ModStatus, Report } from '../hooks/core'

describe('nameFromId', () => {
  test('drops the marketplace', () => expect(nameFromId('relay@roberts-mods')).toBe('relay'))
  test('keeps a bare name', () => expect(nameFromId('relay')).toBe('relay'))
})

describe('parsePluginList', () => {
  const json = JSON.stringify([
    { id: 'relay@roberts-mods', version: '0.3.0', enabled: true, installPath: 'C:\\cache\\relay\\0.3.0', readFromFolder: 'D:\\Projects\\roberts-mods\\relay', folderVersion: '0.4.0' },
    { id: 'skins@hellosverre-mods', version: '0.5.4', enabled: true, installPath: 'C:\\cache\\skins\\0.5.4' },
    { id: 'blast-radius@x', version: '0.1.0', enabled: false, installPath: 'C:\\cache\\br' },
    { version: '1.0.0', enabled: true },
  ])
  test('keeps enabled entries with an id, folder from readFromFolder else installPath', () => {
    expect(parsePluginList(json)).toEqual([
      { id: 'relay@roberts-mods', name: 'relay', version: '0.3.0', folder: 'D:\\Projects\\roberts-mods\\relay', folderVersion: '0.4.0', isReadFromFolder: true },
      { id: 'skins@hellosverre-mods', name: 'skins', version: '0.5.4', folder: 'C:\\cache\\skins\\0.5.4', folderVersion: null, isReadFromFolder: false },
    ])
  })
  test('bad JSON throws', () => expect(() => parsePluginList('nope')).toThrow())
  test('a non-array throws', () => expect(() => parsePluginList('{}')).toThrow())
})

describe('hasHooksModule', () => {
  test('true for a non-empty modules array', () => expect(hasHooksModule('{ "modules": ["./register.tsx"] }')).toBe(true))
  test('false for an empty array', () => expect(hasHooksModule('{ "modules": [] }')).toBe(false))
  test('false for classic hooks only', () => expect(hasHooksModule('{ "hooks": { "Stop": [] } }')).toBe(false))
  test('false for bad JSON', () => expect(hasHooksModule('{')).toBe(false))
})

describe('commandOwners', () => {
  test('plugins owning a bare-named plugin command: their hooks module registered it, so it is running', () => {
    expect(
      commandOwners([
        { name: 'challenge', plugin: 'daily-challenge', source: 'plugin' },
        { name: 'ship', plugin: 'git-ship', source: 'plugin' },
        { name: 'skins:skin-designer', plugin: 'skins', source: 'plugin' },
        { name: 'superpowers:brainstorm', plugin: 'superpowers', source: 'plugin' },
        { name: 'relay', plugin: 'relay', source: 'plugin' },
        { name: 'handoff', plugin: 'relay', source: 'plugin' },
        { name: 'orphan', source: 'plugin' },
        { name: 'help', source: 'builtin' },
        { name: 'mine', plugin: 'x', source: 'user' },
      ]),
    ).toEqual(['daily-challenge', 'git-ship', 'relay'])
  })
  test('none', () => expect(commandOwners([])).toEqual([]))
})

describe('mergeLoaded', () => {
  test('unions and sorts', () => expect(mergeLoaded(['relay'], ['git-ship', 'relay'])).toEqual(['git-ship', 'relay']))
  test('a self-only list adds nothing', () => expect(mergeLoaded(['relay'], ['mod-doctor'])).toEqual(['relay']))
  test('an empty list adds nothing', () => expect(mergeLoaded(['relay'], [])).toEqual(['relay']))
})

describe('parseValidate', () => {
  const root = 'C:\\Users\\k\\mods\\probe-broken'
  const out = [
    'Validating hooks: C:\\Users\\k\\mods\\probe-broken\\hooks\\hooks.json',
    '',
    '✘ Found 1 error:',
    '',
    '  ❯ modules../register.ts: probe-broken: C:\\Users\\k\\mods\\probe-broken\\hooks\\register.ts does not parse: Expected ")" but found end of file (line 2, column 46)',
    '',
    '✘ Validation failed',
  ].join('\n')
  test('takes error lines, strips the prefix, shortens paths under the root', () => {
    expect(parseValidate(out, root)).toEqual(['hooks\\register.ts does not parse: Expected ")" but found end of file (line 2, column 46)'])
  })
  test('ignores warnings', () => {
    const warn = '⚠ Found 1 warning:\n\n  ❯ author: No author information provided.\n\n✔ Validation passed with warnings'
    expect(parseValidate(warn, root)).toEqual([])
  })
  test('caps at three lines', () => {
    const many = ['✘ Found 4 errors:', '  ❯ a', '  ❯ b', '  ❯ c', '  ❯ d', '✘ Validation failed'].join('\n')
    expect(parseValidate(many, root)).toEqual(['a', 'b', 'c'])
  })
  test('matches the root with forward slashes and any case', () => {
    const fwd = '✘ Found 1 error:\n  ❯ c:/users/k/mods/probe-broken/hooks/x.ts bad'
    expect(parseValidate(fwd, root)).toEqual(['hooks/x.ts bad'])
  })
})

const relay: ExpectedEntry = { id: 'relay@roberts-mods', name: 'relay', version: '0.3.0', folder: 'D:\\m\\relay', folderVersion: '0.3.0', isReadFromFolder: true }
const ship: ExpectedEntry = { id: 'git-ship@roberts-mods', name: 'git-ship', version: '0.1.0', folder: 'D:\\m\\git-ship', folderVersion: '0.2.0', isReadFromFolder: true }
const skins: ExpectedEntry = { id: 'skins@h', name: 'skins', version: '0.5.4', folder: 'C:\\c\\skins', folderVersion: null, isReadFromFolder: false }

describe('diagnose', () => {
  const base = { checkedAt: 0, inline: [], skipped: 2, commands: { 'git-ship': ['ship'] } }
  test('missing → not-loaded with validate errors; problems first then by name', () => {
    const r = diagnose({ ...base, expected: [ship, relay, skins], loaded: ['git-ship', 'skins'], validations: { relay: { ok: false, errors: ['bad'] } } })
    expect(r.mods.map(m => [m.name, m.status])).toEqual([['relay', 'not-loaded'], ['git-ship', 'loaded'], ['skins', 'loaded']])
    expect(r.mods[0]!.errors).toEqual(['bad'])
    expect(r.mods[1]!.commands).toEqual(['ship'])
  })
  test('loaded but validate fails → broken', () => {
    const r = diagnose({ ...base, expected: [relay], loaded: ['relay'], validations: { relay: { ok: false, errors: ['x'] } } })
    expect(r.mods[0]!.status).toBe('broken')
  })
  test('missing but validate passes → note to reload', () => {
    const r = diagnose({ ...base, expected: [relay], loaded: [], validations: { relay: { ok: true } } })
    expect(r.mods[0]!.note).toBe('validate passes; try /reload-plugins')
  })
  test('validate could not run → note with the reason', () => {
    const r = diagnose({ ...base, expected: [relay], loaded: [], validations: { relay: { ok: null, reason: 'timed out' } } })
    expect(r.mods[0]!.note).toBe("couldn't validate: timed out")
  })
  test('version drift only when read from folder and versions differ', () => {
    const r = diagnose({ ...base, expected: [ship, relay, skins], loaded: ['git-ship', 'relay', 'skins'], validations: {} })
    expect(r.mods.find(m => m.name === 'git-ship')!.drift).toEqual({ folder: '0.2.0', record: '0.1.0' })
    expect(r.mods.find(m => m.name === 'relay')!.drift).toBe(null)
    expect(r.mods.find(m => m.name === 'skins')!.drift).toBe(null)
  })
})

describe('rowText', () => {
  const mod = (name: string, status: ModStatus): ModReport => ({ name, version: '1', status, errors: [], note: null, drift: null, commands: [] })
  const report = (mods: ModReport[], error: string | null = null): Report => ({ checkedAt: 0, mods, inline: [], skipped: 0, error })
  test('null when all loaded', () => expect(rowText(report([mod('a', 'loaded')]))).toBe(null))
  test('null when the check failed', () => expect(rowText(report([mod('a', 'not-loaded')], 'boom'))).toBe(null))
  test('one', () => expect(rowText(report([mod('relay', 'not-loaded')]))).toBe("✗ Mod Doctor  1 mod didn't load: relay"))
  test('several not loaded', () =>
    expect(rowText(report([mod('a', 'not-loaded'), mod('b', 'not-loaded'), mod('c', 'not-loaded')]))).toBe("✗ Mod Doctor  3 mods didn't load: a, b +1"))
  test('one broken', () => expect(rowText(report([mod('relay', 'broken')]))).toBe('✗ Mod Doctor  1 mod is broken: relay'))
  test('several broken', () => expect(rowText(report([mod('a', 'broken'), mod('b', 'broken')]))).toBe('✗ Mod Doctor  2 mods are broken: a, b'))
  test('mixed', () =>
    expect(rowText(report([mod('a', 'not-loaded'), mod('b', 'broken'), mod('c', 'not-loaded')]))).toBe('✗ Mod Doctor  3 mods have problems: a, b +1'))
})

describe('toastText', () => {
  const mod = (status: ModStatus): ModReport => ({ name: 'relay', version: '1', status, errors: [], note: null, drift: null, commands: [] })
  test('not loaded', () => expect(toastText(mod('not-loaded'))).toBe("Mod Doctor: relay didn't load — /mod-doctor for why"))
  test('broken', () => expect(toastText(mod('broken'))).toBe('Mod Doctor: relay is broken on disk — /mod-doctor for why'))
})

describe('paneLines and reportText', () => {
  const r: Report = {
    checkedAt: 0, skipped: 9, inline: ['probe'], error: null,
    mods: [
      { name: 'relay', version: '0.3.0', status: 'not-loaded', errors: ['hooks\\register.tsx does not parse'], note: null, drift: null, commands: [] },
      { name: 'git-ship', version: '0.1.0', status: 'loaded', errors: [], note: null, drift: { folder: '0.2.0', record: '0.1.0' }, commands: ['ship'] },
      { name: 'clean-view', version: '0.1.0', status: 'loaded', errors: [], note: null, drift: null, commands: ['a', 'b', 'c', 'd', 'e'] },
    ],
  }
  test('a narrow pane: a command list that would wrap becomes one command plus +N; lines that fit stay', () => {
    const narrow: Report = {
      ...r,
      inline: [],
      mods: [
        { name: 'reflect-mod', version: '3.3.0', status: 'loaded', errors: [], note: null, drift: null, commands: ['reflect-queue', 'reflect-pause'] },
        { name: 'git-ship', version: '0.1.0', status: 'loaded', errors: [], note: null, drift: null, commands: ['ship'] },
      ],
    }
    // '✓ reflect-mod  3.3.0  · /reflect-queue /reflect-pause' is 53 wide.
    const at = (columns: number) => paneLines(narrow, '12:41', columns).map(l => l.text)
    expect(at(40)).toContain('✓ reflect-mod  3.3.0  · /reflect-queue +1')
    expect(at(40)).toContain('✓ git-ship  0.1.0  · /ship')
    expect(at(53)).toContain('✓ reflect-mod  3.3.0  · /reflect-queue /reflect-pause')
    expect(at(52)).toContain('✓ reflect-mod  3.3.0  · /reflect-queue +1')
  })

  test('lines with tones', () => {
    expect(paneLines(r, '12:41')).toEqual([
      { tone: 'muted', text: 'Checked 12:41 · 3 mods · 1 problem' },
      { tone: 'bad', text: '✗ relay  not loaded' },
      { tone: 'bad', text: '    hooks\\register.tsx does not parse', isDetail: true },
      { tone: 'ok', text: '✓ git-ship  0.1.0  · /ship' },
      { tone: 'warn', text: '    ⚠ folder is 0.2.0, on record 0.1.0', isDetail: true },
      { tone: 'ok', text: '✓ clean-view  0.1.0  · /a /b /c +2' },
      { tone: 'ok', text: '✓ probe  dev folder' },
      { tone: 'muted', text: '9 skipped (no hooks module)' },
    ])
  })
  test('a failed check is one line', () => {
    expect(paneLines({ ...r, error: 'claude CLI not found' }, '12:41')).toEqual([{ tone: 'bad', text: "couldn't check: claude CLI not found" }])
  })
  test('reportText joins the lines under a title', () => {
    expect(reportText(r, '12:41').split('\n')[0]).toBe('Mod Doctor report')
    expect(reportText(r, '12:41')).toContain('✗ relay  not loaded\n    hooks\\register.tsx does not parse')
  })
})

describe('toastKey', () => {
  test('name, status and first reason', () => {
    expect(toastKey({ name: 'relay', version: '1', status: 'not-loaded', errors: ['e1', 'e2'], note: null, drift: null, commands: [] })).toBe('relay|not-loaded|e1')
  })
})

describe('review fixes', () => {
  const mk = (name: string, status: ModStatus, over: Partial<ModReport> = {}): ModReport => ({ name, version: '1', status, errors: [], note: null, drift: null, commands: [], ...over })
  const rep = (mods: ModReport[], inline: string[] = []): Report => ({ checkedAt: 0, mods, inline, skipped: 0, error: null })
  const one = '✘ Found 1 error:\n  ❯ c:/m/p/hooks/x.ts bad\n✘ Validation failed'

  test('parseValidate: root with a trailing backslash', () => {
    expect(parseValidate('✘ Found 1 error:\n  ❯ C:\\m\\p\\hooks\\x.ts bad', 'C:\\m\\p\\')).toEqual(['hooks\\x.ts bad'])
  })
  test('parseValidate: forward-slash root against backslash output', () => {
    expect(parseValidate('✘ Found 1 error:\n  ❯ C:\\m\\p\\hooks\\x.ts bad', 'C:/m/p')).toEqual(['hooks\\x.ts bad'])
  })
  test('parseValidate: empty root leaves the line unchanged', () => {
    expect(parseValidate('✘ Found 1 error:\n  ❯ /hooks/x.ts bad', '')).toEqual(['/hooks/x.ts bad'])
    expect(parseValidate('✘ Found 1 error:\n  ❯ /hooks/x.ts bad', '/')).toEqual(['/hooks/x.ts bad'])
  })
  test('parseValidate: strips ANSI colour codes', () => {
    const c = '\x1b[31m✘ Found 1 error:\x1b[0m\n  \x1b[31m❯\x1b[0m \x1b[1mbad thing\x1b[0m'
    expect(parseValidate(c, 'C:\\m\\p')).toEqual(['bad thing'])
  })
  test('parseValidate: no error block gives []', () => {
    expect(parseValidate('✔ Validation passed', 'C:\\m\\p')).toEqual([])
    expect(parseValidate('', 'C:\\m\\p')).toEqual([])
  })
  test('parseValidate: collects from a second error block', () => {
    const two = '✘ Found 1 error:\n  ❯ first\n\n⚠ Found 1 warning:\n  ❯ warn\n\n✘ Found 1 error:\n  ❯ second\n✘ Validation failed'
    expect(parseValidate(two, 'C:\\m\\p')).toEqual(['first', 'second'])
  })
  test('parseValidate: CRLF output', () => {
    expect(parseValidate(one.replace(/\n/g, '\r\n'), 'C:\\m\\p')).toEqual(['hooks/x.ts bad'])
  })
  test('hasHooksModule: leading BOM', () => expect(hasHooksModule('\uFEFF{ "modules": ["./r.tsx"] }')).toBe(true))
  test('parsePluginList: leading BOM', () => {
    expect(parsePluginList('\uFEFF' + JSON.stringify([{ id: 'a@b', enabled: true, installPath: 'C:\\a' }]))).toHaveLength(1)
  })
  test('paneLines: an inline name that is also a listed mod is not repeated', () => {
    const lines = paneLines(rep([mk('relay', 'loaded')], ['relay', 'probe']), '1:00').map(l => l.text)
    expect(lines).not.toContain('✓ relay  dev folder')
    expect(lines).toContain('✓ probe  dev folder')
  })
  test('mergeLoaded: a list with self and another adds both', () => {
    expect(mergeLoaded(['a'], ['mod-doctor', 'b'])).toEqual(['a', 'b', 'mod-doctor'])
  })
  test('diagnose: broken and not-loaded sort together by name', () => {
    const r = diagnose({
      expected: [skins, relay, ship], loaded: ['skins', 'git-ship'], commands: {}, inline: [], skipped: 0, checkedAt: 0,
      validations: { 'git-ship': { ok: false, errors: ['x'] } },
    })
    expect(r.mods.map(m => [m.name, m.status])).toEqual([['git-ship', 'broken'], ['relay', 'not-loaded'], ['skins', 'loaded']])
  })
  test('diagnose: a loaded mod whose validate could not run stays loaded with a note', () => {
    const r = diagnose({ expected: [relay], loaded: ['relay'], commands: {}, inline: [], skipped: 0, checkedAt: 0, validations: { relay: { ok: null, reason: 'timed out' } } })
    expect(r.mods[0]!.status).toBe('loaded')
    expect(r.mods[0]!.note).toBe("couldn't validate: timed out")
  })
  test('rowText: exactly two problems has no +N', () => {
    expect(rowText(rep([mk('a', 'not-loaded'), mk('b', 'not-loaded')]))).toBe("✗ Mod Doctor  2 mods didn't load: a, b")
  })
  test('paneLines: a loaded mod with no commands has no separator', () => {
    expect(paneLines(rep([mk('a', 'loaded', { version: '1' })]), '1:00')[1]).toEqual({ tone: 'ok', text: '✓ a  1' })
  })
  test('nameFromId: a leading @ is kept', () => expect(nameFromId('@x')).toBe('@x'))
})

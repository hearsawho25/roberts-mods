# Mod Doctor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `mod-doctor`, a mod that tells Robert which enabled mods failed to load and why. It shows a red row only when something's wrong, and `/mod-doctor` opens a pane.

**Architecture:**
- Pure logic lives in `hooks/core.ts`: parsing, diffing and text.
- All the engine code lives in `hooks/register.tsx`.
- The loaded set comes from `engine.create` plus `plugin.register`. The expected set comes from `claude plugin list --json` together with each mod's `hooks/hooks.json`. Reasons come from `claude plugin validate`.
- The source of truth is `docs/DESIGN.md`. Read it first.

**Tech Stack:** Claude Code plugin hooks API (build 2.1.296), TypeScript/TSX with `h` JSX, tested with `claude plugin test` (`claude-code/testing`).

## Ground rules for every subagent

- **Never run any git command**, not even `git status` or `git diff`. Robert commits himself. There are no commit steps in this plan.
- Keep every file LF. Write files with the Edit/Write tools, never with shell heredocs or Python, because escapes get mangled.
- Mirror `D:\Projects\roberts-mods\git-ship`:
  - its test harness style: `tests/ship.test.tsx`, which shows how `$.process.run` is stubbed and how a session is driven
  - its `runProcess` wrapper in `hooks/register.tsx`, around line 150
  - its pane and row code
  - Read those before writing register code.
- API types: `C:/Users/kagek/AppData/Local/Temp/claude/bundled-skills/2.1.296/c693e801db464ba1acd72e0980158552/plugin-authoring/types/claude-code.d.ts`. Grep for what you need: `'engine.create'`, `PluginRegisterInput`, `CommandInfo`, `copy:`, `process: {`.
- Checks, run from any folder:
  - `claude plugin validate D:/Projects/roberts-mods/mod-doctor`
  - `claude plugin test D:/Projects/roberts-mods/mod-doctor`
  - `npx -y -p typescript@5 tsc -p C:/Users/kagek/.claude/jobs/04094503/tmp/mod-doctor-tsconfig.json`

## Files

| File | Responsibility |
| --- | --- |
| `mod-doctor/.claude-plugin/plugin.json` | manifest |
| `mod-doctor/hooks/hooks.json` | `{ "modules": ["./register.tsx"] }` |
| `mod-doctor/hooks/core.ts` | pure logic (Tasks 1–2) |
| `mod-doctor/hooks/register.tsx` | all `$` code (Tasks 3–4) |
| `mod-doctor/types/index.d.ts` | `PluginState` contract (Task 3) |
| `mod-doctor/tests/core.test.ts` | core tests |
| `mod-doctor/tests/doctor.test.tsx` | hook tests |
| `mod-doctor/README.md`, root `README.md`, root `.claude-plugin/marketplace.json` | docs and listing (Task 5) |

---

### Task 1: Scaffold and core parsing

**Files:** create `mod-doctor/.claude-plugin/plugin.json`, `mod-doctor/hooks/hooks.json`, `mod-doctor/hooks/core.ts` and `mod-doctor/tests/core.test.ts`. Also create `C:/Users/kagek/.claude/jobs/04094503/tmp/mod-doctor-tsconfig.json` as a copy of `git-ship-tsconfig.json` in the same folder, with `git-ship` replaced by `mod-doctor` in `include`.

- [ ] **Step 1: Manifest and hooks.json**

`plugin.json`:
```json
{
  "name": "mod-doctor",
  "version": "0.1.0",
  "description": "Checks that every enabled mod's hooks module actually loaded, and shows why one didn't. Quiet unless something is broken; /mod-doctor opens the report.",
  "author": { "name": "Robert Horton" },
  "types": "./types/index.d.ts"
}
```
`hooks/hooks.json`: `{ "modules": ["./register.tsx"] }`. Until Task 3, `register.tsx` is a stub: `import type { Register } from 'claude-code'` and `export const register: Register = () => {}`. Also create a stub `types/index.d.ts`:
```ts
declare module 'claude-code' {
  interface PluginState {
    'mod-doctor': {}
  }
}
export {}
```

- [ ] **Step 2: Write failing tests** in `tests/core.test.ts`:

```ts
import { describe, expect, test } from 'claude-code/testing'

import { hasHooksModule, mergeLoaded, nameFromId, parsePluginList, parseValidate } from '../hooks/core'

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
```

- [ ] **Step 3: Run it.** `claude plugin test D:/Projects/roberts-mods/mod-doctor`. Expected: FAIL, because `../hooks/core` has no exports.

- [ ] **Step 4: Implement** `hooks/core.ts`:

```ts
/** Mod Doctor's pure logic: no `$`, no engine. See docs/DESIGN.md. */

export const SELF = 'mod-doctor'
const MAX_ERROR_LINES = 3

/** An enabled plugin from `claude plugin list --json`. */
export type ExpectedEntry = {
  id: string
  name: string
  version: string | null
  /** readFromFolder when set, else installPath. */
  folder: string
  folderVersion: string | null
  isReadFromFolder: boolean
}

/** `relay@roberts-mods` → `relay`. */
export function nameFromId(id: string): string {
  const at = id.lastIndexOf('@')
  return at > 0 ? id.slice(0, at) : id
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v !== '' ? v : null
}

/** The enabled entries of `claude plugin list --json`. Throws on JSON that isn't an array. */
export function parsePluginList(json: string): ExpectedEntry[] {
  const raw: unknown = JSON.parse(json)
  if (!Array.isArray(raw)) throw new Error('plugin list is not an array')
  const out: ExpectedEntry[] = []
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue
    const o = item as Record<string, unknown>
    const id = str(o['id'])
    if (id === null || o['enabled'] !== true) continue
    const fromFolder = str(o['readFromFolder'])
    const folder = fromFolder ?? str(o['installPath'])
    if (folder === null) continue
    out.push({
      id,
      name: nameFromId(id),
      version: str(o['version']),
      folder,
      folderVersion: str(o['folderVersion']),
      isReadFromFolder: fromFolder !== null,
    })
  }
  return out
}

/** Whether a hooks/hooks.json names at least one hooks module. */
export function hasHooksModule(text: string): boolean {
  try {
    const j: unknown = JSON.parse(text)
    const modules = typeof j === 'object' && j !== null ? (j as Record<string, unknown>)['modules'] : undefined
    return Array.isArray(modules) && modules.length > 0
  } catch {
    return false
  }
}

/** Adds an engine.create or plugin.register list to the loaded set. A list holding only Mod Doctor (its own reload) adds nothing. */
export function mergeLoaded(prev: readonly string[], plugins: readonly string[]): string[] {
  if (plugins.every(p => p === SELF)) return [...prev]
  return [...new Set([...prev, ...plugins])].sort()
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** The error lines of `claude plugin validate` output, at most three, with paths under `root` made relative. */
export function parseValidate(stdout: string, root: string): string[] {
  const lines = stdout.split(/\r?\n/)
  const start = lines.findIndex(l => /^✘ Found \d+ errors?:/.test(l.trim()))
  if (start < 0) return []
  const rootPattern = new RegExp(`${escapeRegExp(root).replace(/\\\\/g, '[\\\\/]')}[\\\\/]`, 'gi')
  const out: string[] = []
  for (const line of lines.slice(start + 1)) {
    const t = line.trim()
    if (t.startsWith('✘') || t.startsWith('✔') || t.startsWith('⚠')) break
    if (!t.startsWith('❯')) continue
    const text = t.slice(1).trim().replace(/^modules\S*: [^\s:]+: /, '').replace(rootPattern, '')
    out.push(text)
    if (out.length === MAX_ERROR_LINES) break
  }
  return out
}
```

Note on the forward-slash test: `rootPattern` turns each `\` in the root into `[\\/]`, so it matches either slash, and `gi` makes it case-insensitive.

- [ ] **Step 5: Run the tests.** Expected: all pass. Then run validate and tsc. Expected: clean.

---

### Task 2: Diagnosis and text

**Files:** modify `mod-doctor/hooks/core.ts` and `mod-doctor/tests/core.test.ts`.

- [ ] **Step 1: Failing tests**, appended to `tests/core.test.ts`. Add `diagnose, paneLines, reportText, rowText, toastKey` and the types to the import.

```ts
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
  test('several', () => expect(rowText(report([mod('a', 'not-loaded'), mod('b', 'broken'), mod('c', 'not-loaded')]))).toBe("✗ Mod Doctor  3 mods didn't load: a, b +1"))
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
```

- [ ] **Step 2: Run.** Expected: FAIL, because the exports are missing.

- [ ] **Step 3: Implement**, appended to `hooks/core.ts`:

```ts
export type Validation = { ok: true } | { ok: false; errors: string[] } | { ok: null; reason: string }
export type ModStatus = 'loaded' | 'not-loaded' | 'broken'
export type ModReport = {
  name: string
  version: string | null
  status: ModStatus
  errors: string[]
  note: string | null
  drift: { folder: string; record: string } | null
  /** Slash command names without the `/`. */
  commands: string[]
}
export type Report = {
  checkedAt: number
  mods: ModReport[]
  /** `--plugin-dir` mods heard through plugin.register (provenance `@inline`). */
  inline: string[]
  /** Enabled plugins with no hooks module. */
  skipped: number
  /** Set when the check itself could not run. */
  error: string | null
}
export type Tone = 'ok' | 'bad' | 'warn' | 'muted'
export type PaneLine = { tone: Tone; text: string; isDetail?: true }

const MAX_COMMANDS = 3

export function diagnose(input: {
  expected: readonly ExpectedEntry[]
  loaded: readonly string[]
  validations: Readonly<Record<string, Validation>>
  commands: Readonly<Record<string, readonly string[]>>
  inline: readonly string[]
  skipped: number
  checkedAt: number
}): Report {
  const loaded = new Set(input.loaded)
  const mods = input.expected.map((e): ModReport => {
    const v = input.validations[e.name]
    const isLoaded = loaded.has(e.name)
    const status: ModStatus = !isLoaded ? 'not-loaded' : v?.ok === false ? 'broken' : 'loaded'
    const note =
      v?.ok === null ? `couldn't validate: ${v.reason}` : !isLoaded && v?.ok === true ? 'validate passes; try /reload-plugins' : null
    const drift =
      e.isReadFromFolder && e.folderVersion !== null && e.version !== null && e.folderVersion !== e.version
        ? { folder: e.folderVersion, record: e.version }
        : null
    return { name: e.name, version: e.version, status, errors: v?.ok === false ? v.errors : [], note, drift, commands: [...(input.commands[e.name] ?? [])] }
  })
  mods.sort((a, b) => Number(a.status === 'loaded') - Number(b.status === 'loaded') || a.name.localeCompare(b.name))
  return { checkedAt: input.checkedAt, mods, inline: [...input.inline], skipped: input.skipped, error: null }
}

function problems(report: Report): ModReport[] {
  return report.mods.filter(m => m.status !== 'loaded')
}

/** The band row's text, or null when nothing is wrong (or the check couldn't run). */
export function rowText(report: Report): string | null {
  const bad = problems(report)
  if (report.error !== null || bad.length === 0) return null
  const names = bad.slice(0, 2).map(m => m.name).join(', ')
  const more = bad.length > 2 ? ` +${bad.length - 2}` : ''
  return `✗ Mod Doctor  ${bad.length} ${bad.length === 1 ? 'mod' : 'mods'} didn't load: ${names}${more}`
}

const STATUS_WORDS: Record<Exclude<ModStatus, 'loaded'>, string> = { 'not-loaded': 'not loaded', broken: 'broken on disk' }

/** The pane's lines; `time` is the check's local time, e.g. `12:41`. */
export function paneLines(report: Report, time: string): PaneLine[] {
  if (report.error !== null) return [{ tone: 'bad', text: `couldn't check: ${report.error}` }]
  const count = report.mods.length
  const bad = problems(report).length
  const lines: PaneLine[] = [
    { tone: 'muted', text: `Checked ${time} · ${count} ${count === 1 ? 'mod' : 'mods'} · ${bad} ${bad === 1 ? 'problem' : 'problems'}` },
  ]
  for (const m of report.mods) {
    if (m.status === 'loaded') {
      const shown = m.commands.slice(0, MAX_COMMANDS).map(c => `/${c}`).join(' ')
      const more = m.commands.length > MAX_COMMANDS ? ` +${m.commands.length - MAX_COMMANDS}` : ''
      const cmds = shown === '' ? '' : `  · ${shown}${more}`
      lines.push({ tone: 'ok', text: `✓ ${m.name}${m.version !== null ? `  ${m.version}` : ''}${cmds}` })
    } else {
      lines.push({ tone: 'bad', text: `✗ ${m.name}  ${STATUS_WORDS[m.status]}` })
    }
    for (const err of m.errors) lines.push({ tone: 'bad', text: `    ${err}`, isDetail: true })
    if (m.note !== null) lines.push({ tone: 'muted', text: `    ${m.note}`, isDetail: true })
    if (m.drift !== null) lines.push({ tone: 'warn', text: `    ⚠ folder is ${m.drift.folder}, on record ${m.drift.record}`, isDetail: true })
  }
  for (const name of report.inline) lines.push({ tone: 'ok', text: `✓ ${name}  dev folder` })
  lines.push({ tone: 'muted', text: `${report.skipped} skipped (no hooks module)` })
  return lines
}

/** Plain text for Copy report. */
export function reportText(report: Report, time: string): string {
  return ['Mod Doctor report', ...paneLines(report, time).map(l => l.text)].join('\n')
}

/** One toast per mod, status and first reason per session. */
export function toastKey(m: ModReport): string {
  return `${m.name}|${m.status}|${m.errors[0] ?? m.note ?? ''}`
}
```

- [ ] **Step 4: Run tests, validate and tsc.** Expected: all pass, clean.

---

### Task 3: Engine wiring and the check

**Files:** replace `mod-doctor/hooks/register.tsx` and `mod-doctor/types/index.d.ts`. Create `mod-doctor/tests/doctor.test.tsx`.

**State contract** (`types/index.d.ts`). Use the same layout as git-ship's types file, and import `Report` shape by duplicating it as `ModDoctorReport`, the same way git-ship duplicates `RepoState` as `GitShipRepo`:
```ts
export type ModDoctorReport = { /* same fields as core.ts Report, with ModReport inlined */ }
declare module 'claude-code' {
  interface PluginState {
    'mod-doctor': {
      loaded: string[]
      inline: string[]
      report: ModDoctorReport | null
      checking: boolean
      toasted: string[]
    }
  }
}
```

**Behaviour to implement in `register.tsx`.** It must be in exactly this form, because the tests below pin it.

1. **`engine.create`:** `const built = await next(e)`. Record `e.plugins` into a module variable `pendingCreate`, then return `built`. Do not touch `$.state` here; `$` is still being built.
2. **`plugin.register`:**
   - `const r = await next(e)`.
   - If `r.allow`, then:
     - `update($, loaded, prev => mergeLoaded(prev ?? [], [e.name]))`
     - if `e.provenance.endsWith('@inline')` and `e.name !== SELF`, add `e.name` to `inline`
     - call `scheduleCheck($)`, which debounces 2,000 ms via `$.clock.after` (or the equivalent in the types)
   - Return `r`.
   - Add `.catch(($, e, next) => next(e))`: Mod Doctor never refuses a mod, and a failing hook must let it join.
3. **`session.start`:**
   - `const r = await next(e)`.
   - Register `/mod-doctor` (description `Show which mods loaded and why any didn't`) **first**, before any other command.
   - Merge `pendingCreate` into `loaded` with `mergeLoaded`.
   - Fire-and-forget `runCheck($, { full: false })`.
   - Return `r`.
4. **`runCheck($, { full })`:**
   - A single-flight guard. If a check is running, set `again = true` and return; when the running check ends, run once more if `again`.
   - Set `checking` true, then:
     1. `runClaude($, ['plugin', 'list', '--json'], 30_000)`. If it fails to start or exits non-zero, write a report with `error: 'claude CLI not found'` or `error: 'plugin list failed (exit N)'`. If `parsePluginList` throws, the error is `'plugin list output not understood'`.
     2. For each expected entry, `$.fs.read(<folder>/hooks/hooks.json)` (catch → not a hooks mod) → `hasHooksModule`. The ones that pass are checked; the rest count as `skipped`. Join paths with `/`, which works on Windows.
     3. Get `loaded` from state.
     4. Validate targets are the checked mods not in `loaded`, plus, when `full`, every checked mod.
        - Run `runClaude($, ['plugin', 'validate', folder], 30_000)` four at a time.
        - Exit 0 gives `{ ok: true }`.
        - A non-zero exit gives `{ ok: false, errors: parseValidate(stdout + '\n' + stderr, folder) }`. If that is empty, the errors are `[\`validate failed (exit N)\`]`.
        - A rejection gives `{ ok: null, reason: 'timed out or could not start' }`.
     5. `commands`: from `$.command.list()`, group by `c.plugin`. For each name, strip a leading `<plugin>:` prefix, e.g. `superpowers:brainstorm` → `brainstorm`.
     6. `diagnose(...)` with `checkedAt: $.clock.now()`. Write `report`.
     7. **Toasts:** for each mod with status not `loaded`, if `toastKey(m)` is not in `toasted`, run `$.ui.toast(\`Mod Doctor: ${m.name} didn't load — /mod-doctor for why\`)` and append the key.
   - Set `checking` false in a `finally`.
5. **`runClaude`:**
   - Mirror git-ship's `runProcess`: `$.process.run(['claude', ...args], { timeoutMs })` inside `try`, returning `undefined` on rejection.
   - Check in the types whether `process.run` returns `{ code, stdout, stderr }` or other names, and use the real ones.
   - If running bare `claude` fails on Windows in the live check, the fix is `claude.exe`. Note it in the report; don't guess now.

**Tests** in `tests/doctor.test.tsx`. Use git-ship's `ship.test.tsx` harness pattern: stub `process.run` by argv-joined key, stub `fs.read` by path, and drive `session.start`. Required cases:
- All loaded: plugin list with `relay` and `skins`, both with hooks modules, and `engine.create` plugins `['mod-doctor','relay','skins']`. After start, the report has 2 mods, both `loaded`, no toast, and validate is **not** run.
- Missing mod: `engine.create` lacks `relay`. Validate for relay's folder exits 1 with the probe output from Task 1. The report shows relay `not-loaded` with the parsed error, and one toast `Mod Doctor: relay didn't load — /mod-doctor for why`. A second check makes no second toast.
- A skills-only plugin (`fs.read` of its hooks.json rejects) is counted in `skipped` and not checked.
- `claude` fails to start, so the report error is `claude CLI not found`, and no toast is shown.
- `plugin.register` for `foo` with provenance `foo@inline` adds `foo` to `inline`. A later check after the debounce lists it.
- `plugin.register` hook returns core's `{ allow: true }` unchanged.
- `full: true` runs validate for every checked mod.
- Two overlapping `runCheck` calls run `plugin list` exactly twice, not three times. This is the single flight plus one follow-up.

- [ ] Step 1: Write the tests. Step 2: Run them and see them fail. Step 3: Implement. Step 4: Get tests, validate and tsc green.

---

### Task 4: Row, pane, command and buttons

**Files:** modify `mod-doctor/hooks/register.tsx` and `mod-doctor/tests/doctor.test.tsx`.

**Colours:** copy git-ship's or roberts-toolbox's `COLORS` and add `red: '#F85149'`. Tones map as follows: `ok` is green, `bad` is red, `warn` is gold, `muted` is muted.

1. **AbovePrompt** (`ui.render`, `{ component: 'AbovePrompt' }`):
   - Always run `const base = await next(e)`.
   - Read `report`. If `rowText(report)` is null (or there is no report), return `base` unchanged.
   - Otherwise append one row the way git-ship does: red text, then a spacer, then `[ Open ]`, a Button calling top-level `openPane($)`.
2. **`/mod-doctor`** (`command.run`, `{ command: 'mod-doctor' }`): `openPane($)` and return `{ text: '' }`. Check what git-ship's `/ship` returns and match it.
3. **`openPane($)`:**
   - `$.ui.open({ id: 'mod-doctor', title: 'Mod Doctor' })`.
   - Then fire-and-forget `runCheck($, { full: false })`.
4. **Pane render** (`ui.render`, `{ component: 'Pane', requestId: 'mod-doctor' }`):
   - Read `report` and `checking`.
   - With no report yet, show `checking…`.
   - Otherwise show one Text per `paneLines(report, hhmm(report.checkedAt))` line, coloured by tone. `hhmm` uses local time, two-digit hours and minutes.
   - While `checking` is true and there is a report, add `checking…` to the header line.
   - Buttons in a `flexWrap` row:
     - `Re-check`: `runCheck($, { full: true })`. Disabled while checking.
     - `Copy report`: `$.ui.copy(reportText(report, hhmm(...)))`, then `$.ui.toast('Mod Doctor report copied')`. Check `copy`'s exact signature in the types.
     - `Close`: `$.ui.close({ id: 'mod-doctor' })`.

**Tests** (add):
- The row is absent when all mods are loaded. The band then equals `next`'s tree, which also shows other plugins' rows are kept.
- The row is present with the text `✗ Mod Doctor  1 mod didn't load: relay` when relay is missing.
- `/mod-doctor` opens the pane `mod-doctor`.
- The pane shows the header line and `✗ relay  not loaded`.
- Re-check runs validate for every checked mod.
- Copy report calls copy with text starting `Mod Doctor report`.
- `/mod-doctor` is the first command registered.

- [ ] Step 1: Write the tests. Step 2: Run them and see them fail. Step 3: Implement. Step 4: Get tests, validate and tsc green.

---

### Task 5: Docs and listing (controller does this directly)

- `mod-doctor/README.md`: what it does, `/mod-doctor`, the row, the pane lines, that it's read-only, and that it's reached through the Toolbox. Match `git-ship/README.md`'s tone.
- Root `README.md`: add a `mod-doctor` row to the table.
- Root `.claude-plugin/marketplace.json`: add `{ "name": "mod-doctor", "source": "./mod-doctor" }`.
- Final: validate, test and tsc. Then ask Robert to install it with `claude plugin install mod-doctor@roberts-mods` and run the live checks in DESIGN.md.

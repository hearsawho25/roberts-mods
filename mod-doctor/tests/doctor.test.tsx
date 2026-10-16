import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine, Plugin } from 'claude-code/testing'
import type { CommandInfo, On, RenderPropsOf } from 'claude-code'

import { hhmm, isInlineProvenance } from '../hooks/core'
import type { ModReport, Report } from '../hooks/core'
import type { ModDoctorMod, ModDoctorReport } from '../types'

/** The runtime has it; the tsconfig's es2023 lib does not declare it. */
declare const setTimeout: (fn: () => void, ms: number) => unknown

const START = 1_800_000_000_000
const LIST = 'claude plugin list --json'
const RELAY = 'C:\\Users\\k\\mods\\relay'
const SKINS = 'C:\\c\\skins'
const DOCS = 'C:\\c\\docs'
const CLASSIC = 'C:\\c\\classic'
const FOO = 'D:\\dev\\foo'
const HOOKS_MODULE = '{ "modules": ["./register.tsx"] }'
const RELAY_TOAST = "Mod Doctor: relay didn't load — /mod-doctor for why"
const PARSE_ERROR = 'hooks\\register.ts does not parse: Expected ")" but found end of file (line 2, column 46)'

/** `claude plugin validate` output for a mod whose module does not parse. */
const PROBE_OUT = [
  `Validating hooks: ${RELAY}\\hooks\\hooks.json`,
  '',
  '✘ Found 1 error:',
  '',
  `  ❯ modules../register.ts: relay: ${RELAY}\\hooks\\register.ts does not parse: Expected ")" but found end of file (line 2, column 46)`,
  '',
  '✘ Validation failed',
].join('\n')

function validate(folder: string): string {
  return `claude plugin validate ${folder}`
}

type Entry = { id: string; folder: string; fromFolder?: boolean; enabled?: boolean }

/** `claude plugin list --json` output. */
function pluginList(entries: readonly Entry[]): string {
  return JSON.stringify(
    entries.map(e => ({
      id: e.id,
      version: '1.0.0',
      enabled: e.enabled ?? true,
      installPath: e.fromFolder === true ? 'C:\\cache\\x' : e.folder,
      ...(e.fromFolder === true ? { readFromFolder: e.folder, folderVersion: '1.0.0' } : {}),
    })),
  )
}

const RELAY_ENTRY: Entry = { id: 'relay@roberts-mods', folder: RELAY, fromFolder: true }
const SKINS_ENTRY: Entry = { id: 'skins@hellosverre-mods', folder: SKINS }

type Output = { exitCode: number; stdout: string; stderr?: string }

type Control = {
  /** argv joined by spaces → what the command answers; one not listed exits 1 with no output. */
  outputs: Record<string, Output>
  /** path → text; one not listed is missing. */
  files: Record<string, string>
  /** Commands that cannot start (claude missing, or timed out). */
  refused: Set<string>
  /** Holds every plugin list call until resolved (to overlap checks). */
  hold: Promise<void> | null
  /** What `$.command.list()` answers. */
  commands: CommandInfo[]
  /** Every process.run call, its argv joined. */
  ran: string[]
  toasts: string[]
  /** Runs and toasts in the order they happened. */
  events: string[]
  /** Every command registered, in order. */
  registered: Array<{ name: string; description: string }>
  opened: Array<{ id: string; title: string | undefined }>
  closed: string[]
  copied: string[]
  /** The panes the engine has open. */
  panes: Set<string>
  /** ui.open answers isPlaced false (a narrow terminal). */
  isUnplaced: boolean
  /** ui.copy answers isCopied false. */
  isCopyRefused: boolean
  clock: ReturnType<typeof mock.clock>
}

/** Stands in for the engine beneath the mod. */
function engine(on: On, setup: { list?: string; outputs?: Record<string, Output>; files?: Record<string, string> } = {}): Control {
  const seen: Control = {
    outputs: { [LIST]: { exitCode: 0, stdout: setup.list ?? '[]' }, ...setup.outputs },
    files: Object.fromEntries(Object.entries(setup.files ?? {}).map(([path, text]) => [path.replace(/\//g, '\\'), text])),
    refused: new Set(),
    hold: null,
    commands: [],
    ran: [],
    toasts: [],
    events: [],
    registered: [],
    opened: [],
    closed: [],
    copied: [],
    panes: new Set(),
    isUnplaced: false,
    isCopyRefused: false,
    clock: mock.clock(on, { now: START }),
  }
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => {
    seen.registered.push({ name: e.name, description: e.description })
    return { value: { command: e.name } }
  })
  on('command.list', () => ({ value: seen.commands }))
  on('fs.read', ($, e) => {
    // The engine hands the path on in the platform's own separators.
    const text = seen.files[e.path.replace(/\//g, '\\')]
    return text === undefined ? { deny: `ENOENT: ${e.path}` } : { value: text }
  })
  on('process.run', async ($, e) => {
    const argv = e.argv.join(' ')
    seen.ran.push(argv)
    seen.events.push(`run ${argv}`)
    if (seen.refused.has(argv)) return { deny: 'could not start' }
    if (argv === LIST && seen.hold !== null) await seen.hold
    const out = seen.outputs[argv] ?? { exitCode: 1, stdout: '' }
    return { value: { exitCode: out.exitCode, stdout: out.stdout, stderr: out.stderr ?? '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('ui.toast', ($, e) => {
    seen.toasts.push(e.text)
    seen.events.push(`toast ${e.text}`)
    return { value: undefined }
  })
  on('ui.open', ($, e) => {
    seen.opened.push({ id: e.id, title: e.title })
    seen.panes.add(e.id)
    return { value: seen.isUnplaced ? { isPlaced: false as const, reason: 'narrow' } : { isPlaced: true as const } }
  })
  on('ui.close', ($, e) => {
    seen.closed.push(e.id)
    seen.panes.delete(e.id)
    return { value: undefined }
  })
  on('ui.panes', () => ({
    value: [...seen.panes].map(id => ({ id, title: 'Mod Doctor', isShown: true, isFocused: false, isPlaced: !seen.isUnplaced })),
  }))
  on('ui.copy', ($, e) => {
    seen.copied.push(e.text)
    return { value: seen.isCopyRefused ? { isCopied: false as const, reason: 'no-clipboard' as const } : { isCopied: true as const } }
  })
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box key="engine-band" />
  })
  return seen
}

/**
 * Reads Mod Doctor's state for the test (any plugin reads any value): `/peek` answers it as JSON.
 * An inline plugin, since the host lets only a scanned hooks module call `$.state.get`.
 */
const PEEK: Plugin = {
  name: 'peek',
  register(on) {
    on('command.run', { command: 'peek' }, async $ => {
      const [loaded, inline, report, checking, toasted] = await Promise.all([
        $.state.get({ plugin: 'mod-doctor', key: 'loaded' }),
        $.state.get({ plugin: 'mod-doctor', key: 'inline' }),
        $.state.get({ plugin: 'mod-doctor', key: 'report' }),
        $.state.get({ plugin: 'mod-doctor', key: 'checking' }),
        $.state.get({ plugin: 'mod-doctor', key: 'toasted' }),
      ])
      return {
        text: JSON.stringify({
          loaded: loaded.value ?? [],
          inline: inline.value ?? [],
          report: report.value ?? null,
          checking: checking.value ?? false,
          toasted: toasted.value ?? [],
        }),
      }
    })
  },
}

/** The inline plugins a test loads: the peek, then `names`, each with no hooks of its own. */
function withPlugins(...names: string[]): { plugins: Plugin[] } {
  return { plugins: [PEEK, ...names.map(plain)] }
}

type Snapshot = { loaded: string[]; inline: string[]; report: ModDoctorReport | null; checking: boolean; toasted: string[] }

async function peek($: Engine): Promise<Snapshot> {
  const result = await $.command.run({ command: 'peek', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } })
  return JSON.parse(result.text ?? '{}') as Snapshot
}

/** Waits until `check` holds: no hook waits on a check, so it lands beside the events. */
async function waitFor(check: () => boolean | Promise<boolean>, what = 'the condition') {
  for (let i = 0; i < 400; i++) {
    if (await check()) return
    await new Promise<void>(resolve => setTimeout(() => resolve(), 10))
  }
  throw new Error(`timed out waiting for ${what}`)
}

async function start($: Engine) {
  await $.session.start({ cwd: '.', surface: 'terminal', isInteractive: true })
}

/** Waits for the `n`th plugin list call's check to finish, and answers the report. */
async function checked($: Engine, seen: Control, n = 1): Promise<ModDoctorReport> {
  await waitFor(() => seen.ran.filter(argv => argv === LIST).length >= n, `plugin list call ${n}`)
  let snap: Snapshot | null = null
  await waitFor(async () => {
    snap = await peek($)
    return snap.report !== null && !snap.checking
  }, `check ${n}`)
  return (snap as Snapshot | null)!.report!
}

/** An inline plugin that loads beside Mod Doctor with no hooks of its own. */
function plain(name: string): Plugin {
  return { name, register() {} }
}

describe('session start', () => {
  test('/mod-doctor is the first command registered', async ($, on) => {
    const seen = engine(on)
    await start($)
    expect(seen.registered[0]).toEqual({ name: 'mod-doctor', description: "Show which mods loaded and why any didn't" })
  })

  test('all loaded: two mods loaded, no toast, no validate', withPlugins('relay', 'skins'), async ($, on) => {
    const seen = engine(on, {
      list: pluginList([RELAY_ENTRY, SKINS_ENTRY]),
      files: { [`${RELAY}/hooks/hooks.json`]: HOOKS_MODULE, [`${SKINS}/hooks/hooks.json`]: HOOKS_MODULE },
    })
    seen.commands = [
      { name: 'relay:send', description: 'x', source: 'plugin', plugin: 'relay' },
      { name: 'help', description: 'x', source: 'builtin' },
    ]
    await start($)
    const report = await checked($, seen)
    expect(report.error).toBe(null)
    expect(report.mods.map(m => [m.name, m.status])).toEqual([
      ['relay', 'loaded'],
      ['skins', 'loaded'],
    ])
    expect(report.mods[0]!.commands).toEqual(['send'])
    expect(report.skipped).toBe(0)
    expect(report.checkedAt).toBe(START)
    expect(seen.toasts).toEqual([])
    expect(seen.ran.some(argv => argv.startsWith('claude plugin validate'))).toBe(false)
    const { loaded } = await peek($)
    expect(loaded).toContain('relay')
    expect(loaded).toContain('skins')
  })
})

describe('a missing mod', () => {
  test('not-loaded with the parsed error and one toast, raised after validate; a second check adds none', withPlugins('skins'), async ($, on) => {
    const seen = engine(on, {
      list: pluginList([RELAY_ENTRY, SKINS_ENTRY]),
      files: { [`${RELAY}/hooks/hooks.json`]: HOOKS_MODULE, [`${SKINS}/hooks/hooks.json`]: HOOKS_MODULE },
      outputs: { [validate(RELAY)]: { exitCode: 1, stdout: PROBE_OUT } },
    })
    await start($)
    const report = await checked($, seen)
    expect(report.mods.map(m => [m.name, m.status])).toEqual([
      ['relay', 'not-loaded'],
      ['skins', 'loaded'],
    ])
    expect(report.mods[0]!.errors).toEqual([PARSE_ERROR])
    expect(seen.ran.filter(argv => argv.startsWith('claude plugin validate'))).toEqual([validate(RELAY)])
    expect(seen.toasts).toEqual([RELAY_TOAST])
    expect(seen.events.indexOf(`toast ${RELAY_TOAST}`)).toBeGreaterThan(seen.events.indexOf(`run ${validate(RELAY)}`))

    await start($)
    await checked($, seen, 2)
    expect(seen.ran.filter(argv => argv === validate(RELAY)).length).toBe(2)
    expect(seen.toasts).toEqual([RELAY_TOAST])
    expect((await peek($)).toasted).toEqual([`relay|not-loaded|${PARSE_ERROR}`])
  })

  test('a mod no load event named but whose hooks module registered a bare command is loaded (a /reload-plugins newcomer)', withPlugins('skins'), async ($, on) => {
    const seen = engine(on, {
      list: pluginList([RELAY_ENTRY, SKINS_ENTRY]),
      files: { [`${RELAY}/hooks/hooks.json`]: HOOKS_MODULE, [`${SKINS}/hooks/hooks.json`]: HOOKS_MODULE },
      outputs: { [validate(RELAY)]: { exitCode: 1, stdout: PROBE_OUT } },
    })
    seen.commands = [{ name: 'relay', description: 'x', source: 'plugin', plugin: 'relay' }]
    await start($)
    const report = await checked($, seen)
    expect(report.mods.map(m => [m.name, m.status])).toEqual([
      ['relay', 'loaded'],
      ['skins', 'loaded'],
    ])
    expect(seen.ran.some(argv => argv.startsWith('claude plugin validate'))).toBe(false)
    expect(seen.toasts).toEqual([])
    expect((await peek($)).loaded).toContain('relay')
  })

  test('a namespaced (skill) command alone does not count as loaded', withPlugins('skins'), async ($, on) => {
    const seen = engine(on, {
      list: pluginList([RELAY_ENTRY, SKINS_ENTRY]),
      files: { [`${RELAY}/hooks/hooks.json`]: HOOKS_MODULE, [`${SKINS}/hooks/hooks.json`]: HOOKS_MODULE },
      outputs: { [validate(RELAY)]: { exitCode: 1, stdout: PROBE_OUT } },
    })
    seen.commands = [{ name: 'relay:send', description: 'x', source: 'plugin', plugin: 'relay' }]
    await start($)
    const report = await checked($, seen)
    expect(report.mods.find(m => m.name === 'relay')!.status).toBe('not-loaded')
  })

  test('validate failing with output it cannot parse names the exit code', withPlugins(), async ($, on) => {
    const seen = engine(on, {
      list: pluginList([RELAY_ENTRY]),
      files: { [`${RELAY}/hooks/hooks.json`]: HOOKS_MODULE },
      outputs: { [validate(RELAY)]: { exitCode: 2, stdout: 'something odd', stderr: 'boom' } },
    })
    await start($)
    const report = await checked($, seen)
    expect(report.mods[0]!.status).toBe('not-loaded')
    expect(report.mods[0]!.errors).toEqual(['validate failed (exit 2)'])
  })

  test('validate passing says to reload; validate that cannot start says so', withPlugins(), async ($, on) => {
    const other: Entry = { id: 'other@roberts-mods', folder: 'C:\\c\\other' }
    const seen = engine(on, {
      list: pluginList([RELAY_ENTRY, other]),
      files: { [`${RELAY}/hooks/hooks.json`]: HOOKS_MODULE, ['C:\\c\\other/hooks/hooks.json']: HOOKS_MODULE },
      outputs: { [validate(RELAY)]: { exitCode: 0, stdout: '✔ Validation passed' } },
    })
    seen.refused.add(validate('C:\\c\\other'))
    await start($)
    const report = await checked($, seen)
    expect(report.mods.find(m => m.name === 'relay')!.note).toBe('validate passes; try /reload-plugins')
    expect(report.mods.find(m => m.name === 'other')!.note).toBe("couldn't validate: timed out or could not start")
  })
})

describe('skipped plugins', () => {
  test('a skills-only plugin and a classic-hooks one are skipped, never checked', withPlugins('relay'), async ($, on) => {
    const seen = engine(on, {
      list: pluginList([RELAY_ENTRY, { id: 'docs@x', folder: DOCS }, { id: 'classic@x', folder: CLASSIC }, { id: 'off@x', folder: 'C:\\c\\off', enabled: false }]),
      files: { [`${RELAY}/hooks/hooks.json`]: HOOKS_MODULE, [`${CLASSIC}/hooks/hooks.json`]: '{ "hooks": { "Stop": [] } }' },
    })
    await start($)
    const report = await checked($, seen)
    expect(report.mods.map(m => m.name)).toEqual(['relay'])
    expect(report.skipped).toBe(2)
    expect(seen.ran.some(argv => argv.startsWith('claude plugin validate'))).toBe(false)
  })
})

describe('a check that cannot run', () => {
  test('claude that fails to start: claude CLI not found, no toast', withPlugins(), async ($, on) => {
    const seen = engine(on, { list: pluginList([RELAY_ENTRY]) })
    seen.refused.add(LIST)
    await start($)
    const report = await checked($, seen)
    expect(report.error).toBe('claude CLI not found')
    expect(report.mods).toEqual([])
    expect(seen.toasts).toEqual([])
  })

  test('plugin list exiting non-zero names the exit code', withPlugins(), async ($, on) => {
    const seen = engine(on, { outputs: { [LIST]: { exitCode: 3, stdout: '' } } })
    await start($)
    expect((await checked($, seen)).error).toBe('plugin list failed (exit 3)')
  })

  test('plugin list output that is not JSON is not understood', withPlugins(), async ($, on) => {
    const seen = engine(on, { list: 'Installed plugins:\n  relay' })
    await start($)
    expect((await checked($, seen)).error).toBe('plugin list output not understood')
    expect(seen.toasts).toEqual([])
  })
})

describe('plugin.register', () => {
  // The kit raises plugin.register only while it loads the plugins (no later join can be
  // raised), so the debounce is seen from a load with no session.start: peek's call loads them.
  test('a module joining after Mod Doctor is loaded, and checked once 2 s after it joined', withPlugins('foo'), async ($, on) => {
    const seen = engine(on, {
      list: pluginList([{ id: 'foo@x', folder: FOO }]),
      files: { [`${FOO}/hooks/hooks.json`]: HOOKS_MODULE },
    })
    const loadedNow = await peek($)
    expect(loadedNow.loaded).toContain('foo')
    // The kit's own provenance (`foo@claude-plugin-test`) is not --plugin-dir's.
    expect(loadedNow.inline).toEqual([])
    await seen.clock.advance(1_999)
    expect(seen.ran.filter(argv => argv === LIST).length).toBe(0)
    await seen.clock.advance(1)
    const report = await checked($, seen)
    expect(report.mods.map(m => [m.name, m.status])).toEqual([['foo', 'loaded']])
    await seen.clock.advance(10_000)
    expect(seen.ran.filter(argv => argv === LIST).length).toBe(1)
  })

  test('/reload-plugins: checked again 2 s after it finishes (its newcomers raise no plugin.register)', withPlugins(), async ($, on) => {
    const seen = engine(on, {
      list: pluginList([{ id: 'foo@x', folder: FOO }]),
      files: { [`${FOO}/hooks/hooks.json`]: HOOKS_MODULE },
    })
    on('command.run', { command: 'reload-plugins' }, () => ({ text: 'Reloaded: 1 plugin' }))
    await start($)
    await checked($, seen)
    expect(seen.ran.filter(argv => argv === LIST).length).toBe(1)
    const answer = await $.command.run({ command: 'reload-plugins', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } })
    expect(answer.text).toBe('Reloaded: 1 plugin')
    await seen.clock.advance(1_999)
    expect(seen.ran.filter(argv => argv === LIST).length).toBe(1)
    await seen.clock.advance(1)
    await checked($, seen, 2)
    expect(seen.ran.filter(argv => argv === LIST).length).toBe(2)
  })

  test("session.start's check replaces the load's pending debounced one: plugin list runs once", withPlugins('foo'), async ($, on) => {
    const seen = engine(on, {
      list: pluginList([{ id: 'foo@x', folder: FOO }]),
      files: { [`${FOO}/hooks/hooks.json`]: HOOKS_MODULE },
    })
    await start($)
    await checked($, seen)
    await seen.clock.advance(2_000)
    await new Promise<void>(resolve => setTimeout(() => resolve(), 30))
    expect(seen.ran.filter(argv => argv === LIST).length).toBe(1)
  })

  test("the hook returns core's { allow: true } unchanged", {
    plugins: [
      {
        name: 'observer',
        tier: 'prepend',
        register(on) {
          on('plugin.register', async ($, e, next) => {
            const result = await next(e)
            if (e.name === 'foo') $.ui.toast(`register foo ${JSON.stringify(result)}`)
            return result
          })
        },
      },
      plain('foo'),
    ],
  }, async ($, on) => {
    const seen = engine(on)
    await start($)
    expect(seen.toasts).toContain('register foo {"allow":true}')
  })

  test('only a --plugin-dir provenance counts as inline, never Mod Doctor itself', () => {
    expect(isInlineProvenance('foo', 'foo@inline')).toBe(true)
    expect(isInlineProvenance('foo', 'foo@roberts-mods')).toBe(false)
    expect(isInlineProvenance('foo', 'foo@claude-plugin-test')).toBe(false)
    expect(isInlineProvenance('mod-doctor', 'mod-doctor@inline')).toBe(false)
  })
})

describe('single flight', () => {
  test('checks asked for while one runs queue one follow-up: plugin list runs exactly twice', withPlugins(), async ($, on) => {
    const seen = engine(on, { list: pluginList([RELAY_ENTRY]), files: { [`${RELAY}/hooks/hooks.json`]: HOOKS_MODULE } })
    let release = () => {}
    seen.hold = new Promise<void>(resolve => {
      release = resolve
    })
    await start($)
    await waitFor(() => seen.ran.includes(LIST), 'the held plugin list')
    await start($)
    await start($)
    seen.hold = null
    release()
    await checked($, seen, 2)
    await new Promise<void>(resolve => setTimeout(() => resolve(), 30))
    expect(seen.ran.filter(argv => argv === LIST).length).toBe(2)
  })

  test('a hung check gives check timed out once the 90 s watchdog fires, and frees the next check', withPlugins(), async ($, on) => {
    const seen = engine(on, { list: pluginList([RELAY_ENTRY]), files: { [`${RELAY}/hooks/hooks.json`]: HOOKS_MODULE } })
    seen.hold = new Promise<void>(() => {})
    await start($)
    await waitFor(() => seen.ran.includes(LIST), 'the hung plugin list')
    await seen.clock.advance(89_999)
    expect((await peek($)).checking).toBe(true)
    await seen.clock.advance(1)
    const report = await checked($, seen)
    expect(report.error).toBe('check timed out')
    expect(seen.toasts).toEqual([])
    seen.hold = null
    await start($)
    const next = await checked($, seen, 2)
    expect(next.error).toBe(null)
    expect(next.mods.map(m => m.name)).toEqual(['relay'])
  })
})

/** Whether A and B are each assignable to the other. */
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false

describe('the contract', () => {
  test("core's Report and ModReport match the contract's ModDoctorReport and ModDoctorMod", () => {
    // A compile-time check: tsc fails here if the shapes drift apart.
    const reports: Same<Report, ModDoctorReport> = true
    const mods: Same<ModReport, ModDoctorMod> = true
    expect([reports, mods]).toEqual([true, true])
  })
})

const PLUGIN = 'mod-doctor'
const PANE = 'mod-doctor'
const RELAY_ROW = "✗ Mod Doctor  1 mod didn't load: relay"

async function modDoctor($: Engine) {
  return $.command.run({ command: 'mod-doctor', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } })
}

async function mountBand($: Engine) {
  const props: RenderPropsOf['AbovePrompt'] = { hasSurvey: false, isWorking: false, maxRows: 20, bodyColumns: 140, scroll: { offset: 0, bodyRows: 20 }, view: {} }
  return $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'AbovePrompt', props, viewport: { columns: 140, rows: 40, isFullscreen: true } })
}

async function band($: Engine) {
  const drawn = await mountBand($)
  const found = {
    engineBand: await drawn.find({ key: 'engine-band' }),
    row: await drawn.find({ key: 'mod-doctor-row' }),
    text: (await drawn.find({ key: 'mod-doctor-text' }))?.text,
    toggle: (await drawn.find({ key: 'mod-doctor-toggle' }))?.props.label,
  }
  await drawn.unmount()
  return found
}

async function mountPane($: Engine) {
  const props: RenderPropsOf['Pane'] = { title: 'Mod Doctor', isFocused: true, bodyColumns: 100, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} }
  return $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'Pane', requestId: PANE, props, viewport: { columns: 160, rows: 50, isFullscreen: true } })
}

/** The pane's line texts, in order, and whether Re-check is drawn dim. */
async function pane($: Engine) {
  const drawn = await mountPane($)
  const lines: string[] = []
  for (let i = 0; ; i++) {
    const line = await drawn.find({ key: `mod-doctor-line-${i}` })
    if (line === undefined) break
    lines.push(line.text)
  }
  const found = {
    lines,
    waiting: (await drawn.find({ key: 'mod-doctor-waiting' }))?.text,
    isRecheckDim: (await drawn.find({ key: 'mod-doctor-recheck' }))?.props.dimColor,
  }
  await drawn.unmount()
  return found
}

async function pressInPane($: Engine, key: string) {
  const drawn = await mountPane($)
  await drawn.press({ key })
  await drawn.unmount()
}

function lists(seen: Control): number {
  return seen.ran.filter(argv => argv === LIST).length
}

/** relay and skins both enabled with hooks modules; relay's validate fails to parse. */
function twoMods(on: On): Control {
  return engine(on, {
    list: pluginList([RELAY_ENTRY, SKINS_ENTRY]),
    files: { [`${RELAY}/hooks/hooks.json`]: HOOKS_MODULE, [`${SKINS}/hooks/hooks.json`]: HOOKS_MODULE },
    outputs: { [validate(RELAY)]: { exitCode: 1, stdout: PROBE_OUT }, [validate(SKINS)]: { exitCode: 0, stdout: '✔ Validation passed' } },
  })
}

describe('hhmm', () => {
  test('two-digit local hours and minutes', () => {
    const at = new Date(2026, 9, 15, 9, 5).getTime()
    expect(hhmm(at)).toBe('09:05')
  })
  test('a check with no clock (0) shows --:--', () => expect(hhmm(0)).toBe('--:--'))
})

describe('row', () => {
  test("absent when every mod loaded: the band is next's alone", withPlugins('relay', 'skins'), async ($, on) => {
    const seen = twoMods(on)
    await start($)
    await checked($, seen)
    const { engineBand, row } = await band($)
    expect(engineBand).toBeDefined()
    expect(row).toBeUndefined()
  })

  test('present when relay is missing, under the other rows; its button opens the pane, then closes it', withPlugins('skins'), async ($, on) => {
    const seen = twoMods(on)
    await start($)
    await checked($, seen)
    const { engineBand, text, toggle } = await band($)
    expect(engineBand).toBeDefined()
    expect(text).toBe(RELAY_ROW)
    expect(toggle).toBe('Open')
    const drawn = await mountBand($)
    await drawn.press({ key: 'mod-doctor-toggle' })
    expect(seen.opened).toEqual([{ id: PANE, title: 'Mod Doctor' }])
    await drawn.unmount()
    expect((await band($)).toggle).toBe('Close')
    const again = await mountBand($)
    await again.press({ key: 'mod-doctor-toggle' })
    await again.unmount()
    expect(seen.closed).toEqual([PANE])
    expect((await band($)).toggle).toBe('Open')
  })

  test('a pane closed by the person: the button reads the engine and opens it again', withPlugins('skins'), async ($, on) => {
    // The kit's $ cannot raise a person's ui.close, so their close is the engine's list losing the pane.
    const seen = twoMods(on)
    await start($)
    await checked($, seen)
    await modDoctor($)
    seen.panes.delete(PANE)
    const drawn = await mountBand($)
    await drawn.press({ key: 'mod-doctor-toggle' })
    await drawn.unmount()
    expect(seen.opened.length).toBe(2)
    expect(seen.closed).toEqual([])
    expect((await band($)).toggle).toBe('Close')
  })

  test('absent when the check could not run', withPlugins(), async ($, on) => {
    const seen = engine(on)
    seen.refused.add(LIST)
    await start($)
    await checked($, seen)
    expect((await band($)).row).toBeUndefined()
  })
})

describe('pane', () => {
  test('/mod-doctor opens the pane and checks again; it answers nothing as text', withPlugins('skins'), async ($, on) => {
    const seen = twoMods(on)
    await start($)
    await checked($, seen)
    const result = await modDoctor($)
    expect(result.text).toBeUndefined()
    expect(seen.opened).toEqual([{ id: PANE, title: 'Mod Doctor' }])
    await checked($, seen, 2)
  })

  test('the header, then relay not loaded with its error, then skins, then the skipped count', withPlugins('skins'), async ($, on) => {
    const seen = twoMods(on)
    await start($)
    await checked($, seen)
    const { lines } = await pane($)
    expect(lines).toEqual([
      `Checked ${hhmm(START)} · 2 mods · 1 problem`,
      '✗ relay  not loaded',
      `    ${PARSE_ERROR}`,
      '✓ skins  1.0.0',
      '0 skipped (no hooks module)',
    ])
  })

  test('before the first report the pane says checking…', withPlugins(), async ($, on) => {
    const seen = twoMods(on)
    let release = () => {}
    seen.hold = new Promise<void>(resolve => {
      release = resolve
    })
    await start($)
    await waitFor(() => lists(seen) === 1, 'the held plugin list')
    expect((await pane($)).waiting).toBe('checking…')
    seen.hold = null
    release()
    await checked($, seen)
    expect((await pane($)).waiting).toBeUndefined()
  })

  test('a pane with no room yet says to widen the window', withPlugins(), async ($, on) => {
    const seen = twoMods(on)
    seen.isUnplaced = true
    await start($)
    await checked($, seen)
    await modDoctor($)
    expect(seen.toasts).toContain('Widen the window to see the Mod Doctor pane.')
  })

  test('a copy the surface refuses says why', withPlugins('skins'), async ($, on) => {
    const seen = twoMods(on)
    seen.isCopyRefused = true
    await start($)
    await checked($, seen)
    await pressInPane($, 'mod-doctor-copy')
    expect(seen.toasts).toContain('Mod Doctor: could not copy the report (no-clipboard)')
    expect(seen.toasts).not.toContain('Mod Doctor report copied')
  })

  test('Re-check validates every checked mod and can find a loaded one broken', withPlugins('relay', 'skins'), async ($, on) => {
    const seen = twoMods(on)
    await start($)
    expect((await checked($, seen)).mods.map(m => m.status)).toEqual(['loaded', 'loaded'])
    expect(seen.ran.some(argv => argv.startsWith('claude plugin validate'))).toBe(false)
    await pressInPane($, 'mod-doctor-recheck')
    const report = await checked($, seen, 2)
    expect(seen.ran.filter(argv => argv.startsWith('claude plugin validate')).sort()).toEqual([validate(RELAY), validate(SKINS)].sort())
    expect(report.mods.map(m => [m.name, m.status])).toEqual([
      ['relay', 'broken'],
      ['skins', 'loaded'],
    ])
    expect((await pane($)).lines[1]).toBe('✗ relay  broken on disk')
    expect(seen.toasts).toEqual(['Mod Doctor: relay is broken on disk — /mod-doctor for why'])
    expect((await band($)).text).toBe('✗ Mod Doctor  1 mod is broken: relay')
  })

  test('Re-check pressed during a plain check is drawn dim but still queues a full follow-up', withPlugins('relay', 'skins'), async ($, on) => {
    const seen = twoMods(on)
    await start($)
    await checked($, seen)
    expect((await pane($)).isRecheckDim).toBe(false)
    let release = () => {}
    seen.hold = new Promise<void>(resolve => {
      release = resolve
    })
    // /mod-doctor starts a plain check (no validate for loaded mods); it is held.
    const opening = modDoctor($)
    await waitFor(() => lists(seen) === 2, 'the held plain check')
    const drawn = await mountPane($)
    await waitFor(async () => (await drawn.find({ key: 'mod-doctor-recheck' }))?.props.dimColor === true, 'Re-check drawn dim')
    expect((await drawn.find({ key: 'mod-doctor-line-0' }))?.text).toBe(`Checked ${hhmm(START)} · 2 mods · 0 problems · checking…`)
    await drawn.press({ key: 'mod-doctor-recheck' })
    await drawn.unmount()
    expect(seen.ran.some(argv => argv.startsWith('claude plugin validate'))).toBe(false)
    seen.hold = null
    release()
    await opening
    const report = await checked($, seen, 3)
    expect(seen.ran.filter(argv => argv.startsWith('claude plugin validate')).sort()).toEqual([validate(RELAY), validate(SKINS)].sort())
    expect(report.mods.find(m => m.name === 'relay')!.status).toBe('broken')
    await new Promise<void>(resolve => setTimeout(() => resolve(), 30))
    expect(lists(seen)).toBe(3)
  })

  test('Copy report copies the plain text and says so', withPlugins('skins'), async ($, on) => {
    const seen = twoMods(on)
    await start($)
    await checked($, seen)
    await pressInPane($, 'mod-doctor-copy')
    expect(seen.copied.length).toBe(1)
    expect(seen.copied[0]!.startsWith('Mod Doctor report\n')).toBe(true)
    expect(seen.copied[0]).toContain('✗ relay  not loaded')
    expect(seen.toasts).toContain('Mod Doctor report copied')
  })

  test('Close closes the pane', withPlugins(), async ($, on) => {
    const seen = twoMods(on)
    await start($)
    await checked($, seen)
    await pressInPane($, 'mod-doctor-close')
    expect(seen.closed).toEqual([PANE])
  })
})

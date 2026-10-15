import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On, RenderPropsOf } from 'claude-code'

/** The runtime has it; the tsconfig's es2023 lib does not declare it. */
declare const setTimeout: (fn: () => void, ms: number) => unknown

const PLUGIN = 'git-ship'
const PANE = 'git-ship'
const ROOT = 'D:\\Projects\\app'
const START = 1_800_000_000_000
const STATUS = 'git -c core.quotePath=false --no-optional-locks status --porcelain=v2 --branch'
const TOPLEVEL = 'git rev-parse --show-toplevel'
const LOG = 'git log -1 --format=%h %s'
const ORIGIN_HEAD = 'git symbolic-ref --short refs/remotes/origin/HEAD'
const GH_VIEW = 'gh pr view --json number,state'
const CLEAN = '◆ Ship  main · clean · ↑0 ↓0'

/** `git status --porcelain=v2 --branch` output for a branch and its files. */
function status(o: { head?: string; upstream?: string | null; ab?: string; files?: string[] } = {}): string {
  const lines = ['# branch.oid 1a2b3c4d5e6f', `# branch.head ${o.head ?? 'main'}`]
  const upstream = o.upstream === undefined ? 'origin/main' : o.upstream
  if (upstream !== null) lines.push(`# branch.upstream ${upstream}`, `# branch.ab ${o.ab ?? '+0 -0'}`)
  return `${[...lines, ...(o.files ?? [])].join('\n')}\n`
}

const THREE = ['1 .M N... 100644 100644 100644 aaa bbb a.ts', '1 M. N... 100644 100644 100644 aaa bbb b.ts', '? c.txt']

/** argv (joined by spaces) → stdout; a command not listed exits 128. */
function repo(statusText: string, extra: Record<string, string> = {}): Record<string, string> {
  return {
    [TOPLEVEL]: 'D:/Projects/app\n',
    [STATUS]: statusText,
    [LOG]: '1a2b3c4 Fix the row\n',
    [ORIGIN_HEAD]: 'origin/main\n',
    ...extra,
  }
}

type Control = {
  /** The canned outputs; tests swap them between refreshes. */
  outputs: Record<string, string>
  /** Every process.run call, its argv joined. */
  ran: string[]
  /** The env each gh call was given. */
  ghEnv: Array<Record<string, string> | undefined>
  /** Holds the status call until resolved (to overlap refreshes). */
  hold: Promise<void> | null
  /** process.run is refused (git missing or timed out). */
  isRefused: boolean
  /** Commands refused one by one (a single call timing out). */
  refused: Set<string>
  /** Answers for the next gh calls, each held until its gate opens. */
  ghQueue: Array<{ gate: Promise<void>; out: string }>
  /** ui.open answers isPlaced false (a narrow terminal). */
  isUnplaced: boolean
  /** ui.open is refused. */
  isOpenRefused: boolean
  /** The panes the engine has open. */
  panes: Set<string>
  filled: Array<{ text: string; mode: string | undefined }>
  submitted: string[]
  toasts: string[]
  opened: string[]
  closed: string[]
  clock: ReturnType<typeof mock.clock>
}

/** Stands in for the engine beneath the mod. */
function engine(on: On, outputs: Record<string, string>): Control {
  const seen: Control = {
    outputs,
    ran: [],
    ghEnv: [],
    hold: null,
    isRefused: false,
    refused: new Set(),
    ghQueue: [],
    isUnplaced: false,
    isOpenRefused: false,
    panes: new Set(),
    filled: [],
    submitted: [],
    toasts: [],
    opened: [],
    closed: [],
    clock: mock.clock(on, { now: START }),
  }
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('session.root', () => ({ value: ROOT }))
  on('process.run', async ($, e) => {
    const argv = e.argv.join(' ')
    seen.ran.push(argv)
    if (e.argv[0] === 'gh') seen.ghEnv.push(e.init?.env)
    if (seen.isRefused || seen.refused.has(argv)) return { deny: 'timed out' }
    const queued = e.argv[0] === 'gh' ? seen.ghQueue.shift() : undefined
    if (queued !== undefined) {
      await queued.gate
      return { value: { exitCode: 0, stdout: queued.out, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    }
    if (argv === STATUS && seen.hold !== null) await seen.hold
    const out = seen.outputs[argv]
    return {
      value: { exitCode: out === undefined ? 128 : 0, stdout: out ?? '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
    }
  })
  on('prompt.fill', ($, e) => {
    seen.filled.push({ text: e.text, mode: e.mode })
    return { isFilled: true }
  })
  on('prompt.submit', ($, e) => {
    seen.submitted.push(e.text)
    return { text: e.text }
  })
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('ui.toast', ($, e) => {
    seen.toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.open', ($, e) => {
    seen.opened.push(e.id)
    if (seen.isOpenRefused) return { deny: 'no room for panes' }
    seen.panes.add(e.id)
    return { value: seen.isUnplaced ? { isPlaced: false as const, reason: 'narrow' } : { isPlaced: true as const } }
  })
  on('ui.close', ($, e) => {
    seen.closed.push(e.id)
    seen.panes.delete(e.id)
    return { value: undefined }
  })
  on('ui.panes', () => ({
    value: [...seen.panes].map(id => ({ id, title: 'Git Ship', isShown: true, isFocused: false, isPlaced: !seen.isUnplaced })),
  }))
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box key="engine-band" />
  })
  return seen
}

/** Waits until `check` holds: no hook waits on git, so reads land beside the events. */
async function waitFor(check: () => boolean | Promise<boolean>, what = 'the condition') {
  for (let i = 0; i < 200; i++) {
    if (await check()) return
    await new Promise<void>(resolve => setTimeout(() => resolve(), 5))
  }
  throw new Error(`timed out waiting for ${what}`)
}

async function start($: Engine) {
  await $.session.start({ cwd: '.', surface: 'terminal', isInteractive: true })
}

/** Session start, then the first read landed on the row. */
async function started($: Engine) {
  await start($)
  await waitFor(async () => (await band($)).text !== undefined, 'the first read')
}

async function reply($: Engine) {
  await $.turn.complete({ answer: 'ok', durationMs: 1000, isAborted: false, turnId: 't1', reason: 'answer' })
}

async function ship($: Engine) {
  return $.command.run({ command: 'ship', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } })
}

function bandProps(bodyColumns: number): RenderPropsOf['AbovePrompt'] {
  return { hasSurvey: false, isWorking: false, maxRows: 20, bodyColumns, scroll: { offset: 0, bodyRows: 20 }, view: {} }
}

async function mountBand($: Engine) {
  return $.ui.mount({
    plugin: PLUGIN,
    surface: 'terminal',
    component: 'AbovePrompt',
    props: bandProps(140),
    viewport: { columns: 140, rows: 40, isFullscreen: true },
  })
}

async function mountPane($: Engine) {
  const props: RenderPropsOf['Pane'] = {
    title: 'Git Ship',
    isFocused: true,
    bodyColumns: 100,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  }
  return $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'Pane', requestId: PANE, props, viewport: { columns: 160, rows: 50, isFullscreen: true } })
}

async function band($: Engine) {
  const drawn = await mountBand($)
  const found = {
    engineBand: await drawn.find({ key: 'engine-band' }),
    row: await drawn.find({ key: 'git-ship-row' }),
    text: (await drawn.find({ key: 'git-ship-text' }))?.text,
    toggle: (await drawn.find({ key: 'git-ship-toggle' }))?.props.label,
  }
  await drawn.unmount()
  return found
}

async function bandText($: Engine) {
  return (await band($)).text
}

/** The text of the pane line keyed `key`. */
async function paneLine($: Engine, key: string) {
  const pane = await mountPane($)
  const text = (await pane.find({ key }))?.text
  await pane.unmount()
  return text
}

/** Presses one of the open pane's buttons. */
async function pressInPane($: Engine, key: string) {
  const pane = await mountPane($)
  await pane.press({ key })
  await pane.unmount()
}

/** `/ship`, then the pane's read (and PR check) landed. */
async function openShip($: Engine, seen: Control) {
  const before = seen.ran.length
  await ship($)
  await waitFor(() => seen.ran.slice(before).includes(STATUS), 'the pane read')
  await waitFor(async () => (await paneLine($, 'git-ship-head')) !== undefined, 'the pane header')
}

describe('row', () => {
  test('outside a repo the band is the engine band alone', async ($, on) => {
    const seen = engine(on, {})
    await start($)
    await waitFor(() => seen.ran.includes(TOPLEVEL), 'rev-parse')
    const { engineBand, row } = await band($)
    expect(engineBand).toBeDefined()
    expect(row).toBeUndefined()
  })

  test('a repo with three changes, two ahead', async ($, on) => {
    engine(on, repo(status({ ab: '+2 -0', files: THREE })))
    await started($)
    const { engineBand, text, toggle } = await band($)
    expect(engineBand).toBeDefined()
    expect(text).toBe('◆ Ship  main · 3 changed · ↑2 ↓0')
    expect(toggle).toBe('Open')
  })

  test('git that cannot run shows git unavailable and no button', async ($, on) => {
    const seen = engine(on, repo(status()))
    seen.isRefused = true
    await started($)
    const { text, toggle } = await band($)
    expect(text).toBe('◆ Ship  git unavailable')
    expect(toggle).toBeUndefined()
  })

  test('a status call that fails shows git unavailable; Close stays while the pane is open', async ($, on) => {
    const outputs = repo(status())
    delete outputs[STATUS]
    const seen = engine(on, outputs)
    await started($)
    expect(await bandText($)).toBe('◆ Ship  git unavailable')
    await ship($)
    await waitFor(async () => (await band($)).toggle === 'Close', 'the Close button')
    const drawn = await mountBand($)
    await drawn.press({ key: 'git-ship-toggle' })
    await drawn.unmount()
    expect(seen.closed).toEqual([PANE])
    expect((await band($)).toggle).toBeUndefined()
  })

  test('the row button opens and closes the pane', async ($, on) => {
    const seen = engine(on, repo(status({ files: THREE })))
    await started($)
    const drawn = await mountBand($)
    await drawn.press({ key: 'git-ship-toggle' })
    expect(seen.opened).toEqual([PANE])
    expect((await drawn.find({ key: 'git-ship-toggle' }))?.props.label).toBe('Close')
    await drawn.press({ key: 'git-ship-toggle' })
    expect(seen.closed).toEqual([PANE])
    expect((await drawn.find({ key: 'git-ship-toggle' }))?.props.label).toBe('Open')
    await drawn.unmount()
  })
})

describe('pane', () => {
  test('/ship opens the pane: files, +N more past 10, the last commit', async ($, on) => {
    const files = Array.from({ length: 12 }, (_, i) => `1 .M N... 100644 100644 100644 aaa bbb f${i}.ts`)
    const seen = engine(on, repo(status({ ab: '+1 -2', files })))
    await started($)
    const result = await ship($)
    expect(result.text).toBeUndefined()
    expect(seen.opened).toEqual([PANE])
    const pane = await mountPane($)
    expect((await pane.find({ key: 'git-ship-head' }))?.text).toBe('main → origin/main  ↑1 ↓2')
    expect((await pane.findAll({ type: 'Text', text: /\.M {2}f\d+\.ts/ })).length).toBe(10)
    expect((await pane.find({ key: 'git-ship-file-0' }))?.text).toBe('  .M  f0.ts')
    expect((await pane.find({ key: 'git-ship-more' }))?.text).toBe('  +2 more')
    expect((await pane.find({ key: 'git-ship-last' }))?.text).toBe('last: 1a2b3c4 Fix the row')
    await pane.unmount()
  })

  test('/ship again closes it', async ($, on) => {
    const seen = engine(on, repo(status()))
    await started($)
    await ship($)
    await ship($)
    expect(seen.closed).toEqual([PANE])
  })

  test('a pane closed by the person: the toggle reads the engine and opens it again', async ($, on) => {
    // The kit's $ cannot raise ui.close (origin person), so the person's close is
    // the engine's pane list losing the pane, as it would after their close mark.
    const seen = engine(on, repo(status()))
    await started($)
    await ship($)
    expect((await band($)).toggle).toBe('Close')
    seen.panes.delete(PANE)
    await ship($)
    expect(seen.opened).toEqual([PANE, PANE])
    expect(seen.closed).toEqual([])
    expect((await band($)).toggle).toBe('Close')
  })

  test('a pane waiting for room toasts; one refused leaves Open', async ($, on) => {
    const seen = engine(on, repo(status()))
    await started($)
    seen.isUnplaced = true
    await ship($)
    expect(seen.toasts).toContain('Widen the window to see the Git Ship pane.')
    await ship($)
    expect(seen.closed).toEqual([PANE])

    seen.isUnplaced = false
    seen.isOpenRefused = true
    await ship($)
    expect(seen.toasts.some(text => text.startsWith('Git Ship: the pane could not open'))).toBe(true)
    expect((await band($)).toggle).toBe('Open')
  })

  test('a conflict shows the resolve line', async ($, on) => {
    const seen = engine(on, repo(status({ files: ['u UU N... 100644 100644 100644 100644 aaa bbb ccc conflict.ts'] })))
    await started($)
    await openShip($, seen)
    expect(await paneLine($, 'git-ship-conflicts')).toBe('resolve conflicts, then git add <file> yourself')
  })

  test('each button fills its command, replacing the draft', async ($, on) => {
    const seen = engine(on, repo(status({ head: 'feat', upstream: null, files: THREE })))
    await started($)
    await openShip($, seen)
    await pressInPane($, 'git-ship-stage')
    await pressInPane($, 'git-ship-push')
    await pressInPane($, 'git-ship-branch')
    seen.outputs[STATUS] = status({ ab: '+0 -1' })
    await reply($)
    await waitFor(async () => (await bandText($)) === '◆ Ship  main · clean · ↑0 ↓1', 'the pulled-behind read')
    await pressInPane($, 'git-ship-pull')
    expect(seen.filled).toEqual([
      { text: '!git add -A', mode: 'replace' },
      { text: '!git push -u origin "feat"', mode: 'replace' },
      { text: '!git switch -c ', mode: 'replace' },
      { text: '!git pull', mode: 'replace' },
    ])
  })

  test('a disabled Push (nothing ahead, an upstream) fills nothing and is drawn dim', async ($, on) => {
    const seen = engine(on, repo(status({ ab: '+0 -0' })))
    await started($)
    await openShip($, seen)
    const pane = await mountPane($)
    expect((await pane.find({ key: 'git-ship-push' }))?.props.dimColor).toBe(true)
    await pane.press({ key: 'git-ship-push' })
    await pane.unmount()
    expect(seen.filled).toEqual([])
  })

  test('no button ever submits', async ($, on) => {
    const seen = engine(on, repo(status({ head: 'feat', upstream: 'origin/feat', ab: '+1 -1', files: THREE })))
    await started($)
    await openShip($, seen)
    for (const key of ['stage', 'commit', 'push', 'pull', 'branch', 'pr']) {
      await pressInPane($, `git-ship-${key}`)
      expect(seen.submitted).toEqual([])
    }
    expect(seen.filled.length).toBe(6)
    await pressInPane($, 'git-ship-close')
    expect(seen.submitted).toEqual([])
    expect(seen.closed).toEqual([PANE])
  })

  test('PR on a feature branch with an open PR fills pr view; on the default branch gh never runs', async ($, on) => {
    const seen = engine(on, repo(status({ head: 'feat', upstream: 'origin/feat' }), { [GH_VIEW]: '{"number":4,"state":"OPEN"}' }))
    await started($)
    await openShip($, seen)
    await waitFor(() => seen.ran.includes(GH_VIEW), 'the PR check')
    expect(seen.ghEnv[0]).toEqual({ GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1' })
    await waitFor(async () => {
      await pressInPane($, 'git-ship-pr')
      return seen.filled.length > 0
    }, 'the PR fill')
    expect(seen.filled).toEqual([{ text: '!gh pr view --web', mode: 'replace' }])

    await ship($)
    seen.outputs[STATUS] = status({ head: 'main' })
    seen.ran.length = 0
    await openShip($, seen)
    await waitFor(async () => (await paneLine($, 'git-ship-head')) === 'main → origin/main  ↑0 ↓0', 'the main read')
    expect(seen.ran.some(argv => argv.startsWith('gh '))).toBe(false)
    await pressInPane($, 'git-ship-pr')
    expect(seen.filled.length).toBe(1)
  })

  test('a branch switch drops the PR answer and checks again while the pane is open', async ($, on) => {
    const seen = engine(on, repo(status({ head: 'feat', upstream: 'origin/feat' }), { [GH_VIEW]: '{"number":4,"state":"OPEN"}' }))
    await started($)
    await openShip($, seen)
    await waitFor(() => seen.ran.filter(argv => argv === GH_VIEW).length === 1, 'the first PR check')
    seen.outputs[GH_VIEW] = '{"number":5,"state":"CLOSED"}'
    seen.outputs[STATUS] = status({ head: 'other', upstream: 'origin/other' })
    await reply($)
    await waitFor(() => seen.ran.filter(argv => argv === GH_VIEW).length === 2, 'the second PR check')
    await waitFor(async () => (await paneLine($, 'git-ship-head'))?.startsWith('other') === true, 'the switched read')
    // The check runs after the read lands; press until its answer is in.
    await waitFor(async () => {
      seen.filled.length = 0
      await pressInPane($, 'git-ship-pr')
      return seen.filled[0]?.text === '!gh pr create --title "" --body ""'
    }, 'the create fill')
  })

  test('a PR answer that lands after a branch switch is dropped', async ($, on) => {
    const seen = engine(on, repo(status({ head: 'feat', upstream: 'origin/feat' })))
    const gate = () => {
      let open = () => {}
      const promise = new Promise<void>(resolve => {
        open = resolve
      })
      return { promise, open }
    }
    const stale = gate()
    const fresh = gate()
    // feat's check answers OPEN, but only after other's check answered CLOSED.
    seen.ghQueue.push({ gate: stale.promise, out: '{"number":4,"state":"OPEN"}' }, { gate: fresh.promise, out: '{"number":5,"state":"CLOSED"}' })
    await started($)
    await ship($)
    await waitFor(() => seen.ran.filter(argv => argv === GH_VIEW).length === 1, 'the first PR check')
    seen.outputs[STATUS] = status({ head: 'other', upstream: 'origin/other' })
    void reply($)
    await waitFor(() => seen.ran.filter(argv => argv === GH_VIEW).length === 2, 'the second PR check')
    fresh.open()
    await new Promise<void>(resolve => setTimeout(() => resolve(), 20))
    stale.open()
    await new Promise<void>(resolve => setTimeout(() => resolve(), 20))
    await pressInPane($, 'git-ship-pr')
    expect(seen.filled).toEqual([{ text: '!gh pr create --title "" --body ""', mode: 'replace' }])
  })

  test('a default-branch probe that timed out is not cached: a later read finds the real one', async ($, on) => {
    const seen = engine(on, repo(status({ head: 'main', upstream: 'origin/main' }), { [ORIGIN_HEAD]: 'origin/trunk\n' }))
    seen.refused.add(ORIGIN_HEAD)
    await started($)
    await openShip($, seen)
    const prDim = async () => {
      const pane = await mountPane($)
      const dim = (await pane.find({ key: 'git-ship-pr' }))?.props.dimColor
      await pane.unmount()
      return dim
    }
    // Fallen back to main: on main, PR is off.
    expect(await prDim()).toBe(true)
    seen.refused.clear()
    await reply($)
    await waitFor(async () => (await prDim()) === false, 'trunk as the default branch')
  })
})

describe('refresh', () => {
  test('turn.complete reads git again', async ($, on) => {
    const seen = engine(on, repo(status({ files: THREE })))
    await started($)
    seen.ran.length = 0
    seen.outputs[STATUS] = status()
    await reply($)
    await waitFor(async () => (await bandText($)) === CLEAN, 'the clean row')
    expect(seen.ran).toContain(STATUS)
  })

  test('a ! prompt refreshes after it is handled, and once more 1.5s later; a plain prompt does not', async ($, on) => {
    const seen = engine(on, repo(status({ files: THREE })))
    await started($)
    seen.ran.length = 0
    await $.prompt.submit({ text: 'hello', origin: { kind: 'composer' }, wait: false })
    await seen.clock.advance(2_000)
    expect(seen.ran).toEqual([])
    // This proves the read comes after next(e) against the mock only, not that a
    // live `!` command reaches prompt.submit or has finished by then.
    seen.outputs[STATUS] = status()
    await $.prompt.submit({ text: '!git status', origin: { kind: 'composer' }, wait: false })
    expect(seen.submitted).toEqual(['hello', '!git status'])
    await waitFor(async () => (await bandText($)) === CLEAN, 'the clean row')
    const reads = seen.ran.filter(argv => argv === STATUS).length
    await seen.clock.advance(1_500)
    await waitFor(() => seen.ran.filter(argv => argv === STATUS).length === reads + 1, 'the backstop read')
  })

  test('refreshes fired at once coalesce: exactly two status runs, ending on the newest state', async ($, on) => {
    const seen = engine(on, repo(status({ files: THREE })))
    await started($)
    seen.ran.length = 0
    let release = () => {}
    seen.hold = new Promise<void>(resolve => {
      release = resolve
    })
    const all = Promise.all([reply($), reply($), reply($)])
    await waitFor(() => seen.ran.includes(STATUS), 'the held status call')
    seen.outputs[STATUS] = status()
    release()
    seen.hold = null
    await all
    await waitFor(() => seen.ran.filter(argv => argv === STATUS).length === 2, 'the queued read')
    await waitFor(async () => (await bandText($)) === CLEAN, 'the clean row')
    await new Promise<void>(resolve => setTimeout(() => resolve(), 30))
    expect(seen.ran.filter(argv => argv === STATUS).length).toBe(2)
  })

  test('a hung git read gives git unavailable once the watchdog fires', async ($, on) => {
    const seen = engine(on, repo(status()))
    await started($)
    seen.hold = new Promise<void>(() => {})
    void reply($).catch(() => undefined)
    await waitFor(() => seen.ran.filter(argv => argv === STATUS).length === 2, 'the hung status call')
    await seen.clock.advance(30_000)
    await waitFor(async () => (await bandText($)) === '◆ Ship  git unavailable', 'the watchdog')
    // The coalescer is free again: the next read runs.
    seen.hold = null
    await reply($)
    await waitFor(async () => (await bandText($)) === CLEAN, 'the next read')
  })
})

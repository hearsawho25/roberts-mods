import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { ModelCompleteResult, On, RenderPropsOf } from 'claude-code'

/** The runtime has it; the tsconfig's es2023 lib does not declare it. */
declare const setTimeout: (fn: () => void, ms: number) => unknown

// The harness below is copied from ship.test.tsx: test files share no module.

const PLUGIN = 'git-ship'
const PANE = 'git-ship'
const ROOT = 'D:\\Projects\\app'
const START = 1_800_000_000_000
const STATUS = 'git -c core.quotePath=false --no-optional-locks status --porcelain=v2 --branch'
const TOPLEVEL = 'git rev-parse --show-toplevel'
const LOG = 'git log -1 --format=%h %s'
const ORIGIN_HEAD = 'git symbolic-ref --short refs/remotes/origin/HEAD'
const DIFF_ARGS = 'git -c core.quotePath=false diff --no-color --no-ext-diff'
const DIFF = DIFF_ARGS
const DIFF_STAT = `${DIFF_ARGS} --stat`
const CACHED = `${DIFF_ARGS} --cached`
const CACHED_STAT = `${DIFF_ARGS} --cached --stat`
const SUBJECTS = 'git log -5 --format=%s'
const PR_LOG = 'git log origin/main..HEAD --format=%s%n%n%b%n---'
const PR_STAT = `${DIFF_ARGS} --stat origin/main...HEAD`
const TRAILER = 'Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>'
const FOOTER = '🤖 Generated with [Claude Code](https://claude.com/claude-code)'
const FAILED = 'Git Ship: the draft failed — fill in the message yourself.'
const UNREAD = 'Git Ship: could not read the diff — fill in the message yourself.'
const NOTHING_STAGED = ' Nothing is staged yet.'
const USAGE = { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 90_000, cache_creation_input_tokens: 0 }

/** `git status --porcelain=v2 --branch` output for a branch and its files. */
function status(o: { head?: string; upstream?: string | null; ab?: string; files?: string[] } = {}): string {
  const lines = ['# branch.oid 1a2b3c4d5e6f', `# branch.head ${o.head ?? 'main'}`]
  const upstream = o.upstream === undefined ? 'origin/main' : o.upstream
  if (upstream !== null) lines.push(`# branch.upstream ${upstream}`, `# branch.ab ${o.ab ?? '+0 -0'}`)
  return `${[...lines, ...(o.files ?? [])].join('\n')}\n`
}

/** One staged file. */
const STAGED = ['1 M. N... 100644 100644 100644 aaa bbb b.ts']
/** One unstaged file and one untracked. */
const UNSTAGED = ['1 .M N... 100644 100644 100644 aaa bbb a.ts', '? c.txt']

/** argv (joined by spaces) → stdout; a command not listed exits 128. */
function repo(statusText: string, extra: Record<string, string> = {}): Record<string, string> {
  return {
    [TOPLEVEL]: 'D:/Projects/app\n',
    [STATUS]: statusText,
    [LOG]: '1a2b3c4 Fix the row\n',
    [ORIGIN_HEAD]: 'origin/main\n',
    [CACHED]: 'diff --git a/b.ts b/b.ts\n+staged line\n',
    [CACHED_STAT]: ' b.ts | 1 +\n',
    [DIFF]: 'diff --git a/a.ts b/a.ts\n+unstaged line\n',
    [DIFF_STAT]: ' a.ts | 1 +\n',
    [SUBJECTS]: 'Fix the row\nAdd the pane\n',
    ...extra,
  }
}

function answer(text: string): ModelCompleteResult {
  return { isAnswered: true, text, usage: USAGE }
}

type Control = {
  outputs: Record<string, string>
  /** Every process.run call, its argv joined. */
  ran: string[]
  /** Every process.run call's cwd. */
  cwds: Array<string | undefined>
  /** Every process.run call's timeout. */
  timeouts: Array<number | undefined>
  /** What the next completion answers; 'throw' refuses the call. */
  reply: ModelCompleteResult | 'throw'
  /** Holds each completion until resolved (to press while drafting). */
  gate: Promise<void> | null
  /** Every completion's request. */
  calls: Array<{ model: string; maxTokens: number | undefined; effort: string | undefined; timeoutMs: number | undefined }>
  /** Every completion's prompt. */
  prompts: string[]
  filled: Array<{ text: string; mode: string | undefined }>
  submitted: string[]
  toasts: string[]
  panes: Set<string>
  /** File texts fs.read answers, by full path; any other path is refused. */
  files: Record<string, string>
  clock: ReturnType<typeof mock.clock>
}

/** Stands in for the engine beneath the mod. */
function engine(on: On, outputs: Record<string, string>): Control {
  const seen: Control = {
    outputs,
    ran: [],
    cwds: [],
    timeouts: [],
    reply: answer('fix: tidy row\n\nShorter label.'),
    gate: null,
    calls: [],
    prompts: [],
    filled: [],
    submitted: [],
    toasts: [],
    panes: new Set(),
    files: {},
    clock: mock.clock(on, { now: START }),
  }
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('session.root', () => ({ value: ROOT }))
  on('process.run', ($, e) => {
    const argv = e.argv.join(' ')
    seen.ran.push(argv)
    seen.cwds.push(e.init?.cwd)
    seen.timeouts.push(e.init?.timeoutMs)
    const out = seen.outputs[argv]
    return {
      value: { exitCode: out === undefined ? 128 : 0, stdout: out ?? '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
    }
  })
  on('fs.read', ($, e) => {
    const text = seen.files[e.path]
    return text === undefined ? { deny: 'ENOENT: no such file' } : { value: text }
  })
  on('model.complete', async ($, e) => {
    seen.calls.push({ model: e.model, maxTokens: e.maxTokens, effort: e.effort, timeoutMs: e.timeoutMs })
    seen.prompts.push(e.prompt)
    if (seen.gate !== null) await seen.gate
    return seen.reply === 'throw' ? { deny: 'the model call broke' } : { value: seen.reply }
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
    seen.panes.add(e.id)
    return { value: { isPlaced: true as const } }
  })
  on('ui.close', ($, e) => {
    seen.panes.delete(e.id)
    return { value: undefined }
  })
  on('ui.panes', () => ({
    value: [...seen.panes].map(id => ({ id, title: 'Git Ship', isShown: true, isFocused: false, isPlaced: true })),
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

async function ship($: Engine) {
  return $.command.run({ command: 'ship', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } })
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

/** The text of the pane line keyed `key`. */
async function paneLine($: Engine, key: string) {
  const pane = await mountPane($)
  const text = (await pane.find({ key }))?.text
  await pane.unmount()
  return text
}

/** Whether the pane's button keyed `key` is drawn dim. */
async function isDim($: Engine, key: string) {
  const pane = await mountPane($)
  const dim = (await pane.find({ key }))?.props.dimColor
  await pane.unmount()
  return dim
}

/** Presses one of the open pane's buttons. */
async function pressInPane($: Engine, key: string) {
  const pane = await mountPane($)
  await pane.press({ key })
  await pane.unmount()
}

/** Session start, `/ship`, then the pane's read landed. */
async function opened($: Engine, seen: Control) {
  await $.session.start({ cwd: '.', surface: 'terminal', isInteractive: true })
  await waitFor(() => seen.ran.includes(STATUS), 'the first read')
  await ship($)
  await waitFor(async () => (await paneLine($, 'git-ship-head')) !== undefined, 'the pane header')
}

/** Presses Draft commit (or PR) and waits for its fill. */
async function draft($: Engine, seen: Control, key = 'git-ship-commit') {
  const before = seen.filled.length
  await pressInPane($, key)
  await waitFor(() => seen.filled.length > before, 'the draft fill')
  return seen.filled[seen.filled.length - 1]
}

describe('draft commit', () => {
  test('staged changes: the reply becomes subject and body, trailer added', async ($, on) => {
    const seen = engine(on, repo(status({ files: STAGED })))
    await opened($, seen)
    expect(await draft($, seen)).toEqual({
      text: `!git commit -m "fix: tidy row" -m "Shorter label.\n\n${TRAILER}"`,
      mode: 'replace',
    })
    expect(seen.prompts.length).toBe(1)
    expect(seen.prompts[0]).toContain('+staged line')
    expect(seen.prompts[0]).toContain(' b.ts | 1 +')
    expect(seen.prompts[0]).toContain('Fix the row\nAdd the pane')
    expect(seen.ran).toContain(CACHED)
    expect(seen.ran).toContain(CACHED_STAT)
    expect(seen.ran).toContain(SUBJECTS)
    // Every drafting git call runs from the repo root with the git timeout.
    seen.ran.forEach((argv, i) => {
      if (argv === CACHED || argv === SUBJECTS) {
        expect(seen.cwds[i]).toBe('D:/Projects/app')
        expect(seen.timeouts[i]).toBe(5_000)
      }
    })
    expect(seen.toasts).toEqual([])
  })

  test('a session with no prior turn drafts: one standalone sonnet completion, no fork', async ($, on) => {
    const seen = engine(on, repo(status({ files: STAGED })))
    const forks: string[] = []
    // A fork here would answer nothing-to-fork: no turn has completed yet.
    on('model.fork', ($, e) => {
      forks.push(e.prompt)
      return { value: { isAnswered: false as const, reason: 'nothing-to-fork' as const } }
    })
    await opened($, seen)
    expect((await draft($, seen))?.text).toBe(`!git commit -m "fix: tidy row" -m "Shorter label.\n\n${TRAILER}"`)
    expect(seen.calls).toEqual([{ model: 'sonnet', maxTokens: 1024, effort: 'low', timeoutMs: 60_000 }])
    expect(forks).toEqual([])
  })

  test('nothing staged: git add -A first, the diff is the unstaged one, untracked names listed', async ($, on) => {
    const seen = engine(on, repo(status({ files: UNSTAGED })))
    await opened($, seen)
    const filled = await draft($, seen)
    expect(filled?.text.startsWith('!git add -A && git commit')).toBe(true)
    expect(seen.ran).toContain(DIFF)
    expect(seen.ran).toContain(DIFF_STAT)
    expect(seen.ran).not.toContain(CACHED)
    expect(seen.prompts[0]).toContain('+unstaged line')
    expect(seen.prompts[0]).not.toContain('+staged line')
    expect(seen.prompts[0]).toContain('Untracked files: c.txt')
  })

  test('a new folder: the draft lists every file inside it and reads their text', async ($, on) => {
    const LS = 'git -c core.quotePath=false ls-files --others --exclude-standard'
    const seen = engine(on, repo(status({ files: ['? git-ship/'] }), { [DIFF]: '', [DIFF_STAT]: '', [LS]: 'git-ship/a.ts\ngit-ship/README.md\n' }))
    seen.files[`${ROOT}\\git-ship\\a.ts`] = 'export const shipped = true\n'
    await opened($, seen)
    const filled = await draft($, seen)
    expect(filled?.text.startsWith('!git add -A && git commit -m "fix: tidy row"')).toBe(true)
    expect(seen.prompts[0]).toContain('Untracked files: git-ship/a.ts, git-ship/README.md')
    expect(seen.prompts[0]).toContain('New file: git-ship/a.ts\nexport const shipped = true')
    expect(seen.prompts[0]).toContain('New file: git-ship/README.md (not shown)')
  })

  test('nothing staged and the draft fails: plain git commit, never git add -A, and the toast says so', async ($, on) => {
    const seen = engine(on, repo(status({ files: UNSTAGED })))
    seen.reply = 'throw'
    await opened($, seen)
    expect((await draft($, seen))?.text).toBe('!git commit -m ""')
    expect(seen.toasts).toEqual([FAILED + NOTHING_STAGED])
  })

  test('more than 20 untracked files: 20 names, then +N more', async ($, on) => {
    const untracked = Array.from({ length: 22 }, (_, i) => `? u${i}.txt`)
    const seen = engine(on, repo(status({ files: untracked }), { [DIFF]: '', [DIFF_STAT]: '' }))
    await opened($, seen)
    await draft($, seen)
    const names = Array.from({ length: 20 }, (_, i) => `u${i}.txt`).join(', ')
    expect(seen.prompts[0]).toContain(`Untracked files: ${names}, +2 more`)
  })

  test('a diff that cannot be read never drafts from nothing', async ($, on) => {
    const outputs = repo(status({ files: STAGED }))
    delete outputs[CACHED]
    const seen = engine(on, outputs)
    await opened($, seen)
    expect((await draft($, seen))?.text).toBe('!git commit -m ""')
    expect(seen.toasts).toEqual([UNREAD])
    expect(seen.calls).toEqual([])
  })

  test('an empty diff, stat and untracked list never drafts from nothing', async ($, on) => {
    const seen = engine(on, repo(status({ files: ['1 .M N... 100644 100644 100644 aaa bbb a.ts'] }), { [DIFF]: '', [DIFF_STAT]: '\n' }))
    await opened($, seen)
    expect((await draft($, seen))?.text).toBe('!git commit -m ""')
    expect(seen.toasts).toEqual([UNREAD + NOTHING_STAGED])
    expect(seen.calls).toEqual([])
  })

  test('a subject starting with --amend stays inside the quotes after -m', async ($, on) => {
    const seen = engine(on, repo(status({ files: STAGED })))
    seen.reply = answer('--amend everything\n\nBody.')
    await opened($, seen)
    expect((await draft($, seen))?.text).toBe(`!git commit -m "--amend everything" -m "Body.\n\n${TRAILER}"`)
  })

  test('a new session start clears a drafting flag left by a reload mid-draft', async ($, on) => {
    const seen = engine(on, repo(status({ files: STAGED })))
    let release = () => {}
    seen.gate = new Promise<void>(resolve => {
      release = resolve
    })
    await opened($, seen)
    const pane = await mountPane($)
    const first = pane.press({ key: 'git-ship-commit' })
    await waitFor(async () => (await pane.find({ key: 'git-ship-commit' }))?.props.dimColor === true, 'the dim draft button')
    await $.session.start({ cwd: '.', surface: 'terminal', isInteractive: true })
    await waitFor(async () => (await pane.find({ key: 'git-ship-commit' }))?.props.dimColor === false, 'the draft button back')
    expect(await pane.find({ key: 'git-ship-drafting' })).toBeUndefined()
    release()
    await first
    await pane.unmount()
  })

  test('a $ and a quote in the subject are escaped in the fill', async ($, on) => {
    const seen = engine(on, repo(status({ files: STAGED })))
    seen.reply = answer('fix: pay $5 "now"\n\nBody.')
    await opened($, seen)
    expect((await draft($, seen))?.text).toBe(`!git commit -m "fix: pay \\$5 \\"now\\"" -m "Body.\n\n${TRAILER}"`)
  })

  test('a draft not answered fills empty quotes and toasts', async ($, on) => {
    const seen = engine(on, repo(status({ files: STAGED })))
    seen.reply = { isAnswered: false, reason: 'api-error', status: 529, error: 'overloaded', usage: USAGE }
    await opened($, seen)
    expect((await draft($, seen))?.text).toBe('!git commit -m ""')
    expect(seen.toasts).toEqual([FAILED])
  })

  test('a second press while drafting does nothing; the pane shows drafting… meanwhile', async ($, on) => {
    const seen = engine(on, repo(status({ files: STAGED })))
    let release = () => {}
    seen.gate = new Promise<void>(resolve => {
      release = resolve
    })
    await opened($, seen)
    // One mount throughout: a press resolves once its handler has, and this one is held on the model call.
    const pane = await mountPane($)
    const first = pane.press({ key: 'git-ship-commit' })
    await waitFor(() => seen.prompts.length === 1, 'the model call')
    await waitFor(async () => (await pane.find({ key: 'git-ship-drafting' }))?.text === 'drafting…', 'the drafting line')
    expect((await pane.find({ key: 'git-ship-commit' }))?.props.dimColor).toBe(true)
    await pane.press({ key: 'git-ship-commit' })
    release()
    await first
    await waitFor(() => seen.filled.length === 1, 'the draft fill')
    await new Promise<void>(resolve => setTimeout(() => resolve(), 20))
    expect(seen.prompts.length).toBe(1)
    expect(seen.filled.length).toBe(1)
    await waitFor(async () => (await pane.find({ key: 'git-ship-drafting' })) === undefined, 'the drafting line gone')
    await pane.unmount()
  })

  test('a model call that throws fills empty quotes, toasts, and drafting resets', async ($, on) => {
    const seen = engine(on, repo(status({ files: STAGED })))
    seen.reply = 'throw'
    await opened($, seen)
    expect((await draft($, seen))?.text).toBe('!git commit -m ""')
    expect(seen.toasts).toEqual([FAILED])
    expect(await paneLine($, 'git-ship-drafting')).toBeUndefined()
    expect(await isDim($, 'git-ship-commit')).toBe(false)
    seen.reply = answer('fix: again\n\nBody.')
    expect((await draft($, seen))?.text).toBe(`!git commit -m "fix: again" -m "Body.\n\n${TRAILER}"`)
    expect(seen.prompts.length).toBe(2)
  })

  test('an empty subject counts as a failed draft', async ($, on) => {
    const seen = engine(on, repo(status({ files: STAGED })))
    seen.reply = answer('   \n')
    await opened($, seen)
    expect((await draft($, seen))?.text).toBe('!git commit -m ""')
    expect(seen.toasts).toEqual([FAILED])
  })
})

describe('draft PR', () => {
  test('the reply becomes title and body, footer added', async ($, on) => {
    const seen = engine(
      on,
      repo(status({ head: 'feat', upstream: 'origin/feat' }), {
        [PR_LOG]: 'Add the row\n\nThe row.\n---\n',
        [PR_STAT]: ' hooks/register.tsx | 10 +\n',
      }),
    )
    seen.reply = answer('Add ship pane\n\n- row\n- pane')
    await opened($, seen)
    expect(await draft($, seen, 'git-ship-pr')).toEqual({
      text: `!gh pr create --title "Add ship pane" --body "- row\n- pane\n\n${FOOTER}"`,
      mode: 'replace',
    })
    expect(seen.prompts[0]).toContain('Add the row\n\nThe row.\n---')
    expect(seen.prompts[0]).toContain(' hooks/register.tsx | 10 +')
    expect(seen.prompts[0]).toContain('branch feat')
  })

  test('a PR draft not answered fills empty title and body and toasts', async ($, on) => {
    const seen = engine(on, repo(status({ head: 'feat', upstream: 'origin/feat' }), { [PR_LOG]: 'Add the row\n---\n' }))
    seen.reply = { isAnswered: false, reason: 'empty-reply', usage: USAGE }
    await opened($, seen)
    expect((await draft($, seen, 'git-ship-pr'))?.text).toBe('!gh pr create --title "" --body ""')
    expect(seen.toasts).toEqual([FAILED])
  })

  test('no commits since the base (or a log that fails): empty title and body, never drafted', async ($, on) => {
    const seen = engine(on, repo(status({ head: 'feat', upstream: 'origin/feat' }), { [PR_LOG]: '\n' }))
    await opened($, seen)
    expect((await draft($, seen, 'git-ship-pr'))?.text).toBe('!gh pr create --title "" --body ""')
    delete seen.outputs[PR_LOG]
    expect((await draft($, seen, 'git-ship-pr'))?.text).toBe('!gh pr create --title "" --body ""')
    expect(seen.toasts).toEqual(['Git Ship: no commits since origin/main to draft from.', 'Git Ship: no commits since origin/main to draft from.'])
    expect(seen.calls).toEqual([])
  })

  test('without origin/HEAD the PR is drafted against the local base branch', async ($, on) => {
    const outputs = repo(status({ head: 'feat', upstream: 'origin/feat' }), {
      'git rev-parse --verify --quiet refs/heads/main': '',
      'git log main..HEAD --format=%s%n%n%b%n---': 'Local commit\n---\n',
      [`${DIFF_ARGS} --stat main...HEAD`]: ' a.ts | 1 +\n',
    })
    delete outputs[ORIGIN_HEAD]
    const seen = engine(on, outputs)
    seen.reply = answer('Add ship pane\n\nBody.')
    await opened($, seen)
    expect((await draft($, seen, 'git-ship-pr'))?.text).toBe(`!gh pr create --title "Add ship pane" --body "Body.\n\n${FOOTER}"`)
    expect(seen.ran).not.toContain(PR_LOG)
    expect(seen.prompts[0]).toContain('Local commit')
    expect(seen.prompts[0]).toContain(' a.ts | 1 +')
  })

  test('with origin/HEAD the PR is drafted against origin/<base>', async ($, on) => {
    const seen = engine(on, repo(status({ head: 'feat', upstream: 'origin/feat' }), { [PR_LOG]: 'Remote base\n---\n' }))
    await opened($, seen)
    await draft($, seen, 'git-ship-pr')
    expect(seen.ran).toContain(PR_LOG)
    expect(seen.ran).toContain(PR_STAT)
    expect(seen.ran.some(argv => argv.startsWith('git log main..'))).toBe(false)
    expect(seen.prompts[0]).toContain('Remote base')
  })
})

describe('fill only', () => {
  test('drafting never submits the prompt', async ($, on) => {
    const seen = engine(on, repo(status({ head: 'feat', upstream: 'origin/feat', files: STAGED })))
    await opened($, seen)
    await draft($, seen)
    expect(seen.submitted).toEqual([])
    await draft($, seen, 'git-ship-pr')
    expect(seen.submitted).toEqual([])
    seen.reply = 'throw'
    await draft($, seen)
    expect(seen.submitted).toEqual([])
    expect(seen.filled.every(f => f.mode === 'replace')).toBe(true)
  })
})

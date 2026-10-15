import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On, PromptOrigin, RenderPropsOf } from 'claude-code'

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
const EXEC_PATH = 'git --exec-path'
const BASH = 'D:/Program Files/Git/bin/bash.exe'
/** The fixed script every run gets: the line itself travels in the environment, never in argv. */
const EVAL = 'eval "$GIT_SHIP_COMMAND"'
const SHELL_ENV = { GIT_TERMINAL_PROMPT: '0', GH_PROMPT_DISABLED: '1', GIT_EDITOR: 'false', GIT_SEQUENCE_EDITOR: 'false' }
const NO_GIT_BASH = 'Git Ship: could not find Git Bash — run it yourself.'

/** `git status --porcelain=v2 --branch` output for a branch and its files. */
function status(o: { head?: string; upstream?: string | null; ab?: string; files?: string[] } = {}): string {
  const lines = ['# branch.oid 1a2b3c4d5e6f', `# branch.head ${o.head ?? 'main'}`]
  const upstream = o.upstream === undefined ? 'origin/main' : o.upstream
  if (upstream !== null) lines.push(`# branch.upstream ${upstream}`, `# branch.ab ${o.ab ?? '+0 -0'}`)
  return `${[...lines, ...(o.files ?? [])].join('\n')}\n`
}

/** argv (joined by spaces) → stdout; a command not listed exits 128. */
function repo(statusText: string, extra: Record<string, string> = {}): Record<string, string> {
  return {
    [TOPLEVEL]: 'D:/Projects/app\n',
    [STATUS]: statusText,
    [LOG]: '1a2b3c4 Fix the row\n',
    [ORIGIN_HEAD]: 'origin/main\n',
    [EXEC_PATH]: 'D:/Program Files/Git/mingw64/libexec/git-core\n',
    ...extra,
  }
}

type ShellRun = { argv: readonly string[]; cwd: string | undefined; env: Record<string, string> | undefined; timeoutMs: number | undefined }

type Control = {
  outputs: Record<string, string>
  /** Every process.run call, its argv joined. */
  ran: string[]
  /** Every run of a shell (argv[0] is not git or gh). */
  shells: ShellRun[]
  /** What the next shell run gives back; 'throw' refuses it at once (it could not start), 'timeout' after the 300 s limit. */
  shell: { exitCode: number; stdout: string; stderr: string; isStdoutTruncated?: boolean } | 'throw' | 'timeout'
  /** env.get is refused (the engine failed mid-hook). */
  isEnvRefused: boolean
  /** Every Git Bash check (`<bash> -c 'exit 0'`), by path. */
  probes: string[]
  /** The check's exit code; 'throw' when bash will not start. */
  probe: number | 'throw'
  /** Holds each status read until resolved. */
  hold: Promise<void> | null
  /** Holds each shell run until resolved. */
  gate: Promise<void> | null
  env: Record<string, string>
  /** Prompts that reached the engine below the mod. */
  submitted: string[]
  filled: string[]
  /** What the prompt box holds, as prompt.read answers it. */
  box: string
  toasts: string[]
  opened: string[]
  panes: Set<string>
  clock: ReturnType<typeof mock.clock>
}

/** Stands in for the engine beneath the mod. */
function engine(on: On, outputs: Record<string, string>): Control {
  const seen: Control = {
    outputs,
    ran: [],
    shells: [],
    shell: { exitCode: 0, stdout: 'Everything up-to-date\n', stderr: '' },
    gate: null,
    isEnvRefused: false,
    probes: [],
    probe: 0,
    hold: null,
    env: { OS: 'Windows_NT' },
    submitted: [],
    filled: [],
    box: '',
    toasts: [],
    opened: [],
    panes: new Set(),
    clock: mock.clock(on, { now: START }),
  }
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('session.root', () => ({ value: ROOT }))
  on('env.get', ($, e) => (seen.isEnvRefused ? { deny: 'env unavailable' } : { value: seen.env[e.name] }))
  on('process.run', async ($, e) => {
    const argv = e.argv.join(' ')
    seen.ran.push(argv)
    // Git Ship checking a Git Bash path once before its first use.
    if (e.argv[0] !== 'git' && e.argv[0] !== 'gh' && e.argv[2] === 'exit 0') {
      seen.probes.push(e.argv[0] ?? '')
      if (seen.probe === 'throw') return { deny: 'spawn ENOENT' }
      return { value: { exitCode: seen.probe, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    }
    // A shell run: anything but git or gh itself (git's own `-c` is a config flag).
    if (e.argv[0] !== 'git' && e.argv[0] !== 'gh') {
      seen.shells.push({ argv: e.argv, cwd: e.init?.cwd, env: e.init?.env, timeoutMs: e.init?.timeoutMs })
      if (seen.gate !== null) await seen.gate
      if (seen.shell === 'throw') return { deny: 'spawn ENOENT' }
      if (seen.shell === 'timeout') {
        await seen.clock.advance(300_000)
        return { deny: 'timed out' }
      }
      return { value: { isStdoutTruncated: false, isStderrTruncated: false, ...seen.shell } }
    }
    if (argv === STATUS && seen.hold !== null) await seen.hold
    const out = seen.outputs[argv]
    return {
      value: { exitCode: out === undefined ? 128 : 0, stdout: out ?? '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
    }
  })
  on('prompt.fill', ($, e) => {
    seen.filled.push(e.text)
    seen.box = e.text
    return { isFilled: true }
  })
  on('prompt.read', () => ({ value: { text: seen.box, cursor: seen.box.length } }))
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

async function settle(ms = 20) {
  await new Promise<void>(resolve => setTimeout(() => resolve(), ms))
}

/** Session start, then the first read landed on the row. */
async function started($: Engine, seen: Control) {
  await $.session.start({ cwd: '.', surface: 'terminal', isInteractive: true })
  await waitFor(() => seen.ran.includes(STATUS), 'the first read')
  await waitFor(async () => (await rowText($)) !== undefined, 'the row')
}

async function submit($: Engine, text: string, origin: PromptOrigin = { kind: 'composer' }) {
  return $.prompt.submit({ text, origin, wait: false })
}

async function rowText($: Engine) {
  const props: RenderPropsOf['AbovePrompt'] = { hasSurvey: false, isWorking: false, maxRows: 20, bodyColumns: 140, scroll: { offset: 0, bodyRows: 20 }, view: {} }
  const drawn = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'AbovePrompt', props, viewport: { columns: 140, rows: 40, isFullscreen: true } })
  const text = (await drawn.find({ key: 'git-ship-text' }))?.text
  await drawn.unmount()
  return text
}

async function paneLine($: Engine, key: string) {
  const props: RenderPropsOf['Pane'] = { title: 'Git Ship', isFocused: true, bodyColumns: 100, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} }
  const pane = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'Pane', requestId: PANE, props, viewport: { columns: 160, rows: 50, isFullscreen: true } })
  const text = (await pane.find({ key }))?.text
  await pane.unmount()
  return text
}

describe('intercepting a filled command', () => {
  test('!git push is dropped, never reaches the engine, and runs in Git Bash from the repo root', async ($, on) => {
    const seen = engine(on, repo(status({ ab: '+1 -0' })))
    await started($, seen)
    const result = await submit($, '!git push')
    expect(result).toEqual({ drop: 'Git Ship ran: git push' })
    expect(seen.submitted).toEqual([])
    await waitFor(() => seen.shells.length === 1, 'the run')
    expect(seen.shells[0]).toEqual({
      argv: [BASH, '-c', EVAL],
      cwd: 'D:/Projects/app',
      env: { ...SHELL_ENV, GIT_SHIP_COMMAND: 'git push' },
      timeoutMs: 300_000,
    })
  })

  test('a line that ran is cleared from the box the engine handed it back to', async ($, on) => {
    const seen = engine(on, repo(status({ ab: '+1 -0' })))
    await started($, seen)
    seen.box = '!git push'
    await submit($, '!git push')
    await seen.clock.advance(1_000)
    await waitFor(() => seen.box === '', 'the box cleared')
    expect(seen.filled).toContain('')
  })

  test('a box Robert has typed something new into is left alone', async ($, on) => {
    const seen = engine(on, repo(status({ ab: '+1 -0' })))
    await started($, seen)
    seen.box = 'a new prompt'
    await submit($, '!git push')
    await seen.clock.advance(1_000)
    await waitFor(() => seen.shells.length === 1, 'the run')
    expect(seen.box).toBe('a new prompt')
    expect(seen.filled).not.toContain('')
  })

  test('an edited commit line runs verbatim', async ($, on) => {
    const seen = engine(on, repo(status()))
    await started($, seen)
    const line = '!git add -A && git commit -m "fix: my own words" -m "Body\nline two"'
    await submit($, line)
    await waitFor(() => seen.shells.length === 1, 'the run')
    expect(seen.shells[0]?.argv).toEqual([BASH, '-c', EVAL])
    expect(seen.shells[0]?.env?.['GIT_SHIP_COMMAND']).toBe(line.slice(1))
    expect(seen.submitted).toEqual([])
  })

  test('the line never enters argv: backslashes and $(…) reach bash only through the environment, exactly', async ($, on) => {
    const seen = engine(on, repo(status()))
    await started($, seen)
    const command = 'git commit -m "x\\$(echo INJECTED) C:\\\\path \\`id\\` $HOME"'
    await submit($, `!${command}`)
    await waitFor(() => seen.shells.length === 1, 'the run')
    expect(seen.shells[0]?.argv).toEqual([BASH, '-c', EVAL])
    expect(seen.shells[0]?.argv.some(arg => arg.includes('INJECTED'))).toBe(false)
    expect(seen.shells[0]?.env).toEqual({ ...SHELL_ENV, GIT_SHIP_COMMAND: command })
  })

  test('leading whitespace before !git is still intercepted', async ($, on) => {
    const seen = engine(on, repo(status()))
    await started($, seen)
    expect(await submit($, '   !git pull')).toEqual({ drop: 'Git Ship ran: git pull' })
    await waitFor(() => seen.shells.length === 1, 'the run')
    expect(seen.shells[0]?.env?.['GIT_SHIP_COMMAND']).toBe('git pull')
  })

  test('a prompt with !git mid-text, !gitk and a bare !git are not intercepted', async ($, on) => {
    const seen = engine(on, repo(status()))
    await started($, seen)
    for (const text of ['please run !git push for me', '!gitk', '!git']) await submit($, text)
    expect(seen.submitted).toEqual(['please run !git push for me', '!gitk', '!git'])
    await settle()
    expect(seen.shells).toEqual([])
  })

  test('!ls is not intercepted: it reaches the engine and nothing runs', async ($, on) => {
    const seen = engine(on, repo(status()))
    await started($, seen)
    const result = await submit($, '!ls')
    expect(result).toEqual({ text: '!ls' })
    expect(seen.submitted).toEqual(['!ls'])
    await settle()
    expect(seen.shells).toEqual([])
  })

  test('outside a repo nothing is intercepted', async ($, on) => {
    const seen = engine(on, { [EXEC_PATH]: 'D:/Program Files/Git/mingw64/libexec/git-core\n' })
    await $.session.start({ cwd: '.', surface: 'terminal', isInteractive: true })
    await waitFor(() => seen.ran.includes(TOPLEVEL), 'rev-parse')
    await settle()
    await submit($, '!git push')
    expect(seen.submitted).toEqual(['!git push'])
    await settle()
    expect(seen.shells).toEqual([])
  })

  test('a line that did not come from the composer is not intercepted', async ($, on) => {
    const seen = engine(on, repo(status()))
    await started($, seen)
    await submit($, '!git push', { kind: 'peer' } as PromptOrigin)
    await submit($, '!git pull', { kind: 'bridge' } as PromptOrigin)
    expect(seen.submitted).toEqual(['!git push', '!git pull'])
    await settle()
    expect(seen.shells).toEqual([])
  })

  test('without Git Bash the line is dropped with a message and nothing runs', async ($, on) => {
    const outputs = repo(status())
    delete outputs[EXEC_PATH]
    const seen = engine(on, outputs)
    await started($, seen)
    expect(await submit($, '!git push --force-with-lease')).toEqual({ drop: NO_GIT_BASH })
    expect(seen.submitted).toEqual([])
    // Robert's line goes back in the box.
    expect(seen.filled).toEqual(['!git push --force-with-lease'])
    await settle()
    expect(seen.shells).toEqual([])
  })

  test('a WSL bash is never Git Bash: System32 from the env var counts as not found', async ($, on) => {
    const seen = engine(on, repo(status()))
    seen.env['CLAUDE_CODE_GIT_BASH_PATH'] = 'C:\\Windows\\System32\\bash.exe'
    await started($, seen)
    expect(await submit($, '!git push')).toEqual({ drop: NO_GIT_BASH })
    await settle()
    expect(seen.shells).toEqual([])
  })

  test('a drive-letter repo root counts as Windows even without OS set', async ($, on) => {
    const seen = engine(on, repo(status()))
    seen.env = {}
    await started($, seen)
    await submit($, '!git pull')
    await waitFor(() => seen.shells.length === 1, 'the run')
    expect(seen.shells[0]?.argv[0]).toBe(BASH)
  })

  test('Git Bash that fails to start: the no-Git-Bash toast, the line back in the box, and a fresh search next time', async ($, on) => {
    const seen = engine(on, repo(status()))
    seen.shell = 'throw'
    await started($, seen)
    await submit($, '!git push')
    await waitFor(() => seen.toasts.includes(NO_GIT_BASH), 'the toast')
    await waitFor(() => seen.filled.includes('!git push'), 'the line back')
    expect(seen.toasts.some(text => text.includes('did not finish'))).toBe(false)
    seen.shell = { exitCode: 0, stdout: '', stderr: '' }
    await submit($, '!git push')
    await waitFor(() => seen.toasts.includes('Git Ship: git push done'), 'the second run')
    expect(seen.ran.filter(argv => argv === EXEC_PATH).length).toBe(2)
  })

  test('an engine failure mid-hook drops the line instead of handing it to Claude', async ($, on) => {
    const seen = engine(on, repo(status()))
    await started($, seen)
    seen.isEnvRefused = true
    expect(await submit($, '!git push')).toEqual({ drop: 'Git Ship could not run it — nothing was sent' })
    expect(seen.submitted).toEqual([])
    expect(seen.filled).toEqual(['!git push'])
    await settle()
    expect(seen.shells).toEqual([])
  })

  test('git that cannot be read here: read again, then drop rather than send', async ($, on) => {
    const outputs = repo(status())
    delete outputs[STATUS]
    const seen = engine(on, outputs)
    await started($, seen)
    const reads = seen.ran.filter(argv => argv === STATUS).length
    expect(await submit($, '!git push')).toEqual({ drop: 'Git Ship: could not read git here — nothing was sent' })
    expect(seen.ran.filter(argv => argv === STATUS).length).toBeGreaterThan(reads)
    expect(seen.submitted).toEqual([])
    expect(seen.filled).toEqual(['!git push'])
    expect(seen.shells).toEqual([])
  })

  test('a repo not read yet is read before deciding', async ($, on) => {
    const seen = engine(on, repo(status()))
    // No session start: nothing has been read.
    expect(await submit($, '!git push')).toEqual({ drop: 'Git Ship ran: git push' })
    await waitFor(() => seen.shells.length === 1, 'the run')
    expect(seen.submitted).toEqual([])
  })

  test('a read that outlasts the wait: dropped once, restored once, and the late read never runs the line', async ($, on) => {
    const seen = engine(on, repo(status()))
    let release = () => {}
    seen.hold = new Promise<void>(resolve => {
      release = resolve
    })
    // No session start: the line has to wait for the first read.
    const pending = submit($, '!git push')
    await waitFor(() => seen.ran.includes(STATUS), 'the held read')
    await seen.clock.advance(6_000)
    expect(await pending).toEqual({ drop: 'Git Ship: could not read git here — nothing was sent' })
    release()
    seen.hold = null
    await waitFor(async () => (await rowText($)) !== undefined, 'the late read')
    await settle(50)
    expect(seen.shells).toEqual([])
    expect(seen.filled).toEqual(['!git push'])
    expect(seen.submitted).toEqual([])
  })

  test('Git Bash is checked once before its first use; a check that fails counts as not found', async ($, on) => {
    const seen = engine(on, repo(status()))
    await started($, seen)
    await submit($, '!git pull')
    await waitFor(() => seen.toasts.includes('Git Ship: git pull done'), 'the first run')
    await submit($, '!git pull')
    await waitFor(() => seen.toasts.filter(t => t === 'Git Ship: git pull done').length === 2, 'the second run')
    expect(seen.probes).toEqual([BASH])
  })

  test('a Git Bash that fails its check is not found and nothing runs', async ($, on) => {
    const seen = engine(on, repo(status()))
    seen.probe = 'throw'
    await started($, seen)
    expect(await submit($, '!git push')).toEqual({ drop: NO_GIT_BASH })
    seen.probe = 1
    expect(await submit($, '!git push')).toEqual({ drop: NO_GIT_BASH })
    await settle()
    expect(seen.shells).toEqual([])
    expect(seen.probes.length).toBe(2)
  })

  test('on Windows a CLAUDE_CODE_GIT_BASH_PATH that is not absolute is not found; a UNC path is', async ($, on) => {
    const seen = engine(on, repo(status()))
    seen.env['CLAUDE_CODE_GIT_BASH_PATH'] = 'bash.exe'
    await started($, seen)
    expect(await submit($, '!git push')).toEqual({ drop: NO_GIT_BASH })
    seen.env['CLAUDE_CODE_GIT_BASH_PATH'] = '\\\\server\\git\\bin\\bash.exe'
    await submit($, '!git push')
    await waitFor(() => seen.shells.length === 1, 'the run')
    expect(seen.shells[0]?.argv[0]).toBe('\\\\server\\git\\bin\\bash.exe')
  })

  test('CLAUDE_CODE_GIT_BASH_PATH wins over git --exec-path', async ($, on) => {
    const seen = engine(on, repo(status()))
    seen.env['CLAUDE_CODE_GIT_BASH_PATH'] = 'E:\\Tools\\Git\\bin\\bash.exe'
    await started($, seen)
    await submit($, '!git pull')
    await waitFor(() => seen.shells.length === 1, 'the run')
    expect(seen.shells[0]?.argv[0]).toBe('E:\\Tools\\Git\\bin\\bash.exe')
    expect(seen.ran).not.toContain(EXEC_PATH)
  })

  test('off Windows it is plain bash', async ($, on) => {
    const seen = engine(on, repo(status(), { [TOPLEVEL]: '/home/r/app\n' }))
    seen.env = {}
    await started($, seen)
    await submit($, '!git pull')
    await waitFor(() => seen.shells.length === 1, 'the run')
    expect(seen.shells[0]?.argv[0]).toBe('bash')
  })
})

describe('after the run', () => {
  test('exit 0: the done toast, and the pane shows the command, output and exit', async ($, on) => {
    const seen = engine(on, repo(status({ ab: '+1 -0' })))
    seen.shell = { exitCode: 0, stdout: 'pushed\n', stderr: 'To origin\n   abc..def  main -> main\n' }
    await started($, seen)
    await submit($, '!git push')
    await waitFor(() => seen.toasts.includes('Git Ship: git push done'), 'the done toast')
    expect(seen.opened).toEqual([])
    expect(await paneLine($, 'git-ship-run-command')).toBe('$ git push')
    expect(await paneLine($, 'git-ship-run-output')).toBe('pushed\nTo origin\n   abc..def  main -> main')
    expect(await paneLine($, 'git-ship-run-status')).toBe('✓ exit 0')
  })

  test('exit 1: the failed toast, and the pane opens', async ($, on) => {
    const seen = engine(on, repo(status()))
    seen.shell = { exitCode: 1, stdout: '', stderr: 'rejected\n' }
    await started($, seen)
    await submit($, '!git push')
    await waitFor(() => seen.toasts.includes('Git Ship: git push failed (exit 1) — see the pane'), 'the failed toast')
    await waitFor(() => seen.opened.includes(PANE), 'the pane open')
    expect(await paneLine($, 'git-ship-run-status')).toBe('✗ exit 1')
    expect(await paneLine($, 'git-ship-run-output')).toBe('rejected')
  })

  test('a run that times out did not finish (it may still be running), the pane opens, and git is read again 30 s on', async ($, on) => {
    const seen = engine(on, repo(status()))
    seen.shell = 'timeout'
    await started($, seen)
    await submit($, '!git push')
    await waitFor(() => seen.toasts.includes('Git Ship: git push did not finish — it may still be running'), 'the toast')
    await waitFor(() => seen.opened.includes(PANE), 'the pane open')
    expect(await paneLine($, 'git-ship-run-status')).toBe('✗ did not finish — it may still be running')
    await settle()
    const reads = seen.ran.filter(argv => argv === STATUS).length
    await seen.clock.advance(30_000)
    await waitFor(() => seen.ran.filter(argv => argv === STATUS).length > reads, 'the 30 s read')
  })

  test('a run that never returns frees the slot once the watchdog fires', async ($, on) => {
    const seen = engine(on, repo(status()))
    seen.gate = new Promise<void>(() => {})
    await started($, seen)
    await submit($, '!git push')
    await waitFor(() => seen.shells.length === 1, 'the hung run')
    expect(await submit($, '!git pull')).toEqual({ drop: 'Git Ship is still running git push' })
    await seen.clock.advance(310_000)
    await waitFor(async () => (await rowText($))?.includes('running') === false, 'the row freed')
    seen.gate = null
    expect(await submit($, '!git pull')).toEqual({ drop: 'Git Ship ran: git pull' })
  })

  test('a run freed by the watchdog that ends late never clears the run after it', async ($, on) => {
    const seen = engine(on, repo(status()))
    let releaseFirst = () => {}
    seen.gate = new Promise<void>(resolve => {
      releaseFirst = resolve
    })
    await started($, seen)
    await submit($, '!git push')
    await waitFor(() => seen.shells.length === 1, 'the first run')
    await seen.clock.advance(310_000)
    await waitFor(async () => (await rowText($))?.includes('running') === false, 'the slot freed')
    // The same command again: only its token tells the two runs apart.
    seen.gate = new Promise<void>(() => {})
    expect(await submit($, '!git push')).toEqual({ drop: 'Git Ship ran: git push' })
    await waitFor(() => seen.shells.length === 2, 'the second run')
    releaseFirst()
    await waitFor(() => seen.toasts.includes('Git Ship: git push done'), 'the first run ending')
    await settle()
    expect(await rowText($)).toContain('running git push…')
    expect(await submit($, '!git pull')).toEqual({ drop: 'Git Ship is still running git push' })
  })

  test('a session start does not clear a run this load still has going', async ($, on) => {
    const seen = engine(on, repo(status()))
    let release = () => {}
    seen.gate = new Promise<void>(resolve => {
      release = resolve
    })
    await started($, seen)
    await submit($, '!git push')
    await waitFor(() => seen.shells.length === 1, 'the run')
    await $.session.start({ cwd: '.', surface: 'terminal', isInteractive: true })
    expect(await submit($, '!git pull')).toEqual({ drop: 'Git Ship is still running git push' })
    release()
    await waitFor(() => seen.toasts.includes('Git Ship: git push done'), 'the run ending')
    await waitFor(async () => (await rowText($))?.includes('running') === false, 'the slot freed')
  })

  test('output past the engine cap is marked truncated in the pane', async ($, on) => {
    const seen = engine(on, repo(status()))
    seen.shell = { exitCode: 0, stdout: 'lots\n', stderr: '', isStdoutTruncated: true }
    await started($, seen)
    await submit($, '!git log')
    await waitFor(() => seen.toasts.includes('Git Ship: git log done'), 'the done toast')
    expect(await paneLine($, 'git-ship-run-output')).toBe('lots\n… (output truncated)')
  })

  test('a second line while one runs is dropped; the row shows the running command', async ($, on) => {
    const seen = engine(on, repo(status()))
    let release = () => {}
    seen.gate = new Promise<void>(resolve => {
      release = resolve
    })
    await started($, seen)
    await submit($, '!git push')
    await waitFor(() => seen.shells.length === 1, 'the first run')
    await waitFor(async () => (await rowText($))?.endsWith('running git push…') === true, 'the running row')
    expect(await submit($, '!git pull')).toEqual({ drop: 'Git Ship is still running git push' })
    expect(seen.filled).toEqual(['!git pull'])
    release()
    await waitFor(() => seen.toasts.includes('Git Ship: git push done'), 'the done toast')
    await settle()
    expect(seen.shells.length).toBe(1)
    expect(seen.submitted).toEqual([])
    await waitFor(async () => (await rowText($))?.includes('running') === false, 'the row back')
  })

  test('a refresh follows the run, and no 1.5 s backstop read for an intercepted line', async ($, on) => {
    const seen = engine(on, repo(status({ ab: '+1 -0' })))
    await started($, seen)
    seen.outputs[STATUS] = status()
    seen.ran.length = 0
    await submit($, '!git push')
    await waitFor(async () => (await rowText($)) === '◆ Ship  main · clean · ↑0 ↓0', 'the refreshed row')
    const statusAt = seen.ran.indexOf(STATUS)
    const shellAt = seen.ran.findIndex(argv => argv.startsWith(BASH))
    expect(shellAt).toBeGreaterThan(-1)
    expect(statusAt).toBeGreaterThan(shellAt)
    const reads = seen.ran.filter(argv => argv === STATUS).length
    await seen.clock.advance(2_000)
    await settle()
    expect(seen.ran.filter(argv => argv === STATUS).length).toBe(reads)
  })

  test('buttons still only fill; nothing reaches the engine', async ($, on) => {
    const seen = engine(on, repo(status({ ab: '+1 -0' })))
    await started($, seen)
    await submit($, '!git push')
    await waitFor(() => seen.toasts.includes('Git Ship: git push done'), 'the done toast')
    expect(seen.submitted).toEqual([])
    expect(seen.filled).toEqual([])
  })
})

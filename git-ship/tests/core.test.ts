import { describe, expect, test } from 'claude-code/testing'

import {
  COMMIT_TRAILER,
  PR_FOOTER,
  bashQuote,
  branchCommand,
  buttonStates,
  capDiff,
  commandLabel,
  commitCommand,
  commitDraftPrompt,
  gitBashFromExecPath,
  interceptedCommand,
  isWindowsPath,
  isWslBash,
  newFilesText,
  parseDefaultBranch,
  parseDraft,
  parsePrView,
  parseStatus,
  prCreateCommand,
  prDraftPrompt,
  prViewCommand,
  pullCommand,
  pushCommand,
  rowText,
  runOutput,
  runStatusText,
  stageCommand,
  withTrailer,
} from '../hooks/core'
import type { RepoState } from '../hooks/core'

const FULL = [
  '# branch.oid 1a2b3c4d5e6f',
  '# branch.head main',
  '# branch.upstream origin/main',
  '# branch.ab +2 -1',
  '1 M. N... 100644 100644 100644 aaa bbb staged.ts',
  '1 .M N... 100644 100644 100644 aaa bbb unstaged file.ts',
  '2 R. N... 100644 100644 100644 aaa bbb R100 new.ts\told.ts',
  '? untracked.txt',
].join('\n') + '\n'

function state(over: Partial<RepoState> = {}): RepoState {
  return {
    branch: 'main',
    sha: '1a2b3c4',
    upstream: 'origin/main',
    ahead: 0,
    behind: 0,
    files: [],
    staged: 0,
    unstaged: 0,
    untracked: 0,
    unmerged: 0,
    root: 'D:\\Projects\\app',
    lastCommit: null,
    defaultBranch: 'main',
    baseRef: 'origin/main',
    ...over,
  }
}

const NO_OPTS = { drafting: false, hasOpenPr: null }

describe('parseStatus', () => {
  test('branch with upstream', () => {
    const s = parseStatus(FULL)
    expect(s.branch).toBe('main')
    expect(s.sha).toBe('1a2b3c4')
    expect(s.upstream).toBe('origin/main')
    expect(s.ahead).toBe(2)
    expect(s.behind).toBe(1)
    expect(s.files).toEqual([
      { xy: 'M.', path: 'staged.ts' },
      { xy: '.M', path: 'unstaged file.ts' },
      { xy: 'R.', path: 'new.ts' },
      { xy: '??', path: 'untracked.txt' },
    ])
    expect(s.staged).toBe(2)
    expect(s.unstaged).toBe(1)
    expect(s.untracked).toBe(1)
  })

  test('CRLF input with a trailing CRLF matches LF', () => {
    expect(parseStatus(FULL.replace(/\n/g, '\r\n'))).toEqual(parseStatus(FULL))
  })

  test('type 2 entry with a space in the new path', () => {
    const s = parseStatus('2 R. N... 100644 100644 100644 aaa bbb R100 new name.ts\told name.ts')
    expect(s.files).toEqual([{ xy: 'R.', path: 'new name.ts' }])
  })

  test('unmerged line with a space in the path', () => {
    const s = parseStatus('u UU N... 100644 100644 100644 100644 aaa bbb ccc my conflict.ts')
    expect(s.files).toEqual([{ xy: 'UU', path: 'my conflict.ts' }])
    expect(s.unmerged).toBe(1)
    expect(s.unstaged).toBe(1)
  })

  test('MM counts as staged and unstaged', () => {
    const s = parseStatus('1 MM N... 100644 100644 100644 aaa bbb both.ts')
    expect([s.staged, s.unstaged]).toEqual([1, 1])
    expect(s.unmerged).toBe(0)
  })

  test('branch.ab +0 -0', () => {
    const s = parseStatus('# branch.ab +0 -0')
    expect([s.ahead, s.behind]).toEqual([0, 0])
  })

  test('detached head has no branch', () => {
    expect(parseStatus('# branch.oid 1a2b3c4d5e6f\n# branch.head (detached)').branch).toBeNull()
  })

  test('no upstream', () => {
    const s = parseStatus('# branch.oid 1a2b3c4d5e6f\n# branch.head feat')
    expect(s.upstream).toBeNull()
    expect(s.ahead).toBe(0)
    expect(s.behind).toBe(0)
  })

  test('unborn branch has no sha', () => {
    expect(parseStatus('# branch.oid (initial)\n# branch.head main').sha).toBeNull()
  })

  test('unmerged lines count as unstaged', () => {
    const s = parseStatus('u UU N... 100644 100644 100644 100644 aaa bbb ccc conflict.ts')
    expect(s.files).toEqual([{ xy: 'UU', path: 'conflict.ts' }])
    expect(s.unstaged).toBe(1)
    expect(s.staged).toBe(0)
  })

  test('ignored lines are skipped', () => {
    expect(parseStatus('! ignored.log').files).toEqual([])
  })

  test('empty input', () => {
    const s = parseStatus('')
    expect(s.files).toEqual([])
    expect([s.staged, s.unstaged, s.untracked, s.ahead, s.behind]).toEqual([0, 0, 0, 0, 0])
  })
})

describe('rowText', () => {
  test('changed with arrows', () => {
    const files = [
      { xy: 'M.', path: 'a' },
      { xy: 'M.', path: 'b' },
      { xy: '??', path: 'c' },
    ]
    expect(rowText(state({ ahead: 2, behind: 1, files }))).toBe('main · 3 changed · ↑2 ↓1')
  })
  test('conflicts', () => {
    const files = [{ xy: 'UU', path: 'a' }, { xy: 'M.', path: 'b' }, { xy: '??', path: 'c' }]
    expect(rowText(state({ files, unmerged: 1, unstaged: 1 }))).toBe('main · 3 changed · 1 conflict · ↑0 ↓0')
    expect(rowText(state({ files, unmerged: 2, unstaged: 2 }))).toBe('main · 3 changed · 2 conflicts · ↑0 ↓0')
  })
  test('clean tree', () => {
    expect(rowText(state())).toBe('main · clean · ↑0 ↓0')
  })
  test('no upstream', () => {
    const files = [{ xy: 'M.', path: 'a' }]
    expect(rowText(state({ branch: 'feature/x', upstream: null, files }))).toBe('feature/x · 1 changed · no upstream')
  })
  test('detached', () => {
    expect(rowText(state({ branch: null, upstream: null }))).toBe('detached 1a2b3c4 · clean · no upstream')
  })
})

describe('buttonStates', () => {
  test('stage', () => {
    expect(buttonStates(state({ unstaged: 1 }), NO_OPTS).stage).toBe(true)
    expect(buttonStates(state({ untracked: 1 }), NO_OPTS).stage).toBe(true)
    expect(buttonStates(state({ staged: 1 }), NO_OPTS).stage).toBe(false)
  })
  test('commit', () => {
    const dirty = state({ files: [{ xy: 'M.', path: 'a' }] })
    expect(buttonStates(dirty, NO_OPTS).commit).toBe(true)
    expect(buttonStates(state(), NO_OPTS).commit).toBe(false)
    expect(buttonStates(dirty, { drafting: true, hasOpenPr: null }).commit).toBe(false)
  })
  test('stage and commit are off during a conflict', () => {
    const conflicted = state({ files: [{ xy: 'UU', path: 'a' }], unstaged: 1, unmerged: 1 })
    const b = buttonStates(conflicted, NO_OPTS)
    expect(b.stage).toBe(false)
    expect(b.commit).toBe(false)
  })
  test('push', () => {
    expect(buttonStates(state({ ahead: 1 }), NO_OPTS).push).toBe(true)
    expect(buttonStates(state({ upstream: null }), NO_OPTS).push).toBe(true)
    expect(buttonStates(state(), NO_OPTS).push).toBe(false)
    expect(buttonStates(state({ branch: null, upstream: null }), NO_OPTS).push).toBe(false)
    expect(buttonStates(state({ sha: null, upstream: null }), NO_OPTS).push).toBe(false)
  })
  test('pull', () => {
    expect(buttonStates(state(), NO_OPTS).pull).toBe(true)
    expect(buttonStates(state({ upstream: null }), NO_OPTS).pull).toBe(false)
  })
  test('branch and close are always on', () => {
    const b = buttonStates(state({ branch: null, upstream: null, sha: null }), NO_OPTS)
    expect(b.branch).toBe(true)
    expect(b.close).toBe(true)
  })
  test('pr', () => {
    expect(buttonStates(state({ branch: 'feat' }), NO_OPTS).pr).toBe(true)
    expect(buttonStates(state(), NO_OPTS).pr).toBe(false)
    expect(buttonStates(state({ branch: 'feat', upstream: null }), NO_OPTS).pr).toBe(false)
    expect(buttonStates(state({ branch: null }), NO_OPTS).pr).toBe(false)
    expect(buttonStates(state({ branch: 'feat' }), { drafting: true, hasOpenPr: null }).pr).toBe(false)
    expect(buttonStates(state({ branch: 'feat' }), { drafting: true, hasOpenPr: true }).pr).toBe(true)
    expect(buttonStates(state(), { drafting: false, hasOpenPr: true }).pr).toBe(false)
  })
})

describe('bashQuote', () => {
  test('escapes backslash, quote, dollar and backtick', () => {
    expect(bashQuote('a "b" $c `d` \\e')).toBe('"a \\"b\\" \\$c \\`d\\` \\\\e"')
  })
  test('keeps newlines', () => {
    expect(bashQuote('a\nb')).toBe('"a\nb"')
  })
  test('passes ! and single quotes through', () => {
    expect(bashQuote("it's done!")).toBe('"it\'s done!"')
  })
})

describe('commands', () => {
  test('stage', () => {
    expect(stageCommand()).toBe('!git add -A')
  })
  test('commit', () => {
    expect(commitCommand('fix: x', 'body', false)).toBe('!git commit -m "fix: x" -m "body"')
    expect(commitCommand('fix: x', 'body', true)).toBe('!git add -A && git commit -m "fix: x" -m "body"')
    expect(commitCommand('', '', false)).toBe('!git commit -m ""')
  })
  test('push', () => {
    expect(pushCommand(state())).toBe('!git push')
    expect(pushCommand(state({ branch: 'feat', upstream: null }))).toBe('!git push -u origin "feat"')
    expect(pushCommand(state({ branch: 'a$b`c', upstream: null }))).toBe('!git push -u origin "a\\$b\\`c"')
    expect(pushCommand(state({ branch: null, upstream: null }))).toBe('')
  })
  test('pull, branch, pr', () => {
    expect(pullCommand()).toBe('!git pull')
    expect(branchCommand()).toBe('!git switch -c ')
    expect(prCreateCommand('T', 'B')).toBe('!gh pr create --title "T" --body "B"')
    expect(prViewCommand()).toBe('!gh pr view --web')
  })
})

describe('drafting helpers', () => {
  test('capDiff', () => {
    expect(capDiff('abc', 10)).toEqual({ text: 'abc', isTruncated: false })
    expect(capDiff('abcdefghij', 4)).toEqual({ text: 'abcd\n… (diff truncated)', isTruncated: true })
    expect(capDiff('x'.repeat(40_001)).isTruncated).toBe(true)
  })

  test('constants', () => {
    expect(COMMIT_TRAILER).toBe('Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>')
    expect(PR_FOOTER).toBe('🤖 Generated with [Claude Code](https://claude.com/claude-code)')
  })

  test('withTrailer', () => {
    expect(withTrailer('body', 'T')).toBe('body\n\nT')
    expect(withTrailer('body\n\nT', 'T')).toBe('body\n\nT')
    expect(withTrailer('', 'T')).toBe('T')
    expect(withTrailer('body\n\nT  \n', 'T')).toBe('body\n\nT  \n')
  })

  test('parseDraft', () => {
    expect(parseDraft('fix: x\n\nthe body\nmore')).toEqual({ subject: 'fix: x', body: 'the body\nmore' })
    expect(parseDraft('```\nfix: x\n\nbody\n```')).toEqual({ subject: 'fix: x', body: 'body' })
    expect(parseDraft('  spaced  \n\n  body  ').subject).toBe('spaced')
    expect(parseDraft('a'.repeat(100)).subject).toBe('a'.repeat(72))
    // The cut counts code points: an emoji at the boundary is kept whole, never half a surrogate pair.
    expect(parseDraft(`${'a'.repeat(71)}😀b`).subject).toBe(`${'a'.repeat(71)}😀`)
    expect(parseDraft(`${'a'.repeat(72)}😀`).subject).toBe('a'.repeat(72))
    expect(parseDraft('fix: x\r\n\r\nbody\r\nmore')).toEqual({ subject: 'fix: x', body: 'body\nmore' })
    expect(parseDraft('\n\n  \nfix: x\n\nbody')).toEqual({ subject: 'fix: x', body: 'body' })
    expect(parseDraft('')).toEqual({ subject: '', body: '' })
  })

  test('commitDraftPrompt', () => {
    const p = commitDraftPrompt({ diff: 'DIFFTEXT', stat: 'STATTEXT', recentSubjects: ['feat: one', 'fix: two'] })
    for (const part of ['DIFFTEXT', 'STATTEXT', 'feat: one', 'fix: two']) expect(p).toContain(part)
    expect(p).toContain(
      'Reply with only the commit message: one subject line of at most 72 characters in the same style as the recent subjects, a blank line, then a short body of what changed and why. No trailers, no code fences.',
    )
  })

  test('prDraftPrompt', () => {
    const p = prDraftPrompt({ log: 'LOGTEXT', stat: 'STATTEXT', branch: 'feat', base: 'main' })
    for (const part of ['LOGTEXT', 'STATTEXT', 'feat', 'main']) expect(p).toContain(part)
    expect(p).toContain(
      'a PR title line, a blank line, then a markdown body with a short summary and a bullet list of changes. No footer, no code fences.',
    )
  })

  test('parseDefaultBranch', () => {
    expect(parseDefaultBranch('origin/main\n')).toBe('main')
    expect(parseDefaultBranch(undefined)).toBeNull()
    expect(parseDefaultBranch('')).toBeNull()
    expect(parseDefaultBranch('origin/feature/x\n')).toBe('feature/x')
  })

  test('parsePrView', () => {
    expect(parsePrView('{"number":4,"state":"OPEN"}')).toBe(true)
    expect(parsePrView('{"number":4,"state":"MERGED"}')).toBe(false)
    expect(parsePrView('{"number":4,"state":"CLOSED"}')).toBe(false)
    expect(parsePrView('not json')).toBe(false)
    expect(parsePrView(undefined)).toBe(false)
  })
})

describe('newFilesText', () => {
  test('each file under a header, long ones cut, binary or unreadable ones named only', () => {
    const text = newFilesText(
      [
        { path: 'a.ts', text: 'export const a = 1\n' },
        { path: 'big.md', text: 'x'.repeat(30) },
        { path: 'img.png', text: 'PNG\u0000data' },
        { path: 'gone.txt', text: undefined },
      ],
      20,
    )
    expect(text).toBe(
      [
        'New file: a.ts\nexport const a = 1',
        `New file: big.md\n${'x'.repeat(20)}\n… (file truncated)`,
        'New file: img.png (not shown)',
        'New file: gone.txt (not shown)',
      ].join('\n\n'),
    )
  })

  test('no files gives an empty string', () => {
    expect(newFilesText([])).toBe('')
  })
})

describe('running a filled command', () => {
  test('interceptedCommand: only !git and !gh lines, the text after ! kept verbatim', () => {
    expect(interceptedCommand('!git push')).toBe('git push')
    expect(interceptedCommand('  !gh pr view --web  ')).toBe('gh pr view --web  ')
    expect(interceptedCommand('!git commit -m "a" -m "b\nc"')).toBe('git commit -m "a" -m "b\nc"')
    expect(interceptedCommand('!ls')).toBeNull()
    expect(interceptedCommand('!gitk')).toBeNull()
    expect(interceptedCommand('!git')).toBeNull()
    expect(interceptedCommand('git push')).toBeNull()
    expect(interceptedCommand('please !git push')).toBeNull()
    expect(interceptedCommand('\n\t  !git push')).toBe('git push')
    expect(interceptedCommand('!gh')).toBeNull()
  })

  test('gitBashFromExecPath: three folders up, then bin/bash.exe', () => {
    expect(gitBashFromExecPath('D:/Program Files/Git/mingw64/libexec/git-core\n')).toBe('D:/Program Files/Git/bin/bash.exe')
    expect(gitBashFromExecPath('C:\\Program Files\\Git\\mingw64\\libexec\\git-core\\')).toBe('C:/Program Files/Git/bin/bash.exe')
    expect(gitBashFromExecPath('/git-core')).toBeNull()
    expect(gitBashFromExecPath('')).toBeNull()
    expect(gitBashFromExecPath(undefined)).toBeNull()
  })

  test('runOutput: stdout then stderr, the last 30 lines', () => {
    expect(runOutput('out 1\nout 2\n', 'err 1\n')).toBe('out 1\nout 2\nerr 1')
    expect(runOutput('', 'only err\r\n')).toBe('only err')
    expect(runOutput('', '')).toBe('')
    const many = Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n')
    expect(runOutput(many, '')).toBe(Array.from({ length: 30 }, (_, i) => `line ${i + 10}`).join('\n'))
  })

  test('runOutput: each line capped at 500 characters', () => {
    expect(runOutput('x'.repeat(800), '')).toBe(`${'x'.repeat(500)}…`)
  })

  test('runOutput: the total capped at 4,000 characters, keeping the end, marked', () => {
    const lines = Array.from({ length: 30 }, (_, i) => `${String(i).padStart(2, '0')}${'y'.repeat(298)}`)
    const out = runOutput(lines.join('\n'), '')
    expect(out.length).toBeLessThanOrEqual(4_000 + '\n… (output truncated)'.length)
    expect(out.endsWith('\n… (output truncated)')).toBe(true)
    expect(out).toContain(lines[29] ?? '')
    expect(out).not.toContain(lines[0] ?? '')
  })

  test('runOutput: ANSI escapes and control characters stripped, newlines kept; a carriage return keeps what was redrawn last', () => {
    expect(runOutput('\u001b[32mgreen\u001b[0m\nbell\u0007 done\u0000\n', '')).toBe('green\nbell done')
    expect(runOutput('Counting 50%\rCounting 100%\n', '')).toBe('Counting 100%')
    expect(runOutput('a\tb\n', '')).toBe('a b')
  })

  test('runOutput: an engine-truncated stream is marked', () => {
    expect(runOutput('head\n', '', true)).toBe('head\n… (output truncated)')
    expect(runOutput('', '', true)).toBe('… (output truncated)')
  })

  test('isWslBash: System32 and WindowsApps bash are WSL, never Git Bash', () => {
    expect(isWslBash('C:\\Windows\\System32\\bash.exe')).toBe(true)
    expect(isWslBash('c:/windows/system32/BASH.EXE')).toBe(true)
    expect(isWslBash('C:\\Users\\r\\AppData\\Local\\Microsoft\\WindowsApps\\bash.exe')).toBe(true)
    expect(isWslBash('D:/Program Files/Git/bin/bash.exe')).toBe(false)
    expect(isWslBash('bash')).toBe(false)
  })

  test('isWindowsPath: a drive letter', () => {
    expect(isWindowsPath('D:/Projects/app')).toBe(true)
    expect(isWindowsPath('c:\\x')).toBe(true)
    expect(isWindowsPath('/home/r/app')).toBe(false)
  })

  test('commandLabel: the first line, cut to 60 characters', () => {
    expect(commandLabel('git push')).toBe('git push')
    expect(commandLabel('git commit -m "a"\n-m "b"')).toBe('git commit -m "a"…')
    expect(commandLabel(`git ${'x'.repeat(80)}`)).toBe(`git ${'x'.repeat(56)}…`)
  })

  test('runStatusText', () => {
    expect(runStatusText(0)).toBe('✓ exit 0')
    expect(runStatusText(1)).toBe('✗ exit 1')
    expect(runStatusText(null)).toBe('✗ did not finish — it may still be running')
  })
})

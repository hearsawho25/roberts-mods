/**
 * Git Ship's pure logic: parsing `git status --porcelain=v2 --branch`, the row text,
 * which buttons are enabled, the commands the buttons fill, shell quoting and the
 * drafting prompts. Nothing here touches `$`, so every function is unit-tested directly.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type FileChange = { xy: string; path: string }

/** What one `git status --porcelain=v2 --branch` run says. */
export type StatusFacts = {
  /** null when HEAD is detached. */
  branch: string | null
  /** The first 7 characters of HEAD; null on an unborn branch. */
  sha: string | null
  upstream: string | null
  ahead: number
  behind: number
  files: FileChange[]
  staged: number
  unstaged: number
  untracked: number
  /** Unmerged (conflicted) paths; they also count as unstaged. */
  unmerged: number
}

/** `baseRef` is what a PR is drafted against: `origin/<base>` when origin/HEAD names it, else the local `<base>`. */
export type RepoState = StatusFacts & { root: string; lastCommit: string | null; defaultBranch: string; baseRef: string }

export type ButtonId = 'stage' | 'commit' | 'push' | 'pull' | 'branch' | 'pr' | 'close'

// ---------------------------------------------------------------------------
// Status parsing and the row
// ---------------------------------------------------------------------------

/** The text after the first `n` space-separated fields of `line`. */
function afterFields(line: string, n: number): string {
  let at = 0
  for (let i = 0; i < n; i++) {
    const space = line.indexOf(' ', at)
    if (space === -1) return ''
    at = space + 1
  }
  return line.slice(at)
}

/** Parse `git status --porcelain=v2 --branch` output (not `-z`). */
export function parseStatus(text: string): StatusFacts {
  const facts: StatusFacts = {
    branch: null,
    sha: null,
    upstream: null,
    ahead: 0,
    behind: 0,
    files: [],
    staged: 0,
    unstaged: 0,
    untracked: 0,
    unmerged: 0,
  }
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith('# branch.oid ')) {
      const oid = line.slice('# branch.oid '.length).trim()
      facts.sha = oid === '(initial)' || oid === '' ? null : oid.slice(0, 7)
    } else if (line.startsWith('# branch.head ')) {
      const head = line.slice('# branch.head '.length).trim()
      facts.branch = head === '(detached)' || head === '' ? null : head
    } else if (line.startsWith('# branch.upstream ')) {
      facts.upstream = line.slice('# branch.upstream '.length).trim() || null
    } else if (line.startsWith('# branch.ab ')) {
      const m = /\+(\d+) -(\d+)/.exec(line)
      if (m) {
        facts.ahead = Number(m[1])
        facts.behind = Number(m[2])
      }
    } else if (line.startsWith('1 ') || line.startsWith('2 ') || line.startsWith('u ')) {
      const xy = line.slice(2, 4)
      let path: string
      if (line[0] === '1') path = afterFields(line, 8)
      else if (line[0] === '2') path = afterFields(line, 9).split('\t')[0] ?? ''
      else path = afterFields(line, 10)
      facts.files.push({ xy, path })
      if (line[0] === 'u') {
        facts.unstaged++
        facts.unmerged++
      } else {
        if (xy[0] !== '.') facts.staged++
        if (xy[1] !== '.') facts.unstaged++
      }
    } else if (line.startsWith('? ')) {
      facts.files.push({ xy: '??', path: line.slice(2) })
      facts.untracked++
    }
  }
  return facts
}

/** The row's status text, e.g. `main · 3 changed · ↑2 ↓1`. */
export function rowText(state: RepoState): string {
  const where = state.branch ?? `detached ${state.sha ?? 'HEAD'}`
  const changed = state.files.length === 0 ? 'clean' : `${state.files.length} changed`
  const conflicts = state.unmerged === 0 ? '' : ` · ${state.unmerged} ${state.unmerged === 1 ? 'conflict' : 'conflicts'}`
  const sync = state.upstream === null ? 'no upstream' : `↑${state.ahead} ↓${state.behind}`
  return `${where} · ${changed}${conflicts} · ${sync}`
}

/** Which buttons are enabled. `close` and `branch` are always on. */
export function buttonStates(
  state: RepoState,
  opts: { drafting: boolean; hasOpenPr: boolean | null },
): Record<ButtonId, boolean> {
  return {
    // Staging or committing during a conflict would take the conflict markers.
    stage: state.unmerged === 0 && state.unstaged + state.untracked > 0,
    commit: state.unmerged === 0 && state.files.length > 0 && !opts.drafting,
    push: state.branch !== null && state.sha !== null && (state.ahead > 0 || state.upstream === null),
    pull: state.upstream !== null,
    branch: true,
    // With an open PR the button only views it, so drafting does not matter.
    pr:
      state.branch !== null &&
      state.branch !== state.defaultBranch &&
      state.upstream !== null &&
      (opts.hasOpenPr === true || !opts.drafting),
    close: true,
  }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/** Wrap `s` in bash double quotes, backslash-escaping `\`, `"`, `$` and a backtick. Newlines stay. */
export function bashQuote(s: string): string {
  return `"${s.replace(/[\\"$`]/g, '\\$&')}"`
}

export function stageCommand(): string {
  return '!git add -A'
}

/** `!git commit`, with `git add -A &&` in front when nothing is staged. An empty body adds no second `-m`. */
export function commitCommand(subject: string, body: string, stageFirst: boolean): string {
  const parts = `-m ${bashQuote(subject)}${body === '' ? '' : ` -m ${bashQuote(body)}`}`
  return `!${stageFirst ? 'git add -A && ' : ''}git commit ${parts}`
}

/** `!git push`, or `-u origin "<branch>"` without an upstream. Empty on a detached HEAD. */
export function pushCommand(state: RepoState): string {
  if (state.branch === null) return ''
  return state.upstream === null ? `!git push -u origin ${bashQuote(state.branch)}` : '!git push'
}

export function pullCommand(): string {
  return '!git pull'
}

/** Ends in a space so Robert types the branch name. */
export function branchCommand(): string {
  return '!git switch -c '
}

export function prCreateCommand(title: string, body: string): string {
  return `!gh pr create --title ${bashQuote(title)} --body ${bashQuote(body)}`
}

export function prViewCommand(): string {
  return '!gh pr view --web'
}

// ---------------------------------------------------------------------------
// Drafting
// ---------------------------------------------------------------------------

export const COMMIT_TRAILER = 'Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>'
export const PR_FOOTER = '🤖 Generated with [Claude Code](https://claude.com/claude-code)'

const SUBJECT_MAX = 72

/** Cut a diff to `max` characters, marking the cut. */
export function capDiff(text: string, max = 40_000): { text: string; isTruncated: boolean } {
  if (text.length <= max) return { text, isTruncated: false }
  return { text: `${text.slice(0, max)}\n… (diff truncated)`, isTruncated: true }
}

/**
 * New (untracked) files as text the draft can read, since `git diff` leaves them out: each
 * under a `New file:` header, cut to `perFile` characters; unreadable or binary ones by name.
 */
export function newFilesText(files: readonly { path: string; text: string | undefined }[], perFile = 4_000): string {
  return files
    .map(({ path, text }) => {
      if (text === undefined || text.includes('\u0000')) return `New file: ${path} (not shown)`
      const body = text.length > perFile ? `${text.slice(0, perFile)}\n… (file truncated)` : text
      return `New file: ${path}\n${body.trimEnd()}`
    })
    .join('\n\n')
}

/** Append `trailer` below `body` unless the body already ends with it. */
export function withTrailer(body: string, trailer: string): string {
  if (body === '') return trailer
  if (body.trimEnd().endsWith(trailer)) return body
  return `${body}\n\n${trailer}`
}

/** Read the model's "subject, blank line, body" reply. */
export function parseDraft(reply: string): { subject: string; body: string } {
  // Normalise line endings; trim() also drops any leading blank lines.
  let text = reply.replace(/\r\n?/g, '\n').trim()
  const fence = /^```[^\n]*\n([\s\S]*?)\n?```$/.exec(text)
  if (fence) text = (fence[1] ?? '').trim()
  const nl = text.indexOf('\n')
  const first = nl === -1 ? text : text.slice(0, nl)
  const rest = nl === -1 ? '' : text.slice(nl + 1)
  // Cut by code point, so an emoji at the boundary is never split into half a surrogate pair.
  return { subject: Array.from(first.trim()).slice(0, SUBJECT_MAX).join(''), body: rest.trim() }
}

export function commitDraftPrompt(i: { diff: string; stat: string; recentSubjects: string[] }): string {
  return [
    'Write a git commit message for the changes below.',
    '',
    'Recent commit subjects (for style):',
    i.recentSubjects.join('\n'),
    '',
    'Diff stat:',
    i.stat,
    '',
    'Diff:',
    i.diff,
    '',
    'Reply with only the commit message: one subject line of at most 72 characters in the same style as the recent subjects, a blank line, then a short body of what changed and why. No trailers, no code fences.',
  ].join('\n')
}

export function prDraftPrompt(i: { log: string; stat: string; branch: string; base: string }): string {
  return [
    `Write a pull request for branch ${i.branch}, to be merged into ${i.base}.`,
    '',
    `Commits on ${i.branch} since ${i.base}:`,
    i.log,
    '',
    'Diff stat:',
    i.stat,
    '',
    'Reply with only a PR title line, a blank line, then a markdown body with a short summary and a bullet list of changes. No footer, no code fences.',
  ].join('\n')
}

// ---------------------------------------------------------------------------
// Git output
// ---------------------------------------------------------------------------

/** `git symbolic-ref --short refs/remotes/origin/HEAD` output (`origin/main`) to the branch name. */
export function parseDefaultBranch(out: string | undefined): string | null {
  const ref = out?.trim() ?? ''
  if (ref === '') return null
  const slash = ref.indexOf('/')
  return slash === -1 ? ref : ref.slice(slash + 1) || null
}

/** Whether `gh pr view --json number,state` reports an open PR. */
export function parsePrView(json: string | undefined): boolean {
  if (!json) return false
  try {
    return (JSON.parse(json) as { state?: unknown }).state === 'OPEN'
  } catch {
    return false
  }
}

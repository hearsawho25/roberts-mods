/** One changed path: its two-letter porcelain status (`??` untracked) and its path. */
export type GitShipFile = { xy: string; path: string }

/** The repo as the row and the pane draw it; the same shape as core.ts's RepoState. */
export type GitShipRepo = {
  /** null when HEAD is detached. */
  branch: string | null
  /** The first 7 characters of HEAD; null on an unborn branch. */
  sha: string | null
  upstream: string | null
  ahead: number
  behind: number
  files: GitShipFile[]
  staged: number
  unstaged: number
  untracked: number
  /** Unmerged (conflicted) paths; they also count as unstaged. */
  unmerged: number
  /** The work tree's top folder. */
  root: string
  /** `<short sha> <subject>` of HEAD; null with no commits. */
  lastCommit: string | null
  /** origin/HEAD's branch, else `main` or `master`. */
  defaultBranch: string
  /** What a PR is drafted against: `origin/<defaultBranch>` when origin/HEAD names it, else the local `<defaultBranch>`. */
  baseRef: string
}

/** The line Git Ship is running now. */
export type GitShipRunning = {
  /** The text after `!`, as submitted. */
  command: string
  /** This run's own token: only its own run (or a later load) clears the slot, never a run of the same command. */
  token: number
}

/** One line Git Ship ran when Robert pressed Enter on it. */
export type GitShipRun = {
  /** The text after `!`, as submitted. */
  command: string
  /** null when the run threw or timed out. */
  exitCode: number | null
  /** stdout then stderr, the last 30 lines. */
  output: string
  /** When it finished, epoch ms. */
  at: number
}

declare module 'claude-code' {
  interface PluginState {
    'git-ship': {
      /** The repo as last read; null outside a repo (or before the first read), 'error' when git failed. */
      repo: GitShipRepo | null | 'error'
      /** Whether the Git Ship pane is open. */
      paneOpen: boolean
      /** True while a commit or PR draft is being written (Task 3). */
      drafting: boolean
      /** Whether the branch has an open PR, checked when the pane opens; null when not checked. */
      hasOpenPr: boolean | null
      /** The `!git`/`!gh` line Git Ship is running now, with its run's token; null when none. */
      running: GitShipRunning | null
      /** The last line Git Ship ran; null before the first. */
      lastRun: GitShipRun | null
    }
  }
}

# Git Ship Pane (`git-ship`) — design

Approved by Robert on 2026-10-14. The mod shows the state of the current git repo in the band above the prompt. A pane with buttons fills ready-to-run `!git …` and `!gh …` commands into the prompt box. Robert reads each command and presses Enter himself, which is how he already handles git.

## Rules

- **Fill only, never send.** Every button calls `$.prompt.fill` with mode `replace`. The mod never calls `$.prompt.submit`.
- **The mod's own git use is read-only.** It runs only `status`, `log`, `diff`, `rev-parse`, `symbolic-ref` and `gh pr view`. Every write goes through a command Robert sends himself.
- **No hint-line button.** The pane is reached from the row's `[ Open ]`, from `/ship`, or from Robert's Toolbox, which runs the mod's first registered command, `/ship`.
- **Shares the band.** The AbovePrompt hook always calls `next(e)` and adds its row to what comes back, the same way Relay does.

## Presence

- The mod shows only when the session's folder is inside a git work tree (`git rev-parse --show-toplevel`). Outside a repo, such as `D:\Projects` itself, it draws nothing.
- **Row:** `◆ Ship  <branch> · <n> changed · ↑<ahead> ↓<behind>  [ Open ]`. Its colour is green, which keeps it distinct from Relay's gold.
  - With no upstream, it shows `no upstream` in place of the arrows.
  - On a detached HEAD, it shows `detached <short sha>`.
  - A clean tree shows `clean`.
- **Pane (open):**
  - `<branch> → <upstream>  ↑a ↓b` (with no upstream: `<branch> → no upstream`, matching the row)
  - up to 10 changed files, each with its two-letter porcelain status, then `+N more`
  - the last commit, as `<short sha> <subject>`
  - the button row
- `[ Close ]` closes the pane, and so does running `/ship` while it is open.

## Refresh (approach 1: on demand, no timer)

- The mod re-reads git state:
  - when the session starts
  - after each turn completes
  - after a prompt beginning with `!` (a shell command Robert ran) has been handled
  - when the pane opens
- It doesn't poll on a timer.
- Concurrent refreshes coalesce. If a refresh is already running, one more is queued, never several.
- Every git call has a 5-second timeout. On failure, the row shows `◆ Ship  git unavailable` with no buttons.

## Buttons

| Button | Fills | Enabled when |
|---|---|---|
| Stage all | `!git add -A` | there are unstaged or untracked changes |
| Draft commit | `!git commit -m "<subject>" -m "<body>"`. If nothing is staged, the command starts with `git add -A && ` and the draft covers all changes | there is any change |
| Push | `!git push`. With no upstream: `!git push -u origin <branch>` | ahead > 0, or no upstream and at least one commit, and not detached |
| Pull | `!git pull` | an upstream exists |
| New branch | `!git switch -c ` with the cursor at the end | always (in a repo) |
| PR | `!gh pr create --title "<title>" --body "<body>"`. If the branch already has an open PR: `!gh pr view --web` | not on the default branch, not detached, and the branch has an upstream |
| Close | closes the pane | always |

- Disabled buttons are drawn dim and do nothing when pressed.
- **Conflicts** (Robert, 2026-10-14): while any file is unmerged, the row shows `· N conflicts`, and both Stage all and Draft commit are disabled. Their `git add -A` would mark the conflict markers as resolved. Robert resolves and stages those files himself.
- The default branch comes from `git symbolic-ref --short refs/remotes/origin/HEAD`. If that fails, it falls back to `main`, then `master`.
- The PR existence check (`gh pr view --json number,state`) runs only when the pane opens, never on the row. If `gh` is missing or fails, the PR button fills `create`.

## Drafting

- Draft commit and PR use a side model call: `$.model.complete` with model `sonnet`, effort `low`, a 1024-token cap and a 60-second timeout. This runs outside the main conversation and sends only the diff and the log. It replaced `$.model.fork` during the build, because a fork fails in a new or just-cleared session and re-sends the whole transcript.
- **Commit input:** the staged diff, or the full diff when nothing is staged, capped at 40,000 characters. It always includes `git diff --stat`, plus the last 5 commit subjects as a style sample. When the commit stages everything first, it also lists every untracked file (`git ls-files --others --exclude-standard`, which looks inside new folders) and adds the text of the first 30, each cut to 4,000 characters. `git diff` leaves new files out.
  - Output: one subject line of 72 characters or fewer, then a short body.
  - The body always ends with the trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`, which matches Robert's existing commits.
- **PR input:** `git log <base>..HEAD` subjects and bodies, plus `git diff --stat <base>...HEAD`. `<base>` is `origin/<default>` when origin's HEAD is known, otherwise the local default branch.
- **No draft from nothing:** if a diff or log can't be read, or is empty, the mod doesn't call the model. It fills the empty command and shows a toast saying why.
  - Output: a title and a markdown body.
  - The body ends with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.
- While a draft is running, the pane shows `drafting…` and the draft buttons are disabled.
- If the call fails, the button fills the command with empty `-m ""` (or `--title "" --body ""`), and a toast says the draft failed.
- **Quoting:** `!` commands run in Git Bash on Robert's machine. This was confirmed on 2026-10-14: `! echo "shell:$0"` printed `shell:/usr/bin/bash`, even though the machine's primary shell is PowerShell. If that ever changes, the quoting must change too, because PowerShell doesn't treat `\` as an escape. Each message part is wrapped in double quotes, and `\`, `"`, `$` and `` ` `` are backslash-escaped. Newlines are kept inside the quotes.

## Files

- `hooks/core.ts` holds the pure logic, tested directly:
  - parsing `git status --porcelain=v2 --branch` into a `RepoState`
  - formatting the row
  - deciding which buttons are enabled
  - building each command
  - shell quoting
  - building the drafting prompts and parsing the model's reply
- `hooks/register.tsx` holds every `$` call:
  - atoms
  - the refresh
  - the AbovePrompt row
  - the Pane
  - the `/ship` command
  - the button handlers
  - the model calls

  Helpers that take `$` are top-level functions in this file, as the validator requires.
- `types/index.d.ts` is the `PluginState` contract.
- `tests/core.test.ts`, `tests/ship.test.tsx` and `tests/draft.test.tsx` hold the tests.

## Out of scope (v1)

Staging individual files, a diff viewer, stash, rebase, merge, multi-repo views and timer polling.

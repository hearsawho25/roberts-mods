# Git Ship Pane (`git-ship`) — design

Approved by Robert on 2026-10-14. The mod shows the state of the current git repo in the band above the prompt. A pane with buttons fills ready-to-run `!git …` and `!gh …` commands into the prompt box. Robert reads each command and presses Enter himself, which is how he already handles git.

## Rules

- **Fill only, never send.** Every button calls `$.prompt.fill` with mode `replace`. The mod never calls `$.prompt.submit`.
- **Writes only on Robert's Enter.** On its own account the mod runs only read-only commands: `status`, `log`, `diff`, `ls-files`, `rev-parse`, `symbolic-ref` and `gh pr view`. A write runs only when Robert presses Enter on a `!git` or `!gh` line (see "Running a filled command").
- **No hint-line button.** The pane is reached from the row's `[ Open ]`, from `/ship`, or from Robert's Toolbox, which runs the mod's first registered command, `/ship`.
- **Shares the band.** The AbovePrompt hook always calls `next(e)` and adds its row to what comes back, the same way Relay does.

## Running a filled command (changed 2026-10-14)

A plugin fill can't put the prompt box into shell mode. A filled `!git push` would otherwise go to Claude as a normal message, and Claude would run it as a tool call. Robert chose to have the mod run the line itself, but only when he presses Enter:

- **When it intercepts:** a `prompt.submit` hook catches any submitted line that, once trimmed, starts with `!git ` or `!gh `, while the session is in a repo. The prompt is dropped and never reaches Claude. The drop reason shown is `Git Ship ran: <command>`.
- **How it runs:** the text after `!`, including any edits Robert made, is passed through the environment as `GIT_SHIP_COMMAND` and run as `<git-bash> -c 'eval "$GIT_SHIP_COMMAND"'` from the repo root.
  - It is never put on the command line. On Windows, MSYS parses argv a second time, which collapses backslashes. In a test that second parse ran a `\$(…)` from inside a quoted message.
  - The timeout is 300 s, which leaves room for a credential window.
  - `GIT_TERMINAL_PROMPT=0`, `GH_PROMPT_DISABLED=1`, `GIT_EDITOR=false` and `GIT_SEQUENCE_EDITOR=false` are set, so nothing can hang waiting for input or an editor. A `git commit` without `-m` fails at once instead.
  - The Git Bash path is `CLAUDE_CODE_GIT_BASH_PATH` if that is set. Otherwise it's worked out from `git --exec-path`: three folders up, then `bin/bash.exe` (`D:/Program Files/Git/bin/bash.exe` on Robert's machine).
  - On non-Windows it's plain `bash`.
  - It must never be a bare `bash` on Windows, because `C:\Windows\System32\bash.exe` is WSL. Paths ending in `System32\bash.exe` or `WindowsApps\bash.exe` are refused.
- **What counts as Enter:** only a `prompt.submit` with `origin.kind === 'composer'`. That is Robert's Enter, including a line queued mid-turn, which runs at once. Bridge, SDK, peer and plugin submissions pass through untouched.
- **Robert's own typed `!git …` is caught too.** Its output goes to the pane, not into Claude's context.
- **Never to Claude by accident:** if the hook fails, or git state can't be read, an intercepted line is dropped with a message and put back in the box. It is never passed on.
- **Output limits:** each line is capped at 500 characters and the whole output at 4,000. ANSI and control characters are stripped. The output is marked `… (output truncated)` when the process cut a stream.
- **Output:** the pane shows the last run: `$ <command>`, the last 30 lines of combined output, and `✓ exit 0`, `✗ exit N`, or `✗ did not finish — it may still be running`. A run that didn't finish gets one more refresh 30 s later. A toast reports the outcome: `Git Ship: git push done`, or `… failed (exit N) — see the pane`. A failure opens the pane.
- **One at a time:** while a command runs, the row shows `running <command>…`. A second intercepted line is dropped with `Git Ship is still running <command>`.
- After every run, the mod refreshes git state.
- **Clearing the box:** Claude Code puts a dropped prompt back in the box. About 300 ms after a successful intercept, the mod clears the box, but only if it still holds that exact line, so a second Enter can't run it twice.
- **The rule changes** from "the mod never runs a git write" to "the mod runs a write only when Robert presses Enter on the line". The buttons themselves still only fill.

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
  - after a prompt beginning with `!` (a shell command Robert ran) has been handled, and once more 1.5 s later.
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
- **Quoting:** filled commands run in Git Bash, through the mod (see "Running a filled command"). This was confirmed on 2026-10-14: `! echo "shell:$0"` printed `shell:/usr/bin/bash`, even though the machine's primary shell is PowerShell. If that ever changes, the quoting must change too, because PowerShell doesn't treat `\` as an escape. Each message part is wrapped in double quotes, and `\`, `"`, `$` and `` ` `` are backslash-escaped. Newlines are kept inside the quotes.

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
- `tests/core.test.ts`, `tests/ship.test.tsx`, `tests/draft.test.tsx` and `tests/run.test.tsx` hold the tests.

## Out of scope (v1)

Staging individual files, a diff viewer, stash, rebase, merge, multi-repo views and timer polling.

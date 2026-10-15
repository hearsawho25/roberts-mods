# Git Ship

A Claude Code mod that shows the state of your git repo above the prompt. A `/ship` pane has buttons that fill ready-to-run `git` and `gh` commands into the prompt box. **The buttons only fill; nothing runs until you press Enter.** You read the command, edit it if you like, and press Enter. Git Ship then runs the line itself in Git Bash from the repo root, and Claude never sees it.

## Install

```
claude plugin marketplace add hearsawho25/roberts-mods
claude plugin install git-ship@roberts-mods
```

## The row

Inside a git repo, one line sits in the band above the prompt:

```
◆ Ship  main · 3 changed · ↑2 ↓0  [ Open ]
```

- With no upstream, the arrows are replaced by `no upstream`.
- On a detached HEAD, the branch name is replaced by `detached <sha>`.
- During a merge conflict, the row adds `· N conflicts`.
- If git can't be read, the row shows `◆ Ship  git unavailable`.
- Outside a repo, nothing shows.

The row refreshes on these occasions:

- when the session starts
- after each reply
- after Git Ship runs a `!git` or `!gh` line for you
- after any other `!` command you run, and once more 1.5 seconds later
- when you open the pane

It never polls on a timer. Every git call it makes is read-only and times out after 5 seconds. None of them hold up a reply.

## The pane

Open it with the row's `[ Open ]`, with `/ship`, or from Robert's Toolbox. It shows:

- the branch and its upstream
- up to 10 changed files
- the last commit
- these buttons:

| Button | Fills |
|---|---|
| Stage all | `!git add -A` |
| Draft commit | `!git commit -m "<subject>" -m "<body>"`. The message is written by a side Sonnet call from the diff and your last 5 commit subjects, and ends with a `Co-Authored-By: Claude` line. If nothing is staged, the command starts with `git add -A && `. |
| Push | `!git push`, or `!git push -u origin "<branch>"` the first time |
| Pull | `!git pull` |
| New branch | `!git switch -c ` (type the name) |
| PR | `!gh pr create --title "…" --body "…"`, drafted from the branch's commits. If the branch already has an open PR, it fills `!gh pr view --web` instead. |
| Close | closes the pane |

- Buttons that don't apply are dimmed and do nothing:
  - Push with nothing to push
  - PR on the default branch
  - Stage all and Draft commit during a merge conflict. Resolve the conflict, then `git add <file>` yourself.
- If a draft fails, the command is filled with empty quotes for you to type into.

## Pressing Enter

A plugin can't put the prompt box into shell mode, so a filled `!git push` would otherwise go to Claude as an ordinary message. Git Ship catches it instead:

- Any line you submit that starts with `!git ` or `!gh `, inside a repo, is dropped before it reaches Claude, and Git Ship runs it exactly as you left it, edits included.
- It runs in Git Bash from the repo root, with a 5-minute limit. The line is handed to bash through an environment variable, never on the command line, so backslashes and `$(…)` inside quoted messages stay as written. `GIT_TERMINAL_PROMPT=0`, `GH_PROMPT_DISABLED=1` and `GIT_EDITOR=false` mean nothing waits for input or opens an editor.
- If a line can't be run (no Git Bash, git unreadable, or another line still running), it's dropped with a reason and put back in the prompt box. It never goes to Claude.
- Git Bash is `CLAUDE_CODE_GIT_BASH_PATH` if that's set. Otherwise it's found from `git --exec-path` (on Windows), or plain `bash` elsewhere. If it can't be found, the line is dropped with a message and nothing runs.
- One line runs at a time. While it runs, the row shows `running <command>…`.
- When it finishes, a toast says `done` or `failed (exit N)`, or `did not finish — it may still be running` after the limit. The pane shows the command, the last 30 lines of output (plain text, capped), and the exit code. A failure opens the pane. Git state is read again afterwards, and once more 30 seconds later if the run didn't finish.

Messages are quoted for Git Bash, which is the shell these lines run in.

## Design

See [docs/DESIGN.md](docs/DESIGN.md).

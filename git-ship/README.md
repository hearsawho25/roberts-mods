# Git Ship

A Claude Code mod that shows the state of your git repo above the prompt. A `/ship` pane has buttons that fill ready-to-run `git` and `gh` commands into the prompt box. **It never runs a git write and never sends anything.** You read the command and press Enter yourself.

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
- after a `!` command you run, and once more 1.5 seconds later
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

Messages are quoted for Git Bash, which is the shell `!` commands run in on Windows.

## Design

See [docs/DESIGN.md](docs/DESIGN.md).

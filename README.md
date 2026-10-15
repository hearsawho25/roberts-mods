# roberts-mods

A small collection of Claude Code mods (hooks-module plugins), shared as a plugin marketplace. Use any of them, change them, pass them on: they're MIT-licensed.

## Install

```
claude plugin marketplace add hearsawho25/roberts-mods
claude plugin install <mod>@roberts-mods
```

Install as many as you like, then run `/reload-plugins` or start a new session.

## The mods

| Mod | Command | What it does |
|---|---|---|
| `roberts-toolbox` | `/toolbox` | One button at the end of the prompt hint line that opens a menu of your mods and the commands that change Claude Code. |
| `clean-view` | `/simple on\|off` | Hides tool calls, diffs and command output, and shows one plain-English checklist above the prompt instead. |
| `prompt-upgrade` | `/better` | Turns a rough prompt into a better one in a pane: up to three quick questions, a rewrite, and a side-by-side review before anything is sent. |
| `daily-challenge` | `/challenge` | One small Claude Code exercise a day, with a streak and a year of challenges that never repeat. |
| `work-report` | `/report` | Counts the tasks Claude finished for you and estimates the hours and dollars saved, by day, week, month and year. |
| `copy-blocks` | `/copyblock [n]` | A Copy button under every code block in Claude's replies, so you get clean text without the frame. |
| `relay` | `/relay`, `/handoff`, `/keepwarm` | A context and prompt-cache meter above the prompt, one-click handoffs to a fresh session, and cache warming with a cold-cache guard. See [relay/README.md](relay/README.md). |
| `git-ship` | `/ship` | Repo status above the prompt, and a pane whose buttons fill ready-to-run `git` and `gh` commands (commit messages and PRs drafted for you). It never runs a write: you press Enter. See [git-ship/README.md](git-ship/README.md). |

## Credits

Several of these started as other people's ideas, and they deserve the credit:

- **Clean View, Prompt Upgrade, Daily Challenge and Work Report** were built from prompts by Tristen O'Brien ([AI Made Easy](https://tristenobrien.ai/)). The ideas are Tristen's. These are my builds of them.
- **Robert's Toolbox** is based on a toolbox Tristen O'Brien showed in a video ([tristenobrien.ai](https://tristenobrien.ai/)).
- **Relay's** price table is adapted from [cache-tax](https://github.com/karanb192/cache-tax) by Karan Bansal (MIT License).
- **`patches/skins/`** holds copies of a file from [skins](https://github.com/hellosverre/claude-skins) by hellosverre (MIT License). See [patches/skins/LICENSE-skins.txt](patches/skins/LICENSE-skins.txt).

The mods themselves were built with Claude Code.

## License

[MIT](LICENSE), except the files in `patches/skins/`, which keep the skins license.

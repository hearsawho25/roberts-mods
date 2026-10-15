# Git Ship Pane Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the `git-ship` Claude Code mod described in `docs/DESIGN.md`. It shows a green repo-status row above the prompt and a `/ship` pane. The pane's buttons fill `!git …` and `!gh …` commands into the prompt box and never send them.

**Architecture:** `hooks/core.ts` holds the pure logic: parsing, enablement, command building, quoting, and drafting prompts. `hooks/register.tsx` holds every `$` call: refresh via `$.process.run`, the AbovePrompt row, the Pane, `/ship`, button handlers, and `$.model.fork` drafting. Shape, idioms and test harness all follow `D:\Projects\roberts-mods\relay` exactly.

**Tech Stack:** Claude Code hooks-module mod API (build 2.1.296), TypeScript/TSX with the `h` JSX factory, and the `claude-code/testing` harness.

---

## Ground rules for every task

- **Never run git commands of any kind.** This applies to the implementer, not to the mod's code, which runs read-only git through `$.process.run`.
- **API reference:** `C:/Users/kagek/AppData/Local/Temp/claude/bundled-skills/2.1.296/c693e801db464ba1acd72e0980158552/plugin-authoring/types/claude-code.d.ts`, about 14k lines. Grep it for the name at hand and read the declaration. Long-form guide: `reference.md` in the same skill folder. Worked examples are in that folder's `examples/` (`pane.tsx`, `band.tsx`).
- **Reference mod:** `D:\Projects\roberts-mods\relay`. Copy its patterns:
  - atoms, `read`/`update`
  - `sessionRoot($)` and `git($, root, args)` helpers
  - AbovePrompt hook calling `next(e)` and appending
  - test harness setup in `tests/relay.test.tsx`
- **Validator rules:**
  - every helper that takes `$` must be a top-level function in `register.tsx`
  - never pass `$` into an imported function
  - never read an atom imported from another file
  - pure logic may live in `core.ts`
- **Buttons:**
  - A plugin's own `$.command.run` called from a button skips its own command hooks, so button handlers call top-level functions directly.
  - Fill with `$.prompt.fill({ text, mode: 'replace' })`.
  - Never call `$.prompt.submit`.
- **Checks to run** (from Git Bash, `MSYS_NO_PATHCONV=1` not needed for these):
  - `claude plugin validate D:/Projects/roberts-mods/git-ship`
  - `claude plugin test D:/Projects/roberts-mods/git-ship`
  - `npx -y -p typescript@5 tsc -p C:/Users/kagek/.claude/jobs/04094503/tmp/git-ship-tsconfig.json`

---

### Task 1: Scaffold and pure core

**Files:**
- Create: `git-ship/.claude-plugin/plugin.json`
- Create: `git-ship/hooks/hooks.json`
- Create: `git-ship/hooks/core.ts`
- Create: `git-ship/hooks/register.tsx` (minimal stub, so the mod validates)
- Create: `git-ship/types/index.d.ts` (stub contract)
- Test: `git-ship/tests/core.test.ts`

- [ ] **Step 1: Manifests.**

`plugin.json`:
```json
{
  "name": "git-ship",
  "version": "0.1.0",
  "description": "Repo status row above the prompt and a /ship pane whose buttons fill ready-to-run git and gh commands — you press Enter.",
  "author": { "name": "Robert Horton" },
  "types": "./types/index.d.ts"
}
```
`hooks.json`: `{ "modules": ["./register.tsx"] }`

Stub `register.tsx`:
```tsx
import type { Register } from 'claude-code'
export const register: Register = () => {}
```

- [ ] **Step 2: Write `tests/core.test.ts`** (import `describe, expect, test` from `'claude-code/testing'`, as relay's `core.test.ts` does). Cover exactly these cases:

`parseStatus(text)`, where the input is `git status --porcelain=v2 --branch` output (non `-z`):
- Branch with upstream:
  ```
  # branch.oid 1a2b3c4d5e6f
  # branch.head main
  # branch.upstream origin/main
  # branch.ab +2 -1
  1 M. N... 100644 100644 100644 aaa bbb staged.ts
  1 .M N... 100644 100644 100644 aaa bbb unstaged file.ts
  2 R. N... 100644 100644 100644 aaa bbb R100 new.ts	old.ts
  ? untracked.txt
  ```
  Expected:
  - `branch: 'main'`, `sha: '1a2b3c4'`, `upstream: 'origin/main'`, `ahead: 2`, `behind: 1`
  - `files`: `[{xy:'M.',path:'staged.ts'},{xy:'.M',path:'unstaged file.ts'},{xy:'R.',path:'new.ts'},{xy:'??',path:'untracked.txt'}]`
  - `staged: 2`, `unstaged: 1`, `untracked: 1`
- Detached: `# branch.head (detached)` gives `branch: null`.
- No upstream: no `branch.upstream` or `branch.ab` lines gives `upstream: null`, `ahead: 0`, `behind: 0`.
- Unborn: `# branch.oid (initial)` gives `sha: null`.
- Unmerged `u UU N... …  conflict.ts` gives `{xy:'UU',path:'conflict.ts'}` and counts as unstaged.
- Ignored `!` lines are skipped.
- Empty input gives no files and all counts 0.

`rowText(state)`:
- `main · 3 changed · ↑2 ↓1`
- clean tree: `main · clean · ↑0 ↓0`
- no upstream: `feature/x · 1 changed · no upstream`
- detached: `detached 1a2b3c4 · clean · no upstream`

`buttonStates(state, { drafting, hasOpenPr })` returns `Record<ButtonId, boolean>`, where `ButtonId = 'stage'|'commit'|'push'|'pull'|'branch'|'pr'|'close'`:
- `stage`: `unstaged + untracked > 0`
- `commit`: `files.length > 0 && !drafting`
- `push`: `branch !== null && sha !== null && (ahead > 0 || upstream === null)`
- `pull`: `upstream !== null`
- `branch`: always true
- `pr`: `branch !== null && branch !== state.defaultBranch && upstream !== null && !drafting`
- `close`: always true

Test each rule with one true and one false case.

`bashQuote(s)`:
- `bashQuote('a "b" $c `d` \\e')` gives `"a \"b\" \$c \`d\` \\\\e"`. Assert the exact JS string `'"a \\"b\\" \\$c \\`d\\` \\\\e"'`.
- Newlines are kept.

Commands:
- `stageCommand()` gives `'!git add -A'`.
- `commitCommand('fix: x', 'body', false)` gives `'!git commit -m "fix: x" -m "body"'`.
- `commitCommand('fix: x', 'body', true)` gives `'!git add -A && git commit -m "fix: x" -m "body"'`.
- `commitCommand('', '', false)` gives `'!git commit -m ""'`. With an empty body, the second `-m` is omitted.
- `pushCommand(state)`: with an upstream it gives `'!git push'`. With no upstream on `feat` it gives `'!git push -u origin feat'`.
- `pullCommand()` gives `'!git pull'`.
- `branchCommand()` gives `'!git switch -c '`, with a trailing space.
- `prCreateCommand('T', 'B')` gives `'!gh pr create --title "T" --body "B"'`.
- `prViewCommand()` gives `'!gh pr view --web'`.

Drafting helpers:
- `capDiff(text, max = 40_000)` returns `{ text, isTruncated }`. When truncated, it cuts at `max` and appends `'\n… (diff truncated)'`.
- `COMMIT_TRAILER = 'Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>'`
- `PR_FOOTER = '🤖 Generated with [Claude Code](https://claude.com/claude-code)'`
- `withTrailer(body, trailer)`:
  - appends `\n\n` + trailer when the trailer is absent
  - returns `body` unchanged when it already ends with the trailer
  - returns just the trailer for an empty body
- `parseDraft(reply)` reads the model's reply in the format "subject line, blank line, body":
  - strips a surrounding ``` fence if present
  - trims the subject; if it is over 72 characters, cuts it to 72
  - body is the rest, trimmed
  - `parseDraft('')` gives `{ subject: '', body: '' }`
- `commitDraftPrompt({ diff, stat, recentSubjects })` returns a string containing the stat, the diff, the recent subjects, and the instruction: "Reply with only the commit message: one subject line of at most 72 characters in the same style as the recent subjects, a blank line, then a short body of what changed and why. No trailers, no code fences."
- `prDraftPrompt({ log, stat, branch, base })`: same idea. It asks for "a PR title line, a blank line, then a markdown body with a short summary and a bullet list of changes. No footer, no code fences."
- `parseDefaultBranch(out)`: `'origin/main\n'` gives `'main'`; `undefined` or `''` gives `null`.
- `parsePrView(json)`: `'{"number":4,"state":"OPEN"}'` gives `true`; `"MERGED"`/`"CLOSED"`, invalid JSON, or `undefined` give `false`.

- [ ] **Step 3: Run `claude plugin test D:/Projects/roberts-mods/git-ship`.** Expected: FAIL (`core.ts` exports missing).

- [ ] **Step 4: Implement `hooks/core.ts`** with these exact exports:
```ts
export type FileChange = { xy: string; path: string }
export type StatusFacts = {
  branch: string | null; sha: string | null; upstream: string | null
  ahead: number; behind: number; files: FileChange[]
  staged: number; unstaged: number; untracked: number
}
export type RepoState = StatusFacts & { root: string; lastCommit: string | null; defaultBranch: string }
export type ButtonId = 'stage' | 'commit' | 'push' | 'pull' | 'branch' | 'pr' | 'close'
export function parseStatus(text: string): StatusFacts
export function rowText(state: RepoState): string
export function buttonStates(state: RepoState, opts: { drafting: boolean; hasOpenPr: boolean | null }): Record<ButtonId, boolean>
export function bashQuote(s: string): string
export function stageCommand(): string
export function commitCommand(subject: string, body: string, stageFirst: boolean): string
export function pushCommand(state: RepoState): string
export function pullCommand(): string
export function branchCommand(): string
export function prCreateCommand(title: string, body: string): string
export function prViewCommand(): string
export const COMMIT_TRAILER: string
export const PR_FOOTER: string
export function capDiff(text: string, max?: number): { text: string; isTruncated: boolean }
export function withTrailer(body: string, trailer: string): string
export function parseDraft(reply: string): { subject: string; body: string }
export function commitDraftPrompt(i: { diff: string; stat: string; recentSubjects: string[] }): string
export function prDraftPrompt(i: { log: string; stat: string; branch: string; base: string }): string
export function parseDefaultBranch(out: string | undefined): string | null
export function parsePrView(json: string | undefined): boolean
```
Parsing notes:
- Type `1` lines: the path is everything after the 8th space-separated field.
- Type `2` lines: after the 9th field, then split on `\t` and take the first part, which is the new path.
- Type `u` lines: after the 10th field.
- Staged means X is not `.`; unstaged means Y is not `.`. Each `u` line counts as unstaged only.
- `sha` is the first 7 characters of `branch.oid`.

Also write a stub `types/index.d.ts` modelled on relay's, declaring `interface PluginState { 'git-ship': {} }` in the same module form relay uses. Task 2 fills it in.

- [ ] **Step 5: Run the tests, validate, and tsc.** All three must pass. No commit step: Robert commits himself.

---

### Task 2: Refresh, row, pane, /ship, fill buttons (no drafting yet)

**Files:**
- Modify: `git-ship/hooks/register.tsx`
- Modify: `git-ship/types/index.d.ts`
- Test: `git-ship/tests/ship.test.tsx`

Behaviour (DESIGN.md is the source of truth):

- **Atoms** (declared in `types/index.d.ts` under `'git-ship'`, as relay declares its own):
  - `repo: RepoState | null | 'error'`: `null` means not a repo or not read yet; `'error'` means git failed.
  - `paneOpen: boolean`
  - `drafting: boolean`
  - `hasOpenPr: boolean | null`
- **`refresh($)`**, top-level:
  - root = `$.session.root()`, as relay's `sessionRoot` gets it.
  - Run `git rev-parse --show-toplevel` with `timeoutMs: 5000`. A non-zero exit means not a repo, so `repo = null`.
  - Otherwise run `git --no-optional-locks status --porcelain=v2 --branch`, `git log -1 --format=%h %s` (empty output gives `lastCommit: null`), and `git symbolic-ref --short refs/remotes/origin/HEAD`.
  - The default branch comes from `parseDefaultBranch`. If that is null, use `'main'` when `git rev-parse --verify --quiet refs/heads/main` exits 0, then `'master'` the same way, else `'main'`.
  - If any status call fails to start or times out, `repo = 'error'`.
  - **Coalescing:** a module-level `runtime = { running: false, queued: false }`. If a refresh is running, set `queued` and return. When it finishes and `queued` is set, run once more.
- **Refresh triggers:**
  - `session.start`: also registers `/ship` with description "Open the Git Ship pane — repo status and ready-to-run git commands".
  - `turn.complete`: `await next(e)` first, then refresh, and return next's result.
  - `!` commands: `on('prompt.submit', …)`. If `e.text` starts with `!`, `await next(e)`, then refresh, and return the result. Otherwise return `next(e)` untouched. Check in the API types whether bash-mode `!` input reaches `prompt.submit` (grep `'!'`, `bash`, and `shell` near `PromptSubmitInput`). If the types show it does not, use the event the types name for it, and write down what you found in your report.
  - **Pane open:** refresh, then the PR check.
- **PR check** (pane open only):
  - Skip it when `buttonStates(...).pr` would be false ignoring drafting, meaning there's no branch, it's the default branch, or there's no upstream.
  - Otherwise run `gh pr view --json number,state` in root, `timeoutMs: 5000`, and set `hasOpenPr = parsePrView(stdout)`. A failure gives `false`.
- **Row:** `on('ui.render', { component: 'AbovePrompt' }, …)`.
  - Always `const base = await next(e)`.
  - If `repo` is null, return `base`. Otherwise return a Box column holding `base`, then the row, matching how relay composes the band.
  - Row: `◆ Ship` in bold green, two spaces, `rowText(repo)` dim, then `[ Open ]` (or `[ Close ]` when the pane is open). The button toggles the pane.
  - With `'error'`, the row is `◆ Ship  git unavailable` and has no button.
- **Pane:**
  - `$.ui.open({ id: 'git-ship', title: 'Git Ship' })` opens it. Close it with the matching API in the types (grep `ui.close` or `isPlaced`).
  - It is drawn by `on('ui.render', { component: 'Pane', requestId: 'git-ship' }, …)`.
  - Contents, in order:
    1. header line `<branch or detached sha> → <upstream or 'no upstream'>  ↑a ↓b`
    2. up to 10 file lines `  <xy>  <path>`, then `  +N more` when there are more than 10
    3. `last: <lastCommit>`, or `last: (no commits)`
    4. button row: `[ Stage all ] [ Draft commit ] [ Push ] [ Pull ] [ New branch ] [ PR ] [ Close ]`
  - Disabled buttons are drawn dim (`dimColor`), and their press handler returns without doing anything.
  - If the Button element has no disabled prop, use the guard in the handler; check the `Button` props in the types.
  - The PR button's label is `[ PR ]` either way. Its fill depends on `hasOpenPr`: `true` fills `prViewCommand()`. Otherwise, in Task 2, it fills `prCreateCommand('', '')`; Task 3 replaces that with drafting.
  - Draft commit in Task 2 fills `commitCommand('', '', staged === 0)`. Task 3 replaces it with drafting.
- **`/ship`:** `on('command.run', { name: 'ship' }, …)` toggles the pane (opening it refreshes) and returns `{ text: '' }` or whatever relay returns for a silent command. Look at relay's `command.run` handlers.
- **Fill helper:** `fill($, text)` is top-level. It calls `$.prompt.fill({ text, mode: 'replace' })`. When `isFilled` is not true, it toasts `Git Ship: could not fill the prompt box — <text>` so the command is still visible.

Tests in `tests/ship.test.tsx`: copy relay's harness approach. Mock:
- `session.start`
- `command.register`
- `session.root`, returning `'D:\\Projects\\app'`
- `process.run`, routed by `args`, returning canned stdout per git subcommand
- `prompt.fill`, recording the text and returning `{ isFilled: true }`

Cover:
1. Not a repo (`rev-parse` exit 128): the AbovePrompt output equals the base and has no Ship row.
2. A repo with 3 changes, ↑2 ↓0: the row text contains `main · 3 changed · ↑2 ↓0`.
3. git times out or throws: the row shows `git unavailable`.
4. `/ship` opens the pane, which lists files, shows `+N more` past 10, and shows the last commit.
5. Each button press fills the exact command:
   - Stage all → `!git add -A`
   - Push with no upstream → `!git push -u origin feat`
   - Pull → `!git pull`
   - New branch → `!git switch -c `
6. A disabled Push (ahead 0 with an upstream) fills nothing.
7. Nothing ever calls `prompt.submit`. Register a `prompt.submit` mock that records calls, and assert it is empty after every press.
8. `turn.complete` triggers a refresh: process.run is called again.
9. A `!git status` prompt triggers a refresh after `next`.
10. Two refreshes fired at once run status at most twice: coalescing.
11. PR check: on a feature branch with an upstream and gh returning `OPEN`, PR fills `!gh pr view --web`. On the default branch, gh is never called.

- [ ] Write the tests, run them, and see them fail.
- [ ] Implement.
- [ ] Run the tests, validate and tsc, and see all pass.

---

### Task 3: Drafting with `$.model.fork`

> **Superseded during the build:** drafting uses `$.model.complete` (sonnet, low effort, 60s timeout) instead of `$.model.fork`, drafts PRs against `origin/<base>`, and refuses to draft from an unreadable or empty diff. DESIGN.md is the source of truth.

**Files:**
- Modify: `git-ship/hooks/register.tsx`
- Test: `git-ship/tests/draft.test.tsx`

- First read how relay calls `$.model.fork` (grep `model.fork` in `relay/hooks/register.tsx`) and its result shape in the types (`isAnswered`, `reason`, the answer text). Use the same call shape. The draft must not touch the main conversation.
- **`draftCommit($)`**, top-level:
  1. If already `drafting`, return. Set `drafting = true` (the pane shows `drafting…` in place of the button row's first line; add that line to the pane).
  2. `stageFirst = repo.staged === 0`.
  3. Run `git diff --cached` and `git diff --cached --stat` when staged > 0. Otherwise run `git diff` and `git diff --stat`. Untracked files don't appear in `git diff`, so when `untracked > 0` and nothing is staged, append a line `Untracked files: a, b, c` (max 20 names) to the stat.
  4. `git log -5 --format=%s` gives the recent subjects.
  5. `capDiff`, then `commitDraftPrompt`, then `$.model.fork`, then `parseDraft`, then `withTrailer(body, COMMIT_TRAILER)`, then `fill($, commitCommand(subject, body, stageFirst))`.
  6. If the call isn't answered, throws, or returns an empty subject: `fill($, commitCommand('', '', stageFirst))` and toast `Git Ship: the draft failed — fill in the message yourself.`
  7. Always set `drafting = false` in `finally`.
- **`draftPr($)`**, same shape:
  - `base = repo.defaultBranch`
  - `git log <base>..HEAD --format=%s%n%n%b%n---` and `git diff --stat <base>...HEAD`
  - `prDraftPrompt`, then fork, then `parseDraft` (subject becomes the title), then `withTrailer(body, PR_FOOTER)`, then `fill($, prCreateCommand(title, body))`
  - On failure, fill `prCreateCommand('', '')` and toast.
- Wire the Draft commit button to `draftCommit`. Wire PR to `draftPr` when `hasOpenPr !== true`.

Tests in `tests/draft.test.tsx` (same harness, `model.fork` mocked):
1. Staged changes, and fork answers `fix: tidy row\n\nShorter label.`: fills `!git commit -m "fix: tidy row" -m "Shorter label.\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"`, with a real newline inside the quotes.
2. Nothing staged: the fill starts with `!git add -A && git commit`, and the diff passed to the fork came from `git diff`, not `--cached`.
3. A fork reply with `$` and a quote in the subject is escaped in the fill.
4. Fork not answered: fills `!git commit -m ""` and toasts.
5. A second press while drafting does nothing: one fork call.
6. PR: fork answers `Add ship pane\n\n- row\n- pane`: fills `!gh pr create --title "Add ship pane" --body "- row\n- pane\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)"`.
7. `prompt.submit` is never called.

- [ ] Write the tests, run them, and see them fail.
- [ ] Implement.
- [ ] Run the tests, validate and tsc, and see all pass.

---

### Task 4: Install (done by the controller, not a subagent)

- Add `{ "name": "git-ship", "source": "./git-ship" }` to `roberts-mods/.claude-plugin/marketplace.json`.
- Write `git-ship/README.md`: what it does, `/ship`, the button table, the fill-only rule, and that it's reached through the Toolbox. Add the mod to the root `README.md` list.
- `claude plugin install git-ship@roberts-mods --scope user`. Run the final validate, test and tsc.
- Robert runs `/reload-plugins`, then does a live check in roberts-mods (dirty tree) and Vernal, with screenshots.

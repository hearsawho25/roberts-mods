# Mod Doctor (`mod-doctor`) — design

Approved by Robert on 2026-10-15. Mod Doctor answers one question: **did my mods load?** It compares the mods that should have a hooks module running against the ones the engine actually loaded. For any mod that's missing or broken, it shows the reason taken from `claude plugin validate`.

## Rules

- **Quiet unless broken.** No row while every checked mod is fine. A red row appears only when at least one enabled mod didn't load or fails validation.
- **No hint-line button.** The pane is reached from the row's `[ Open ]`, from `/mod-doctor`, or from Robert's Toolbox, which runs the mod's first registered command. So `/mod-doctor` is registered first.
- **Shares the band.** The AbovePrompt hook always calls `next(e)` and appends its row, the same way Git Ship and Relay do.
- **Read-only.** It never edits, enables, disables or reinstalls anything. It only runs `claude plugin list --json` and `claude plugin validate <folder>`.
- **Never claims a mod is broken without evidence.** If a check can't run (the `claude` CLI is missing, it times out, or its JSON doesn't parse), the pane says `couldn't check: <reason>` and the row stays hidden.
- **Never polls on a timer.** No hook blocks on a check. Checks run after `next(e)` returns, fire-and-forget, with one check at a time.

## What the engine tells a mod (probed 2026-10-15, build 2.1.296)

A headless probe with a good mod and a deliberately broken mod showed:

- **`engine.create`:** `e.plugins` is the plain names of every hooks module in the load, e.g. `savvy-progress`, `relay`, `git-ship`. It also includes the built-ins `cc-plugin-agents-md`, `cc-plugin-telemetry` and `cc-plugin-you-should-know`. A module that fails to parse is **absent**.
- **`plugin.register`:** fires once for each module that joins after Mod Doctor, with `name`, `provenance` (`<name>@<marketplace>`, or `<name>@inline` for `--plugin-dir`), `root`, `version` and `uses.events`. A module that fails to parse never fires it. Mod Doctor sees only modules admitted *after* it.
- **When `engine.create` fires:** once per load or reload of Mod Doctor itself. At its own reload `e.plugins` is only `mod-doctor`, and at a refresh it holds only the added or changed modules. So the full list is only trustworthy from the first load in a session.
- **`$.command.list()`:** returns each command with a `plugin` field naming the mod that owns it.
- **`claude plugin validate <folder>`:** prints the exact load error, e.g. `does not parse: Expected ")" but found end of file (line 2, column 46)`, and exits non-zero.

**Found live on 2026-10-15:** `/reload-plugins` sends **no** `plugin.register` to an already-loaded Mod Doctor for the mods it loads, and it doesn't reload Mod Doctor either. A trace showed the same load id before and after, with no events in between. So a mod fixed and then reloaded stayed `✗` until two fixes went in:
- **Command evidence:** at each check, a mod that owns a bare-named plugin command (`challenge`, `ship`) counts as loaded, because only its hooks module's `$.command.register` makes such a command. Skill and manifest commands are namespaced (`skins:skin-designer`), so they don't count. A headless probe confirmed the naming.
- **Reload hook:** a `command.run` hook on `reload-plugins` awaits `next(e)` and then schedules the debounced check. This was confirmed live: the row cleared by itself about 2 s after `/reload-plugins`.

Still unverified: what a reload does to a mod that had loaded and is now broken on disk. It may keep the old copy or drop it. That's why Re-check validates every checked mod, not only the missing ones.

## The check

1. **Expected mods:** run `claude plugin list --json`.
   - Keep the entries with `enabled: true`.
   - Each entry's folder is `readFromFolder` if present, else `installPath`.
   - Read `<folder>/hooks/hooks.json`. A mod is **checked** if that file has a non-empty `modules` array.
   - Every other enabled plugin (skills, commands or classic hooks only) is counted as **skipped**.
   - Match by name: the part of `id` before `@`.
2. **Loaded mods:** the union of:
   - the `e.plugins` list from Mod Doctor's `engine.create`
   - every `plugin.register` name heard since
   - at each check, every plugin owning a bare-named command in `$.command.list()` (`commandOwners`)

   The list is kept in `$.state` so it survives Mod Doctor's own reloads. A load where `e.plugins` holds only `mod-doctor` adds nothing.
3. **Status per checked mod:**
   - `✓ loaded`: in the loaded set, and validate (when it was run) passed.
   - `✗ not loaded`: missing from the loaded set. Validate runs and its error lines are shown. If validate passes anyway, a detail line under it reads `validate passes; try /reload-plugins`.
   - `✗ broken on disk`: in the loaded set but validate now fails, for example after an edit. This is only found by Re-check.
   - `⚠ version drift`: an extra mark on a `✓` or `✗` mod when `readFromFolder` is set and `folderVersion` ≠ `version`.
4. **Extra loaded modules:** loaded modules that aren't in the plugin list are ignored. That covers `cc-plugin-*` built-ins and `--plugin-dir` mods. The exception is a `plugin.register` provenance ending in `@inline`, which is listed as `✓ <name>  dev folder`.
5. **When validate runs:**
   - for every `✗ not loaded` mod on every check
   - for **every** checked mod on Re-check

   It runs four at a time with a 30 s timeout each.
6. **Validate output parsing:** take the lines that begin with `❯` after a `✘ Found N error(s)` line, at most three per mod. Strip the leading `modules<path>: <name>: ` prefix, and shorten absolute paths under the mod's folder to paths relative to it. Warnings, such as a missing author, are ignored.

## When it checks

- `session.start`, after `next(e)`. It does not block start-up.
- After `plugin.register` fires, and after `/reload-plugins` finishes. Both are debounced by 2 s, so a reload of several mods causes one check.
- On pane open, and from the Re-check button (the full validate).

Only one check runs at a time. A request made while one is running queues a single follow-up.

## Presence

- **Row** (only when there's at least one `✗`), red (`#F85149`) on Toolbox's palette. Its wording follows the kind of problem:
  - all not loaded: `✗ Mod Doctor  1 mod didn't load: relay`, or `3 mods didn't load: relay, git-ship +1`
  - all broken on disk: `✗ Mod Doctor  1 mod is broken: relay`, or `2 mods are broken: relay, git-ship`
  - a mix: `✗ Mod Doctor  3 mods have problems: relay, git-ship +1`
  - Its button toggles like Git Ship's: `[ Open ]` while the pane is closed, `[ Close ]` while it's open. A press decides from the engine's own list of open panes (`$.ui.panes()`), so a pane the person closed opens again.
- **Toast:** once per mod and reason per session: `Mod Doctor: relay didn't load — /mod-doctor for why`, or for a mod broken on disk `Mod Doctor: relay is broken on disk — /mod-doctor for why`.
- **Pane** (`/mod-doctor`, id `mod-doctor`, title `Mod Doctor`):
  - header `Checked 12:41 · 11 mods · 1 problem` (or `checking…`)
  - one line per checked mod, failures first, then by name:
    - `✓ git-ship  0.1.0  · /ship`. These are its commands from `$.command.list()`. It shows at most 3, then `+N`. If that line would be wider than the pane (`bodyColumns`), it shows one command and `+N` instead, so it doesn't wrap. Copy report always lists up to 3.
    - `✗ relay  not loaded` (or `broken on disk`), followed by up to 3 indented error lines
    - Below a mod's line come indented detail lines: its notes (`validate passes; try /reload-plugins` or `couldn't validate: <reason>`), then drift (`⚠ folder is 0.2.0, on record 0.1.0`)
  - footer `9 skipped (no hooks module)`
  - buttons `Re-check`, `Copy report` and `Close`, wrapped with `flexWrap`
- **Copy report** puts a plain-text version of the pane on the clipboard (`$.ui.copy`), ready to paste to Claude.
- **Colours:** Toolbox's palette, `COLORS` in `roberts-toolbox/hooks/register.tsx`, plus red `#F85149` for failures. Green is `✓` and gold is `⚠`.

## Code layout

- `hooks/core.ts`: pure logic, no `$`.
  - `parsePluginList(json)` gives the expected entries.
  - `hasHooksModule(hooksJsonText)`
  - `mergeLoaded(prev, plugins)` (self is the `SELF` constant)
  - `diagnose(expected, loaded, validations)` builds the report.
  - `parseValidate(stdout, root)` gives error lines.
  - `rowText(report)`, `paneLines(report)`, `reportText(report)` and `toastKey`.
- `hooks/register.tsx`: all the `$` code.
  - The hooks: `engine.create`, `plugin.register`, `session.start`, `command.run` and `ui.render` (AbovePrompt and the Pane).
  - Top-level `$`-taking helpers: `runCheck($, { full })`, `runClaude($, args, timeoutMs)` and `openPane($)`.
- `types/index.d.ts`: the `PluginState` contract. The values are `loaded: string[]`, `inline: string[]`, `report: Report | null`, `checking: boolean` and `toasted: string[]`.
- `tests/`: `core.test.ts`, plus `doctor.test.tsx` for the hooks with `$.process` stubbed.
- `README.md` and an entry in the root README and `.claude-plugin/marketplace.json`.

## Finding the `claude` CLI

Run it through `$.process.run` as `claude`, which is on PATH on Robert's machine. If that fails to start, the result is `couldn't check: claude CLI not found`. The JSON is parsed defensively: unknown fields are ignored, and entries missing `id` are skipped.

## Live checks after build

1. A normal session start shows no row, and `/mod-doctor` lists every Robert mod as `✓`.
2. Add a stray `(` to the end of `daily-challenge/hooks/register.tsx` and start a new session. Mod Doctor should show the red row, a toast, and `✗ daily-challenge` with the parse error. Then revert the file. A `--plugin-dir` mod can't be used for this, because it isn't in `claude plugin list`, so it's never expected.
3. Fix the broken mod and run `/reload-plugins`. The row clears by itself about 2 s later. Passed 2026-10-15.
4. Still to try: break a mod that already loaded, run `/reload-plugins`, then Re-check, and fill in the unverified point above.

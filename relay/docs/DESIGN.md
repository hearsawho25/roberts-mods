# Relay — design and build plan (approved 2026-10-14)

Relay is one Claude Code mod that does three jobs:
1. a always-visible meter row above the prompt (context fill + prompt-cache state + a Handoff button),
2. handoffs: write a handoff prompt for a fresh session, `/clear`, and put the handoff in the prompt box; offer unused handoffs in later sessions in the same project,
3. cache warming and a cold-cache guard (replaces the third-party cache-tax mod).

Owner: Robert. Lives at `roberts-mods/relay`, installed at user scope from the local `roberts-mods` marketplace, default ON in every session and project.

## API facts (this build, 2.1.296)

Types: `claude-code.d.ts` in the plugin-authoring skill, which Claude Code unpacks under its temp folder at `.../bundled-skills/<version>/<id>/plugin-authoring/types/` (grep it; ~21k lines). Skill docs: same folder's `../SKILL.md` is not readable; read `reference.md` and `examples/` in `.../plugin-authoring/`.

- `$.session.usage()` → `{ startedAt, context: SessionContextUsage, rateLimits, cost }`. `session.measure` event fires after each main-thread turn with the same figures (pushed).
- `$.session.compact()`, `$.command.run({ command: 'clear' })` runs `/clear` as if typed (queued until idle).
- `session.start` does NOT fire on `/clear`; `classic.SessionStart` with `source: 'clear' | 'startup' | 'resume' | 'compact'` does. Resume carries `seconds_since_last_response`, `context_tokens`, `prompt_cache_likely_expired`, `estimated_cache_write_usd`.
- `$.prompt.fill({ text, mode: 'replace' })` puts text in the prompt box (not sent). `$.prompt.submit` sends.
- `$.model.fork({ prompt })` = one tool-less completion over the session's own transcript; reads the cached prefix (cheap while warm). `reason: 'nothing-to-fork'` before first response / after `/clear`. Result `usage` has `cache_read_input_tokens` / `cache_creation_input_tokens`.
- `$.clock.now/after/every/sleep`, `$.store.get/set/delete` (persists across sessions), `$.state` atoms (session), `$.fs.read/write/list` (absolute paths ok), `$.process.run(argv, { cwd })` (no shell), `$.env.get`, `$.ui.status/toast/open/resolve`, clipboard write on the ui noun (grep "clipboard").
- Band: `on('ui.render', { component: 'AbovePrompt' }, hook)`. **Always call `next(e)` and append Relay's row to what it returns** — other mods (Clean View, Robert's Toolbox menu, others) share this band. Never return a tree without `next`.
- Validator gotcha: helpers that take `$` must be declared at the top level of the file.
- Reference implementation for warming / cold guard: cache-tax at `~/.claude/plugins/cache/claude-code-mods/cache-tax/2.2.1/hooks/register.ts` (MIT; read its LICENSE; keep an attribution comment for anything adapted, e.g. its price table).
- House style to match: `roberts-mods/clean-view` (hooks/register.tsx, a pure-logic module beside it, tests in `tests/*.test.tsx` using `claude-code/testing` with `mock.clock`, `mock.store`).
- Robert's rules for his mods: no hint-line (PromptHint) button of its own — mods are reached through Robert's Toolbox (it auto-lists every mod folder in roberts-mods and its Open chip runs the mod's first registered command, so register `/relay` first). Buttons inside the AbovePrompt row are fine.

## Behaviour

### Meter row (always shown in interactive sessions while Relay is on)
```
◆ Relay   ctx ▰▰▰▰▰▱▱▱ 58% · 231k   cache ● warm · 41m left        [ Handoff ]
```
- Gold accent matching Robert's Toolbox (read its COLORS in `roberts-toolbox/hooks/register.tsx`).
- Context: percent and token count from usage. Meter 10 cells.
- Cache state from a one-hour clock since the last main-thread response: `warm` (green, >10 min left), `cooling` (amber, ≤10 min left), `cold` (grey, >60 min), `unknown` (before first response / right after compaction or /clear). Label text always present so colour is never the only signal.
- While warming is armed, append `· warming · next ping 12m`.
- Narrow terminals: drop the meter bar first, then the "left" text; the Handoff button always stays.

### Handoff threshold prompt
- Trigger when context ≥ 80% OR context tokens ≥ 300,000, whichever first (check after each turn via `session.measure`/usage).
- Row turns amber: `Context is at 81% (322k). Hand off and start fresh?  [ Handoff now ]  [ Not yet ]`.
- "Not yet" snoozes until 90% (or 400k tokens); after that it reappears and stays until handled. Per session.
- Note: verify whether `context.percent` is relative to the auto-compact window; if the engine exposes the window/auto-compact numbers, compute percent of the full model window and document what you found.

### Handoff flow (button, `/handoff`, threshold prompt, cold prompt)
1. Gather git facts with read-only `$.process.run` in the session root: branch (`git rev-parse --abbrev-ref HEAD`), HEAD short sha + subject (`git log -1 --format=%h %s`), ahead/behind upstream (`git rev-list --left-right --count @{u}...HEAD`, tolerate no upstream), uncommitted files (`git status --porcelain`, count + first 10). Not a repo → skip. Never any write git command.
2. `$.model.fork({ prompt: HANDOFF_PROMPT + facts })`. HANDOFF_PROMPT asks for Robert's brief layout: a one-line title; `## Where things stand` (include the git facts verbatim); `## Read first` (files/docs/memory files); `## What's next`; `## Hard rules` (copy every user-stated constraint verbatim, quoted); `## How to run it` (method, e.g. subagent-driven, stop points). Plain text, no preamble.
   - If fork returns `nothing-to-fork` or an error: toast the reason and stop.
   - If the cache is cold, first show the estimated re-write cost and require a second click.
3. Preview pane (`$.ui.open`, id `relay-handoff`) showing the text with buttons `[ Clear & continue ]  [ Copy ]  [ Cancel ]`. (Editing happens in the prompt box after Clear & continue, since nothing is sent until Enter.)
4. Save: `~/.claude/handoffs/<project-key>/<YYYY-MM-DD-HHmmss>-<slug>.md` (home from `USERPROFILE` or `HOME`; project-key = session root with `:\/ ` replaced by `-`), and an index record in `$.store` key `relay.handoffs` → `{ id, projectKey, root, title, path, createdAt, consumedAt? }[]`, newest first, capped at 50.
5. Clear & continue: copy to clipboard, mark consumed, `$.command.run({ command: 'clear' })`, then on the following `classic.SessionStart` with `source: 'clear'` (or right after `run` resolves, whichever the engine supports — test it), `$.prompt.fill({ text, mode: 'replace' })`. Never auto-submit.
6. Copy: clipboard + toast. Cancel: close; the handoff stays saved as unconsumed.

### Pending handoff offer
- At `classic.SessionStart` source `startup` (and `clear` when not already filling), if the store has an unconsumed handoff for this project-key created within 7 days, show a row: `Handoff waiting: "<title>" · from 10h ago   [ Load ]  [ Dismiss ]`.
- Load → fill prompt box, mark consumed. Dismiss → mark consumed. Older than 7 days → ignored (still listed in `/handoff list`).

### Warming
- After each main-thread turn completes, arm (or extend) an idle window of 2 hours from now. When 50 idle minutes pass with no new turn, send one `$.model.fork` ping with a tiny prompt and `maxTokens`-style cap if the API has one. Repeat every 50 idle minutes until the window ends.
- Stop warming (and say why on the row) if a ping shows `cache_read_input_tokens === 0` or writes ≥ 10% of reads (cache wasn't being reused), on any error, or when `/keepwarm off`.
- Skip warming entirely for sessions whose context is < 50,000 tokens.
- **Final ping writes the handoff**: when the window's last ping is due, instead of a plain ping, run the handoff fork (steps 1–2 and 4 above, no pane, no clear) and save it as an unconsumed handoff; toast/log "Relay saved a handoff before the cache cooled". Then let the cache go cold. Opt-out: `/relay overnight off` (store key `relay.settings.overnightHandoff`, default true).
- `/keepwarm 90m|2h|off|status` manual control (durations like cache-tax: `90m`, `2h30m`, `6h`, max 12h).

### Cold-cache guard
- On `prompt.submit` of a typed, non-slash prompt when the cache is cold and context ≥ 50,000 tokens: hold it once (return without sending — see how cache-tax drops it) and show on the row: `Cache went cold 9h ago. Sending this re-writes ~240k tokens (≈ $4.80).  [ Handoff & start fresh ]  [ Send anyway ]`. Send anyway → `$.prompt.submit` the held text (marked so the guard lets it through). Handoff & start fresh → handoff flow (with the cold-cost confirmation already satisfied), and keep the held text in the store so it can be appended to the filled prompt after the clear.
- Resumed sessions: use `classic.SessionStart` resume fields (`seconds_since_last_response`, `context_tokens`, `estimated_cache_write_usd`) for the clock and estimate.
- Price estimate: per-model cache-write price per MTok (adapt cache-tax's price table with attribution); unknown model → show tokens only.

### Commands
- `/relay` (register first) — status card: context, cache state, warming window, last ping receipt, overnight setting, pending handoffs for this project.
- `/relay on|off` — global toggle, store key `relay.settings.enabled`, default true. Off = no row, no warming, no guard.
- `/relay overnight on|off`.
- `/handoff` — start the handoff flow. `/handoff list` — last 20 handoffs (all projects, this project first), with path and consumed state.
- `/keepwarm …` as above.

## Files
```
relay/
  .claude-plugin/plugin.json      { name: "relay", version: "0.1.0", description, types: "./types/index.d.ts" }
  hooks/hooks.json                { "modules": ["./register.tsx"] }
  hooks/register.tsx              hooks, wiring, rendering
  hooks/core.ts                   pure logic (no $): thresholds, cache clock, durations, slug/paths, prompt text, price table, git-output parsing
  hooks/warming.ts                pure warming/guard decisions (no $); the validator follows $ and atoms only inside register.tsx, so all $ glue lives there
  types/index.d.ts                PluginState contract for $.state atoms
  tests/core.test.ts              unit tests for core.ts
  tests/relay.test.tsx            engine-level tests (claude-code/testing)
  tests/handoff.test.tsx          handoff flow engine tests
  tests/warming.test.tsx          warming, overnight handoff, cold guard (engine + pure)
  README.md                       short: what it does, commands, uninstall
```

## Checks for every task
- `claude plugin validate relay`
- type-check: `tsc -p relay` once `.claude-plugin/types/` exists; before that, a tsconfig kept OUTSIDE the mod folder (in a scratch folder) whose `include` names the types file and the mod's hooks — see the header of the types file.
- `claude plugin test relay`
- Never run git. Repo files: use Edit/Write (no PowerShell Get/Set-Content).

## Tasks
1. Scaffold + `core.ts` + `tests/core.test.ts` (all pure logic listed above).
2. Meter row + threshold prompt + `/relay` commands + store settings (register.tsx), with engine tests.
3. Handoff flow + preview pane + save/index + clear-and-fill + pending offer + `/handoff`, with engine tests.
4. Warming + overnight handoff + cold guard + `/keepwarm`, with engine tests.
5. Final cross-task review; README.

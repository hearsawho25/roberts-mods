# Relay

A Claude Code mod with three jobs:

1. **A meter row** above the prompt, showing how full the context is, whether the prompt cache is warm, and a Handoff button.
2. **Handoffs.** Relay writes a brief for a fresh session, runs `/clear`, and puts the brief in the prompt box. A handoff you never used is offered in later sessions in the same project.
3. **Cache warming and a cold-cache guard.** These replace the cache-tax mod.

## The row

```
◆ Relay   ctx ▰▰▰▰▰▱▱▱ 58% · 231k   cache ● warm · 41m left · warming · next ping 12m   [ Handoff ]
```

- **Cache state** is counted from the last main-thread request (the cache lasts one hour):
  - `warm`: more than 10 minutes left
  - `cooling`: 10 minutes or less left
  - `cold`: past the hour
  - `unknown`: no reply yet, or just after `/clear` or compaction
- **Warming** adds `· warming · next ping 12m` while a window is armed. Once warming stops it shows `· warming stopped: <reason>` until the next reply.
- **On a narrow terminal** the meter bar goes first, then the time left, then the warming text. The button always stays.

The row changes for these situations:

| Situation | Row |
|---|---|
| Context at 80% or 300k tokens | `Context is at 81% (322k). Hand off and start fresh?  [ Handoff now ]  [ Not yet ]`. "Not yet" waits until 90% or 400k. |
| Handoff asked for while the cache is cold | `Cache is cold — writing the handoff re-writes ~240k tokens (≈ $2.40).  [ Write it anyway ]  [ Cancel ]` |
| A typed prompt held by the cold guard | `Cache went cold 9h ago. Sending this re-writes ~240k tokens (≈ $4.80).  [ Handoff & start fresh ]  [ Send anyway ]` |
| A handoff written earlier and never used (within 7 days) | An extra line above the row: `Handoff waiting: "<title>" · from 10h ago  [ Load ]  [ Dismiss ]` |
| A handoff being written | `◆ Relay   Writing handoff…` |

## Handoffs

**Start one** with the Handoff button, "Handoff now", or `/handoff`.

**What Relay does:**
1. Gathers git facts with read-only commands: branch, HEAD, ahead/behind, and uncommitted files.
2. Asks the session itself, through a fork, for a brief with these parts: title, Where things stand, Read first, What's next, Hard rules, How to run it.
3. Saves the brief and opens a pane with three buttons:
   - **Clear & continue** copies the brief, runs `/clear`, and fills the prompt box. Nothing is sent until you press Enter.
   - **Copy** puts the brief on the clipboard.
   - **Cancel** closes the pane. The handoff stays saved and is offered later.

## Warming and the overnight handoff

**When a window is armed.** After each reply, a session with at least 50k tokens of context gets a 2-hour warming window.

**Pings.** After 50 idle minutes Relay sends one tiny fork ("Reply with the single word: warm"). This reads the cache, which keeps it alive for another hour. Pings repeat every 50 idle minutes until the window ends. A new reply moves the next ping, and nothing is sent while a turn runs.

**Warming stops** in any of these cases:
- a ping read nothing
- a ping wrote 10% or more of what it read
- a ping failed
- the window ended
- `/keepwarm off`
- Relay is switched off

**The overnight handoff.** When the next ping would fall after the window ends, the last ping writes a handoff instead. It is saved unused, with no pane and no clear. Relay toasts "Relay saved a handoff before the cache cooled: <title>" and then lets the cache go cold. The handoff is skipped if one was already saved since the last reply. A `/keepwarm` window shorter than the first ping gets its handoff when the window ends, provided the cache is still warm. Turn this off with `/relay overnight off`.

## The cold-cache guard

**What it holds.** When the cache is cold and context is at least 50k tokens, the guard holds the first prompt you type, once per cold spell, and shows the cost estimate on the row.

**What it never holds:**
- slash commands
- `!` bash input
- prompts typed while a turn runs
- prompts with attachments, `@` mentions, or context added by a hook
- prompts from plugins, peers, or schedules

**Your choices once a prompt is held:**
- **Send anyway** sends the held text as your own words.
- **Handoff & start fresh** writes the handoff without asking about the cold cost. The held text goes below the handoff after the clear.
- **Send it again yourself.** Typing and sending a second time also lets it through.

**Held text is never lost.** If the handoff fails or is cancelled, a reply arrives, you `/clear`, or Relay is switched off, the held text goes back into the prompt box with "Your held message is back in the prompt box."

**The cost estimate** uses the model's 1-hour cache-write price. For a resumed session it uses the engine's own `estimated_cache_write_usd`. When the model's price is unknown it shows tokens only.

## Commands

| Command | Does |
|---|---|
| `/relay` | Status card: context, cache, handoff threshold, warming (window, next ping, last ping cost, overnight setting), and waiting handoffs. |
| `/relay on` / `/relay off` | Global switch (default on). Off means no row, no warming and no guard. Other sessions pick it up at their next turn or ping. |
| `/relay overnight on` / `off` | The overnight handoff (default on). |
| `/handoff` | Write a handoff now. |
| `/handoff list` | The last 20 handoffs, this project's first, with path and whether each was used. |
| `/keepwarm 90m` / `2h` / `2h30m` | Warm for that window, from now (max 12h). |
| `/keepwarm off` | Stop warming for this session. Replies no longer arm a window until `/keepwarm <duration>`. |
| `/keepwarm` or `/keepwarm status` | The warming line. |

## Where things are kept

**Handoff files:** `~/.claude/handoffs/<project-key>/<YYYY-MM-DD-HHmmss>-<slug>.md`. The project key is the session root with `:`, `\`, `/` and spaces turned into `-`.

**Store keys** (in the mod's own store):

| Key | Holds |
|---|---|
| `relay.settings.enabled` | The global on/off switch. |
| `relay.settings.overnightHandoff` | The overnight handoff setting. |
| `relay.handoffs` | The handoff index, newest first, capped at 50. |
| `relay.fillAfterClear` | What to put in the prompt box once `/clear` has run. Kept for 10 minutes. |
| `relay.warming.<session id>` | This session's warming window. |
| `relay.heldText.<session id>` | A prompt the guard is holding. |

At each session start, Relay removes warming records whose window has passed, `/keepwarm off` flags older than 3 days, and held prompts older than 7 days.

## Uninstall

```
claude plugin uninstall relay@roberts-mods
```

Handoff files in `~/.claude/handoffs` stay until you delete them.

## Credits

The warming loop, its stop rules, the hold-once cold guard, the duration parser and the price table are adapted from the cache-tax mod (MIT License, Copyright (c) 2026 Karan Bansal).

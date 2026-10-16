# Mod Doctor

A Claude Code mod that answers one question: **did my mods load?**

It compares two lists:
- every enabled plugin that ships a hooks module
- the hooks modules Claude Code actually loaded

If a mod is missing or broken, Mod Doctor shows why, using the error from `claude plugin validate`. It stays quiet while everything is fine.

## Install

```
claude plugin marketplace add hearsawho25/roberts-mods
claude plugin install mod-doctor@roberts-mods
```

## The row

There is no row while every mod is fine. If an enabled mod didn't load, a red line appears above the prompt:

```
✗ Mod Doctor  1 mod didn't load: relay  [ Open ]
```

A mod that loaded but now fails validation reads `1 mod is broken: relay`, and a mix of both reads `N mods have problems`. The button reads `[ Close ]` while the pane is open. You also get one toast per problem per session.

## The pane

Open it with the row's `[ Open ]`, with `/mod-doctor`, or from Robert's Toolbox. It shows:

```
Checked 12:41 · 11 mods · 1 problem
✗ relay  not loaded
    hooks\register.tsx does not parse: Expected ")" but found end of file (line 2, column 46)
✓ git-ship  0.1.0  · /ship
    ⚠ folder is 0.2.0, on record 0.1.0
✓ clean-view  0.1.0  · /simple
9 skipped (no hooks module)
```

What the marks mean:

- **`✗ not loaded`**: the mod is enabled, but Claude Code didn't load its hooks module. The indented lines are validate's errors. If validate passes anyway, the line says to try `/reload-plugins`.
- **`✗ broken on disk`**: the mod loaded, but its files fail validation now, for example after an edit. Only **Re-check** finds this.
- **`⚠ folder is X, on record Y`**: the mod is read from a folder whose version differs from the installed one.
- **Skipped**: enabled plugins with no hooks module (skills, commands or classic hooks only). Nothing loads for them, so there is nothing to check.

The buttons:

| Button | What it does |
|---|---|
| Re-check | Runs `claude plugin validate` on every checked mod, not just missing ones |
| Copy report | Copies the pane as plain text, ready to paste to Claude |
| Close | Closes the pane |

## When it checks

Mod Doctor checks at these times:
- when the session starts
- 2 seconds after `/reload-plugins` finishes, so a mod you fixed and reloaded clears the row by itself
- when you open the pane
- when you press Re-check

It never polls on a timer, and it never holds up start-up. A whole check gives up after 90 seconds, and each `claude` call after 30 seconds.

## What it never does

It is read-only. It runs only `claude plugin list --json` and `claude plugin validate <folder>`. It never enables, disables, edits or reinstalls anything. If a check can't run (for example, the `claude` CLI isn't found), the pane says `couldn't check: <reason>` and the row stays hidden. It never guesses that a mod is broken.

Design notes: [docs/DESIGN.md](docs/DESIGN.md).

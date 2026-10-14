# Local patch to the skins mod (hellosverre-mods)

**What:** on the terminal, skins puts each code block's Copy button on the frame's top border, where Windows Terminal draws nothing. This patch moves the button to its own row under the frame.

**Patched file:** `~/.claude/plugins/cache/hellosverre-mods/skins/<version>/hooks/code-rows.tsx` (the installed copy). The git clone in `plugins/marketplaces/` is left untouched so `git pull` stays clean.

**After a skins update** the patch is gone (the update installs a new version folder). To reapply: open the new `code-rows.tsx`, find the `<Box position="absolute" top={-1} right={1}>{control}</Box>` block inside the frame, and move it below the frame's closing `</Box>` as `<Box flexDirection="row" justifyContent="flex-end">{control}</Box>`. Or ask Claude: "reapply my skins Copy patch". Skip it if the update fixed the bug.

**Undo:** copy `code-rows.0.5.4.original.tsx` back over the installed file, then `/reload-plugins`.

Files here: the original, the patched copy, and `bug-report.md` (posted as issue #54).

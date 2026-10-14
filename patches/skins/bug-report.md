# POSTED 2026-10-13: https://github.com/hellosverre/claude-skins/issues/54

**Title:** Code block Copy button and language label don't render on the frame border (Windows Terminal)

**What happens**
With `highlight` on, a fenced code block in a reply draws as a rounded frame with highlighted lines, but the top border is empty. The language label (` powershell `) and the ` Copy ` button that `codeRows` lays over the border with `position="absolute" top={-1}` don't show up at all. So there's no way to click Copy on a block. The whole-reply `copy reply` button below the reply does show.

With `/skin highlight off`, the block falls back to `<Markdown>` + `copyRow`, and the Copy button under it shows and works.

**Expected**
The language label and Copy button visible on the frame's top border.

**Environment**
- skins 0.5.4 (marketplace commit 1953c83)
- Claude Code 2.1.296
- Windows 11 Pro 10.0.26200, Windows Terminal, main screen (not fullscreen)

**Repro**
1. `/skin highlight on`
2. Ask Claude for a reply containing a fenced block, e.g. ```` ```powershell ```` with a few lines.
3. The frame's top border is plain: no label, no Copy.

**Likely cause**
The absolute children at `top={-1}` in `hooks/code-rows.tsx` (and probably the table frame's control in `hooks/rows.tsx`, same pattern) aren't painted over the border on this terminal/build.

**Workaround I'm using locally**
Copy drawn as its own right-aligned row under the frame instead of on the border:

```tsx
      </Box>
      {control === undefined ? '' : (
        <Box flexDirection="row" justifyContent="flex-end">{control}</Box>
      )}
      {foldButton(look, foldKey, lines.length, FOLD_CODE)}
```

Happy to test a fix. Thanks for skins, the highlighting really helps code blocks stand out.

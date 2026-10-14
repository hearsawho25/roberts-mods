import type { EngineInterface, Register, RenderSurface } from 'claude-code'

import { describeBlock, parseIndex, pickBlock, splitAfterBlocks } from './blocks'

const COMMAND = 'copyblock'

/** Puts a block's text on the clipboard and says how it went in a toast. */
async function copyText($: EngineInterface, text: string, what: string, surface?: RenderSurface): Promise<boolean> {
  const copied = await $.ui.copy(surface === undefined ? { text } : { text, surface }).catch(() => ({ isCopied: false as const }))
  $.ui.toast(copied.isCopied ? `Copied ${what}` : 'Could not reach the clipboard')
  return copied.isCopied
}

export const register: Register = on => {
  // Registered first so Robert's Toolbox "Open" chip runs it.
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: COMMAND,
      description: 'Copy a code block from my replies, clean (no box): /copyblock = last, /copyblock 2 = the one before',
    })
    return next(e)
  })

  on('command.run', { command: COMMAND }, async ($, e) => {
    const n = parseIndex(e.args)
    if (n === undefined) return { text: 'Usage: /copyblock (the last block) or /copyblock 2 (the one before it), and so on.' }
    const messages = await $.session.messages()
    const replies = messages.filter(m => m.role === 'assistant').map(m => m.text)
    const block = pickBlock(replies, n)
    if (block === undefined) return { text: n === 1 ? 'No code blocks in this conversation yet.' : `There aren't ${n} code blocks in this conversation yet.` }
    const ok = await copyText($, block.text, describeBlock(block))
    return { text: ok ? `Copied block ${n === 1 ? '(the last one)' : `#${n} from the end`}: ${describeBlock(block)}.` : 'Could not reach the clipboard.' }
  })

  // Draws the reply as Claude Code does, a piece at a time, with a Copy button under each finished block.
  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    if (e.props.isSummary === true) return next(e)
    const pieces = splitAfterBlocks(e.props.text)
    if (!pieces.some(piece => piece.block?.isClosed === true)) return next(e)

    const { Box, Button } = $.ui.resolve(e)
    const rows = []
    for (const [i, piece] of pieces.entries()) {
      rows.push(await next({ ...e, props: { ...e.props, text: piece.text, isFirstOfReply: e.props.isFirstOfReply && i === 0 } }))
      const block = piece.block
      if (block?.isClosed === true) {
        rows.push(
          <Box key={`copy-row-${i}`} marginLeft={2}>
            <Button key={`copy-${i}`} label="⧉ Copy" onPress={press => void copyText($, block.text, describeBlock(block), press.surface)} />
          </Box>,
        )
      }
    }
    return <Box key="copy-blocks" flexDirection="column">{rows}</Box>
  })
}

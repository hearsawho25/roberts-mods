import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { findBlocks, parseIndex, pickBlock, splitAfterBlocks } from '../hooks/blocks'

const PLUGIN = 'copy-blocks'
const REPLY = [
  'Run this:',
  '',
  '```powershell',
  'Get-ChildItem -Path "C:\\Users\\robert\\a very long folder name that would wrap on a narrow terminal" -Recurse',
  '  indented line',
  '```',
  '',
  'Then this config:',
  '',
  '~~~json',
  '{ "a": 1 }',
  '~~~',
  '',
  'Done.',
].join('\n')

/** Stands in for the engine: draws a reply piece as one Text holding its markdown, and records copies and toasts. */
function engine(on: On, replies: string[] = [REPLY]) {
  const seen = { copies: [] as string[], toasts: [] as string[], drawn: [] as { text: string; isFirst: boolean }[] }
  mock.store(on)
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('ui.toast', ($, e) => {
    seen.toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.copy', ($, e) => {
    seen.copies.push(e.text)
    return { value: { isCopied: true } }
  })
  on('session.messages', () => ({
    value: replies.flatMap(text => [
      { role: 'user' as const, text: 'hi', toolUses: [] },
      { role: 'assistant' as const, text, toolUses: [] },
    ]),
  }) as never)
  on('ui.render', { component: 'AssistantMessage' }, ($, e) => {
    seen.drawn.push({ text: e.props.text, isFirst: e.props.isFirstOfReply })
    const { Text } = $.ui.resolve(e)
    return <Text key="engine-reply">{e.props.text}</Text>
  })
  return seen
}

async function start($: Engine) {
  await $.session.start({ cwd: '.', surface: 'terminal', isInteractive: true } as never)
}

function mountReply($: Engine, text: string) {
  return $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'AssistantMessage', props: { text, isFirstOfReply: true } })
}

describe('finding blocks', () => {
  test('takes the text between fences verbatim, backticks and tildes', () => {
    const blocks = findBlocks(REPLY)
    expect(blocks).toHaveLength(2)
    expect(blocks[0]?.language).toBe('powershell')
    expect(blocks[0]?.text).toBe(
      'Get-ChildItem -Path "C:\\Users\\robert\\a very long folder name that would wrap on a narrow terminal" -Recurse\n  indented line',
    )
    expect(blocks[1]?.text).toBe('{ "a": 1 }')
    expect(blocks.every(b => b.isClosed)).toBe(true)
  })

  test('a longer fence holds a shorter one inside it', () => {
    const blocks = findBlocks('````md\n```js\nx\n```\n````')
    expect(blocks).toHaveLength(1)
    expect(blocks[0]?.text).toBe('```js\nx\n```')
  })

  test('an unclosed fence (still streaming) is marked open', () => {
    const blocks = findBlocks('text\n```bash\necho hi')
    expect(blocks[0]?.isClosed).toBe(false)
  })

  test('windows line endings do not leak into the copy', () => {
    expect(findBlocks('```\r\na\r\nb\r\n```\r\n')[0]?.text).toBe('a\nb')
  })

  test('splits a reply after each block and keeps the trailing prose', () => {
    const pieces = splitAfterBlocks(REPLY)
    expect(pieces).toHaveLength(3)
    expect(pieces[0]?.text.endsWith('```')).toBe(true)
    expect(pieces[2]?.text).toBe('Done.')
    expect(pieces.map(p => p.text).join('\n\n')).toContain('Then this config:')
  })

  test('picks blocks counting back from the last', () => {
    expect(pickBlock([REPLY, '```\nnewest\n```'], 1)?.text).toBe('newest')
    expect(pickBlock([REPLY, '```\nnewest\n```'], 2)?.text).toBe('{ "a": 1 }')
    expect(pickBlock([REPLY], 9)).toBeUndefined()
    expect(parseIndex('')).toBe(1)
    expect(parseIndex(' 3 ')).toBe(3)
    expect(parseIndex('0')).toBeUndefined()
    expect(parseIndex('abc')).toBeUndefined()
  })
})

describe('the Copy button', () => {
  test('draws one button under each finished block and copies the clean text', async ($, on) => {
    const seen = engine(on)
    await start($)
    const ui = await mountReply($, REPLY)
    expect(await ui.findAll({ type: 'Button' })).toHaveLength(2)
    await ui.press({ key: 'copy-0' })
    expect(seen.copies.at(-1)).toBe(
      'Get-ChildItem -Path "C:\\Users\\robert\\a very long folder name that would wrap on a narrow terminal" -Recurse\n  indented line',
    )
    expect(seen.copies.at(-1)).not.toMatch(/[│╭╮╰╯─]/)
    await ui.press({ key: 'copy-1' })
    expect(seen.copies.at(-1)).toBe('{ "a": 1 }')
    expect(seen.toasts.at(-1)).toContain('Copied 1 line of json')
  })

  test('the engine still draws every piece, and only the first carries the reply bullet', async ($, on) => {
    const seen = engine(on)
    await start($)
    await mountReply($, REPLY)
    const pieces = seen.drawn.slice(-3)
    expect(pieces.map(p => p.isFirst)).toEqual([true, false, false])
    expect(pieces.map(p => p.text).join('')).toContain('Run this:')
  })

  test('a reply without blocks is left alone', async ($, on) => {
    const seen = engine(on)
    await start($)
    const ui = await mountReply($, 'Just prose, no code.')
    expect(await ui.findAll({ type: 'Button' })).toHaveLength(0)
    expect(seen.drawn.at(-1)?.text).toBe('Just prose, no code.')
  })

  test('a block still streaming gets no button yet', async ($, on) => {
    engine(on)
    await start($)
    const ui = await mountReply($, 'Here:\n```bash\necho hi')
    expect(await ui.findAll({ type: 'Button' })).toHaveLength(0)
  })
})

describe('/copyblock', () => {
  test('copies the last block, or one further back', async ($, on) => {
    const seen = engine(on, [REPLY, 'and\n```\nnewest\n```'])
    await start($)
    const last = await $.command.run({ command: 'copyblock', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } } as never)
    expect(seen.copies.at(-1)).toBe('newest')
    expect(JSON.stringify(last)).toContain('Copied block')
    await $.command.run({ command: 'copyblock', args: '2', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } } as never)
    expect(seen.copies.at(-1)).toBe('{ "a": 1 }')
  })

  test('says so when there is nothing to copy', async ($, on) => {
    const seen = engine(on, ['no code here'])
    await start($)
    const out = await $.command.run({ command: 'copyblock', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } } as never)
    expect(JSON.stringify(out)).toContain('No code blocks')
    expect(seen.copies).toHaveLength(0)
  })
})

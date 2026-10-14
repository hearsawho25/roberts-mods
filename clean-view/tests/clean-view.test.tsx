import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On, RenderPropsOf } from 'claude-code'

import { cleanName } from '../hooks/clean-view'

const PLUGIN = 'clean-view'
const PLAN = 'mcp__clean-view__plan_steps'
const PROGRESS = 'mcp__clean-view__report_progress'
const SURFACES = ['terminal', 'desktop'] as const

/** Stands in for the engine beneath the mod. */
function engine(on: On) {
  const clock = mock.clock(on, { now: 1_000_000 })
  const seen = { toasts: [] as string[], ran: [] as string[], clock }
  mock.store(on)
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('tool.register', ($, e) => ({ value: { tool: `mcp__clean-view__${e.name}` } }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('ui.toast', ($, e) => {
    seen.toasts.push(e.text)
    return { value: undefined }
  })
  on('model.complete', () => ({
    value: {
      isAnswered: true,
      text: 'Build my landing page',
      usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    },
  }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('classic.Notification', () => ({}))
  on('tool.call', ($, e) => {
    seen.ran.push(String(e.tool))
    if (e.tool === 'Bash' && (e as { command?: string }).command === 'false') return { deny: 'boom' }
    if (e.tool === 'TaskCreate') return { result: { task: { id: '1', subject: e.subject } } } as never
    return { result: {} } as never
  })
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box key="engine-band" />
  })
  on('ui.render', { component: 'ToolUse' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text key="engine-row">engine row</Text>
  })
  return seen
}

async function start($: Engine) {
  await $.session.start({ cwd: '.', surface: 'terminal', isInteractive: true } as never)
}

async function newJob($: Engine, text = 'Build me a landing page with pricing and a contact form') {
  await $.turn.start({ text, turnId: 'turn-1' })
}

function bandProps(bodyColumns: number): RenderPropsOf['AbovePrompt'] {
  return { hasSurvey: false, isWorking: true, maxRows: 20, bodyColumns, scroll: { offset: 0, bodyRows: 20 }, view: {} }
}

async function mountBand($: Engine, surface: (typeof SURFACES)[number], columns = 90) {
  return $.ui.mount({
    plugin: PLUGIN,
    surface,
    component: 'AbovePrompt',
    props: bandProps(columns),
    viewport: { columns, rows: 40, isFullscreen: true },
  })
}

async function shownText($: Engine, surface: (typeof SURFACES)[number], columns = 90) {
  const band = await mountBand($, surface, columns)
  const found = await band.findAll({ type: 'Text' })
  const texts = found.map(one => one.text)
  const rows = (await band.findAll({ type: 'Box' })).filter(one => one.key?.startsWith('row-')).map(one => one.text)
  const button = await band.find({ key: 'clean-view-toggle' })
  await band.unmount()
  return { texts, rows, all: texts.join('\n'), button }
}

describe('plain names', () => {
  test('code, paths and file names are cleaned out of a step name', () => {
    expect(cleanName('Build the pricing section in `src/Pricing.tsx`')).toBe('Build the pricing section in')
    expect(cleanName('update the file src/app/page.tsx with new copy')).toBe('Update the file with new copy')
    expect(cleanName('Fix the bug in checkout.py today')).toBe('Fix the bug in today')
    expect(cleanName('`npm test`')).toBe('Working on it')
    expect(cleanName('   ')).toBe('Working on it')
  })

  test('a long name is trimmed at a word boundary to 40 characters or less', () => {
    const long = 'Write the friendly welcome message for every new visitor who arrives on the homepage'
    expect(long.length).toBeGreaterThan(79)
    const cleaned = cleanName(long)
    expect(cleaned.length).toBeLessThanOrEqual(40)
    expect(cleaned).toEndWith('…')
    expect(long.startsWith(cleaned.slice(0, -1))).toBe(true)
    expect(cleaned.slice(-2, -1)).not.toBe(' ')
  })
})

describe('checklist', () => {
  test('a to-do list plus a 60% report draws done, current, next and up next rows', async ($, on) => {
    engine(on)
    await start($)
    await newJob($)
    await $.tool.call({
      tool: 'TodoWrite',
      todos: [
        { content: 'Read your brand notes', status: 'completed', activeForm: 'Reading' },
        { content: 'Build the pricing section', status: 'in_progress', activeForm: 'Building' },
        { content: 'Add the contact form', status: 'pending', activeForm: 'Adding' },
        { content: 'Polish the footer', status: 'pending', activeForm: 'Polishing' },
      ],
    })
    await $.tool.call({ tool: PROGRESS, task: 'Build the pricing section', percent: 60 } as never)

    for (const surface of SURFACES) {
      const { all, button } = await shownText($, surface)
      expect(all).toContain('✓')
      expect(all).toContain('Read your brand notes')
      expect(all).toContain('▰▰▰▰▰▰▰▰▰▰')
      expect(all).toContain('Done')
      expect(all).toContain('▶')
      expect(all).toContain('▰▰▰▰▰▰▱▱▱▱')
      expect(all).toContain('60%')
      expect(all).toMatch(/○ Add the contact form\s+▱{10}\s+Next/)
      expect(all).toMatch(/○ Polish the footer\s+▱{10}\s+Up next/)
      expect(button?.props.label).toBe('● Clean View: ON')
    }
  })

  test('bars sit right after the longest step name', async ($, on) => {
    engine(on)
    await start($)
    await newJob($)
    await $.tool.call({ tool: PLAN, steps: ['Read notes', 'Build the pricing section'] } as never)
    const { rows } = await shownText($, 'terminal', 120)
    expect(rows[0]).toMatch(/^▶ Read notes {16}[▰▱]{10}  Working$/)
    expect(rows[1]).toMatch(/^○ Build the pricing section ▱{10}  Next$/)
  })

  test('rows fit a narrow terminal without wrapping', async ($, on) => {
    engine(on)
    await start($)
    await newJob($)
    await $.tool.call({ tool: PLAN, steps: ['Read your brand notes', 'Build the pricing section'] } as never)
    const { rows } = await shownText($, 'terminal', 34)
    expect(rows.length).toBe(2)
    for (const row of rows) expect(row.length).toBeLessThanOrEqual(34)
  })

  test('plan_steps then report_progress at 100 checks off step one and starts step two', async ($, on) => {
    engine(on)
    await start($)
    await newJob($)
    const planned = await $.tool.call({ tool: PLAN, steps: ['Read your notes', 'Build the page', 'Check it'] } as never)
    expect(JSON.stringify(planned)).toContain('Planned 3 steps. The first one has started.')
    const reported = await $.tool.call({ tool: PROGRESS, task: 'Read your notes', percent: 140 } as never)
    expect(JSON.stringify(reported)).toContain('Progress noted: 100%.')

    const { rows } = await shownText($, 'terminal')
    expect(rows[0]).toMatch(/^✓ Read your notes\s+▰{10}\s+Done$/)
    expect(rows[1]).toMatch(/^▶ Build the page\s+[▰▱]{10}\s+Working$/)
    expect(rows[2]).toMatch(/^○ Check it\s+▱{10}\s+Next$/)
  })

  test('the job finishes with All done and shrinks to one line after 5 seconds', async ($, on) => {
    const { clock } = engine(on)
    await start($)
    await newJob($)
    await $.tool.call({ tool: PLAN, steps: ['Read your notes', 'Build the page'] } as never)
    await $.tool.call({ tool: PROGRESS, task: 'Build the page', percent: 100 } as never)
    await clock.advance(134_000)
    await $.turn.complete({ answer: 'Done', durationMs: 134_000, isAborted: false, turnId: 'turn-1', reason: 'answer' })

    const before = await shownText($, 'terminal')
    expect(before.all).toContain('✓ All done')
    expect(before.all).toContain('took 2m 14s')
    expect(before.all).toContain('Build the page')

    await clock.advance(5_000)
    const after = await shownText($, 'terminal')
    expect(after.all).toContain('✓ All done')
    expect(after.all).not.toContain('Build the page')
  })
})

describe('states', () => {
  test('a permission prompt shows Needs you', async ($, on) => {
    engine(on)
    await start($)
    await newJob($)
    await $.tool.call({ tool: PLAN, steps: ['Read your notes', 'Build the page'] } as never)
    await $.classic.Notification({ message: 'Claude needs your permission to use Bash', notification_type: 'permission_prompt' })

    for (const surface of SURFACES) {
      const { all } = await shownText($, surface)
      expect(all).toContain('Needs you')
      expect(all).toContain('Claude needs your OK to continue')
      expect(all).toContain('‖')
    }
  })

  test('Esc shows Stopped', async ($, on) => {
    engine(on)
    await start($)
    await newJob($)
    await $.tool.call({ tool: PLAN, steps: ['Read your notes', 'Build the page'] } as never)
    await $.turn.complete({ answer: '', durationMs: 1000, isAborted: true, turnId: 'turn-1', reason: 'aborted' })
    const { all } = await shownText($, 'terminal')
    expect(all).toContain('■ Stopped')
    expect(all).toContain('you pressed Esc')
  })

  test('three failures in a row show Stuck, and a success clears it', async ($, on) => {
    const seen = engine(on)
    await start($)
    await newJob($)
    await $.tool.call({ tool: PLAN, steps: ['Read your notes', 'Build the page'] } as never)
    for (let at = 0; at < 3; at++) await $.tool.call({ tool: 'Bash', command: 'false' } as never)
    expect((await shownText($, 'terminal')).all).toContain('⚠ Stuck: a step keeps failing, Claude is trying another way')
    await $.tool.call({ tool: 'Read', file_path: 'x' } as never)
    expect((await shownText($, 'terminal')).all).not.toContain('Stuck')
    expect(seen.ran).toContain('Read')
  })
})

describe('switch', () => {
  test('/simple off hides the band but keeps the button, and shows tool rows again', async ($, on) => {
    const seen = engine(on)
    await start($)
    await newJob($)
    await $.tool.call({ tool: PLAN, steps: ['Read your notes', 'Build the page'] } as never)

    const hiddenRow = await $.ui.mount({
      plugin: PLUGIN,
      surface: 'terminal',
      component: 'ToolUse',
      props: { tool_use_id: 'x', tool: 'Bash', input: {}, isRunning: false, isErrored: false, isInterrupted: false },
    })
    expect(await hiddenRow.find({ text: 'engine row' })).toBeUndefined()
    await hiddenRow.unmount()

    await $.command.run({
      command: 'simple',
      args: 'off',
      origin: { kind: 'composer' },
      presentation: { isFullscreen: true, columns: 120 },
    })
    const { all, button } = await shownText($, 'terminal')
    expect(all).not.toContain('Read your notes')
    expect(all).not.toContain('▶')
    expect(button?.props.label).toBe('○ Clean View: OFF')
    expect(seen.toasts.at(-1)).toContain('Clean View off')

    const shownRow = await $.ui.mount({
      plugin: PLUGIN,
      surface: 'terminal',
      component: 'ToolUse',
      props: { tool_use_id: 'x', tool: 'Bash', input: {}, isRunning: false, isErrored: false, isInterrupted: false },
    })
    expect(await shownRow.find({ text: 'engine row' })).toBeDefined()
  })

  test('the button turns it back on', async ($, on) => {
    engine(on)
    await start($)
    await $.command.run({ command: 'simple', args: 'off', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } })
    const band = await mountBand($, 'terminal')
    await band.press({ key: 'clean-view-toggle' })
    expect((await band.find({ key: 'clean-view-toggle' }))?.props.label).toBe('● Clean View: ON')
  })
})

describe('plan first', () => {
  test('any tool is denied before a plan exists and allowed after', async ($, on) => {
    const seen = engine(on)
    await start($)
    await newJob($)
    const before = await $.tool.call({ tool: 'Bash', command: 'ls' } as never)
    expect(JSON.stringify(before)).toContain('plan_steps')
    expect(seen.ran).not.toContain('Bash')

    const search = await $.tool.call({ tool: 'ToolSearch', query: 'select:plan_steps', max_results: 1 } as never)
    expect(JSON.stringify(search)).not.toContain('plan_steps first')

    await $.tool.call({ tool: PLAN, steps: ['Look around', 'Answer the question'] } as never)
    await $.tool.call({ tool: 'Bash', command: 'ls' } as never)
    expect(seen.ran).toContain('Bash')
  })

  test('subagents are never gated', async ($, on) => {
    const seen = engine(on)
    await start($)
    await newJob($)
    await $.tool.call({ tool: 'Read', file_path: 'x', agentId: 'helper' } as never)
    expect(seen.ran).toContain('Read')
  })
})

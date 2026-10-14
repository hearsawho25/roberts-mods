import { atom, read, update } from 'claude-code'
import type { EngineInterface, On, Timer } from 'claude-code'

import type { CleanViewChecklist, CleanViewTask } from '../types'

/**
 * Clean View: hides the tool rows of the transcript and draws one plain-English
 * checklist above the prompt (the plan, the step under way, how far along it is).
 */

type Engine = EngineInterface

const PLAN_TOOL = 'mcp__clean-view__plan_steps'
const PROGRESS_TOOL = 'mcp__clean-view__report_progress'
const ALWAYS_ALLOWED = new Set(['ToolSearch', 'TodoWrite', 'TaskCreate', 'TaskUpdate', 'AskUserQuestion', PLAN_TOOL])
const STORE_KEY = 'cleanViewEnabled'
const MAX_NAME = 40
const METER = 10
const FILLED = '▰'
const EMPTY = '▱'
const LABEL_WIDTH = 7
const TICK_MS = 250
const COLLAPSE_MS = 5000
const FALLBACK_NAME = 'Working on it'
const FIRST_TITLE = 'Working on your request'

const ASKED_OK = 'Claude needs your OK to continue'
const ASKED_QUESTION = 'Claude has a question for you'
const WAITING_REPLY = 'Claude is waiting for your reply'
const SAID_NO = 'you said no to a step, so Claude paused'
const KEEPS_FAILING = 'a step keeps failing, Claude is trying another way'
const REFUSED = "Claude couldn't help with that request"

const GATE_MESSAGE =
  `Clean View: before any other tool, call ${PLAN_TOOL} with every step of this job ` +
  '(2 to 8 short plain-English names, in order). Load it with ToolSearch if it is deferred, then carry on.'

const GUIDE = [
  '# Clean View',
  'The person sees a simple checklist above the prompt instead of your tool calls. Keep it true:',
  `- For every request, even a quick question, call \`${PLAN_TOOL}\` first with every step of the job, 2 to 8 in order. Load it with ToolSearch if it is deferred. Other tools are refused until you do.`,
  `- Call \`${PROGRESS_TOOL}\` with the step's exact name and a percent as real progress happens, and with 100 the moment a step finishes.`,
  '- Write every step name in plain English a non-technical person understands, under 40 characters, starting with a verb, like "Build the pricing section".',
  '- Never put file paths, file names, commands, code or tool names in a step name.',
  '- If this session has TodoWrite or TaskCreate, your to-do list can be the plan instead; the same naming rules apply to its items.',
].join('\n')

const enabledAtom = atom({ plugin: 'clean-view', key: 'cleanViewEnabled' } as const, true)
const checklistAtom = atom({ plugin: 'clean-view', key: 'checklist' } as const, null)
const tickAtom = atom({ plugin: 'clean-view', key: 'tick' } as const, 0)

const CODE_EXT =
  /\.(tsx?|jsx?|mjs|cjs|mts|cts|py|rb|go|rs|java|kt|swift|c|h|cc|cpp|hpp|cs|php|html?|css|scss|sass|less|json|jsonc|ya?ml|toml|md|mdx|sh|bash|zsh|ps1|bat|cmd|sql|vue|svelte|xml|lock|ini|cfg|conf|env|txt|csv|gradle|dart|lua|ex|exs|pl|dockerfile)$/i

/** Turns any step or job name into a short plain name: no code, paths or file names. */
export function cleanName(raw: unknown): string {
  const source = typeof raw === 'string' ? raw : ''
  const words = source
    .replace(/`[^`]*`?/g, ' ')
    .split(/\s+/)
    .filter(word => {
      if (word === '' || word.includes('/') || word.includes('\\')) return false
      return !CODE_EXT.test(word.replace(/^[("'[]+|[)"'\],.;:!?]+$/g, ''))
    })
  let text = words
    .join(' ')
    .replace(/\s+([,.;:!?])/g, '$1')
    .replace(/^[\s,.;:!?-]+/, '')
    .replace(/[\s,;:-]+$/, '')
    .trim()
  if (text === '') return FALLBACK_NAME
  text = text.charAt(0).toUpperCase() + text.slice(1)
  if (text.length > MAX_NAME) {
    const cut = text.slice(0, MAX_NAME - 1)
    const space = cut.lastIndexOf(' ')
    text = (space > 0 ? cut.slice(0, space) : cut).replace(/[\s,.;:!?-]+$/, '') + '…'
  }
  return text
}

/** A job title: the cleaned name, at most six words, without quotes or a closing full stop. */
function cleanTitle(raw: string): string {
  const firstLine = raw.split('\n').find(line => line.trim() !== '') ?? ''
  const words = firstLine.replace(/["“”*]/g, '').replace(/\.\s*$/, '').trim().split(/\s+/).slice(0, 6)
  return cleanName(words.join(' '))
}

function newId(): string {
  return crypto.randomUUID().slice(0, 8)
}

function step(name: string, status: CleanViewTask['status'], id = newId()): CleanViewTask {
  return { id, name, status, percent: status === 'done' ? 100 : 0, hasReported: false }
}

function freshChecklist(jobId: string, now: number): CleanViewChecklist {
  return {
    jobId,
    title: FIRST_TITLE,
    phase: 'working',
    tasks: [step('Understand your request', 'active', 'p1'), step('Plan the steps', 'upcoming', 'p2')],
    isPlanned: false,
    needsYouReason: null,
    stuckReason: null,
    startedAt: now,
    finishedAt: null,
    isCollapsed: false,
  }
}

const sameName = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()

const isLive = (list: CleanViewChecklist) =>
  list.phase === 'working' || list.phase === 'needsYou' || list.phase === 'stuck'

/** The checklist after a progress report on `name`: earlier steps done, a finished step hands on. */
export function applyProgress(tasks: readonly CleanViewTask[], name: string, percent: number): CleanViewTask[] {
  const list = tasks.map(task => ({ ...task }))
  let index = list.findIndex(task => sameName(task.name, name))
  if (index === -1) {
    index = list.reduce((last, task, at) => (task.status === 'upcoming' ? last : at), -1) + 1
    list.splice(index, 0, step(name, 'upcoming'))
  }
  const updated = list.map((task, at): CleanViewTask => {
    if (at < index) return { ...task, status: 'done', percent: 100 }
    if (at === index) return { ...task, status: 'active', percent, hasReported: true }
    return task.status === 'active' ? { ...task, status: 'upcoming' } : task
  })
  const reported = updated[index]
  if (percent >= 100 && reported !== undefined) {
    updated[index] = { ...reported, status: 'done', percent: 100 }
    const following = updated.findIndex((task, at) => at > index && task.status === 'upcoming')
    const nextTask = updated[following]
    if (nextTask !== undefined) updated[following] = { ...nextTask, status: 'active', percent: 0, hasReported: false }
  }
  return updated
}

type Todo = { content: string; status: 'pending' | 'in_progress' | 'completed' }

function todoTasks(todos: readonly Todo[], previous: readonly CleanViewTask[]): CleanViewTask[] {
  return todos.map((todo, at) => {
    const name = cleanName(todo.content)
    const old = previous.find(task => sameName(task.name, name))
    if (todo.status === 'completed') return step(name, 'done', `todo-${at}`)
    if (todo.status === 'pending') return step(name, 'upcoming', `todo-${at}`)
    const kept = old?.status === 'active' && old.hasReported
    return { id: `todo-${at}`, name, status: 'active', percent: kept ? old.percent : 0, hasReported: kept }
  })
}

/** One calm sentence for an API failure, by the kind Claude Code classifies it as. */
function apiSentence(kind: string, details: string): string {
  if (/prompt is too long|context (window|length)|too many tokens/i.test(details)) return 'type /compact and try again'
  if (kind === 'rate_limit' || kind === 'billing_error') return 'you hit your usage limit, try again a little later'
  if (kind === 'overloaded' || kind === 'server_error') return "Claude's servers are busy, try again in a minute"
  if (/auth|oauth|login|credential/i.test(kind)) return 'type /login'
  if (/network|connect|socket|timed? ?out|fetch failed|ENOTFOUND|ECONN/i.test(details)) return 'the internet connection dropped'
  return 'something went wrong, try sending your message again'
}

function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000))
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  if (hours > 0) return `${hours}h ${minutes}m`
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`
  return `${seconds}s`
}

function fit(text: string, width: number): string {
  if (width <= 0) return ''
  return text.length <= width ? text : text.slice(0, Math.max(0, width - 1)) + '…'
}

function meter(task: CleanViewTask, tick: number): string {
  if (task.status === 'done') return FILLED.repeat(METER)
  if (task.status === 'upcoming') return EMPTY.repeat(METER)
  if (task.hasReported) {
    const filled = Math.round(task.percent / 10)
    return FILLED.repeat(filled) + EMPTY.repeat(METER - filled)
  }
  const at = (tick % (METER + 3)) - 2
  return Array.from({ length: METER }, (_, cell) => (cell >= at && cell < at + 3 ? FILLED : EMPTY)).join('')
}

/** What the module keeps between events; a hot reload starts it over (the checklist itself is in $.state). */
const runtime = {
  ticker: null as Timer | null,
  collapser: null as Timer | null,
  failures: 0,
  apiFailure: null as string | null,
}

const isEnabled = ($: Engine) => read($, enabledAtom)
const getChecklist = ($: Engine) => read($, checklistAtom)

/** Runs the 250ms animation clock only while a job is working or waiting on the person. */
async function syncClock($: Engine) {
  const list = await getChecklist($)
  const isAnimated =
    (await isEnabled($)) && list !== null && (list.phase === 'working' || list.phase === 'needsYou')
  if (isAnimated && runtime.ticker === null) {
    runtime.ticker = $.clock.every(TICK_MS, () => {
      void update($, tickAtom, n => (n + 1) % 1_000_000).catch(() => undefined)
    })
  } else if (!isAnimated && runtime.ticker !== null) {
    runtime.ticker.cancel()
    runtime.ticker = null
  }
}

async function edit($: Engine, change: (list: CleanViewChecklist) => CleanViewChecklist) {
  await update($, checklistAtom, list => (list === null ? list : change(list)))
  await syncClock($)
}

async function replace($: Engine, list: CleanViewChecklist | null) {
  await update($, checklistAtom, () => list)
  await syncClock($)
}

async function setEnabled($: Engine, isOn: boolean) {
  await update($, enabledAtom, () => isOn)
  await $.store.set(STORE_KEY, isOn)
  $.ui.toast(isOn ? "Clean View on: Claude's technical steps are hidden" : 'Clean View off: showing everything Claude does')
  await syncClock($)
}

function scheduleCollapse($: Engine, jobId: string) {
  runtime.collapser?.cancel()
  runtime.collapser = $.clock.after(COLLAPSE_MS, () => {
    void edit($, list => (list.jobId === jobId && list.phase === 'done' ? { ...list, isCollapsed: true } : list)).catch(
      () => undefined,
    )
  })
}

/** Asks Haiku for a short name for the job in the background; a newer job's start makes the answer moot. */
function nameJob($: Engine, jobId: string, request: string) {
  const prompt =
    'Name this job in 2 to 6 plain words a non-technical person understands, starting with a verb ' +
    '(like "Build my landing page"). No file names, code or quotes. Reply with the name only.\n\n' +
    `Request: ${request.slice(0, 2000)}`
  $.clock.after(0, () => {
    void (async () => {
      const ask = { model: 'haiku', prompt, maxTokens: 30 }
      const reply = await $.model.complete({ ...ask, effort: 'low' }).catch(() => $.model.complete(ask))
      if (!reply.isAnswered) return
      const title = cleanTitle(reply.text)
      if (title === FALLBACK_NAME) return
      await edit($, list => (list.jobId === jobId ? { ...list, title } : list))
    })().catch(() => undefined)
  })
}

async function isGated($: Engine) {
  if (!(await isEnabled($))) return false
  const list = await getChecklist($)
  return list !== null && isLive(list) && !list.isPlanned
}

export function registerCleanView(on: On): void {
  on('session.start', async ($, e, next) => {
    await $.tool.register({
      name: 'plan_steps',
      description:
        'Lay out every step of the job up front for the checklist the person sees: 2 to 8 short plain-English names in order, each under 40 characters and starting with a verb. The first step starts right away. Call this first for every request.',
      inputSchema: {
        type: 'object',
        properties: {
          steps: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 8, description: 'Step names, in order' },
        },
        required: ['steps'],
      },
      isDeferred: false,
    })
    await $.tool.register({
      name: 'report_progress',
      description:
        'Report progress on the current step of the checklist. Use the step name exactly as planned and a percent from 0 to 100; report 100 the moment a step finishes and the next one starts by itself.',
      inputSchema: {
        type: 'object',
        properties: {
          task: { type: 'string', description: 'The step name, as planned' },
          percent: { type: 'number', minimum: 0, maximum: 100 },
        },
        required: ['task', 'percent'],
      },
      isDeferred: false,
    })
    await $.command.register({
      name: 'simple',
      description: 'Turn Clean View on or off (hides the technical details while Claude works)',
      argumentHint: '[on|off]',
      immediate: true,
    })
    const saved = await $.store.get(STORE_KEY)
    await update($, enabledAtom, () => saved !== false)
    await syncClock($)
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') await replace($, null)
    return next(e)
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'simple' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    if (arg !== '' && arg !== 'on' && arg !== 'off') {
      return { text: 'Type /simple on, /simple off, or just /simple to switch Clean View.' }
    }
    const isOn = arg === '' ? !(await isEnabled($)) : arg === 'on'
    await setEnabled($, isOn)
    return { text: isOn ? 'Clean View is on.' : 'Clean View is off.' }
  })

  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    if (!(await isEnabled($))) return composed
    return { sections: [...composed.sections, { id: 'clean-view:steps', text: GUIDE, scope: 'session' as const }] }
  }).catch(($, e, next) => next(e))

  on('turn.start', async ($, e, next) => {
    const text = e.text.trim()
    if (text !== '' && !text.startsWith('/') && (await isEnabled($))) {
      const list = await getChecklist($)
      const isContinuing = list !== null && list.phase === 'needsYou' && list.tasks.some(task => task.status !== 'done')
      runtime.failures = 0
      runtime.apiFailure = null
      if (isContinuing) {
        await edit($, current => ({ ...current, phase: 'working', needsYouReason: null, stuckReason: null }))
      } else {
        runtime.collapser?.cancel()
        await replace($, freshChecklist(e.turnId, await $.clock.now()))
        nameJob($, e.turnId, text)
      }
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('tool.call', async ($, e, next) => {
    const tool = String(e.tool)
    const isMain = e.agentId === undefined
    if (isMain && !ALWAYS_ALLOWED.has(tool) && (await isGated($))) return { deny: GATE_MESSAGE }

    if (tool === PLAN_TOOL) {
      const steps = (e as { steps?: unknown }).steps
      const names = (Array.isArray(steps) ? steps : []).map(cleanName).slice(0, 8)
      if (names.length === 0) return { deny: 'plan_steps needs 2 to 8 step names.' }
      if (!isMain) return { result: 'Only the main conversation keeps the plan; carry on with your task.' }
      const tasks = names.map((name, at) => step(name, at === 0 ? 'active' : 'upcoming', `s${at + 1}`))
      const now = await $.clock.now()
      await update($, checklistAtom, (list): CleanViewChecklist => ({
        ...(list ?? freshChecklist(newId(), now)),
        tasks,
        isPlanned: true,
        phase: 'working',
        needsYouReason: null,
        stuckReason: null,
        finishedAt: null,
        isCollapsed: false,
      }))
      await syncClock($)
      return { result: `Planned ${names.length} steps. The first one has started.` }
    }

    if (tool === PROGRESS_TOOL) {
      const input = e as { task?: unknown; percent?: unknown }
      const raw = Number(input.percent)
      const percent = Math.round(Math.min(100, Math.max(0, Number.isFinite(raw) ? raw : 0)))
      if (isMain) {
        const name = cleanName(input.task)
        const now = await $.clock.now()
        await update($, checklistAtom, (list): CleanViewChecklist => {
          const base = list ?? { ...freshChecklist(newId(), now), tasks: [], isPlanned: true }
          return {
            ...base,
            tasks: applyProgress(base.tasks, name, percent),
            phase: base.phase === 'stuck' || base.phase === 'needsYou' ? 'working' : base.phase,
            needsYouReason: null,
            stuckReason: null,
          }
        })
        runtime.failures = 0
        await syncClock($)
      }
      return { result: `Progress noted: ${percent}%.` }
    }

    if (!isMain) return next(e)

    if (tool === 'AskUserQuestion') {
      await edit($, list => (isLive(list) ? { ...list, phase: 'needsYou', needsYouReason: ASKED_QUESTION } : list))
    } else {
      await edit($, list => (list.phase === 'needsYou' ? { ...list, phase: 'working', needsYouReason: null } : list))
    }

    const ran = await next(e)

    const isError = ran.deny !== undefined || ran.isError === true
    const said = ran.deny ?? ran.text ?? ''
    const isRefusedByPerson = isError && /doesn't want to proceed|user (rejected|denied|declined)|was rejected/i.test(said)
    if (isRefusedByPerson) runtime.failures = 0
    else runtime.failures = isError ? runtime.failures + 1 : 0

    await edit($, list => {
      if (!isLive(list)) return list
      let changed: CleanViewChecklist =
        list.phase === 'needsYou' ? { ...list, phase: 'working', needsYouReason: null } : list
      if (isRefusedByPerson) changed = { ...changed, phase: 'stuck', stuckReason: SAID_NO }
      else if (runtime.failures >= 3) changed = { ...changed, phase: 'stuck', stuckReason: KEEPS_FAILING }
      else if (!isError && changed.phase === 'stuck') changed = { ...changed, phase: 'working', stuckReason: null }

      if (isError) return changed
      if (tool === 'TodoWrite') {
        const todos = (e as { todos?: Todo[] }).todos ?? []
        if (todos.length > 0) changed = { ...changed, tasks: todoTasks(todos, changed.tasks), isPlanned: true }
      } else if (tool === 'TaskCreate') {
        const subject = (e as { subject?: string }).subject
        const created = (ran.result as { task?: { id?: string } } | undefined)?.task?.id ?? newId()
        const kept = changed.isPlanned ? changed.tasks : []
        changed = { ...changed, tasks: [...kept, step(cleanName(subject), 'upcoming', `task-${created}`)], isPlanned: true }
      } else if (tool === 'TaskUpdate') {
        const input = e as { taskId?: string; subject?: string; status?: string }
        const id = `task-${input.taskId ?? ''}`
        const tasks = changed.tasks
          .filter(task => !(task.id === id && input.status === 'deleted'))
          .map((task): CleanViewTask => {
            if (task.id !== id) return task
            const named = input.subject === undefined ? task : { ...task, name: cleanName(input.subject) }
            if (input.status === 'completed') return { ...named, status: 'done', percent: 100 }
            if (input.status === 'in_progress') return { ...named, status: 'active' }
            if (input.status === 'pending') return { ...named, status: 'upcoming' }
            return named
          })
        changed = { ...changed, tasks }
      }
      return changed
    })
    return ran
  }).catch(($, e, next) => next(e))

  on('classic.Notification', async ($, e, next) => {
    const reason =
      e.notification_type === 'permission_prompt'
        ? ASKED_OK
        : e.notification_type === 'elicitation_dialog'
          ? ASKED_QUESTION
          : null
    if (reason !== null && e.agent_id === undefined) {
      await edit($, list => (isLive(list) ? { ...list, phase: 'needsYou', needsYouReason: reason } : list))
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('classic.StopFailure', async ($, e, next) => {
    if (e.agent_id === undefined) {
      const sentence = apiSentence(e.error, e.error_details ?? '')
      runtime.apiFailure = sentence
      await edit($, list =>
        list.phase === 'stopped' || list.phase === 'done' ? list : { ...list, phase: 'stuck', stuckReason: sentence },
      )
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) {
      const now = await $.clock.now()
      let finishedJob: string | null = null
      await edit($, list => {
        if (!isLive(list)) return list
        if (e.reason === 'error') {
          return { ...list, phase: 'stuck', stuckReason: runtime.apiFailure ?? apiSentence('unknown', ''), finishedAt: now }
        }
        if (e.reason === 'refusal') return { ...list, phase: 'stuck', stuckReason: REFUSED, finishedAt: now }
        if (e.reason === 'aborted') return { ...list, phase: 'stopped', finishedAt: now }
        if (list.phase === 'stuck' && list.stuckReason === SAID_NO) return list
        const hasUnfinished = list.isPlanned && list.tasks.some(task => task.status !== 'done')
        if (hasUnfinished) return { ...list, phase: 'needsYou', needsYouReason: WAITING_REPLY, stuckReason: null }
        finishedJob = list.jobId
        return {
          ...list,
          phase: 'done',
          tasks: list.tasks.map(task => ({ ...task, status: 'done' as const, percent: 100 })),
          needsYouReason: null,
          stuckReason: null,
          finishedAt: now,
          isCollapsed: false,
        }
      })
      runtime.apiFailure = null
      runtime.failures = 0
      if (finishedJob !== null) scheduleCollapse($, finishedJob)
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'ToolUse' }, async ($, e, next) => {
    if (!(await isEnabled($))) return next(e)
    const { Box } = $.ui.resolve(e)
    return <Box display="none" />
  })

  on('ui.render', { component: 'ToolResult' }, async ($, e, next) => {
    if (!(await isEnabled($))) return next(e)
    const { Box } = $.ui.resolve(e)
    return <Box display="none" />
  })

  on('ui.render', { component: 'ToolGroup' }, async ($, e, next) => {
    if (!(await isEnabled($))) return next(e)
    const { Box } = $.ui.resolve(e)
    return <Box display="none" />
  })

  on('ui.render', { component: 'ToolProgress' }, async ($, e, next) =>
    (await isEnabled($)) ? next({ ...e, props: { ...e.props, hint: '' } }) : next(e),
  )

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const { Box, Text, Button } = $.ui.resolve(e)
    const isOn = await isEnabled($)
    const list = isOn ? await getChecklist($) : null
    const isAnimated = list !== null && (list.phase === 'working' || list.phase === 'needsYou')
    const tick = isAnimated ? await read($, tickAtom) : 0
    const now = list !== null && list.finishedAt === null ? await $.clock.now() : 0
    const below = await next(e)

    const columns = Math.max(24, e.props.bodyColumns)
    const buttonLabel = isOn ? '● Clean View: ON' : '○ Clean View: OFF'
    const room = Math.max(8, columns - buttonLabel.length - 5)

    const header = () => {
      if (list === null) return <Text> </Text>
      const took = formatDuration((list.finishedAt ?? now) - list.startedAt)
      if (list.phase === 'needsYou') {
        return (
          <Text>
            <Text inverse bold color="warning"> Needs you </Text>
            <Text> {fit(list.needsYouReason ?? WAITING_REPLY, room - 12)}</Text>
          </Text>
        )
      }
      if (list.phase === 'stuck') {
        return <Text color="warning">{fit(`⚠ Stuck: ${list.stuckReason ?? KEEPS_FAILING}`, room)}</Text>
      }
      if (list.phase === 'stopped') {
        return <Text dimColor>{fit(`■ Stopped · ${list.title} · you pressed Esc`, room)}</Text>
      }
      if (list.phase === 'done') {
        return (
          <Text>
            <Text color="success" bold>✓ All done</Text>
            <Text>{fit(` · ${list.title} · took ${took}`, room - 10)}</Text>
          </Text>
        )
      }
      const time = ` · ${took}`
      return (
        <Text>
          <Text bold>{fit(list.title, room - time.length)}</Text>
          <Text dimColor>{time}</Text>
        </Text>
      )
    }

    const rows = () => {
      if (list === null || (list.phase === 'done' && list.isCollapsed)) return []
      // The name column is as wide as the longest name, so the bars sit close to the names.
      const longest = Math.max(...list.tasks.map(task => task.name.length), 4)
      const nameWidth = Math.max(4, Math.min(longest, MAX_NAME, columns - 2 - 1 - METER - 2 - LABEL_WIDTH))
      const firstUpcoming = list.tasks.findIndex(task => task.status === 'upcoming')
      return list.tasks.map((task, at) => {
        const name = fit(task.name, nameWidth).padEnd(nameWidth)
        const bar = meter(task, tick)
        if (task.status === 'done') {
          return (
            <Box key={`row-${task.id}`}>
              <Text>
              <Text color="success">✓ </Text>
              <Text dimColor>{name} </Text>
              <Text color="success">{bar}</Text>
              <Text dimColor>  Done</Text>
              </Text>
            </Box>
          )
        }
        if (task.status === 'active') {
          const mark = list.phase === 'needsYou' ? '‖ ' : '▶ '
          const label = task.hasReported ? `${task.percent}%` : 'Working'
          return (
            <Box key={`row-${task.id}`}>
              <Text>
              <Text color="claude">{mark}</Text>
              <Text bold>{name} </Text>
              <Text color="claude">{bar}</Text>
              <Text>  {label}</Text>
              </Text>
            </Box>
          )
        }
        return (
          <Box key={`row-${task.id}`}>
            <Text dimColor>{`○ ${name} ${bar}  ${at === firstUpcoming ? 'Next' : 'Up next'}`}</Text>
          </Box>
        )
      })
    }

    return (
      <Box flexDirection="column">
        <Box key="clean-view-header" flexDirection="row">
          <Box flexGrow={1} flexShrink={1}>
            {header()}
          </Box>
          <Button
            key="clean-view-toggle"
            label={buttonLabel}
            variant={isOn ? 'primary' : 'secondary'}
            onPress={() => setEnabled($, !isOn)}
          />
        </Box>
        {rows()}
        {below}
      </Box>
    )
  }).catch(($, e, next) => next(e))
}

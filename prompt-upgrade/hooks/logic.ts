// Pure helpers: deciding what to intercept, talking to the model, reading its
// replies, and laying text out in cells. Nothing here touches `$`.

import type { PromptUpgradeAnswer, PromptUpgradeQuestion } from '../types'

export type Decision = { action: 'pass' } | { action: 'strip'; text: string } | { action: 'intercept' }

export type Submission = {
  text: string
  attachments?: readonly unknown[]
  turnId?: string
  origin: { kind: string }
}

const ACKS =
  /^(y|yes|yeah|yep|yup|no|nope|nah|ok|okay|k|sure|thanks|thank you|thx|ty|go|go ahead|go on|do it|keep going|continue|carry on|proceed|next|sounds good|looks good|lgtm|perfect|great|nice|cool|done|stop|wait|retry|try again|again|undo|revert)[\s.!?]*$/i

/** Fewer words than this counts as a short reply and goes straight through. */
export const SHORT_REPLY_WORDS = 4

export function decide(e: Submission, isAuto: boolean): Decision {
  if (!isAuto) return { action: 'pass' }
  // Only what the person typed at the prompt box. The mod's own submissions
  // arrive as origin `plugin`, so an upgrade can never come back in here.
  if (e.origin.kind !== 'composer') return { action: 'pass' }
  if (e.turnId !== undefined) return { action: 'pass' }
  if ((e.attachments?.length ?? 0) > 0) return { action: 'pass' }
  const text = e.text.trim()
  if (text === '') return { action: 'pass' }
  if (text.startsWith('>')) return { action: 'strip', text: text.slice(1).trimStart() }
  if (text.startsWith('/')) return { action: 'pass' }
  if (ACKS.test(text)) return { action: 'pass' }
  if (wordCount(text) < SHORT_REPLY_WORDS) return { action: 'pass' }
  return { action: 'intercept' }
}

export function wordCount(text: string): number {
  const words = text.trim().split(/\s+/)
  return words[0] === '' ? 0 : words.length
}

// ---------------------------------------------------------------- the model

export const QUESTIONS_SYSTEM = `You help a person improve a prompt they are about to send to an AI coding and writing assistant.
Pick the at most three multiple-choice questions whose answers would most improve the result.
Ask only about things the prompt leaves genuinely open and that change the outcome: the goal, who it is for, the format, scope, or what "done" looks like.
Never ask about something the prompt already says. If no question would help, return none.
Each question is one short sentence. Each has two to four short options of at most six words. Do not add an "Other" option.
Reply with JSON only, no prose and no code fence, in exactly this shape:
{"questions":[{"question":"...","options":["...","..."]}]}`

export function questionsPrompt(original: string): string {
  return `The prompt:\n<prompt>\n${original}\n</prompt>`
}

export const REWRITE_SYSTEM = `You rewrite a rough prompt into a great one, written as one request the person could have typed themselves, in plain language.
Rules:
- Keep exactly what the person meant. Do not change the task.
- Add a clear goal, who it is for, the format of the result, and what "done" looks like.
- Use the answers the person gave. Leave out anything they skipped.
- Never invent facts, names, numbers, prices, file names or URLs. Where something needed is unknown, write a placeholder in square brackets, like [the API base URL].
- No headings, no bullet lists of instructions to the AI about being an AI; just a clear request, a few short paragraphs at most.
Also list, in a few words each, what you added that was not in the original (at most six items).
Reply with JSON only, no prose and no code fence, in exactly this shape:
{"prompt":"...","added":["...","..."]}`

export function rewritePrompt(
  original: string,
  questions: readonly PromptUpgradeQuestion[],
  answers: readonly (PromptUpgradeAnswer | null)[],
): string {
  const lines: string[] = []
  questions.forEach((q, i) => {
    const a = answers[i]
    if (a === null || a === undefined || a.kind === 'skip') return
    lines.push(`Q: ${q.question}\nA: ${a.text}`)
  })
  const answered = lines.length === 0 ? 'The person answered no questions.' : `The person's answers:\n${lines.join('\n')}`
  return `The original prompt:\n<prompt>\n${original}\n</prompt>\n\n${answered}`
}

/** Finds the JSON object in a reply, tolerating a code fence or a stray line around it. */
function jsonObject(reply: string): unknown {
  const start = reply.indexOf('{')
  const end = reply.lastIndexOf('}')
  if (start === -1 || end <= start) throw new Error('The reply held no JSON object.')
  return JSON.parse(reply.slice(start, end + 1))
}

function cleanLine(value: unknown, max: number): string {
  if (typeof value !== 'string') return ''
  const one = value.replace(/\s+/g, ' ').trim()
  return one.length > max ? `${one.slice(0, max - 1).trimEnd()}…` : one
}

export function parseQuestions(reply: string): PromptUpgradeQuestion[] {
  const data = jsonObject(reply) as { questions?: unknown }
  if (!Array.isArray(data.questions)) throw new Error('The reply had no questions list.')
  const out: PromptUpgradeQuestion[] = []
  for (const raw of data.questions) {
    if (typeof raw !== 'object' || raw === null) continue
    const item = raw as { question?: unknown; options?: unknown }
    const question = cleanLine(item.question, 140)
    if (question === '' || !Array.isArray(item.options)) continue
    const seen = new Set<string>()
    const options: string[] = []
    for (const option of item.options) {
      const text = cleanLine(option, 40)
      if (text === '' || /^other\b/i.test(text) || seen.has(text.toLowerCase())) continue
      seen.add(text.toLowerCase())
      options.push(text)
    }
    if (options.length < 2) continue
    out.push({ question, options: options.slice(0, 4) })
    if (out.length === 3) break
  }
  return out
}

export function parseRewrite(reply: string): { prompt: string; added: string[] } {
  const data = jsonObject(reply) as { prompt?: unknown; added?: unknown }
  if (typeof data.prompt !== 'string' || data.prompt.trim() === '') throw new Error('The reply had no rewritten prompt.')
  const added = Array.isArray(data.added)
    ? data.added.map(item => cleanLine(item, 80)).filter(item => item !== '').slice(0, 6)
    : []
  return { prompt: data.prompt.trim(), added }
}

// ---------------------------------------------------------------- layout

/** Wraps text into lines no wider than `width`, keeping the author's line breaks. */
export function wrapText(text: string, width: number): string[] {
  const room = Math.max(1, width)
  const out: string[] = []
  for (const paragraph of text.replace(/\r\n?/g, '\n').split('\n')) {
    if (paragraph.trim() === '') {
      out.push('')
      continue
    }
    let line = ''
    for (const word of paragraph.split(/\s+/).filter(w => w !== '')) {
      let rest = word
      while (rest.length > room) {
        if (line !== '') {
          out.push(line)
          line = ''
        }
        out.push(rest.slice(0, room))
        rest = rest.slice(room)
      }
      if (line === '') line = rest
      else if (line.length + 1 + rest.length <= room) line = `${line} ${rest}`
      else {
        out.push(line)
        line = rest
      }
    }
    if (line !== '') out.push(line)
  }
  while (out.length > 0 && out[out.length - 1] === '') out.pop()
  return out
}

export function clip(text: string, width: number): string {
  if (width <= 0) return ''
  return text.length > width ? `${text.slice(0, Math.max(0, width - 1))}…` : text
}

/** Splits chips into rows that fit `width`, given each chip's drawn width and a gap of one. */
export function packRows<T>(items: readonly T[], widthOf: (item: T) => number, width: number): T[][] {
  const rows: T[][] = []
  let row: T[] = []
  let used = 0
  for (const item of items) {
    const w = widthOf(item)
    const need = row.length === 0 ? w : used + 1 + w
    if (row.length > 0 && need > width) {
      rows.push(row)
      row = [item]
      used = w
    } else {
      row.push(item)
      used = need
    }
  }
  if (row.length > 0) rows.push(row)
  return rows
}

const DIGITS: Record<string, [string, string, string]> = {
  '0': ['┏━┓', '┃ ┃', '┗━┛'],
  '1': ['╺┓ ', ' ┃ ', '╺┻╸'],
  '2': ['╺━┓', '┏━┛', '┗━╸'],
  '3': ['╺━┓', ' ━┫', '╺━┛'],
  '4': ['╻ ╻', '┗━┫', '  ╹'],
  '5': ['┏━╸', '┗━┓', '╺━┛'],
  '6': ['┏━╸', '┣━┓', '┗━┛'],
  '7': ['╺━┓', '  ┃', '  ╹'],
  '8': ['┏━┓', '┣━┫', '┗━┛'],
  '9': ['┏━┓', '┗━┫', '╺━┛'],
}

/** A number drawn three rows tall in heavy box-drawing characters. */
export function bigNumber(n: number): [string, string, string] {
  const digits = String(Math.max(0, Math.round(n))).split('')
  const rows: [string, string, string] = ['', '', '']
  digits.forEach((d, i) => {
    const glyph = DIGITS[d] ?? DIGITS['0']!
    for (let r = 0; r < 3; r++) rows[r] += (i > 0 ? ' ' : '') + glyph[r]
  })
  return rows
}

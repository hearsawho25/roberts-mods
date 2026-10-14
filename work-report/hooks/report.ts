// The work report's pure logic: sorting tasks, the calendar, the sums, the
// estimate, and the strings the pane draws. Nothing here touches `$`.

import type { ReportTab } from '../types'

export type Kind = 'emails' | 'documents' | 'media' | 'research' | 'other'

export const KINDS: readonly Kind[] = ['emails', 'documents', 'media', 'research', 'other']

export const KIND_LABEL: Record<Kind, string> = {
  emails: 'Emails',
  documents: 'Documents',
  media: 'Images and video',
  research: 'Research',
  other: 'Other',
}

export const KIND_SHORT: Record<Kind, string> = {
  emails: 'Email',
  documents: 'Docs',
  media: 'Media',
  research: 'Research',
  other: 'Other',
}

export type DayRecord = { kinds: Partial<Record<Kind, number>>; models: Record<string, number> }
export type Days = Record<string, DayRecord>
export type Settings = { rate: number; minutes: Record<Kind, number> }
export type ToolUse = { name: string; path?: string }

export const DEFAULT_SETTINGS: Settings = {
  rate: 50,
  minutes: { emails: 10, documents: 30, media: 20, research: 25, other: 10 },
}

export const DAY_MS = 86_400_000
export const KEEP_DAYS = 400

// ---------------------------------------------------------------- sorting

const MAIL_TOOL = /(gmail|outlook|e-?mail|mail|inbox|himalaya)/i
const MEDIA_TOOL = /(image|video|photo|picture|canva|figma|gif|dall-?e|midjourney|imagen|sora|thumbnail)/i
const MEDIA_FILE = /\.(png|jpe?g|gif|webp|svg|bmp|tiff?|heic|avif|ico|mp4|mov|m4v|webm|avi|mkv|wmv)$/i
const RESEARCH_TOOL =
  /(^webfetch$|^websearch$|web_?search|web_?fetch|search_web|fetch_url|context7|query-docs|transcript|youtube|read_page|get_page_text|navigate|browse|crawl|scrape|tavily|perplexity|deep-?research)/i
const DOC_TOOL = /(docs?|document|slide|deck|spreadsheet|sheets?|excel|powerpoint|pptx|docx|xlsx|pdf|notion|drive)/i
const DOC_FILE = /\.(md|markdown|txt|rtf|docx?|odt|pdf|pptx?|key|odp|xlsx?|csv|ods|tex)$/i
const WRITE_TOOL = /^(write|edit|multiedit|notebookedit)$/i

/** The kind one tool call points at, or undefined when it says nothing. */
export function kindOfTool(use: ToolUse): Kind | undefined {
  const path = use.path ?? ''
  if (MAIL_TOOL.test(use.name)) return 'emails'
  if (MEDIA_TOOL.test(use.name) || MEDIA_FILE.test(path)) return 'media'
  if (RESEARCH_TOOL.test(use.name)) return 'research'
  if (DOC_TOOL.test(use.name) || (WRITE_TOOL.test(use.name) && DOC_FILE.test(path))) return 'documents'
  return undefined
}

/** One kind per task: Emails, then Images and video, Documents, Research, else Other. */
export function classify(tools: readonly ToolUse[]): Kind {
  const seen = new Set<Kind>()
  for (const use of tools) {
    const kind = kindOfTool(use)
    if (kind !== undefined) seen.add(kind)
  }
  for (const kind of ['emails', 'media', 'documents', 'research'] as const) {
    if (seen.has(kind)) return kind
  }
  return 'other'
}

// ------------------------------------------------------- counting prompts

/** A prompt the person typed: their own Enter (or the remote bridge), not a slash command. */
export function isTypedPrompt(text: string, originKind: string): boolean {
  if (originKind !== 'composer' && originKind !== 'bridge') return false
  const trimmed = text.trim()
  return trimmed !== '' && !trimmed.startsWith('/')
}

/** Takes the pending typed prompt a turn starts with, if any; the rest stay pending. */
export function takePending(pending: readonly string[], turnText: string): { isTyped: boolean; rest: string[] } {
  const text = turnText.trim()
  if (text === '') return { isTyped: false, rest: [...pending] }
  const at = pending.findIndex(one => {
    const typed = one.trim()
    return typed === text || text.startsWith(typed) || typed.startsWith(text)
  })
  if (at < 0) return { isTyped: false, rest: [...pending] }
  return { isTyped: true, rest: pending.filter((_, i) => i !== at) }
}

// --------------------------------------------------------------- calendar

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n)
}

/** Local noon of the day `ms` falls on. */
export function localNoon(ms: number): number {
  const d = new Date(ms)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 12).getTime()
}

/** Steps whole days from a day, landing on local noon, so a clock change never skips or repeats a date. */
export function stepDays(ms: number, n: number): number {
  return localNoon(localNoon(ms) + n * DAY_MS)
}

export function dayKey(ms: number): string {
  const d = new Date(ms)
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
}

/** The last `n` days ending today, oldest first, as local noons. */
export function lastDays(nowMs: number, n: number): number[] {
  const out: number[] = []
  for (let i = n - 1; i >= 0; i--) out.push(stepDays(nowMs, -i))
  return out
}

/** 1 for January 1. */
export function dayOfYear(ms: number): number {
  const d = new Date(ms)
  return Math.round((Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) - Date.UTC(d.getFullYear(), 0, 1)) / DAY_MS) + 1
}

export function rangeDays(tab: ReportTab, nowMs: number): number[] {
  if (tab === 'today') return lastDays(nowMs, 1)
  if (tab === 'week') return lastDays(nowMs, 7)
  if (tab === 'month') return lastDays(nowMs, 30)
  return lastDays(nowMs, dayOfYear(nowMs))
}

export const TAB_TITLE: Record<ReportTab, string> = {
  today: 'TODAY',
  week: 'THIS WEEK',
  month: 'THIS MONTH',
  year: 'THIS YEAR',
}

function shortDate(ms: number, withYear = false): string {
  const d = new Date(ms)
  return `${MONTHS[d.getMonth()]} ${d.getDate()}${withYear ? `, ${d.getFullYear()}` : ''}`
}

export function rangeDates(tab: ReportTab, nowMs: number): string {
  const days = rangeDays(tab, nowMs)
  const last = days[days.length - 1] ?? nowMs
  const first = days[0] ?? nowMs
  if (tab === 'today') return `${WEEKDAYS[new Date(last).getDay()]}, ${shortDate(last)}`
  const isSplit = new Date(first).getFullYear() !== new Date(last).getFullYear()
  if (tab === 'year' || isSplit) return `${shortDate(first, isSplit)} - ${shortDate(last, true)}`
  return `${shortDate(first)} - ${shortDate(last)}`
}

// ------------------------------------------------------------------- sums

export function dayTotal(rec: DayRecord | undefined): number {
  if (rec === undefined) return 0
  let sum = 0
  for (const kind of KINDS) sum += rec.kinds[kind] ?? 0
  return sum
}

export type Totals = { tasks: number; active: number; kinds: Record<Kind, number>; models: Record<string, number> }

export function addDays(days: Days, keys: readonly string[]): Totals {
  const totals: Totals = {
    tasks: 0,
    active: 0,
    kinds: { emails: 0, documents: 0, media: 0, research: 0, other: 0 },
    models: {},
  }
  for (const key of keys) {
    const rec = days[key]
    if (rec === undefined) continue
    const count = dayTotal(rec)
    totals.tasks += count
    if (count > 0) totals.active += 1
    for (const kind of KINDS) totals.kinds[kind] += rec.kinds[kind] ?? 0
    for (const [model, n] of Object.entries(rec.models)) totals.models[model] = (totals.models[model] ?? 0) + n
  }
  return totals
}

/** Adds one finished task to its day, dropping days older than KEEP_DAYS. */
export function addTask(days: Days, nowMs: number, kind: Kind, model: string): Days {
  const key = dayKey(nowMs)
  const cutoff = dayKey(stepDays(nowMs, -KEEP_DAYS))
  const out: Days = {}
  for (const [k, rec] of Object.entries(days)) if (k >= cutoff) out[k] = rec
  const rec = out[key] ?? { kinds: {}, models: {} }
  out[key] = {
    kinds: { ...rec.kinds, [kind]: (rec.kinds[kind] ?? 0) + 1 },
    models: { ...rec.models, [model]: (rec.models[model] ?? 0) + 1 },
  }
  return out
}

/** Days in a row with a finished task, ending today, or yesterday while today has none yet. */
export function streak(days: Days, nowMs: number): number {
  let at = dayTotal(days[dayKey(nowMs)]) > 0 ? 0 : -1
  let count = 0
  while (dayTotal(days[dayKey(stepDays(nowMs, at))]) > 0) {
    count += 1
    at -= 1
  }
  return count
}

export function bestDay(days: Days, keys: readonly number[]): { ms: number; count: number } | undefined {
  let best: { ms: number; count: number } | undefined
  for (const ms of keys) {
    const count = dayTotal(days[dayKey(ms)])
    if (count > 0 && (best === undefined || count > best.count)) best = { ms, count }
  }
  return best
}

export function monthTotals(days: Days, nowMs: number): number[] {
  const year = new Date(nowMs).getFullYear()
  const out = Array.from({ length: 12 }, () => 0)
  for (const [key, rec] of Object.entries(days)) {
    if (!key.startsWith(`${year}-`)) continue
    const month = Number(key.slice(5, 7)) - 1
    if (month >= 0 && month < 12) out[month] = (out[month] ?? 0) + dayTotal(rec)
  }
  return out
}

// --------------------------------------------------------------- estimate

export function minutesFor(totals: Totals, settings: Settings): Record<Kind, number> {
  const out = { emails: 0, documents: 0, media: 0, research: 0, other: 0 }
  for (const kind of KINDS) out[kind] = totals.kinds[kind] * settings.minutes[kind]
  return out
}

export function estimate(totals: Totals, settings: Settings): { hours: number; dollars: number } {
  const perKind = minutesFor(totals, settings)
  let minutes = 0
  for (const kind of KINDS) minutes += perKind[kind]
  const hours = minutes / 60
  return { hours, dollars: hours * settings.rate }
}

function withCommas(n: number): string {
  return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

export function formatHours(hrs: number): string {
  if (hrs === 0) return '0'
  if (hrs < 100) return hrs.toFixed(1)
  return withCommas(hrs)
}

export function formatMoney(dollars: number): string {
  return `$${withCommas(dollars)}`
}

// -------------------------------------------------------------- settings

export function readSettings(value: unknown): Settings {
  const raw = (typeof value === 'object' && value !== null ? value : {}) as Partial<Settings>
  const minutes = { ...DEFAULT_SETTINGS.minutes }
  for (const kind of KINDS) {
    const n = raw.minutes?.[kind]
    if (typeof n === 'number' && Number.isFinite(n) && n >= 0) minutes[kind] = n
  }
  const rate = typeof raw.rate === 'number' && Number.isFinite(raw.rate) && raw.rate >= 0 ? raw.rate : DEFAULT_SETTINGS.rate
  return { rate, minutes }
}

export function readDays(value: unknown): Days {
  if (typeof value !== 'object' || value === null) return {}
  const out: Days = {}
  for (const [key, rec] of Object.entries(value as Record<string, unknown>)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(key) || typeof rec !== 'object' || rec === null) continue
    const r = rec as Partial<DayRecord>
    out[key] = { kinds: { ...(r.kinds ?? {}) }, models: { ...(r.models ?? {}) } }
  }
  return out
}

const SETTING_KEYS: Record<string, Kind | 'rate'> = {
  rate: 'rate',
  emails: 'emails',
  email: 'emails',
  documents: 'documents',
  docs: 'documents',
  images: 'media',
  video: 'media',
  media: 'media',
  research: 'research',
  other: 'other',
}

export function describeSettings(settings: Settings): string {
  const lines = [
    'Work report settings (used for the estimate):',
    `  rate       $${settings.rate} per hour`,
    `  emails     ${settings.minutes.emails} min per task`,
    `  documents  ${settings.minutes.documents} min per task`,
    `  images     ${settings.minutes.media} min per task (images and video)`,
    `  research   ${settings.minutes.research} min per task`,
    `  other      ${settings.minutes.other} min per task`,
    'Change one with /report settings <name> <number>, e.g. /report settings rate 75',
  ]
  return lines.join('\n')
}

/** Reads `settings [name number]`; answers the new settings when they change. */
export function applySettingsArgs(words: readonly string[], settings: Settings): { settings?: Settings; text: string } {
  if (words.length === 0) return { text: describeSettings(settings) }
  const [name = '', raw = ''] = words
  const target = SETTING_KEYS[name.toLowerCase()]
  if (target === undefined) {
    return { text: `"${name}" is not a setting. Use rate, emails, documents, images, research or other.` }
  }
  const value = Number(raw.replace(/^\$/, ''))
  if (raw === '' || !Number.isFinite(value) || value < 0 || value > 100_000) {
    return { text: `Give ${name} a number, e.g. /report settings ${name} ${target === 'rate' ? 75 : 15}` }
  }
  if (target === 'rate') {
    return { settings: { ...settings, rate: value }, text: `Hourly rate is now $${value} (used for the estimate).` }
  }
  return {
    settings: { ...settings, minutes: { ...settings.minutes, [target]: value } },
    text: `${KIND_LABEL[target]} now count ${value} minutes per task (used for the estimate).`,
  }
}

// ------------------------------------------------------------------ models

export function prettyModel(id: string): string {
  const m = /claude-(opus|sonnet|haiku|fable)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?/i.exec(id)
  if (m === null) return id
  const family = (m[1] ?? '').charAt(0).toUpperCase() + (m[1] ?? '').slice(1).toLowerCase()
  return m[3] !== undefined ? `${family} ${m[2]}.${m[3]}` : `${family} ${m[2]}`
}

// ---------------------------------------------------------------- drawing

export const GLYPHS: Record<string, readonly [string, string, string]> = {
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
  '.': [' ', ' ', '╻'],
  ',': [' ', ' ', '┛'],
  $: ['┏╋╸', '┗╋┓', '╺╋┛'],
}

export function bigWidth(text: string): number {
  let width = 0
  for (const ch of text) width += (GLYPHS[ch]?.[0].length ?? 1) + 1
  return Math.max(0, width - 1)
}

/** Three rows of heavy box-drawing numerals; undefined when a character has no glyph. */
export function bigRows(text: string): [string, string, string] | undefined {
  const rows: [string, string, string] = ['', '', '']
  let first = true
  for (const ch of text) {
    const glyph = GLYPHS[ch]
    if (glyph === undefined) return undefined
    for (let r = 0; r < 3; r++) rows[r] += (first ? '' : ' ') + glyph[r]
    first = false
  }
  return rows
}

export type Bar = { label: string; value: number; isCurrent: boolean; isFuture: boolean }

export function chartBars(tab: ReportTab, days: Days, nowMs: number): Bar[] {
  if (tab === 'year') {
    const totals = monthTotals(days, nowMs)
    const month = new Date(nowMs).getMonth()
    return MONTHS.map((label, i) => ({ label, value: totals[i] ?? 0, isCurrent: i === month, isFuture: i > month }))
  }
  const span = tab === 'month' ? 30 : 7
  const list = lastDays(nowMs, span)
  return list.map((ms, i) => ({
    label: tab === 'month' ? String(new Date(ms).getDate()) : WEEKDAYS[new Date(ms).getDay()] ?? '',
    value: dayTotal(days[dayKey(ms)]),
    isCurrent: i === list.length - 1,
    isFuture: false,
  }))
}

export type Cell = { text: string; tone: 'bar' | 'current' | 'base' | 'none' }

const EIGHTHS = [' ', '▁', '▂', '▃', '▄', '▅', '▆', '▇', '█']

/** The chart's three bar rows (top first) and its label row, each at most `columns` wide. */
export function chartRows(all: readonly Bar[], columns: number): { rows: Cell[][]; labels: string } {
  const bars = all.length > columns ? all.slice(-Math.max(1, columns)) : all
  const n = Math.max(1, bars.length)
  const slot = Math.max(1, Math.floor(columns / n))
  const barWidth = slot >= 3 ? Math.min(slot - 1, 5) : 1
  const gap = slot - barWidth
  const peak = Math.max(1, ...bars.map(bar => bar.value))
  const rows: Cell[][] = [[], [], []]
  for (const bar of bars) {
    const level = bar.value > 0 ? Math.max(1, Math.round((bar.value / peak) * 24)) : 0
    for (let r = 0; r < 3; r++) {
      const eighths = Math.min(8, Math.max(0, level - (2 - r) * 8))
      let cell: Cell
      if (bar.isFuture) cell = { text: ' '.repeat(barWidth), tone: 'none' }
      else if (level === 0) cell = { text: (r === 2 ? '▁' : ' ').repeat(barWidth), tone: r === 2 ? 'base' : 'none' }
      else cell = { text: (EIGHTHS[eighths] ?? ' ').repeat(barWidth), tone: bar.isCurrent ? 'current' : 'bar' }
      rows[r]?.push(cell)
      if (gap > 0) rows[r]?.push({ text: ' '.repeat(gap), tone: 'none' })
    }
  }
  // Labels: each placed at its slot's start when it fits without touching the one before.
  const width = slot * n
  const chars = Array.from({ length: width }, () => ' ')
  let freeFrom = 0
  bars.forEach((bar, i) => {
    const start = i * slot
    const room = n <= 12 ? slot - (slot > 1 ? 1 : 0) : width - start
    const label = n <= 12 ? bar.label.slice(0, Math.max(1, room)) : bar.label
    if (start < freeFrom || start + label.length > width) return
    for (let c = 0; c < label.length; c++) chars[start + c] = label[c] ?? ' '
    freeFrom = start + label.length + 1
  })
  return { rows, labels: chars.join('').trimEnd() }
}

/** How many tiles fit across `columns`: three, then two, then one. */
export function tileCount(columns: number): 1 | 2 | 3 {
  if (columns >= 66) return 3
  if (columns >= 40) return 2
  return 1
}

export function padEnd(text: string, width: number): string {
  if (width <= 0) return ''
  if (text.length > width) return width > 1 ? `${text.slice(0, width - 1)}…` : text.slice(0, width)
  return text + ' '.repeat(width - text.length)
}

export function padStart(text: string, width: number): string {
  if (width <= 0) return ''
  if (text.length >= width) return text.slice(0, width)
  return ' '.repeat(width - text.length) + text
}

export function emptyText(tab: ReportTab): string {
  if (tab === 'today') return 'Nothing finished yet today. Your first finished task shows up here.'
  if (tab === 'week') return 'Nothing finished in the last 7 days. Your first finished task shows up here.'
  if (tab === 'month') return 'Nothing finished in the last 30 days. Your first finished task shows up here.'
  return 'Nothing finished yet this year. Your first finished task shows up here.'
}

/** Breaks text into rows no wider than `width`, at spaces. */
export function wrapWords(text: string, width: number): string[] {
  const rows: string[] = []
  let row = ''
  for (const word of text.split(' ')) {
    const next = row === '' ? word : `${row} ${word}`
    if (next.length <= width || row === '') row = next.slice(0, Math.max(1, width))
    else {
      rows.push(row)
      row = word.slice(0, Math.max(1, width))
    }
  }
  if (row !== '') rows.push(row)
  return rows
}

export function monthName(index: number): string {
  return MONTHS[index] ?? ''
}

export function shortDay(ms: number): string {
  return shortDate(ms)
}

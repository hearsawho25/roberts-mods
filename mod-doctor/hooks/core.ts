/** Mod Doctor's pure logic: no `$`, no engine. See docs/DESIGN.md. */

export const SELF = 'mod-doctor'
const MAX_ERROR_LINES = 3

/** An enabled plugin from `claude plugin list --json`. */
export type ExpectedEntry = {
  id: string
  name: string
  version: string | null
  /** readFromFolder when set, else installPath. */
  folder: string
  folderVersion: string | null
  isReadFromFolder: boolean
}

/** `relay@roberts-mods` → `relay`. */
export function nameFromId(id: string): string {
  const at = id.lastIndexOf('@')
  return at > 0 ? id.slice(0, at) : id
}

function stripBom(s: string): string {
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v !== '' ? v : null
}

/** The enabled entries of `claude plugin list --json`. Throws on JSON that isn't an array. */
export function parsePluginList(json: string): ExpectedEntry[] {
  const raw: unknown = JSON.parse(stripBom(json))
  if (!Array.isArray(raw)) throw new Error('plugin list is not an array')
  const out: ExpectedEntry[] = []
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue
    const o = item as Record<string, unknown>
    const id = str(o['id'])
    if (id === null || o['enabled'] !== true) continue
    const fromFolder = str(o['readFromFolder'])
    const folder = fromFolder ?? str(o['installPath'])
    if (folder === null) continue
    out.push({
      id,
      name: nameFromId(id),
      version: str(o['version']),
      folder,
      folderVersion: str(o['folderVersion']),
      isReadFromFolder: fromFolder !== null,
    })
  }
  return out
}

/** Whether a hooks/hooks.json names at least one hooks module. */
export function hasHooksModule(text: string): boolean {
  try {
    const j: unknown = JSON.parse(stripBom(text))
    const modules = typeof j === 'object' && j !== null ? (j as Record<string, unknown>)['modules'] : undefined
    return Array.isArray(modules) && modules.length > 0
  } catch {
    return false
  }
}

/** Adds an engine.create or plugin.register list to the loaded set. A list holding only Mod Doctor (its own reload) adds nothing. */
export function mergeLoaded(prev: readonly string[], plugins: readonly string[]): string[] {
  if (plugins.every(p => p === SELF)) return [...prev]
  return [...new Set([...prev, ...plugins])].sort()
}

/**
 * The plugins whose hooks module is running now, as the command list shows: one that owns a
 * bare-named plugin command registered it through `$.command.register` (skill and manifest
 * commands are namespaced `<plugin>:<name>`). A reload's newcomers raise no plugin.register
 * for a plugin already loaded (probed 2026-10-15), so this is what keeps the loaded set true.
 */
export function commandOwners(list: readonly { name: string; plugin?: string; source: string }[]): string[] {
  const owners = new Set<string>()
  for (const c of list) {
    if (c.source === 'plugin' && c.plugin !== undefined && !c.name.includes(':')) owners.add(c.plugin)
  }
  return [...owners].sort()
}

/** Whether a plugin.register provenance is a `--plugin-dir` load (`<name>@inline`) of a mod other than Mod Doctor. */
export function isInlineProvenance(name: string, provenance: string): boolean {
  return name !== SELF && provenance.endsWith('@inline')
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** The error lines of `claude plugin validate` output, at most three, with paths under `root` made relative. */
export function parseValidate(stdout: string, root: string): string[] {
  const lines = stdout.split(/\r?\n/).map(l => l.replace(/\x1b\[[0-9;]*m/g, ''))
  const trimmedRoot = root.replace(/[\\/]+$/, '')
  const rootPattern =
    trimmedRoot === ''
      ? null
      : new RegExp(`${trimmedRoot.split(/[\\/]/).map(escapeRegExp).join('[\\\\/]')}[\\\\/]`, 'gi')
  const out: string[] = []
  let inErrors = false
  for (const line of lines) {
    const t = line.trim()
    if (/^✘ Found \d+ errors?:/.test(t)) {
      inErrors = true
      continue
    }
    if (t.startsWith('✘') || t.startsWith('✔') || t.startsWith('⚠')) {
      inErrors = false
      continue
    }
    if (!inErrors || !t.startsWith('❯')) continue
    let text = t.slice(1).trim().replace(/^modules\S*: [^\s:]+: /, '')
    if (rootPattern !== null) text = text.replace(rootPattern, '')
    out.push(text)
    if (out.length === MAX_ERROR_LINES) break
  }
  return out
}

export type Validation = { ok: true } | { ok: false; errors: string[] } | { ok: null; reason: string }
export type ModStatus = 'loaded' | 'not-loaded' | 'broken'
export type ModReport = {
  name: string
  version: string | null
  status: ModStatus
  errors: string[]
  note: string | null
  drift: { folder: string; record: string } | null
  /** Slash command names without the `/`. */
  commands: string[]
}
export type Report = {
  checkedAt: number
  mods: ModReport[]
  /** `--plugin-dir` mods heard through plugin.register (provenance `@inline`). */
  inline: string[]
  /** Enabled plugins with no hooks module. */
  skipped: number
  /** Set when the check itself could not run. */
  error: string | null
}
export type Tone = 'ok' | 'bad' | 'warn' | 'muted'
export type PaneLine = { tone: Tone; text: string; isDetail?: true }

const MAX_COMMANDS = 3

export function diagnose(input: {
  expected: readonly ExpectedEntry[]
  loaded: readonly string[]
  validations: Readonly<Record<string, Validation>>
  commands: Readonly<Record<string, readonly string[]>>
  inline: readonly string[]
  skipped: number
  checkedAt: number
}): Report {
  const loaded = new Set(input.loaded)
  const mods = input.expected.map((e): ModReport => {
    const v = input.validations[e.name]
    const isLoaded = loaded.has(e.name)
    const status: ModStatus = !isLoaded ? 'not-loaded' : v?.ok === false ? 'broken' : 'loaded'
    const note =
      v?.ok === null ? `couldn't validate: ${v.reason}` : !isLoaded && v?.ok === true ? 'validate passes; try /reload-plugins' : null
    const drift =
      e.isReadFromFolder && e.folderVersion !== null && e.version !== null && e.folderVersion !== e.version
        ? { folder: e.folderVersion, record: e.version }
        : null
    return { name: e.name, version: e.version, status, errors: v?.ok === false ? v.errors : [], note, drift, commands: [...(input.commands[e.name] ?? [])] }
  })
  mods.sort((a, b) => Number(a.status === 'loaded') - Number(b.status === 'loaded') || a.name.localeCompare(b.name))
  return { checkedAt: input.checkedAt, mods, inline: [...input.inline], skipped: input.skipped, error: null }
}

function problems(report: Report): ModReport[] {
  return report.mods.filter(m => m.status !== 'loaded')
}

/** The band row's text, or null when nothing is wrong (or the check couldn't run). */
export function rowText(report: Report): string | null {
  const bad = problems(report)
  if (report.error !== null || bad.length === 0) return null
  const names = bad.slice(0, 2).map(m => m.name).join(', ')
  const more = bad.length > 2 ? ` +${bad.length - 2}` : ''
  const one = bad.length === 1
  const count = `${bad.length} ${one ? 'mod' : 'mods'}`
  const what = bad.every(m => m.status === 'not-loaded')
    ? "didn't load"
    : bad.every(m => m.status === 'broken')
      ? one
        ? 'is broken'
        : 'are broken'
      : 'have problems'
  return `✗ Mod Doctor  ${count} ${what}: ${names}${more}`
}

/** The toast for a mod with a problem. */
export function toastText(m: ModReport): string {
  return m.status === 'broken'
    ? `Mod Doctor: ${m.name} is broken on disk — /mod-doctor for why`
    : `Mod Doctor: ${m.name} didn't load — /mod-doctor for why`
}

const STATUS_WORDS: Record<Exclude<ModStatus, 'loaded'>, string> = { 'not-loaded': 'not loaded', broken: 'broken on disk' }

/** A loaded mod's line: up to three commands, or one plus `+N` where that would be wider than `columns`. */
function loadedLine(m: ModReport, columns: number | undefined): string {
  const head = `✓ ${m.name}${m.version !== null ? `  ${m.version}` : ''}`
  const withCommands = (max: number) => {
    const shown = m.commands.slice(0, max).map(c => `/${c}`).join(' ')
    const more = m.commands.length > max ? ` +${m.commands.length - max}` : ''
    return shown === '' ? head : `${head}  · ${shown}${more}`
  }
  const full = withCommands(MAX_COMMANDS)
  return columns !== undefined && full.length > columns ? withCommands(1) : full
}

/** The pane's lines; `time` is the check's local time, e.g. `12:41`; `columns` the pane's width, when known. */
export function paneLines(report: Report, time: string, columns?: number): PaneLine[] {
  if (report.error !== null) return [{ tone: 'bad', text: `couldn't check: ${report.error}` }]
  const count = report.mods.length
  const bad = problems(report).length
  const lines: PaneLine[] = [
    { tone: 'muted', text: `Checked ${time} · ${count} ${count === 1 ? 'mod' : 'mods'} · ${bad} ${bad === 1 ? 'problem' : 'problems'}` },
  ]
  for (const m of report.mods) {
    if (m.status === 'loaded') {
      lines.push({ tone: 'ok', text: loadedLine(m, columns) })
    } else {
      lines.push({ tone: 'bad', text: `✗ ${m.name}  ${STATUS_WORDS[m.status]}` })
    }
    for (const err of m.errors) lines.push({ tone: 'bad', text: `    ${err}`, isDetail: true })
    if (m.note !== null) lines.push({ tone: 'muted', text: `    ${m.note}`, isDetail: true })
    if (m.drift !== null) lines.push({ tone: 'warn', text: `    ⚠ folder is ${m.drift.folder}, on record ${m.drift.record}`, isDetail: true })
  }
  const listed = new Set(report.mods.map(m => m.name))
  for (const name of report.inline.filter(n => !listed.has(n))) lines.push({ tone: 'ok', text: `✓ ${name}  dev folder` })
  lines.push({ tone: 'muted', text: `${report.skipped} skipped (no hooks module)` })
  return lines
}

/** A check's local time as `HH:MM`; `--:--` for 0, a check made with no clock. */
export function hhmm(ms: number): string {
  if (ms <= 0) return '--:--'
  const at = new Date(ms)
  return `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`
}

/** Plain text for Copy report. */
export function reportText(report: Report, time: string): string {
  return ['Mod Doctor report', ...paneLines(report, time).map(l => l.text)].join('\n')
}

/** One toast per mod, status and first reason per session. */
export function toastKey(m: ModReport): string {
  return `${m.name}|${m.status}|${m.errors[0] ?? m.note ?? ''}`
}

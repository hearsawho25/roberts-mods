/** One fenced block of a reply: the text a copy puts on the clipboard, and where the block ends. */
export type Block = {
  /** The lines between the fences, verbatim: no fence lines, no added indent. */
  text: string
  /** The fence's info string (`bash`, `json`), '' when it has none. */
  language: string
  /** The index into the source just past the closing fence's line (or the end, while one streams unclosed). */
  end: number
  /** False while the closing fence has not arrived yet. */
  isClosed: boolean
}

const OPENER = /^( {0,3})(`{3,}|~{3,})[ \t]*([^\n`]*)$/

/** Finds every fenced block in markdown, CommonMark's way: a run of 3+ backticks or tildes opens, a run as long or longer of the same closes. */
export function findBlocks(markdown: string): Block[] {
  const blocks: Block[] = []
  const lines = markdown.split('\n')
  let offset = 0
  let open: { fence: string; indent: number; language: string; body: string[] } | null = null

  for (const raw of lines) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw
    const lineEnd = offset + raw.length + 1
    if (open === null) {
      const m = OPENER.exec(line)
      if (m !== null) {
        open = { fence: m[2] ?? '```', indent: (m[1] ?? '').length, language: (m[3] ?? '').trim().split(/\s+/)[0] ?? '', body: [] }
      }
    } else {
      const trimmed = line.replace(/^ {0,3}/, '')
      const fenceChar = open.fence[0] ?? '`'
      const closer = new RegExp(`^\\${fenceChar}{${open.fence.length},}[ \\t]*$`)
      if (closer.test(trimmed)) {
        blocks.push({ text: open.body.join('\n'), language: open.language, end: Math.min(lineEnd, markdown.length), isClosed: true })
        open = null
      } else {
        open.body.push(stripIndent(line, open.indent))
      }
    }
    offset = lineEnd
  }
  if (open !== null) {
    blocks.push({ text: open.body.join('\n'), language: open.language, end: markdown.length, isClosed: false })
  }
  return blocks
}

/** A fence indented by N spaces strips up to N from each content line, as CommonMark does. */
function stripIndent(line: string, indent: number): string {
  let i = 0
  while (i < indent && line[i] === ' ') i += 1
  return line.slice(i)
}

/** Cuts markdown into pieces that each end with one fenced block, and a last piece of whatever prose follows. */
export function splitAfterBlocks(markdown: string): { text: string; block?: Block }[] {
  const out: { text: string; block?: Block }[] = []
  let start = 0
  for (const block of findBlocks(markdown)) {
    out.push({ text: markdown.slice(start, block.end).replace(/\n+$/, ''), block })
    start = block.end
  }
  const rest = markdown.slice(start).replace(/^\n+/, '')
  if (rest.trim() !== '') out.push({ text: rest })
  return out
}

/** The block `n` back from the last (1 = the last) across replies, oldest first. */
export function pickBlock(replies: readonly string[], n: number): Block | undefined {
  const all = replies.flatMap(text => findBlocks(text))
  return all[all.length - n]
}

/** `/copyblock`'s argument: blank is 1, else a whole number 1 or more; anything else is undefined. */
export function parseIndex(args: string): number | undefined {
  const t = args.trim()
  if (t === '') return 1
  return /^\d+$/.test(t) && Number(t) >= 1 ? Number(t) : undefined
}

export function describeBlock(block: Block): string {
  const lines = block.text === '' ? 0 : block.text.split('\n').length
  return `${lines} line${lines === 1 ? '' : 's'}${block.language === '' ? '' : ` of ${block.language}`}`
}

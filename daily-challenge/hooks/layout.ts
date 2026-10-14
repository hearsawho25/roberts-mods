// Pure sizing for the pane: every row is measured against the body width here,
// so the drawing never relies on the surface wrapping or cutting text.

export const COLORS = {
  gold: '#F2C46D',
  line: '#262B33',
  muted: '#7D8590',
  text: '#E6EDF3',
  green: '#3DD68C',
  amber: '#E3B341',
  ink: '#0D1117',
} as const

export const TITLE = 'DAILY CHALLENGE'

const DIGITS: Record<string, readonly [string, string, string]> = {
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
export function bigNumber(value: number): [string, string, string] {
  const glyphs = String(Math.max(0, Math.floor(value)))
    .split('')
    .map(digit => DIGITS[digit] ?? DIGITS['0']!)
  return [0, 1, 2].map(row => glyphs.map(glyph => glyph[row]).join(' ')) as [string, string, string]
}

/** Greedy word wrap to `width` columns; a word longer than the width is cut. */
export function wrap(text: string, width: number): string[] {
  const room = Math.max(1, width)
  const lines: string[] = []
  let line = ''
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const piece = word.length > room ? word.slice(0, room) : word
    if (line === '') line = piece
    else if (line.length + 1 + piece.length <= room) line += ` ${piece}`
    else {
      lines.push(line)
      line = piece
    }
  }
  if (line !== '') lines.push(line)
  return lines.length === 0 ? [''] : lines
}

export function fit(text: string, width: number): string {
  return text.length <= width ? text : text.slice(0, Math.max(0, width))
}

/** The gold rule under the title, as long as the title, then the hairline to the edge. */
export function titleRule(cols: number): { gold: string; hairline: string } {
  const goldWidth = Math.min(TITLE.length, cols)
  return { gold: '━'.repeat(goldWidth), hairline: '─'.repeat(Math.max(0, cols - goldWidth)) }
}

/** A section heading in capitals followed by a hairline to the edge. */
export function heading(label: string, cols: number): { label: string; hairline: string } {
  const text = fit(label.toUpperCase(), cols)
  const rest = cols - text.length - 1
  return { label: text, hairline: rest > 0 ? ` ${'─'.repeat(rest)}` : '' }
}

export type TileLayout = { direction: 'row' | 'column'; width: number }

export const TILE_LABELS = ['DAY STREAK', 'COMPLETED / 365', 'BEST STREAK'] as const

/** Tiles side by side when three fit, else stacked at full width. */
export function tileLayout(cols: number): TileLayout {
  const inner = Math.max(...TILE_LABELS.map(label => label.length), bigNumber(365)[0].length)
  const minimum = inner + 4
  const sideBySide = Math.floor((cols - 2) / 3)
  if (sideBySide >= minimum) return { direction: 'row', width: sideBySide }
  return { direction: 'column', width: cols }
}

export type Chip = { key: string; label: string }

/** Buttons on one row with a space between when they fit, else one per row. */
export function chipRows(chips: readonly Chip[], cols: number): Chip[][] {
  const total = chips.reduce((sum, chip) => sum + chip.label.length + 2, 0) + Math.max(0, chips.length - 1)
  if (total <= cols) return [chips.slice()]
  return chips.map(chip => [chip])
}

/** How many day cells fit and how wide each is: up to 14, two to four columns each. */
export function dayGrid(cols: number): { count: number; cell: number } {
  const count = Math.max(1, Math.min(14, Math.floor(cols / 2)))
  const cell = Math.max(2, Math.min(4, Math.floor(cols / count)))
  return { count, cell }
}

export function dayLabel(weekday: string, cell: number): string {
  return weekday.slice(0, cell >= 3 ? 2 : 1)
}

/** The year bar's filled and empty widths; any progress shows at least one cell. */
export function yearBar(done: number, total: number, cols: number): { filled: number; empty: number } {
  const raw = Math.round((done / total) * cols)
  const filled = Math.min(cols, done > 0 ? Math.max(1, raw) : 0)
  return { filled, empty: cols - filled }
}

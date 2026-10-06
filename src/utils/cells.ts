import type { CellCoord, CellRange } from '../types/sheet'

export function columnLabel(index: number): string {
  let value = index + 1
  let label = ''
  while (value > 0) {
    const remainder = (value - 1) % 26
    label = String.fromCharCode(65 + remainder) + label
    value = Math.floor((value - 1) / 26)
  }
  return label
}

export function columnIndex(label: string): number {
  return label.toUpperCase().split('').reduce((sum, char) => sum * 26 + char.charCodeAt(0) - 64, 0) - 1
}

export function cellId(row: number, col: number): string {
  return `${columnLabel(col)}${row + 1}`
}

export function parseCellId(id: string): CellCoord | null {
  const match = /^\$?([A-Z]+)\$?(\d+)$/i.exec(id.trim())
  if (!match) return null
  return { col: columnIndex(match[1]), row: Number(match[2]) - 1 }
}

export function normalizeRange(range: CellRange): CellRange {
  return {
    start: {
      row: Math.min(range.start.row, range.end.row),
      col: Math.min(range.start.col, range.end.col),
    },
    end: {
      row: Math.max(range.start.row, range.end.row),
      col: Math.max(range.start.col, range.end.col),
    },
  }
}

export function rangeContains(range: CellRange, row: number, col: number): boolean {
  const normalized = normalizeRange(range)
  return row >= normalized.start.row && row <= normalized.end.row && col >= normalized.start.col && col <= normalized.end.col
}

export function expandRange(startId: string, endId: string): string[] {
  const start = parseCellId(startId)
  const end = parseCellId(endId)
  if (!start || !end) return []
  const range = normalizeRange({ start, end })
  const ids: string[] = []
  for (let row = range.start.row; row <= range.end.row; row += 1) {
    for (let col = range.start.col; col <= range.end.col; col += 1) {
      ids.push(cellId(row, col))
    }
  }
  return ids
}

export function literalValue(raw: string): string | number | boolean | null {
  const trimmed = raw.trim()
  if (!trimmed) return null
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed)
  if (/^(true|false)$/i.test(trimmed)) return trimmed.toLowerCase() === 'true'
  return raw
}

export function displayValue(value: unknown): string {
  if (value === null || value === undefined || value === '') return ''
  if (typeof value === 'number') return Number.isInteger(value) ? value.toLocaleString('zh-CN') : value.toFixed(4).replace(/0+$/, '').replace(/\.$/, '')
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE'
  return String(value)
}

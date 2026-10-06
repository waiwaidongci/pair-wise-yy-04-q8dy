import type { CellRef, FormulaAst, FormulaErrorCode } from '../types/sheet'
import { cellId, columnIndex, columnLabel, expandRange } from './cells'

type TokenType = 'number' | 'string' | 'reference' | 'identifier' | 'operator' | 'leftParen' | 'rightParen' | 'comma' | 'colon' | 'error'

interface Token {
  type: TokenType
  value: string
}

export class FormulaError extends Error {
  constructor(public code: FormulaErrorCode | string) {
    super(code)
  }
}

function tokenize(input: string): Token[] {
  const tokens: Token[] = []
  let index = 0
  while (index < input.length) {
    const char = input[index]
    if (/\s/.test(char)) {
      index += 1
      continue
    }
    if (char === '"') {
      let value = ''
      index += 1
      while (index < input.length && input[index] !== '"') {
        if (input[index] === '\\' && index + 1 < input.length) index += 1
        value += input[index]
        index += 1
      }
      if (input[index] !== '"') throw new FormulaError('#PARSE!')
      index += 1
      tokens.push({ type: 'string', value })
      continue
    }
    const errorLiteral = /^#(REF!|NAME\?|VALUE!|DIV\/0!|CYCLE!|PARSE!|FORMULA!|NULL!|NUM!|N\/A)/i.exec(input.slice(index))
    if (errorLiteral) {
      tokens.push({ type: 'error', value: errorLiteral[0].toUpperCase() })
      index += errorLiteral[0].length
      continue
    }
    const number = /^-?\d+(\.\d+)?/.exec(input.slice(index))
    if (number) {
      tokens.push({ type: 'number', value: number[0] })
      index += number[0].length
      continue
    }
    const reference = /^\$?[A-Z]+\$?\d+/i.exec(input.slice(index))
    if (reference) {
      tokens.push({ type: 'reference', value: reference[0].toUpperCase() })
      index += reference[0].length
      continue
    }
    const identifier = /^[A-Z_][A-Z0-9_]*/i.exec(input.slice(index))
    if (identifier) {
      tokens.push({ type: 'identifier', value: identifier[0].toUpperCase() })
      index += identifier[0].length
      continue
    }
    const twoChar = input.slice(index, index + 2)
    if (['<=', '>=', '<>'].includes(twoChar)) {
      tokens.push({ type: 'operator', value: twoChar })
      index += 2
      continue
    }
    if ('+-*/^%=<>'.includes(char)) {
      tokens.push({ type: 'operator', value: char })
      index += 1
      continue
    }
    if (char === '(') tokens.push({ type: 'leftParen', value: char })
    else if (char === ')') tokens.push({ type: 'rightParen', value: char })
    else if (char === ',') tokens.push({ type: 'comma', value: char })
    else if (char === ':') tokens.push({ type: 'colon', value: char })
    else throw new FormulaError('#PARSE!')
    index += 1
  }
  return tokens
}

const BINARY_PRECEDENCE: Record<string, number> = {
  '=': 5, '<>': 5, '<': 5, '>': 5, '<=': 5, '>=': 5,
  '+': 10, '-': 10, '*': 20, '/': 20, '%': 20, '^': 30,
}

function parseReference(text: string): CellRef {
  const match = /^(\$?)([A-Z]+)(\$?)(\d+)$/i.exec(text.trim())
  if (!match) throw new FormulaError('#PARSE!')
  return {
    col: columnIndex(match[2]),
    row: Number(match[4]) - 1,
    colAbs: match[1] === '$',
    rowAbs: match[3] === '$',
  }
}

export function formatRef(ref: CellRef): string {
  return `${ref.colAbs ? '$' : ''}${columnLabel(ref.col)}${ref.rowAbs ? '$' : ''}${ref.row + 1}`
}

class Parser {
  private index = 0

  constructor(private tokens: Token[]) {}

  parse(): FormulaAst {
    const ast = this.expression(0)
    if (this.peek()) throw new FormulaError('#PARSE!')
    return ast
  }

  private peek() {
    return this.tokens[this.index]
  }

  private consume() {
    return this.tokens[this.index++]
  }

  private expression(minPrecedence: number): FormulaAst {
    let left = this.unary()
    while (this.peek()?.type === 'operator' && (BINARY_PRECEDENCE[this.peek().value] ?? -1) >= minPrecedence) {
      const operator = this.consume().value
      const nextMin = operator === '^' ? BINARY_PRECEDENCE[operator] : BINARY_PRECEDENCE[operator] + 1
      const right = this.expression(nextMin)
      left = { type: 'binary', operator, left, right }
    }
    return left
  }

  private unary(): FormulaAst {
    const token = this.peek()
    if (token?.type === 'operator' && (token.value === '+' || token.value === '-')) {
      this.consume()
      return { type: 'unary', operator: token.value, left: this.unary() }
    }
    return this.primary()
  }

  private primary(): FormulaAst {
    const token = this.consume()
    if (!token) throw new FormulaError('#PARSE!')
    if (token.type === 'number') return { type: 'number', value: Number(token.value) }
    if (token.type === 'string') return { type: 'string', value: token.value }
    if (token.type === 'error') return { type: 'error', value: token.value }
    if (token.type === 'reference') {
      const ref = parseReference(token.value)
      if (this.peek()?.type === 'colon') {
        this.consume()
        const end = this.consume()
        if (end?.type !== 'reference') throw new FormulaError('#PARSE!')
        return { type: 'range', startRef: ref, endRef: parseReference(end.value) }
      }
      return { type: 'reference', ref }
    }
    if (token.type === 'identifier') {
      if (token.value === 'TRUE' || token.value === 'FALSE') return { type: 'boolean', value: token.value === 'TRUE' }
      if (this.peek()?.type !== 'leftParen') throw new FormulaError('#NAME?')
      this.consume()
      const args: FormulaAst[] = []
      if (this.peek()?.type !== 'rightParen') {
        do {
          args.push(this.expression(0))
          if (this.peek()?.type !== 'comma') break
          this.consume()
        } while (true)
      }
      if (this.consume()?.type !== 'rightParen') throw new FormulaError('#PARSE!')
      return { type: 'function', name: token.value, args }
    }
    if (token.type === 'leftParen') {
      const ast = this.expression(0)
      if (this.consume()?.type !== 'rightParen') throw new FormulaError('#PARSE!')
      return ast
    }
    throw new FormulaError('#PARSE!')
  }
}

export function parseFormula(formula: string): FormulaAst {
  if (!formula.startsWith('=')) throw new FormulaError('#FORMULA!')
  return new Parser(tokenize(formula.slice(1))).parse()
}

function formatAst(ast: FormulaAst, parentPrec = 0): string {
  switch (ast.type) {
    case 'number': return String(ast.value)
    case 'string': return `"${String(ast.value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
    case 'boolean': return ast.value ? 'TRUE' : 'FALSE'
    case 'error': return String(ast.value)
    case 'reference': return formatRef(ast.ref!)
    case 'range': return `${formatRef(ast.startRef!)}:${formatRef(ast.endRef!)}`
    case 'unary': return `${ast.operator}${formatAst(ast.left!, 100)}`
    case 'binary': {
      const prec = BINARY_PRECEDENCE[ast.operator!] ?? 0
      const rightMin = ast.operator === '^' ? prec : prec + 1
      const text = `${formatAst(ast.left!, prec)}${ast.operator}${formatAst(ast.right!, rightMin)}`
      return prec < parentPrec ? `(${text})` : text
    }
    case 'function': return `${ast.name}(${(ast.args ?? []).map((arg) => formatAst(arg, 0)).join(',')})`
  }
}

export function formatFormula(ast: FormulaAst): string {
  return `=${formatAst(ast)}`
}

function flatten(value: unknown): unknown[] {
  return Array.isArray(value) ? value.flatMap(flatten) : [value]
}

function numberValue(value: unknown): number {
  if (typeof value === 'number') return value
  if (typeof value === 'boolean') return value ? 1 : 0
  if (value === null || value === undefined || value === '') return 0
  if (typeof value === 'string' && /^-?\d+(\.\d+)?$/.test(value.trim())) return Number(value)
  throw new FormulaError('#VALUE!')
}

function scalar(value: unknown): unknown {
  if (Array.isArray(value)) return value[0] ?? null
  return value
}

export function evaluateAst(ast: FormulaAst, resolveRef: (id: string) => unknown, resolveRange: (range: string) => unknown[]): unknown {
  if (ast.type === 'number' || ast.type === 'string' || ast.type === 'boolean') return ast.value
  if (ast.type === 'error') throw new FormulaError(String(ast.value))
  if (ast.type === 'reference') return resolveRef(cellId(ast.ref!.row, ast.ref!.col))
  if (ast.type === 'range') {
    const start = cellId(ast.startRef!.row, ast.startRef!.col)
    const end = cellId(ast.endRef!.row, ast.endRef!.col)
    return resolveRange(`${start}:${end}`)
  }
  if (ast.type === 'unary') {
    const value = numberValue(evaluateAst(ast.left!, resolveRef, resolveRange))
    return ast.operator === '-' ? -value : value
  }
  if (ast.type === 'binary') {
    const left = scalar(evaluateAst(ast.left!, resolveRef, resolveRange))
    const right = scalar(evaluateAst(ast.right!, resolveRef, resolveRange))
    if (ast.operator === '=') return left === right
    if (ast.operator === '<>') return left !== right
    if (ast.operator === '<') return numberValue(left) < numberValue(right)
    if (ast.operator === '>') return numberValue(left) > numberValue(right)
    if (ast.operator === '<=') return numberValue(left) <= numberValue(right)
    if (ast.operator === '>=') return numberValue(left) >= numberValue(right)
    const a = numberValue(left)
    const b = numberValue(right)
    if (ast.operator === '+') return a + b
    if (ast.operator === '-') return a - b
    if (ast.operator === '*') return a * b
    if (ast.operator === '/') {
      if (b === 0) throw new FormulaError('#DIV/0!')
      return a / b
    }
    if (ast.operator === '%') return a % b
    if (ast.operator === '^') return a ** b
  }
  if (ast.type === 'function') {
    const args = (ast.args ?? []).map((arg) => evaluateAst(arg, resolveRef, resolveRange))
    const flat = args.flatMap(flatten)
    const numbers = () => flat
      .filter((value) => value !== null && value !== '' && value !== undefined && typeof value !== 'boolean')
      .map(numberValue)
    switch (ast.name) {
      case 'SUM': return numbers().reduce((sum, value) => sum + value, 0)
      case 'AVERAGE': {
        const values = numbers()
        if (!values.length) throw new FormulaError('#DIV/0!')
        return values.reduce((sum, value) => sum + value, 0) / values.length
      }
      case 'MIN': return numbers().length ? Math.min(...numbers()) : 0
      case 'MAX': return numbers().length ? Math.max(...numbers()) : 0
      case 'COUNT': return numbers().length
      case 'ABS': return Math.abs(numberValue(scalar(args[0])))
      case 'ROUND': {
        const value = numberValue(scalar(args[0]))
        const digits = args.length > 1 ? numberValue(scalar(args[1])) : 0
        const factor = 10 ** digits
        return Math.round(value * factor) / factor
      }
      case 'IF': {
        const condition = scalar(args[0])
        return condition ? args[1] : args[2]
      }
      default: throw new FormulaError('#NAME?')
    }
  }
  throw new FormulaError('#VALUE!')
}

export function collectDependencies(ast: FormulaAst, result = new Set<string>()): Set<string> {
  if (ast.type === 'reference' && ast.ref) result.add(cellId(ast.ref.row, ast.ref.col))
  if (ast.type === 'range' && ast.startRef && ast.endRef) {
    expandRange(cellId(ast.startRef.row, ast.startRef.col), cellId(ast.endRef.row, ast.endRef.col)).forEach((id) => result.add(id))
  }
  if (ast.left) collectDependencies(ast.left, result)
  if (ast.right) collectDependencies(ast.right, result)
  if (ast.args) ast.args.forEach((arg) => collectDependencies(arg, result))
  return result
}

export function formulaDependencies(formula: string): Set<string> {
  try {
    return collectDependencies(parseFormula(formula))
  } catch {
    return new Set()
  }
}

/**
 * One structural operation (insert or delete) on a single dimension.
 */
export interface DimensionOp {
  kind: 'insert' | 'delete'
  dimension: 'row' | 'col'
  at: number
  count: number
}

/**
 * Migrate a single coordinate of a reference endpoint.
 * Absolute coordinates never shift; relative ones follow the data.
 * Returns null when the target is removed or pushed off-sheet (=> #REF!).
 */
function applyRefCoord(coord: number, abs: boolean, op: DimensionOp, max: number): number | null {
  if (op.kind === 'insert') {
    if (abs) return coord
    if (coord >= op.at) {
      const next = coord + op.count
      return next < max ? next : null
    }
    return coord
  }
  if (coord >= op.at && coord < op.at + op.count) return null
  if (abs) return coord
  if (coord >= op.at + op.count) return coord - op.count
  return coord
}

/**
 * Migrate a cell's own coordinate (cells always move with the operation, never absolute).
 * Returns null when the cell is deleted.
 */
export function applyCellCoord(coord: number, op: DimensionOp, max: number): number | null {
  if (op.kind === 'insert') {
    if (coord >= op.at) {
      const next = coord + op.count
      return next < max ? next : null
    }
    return coord
  }
  if (coord >= op.at && coord < op.at + op.count) return null
  if (coord >= op.at + op.count) return coord - op.count
  return coord
}

function migrateRef(ref: CellRef, rowOp: DimensionOp | null, colOp: DimensionOp | null, maxRow: number, maxCol: number): CellRef | null {
  let { row, col } = ref
  if (rowOp) {
    const next = applyRefCoord(row, ref.rowAbs, rowOp, maxRow)
    if (next === null) return null
    row = next
  }
  if (colOp) {
    const next = applyRefCoord(col, ref.colAbs, colOp, maxCol)
    if (next === null) return null
    col = next
  }
  return { ...ref, row, col }
}

function migrateAst(ast: FormulaAst, rowOp: DimensionOp | null, colOp: DimensionOp | null, maxRow: number, maxCol: number): FormulaAst {
  switch (ast.type) {
    case 'reference': {
      const ref = migrateRef(ast.ref!, rowOp, colOp, maxRow, maxCol)
      return ref ? { type: 'reference', ref } : { type: 'error', value: '#REF!' }
    }
    case 'range': {
      const start = migrateRef(ast.startRef!, rowOp, colOp, maxRow, maxCol)
      const end = migrateRef(ast.endRef!, rowOp, colOp, maxRow, maxCol)
      if (!start || !end) return { type: 'error', value: '#REF!' }
      return { type: 'range', startRef: start, endRef: end }
    }
    case 'binary':
      return { ...ast, left: migrateAst(ast.left!, rowOp, colOp, maxRow, maxCol), right: migrateAst(ast.right!, rowOp, colOp, maxRow, maxCol) }
    case 'unary':
      return { ...ast, left: migrateAst(ast.left!, rowOp, colOp, maxRow, maxCol) }
    case 'function':
      return { ...ast, args: (ast.args ?? []).map((arg) => migrateAst(arg, rowOp, colOp, maxRow, maxCol)) }
    default:
      return ast
  }
}

/**
 * Rewrite every cell/range reference in a formula for a structural operation,
 * preserving absolute markers. Endpoints are migrated independently.
 * Invalid references become #REF!.
 */
export function migrateFormula(raw: string, rowOp: DimensionOp | null, colOp: DimensionOp | null, maxRow: number, maxCol: number): string {
  const ast = parseFormula(raw)
  return formatFormula(migrateAst(ast, rowOp, colOp, maxRow, maxCol))
}

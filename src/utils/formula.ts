import type { FormulaAst } from '../types/sheet'
import { cellId, columnLabel, expandRange, parseCellId } from './cells'

type TokenType = 'number' | 'string' | 'error' | 'reference' | 'identifier' | 'operator' | 'leftParen' | 'rightParen' | 'comma' | 'colon'

interface Token {
  type: TokenType
  value: string
  start: number
  end: number
}

export class FormulaError extends Error {
  constructor(public code: string) {
    super(code)
  }
}

function tokenize(input: string): Token[] {
  const tokens: Token[] = []
  let index = 0
  const push = (type: TokenType, value: string, start: number) => {
    tokens.push({ type, value, start, end: index })
  }
  while (index < input.length) {
    const start = index
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
      // 字符串 token 的 value 保留原文（含引号），供结构变更时原样回填
      push('string', input.slice(start, index), start)
      continue
    }
    if (char === '#') {
      const errorMatch = /^#[A-Z0-9/]+!?/i.exec(input.slice(index))
      if (errorMatch) {
        index += errorMatch[0].length
        push('error', errorMatch[0].toUpperCase(), start)
        continue
      }
    }
    const number = /^-?\d+(\.\d+)?/.exec(input.slice(index))
    if (number) {
      index += number[0].length
      push('number', number[0], start)
      continue
    }
    const reference = /^\$?[A-Z]+\$?\d+/i.exec(input.slice(index))
    if (reference) {
      // 保留 $ 绝对引用标记，仅统一大小写；解析坐标时再剥离 $
      index += reference[0].length
      push('reference', reference[0].toUpperCase(), start)
      continue
    }
    const identifier = /^[A-Z_][A-Z0-9_]*/i.exec(input.slice(index))
    if (identifier) {
      index += identifier[0].length
      push('identifier', identifier[0].toUpperCase(), start)
      continue
    }
    const twoChar = input.slice(index, index + 2)
    if (['<=', '>=', '<>'].includes(twoChar)) {
      index += 2
      push('operator', twoChar, start)
      continue
    }
    if ('+-*/^%=<>'.includes(char)) {
      index += 1
      push('operator', char, start)
      continue
    }
    if (char === '(') { index += 1; push('leftParen', char, start) }
    else if (char === ')') { index += 1; push('rightParen', char, start) }
    else if (char === ',') { index += 1; push('comma', char, start) }
    else if (char === ':') { index += 1; push('colon', char, start) }
    else throw new FormulaError('#PARSE!')
  }
  return tokens
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
    const precedence: Record<string, number> = { '=': 5, '<>': 5, '<': 5, '>': 5, '<=': 5, '>=': 5, '+': 10, '-': 10, '*': 20, '/': 20, '%': 20, '^': 30 }
    while (this.peek()?.type === 'operator' && (precedence[this.peek().value] ?? -1) >= minPrecedence) {
      const operator = this.consume().value
      const nextMin = operator === '^' ? precedence[operator] : precedence[operator] + 1
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
    if (token.type === 'string') return { type: 'string', value: token.value.slice(1, -1) }
    if (token.type === 'error') return { type: 'error', value: token.value }
    if (token.type === 'reference') {
      if (this.peek()?.type === 'colon') {
        this.consume()
        const end = this.consume()
        if (end?.type !== 'reference') throw new FormulaError('#PARSE!')
        return { type: 'range', value: `${token.value}:${end.value}` }
      }
      return { type: 'reference', value: token.value }
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
  if (ast.type === 'reference') return resolveRef(normalizeReference(String(ast.value)))
  if (ast.type === 'range') {
    const [start, end] = String(ast.value).split(':')
    return resolveRange(`${normalizeReference(start)}:${normalizeReference(end)}`)
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
  if (ast.type === 'reference' && ast.value) result.add(normalizeReference(String(ast.value)))
  if (ast.type === 'range' && ast.value) {
    const [start, end] = String(ast.value).split(':')
    expandRange(start, end).forEach((id) => result.add(id))
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

export function normalizeReference(id: string): string {
  const coord = parseCellId(id)
  return coord ? cellId(coord.row, coord.col) : id
}

export interface AxisShift {
  /** true=插入，false=移除 */
  insert: boolean
  /** 行轴为行索引（0 起），列轴为列索引（0 起） */
  index: number
  /** 插入/移除的条数 */
  count: number
  /** 表上限，超出的索引判为越界（无对应位置） */
  limit: number
}

interface RefParts {
  absCol: boolean
  col: number
  absRow: boolean
  row: number
}

function parseRefParts(token: string): RefParts | null {
  const match = /^\$?([A-Z]+)\$?\d+$/i.exec(token)
  const coord = parseCellId(token)
  if (!match || !coord) return null
  const dollarCol = /^\$/.test(token)
  const dollarRow = /\$\d+$/.test(token)
  return { absCol: dollarCol, col: coord.col, absRow: dollarRow, row: coord.row }
}

function formatRefParts(parts: RefParts): string {
  return `${parts.absCol ? '$' : ''}${columnLabel(parts.col)}${parts.absRow ? '$' : ''}${parts.row + 1}`
}

function shiftCoord(value: number, shift: AxisShift): number | null {
  if (shift.insert) {
    if (value >= shift.index) {
      const next = value + shift.count
      return next < shift.limit ? next : null
    }
    return value
  }
  if (value >= shift.index && value < shift.index + shift.count) return null
  if (value >= shift.index + shift.count) {
    const next = value - shift.count
    return next < shift.limit ? next : null
  }
  return value
}

/**
 * 迁移单个引用的一维坐标：绝对引用钉住不动；相对引用越过插入点/移除点后移位；
 * 引用目标落在被移除区间（或插入后越过表边界）时返回 null。
 */
function movePart(parts: RefParts, axis: 'row' | 'col', shift: AxisShift): RefParts | null {
  const absolute = axis === 'row' ? parts.absRow : parts.absCol
  if (absolute) return parts
  const current = axis === 'row' ? parts.row : parts.col
  const next = shiftCoord(current, shift)
  if (next === null) return null
  return axis === 'row' ? { ...parts, row: next } : { ...parts, col: next }
}

function shiftRefToken(token: string, rowShift?: AxisShift, colShift?: AxisShift): string | null {
  const parts = parseRefParts(token)
  if (!parts) return token
  if (colShift) {
    const next = movePart(parts, 'col', colShift)
    if (!next) return null
    Object.assign(parts, next)
  }
  if (rowShift) {
    const next = movePart(parts, 'row', rowShift)
    if (!next) return null
    Object.assign(parts, next)
  }
  return formatRefParts(parts)
}

/**
 * 按结构变更重写整个公式文本。单个引用/区域引用各自迁移，区域两端独立判断；
 * 任一端失去对应位置，该引用整体替换为 #REF!。字符串字面量与无法解析的公式原样保留。
 */
export function rewriteFormula(formula: string, rowShift?: AxisShift, colShift?: AxisShift): string {
  if (!formula.startsWith('=')) return formula
  const body = formula.slice(1)
  let tokens: Token[]
  try {
    tokens = tokenize(body)
  } catch {
    return formula
  }
  let output = ''
  let cursor = 0
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i]
    output += body.slice(cursor, token.start)
    if (token.type !== 'reference') {
      output += token.type === 'string' ? token.value : token.value
      cursor = token.end
      continue
    }
    const nextToken = tokens[i + 1]
    const endToken = tokens[i + 2]
    if (nextToken?.type === 'colon' && endToken?.type === 'reference') {
      const first = shiftRefToken(token.value, rowShift, colShift)
      const second = shiftRefToken(endToken.value, rowShift, colShift)
      output += first && second ? `${first}:${second}` : '#REF!'
      i += 2
      cursor = endToken.end
    } else {
      const moved = shiftRefToken(token.value, rowShift, colShift)
      output += moved ?? '#REF!'
      cursor = token.end
    }
  }
  output += body.slice(cursor)
  return `=${output}`
}


import type { FormulaAst } from '../types/sheet'
import { cellId, expandRange, parseCellId } from './cells'

type TokenType = 'number' | 'string' | 'reference' | 'identifier' | 'operator' | 'leftParen' | 'rightParen' | 'comma' | 'colon'

interface Token {
  type: TokenType
  value: string
}

export class FormulaError extends Error {
  constructor(public code: string) {
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
    const number = /^-?\d+(\.\d+)?/.exec(input.slice(index))
    if (number) {
      tokens.push({ type: 'number', value: number[0] })
      index += number[0].length
      continue
    }
    const reference = /^\$?[A-Z]+\$?\d+/i.exec(input.slice(index))
    if (reference) {
      tokens.push({ type: 'reference', value: reference[0].replace(/\$/g, '').toUpperCase() })
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
    if (token.type === 'string') return { type: 'string', value: token.value }
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
  if (ast.type === 'reference') return resolveRef(String(ast.value))
  if (ast.type === 'range') return resolveRange(String(ast.value))
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
  if (ast.type === 'reference' && ast.value) result.add(String(ast.value))
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

export type CellValue = string | number | boolean | null

export interface CellRecord {
  raw: string
  value: CellValue
  error?: string
}

export interface CellCoord {
  row: number
  col: number
}

export interface CellRange {
  start: CellCoord
  end: CellCoord
}

export interface CellRef {
  row: number
  col: number
  rowAbs: boolean
  colAbs: boolean
}

export type FormulaErrorCode = '#REF!' | '#CYCLE!' | '#NAME?' | '#VALUE!' | '#DIV/0!' | '#PARSE!' | '#FORMULA!'

export interface FormulaAst {
  type: 'number' | 'string' | 'boolean' | 'reference' | 'range' | 'binary' | 'unary' | 'function' | 'error'
  value?: string | number | boolean
  ref?: CellRef
  startRef?: CellRef
  endRef?: CellRef
  left?: FormulaAst
  right?: FormulaAst
  operator?: string
  name?: string
  args?: FormulaAst[]
}

export type CellMap = Record<string, CellRecord>

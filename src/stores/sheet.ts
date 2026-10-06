import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import type { CellCoord, CellMap, CellRange, CellRecord, CellValue } from '../types/sheet'
import { cellId, displayValue, literalValue, normalizeRange, parseCellId, rangeContains } from '../utils/cells'
import { applyCellCoord, FormulaError, evaluateAst, formulaDependencies, migrateFormula, parseFormula, type DimensionOp } from '../utils/formula'

const ROWS = 1000
const COLS = 26

function createStarterCells(): CellMap {
  const cells: CellMap = {}
  const put = (id: string, raw: string) => { cells[id] = { raw, value: raw.startsWith('=') ? null : literalValue(raw) } }
  put('A1', '区域')
  put('B1', '一月')
  put('C1', '二月')
  put('D1', '三月')
  put('E1', '季度合计')
  put('A2', '华北')
  put('B2', '128000')
  put('C2', '143500')
  put('D2', '151200')
  put('A3', '华东')
  put('B3', '186000')
  put('C3', '193400')
  put('D3', '205800')
  put('A4', '华南')
  put('B4', '97000')
  put('C4', '118600')
  put('D4', '126900')
  put('A5', '西南')
  put('B5', '76000')
  put('C5', '83400')
  put('D5', '92100')
  put('E2', '=SUM(B2:D2)')
  put('E3', '=SUM(B3:D3)')
  put('E4', '=SUM(B4:D4)')
  put('E5', '=SUM(B5:D5)')
  put('A6', '合计')
  put('B6', '=SUM(B2:B5)')
  put('C6', '=SUM(C2:C5)')
  put('D6', '=SUM(D2:D5)')
  put('E6', '=SUM(E2:E5)')
  put('A8', '月均销售')
  put('B8', '=ROUND(AVERAGE(B2:B5),0)')
  put('C8', '=ROUND(AVERAGE(C2:C5),0)')
  put('D8', '=ROUND(AVERAGE(D2:D5),0)')
  put('E8', '=ROUND(AVERAGE(E2:E5),0)')
  put('A10', '最高区域')
  put('B10', '=MAX(E2:E5)')
  put('A11', '最低区域')
  put('B11', '=MIN(E2:E5)')
  put('A13', '达标说明')
  put('B13', '=IF(E6>1500000,"达成季度目标","需要关注")')
  return cells
}

interface HistorySnapshot {
  cells: CellMap
  active: CellCoord
  selection: CellRange
}

export const useSheetStore = defineStore('sheet', () => {
  const rows = ROWS
  const cols = COLS
  const cells = ref<CellMap>(createStarterCells())
  const active = ref<CellCoord>({ row: 1, col: 4 })
  const selection = ref<CellRange>({ start: { row: 1, col: 4 }, end: { row: 1, col: 4 } })
  const freezeRows = ref(1)
  const freezeCols = ref(1)
  const lastRecalculated = ref<string[]>([])
  const history = ref<HistorySnapshot[]>([])
  const future = ref<HistorySnapshot[]>([])
  const status = ref('工作簿已加载，公式引擎待命')

  const activeRaw = computed(() => getRaw(active.value.row, active.value.col))
  const activeValue = computed(() => cells.value[cellId(active.value.row, active.value.col)]?.value ?? null)
  const canUndo = computed(() => history.value.length > 0)
  const canRedo = computed(() => future.value.length > 0)

  function idFor(row: number, col: number) {
    return cellId(row, col)
  }

  function getRaw(row: number, col: number) {
    return cells.value[idFor(row, col)]?.raw ?? ''
  }

  function getRecord(row: number, col: number): CellRecord | undefined {
    return cells.value[idFor(row, col)]
  }

  function dependencyMap() {
    const map = new Map<string, Set<string>>()
    Object.entries(cells.value).forEach(([id, cell]) => {
      if (!cell.raw.startsWith('=')) return
      const deps = formulaDependencies(cell.raw)
      deps.forEach((dep) => map.set(dep, new Set([...(map.get(dep) ?? []), id])))
    })
    return map
  }

  function affectedCells(startIds: string[]) {
    const map = dependencyMap()
    const affected = new Set(startIds)
    const queue = [...startIds]
    while (queue.length) {
      const id = queue.shift()!
      for (const dependent of map.get(id) ?? []) {
        if (!affected.has(dependent)) {
          affected.add(dependent)
          queue.push(dependent)
        }
      }
    }
    return affected
  }

  function recalculate(ids: Set<string>, quiet = false) {
    const resolved = new Map<string, CellValue>()
    const failedCycles = new Set<string>()

    const resolve = (id: string, stack: string[]): CellValue => {
      if (resolved.has(id)) return resolved.get(id) ?? null
      if (stack.includes(id)) {
        stack.forEach((item) => failedCycles.add(item))
        throw new FormulaError('#CYCLE!')
      }
      const record = cells.value[id]
      if (!record) return null
      if (!record.raw.startsWith('=')) {
        const value = literalValue(record.raw)
        resolved.set(id, value)
        return value
      }
      const ast = parseFormula(record.raw)
      const nextStack = [...stack, id]
      const value = evaluateAst(
        ast,
        (reference) => resolve(reference, nextStack),
        (range) => {
          const [start, end] = range.split(':')
          const startCoord = cells.value[start] ? start : start
          const endCoord = cells.value[end] ? end : end
          const idsInRange: string[] = []
          const startMatch = /^([A-Z]+)(\d+)$/i.exec(startCoord)
          const endMatch = /^([A-Z]+)(\d+)$/i.exec(endCoord)
          if (startMatch && endMatch) {
            const startCol = startMatch[1].toUpperCase().split('').reduce((sum, char) => sum * 26 + char.charCodeAt(0) - 64, 0) - 1
            const endCol = endMatch[1].toUpperCase().split('').reduce((sum, char) => sum * 26 + char.charCodeAt(0) - 64, 0) - 1
            for (let row = Number(startMatch[2]) - 1; row <= Number(endMatch[2]) - 1; row += 1) {
              for (let col = startCol; col <= endCol; col += 1) idsInRange.push(cellId(row, col))
            }
          }
          return idsInRange.map((cell) => resolve(cell, nextStack))
        },
      ) as CellValue
      resolved.set(id, value)
      return value
    }

    ids.forEach((id) => {
      try {
        const value = resolve(id, [])
        const record = cells.value[id]
        if (record) cells.value[id] = { ...record, value, error: undefined }
      } catch (error) {
        const record = cells.value[id]
        if (record) {
          const code = error instanceof FormulaError ? error.code : '#ERROR!'
          cells.value[id] = { ...record, value: null, error: failedCycles.has(id) ? '#CYCLE!' : code }
        }
      }
    })
    if (!quiet) {
      lastRecalculated.value = [...ids]
      status.value = `已重算 ${ids.size} 个受影响单元格`
    }
  }

  function snapshot(): HistorySnapshot {
    return {
      cells: JSON.parse(JSON.stringify(cells.value)) as CellMap,
      active: { ...active.value },
      selection: { start: { ...selection.value.start }, end: { ...selection.value.end } },
    }
  }

  function recordHistory() {
    history.value.push(snapshot())
    if (history.value.length > 80) history.value.shift()
    future.value = []
  }

  function setRaw(row: number, col: number, raw: string, record = true) {
    if (record) recordHistory()
    const id = idFor(row, col)
    const existing = cells.value[id]
    if ((existing?.raw ?? '') === raw) return
    cells.value[id] = { raw, value: raw.startsWith('=') ? null : literalValue(raw) }
    recalculate(affectedCells([id]))
  }

  function setManyRaw(start: CellCoord, matrix: string[][]) {
    recordHistory()
    const changed: string[] = []
    matrix.forEach((rowValues, rowOffset) => {
      rowValues.forEach((raw, colOffset) => {
        const row = start.row + rowOffset
        const col = start.col + colOffset
        if (row >= rows || col >= cols) return
        const id = idFor(row, col)
        cells.value[id] = { raw, value: raw.startsWith('=') ? null : literalValue(raw) }
        changed.push(id)
      })
    })
    recalculate(affectedCells(changed))
  }

  function setSelectionRange(range: CellRange) {
    const normalized = normalizeRange(range)
    active.value = { row: normalized.start.row, col: normalized.start.col }
    selection.value = normalized
  }

  /**
   * Move the active/selection coordinate for a structural operation.
   * Insert keeps the selection at the new empty region; delete clamps to the removal point.
   */
  function shiftCoord(coord: number, op: DimensionOp, max: number): number {
    if (op.kind === 'insert') {
      if (coord >= op.at) return Math.min(coord + op.count, max - 1)
      return coord
    }
    if (coord >= op.at && coord < op.at + op.count) return op.at
    if (coord >= op.at + op.count) return coord - op.count
    return coord
  }

  function structureAffected(movedIds: string[], movedFromIds: string[], rewrittenIds: string[], deletedIds: string[]): Set<string> {
    const map = dependencyMap()
    const affected = new Set<string>()
    const queue: string[] = []
    const add = (id: string) => {
      if (!id || affected.has(id)) return
      affected.add(id)
      queue.push(id)
    }
    movedIds.forEach(add)
    movedFromIds.forEach(add)
    rewrittenIds.forEach(add)
    deletedIds.forEach(add)
    while (queue.length) {
      const id = queue.shift()!
      for (const dependent of map.get(id) ?? []) add(dependent)
    }
    return affected
  }

  function nextFrame() {
    return new Promise<void>((resolve) => {
      if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => resolve())
      else setTimeout(resolve, 0)
    })
  }

  /**
   * Recalculate affected formulas in batches grouped by worksheet rows,
   * yielding to the browser between batches so large structural operations
   * (e.g. inserting a column across a 1000-row sheet) stay responsive.
   */
  async function recalculateBatched(ids: Set<string>, batchRows = 120) {
    const byRow = new Map<number, string[]>()
    ids.forEach((id) => {
      const coord = parseCellId(id)
      if (!coord) return
      if (!byRow.has(coord.row)) byRow.set(coord.row, [])
      byRow.get(coord.row)!.push(id)
    })
    const rowList = [...byRow.keys()].sort((a, b) => a - b)
    let done = 0
    for (let i = 0; i < rowList.length; i += batchRows) {
      const batch = new Set<string>()
      for (let j = i; j < rowList.length && j < i + batchRows; j += 1) {
        byRow.get(rowList[j])!.forEach((id) => batch.add(id))
      }
      recalculate(batch, true)
      done += batch.size
      lastRecalculated.value = [...batch]
      status.value = `已分批重算 ${done}/${ids.size} 个受影响公式`
      await nextFrame()
    }
    if (!ids.size) status.value = '结构调整完成，无需重算公式'
  }

  function applyStructureOp(op: DimensionOp) {
    recordHistory()
    const rowOp = op.dimension === 'row' ? op : null
    const colOp = op.dimension === 'col' ? op : null
    const max = op.dimension === 'row' ? rows : cols
    const newCells: CellMap = {}
    const movedIds: string[] = []
    const movedFromIds: string[] = []
    const rewrittenIds: string[] = []
    const deletedIds: string[] = []

    Object.entries(cells.value).forEach(([id, record]) => {
      const coord = parseCellId(id)!
      const cellCoord = op.dimension === 'row' ? coord.row : coord.col
      const nextCoord = applyCellCoord(cellCoord, op, max)
      if (nextCoord === null) {
        deletedIds.push(id)
        return
      }
      const nextRow = op.dimension === 'row' ? nextCoord : coord.row
      const nextCol = op.dimension === 'col' ? nextCoord : coord.col
      const nextId = cellId(nextRow, nextCol)
      let raw = record.raw
      if (raw.startsWith('=')) {
        try {
          const migrated = migrateFormula(raw, rowOp, colOp, rows, cols)
          if (migrated !== raw) {
            raw = migrated
            rewrittenIds.push(nextId)
          }
        } catch {
          // Keep the original formula if it cannot be parsed/migrated.
        }
      }
      newCells[nextId] = { raw, value: raw.startsWith('=') ? null : literalValue(raw) }
      if (nextId !== id) {
        movedIds.push(nextId)
        movedFromIds.push(id)
      }
    })

    cells.value = newCells

    active.value = {
      row: rowOp ? shiftCoord(active.value.row, rowOp, rows) : active.value.row,
      col: colOp ? shiftCoord(active.value.col, colOp, cols) : active.value.col,
    }
    selection.value = {
      start: {
        row: rowOp ? shiftCoord(selection.value.start.row, rowOp, rows) : selection.value.start.row,
        col: colOp ? shiftCoord(selection.value.start.col, colOp, cols) : selection.value.start.col,
      },
      end: {
        row: rowOp ? shiftCoord(selection.value.end.row, rowOp, rows) : selection.value.end.row,
        col: colOp ? shiftCoord(selection.value.end.col, colOp, cols) : selection.value.end.col,
      },
    }

    if (rowOp && rowOp.at < freezeRows.value) {
      freezeRows.value = rowOp.kind === 'insert'
        ? Math.min(rows, freezeRows.value + rowOp.count)
        : Math.max(0, freezeRows.value - rowOp.count)
    }
    if (colOp && colOp.at < freezeCols.value) {
      freezeCols.value = colOp.kind === 'insert'
        ? Math.min(cols, freezeCols.value + colOp.count)
        : Math.max(0, freezeCols.value - colOp.count)
    }

    void recalculateBatched(structureAffected(movedIds, movedFromIds, rewrittenIds, deletedIds))
    const target = op.dimension === 'row' ? '行' : '列'
    status.value = `${op.kind === 'insert' ? '已插入' : '已删除'}${target}，公式引用正在跟随迁移`
  }

  function insertRows() {
    const range = normalizeRange(selection.value)
    const at = range.start.row
    const count = Math.max(1, range.end.row - range.start.row + 1)
    applyStructureOp({ kind: 'insert', dimension: 'row', at, count })
  }

  function deleteRows() {
    const range = normalizeRange(selection.value)
    const at = range.start.row
    const count = Math.max(1, range.end.row - range.start.row + 1)
    applyStructureOp({ kind: 'delete', dimension: 'row', at, count })
  }

  function insertCols() {
    const range = normalizeRange(selection.value)
    const at = range.start.col
    const count = Math.max(1, range.end.col - range.start.col + 1)
    applyStructureOp({ kind: 'insert', dimension: 'col', at, count })
  }

  function deleteCols() {
    const range = normalizeRange(selection.value)
    const at = range.start.col
    const count = Math.max(1, range.end.col - range.start.col + 1)
    applyStructureOp({ kind: 'delete', dimension: 'col', at, count })
  }

  function setActive(row: number, col: number, extend = false) {
    const next = {
      row: Math.max(0, Math.min(rows - 1, row)),
      col: Math.max(0, Math.min(cols - 1, col)),
    }
    active.value = next
    if (!extend) selection.value = { start: { ...next }, end: { ...next } }
    else selection.value.end = { ...next }
  }

  function setSelectionEnd(row: number, col: number) {
    selection.value.end = {
      row: Math.max(0, Math.min(rows - 1, row)),
      col: Math.max(0, Math.min(cols - 1, col)),
    }
  }

  function selectedMatrix() {
    const range = normalizeRange(selection.value)
    const matrix: string[][] = []
    for (let row = range.start.row; row <= range.end.row; row += 1) {
      const values: string[] = []
      for (let col = range.start.col; col <= range.end.col; col += 1) values.push(getRaw(row, col))
      matrix.push(values)
    }
    return matrix
  }

  function selectedText() {
    return selectedMatrix().map((row) => row.map((cell) => cell.replace(/\t/g, ' ')).join('\t')).join('\n')
  }

  function pasteText(text: string) {
    const matrix = text.replace(/\r/g, '').split('\n').filter((row, index, list) => row.length || index < list.length - 1).map((row) => row.split('\t'))
    if (matrix.length) setManyRaw(active.value, matrix)
  }

  function clearSelection() {
    const range = normalizeRange(selection.value)
    const matrix = Array.from({ length: range.end.row - range.start.row + 1 }, () => Array(range.end.col - range.start.col + 1).fill(''))
    setManyRaw(range.start, matrix)
  }

  function undo() {
    const previous = history.value.pop()
    if (!previous) return
    future.value.push(snapshot())
    // Restore formulas and their computed values together from the snapshot.
    cells.value = previous.cells
    active.value = previous.active
    selection.value = previous.selection
    lastRecalculated.value = []
    status.value = '已撤销，公式与结果值已一起还原'
  }

  function redo() {
    const next = future.value.pop()
    if (!next) return
    history.value.push(snapshot())
    // Restore formulas and their computed values together from the snapshot.
    cells.value = next.cells
    active.value = next.active
    selection.value = next.selection
    lastRecalculated.value = []
    status.value = '已重做，公式与结果值已一起还原'
  }

  function isSelected(row: number, col: number) {
    return rangeContains(selection.value, row, col)
  }

  function exportCsv() {
    const lines: string[] = []
    for (let row = 0; row < Math.min(rows, 80); row += 1) {
      const values: string[] = []
      let hasData = false
      for (let col = 0; col < cols; col += 1) {
        const record = getRecord(row, col)
        if (record?.raw) hasData = true
        values.push(`"${displayValue(record?.value ?? '').replace(/"/g, '""')}"`)
      }
      if (hasData || row < 15) lines.push(values.join(','))
    }
    const blob = new Blob([`\uFEFF${lines.join('\n')}`], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = '季度销售公式表.csv'
    anchor.click()
    URL.revokeObjectURL(url)
    status.value = 'CSV 已导出'
  }

  function reset() {
    recordHistory()
    cells.value = createStarterCells()
    recalculate(new Set(Object.keys(cells.value)))
    status.value = '已恢复示例工作簿'
  }

  recalculate(new Set(Object.keys(cells.value)))

  return {
    rows,
    cols,
    cells,
    active,
    selection,
    activeRaw,
    activeValue,
    freezeRows,
    freezeCols,
    lastRecalculated,
    canUndo,
    canRedo,
    status,
    idFor,
    getRaw,
    getRecord,
    setRaw,
    setManyRaw,
    setActive,
    setSelectionEnd,
    setSelectionRange,
    insertRows,
    deleteRows,
    insertCols,
    deleteCols,
    selectedMatrix,
    selectedText,
    pasteText,
    clearSelection,
    undo,
    redo,
    isSelected,
    exportCsv,
    reset,
  }
})

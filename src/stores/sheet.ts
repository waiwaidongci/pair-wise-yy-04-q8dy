import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import type { CellCoord, CellMap, CellRange, CellRecord, CellValue } from '../types/sheet'
import { cellId, displayValue, expandRange, literalValue, normalizeRange, parseCellId, rangeContains } from '../utils/cells'
import { FormulaError, evaluateAst, formulaDependencies, parseFormula, rewriteFormula } from '../utils/formula'
import type { AxisShift } from '../utils/formula'

const ROWS = 1000
const COLS = 26
/** 分批重算时抛出的内部信号：目标公式的依赖尚未就绪，本块先不求值 */
const NOT_READY = Symbol('not-ready')

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

const yieldToUi = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

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
  /** 结构变更期间分批重算进行中，临时锁住编辑类操作 */
  const busy = ref(false)

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

  /**
   * 求值核心：带记忆的依赖解析。目标公式每次重新解析；被依赖的非目标单元格沿用既有值。
   * 被依赖单元格若携带错误（#REF!、#DIV/0!、#CYCLE! 等），错误沿依赖链向上传播。
   * isReady 守卫保证只有依赖已就绪的目标公式才求值，从而支持分块调度而不破坏求值顺序。
   */
  function resolveTargets(ids: Set<string>, isReady?: (id: string) => boolean) {
    const resolved = new Map<string, CellValue>()
    const failed = new Map<string, string>()
    const failedCycles = new Set<string>()
    const visiting = new Set<string>()

    const resolve = (id: string, stack: string[]): CellValue => {
      if (resolved.has(id)) return resolved.get(id) ?? null
      if (failed.has(id)) throw new FormulaError(failed.get(id)!)
      if (stack.includes(id)) {
        stack.forEach((item) => failedCycles.add(item))
        throw new FormulaError('#CYCLE!')
      }
      const record = cells.value[id]
      if (!record) {
        resolved.set(id, null)
        return null
      }
      const isTarget = ids.has(id)
      // 目标公式需等其依赖先处理；否则分块调度会按错误顺序取到中间态
      if (isTarget && isReady && !visiting.has(id) && !isReady(id)) throw NOT_READY
      // 非目标单元格沿用既有结果；若它已失效，引用它的公式跟着失效
      if (!isTarget && record.error) throw new FormulaError(record.error)
      if (!record.raw.startsWith('=')) {
        const value = literalValue(record.raw)
        resolved.set(id, value)
        return value
      }
      visiting.add(id)
      const ast = parseFormula(record.raw)
      const nextStack = [...stack, id]
      try {
        const value = evaluateAst(
          ast,
          (reference) => resolve(reference, nextStack),
          (range) => expandRange(...range.split(':') as [string, string]).map((cell) => resolve(cell, nextStack)),
        ) as CellValue
        resolved.set(id, value)
        return value
      } finally {
        visiting.delete(id)
      }
    }

    ids.forEach((id) => {
      if (isReady && !isReady(id)) return // 依赖尚未就绪，留给后续分块
      try {
        const value = resolve(id, [])
        const record = cells.value[id]
        if (record) cells.value[id] = { ...record, value, error: undefined }
      } catch (error) {
        if (error === NOT_READY) return
        const code = error instanceof FormulaError ? error.code : '#ERROR!'
        failed.set(id, failedCycles.has(id) ? '#CYCLE!' : code)
        const record = cells.value[id]
        if (record) cells.value[id] = { ...record, value: null, error: failedCycles.has(id) ? '#CYCLE!' : code }
      }
    })
  }

  function recalculate(ids: Set<string>) {
    resolveTargets(ids)
    lastRecalculated.value = [...ids]
    status.value = `已重算 ${ids.size} 个受影响单元格`
  }

  /**
   * 结构变更后使用：只重算受影响公式。按“依赖先于引用完成”的就绪顺序分块，
   * 每处理一批让出一次主线程，避免千行大表插入整列时长时间卡死，
   * 同时保证跨行带引用（上方引用下方）也按正确顺序求值。
   */
  async function recalculateBatched(ids: Set<string>, label: string) {
    if (!ids.size) {
      lastRecalculated.value = []
      status.value = label
      return
    }
    const total = ids.size
    let done = 0
    const pending = new Set(ids)
    while (pending.size) {
      // 数据格恒就绪；公式格要求其依赖都已离开待处理队列
      const batch = new Set<string>()
      pending.forEach((id) => {
        const record = cells.value[id]
        if (!record || !record.raw.startsWith('=')) { batch.add(id); return }
        let readyNow = true
        for (const dep of formulaDependencies(record.raw)) {
          if (pending.has(dep)) { readyNow = false; break }
        }
        if (readyNow) batch.add(id)
      })
      // 仅剩相互依赖（循环引用）的目标时全部放行，交给循环检测报 #CYCLE!
      if (!batch.size) pending.forEach((id) => batch.add(id))
      resolveTargets(ids, (candidate) => !pending.has(candidate) || batch.has(candidate))
      batch.forEach((id) => {
        pending.delete(id)
        done += 1
      })
      lastRecalculated.value = [...ids].slice(0, done)
      status.value = `${label}：分批重算 ${done}/${total}…`
      // 批间让出主线程，保证千行大表插入整列时界面不卡死
      await yieldToUi()
    }
    status.value = `${label}：已重算 ${total} 个受影响公式`
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
    if (busy.value) return
    const id = idFor(row, col)
    const existing = cells.value[id]
    if ((existing?.raw ?? '') === raw) return
    if (record) recordHistory()
    cells.value[id] = { raw, value: raw.startsWith('=') ? null : literalValue(raw) }
    recalculate(affectedCells([id]))
  }

  function setManyRaw(start: CellCoord, matrix: string[][]) {
    if (busy.value) return
    const pending: Array<{ id: string; raw: string }> = []
    matrix.forEach((rowValues, rowOffset) => {
      rowValues.forEach((raw, colOffset) => {
        const row = start.row + rowOffset
        const col = start.col + colOffset
        if (row >= rows || col >= cols) return
        const id = idFor(row, col)
        if (cells.value[id]?.raw === raw && raw !== '') return
        pending.push({ id, raw })
      })
    })
    if (!pending.length) return
    recordHistory()
    const changed: string[] = []
    pending.forEach(({ id, raw }) => {
      cells.value[id] = { raw, value: raw.startsWith('=') ? null : literalValue(raw) }
      changed.push(id)
    })
    recalculate(affectedCells(changed))
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

  /** 点列头：整列选中；Shift 时以活动格为起点扩展 */
  function selectEntireColumn(col: number, extend = false) {
    const clamped = Math.max(0, Math.min(cols - 1, col))
    active.value = { row: active.value.row, col: clamped }
    if (!extend) {
      selection.value = { start: { row: 0, col: clamped }, end: { row: rows - 1, col: clamped } }
    } else {
      selection.value.end = { row: rows - 1, col: clamped }
    }
  }

  /** 点行头：整行选中；Shift 时以活动格为起点扩展 */
  function selectEntireRow(row: number, extend = false) {
    const clamped = Math.max(0, Math.min(rows - 1, row))
    active.value = { row: clamped, col: active.value.col }
    if (!extend) {
      selection.value = { start: { row: clamped, col: 0 }, end: { row: clamped, col: cols - 1 } }
    } else {
      selection.value.end = { row: clamped, col: cols - 1 }
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
    if (busy.value) return
    const range = normalizeRange(selection.value)
    const matrix = Array.from({ length: range.end.row - range.start.row + 1 }, () => Array(range.end.col - range.start.col + 1).fill(''))
    setManyRaw(range.start, matrix)
  }

  /** 数据坐标的严格映射：移除时落在被删区间返回 null；插入时越界返回 null */
  function mapStrict(coord: CellCoord, rowShift?: AxisShift, colShift?: AxisShift): CellCoord | null {
    let { row, col } = coord
    if (rowShift) {
      const next = mapAxis(row, rowShift)
      if (next === null) return null
      row = next
    }
    if (colShift) {
      const next = mapAxis(col, colShift)
      if (next === null) return null
      col = next
    }
    return { row, col }
  }

  function mapAxis(value: number, shift: AxisShift): number | null {
    if (shift.insert) {
      const next = value >= shift.index ? value + shift.count : value
      return next < shift.limit ? next : null
    }
    if (value >= shift.index && value < shift.index + shift.count) return null
    if (value >= shift.index + shift.count) return Math.max(0, value - shift.count)
    return value
  }

  /** 活动格/选区用的非严格映射：光标不能丢失，移除时夹取到插入点 */
  function mapClamped(coord: CellCoord, rowShift?: AxisShift, colShift?: AxisShift): CellCoord {
    let { row, col } = coord
    if (rowShift) {
      row = rowShift.insert
        ? clampAxis(row + (row >= rowShift.index ? rowShift.count : 0), 0, rows - 1)
        : row >= rowShift.index + rowShift.count
          ? row - rowShift.count
          : Math.min(row, rowShift.index)
    }
    if (colShift) {
      col = colShift.insert
        ? clampAxis(col + (col >= colShift.index ? colShift.count : 0), 0, cols - 1)
        : col >= colShift.index + colShift.count
          ? col - colShift.count
          : Math.min(col, colShift.index)
    }
    return { row, col }
  }

  function clampAxis(value: number, min: number, max: number) {
    return Math.max(min, Math.min(max, value))
  }

  /**
   * 结构变更总入口：
   * 1) 基于旧表建立依赖图并迁移数据（公式文本经 rewriteFormula 迁移引用）；
   * 2) 被删数据的相对引用由重写器置为 #REF!，绝对引用钉住不动，区域两端各自判断；
   * 3) 只收集受影响公式，交给按行带分批的重算器。
   */
  async function applyStructural(
    rowShift: AxisShift | undefined,
    colShift: AxisShift | undefined,
    label: string,
  ) {
    if (busy.value) return
    busy.value = true
    try {
      recordHistory()
      const oldCells = cells.value
      const oldDependencyMap = dependencyMap()
      const next: CellMap = {}
      const affected = new Set<string>()
      // 被“移位”的数据格：旧位置在插入点之后或移除点之后（含被移除点本身），其旧依赖者需重算
      const displacedOldIds = new Set<string>()

      // 结构变更后，变更轴上 >=index 的网格点所承载的数据身份都会改变（插入出新行/列、删除后后续补位）。
      // 绝对引用钉在网格点不动，旧依赖图无法发现它应重读新数据，需要对未改写公式单独扫描其引用点。
      const referencesChangedGridPoint = (formula: string): boolean => {
        for (const depId of formulaDependencies(formula)) {
          const depCoord = parseCellId(depId)
          if (!depCoord) continue
          if (rowShift && depCoord.row >= rowShift.index) return true
          if (colShift && depCoord.col >= colShift.index) return true
        }
        return false
      }

      for (const [oldId, oldRecord] of Object.entries(oldCells)) {
        const coord = parseCellId(oldId)
        if (!coord) continue
        const strict = mapStrict(coord, rowShift, colShift)
        if (!strict) continue
        const newId = cellId(strict.row, strict.col)
        let { raw, value } = oldRecord
        if (raw.startsWith('=')) {
          const rewritten = rewriteFormula(raw, rowShift, colShift)
          if (rewritten !== raw) {
            raw = rewritten
            value = null
            affected.add(newId)
          } else if (referencesChangedGridPoint(raw)) {
            // 公式文本未变（通常是绝对引用），但它钉住的网格点换了数据，必须重算
            value = null
            affected.add(newId)
          }
        }
        next[newId] = { ...oldRecord, raw, value }
        if (
          (rowShift && coord.row >= rowShift.index) ||
          (colShift && coord.col >= colShift.index)
        ) {
          displacedOldIds.add(oldId)
        }
      }

      cells.value = next

      displacedOldIds.forEach((oldId) => {
        ;(oldDependencyMap.get(oldId) ?? []).forEach((dependent) => {
          const coord = parseCellId(dependent)
          if (!coord) return
          const target = mapStrict(coord, rowShift, colShift)
          if (target) affected.add(cellId(target.row, target.col))
        })
      })

      // 在迁移后的依赖图上做反向传递闭包：被删数据的直接依赖者失效后，
      // 间接依赖它的公式（含跨行带的上方公式）也必须一并纳入重算。
      const newDependencyMap = dependencyMap()
      const closureQueue = [...affected]
      while (closureQueue.length) {
        const id = closureQueue.shift()!
        for (const dependent of newDependencyMap.get(id) ?? []) {
          if (!affected.has(dependent)) {
            affected.add(dependent)
            closureQueue.push(dependent)
          }
        }
      }

      active.value = mapClamped(active.value, rowShift, colShift)
      selection.value = {
        start: mapClamped(selection.value.start, rowShift, colShift),
        end: mapClamped(selection.value.end, rowShift, colShift),
      }

      await recalculateBatched(affected, label)
    } finally {
      busy.value = false
    }
  }

  function insertRows() {
    const normalized = normalizeRange(selection.value)
    const count = Math.min(normalized.end.row - normalized.start.row + 1, rows - 1)
    if (count <= 0) return
    void applyStructural({ insert: true, index: normalized.start.row, count, limit: rows }, undefined, `在第 ${normalized.start.row + 1} 行前插入 ${count} 行`)
  }

  function removeRows() {
    const normalized = normalizeRange(selection.value)
    const count = normalized.end.row - normalized.start.row + 1
    if (normalized.start.row >= rows) return
    void applyStructural({ insert: false, index: normalized.start.row, count, limit: rows }, undefined, `移除第 ${normalized.start.row + 1}–${normalized.end.row + 1} 行`)
  }

  function insertColumns() {
    const normalized = normalizeRange(selection.value)
    const count = Math.min(normalized.end.col - normalized.start.col + 1, cols - 1)
    if (count <= 0) return
    void applyStructural(undefined, { insert: true, index: normalized.start.col, count, limit: cols }, `在第 ${normalized.start.col + 1} 列前插入 ${count} 列`)
  }

  function removeColumns() {
    const normalized = normalizeRange(selection.value)
    const count = normalized.end.col - normalized.start.col + 1
    if (normalized.start.col >= cols) return
    void applyStructural(undefined, { insert: false, index: normalized.start.col, count, limit: cols }, `移除第 ${normalized.start.col + 1}–${normalized.end.col + 1} 列`)
  }

  function undo() {
    if (busy.value) return
    const previous = history.value.pop()
    if (!previous) return
    future.value.push(snapshot())
    // 快照同时保存了公式与已算好的值/错误，直接整体还原，不再重算
    cells.value = previous.cells
    active.value = previous.active
    selection.value = previous.selection
    lastRecalculated.value = Object.keys(previous.cells)
    status.value = '已撤销：公式与计算值一并还原'
  }

  function redo() {
    if (busy.value) return
    const nextSnapshot = future.value.pop()
    if (!nextSnapshot) return
    history.value.push(snapshot())
    cells.value = nextSnapshot.cells
    active.value = nextSnapshot.active
    selection.value = nextSnapshot.selection
    lastRecalculated.value = Object.keys(nextSnapshot.cells)
    status.value = '已重做：公式与计算值一并还原'
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
        values.push(`"${displayValue(record?.error ?? record?.value ?? '').replace(/"/g, '""')}"`)
      }
      if (hasData || row < 15) lines.push(values.join(','))
    }
    const blob = new Blob([`﻿${lines.join('\n')}`], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = '季度销售公式表.csv'
    anchor.click()
    URL.revokeObjectURL(url)
    status.value = 'CSV 已导出'
  }

  function reset() {
    if (busy.value) return
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
    busy,
    idFor,
    getRaw,
    getRecord,
    setRaw,
    setManyRaw,
    setActive,
    setSelectionEnd,
    selectEntireColumn,
    selectEntireRow,
    insertRows,
    removeRows,
    insertColumns,
    removeColumns,
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

<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref } from 'vue'
import { useSheetStore } from '../stores/sheet'
import { columnLabel, displayValue, normalizeRange } from '../utils/cells'

const store = useSheetStore()
const viewport = ref<HTMLElement | null>(null)
const scrollTop = ref(0)
const scrollLeft = ref(0)
const width = ref(1000)
const height = ref(600)
const selecting = ref(false)
const editing = ref<{ row: number; col: number } | null>(null)
const editValue = ref('')
let resizeObserver: ResizeObserver | undefined

const CELL_W = 112
const CELL_H = 30
const HEADER_W = 52
const HEADER_H = 28
const OVERSCAN = 3

const frozenWidth = computed(() => store.freezeCols * CELL_W)
const frozenHeight = computed(() => store.freezeRows * CELL_H)
const contentWidth = computed(() => HEADER_W + store.cols * CELL_W)
const contentHeight = computed(() => HEADER_H + store.rows * CELL_H)
const visibleRows = computed(() => {
  const start = Math.max(store.freezeRows, store.freezeRows + Math.floor(scrollTop.value / CELL_H) - OVERSCAN)
  const end = Math.min(store.rows - 1, store.freezeRows + Math.ceil((scrollTop.value + height.value) / CELL_H) + OVERSCAN)
  return Array.from({ length: Math.max(0, end - start + 1) }, (_, index) => start + index)
})
const visibleCols = computed(() => {
  const start = Math.max(store.freezeCols, store.freezeCols + Math.floor(scrollLeft.value / CELL_W) - OVERSCAN)
  const end = Math.min(store.cols - 1, store.freezeCols + Math.ceil((scrollLeft.value + width.value) / CELL_W) + OVERSCAN)
  return Array.from({ length: Math.max(0, end - start + 1) }, (_, index) => start + index)
})
const frozenRows = computed(() => Array.from({ length: store.freezeRows }, (_, index) => index))
const frozenCols = computed(() => Array.from({ length: store.freezeCols }, (_, index) => index))

function xForCol(col: number) {
  if (col < store.freezeCols) return HEADER_W + col * CELL_W
  return HEADER_W + frozenWidth.value + (col - store.freezeCols) * CELL_W - scrollLeft.value
}

function yForRow(row: number) {
  if (row < store.freezeRows) return HEADER_H + row * CELL_H
  return HEADER_H + frozenHeight.value + (row - store.freezeRows) * CELL_H - scrollTop.value
}

function onScroll() {
  if (!viewport.value) return
  scrollTop.value = viewport.value.scrollTop
  scrollLeft.value = viewport.value.scrollLeft
}

function selectCell(row: number, col: number, event?: MouseEvent) {
  editing.value = null
  store.setActive(row, col, Boolean(event?.shiftKey))
  selecting.value = true
  viewport.value?.focus()
}

function enterCell(row: number, col: number) {
  if (selecting.value) store.setSelectionEnd(row, col)
}

function startEdit(row?: number, col?: number) {
  const target = row === undefined || col === undefined ? store.active : { row, col }
  store.setActive(target.row, target.col)
  editing.value = { ...target }
  editValue.value = store.getRaw(target.row, target.col)
  nextTick(() => {
    const input = document.querySelector<HTMLInputElement>('.cell-editor')
    input?.focus()
    input?.select()
  })
}

function commitEdit() {
  if (!editing.value) return
  store.setRaw(editing.value.row, editing.value.col, editValue.value)
  editing.value = null
}

function cancelEdit() {
  editing.value = null
}

function move(rowDelta: number, colDelta: number, extend = false) {
  store.setActive(store.active.row + rowDelta, store.active.col + colDelta, extend)
}

async function copySelection() {
  try {
    await navigator.clipboard.writeText(store.selectedText())
    store.status = `已复制 ${normalizeRange(store.selection).end.row - normalizeRange(store.selection).start.row + 1} 行选区`
  } catch {
    store.status = '浏览器未授予剪贴板写入权限'
  }
}

async function pasteSelection() {
  try {
    store.pasteText(await navigator.clipboard.readText())
  } catch {
    store.status = '浏览器未授予剪贴板读取权限'
  }
}

function onKeydown(event: KeyboardEvent) {
  if (editing.value) {
    if (event.key === 'Escape') cancelEdit()
    if (event.key === 'Enter') {
      event.preventDefault()
      commitEdit()
      move(1, 0)
    } else if (event.key === 'Tab') {
      event.preventDefault()
      commitEdit()
      move(0, event.shiftKey ? -1 : 1)
    }
    return
  }
  const command = event.metaKey || event.ctrlKey
  if (command && event.key.toLowerCase() === 'c') {
    event.preventDefault()
    void copySelection()
  } else if (command && event.key.toLowerCase() === 'v') {
    event.preventDefault()
    void pasteSelection()
  } else if (command && event.key.toLowerCase() === 'z') {
    event.preventDefault()
    event.shiftKey ? store.redo() : store.undo()
  } else if (event.key === 'ArrowUp') {
    event.preventDefault()
    move(-1, 0, event.shiftKey)
  } else if (event.key === 'ArrowDown' || event.key === 'Enter') {
    event.preventDefault()
    move(1, 0, event.shiftKey)
  } else if (event.key === 'ArrowLeft') {
    event.preventDefault()
    move(0, -1, event.shiftKey)
  } else if (event.key === 'ArrowRight' || event.key === 'Tab') {
    event.preventDefault()
    move(0, event.shiftKey ? -1 : 1)
  } else if (event.key === 'Delete' || event.key === 'Backspace') {
    event.preventDefault()
    store.clearSelection()
  } else if (event.key === 'F2') {
    event.preventDefault()
    startEdit()
  } else if (event.key.length === 1 && !command) {
    editValue.value = event.key
    startEdit()
    editValue.value = event.key
  }
}

onMounted(() => {
  if (viewport.value) {
    resizeObserver = new ResizeObserver(([entry]) => {
      width.value = entry.contentRect.width
      height.value = entry.contentRect.height
    })
    resizeObserver.observe(viewport.value)
    viewport.value.focus()
  }
  window.addEventListener('mouseup', () => { selecting.value = false })
})
onUnmounted(() => {
  resizeObserver?.disconnect()
})
</script>

<template>
  <div ref="viewport" class="grid-viewport" tabindex="0" @scroll="onScroll" @keydown="onKeydown">
    <div class="grid-spacer" :style="{ width: `${contentWidth}px`, height: `${contentHeight}px` }" />

    <div class="corner" :style="{ width: `${HEADER_W}px`, height: `${HEADER_H}px` }" />
    <div
      v-for="col in visibleCols"
      :key="`col-${col}`"
      class="column-header"
      :class="{ frozen: col < store.freezeCols }"
      :style="{ left: `${xForCol(col)}px`, width: `${CELL_W}px`, height: `${HEADER_H}px` }"
    >
      {{ columnLabel(col) }}
    </div>
    <div
      v-for="row in visibleRows"
      :key="`row-${row}`"
      class="row-header"
      :class="{ frozen: row < store.freezeRows }"
      :style="{ top: `${yForRow(row)}px`, width: `${HEADER_W}px`, height: `${CELL_H}px` }"
    >
      {{ row + 1 }}
    </div>

    <template v-for="row in frozenRows" :key="`fr-${row}`">
      <div
        v-for="col in frozenCols"
        :key="`fc-${row}-${col}`"
        class="cell frozen-cell"
        :class="{ selected: store.isSelected(row, col), active: store.active.row === row && store.active.col === col }"
        :style="{ left: `${xForCol(col)}px`, top: `${yForRow(row)}px`, width: `${CELL_W}px`, height: `${CELL_H}px` }"
        @mousedown="selectCell(row, col, $event)"
        @dblclick="startEdit(row, col)"
      >
        <span class="cell-value">{{ store.getRecord(row, col)?.error || displayValue(store.getRecord(row, col)?.value) }}</span>
      </div>
    </template>

    <template v-for="row in visibleRows" :key="`vr-${row}`">
      <div
        v-for="col in frozenCols"
        :key="`vrf-${row}-${col}`"
        class="cell frozen-cell"
        :class="{ selected: store.isSelected(row, col), active: store.active.row === row && store.active.col === col }"
        :style="{ left: `${xForCol(col)}px`, top: `${yForRow(row)}px`, width: `${CELL_W}px`, height: `${CELL_H}px` }"
        @mousedown="selectCell(row, col, $event)"
        @mouseenter="enterCell(row, col)"
        @dblclick="startEdit(row, col)"
      >
        <input
          v-if="editing?.row === row && editing?.col === col"
          v-model="editValue"
          class="cell-editor"
          @blur="commitEdit"
          @keydown.enter.prevent="commitEdit(); move(1, 0)"
          @keydown.escape.prevent="cancelEdit"
        />
        <span v-else class="cell-value" :class="{ error: store.getRecord(row, col)?.error }">
          {{ store.getRecord(row, col)?.error || displayValue(store.getRecord(row, col)?.value) }}
        </span>
      </div>
    </template>

    <template v-for="row in visibleRows" :key="`main-${row}`">
      <div
        v-for="col in visibleCols"
        :key="`cell-${row}-${col}`"
        class="cell"
        :class="{ selected: store.isSelected(row, col), active: store.active.row === row && store.active.col === col }"
        :style="{ left: `${xForCol(col)}px`, top: `${yForRow(row)}px`, width: `${CELL_W}px`, height: `${CELL_H}px` }"
        @mousedown="selectCell(row, col, $event)"
        @mouseenter="enterCell(row, col)"
        @dblclick="startEdit(row, col)"
      >
        <input
          v-if="editing?.row === row && editing?.col === col"
          v-model="editValue"
          class="cell-editor"
          @blur="commitEdit"
          @keydown.enter.prevent="commitEdit(); move(1, 0)"
          @keydown.escape.prevent="cancelEdit"
        />
        <span v-else class="cell-value" :class="{ error: store.getRecord(row, col)?.error }">
          {{ store.getRecord(row, col)?.error || displayValue(store.getRecord(row, col)?.value) }}
        </span>
      </div>
    </template>
  </div>
</template>

<style scoped>
.grid-viewport {
  position: relative;
  width: 100%;
  height: 100%;
  overflow: auto;
  outline: none;
  background: #fff;
}
.grid-spacer { pointer-events: none; }
.corner, .column-header, .row-header, .cell { position: absolute; }
.corner {
  z-index: 8;
  top: 0;
  left: 0;
  border-right: 1px solid #c8d2df;
  border-bottom: 1px solid #c8d2df;
  background: #eef2f7;
}
.column-header {
  z-index: 6;
  top: 0;
  display: grid;
  place-items: center;
  color: #59677a;
  background: #f2f5f9;
  border-right: 1px solid #d8e0ea;
  border-bottom: 1px solid #c8d2df;
  font-size: 11px;
  font-weight: 700;
}
.row-header {
  z-index: 6;
  left: 0;
  display: grid;
  place-items: center;
  color: #59677a;
  background: #f2f5f9;
  border-right: 1px solid #c8d2df;
  border-bottom: 1px solid #e0e6ee;
  font-size: 11px;
}
.column-header.frozen, .row-header.frozen { background: #e8eef7; color: #28476f; }
.cell {
  z-index: 2;
  display: flex;
  align-items: center;
  overflow: hidden;
  padding: 0 7px;
  background: #fff;
  border-right: 1px solid #e5eaf0;
  border-bottom: 1px solid #e5eaf0;
  color: #1f2937;
  font-size: 12px;
  cursor: cell;
  user-select: none;
}
.cell:hover { background: #f8fbff; }
.cell.selected { background: rgba(59, 130, 246, .09); }
.cell.active { z-index: 4; outline: 2px solid #2563eb; outline-offset: -2px; background: #fff; }
.cell.frozen-cell { z-index: 5; box-shadow: 2px 0 5px rgba(30, 45, 65, .04); }
.cell-value { width: 100%; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.cell-value.error { color: #dc2626; font-family: ui-monospace, monospace; font-size: 11px; }
.cell-editor {
  width: calc(100% + 14px);
  height: 100%;
  margin: 0 -7px;
  padding: 0 7px;
  border: 0;
  outline: 0;
  color: #172033;
  background: #fff;
  font: 12px ui-monospace, monospace;
}
</style>

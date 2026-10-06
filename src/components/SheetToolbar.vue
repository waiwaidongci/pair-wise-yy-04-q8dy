<script setup lang="ts">
import { computed } from 'vue'
import { useSheetStore } from '../stores/sheet'
import { columnLabel, normalizeRange } from '../utils/cells'

const store = useSheetStore()
const activeLabel = computed(() => `${columnLabel(store.active.col)}${store.active.row + 1}`)
const range = computed(() => normalizeRange(store.selection))
const rowLabel = computed(() => {
  const { start, end } = range.value
  return start.row === end.row ? `第 ${start.row + 1} 行` : `第 ${start.row + 1}–${end.row + 1} 行`
})
const colLabel = computed(() => {
  const { start, end } = range.value
  return start.col === end.col ? `第 ${columnLabel(start.col)} 列` : `第 ${columnLabel(start.col)}–${columnLabel(end.col)} 列`
})
</script>

<template>
  <div class="sheet-toolbar">
    <div class="toolbar-left">
      <v-btn size="small" variant="text" prepend-icon="mdi-undo" :disabled="!store.canUndo || store.busy" @click="store.undo">撤销</v-btn>
      <v-btn size="small" variant="text" prepend-icon="mdi-redo" :disabled="!store.canRedo || store.busy" @click="store.redo">重做</v-btn>
      <v-divider vertical class="mx-2" />
      <v-btn size="small" variant="text" prepend-icon="mdi-table-row-plus-before" :disabled="store.busy" @click="store.insertRows">
        插入{{ rowLabel }}
      </v-btn>
      <v-btn size="small" variant="text" prepend-icon="mdi-table-row-remove" :disabled="store.busy" @click="store.removeRows">
        移除{{ rowLabel }}
      </v-btn>
      <v-btn size="small" variant="text" prepend-icon="mdi-table-column-plus-before" :disabled="store.busy" @click="store.insertColumns">
        插入{{ colLabel }}
      </v-btn>
      <v-btn size="small" variant="text" prepend-icon="mdi-table-column-remove" :disabled="store.busy" @click="store.removeColumns">
        移除{{ colLabel }}
      </v-btn>
      <v-divider vertical class="mx-2" />
      <v-btn-toggle
        :model-value="store.freezeRows"
        density="compact"
        variant="outlined"
        @update:model-value="store.freezeRows = Number($event)"
      >
        <v-btn :value="0" size="small">不冻结行</v-btn>
        <v-btn :value="1" size="small">冻结首行</v-btn>
      </v-btn-toggle>
      <v-btn-toggle
        :model-value="store.freezeCols"
        density="compact"
        variant="outlined"
        @update:model-value="store.freezeCols = Number($event)"
      >
        <v-btn :value="0" size="small">不冻结列</v-btn>
        <v-btn :value="1" size="small">冻结首列</v-btn>
      </v-btn-toggle>
      <v-btn size="small" variant="text" prepend-icon="mdi-delete-outline" :disabled="store.busy" @click="store.clearSelection">清除内容</v-btn>
    </div>
    <div class="toolbar-right">
      <v-progress-circular v-if="store.busy" indeterminate size="16" width="2" color="primary" />
      <span class="active-badge">{{ activeLabel }}</span>
      <span class="muted">{{ store.status }}</span>
      <v-btn size="small" variant="text" prepend-icon="mdi-refresh" :disabled="store.busy" @click="store.reset">重置</v-btn>
      <v-btn size="small" color="primary" variant="flat" prepend-icon="mdi-download" @click="store.exportCsv">导出 CSV</v-btn>
    </div>
  </div>
</template>

<style scoped>
.sheet-toolbar {
  height: 52px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 0 12px;
  border-bottom: 1px solid #dce3ec;
  background: #fff;
}
.toolbar-left, .toolbar-right { display: flex; align-items: center; gap: 6px; min-width: 0; }
.active-badge { padding: 4px 8px; border-radius: 5px; color: #1d4ed8; background: #eaf2ff; font: 700 12px ui-monospace, monospace; }
.muted { color: #718096; font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 260px; }
</style>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useSheetStore } from '../stores/sheet'
import { columnLabel } from '../utils/cells'

const store = useSheetStore()
const draft = ref('')
const cellLabel = computed(() => `${columnLabel(store.active.col)}${store.active.row + 1}`)

watch(() => store.activeRaw, (value) => { draft.value = value }, { immediate: true })

function commit() {
  store.setRaw(store.active.row, store.active.col, draft.value)
}
</script>

<template>
  <div class="formula-bar">
    <div class="fx-label">fx</div>
    <div class="cell-name">{{ cellLabel }}</div>
    <input
      v-model="draft"
      class="formula-input"
      aria-label="公式编辑栏"
      @keydown.enter.prevent="commit"
      @blur="draft !== store.activeRaw && commit()"
    />
    <span v-if="store.getRecord(store.active.row, store.active.col)?.error" class="formula-error">
      {{ store.getRecord(store.active.row, store.active.col)?.error }}
    </span>
  </div>
</template>

<style scoped>
.formula-bar { height: 38px; display: flex; align-items: center; gap: 8px; padding: 0 10px; border-bottom: 1px solid #dce3ec; background: #fff; }
.fx-label { color: #2563eb; font: italic 700 14px Georgia, serif; }
.cell-name { width: 72px; padding: 5px 8px; border: 1px solid #d8e0ea; border-radius: 4px; color: #334155; background: #f8fafc; font: 600 12px ui-monospace, monospace; }
.formula-input { flex: 1; min-width: 0; height: 28px; padding: 0 8px; border: 1px solid #d8e0ea; border-radius: 4px; outline: none; color: #1e293b; font: 12px ui-monospace, monospace; }
.formula-input:focus { border-color: #3b82f6; box-shadow: 0 0 0 2px rgba(59,130,246,.12); }
.formula-error { color: #dc2626; font-size: 11px; font-weight: 700; }
</style>

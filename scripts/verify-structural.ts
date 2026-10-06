import { createPinia, setActivePinia } from 'pinia'
import { useSheetStore } from '../src/stores/sheet'
import { rewriteFormula } from '../src/utils/formula'

let failures = 0
function assert(cond: boolean, message: string) {
  if (cond) console.log(`  ✓ ${message}`)
  else { failures += 1; console.error(`  ✗ ${message}`) }
}
function eq(actual: unknown, expected: unknown, message: string) {
  assert(actual === expected, `${message}（期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}）`)
}

async function waitBusy(store: ReturnType<typeof useSheetStore>) {
  // 等待结构变更的分批重算结束
  for (let i = 0; i < 50 && store.busy; i += 1) await new Promise((r) => setTimeout(r, 10))
  if (store.busy) throw new Error('store 长时间 busy')
}

console.log('rewriteFormula：列插入')
eq(rewriteFormula('=SUM(B2:D2)', undefined, { insert: true, index: 1, count: 1, limit: 26 }), '=SUM(C2:E2)', '相对区域整体右移')
eq(rewriteFormula('=$B$2+1', undefined, { insert: true, index: 1, count: 1, limit: 26 }), '=$B$2+1', '全绝对引用不移动')
eq(rewriteFormula('=$B2+B$3', undefined, { insert: true, index: 1, count: 1, limit: 26 }), '=$B2+C$3', '半绝对引用：锁列不动、锁行的列随移')
eq(rewriteFormula('=A1', undefined, { insert: true, index: 1, count: 1, limit: 26 }), '=A1', '插入点之前不动')
eq(rewriteFormula('=Z1', undefined, { insert: true, index: 1, count: 1, limit: 26 }), '=#REF!', '插入后越过表边界 → #REF!')
eq(rewriteFormula('=IF(A1>1,"B2:D2",B2)', undefined, { insert: true, index: 1, count: 1, limit: 26 }), '=IF(A1>1,"B2:D2",C2)', '字符串字面量原样保留')

console.log('rewriteFormula：行插入')
eq(rewriteFormula('=SUM(B2:B5)', { insert: true, index: 1, count: 1, limit: 1000 }), '=SUM(B3:B6)', '相对区域整体下移')
eq(rewriteFormula('=B$1', { insert: true, index: 5, count: 1, limit: 1000 }), '=B$1', '绝对行不移动')
eq(rewriteFormula('=B6', { insert: true, index: 1, count: 2, limit: 1000 }), '=B8', '插两行移动两个单位')

console.log('rewriteFormula：列移除')
eq(rewriteFormula('=B1', undefined, { insert: false, index: 1, count: 1, limit: 26 }), '=#REF!', '相对单点被删 → #REF!')
eq(rewriteFormula('=A1+C1', undefined, { insert: false, index: 1, count: 1, limit: 26 }), '=A1+B1', '区域外端点各自移位')
eq(rewriteFormula('=SUM(A1:C1)', undefined, { insert: false, index: 1, count: 1, limit: 26 }), '=SUM(A1:B1)', '区域一端在删除区外则收缩')
eq(rewriteFormula('=SUM(B1:C1)', undefined, { insert: false, index: 1, count: 1, limit: 26 }), '=SUM(#REF!)', '区域起点被删 → 整体 #REF!')
eq(rewriteFormula('=SUM(A1:B1)', undefined, { insert: false, index: 1, count: 1, limit: 26 }), '=SUM(#REF!)', '区域终点被删 → 整体 #REF!')
eq(rewriteFormula('=$B$1', undefined, { insert: false, index: 1, count: 1, limit: 26 }), '=$B$1', '绝对引用钉住，不跟随删除')

console.log('rewriteFormula：行移除')
eq(rewriteFormula('=B5', { insert: false, index: 1, count: 2, limit: 1000 }), '=B3', '删除区之后上移两条')
eq(rewriteFormula('=B2', { insert: false, index: 1, count: 2, limit: 1000 }), '=#REF!', '落在删除区间 → #REF!')

setActivePinia(createPinia())
const store = useSheetStore()

console.log('store：在 B 列前插入一列')
store.selectEntireColumn(1)
store.insertColumns()
await waitBusy(store)
eq(store.getRecord(1, 5)?.raw, '=SUM(C2:E2)', 'E2 的季度合计迁到 F2 并改指 C:E')
eq(store.getRecord(1, 5)?.value, 422700, 'F2 值仍为原三个月之和')
eq(store.getRecord(1, 4)?.raw, '151200', '原三月列数据搬到 E 列位置')
eq(store.getRecord(5, 2)?.raw, '=SUM(C2:C5)', '原 B6 合计迁到 C6')
eq(store.getRecord(5, 2)?.value, 128000 + 186000 + 97000 + 76000, 'C6 为现列（原一月）之和')
eq(store.freezeRows, 1, '冻结行数不变')
eq(store.freezeCols, 1, '冻结列数不变')

console.log('store：撤销列插入（公式与值一起还原）')
store.undo()
eq(store.getRecord(1, 4)?.raw, '=SUM(B2:D2)', '撤销后 E2 公式还原')
eq(store.getRecord(1, 4)?.value, 422700, '撤销后 E2 计算值一并还原')
eq(store.getRecord(1, 5)?.raw, undefined, '撤销后 F2 清空')

console.log('store：重做列插入')
store.redo()
eq(store.getRecord(1, 5)?.raw, '=SUM(C2:E2)', '重做后迁移公式回到 F2')
eq(store.getRecord(1, 5)?.value, 422700, '重做后值正确')
store.undo() // 回到初始表再做删除测试

console.log('store：移除 B 列（一月）后的错误与绝对引用')
store.setRaw(1, 6, '=$B$1')   // G2：绝对引用一月表头
store.setRaw(2, 6, '=B2*2')   // G3
store.setRaw(3, 6, '=G3+1')   // G4 依赖 G3
store.selectEntireColumn(1)
store.removeColumns()
await waitBusy(store)
eq(store.getRecord(1, 3)?.raw, '=SUM(#REF!)', '原 E2 季度合计迁到 D2，区域含被删列 → #REF!')
eq(store.getRecord(1, 3)?.error, '#REF!', 'D2 报 #REF! 错误值')
eq(store.getRecord(1, 5)?.raw, '=$B$1', '绝对引用迁到 F2 后仍钉在 B1')
eq(store.getRecord(1, 5)?.value, '二月', 'F2 的 $B$1 读到补位后的“二月”，不报错')
eq(store.getRecord(2, 5)?.raw, '=#REF!*2', 'G3 迁到 F3 并失效')
eq(store.getRecord(2, 5)?.error, '#REF!', 'F3 报 #REF!')
eq(store.getRecord(3, 5)?.raw, '=F3+1', 'G4 迁到 F4 改指 F3')
eq(store.getRecord(3, 5)?.error, '#REF!', '依赖失效单元格的 F4 跟着失效')

console.log('store：撤销列移除')
store.undo()
// setRaw 的历史在更前面，撤销移除后应回到“已布置测试公式”的状态
eq(store.getRecord(1, 4)?.raw, '=SUM(B2:D2)', 'E2 公式还原')
eq(store.getRecord(1, 4)?.value, 422700, 'E2 值还原')
eq(store.getRecord(2, 6)?.raw, '=B2*2', 'G3 公式还原')
eq(store.getRecord(2, 6)?.error, undefined, 'G3 错误清除')
eq(store.getRecord(3, 6)?.value, 128000 * 2 + 1, 'G4 值还原')

console.log('store：移除第 2 行（华北）')
store.selectEntireRow(1)
store.removeRows()
await waitBusy(store)
eq(store.getRecord(1, 4)?.raw, '=SUM(B2:D2)', '原 E3 华东行上移到 E2，引用改为 B2:D2')
eq(store.getRecord(1, 4)?.value, 186000 + 193400 + 205800, 'E2 值为华东合计 585200')
eq(store.getRecord(4, 1)?.raw, '=SUM(#REF!)', '原 B6 合计上移到 B5，区域起点行被删 → #REF!')
eq(store.getRecord(4, 1)?.error, '#REF!', 'B5 报 #REF!')
eq(store.getRecord(4, 4)?.raw, '=SUM(#REF!)', '原 E6 迁到 E5，同样失效')
store.undo()
eq(store.getRecord(1, 4)?.value, 422700, '撤销删行后 E2 恢复华北数据')

console.log('store：在第 2 行前插入一行')
store.selectEntireRow(1)
store.insertRows()
await waitBusy(store)
eq(store.getRecord(6, 4)?.raw, '=SUM(E3:E6)', '原 E6 迁到 E7 并改指 E3:E6')
eq(store.getRecord(1, 4)?.raw, undefined, '新第 2 行为空行')
eq(store.getRecord(8, 1)?.raw, '=ROUND(AVERAGE(B3:B6),0)', '月均公式迁到第 9 行并改引用')
store.undo()
eq(store.getRecord(5, 4)?.raw, '=SUM(E2:E5)', '撤销后 E6 还原')

console.log('store：跨行带自顶向下链式依赖，删除数据源行')
store.setRaw(998, 24, '=B2')          // Y999 引用一月华北
store.setRaw(0, 0, '=Y999')           // A1 在最上，引用最下的 Y999
store.setRaw(0, 1, '=A1+1')           // B1 再依赖 A1
store.selectEntireRow(1)              // 选中第 2 行（华北，B2 所在）
store.removeRows()
await waitBusy(store)
eq(store.getRecord(997, 24)?.raw, '=#REF!', 'Y999 上移后引用被删 → #REF!')
eq(store.getRecord(997, 24)?.error, '#REF!', 'Y999 报 #REF!')
eq(store.getRecord(0, 0)?.raw, '=Y998', 'A1 改指上移后的 Y998')
eq(store.getRecord(0, 0)?.error, '#REF!', 'A1 跨带引用下方失效格，跟着失效')
eq(store.getRecord(0, 1)?.error, '#REF!', 'B1 链式依赖 A1，同样失效')
store.undo()
eq(store.getRecord(0, 0)?.error, undefined, '撤销后 A1 错误清除')
eq(store.getRecord(0, 0)?.value, 128000, '撤销后 A1 恢复 128000')
eq(store.getRecord(0, 1)?.value, 128001, '撤销后 B1 恢复 128001')

console.log(failures ? `\n${failures} 项断言失败` : '\n全部断言通过')
process.exit(failures ? 1 : 0)

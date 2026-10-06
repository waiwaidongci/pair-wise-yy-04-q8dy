# GridFormula 类电子表格公式编辑器

技术栈：Vue 3、TypeScript、Vite、Vuetify、Pinia、Vue Router。

## 功能

- 1000 行、26 列虚拟滚动表格，支持编辑、区域选择、复制粘贴与键盘导航。
- 支持冻结首行、首列。
- 公式支持四则运算、括号、单元格引用、区域引用、SUM、AVERAGE、MIN、MAX、COUNT、IF、ROUND、ABS。
- 基于依赖图检测循环引用，并返回 `#CYCLE!` 等错误。
- 编辑后只重算直接和间接受影响的公式单元格。
- 支持撤销重做和 CSV 导出。

## 运行

```bash
corepack pnpm install
corepack pnpm dev
corepack pnpm build
```

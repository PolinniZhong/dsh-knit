/**
 * Knit v0.20 · **规模基准**（R1 硬门槛）—— 全文检索轮到 5 秒轮询了没有？
 *
 * ── 为什么要单独有这一个 ──────────────────────────────
 *
 * v0.19 之前「参与打分的正文」只有每篇前 2500 字，`SCAN_BUDGET_MS = 4000` 管的是
 * **目录遍历**，打分本身可以忽略不计。v0.20 取消窗口后，`countOccurrences` 的扫描长度
 * 变成整篇：真实用例一篇文档平均 12 930 字，代码侧还有 773 个文件的池子。
 * 而客户端 `POLL_MS = 5000` —— **每 5 秒打一次 `/knit/api/recent`，每次都是一个完整 `scan()`**。
 * 打分一旦比 5 秒还慢，请求就会叠加。
 *
 * 所以这个工具回答一个问题：**冷扫 / 热扫一次要多久，离 5 秒还有多少余量。**
 *
 * ── 验收门（实现说明 §7 R1，硬）────────────────────────
 *
 *   1000 文件合成语料：`totalMs <= 1500`
 *   真实工作区 1400+ 文件（635 md + 773 code）：`totalMs <= 1200`
 *
 * 超了就**先别接 UI**，回去做 `index.js` 的三条优化（全文小写体缓存 / 缓存上界 /
 * `TF_CAP` 早退）—— **不许**用「只扫前 N 个文件」这种悄悄降召回的做法达标。
 *
 * ── 语料工厂不在这里 ─────────────────────────────────
 *
 * `makeScaleWorkspace` / `timeWorkspace` 住在 `test/deep-corpus.mjs` —— 因为守着同一个
 * 门槛的 `test/deep-scale.test.mjs` 必须能随 npm 包一起跑（`tools/` 不随包发布，
 * v0.20.0 就是因为这个漏了一条包装缺陷，见 `tools/clean-room-test.mjs`）。
 * 这里只 re-export 旧路径，用法不变。
 *
 * 用法：`node knit/tools/deep-benchmark.mjs`
 * 依赖：无（只用 Knit 自己的源码 + Node 标准库）。**不进 `npm test`** —— 它是基准；
 * 门槛由 `test/deep-scale.test.mjs` 用一个小一号的语料守着（见那个文件头的说明）。
 */
import { SIZES, GATES, makeScaleWorkspace, timeWorkspace } from '../test/deep-corpus.mjs'

export { SIZES, GATES, makeScaleWorkspace, timeWorkspace }

/** 把一行结果打成表里的样子。 */
function row(label, r) {
  return [
    label.padEnd(12),
    String(r.counts.scanned).padStart(6),
    `${r.counts.docs}+${r.counts.code}`.padStart(10),
    r.collectMs.toFixed(0).padStart(9),
    r.coldMs.toFixed(0).padStart(8),
    r.warmMs.toFixed(0).padStart(8),
    `${r.heapMB.toFixed(0)} MB`.padStart(9),
  ].join(' ')
}

/** 跑合成语料那一半。 */
export async function runSynthetic(sizes = SIZES) {
  const rows = []
  for (const n of sizes) {
    const ws = makeScaleWorkspace(n)
    try {
      const r = await timeWorkspace(ws.root)
      rows.push({ n, ...r })
    } finally {
      ws.cleanup()
    }
  }
  return rows
}

/** 真工作区那一半：跑一次真实目录（默认是本仓库所在的那一级）。 */
export async function runReal(root) {
  const r = await timeWorkspace(root)
  return { root, ...r }
}

const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href
if (isMain) {
  const real = process.argv[2] || '/Users/zhongwentuo/DeepSeek Harness Native'
  console.log('Knit v0.20 规模基准（R1）\n')
  console.log(['语料'.padEnd(12), '文件'.padStart(6), 'doc+code'.padStart(10),
    'collect'.padStart(9), 'cold'.padStart(8), 'warm'.padStart(8), 'heap'.padStart(9)].join(' '))
  const syn = await runSynthetic()
  for (const r of syn) console.log(row(`synth-${r.n}`, r))
  let realRow = null
  try {
    realRow = await runReal(real)
    console.log(row('real', realRow))
  } catch (e) {
    console.log(`real        跳过（读不了 ${real}：${e.message}）`)
  }
  const big = syn.find((r) => r.n === 1000)
  console.log('')
  if (big) {
    const ok = big.totalMs <= GATES.synthetic1000Ms
    console.log(`1000 文件 cold=${big.totalMs.toFixed(0)}ms（门槛 ${GATES.synthetic1000Ms}ms）`
      + ` warm=${big.warmMs.toFixed(0)}ms ⇒ ${ok ? 'PASS' : 'FAIL'}`)
  }
  if (realRow) {
    const ok = realRow.totalMs <= GATES.realMs
    console.log(`真实工作区 cold=${realRow.totalMs.toFixed(0)}ms（门槛 ${GATES.realMs}ms）`
      + ` warm=${realRow.warmMs.toFixed(0)}ms ⇒ ${ok ? 'PASS' : 'FAIL'}`)
  }
}

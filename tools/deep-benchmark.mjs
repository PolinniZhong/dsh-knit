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
 * ── 四类文件（需求 §18 点名的 small / medium / large text / large code）──
 *
 *   小 Markdown  ~1 KB   55%     中等 Markdown ~16 KB  25%
 *   大 Markdown  ~128 KB 10%     大代码        ~64 KB  10%
 *
 * 用法：`node knit/tools/deep-benchmark.mjs`
 * 依赖：无（只用 Knit 自己的源码 + Node 标准库）。**不进 `npm test`** —— 它是基准；
 * 门槛由 `test/deep-scale.test.mjs` 用一个小一号的语料守着（见那个文件头的说明）。
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { scan, collectDocs } from '../src/host/index.js'

/** 合成语料的规模档位。 */
export const SIZES = [100, 500, 1000]

/** R1 的两条硬门槛。 */
export const GATES = { synthetic1000Ms: 1500, realMs: 1200 }

/** 四类文件的占比（按索引取模分配，保证任何 N 下四类都在）。 */
const MIX = [
  { kind: 'small-md', share: 55, bytes: 1 * 1024 },
  { kind: 'medium-md', share: 25, bytes: 16 * 1024 },
  { kind: 'large-md', share: 10, bytes: 128 * 1024 },
  { kind: 'large-code', share: 10, bytes: 64 * 1024 },
]

/** 造一段定长文本（中文按 3 字节算，够接近就行 —— 这是量级基准，不是字节精确测试）。 */
function filler(bytes, seed) {
  const line = `第 ${seed} 段：这一段正文用于把文件撑到目标大小，与任何查询词都无关。`
  const need = Math.max(1, Math.floor(bytes / (line.length * 3)))
  return new Array(need).fill(line).join('\n')
}

/** 按占比决定第 i 个文件属于哪一类。 */
function kindOf(i, n) {
  let acc = 0
  const pos = (i / n) * 100
  for (const m of MIX) {
    acc += m.share
    if (pos < acc) return m
  }
  return MIX[0]
}

/** 造一个 N 篇的合成工作区；返回 { root, files, cleanup }。 */
export function makeScaleWorkspace(n, label = 'knit-bench') {
  const root = mkdtempSync(join(tmpdir(), `${label}-`))
  const files = 0
  for (let i = 0; i < n; i += 1) {
    const m = kindOf(i, n)
    const rel = m.kind === 'large-code' ? `src/mod${i}.mjs` : `docs/page${i}.md`
    const body = m.kind === 'large-code'
      ? `${filler(m.bytes, i)}\nexport function handler${i}(input) {\n  return input\n}\n`
      : `# 页面 ${i}\n\n${filler(m.bytes, i)}\n`
    const abs = join(root, rel)
    mkdirSync(join(abs, '..'), { recursive: true })
    writeFileSync(abs, body)
  }
  return { root, files: n, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

/** 跑一次「冷扫 + 热扫」，返回各阶段耗时。 */
export async function timeWorkspace(root, query = 'handler') {
  const heap0 = process.memoryUsage().heapUsed

  const t0 = process.hrtime.bigint()
  const collected = await collectDocs(root)
  const t1 = process.hrtime.bigint()

  const payload = await scan(root, 400, { sort: 'relevance', query, kind: 'context' })
  const t2 = process.hrtime.bigint()

  const again = await scan(root, 400, { sort: 'relevance', query, kind: 'context' })
  const t3 = process.hrtime.bigint()

  const ms = (a, b) => Number(b - a) / 1e6
  const heap1 = process.memoryUsage().heapUsed

  return {
    collectMs: ms(t0, t1),
    coldMs: ms(t0, t2),
    warmMs: ms(t2, t3),
    totalMs: ms(t0, t2),
    heapMB: (heap1 - heap0) / 1024 / 1024,
    counts: {
      docs: collected.docs.length,
      code: collected.code.length,
      media: collected.media.length,
      scanned: collected.docs.length + collected.code.length + collected.media.length,
      truncated: collected.truncated,
      codeTruncated: collected.codeTruncated,
    },
    ranked: payload.docs.length,
    matched: again.docs.filter((d) => Array.isArray(d.matches) && d.matches.length > 0).length,
  }
}

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

/**
 * Knit v0.20 · **规模语料工厂**（R1 规模门槛的那份语料）—— 一处真源。
 *
 * ── 为什么它住在 `test/` 而不是 `tools/` ────────────────
 *
 * `test/deep-scale.test.mjs` 要造一份 1000 文件的合成工作区来守 R1 门槛，所以它
 * 和这份工厂必须**一起进 npm 包**。`tools/` 不随包发布（`package.json` 的 `files`
 * 只白名单了两个脚本），v0.20.0 因此漏了一条包装缺陷：registry 上那份 tarball 里
 * `npm test` 是 638 pass / 1 fail（`ERR_MODULE_NOT_FOUND`）。
 *
 * 修法是搬进 `test/`，**不是**把 `tools/` 加进 `files` —— 「`tools/` 不进包」是
 * 不变式。`tools/deep-benchmark.mjs` 现在从这里 re-export，`node tools/deep-benchmark.mjs`
 * 的用法一个字没变。守这条不变式的闸门是 `tools/clean-room-test.mjs`（发版前必跑）。
 *
 * ── 四类文件（需求 §18 点名的 small / medium / large text / large code）──
 *
 *   小 Markdown  ~1 KB   55%     中等 Markdown ~16 KB  25%
 *   大 Markdown  ~128 KB 10%     大代码        ~64 KB  10%
 *
 * 依赖：无（只用 Knit 自己的源码 + Node 标准库）。
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

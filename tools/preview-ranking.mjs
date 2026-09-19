/**
 * Knit · **排序预演** —— 回答「这句问法值不值得拿去做真机验收」
 *
 * ## 为什么有这个脚本
 *
 * v0.11 ② 的真机验收**连着两轮没验成**，两次都不是功能坏了，是**问题选错了**：
 *
 *   1. 第一轮问在 **Knit 自己的仓库**里 → `AGENTS.md` §2/§8 已经把答案在哪篇点名了，
 *      agent 压根不需要文档发现工具。
 *   2. 第二轮问「**当初为什么决定不引入向量检索**」→ 实测在这份语料里
 *      `向量检索` **只出现在 4 个文件**、且都是顺带一提。这是**找确切字符串**，
 *      `grep` 是更强的工具（穷举、精确）—— agent 选 grep 是**理性的**，
 *      换成 `knit_docs` 也不会更好。
 *
 * 盲试一轮要重启 DSH + 开新会话 + 等一轮对话，成本不低。所以这里
 * **直接用 Knit 自己的引擎把排序算出来**：走的是 `scan(root, limit,
 * { sort: 'relevance', query })` —— 与 `knit_docs` 工具**逐字相同**的一条路径，
 * 连命中词（`payload.keywords`）和 `pickSnippet` 的调用方式都照抄。
 *
 * 于是「这句问法会返回哪几篇、其中几篇有 `match:` 段落」在**开真机之前**就看得见。
 *
 * ## 用法
 *
 *   node tools/preview-ranking.mjs <工作区绝对路径> "<问法1>" ["<问法2>" ...]
 *   node tools/preview-ranking.mjs <工作区绝对路径>        # 用内置的对照问法
 *
 * 工作区不给就取当前目录。只读：不写文件、不连网、不调模型。
 *
 * ## 三条判据（都打在输出里）
 *
 * **① 命中的篇数（`df`）—— 决定 `grep` 够不够用。**
 * 每个命中词后面括号里的数字，是**语料里有几篇真的含这个词**。
 * 取「最长命中词」中 df 最大的那个当作主题的代表：
 *   - `df ≤ 6`  → 一个 `grep` 就穷举完了，**这类问法测不到 Knit 的价值**
 *   - `df ≥ 20` → 命中面很宽，`glob` / `grep` 都会淹掉，**排序才有意义**
 *
 * **② 文件名有没有直说答案。**
 * 最强命中词若就写在 top-1 的**文件名**里，`glob` 一步命中 ——
 * 那测的是「agent 会不会 glob」，不是「会不会用排序工具」。
 *
 * **③ 这句话要的是「一件事的答案」，还是「一份清单」。**
 * 前两条**算不出来**这一条 —— 但它们都过了，问法仍然可能是坏的：
 * 2026-09-19 第三轮真机问「讲内容生产流程的是**哪几篇**？**各自**侧重什么？」，
 * 排序完美（20/20 带 `match:`），可是 agent 一看就开了 `limit: 20`，
 * 拿到 20 条路径去翻其中几篇 —— **② 再也判不出来**。
 * 所以用词面线索挡一道（见 `LIST_CUE`），**但最终还得人自己确认一句**：
 * **「这句问出来，答案是一句话，还是一张表？」**
 *
 * 三条都过，才值得拿去做真机验收。
 */

import { resolve } from 'node:path'
import { collectDocs, scan, readDocument } from '../src/host/index.js'
import { pickSnippet } from '../src/host/tool.js'

/* ── 参数 ───────────────────────────────────────────── */

const argv = process.argv.slice(2)
const looksLikePath = (s) => typeof s === 'string' && (s.startsWith('/') || s.startsWith('.'))
const root = resolve(looksLikePath(argv[0]) ? argv[0] : '.')
const given = looksLikePath(argv[0]) ? argv.slice(1) : argv

/**
 * 内置对照问法：**同一个工作区，两种问题形状**。
 * 一句是「要清单 + 要大意」（`knit_docs` 的靶心），一句是「查一个事实」
 * （grep 的靶心）。并排看，差别一目了然。
 */
const FALLBACK = [
  '这个项目里讲内容生产流程的文档是哪几篇？各自侧重什么？',
  '当初为什么决定不引入向量检索？简要回答。',
]

const questions = given.length > 0 ? given : FALLBACK

/**
 * 「要清单」的词面线索（判据③）。
 *
 * ⚠️ **这是线索，不是判定。** 它只负责把可疑的问法顶出来让人自己看一眼 ——
 * 判据③ 的实质是「这句问出来，答案是一句话，还是一张表？」。
 * 宁可放过，也不要误伤：所以只收**明确在要枚举**的说法。
 */
const LIST_CUE = /哪几篇|哪几份|哪几个|哪些文档|哪些文件|有哪些|各自|分别|列一下|列出|盘点|汇总|都有什么|都讲了什么|一览/

/* ── 语料与词频 ─────────────────────────────────────── */

const started = Date.now()
const corpus = await collectDocs(root)

/**
 * 每个词在**全文**里有几篇命中。
 * 用全文而不是 `haystack` —— 因为这里要回答的是「`grep` 能不能穷举」，
 * 而 `grep` 看的是全文（`haystack.body` 只截了前 2500 字，会低估）。
 */
const texts = []
for (const doc of corpus.docs) {
  try {
    const read = await readDocument(root, doc.rel)
    if (read && read.ok === true) texts.push(read.text.toLowerCase())
  } catch {
    /* 读不了就当它不存在，不影响判定 */
  }
}

const df = (term) => texts.filter((t) => t.includes(String(term).toLowerCase())).length

const baseName = (rel) => (rel.split('/').pop() || rel).replace(/\.[^.]+$/, '')

/* ── 预演 ───────────────────────────────────────────── */

let bad = 0

console.log('═'.repeat(72))
console.log('Knit · 排序预演（与 `knit_docs` 同一条 scan 路径）')
console.log('═'.repeat(72))
console.log(`工作区  ${root}`)
console.log(`语料    ${corpus.docs.length} 篇 Markdown${
  corpus.truncated ? '（⚠️ 已达扫描上限，实际更多）' : ''}，只用 ${Date.now() - started} ms 读完`)
console.log()

for (const [qi, question] of questions.entries()) {
  console.log('─'.repeat(72))
  console.log(`问法 ${qi + 1}  「${question}」`)
  console.log()

  // limit 用工具的默认值（5），好让名次与真实调用可比
  const payload = await scan(root, 5, { sort: 'relevance', query: question })
  const terms = Array.isArray(payload.keywords) ? payload.keywords : []

  console.log(`模式      ${payload.mode}，话题标签「${payload.topic || '(无)'}」`)

  if (terms.length === 0) {
    console.log('命中词    (无)')
    console.log()
    console.log('  ❌ 一个命中词都没有。这条问法的词**在语料里不存在** ——')
    console.log('     工具会退化成时间序，`match:` 段落也无从抽起。**换问法。**')
    console.log()
    bad += 1
    continue
  }

  // 每个命中词带 df —— 「grep 够不够用」就看这串数字
  console.log(`命中词    ${terms.map((t) => `${t}(${df(t)})`).join(' / ')}`)
  console.log()

  let withSnippet = 0
  const rows = []

  for (const [i, doc] of (payload.docs || []).entries()) {
    let snippet = ''
    try {
      const read = await readDocument(root, doc.rel)
      if (read && read.ok === true) snippet = pickSnippet(read.text, terms, { title: doc.title })
    } catch {
      snippet = ''
    }
    if (snippet) withSnippet += 1
    rows.push({ i, doc, snippet })
  }

  for (const { i, doc, snippet } of rows) {
    console.log(`  ${i + 1}. ${doc.rel}`)
    if (snippet) {
      const one = snippet.replace(/\s+/g, ' ').trim()
      console.log(`     match ✓  ${one.length > 76 ? one.slice(0, 76) + '…' : one}`)
    } else {
      console.log('     match ✗  （抽不到段落 —— 结果里不会有 match: 行）')
    }
  }
  console.log()
  console.log(`  候选 ${rows.length} 篇，其中 ${withSnippet} 篇带 \`match:\` 段落`)

  /* ── 判据①：主题在语料里有多宽 ───────────────────── */

  const top = rows[0]
  const longest = Math.max(...terms.map((t) => String(t).length))
  const wide = terms.filter((t) => String(t).length === longest)
  const probe = wide.reduce((best, t) => (df(t) > df(best) ? t : best), wide[0])
  const probeDf = df(probe)

  const notes = []
  if (!top) notes.push('没有候选文档。**换工作区。**')
  if (withSnippet === 0) {
    notes.push('一篇都没抽到 `match:` 段落 —— ② 的核心证据不会出现。**换问法。**')
  }
  if (probeDf <= 6) {
    notes.push(`主题面太窄：最长命中词里最宽的是「${probe}」，只有 ${probeDf} 篇含它。\n` +
      '     一个 `grep` 就穷举完了 —— **这类问法测不到排序工具的价值**（agent 选 grep 是对的）。')
  } else if (probeDf >= corpus.docs.length * 0.8) {
    notes.push(`主题面太宽：「${probe}」命中 ${probeDf}/${corpus.docs.length} 篇，几乎没有区分度。`)
  }
  if (top) {
    const topName = baseName(top.doc.rel).toLowerCase()
    const leaked = terms.filter((t) => topName.includes(String(t).toLowerCase()))
    if (leaked.length >= 2) {
      notes.push(`文件名直说答案：命中词 ${leaked.map((t) => `「${t}」`).join('')} 就在 top-1 的\n` +
        `     文件名里（\`${top.doc.rel}\`）—— \`glob\` 一步命中，测不到排序工具。`)
    }
  }

  /* ── 判据③：这句话是在要「一件事的答案」，还是在要「一份清单」？ ──
   *
   * **排序算不出来这一条** —— 上面两条都过了，问法仍然可能是坏的。
   * 2026-09-19 第三轮真机就是栽在这里：问的是「讲内容生产流程的是**哪几篇**？
   * **各自**侧重什么？」→ 排序完美（20/20 带 `match:`），但 agent 一看这问法就
   * 开了 `limit: 20`，拿到 20 条路径去翻其中几篇，**② 再也判不出来**。
   *
   * 所以用词面线索挡一道。**只是线索，不是判定** —— 真懂的还是人：
   * 「这句问出来，答案是一句话，还是一张表？」
   */
  const listCue = LIST_CUE.exec(question)
  if (listCue) {
    notes.push(`**问法在要清单**（出现「${listCue[0]}」）：agent 多半会开大 \`limit\`，` +
      '拿到一长串路径去翻其中几篇 ——\n' +
      '     那是**问法的必然结果**，与「段落有没有省下 read」无关，那一轮**判不了 ②**。\n' +
      '     改成一件**答案只在一篇里**的事。')
  }

  console.log()
  if (notes.length === 0) {
    console.log('  ✅ **这个问法值得拿去做真机验收**')
    console.log(`     - 主题面宽窄适中：代表词「${probe}」命中 ${probeDf}/${corpus.docs.length} 篇`)
    console.log(`     - top-1 的文件名没有直说答案（不易被 glob 绕过）`)
    console.log(`     - 问法要的是「一件事的答案」，不是一份清单（agent 不会开大 \`limit\`）`)
    console.log(`     - ${withSnippet} 篇带 \`match:\` 段落，② 有证据可看`)
  } else {
    console.log('  ❌ **不建议拿这个问法去真机**：')
    for (const n of notes) console.log(`     - ${n}`)
    bad += 1
  }
  console.log()
}

/* ── 收尾 ───────────────────────────────────────────── */

console.log('═'.repeat(72))
if (bad === 0) {
  console.log('预演结论：上面打 ✅ 的那条问法可以直接用。')
  console.log()
  console.log('真机步骤（**三步，都不用重启** —— 宿主新鲜度由脚本自己证）：')
  console.log('  1. 在这个工作区**开一个新会话**')
  console.log('  2. 问打 ✅ 的那句（**原话照抄**，改一个词就可能改变排序）')
  console.log('  3. node tools/verify-v0.11.mjs      # 自动选别的项目的最近会话')
  console.log()
  console.log('判据（`verify-v0.11.mjs` 会自己判并打印，五种）：')
  console.log('  knit_docs 后直接答、不 read             → ✅ 有效')
  console.log('  后续只有列目录 / grep，**没读正文**      → ✅ 有效')
  console.log('  read 但只带 offset/limit 读一小段        → ✅ 部分有效')
  console.log('  **limit ≥ 10（agent 在要清单）**         → ⚠️ 判不了（测例混杂），不算 ✅ 也不算 ❌')
  console.log('  拿到段落之后仍读多处正文                  → ❌ 无效，负收益，**停手不试第四轮**')
} else {
  console.log(`预演结论：${bad} 条问法**不建议**直接拿去真机 —— 按上面的提示换。`)
}
console.log('═'.repeat(72))

process.exit(bad === 0 ? 0 : 1)

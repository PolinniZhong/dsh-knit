#!/usr/bin/env node
/**
 * 重放评审文档 §5 那 5 个案例的 Context Pack 输出。
 *
 * **为什么要这个脚本**：`01_ Knit PRD/Knit_评审-v0.14-ContextPack.md` §5 的案例输出
 * 原本是**上限 3 / 5 / 12 那一版**的快照。上限收敛成 1 / 3 / 5 之后，
 * 「辅助 5 / 相关 12」这类数字就不再可复现了 —— 而评审文档里的数字必须能被复核，
 * 否则它就从证据退化成传说。
 *
 * **它刻意不看运行中的宿主**：直接在进程内 `import` 源码跑 `execute()`，
 * 所以宿主**没重启**也能回答「磁盘上这份代码会输出什么」。
 * （要问「跑着的宿主是不是新代码」，用 `tools/verify-v0.14.mjs`。）
 *
 * 用法：
 *   node tools/replay-cases.mjs                    # 紧凑格式（评审文档 §5 用的就是它）
 *   node tools/replay-cases.mjs --full             # 原始渲染，即 agent 真正收到的那段文本
 *   node tools/replay-cases.mjs <工作区根>
 *   node tools/replay-cases.mjs --full --query "任意问题"   # 不改 CASES 也能重放任意查询
 *
 * `--query` 可以给多次；给了它就**只跑这些**，不再跑内置的 5 个案例。
 * 它是为真实 Agent 实验准备的：要拿某一轮任务的 Context Pack 原文去喂 agent 时，
 * 不必先把问题写进 `CASES` 数组再改回来。
 *
 * 零依赖、零网络、不写盘。
 */
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
// `knit/tools/` → 工作区根是再上两级（`08_Knit`）
const DEFAULT_ROOT = resolve(HERE, '..', '..')

/** 评审文档 §5 的 5 个案例，查询原文照抄，不要改写 —— 否则输出不可比对。 */
const CASES = [
  ['案例 1', 'BM25 为什么比关键词计数好？'],
  ['案例 2', 'npm 包为什么测试在 clone 后失败？'],
  ['案例 3', 'knit_docs 为什么要返回 snippet？'],
  ['案例 4', '路径越界怎么防？'],
  ['案例 5', '竞品里下载量最高的是哪一类插件？'],
]

const argv = process.argv.slice(2)
const full = argv.includes('--full')
const queries = []
let rootArg = ''
for (let i = 0; i < argv.length; i += 1) {
  const arg = argv[i]
  if (arg === '--full') continue
  if (arg === '--query') { queries.push(argv[(i += 1)]); continue }
  if (arg.startsWith('--')) continue
  rootArg = arg
}

const root = rootArg ? resolve(rootArg) : DEFAULT_ROOT

/** 给了 `--query` 就只跑它给的那些，否则跑内置的 5 个案例。 */
const CASES_RUN = queries.length > 0
  ? queries.map((q, i) => [`--query ${i + 1}`, q])
  : CASES

const { knitDocsDefinition } = await import('../src/host/tool.js')
const { scan, readDocument, buildContextFor } = await import('../src/host/index.js')

const definition = knitDocsDefinition(scan, readDocument, buildContextFor)

/**
 * 理由码 → 评审文档用的中文说法。
 *
 * 与 `tool.js` 里那个模块私有的 `whyText()` **不是一回事**：那个是**模型**看的英文
 * （`matched in the summary (…)`），这里是**给人读的文档**用的中文。
 * 用词与面板词典保持一致（`client.js` 的 `why.titleMatch` 等）。
 */
const WHY_CN = {
  direct: '直接主题命中',
  titleMatch: '标题命中',
  summaryMatch: '摘要命中',
  bodyMatch: '正文命中',
  linkTarget: '被主要上下文引用',
  linkSource: '引用了主要上下文',
  related: '与当前任务相关',
}

/** 一条理由 → `正文命中（bm25, 关键词）`。词表优先用 `terms`，退回 `term`。 */
function whyCompact(reason) {
  if (!reason || typeof reason !== 'object') return ''
  const head = WHY_CN[reason.code] || reason.code || ''
  const terms = Array.isArray(reason.terms) && reason.terms.length > 0
    ? reason.terms
    : (typeof reason.term === 'string' && reason.term ? [reason.term] : [])
  return terms.length > 0 ? `${head}（${terms.join('、')}）` : head
}

/** 紧凑格式：评审文档 §5 的案例块。左列对齐到本案例最长的那条 `rel`。 */
function compact(label, query, value) {
  const tiers = [['primary', 'Primary'], ['supporting', 'Supporting'], ['related', 'Related']]
  const rows = []
  for (const [key, name] of tiers) {
    const items = Array.isArray(value[key]) ? value[key] : []
    if (items.length === 0) {
      rows.push({ name, rel: '', why: '（空）' })
      continue
    }
    for (const item of items) rows.push({ name, rel: item.rel, why: whyCompact(item.reason) })
  }
  const w = Math.max(...rows.map((r) => r.rel.length), 4)
  const body = rows.map((r) => `${r.name.padEnd(10)} ${r.rel.padEnd(w)}  Why: ${r.why}`.trimEnd())
  const counts = tiers
    .map(([key, name]) => `${name} ${Array.isArray(value[key]) ? value[key].length : 0}`)
    .join(' / ')
  return [
    `${label} · ${query}`,
    `topic = ${value.topic ? `「${value.topic}」` : '（空）'}；命中 ${value.totals?.matched}/${value.totals?.total}；${counts}`,
    '',
    ...body,
  ].join('\n')
}

/**
 * 「是不是 top-N 换名字」的实测量。
 *
 * 判据来自 PRD §18：如果分层只是把**平铺相关度前 6 名**改三个名字，
 * 那么 `promoted` 必须恒为 0。`demoted` 是被挤下去的。
 * 平铺名次取 `scan()` 的 `ranked`（**全量、未切片**）：工具内部也是拿它做分层的，
 * 所以两边比的是同一个名次表。
 */
function compareToFlat(value, ranked) {
  const flat6 = ranked.slice(0, 6).map((d) => String(d.rel))
  const top2 = [...(value.primary || []), ...(value.supporting || [])]
  const top2Rel = top2.map((i) => i.rel)
  const promoted = top2Rel.filter((r) => !flat6.includes(r))
  const demoted = flat6.filter((r) => !top2Rel.includes(r))
  const zeroHit = top2.filter((i) => {
    const code = i.reason && i.reason.code
    return code === 'linkTarget' || code === 'linkSource'
  })
  return { flat6, top2Rel, promoted, demoted, zeroHit }
}


// 假会话：`cwd` 决定工作区根，`snapshotEvents` 给空对话。
// 传 `query` 时宿主不读对话，所以这个假会话不会污染结果。
const session = { header: { cwd: root, id: 'replay-cases' }, snapshotEvents: () => [] }

console.log(`工作区根：${root}\n`)

for (const [label, query] of CASES_RUN) {
  const value = await definition.execute({ query }, { agent: { session } })
  // 平铺名次：单独跑一次 `scan()` 拿全量 `ranked`（工具内部也是拿它分层的）。
  // 这是**第二次** collect —— 只为文档工具服务，50 篇的成本可忽略。
  const flat = await scan(root, 60, { session, sessionId: 'replay-cases', sort: 'relevance', query })
  const cmp = compareToFlat(value, Array.isArray(flat.ranked) ? flat.ranked : [])
  if (full) {
    const text = definition.output.render({ query }, value).map((p) => p.text).join('')
    console.log('='.repeat(76))
    console.log(`${label} · ${query}`)
    console.log('='.repeat(76))
    console.log(text)
    console.log()
  } else {
    console.log(compact(label, query, value))
    console.log(`平铺 top6：${cmp.flat6.join(' · ') || '（空）'}`)
    console.log(`前两层      ：${cmp.top2Rel.join(' · ') || '（空）'}`)
    console.log(`提上来 ${cmp.promoted.length}：${cmp.promoted.join(' · ') || '—'}`)
    console.log(`降下去 ${cmp.demoted.length}：${cmp.demoted.join(' · ') || '—'}`)
    console.log(`零命中靠引用 ${cmp.zeroHit.length}：${cmp.zeroHit.map((i) => i.rel).join(' · ') || '—'}`)
    console.log()
  }
}


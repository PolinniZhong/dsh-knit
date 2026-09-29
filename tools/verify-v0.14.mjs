/**
 * Knit v0.14 · **真机验收探针**
 *
 * 为什么需要它：宿主半边**不热加载**（AGENTS.md §4.2）—— 改完 `src/host/*`
 * 必须重启 DSH，否则你会对着一份「看起来正常」的旧响应做验收。
 * 这个脚本把「跑的是不是新代码」变成一条可判定的检查，而不是靠感觉。
 *
 * 它还替掉一个真实踩过的坑：`/knit/api/*` 只认**当前还开着**的会话。
 * `sessionId` 填错/填一个已归档的会话时，宿主会兜底成 DSH 服务进程的 cwd，
 * 返回一份**看起来正常但工作区不对**的结果（AGENTS.md §1 那条警告）。
 * 所以这里对「根路径是不是你期望的工作区」也做一次断言。
 *
 * 零依赖，只用 node 内置 fetch（Node ≥ 22）。
 *
 * 用法（两种传法等价，位置参数照 `verify-v0.11.mjs` 的先例）：
 *   node tools/verify-v0.14.mjs --list                  # 只列 08_Knit 最近的会话，帮你挑 id
 *   node tools/verify-v0.14.mjs <活着的会话 id>
 *   node tools/verify-v0.14.mjs --session <id> [--root <期望的工作区>]
 *
 * 退出码：0 = 全过；1 = 有 FAIL。
 */
import { readFile, readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

const PORT = process.env.KNIT_PORT || '3080'
const BASE = `http://127.0.0.1:${PORT}/knit`
const HOST_LOG = join(homedir(), 'Library/Application Support/dsh-tauri/logs/desktop.log')
const SESSION_DIR = join(homedir(), '.dsh/sessions')

/** 内部字段：一个都不许出现在任何 HTTP 响应里。 */
const FORBIDDEN = ['"raw"', 'matchedTerms', '"strength"', '"haystack"', '"head"', '"rank"']

const argv = process.argv.slice(2)
const argOf = (flag) => {
  const i = argv.indexOf(flag)
  return i >= 0 ? argv[i + 1] : undefined
}

let failed = 0
const pass = (title, detail = '') => console.log(`  ✅ ${title}${detail ? `  ${detail}` : ''}`)
const fail = (title, detail = '') => { failed += 1; console.log(`  ❌ ${title}${detail ? `\n     ${detail}` : ''}`) }
const section = (title) => console.log(`\n${title}`)

/**
 * 列 08_Knit 工作区里最近改动过的会话 id（用来挑一个活着的 sessionId）。
 * @returns {Promise<Array<{id:string, mtime:number}>>} 会话
 */
async function recentSessions() {
  const dirs = await readdir(SESSION_DIR)
  const target = dirs.find((d) => d.includes('08_Knit'))
  if (!target) return []
  const base = join(SESSION_DIR, target)
  const out = []
  for (const name of await readdir(base)) {
    try {
      const files = await readdir(join(base, name))
      let mtime = 0
      for (const f of files) {
        const st = await import('node:fs/promises').then((m) => m.stat(join(base, name, f)))
        if (st.mtimeMs > mtime) mtime = st.mtimeMs
      }
      out.push({ id: name, mtime })
    } catch { /* 不是目录 */ }
  }
  return out.sort((a, b) => b.mtime - a.mtime)
}

/** GET 一个 Knit 路由，返回 `{status, text, json}`。 */
async function get(path) {
  const res = await fetch(`${BASE}${path}`, { headers: { accept: 'application/json' }, cache: 'no-store' })
  const text = await res.text()
  let json = null
  try { json = JSON.parse(text) } catch { /* 非 JSON（/raw 回字节） */ }
  return { status: res.status, text, json, headers: res.headers }
}

/** 最后一条 route ready 那一行（判断宿主加载了哪几条路由）。 */
async function lastRouteLine() {
  try {
    const log = await readFile(HOST_LOG, 'utf8')
    const lines = log.split('\n').filter((l) => l.includes('[dsh-knit] route ready'))
    return lines.at(-1) || ''
  } catch { return '' }
}

/* ── --list ───────────────────────────────────────────── */
if (argv.includes('--list')) {
  const rows = await recentSessions()
  console.log('08_Knit 工作区最近的会话（挑一个「现在还在 GUI 里开着」的）：\n')
  for (const row of rows.slice(0, 8)) {
    console.log(`  ${new Date(row.mtime).toLocaleString('zh-CN')}  ${row.id}`)
  }
  console.log('\n用它跑：node tools/verify-v0.14.mjs --session <id>')
  process.exit(0)
}

// 兼容两种传法：`--session <id>`（显式）与位置参数 `<id>`（照 verify-v0.11.mjs 的先例）。
const positional = argv.find((a) => !a.startsWith('--') && a !== argOf('--session') && a !== argOf('--root'))
const sessionId = argOf('--session') || positional
const wantRoot = argOf('--root') || '/Users/zhongwentuo/DeepSeek Harness Native/08_Knit'

console.log(`Knit v0.14 真机验收探针  →  ${BASE}`)
if (!sessionId) {
  console.log('\n⚠️ 没给 --session。')
  console.log('   `/knit/api/*` 只认「当前还开着」的会话；不填会让宿主兜底到 DSH 进程的 cwd，')
  console.log('   拿到一份看起来正常但工作区不对的结果。先跑：')
  console.log('     node tools/verify-v0.14.mjs --list')
  process.exit(1)
}
console.log(`sessionId = ${sessionId}`)

/* ── 1 · 插件是否挂在跑 ───────────────────────────────── */
section('1 · 插件在不在跑')
{
  const r = await get('/api/raw?rel=__knit_probe__.png')
  if (r.json && r.json.code === 'knit/not-found') {
    pass('路由在跑', '（空 body 的 404 = 没挂上；带 knit/not-found 才是活着）')
  } else {
    fail('路由在跑', `期望 {"ok":false,"code":"knit/not-found"}，实际 status=${r.status} body=${r.text.slice(0, 120)}`)
  }
}

/* ── 2 · 跑的是不是新代码 ─────────────────────────────── */
section('2 · 跑的是不是 v0.14 的代码')
{
  const r = await get('/api/context?sessionId=' + encodeURIComponent(sessionId))
  if (r.status === 200 && r.json && r.json.ok === true) {
    pass('/knit/api/context 存在', '（v0.13 没有这条路由）')
  } else {
    fail('/knit/api/context 存在',
      `status=${r.status} body=${r.text.slice(0, 160)}\n     ⇒ 宿主还是旧代码，必须**重启 DSH**（宿主半边不热加载）`)
  }
  const line = await lastRouteLine()
  if (line.includes('/api/context')) pass('宿主日志里的 route ready 含 /api/context')
  else fail('宿主日志里的 route ready 含 /api/context', `最后一条是：\n     ${line.slice(0, 200) || '（没找到）'}`)
}

/* ── 3 · 工作区是不是对的 ─────────────────────────────── */
section('3 · 会话工作区解析对了没有')
{
  const r = await get('/api/recent?sessionId=' + encodeURIComponent(sessionId) + '&sort=relevance&kind=doc')
  if (!r.json || r.json.ok !== true) {
    fail('拿到 recent 载荷', `${r.status} ${r.text.slice(0, 160)}`)
  } else {
    if (r.json.root === wantRoot) pass('root 是期望的工作区', r.json.root)
    else {
      fail('root 是期望的工作区',
        `实际 ${r.json.root}\n     ⇒ sessionId 不对/会话已归档，宿主兜底成了 DSH 进程的 cwd。`
        + `\n     先跑 --list 挑一个现在开着的会话。`)
    }
    if (r.json.total > 0) pass('扫到了 Markdown', `${r.json.total} 篇`)
    else fail('扫到了 Markdown', 'total = 0 —— 工作区不对，后面的断言都没意义')
  }
}

/* ── 4 · context 分层结构 ─────────────────────────────── */
section('4 · Context Pack 结构（真实工作区）')
{
  const r = await get('/api/context?sessionId=' + encodeURIComponent(sessionId) + '&sort=relevance&kind=doc')
  const pack = r.json && r.json.context
  if (!pack) {
    fail('载荷里有 context', r.text.slice(0, 200))
  } else {
    const shapeOk = Array.isArray(pack.primary) && Array.isArray(pack.supporting)
      && Array.isArray(pack.related) && pack.totals && pack.summary
    if (shapeOk) pass('三层 + totals + summary 齐全')
    else fail('三层 + totals + summary 齐全', JSON.stringify(Object.keys(pack)))

    // v0.14 规格（SDD §12）：task = **最新一条有效 user 消息原文**，不是模型生成的摘要。
    // 断言只查「它是个字符串」，不查内容 —— 内容是环境相关的，查内容就是查死数据。
    if (typeof pack.task === 'string') {
      pass('task 是字符串（规格要求：引用最近一条 user 消息原文）',
        pack.task ? `${pack.task.length} 字符：${pack.task.slice(0, 40)}…` : '空串（本次会话没有可引用的 user 消息）')
    } else fail('task 是字符串', describe(pack.task))

    // v0.14 数量收敛（PRD §5 / SDD §25）：Primary 1、Supporting 3、Related 5。
    // 注意这里是**上限**不是配额：Primary 允许为空（「这里没有主文档」是合法结论）。
    const caps = pack.primary.length <= 1 && pack.supporting.length <= 3 && pack.related.length <= 5
    if (caps) pass('上限成立（1 / 3 / 5）', `主要 ${pack.primary.length} / 辅助 ${pack.supporting.length} / 相关 ${pack.related.length}`)
    else fail('上限成立（1 / 3 / 5）', `主要 ${pack.primary.length} / 辅助 ${pack.supporting.length} / 相关 ${pack.related.length}`)

    // 三层不许重复
    const rels = [...pack.primary, ...pack.supporting, ...pack.related].map((x) => x.rel)
    if (new Set(rels).size === rels.length) pass('同一条没有跨层重复', `${rels.length} 条`)
    else fail('同一条没有跨层重复', JSON.stringify(rels))

    // 主要上下文必须有落脚点（理由码限定）
    const grounded = new Set(['direct', 'titleMatch', 'summaryMatch'])
    const badPrimary = pack.primary.filter((x) => !grounded.has(x.reason && x.reason.code))
    if (badPrimary.length === 0) pass('主要上下文的每一条都有落脚点')
    else fail('主要上下文的每一条都有落脚点', badPrimary.map((x) => `${x.rel}[${x.reason.code}]`).join('、'))

    // 零命中进前两层必须是靠引用关系
    const zeroHitBad = [...pack.primary, ...pack.supporting].filter((x) => {
      const linked = x.reason.code === 'linkTarget' || x.reason.code === 'linkSource'
      return x.reason.terms.length === 0 && !linked
    })
    if (zeroHitBad.length === 0) pass('零命中的条目只能靠引用关系进前两层')
    else fail('零命中的条目只能靠引用关系进前两层', zeroHitBad.map((x) => `${x.rel}[${x.reason.code}]`).join('、'))

    // Related 里的每一条也要有据可查（2026-09-29 收紧）：
    // 「一个话题词都没命中、又没有任何引用关系」的文档**不许出场** ——
    // 它唯一的理由会是兜底码 `related`，客户端把它译成「与当前工作区相关」，
    // 而那是需求 §九 明令禁止的无法验证的推断。Related 为空是合法结论。
    const relatedBad = pack.related.filter((x) => {
      const linked = x.reason.code === 'linkTarget' || x.reason.code === 'linkSource'
      return x.reason.code === 'related' || (x.reason.terms.length === 0 && !linked)
    })
    if (relatedBad.length === 0) pass('Related 里的每一条都有据可查（不是「工作区里还有这一篇」）')
    else fail('Related 里的每一条都有据可查', relatedBad.map((x) => `${x.rel}[${x.reason.code}]`).join('、'))

    // 每条理由的码在封闭集合里 + 条目字段固定
    const codes = new Set(['direct', 'titleMatch', 'summaryMatch', 'bodyMatch', 'linkTarget', 'linkSource', 'related'])
    const badCode = [...pack.primary, ...pack.supporting, ...pack.related].filter((x) => !codes.has(x.reason.code))
    if (badCode.length === 0) pass('理由码都在封闭集合里')
    else fail('理由码都在封闭集合里', badCode.map((x) => `${x.rel}[${x.reason.code}]`).join('、'))

    const expectKeys = ['kind', 'mtimeMs', 'reason', 'rel', 'source', 'summary', 'title']
    const badKeys = [...pack.primary, ...pack.supporting, ...pack.related]
      .filter((x) => JSON.stringify(Object.keys(x).sort()) !== JSON.stringify(expectKeys))
    if (badKeys.length === 0) pass('条目字段固定', expectKeys.join('/'))
    else fail('条目字段固定', badKeys.slice(0, 3).map((x) => Object.keys(x).join('/')).join(' | '))

    if (pack.summary.matched === pack.totals.matched && pack.summary.total === pack.totals.total) {
      pass('summary 与 totals 一致')
    } else fail('summary 与 totals 一致', JSON.stringify({ summary: pack.summary, totals: pack.totals }))
  }
}

/* ── 5 · 内部字段不泄漏 ───────────────────────────────── */
section('5 · 装配层的内部输入一个都没下发')
{
  const recent = await get('/api/recent?sessionId=' + encodeURIComponent(sessionId) + '&sort=relevance&kind=doc&limit=60')
  const ctx = await get('/api/context?sessionId=' + encodeURIComponent(sessionId) + '&sort=relevance&kind=doc')
  let leaked = []
  for (const [name, r] of [['/api/recent', recent], ['/api/context', ctx]]) {
    const body = r.text
    const hits = FORBIDDEN.filter((f) => body.includes(f))
    if (hits.length) leaked.push(`${name}: ${hits.join(',')}`)
    if (body.includes('ranked')) leaked.push(`${name}: ranked`)
  }
  if (leaked.length === 0) pass('没有 raw / matchedTerms / strength / haystack / head / rank / ranked')
  else fail('没有内部字段泄漏', leaked.join('；'))

  // Context Pack 的条目里**只许有 rel**。这条比「响应里不许出现绝对路径」准 ——
  // `recent.docs[].path` 是绝对路径，而那是 v0.13 就有的**既定契约**
  // （客户端用它做「在新标签页打开」，面板 meta 行显示的是 `rel`）。
  // 拿「整个响应里不许出现 root」当判据会误报（第一版就误报了）。
  const packs = [ctx.json && ctx.json.context, recent.json && recent.json.context].filter(Boolean)
  const badRel = []
  for (const pack of packs) {
    for (const item of [...(pack.primary || []), ...(pack.supporting || []), ...(pack.related || [])]) {
      if (typeof item.rel !== 'string' || item.rel.startsWith('/') || item.rel.includes(wantRoot)) {
        badRel.push(String(item.rel))
      }
      if ('path' in item) badRel.push(`${item.rel} 带了 path 字段`)
    }
  }
  if (badRel.length === 0) pass('Context Pack 条目的 rel 全是相对路径，且不带 path 字段')
  else fail('Context Pack 条目的 rel 全是相对路径', badRel.slice(0, 3).join('、'))

  if (recent.json && 'context' in recent.json) pass('/api/recent 顺带给了 context 字段')
  else fail('/api/recent 顺带给了 context 字段', `keys=${recent.json ? Object.keys(recent.json).join(',') : '?'}`)

  // 老客户端兼容：docs 的形状与 v0.13 一致
  const d = recent.json && recent.json.docs && recent.json.docs[0]
  // ⚠️ 要比较**同一份**期望的排序副本 —— `[a,b].sort()` 是原地排序，
  // 直接拿 expectDoc 去比会把期望也一起排掉，于是两边永远「看起来一样」或
  // 「看起来差一个」（第一版就在这上面误报过一次）。
  const expectDoc = ['kind', 'path', 'rel', 'name', 'title', 'summary', 'size', 'mtimeMs', 'score'].sort()
  const actualDoc = d ? Object.keys(d).sort() : []
  if (JSON.stringify(actualDoc) === JSON.stringify(expectDoc)) {
    pass('recent.docs 的形状与 v0.13 逐字一致', expectDoc.join('/'))
  } else {
    fail('recent.docs 的形状与 v0.13 逐字一致',
      `期望 ${expectDoc.join('/')}\n     实际 ${actualDoc.join('/') || '（没有 docs）'}`)
  }
}

/* ── 6 · 时间序 / 媒体档不该分层 ──────────────────────── */
section('6 · 不该分层的档位确实没分层')
{
  // ⚠️ 取值要防 undefined —— `JSON.stringify(undefined)` 返回 undefined，
  // 再 `.slice()` 会直接把探针自己炸掉（第一版就炸过），于是「有一项失败」变成「整个脚本挂了」。
  const describe = (v) => (v === undefined ? '（字段不存在 —— 旧代码）' : JSON.stringify(v))
  for (const [label, query] of [
    ['时间序', 'sort=time&kind=doc'],
    ['媒体档', 'sort=relevance&kind=media'],
    ['全部档', 'sort=relevance&kind=all'],
  ]) {
    const r = await get(`/api/recent?sessionId=${encodeURIComponent(sessionId)}&${query}`)
    const value = r.json && r.json.context
    if (value === null) pass(`${label}：context = null（面板退回平铺列表）`)
    else fail(`${label}：context = null`, describe(value).slice(0, 120))
  }
}

/* ── 7 · 性能（一次轮询的完整成本）────────────────────── */
section('7 · 一次「5 秒轮询」的完整成本')
{
  const url = `/api/recent?sessionId=${encodeURIComponent(sessionId)}&sort=relevance&kind=doc&limit=60`
  await get(url)                                   // 预热
  const runs = []
  for (let i = 0; i < 6; i += 1) {
    const t0 = performance.now()
    await get(url)
    runs.push(performance.now() - t0)
  }
  runs.sort((a, b) => a - b)
  const median = runs[Math.floor(runs.length / 2)]
  const worst = runs.at(-1)
  const label = `中位 ${median.toFixed(0)}ms / 最差 ${worst.toFixed(0)}ms（含引用图 + 装配）`
  if (median < 400) pass('轮询成本可接受', label)
  else fail('轮询成本可接受', label)
}

/* ── 8 · 工具返回值 vs 它自己的 schema（进程内）────────── */
section('8 · knit_docs 的返回值能通过它自己的 OUTPUT_SCHEMA')
{
  // ⚠️ 这一节**不看运行中的宿主**，直接 import 磁盘上的代码跑一次真实 `execute()`
  // —— 所以它在**重启之前**就能判定「代码改对了没有」，与前面七节互补：
  // 那七节问的是「跑着的宿主是不是新代码」，这一节问的是「磁盘上的代码自不自洽」。
  //
  // 加它的原因是一次真实事故：工具的输出 schema 是**封闭**的
  // （`additionalProperties: false`），而三层条目带了 `kind` / `reason.term` / `totals`
  // 三个没声明的字段、`mtimeMs` 还是浮点（`fs.Stats.mtimeMs` 本来就是浮点）
  // ⇒ 宿主的校验层把**每一次** `knit_docs` 调用都拒了，agent 一个 Context Pack
  // 都拿不到，而当时 335 条测试全绿 —— 因为所有 tool 测试都是拿手写的假 payload
  // 测渲染函数，**没有一条验过真实返回值**。是在真机对照实验里暴露的。
  const { knitDocsDefinition } = await import('../src/host/tool.js')
  const { scan, readDocument, buildContextFor } = await import('../src/host/index.js')
  const { validateAgainst } = await import('./json-schema-subset.mjs')

  const definition = knitDocsDefinition(scan, readDocument, buildContextFor)
  const session = {
    header: { cwd: wantRoot, id: 'verify-v0.14-probe' },
    snapshotEvents: () => [],
  }

  for (const [label, args] of [
    ['relevance（给了 query）', { query: '相关性排序 BM25 长度归一化' }],
    ['time（没对话、也没 query）', {}],
  ]) {
    let value
    try {
      value = await definition.execute(args, { agent: { session } })
    } catch (err) {
      fail(`${label}：execute() 不抛异常`, String(err && err.message))
      continue
    }
    const errors = validateAgainst(definition.output.schema, value)
    if (errors.length === 0) pass(`${label}：返回值通过自己的 schema`, `mode=${value.mode}`)
    else fail(`${label}：返回值通过自己的 schema`, errors.slice(0, 6).join('\n     '))
  }
}

/* ── 收尾 ─────────────────────────────────────────────── */
section(failed === 0 ? '全部通过 ✅' : `${failed} 项失败 ❌`)
console.log(`
还没验的一项（脚本没法替你做，但很短）：
  浏览器里看面板 —— 硬刷新（Cmd+Shift+R），相关模式下应当看到**双栏**：
     左栏是三层分区的文档列表（主要 / 辅助 / 相关，每条带编号、主要那条前面有个黑点、
     右上一个 Why 短句），右栏是一个安静的说明栏 ——
     「Context Pack  N 个上下文」/ 分隔线 / 「当前任务」+ 一句话 / 分隔线 /
     「直接主题命中 · 存在辅助关系 · 保留相关背景」三行证据类型。
     窗口拖到 1000px 以下应当并回单栏（右栏落到列表下面，不出现横向滚动条）。
`)
process.exit(failed === 0 ? 0 : 1)

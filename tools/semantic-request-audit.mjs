/**
 * Knit · **语义请求隐私审计**（v0.23.x）—— 把「远端 provider 到底收到了什么」变成可执行证据。
 *
 * 为什么要有这个脚本：README / `package.json` / 市场简介都在说「只发标题与摘要、不发正文」。
 * 那句话的**唯一真源**是 `semantic.js` 的 `embedTextOf()` —— 但它是不是真的按那句话执行，
 * 只有把**实际发出去的字节**录下来才算数。读代码得出的结论与跑一次得出的结论，
 * 在「有没有别的东西混进去」这个问题上不是一回事。
 *
 * 做法：装一个**录音 fetch**（既能应答探测与嵌入，又把每一次请求的 URL / 方法 / body 原样存下），
 * 用**真实工作区**跑一轮 `retrieval=hybrid` 的 `scan()`，然后逐条断言。
 *
 * 跑法（`--root` 默认是插件仓库的上一级，也就是这个工作区）：
 *
 * ```sh
 * cd knit && node tools/semantic-request-audit.mjs
 * node tools/semantic-request-audit.mjs --root "/path/to/workspace"
 * node tools/semantic-request-audit.mjs --json          # 只打最后那行 JSON
 * ```
 *
 * ⚠️ **它不打任何真网络**：fetch 是注入的录音替身。这里量的是「我们构造了什么报文」，
 * 不是「某个真服务收到了什么」—— 后者只有真 provider 才能验（见 `hybrid-retrieval-eval.mjs` 的 H1）。
 *
 * 退出码：任何一条硬断言不成立 ⇒ 1（可以接进任何闸门）。**只读**：不写仓库、不改配置。
 */

import { readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { scan, setSemanticEngine } from '../src/host/index.js'
import { createSemanticEngine } from '../src/host/semantic.js'

const HERE = dirname(fileURLToPath(import.meta.url))
/** 默认工作区 = 插件仓库的上一级（本机的 `08_Knit`）。 */
const DEFAULT_ROOT = resolve(HERE, '..', '..')

const argOf = (name, fallback) => {
  const i = process.argv.indexOf(name)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}
const JSON_ONLY = process.argv.includes('--json')

const root = resolve(argOf('--root', DEFAULT_ROOT))
const QUERY = argOf('--query', '语义候选 标题与摘要 发到远端 provider')

/** 注入用的 provider 配置（回环地址，永远不会真的连上）。 */
const CONFIG = { kind: 'ollama', base: 'http://127.0.0.1:11434', model: 'audit-recorder-v1' }

/** 断言结果收集。 */
const checks = []
const check = (id, title, ok, detail) => {
  checks.push({ id, title, ok: !!ok, detail: detail || '' })
}

/**
 * 录音 fetch：应答探测与嵌入，且把每一次请求的**原始字节**存进 `log`。
 * @param {Array<object>} log
 * @returns {Function} fetch 替身
 */
function recordingFetch(log) {
  const impl = async (url, init) => {
    const entry = {
      url: String(url),
      method: (init && init.method) || 'GET',
      headers: (init && init.headers) || null,
      body: init && typeof init.body === 'string' ? init.body : null,
    }
    log.push(entry)
    if (entry.url.includes('/api/tags')) {
      return { status: 200, json: async () => ({ models: [] }) }
    }
    // 嵌入：给每个输入一条等长向量（内容不重要 —— 这里量的是**请求**，不是结果）。
    const input = JSON.parse(entry.body || '{"input":[]}').input
    return { status: 200, json: async () => ({ embeddings: input.map(() => [1, 0, 0]) }) }
  }
  return impl
}

/** 把 `embedTextOf()` 的口径在审计侧复算一遍（**不改源码**，只做同一件事）。 */
const textOf = (doc) => {
  const title = typeof doc.title === 'string' ? doc.title : ''
  const summary = typeof doc.summary === 'string' ? doc.summary : ''
  const text = `${title}\n${summary}`.trim()
  return text.length > 0 ? text.slice(0, 2000) : null
}

/** 会话替身：走「面板那条路」（`task` = 用户原话），查询文本才是原话而不是关键词碎片。 */
const session = {
  header: { cwd: root, id: 'audit-session' },
  snapshotEvents: () => [{
    seq: 1,
    type: 'user/message',
    data: { role: 'user', content: [{ type: 'text', text: QUERY }], source: { kind: 'user' } },
  }],
}

const log = []
const engine = createSemanticEngine({ store: null, fetchImpl: recordingFetch(log) })
await engine.configure(CONFIG)
setSemanticEngine(engine)

const args = { session, sessionId: 'semantic-request-audit', sort: 'relevance', kind: 'context', retrieval: 'hybrid' }
// 一轮最多新嵌 8 篇（`SEM_EMBED_PER_PASS`）⇒ 想看到**几乎全部**语料的报文就要多跑几轮。
// 上限 40 轮是防呆：语料再大也只证明「被录到的这些」是什么样，不假装录全了。
const PER_PASS = 8
let payload = await scan(root, 40, args)
const corpusSize = Array.isArray(payload.allDocs) ? payload.allDocs.length : 0
const passes = Math.min(40, Math.ceil(corpusSize / PER_PASS) + 1)
for (let i = 1; i < passes; i += 1) payload = await scan(root, 40, args)
setSemanticEngine(null)
const PASSES_RUN = passes

/* ── 从录到的报文里挑出嵌入请求 ───────────────────────── */

const embeds = log.filter((e) => e.method === 'POST' && e.url.endsWith('/api/embed'))
const probes = log.filter((e) => e.method === 'GET')
const bodies = embeds.map((e) => e.body || '')

/** 每个输入串对应的文档（按 `textOf()` 精确匹配回表）。 */
const docs = Array.isArray(payload.allDocs) ? payload.allDocs : []
const byText = new Map()
for (const doc of docs) {
  const text = textOf(doc)
  if (text) byText.set(text, doc)
}

/** 拆出所有输入串，并尽量映射回文档。 */
const inputs = []
for (const body of bodies) {
  let parsed = null
  try { parsed = JSON.parse(body) } catch { /* 下面会判成坏形状 */ }
  const list = parsed && Array.isArray(parsed.input) ? parsed.input : []
  for (const text of list) inputs.push({ text, doc: byText.get(text) || null })
}

/* ── 硬断言 ─────────────────────────────────────────── */

// C1：顶层字段只有 model + input（两种协议共用同一条构造，见 `semantic.js` 的 `embed()`）。
const keySets = bodies.map((body) => {
  try { return Object.keys(JSON.parse(body)).sort().join(',') } catch { return '(unparsable)' }
})
const uniqueKeySets = [...new Set(keySets)]
check('C1', '嵌入请求的顶层字段只有 model + input', uniqueKeySets.length === 1 && uniqueKeySets[0] === 'input,model',
  `实测字段集合：${JSON.stringify(uniqueKeySets)}`)
check('C1b', '嵌入请求没有额外请求头（只有 content-type）',
  bodies.length > 0 && embeds.every((e) => Object.keys(e.headers || {}).join(',').toLowerCase() === 'content-type'),
  `实测：${JSON.stringify([...new Set(embeds.map((e) => JSON.stringify(e.headers || {})))])}`)

// C2：任何报文里都不许出现绝对路径。
const absoluteMarkers = [root, '/Users/', '/home/', 'file://']
const hitAbsolute = absoluteMarkers.filter((m) => bodies.some((b) => b.includes(m)))
check('C2', '报文里没有绝对路径（工作区根 / 家目录 / file://）', hitAbsolute.length === 0,
  hitAbsolute.length === 0 ? '四条标记一条都没出现' : `命中：${JSON.stringify(hitAbsolute)}`)

// C3：**每一个**输入串都必须能被解释成「查询原话」或「某一篇的 title + summary」。
// 这条比「没有出现某个字符串」强：多塞任何一个字段（rel / path / 正文 / 元数据）都会
// 让这个输入串对不上任何一篇的 `title + summary`，于是它当场变成未解释项。
const queryEmbedCount = inputs.filter((i) => i.text === QUERY).length
const unexplained = inputs.filter((i) => !i.doc && i.text !== QUERY)
check('C3', '每个输入串都能被解释成「查询原话」或某篇的 title + summary（多一个字段就会掉出这个集合）',
  unexplained.length === 0,
  unexplained.length === 0
    ? `${inputs.length} 条输入全部可解释（查询 ${queryEmbedCount} 条 / 文档 ${inputs.length - queryEmbedCount} 条）`
    : `无法解释 ${unexplained.length} 条：${JSON.stringify(unexplained.slice(0, 3).map((i) => i.text))}`)

// C3b：代码的 summary 槽必须是**工作区相对目录**（空串 = 根目录，否则以 `/` 结尾）。
// ⚠️ 根目录下的代码文件（`dir === ''`）里 `title` 就是文件名、`rel` 也就是文件名 ——
// 两者相同是**定义使然**，不是「把路径当字段发」。真正要守的是「没有前导斜杠 / 盘符 / 反斜杠」。
const codeDocInputs = inputs.filter((i) => i.doc && i.doc.kind !== 'md')
const badDirSlot = codeDocInputs.filter((i) => {
  const dir = String(i.doc.summary || '')
  return dir.includes('\\') || dir.startsWith('/') || /^[A-Za-z]:/.test(dir) || (dir !== '' && !dir.endsWith('/'))
})
check('C3b', '代码的 summary 槽是工作区相对目录（空串或 `xxx/` 结尾，无前导斜杠 / 盘符 / 反斜杠）',
  badDirSlot.length === 0,
  badDirSlot.length === 0 ? `逐条比过 ${codeDocInputs.length} 条代码输入` : `命中：${JSON.stringify(badDirSlot.slice(0, 3).map((i) => i.doc.rel))}`)

// C4：正文不许成片出现 —— 用「文件正文前 200 字符」与「正文中段 200 字符」两处探针。
const bodyProbes = []
for (const doc of docs) {
  if (!doc.path) continue
  try {
    const raw = await readFile(doc.path, 'utf8')
    if (raw.length >= 400) bodyProbes.push({ rel: doc.rel, head: raw.slice(0, 200), mid: raw.slice(Math.floor(raw.length / 2), Math.floor(raw.length / 2) + 200) })
  } catch { /* 读不到就跳过 —— 这条断言只对被读到的文件成立，报告里会写明覆盖数 */ }
}
const leakedBodies = bodyProbes.filter((p) => bodies.some((b) => b.includes(p.head) || b.includes(p.mid)))
check('C4', '没有任何一篇的正文成片（200 字符）出现在报文里', leakedBodies.length === 0,
  leakedBodies.length === 0
    ? `对 ${bodyProbes.length} 篇真实文件做了「开头 200 字 + 中段 200 字」两处探针，均未出现`
    : `命中：${JSON.stringify(leakedBodies.map((p) => p.rel))}`)

// C5：每个输入串的形状 —— 最多一个换行（title\summary 的分隔符）、长度 ≤ 2000。
const badShape = inputs.filter((i) => (i.text.match(/\n/g) || []).length > 1 || i.text.length > 2000)
check('C5', '每个输入串至多一个换行、长度 ≤ 2000', badShape.length === 0,
  badShape.length === 0 ? `${inputs.length} 条输入全部合规` : `${badShape.length} 条不合规`)

// C6：**如实披露** —— 查询原话本身是被发出去的（它也是嵌入输入之一，且**每一轮都重发**）。
check('C6', '查询原话确实作为嵌入输入发出（这是要如实披露的事实，不是缺陷）', queryEmbedCount > 0,
  queryEmbedCount > 0
    ? `共发出 ${queryEmbedCount} 次（跑了 ${PASSES_RUN} 轮 —— 文档向量有缓存、查询没有）`
    : '没在报文里找到查询原话（若如此，下面的披露结论要改写）')

/* ── 摘要的**来源**：正文派生 vs 目录 ─────────────────── */

const mdInputs = inputs.filter((i) => i.doc && i.doc.kind === 'md')
const codeInputs = inputs.filter((i) => i.doc && i.doc.kind !== 'md')
const embeddedRels = [...new Set(inputs.filter((i) => i.doc).map((i) => i.doc.rel))]

/** Markdown 摘要的最长正文派生字符数（去掉结尾的 `…` 省略号）。 */
let maxMdBodyDerived = 0
for (const i of mdInputs) {
  const summary = String(i.doc.summary || '')
  const core = summary.endsWith('…') ? summary.slice(0, -1) : summary
  maxMdBodyDerived = Math.max(maxMdBodyDerived, core.length)
}

/** 代码路径摘要：去重后的目录集合。 */
const codeDirs = [...new Set(codeInputs.map((i) => String(i.doc.summary || '')))].sort()

// C7：**如实披露**（不是缺陷）—— Markdown 的摘要是正文散文，散文里可能**顺带提到**别的文件的相对路径。
// 这些字符串出现在报文里不是因为 Knit 把路径当字段发，而是因为那篇文档本身在正文里引用了它。
const rels = docs.map((d) => d.rel).filter((r) => r && r.length > 6)
const quotedRels = new Set()
for (const i of mdInputs) {
  for (const rel of rels) if (rel !== i.doc.rel && i.text.includes(rel)) quotedRels.add(rel)
}
check('C7', '披露：Markdown 摘要散文里顺带提到的相对路径（不是字段，是正文内容）', true,
  quotedRels.size === 0
    ? '本轮语料里一条都没有'
    : `${quotedRels.size} 条：${JSON.stringify([...quotedRels].slice(0, 5))}`)

/* ── 输出 ───────────────────────────────────────────── */

if (!JSON_ONLY) {
  const line = (s = '') => console.log(s)
  line('Knit · 语义请求隐私审计（录音 fetch + 真实工作区）')
  line(`  工作区      ${root}`)
  line(`  插件版本    ${JSON.parse(await readFile(join(HERE, '..', 'package.json'), 'utf8')).version}`)
  line(`  查询原话    ${JSON.stringify(QUERY)}`)
  line(`  语料        ${docs.length} 篇（md ${docs.filter((d) => d.kind === 'md').length} / 其余 ${docs.filter((d) => d.kind !== 'md').length}）`)
  line(`  覆盖        ${PASSES_RUN} 轮 scan ⇒ 录到 ${embeddedRels.length} 篇的嵌入报文（占语料 ${(embeddedRels.length / (docs.length || 1) * 100).toFixed(1)}%）`)
  line()

  line('── 一、报文清单（按实际发生的顺序）──')
  const tally = new Map()
  for (const e of log) {
    const key = `${e.method} ${e.url.replace(CONFIG.base, '<base>')}${e.body ? `  body=${e.body.length}B` : ''}`
    tally.set(key, (tally.get(key) || 0) + 1)
  }
  for (const [key, n] of tally) line(`  ×${String(n).padEnd(3)} ${key}`)
  line()

  line('── 二、硬断言 ──')
  for (const c of checks) line(`  ${c.ok ? '✅' : '❌'} ${c.id.padEnd(4)} ${c.title}\n        ${c.detail}`)
  line()

  line('── 三、Markdown 的「摘要」是什么 ──')
  line(`  被嵌入的 Markdown 篇数：${mdInputs.length}`)
  line(`  摘要的**最长**正文派生字符数：${maxMdBodyDerived}（源码常量 SUMMARY_CHARS = 60，超出会加 `+'`…`'+`）`)
  line('  ⇒ 「标题 + 摘要」里的「摘要」**是正文的首个正文段落节选**，不是与正文无关的元数据。')
  line()

  line('── 四、代码的「摘要」是什么 ──')
  line(`  被嵌入的代码篇数：${codeInputs.length}；涉及 ${codeDirs.length} 个不同目录`)
  for (const dir of codeDirs.slice(0, 12)) line(`    ${JSON.stringify(dir)}`)
  if (codeDirs.length > 12) line(`    …其余 ${codeDirs.length - 12} 个`)
  line('  ⇒ 代码的 summary 槽放的是**工作区相对目录**（`src/host/` 这种），不是绝对路径、也不是正文。')
  line()

  line('── 五、逐条报文（前 6 个嵌入输入）──')
  for (const i of inputs.slice(0, 6)) {
    const who = i.doc ? `${i.doc.rel}  [${i.doc.kind}]` : '(查询原话)'
    line(`  ${who}`)
    line(`    ${JSON.stringify(i.text)}`)
  }
  line()

  const failed = checks.filter((c) => !c.ok)
  line(failed.length === 0
    ? '结论：硬断言全部成立 —— 「只发标题与摘要」在**报文层面**成立。'
    : `结论：有 ${failed.length} 条硬断言不成立（见上），在修好之前不许对外说「只发标题与摘要」。`)
  line('但同一轮审计还量到三件必须一起说出去的事：')
  line(`  ① 查询原话（用户那句话）本身也发出去 —— 跑 ${PASSES_RUN} 轮就发 ${queryEmbedCount} 次（C6）；`)
  line(`  ② Markdown 的「摘要」是正文首个正文段落的节选（最长 ${maxMdBodyDerived} 字符，源码常量 SUMMARY_CHARS=60）—— 不是与正文无关的元数据（第三节）；`)
  line(`  ③ 代码的「摘要」槽放的是工作区**相对目录**（${codeDirs.length} 个不同目录），不是绝对路径、也不是正文（第四节）。`)
}

const json = {
  tool: 'semantic-request-audit',
  root,
  query: QUERY,
  provider: { kind: CONFIG.kind, base: CONFIG.base, model: CONFIG.model },
  passes: PASSES_RUN,
  requests: { total: log.length, probe: probes.length, embed: embeds.length },
  corpus: { docs: docs.length, md: docs.filter((d) => d.kind === 'md').length, other: docs.filter((d) => d.kind !== 'md').length },
  coverage: { docsEmbedded: embeddedRels.length, share: docs.length ? Number((embeddedRels.length / docs.length).toFixed(3)) : 0 },
  inputs: {
    total: inputs.length,
    mappedToDoc: inputs.filter((i) => i.doc).length,
    queryEmbedCount,
    queryIncluded: queryEmbedCount > 0,
    maxNewlines: inputs.reduce((m, i) => Math.max(m, (i.text.match(/\n/g) || []).length), 0),
    maxChars: inputs.reduce((m, i) => Math.max(m, i.text.length), 0),
  },
  summaryProvenance: {
    markdown: { embedded: mdInputs.length, maxBodyDerivedChars: maxMdBodyDerived, sourceConstant: 'SUMMARY_CHARS=60', bodyDerived: true },
    code: { embedded: codeInputs.length, distinctDirs: codeDirs.length, summaryIsRelativeDir: true },
  },
  disclosure: { querySent: queryEmbedCount > 0, markdownSummaryIsBodyExcerpt: true, codeSummaryIsRelativeDir: true, quotedRels: [...quotedRels].slice(0, 20), quotedRelCount: quotedRels.size },
  checks,
  passed: checks.every((c) => c.ok),
}
console.log(`\nJSON ${JSON.stringify(json)}`)
process.exitCode = checks.every((c) => c.ok) ? 0 : 1

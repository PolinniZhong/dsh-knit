/**
 * Knit · **关系投影**（v0.21）
 *
 * 回答「这一篇为什么在这个包里」的第二种答案：不是检索命中，而是**与包内某篇有证据级关系**。
 *
 * ## 只做四类，每一类都必须有可核验的证据
 *
 * | type | 边 | 证据怎么来 |
 * |---|---|---|
 * | `references` | md → md | 路径提及（复用 v0.12 的抽取器） |
 * | `documents` | md → 代码 | 同一条抽取，目标**显式**放开到代码 |
 * | `imports` | 代码 → 代码 | 逐行正则 + 相对路径解析 |
 * | `tests` | 测试 ↔ 被测 | 文件名约定，**歧义一律不算** |
 *
 * **不做** `calls`（没有 AST / 符号分析就是猜，且直接撞 v0.19 的禁区）、不建 import 图、
 * 不解析符号、不做 Git provenance（推迟）、不参与排序（需求 §6.3）。
 *
 * ## 这是投影，不是第二个排序阶段
 *
 * 关系在 Context Pack **装配完成之后**才对**包内条目**投影：不改名次、不改分层、
 * 不把任何一篇「拉进」包里。它的唯一用途是**解释**。
 *
 * ## 零 I/O
 *
 * 用的是排序器手里**已经有**的那份文本（md 的 `head` = 16 KB、代码的 `head` = 8 KB）。
 * 本模块不读盘、不 spawn 子进程、不发网络请求。
 *
 * ## `line` 的语义
 *
 * `{ type, dir, other, line }` 里 `line` 是**提及所在文件的真实行号**：
 * `dir:'out'` 时在本项文件里，`dir:'in'` 时在 `other` 文件里。
 * `tests` 是**唯一没有 `line`** 的一类 —— 它的证据是文件名约定（一条可核验的路径事实），
 * 不是某一行的文字，所以如实不给行号，而不是编一个出来。
 */

import { createIndex, extractRefsWithLines, resolveRef } from './links.js'

/** 与 `links.js` 里那两个私有 helper 同一口径（那边不导出，这里只需要两行）。 */
const dirOf = (rel) => {
  const i = String(rel).lastIndexOf('/')
  return i < 0 ? '' : String(rel).slice(0, i)
}
const baseOf = (rel) => {
  const i = String(rel).lastIndexOf('/')
  return i < 0 ? String(rel) : String(rel).slice(i + 1)
}

/** 面板每项最多投影几条关系（§6.7 / D4：这是**预算约束**，不是建议）。 */
export const MAX_RELATIONS_PER_ITEM = 3

/** `knit_docs` 每项最多投影几条（§9：工具输出比面板更贵）。 */
export const MAX_TOOL_RELATIONS_PER_ITEM = 2

/** 四类关系，**这个顺序就是截断优先级**（需求 §6.2 的 ① ② ③ ④）。 */
export const RELATION_TYPES = ['references', 'imports', 'tests', 'documents']

const TYPE_RANK = new Map(RELATION_TYPES.map((t, i) => [t, i]))

/** `imports` 补全扩展名的顺序 —— 固定顺序本身就是确定性的一部分。 */
const EXTS = ['mjs', 'js', 'cjs', 'ts', 'tsx', 'jsx', 'md']

/**
 * 逐行正则：`import … from '…'` / 裸 `import '…'` / `require('…')` 三种真实写法。
 * 已在真数据上验证（它抓出来的第一件事就是 v0.20.1 那条包装缺陷本身）。
 *
 * ⚠️ 行首缩进用 `[^\S\n]*`（只吃空格与制表符），**不能用 `\s*`** —— `\s` 会吃掉前一行的
 * 换行，`m.index` 就落到上一行末尾，行号整体少 1。这是测试抓出来的，不是假想。
 */
const IMPORT_RE = /^[^\S\n]*(?:import\s[^\n]*?from\s*|import\s*|(?:const|let|var)\s[^\n]*?=\s*require\s*\()\s*['"]([^'"]+)['"]/gm

const isMd = (rel) => /\.md$/i.test(String(rel))
/** 测试文件的两种真实命名：`x.test.mjs` / `x.spec.js`。 */
const isTestRel = (rel) => /\.(?:test|spec)\.[A-Za-z0-9]+$/.test(String(rel))

/**
 * 从代码正文里抽出**相对**导入指定符及其行号。纯函数，零 I/O。
 *
 * 裸指定符（`node:test`、`react`）也如实返回 —— 过滤交给 `resolveSpec()`，
 * 那里才知道候选集里有什么。
 *
 * @param {string} text - 代码正文（原文）
 * @returns {Array<{spec: string, line: number}>} 去重（保留首次出现），按出现顺序
 */
export function importsOf(text) {
  if (typeof text !== 'string' || text === '') return []
  const out = []
  const seen = new Set()
  let line = 1
  let from = 0
  for (const m of text.matchAll(IMPORT_RE)) {
    // 行号增量数出来（matchAll 的下标天然升序，所以一次线性扫描就够）
    for (let i = from; i < m.index; i++) if (text.charCodeAt(i) === 10) line += 1
    from = m.index
    const spec = m[1]
    if (seen.has(spec)) continue
    seen.add(spec)
    out.push({ spec, line })
  }
  return out
}

/**
 * 把 `fromRel` 与一个相对路径拼成工作区 rel。**出了工作区就返回 null**
 * （`../../../etc/passwd` 这类不产生关系，也不做任何「猜一个」）。
 */
function joinRel(fromRel, spec) {
  const dir = dirOf(fromRel)
  const parts = (dir ? dir.split('/') : []).concat(String(spec).split('/'))
  const stack = []
  for (const p of parts) {
    if (p === '' || p === '.') continue
    if (p === '..') {
      if (stack.length === 0) return null
      stack.pop()
      continue
    }
    stack.push(p)
  }
  return stack.length > 0 ? stack.join('/') : null
}

/**
 * 把一条导入指定符解析成候选集里的 rel。**解析不出来就返回 null**。
 *
 * 只认相对指定符（`./` / `../`）—— 裸指定符是包，不是工作区文件。
 * 扩展名补全顺序：原样 → `.mjs` / `.js` / `.ts` / `.tsx` / `.jsx` / `.md` → `/index.<ext>`。
 *
 * @param {string} spec - 指定符原文
 * @param {string} fromRel - 导入方的 rel
 * @param {object} relIndex - `createIndex()` 的产物（候选集）
 * @returns {string|null}
 */
export function resolveSpec(spec, fromRel, relIndex) {
  const raw = String(spec || '').trim()
  if (!raw || !relIndex || !(relIndex.relSet instanceof Set)) return null
  if (!raw.startsWith('./') && !raw.startsWith('../')) return null
  const base = joinRel(fromRel, raw)
  if (!base) return null
  if (relIndex.relSet.has(base)) return base
  for (const ext of EXTS) {
    const hit = `${base}.${ext}`
    if (relIndex.relSet.has(hit)) return hit
  }
  for (const ext of EXTS) {
    const hit = `${base}/index.${ext}`
    if (relIndex.relSet.has(hit)) return hit
  }
  return null
}

/**
 * 按文件名约定找「对面那一篇」。**歧义一律不算**（与 v0.12 的 basename 规则同一条纪律）：
 * 命中 0 个或多个都返回 `null`。
 *
 * 只有两种写法算数，都是可核验的路径事实：
 *  - 测试方 → 被测方：去掉 `.test` / `.spec` 标记后全库同名（去掉扩展名）的**唯一**非测试文件；
 *  - 被测方 → 测试方：同目录或 `test/` 下的 `<name>.test|spec.<ext>`，**唯一**的那个。
 *
 * @param {string} rel - 本项
 * @param {object} relIndex - `createIndex()` 的产物（候选集）
 * @returns {string|null}
 */
export function testsOf(rel, relIndex) {
  const r = String(rel || '')
  if (!r || !relIndex || !Array.isArray(relIndex.rels)) return null
  const stem = (x) => baseOf(x).replace(/\.[A-Za-z0-9]+$/, '')
  if (isTestRel(r)) {
    const name = stem(r).replace(/\.(?:test|spec)$/, '')
    const hits = relIndex.rels.filter((x) => x !== r && !isTestRel(x) && stem(x) === name)
    return hits.length === 1 ? hits[0] : null
  }
  const dir = dirOf(r)
  const name = stem(r)
  const hits = new Set()
  for (const ext of EXTS) {
    for (const mid of ['test', 'spec']) {
      for (const d of dir === 'test' ? ['test'] : [dir, 'test']) {
        const cand = `${d}/${name}.${mid}.${ext}`
        if (relIndex.relSet.has(cand)) hits.add(cand)
      }
    }
  }
  return hits.size === 1 ? [...hits][0] : null
}

/**
 * 截断顺序（确定性，D4）：
 * `type` 优先级（`references` > `imports` > `tests` > `documents`）→ `dir`（`in` 先）
 * → `line` 升序 → `other` 字典序。
 */
function compareFacts(a, b) {
  const ta = TYPE_RANK.has(a.type) ? TYPE_RANK.get(a.type) : 99
  const tb = TYPE_RANK.has(b.type) ? TYPE_RANK.get(b.type) : 99
  if (ta !== tb) return ta - tb
  const da = a.dir === 'in' ? 0 : 1
  const db = b.dir === 'in' ? 0 : 1
  if (da !== db) return da - db
  const la = a.line === undefined ? Number.MAX_SAFE_INTEGER : a.line
  const lb = b.line === undefined ? Number.MAX_SAFE_INTEGER : b.line
  if (la !== lb) return la - lb
  return a.other < b.other ? -1 : a.other > b.other ? 1 : 0
}

/** 模块内的缓存：一个工作区一份事实，键含**候选集身份**（D6 的同一个理由：串了就是静默错配）。 */
const CACHE = new Map()

function signatureOf(list) {
  const parts = list.map((d) => `${d.rel}\u0000${d.mtimeMs}`)
  parts.sort()
  return parts.join('\n')
}

/**
 * 候选集 → 关系事实。**同步、零 I/O**：只用记录上现成的 `head`。
 *
 * 返回 `incident`：每个候选**与自己有关**的边（`dir` 已按「本项」的视角算好）。
 * 一条边同时登记到两端，投影时不必再扫一遍；`in` 边的 `line` 正好就是源那一行（D4）。
 *
 * @param {Array<object>|Map<string, object>} candidates - 含 `rel` / `kind` / `head` / `mtimeMs`
 * @param {{root?: string}} [options] - `root` 只参与缓存键
 * @returns {{signature: string, incident: Map<string, Array<object>>}}
 */
export function buildRelationFacts(candidates, options = {}) {
  const root = typeof options.root === 'string' ? options.root : ''
  const list = Array.isArray(candidates)
    ? candidates
    : [...(candidates instanceof Map ? candidates.values() : [])]
  const signature = signatureOf(list)
  const hit = CACHE.get(root)
  if (hit && hit.signature === signature) return hit.facts

  const rels = list.map((d) => String(d.rel))
  const index = createIndex(rels)
  const incident = new Map(rels.map((r) => [r, []]))

  const add = (rel, fact) => {
    const arr = incident.get(rel)
    if (!arr) return
    const prev = arr.find((f) => f.type === fact.type && f.other === fact.other && f.dir === fact.dir)
    if (prev) {
      // 同一对（类型 + 方向 + 对端）只留一条，行号取最靠前的
      if (prev.line !== undefined && fact.line !== undefined && fact.line < prev.line) prev.line = fact.line
      return
    }
    arr.push(fact)
  }
  /** 一条有向边 → 两端各登记一次（`line` 属于「提及所在的那个文件」）。 */
  const edge = (from, type, other, line) => {
    add(from, line === undefined ? { type, dir: 'out', other } : { type, dir: 'out', other, line })
    add(other, line === undefined ? { type, dir: 'in', other: from } : { type, dir: 'in', other: from, line })
  }

  for (const doc of list) {
    const rel = String(doc.rel)
    const text = typeof doc.head === 'string' ? doc.head : ''
    if (isMd(rel)) {
      // 只有 Markdown 能当 `references` / `documents` 的**源**（D5）：源这一侧不放开关。
      for (const ref of extractRefsWithLines(text, { anyExt: true })) {
        const other = resolveRef(ref.raw, index, rel, { anyExt: true })
        if (!other || other === rel) continue
        edge(rel, isMd(other) ? 'references' : 'documents', other, ref.line)
      }
    } else {
      for (const imp of importsOf(text)) {
        const other = resolveSpec(imp.spec, rel, index)
        if (!other || other === rel) continue
        edge(rel, 'imports', other, imp.line)
      }
    }
    const pair = testsOf(rel, index)
    if (pair && pair !== rel) {
      // 「测试方」是这条关系里叙述的那一方（文件名的约定在它身上）。
      if (isTestRel(rel)) edge(rel, 'tests', pair)
      else edge(pair, 'tests', rel)
    }
  }

  const facts = { signature, incident }
  CACHE.set(root, { signature, facts })
  return facts
}

/**
 * 取某一项的投影（**只给包内条目用**）。超出上限时如实给出 `total`，
 * 由调用方决定怎么说明「共 N 条」（§6.7：关系不是全量输出）。
 *
 * `facts` 收两种形状：`buildRelationFacts()` 的整份产物，**或**它的 `incident` 表本身
 * （装配层只往下传表，不传签名 —— 签名是缓存的事，跟投影无关）。
 *
 * @param {{incident: Map}|Map} facts - 事实表（整份产物或 `incident`）
 * @param {string} rel - 包内某一项
 * @param {number} [limit] - 最多几条（默认面板上限 3）
 * @returns {{relations: Array<object>, total: number}}
 */
export function relationsOf(facts, rel, limit = MAX_RELATIONS_PER_ITEM) {
  const table = facts instanceof Map ? facts : (facts && facts.incident)
  const all = (table && table.get(rel)) || []
  const cap = Number.isFinite(limit) && limit > 0 ? Math.trunc(limit) : MAX_RELATIONS_PER_ITEM
  const sorted = [...all].sort(compareFacts)
  return { relations: sorted.slice(0, cap), total: sorted.length }
}

/** 仅供测试：清掉缓存，避免用例之间互相污染。 */
export function resetRelationCache() {
  CACHE.clear()
}

/**
 * Knit · **引用关系**（v0.12）
 *
 * 从工作区的 Markdown 里解析出「谁引用了谁」，供反向链接面板使用。
 *
 * ## 为什么是「宁可少，不可错」
 *
 * 设计依据是拿真实语料量出来的（`01_ Knit PRD/Knit_SDD-v0.12-链接解析与反向链接面板.md` §一）：
 *
 * - `[[wikilink]]` 在真实语料里出现 **0 次** —— 所以**不解析 Obsidian 语法**，
 *   真正要认的是 `` `path/x.md` ``（出现 946 次）
 * - **歧义 basename 是最大误报源**：`SKILL.md` 有 20 个、`01_公众号正文.md` 有 12 个。
 *   一条只写了 basename 的提及**无法确定是哪一篇** —— 而那些提及多半在讲
 *   「文件名约定」而不是某一篇具体文档（实测 13% 的边是这么来的）
 *
 * 所以本模块**猜的一律不算**：解析不出来就是没有链接。
 * 少显示一条真链接，比显示一条假链接轻。
 *
 * ## 这是纯解析，不碰排序
 *
 * 链接图当排序信号**实测补不上**词面错配那个缺口（目标文档 BM25 第 45 名 →
 * 融合后 16~24 名，RRF 最好第 8，从未进 top-5）。所以这里只产出「关系」，不参与打分。
 *
 * ## 依赖是注入的，不 import `index.js`
 *
 * `index.js` 要 import 本模块来挂路由；如果本模块反过来 import 它的
 * `collectDocs` / `readDocument`，就成环了。所以照 `tool.js` 的先例
 * （`knitDocsDefinition(scan, read)`）**由调用方把两个函数传进来**。
 * 好处不止是避环：纯函数可以拿假数据直接测，不用起文件系统。
 *
 * ⚠️ **已知边界**（都写在 SDD §八）：不做模糊匹配、不处理 `../` 上跳、
 * 不区分代码块内的「示例路径」、正文按 `readDocument` 的 512KB 上限截断。
 */

/** 解析一篇正文时最多认多少条候选，防御性上限（正常文档远低于此）。 */
const MAX_REFS_PER_DOC = 500

/** 行首偏移表 + 二分：把「字符下标」换成 1 起的行号（同一篇正文只建一次）。 */
function startsOf(text) {
  const starts = [0]
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) starts.push(i + 1)
  return starts
}
function lineAt(starts, idx) {
  let lo = 0
  let hi = starts.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (starts[mid] <= idx) lo = mid
    else hi = mid - 1
  }
  return lo + 1
}

/**
 * 与 `extractRefs()` **同一套规则、同一套顺序**，只是额外给出每一处提及的真实行号。
 *
 * v0.21 新增，唯一理由：关系投影要的是「第几行」（`{type, dir, other, line}`），
 * 而证据必须能按 `other` + `line` 读回原文核验（需求 §6.8）。**不另写一套解析**。
 *
 * @param {string} text - 正文（原文）
 * @param {{anyExt?: boolean}} [options] - 同 `extractRefs()`
 * @returns {Array<{raw: string, line: number}>} 去重（保留首次出现），保持出现顺序
 */
export function extractRefsWithLines(text, options = {}) {
  if (typeof text !== 'string' || text === '') return []
  const anyExt = !!(options && options.anyExt === true)
  const starts = startsOf(text)
  const out = []
  const seen = new Set()
  const push = (whole, raw, at) => {
    const v = String(raw || '').trim()
    if (!v || seen.has(v)) return
    if (out.length >= MAX_REFS_PER_DOC) return
    // 外链不是本工作区的文档
    if (/^[a-z][a-z0-9+.-]*:/i.test(v)) return
    if (anyExt ? !/\.[A-Za-z0-9]+$/.test(v) : !/\.md$/i.test(v)) return
    seen.add(v)
    // 命中的是整个 match（含边界字符 / 反引号），路径在它里面的偏移要算上
    const off = Math.max(0, whole.indexOf(String(raw)))
    out.push({ raw: v, line: lineAt(starts, at + off) })
  }

  // ① 反引号：允许空格（`00_ Knit PRD/x.md` 这种目录名真实存在），不允许换行/反引号
  for (const m of text.matchAll(/`([^`\n]+?)`/g)) push(m[0], m[1], m.index)
  // ② Markdown 链接：取 () 里的路径，忽略其后的 #锚点
  for (const m of text.matchAll(/\]\(\s*([^)\s]+?)(?:#[^)\s]*)?\s*\)/g)) push(m[0], m[1], m.index)
  // ③ 裸路径：前面是行首/空白/中文括号，路径本身不含空格（有空格就得用反引号），
  //    末尾用 `(?![\w.])` 挡住 `a.md.bak` 这类「更长但不是 .md」的字符串
  //
  //    ⚠️ 必须在**挖掉反引号与链接目标之后的副本**上跑。否则
  //    `` `00_ Knit PRD/x.md` `` 里的 `PRD/x.md`（前面正好是空格）会被当成
  //    一条独立候选 —— 这是测试抓出来的真实缺陷，不是假想。
  const masked = text
    .replace(/`[^`\n]*`/g, (s) => ' '.repeat(s.length))
    .replace(/\]\([^)\n]*\)/g, (s) => ' '.repeat(s.length))
  const BARE = anyExt
    // v0.21：同样的「裸路径」写法，只是目标不再限定 `.md`（`documents` 要认代码路径）。
    ? /(?:^|[\s(（])((?:[\w\u4e00-\u9fa5.@+-]+\/)*[\w\u4e00-\u9fa5.@+-]+\.[A-Za-z0-9]+)(?![\w.])/gm
    : /(?:^|[\s(（])((?:[\w\u4e00-\u9fa5.@+-]+\/)*[\w\u4e00-\u9fa5.@+-]+\.md)(?![\w.])/gm
  for (const m of masked.matchAll(BARE)) push(m[0], m[1], m.index)

  return out
}

/**
 * 从正文里抽出**候选**引用（还没解析成 rel）。
 *
 * 三种真实写法，按语料出现频次排：
 *  1. 反引号包裹的路径 —— `` `docs/A.md` ``（946 次，主力）
 *  2. 标准 Markdown 链接 —— `[文字](docs/A.md)`（15 次）
 *  3. 裸路径提及 —— `见 docs/A.md`（前面必须是空白或括号，避免咬到 `a.md.bak` 这类）
 *
 * **不含 `[[wikilink]]`** —— 真实语料 0 次，不做。
 *
 * @param {string} text - 正文（原文，**不是**小写化的 haystack）
 * @param {{anyExt?: boolean}} [options] - v0.21：`anyExt` 把**目标**放开到「任何带扩展名的文件」
 *   （只给关系层的 `documents` 用：md → 代码）。默认**一个字不改** —— v0.12 的引用图与
 *   `test/code-context.test.mjs` 那条「代码只能被指向、不能当源」的守卫原样通过。
 * @returns {string[]} 去重后的候选项，保持出现顺序
 */
export function extractRefs(text, options = {}) {
  return extractRefsWithLines(text, options).map((hit) => hit.raw)
}

/** rel 用 `/` 连接（`index.js` 保证），所以这里也按 `/` 取目录，不碰 `node:path`。 */
const dirOf = (rel) => {
  const i = String(rel).lastIndexOf('/')
  return i === -1 ? '' : String(rel).slice(0, i)
}
const baseOf = (rel) => {
  const s = String(rel)
  const i = s.lastIndexOf('/')
  return i === -1 ? s : s.slice(i + 1)
}

/**
 * 为一批 rel 建解析上下文。**纯数据，可缓存**。
 *
 * @param {string[]} rels - 工作区里全部文档的 rel
 * @returns {{relSet:Set<string>, rels:string[], byBase:Map<string,string[]>}}
 */
export function createIndex(rels) {
  const relSet = new Set(rels)
  const byBase = new Map()
  for (const rel of rels) {
    const b = baseOf(rel)
    if (!byBase.has(b)) byBase.set(b, [])
    byBase.get(b).push(rel)
  }
  return { relSet, rels, byBase }
}

/**
 * 把一条候选解析成工作区内的 rel，**解析不出来就返回 null**。
 *
 * 优先级（SDD §3.3，顺序本身就是设计）：
 *  1. **引用方所在目录优先** —— 这才是相对路径的语义。
 *     所以 `docs/B.md` 里写 `README.md` 会先找 `docs/README.md`
 *  2. 工作区根
 *  3. **缩写后缀**：`-SDD-v0.6.md` 这种省略了公共前缀的写法（真实语料里存在），
 *     必须**唯一命中**才算
 *  4. **basename**：仅当全库该名字**唯一**时才算
 *  5. 否则 → `null`（§一 的 13% 误报就是这里挡掉的）
 *
 * @param {string} raw - 候选项
 * @param {object} index - `createIndex()` 的产物
 * @param {string} [referrerRel] - 引用方的 rel；不传则跳过第 1 步
 * @param {{anyExt?: boolean}} [options] - v0.21：与 `extractRefs()` 同一个显式开关（默认只认 `.md`）
 * @returns {string|null}
 */
export function resolveRef(raw, index, referrerRel, options = {}) {
  const anyExt = !!(options && options.anyExt === true)
  const v = String(raw || '').trim()
  if (!v || !index || !(index.relSet instanceof Set)) return null
  if (/^[a-z][a-z0-9+.-]*:/i.test(v)) return null
  if (anyExt ? !/\.[A-Za-z0-9]+$/.test(v) : !/\.md$/i.test(v)) return null

  // 去掉 ./ 前缀（`./docs/A.md` 是常见写法，但不是本工作区的 rel）
  const clean = v.replace(/^\.\//, '')

  // ① 引用方所在目录
  if (referrerRel) {
    const dir = dirOf(referrerRel)
    if (dir) {
      const sibling = `${dir}/${clean}`
      if (index.relSet.has(sibling)) return sibling
    }
  }

  // ② 工作区根
  if (index.relSet.has(clean)) return clean

  // ③ 缩写后缀：只在以 `-` 开头时试，且必须唯一
  if (clean.startsWith('-')) {
    const tail = clean.slice(1)
    const hits = index.rels.filter((r) => r.endsWith(tail))
    if (hits.length === 1) return hits[0]
    return null
  }

  // ④ basename，仅当唯一
  const same = index.byBase.get(baseOf(clean))
  if (same && same.length === 1) return same[0]

  // ⑤ 猜不了就不算
  return null
}

/** 模块内的图缓存：一个工作区一张图。key 是 `root`，值是 `{signature, graph}`。 */
const CACHE = new Map()
/** 进行中的构建，避免并发请求解析两遍。key 是 `root`。 */
const INFLIGHT = new Map()

/**
 * 图签名：变了才重建。
 *
 * v0.21（D6）修掉一个真缺陷：原来的键是「篇数 + 最大 mtime + 是否被截断」，
 * **不含候选集身份** —— 同一进程里连跑两个 query，只要候选数相同、最大 mtime 还落在
 * 同一个文件上，第二个 query 就会拿到第一个 query 的图，**关系全部落空**（实测复现）。
 * 现在键 = 每个候选的 `rel` + `mtimeMs`，排序后拼接（候选换了要重建；候选没换但内容改了也要重建）。
 *
 * 不用哈希：碰撞会让关系**静默错配**，而 Knit 的全部价值建立在「可核验」上；
 * 拼一个 ≤1000 项的字符串，成本远低于这条路径上已经付掉的「读几十个文件的 head」。
 */
function signatureOf(listed) {
  const docs = (listed && listed.docs) || []
  const parts = docs.map((d) => `${d.rel}\u0000${d.mtimeMs}`)
  parts.sort()
  return `${parts.join('\n')}\u0000${listed && listed.truncated ? 1 : 0}`
}

/**
 * 建（或复用缓存的）引用图。
 *
 * @param {string} root - 工作区根
 * @param {{list:Function, read:Function}} io - `list(root)` → `{docs, truncated}`；`read(root, rel)` → `{ok, text}`
 * @returns {Promise<object>} `{ signature, docs:Map<rel,title>, out:Map<rel,Set>, in:Map<rel,Set>, limited, parsed, skipped }`
 */
export async function buildLinkGraph(root, io) {
  const listed = await io.list(root)
  const signature = signatureOf(listed)
  const hit = CACHE.get(root)
  if (hit && hit.signature === signature) return hit.graph

  const pending = INFLIGHT.get(root)
  if (pending) return pending

  const work = (async () => {
    const docs = (listed && listed.docs) || []
    const titles = new Map(docs.map((d) => [d.rel, d.title || baseOf(d.rel)]))
    const index = createIndex(docs.map((d) => d.rel))
    const out = new Map()
    let parsed = 0
    let skipped = 0

    for (const doc of docs) {
      // v0.22 修法 ①：条目/索引里已经带了抽取结果就直接用 —— `doc.refs.md` 正是
      // `extractRefs()`（默认口径、只认 `.md` 目标）的产物，连 `io.read()` 都不用调。
      // 没有它时才回落去要文本（旧调用方与单测的假条目走这条路）。
      const cachedRefs = doc.refs && Array.isArray(doc.refs.md) ? doc.refs.md : null
      let text = ''
      if (!cachedRefs) {
        try {
          const r = await io.read(root, doc.rel)
          if (!r || r.ok !== true) {
            skipped += 1
            continue
          }
          text = r.text || ''
        } catch {
          skipped += 1
          continue
        }
      }
      parsed += 1
      const targets = new Set()
      if (cachedRefs) {
        for (const hit of cachedRefs) {
          const rel = resolveRef(hit.raw, index, doc.rel)
          if (rel && rel !== doc.rel) targets.add(rel)
        }
      } else {
        for (const raw of extractRefs(text)) {
          const rel = resolveRef(raw, index, doc.rel)
          if (rel && rel !== doc.rel) targets.add(rel)
        }
      }
      out.set(doc.rel, targets)
    }

    // 反向边由正向边推出来，避免两处逻辑不一致
    const incoming = new Map(docs.map((d) => [d.rel, new Set()]))
    for (const [from, targets] of out) {
      for (const to of targets) {
        if (incoming.has(to)) incoming.get(to).add(from)
      }
    }

    const graph = {
      signature,
      titles,
      out,
      in: incoming,
      limited: !!(listed && listed.truncated),
      parsed,
      skipped,
    }
    CACHE.set(root, { signature, graph })
    INFLIGHT.delete(root)
    return graph
  })()

  INFLIGHT.set(root, work)
  try {
    return await work
  } catch (err) {
    INFLIGHT.delete(root)
    throw err
  }
}

/** 仅供测试：清掉缓存，避免用例之间互相污染。 */
export function resetLinkCache() {
  CACHE.clear()
  INFLIGHT.clear()
}

/** 按「对方入度降序 + rel 字典序」排 —— 引用多的文档往往是主脉络，且顺序必须稳定。 */
function orderBy(rels, graph) {
  return [...rels].sort((a, b) => {
    const da = (graph.in.get(a) || new Set()).size
    const db = (graph.in.get(b) || new Set()).size
    if (da !== db) return db - da
    return a < b ? -1 : a > b ? 1 : 0
  })
}

/**
 * 取某一篇的引用关系。**只返回 `rel` + `title`** —— 与 `knit_docs` 同一条纪律，
 * 不把图、haystack 之类的内部结构泄漏给客户端。
 *
 * @param {object} graph - `buildLinkGraph()` 的产物
 * @param {string} rel - 目标文档
 * @param {number} [limit] - 每侧最多返回多少条（计数仍给全量）
 * @returns {object} 成功 `{ok:true, …}`；未知 rel 返回 `{ok:false, code:'knit/not-found'}`
 */
export function linksOf(graph, rel, limit = 50) {
  if (!graph || !graph.titles || !graph.titles.has(rel)) {
    return { ok: false, code: 'knit/not-found' }
  }
  const cap = Number.isFinite(limit) && limit > 0 ? Math.trunc(limit) : 50
  const map = (set) => orderBy(set || new Set(), graph)
    .map((r) => ({ rel: r, title: graph.titles.get(r) || baseOf(r) }))

  const incoming = map(graph.in.get(rel))
  const outgoing = map(graph.out.get(rel))
  return {
    ok: true,
    rel,
    incoming: incoming.slice(0, cap),
    outgoing: outgoing.slice(0, cap),
    incomingTotal: incoming.length,
    outgoingTotal: outgoing.length,
    limited: !!graph.limited,
  }
}

/**
 * Knit · **Git 变更关联投影**（v0.25 Git-aware Context Retrieval）
 *
 * 这一层回答的问题只有一句：**「这些被改过的文件，按已有的关联证据，还牵着谁」**。
 *
 * ## 它不发明关系，只挑已有的边
 *
 * 边全部来自 `relations.js` 的 `buildRelationFacts()` —— 那四类（`tests` / `imports` /
 * `references` / `documents`）已经有各自的证据与守卫。本模块**只做一件事**：
 * 把「变更文件」当作种子，去事实表里取它**已经存在**的边，再把边指向的那一端投影成
 * 一条可以摆进列表的结果。**没有 AST、没有新图、没有猜出来的依赖。**
 *
 * ## 一条边都没有的变更文件怎么办
 *
 * 如实进 `unresolved`（面板据此说「N 个变更文件没有关联证据」），**不硬凑**。
 * 这与 `context.js` 给 Related 层写下的那条纪律是同一条：说不出凭什么，就不出场。
 *
 * ## 为什么已删除 / 重命名前的路径也要当种子
 *
 * 这是本模块唯一一处需要解释的设计：**文件被删掉之后，它就不在候选集里了**，
 * 于是 `relations.js` 的解析（`resolveRef` / `resolveSpec` / `testsOf`）**都不再认它** ——
 * 「删掉 `tests/foo.test.ts`，谁在用它」这个问题会一声不响地没有答案。
 *
 * 修法很小：把**变更清单里那些已经不在工作区里的路径**，作为 `head: ''` 的**合成候选**
 * 一并交给 `buildRelationFacts()`。索引里因此有这个 rel，别人指向它的边就能解析出来。
 * 两条边界：
 *   · 合成候选的 `head` 是空的 ⇒ 它**自己**产不出任何出边（它确实已经没了）；
 *   · 它**永远只能当种子，不能当结果**（`itemRels` 把它排除掉）—— 你没法打开一个不存在的文件。
 *
 * ## 截断（确定性）
 *
 * 结果按「证据类型优先级（沿用 `relations.js` 的 `RELATION_TYPES` 顺序）→ 关联到的变更文件数降序
 * → rel 字典序」排，超过 `MAX_CHANGE_RELATED` 截断并如实给出 `relatedTotal`。
 */

import { RELATION_TYPES, MAX_RELATIONS_PER_ITEM } from './relations.js'

/** 面板「变更关联」区最多几条（§6.7 同一条预算纪律：这是上限，不是建议）。 */
export const MAX_CHANGE_RELATED = 8

const TYPE_RANK = new Map(RELATION_TYPES.map((t, i) => [t, i]))
const rankOf = (type) => (TYPE_RANK.has(type) ? TYPE_RANK.get(type) : 99)

/** 方向翻转：一条边在两端各有一次登记，`line` 属于**叙述方**，所以翻转方向不改行号。 */
const flip = (dir) => (dir === 'in' ? 'out' : 'in')

/**
 * 把一次变更清单分成三份：**能当结果的**、**只能当种子的**、**够不着的**。
 *
 * @param {object} changeSet - `git.js` 的 `read()` 产物
 * @param {Set<string>} corpusRels - 当前候选集里的 rel（**只有它们能当结果**）
 * @returns {{seeds: string[], gone: string[], outside: string[], seedRels: string[]}}
 *   `seeds`   = 变更里确实还在候选集中的路径（含重命名后的新路径）—— 可以当结果，也可以当种子
 *   `gone`    = 变更里**不在**候选集里的文件路径（删除的、重命名前的、工作区外的）——
 *               **只能当种子**（合成候选，见 `ghostCandidates()`），永远不当结果
 *   `outside` = 同 `gone`，但只算「看起来像文件」的（目录条目不算）—— 面板据此说
 *               「N 个变更不在检索范围」
 *   `seedRels`= `seeds` + `gone`（**查找关系时两者都要问**：删掉的测试文件照样牵着它的被测文件）
 *
 * ⚠️ 目录条目（`?? some/dir/`）既不当种子也不算 `outside`：它不是文件，
 * 而 `resolveRef` / `testsOf` 只会去认文件。它仍然出现在 `changeSet.files` 里（如实报告）。
 */
export function splitSeeds(changeSet, corpusRels) {
  const files = Array.isArray(changeSet && changeSet.files) ? changeSet.files : []
  const seeds = []
  const gone = []
  const outside = []
  const seenSeed = new Set()
  const seenGone = new Set()
  // ⚠️ `gone` 与 `outside` 是**两张表、两条去重线**：同一个 rel 同时属于两张表是**正常**的
  // （「不在语料里的变更文件」既是「只能当种子」也是「不在检索范围」）。共用一个 Set
  // 会让第二次 push 被当成重复而静默丢掉一枚（写完当场被测试抓到过一次）。
  const seenOutside = new Set()
  const push = (list, seen, rel) => {
    if (!rel || seen.has(rel)) return
    seen.add(rel)
    list.push(rel)
  }
  const pushGone = (rel, isDir) => {
    if (isDir) return
    push(gone, seenGone, rel)
    push(outside, seenOutside, rel)
  }
  for (const file of files) {
    const rel = String(file.rel || '')
    if (!rel) continue
    const isDir = file.isDir === true
    if (corpusRels.has(rel)) push(seeds, seenSeed, rel)
    else pushGone(rel, isDir)
    // 重命名 / 复制：原路径也当种子 —— 别人引用它的那条边还在，只是目标换了名字
    const orig = file.origRel ? String(file.origRel) : ''
    if (orig) {
      if (corpusRels.has(orig)) push(seeds, seenSeed, orig)
      else pushGone(orig, false)
    }
  }
  seeds.sort()
  gone.sort()
  outside.sort()
  return { seeds, gone, outside, seedRels: [...seeds, ...gone].sort() }
}

/**
 * 合成候选：给「已经不在候选集里的变更路径」一个空壳，好让**别人指向它的边**解析得出来。
 * 只喂给 `buildRelationFacts()`，**不进任何结果**。
 *
 * @param {string[]} gone - `splitSeeds()` 的 `gone`
 * @returns {Array<{rel: string, head: string, mtimeMs: number, kind: string}>}
 */
export function ghostCandidates(gone) {
  return (Array.isArray(gone) ? gone : []).map((rel) => ({ rel, head: '', mtimeMs: 0, kind: 'md' }))
}

/**
 * 种子 + 事实表 → 关联结果。**纯函数**（不读盘、不看时钟、不发请求）。
 *
 * @param {object} input
 * @param {string[]} input.seeds - 变更文件里在候选集中的那些
 * @param {Map<string, Array<object>>} input.incident - `buildRelationFacts().incident`
 * @param {Set<string>} input.itemRels - **允许当结果**的 rel（= 候选集；已删除的路径不在里面）
 * @param {Set<string>} [input.exclude] - 明确排除的 rel（变更文件自己 + 已经在三层 / 固定区里的）。
 *   变更文件自己不当结果：这一区要回答的是「**还**该一起看什么」，不是「你改了什么」。
 * @param {number} [input.limit] - 最多几条结果
 * @returns {{related: Array<{rel: string, evidence: Array<object>, types: string[]}>, unresolved: string[], relatedTotal: number}}
 */
export function projectChangeRelated(input) {
  const seeds = Array.isArray(input && input.seeds) ? input.seeds : []
  const incident = input && input.incident
  const itemRels = input && input.itemRels instanceof Set ? input.itemRels : new Set()
  const exclude = input && input.exclude instanceof Set ? input.exclude : new Set()
  const limit = Number.isInteger(input && input.limit) && input.limit > 0 ? input.limit : MAX_CHANGE_RELATED

  /** target rel → { rel, evidence: Map<key, edge> } */
  const targets = new Map()
  const unresolved = []

  for (const seed of seeds) {
    const edges = (incident && typeof incident.get === 'function' ? incident.get(seed) : null) || []
    let count = 0
    for (const edge of edges) {
      if (!edge || typeof edge.other !== 'string' || !edge.type) continue
      const target = edge.other
      // 结果必须能打开：合成候选（已删除的路径）永远不当结果
      if (target === seed || !itemRels.has(target) || exclude.has(target)) continue
      let bucket = targets.get(target)
      if (!bucket) {
        bucket = { rel: target, evidence: new Map() }
        targets.set(target, bucket)
      }
      // 证据按（起点 + 类型 + 方向）去重：同一对文件只留一条，行号取最靠前的
      const key = `${seed}\u0000${edge.type}\u0000${flip(edge.dir)}`
      const prev = bucket.evidence.get(key)
      if (!prev) {
        // ⚠️ 字段名逐字沿用 `relations.js` 的边形状（`type` / `dir` / `other` / `line`）——
        // 面板的行级证据弹层与工具 `ITEM_SCHEMA` 都直接吃这一份，改个名字就会两处一起坏。
        // 这里的 `other` 就是**关联起点**（那个被改过的文件）。
        bucket.evidence.set(key, {
          type: edge.type,
          dir: flip(edge.dir),
          other: seed,
          ...(Number.isInteger(edge.line) ? { line: edge.line } : {}),
        })
      } else if (Number.isInteger(edge.line) && (!Number.isInteger(prev.line) || edge.line < prev.line)) {
        prev.line = edge.line
      }
      count += 1
    }
    if (count === 0) unresolved.push(seed)
  }

  const rows = [...targets.values()].map((bucket) => {
    const evidence = [...bucket.evidence.values()]
    // 同一目标、同一类型、不同起点时，按类型优先级 → 起点字典序
    evidence.sort((a, b) => {
      const ta = rankOf(a.type)
      const tb = rankOf(b.type)
      if (ta !== tb) return ta - tb
      const la = Number.isInteger(a.line) ? a.line : Number.MAX_SAFE_INTEGER
      const lb = Number.isInteger(b.line) ? b.line : Number.MAX_SAFE_INTEGER
      if (la !== lb) return la - lb
      return a.other < b.other ? -1 : a.other > b.other ? 1 : 0
    })
    return { rel: bucket.rel, evidence, sources: new Set(evidence.map((e) => e.other)) }
  })

  rows.sort((a, b) => {
    const ta = rankOf(a.evidence[0] && a.evidence[0].type)
    const tb = rankOf(b.evidence[0] && b.evidence[0].type)
    if (ta !== tb) return ta - tb
    // 关联到的**变更文件**越多越靠前 —— 两个变更文件都指向它，是更强的「一起改」信号
    if (a.sources.size !== b.sources.size) return b.sources.size - a.sources.size
    return a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0
  })

  const relatedTotal = rows.length
  const related = rows.slice(0, limit).map((row) => {
    const shown = row.evidence.slice(0, MAX_RELATIONS_PER_ITEM)
    return {
      rel: row.rel,
      evidence: shown,
      evidenceTotal: row.evidence.length,
      types: [...new Set(row.evidence.map((e) => e.type))],
      from: [...new Set(row.evidence.map((e) => e.other))],
    }
  })
  unresolved.sort()
  return { related, unresolved, relatedTotal }
}

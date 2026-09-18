/**
 * v0.5.2 的排序实现 —— **只作为评测对照存在，不参与生产路径**。
 *
 * 为什么留一份副本：`test/eval/fixture.mjs` 的阈值是「新引擎必须显著优于基线」
 * （PRD §6.2），而基线必须可复现、可重测 —— 语料一改，历史基线数字就作废。
 * 把它冻在这里，评测就能随时自己算一遍「旧 vs 新」，而不是引用一个无法核对的常数。
 *
 * 包含两部分，因为 v0.6 两处都动了：
 *   - `extractKeywordsLegacy`：去重叠**按分数降序**（这是垃圾 3-gram 挤走真实词的原因）
 *   - `rankByRelevanceLegacy`：加权命中，**没有 IDF、没有长度归一化**，命中封顶 6 次
 *
 * ⚠️ `tokenize` 是共用的 —— 它在 v0.5.2 → v0.6 之间**行为逐字未变**（只是从
 * `accumulate` 里抽成了独立函数），所以这里直接引用来路一致的实现。
 */
import { tokenize } from '../../src/host/relevance.js'

/** 新鲜度奖励的时间常数（7 天）。 */
const FRESHNESS_WINDOW_MS = 7 * 24 * 60 * 60 * 1000

/**
 * v0.5.2 的关键词抽取：与 `extractKeywords` 的唯一差别是
 * **去重叠顺序按分数降序**（没有「短词优先」），输出顺序也不再重排。
 *
 * @param {readonly string[]} messages - 对话文本，最新在前
 * @param {number} limit - 最多返回多少个关键词
 * @returns {Array<{term: string, weight: number}>} 关键词及其权重
 */
export function extractKeywordsLegacy(messages, limit = 30) {
  const raw = new Map()
  const weighted = new Map()

  messages.forEach((text, index) => {
    const weight = index === 0 ? 3 : index === 1 ? 2 : 1
    for (const term of tokenize(text)) {
      raw.set(term, (raw.get(term) || 0) + 1)
      weighted.set(term, (weighted.get(term) || 0) + weight)
    }
  })

  const ranked = [...weighted.entries()]
    .map(([term, weight]) => ({ term, weight, seen: raw.get(term) || 0 }))
    .filter((entry) => {
      if (/^[a-z]/.test(entry.term)) return entry.seen >= 1
      return entry.seen >= 2 || entry.weight >= 3
    })
    .map((entry) => ({ ...entry, score: entry.weight * entry.term.length * entry.term.length }))
    .sort((a, b) => b.score - a.score)

  const picked = []
  for (const entry of ranked) {
    if (picked.length >= limit) break
    if (picked.some((p) => p.term.includes(entry.term) || entry.term.includes(p.term))) continue
    picked.push(entry)
  }

  return picked.map((entry) => ({ term: entry.term, weight: entry.score }))
}

/**
 * 数一个词在文本里出现几次（封顶，避免长文档靠堆词刷分）。
 * @param {string} hay - 小写后的可搜索文本
 * @param {string} needle - 关键词（小写）
 * @returns {number} 命中次数，最多 6
 */
function countOccurrences(hay, needle) {
  if (!hay || !needle) return 0
  let hits = 0
  let from = 0
  for (;;) {
    const at = hay.indexOf(needle, from)
    if (at === -1 || hits >= 6) break
    hits += 1
    from = at + needle.length
  }
  return hits
}

/**
 * v0.5.2 的打分与排序。
 * @param {Array<object>} docs - 文档记录
 * @param {readonly {term: string, weight: number}[]} keywords - 关键词表
 * @param {number} now - 当前时间（epoch ms）
 * @returns {{docs: Array<object>, maxRaw: number}} 带 `score` 的文档
 */
export function rankByRelevanceLegacy(docs, keywords, now) {
  if (keywords.length === 0) {
    return { docs: docs.map((doc) => ({ ...doc, score: 0 })), maxRaw: 0 }
  }

  const raws = docs.map((doc) => {
    const hay = doc.haystack || { title: '', summary: '', body: '' }
    let raw = 0
    for (const { term, weight } of keywords) {
      const hits = countOccurrences(hay.title, term) * 4
        + countOccurrences(hay.summary, term) * 2
        + countOccurrences(hay.body, term)
      if (hits > 0) raw += weight * hits
    }
    const age = Math.max(0, now - (doc.mtimeMs || 0))
    const freshness = 1 - Math.min(1, age / FRESHNESS_WINDOW_MS)
    return raw * (1 + 0.1 * freshness)
  })

  const maxRaw = Math.max(...raws, 0)

  const scored = docs.map((doc, index) => ({
    ...doc,
    raw: raws[index],
    score: maxRaw > 0 ? Math.round((raws[index] / maxRaw) * 100) : 0,
  }))

  scored.sort((a, b) => b.raw - a.raw || b.mtimeMs - a.mtimeMs)

  return { docs: scored, maxRaw }
}

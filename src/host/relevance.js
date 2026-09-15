/**
 * Knit · 相关性引擎（纯本地，零模型、零网络）
 *
 * 输入：当前对话最近几条消息的文本 + 每个文档的可搜索文本
 * 输出：每个文档一个 0-100 的相关度，以及一个「当前话题」标签
 *
 * 算法（TF-IDF 的简化版，但不做全局 df 统计以保持 O(docs×keywords)）：
 *   1. 从对话里抽关键词：ASCII 词 + 中文 2/3-gram，按 出现次数×长度² 排序，
 *      贪心去重叠，取前 N 个。越新的消息权重越高。
 *   2. 每个文档算加权命中分：标题×4 + 摘要×2 + 正文头部×1，命中数封顶 6 次。
 *   3. 加 10% 的时间新鲜度奖励（相关性为主，新鲜度只做微调）。
 *   4. 以最高分为 100 归一化。
 *
 * 全部是确定性字符串运算，没有模型调用，没有网络请求。
 */

/* ── 停用词 ─────────────────────────────────────────── */

/** 英文停用词（小写）。 */
const EN_STOP = new Set([
  'the', 'and', 'for', 'are', 'but', 'not', 'you', 'all', 'can', 'her', 'was', 'one', 'our',
  'out', 'day', 'get', 'has', 'him', 'his', 'how', 'its', 'new', 'now', 'old', 'see', 'two',
  'way', 'who', 'boy', 'did', 'use', 'that', 'this', 'with', 'have', 'from', 'they', 'will',
  'would', 'there', 'their', 'what', 'about', 'which', 'when', 'make', 'like', 'time', 'just',
  'know', 'take', 'into', 'your', 'some', 'them', 'than', 'then', 'only', 'come', 'over',
  'also', 'back', 'after', 'first', 'well', 'even', 'want', 'because', 'these', 'give', 'most',
  'been', 'were', 'does', 'here', 'more', 'very', 'should', 'could', 'need', 'using', 'used',
  'does', 'each', 'such', 'same', 'other', 'been', 'being', 'both', 'any', 'may', 'own',
  'com', 'www', 'http', 'https', 'html', 'json', 'node', 'true', 'false', 'null', 'undefined',
  'var', 'let', 'const', 'function', 'return', 'import', 'export', 'default', 'async', 'await',
])

/** 中文单字停用词：一个 gram 的字符全在这里面就丢掉。 */
const CN_STOP_CHARS = new Set([
  '的', '了', '是', '在', '我', '你', '他', '她', '它', '们', '这', '那', '有', '和', '与',
  '就', '都', '也', '不', '没', '很', '会', '能', '要', '把', '被', '让', '给', '从', '到',
  '对', '为', '以', '及', '或', '但', '而', '之', '其', '于', '并', '等', '着', '过', '们',
  '个', '上', '下', '中', '里', '外', '前', '后', '时', '话', '说', '做', '用', '好', '多',
  '少', '大', '小', '来', '去', '出', '入', '一', '二', '三', '四', '五', '六', '七', '八',
  '九', '十', '呢', '吗', '吧', '啊', '哦', '嗯', '呀', '么', '些', '嘛', '啦',
])

/** 中文 2-gram 停用词（常见虚词组合，单字停用表盖不住）。 */
const CN_STOP_BIGRAMS = new Set([
  '我们', '你们', '他们', '她们', '这个', '那个', '这些', '那些', '什么', '怎么', '可以',
  '需要', '一个', '就是', '不是', '没有', '已经', '还是', '因为', '所以', '但是', '如果',
  '这样', '那样', '现在', '时候', '一下', '一直', '而且', '或者', '以及', '不过', '然后',
  '比较', '非常', '真的', '应该', '可能', '只是', '其实', '这里', '那里', '自己', '大家',
  '一些', '有点', '有点', '有点', '以后', '以前', '之后', '之前', '的话', '来说', '方面',
])

/* ── 关键词抽取 ─────────────────────────────────────── */

/**
 * 给一个 n-gram 打分用的字符集检查。
 * @param {string} gram - 待检查的片段
 * @returns {boolean} 是否全是停用字符
 */
function allStopChars(gram) {
  for (const ch of gram) {
    if (!CN_STOP_CHARS.has(ch)) return false
  }
  return true
}

/**
 * 从一段文本里累计 n-gram。
 *
 * **原始次数与加权分数分开记**：权重只影响排序，不影响「够不够格」。
 * 否则一条消息权重 3，里面出现一次的词也会被当成出现 3 次，噪音全进来了。
 *
 * @param {string} text - 文本
 * @param {number} weight - 这段话的权重倍数
 * @param {Map<string, number>} raw - 原始出现次数
 * @param {Map<string, number>} weighted - 加权分数
 * @returns {void}
 */
function accumulate(text, weight, raw, weighted) {
  if (!text) return

  /**
   * 记一次命中。
   * @param {string} term - 词
   * @returns {void}
   */
  const bump = (term) => {
    raw.set(term, (raw.get(term) || 0) + 1)
    weighted.set(term, (weighted.get(term) || 0) + weight)
  }

  // ASCII 词 / 标识符（chokidar、TypeScript、ctx.sidebarRightTabs…）
  for (const m of text.matchAll(/[A-Za-z][A-Za-z0-9_]{2,29}/g)) {
    const token = m[0].toLowerCase()
    if (EN_STOP.has(token)) continue
    bump(token)
  }

  // 中文 2-gram / 3-gram
  const cjkRuns = text.replace(/[^\u4e00-\u9fff]+/g, ' ').split(' ')
  for (const run of cjkRuns) {
    if (run.length < 2) continue
    for (let n = 2; n <= 3; n += 1) {
      for (let i = 0; i + n <= run.length; i += 1) {
        const gram = run.slice(i, i + n)
        if (n === 2 && CN_STOP_BIGRAMS.has(gram)) continue
        if (allStopChars(gram)) continue
        bump(gram)
      }
    }
  }
}

/**
 * 从最近几段对话文本里抽关键词。
 *
 * `messages` 按**由新到旧**排列；越新的权重越高（3 / 2 / 1 / 1 …）。
 *
 * 门槛分两档：
 *   - ASCII 词出现 1 次就要（`chokidar`、`mtime` 这种精确词很值钱）
 *   - 中文 n-gram 要「出现过 2 次」或「出现在最新那条消息里」——
 *     后者权重为 3，是当下正在聊什么的最强信号，不该因为只出现一次被丢掉；
 *     而只在旧消息里露过一次的中文片段基本是噪音，滤掉。
 *
 * @param {readonly string[]} messages - 对话文本，最新在前
 * @param {number} limit - 最多返回多少个关键词
 * @returns {Array<{term: string, weight: number}>} 关键词及其权重，权重降序
 */
export function extractKeywords(messages, limit = 30) {
  const raw = new Map()
  const weighted = new Map()

  messages.forEach((text, index) => {
    const weight = index === 0 ? 3 : index === 1 ? 2 : 1
    accumulate(text, weight, raw, weighted)
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
    // 去重叠：已经选了「相关性排序」，就不再要「相关性」和「排序」
    if (picked.some((p) => p.term.includes(entry.term) || entry.term.includes(p.term))) continue
    picked.push(entry)
  }

  return picked.map((entry) => ({ term: entry.term, weight: entry.score }))
}

/* ── 文档打分 ───────────────────────────────────────── */

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

/** 新鲜度奖励的时间常数（7 天）。 */
const FRESHNESS_WINDOW_MS = 7 * 24 * 60 * 60 * 1000

/**
 * 给一批文档算相关度并按相关度重排。
 *
 * 每个文档需要 `haystack: { title, summary, body }`（都已小写）。
 *
 * @param {Array<object>} docs - 文档记录（含 haystack 与 mtimeMs）
 * @param {readonly {term: string, weight: number}[]} keywords - 关键词表
 * @param {number} now - 当前时间（epoch ms）
 * @returns {{docs: Array<object>, maxRaw: number}} 带 `score` 的文档（相关度降序）
 */
export function rankByRelevance(docs, keywords, now) {
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
    // 时间新鲜度只做 10% 的微调，主排序仍然是相关性
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

/**
 * 从关键词表里挑一个给人看的「当前话题」标签。
 * @param {readonly {term: string, weight: number}[]} keywords - 关键词表
 * @param {number} count - 取几个
 * @returns {string} 用「、」连接的标签，没有则空串
 */
export function topicLabel(keywords, count = 3) {
  const terms = keywords
    .slice(0, count)
    .map((entry) => entry.term)
    .filter((term) => term.length >= 2)
  return terms.join('、')
}

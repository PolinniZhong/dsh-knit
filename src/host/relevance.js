/**
 * Knit · 相关性引擎（纯本地，零模型、零网络）
 *
 * 输入：当前对话最近几条消息的文本 + 每个文档的可搜索文本
 * 输出：每个文档一个 0-100 的相关度、一个「当前话题」标签，以及实际命中的词
 *
 * ── 两层，各自的词表来源不同 ─────────────────────────
 *
 * **查询侧**用 `tokenize()` 生成候选词：ASCII 词 + 中文 2/3-gram。
 * **文档侧**不做分词，直接用 `indexOf` 数子串出现次数。
 *
 * 为什么文档侧不分词：分词要为每篇文档生成全部 2/3-gram，
 * 500 篇 × 2500 字实测 **114ms**，而 `indexOf` 是原生实现、只找那几十个候选词。
 * 两者语义也一致 —— 候选词本身就是子串，子串计数就是它的词频。
 *
 * ── 打分：BM25（字段加权） ───────────────────────────
 *
 *   1. 从对话里抽关键词（见下方「抽取」的说明）。
 *   2. 对语料做一次统计：每个词在每篇文档、每个字段的出现次数（tf）、
 *      字段长度、以及**文档频率** df。
 *   3. BM25 打分，字段加权求和：
 *
 *        raw(d) = Σ_t qw(t) · idf(t) · Σ_f w_f · sat_f(t, d)
 *
 *        sat_f(t,d) = tf·(k1+1) / ( tf + k1·(1 - b_f + b_f·len_f/avgdl_f) )
 *        idf(t)     = ln(1 + (N - df + 0.5) / (df + 0.5))
 *        qw(t)      = weight(t) / max(weight)          （查询侧相对权重）
 *
 *   4. 叠 10% 的时间新鲜度微调（主排序仍是相关性）。
 *   5. 以最高分为 100 归一化。
 *
 * `len_f` 用的是**字段字符数**而不是「分词后的词数」—— 那需要分词，见上。
 * 长度归一化只要求长度尺度和文档长度单调相关，字符数满足这一点。
 *
 * ── 为什么不再用 v0.5.2 的「加权命中」 ─────────────────
 *
 *   - 旧做法**没有 IDF** —— 语料里到处都是的词（比如项目名）和罕见词同权，
 *     高频词于是不产生任何区分度，还把罕见词的区分度稀释掉。
 *   - 旧做法**没有长度归一化** —— 长文档天然命中次数多，靠堆词就能赢。
 *   - 旧做法的饱和曲线是手写硬拐点（命中封顶 6 次）；`k1` / `b` 才是为这件事设计的。
 *
 * **候选要丢掉跨词边界的碎片**（`CN_EDGE_STOP`）：中文没有词边界，n-gram 会把相邻
 * 两个词的字粘起来（「图片和」「片和视」「个插」）。它们分数还高（`词长²`），
 * 去重叠时会把「图片」「视频」「面板」这些真实存在的词全部挤掉 ——
 * 结果是查询词里几乎没有一个是文档里真有的词。
 *
 * 实测（`test/eval/fixture.mjs`，21 个用例）：
 *
 *   | 配置                              | top-1     | MRR       |
 *   |----------------------------------|-----------|-----------|
 *   | v0.5.2（加权命中 + 不去碎片）        | 76.2%     | 0.830     |
 *   | BM25，但抽取仍不去碎片               | 81.0%     | 0.870     |
 *   | **BM25 + 去掉首尾虚词的碎片**        | **95.2%** | **0.976** |
 *
 * 输出顺序仍是分数降序 —— 面板那行「按「xxx」排序」显示的是最重要的词。
 *
 * 全部是确定性字符串运算，没有模型调用，没有网络请求，没有任何依赖。
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

/**
 * **首尾出现即判定为「跨词边界碎片」**的虚词集合。
 *
 * 中文没有词边界，n-gram 会把相邻两个词的字粘在一起（「图片和」「个插」「的排」）。
 * 这类碎片有两个共同特征：**首字或尾字是纯虚词**。它们几乎不可能是真词，
 * 却会占满候选位，把「图片」「排序」这种真实存在的词挤掉。
 *
 * 这是**窄集**，不是 `CN_STOP_CHARS` 全表 —— 后者含「上/中/里/前/后/大/小/一…」，
 * 那些是常见**构词成分**（上传、上下文、中间、下游…），拿它们做首尾判定会误杀真词。
 * 实测：窄集与宽集在评测集上表现完全相同（top-1 95.2% / MRR 0.976），
 * 但窄集保住了上面那些词。
 *
 * ⚠️ **「对」在 v0.8 被移出这个集合。** 它是介词，但也是**构词成分**：
 * 对比、对话、对象、对齐 都是真词，判在首字会把它们全部误杀
 * （实测：「对比度」被切成了碎片「比度」）。
 * 移出之后评测四项指标**一个都没变**（top-1 95.2% / MRR 0.976 / 陷阱 0）。
 * 移除是免费的，所以做了；**再往下裁就没有额外收益**（试过 以/从/到/及/或/为/之/于/并/等/着/过/来/去，
 * 标签一个都没变好），所以停在这里，不再扩大。
 */
const CN_EDGE_STOP = new Set([
  '的', '了', '是', '在', '和', '与', '就', '都', '也', '很', '把', '被', '让', '给',
  '从', '到', '为', '以', '及', '或', '但', '而', '之', '于', '并', '等', '着',
  '过', '呢', '吗', '吧', '啊', '哦', '嗯', '呀', '么', '些', '嘛', '啦',
  '我', '你', '他', '她', '它', '们', '这', '那', '有', '没', '会', '能', '要', '不',
  '说', '做', '用', '好', '多', '少', '来', '去', '出', '入', '时', '话', '个',
])

/* ── 分词（只用于查询侧） ───────────────────────────── */

/** 单个 CJK 字符。用来扫出连续的汉字段，同时保留原文位置。 */
const CJK_RE = /[\u4e00-\u9fff]/

/** 一个词最多留几个位置（只用于合并话题标签，不需要穷举）。 */
const MAX_SPANS_PER_TERM = 8

/** 合并后的标签最长几个字。真词一般不超过这个长度（扩展名白名单 = 6）。 */
const MAX_LABEL_CHARS = 6

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
 * 把一段对话文本切成候选词，**并带上每个词在原文里的位置**。
 *
 * 位置是给「当前话题」标签用的：候选里难免有跨词边界的碎片
 * （`项目文` / `目文档` 都是「项目文档」的碎片），但**它们覆盖的区间是重叠的** ——
 * 把重叠区间合并再切原文，就还原出真词「项目文档」。
 * 见 `readableTopics()`。
 *
 * 只在**查询侧**使用。文档侧不调它 —— 那是为了性能，见文件头说明。
 *
 * 规则（与 v0.6 的 `tokenize` 逐字一致，只是多带位置）：
 *   - ASCII 词 / 标识符：`[A-Za-z][A-Za-z0-9_]{2,29}`，小写后丢掉英文停用词
 *   - 中文：按非 CJK 字符切段，每段长度 ≥ 2 时产出**全部 2-gram 与 3-gram**，
 *     2-gram 丢掉中文停用 bigram，全是停用字符的 gram 丢掉
 *
 * @param {string} text - 文本（调用方保证已是小写；中文不受影响）
 * @returns {Array<{term: string, start: number, end: number}>} 词与它在 `text` 里的区间
 */
export function tokenizeSpans(text) {
  if (!text) return []
  const out = []

  // ASCII 词 / 标识符（chokidar、TypeScript、ctx.sidebarRightTabs…）
  for (const m of text.matchAll(/[A-Za-z][A-Za-z0-9_]{2,29}/g)) {
    const token = m[0].toLowerCase()
    if (EN_STOP.has(token)) continue
    out.push({ term: token, start: m.index, end: m.index + m[0].length })
  }

  // 中文 2-gram / 3-gram。
  // **不能用 replace + split 找 run** —— 那会丢掉原文位置，只能自己扫。
  let i = 0
  while (i < text.length) {
    if (!CJK_RE.test(text[i])) {
      i += 1
      continue
    }
    let j = i
    while (j < text.length && CJK_RE.test(text[j])) j += 1
    const runLen = j - i
    if (runLen >= 2) {
      for (let n = 2; n <= 3; n += 1) {
        for (let k = 0; k + n <= runLen; k += 1) {
          const gram = text.slice(i + k, i + k + n)
          if (n === 2 && CN_STOP_BIGRAMS.has(gram)) continue
          if (allStopChars(gram)) continue
          out.push({ term: gram, start: i + k, end: i + k + n })
        }
      }
    }
    i = j
  }

  return out
}

/**
 * 把一段对话文本切成候选词（只要词，不要位置）。
 *
 * 与 `tokenizeSpans` 产出的词表**逐字一致**，只是把位置丢掉了。
 * 保留这个导出是因为 v0.6 的「抽词零变化」守卫测试直接对着它断言。
 *
 * @param {string} text - 文本
 * @returns {string[]} 词表，含重复
 */
export function tokenize(text) {
  return tokenizeSpans(text).map((tok) => tok.term)
}

/* ── 关键词抽取 ─────────────────────────────────────── */

/**
 * 把一段文本的词频累加进两张表，并记下每个词在原文里的位置。
 *
 * **原始次数与加权分数分开记**：权重只影响排序，不影响「够不够格」。
 * 否则一条消息权重 3，里面出现一次的词也会被当成出现 3 次，噪音全进来了。
 *
 * @param {string} text - 文本
 * @param {number} weight - 这段话的权重倍数
 * @param {Map<string, number>} raw - 原始出现次数
 * @param {Map<string, number>} weighted - 加权分数
 * @param {Map<string, Array<{text: string, start: number, end: number}>>} spans - 词 → 它在原文里的区间
 * @returns {void}
 */
function accumulate(text, weight, raw, weighted, spans) {
  for (const tok of tokenizeSpans(text)) {
    const term = tok.term
    raw.set(term, (raw.get(term) || 0) + 1)
    weighted.set(term, (weighted.get(term) || 0) + weight)
    if (!spans) continue
    let list = spans.get(term)
    if (list === undefined) {
      list = []
      spans.set(term, list)
    }
    if (list.length < MAX_SPANS_PER_TERM) list.push({ text, start: tok.start, end: tok.end })
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
 * **候选会丢掉跨词边界的碎片**（见 `CN_EDGE_STOP`）：首字或尾字是虚词的 n-gram
 * 几乎都是两个词粘起来的产物，不是词。不丢的话它们会占满候选位，
 * 把真实存在的词全挤出去。
 *
 * 输出仍按分数降序。
 *
 * **每个词还会带上它在原文里的位置**（`spans`）。位置不参与排序，
 * 只用来把「当前话题」标签还原成可读的词 —— 见 `readableTopics()`。
 *
 * @param {readonly string[]} messages - 对话文本，最新在前
 * @param {number} limit - 最多返回多少个关键词
 * @returns {Array<{term: string, weight: number, spans: Array<{text: string, start: number, end: number}>}>}
 *   关键词及其权重，权重降序
 */
export function extractKeywords(messages, limit = 30) {
  const raw = new Map()
  const weighted = new Map()
  const spans = new Map()

  messages.forEach((text, index) => {
    const weight = index === 0 ? 3 : index === 1 ? 2 : 1
    accumulate(text, weight, raw, weighted, spans)
  })

  const ranked = [...weighted.entries()]
    .map(([term, weight]) => ({ term, weight, seen: raw.get(term) || 0 }))
    .filter((entry) => {
      if (/^[a-z]/.test(entry.term)) return entry.seen >= 1
      // 跨词边界的碎片：首字或尾字是纯虚词。判在门槛之前 —— 它比「出现几次」更根本。
      if (CN_EDGE_STOP.has(entry.term[0])) return false
      if (CN_EDGE_STOP.has(entry.term[entry.term.length - 1])) return false
      return entry.seen >= 2 || entry.weight >= 3
    })
    .map((entry) => ({ ...entry, score: entry.weight * entry.term.length * entry.term.length }))
    .sort((a, b) => (b.score - a.score) || a.term.localeCompare(b.term))

  const picked = []
  for (const entry of ranked) {
    if (picked.length >= limit) break
    // 去重叠：已经选了「相关性排序」，就不再要「相关性」和「排序」
    if (picked.some((p) => p.term.includes(entry.term) || entry.term.includes(p.term))) continue
    picked.push(entry)
  }

  return picked.map((entry) => ({
    term: entry.term,
    weight: entry.score,
    spans: spans.get(entry.term) || [],
  }))
}

/* ── 当前话题标签（v0.8） ───────────────────────────── */

/**
 * 把「语料里真实存在」的那批候选词还原成人能读的标签。
 *
 * **问题**：候选分是 `出现次数 × 词长²`，所以每个 3-gram 都压过所有 2-gram。
 * 对「项目文档」这种输入，`项目文` 与 `目文档` 先被选中，
 * 真实的 `项目` / `文档` 作为它们的子串在去重叠时被吞掉 ——
 * 面板那行就成了「按「目文档、项目文」排序」。
 *
 * **修法**：不动排序（`extractKeywords` 的候选与顺序一字不改），
 * 只把命中词的**原文区间**拿来合并 —— `项目文[0,3)` 与 `目文档[1,4)` 是**重叠**的，
 * 合并后切原文得到 `项目文档`，正好是真词。
 *
 * 三个细节：
 *   - **只有严格重叠才合并**，相邻不算。否则 `相关[0,2)` + `性排[2,4)` 会被粘成
 *     更难看的「相关性排」。
 *   - **合并结果必须在语料里真的出现过**（`isPresent`）。这一条是必需的：
 *     3-gram 逐个错位、彼此都重叠，所以**传递性合并会一路串下去** ——
 *     实测「悬停浮层是怎么做的」会串成「悬停浮层是怎」、「扩展名白名单都放行什么」
 *     会串成「扩展名白名单都放行什」。光靠长度上限没用（链条会一直长到上限为止）。
 *     「项目文档」「悬停浮层」「扩展名白名单」都真的在项目里出现过，而串出来的那几句没有。
 *   - 拿不到 `spans`（调用方直接传了 `{term, weight}`）时返回空数组，
 *     由调用方回落成原来的词表。
 *
 * @param {readonly {term: string, weight: number, spans?: Array<{text: string, start: number, end: number}>}[]} keywords -
 *   已经过滤到「语料里真实存在」的那批词
 * @param {number} limit - 最多返回几个标签
 * @param {(label: string) => boolean} [isPresent] - 判断一段文本是否在语料里出现过；
 *   不传就只按长度上限取最长的那段（测试用）
 * @returns {string[]} 标签词，按权重降序
 */
export function readableTopics(keywords, limit = 3, isPresent) {
  const groups = new Map()
  for (const kw of keywords) {
    if (!kw || !Array.isArray(kw.spans)) continue
    for (const span of kw.spans) {
      if (!span || typeof span.text !== 'string') continue
      if (!Number.isInteger(span.start) || !Number.isInteger(span.end)) continue
      let list = groups.get(span.text)
      if (list === undefined) {
        list = []
        groups.set(span.text, list)
      }
      list.push({ start: span.start, end: span.end, weight: kw.weight })
    }
  }

  const found = []
  for (const [text, list] of groups) {
    list.sort((a, b) => (a.start - b.start) || (a.end - b.end))

    // 滑动窗口：从每个还没被用掉的区间出发，尽量往后接**仍然与当前并集重叠**的区间，
    // 一旦并集超过长度上限就停（后面只会更长）。
    // 取其中**最长且在语料里真的出现过**的那一段；用掉它覆盖的区间，再处理下一个。
    // 于是一句话里可以有多个标签（互不重叠），而不是只挑一个。
    const used = new Array(list.length).fill(false)
    for (let i = 0; i < list.length; i += 1) {
      if (used[i]) continue
      const start = list[i].start
      let end = list[i].end
      let weight = list[i].weight
      let bestEnd = -1
      let bestWeight = -1
      for (let j = i; j < list.length; j += 1) {
        if (j > i) {
          if (list[j].start >= end) break // 不再重叠 → 链条断了
          end = Math.max(end, list[j].end)
          weight = Math.max(weight, list[j].weight)
        }
        const size = end - start
        if (size < 2) continue
        if (size > MAX_LABEL_CHARS) break
        const label = text.slice(start, end)
        if (isPresent !== undefined && !isPresent(label)) continue
        if (size > bestEnd - start) {
          bestEnd = end
          bestWeight = weight
        }
      }
      if (bestEnd < 0) continue // 这个起点组不出任何真实存在的词
      found.push({ label: text.slice(start, bestEnd), weight: bestWeight })
      for (let j = i; j < list.length; j += 1) {
        if (list[j].start < bestEnd) used[j] = true
      }
    }
  }

  found.sort((a, b) => (b.weight - a.weight) || a.label.localeCompare(b.label))
  const seen = new Set()
  const out = []
  for (const item of found) {
    if (seen.has(item.label)) continue
    seen.add(item.label)
    out.push(item.label)
    if (out.length >= limit) break
  }
  return out
}

/* ── 文档打分（v0.6 换成 BM25） ─────────────────────── */

/**
 * 字段权重。
 *
 * 沿用 v0.5.2 的比例（标题 > 摘要 > 正文）—— 这是已经对外解释过的产品决策，
 * 不是 v0.6 要改的东西；README 里那张表说的就是这三个数。
 */
const FIELD_WEIGHTS = { title: 4, summary: 2, body: 1 }

/**
 * 每个字段的长度归一化强度 `b`：`0` 是不归一化，`1` 是完全按长度归一化。
 *
 * 标题本来就短、长度差异小，过度归一化会惩罚「信息量大的长标题」，所以给小值；
 * 正文差异最大，用 BM25 的经典默认值 0.75。
 */
const FIELD_B = { title: 0.3, summary: 0.5, body: 0.75 }

/** BM25 的词频饱和系数（经典默认值）。 */
const K1 = 1.2

/**
 * 单词频上限。
 *
 * BM25 本身就会饱和（`k1` 越小饱和越快），所以封顶不是为了压制长文档，
 * 纯粹是为了给最坏情况（一个词在 2500 字里出现几百次）定一个成本上界。
 * 取 20 时，与不封顶的分数差已经可以忽略。
 */
const TF_CAP = 20

/** 参与打分的字段名。 */
const FIELDS = ['title', 'summary', 'body']

/** 新鲜度奖励的时间常数（7 天）。 */
const FRESHNESS_WINDOW_MS = 7 * 24 * 60 * 60 * 1000

/**
 * 查询侧相对权重的压缩指数：`qw(t) = (weight(t) / max(weight)) ^ QW_EXPONENT`。
 *
 * 候选分是 `出现次数 × 词长²`，尺度差得很远：一个 4 字英文词出现 10 次是 160 分，
 * 一个中文 2-gram 出现 5 次只有 20 分。直接用比例（指数 1）会让**最强的那一个词**
 * 压过其余所有词，于是「满篇项目名」的文档靠一个词就能霸榜。
 *
 * 实测（21 个用例）：指数 1 时高频词陷阱仍然失败；**≤ 0.25 时全部翻正**，
 * 而 top-1 / MRR 不变。取 0.25 —— 保留「越新 / 越长的词更重要」的**次序**，
 * 但把它的**幅度**压到不再压倒其他词。
 */
const QW_EXPONENT = 0.25

/**
 * 数一个词在文本里出现几次，最多 `TF_CAP` 次。
 * @param {string} hay - 小写后的可搜索文本
 * @param {string} needle - 关键词（小写）
 * @returns {number} 出现次数
 */
function countOccurrences(hay, needle) {
  if (!hay || !needle) return 0
  let hits = 0
  let from = 0
  for (;;) {
    const at = hay.indexOf(needle, from)
    if (at === -1 || hits >= TF_CAP) break
    hits += 1
    from = at + needle.length
  }
  return hits
}

/**
 * 给一批文档算相关度并按相关度重排（BM25 + 字段加权）。
 *
 * 每个文档需要 `haystack: { title, summary, body }`（都已小写）。
 * 文档侧不做分词 —— tf 用子串扫描数，长度用字符数，见文件头。
 *
 * @param {Array<object>} docs - 文档记录（含 haystack 与 mtimeMs）
 * @param {readonly {term: string, weight: number, spans?: Array<object>}[]} keywords - 关键词表
 * @param {number} now - 当前时间（epoch ms）
 * @returns {{docs: Array<object>, maxRaw: number, matched: string[], label: string[]}}
 *   带 `score` 的文档（相关度降序）；
 *   `matched` 是**语料里真实存在**的词，`label` 是给用户看的**可读**话题词
 *   （把命中词的原文区间合并后的结果，见 `readableTopics`）。
 *   调用方应该用 `label` 渲染「按「xxx」排序」。
 */
export function rankByRelevance(docs, keywords, now) {
  if (keywords.length === 0) {
    return { docs: docs.map((doc) => ({ ...doc, score: 0 })), maxRaw: 0, matched: [], label: [] }
  }

  const maxWeight = keywords.reduce((max, k) => Math.max(max, k.weight), 0)

  // 查询侧相对权重：保留「越新 / 越长的词越重要」这个既有语义，
  // 但压缩幅度并去掉绝对尺度 —— 否则 raw 的量级会随对话长度漂移，
  // 而且最强的那个词会压过其余所有词（见 QW_EXPONENT 的说明）。
  const qw = new Map(keywords.map((k) => {
    const ratio = maxWeight > 0 ? k.weight / maxWeight : 0
    return [k.term, Math.pow(ratio, QW_EXPONENT)]
  }))

  /* ── 第 1 趟：tf、字段长度、文档频率 ───────────────── */

  const total = docs.length
  const df = new Map()
  const lens = { title: 0, summary: 0, body: 0 }
  const tfList = []

  for (const doc of docs) {
    const hay = doc.haystack || { title: '', summary: '', body: '' }
    const tf = { title: new Map(), summary: new Map(), body: new Map() }
    const len = { title: 0, summary: 0, body: 0 }
    const seen = new Set()

    for (const field of FIELDS) {
      const text = hay[field] || ''
      // 长度代理：字段字符数。只要求与文档长度单调相关，不要求是「词数」。
      len[field] = text.length
      lens[field] += text.length
      for (const { term } of keywords) {
        const hits = countOccurrences(text, term)
        if (hits === 0) continue
        tf[field].set(term, hits)
        seen.add(term)
      }
    }

    // df 是**文档级**的：一个词在这篇的任一字段出现过就算一次，
    // 同一篇里两个字段都命中不能算两次。
    for (const term of seen) df.set(term, (df.get(term) || 0) + 1)
    tfList.push({ tf, len })
  }

  const avgdl = {}
  for (const field of FIELDS) {
    avgdl[field] = total > 0 ? lens[field] / total : 0
  }

  // 概率式 BM25 的 IDF：恒为正，不会出现负值把分数往下拉。
  // 注意语料越小，df 的取值范围越窄 → IDF 的动态范围越窄 → 收益越小（但不会变坏）。
  // 三五篇文档时它几乎不起作用，这是合理预期，不要宣传成「小项目也明显变准」。
  const idf = new Map()
  for (const { term } of keywords) {
    const d = df.get(term) || 0
    idf.set(term, d > 0 ? Math.log(1 + (total - d + 0.5) / (d + 0.5)) : 0)
  }

  /* ── 第 2 趟：BM25 打分 ────────────────────────────── */

  const raws = docs.map((doc, index) => {
    const { tf, len } = tfList[index]
    let raw = 0

    for (const { term } of keywords) {
      const weight = qw.get(term) || 0
      if (weight === 0) continue
      const termIdf = idf.get(term) || 0
      if (termIdf === 0) continue // df = 0：语料里没有这个词，直接跳过

      let fieldSum = 0
      for (const field of FIELDS) {
        const freq = tf[field].get(term) || 0
        if (freq === 0) continue
        // avgdl 为 0 说明这个字段在整个语料里都是空的（例如 kind=media 时
        // 每篇的 summary/body 都为空）—— 此时不做长度归一化。
        // 不短路的话这里会除零，NaN 会顺着 maxRaw 污染全部文档的分数。
        const norm = avgdl[field] > 0 ? len[field] / avgdl[field] : 0
        const denom = freq + K1 * (1 - FIELD_B[field] + FIELD_B[field] * norm)
        fieldSum += (FIELD_WEIGHTS[field] * freq * (K1 + 1)) / denom
      }

      if (fieldSum > 0) raw += weight * termIdf * fieldSum
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

  // 语料里真实存在的词，按查询权重降序。
  const present = keywords
    .filter((k) => (df.get(k.term) || 0) > 0)
    .sort((a, b) => b.weight - a.weight)
  const matched = present.map((k) => k.term)

  // 给「当前话题」用的**可读**标签：把命中词的原文区间合并，还原出真词。
  // 合并结果还要**真的在语料里出现过**才认 —— 否则传递性合并会把整句串起来，
  // 见 `readableTopics` 的说明。用不了 spans 时回落成 matched 本身。
  // ⚠️ 语料的 haystack 是**已小写**的，而标签切的是**原文**（保留大小写）——
  // 所以比对前必须把标签也小写，否则 `BM25` 这种永远匹配不上。
  const isPresent = (label) => {
    const needle = label.toLowerCase()
    return docs.some((doc) => {
      const hay = doc.haystack
      if (!hay) return false
      return (hay.title || '').includes(needle)
        || (hay.summary || '').includes(needle)
        || (hay.body || '').includes(needle)
    })
  }
  const merged = readableTopics(present, 3, isPresent)
  const label = merged.length > 0 ? merged : matched.slice(0, 3)

  return { docs: scored, maxRaw, matched, label }
}

/**
 * 从关键词表里挑一个给人看的「当前话题」标签。
 * @param {readonly (string|{term: string})[]} terms - 词，或含 `term` 的对象
 * @param {number} count - 取几个
 * @returns {string} 用「、」连接的标签，没有则空串
 */
export function topicLabel(terms, count = 3) {
  const picked = terms
    .slice(0, count)
    .map((entry) => (typeof entry === 'string' ? entry : entry.term))
    .filter((term) => term && term.length >= 2)
  return picked.join('、')
}

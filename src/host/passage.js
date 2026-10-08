/**
 * Knit · 内容片段层（v0.20 Deep Context Retrieval）
 *
 * 这一层只回答一个问题：**一篇文件的正文里，哪几段与当前任务有关？**
 *
 * 三条边界（需求 §6 / §24）：
 *   - 零模型、零网络、零依赖：全部是字符串操作
 *   - **不引入 AST / LSP / Tree-sitter**：切段靠行级正则、空行与大括号，不靠语法树
 *   - **不新建第二套检索器**：片段排序复用 `relevance.js` 的 `rankByRelevance()`
 *
 * 最要紧的设计是「片段是**投影**，不是第二个排序阶段」（实现说明 D3）：
 * 文件名次仍完全由现有的文件级 BM25 决定（正文不再截断，于是 `avgdl[body]`
 * 是真实长度，长文件被 `b = 0.75` 直接惩罚），片段只在**已经排好序的文件内部**
 * 挑最好的 1–2 段。于是「20 个低价值片段堆出一个高分文件」在结构上不可能发生
 * （需求 §8 / §9），`test/eval.test.mjs` 那套质量基线也逐字不受影响。
 *
 * 行号与偏移量的口径（§11）：
 *   - `startLine` / `endLine` 是 **1 起算、两端都含**的行号
 *   - `startOffset` / `endOffset` 是**原文**（不是小写 haystack）上的字符偏移，
 *     且恒有 `body.slice(startOffset, endOffset) === 片段文本`
 *   - 片段文本**不含**结尾换行 —— 于是上面那条恒等式逐字成立，可以被测试直接断言
 */

import { rankByRelevance } from './relevance.js'
import { KIND_CODE } from './classification.js'

/** 单个片段的目标上限（§5：结构优先，长度兜底）。 */
export const PASSAGE_MAX_CHARS = 1200
/** 片段的目标下限，短于此的相邻片段会被合并（标题、单行声明不该各占一个片段）。 */
export const PASSAGE_MIN_CHARS = 300
/** 每篇文件最多报几段（§8：限制片段数，别让一篇文件刷屏）。 */
export const PASSAGE_MAX_PER_FILE = 2
/**
 * 只为排名最前的多少条记录建片段。
 *
 * 与列表分页无关：这是**宿主**这边的成本上限 —— 1000 篇文件全部切段
 * 是 O(全文)，而我们只需要前若干条的片段（§16 的「更精准而不是发更多内容」）。
 */
export const PASSAGE_WINDOW = 24
/** 一篇文件最多产出多少片段，超出截断（防止一个巨文件把内存吃光）。 */
export const PASSAGE_LINES_MAX = 200
/** 片段摘要的长度（与 `tool.js` 的 `SNIPPET_CHARS` 是同一个展示口径）。 */
export const SNIPPET_CHARS = 200

/** 超长单行按字符硬切时的重叠量：避免一个词正好落在切缝上被两边各切一半。 */
const HARD_SPLIT_OVERLAP = 64
/** 代码没有任何结构化锚点时的兜底窗口行数。 */
const CODE_WINDOW_LINES = 40

/** Markdown 的分段锚点：H1–H6。 */
const MD_HEADING = /^#{1,6}\s/
/**
 * 代码的分段锚点（§5）—— **只看行首**，于是只认顶层声明，
 * 函数内部的 `const` / `return` 不会把一段函数切碎。
 *
 * `}` **不是**锚点：锚点的语义是「新片段从这里**开始**」，
 * 把收尾大括号当锚点会让片段从上一段的 `}` 开始（命中在 beta 里、
 * 片段却从 alpha 的闭括号报起），反而不像「函数附近」。
 */
const CODE_ANCHOR = /^(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function|class|const|let|var|interface|type|enum|import|export|def|from)\b/

/**
 * 把正文切成片段。
 *
 * @param {string} text - **原文**（不是小写化的 haystack）
 * @param {{kind?: string}} [options] - `kind` 为 `KIND_CODE` 时走代码口径，否则走 Markdown 口径
 * @returns {{passages: Array<{startLine:number, endLine:number, startOffset:number,
 *   endOffset:number, text:string, body:string}>, truncated: boolean}}
 */
export function chunkText(text, options = {}) {
  const src = typeof text === 'string' ? text : ''
  if (src.trim() === '') return { passages: [], truncated: false }
  const kind = options.kind === KIND_CODE ? 'code' : 'doc'

  const lines = src.split('\n')
  const offsets = new Array(lines.length)
  let at = 0
  for (let i = 0; i < lines.length; i++) {
    offsets[i] = at
    at += lines[i].length + 1
  }

  // 结构优先：先按结构锚点把文件切成若干「节」，再用长度兜底把过长的节切开。
  const bounds = [0]
  for (const c of cutsOf(lines, kind)) {
    if (c > 0 && c < lines.length && c > bounds[bounds.length - 1]) bounds.push(c)
  }
  bounds.push(lines.length)

  const raw = []
  for (let i = 0; i < bounds.length - 1; i++) {
    const a = bounds[i]
    const z = bounds[i + 1] - 1
    if (z < a) continue
    pushRanges(raw, lines, offsets, a, z, PASSAGE_MAX_CHARS, PASSAGE_MIN_CHARS)
  }

  const merged = mergeRanges(raw, PASSAGE_MIN_CHARS, PASSAGE_MAX_CHARS)
  const truncated = merged.length > PASSAGE_LINES_MAX
  const kept = truncated ? merged.slice(0, PASSAGE_LINES_MAX) : merged
  return { passages: kept.map((r) => toPassage(src, r)), truncated }
}

/**
 * 给一条**已经排好名次**的文件记录挑出最相关的 1–2 段。
 *
 * ⚠️ 只在文件内部排序，不改文件名次（D3）。没有正文、没有关键词、或一段都没命中时
 * 老实返回空数组 —— 空数组是「没有可报的片段」，不是「不相关」。
 *
 * @param {object} entry - 内部记录（需要 `body` / `kind` / `rel` / `mtimeMs`）
 * @param {Array<{term:string, weight:number}>} keywords - 与文件级打分同一批关键词
 * @param {number} [now] - 时间基准（确定性测试要传固定值）
 * @returns {Array<{startLine:number, endLine:number, startOffset:number, endOffset:number,
 *   terms:Array<string>, snippet:string}>}
 */
export function passageMatchesFor(entry, keywords, now = Date.now()) {
  if (!entry || typeof entry.body !== 'string' || entry.body === '') return []
  if (!Array.isArray(keywords) || keywords.length === 0) return []

  const { passages } = chunkText(entry.body, { kind: entry.kind })
  if (passages.length === 0) return []

  const rel = typeof entry.rel === 'string' ? entry.rel : ''
  // 片段在这里被当成一条「文档」喂给现成的 `rankByRelevance()`：
  // title / summary 留空，整段正文进 body（权重 1，与文件级正文同一个字段口径）。
  const docs = passages.map((p, i) => ({
    rel: `${rel}#${i}`,
    name: entry.name || '',
    title: '',
    summary: '',
    mtimeMs: entry.mtimeMs || 0,
    kind: entry.kind,
    haystack: { title: '', summary: '', body: p.body },
    passage: p,
  }))

  const ranked = rankByRelevance(docs, keywords, now)
  const hit = ranked.docs.filter((d) => d.raw > 0)
  // 显式定序（§20）：分数 → 行号 → 偏移 → rel。
  // `rankByRelevance` 的末位并列判据是 `rel`，而这里的 `rel` 带着 `#下标` 后缀，
  // 字典序会把 `#10` 排到 `#2` 前面 —— 所以这里必须自己定序，不依赖那一条。
  hit.sort((a, b) =>
    b.raw - a.raw
    || a.passage.startLine - b.passage.startLine
    || a.passage.startOffset - b.passage.startOffset
    || (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0))

  // **先按分数选出最好的 1–2 段，再把选中的这几段按行号升序报出去。**
  // 两件事要分开：分数决定「哪几段值得报」，行号决定「报出来的阅读顺序」——
  // 读者在预览里从上往下看，片段就该按文档顺序排（§11 的「稳定确定」由前者保证）。
  const picked = hit.slice(0, PASSAGE_MAX_PER_FILE)
  picked.sort((a, b) =>
    a.passage.startLine - b.passage.startLine
    || a.passage.startOffset - b.passage.startOffset
    || (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0))

  return picked.map((d) => ({
    startLine: d.passage.startLine,
    endLine: d.passage.endLine,
    startOffset: d.passage.startOffset,
    endOffset: d.passage.endOffset,
    terms: d.matchedTerms.map((t) => t.term),
    snippet: snippetOf(d.passage.text, d.matchedTerms),
  }))
}

/**
 * 在原文上取一小段可读的摘要，以**第一个命中词**为中心。
 *
 * 与 `tool.js` 的 `pickSnippet` 是同一套展示口径（先压平空白再截），
 * 区别只在于这里切的是**片段**而不是整篇正文的首部窗口。
 *
 * @param {string} text - 片段原文
 * @param {Array<{term:string}>} matchedTerms - 该片段的命中词
 * @returns {string} 不超过 `SNIPPET_CHARS` 字符的摘要（截断处用 `…` 标出）
 */
export function snippetOf(text, matchedTerms) {
  const flat = String(text || '').replace(/\s+/g, ' ').trim()
  if (flat === '') return ''
  const lower = flat.toLowerCase()

  let centre = -1
  for (const t of matchedTerms || []) {
    const term = String(t && t.term ? t.term : '').toLowerCase()
    if (term === '') continue
    const pos = lower.indexOf(term)
    if (pos >= 0 && (centre < 0 || pos < centre)) centre = pos
  }
  if (centre < 0) centre = 0

  const start = Math.max(0, centre - 40)
  let out = flat.slice(start, start + SNIPPET_CHARS)
  if (start > 0) out = `…${out}`
  if (start + SNIPPET_CHARS < flat.length) out = `${out}…`
  return out
}

/**
 * 一个词在**任意一段 `window` 字符宽的窗口内**最多出现几次。
 *
 * 这是修「长文件污染」的那个长度无关的量（需求 §9）：整篇字频会随文件变长
 * 而虚高 —— 29 000 字的 CHANGELOG 里一个词出现 3 次，看起来比 400 字的短文里
 * 出现 4 次还「更像在讲它」；但把窗口收窄到一段，3 次散在三处只有 1 次，
 * 而 4 次挤在一段里就是 4 次。`context.js` 的 `isDocHit` 用它替代整篇字频。
 *
 * 纯函数、零 I/O、上界确定：滑动窗口是 O(出现次数)，出现次数再多数到 `cap` 次就停。
 *
 * @param {string} text - **已小写化**的正文（`haystack.body`）
 * @param {string} term - **已小写化**的词
 * @param {number} [window] - 窗口宽度（字符），默认与片段上限一致
 * @param {number} [cap] - 最多数到几次（病态的重复文本不至于吃掉内存）
 * @returns {number} 单窗口内的最大出现次数（0 表示没出现）
 */
export function windowTf(text, term, window = PASSAGE_MAX_CHARS, cap = 32) {
  if (typeof text !== 'string' || text === '') return 0
  if (typeof term !== 'string' || term === '') return 0
  if (!Number.isFinite(window) || window <= 0) return 0

  // 与 `relevance.js` 的 `countOccurrences()` 同一个口径：切完就跳过整个词
  // （不做重叠计数），否则 'aa' 在 'aaa' 里会数出 2 次。
  const at = []
  let from = 0
  for (;;) {
    const i = text.indexOf(term, from)
    if (i < 0) break
    at.push(i)
    if (at.length >= cap) break
    from = i + term.length
  }
  if (at.length === 0) return 0

  let best = 0
  let left = 0
  for (let right = 0; right < at.length; right++) {
    while (at[right] - at[left] + term.length > window) left += 1
    const span = right - left + 1
    if (span > best) best = span
  }
  return best
}

/**
 * 给**一条已经排好名次的记录**算逐词的「单窗口内最大字频」（D5）。
 *
 * 只算**正文真的命中**的那些词（`matchedTerms[].fields.body`）—— 别的词本来
 * 就不会被 `isDocHit` 看一眼，算了也是白算。没有正文（媒体）或一个词都没命中
 * 正文时返回 `null`，于是 `context.js` 会退回 v0.19 的整篇字频口径。
 *
 * @param {object} doc - `rankByRelevance()` 产出的记录（含 `haystack` / `matchedTerms`）
 * @param {number} [window] - 窗口宽度，默认与片段上限一致
 * @returns {Object<string, number>|null}
 */
export function passageTfOf(doc, window = PASSAGE_MAX_CHARS) {
  const hay = doc && doc.haystack ? doc.haystack : null
  const body = hay && typeof hay.body === 'string' ? hay.body : ''
  if (body === '') return null
  const terms = Array.isArray(doc.matchedTerms) ? doc.matchedTerms : []
  const out = {}
  let any = false
  for (const entry of terms) {
    if (!entry || !entry.fields || !entry.fields.body) continue
    const term = typeof entry.term === 'string' ? entry.term : ''
    if (term === '') continue
    out[term] = windowTf(body, term, window)
    any = true
  }
  return any ? out : null
}

/* ── 内部：分段 ──────────────────────────────────────── */

/** 结构锚点所在的行下标（1 起，不包含第 0 行）。 */
function cutsOf(lines, kind) {
  const out = []
  if (kind === 'doc') {
    for (let i = 1; i < lines.length; i++) {
      if (MD_HEADING.test(lines[i])) out.push(i)
    }
    return out
  }

  for (let i = 1; i < lines.length; i++) {
    if (CODE_ANCHOR.test(lines[i])) out.push(i)
  }
  // 结构化锚点太少（没有顶层声明的数据文件、一段散文式脚本）：
  // 退回固定行窗口，保证「长文件一定被切成多段」而不是硬撑成一整段。
  if (out.length < 2 && lines.length > CODE_WINDOW_LINES) {
    out.length = 0
    for (let i = CODE_WINDOW_LINES; i < lines.length; i += CODE_WINDOW_LINES) out.push(i)
  }
  return out
}

/** 行区间 → 带字符偏移的区间（`endOffset` 不含结尾换行；首尾空行不算内容）。 */
function makeRange(lines, offsets, a, z) {
  // 首尾的空行不算内容：不剥掉的话每个片段都会顶着上一段留下的空行开头，
  // 而 `snippetOf()` 又要先压平空白 —— 那是在为切分的毛边反复擦屁股。
  while (a < z && lines[a].length === 0) a += 1
  while (z > a && lines[z].length === 0) z -= 1
  return {
    start: a,
    end: z,
    startOffset: offsets[a],
    endOffset: offsets[z] + lines[z].length,
  }
}

/**
 * 把一个「节」（行区间 `[a, z]`）按长度上限切开。
 *
 * 两处细节是刻意的：
 *   - 优先在**本段内最后一个空行**处断（§5 的 paragraph 切分），空行落在段首时不用它
 *   - 单行本身就超过上限时（压缩过的 JSON、打包产物）按字符硬切，
 *     切缝留 `HARD_SPLIT_OVERLAP` 个字符的重叠，免得一个词被切缝劈成两半而漏掉
 */
function pushRanges(out, lines, offsets, a, z, maxChars, minChars) {
  let start = a
  let size = 0
  let lastBlank = -1

  const flush = (end) => {
    if (end < start) return
    out.push(makeRange(lines, offsets, start, end))
    start = end + 1
    size = 0
    lastBlank = -1
  }

  for (let i = a; i <= z; i++) {
    const lineLen = lines[i].length

    if (lineLen > maxChars) {
      if (i > start) flush(i - 1)
      pushHardSplit(out, lines, offsets, i, maxChars)
      start = i + 1
      size = 0
      lastBlank = -1
      continue
    }

    const add = lineLen + 1
    if (size > 0 && size + add > maxChars) {
      // ③ 优先在**本段内最后一个空行**处断（§5 的 paragraph 切分）。
      //    但只有那个空行确实够靠后（切出来的前半段已经达到下限）才用它 ——
      //    否则一段没有空行的长正文会被切出一个只有几行的碎片。
      const usable = lastBlank > start && offsets[lastBlank] - offsets[start] >= minChars
      const at = usable ? lastBlank : i - 1
      flush(at)
      // `flush(at)` 只把 `start` 推到 `at + 1`：`at + 1 .. i - 1` 这几行已经属于
      // 新片段，长度要重新累计（它们不可能超过一个片段，循环是有界的）。
      for (let j = start; j < i; j++) {
        size += lines[j].length + 1
        if (lines[j].length === 0) lastBlank = j
      }
    }
    size += add
    if (lineLen === 0) lastBlank = i
  }
  if (start <= z) flush(z)
}

/** 超长单行按字符硬切（行号不变，靠偏移量区分）。 */
function pushHardSplit(out, lines, offsets, i, maxChars) {
  const line = lines[i]
  const step = Math.max(1, maxChars - HARD_SPLIT_OVERLAP)
  let at = 0
  while (at < line.length) {
    const take = Math.min(maxChars, line.length - at)
    out.push({
      start: i,
      end: i,
      startOffset: offsets[i] + at,
      endOffset: offsets[i] + at + take,
    })
    if (at + take >= line.length) break
    at += step
  }
}

/** 把过短的相邻片段并起来（只在合并后仍不超上限时）。 */
function mergeRanges(ranges, minChars, maxChars) {
  const out = []
  for (const r of ranges) {
    const prev = out[out.length - 1]
    const len = r.endOffset - r.startOffset
    const prevLen = prev ? prev.endOffset - prev.startOffset : 0
    if (prev && prevLen < minChars && prevLen + len + 1 <= maxChars) {
      prev.end = r.end
      prev.endOffset = r.endOffset
      continue
    }
    out.push({ start: r.start, end: r.end, startOffset: r.startOffset, endOffset: r.endOffset })
  }
  return out
}

/** 区间 → 公开片段（行号转 1 起算，附小写正文供打分）。 */
function toPassage(src, r) {
  const text = src.slice(r.startOffset, r.endOffset)
  return {
    startLine: r.start + 1,
    endLine: r.end + 1,
    startOffset: r.startOffset,
    endOffset: r.endOffset,
    text,
    body: text.toLowerCase(),
  }
}

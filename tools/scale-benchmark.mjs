/**
 * Knit · **规模基准**：Knit 的排序 vs agent 自己会做的 `grep -c` 计数
 *
 * ── 为什么要有这个 ─────────────────────────────────────
 *
 * 真机验证（`Knit_SDD-v0.8` §8.4）发现：agent 调用完 `knit_docs` 之后，
 * **还会自己 `grep -c` 数一遍关键词密度重新排名**。它不是在核对有没有漏，
 * 是**不认这个排名**。
 *
 * 那么问题就变成一个可以量的问题：**Knit 的排名到底比它自己数关键词强多少？**
 * 如果强不了多少，它自己算就是理性的，改描述也没用。
 *
 * 而且这个差距**应该随语料规模增长** —— 这正是「值钱的是喂给 agent」那条战略判断
 * 需要的前提。所以这里按 N = 20 / 60 / 180 / 540 扫一遍。
 *
 * 用法：node knit/tools/scale-benchmark.mjs
 * 依赖：无（只用 Knit 自己的源码）。不进 `npm test` —— 它是基准，不是断言。
 */
import { pathToFileURL } from 'node:url'
import { extractKeywords, rankByRelevance } from '../src/host/relevance.js'

/* ── 语料构造 ───────────────────────────────────────── */

/** 项目名 —— 在**每一篇**里都出现，所以 df 最高、IDF 最低。真实项目都这样。 */
const PROJECT = 'Knit'

/** 每条主题：一个真词 + 一段只有这篇才讲的正文。 */
const TOPICS = [
  ['排序算法', '相关性打分用 BM25，引入 IDF 抑制高频词，加上长度归一化与 k1 饱和'],
  ['键盘导航', '方向键移动即预览，回车切换展开，Esc 收起，焦点环用中性描边'],
  ['图片视频', '方形缩略图网格最少三列，视频取首帧当海报，走 HTTP Range 流式播放'],
  ['主题令牌', '强调色只允许一个来源，表面分层用 module platform，灰底要降一档'],
  ['接口契约', '列表接口返回 mode topic keywords total，错误只回错误码不回文案'],
  ['路径越界', '读文件接口必须落在工作区内，扩展名白名单，响应带 nosniff 与 sandbox'],
  ['发布流程', '先跑测试确认全绿，再核对版本号与打包内容，最后提交市场收录'],
  ['竞品调研', '全库插件总数与下载量分布，文档类目头部全是生成工具，记忆类目又深又热'],
  ['悬停浮层', '只读浮层列最近五篇，延迟显示与收起，点击才进右边栏不推挤布局'],
  ['权限模型', '按工具层控制权限，审批策略 ask，写操作受白名单约束'],
  ['会话事件', '事件流按 seq 追加，快照读取最近若干条，只认真人输入的用户消息'],
  ['本地优先', '不调模型不联网，全部是确定性字符串运算，文档不出本机'],
]

/** 填充文档里会掺进来的常见词（制造噪音，但都不指向任何一条主题）。 */
const NOISE = [
  '这里记录一些零散的想法与待办事项，与当前话题没有直接关系',
  '这段是为了把文档撑长而写的填充内容，反复出现项目名与常见词',
  '讨论过几次但没有结论，先记在这里以后再看',
  '时间地点人物都略去，只留下几句备忘',
]

/**
 * 造一篇文档。
 * @param {string} rel - 相对路径
 * @param {string} title - 标题
 * @param {string} body - 正文
 * @returns {object} 文档记录（haystack 口径与宿主一致：先截 2500 再小写）
 */
function doc(rel, title, body) {
  return {
    rel,
    mtimeMs: 1_760_000_000_000, // 全部同一时间：把新鲜度变成常数，隔离出「排序」本身
    haystack: {
      title: title.toLowerCase(),
      summary: '',
      body: body.slice(0, 2500).toLowerCase(),
    },
  }
}

/**
 * 造一个 N 篇规模的语料。
 *
 * 结构刻意做成**有干扰项**的：
 *   - 每篇都出现项目名（高 df，考验 IDF）
 *   - 每篇都很长（考验长度归一化）
 *   - 填充文档里**偶尔掺一次**主题词（这才是真正的陷阱：提了一句 ≠ 讲这件事）
 *
 * @param {number} n - 总篇数
 * @returns {{docs: object[], cases: Array<{query: string, want: string}>}} 语料与用例
 */
export function buildCorpus(n) {
  const docs = []
  const cases = []
  const NOW = 1_760_000_000_000
  const stamp = (rel, title, body) => ({
    rel,
    mtimeMs: NOW,
    haystack: {
      title: title.toLowerCase(),
      summary: '',
      body: body.slice(0, 2500).toLowerCase(),
    },
  })

  // ① 主题文档：短、聚焦，只讲一件事，主题词出现 3 次。
  //    文件名**一半描述性、一半看不出内容** —— 真实仓库两者都有
  //    （`Knit_SDD-v0.6-相关性排序质量.md` vs `notes/2026-09-18.md`）。
  //    把「文件名好不好使」这个变量分开，才能看清 Knit 到底解决了什么。
  TOPICS.forEach(([topic, detail], index) => {
    const descriptive = index % 2 === 0
    const rel = descriptive ? `docs/${topic}.md` : `notes/${20260901 + index}.md`
    const body = `${PROJECT} 的${topic}：${detail}。`
      + `${PROJECT} 里${topic}这件事只在这一篇讲清楚。`
      + `再说一遍${topic}的要点：${detail.slice(0, 12)}。`
    docs.push(stamp(rel, topic, body))
    cases.push({ query: `${PROJECT} 的${topic}是怎么做的`, want: rel, descriptive })
  })

  // ② 干扰文档：长，把**每一条主题各提 5 次**（像 CHANGELOG / 归档长文），
  //    但哪一件事都没讲 —— 这是绝对计数法最容易栽的地方
  let i = 0
  while (docs.length < n) {
    const rel = `notes/filler-${i}.md`
    const isArchive = i % 3 === 0
    let body
    if (isArchive) {
      body = `${PROJECT} 历史归档。`
        + TOPICS.map(([t]) => `${t}改过几次。`.repeat(5)).join('')
        + `${PROJECT} 这只是一份流水账，每条都只提一句，没有展开。`.repeat(6)
    } else {
      body = `${PROJECT} 随手记 ${i}。${NOISE[i % NOISE.length]}。`
        + `${PROJECT} 这个是临时记录，内容比较杂。`.repeat(10)
    }
    docs.push(stamp(rel, isArchive ? `归档 ${i}` : `随手记 ${i}`, body))
    i += 1
  }

  return { docs, cases }
}

/* ── 三条路线 ───────────────────────────────────────── */

/**
 * **基线：agent 自己会做的那种** —— 数查询词在整篇里出现了几次，按次数排。
 *
 * 与真机日志里看到的行为一致：`grep -c -E "词1|词2" 每个文件` 然后排序。
 * 没有 IDF、没有长度归一化、没有字段权重、不截断正文。
 *
 * @param {object[]} docs - 文档
 * @param {string[]} terms - 查询词
 * @returns {string[]} 排好序的 rel 列表
 */
/**
 * **基线：agent 自己会做的那种** —— 数查询词在整篇里出现了几次，按次数排。
 *
 * 照抄真机日志里的行为：`grep -c -E "排序|BM25|相关度|相关性"`。
 * **注意它刻意不含项目名** —— 那是它自己挑的词，不是把抽出来的关键词全用上。
 * 所以这里把它排除项目名之后**剩下的**词给它，这是它应得的、不算放水。
 *
 * @param {object[]} docs - 文档
 * @param {string[]} terms - 查询词（调用方已排除项目名）
 * @returns {string[]} 排好序的 rel 列表
 */
function rankByGrepCount(docs, terms) {
  const scored = docs.map((d) => {
    const hay = `${d.haystack.title} ${d.haystack.body}`
    let hits = 0
    for (const t of terms) {
      let from = 0
      for (;;) {
        const at = hay.indexOf(t, from)
        if (at === -1) break
        hits += 1
        from = at + t.length
      }
    }
    return { rel: d.rel, hits }
  })
  return scored.sort((a, b) => b.hits - a.hits).map((d) => d.rel)
}

/**
 * 基线 2：只看**文件名**（很多 agent 会先 glob 文件名再挑）。
 * @param {object[]} docs - 文档
 * @param {string[]} terms - 查询词
 * @returns {string[]} 排好序的 rel 列表
 */
function rankByFileName(docs, terms) {
  const scored = docs.map((d) => ({
    rel: d.rel,
    hits: terms.reduce((n, t) => n + (d.rel.toLowerCase().includes(t) ? 1 : 0), 0),
  }))
  return scored.sort((a, b) => b.hits - a.hits).map((d) => d.rel)
}

/* ── 跑一轮 ─────────────────────────────────────────── */

/**
 * 在给定规模上比较三条路线。
 * @param {number} n - 语料篇数
 * @returns {object} 每条路线的 top-1 / top-3 / MRR
 */
export function runAt(n) {
  const { docs, cases } = buildCorpus(n)
  const NOW = 1_760_000_000_000
  const out = {}
  for (const name of ['Knit BM25', 'grep -c 计数', '只看文件名']) {
    // 按「文件名是否描述内容」分两组统计
    const groups = { 全部: cases, 文件名说得清: cases.filter((c) => c.descriptive), 文件名看不出: cases.filter((c) => !c.descriptive) }
    const m = {}
    for (const [gname, list] of Object.entries(groups)) {
      let top1 = 0
      let mrr = 0
      for (const c of list) {
        const keywords = extractKeywords([c.query], 30)
        const terms = keywords.map((k) => k.term).filter((t) => t !== PROJECT.toLowerCase())
        const order = name === 'Knit BM25'
          ? rankByRelevance(docs, keywords, NOW).docs.map((d) => d.rel)
          : name === 'grep -c 计数'
            ? rankByGrepCount(docs, terms)
            : rankByFileName(docs, terms)
        const pos = order.indexOf(c.want)
        const rank1 = pos < 0 ? 0 : pos + 1
        if (rank1 === 1) top1 += 1
        mrr += rank1 > 0 ? 1 / rank1 : 0
      }
      m[gname] = { n: list.length, top1: list.length ? top1 / list.length : 0, mrr: list.length ? mrr / list.length : 0 }
    }
    out[name] = m
  }
  return out
}

/* ── 主流程 ─────────────────────────────────────────── */

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const sizes = [20, 60, 180, 540]
  const pct = (x) => `${(x * 100).toFixed(0)}%`.padStart(4)
  console.log('语料：12 篇「主题文档」（短而聚焦，主题词出现 3 次）')
  console.log('      + 干扰文档（长，把每一条主题各提 5 次但哪件都没讲 —— 像 CHANGELOG）')
  console.log('      + 纯填充（长，只重复项目名）')
  console.log('      主题文档的文件名：一半描述内容、一半看不出内容（真实仓库两者都有）')
  console.log('用例：12 条「Knit 的 X 是怎么做的」，正确答案是对应那篇主题文档')
  console.log('基线：照抄真机日志里 agent 的做法（grep -c 数主题词，不含项目名），不算放水\n')
  for (const n of sizes) {
    const r = runAt(n)
    console.log(`── ${n} 篇 ` + '─'.repeat(52))
    console.log('路线          文件名说得清 top-1    文件名看不出 top-1    MRR(全部)')
    for (const [name, m] of Object.entries(r)) {
      console.log(`${name.padEnd(12)}  ${pct(m.文件名说得清.top1)} (${m.文件名说得清.n} 条)        `
        + `${pct(m.文件名看不出.top1)} (${m.文件名看不出.n} 条)         ${m.全部.mrr.toFixed(3)}`)
    }
    console.log('')
  }
}

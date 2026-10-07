/**
 * Knit 相关性排序 · 离线评测集
 *
 * 用途：给 `rankByRelevance` 一个**可重复、可对比**的质量刻度。
 * v0.6（BM25 + IDF）的目标就是让这个刻度明显高于 v0.5.2 的基线，
 * 并且此后任何改动都不许把它弄坏（PRD §6.1 / SDD §7.2）。
 *
 * 两条设计决定，都是为了「隔离出相关性本身」：
 *
 *  1. **所有文档共用同一个 mtimeMs。** 新鲜度因子 `(1 + 0.1·freshness)` 于是变成
 *     一个对所有文档相同的常数 —— 它不影响名次，评测测的就纯粹是相关性。
 *  2. **直接构造 `{haystack, mtimeMs}`，不走文件系统。** 被测对象是排序器，
 *     不是扫描器/解析器；把 I/O 与解析拉进来只会制造混淆变量。
 *     haystack 的口径严格照抄宿主（`src/host/index.js:237-239`）：
 *     **先截前 2500 字，再转小写**。
 *
 * 覆盖六类用例（PRD §6.1）：纯中文 / 纯英文技术词 / 中英混合 /
 * 高频词陷阱 / 长文档陷阱 / 退化场景，另加一条一次性罕见词（SDD §4.8）。
 */

/** 与宿主一致的正文截断长度。 */
const HAYSTACK_CHARS = 2500

/** 固定的「现在」，让评测完全确定（不受运行时间影响）。 */
export const NOW = 1_760_000_000_000

/**
 * 所有文档共用同一个 mtime —— 见文件头说明 1。
 * 取 `NOW - 60s`，保证新鲜度因子是一个固定的正数而不是 0。
 */
const SHARED_MTIME = NOW - 60_000

/**
 * 造一条文档记录，haystack 口径与宿主一致。
 * @param {string} rel - 工作区相对路径
 * @param {{title: string, summary?: string, body?: string}} text - 三段文本
 * @returns {object} 文档记录
 */
function doc(rel, { title, summary = '', body = '' }) {
  return {
    rel,
    path: rel,
    name: rel.split('/').pop(),
    size: body.length,
    mtimeMs: SHARED_MTIME,
    haystack: {
      title: title.toLowerCase(),
      summary: summary.toLowerCase(),
      body: body.slice(0, HAYSTACK_CHARS).toLowerCase(),
    },
  }
}

/**
 * 语料。
 *
 * 刻意让项目名 `knit` 与 `dsh` 出现在**几乎每一篇**里（高 df），
 * 这样「高频词污染」这个缺陷才有机会暴露出来：
 * 旧算法会给它们和别人一样的权重，于是满篇「knit」的 README 什么都赢。
 */
export const CORPUS = [
  doc('README.md', {
    title: 'Knit',
    summary: '把工作区最近的 Markdown 放到对话旁边，按相关性排序。零模型、零网络。',
    body: `
Knit 是 DeepSeek Harness（DSH）的一个插件。Knit 扫描当前会话工作区里的 Markdown 文档，
把 Knit 认为跟当前对话相关的那些放到侧边栏。Knit 不调用模型，Knit 也不联网。
安装 Knit：dsh plugin --profile web add dsh-knit。装完重启 DSH，然后硬刷新浏览器。
Knit 支持文档、图片与视频三类。Knit 的面板可以在文件与媒体之间切换。
本段刻意重复插件名：knit knit knit dsh dsh 插件 插件 文档 文档 工作区 工作区。
Knit 的目标用户是每天产出很多 Markdown 的人。Knit 的定位是项目级的文档导航层。
    `,
  }),

  doc('CHANGELOG.md', {
    title: 'Knit 变更记录',
    summary: 'Knit 的版本变更记录。',
    body: `
Knit 0.5.2 阅读态与灰底降档。Knit 0.5.1 测试不再依赖目录布局。Knit 0.5.0 图片与视频、类型切换、媒体就地预览。
Knit 0.4.0 第一版：侧边栏列出最近的 Markdown。Knit 修复了路径越界、键盘导航、主题令牌等若干问题。
这次还调整了 Knit 的发布流程、npm 打包内容、市场条目描述与截图。
    `,
  }),

  doc('docs/relevance-algorithm.md', {
    title: '相关性排序算法',
    summary: '对话关键词与文档打分：加权命中、IDF、BM25 饱和与长度归一化。',
    body: `
Knit 的相关性排序分三步。第一步从当前会话最近六条消息里抽关键词：英文词按原样取，中文按 2-gram 与 3-gram 近似，
再按出现次数与词长排序、贪心去重叠。第二步给每篇文档算加权命中：标题权重最高，摘要次之，正文再次。
第三步按分数降序，并在分数相同时用 mtime 兜底 —— 也就是 tie 到同一分时，改动更新的那篇排前面。

每篇文档最终对外给出的 score 是零到一百的整数，由本次最高分归一化而来；
排序依据不足时 score 为 null。名次本身才是答案，界面上不显示 score。

Knit 这套打分的已知缺陷是**没有 IDF**：一个在语料里到处都是的词（比如项目名）和罕见词拿到同样的权重，
于是高频词不产生任何区分度。第二个缺陷是**没有长度归一化**：长文档天然命中次数多，靠堆词就能赢。
第三个缺陷是命中次数被硬性封顶，饱和曲线是拍的而不是算出来的。

Knit v0.6 的修法是把加权命中换成 BM25：引入语料级 df 统计得到 IDF，用 k1 控制词频饱和、
用 b 控制长度归一化，字段权重仍是标题大于摘要大于正文。全程仍然是零模型、零网络、零依赖的字符串运算。
    `,
  }),

  doc('docs/media-browse.md', {
    title: '图片与视频浏览',
    summary: '方形缩略图网格、最少三列、一屏八个基准、视频取首帧当海报。',
    body: `
Knit 的媒体视图把图片与视频铺成方形缩略图网格。列数最少三列，面板变宽才加列，格子边长六十四像素起步。
一屏基准八个，超过八个不隐藏，而是整块等比缩小，此时卡片文字让位给缩略图。
视频用 video 标签的 preload metadata 让浏览器自己解出首帧当海报，中间叠播放三角，右下角叠时长角标，
零依赖、零转码、宿主不解析容器格式。点开图片看大图，点开视频可以播放和拖动进度，
视频走 HTTP Range 流式取字节，不会全量下载。图片的扩展名白名单包含 png jpg gif webp avif，
视频包含 mp4 webm mov。单张图片上限十二兆，单个视频上限二百五十六兆。
Knit 按扩展名放行媒体，不解析画面内容。
    `,
  }),

  doc('docs/release-checklist.md', {
    title: '发布清单',
    summary: 'npm 发布、版本号、打包内容、市场收录与截图。',
    body: `
Knit 发布前先跑测试并确认全绿，再核对版本号、确认没有 private 字段、确认 dsh 的 bundle patch 声明存在、
确认包名在 package json 与 cordis patch yml 里一致。用 npm pack 的 dry run 看打包内容与体积。
发布 Knit 到 npm 与 GitHub 之后，再提交市场收录的 pull request，附上中英双语描述与截图。
市场收录是人工合并的，要盯着队列。dshfind 那个目录是按 GitHub topic 自动爬的，
记得给 Knit 的仓库打上 dsh-plugin 标签。
    `,
  }),

  doc('docs/competitor-research.md', {
    title: '竞品调研',
    summary: '插件市场的竞争格局、下载量分布与差异化判断。',
    body: `
Knit 所在的插件市场里总数三千多，其中有 npm 包的接近一半，剩下的一半下载量统计不到。
文档类目的头部全是 office、pdf、ppt、流程图这类生成工具；记忆类目又深又热，头部有五万多下载，
而且那批插件做的是可检索的项目文档、语义召回与侧栏界面，和 Knit 的文档导航直接相邻。
Knit 真正的差异化只剩两条：扫描范围是整个项目工作区，以及排序跟着对话走。
风险是没有护城河，而且需求本身还没有被验证 —— 竞品里最像 Knit 的那个星标只有二，下载是零。
    `,
  }),

  doc('docs/path-safety.md', {
    title: '路径越界防护',
    summary: '读文件接口的沙箱边界、扩展名白名单与响应头。',
    body: `
Knit 按路径读文件的接口必须守住两条边界。第一条：路径解析之后必须落在会话工作区之内，
任何越界一律拒绝，包括目录穿越、绝对路径逃逸和符号链接绕行。第二条：扩展名白名单，
只放行图片与视频，图片上限十二兆、视频上限二百五十六兆。只允许 GET，只允许回环地址访问。
响应必须带 nosniff 与 default-src none sandbox。Knit 新增任何读文件的路由都要照抄这两条防护。
    `,
  }),

  doc('docs/keyboard-nav.md', {
    title: '键盘导航',
    summary: '上下键移动即预览、回车切换、Esc 收起。',
    body: `
Knit 面板的键盘导航用上下方向键在列表里移动，移动即预览，不需要再按一次。回车切换当前项的展开与收起。
Esc 收起预览，如果焦点在过滤框里则先清空过滤词。顶部与底部会停住，不循环。
Knit 的焦点环用中性的描边，不用品牌色。
    `,
  }),

  doc('docs/theme-tokens.md', {
    title: '主题令牌',
    summary: '品牌色、中性灰、分层表面与明暗两套值。',
    body: `
Knit 面板里的强调色只允许有一个来源，绑定到 DSH 的品牌主色令牌，浅色与暗色各一套，随主题切换。
表面分层不能用 layer 系列，浅色主题下那三个令牌解析出来全是白色，做不出层级；
要用 module platform 那个令牌。半透明的灰底要在 DSH 默认档上降一档，
悬停保留四成、选中保留六成 —— 默认那档灰色太深，读文档时对比度被吃掉。
不要自己用 color mix 混色，旧内核下整条声明会失效。
Knit 里变量必须先定义再引用，缺了会静默少一块样式。
    `,
  }),

  doc('docs/api-contract.md', {
    title: '接口契约',
    summary: 'recent 与 doc 两个路由的响应字段与错误码。',
    body: `
Knit 列表接口的响应里，文档记录包含 kind、path、rel、name、title、summary、size、mtimeMs 与 score。
score 在没有排序依据时为 null，否则是零到一百的整数。响应顶层还有 mode、topic、keywords、
total 与 truncated。Knit 读正文的接口只接受工作区内的相对路径，越界返回错误码而不是文案。
Knit 的宿主只返回错误码，面向用户的文字全部由客户端词典翻译。
    `,
  }),

  // 长文档陷阱：很长、把很多话题词各提一次，但哪一件都没讲清楚。
  doc('docs/long-archive.md', {
    title: 'Knit 归档长文',
    summary: 'Knit 的历史归档，涵盖许多话题。',
    body: `
这是 Knit 的一篇很长的归档文档，里面什么都会提一句。相关性排序提到了一次。图片与视频浏览提到了一次。
发布清单提到了一次。竞品调研提到了一次。路径越界防护提到了一次。键盘导航提到了一次。
主题令牌提到了一次。接口契约提到了一次。悬停浮层提到了一次。缩略图网格提到了一次。
市场下载量提到了一次。版本号提到了一次。扩展名白名单提到了一次。焦点环提到了一次。
颜色令牌提到了一次。错误码提到了一次。工作区扫描提到了一次。摘要截断提到了一次。
为了制造长度，下面这段重复但不含新话题词：
${'Knit 归档归档归档归档归档归档归档归档归档。'.repeat(60)}
    `,
  }),

  // 短文档陷阱的「正解」：短，但整篇都在讲一件事。
  doc('docs/peek-overlay.md', {
    title: '悬停浮层',
    summary: 'Knit 悬停入口按钮偷看最近五篇。',
    body: `
Knit 的悬停入口按钮会弹一个只读浮层，列出最近五篇文档。浮层是自己画的，不碰框架布局，所以不会把页面推开。
点击浮层里的某一篇才真正进入右边栏并预览那一篇。浮层有延迟显示与延迟收起，避免鼠标掠过时闪。
Knit 浮层里的点击是即时响应的，不走列表接口，也不等轮询。
    `,
  }),

  // 媒体记录：haystack 只有文件名，summary 与 body 恒为空 —— 用来验证排序器不炸。
  {
    rel: 'docs/knit-screenshot.png',
    path: 'docs/knit-screenshot.png',
    name: 'knit-screenshot.png',
    kind: 'image',
    size: 4096,
    mtimeMs: SHARED_MTIME,
    haystack: { title: 'knit-screenshot.png', summary: '', body: '' },
  },

  // 一次性罕见词：整个语料里只有这一篇含它。
  doc('docs/one-off.md', {
    title: '临时记录',
    summary: 'Knit 的一段临时笔记。',
    body: `
这里记了 Knit 的一个只在本次对话里出现过的记号 zqxwv，别的地方都没有。除此之外这篇没有别的内容。
    `,
  }),

  doc('notes/short-note.md', {
    title: '随手记',
    summary: '很短的一条。',
    body: 'Knit 记得把缩略图网格的列数上限再确认一遍。',
  }),
]

/**
 * 造一条**代码**记录，haystack 口径严格照抄宿主的 `readCode()`
 * （`src/host/index.js:346-359`）：
 *
 * ```text
 * filename → title   （权重 ×4）
 * path     → summary （权重 ×2，保留结尾斜杠）
 * content  → body    （权重 ×1，前 HAYSTACK_CHARS 字）
 * ```
 *
 * `title` 是**带扩展名的文件名**，不是去扩展名的 stem —— 代码的文件名里扩展名本身
 * 就是信息（`plugin-loader.js` vs `plugin.json`），去掉它反而丢掉最能把两个候选
 * 分开的那几个字符。
 *
 * 为什么要有这个工厂：v0.19 的 `CODE_CASES` 必须验的是「同一个 `rankByRelevance`
 * 在文档与代码混合的语料上怎么排」，而不是另写一套排序器。所以**代码条目和文档条目
 * 走完全相同的 `{rel, haystack, mtimeMs}` 形状**，只是三段文本的来源不同。
 *
 * @param {string} rel - 工作区相对路径
 * @param {string} head - 文件开头的内容（会被截到 `HAYSTACK_CHARS`）
 * @param {string} [kind] - 产物类型，默认 `'code'`
 * @returns {object} 语料记录
 */
function codeDoc(rel, head, kind = 'code') {
  const name = rel.split('/').pop()
  const cut = rel.lastIndexOf('/')
  const dir = cut >= 0 ? rel.slice(0, cut + 1) : ''
  return {
    rel,
    path: rel,
    name,
    kind,
    size: head.length,
    mtimeMs: SHARED_MTIME,
    haystack: {
      title: name.toLowerCase(),
      summary: dir.toLowerCase(),
      body: head.slice(0, HAYSTACK_CHARS).toLowerCase(),
    },
  }
}

/**
 * v0.19 新增的**文档**候选（只给混合场景用，不进 `CORPUS`）。
 *
 * 单独一份的理由：`CORPUS` 是 v0.6 起就被 21 条用例钉住的基线，往里加一篇
 * 就是在动历史刻度。Case C 需要一篇「相关但排在代码后面」的文档候选，
 * 于是把它放进 v0.19 自己的池子里 —— 两个对比臂（只 Markdown / Markdown+Code）
 * **都含它**，所以它不会变成某一臂的额外优势。
 */
export const V019_DOCS = [
  doc('docs/architecture.md', {
    title: '架构分层',
    summary: '扫描 → 分类 → 检索 → Context Pack 的分层与职责边界。',
    body: `
这份设计文档说明 knit 的分层：workspace scan 只负责找到文件，file classification
决定一个文件算文档、代码还是媒体，retrieval 用 BM25 在当前任务与候选之间排序，
最后装配成 Context Pack 的三层。分层之间只通过 artifact.kind 传递，不许互相偷看。

session context 的装配属于 retrieval 之后的一步：把检索结果按 primary / supporting /
related 分组，再冻结成一次 context epoch。session 的持久化不在这份文档的范围里，
它由 session-store 负责。架构上刻意不引入 embedding 与向量库，检索保持纯本地确定性。
    `,
  }),
]

/**
 * v0.19 的代码语料 —— 三个真实 AI Coding 场景。
 *
 * 刻意让**不相关的东西也留在池子里**（`CORPUS` 那 16 篇文档全在），因为要回答的
 * 问题不是「代码能不能排第一」，而是：
 *
 * > 把代码放进同一个 BM25 池子之后，**原有文档的检索质量会不会被挤坏**。
 *
 * 那只有在真竞争里才量得出来。
 */
export const CODE_CORPUS = [
  // ── Case A：React / TypeScript ──────────────────────────
  codeDoc('src/components/Component.tsx', `
import React, { useState, useEffect } from 'react'

/**
 * 任务面板。父级把 state 传下来，这里同步到本地 draft。
 * bug：父级 state 变了，这个组件 render 之后还是旧值。
 */
export function Component({ task, onChange }) {
  const [draft, setDraft] = useState(task.title)

  useEffect(() => {
    // 同步不上的地方：依赖数组是空的，只在 mount 时跑一次，
    // 父级后续的 props 改动被整个丢掉了。
    setDraft(task.title)
  }, [])

  const onInput = (event) => {
    setDraft(event.target.value)
    onChange(event.target.value)
  }

  return <input value={draft} onChange={onInput} />
}
`),
  codeDoc('src/state/state.ts', `
/**
 * 任务状态。组件之间的状态同步都要经过这里，不许各存一份。
 */
export interface TaskState {
  title: string
  dirty: boolean
}

export const initialState: TaskState = { title: '', dirty: false }

export function reducer(state: TaskState, action: { type: string, value?: string }) {
  switch (action.type) {
    case 'title': return { ...state, title: action.value || '', dirty: true }
    default: return state
  }
}
`),
  codeDoc('src/hooks/hooks.ts', `
import { useEffect, useRef, useState } from 'react'

/** 把外部值同步进本地 state —— 依赖数组必须带上外部值本身。 */
export function useSyncedValue(external) {
  const [value, setValue] = useState(external)
  useEffect(() => { setValue(external) }, [external])
  return [value, setValue]
}

/** 去抖，避免每次按键都 render 父级。 */
export function useDebounced(value, ms = 200) {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), ms)
    return () => clearTimeout(id)
  }, [value, ms])
  return debounced
}
`),

  // ── Case B：Node / JavaScript ───────────────────────────
  codeDoc('src/plugin/plugin-loader.js', `
/**
 * plugin loader：扫插件目录、读 metadata、注册到 loader 表。
 * 新增的 metadata 字段在这里认不出来，于是被静默丢掉。
 */
export async function loadPlugin(dir) {
  const metadata = await readMetadata(dir)
  if (!metadata || !metadata.name) {
    throw new Error('metadata.name is required')
  }
  return { ...metadata, dir, loaded: true }
}

export async function loadAll(root) {
  const dirs = await listPluginDirs(root)
  const out = []
  for (const dir of dirs) out.push(await loadPlugin(dir))
  return out
}
`),
  codeDoc('src/plugin/plugin.ts', `
/** 插件的运行时形状，以及 loader 认得的 metadata 字段。 */
export interface PluginMetadata {
  name: string
  version?: string
  main?: string
}

export interface Plugin extends PluginMetadata {
  dir: string
  loaded: boolean
}

export interface PluginLoader {
  loadPlugin(dir: string): Promise<Plugin>
  loadAll(root: string): Promise<Plugin[]>
}
`),
  codeDoc('src/plugin/metadata.js', `
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

/** 读 plugin.json —— loader 只认这里的字段，别处的一律忽略。 */
export async function readMetadata(dir) {
  try {
    const raw = await readFile(join(dir, 'plugin.json'), 'utf8')
    const parsed = JSON.parse(raw)
    return typeof parsed === 'object' && parsed !== null ? parsed : null
  } catch {
    return null
  }
}
`),

  // ── Case C：混合上下文（文档 + 代码竞争同一层）──────────
  codeDoc('src/context/context-manager.ts', `
/**
 * session context 的装配：把检索结果按 primary / supporting / related 分组，
 * 再冻结成一次 context epoch。所有对 session 的读写都要经过这里。
 */
export function assembleContext(session, ranked) {
  const primary = ranked.filter((entry) => entry.score >= HIGH)
  const supporting = ranked.filter((entry) => entry.score >= MID && entry.score < HIGH)
  const related = ranked.filter((entry) => entry.score < MID)
  return { session: session.id, primary, supporting, related, epoch: session.epoch + 1 }
}
`),
  codeDoc('src/context/session-store.ts', `
/**
 * session 的持久化层。只存 id / epoch / 已读证据，不存任何检索中间结果。
 */
export function saveSession(store, session) {
  store.set(session.id, { id: session.id, epoch: session.epoch, reads: session.reads })
  return store.get(session.id)
}

export function loadSession(store, id) {
  return store.get(id) || null
}
`),
]

/**
 * v0.19 必须**一个都不准进语料**的生成 / 噪声产物（需求 §6 §7 §35）。
 *
 * 这张表有两个消费方，所以放在这里而不是某个测试里：
 *
 *  1. `code-context.test.mjs` 拿它去**真实扫描**一个临时工作区，断言这 7 条
 *     在候选里一个都找不到（这是「verification」，不是「说明」）。
 *  2. 基准里用它算 noise rate —— 只要有一条出现在代码用例的 top-1，
 *     这个数就不再是 0。
 *
 * 注意 `node_modules` / `dist` / `coverage` 三条**同时**会被既有的 `SKIP_DIRS`
 * 挡掉：所以它们验的是「目录级排除仍然生效」，而 `app.min.js` / `bundle.generated.js`
 * / `app.js.map` / `package-lock.json` 验的是「新增的 code-specific noise 规则生效」。
 * 两层都要有，因为任意一层接手都不会让它们漏进来 —— 但测出来必须是零。
 */
export const NOISE_RELS = [
  'node_modules/foo.js',
  'dist/app.js',
  'coverage/report.js',
  'app.min.js',
  'bundle.generated.js',
  'app.js.map',
  'package-lock.json',
]


/**
 * 用例。
 *
 * `expect` 是**期望的 top-1**。
 * `notTop` 是**必须不能排第一**的文档 —— 专门用来钉死两个陷阱：
 * 满篇项目名的 README、以及什么话题都提一句的归档长文。
 * `expectTop3` 用来表达「排在前面就行」的弱断言（MRR 会自然反映）。
 */
export const CASES = [
  // ── 纯中文 ────────────────────────────────────────────
  {
    name: '中文：问排序怎么算',
    messages: ['相关性排序到底是怎么算出来的？', '我看不懂它凭什么把这篇排第一'],
    expect: 'docs/relevance-algorithm.md',
    notTop: ['README.md', 'docs/long-archive.md'],
  },
  {
    name: '中文：问 IDF 和长度归一化',
    messages: ['没有 IDF 的话高频词不就没区分度了吗', '还有长度归一化也缺'],
    expect: 'docs/relevance-algorithm.md',
    notTop: ['README.md'],
  },
  {
    name: '中文：问图片视频怎么展示',
    messages: ['图片和视频在面板里怎么展示的', '缩略图网格几列、视频首帧怎么来的'],
    expect: 'docs/media-browse.md',
    notTop: ['docs/long-archive.md'],
  },
  {
    name: '中文：问视频要不要转码',
    messages: ['视频要转码吗？还是浏览器直接解首帧', '网格最多几列'],
    expect: 'docs/media-browse.md',
  },
  {
    name: '中文：问发布流程',
    messages: ['这版发之前要检查什么', 'npm 打包内容和市场收录的顺序是什么'],
    expect: 'docs/release-checklist.md',
  },
  {
    name: '中文：问越界防护',
    messages: ['读文件的接口怎么防止目录穿越', '扩展名白名单都放行什么'],
    expect: 'docs/path-safety.md',
    notTop: ['README.md'],
  },
  {
    name: '中文：问键盘操作',
    messages: ['面板里能用键盘吗', '上下键和 Esc 分别干什么'],
    expect: 'docs/keyboard-nav.md',
  },
  {
    name: '中文：问颜色令牌',
    messages: ['这个灰色太深了，读文档对比度不够', '表面分层该用哪个令牌'],
    expect: 'docs/theme-tokens.md',
  },

  // ── 纯英文技术词 ───────────────────────────────────────
  {
    name: '英文：HTTP Range',
    messages: ['does the video use HTTP Range for streaming', 'preload metadata only'],
    expect: 'docs/media-browse.md',
    notTop: ['README.md'],
  },
  {
    name: '英文：nosniff 与 sandbox',
    messages: ['the response should carry nosniff and default-src none sandbox'],
    expect: 'docs/path-safety.md',
  },
  {
    name: '英文：mtime 兜底',
    messages: ['when scores tie, does it fall back to mtime'],
    expect: 'docs/relevance-algorithm.md',
  },

  // ── 中英混合 ──────────────────────────────────────────
  {
    name: '混合：score 字段语义',
    messages: ['recent 接口里的 score 什么时候是 null', 'mode 有哪几种取值'],
    expect: 'docs/api-contract.md',
  },
  {
    name: '混合：BM25 的 k1 和 b',
    messages: ['用 BM25 的话 k1 和 b 取多少合适', '标题权重还是最高的吗'],
    expect: 'docs/relevance-algorithm.md',
  },

  // ── 高频词陷阱：对话里塞满项目名 ────────────────────────
  {
    name: '陷阱：满口项目名，问的是排序',
    messages: [
      'knit 这个插件挺好用的，但是 knit 的排序我不是很懂',
      'knit 为什么把这篇放第一？knit 的排序依据是什么',
    ],
    expect: 'docs/relevance-algorithm.md',
    notTop: ['README.md', 'CHANGELOG.md', 'docs/long-archive.md'],
  },
  {
    name: '陷阱：满口项目名，问的是安全',
    messages: [
      'knit 的接口安全吗？knit 会不会被目录穿越打穿',
      'knit 读文件的时候 knit 有没有做越界检查',
    ],
    expect: 'docs/path-safety.md',
    notTop: ['README.md', 'CHANGELOG.md'],
  },

  // ── 长文档陷阱：正解是短文档，干扰项是长归档 ────────────
  {
    name: '陷阱：话题只在长归档里提了一句',
    messages: ['悬停浮层是怎么做的，会不会把页面推开', '点浮层里的东西是即时的吗'],
    expect: 'docs/peek-overlay.md',
    notTop: ['docs/long-archive.md', 'README.md'],
  },
  {
    name: '陷阱：短笔记对长归档',
    messages: ['缩略图网格的列数上限再确认一下'],
    expect: 'notes/short-note.md',
    notTop: ['docs/long-archive.md'],
  },

  // ── 中文 n-gram 细分 ───────────────────────────────────
  {
    name: '中文：归档与竞品',
    messages: ['竞品里下载量最高的是哪一类插件', 'star 和下载量哪个更能说明问题'],
    expect: 'docs/competitor-research.md',
    notTop: ['README.md'],
  },
  {
    name: '中文：变更历史',
    messages: ['上一版改了什么', '阅读态是哪个版本加的'],
    expect: 'CHANGELOG.md',
    notTop: ['docs/long-archive.md'],
  },
  {
    name: '中文：暂存笔记',
    messages: ['把临时记的那个记号找出来', 'zqxwv 写在哪个文件里'],
    expect: 'docs/one-off.md',
    notTop: ['README.md'],
  },

  // ── 一次性的罕见词（SDD §4.8 的观察项）────────────────
  {
    name: '观察：罕见词是否会失控',
    messages: ['zqxwv 这个东西是什么'],
    expect: 'docs/one-off.md',
  },
]

/**
 * v0.19 的代码用例 —— 需求 §34 点名的三个真实 AI Coding 场景。
 *
 * 标注口径与 `CASES` 完全相同（`expect` ＝ 期望的 top-1），**不新增一套标注格式**：
 * 二元标注够用，因为要回答的问题是「这块上下文有没有被找出来」，
 * 而不是「它比第二名好多少」。
 */
export const CODE_CASES = [
  {
    name: 'V0.19-A React/TS：组件状态同步',
    messages: [
      '修复当前任务中的 React 组件状态同步问题',
      'Component 里的 state 跟父级不同步，重新 render 之后还是旧值',
    ],
    expect: 'src/components/Component.tsx',
    // 这四条是「任务里根本没提到、但池子里有的东西」——
    // 架构文档、变更日志、临时笔记都不该赢过一个正在报 bug 的组件。
    notTop: ['docs/architecture.md', 'CHANGELOG.md', 'docs/one-off.md', 'docs/long-archive.md'],
  },
  {
    name: 'V0.19-B Node/JS：plugin loader 的 metadata',
    messages: [
      '修改 plugin loader，使它支持新的 plugin metadata',
      'loader 读 metadata 的时候认不出新加的那个字段',
    ],
    expect: 'src/plugin/plugin-loader.js',
    notTop: ['docs/architecture.md', 'README.md', 'docs/long-archive.md'],
  },
  {
    name: 'V0.19-C 混合：session context 的实现',
    messages: [
      '根据项目设计修改 session context 实现',
      'context 的装配逻辑跟 session 的存储对不上',
    ],
    expect: 'src/context/context-manager.ts',
    notTop: ['README.md', 'docs/long-archive.md', 'docs/one-off.md'],
  },
]

/**
 * v0.19 的两个对比臂 —— **同一个语料形状，只差一个代码语料**。
 *
 * 这样「Markdown only vs Markdown + Code」就不是两次不同实验的比较，
 * 而是同一池子加料前后的差值，唯一变量就是代码。
 */
export const V019_MD_ONLY = [...CORPUS, ...V019_DOCS]
export const V019_WITH_CODE = [...V019_MD_ONLY, ...CODE_CORPUS]

/**
 * 跑一遍评测。
 *
 * @param {(messages: string[], limit?: number) => Array<{term: string, weight: number}>} extract -
 *   关键词抽取（注入真实实现，便于新旧对比）
 * @param {(docs: object[], keywords: object[], now: number) => {docs: object[]}} rank -
 *   排序（注入真实实现）
 * @param {object[]} [corpus] - 语料；默认 `CORPUS`。
 *   v0.19 新增这个口子是为了量「同一个排序器在只 Markdown 与 Markdown+Code 上的差」——
 *   代码条目与文档条目走**完全相同的** `{rel, haystack, mtimeMs}` 形状，
 *   所以不值得（也不允许）为代码另写一个评测器。
 * @param {object[]} [cases] - 用例；默认 `CASES`
 * @returns {{total: number, top1: number, top1Rate: number, mrr: number,
 *   misses: Array<{name: string, got: string, want: string}>,
 *   trapViolations: Array<{name: string, offender: string}>,
 *   degenerate: number, ranks: number[]}} 评测结果
 */
export function runEval(extract, rank, corpus = CORPUS, cases = CASES) {
  let top1 = 0
  let mrrSum = 0
  let degenerate = 0
  const misses = []
  const trapViolations = []
  const ranks = []

  for (const testCase of cases) {
    const keywords = extract(testCase.messages, 30)
    const { docs: ranked } = rank(corpus, keywords, NOW)
    const order = ranked.map((d) => d.rel)
    const position = order.indexOf(testCase.expect)
    // 名次从 1 开始；找不到记为 0（对 MRR 没有贡献）
    const rank1 = position === -1 ? 0 : position + 1
    ranks.push(rank1)
    mrrSum += rank1 > 0 ? 1 / rank1 : 0
    if (rank1 === 1) top1 += 1
    else misses.push({ name: testCase.name, got: order[0] || '(空)', want: testCase.expect })

    // 退化排序：只有一篇有分、其余全 0。名次就没有信息量了 ——
    // 这种情况必须被看见，否则「提升」可能只是语料没配对。
    if (ranked.filter((d) => d.raw > 0).length <= 1) degenerate += 1

    for (const offender of testCase.notTop || []) {
      if (order[0] === offender) trapViolations.push({ name: testCase.name, offender })
    }
  }

  return {
    total: cases.length,
    top1,
    top1Rate: top1 / cases.length,
    mrr: mrrSum / cases.length,
    misses,
    trapViolations,
    degenerate,
    ranks,
  }
}

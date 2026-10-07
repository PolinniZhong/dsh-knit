/**
 * Knit · 浏览器半边
 *
 * 在两个宿主上注册同一个「最近文档」面板：
 *   1. DSH 自带右侧栏（@deepseek-ai/dsh-client-ui-sidebar-right）—— 主路径
 *   2. dsh-better-sidebar 的 ctx.betterSidebar.registerTab —— 可选，吃到它那批用户
 *
 * 面板本身：列表（相关性或 mtime 排序 + 过滤 + 键盘导航）+ 列表下方的就地预览。
 * 两个宿主共用同一个 KnitBody，只在「怎么开新标签页」上用适配器分叉。
 *
 * 构建：无。手写脚本，由 __ModuleLoader__ 直接装载，用 React.createElement 而非 JSX。
 */
window.__ModuleLoader__.load({
  id: 'dsh-knit',
  factory: (require) => {
    const module = { exports: {} }
    const React = require('react')
    const h = React.createElement

    /* ── 国际化（DSH 官方 ctx.locale）─────────────────── */

    /** 本插件在 DSH locale 注册表里的命名空间。 */
    const NS = 'knit'

    /** 中文词典（源语言）。 */
    const ZH = {
      'type.label': 'Knit',
      'guide.title': 'Knit 最近文档',
      'guide.description': '按对话相关性排序，点开就地预览',
      'entry.label': 'Knit 最近文档',

      'count': '{n} 篇',
      'count.filtered': '{hit} / {total} 篇',
      'count.code': '{n} 个代码文件',
      'count.code.filtered': '{hit} / {total} 个代码文件',
      'count.media': '{n} 个媒体',
      'count.media.filtered': '{hit} / {total} 个媒体',
      'count.all': '{n} 项',
      'count.all.filtered': '{hit} / {total} 项',
      'action.refresh': '刷新',
      'path.openTitle': '在文件管理器中打开',
      'peek.empty': '这个工作区里还没有 Markdown 文档。',
      'action.refreshNow': '立即刷新',

      'sort.relevance': '相关',
      'sort.time': '最新',
      'sort.relevanceTitle': '按与当前对话的相关性排序（纯本地关键词匹配，不调模型）',
      'sort.timeTitle': '按文件修改时间倒序',

      'kind.all': '全部',
      'kind.doc': '文档',
      // v0.19：「代码」这一档。文案口径刻意保持朴素 —— 不写「代码知识库 / AI Code
      //   Intelligence / 智能代码分析」。Knit 只是把**当前任务真正需要的**代码文件
      //   纳入同一份 Context Pack，它不是代码浏览器、不是 grep、不是 IDE（需求 §44）。
      'kind.code': '代码',
      // ⚠️ 2026-10-06 用户定：类型页签与「全部」分区标题都用**「媒体」**，不用「图片与视频」
      //    （原话：「我想修改成 媒体 或者 多媒体，你觉得呢？」→ 随后确认「媒体」）。
      //    理由：① 这一档的计数本来就是「{n} 个媒体」（count.media），页签叫「图片与视频」
      //    是唯一的例外；② 「多媒体」在中文 IT 语境里带 AV / 课件味，还暗示音频，而这一档
      //    只扫图片与视频（宿主按扩展名放行，没有音频）；③ 「媒体」省 3 个字，窄侧栏少一次
      //    省略号。**含义由空态说明**（list.emptyMedia 仍写「还没有图片或视频」）。
      'kind.media': '媒体',
      'kind.title': '切换要列出的产物类型',

      'filter.placeholder': '过滤文档',
      'filter.aria': '过滤文档',

      'usage.toggle': '使用情况',
      'usage.toggleTitle': '打开后开始统计这个会话：先看的那篇有没有被读、有多少次读落在包外、上下文换过几回。只记事实，不给分数。',
      'usage.none': '还没有记录',
      'usage.note': '只统计本会话 · 数据在内核内存里，重启 DSH 就没了',

      // ── v0.18 Context Usage Lens ────────────────────────────────
      // 这一层只回答一件事：「Knit 交出去的那份 Context，被怎样消费了」。
      // ⚠️ 它**不是** Dashboard：没有 KPI 大数字、没有百分比、没有评分、没有图表、
      //    没有进度条、没有「使用率 / 健康度 / 认可度」。字号一律弱于文档标题 ——
      //    层级只靠空间与灰阶（AGENTS.md §6.3 / §7.1）。
      // ⚠️ 每一条都是**事实陈述**，不是评价：不许写成「Agent 没看这篇 / 用错了 /
      //    Knit 漏了 / 推荐得不准」。「最近读取」也不是「正在阅读」—— 证明不了。
      'lens.title': '使用情况',
      'lens.expand': '展开使用情况',
      'lens.collapse': '收起使用情况',
      'lens.epoch': 'Epoch {n}',
      'lens.reads': '{n} 次读取',
      'lens.outside': '{n} 篇包外',
      'lens.changes': '上下文变化 {n} 次',
      'lens.currentContext': '当前上下文',
      'lens.recentRead': '最近读取',
      'lens.recentNone': '暂无记录',
      'lens.outsideDocs': '上下文外读取',
      'lens.more': '还有 {n} 篇',
      'lens.openDoc': '打开 {rel}',
      'lens.delta': '上下文变化',
      'lens.locate': '定位到{tier}上下文',
      // 读屏专用（md §六十三）：**屏幕上不出现这句话**，视觉给的是「层名 + n / m + 圆点」。
      'lens.coverageAria': '{tier}上下文：{read} / {total} 篇已读',
      // 上下文变化那一行的右侧说明（md §三十八「上下文变化　最近一次 ›」）：
      // 变化永远只说**最近一次**，所以这里不写条数（条数由展开后的行数承担）。
      'lens.deltaLatest': '最近一次',

      // ── v0.17 文档生命周期（Document Lifecycle）──────────────────
      // ⚠️ 四态全是**事实**，不是评价：「读后已更新」只说「文件在最后一次成功读取之后
      //    变过」，绝不许写成「Agent 还不知道最新版本」「Agent 用了旧版本」这类推断。
      // ⚠️ 「上下文外读取」只陈述「这篇不在当前包内、但被成功读过」。
      // ⚠️ `readCountShort` 是给行尾用的：行首的 glyph 已经说了「读过了」，
      //    行尾只需要补一个「几次」—— 再说一遍「已读」是重复信息。
      'usage.deltaEnter': '进入',
      'usage.deltaLeave': '离开',
      'usage.deltaMove': '换层',
      'usage.deltaTask': '任务上下文已更新',
      'usage.deltaMore': '还有 {n} 条',
      'lifecycle.unread': '未读',
      'lifecycle.read': '已读',
      'lifecycle.readCount': '已读 ×{n}',
      'lifecycle.readCountShort': '×{n}',
      'lifecycle.updatedAfterRead': '读后已更新',
      'lifecycle.rereadAfterUpdate': '修改后已重新读取',
      'tierName.primary': '主要',
      'tierName.supporting': '辅助',
      'tierName.related': '相关',

      // ── v0.14 当前任务上下文（Context Pack）──────────────────────
      // ⚠️ 文案纪律：不出现「AI / 智能 / 推荐 / 置信度 / 百分比」。
      // 这一层是确定性规则算出来的，说成 AI 就是在骗用户。也不能放表情符号
      // （test/i18n.test.mjs 有守卫）。
      // ⚠️ 这里只剩**分组**与**理由**的文案（2026-09-29）：右栏那个
      // 「当前任务上下文」面板整个删掉了 —— Context Pack 是**数据层**结构
      // （Primary / Supporting / Related），不是一张要单独显示的卡片。
      // 所以 `context.title` / `matched` / `task*` / `evidence*` / `ev*` /
      // `float` / `dock` / `dragHint` / `gripAria` 这些词条一起删了：
      // 不留在词典里当死键，否则下一个人会以为那个面板还在。
      'context.primary': '主要上下文',
      'context.supporting': '辅助上下文',
      'context.related': '相关上下文',
      'context.other': '其他相关文档',
      // 提示词**极短**（用户要求）：长副标题会把分组标题读成说明文。
      'context.primaryHint': '先看',
      'context.supportingHint': '辅助',
      'context.relatedHint': '背景',
      'context.why': '为什么在这里',
      // 理由码 → 文案。宿主只给码（AGENTS.md §4.5），翻译在这里。
      // ⚠️ 2026-09-29 用户要求把这行压得更克制：原来是「直接命中当前话题：…」，
      // 读起来像调试信息。现在它是**标签 + 值**，词之间用「 · 」分隔。
      'why.direct': '直接命中：{term}',
      'why.titleMatch': '标题命中：{term}',
      // v0.19：代码占的是 `title` / `summary` 两个槽位（文件名、所在目录），
      // 但**不能**对 `.ts` 文件说「标题命中」—— 判据一样，称谓必须分开。
      // 这两个码由宿主直接给出（`context.js` 的 `explainContext()`），
      // 客户端不做 kind → key 的重映射：宿主给什么码就翻什么码。
      'why.filenameMatch': '文件名命中：{term}',
      'why.pathMatch': '路径命中：{term}',
      'why.summaryMatch': '摘要命中：{term}',
      'why.bodyMatch': '正文命中：{term}',
      'why.bodyMatchPlain': '正文命中',
      'why.linkTarget': '被主要上下文引用',
      'why.linkSource': '引用了主要上下文',
      'why.related': '与当前任务相关',

      'row.tooltip': '{path}\n单击就地预览 · 双击在新标签页打开',
      'summary.empty': '（没有正文摘要）',

      'list.scanning': '正在扫描工作区…',
      'list.failed': '读取失败：{error}',
      'list.failedHint': '确认插件宿主半边已加载。',
      'list.empty': '这个工作区里还没有 Markdown 文档。',
      'list.emptyCode': '这个工作区里还没有可纳入上下文的代码文件。',
      'list.emptyMedia': '这个工作区里还没有图片或视频。',
      'list.noMatch': '没有匹配「{query}」的文档。',
      // 文档列表这个 listbox 的无障碍名字（原先硬编码在 JSX 里，英文界面下会漏出中文）
      'list.aria': '最近文档',

      // 相对时间。⚠️ 这六条原先**硬编码在 relTime() 里**，英文界面下会漏出中文
      // （2026-09-19 被真机截图抓出来的）。**加时间粒度时必须同时加中英两条。**
      'time.justNow': '刚刚',
      'time.minutesAgo': '{n}分钟前',
      'time.hoursAgo': '{n}小时前',
      'time.yesterday': '昨天',
      'time.daysAgo': '{n}天前',
      'time.monthDay': '{month}月{day}日',

      'media.play': '播放视频',

      // 「全部」的分区：类型名复用 kind.doc / kind.media，这里只补计数与跳转
      'section.count': '{shown} / {total}',
      'section.more': '查看全部 →',

      'preview.loading': '正在读取…',
      'preview.truncated': '（文件较大，仅预览前 512 KB）',
      'preview.fullscreen': '全屏',
      'preview.exitFullscreen': '退出全屏',
      'preview.fullscreenTitle': '全屏阅读',
      'preview.exitFullscreenTitle': '退出全屏（Esc）',
      // v0.19 追加：HTML 的「网页预览」入口。
      // 就地预览给的是**源码**，这个按钮开的是**官方文档预览标签页** ——
      // 那一侧有 DSH 自带的 HTML 渲染器（`extensions:['html','htm']`，默认走静态档：
      // 清洗过的完整文档 + 不给任何 sandbox 权限的 iframe + 摆在 `<head>` 最前的 CSP，
      // 挡脚本 / 外部资源 / 表单 / 嵌套框架，内联 `<style>` 与 `data:` 图片保留）。
      // 两者**不重复**，所以它不是把 v0.10 撤掉的那个「新标签页」按钮原样搬回来。
      'preview.openWeb': '网页预览',
      'preview.openWebTitle': '{path}\n在官方文档预览里按网页渲染',
      'preview.openLocal': '{path}\n用系统默认应用打开这篇文档',
      'preview.openLocalBtn': '本地打开',
      // 面包屑那条路径点开的是**文件管理器里这个文件所在的位置**（并把文件选中），
      // 不是「打开文件」—— 那是页脚「本地打开」的事，所以文案也得说清。
      'preview.reveal': '{path}\n在文件管理器中显示并选中这个文件',
      'preview.close': '收起预览',
      // v0.19：同名 source map 的入口。**它是低权重动作，不是文件列表条目** ——
      //   `.map` 不参与检索、不进上下文、不进代码列表（需求 §6 §28），
      //   只有用户在这个 .js 的预览里主动点它才会打开，且以纯文本/JSON 呈现。
      'preview.sourceMap': 'Source map',
      'preview.sourceMapTitle': '查看同名 source map（不进入上下文检索）',
      // v0.19：代码预览的两条边界提示。
      //   `codeTruncated` —— 渲染侧的行数上限（与宿主 512 KB 字节上限是两道不同的闸门）。
      //   `copyFailed` —— 剪贴板两条路都失败时才出现。**不能静默**：点了没反应，
      //   用户会以为是按钮坏了，而不是「浏览器不给权限」。
      'preview.codeTruncated': '（文件较大，仅显示前 {n} 行）',
      'preview.copyFailed': '复制失败，请手动选择文本',
      'preview.resizeTitle': '拖动调整高度',
      // v0.12 引用条。⚠️ 不放任何表情符号（test/i18n.test.mjs 有守卫）。
      'links.summary': '被引用 {in} · 引用了 {out}',
      'links.incoming': '被引用',
      'links.outgoing': '引用了',
      'links.noneIn': '没有被引用',
      'links.noneOut': '没有引用别的文档',
      'links.more': '还有 {count} 篇',
      'links.failed': '引用关系读取失败',
      'links.incomplete': '工作区较大，结果可能不完整',
      'preview.rawFallback': '原生 Markdown 渲染不可用，下面是纯文本。请看控制台的 [knit] 日志。',
      'code.copy': '复制',
      'code.copied': '已复制',

      'error.noSession': '当前 tab 没有 sessionId',
      'error.hostFailed': '宿主返回失败',
      'error.noHostTab': '当前宿主没有提供「在新标签页打开」',
      'error.noOpenResource': '座位没有提供 tab.actions.openResource',
      'error.openFailed': '打开失败：{error}',
      'error.bsNoContext': 'better-sidebar 上下文不可用',
      'error.bsNoService': 'betterSidebar 服务不可用',
      'error.bsEditorDisabled': 'better-sidebar 的「编辑器」标签页被禁用了（设置 → 侧边卡片）',

      'host.outsideWorkspace': '路径越出工作区',
      // v0.19：从 `host.markdownOnly`（「只支持 Markdown」）改名。能力已经不止
      //   Markdown 了，文案必须跟着说清**真正的**边界：这个类型不支持在面板里预览。
      'host.notPreviewable': '这个类型不支持在面板里预览',
      'host.notFound': '文件不存在',
      'host.notAFile': '不是普通文件',
      'host.imageOnly': '只允许图片类型',
      'host.imageTooLarge': '图片过大',
      'host.mediaOnly': '仅支持图片或视频类型',
      'host.mediaTooLarge': '视频过大',
      'host.readFailed': '读取失败',
      'host.missingRel': '缺少 rel 参数',
      'host.internal': '宿主内部错误',
    }

    /** 英文词典。键必须与 ZH 完全一致（有测试守着）。 */
    const EN = {
      'type.label': 'Knit',
      'guide.title': 'Knit — recent documents',
      'guide.description': 'Relevance-sorted, click to preview in place',
      'entry.label': 'Knit — recent documents',

      'count': '{n} docs',
      'count.filtered': '{hit} / {total} docs',
      'count.code': '{n} code files',
      'count.code.filtered': '{hit} / {total} code files',
      'count.media': '{n} media',
      'count.media.filtered': '{hit} / {total} media',
      'count.all': '{n} items',
      'count.all.filtered': '{hit} / {total} items',
      'action.refresh': 'Refresh',
      'path.openTitle': 'Open in file manager',
      'peek.empty': 'No Markdown documents in this workspace yet.',
      'action.refreshNow': 'Refresh now',

      'sort.relevance': 'Relevant',
      'sort.time': 'Recent',
      'sort.relevanceTitle': 'Sort by relevance to the current conversation (local keyword matching, no model call)',
      'sort.timeTitle': 'Sort by file modified time, newest first',

      'kind.all': 'All',
      'kind.doc': 'Docs',
      'kind.code': 'Code',
      // 2026-10-06: user picked 「媒体」 for the tab + the "All" section title, so English
      // follows the same word as count.media ("{n} media"): the tab says Media, and the
      // explicit "images and videos" wording stays in the empty state / README prose.
      'kind.media': 'Media',
      'kind.title': 'Switch which artifacts are listed',

      'filter.placeholder': 'Filter docs',
      'filter.aria': 'Filter documents',

      'usage.toggle': 'Usage',
      'usage.toggleTitle': 'Measure this session: whether the primary doc was read, how many reads fell outside the pack, how often the context changed. Facts only — no score.',
      'usage.none': 'Nothing recorded yet',
      'usage.note': 'This session only · kept in kernel memory, gone after a DSH restart',

      // ── v0.18 Context Usage Lens ───────────────────────────────
      // Answers exactly one question: how was the context Knit handed over actually
      // consumed. ⚠️ Not a dashboard: no KPI figures, no percentages, no scores, no
      // charts, no progress bars, no "usage rate / health / confidence". Every line is
      // a fact, never a judgement — and "recent read" is not "currently reading".
      'lens.title': 'Usage',
      'lens.expand': 'Expand usage',
      'lens.collapse': 'Collapse usage',
      'lens.epoch': 'Epoch {n}',
      'lens.reads': '{n} reads',
      'lens.outside': '{n} outside the pack',
      'lens.changes': 'context changed {n}×',
      'lens.currentContext': 'Current context',
      'lens.recentRead': 'Recent read',
      'lens.recentNone': 'Nothing yet',
      'lens.outsideDocs': 'Reads outside context',
      'lens.more': '{n} more',
      'lens.openDoc': 'Open {rel}',
      'lens.delta': 'Context changes',
      'lens.locate': 'Locate {tier} context',
      'lens.coverageAria': '{tier} context: {read} / {total} read',
      'lens.deltaLatest': 'Latest',

      // ── v0.17 document lifecycle ───────────────────────────────
      // ⚠️ All four states are facts, never judgements: "Updated after read" only says the
      //    file changed after the last successful read. Never "the agent has not seen the
      //    latest version" or "the agent used a stale copy" — that would be inference.
      // ⚠️ `readCountShort` is for the row tail: the leading glyph already says it was
      //    read, so the tail only adds the count — repeating "read" would be redundant.
      'usage.deltaEnter': 'Entered',
      'usage.deltaLeave': 'Left',
      'usage.deltaMove': 'Moved tier',
      'usage.deltaTask': 'Task context updated',
      'usage.deltaMore': '+{n} more',
      'lifecycle.unread': 'Unread',
      'lifecycle.read': 'Read',
      'lifecycle.readCount': 'Read ×{n}',
      'lifecycle.readCountShort': '×{n}',
      'lifecycle.updatedAfterRead': 'Updated after read',
      'lifecycle.rereadAfterUpdate': 'Re-read after update',
      'tierName.primary': 'Primary',
      'tierName.supporting': 'Supporting',
      'tierName.related': 'Related',

      // ── v0.14 current-task context (Context Pack) ──────────────
      // ⚠️ Never say "AI", "smart", "recommended", "confidence" or show percentages:
      // this tiering is deterministic local rules, and pretending otherwise is a lie.
      // ⚠️ Only **group** and **reason** labels live here now (2026-09-29): the
      // right-hand "Current task context" panel was deleted — a Context Pack is a
      // **data-layer** structure (Primary / Supporting / Related), not a card.
      // `context.title` / `matched` / `task*` / `evidence*` / `ev*` / `float` /
      // `dock` / `dragHint` / `gripAria` went with it, so no dead keys remain.
      'context.primary': 'Primary',
      'context.supporting': 'Supporting',
      'context.related': 'Related',
      'context.other': 'Other documents',
      // Hints are deliberately **tiny**: a long subtitle turns a group title into prose.
      'context.primaryHint': 'read first',
      'context.supportingHint': 'supporting',
      'context.relatedHint': 'background',
      'context.why': 'Why it is here',
      // Reason codes → copy. The host only ships codes (AGENTS.md §4.5).
      // ⚠️ Flattened on 2026-09-29: "direct topic match: …" read like debug output.
      'why.direct': 'direct match: {term}',
      'why.titleMatch': 'title match: {term}',
      'why.filenameMatch': 'filename match: {term}',
      'why.pathMatch': 'path match: {term}',
      'why.summaryMatch': 'summary match: {term}',
      'why.bodyMatch': 'body match: {term}',
      'why.bodyMatchPlain': 'body match',
      'why.linkTarget': 'referenced by a primary document',
      'why.linkSource': 'references a primary document',
      'why.related': 'related to the current task',

      'row.tooltip': '{path}\nClick to preview here · double-click to open in a new tab',
      'summary.empty': '(no summary)',

      'list.scanning': 'Scanning the workspace…',
      'list.failed': 'Failed to read: {error}',
      'list.failedHint': 'Make sure the plugin’s host half is loaded.',
      'list.empty': 'No Markdown documents in this workspace yet.',
      'list.emptyCode': 'No code files eligible for context in this workspace yet.',
      'list.emptyMedia': 'No images or videos in this workspace yet.',
      'list.noMatch': 'No documents match “{query}”.',
      // Accessible name of the document listbox (was hardcoded in JSX before)
      'list.aria': 'Recent documents',

      // Relative time. ⚠️ These six used to be **hardcoded inside relTime()** and leaked
      // Chinese into the English UI (caught by a real-machine screenshot, 2026-09-19).
      // **Add both languages whenever you add a granularity.**
      'time.justNow': 'just now',
      'time.minutesAgo': '{n} min ago',
      'time.hoursAgo': '{n} h ago',
      'time.yesterday': 'yesterday',
      'time.daysAgo': '{n} d ago',
      'time.monthDay': '{month}/{day}',

      'media.play': 'Play video',

      // "All" sections: titles reuse kind.doc / kind.media, only count + jump live here
      'section.count': '{shown} / {total}',
      'section.more': 'View all →',

      'preview.loading': 'Loading…',
      'preview.truncated': '(large file — showing the first 512 KB)',
      'preview.fullscreen': 'Fullscreen',
      'preview.exitFullscreen': 'Exit fullscreen',
      'preview.fullscreenTitle': 'Read fullscreen',
      'preview.exitFullscreenTitle': 'Exit fullscreen (Esc)',
      'preview.openWeb': 'Web preview',
      'preview.openWebTitle': '{path}\nRender as a web page in the official document preview',
      'preview.openLocal': '{path}\nOpen this document in your default app',
      'preview.openLocalBtn': 'Open locally',
      'preview.reveal': '{path}\nShow this file in your file manager (and select it)',
      'preview.close': 'Close preview',
      'preview.sourceMap': 'Source map',
      'preview.sourceMapTitle': 'View the sibling source map (not part of context retrieval)',
      'preview.codeTruncated': '(large file — showing the first {n} lines)',
      'preview.copyFailed': 'Copy failed — select the text manually',
      'preview.resizeTitle': 'Drag to resize',
      'links.summary': 'Referenced by {in} · links to {out}',
      'links.incoming': 'Referenced by',
      'links.outgoing': 'Links to',
      'links.noneIn': 'Not referenced by anything',
      'links.noneOut': 'Links to no other document',
      'links.more': '{count} more',
      'links.failed': 'Could not read references',
      'links.incomplete': 'Large workspace — results may be incomplete',
      'preview.rawFallback': 'Native Markdown rendering is unavailable — showing plain text. Check the [knit] logs in the console.',
      'code.copy': 'Copy',
      'code.copied': 'Copied',

      'error.noSession': 'This tab has no sessionId',
      'error.hostFailed': 'The host returned a failure',
      'error.noHostTab': 'This host cannot open a new tab',
      'error.noOpenResource': 'The seat did not provide tab.actions.openResource',
      'error.openFailed': 'Open failed: {error}',
      'error.bsNoContext': 'better-sidebar context is unavailable',
      'error.bsNoService': 'The betterSidebar service is unavailable',
      'error.bsEditorDisabled': 'better-sidebar’s Editor tab is disabled (Settings → Side card)',

      'host.outsideWorkspace': 'Path escapes the workspace',
      'host.notPreviewable': 'This type cannot be previewed here',
      'host.notFound': 'File not found',
      'host.notAFile': 'Not a regular file',
      'host.imageOnly': 'Images only',
      'host.imageTooLarge': 'Image too large',
      'host.mediaOnly': 'Images or videos only',
      'host.mediaTooLarge': 'Video too large',
      'host.readFailed': 'Read failed',
      'host.missingRel': 'Missing the rel parameter',
      'host.internal': 'Internal host error',
    }

    /**
     * 把 `{name}` 占位符换成实参。
     * @param {string} template - 模板串
     * @param {object} [params] - 实参
     * @returns {string} 结果
     */
    function format(template, params) {
      if (!params) return template
      return template.replace(/\{(\w+)\}/g, (whole, key) => (
        Object.prototype.hasOwnProperty.call(params, key) ? String(params[key]) : whole
      ))
    }

    /**
     * 当前翻译函数。`apply` 时绑到 ctx.locale；未绑定时退回中文词典，
     * 这样单测里不装 locale 也能直接渲染（真实运行时一定会绑）。
     */
    let t = (key, params) => format(ZH[key] !== undefined ? ZH[key] : key, params)

    /**
     * 宿主错误码 → 词典键。
     *
     * 宿主只返回机器可读的码，文案在这里翻译 —— 这样宿主与 UI 语言解耦。
     * 未登记的码原样显示（便于发现宿主新增了码但忘了翻译）。
     */
    const HOST_ERROR_KEY = {
      'knit/outside-workspace': 'host.outsideWorkspace',
      'knit/not-previewable': 'host.notPreviewable',
      'knit/not-found': 'host.notFound',
      'knit/not-a-file': 'host.notAFile',
      'knit/image-only': 'host.imageOnly',
      'knit/image-too-large': 'host.imageTooLarge',
      'knit/media-only': 'host.mediaOnly',
      'knit/media-too-large': 'host.mediaTooLarge',
      'knit/read-failed': 'host.readFailed',
      'knit/missing-rel': 'host.missingRel',
      'knit/internal': 'host.internal',
    }

    /**
     * 把一个失败的宿主响应翻成当前语言的文案。
     * @param {object} data - 宿主载荷
     * @returns {string} 文案
     */
    function hostMessage(data) {
      const code = data && data.code
      if (!code) return t('error.hostFailed')
      const key = HOST_ERROR_KEY[code]
      return key ? t(key) : code
    }

    /**
     * DSH 共享的 Markdown 渲染器（@deepseek-ai/dsh-client-ui-primitives 的 MarkdownText，
     * 官方 ui-sidebar-documentpreview 与 dsh-better-sidebar 用的是同一个）。
     *
     * ⚠️ 它由 `React.memo()` 包出来，值是**对象**不是函数
     * （`{ $$typeof: Symbol(react.memo), type: fn }`）。所以这里只能判空，
     * 不能用 `typeof === 'function'` —— 那样会把可用的渲染器误判成不可用，
     * 一路静默降级成纯文本（真实踩过的坑）。React 认这个对象形态，直接交给
     * createElement 渲染即可。
     */
    let MarkdownText = null
    try {
      const primitives = require('@deepseek-ai/dsh-client-ui-primitives')
      const candidate = primitives && primitives.MarkdownText
      if (candidate !== undefined && candidate !== null) MarkdownText = candidate
      else console.warn('[knit] ui-primitives does not export MarkdownText — preview falls back to plain text')
    } catch (error) {
      console.warn('[knit] could not load ui-primitives.MarkdownText — preview falls back to plain text', error)
    }

    /* ── 常量 ───────────────────────────────────────── */

    /** 官方右侧栏 tab 的身份，也是 body/title 注册用的 key。 */
    const TAB_ID = 'dsh-knit:recent'
    /** page 类型判别符；openTab('knit') 用它。 */
    const KIND = 'knit'
    /** better-sidebar 里这个 tab 的 id。 */
    const BS_TAB_ID = 'knit:recent'

    const LIST_API = '/knit/api/recent'
    const DOC_API = '/knit/api/doc'
    const RAW_API = '/knit/api/raw'
    // v0.12：某篇的「谁引用了它 / 它引用了谁」。与上面三条一样是**同源相对地址**，
    // 所以仍然满足「客户端零网络出口」那条守卫（test/security.test.mjs）。
    const LINKS_API = '/knit/api/links'

    /** 轮询间隔。 */
    const POLL_MS = 5000
    /** 多久之内算「新」，打 🆕 标记。 */
    const NEW_WINDOW_MS = 2 * 60 * 1000

    /** 悬停偷看：进入后延迟显示，离开后延迟收起（避免误触与闪烁）。 */
    const PEEK_SHOW_DELAY = 250
    const PEEK_HIDE_DELAY = 200
    /** 悬停浮层里最多列几篇。 */
    const PEEK_LIMIT = 5

    /** 用户偏好（选了就记住）。 */
    const SORT_KEY = 'dsh-knit:sort'
    const RATIO_KEY = 'dsh-knit:preview-ratio'
    const KIND_KEY = 'dsh-knit:kind'
    /**
     * v0.15「使用情况」的开闸键。**默认关** —— 记账意味着每次轮询都要读一遍会话事件，
     * 用户没要看这个之前，不该有人替他付出这个代价（也不该悄悄攒数据）。
     */
    const USAGE_KEY = 'dsh-knit:usage'

    /** 列表类型：仅文档 / 仅代码 / 仅图片视频 / 全部混排。默认 doc，与旧版体验一致。 */
    const KIND_DOC = 'doc'
    /**
     * v0.19：代码档。**它是同一份 Context Retrieval 结果的另一个切片，不是代码工具页。**
     * 这一档里显示的仍然是「按当前任务排出来的代码候选」，不是仓库的代码文件树
     * （需求 §24：任务「修改 Skill loader 使它支持新的 frontmatter」时，
     * 应该看到 skill-loader.ts / frontmatter.ts，而不是 src/ 下的全部 .ts）。
     */
    const KIND_CODE = 'code'
    const KIND_MEDIA = 'media'
    const KIND_ALL = 'all'

    /**
     * v0.19：分类层给的「生成产物」档（`.map` / `*.min.js` / `package-lock.json` …）。
     *
     * **它不出现在任何列表里**（`contextual:false`、`searchable:false`，宿主根本不会
     * 把它放进候选），但它**可以预览** —— 用户主动点「Source map」时才走到这里。
     * 「能不能进上下文」与「能不能看」是两件事（需求 §29：Context eligibility ≠
     * File system visibility）。
     */
    const KIND_GENERATED = 'generated'

    /* ── 产物 kind（宿主 `classification.js` 的取值）─────────────────────
       ⚠️ **不要把它和上面的页签常量 `KIND_DOC` 混起来**：`KIND_DOC` 是**页签值**
       （`'doc'`，只活在 URL 参数与 localStorage 里），而宿主下发的 `doc.kind` 是
       **分类层的产物类型**（Markdown 是 `'md'`）。两者字面量不同、语义也不同，
       写成 `doc.kind === KIND_DOC` 会恒为假 —— 那正是「代码区永远空白」这类
       看起来像没数据、其实是比较写错的问题。 */
    const ARTIFACT_DOC = 'md'
    const ARTIFACT_CODE = 'code'

    /** 预览面板高度的上下限：任何一端都不把对方挤没。 */
    const MIN_RATIO = 0.2
    const MAX_RATIO = 0.8
    const DEFAULT_RATIO = 0.46

    /* ── 曾经在这里的一组常量：右栏的宽度与形态 ──────────────
       `PACK_W_DEFAULT`(310) / `PACK_W_MIN`(260) / `PACK_W_MAX`(420) /
       `PACK_SNAP_PX`(28) / `PACK_DRAG_SLOP`(4)
       **2026-09-29 整组删除**：它们只服务于「拖宽那个面板 / 把它拖出去浮动 /
       拖到右缘吸附回来」这一套动作，而**右侧那个面板本身没有了**。
       用户当天的结论：Context Pack 是**数据层**概念（Primary / Supporting /
       Related 的结构化结果），**不是一个必须单独显示出来的 UI 卡片** ——
      同一个结构直接落进文档列表的分组里，不再另开一栏解释一遍。
       ⚠️ 留着一套只服务于已删 UI 的常量，下一个人只会以为它还在生效。 */

    /** 「全部」视图里文档区的固定上限。 */
    const ALL_DOC_CAP = 4
    /** 「全部」视图里代码区的固定上限（与文档区同量级 —— 代码不该在这一档里压过文档）。 */
    const ALL_CODE_CAP = 4
    /**
     * 一屏基准：两行 × 4 列的观感（只在「媒体」这一档决定一屏铺几行时用）。
     * **它不决定列数** —— 列数交给 CSS 的 `auto-fill`，见 mediaLayoutFor。
     */
    const MEDIA_MAX_ITEMS = 8
    /**
     * 媒体格子的基准边长（CSS `minmax` 的下限）。
     *
     * **它与条目数完全无关** —— 这是 2026-09-20 第二版修正的核心。
     * 第一版仍然按「条目数」反推格宽：条目 ≤8 个想要 4 列满宽、超过就缩到 64px 硬塞两行。
     * 结果**列数被条目数锁死**：实测面板从 400px 拉到 1200px，列数一直卡在 **5 列**，
     * 只有格子从 64px 被吹到 224px。用户的原话：「要我拉到一定的宽度以后，它才从 4 个变成更多」
     * 「它不是真的响应式」。
     *
     * 现在只钉一个数：**格子基准 104px**（实际渲染约 104–155px），
     * 列数 = 浏览器按可用宽度连续数出来的（`repeat(auto-fill, minmax(104px, 1fr))`）——
     * 拖宽约 120px 就多一列，与 AIGC 资产中心的图片网格同一套机制
     * （它的窄屏档就是 `minmax(104px,1fr)`）。
     */
    const MEDIA_TRACK_PX = 104
    /* ── 文档列表为什么是单列（历史，写给下一个人看）─────────────────
     * 这一段**不修饰任何声明**，只记结论与代价 —— 因为原来修饰的那个常量
     * （`DOC_GRID_MIN_COLS` 那一组）已经随多列一起删了。
     *
     * 文档列表**永远是单列**（2026-09-29 用户拍板，第四版也是最后一版）。
     *
     * 演进，每一版都是真机体验后被打回的：
     *  - 第一版「把完整卡直接压窄」→ 632px 面板 4 列时标题只剩 **9 个字**
     *    （真实标题中位数 18、最长 43）。**多列不等于可以砍数据**（第二版
     *    「多列只留标题 + 时间」也被否掉）。
     *  - 第三版保留全部字段、上限收到 2 列；用户原话：「大于三行体验上视觉跳动信息过载了」。
     *  - **第四版（当前）**：用户看到真机上的 2 列后拍板 ——「文档列表最多一个就行，
     *    现在一行两个有点太多了」。**上限改成 1 列，多列那套整体删除**
     *    （`docLayoutFor` / `DOC_TRACK_PX` / `DOC_SUMMARY_MIN_PX` / `.knit-multicol.cols-N`
     *    与 `.no-sum` 兜底全部不再存在）。
     *
     * 单列之后行内改成**元信息在上、标题独占一行**（用户同一条消息里给的方向：
     * 「时间跟那个置顶的序号可以一行」）—— 见 `DocRow` 的组装顺序与 `.knit-row1`。
     *
     * ⚠️ **不要加回多列**。真要提升宽面板的信息利用率，该做的是让**单列更舒展**，
     * 不是切栏 —— 这句从第三版起没变过。
     */
    /**
     * 实际格宽低于这个值才让卡片文字让位给缩略图。
     *
     * ⚠️ **正常情况下这个分支永远不触发**：格子基准 104px + `1fr` 只会把格子**撑宽**，
     * 所以任何面板宽度下实际格宽都 ≥ 100px，文件名放得下。
     * 旧版（按条目数把格子压到 64px 那套）才会频繁让位；这里保留判据只是兜底。
     */
    const MEDIA_LABEL_MIN_PX = 96
    const MEDIA_GAP_PX = 10
    /** 网格左右内边距合计（.knit-media-grid 的 padding:0 12px / 8px 12px 16px）。 */
    const MEDIA_GRID_PAD_X = 24
    /** `.knit-list` 自己的左右内边距（padding:8px）—— 量到的是它，算格子要先扣掉。 */
    const LIST_PAD_X = 16
    /** 量不到宽度时的兜底：默认右侧栏的几何（旧实现里的默认值，别改）。 */
    const MEDIA_FALLBACK_WIDTH = 632

    /**
     * 算媒体网格当前能排几列、单格实际多宽。
     *
     * 规则（2026-09-20 第三次修正后的口径）：
     *
     * 1. **格子基准固定 104px，与条目数无关** —— 面板拖宽是**多出一列**，不是把格子吹大。
     * 2. **列数连续增长** —— 宽约 120px 就多一列；不再像第一版那样卡在 5 列不动。
     * 3. **纵向有多少行就铺多少行** —— 网格**不再设 maxHeight**。
     *
     * ⚠️ **第 3 条是 2026-09-20 第三次修正**：前两版都把高度封在「两行」，
     * 让网格自己内部滚动。真机上第三行只能露出一点点，用户的原话是
     * 「本来有三行，结果第三行只显示了一点点，应该纵向也完整显示」——
     * 封顶高度是按「两行」算死的，跟面板实际有多高无关，必然截断。
     * 现在整块交给 `.knit-list` 的滚动，与 AIGC 资产中心的做法一致。
     *
     * ⚠️ **这里的列数算术必须与 CSS 的 `auto-fill` 逐字同源**：CSS 那行是
     * `repeat(auto-fill, minmax(104px, 1fr))`，所以列数是
     * `floor((可用宽 + gap) / (104 + gap))`，**不是** `floor(可用宽 / 104)`；
     * 少算 gap 会让 JS 与真机差一列（第一版实测踩过）。
     *
     * @param {number} width - 网格可用宽度（px，不含左右内边距）
     * @returns {{min:number, columns:number, cell:number, scaled:boolean}}
     *   格子基准宽（= CSS 的 minmax 下限）、当前宽度下能排几列、单格实际宽度、
     *   是否让卡片文字让位
     */
    function mediaLayoutFor(width) {
      const w = Number(width)
      const usable = Number.isFinite(w) && w > 0 ? w : MEDIA_FALLBACK_WIDTH
      /** cols 列时每格实际能有多宽（含 gap 的同一套算术）。 */
      const cellFor = (cols) => Math.floor((usable - (cols - 1) * MEDIA_GAP_PX) / cols)
      // 与 CSS 的 auto-fill 同一套判定：minmax(104px, …) 下能排几条。
      const columns = Math.max(1,
        Math.floor((usable + MEDIA_GAP_PX) / (MEDIA_TRACK_PX + MEDIA_GAP_PX)))
      const cell = cellFor(columns)
      // 让位判据看的是**实际格宽**，不是基准宽：窄面板只出 2 列时格子反而宽到 135px，
      // 那时文件名放得下，不该跟着一起让位。
      return {
        min: MEDIA_TRACK_PX,
        columns,
        cell,
        scaled: cell < MEDIA_LABEL_MIN_PX,
      }
    }

    /* ── 样式：跟随 DSH 主题令牌，深浅色自适应 ───────────────── */
    const STYLE_ID = 'dsh-knit-style'
    const CSS = `
.knit-root{
  /* 交互强调色统一走 DSH 品牌令牌：浅色 #4176e6 / 暗色 #5686fe，随主题切换。
     这里曾经硬编码过一套紫与另一套蓝，两套都不跟主题，深色下尤其突兀。
     填充改用 DSH 选中态的半透明令牌，不自己混色 —— color-mix 在旧内核上
     会让整条声明失效（invalid at computed-value time），不是渐进增强。 */
  --knit-accent:var(--dsw-alias-brand-primary-new-colorprimary-new-color,#4176e6);
  /* 悬停 / 选中的灰底：在 DSH 两个令牌的**透明度上各降一档**
     （悬停 −60% → 保留 40%；选中 −40% → 保留 60%）。
     起因是用户觉得默认那档「太灰了」，读文档时对比度被吃掉。
     两个主题各给一套显式值，所以这不违反「不要硬编码不跟主题」这条：
     浅色是 rgba(38,49,72,α)（即 DSH 的 #263148），暗色是白色低透明度。 */
  --knit-hover-bg:rgba(38,49,72,.024);   /* DSH .0588 × 0.4 */
  --knit-active-bg:rgba(38,49,72,.061);  /* DSH .1020 × 0.6 */
  display:flex;flex-direction:column;height:100%;min-height:0;
  color:var(--dsw-alias-label-primary,#e8eaed);font-size:13px}
body[data-ds-dark-theme] .knit-root{
  --knit-hover-bg:rgba(255,255,255,.031);  /* DSH .0784 × 0.4 */
  --knit-active-bg:rgba(255,255,255,.085); /* DSH .1412 × 0.6 */
}
.knit-head{display:flex;align-items:center;gap:8px;padding:10px 12px 8px;flex:none}
.knit-head .knit-root-path{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;
  white-space:nowrap;font-size:11px;color:var(--dsw-alias-label-caption,#80868b);
  background:transparent;border:none;padding:0;text-align:left;font-family:inherit;
  cursor:pointer}
.knit-head .knit-root-path:hover{color:var(--dsw-alias-label-primary,#e8eaed);
  text-decoration:underline}
.knit-head .knit-root-path:disabled{cursor:default;text-decoration:none}
.knit-count{font-size:11px;color:var(--dsw-alias-label-caption,#80868b);flex:none}
.knit-btn{flex:none;display:inline-flex;align-items:center;justify-content:center;
  height:28px;padding:0 10px;border-radius:8px;cursor:pointer;
  background:transparent;color:var(--dsw-alias-label-secondary,#9aa0a6);
  border:.5px solid var(--dsw-alias-border-l4,rgba(255,255,255,.08));font-size:12px;
  transition:background .16s ease,color .16s ease}
.knit-btn:hover{background:var(--knit-hover-bg,rgba(255,255,255,.03));
  color:var(--dsw-alias-label-primary,#e8eaed)}
.knit-btn.active{background:var(--knit-active-bg,rgba(255,255,255,.085));
  color:var(--dsw-alias-label-primary,#e8eaed);border-color:var(--dsw-alias-border-l4,rgba(255,255,255,.22))}
/* v0.19「低权重动作」：Source map。
   它**不是**主要操作 —— .map 不参与检索，只是一个「顺手看一眼」的旁路。
   所以去掉边框、压到 caption 色，让「复制 / 全屏 / 本地打开」保持主次分明。
   ⚠️ 不要在这里加 accent 色（类型页签那条守卫也是这个道理）。
   ⚠️ 这段注释在模板串里：**任何反引号都会截断样式表**（AGENTS.md 的老坑）。 */
.knit-btn-quiet{border-color:transparent;color:var(--dsw-alias-label-caption,#80868b);font-size:11px;padding:0 8px}
.knit-btn-quiet:hover{color:var(--dsw-alias-label-secondary,#9aa0a6)}
/* 排序切换与搜索框：v0.18 UI 迭代（md §四~§六）把这两个控件**按输入控件的尺度重做** ——
   圆角 10px / 字号 13px。原来那套 22px 迷你胶囊读起来像「标签」而不是控件，
   与 14px 的页签、15px 的 Usage 标题差了两档，是「审美欠缺」最直观的一处。
   ⚠️ 高度：md 写 36px，2026-10-06 用户看了真机后定成 **28px**（「太高了，不需要这么高」），
      与左边的「使用情况 / 刷新」同高。
   ⚠️ 描边色：用 **--dsw-alias-border-l3**，与 DSH 主区「对话」页签下面那条横线（官方
      .wSkVaW_header 的 border-bottom: .5px solid rgba(0,0,0,.12) = 浅色下的 border-l3）
      同一个 token —— 2026-10-06 用户要求「描边色值改成跟那条横一样」。不用更深的 l4：
      l4（浅色 rgba(0,0,0,.161)）比官方分割线重一档，摆在页签下面像两个输入框框住了内容。
    ⚠️ 描边粗细：**0.5px**（2026-10-06 用户第二轮要求「描边色值修改成 0.5px」）—— 官方那条
       横本身就是 .5px，色值对上而粗细仍写 1px，高分屏上比它粗一倍。三处同粗：.knit-seg
       外框、.knit-seg 内部竖线、.knit-filter。CSS 里统一写 0.5px（与官方 .wSkVaW_header 的 .5px 同值）。
   ⚠️ 选中态只改**底色 + 字重 600**（不是 700），hover 只改底色 —— 不许 scale / translate /
      box-shadow（md §五）。暗色下靠 --knit-active-bg 这个 token，不写死颜色。 */
.knit-bar{display:flex;align-items:center;gap:8px;padding:0 12px 8px;flex:none}
.knit-seg{display:inline-flex;flex:none;border-radius:10px;overflow:hidden;
  border:0.5px solid var(--dsw-alias-border-l3,rgba(255,255,255,.12))}
.knit-seg-btn{height:28px;padding:0 15px;cursor:pointer;font-size:13px;font-weight:400;
  border:none;background:transparent;color:var(--dsw-alias-label-secondary,#9aa0a6);
  transition:background .16s ease,color .16s ease}
.knit-seg-btn + .knit-seg-btn{border-left:0.5px solid var(--dsw-alias-border-l3,rgba(255,255,255,.12))}
.knit-seg-btn:hover{background:var(--knit-hover-bg,rgba(255,255,255,.03))}
.knit-seg-btn.active{background:var(--knit-active-bg,rgba(255,255,255,.085));
  color:var(--dsw-alias-label-primary,#e8eaed);font-weight:600}
.knit-filter{flex:1;min-width:0;height:28px;padding:0 12px;border-radius:10px;font-size:13px;
  background:transparent;color:var(--dsw-alias-label-primary,#e8eaed);
  border:0.5px solid var(--dsw-alias-border-l3,rgba(255,255,255,.12));outline:none;
  transition:border-color .16s ease}
.knit-filter:focus{border-color:var(--knit-accent)}
.knit-filter::placeholder{color:var(--dsw-alias-label-caption,#80868b)}
/* v0.15「使用情况」→ v0.18「Context Usage Lens」：**列表上方的一块轻量观察层**。
   不是弹窗、不是新页面、不是 Dashboard、不画卡片、不画进度条、不用品牌色。
   它占的是原来「相关性排序」那一行的位置 —— 2026-09-30 用户裁决那一行整个删掉
   （排序方式由「相关 / 最新」那个切换按钮自己表达，再说一遍是重复），
   于是它是类型页签下面、列表上面唯一的一块弱化信息，不是一块新面板。
   ⚠️ 全宽横线一律不画：2026-09-29 用户要求**减少全宽分割线** ——
   「页面上横线一多，读起来就像文件管理表格」。层级由空间与字号建立。
   ⚠️ 它**自己不滚动**：滚动统一交给 .knit-list —— 窄侧栏里滚轮套滚轮很难用。
   ⚠️ 这一条不许加 background / width / 品牌色（有守卫盯着，见 client.test.mjs）。 */
.knit-usage{flex:none;padding:12px 12px 10px;font-size:12px;line-height:1.5;
  color:var(--dsw-alias-label-caption,#80868b)}
/* Lens 标题行：整行可点，展开 / 收起。**「使用情况」开关管统计开不开，
   这一行管「统计开着但看不看细节」—— 两件事**（2026-10-05 规格 §25）。
   v0.18 UI 迭代（2026-10-06，依 '02_方案与 Demo/dsh-knit V0.18 UI 重构开发提示词.md'
   §七 / §四十七 的尺度表）：标题 15px/600（它是这一块的**标题**，不是元信息）、
   Epoch 12px 弱化靠右、**不做成 Badge**（不画底、不画边）。 */
.knit-lens-head{display:flex;align-items:baseline;gap:8px;width:100%;appearance:none;
  border:0;background:none;margin:0;padding:0;font:inherit;cursor:pointer;text-align:left;
  color:var(--dsw-alias-label-secondary,#9aa0a6)}
.knit-lens-head:hover{color:var(--dsw-alias-label-primary,#e8eaed)}
.knit-lens-head:focus-visible{outline:1px solid var(--knit-accent);outline-offset:1px}
.knit-lens-title{flex:none;font-size:15px;font-weight:600;line-height:20px;
  color:var(--dsw-alias-label-primary,#e8eaed)}
.knit-lens-epoch{flex:none;margin-left:auto;font-size:12px;font-weight:400;line-height:20px;
  color:var(--dsw-alias-label-caption,#80868b)}
/* 摘要行：三件事实，一行。放不下就省略号 —— 绝不换行把列表顶下去。
   12px/18px、与标题 4~6px（md §九 / §十）。 */
.knit-lens-sum{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
  margin-top:5px;font-size:12px;line-height:18px}
.knit-lens-sec{margin-top:13px}
.knit-lens-name{margin-bottom:6px;font-size:12px;font-weight:500;
  color:var(--dsw-alias-label-secondary,#9aa0a6)}
/* 「当前上下文」这一句是**分节标题**（比层名与行标签高一档，md §十三：13px/500）；
   距摘要行 12~14px 由 .knit-lens-sec 的 margin-top 给。 */
.knit-lens-cap{margin-bottom:6px;font-size:13px;font-weight:500;
  color:var(--dsw-alias-label-secondary,#9aa0a6)}
/* 当前上下文 Coverage：三层各「层名 + 已读 ÷ 总数 + 状态点」。
   v0.18 UI 迭代（md §十二~§十九）：三层用 '1fr 1.2fr 1.8fr' 的**网格**（Related 通常
   最多），层名与 'n / m' 落在**同一行**（数值右对齐），状态点是**真的 9px 圆点** ——
   不再是 '○ ●' 字符：字符圆点在不同字体 / 字号下大小不一，正是「不像设计稿」的那一处。
   ⚠️ 不是三张 Card：默认不画底、不画边，只有 hover 时一层很淡的底（md §十三 / §五十一）。
   ⚠️ 分母是这一层当前真实几篇：Primary 不存在时整列不显示（不画 0 / 0 的假层）。 */
.knit-cov{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.2fr) minmax(0,1.8fr);
  column-gap:14px;align-items:start;margin:0 -8px}
.knit-cov-col{display:grid;grid-template-columns:1fr auto;column-gap:8px;row-gap:7px;
  align-items:center;appearance:none;border:0;margin:0;padding:6px 8px;
  background:transparent;font:inherit;cursor:pointer;text-align:left;border-radius:10px;
  color:var(--dsw-alias-label-caption,#80868b);transition:background .16s ease}
.knit-cov-col:hover{background:var(--knit-hover-bg,rgba(255,255,255,.03))}
.knit-cov-col:focus-visible{outline:1px solid var(--knit-accent);outline-offset:1px}
.knit-cov-name{grid-column:1;min-width:0;overflow:hidden;text-overflow:ellipsis;
  white-space:nowrap;font-size:12px;font-weight:500;
  color:var(--dsw-alias-label-secondary,#9aa0a6)}
/* 状态点：**真 CSS 圆** —— 未读＝空心环（1px 中性边）、已读＝中性填充；'○→●' 只做
   background / border-color 两笔 220ms 过渡，不弹跳、不闪烁。
   ⚠️ 轮询不动数据就不动 className，于是补间不会被重播。
   ⚠️ 只用中性 token：没有绿 / 红 / 黄 / 蓝 —— 读没读过不是「好 / 坏」（PRD §7.3）。
   ⚠️ 与文档行里的 .knit-glyph-mark **同一对 token、同一个直径**：md §二十九 要求
   生命周期那枚空心圆与这里的空心圆「视觉完全一致」。 */
.knit-cov-dots{grid-column:1 / -1;display:flex;flex-wrap:wrap;gap:6px;row-gap:5px;
  min-height:6px;align-items:center}
/* ⚠️ 圆点直径 6px（2026-10-06 用户定：「9px 真圆请改成 6px」）。
   Coverage 与文档行的 glyph 必须**同一个直径、同一对 token**（守卫会比对两处）。 */
.knit-cov-dot{flex:none;display:block;width:6px;height:6px;border-radius:50%;
  border:1px solid var(--dsw-alias-label-caption,#80868b);background:transparent;
  transition:background .22s ease,border-color .22s ease}
.knit-cov-dot.on{background:var(--dsw-alias-label-caption,#80868b);
  border-color:var(--dsw-alias-label-caption,#80868b)}
.knit-cov-num{grid-column:2;text-align:right;font-size:11px;font-weight:400;
  font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-caption,#80868b)}
/* 最近读取：**可点的一行**（文件名 · 相对时间 ›）。整行可点、hover 只改底色。
   v0.18 UI 迭代（md §二十一 / §二十二）：高 38px、左右 10px、圆角 8px、
   文件 12px、时间 11px、箭头 16px。
   ⚠️ 语义仍是「最近一次成功 read」：文案不许写成「当前正在阅读」。 */
.knit-read-row{display:flex;align-items:center;gap:10px;width:100%;appearance:none;
  border:0;background:none;margin:0;padding:0 10px;height:38px;border-radius:8px;font:inherit;
  text-align:left;cursor:pointer;color:var(--dsw-alias-label-primary,#e8eaed);
  transition:background .16s ease}
.knit-read-row:hover{background:var(--knit-hover-bg,rgba(255,255,255,.03))}
.knit-read-row:focus-visible{outline:1px solid var(--knit-accent);outline-offset:1px}
.knit-read-rel{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;
  white-space:nowrap;font-size:12px}
.knit-read-time{flex:none;font-size:11px;color:var(--dsw-alias-label-caption,#80868b)}
.knit-read-go{flex:none;font-size:16px;line-height:1;
  color:var(--dsw-alias-label-caption,#80868b)}
.knit-lens-empty{opacity:.75}
/* 包外读取：每一行都是**可点对象**（点开预览），但不许加入 Context ——
   V0.18 不做 Context Control，这里是「看一眼」，不是「改上下文」。
   v0.18 UI 迭代（md §三十四~§三十七）：展开后逐行
   '01  docs/…  ×3  已读'（序号 + 路径 + 次数 + 状态），11px、行内不画线。 */
.knit-out-row{display:flex;align-items:center;gap:9px;width:100%;appearance:none;
  border:0;background:none;margin:0;padding:5px 9px 5px 17px;border-radius:8px;font:inherit;
  text-align:left;cursor:pointer;color:var(--dsw-alias-label-caption,#80868b);
  transition:background .16s ease}
.knit-out-row:hover{background:var(--knit-hover-bg,rgba(255,255,255,.03));
  color:var(--dsw-alias-label-primary,#e8eaed)}
.knit-out-row:focus-visible{outline:1px solid var(--knit-accent);outline-offset:1px}
.knit-out-num{flex:none;width:18px;text-align:right;font-size:11px;
  font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-caption,#80868b);opacity:.75}
.knit-out-rel{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;
  white-space:nowrap;font-size:11px}
.knit-out-count{flex:none;font-size:11px;font-variant-numeric:tabular-nums}
/* 行内生命周期 glyph（v0.17 起）：**极小、中性、不抢标题**。点它 = 打开 / 选中这篇。
   v0.18 UI 迭代（md §二十七~§二十九）：四态改成与 Coverage **同一套**圆点语言 ——
   未读＝空心环、已读＝实心、读后已更新＝空心环 + 中心点、修改后已重新读取＝ ↻ 字符。
   两者用同一对 token、同一个 9px 直径，所以「同一套状态语言」不靠自觉。
   ⚠️ 类名不能叫 knit-life-*：byClass 是子串匹配，会和 .knit-life 撞。 */
.knit-glyph{flex:none;display:inline-flex;align-items:center;justify-content:center;
  appearance:none;border:0;background:none;margin:0;padding:0;width:14px;height:18px;
  cursor:pointer;color:var(--dsw-alias-label-caption,#80868b)}
.knit-glyph:hover{color:var(--dsw-alias-label-primary,#e8eaed)}
.knit-glyph:focus-visible{outline:1px solid var(--knit-accent);outline-offset:1px}
.knit-glyph-mark{flex:none;display:block;width:6px;height:6px;border-radius:50%;
  border:1px solid var(--dsw-alias-label-caption,#80868b);background:transparent;
  transition:background .22s ease,border-color .22s ease}
.knit-glyph-mark[data-mark="read"]{background:var(--dsw-alias-label-caption,#80868b)}
.knit-glyph-mark[data-mark="updated"]{position:relative}
.knit-glyph-mark[data-mark="updated"]::after{content:'';position:absolute;inset:1.5px;
  border-radius:50%;background:var(--dsw-alias-label-caption,#80868b)}
.knit-glyph-mark[data-mark="reread"]{width:9px;height:9px;border:0;background:transparent;
  font-size:9px;line-height:9px;text-align:center}
/* Coverage 点某一层 → 那一层**短暂高亮**（空间定位，不画横线、不加箭头）。
   1200ms 轻微背景（md §十七原写 500~700ms，2026-10-06 用户看真机后定成 1200ms），
   不许闪红、不许位移。CSS transition 的时长必须与 FLASH_MS 一致，否则会出现「已经取消高亮
   但背景还在慢慢褪」的错帧。 */
.knit-tier{transition:background 1.2s ease}
.knit-tier.flash{background:var(--knit-hover-bg,rgba(255,255,255,.03));border-radius:10px}

/* v0.17 文档生命周期（Document Lifecycle）—— 三条新信息，都只是**事实**。
   ⚠️ 状态是文字，不是徽章：不加底色、不加边框、不用红绿 —— 红绿会把「事实」读成
   「好 / 坏」（PRD §7.3）。永远不抢标题（标题 14px）。
   v0.18 UI 迭代：10.5px → **11px** —— md §四十七 的尺度表里最小一档就是 11px。
   ⚠️ 折叠块沿用 .knit-usage 的弱化灰阶：它们是同一行事实的展开，不是新卡片。
   ⚠️ 这一段**不含反引号**，整段可以直接放在 CSS 模板串里。 */
.knit-life{flex:none;font-size:11px;line-height:1.4;white-space:nowrap;
  color:var(--dsw-alias-label-caption,#80868b)}
.knit-usage-more{margin-top:10px}
/* 菜单式展开行（包外读取 / 上下文变化）：整行可点、高 38px、圆角 8px、hover 只改底色；
   左边是标题，右边是「数量 / 最近一次 + ›」，展开后箭头换成 ⌃（md §三十四 / §三十八）。 */
.knit-more-btn{display:flex;align-items:center;gap:10px;width:100%;
  appearance:none;border:0;background:none;margin:0;padding:0 10px;height:38px;
  border-radius:8px;font:inherit;font-size:12px;line-height:1;cursor:pointer;text-align:left;
  color:var(--dsw-alias-label-secondary,#9aa0a6);transition:background .16s ease}
.knit-more-btn:hover{background:var(--knit-hover-bg,rgba(255,255,255,.03));
  color:var(--dsw-alias-label-primary,#e8eaed)}
.knit-more-btn:focus-visible{outline:1px solid var(--knit-accent);outline-offset:1px}
.knit-more-label{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;
  white-space:nowrap}
.knit-more-meta{flex:none;font-size:11px;font-variant-numeric:tabular-nums;
  color:var(--dsw-alias-label-caption,#80868b)}
.knit-gap-row,.knit-delta-row{display:flex;gap:9px;align-items:baseline;
  padding:3px 9px 3px 17px;font-size:11px;
  color:var(--dsw-alias-label-caption,#80868b)}
.knit-gap-rel,.knit-delta-rel{flex:1 1 auto;min-width:0;overflow:hidden;
  text-overflow:ellipsis;white-space:nowrap}
.knit-delta-head{margin-top:8px;padding:0 9px 0 17px;font-size:11px;font-weight:500;
  color:var(--dsw-alias-label-secondary,#9aa0a6)}


/* ── v0.14 右栏（Context Pack 面板）已整体删除（2026-09-29）────────
   用户裁定：Context Pack 是**数据层**结构（Primary / Supporting / Related），
   不是一个要单独显示的 UI 卡片。右栏与左栏的 Primary / Supporting / Related
   信息重复，「当前任务 / 命中 N 篇 / 证据」的视觉价值也有限，还容易把 Knit
   做成 AI Dashboard ⇒ 界面改成**单栏**，分组直接落在文档列表里。

   随这一栏删掉的东西（**删干净，不留死代码**）：
   .knit-context-layout / .knit-col-list / .knit-context-column（两列网格）、
   @media (max-width:1000px) 的并栏规则、.knit-grip（拖宽把手）、
   .knit-pack*（面板与头部）、.knit-evrow 一整套证据行、
   .knit-solo / .knit-undocked / .knit-snap 三个状态类。
   JS 那边对应的 clampPackW / clampFloatPos / nearRightEdge、拖拽与吸附、
   contextPanel 也一起删了。
   ⚠️ 留着一套永远渲染不出来的样式，下一个人只会以为它还在生效。

   ⚠️ 这段注释里不能出现反引号（整个 CSS 是一个模板串）。 */

.knit-tier{display:block}
.knit-tier + .knit-tier{margin-top:16px}
/* ⚠️ 组与组之间**不再画线**（2026-09-29）：以前是 margin-top:2px + 一条 border-top，
   读起来像表格。现在只有 16px 空间 —— 分组靠间距与组名建立，不靠横线。 */
.knit-tierline{display:flex;align-items:baseline;gap:6px;padding:0 12px 6px;
  font-size:10px;line-height:1.3;color:var(--dsw-alias-text-tertiary)}
/* Design §14：层名走「大写 + 字距」这套页签式排版，中文 hint 退到 muted 那一档。
   ⚠️ uppercase 对中文是空操作，所以中文形态仍然是「主要上下文」——
   不为了对齐英文形态去改词典：界面语言该由 i18n 决定，不该由 CSS 决定。
   Design §14 里那个「可选的 5~6px 灰点」**不做** —— Primary 已经有一颗黑点了，
   再加一颗同形状的点会让「层标记」和「主上下文标记」看起来是一回事。 */
.knit-tiername{font-weight:600;font-size:12px;letter-spacing:.01em;
  text-transform:uppercase;color:var(--dsw-alias-text-secondary)}
.knit-tierhint{font-weight:400}
/* 「为什么在这里」：比摘要更弱的一行，只在 Context Pack 的条目上出现。
   11px 而不是 10px，因为它承担的是**信息**（可核验的理由），不是装饰标注。 */
.knit-why{padding-top:2px;font-size:11px;line-height:17px;color:var(--dsw-alias-text-tertiary)}
/* 滚动条**不要自己画**：DSH 主题里已有全局样式
   （::-webkit-scrollbar 宽 8px ＋ --dsh-scrollbar-thumb，见 dsh-client-ui-theme）。
   曾经在这里写死 6px 宽 ＋ rgba(255,255,255,.14) 的滑块 —— 白色 14% 在白底上完全隐形，
   用户的原话是「没有一个右侧的滑动条」。删掉即继承主题默认（l1），与侧栏列表一致。
   ⚠️ CSS 注释里不要出现反引号：这段是模板字符串，反引号会把它提前截断。 */
.knit-list{flex:1 1 auto;min-height:0;overflow-y:auto;padding:8px;display:flex;flex-direction:column;gap:6px;outline:none}
/* 文档列表**没有网格**：永远一个文档一行（2026-09-29 用户拍板，第四版也是最后一版）。
   ⚠️ 这里曾经有 「.knit-multicol.cols-2」 那一档（JS 按可用宽度算列数、再加类），
   连同 「docLayoutFor」 / 「DOC_TRACK_PX」 / 「DOC_SUMMARY_MIN_PX」 / 「.no-sum」 一起删了 ——
   留着一套永远算不出 2 列的代码，下一个人只会以为它还在生效。
   媒体网格不走这里（它有自己的 「.knit-media-grid」 + CSS auto-fill，不受影响）。 */
.knit-list:focus-visible{box-shadow:inset 0 0 0 1px var(--knit-accent)}
/* 列表行＝**两列的 grid**（2026-09-29 用户追加要求：「文档列表序号放在独立最左边，
   其他数据放在右边」）。第一列＝序号那条竖直的轴（.knit-num），第二列＝其余全部数据
   （.knit-body）。用 grid 而不是「有号才插一个元素」，是因为没有号的条目（时间序 /
   筛选结果 /「其他相关文档」）也要和有的条目**左边缘对齐** —— 轨道一直在，
   正文就永远不会因为少一个序号而左移。
   2026-10-01 补：光对齐还不够 —— **混着**才刺眼（整屏没号时没人觉得缺东西）。所以
   这一屏里有号时，没号的行在同一列渲染一个 .knit-gapmark（·）把格子顶住。 */
/* 行的**静止态没有底色**（2026-09-29 用户反馈：「深色模式下，文档列表没有选中，鼠标没有悬停，
   不需要有背景。或者是说，跟深色模式的最底下的背景一样」）。
   ⚠️ 这里以前写的是 bg-layer-1 —— 浅色主题下它和面板底色都是 #fff（根本看不出来），
   **暗色主题下它比 bg-base 亮一档**，于是每一行都像一张浮起来的小卡片，哪怕没选中、没悬停。
   现在静止态直接 transparent，露出宿主侧边栏的底色（.knit-root / .knit-list 都不画底色）；
   ⚠️ 右栏删除后这段注释里提到的 .knit-pack 已经不存在了（2026-09-29），
   hover 与 .active 各有自己的令牌，
   两者都**不该**跟着改成 transparent（那样一屏灰里就认不出选中态了）。
   ⚠️ 2026-09-30 用户反馈：「悬停跟选中，最外层那个描边，我觉得也不需要了，还是有点影响」
   ⇒ 原来那圈 .5px solid transparent（悬停 / 选中时才上色）**整条删掉**。
   padding 各加 .5px 补回那条边框占掉的宽度，行的几何尺寸与改前逐像素一致
   （所以下面这两条 padding 数字是有来历的，不是随手写的小数）。 */
.knit-doc{display:grid;grid-template-columns:22px minmax(0,1fr);column-gap:8px;align-items:start;
  padding:10.5px 11.5px;border-radius:10px;cursor:pointer;
  background:transparent;
  transition:background .18s,transform .18s,opacity .18s}
.knit-doc:hover{background:var(--knit-hover-bg,rgba(255,255,255,.03));transform:translateX(-2px)}
/* 选中（正在预览）＝**只有灰底**（2026-09-30 用户裁决）。
   ⚠️ 这条的上一版是「中性描边 + 灰底」（2026-09-29 裁决，用来取代更早的品牌色描边）。
   用户这次的原话是「文档列表悬停跟选中，最外层那个描边，我觉得也不需要了」⇒
   描边整条删掉，**选中态只剩灰底**。
   ⚠️ 灰底是选中唯一的分层信号，**不许**跟着改成 transparent（一屏灰里就认不出选中了）。
   ⚠️ hover 与选中的区别现在**只**是底色深浅（--knit-hover-bg / --knit-active-bg），
   不再有任何一圈线。 */
.knit-doc.active{background:var(--knit-active-bg,rgba(255,255,255,.085))}
/* .knit-doc.cursor **故意不设样式**：键盘焦点靠「移动即预览」的预览面板表达，
   再加描边会与 .active 的整块背景重复，显得突兀。
   （曾经有一条 「.knit-multicol .knit-doc.cursor」 的中性环，是为多列网格补的 ——
   多列没了，那条也删了。） */
/* ── 列表进出动效的**静态**部分（v0.17，2026-10-03 用户要求）───────────────
   补间本身在 JS 里用 WAAPI 跑（见 client.js 的 DocRow 与 MOTION_* 那段）—— 高度要按
   量出来的自然高度补间，CSS 的 @keyframes 做不到（height:auto 不可插值）。这里只管两件事：
   ① .leaving ＝正在离开的幽灵行：不吃指针事件、内容裁掉；
   ② 系统开了「减弱动态效果」时，连底色过渡一起去掉（进出本来就不播）。 */
.knit-doc.leaving{pointer-events:none;user-select:none;overflow:hidden}
@media (prefers-reduced-motion: reduce){
  .knit-doc{transition:none}
  .knit-cov-dots,.knit-cov-dot{transition:none}
  .knit-tier,.knit-tier.flash{transition:none}
  .knit-cov-col,.knit-read-row,.knit-out-row,.knit-more-btn,.knit-glyph-mark{transition:none}
}
/* 行一＝**标题行**：Primary 点 + 标题 + 相对时间（**时间靠右**）。
   2026-09-29 这一天里这一行改了三次：先是「序号 + 标题 + 时间」，然后
   「时间跟那个置顶的序号可以一行」（序号留下、标题移出去），再后来
   「序号放在独立最左边」（序号也出去、只剩点与时间）；最后用户要求
   「将时间放到标题同行，时间放在右边，然后标题跟时间就可以以序号平行，居中平行」
   ⇒ 标题**回到这一行**，时间从行尾滑到标题右边。
   序号那一列与这一行**垂直居中**：靠 .knit-num 的 line-height 与标题行高对齐
   （见下面 .knit-num 的说明 —— 两处必须同步改）。 */
.knit-row1{display:flex;align-items:center;gap:8px;margin-bottom:5px}
/* v0.14（Design §11 / §13）：**最左边独立一列**的序号（2026-09-29 用户追加要求）。
   序号是「这个包里的第几篇」，不是分数；Primary 只给一个 5px 黑点 ——
   不是星标、不是徽章、不是 AI 图标。「重要来自位置和结构，不来自图标」。
   ⚠️ 深浅主题都要能看见：用文字色令牌，不写死 #242426（暗色下会消失）。
   ⚠️ 没有序号的行**不渲染这个节点**；那一列由 .knit-doc 的 grid 轨道保着
   （时间序 / 筛选结果 /「其他相关文档」照样和有条目的行左边缘对齐）。
   ⚠️ line-height **19.6px 是把序号与标题第一行居中的唯一手段**：
   它＝.knit-title 的 14px × 1.4。格的 align-items:start 让这一列从卡片顶边
   开始排，所以只要这个行盒与标题行盒等高，两个字号不同的文本就自然居中。
   **改 .knit-title 的字号或行高时，这里必须同步改**，否则序号会与标题错开。 */
.knit-num,.knit-gapmark{grid-column:1;font-size:11px;line-height:19.6px;font-variant-numeric:tabular-nums;
  color:var(--dsw-alias-label-caption,#80868b)}
/* 中性占位标记（2026-10-01 用户反馈）：「其他相关文档」那一节没有序号，空着的那一格
   被读成「漏了一个号」（原话：「没有序号以后左边就空了，视觉上比较割裂，就觉得是个 bug 一样」）。
   没号的行就在同一列放一个最轻的 · —— 不冒充序号，也不让轨道断掉。
   ⚠️ 只有**这一屏里有号**时才渲染（时间序 / 平铺列表整屏都没号 ⇒ 一个标记都没有：
   一屏里要么都有、要么都没有；混着才是刺眼的原因）。
   ⚠️ 几何与 .knit-num 共用同一条选择器 —— 这就是「改一处必须改另一处」的执行方式。 */
/* 右边这一列＝其余全部数据（标题行 / 摘要 / 理由）。
   ⚠️ min-width:0 不能省：轨道是 minmax(0,1fr)，但**单元格本身**默认也是按
   min-content 撑的，不写它标题的省略号和摘要的两行截断就不生效（会把行撑宽）。 */
.knit-body{grid-column:2;min-width:0}
.knit-dot{flex:none;width:5px;height:5px;border-radius:50%;
  background:var(--dsw-alias-text-primary,var(--dsw-alias-label-primary,#242426))}
/* 时间**在标题右边的行尾**（2026-09-29 用户要求「时间放在右边」）。
   ⚠️ 这条推翻了同一天早先的写法（那时候时间跟在点后面左对齐，理由是
   「元信息行读起来像一句话」）—— 时间现在和标题同一行，左对齐会把标题夹在中间。
   靠 .knit-title 的 flex:1 1 auto 把时间挤到行尾；这里只要 flex:none 不被压扁。 */
.knit-time{flex:none;font-size:11px;color:var(--dsw-alias-label-caption,#80868b)}
/* 标题现在和 Primary 点、时间**同行**（见 .knit-row1 的说明；margin-bottom 移到了那一行）。
   仍是单行省略 —— 列表是扫读用的，想看全标题就预览或打开；折行会让每条卡高度不一，
   「移动到下一项」的位移就没法预期。
   flex:1 1 auto + min-width:0 是**时间能被推到行尾、且长标题在时间之前省略**的前提：
   去掉 min-width:0，标题会把整行撑宽（省略号失效）；去掉 flex-grow，时间会紧贴标题而不是靠右。 */
.knit-title{flex:1 1 auto;min-width:0;font-weight:600;font-size:14px;line-height:1.4;
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.knit-sum{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary,#9aa0a6);
  display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.knit-sum.empty{font-style:italic;color:var(--dsw-alias-label-caption,#80868b)}
/* ── 列表行里为什么没有路径（2026-09-29） ────────────────────
   这里曾经是「.knit-meta」（相对路径那一行）。用户否掉了它：
   「文档列表中的文档路径，我觉得不需要出现了，因为点开查看文档详情的时候已经有了，
   所以这里是重复的，隐藏掉」。
   ⇒ **删掉，不是 display:none** —— 预览头的面包屑（.knit-preview-path）已经
   始终显示完整路径，重复的那一份没有存在的理由。
   ⚠️ 不要和「多列砍字段」那条教训混起来：**摘要（.knit-sum）仍然任何情况下都不许
   display:none** —— 那条守的是「不许因为排版窄就静默少给信息」，而路径是**重复信息**。
   ⚠️ 另：本文件整份 CSS 在一个模板串里，**注释里不能出现反引号**（会截断模板）——
   这个教训在这里被踩到过一次（就是写上面这段注释的时候）。
/* ── 曾经在这里的一段：2 列时的卡片 ─────────────────────────
   它按「格子窄了」改排版（时间纵向排、标题折两行、摘要按格子宽让位、路径折两行），
   并顺手把 :hover 的 translateX 关掉。
   **2026-09-29 整段删除**：列表不再有第二列，这些规则一条也匹配不到。
   删的时候**没有**把 「transform:none」 留下来 —— 上面的 「.knit-doc:hover」
   仍然保留 「translateX(-2px)」（单列的悬停位移从来没被这些规则影响过）。 */
.knit-msg{padding:24px 16px;text-align:center;font-size:12px;
  color:var(--dsw-alias-label-caption,#80868b);line-height:1.7}
.knit-notice{margin:6px 8px 0;padding:7px 10px;border-radius:7px;font-size:11px;line-height:1.5;
  background:rgba(255,120,120,.12);border:.5px solid rgba(255,120,120,.3);color:#ffb4b4}
.knit-badge{font-size:10px;margin-right:3px}

/* ── 列表下方的预览面板 ───────────────────────────────
   要让人一眼看出「这是另一层，不是列表的续行」，靠**结构**而不是底色：
   ① 顶部圆角 + 更强的上边界；② 一层向上的柔影。
   ⚠️ 底色**不再**参与分层（2026-09-20 起一律是纯阅读底色），理由见下面那条注释。
   ⚠️ 也不要再拿 bg-layer-2 来做层级：浅色主题下 bg-layer-1/2/3 解析出来全是 #fff，
      换过去等于没换（实测官方 theme 变量）。 */
/* 预览面板的底色：**一律用纯阅读底色**（浅 #fff / 深 #151517）。
   曾经是「先分层灰、用户一滚正文才过渡到白」，用户 2026-09-20 否掉了：
   「下拉出现详情时背景是灰的，这个交互比较差……把它改成整个都是白」。
   分层不靠底色了 —— 靠上边界 + 顶部圆角 + 向上柔影（下面三件仍然都在）。
   ⚠️ 别只看浅色主题：这里必须走 bg-base，深色下它是 #151517；
   写死 #fff 会在暗色主题里白得刺眼。 */
.knit-preview{position:relative;flex:none;display:flex;flex-direction:column;min-height:0;
  border-top:.5px solid var(--dsw-alias-border-l3,rgba(255,255,255,.14));
  border-top-left-radius:12px;border-top-right-radius:12px;
  background:var(--dsw-alias-bg-base,#fff);
  box-shadow:0 -8px 24px rgba(0,0,0,.06)}
body[data-ds-dark-theme] .knit-preview{box-shadow:0 -8px 24px rgba(0,0,0,.38)}
/* 拖拽把手：**绝对定位、不占布局高度**。
   它原来是一条 11px 的普通 flex 行，把 38px 的头整体往下推 —— 用户看到的就是
   「文档名和那几个按钮偏下」。改成浮在头顶的窄条后，头里的内容才真正上下居中。
   高度取 6px：头里的按钮高 24px、在 37.5px 内容区里居中 → 顶边在 6.75px，
   所以 6px 的把手**不会盖住按钮**（盖住会吃掉点击）。 */
.knit-resize{position:absolute;top:0;left:0;right:0;height:6px;z-index:2;
  cursor:ns-resize;background:transparent;
  display:flex;align-items:center;justify-content:center}
.knit-resize::after{content:'';width:44px;height:3px;border-radius:2px;
  background:var(--dsw-alias-border-l3,rgba(255,255,255,.2));transition:background .15s,width .15s}
.knit-resize:hover::after{background:var(--knit-accent);width:64px}
/* 头对齐官方文档预览面板（.dhJKeW_header）：38px 高，
   里面放路径面包屑而不是标题 —— 正文 H1 已经写了标题，重复只添乱。
   ⚠️ 2026-09-30 用户裁决：官方那条 border-l3 底边**不要** ——
   「查看文档详情被引用，上下那两条横线，细细的横线，我觉得也不需要的」。
   头部与引用条 / 正文之间现在只靠留白分层（配合 .knit-links 同时去掉的那条）。 */
.knit-preview-head{box-sizing:border-box;display:flex;align-items:center;gap:4px;
  height:38px;padding:0 6px 0 12px;flex:none}
/* 路径：**可点** —— 用系统默认应用打开这篇本地文档（阅读时多一个入口）。
   目录一律不展开，只留一个「…/」占位（2026-10-01 用户要求：「前面那一串都用三个点点点表示」，
   头部宽度让给文件名）；文件名不收缩。**完整相对路径不丢** —— 在 .knit-preview-path 的悬停提示里。
   ⚠️ 本段在 CSS 那一个大模板串里：注释里**不能出现反引号**（写 .knit-preview-path 这种
   带反引号的类名会把模板提前截断，客户端半边整个加载失败 —— 2026-10-01 又踩一次）。 */
.knit-preview-path{flex:1 1 auto;min-width:0;display:flex;align-items:center;
  margin-right:6px;font-size:12px;white-space:nowrap;overflow:hidden;
  background:transparent;border:none;padding:0;font-family:inherit;text-align:left;
  color:inherit;cursor:pointer}
.knit-preview-path:disabled{cursor:default}
.knit-preview-path:hover:not(:disabled) .knit-preview-name{text-decoration:underline}
.knit-preview-dir{flex:0 0 auto;color:var(--dsw-alias-label-tertiary,rgba(255,255,255,.4))}
.knit-preview-name{flex:0 0 auto;color:var(--dsw-alias-label-primary,#e8eaed)}
/* 正文区把滚动条提到 l2 —— 与官方文档预览面板同一档（那边的 .body 也覆盖这两个变量）。
   不重写 ::-webkit-scrollbar，只覆盖变量，所以宽度/圆角/悬停都跟 DSH 完全一致。 */
.knit-preview-body{--dsh-scrollbar-thumb:var(--dsw-alias-scrollbar-bg-l2);
  --dsh-scrollbar-thumb-hover:var(--dsw-alias-scrollbar-hover-l2);
  flex:1;min-height:0;overflow-y:auto;padding:10px 14px 16px;font-size:12.5px}
.knit-preview-close{flex:none;width:24px;height:24px;border-radius:6px;cursor:pointer;
  display:inline-flex;align-items:center;justify-content:center;font-size:13px;
  background:transparent;border:none;color:var(--dsw-alias-label-secondary,#9aa0a6)}
.knit-preview-close:hover{background:var(--knit-hover-bg,rgba(255,255,255,.03));
  color:var(--dsw-alias-label-primary,#e8eaed)}
.knit-raw{margin:0;white-space:pre-wrap;word-break:break-word;font-size:11.5px;line-height:1.6;
  color:var(--dsw-alias-label-secondary,#9aa0a6);font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.knit-preview-note{font-size:11px;color:var(--dsw-alias-label-caption,#80868b);padding:2px 0 8px}

/* v0.19：代码行的语言徽章（TS / JS / PY …）。
   刻意**不是**一个胶囊：没有底色、没有边框、没有圆角 —— 它是一条弱注释，
   不是标签墙。字号比标题小两档，颜色用 caption，永远不抢标题。
   窄侧边栏里它 flex:none，压缩的是标题（.knit-title 会省略号收尾）而不是它。 */
.knit-lang{flex:none;margin-left:6px;font-size:10px;letter-spacing:.04em;
  text-transform:uppercase;color:var(--dsw-alias-label-caption,#80868b)}

/* ── 代码预览（v0.19）────────────────────────────────────
   轻量：行号栏 + 代码正文。**不做语法高亮、不做折叠、不做 minimap**，
   也没引入 Monaco / CodeMirror —— Knit 不是编辑器（需求 §8 §25）。
   横向滚动只发生在正文那一格（overflow-x:auto + min-width:0），
   行号栏 flex:none 留在左边；纵向滚动仍由外面的 .knit-preview-body 负责，
   所以这里**不开第二个纵向滚动容器**（两个纵向滚动条会互相打架）。 */
.knit-codepane{display:flex;align-items:stretch;min-height:100%;
  font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11.5px;line-height:1.6}
.knit-code-gutter{flex:none;white-space:pre;text-align:right;user-select:none;
  padding:0 8px 0 2px;color:var(--dsw-alias-label-caption,#80868b);
  border-right:1px solid var(--dsw-alias-border-l3,rgba(255,255,255,.08))}
.knit-code-src{flex:1 1 auto;min-width:0;margin:0;padding:0 0 0 10px;
  white-space:pre;overflow-x:auto;color:var(--dsw-alias-label-primary,#e8eaed)}

/* ── 引用条（v0.12）────────────────────────────────────
   夹在预览头与正文之间的一层。全用中性令牌：它是「信息」，不是「操作」。
   ⚠️ 2026-09-30 用户裁决：它自己那条 border-l2 底边**删掉** —— 与预览头的底边
   一上一下两条细线把这一小块夹成了独立一截，用户的原话是「有点割裂」。
   现在这一层不画任何横线，收紧的 padding 就是它的边界。
   注意 CSS 里不要写反引号 —— 这段样式是模板字符串，一个反引号就会把它截断。 */
.knit-links{flex:none;font-size:11px;color:var(--dsw-alias-label-secondary,#9aa0a6)}
.knit-links-state{padding:5px 12px;color:var(--dsw-alias-label-caption,#80868b)}
.knit-links-head{box-sizing:border-box;display:flex;align-items:center;gap:6px;width:100%;
  padding:5px 12px;background:transparent;border:none;cursor:pointer;text-align:left;
  font:inherit;color:inherit}
.knit-links-head:hover{background:var(--knit-hover-bg,rgba(255,255,255,.03))}
.knit-links-arrow{flex:none;width:10px;font-size:9px;opacity:.75}
.knit-links-summary{flex:1 1 auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.knit-links-note{padding:2px 12px 6px;color:var(--dsw-alias-label-caption,#80868b)}
.knit-links-body{padding:0 12px 8px;max-height:180px;overflow:auto}
.knit-links-group + .knit-links-group{margin-top:6px}
.knit-links-label{font-weight:600;color:var(--dsw-alias-label-caption,#80868b);margin-bottom:2px}
.knit-links-empty{color:var(--dsw-alias-label-caption,#80868b);padding:1px 0}
.knit-links-list{list-style:none;margin:0;padding:0}
.knit-link-row{box-sizing:border-box;display:block;width:100%;text-align:left;padding:2px 4px;
  border:none;background:transparent;border-radius:4px;cursor:pointer;font:inherit;color:inherit}
.knit-link-row:hover{background:var(--knit-hover-bg,rgba(255,255,255,.03))}
.knit-link-name{display:block;color:var(--dsw-alias-label-primary,#e8eaed);
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.knit-link-path{display:block;font-size:10px;color:var(--dsw-alias-label-caption,#80868b);
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap}

/* ── 类型切换（文档 / 图片与视频 / 全部）────────────── */
/* v0.14（Design §20）：**不再是三个并排的灰底按钮**，改成下划线式页签 ——
   选中的那个用「深色文字 + 2px 深色下划线」表达。
   ⚠️ 2026-09-29 用户裁决：这条**覆盖**了早先那条「选中填充背景灰就可以」。
   当时用户的原话是「选中的时候不用加绿色、蓝色的描边，就跟下面列表一样」——
   诉求是「别用品牌色描边」；现在连灰底也不要了，层级交给下划线，
   依然不许出现 --knit-accent / --knit-accent-fill（Design §8：灰阶分层）。
   ⚠️ 2026-09-30 用户反馈：页签条底下原本还有一条全宽 hairline（border-l1）——
   「最细最淡那条横线」与下面的列表割裂，**删掉**。层级现在只由选中项自己那条
   2px 下划线表达，页签条本身不画线（也不是「下划线悬空」：它画在自己的文字下面）。
   ⚠️ 排序切换（.knit-seg-btn，Design §18）是**另一个控件**，它保持灰底不变。 */
.knit-types{display:flex;gap:14px;padding:0 12px;flex:none}
.knit-type-btn{flex:none;height:30px;padding:0;cursor:pointer;
  border:none;border-bottom:2px solid transparent;background:transparent;
  color:var(--dsw-alias-label-secondary,#9aa0a6);font-family:inherit;font-size:14px;
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
  transition:color .15s,border-color .15s}
.knit-type-btn:hover{color:var(--dsw-alias-label-primary,#e8eaed)}
.knit-type-btn.active{color:var(--dsw-alias-label-primary,#e8eaed);font-weight:600;
  border-bottom-color:var(--dsw-alias-label-primary,#e8eaed)}

/* ── 图片与视频：方形缩略图网格 ─────────────────────
   **列数由浏览器自己数**（用户 2026-09-20 点名的机制，取自 AIGC 资产中心的图片网格）：
   auto-fill + 固定下限 104px —— 面板拖宽约 120px 就多出一列，格子大小基本不变。

   ⚠️ **1fr 是有意写的，不要改成固定轨道**。第一版把上下限都写成 JS 算的「实际格宽」，
   结果列数被**条目数**锁死（条目 >8 个就把格宽压到 64px）：实测 400→1200px 全是 5 列，
   只有格子从 64px 被吹到 224px —— 用户的原话是「它不是真的响应式」。
   改成 minmax(104px, 1fr) 后列数只跟**可用宽度**有关，与有几个媒体无关。

   ⚠️ 但**下限也不能省**：只写 1fr 会让只有一个媒体时那张图撑满整个面板宽度。

   ⚠️ **网格不许设 maxHeight、也不自己滚动**。前两版把高度封在「两行」并给网格加
   overflow-y:auto，真机上第三行只能露出一点点（用户原话：「本来有三行，结果第三行
   只显示了一点点，应该纵向也完整显示」）—— 封顶高度是按「两行」算死的，与面板实际多高无关，
   必然截断。现在有多少行就铺多少行，纵向滚动统一交给 .knit-list（与资产中心一致）。

   fallback 那一行（3 列）是给不认 minmax(变量) 的旧内核用的，必须写在前面。
   --knit-media-cell 由 JS 按当前列数下发，只用于 height 的方形兜底。
   ⚠️ 注释里不要出现反引号 —— 这段是模板字符串，反引号会把它提前截断（见 AGENTS §6.9）。 */
.knit-media-grid{display:grid;gap:${MEDIA_GAP_PX}px;
  --knit-media-label:block;
  --knit-media-track:${MEDIA_TRACK_PX}px;
  --knit-media-cell:120px;
  grid-template-columns:repeat(3,1fr);
  grid-template-columns:repeat(auto-fill,minmax(var(--knit-media-track,104px),1fr));
  padding:8px 12px 16px;align-content:start;min-height:0}
/* 分区里的网格：不留内边距。滚动一律交给 .knit-list，网格自己**不滚** ——
   嵌套滚动会在「全部」里变成滚动陷阱，而且封顶高度必然截断最后一行。 */
.knit-media-grid.in-section{padding:0}
.knit-media-card{min-width:0;cursor:pointer;border-radius:10px}
.knit-media-thumbbox{position:relative;width:100%;height:var(--knit-media-cell,auto);aspect-ratio:1/1;
  border-radius:9px;overflow:hidden;
  background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.06));
  border:.5px solid var(--dsw-alias-border-l2,rgba(255,255,255,.1));
  transition:border-color .15s,box-shadow .15s}
.knit-media-card:hover .knit-media-thumbbox{border-color:var(--dsw-alias-border-l4,rgba(255,255,255,.22))}
/* 键盘移动 → 只有中性描边。必须排在 .active 之前：键盘光标默认常驻第一项，
   若排在后面会把「正在预览」的品牌色描边盖成灰色，点第一张图就看不到选中态。 */
.knit-media-card.cursor .knit-media-thumbbox{
  border-color:var(--dsw-alias-border-l4,rgba(255,255,255,.22));
  box-shadow:0 0 0 1.5px var(--dsw-alias-interactive-bg-active,rgba(255,255,255,.1))}
/* 正在预览 → 品牌色描边（排在 cursor 之后，确保同时命中时以「选中」为准） */
.knit-media-card.active .knit-media-thumbbox{
  border-color:var(--knit-accent);box-shadow:0 0 0 1.5px var(--knit-accent)}
/* 格子窄到 96px 以下时，文件名与时间会挤成一团 —— 整块让位给缩略图（mediaLayoutFor 的 scaled） */
.knit-media-meta{margin-top:5px;display:var(--knit-media-label,block)}
.knit-media-name{display:flex;align-items:center;gap:3px;font-size:11.5px;line-height:1.3;
  color:var(--dsw-alias-label-primary,#e8eaed);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.knit-media-time{margin-top:1px;padding:0 1px;font-size:10px;color:var(--dsw-alias-label-caption,#80868b)}

/* ── 缩略图本体（图片 / 视频首帧 + 播放三角 + 时长）── */
.knit-thumb{position:absolute;inset:0}
.knit-thumb img,.knit-thumb video{width:100%;height:100%;object-fit:cover;display:block;background:#000}
.knit-thumb-play{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;
  color:#fff;pointer-events:none}
.knit-thumb-play svg{width:32%;height:32%;fill:currentColor;opacity:.95;
  filter:drop-shadow(0 1px 4px rgba(0,0,0,.65))}
.knit-thumb-dur{position:absolute;right:5px;bottom:5px;padding:1px 5px;border-radius:5px;
  background:rgba(0,0,0,.7);color:#fff;font-size:10px;line-height:1.5;font-variant-numeric:tabular-nums;
  pointer-events:none}

/* ── 「全部」按类型分上下两区（文档 / 图片与视频）──── */
.knit-section{display:flex;flex-direction:column;gap:6px}
.knit-section-head{display:flex;align-items:center;gap:6px;padding:0 2px}
.knit-section-title{font-size:11px;font-weight:600;color:var(--dsw-alias-label-secondary,#9aa0a6)}
.knit-section-count{font-size:10.5px;color:var(--dsw-alias-label-caption,#80868b);
  font-variant-numeric:tabular-nums}
.knit-section-more{margin-left:auto;flex:none;padding:0;border:none;background:transparent;
  cursor:pointer;font-family:inherit;font-size:10.5px;color:var(--knit-accent)}
.knit-section-more:hover{text-decoration:underline}

/* ── 预览面板里的图片 / 视频 ───────────────────────── */
.knit-preview-body.is-media{display:flex;align-items:center;justify-content:center;
  padding:12px;background:rgba(0,0,0,.22)}
.knit-preview-media{max-width:100%;max-height:100%;object-fit:contain;border-radius:6px}
video.knit-preview-media{width:100%;background:#000}

/* Knit 图标：不跟随文本色，浅色模式纯黑、暗色模式纯白。
   DSH 的暗色信号是 body[data-ds-dark-theme]（官方 CSS 用的就是这个）。 */
.knit-icon{color:#000}
body[data-ds-dark-theme] .knit-icon{color:#fff}

/* 入口按钮：挂在会话头部右侧与输入框工具行两处 list 座位上 */
/* 悬停偷看浮层：自己画的，不碰框架（所以不会推开右侧栏） */
.knit-peek-anchor{display:inline-flex;position:relative}
.knit-peek{position:fixed;z-index:60;display:flex;flex-direction:column;max-height:60vh;
  padding:5px;border-radius:12px;box-shadow:0 12px 32px rgba(0,0,0,.32);
  background:var(--dsw-alias-bg-layer-2,#2c2c2e);
  border:.5px solid var(--dsw-alias-border-l4,rgba(255,255,255,.12));
  color:var(--dsw-alias-label-primary,#e8eaed)}
.knit-peek-head{display:flex;align-items:center;gap:7px;padding:5px 7px 7px;
  font-size:11px;color:var(--dsw-alias-label-caption,#80868b)}
.knit-peek-list{display:flex;flex-direction:column;gap:1px;min-height:0;overflow-y:auto}
.knit-peek-doc{display:flex;align-items:baseline;gap:8px;width:100%;padding:7px 8px;
  border:none;border-radius:8px;cursor:pointer;text-align:left;font-family:inherit;
  background:transparent;color:inherit}
.knit-peek-doc:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.08))}
.knit-peek-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px}
.knit-peek-time{flex:none;font-size:10.5px;color:var(--dsw-alias-label-caption,#80868b)}
.knit-peek .knit-peek-hint{padding:7px;font-size:10.5px;
  color:var(--dsw-alias-label-caption,#80868b)}

.knit-entry{display:inline-flex;align-items:center;justify-content:center;flex:none;
  width:28px;height:28px;padding:0;border:none;border-radius:8px;cursor:pointer;
  background:transparent;color:var(--dsw-alias-label-secondary,#9aa0a6);
  transition:background .15s}
.knit-entry:hover{background:var(--knit-hover-bg,rgba(255,255,255,.03))}
.knit-entry:active{transform:scale(.94)}

/* 全屏阅读：藏掉头部与列表，只留预览 */
.knit-root.fullscreen .knit-head,
.knit-root.fullscreen .knit-bar,
.knit-root.fullscreen .knit-types,
.knit-root.fullscreen .knit-list{display:none}
/* v0.19 修补（2026-10-07 用户反馈）：**使用情况也是列表上方的观察层**，全屏时同样让位。
   这条规则漏了它 ⇒ 开着「使用情况」再点全屏，Lens 仍占掉面板上方约三分之一，
   预览被挤在下面 —— 看起来就像「全屏没生效」。它是 flex:none 的自然高度，
   不是浮层，所以必须显式 display:none，光靠预览 flex:1 抢不回来。 */
.knit-root.fullscreen .knit-usage{display:none}
/* 全屏时预览铺满整个面板：圆角与向上柔影是「浮在列表上」的隐喻，这里没有列表，去掉 */
.knit-root.fullscreen .knit-preview{flex:1 1 auto;max-height:none;
  border-top:none;border-radius:0;box-shadow:none}
`

    /**
     * 把样式表插进文档一次。
     * @returns {void}
     */
    function ensureStyle() {
      if (typeof document === 'undefined') return
      if (document.getElementById(STYLE_ID)) return
      const el = document.createElement('style')
      el.id = STYLE_ID
      el.textContent = CSS
      document.head.appendChild(el)
    }

    /* ── 用户偏好 ───────────────────────────────────── */

    /**
     * 读一个 localStorage 偏好。
     * @param {string} key - 键
     * @returns {string|null} 值
     */
    function readPref(key) {
      try {
        return window.localStorage.getItem(key)
      } catch {
        return null
      }
    }

    /**
     * 写一个 localStorage 偏好。
     * @param {string} key - 键
     * @param {string} value - 值
     * @returns {void}
     */
    function writePref(key, value) {
      try { window.localStorage.setItem(key, value) } catch { /* 隐私模式忽略 */ }
    }

    /**
     * 读用户上次选的排序方式。
     * @returns {'relevance'|'time'} 排序方式
     */
    function readSortPref() {
      return readPref(SORT_KEY) === 'time' ? 'time' : 'relevance'
    }

    /**
     * 读上次选择的列表类型，非法值回落到 doc。
     * @returns {'doc'|'media'|'all'} 类型
     */
    function readKindPref() {
      const v = readPref(KIND_KEY)
      return v === KIND_MEDIA || v === KIND_ALL || v === KIND_CODE ? v : KIND_DOC
    }

    /**
     * 读上次是否打开了「使用情况」。**默认关**（没写过就是关）。
     * @returns {boolean} 是否记账
     */
    function readUsagePref() {
      return readPref(USAGE_KEY) === '1'
    }

    /**
     * 把预览高度比例夹到合法区间。
     * @param {number} value - 原始比例
     * @returns {number} 夹紧后的比例
     */
    function clampRatio(value) {
      const n = Number(value)
      if (!Number.isFinite(n)) return DEFAULT_RATIO
      return Math.min(MAX_RATIO, Math.max(MIN_RATIO, n))
    }

    /* ── 曾经在这里的三个纯函数：右栏几何 ────────────────────
       `clampPackW`（把右栏宽度夹进 260–420）/ `clampFloatPos`（把浮窗夹进视口）/
       `nearRightEdge`（指针是否落在右缘 28px 的吸附带里）。
       **2026-09-29 随右栏一起删除**：没有可拖宽的面板、没有浮窗、没有吸附，
       这三个函数一个都不可能再被调用。 */

    /**
     * 读用户上次拖的预览高度。
     * @returns {number} 0.2–0.8
     */
    function readRatioPref() {
      const raw = readPref(RATIO_KEY)
      return raw === null ? DEFAULT_RATIO : clampRatio(Number(raw))
    }

    /* ── 路径处理 ───────────────────────────────────── */

    /**
     * 组件级编码一个地址段：`:` 保持字面量（盘符要按原样读）。
     * @param {string} seg - 段
     * @returns {string} 编码后的段
     */
    function encodeSegment(seg) {
      return encodeURIComponent(seg).replace(/%3A/gi, ':')
    }

    /**
     * 拼一个 `dsh-resource://file/session/<id>/<path>` 地址，交给官方预览认领。
     * 归一化规则与官方 sessionFileAddress 一致。
     * @param {string} sessionId - 会话 id
     * @param {string} relPath - 相对工作区根的 `/` 分隔路径
     * @returns {string} 资源地址
     */
    function sessionFileAddress(sessionId, relPath) {
      const norm = String(relPath || '')
        .replace(/\\/g, '/')
        .replace(/^(?:\.\/)+/, '')
      const tail = norm.split('/').filter(Boolean).map(encodeSegment).join('/')
      return `dsh-resource://file/session/${encodeSegment(sessionId)}/${tail}`
    }

    /**
     * 把 Markdown 里的相对图片地址解析成工作区相对路径。
     *
     * 带协议的（http: / data: / file:…）与页内锚点一律返回空串 —— 那些交给 MarkdownText 自己处理。
     *
     * @param {string} docRel - 当前文档的工作区相对路径
     * @param {string} src - Markdown 里写的原始地址
     * @returns {string} 工作区相对路径；不适用时为空串
     */
    function resolveRelative(docRel, src) {
      const clean = String(src || '').trim()
      if (!clean) return ''
      if (/^[a-z][a-z0-9+.-]*:/i.test(clean)) return ''
      if (clean.startsWith('#') || clean.startsWith('//')) return ''

      const cut = clean.search(/[?#]/)
      const pathOnly = cut === -1 ? clean : clean.slice(0, cut)
      const dir = docRel.includes('/') ? docRel.slice(0, docRel.lastIndexOf('/')) : ''
      const segments = (dir ? `${dir}/${pathOnly}` : pathOnly).split('/')

      const out = []
      for (const seg of segments) {
        if (!seg || seg === '.') continue
        if (seg === '..') { out.pop(); continue }
        out.push(seg)
      }
      return out.join('/')
    }

    /**
     * 把工作区相对路径拆成「目录 / 文件名」，给预览头做面包屑。
     *
     * 官方文档预览面板就是这么做的（路径靠右、目录用 tertiary、文件名用 primary），
     * 好处是**文件名永远可见**、长目录靠左被裁掉 —— 而预览头如果直接重复正文的 H1，
     * 用户会看到「列表行标题 / 预览头标题 / 正文标题」三遍同一个词，
     * 反而分不清哪块是列表、哪块是详情。
     *
     * @param {string} rel - 工作区相对路径，如 `a/b/c.md`
     * @returns {{dir: string, name: string}} 目录（含结尾斜杠）与文件名
     */
    function splitRelPath(rel) {
      const path = String(rel == null ? '' : rel)
      const cut = path.lastIndexOf('/')
      if (cut < 0) return { dir: '', name: path }
      return { dir: path.slice(0, cut + 1), name: path.slice(cut + 1) }
    }

    /**
     * 把工作区根与相对路径拼成绝对路径（拿不到宿主给的 path 时的兜底）。
     *
     * @param {string} root - 工作区根（宿主返回的绝对路径）
     * @param {string} rel - 工作区相对路径
     * @returns {string} 绝对路径；拼不出来就返回空串
     */
    function joinPath(root, rel) {
      const base = String(root == null ? '' : root).replace(/\/+$/, '')
      const tail = String(rel == null ? '' : rel).replace(/^\/+/, '')
      if (!base) return ''
      if (!tail) return base
      return `${base}/${tail}`
    }

    /**
     * 给 MarkdownText 的相对路径图片解析器。
     *
     * 契约（从 ui-primitives 实现反推）：返回的对象要有 `resolve(src)`，
     * 返回值最终会被 `new URL(v)` 解析并只接受 http/https/blob/data —— 所以
     * 返回同源相对地址（`/knit/api/raw?...`）是合法的。
     *
     * @param {string} sessionId - 会话 id
     * @param {string} docRel - 当前文档的工作区相对路径
     * @returns {{resolve: (src: string) => (string|undefined)}} 解析器
     */
    function pathImagesFor(sessionId, docRel) {
      return {
        resolve(src) {
          const rel = resolveRelative(docRel, src)
          if (!rel) return undefined
          return `${RAW_API}?sessionId=${encodeURIComponent(sessionId)}&rel=${encodeURIComponent(rel)}`
        },
      }
    }

    /**
     * 人类可读的相对时间。
     *
     * ⚠️ **文案必须走 `t()`。** 这六条原先硬编码中文，英文界面下会漏出「3 分钟前」——
     * 2026-09-19 的真机截图把它抓出来了（`test/i18n.test.mjs` 有守卫：
     * 英文渲染出来的整棵树里不许出现汉字）。
     *
     * @param {number} ms - 文件 mtime（epoch ms）
     * @param {number} now - 当前时间
     * @returns {string} 刚刚 / X分钟前 / X小时前 / 昨天 / X天前 / 月日（按当前语言）
     */
    function relTime(ms, now) {
      const diff = Math.max(0, now - ms)
      const min = Math.floor(diff / 60000)
      if (min < 1) return t('time.justNow')
      if (min < 60) return t('time.minutesAgo', { n: min })
      const hour = Math.floor(min / 60)
      if (hour < 24) return t('time.hoursAgo', { n: hour })
      const day = Math.floor(hour / 24)
      if (day === 1) return t('time.yesterday')
      if (day < 30) return t('time.daysAgo', { n: day })
      const d = new Date(ms)
      return t('time.monthDay', { month: d.getMonth() + 1, day: d.getDate() })
    }

    /**
     * 拼媒体文件的同源原始字节地址（缩略图与就地预览都走它，宿主支持 Range）。
     * @param {string} sessionId - 会话 id
     * @param {string} rel - 工作区相对路径
     * @returns {string} `/knit/api/raw?...`
     */
    function mediaUrl(sessionId, rel) {
      return `${RAW_API}?sessionId=${encodeURIComponent(sessionId)}&rel=${encodeURIComponent(rel)}`
    }

    /**
     * 秒 → `m:ss` / `h:mm:ss`，用于视频时长角标。
     * @param {number} seconds - 秒
     * @returns {string} 时长文本
     */
    function fmtDuration(seconds) {
      const total = Math.max(0, Math.round(Number(seconds) || 0))
      const h = Math.floor(total / 3600)
      const m = Math.floor((total % 3600) / 60)
      const s = total % 60
      const pad = (n) => String(n).padStart(2, '0')
      return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`
    }

    /** 条目是不是图片/视频。 */
    function isMedia(doc) {
      return !!doc && (doc.kind === 'image' || doc.kind === 'video')
    }

    /* ── 组件 ───────────────────────────────────────── */

    /**
     * 一条文档卡片。
     *
     * 相关性**不做任何可视化**：排序本身已经表达了相关度，名次就是答案。
     * 曾经加过百分比数字和长条，实测都是噪音 —— 数字会被误读成绝对概率，
     * 长条对「找到那篇文档」这件事没有帮助。
     *
     * `cursor` 这个 class 保留在 DOM 上（键盘焦点位置，可观测、也给测试用），
     * 但**不配任何样式**：既然是「移动即预览」，预览面板本身就是焦点指示。
     *
     * @param {{doc:object,now:number,active:boolean,cursor:boolean,relevance:boolean,onSelect:Function,onOpenTab:Function}} props - 渲染入参
     * @returns {import('react').ReactElement} 元素
     */
    /**
     * 键盘空间导航：算出「按这个方向键之后该到第几项」。
     *
     * 抽成纯函数是为了**可测**：真实宽度要靠 `ResizeObserver` 量，测试环境里量不到，
     * 列数永远是 1 —— 那多列的分支就永远跑不到（§6.12 说的「空转的绿灯」）。
     *
     * 语义：
     * - `ArrowDown` / `ArrowUp`：走**相邻项**（DOM 顺序 = 阅读顺序，多列时视觉上就是横向走）
     * - `ArrowLeft` / `ArrowRight`：**只在多列时**跨一整行（步长 = 列数）；
     *   到行首再按左 / 到行尾再按右时**停在本行**，不回绕 —— 回绕会让「往左」
     *   突然跳到上一行末尾，方向感反而更差
     * - `Home` / `End`：首项 / 末项
     *
     * @param {number} index - 当前下标（<0 表示还没有光标，按第 0 项算）
     * @param {string} key - 键名
     * @param {number} count - 条目总数
     * @param {number} columns - 当前列数（1 = 单列，此时 ←→ 不参与）
     * @returns {number} 目标下标；不该处理这个键时返回 -1
     */
    function nextIndexFor(index, key, count, columns) {
      if (!(count > 0)) return -1
      const here = index < 0 ? 0 : Math.min(index, count - 1)
      const last = count - 1
      if (key === 'ArrowDown') return Math.min(last, here + 1)
      if (key === 'ArrowUp') return Math.max(0, here - 1)
      if (key === 'Home') return 0
      if (key === 'End') return last
      const rowWidth = columns > 1 ? columns : 0
      if (rowWidth > 0 && (key === 'ArrowLeft' || key === 'ArrowRight')) {
        const rowStart = Math.floor(here / rowWidth) * rowWidth
        const rowEnd = Math.min(last, rowStart + rowWidth - 1)
        const step = key === 'ArrowRight' ? 1 : -1
        return Math.min(rowEnd, Math.max(rowStart, here + step))
      }
      return -1
    }

    /**
     * 列表项在 DOM 里的稳定 id（供 `role="option"` + `aria-activedescendant` 使用）。
     *
     * ⚠️ 之前这里**只给容器加了 `role="listbox"`，选项却是裸 div** ——
     * 屏幕阅读器读到的是「一个叫『最近文档』的列表框，里面 8 个无语义元素」：
     * 既播报不出条目数，也播报不出当前选中项。这是多列改造之前就有的缺陷，
     * 但多列让「当前在哪一项」更难表达，所以一起补上。
     *
     * ⚠️ **id 必须由 rel 稳定推导，不能用计数器** —— `aria-activedescendant` 要指向
     * 真实存在的 id，而 id 在渲染期自增的话，同一篇文档在不同帧会拿到不同 id
     * （渲染顺序、过滤、轮询刷新都会变），指向就会漂。用哈希则同一篇永远同一个 id。
     * 前缀保留可读部分纯粹是为了调试时看得懂。
     */
    /**
     * 一个条目「为什么在 Context Pack 里」的文案（v0.14）。
     *
     * 宿主只给**结构化理由**（码 + 命中的词 + 跨了几个字段），文案在这里翻译 ——
     * 与宿主错误码同一套纪律（AGENTS.md §4.5）。
     *
     * ⚠️ 只输出**可核验的事实**：命中了哪个词、被谁引用、文件角色是什么。
     * **不要**在这里写「可能对你的任务有帮助」这类无法验证的推断 ——
     * Context Pack 的全部价值就是「每条都能说出凭什么」。
     *
     * @param {{code?: string, terms?: string[]}} [reason] - `context.js` 的 `reason`
     * @returns {string} 文案；没有理由时返回空串（时间序 / 非相关模式）
     */
    function whyText(reason) {
      if (!reason || typeof reason.code !== 'string') return ''
      const terms = Array.isArray(reason.terms) ? reason.terms.filter(Boolean) : []
      // 最多列两个词：理由行是**一行**，列多了会把列表读成段落。
      // 分隔符用「 · 」而不是「、」（2026-09-29 用户要求把这条理由压得更克制：
      // 「直接命中：knit · client」）—— 它读起来是**标签 + 值**，不是一句话。
      const shown = terms.slice(0, 2).join(' · ')
      const key = `why.${reason.code}`
      // 词典里没有这个码就把码本身显示出来 —— 宿主加了新码而客户端还没跟上时，
      // 用户看到的是 `why.xxx` 这种明显异常，而不是一条静默的空行。
      if (!terms.length) {
        const plain = `${key}Plain`
        return ZH[plain] !== undefined ? t(plain) : t(key)
      }
      return t(key, { term: shown })
    }

    function docOptionId(doc) {
      const rel = String(doc.rel || doc.path || '')
      const safe = rel.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 48)
      let hash = 2166136261
      for (let i = 0; i < rel.length; i += 1) {
        hash ^= rel.charCodeAt(i)
        hash = Math.imul(hash, 16777619)
      }
      return `knit-opt-${safe}-${(hash >>> 0).toString(36)}`
    }

    /* ── v0.18 Context Usage Lens 的纯函数 ────────────────────────────
       这一层只把**已经有的事实**重新组织一遍：不新增采集、不新增存储、不新增事件、
       不新增第二个生命周期口径。「能派生就不要存储」—— Coverage 是拿当前 Context
       Pack 的三层 rels 加上 `usage.lifecycle` **现算**出来的，没有任何一份自己的 state。
       ⚠️ 全部是纯函数（不吃 React、不读 DOM），所以测试可以直接对拍。
       ⚠️ 这一段**不含反引号**，整段可以直接放进 CSS/代码模板串里。 */

    /** 生命周期四态的 glyph。**不是颜色、不是徽章** —— 它只是一枚字符。
     *  ⚠️ 四态一律中性：不许「绿=已读 / 红=未读 / 黄=更新」——
     *  生命周期是**事实**，不是风险等级（PRD §7.3）。 */
    const LIFE_GLYPH = {
      unread: '○',
      read: '●',
      updated_after_read: '△',
      reread_after_update: '↻',
    }

    /** 某篇的读取状态：**没有记录就是未读**（这是事实，不是猜测）。
     *  认不出的状态一律退回 `unread` —— 宿主加了新状态时，界面显示「未读」而不是空白。 */
    function lifeStatusOf(lifecycle, rel) {
      const row = lifecycle && typeof lifecycle === 'object' ? lifecycle[rel] : null
      const status = row && typeof row.status === 'string' ? row.status : 'unread'
      return LIFE_GLYPH[status] ? status : 'unread'
    }

    /** Coverage：三层各自的 `{ total, read, rels }`。
     *  `tierRels` = `{ primary: [...rel], supporting: [...], related: [...] }`；
     *  `rels` 里每一项带 `read` 布尔（状态点要用它）。
     *  ⚠️ 分母是**这一层当前真实有几篇**，不是 Context Pack 的 `matched/total`；
     *  所以 Primary 不存在时是 `{ total: 0, read: 0, rels: [] }`，面板显示 `0 / 0`
     *  —— Knit 不能假设每一份上下文都有 Primary。 */
    function coverageOf(tierRels, lifecycle) {
      const out = {}
      for (const key of ['primary', 'supporting', 'related']) {
        const list = tierRels && Array.isArray(tierRels[key]) ? tierRels[key] : []
        const rels = []
        let read = 0
        for (const item of list) {
          const rel = typeof item === 'string' ? item : (item && item.rel)
          if (!rel) continue
          const isRead = lifeStatusOf(lifecycle, rel) !== 'unread'
          if (isRead) read += 1
          rels.push({ rel, read: isRead })
        }
        out[key] = { total: rels.length, read, rels }
      }
      return out
    }

    /** 包外读取的**事实排序**：读得最多的在前，同次数按**最后读**的先后。
     *  ⚠️ 宿主回的是**首次读的顺序**（`seq` = firstRead.seq，阅读顺序）；面板要回答的是
     *  「哪几篇被反复读」—— 两件事，所以在客户端重排，不动宿主。
     *  ⚠️ 载荷里没有 `lastRead.seq`（只有首次读的 `seq` 与 `lastReadAt`），
     *  于是同计数时按 `lastReadAt` 降序 —— 它对应的就是规格里的「最后读的那一次更靠前」。 */
    function groupOutsideDocs(outsideDocs) {
      const list = Array.isArray(outsideDocs) ? outsideDocs.slice() : []
      return list.sort((a, b) => {
        const ca = Number(a && a.count) || 0
        const cb = Number(b && b.count) || 0
        if (cb !== ca) return cb - ca
        const ta = Number(a && a.lastReadAt) || 0
        const tb = Number(b && b.lastReadAt) || 0
        if (tb !== ta) return tb - ta
        const sa = Number(a && a.seq) || 0
        const sb = Number(b && b.seq) || 0
        if (sb !== sa) return sb - sa
        return String((a && a.rel) || '').localeCompare(String((b && b.rel) || ''))
      })
    }

    /** 最近一次 Context Delta 按「进 / 出 / 换层」拆开（只拆，不排序、不丢弃）。
     *  ⚠️ v0.15 那种把 `appeared` 写成**字符串数组**的旧载荷也认 ——
     *  客户端不能因为宿主版本不同就崩。 */
    function groupDelta(delta) {
      const out = { enter: [], leave: [], move: [] }
      if (!delta) return out
      const push = (target, item) => {
        const rel = typeof item === 'string' ? item : (item && item.rel)
        if (!rel) return
        target.push(typeof item === 'string' ? { rel } : item)
      }
      for (const item of Array.isArray(delta.appeared) ? delta.appeared : []) push(out.enter, item)
      for (const item of Array.isArray(delta.disappeared) ? delta.disappeared : []) push(out.leave, item)
      for (const item of Array.isArray(delta.moved) ? delta.moved : []) push(out.move, item)
      return out
    }

    /** 面板矮到这个高度以下就进「小高度」档：只留 Summary / Coverage / Recent Read，
     *  Outside / Delta 收成标题（点开照常能用）。⚠️ 不是「藏起来」，是「别先占高度」。 */
    const COMPACT_PANEL_PX = 420
    /** 包外读取默认最多铺几行，其余折成「还有 N 篇」。 */
    const MAX_OUTSIDE_SHOWN = 10
    /** 上下文变化：收起时最多 3 条，展开后每个分类最多 5 条（v0.17 规则，保持不变）。 */
    const MAX_DELTA_SHOWN = 3
    const MAX_DELTA_GROUP = 5
    /** 点 Coverage 之后那一层高亮多久（毫秒）。只是「我把你送到这儿了」的一下提示。
     *  v0.18 UI 迭代（md §十七）：原写 500~700ms、取 650；2026-10-06 用户看真机后定成 **1200**，
     *  「停留久一点才看得清是哪一层」。CSS 里 `.knit-tier{transition:background 1.2s}` 必须同步。 */
    const FLASH_MS = 1200

    /* ── 列表进出动效（v0.17）─────────────────────────────────────────
       用户原话（2026-10-03）：「文档列表，新读取跟挤掉旧的未读的，这里的交互可能要优化，
       因为现在是一闪一闪的，就非常的快……如果说从当前的，如辅助上下文中新增，它应该是
       从低向上的，有种交互动效飞上的感觉，然后消失的时候从上到下，就隐掉了」。

       手感来自 `02_方案与 Demo/knit-list-motion-prototype.html`（用户点头的那一版）：
       缓动 cubic-bezier(.22,1,.36,1)、进入 translateY(26px)→0 + 渐现 + blur(3px)→0、
       离开高度收到 0 且**自上而下**擦掉。参数照抄原型，不要再另调。

       ⚠️ 只碰**文档行**（`.knit-doc`）：媒体格子是网格布局，收起高度没有意义。
       ⚠️ 补间用 WAAPI（`Element.animate`）手写，不用 @keyframes —— 高度要按量出来的
       自然高度补间，而 CSS 里 `height:auto` 不可插值。
       ⚠️ 行节点是按 key 复用的（`doc.path || doc.rel`），所以「闪」不是重挂 —— 是增删
       瞬间落位、一点过渡都没有。因此动效分三件独立的事：**新来的行自己飞进来**、
       **走了的行留一个幽灵行把高度收掉**（React 一删节点就没机会补间了）、
       **活下来的行换了位置（换层 / 重排）走 FLIP** —— 量出新位置、先从老位置拉回来
       再补间归位，逻辑也在 `KnitBody` 那次提交后的 layout effect 里（那里才有列表）。 */
    const MOTION_ENTER_MS = 320
    const MOTION_EXIT_MS = 260
    const MOTION_STAGGER_MS = 45
    const MOTION_STAGGER_MAX = 6
    const MOTION_EASE = 'cubic-bezier(.22,1,.36,1)'
    /** 幽灵行所在的「区」：分层视图用层名，平铺与「全部」各一个 —— 幽灵要插回原位。 */
    const MOTION_TIER_FLAT = 'flat'
    const MOTION_TIER_ALL_DOCS = 'all-docs'
    /** v0.19：「全部」档里的代码区自己的区名 —— 幽灵行要插回**它原来那一区**，共用会插错位置。 */
    const MOTION_TIER_ALL_CODE = 'all-code'
    /** 幸存行位移（换层 / 重排）的 FLIP 时长：比进入略长，它要真的「走」完一段距离。 */
    const MOTION_MOVE_MS = 340
    /** 位移小于这个像素数（含亚像素抖动）就当没动过，不排补间。 */
    const MOTION_MOVE_EPS = 0.5

    /**
     * 这台机器上要不要播动效。
     *
     * 三种情况**不播**：没有 DOM（Node 里的测试替身）、浏览器/系统要求「减弱动态效果」、
     * 以及不认 WAAPI 的宿主。返回假时一行补间都不排、也不留幽灵行 —— 渲染树与没有这段动效时逐字一致。
     *
     * @returns {boolean} 是否播动效
     */
    function motionAllowed() {
      if (typeof document === 'undefined' || typeof document.createElement !== 'function') return false
      if (typeof Element !== 'function' || typeof Element.prototype.animate !== 'function') return false
      const view = typeof window === 'undefined' ? null : window
      if (view && typeof view.matchMedia === 'function') {
        try {
          if (view.matchMedia('(prefers-reduced-motion: reduce)').matches) return false
        } catch (err) { /* matchMedia 抛错就当用户没提要求 */ }
      }
      return true
    }

    /**
     * 算这一帧哪些行是**新来的**、哪些行**走了**（纯函数，测试直接喂它）。
     *
     * 「走了」的行带回它上一帧的 `tierKey` / `index` —— 幽灵行要靠这两个值插回原来的位置，
     * 不能一律塞到列表末尾（那样看起来是「这篇文档跳到了下面然后消失」）。
     *
     * ⚠️ 视图整体换掉时（换类型 / 换排序 / 搜索词变了）返回空：那是「换屏」，不是
     * 「列表里多了一行」，整屏一起飞会很吵（原型里首屏也刻意不播）。
     * ⚠️ 同一篇**换层**（rel 不变、tierKey 变了）既不算进入也不算离开 —— 这不是「不播」：
     * 那一行交给 `KnitBody` 里的 FLIP（`motionShift` + 上一帧按 rel 记下的矩形）。跨分区时
     * React 会重建节点，但位置是按 **rel** 记的，所以它照样能从老位置补间到新位置；
     * 在这里把它当「进入」反而会让它先闪一下再飞，两段补间会互相打架。
     *
     * @param {{view: string, rows: object[]}|null} prev - 上一帧的快照（没提交过就是 null）
     * @param {string} view - 本帧的视图签名
     * @param {object[]} rows - 本帧的行表，顺序＝屏幕顺序
     * @returns {{entered: Array<{rel: string, delay: number}>, left: object[]}} 新来的 / 走了的
     */
    function planRowMotion(prev, view, rows) {
      const next = (Array.isArray(rows) ? rows : []).filter((row) => row && row.rel)
      if (!prev || prev.view !== view) return { entered: [], left: [] }
      const before = new Map((prev.rows || []).map((row) => [row.rel, row]))
      const after = new Set(next.map((row) => row.rel))
      const entered = []
      let order = 0
      for (const row of next) {
        if (before.has(row.rel)) continue
        entered.push({ rel: row.rel, delay: Math.min(order, MOTION_STAGGER_MAX) * MOTION_STAGGER_MS })
        order += 1
      }
      return {
        entered,
        left: (prev.rows || []).filter((row) => row && row.rel && !after.has(row.rel)),
      }
    }

    /**
     * 幸存行这一帧**相对上一帧挪了多远**（FLIP 的第一步：算反方向的位移）。
     *
     * 纯函数：喂两个 `{left, top}` 位置（**布局坐标**，见 `rowLayoutPoint`），返回要「拉回来」的
     * 位移；没得比或者没动过就返回 `null`。
     *
     * ⚠️ 阈值不是洁癖：`offsetTop` 也会给亚像素值，浏览器缩放导致的零点几像素抖动如果也排一段
     * 补间，那一屏会一直有东西在微微地飘。
     *
     * @param {{left: number, top: number}|null} prev - 上一帧的位置（没记过就是 null）
     * @param {{left: number, top: number}|null} now - 这一帧的位置
     * @param {number} [threshold] - 小于它就算没动（默认 `MOTION_MOVE_EPS`）
     * @returns {{dx: number, dy: number}|null} 位移（正数＝上一帧更靠右下，要往左上拉）
     */
    function motionShift(prev, now, threshold = MOTION_MOVE_EPS) {
      if (!prev || !now) return null
      const dx = prev.left - now.left
      const dy = prev.top - now.top
      if (!Number.isFinite(dx) || !Number.isFinite(dy)) return null
      if (Math.abs(dx) < threshold && Math.abs(dy) < threshold) return null
      return { dx, dy }
    }

    /**
     * 一行在**列表自己的坐标系**里的位置 —— FLIP 量位置只能用这个。
     *
     * ⚠️ 不能拿 `getBoundingClientRect()` 当「位置」：它是**视口坐标**，于是三件与「谁换了位置」
     * 毫无关系的机械动作都会让整屏的行凭空产生位移 ——
     *   ① 容器滚动（含滚动位置被 clamp）；
     *   ② 容器自己的高度 / 顶边变了（预览面板一开一合、头上那块「使用情况」长高一行）；
     *   ③ 行上挂着 transform（`.knit-doc:hover{transform:translateX(-2px)}` 是死区 0.5px 的四倍）。
     * 2026-10-04 交互审用户报的两件事都是它：「我一点它就跳……闪得很快」与「我没有输入任何对话，
     * 文档列表就开始跳动」。`offsetTop/offsetLeft` 是**布局坐标**：不含滚动、不含 transform，
     * 容器自己怎么变都不动它。节点拿不到 offset*（测试替身 / 已卸载）时才退回视口矩形，并减掉
     * 容器那一块，好歹把滚动与容器位移去掉。
     *
     * @param {{getBoundingClientRect?: Function, scrollLeft?: number, scrollTop?: number}|null} host - 列表容器
     * @param {object} el - 行节点
     * @returns {{left: number, top: number}|null} 布局坐标；量不到就是 null
     */
    function rowLayoutPoint(host, el) {
      if (!el) return null
      if (Number.isFinite(el.offsetTop) && Number.isFinite(el.offsetLeft)) {
        return { left: el.offsetLeft, top: el.offsetTop }
      }
      if (typeof el.getBoundingClientRect !== 'function') return null
      const box = el.getBoundingClientRect()
      if (!box) return null
      const base = host && typeof host.getBoundingClientRect === 'function'
        ? host.getBoundingClientRect()
        : null
      if (!base) return { left: box.left, top: box.top }
      return {
        left: box.left - base.left + (Number.isFinite(host.scrollLeft) ? host.scrollLeft : 0),
        top: box.top - base.top + (Number.isFinite(host.scrollTop) ? host.scrollTop : 0),
      }
    }

    /**
     * 给这一帧**挪了位置**的幸存行排 FLIP，并返回这一帧的位置表留给下一帧。
     *
     * 换层（同一个 rel 从「包外」升进「Primary」）与区内重排都走这里。位置按 **rel** 记 ——
     * 跨分区时 React 会重建节点，老节点量到的位置照样能用在新节点上。
     *
     * ⚠️ 调用点必须是**提交之后**、绘制之前的 layout effect，而且在 `DocRow` 的进 / 出补间
     * **之后**（React 是子先父后）：那一刻新行已经是 0 高、幽灵行还占着原高度，所以这里
     * 量到的位移就只剩「真的挪了位置」的行，不会和进 / 出补间算两遍。
     * ⚠️ `skip` 里的行（正在进 / 出的）一个都不碰：它们有自己的补间；幽灵行连数据都没有。
     * ⚠️ 只补 `transform`，不碰高度 —— 高度是进 / 出补间的事，两处都改会互相踩。
     *
     * @param {{querySelectorAll: Function}|null} host - 列表容器（`.knit-list`）
     * @param {Map<string, {left: number, top: number}>} before - 上一帧的位置表（按 rel，布局坐标）
     * @param {Set<string>} [skip] - 这一帧正在进 / 出的 rel
     * @returns {Map<string, {left: number, top: number}>} 这一帧的位置表（按 rel，布局坐标）
     */
    function applyRowFlips(host, before, skip) {
      const after = new Map()
      const was = before instanceof Map ? before : new Map()
      const nodes = host && typeof host.querySelectorAll === 'function'
        ? host.querySelectorAll('.knit-doc[data-knit-rel]') : []
      for (const el of nodes) {
        const rel = el && typeof el.getAttribute === 'function' ? el.getAttribute('data-knit-rel') : null
        if (!rel || (skip && skip.has(rel))) continue
        const point = rowLayoutPoint(host, el)
        if (!point) continue
        const shift = motionShift(was.get(rel), point)
        if (shift && typeof el.animate === 'function') {
          const anim = el.animate([
            { transform: `translate(${shift.dx}px, ${shift.dy}px)` },
            { transform: 'translate(0px, 0px)' },
          ], { duration: MOTION_MOVE_MS, easing: MOTION_EASE })
          if (anim && anim.finished && typeof anim.finished.catch === 'function') anim.finished.catch(() => {})
        }
        after.set(rel, { left: point.left, top: point.top })
      }
      return after
    }

    /**
     * 把要「离开」的行插回它们**原来的位置**（纯函数）。
     *
     * 位置是上一帧记下来的 `index` —— 不插回原位的话，看到的会是「这篇文档跳到了列表
     * 末尾才消失」。数据里已经有同一篇时跳过：那一行还活着（比如它只是换了层），
     * 不该在同一区里再多出一个幽灵。
     *
     * @param {object[]} docs - 这一区这一帧的数据
     * @param {object[]} ghosts - 全部要离开的行（`{rel, doc, tierKey, index}`）
     * @param {string} tierKey - 哪一个区（分层视图＝层名，平铺 / 「全部」各一个常量）
     * @returns {object[]} 带幽灵行的新数组（这一区没幽灵时原样返回）
     */
    function mergeGhostRows(docs, ghosts, tierKey) {
      const mine = []
      for (const ghost of Array.isArray(ghosts) ? ghosts : []) {
        if (ghost && ghost.tierKey === tierKey) mine.push(ghost)
      }
      if (mine.length === 0) return docs
      mine.sort((a, b) => a.index - b.index)
      const out = docs.slice()
      for (const ghost of mine) {
        if (out.some((doc) => doc.rel === ghost.rel)) continue
        out.splice(Math.min(ghost.index, out.length), 0, { ...ghost.doc, knitLeaving: true })
      }
      return out
    }

    function DocRow({ doc, now, active, cursor, relevance, why, num, mark, primary, life,
      glyph, onGlyph, onSelect, onOpenTab, optionId, entering, leaving }) {
      const fresh = now - doc.mtimeMs < NEW_WINDOW_MS
      const rowRef = React.useRef(null)
      /* v0.19：只有**代码行**带语言徽章。
         文档列表整列都是 Markdown，给每一行都挂一个「MD」是纯噪声 —— 信息量为零，
         还多占横向空间（§47 要求窄侧边栏不许溢出）。代码行混在文档里时才需要
         「这是 TS 还是 PY」这一眼。 */
      const lang = doc.kind === ARTIFACT_CODE ? langBadge(doc.name || doc.rel) : ''

      /* 进 / 出两段补间都跑在 **layout effect** 里：放到 paint 之后会先闪一帧完整高度的
         行，那正是用户抱怨的那一下。没有 DOM 时 `motionAllowed()` 直接挡掉。 */
      React.useLayoutEffect(() => {
        if (!motionAllowed()) return
        const el = rowRef.current
        if (!el || typeof el.getBoundingClientRect !== 'function') return
        const box = el.getBoundingClientRect()
        const height = box && box.height > 0 ? box.height : 0
        if (height <= 0) return
        // 量的高度是 border-box，补间也得按 border-box 算，否则第一帧会把行撑高一个内边距。
        el.style.boxSizing = 'border-box'
        if (leaving) {
          // 离开：高度收到 0，同时**自上而下**擦掉（clip-path 的 top 从 0 涨到 100%），
          // 末尾补一点模糊 —— 与原型里那条 mask 擦除是同一个读法。
          el.style.overflow = 'hidden'
          const anim = el.animate([
            { height: `${height}px`, clipPath: 'inset(0% 0 0 0)', opacity: 1, filter: 'blur(0px)' },
            { height: `${height * 0.55}px`, clipPath: 'inset(45% 0 0 0)', opacity: 0.7, filter: 'blur(1px)', offset: 0.55 },
            { height: '0px', clipPath: 'inset(100% 0 0 0)', opacity: 0, filter: 'blur(2px)' },
          ], { duration: MOTION_EXIT_MS, easing: MOTION_EASE, fill: 'forwards' })
          if (anim && anim.finished && typeof anim.finished.catch === 'function') anim.finished.catch(() => {})
          return
        }
        if (entering === null || entering === undefined) return
        // 进入：先把高度收成 0 再补间到自然高度 —— 下面的行是被**挤**下去的，不是跳下去的
        // （原型里踩过的坑：不先量自然高度，插入瞬间会把下面那行蹬一下）。
        el.style.overflow = 'hidden'
        const anim = el.animate([
          { height: '0px', transform: 'translateY(26px)', opacity: 0, filter: 'blur(3px)' },
          { height: `${height}px`, transform: 'translateY(0)', opacity: 1, filter: 'blur(0px)' },
        ], { duration: MOTION_ENTER_MS, delay: entering, easing: MOTION_EASE, fill: 'both' })
        const done = anim && anim.finished
        if (done && typeof done.then === 'function') {
          done.then(() => { el.style.height = ''; el.style.overflow = '' }).catch(() => {})
        } else {
          el.style.height = ''
          el.style.overflow = ''
        }
      })

      return h('div', {
        className: `knit-doc${active ? ' active' : ''}${cursor ? ' cursor' : ''}${fresh ? ' fresh' : ''}${leaving ? ' leaving' : ''}`,
        ref: rowRef,
        // listbox 的选项语义：有 role 才能被读成「N 项中的第 i 项」，
        // 有 aria-selected 才能播报「当前选中」。
        role: 'option',
        id: optionId,
        'aria-selected': active ? 'true' : 'false',
        // 「正在离开」的幽灵行已经不在数据里了（点不动、键盘也到不了），
        // 只是占着位置把高度收掉 —— 别让它被读成一项。
        'aria-hidden': leaving ? 'true' : undefined,
        'data-knit-rel': doc.rel,
        title: t('row.tooltip', { path: doc.rel }),
        onClick: () => onSelect(doc),
        onDoubleClick: () => onOpenTab(doc),
      },
      // ── 序号＝**最左边独立一列**（2026-09-29 用户追加要求）──────────────
      // 用户原话：「文档列表序号放在独立最左边，其他数据放在右边」。所以序号从行一里
      // 搬了出来，成为 .knit-doc 这条两列 grid 的第一列，其余数据全在右边堆叠。
      // v0.14（Design §11）：只有 Context Pack 前三层的条目有号；「其他相关文档」里的
      // 没有 —— 那些不属于这个包，编号会把它们谎报成包的一部分。
      // 2026-10-01：**不再「没有号就整个节点不渲染」**。这一屏里有号时（`mark`，由
      // `docsGrid` 下发），这一列放一个中性占位标记，否则空着的那一格会被读成漏了一个号。
      // 整屏没号（时间序 / 平铺列表）时 `mark` 为假 —— 一个标记都不渲染。
      num ? h('span', { className: 'knit-num' }, String(num).padStart(2, '0'))
        : (mark ? h('span', { className: 'knit-gapmark', 'aria-hidden': 'true' }, '·') : null),
      // 右边这一列＝其余全部数据。列位置由 .knit-body 的 grid-column 定死 ——
      // 靠自动排布的话，没有序号时正文会掉进第一列。
      h('div', { className: 'knit-body' },
        // 行一＝**标题行**（Primary 点 + 标题 + 相对时间，**时间靠右**）—— 2026-09-29 用户要求
        // 「将时间放到标题同行，时间放在右边，然后标题跟时间就可以以序号平行，居中平行」。
        // 序号那一列与这一行垂直居中（靠 .knit-num 的 line-height，CSS 里有说明）。
        h('div', { className: 'knit-row1' },
          // v0.14（Design §13）：Primary 唯一允许的标记 —— 5px 黑点。
          // 不是星标、不是徽章、不是 AI 图标：「重要来自位置和结构，不来自图标」。
          // v0.18：**统计开着时这一格让给生命周期 glyph**（○ ● △ ↻）——
          // 2026-10-05 规格 §13 给的 ASCII 每一行只有一个标记，而层名已经由分组标题
          // （「主要上下文」）说了，glyph 才是这一版新加的那条事实。usage 关掉时
          // 这一行与 v0.17 逐字一致（`knit-dot` 照旧）。
          primary && !glyph ? h('span', { className: 'knit-dot', 'aria-hidden': 'true' }) : null,
          // 生命周期 glyph：极小、中性、点它＝打开 / 选中这篇（**已经打开则保持原预览**）。
          // ⚠️ 它是真 `button`：键盘 Tab 得到、读屏读得出，不是 div + onClick。
          glyph ? h('button', {
            className: 'knit-glyph',
            type: 'button',
            title: glyph.title,
            'aria-label': glyph.title,
            onClick: (event) => {
              if (event && typeof event.stopPropagation === 'function') event.stopPropagation()
              onGlyph(doc)
            },
          },
          // v0.18 UI 迭代（md §二十七~§二十九）：四态画成与 Coverage **同一套** 9px 圆点 ——
          // 未读＝空心环、已读＝实心、读后已更新＝空心环 + 中心点、修改后已重新读取＝ ↻ 字符。
          // 两处用同一对 token、同一个直径，所以「同一套状态语言」不靠自觉。
          // ⚠️ 状态词仍然只在 title / aria-label 里；行尾那一段文字由 `.knit-life` 说。
          h('span', {
            className: 'knit-glyph-mark',
            'data-mark': glyph.status === 'read' ? 'read'
              : glyph.status === 'updated_after_read' ? 'updated'
                : glyph.status === 'reread_after_update' ? 'reread' : 'unread',
            'aria-hidden': 'true',
          }, glyph.status === 'reread_after_update' ? glyph.char : null)) : null,
          h('div', { className: 'knit-title' },
            fresh ? h('span', { className: 'knit-badge' }, '🆕') : null,
            doc.title || doc.name,
            lang ? h('span', { className: 'knit-lang' }, lang) : null),
          // v0.17：生命周期状态（文案已算好；没有证据时是 null，一个节点都不加）。
          // 插在**标题与时间之间**：`.knit-title` 是 flex:1 1 auto，会把状态与时间一起推到
          // 行尾，状态在时间左侧、行尾仍然是时间。
          // ⚠️ 状态是**纯文字**：不加图标、不加底色、不加边框、不用红绿表达好坏 ——
          //    它陈述事实，不是评分（AGENTS.md §6.2 / PRD §7.3）。字号比标题弱一档，
          //    永远不抢标题。
          life ? h('span', { className: 'knit-life' }, life) : null,
          // 时间在标题右边的行尾 —— 靠 .knit-title 的 flex-grow 推过去，不是靠 margin。
          h('div', { className: 'knit-time' }, relTime(doc.mtimeMs, now))),
        doc.summary
          ? h('div', { className: 'knit-sum' }, doc.summary)
          : h('div', { className: 'knit-sum empty' }, t('summary.empty')),
        // ⚠️ **列表行里不再有路径**（2026-09-29 用户要求）：「文档列表中的文档路径，我觉得
        //    不需要出现了，因为点开查看文档详情的时候已经有了，所以这里是重复的，隐藏掉」。
        //    —— 这是**重复信息**，不是「多列砍字段」那种静默降级：预览头
        //    （`.knit-preview-path`：目录收敛成 `…/` + 文件名亮，还可点）已经能定位到是哪一篇，
        //    完整相对路径在它的悬停提示里。
        //    所以删掉的是 `.knit-meta` 这一个节点，**摘要仍然任何情况下都不许 display:none**。
        //    行的定位不走可见路径：`data-knit-rel` 仍在（键盘 / 预览映射靠它）。
        // v0.14：为什么这一篇在这个层里。只有 Context Pack 的条目才有 ——
        // 时间序 / 平铺列表里不渲染这一行（不编造理由）。
        // ⚠️ 这一行**故意独占一行**，不并到上面的标题行（Design §11 的 ASCII 把它画在
        //    标题右侧）：它是本版新增的那条信息，右侧对齐 + 省略号会把它截成
        //    「标题命中当前…」，恰好把要传达的东西吃掉。Design §11 的字段顺序
        //    （number / title / summary / path / why）在这里是满足的。
        why ? h('div', { className: 'knit-why', title: `${t('context.why')}：${why}` }, why) : null))
    }

    /**
     * 视频缩略图。
     *
     * 用 `<video preload="metadata" src#t=0.5>` 让浏览器直接解出首帧当海报，
     * 中央叠播放三角、右下角叠时长 —— 零依赖、零 ffmpeg、宿主也不必解析容器。
     * 时长在 loadedmetadata 后填，拿不到就不显示角标。
     *
     * 每张缩略图都会发一次 Range 请求取首帧，所以在媒体视图（无上限）里
     * 视频多的目录会比较费；「全部」里媒体区限 2 行，已经把这个量压住了。
     *
     * @param {{src:string}} props - 视频字节地址
     * @returns {import('react').ReactElement} 元素
     */
    function VideoThumb({ src }) {
      const [duration, setDuration] = React.useState(null)
      return h('div', { className: 'knit-thumb' },
        h('video', {
          preload: 'metadata',
          muted: true,
          playsInline: true,
          src: `${src}#t=0.5`,
          onLoadedMetadata(event) {
            const v = event && event.target
            if (v && Number.isFinite(v.duration) && v.duration > 0) setDuration(v.duration)
          },
        }),
        h('span', { className: 'knit-thumb-play', 'aria-hidden': true },
          h('svg', { viewBox: '0 0 24 24', focusable: false },
            h('path', { d: 'M8 5v14l11-7z' }))),
        duration ? h('span', { className: 'knit-thumb-dur' }, fmtDuration(duration)) : null)
    }

    /**
     * 缩略图本体：图片走懒加载 `<img>`，视频走首帧 VideoThumb。
     * @param {{doc:object,src:string}} props - 条目与字节地址
     * @returns {import('react').ReactElement} 元素
     */
    function MediaThumb({ doc, src }) {
      if (doc.kind === 'video') return h(VideoThumb, { src })
      return h('div', { className: 'knit-thumb' },
        h('img', { loading: 'lazy', src, alt: doc.name || '', draggable: false }))
    }

    /**
     * 媒体网格卡片（图片与视频视图）：方形缩略图 + 文件名 + 相对时间。
     * @param {object} props - 与 DocRow 同构，外加 src
     * @returns {import('react').ReactElement} 元素
     */
    function MediaCard({ doc, now, active, cursor, src, onSelect, onOpenTab, optionId }) {
      const fresh = now - doc.mtimeMs < NEW_WINDOW_MS
      return h('div', {
        className: `knit-media-card${active ? ' active' : ''}${cursor ? ' cursor' : ''}${fresh ? ' fresh' : ''}`,
        // 与 DocRow 同一套 listbox 选项语义（媒体档与「全部」的媒体区都在同一个 listbox 里）
        role: 'option',
        id: optionId,
        'aria-selected': active ? 'true' : 'false',
        'data-knit-rel': doc.rel,
        title: t('row.tooltip', { path: doc.rel }),
        onClick: () => onSelect(doc),
        onDoubleClick: () => onOpenTab(doc),
      },
      h('div', { className: 'knit-media-thumbbox' }, h(MediaThumb, { doc, src })),
      h('div', { className: 'knit-media-meta' },
        h('div', { className: 'knit-media-name', title: doc.name },
          fresh ? h('span', { className: 'knit-badge' }, '🆕') : null,
          doc.name),
        h('div', { className: 'knit-media-time' }, relTime(doc.mtimeMs, now))))
    }

    /**
     * 列表下方的预览面板。
     * @param {{preview:object,pathImages:object|null,fullscreen:boolean,onClose:Function,onOpenLocal:Function|null,onReveal:Function|null,onToggleFullscreen:Function,onResizeStart:Function}} props - 渲染入参
     * @returns {import('react').ReactElement} 元素
     */
    /**
     * 复制一段文本。
     *
     * 优先 `navigator.clipboard`（异步；非 secure context 里可能根本没有）；
     * 拿不到就退回 `document.execCommand('copy')` + 一个离屏 textarea。
     * 两条路都失败返回 `false` —— **由调用方决定怎么告诉用户**（静默失败比报错更糟）。
     *
     * @param {string} text - 要复制的文本
     * @returns {Promise<boolean>} 是否成功
     */
    function copyText(text) {
      const value = String(text == null ? '' : text)
      const legacy = () => {
        try {
          const area = document.createElement('textarea')
          area.value = value
          area.setAttribute('readonly', 'readonly')
          area.style.position = 'fixed'
          area.style.top = '-1000px'
          document.body.appendChild(area)
          area.select()
          const ok = document.execCommand('copy')
          document.body.removeChild(area)
          return ok
        } catch (error) {
          return false
        }
      }
      if (navigator.clipboard && navigator.clipboard.writeText) {
        return navigator.clipboard.writeText(value).then(() => true, legacy)
      }
      return Promise.resolve(legacy())
    }

    /**
     * 语言徽章：文件后缀 → 短标签（TS / JS / PY / JSON / MD …）。
     *
     * **纯展示，不是判据。** 「这是什么类型、能不能进上下文、能不能预览」的权威
     * 一律是宿主的分类层（`src/host/classification.js`）；这里只是把后缀压成一个
     * 窄标签给列表行和预览头用。认不出的后缀返回空串 —— **不猜**，宁可不显示。
     *
     * ⚠️ 这份表**不决定**任何文件是否被接纳：加一个后缀进这张表不会让 `.go` 变成
     * 上下文候选（宿主那边它是 `ignored`）。反过来也一样。
     */
    const LANG_BADGE = {
      js: 'JS', mjs: 'JS', cjs: 'JS', ts: 'TS', tsx: 'TSX', jsx: 'JSX', py: 'PY',
      json: 'JSON', html: 'HTML', htm: 'HTML', css: 'CSS', scss: 'SCSS',
      yaml: 'YAML', yml: 'YAML', sh: 'SH', bash: 'SH', zsh: 'SH',
      md: 'MD', map: 'MAP',
    }

    /**
     * @param {string} name - 文件名（带后缀）
     * @returns {string} 徽章文本，认不出时为空串
     */
    function langBadge(name) {
      const m = /\.([a-z0-9]+)$/i.exec(String(name || ''))
      return m ? (LANG_BADGE[m[1].toLowerCase()] || '') : ''
    }

    /**
     * 代码预览里最多渲染多少行。
     *
     * 一次最多这么多行号 —— 长文件不会把 DOM 撑爆（`readDocument` 那边已经按
     * `DOC_MAX_BYTES` 截过字节，这里是第二道、面向渲染的边界）。
     * 超出的部分明说「只显示前 N 行」，不静默砍掉。
     */
    const CODE_LINES_MAX = 4000

    /**
     * 轻量代码预览：行号栏 + 代码正文。
     *
     * 刻意的取舍（需求 §8 §25 §26）：
     *  - **不做语法高亮、不做折叠、不做 minimap、不做 AST / symbol outline**，
     *    不引入 Monaco / CodeMirror。Knit 不是编辑器。
     *  - 行号与正文**各是一个文本节点**（靠 `white-space: pre` 换行），不是每行一个
     *    元素 —— 4000 行代码因此只有两个节点，横向滚动交给 CSS 的 `overflow-x:auto`。
     *  - 字体、配色全部走既有 `--knit-*` / `--dsw-alias-*` 变量，随 light/dark 主题走。
     *
     * @param {{text: string}} props - `preview.text` 原文
     * @returns {import('react').ReactElement} 元素
     */
    function CodePane({ text }) {
      const lines = String(text == null ? '' : text).split('\n')
      // 末尾换行会切出一个空尾行 —— 显示它会让行数比编辑器里多一行。
      if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop()
      const clipped = lines.length > CODE_LINES_MAX
      const shown = clipped ? lines.slice(0, CODE_LINES_MAX) : lines
      let gutter = ''
      for (let i = 1; i <= shown.length; i += 1) gutter += (i === 1 ? '' : '\n') + i
      return h('div', { className: 'knit-codepane' },
        h('div', { className: 'knit-code-gutter', 'aria-hidden': 'true' }, gutter),
        h('pre', { className: 'knit-code-src' }, shown.join('\n')),
        clipped
          ? h('div', { className: 'knit-preview-note' },
            t('preview.codeTruncated', { n: CODE_LINES_MAX }))
          : null)
    }

    function PreviewPanel({ preview, pathImages, fullscreen, ratio, links, linksExpanded, onToggleLinks, onOpenLink, onClose, onOpenLocal, onReveal, onOpenMap, onOpenWeb, onToggleFullscreen, onResizeStart }) {
      const isMedia = preview.kind === 'image' || preview.kind === 'video'
      const previewPath = splitRelPath(preview.rel)

      /* ── v0.19：复制整篇 + Source map ──────────────────────
       * 「复制」只给代码 —— Markdown 那边 MarkdownText 自带每个代码块的复制按钮，
       * 再给一个「复制整篇」会和它挤在一起，而且很少用。
       * `copied` 只活在这个组件里（1.6s 后自己复位），不落盘、不进任何 store。 */
      const isCodeView = preview.kind === ARTIFACT_CODE || preview.kind === KIND_GENERATED
      /* v0.19 追加：**网页预览**只给 HTML。
         判据优先用宿主给的 `language` —— 那是分类层（`src/host/classification.js`）
         的结论，v0.19 起客户端不再自己看扩展名。正文还没到手时 `language` 是空的，
         退回列表徽章那张表（`LANG_BADGE`）兜一下：它**只决定这个按钮出不出场**，
         不改变任何文件的接纳结论 —— 该表自己的注释也是这么写的。 */
      const isWebPage = isCodeView && (preview.language === 'html'
        || (!preview.language && langBadge(preview.title || preview.rel) === 'HTML'))
      const [copied, setCopied] = React.useState(false)
      const [copyFailed, setCopyFailed] = React.useState(false)
      // 两个提示都自己复位（1.6s / 2.4s）—— 它们只活在组件里，不落盘、不进 store。
      React.useEffect(() => {
        if (!copied) return undefined
        const id = setTimeout(() => setCopied(false), 1600)
        return () => clearTimeout(id)
      }, [copied])
      React.useEffect(() => {
        if (!copyFailed) return undefined
        const id = setTimeout(() => setCopyFailed(false), 2400)
        return () => clearTimeout(id)
      }, [copyFailed])
      // 换一篇就复位 —— 否则「已复制」会跟着下一篇继续亮着，说的是上一篇的事。
      React.useEffect(() => {
        setCopied(false)
        setCopyFailed(false)
      }, [preview.rel])
      const onCopySource = React.useCallback(() => {
        copyText(preview.text).then((ok) => {
          if (ok) setCopied(true)
          else setCopyFailed(true)
        })
      }, [preview.text])

      /* ── v0.12 引用条 ────────────────────────────────────
       * 位置：预览头**下面**、正文**上面** —— 一条可折叠的窄条。
       *
       * 为什么不塞进正文：正文是 Markdown 渲染的，插进去会**被滚动带走**，
       * 还容易跟渲染器打架。预览头也放不下（38px 里已经有面包屑 + 三个按钮 + 拖拽把手）。
       *
       * 默认**折叠**，只显示两个计数，展开才占高度。空态与失败态文案**分开** ——
       * 「没有被引用」是一个结论，「读取失败」是另一个，不能都显示成空白。
       */
      const linkItems = (title, items, emptyText) => h('div', { className: 'knit-links-group' },
        h('div', { className: 'knit-links-label' }, title),
        items.length === 0
          ? h('div', { className: 'knit-links-empty' }, emptyText)
          : h('ul', { className: 'knit-links-list' },
            items.map((item) => h('li', { key: item.rel },
              h('button', {
                type: 'button',
                className: 'knit-link-row',
                title: item.rel,
                onClick: () => onOpenLink(item),
              },
              h('span', { className: 'knit-link-name' }, item.title),
              h('span', { className: 'knit-link-path' }, item.rel))))))

      const linksBar = (() => {
        if (!links || !onToggleLinks) return null
        if (links.status === 'loading') {
          return h('div', { className: 'knit-links' },
            h('div', { className: 'knit-links-state' }, t('preview.loading')))
        }
        if (links.status !== 'ready') {
          return h('div', { className: 'knit-links' },
            h('div', { className: 'knit-links-state' }, t('links.failed')))
        }
        const incoming = links.incoming || []
        const outgoing = links.outgoing || []
        return h('div', { className: `knit-links${linksExpanded ? ' is-open' : ''}` },
          h('button', {
            type: 'button',
            className: 'knit-links-head',
            'aria-expanded': linksExpanded ? 'true' : 'false',
            onClick: onToggleLinks,
            title: links.rel,
          },
          h('span', { className: 'knit-links-arrow' }, linksExpanded ? '▾' : '▸'),
          h('span', { className: 'knit-links-summary' },
            t('links.summary', { in: links.incomingTotal || 0, out: links.outgoingTotal || 0 }))),
          links.limited
            ? h('div', { className: 'knit-links-note' }, t('links.incomplete'))
            : null,
          linksExpanded
            ? h('div', { className: 'knit-links-body' },
              linkItems(t('links.incoming'), incoming, t('links.noneIn')),
              linkItems(t('links.outgoing'), outgoing, t('links.noneOut')),
              (links.incomingTotal > incoming.length || links.outgoingTotal > outgoing.length)
                ? h('div', { className: 'knit-links-note' },
                  t('links.more', {
                    count: Math.max(
                      (links.incomingTotal || 0) - incoming.length,
                      (links.outgoingTotal || 0) - outgoing.length,
                    ),
                  }))
                : null)
            : null)
      })()

      // 图片/视频不读正文，直接用同源字节地址渲染；Markdown 才走加载 / MarkdownText / 降级。
      // v0.19：代码（含 `.map` 这类生成产物）走轻量 CodePane —— **绝不能落到
      // MarkdownText 那支**，否则 `#` 开头的注释会变成标题、`*` 会变成列表。
      const isCode = preview.kind === ARTIFACT_CODE || preview.kind === KIND_GENERATED
      const body = preview.status === 'loading'
        ? h('div', { className: 'knit-preview-note' }, t('preview.loading'))
        : preview.status === 'error'
          ? h('div', { className: 'knit-preview-note' }, t('list.failed', { error: preview.error }))
          : preview.kind === 'image'
            ? h('img', { className: 'knit-preview-media', src: preview.src, alt: preview.title || preview.rel })
            : preview.kind === 'video'
              ? h('video', {
                  className: 'knit-preview-media',
                  src: preview.src,
                  controls: true,
                  autoPlay: true,
                  muted: true,
                  playsInline: true,
                  'aria-label': t('media.play'),
                })
              : isCode
                ? h(CodePane, { text: preview.text })
                : MarkdownText
                ? h(MarkdownText, {
                    text: preview.text,
                    labels: { code: { copyLabel: t('code.copy'), copiedLabel: t('code.copied') }, footnotes: '' },
                    pathImages: pathImages || undefined,
                  })
                // 降级必须说出来 —— 静默退回纯文本会让人以为是渲染坏了（真实踩过的坑）
                : h('div', null,
                    h('div', { className: 'knit-preview-note' },
                      t('preview.rawFallback')),
                    h('pre', { className: 'knit-raw' }, preview.text))

      return h('div', {
        className: 'knit-preview',
        /* ⚠️ 高度**打开期间是固定的**（= 拖出来的那个比例），不是 `maxHeight`（2026-10-04 交互审）。
           原来是 `maxHeight: 46%` ⇒ 面板高度由**内容**决定，于是：
             ① 点一篇 → 先出「加载中」（一两行高），正文到了再窜到 46% ⇒ 列表跟着一伸一缩；
             ② 在预览里点「相关文档」换一篇 ⇒ 正文长短变了 ⇒ 列表又跟着一伸一缩。
           用户的原话是「我选中一个文档查看全文……我一点它就跳，我一点它就很跳，闪的很快」。
           固定高度之后这两次几何变化一次都不发生：加载中 / 换篇都不再改动列表的高度，
           长文照样在 `.knit-preview-body` 里滚（它本来就是 `overflow-y:auto`）。
           短文档会因此下方留白 —— 这是拿「点一下不跳」换来的，别再改回 maxHeight。 */
        style: fullscreen ? undefined : { height: `${Math.round(ratio * 100)}%` },
      },
        fullscreen ? null : h('div', { className: 'knit-resize', onPointerDown: onResizeStart, title: t('preview.resizeTitle') }),
        h('div', { className: 'knit-preview-head' },
          // 路径，**可点**：在文件管理器里打开它所在的文件夹**并选中这个文件**
          // （`action: 'reveal'` → macOS `open -R` / Windows `explorer /select,`）。
          // 与面板顶部那行工作区路径是同一套 remote（`openWorkspacePath`），
          // 差别只在多带一个 `action` —— 那行是「打开目录」，这条是「定位到文件」。
          // **打开文件本身**是页脚那个「本地打开」按钮的事，两者刻意分开。
          // 不放标题：正文 H1 已经写了，重复会让「列表行 / 预览头 / 正文」出现三遍
          // 同一个词，反而分不清哪块是详情。
          // 目录收敛成 `…/`（2026-10-01 用户要求），完整相对路径在 title 里。
          h('button', {
            type: 'button',
            className: 'knit-preview-path',
            title: onReveal ? t('preview.reveal', { path: preview.rel }) : preview.rel,
            disabled: !onReveal,
            onClick: () => { if (onReveal) onReveal() },
          },
          previewPath.dir
            ? h('span', { className: 'knit-preview-dir' }, '…/')
            : null,
          h('span', { className: 'knit-preview-name' }, previewPath.name)),
          // 复制整篇（只给代码；MarkdownText 自己带代码块复制）
          isCodeView
            ? h('button', {
                className: 'knit-btn',
                onClick: onCopySource,
                title: copyFailed ? t('preview.copyFailed') : t('code.copy'),
              }, copied ? t('code.copied') : t('code.copy'))
            : null,
          // Source map：**低权重**入口 —— 只在同名 `<file>.map` 真的存在时出现，
          // 且 `.map` 本身不参与检索（需求 §6 §28）。点开仍是这个面板，纯文本。
          isCodeView && preview.mapRel
            ? h('button', {
                className: 'knit-btn knit-btn-quiet',
                onClick: () => { if (onOpenMap) onOpenMap(preview.mapRel) },
                title: t('preview.sourceMapTitle'),
              }, t('preview.sourceMap'))
            : null,
          h('button', {
            className: 'knit-btn',
            onClick: onToggleFullscreen,
            title: fullscreen ? t('preview.exitFullscreenTitle') : t('preview.fullscreenTitle'),
          }, fullscreen ? t('preview.exitFullscreen') : t('preview.fullscreen')),
          // v0.19 追加：**网页预览** —— 只给 HTML。
          // 它开的是官方文档预览标签页（`actions.openResource`，与双击列表行**同一条**路），
          // 那一侧有 DSH 自带的 HTML 渲染器，出来的是**网页**而不是源码。
          // ⚠️ 这不是把 v0.10 撤掉的那个「新标签页」按钮原样搬回来：当时撤的理由是
          // 「面板里已经有就地预览，重复度高、用得少」—— 那个判断对 Markdown / 图片 /
          // 视频成立，对 HTML **不成立**（就地给源码，那边给页面）。所以这里按类型放它出来，
          // 其余类型仍然只靠双击开新标签页。
          isWebPage
            ? h('button', {
                className: 'knit-btn',
                onClick: () => { if (onOpenWeb) onOpenWeb() },
                disabled: !onOpenWeb,
                title: onOpenWeb ? t('preview.openWebTitle', { path: preview.rel }) : preview.rel,
              }, t('preview.openWeb'))
            : null,
          // 「本地打开」＝ 之前那个「新标签页」的位置（v0.10）。
          // 「新标签页」开的是官方文档预览，但面板里已经有就地预览，重复度高、用得少；
          // 而「用默认应用打开这篇文档」原本只藏在路径的悬停提示里 ——
          // 把值钱的那个放到显眼处，把鸡肋的那个让位（双击列表行仍能开新标签页）。
          // v0.19 例外：HTML 那边就地预览给不了网页，所以「网页预览」按钮又回来了
          // （见上面那条）；这条注释描述的取舍对其余类型仍然成立。
          h('button', {
            className: 'knit-btn',
            onClick: () => { if (onOpenLocal) onOpenLocal() },
            disabled: !onOpenLocal,
            title: onOpenLocal ? t('preview.openLocal', { path: preview.rel }) : preview.rel,
          }, t('preview.openLocalBtn')),
          h('button', { className: 'knit-preview-close', onClick: onClose, title: t('preview.close') }, '✕')),
        // v0.12 引用条：夹在头与正文之间，不参与正文滚动
        linksBar,
        h('div', {
          className: `knit-preview-body${isMedia ? ' is-media' : ''}`,
        },
          !isMedia && preview.truncated ? h('div', { className: 'knit-preview-note' }, t('preview.truncated')) : null,
          body))
    }

    /**
     * 面板主体。两个宿主共用。
     *
     * @param {{sessionId?:string, openInTab?:Function, visible?:boolean}} props - 渲染入参。
     *   `openInTab(doc)` 返回空串表示成功，返回文案表示失败原因。
     *   `visible === false` 表示宿主那边这块面板**看不见**（官方右侧栏收起 / 不是当前标签）——
     *   那时一次都不取数、也不落状态（见下）。
     * @returns {import('react').ReactElement} 元素
     */
    function KnitBody({ sessionId, openInTab, visible }) {
      ensureStyle()

      const [notice, setNotice] = React.useState('')
      const [sort, setSort] = React.useState(readSortPref)
      // 紧跟 sort：测试按 hook 顺序预置前两位（notice/sort），kind 放第三位不影响老用例。
      const [kind, setKind] = React.useState(readKindPref)
      const [state, setState] = React.useState({
        status: 'loading', docs: [], root: '', total: 0, error: '', mode: 'time',
        // v0.14：当前任务上下文（Context Pack）。宿主只在「文档档 + 相关序 + 有命中」时给，
        // 其余情形是 null —— 那时面板退回它一直在用的平铺列表（行为与 v0.13 逐字一致）。
        context: null,
        // v0.15：这个会话的使用情况（只统计**事实**：读了几次、落在哪一层、上下文换过几次）。
        // 宿主只在用户显式打开「使用情况」之后才回传它。
        usage: null,
      })
      const [preview, setPreview] = React.useState(null)
      const [tick, setTick] = React.useState(() => Date.now())
      const [cursor, setCursor] = React.useState('')
      const [query, setQuery] = React.useState('')
      const [ratio, setRatio] = React.useState(readRatioPref)
      const [fullscreen, setFullscreen] = React.useState(false)

      const listRef = React.useRef(null)
      const rootRef = React.useRef(null)

      // 「全部」的媒体区只给两行，所以列数得跟着面板宽度走（量不到就按默认 3 列）。
      // 放在 fullscreen 之后，保持前几个 hook 的顺序不变 —— 测试按顺序预置状态。
      const [listWidth, setListWidth] = React.useState(0)

      // v0.12 引用关系。`null` = 还没请求；请求回来是 `{status, incoming, outgoing, …}`。
      // **只跟着 previewRel 走**，绝不进列表轮询路径 —— 那份解析要读全库，
      // 塞进「每 5 秒一次」会把面板拖垮（SDD §3.5）。
      const [links, setLinks] = React.useState(null)
      const [linksExpandedTick, setLinksExpandedTick] = React.useState(0)

      // v0.15「使用情况」的开闸状态（默认关，见 `USAGE_KEY`）。放在最后 —— 前几个 hook
      // 的顺序被测试按位预置，别插队。
      const [usageOn, setUsageOn] = React.useState(readUsagePref)

      // v0.17：两个折叠块的开合状态（上下文外读取 / 最近一次变化）。
      // **纯瞬时 UI 状态** —— 不写 pref、不进 `dsh-knit:*` 存储，刷新即回默认（收起）。
      // 仍然放在最后：前面那些 hook 的位置被测试按位预置，别插队。
      const [gapOpen, setGapOpen] = React.useState(false)
      const [deltaOpen, setDeltaOpen] = React.useState(false)

      /* ── 曾经在这里的三个状态 + 一个 ref：右栏的形态 ──────────
         `packWidth`(310) / `packFloat`(null) / `packSnap`(false) / `packColRef`。
         **2026-09-29 随右栏一起删除**。当时它们**只存在内存里**（刷新回默认值），
         理由现在仍然成立、也仍然适用于剩下的界面：readPref/writePref 那套只用于
         排序 / 类型 / 预览高度这类**语义偏好**，界面几何状态不属于它。 */

      React.useEffect(() => {
        const host = listRef.current
        if (!host || typeof ResizeObserver === 'undefined') return undefined
        const observer = new ResizeObserver((entries) => {
          const width = entries && entries[0] && entries[0].contentRect
            ? entries[0].contentRect.width
            : 0
          if (width) setListWidth(width)
        })
        observer.observe(host)
        return () => observer.disconnect()
      }, [])

      /* 官方右侧栏收起之后，标签身体**仍然挂着**（dockkit 的 `keepMounted`），v0.16 之前
         这里照旧每 5 秒敲一次 `/knit/api/recent` 并 `setState`：白烧一次全工作区扫描，
         还往宿主正在收起的那层 DOM 里插一帧重渲染。现在取数先问一句「还看得见吗」，看不见
         **连请求都不发**；请求在途时被折叠的那一次，回来也不落状态（`alive` 由轮询的
         cleanup 翻假）。重新可见时那个 effect 会重跑 ⇒ 立刻补一次，不必等下一个 5 秒。 */
      const load = React.useCallback(async (alive) => {
        const live = () => typeof alive !== 'function' || alive()
        if (!live()) return
        if (!sessionId) {
          setState({ status: 'error', docs: [], root: '', total: 0, error: t('error.noSession'), mode: 'time', context: null })
          return
        }
        try {
          // `usage=1` 是**开闸**（不是「顺便取一下」）：宿主只有看到它才会开始给这个会话记账。
          // 没打开「使用情况」的会话，宿主侧一个事件都不读。
          const url = `${LIST_API}?sessionId=${encodeURIComponent(sessionId)}&limit=40&sort=${sort}&kind=${kind}${usageOn ? '&usage=1' : ''}`
          const res = await fetch(url, { headers: { accept: 'application/json' }, cache: 'no-store' })
          const data = await res.json()
          if (!live()) return
          if (data && data.ok) {
            setState({
              status: 'ready',
              docs: data.docs || [],
              root: data.root || '',
              // v0.19 修订：`hostRoot` 是同一个工作区、但符号链接已展开的那份路径。
              // 界面**显示**仍用 `root`（用户看到的是自己选的那条路径），凡是**交给宿主
              // 去打开 / 定位**的路径一律用 `hostRoot` —— DSH 的 `openWorkspacePath` 只认
              // realpath，含未展开链接的路径会被它判成 `Path has no verified Host path`。
              hostRoot: data.hostRoot || data.root || '',
              total: data.total || 0,
              error: '',
              mode: data.mode || 'time',
              context: data.context || null,
              usage: data.usage || null,
            })

          } else {
            setState({ status: 'error', docs: [], root: '', total: 0, error: hostMessage(data), mode: 'time', context: null, usage: null })
          }
        } catch (error) {
          if (!live()) return
          setState({ status: 'error', docs: [], root: '', total: 0, error: String((error && error.message) || error), mode: 'time', context: null, usage: null })
        }
        setTick(Date.now())
      }, [sessionId, sort, kind, usageOn])

      React.useEffect(() => {
        // 看不见就一个定时器都不挂：`visible` 变回 true 时本 effect 重跑，立刻 load 一次。
        if (visible === false) return undefined
        let alive = true
        let timer = null
        const isAlive = () => alive
        const run = async () => {
          await load(isAlive)
          if (alive) timer = setTimeout(run, POLL_MS)
        }
        run()
        return () => { alive = false; if (timer) clearTimeout(timer) }
      }, [load, visible])

      /* ── 过滤：纯客户端，不重新请求宿主 ─────────────── */
      const visibleDocs = React.useMemo(() => {
        const all = Array.isArray(state.docs) ? state.docs : []
        const q = query.trim().toLowerCase()
        if (!q) return all
        return all.filter((doc) =>
          String(doc.title || '').toLowerCase().includes(q)
          || String(doc.summary || '').toLowerCase().includes(q)
          || String(doc.rel || '').toLowerCase().includes(q))
      }, [state.docs, query])

      /* ── 「全部」：按类型分三区 ─────────────────────
         文档区与代码区各固定 4 条，多余的在分区标题给「查看全部」；
         媒体区**不截断** —— 一屏两行以外交给媒体区内部滚动（不隐藏、也不压小格子）。
         v0.19 新增代码区，**顺序放在文档之后**：这不是排序（各区的条目顺序都来自
         同一套任务检索），只是混排时的展示次序 —— Markdown 仍然是这个面板的主角。 */
      const docItems = kind === KIND_ALL ? visibleDocs.filter((doc) => doc.kind === ARTIFACT_DOC) : []
      const codeItems = kind === KIND_ALL ? visibleDocs.filter((doc) => doc.kind === ARTIFACT_CODE) : []
      const mediaItems = kind === KIND_ALL ? visibleDocs.filter(isMedia) : []
      const shownDocs = docItems.slice(0, ALL_DOC_CAP)
      const shownCode = codeItems.slice(0, ALL_CODE_CAP)
      // ResizeObserver 量到的是 .knit-list（它自己也有左右内边距），
      // 网格的可用宽度 = 列表宽度 − 列表内边距 − 网格内边距。
      // 文档列表**没有列数可算**：永远一个文档一行（见 `DOC_GRID` 那段说明）。
      // 于是这里也不再需要 `listWidth − LIST_PAD_X` 这个量 —— 只有媒体网格要宽度。
      const mediaLayout = mediaLayoutFor(Math.max(0, listWidth - LIST_PAD_X - MEDIA_GRID_PAD_X))

      /** 媒体网格：列数由 CSS 的 auto-fill 自己数；JS 只下发「一格多宽」用于正方形兜底。
       *  **不设 maxHeight** —— 有多少行就铺多少行，纵向滚动统一交给 `.knit-list`。 */
      const mediaGrid = (docs, inSection) => h('div', {
        className: `knit-media-grid${inSection ? ' in-section' : ''}`,
        role: 'group',
        style: {
          '--knit-media-cell': `${mediaLayout.cell}px`,
          ...(mediaLayout.scaled ? { '--knit-media-label': 'none' } : {}),
        },
      }, docs.map(renderEntry))

      /**
       * 渲染一组文档行：**没有容器、没有列数**（2026-09-29 起）。
       *
       * 这里曾经按可用宽度包一层 `.knit-multicol.cols-2` 网格。列表改成永远单列后
       * 那层网格连同 `docLayoutFor` 一起删了 —— 现在它只剩一件事要做：
       * 把「这一组的条目」映射成带序号 / Primary 标记的 `DocRow`。
       *
       * ⚠️ `num` 只有 Context Pack 前三层才有（见 `renderEntry` 的说明）：
       * 时间序、筛选结果、「其他相关文档」都不编号 —— 但**这一屏里有号时**，没号的行会在
       * 同一列拿到 `mark`（渲染 `.knit-gapmark` 占位），算法见下面。
       */
      const docsGrid = (docs, numbers, primary, withLife) => {
        // 一屏里「要么都有号、要么都没有」（2026-10-01）：只要这个视图里存在序号，
        // 没号的那些行（「其他相关文档」）就在同一列渲染占位标记；整屏没号时不渲染。
        const mark = Boolean(numbers && numbers.size > 0)
        return docs.map((doc) =>
          renderEntry(doc, numbers ? numbers.get(doc.rel) || 0 : 0, Boolean(primary), mark, withLife))
      }

      const relevance = state.mode === 'relevance'
      const filtering = query.trim().length > 0

      /**
       * 把分层视图渲染成一组分区（v0.14）。
       *
       * 每个分区：一行标题（层名 + 一句提示），下面是这个层的条目。
       * 组内**复用 `docsGrid()`**，所以多列排版与单列形态与原来完全一致。
       *
       * ⚠️ 分区标题是**纯排版**，不带列表语义（`role="presentation"`）——
       * listbox 的直接子级只能是 option，否则辅助技术会把选项算错集合。
       *
       * @param {{sections: Array<{key:string,titleKey:string,hintKey:string,docs:object[]}>,numbers: Map<string,number>}} view - `contextView`
       * @returns {Array} 节点数组
       */
      const contextBody = (view) => view.sections.map((section) => h('div', {
        // 点 Coverage 定位过来时，这一层短暂亮一下（`flashTier`，900ms 后自己收掉）。
        // 不画箭头、不画横线 —— 用**空间**说「就是这里」。
        className: `knit-tier${flashTier === section.key ? ' flash' : ''}`,
        key: section.key,
        // Coverage 的定位锚点：点某一层 → `[data-knit-tier=...]` 滚进视口。
        'data-knit-tier': section.key,
        role: 'presentation',
      },
      // ⚠️ 这几个类名**互不为子串**：`byClass` 是子串匹配，若叫
      // `knit-tier-head` / `knit-tier-title`，取 `knit-tier` 会一次命中十几个节点
      // （AGENTS.md §6.5 同一个坑踩过三次）。
      h('div', { className: 'knit-tierline', role: 'presentation' },
        h('span', { className: 'knit-tiername' }, t(section.titleKey)),
        section.hintKey ? h('span', { className: 'knit-tierhint' }, t(section.hintKey)) : null),
      // ⚠️ 幽灵行（正在离开的）也走 `docsGrid`，所以它照样是一个 `.knit-doc` ——
      // 会被 `byClass` 数到，但**不在** `navDocs` 里（键盘与 cursor 都到不了）。
      docsGrid(withGhosts(section.key, section.docs), view.numbers, section.key === 'primary', true)))

      /* ── 曾经在这里的一个函数：`contextPanel` ─────────────────
         它渲染右栏那三样东西（当前任务原文 / 「命中 N 篇」/ 三条证据行）。
         **2026-09-29 整个删除**，因为面板本身没有了：那三样里
         ①「当前任务」是列表**上方**那行弱化的元信息在说的话，
         ②「命中 N 篇」与头部的总篇数重复，
         ③「三条证据行」说的正是下面三个分组标题已经在说的事。
         用户当天的判断：这一栏「视觉价值有限」，而且「容易把 Knit 做成 AI Dashboard」。
         留下的那条纪律仍然有效：**层级靠灰阶与位置表达，不用颜色、不用评分、
         不用「AI 推荐」**（PRD §8.3 / Design §8）。 */


      /**
       * v0.14：当前任务上下文的分层视图。
       *
       * **只在「文档档 / 代码档 + 相关序 + 宿主给了 context」时成立**；否则返回 null，
       * 下面的渲染退回平铺列表。
       *
       * v0.19：多认一档 `KIND_CODE` —— 代码和文档走的是**同一个 Context Pack**
       * （同一份 Primary / Supporting / Related），只是列表按 `kind` 切了一刀。
       * 宿主在 `code` 档下同样给 `context`（见 `index.js` 的 `contextPayload()`），
       * 「全部」档不给 —— 混排视图的分区已经是它自己的结构了。
       *
       * 这一层是**纯投影**：分组、顺序、理由都来自宿主（同一个 Context Model），
       * 客户端不重算任何东西 —— 面板与 `knit_docs` 用的是同一份结果。
       *
       * ⚠️ 过滤框生效时**照常过滤**，而不是切回平铺列表：过滤是对当前视图的子集化，
       * 用户的预期是「在当前这份上下文里找」。
       */
      const contextView = React.useMemo(() => {
        const pack = state.context
        if (!relevance || (kind !== KIND_DOC && kind !== KIND_CODE) || !pack) return null
        const tiers = [
          ['primary', 'context.primary', 'context.primaryHint'],
          ['supporting', 'context.supporting', 'context.supportingHint'],
          ['related', 'context.related', 'context.relatedHint'],
        ]
        const visible = new Set(visibleDocs.map((doc) => doc.rel))
        const sections = []
        for (const [tierKey, titleKey, hintKey] of tiers) {
          const items = Array.isArray(pack[tierKey]) ? pack[tierKey] : []
          const docs = items.filter((item) => visible.has(item.rel))
          if (docs.length > 0) sections.push({ key: tierKey, titleKey, hintKey, docs })
        }
        // 其余文档：宿主没放进任何一层的。补上它们，面板才仍然是「工作区的地图」，
        // 而不是一个可能漏掉用户要找的那一篇的子集。
        const placed = new Set()
        for (const tierKey of ['primary', 'supporting', 'related']) {
          for (const item of (Array.isArray(pack[tierKey]) ? pack[tierKey] : [])) placed.add(item.rel)
        }
        const rest = visibleDocs.filter((doc) => !isMedia(doc) && !placed.has(doc.rel))
        if (rest.length > 0) {
          sections.push({ key: 'other', titleKey: 'context.other', hintKey: '', docs: rest })
        }
        if (sections.length === 0) return null
        // 行首序号（Design §11）：**只编三层里的**，而且是跨层连续的
        // （01 属于 Primary、02/03 属于 Supporting……），与右栏证据行的计数对齐。
        // 「其他相关文档」不编号 —— 它们不在这个包里面。
        const numbers = new Map()
        for (const section of sections) {
          if (section.key === 'other') continue
          for (const doc of section.docs) numbers.set(doc.rel, numbers.size + 1)
        }
        // 键盘到达顺序 = 屏幕上从上到下的顺序（分组顺序 + 组内顺序）
        const flat = []
        for (const section of sections) for (const doc of section.docs) flat.push(doc)
        return { sections, flat, numbers }
      }, [relevance, kind, state.context, visibleDocs])

      /**
       * 键盘与 cursor 真正能到达的条目。
       *
       * 分了层时必须是**三层里那些真的渲染出来的条目**（`contextView.flat`）——
       * 否则「其他相关文档」区里的条目键盘到不了，而已经在 Related 层里的条目
       * 会被算两次。「全部」档里文档只到上限，媒体全部可达。
       */
      const navDocs = kind === KIND_ALL
        ? shownDocs.concat(mediaItems)
        : (contextView ? contextView.flat : visibleDocs)

      // cursor 消失（被过滤掉 / 被上限截断 / 列表刷新）时落回第一项
      React.useEffect(() => {
        if (navDocs.length === 0) {
          if (cursor !== '') setCursor('')
          return
        }
        if (!navDocs.some((doc) => doc.rel === cursor)) setCursor(navDocs[0].rel)
      }, [navDocs, cursor])

      /* 键盘焦点跟手滚进视口（测试环境没有 DOM，静默跳过）。
         ⚠️ 2026-10-04（交互审的那个 bug）：这里曾经把 `state.docs` 也放进依赖里，而那是**每 5 秒
         轮询一次的新数组** —— 于是「刷新到了新数据」被当成了「用户按了方向键」。光标默认落在第一行，
         用户往下滚过之后那一行必然不在视口里 ⇒ 列表每 5 秒被拽回第一行一次，用户的原话是
         「我没有输入任何的对话……文档列表就开始跳动」。滚动**只在光标真的换了**（或搜索词变了）时发生，
         而且只在列表拿着键盘焦点时发生 —— 这条服务的是键盘导航；鼠标点过 / 悬停过的行本来就在视口里，
         而「数据刷新」一次都不该动列表。 */
      React.useEffect(() => {
        if (!cursor || typeof document === 'undefined') return
        const host = listRef.current
        if (!host || typeof host.querySelector !== 'function') return
        const active = document.activeElement
        if (active !== host && !(active && host.contains && host.contains(active))) return
        const escaped = typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(cursor) : cursor
        const el = host.querySelector(`[data-knit-rel="${escaped}"]`)
        if (el && typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'nearest' })
      }, [cursor, query])

      // 预览高度：拖完就记住
      React.useEffect(() => { writePref(RATIO_KEY, String(ratio)) }, [ratio])

      // 「使用情况」开关：开了就记住（只记开关本身，**记账数据一律活在内核内存里**，
      // 面板不落盘 —— 与「界面几何状态不落盘」是同一条纪律）。
      React.useEffect(() => { writePref(USAGE_KEY, usageOn ? '1' : '0') }, [usageOn])

      /**
       * 为一个条目造预览状态：图片/视频直接 ready（字节地址交给 <img>/<video>），
       * 其余（Markdown / 代码）进 loading 去拉正文。
       *
       * v0.19：`kind` 必须**原样透传**。这里以前无条件写 `KIND_DOC`，代码接进来之后
       * 那个写法会让 `.ts` 文件走 MarkdownText 渲染 —— 一行行代码会被当成 Markdown
       * 排版（`#` 变标题、`*` 变列表、缩进被吃掉）。宿主已经在 `/api/doc` 的响应里
       * 给了分类结论，客户端照抄即可，不再自己看扩展名。
       */
      const previewFor = React.useCallback((doc) => {
        const base = { rel: doc.rel, title: doc.title || doc.name, path: doc.path || '', text: '', truncated: false }
        if (isMedia(doc)) {
          return { ...base, kind: doc.kind, src: mediaUrl(sessionId, doc.rel), status: 'ready' }
        }
        return { ...base, kind: doc.kind || ARTIFACT_DOC, status: 'loading' }
      }, [sessionId])

      /** 打开（不切换）某篇的预览。 */
      const openPreview = React.useCallback((doc) => {
        setNotice('')
        setPreview(previewFor(doc))
      }, [previewFor])

      /** 单击 / Enter：切换某篇的预览开与关。 */
      const togglePreview = React.useCallback((doc) => {
        setNotice('')
        setCursor(doc.rel)
        setPreview((current) => {
          if (current && current.rel === doc.rel && current.status !== 'error') return null
          return previewFor(doc)
        })
      }, [previewFor])

      /** 收起预览；全屏时顺带退出全屏。 */
      const closePreview = React.useCallback(() => {
        setPreview(null)
        setFullscreen(false)
      }, [])

      /**
       * 键盘导航：↑↓ 逐项移动即预览，Enter 切换，Esc 收起。
       *
       * ⚠️ **←→ 只在当前列表真的横向铺开时才生效**：
       *  - 文档档（`KIND_DOC`）与「全部」档：文档**永远单列**（2026-09-29 起），
       *    纵向列表里 ←→ 没有空间含义 —— 拦它只会挡掉宿主/输入框的正常行为，所以传 1。
       *  - 媒体档：网格由 CSS auto-fill 排布，列数用 `mediaLayout.columns` 镜像同一套算术。
       *    （这里以前一律传 `docLayout.columns`，而文档列数与媒体列数根本不是一回事 ——
       *    媒体档的 ←→ 一直是按文档的 2 列在走。改动顺便把它对齐了。）
       */
      const onListKeyDown = React.useCallback((event) => {
        if (navDocs.length === 0) return
        const index = navDocs.findIndex((doc) => doc.rel === cursor)
        const last = navDocs.length - 1

        // 方向键与 Home/End 全部交给纯函数算（见 nextIndexFor 的注释）
        const navColumns = kind === KIND_MEDIA ? mediaLayout.columns : 1
        const target = nextIndexFor(index, event.key, navDocs.length, navColumns)
        if (target >= 0) {
          event.preventDefault()
          const doc = navDocs[target]
          if (doc) { setCursor(doc.rel); openPreview(doc) }
          return
        }
        if (event.key === 'Enter') {
          event.preventDefault()
          const doc = navDocs.find((d) => d.rel === cursor) || navDocs[0]
          if (doc) togglePreview(doc)
          return
        }
        if (event.key === 'Escape') {
          event.preventDefault()
          if (fullscreen) setFullscreen(false)
          else closePreview()
        }
      }, [navDocs, cursor, fullscreen, kind, mediaLayout.columns, openPreview, togglePreview, closePreview])

      /** 拖拽预览面板上缘改变高度。 */
      const onResizeStart = React.useCallback((event) => {
        if (typeof window === 'undefined' || !event || typeof event.preventDefault !== 'function') return
        event.preventDefault()
        const host = rootRef.current
        const total = host && typeof host.getBoundingClientRect === 'function'
          ? host.getBoundingClientRect().height
          : (typeof window.innerHeight === 'number' ? window.innerHeight : 600)
        const span = total > 0 ? total : 600
        const startY = event.clientY
        const startRatio = ratio

        const onMove = (moveEvent) => setRatio(clampRatio(startRatio + (startY - moveEvent.clientY) / span))
        const onUp = () => {
          window.removeEventListener('pointermove', onMove)
          window.removeEventListener('pointerup', onUp)
        }
        window.addEventListener('pointermove', onMove)
        window.addEventListener('pointerup', onUp)
      }, [ratio])

      /* ── 曾经在这里的一整段：右栏的拖宽 / 浮动 / 吸附 ────────
         `packRect` // `viewportSize` // `floatPack` // `onGripDown` //
         `onGripKeyDown` // `onPackHeadDown`
         **2026-09-29 随右栏一起删除**。当时的三条决定（量不到几何就不动 /
         位移小于阈值不算拖 / 吸附只认指针进右缘）全部只服务于那个面板。 */


      // 悬停浮层点了某一篇 → **立刻**展开预览，不等列表、不等轮询。
      // 挂载时先取一次可能已挂起的目标，之后靠订阅实时收。
      React.useEffect(() => {
        /**
         * 把一次预览请求落到状态上。
         * @param {{rel:string, title:string}} target - 目标
         * @returns {void}
         */
        const apply = (target) => {
          setNotice('')
          // 悬停浮层由宿主下发 `kind`（v0.19 起浮层也可能列代码）—— 拿不到就当文档，
          // 走 loading→拉正文。**不要在这里写死**，否则代码会进 MarkdownText。
          setPreview({
            rel: target.rel,
            title: target.title,
            path: target.path || '',
            kind: target.kind || ARTIFACT_DOC,
            status: 'loading',
            text: '',
            truncated: false,
          })
        }
        if (pendingPreview) {
          const queued = pendingPreview
          pendingPreview = null
          apply(queued)
        }
        return subscribePreview(apply)
      }, [])

      // 预览进入 loading 时去宿主取正文
      const previewRel = preview && preview.rel
      const previewStatus = preview && preview.status
      /**
       * 只有 Markdown 有引用关系 —— 链接图里只有 `.md`，所以对图片/视频请求
       * 必然拿到 `knit/not-found`，面板会把它显示成「读取失败」。
       * **与其显示一个假的失败，不如压根不请求、也不显示这一条。**
       */
      const previewIsDoc = !preview || preview.kind === ARTIFACT_DOC

      /**
       * 这篇文档在磁盘上的绝对路径，优先级：
       * ① 宿主 `/api/doc` 给的 `path`（它已经展开过符号链接）；
       * ② `hostRoot + rel`（同一个工作区根，也是 canonical 的）；
       * ③ `root + rel`（老宿主，可能含符号链接 —— 点了会被 DSH 拒）。
       * 「打开 / 定位」要的是**宿主验证得过的路径**，不是看起来对的那条。
       */
      const previewAbsPath = preview
        ? (preview.path || joinPath(state.hostRoot || state.root, preview.rel))
        : ''

      /**
       * 点预览头那条面包屑 → 在文件管理器里**打开它所在的文件夹并选中这个文件**
       * （`action: 'reveal'`，macOS 上是 `open -R`）。用户不必在文件夹里自己找。
       *
       * 与页脚「本地打开」的分工：那个用默认应用**打开文件**，这个只**定位文件**。
       * reveal 要的是**文件本身的绝对路径**（不是所在目录）—— 传目录过去会变成
       * 「在上级目录里选中这个文件夹」，不是我们要的。
       */
      const openPreviewReveal = React.useCallback(async () => {
        setNotice((await openLocalPath(previewAbsPath, { reveal: true })) || '')
      }, [previewAbsPath])

      /** 页脚「本地打开」→ 用系统默认应用打开这篇文档本身。 */
      const openPreviewLocal = React.useCallback(async () => {
        setNotice((await openLocalPath(previewAbsPath)) || '')
      }, [previewAbsPath])

      React.useEffect(() => {
        if (!previewRel || previewStatus !== 'loading') return undefined
        let alive = true
        const run = async () => {
          try {
            const url = `${DOC_API}?sessionId=${encodeURIComponent(sessionId)}&rel=${encodeURIComponent(previewRel)}`
            const res = await fetch(url, { headers: { accept: 'application/json' }, cache: 'no-store' })
            const data = await res.json()
            if (!alive) return
            setPreview((cur) => {
              if (!cur || cur.rel !== previewRel) return cur
              if (!data || !data.ok) return { ...cur, status: 'error', error: hostMessage(data) }
              return {
                ...cur,
                status: 'ready',
                text: data.text || '',
                truncated: Boolean(data.truncated),
                /* v0.19：分类结论以宿主响应为准 —— 本地点开时已经带上了，但
                   「悬停浮层点的」「引用条点的」这些入口未必知道，正文到手后
                   就地校正一次，渲染分支（CodePane vs MarkdownText）才不会选错。
                   `mapRel` 是宿主那次有界 stat 的结果：有同名 `.map` 才给入口。 */
                kind: data.kind || cur.kind,
                language: data.language || cur.language,
                mapRel: data.mapRel || '',
                /* v0.19 修订：正文到手后把「打开用」的绝对路径也校正过来 ——
                   自己用 root + rel 拼的那份在符号链接工作区里会被 DSH 判成
                   `Path has no verified Host path`（见宿主 `hostPathOf()`）。 */
                path: data.path || cur.path,
              }
            })
          } catch (error) {
            if (!alive) return
            setPreview((cur) => (cur && cur.rel === previewRel
              ? { ...cur, status: 'error', error: String((error && error.message) || error) }
              : cur))
          }
        }
        run()
        return () => { alive = false }
      }, [previewRel, previewStatus, sessionId])

      /**
       * v0.12：引用关系。**只在打开某一篇时请求一次**，换篇重取。
       *
       * 两条刻意的选择：
       *  - 不依赖 `previewStatus` —— 引用关系与「正文读没读出来」无关
       *  - 不进列表轮询 —— 全库解析很贵，只在用户真打开一篇时才发生
       * 服务端按签名缓存，所以连续换篇不会重复解析。
       */
      React.useEffect(() => {
        if (!previewRel || !previewIsDoc) {
          setLinks(null)
          return undefined
        }
        let alive = true
        setLinks({ status: 'loading' })
        const run = async () => {
          try {
            const url = `${LINKS_API}?sessionId=${encodeURIComponent(sessionId)}&rel=${encodeURIComponent(previewRel)}`
            const res = await fetch(url, { headers: { accept: 'application/json' }, cache: 'no-store' })
            const data = await res.json()
            if (!alive) return
            setLinks(data && data.ok
              ? { status: 'ready', ...data }
              : { status: 'error', error: hostMessage(data) })
          } catch (error) {
            if (!alive) return
            setLinks({ status: 'error', error: String((error && error.message) || error) })
          }
        }
        run()
        return () => { alive = false }
      }, [previewRel, previewIsDoc, sessionId])

      /** 展开 / 收起引用条。真相在模块级 `expandedLinks`，组件只留计数器（理由同阅读态）。 */
      const toggleLinks = React.useCallback(() => {
        if (!previewRel) return
        const key = previewKey(sessionId, previewRel)
        if (expandedLinks.has(key)) expandedLinks.delete(key)
        else expandedLinks.add(key)
        setLinksExpandedTick((n) => n + 1)
      }, [previewRel, sessionId])
      const linksExpanded = Boolean(previewRel)
        && expandedLinks.has(previewKey(sessionId, previewRel))
      void linksExpandedTick

      // 相对路径图片解析器：按当前文档所在目录解析。MarkdownText 按引用身份 memo，
      // 所以必须 useMemo 住，否则每帧都会重解析整篇 markdown。
      const pathImages = React.useMemo(
        () => (previewRel ? pathImagesFor(sessionId, previewRel) : null),
        [sessionId, previewRel],
      )

      /** 次动作：双击 / 面板按钮 → 交给宿主的「开新标签页」能力。 */
      const onOpenTab = React.useCallback((doc) => {
        const target = doc && doc.rel ? doc : preview
        if (!target) return
        if (typeof openInTab !== 'function') {
          setNotice(t('error.noHostTab'))
          return
        }
        setNotice(openInTab(target) || '')
      }, [openInTab, preview])

      /** 切换排序方式，并记住偏好。 */
      const pickSort = React.useCallback((value) => {
        writePref(SORT_KEY, value)
        setSort(value)
      }, [])

      /** 媒体条目的同源字节地址（缩略图 / 就地预览）。 */
      const srcFor = React.useCallback((doc) => mediaUrl(sessionId, doc.rel), [sessionId])

      /** 切换列表类型并记住偏好；同时收起上一类型的预览。 */
      const pickKind = React.useCallback((value) => {
        writePref(KIND_KEY, value)
        setKind(value)
        setPreview(null)
        setFullscreen(false)
      }, [])



      /**
       * v0.17：这一篇当前的**事实状态**，文案已按语言算好（没有证据时是 null）。
       *
       * ⚠️ 只有「使用情况」开着、并且宿主真的回传了 `usage` 时才有文案 —— 关掉时
       *    一个状态节点都不渲染，DOM 与 v0.16 逐字一致。
       * ⚠️ `lifecycle` 里没有这篇 = 本会话没有一次成功 read ⇒ 未读。这是事实陈述，
       *    不是「你漏了它」的提醒，更不许写成「Agent 忽略了它」（PRD §8）。
       * ⚠️ 状态值本身是英文（数据层只有一个口径），中文只存在于词典（§15.4 / §24）。
       *
      /**
       * v0.17 → v0.18：生命周期现在是**一枚 glyph + 一段极短的文字**。
       * `○ 未读` / `● 已读 ×n` / `△ 读后已更新` / `↻ 修改后已重新读取`。
       *
       * ⚠️ tooltip 与 `aria-label` 挂在 **glyph** 上：`.knit-life` 只许有一个 `className`
       *    prop（client.test.mjs 有守卫盯着）—— 状态是文字，不是可交互控件。
       * ⚠️ 没有记录就是「未读」：这是**事实**，不是猜测。
       *
       * @param {string} rel - 相对路径
       * @returns {{status:string,char:string,text:string,title:string}|null}
       */
      const lifeInfo = (rel) => {
        if (!usageOn) return null
        const usageNow = state.usage
        if (!usageNow || !usageNow.stats) return null
        const row = usageNow.lifecycle && usageNow.lifecycle[rel]
        const status = row && row.status ? row.status : 'unread'
        const char = LIFE_GLYPH[status] || LIFE_GLYPH.unread
        const count = row && Number.isFinite(row.count) ? row.count : 0
        if (status === 'updated_after_read') {
          return { status, char, text: t('lifecycle.updatedAfterRead'),
            title: t('lifecycle.updatedAfterRead') }
        }
        if (status === 'reread_after_update') {
          return { status, char, text: t('lifecycle.rereadAfterUpdate'),
            title: t('lifecycle.rereadAfterUpdate') }
        }
        if (status === 'read') {
          // 读了几次只说次数：`×3`。**不排序、不评分、不建议**。
          return { status, char, text: t('lifecycle.readCountShort', { n: count }),
            title: t('lifecycle.readCount', { n: count }) }
        }
        return { status: 'unread', char: LIFE_GLYPH.unread,
          text: t('lifecycle.unread'), title: t('lifecycle.unread') }
      }

      /** 只有文字的那一半（行尾 `.knit-life`）；没有证据时 null，一个节点都不加。 */
      const lifecycleLabel = (rel) => {
        const info = lifeInfo(rel)
        return info ? info.text : null
      }

      /**
       * 状态词（**不带次数**）—— 给「次数已经在同一行单独显示」的地方用。
       * 包外行左边已经有一个 `×N`（它同时是这一档的排序键），再让 lifecycle 说一遍 `×N`
       * 就会渲染成 `client.js ×71 ×71`（2026-10-05 用真实载荷渲染时抓到）。
       * `read` 换成短词「已读」；其余三态本来就是词，照旧。
       */
      const lifeWord = (rel) => {
        const info = lifeInfo(rel)
        if (!info) return null
        return info.status === 'read' ? t('lifecycle.read') : info.text
      }

      /* ── 列表进出动效：这一帧谁新来了、谁走了 ─────────────────────────
         （参数与手感见模块级 `planRowMotion` / `MOTION_*` 那段注释。）

         ⚠️ 渲染期**只读** `motionRef`，落盘与计时器都在下面的 layout effect 里 ——
         并发渲染下这一帧可能根本没提交，渲染里写 ref 会把幽灵行记进一个被丢掉的帧。 */
      const motionRef = React.useRef({
        committed: null,
        ghosts: new Map(),
        timers: new Map(),
        positions: new Map(),
        // 位置表是在**哪一屏**量下来的（视图签名）。换屏时必须整表作废：见下面 settled 那条。
        view: '',
        // 进 / 出补间还在飞的截止时刻（毫秒时间戳）。那段时间里行高是中间态，量不得。
        tweenUntil: 0,
      })
      const [, setMotionSeq] = React.useState(0)

      /* ── v0.18 Usage Lens：三个新状态 + 两个新 effect ────────────────
         ⚠️ 这些 hook 必须留在**本组件最后一个 hook 之后**：假 React（test/harness.mjs）
         按调用顺序分配槽位，`harness.seed()` 又按顺序预置 —— 插在中间会让所有老用例错位。 */

      /** Lens 的展开 / 收起。它与「使用情况」开关是**两个状态**（规格 §25）：
       *  开关管「统计开不开」，这一位只管「统计开着，但暂时不想看细节」。默认展开。 */
      const [lensOpen, setLensOpen] = React.useState(true)
      /** 正在短暂高亮的那一层（点 Coverage 定位用）；空串＝没有高亮。 */
      const [flashTier, setFlashTier] = React.useState('')
      /** 面板高度（px）。0 = 量不到（测试替身 / 首帧）——那时按「不矮」处理，不降级。 */
      const [panelH, setPanelH] = React.useState(0)

      /** 点 Coverage 的某一层 → 滚到那一层 + 短暂高亮。
       *  ⚠️ 滚的是 `.knit-list`（唯一滚动容器）：Lens 自己不滚动，也不新增容器。
       *  ⚠️ 高亮走 state 而不是直接改 classList —— 这样测试替身里也能断言到结果。 */
      const locateTier = (key) => {
        setFlashTier(key)
        const host = listRef.current
        if (host && typeof host.querySelector === 'function') {
          const el = host.querySelector(`[data-knit-tier="${key}"]`)
          if (el && typeof el.scrollIntoView === 'function') {
            // v0.18 UI 迭代（md §十七）：把那一层滚到**视口中部**，并且只在允许动效时
            // 用平滑滚动（`motionAllowed()` 已经把「减弱动态效果」挡在外面 ⇒ 那时是瞬移，
            // 与 md §十八 的 `scroll-behavior:auto` 同义）。
            el.scrollIntoView({ behavior: motionAllowed() ? 'smooth' : 'auto', block: 'center' })
          }
        }
      }

      /** 打开某一篇 —— 它**可能不在当前列表里**（包外文档就不在 `state.docs` 里）。
       *  走模块级 `requestPreview`：与工具输出、其他座位共用同一条打开路径。
       *  ⚠️ **不重新请求列表**：只换预览（规格 §16）。已经打开同一篇就保持原预览。 */
      const openDocByRel = (rel) => {
        if (!rel) return
        if (preview && preview.rel === rel) return
        requestPreview({ rel, title: rel })
      }

      // 高亮只亮一下，然后自己收掉（不靠 hover、不靠「点了别处」）。
      React.useEffect(() => {
        if (!flashTier) return undefined
        const timer = setTimeout(() => setFlashTier(''), FLASH_MS)
        return () => clearTimeout(timer)
      }, [flashTier])

      // 面板矮的时候 Lens 要降级（Summary + Coverage + 最近读取；Outside / Delta 收成标题）。
      React.useEffect(() => {
        if (typeof ResizeObserver !== 'function' || !rootRef.current) return undefined
        const observer = new ResizeObserver((entries) => {
          const box = entries && entries[0] && entries[0].contentRect
          const height = box ? box.height : 0
          if (height) setPanelH((current) => (Math.abs(current - height) < 1 ? current : height))
        })
        observer.observe(rootRef.current)
        return () => observer.disconnect()
      }, [])
      const motionOn = motionAllowed()
      // 视图签名：换类型 / 换排序 / 搜索词变了都算「换屏」——整屏一起飞会很吵。
      const motionView = `${kind}|${state.mode}|${query.trim()}`
      // 只列**真会渲染成 .knit-doc 的行**，顺序＝屏幕顺序（幽灵行要按这个位置插回去）。
      const motionRows = (() => {
        if (state.status === 'error' || state.docs.length === 0 || visibleDocs.length === 0) return []
        if (kind === KIND_MEDIA) return []   // 媒体格子不参与：网格里收起高度没有意义
        if (kind === KIND_ALL) {
          if (docItems.length === 0 && codeItems.length === 0) return []
          return [
            ...shownDocs.map((doc, index) => (
              { rel: doc.rel, tierKey: MOTION_TIER_ALL_DOCS, index, doc })),
            ...shownCode.map((doc, index) => (
              { rel: doc.rel, tierKey: MOTION_TIER_ALL_CODE, index, doc })),
          ]
        }
        if (contextView) {
          const rows = []
          for (const section of contextView.sections) {
            section.docs.forEach((doc, index) => rows.push(
              { rel: doc.rel, tierKey: section.key, index, doc }))
          }
          return rows
        }
        return visibleDocs.map((doc, index) => (
          { rel: doc.rel, tierKey: MOTION_TIER_FLAT, index, doc }))
      })()
      const motion = (() => {
        const live = new Set(motionRows.map((row) => row.rel))
        const plan = motionOn
          ? planRowMotion(motionRef.current.committed, motionView, motionRows)
          : { entered: [], left: [] }
        const ghosts = new Map()
        if (motionOn) {
          // 上一帧留下的幽灵，这一帧还不在数据里 ⇒ 继续收着（同一篇回来了就撤掉）。
          for (const [rel, ghost] of motionRef.current.ghosts) if (!live.has(rel)) ghosts.set(rel, ghost)
          for (const row of plan.left) {
            if (ghosts.has(row.rel)) continue
            ghosts.set(row.rel, { rel: row.rel, doc: row.doc, tierKey: row.tierKey, index: row.index })
          }
        }
        return { entered: new Map(plan.entered.map((row) => [row.rel, row.delay])), ghosts, live }
      })()
      React.useLayoutEffect(() => {
        const store = motionRef.current
        store.committed = motionOn && motionRows.length > 0 ? { view: motionView, rows: motionRows } : null
        store.ghosts = motion.ghosts
        for (const [rel, timer] of store.timers) {
          if (motion.ghosts.has(rel)) continue
          clearTimeout(timer)
          store.timers.delete(rel)
        }
        for (const rel of motion.ghosts.keys()) {
          if (store.timers.has(rel)) continue
          // 补间跑完（外加一点交错余量）就把幽灵行摘掉 —— 摘的时候高度已经是 0，
          // 所以下面的行不会再跳一下。
          const timer = setTimeout(() => {
            store.timers.delete(rel)
            if (!store.ghosts.has(rel)) return
            const next = new Map(store.ghosts)
            next.delete(rel)
            store.ghosts = next
            setMotionSeq((n) => n + 1)
          }, MOTION_EXIT_MS + MOTION_STAGGER_MS)
          store.timers.set(rel, timer)
        }
        /* ── 活下来的行换了位置：FLIP（算法在模块级 `applyRowFlips`）────
           正在进 / 出的行不参与：它们有自己的补间（幽灵行连数据都没有，别去量）。

           ⚠️ 另外两种时候**一个都不量**（2026-10-04 交互审那两个 bug 的正主）：
           ① **换屏**（视图签名变了）：那是「整屏换了一批内容」，不是「列表里有人挪了位置」。
              `planRowMotion` 对换屏就是不播，FLIP 却会照两张布局的差把每一行都补一遍 ——
              换排序 / 第一次拿到数据 / 搜索词一变，整屏一起飞。
           ② **进 / 出补间还在飞**：那几百毫秒里行高在 0 与自然高之间，量到的全是中间态。
              拿中间态当基准，等补间落地后下一帧就把这段位移当成「有人挪了位置」再补一遍 ——
              一屏就这么飘起来（而且会一直飘：每次进 / 出都留下一个错基准）。
           两种时候都把位置表**清空**（不是照记）：清空等于「没有上一帧可比」，下一帧只会安静
           落位、不补间；等落地后再量一帧，基准就又是干净的了。 */
        const tweening = store.tweenUntil > Date.now()
        if (motion.entered.size > 0 || motion.ghosts.size > 0) {
          // 取较长的那一套（进入 + 一点交错余量），离开比它短，等它一定够了。
          store.tweenUntil = Date.now() + MOTION_ENTER_MS + MOTION_STAGGER_MS
        }
        const skip = new Set([...motion.entered.keys(), ...motion.ghosts.keys()])
        const settled = motionOn
          && motionRows.length > 0
          && !tweening
          && motion.entered.size === 0
          && motion.ghosts.size === 0
          && store.view === motionView
        store.positions = settled ? applyRowFlips(listRef.current, store.positions, skip) : new Map()
        store.view = motionView
      })
      React.useEffect(() => () => {
        for (const timer of motionRef.current.timers.values()) clearTimeout(timer)
        motionRef.current.timers.clear()
      }, [])
      /** 把这一帧要「离开」的行按原位插回去（只在真机上会非空，逻辑在 `mergeGhostRows`）。 */
      const withGhosts = (tierKey, docs) =>
        mergeGhostRows(docs, [...motion.ghosts.values()], tierKey)

      /** 渲染一个条目：媒体一律出方形卡片（媒体视图与「全部」的媒体区共用），其余出文档行。
       *  `withLife` 只有**分层视图**（Context Pack 三层 + 其他相关文档）才给真 —— 时间序、
       *  筛选结果、「全部」都不显示生命周期：那一屏说的不是「这个包里的文档现在什么状态」。 */
      const renderEntry = (doc, num, primary, mark, withLife) => {
        const common = {
          key: doc.path || doc.rel,
          doc,
          now: tick,
          active: Boolean(preview && preview.rel === doc.rel),
          cursor: doc.rel === cursor,
          optionId: docOptionId(doc),
          onSelect: togglePreview,
          onOpenTab,
        }
        if (isMedia(doc)) return h(MediaCard, { ...common, src: srcFor(doc) })
        // `whyText` 只认 Context Pack 条目上挂的 `reason` —— 平铺列表里没有这个字段，
        // 于是返回空串，那一行不渲染。
        // `num` / `primary` 只有分层视图会传（Design §11 / §13）；平铺列表照旧无序号。
        // `mark`＝没号时同列的占位标记，只在「这一屏里有号」时为真。
        // 进出动效只在真机上跑（`motionOn`）：测试替身没有 DOM，`motionAllowed()` 挡掉，
        // 于是渲染树里既没有 `entering` 也没有 `leaving`，与没有这段动效时逐字一致。
        // v0.18：生命周期现在是**一枚 glyph + 一段极短的文字**。glyph 可点：
        // 点它＝打开 / 选中这一篇（**已经打开则保持原预览**，不重开也不重拉）。
        const info = withLife ? lifeInfo(doc.rel) : null
        return h(DocRow, { ...common, relevance, why: whyText(doc.reason), num, mark, primary,
          life: info ? info.text : null,
          glyph: info,
          onGlyph: (target) => {
            if (preview && preview.rel === target.rel) return
            openPreview(target)
          },
          entering: motion.entered.has(doc.rel) ? motion.entered.get(doc.rel) : null,
          leaving: Boolean(doc.knitLeaving) })
      }

      /** 「全部」的分区标题：类型名 + 「已显示 / 总数」+ 被截断时的「查看全部」。 */
      const sectionHead = (labelKey, shownCount, totalCount, targetKind) =>
        h('div', { className: 'knit-section-head' },
          h('span', { className: 'knit-section-title' }, t(labelKey)),
          h('span', { className: 'knit-section-count' },
            t('section.count', { shown: shownCount, total: totalCount })),
          totalCount > shownCount
            ? h('button', {
                type: 'button',
                className: 'knit-section-more',
                title: t('section.more'),
                onClick: () => pickKind(targetKind),
              }, t('section.more'))
            : null)

      /** 「全部」的上下两区：空的一区整个不渲染，免得只剩一个空标题。 */
      const allSections = [
        docItems.length === 0 ? null : h('div', { className: 'knit-section', key: 'docs' },
          sectionHead('kind.doc', shownDocs.length, docItems.length, KIND_DOC),
          docsGrid(withGhosts(MOTION_TIER_ALL_DOCS, shownDocs))),
        codeItems.length === 0 ? null : h('div', { className: 'knit-section', key: 'code' },
          sectionHead('kind.code', shownCode.length, codeItems.length, KIND_CODE),
          docsGrid(withGhosts(MOTION_TIER_ALL_CODE, shownCode))),
        mediaItems.length === 0 ? null : h('div', { className: 'knit-section', key: 'media' },
          // 媒体不截断，所以只给一个标题，不给「已显示 / 总数」和「查看全部」
          h('div', { className: 'knit-section-head' },
            h('span', { className: 'knit-section-title' }, t('kind.media')),
            h('span', { className: 'knit-section-count' }, String(mediaItems.length))),
          mediaGrid(mediaItems, true)),
      ]

      // 媒体视图：一格都不隐藏 —— 一屏两行以外的部分在媒体区**内部滚动**，
      // 既不让面板被整面媒体墙顶爆，也不会像旧版那样把剩下的条目直接切掉。
      const emptyText = kind === KIND_MEDIA
        ? t('list.emptyMedia')
        : kind === KIND_CODE
          ? t('list.emptyCode')
          : t('list.empty')
      const body = state.status === 'loading' && state.docs.length === 0
        ? h('div', { className: 'knit-msg' }, t('list.scanning'))
        : state.status === 'error'
          ? h('div', { className: 'knit-msg' }, t('list.failed', { error: state.error }), h('br'), t('list.failedHint'))
          : state.docs.length === 0
            ? h('div', { className: 'knit-msg' }, emptyText)
            : visibleDocs.length === 0
              ? h('div', { className: 'knit-msg' }, t('list.noMatch', { query: query.trim() }))
              : kind === KIND_MEDIA
                ? mediaGrid(visibleDocs, false)
                : kind === KIND_ALL
                  ? allSections
                  : contextView
                    ? contextBody(contextView)
                    : docsGrid(withGhosts(MOTION_TIER_FLAT, visibleDocs))

      // 排序说明那一行（.knit-topic）**2026-09-30 已整体删除**：排序方式由头部那个
      // 「相关 / 最新」切换按钮自己表达（按钮上就写着当前选的是哪个），再补一句
      // 「相关性排序」是重复。命中的关键词**跟着一起消失** —— 它当时只在这行的
      // title 里（可见文本本来就不许出现关键词，test/i18n.test.mjs 有守卫）。
      // ⚠️ i18n 里那四个 topic.* 键已同时删除，不要为了「以后可能用」留着。

      /* v0.18「Context Usage Lens」：列表**上方**的一块轻量观察层。
         它按**视觉层级**回答四件事（规格 §9 的三层）：
           Level 1 当前上下文 Coverage（这一份上下文被用到什么程度）
           Level 2 最近读取（最近一次成功读的是什么）
           Level 3 上下文外读取 / 上下文变化（辅助事实）
         三块不能一样重 —— 靠**空间与字号**拉开，不靠横线、不靠颜色、不靠卡片。
         ⚠️ 不许出现分数 / 百分比 / 评分条 / 置信度 / 「AI 判断」这类词：用户要知道的是
         「这份上下文有没有被用上」，不是「它好不好用」。**没有任何一行是估算出来的。**
         ⚠️ 关掉使用情况时**一个节点都不加**（`.knit-usage` 整个不渲染，与 v0.17 一致）。*/

      const usageNow = usageOn && state.usage && state.usage.stats ? state.usage : null
      // 「Epoch N」只在标题行显示一次：`epochId` 是**累计编号**（换一次 +1），
      // 一份包都没交过时是 null，整个角标不显示（SDD §20）。
      const epochText = usageNow && Number.isInteger(usageNow.epochId)
        ? t('lens.epoch', { n: usageNow.epochId })
        : ''
      // 摘要行＝三件纯事实，一行读完。**不写 Primary 文件名、不写「辅助 0/3」**——
      // 那两件事下面的 Coverage 说得更准、更短（规格 §10）。
      const lensSummary = (() => {
        if (!usageNow) return t('usage.none')
        const s = usageNow.stats
        const parts = [t('lens.reads', { n: s.reads || 0 })]
        if (s.outside) parts.push(t('lens.outside', { n: s.outside }))
        const changes = s.churn && s.churn.snapshots ? s.churn.snapshots : 0
        if (changes) parts.push(t('lens.changes', { n: changes }))
        return parts.join(' · ')
      })()

      /* v0.17 的三条事实 —— 全部只在「使用情况」开着、且宿主真的回传了 `usage` 时出现。
         ⚠️ 这里没有时间线、没有全量事件、没有评分 —— 「最近一次」就只有一条。 */

      // ── Level 1：当前上下文 Coverage ────────────────────────────────
      // ⚠️ 用 `state.context` 的三层**原始** rels（不是 `contextView`：那一份被过滤框
      // 子集化、而且只在文档档 + 相关序成立），再叠上 `usage.lifecycle` —— 纯派生，
      // 不新增任何一份自己的状态（「能派生就不要存储」）。
      const coverage = coverageOf({
        primary: (state.context && state.context.primary) || [],
        supporting: (state.context && state.context.supporting) || [],
        related: (state.context && state.context.related) || [],
      }, usageNow ? usageNow.lifecycle : null)
      const coverageNode = contextView ? h('div', { className: 'knit-lens-sec', key: 'cov' },
        h('div', { className: 'knit-lens-cap' }, t('lens.currentContext')),
        h('div', { className: 'knit-cov' },
          ['primary', 'supporting', 'related']
            // Primary 可以被一份包整体缺席 —— 那就整列不显示，而不是画一个
            // 「0 / 0」的假层（规格 §11：Knit 不能假设一定有 Primary）。
            .filter((key) => !(key === 'primary' && coverage.primary.total === 0))
            .map((key) => h('button', {
              className: 'knit-cov-col',
              key,
              type: 'button',
              title: t('lens.locate', { tier: t(`tierName.${key}`) }),
              // 读屏的说法是完整一句「主要上下文：0 / 1 篇已读」（md §六十三）——
              // 但**视觉上不显示这句话**：屏幕上给的是层名 + `n / m` + 圆点。
              'aria-label': t('lens.coverageAria', {
                tier: t(`tierName.${key}`),
                read: coverage[key].read,
                total: coverage[key].total,
              }),
              onClick: () => locateTier(key),
            },
            // 视觉（点）与文本（已读 ÷ 本层总数）**同时**存在：只给点读不出「读了几篇」，
            // 只给数字又看不出「是哪几篇」。没有进度条、没有百分比。
            // ⚠️ **顺序**是「层名 → 数字 → 圆点」，不要调换：这三个是 grid 的同一套单元格，
            //    自动排布按 DOM 顺序找空位 —— 层名占第 1 行第 1 列、数字占第 1 行第 2 列、
            //    圆点那一条横跨两列，于是必然落到第 2 行（换顺序数字会被挤到圆点下面一行）。
            h('span', { className: 'knit-cov-name' }, t(`tierName.${key}`)),
            h('span', { className: 'knit-cov-num' },
              `${coverage[key].read} / ${coverage[key].total}`),
            // v0.18 UI 迭代：**真的圆**（9px，见 CSS），不再是 `○ ●` 字符 —— 字符圆点在不同
            // 字体下大小不一，正是「不像设计稿」的那一处。点本身对读屏是装饰（aria-hidden），
            // 「几篇已读」由上面那个 aria-label 的完整句子说。
            h('span', { className: 'knit-cov-dots' },
              coverage[key].rels.map((item) => h('span', {
                className: `knit-cov-dot${item.read ? ' on' : ''}`,
                key: item.rel,
                'aria-hidden': 'true',
              }))))))) : null

      // ── Level 2：最近读取（最近一次**成功** read；不是「正在阅读」）──────
      const recent = usageNow && usageNow.recentRead ? usageNow.recentRead : null
      const recentNode = h('div', { className: 'knit-lens-sec', key: 'recent' },
        h('div', { className: 'knit-lens-name' }, t('lens.recentRead')),
        recent && recent.rel
          ? h('button', {
            className: 'knit-read-row',
            type: 'button',
            title: t('lens.openDoc', { rel: recent.rel }),
            // 这一行整行可点（打开预览），所以它需要一个**完整的可访问名**（md §二十二）：
            // 只有 title 的话读屏在部分平台读不出「这是干什么的」。
            'aria-label': t('lens.openDoc', { rel: recent.rel }),
            onClick: () => openDocByRel(recent.rel),
          },
          h('span', { className: 'knit-read-rel' }, recent.rel),
          h('span', { className: 'knit-read-time' }, relTime(recent.at, tick)),
          // 箭头是装饰（对读屏隐藏）；不要前导空格 —— 间距由 .knit-read-row 的 gap 给。
          h('span', { className: 'knit-read-go', 'aria-hidden': 'true' }, '›'))
          : h('div', { className: 'knit-lens-empty' }, t('lens.recentNone')))

      // ── Level 3a：上下文外读取（可浏览集合；排序是**事实排序**）─────────
      const outsideList = usageNow && Array.isArray(usageNow.outsideDocs) ? usageNow.outsideDocs : []
      const outsideSorted = groupOutsideDocs(outsideList)
      const outsideNode = outsideSorted.length > 0
        ? h('div', { className: 'knit-usage-more', key: 'gap' },
          h('button', {
            className: 'knit-more-btn',
            type: 'button',
            'aria-expanded': gapOpen ? 'true' : 'false',
            onClick: () => setGapOpen((value) => !value),
          },
          // 菜单行的三段（md §三十四）：「label ── 数量 ›」。原来把两条信息压在一个字符串里
          // （`上下文外读取 · 20`），数字既不右对齐、也不能单独参与排版。
          h('span', { className: 'knit-more-label' }, t('lens.outsideDocs')),
          h('span', { className: 'knit-more-meta' }, String(outsideSorted.length)),
          h('span', { className: 'knit-read-go', 'aria-hidden': 'true' }, gapOpen ? '⌃' : '›')),
          gapOpen ? h('div', { className: 'knit-gap-list' },
            // 每一行都是**可点对象**（点开预览），但**不许**加入 Context ——
            // V0.18 不做 Context Control（规格 §19）。
            // 行首序号（md §三十六）：让展开的包外列表可数，并把 rel 与次数隔开。
            // 序号说的是**位置**（第几篇），不是评分。
            outsideSorted.slice(0, MAX_OUTSIDE_SHOWN).map((row, i) => h('button', {
              className: 'knit-out-row',
              key: row.rel,
              type: 'button',
              title: t('lens.openDoc', { rel: row.rel }),
              onClick: () => openDocByRel(row.rel),
            },
            h('span', { className: 'knit-out-num' }, String(i + 1).padStart(2, '0')),
            h('span', { className: 'knit-out-rel' }, row.rel),
            h('span', { className: 'knit-out-count' }, `×${row.count}`),
            // 每一行都带生命周期：**复用 v0.17 那一份数据**，不维护第二套。
            // ⚠️ 用 `lifeWord`（状态词）而不是 `lifecycleLabel`（短次数）：左边已经有 `×N` 了。
            h('span', { className: 'knit-life' }, lifeWord(row.rel)))),
            outsideSorted.length > MAX_OUTSIDE_SHOWN
              ? h('div', { className: 'knit-gap-row' },
                h('span', { className: 'knit-gap-rel' },
                  t('lens.more', { n: outsideSorted.length - MAX_OUTSIDE_SHOWN })))
              : null) : null)
        : null

      // 层级的**短名**：分组标题那套长文案（主要上下文 / 辅助上下文 / 相关上下文）在变化行里太长。
      const tierShort = (key) => {
        if (key === 'primary') return t('tierName.primary')
        if (key === 'supporting') return t('tierName.supporting')
        if (key === 'related') return t('tierName.related')
        return ''
      }
      const delta = usageNow && usageNow.latestDelta ? usageNow.latestDelta : null
      const deltaLine = (text, key) => h('div', { className: 'knit-delta-row', key },
        h('span', { className: 'knit-delta-rel' }, text))
      /** `moved` 的两种载荷都认：v0.17 起宿主给的是 `{tier,rank}`，旧夹具里是裸层名。 */
      const tierOf = (value) => (value && typeof value === 'object' ? value.tier : value)
      const deltaText = (kind, item) => {
        if (kind === 'enter') return `+ ${item.rel}`
        if (kind === 'leave') return `- ${item.rel}`
        return `↔ ${item.rel} · ${tierShort(tierOf(item.from))} → ${tierShort(tierOf(item.to))}`
      }
      // 摘要行的符号只用 `+` `-` `↔` 三个通用符号，不用颜色区分「进 / 出」。
      const grouped = groupDelta(delta)
      const deltaDigest = []
      for (const item of grouped.enter) {
        deltaDigest.push({ key: `plus-${item.rel}`, text: deltaText('enter', item) })
      }
      for (const item of grouped.leave) {
        deltaDigest.push({ key: `minus-${item.rel}`, text: deltaText('leave', item) })
      }
      for (const item of grouped.move) {
        deltaDigest.push({ key: `move-${item.rel}`, text: deltaText('move', item) })
      }
      if (delta && delta.taskChanged) deltaDigest.push({ key: 'task', text: t('usage.deltaTask') })
      const deltaGroups = [
        { key: 'enter', label: t('usage.deltaEnter'),
          rows: grouped.enter.map((item) => ({ key: `plus-${item.rel}`, text: deltaText('enter', item) })) },
        { key: 'leave', label: t('usage.deltaLeave'),
          rows: grouped.leave.map((item) => ({ key: `minus-${item.rel}`, text: deltaText('leave', item) })) },
        { key: 'move', label: t('usage.deltaMove'),
          rows: grouped.move.map((item) => ({ key: `move-${item.rel}`, text: deltaText('move', item) })) },
      ].filter((group) => group.rows.length > 0)
      // ⚠️ `compact` 必须在 `previewLines` 之前算出来（TDZ）。
      const compact = panelH > 0 && panelH < COMPACT_PANEL_PX
      // 面板矮的时候收起态**不铺摘要行** —— 只留标题，点开照常看得到。
      const previewLines = compact ? [] : deltaDigest.slice(0, MAX_DELTA_SHOWN)
      const deltaNode = delta
        ? h('div', { className: 'knit-usage-more', key: 'delta' },
          h('button', {
            className: 'knit-more-btn',
            type: 'button',
            'aria-expanded': deltaOpen ? 'true' : 'false',
            onClick: () => setDeltaOpen((value) => !value),
          },
          // 菜单行的三段（md §三十八）：「上下文变化 ── 最近一次 ›」。
          // ⚠️ 这里**不再写条数**（原来是 `上下文变化 · 11`）：变化永远只说最近一次，
          //    「有几条」由展开后的行数与「还有 N 条」承担 —— 数字写在按钮上时，
          //    折叠摘要、分组尾巴、按钮三处会各自算一遍，很容易自相矛盾。
          h('span', { className: 'knit-more-label' }, t('lens.delta')),
          h('span', { className: 'knit-more-meta' }, t('lens.deltaLatest')),
          h('span', { className: 'knit-read-go', 'aria-hidden': 'true' }, deltaOpen ? '⌃' : '›')),
          // ⚠️ 展开后**不再画折叠摘要**：分组视图是它的超集（三行摘要 + 「还有 N 条」再叠上
          // 分组明细，同一条事实会在同一块里出现两遍 —— 2026-10-05 用真实载荷渲染时抓到）。
          deltaOpen ? null : previewLines.map((line) => deltaLine(line.text, line.key)),
          !deltaOpen && !compact && deltaDigest.length > MAX_DELTA_SHOWN
            ? deltaLine(t('usage.deltaMore', { n: deltaDigest.length - MAX_DELTA_SHOWN }), 'more')
            : null,
          deltaOpen ? deltaGroups
            .map((group) => [
              h('div', { className: 'knit-delta-head', key: `${group.key}-head` }, group.label),
              ...group.rows.slice(0, MAX_DELTA_GROUP)
                .map((line) => deltaLine(line.text, `${group.key}-${line.key}`)),
              group.rows.length > MAX_DELTA_GROUP
                ? deltaLine(t('usage.deltaMore', { n: group.rows.length - MAX_DELTA_GROUP }),
                  `${group.key}-more`)
                : null,
            ]) : null,
          // ⚠️ 「任务上下文已更新」不是进出换层，没有分组标题可挂 —— 但它算在
          // `deltaDigest.length` 里（按钮上那个数字就是它）。展开时漏掉这一行，
          // 就会出现「按钮说 6 条、下面只列出 5 行」的自相矛盾（2026-10-05 用真实载荷渲染时抓到）。
          // 它在摘要里的位置本来就是最后一条，这里也放最后。
          deltaOpen && delta && delta.taskChanged
            ? deltaLine(t('usage.deltaTask'), 'task')
            : null)
        : null

      // ── Lens 整块：标题行（可点，展开 / 收起）+ 摘要行 + 细节 ──────────
      // ⚠️ 「收起」不等于「关掉统计」：收起只表示「统计开着，但暂时不想看细节」（规格 §25）。
      const lensNode = h('div', { className: 'knit-usage', title: t('usage.note') },
        h('button', {
          className: 'knit-lens-head',
          type: 'button',
          'aria-expanded': lensOpen ? 'true' : 'false',
          title: lensOpen ? t('lens.collapse') : t('lens.expand'),
          onClick: () => setLensOpen((value) => !value),
        },
        h('span', { className: 'knit-lens-title' }, t('lens.title')),
        epochText ? h('span', { className: 'knit-lens-epoch' }, epochText) : null,
        h('span', { className: 'knit-read-go', 'aria-hidden': 'true' }, lensOpen ? ' ˄' : ' ˅')),
        h('div', { className: 'knit-lens-sum' }, lensSummary),
        lensOpen ? h('div', { className: 'knit-lens-body' },
          coverageNode, recentNode, outsideNode, deltaNode) : null)

      // 不同类型用不同量词：文档「篇」、代码「个」、媒体「个」、混排「项」。
      const countKey = kind === KIND_MEDIA
        ? (filtering ? 'count.media.filtered' : 'count.media')
        : kind === KIND_CODE
          ? (filtering ? 'count.code.filtered' : 'count.code')
          : kind === KIND_ALL
            ? (filtering ? 'count.all.filtered' : 'count.all')
            : (filtering ? 'count.filtered' : 'count')
      const countText = filtering
        ? t(countKey, { hit: visibleDocs.length, total: state.total })
        : t(countKey, { n: state.total })

      return h('div', {
        className: `knit-root${fullscreen ? ' fullscreen' : ''}`,
        ref: rootRef,
      },
      h('div', { className: 'knit-head' },
        h('button', {
          type: 'button',
          className: 'knit-root-path',
          // 有工作目录才可点；悬停提示说明点了会发生什么
          title: state.root ? t('path.openTitle') : '',
          disabled: !state.root,
          onClick: async () => {
            // 打开文件夹同样要走 canonical 路径 —— 目录也会被同一条 `verifyDesktopPath` 拒。
            setNotice((await openLocalPath(state.hostRoot || state.root)) || '')
          },
        }, state.root || '—'),
        h('div', { className: 'knit-count' }, countText),
        // v0.15：默认关的自查开关。开着才有 `&usage=1` —— 宿主也只在那一刻开始记账。
        h('button', {
          type: 'button',
          className: `knit-btn${usageOn ? ' active' : ''}`,
          'aria-pressed': usageOn,
          title: t('usage.toggleTitle'),
          onClick: () => setUsageOn((value) => !value),
        }, t('usage.toggle')),
        h('button', { className: 'knit-btn', onClick: load, title: t('action.refreshNow') }, t('action.refresh'))),
      h('div', { className: 'knit-bar' },
        h('div', { className: 'knit-seg' },
          h('button', {
            className: `knit-seg-btn${sort === 'relevance' ? ' active' : ''}`,
            onClick: () => pickSort('relevance'),
            title: t('sort.relevanceTitle'),
          }, t('sort.relevance')),
          h('button', {
            className: `knit-seg-btn${sort === 'time' ? ' active' : ''}`,
            onClick: () => pickSort('time'),
            title: t('sort.timeTitle'),
          }, t('sort.time'))),
        h('input', {
          className: 'knit-filter',
          value: query,
          placeholder: t('filter.placeholder'),
          'aria-label': t('filter.aria'),
          onChange: (event) => setQuery(event.target.value),
          onKeyDown: (event) => {
            if (event.key === 'Escape') { event.stopPropagation(); setQuery('') }
          },
        })),
      h('div', { className: 'knit-types', role: 'tablist', 'aria-label': t('kind.title') },
        // v0.19：四档「文档 / 代码 / 媒体 / 全部」。**没有第二层分类** ——
        // 代码里不再按语言（JS / TS / Python…）分组（需求 §46：不给代码加视觉层级压迫）。
        [[KIND_DOC, 'kind.doc'], [KIND_CODE, 'kind.code'], [KIND_MEDIA, 'kind.media'], [KIND_ALL, 'kind.all']].map(([value, labelKey]) =>
          h('button', {
            type: 'button',
            key: value,
            role: 'tab',
            'aria-selected': kind === value,
            className: `knit-type-btn${kind === value ? ' active' : ''}`,
            title: t('kind.title'),
            onClick: () => pickKind(value),
          }, t(labelKey)))),
      // v0.15：开了才显示。v0.18：这一块是「Context Usage Lens」——
      // 列表**上方**的观察层，不是弹窗、不是新页面、不是 Dashboard。
      usageOn ? lensNode : null,
      notice ? h('div', { className: 'knit-notice' }, notice) : null,
      // 列表节点**直接挂上去**（2026-09-29 起永远单栏；曾经它要交给一个 IIFE
      // 决定塞进单栏还是双栏的左列）。**输出与 v0.13 逐字一致** ——
      // 时间序、媒体档、「全部」都不受影响。
      (() => {
        const listNode = h('div', {
          className: 'knit-list',
          ref: listRef,
          tabIndex: 0,
          onKeyDown: onListKeyDown,
          role: 'listbox',
          'aria-label': t('list.aria'),
          // 焦点始终在容器上（roving 焦点会打断「移动即预览」），
          // 所以用 activedescendant 把「当前项」告诉辅助技术。
          // cursor 不在可见列表里时（被过滤/被上限截断）就不指向任何东西。
          'aria-activedescendant': navDocs.some((doc) => doc.rel === cursor)
            ? docOptionId(navDocs.find((doc) => doc.rel === cursor))
            : undefined,
        }, body)
        /* ── 曾经在这里的一层：双栏装配 ────────────────────────
           `if (!contextView) return listNode` 之后是 `.knit-context-layout`
           （两列网格：左 `.knit-col-list` + 右 `.knit-context-column`）、
           右栏里的 `.knit-grip` 拖宽把手，以及 `.knit-pack-scroll` 包着的
           `contextPanel(contextView)`。
           **2026-09-29 整段删除，改成永远单栏**：`listNode` 直接返回，
           DOM 里不再有任何双栏骨架。
           ⚠️ 当初把网格放在 listbox **外面**的那条理由现在仍然成立，所以
           **不要**为了「划一块区域」再往 `.knit-list` 里面塞包装节点 ——
           `role=listbox` 的直接子级只能是 option，多一层 group 会让辅助技术
           把选项算成另一个集合（这条纪律与右栏无关，别跟着一起删）。 */
        return listNode
      })(),
      preview ? h(PreviewPanel, {
        preview,
        pathImages,
        fullscreen,
        ratio,
        // v0.12 引用条
        links,
        linksExpanded,
        onToggleLinks: toggleLinks,
        // 点引用列表里的一项 → 就地预览那一篇。
        // **走订阅制 requestPreview，不碰列表** —— 用户点一下就该立刻有反应
        // （AGENTS.md §6.4 的教训：即时信号别藏在轮询里）。
        onOpenLink: (item) => requestPreview(item),
        // 拿不到绝对路径就不给点（而不是点了没反应）
        onOpenLocal: previewAbsPath ? openPreviewLocal : null,
        onReveal: previewAbsPath ? openPreviewReveal : null,
        /* v0.19 Source map：仍走 `requestPreview` 这条既有通道，不新开一条打开路径。
           `.map` 是宿主分类层判定的 `generated`（previewable 但 contextual:false）——
           面板能看它，列表与检索永远见不到它（需求 §6 §28 §29）。 */
        onOpenMap: (rel) => requestPreview({
          rel,
          title: rel.split('/').pop(),
          kind: KIND_GENERATED,
        }),
        /* v0.19 追加：HTML 的「网页预览」走**同一条**官方标签页通道（`onOpenTab`），
           不新开第二条打开路径。宿主没提供这条能力时按钮置灰，而不是点了没反应。 */
        onOpenWeb: typeof openInTab === 'function' ? () => onOpenTab(preview) : null,
        onClose: closePreview,
        onToggleFullscreen: () => setFullscreen((v) => !v),
        onResizeStart,
      }) : null)
    }

    /* ── 会话入口按钮 ───────────────────────────────── */

    /**
     * 打开 Knit 面板：先试官方右侧栏，再试 better-sidebar。
     *
     * 一个按钮要同时服务两个宿主，所以宿主在**点击时**解析，
     * 而不是在注册时绑定 —— 宿主可能后装、可能被禁用。
     *
     * @param {object} ctx - 客户端根上下文
     * @returns {boolean} 是否有宿主接住了这次打开
     */
    function openKnitPanel(ctx) {
      if (!ctx || typeof ctx.get !== 'function') return false

      const sidebarRight = ctx.get('sidebarRight')
      if (sidebarRight && typeof sidebarRight.openTab === 'function') {
        try {
          // openTab 会顺带展开面板：用户看不见的内容不叫「打开」
          sidebarRight.openTab(KIND)
          return true
        } catch (error) {
          console.warn('[knit] sidebarRight.openTab failed', error)
        }
      }

      const betterSidebar = ctx.get('betterSidebar')
      if (betterSidebar && typeof betterSidebar.openTab === 'function') {
        try {
          betterSidebar.openTab({ type: BS_TAB_ID })
          return true
        } catch (error) {
          console.warn('[knit] betterSidebar.openTab failed', error)
        }
      }

      return false
    }

    /**
     * 造一个入口按钮组件。
     *
     * 两处座位（会话头部右侧、输入框工具行）共用同一个组件，
     * 官方原组件一像素不动，我们只是往 list 座位里追加一项。
     *
     * @param {Function} onOpen - 点击时的动作，返回是否有宿主接住
     * @returns {Function} 组件
     */
    /**
     * 旧内核的兜底读法：从 `sessions` 列表快照里读「当前会话」。
     *
     * ⚠️ **这不是主路径**。2026-09-30 实测当前内核的契约：
     * `ctx.sessions.list` 的快照是 `SessionListState`
     * `{ ids, byId, phase, projectionsBySession }` —— **没有 `current` 字段**
     * （契约注释写着「navigation belongs to view owners」，当前会话归视图所有）。
     * 所以这个函数在现代内核上恒返回空串；悬停浮层的主路径是座位 props 里的
     * `sessionId`（见 `makeEntryButton`）。保留它只是让更老的内核上不至于全空。
     *
     * @returns {string} 会话 id，取不到为空串
     */
    function currentSessionId() {
      try {
        const sessions = rootCtx && typeof rootCtx.get === 'function' ? rootCtx.get('sessions') : null
        const snapshot = sessions && sessions.list && typeof sessions.list.getSnapshot === 'function'
          ? sessions.list.getSnapshot()
          : null
        return (snapshot && snapshot.current) || ''
      } catch {
        return ''
      }
    }

    /**
     * 悬停浮层。只读预览：列出最近几篇，点哪篇就开面板并直接预览哪篇。
     *
     * @param {{rect:object|null, status:string, docs:object[], total:number, now:number,
     *          onOpenDoc:Function, onOpenPanel:Function, onEnter:Function, onLeave:Function}} props - 渲染入参
     * @returns {import('react').ReactElement} 元素
     */
    function KnitPeek({ rect, status, docs, total, now, onOpenDoc, onOpenPanel, onEnter, onLeave }) {
      // 锚在按钮右下方；拿不到 rect（无 DOM / 测试）时给个兜底位置
      const width = 300
      const viewportWidth = typeof window !== 'undefined' && window.innerWidth ? window.innerWidth : 1200
      const right = rect ? Math.max(8, viewportWidth - rect.right) : 16
      const top = rect ? rect.bottom + 6 : 56
      const style = { position: 'fixed', top: `${Math.round(top)}px`, right: `${Math.round(right)}px`, width: `${width}px` }

      const body = status === 'loading'
        ? h('div', { className: 'knit-peek-hint' }, t('preview.loading'))
        : docs.length === 0
          ? h('div', { className: 'knit-peek-hint' }, t('peek.empty'))
          : docs.map((doc) => h('button', {
              key: doc.path || doc.rel,
              type: 'button',
              className: 'knit-peek-doc',
              title: doc.rel,
              onClick: () => onOpenDoc(doc),
            },
            h('span', { className: 'knit-peek-name' }, doc.title || doc.name || doc.rel),
            h('span', { className: 'knit-peek-time' }, relTime(doc.mtimeMs, now))))

      return h('div', {
        className: 'knit-peek',
        style,
        onMouseEnter: onEnter,
        onMouseLeave: onLeave,
      },
      h('div', { className: 'knit-peek-head' },
        h(KnitGlyph, { size: 13 }),
        h('span', null, t('count', { n: total }))),
      h('div', { className: 'knit-peek-list' }, body))
    }

    /**
     * 造一个入口按钮组件：**悬停偷看，点击进右边栏**。
     *
     * 悬停不碰任何框架 API —— 浮层是我们自己画的，所以不会展开右侧栏、
     * 不会引发布局变化。（框架的 `sidebarRight.float` 做不到这一点：
     * `openTab` 一定会展开面板，`float` 又要求 tab 已经停靠。）
     *
     * 官方原组件一像素不动，我们只是往 list 座位里追加一项。
     *
     * @param {Function} onOpen - 点击时的动作，返回是否有宿主接住
     * @returns {Function} 组件
     */
    function makeEntryButton(onOpen) {
      return function KnitEntryButton(props) {
        const [peek, setPeek] = React.useState(null)
        const btnRef = React.useRef(null)
        const showTimer = React.useRef(null)
        const hideTimer = React.useRef(null)

        // 当前会话 id：这个座位是 **session 作用域**
        // （`conversation.session.header.utilities`），框架通过标准 props
        // 直接把当前会话 id 递进来（`SessionStandardProps.sessionId`，
        // 由 `dsh-client-ui-session` 声明、座位契约注释也写明
        // 「Header actions derive their state from standard Session props」）。
        // 这是唯一可靠的来源 —— 老写法读 `sessions` 列表快照的 `current`，
        // 而那个字段在现行契约里不存在（见 `currentSessionId` 的注释）。
        // 属性留在 ref 里给定时器回调用，每次渲染刷新。
        const seatSessionId = (props && props.sessionId) || ''
        const sidRef = React.useRef(seatSessionId)
        sidRef.current = seatSessionId || currentSessionId()

        /** 清掉两个定时器。 */
        const clearTimers = () => {
          if (showTimer.current) { clearTimeout(showTimer.current); showTimer.current = null }
          if (hideTimer.current) { clearTimeout(hideTimer.current); hideTimer.current = null }
        }

        /** 拉浮层要显示的那几篇。 */
        const loadPeek = async () => {
          const sessionId = sidRef.current
          if (!sessionId) {
            setPeek((cur) => (cur ? { ...cur, status: 'ready', docs: [], total: 0 } : cur))
            return
          }
          try {
            const url = `${LIST_API}?sessionId=${encodeURIComponent(sessionId)}&limit=${PEEK_LIMIT}&sort=${readSortPref()}`
            const res = await fetch(url, { headers: { accept: 'application/json' }, cache: 'no-store' })
            const data = await res.json()
            setPeek((cur) => (cur
              ? { ...cur, status: 'ready', docs: (data && data.docs) || [], total: (data && data.total) || 0 }
              : cur))
          } catch {
            setPeek((cur) => (cur ? { ...cur, status: 'ready', docs: [], total: 0 } : cur))
          }
        }

        /** 进入：延迟一点再显示，避免鼠标扫过就弹。 */
        const scheduleShow = () => {
          clearTimers()
          showTimer.current = setTimeout(() => {
            const node = btnRef.current
            const rect = node && typeof node.getBoundingClientRect === 'function' ? node.getBoundingClientRect() : null
            setPeek({ rect, status: 'loading', docs: [], total: 0, now: Date.now() })
            loadPeek()
          }, PEEK_SHOW_DELAY)
        }

        /** 离开：延迟一点再收起，给鼠标从按钮移到浮层的时间。 */
        const scheduleHide = () => {
          clearTimers()
          hideTimer.current = setTimeout(() => setPeek(null), PEEK_HIDE_DELAY)
        }

        return h('span', {
          className: 'knit-peek-anchor',
          onMouseEnter: scheduleShow,
          onMouseLeave: scheduleHide,
        },
        h('button', {
          ref: btnRef,
          type: 'button',
          className: 'knit-entry',
          title: t('entry.label'),
          'aria-label': t('entry.label'),
          onClick: (event) => {
            if (event && typeof event.preventDefault === 'function') event.preventDefault()
            if (event && typeof event.stopPropagation === 'function') event.stopPropagation()
            clearTimers()
            setPeek(null)
            if (!onOpen()) console.warn('[knit] no sidebar host available — the entry button cannot open the panel')
          },
        }, h(KnitGlyph, { size: 16 })),
        peek ? h(KnitPeek, {
          ...peek,
          now: peek.now || Date.now(),
          // 鼠标移进浮层就取消收起；移出去再计时
          onEnter: clearTimers,
          onLeave: scheduleHide,
          onOpenDoc: (doc) => {
            // 先发信号再开面板：面板还没挂时它会留成挂起值，
            // 挂载后第一帧就取走 —— 两种情况都不用等列表
            requestPreview(doc)
            clearTimers()
            setPeek(null)
            onOpen()
          },
          onOpenPanel: () => {
            clearTimers()
            setPeek(null)
            onOpen()
          },
        }) : null)
      }
    }

    /* ── 宿主适配层 ─────────────────────────────────── */

    /**
     * 官方右侧栏的座位适配：`tab.actions` 只能从框架注入的 `useTabInfo()` 拿。
     * @param {object} tabProps - 座位入参
     * @returns {import('react').ReactElement} 元素
     */
    function OfficialTabBody(tabProps) {
      const sessionId = tabProps && tabProps.sessionId

      // 官方写法（ui-sidebar-files）：const { tab } = useTabInfo()
      // 该 prop 由座位契约保证恒定存在，条件调用不破坏 hooks 顺序。
      const useTabInfo = tabProps && tabProps.useTabInfo
      const tabInfo = typeof useTabInfo === 'function' ? useTabInfo() : null
      const actions = tabInfo && tabInfo.tab ? tabInfo.tab.actions : null

      // 座位契约里的 `tab.visible`：右栏收起、或本标签不是当前那个时是 `false`
      // （`SidebarRightTabInfo.tab.visible`，「Docked bodies require expansion and selection」）。
      // **折叠期间 dockkit 不卸载 tag 身体**，所以要自己停下来 —— 见 KnitBody 轮询那段。
      const visible = !tabInfo || !tabInfo.tab || tabInfo.tab.visible !== false

      const openInTab = React.useCallback((doc) => {
        if (!actions || typeof actions.openResource !== 'function') {
          return t('error.noOpenResource')
        }
        try {
          actions.openResource(sessionFileAddress(sessionId, doc.rel))
          return ''
        } catch (error) {
          return t('error.openFailed', { error: String((error && error.message) || error) })
        }
      }, [actions, sessionId])

      return h(KnitBody, { sessionId, openInTab, visible })
    }

    /**
     * better-sidebar 的 tab 适配：走 `ctx.betterSidebar.openTab({type:'editor'})`。
     * 编辑器 tab 被用户关掉时不硬闯，直接把原因交给面板提示。
     * @param {object} bsProps - better-sidebar 的 TabComponentProps
     * @returns {import('react').ReactElement} 元素
     */
    function BetterSidebarTabBody(bsProps) {
      const sessionId = bsProps && bsProps.scope ? bsProps.scope.sessionId : undefined
      const ctx = bsProps && bsProps.ctx

      const openInTab = React.useCallback((doc) => {
        if (!ctx || typeof ctx.get !== 'function') return t('error.bsNoContext')
        const bs = ctx.get('betterSidebar')
        if (!bs || typeof bs.openTab !== 'function') return t('error.bsNoService')
        if (typeof bs.isTabEnabled === 'function' && !bs.isTabEnabled('editor')) {
          return t('error.bsEditorDisabled')
        }
        try {
          bs.openTab({ type: 'editor', path: doc.path, title: doc.name })
          return ''
        } catch (error) {
          return t('error.openFailed', { error: String((error && error.message) || error) })
        }
      }, [ctx])

      return h(KnitBody, { sessionId, openInTab })
    }

    /* ── 图标 ───────────────────────────────────────── */

    /**
     * Knit 的 mono 图标路径（24×24，viewBox 0 0 100 100，4px 描边）。
     *
     * **为什么内联在代码里**：客户端半边没有构建步骤，加载期也不能读文件
     * （`__ModuleLoader__` 直接装载这个脚本），path 只能作为字面量存在。
     * 源文件在 `assets/knit-icon-24-mono-4px.svg` —— **改图标时两处一起改**。
     *
     * 用 `stroke="currentColor"`，颜色由 `.knit-icon` 那条 CSS 定死：
     * **浅色模式纯黑、暗色模式纯白**（暗色信号是 DSH 的 `body[data-ds-dark-theme]`）。
     */
    const KNIT_ICON_PATH = 'M78.73 31.92L78.44 31.53L78.12 31.16L77.79 30.80L77.44 30.45L77.07 30.11L76.69 29.79L76.30 29.48L75.89 29.19L75.46 28.91L75.02 28.64L74.57 28.39L74.10 28.16L73.62 27.94L73.13 27.74L72.62 27.55L72.11 27.38L71.58 27.23L71.04 27.09L70.49 26.97L69.93 26.87L69.36 26.79L68.78 26.72L68.20 26.67L67.60 26.64L67.00 26.63L66.39 26.63L65.78 26.65L65.16 26.70L64.53 26.76L63.90 26.83L63.26 26.93L62.62 27.05L61.98 27.18L61.33 27.33L60.68 27.50L60.03 27.69L59.38 27.90L58.73 28.13L58.08 28.37L57.43 28.64L56.78 28.92L56.13 29.21L55.48 29.53L54.83 29.86L54.19 30.22L53.55 30.58L52.91 30.97L52.28 31.37L51.66 31.79L51.04 32.23L50.42 32.68L49.82 33.14L49.21 33.63L48.62 34.12L48.03 34.64L47.46 35.16L46.89 35.71L46.33 36.26L45.78 36.83L45.23 37.41L44.70 38.01L44.18 38.61L43.68 39.23L43.18 39.86L42.69 40.51M51.45 83.91L51.94 83.83L52.42 83.74L52.90 83.63L53.37 83.49L53.84 83.34L54.31 83.16L54.77 82.97L55.23 82.75L55.68 82.52L56.13 82.26L56.57 81.99L57.01 81.69L57.43 81.38L57.85 81.05L58.26 80.70L58.67 80.33L59.06 79.94L59.45 79.54L59.82 79.12L60.19 78.68L60.54 78.22L60.88 77.75L61.21 77.26L61.54 76.76L61.84 76.24L62.14 75.70L62.42 75.15L62.69 74.59L62.95 74.01L63.19 73.42L63.42 72.82L63.64 72.20L63.84 71.57L64.02 70.93L64.19 70.28L64.35 69.62L64.49 68.95L64.62 68.27L64.73 67.58L64.82 66.88L64.90 66.17L64.96 65.46L65.00 64.74L65.03 64.01L65.04 63.27L65.04 62.54L65.01 61.79L64.98 61.04L64.92 60.29L64.85 59.53L64.76 58.77L64.65 58.01L64.53 57.25L64.39 56.49L64.23 55.72L64.06 54.96L63.87 54.20L63.66 53.43L63.44 52.67L63.20 51.91L62.95 51.16L62.68 50.41L62.39 49.66L62.09 48.91L61.77 48.17M19.85 34.46L19.68 34.91L19.52 35.38L19.39 35.85L19.27 36.33L19.18 36.82L19.10 37.32L19.05 37.82L19.01 38.32L19.00 38.84L19.00 39.35L19.02 39.87L19.07 40.40L19.13 40.92L19.22 41.45L19.32 41.99L19.44 42.52L19.59 43.05L19.75 43.59L19.94 44.13L20.14 44.66L20.37 45.19L20.61 45.73L20.87 46.26L21.16 46.79L21.46 47.31L21.78 47.84L22.12 48.35L22.48 48.87L22.86 49.38L23.25 49.88L23.67 50.38L24.10 50.87L24.55 51.36L25.02 51.84L25.50 52.31L26.00 52.77L26.52 53.23L27.05 53.67L27.60 54.11L28.16 54.53L28.74 54.95L29.33 55.36L29.94 55.75L30.56 56.14L31.20 56.51L31.84 56.87L32.50 57.22L33.17 57.56L33.86 57.88L34.55 58.19L35.26 58.49L35.97 58.78L36.70 59.05L37.43 59.30L38.17 59.54L38.93 59.77L39.68 59.98L40.45 60.18L41.22 60.36L42.00 60.53L42.79 60.68L43.57 60.82L44.37 60.94L45.16 61.04'

    /**
     * Knit 图标。guide 页入口胶囊、tab 芯片标题、better-sidebar tab 都用它。
     *
     * @param {{size?:number, className?:string}} props - 尺寸与附加 class
     * @returns {import('react').ReactElement} 元素
     */
    function KnitGlyph({ size, className }) {
      // 图标可能在 KnitBody 之前渲染（guide 胶囊、tab 芯片），
      // 所以样式表由图标自己保证注入，不依赖面板先渲染。
      ensureStyle()

      const s = size || 16
      return h('svg', {
        width: s,
        height: s,
        viewBox: '0 0 100 100',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 16.67,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        className: className ? `knit-icon ${className}` : 'knit-icon',
        'aria-hidden': 'true',
        focusable: 'false',
      }, h('path', { d: KNIT_ICON_PATH }))
    }

    /**
     * tab 芯片上的标题：图标 + 名称。
     *
     * 用内联样式而不是 class —— 芯片标题可能在 KnitBody 之前渲染，
     * 那时 ensureStyle() 还没跑，样式表还不存在。
     *
     * @returns {import('react').ReactElement} 元素
     */
    function KnitTitle() {
      return h('span', {
        style: { display: 'inline-flex', alignItems: 'center', gap: '5px', minWidth: 0 },
      }, h(KnitGlyph, { size: 16 }), t('type.label'))
    }

    /* ── 注册 ───────────────────────────────────────── */

    /**
     * 插件根上下文。apply 时赋值，供「打开本地文件夹」在点击时解析 remote 服务。
     *
     * 用「点击时解析」而不是注册时绑定：`remote.session` 可能后到，
     * 而且宿主可能被换掉（与 openKnitPanel 同一个理由）。
     */
    let rootCtx = null

    /**
     * 「点浮层里的某一篇 → 在面板里直接打开它」的即时信号。
     *
     * 为什么不用「挂在某个变量上、等列表拉回来再消费」：
     * KnitBody 的 load() 是**挂载时一次 + 之后每 5 秒一次**，
     * 面板已经开着时那样做要等下一次轮询（最长 5 秒才响应）。
     * 而且列表接口要扫整个工作区（最慢 4 秒），**预览根本不需要等它** ——
     * 浮层里已经有 rel 和 title 了。
     *
     * 所以改成订阅制：面板挂着就立刻送达，没挂就留一份挂起值给挂载时取。
     */
    let pendingPreview = null
    /** @type {Set<Function>} */
    const previewSubscribers = new Set()

    /**
     * 已经**展开过引用条**的文档，key 见 `previewKey`。
     *
     * **故意放在模块级而不是组件 state**：「用户做过的事」不能只放组件 state ——
     * 宿主重挂载会把它清零，用户就得再点一次（见 `AGENTS.md` §6.9）。
     * 语义是「这一篇在这个会话里被展开过」。
     *
     * @type {Set<string>}
     */
    const expandedLinks = new Set()

    /**
     * 「用户对这篇做过某件事」的 key：同一会话里的同一篇文档算一个（引用条展开态在用）。
     * @param {string} sessionId - 会话 id
     * @param {string} rel - 工作区相对路径
     * @returns {string} key
     */
    function previewKey(sessionId, rel) {
      return `${sessionId || ''}\u0000${rel || ''}`
    }

    /**
     * 请求在面板里打开某一篇。面板挂着就立刻生效，没挂就留一份挂起。
     * @param {{rel:string, title?:string, name?:string, path?:string, kind?:string}} doc - 目标文档
     * @returns {void}
     */
    function requestPreview(doc) {
      if (!doc || !doc.rel) return
      const target = { rel: doc.rel, title: doc.title || doc.name || doc.rel }
      /* v0.19：把 `path` / `kind` 一起带过去。
         以前这里只传 `rel` + `title`，于是接收端只能自己猜类型（猜的结果就是
         「一律当 Markdown」）。分类结论在宿主，这一路上不该被丢掉。
         ⚠️ 两个字段都**只在有值时**写入：调用方常传 `{rel, title}`，别把
         `kind: undefined` 传下去，那会覆盖掉接收端的兜底默认值。 */
      if (doc.path) target.path = doc.path
      if (doc.kind) target.kind = doc.kind
      if (previewSubscribers.size === 0) {
        pendingPreview = target
        return
      }
      previewSubscribers.forEach((notify) => notify(target))
    }

    /**
     * 订阅预览请求。
     * @param {Function} notify - 收到目标时调用
     * @returns {Function} 退订
     */
    function subscribePreview(notify) {
      previewSubscribers.add(notify)
      return () => previewSubscribers.delete(notify)
    }

    /**
     * 用操作系统的文件管理器打开一个本地路径。
     *
     * 走官方 Remote：`ctx.remote.session.openWorkspacePath({ path })`。
     * 它把业务值折进一个信封（`{ ok: true, value } | { ok: false, error }`），
     * 所以这里要拆信封而不是直接 await 出结果。
     *
     * `options.reveal` 走的是**同一个** remote 的同一个方法，只是多带一个
     * `action: 'reveal'`（DSH 的 `SessionOpenWorkspacePathRequest.action`）。
     * 主机侧落在 `revealNativePath` 上：macOS 是 `open -R`、Windows 是
     * `explorer /select,`，也就是**打开所在文件夹并选中这个文件** ——
     * 用户不必再在文件夹里自己找（Chrome「在文件夹中显示」是同一件事）。
     * ⚠️ Linux 的 xdg-open 没有「选中」这个概念，那边只有打开目录，
     * 这是平台差异，不是我们少做了一步。
     *
     * @param {string} path - 绝对路径（reveal 要的是**文件本身**，不是它所在的目录）
     * @param {{reveal?:boolean}} [options] - `reveal` 为真则在文件管理器里选中它
     * @returns {Promise<string>} 空串表示成功，否则是失败原因
     */
    async function openLocalPath(path, options = {}) {
      if (!path) return t('error.hostFailed')
      const services = rootCtx && typeof rootCtx.get === 'function' ? rootCtx.get('remote.session') : null
      if (!services || typeof services.openWorkspacePath !== 'function') {
        return t('error.noHostTab')
      }
      const request = options.reveal ? { path, action: 'reveal' } : { path }
      try {
        const result = await services.openWorkspacePath(request)
        if (result && result.ok === false) {
          const detail = result.error && (result.error.message || result.error.code)
          return t('error.openFailed', { error: String(detail || 'unknown') })
        }
        return ''
      } catch (error) {
        return t('error.openFailed', { error: String((error && error.message) || error) })
      }
    }

    module.exports.inject = ['slots', 'locale']
    module.exports.apply = (ctx) => {
      rootCtx = ctx
      // ⓪ 国际化：注册双语词典，再把 t 绑到当前活动语言。
      //    bind 返回的函数身份稳定、**按调用时读取活动语言**，所以可以长期持有；
      //    DSH 切换语言时 locale 会 bump revision，插座运行时据此重渲染，
      //    文案随之更新（无需重新注册）。
      ctx.effect(() => ctx.locale.register(NS, { zh: ZH, en: EN }), 'dsh-knit: dictionaries')
      t = ctx.locale.bind(NS)

      // ① 会话入口按钮：一个官方 list 座位（追加，不动官方组件）
      //
      //    为什么放这里而不是产物卡片的下拉菜单：
      //    那个菜单的 items 是官方组件里硬编码的两项数组、onSelect 只认
      //    'open' | 'reveal'，deliverables 包声明了 0 个座位 —— 加不了第三项。
      //    而「入口太深」这个真实痛点，官方本来就留了 list 座位给入口按钮。
      //
      //    只挂会话头部右侧一处：输入框工具行那处实测「太刻意」，去掉了。
      //    头部这处紧挨右侧栏展开按钮，是「开侧边面板」的天然位置。
      //
      //    宿主在点击时才解析（openKnitPanel 内部 ctx.get），所以宿主后装 /
      //    被禁用 / 换成 better-sidebar 都不影响这个按钮的存在。
      const EntryButton = makeEntryButton(() => openKnitPanel(ctx))

      ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({
        name: 'conversation.session.header.utilities',
        id: 'knit:entry',
        order: 40,
        locale: NS,
      }, EntryButton))

      // ① DSH 自带右侧栏（主路径）
      //    可选依赖：不在顶层 inject 里，缺失时子 fiber 只等待、不报错。
      ctx.inject(['sidebarRightTabs'], (srCtx) => {
        const tabs = srCtx.sidebarRightTabs
        if (!tabs || typeof tabs.register !== 'function') {
          console.info('[knit] official right sidebar unavailable — skipping tab registration')
          return
        }

        // 类型：page 类型（无 patterns），靠 guide 入口 / openTab('knit') 打开
        srCtx.effect(() => tabs.register({
          id: TAB_ID,
          kind: KIND,
          priority: 'extension',
          title: () => t('type.label'),
          guide: [{
            order: 30,
            title: () => t('guide.title'),
            description: () => t('guide.description'),
            icon: KnitGlyph,
          }],
        }), 'dsh-knit: sidebar-right type')

        srCtx.effect(() => srCtx.slots.inject('sidebar.right.pane.tab', () => srCtx.slots.register({
          name: 'sidebar.right.pane.tab',
          key: TAB_ID,
        }, OfficialTabBody)), 'dsh-knit: sidebar-right body')

        srCtx.effect(() => srCtx.slots.inject('sidebar.right.pane.tab.title', () => srCtx.slots.register({
          name: 'sidebar.right.pane.tab.title',
          key: TAB_ID,
        }, KnitTitle)), 'dsh-knit: sidebar.right title')

        console.log('[knit] registered on the official right sidebar: kind =', KIND)
      })

      // ② dsh-better-sidebar（可选宿主）
      //    同样走 ctx.inject 子 fiber：没装 / 被禁用时静默等待，不影响 ①。
      ctx.inject(['betterSidebar'], (bsCtx) => {
        const bs = bsCtx.betterSidebar
        if (!bs || typeof bs.registerTab !== 'function') {
          console.info('[knit] betterSidebar service not present — skipping tab registration')
          return
        }

        //    hidden: true 是给 better-sidebar v0.24.1+ 的「原生表面」用的：那一版起它把
        //    每个 descriptor 镜像成官方右侧栏的一个类型（id `dsh-better-sidebar:<id>`、
        //    kind 取这里的 id），并在 descriptor 没写 hidden 时**连带注册一条 guide 条目**。
        //    于是「开始」页上出现两行一模一样的「Knit 最近文档」：① 的 kind 'knit' 与镜像的
        //    kind 'knit:recent'。hidden 只掐掉镜像那条 guide 条目（+ 菜单项），类型、座位与
        //    ctx.betterSidebar.openTab 都还在 —— 入口保留 ① 那条（不看宿主装没装都在）。
        bsCtx.effect(() => bs.registerTab({
          id: BS_TAB_ID,
          title: () => t('guide.title'),
          icon: KnitGlyph,
          order: 30,
          single: true,                       // 同类型只开一个
          hidden: true,                       // 别让镜像在官方 guide 里再挂一行（见上）
          component: (props) => h(BetterSidebarTabBody, props),
        }), 'dsh-knit: better-sidebar tab')

        console.log('[knit] registered on dsh-better-sidebar: ', BS_TAB_ID)
      })
    }

    return module.exports
  },
})

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
      'count.media': '{n} 个媒体',
      'count.media.filtered': '{hit} / {total} 个媒体',
      'count.all': '{n} 项',
      'count.all.filtered': '{hit} / {total} 项',
      'action.refresh': '刷新',
      'path.openTitle': '在文件管理器中打开',
      'peek.openPanel': '点击打开面板',
      'peek.empty': '这个工作区里还没有 Markdown 文档。',
      'action.refreshNow': '立即刷新',

      'sort.relevance': '相关',
      'sort.time': '最新',
      'sort.relevanceTitle': '按与当前对话的相关性排序（纯本地关键词匹配，不调模型）',
      'sort.timeTitle': '按文件修改时间倒序',

      'kind.all': '全部',
      'kind.doc': '文档',
      'kind.media': '图片与视频',
      'kind.title': '切换要列出的产物类型',

      'filter.placeholder': '过滤标题 / 摘要 / 路径',
      'filter.aria': '过滤文档',

      // 关键词**退到 title 里当低层 metadata**（2026-09-29 用户要求弱化）：
      // 可见的只有「相关性排序」一句，命中了哪几个词只在悬停时给。
      'topic.relevanceTerms': '按相关度排序 · 命中的关键词：{topic}',
      'topic.relevancePlain': '相关性排序',
      'topic.needsConversation': '对话内容还不足，暂按最新排序',
      'topic.time': '按修改时间倒序',

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
      'preview.openLocal': '{path}\n用系统默认应用打开这篇文档',
      'preview.openLocalBtn': '在本地打开',
      'preview.close': '收起预览',
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
      'host.markdownOnly': '只支持 Markdown',
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
      'count.media': '{n} media',
      'count.media.filtered': '{hit} / {total} media',
      'count.all': '{n} items',
      'count.all.filtered': '{hit} / {total} items',
      'action.refresh': 'Refresh',
      'path.openTitle': 'Open in file manager',
      'peek.openPanel': 'Click to open the panel',
      'peek.empty': 'No Markdown documents in this workspace yet.',
      'action.refreshNow': 'Refresh now',

      'sort.relevance': 'Relevant',
      'sort.time': 'Recent',
      'sort.relevanceTitle': 'Sort by relevance to the current conversation (local keyword matching, no model call)',
      'sort.timeTitle': 'Sort by file modified time, newest first',

      'kind.all': 'All',
      'kind.doc': 'Docs',
      'kind.media': 'Images & video',
      'kind.title': 'Switch which artifacts are listed',

      'filter.placeholder': 'Filter title / summary / path',
      'filter.aria': 'Filter documents',

      // Keywords are **low-level metadata** now (2026-09-29): the visible text is just
      // "Sorted by relevance" — which terms matched only shows up on hover.
      'topic.relevanceTerms': 'Sorted by relevance · matched keywords: {topic}',
      'topic.relevancePlain': 'Sorted by relevance',
      'topic.needsConversation': 'Not enough conversation yet — sorted by time',
      'topic.time': 'Sorted by modified time',

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
      'preview.openLocal': '{path}\nOpen this document in your default app',
      'preview.openLocalBtn': 'Open locally',
      'preview.close': 'Close preview',
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
      'host.markdownOnly': 'Markdown only',
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
      'knit/markdown-only': 'host.markdownOnly',
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

    /** 列表类型：仅文档 / 仅图片视频 / 全部混排。默认 doc，与旧版体验一致。 */
    const KIND_DOC = 'doc'
    const KIND_MEDIA = 'media'
    const KIND_ALL = 'all'

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
  height:24px;padding:0 9px;border-radius:6px;cursor:pointer;
  background:transparent;color:var(--dsw-alias-label-secondary,#9aa0a6);
  border:.5px solid var(--dsw-alias-border-l4,rgba(255,255,255,.08));font-size:11px}
.knit-btn:hover{background:var(--knit-hover-bg,rgba(255,255,255,.03));
  color:var(--dsw-alias-label-primary,#e8eaed)}
.knit-bar{display:flex;align-items:center;gap:8px;padding:0 12px 8px;flex:none}
.knit-seg{display:inline-flex;flex:none;border-radius:7px;overflow:hidden;
  border:.5px solid var(--dsw-alias-border-l4,rgba(255,255,255,.1))}
.knit-seg-btn{height:22px;padding:0 10px;cursor:pointer;font-size:11px;border:none;
  background:transparent;color:var(--dsw-alias-label-secondary,#9aa0a6)}
.knit-seg-btn:hover{background:var(--knit-hover-bg,rgba(255,255,255,.03))}
.knit-seg-btn.active{background:var(--knit-active-bg,rgba(255,255,255,.085));
  color:var(--dsw-alias-label-primary,#e8eaed);font-weight:600}
.knit-filter{flex:1;min-width:0;height:24px;padding:0 9px;border-radius:7px;font-size:11px;
  background:transparent;color:var(--dsw-alias-label-primary,#e8eaed);
  border:.5px solid var(--dsw-alias-border-l4,rgba(255,255,255,.1));outline:none}
.knit-filter:focus{border-color:var(--knit-accent)}
.knit-filter::placeholder{color:var(--dsw-alias-label-caption,#80868b)}
.knit-topic{flex:none;padding:0 12px 9px;font-size:10.5px;line-height:1.4;
  color:var(--dsw-alias-label-caption,#80868b);
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
/* ⚠️ 这里以前有一条 border-bottom（全宽横线）。2026-09-29 用户要求**减少全宽分割线**
   ——「页面上横线一多，读起来就像文件管理表格」。层级改由空间与字号建立：
   这一行只用 bottom padding 与列表拉开距离，不画线。 */


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
.knit-why{padding-top:2px;font-size:11px;line-height:1.5;color:var(--dsw-alias-text-tertiary)}
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
   正文就永远不会因为少一个序号而左移。 */
/* 行的**静止态没有底色**（2026-09-29 用户反馈：「深色模式下，文档列表没有选中，鼠标没有悬停，
   不需要有背景。或者是说，跟深色模式的最底下的背景一样」）。
   ⚠️ 这里以前写的是 bg-layer-1 —— 浅色主题下它和面板底色都是 #fff（根本看不出来），
   **暗色主题下它比 bg-base 亮一档**，于是每一行都像一张浮起来的小卡片，哪怕没选中、没悬停。
   现在静止态直接 transparent，露出宿主侧边栏的底色（.knit-root / .knit-list 都不画底色）；
   ⚠️ 右栏删除后这段注释里提到的 .knit-pack 已经不存在了（2026-09-29），
   hover 与 .active 各有自己的令牌，
   两者都**不该**跟着改成 transparent（那样一屏灰里就认不出选中态了）。 */
.knit-doc{display:grid;grid-template-columns:22px minmax(0,1fr);column-gap:8px;align-items:start;
  padding:10px 11px;border-radius:10px;cursor:pointer;
  border:.5px solid transparent;background:transparent;
  transition:background .18s,border-color .18s,transform .18s,opacity .18s}
.knit-doc:hover{background:var(--knit-hover-bg,rgba(255,255,255,.03));
  border-color:var(--dsw-alias-border-l4,rgba(255,255,255,.1));transform:translateX(-2px)}
/* 选中（正在预览）用**中性描边**（Design §12 / 2026-09-29 用户裁决）。
   ⚠️ 这里曾经是品牌色描边。用户本次的决定是「按 Design 改成 neutral border」，
   理由是 Design §8「用灰阶建立层级，而不是用颜色建立层级」——
   选中态要能从一屏灰里被认出来，但不该在整个界面里唯一地跳成蓝色。
   两个态不再靠色相区分，而是靠「选中＝整行描边 + 灰底」。 */
.knit-doc.active{border-color:var(--dsw-alias-border-l4,rgba(255,255,255,.22));
  background:var(--knit-active-bg,rgba(255,255,255,.085))}
/* .knit-doc.cursor **故意不设样式**：键盘焦点靠「移动即预览」的预览面板表达，
   再加描边会与 .active 的整块背景重复，显得突兀。
   （曾经有一条 「.knit-multicol .knit-doc.cursor」 的中性环，是为多列网格补的 ——
   多列没了，那条也删了。） */
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
.knit-num{grid-column:1;font-size:10.5px;line-height:19.6px;font-variant-numeric:tabular-nums;
  color:var(--dsw-alias-label-caption,#80868b)}
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
.knit-time{flex:none;font-size:10.5px;color:var(--dsw-alias-label-caption,#80868b)}
/* 标题现在和 Primary 点、时间**同行**（见 .knit-row1 的说明；margin-bottom 移到了那一行）。
   仍是单行省略 —— 列表是扫读用的，想看全标题就预览或打开；折行会让每条卡高度不一，
   「移动到下一项」的位移就没法预期。
   flex:1 1 auto + min-width:0 是**时间能被推到行尾、且长标题在时间之前省略**的前提：
   去掉 min-width:0，标题会把整行撑宽（省略号失效）；去掉 flex-grow，时间会紧贴标题而不是靠右。 */
.knit-title{flex:1 1 auto;min-width:0;font-weight:600;font-size:14px;line-height:1.4;
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.knit-sum{font-size:12px;line-height:19px;color:var(--dsw-alias-label-secondary,#9aa0a6);
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
/* 头对齐官方文档预览面板（.dhJKeW_header）：38px 高 + border-l3，
   里面放路径面包屑而不是标题 —— 正文 H1 已经写了标题，重复只添乱。 */
.knit-preview-head{box-sizing:border-box;display:flex;align-items:center;gap:4px;
  height:38px;padding:0 6px 0 12px;flex:none;
  border-bottom:.5px solid var(--dsw-alias-border-l3,rgba(255,255,255,.14))}
/* 路径面包屑：**可点** —— 用系统默认应用打开这篇本地文档（阅读时多一个入口）。
   目录可收缩并出省略号，文件名不收缩，所以长路径下仍然看得见是哪个文件。 */
.knit-preview-path{flex:1 1 auto;min-width:0;display:flex;align-items:center;
  margin-right:6px;font-size:12px;white-space:nowrap;overflow:hidden;
  background:transparent;border:none;padding:0;font-family:inherit;text-align:left;
  color:inherit;cursor:pointer}
.knit-preview-path:disabled{cursor:default}
.knit-preview-path:hover:not(:disabled) .knit-preview-name{text-decoration:underline}
.knit-preview-dir{flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;
  color:var(--dsw-alias-label-tertiary,rgba(255,255,255,.4))}
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

/* ── 引用条（v0.12）────────────────────────────────────
   夹在预览头与正文之间的一层。全用中性令牌：它是「信息」，不是「操作」。
   注意 CSS 里不要写反引号 —— 这段样式是模板字符串，一个反引号就会把它截断。 */
.knit-links{flex:none;border-bottom:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.08));
  font-size:11px;color:var(--dsw-alias-label-secondary,#9aa0a6)}
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
   底部一条 hairline，选中的那个用「深色文字 + 2px 深色下划线」表达。
   ⚠️ 2026-09-29 用户裁决：这条**覆盖**了早先那条「选中填充背景灰就可以」。
   当时用户的原话是「选中的时候不用加绿色、蓝色的描边，就跟下面列表一样」——
   诉求是「别用品牌色描边」；现在连灰底也不要了，层级交给下划线，
   依然不许出现 --knit-accent / --knit-accent-fill（Design §8：灰阶分层）。
   ⚠️ 排序切换（.knit-seg-btn，Design §18）是**另一个控件**，它保持灰底不变。 */
.knit-types{display:flex;gap:14px;padding:0 12px;flex:none;
  border-bottom:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.06))}
.knit-type-btn{flex:none;height:28px;padding:0;cursor:pointer;
  border:none;border-bottom:2px solid transparent;background:transparent;
  color:var(--dsw-alias-label-secondary,#9aa0a6);font-family:inherit;font-size:11.5px;
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
.knit-peek-list + .knit-peek-hint{margin-top:4px;padding-top:8px;
  border-top:.5px solid var(--dsw-alias-border-l4,rgba(255,255,255,.08))}

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
.knit-root.fullscreen .knit-topic,
.knit-root.fullscreen .knit-list{display:none}
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
      return v === KIND_MEDIA || v === KIND_ALL ? v : KIND_DOC
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

    function DocRow({ doc, now, active, cursor, relevance, why, num, primary, onSelect, onOpenTab, optionId }) {
      const fresh = now - doc.mtimeMs < NEW_WINDOW_MS

      return h('div', {
        className: `knit-doc${active ? ' active' : ''}${cursor ? ' cursor' : ''}${fresh ? ' fresh' : ''}`,
        // listbox 的选项语义：有 role 才能被读成「N 项中的第 i 项」，
        // 有 aria-selected 才能播报「当前选中」。
        role: 'option',
        id: optionId,
        'aria-selected': active ? 'true' : 'false',
        'data-knit-rel': doc.rel,
        title: t('row.tooltip', { path: doc.rel }),
        onClick: () => onSelect(doc),
        onDoubleClick: () => onOpenTab(doc),
      },
      // ── 序号＝**最左边独立一列**（2026-09-29 用户追加要求）──────────────
      // 用户原话：「文档列表序号放在独立最左边，其他数据放在右边」。所以序号从行一里
      // 搬了出来，成为 .knit-doc 这条两列 grid 的第一列，其余数据全在右边堆叠。
      // v0.14（Design §11）：只有 Context Pack 前三层的条目有号；「其他相关文档」里的
      // 没有 —— 那些不属于这个包，编号会把它们谎报成包的一部分。**没有号时整个节点不渲染**，
      // 左边那一列由 grid 轨道保着（正文照样和有条目的行对齐，不会左移）。
      num ? h('span', { className: 'knit-num' }, String(num).padStart(2, '0')) : null,
      // 右边这一列＝其余全部数据。列位置由 .knit-body 的 grid-column 定死 ——
      // 靠自动排布的话，没有序号时正文会掉进第一列。
      h('div', { className: 'knit-body' },
        // 行一＝**标题行**（Primary 点 + 标题 + 相对时间，**时间靠右**）—— 2026-09-29 用户要求
        // 「将时间放到标题同行，时间放在右边，然后标题跟时间就可以以序号平行，居中平行」。
        // 序号那一列与这一行垂直居中（靠 .knit-num 的 line-height，CSS 里有说明）。
        h('div', { className: 'knit-row1' },
          // v0.14（Design §13）：Primary 唯一允许的标记 —— 5px 黑点。
          // 不是星标、不是徽章、不是 AI 图标：「重要来自位置和结构，不来自图标」。
          primary ? h('span', { className: 'knit-dot', 'aria-hidden': 'true' }) : null,
          h('div', { className: 'knit-title' },
            fresh ? h('span', { className: 'knit-badge' }, '🆕') : null,
            doc.title || doc.name),
          // 时间在标题右边的行尾 —— 靠 .knit-title 的 flex-grow 推过去，不是靠 margin。
          h('div', { className: 'knit-time' }, relTime(doc.mtimeMs, now))),
        doc.summary
          ? h('div', { className: 'knit-sum' }, doc.summary)
          : h('div', { className: 'knit-sum empty' }, t('summary.empty')),
        // ⚠️ **列表行里不再有路径**（2026-09-29 用户要求）：「文档列表中的文档路径，我觉得
        //    不需要出现了，因为点开查看文档详情的时候已经有了，所以这里是重复的，隐藏掉」。
        //    —— 这是**重复信息**，不是「多列砍字段」那种静默降级：预览头的面包屑
        //    （`.knit-preview-path`：目录浅 + 文件名亮，还可点）始终显示完整路径。
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
     * @param {{preview:object,pathImages:object|null,fullscreen:boolean,onClose:Function,onOpenLocal:Function|null,onToggleFullscreen:Function,onResizeStart:Function}} props - 渲染入参
     * @returns {import('react').ReactElement} 元素
     */
    function PreviewPanel({ preview, pathImages, fullscreen, ratio, links, linksExpanded, onToggleLinks, onOpenLink, onClose, onOpenLocal, onToggleFullscreen, onResizeStart }) {
      const isMedia = preview.kind === 'image' || preview.kind === 'video'
      const previewPath = splitRelPath(preview.rel)

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
        style: fullscreen ? undefined : { maxHeight: `${Math.round(ratio * 100)}%` },
      },
        fullscreen ? null : h('div', { className: 'knit-resize', onPointerDown: onResizeStart, title: t('preview.resizeTitle') }),
        h('div', { className: 'knit-preview-head' },
          // 路径面包屑，**可点**：用系统默认应用打开这篇本地文档 —— 阅读时多一个
          // 「跳到本地」的入口。不放标题：正文 H1 已经写了，重复会让
          // 「列表行 / 预览头 / 正文」出现三遍同一个词，反而分不清哪块是详情。
          h('button', {
            type: 'button',
            className: 'knit-preview-path',
            title: onOpenLocal ? t('preview.openLocal', { path: preview.rel }) : preview.rel,
            disabled: !onOpenLocal,
            onClick: () => { if (onOpenLocal) onOpenLocal() },
          },
          previewPath.dir
            ? h('span', { className: 'knit-preview-dir' }, previewPath.dir)
            : null,
          h('span', { className: 'knit-preview-name' }, previewPath.name)),
          h('button', {
            className: 'knit-btn',
            onClick: onToggleFullscreen,
            title: fullscreen ? t('preview.exitFullscreenTitle') : t('preview.fullscreenTitle'),
          }, fullscreen ? t('preview.exitFullscreen') : t('preview.fullscreen')),
          // 「在本地打开」＝ 之前那个「新标签页」的位置（v0.10）。
          // 「新标签页」开的是官方文档预览，但面板里已经有就地预览，重复度高、用得少；
          // 而「用默认应用打开这篇文档」原本只藏在路径面包屑的悬停提示里 ——
          // 把值钱的那个放到显眼处，把鸡肋的那个让位（双击列表行仍能开新标签页）。
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
     * @param {{sessionId?:string, openInTab?:Function}} props - 渲染入参。
     *   `openInTab(doc)` 返回空串表示成功，返回文案表示失败原因。
     * @returns {import('react').ReactElement} 元素
     */
    function KnitBody({ sessionId, openInTab }) {
      ensureStyle()

      const [notice, setNotice] = React.useState('')
      const [sort, setSort] = React.useState(readSortPref)
      // 紧跟 sort：测试按 hook 顺序预置前两位（notice/sort），kind 放第三位不影响老用例。
      const [kind, setKind] = React.useState(readKindPref)
      const [state, setState] = React.useState({
        status: 'loading', docs: [], root: '', total: 0, error: '', mode: 'time', topic: '',
        // v0.14：当前任务上下文（Context Pack）。宿主只在「文档档 + 相关序 + 有命中」时给，
        // 其余情形是 null —— 那时面板退回它一直在用的平铺列表（行为与 v0.13 逐字一致）。
        context: null,
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

      const load = React.useCallback(async () => {
        if (!sessionId) {
          setState({ status: 'error', docs: [], root: '', total: 0, error: t('error.noSession'), mode: 'time', topic: '', context: null })
          return
        }
        try {
          const url = `${LIST_API}?sessionId=${encodeURIComponent(sessionId)}&limit=40&sort=${sort}&kind=${kind}`
          const res = await fetch(url, { headers: { accept: 'application/json' }, cache: 'no-store' })
          const data = await res.json()
          if (data && data.ok) {
            setState({
              status: 'ready',
              docs: data.docs || [],
              root: data.root || '',
              total: data.total || 0,
              error: '',
              mode: data.mode || 'time',
              topic: data.topic || '',
              context: data.context || null,
            })

          } else {
            setState({ status: 'error', docs: [], root: '', total: 0, error: hostMessage(data), mode: 'time', topic: '', context: null })
          }
        } catch (error) {
          setState({ status: 'error', docs: [], root: '', total: 0, error: String((error && error.message) || error), mode: 'time', topic: '', context: null })
        }
        setTick(Date.now())
      }, [sessionId, sort, kind])

      React.useEffect(() => {
        let alive = true
        let timer = null
        const run = async () => {
          await load()
          if (alive) timer = setTimeout(run, POLL_MS)
        }
        run()
        return () => { alive = false; if (timer) clearTimeout(timer) }
      }, [load])

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

      /* ── 「全部」：按类型分上下两区 ─────────────────────
         文档区固定 4 条，多余的在分区标题给「查看全部」；
         媒体区**不截断** —— 一屏两行以外交给媒体区内部滚动（不隐藏、也不压小格子）。 */
      const docItems = kind === KIND_ALL ? visibleDocs.filter((doc) => !isMedia(doc)) : []
      const mediaItems = kind === KIND_ALL ? visibleDocs.filter(isMedia) : []
      const shownDocs = docItems.slice(0, ALL_DOC_CAP)
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
       * 时间序、筛选结果、「其他相关文档」都不编号。
       */
      const docsGrid = (docs, numbers, primary) => docs.map((doc) =>
        renderEntry(doc, numbers ? numbers.get(doc.rel) || 0 : 0, Boolean(primary)))

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
        className: 'knit-tier',
        key: section.key,
        role: 'presentation',
      },
      // ⚠️ 这几个类名**互不为子串**：`byClass` 是子串匹配，若叫
      // `knit-tier-head` / `knit-tier-title`，取 `knit-tier` 会一次命中十几个节点
      // （AGENTS.md §6.5 同一个坑踩过三次）。
      h('div', { className: 'knit-tierline', role: 'presentation' },
        h('span', { className: 'knit-tiername' }, t(section.titleKey)),
        section.hintKey ? h('span', { className: 'knit-tierhint' }, t(section.hintKey)) : null),
      docsGrid(section.docs, view.numbers, section.key === 'primary')))

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
       * **只在「文档档 + 相关序 + 宿主给了 context」时成立**；否则返回 null，
       * 下面的渲染退回与 v0.13 逐字一致的平铺列表。
       *
       * 这一层是**纯投影**：分组、顺序、理由都来自宿主（同一个 Context Model），
       * 客户端不重算任何东西 —— 面板与 `knit_docs` 用的是同一份结果。
       *
       * ⚠️ 过滤框生效时**照常过滤**，而不是切回平铺列表：过滤是对当前视图的子集化，
       * 用户的预期是「在当前这份上下文里找」。
       */
      const contextView = React.useMemo(() => {
        const pack = state.context
        if (!relevance || kind !== KIND_DOC || !pack) return null
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

      // 键盘焦点跟手滚进视口（测试环境没有 DOM，静默跳过）
      React.useEffect(() => {
        if (!cursor || typeof document === 'undefined') return
        const host = listRef.current
        if (!host || typeof host.querySelector !== 'function') return
        const escaped = typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(cursor) : cursor
        const el = host.querySelector(`[data-knit-rel="${escaped}"]`)
        if (el && typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'nearest' })
      }, [cursor, query, state.docs])

      // 预览高度：拖完就记住
      React.useEffect(() => { writePref(RATIO_KEY, String(ratio)) }, [ratio])

      /**
       * 为一个条目造预览状态：图片/视频直接 ready（字节地址交给 <img>/<video>），
       * Markdown 才进 loading 去拉正文。
       */
      const previewFor = React.useCallback((doc) => {
        const base = { rel: doc.rel, title: doc.title || doc.name, path: doc.path || '', text: '', truncated: false }
        if (isMedia(doc)) {
          return { ...base, kind: doc.kind, src: mediaUrl(sessionId, doc.rel), status: 'ready' }
        }
        return { ...base, kind: KIND_DOC, status: 'loading' }
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
          // 悬停浮层只列 Markdown，这里固定按文档走 loading→拉正文。
          setPreview({ rel: target.rel, title: target.title, path: target.path || '', kind: KIND_DOC, status: 'loading', text: '', truncated: false })
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
      const previewIsDoc = !preview || (preview.kind !== 'image' && preview.kind !== 'video')

      /** 这篇文档在磁盘上的绝对路径：宿主给的 path 优先，拿不到就用 root + rel 拼。 */
      const previewAbsPath = preview
        ? (preview.path || joinPath(state.root, preview.rel))
        : ''

      /** 点预览头那行路径 → 用系统默认应用打开本地文档。 */
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
              return data && data.ok
                ? { ...cur, status: 'ready', text: data.text || '', truncated: Boolean(data.truncated) }
                : { ...cur, status: 'error', error: hostMessage(data) }
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



      /** 渲染一个条目：媒体一律出方形卡片（媒体视图与「全部」的媒体区共用），其余出文档行。 */
      const renderEntry = (doc, num, primary) => {
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
        return h(DocRow, { ...common, relevance, why: whyText(doc.reason), num, primary })
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
          docsGrid(shownDocs)),
        mediaItems.length === 0 ? null : h('div', { className: 'knit-section', key: 'media' },
          // 媒体不截断，所以只给一个标题，不给「已显示 / 总数」和「查看全部」
          h('div', { className: 'knit-section-head' },
            h('span', { className: 'knit-section-title' }, t('kind.media')),
            h('span', { className: 'knit-section-count' }, String(mediaItems.length))),
          mediaGrid(mediaItems, true)),
      ]

      // 媒体视图：一格都不隐藏 —— 一屏两行以外的部分在媒体区**内部滚动**，
      // 既不让面板被整面媒体墙顶爆，也不会像旧版那样把剩下的条目直接切掉。
      const emptyText = kind === KIND_MEDIA ? t('list.emptyMedia') : t('list.empty')
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
                    : docsGrid(visibleDocs)

      // 排序依据那行**弱化**了（2026-09-29 用户要求）：可见的只有一句
      // 「相关性排序」，命中的关键词退到 title 里当低层 metadata ——
      // 关键词是**系统依据**，不该被大号加粗地推到用户眼前。
      // ⚠️ 可见文本里**不能**出现关键词：test/i18n.test.mjs 有守卫。
      const topicText = relevance
        ? t('topic.relevancePlain')
        : (sort === 'relevance' ? t('topic.needsConversation') : t('topic.time'))
      const topicTitle = relevance && state.topic
        ? t('topic.relevanceTerms', { topic: state.topic })
        : topicText

      // 不同类型用不同量词：文档「篇」、媒体「个」、混排「项」。
      const countKey = kind === KIND_MEDIA
        ? (filtering ? 'count.media.filtered' : 'count.media')
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
            setNotice((await openLocalPath(state.root)) || '')
          },
        }, state.root || '—'),
        h('div', { className: 'knit-count' }, countText),
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
        [[KIND_DOC, 'kind.doc'], [KIND_MEDIA, 'kind.media'], [KIND_ALL, 'kind.all']].map(([value, labelKey]) =>
          h('button', {
            type: 'button',
            key: value,
            role: 'tab',
            'aria-selected': kind === value,
            className: `knit-type-btn${kind === value ? ' active' : ''}`,
            title: t('kind.title'),
            onClick: () => pickKind(value),
          }, t(labelKey)))),
      h('div', { className: 'knit-topic', title: topicTitle }, topicText),
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
     * 取当前会话 id（悬停浮层要用它拉列表）。
     *
     * 入口按钮坐在 list 座位上，座位不给任何 owner 参数，所以只能从
     * sessions 列表里读「当前会话」——与聊天视图解析 cwd 用的是同一条路。
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
      h('div', { className: 'knit-peek-list' }, body),
      h('div', { className: 'knit-peek-hint' }, t('peek.openPanel')))
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
      return function KnitEntryButton() {
        const [peek, setPeek] = React.useState(null)
        const btnRef = React.useRef(null)
        const showTimer = React.useRef(null)
        const hideTimer = React.useRef(null)

        /** 清掉两个定时器。 */
        const clearTimers = () => {
          if (showTimer.current) { clearTimeout(showTimer.current); showTimer.current = null }
          if (hideTimer.current) { clearTimeout(hideTimer.current); hideTimer.current = null }
        }

        /** 拉浮层要显示的那几篇。 */
        const loadPeek = async () => {
          const sessionId = currentSessionId()
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

      return h(KnitBody, { sessionId, openInTab })
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
     * @param {{rel:string, title?:string, name?:string}} doc - 目标文档
     * @returns {void}
     */
    function requestPreview(doc) {
      if (!doc || !doc.rel) return
      const target = { rel: doc.rel, title: doc.title || doc.name || doc.rel }
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
     * @param {string} path - 绝对路径
     * @returns {Promise<string>} 空串表示成功，否则是失败原因
     */
    async function openLocalPath(path) {
      if (!path) return t('error.hostFailed')
      const services = rootCtx && typeof rootCtx.get === 'function' ? rootCtx.get('remote.session') : null
      if (!services || typeof services.openWorkspacePath !== 'function') {
        return t('error.noHostTab')
      }
      try {
        const result = await services.openWorkspacePath({ path })
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

        bsCtx.effect(() => bs.registerTab({
          id: BS_TAB_ID,
          title: () => t('guide.title'),
          icon: KnitGlyph,
          order: 30,
          single: true,                       // 同类型只开一个
          component: (props) => h(BetterSidebarTabBody, props),
        }), 'dsh-knit: better-sidebar tab')

        console.log('[knit] registered on dsh-better-sidebar: ', BS_TAB_ID)
      })
    }

    return module.exports
  },
})

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

      'topic.relevance': '🤖 按「{topic}」排序',
      'topic.relevancePlain': '🤖 相关性排序',
      'topic.needsConversation': '对话内容还不足，暂按最新排序',
      'topic.time': '按修改时间倒序',

      'row.tooltip': '{path}\n单击就地预览 · 双击在新标签页打开',
      'summary.empty': '（没有正文摘要）',

      'list.scanning': '正在扫描工作区…',
      'list.failed': '读取失败：{error}',
      'list.failedHint': '确认插件宿主半边已加载。',
      'list.empty': '这个工作区里还没有 Markdown 文档。',
      'list.emptyMedia': '这个工作区里还没有图片或视频。',
      'list.noMatch': '没有匹配「{query}」的文档。',

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
      'preview.newTab': '新标签页',
      'preview.newTabTitle': '在新标签页打开',
      'preview.close': '收起预览',
      'preview.resizeTitle': '拖动调整高度',
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

      'topic.relevance': '🤖 Sorted by “{topic}”',
      'topic.relevancePlain': '🤖 Sorted by relevance',
      'topic.needsConversation': 'Not enough conversation yet — sorted by time',
      'topic.time': 'Sorted by modified time',

      'row.tooltip': '{path}\nClick to preview here · double-click to open in a new tab',
      'summary.empty': '(no summary)',

      'list.scanning': 'Scanning the workspace…',
      'list.failed': 'Failed to read: {error}',
      'list.failedHint': 'Make sure the plugin’s host half is loaded.',
      'list.empty': 'No Markdown documents in this workspace yet.',
      'list.emptyMedia': 'No images or videos in this workspace yet.',
      'list.noMatch': 'No documents match “{query}”.',

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
      'preview.newTab': 'New tab',
      'preview.newTabTitle': 'Open in a new tab',
      'preview.close': 'Close preview',
      'preview.resizeTitle': 'Drag to resize',
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

    /** 「全部」视图里文档区的固定上限。 */
    const ALL_DOC_CAP = 4
    /**
     * 媒体网格一屏最多摆几个（4 列 × 2 行）。
     * 超出不再隐藏，而是整块等比缩小 —— 见 mediaLayoutFor 的 scaled 分支。
     */
    const MEDIA_MAX_ITEMS = 8
    /**
     * 媒体格子（缩略图）的最小边长。低于这个值再缩就看不清了，用户明确说过
     * 「64×64 就够了」。与 CSS 里的 --knit-media-min 同一套算术 —— 改一处必须改另一处。
     */
    const MEDIA_MIN_PX = 64
    /** 媒体视图（独立一档）一屏最多铺几行，再多就滚动 —— 免得面板被一个媒体墙顶爆。 */
    const MEDIA_VIEW_ROWS = 3
    /** 媒体网格的列数下限：面板再窄、媒体再少，也保持 3 列的观感（用户明确要求）。 */
    const MEDIA_MIN_COLS = 3
    const MEDIA_GAP_PX = 10
    /** 网格左右内边距合计（.knit-media-grid 的 padding:0 12px / 8px 12px 16px）。 */
    const MEDIA_GRID_PAD_X = 24
    /** `.knit-list` 自己的左右内边距（padding:8px）—— 量到的是它，算格子要先扣掉。 */
    const LIST_PAD_X = 16

    /**
     * 算媒体网格的列数、格子边长与是否进入「等比缩小」态。
     *
     * 规则来自用户：
     *
     * 1. **最少 3 列** —— 面板再窄也不掉到 1~2 列那种「一列一个」的观感；宽了才加列。
     * 2. **一屏 8 个（4 列 × 2 行）是基准** —— 超过 8 个不再隐藏、也不再多铺行，
     *    而是让整块网格**等比缩小**把这一屏塞满（所以格子会小于 64px，这是有意的）。
     * 3. 不超过 8 个时以 64px 为基准、4 列满宽为上限；宽度不够就先让出一行
     *    （列数降到 3）把格子撑回 64px。
     *
     * 任何情况下 `columns*cell + gap` 都装得进可用宽度 —— 宁可格子小一点，也不能横向溢出。
     *
     * @param {number} width - 网格可用宽度（px，不含左右内边距）
     * @param {number} [count] - 实际要摆几个；缺省按一屏基准（8）算
     * @returns {{columns:number, cell:number, scaled:boolean, maxHeight:number|null}}
     *   列数、格子边长（px，取整）、是否处于「等比缩小」态（此时卡片文字让位给缩略图）、
     *   以及网格自身最大高度（null = 不限制，交给外层滚动）
     */
    function mediaLayoutFor(width, count) {
      const n = Number.isFinite(count) && count > 0 ? Math.floor(count) : MEDIA_MAX_ITEMS
      const w = Number(width)
      const usable = Number.isFinite(w) && w > 0 ? w : 632 // 量不到就按默认右侧栏的几何算
      const cellFor = (cols) => Math.floor((usable - (cols - 1) * MEDIA_GAP_PX) / cols)

      /** 让格子长得下 64px 时最多能排几列（所以「格子大小」和「列数」是同一个约束）。 */
      const colsAtMinCell = () => {
        for (let cols = 8; cols > MEDIA_MIN_COLS; cols -= 1) {
          if (cellFor(cols) >= MEDIA_MIN_PX) return cols
        }
        return MEDIA_MIN_COLS // 连 3 列 64px 都放不下：保住 3 列，允许极窄时轻微横溢
      }

      if (n <= MEDIA_MAX_ITEMS) {
        // 不超一屏：宽度够就是 4 列满宽；媒体少于 4 个也不缩列（否则一个缩略图独占半屏）。
        // 面板窄到 4 列放不下 64px 时按能放下的列数走，但**永远不减到 3 列以下**。
        const fit = Math.min(4, colsAtMinCell()) // 64px 装得下时想要 4 列满宽
        const cols = Math.max(fit, MEDIA_MIN_COLS)
        const cell = Math.max(MEDIA_MIN_PX, cellFor(cols))
        return { columns: cols, cell, scaled: cell < 96, maxHeight: null }
      }

      // 超过一屏：加列 + 等比缩小，两行装下（上限 8 列）。此时格子允许小于 64px ——
      // 「超过就等比缩小」是用户明确要的行为，宁可小也不多铺行。
      const cols = Math.min(8, Math.max(MEDIA_MIN_COLS, Math.ceil(n / 2)))
      const cell = cellFor(cols)
      return { columns: cols, cell, scaled: true, maxHeight: cell * 2 + MEDIA_GAP_PX }
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
  /* 选中态的灰底一律直接用 DSH 的中性令牌（列表行、类型切换、排序切换共用一套），
     所以这里不再需要自备一个 accent 填充令牌。 */
  display:flex;flex-direction:column;height:100%;min-height:0;
  color:var(--dsw-alias-label-primary,#e8eaed);font-size:13px}
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
.knit-btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.06));
  color:var(--dsw-alias-label-primary,#e8eaed)}
.knit-bar{display:flex;align-items:center;gap:8px;padding:0 12px 8px;flex:none}
.knit-seg{display:inline-flex;flex:none;border-radius:7px;overflow:hidden;
  border:.5px solid var(--dsw-alias-border-l4,rgba(255,255,255,.1))}
.knit-seg-btn{height:22px;padding:0 10px;cursor:pointer;font-size:11px;border:none;
  background:transparent;color:var(--dsw-alias-label-secondary,#9aa0a6)}
.knit-seg-btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.06))}
.knit-seg-btn.active{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.1));
  color:var(--dsw-alias-label-primary,#e8eaed);font-weight:600}
.knit-filter{flex:1;min-width:0;height:24px;padding:0 9px;border-radius:7px;font-size:11px;
  background:transparent;color:var(--dsw-alias-label-primary,#e8eaed);
  border:.5px solid var(--dsw-alias-border-l4,rgba(255,255,255,.1));outline:none}
.knit-filter:focus{border-color:var(--knit-accent)}
.knit-filter::placeholder{color:var(--dsw-alias-label-caption,#80868b)}
.knit-topic{flex:none;padding:0 12px 8px;font-size:10.5px;line-height:1.4;
  color:var(--dsw-alias-label-caption,#80868b);
  border-bottom:.5px solid var(--dsw-alias-border-l4,rgba(255,255,255,.08));
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.knit-list{flex:1 1 auto;min-height:0;overflow-y:auto;padding:8px;display:flex;flex-direction:column;gap:6px;outline:none}
.knit-list:focus-visible{box-shadow:inset 0 0 0 1px var(--knit-accent)}
.knit-list::-webkit-scrollbar{width:6px}
.knit-list::-webkit-scrollbar-thumb{background:rgba(255,255,255,.14);border-radius:3px}
.knit-doc{padding:10px 11px;border-radius:10px;cursor:pointer;
  border:.5px solid transparent;background:var(--dsw-alias-bg-layer-1,rgba(255,255,255,.03));
  transition:background .18s,border-color .18s,transform .18s,opacity .18s}
.knit-doc:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.06));
  border-color:var(--dsw-alias-border-l4,rgba(255,255,255,.1));transform:translateX(-2px)}
.knit-doc.active{border-color:var(--knit-accent);
  background:var(--dsw-alias-interactive-bg-active,rgba(255,255,255,.1))}
/* .knit-doc.cursor 故意不设样式：键盘焦点靠「移动即预览」的预览面板表达，
   再加描边会与 .active 的整块蓝色背景重复，显得突兀 */
.knit-row1{display:flex;align-items:center;gap:8px;margin-bottom:5px}
.knit-title{flex:1;min-width:0;font-weight:600;font-size:12.5px;line-height:1.4;
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.knit-time{flex:none;font-size:10.5px;color:var(--dsw-alias-label-caption,#80868b)}
.knit-sum{font-size:11.5px;line-height:1.55;color:var(--dsw-alias-label-secondary,#9aa0a6);
  display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.knit-sum.empty{font-style:italic;color:var(--dsw-alias-label-caption,#80868b)}
.knit-meta{margin-top:6px;font-size:10px;color:var(--dsw-alias-label-caption,#80868b);
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.knit-msg{padding:24px 16px;text-align:center;font-size:12px;
  color:var(--dsw-alias-label-caption,#80868b);line-height:1.7}
.knit-notice{margin:6px 8px 0;padding:7px 10px;border-radius:7px;font-size:11px;line-height:1.5;
  background:rgba(255,120,120,.12);border:.5px solid rgba(255,120,120,.3);color:#ffb4b4}
.knit-badge{font-size:10px;margin-right:3px}

/* ── 列表下方的预览面板 ─────────────────────────────── */
.knit-preview{flex:none;display:flex;flex-direction:column;min-height:0;
  border-top:.5px solid var(--dsw-alias-border-l4,rgba(255,255,255,.1));
  background:var(--dsw-alias-bg-layer-1,rgba(255,255,255,.02))}
.knit-resize{flex:none;height:7px;cursor:ns-resize;background:transparent;position:relative}
.knit-resize::after{content:'';position:absolute;left:50%;top:2px;transform:translateX(-50%);
  width:34px;height:3px;border-radius:2px;background:var(--dsw-alias-border-l4,rgba(255,255,255,.14))}
.knit-resize:hover::after{background:var(--knit-accent)}
.knit-preview-head{display:flex;align-items:center;gap:8px;padding:6px 12px 8px;flex:none;
  border-bottom:.5px solid var(--dsw-alias-border-l4,rgba(255,255,255,.06))}
.knit-preview-title{flex:1;min-width:0;font-size:12px;font-weight:600;
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.knit-preview-body{flex:1;min-height:0;overflow-y:auto;padding:10px 14px 16px;font-size:12.5px}
.knit-preview-body::-webkit-scrollbar{width:6px}
.knit-preview-body::-webkit-scrollbar-thumb{background:rgba(255,255,255,.14);border-radius:3px}
.knit-preview-close{flex:none;width:24px;height:24px;border-radius:6px;cursor:pointer;
  display:inline-flex;align-items:center;justify-content:center;font-size:13px;
  background:transparent;border:none;color:var(--dsw-alias-label-secondary,#9aa0a6)}
.knit-preview-close:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.08));
  color:var(--dsw-alias-label-primary,#e8eaed)}
.knit-raw{margin:0;white-space:pre-wrap;word-break:break-word;font-size:11.5px;line-height:1.6;
  color:var(--dsw-alias-label-secondary,#9aa0a6);font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.knit-preview-note{font-size:11px;color:var(--dsw-alias-label-caption,#80868b);padding:2px 0 8px}

/* ── 类型切换（文档 / 图片与视频 / 全部）────────────── */
/* 选中态与下面的列表行、上面的排序切换共用一套中性灰填充，**不要品牌色描边**：
   用户的原话是「选中的时候不用加绿色、蓝色的描边，就跟下面列表一样，
   选中填充背景灰就可以」。所以这里不许再用 --knit-accent / --knit-accent-fill。 */
.knit-types{display:flex;gap:5px;padding:1px 12px 7px;flex:none}
.knit-type-btn{flex:1;height:24px;padding:0 6px;border-radius:6px;cursor:pointer;
  border:.5px solid transparent;background:transparent;
  color:var(--dsw-alias-label-secondary,#9aa0a6);font-family:inherit;font-size:11px;
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
  transition:background .15s,color .15s}
.knit-type-btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.08));
  color:var(--dsw-alias-label-primary,#e8eaed)}
.knit-type-btn.active{background:var(--dsw-alias-interactive-bg-active,rgba(255,255,255,.1));
  color:var(--dsw-alias-label-primary,#e8eaed);font-weight:600}

/* ── 图片与视频：方形缩略图网格 ─────────────────────
   列数与格子边长由 client.js 的 mediaLayoutFor 算好后用 CSS 变量传进来
   （--knit-media-cols / --knit-media-cell），这里只留一个 3 列的兜底，
   保证「最少 3 列」这条规则在 JS 没跑起来时也成立。
   fallback 那一行是给不认 repeat(变量, ...) 的旧内核用的，必须写在前面。 */
.knit-media-grid{display:grid;gap:${MEDIA_GAP_PX}px;
  --knit-media-label:block;
  grid-template-columns:repeat(3,1fr);
  grid-template-columns:repeat(var(--knit-media-cols,3),minmax(0,1fr));
  padding:8px 12px 16px;align-content:start;min-height:0;overflow-y:auto}
/* 分区里的网格：滚动交给 .knit-list 统一管，自己不留内边距 */
.knit-media-grid.in-section{padding:0;overflow:visible}
.knit-media-card{min-width:0;cursor:pointer;border-radius:10px}
.knit-media-thumbbox{position:relative;width:100%;height:var(--knit-media-cell,auto);aspect-ratio:1/1;
  border-radius:9px;overflow:hidden;
  background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.06));
  border:.5px solid var(--dsw-alias-border-l2,rgba(255,255,255,.1));
  transition:border-color .15s,box-shadow .15s}
.knit-media-card:hover .knit-media-thumbbox{border-color:var(--dsw-alias-border-l4,rgba(255,255,255,.22))}
/* 正在预览 → 品牌色描边；键盘移动 → 只有中性描边，别让它看起来像「选中了」 */
.knit-media-card.active .knit-media-thumbbox{
  border-color:var(--knit-accent);box-shadow:0 0 0 1.5px var(--knit-accent)}
.knit-media-card.cursor .knit-media-thumbbox{
  border-color:var(--dsw-alias-border-l4,rgba(255,255,255,.22));
  box-shadow:0 0 0 1.5px var(--dsw-alias-interactive-bg-active,rgba(255,255,255,.1))}
/* 等比缩小态（一屏硬塞 8 个以上）下格子太小，文件名与时间会挤成一团 —— 整块让位给缩略图 */
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
.knit-entry:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.08))}
.knit-entry:active{transform:scale(.94)}

/* 全屏阅读：藏掉头部与列表，只留预览 */
.knit-root.fullscreen .knit-head,
.knit-root.fullscreen .knit-bar,
.knit-root.fullscreen .knit-types,
.knit-root.fullscreen .knit-topic,
.knit-root.fullscreen .knit-list{display:none}
.knit-root.fullscreen .knit-preview{flex:1 1 auto;max-height:none}
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
     * @param {number} ms - 文件 mtime（epoch ms）
     * @param {number} now - 当前时间
     * @returns {string} 刚刚 / X分钟前 / X小时前 / 昨天 / X天前 / 月日
     */
    function relTime(ms, now) {
      const diff = Math.max(0, now - ms)
      const min = Math.floor(diff / 60000)
      if (min < 1) return '刚刚'
      if (min < 60) return `${min}分钟前`
      const hour = Math.floor(min / 60)
      if (hour < 24) return `${hour}小时前`
      const day = Math.floor(hour / 24)
      if (day === 1) return '昨天'
      if (day < 30) return `${day}天前`
      const d = new Date(ms)
      return `${d.getMonth() + 1}月${d.getDate()}日`
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
    function DocRow({ doc, now, active, cursor, relevance, onSelect, onOpenTab }) {
      const fresh = now - doc.mtimeMs < NEW_WINDOW_MS

      return h('div', {
        className: `knit-doc${active ? ' active' : ''}${cursor ? ' cursor' : ''}${fresh ? ' fresh' : ''}`,
        'data-knit-rel': doc.rel,
        title: t('row.tooltip', { path: doc.rel }),
        onClick: () => onSelect(doc),
        onDoubleClick: () => onOpenTab(doc),
      },
      h('div', { className: 'knit-row1' },
        h('div', { className: 'knit-title' },
          fresh ? h('span', { className: 'knit-badge' }, '🆕') : null,
          doc.title || doc.name),
        h('div', { className: 'knit-time' }, relTime(doc.mtimeMs, now))),
      doc.summary
        ? h('div', { className: 'knit-sum' }, doc.summary)
        : h('div', { className: 'knit-sum empty' }, t('summary.empty')),
      h('div', { className: 'knit-meta' }, doc.rel))
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
    function MediaCard({ doc, now, active, cursor, src, onSelect, onOpenTab }) {
      const fresh = now - doc.mtimeMs < NEW_WINDOW_MS
      return h('div', {
        className: `knit-media-card${active ? ' active' : ''}${cursor ? ' cursor' : ''}${fresh ? ' fresh' : ''}`,
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
     * @param {{preview:object,pathImages:object|null,fullscreen:boolean,onClose:Function,onOpenTab:Function,onToggleFullscreen:Function,onResizeStart:Function}} props - 渲染入参
     * @returns {import('react').ReactElement} 元素
     */
    function PreviewPanel({ preview, pathImages, fullscreen, ratio, onClose, onOpenTab, onToggleFullscreen, onResizeStart }) {
      const isMedia = preview.kind === 'image' || preview.kind === 'video'

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
          h('div', { className: 'knit-preview-title', title: preview.rel }, preview.title || preview.rel),
          h('button', {
            className: 'knit-btn',
            onClick: onToggleFullscreen,
            title: fullscreen ? t('preview.exitFullscreenTitle') : t('preview.fullscreenTitle'),
          }, fullscreen ? t('preview.exitFullscreen') : t('preview.fullscreen')),
          h('button', { className: 'knit-btn', onClick: onOpenTab, title: t('preview.newTabTitle') }, t('preview.newTab')),
          h('button', { className: 'knit-preview-close', onClick: onClose, title: t('preview.close') }, '✕')),
        h('div', { className: `knit-preview-body${isMedia ? ' is-media' : ''}` },
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
          setState({ status: 'error', docs: [], root: '', total: 0, error: t('error.noSession'), mode: 'time', topic: '' })
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
            })

          } else {
            setState({ status: 'error', docs: [], root: '', total: 0, error: hostMessage(data), mode: 'time', topic: '' })
          }
        } catch (error) {
          setState({ status: 'error', docs: [], root: '', total: 0, error: String((error && error.message) || error), mode: 'time', topic: '' })
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
         媒体区**不截断** —— 超过一屏基准（8 个）就整块等比缩小，而不是把剩下的藏起来。 */
      const docItems = kind === KIND_ALL ? visibleDocs.filter((doc) => !isMedia(doc)) : []
      const mediaItems = kind === KIND_ALL ? visibleDocs.filter(isMedia) : []
      const shownDocs = docItems.slice(0, ALL_DOC_CAP)
      // ResizeObserver 量到的是 .knit-list（它自己也有左右内边距），
      // 网格的可用宽度 = 列表宽度 − 列表内边距 − 网格内边距
      const mediaLayout = mediaLayoutFor(
        Math.max(0, listWidth - LIST_PAD_X - MEDIA_GRID_PAD_X),
        kind === KIND_ALL ? mediaItems.length : Math.min(visibleDocs.length, MEDIA_MAX_ITEMS))

      /** 媒体网格：列数与格子边长都由 mediaLayout 决定（CSS 只提供变量名）。 */
      const mediaGrid = (docs, inSection) => h('div', {
        className: `knit-media-grid${inSection ? ' in-section' : ''}`,
        role: 'group',
        style: {
          '--knit-media-cols': String(mediaLayout.columns),
          '--knit-media-cell': `${mediaLayout.cell}px`,
          ...(mediaLayout.scaled ? { '--knit-media-label': 'none' } : {}),
          ...(mediaLayout.maxHeight ? { maxHeight: `${mediaLayout.maxHeight}px` } : {}),
        },
      }, docs.map(renderEntry))

      /** 键盘与 cursor 真正能到达的条目：「全部」里文档只到上限，媒体全部可达。 */
      const navDocs = kind === KIND_ALL ? shownDocs.concat(mediaItems) : visibleDocs

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
        const base = { rel: doc.rel, title: doc.title || doc.name, text: '', truncated: false }
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

      /** 键盘导航：↑↓ 移动即预览，Enter 切换，Esc 收起。 */
      const onListKeyDown = React.useCallback((event) => {
        if (navDocs.length === 0) return
        const index = navDocs.findIndex((doc) => doc.rel === cursor)

        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault()
          const next = event.key === 'ArrowDown'
            ? Math.min(navDocs.length - 1, index < 0 ? 0 : index + 1)
            : Math.max(0, index < 0 ? 0 : index - 1)
          const doc = navDocs[next]
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
      }, [navDocs, cursor, fullscreen, openPreview, togglePreview, closePreview])

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
          setPreview({ rel: target.rel, title: target.title, kind: KIND_DOC, status: 'loading', text: '', truncated: false })
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

      const relevance = state.mode === 'relevance'
      const filtering = query.trim().length > 0

      /** 渲染一个条目：媒体一律出方形卡片（媒体视图与「全部」的媒体区共用），其余出文档行。 */
      const renderEntry = (doc) => {
        const common = {
          key: doc.path || doc.rel,
          doc,
          now: tick,
          active: Boolean(preview && preview.rel === doc.rel),
          cursor: doc.rel === cursor,
          onSelect: togglePreview,
          onOpenTab,
        }
        if (isMedia(doc)) return h(MediaCard, { ...common, src: srcFor(doc) })
        return h(DocRow, { ...common, relevance })
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
          shownDocs.map(renderEntry)),
        mediaItems.length === 0 ? null : h('div', { className: 'knit-section', key: 'media' },
          // 媒体不截断，所以只给一个标题，不给「已显示 / 总数」和「查看全部」
          h('div', { className: 'knit-section-head' },
            h('span', { className: 'knit-section-title' }, t('kind.media')),
            h('span', { className: 'knit-section-count' }, String(mediaItems.length))),
          mediaGrid(mediaItems, true)),
      ]

      // 媒体视图一屏最多铺 MEDIA_VIEW_ROWS 行，再多就交给滚动 —— 不让面板被媒体墙顶爆
      const mediaViewLimit = Math.max(1, mediaLayout.columns * MEDIA_VIEW_ROWS)

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
                ? mediaGrid(visibleDocs.slice(0, mediaViewLimit), false)
                : kind === KIND_ALL
                  ? allSections
                  : visibleDocs.map(renderEntry)

      const topicText = relevance
        ? (state.topic ? t('topic.relevance', { topic: state.topic }) : t('topic.relevancePlain'))
        : (sort === 'relevance' ? t('topic.needsConversation') : t('topic.time'))

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
      h('div', { className: 'knit-topic', title: topicText }, topicText),
      notice ? h('div', { className: 'knit-notice' }, notice) : null,
      h('div', {
        className: 'knit-list',
        ref: listRef,
        tabIndex: 0,
        onKeyDown: onListKeyDown,
        role: 'listbox',
        'aria-label': '最近文档',
      }, body),
      preview ? h(PreviewPanel, {
        preview,
        pathImages,
        fullscreen,
        ratio,
        onClose: closePreview,
        onOpenTab: () => onOpenTab(null),
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
          title: () => 'Knit 最近文档',
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

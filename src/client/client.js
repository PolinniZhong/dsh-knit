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
      'action.refresh': '刷新',
      'action.refreshNow': '立即刷新',

      'sort.relevance': '相关',
      'sort.time': '最新',
      'sort.relevanceTitle': '按与当前对话的相关性排序（纯本地关键词匹配，不调模型）',
      'sort.timeTitle': '按文件修改时间倒序',

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
      'list.noMatch': '没有匹配「{query}」的文档。',

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
      'action.refresh': 'Refresh',
      'action.refreshNow': 'Refresh now',

      'sort.relevance': 'Relevant',
      'sort.time': 'Recent',
      'sort.relevanceTitle': 'Sort by relevance to the current conversation (local keyword matching, no model call)',
      'sort.timeTitle': 'Sort by file modified time, newest first',

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
      'list.noMatch': 'No documents match “{query}”.',

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

    /** 用户偏好（选了就记住）。 */
    const SORT_KEY = 'dsh-knit:sort'
    const RATIO_KEY = 'dsh-knit:preview-ratio'

    /** 预览面板高度的上下限：任何一端都不把对方挤没。 */
    const MIN_RATIO = 0.2
    const MAX_RATIO = 0.8
    const DEFAULT_RATIO = 0.46

    /* ── 样式：跟随 DSH 主题令牌，深浅色自适应 ───────────────── */
    const STYLE_ID = 'dsh-knit-style'
    const CSS = `
.knit-root{display:flex;flex-direction:column;height:100%;min-height:0;
  color:var(--dsw-alias-label-primary,#e8eaed);font-size:13px}
.knit-head{display:flex;align-items:center;gap:8px;padding:10px 12px 8px;flex:none}
.knit-head .knit-root-path{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;
  white-space:nowrap;font-size:11px;color:var(--dsw-alias-label-caption,#80868b)}
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
.knit-filter:focus{border-color:rgba(79,140,255,.5)}
.knit-filter::placeholder{color:var(--dsw-alias-label-caption,#80868b)}
.knit-topic{flex:none;padding:0 12px 8px;font-size:10.5px;line-height:1.4;
  color:var(--dsw-alias-label-caption,#80868b);
  border-bottom:.5px solid var(--dsw-alias-border-l4,rgba(255,255,255,.08));
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.knit-list{flex:1 1 auto;min-height:0;overflow-y:auto;padding:8px;display:flex;flex-direction:column;gap:6px;outline:none}
.knit-list:focus-visible{box-shadow:inset 0 0 0 1px rgba(79,140,255,.35)}
.knit-list::-webkit-scrollbar{width:6px}
.knit-list::-webkit-scrollbar-thumb{background:rgba(255,255,255,.14);border-radius:3px}
.knit-doc{padding:10px 11px;border-radius:10px;cursor:pointer;
  border:.5px solid transparent;background:var(--dsw-alias-bg-layer-1,rgba(255,255,255,.03));
  transition:background .18s,border-color .18s,transform .18s,opacity .18s}
.knit-doc:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.06));
  border-color:var(--dsw-alias-border-l4,rgba(255,255,255,.1));transform:translateX(-2px)}
.knit-doc.active{border-color:rgba(79,140,255,.55);background:rgba(79,140,255,.10)}
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
.knit-resize:hover::after{background:rgba(79,140,255,.6)}
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

/* Knit 图标：不跟随文本色，浅色模式纯黑、暗色模式纯白。
   DSH 的暗色信号是 body[data-ds-dark-theme]（官方 CSS 用的就是这个）。 */
.knit-icon{color:#000}
body[data-ds-dark-theme] .knit-icon{color:#fff}

/* 入口按钮：挂在会话头部右侧与输入框工具行两处 list 座位上 */
.knit-entry{display:inline-flex;align-items:center;justify-content:center;flex:none;
  width:28px;height:28px;padding:0;border:none;border-radius:8px;cursor:pointer;
  background:transparent;color:var(--dsw-alias-label-secondary,#9aa0a6);
  transition:background .15s}
.knit-entry:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.08))}
.knit-entry:active{transform:scale(.94)}

/* 全屏阅读：藏掉头部与列表，只留预览 */
.knit-root.fullscreen .knit-head,
.knit-root.fullscreen .knit-bar,
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
     * 列表下方的预览面板。
     * @param {{preview:object,pathImages:object|null,fullscreen:boolean,onClose:Function,onOpenTab:Function,onToggleFullscreen:Function,onResizeStart:Function}} props - 渲染入参
     * @returns {import('react').ReactElement} 元素
     */
    function PreviewPanel({ preview, pathImages, fullscreen, ratio, onClose, onOpenTab, onToggleFullscreen, onResizeStart }) {
      const body = preview.status === 'loading'
        ? h('div', { className: 'knit-preview-note' }, t('preview.loading'))
        : preview.status === 'error'
          ? h('div', { className: 'knit-preview-note' }, t('list.failed', { error: preview.error }))
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
        h('div', { className: 'knit-preview-body' },
          preview.truncated ? h('div', { className: 'knit-preview-note' }, t('preview.truncated')) : null,
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

      const load = React.useCallback(async () => {
        if (!sessionId) {
          setState({ status: 'error', docs: [], root: '', total: 0, error: t('error.noSession'), mode: 'time', topic: '' })
          return
        }
        try {
          const url = `${LIST_API}?sessionId=${encodeURIComponent(sessionId)}&limit=40&sort=${sort}`
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
      }, [sessionId, sort])

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
        const q = query.trim().toLowerCase()
        if (!q) return state.docs
        return state.docs.filter((doc) =>
          String(doc.title || '').toLowerCase().includes(q)
          || String(doc.summary || '').toLowerCase().includes(q)
          || String(doc.rel || '').toLowerCase().includes(q))
      }, [state.docs, query])

      // cursor 消失（被过滤掉 / 列表刷新）时落回第一项
      React.useEffect(() => {
        if (visibleDocs.length === 0) {
          if (cursor !== '') setCursor('')
          return
        }
        if (!visibleDocs.some((doc) => doc.rel === cursor)) setCursor(visibleDocs[0].rel)
      }, [visibleDocs, cursor])

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

      /** 打开（不切换）某篇的预览。 */
      const openPreview = React.useCallback((doc) => {
        setNotice('')
        setPreview({ rel: doc.rel, title: doc.title || doc.name, status: 'loading', text: '', truncated: false })
      }, [])

      /** 单击 / Enter：切换某篇的预览开与关。 */
      const togglePreview = React.useCallback((doc) => {
        setNotice('')
        setCursor(doc.rel)
        setPreview((current) => {
          if (current && current.rel === doc.rel && current.status !== 'error') return null
          return { rel: doc.rel, title: doc.title || doc.name, status: 'loading', text: '', truncated: false }
        })
      }, [])

      /** 收起预览；全屏时顺带退出全屏。 */
      const closePreview = React.useCallback(() => {
        setPreview(null)
        setFullscreen(false)
      }, [])

      /** 键盘导航：↑↓ 移动即预览，Enter 切换，Esc 收起。 */
      const onListKeyDown = React.useCallback((event) => {
        if (visibleDocs.length === 0) return
        const index = visibleDocs.findIndex((doc) => doc.rel === cursor)

        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault()
          const next = event.key === 'ArrowDown'
            ? Math.min(visibleDocs.length - 1, index < 0 ? 0 : index + 1)
            : Math.max(0, index < 0 ? 0 : index - 1)
          const doc = visibleDocs[next]
          if (doc) { setCursor(doc.rel); openPreview(doc) }
          return
        }
        if (event.key === 'Enter') {
          event.preventDefault()
          const doc = visibleDocs.find((d) => d.rel === cursor) || visibleDocs[0]
          if (doc) togglePreview(doc)
          return
        }
        if (event.key === 'Escape') {
          event.preventDefault()
          if (fullscreen) setFullscreen(false)
          else closePreview()
        }
      }, [visibleDocs, cursor, fullscreen, openPreview, togglePreview, closePreview])

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

      const relevance = state.mode === 'relevance'
      const filtering = query.trim().length > 0

      const body = state.status === 'loading' && state.docs.length === 0
        ? h('div', { className: 'knit-msg' }, t('list.scanning'))
        : state.status === 'error'
          ? h('div', { className: 'knit-msg' }, t('list.failed', { error: state.error }), h('br'), t('list.failedHint'))
          : state.docs.length === 0
            ? h('div', { className: 'knit-msg' }, t('list.empty'))
            : visibleDocs.length === 0
              ? h('div', { className: 'knit-msg' }, t('list.noMatch', { query: query.trim() }))
              : visibleDocs.map((doc) => h(DocRow, {
                  key: doc.path,
                  doc,
                  now: tick,
                  active: Boolean(preview && preview.rel === doc.rel),
                  cursor: doc.rel === cursor,
                  relevance,
                  onSelect: togglePreview,
                  onOpenTab,
                }))

      const topicText = relevance
        ? (state.topic ? t('topic.relevance', { topic: state.topic }) : t('topic.relevancePlain'))
        : (sort === 'relevance' ? t('topic.needsConversation') : t('topic.time'))

      const countText = filtering
        ? t('count.filtered', { hit: visibleDocs.length, total: state.total })
        : t('count', { n: state.total })

      return h('div', {
        className: `knit-root${fullscreen ? ' fullscreen' : ''}`,
        ref: rootRef,
      },
      h('div', { className: 'knit-head' },
        h('div', { className: 'knit-root-path', title: state.root }, state.root || '—'),
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
    function makeEntryButton(onOpen) {
      return function KnitEntryButton() {
        return h('button', {
          type: 'button',
          className: 'knit-entry',
          title: t('entry.label'),
          'aria-label': t('entry.label'),
          onClick: (event) => {
            if (event && typeof event.preventDefault === 'function') event.preventDefault()
            if (event && typeof event.stopPropagation === 'function') event.stopPropagation()
            if (!onOpen()) console.warn('[knit] no sidebar host available — the entry button cannot open the panel')
          },
        }, h(KnitGlyph, { size: 16 }))
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

    module.exports.inject = ['slots', 'locale']
    module.exports.apply = (ctx) => {
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

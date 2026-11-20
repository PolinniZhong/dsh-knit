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
     * **跟随 DSH 主文本色令牌**（浅 #0f1115 / 暗 #f9fafb，随主题自己切）。
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

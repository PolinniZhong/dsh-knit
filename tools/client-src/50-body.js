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
        // v0.20 性能治理：这一份数据自己的签名 —— 轮询回来的载荷与它相同就不重渲染（见 `load`）。
        sig: '',
        // v0.21：用户自己的上下文控制（固定 / 排除）。宿主在 `/api/recent` 里回
        // `{pinned, excluded, skipped, persisted}`；`skipped` 是**这一批真的被排掉几篇**
        // （不是 excluded 的长度 —— 被排除的文件可能已经不在工作区里了）。
        control: null,
        // v0.23：宿主回的 `semantic`（模式 / 是否可用 / 原因 / 候选数 / provider）。
        // ⚠️ **老宿主没有这个字段** ⇒ 保持 null，界面按「宿主不支持混合检索」如实降级。
        semantic: null,
      })
      const [preview, setPreview] = React.useState(null)
      /* v0.20 性能治理：**一分钟一次**的刷新信号。相对时间标签是按分钟变的，所以轮询只在
         分钟数变了时落一次（其余时候返回同一个值 ⇒ React 直接跳过这次更新）。标签本身读的
         是**渲染那一刻**的钟（`Date.now()`），所以不会因为「刷新间隔还没到」而显示成
         「11 分钟前」—— 这个状态只负责「隔一会儿喊一嗓子」，不参与算时间。 */
      const [, bumpTick] = React.useState(0)
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
      /* v0.25：Git 变更关联开关。偏好记在 localStorage（与排序 / 类型 / 检索模式同一族），
         **默认关**。关着时请求里不带 `changes=1` ⇒ 宿主一个 git 进程都不 spawn。
         ⚠️ **刻意声明在 `usageOn` 之后**：`test/client.test.mjs` 用**指数 seed** 来打开
            「使用情况」（hook 下标 15），插在它前面会把后面所有下标顶开一位。
            新 hook 一律往**末尾**追加，别插队。 */
      const [changesOn, setChangesOn] = React.useState(readChangesPref)
      /* v0.25（第二轮修订）：变更关联来自**独立接口** `/knit/api/changes`，不再挂在
         `/api/recent` 的 `context` 上 —— 所以它有自己的状态槽。**必须追加在末尾**：
         前面的 hook 位置被 `test/client.test.mjs` 按位预置。 */
      const [changesData, setChangesData] = React.useState(null)

      // v0.17：两个折叠块的开合状态（上下文外读取 / 最近一次变化）。
      // **纯瞬时 UI 状态** —— 不写 pref、不进 `dsh-knit:*` 存储，刷新即回默认（收起）。
      // 仍然放在最后：前面那些 hook 的位置被测试按位预置，别插队。
      const [gapOpen, setGapOpen] = React.useState(false)
      const [deltaOpen, setDeltaOpen] = React.useState(false)
      // v0.21：哪一条的**行级证据**是展开的。按 `rel` 记、一次只开一条 —— 证据是「这一行
      // 为什么在这里」的补充说明，同时展开多条就不是在看一行了。仍然放在最后（同上）。
      const [whyOpen, setWhyOpen] = React.useState('')

      /* v0.23（Phase A）：检索模式 + provider 配置。
         ⚠️ 四个 hook 都**追加在最后**：前面的槽位被测试按位预置（notice / sort / …），
            插队会让老用例读到错的状态。`semForm` 用 `null` 表示「还没编辑过」——
            那时表单值从宿主回的 `semantic.provider` 现推（见渲染里的 `semForm0`），
            所以不需要额外的同步 effect。 */
      const [retrieval, setRetrieval] = React.useState(readRetrievalPref)
      const [semForm, setSemForm] = React.useState(null)
      const [semBusy, setSemBusy] = React.useState(false)
      const [semNotice, setSemNotice] = React.useState('')

      /* ── v0.25：对话里「工具产出」的图 ─────────────────────────────────────
         数据来自独立接口（只在本会话的 `tool/result` 事件里收集）；**列表零 I/O**。
         它们**不在工作区里**，所以是这一档唯一「不是文件」的条目：
         · 已经在工作区里存在同内容文件（sha256 相同）的 ⇒ 宿主侧就过滤掉了，不重复出现；
         · 一旦你把图存进项目，下一次轮询它就自己消失 —— 这就是用户要的那条规则。 */
      const [attachments, setAttachments] = React.useState([])
      /** 附件 → 伪文档：让它走**同一条**网格渲染/预览/键盘路径，不新开一套。 */
      const attachmentDocs = React.useMemo(() => (Array.isArray(attachments) ? attachments : [])
        .slice()
        .sort((a, b) => (Number.isFinite(b.at) ? b.at : 0) - (Number.isFinite(a.at) ? a.at : 0))
        .map((item) => ({
          rel: item.id,
          name: item.name,
          title: item.name,
          path: '',
          kind: item.kind === 'video' ? 'video' : 'image',
          mtimeMs: Number.isFinite(item.at) ? item.at : Date.now(),
          size: Number.isFinite(item.bytes) ? item.bytes : 0,
          summary: '',
          score: null,
          attachmentId: item.id,
          conversation: true,
        })), [attachments])

      /* ── v0.25：媒体收藏（同样**追加在末尾**：替身按下标 seed useState/useRef）──────
         只存 localStorage；工作区换了就重读那一格。写入时只保留最近 FAV_MAX_ROOTS 个工作区。 */
      const [favorites, setFavorites] = React.useState([])
      React.useEffect(() => {
        setFavorites(favoriteRelsFor(parseFavorites(readPref(FAV_KEY)), state.root))
      }, [state.root])
      const favoriteSet = React.useMemo(() => new Set(favorites), [favorites])
      /** 加 / 取消收藏，并立刻落盘。 */
      const toggleFavorite = React.useCallback((rel) => {
        const next = toggleFavoriteList(favorites, rel)
        setFavorites(next)
        const key = state.root || ''
        if (!key) return                     // 工作区未知 ⇒ 只活到这次会话结束，不写脏数据
        const table = parseFavorites(readPref(FAV_KEY))
        // 取消到空就把这一格**删掉**，不留 `{"<root>":[]}` 这种垃圾键
        if (next.length) table[key] = next
        else delete table[key]
        // 只保留最近几个工作区；**当前这个永远保留**（别把用户刚标的丢掉）
        const roots = Object.keys(table)
        while (roots.length > FAV_MAX_ROOTS) {
          const drop = roots.find((r) => r !== key)
          if (!drop) break
          delete table[drop]
          roots.splice(roots.indexOf(drop), 1)
        }
        writePref(FAV_KEY, JSON.stringify(table))
      }, [favorites, state.root])


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
      /* 轮询去重（v0.20 性能治理，2026-10-07）：`load` 把**这次的载荷签名**跟当前状态比，
         一字未变就返回同一个状态对象 —— React 直接跳过这次重渲染（`tick` 也只在分钟数变了
         才 bump）。原先每 5 s 都无条件落一个新对象：整屏重渲染一遍 + 一轮 FLIP 强制布局 +
         GC，用户体感就是「卡顿卡顿的」。签名存在状态自己身上，所以不需要新 hook
         （前面那些 hook 的位置被测试按位预置，别插队）。 */
      /* v0.25（2026-10-22 用户裁决）：**媒体档不看相关性，一律按时间倒序**。
         原话：「媒体这里不用跟随 Agent 读了它进行排序，目前就是以上传时间排序就可以，
         最新的放在前面就够了……文档可以是调用，但是图片不需要有这种逻辑」。

         ⇒ 请求**就是 time**（不只改显示）：这样宿主不做无用的相关度计算、截断也按时间切。
         排序偏好本身**不做修改** —— 切回文档/代码还是你原来选的那个。 */
      const effectiveSort = kind === KIND_MEDIA || kind === KIND_CHANGES ? 'time' : sort

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
          // v0.23：`retrieval` 是**选填**参数 —— 老宿主忽略它（那就等于词法），
          // 而词法模式下宿主**一次 provider 调用都不会发**（方案 §9.2 判据 1）。
          // ⚠️ v0.25（第二轮修订）：`/api/recent` 上**一个字节的变更关联都没有** ——
          // 它的响应形状与 v0.24 逐字相同。变更关联走**独立接口**，见下面那次 fetch。
          const url = `${LIST_API}?sessionId=${encodeURIComponent(sessionId)}&limit=40&sort=${effectiveSort}&kind=${kind}&retrieval=${effectiveSort === 'relevance' && retrieval === 'hybrid' ? 'hybrid' : 'lexical'}${usageOn ? '&usage=1' : ''}`
          const res = await fetch(url, { headers: { accept: 'application/json' }, cache: 'no-store' })
          const data = await res.json()
          if (!live()) return
          if (data && data.ok) {
            // 载荷一字未变（`JSON.stringify` 一份 35–46 KB ≈ 1 ms，比整屏重渲染便宜两个数量级）
            // ⇒ 原样返回**当前状态对象**，React 直接跳过这次更新（签名就存在状态自己身上）。
            const sig = JSON.stringify(data)
            setState((prev) => (prev.status === 'ready' && prev.sig === sig ? prev : {
              status: 'ready',
              // 变更档的独立载荷不归 load 管；轮询时原样带过去，别被列表刷新抹掉。
              changesStatus: prev.changesStatus || null,
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
              // v0.21：固定 / 排除的原始记录（面板要拿它画固定区、排除说明与管道条）。
              control: data.control || null,
              // v0.23：`semantic` 可能不存在（老宿主）⇒ null，界面据此如实降级。
              semantic: data.semantic || null,
              sig,
            }))
          } else {
            setState({ status: 'error', docs: [], root: '', total: 0, error: hostMessage(data), mode: 'time', context: null, usage: null })
          }
        } catch (error) {
          if (!live()) return
          setState({ status: 'error', docs: [], root: '', total: 0, error: String((error && error.message) || error), mode: 'time', context: null, usage: null })
        }
        /* v0.25（第二轮修订）：**独立接口** `/knit/api/changes`。
           · 关着时**一个请求都不发**（宿主因此一个 git 进程都不 spawn）——判据 5 的客户端那一半；
           · 只在「相关」序要它（时间序没有 Context Pack，变更关联无处可落）；
           · 复用宿主刚刚那次扫描（服务端 8 s 同窗）⇒ 两个请求 = 一次扫描 + 一次 git；
           · 失败一律降级成 `null`（这一区消失），**绝不带坏列表** —— 列表已经落好了。 */
          // v0.25：媒体档额外取「对话里工具产出的图」。**只在这一档取** —— 别的档不显示它们。
          // 失败/老宿主没有这条路由 ⇒ 保持安静（列表为空），不弹错、不挡列表。
          if (kind === KIND_MEDIA) {
            try {
              const ares = await fetch(`${ATTACH_LIST_API}?sessionId=${encodeURIComponent(sessionId)}`, {
                headers: { accept: 'application/json' }, cache: 'no-store',
              })
              const adata = await ares.json()
              if (!live()) return
              if (adata && adata.ok && Array.isArray(adata.items)) {
                const items = adata.items
                // 一字未变就返回**同一个数组**（与列表同一套去重理由：省一次整屏重渲染）
                setAttachments((prev) => (prev.length === items.length
                  && items.every((item, i) => item && prev[i] && item.id === prev[i].id) ? prev : items))
              }
            } catch { /* 安静：这一档少几张图，不影响文件列表 */ }
          }

        const wantChanges = effectiveSort === 'relevance' && changesOn
        if (!wantChanges) {
          setChangesData((prev) => (prev === null ? prev : null))
          return
        }
        try {
          // ⚠️ **没有 `kind` 参数**：这一路固定用「文档 + 代码」那一份不分档语料，
          // 和面板当前在哪个档位无关（档位只切列表那一栏）。
          const res = await fetch(`${CHANGES_API}?sessionId=${encodeURIComponent(sessionId)}&limit=40&sort=relevance`, {
            headers: { accept: 'application/json' }, cache: 'no-store',
          })
          const data = await res.json()
          if (!live()) return
          setChangesData((prev) => {
            // ⚠️ 「请求失败」与「读不到 git」**不许**都变成 `null`：`null` 是「这个功能没开」，
            // 用它表示失败会让用户以为「没有变更」。失败有自己的形状（见 `changeStatusOf`）。
            if (!data || !data.ok) return { failed: true, reason: 'request' }
            // 载荷一字未变就返回**同一个对象**，React 跳过这次更新（与列表同一套去重理由）
            const sig = JSON.stringify(data)
            return (prev && prev.sig === sig) ? prev : { ...data, sig }
          })
        } catch {
          if (!live()) return
          setChangesData({ failed: true, reason: 'request' })
        }
        // 「读了多久」是按分钟变的相对时间：只有**分钟数**真的变了才落一次刷新信号（其余时候
        // 返回同一个值，React 直接跳过这次更新）。标签读的是渲染时刻的钟，不受这里影响。
        const now = Date.now()
        bumpTick((prev) => (Math.floor(now / 60000) === Math.floor(prev / 60000) ? prev : now))
      }, [sessionId, sort, kind, usageOn, retrieval, changesOn])

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

      /* ── v0.21 固定 / 排除：整个 HTTP 面唯一的**写**动作 ──────────────
         一次点击 = 一次 POST + 一次重取。为什么要重取而不是本地改状态：被固定的那篇
         要从三层里**移出**、被排除的那篇要**离开候选集**（连 `matched` 计数都变），
         这些判断都在宿主侧（`context.js` 的分层与 `scan()` 的候选集）—— 客户端自己
         算一份就是第二个真相。`sig: ''` 是让紧接着的 `load` 一定落一次状态，
         不等下一次轮询（即时信号那条纪律：点一下就该有反应）。
         ⚠️ 失败必须是**说明**而不是静默：失败只写 notice，不动任何本地状态
         （乐观更新在这条路径上会让界面先骗人再改口）。 */
      const act = React.useCallback(async (action, rel) => {
        if (!sessionId || !rel) return
        try {
          const res = await fetch(`${CONTROL_API}?sessionId=${encodeURIComponent(sessionId)}`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', accept: 'application/json' },
            cache: 'no-store',
            body: JSON.stringify({ action, rel }),
          })
          const data = await res.json()
          if (data && data.ok && data.control) {
            setNotice('')
            setWhyOpen('')
            setState((prev) => ({ ...prev, control: data.control, sig: '' }))
            await load(true)
          } else {
            setNotice(t('control.failed', { error: hostMessage(data) }))
          }
        } catch (error) {
          setNotice(t('control.failed', { error: String((error && error.message) || error) }))
        }
      }, [sessionId, load])

      /* ── 过滤：纯客户端，不重新请求宿主 ─────────────── */
      /* v0.26.x「变更」档：数据来自独立 `/api/status`，**不混进 state.docs** ——
         列表刷新（5 s 轮询）与变更读取互不影响。`changesStatus` 挂在 state 上是为了
         避免新增 hook 位置（测试按位预置 hook）；它是纯缓存，不参与排序。 */
      const changesStatus = state.changesStatus || null
      const changeView = changeStatusOf(changesStatus)
      const changeDocsAll = changeDocsOf(changesStatus)
      const changeText = query.trim().toLowerCase()
      const changeDocs = changeText
        ? changeDocsAll.filter((doc) => docMatchesQuery(doc, changeText))
        : changeDocsAll
      const visibleDocs = React.useMemo(() => {
        if (kind === KIND_CHANGES) return changeDocs
        const all = Array.isArray(state.docs) ? state.docs : []
        const q = query.trim().toLowerCase()
        if (!q) return all
        return all.filter((doc) => docMatchesQuery(doc, q))
      }, [kind, changeDocs, state.docs, query])

      // ResizeObserver 量到的是 .knit-list（它自己也有左右内边距），
      // 网格的可用宽度 = 列表宽度 − 列表内边距 − 网格内边距。
      // 文档列表**没有列数可算**：永远一个文档一行（见 `DOC_GRID` 那段说明）。
      // 于是这里也不再需要 `listWidth − LIST_PAD_X` 这个量 —— 只有媒体网格要宽度。
      const mediaLayout = mediaLayoutFor(Math.max(0, listWidth - LIST_PAD_X - MEDIA_GRID_PAD_X))

      /* v0.28：缩略图采样边长（只依赖列宽，没有 TDZ）。
         真正的「挂多少张」在 `navDocsOf()` 里算 —— 那个要读末尾声明的 `mediaShown`。 */
      const mediaEdge = thumbEdgeFor(mediaLayout.cell)

      /** 媒体网格：列数由 CSS 的 auto-fill 自己数；JS 只下发「一格多宽」用于正方形兜底。
       *  **不设 maxHeight** —— 有多少行就铺多少行，纵向滚动统一交给 `.knit-list`。 */
      // v0.23：`inSection` 参数随「全部」的类型分区一起删除 —— 媒体网格只有一种形态
      // （不带 `.in-section`，外层自己带内边距）。
      const mediaGrid = (docs) => h('div', {
        className: 'knit-media-grid',
        role: 'group',
        style: {
          '--knit-media-cell': `${mediaLayout.cell}px`,
          ...(mediaLayout.scaled ? { '--knit-media-label': 'none' } : {}),
        },
      }, docs.map(renderEntry),
      // 滚到底的哨兵：IntersectionObserver 命中就追加一批
      // （`mediaShown` 声明在末尾，所以这里只能**函数内**判断，不能在渲染期读常量）
      mediaVisibleDocs().length < mediaDocs.length
        ? h('div', { key: 'knit-media-more', className: 'knit-media-more', 'data-knit-media-more': '1', ref: mediaSentinelRef },
            h('span', { className: 'knit-media-more-text' }, t('media.loadingMore')))
        : null)

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

      const relevance = state.mode === 'relevance' && kind !== KIND_CHANGES
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
        section.hintKey
          ? h('span', { className: 'knit-tierhint' }, t(section.hintKey, section.hintParams))
          : null),
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
        // v0.23.1：只认「文档 / 代码」两档 —— 「全部」档已整体删除（2026-10-12 用户裁决）。
        if (!relevance || (kind !== KIND_DOC && kind !== KIND_CODE) || !pack) return null
        const tiers = [
          ['primary', 'context.primary', 'context.primaryHint'],
          ['supporting', 'context.supporting', 'context.supportingHint'],
          ['related', 'context.related', 'context.relatedHint'],
        ]
        // v0.23：层级过滤只认**成行的条目**（文档 / 代码）—— 媒体**永远不进层**。
        // 宿主侧已经在装配之前把媒体剔掉了（`contextPayload()`），这里是第二道防线：
        // 就算哪天宿主把一个靠文件名命中的 `.mp4` 塞进包里，界面也不会把它当上下文渲染。
        const visible = new Set(visibleDocs.filter((doc) => !isMedia(doc)).map((doc) => doc.rel))
        /* v0.20 修正：宿主给三层条目的投影**只有 7 个键**（`context.js` 的
           `rel/title/summary/mtimeMs/kind/source/reason`）—— 那里**没有 `matches`**，
           而「命中片段」那一行读的是 `doc.matches`（下面的 `firstMatchOf`）。
           于是最初的三层行（Primary/Supporting/Related，恰恰是最该给片段的那几行）
           全都渲染不出片段行，只有「其他相关文档」区（取自 `visibleDocs`）有。
           修法：三层条目按 `rel` 从**同一批 `visibleDocs`** 取回 `matches` ——
           `docs` 里本来就有这份数据，**不额外增长任何载荷**；不改成让宿主补键，
           是因为面板载荷已经吃掉 16 KB 预算的大部分（v0.20 R2：+14760 B）。 */
        const hitByRel = new Map()
        for (const doc of visibleDocs) {
          if (Array.isArray(doc.matches) && doc.matches.length > 0) hitByRel.set(doc.rel, doc.matches)
        }
        const withHits = (item) => (item.matches ? item
          : (hitByRel.has(item.rel) ? { ...item, matches: hitByRel.get(item.rel) } : item))
        const sections = []
        /* v0.21：**用户固定**在最上面，独立一区、不编号（需求 §6.3）。它排在三层之前不是
           因为它更重要，而是因为它是**用户自己的动作**：三层是这一轮的检索结果，下一轮
           就变了；固定的那几篇会一直在。`pack.pinned` 由宿主从三层里**移出**后给出，
           所以这里不会与下面三层重复。 */
        const pinned = Array.isArray(pack.pinned) ? pack.pinned.filter((item) => visible.has(item.rel)).map(withHits) : []
        if (pinned.length > 0) {
          sections.push({ key: 'pinned', titleKey: 'context.pinned', hintKey: 'context.pinnedHint', docs: pinned })
        }
        /* v0.25：**Git 变更关联**。它与固定区是同一类东西：一组有证据、但**不属于这一轮名次**的
           条目，所以独立成一区、不编号（`numbers` 那边一并跳过它）。
           ⚠️ 这里**不能**用 `visible`（它来自 `state.docs` 那 40 条的切片）—— 一条变更关联的
              文件很可能排在 40 名之外，用 `visible` 过滤会让整区凭空空掉。它只受**过滤框**约束，
              与用户在搜索框里打的字保持一致。 */
        const changeRows = changeRowsOf(changesData)
        // ⚠️ 这里**自己派生一次**，不复用状态行那份 `changeStatus`：那个常量声明在这个
        // useMemo **之后**（靠近状态行的渲染），引它会 `Cannot access before initialization`
        // —— 运行时直接白屏（写完当场被测试抓到）。同一个纯函数、同一个入参，不会分叉。
        const changeState = changeStatusOf(changesData)
        const q = query.trim().toLowerCase()
        const changeDocs = changeRows.filter((item) => !isMedia(item) && docMatchesQuery(item, q)).map(withHits)
        if (changeDocs.length > 0) {
          sections.push({ key: 'changes', titleKey: 'context.changes', hintKey: 'context.changesHint', docs: changeDocs })
        } else if (changesOn && changesData !== null && !changeState.read) {
          /* v0.25 收尾：**读不到时把原因直接写出来**，不再只放在悬停里。
             为什么加这一条：真人反馈（2026-10-13）—— 用户看到那一格写「变更 —」，
             读成了「这个数据没记录到」，而真正的原因是「这个工作区不是 Git 仓库」，
             它只藏在 `title` 里，不悬停就看不见。
             ⚠️ 条件里的 `changesData !== null` 是必须的：功能刚打开、第一次取数还没回来时
             `read` 也是 false，那时写「原因未知」是**假话**（不是读不到，是还没读到）。
             那一瞬间不出这一区，等下一条轮询落地。 */
          sections.push({
            key: 'changes', titleKey: 'context.changes', hintKey: 'context.changesUnreadable',
            hintParams: { reason: t(changeReasonKey(changeState.reason)) },
            docs: [],
          })
        } else if (changesOn && changeState.read && changeState.filesTotal > 0) {
          /* v0.25 收尾：**有变更、但一条关联证据都没有**时要说得出来。
             这一区是**只带提示句、不带行**的（区头照常出现）—— 用户因此能区分
             「没有变更」（那一格写 0，这里什么都不出）与「有变更但没找到该一起看的」。
             读不到 git 的那种情况**不在这里**：它的提示在状态行那一格（「变更 —」 + 悬停原因），
             因为「读不到」不是一条列表内容。 */
          sections.push({
            key: 'changes', titleKey: 'context.changes',
            hintKey: 'context.changesEmpty', hintParams: { files: changeState.filesTotal },
            docs: [],
          })
        }
        for (const [tierKey, titleKey, hintKey] of tiers) {
          const items = Array.isArray(pack[tierKey]) ? pack[tierKey] : []
          const docs = items.filter((item) => visible.has(item.rel)).map(withHits)
          if (docs.length > 0) sections.push({ key: tierKey, titleKey, hintKey, docs })
        }
        // 其余文档：宿主没放进任何一层的。补上它们，面板才仍然是「工作区的地图」，
        // 而不是一个可能漏掉用户要找的那一篇的子集。
        const placed = new Set()
        for (const tierKey of ['primary', 'supporting', 'related']) {
          for (const item of (Array.isArray(pack[tierKey]) ? pack[tierKey] : [])) placed.add(item.rel)
        }
        // 固定区里的也在包里 —— 它们同样不该出现在「其他相关文档」。
        for (const item of (Array.isArray(pack.pinned) ? pack.pinned : [])) placed.add(item.rel)
        // 变更关联区里的也不再出现在「其他相关文档」（同一篇不该在两处出现）
        for (const item of changeRows) placed.add(item.rel)
        const rest = visibleDocs.filter((doc) => !isMedia(doc) && !placed.has(doc.rel))
        if (rest.length > 0) {
          sections.push({ key: 'other', titleKey: 'context.other', hintKey: '', docs: rest })
        }
        if (sections.length === 0) return null
        // 行首序号（Design §11）：**只编三层里的**，而且是跨层连续的
        // （01 属于 Primary、02/03 属于 Supporting……），与右栏证据行的计数对齐。
        // 「其他相关文档」不编号 —— 它们不在这个包里面。
        // v0.21：**固定区也不编号** —— 它的位置由用户决定，不由阅读顺序决定。
        const numbers = new Map()
        for (const section of sections) {
          if (section.key === 'other' || section.key === 'pinned' || section.key === 'changes') continue
          for (const doc of section.docs) numbers.set(doc.rel, numbers.size + 1)
        }
        // 键盘到达顺序 = 屏幕上从上到下的顺序（分组顺序 + 组内顺序）
        const flat = []
        for (const section of sections) for (const doc of section.docs) flat.push(doc)
        return { sections, flat, numbers }
      }, [relevance, kind, state.context, changesData, visibleDocs, query])

      /**
       * 键盘与 cursor 真正能到达的条目。
       *
       * 分了层时必须是**三层里那些真的渲染出来的条目**（`contextView.flat`）——
       * 否则「其他相关文档」区里的条目键盘到不了，而已经在 Related 层里的条目
       * 会被算两次。（媒体档走的是网格，`visibleDocs` 就是那批媒体。）
       */
      /* v0.25：媒体档的「可见条目」＝ 收藏在前 + 对话里生成的 + 其余。
         `navDocs` 也用它 —— 否则键盘导航会把对话里那几张**跳过去**（看得见、走不到）。
         收藏仍然排在最前：这一条没变，只是把「还没存进项目的图」插在收藏之后。 */
      const mediaDocs = React.useMemo(() => {
        /* 媒体档的**唯一**顺序：按时间倒序（最新在前）。文档/代码才看相关性。
           工作区文件用 `mtimeMs`，对话里生成的图用事件时间（`at` → 伪文档的 `mtimeMs`）——
           两者同一条时间轴，所以「刚生成的」自然在最前；存进项目后它变成文件、时间也还在附近。
           收藏仍然前移（`orderFavorites` 是**稳定**分区 ⇒ 两组内部都还是时间倒序）。 */
        const byTimeDesc = (a, b) => (Number.isFinite(b.mtimeMs) ? b.mtimeMs : 0) - (Number.isFinite(a.mtimeMs) ? a.mtimeMs : 0)
        const merged = (Array.isArray(visibleDocs) ? visibleDocs : []).concat(attachmentDocs)
        return orderFavorites(merged.slice().sort(byTimeDesc), favoriteSet)
      }, [visibleDocs, favoriteSet, attachmentDocs])
      /* v0.28：**函数**而不是常量 —— 媒体档要读「当前挂载到第几张」（`mediaShown`），
         而那个 state 声明在函数末尾（新 hook 只能往后追加，不能插队）。
         这里改成惰性求值：渲染期与事件/effect 里调用它时，末尾那些声明早已初始化。 */
      const navDocsOf = () => {
        if (kind === KIND_CHANGES) return visibleDocs
        if (kind === KIND_MEDIA && !contextView) return mediaVisibleDocs()
        return contextView ? contextView.flat : visibleDocs
      }

      // cursor 消失（被过滤掉 / 被上限截断 / 列表刷新）时落回第一项
      React.useEffect(() => {
        const list = navDocsOf()
        if (list.length === 0) {
          if (cursor !== '') setCursor('')
          return
        }
        if (!list.some((doc) => doc.rel === cursor)) setCursor(list[0].rel)
        // 依赖里**不放** navDocsOf（每次渲染都是新函数）；用它的输入量代替。
      }, [kind, query, cursor, state.docs, mediaDocs, visibleDocs, contextView])

      /* v0.28：换档 / 换搜索词 / 条目批次变化 ⇒ 回到首屏批量。
         （只按 kind+query 重置：5 秒轮询拿到的新数组不该把用户已经滚出来的量收回去。） */
      React.useEffect(() => {
        setMediaShown((prev) => (prev === 0 ? prev : 0))
      }, [kind, query])

      /* v0.28：哨兵进视口就追加一批。没有 `IntersectionObserver` 时**保持原样**
         （只挂首屏那批；用户可以用键盘 / 搜索到达更多），绝不假装加载过。 */
      React.useEffect(() => {
        if (mediaDocs.length <= mediaFirstBatch(mediaLayout.columns)) return undefined
        if (typeof IntersectionObserver !== 'function') return undefined
        const node = mediaSentinelRef.current
        const root = listRef.current
        if (!node) return undefined
        const io = new IntersectionObserver((entries) => {
          for (const entry of entries) {
            if (!entry || !entry.isIntersecting) continue
            setMediaShown((prev) => {
              const all = mediaDocs.length
              const base = prev > 0 ? prev : mediaFirstBatch(mediaLayout.columns)
              return mediaNextCount(Math.min(base, all), all)
            })
          }
        }, { root: root || null, rootMargin: '320px' })
        io.observe(node)
        return () => { try { io.disconnect() } catch { /* 忽略 */ } }
      }, [mediaDocs.length, mediaLayout.columns])

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
      const previewFor = React.useCallback((doc, anchor) => {
        const base = {
          rel: doc.rel, title: doc.title || doc.name, path: doc.path || '', text: '', truncated: false,
          // `anchorSeq`：每**一次**打开都 +1，让「重复点同一段」也能再滚一次
          // （CodePane / DocPane 的 effect 只看这一个计数，不看偏移量相等与否）。
          anchor: anchor || null, anchorSeq: 0,
        }
        if (isMedia(doc)) {
          // v0.25：对话里生成的图走 sha256 那条地址（它没有工作区路径）
          const src = doc.attachmentId ? attachmentUrl(sessionId, doc.attachmentId) : mediaUrl(sessionId, doc.rel)
          return { ...base, kind: doc.kind, src, status: 'ready' }
        }
        return { ...base, kind: doc.kind || ARTIFACT_DOC, status: 'loading' }
      }, [sessionId])

      /**
       * 打开（不切换）某篇的预览。
       *
       * v0.20（2026-10-07 用户裁决）：**带上篇内第一段命中**（`firstMatchOf`）——
       * 原话「我在点击这个文档或者是代码块的时候，就进入一个预览，那能不能直接定位到
       * 这几段呢？这样的交互非常丝滑」。于是「点文档」＝「看这一篇里跟当前任务有关的那几行」，
       * 不再先落在文件开头让用户自己找。v0.20 起**文档与代码一样会滚**：代码按行高算
       * （`CodePane`），Markdown 按文本锚点找（`DocPane` + `docAnchorNeedles`）——
       * 后者靠的是「片段原文里的那几行字符串在渲染结果里也一定在」。
       */
      const openPreview = React.useCallback((doc) => {
        setNotice('')
        setPreview(previewFor(doc, firstMatchOf(doc)))
      }, [previewFor])

      /** 单击 / Enter：切换某篇的预览开与关（同样带上篇内第一段命中）。 */
      const togglePreview = React.useCallback((doc) => {
        setNotice('')
        setCursor(doc.rel)
        setPreview((current) => {
          if (current && current.rel === doc.rel && current.status !== 'error') return null
          return previewFor(doc, firstMatchOf(doc))
        })
      }, [previewFor])

      /**
       * 「变更」档点开一行：拉 `/api/diff`，在同一个预览面板里画逐行 diff。
       * 普通行仍走 `togglePreview`；这里只是给变更行换一个打开方式，不新增第二套面板。
       */
      const openDiff = async (doc) => {
        if (!doc) return
        setNotice('')
        setCursor(doc.rel)
        setPreview({
          rel: doc.rel, title: doc.title || doc.name, path: '', text: '', status: 'ready',
          kind: doc.kind || ARTIFACT_CODE, diff: { loading: true },
          added: doc.change ? doc.change.added : null, removed: doc.change ? doc.change.removed : null,
        })
        try {
          const res = await fetch(`${DIFF_API}?sessionId=${encodeURIComponent(sessionId)}&rel=${encodeURIComponent(doc.rel)}`, {
            headers: { accept: 'application/json' }, cache: 'no-store',
          })
          const data = await res.json()
          setPreview((prev) => (prev && prev.rel === doc.rel
            ? { ...prev, diff: data && data.ok ? data : { error: true } }
            : prev))
        } catch {
          setPreview((prev) => (prev && prev.rel === doc.rel ? { ...prev, diff: { error: true } } : prev))
        }
      }

      /** 收起预览；全屏时顺带退出全屏。 */
      const closePreview = React.useCallback(() => {
        setPreview(null)
        setFullscreen(false)
      }, [])

      /**
       * v0.20（需求 §13）：点列表行的「命中片段：147–163」——**就地预览 + 跳到那一段**。
       *
       * 三条刻意的选择：
       *  - **不发明新的 preview**：仍是 `.knit-preview` 那一套（同一个拉正文的 effect、
       *    同一个 CodePane），只是多带一个 `anchor`。
       *  - **同一篇已经打开时不重拉正文**：只换 `anchor`，滚动由 CodePane 的 effect 做
       *    （重拉会让预览闪一下「加载中」，那是用户抱怨过的「一点它就跳」）。
       *  - `anchor` 谁都能读：代码给 `CodePane`（按行高算），Markdown 给 `DocPane`
       *    （按文本锚点找）。两边都**找不到就不动**，绝不假装跳过。
       */
      const openPassage = React.useCallback((doc, match) => {
        setNotice('')
        setCursor(doc.rel)
        setPreview((current) => {
          if (current && current.rel === doc.rel && current.status === 'ready') {
            return { ...current, anchor: match || null, anchorSeq: (Number(current.anchorSeq) || 0) + 1 }
          }
          return previewFor(doc, match)
        })
      }, [previewFor])

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
      /* ── v0.25：媒体档「双击全屏」（**追加在末尾**：替身按下标 seed useState/useRef）
         存的是 `rel` 而不是下标 —— 列表每 5 秒会换一份，下标会漂；`rel` 不会。
         列表里找不到它了（被删 / 被存进项目 / 切了档）就自己关掉。 */
      const [lightboxRel, setLightboxRel] = React.useState('')
      /* v0.26 返工：`docked` = 在 **Knit 面板里**显示画布（不盖会话、身份清楚）；
         `false` = 原来的整屏查看器（只在「全屏」按钮里用）。
         ⚠️ 默认双击仍是整屏（v0.25 的既有语义不动）；**评论入口走 hover 大图 → 面板画布**。 */
      const [lightboxDock, setLightboxDock] = React.useState(false)
      const lightboxRef = React.useRef(null)
      const lightboxIndex = React.useMemo(
        () => (lightboxRel ? mediaDocs.findIndex((doc) => doc.rel === lightboxRel) : -1),
        [mediaDocs, lightboxRel],
      )
      const lightboxDoc = lightboxIndex >= 0 ? mediaDocs[lightboxIndex] : null
      const lightboxRailView = React.useMemo(
        () => lightboxRail(mediaDocs, lightboxIndex),
        [mediaDocs, lightboxIndex],
      )
      React.useEffect(() => {
        if (lightboxRel && lightboxIndex < 0) setLightboxRel('')
      }, [lightboxRel, lightboxIndex])
      const lightboxOpen = React.useCallback((doc, opts = {}) => {
        if (!doc || doc.kind !== 'image') return
        setLightboxRel(doc.rel)
        setLightboxDock(opts.dock === true)
        // 面板画布从 hover 的「评论」进来时直接落在评论模式；整屏查看默认干净
        setCommentOn(opts.comment === true)
        // 悬停浮窗这时必须收掉：它在查看器下面，留着就是两层大字
        if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current)
        hoverTimerRef.current = 0
        if (hoverHideRef.current) clearTimeout(hoverHideRef.current)
        hoverHideRef.current = 0
        setHoverShot(null)
      }, [])
      const lightboxClose = React.useCallback(() => setLightboxRel(''), [])
      /* 翻到第 9 张时，左列如果溢出，当前那张会被留在视野外 —— 每次换图都把它**滚进来**
         （`block:'nearest'`：已经在视野里就一格都不动，不会抖）。没有 DOM 就跳过。 */
      const lightboxRailRef = React.useRef(null)
      React.useEffect(() => {
        if (!lightboxRel) return
        const rail = lightboxRailRef.current
        if (!rail || typeof rail.querySelector !== 'function') return
        const active = rail.querySelector('.knit-lightbox-thumb.active')
        if (active && typeof active.scrollIntoView === 'function') {
          try { active.scrollIntoView({ block: 'nearest' }) } catch { /* 老浏览器：算了，不影响换图 */ }
        }
      }, [lightboxRel])
      /** 查看器里的「本地打开」：与预览头同一条宿主通道，只是路径从 rel 现算。 */
      const lightboxAbs = lightboxDoc
        ? (lightboxDoc.path || joinPath(state.hostRoot || state.root, lightboxDoc.rel))
        : ''
      const lightboxOpenLocal = React.useCallback(async () => {
        setNotice((await openLocalPath(lightboxAbs)) || '')
      }, [lightboxAbs])
      /* 打开时把焦点交给遮罩：键盘用户一进来 Esc / ← → 就该能用（真机才有 DOM）。 */
      React.useLayoutEffect(() => {
        if (!lightboxRel) return
        const node = lightboxRef.current
        if (node && typeof node.focus === 'function') node.focus()
      }, [lightboxRel])
      /**
       * 在带子里前后翻（环绕）。
       *
       * ⚠️ 必须用**函数式更新**从「当前 state」推下一步，不能读渲染时捕获的 `lightboxIndex`：
       * 连着按两下 → 如果两下都落在同一次渲染的闭包里，第二下会用**陈旧的下标**再算一遍，
       * 结果只前进一格（证伪时就是这么抓到的）。现在每一步都以「此刻的 rel」为起点。
       */
      const lightboxStep = React.useCallback((delta) => {
        if (!mediaDocs.length) return
        setLightboxRel((current) => {
          const at = mediaDocs.findIndex((doc) => doc.rel === current)
          const from = at >= 0 ? at : 0
          const next = (from + (delta < 0 ? -1 : 1) + mediaDocs.length) % mediaDocs.length
          const doc = mediaDocs[next]
          return doc ? doc.rel : current
        })
      }, [mediaDocs])

      const onListKeyDown = React.useCallback((event) => {
        const navDocs = navDocsOf()
        if (navDocs.length === 0) return
        const index = navDocs.findIndex((doc) => doc.rel === cursor)
        const last = navDocs.length - 1

        // 方向键与 Home/End 全部交给纯函数算（见 nextIndexFor 的注释）
        const navColumns = kind === KIND_MEDIA ? mediaLayout.columns : 1
        const target = nextIndexFor(index, event.key, navDocs.length, navColumns)
        if (target >= 0) {
          event.preventDefault()
          const doc = navDocs[target]
          if (doc) {
            setCursor(doc.rel)
            // 媒体档不做就地预览（2026-10-22 用户裁决）：方向键只移光标，看大图用 Enter / 双击
            if (kind !== KIND_MEDIA) openPreview(doc)
          }
          return
        }
        if (event.key === 'Enter') {
          event.preventDefault()
          const doc = navDocs.find((d) => d.rel === cursor) || navDocs[0]
          if (doc) {
            // 与双击同一套分流（键盘不能比鼠标少一条路）
            if (kind === KIND_MEDIA && doc.kind === 'image') lightboxOpen(doc)
            else togglePreview(doc)
          }
          return
        }
        if (event.key === 'Escape') {
          event.preventDefault()
          if (fullscreen) setFullscreen(false)
          else closePreview()
        }
      }, [cursor, fullscreen, kind, query, state.docs, mediaDocs, visibleDocs, contextView, mediaLayout.columns, openPreview, togglePreview, closePreview, lightboxOpen])

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
      const srcFor = React.useCallback(
        (doc) => (doc.attachmentId ? attachmentUrl(sessionId, doc.attachmentId) : mediaUrl(sessionId, doc.rel)),
        [sessionId],
      )

      /**
       * 切换检索模式并记住偏好。**只切偏好**：真正的 provider 调用发生在宿主侧，
       * 下一次 `load()` 会带上新的 `retrieval`。切回词法时把配置区的提示清掉。
       * @param {'lexical'|'hybrid'} value - 检索模式
       */
      const pickRetrieval = React.useCallback((value) => {
        writePref(RETRIEVAL_KEY, value)
        setRetrieval(value)
        setSemNotice('')
      }, [])

      /**
       * v0.25：切换「Git 变更关联」并记住偏好。**只切偏好** —— 真正跑 git 的是宿主，
       * 下一次 `load()` 会带上 `changes=1`。关掉时请求里就不带了（宿主零开销）。
       * @param {boolean} value - 是否开启
       */
      const pickChanges = React.useCallback((value) => {
        writePref(CHANGES_KEY, value ? '1' : '0')
        setChangesOn(value)
      }, [])

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
        // 上一次**量过**的那帧的行签名（v0.20 性能治理）：签名没变就一行都不量。
        sig: '',
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

      /* v0.23（2026-10-11）：检索模式改成搜索框右端的小下拉后的两个状态。
         ⚠️ 与上面那条注释同一条纪律：**必须留在本组件所有既有 hook 之后**，
            否则 `harness.seed()` 的位置预置会整体错位。 */
      /** 那个小菜单开着没有。 */
      const [retMenuOpen, setRetMenuOpen] = React.useState(false)
      /** 就地配置区（`.knit-semcfg`）展开了没有 —— 由菜单里「配置语义 provider…」开关。 */
      const [semCfgOpen, setSemCfgOpen] = React.useState(false)

      /** 配置区一展开就把焦点送进第一个输入框（键盘用户不用自己 Tab 过去）。 */
      React.useEffect(() => {
        if (semCfgOpen) focusFirst('.knit-semcfg-input')
      }, [semCfgOpen])

      /** 点面板别处就收起菜单。判据用「点在 `.knit-pipe-method-wrap` 之内就放过」——
       *  否则按钮自己的点击会先关（pointerdown）再开（click），菜单根本打不开。
       *  ⚠️ 测试替身里 `window.addEventListener` 是空实现 ⇒ 这条只在真机生效，
       *     所以 Esc 那条**必须**另外挂在按钮与菜单上（可被断言）。 */
      React.useEffect(() => {
        if (!retMenuOpen) return undefined
        const onPointerDown = (event) => {
          const node = event && event.target
          if (node && typeof node.closest === 'function' && node.closest('.knit-pipe-method-wrap')) return
          setRetMenuOpen(false)
        }
        window.addEventListener('pointerdown', onPointerDown)
        return () => window.removeEventListener('pointerdown', onPointerDown)
      }, [retMenuOpen])

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
        if (kind === KIND_CHANGES) return []  // 变更档：列表每次刷新可能整批换，别让整屏飞
        if (contextView) {
          // 有包（相关序）：三层的 key 就是运动分组 —— 「全部」与「文档」走同一条路。
          const rows = []
          for (const section of contextView.sections) {
            section.docs.forEach((doc, index) => rows.push(
              { rel: doc.rel, tierKey: section.key, index, doc }))
          }
          return rows
        }
        // 平铺（时间序 / 没有包）：媒体档走网格、不进行。
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
        /* v0.20 性能治理（2026-10-07）：**行集合 / 顺序 / 会影响行高的字段**都没变时，一行都
           不量 —— 直接复用上一帧的位置表。FLIP 的量法本身就是一次强制布局
           （`querySelectorAll` + 逐行 `offsetTop`），而 5 s 轮询 / 悬停 / 选中都会走到这里：
           真机 4× CPU 节流下量到 90–350 ms / 次，用户体感就是「点一下卡一下」。
           签名里带上窗口宽度（换宽 / 缩放会让行高变），行真挪了签名就变，照旧量。 */
        const rowSig = settled
          ? `${typeof window === 'undefined' ? '' : `${window.innerWidth}x${window.innerHeight}`}|${
            motionRows.map((row) => `${row.rel}\u0000${row.tierKey}\u0000${
              (row.doc && row.doc.matches && row.doc.matches.length) || 0}\u0000${
              (row.doc && (row.doc.mtimeMs || row.doc.mtime || row.doc.size)) || ''}`).join('\u0001')}`
          : ''
        store.positions = settled && rowSig !== store.sig
          ? applyRowFlips(listRef.current, store.positions, skip)
          : (settled ? store.positions : new Map())
        store.sig = rowSig
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
          now: Date.now(),
          active: Boolean(preview && preview.rel === doc.rel),
          cursor: doc.rel === cursor,
          optionId: docOptionId(doc),
          onSelect: doc.change ? () => openDiff(doc) : togglePreview,
          onOpenTab: doc.change ? () => openDiff(doc) : onOpenTab,
          // v0.20（需求 §12）：只有真的带命中片段的条目才渲染那一行 —— 没有就不渲染，
          // 不编造一个「命中片段：—」的占位（§26：只展示可验证信息）。
          passage: firstMatchOf(doc),
          onPassage: openPassage,
        }
        if (isMedia(doc)) {
          return h(MediaCard, {
            ...common,
            /* 单击**只移光标**（`active` 不再亮、下方不再弹预览）——
               这是用户 2026-10-22 明确要撤掉的那个交互。 */
            onSelect: () => setCursor(doc.rel),
            onPreview: togglePreview,
            src: srcFor(doc),
            edge: mediaEdge,
            favorite: favoriteSet.has(doc.rel),
            conversation: Boolean(doc.conversation),
            onHoverStart: hoverStart,
            onHoverEnd: hoverEnd,
            onZoom: lightboxOpen,
          })
        }
        // `whyText` 只认 Context Pack 条目上挂的 `reason` —— 平铺列表里没有这个字段，
        // 于是返回空串，那一行不渲染。
        // `num` / `primary` 只有分层视图会传（Design §11 / §13）；平铺列表照旧无序号。
        // `mark`＝没号时同列的占位标记，只在「这一屏里有号」时为真。
        // 进出动效只在真机上跑（`motionOn`）：测试替身没有 DOM，`motionAllowed()` 挡掉，
        // 于是渲染树里既没有 `entering` 也没有 `leaving`，与没有这段动效时逐字一致。
        // v0.18：生命周期现在是**一枚 glyph + 一段极短的文字**。glyph 可点：
        // 点它＝打开 / 选中这一篇（**已经打开则保持原预览**，不重开也不重拉）。
        const info = withLife ? lifeInfo(doc.rel) : null
        // v0.21：上下文控制只在**有包的视图**里给出（相关序 + 宿主真的给了 Context Pack）
        // —— 固定与排除说的都是「这个包 / 这份候选集里的这一条」，管道条与排除说明
        // 也在同一条件下出现。来源徽标只有宿主真的给了 `provenance` 才渲染：
        // 平铺列表里的条目来源未知，不能替它认领一个「检索」。
        const controllable = Boolean(contextView && !isMedia(doc))
        return h(DocRow, { ...common, relevance, why: whyText(doc.reason), num, mark, primary,
          change: doc.change || null,
          prov: provText(doc.provenance),
          pinned: doc.provenance === 'manual',
          onAct: controllable ? act : null,
          whyOpen: Boolean(whyOpen) && whyOpen === doc.rel,
          // 「为什么」只有在**真的有关系可看**时才是一个可点的开关（没有证据就不装成
          // 有证据的样子 —— 需求 §6.4：解释必须来自真实关系）。
          relations: Array.isArray(doc.relations) && doc.relations.length > 0 ? doc.relations : null,
          relationsTotal: Number.isInteger(doc.relationsTotal) ? doc.relationsTotal : 0,
          onWhyToggle: controllable ? () => setWhyOpen((prev) => (prev === doc.rel ? '' : doc.rel)) : null,
          onOpenRelation: (rel, line) => {
            const target = visibleDocs.find((item) => item.rel === rel) || { rel }
            openPassage(target, Number.isInteger(line) ? { startLine: line, endLine: line } : null)
          },
          life: info ? info.text : null,
          glyph: info,
          onGlyph: (target) => {
            if (preview && preview.rel === target.rel) return
            openPreview(target)
          },
          entering: motion.entered.has(doc.rel) ? motion.entered.get(doc.rel) : null,
          leaving: Boolean(doc.knitLeaving) })
      }

      // 媒体视图：一格都不隐藏 —— 一屏两行以外的部分在媒体区**内部滚动**，
      // 既不让面板被整面媒体墙顶爆，也不会像旧版那样把剩下的条目直接切掉。
      const emptyText = kind === KIND_CHANGES
        ? t('list.emptyChanges')
        : kind === KIND_MEDIA
          ? t('list.emptyMedia')
          : kind === KIND_CODE
            ? t('list.emptyCode')
            : t('list.empty')
      /* ⚠️ 为什么是**函数**而不是常量：这里要读「面板末尾才声明」的状态（媒体收藏）。
         写成常量会在这一行就求值 ⇒ TDZ（`Cannot access 'favoriteSet' before initialization`）。
         包成函数、在 return 里调用一次，既不改渲染结果，也不会再被后面的新状态绊倒。 */
      /* 变更档自己的三态：还没读到 / 读不到（带原因）/ 读到了但没东西可列。
         ⚠️ 它**不**看 `state.status` —— 那是文档列表的加载态，与 git 无关。 */
      const changesListBody = () => {
        if (changesStatus === null) return h('div', { className: 'knit-msg' }, t('list.changesLoading'))
        if (!changeView.read) {
          return h('div', { className: 'knit-msg' },
            t('changes.unavailable', { reason: t(changeReasonKey(changeView.reason)) }))
        }
        if (changeView.filesTotal === 0) return h('div', { className: 'knit-msg' }, t('list.emptyChanges'))
        if (changeDocsAll.length === 0) {
          return h('div', { className: 'knit-msg' }, t('list.changeOnlyOther', { n: changeView.filesTotal }))
        }
        if (changeDocs.length === 0) {
          return h('div', { className: 'knit-msg' }, t('list.noMatch', { query: query.trim() }))
        }
        return docsGrid(changeDocs)
      }
      const listBody = () => (kind === KIND_CHANGES
        ? changesListBody()
        : state.status === 'loading' && state.docs.length === 0
        ? h('div', { className: 'knit-msg' }, t('list.scanning'))
        : state.status === 'error'
          ? h('div', { className: 'knit-msg' }, t('list.failed', { error: state.error }), h('br'), t('list.failedHint'))
          : state.docs.length === 0
            ? h('div', { className: 'knit-msg' }, emptyText)
            : visibleDocs.length === 0
              ? h('div', { className: 'knit-msg' }, t('list.noMatch', { query: query.trim() }))
              : kind === KIND_MEDIA
                ? mediaGrid(mediaVisibleDocs())
                : contextView
                  ? contextBody(contextView)
                  : docsGrid(withGhosts(MOTION_TIER_FLAT, visibleDocs)))

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
          h('span', { className: 'knit-read-time' }, relTime(recent.at, Date.now())),
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

      // 不同类型用不同量词：文档「篇」、代码「个代码文件」、媒体「个媒体」、混排「项」。
      // ⚠️ 2026-10-09 用户要求：**屏幕上只留阿拉伯数字**（`9` / `3 / 79`）——
      //    量词本来就随档位变（同一位置换个档就换一种中文，读起来像两套东西）。
      //    整句降级成 `title`（悬停仍读得到「9 个代码文件」），i18n 键不闲置。
      const countKey = kind === KIND_CHANGES
        ? (filtering ? 'count.changes.filtered' : 'count.changes')
        : kind === KIND_MEDIA
          ? (filtering ? 'count.media.filtered' : 'count.media')
          : kind === KIND_CODE
            ? (filtering ? 'count.code.filtered' : 'count.code')
            : (filtering ? 'count.filtered' : 'count')
      const countTotal = kind === KIND_CHANGES ? changeView.filesTotal : state.total
      const countVisible = kind === KIND_CHANGES ? changeDocs.length : visibleDocs.length
      // 可见文本 = 纯数字；整句（含量词）只出现在 title 里。
      const countText = filtering
        ? `${countVisible} / ${countTotal}`
        : String(countTotal ?? 0)
      const countTitle = filtering
        ? t(countKey, { hit: countVisible, total: countTotal })
        : t(countKey, { n: countTotal })

      /* ── v0.21 检索状态摘要（需求 §6.3；2026-10-09 用户规格重排）──────────
         每一格都是**已经发生的事实**，不是估算：
         · 收集 = `total` + `skipped`（`total` 是排除**之后**的候选数，加回被排掉的那些
           才是扫描到的篇数 —— 面板头部的计数仍然只用 `total`，口径不变）；
         · 排除 = 这一批里真的被排掉几篇（宿主按候选集算的 `skipped`，不是 excluded 的长度：
           切到代码档时，被排除的那篇 Markdown 根本不在语料里，那时它没被排掉）；
         · 候选 = 排除之后进入检索的篇数（就是 `state.total`，原来是那个没有名字的光数字）；
         · BM25 词法检索 = 这一路是纯本地词法检索 + 排序（**零模型**，这句话本身就是产品承诺）；
         · 关系 N 条 = 这一份包里一共带了几条关系证据（三层各条 relations 之和）；
         · 固定 N = 有几篇被用户固定、因此**从三层移出**进了固定区（`pack.pinned` 的长度）；
         · 入包 N = 三层现有条目数（固定区不算 —— 它不在包里）。
         布局是**三组、单行、竖线分隔**：候选 ｜ 检索与调整 ｜ 入包。组内用中点。
         ⚠️ 没有箭头、没有图标、没有色块（需求 §三）：顺序与分组本身就是信息。
         ⚠️ 不显示任何分数 / 百分比 / 索引内部量（需求 §十二）。 */
      const pack = state.context || null
      const packCount = pack
        ? ['primary', 'supporting', 'related'].reduce((sum, key) => sum + (Array.isArray(pack[key]) ? pack[key].length : 0), 0)
        : 0
      const relCount = pack
        ? ['primary', 'supporting', 'related'].reduce((sum, key) => sum + (Array.isArray(pack[key])
          ? pack[key].reduce((n, item) => n + (Array.isArray(item.relations) ? item.relations.length : 0), 0) : 0), 0)
        : 0
      const skipped = Number(state.control && state.control.skipped) || 0
      const collected = state.total + skipped
      const pipeCell = (text, strong) => h('span', { className: `knit-pipecell${strong ? ' strong' : ''}` }, text)
      // 组内中点 / 组间竖线：都是文本节点，跟着同一行流排版（基线天然一致、换行不留孤线）。
      const pipeDot = () => h('span', { className: 'knit-pipedot', 'aria-hidden': 'true' }, '·')
      const pipeSep = () => h('span', { className: 'knit-pipesep', 'aria-hidden': 'true' }, '|')
      const pinnedCount = pack && Array.isArray(pack.pinned) ? pack.pinned.length : 0

      /* ── v0.23（Phase A）：从宿主回的 `semantic` 推出来的几个量 ─────────────
         `semLive` 只看**实际生效**的模式：`mode === 'hybrid'` 才算语义真的在跑；
         点了混合而宿主回 lexical（不可用 / 未配置 / 老宿主）⇒ 一律走「如实说明」这条。 */
      const semInfo = state.semantic || null
      const semOn = retrieval === 'hybrid'
      const semLive = !!(semInfo && semInfo.mode === 'hybrid')
      const semCandidateCount = semInfo ? Math.max(0, Number(semInfo.candidates) || 0) : 0
      const semProvider = semInfo && semInfo.provider ? semInfo.provider : null
      const semForm0 = semForm || (semProvider
        ? { kind: semProvider.kind, base: semProvider.base, model: semProvider.model }
        : { kind: 'ollama', base: '', model: '' })
      const semReasonText = semInfo
        ? t(semanticReasonKey(semInfo.reason))
        : t('sem.unsupported')

      /* v0.23（2026-10-11 用户裁决）：**检索模式贴在搜索框右端的小下拉里**，而且只在「相关」档出现。
         理由（都在代码里）：时间序没有 Context Pack 分层（宿主 `contextPayload()` 要求
         `sort === 'relevance'`），语义候选无处可落；宿主那侧也已按 `not-applicable` 整层短路。
         ⚠️ **不再看 provider 配没配**（本次放宽）：未配也出现 —— Knit 还没有设置页，
            藏起来用户就永远打不开这个功能；菜单里如实写状态，并就地给配置入口。
         ⚠️ **永远不做置灰禁用态**。 */
      const showRetrieval = sort === 'relevance' && kind !== KIND_CHANGES
      const semReason = semInfo && typeof semInfo.reason === 'string' ? semInfo.reason : null
      /** 菜单底部那行状态：如实说这一档现在到底生效成什么（不美化、不猜）。 */
      const semStateText = !semOn
        ? t('sem.state.lexical')
        : (semLive
          ? t('sem.state.hybridLive')
          : (semReason && semReason !== 'no-provider'
            ? t(semanticReasonKey(semReason))
            : t('sem.state.noProvider')))
      /** 「配置语义 provider…」入口只在「选了混合但没生效」时给 —— 其它状态下配置是无意义的动作。 */
      const semCanConfigure = semOn && !semLive
      /** Esc：关菜单并把焦点还给按钮（键盘可达性）。挂按钮与菜单两处，测试可断言。 */
      const closeRetMenuOnEscape = (event) => {
        if (!event || event.key !== 'Escape') return
        event.stopPropagation()
        setRetMenuOpen(false)
        focusFirst('.knit-retmode-btn')
      }

      /* 保存并测试：**一次 POST**（宿主会 probe 一次，并在响应里回 `available` / `reason`）。
         成功后把表单交还给宿主的回值（`setSemForm(null)`），再重取一次列表 ——
         配置区/事实行下一帧就按宿主的事实重画，不在客户端自己猜。 */
      const saveSemantic = async () => {
        if (semBusy) return
        setSemBusy(true)
        setSemNotice('')
        try {
          const res = await fetch(SEMANTIC_API, {
            method: 'POST',
            headers: { 'content-type': 'application/json', accept: 'application/json' },
            body: JSON.stringify({ kind: semForm0.kind, base: semForm0.base, model: semForm0.model }),
          })
          const data = await res.json().catch(() => null)
          if (data && data.ok) {
            setSemForm(null)
            setSemNotice(data.available ? t('sem.savedOk') : t('sem.savedFail'))
            await load()
          } else {
            setSemNotice(data ? hostMessage(data) : t('sem.savedFail'))
          }
        } catch (error) {
          setSemNotice(String((error && error.message) || error))
        } finally {
          setSemBusy(false)
        }
      }

      const semcfgNode = h('div', { className: 'knit-semcfg' },
        h('div', { className: 'knit-retseg', role: 'group', 'aria-label': t('sem.kindAria') },
          [['ollama', 'sem.kind.ollama'], ['openai-compatible', 'sem.kind.openai']].map(([value, labelKey]) =>
            h('button', {
              type: 'button',
              key: value,
              className: `knit-retseg-btn${semForm0.kind === value ? ' active' : ''}`,
              'aria-pressed': semForm0.kind === value,
              onClick: () => setSemForm({ ...semForm0, kind: value }),
            }, t(labelKey)))),
        h('input', {
          className: 'knit-semcfg-input',
          value: semForm0.base,
          placeholder: t('sem.basePlaceholder'),
          'aria-label': t('sem.baseAria'),
          onChange: (event) => setSemForm({ ...semForm0, base: event.target.value }),
        }),
        h('input', {
          className: 'knit-semcfg-input',
          value: semForm0.model,
          placeholder: t('sem.modelPlaceholder'),
          'aria-label': t('sem.modelAria'),
          onChange: (event) => setSemForm({ ...semForm0, model: event.target.value }),
        }),
        h('button', {
          type: 'button',
          className: 'knit-btn',
          disabled: semBusy,
          title: t('sem.saveTitle'),
          onClick: saveSemantic,
        }, semBusy ? t('sem.saving') : t('sem.save')),
        // 披露：只有回环地址才敢说「不离开这台机器」，其余一律明写会发到哪个服务（方案 §2）。
        h('span', { className: 'knit-semcfg-note' },
          !semForm0.base
            ? t('sem.disclose.empty')
            : (isLoopbackBase(semForm0.base)
              ? t('sem.disclose.local')
              : t('sem.disclose.remote', { base: semForm0.base }))))
      /* v0.24（2026-10-12 用户裁决 + Demo 参考）：检索方式不再是工具栏里的下拉，
         而是状态行里一个**可点的状态格**（`BM25 词法检索 ›`）—— 虚线下划线 + 小箭头提示可点。
         菜单**相对这一格定位**（`.knit-retmenu{left:0;top:22px}`），内容与行为逐字沿用原来的：
         两个选项（menuitemradio / aria-checked）+ 现状说明 + 「不可用时就地配置」入口。
         ⚠️ 这一格说的是**实际生效**的模式（`semLive`）：点了混合但不可用时，宿主回的是 lexical，
            所以它仍然显示「BM25 词法检索」—— 不许把它写成「用户点了什么」。 */
      const pipeMethodNode = h('div', { className: 'knit-pipe-method-wrap' },
        h('button', {
          type: 'button',
          className: 'knit-pipe-method',
          'aria-haspopup': 'true',
          'aria-expanded': retMenuOpen,
          // 悬停给**整句话**（长键在这里被用上；菜单里则是逐选项的副文案）
          title: t(retrieval === 'hybrid' ? 'sem.mode.hybridTitle' : 'sem.mode.lexicalTitle'),
          onClick: () => setRetMenuOpen((value) => !value),
          onKeyDown: closeRetMenuOnEscape,
        },
        // 文字单独一层：悬停的下划线只划它，不划右边那个箭头（见 CSS 注释）。
        h('span', { className: 'knit-pipe-method-label' }, t(semLive ? 'pipe.rankHybrid' : 'pipe.rank')),
        // 箭头是**装饰**（对读屏隐藏），可访问名由上面的 title 承担。
        // 字形复用「最近读取」行最右端那个 `›`，CSS 旋转 90° 朝下、展开时转回朝上。
        h('span', { className: 'knit-pipe-method-go', 'aria-hidden': 'true' }, '›')),
        retMenuOpen ? h('div', {
          className: 'knit-retmenu',
          role: 'menu',
          'aria-label': t('sem.mode.aria'),
          onKeyDown: closeRetMenuOnEscape,
        },
        [['lexical', 'sem.mode.lexicalOption', 'sem.mode.lexicalDesc'],
          ['hybrid', 'sem.mode.hybridOption', 'sem.mode.hybridDesc']].map(([value, labelKey, descKey]) =>
          h('button', {
            type: 'button',
            key: value,
            role: 'menuitemradio',
            'aria-checked': retrieval === value,
            className: `knit-retmenu-item${retrieval === value ? ' active' : ''}`,
            onClick: () => { pickRetrieval(value); setRetMenuOpen(false) },
          },
          h('strong', null, t(labelKey)),
          h('span', null, t(descKey)))),
        // 状态行：如实写这一档现在到底生效成什么（判据 5 的界面面）
        h('div', { className: 'knit-retmenu-note' }, semStateText),
        // 就地配置入口：只在「选了混合且没生效」时给；点开的是那行最小配置区
        semCanConfigure ? h('button', {
          type: 'button',
          className: 'knit-retmenu-cfg',
          onClick: () => { setRetMenuOpen(false); setSemCfgOpen((value) => !value) },
        }, t(semCfgOpen ? 'sem.cfg.hide' : 'sem.cfg.show')) : null) : null)
      /* v0.25：Git 变更关联那一格（见上面 CSS 的说明）。三种话术，都由**宿主的事实**决定：
         关着 / 开着且有数 / 开着但读不到（写原因）。读完就关也不会留下悬念。 */
      /* v0.25（第二轮修订）：这一格的数字来自**独立接口**的那份载荷，不再来自 Context Pack。
         v0.25 收尾：**三种状态必须互相可辨**（这是原来那版最实的一个缺口 ——
         请求失败时那一格显示成「关着」的样子，用户会把「读不到」读成「没有变更」）：
           · 关着            → 归一成 `null`  → 「变更」
           · 开着但读不到     → `failed` / `git.available === false` → 「变更 —」+ 悬停写原因
           · 开着且读到了     → `git.available === true` → 「变更 N」（N = 变更文件数）
         ⚠️ 「有变更但没有关联」与「有变更且有关联」在状态行上是同一个 `变更 N` ——
         它们的区别在**列表里那一区的提示句**（见 `contextView`），不在这一格。 */
      const changeStatus = changeStatusOf(changesData)
      const changeInfo = changeStatus.read ? { ...changeStatus, relatedTotal: Number(changesData.linksTotal) || 0 } : null
      const changeFiles = changeInfo && Number.isFinite(changeInfo.filesTotal) ? changeInfo.filesTotal : 0
      const changesLabel = !changesOn
        ? t('pipe.changesOff')
        : (!changeStatus.read
          ? t('pipe.changesUnavailable')
          : t('pipe.changesOn', { n: changeFiles }))
      const changesTitle = !changesOn
        ? t('changes.titleOff')
        : (!changeStatus.read
          ? t('changes.titleUnavailable', { reason: t(changeReasonKey(changeStatus.reason)) })
          : t('changes.titleOn', {
            files: changeFiles,
            related: changeInfo ? (Number(changeInfo.relatedTotal) || 0) : 0,
          }))
      const changesNode = h('button', {
        type: 'button',
        className: 'knit-pipe-changes',
        'aria-pressed': changesOn ? 'true' : 'false',
        title: changesTitle,
        onClick: (event) => {
          if (event && typeof event.stopPropagation === 'function') event.stopPropagation()
          pickChanges(!changesOn)
        },
      }, h('span', { className: 'knit-pipe-changes-label' }, changesLabel))
      const pipeNode = h('div', { className: 'knit-pipe' },
        pipeCell(t('pipe.collect', { n: collected })),
        pipeDot(),
        pipeCell(t('pipe.exclude', { n: skipped })),
        pipeDot(),
        pipeCell(t('pipe.candidates', { n: state.total })),
        pipeSep(),
        // 这一格说的是**实际生效**的模式（`semantic.mode`），不是你点了什么：
        // 点了混合但不可用时，宿主回的是 lexical，这里就必须还写「BM25 词法检索」。
        pipeMethodNode,
        ...(semLive ? [pipeDot(), pipeCell(t('pipe.semantic', { n: semCandidateCount }))] : []),
        pipeDot(),
        pipeCell(t('pipe.relations', { n: relCount })),
        pipeDot(),
        pipeCell(t('pipe.pin', { n: pinnedCount })),
        pipeDot(),
        // v0.25：入口就是这一格 —— **默认关**，关着也出现（藏起来用户就永远打不开）。
        // 它说的是宿主回的**事实**（几个变更文件 / 读不到的原因），不是「你点了什么」。
        changesNode,
        pipeSep(),
        // 唯一略微加重的一格：它是这一行里被后续阶段消费的那个数字（需求 §三.8：
        // 只提字重，不用品牌色、不做徽章）。
        pipeCell(t('pipe.pack', { n: packCount }), true))
      // 排除说明只列**还能找回来**的那些：宿主保留了记录（用户排除过就是排除过），
      // 但文件已经删掉的不该给一个按下去什么都不会发生的「恢复」（需求 §6.4）。
      // ⚠️ 判据是宿主给的 `exists`，**不能**拿 `state.docs` 去反查 ——
      // 被排除的那一篇恰恰不在 `docs` 里（那正是「排除」的意思），反查恒为空。
      const excludedList = (state.control && Array.isArray(state.control.excluded))
        ? state.control.excluded.filter((item) => item.exists)
        : []

      /* ── v0.25：预览里的查找（Cmd+F）──────────────────────────────────────
         ⚠️ **这一整块必须留在组件末尾** —— 测试替身按**下标**预置 useState/useRef 的初值
         （`harness.seed`），而只有 useState/useRef 占槽位。插在中间会把后面每一个槽位
         整体挪位，`seeded[15]` 那条就直接落到别的状态上（上一轮 `changesOn` 已经踩过一次，
         这次的 `query.trim is not a function` 是第二次）。新钩子一律**追加在最后**。

      /* ── v0.25：预览里的查找（Cmd+F）──────────────────────────────────────
         状态放在**这一层**而不是 PreviewPanel：快捷键挂在面板根上（见
         `onRootKeyDownCapture`）—— 焦点通常在左边那个列表上（↑↓ 开着预览），
         挂在 `.knit-preview` 上根本收不到那个事件。
         `findSeq` 只在**显式导航**时 +1（打开 / 输入 / 上一下一个），它是「要不要滚」的唯一开关：
         5 秒轮询会重画命中，**但绝不滚动** —— 否则用户读到一半每 5 秒被拽回去一次
         （AGENTS.md §6.13 ② 那个「列表自己跳」的坑，同一个道理）。 */
      const [findOn, setFindOn] = React.useState(false)
      const [findQuery, setFindQuery] = React.useState('')
      const [findIndex, setFindIndex] = React.useState(0)
      const [findSeq, setFindSeq] = React.useState(0)
      const [findCount, setFindCount] = React.useState(0)
      const findMarksRef = React.useRef([])
      const findInputRef = React.useRef(null)
      const previewBodyRef = React.useRef(null)

      /* 关掉预览就关掉查找（否则下次打开会带着上一次的关键词与一树残留标记）。 */
      React.useEffect(() => {
        if (preview) return
        setFindOn(false)
        setFindQuery('')
      }, [preview])

      /* 画命中 —— 开关 / 关键词 / 这一篇的内容，任一变了就重画。
         ⚠️ 依赖里没有轮询刷出来的数组；`preview` 换了一篇或文件被改过就重画一次，
         但**不滚** —— 滚动只由 `findSeq` 那条 effect 负责。 */
      React.useLayoutEffect(() => {
        const box = previewBodyRef.current
        clearFindMarks(box)
        findMarksRef.current = []
        if (!box || !findOn || !findQuery) {
          setFindCount(0)
          return
        }
        const marks = paintFindMarks(box, findQuery)
        findMarksRef.current = marks
        setFindCount(marks.length)
      }, [findOn, findQuery, preview && preview.rel, preview && preview.text])

      /* 标出「当前这一条」并滚到它。
         ⚠️ **只依赖 `findSeq`**（显式导航才 +1）、命中数组走 ref 读：把重画当成「用户动了光标」，
         就会每 5 秒把用户读到一半的视图拽回去一次（§6.13 ② 那条坑，同一个道理）。 */
      React.useLayoutEffect(() => {
        const marks = findMarksRef.current
        if (!findOn || !marks.length) return
        const index = Math.min(Math.max(0, findIndex), marks.length - 1)
        markFindCurrent(marks, index)
        scrollMarkIntoView(marks[index])
      }, [findSeq])

      /* 打开后把焦点交给输入框（挂上去之后再 focus）。 */
      React.useLayoutEffect(() => {
        if (!findOn) return
        const input = findInputRef.current
        if (input && typeof input.focus === 'function') input.focus()
      }, [findOn])

      /**
       * 打开查找条并把焦点给它。
       *
       * 两条入口都用它：**Cmd+F**（焦点在面板里时），以及预览头那个**「查找」按钮** ——
       * 后者是兜底：外层应用的原生快捷键在按键进入网页之前就被它自己处理了，网页侧抢不回来。
       * 已经开着时 `findOn` 不变、聚焦那条 effect 不会再跑，所以这里就地补一次 focus。
       */
      const openFind = React.useCallback(() => {
        setFindOn(true)
        const input = findInputRef.current
        if (input && typeof input.focus === 'function') input.focus()
      }, [])

      /** 关掉查找条（不清正文内容，也不动预览）。 */
      const closeFind = React.useCallback(() => {
        setFindOn(false)
        setFindQuery('')
      }, [])

      /** 上一个 / 下一个（环绕）。 */
      const findStep = React.useCallback((delta) => {
        const total = findMarksRef.current.length
        if (!total) return
        setFindIndex((current) => stepFindIndex(current, total, delta))
        setFindSeq((n) => n + 1)
      }, [])

      /** 改关键词：回到第一条命中并滚过去（与 Chrome 一致）。 */
      const onFindQuery = React.useCallback((value) => {
        setFindQuery(value)
        setFindIndex(0)
        setFindSeq((n) => n + 1)
      }, [])

      /**
       * 面板根上的**捕获阶段**键盘处理。
       *
       * 为什么是「这一层」：焦点通常在左边那个列表上（↑↓ 打开预览），把快捷键挂在
       * `.knit-preview` 上收不到那个事件（事件从列表冒泡，不经过预览）。
       * 为什么是「捕获」：列表自己有 Esc（关预览 / 退全屏），而查找开着时 Esc 的语义
       * 应当是**先关查找条** —— 捕获先于子节点执行，这里 stopPropagation 就把它拦下了。
       *
       * 只拦两件事（Cmd/Ctrl+F、查找开着时的 Esc），其余一律放行：不抢输入框、不抢列表方向键。
       */
      const onRootKeyDownCapture = React.useCallback((event) => {
        if (!event) return
        // ⚠️ 查看器是**最上层**：它开着时 Esc / ← / → 先归它（不许漏到列表的键盘导航上）
        if (lightboxRel) {
          // 评论输入框里的 Escape / 方向键属于「取消编辑 / 移光标」，不许被查看器抢走
          // （这里在捕获阶段，输入框自己的 onKeyDown 还没跑）。判定只看 DOM 归属。
          if (commentEditorTarget(event)) return
          if (event.key === 'Escape') {
            event.preventDefault(); event.stopPropagation(); lightboxClose(); return
          }
          /* 左列是**竖排**的，所以 ↑↓ 必须能用（用户 2026-10-22 追加要求）；
             ←→ 一并留着 —— 有人就是习惯左右翻，两条路没有冲突。 */
          if (event.key === 'ArrowRight' || event.key === 'ArrowLeft'
            || event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault(); event.stopPropagation()
            const back = event.key === 'ArrowLeft' || event.key === 'ArrowUp'
            lightboxStep(back ? -1 : 1)
            return
          }
        }
        const mod = !!(event.metaKey || event.ctrlKey)
        if (mod && !event.altKey && String(event.key || '').toLowerCase() === 'f') {
          // 媒体档没有可搜的正文 ⇒ 不拦，交回宿主 / 浏览器自己的行为
          if (!preview || preview.kind === 'image' || preview.kind === 'video') return
          event.preventDefault()
          event.stopPropagation()
          openFind()
          return
        }
        if (event.key === 'Escape' && findOn) {
          event.preventDefault()
          event.stopPropagation()
          setFindOn(false)
          setFindQuery('')
        }
      }, [preview, findOn, openFind, lightboxRel, lightboxClose, lightboxStep])

      /* ── v0.25：媒体档「悬停看大图」（同样**追加在末尾**：替身按下标 seed useState/useRef）
         只对图片；停 HOVER_SHOT_DELAY_MS 才出现；离开 / 滚动 / 换档立刻收。 */
      const [hoverShot, setHoverShot] = React.useState(null)
      const hoverTimerRef = React.useRef(0)
      const hoverHideRef = React.useRef(0)
      const hoverStart = React.useCallback((doc, src, event) => {
        if (!doc || doc.kind !== 'image' || !src) return
        if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current)
        // 矩形从事件里取（真机有 currentTarget）；取不到就交给纯函数走「视口居中」那条路
        let rect = null
        try {
          const el = event && event.currentTarget
          if (el && typeof el.getBoundingClientRect === 'function') rect = el.getBoundingClientRect()
        } catch { rect = null }
        const view = {
          width: typeof window !== 'undefined' && Number.isFinite(window.innerWidth) ? window.innerWidth : 1024,
          height: typeof window !== 'undefined' && Number.isFinite(window.innerHeight) ? window.innerHeight : 768,
        }
        const box = hoverShotBox(rect, view)
        hoverTimerRef.current = setTimeout(() => {
          hoverTimerRef.current = 0
          setHoverShot({ rel: doc.rel, src, box, doc })
        }, HOVER_SHOT_DELAY_MS)
      }, [])
      /** 离开卡片：**延迟**收起，给「鼠标挪进浮窗点评论」留出通路。 */
      const hoverEnd = React.useCallback(() => {
        if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current)
        hoverTimerRef.current = 0
        if (hoverHideRef.current) clearTimeout(hoverHideRef.current)
        hoverHideRef.current = setTimeout(() => {
          hoverHideRef.current = 0
          setHoverShot((prev) => (prev ? null : prev))
        }, HOVER_SHOT_HIDE_MS)
      }, [])
      /** 鼠标已经进到浮窗上：取消收起。 */
      const hoverKeep = React.useCallback(() => {
        if (hoverHideRef.current) clearTimeout(hoverHideRef.current)
        hoverHideRef.current = 0
      }, [])
      /** 立刻收（滚动 / 打开画布 / 卸载）。 */
      const hoverClose = React.useCallback(() => {
        if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current)
        if (hoverHideRef.current) clearTimeout(hoverHideRef.current)
        hoverTimerRef.current = 0
        hoverHideRef.current = 0
        setHoverShot((prev) => (prev ? null : prev))
      }, [])
      React.useEffect(() => () => {
        if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current)
        if (hoverHideRef.current) clearTimeout(hoverHideRef.current)
      }, [])

      /* ── v0.26：图内评论（**追加在末尾**：替身按下标 seed useState / useRef）
         commentsByAnchor 按身份锚定（工作区图 = rel；对话图 = 附件 sha256 id）。
         P0 只活在内存里：退出查看器仍在、硬刷新丢 —— **不写 localStorage**（有守卫）。
         落点由 commentClickPct 从图片**绘制矩形**算；渲染层用同一份
         contentViewportOf(img)，再换算成**相对画布表面**的坐标（整屏查看器 / 面板画布共用一套），
         **落点与画点同一个矩形**。窗口缩放 / 面板宽度变化 / 滚动都会重算（下一个 effect）。 */
      const [commentOn, setCommentOn] = React.useState(false)
      const [commentsByAnchor, setCommentsByAnchor] = React.useState({})
      const [commentDraft, setCommentDraft] = React.useState(null)
      const [commentBox, setCommentBox] = React.useState(null)
      const [commentSurface, setCommentSurface] = React.useState(null)
      const [commentStatus, setCommentStatus] = React.useState('')
      const commentStageRef = React.useRef(null)
      const commentImgRef = React.useRef(null)

      /* v0.28：媒体首屏分批（新 hook 只能往末尾追加：前面被测试按位预置）。
         `mediaShown` = 当前挂载上限；0 = 还没算过，用首屏批量的推导值。 */
      const [mediaShown, setMediaShown] = React.useState(0)
      const mediaSentinelRef = React.useRef(null)

      /**
       * 媒体档「当前该挂载的那一份」。**函数**：调用时 `mediaShown` / `mediaDocs` 都已就绪。
       * 首屏批量按列数估（三行），`mediaShown` > 0 之后就是用户已经滚出来的量。
       */
      const mediaVisibleDocs = () => {
        const all = mediaDocs
        const first = mediaFirstBatch(mediaLayout.columns)
        const cap = mediaShown > 0 ? Math.min(all.length, mediaShown) : Math.min(all.length, first)
        return cap >= all.length ? all : all.slice(0, cap)
      }

      /* v0.28：查看器的「保存到本地」——
         · 右键：自己画一个只有一项的菜单（浏览器原生菜单在桌面壳里不可靠，且没有「保存」语义）；
         · 拖拽：把图拖到桌面 / 文件夹，`DownloadURL` 让系统按一次下载处理。
         两条都**只读同源字节**，不新增路由、不落任何服务端状态。 */
      const [shotMenu, setShotMenu] = React.useState(null)

      const openShotMenu = React.useCallback((event) => {
        if (!lightboxDoc) return
        if (!event) return
        if (event.preventDefault) event.preventDefault()
        if (event.stopPropagation) event.stopPropagation()
        const x = Number(event.clientX) || 0
        const y = Number(event.clientY) || 0
        setShotMenu({ x, y })
      }, [lightboxDoc])

      const closeShotMenu = React.useCallback(() => setShotMenu(null), [])

      /** 右键菜单：把当前这张图取字节落盘（不依赖浏览器原生「图片另存为」）。 */
      const saveLightboxImage = React.useCallback(async () => {
        setShotMenu(null)
        if (!lightboxDoc) return
        const name = downloadNameOf(lightboxDoc)
        try {
          const res = await fetch(srcFor(lightboxDoc), { credentials: 'same-origin' })
          if (!res || res.ok === false) throw new Error('fetch')
          const blob = await res.blob()
          const url = URL.createObjectURL(blob)
          const a = document.createElement('a')
          a.href = url
          a.download = name
          document.body.appendChild(a)
          a.click()
          a.remove()
          setTimeout(() => { try { URL.revokeObjectURL(url) } catch { /* 忽略 */ } }, 10000)
        } catch {
          setNotice(t('lightbox.saveFailed'))
        }
      }, [lightboxDoc, srcFor, setNotice, t])

      /** 拖拽：把 `DownloadURL` 写进 dataTransfer，系统会按文件名与 MIME 落盘。 */
      const onLightboxDragStart = React.useCallback((event) => {
        if (!lightboxDoc || !event) return
        const dt = event.dataTransfer
        if (!dt) return
        const name = downloadNameOf(lightboxDoc)
        const src = srcFor(lightboxDoc)
        try {
          dt.effectAllowed = 'copy'
          dt.setData('DownloadURL', downloadUrlFor(src, name, typeof window !== 'undefined' ? window.location && window.location.origin : ''))
          const abs = /^https?:/i.test(src) ? src : `${(typeof window !== 'undefined' && window.location && window.location.origin) || ''}${src}`
          dt.setData('text/uri-list', abs)
        } catch { /* 某些宿主禁止写自定义类型：不影响右键保存 */ }
      }, [lightboxDoc, srcFor])
      const commentAnchor = lightboxDoc ? anchorIdFor(lightboxDoc) : ''
      const commentList = commentsFor(commentsByAnchor, commentAnchor)

      /** 量一次：内容框相对**画布表面**（`.knit-lightbox` 根）的盒子 + 表面尺寸。 */
      const measureCommentBox = React.useCallback(() => {
        const img = commentImgRef.current
        const surface = lightboxRef.current
        if (!img || !surface || typeof surface.getBoundingClientRect !== 'function') return
        const rect = contentViewportOf(img)
        if (!rect) return
        const srect = surface.getBoundingClientRect()
        setCommentBox({
          left: rect.left - srect.left,
          top: rect.top - srect.top,
          width: rect.width,
          height: rect.height,
        })
        setCommentSurface({ width: srect.width, height: srect.height })
      }, [])

      // 换图 / 关闭：丢掉半截草稿与提示；关掉查看器时连评论模式一起退出。
      React.useEffect(() => {
        setCommentDraft(null)
        setCommentStatus('')
        if (!lightboxRel) {
          setCommentOn(false)
          setLightboxDock(false)
          setCommentBox(null)
          setCommentSurface(null)
        }
      }, [lightboxRel])

      // 窗口缩放 / 面板宽度变化 / 滚动：**重新量**（一次算完就不管 = pin 必跑位）。
      React.useEffect(() => {
        if (!lightboxRel) return undefined
        measureCommentBox()
        let observer = null
        try {
          if (typeof ResizeObserver !== 'undefined') {
            observer = new ResizeObserver(measureCommentBox)
            if (lightboxRef.current) observer.observe(lightboxRef.current)
            if (commentImgRef.current) observer.observe(commentImgRef.current)
          }
        } catch { observer = null }
        const win = typeof window === 'undefined' ? null : window
        if (win && typeof win.addEventListener === 'function') {
          win.addEventListener('resize', measureCommentBox)
          win.addEventListener('scroll', measureCommentBox, true)
        }
        return () => {
          if (observer && typeof observer.disconnect === 'function') observer.disconnect()
          if (win && typeof win.removeEventListener === 'function') {
            win.removeEventListener('resize', measureCommentBox)
            win.removeEventListener('scroll', measureCommentBox, true)
          }
        }
      }, [lightboxRel, lightboxDock, measureCommentBox])

      const toggleCommentMode = React.useCallback((event) => {
        if (event && event.stopPropagation) event.stopPropagation()
        setCommentDraft(null)
        setCommentStatus('')
        setCommentOn((current) => !current)
      }, [])

      /** 评论模式里点图片：落点 → 百分比 → 就地开一个空草稿。 */
      const onCommentStageClick = React.useCallback((event) => {
        if (!commentOn || !lightboxDoc) return
        if (event && event.stopPropagation) event.stopPropagation()
        if (commentList.length >= COMMENT_MAX) {
          setCommentStatus('lightbox.comment.full')
          return
        }
        const stage = commentStageRef.current || (event && event.currentTarget)
        const img = commentImgRef.current
          || (stage && typeof stage.querySelector === 'function' ? stage.querySelector('.knit-lightbox-img') : null)
        const pct = commentClickPct(event, img)
        if (!pct) return
        setCommentStatus('')
        setCommentDraft({
          anchor: commentAnchor,
          n: nextNumber(commentList),
          xPct: pct.xPct,
          yPct: pct.yPct,
          text: '',
          isNew: true,
        })
      }, [commentOn, lightboxDoc, commentAnchor, commentList])

      /** 点已有 pin / 评论栏里那一行 → 就地重编辑。 */
      const openCommentEditor = React.useCallback((event, comment) => {
        if (event && event.stopPropagation) event.stopPropagation()
        if (!comment) return
        setCommentStatus('')
        setCommentDraft({
          anchor: commentAnchor,
          n: comment.n,
          xPct: comment.xPct,
          yPct: comment.yPct,
          text: comment.text,
          isNew: false,
        })
      }, [commentAnchor])

      /** Enter / 保存：空文本不落；超 200 字**不截断**，提示后留在编辑态。 */
      const saveComment = React.useCallback(() => {
        const draft = commentDraft
        if (!draft) return
        const text = String(draft.text || '')
        if (!text.trim()) { setCommentDraft(null); setCommentStatus(''); return }
        if (text.length > COMMENT_MAX_CHARS) { setCommentStatus('lightbox.comment.tooLong'); return }
        const current = commentsFor(commentsByAnchor, draft.anchor)
        const next = draft.isNew
          ? normalizeComments(current.concat([{ n: draft.n, xPct: draft.xPct, yPct: draft.yPct, text }]))
          : normalizeComments(current.map((item) => (item.n === draft.n ? { ...item, text } : item)))
        setCommentsByAnchor(withComments(commentsByAnchor, draft.anchor, next))
        setCommentDraft(null)
        setCommentStatus('')
      }, [commentDraft, commentsByAnchor])

      const deleteComment = React.useCallback((n) => {
        const anchor = commentDraft ? commentDraft.anchor : commentAnchor
        const current = commentsFor(commentsByAnchor, anchor)
        setCommentsByAnchor(withComments(commentsByAnchor, anchor, current.filter((item) => item.n !== n)))
        setCommentDraft((draft) => (draft && draft.n === n ? null : draft))
      }, [commentDraft, commentAnchor, commentsByAnchor])

      /** 发送 = 只**投递**（§四 文本），绝不自动发送。 */
      const sendComments = React.useCallback(async () => {
        if (!lightboxDoc) return
        const list = commentsFor(commentsByAnchor, anchorIdFor(lightboxDoc))
        if (!list.length) return
        /* 文本身份：工作区图用 **rel**（比文件名唯一，agent 能直接定位）；对话图没有路径，
           用文件名 + 附件 sha。图片本身作为附件随 paste 一起进输入框（不再是「只发文字」）。 */
        const label = lightboxDoc.conversation
          ? (lightboxDoc.name || 'image')
          : lightboxDoc.rel
        /* 附件序号就是图像序号：输入框里已经有 N 张附件 ⇒ 这一张是「图像 N+1」。 */
        const composer = composerState(typeof document === 'undefined' ? null : document)
        const text = commentLines(list, {
          rel: label,
          sha: shaOfDoc(lightboxDoc),
          index: composer.count + 1,
        }).join('\n')
        const result = await deliverCommentText(text, {
          attachment: {
            src: srcFor(lightboxDoc),
            name: lightboxDoc.name || String(lightboxDoc.rel).split('/').pop() || 'knit-image.png',
          },
        })
        setCommentStatus(!result.ok
          ? 'lightbox.comment.sendFailed'
          : result.via === 'clipboard'
            ? 'lightbox.comment.copied'
            : result.via === 'download'
              ? 'lightbox.comment.downloaded'
              : result.image
                ? 'lightbox.comment.sent'
                : 'lightbox.comment.sentNoImage')
      }, [lightboxDoc, commentsByAnchor])

      const cancelCommentDraft = React.useCallback(() => {
        setCommentDraft(null)
        setCommentStatus('')
      }, [])

      const commentStatusText = commentStatus
        ? t(commentStatus, { max: commentStatus === 'lightbox.comment.full' ? COMMENT_MAX : COMMENT_MAX_CHARS })
        : ''

      /* 编辑气泡落点：优先贴着 pin（**相对画布表面**的坐标）；量不到尺寸就回退表面中心
         —— 气泡本身仍然由 commentPopoverBox 夹进表面，不会跑到外面（整屏与面板画布共用）。 */
      const commentView = {
        width: commentSurface && Number.isFinite(commentSurface.width) ? commentSurface.width : (
          typeof window !== 'undefined' && Number.isFinite(window.innerWidth) ? window.innerWidth : 1024),
        height: commentSurface && Number.isFinite(commentSurface.height) ? commentSurface.height : (
          typeof window !== 'undefined' && Number.isFinite(window.innerHeight) ? window.innerHeight : 768),
      }
      const commentAnchorPoint = commentDraft && commentBox
        ? {
            x: commentBox.left + (commentBox.width * commentDraft.xPct) / 100,
            y: commentBox.top + (commentBox.height * commentDraft.yPct) / 100,
          }
        : null
      const commentEditorBox = commentDraft
        ? commentPopoverBox(commentAnchorPoint, { width: COMMENT_POP_W, height: COMMENT_POP_H }, commentView)
        : null

      /* v0.26.x「变更」档：独立的只读状态读取（不混进列表轮询）。
         · 只在**变更档且面板可见**时请求；切走 / 收起来就停（和列表同一条「看不见不花钱」纪律）；
         · 载荷放 `state.changesStatus`，`load()` 轮询时原样带过去；
         · 失败有独立形状（`{failed,reason}`），不会把「读不到」显示成「没有改动」。 */
      React.useEffect(() => {
        if (visible === false || kind !== KIND_CHANGES) return undefined
        let alive = true
        let timer = null
        const run = async () => {
          if (!sessionId) return
          try {
            const res = await fetch(`${STATUS_API}?sessionId=${encodeURIComponent(sessionId)}`, {
              headers: { accept: 'application/json' }, cache: 'no-store',
            })
            const data = await res.json()
            if (!alive) return
            const next = data && data.ok ? data : { failed: true, reason: 'request' }
            const sig = JSON.stringify(next)
            setState((prev) => {
              if (prev.changesStatus && prev.changesStatus.sig === sig) return prev
              return { ...prev, changesStatus: { ...next, sig } }
            })
          } catch {
            if (!alive) return
            const next = { failed: true, reason: 'request' }
            const sig = JSON.stringify(next)
            setState((prev) => (prev.changesStatus && prev.changesStatus.sig === sig
              ? prev : { ...prev, changesStatus: { ...next, sig } }))
          }
        }
        const loop = async () => { await run(); if (alive) timer = setTimeout(loop, POLL_MS) }
        loop()
        return () => { alive = false; if (timer) clearTimeout(timer) }
      }, [visible, kind, sessionId])

      /* v0.26 返工：画布内容只渲染一次，但有两种挂载点 ——
         · `lightboxDock` = Knit 面板里的画布（会话不盖住、身份清楚）
         · 否则 = 原来的整屏查看器（portal 到 body）
         两者共用同一份 DOM / 同一套评论状态，切换不丢。 */
      const lightboxContent = lightboxDoc
        ? h('div', {
            className: `knit-lightbox${lightboxDock ? ' docked' : ''}`,
            role: 'dialog',
            'aria-modal': lightboxDock ? 'false' : 'true',
            'aria-label': t('lightbox.aria', { name: lightboxDoc.name || lightboxDoc.rel }),
            tabIndex: 0,
            ref: lightboxRef,
            /* 菜单开着时，点空白只收菜单 —— 不然「想关菜单」会连查看器一起关掉。 */
            onClick: () => { if (shotMenu) { setShotMenu(null); return } lightboxClose() },
            /* v0.28：**不再用滚轮翻页**（用户 2026-11-20：一次滑动会连翻好几张，
               而且和图片自身的滚动混在一起）。翻页只走显式的上一张 / 下一张按钮、左列缩略图、方向键。 */
          },
            lightboxDock
              ? h('div', { className: 'knit-lightbox-dockhead' },
                  h('span', { className: 'knit-lightbox-dockname', title: lightboxDoc.rel },
                    lightboxDoc.name || lightboxDoc.rel),
                  h('span', { className: 'knit-lightbox-dockctx', title: lightboxDoc.rel },
                    lightboxDoc.conversation
                      ? t('attach.title')
                      : (String(lightboxDoc.rel).includes('/')
                        ? String(lightboxDoc.rel).slice(0, String(lightboxDoc.rel).lastIndexOf('/') + 1)
                        : '')),
                  mediaDocs.length > 1
                    ? h('span', { className: 'knit-lightbox-dockcount' }, `${lightboxIndex + 1}/${mediaDocs.length}`)
                    : null)
              : h('div', {
              className: 'knit-lightbox-rail',
              ref: lightboxRailRef,
              onClick: (event) => { if (event && event.stopPropagation) event.stopPropagation() },
            }, lightboxRailView.items.map((doc, i) => h('button', {
              key: doc.rel,
              type: 'button',
              className: `knit-lightbox-thumb${doc.rel === lightboxDoc.rel ? ' active' : ''}`,
              title: doc.name || doc.rel,
              'data-thumb-index': lightboxRailView.start + i,
              onClick: () => setLightboxRel(doc.rel),
            }, h('img', { src: srcFor(doc), alt: '', draggable: false })))),
            /* v0.28：右键菜单（保存到本地）。坐标夹在视口内，避免贴边被裁。 */
            shotMenu
              ? (() => {
                  const vw = typeof window !== 'undefined' && Number.isFinite(window.innerWidth) ? window.innerWidth : 1024
                  const vh = typeof window !== 'undefined' && Number.isFinite(window.innerHeight) ? window.innerHeight : 768
                  const left = Math.max(8, Math.min(shotMenu.x, vw - 170))
                  const top = Math.max(8, Math.min(shotMenu.y, vh - 52))
                  return h('div', {
                    className: 'knit-lightbox-menu',
                    role: 'menu',
                    style: { left: `${left}px`, top: `${top}px` },
                    onClick: (event) => { if (event && event.stopPropagation) event.stopPropagation() },
                    onContextMenu: (event) => { if (event && event.preventDefault) event.preventDefault() },
                  }, h('button', {
                    className: 'knit-lightbox-menu-item',
                    type: 'button',
                    role: 'menuitem',
                    'data-knit-save-local': '1',
                    onClick: saveLightboxImage,
                  }, t('lightbox.saveLocal')))
                })()
              : null,
            /* 查看器工具条：「收藏」「本地打开」原来只活在**被撤掉的**媒体预览头里 ——
               不搬过来就等于静默丢掉两个功能（用户 2026-10-21 明确要过「收藏排第一」）。
               收藏只对工作区文件有意义（对话里的图还没有路径），所以对话图不显示这一条。 */
            h('div', { className: 'knit-lightbox-tools' },
              /* 面板画布只留评论相关动作（评论 / 全屏 / 返回）—— 面板窄，塞五个按钮会跟标题打架；
                 收藏 / 本地打开在整屏里仍然有，图标与入口一个没丢。 */
              lightboxDock || lightboxDoc.conversation
                ? null
                : h('button', {
                    className: 'knit-btn',
                    type: 'button',
                    onClick: () => toggleFavorite(lightboxDoc.rel),
                    title: favoriteSet.has(lightboxDoc.rel) ? t('fav.removeTitle') : t('fav.addTitle'),
                  }, favoriteSet.has(lightboxDoc.rel) ? t('fav.on') : t('fav.off')),
              lightboxDock || lightboxDoc.conversation
                ? null
                : h('button', {
                    className: 'knit-btn',
                    type: 'button',
                    onClick: lightboxOpenLocal,
                    title: t('preview.openLocal', { path: lightboxDoc.rel }),
                  }, t('preview.openLocalBtn')),
              /* v0.26 评论模式：二态入口。点它只切模式，不许冒泡去关查看器。 */
              h('button', {
                className: `knit-btn${commentOn ? ' active' : ''}`,
                type: 'button',
                title: t('lightbox.comment.title'),
                'aria-pressed': commentOn ? 'true' : 'false',
                'data-knit-comment-toggle': '1',
                onClick: toggleCommentMode,
              }, commentOn ? t('lightbox.comment.exit') : t('lightbox.comment.enter')),
              /* 画布 / 整屏互相切换：评论在面板画布里做，看细节再进整屏 */
              lightboxDock
                ? h('button', {
                    className: 'knit-btn knit-lightbox-nav',
                    type: 'button',
                    title: t('lightbox.canvas.prev'),
                    'aria-label': t('lightbox.canvas.prev'),
                    'data-knit-canvas-prev': '1',
                    onClick: (event) => {
                      if (event && event.stopPropagation) event.stopPropagation()
                      lightboxStep(-1)
                    },
                  }, '‹')
                : null,
              lightboxDock
                ? h('button', {
                    className: 'knit-btn knit-lightbox-nav',
                    type: 'button',
                    title: t('lightbox.canvas.next'),
                    'aria-label': t('lightbox.canvas.next'),
                    'data-knit-canvas-next': '1',
                    onClick: (event) => {
                      if (event && event.stopPropagation) event.stopPropagation()
                      lightboxStep(1)
                    },
                  }, '›')
                : null,
              lightboxDock
                ? h('button', {
                    className: 'knit-btn',
                    type: 'button',
                    title: t('lightbox.canvas.fullscreenTitle'),
                    'data-knit-canvas-fullscreen': '1',
                    onClick: (event) => {
                      if (event && event.stopPropagation) event.stopPropagation()
                      setLightboxDock(false)
                    },
                  }, t('lightbox.canvas.fullscreen'))
                : h('button', {
                    className: 'knit-btn',
                    type: 'button',
                    title: t('lightbox.canvas.dockTitle'),
                    'data-knit-canvas-dock': '1',
                    onClick: (event) => {
                      if (event && event.stopPropagation) event.stopPropagation()
                      setLightboxDock(true)
                    },
                  }, t('lightbox.canvas.dock')),
              lightboxDock
                ? h('button', {
                    className: 'knit-btn',
                    type: 'button',
                    title: t('lightbox.canvas.backTitle'),
                    'data-knit-canvas-back': '1',
                    onClick: (event) => {
                      if (event && event.stopPropagation) event.stopPropagation()
                      lightboxClose()
                    },
                  }, t('lightbox.canvas.back'))
                : null),
            /* v0.28：整屏的上一张 / 下一张（滚轮删掉之后的显式入口）。
               停掉冒泡，否则会冒到遮罩上把查看器关掉。 */
            lightboxDock
              ? null
              : h('button', {
                  className: 'knit-lightbox-nav prev',
                  type: 'button',
                  title: t('lightbox.canvas.prev'),
                  'aria-label': t('lightbox.canvas.prev'),
                  'data-knit-lightbox-prev': '1',
                  onClick: (event) => {
                    if (event && event.stopPropagation) event.stopPropagation()
                    lightboxStep(-1)
                  },
                }, '‹'),
            lightboxDock
              ? null
              : h('button', {
                  className: 'knit-lightbox-nav next',
                  type: 'button',
                  title: t('lightbox.canvas.next'),
                  'aria-label': t('lightbox.canvas.next'),
                  'data-knit-lightbox-next': '1',
                  onClick: (event) => {
                    if (event && event.stopPropagation) event.stopPropagation()
                    lightboxStep(1)
                  },
                }, '›'),
            /* 右上角 ✕ —— 照 DSH 自带查看器那套（全屏之后必须有一个**看得见的**出口：
               光靠「点图片以外」和 Esc，第一次用的人不知道往哪点）。 */
            lightboxDock
              ? null
              : h('button', {
                  className: 'knit-lightbox-close',
                  type: 'button',
                  title: t('lightbox.close'),
                  'aria-label': t('lightbox.close'),
                  onClick: () => lightboxClose(),
                }, '✕'),
            /* v0.28：滚轮翻页已删除 —— 一次滑动惯性会连翻好几张，用户明确要求去掉。 */
            h('div', {
              className: 'knit-lightbox-stage',
              ref: commentStageRef,
              /* 评论模式：点图落 pin（handler 里 stopPropagation，不关查看器）。
                 非评论模式：不拦，冒泡到遮罩 = 点图片以外才关的既有语义不变。 */
              onClick: commentOn ? onCommentStageClick : undefined,
              style: commentOn ? { cursor: 'crosshair' } : undefined,
              onContextMenu: openShotMenu,
            },
              h('img', {
                className: 'knit-lightbox-img',
                ref: commentImgRef,
                src: srcFor(lightboxDoc),
                alt: lightboxDoc.name || '',
                /* v0.28：拖到桌面 / 文件夹即保存（配 `DownloadURL`）。 */
                draggable: true,
                onDragStart: onLightboxDragStart,
                style: commentOn ? { cursor: 'crosshair' } : undefined,
                onLoad: measureCommentBox,
                onClick: (event) => {
                  // 评论模式下把点击让给 stage（要换算成图片上的百分比）
                  if (!commentOn && event && event.stopPropagation) event.stopPropagation()
                },
              }),
              commentOn
                ? h('div', {
                    className: 'knit-lightbox-pins',
                    /* 覆盖层 = **画布表面**（整屏 root / 面板画布 root 都是同一个根）；
                       pin 的像素位置由 commentBox（与落点**同一个**绘制矩形，换算到表面坐标）算。
                       拿不到尺寸（测试替身 / 图还没 load）时先不画位置，量到即重排。 */
                    onClick: (event) => { if (event && event.stopPropagation) event.stopPropagation() },
                  },
                    commentList.map((item) => h('button', {
                      key: item.n,
                      type: 'button',
                      className: 'knit-lightbox-pin',
                      style: commentBox
                        ? {
                            left: `${commentBox.left + (commentBox.width * item.xPct) / 100}px`,
                            top: `${commentBox.top + (commentBox.height * item.yPct) / 100}px`,
                          }
                        : null,
                      title: item.text,
                      'aria-label': t('lightbox.comment.pinAria', { n: item.n }),
                      'data-knit-comment-pin': String(item.n),
                      onClick: (event) => openCommentEditor(event, item),
                    }, String(item.n))),
                    /* 草稿 pin：点下去的那一点要**看得见**（不然输入框像浮在图上）。
                       与 Infini 的 .pin.draft 同一语义：半透明、不可点、编号就是即将保存的 n。 */
                    commentDraft && commentDraft.isNew
                      ? h('span', {
                          className: 'knit-lightbox-pin draft',
                          /* 有绘制矩形就落真实像素位置；量不到（测试替身 / 图还没 load）时
                             用百分比近似，等测量回来即对齐 —— 草稿点本身必须看得见。 */
                          style: commentBox
                            ? {
                                left: `${commentBox.left + (commentBox.width * commentDraft.xPct) / 100}px`,
                                top: `${commentBox.top + (commentBox.height * commentDraft.yPct) / 100}px`,
                              }
                            : { left: `${commentDraft.xPct}%`, top: `${commentDraft.yPct}%` },
                          'aria-hidden': 'true',
                        }, String(commentDraft.n))
                      : null,
                    commentDraft
                      ? h('div', {
                          className: 'knit-lightbox-editor',
                          'data-knit-comment-editor': '',
                          /* **贴着 pin**的气泡：出屏按 commentPopoverBox 翻边 + 夹进视口
                             （与 Infini 分享包同一套规则），不再「按百分比放到图片边上」。 */
                          style: { left: `${commentEditorBox.left}px`, top: `${commentEditorBox.top}px` },
                          'data-placement': commentEditorBox.placement,
                          onClick: (event) => { if (event && event.stopPropagation) event.stopPropagation() },
                        },
                          h('div', { className: 'knit-lightbox-editor-head' },
                            h('span', { className: 'knit-lightbox-editor-title' }, commentDraft.isNew
                              ? t('lightbox.comment.new')
                              : t('lightbox.comment.edit', { n: commentDraft.n })),
                            h('span', { className: 'knit-lightbox-editor-pos' },
                              `x ${commentDraft.xPct.toFixed(1)}% · y ${commentDraft.yPct.toFixed(1)}%`),
                          ),
                          h('input', {
                            className: 'knit-lightbox-editor-input',
                            type: 'text',
                            value: commentDraft.text,
                            autoFocus: true,
                            placeholder: t('lightbox.comment.placeholder'),
                            'aria-label': t('lightbox.comment.placeholder'),
                            onChange: (event) => {
                              const value = event && event.target ? event.target.value : ''
                              setCommentDraft({ ...commentDraft, text: String(value) })
                            },
                            onKeyDown: (event) => {
                              if (!event) return
                              if (event.key === 'Enter') {
                                event.preventDefault(); event.stopPropagation(); saveComment(); return
                              }
                              if (event.key === 'Escape') {
                                event.preventDefault(); event.stopPropagation(); cancelCommentDraft()
                              }
                            },
                          }),
                          commentStatus === 'lightbox.comment.tooLong'
                            ? h('span', { className: 'knit-lightbox-editor-hint' }, commentStatusText)
                            : null,
                          h('div', { className: 'knit-lightbox-editor-foot' },
                            commentDraft.isNew
                              ? null
                              : h('button', {
                                  className: 'knit-btn',
                                  type: 'button',
                                  onClick: () => deleteComment(commentDraft.n),
                                }, t('lightbox.comment.delete')),
                            h('span', { className: 'knit-lightbox-editor-count' },
                              `${String(commentDraft.text || '').length}/${COMMENT_MAX_CHARS}`),
                            h('button', {
                              className: 'knit-btn',
                              type: 'button',
                              onClick: cancelCommentDraft,
                            }, t('lightbox.comment.cancel')),
                            h('button', {
                              className: 'knit-btn',
                              type: 'button',
                              onClick: saveComment,
                            }, t('lightbox.comment.save'))))
                      : null
                  )
                : null),
            commentOn
              ? h('div', {
                  className: 'knit-lightbox-comments',
                  role: 'region',
                  'aria-label': t('lightbox.comment.count', { n: commentList.length }),
                  onClick: (event) => { if (event && event.stopPropagation) event.stopPropagation() },
                },
                  h('div', { className: 'knit-lightbox-comments-list' },
                    commentList.length
                      ? commentList.map((item) => h('div', {
                          key: item.n,
                          className: 'knit-lightbox-comment-row',
                        },
                          h('span', { className: 'knit-lightbox-comment-n' }, String(item.n)),
                          h('button', {
                            className: 'knit-lightbox-comment-text',
                            type: 'button',
                            title: item.text,
                            onClick: (event) => openCommentEditor(event, item),
                          }, commentSummary(item.text)),
                          h('button', {
                            className: 'knit-lightbox-comment-del',
                            type: 'button',
                            title: t('lightbox.comment.delete'),
                            'aria-label': t('lightbox.comment.delete'),
                            onClick: () => deleteComment(item.n),
                          }, '✕'),
                        ))
                      : h('div', { className: 'knit-lightbox-comments-empty' },
                          h('span', { className: 'knit-lightbox-comments-emptyTitle' }, t('lightbox.comment.empty')),
                          h('span', { className: 'knit-lightbox-comments-emptyHint' }, t('lightbox.comment.emptyHint'))),
                  ),
                  h('div', { className: 'knit-lightbox-comments-right' },
                    commentStatusText
                      ? h('span', { className: 'knit-lightbox-comments-status' }, commentStatusText)
                      : null,
                    h('button', {
                      className: 'knit-btn knit-lightbox-comments-send',
                      type: 'button',
                      disabled: !commentList.length,
                      title: t('lightbox.comment.sendTitle'),
                      'data-knit-comment-send': '1',
                      onClick: sendComments,
                    }, t('lightbox.comment.send')),
                  ),
                )
              : null)
        : null

      return h('div', {
        className: `knit-root${fullscreen ? ' fullscreen' : ''}`,
        ref: rootRef,
        // v0.25 查找：捕获阶段（要抢在列表的 Esc 之前，见 onRootKeyDownCapture 的注释）
        onKeyDownCapture: onRootKeyDownCapture,
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
        // v0.21.x（2026-10-09）：计数只剩数字（量词在 title 里，悬停才读得到）。
        h('div', { className: 'knit-count', title: countTitle }, countText),
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
        /* v0.21.x（2026-10-09 用户规格）：三组一行 —— 排序 ｜ 类型 ｜ 搜索。
           ① 排序与类型**不做成一个整体**：两组各管各的（中间的竖线 2026-10-12 已删除，靠 gap 分界）。
           ② 搜索排最后、贴最右：它只过滤当前列表，不重置排序与类型（§三.3）。
           ③ 六个选项彼此独立 —— 选「代码」再选「最新」= 最新的代码。
           顺序即控件顺序，别再挪（细则在 CSS 那边的 .knit-bar / .knit-filter 注释里）。 */
        /* v0.25（2026-10-22 用户裁决）：**媒体档不看相关性** ⇒ 这一组在那一档禁用，
           并且**如实显示「最新」在生效**（显示的是「当前实际顺序」，不是存着的偏好）。
           偏好本身不动：切回文档/代码还是你原来选的那个。
           ⚠️ 是「禁用」不是「删掉」：控件不消失，布局不跳，鼠标悬停也有一句解释。 */
        h('div', { className: 'knit-seg' },
          h('button', {
            className: `knit-seg-btn${effectiveSort === 'relevance' ? ' active' : ''}`,
            onClick: () => pickSort('relevance'),
            disabled: kind === KIND_MEDIA || kind === KIND_CHANGES,
            title: kind === KIND_CHANGES ? t('sort.changesTitle') : (kind === KIND_MEDIA ? t('sort.mediaTimeTitle') : t('sort.relevanceTitle')),
          }, t('sort.relevance')),
          h('button', {
            className: `knit-seg-btn${effectiveSort === 'time' ? ' active' : ''}`,
            onClick: () => pickSort('time'),
            disabled: kind === KIND_MEDIA || kind === KIND_CHANGES,
            title: kind === KIND_CHANGES ? t('sort.changesTitle') : (kind === KIND_MEDIA ? t('sort.mediaTimeTitle') : t('sort.timeTitle')),
          }, t('sort.time'))),
        // ⚠️ 2026-10-12 用户裁决：排序组与类型组之间**那根竖线去掉了** —— 它的类名与 CSS 规则都已整体删除。
        // 两组靠 `.knit-bar` 的 gap 分开就够 —— 「边界」不再需要一根线来表达。
        h('div', { className: 'knit-types', role: 'tablist', 'aria-label': t('kind.title') },
          // v0.23.1（2026-10-12 用户裁决）：**三档**「文档 / 代码 / 媒体」——
          // 「全部」那一档连同它的混合浏览视图在整个界面上删除了（三档等距、页签样式不变）。
          // **没有第二层分类** —— 代码里不按语言（JS / TS / Python…）分组（需求 §46）。
          [[KIND_DOC, 'kind.doc'], [KIND_CODE, 'kind.code'], [KIND_MEDIA, 'kind.media'], [KIND_CHANGES, 'kind.changes']].map(([value, labelKey]) =>
            h('button', {
              type: 'button',
              key: value,
              role: 'tab',
              'aria-selected': kind === value,
              className: `knit-type-btn${kind === value ? ' active' : ''}`,
              title: t('kind.title'),
              onClick: () => pickKind(value),
            }, t(labelKey)))),
        /* v0.24（2026-10-12 用户裁决）：**检索方式搬去状态行了**（见下面 `pipeMethodNode`），
           工具栏第二行只剩三样：排序、类型、搜索框。
             `[相关|最新] [文档|代码|媒体] …………………………… [ ……搜索框…… ]`
           ⚠️ 搜索框仍靠右：`margin-left:auto` 由它外面的 `.knit-bar-right` 承担（容器没被撤掉，
             只是里面从「检索方式 + 搜索框」变成「只有搜索框」）。
           ⚠️ 容器里**只有搜索框**是 `flex:1 1 …` 的可伸缩项 —— 窄屏先缩它；排序 / 类型一律 `flex:none`。
           ⚠️ 搜索仍是对**当前这一份列表**再过滤，不动排序与类型。 */
        h('div', { className: 'knit-bar-right' },
          h('div', { className: 'knit-searchwrap' },
            h('input', {
              className: 'knit-filter',
              value: query,
              placeholder: t('filter.placeholder'),
              'aria-label': t('filter.aria'),
              onChange: (event) => setQuery(event.target.value),
              onKeyDown: (event) => {
                if (event.key === 'Escape') { event.stopPropagation(); setQuery('') }
              },
            })))),
      /* ── v0.21：检索状态摘要 + 排除说明（需求 §6.3）──────────────────────
         两条都是**事实行**，都在列表上方、都只在相关序出现（那是唯一有「包」的视图）。
      ⚠️ 它们的排位是**紧贴工具栏**的（2026-10-09 用户反馈）：观察层排在它们下面，
         所以开关「使用情况」不会把这一行顶下去（详见下面的 Lens 注释）。
         ① 状态摘要 `收集 137 · 排除 1 · 候选 136 | BM25 词法检索 · 关系 24 条 · 固定 1 | 入包 8`：
            **分组与顺序本身就是这条设计要传达的信息** —— 排除发生在检索**之前**、固定发生在
            排序**之后**。所以它不是装饰，也不是进度条，更没有流程图箭头（2026-10-09 用户规格）。
         ② 排除说明：被排掉的那几篇 + 一个「恢复」。它说的是「这一批少了什么」，
            空的时候**不出现、也不占位**。 */
      relevance && contextView ? pipeNode : null,
      /* ── v0.23（Phase A）：混合检索的两条行 ─────────────────────────────
         ⚠️ 排位固定在这里（**状态摘要之后**）：摘要的前一个兄弟必须是 `.knit-bar`，
            插到工具栏与摘要之间会把那条守卫顶掉（见 test/client.test.mjs 的顺序用例）。
         两条都只在**用户选了混合**时出现：默认词法时一个节点都不产生（判据 2 的回归面）。
         ① 事实行：混合**没生效**时如实写原因（含「宿主版本较旧」这一档静默降级）；
         ② 配置行：只有「选了混合 + provider 不可用」才就地展开，一行三格 + 一句披露。 */
      showRetrieval && semOn && !semLive ? h('div', { className: 'knit-retnote' }, semReasonText) : null,
      showRetrieval && semCfgOpen && semInfo && !semInfo.available ? semcfgNode : null,
      semOn && semNotice ? h('div', { className: 'knit-notice' }, semNotice) : null,
      relevance && excludedList.length > 0 ? h('div', { className: 'knit-excl' },
        h('span', { className: 'knit-excl-what' },
          t('control.excluded', { rel: excludedList.map((item) => item.rel).join('、') })),
        h('button', {
          className: 'knit-act',
          type: 'button',
          onClick: () => act('restore', excludedList[0].rel),
        }, t('control.restore'))) : null,
      notice ? h('div', { className: 'knit-notice' }, notice) : null,
      /* ── v0.18 的「Context Usage Lens」**排在最后**（2026-10-09 用户反馈）───────
         它原来是紧随 `.knit-bar` 的：一开「使用情况」，整块观察层插在状态摘要**上面**，
         把那一行数字顶下去 —— 用户原话「这一列…向下排，我觉得这列不用向下排，而是固定在原来的位置」。
         所以顺序改成 **工具栏 → 状态摘要 → 排除说明 → 通知 → 观察层 → 列表**：
         摘要这一行永远紧贴工具栏，位置不随开关变；观察层仍是「列表上方的观察层」，
         而且比原来更贴近列表。⚠️ 别再把它挪回 `.knit-bar` 后面（有守卫钉着顺序）。
         v0.15：开了才显示。不是弹窗、不是新页面、不是 Dashboard。 */
      usageOn && kind !== KIND_CHANGES ? lensNode : null,
      // 列表节点**直接挂上去**（2026-09-29 起永远单栏；曾经它要交给一个 IIFE
      // 决定塞进单栏还是双栏的左列）。**输出与 v0.13 逐字一致** ——
      // 时间序、媒体档、「全部」都不受影响。
      (lightboxDoc && lightboxDock
        ? h('div', { className: 'knit-canvas' }, lightboxContent)
        : (() => {
        const listNode = h('div', {
          className: 'knit-list',
          ref: listRef,
          tabIndex: 0,
          onKeyDown: onListKeyDown,
          // v0.25：滚动就收起悬停大图 —— 它是 fixed 定位，不跟着卡片走，留着只会错位
          onScroll: hoverClose,
          role: 'listbox',
          'aria-label': t('list.aria'),
          // 焦点始终在容器上（roving 焦点会打断「移动即预览」），
          // 所以用 activedescendant 把「当前项」告诉辅助技术。
          // cursor 不在可见列表里时（被过滤/被上限截断）就不指向任何东西。
          'aria-activedescendant': (() => {
            const list = navDocsOf()
            return list.some((doc) => doc.rel === cursor)
              ? docOptionId(list.find((doc) => doc.rel === cursor))
              : undefined
          })(),
        }, listBody())
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
      })()),
      preview && !(lightboxDoc && lightboxDock) ? h(PreviewPanel, {
        preview,
        pathImages,
        fullscreen,
        ratio,
        // v0.25 查找：状态在 KnitBody，正文容器 ref 也交出去给 DOM 绘制用
        find: {
          on: findOn,
          query: findQuery,
          index: findIndex,
          count: findCount,
          inputRef: findInputRef,
          onOpen: openFind,
          onQuery: onFindQuery,
          onStep: findStep,
          onClose: closeFind,
        },
        bodyRef: previewBodyRef,
        // v0.25 媒体收藏
        favorite: favoriteSet.has(preview.rel),
        onToggleFavorite: toggleFavorite,
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
      }) : null,
      /* v0.25：媒体档「悬停看大图」。`position:fixed` + CSS 的 `pointer-events:none` ——
         它只是「看一眼」：不参与布局、不挡点击、不抢焦点。盒子由 `hoverShotBox()` 算好。 */
      hoverShot
        ? h('div', {
            className: 'knit-shot',
            style: {
              left: `${hoverShot.box.left}px`,
              top: `${hoverShot.box.top}px`,
              width: `${hoverShot.box.width}px`,
              height: `${hoverShot.box.height}px`,
            },
            role: 'button',
            tabIndex: 0,
            title: t('lightbox.canvas.hintTitle'),
            'data-knit-hover-shot': '1',
            onMouseEnter: hoverKeep,
            onMouseLeave: hoverEnd,
            onClick: (event) => {
              if (event && event.stopPropagation) event.stopPropagation()
              const doc = hoverShot.doc
              hoverClose()
              if (doc) lightboxOpen(doc, { dock: true, comment: true })
            },
          },
            h('img', { src: hoverShot.src, alt: '', draggable: false }),
            h('span', { className: 'knit-shot-hint' }, t('lightbox.canvas.commentHint')))
        : null,
      /* v0.25：媒体档「双击全屏」查看器。
         · 点**图片以外**（遮罩）⇒ 关；点图片本身 ⇒ 不关（`stopPropagation`），
           否则「点一下想看清细节」就把查看器点没了；
         · 左侧一列缩略图（当前这张附近 10 张）——点它换图，也不许冒泡去关；
         · `role="dialog"` + `aria-modal` + 可聚焦：Esc / ← → 由根上的捕获阶段接管。 */
      lightboxDoc && !lightboxDock ? mountLightbox(lightboxContent) : null)
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

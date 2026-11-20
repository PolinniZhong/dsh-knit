    /* ── 官方语法高亮器（v0.20，2026-10-07 用户新增需求）────────────────────
       代码预览原本是**单色**（浅色黑 / 暗色白），用户的原话是「对于一个阅读代码
       用户来说，可读性太低了」，并给了 DSH 自己那份带行号的代码视图当参照。

       这里用的是**同一个包**里的 `useCodeHighlighter(language) → (code) =>
       HighlightSpan[][]`。它的 `style.color` 一律是 `var(--shiki-*)`，而那张
       调色板定义在 DSH 主题包里（浅色一套、`body[data-ds-dark-theme]` 一套）——
       所以**我们一行颜色都不写**：既不会自己发明一套配色，也不会在某个主题下
       悄悄写死白色（那正是上一轮暗色治理踩过的坑）。

       ⚠️ 它是个 **hook**：必须**无条件**调用。所以缺包/缺导出时用下面这个同形状的
       假 hook 顶上（返回的 highlighter 一律 `undefined` = 纯文本兜底），而不是在
       组件里写「如果有就调用」—— 条件调用 hook 是 React 的硬错误。语法是**懒加载**
       的（TypeScript / shell / JSON 启动即在，python、html、css、yaml 首次用到才
       装载）：那一帧回落纯文本，hook 自己订阅了装载事件并会重渲染，我们不必插手。 */
    let useCodeHighlighter = null
    try {
      const primitives = require('@deepseek-ai/dsh-client-ui-primitives')
      const candidate = primitives && primitives.useCodeHighlighter
      if (typeof candidate === 'function') useCodeHighlighter = candidate
      else console.warn('[knit] ui-primitives does not export useCodeHighlighter — code preview falls back to plain text')
    } catch (error) {
      console.warn('[knit] could not load ui-primitives.useCodeHighlighter — code preview falls back to plain text', error)
    }

    /** 没有官方高亮器时 `(code) => undefined` —— 与官方同形状，调用方不必分叉。 */
    const PLAIN_CODE_HIGHLIGHTER = () => undefined
    /** 假 hook：恒等返回上面那个函数（引用稳定，可以安全当 memo 依赖）。 */
    function usePlainCodeHighlighter() { return PLAIN_CODE_HIGHLIGHTER }
    /** 真 hook 或假 hook，二选一 —— **在组件里永远是无条件调用**（见上）。 */
    const useCodeSpans = useCodeHighlighter || usePlainCodeHighlighter

    /* 高亮结果**按文件缓存**（v0.20 性能治理，2026-10-07）。官方高亮器实测 170–560 ms /
       千行，而「关掉再点开同一篇」「切标签再回来」都会重新挂载 `CodePane` —— 不缓存就每次
       从头再分词一遍。键 = `rel#行数`，命中时还比一次原文（原文变了就重算）；上限 8 篇，
       够覆盖「来回点几篇」，又不会把整库正文吊在内存里（真机量到：点开 4000 行的文件
       3459 ms、其中 1259 ms 就是分词；重开同一篇从 2155 ms 降到几十毫秒）。 */
    const CODE_HL_CACHE = new Map()
    function cachedCodeSpans(key, text, run) {
      const hit = CODE_HL_CACHE.get(key)
      if (hit && hit.text === text) { CODE_HL_CACHE.delete(key); CODE_HL_CACHE.set(key, hit); return hit.spans }
      const spans = run()
      CODE_HL_CACHE.set(key, { text, spans })
      while (CODE_HL_CACHE.size > 8) CODE_HL_CACHE.delete(CODE_HL_CACHE.keys().next().value)
      return spans
    }

    /* ── 常量 ───────────────────────────────────────── */

    /** 官方右侧栏 tab 的身份，也是 body/title 注册用的 key。 */
    const TAB_ID = 'dsh-knit:recent'
    /** page 类型判别符；openTab('knit') 用它。 */
    const KIND = 'knit'
    /** better-sidebar 里这个 tab 的 id。 */
    const BS_TAB_ID = 'knit:recent'

    const LIST_API = '/knit/api/recent'
    /* v0.25：Git 变更关联的**独立接口**。它与列表接口分开，所以「列表的响应形状」
       不会被这个功能碰到；关掉功能时客户端连这个请求都不发。 */
    const CHANGES_API = '/knit/api/changes'
    const STATUS_API = '/knit/api/status'
    const DIFF_API = '/knit/api/diff'
    /* v0.25：媒体档额外显示「对话里工具产出的图」——**独立接口**，`/api/recent` 一个字节没动。
       列表零 I/O（元数据全在会话事件里）；字节按 **sha256** 取（见 `attachmentUrl`）。 */
    const ATTACH_LIST_API = '/knit/api/attachments'
    const ATTACH_RAW_API = '/knit/api/attachment'
    const DOC_API = '/knit/api/doc'
    const RAW_API = '/knit/api/raw'
    // v0.12：某篇的「谁引用了它 / 它引用了谁」。与上面三条一样是**同源相对地址**，
    // 所以仍然满足「客户端零网络出口」那条守卫（test/security.test.mjs）。
    const LINKS_API = '/knit/api/links'
    // v0.21：整个 HTTP 面**唯一**的写动作（固定 / 排除）。只回环、只 POST、只认
    // `{action, rel}`；工作区根由 `sessionId` 解析 —— 与其余路由同一条纪律。
    const CONTROL_API = '/knit/api/control'
    // v0.21：**镜像**宿主的面板投影上限（`src/host/relations.js` 的
    // `MAX_RELATIONS_PER_ITEM = 3`）。客户端只需要它来写「共 N 条关系，每项最多投影 3 条」
    // 那句话 —— 真正的截断在宿主做，这里**不截断**（截断两次就会出现两份真相）。
    // ⚠️ 两个数字必须一致：`test/client.test.mjs` 有一条源码级守卫同时读两侧。
    const REL_MAX = 3

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

    /* ── v0.23（Phase A）：检索模式 ──────────────────────────
       默认**词法**。「混合」只是把语义候选**补进候选集**的一种可选模式，
       它要用户显式选、并且配了 provider 才会真的跑 —— 「零模型调用 / 零网络出口」
       这条对外承诺只在默认模式成立（细则见 v0.23 方案 §2 的文案纪律）。 */
    const RETRIEVAL_KEY = 'dsh-knit:retrieval'
    /** v0.25：Git 变更关联的开关。**默认关** —— 不写这一项就是关。 */
    const CHANGES_KEY = 'dsh-knit:changes'
    /** 语义 provider 的**唯一写路由**；读走 `/api/recent` 的 `semantic.provider`。 */
    const SEMANTIC_API = '/knit/api/semantic'

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
    /** v0.26.x：「变更」档 —— 未提交改动（跨 Markdown / 代码）。 */
    const KIND_CHANGES = 'changes'

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
    /* v0.23（方案 A）：「全部」档的**两个类型上限**已整体删除 ——
       「全部」不再是「文档前 4 + 代码前 4 + 媒体」，而是**整份包的原样**
       （三层混排文档 + 代码，媒体在三层之后一个不截断的网格）。 */
    /** 「全部」视图里代码区的固定上限（与文档区同量级 —— 代码不该在这一档里压过文档）。 */
    /**
     * 一屏基准：两行 × 4 列的观感（只在「媒体」这一档决定一屏铺几行时用）。
     * **它不决定列数** —— 列数交给 CSS 的 `auto-fill`，见 mediaLayoutFor。
     */
    const MEDIA_MAX_ITEMS = 8
    /* ── v0.28：媒体档分批 + 缩略图降采样（实测：40 张原图同屏 = 586 MB 位图）──
       两层缺一不可：① 首屏只挂一屏量、滚到底追加；② 缩略图降采样后上屏（见 useThumb）。
       完整取证与数字在 `docs/media-performance.md`。 */
    /** 一次「加载更多」追加多少张。 */
    const MEDIA_BATCH = 24
    /** 首屏最少 / 最多挂几张（列数 × 行数会夹在这个区间里）。 */
    const MEDIA_FIRST_MIN = 12
    const MEDIA_FIRST_MAX = 48
    /** 缩略图缓存条数上限（240 × ≈20 KB ≈ 5 MB，远小于一张原图的位图）。 */
    const THUMB_CACHE_MAX = 240
    /** 同时进行的缩略图解码数（>2 会让主线程解码峰值叠起来）。 */
    const THUMB_CONCURRENCY = 2
    /** 生成缩略图时按格宽的几倍采样（2× 足够 2x DPR 屏清晰）。 */
    const THUMB_SCALE = 2
    const THUMB_EDGE_MIN = 96
    const THUMB_EDGE_MAX = 320

    /* ── v0.28：查看器「保存到本地」（右键菜单 / 拖到桌面）───────────────
       没有新路由：仍然只读同源的 `/knit/api/raw` / `/knit/api/attachment`，
       客户端拿到字节后用 `<a download>` 落盘；拖拽则用 `DownloadURL` 让浏览器/系统
       自己把它当成一次「下载」。文件名要**带扩展名**，否则系统会存成 `raw`。 */
    const IMAGE_MIME = {
      png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
      webp: 'image/webp', avif: 'image/avif', svg: 'image/svg+xml', bmp: 'image/bmp',
    }

    /**
     * 取文件扩展名（小写，不含点）。**纯函数**。
     * @param {string} name - 文件名或路径
     * @returns {string} 扩展名；没有就空串
     */
    function extOf(name) {
      const m = String(name || '').match(/\.([a-z0-9]{1,5})$/i)
      return m ? m[1].toLowerCase() : ''
    }

    /**
     * 图片的 MIME。**纯函数**。
     * @param {string} name - 文件名
     * @returns {string} MIME；认不出就 octet-stream
     */
    function imageMimeOf(name) {
      return IMAGE_MIME[extOf(name)] || 'application/octet-stream'
    }

    /**
     * 保存时用的文件名：basename + 去掉文件系统非法字符，缺扩展名时补 `.png`。**纯函数**。
     * @param {{name?:string, rel?:string}} doc - 媒体条目
     * @returns {string} 可落盘的文件名
     */
    function downloadNameOf(doc) {
      const raw = String((doc && (doc.name || doc.rel)) || '')
      const base = raw.split(/[\\/]/).pop() || ''
      const cleaned = base.replace(/[\\/:*?"<>|]+/g, '-').trim()
      if (!cleaned) return 'knit-image.png'
      return extOf(cleaned) ? cleaned : `${cleaned}.png`
    }

    /**
     * 拖拽用的 `DownloadURL` 值（Chromium 约定 `mime:filename:absoluteUrl`）。**纯函数**。
     * @param {string} src - 同源相对地址
     * @param {string} name - 落盘文件名
     * @param {string} origin - 当前页面 origin
     * @returns {string} `DownloadURL` 字符串
     */
    function downloadUrlFor(src, name, origin) {
      const rel = String(src || '')
      const abs = /^https?:/i.test(rel) ? rel : `${origin || ''}${rel}`
      return `${imageMimeOf(name)}:${name}:${abs}`
    }

    /**
     * 首屏该挂多少张媒体。**纯函数**。
     *
     * 按「三行 + 一行预取」估：列数 × 3，夹进 `MEDIA_FIRST_MIN…MAX`。
     * ⚠️ **刻意不读面板高度**：高度那个 state 在 KnitBody 里声明得比使用点晚
     * （TDZ），而首屏批量必须在 `navDocs` 之前就能算出来（键盘与挂载必须同一份清单）。
     * 三行已足够覆盖一屏；真正的「按屏精确」由滚动哨兵追加来补。
     *
     * @param {number} columns - 当前列数（`mediaLayoutFor().columns`）
     * @returns {number} 首屏挂载数
     */
    function mediaFirstBatch(columns) {
      const cols = Math.max(1, Math.round(Number(columns) || 1))
      return Math.max(MEDIA_FIRST_MIN, Math.min(MEDIA_FIRST_MAX, cols * 3))
    }

    /**
     * 「加载更多」之后该挂多少张。**纯函数**。
     * @param {number} current - 当前已挂载数
     * @param {number} total - 总条目数
     * @returns {number} 新的挂载数（不超过 total）
     */
    function mediaNextCount(current, total) {
      const have = Math.max(0, Math.round(Number(current) || 0))
      const all = Math.max(0, Math.round(Number(total) || 0))
      return Math.min(all, have + MEDIA_BATCH)
    }

    /**
     * 缩略图采样边长。**纯函数**。
     * @param {number} cell - 格子实际边长（px）
     * @returns {number} 采样边长（px）
     */
    function thumbEdgeFor(cell) {
      const c = Number(cell)
      const base = Number.isFinite(c) && c > 0 ? c : MEDIA_TRACK_PX
      return Math.max(THUMB_EDGE_MIN, Math.min(THUMB_EDGE_MAX, Math.round(base * THUMB_SCALE)))
    }

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
    /* ── v0.25：媒体档「悬停看大图」────────────────────────────────────────
       用户要的是「鼠标停在图片上，弹一个大图」。

       三条取舍：
       ① **800×800 是上限，不是尺寸** —— 面板本身只有几百像素宽，硬占 800 会把对话区盖住。
          所以盒子按「卡片左边还剩多少」与视口算，最后再夹到 800。
       ② **只做图片**（视频要解码 + 起播放器，噪声与代价都不是一个量级）。
       ③ **延迟出现**（`HOVER_SHOT_DELAY_MS`）：鼠标扫过网格时不许一路闪；
          离开即收。`pointer-events:none` —— 它只是「看一眼」，不许挡点击。
    */

    /**
     * 悬停浮窗的边长上限。
     *
     * ⚠️ 2026-10-21 从 800 改成 420：用户在真机上看了之后说「现在浮窗太大了」，
     * 并在截图上用红框标出他想要的大小 —— 约等于原来的**一半**。
     * 这是**一个人眼定的大小**，不是算出来的；要再调就只改这一个数。
     */
    const HOVER_SHOT_MAX = 420
    /* ── v0.25：媒体档「双击全屏」（2026-10-22，参照用户给的 Codex 截图）────────
       用户要的三件事：① 双击图片进全屏；② 点图片以外关闭；③ 左侧一列「近 10 张」缩略图。
       另加两件（不然光看图就断手）：图片以外是**毛玻璃**且随主题变（他第 4 点要的），
       以及 `←` `→` 在带子里前后翻。
       刻意**没做**（他没要，也不该顺手塞）：缩放百分比、下载、用其他应用打开。
    */

    /**
     * 把查看器挂到哪：**能 portal 就一定 portal**（否则 `fixed` 会被侧边栏的 transform 困住）。
     *
     * 单独抽成一个函数是为了「这件事有没有做」能被源码守卫直接看见 ——
     * 测试替身没有 `document`，这条路径只能在真机上走，所以形状守卫是它唯一的护栏。
     *
     * @param {object} node - 要挂的 React 元素
     * @param {{doc?:object, dom?:object}} [env] - 可注入的 document / ReactDOM（默认取模块里的）
     * @returns {object} portal 结果，或原节点（降级）
     */
    function mountLightbox(node, env = {}) {
      const dom = env.dom === undefined ? (typeof document === 'undefined' ? null : document) : env.dom
      const renderer = env.renderer === undefined ? ReactDOM : env.renderer
      try {
        if (node && dom && dom.body && renderer && typeof renderer.createPortal === 'function') {
          return renderer.createPortal(node, dom.body)
        }
      } catch { /* portal 失败就就地渲染，不许白屏 */ }
      return node
    }

    /** 全屏查看器左侧缩略图带显示几张。 */
    const LIGHTBOX_RAIL = 10
    /** 当前这张在带子里前面留几张（偏「刚看过的」，不是偏「后面的」）。 */
    const LIGHTBOX_RAIL_LEAD = 4

    /**
     * 全屏查看器的左侧缩略图带：取**当前这张附近**的 N 张。
     *
     * 为什么不是「最新的 N 张」：双击第 30 张时，「最新 10 张」里根本没有它 ——
     * 带子里看不到当前这张，前后翻也断在画面外。所以取一个以当前为中心的窗口，两头夹紧。
     * **纯函数**：只吃数组与下标，能真断言。
     *
     * @param {object[]} docs - 当前媒体列表（已排好序）
     * @param {number} index - 当前这张的下标
     * @param {{size?:number, lead?:number}} [opts] - 带子长度与前置张数
     * @returns {{start:number, items:object[]}} 起点与带子内容
     */
    function lightboxRail(docs, index, opts = {}) {
      const list = Array.isArray(docs) ? docs : []
      const size = Number.isFinite(opts.size) ? Math.max(1, Math.round(opts.size)) : LIGHTBOX_RAIL
      const lead = Number.isFinite(opts.lead) ? Math.max(0, Math.round(opts.lead)) : LIGHTBOX_RAIL_LEAD
      if (!list.length) return { start: 0, items: [] }
      const at = Number.isFinite(index) ? Math.min(Math.max(0, Math.round(index)), list.length - 1) : 0
      const start = Math.min(Math.max(0, at - lead), Math.max(0, list.length - size))
      return { start, items: list.slice(start, start + size) }
    }

    /* ── v0.26：图内评论（pin 评论）────────────────────────────────────────
       起点是 Codex 画布与 Infini 分享包的**坐标格式**：
       每条评论 { n, xPct, yPct, text }，xPct / yPct 是相对**图片实际绘制矩形**
       （object-fit: contain 之后那一块）的 0–100 百分比。
       ⚠️ 命门在坐标：**百分比只能从 contentRect 算**，不能从 stage 框算 ——
       图不是等比铺满 stage（letterbox 的空白也算在 stage 里），拿 stage 算会让
       所有 pin 在窄视口 / 方图上整体偏移。window resize / 面板宽度变化 / 滚动后
       都要重算（measureCommentBox + ResizeObserver + resize / scroll 监听）。
       P0 **不落盘**：评论只活在这个组件的 state 里，退出查看器仍在、硬刷新丢失。
    */

    /** 一条评论最多几个字（超出提示，不截断用户输入）。 */
    const COMMENT_MAX_CHARS = 200
    /** 一张图最多几条评论（到顶就不许再落新 pin）。 */
    const COMMENT_MAX = 50
    /** 底部评论栏里一条文字摘要最多显示几个字。 */
    const COMMENT_SUMMARY_CHARS = 28
    /** 评论编辑气泡的基准尺寸（px）：用来算「会不会出屏 / 该往哪边翻」。 */
    const COMMENT_POP_W = 280
    const COMMENT_POP_H = 172

    /**
     * `object-fit` 之后**真正画出图**的那块矩形（视口坐标）。
     *
     * 为什么不能直接用 img 元素盒：`object-fit: contain` 时盒子里会留 letterbox 空白，
     * 百分比按盒子算会在空白里也落 pin，并且整体偏移。拿 naturalWidth / naturalHeight
     * 反推缩放比，才能得到「图上这一点」的真实位置。
     *
     * @param {{left:number,top:number,width:number,height:number}} imgRect - img 元素盒
     * @param {{width:number,height:number}} natural - naturalWidth / naturalHeight
     * @param {'contain'|'cover'|'fill'} [mode] - object-fit 模式
     * @returns {{left:number,top:number,width:number,height:number}|null} 绘制矩形
     */
    function contentRect(imgRect, natural, mode = 'contain') {
      if (!imgRect || !natural) return null
      const boxW = Number(imgRect.width)
      const boxH = Number(imgRect.height)
      const natW = Number(natural.width)
      const natH = Number(natural.height)
      if (!(boxW > 0) || !(boxH > 0) || !(natW > 0) || !(natH > 0)) return null
      const fit = mode === 'cover' ? 'cover' : mode === 'fill' ? 'fill' : 'contain'
      let width = boxW
      let height = boxH
      if (fit !== 'fill') {
        const scale = fit === 'cover'
          ? Math.max(boxW / natW, boxH / natH)
          : Math.min(boxW / natW, boxH / natH)
        width = natW * scale
        height = natH * scale
      }
      const left = Number.isFinite(Number(imgRect.left)) ? Number(imgRect.left) : 0
      const top = Number.isFinite(Number(imgRect.top)) ? Number(imgRect.top) : 0
      return { left: left + (boxW - width) / 2, top: top + (boxH - height) / 2, width, height }
    }

    /** 百分比保留到千分位，避免浮点噪声把「同一个点」写成两个值。 */
    function roundPct(value) {
      return Math.min(100, Math.max(0, Math.round(Number(value) * 1000) / 1000))
    }

    /**
     * 视口坐标 → 内容框里的百分比。**纯函数**。
     * @param {{x:number,y:number}} point - 视口坐标
     * @param {{left:number,top:number,width:number,height:number}} rect - contentRect 的结果
     * @returns {{xPct:number,yPct:number}|null} 0–100 的百分比
     */
    function pctFromPoint(point, rect) {
      if (!point || !rect) return null
      const x = Number(point.x)
      const y = Number(point.y)
      if (!Number.isFinite(x) || !Number.isFinite(y)) return null
      if (!(rect.width > 0) || !(rect.height > 0)) return null
      return {
        xPct: roundPct(((x - rect.left) / rect.width) * 100),
        yPct: roundPct(((y - rect.top) / rect.height) * 100),
      }
    }

    /**
     * 百分比 → 视口坐标（`pctFromPoint` 的逆运算）。**纯函数**。
     * @param {{xPct:number,yPct:number}} pct - 0–100 的百分比
     * @param {{left:number,top:number,width:number,height:number}} rect - contentRect 的结果
     * @returns {{x:number,y:number}|null} 视口坐标
     */
    function pointFromPct(pct, rect) {
      if (!pct || !rect) return null
      const xPct = Number(pct.xPct)
      const yPct = Number(pct.yPct)
      if (!Number.isFinite(xPct) || !Number.isFinite(yPct)) return null
      return {
        x: rect.left + (Math.min(100, Math.max(0, xPct)) / 100) * rect.width,
        y: rect.top + (Math.min(100, Math.max(0, yPct)) / 100) * rect.height,
      }
    }

    /**
     * 把任意来源的评论表洗成**可信的形状**：畸形回空、坐标夹到 0–100、
     * 空文本不占位、条数封顶、编号从 1 连续重排。**纯函数**。
     *
     * ⚠️ 编号连续是刻意的：删掉中间一条之后，剩下的必须重新从 1 排 ——
     * 否则发送文本里会出现「1. 3. 4.」，agent 读起来像漏了内容。
     *
     * @param {object[]|null} raw - 任意输入（localStorage / 手改 / 旧版本）
     * @returns {{n:number,xPct:number,yPct:number,text:string}[]} 干净列表
     */
    function normalizeComments(raw) {
      if (!Array.isArray(raw)) return []
      const out = []
      for (const item of raw) {
        if (out.length >= COMMENT_MAX) break
        if (!item || typeof item !== 'object') continue
        const text = typeof item.text === 'string' ? item.text : ''
        if (!text.trim()) continue
        const xPct = Number(item.xPct)
        const yPct = Number(item.yPct)
        if (!Number.isFinite(xPct) || !Number.isFinite(yPct)) continue
        out.push({ n: out.length + 1, xPct: roundPct(xPct), yPct: roundPct(yPct), text })
      }
      return out
    }

    /**
     * 下一条评论的编号（1 起、连续）。**纯函数**。
     * @param {{n:number}[]|null} list - 当前评论
     * @returns {number} 下一个编号
     */
    function nextNumber(list) {
      const items = normalizeComments(list)
      // normalizeComments 已经保证连续，最后一条的 n + 1 就是下一个
      if (items.length) return items[items.length - 1].n + 1
      // 还没成形（比如只有 {n} 没有坐标）时按「有几条」兜底，仍然从 1 起连续
      const count = Array.isArray(list) ? list.filter((item) => item && typeof item === 'object').length : 0
      return count + 1
    }

    /** 评论栏里的一行摘要（按字数截，末尾补省略号）。**纯函数**。 */
    function commentSummary(text, max) {
      const raw = String(text === undefined || text === null ? '' : text)
      const limit = Number.isFinite(max) ? Math.max(1, Math.round(max)) : COMMENT_SUMMARY_CHARS
      return raw.length > limit ? `${raw.slice(0, limit)}…` : raw
    }

    /**
     * §四 的发送文本行。**纯函数**（但格式是「事实标准」，刻意不随界面语言变）。
     *
     * 单图：
     *   图像 1：<文件名或 rel>（sha256 <前 12 位，若有>）
     *   1.（x：62.5%，y：31.0%）文案
     *
     * @param {{n:number,xPct:number,yPct:number,text:string}[]} list - 评论
     * @param {{name?:string,rel?:string,sha?:string,index?:number}} [image] - 身份 + 在输入框附件里的序号
     * @returns {string[]} 文本行
     */
    function commentLines(list, image) {
      const lines = []
      const label = image && (image.rel || image.name)
      if (label) {
        const sha = image.sha ? String(image.sha).slice(0, 12) : ''
        /* 编号必须与**输入框里的附件顺序**一致：第一张附过去是「图像 1」，第二张是「图像 2」。
           不传 index（旧调用 / 单测）时回落 1。 */
        const index = image && Number.isFinite(image.index) && image.index > 0 ? Math.round(image.index) : 1
        lines.push(`图像 ${index}：${label}${sha ? `（sha256 ${sha}）` : ''}`)
      }
      for (const item of normalizeComments(list)) {
        lines.push(`${item.n}.（x：${item.xPct.toFixed(1)}%，y：${item.yPct.toFixed(1)}%）${item.text}`)
      }
      return lines
    }

    /**
     * 评论挂在谁身上：工作区图用 rel；对话里生成的图没有路径，用附件 sha256 id。
     * **纯函数**。
     * @param {object|null} doc - 媒体条目
     * @returns {string} 锚点 id（空串表示无可锚定）
     */
    function anchorIdFor(doc) {
      if (!doc) return ''
      if (doc.attachmentId) return String(doc.attachmentId)
      const rel = String(doc.rel || '')
      if (/^sha256:[0-9a-f]{64}$/i.test(rel)) return rel
      return rel || (doc.path ? String(doc.path) : '')
    }

    /**
     * 这张图的 sha256（有就取，没有就空串）。工作区图通常没有，对话图一定有。
     * @param {object|null} doc - 媒体条目
     * @returns {string} 64 位十六进制，或空串
     */
    function shaOfDoc(doc) {
      if (!doc) return ''
      const direct = doc.sha256 || doc.sha
      if (typeof direct === 'string' && /^[0-9a-f]{64}$/i.test(direct)) return direct
      const id = String(doc.attachmentId || doc.rel || '')
      const match = /^sha256:([0-9a-f]{64})$/i.exec(id)
      return match ? match[1] : ''
    }

    /** 取某张图的评论（没有就空表）。**纯函数**。 */
    function commentsFor(store, anchor) {
      if (!store || typeof store !== 'object' || !anchor) return []
      return normalizeComments(store[anchor])
    }

    /**
     * 写回某张图的评论：返回**新对象**（不原地改 state），空表则删键不留垃圾。
     * **纯函数**。
     */
    function withComments(store, anchor, list) {
      const base = store && typeof store === 'object' ? store : {}
      const next = { ...base }
      if (!anchor) return next
      const clean = normalizeComments(list)
      if (clean.length) next[anchor] = clean
      else delete next[anchor]
      return next
    }

    /**
     * 图片内容框在**视口坐标**里的矩形（渲染 pin / 编辑气泡用）。
     *
     * 与 `commentClickPct` 共用 `contentRect`：落点与画点永远同一个矩形。
     * @param {object} imgEl - `.knit-lightbox-img`
     * @returns {{left:number,top:number,width:number,height:number}|null} 矩形
     */
    function contentViewportOf(imgEl) {
      try {
        if (!imgEl || typeof imgEl.getBoundingClientRect !== 'function') return null
        const imgRect = imgEl.getBoundingClientRect()
        const natural = { width: imgEl.naturalWidth, height: imgEl.naturalHeight }
        return contentRect(imgRect, natural) || {
          left: imgRect.left, top: imgRect.top, width: imgRect.width, height: imgRect.height,
        }
      } catch { return null }
    }

    /**
     * 评论编辑气泡摆哪：**贴着 pin**，但出屏就从另一侧长出来（与 Infini 分享包同一套翻边逻辑）。
     *
     * 真机上「气泡停在图片边外」就是没有这一步：只按百分比放，靠右/靠下时半截出屏。
     * 规则：默认在 pin 右下；右边放不下翻左，下面放不下翻上；最后再夹进视口。
     * **纯函数**：只吃三个盒子，不读 DOM。
     *
     * @param {{x:number,y:number}} anchor - pin 的视口坐标
     * @param {{width:number,height:number}} size - 气泡尺寸
     * @param {{width:number,height:number}} view - 视口尺寸
     * @param {{gap?:number,margin?:number}} [opts] - 间距与视口留白
     * @returns {{left:number,top:number,placement:'right'|'left',side:'below'|'above'}} 盒子
     */
    function commentPopoverBox(anchor, size, view, opts = {}) {
      const gap = Number.isFinite(opts.gap) ? opts.gap : 14
      const margin = Number.isFinite(opts.margin) ? opts.margin : 12
      const viewW = view && Number.isFinite(view.width) && view.width > 0 ? view.width : 1024
      const viewH = view && Number.isFinite(view.height) && view.height > 0 ? view.height : 768
      const width = Math.max(1, Math.min(size && Number.isFinite(size.width) ? size.width : COMMENT_POP_W, viewW - margin * 2))
      const height = Math.max(1, Math.min(size && Number.isFinite(size.height) ? size.height : COMMENT_POP_H, viewH - margin * 2))
      const ax = anchor && Number.isFinite(anchor.x) ? anchor.x : viewW / 2
      const ay = anchor && Number.isFinite(anchor.y) ? anchor.y : viewH / 2

      let placement = 'right'
      let left = ax + gap
      if (left + width > viewW - margin) { left = ax - width - gap; placement = 'left' }
      left = Math.min(Math.max(margin, left), Math.max(margin, viewW - width - margin))

      let side = 'below'
      let top = ay + gap
      if (top + height > viewH - margin) { top = ay - height - gap; side = 'above' }
      top = Math.min(Math.max(margin, top), Math.max(margin, viewH - height - margin))
      return { left, top, placement, side }
    }

    /**
     * 一次点击落在**图片内容框**的百分比。
     *
     * ⚠️ 这里必须是 `contentRect` → `pctFromPoint` 这条链，**不能**用 stage 的宽度。
     * 源码守卫（test/comments.test.mjs）会检查这个函数的形状；改坏了会红。
     *
     * @param {{clientX:number,clientY:number}} event - 点击事件
     * @param {object} imgEl - `.knit-lightbox-img`
     * @returns {{xPct:number,yPct:number}|null} 百分比
     */
    function commentClickPct(event, imgEl) {
      try {
        if (!event || !imgEl || typeof imgEl.getBoundingClientRect !== 'function') return null
        const imgRect = imgEl.getBoundingClientRect()
        const natural = { width: imgEl.naturalWidth, height: imgEl.naturalHeight }
        const rect = contentRect(imgRect, natural)
        if (!rect) return null
        return pctFromPoint({ x: event.clientX, y: event.clientY }, rect)
      } catch { return null }
    }

    /**
     * 键盘事件是不是发生在**评论输入框**里。
     *
     * 必须在「查看器根上的捕获阶段处理器」里先判它：Escape / 方向键在输入框里
     * 属于「取消编辑 / 移光标」，如果照旧交给查看器，会变成「关查看器 / 翻图」。
     *
     * @param {object} event - 键盘事件
     * @returns {boolean} 是否在评论输入框内
     */
    function commentEditorTarget(event) {
      const target = event && event.target
      if (!target) return false
      if (target.isContentEditable) return true
      try {
        if (typeof target.closest === 'function') return !!target.closest('[data-knit-comment-editor]')
      } catch { /* 老宿主 / 测试替身：当作不在输入框 */ }
      return false
    }

    /**
     * 把评论关联的那张图读成 `File`（**同源、本机**：/knit/api/raw 或 /knit/api/attachment）。
     *
     * 为什么要附件：只发文字时，agent 只能看到文件名/rel；同名文件、被移动的文件、
     * 以及对话里生成的图（没有路径，只有 sha256）都可能对不上。Codex Canvas 的评论
     * 也是把原图随评论一起提交 —— 这里附**原图**（不带 pin），pin 的坐标已经在文本里。
     *
     * @param {string} src - 同源图片地址
     * @param {string} name - 附件文件名
     * @param {{fetch?:Function, File?:Function}} [env] - 可注入（测试用）
     * @returns {Promise<object|null>} File 或 null
     */
    async function imageFileFrom(src, name, env = {}) {
      try {
        const fetchFn = env.fetch || (typeof fetch === 'function' ? fetch : null)
        const FileCtor = env.File || (typeof File === 'function' ? File : null)
        if (!fetchFn || !FileCtor || !src) return null
        const response = await fetchFn(src, { credentials: 'same-origin' })
        if (!response || response.ok === false) return null
        const blob = await response.blob()
        if (!blob || !Number(blob.size)) return null
        const type = blob.type || 'image/png'
        const fallback = type.includes('jpeg') ? 'image.jpg' : type.includes('webp') ? 'image.webp' : 'image.png'
        return new FileCtor([blob], name || fallback, { type })
      } catch { return null }
    }

    /**
     * 造一个合成 paste 事件（真浏览器用原生构造器；测试替身用同契约的普通对象）。
     * 事件里**同时**带 text/plain 与（可选）图片 File —— DSH 输入框的 paste 处理器
     * 会先 intake 文件、再插入文本（`keymap.ts` 的 PASTE_COMMAND）。
     * @param {string} text - 要粘贴的纯文本
     * @param {object|null} win - window
     * @param {object|null} [file] - 可选图片 File
     * @returns {object} 事件
     */
    function buildPasteEvent(text, win, file) {
      const payload = String(text)
      const DT = win && win.DataTransfer
      const CE = win && win.ClipboardEvent
      if (typeof DT === 'function' && typeof CE === 'function') {
        try {
          const transfer = new DT()
          transfer.setData('text/plain', payload)
          if (file && transfer.items && typeof transfer.items.add === 'function') transfer.items.add(file)
          return new CE('paste', { clipboardData: transfer, bubbles: true, cancelable: true })
        } catch { /* 落下去用普通对象 */ }
      }
      return {
        type: 'paste',
        clipboardData: {
          getData: (kind) => (kind === 'text/plain' || !kind ? payload : ''),
          files: file ? [file] : [],
          items: file ? [{ kind: 'file', type: file.type || '', getAsFile: () => file }] : [],
        },
        bubbles: true,
        cancelable: true,
        defaultPrevented: false,
        preventDefault() { this.defaultPrevented = true },
      }
    }

    /** 造一个合成 drop 事件（契约同上）。 */
    function buildDropEvent(text, win) {
      const payload = String(text)
      const DT = win && win.DataTransfer
      const DE = win && win.DragEvent
      if (typeof DT === 'function' && typeof DE === 'function') {
        try {
          const transfer = new DT()
          transfer.setData('text/plain', payload)
          return new DE('drop', { dataTransfer: transfer, bubbles: true, cancelable: true })
        } catch { /* 落下去用普通对象 */ }
      }
      return {
        type: 'drop',
        dataTransfer: { getData: (kind) => (kind === 'text/plain' || !kind ? payload : '') },
        bubbles: true,
        cancelable: true,
        defaultPrevented: false,
        preventDefault() { this.defaultPrevented = true },
      }
    }

    /**
     * 输入框当前状态：已附件几张图、有没有正文。**只读 DOM，不改任何东西**。
     *
     * 用途有两个：
     * ① 新评论的编号 = 已有附件数 + 1（「附件一就是图像一」）；
     * ② 已经有正文时，这次投递前面要空一行（独立段落），不能拼在上一句后面。
     *
     * @param {object|null} doc - document（测试可注入）
     * @returns {{count:number, hasText:boolean}} 状态
     */
    function composerState(doc) {
      const empty = { count: 0, hasText: false }
      try {
        if (!doc || typeof doc.querySelector !== 'function') return empty
        const input = doc.querySelector('[data-composer-input]')
        if (!input) return empty
        const hasText = typeof input.textContent === 'string' && input.textContent.trim() !== ''
        let count = 0
        const card = typeof input.closest === 'function' ? input.closest('[data-composer-card]') : null
        if (card && typeof card.querySelectorAll === 'function') {
          count = [...card.querySelectorAll('img')].filter((img) => {
            const src = String((img && img.src) || '')
            if (src.startsWith('blob:')) return true
            const parent = img && img.parentElement
            return /thumbnail/i.test(String((parent && parent.className) || ''))
          }).length
        }
        return { count, hasText }
      } catch { return empty }
    }

    /** 把光标放到输入框末尾（否则 paste 会插在当前光标处，段落会断在中间）。 */
    function caretToEnd(input, win, doc) {
      try {
        if (!input || !win || typeof win.getSelection !== 'function') return
        if (!doc || typeof doc.createRange !== 'function') return
        const selection = win.getSelection()
        if (!selection) return
        const range = doc.createRange()
        range.selectNodeContents(input)
        range.collapse(false)
        selection.removeAllRanges()
        selection.addRange(range)
      } catch { /* 拿不到 selection 就按默认光标位置投递 */ }
    }

    /**
     * 把一段文本投进**输入框**（不发送）。通道照 dsh-image-annotate 的已验证做法：
     * 合成 paste 到 `[data-composer-input]`；失败按序回落 document drop → clipboard → 下载。
     *
     * ⚠️ 只借通道，不引入依赖、不 import 那个插件；零网络出口（clipboard / 下载都是本机）。
     *
     * @param {string} text - 要投递的文本
     * @param {{document?:object, window?:object, fetch?:Function, File?:Function, attachment?:{src:string,name?:string}}} [env] - 可注入（测试用）
     * @returns {Promise<{ok:boolean, via:'paste'|'drop'|'clipboard'|'download'|'none', image:boolean}>} 结果
     */
    async function deliverCommentText(text, env = {}) {
      const payload = String(text === undefined || text === null ? '' : text)
      if (!payload) return { ok: false, via: 'none', image: false }
      const doc = env.document === undefined ? (typeof document === 'undefined' ? null : document) : env.document
      const win = env.window === undefined ? (typeof window === 'undefined' ? null : window) : env.window
      const file = env.attachment ? await imageFileFrom(env.attachment.src, env.attachment.name, env) : null
      /* 每次发送 = **独立段落**：输入框里已经有正文时，前面空两行再投；没有就原样。
         （只加前缀不补后缀 —— 下一次发送自己会补，避免末尾多出空行。） */
      const existing = (() => {
        try {
          const probe = doc && typeof doc.querySelector === 'function' ? doc.querySelector('[data-composer-input]') : null
          return probe && typeof probe.textContent === 'string' ? probe.textContent.trim() : ''
        } catch { return '' }
      })()
      const body = existing ? `\n\n${payload}` : payload

      // ① 合成 paste 到输入框（文本 + 图片 File 同一个事件）
      const input = doc && typeof doc.querySelector === 'function' ? doc.querySelector('[data-composer-input]') : null
      if (input && typeof input.dispatchEvent === 'function') {
        try { if (typeof input.focus === 'function') input.focus() } catch { /* 拿不到焦点也继续 */ }
        try { caretToEnd(input, win, doc) } catch { /* 光标放不到末尾就按默认位置 */ }
        const before = typeof input.textContent === 'string' ? input.textContent : ''
        try {
          const event = buildPasteEvent(body, win, file)
          const notPrevented = input.dispatchEvent(event)
          const after = typeof input.textContent === 'string' ? input.textContent : ''
          /* 宿主（Lexical）收到 paste 会 `preventDefault()` ⇒ dispatchEvent 返回 false。
             ⚠️ **不要在这里补第二次 paste**：编辑器的文本更新不保证同步，`textContent` 可能
             还没变，补一次就会把同一段文本/图片塞两遍（真机踩过：输入框里出现两遍）。
             preventDefault 返回 true 而 textContent 仍没变（极老宿主）时交给下面的 drop 回落。 */
          if (notPrevented === false || (event && event.defaultPrevented) || after !== before) {
            return { ok: true, via: 'paste', image: !!file }
          }
        } catch { /* 换下一条通道 */ }
      }

      // ② document 上的 drop
      if (doc && typeof doc.dispatchEvent === 'function') {
        try {
          const event = buildDropEvent(body, win)
          if (doc.dispatchEvent(event) === false || (event && event.defaultPrevented)) return { ok: true, via: 'drop', image: false }
        } catch { /* 换下一条通道 */ }
      }

      // ③ 剪贴板
      try {
        const clipboard = win && win.navigator && win.navigator.clipboard
        if (clipboard && typeof clipboard.writeText === 'function') {
          await clipboard.writeText(body)
          return { ok: true, via: 'clipboard', image: false }
        }
      } catch { /* 换下一条通道 */ }

      // ④ 下载一个 .txt
      try {
        const BlobCtor = win && win.Blob
        const UrlApi = win && win.URL
        if (BlobCtor && UrlApi && typeof UrlApi.createObjectURL === 'function' && doc && typeof doc.createElement === 'function') {
          const url = UrlApi.createObjectURL(new BlobCtor([body], { type: 'text/plain;charset=utf-8' }))
          const anchor = doc.createElement('a')
          anchor.href = url
          anchor.download = 'knit-comments.txt'
          if (typeof anchor.click === 'function') anchor.click()
          if (typeof UrlApi.revokeObjectURL === 'function') UrlApi.revokeObjectURL(url)
          return { ok: true, via: 'download', image: false }
        }
      } catch { /* 全部通道都不行 */ }

      return { ok: false, via: 'none', image: false }
    }

    /** 浮窗与卡片之间的间距。 */
    const HOVER_SHOT_GAP = 12
    /** 浮窗与视口边缘的最小留白。 */
    const HOVER_SHOT_MARGIN = 12
    /** 停多久才出现 —— 短了会在鼠标扫过时一路闪，长了会显得没反应。 */
    const HOVER_SHOT_DELAY_MS = 350
    /** 从卡片挪到浮窗上要多久才收 —— 浮窗现在是**评论入口**（可点），
        立即收会让鼠标还没走到按钮它就消失了。 */
    const HOVER_SHOT_HIDE_MS = 220

    /**
     * 算悬停浮窗的盒子。**纯函数**：只吃两个矩形，不做任何 DOM 读。
     *
     * 规则：默认摆在卡片**左侧**（面板在右边，浮窗往对话区那边让，不压住网格）；
     * 左边放不下就翻到右侧；垂直以卡片中线居中并夹进视口；盒子边长**最后**夹到 800。
     *
     * @param {{left:number,top:number,width:number,height:number}|null} card - 卡片矩形
     * @param {{width:number,height:number}} view - 视口尺寸
     * @param {{max?:number,gap?:number,margin?:number}} [opts] - 可注入的常数（测试用）
     * @returns {{left:number,top:number,width:number,height:number,side:'left'|'right'}} 盒子
     */
    function hoverShotBox(card, view, opts = {}) {
      const max = Number.isFinite(opts.max) ? opts.max : HOVER_SHOT_MAX
      const gap = Number.isFinite(opts.gap) ? opts.gap : HOVER_SHOT_GAP
      const margin = Number.isFinite(opts.margin) ? opts.margin : HOVER_SHOT_MARGIN
      const viewW = view && Number.isFinite(view.width) ? view.width : 1024
      const viewH = view && Number.isFinite(view.height) ? view.height : 768
      // 拿不到卡片矩形（测试替身没有 DOM / 事件不带 currentTarget）⇒ 视口里居中，仍然守 800 上限
      if (!card || !Number.isFinite(card.left) || !Number.isFinite(card.top)) {
        const size = Math.min(max, viewW - margin * 2, viewH - margin * 2)
        return {
          left: Math.max(margin, Math.round((viewW - size) / 2)),
          top: Math.max(margin, Math.round((viewH - size) / 2)),
          width: size,
          height: size,
          side: 'right',
        }
      }
      const roomLeft = card.left - gap - margin
      const roomRight = viewW - (card.left + card.width) - gap - margin
      const side = roomLeft >= roomRight ? 'left' : 'right'
      const room = Math.max(0, side === 'left' ? roomLeft : roomRight)
      const width = Math.max(1, Math.min(max, room, viewW - margin * 2))
      const height = Math.max(1, Math.min(max, viewH - margin * 2, width * 1.6))
      const rawLeft = side === 'left' ? card.left - gap - width : card.left + card.width + gap
      const left = Math.min(Math.max(margin, Math.round(rawLeft)), Math.max(margin, viewW - margin - width))
      const centerY = card.top + card.height / 2 - height / 2
      const top = Math.min(Math.max(margin, Math.round(centerY)), Math.max(margin, viewH - margin - height))
      return { left, top, width, height, side }
    }

    /* ── v0.25：媒体收藏 ───────────────────────────────────────────────────
       只活在 localStorage（`readPref / writePref` 那一族：这是**语义偏好**，不是界面几何）。
       **不改宿主、不加接口** ⇒ 只需要硬刷新，不用重启 DSH。

       顺序规则只有一条：**稳定分区** —— 收藏的按原有顺序排到前面，其余按原有顺序跟在后面。
       刻意**不做第二套排序**（不按收藏时间排、不按文件名排）：用户要的是「收藏的放最前面」，
       而收藏之间谁在前仍由当前的「相关 / 最新」决定 —— 这样它不会变成第三种排序口径。

       ⚠️ 与既有的「固定 / 排除」（`control.*`，宿主存储 `knit_control`）**不是同一件事**：
       那一套只服务三层 Context Pack，媒体不参与，媒体卡片上也没有那个入口。
    */

    /** 落盘的键。值形如 `{ "<root>": ["a.png", "b.mp4"] }`。 */
    const FAV_KEY = 'dsh-knit:favorites'
    /** 最多记几个工作区（换项目时旧的不会无限长）。 */
    const FAV_MAX_ROOTS = 5
    /** 每个工作区最多记几条（超了按写入顺序截断，不做 LRU）。 */
    const FAV_MAX_RELS = 200

    /**
     * 把落盘的值解析成 `{ [root]: string[] }`。
     *
     * 畸形输入一律回空表，**不许抛** —— localStorage 里的东西可能是上一版、手改过的、
     * 或者干脆是别的插件写坏的；这里坏了不能让整个面板白掉。
     *
     * @param {string|null} raw - localStorage 里的原始字符串
     * @returns {Object<string, string[]>} 归一化后的表
     */
    function parseFavorites(raw) {
      if (typeof raw !== 'string' || !raw) return {}
      let data = null
      try { data = JSON.parse(raw) } catch { return {} }
      if (!data || typeof data !== 'object' || Array.isArray(data)) return {}
      const out = {}
      for (const root of Object.keys(data)) {
        const list = data[root]
        if (!Array.isArray(list)) continue
        const rels = []
        for (const rel of list) {
          if (typeof rel === 'string' && rel && rels.indexOf(rel) < 0) rels.push(rel)
          if (rels.length >= FAV_MAX_RELS) break
        }
        if (rels.length) out[root] = rels
      }
      return out
    }

    /**
     * 某个工作区下的收藏。
     * @param {Object<string, string[]>} table - `parseFavorites()` 的产物
     * @param {string} root - 工作区根（未知时回空数组）
     * @returns {string[]} 副本
     */
    function favoriteRelsFor(table, root) {
      const key = typeof root === 'string' ? root : ''
      if (!key || !table || !Array.isArray(table[key])) return []
      return table[key].slice()
    }

    /**
     * 加 / 取消一条收藏，返回**新数组**（不改入参）。
     * 新加的排到最前 —— 同一次会话里立即可见，不用等重新排序。
     *
     * @param {string[]} rels - 当前收藏
     * @param {string} rel - 目标
     * @returns {string[]} 新数组
     */
    function toggleFavoriteList(rels, rel) {
      const list = Array.isArray(rels) ? rels.slice() : []
      if (typeof rel !== 'string' || !rel) return list
      const at = list.indexOf(rel)
      if (at >= 0) { list.splice(at, 1); return list }
      list.unshift(rel)
      return list.slice(0, FAV_MAX_RELS)
    }

    /**
     * 收藏的排到最前（**稳定**：两组内部都保持入参顺序）。
     * 没有收藏时**原样返回同一个数组**（同一引用，省一次无意义的重渲染）。
     *
     * @param {object[]} docs - 当前可见条目
     * @param {Set<string>|string[]} favorites - 收藏的 rel
     * @returns {object[]} 排好序的数组（或原数组）
     */
    function orderFavorites(docs, favorites) {
      const list = Array.isArray(docs) ? docs : []
      const has = (rel) => (favorites instanceof Set
        ? favorites.has(rel)
        : (Array.isArray(favorites) && favorites.indexOf(rel) >= 0))
      if (!list.length) return list
      const first = []
      const rest = []
      for (const doc of list) {
        if (doc && has(doc.rel)) first.push(doc)
        else rest.push(doc)
      }
      return first.length ? first.concat(rest) : list
    }

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


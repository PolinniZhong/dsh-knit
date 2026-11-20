    function ensureStyle() {
      if (typeof document === 'undefined') return
      const existing = document.getElementById(STYLE_ID)
      if (existing) {
        /* ⚠️ **必须比对内容，不能「有就跳过」**：客户端插件热换（HMR）只替换 JS 模块、
           不重载页面，`<style>` 元素会留在 DOM 里 —— 旧版那行 `if (existing) return`
           于是让新加的规则一条都不生效：新 DOM 按旧 CSS 排版，评论编辑框/评论栏被当成
           普通 flex 子项挤到图片右边（真机就是这么看到「停在边上」的）。
           现在内容不一致就整段换掉，下一次渲染立刻追上当前代码。 */
        if (existing.textContent !== CSS) existing.textContent = CSS
        return
      }
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
     *
     * v0.23.1：「全部」档已整体删除 ⇒ 白名单里的 `'all'` 也删掉 ——
     * 老用户 localStorage 里存着 `'all'` 时**回落到 `文档`**（不空白、不抛）。
     * @returns {'doc'|'code'|'media'|'changes'} 类型
     */
    function readKindPref() {
      const v = readPref(KIND_KEY)
      return v === KIND_MEDIA || v === KIND_CODE || v === KIND_CHANGES ? v : KIND_DOC
    }

    /**
     * 读上次是否打开了「使用情况」。**默认关**（没写过就是关）。
     * @returns {boolean} 是否记账
     */
    function readUsagePref() {
      return readPref(USAGE_KEY) === '1'
    }

    /**
     * 读用户上次选的检索模式。**没写过、写坏了都回词法**（默认值是安全的那一个）。
     * @returns {'lexical'|'hybrid'} 检索模式
     */
    function readRetrievalPref() {
      return readPref(RETRIEVAL_KEY) === 'hybrid' ? 'hybrid' : 'lexical'
    }

    /**
     * 读「Git 变更关联」开关。**没写过、写坏了都是关** —— 默认值必须是「不动基础检索行为」那一个。
     * @returns {boolean} 是否开启
     */
    function readChangesPref() {
      return readPref(CHANGES_KEY) === '1'
    }

    /** 宿主给的 Git 原因码 → i18n 键（与 `semanticReasonKey` 同一条纪律：宿主只给码）。 */
    function changeReasonKey(reason) {
      if (reason === 'not-a-repo') return 'changes.reason.notARepo'
      if (reason === 'git-missing') return 'changes.reason.gitMissing'
      if (reason === 'timeout') return 'changes.reason.timeout'
      if (reason === 'output-too-large') return 'changes.reason.tooLarge'
      if (reason === 'failed-fatal') return 'changes.reason.failed'
      // v0.25 收尾：这一条**不是**宿主的原因码，而是客户端自己的 —— 独立接口那次请求本身
      // 失败（网络/解析异常、非 ok 响应）。「读不到 git」与「没问到」是两件事，不许都写成
      // 「原因未知」，否则用户分不清该去检查仓库还是该重试。
      if (reason === 'request') return 'changes.reason.request'
      return 'changes.reason.unknown'
    }

    /**
     * provider 地址是不是**本机回环**。只有回环才敢说「内容不离开这台机器」；
     * 其它（含空地址）一律按「会发送到你配置的服务」披露 —— 宁可说得重一点。
     * @param {string} base - 服务地址
     * @returns {boolean} 是否回环
     */
    function isLoopbackBase(base) {
      const text = String(base || '').trim().toLowerCase()
      if (!text) return false
      const host = text.replace(/^[a-z][a-z0-9+.-]*:\/\//, '').split('/')[0].replace(/:\d+$/, '')
      return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]'
    }

    /**
     * 把一个选择器对应的元素聚焦。**只在真浏览器里有用**：测试替身（test/harness.mjs）
     * 没有真 `document`，SSR 里也没有 —— 所以整段包在 try 里，失败一律静默（聚焦失败
     * 不该影响任何行为，更不能让面板崩）。
     * @param {string} selector - CSS 选择器
     */
    function focusFirst(selector) {
      try {
        if (typeof document === 'undefined' || !document || typeof document.querySelector !== 'function') return
        const node = document.querySelector(selector)
        if (node && typeof node.focus === 'function') node.focus()
      } catch (error) {
        // 故意吞掉：焦点是锦上添花，不是功能
      }
    }

    /**
     * 宿主给的 reason 码 → i18n 键。**宿主只给码、不给文案**（AGENTS.md §4.5）。
     * @param {string} reason - 宿主码
     * @returns {string} i18n 键
     */
    function semanticReasonKey(reason) {
      if (reason === 'no-provider') return 'sem.reason.noProvider'
      if (reason === 'probe-failed') return 'sem.reason.probeFailed'
      if (reason === 'timeout') return 'sem.reason.timeout'
      if (reason === 'bad-response') return 'sem.reason.badResponse'
      if (reason === 'no-query') return 'sem.reason.noQuery'
      // 防御性：时间序下宿主整层短路（`not-applicable`）。那档下拉根本不出现，
      // 但老/新宿主混合时仍可能回这个码 ⇒ 不许掉进「原因未知」。
      if (reason === 'not-applicable') return 'sem.reason.notApplicable'
      return 'sem.reason.unknown'
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
     * 对话里生成的图（v0.25）的字节地址。
     *
     * ⚠️ **只传 sha256 id，不传路径** —— 宿主那条路由只认 `sha256:<64 hex>`，而且只读
     * **本会话出现过**的 id。这不是硬凑的 URL 形状，是那条边界的全部：给不出路径就没有穿越。
     *
     * @param {string} sessionId - 会话 id
     * @param {string} id - `sha256:<64 hex>`
     * @returns {string} 同源地址
     */
    function attachmentUrl(sessionId, id) {
      return `${ATTACH_RAW_API}?sessionId=${encodeURIComponent(sessionId)}&id=${encodeURIComponent(id)}`
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

    /**
     * v0.25 收尾：把独立接口那份载荷归成**三种状态之一**（状态行与列表提示共用同一个判断）。
     *
     * @param {object|null} data - `state.changes`
     * @returns {{read: boolean, reason: string|null, filesTotal: number, hasRows: boolean}}
     *   `read=false` ⇒ 读不到（接口失败或 git 读不到），`reason` 是给用户看的原因码；
     *   `read=true`  ⇒ 拿到了 git 事实，`filesTotal` 是变更文件数。
     */
    function changeStatusOf(data) {
      if (!data) return { read: false, reason: null, filesTotal: 0 }
      if (data.failed === true) return { read: false, reason: data.reason || 'request', filesTotal: 0 }
      const git = data.git || null
      if (!git || git.available !== true) {
        return { read: false, reason: (git && git.reason) || 'unknown', filesTotal: 0 }
      }
      return { read: true, reason: null, filesTotal: Number(git.filesTotal) || 0 }
    }

    /**
     * v0.25：`/knit/api/changes` 的**专用结构** → 列表行（只做形状映射，不做判断）。
     *
     * 宿主给的是「变更起点 / 关联目标 / 关系类型 / 行号」这套事实；这里把它摊成与列表行
     * 同形状的一层，好让**既有那套行渲染 + 证据弹层**直接用上（零第二条渲染路径）。
     * 两个刻意的决定：
     *   · `provenance: 'change'` 是**客户端自己**给这一区贴的来源词（宿主的结构里没有这个词），
     *     只决定行右端那个「变更关联」；**不给 `reason`** —— 见下面那段说明；
     *   · 证据行映射回 `{type, dir, other: 起点, line}`：`other` = 那个被改过的文件，
     *     与 v0.21 的行级证据**逐字同源**，所以弹层里「谁 · 什么 · 第几行」照旧可读。
     *
     * @param {object|null} data - `/knit/api/changes` 的载荷
     * @returns {Array<object>} 行（没有数据 ⇒ 空数组，调用方据此不渲染这一区）
     */
    function changeRowsOf(data) {
      const links = (data && Array.isArray(data.links)) ? data.links : []
      return links.map((link) => ({
        rel: link.target,
        title: link.title || link.target,
        summary: link.summary || '',
        mtimeMs: link.mtimeMs,
        kind: link.kind,
        source: link.source,
        provenance: 'change',
        // ⚠️ **刻意不给 `reason`**（v0.25 收尾）：`changeRelated` 那个理由码曾经让宿主
        // 「声明了一个自己不再产出」的码。现在「为什么在这一区」由**区标题 + 提示句**回答
        // （「变更关联 / 由未提交的改动牵出」），每一行的**具体依据**在证据弹层里
        // （类型 + 起点 + 行号）—— 行级渲染本来就不给没有 reason 的条目出那一行。
        relations: (Array.isArray(link.evidence) ? link.evidence : []).map((e) => ({
          type: e.type,
          dir: e.dir,
          other: e.origin,
          // `line` 是 `null` 时**不给这个键** —— 弹层据此说「文件名约定，没行号」
          ...(Number.isInteger(e.line) ? { line: e.line } : {}),
        })),
        ...(Number.isInteger(link.evidenceTotal) && link.evidenceTotal > (Array.isArray(link.evidence) ? link.evidence.length : 0)
          ? { relationsTotal: link.evidenceTotal } : {}),
      }))
    }

    /**
     * 一个变更条目 → 状态词（只给一枚主徽标，`kinds` 的完整集合仍随行带出）。
     * @param {string[]} kinds - `git status` 的 kinds
     * @returns {string} modified|added|deleted|renamed|untracked|unmerged|copied
     */
    function changeStatusOfFile(kinds) {
      const list = Array.isArray(kinds) ? kinds : []
      if (list.includes('unmerged')) return 'unmerged'
      if (list.includes('untracked')) return 'untracked'
      if (list.includes('deleted')) return 'deleted'
      if (list.includes('renamed')) return 'renamed'
      if (list.includes('added')) return 'added'
      if (list.includes('copied')) return 'copied'
      return 'modified'
    }

    /**
     * `/knit/api/status` 的 `git.files` → 列表行（只做形状映射；只收 Markdown / 代码）。
     *
     * 变更档的列表行**就是**既有 `DocRow`：点开走同一条预览路径，不新开第二套渲染。
     * 额外的 `change` 字段只负责状态徽标与 `+N −N`，不影响键盘 / 预览。
     *
     * @param {object|null} data - `/knit/api/status` 的载荷
     * @returns {Array<object>} 行（`rel/title/name/summary/kind/mtimeMs/change`）
     */
    function changeDocsOf(data) {
      const files = data && data.git && Array.isArray(data.git.files) ? data.git.files : []
      const out = []
      for (const file of files) {
        if (!file || file.isDir === true) continue
        const kind = file.kind
        if (kind !== ARTIFACT_DOC && kind !== ARTIFACT_CODE) continue
        const rel = String(file.rel || '')
        if (!rel) continue
        const parts = rel.split('/')
        const name = parts[parts.length - 1]
        const dir = parts.slice(0, -1).join('/')
        out.push({
          rel,
          title: name,
          name,
          summary: dir ? `${dir}/` : '',
          kind,
          mtimeMs: Number.isFinite(file.mtimeMs) ? file.mtimeMs : 0,
          size: Number.isFinite(file.bytes) ? file.bytes : 0,
          change: {
            status: changeStatusOfFile(file.kinds),
            added: Number.isFinite(file.added) ? file.added : null,
            removed: Number.isFinite(file.removed) ? file.removed : null,
            binary: file.binary === true,
            untracked: file.untracked === true,
            deleted: file.deleted === true,
            ...(file.origRel ? { origRel: file.origRel } : {}),
          },
        })
      }
      return out
    }

    /**
     * 一个条目符不符合过滤框里的那串字（标题 / 摘要 / 相对路径）。
     *
     * v0.25 抽出来的：`visibleDocs`（列表那一份）与「变更关联」区都要用同一条判据 ——
     * 用户在搜索框里打了字，两处都该跟着收窄，而**两处都不许**各自写一份。
     *
     * @param {object} doc - 条目（面板条目或宿主给的记录）
     * @param {string} q - 已经 trim + toLowerCase 过的查询串；空串表示不过滤
     * @returns {boolean}
     */
    function docMatchesQuery(doc, q) {
      if (!q) return true
      return String(doc.title || '').toLowerCase().includes(q)
        || String(doc.summary || '').toLowerCase().includes(q)
        || String(doc.rel || '').toLowerCase().includes(q)
    }

    /**
     * 命中片段的**行号区间**文本（v0.20，需求 §11 / §12）。
     *
     * 只用 en dash 连起来 —— 不加 `L` 前缀、不加「行」字（i18n 的整句已经有「命中片段：」），
     * 也**不加**任何分数/百分比：行号是事实，可核验（拿行号去文件里数就是那一段）。
     *
     * @param {{startLine?:number, endLine?:number}|null} match - `doc.matches[]` 的一项
     * @returns {string} 例如 `147–163`；拿不到行号时返回空串
     */
    function fmtRange(match) {
      const a = match && Number.isFinite(match.startLine) ? Math.max(1, Math.floor(match.startLine)) : 0
      if (!a) return ''
      const b = match && Number.isFinite(match.endLine) ? Math.max(a, Math.floor(match.endLine)) : a
      return a === b ? String(a) : `${a}–${b}`
    }

    /**
     * 一行里要点亮/滚动过去的片段：**只认第一个**（v0.20，需求 §12）。
     *
     * 需求给列表行只留了一行「命中片段：147–163」；宿主最多给 2 段（`PASSAGE_MAX_PER_FILE`），
     * 第二段在列表里**不显示**（§16「不许多给」），但滚动区间仍取第一段的完整范围。
     *
     * @param {object} doc - 条目
     * @returns {object|null} 第一段命中，或 null
     */
    function firstMatchOf(doc) {
      const list = doc && Array.isArray(doc.matches) ? doc.matches : null
      if (!list || list.length === 0) return null
      return list[0] || null
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
      // 「直接命中」后面跟一个「knit · client」）—— 它读起来是**标签 + 值**，不是一句话。
      const shown = terms.slice(0, 2).join(' · ')
      const key = `why.${reason.code}`
      // v0.23 加固：**先看词典里有没有这个码**，再有条件地交给 `t()`。
      // 未知码不赌官方 `bind()` 的缺失键行为（可能是 `undefined`），而是把键名显示出来 ——
      // 宿主加了新码而客户端还没跟上时，用户看到 `why.xxx` 这种明显异常，
      // 而不是一条静默的空行，更不是一个 `undefined`。
      // （`ZH` 与 `EN` 的键集由 `test/i18n.test.mjs` 守齐，所以只查一本就够。）
      if (ZH[key] === undefined) return key
      if (!terms.length) {
        const plain = `${key}Plain`
        return ZH[plain] !== undefined ? t(plain) : t(key)
      }
      return t(key, { term: shown })
    }

    /**
     * v0.23：来源徽标的文案。**只认词典里真有的那几档**
     * （`retrieval` / `relation` / `manual` / `semantic`）；未知值一律 `null` ⇒ **不给徽标**。
     *
     * 为什么不把未知值交给 `t()`：来源是宿主给的字符串，客户端不认识时既不该抛，
     * 也不该把裸码（`prov.mystery`）或 `undefined` 渲染到界面上 —— 与 `DocRow` 调用点
     * 那条纪律同源：「平铺列表里的条目来源未知，不能替它认领一个『检索』」。
     *
     * @param {unknown} provenance - 宿主给的那一档
     * @returns {string|null} 文案或 null
     */
    function provText(provenance) {
      if (typeof provenance !== 'string' || provenance.length === 0) return null
      const key = `prov.${provenance}`
      return ZH[key] !== undefined ? t(key) : null
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
    /** v0.19：「全部」档里的代码区自己的区名 —— 幽灵行要插回**它原来那一区**，共用会插错位置。 */
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
     * 入场补间播完时的**收尾**：注销补间 + 清掉那两行内联样式。
     *
     * ⚠️ `cancel()` 不是可省的礼节，是这件事的全部要点：入场补间用 `fill:'both'`
     * （延迟期间要按住 `height:0`），而 **fill 会在补间播完之后继续生效** ——
     * 于是这一行被**入场那一刻量到的高度**永久钉住；`el.style.height=''` 清不掉它
     * （内联样式与补间效果是两层）。后果：之后行内长出新的内容（点开「检索」多出来的
     * 那几条行级证据）不会把下面的行挤下去，而是**溢出到下一行上面**。
     * 2026-10-09 用户真机截图报的「检索的数据压在下一个列表的下面」就是它。
     *
     * 纯对象即可测（替身里没有 DOM，跑不到 DocRow 那段 layout effect ⇒
     * `test/client.test.mjs` 直接喂假 el / 假 anim 守这一条，并另有一条钉住调用点）。
     *
     * @param {{style?: object}|null} el - 行节点
     * @param {{cancel?: Function}|null} anim - `el.animate()` 返回的补间
     */
    function settleEnterAnim(el, anim) {
      if (anim && typeof anim.cancel === 'function') {
        try {
          anim.cancel()
        } catch (err) { /* cancel 抛错也不能把收尾卡住 */ }
      }
      if (el && el.style) {
        el.style.height = ''
        el.style.overflow = ''
      }
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
      glyph, onGlyph, onSelect, onOpenTab, passage, onPassage, optionId, entering, leaving,
      // ── v0.21（需求 §6.3 / §8）：来源徽标、行级证据、固定与排除 ──────────
      // 全部是**可选** props：平铺列表（时间序 / 过滤结果）一个都不传，那一屏与 v0.20
      // 逐字相同。`onAct` 为 null ⇒ 不渲染动作按钮；`relations` 为空 ⇒ 「为什么」退回
      // 纯文本（没有证据就不装成有证据的样子）。
      prov, pinned, onAct, relations, relationsTotal, whyOpen, onWhyToggle, onOpenRelation,
      // v0.26.x 变更档：一个可选的 `change` 只负责「状态徽标 + +N −N」，其余路径不变。
      change }) {
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
        /* 只有**真的要补间**时才量行高：`getBoundingClientRect()` 会强制整棵树重排，而这一屏里
           可能正挂着一个几千行、上万个 token span 的代码预览 —— 白量一次 ≈ 0.25s（4× 节流实测）。
           这个 effect 没有依赖数组（每次提交都跑），所以这行早退就是「别白量」的全部。 */
        if (!leaving && (entering === null || entering === undefined)) return
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
        // 进入：先把高度收成 0 再补间到自然高度 —— 下面的行是被**挤**下去的，不是跳下去的
        // （原型里踩过的坑：不先量自然高度，插入瞬间会把下面那行蹬一下）。
        el.style.overflow = 'hidden'
        const anim = el.animate([
          { height: '0px', transform: 'translateY(26px)', opacity: 0, filter: 'blur(3px)' },
          { height: `${height}px`, transform: 'translateY(0)', opacity: 1, filter: 'blur(0px)' },
        ], { duration: MOTION_ENTER_MS, delay: entering, easing: MOTION_EASE, fill: 'both' })
        const done = anim && anim.finished
        // ⚠️ 收尾必须**注销补间**（`settleEnterAnim` 里那句 `cancel()`）——
        //    只清 `el.style.height` 会把这一行按入场高度永久钉住，之后点开「检索」
        //    长出来的证据列表就只会溢出到下一行上面（2026-10-09 用户真机反馈）。
        const settle = () => settleEnterAnim(el, anim)
        if (done && typeof done.then === 'function') done.then(settle).catch(settle)
        else settle()
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
          change
            ? h('span', { className: 'knit-change-badge' }, t(`changes.status.${change.status}`))
            : null,
          change && !change.binary && (Number.isFinite(change.added) || Number.isFinite(change.removed))
            ? h('span', { className: 'knit-change-count' },
                Number.isFinite(change.added) ? h('span', { className: 'knit-change-add' }, `+${change.added}`) : null,
                Number.isFinite(change.removed) ? h('span', { className: 'knit-change-del' }, `−${change.removed}`) : null)
            : (change && change.binary ? h('span', { className: 'knit-change-count knit-change-binary' }, t('changes.binary')) : null),
          // v0.17：生命周期状态（文案已算好；没有证据时是 null，一个节点都不加）。
          // 插在**标题与时间之间**：`.knit-title` 是 flex:1 1 auto，会把状态与时间一起推到
          // 行尾，状态在时间左侧、行尾仍然是时间。
          // ⚠️ 状态是**纯文字**：不加图标、不加底色、不加边框、不用红绿表达好坏 ——
          //    它陈述事实，不是评分（AGENTS.md §6.2 / PRD §7.3）。字号比标题弱一档，
          //    永远不抢标题。
          life ? h('span', { className: 'knit-life' }, life) : null,
          // 时间在标题右边的行尾 —— 靠 .knit-title 的 flex-grow 推过去，不是靠 margin。
          // ⚠️ 2026-10-08 用户规格：标题行**到此为止** —— 只剩「序号 · 标记 · 标题 · 时间」。
          //    来源词（检索 / 关系 / 用户固定）与固定 / 排除原来都挤在这一行的右端，
          //    现在全部搬到下面那条证据行的右端（见 `.knit-subrow` / `.knit-rowacts`）。
          //    原因：来源与命中段、理由说的是**同一件事的两级证据**，而固定 / 排除是
          //    操作入口 —— 四样东西并排 = 标题行信息过载，且每一行都重复一遍。
          h('div', { className: 'knit-time' }, relTime(doc.mtimeMs, now))),
        doc.summary
          ? h('div', { className: 'knit-sum' }, doc.summary)
          : (change ? null : h('div', { className: 'knit-sum empty' }, t('summary.empty'))),
        // ⚠️ **列表行里不再有路径**（2026-09-29 用户要求）：「文档列表中的文档路径，我觉得
        //    不需要出现了，因为点开查看文档详情的时候已经有了，所以这里是重复的，隐藏掉」。
        //    —— 这是**重复信息**，不是「多列砍字段」那种静默降级：预览头
        //    （`.knit-preview-path`：目录收敛成 `…/` + 文件名亮，还可点）已经能定位到是哪一篇，
        //    完整相对路径在它的悬停提示里。
        //    所以删掉的是 `.knit-meta` 这一个节点，**摘要仍然任何情况下都不许 display:none**。
        //    行的定位不走可见路径：`data-knit-rel` 仍在（键盘 / 预览映射靠它）。
        // v0.14：为什么这一篇在这个层里。只有 Context Pack 的条目才有 ——
        // 时间序 / 平铺列表里不渲染这一行（不编造理由）。
        // v0.20（2026-10-07 用户裁决）：**命中段在前、理由在后，同一条 metadata 行**，
        //    中间一条 1px 中性竖线。理由：两条说的都是「这一行为什么在这里」，
        //    分两行等于每行都变高；合一行列表就矮回来一格。
        // ⚠️ 这一行**仍然独占一行**，不并进标题行：标题右侧的省略号会把它截成
        //    「标题命中当前…」，恰好把要传达的东西吃掉（Design §11 字段顺序不变）。
        // ── 2026-10-08 用户规格（v0.21.x 布局改造）：这一行现在是**证据行 + 操作行** ──
        //    左边＝证据（命中段 ｜ 理由），右边＝三个文字动作（固定 → 排除 → 来源词）。
        //    为什么来源词也搬到这里：它和命中段、理由说的是**同一层证据**（这一条怎么进来的），
        //    而固定 / 排除是操作入口 —— 原来四样东西并排挤在标题行右端，是信息过载。
        //    ⚠️ 那一组默认**不显示**（`.knit-rowacts` 的 `visibility:hidden`），
        //    悬停到这一行 / 键盘光标在这一行 / 焦点进入这一行才出现。
        //    ⚠️ 没有命中段、也没有理由时这一行**仍然渲染**（左边就是空的，一个字的占位都不写）：
        //    否则那一条会连固定 / 排除的入口一起没有。为什么不留占位文字 —— 需求 §6.4
        //    「没有证据就不装成有证据的样子」，所以这里连一个「—」都不给。
        (passage || why || onAct || prov) ? h('div', { className: 'knit-subrow' },
          // 左（flex:1 1 auto，可被截断）＝证据。右（flex:none）＝动作，永远有位置：
          // 窄宽度下先截证据，不让动作压到证据上面（需求 §3.2）。
          h('div', { className: 'knit-subrow-main' },
            /* ── 命中段（需求 §12）─────────────────────────────────────────
               只有一个行号区间 —— 这是「文件 → 相关内容片段」升级在列表里唯一露出的
               那一格。它**不是**：分数、百分比、置信度、AI 摘要、高亮预览卡片
               （§26 明令禁止那一类展示）。
               ⚠️ 它是真 `button`（Tab 得到、回车能开、读屏读得出），并且
               `stopPropagation` —— 否则点它会顺带触发行的 onSelect（预览开/关切换），
               于是「点片段」在同一行上点第二次会把预览关掉。 */
            passage ? h('button', {
              className: 'knit-hit',
              type: 'button',
              title: t('row.passages', { range: fmtRange(passage) }),
              onClick: (event) => {
                if (event && typeof event.stopPropagation === 'function') event.stopPropagation()
                onPassage(doc, passage)
              },
            }, t('row.passages', { range: fmtRange(passage) })) : null,
            (passage && why) ? h('span', { className: 'knit-subrow-sep', 'aria-hidden': 'true' }) : null,
            why ? (onWhyToggle && relations
              // v0.21：**有关系可看时，「为什么」就是那个开关**（需求 §6.6：点「原因」展开证据）。
              // 文本一个字节都没变，只是从 div 变成 button —— 它现在真的可点、可 Tab、可回车。
              // 2026-10-08：证据行右端的来源词（检索 / 关系 / 用户固定）**是同一个开关** ——
              // 用户规格要的就是它，而理由那一行的原文与交互一个字都没动。
              ? h('button', {
                className: 'knit-why',
                type: 'button',
                title: t('rel.toggle'),
                'aria-expanded': whyOpen ? 'true' : 'false',
                onClick: (event) => {
                  if (event && typeof event.stopPropagation === 'function') event.stopPropagation()
                  onWhyToggle()
                },
              }, why)
              : h('div', { className: 'knit-why', title: `${t('context.why')}：${why}` }, why)) : null),
          /* ── 右端＝操作组（2026-10-08 用户规格）───────────────────────────
             顺序是**硬的**：固定 → 排除 → 来源词。**只有文字、没有任何图标**
             （不加 Pin / 放大镜 / 禁止符号 / 星形，不加 SVG 装饰），也不给三个按钮
             各自的彩色胶囊 —— 它们默认根本不显示，出现时就是一行克制的灰字。
             ⚠️ 来源词是**第三个**：它既是「这一条怎么进来的」这条事实，又是展开证据的入口
                （有关系可看时才是 button；没有证据可展开时只是一个词，不装成能点）。
             ⚠️ 三个动作都 `stopPropagation` —— 否则点它会顺带开 / 关这一篇的预览。 */
          (onAct || prov) ? h('div', { className: 'knit-rowacts' },
            onAct ? h('button', {
              className: 'knit-act',
              type: 'button',
              title: t(pinned ? 'control.unpin' : 'control.pin'),
              onClick: (event) => {
                if (event && typeof event.stopPropagation === 'function') event.stopPropagation()
                onAct(pinned ? 'unpin' : 'pin', doc.rel)
              },
            }, t(pinned ? 'control.unpin' : 'control.pin')) : null,
            onAct ? h('button', {
              className: 'knit-act',
              type: 'button',
              title: t('control.exclude'),
              onClick: (event) => {
                if (event && typeof event.stopPropagation === 'function') event.stopPropagation()
                onAct('exclude', doc.rel)
              },
            }, t('control.exclude')) : null,
            prov ? (onWhyToggle && relations
              ? h('button', {
                className: 'knit-prov',
                type: 'button',
                title: t('rel.toggle'),
                'aria-expanded': whyOpen ? 'true' : 'false',
                onClick: (event) => {
                  if (event && typeof event.stopPropagation === 'function') event.stopPropagation()
                  onWhyToggle()
                },
              }, prov)
              : h('span', { className: 'knit-prov', title: t('context.why') }, prov)) : null) : null) : null,
        // ── v0.21 行级证据（需求 §6.2）──────────────────────────────────
        // **默认一个节点都不渲染**，点开「为什么」才有。每条一行，四个字段全都可核验：
        // 类型 · 方向 · 谁 · 第几行。⚠️ 它渲染在 `.knit-subrow` **之外**（.knit-subrow 是
        // 「一条 metadata 行」那个容器，有测试钉着它每行恰好一个）。
        // ⚠️ 类名刻意避开 `knit-why` 子串 —— `byClass` 是子串匹配，测试用
        //    `byClass(nodes,'knit-why')` 数理由行，撞上就会多算。
        // `tests` 那一类**没有行号**：它的证据是「文件名约定」这个事实，不是某一行文字，
        // 所以不编一个行号出来。
        whyOpen && relations ? h('div', { className: 'knit-rellist' },
          ...relations.slice(0, REL_MAX).map((rel, index) => {
            // 「谁在提这件事」的那个文件：`in` 边是对方指向这一篇（对方是叙述方），
            // `out` 边是这一篇指向对方。行号属于**叙述方**那份文件。
            const owner = rel.dir === 'in' ? rel.other : doc.rel
            return h('div', { className: 'knit-relrow', key: `${rel.type}:${rel.dir}:${rel.other}:${index}` },
              h('span', { className: 'knit-reltag' }, t(`rel.${rel.type}`)),
              h('span', { className: 'knit-relwho' }, `${rel.dir === 'in' ? '←' : '→'} ${rel.other}`),
              Number.isInteger(rel.line) ? h('span', { className: 'knit-relline' }, t('rel.line', { line: rel.line })) : null,
              h('button', {
                className: 'knit-relopen',
                type: 'button',
                onClick: (event) => {
                  if (event && typeof event.stopPropagation === 'function') event.stopPropagation()
                  onOpenRelation(owner, rel.line)
                },
              }, t('rel.open')))
          }),
          relationsTotal > relations.length
            ? h('div', { className: 'knit-relmore' },
              t('rel.more', { n: relationsTotal, max: REL_MAX }))
            : null) : null))
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
    function MediaCard({ doc, now, active, cursor, src, onSelect, onOpenTab, onZoom, onPreview, optionId, favorite, conversation, onHoverStart, onHoverEnd }) {
      const fresh = now - doc.mtimeMs < NEW_WINDOW_MS
      return h('div', {
        className: `knit-media-card${active ? ' active' : ''}${cursor ? ' cursor' : ''}${fresh ? ' fresh' : ''}`,
        // 与 DocRow 同一套 listbox 选项语义（媒体档与「全部」的媒体区都在同一个 listbox 里）
        role: 'option',
        id: optionId,
        'aria-selected': active ? 'true' : 'false',
        'data-knit-rel': doc.rel,
        // v0.25：对话里生成的图没有工作区路径 —— 提示语换成「还没保存到本地」
        title: conversation ? t('attach.title') : t('row.tooltip', { path: doc.rel }),
        onClick: () => onSelect(doc),
        /* v0.25（2026-10-22 用户裁决）：媒体档**取消单击就地预览** —— 双击才是「看」。
           按类型分流：
           · 图片 → 全屏查看器（`onZoom`，里面自带收藏 / 本地打开）；
           · 视频 → **仍走就地预览**（`onPreview`）：查看器只做图片，不这么走的话
             播放器、收藏、本地打开就全没了入口。 */
        onDoubleClick: () => (doc.kind === 'image'
          ? (onZoom && onZoom(doc))
          : (onPreview ? onPreview(doc) : onOpenTab(doc))),
        // v0.25：悬停看大图（只对图片；视频交给点击预览）。事件里带矩形，几何在纯函数里算。
        onMouseEnter: onHoverStart ? (event) => onHoverStart(doc, src, event) : undefined,
        onMouseLeave: onHoverEnd || undefined,
      },
      h('div', { className: 'knit-media-thumbbox' }, h(MediaThumb, { doc, src })),
      h('div', { className: 'knit-media-meta' },
        h('div', { className: 'knit-media-name', title: doc.name },
          // v0.25：对话里生成的图带一个「对话」标记 —— 它解释两件事：这张还没存进项目、
          // 存进去之后它会自己消失（去重规则）。用文字不用图标：它承担信息。
          conversation ? h('span', { className: 'knit-conv' }, t('attach.badge')) : null,
          // v0.25 媒体收藏：★ 是**状态标记**（不是装饰）—— 它解释「这张为什么排在最前面」
          favorite ? h('span', { className: 'knit-fav', title: t('fav.mark'), 'aria-label': t('fav.mark') }, '★') : null,
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
     * 语法高亮：**只有命中段那一带**有 token 颜色（2026-10-07 用户第二次裁决）。
     *
     * 演进：先是「整篇（前 2000 行）着色」，同日收到「前 800 行」—— 用户实测仍嫌慢。
     * 根因是官方高亮器（shiki 的 JS 引擎，**同步**跑）的成本 ∝ 被着色的行数：
     * 实测约 170–560 ms / 千行，4000 行文件首开 1.3–2.5 s。
     * 所以现在只给命中段前后各 `CODE_HL_PAD` 行上色，其余保持默认正文色
     * （跟随主题令牌：浅色黑、暗色白，与代码块正文同色）。窗口通常百余行 ⇒
     * 分词约 50–100 ms，DOM 从 1.3 万个 span 降到几百个。
     *
     * 已知代价（明说，不装作没有）：窗口若从半截注释 / 字符串中间开始，高亮器缺上文，
     * 那一段可能**错色**（整篇从第一行开始分词才没这个问题）。命中横带
     * （`.knit-code-hit`）仍然精确标出命中行 —— 它是纯算术定位，不依赖颜色。
     * 没有命中段（载荷里没有 `matches`）的文件：一个 token 都不上色。
     */
    const CODE_HL_PAD = 60

    /** 命中窗口的硬上限：命中段本身可能很长（几百行），不许把整篇拖进来。 */
    const CODE_HL_MAX_LINES = 800

    /**
     * 命中片段在代码预览里的几何（v0.20，需求 §13）—— **纯算术**，不碰 DOM。
     *
     * 抽出来是为了可测：真实渲染要真 DOM 才量得到行高，而这段算术（行号 → 像素、
     * 滚动位置、边界夹取）才是会算错的地方。DOM 那一侧只剩「量行高、写 scrollTop」。
     *
     * 规则：
     *  - 行号 1 起算；`endLine` 缺省等于 `startLine`（单行命中）；
     *  - `endLine` 超出文件末尾时**夹到末尾**（不画到文件外面去）；
     *  - `startLine` 超出文件末尾 ⇒ `null`（这一篇没有那一行 —— 不猜、不画）；
     *  - 滚动位置在横带上方留 2 行：命中片段不是屏幕第一行时才看得出它为什么被命中。
     *
     * @param {{startLine?:number, endLine?:number}|null} anchor - 行区间
     * @param {{total:number, lineHeight:number, offsetTop?:number}} layout - 实测布局
     * @returns {{top:number, height:number, scrollTop:number}|null} 几何，或 null
     */
    function anchorBandFor(anchor, layout) {
      const total = layout && Number.isFinite(layout.total) ? Math.floor(layout.total) : 0
      const lineHeight = layout && Number.isFinite(layout.lineHeight) ? layout.lineHeight : 0
      const offsetTop = layout && Number.isFinite(layout.offsetTop) ? layout.offsetTop : 0
      const startLine = anchor && Number.isFinite(anchor.startLine)
        ? Math.max(1, Math.floor(anchor.startLine)) : 0
      if (!startLine || total <= 0 || startLine > total || !(lineHeight > 0)) return null
      const endLine = anchor && Number.isFinite(anchor.endLine)
        ? Math.max(startLine, Math.floor(anchor.endLine)) : startLine
      const last = Math.min(endLine, total)
      const top = offsetTop + (startLine - 1) * lineHeight
      return {
        top,
        height: (last - startLine + 1) * lineHeight,
        scrollTop: Math.max(0, top - lineHeight * 2),
      }
    }

    /* ── v0.20：Markdown 预览的行锚点（2026-10-07 用户裁决）───────────────────
       原话：「文档没有进入指定段落，文档这边也参考代码块一样，选中文档以后进入详情，
       要指定到段落」。代码那边靠行高算（`anchorBandFor`），**Markdown 这边算不了**：
       正文是 DSH 的 `MarkdownText` 渲染出来的富文本，DOM 里既没有行号也没有字符偏移
       ⇒「行号 → 像素」这条路根本不存在。

       于是换成**文本锚点**：宿主给的片段本身就带 `[startOffset, endOffset)`，而且
       `body.slice(startOffset, endOffset)` 就是那段原文，所以能从原文里取一根够长的
       「针」，再到**渲染结果**里找第一根针 —— 找到就滚过去（并淡一下底），找不到就
       **什么都不做**。宁可不动，也不能假装动了：滚到一段不相干的文字比不滚更糟
       （§26 只展示可验证信息）。

       为什么一根针对应**一行**而不是整段：片段是 24 行的窗口，整段常常跨好几个
       `p` / `li`，渲染后根本不在同一个元素里；而片段两端本来就按空行裁过
       （`passage.js`：首尾空行不算内容），所以**首行通常就是某个元素的开始**。
       逐行给针、命中即用。 */

    /** 针的最大长度：够独特，又不至于跨元素。 */
    const DOC_NEEDLE_CHARS = 40
    /** 针的最短长度：太短的（`## 2.2`、`- 是`）在正文里到处命中，等于乱滚。 */
    const DOC_NEEDLE_MIN = 12
    /** 最多试几根针（片段的前 4 个够长的行）。 */
    const DOC_NEEDLE_MAX = 4

    /**
     * 一行 Markdown 原文 → 渲染后 DOM 里那串文字的「归一化形态」。
     *
     * 富文本渲染会吃掉语法符、把行内强调拆成多个文本节点，所以两边要先归一到同一套口径：
     *  - 行首的 `#` / `-` / `1.` / `>` 在 DOM 里不存在（列表符号是伪元素）⇒ 去掉；
     *  - `*x*` / `**x**` / 反引号 / `~~x~~` 渲染成元素 ⇒ 去掉标记符、保留文字；
     *  - `[文字](地址)` 只留文字；
     *  - 空白一律折叠成一个空格（DOM 那一侧也这么折，见 `docAnchorHit`）。
     *
     * ⚠️ `_` 只在**成对的强调**位置上删（`_斜体_`），不做全局删除 ——
     *    `snake_case` 这类标识符里的下划线是正文的一部分，删了反而对不上。
     *
     * @param {string} value - 原文（一行或整段）
     * @returns {string} 归一化文本
     */
    function docNeedleText(value) {
      return String(value == null ? '' : value)
        .replace(/^\s{0,3}(?:#{1,6}\s*|>\s?|(?:[-*+]|\d{1,3}[.)])\s+)/, '')
        .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
        .replace(/(^|[\s(（])_([^_\n]+)_(?=[\s)）.,:;!?，。：；！？]|$)/g, '$1$2')
        .replace(/[*~`]/g, '')
        .replace(/\s+/g, ' ')
        .trim()
    }

    /**
     * 从片段原文里取「针」。
     *
     * @param {string} text - 预览正文（`/api/doc` 给的那一份）
     * @param {{startOffset?:number, endOffset?:number, snippet?:string}|null} anchor - 片段
     * @returns {string[]} 候选针（去重、按可靠性排序）；取不到就是空数组 ⇒ 调用方什么都不做
     */
    function docAnchorNeedles(text, anchor) {
      const out = []
      const body = typeof text === 'string' ? text : ''
      let raw = ''
      if (anchor && Number.isFinite(anchor.startOffset) && Number.isFinite(anchor.endOffset)
        && anchor.endOffset > anchor.startOffset && body) {
        const from = Math.max(0, Math.floor(anchor.startOffset))
        const to = Math.min(body.length, Math.floor(anchor.endOffset))
        if (to > from) raw = body.slice(from, to)
      }
      // 偏移量对不上（正文被截断过、宿主改过口径）时退回 `snippet` —— 它仍然只是**线索**。
      if (!raw && anchor && typeof anchor.snippet === 'string') raw = anchor.snippet
      if (!raw) return out
      for (const line of raw.split('\n')) {
        if (out.length >= DOC_NEEDLE_MAX) break
        const needle = docNeedleText(line).slice(0, DOC_NEEDLE_CHARS)
        if (needle.length < DOC_NEEDLE_MIN) continue
        if (out.indexOf(needle) < 0) out.push(needle)
      }
      return out
    }

    /** 计算样式里这些 `display` 不算「块」—— 命中它们就继续往上找。 */
    // ⚠️ 2026-10-07 真机实测：DSH 的行内 `code` 是 **inline-block** —— 不把它算作行内，
    // 淡底就会画在「`matches: [...]`」那一个小片片上，而不是它所在的那一段。
    const DOC_INLINE_DISPLAY = {
      inline: 1, contents: 1, 'inline-block': 1, 'inline-flex': 1, 'inline-grid': 1, ruby: 1,
    }

    /**
     * 命中的文本节点 → 该滚过去的那个元素（段落 / 列表项 / 标题 / 代码块自己）。
     *
     * 判据是**计算样式**而不是标签名：标签猜不准（`<div>` 既可能是包住全文的容器、
     * 也可能是排版块），而 `display` 直接说明它是不是一块。取不到计算样式（老宿主 /
     * 测试替身）时就近返回，绝不因此崩掉一次预览。
     *
     * @param {Text} node - 命中针所在的文本节点
     * @param {HTMLElement} box - 正文容器（上界，不返回它自己）
     * @returns {HTMLElement|null} 目标元素
     */
    function docBlockElement(node, box) {
      let el = node && node.parentElement ? node.parentElement : null
      while (el && el !== box) {
        let display = ''
        try {
          const win = el.ownerDocument && el.ownerDocument.defaultView
          display = win && typeof win.getComputedStyle === 'function' ? win.getComputedStyle(el).display : ''
        } catch (error) {
          display = ''
        }
        if (!display) return el
        if (!DOC_INLINE_DISPLAY[display]) return el
        el = el.parentElement
      }
      return null
    }

    /**
     * 在拼接好的正文里挑一次命中（**纯函数**，可单测）。
     *
     * 两条判据，缺一不可：
     *  - **独特的那根针优先**：一根针整篇只出现一次，它落在哪就是哪；
     *  - 同档再比**离锚点最近**：用 `startOffset / 正文长度` 估个位置比例，重复出现的
     *    针挑最接近的那一次 —— 否则 `indexOf` 会永远返回**全篇最早的**那次，跳去一个
     *    跟这段无关的地方（同一个词在长文档里出现几十次是常态）。
     *
     * @param {string[]} needles - 候选针
     * @param {string} haystack - 正文拼接串
     * @param {number} ratio - 锚点在原文里的位置比例（0–1；拿不到时传负数）
     * @returns {number} 命中的下标，找不到为 -1
     */
    function docPickOffset(needles, haystack, ratio) {
      if (!Array.isArray(needles) || !haystack) return -1
      let best = -1
      let bestScore = Infinity
      for (const needle of needles) {
        if (!needle) continue
        let at = haystack.indexOf(needle)
        let count = 0
        let localAt = -1
        let localCost = Infinity
        while (at >= 0) {
          count += 1
          const cost = ratio >= 0 && haystack.length
            ? Math.abs(at / haystack.length - ratio)
            : 0
          if (cost < localCost) { localCost = cost; localAt = at }
          at = haystack.indexOf(needle, at + 1)
        }
        if (localAt < 0) continue
        const score = (count === 1 ? 0 : 1) + localCost
        if (score < bestScore) { bestScore = score; best = localAt }
      }
      return best
    }

    /**
     * 正文里第一个包含某根针的元素。
     *
     * 走 `TreeWalker` 把正文的文本节点接成一根**带下标映射**的字符串（每个文本节点记
     * `[start, end)`），`indexOf` 命中后反查是哪个节点，再交给 `docBlockElement` 往上找块。
     * **不在节点之间补空格** —— 渲染会把 `**粗**字` 拆成两个文本节点，补空格反而对不上，
     * 而原文里真有空格时那个空格本来就在某个文本节点里。
     *
     * @param {HTMLElement} box - 正文容器
     * @param {string[]} needles - 候选针
     * @param {number} [ratio] - 锚点在原文里的位置比例（挑重复词的哪一次）
     * @returns {HTMLElement|null} 命中的元素
     */
    function docAnchorHit(box, needles, ratio) {
      const spans = []
      let text = ''
      const walker = document.createTreeWalker(box, 4) // 4 = SHOW_TEXT
      let node = walker.nextNode()
      while (node) {
        const normalized = String(node.nodeValue || '').replace(/\s+/g, ' ')
        if (normalized) {
          spans.push({ node, start: text.length, end: text.length + normalized.length })
          text += normalized
        }
        node = walker.nextNode()
      }
      const at = docPickOffset(needles, text, Number.isFinite(ratio) ? ratio : -1)
      if (at < 0) return null
      const span = spans.find((s) => at >= s.start && at < s.end)
      if (!span) return null
      return docBlockElement(span.node, box)
    }

    /**
     * 把 Markdown 预览滚到命中段，并给那一块一次 1.2s 的淡底。
     *
     * 三个刻意的选择：
     *  - **滚的是 `.knit-preview-body`**（正文那个滚动容器），不是这里新开一个 ——
     *    两个纵向滚动条会互相打架（v0.19 代码预览踩过同一个坑）。
     *  - 淡底时长就是 `FLASH_MS`（与「点 Coverage → 那一层亮一下」同一档灰、同一个时长）。
     *  - 只做**空间定位**的提示：不画边框、不位移、不留状态，也不改任何列表数据。
     *
     * @param {HTMLElement|null} box - 正文容器
     * @param {string[]} needles - `docAnchorNeedles()` 的产物
     * @param {number} [ratio] - 锚点在原文里的位置比例
     * @returns {boolean} 是否真的滚了（false = 没找到，什么都没动）
     */
    function scrollToDocAnchor(box, needles, ratio) {
      if (!box || !Array.isArray(needles) || !needles.length) return false
      if (typeof document === 'undefined' || typeof document.createTreeWalker !== 'function') return false
      const hit = docAnchorHit(box, needles, ratio)
      if (!hit || typeof hit.getBoundingClientRect !== 'function') return false
      const scroller = typeof box.closest === 'function' ? box.closest('.knit-preview-body') : null
      const view = scroller || box
      if (view && Number.isFinite(view.scrollTop) && typeof view.getBoundingClientRect === 'function') {
        const delta = hit.getBoundingClientRect().top - view.getBoundingClientRect().top
        view.scrollTop = Math.max(0, Math.round(view.scrollTop + delta) - 8)
      }
      hit.classList.add('knit-doc-hit')
      setTimeout(() => { hit.classList.remove('knit-doc-hit') }, FLASH_MS)
      return true
    }

    /* ── v0.25：预览里的「查找」（Cmd+F）───────────────────────────────────
       用户要的是「像 Chrome 那样在文档里搜关键词并定位」。三条房规决定了它长什么样：

       ① **不自己渲染 Markdown**（见 DocPane 那条注释：那会变成第二套渲染器）
          ⇒ 与 `docAnchorHit` 同一套办法：渲染完成后走 TreeWalker，在**已经渲染出来的文本**上找。
       ② **匹配是纯函数**，DOM 那一层只负责画。测试替身没有 document，所以能被真断言钉住的
          只有纯函数那一半 —— 这是刻意的分工，与 `docAnchorNeedles`（纯）/
          `docAnchorHit`（DOM）那条已有的分界线一致。
       ③ **命中只上底色，绝不动几何**：`mark` 不许有 padding / border，也不许改行高
          —— 代码预览的命中横带是按「滚动高度 ÷ 行数」算行高的，动了就会错位。

       ⚠️ 已知边界（与既有锚点定位同一条）：命中**不跨文本节点**。渲染会把 `**粗**字`
       拆成两个节点，所以正好被 Markdown 语法截断的关键词（一半在「粗」左边、一半在右边）找不到。
       跨节点要额外把「归一化后的下标」分别映射回两个节点的原文下标，代价与收益不成比例。
       `preview.truncated` 那句「仅预览前 512 KB」不算文档内容，跳过不搜。
    */

    /**
     * 在一段文本里找出**所有**字面量命中。
     *
     * - **字面量，不是正则**：输入 `(`、`*`、`[` 时必须原样找 —— 既不许当元字符，也不许抛
     *   （用户搜的是关键词，不是模式）。
     * - **不重叠、按出现顺序**（与 Chrome 的计数口径一致）。
     * - **大小写不敏感，但只在折叠后长度不变时才用折叠串**：少数 Unicode 字符折叠后会**变长**
     *   （如 `İ`），那样下标就与原文错位、画出来的命中会偏一格。这种输入退回大小写敏感 ——
     *   宁可少匹配几个，也不许标错位置。
     *
     * @param {string} haystack - 被搜的文本
     * @param {string} query - 关键词
     * @returns {{start:number,end:number}[]} 命中区间（原文下标，左闭右开）
     */
    function findRanges(haystack, query) {
      const text = typeof haystack === 'string' ? haystack : ''
      const needle = typeof query === 'string' ? query : ''
      if (!text || !needle) return []
      const foldedText = text.toLowerCase()
      const foldedNeedle = needle.toLowerCase()
      const foldable = foldedText.length === text.length && foldedNeedle.length === needle.length
      const hay = foldable ? foldedText : text
      const pin = foldable ? foldedNeedle : needle
      const out = []
      let from = 0
      for (;;) {
        const at = hay.indexOf(pin, from)
        if (at < 0) break
        out.push({ start: at, end: at + pin.length })
        from = at + pin.length
      }
      return out
    }

    /**
     * 归一化文本的**下标 → 原文下标**映射。
     *
     * 搜索要先把换行折叠成空格再找（渲染出来的文本就是这样，不折叠就对不上），
     * 但**画的时候必须切原文** —— 所以需要这座桥：返回数组第 i 项 = 归一化文本第 i 个字符
     * 在原文里的下标。归一化规则与 `docAnchorHit` 逐字同一条：一串空白 → 一个空格。
     *
     * @param {string} original - 原文
     * @returns {number[]} 映射（长度 == 归一化后的长度）
     */
    function normalizedIndexMap(original) {
      const text = typeof original === 'string' ? original : ''
      const map = []
      let i = 0
      while (i < text.length) {
        map.push(i)
        const isSpace = /\s/.test(text[i])
        i += 1
        if (isSpace) while (i < text.length && /\s/.test(text[i])) i += 1
      }
      return map
    }

    /**
     * 下一个命中下标（**环绕**，与 Chrome 一致：最后一个再按「下一个」回到第一个）。
     *
     * @param {number} current - 当前下标
     * @param {number} total - 命中总数
     * @param {number} delta - 方向（负数 = 上一个）
     * @returns {number} 新下标（total 为 0 时恒 0）
     */
    function stepFindIndex(current, total, delta) {
      if (!(total > 0)) return 0
      const at = Number.isFinite(current) ? Math.min(Math.max(0, Math.round(current)), total - 1) : 0
      const next = (at + (delta < 0 ? -1 : 1)) % total
      return next < 0 ? next + total : next
    }

    /** 查找时跳过的子树：`preview.truncated` 那句提示不是文档内容。 */
    function findSkippedNode(node) {
      let el = node && node.parentNode
      while (el && el.nodeType === 1) {
        if (String(el.className || '').indexOf('knit-preview-note') >= 0) return true
        el = el.parentNode
      }
      return false
    }

    /**
     * 把命中画成 `mark.knit-find`，返回**按文档顺序**的命中元素。
     *
     * 一个文本节点里可能有多个命中 —— 先把该节点切成「文本 + mark + 文本…」再整体替换它，
     * 所以顺序天然是对的；`insertBefore` 逐片插在旧节点前面、最后删掉旧节点。
     * 没有 document（测试替身）时**静默返回空数组** —— 与 `scrollToDocAnchor` 同一层守卫。
     *
     * @param {HTMLElement|null} box - 正文容器
     * @param {string} query - 关键词
     * @returns {HTMLElement[]} 命中元素（文档顺序）
     */
    function paintFindMarks(box, query) {
      if (!box || typeof document === 'undefined' || typeof document.createTreeWalker !== 'function') return []
      if (typeof document.createElement !== 'function' || !query) return []
      const walker = document.createTreeWalker(box, 4) // 4 = SHOW_TEXT
      const targets = []
      let node = walker.nextNode()
      while (node) {
        const value = String(node.nodeValue || '')
        if (value && !findSkippedNode(node)) {
          const flat = value.replace(/\s+/g, ' ')
          const ranges = findRanges(flat, query)
          if (ranges.length && node.parentNode) {
            targets.push({ node, value, ranges, map: normalizedIndexMap(value) })
          }
        }
        node = walker.nextNode()
      }
      const marks = []
      for (const target of targets) {
        const pieces = []
        let at = 0
        for (const range of target.ranges) {
          const from = target.map[range.start]
          const to = range.end < target.map.length ? target.map[range.end] : target.value.length
          if (!(from >= at) || !(to > from)) continue
          if (from > at) pieces.push(document.createTextNode(target.value.slice(at, from)))
          const mark = document.createElement('mark')
          mark.className = 'knit-find'
          mark.textContent = target.value.slice(from, to)
          pieces.push(mark)
          marks.push(mark)
          at = to
        }
        if (!pieces.length) continue
        if (at < target.value.length) pieces.push(document.createTextNode(target.value.slice(at)))
        const parent = target.node.parentNode
        for (const piece of pieces) parent.insertBefore(piece, target.node)
        parent.removeChild(target.node)
      }
      return marks
    }

    /**
     * 还原：把每个 `mark.knit-find` 换回纯文本节点，再把相邻文本节点合并。
     *
     * **必须还原得干净** —— 否则下一次画是在「已经画过的树」上再画一层，
     * 命中数会越算越多，而且退出查找后正文里永远留着标签。
     *
     * @param {HTMLElement|null} box - 正文容器
     * @returns {void}
     */
    function clearFindMarks(box) {
      if (!box || typeof box.querySelectorAll !== 'function' || typeof document === 'undefined') return
      const marks = box.querySelectorAll('mark.knit-find')
      const parents = []
      for (let i = 0; i < marks.length; i += 1) {
        const mark = marks[i]
        const parent = mark.parentNode
        if (!parent) continue
        parent.replaceChild(document.createTextNode(String(mark.textContent || '')), mark)
        if (parents.indexOf(parent) < 0) parents.push(parent)
      }
      for (const parent of parents) if (typeof parent.normalize === 'function') parent.normalize()
    }

    /** 标出「当前这一条命中」（其余保持普通底色）。 */
    function markFindCurrent(marks, index) {
      if (!Array.isArray(marks)) return
      for (let i = 0; i < marks.length; i += 1) {
        const el = marks[i]
        if (!el || !el.classList) continue
        if (i === index) el.classList.add('knit-find-current')
        else el.classList.remove('knit-find-current')
      }
    }

    /**
     * 把当前命中滚进视野 —— 与 `scrollToDocAnchor` **同一套手动算术**。
     *
     * 刻意不用 `scrollIntoView`：那会连带滚外层容器与整个面板，长文里的位置会飘
     * （见 `scrollToDocAnchor` 那条注释，同一个坑）。这里滚的仍是 `.knit-preview-body`。
     * 位置取**居中**：逐个往下找时，命中停在视野中间最好读。
     *
     * @param {HTMLElement|null} mark - 当前命中的元素
     * @returns {boolean} 是否真的滚了
     */
    function scrollMarkIntoView(mark) {
      if (!mark || typeof mark.getBoundingClientRect !== 'function') return false
      const box = typeof mark.closest === 'function' ? mark.closest('.knit-preview-body') : null
      if (!box || !Number.isFinite(box.scrollTop) || typeof box.getBoundingClientRect !== 'function') return false
      const rect = box.getBoundingClientRect()
      const delta = mark.getBoundingClientRect().top - rect.top
      const viewH = Number.isFinite(rect.height) ? rect.height : 0
      const target = box.scrollTop + delta - Math.max(0, viewH / 2 - 10)
      box.scrollTop = Math.max(0, Math.round(target))
      return true
    }

    /**
     * Markdown 预览：在 `MarkdownText` 外面包一层，只为把「跳到你点的那一段」接上。
     *
     * 刻意**不自己渲染 Markdown**（那会变成第二套渲染器，与 DSH 的主题、代码块复制、
     * 相对图片解析全部脱钩）：这一层只做一件事 —— 渲染完成后把锚点滚过去。
     *
     * @param {{text:string, anchor?:object|null, anchorSeq?:number, body?:any}} props -
     *   `anchorSeq` 每次点片段都 +1，**重复点同一段也要再滚一次**（只比 startOffset 的话
     *   第二次点会没反应）；`body` = 渲染好的正文（**显式 prop**，理由见渲染点那条注释）。
     * @returns {import('react').ReactElement} 元素
     */
    function DocPane({ text, anchor, anchorSeq, body }) {
      const boxRef = React.useRef(null)
      const startOffset = anchor && Number.isFinite(anchor.startOffset) ? anchor.startOffset : -1
      const endOffset = anchor && Number.isFinite(anchor.endOffset) ? anchor.endOffset : -1
      React.useLayoutEffect(() => {
        // 测试替身没有 DOM：这里必须是**静默**的 no-op，不是异常（`scrollToDocAnchor` 里那层守卫）。
        // 位置比例 = 原文里锚点在哪（0–1）；重复出现的针靠它挑「最接近的那一次」，
        // 否则 `indexOf` 永远返回全篇最早那次（长文档里同一个词出现几十次是常态）。
        const ratio = Number.isFinite(startOffset) && text
          ? Math.min(1, Math.max(0, startOffset / text.length))
          : -1
        scrollToDocAnchor(boxRef.current, docAnchorNeedles(text, anchor), ratio)
      }, [anchorSeq, startOffset, endOffset, text])
      return h('div', { className: 'knit-md-body', ref: boxRef }, body)
    }

    /**
     * 轻量代码预览：行号栏 + 代码正文。
     *
     * 刻意的取舍（需求 §8 §25 §26）：
     *  - **不做折叠、不做 minimap、不做 AST / symbol outline**，不引入 Monaco /
     *    CodeMirror。Knit 不是编辑器。
     *  - ⚠️ v0.19 原本连**语法高亮**也不做（正文单色）。v0.20 期间用户改主意了
     *    （2026-10-07：「对于一个阅读代码用户来说，可读性太低了」，并给了 DSH
     *    自己那份带行号的代码视图当参照），于是接上**官方高亮器** —— 颜色全部来自
     *    主题包的 `--shiki-*`，见上面 `useCodeSpans` 那段注释与 `Knit-决策记录.md`。
     *    高亮是**同步**算完再渲染的（`React.useMemo`，带按文件的缓存）；让帧方案实测更慢，
     *    已否决，理由见 `Knit-决策记录.md`。
     *  - 行号仍是**一个**文本节点（靠 `white-space: pre` 换行）；正文是逐 token 的
     *    片段，但**行与行之间只隔一个 '\n' 文本节点**、不新增逐行元素 —— 于是
     *    行高几何（`pre.scrollHeight / 行数`）、横向滚动、命中横带全部照旧。
     *  - 字体、配色全部走既有 `--knit-*` / `--dsw-alias-*` / `--shiki-*` 变量，
     *    随 light/dark 主题走。
     *
     * @param {{rel?: string, text: string, language?: string|null, anchor?: {startLine?:number, endLine?:number}|null,
     *   anchorSeq?:number}} props -
     *   `preview.text` 原文；`language` = **宿主分类层给的**语言标识（客户端不许自己看
     *   扩展名，见渲染点那条注释），原样喂给官方高亮器；`anchor`（v0.20）= 要点亮并
     *   滚动过去的行区间（`doc.matches[0]`）；`anchorSeq` 每次点片段 +1（重复点同一段
     *   也要再滚一次）
     * @returns {import('react').ReactElement} 元素
     */
    function CodePane({ rel, text, language, anchor, anchorSeq }) {
      const lines = String(text == null ? '' : text).split('\n')
      // 末尾换行会切出一个空尾行 —— 显示它会让行数比编辑器里多一行。
      if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop()
      const clipped = lines.length > CODE_LINES_MAX
      const shown = clipped ? lines.slice(0, CODE_LINES_MAX) : lines
      const shownLines = shown.length
      const shownText = shown.join('\n')

      /* 命中行锚点（需求 §13）：几何那半段在下面。 */
      const anchorStart = anchor && Number.isFinite(anchor.startLine) ? anchor.startLine : 0
      const anchorEnd = anchor && Number.isFinite(anchor.endLine) ? anchor.endLine : 0

      /* ── v0.20 语法高亮（2026-10-07 用户新增需求；同日两次收窄，见常量注释）────
         只给**命中段那一带**上色（前后各 `CODE_HL_PAD` 行，窗口硬上限
         `CODE_HL_MAX_LINES`）。没有命中段就一个 token 都不上色 —— 其余行是默认正文色。
         `useMemo` 记忆化（键 = 高亮器引用 + 被上色的那截正文），滚动 / 悬停 / 5 s 轮询
         引起的重渲染不重算。高亮器返回的**行数对不上正文**时一律退回纯文本 ——
         宁可没颜色，也不能错位（错位意味着颜色落在错误的代码上，比单色更难读）。
         拿不到官方高亮器时 `useCodeSpans` 返回的假 hook 给的就是 `undefined`。 */
      const hlFrom = anchorEnd > 0 ? Math.max(0, anchorStart - 1 - CODE_HL_PAD) : 0
      const hlTo = anchorEnd > 0
        ? Math.min(shownLines, anchorEnd + CODE_HL_PAD, hlFrom + CODE_HL_MAX_LINES)
        : 0
      const hlLines = Math.max(0, hlTo - hlFrom)
      const hlText = hlLines > 0 ? shown.slice(hlFrom, hlTo).join('\n') : ''
      const highlighter = useCodeSpans(language)
      const spans = React.useMemo(() => {
        if (typeof highlighter !== 'function' || hlLines === 0) return null
        // 先查按文件的结果缓存（重开同一篇 = 直接命中），未命中才算、算完存回去。
        return cachedCodeSpans(`${rel || ''}#${hlFrom}-${hlTo}`, hlText, () => {
          try {
            const out = highlighter(hlText)
            return Array.isArray(out) && out.length === hlLines ? out : null
          } catch (error) { return null }
        })
      }, [rel, highlighter, hlText, hlLines])

      /* 上色后的正文树 = `[头纯文本, …token, '\n', …token, 尾纯文本]`：行内是 token
         片段，行间是**一个**换行文本节点（不包逐行元素，理由见 doc 注释）；窗口之外的
         头、尾各是**一个**纯文本节点（不上色，但一字不少）。没颜色时就是原来的整串。
         `useMemo` 记忆化（键 = 上文那份 spans + 正文 + 窗口）：5 s 轮询 / 悬停 / 选中引起的
         重渲染不再重建这几百个元素。 */
      const body = React.useMemo(() => {
        if (!spans || hlLines === 0) return shownText
        const nodes = []
        if (hlFrom > 0) nodes.push(shown.slice(0, hlFrom).join('\n'), '\n')
        for (let i = 0; i < spans.length; i += 1) {
          if (i > 0) nodes.push('\n')
          const runs = spans[i] || []
          for (let j = 0; j < runs.length; j += 1) {
            const run = runs[j]
            if (!run || typeof run.text !== 'string' || run.text === '') continue
            nodes.push(h('span', { key: i + '-' + j, style: run.style || null }, run.text))
          }
        }
        // 窗口之后的行**照常显示，只是不上色**：整段作为**一个**纯文本节点接在末尾。
        if (hlTo < shownLines) nodes.push('\n', shown.slice(hlTo).join('\n'))
        return nodes
      }, [spans, shownText, shownLines, hlFrom, hlTo, hlLines])

      let gutter = ''
      for (let i = 1; i <= shown.length; i += 1) gutter += (i === 1 ? '' : '\n') + i
      const paneRef = React.useRef(null)
      const srcRef = React.useRef(null)
      /* ── v0.20 行锚点（需求 §13）──────────────────────────────────────────
         刻意**不动 DOM 结构**：行号栏与正文各是一个文本节点（4000 行也只有两个），
         所以定位靠算（`anchorBandFor`）。行高从**实测**拿（`pre.scrollHeight / 行数`）
         —— `white-space:pre` 不换行、每行等高，量出来的比值就是行高；不依赖
         `getComputedStyle` 的字符串解析（那要处理 `normal` / 单位 / 继承，容易在某些
         主题下崩成 NaN）。拿不到布局（测试替身没有真 DOM）就什么都不做 —— 不猜、不写死行高。 */
      const [band, setBand] = React.useState(null)
      React.useLayoutEffect(() => {
        const pre = srcRef.current
        if (!pre || typeof pre.getBoundingClientRect !== 'function') {
          setBand(null)
          return
        }
        const total = shown.length
        const lineHeight = total > 0 && typeof pre.scrollHeight === 'number' && pre.scrollHeight > 0
          ? pre.scrollHeight / total : 0
        const box = anchorBandFor(anchor, { total, lineHeight, offsetTop: Number(pre.offsetTop) || 0 })
        setBand(box ? { top: box.top, height: box.height } : null)
        if (!box) return
        // 只滚**正文所在的**那个滚动容器（`.knit-preview-body`）；这里不开第二个
        // 纵向滚动容器（见上面 CSS 注释：两个纵向滚动条会互相打架）。
        const scroller = typeof pre.closest === 'function' ? pre.closest('.knit-preview-body') : null
        if (scroller && Number.isFinite(scroller.scrollTop)) scroller.scrollTop = box.scrollTop
      }, [anchorStart, anchorEnd, anchorSeq, text, shown.length])
      return h('div', { className: 'knit-codepane', ref: paneRef },
        // 横带在**文字之前**入树、且 pointer-events:none —— 它不挡选择、不挡滚动。
        band ? h('div', {
          className: 'knit-code-hit',
          'aria-hidden': 'true',
          style: { top: `${Math.round(band.top)}px`, height: `${Math.round(band.height)}px` },
        }) : null,
        h('div', { className: 'knit-code-gutter', 'aria-hidden': 'true' }, gutter),
        h('pre', { className: 'knit-code-src', ref: srcRef }, body),
        clipped
          ? h('div', { className: 'knit-preview-note' },
            t('preview.codeTruncated', { n: CODE_LINES_MAX }))
          : null)
    }

    /**
     * 预览面板（头 + 引用条 + 正文）。
     *
     * @param {object} props - 渲染入参。
     *   `find`（v0.25）= 查找条那一组：状态在 `KnitBody`（快捷键挂在面板根上，
     *   所以状态不能只活在这一层）；`bodyRef` = 正文容器 ref，由 `KnitBody` 拿去做 DOM 命中绘制。
     */
    /**
     * 逐行 diff 视图（「变更」档点开一行）。只画宿主解析好的内容行：
     * 旧行号 / 新行号 / +/- / 文本；不加语法高亮、不做折叠（不是编辑器）。
     * @param {{diff: object}} props - `/knit/api/diff` 的载荷
     * @returns {import('react').ReactElement} 元素
     */
    function DiffPane({ diff }) {
      const lines = Array.isArray(diff.lines) ? diff.lines : []
      const rows = lines.map((line, i) => h('div', {
        key: `${i}-${line.type}`,
        className: `knit-diff-line ${line.type}`,
      },
        h('span', { className: 'knit-diff-old' }, line.oldNo == null ? '' : String(line.oldNo)),
        h('span', { className: 'knit-diff-new' }, line.newNo == null ? '' : String(line.newNo)),
        h('span', { className: 'knit-diff-sign' }, line.type === 'add' ? '+' : line.type === 'del' ? '−' : ' '),
        h('span', { className: 'knit-diff-text' }, line.text === '' ? ' ' : line.text)))
      const head = h('div', { className: 'knit-diff-sum' },
        h('span', { className: 'knit-diff-file' }, diff.rel || ''),
        h('span', { className: 'knit-diff-add' }, `+${Number(diff.added) || 0}`),
        h('span', { className: 'knit-diff-del' }, `−${Number(diff.removed) || 0}`),
        diff.binary ? h('span', { className: 'knit-diff-note' }, t('changes.binary')) : null,
        diff.truncated ? h('span', { className: 'knit-diff-note' }, t('diff.truncated')) : null)
      const body = diff.binary
        ? h('div', { className: 'knit-preview-note' }, t('diff.binary'))
        : h('div', { className: 'knit-diff-body' }, rows)
      return h('div', { className: 'knit-diff' }, head, body)
    }

    function PreviewPanel({ preview, pathImages, fullscreen, ratio, links, linksExpanded, onToggleLinks, onOpenLink, onClose, onOpenLocal, onReveal, onOpenMap, onOpenWeb, onToggleFullscreen, onResizeStart, find, bodyRef, favorite, onToggleFavorite }) {
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

      /* v0.25 查找条：位置与 `linksBar` 同一层（夹在头与正文之间，**不参与正文滚动**）。
         只在查找打开、且这篇有可搜正文（非媒体）时出现；它占的是预览内部的行高，
         预览的**外框高度是写死的**（style.height = 拖出来的比例）⇒ 列表不会被它推着动。 */
      const findBar = find && find.on && !isMedia
        ? h('div', { className: 'knit-findbar' },
            h('div', { className: 'knit-searchwrap' },
              h('input', {
                // 第二个 class 是给测试与样式用的锚点：替身返回的是**扁平**节点表，
                // 没有父子关系可查，而工具栏那个过滤框也叫 .knit-filter —— 不区分就分不出谁是谁。
                className: 'knit-filter knit-findinput',
                ref: find.inputRef,
                value: find.query,
                placeholder: t('find.placeholder'),
                'aria-label': t('find.aria'),
                onChange: (event) => find.onQuery(event.target.value),
                onKeyDown: (event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault()
                    find.onStep(event.shiftKey ? -1 : 1)
                  } else if (event.key === 'Escape') {
                    // 双保险：根上的捕获阶段通常已经处理掉了（那里要抢在列表的 Esc 之前）
                    event.stopPropagation()
                    find.onClose()
                  }
                },
              })),
            h('span', { className: 'knit-findcount', 'aria-live': 'polite' },
              !find.query
                ? ''
                : (find.count > 0
                    ? t('find.count', { current: Math.min(find.index, find.count - 1) + 1, total: find.count })
                    : t('find.none'))),
            h('button', {
              type: 'button', className: 'knit-findnav', title: t('find.prev'),
              disabled: find.count === 0, onClick: () => find.onStep(-1),
            }, '↑'),
            h('button', {
              type: 'button', className: 'knit-findnav', title: t('find.next'),
              disabled: find.count === 0, onClick: () => find.onStep(1),
            }, '↓'),
            h('button', {
              type: 'button', className: 'knit-preview-close', title: t('find.close'), onClick: find.onClose,
            }, '✕'))
        : null

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
      const body = preview.diff
        ? (preview.diff.loading
            ? h('div', { className: 'knit-preview-note' }, t('diff.loading'))
            : preview.diff.error
              ? h('div', { className: 'knit-preview-note' }, t('diff.failed'))
              : h(DiffPane, { diff: preview.diff }))
        : preview.status === 'loading'
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
                ? h(CodePane, {
                    // `rel` 只用来给高亮结果做**按文件的缓存键**（同一篇重开直接命中）。
                    rel: preview.rel,
                    text: preview.text,
                    // 语言提示只认**宿主分类层给的** `language`（v0.19 的既有规矩：
                    // 客户端不再自己看扩展名）。它同时是语言徽章与 `source map` 入口的
                    // 判据，这里多接一根线到官方高亮器。取不到就是纯文本。
                    language: preview.language,
                    anchor: preview.anchor,
                    anchorSeq: preview.anchorSeq,
                  })
                : MarkdownText
                // v0.20：Markdown 也走「跳到你点的那一段」—— DocPane 只负责滚，渲染仍是
                // DSH 那个 MarkdownText（见 DocPane 的注释：不自己造第二套渲染器）。
                ? h(DocPane, {
                    text: preview.text,
                    anchor: preview.anchor,
                    anchorSeq: preview.anchorSeq,
                    // ⚠️ 渲染好的正文走**显式 prop**（`body`）而不是 children：
                    //    组件测试替身展开函数组件时只把 props 传进去（children 留在节点上），
                    //    走 children 的话 MarkdownText 会在替身里凭空消失、既渲染不出也数不到。
                    body: h(MarkdownText, {
                      text: preview.text,
                      labels: { code: { copyLabel: t('code.copy'), copiedLabel: t('code.copied') }, footnotes: '' },
                      pathImages: pathImages || undefined,
                    }),
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
          isCodeView && !preview.diff
            ? h('button', {
                className: 'knit-btn',
                onClick: onCopySource,
                title: copyFailed ? t('preview.copyFailed') : t('code.copy'),
              }, copied ? t('code.copied') : t('code.copy'))
            : null,
          // Source map：**低权重**入口 —— 只在同名 `<file>.map` 真的存在时出现，
          // 且 `.map` 本身不参与检索（需求 §6 §28）。点开仍是这个面板，纯文本。
          isCodeView && !preview.diff && preview.mapRel
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
          // v0.25 媒体收藏：只给媒体档。
          // 「收藏」在文档 / 代码上是另一个概念（那是 Context Pack 的「固定」，宿主存储），
          // 这里不混用，也不给媒体做固定 —— 两套语义各自独立。
          isMedia && onToggleFavorite
            ? h('button', {
                className: 'knit-btn',
                onClick: () => onToggleFavorite(preview.rel),
                title: favorite ? t('fav.removeTitle') : t('fav.addTitle'),
              }, favorite ? t('fav.on') : t('fav.off'))
            : null,
          // v0.25 追加：**查找**按钮。
          // 为什么除了快捷键还要有这个按钮：外层应用（飞书客户端的内置浏览器等）有自己的
          // 原生 Cmd+F，它在按键**进入网页之前**就被处理掉了 —— 网页侧抢不回来。
          // 所以能力必须有一个**不依赖快捷键**的入口。只给有正文的档：媒体档没有可搜的东西。
          !isMedia
            ? h('button', {
                className: 'knit-btn',
                onClick: () => { if (find) find.onOpen() },
                title: t('find.openTitle'),
              }, t('find.openBtn'))
            : null,
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
        // v0.25 查找条：同上，也是「夹在头与正文之间」
        findBar,
        h('div', {
          className: `knit-preview-body${isMedia ? ' is-media' : ''}`,
          ref: bodyRef,
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

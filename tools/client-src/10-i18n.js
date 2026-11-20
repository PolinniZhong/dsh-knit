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
      'count.changes': '{n} 个变更文件',
      'count.changes.filtered': '{hit} / {total} 个变更文件',
      'action.refresh': '刷新',
      'path.openTitle': '在文件管理器中打开',
      'peek.empty': '这个工作区里还没有 Markdown 文档。',
      'action.refreshNow': '立即刷新',

      'sort.relevance': '相关',
      'sort.time': '最新',
      'sort.mediaTimeTitle': '图片一律按时间排序（最新在前）',
      'sort.changesTitle': '变更按文件修改时间列出（最新在前）',
      'sort.relevanceTitle': '按与当前对话的相关性排序（纯本地关键词匹配，不调模型）',
      'sort.timeTitle': '按文件修改时间倒序',

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
      'kind.changes': '变更',
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
      // ── v0.21 上下文控制（固定 / 排除）与关系来源 ────────────────────
      // ⚠️ 三个来源词是**中性词**：来源只说明「它怎么进来的」，不表达强弱。
      //    所以它们一色到底（都是 caption 灰），靠**字**区分，不靠颜色。
      'context.pinned': '固定上下文',
      'context.pinnedHint': '你自己标记的',
      // v0.25：Git 变更关联。**与三层平行的一区**，不参与 01…0N 的编号。
      'context.changes': '变更关联',
      'context.changesHint': '由未提交的改动牵出来的',
      'context.changesEmpty': '{files} 个变更文件，没有找到关联证据',
      'context.changesUnreadable': '读不到 Git 变更状态：{reason}',
      'prov.retrieval': '检索',
      'prov.relation': '关系',
      'prov.manual': '用户固定',
      // v0.23：第四档来源。它**只**由「标题 + 摘要」的向量与任务相似而来 ——
      // 不是关键词命中、也不是关系证据，而且只可能落在「相关」那一层。
      'prov.semantic': '语义相关',
      'prov.change': '变更关联',
      'control.pin': '固定',
      'control.unpin': '取消固定',
      'control.exclude': '排除',
      'control.restore': '恢复',
      'control.excluded': '被用户排除：{rel}',
      'control.failed': '操作没生效：{error}',
      // 行级证据（需求 §6.2）：类型 + 方向 + 谁 + 第几行 + 打开。点「为什么」才展开。
      'rel.toggle': '点开看这一行的证据',
      'rel.references': '引用',
      'rel.imports': '导入',
      'rel.tests': '测试',
      'rel.documents': '描述',
      'rel.line': '第 {line} 行',
      'rel.open': '打开',
      'rel.more': '共 {n} 条关系，每项最多投影 {max} 条（预算，不是建议）',
      // 检索状态摘要（需求 §6.3）：**分组与顺序本身就是这条设计要传达的信息** ——
      // 工作区候选 ｜ 检索与调整 ｜ 最终结果；三组之间是细竖线，组内是中点（见 CSS 的 .knit-pipe）。
      // ⚠️ 每一格都是**已经发生过的事实**，不是估算，也不许改成别的口径（见宿主侧注释）。
      'pipe.collect': '收集 {n}',
      'pipe.exclude': '排除 {n}',
      // v0.21.x（2026-10-09 用户规格）：排除之后的候选数原来是一个**光数字**（只有
      // 「→ 79」），现在给它一个名字 —— 状态摘要里每一格都必须能独立读懂。
      'pipe.candidates': '候选 {n}',
      'pipe.rank': 'BM25 检索',
      // ⚠️ 「关系 N 条」说的是**这一份包里带了几条关系证据**（三层各条 relations 之和），
      // 不是工作区里的关系总数、也不是候选数（那两类数字宿主另有字段，这里不展示）。
      'pipe.relations': '关系 {n} 条',
      // v0.25：状态行里那一格（**默认关**）。关着也出现 —— 藏起来用户就永远打不开这个功能。
      'pipe.changesOff': '变更',
      'pipe.changesOn': '变更 {n}',
      'pipe.changesUnavailable': '变更 —',
      'changes.titleOff': '按 Git 变更查找需要一起检查的文件（只读：只跑一条 git status，不执行任何写操作）',
      'changes.titleOn': '{files} 个变更文件 · {related} 条关联证据 · 点一下关闭',
      'changes.titleUnavailable': '读不到 Git 变更状态：{reason}',
      'changes.reason.notARepo': '不是 Git 工作区',
      'changes.reason.gitMissing': '找不到 git 命令',
      'changes.reason.timeout': 'git 读取超时',
      'changes.reason.tooLarge': 'git 输出过大（已截断）',
      'changes.reason.failed': 'git 读取失败',
      'changes.reason.request': '变更关联接口请求失败',
      'changes.reason.unknown': '原因未知',
      // ⚠️ 「固定 N」= 有几篇被你固定、因此**从三层移出**进了固定区（pack.pinned 的长度）。
      // 不写「固定覆盖」这种内部说法；也不带量词 —— 固定对象可能是文档、代码或媒体。
      'pipe.pin': '固定 {n}',
      'pipe.pack': '入包 {n}',
      // v0.23（Phase A）：混合检索。**默认词法** —— 这一格说的是实际生效的模式，不是用户的点击。
      'pipe.rankHybrid': 'BM25 + 语义补充',
      // 语义候选**只计数**（Phase A 不进包）。它是「有界」的：上限由消融定（方案 §5.2）。
      'pipe.semantic': '语义候选 {n} 条',
      // 检索模式选择器（工具栏第三组）
      'sem.mode.aria': '检索模式',
      'sem.mode.lexical': '词法',
      'sem.mode.hybrid': '混合',
      'sem.mode.lexicalTitle': '词法检索：BM25 + IDF，纯本地、零模型调用（默认）',
      'sem.mode.hybridTitle': '混合检索（实验）：在词法候选之外补充语义候选；需要先配置 provider',
      // ⚠️ 2026-10-13：原来的 sem.mode.lexicalShort / hybridShort 两个**短标签键已删除** ——
      // 检索方式的可见文案改成状态行的 pipe.rank / pipe.rankHybrid（实际生效的模式），
      // 键留着只会变成没人渲染的死键（i18n 的键集对齐守卫也查不出「定义了但没人用」）。
      // 菜单里两个选项的副文案（长解释收进菜单，工具栏不再挤第三组）
      'sem.mode.lexicalOption': '词法检索',
      'sem.mode.hybridOption': '混合检索 · 实验',
      'sem.mode.lexicalDesc': '默认模式；沿用当前 BM25 + IDF 排序。',
      'sem.mode.hybridDesc': '在词法候选之外补充语义候选；需先配置 provider。',
      // 菜单底部的**状态行**（如实说这一档现在到底生效成什么，不美化）
      'sem.state.lexical': '当前按词法检索。',
      'sem.state.hybridLive': '混合已生效：语义候选只追加在「相关」层最后，主要 / 辅助两层不动。',
      'sem.state.noProvider': '未配置 provider —— 混合还没生效。',
      // 就地配置入口（未配 provider 时菜单里那一条）
      'sem.cfg.show': '配置语义 provider…',
      'sem.cfg.hide': '收起配置',
      // 混合没生效时的**事实**（宿主只给码，文案在这里）
      'sem.reason.noProvider': '混合检索不可用：还没有配置 provider',
      'sem.reason.probeFailed': '混合检索不可用：provider 连不上',
      'sem.reason.timeout': '混合检索不可用：provider 超时',
      'sem.reason.badResponse': '混合检索不可用：provider 返回了无法解析的结果',
      'sem.reason.noQuery': '混合检索不可用：这一轮没有可用的查询文本',
      'sem.reason.unknown': '混合检索不可用：原因未知（已退回词法）',
      // 防御性：时间序下宿主整层短路，回的是这个码（界面极少走到 —— 那档根本不出现这个下拉）
      'sem.reason.notApplicable': '混合检索不适用：时间序没有相关性分层（已按词法）',
      // 老宿主没有 `semantic` 字段 ⇒ 如实说是宿主的问题，不让用户去配一个用不上的 provider
      'sem.unsupported': '混合检索不可用：当前宿主版本不支持（已退回词法）',
      // 最小配置区（就地一行，不是面板）
      'sem.kindAria': 'provider 类型',
      'sem.kind.ollama': 'Ollama（本地）',
      'sem.kind.openai': 'OpenAI 兼容',
      'sem.basePlaceholder': '服务地址，如 http://127.0.0.1:11434',
      'sem.baseAria': 'provider 服务地址',
      'sem.modelPlaceholder': '模型名，如 nomic-embed-text',
      'sem.modelAria': 'provider 模型名',
      'sem.save': '保存并测试',
      'sem.saving': '测试中…',
      'sem.saveTitle': '保存配置并让宿主探测一次（会发一次请求）',
      'sem.savedOk': '已保存：provider 可用',
      'sem.savedFail': '已保存，但 provider 现在还不可用',
      // ⚠️ 披露措辞不许含糊：回环 = 不离开本机；其余一律明写「会发送到 <地址>」
      'sem.disclose.local': '本地服务：内容不离开这台机器',
      'sem.disclose.empty': '填上服务地址后，这里会写明内容会不会离开这台机器',
      'sem.disclose.remote': '内容会发送到你配置的服务 {base}',
      // 理由码 → 文案。宿主只给码（AGENTS.md §4.5），翻译在这里。
      // ⚠️ 2026-09-29 用户要求把这行压得更克制：原来是「直接命中当前话题：…」，
      // 读起来像调试信息。现在它是**标签 + 值**，词之间用「 · 」分隔。
      // ⚠️ 2026-10-07 用户裁决（去掉中文全角冒号）：这一族标签原来是
      // 「直接命中」「标题命中」后面跟一个全角冒号。全角冒号在中文里占**一个整字宽**
      // 且强制一个停顿 —— 这一行是 metadata，两个标签并排时显得很重；去掉后
      // 「命中在前、值紧随」，也正是用户要的阅读顺序。**冒号只在「引出列表」时保留**
      // （正文里的句子照旧，见 `list.failed` 这类），**英文保留 ASCII 冒号**：
      // 它只占半个字宽，而且英文靠它把标签和值绑在一起。
      'why.direct': '直接命中 {term}',
      'why.titleMatch': '标题命中 {term}',
      // v0.19：代码占的是 `title` / `summary` 两个槽位（文件名、所在目录），
      // 但**不能**对 `.ts` 文件说「标题命中」—— 判据一样，称谓必须分开。
      // 这两个码由宿主直接给出（`context.js` 的 `explainContext()`），
      // 客户端不做 kind → key 的重映射：宿主给什么码就翻什么码。
      'why.filenameMatch': '文件名命中 {term}',
      'why.pathMatch': '路径命中 {term}',
      'why.summaryMatch': '摘要命中 {term}',
      'why.bodyMatch': '正文命中 {term}',
      'why.bodyMatchPlain': '正文命中',
      'why.linkTarget': '被主要上下文引用',
      'why.linkSource': '引用了主要上下文',
      'why.related': '与当前任务相关',
      // v0.23：语义补进来的理由。**只陈述可复核的事实**（标题 + 摘要的向量与任务相似），
      // 不许写成「模型觉得相关」这类不可核查的话。
      'why.semantic': '语义相关',

      'row.tooltip': '{path}\n单击就地预览 · 双击在新标签页打开',
      /* v0.20：命中片段（需求 §12）。**纯 metadata**：行号区间，不是分数、不是评分、
         不是「相关度 92%」。点击＝就地预览并跳到那一段（代码可跳，Markdown 见已知限制）。 */
      'row.passages': '命中段 {range}',
      'summary.empty': '（没有正文摘要）',

      'list.scanning': '正在扫描工作区…',
      'list.failed': '读取失败：{error}',
      'list.failedHint': '确认插件宿主半边已加载。',
      'list.empty': '这个工作区里还没有 Markdown 文档。',
      'list.emptyCode': '这个工作区里还没有可纳入上下文的代码文件。',
      'list.emptyMedia': '这个工作区里还没有图片或视频。',
      'list.emptyChanges': '工作区里没有未提交的改动。',
      'list.changeOnlyOther': '有 {n} 个变更文件，但没有可列出的 Markdown / 代码。',
      'list.changesLoading': '正在读取 Git 变更…',
      'changes.unavailable': '读不到 Git 变更：{reason}',
      'changes.status.modified': '修改',
      'changes.status.added': '新增',
      'changes.status.deleted': '删除',
      'changes.status.renamed': '重命名',
      'changes.status.untracked': '新文件',
      'changes.status.unmerged': '冲突',
      'changes.status.copied': '复制',
      'changes.binary': '二进制',
      'changes.lines': '行数统计不可用',
      'diff.loading': '正在读取 diff…',
      'diff.failed': '读取 diff 失败',
      'diff.binary': '二进制文件，没有文本 diff',
      'diff.truncated': 'diff 已截断',
      'changes.title': '未提交的改动（只读 git status + numstat）',
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

      'preview.loading': '正在读取…',
      'preview.truncated': '（文件较大，仅预览前 512 KB）',
      // v0.25 预览里的查找（Cmd+F）。数字用 {current}/{total}，两种语言同形。
      'lightbox.aria': '查看大图：{name}',
      'lightbox.close': '关闭（Esc）',
      /* v0.26 图内评论：pin / 就地编辑 / 底部评论栏。
         发送出去的文本**不走这两本词典** —— 它是给 agent 的事实格式（§四），不随界面语言变。 */
      'lightbox.comment.enter': '评论',
      'lightbox.comment.exit': '退出评论',
      'lightbox.comment.title': '在图上点一下落 pin，写一句给 agent',
      'lightbox.comment.placeholder': '哪里不对？写一句…',
      'lightbox.comment.pinAria': '第 {n} 条评论',
      'lightbox.comment.new': '新评论',
      'lightbox.comment.edit': '评论 {n}',
      'lightbox.comment.cancel': '取消',
      'lightbox.comment.save': '保存',
      'lightbox.comment.delete': '删除',
      'lightbox.comment.empty': '这张图还没有评论',
      'lightbox.comment.emptyHint': '点一下图片上的位置，写下第一条评论',
      'lightbox.comment.count': '{n} 条评论',
      'lightbox.comment.send': '发送',
      'lightbox.comment.sendTitle': '把坐标和文字投进输入框（不会自动发送）',
      'lightbox.comment.sent': '已投进输入框（含原图附件），按 Enter 发送',
      'lightbox.comment.sentNoImage': '已投递文本，但图片附件没带上（请手动把图拖进输入框）',
      'lightbox.comment.copied': '输入框没接住，已复制到剪贴板',
      'lightbox.comment.downloaded': '输入框没接住，已下载为 txt',
      'lightbox.comment.sendFailed': '投递失败，请手动复制',
      'lightbox.comment.tooLong': '一条最多 {max} 字',
      'lightbox.comment.full': '一张图最多 {max} 条评论',
      'lightbox.canvas.back': '返回',
      'lightbox.canvas.backTitle': '关掉画布，回到媒体列表',
      'lightbox.canvas.fullscreen': '全屏',
      'lightbox.canvas.fullscreenTitle': '在整屏里看细节（评论会保留）',
      'lightbox.canvas.dock': '画布',
      'lightbox.canvas.dockTitle': '回到 Knit 面板里的画布（不盖住会话）',
      'lightbox.canvas.commentHint': '评论',
      'lightbox.canvas.hintTitle': '点击在 Knit 面板里打开画布并评论（不盖住会话）',
      'lightbox.canvas.prev': '上一张',
      'lightbox.canvas.next': '下一张',
      'attach.badge': '对话',
      'attach.title': '对话里生成的图，还没保存到本地',
      'fav.off': '收藏',
      'fav.on': '已收藏',
      'fav.addTitle': '收藏（排在媒体列表最前面）',
      'fav.removeTitle': '取消收藏',
      'fav.mark': '已收藏',
      'find.openBtn': '查找',
      'find.openTitle': '在本文里查找（Cmd+F）',
      'find.placeholder': '在本文里查找',
      'find.aria': '在预览的文档里查找',
      'find.count': '{current}/{total}',
      'find.none': '无结果',
      'find.prev': '上一个',
      'find.next': '下一个',
      'find.close': '关闭查找',
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
      'host.diffFailed': '读取 diff 失败',
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
      'count.changes': '{n} changed files',
      'count.changes.filtered': '{hit} / {total} changed files',
      'action.refresh': 'Refresh',
      'path.openTitle': 'Open in file manager',
      'peek.empty': 'No Markdown documents in this workspace yet.',
      'action.refreshNow': 'Refresh now',

      'sort.relevance': 'Relevant',
      'sort.time': 'Recent',
      'sort.mediaTimeTitle': 'Images are always sorted by newest first',
      'sort.changesTitle': 'Changes are listed by file modification time (newest first)',
      'sort.relevanceTitle': 'Sort by relevance to the current conversation (local keyword matching, no model call)',
      'sort.timeTitle': 'Sort by file modified time, newest first',

      'kind.doc': 'Docs',
      'kind.code': 'Code',
      // 2026-10-06: user picked 「媒体」 for the tab + the "All" section title, so English
      // follows the same word as count.media ("{n} media"): the tab says Media, and the
      // explicit "images and videos" wording stays in the empty state / README prose.
      'kind.media': 'Media',
      'kind.changes': 'Changes',
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
      // ── v0.21 context control (pin / exclude) and relation provenance ──
      // ⚠️ The three provenance words are **neutral**: provenance says how an item got
      //    in, not how strong it is — so they share one colour and differ by word.
      'context.pinned': 'Pinned',
      'context.pinnedHint': 'you marked these',
      'context.changes': 'Tied to changes',
      'context.changesHint': 'pulled in by your uncommitted edits',
      'context.changesEmpty': '{files} changed file(s), no related evidence found',
      'context.changesUnreadable': 'Git change status unavailable: {reason}',
      'prov.retrieval': 'retrieved',
      'prov.relation': 'relation',
      'prov.manual': 'pinned',
      // v0.23: the fourth provenance (semantic) — same neutral, lowercase word group.
      'prov.semantic': 'semantic',
      'prov.change': 'change',
      'control.pin': 'Pin',
      'control.unpin': 'Unpin',
      'control.exclude': 'Exclude',
      'control.restore': 'Restore',
      'control.excluded': 'Excluded by you: {rel}',
      'control.failed': 'Action failed: {error}',
      'rel.toggle': 'open the evidence for this line',
      'rel.references': 'references',
      'rel.imports': 'imports',
      'rel.tests': 'tests',
      'rel.documents': 'documents',
      'rel.line': 'line {line}',
      'rel.open': 'Open',
      'rel.more': '{n} relations total, at most {max} projected per item',
      'pipe.collect': '{n} collected',
      'pipe.exclude': '{n} excluded',
      'pipe.candidates': '{n} candidates',
      'pipe.rank': 'BM25 retrieval',
      'pipe.relations': '{n} relations',
      'pipe.changesOff': 'Changes',
      'pipe.changesOn': 'Changes {n}',
      'pipe.changesUnavailable': 'Changes —',
      'changes.titleOff': 'Find the files to check alongside your Git changes (read-only: one git status, no write commands)',
      'changes.titleOn': '{files} changed file(s) · {related} related by evidence · click to turn off',
      'changes.titleUnavailable': 'Git change status unavailable: {reason}',
      'changes.reason.notARepo': 'not a Git working tree',
      'changes.reason.gitMissing': 'git command not found',
      'changes.reason.timeout': 'git timed out',
      'changes.reason.tooLarge': 'git output too large (truncated)',
      'changes.reason.failed': 'git read failed',
      'changes.reason.request': 'the change-links request failed',
      'changes.reason.unknown': 'unknown reason',
      'pipe.pin': '{n} pinned',
      'pipe.pack': '{n} in pack',
      // v0.23 (Phase A): hybrid retrieval. This cell states the mode **in effect**, not the click.
      'pipe.rankHybrid': 'BM25 + semantic',
      'pipe.semantic': '{n} semantic candidates',
      'sem.mode.aria': 'Retrieval mode',
      'sem.mode.lexical': 'Lexical',
      'sem.mode.hybrid': 'Hybrid',
      'sem.mode.lexicalTitle': 'Lexical retrieval: BM25 + IDF, fully local, no model call (default)',
      'sem.mode.hybridTitle': 'Hybrid retrieval (experimental): adds semantic candidates on top of lexical ones; needs a configured provider',
      'sem.mode.lexicalOption': 'Lexical retrieval',
      'sem.mode.hybridOption': 'Hybrid retrieval · experimental',
      'sem.mode.lexicalDesc': 'Default: keeps the current BM25 + IDF ranking.',
      'sem.mode.hybridDesc': 'Adds semantic candidates on top of the lexical ones; needs a configured provider.',
      'sem.state.lexical': 'Currently lexical retrieval.',
      'sem.state.hybridLive': 'Hybrid is live: semantic candidates are appended to the related tier only; primary and supporting are unchanged.',
      'sem.state.noProvider': 'No provider configured — hybrid is not active yet.',
      'sem.cfg.show': 'Configure semantic provider…',
      'sem.cfg.hide': 'Hide configuration',
      'sem.reason.noProvider': 'Hybrid retrieval unavailable: no provider configured yet',
      'sem.reason.probeFailed': 'Hybrid retrieval unavailable: provider is unreachable',
      'sem.reason.timeout': 'Hybrid retrieval unavailable: provider timed out',
      'sem.reason.badResponse': 'Hybrid retrieval unavailable: provider returned an unusable response',
      'sem.reason.noQuery': 'Hybrid retrieval unavailable: no usable query text this round',
      'sem.reason.unknown': 'Hybrid retrieval unavailable: unknown reason (fell back to lexical)',
      'sem.reason.notApplicable': 'Hybrid retrieval does not apply: a time-ordered list has no relevance tiers (kept lexical)',
      'sem.unsupported': 'Hybrid retrieval unavailable: this host version does not support it (fell back to lexical)',
      'sem.kindAria': 'Provider kind',
      'sem.kind.ollama': 'Ollama (local)',
      'sem.kind.openai': 'OpenAI-compatible',
      'sem.basePlaceholder': 'Service URL, e.g. http://127.0.0.1:11434',
      'sem.baseAria': 'Provider service URL',
      'sem.modelPlaceholder': 'Model name, e.g. nomic-embed-text',
      'sem.modelAria': 'Provider model name',
      'sem.save': 'Save and test',
      'sem.saving': 'Testing…',
      'sem.saveTitle': 'Save the configuration and let the host probe it once (sends one request)',
      'sem.savedOk': 'Saved: provider is available',
      'sem.savedFail': 'Saved, but the provider is still unavailable',
      'sem.disclose.local': 'Local service: content stays on this machine',
      'sem.disclose.empty': 'Once a service URL is filled in, this line says whether content leaves this machine',
      'sem.disclose.remote': 'Content will be sent to your configured service {base}',
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
      // v0.23: semantic match — states the verifiable fact (title + summary embedding),
      // never "the model thinks this is relevant".
      'why.semantic': 'semantic match',

      'row.tooltip': '{path}\nClick to preview here · double-click to open in a new tab',
      /* v0.20：matched passage range (requirement §12) — metadata only, never a score. */
      'row.passages': 'Passage: {range}',
      'summary.empty': '(no summary)',

      'list.scanning': 'Scanning the workspace…',
      'list.failed': 'Failed to read: {error}',
      'list.failedHint': 'Make sure the plugin’s host half is loaded.',
      'list.empty': 'No Markdown documents in this workspace yet.',
      'list.emptyCode': 'No code files eligible for context in this workspace yet.',
      'list.emptyMedia': 'No images or videos in this workspace yet.',
      'list.emptyChanges': 'No uncommitted changes in this workspace.',
      'list.changeOnlyOther': '{n} changed file(s), but no Markdown / code to list.',
      'list.changesLoading': 'Reading Git changes…',
      'changes.unavailable': 'Git changes unavailable: {reason}',
      'changes.status.modified': 'Modified',
      'changes.status.added': 'Added',
      'changes.status.deleted': 'Deleted',
      'changes.status.renamed': 'Renamed',
      'changes.status.untracked': 'Untracked',
      'changes.status.unmerged': 'Conflict',
      'changes.status.copied': 'Copied',
      'changes.binary': 'binary',
      'changes.lines': 'line counts unavailable',
      'diff.loading': 'Reading diff…',
      'diff.failed': 'Could not read the diff',
      'diff.binary': 'Binary file — no text diff',
      'diff.truncated': 'Diff truncated',
      'changes.title': 'Uncommitted changes (read-only git status + numstat)',
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

      'preview.loading': 'Loading…',
      'preview.truncated': '(large file — showing the first 512 KB)',
      'lightbox.aria': 'Image viewer: {name}',
      'lightbox.close': 'Close (Esc)',
      'lightbox.comment.enter': 'Comment',
      'lightbox.comment.exit': 'Exit comment',
      'lightbox.comment.title': 'Click the image to drop a pin, then write one line for the agent',
      'lightbox.comment.placeholder': 'What is wrong here?',
      'lightbox.comment.pinAria': 'Comment {n}',
      'lightbox.comment.new': 'New comment',
      'lightbox.comment.edit': 'Comment {n}',
      'lightbox.comment.cancel': 'Cancel',
      'lightbox.comment.save': 'Save',
      'lightbox.comment.delete': 'Delete',
      'lightbox.comment.empty': 'No comments on this image yet',
      'lightbox.comment.emptyHint': 'Click a spot on the image to add the first comment',
      'lightbox.comment.count': '{n} comments',
      'lightbox.comment.send': 'Send',
      'lightbox.comment.sendTitle': 'Insert the coordinates and text into the composer (it will not be sent automatically)',
      'lightbox.comment.sent': 'Inserted into the composer with the original image — press Enter to send',
      'lightbox.comment.sentNoImage': 'Text inserted, but the image attachment failed — drag the image into the composer',
      'lightbox.comment.copied': 'Composer did not accept it — copied to clipboard',
      'lightbox.comment.downloaded': 'Composer did not accept it — downloaded as a txt file',
      'lightbox.comment.sendFailed': 'Delivery failed — copy it manually',
      'lightbox.comment.tooLong': 'Up to {max} characters per note',
      'lightbox.comment.full': 'Up to {max} comments per image',
      'lightbox.canvas.back': 'Back',
      'lightbox.canvas.backTitle': 'Close the canvas and return to the media list',
      'lightbox.canvas.fullscreen': 'Full screen',
      'lightbox.canvas.fullscreenTitle': 'View details full screen (comments are kept)',
      'lightbox.canvas.dock': 'Canvas',
      'lightbox.canvas.dockTitle': 'Back to the canvas inside the Knit panel (the conversation stays visible)',
      'lightbox.canvas.commentHint': 'Comment',
      'lightbox.canvas.hintTitle': 'Click to open the canvas in the Knit panel and comment (the conversation stays visible)',
      'lightbox.canvas.prev': 'Previous image',
      'lightbox.canvas.next': 'Next image',
      'attach.badge': 'Chat',
      'attach.title': 'Generated in this chat — not saved locally yet',
      'fav.off': 'Favorite',
      'fav.on': 'Favorited',
      'fav.addTitle': 'Favorite this (it moves to the front of the media list)',
      'fav.removeTitle': 'Remove favorite',
      'fav.mark': 'Favorited',
      'find.openBtn': 'Find',
      'find.openTitle': 'Find in this document (Cmd+F)',
      'find.placeholder': 'Find in this document',
      'find.aria': 'Find in the previewed document',
      'find.count': '{current}/{total}',
      'find.none': 'No results',
      'find.prev': 'Previous',
      'find.next': 'Next',
      'find.close': 'Close find',
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
      'host.diffFailed': 'Could not read the diff',
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
      'knit/diff-failed': 'host.diffFailed',
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


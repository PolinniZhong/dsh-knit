    /* ── 样式：跟随 DSH 主题令牌，深浅色自适应 ───────────────── */
    const STYLE_ID = 'dsh-knit-style'
    const CSS = `
.knit-root{
  /* 交互强调色统一走 DSH 品牌令牌：浅色 #4176e6 / 暗色 #5686fe，随主题切换。
     这里曾经硬编码过一套紫与另一套蓝，两套都不跟主题，深色下尤其突兀。
     填充改用 DSH 选中态的半透明令牌，不自己混色 —— color-mix 在旧内核上
     会让整条声明失效（invalid at computed-value time），不是渐进增强。 */
  --knit-accent:var(--dsw-alias-brand-primary-new-colorprimary-new-color,#4176e6);
  /* 悬停 / 选中 / 命中段的灰底：**一律从 DSH 官方那两个交互令牌推**，不自己发明色。
     官方值在 dsh-client-ui-theme/lib/client.js 里，浅色在前、暗色在后：
       --dsw-alias-interactive-bg-hover   浅 #2631480f = 5.88%   暗 #ffffff14 = 7.84%
       --dsw-alias-interactive-bg-active  浅 #2631481a = 10.20%  暗 #ffffff24 = 14.12%
     Knit 的行比 DSH 的控件更小更密，所以取官方透明度的**一个固定比例**，
     而不是把官方值原样搬过来（起因：用户觉得 DSH 默认那档「太灰了」，对比度被吃掉）。
     浅色比例：悬停 ×0.41、选中 ×0.60、命中段 ×0.90；**暗色是浅色这组再 ×0.9**
     （2026-10-07 用户：「暗色下最高那一档白得犯晕……再降一下，降 10%」）。
     命中段是三档里最高的一档，必须比「行选中」再深一点，否则它在被选中 / 悬停的行里会消失。 */
  --knit-hover-bg:rgba(38,49,72,.024);   /* 官方 5.88% × 0.41 */
  --knit-active-bg:rgba(38,49,72,.061);  /* 官方 10.20% × 0.60 */
  /* 「命中段」那一格要一个**灰底**而不是白描边（2026-10-07 用户裁决，原话是
     「叫它寻一个背景就行了，寻灰背景就行了，不需要在背景填充外面再加一个白色的描边」）。 */
  --knit-chip-bg:rgba(38,49,72,.092);    /* 官方 10.20% × 0.90 */

  display:flex;flex-direction:column;height:100%;min-height:0;
  color:var(--dsw-alias-label-primary,#e8eaed);font-size:13px}
body[data-ds-dark-theme] .knit-root{
  /* 2026-10-07 用户：暗色下列表里最高那一档「白得犯晕」—— 命中段的底原本是**纯白 13%**，
     确实是我们自己拍的数（官方 active 只有 14.12%）。现在三档一律「官方值 × 浅色比例 × 0.9」：
       悬停 7.84% × 0.41 × 0.9 ≈ .028（原 .031）
       选中 14.12% × 0.60 × 0.9 ≈ .076（原 .085）
       命中 14.12% × 0.90 × 0.9 ≈ .114（原 .13 —— 降幅最多，因为那个数本来就是自己拍的）
     α 只保留三位小数，所以是「≈」；三档相对深浅的关系没变。 */
  --knit-hover-bg:rgba(255,255,255,.028);
  --knit-active-bg:rgba(255,255,255,.076);
  --knit-chip-bg:rgba(255,255,255,.114);
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
      box-shadow（md §五）。暗色下靠 --knit-active-bg 这个 token，不写死颜色。
   ⚠️ 2026-10-09（v0.21.x 用户规格）/ 2026-10-12（v0.23.1 用户裁决）：这一行是
      **两组 + 一个右对齐容器**，顺序就是控件顺序，别再挪 —— ① 排序「相关 / 最新」（灰底分段控件）
      ② 一条浅灰竖线 ③ 类型「文档 / 代码 / 媒体」（下划线页签，**三档**）
      ④ .knit-bar-right：检索模式小下拉（只在相关档出现）+ 搜索框（贴右、宽度自适应、唯一可伸缩项）。
      那根竖线是**边界**，不是把六个选项连成一个整体：排序与类型是两个互不干扰的条件，
      搜索只过滤当前范围、不重置它们（用户规格 §三.3）。 */
.knit-bar{display:flex;align-items:center;gap:8px;padding:0 12px 8px;flex:none}
/* v0.23（Phase A）：检索模式的两条行 —— 都只在**用户选了混合**时出现，默认词法时一个节点都不产生。
   ① .knit-retnote = 混合没生效时的**事实行**（未配置 / 连不上 / 超时 / 返回不合法 / 没有可用查询文本 /
      宿主版本较旧）。它是说明，不是错误提示，所以用次级文字色、不占卡片、不弹窗。
   ② .knit-semcfg = 「选了混合 + provider 不可用」时**就地**展开的一行最小配置。
      不是 Dashboard、不加滚动容器；三格控件都 flex:0/1 + min-width:0，窄面板先缩输入框。 */
/* 检索模式那两组控件（工具栏第三组 / 配置区的 provider 类型）用**自己的类名**：
   样式与 .knit-seg / .knit-seg-btn **逐字同值**（同一套 token、同一组数值、同一档 0.5px 描边），
   只是它们是**另一个控件** —— 用同一个类名会让「工具栏里恰好两个排序按钮」那类老守卫
   在查询 knit-seg-btn 时把检索模式的按钮也算进去。
   ⚠️ 这段注释里不许出现反引号 —— 整个 CSS 在一个模板串里，一个反引号就会提前截断它。 */
.knit-retseg{display:inline-flex;flex:none;border-radius:10px;overflow:hidden;
  border:0.5px solid var(--dsw-alias-border-l3,rgba(255,255,255,.12))}
.knit-retseg-btn{height:28px;padding:0 15px;cursor:pointer;font-size:13px;font-weight:400;
  border:none;background:transparent;color:var(--dsw-alias-label-secondary,#9aa0a6);
  transition:background .16s ease,color .16s ease}
.knit-retseg-btn + .knit-retseg-btn{border-left:0.5px solid var(--dsw-alias-border-l3,rgba(255,255,255,.12))}
.knit-retseg-btn:hover{background:var(--knit-hover-bg,rgba(255,255,255,.03))}
.knit-retseg-btn.active{background:var(--knit-active-bg,rgba(255,255,255,.085));
  color:var(--dsw-alias-label-primary,#e8eaed);font-weight:600}
.knit-retnote{flex:none;padding:0 12px 8px;font-size:11px;line-height:1.5;
  color:var(--dsw-alias-label-secondary,#9aa0a6)}
.knit-semcfg{display:flex;align-items:center;gap:8px;padding:0 12px 8px;flex:none;flex-wrap:wrap}
.knit-semcfg-input{flex:1 1 140px;min-width:0;max-width:240px;height:28px;padding:0 12px;border-radius:10px;
  font-size:13px;background:transparent;color:var(--dsw-alias-label-primary,#e8eaed);
  border:0.5px solid var(--dsw-alias-border-l3,rgba(255,255,255,.12))}
.knit-semcfg-note{flex:1 1 100%;font-size:11px;line-height:1.5;color:var(--dsw-alias-label-secondary,#9aa0a6)}
/* 排序组与类型组之间**不再有竖线**（2026-10-12 用户裁决：「最新跟文档之间那条竖线可以去掉」）——
   那根线的节点、类名与 CSS 规则**整体删除**，两组现在只靠 .knit-bar 的 gap 分隔。
   留档：从前那根线取 .knit-seg 外框 / .knit-filter 描边同一个 border-l3（三处一样淡）、
   粗细 1px（0.5px 在高分屏上看不见）、纯装饰 aria-hidden —— 这些理由随它一起作废。 */
.knit-seg{display:inline-flex;flex:none;border-radius:10px;overflow:hidden;
  border:0.5px solid var(--dsw-alias-border-l3,rgba(255,255,255,.12))}
.knit-seg-btn{height:28px;padding:0 15px;cursor:pointer;font-size:13px;font-weight:400;
  border:none;background:transparent;color:var(--dsw-alias-label-secondary,#9aa0a6);
  transition:background .16s ease,color .16s ease}
.knit-seg-btn + .knit-seg-btn{border-left:0.5px solid var(--dsw-alias-border-l3,rgba(255,255,255,.12))}
.knit-seg-btn:hover{background:var(--knit-hover-bg,rgba(255,255,255,.03))}
.knit-seg-btn.active{background:var(--knit-active-bg,rgba(255,255,255,.085));
  color:var(--dsw-alias-label-primary,#e8eaed);font-weight:600}
/* 搜索框在工具栏**尾部**（用户规格 §二.3：搜索是对当前列表的进一步过滤，放最右符合
   工具栏惯例）。flex-basis 180px + grow ⇒ 常规面板里就是 180–240px 并贴住右边；
   max-width 240px 封顶之后剩下的空间交给 margin-left:auto（否则它会一路长到面板边缘）。
   ⚠️ min-width:0 = 面板窄了**先缩搜索框**；前面两组都 flex:none，永远不被它挤。
   v0.23（2026-10-11 用户裁决）：描边从 input 挪到**外层容器** —— 因为检索模式那个小下拉
   就贴在容器右端（中间一条细左线），两者共用一圈描边才像一个整体控件。
   焦点态挪到 :focus-within（输入框与下拉谁拿到焦点，外框都亮）—— 行为与原来一致。 */
/* v0.23.1：右侧两个控件的**右对齐容器** —— 检索模式在搜索框左边。
   margin-left:auto 从搜索框移交到这里；容器自身可缩（min-width:0），
   里面**只有搜索框**是 flex:1 1 的可伸缩项 ⇒ 窄屏先缩搜索框。
   ⚠️ 这段注释里不许出现反引号 —— 整个 CSS 在一个模板串里。 */
.knit-bar-right{display:flex;align-items:center;gap:8px;margin-left:auto;min-width:0;justify-content:flex-end}
.knit-searchwrap{display:flex;align-items:center;flex:1 1 180px;min-width:0;max-width:240px;
  border:0.5px solid var(--dsw-alias-border-l3,rgba(255,255,255,.12));border-radius:10px;
  transition:border-color .16s ease}
.knit-searchwrap:focus-within{border-color:var(--knit-accent)}
.knit-filter{flex:1 1 auto;min-width:0;height:28px;padding:0 12px;border:none;border-radius:10px;font-size:13px;
  background:transparent;color:var(--dsw-alias-label-primary,#e8eaed);outline:none}
/* v0.24（2026-10-12 用户裁决 + Demo 参考）：检索方式做成状态行里**可点的状态格**。
   外观（2026-10-12 第三次裁决，用户：「UI 视觉参考命中段那种来修改」）：
   **逐条对齐 .knit-hit（命中段）那套** —— 这是同一份视觉语言的复用，不是新造一个控件：
   · 底 = --knit-chip-bg（三档灰底里最深那档，命中段同源；比行选中那档深一点）；
   · 圆角 6px、内边距 1px 6px、描边一根都没有（与命中段逐字同值）；
   · 字色 = 次级灰，hover / 键盘焦点 → 主文本色 + 下划线（命中段同款提示）；
   · **字号 / 行高 / 字重与命中段逐字同值**（font:inherit + font-size:11px + line-height:15px、
     不设 font-weight ⇒ 跟随所在行）：2026-10-13 用户裁决「字号与背景胶囊修改成命中段一样」。
     ⚠️ 这一格因此比它所在的状态行（10.5px）**大 0.5px** —— 那是有意的：它是这一行里唯一的可点控件，
     与命中段同一档，才让人一眼认出「这两处是同一类东西」。 */
.knit-pipe-method-wrap{position:relative;flex:none}
.knit-pipe-method{display:inline-flex;align-items:center;flex:none;white-space:nowrap;cursor:pointer;
  padding:1px 6px;border:0;outline:none;border-radius:6px;
  background:var(--knit-chip-bg,rgba(255,255,255,.12));
  font:inherit;font-size:11px;line-height:15px;
  color:var(--dsw-alias-label-secondary,#61666b)}
/* 悬停只提亮颜色；**下划线给包文字的那一层**，不给按钮本身 ——
   父级的 text-decoration 会传播到全部子节点、子级又无法取消，
   所以写在按钮上会让箭头 › 也一起被划上（2026-10-13 用户裁决）。 */
.knit-pipe-method:hover,.knit-pipe-method:focus-visible{color:var(--dsw-alias-label-primary,#e8eaed)}
.knit-pipe-method:hover .knit-pipe-method-label,
.knit-pipe-method:focus-visible .knit-pipe-method-label{text-decoration:underline}
.knit-pipe-method[aria-expanded="true"]{color:var(--dsw-alias-label-primary,#e8eaed)}
/* v0.25：Git 变更关联那一格。**与检索方式复用同一份视觉语言**（同 --knit-chip-bg、同圆角 6px、
   同内边距 1px 6px、同字号 11px / 行高 15px），但它是个**二态开关**：没有菜单、没有箭头。
   开态只把字色提到主文本色（属性选择器 aria-pressed=true）—— **不换底色、不用品牌色**，
   与检索方式「展开态」那条规则同一个手法：同一行里同类物，靠字重/字色分层，不靠颜色。
   ⚠️ 尾随的 › 在检索方式那边才画；这一格没有箭头，所以下划线直接给文字层即可。 */
.knit-pipe-changes{display:inline-flex;align-items:center;flex:none;white-space:nowrap;cursor:pointer;
  padding:1px 6px;border:0;outline:none;border-radius:6px;
  background:var(--knit-chip-bg,rgba(255,255,255,.12));
  font:inherit;font-size:11px;line-height:15px;
  color:var(--dsw-alias-label-secondary,#61666b);transition:color .14s ease}
.knit-pipe-changes:hover,.knit-pipe-changes:focus-visible{color:var(--dsw-alias-label-primary,#e8eaed)}
.knit-pipe-changes:hover .knit-pipe-changes-label,
.knit-pipe-changes:focus-visible .knit-pipe-changes-label{text-decoration:underline}
.knit-pipe-changes[aria-pressed="true"]{color:var(--dsw-alias-label-primary,#e8eaed)}
@media (prefers-reduced-motion:reduce){.knit-pipe-changes{transition:none}}
/* 箭头：与「最近读取」行最右端那个 › 同一套视觉语言（同字形），基础态旋转 90° 变成「朝下」。
   ⚠️ 展开态用 **横向翻转 scaleX(-1)**，不是对调角度、也不是 scaleY(-1)（2026-10-13 用户裁决：
      「修改成横向翻转……默认箭头向下，交互展开箭头向上」）。
      · 对调成 rotate(-90deg) ⇒ 箭头在 0.14s 里**原地转 180°**（像风车），读起来是「在转」；
      · **scaleY(-1) 是空操作** —— › 这个字形本来就沿水平轴对称，上下镜像后一模一样，
        矩阵算出来仍是朝下（曾经写错过一次，被用户当场抓到，现在有几何守卫盯着）；
      · scaleX(-1) 才是「同一个字形左右翻个面」：先把 › 镜像成 ‹，再转 90° ⇒ 朝上。
   ⇒ 关=朝下、开=朝上，过程是横向翻转。 */
.knit-pipe-method-go{display:inline-block;margin-left:3px;font-size:12px;line-height:1;
  transform:rotate(90deg);transition:transform .14s ease}
.knit-pipe-method[aria-expanded="true"] .knit-pipe-method-go{transform:rotate(90deg) scaleX(-1)}
@media (prefers-reduced-motion:reduce){.knit-pipe-method-go{transition:none}}
.knit-retmenu{position:absolute;left:0;top:22px;z-index:20;width:272px;padding:6px;text-align:left;
  background:var(--dsw-alias-bg-base,#151517);border:0.5px solid var(--dsw-alias-border-l3,rgba(255,255,255,.12));
  border-radius:10px;box-shadow:0 10px 26px rgba(0,0,0,.28)}
/* 菜单里那两个可选项：**沿用命中段那套**（2026-10-12 用户裁决「对，就这样修改」）——
   圆角 6px（命中段同值）、选中态底 = --knit-chip-bg（命中段那档）；
   菜单**面板本身**仍是浮层（bg-base + l3 描边 + 阴影 + 10px 圆角）：浮层必须读起来像浮层，
   把它也压成灰胶囊就没有层级了。 */
.knit-retmenu-item{display:block;width:100%;text-align:left;cursor:pointer;padding:8px 9px;border-radius:6px;
  border:none;background:transparent;color:var(--dsw-alias-label-primary,#e8eaed)}
.knit-retmenu-item:hover{background:var(--knit-hover-bg,rgba(255,255,255,.03))}
.knit-retmenu-item.active{background:var(--knit-chip-bg,rgba(255,255,255,.12))}
.knit-retmenu-item strong{display:block;font-size:12.5px;font-weight:600}
.knit-retmenu-item span{display:block;margin-top:3px;font-size:11px;line-height:1.5;
  color:var(--dsw-alias-label-secondary,#9aa0a6)}
.knit-retmenu-note{margin-top:4px;padding:7px 9px 4px;font-size:11px;line-height:1.5;
  border-top:0.5px solid var(--dsw-alias-border-l3,rgba(255,255,255,.12));
  color:var(--dsw-alias-label-secondary,#9aa0a6)}
.knit-retmenu-cfg{display:block;width:100%;text-align:left;cursor:pointer;padding:7px 9px;border:none;
  border-radius:6px;background:transparent;color:var(--dsw-alias-label-primary,#e8eaed);font-size:12px}
.knit-retmenu-cfg:hover{background:var(--knit-hover-bg,rgba(255,255,255,.03))}
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
  font-size:10px;line-height:1.3;color:var(--dsw-alias-label-tertiary,#81858c)}
/* Design §14：层名走「大写 + 字距」这套页签式排版，中文 hint 退到 muted 那一档。
   ⚠️ uppercase 对中文是空操作，所以中文形态仍然是「主要上下文」——
   不为了对齐英文形态去改词典：界面语言该由 i18n 决定，不该由 CSS 决定。
   Design §14 里那个「可选的 5~6px 灰点」**不做** —— Primary 已经有一颗黑点了，
   再加一颗同形状的点会让「层标记」和「主上下文标记」看起来是一回事。 */
.knit-tiername{font-weight:600;font-size:12px;letter-spacing:.01em;
  text-transform:uppercase;color:var(--dsw-alias-label-secondary,#61666b)}
.knit-tierhint{font-weight:400}
/* 「为什么在这里」＋「命中段」：**同一条 metadata 行**（2026-10-07 用户裁决）。
   两条都是「这一行为什么在这里」，分两行会让每一行都变高；用户的原话是
   「这样就会减少文档列表的高度」。命中段在左（本版最该被看见的那一格），
   中间一条 1px 中性竖线分隔 —— 不是虚线、不是分隔带、不加底色。
   ⚠️ 仍然**独占一行**，不并到标题行右侧：那里的省略号会把它截成
   「标题命中当前…」，恰好把要传达的东西吃掉（Design §11 的字段顺序不变）。
   2026-10-08 用户规格：这一行的**右端**现在是操作组（固定 / 排除 / 来源词），
   所以行本身是「左证据 + 右动作」的两段式 —— 左边 flex:1 可截断，右边 flex:none。
   行高不变、也不因为动作出现或隐藏而跳动（隐藏用的是 visibility，位置一直留着）。 */
.knit-subrow{display:flex;flex-wrap:nowrap;align-items:baseline;gap:8px;min-width:0;padding-top:2px}
.knit-subrow-main{flex:1 1 auto;display:flex;flex-wrap:nowrap;align-items:baseline;gap:8px;min-width:0}
.knit-subrow-sep{flex:none;align-self:stretch;width:1px;margin:2px 0;
  background:var(--dsw-alias-border-l3,rgba(255,255,255,.12))}
/* 11px 而不是 10px，因为它承担的是**信息**（可核验的理由），不是装饰标注。 */
.knit-why{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
  font-size:11px;line-height:17px;color:var(--dsw-alias-label-tertiary,#81858c)}
/* v0.20 命中段（需求 §12）：metadata 行里**靠左**那一格，只有行号区间。
   它是个真 button（可 Tab、可回车、可读屏），但**不像按钮**：没有图标、没有描边
   （border:0 + outline:none，选中 / 聚焦都不画环）、没有品牌色 —— §26「只展示可验证信息」，
   行号是事实，不是分数，也不是 AI 判断。
   2026-10-07 用户裁决：**要一个灰底**（"叫它寻一个背景就行了，寻灰背景就行了，不需要在
   背景填充外面再加一个白色的描边"）—— 底用 --knit-chip-bg（比行选中那档深一点，
   免得它在被选中的行里消失），内边距 1px 6px。
   2026-10-07 同一天第二轮：圆角 **6px**（原话「圆角能不能改成一个胶囊……只是说圆角再增加 2 倍」，
   3px 那档「有点硬」；行高 15px + 上下各 1px ⇒ 盒子高 17px，6px 已接近半高，就是胶囊）。
   **描边仍然一根都没有**。
   键盘焦点靠与 hover 同款的下划线提示。 */
.knit-hit{display:block;flex:none;text-align:left;margin:0;padding:1px 6px;border:0;outline:none;
  border-radius:6px;background:var(--knit-chip-bg,rgba(255,255,255,.12));font:inherit;
  font-size:11px;line-height:15px;cursor:pointer;color:var(--dsw-alias-label-secondary,#61666b)}
.knit-hit:hover,.knit-hit:focus-visible{color:var(--dsw-alias-label-primary,#0f1115);text-decoration:underline}
/* ── v0.21 来源词 / 行级证据 / 固定与排除（需求 §6、§8）────────────
   这一层整体是**弱化层**：来源、动作、证据都排在标题与摘要之下，字号 10–11px、
   都是 caption / tertiary 灰。两条纪律：
   ① **来源不是强弱**：检索 / 关系 / 用户固定 三个词**共用一种灰**，靠字区分，
      不做彩色徽标、不做分数（需求 §8：颜色只用来区分来源，不用来表达强弱）；
   ② 证据列表是「点开才有」的第二层，默认一个节点都不渲染（默认视图一个字节都不变）。
   2026-10-08 用户规格（v0.21.x 布局改造）：来源词从标题行搬进证据行右端的操作组，
   成为那一组里的**第三个文字按钮**（固定 → 排除 → 来源词）—— 于是它不能再是
   一枚有底色的胶囊（§3.4：默认根本不显示，出现时就是克制的文字操作）。
   ⚠️ 它仍然是「这一条怎么进来的」这条**事实**：没有图标、没有描边、同一种灰；
      有关系可展开时才是 button（多一个 hover / 焦点的下划线反馈），
      没有证据可展开时就是一个 span：**不装成能点的样子**。 */
.knit-prov{flex:none;margin:0;padding:0 5px;border:0;outline:none;background:transparent;
  border-radius:5px;font:inherit;font-size:11px;line-height:15px;
  color:var(--dsw-alias-label-caption,#80868b)}
button.knit-prov{cursor:pointer}
button.knit-prov:hover,button.knit-prov:focus-visible{background:var(--knit-hover-bg,rgba(255,255,255,.03));
  color:var(--dsw-alias-label-primary,#0f1115)}
/* 证据行右端的操作组：固定 → 排除 → 来源词。
   **默认整组不显示** —— 悬停到这一行、键盘光标在这一行（.cursor 类）、这一行处于
   选中态（.active 类）、或焦点进入这一行（:focus-within）才出现（2026-10-08 用户规格 §3.3）。
   ⚠️ 用 visibility:hidden 而**不是** opacity:0：隐藏时必须同时退出焦点序与命中测试，
      否则「看不见却 Tab 得到 / 点得到」就是骗人的（§3.3 第 4 条）。
   ⚠️ 没有 opacity / visibility 的过渡动画（§3.3 第 6 条：不加悬停动画、发光、装饰）。
   ⚠️ flex:none + visibility ⇒ 出现与隐藏都**不改变行高、不推挤左侧证据**。 */
.knit-rowacts{flex:none;display:flex;align-items:center;gap:2px;visibility:hidden}
.knit-doc:hover .knit-rowacts,.knit-doc.active .knit-rowacts,.knit-doc.cursor .knit-rowacts,
.knit-doc:focus-within .knit-rowacts{visibility:visible}
.knit-act{flex:none;margin:0;padding:0 5px;border:0;outline:none;background:transparent;
  border-radius:5px;font:inherit;font-size:11px;line-height:15px;cursor:pointer;
  color:var(--dsw-alias-label-caption,#80868b)}
.knit-act:hover,.knit-act:focus-visible{background:var(--knit-hover-bg,rgba(255,255,255,.03));
  color:var(--dsw-alias-label-primary,#0f1115)}
/* 2026-10-09 用户反馈（真机体验过第一版之后）：① 「固定 / 排除 / 检索 这个字号有点太小了，
   可以跟命中段一样大小」⇒ 10px → **11px / 15px**，与命中段（.knit-hit）同档；
   ② 「悬停的时候那个背景可以再左右各加 4 个像素，热区有点小、有点点不到」⇒
   padding 5px → **9px**，同时用 **-4px 的负外边距**把那 4px 从布局宽度里收回来：
   于是**行宽与三个词之间的视觉间距一点没变**，只有悬停底色与可点区域向左右各长 4px。
   ⚠️ 只作用于证据行右端这一组（恢复那个单独的 .knit-act 不动，它旁边没有兄弟会被挤）。 */
.knit-rowacts .knit-act,.knit-rowacts .knit-prov{padding:0 9px;margin:0 -4px}
/* 「为什么」在**有关系可看**时是一个按钮（点开就是那一行的证据），但看起来必须仍是
   一行灰字：没有图标、没有描边、没有底色，只有 hover 时加下划线 —— 与 .knit-hit
   同一套语言（那是事实，不是操作）。
   ⚠️ 文本**一个字节都没变**（test/client.test.mjs 按 knit-why 取这一行的原文）。 */
button.knit-why{margin:0;padding:0;border:0;outline:none;background:transparent;font:inherit;
  font-size:11px;line-height:17px;text-align:left;cursor:pointer;
  color:var(--dsw-alias-label-tertiary,#81858c)}
button.knit-why:hover,button.knit-why:focus-visible{color:var(--dsw-alias-label-secondary,#61666b);
  text-decoration:underline}
/* 行级证据（需求 §6.2）：默认不渲染，点开才有。每条一行，四个字段都不省略：
   类型 · 方向 · 谁 · 第几行。.knit-relline 用等宽体承接行号（对齐扫读）。 */
.knit-rellist{margin-top:4px;padding:5px 0 0;display:flex;flex-direction:column;gap:2px;
  border-top:.5px solid var(--dsw-alias-border-l3,rgba(255,255,255,.12))}
.knit-relrow{display:flex;align-items:baseline;gap:6px;min-width:0;font-size:11px;line-height:16px;
  color:var(--dsw-alias-label-tertiary,#81858c)}
.knit-reltag{flex:none;font-size:10px;padding:0 4px;border-radius:4px;
  background:var(--knit-active-bg,rgba(38,49,72,.061));color:var(--dsw-alias-label-caption,#80868b)}
.knit-relwho{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.knit-relline{flex:none;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:10.5px}
.knit-relopen{flex:none;margin:0;padding:0 4px;border:0;outline:none;background:transparent;
  border-radius:4px;font:inherit;font-size:10px;line-height:15px;cursor:pointer;
  color:var(--dsw-alias-label-caption,#80868b)}
.knit-relopen:hover,.knit-relopen:focus-visible{color:var(--dsw-alias-label-primary,#0f1115);
  text-decoration:underline}
.knit-relmore{font-size:10px;line-height:16px;color:var(--dsw-alias-label-caption,#80868b)}
/* 被用户排除的那一行：**单行弱化说明**，空的时候不出现、也不占位（需求 §6.3）。
   它说的是「这一批少了什么」，所以用中性描边而不是警告色 —— 这不是错误，是用户的选择。 */
.knit-excl{flex:none;display:flex;align-items:baseline;gap:6px;margin:0 12px 6px;padding:5px 8px;
  border-radius:6px;font-size:11px;line-height:16px;
  background:var(--knit-hover-bg,rgba(255,255,255,.03));color:var(--dsw-alias-label-caption,#80868b)}
.knit-excl-what{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
/* 检索状态摘要（需求 §6.3；2026-10-09 用户规格重排）：**单行、三组、竖线分组** ——
   收集 79 · 排除 0 · 候选 79  ｜  BM25 词法检索 · 关系 24 条 · 固定 0  ｜  入包 9。
   三组就是阅读顺序：工作区候选 → 检索与调整 → 最终结果。
   ⚠️ 箭头（↓ / →）和「检索 / 排序（BM25 词法）」「关系投影」「固定覆盖」这些内部说法
      **已整体删除** —— 它们把一条**已经完成**的管线画成了流程图（用户原话：箭头「增加理解成本」）。
   ⚠️ 它仍然只是一串计数：没有图标、没有胶囊、没有卡片、没有色块、没有装饰性边框，
      只有灰字 + 中点 + 一根细竖线。
   ⚠️ 中点与竖线都是**文本节点**（不是伪元素、不是边框）：它们跟同一行流排版，
      基线天然对齐，窄面板换行时也不会留下一条贴边的孤线。
   ⚠️ 这段是模板字符串：注释里**不许出现反引号**（AGENTS.md §6.1，踩过三回了）。 */
.knit-pipe{flex:none;display:flex;align-items:baseline;flex-wrap:wrap;gap:4px;
  margin:0 12px 8px;font-size:10.5px;line-height:15px;
  color:var(--dsw-alias-label-caption,#80868b)}
.knit-pipecell{flex:none;white-space:nowrap}
.knit-pipecell.strong{color:var(--dsw-alias-label-secondary,#61666b);font-weight:500}
.knit-pipedot,.knit-pipesep{flex:none;color:var(--dsw-alias-label-caption,#80868b)}
.knit-pipesep{margin:0 3px}
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
  background:var(--dsw-alias-label-primary,#0f1115)}
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
/* v0.25 媒体收藏：★ 是**状态标记**，所以吃品牌色（与聚焦圈 / 分区「查看全部」同一档）；
   只在**名字行里**占一个字形的位置，不上缩略图、不加底色、不做 hover —— 网格不许长出第二套 chrome。 */
.knit-fav{font-size:10px;margin-right:3px;color:var(--knit-accent)}
/* v0.25：对话里生成的图 —— 标记用**文字**（承担信息：还没存进项目、存进去就消失）。
   字色取次级灰：它不是层级，是来源说明，不该抢过 ★。 */
.knit-conv{font-size:10px;margin-right:3px;color:var(--dsw-alias-label-caption,#80868b)}
/* v0.25 媒体档「悬停看大图」—— 与入口浮窗同一套外框（圆角 / 阴影 / 边框 / 层级）。
   ⚠️ pointer-events:none 是必须的：它只是看一眼，绝不许挡住卡片的点击。
   尺寸由 JS 下发（上限 800，按可用空间收缩），这里只负责「图在盒子里等比铺满」。 */
.knit-shot{position:fixed;z-index:60;display:flex;align-items:center;justify-content:center;
  padding:6px;border-radius:12px;pointer-events:auto;cursor:pointer;
  background:var(--dsw-alias-bg-layer-2,#2c2c2e);
  border:.5px solid var(--dsw-alias-border-l4,rgba(255,255,255,.12));
  box-shadow:0 12px 32px rgba(0,0,0,.32)}
.knit-shot img{display:block;max-width:100%;max-height:100%;border-radius:8px;object-fit:contain}
.knit-shot-hint{position:absolute;left:50%;bottom:12px;transform:translateX(-50%);
  padding:4px 12px;border-radius:999px;font-size:12px;line-height:1.4;white-space:nowrap;
  color:var(--dsw-alias-label-primary-inverted);
  background:var(--dsw-alias-brand-primary-new-colorprimary-new-color)}
.knit-shot:hover .knit-shot-hint{opacity:1}
/* v0.25 媒体档「双击全屏」：整窗遮罩 + 毛玻璃。层级在悬停浮窗（60）与菜单之上。
   左侧留 96px 给缩略图带（它绝对定位在遮罩里）；图片按 contain 铺满剩下的区域。 */
.knit-lightbox{position:fixed;inset:0;z-index:2147483000;display:flex;align-items:stretch;justify-content:center;
  padding:32px 32px 32px 96px;outline:none;cursor:zoom-out;overflow:hidden;box-sizing:border-box;
  /* ⚠️ 遮罩的 α 是**人眼定的**（与 box-shadow 同一性质，推不出来）；两套值**必须不同**，
     否则「随深色模式变化」就是假话（有守卫）。
     ⚠️ 这两个变量故意**挂在查看器自己身上** —— 它被 portal 到 document.body 之后
     不在 .knit-root 里了，读不到那层的变量（第一版就是这么静默变成透明遮罩的）。 */
  --knit-scrim:rgba(255,255,255,.62);
  /* 评论栏底：面板画布能吃到 .knit-root 的 --knit-active-bg；整屏 portal 里读不到，
     就回落到官方交互令牌。浅色下两者都是可见的灰，不会和纯白画布糊在一起。 */
  --knit-comment-surface:var(--knit-active-bg,var(--dsw-alias-interactive-bg-active));
  background:var(--knit-scrim);backdrop-filter:blur(22px) saturate(1.1);
  -webkit-backdrop-filter:blur(22px) saturate(1.1)}
body[data-ds-dark-theme] .knit-lightbox{--knit-scrim:rgba(18,18,20,.72)}
.knit-lightbox-stage{flex:1 1 auto;min-width:0;min-height:0;height:100%;display:flex;align-items:center;
  justify-content:center;cursor:default;position:relative}
.knit-lightbox-img{max-width:100%;max-height:100%;width:auto;height:auto;object-fit:contain;border-radius:10px;cursor:default;
  box-shadow:0 24px 64px rgba(0,0,0,.36);background:var(--dsw-alias-bg-base,#fff)}
/* v0.28：查看器右键菜单（保存到本地）。浮在遮罩之上，坐标用 clientX/Y。 */
.knit-lightbox-menu{position:fixed;z-index:2147483001;min-width:150px;padding:4px;border-radius:10px;
  background:var(--dsw-alias-bg-base,#fff);border:.5px solid var(--dsw-alias-border-l3,transparent);
  box-shadow:0 10px 28px rgba(0,0,0,.22);cursor:default}
.knit-lightbox-menu-item{display:block;width:100%;padding:7px 10px;border:0;border-radius:6px;
  background:transparent;color:var(--dsw-alias-label-primary,#0f1115);font-family:inherit;font-size:12px;
  line-height:1.4;text-align:left;cursor:pointer}
.knit-lightbox-menu-item:hover{background:var(--knit-hover-bg,var(--dsw-alias-interactive-bg-hover))}
/* v0.28：整屏的上一张 / 下一张。滚轮翻页已删除（一次滑动会连翻好几张），
   改成**显式点按**。左列缩略图带占 96px，所以 prev 让到它右边。 */
.knit-lightbox-nav{position:absolute;top:50%;transform:translateY(-50%);z-index:2;
  width:40px;height:40px;padding:0;border:0;border-radius:50%;display:flex;align-items:center;
  justify-content:center;font-family:inherit;font-size:22px;line-height:1;cursor:pointer;
  color:var(--dsw-alias-label-primary,#0f1115);background:var(--knit-hover-bg,transparent);opacity:.72}
.knit-lightbox-nav:hover{opacity:1;background:var(--knit-active-bg,var(--dsw-alias-interactive-bg-active))}
.knit-lightbox-nav.prev{left:104px}
.knit-lightbox-nav.next{right:22px}
.knit-lightbox-tools{position:absolute;top:18px;right:62px;z-index:2;display:flex;align-items:center;gap:6px}
.knit-lightbox-close{position:absolute;top:18px;right:18px;z-index:2;width:34px;height:34px;padding:0;
  display:flex;align-items:center;justify-content:center;border:0;border-radius:10px;
  cursor:pointer;font-family:inherit;font-size:15px;line-height:1;
  color:var(--dsw-alias-label-primary,#0f1115);background:transparent;opacity:.7}
.knit-lightbox-close:hover{opacity:1;background:var(--knit-hover-bg,transparent)}
.knit-lightbox-rail{position:absolute;left:10px;top:50%;z-index:2;transform:translateY(-50%);display:flex;
  flex-direction:column;gap:6px;max-height:88vh;overflow-y:auto;padding:4px;cursor:default}
.knit-lightbox-thumb{flex:none;width:64px;height:64px;padding:0;border:0;border-radius:8px;overflow:hidden;
  cursor:pointer;background:transparent;opacity:.68;transition:opacity .16s ease}
.knit-lightbox-thumb img{width:100%;height:100%;object-fit:cover;display:block}
.knit-lightbox-thumb:hover{opacity:1}
.knit-lightbox-thumb.active{opacity:1;box-shadow:0 0 0 2px var(--knit-accent,var(--dsw-alias-brand-primary-new-colorprimary-new-color))}
@media (prefers-reduced-motion: reduce){.knit-lightbox-thumb{transition:none}}

/* ── v0.26 图内评论 ───────────────────────────────────────────
   pin = 圆点 + 序号（用户 2026-11 选的最轻形态，不做引线标注块）。
   ⚠️ 颜色一律吃 DSH 语义 token（查看器被 portal 到 body，读不到 .knit-root 那层变量）；
   **这里一个硬编码色值都不许出现**，源码守卫 test/comments.test.mjs 会逐条扫本段。
   ⚠️ pin 层 pointer-events:none，只有 pin 与编辑框恢复 auto ——
   否则整块覆盖层会吃掉「点图片以外关闭」与 stage 的落点点击。 */
.knit-lightbox-pins{position:absolute;inset:0;pointer-events:none;z-index:1}
.knit-lightbox-pin{position:absolute;transform:translate(-50%,-50%);width:22px;height:22px;padding:0;
  display:flex;align-items:center;justify-content:center;border:0;border-radius:50%;
  cursor:pointer;pointer-events:auto;font-family:inherit;font-size:11px;font-weight:600;line-height:1;
  color:var(--dsw-alias-label-primary-inverted);
  background:var(--dsw-alias-brand-primary-new-colorprimary-new-color);
  box-shadow:0 0 0 2px var(--dsw-alias-bg-base)}
.knit-lightbox-pin:hover{opacity:.86}
.knit-lightbox-pin.draft{opacity:.55;pointer-events:none}
.knit-lightbox-pin:focus-visible{outline:2px solid var(--dsw-alias-border-l4);outline-offset:2px}
.knit-lightbox-editor{position:absolute;pointer-events:auto;box-sizing:border-box;
  display:flex;flex-direction:column;gap:7px;width:280px;max-width:calc(100vw - 24px);padding:9px;
  border-radius:10px;background:var(--dsw-alias-bg-layer-2);
  border:.5px solid var(--dsw-alias-border-l3);color:var(--dsw-alias-label-primary)}
.knit-lightbox-editor-head{display:flex;align-items:center;justify-content:space-between;gap:8px}
.knit-lightbox-editor-title{font-size:12px;font-weight:600;color:var(--dsw-alias-label-primary)}
.knit-lightbox-editor-pos{font-size:11px;color:var(--dsw-alias-label-caption);white-space:nowrap}
.knit-lightbox-editor-input{width:100%;box-sizing:border-box;padding:6px 8px;border-radius:8px;
  border:.5px solid var(--dsw-alias-border-l4);background:var(--dsw-alias-bg-base);
  color:var(--dsw-alias-label-primary);font-family:inherit;font-size:12px;line-height:1.5;outline:none}
.knit-lightbox-editor-input:focus{border-color:var(--dsw-alias-brand-primary-new-colorprimary-new-color)}
.knit-lightbox-editor-foot{display:flex;align-items:center;justify-content:flex-end;gap:6px}
.knit-lightbox-editor-count{margin-right:auto;font-size:11px;color:var(--dsw-alias-label-caption)}
.knit-lightbox-editor-hint{font-size:11px;color:var(--dsw-alias-label-caption);line-height:1.4}
.knit-lightbox-comments{position:fixed;left:50%;bottom:18px;z-index:2;transform:translateX(-50%);box-sizing:border-box;
  width:min(560px,calc(100vw - 160px));display:flex;align-items:flex-end;gap:12px;padding:10px 12px;
  min-height:54px;border-radius:12px;background:var(--knit-comment-surface);
  border:.5px solid var(--dsw-alias-border-l4);
  box-shadow:0 10px 28px var(--dsw-alias-interactive-bg-hover);
  color:var(--dsw-alias-label-primary);cursor:default}
.knit-lightbox-comments-empty{display:flex;flex-direction:column;gap:2px;padding:2px 0}
.knit-lightbox-comments-emptyTitle{font-size:12px;color:var(--dsw-alias-label-secondary)}
.knit-lightbox-comments-emptyHint{font-size:11px;color:var(--dsw-alias-label-caption)}
.knit-lightbox-comments-send{height:30px;padding:0 16px;font-weight:600;
  color:var(--dsw-alias-label-primary-inverted);
  background:var(--dsw-alias-brand-primary-new-colorprimary-new-color);
  border-color:transparent}
.knit-lightbox-comments-send:disabled{color:var(--dsw-alias-label-caption);
  background:var(--dsw-alias-interactive-bg-active);border-color:var(--dsw-alias-border-l4)}
.knit-lightbox-nav{width:30px;height:30px;padding:0;font-size:16px;line-height:1}
.knit-lightbox-dockcount{margin-left:auto;font-size:11px;color:var(--dsw-alias-label-caption);white-space:nowrap}
.knit-lightbox-comments-list{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;gap:3px;
  max-height:30vh;overflow-y:auto}
.knit-lightbox-comment-row{display:flex;align-items:center;gap:8px;min-width:0}
.knit-lightbox-comment-n{flex:none;font-size:11px;font-weight:600;
  color:var(--dsw-alias-brand-primary-new-colorprimary-new-color)}
.knit-lightbox-comment-text{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;
  white-space:nowrap;font-size:12px;color:var(--dsw-alias-label-secondary);cursor:pointer;
  background:transparent;border:0;padding:0;text-align:left;font-family:inherit}
.knit-lightbox-comment-text:hover{color:var(--dsw-alias-label-primary)}
.knit-lightbox-comment-del{flex:none;width:20px;height:20px;padding:0;border:0;border-radius:6px;
  background:transparent;color:var(--dsw-alias-label-caption);cursor:pointer;font-family:inherit;
  font-size:11px;line-height:1}
.knit-lightbox-comment-del:hover{background:var(--dsw-alias-interactive-bg-hover);
  color:var(--dsw-alias-label-primary)}
.knit-lightbox-comments-right{flex:none;display:flex;flex-direction:column;align-items:flex-end;gap:4px}
.knit-lightbox-comments-status{font-size:11px;color:var(--dsw-alias-label-caption);text-align:right}
.knit-lightbox-comments-empty{font-size:12px;color:var(--dsw-alias-label-caption)}
/* v0.26 返工：面板内画布（lightboxDock）—— 与整屏查看器共用同一份 DOM，
   只把「定位 / 底色 / 左右留白 / 评论栏位置」换掉，评论逻辑一行不分叉。
   ⚠️ 会话永远不被盖住：它只是面板里的一个视图，且面板本身就在会话旁边。 */
.knit-canvas{flex:1 1 auto;min-height:0;position:relative;display:flex;
  margin:6px 8px 8px;border-radius:12px;overflow:hidden;
  background:var(--dsw-alias-bg-base);border:.5px solid var(--dsw-alias-border-l3)}
.knit-lightbox.docked{position:relative;inset:auto;z-index:auto;width:100%;height:100%;
  padding:8px;display:flex;align-items:stretch;justify-content:center;cursor:default;
  background:transparent;backdrop-filter:none;-webkit-backdrop-filter:none;border-radius:0}
.knit-lightbox.docked .knit-lightbox-tools{top:10px;right:10px;z-index:3}
.knit-lightbox.docked .knit-lightbox-comments{position:absolute;left:10px;right:10px;bottom:10px;
  width:auto;transform:none;max-height:44%}
.knit-lightbox-dockhead{position:absolute;left:12px;top:10px;right:280px;z-index:2;
  display:flex;align-items:baseline;gap:8px;min-width:0;pointer-events:none}
.knit-lightbox-dockname{font-size:12px;font-weight:600;color:var(--dsw-alias-label-primary);
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.knit-lightbox-dockctx{flex:none;font-size:11px;color:var(--dsw-alias-label-caption);
  max-width:45%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;direction:rtl;text-align:left}

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
.knit-change-badge{margin-left:6px;flex:none;font-size:10px;line-height:16px;padding:0 5px;
  border-radius:4px;background:var(--knit-chip-bg);color:var(--dsw-alias-label-secondary)}
.knit-change-count{display:inline-flex;gap:4px;flex:none;margin-left:6px;font-size:11px;
  font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-caption)}
.knit-change-add{color:var(--dsw-alias-state-success-primary)}
.knit-change-del{color:var(--dsw-alias-label-error)}
.knit-change-binary{color:var(--dsw-alias-label-caption)}
/* v0.26.x 变更档：逐行 diff（只画内容行，不接语法高亮 / 折叠 / 编辑器） */
.knit-diff{display:flex;flex-direction:column;gap:8px;min-height:100%;overflow-x:auto}
.knit-diff-sum{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap;font-size:11px;
  color:var(--dsw-alias-label-caption);position:sticky;top:0;z-index:1;padding:2px 0;
  background:var(--dsw-alias-bg-base)}
.knit-diff-file{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
  color:var(--dsw-alias-label-secondary)}
.knit-diff-add{color:var(--dsw-alias-state-success-primary);font-variant-numeric:tabular-nums}
.knit-diff-del{color:var(--dsw-alias-label-error);font-variant-numeric:tabular-nums}
.knit-diff-note{color:var(--dsw-alias-label-caption)}
.knit-diff-body{display:flex;flex-direction:column;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;
  font-size:11.5px;line-height:1.7;min-width:max-content;border-radius:6px;overflow:hidden}
/* 行底：用**语义色 + 低透明度覆盖层**，不写死 rgba、也不用 color-mix（AGENTS §6.3）。
   绿 / 红只表达 diff 的增删，不表达好坏；正文仍在最上层。 */
.knit-diff-line{position:relative;display:flex;align-items:baseline;gap:8px;white-space:pre;
  padding:0 8px 0 4px;border-left:2px solid transparent}
.knit-diff-line.add,.knit-diff-line.del{background:var(--knit-hover-bg,var(--dsw-alias-interactive-bg-hover))}
.knit-diff-line.add{border-left-color:var(--dsw-alias-state-success-primary)}
.knit-diff-line.del{border-left-color:var(--dsw-alias-label-error)}
.knit-diff-line.add::before,.knit-diff-line.del::before{content:'';position:absolute;inset:0;
  pointer-events:none;z-index:0}
.knit-diff-line.add::before{background:var(--dsw-alias-state-success-primary);opacity:.13}
.knit-diff-line.del::before{background:var(--dsw-alias-label-error);opacity:.11}
.knit-diff-line > *{position:relative;z-index:1}
.knit-diff-line.hunk{color:var(--dsw-alias-label-caption);background:transparent;
  border-left-color:transparent;margin-top:6px;padding-top:2px;padding-bottom:2px}
.knit-diff-old,.knit-diff-new{flex:none;width:40px;text-align:right;color:var(--dsw-alias-label-caption);
  font-variant-numeric:tabular-nums;user-select:none;font-size:11px}
.knit-diff-line.add .knit-diff-old,.knit-diff-line.add .knit-diff-new{color:var(--dsw-alias-state-success-primary)}
.knit-diff-line.del .knit-diff-old,.knit-diff-line.del .knit-diff-new{color:var(--dsw-alias-label-error)}
.knit-diff-sign{flex:none;width:12px;text-align:center;color:var(--dsw-alias-label-secondary);font-weight:600}
.knit-diff-line.add .knit-diff-sign{color:var(--dsw-alias-state-success-primary)}
.knit-diff-line.del .knit-diff-sign{color:var(--dsw-alias-label-error)}
.knit-diff-text{flex:none;min-width:0;color:var(--dsw-alias-label-primary)}
.knit-lang{flex:none;margin-left:6px;font-size:10px;letter-spacing:.04em;
  text-transform:uppercase;color:var(--dsw-alias-label-caption,#80868b)}

/* ── 代码预览（v0.19）────────────────────────────────────
   轻量：行号栏 + 代码正文。**不做语法高亮、不做折叠、不做 minimap**，
   也没引入 Monaco / CodeMirror —— Knit 不是编辑器（需求 §8 §25）。
   横向滚动只发生在正文那一格（overflow-x:auto + min-width:0），
   行号栏 flex:none 留在左边；纵向滚动仍由外面的 .knit-preview-body 负责，
   所以这里**不开第二个纵向滚动容器**（两个纵向滚动条会互相打架）。 */
.knit-codepane{position:relative;display:flex;align-items:stretch;min-height:100%;
  font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11.5px;line-height:1.6}
/* v0.20 命中区域（需求 §13）：一层**中性灰**横带（不是品牌色、不是荧光笔 —— §6.3
   「用灰阶建立层级」）。绝对定位在代码正文之上、pointer-events:none ⇒ 它不参与
   点击、不参与选中、也不改 DOM 结构（正文仍是**一个**文本节点）。 */
/* v0.20 命中段的高亮横带。2026-10-07 用户裁决：**再浅一半**（原话「背景太深了，
   再减少一半的，这样就让它显点，不用这么明显」）—— 用 opacity:.5 而不是换一个更浅的
   写死色：令牌仍然是同一个中性灰（.knit-doc.active 那块），两个主题自动一致，
   而且不引入新的 --knit-* 变量。 */
.knit-code-hit{position:absolute;left:0;right:0;pointer-events:none;z-index:0;opacity:.5;
  background:var(--knit-active-bg,rgba(255,255,255,.085))}
/* v0.20：Markdown 预览跳到命中段之后，那一块**短暂**亮一下（2026-10-07 用户裁决：
   「文档这边也参考代码块一样……要指定到段落」）。与代码那边是同一个意思、同一档灰，
   只是形状不同：代码是一整条横带，Markdown 只能是「命中的那个块」。
   ⚠️ transition 写在**基础选择器**上（不是 .knit-doc-hit 上）：写进 hit 类的话，
   类一移除 transition 也跟着没了 —— 背景会「啪」地消失（Coverage 那层踩过同一个坑）。
   ⚠️ 时长必须 == FLASH_MS（1200），否则会出现「高亮已取消但底色还在慢慢褪」的错帧。
   这一块**不画边框、不位移、不留状态**，也不进任何列表数据。 */
.knit-md-body :is(p,li,h1,h2,h3,h4,h5,h6,pre,blockquote,table,td,th,dt,dd,summary,figcaption){
  transition:background 1.2s ease;border-radius:6px}
.knit-md-body .knit-doc-hit{background:var(--knit-active-bg,rgba(38,49,72,.061))}
/* ⚠️ 文字必须在横带**之上**：横带是定位元素（z-index:0），会盖住静态兄弟节点。
   所以 position:relative;z-index:1 写进下面两条既有规则里 —— **不新增选择器**：
   test/client.test.mjs 用 .knit-code-src\\{([^}]*)\\} 抓这两条规则，多一条同后缀的
   规则会让它抓到错的那条（真的踩过：守卫报的是 z-index 里没有 overflow-x）。 */
.knit-code-gutter{flex:none;white-space:pre;text-align:right;user-select:none;
  position:relative;z-index:1;
  padding:0 8px 0 2px;color:var(--dsw-alias-label-caption,#80868b);
  border-right:1px solid var(--dsw-alias-border-l3,rgba(255,255,255,.08))}
.knit-code-src{flex:1 1 auto;min-width:0;margin:0;padding:0 0 0 10px;
  position:relative;z-index:1;
  white-space:pre;overflow-x:auto;color:var(--dsw-alias-label-primary,#e8eaed)}

/* ── 引用条（v0.12）────────────────────────────────────
   夹在预览头与正文之间的一层。全用中性令牌：它是「信息」，不是「操作」。
   ⚠️ 2026-09-30 用户裁决：它自己那条 border-l2 底边**删掉** —— 与预览头的底边
   一上一下两条细线把这一小块夹成了独立一截，用户的原话是「有点割裂」。
   现在这一层不画任何横线，收紧的 padding 就是它的边界。
   注意 CSS 里不要写反引号 —— 这段样式是模板字符串，一个反引号就会把它截断。 */
/* v0.25 查找条：与 .knit-links 同一层（夹在头与正文之间，**不参与正文滚动**）。
   输入框直接复用工具栏那套（.knit-searchwrap + .knit-filter）—— 同一份视觉语言，不新造控件；
   这里只把它的最大宽度放开（查找条要占满一行）。
   ⚠️ 注意：本段注释里不许出现反引号 —— 整个 CSS 在一个模板串里。 */
.knit-findbar{flex:none;display:flex;align-items:center;gap:6px;padding:4px 12px 6px}
.knit-findbar .knit-searchwrap{flex:1 1 auto;max-width:none}
.knit-findcount{flex:none;font-size:11px;color:var(--dsw-alias-label-caption,#80868b);
  font-variant-numeric:tabular-nums}
.knit-findnav{flex:none;width:22px;height:22px;border-radius:6px;cursor:pointer;
  display:inline-flex;align-items:center;justify-content:center;font-size:12px;
  background:transparent;border:none;color:var(--dsw-alias-label-secondary,#9aa0a6)}
.knit-findnav:hover:not(:disabled){background:var(--knit-hover-bg,rgba(255,255,255,.03));
  color:var(--dsw-alias-label-primary,#e8eaed)}
.knit-findnav:disabled{opacity:.4;cursor:default}
/* 命中的样式 —— **只有底色**。没有 padding、没有 border、颜色继承 —— 一有内边距就会改变行高与折行，
   而代码预览的命中横带是按「滚动高度 ÷ 行数」算行高的，动了就会错位。
   两级灰阶建立层级（普通命中 = hover 那档，当前命中 = 命中段那档），不引入第二种颜色。 */
mark.knit-find{background:var(--knit-hover-bg,rgba(255,255,255,.03));color:inherit;
  padding:0;border:0;border-radius:2px}
mark.knit-find-current{background:var(--knit-chip-bg)}
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
   ⚠️ 排序切换（.knit-seg-btn，Design §18）是**另一个控件**，它保持灰底不变。
   ⚠️ 2026-10-09（v0.21.x 用户规格）：这一组从**自己一行**搬进了 .knit-bar，排在排序组
   右边（2026-10-12 起中间**没有竖线了** —— 靠 .knit-bar 的 gap 分开）。于是这里**不再自带左右 12px 内边距**（那是
   .knit-bar 的事，再写一遍就是双重缩进、两组对不齐）。下划线式选中态**保持不变** ——
   用户这次说「选中项用浅色背景或文字强调即可」，下划线 + 主色文字正是「文字强调」，
   而且它覆盖 2026-09-29 那条「不要灰底」的裁决，不要因为并排就退回灰底按钮。 */
.knit-types{display:flex;gap:14px;flex:none}
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
/* v0.28：小图还没生成时的占位（骨架）。用中性灰阶，不用品牌色 —— 它是等待，不是状态。 */
.knit-thumb-pending{background:var(--knit-active-bg,var(--dsw-alias-interactive-bg-active))}
/* 分批次加载的哨兵：细一行提示，滚到这里就自动追加下一批。 */
.knit-media-more{grid-column:1 / -1;display:flex;align-items:center;justify-content:center;
  min-height:36px;font-size:11px;color:var(--dsw-alias-label-caption,#80868b)}
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

/* ── 预览面板里的图片 / 视频 ───────────────────────── */
.knit-preview-body.is-media{display:flex;align-items:center;justify-content:center;
  padding:12px;background:rgba(0,0,0,.22)}
.knit-preview-media{max-width:100%;max-height:100%;object-fit:contain;border-radius:6px}
video.knit-preview-media{width:100%;background:#000}

/* Knit 图标：走 DSH 的**主文本色令牌**（浅 #0f1115 / 暗 #f9fafb），
   不写死 #000 / #fff —— 令牌自己随主题切，所以**不需要**一条暗色覆盖规则。
   ⚠️ 2026-10-07：暗色那一版原来是写死的 #fff，比 DSH 自己的主文本色还亮
   （官方暗色 #f9fafb），属于「自己创造一套」，已删。 */
.knit-icon{color:var(--dsw-alias-label-primary,#0f1115)}

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

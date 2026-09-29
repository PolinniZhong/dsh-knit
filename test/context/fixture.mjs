/**
 * Knit v0.14 · **Context Pack 离线评测集**
 *
 * 与 `test/eval/fixture.mjs`（v0.6 的检索质量评测）**分开，且不覆盖它**。
 * 两者测的是两件事：
 *
 * | 文件 | 测什么 | 指标 |
 * |---|---|---|
 * | `test/eval/fixture.mjs` | **Retrieval**：哪几篇排得对 | top-1 / MRR / 陷阱 |
 * | 本文件 | **Context Assembly**：排出来之后，哪些该先看、哪些是支撑 | 层次集合关系 |
 *
 * 分开是硬要求（需求 §十九）：Context Pack 加了新的分层层，
 * **不许**因此把 BM25 的评测删掉或改成不可比的指标。
 *
 * ## 语料是这个项目自己
 *
 * 用 Knit 自己的文档树当语料，而不是编一套假文档。理由：验收标准问的是
 * 「Context Pack 是否比原来的相关文档列表提供了新的决策价值」——
 * 拿真实项目问真实问题，答案才有意义。
 *
 * ## 与检索评测集的一条刻意差别
 *
 * 这里的语料**带原文 `text`**，因为引用关系要从原文里解析（`links.js` 只认路径字面量）。
 * 检索评测集只需要小写 haystack，不带原文 —— 它的被测对象是打分器，不需要引用图。
 */

/** 与宿主一致的正文截断长度（`HAYSTACK_CHARS`）。 */
const HAYSTACK_CHARS = 2500

/** 固定的「现在」，让评测完全确定。 */
export const NOW = 1_760_000_000_000

/** 所有文档共用同一个 mtime —— 新鲜度因子成为一个公共常数，测的就纯粹是分层。 */
const SHARED_MTIME = NOW - 60_000

/**
 * 造一条文档记录。
 *
 * haystack 口径严格照抄宿主（`src/host/index.js` 的 `readDoc`）：
 * **先截前 2500 字，再转小写**。
 *
 * @param {string} rel - 工作区相对路径
 * @param {{title: string, summary?: string, body?: string}} doc - 三段文本
 * @returns {object} 文档记录
 */
function make(rel, { title, summary = '', body = '' }) {
  return {
    rel,
    path: rel,
    name: rel.split('/').pop(),
    kind: 'md',
    size: body.length,
    mtimeMs: SHARED_MTIME,
    // 原文首部：引用解析用（`buildLinkGraph` 的 `read`）
    text: body,
    haystack: {
      title: title.toLowerCase(),
      summary: summary.toLowerCase(),
      body: body.slice(0, HAYSTACK_CHARS).toLowerCase(),
    },
  }
}

/**
 * 语料。
 *
 * 刻意保留两条真实污染源：
 *  - `README.md` 满篇项目名 `Knit`（高频词陷阱），而且它是根目录文档、入度最高
 *  - `CHANGELOG.md` 每一条版本都提一遍所有话题词（「什么话题都提一句」的长尾）
 *
 * 它们在**检索**里已经被 BM25 的 IDF 压住了（见 `test/eval/`），
 * 这里要验的是**另一件事**：即使它们排在前面，也不该霸占 Primary。
 */
export const CORPUS = [
  make('README.md', {
    title: 'Knit',
    summary: '把工作区最近的 Markdown 放到对话旁边，按相关性排序。零模型、零网络。',
    body: `
Knit 是 DeepSeek Harness（DSH）的一个插件。Knit 扫描当前会话工作区里的 Markdown 文档，
把 Knit 认为跟当前对话相关的那些放到侧边栏。Knit 不调用模型，Knit 也不联网。
安装 Knit：dsh plugin --profile web add dsh-knit。装完重启 DSH，然后硬刷新浏览器。
Knit 支持文档、图片与视频三类。Knit 的面板可以在文件与媒体之间切换。
本段刻意重复插件名：knit knit knit dsh dsh 插件 插件 文档 文档 工作区 工作区。
设计取舍与算法细节见 \`docs/relevance-algorithm.md\`，接口字段见 \`docs/api-contract.md\`，
裁剪后的检索评测见 \`docs/eval-benchmark.md\`，npm 打包与目录布局见 \`docs/package-layout.md\`。
Knit 的目标用户是每天产出很多 Markdown 的人。Knit 的定位是项目级的文档导航层。
    `,
  }),

  make('CHANGELOG.md', {
    title: 'Knit 变更记录',
    summary: 'Knit 的版本变更记录。',
    body: `
Knit 0.5.2 阅读态与灰底降档。Knit 0.5.1 测试不再依赖目录布局。Knit 0.5.0 图片与视频、类型切换、媒体就地预览。
Knit 0.4.0 第一版：侧边栏列出最近的 Markdown。Knit 修复了路径越界、键盘导航、主题令牌等若干问题。
这次还调整了 Knit 的发布流程、npm 打包内容、市场条目描述与截图。
每一条都提了一句：相关性排序、图片与视频浏览、发布清单、竞品调研、路径越界防护、
键盘导航、主题令牌、接口契约、悬停浮层、缩略图网格、扩展名白名单、错误码。
    `,
  }),

  make('docs/relevance-algorithm.md', {
    title: '相关性排序算法',
    summary: '对话关键词与文档打分：BM25、IDF、长度归一化、长文档与命中段落。',
    body: `
Knit 的相关性排序分三步。第一步从当前会话最近六条消息里抽关键词：英文词按原样取，
中文按 2-gram 与 3-gram 近似，再按出现次数与词长排序、贪心去重叠。
第二步给每篇文档算 BM25 分数：引入语料级 df 统计得到 IDF，用 k1 控制词频饱和、
用 b 控制长度归一化，字段权重仍是标题大于摘要大于正文。
第三步按分数降序，并在分数相同时用 mtime 兜底。

为什么不能只数关键词出现次数：一个在语料里到处都是的词（比如项目名）和罕见词拿到同样的权重，
于是高频词不产生任何区分度；长文档又天然命中次数多，靠堆词就能赢。
所以 Knit 用 BM25 取代关键词计数，并用 IDF 压住高频词。

排序结果之上还有一层上下文分层：把名次分成主要上下文、辅助上下文与相关上下文，
见 \`docs/sdd-context-assembly.md\`。评测在 \`docs/eval-benchmark.md\`。
    `,
  }),

  make('docs/package-layout.md', {
    title: 'npm 打包与目录布局',
    summary: '测试为什么在 clone 之后失败，以及打包要带上哪些文件。',
    body: `
这篇记录一个真实缺陷：测试在作者本机全绿，但别人 clone 公开仓库之后 npm 测试就会失败。
根因是测试把样本工作区写成包根的上一层目录 —— 作者本机那层恰好有样本，
clone 出来的那层是 clone 的父目录，从 npm 装进 node_modules 之后那层就是 node_modules，
两处都没有样本文件。所以目录布局依赖必须彻底去掉，样本一律现场造。

同一类问题还出现在三处硬编码的 knit 前缀上。修法是把样本工作区造在临时目录里，
并让测试在任何目录布局下都能跑。打包内容见 \`package.json\` 的 files 字段。
    `,
  }),

  make('docs/eval-benchmark.md', {
    title: '排序评测集',
    summary: '离线评测：top-1、MRR、高频词陷阱与长文档陷阱、退化场景。',
    body: `
Knit 的排序评测是一套离线、可重复的刻度，用的是固定的假语料与固定的当前时间，
评测的是相关性排序本身，不碰文件系统。指标有三类：top-1 命中率、
MRR（第一个正确结果名次的倒数）、以及陷阱用例是否失守。

陷阱有两类。第一类是高频词陷阱：对话里塞满项目名，旧的关键词计数算法会让满篇项目名的
README 霸榜。第二类是长文档陷阱：什么话题都提一句的归档长文，因为堆词而排到前面。
退化场景也要盯着：如果只有一个文档有分，名次就没有信息量。

评测只测排序与集合关系，不设「分数必须大于多少」这种拍出来的阈值。
    `,
  }),

  make('docs/tool-contract.md', {
    title: 'knit_docs 工具契约',
    summary: 'agent 工具的输入输出：为什么只给 snippet、不给完整正文。',
    body: `
knit_docs 是给模型用的只读工具，返回当前任务最值得先看的项目上下文。
它只返回工作区相对路径，不返回绝对路径、不返回内部 haystack、不返回 score。
命中段落字段叫 snippet：它给的是每篇文档里真正命中的那一小段原文，
让模型据此判断要不要读整篇文档，而不必为了判断先读五篇。

为什么不直接返回完整正文：一次工具调用返回五篇文档的正文会占掉大量上下文，
而模型多数时候只需要确认「这篇讲的确实是我要的那件事」。
snippet 的具体截断规则见 \`docs/sdd-context-assembly.md\`。
    `,
  }),

  make('docs/path-safety.md', {
    title: '路径越界防护',
    summary: '读文件接口的沙箱边界、扩展名白名单与响应头。',
    body: `
Knit 按路径读文件的接口必须守住两条边界。第一条：路径解析之后必须落在会话工作区之内，
任何越界一律拒绝，包括目录穿越、绝对路径逃逸和符号链接绕行。第二条：扩展名白名单，
只放行图片与视频，图片上限十二兆、视频上限二百五十六兆。只允许 GET，只允许回环地址访问。
响应必须带 nosniff 与 default-src none sandbox。Knit 新增任何读文件的路由都要照抄这两条防护。
接口字段与错误码见 \`docs/api-contract.md\`。
    `,
  }),

  make('docs/api-contract.md', {
    title: '接口契约',
    summary: 'recent 与 doc 两个路由的响应字段与错误码。',
    body: `
Knit 列表接口的响应里，文档记录包含 kind、path、rel、name、title、summary、size、mtimeMs 与 score。
score 在没有排序依据时为 null，否则是零到一百的整数。响应顶层还有 mode、topic、keywords、
total 与 truncated。Knit 读正文的接口只接受工作区内的相对路径，越界返回错误码而不是文案。
Knit 的宿主只返回错误码，面向用户的文字全部由客户端词典翻译。
    `,
  }),

  make('docs/sdd-context-assembly.md', {
    title: '上下文装配设计',
    summary: '主要上下文 / 辅助上下文 / 相关上下文的确定性判据，为什么不做 AI 判断。',
    body: `
Context Pack 是一层纯投影：输入是已经算好的相关度名次与命中词，输出是三层上下文。
判据全部是确定性规则，不引入第二个打分系统。主要上下文要求「够锚定」：
命中标题、或命中两个以上不同话题词、或命中比足够高且跨两个字段。
辅助上下文收「命中了但没进主要」的，以及与主要上下文有引用关系的，
还有本身是代码角色的文档。相关上下文是其余有命中的条目。

引用关系不是「更相关」，它只是上下文信号：被主要文档引用的那篇，
往往就是读主文档时下一步该打开的东西。所以引用关系不能把一篇文档抬进主要上下文。
    `,
  }),

  make('docs/media-browse.md', {
    title: '图片与视频浏览',
    summary: '方形缩略图网格、列数、视频首帧当海报。',
    body: `
Knit 的媒体视图把图片与视频铺成方形缩略图网格。列数由 CSS 的 auto-fill 连续数出来，
格子基准边长固定，面板变宽就多一列而不是把格子吹大。视频用 video 标签的 preload metadata
让浏览器自己解出首帧当海报，中间叠播放三角，右下角叠时长角标，零依赖、零转码。
视频走 HTTP Range 流式取字节，不会全量下载。按扩展名放行媒体，不解析画面内容。
    `,
  }),

  // 长文档陷阱：很长、把很多话题词各提一次，但哪一件都没讲清楚。
  make('docs/long-archive.md', {
    title: 'Knit 归档长文',
    summary: 'Knit 的历史归档，涵盖许多话题。',
    body: `
这是 Knit 的一篇很长的归档文档，里面什么都会提一句。相关性排序提到了一次。
BM25 与 IDF 提到了一次。关键词计数提到了一次。图片与视频浏览提到了一次。
发布清单提到了一次。竞品调研提到了一次。路径越界防护提到了一次。
npm 打包提到了一次。目录布局提到了一次。clone 之后测试失败提到了一次。
knit_docs 提到了一次。snippet 提到了一次。命中段落提到了一次。
接口契约提到了一次。错误码提到了一次。扩展名白名单提到了一次。
上下文分层提到了一次。主要上下文提到了一次。辅助上下文提到了一次。
为了制造长度，下面这段重复但不含新话题词：
${'Knit 归档归档归档归档归档归档归档归档归档。'.repeat(60)}
    `,
  }),

  // ── 下面这批是「工作区里正常会有的其他文档」────────────────────────
  // 它们的作用不是提供答案，而是让语料**像真的**：真实项目里 20 篇文档中
  // 只有 1 篇是当前任务的答案，剩下的都是背景。没有它们，「Related 层装不下」
  // 与「层内排序」这两件事都测不到（语料太小时每条都能进某一层）。
  make('docs/user-guide.md', {
    title: '使用说明',
    summary: '安装、打开面板、切换类型、过滤与预览。',
    body: `
装好插件之后重启 DSH，然后硬刷新浏览器。点会话头部的 Knit 图标进入右边栏。
面板顶部是工作区路径，下面是排序方式与过滤框，再下面是类型切换。
单击列表里的一条会就地展开预览，双击会在新标签页里打开。
    `,
  }),

  make('docs/contributing.md', {
    title: '贡献指南',
    summary: '怎么跑测试、怎么改代码、提交信息怎么写。',
    body: `
改代码之前先跑一遍测试，确认基线是绿的。新加的文案必须同时进中英两本词典，
只加一边会被测试拦下。提交信息用约定式前缀。
不要为了更准引入模型调用 —— 纯本地是这个产品对外的承诺。
    `,
  }),

  make('docs/security.md', {
    title: '安全说明',
    summary: '只读、回环地址、响应头与攻击面。',
    body: `
这个插件只有两个读文件的路由，都只接受工作区内的相对路径。
它不发起任何外部网络请求，也不执行工作区里的任何代码。
报告安全问题时请附上可复现的最小步骤，不要贴真实项目内容。
    `,
  }),

  make('docs/architecture.md', {
    title: '架构总览',
    summary: '扫描、排序、引用图、上下文装配四层的分工。',
    body: `
工作区扫描负责找出 Markdown 与媒体，排序引擎负责算名次，引用图负责解析关系，
上下文装配负责把这三样投影成三层上下文。四层之间是单向依赖。
装配层是纯函数，不读盘；扫描结果是它唯一的输入。
    `,
  }),

  make('docs/roadmap.md', {
    title: '路线图',
    summary: '已经做完的、正在做的、明确不做的。',
    body: `
已经做完的：侧边栏列表、相关性排序、媒体浏览、agent 工具、引用关系、上下文分层。
明确不做的：向量检索、长期记忆、文档格式解析、图谱界面。
    `,
  }),

  make('docs/release-checklist.md', {
    title: '发布清单',
    summary: 'npm 发布、版本号、打包内容与市场收录。',
    body: `
发布前先跑测试并确认全绿，再核对版本号、确认没有 private 字段、
确认包名在 package json 与 cordis patch yml 里一致。
发布顺序是硬规则：先推成功，确认本地与远端与 npm 三处对齐，最后才发布。
    `,
  }),

  make('docs/PRD-v0.14-context-pack.md', {
    title: '上下文包需求',
    summary: '把相关文档列表升级成三层任务上下文。',
    body: `
这一版的目标不是继续堆文件浏览功能，而是把「按当前对话给文档排序」
升级成「按当前对话构建当前任务最需要的项目上下文」。
分类必须来自确定性的、本地可解释的规则，不许引入模型。
    `,
  }),

  make('docs/faq.md', {
    title: '常见问题',
    summary: '装不上、看不到、排序不动、预览空白怎么办。',
    body: `
看不到面板时先确认插件真的挂上了。排序不动时确认当前排序方式是「相关」而不是「最新」。
如果对话内容还不足，面板会退回按修改时间排序，这是有意为之。
    `,
  }),

  make('docs/glossary.md', {
    title: '术语表',
    summary: '上下文包、主要上下文、辅助上下文、相关上下文。',
    body: `
上下文包是一层投影，不是新的数据库。主要上下文是当前任务最直接相关的几篇。
辅助上下文用于验证、补充或继续工作。相关上下文与当前任务有关，但不该抢占前两层。
    `,
  }),

  make('docs/decisions.md', {
    title: '技术决策记录',
    summary: '为什么不用向量检索、为什么不做长期记忆。',
    body: `
第一版明确不做向量检索与语义召回，因为那需要模型或外部服务，与「零模型零网络」冲突。
也不做长期记忆：当前对话只是检索的输入，工作区才是上下文的来源。
    `,
  }),

  make('docs/testing.md', {
    title: '测试说明',
    summary: '测试不许依赖目录布局，样本一律现场造。',
    body: `
所有测试都在临时目录里现造样本工作区，不许借仓库里的真实文件。
理由是同一个测试在作者本机、clone 之后、从 npm 装进 node_modules 之后，
三种目录布局下的「上一层」是三件不同的东西。
    `,
  }),

  make('docs/changelog-policy.md', {
    title: '变更记录规范',
    summary: '每一条变更写清做了什么与为什么。',
    body: `
变更记录按版本分节，每条先说做了什么、再说为什么。破坏性变更要单独标出来。
不要把内部实现细节写进去，用户关心的是行为变了没有。
    `,
  }),

  make('notes/scratch.md', {
    title: '随手记',
    summary: '很短的一条。',
    body: '把上下文分层的解释文案再读一遍，确认没有出现「AI 判断」这种说法。',
  }),
]

/**
 * 真实任务型用例。
 *
 * 每个用例声明三层的**期望集合**。断言方式是**包含**（expected ⊆ actual）而不是相等：
 * 多出来的条目不算失败（它可能就是下一条该看的），但**该出现的没出现必须红**。
 *
 * `notPrimary` 专门用来钉死污染源 —— README / CHANGELOG / 长归档
 * 在**检索**里已经排得不错了，但仍不许它们霸占 Primary。
 */
export const CASES = [
  {
    name: '任务 1：BM25 为什么比关键词计数好',
    messages: [
      '这个排序算法为什么这样设计？',
      'BM25 这里我还是觉得有问题，它凭什么比关键词计数好？',
    ],
    expectPrimary: ['docs/relevance-algorithm.md'],
    expectSupporting: ['docs/eval-benchmark.md'],
    // ⚠️ 这里曾经写 `['CHANGELOG.md']`（需求 §十七 案例 1 的示意）。
    // 但实测本语料的 CHANGELOG **一次都没提 BM25 / 关键词计数**（raw=0）——
    // 它之所以能进 Related，靠的是旧实现里「零命中的都塞进 Related」那条兜底，
    // 而那条兜底给出的理由是 `related`（客户端译作「与当前工作区相关」），
    // 恰好是需求 §九 明令禁止的「可能对你有帮助」。
    // 2026-09-29 把 Related 收紧成「有命中、或与 Primary 有引用关系」之后，
    // 本用例的 Related 变成真正命中了话题、但没有落脚点的长尾归档。
    // （真实仓库的 CHANGELOG 里确实写着「排序升级为 BM25」，所以那个示意在真机上照样成立 ——
    //  只是它成立的理由是「CHANGELOG 提到了这个话题」，而不是「工作区里还有这么一篇」。）
    expectRelated: ['docs/long-archive.md'],
    notPrimary: ['README.md', 'CHANGELOG.md', 'docs/long-archive.md'],
  },
  {
    name: '任务 2：npm 包为什么测试在 clone 后失败',
    messages: [
      '这个 npm 包为什么测试在 clone 之后就失败？',
      '目录布局依赖不是已经去掉了吗？',
    ],
    expectPrimary: ['docs/package-layout.md'],
    expectSupporting: ['README.md'],
    expectRelated: [],
    notPrimary: ['README.md', 'CHANGELOG.md', 'docs/long-archive.md'],
  },
  {
    name: '任务 3：knit_docs 为什么要返回 snippet',
    messages: [
      'knit_docs 为什么要返回 snippet？',
      '直接把完整正文给它不行吗？',
    ],
    expectPrimary: ['docs/tool-contract.md'],
    // 设计文档由**引用关系**带进辅助上下文，理由必须是 linkTarget（不是假装命中）
    expectSupporting: ['docs/sdd-context-assembly.md'],
    expectRelated: [],
    notPrimary: ['README.md', 'CHANGELOG.md', 'docs/long-archive.md'],
  },
  {
    name: '任务 4：路径越界怎么防',
    messages: [
      '路径越界怎么防？',
      '目录穿越和绝对路径逃逸都挡住了吗，扩展名白名单呢？',
    ],
    expectPrimary: ['docs/path-safety.md'],
    // 接口契约由引用关系带进来（「被主要文档引用」）
    expectSupporting: ['docs/api-contract.md'],
    // 需求 §十七 案例 4 的示意是「Related: API contract」—— 这里 api-contract 走得更前，
    // 它在 **Supporting**（比 Related 强）。原先 Related 断言的是 README，
    // 但 README 对本话题 raw=0，属于同一条被删掉的零命中兜底（见任务 1 的注释）。
    expectRelated: ['docs/long-archive.md'],
    notPrimary: ['README.md', 'CHANGELOG.md', 'docs/long-archive.md'],
  },
  {
    name: '任务 5：上下文分层凭什么这么分',
    messages: [
      'Context Pack 为什么把这篇放在主要上下文？',
      '辅助上下文和相关上下文的判据是什么？',
    ],
    expectPrimary: ['docs/sdd-context-assembly.md'],
    expectSupporting: [],
    // Related 上限按 PRD §5 收到 5 之后，`notes/scratch.md`（raw=1、名次第 9）落在上限之外 ——
    // 它在本用例里确实是尾部噪音。改断言这两篇：术语表与 PRD 都是「有关但不该先看」的典型。
    // scratch.md 的守卫由任务 12 承担（那条它 raw=41 排第 1，但三层都进不去）。
    expectRelated: ['docs/glossary.md', 'docs/PRD-v0.14-context-pack.md'],
    notPrimary: ['README.md', 'CHANGELOG.md', 'docs/long-archive.md'],
  },
  {
    name: '任务 6：评测指标为什么要看 MRR',
    messages: [
      '排序评测的指标为什么要看 MRR？',
      'top-1 和陷阱用例分别管什么？',
    ],
    expectPrimary: ['docs/eval-benchmark.md'],
    expectSupporting: [],
    expectRelated: [],
    notPrimary: ['README.md', 'CHANGELOG.md', 'docs/long-archive.md'],
  },
  {
    name: '任务 7：媒体网格的列数怎么定',
    messages: [
      '图片和视频的缩略图网格列数是怎么定的？',
      '为什么不用条目数反推格宽？',
    ],
    expectPrimary: ['docs/media-browse.md'],
    expectSupporting: [],
    expectRelated: [],
    notPrimary: ['README.md', 'CHANGELOG.md', 'docs/long-archive.md'],
  },
  {
    name: '任务 8：recent 接口的字段与错误码',
    messages: [
      'recent 接口的响应字段有哪些？',
      '宿主为什么只返回错误码不返回文案？',
    ],
    expectPrimary: ['docs/api-contract.md'],
    expectSupporting: [],
    expectRelated: [],
    notPrimary: ['README.md', 'CHANGELOG.md', 'docs/long-archive.md'],
  },
  {
    name: '任务 9：高频词陷阱到底指什么',
    messages: [
      '高频词陷阱具体是指什么情况？',
      '满篇项目名的 README 会霸榜吗？',
    ],
    expectPrimary: ['docs/eval-benchmark.md'],
    expectSupporting: ['docs/relevance-algorithm.md'],
    expectRelated: [],
    notPrimary: ['README.md', 'docs/long-archive.md'],
  },
  {
    name: '任务 10：长文档靠堆词赢的问题',
    messages: [
      '长文档靠堆词就能排前面，这个问题怎么解决的？',
      '长度归一化具体压的是什么？',
    ],
    // Primary 上限收到 1（PRD §5「Top 1」）后这里只能断言一篇：问的是**长度归一化**，
    // 该先看的显然是讲算法的那篇（raw=9，摘要命中），评测基准（raw=7）退到 Supporting。
    expectPrimary: ['docs/relevance-algorithm.md'],
    expectSupporting: ['docs/eval-benchmark.md'],
    // 原先断言 CHANGELOG —— 它对「长文档 / 长度归一化 / 堆词」这个话题 raw=0，
    // 靠的是已被删除的零命中兜底（见任务 1 的注释）。收紧之后本用例 Related 为空：
    // **「这里没有相关背景」是合法结论**，不该用一篇没提过这个话题的文档去补位。
    expectRelated: [],
    notPrimary: ['README.md', 'CHANGELOG.md', 'docs/long-archive.md'],
  },
  {
    name: '任务 11：这批文档一共多少篇、按什么排序',
    messages: [
      '你现在列出来的是按什么排序的？',
      '是不是把工作区里的文档都列全了？',
    ],
    // ⚠️ **已知不能判**：这两篇的 raw 都是 4，且**标题里都含「排序」**（`排序[TB3]`）。
    // 「按什么排序」问的语义上更像排序算法那篇，但 BM25 只看得见词 —— 它没有任何
    // 依据在这一对上分高下。所以这里断言的是**一对可接受的答案**，不是二者之一。
    // 这条断言就是那条局限的存档：如果哪天它变成唯一解，说明我们偷偷加了语义判断。
    expectPrimaryOneOf: ['docs/relevance-algorithm.md', 'docs/eval-benchmark.md'],
    expectSupporting: [],
    expectRelated: [],
    notPrimary: ['docs/long-archive.md'],
  },
  {
    name: '任务 12：把上下文分层的解释文案再核一遍',
    messages: [
      '把上下文分层的解释文案再读一遍',
      '确认没有出现 AI 判断这种说法',
    ],
    // ⚠️ 这一条是**分层的价值**最直白的证据：语料里名次最高的是 `notes/scratch.md`
    // （它就是那句「把上下文分层的解释文案再读一遍」的出处），但它是张便签，
    // 不是这个任务的答案。装配层不把它当主要上下文 —— 名次第一 ≠ 先看这篇。
    expectPrimary: [],
    expectSupporting: ['docs/sdd-context-assembly.md'],
    expectRelated: ['notes/scratch.md'],
    notPrimary: ['notes/scratch.md', 'README.md', 'CHANGELOG.md'],
  },
]

/**
 * 从语料里造一个引用图 —— **走真实的 `buildLinkGraph`**，不用手写边。
 *
 * 这样测的才是「`links.js` 解析出来的关系真的被装配层用上了」，
 * 而不是「装配层能用上一张我自己造的图」。
 *
 * @param {Function} buildLinkGraph - `links.js` 的实现（注入，理由同其余模块）
 * @param {Array<object>} [corpus] - 语料；默认 `CORPUS`
 * @returns {Promise<object>} 引用图
 */
export async function buildFixtureGraph(buildLinkGraph, corpus = CORPUS) {
  const byRel = new Map(corpus.map((doc) => [doc.rel, doc]))
  return buildLinkGraph('/knit-context-eval', {
    // ⚠️ list 给的是**全量**语料（不是切片）—— 与宿主里 `linkGraphFor` 的做法一致。
    list: async () => ({ docs: corpus.map((doc) => ({ rel: doc.rel, title: doc.title })), truncated: false }),
    // read 用文档记录上现成的原文 —— 与宿主复用 `head` 的做法同源，零额外 I/O。
    read: async (_root, rel) => {
      const entry = byRel.get(rel)
      if (!entry || typeof entry.text !== 'string') return { ok: false }
      return { ok: true, text: entry.text }
    },
  })
}

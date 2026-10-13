/**
 * Knit · **真实工作区评测语料**（v1）—— 在「这个项目自己的文件」上量的那一份。
 *
 * 与 `test/retrieval-corpus.mjs` 的分工（**别把两份混着读**）：
 *
 * | | `test/retrieval-corpus.mjs` | 本文件 |
 * |---|---|---|
 * | 工作区 | `makeWorkspace()` 造的临时目录（19 篇合成文档） | **真实工作区**（`--root`，默认本仓库的上一级） |
 * | 能进 npm 包吗 | 能（`test/` 会发布） | **不能**（`tools/` 不在 `files` 白名单里）—— 它描述的是一台机器上的真实目录 |
 * | 用途 | 每次 `npm test` 重跑的机制回归 | 人工跑的效果量尺（回答「在这份真实语料上，词法找回多少」） |
 * | 嵌入替身 | 有（加权同义词表，为那份合成语料设计） | **不适用** —— 那份替身的词表是给合成语料写的，用在这里只会产出噪声 |
 *
 * ## 标注协议（写死在这里，免得下一轮重新解释）
 *
 * 1. **`expected` 是人写的答案**，不是「跑出来什么就算什么」。
 *    口径：**一个熟悉这个仓库的人，为了回答这句话会去打开的那 1–3 个文件**。
 *    它**不**等于「所有提到这个词的文件」—— 后者会把 CHANGELOG / SDD / 历史规格全卷进来，
 *    召回率就变成了「这个词有多常见」的度量，而不是检索质量的度量。
 * 2. **每条答案都带一条可 grep 的依据**（`evidence`）。`--verify` 会逐条复核：
 *    依据不在那个文件里 ⇒ 当场红。**不许有没依据的标签。**
 * 3. **`distractors` 是「容易误匹配的负样例」**：与查询共享词汇、但**不是**答案。
 *    它们的存在让「无关@5」不再是一个空转的数字 —— 检索器踩中一个，指标就会掉。
 *    本仓库里最强的两个干扰项是 `knit/CHANGELOG.md` 与 `99_暂存文档/` 下的历史快照：
 *    它们几乎包含所有术语，但不回答任何具体问题。
 * 4. **三条诚实红线**（与合成语料同一套）：
 *    · 标签不因为「检索器没找到」而修改；
 *    · 负样例不因为「检索器找到了」而降级成答案；
 *    · 本语料只量**词法基线**与**回退一致性**。**它不能证明语义检索的价值** ——
 *      价值证据要求真 provider（见 `tools/hybrid-retrieval-eval.mjs` 的 H1 与
 *      `docs/evaluations/hybrid-retrieval.md` 的结论）。
 */

export const CORPUS_VERSION = 1

/** 语料版本对应的仓库状态（写语料时实测，供以后对照）。 */
export const CORPUS_BASELINE = {
  measuredAt: '2026-10-13',
  pluginVersion: '0.23.1',
  gitHead: 'b164d8e',
  note: '工作区 = 打包机上的 08_Knit；扫描结果 182 篇（md 96 / 代码 86）',
}

/**
 * 查询样例。
 *
 * `case` 三类（需求 §三要的三类都必须出现）：
 *   · `exact`    —— 精确关键词查询（字面就在目标文件里）
 *   · `synonym`  —— 同义表达 / 概念查询（问法与目标文件里的用词不一致）
 *   · `negative` —— 容易误匹配的负样例（有很强的干扰项，答错会掉分）
 */
export const QUERIES = [
  /* ── 精确关键词 ───────────────────────────────────── */
  {
    id: 'exact-bm25-weights',
    case: 'exact',
    query: 'BM25 字段权重 长度归一化',
    expected: ['knit/src/host/relevance.js'],
    evidence: { 'knit/src/host/relevance.js': 'BM25（字段加权）' },
    distractors: ['knit/README.md', 'knit/CHANGELOG.md', '01_ Knit PRD/Knit-SDD.md'],
    note: '排序引擎本体。README 与 SDD 都把公式抄了一遍 ⇒ 强干扰。',
  },
  {
    id: 'exact-exclude-before',
    case: 'exact',
    query: '排除在检索之前生效',
    expected: ['knit/src/host/control.js'],
    evidence: { 'knit/src/host/control.js': '排除在检索之前' },
    distractors: ['knit/test/control.test.mjs', 'knit/CHANGELOG.md'],
    note: '控制层三条硬约束的第一条，源码里有逐字短语。',
  },
  {
    id: 'exact-passage-lines',
    case: 'exact',
    query: '片段 行号 偏移量 1 起算 两端都含',
    expected: ['knit/src/host/passage.js'],
    evidence: { 'knit/src/host/passage.js': '1 起算、两端都含' },
    distractors: ['knit/test/deep-context.test.mjs', 'knit/src/host/tool.js'],
    note: '行号口径是 v0.20 的对外契约，只在片段层定义。',
  },
  {
    id: 'exact-classify',
    case: 'exact',
    query: '文件分类 唯一事实来源 classifyFile',
    expected: ['knit/src/host/classification.js'],
    evidence: { 'knit/src/host/classification.js': 'classifyFile(name)' },
    distractors: ['knit/test/classification.test.mjs', 'knit/README.md'],
    note: '扩展名知识只活在分类层。',
  },
  {
    id: 'exact-media-range',
    case: 'exact',
    query: '视频 拖拽播放 HTTP Range 206 Partial Content',
    expected: ['knit/src/host/index.js'],
    evidence: { 'knit/src/host/index.js': '206 Partial Content' },
    distractors: ['knit/SECURITY.md', 'knit/README.md'],
    note: '宿主侧的 sendMedia；SECURITY.md 只讲响应头，不讲 Range。',
  },
  {
    id: 'exact-index-fingerprint',
    case: 'exact',
    query: '重启后复用索引 内容指纹 有界对账',
    expected: ['knit/src/host/index-store.js'],
    evidence: { 'knit/src/host/index-store.js': '不存正文，也不存原文首部' },
    distractors: ['01_ Knit PRD/Knit-SDD.md', 'knit/CHANGELOG.md'],
    note: '“不存正文”这条裁决只写在持久层模块头里。',
  },
  {
    id: 'exact-agents-budget',
    case: 'exact',
    query: '指令文件预算 分层闸门 上限',
    expected: ['knit/tools/agents-budget.mjs'],
    evidence: { 'knit/tools/agents-budget.mjs': '指令文件预算（分层闸门）' },
    distractors: ['AGENTS.md', 'knit/AGENTS.md', '99_暂存文档/指令治理-事实基线-2026-10-09.md'],
    note: '两份 AGENTS.md 都写了预算数字 —— 但「闸门在哪」的答案是这个脚本。',
  },

  /* ── 同义表达 / 概念查询 ──────────────────────────── */
  {
    id: 'syn-layers',
    case: 'synonym',
    query: '它凭什么把一篇放进先看的那一层',
    expected: ['knit/src/host/context.js'],
    evidence: { 'knit/src/host/context.js': 'PRIMARY_MIN_SHARE' },
    distractors: ['knit/AGENTS.md', '01_ Knit PRD/Knit-SDD.md', 'knit/CHANGELOG.md'],
    note: '问法里一个术语都没有（没有「主要 / 辅助 / 相关 / 分层」），考的是概念对概念。',
  },
  {
    id: 'syn-cap-related',
    case: 'synonym',
    query: '相关层名额不够的时候谁让位',
    expected: ['knit/src/host/context.js'],
    evidence: { 'knit/src/host/context.js': '被挤掉的必须是语义条目' },
    distractors: ['knit/test/hybrid-retrieval.test.mjs', 'knit/CHANGELOG.md'],
    note: '「让位」= 挤出顺序。测试文件里有同名断言，是最容易踩中的干扰项。',
  },
  {
    id: 'syn-relations',
    case: 'synonym',
    query: '两个代码文件之间的依赖是怎么看出来的',
    expected: ['knit/src/host/relations.js'],
    evidence: { 'knit/src/host/relations.js': '逐行正则' },
    distractors: ['knit/src/host/links.js', 'knit/CHANGELOG.md'],
    note: '问「依赖」，源码说的是 imports；且相邻还有一个 links.js（那是 Markdown 链接层）。',
  },
  {
    id: 'syn-semantic-inject',
    case: 'synonym',
    query: '语义候选加在哪里 会不会动主要层',
    expected: ['knit/src/host/semantic.js', 'knit/src/host/context.js'],
    evidence: {
      'knit/src/host/semantic.js': '有界语义候选',
      'knit/src/host/context.js': '最后**才轮到语义条目',
    },
    distractors: ['99_暂存文档/01_ Knit PRD-历史版本/Knit-v0.23-方案-可选混合检索.md', 'knit/CHANGELOG.md'],
    note: '这题有两个答案面（算候选的层 + 装包的层）。方案文档也讲同一件事 ⇒ 强干扰。',
  },
  {
    id: 'syn-privacy',
    case: 'synonym',
    query: '开了语义检索以后 我的文件内容会不会被传出去',
    expected: ['knit/src/host/semantic.js'],
    evidence: { 'knit/src/host/semantic.js': '只有 title + summary' },
    distractors: ['knit/README.md', 'knit/CHANGELOG.md', 'knit/SECURITY.md'],
    note: '问的是隐私边界，**答案的真源是 embedTextOf()**，不是 README 那句话。README 反而最容易命中。',
  },
  {
    id: 'syn-fallback',
    case: 'synonym',
    query: '连不上 embedding 服务会怎么样',
    expected: ['knit/src/host/semantic.js', 'knit/test/semantic.test.mjs'],
    evidence: {
      'knit/src/host/semantic.js': 'probe-failed',
      'knit/test/semantic.test.mjs': '失败三态',
    },
    distractors: ['knit/README.md', 'knit/tools/hybrid-retrieval-eval.mjs'],
    note: '「连不上」= 探测失败 / 超时 / 形状不对，五种 reason 收敛在引擎里。',
  },
  {
    id: 'syn-protocol-diff',
    case: 'synonym',
    query: '本地 Ollama 和别的兼容服务 探测接口有什么不一样',
    expected: ['knit/src/host/semantic.js', 'knit/test/semantic.test.mjs'],
    evidence: {
      'knit/src/host/semantic.js': '/v1/embeddings',
      'knit/test/semantic.test.mjs': '/v1/models',
    },
    distractors: ['99_暂存文档/01_ Knit PRD-历史版本/Knit-v0.23-Phase0-审计.md'],
    note: '两协议的**唯一分叉点**在 createSemanticProvider()；测试逐条钉住了 URL 与形状。',
  },
  {
    id: 'syn-feedback-freeze',
    case: 'synonym',
    query: '为什么读过的历史不会再变',
    expected: ['knit/src/host/feedback.js'],
    evidence: { 'knit/src/host/feedback.js': '归因在这一次调用里就结算并冻结' },
    distractors: ['knit/test/document-lifecycle.test.mjs', 'knit/AGENTS.md'],
    note: '问「不会改口」，源码说的是「读时冻结」。',
  },
  {
    id: 'syn-clean-room',
    case: 'synonym',
    query: '怎么证明发出去的包里测试也跑得通',
    expected: ['knit/tools/clean-room-test.mjs'],
    evidence: { 'knit/tools/clean-room-test.mjs': 'clean-room' },
    distractors: ['knit/CHANGELOG.md', 'knit/package.json'],
    note: '「净室」在脚本名里，正文里几乎没有这个词的完整说法。',
  },
  {
    id: 'syn-market-downloads',
    case: 'synonym',
    query: 'npm 下载量到底是不是真人在装',
    expected: ['knit/tools/market-recheck.mjs'],
    evidence: { 'knit/tools/market-recheck.mjs': '被自动化枚举的包' },
    distractors: ['03_发布/分发基线-2026-09-21.md', 'knit/CHANGELOG.md'],
    note: '判据（latest 占比 / 日覆盖度）与形状对照表都在这个脚本里。',
  },
  {
    id: 'syn-plugin-recovery',
    case: 'synonym',
    query: '面板里的插件全都不见了怎么办',
    expected: ['DSH-插件恢复手册.md'],
    evidence: { 'DSH-插件恢复手册.md': '插件在 GUI 里全都不见了' },
    distractors: ['knit/README.md', 'README.md', 'knit/CHANGELOG.md'],
    note: '准确答案是仓库外那本手册；README 只讲安装，不讲恢复。',
  },
  {
    id: 'syn-highlight-window',
    case: 'synonym',
    query: '预览里的代码 为什么只有一段有颜色',
    expected: ['knit/AGENTS.md', 'knit/src/client/client.js'],
    evidence: {
      'knit/AGENTS.md': '只给命中段那一带上色',
      'knit/src/client/client.js': 'CODE_HL_MAX_LINES',
    },
    distractors: ['knit/CHANGELOG.md', 'knit/README.md'],
    note: '「只有一段有颜色」= 命中段窗口。规则写在纪律层，常量写在客户端。',
  },

  /* ── 负样例（强干扰项在场）─────────────────────────── */
  {
    id: 'neg-four-paths',
    case: 'negative',
    query: '四路径消融 分别证明什么',
    expected: ['knit/tools/hybrid-retrieval-eval.mjs'],
    evidence: { 'knit/tools/hybrid-retrieval-eval.mjs': 'deterministic stand-in provider' },
    distractors: [
      '99_暂存文档/01_ Knit PRD-历史版本/Knit-v0.23-实现与基准报告.md',
      '03_发布/发布清单-v0.23.0.md',
      'knit/CHANGELOG.md',
    ],
    note: '「四路径」这个说法在历史报告与发布清单里都出现过 —— 三份干扰项说的是**上一次**的结论，'
      + '而表格本身只在这一个脚本里。',
  },
  {
    id: 'neg-corpus-labels',
    case: 'negative',
    query: '评测语料里的正确答案是谁定的',
    expected: ['knit/test/retrieval-corpus.mjs'],
    evidence: { 'knit/test/retrieval-corpus.mjs': '人工标注的「该命中谁」' },
    distractors: ['knit/test/retrieval-eval.mjs', 'knit/tools/hybrid-retrieval-eval.mjs'],
    note: '量尺（retrieval-eval.mjs）与标注（retrieval-corpus.mjs）是两个文件 —— 这一题专门考会不会答错邻居。',
  },
  {
    id: 'neg-security-table',
    case: 'negative',
    query: '哪些安全属性有机器核验',
    expected: ['knit/SECURITY.md'],
    evidence: { 'knit/SECURITY.md': '每一条都指向一个真实存在的检查' },
    distractors: ['knit/test/security.test.mjs', 'knit/README.md', 'knit/src/host/index.js'],
    note: '对照表在 SECURITY.md；security.test.mjs 是校验这张表的守卫，不是表本身。',
  },
  {
    id: 'neg-value-evidence',
    case: 'negative',
    query: '混合检索的收益证据到哪一步了',
    expected: ['knit/README.md', 'knit/tools/hybrid-retrieval-eval.mjs'],
    evidence: {
      'knit/README.md': 'value-evidence: pending',
      'knit/tools/hybrid-retrieval-eval.mjs': 'value-evidence',
    },
    distractors: ['knit/CHANGELOG.md', '03_发布/发布清单-v0.23.0.md', '01_ Knit PRD/Knit-SDD.md'],
    note: '这题考的是「会不会把机制证据说成价值证据」：三份干扰项都更容易被词法命中。',
  },
  {
    id: 'neg-poll-jump',
    case: 'negative',
    query: '为什么列表不会被五秒轮询拽回去',
    expected: ['knit/AGENTS.md', 'knit/src/client/client.js'],
    evidence: {
      'knit/AGENTS.md': '轮询刷出来的数组',
      'knit/src/client/client.js': 'POLL_MS',
    },
    distractors: ['knit/test/client.test.mjs', 'knit/CHANGELOG.md'],
    note: '「五秒」只以 POLL_MS = 5000 的形式存在，问法里没有这个常量名。',
  },
]

/** 去重后的全部候选 rel（`--verify` 用它检查标签拼写）。 */
export function allLabeledRels() {
  const out = new Set()
  for (const q of QUERIES) {
    for (const rel of q.expected) out.add(rel)
    for (const rel of q.distractors || []) out.add(rel)
  }
  return [...out]
}

# 可选混合检索 · 代码审查与真实工作区评测

> **本轮做了什么**：沿真实调用链审查 v0.23 的可选混合检索（Hybrid）、用**报文级实测**核对它的隐私边界、
> 在**这个仓库自己的真实工作区**上建了一份人工标注的检索量尺并按它量了词法基线，
> 再把 README（中 / 英）、`package.json` 描述、`SECURITY.md`、市场简介逐条对齐到当前实现。
>
> **本轮没做什么**：没改检索算法、没新增检索模式、没动 UI、没改任何测试、没发版、没碰任何外部页面。
>
> | | |
> |---|---|
> | 代码版本 | `knit/package.json` = **0.23.1**；`git rev-parse --short HEAD` = **`b164d8e`**；分支 `main`、工作区干净（开工时） |
> | npm 实际 latest | **0.23.1**（`dist-tags.latest`，发布于 2026-10-12T23:35Z，`gitHead` = `2925ad3`） |
> | 测试基线 | `cd knit && npm test` → **775 / 775 通过**（33 个测试文件）；净室闸门 `node tools/clean-room-test.mjs` → 解包目录里同样 **775/0** |
> | 真 provider | **本机没有**（`127.0.0.1:11434` 无响应、无 `ollama` 可执行文件）⇒ **H1 未跑，语义收益仍为 `pending`** |
> | 结论一句话 | **机制成立、默认路径一分钱不花、回退诚实；但「语义检索有价值」这件事本轮依然没有证据 —— 继续投入的前提是先把真 provider 那一跑做出来。** |

---

## 一、代码审查（沿调用链，每条都有出处）

### 1.1 默认词法检索怎么走

| 步 | 在哪 | 做什么 |
|---|---|---|
| ① | HTTP `GET /knit/api/recent` → `scan(root, limit, options)` | `src/host/index.js:1663` —— 唯一的扫描入口 |
| ② | `wantRelevance = options.sort === 'relevance'` | `index.js:1679` |
| ③ | 抽关键词 / 任务原话 | `index.js:1691-1708`：显式 `query` → `extractKeywords()`；否则 `conversationFor()` 读会话最近消息。**没有关键词就退回时间序**（`mode='time'`） |
| ④ | `collectDocs(hostRoot, { index: mode !== 'relevance' })` | `index.js:1711` —— 相关检索时必须拿到正文（`hydrateBodies`，`index.js:1806`） |
| ⑤ | 类型档选池（`doc` / `code` / `media` / `all` / `context`） | `index.js:1723-1745` |
| ⑥ | **排除先于检索** | `index.js:1747-1768` —— 被排掉的文件不进候选集 |
| ⑦ | `rankByRelevance(pool, keywords, now)` | `index.js:1810` → `src/host/relevance.js`（BM25 + 字段权重 4/2/1 + IDF + 长度归一化 + 10% 时间微调） |
| ⑧ | 装配 Context Pack | `index.js:2037` `contextPayload()` → `src/host/context.js:360` `buildContext()` |

### 1.2 Hybrid 在**哪一行**加候选结果

只有一处注入点，位置是刻意的（注释写明两处都不能挪）：

```js
// src/host/index.js:1776-1785   —— 在「排除之后」（判据 3）、在 rankByRelevance 之前
const semantic = await semanticPassFor(root, { retrieval, applies: mode === 'relevance', queryText, keywords, task, docs: pool })

// src/host/index.js:1792-1795   —— 把候选**标记**进池子：只打标，不排序、不抬层、不改名次
if (semantic.mode === 'hybrid' && semantic.rels.length > 0) {
  const semanticRels = new Set(semantic.rels)
  for (const doc of pool) if (semanticRels.has(doc.rel)) doc.semantic = true
}
```

真正「进包」的一步在装配层 `src/host/context.js`：

- `src/host/context.js:415` `const hit = records.filter((r) => r.raw > 0)` —— 只有词法命中的才有资格进任何一层；
- `src/host/context.js:426` `const semanticOnly = records.filter((r) => r.raw === 0 && r.semantic === true)` —— 语义条目**单独收**；
- `src/host/context.js:595-600` —— 在词法（`hit`）与关系（引用图邻居）**都排完之后**，语义条目才追加进 `related`，且只吃剩下的 `capRelated` 名额。

### 1.3 它只补「相关」层吗？会不会动主要 / 辅助 / 基础排序？

**是，只补相关层，而且是结构性保证，不是纪律。**

| 层 | 准入门槛（`context.js`） | 语义条目为什么进不去 |
|---|---|---|
| Primary | `grounded(record) && record.strength >= PRIMARY_MIN_SHARE`（`:504`） | `strength = raw / topRaw`，语义条目 `raw === 0` ⇒ `strength === 0` |
| Supporting | `isDocHit(record)` —— 要求**正文**里焦点词的窗口字频达标（`:489-497`） | 语义条目 `terms: []`（`explainContext` 的 `semantic` 分支，`:298`）⇒ 没有 `termFields` |
| Related | 先词法、再关系，**最后**才语义（`:571-600`） | 只能落在这里；`capRelated` 满时**第一个被挤掉的也是它** |

另外三条可核验的性质：

1. **基础词法排序一行没改**：`rankByRelevance()` 读的是 `haystack`（title / summary / body），
   `doc.semantic` 不是它的输入 —— `relevance.js` / `passage.js` 里没有 `semantic` 这个标识符。
2. **理由不冒充命中**：语义条目的 `reason.code === 'semantic'`、`terms` 为空、`provenance === 'semantic'`
   （`context.js:298` / `:629-631`），且 `REASON_ORDER.semantic = 7`（最弱，只在同层名次相同时兜底）。
3. **公开字段不变**：`publicDoc()` 是白名单投影，`doc.semantic` 不下发（`test/hybrid-retrieval.test.mjs:246` 判据 7 逐条断言 `'semantic' in doc === false`）。

**已在测试里被钉住**（`test/hybrid-retrieval.test.mjs`，12 项）：判据 1（词法模式零调用）、2（既有条目原样 + 追加）、
2c（`capRelated` 满时挤掉语义）、3（被排除的文件不可能经语义回来）、3b（零命中的语义条目进得了包）、
5（五种失败各自收敛成 reason）、6（理由只写可复核事实）、7（字段集合不变）。
`test/hybrid-eval.test.mjs` 判据 8b 更进一步：在合成语料上 **H0 的 primary / supporting 两层与 L 逐字相同，
related 层以 L 为前缀**。

### 1.4 Provider 的入口 / 配置 / 超时 / 回退

| 问题 | 答案 | 出处 |
|---|---|---|
| 唯一出口 | `createSemanticProvider()`；引擎里**只有 `pass()`** 会发请求 | `src/host/semantic.js:149`、`:389` |
| 配置存哪 | DSH 存储单元 `knit_semantic` 的 `config` 表、键 `provider`（**全局一条，不按工作区**）；`layout:'single'` | `semantic.js:24-30`、`:229-235` |
| 配置怎么改 | **只认** `POST /knit/api/semantic`（回环 + POST + 整份合法，否则 400）；空 `{kind,base,model}` ⇒ 清空；保存后顺手探一次 | `index.js:2739-2775` |
| 配置何时读 | 懒加载（`load()` / `ready()`），**不发探测** | `semantic.js:320-330`、`:362-365` |
| 超时 | 探测 **1500 ms**、嵌入 **8000 ms**，可用 `options.timeouts` 覆盖；`AbortController` 到点 abort ⇒ `reason:'timeout'` | `semantic.js:46-47`、`:154-155`、`:123-140` |
| 失败回退 | 五种 reason：`no-provider` / `no-query` / `probe-failed` / `timeout` / `bad-response`；`fetchJson` **从不抛**；`semanticPassFor` 外面还包一层 try/catch | `semantic.js:13-15`、`:404-413`、`:449`；`index.js:1621-1643` |
| 「实际生效模式」 | `mode` 报的是**跑成了没有**，不是「你要的那个」；工具输出会写 `lexical — fell back from hybrid (<reason>)` | `index.js:1623-1637`；`tool.js:771-775` |
| 有界 | 每轮最多新嵌 **8 篇**（`SEM_EMBED_PER_PASS`）、候选上限 **24**（`SEM_TOPK`）、相似度下限 **0.35**、向量缓存 **2000** 条、探测 TTL **60 s** | `semantic.js:36-44` |
| 时间序短路 | `applies !== true` ⇒ 直接回 `not-applicable`，**连探测都不发** | `index.js:1601-1606` |

### 1.5 Ollama / 本地 loopback / OpenAI 兼容：实际差异

| | `ollama` | `openai-compatible` |
|---|---|---|
| 探测 | `GET {base}/api/tags` | `GET {base}/v1/models` |
| 探测校验 | 只要求「是个对象」，**不校验模型清单** | 同上 |
| 嵌入 | `POST {base}/api/embed` | `POST {base}/v1/embeddings` |
| 请求体 | `{ model, input }` | **逐字相同**（源码里两个分支是同一个对象，`semantic.js:182-184`） |
| 读响应 | `json.embeddings`（数组） | `json.data[].embedding` |
| 形状校验 | `vectors.length === input.length`，逐条非空数组（少给一条比多给一条更危险） | 同一条校验 |

**loopback 没有任何协议差异，也没有额外的运行时保障**：
`isLoopbackBase()`（`semantic.js:77-84`）只做 **hostname 严格相等**判断（`127.0.0.1` / `localhost` / `::1` / `[::1]`），
而且**只有客户端用它来选那句披露文案**（`client.js:5281-5283`）。
宿主侧对 loopback 与非 loopback **一视同仁** —— 同样的超时、同样的报文、同样的调用次数，也**不会**因为地址不是回环就拒绝。
⇒ 「指向本机服务时内容不出这台机器」这句话成立的前提是：**你填的 base 真的是本机地址**。
Knit 不会替你验证这件事（它也没法验证：字符串是回环 ≠ 这台机器上没有把该请求转出去的代理）。

⚠️ **实测到的一个配置陷阱**：`normalizeProviderConfig()` 只去掉 `base` 末尾的斜杠，**不识别 `/v1` 后缀**。
若按 OpenAI 兼容服务的常见习惯填 `http://127.0.0.1:1234/v1`，实际请求会打到：

```
GET  http://127.0.0.1:1234/v1/v1/models      ← 实测
POST http://127.0.0.1:1234/v1/v1/embeddings
```

后果是**安全但费解**的：探测 404 ⇒ `probe-failed` ⇒ 如实退回词法，界面只说「provider 连不上」，
不会提示「`/v1` 写重了」。同理，给 Ollama 填带路径的 base 会得到 `{base}/v1/api/tags`。
（客户端占位符给的是 `http://127.0.0.1:11434`，对 Ollama 是正确示范，但对通用「服务地址」的暗示偏弱。）

### 1.6 现有自动化测试分别证明了什么

| 文件（项数） | 证明了 | 靠什么 |
|---|---|---|
| `test/semantic.test.mjs`（16） | 配置收敛（只认两种协议 + `http(s)` base + 非空 model）、`isLoopbackBase` 四种写法、`cosine` 边界、`embedTextOf` 只取 title+summary、**两种协议的 URL 与响应形状**、五种 reason、存储读写与坏值拦截、引擎全部短路路径（零调用）、有界嵌入、换模型作废缓存、`status()` 不谎报可用 | **全部是注入的假 `fetchImpl`**；Ollama 的请求体在 `:101` 被逐字断言（`{model, input}`） |
| `test/hybrid-retrieval.test.mjs`（12） | 判据 1/2/2c/3/3b/5/6/7 的端到端行为（见 §1.3） | 假 provider（任何输入回 `[1,0]`） |
| `test/hybrid-eval.test.mjs`（6） | 四路径消融：H2 与 L **面板载荷逐字一致**、H0 只追加、标注的「该救」样本真被补回、每轮调用 ≤3、指标函数手算例、真 provider 的环境解析与探测 | **确定性替身**（`retrieval-corpus.mjs` 的加权同义词表），不是模型 |

**都只是 Mock。** 三件事**没有**被任何测试覆盖：

1. **真 provider**：H1 刻意不进测试（会打网络），所以「语义检索有没有用」在 CI 里**从来没被验证过**；
2. **OpenAI 兼容那条路的请求体没被断言** —— 只有 URL 与响应形状（`semantic.test.mjs:104-113`）。
   代码里两条分支共用一个对象，风险低，但「共用」不等于「被验过」；
3. **`POST /knit/api/semantic` 没有宿主侧 e2e**：`SECURITY.md:41` 自己如实写明「只有客户端侧断言
   （`client.test.mjs` 认这条 URL）」，没有像 `/api/control` 那样在真回环端口上验「GET→405 / 别的路由 POST→405 / 坏 body→400」。

---

## 二、检索隐私边界：**报文级**结论

读代码得出的结论与跑一次录下来的结论，在「有没有别的东西混进去」这个问题上不是一回事。
所以做了一支录音 fetch（`knit/tools/semantic-request-audit.mjs`），把每一次请求的 **URL / 方法 / 头 / body 原样存下来**，
在**真实工作区**上跑足够多轮 `scan()`（把有界嵌入铺满整份语料），再逐条判。

复现：

```sh
cd knit && node tools/semantic-request-audit.mjs
```

**实测**（当次工作区快照 = **186 篇**）：`GET {base}/api/tags` × 1、`POST {base}/api/embed` × 49（跑 25 轮）；
录到 **186 / 186 篇**（100%）的嵌入报文；211 条输入（25 条查询 + 186 条文档）。

> ⚠️ 「语料多少篇」随工作区里有多少文件而变（本报告自己也是一个文件）。**会变的是篇数，不变的是断言** ——
> 下表每条都是「对**当次全部**输入逐条判过」的结论。

| 断言 | 结果 | 实测细节 |
|---|---|---|
| 顶层字段只有 `model` + `input` | ✅ | 实测字段集合：`["input,model"]` |
| 请求头只有 `content-type` | ✅ | 唯一值 `{"content-type":"application/json"}` |
| 无绝对路径（工作区根 / 家目录 / `file://`） | ✅ | 四条标记一条未出现 |
| **每个输入串都能被解释成「查询原话」或某篇的 `title + summary`** | ✅ | **211 条全部可解释**（查询 25 / 文档 186）—— **多塞任何一个字段都会掉出这个集合** |
| 无成片正文 | ✅ | 对 **183 篇**真实文件做「开头 200 字 + 中段 200 字」探针，**一处未出现** |
| 每串 ≤1 换行、≤2000 字 | ✅ | 实测最长 119 字 |
| 代码的 summary 槽是工作区相对目录 | ✅ | 88 条逐条比过，9 个不同目录，无前导斜杠 / 盘符 / 反斜杠 |

**发出去了什么（精确边界）**

| # | 内容 | 边界 |
|---|---|---|
| ① | **用户那句查询原话** | 会话路径截到 **80 字**（`TASK_MAX_CHARS`，`index.js:134`）；显式 `query` 路径最多 2000。**每一轮刷新重发一次**（实测 25 轮 = 25 次；文档向量有缓存，查询没有） |
| ② | **标题** | Markdown：正文第一个 `# 标题`（否则文件名）；代码：**带扩展名**的文件名；媒体：**去掉扩展名**的文件名 |
| ③ | **摘要** | Markdown：**正文首个正文段落的节选，≤ 60 字**（`SUMMARY_CHARS = 60`，`index.js:210`、`:344-386`）；代码：**工作区相对目录**；媒体：空 |

**没有发出去**：完整正文、绝对路径、`rel`（含文件名的相对路径）、会话历史、未被选中的文件。

⚠️ **两个必须一起说出去、否则就是半真话的点**：

1. **「摘要」不等于「与正文无关的元数据」。** Markdown 的摘要是**从正文里抽的**（跳过 frontmatter / 标题行 /
   代码围栏 / 列表 / 引用 / 表格，取第一段真正的正文）。审计实测最长 **60 字**。
   ⇒「正文不发送」这句话按字面成立（没有成片正文），但**会有至多 60 字的正文离开本机**。
2. **图片 / 视频的文件名也会被发出去。** 它们没有摘要，`embedTextOf()` 拼出来的就是文件名本身。
   实测例子：`demo-reorder`、`screenshot-all`、`12-新-中文标签去掉全角冒号`、`10-新-命中段灰底chip-同一行`。
   截图文件名往往是**一句描述内容的中文**，这条比文档标题更值得写进披露。

### 2.1 顺带查出的两条（本轮只报告，不改代码）

**(a) `kind=media` 下语义通道跑了，但没有任何消费者。**
`semanticPassFor()` 的适用判据只有 `mode === 'relevance'`（`index.js:1779`），**与类型档无关**；
而 `contextPayload()` 对 `media` 档直接返回 `null`（`index.js:2037-2044`）。
⇒ `kind=media` + 相关序 + 混合模式时：媒体文件名被嵌入并发给你的 provider，**一个候选都不可能出现在任何一层**。
这与 `index.js:1596-1600` 给时间序写下的那条纪律自相矛盾（原话是「照跑就是白花 provider 调用 + 界面上还显示成可用 ⇒ 直接如实回 `not-applicable`」）。
⚠️ **2026-10-13 修正上面引文里的一个说法**：媒体档**没有**「界面上还显示成可用」这个症状 ——
状态摘要那一行（含检索方式状态格）的渲染条件是 `relevance && contextView`（`client.js:5447`），
而 `contextView` 要求 `kind ∈ {doc, code}` 且真有包（`client.js:4079-4081`）⇒ 媒体档整行都不渲染。
所以这条缺陷是**静默的**：白花调用 + 媒体文件名外发，界面上一声不响。完整追踪见 §附录 I。
**建议的最小修法**与影响评估见 §附录 I.4–I.5。⚠️ 它会改变行为 ⇒ 要配测试、要版本号，**不属于本阶段授权范围**。

**(b) `base` 带 `/v1` 会拼出 `/v1/v1/...`**（见 §1.5）。同样是「安全但费解」。

---

## 三、真实工作区评测

### 3.1 为什么要在真实工作区上再量一遍

仓库已有一支合成语料量尺（`test/retrieval-corpus.mjs`，19 篇临时文档 + 确定性替身），它证明的是**机制**。
它证明不了「在这个项目自己的语料上，默认词法到底找回多少」。所以另建一份：

| 文件 | 是什么 |
|---|---|
| `knit/tools/real-workspace-corpus.mjs` | **标注**：24 条查询（精确 7 / 同义 12 / 负样例 5）+ 每条的人工答案与**可 grep 的依据** + 强干扰项 |
| `knit/tools/real-workspace-eval.mjs` | **量尺**：跑 L（词法）与 H2（回退），出指标、断言、头寸清单 |

跑法：

```sh
cd knit
node tools/real-workspace-eval.mjs --verify   # 先核对标注：答案文件在不在、依据 grep 得到吗
node tools/real-workspace-eval.mjs            # 量尺
node tools/real-workspace-eval.mjs --json     # 机器可读的那一行
```

**标注协议**（写死在语料文件里）：`expected` = **一个熟悉这个仓库的人为回答这句话会去打开的那 1–3 个文件**，
不是「所有提到这个词的文件」—— 后者会把召回率变成「这个词有多常见」。每条答案必须有一条能 grep 到的依据，
`--verify` 逐条复核。**答案不由检索器决定。**

### 3.2 结果（2026-10-13，`git b164d8e`，工作区 182 篇，`kind=context`，`limit=40`）

```
路径                 R@5    R@10   MRR    命中@5   命中@10  无关@5   干扰项@5  平均包长
L   词法（默认）      0.479  0.583  0.275  0.500   0.583   0.892   0.542    7.6
H2  hybrid+探测失败   0.479  0.583  0.275  0.500   0.583   0.892   0.542    7.6   ← 与 L 逐字一致
```

| 指标 | 定义（避免各自理解） |
|---|---|
| Recall@5 / @10 | 前 K 条命中了多少比例的标注答案（按包内顺序） |
| MRR | 第一条命中的倒数排名 |
| 命中率@K | **至少一条标注答案进前 K 的查询占比**（success@K） |
| 干扰项@5 | 前 5 条里出现了**标注的负样例**的查询占比 |
| 无关@5 | 前 5 条里不在标注答案里的比例 |

**五条断言全部成立**（脚本退出码 0）：

- ✅ **A1** 词法路径 **0 次** provider 调用（默认零出口，实测）
- ✅ **A2** provider 探不通时，hybrid 的**包内顺序与除状态行外的面板载荷与词法逐字一致**（24/24 条），且 `mode` 如实回 `lexical` + 带 reason
- ✅ **A3** 标注自洽：24 条查询 / 30 条答案 / 55 条干扰项，每个答案文件都在语料里、每条依据都 grep 得到
- ✅ **A4 / A5** 包长逐条相同；**评测自己的产物没有进任何一层**

> 🔴 **A5 是一条被实测抓出来的方法论坑，值得记下来**：第一版把标注文件放在 `knit/tools/` 下、而工作区根是
> `08_Knit` —— 于是**评测语料本身就在被评测的语料里**，它逐字写着 24 条查询与全部依据短语，
> 成了每一条查询的磁铁，把真答案挤到第 7–9 位（首跑 R@5 = 0.354、命中@5 = 0.375）。
> 修法是用 `scan()` 公开支持的 `excluded`（**排除先于检索**）把三支评测脚本 + 这份报告共 4 个路径排掉 ⇒ R@5 = 0.479、命中@5 = 0.500。
> **凡是「把量尺放进被量的目录」的评测，都要先问一句：量尺自己会不会被检索到。**

### 3.3 语义通道的**头寸**（不是收益）

24 条查询里 **10 条**共有 **14 个标注答案**没有被词法找回（其中 4 个是「一个词都没命中」的零命中条目）。
它们就是语义通道**理论上有活干**的地方：

| 查询 | 未找回 | 词法状态 |
|---|---|---|
| 重启后复用索引 内容指纹 有界对账 | `knit/src/host/index-store.js` | 有命中但没进包 |
| 相关层名额不够的时候谁让位 | `knit/src/host/context.js` | **零命中** |
| 两个代码文件之间的依赖是怎么看出来的 | `knit/src/host/relations.js` | **零命中** |
| 语义候选加在哪里 会不会动主要层 | `knit/src/host/semantic.js`、`context.js` | 有命中但没进包 |
| 开了语义检索以后 我的文件内容会不会被传出去 | `knit/src/host/semantic.js` | **零命中** |
| 连不上 embedding 服务会怎么样 | `semantic.js`、`test/semantic.test.mjs` | 有命中但没进包 |
| 为什么读过的历史不会再变 | `knit/src/host/feedback.js` | 有命中但没进包 |
| 怎么证明发出去的包里测试也跑得通 | `knit/tools/clean-room-test.mjs` | **零命中** |
| 混合检索的收益证据到哪一步了 | `knit/README.md`、`tools/hybrid-retrieval-eval.mjs` | 有命中但没进包 |
| 为什么列表不会被五秒轮询拽回去 | `knit/AGENTS.md`、`src/client/client.js` | 有命中但没进包 |

⚠️ **这是「机会」，不是「收益」。** 词法没找到 ≠ 语义找得到：**真 provider 那一跑没做，所以这 14 个里有多少能被救回来，现在不知道。**

### 3.4 一个顺带量到的真实问题：工作区自己的历史文档在骗

`干扰项@5 = 0.542` —— 24 条查询里有 13 条的前 5 名出现了标注的干扰项。明细：

```
×2  knit/CHANGELOG.md
×2  03_发布/发布清单-v0.23.0.md
×1  knit/test/control.test.mjs          ×1  knit/test/deep-context.test.mjs
×1  knit/src/host/tool.js               ×1  knit/test/classification.test.mjs
×1  AGENTS.md                           ×1  knit/test/hybrid-retrieval.test.mjs
×1  99_暂存文档/…/Knit-v0.23-方案-可选混合检索.md
×1  99_暂存文档/…/Knit-v0.23-Phase0-审计.md
×1  03_发布/分发基线-2026-09-21.md
×1  99_暂存文档/…/Knit-v0.23-实现与基准报告.md
```

模式很清楚：**213 KB 的 `CHANGELOG.md`、`03_发布/` 下的发布清单、`99_暂存文档/` 下的历史规格**，
是这份工作区里最强的词法干扰项 —— 它们几乎包含所有术语，但不回答任何具体问题。
这是**工作区本身的形状**（一个持续了大半年的项目会攒下大量与当前实现并行的历史文本），
不是 `relevance.js` 的缺陷；但它同样是**语义候选理论上能帮上忙的地方**（历史文本与当前问题的「主题相近、意图不同」）。
**在真 provider 跑出来之前，不要把它写成收益。**

### 3.5 可复现性：一个必须知道的抖动

同一条命令在间隔约 3 分钟的两次运行里，`干扰项@5` 出现过 **0.583（14/24）与 0.542（13/24）**；
**连续 5 次运行则逐位相同**。原因在代码里：`rankByRelevance(pool, keywords, now)` 叠了 10% 的时间新鲜度微调，
而 `now = Date.now()`（`index.js:1809`）随运行时刻变化 ⇒ **名次接近的条目会翻面**。

⇒ 读这份指标时**只按「≥1 条查询」的粒度读结论，不要追小数点后第三位**；要严格对比两条路径的差异，
必须在**同一次进程**里跑（本脚本的 L 与 H2 就是这样，所以 A2 的「逐字一致」是可靠的）。

---

## 四、产品信息校准

### 4.1 逐项核对

| 位置 | 结论 | 处置 |
|---|---|---|
| `knit/README.md`（中文） | ⚠️ 三处说「只把文件的标题与摘要发过去（正文不发送）」—— 漏了**查询原话**也发、**Markdown 摘要取自正文**、**媒体发文件名** | ✅ **已改**：新增「混合模式到底发出去了什么」小节（报文实测口径），正文与功能表同步 |
| `knit/README.en.md` | 同上（`titles and summaries`, `never bodies`） | ✅ **已改**：新增 *What hybrid mode actually sends* |
| `knit/package.json` `description` | 🔴 **被 npm 截断**：原 **412 字** ⇒ registry 里存的是 **255 字**、末尾断在 `…zero network. Option`。实测 21 个已发版本里 **17 个（0.11.0 → 0.23.1）都是恰好 255 字**、全部断在句子中间 | ✅ **已改**：重写成 **249 字**、自足的一句话。⚠️ **npm 页面要等下一次 `npm publish` 才会变** |
| `knit/CHANGELOG.md` | ✅ 与实现一致：0.23.1 节的定位、工具栏收敛、`description` 重写理由都对得上。**不改历史记录**（那一节描述的是**已发布**的 0.23.1 tarball）。它里面同样写着「标题与摘要（不是正文）」⇒ 新口径要靠**下一次发版**的 CHANGELOG 节来记 | ⏸ 不动（无版本号可挂） |
| `knit/SECURITY.md` | ⚠️ 表格里有一行叫「零网络出口」，容易读成绝对承诺（实际只覆盖浏览器半边） | ✅ **已改**：该行改为「**客户端半边**零网络出口」并加一句边界，另补一条 **⚠️** 行如实写明「宿主半边唯一的出网点是 `semantic.js`，默认一次都不发；报文级实测在 tools/semantic-request-audit.mjs（该脚本不随包发布，所以是人工量尺、不是 CI 守卫）」 |
| `knit/AGENTS.md` §6.7 | 🔴 **与现实相反**：原文「**不要为了「更准」引入 embedding / LLM 调用** —— 这是对外的承诺与差异点」，而 v0.23 已经提供了可选的 embedding 通道 | ❌ **未改**（见 §4.3，有预算硬约束） |
| `AGENTS.md`（工作区 L0）§0 / §6.3 | 同上：「零模型、零网络出口」写成了无条件承诺 | ❌ **未改**，同上 |
| DSH 插件市场（外部） | 🔴 线上简介仍是 **v0.19.1 之前**的口径：只有「列表 + 引用条 + knit_docs 片段」，**一个字都没提混合检索**，而且写着无限定的 `no model calls and no network`；`version` 字段是 `0.22.0`（npm 实际 0.23.1）；第三张截图 `screenshot-all.png` 画的是 **v0.23.1 已删除的「全部」档** | ✅ **已产出可直接提交的中英文修订稿**：`03_发布/市场条目文案-v0.23.1.md`。**没有**改任何外部页面，**没有**改 `screenshots.json`（改了会在站点每日重建时**静默**影响外部页面） |
| 市场 `capabilities` | `["shell","fs-read","network"]`：`network` 现在确实成立（可选混合）；`fs-read` 成立；`shell` **在 `src/` 下找不到任何 `child_process`/`spawn`**（「在文件管理器里显示」是把 `action:'reveal'` 交给 DSH 自己的 remote）。来源应是随包发布的开发脚本 `tools/context-feedback-eval.mjs`（它 `spawnSync('zstd'\|'cat')` 读会话日志） | 📝 只在修订稿里说明，**留给人的决定** |

### 4.2 市场简介修订稿的要点

全文见 [`03_发布/市场条目文案-v0.23.1.md`](../../../03_发布/市场条目文案-v0.23.1.md)。它包含：
① 线上现状的取证方式（`plugins.json` / `gh api` / PR 状态）；
② 对不上的四处及严重程度；
③ 可直接提交的 `description.en` / `description.zh`；
④ 人要做的事（含「先撤掉那张过期截图」与提 PR 的完整命令，含早先那个仍 OPEN 的 #6760 该怎么处理）；
⑤ 提交后的验收判据。

**口径纪律**：修订稿**不许**出现「提升召回」「更准」「理解语义」这类结论 —— 目前没有证据。

### 4.3 为什么没顺手改 AGENTS.md（两份）

`node tools/agents-budget.mjs` 实测：

```
AGENTS.md         15.72 KiB / 上限 16.00 KiB（98.2%）   余量 0.28 KiB
knit/AGENTS.md    39.96 KiB / 上限 40.00 KiB（99.9%）   余量 0.04 KiB  ← 41 字节
合计              55.68 KiB / 上限 56.00 KiB（99.4%）
```

`knit/AGENTS.md` 只剩 **41 字节**余量，而 L0 的净零规则要求「加内容必须同量删」。
§6.7 那句要改成如实版本需要重写整段（提到「默认关闭的可选通道」），属于**指令层的措辞决策**，
不该由一次评测顺手做掉。**建议**（供人决定，净零改写）：

> §6.7 现文：**不要为了「更准」引入 embedding / LLM 调用** —— 「纯本地」是这个产品对外的承诺，也是它相对竞品的差异点之一。
>
> 建议改为：**默认路径不许引入 embedding / LLM 调用** —— 「纯本地」是对外的承诺与差异点。v0.23 的唯一例外是**默认关闭**的可选混合通道（`src/host/semantic.js`）：它只在用户配好 provider 且手动切换后出网，且**只补「相关」层**。

同时 `agents-budget.mjs --claims` 的三条状态断言（版本 `0.23.1` / 测试文件 33 / 测试数 775）在本轮改动后**仍然全部成立**。

---

## 五、尚未验证 / 阻塞与下一步

| # | 未验证的事 | 阻塞原因 | 下一步（人做） | 完成标准 |
|---|---|---|---|---|
| 1 | **语义检索到底有没有收益**（H1） | 本机没有可用 provider：`127.0.0.1:11434` 无响应、无 `ollama` 可执行文件、环境里没有任何 `KNIT_EVAL_*` / embedding 相关变量。擅自装远端服务被明令禁止 | 起一个本机 embedding 服务（例如 Ollama + `nomic-embed-text`），然后：<br>`cd knit && node tools/hybrid-retrieval-eval.mjs`（合成语料 H1）<br>`node tools/real-workspace-eval.mjs`（真实语料 H1） | 两条命令都打出 `H1 hybrid + 真 provider` 那一行、`valueEvidence` 不再是 `pending`；**并且** `rescued`（补回的标注答案）与 `appendedUnrelatedRate`（新增结果里无关项比例）都有数 |
| 2 | 真模型下**新增候选里的无关比例**（14 个头寸里能救回几个、又带进来几个垃圾） | 同上 | 同上 | 报告里能写出「补回 N / 14，新增无关 M 条（比例 M/新增总数）」 |
| 3 | **真模型的延迟与单轮成本** | 同上 | 同上 | 有墙钟 + provider 调用次数（脚本已采集，`wallMs` / `providerCalls`） |
| 4 | `kind=media` 下语义通道「跑了却没消费者」 | 已定位（§2.1a），但修它要动行为 + 加测试 + 版本号 | 决定是否在下一版修 | 有一条守卫钉住「`kind=media` 时零 provider 调用」 |
| 5 | `POST /knit/api/semantic` 的宿主侧 e2e | `SECURITY.md:41` 自己就标着 ⚠️ 未补 | 照 `/api/control` 的 e2e 补一条 | 真回环端口上验到 GET→405 / 别的路由 POST→405 / 坏 body→400 |
| 6 | OpenAI 兼容那条路的**请求体** | 测试只断言了 URL 与响应形状 | 在 `semantic.test.mjs` 补一行 body 断言 | 断言 `{model, input}` |
| 7 | `base` 带 `/v1` 的配置陷阱 | 已实测（§1.5），属可用性缺陷 | 决定是「规范化时识别 `/v1`」还是「占位符写清不许带路径」 | 用户填 `…/v1` 不再得到 `/v1/v1/…` |
| 8 | 我改的 README / 描述 / SECURITY 在 **npm 上还没生效** | 不发版就不会变（本轮禁止发布） | 下一次发版时带上；并在那一版的 CHANGELOG 里记新口径 | registry 上 `0.23.x` 的 `description` 长度 ≤ 255 且句子完整 |

**指标抖动**（§3.5）不是阻塞项，但它决定了「H1 的结果怎么读」：差异要用同一次进程内的对比，且只按 ≥1 条查询的粒度下结论。

---

## 六、改动清单 / 执行过的命令 / 测试结果

### 6.1 改动的文件

| 文件 | 类型 | 说明 |
|---|---|---|
| `knit/package.json` | ✏️ 改 | `description` **412 → 249 字**（躲开 npm 的 255 字截断） |
| `knit/README.md` | ✏️ 改 | 概览 + 新增「混合模式到底发出去了什么」小节 + 功能表那一行 |
| `knit/README.en.md` | ✏️ 改 | 同上（英文） |
| `knit/SECURITY.md` | ✏️ 改 | 「零网络出口」那行限定为客户端半边；新增一条 ⚠️ 行写宿主侧唯一的出网点 |
| `knit/tools/semantic-request-audit.mjs` | 🆕 新 | 语义请求隐私审计（录音 fetch + 真实工作区，9 条硬断言，退出码可接闸门） |
| `knit/tools/real-workspace-corpus.mjs` | 🆕 新 | 24 条查询的真实工作区标注语料（含依据与负样例） |
| `knit/tools/real-workspace-eval.mjs` | 🆕 新 | 真实工作区量尺（L / H2 / 头寸 / 5 条断言） |
| `knit/docs/evaluations/hybrid-retrieval.md` | 🆕 新 | 本文件 |
| `03_发布/市场条目文案-v0.23.1.md`（工作区层） | 🆕 新 | 市场简介修订稿 + 提交步骤 + 取证 |
| **源码 / 测试** | **未改** | `git status` 里 `src/` 与 `test/` 一个文件都没动；版本号没升；没发版；没建 Release；没碰外部页面 |

> 三支新工具都放在 `tools/`（**不在 `package.json` 的 `files` 白名单里**，不随包发布）——
> 这是刻意的：它们要读**真实工作区**、且标注是本机的，放进 `test/` 会让净室闸门在别人的机器上红
> （v0.20.0 的教训：`test/` 引 `tools/` 导致包内 638/1）。因此它们**不进 `scripts.test`**，
> 也就不改变 775 这个基线。
>
> ⚠️ 由此产生的一条代价：这 9 条隐私断言目前是**人工量尺**，不是 CI 守卫。
> 要变成常驻守卫，需要把它改写成一个不依赖真实工作区的用例（造一个小工作区 + 录音 fetch）并挂进 `scripts.test`——
> 那会让测试数从 775 变化，因而必须同步更新 `AGENTS.md` 里的两处状态字样（`--claims` 会红）。**本轮不做，留给下一版决定。**

### 6.2 执行过的命令

```sh
# 现状核实
git -C knit rev-parse --abbrev-ref HEAD && git -C knit status --porcelain && git -C knit log --oneline -6
node -e "console.log(require('./knit/package.json').version)"          # 0.23.1
curl -s http://127.0.0.1:11434/api/tags                                 # 无响应 ⇒ 无 provider
curl -s https://registry.npmjs.org/dsh-knit                             # latest 0.23.1，description 长度 255
curl -s https://awesome-dsh-plugin.com/plugins.json                     # 市场条目（v0.19.1 口径、version 0.22.0）
gh api repos/awesome-dsh-plugin/awesome-dsh-plugin/contents/data/plugins/PolinniZhong__dsh-knit.yml
gh pr view 6760 --repo awesome-dsh-plugin/awesome-dsh-plugin            # 仍 OPEN
gh pr list --repo awesome-dsh-plugin/awesome-dsh-plugin --author PolinniZhong --state all

# 测试基线（改动前后各一次）
cd knit && npm test                                                     # 775 pass / 0 fail（两次）
node --test test/security.test.mjs                                      # 8 pass（改 SECURITY.md 后）
node tools/agents-budget.mjs && node tools/agents-budget.mjs --claims    # ✓ 预算内；三条状态断言成立

# 本轮新增的量尺
node tools/semantic-request-audit.mjs                                   # 9/9 断言通过，覆盖 186/186 篇
node tools/real-workspace-eval.mjs --verify                             # 标注自洽（24 查询 / 30 答案 / 55 干扰项）
node tools/real-workspace-eval.mjs                                      # 5/5 断言通过；R@5 0.479 / MRR 0.275 / 命中@5 0.500
node tools/real-workspace-eval.mjs --json
node tools/hybrid-retrieval-eval.mjs                                    # 既有四路径量尺：H1 如实 skip
```

### 6.3 测试结果

| 命令 | 结果 |
|---|---|
| `cd knit && npm test` | **775 pass / 0 fail**（33 个测试文件，2.6–3.1 s）—— 改动前、改动后各跑一次 |
| `node --test test/security.test.mjs` | **8 pass / 0 fail** |
| `node tools/agents-budget.mjs --claims` | ✅ 预算内（55.68 / 56.00 KiB）；版本 `0.23.1` ✓、测试文件 33 ✓、测试数 775 ✓ |
| `node tools/semantic-request-audit.mjs` | ✅ **9/9** 硬断言通过，退出码 0 |
| `node tools/real-workspace-eval.mjs` | ✅ **5/5** 断言通过，退出码 0；`valueEvidence: pending (no provider)` |
| `node tools/hybrid-retrieval-eval.mjs`（既有） | H1 如实 skip（`value-evidence: pending (no provider)`） |
| `node tools/clean-room-test.mjs`（**发版前闸门**） | ✅ 打包 65 个文件（`tools/` 只有白名单那两个）、解包目录里 **775 pass / 0 fail** —— 即「这份包现在就可以发」（本轮没发） |

---

## 七、结论（一页以内）

**当前 Hybrid 是否值得继续投入？**
**机制层面已经做完且值得留着**（默认零调用、只补相关层、有界、回退与词法逐字一致 —— 这些本轮都复验过，而且真实工作区的 A2 断言也过了）。
但**「有没有收益」这一格到现在仍然是空的**：本机没有 provider，H1 从未跑过，14 个头寸里能救回几个完全未知。
⇒ **值得继续投入的只有一件事：先把真 provider 那一跑做出来**（起本机 Ollama + `nomic-embed-text`，跑两条命令就有数）。
在那之前**不建议**再加语义相关的功能，也**不建议**把这套做进任何对外文案。

**市场文案哪些需要改？**
四处：① 无限定的 `no model calls and no network` 要收窄到「默认词法模式」，并如实写出可选混合（**线上现在一个字都没提它**）；
② 补 v0.19–v0.23 的能力（代码一等公民、三层 Context Pack、读取证据 / 生命周期、固定排除、关系证据、增量索引）；
③ 第三张截图 `screenshot-all.png` 画的是 v0.23.1 已删除的「全部」档，要撤；④ `version` 字段滞后（索引每日重建，会自动跟上）。
可直接提交的中英文修订稿在 `03_发布/市场条目文案-v0.23.1.md`。另外 **npm 上那份描述从 0.11.0 起、17 个版本一直被截断在 255 字**
（0.23.1 断在 `…zero network. Option`），仓库里已修好，**要等下一次发版才会变**。

**还有哪些事实不能下结论？**
① **语义检索的价值**（收益 / 代价 / 新增结果的无关比例）—— 全部 `pending`；
② **真模型下这 14 个头寸能救回几个**；
③ `kind=media` 下那轮「白花的 provider 调用」在真实使用中占多大比例（代码事实已确认，影响面未量）；
④ 改后的 README / 描述 / SECURITY 在市场页与 npm 页上的**实际呈现**（要等发版与站点重建）；
⑤ 市场 `capabilities` 里的 `shell` 该不该改（标签有据但描述的不是运行期行为，归因规则不由我们定）。

---

## 附录 · 说明（2026-10-13 第一阶段收尾核验）

> **这一节加进这份报告，而不是另开一个文件 —— 这是刻意的。**
> 评测语料 = **工作区里实际存在的文件**，所以往工作区里加任何一篇都会改变量尺的输入。
> 本报告已经在 `tools/real-workspace-eval.mjs` 的排除名单（`EVAL_ARTIFACTS`）里，
> 因此**只有加在这里，182 篇的口径与全部指标才保持逐字可复现**。
> 附录里的每一条都能用文中的命令重新跑出来；跑出来的原始输出见 §附录 F。

## 附录 A · 数据口径核验

### A.1 「24 条查询」与「10 条查询」不是两个数字，本轮实跑 24 条

- **语料定义 24 条查询**（`tools/real-workspace-corpus.mjs`，`CORPUS_VERSION = 1`：精确 7 / 同义 12 / 负样例 5）。
- **每次运行都是全量 24 条**：`runPath()` 对 `QUERIES` 全量遍历，没有任何抽样或提前退出。
- **「10 条」是一个子集，不是另一次运行**：24 条里有 **10 条**至少有一个标注答案没进包（`✗`），
  另外 **14 条**的标注答案全部进包（`✓`）。原始记录（从 `eval-stdout.txt` 解析）：
  `parsed rows: 24` / `by flag: {"✓":14,"✗":10}` / `total missed answers: 14`。
- **本轮实际运行量**：

  | 项 | 次数 |
  |---|---|
  | L（词法）`scan()` | **24**（每条查询 1 次） |
  | H2（hybrid + 探测失败）`scan()` | **24**（每条查询 1 次） |
  | 语料快照 `scan()`（`--verify` 与统计用） | 每次运行 1 次 |
  | H1（真 provider） | **0 —— 未跑**（探测 `127.0.0.1:11434` 失败，如实 skip） |
  | 合计（量尺本身） | **48 次 scan / 24 条查询 × 2 条路径** |

- 命令：`cd knit && node tools/real-workspace-eval.mjs`；原始输出 `/tmp` 记录见 §附录 F.2。

### A.2 14 个未找回的标注答案 与 4 个零命中 —— 逐条可追溯

**先纠正一个口径**：「4」是 **未找回的答案数里「零命中」的那 4 个**，计量单位是**答案**，不是查询
（`headroom.missedZeroHit` 统计的是 `missed` 数组里被标为 `zeroHit` 的元素个数）。
在这份语料上它恰好分布在 4 条不同的查询里，所以两种读法都得到 4，但**口径是答案**。

**「零命中」的判据**：该文件的 `raw === 0` —— 即 BM25 在它身上**一个关键词都没命中**，
它是语义通道唯一真正够得着的对象；「有命中但没进包」的答案则连词法都摸到了，只是分层没让它上场。

| # | 查询 id | case | 查询原话 | 未找回的标注答案 | 该答案本轮的词法状态 |
|---|---|---|---|---|---|
| 1 | `exact-index-fingerprint` | exact | 重启后复用索引 内容指纹 有界对账 | `knit/src/host/index-store.js` | 有命中但没进包 |
| 2 | `syn-cap-related` | synonym | 相关层名额不够的时候谁让位 | `knit/src/host/context.js` | **零命中** |
| 3 | `syn-relations` | synonym | 两个代码文件之间的依赖是怎么看出来的 | `knit/src/host/relations.js` | **零命中** |
| 4 | `syn-semantic-inject` | synonym | 语义候选加在哪里 会不会动主要层 | `knit/src/host/semantic.js` | 有命中但没进包 |
| 5 | 〃 | 〃 | 〃 | `knit/src/host/context.js` | 有命中但没进包 |
| 6 | `syn-privacy` | synonym | 开了语义检索以后 我的文件内容会不会被传出去 | `knit/src/host/semantic.js` | **零命中** |
| 7 | `syn-fallback` | synonym | 连不上 embedding 服务会怎么样 | `knit/src/host/semantic.js` | 有命中但没进包 |
| 8 | 〃 | 〃 | 〃 | `knit/test/semantic.test.mjs` | 有命中但没进包 |
| 9 | `syn-feedback-freeze` | synonym | 为什么读过的历史不会再变 | `knit/src/host/feedback.js` | 有命中但没进包 |
| 10 | `syn-clean-room` | synonym | 怎么证明发出去的包里测试也跑得通 | `knit/tools/clean-room-test.mjs` | **零命中** |
| 11 | `neg-value-evidence` | negative | 混合检索的收益证据到哪一步了 | `knit/README.md` | 有命中但没进包 |
| 12 | 〃 | 〃 | 〃 | `knit/tools/hybrid-retrieval-eval.mjs` | 有命中但没进包 |
| 13 | `neg-poll-jump` | negative | 为什么列表不会被五秒轮询拽回去 | `knit/AGENTS.md` | 有命中但没进包 |
| 14 | 〃 | 〃 | 〃 | `knit/src/client/client.js` | 有命中但没进包 |

- **10 条查询 / 14 个答案 / 其中 4 个零命中**（分布在第 2、3、6、10 行）。
- 原始记录：`eval-stdout.txt` 的「── 四、语义通道的头寸」整节（§附录 F.2 原样保留）；
  JSON 里对应 `headroom = { queriesWithMiss: 10, missedTotal: 14, missedZeroHit: 4, detail: [...] }`。
- ⚠️ **这 14 条全部是「机会」，不是「收益」**：`headroom.detail[].foundByHybrid` 在本轮**每一行都是 `null`**
  （因为 H1 没跑），不是 `[]`。`null` = 没测过；`[]` = 测过且一条没救回。**这两个不能混读。**

### A.3 182 篇 与 186 篇：差异就是评测自己的 4 个文件

两个数字量的是**同一台机器、同一时刻、同一个工作区根**（`/Users/zhongwentuo/DeepSeek Harness Native/08_Knit`），
差别只在**排除名单**：

| | 命令 | 是否传 `excluded` | 篇数 | 构成 |
|---|---|---|---|---|
| 隐私审计（无排除） | `node tools/semantic-request-audit.mjs` | 否 —— 它**故意不排除**：要量的是「工作区里所有会被嵌入的东西」 | **186** | md 98 + code 88 |
| 检索评测（排除 4 个） | `node tools/real-workspace-eval.mjs` | 是 —— `scan({ excluded: EVAL_ARTIFACTS })`，**排除先于检索** | **182** | md 97 + code 85 |

差集**恰好**是这 4 个路径（用 `scan()` 两次对比实测，脚本见 §附录 F.4）：

```
scanned (no exclusion) : 186
pool (eval, excluded)  : 182
difference             : 4
  knit/docs/evaluations/hybrid-retrieval.md          ← 本报告
  knit/tools/real-workspace-eval.mjs                 ← 量尺
  knit/tools/real-workspace-corpus.mjs               ← 标注
  knit/tools/semantic-request-audit.mjs              ← 隐私审计
```

**为什么评测必须排除它们**：这 4 个文件里逐字写着 24 条查询与全部依据短语，留在语料里就是
「每一条查询都能命中它」的磁铁（首跑实测：它出现在几乎每一个包的前 5 名，把真答案挤到第 7–9 位，
R@5 只有 0.354）。**先有这条修正，才有 0.479。** 反过来，隐私审计**不该**排除任何东西 ——
它要回答的是「有没有什么被发出去」，漏掉自己就失去了意义。

### A.4 五个指标的分子 / 分母 / 统计范围

全部实现在 `test/retrieval-eval.mjs`（第 33–69 行），由 `tools/real-workspace-eval.mjs` 的
`summarizeRows()` 聚合。**统计范围对五者相同**：

> **包内顺序**（`packRels()`：`primary → supporting → related`）· 语料 `kind=context`（文档 + 代码，媒体不进包）
> · `limit=40` · **全部 24 条查询，一条都不剔除** · 先算每条查询的值、再对 24 取**算术平均（macro-average）**，
> 不按文件或包长加权。

| 指标 | 分子 | 分母 | 计算方式（逐字对应代码） | 边界行为 |
|---|---|---|---|---|
| **Recall@5** | 前 5 条里命中到的标注答案数 | **该条查询的标注答案数**（`expected.length`，全语料共 30 个） | `recallAt(packRels, expected, 5) = \|top5 ∩ expected\| / \|expected\|`；再对 24 条取平均 | `expected` 为空 ⇒ 返回 **0**（不是 1）——本语料无此情况 |
| **Recall@10** | 同上，窗口换成前 10 条 | 同上 | 同上，`k=10` | 同上 |
| **MRR** | 每条查询得 1 个值：`1 / 第一条命中的名次` | 分母恒为 1（不是答案数） | `mrr(packRels, expected)`；一条都没命中 ⇒ **0**；再对 24 条取平均 | 命中在第 1 位 = 1.0，第 2 位 = 0.5，第 7 位 ≈ 0.143 |
| **命中@5 / 命中@10** | **「前 K 条里至少有一条标注答案」的查询条数** | **查询数 24** | `hitRateAt(rows, 5)`（`success@K`）；查询只要命中一条就计 1，命中几条都一样 | 这是「有没有全空」的度量，**不是**召回率 |
| **干扰项@5** | 前 5 条里出现**标注负样例**（`distractors`）的查询条数 | **查询数 24** | `distractorRateAt(rows, 5)`；一条查询踩中多个干扰项也只计 1 | 负样例是人工标注的「共享词汇但非答案」的文件 |
| （参考）**无关@5** | 前 5 条里不在 `expected` 里的条数 | **前 5 条的实际条数**（`min(5, 包长)`） | `unrelatedRateAt(packRels, expected, 5)` | ⚠️ **在本语料上不是质量指标**：标注只写「该打开的那 1–3 篇」，而包平均 7.6 条 ⇒ 分母注定很大 |

**必须一起读的两条读数**：`R@5 = 0.479` 与 `命中@5 = 0.500` 是 macro 平均；
`干扰项@5 = 0.542`（13/24）是**条数占比**。三者的分母不同（30 个答案 / 24 条查询 / 24 条查询），**不能互相换算**。

### A.5 H2 ≡ L 是不是「因为本机没有 provider」？—— 不是，是**刻意构造的回退**

这是本轮最需要说清的一条，因为两种说法听起来一样、含义完全不同：

| 说法 | 是否成立 | 依据 |
|---|---|---|
| H2 与 L 逐字一致，**由词法回退路径造成** | ✅ **成立** | H2 的引擎被配置成 `base = http://127.0.0.1:9`（一个**关着的**回环端口）+ `probeTimeoutMs: 300`（`tools/real-workspace-eval.mjs:206-207`）。探测必然失败 ⇒ `pass()` 在嵌入之前就返回 ⇒ 0 候选 ⇒ 没有任何文件被打上 `doc.semantic` ⇒ 装配结果与纯词法逐字相同 |
| H2 与 L 逐字一致，**是因为这台机器没装 Ollama** | ❌ **不成立** | H2 从头到尾**没有碰过 11434**：它用的是硬编码的端口 9。本机有没有 Ollama，对 H2 这一列**没有任何影响** |

实测证据（脚本见 §附录 F.5）：

```
provider = ollama http://127.0.0.1:11434 nomic-embed-text   ← 这一行是 H1 的配置，不是 H2 的
H2（base=http://127.0.0.1:9）：
  ×24  requested=hybrid mode=lexical available=false reason=probe-failed candidates=0
  H2 provider fetch attempts (total): 1        ← 只有探测那一次；探测失败后不再嵌入
```

- `mode=lexical` + `reason=probe-failed` + `candidates=0`：**如实回退**，没有伪装成「混合成功」。
- 只有 **1 次** provider 调用（探测结果在进程内缓存 60 s，整轮 24 条查询共用它）。
- 逐字比对的范围是：**包内 rel 顺序** + **除 `semantic` 状态行与 `sessionId`（请求参数）之外的面板载荷**
  （`stripDynamic()`，`tools/real-workspace-eval.mjs:266-271`）。`sessionId` 每条查询都不同，与检索结果无关。

**本机没有 provider 这件事，影响的是 H1（真 provider 那一列），不是 H2**：

- H1 的可用性判据是 `probeProvider(provider)`（探测 `http://127.0.0.1:11434/api/tags`，1500 ms 超时）
  返回 2xx 才跑；本轮失败 ⇒ `paths.H1 = null` ⇒ `valueEvidence = "pending (no provider)"`。

**H2 这条断言证明了什么、没证明什么**：

- ✅ 证明了：**provider 不可用时，用户拿到的结果与纯词法逐字相同**（零退化、零夹带）。
- ✅ 顺带证明了：探测失败时**一次嵌入都不发**（省钱的边界在 `pass()` 里，位置正确）。
- ❌ **没有**证明：provider 可用时 hybrid 的表现。**绝不能把 H2 ≡ L 读成「Hybrid 等于词法」** ——
  它是「Hybrid 没连上时等于词法」，这是回退承诺，不是能力结论。
- ℹ️ 另有一条**结构性**事实使这条断言在一般情况下也成立（即便有候选）：Primary / Supporting 的准入门槛
  语义条目都过不了，Related 只能追加 ⇒ L 的包永远是 H 的前缀。H2 是这条性质在「0 候选」时的**极端特例**。

## 附录 B · 真实 Provider 评测：状态、接口与可复制步骤

### B.1 两个脚本的实际接口（读代码得出，不是猜的）

| | `tools/real-workspace-eval.mjs` | `tools/hybrid-retrieval-eval.mjs` |
|---|---|---|
| 命令行参数 | `--root <dir>`（默认 = 本仓库上一级）· `--verify`（只核对标注）· `--json`（只打 JSON）· `--no-exclude`（**不要用**：会让量尺进语料） | **无参数**（只有 `import.meta.url === process.argv[1]` 的入口判断） |
| 环境变量 | `KNIT_EVAL_PROVIDER`（JSON，优先）→ `KNIT_EVAL_BASE` → `KNIT_EVAL_MODEL`（默认 `ollama` / `http://127.0.0.1:11434` / `nomic-embed-text`） | **同一套**（两处实现同源：`providerFromEnv()`） |
| 语料 | **真实工作区**（`--root`，排除 4 个评测产物） | 合成临时工作区（19 篇 / 13 条查询） |
| 路径 | `L` 词法 · `H2` 探测失败回退 · `H1` 真 provider | `L` · `H0` 确定性替身 · `H2` 回退 · `H1` 真 provider |
| H1 运行前提 | `probeProvider()` 对 `{base}/api/tags`（ollama）或 `{base}/v1/models`（openai-compatible）**在 1500 ms 内拿到 2xx** | 同 |
| 输出 | 一张人看的文本表 + **最后一行 `JSON {...}`**（`paths.L/H2/H1`、`headroom`、`checks`、`conditions`、`valueEvidence`） | 同上（`paths.L/H0/H2/H1`、`mechanismEvidence`、`valueEvidence`） |
| 退出码 | 断言全过 = 0；否 = 1（`--verify` 时只看标注） | 0（没跑通也返回 0，靠 `H1: null` 表达） |
| 副作用 | **无**：引擎用 `createSemanticEngine({ store: null })` ⇒ **不读写你的 Knit provider 配置**、不落盘；`runPath()` 收尾 `setSemanticEngine(null)`；不写工作区任何文件 | 同（`store: null`） |

> ⚠️ **`base` 里不要带 `/v1`。** 客户端会把路径拼成 `{base}/v1/embeddings`（见 §1.5），
> 填 `http://127.0.0.1:1234/v1` 会打成 `/v1/v1/embeddings` ⇒ 探测 404 ⇒ 如实回退 `probe-failed`。
> 正确写法是 `KNIT_EVAL_BASE=http://127.0.0.1:1234`。

### B.2 用户可直接复制执行的步骤

**第 0 步 · 先按查询语言选模型，再确认它真的可用**（任一失败就别往下走）

🔴 **模型的默认值不是中立的**：本语料 **24 条查询里 18 条是纯中文、0 条纯英文**（分布与依据见 §附录 G.1）。
所以**不要**拿 `nomic-embed-text`（英文优先的默认示例）直接当基线，除非你有意做「英文模型 vs 多语言模型」的对照。

```sh
# 0a) 选模型：本语料请用**明确声明多语言**的那一档（核实记录见 §附录 G.3）
MODEL=bge-m3                 # 或 qwen3-embedding:0.6b

ollama --version
ollama list | grep -i "$MODEL" || ollama pull "$MODEL"

# 探测端点（Knit 的 probe 打的就是它）
curl -sS -m 5 -o /dev/null -w 'api/tags HTTP %{http_code}\n' http://127.0.0.1:11434/api/tags

# 嵌入端点 + 请求形状（Knit 的 embed 打的、发的就是它）—— 用**中文**探针，和语料同语言
curl -sS -m 30 http://127.0.0.1:11434/api/embed \
  -H 'content-type: application/json' \
  -d "{\"model\":\"$MODEL\",\"input\":[\"缓存失效策略\"]}" | head -c 200; echo
```

**两次模型分别评测的纪律**（做对照时照这个来，**不许把两轮数字混在一起**）：

```sh
cd knit
for MODEL in bge-m3 qwen3-embedding:0.6b; do
  KNIT_EVAL_BASE=http://127.0.0.1:11434 KNIT_EVAL_MODEL="$MODEL" \
    node tools/real-workspace-eval.mjs 2>&1 | tee "/tmp/knit-real-$MODEL.txt"
  tail -1 "/tmp/knit-real-$MODEL.txt" | sed 's/^JSON //' > "/tmp/knit-real-$MODEL.json"
done
```

每一轮都要**单独记录**：模型名（JSON 的 `paths.H1.provider.model` 与 `conditions.provider.model`）、
`gitHead`、`corpusDocs`、日期。报告里两张表分开列，**不许取平均，也不许只留跑得好的那一张**。

判据：`api/tags` 回 **200**；第二条回一个含 `"embeddings"` 的 JSON（数组非空）。
失败判定：连接被拒 / 超时 / `model not found` ⇒ **停在这里**，把失败输出记下来，不要继续也不要编数字。

**第 1 步 · 确认真请求真的出门了（不是 Mock、不是回退）**

```sh
# 见 B.3 的脚本；先写到 /tmp（**不要写进工作区**，理由见附录 A.3）
cd knit && node /tmp/h1-row-inspector.mjs
```

判据（**必须同时满足**）：
- 汇总行里出现 `mode=hybrid`（至少一条查询）；
- `total provider calls` ≥ 2（探测 1 + 查询 1；文档批每轮最多再加 1）；
- 逐行 `candidates` 有非 0 值。

**反面判据同样有效**：若 24 行全是 `mode=lexical` + `reason=probe-failed|timeout|bad-response`，
那说明**真的没打通**（这**不是** Mock 结果，是真实失败），此时**不得**报告任何召回数字。

**第 1b 步 · 在 Provider 侧留痕（最硬的旁证，可选）**

```sh
# 另开一个终端重启 Ollama 并打开调试日志；跑评测时这里会打出每一次请求
OLLAMA_DEBUG=1 ollama serve
```

**第 2 步 · 两条量尺各跑一次，**同一次进程内**对比**

```sh
cd knit

# 真实工作区（L vs H1）
node tools/real-workspace-eval.mjs 2>&1 | tee /tmp/knit-real.txt
tail -1 /tmp/knit-real.txt | sed 's/^JSON //' | python3 -m json.tool > /tmp/knit-real.json

# 合成语料（L vs H0 替身 vs H2 回退 vs H1 真 provider）
node tools/hybrid-retrieval-eval.mjs 2>&1 | tee /tmp/knit-synth.txt
tail -1 /tmp/knit-synth.txt | sed 's/^JSON //' | python3 -m json.tool > /tmp/knit-synth.json
```

判据：`/tmp/knit-real.json` 里 `paths.H1` **不为 null**、`paths.H1.providerCalls > 0`、
`valueEvidence` 不再是 `"pending (no provider)"`。

**第 3 步 · 记录调用次数 / 延迟 / 错误 / 实际召回**

| 要记的 | 从哪拿 | 字段 |
|---|---|---|
| provider 调用次数 | H1 的计数 fetch（包的是**全局 `fetch`**，所以数是真网络调用） | `paths.H1.providerCalls` |
| 墙钟延迟 | `runPath()` 的前后时间差 | `paths.H1.wallMs`（与 `paths.L.wallMs` 同一次运行） |
| 召回 | 与 L 同一份 JSON 内对比 | `paths.H1.metrics.{recall5,recall10,mrr,hit5,hit10,distractor5}` |
| 「补回了哪些标注答案」 | 追加项 ∩ 标注答案 | `paths.H1.rescued` |
| 「新增结果里的无关比例」 | 追加项 − 标注答案 | `paths.H1.appendedUnrelated / paths.H1.appendedTotal` |
| 失败 / 超时 | 逐行看 `mode` 与 `reason`（见 B.3 的脚本） | `requested/mode/available/reason/candidates` |

> ⚠️ **已知工具缺口（本轮发现，未修）**：`real-workspace-eval.mjs` 的「逐条明细」打印的是 **L 行**的语义状态
> （源码里是 `l.semantic`），H1 / H2 的**逐行** `mode/reason` 目前只能靠 B.3 的脚本看。
> 聚合层的数字（`paths.H1.*`）不受影响。

**第 4 步 · 确认「三次同一」，否则数字不可比**

```sh
python3 - <<'PY'
import json
j = json.load(open('/tmp/knit-real.json'))
c = j['conditions']
print('语料篇数   ', c['corpusDocs'])          # 期望 182（如果工作区没增删文件）
print('查询条数   ', c['queries'])             # 期望 24
print('语料版本   ', j['corpusVersion'])       # 期望 1
print('kind/sort/limit', c['kind'], c['sort'], c['limit'])   # context / relevance / 40
print('gitHead    ', j['gitHead'])             # 必须与你报告里写的那个一致
print('provider   ', c['provider'])
print('valueEvidence', j['valueEvidence'])
PY
```

- **同一语料**：`conditions.corpusDocs` + `node tools/real-workspace-eval.mjs --verify` 退出码 0（标注自洽）。
- **同一查询集合**：`conditions.queries = 24`、`corpusVersion = 1`、`corpusBaseline`（含标注日期与当时的 HEAD）。
- **可比配置**：`conditions.kind/sort/limit` + `gitHead` + `pluginVersion`。
- 🔴 **L 与 H1 必须在同一次运行里比**：`rankByRelevance(pool, keywords, now)` 叠了 10% 的时间新鲜度微调，
  `now = Date.now()` ⇒ **跨进程对比会抖**（实测同一命令在 3 分钟间隔的两次运行里 `干扰项@5` 出现过 13/24 与 14/24）。
  同一次进程内的 L 与 H2/H1 不受影响，这就是 `A2 = 逐字一致` 可靠的原因。

### B.3 逐行检查脚本（复制到 `/tmp` 再跑；故意不放进 `knit/tools/`）

```js
// /tmp/h1-row-inspector.mjs  —— 逐条查看「这一轮到底走了哪条路」
import { scan, setSemanticEngine } from '<仓库>/knit/src/host/index.js'
import { createSemanticEngine } from '<仓库>/knit/src/host/semantic.js'
import { QUERIES } from '<仓库>/knit/tools/real-workspace-corpus.mjs'

const root = process.env.KNIT_EVAL_ROOT || '<工作区根>'
const provider = (() => {
  const raw = process.env.KNIT_EVAL_PROVIDER
  if (raw) { try { const p = JSON.parse(raw); if (p && p.kind && p.base && p.model) return p } catch {} }
  return { kind: 'ollama',
    base: process.env.KNIT_EVAL_BASE || 'http://127.0.0.1:11434',
    model: process.env.KNIT_EVAL_MODEL || 'nomic-embed-text' }
})()

let calls = 0
const countingFetch = async (url, init) => { calls += 1; return fetch(url, init) }
const engine = createSemanticEngine({ store: null, fetchImpl: countingFetch })   // store:null ⇒ 不碰你的配置
await engine.configure(provider)
setSemanticEngine(engine)

const tally = new Map()
for (const q of QUERIES) {
  const session = { header: { cwd: root, id: 'h1inspect' },
    snapshotEvents: () => [{ seq: 1, type: 'user/message',
      data: { role: 'user', content: [{ type: 'text', text: q.query }], source: { kind: 'user' } } }] }
  const before = calls
  const p = await scan(root, 40, { session, sessionId: `h1-${q.id}`, sort: 'relevance', kind: 'context', retrieval: 'hybrid' })
  const s = p.semantic || {}
  const key = `requested=${s.requested} mode=${s.mode} available=${s.available} reason=${s.reason} candidates=${s.candidates}`
  tally.set(key, (tally.get(key) || 0) + 1)
  console.log(`${q.id.padEnd(24)} mode=${String(s.mode).padEnd(8)} candidates=${String(s.candidates).padStart(3)} calls=${calls - before} reason=${s.reason || '-'}`)
}
setSemanticEngine(null)
console.log(`total provider calls = ${calls}`)
for (const [k, v] of tally) console.log(`  ×${v}  ${k}`)
console.log([...tally.keys()].some((k) => k.includes('mode=hybrid'))
  ? '✅ 至少有查询真的走了 hybrid —— 真 provider 生效。'
  : '❌ 没有任何查询走到 hybrid —— 全部回退；上面的 reason 就是原因（不是 Mock）。')
```

（把两处 `<仓库>` / `<工作区根>` 换成绝对路径即可。**要让它常驻**，应当把它放进 `knit/tools/`，
**同时**把它的路径加进 `real-workspace-eval.mjs` 的 `EVAL_ARTIFACTS` —— 否则每多一个文件，
量尺的语料就多一篇，182 这个口径就不复现了。）

### B.4 当前的阻塞项（不是「已完成」）

| 阻塞 | 实测 | 谁能解 |
|---|---|---|
| 没有可用的本地 embedding 服务 | `curl -m 3 http://127.0.0.1:11434/api/tags` 无响应；`which ollama` 为空；环境里没有任何 `KNIT_EVAL_*` / `OPENAI*` / `EMBED*` 变量 | **只有用户**（明令禁止擅自安装远端服务） |
| 因此 H1 未跑 | 两个脚本都输出 `H1: null`、`valueEvidence: "pending (no provider)"`；如实跳过，不用替身数字顶替 | 同上 |
| 缺少真实的「新增候选无关比例」 | 该指标依赖 H1 的 `appendedUnrelated`，本轮无值 | 同上 |

**完成标准（跑完这一段才算「真实 Hybrid 评测已完成」）**：
① `real-workspace-eval.mjs` 的 `paths.H1` 非 null 且 `providerCalls > 0`；
② `hybrid-retrieval-eval.mjs` 的 `paths.H1` 非 null；
③ 两条命令的输出（含最后一行 JSON）被原样保留；
④ 报告里能写出：L vs H1 的 R@5 / MRR / 命中@5 对比、`rescued / 14`、
   以及 `appendedUnrelatedRate = appendedUnrelated / appendedTotal`。

## 附录 C · 验收台 15 条独立取证清单

> **用法**：逐条独立核验，**不要因为「报告里写了」就判通过** —— 每条都给了可执行命令；
> 命令跑不通或结果不符即判**未通过**（而不是「无法判定」）。
> 所有命令都在 `cd knit` 下执行（除注明者）。**这些命令只读：不写工作区、不发外部请求、不改配置。**

---

**AC-01 先核实仓库真实状态再开展工作**
- 目标：报告里的版本 / 分支 / 干净度是实测的，而不是沿用旧文档。
- 证据：本报告开头表格；`git log` 输出沿用自 `git -C knit log --oneline -6`。
- 核验：`git rev-parse --abbrev-ref HEAD && git log --oneline -3 && node -e "console.log(require('./package.json').version)"`
- 预期：`main` / 顶部提交 `b164d8e` / 版本 `0.23.1`。
- **失败判定**：分支或版本对不上；或报告声称的 HEAD 与实际不符。
- ⚠️ 注意：开工时 `git status --porcelain` 为**空**（用户没有未提交的工作）；现在不为空是**本轮自己的改动**造成的 ——
  判据是「未提交工作有没有被覆盖」，见 AC-14。

**AC-02 Hybrid 增加候选结果的位置**
- 目标：指出具体函数 / 文件 / 行号。
- 证据：报告 §1.2；源码 `src/host/index.js:1776-1785`（算候选）与 `:1792-1795`（只打标）。
- 核验：`grep -n "semanticPassFor\|doc.semantic = true" src/host/index.js`
- 预期：两处命中，行号与报告一致（1776 / 1794 附近）。
- **失败判定**：`grep` 找不到，或行号与报告相差过大（说明报告是旧快照）。

**AC-03 只补 Related 层、不动 Primary / Supporting / 基础排序**
- 目标：结论可对照实现验证。
- 证据：报告 §1.3；`src/host/context.js:415`（`hit` 门槛）、`:426`（`semanticOnly` 单独收）、`:595-600`（最后追加）。
- 核验：`node --test test/hybrid-retrieval.test.mjs`（12 项，含判据 2 / 2c / 3b）
- 预期：12 pass / 0 fail。
- **失败判定**：有 fail；或「主要 / 辅助两层不许变」的断言缺失（用 `grep -n "判据 2" test/hybrid-retrieval.test.mjs` 复核）。

**AC-04 Provider 的入口 / 配置 / 超时 / 回退**
- 目标：报告列出入口函数、配置来源、超时值与回退行为的具体位置。
- 证据：报告 §1.4 表格；`src/host/semantic.js`（`createSemanticProvider` :149、引擎 :306、`pass()` :389、超时常量 :46-47）。
- 核验：`grep -n "SEM_PROBE_TIMEOUT_MS\|SEM_EMBED_TIMEOUT_MS\|async pass(" src/host/semantic.js`
      并 `node --test test/semantic.test.mjs`
- 预期：超时 1500 / 8000，`pass()` 在 389 行；16 pass / 0 fail。
- **失败判定**：常量值或函数位置与报告不符。

**AC-05 实际发往远端的字段（正文 / 绝对路径不外泄）**
- 目标：给出请求体构造处的代码证据 + 明确字段清单，并说明是否含正文 / 绝对路径。
- 证据：报告 §2；审计脚本 `tools/semantic-request-audit.mjs`（9 条硬断言）。
- 核验：`node tools/semantic-request-audit.mjs; echo "exit=$?"`
- 预期：`exit=0`；9 条全 ✅（C1 顶层字段只有 `model`+`input`；C2 无绝对路径；C4 无成片正文；
  C6 **披露查询原话也发**；第三节写明 Markdown 摘要是正文节选 ≤60 字）。
- **失败判定**：任一断言 ❌，或退出码非 0；或报告只写「不发正文」而不提查询原话与摘要来源（那就是半真话）。
- ⚠️ 该脚本的「语料篇数」会随工作区文件数变化，**变的只是篇数，不是断言**。

**AC-06 Ollama / loopback / OpenAI-compatible 的处理差异**
- 目标：给出各分支的判定条件与行为差异。
- 证据：报告 §1.5 对照表。
- 核验：`grep -n "api/tags\|/v1/models\|api/embed\|/v1/embeddings" src/host/semantic.js`
      并 `grep -n "isLoopbackBase" src/host/semantic.js src/client/client.js`
- 预期：四个端点各自命中；`isLoopbackBase` 在客户端被用于**披露文案**，
  宿主侧**不因 loopback 而改变行为**（报告明确写了这一点）。
- **失败判定**：报告暗示 loopback 有额外的运行时保障（那是错的）。

**AC-07 区分「已证实 / 只是 Mock / 缺真 provider 验证」**
- 目标：报告列出具体测试文件与断言范围，并指明哪些依赖 Mock。
- 证据：报告 §1.6 表格。
- 核验：`node --test test/semantic.test.mjs test/hybrid-retrieval.test.mjs test/hybrid-eval.test.mjs`
- 预期：16 + 12 + 6 = **34 pass / 0 fail**；报告如实写明这三份全部用注入的假 fetch，
  且 **H1 从不进 CI**、OpenAI 兼容的**请求体**没有被断言。
- **失败判定**：报告把 Mock 结果说成真实 provider 证据。

**AC-08 可复现的最小评测工具 + 15–30 条人工标注样例**
- 目标：仓库内存在评测脚本与标注数据；含精确关键词 / 同义概念 / 负样例；命令可复现。
- 证据：`tools/real-workspace-corpus.mjs`（24 条：exact 7 / synonym 12 / negative 5）、`tools/real-workspace-eval.mjs`。
- 核验：`node tools/real-workspace-eval.mjs --verify --json; echo "exit=$?"` 然后
      `node -e "import('./tools/real-workspace-corpus.mjs').then(m=>console.log(m.QUERIES.length))"`
- 预期：`exit=0`；条数 = 24（落在 15–30 区间）；每条答案都有一条能 grep 到的依据。
- **失败判定**：`--verify` 非 0；或条数出界；或存在没有依据的标注。

**AC-09 指标覆盖 Recall@5 / MRR / 命中率 / 新增结果无关比例**
- 目标：评测输出包含这些指标。
- 证据：报告 §3.2 与 A.4；`tools/real-workspace-eval.mjs` 的指标表。
- 核验：`node tools/real-workspace-eval.mjs | sed -n '/一、指标/,/二、代价/p'`
- 预期：表头含 `R@5 R@10 MRR 命中@5 命中@10 无关@5 干扰项@5 平均包长`。
- **失败判定**：缺项；**或报告用替身 / 模拟数字充当「Hybrid 新增结果的无关比例」**。
  本轮该指标**无值**（没有 provider），报告必须写明是 `pending`，写「0」也算失败。

**AC-10 单独统计 Hybrid 新找回的相关文件，不包装成整体提升**
- 目标：输出区分 lexical-only 与 hybrid 新增。
- 证据：报告 §3.3、A.2；JSON 的 `headroom.detail[].foundByHybrid`。
- 核验：`node tools/real-workspace-eval.mjs --json | tail -1 | sed 's/^JSON //' | python3 -c "import json,sys; j=json.load(sys.stdin); print(j['headroom']['queriesWithMiss'], j['headroom']['missedTotal'], j['headroom']['missedZeroHit']); print({h['id']: h['foundByHybrid'] for h in j['headroom']['detail']})"`
- 预期：`10 14 4`；且**每个 `foundByHybrid` 都是 `null`**（= 没测过，不是「一条没救回」）。
- **失败判定**：报告把 14 条「未找回」表述成「Hybrid 会找回」或写成整体召回提升。

**AC-11 记录延迟 / 调用次数 / 超时 / 失败回退，仅在数据可靠时报告成本**
- 目标：这些运行时可观测项有输出，并标注不可得的项。
- 证据：报告 §3.2 的「代价」表、A.5 的 H2 实测。
- 核验：`node tools/real-workspace-eval.mjs | sed -n '/二、代价/,/三、断言/p'`
- 预期：`L: 0（默认零调用）`；`H2: 1`；H1 行**不出现**（没跑）。
- **失败判定**：给 L 报出非 0 调用；或给 H1 编一个延迟 / 调用数。

**AC-12 校准 README（中英）/ package.json / CHANGELOG / 市场介绍**
- 目标：逐项核对结论 + 已修改文件；无外部权限时产出可直接提交的修订稿且不声称已更新。
- 证据：报告 §4；`03_发布/市场条目文案-v0.23.1.md`。
- 核验：`git diff --stat -- README.md README.en.md package.json SECURITY.md`
      并 `grep -n "混合模式到底发出去了什么" README.md; grep -n "What hybrid mode actually sends" README.en.md`
      再 `node -e "console.log(require('./package.json').description.length)"`
- 预期：4 个文件被改；两个小节标题命中；描述长度 **249**（< npm 的 255 截断线）。
- **失败判定**：宣称已更新市场页面（**没有**，也做不到）；或描述长度 > 255（会被再次截断）。

**AC-13 报告文件存在且含版本 / 配置条件 / 命令 / 结果 / 未验证事项**
- 证据：`docs/evaluations/hybrid-retrieval.md`。
- 核验：`wc -l docs/evaluations/hybrid-retrieval.md` 并
      `grep -c "尚未验证\|pending\|未验证" docs/evaluations/hybrid-retrieval.md`
- 预期：文件存在；含「五、尚未验证 / 阻塞与下一步」一节与 `valueEvidence: pending`。
- **失败判定**：文件缺失；或没有任何「未验证」标注（那就说明报告在装完成）。

**AC-14 不改业务代码 / 测试、不发布、不升版本、不新增搜索模式或 UI**
- 目标：`src/` 与 `test/` 零改动；版本号不变；无发布动作。
- 证据：`git status --porcelain` / `git diff --stat`。
- 核验：
  ```sh
  git status --porcelain
  git diff --stat -- src test            # 期望：空
  git diff --stat                        # 期望：只有 README*.md / package.json / SECURITY.md
  node -e "console.log(require('./package.json').version)"   # 期望 0.23.1
  git tag --points-at HEAD                                     # 期望：空（没打新 tag）
  npm test                                                     # 期望 775 pass / 0 fail
  ```
- 预期：如上；另 `package.json` 的 `scripts.test` **逐文件枚举未变**（33 个文件）。
- **失败判定**：`src/` 或 `test/` 出现 diff；版本号变了；新增了 tag / Release；`scripts.test` 被改。
- ℹ️ 允许出现的新增文件只有：`tools/` 下 3 个评测脚本、`docs/evaluations/hybrid-retrieval.md`、
  以及工作区层的 `03_发布/市场条目文案-v0.23.1.md`。**它们在 `git status` 里应显示为 `??`。**

**AC-15 「是否值得继续投入」与未决事实的结论**
- 目标：结论明确、且未决事实被列出。
- 证据：报告 §7；最终回复的「一页结论」。
- 核验：人工阅读，对照三条判据：① 是否明确说了「机制成立但收益未验证」；
  ② 是否列出市场文案要改的四处；③ 是否列出不能下结论的事实（至少含「语义检索价值」与「14 个头寸能救回几个」）。
- **失败判定**：出现「Hybrid 提升了召回率」这类没有证据的断言。

---

### C.1 确认这些验收项本身

- 这 15 条已经登记为验收契约（任务 `task-mv5zcblu-vckaya`），但**状态是「未确认」**：
  验收台要求**由用户先确认**这 15 条，才会发起独立取证。
- 确认后可以只授权其中若干条（例如先做 AC-05 / AC-08 / AC-14 这三条最硬的），
  **不必一次全过**，也不要在确认时就预设「已通过」。
- 确认动作本身**不修改任何数据**：取证命令全部只读、不发布、不访问未授权外部服务
  （唯一会出网的是 `curl` 市场索引与 npm registry，属公开只读接口）。

## 附录 D · 第一阶段收尾记录（按证据强度分级）

### D.1 已由真实证据支持（可当场重跑，且我已跑过）

| 结论 | 证据类型 | 复现命令 |
|---|---|---|
| 仓库真实状态：`knit/` 是独立 git 仓库、分支 `main`、开工时工作区干净、版本 `0.23.1`、HEAD `b164d8e` | 命令实测 | 见 §附录 F.1 |
| Hybrid 只有一处候选注入点（`index.js:1776-1785`）+ 一处标记点（`:1792-1795`） | 源码 + grep | `grep -n "semanticPassFor\|doc.semantic = true" src/host/index.js` |
| 语义候选**只可能**进「相关」层，且最后追加、名额不足时第一个被挤掉 | 源码（结构性）+ 测试 | `node --test test/hybrid-retrieval.test.mjs` |
| provider 不可用时，hybrid 结果与词法**逐字一致**（包内顺序 + 除状态行外的载荷） | 命令实测 24/24 | `node tools/real-workspace-eval.mjs`（断言 A2） |
| 默认词法路径 **0 次** provider 调用 | 命令实测 | 同上（断言 A1） |
| **发往远端的字段**：请求体只有 `{model, input}`；无绝对路径；无成片正文；代码发的是工作区相对目录 | 报文级实测（录音 fetch，186/186 篇覆盖，9 条断言全过） | `node tools/semantic-request-audit.mjs` |
| **披露项**：用户查询原话本身也发（每轮重发）；Markdown 的「摘要」是正文首段 ≤60 字节选；图片 / 视频发的是文件名 | 同上（C6 + 第三 / 四节） | 同上 |
| 真实工作区词法基线：`R@5 0.479 / R@10 0.583 / MRR 0.275 / 命中@5 0.500 / 干扰项@5 0.542`（24 条查询、182 篇） | 命令实测 | `node tools/real-workspace-eval.mjs` |
| 14 个标注答案词法未找回（10 条查询、其中 4 个零命中） | 命令实测 + 可追溯清单 | 同上；清单见 §A.2 |
| 标注自洽：24 条查询 / 30 条答案 / 55 条干扰项，每条依据都能 grep 到 | 命令实测 | `node tools/real-workspace-eval.mjs --verify` |
| 182 vs 186 的差异**恰好**是 4 个评测自身产物 | 命令实测（两次 scan 求差集） | 见 §附录 F.4 |
| H2 ≡ L 由**刻意构造的探测失败**造成（`127.0.0.1:9`），**与「本机没装 Ollama」无关** | 源码 + 命令实测（24/24 `reason=probe-failed`，provider 调用 1 次） | 见 §附录 F.5 |
| npm 上 `description` 被截断在 255 字（21 个已发版本里 17 个恰好 255 字，最早 0.11.0） | registry 实测 | `curl -s https://registry.npmjs.org/dsh-knit \| node -e "…"` |
| 市场条目仍是 v0.19.1 之前的口径、`version` 字段 0.22.0、第三张截图是已删除的「全部」档 | 站点索引 + 上游 yml + PR 状态实测 | `curl -s https://awesome-dsh-plugin.com/plugins.json`；`gh pr view 6760 …` |
| 改动没有碰 `src/` 与 `test/`、版本号未变、测试仍 775/775、净室闸门 775/0 | 命令实测 | `git diff --stat -- src test`；`npm test`；`node tools/clean-room-test.mjs` |

### D.2 已有自动化测试支持，但缺少运行环境验证

| 结论 | 测试依据 | 缺什么 |
|---|---|---|
| 两种协议的 URL / 响应形状 / 失败三态 / 有界嵌入 / 缓存失效 | `test/semantic.test.mjs`（16 项，全用注入假 fetch） | **从没打过一次真网络**；OpenAI 兼容那条路的**请求体**也没有断言（只断言 URL 与形状） |
| 语义条目只进相关层、被排除的文件不可能经语义回来、零命中条目进得了包 | `test/hybrid-retrieval.test.mjs`（12 项） | 同上：假 provider（任何输入回 `[1,0]`） |
| 四路径消融：H2 与 L 面板载荷逐字一致、H0 只追加、标注样本被补回、每轮调用 ≤3 | `test/hybrid-eval.test.mjs`（6 项） | 嵌入是**为那份合成语料手写的加权同义词表**，不是模型 ⇒ 只能证明管道 |
| 写通道只认 POST / 只回环 / 坏 body 400 | 对 `/api/control` 有真回环 e2e；对 `/api/semantic` **只有客户端侧断言** | `SECURITY.md:41` 自己标着 ⚠️：`/api/semantic` 的宿主侧 e2e 尚未补 |
| `kind=media` 时语义通道会跑但没有消费者 | 无（本轮才发现的代码事实，见 §2.1a） | 需要一条「`kind=media` 时零 provider 调用」的守卫才有测试支持 |

### D.3 尚未验证（明确为空，不是「没问题」）

1. **语义检索有没有收益** —— H1 从未跑过。`valueEvidence: "pending (no provider)"`。
2. **真模型下新增候选里的无关比例** —— 依赖 H1 的 `appendedUnrelated`，本轮无值。
3. **14 个头寸里真模型能救回几个** —— `headroom.detail[].foundByHybrid` 全部为 `null`（没测过）。
4. **真实延迟 / 单轮成本** —— 只采到了「没有 provider 时」的墙钟（L 583 ms / H2 539 ms，24 条查询一次跑完），
   它**不能**外推为「开着 provider 也这么快」。
5. **`kind=media` 白花调用在真实使用中的占比** —— 代码事实已确认（§2.1a），影响面未量。
6. **改后的文案在 npm 页与市场页上的实际呈现** —— 需要发版 / 站点重建，本轮禁止。
7. **市场 `capabilities` 里的 `shell` 该不该改** —— 归因规则不由我们定。

### D.4 需要用户执行的动作（按优先级）

| # | 动作 | 命令 / 位置 | 为什么只有你能做 |
|---|---|---|---|
| 1 | **在验收台确认那 15 条验收项**（可只授权其中几条） | 验收台任务 `task-mv5zcblu-vckaya` | 确认动作需要人；未确认前不会发起独立取证 |
| 2 | **起本机 embedding 服务并跑 H1** | 见 §附录 B.2 第 0–4 步 | 明令禁止 agent 擅自安装远端服务 |
| 3 | 决定是否修 §2.1a 的 `kind=media` 问题（要动行为 + 加测试 + 版本号） | — | 属功能决策，超出本阶段授权 |
| 4 | 决定是否补 `/api/semantic` 的宿主侧 e2e、OpenAI 路径的 body 断言 | — | 会让测试数从 775 变化 ⇒ 要同步改 `AGENTS.md` 的 `--strict` 用量断言 |
| 5 | 授权后才动市场：撤掉过期截图（改 `knit/screenshots.json`）+ 提 description PR + 关闭 #6760 | `03_发布/市场条目文案-v0.23.1.md` §四 | §11 规则 7：对外动作必须现拿授权 |
| 6 | 下次发版时带上 README / 描述 / SECURITY 的新口径，并在那一版 CHANGELOG 里记一笔 | — | 发版不由 agent 执行 |

## 附录 E · 两处工具缺口（**已于 2026-10-13 修复并复评 —— 见 §附录 H**）

1. **`tools/hybrid-retrieval-eval.mjs` 的 H2 provider 调用数是假的 0。**
   第 68–71 行：引擎拿到的是**裸 `fetch`**（`createSemanticEngine({ …, fetchImpl: fetch })`），
   而计数器包的是另一个函数（`const deadFetch = countingFetch(fetch)`）—— 计数对象从没被调用过。
   于是它打出 `H2 provider 调用 = 0`，而真实至少是 1（探测那次）。
   修法（一行顺序调整）：**先** `const deadFetch = countingFetch(fetch)`，**再**把它传给引擎。
   ⚠️ **不影响本轮任何结论**：报告里 H2 = 1 次调用取自
   `tools/real-workspace-eval.mjs`，那一处的传参是**正确**的（先建计数 fetch，再给引擎）。
2. **`tools/real-workspace-eval.mjs` 的逐条明细只打印 L 行的语义状态。**
   源码里那两行是 `l.semantic`，所以 24 行恒为 `mode=lexical reason=-`；
   H1 / H2 的**逐行** `mode/reason` 没有输出（聚合层 `paths.H1/H2` 不受影响）。
   ⇒ 用户跑真 provider 时，需要 §B.3 的脚本才能逐条确认「真的走了 hybrid」。

> ✅ **2026-10-13 状态更新**：上面两条**已修**（`tools/`，用户在本轮指令里明确授权修评测工具）。
> 修复内容、前后 blob 哈希、指标复评（逐位未变 + 24/24 包序列一致）、新增的 `--selftest`
> 与一次**证伪**记录，全在 **§附录 H**。`npm test` 仍是 **775/775**（自测住 `tools/`，不进 `test/`）。
> 本附录正文保留为「修之前长什么样」的记录，不改写。

## 附录 F · 原始运行记录（原样保留，未做任何改写）

> 采集时间：2026-10-13 09:39–09:40（Asia/Shanghai）· 工作区 `/Users/zhongwentuo/DeepSeek Harness Native/08_Knit`
> · 插件版本 `0.23.1` · HEAD `b164d8e`（工作区含本轮未提交的改动）。
> 下面每一块都是命令的**原样输出**，没有重新排版，也没有为了对齐而修改数字。

### F.1 测试基线

```text
$ cd knit && npm test
ℹ tests 775
ℹ suites 0
ℹ pass 775
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 2648.293792
```

### F.2 真实工作区量尺 · 完整 stdout

```text
$ cd knit && node tools/real-workspace-eval.mjs
Knit · 真实工作区检索评测
  插件版本   0.23.1（git b164d8e）
  工作区     /Users/zhongwentuo/DeepSeek Harness Native/08_Knit
  语料       182 篇（扫描 5 ms；已排除 4 个评测自身产物 —— 见 A5）
  语料版本   v1（标注于 2026-10-13，当初 工作区 = 打包机上的 08_Knit；扫描结果 182 篇（md 96 / 代码 86））
  查询       24 条（精确 7 / 同义 12 / 负样例 5）
  provider   不可用（探测 http://127.0.0.1:11434 失败）⇒ H1 跳过

── 一、指标（按包内顺序；命中率 = 至少一条标注答案进前 K 的查询占比）──
路径                 R@5    R@10   MRR    命中@5   命中@10  无关@5   干扰项@5  平均包长
-----------------  -----  -----  -----  -----  -----  -----  -----  ----
L   词法（默认）         0.479  0.583  0.275  0.500  0.583  0.892  0.542  7.6 
H2  hybrid + 探测失败  0.479  0.583  0.275  0.500  0.583  0.892  0.542  7.6 

── 二、代价 ──
路径  墙钟 ms  provider 调用
--  -----  -----------
L   584    0（默认零调用）   
H2  540    1          

── 三、断言 ──
  ✅ A1  词法路径一次 provider 调用都不发
        L 的 provider 调用 = 0
  ✅ A2  回退诚实：provider 探不通时，hybrid 的包与面板载荷与词法**逐字一致**
        24 条查询逐条比过（包内顺序 + 除状态行外的载荷）
  ✅ A3  标注自洽：每个答案文件都在语料里、都有一条能 grep 到的依据
        24 条查询 / 30 条答案 / 55 条干扰项，逐条核对通过
  ✅ A4  L 与 H2 的包长逐条相同（回退不改变包的大小）
        逐条比过
  ✅ A5  评测产物（语料 / 量尺 / 报告）没有进任何一层
        已排除 4 个路径（经 scan() 的 excluded 参数，先于检索生效）

── 三·五、干扰项是谁在骗到前 5 名 ──
  ×2   knit/CHANGELOG.md
  ×2   03_发布/发布清单-v0.23.0.md
  ×1   knit/test/control.test.mjs
  ×1   knit/test/deep-context.test.mjs
  ×1   knit/src/host/tool.js
  ×1   knit/test/classification.test.mjs
  ×1   AGENTS.md
  ×1   knit/test/hybrid-retrieval.test.mjs
  ×1   99_暂存文档/01_ Knit PRD-历史版本/Knit-v0.23-方案-可选混合检索.md
  ×1   03_发布/分发基线-2026-09-21.md
  ×1   99_暂存文档/01_ Knit PRD-历史版本/Knit-v0.23-实现与基准报告.md
  ×1   knit/test/retrieval-eval.mjs
  ×1   knit/test/security.test.mjs
  ⇒ 干扰项@5 = 0.542（13/24 条查询的前 5 名里有标注的干扰项）
  ⚠️ 「无关@5」在这份语料上**不是检索质量指标**：标注只写「该打开的那 1–3 篇」，
     而包平均 7.6 条 —— 分母注定很大。要看质量请看 命中@5 / R@5 / MRR 与上面的干扰项明细。

── 四、语义通道的头寸（词法没找回的标注答案）──
  10 条查询有 14 个标注答案没被词法找回（待验证的机会，**不是**收益）
  · [exact] 「重启后复用索引 内容指纹 有界对账」
      未找回：knit/src/host/index-store.js（有命中但没进包）
  · [synonym] 「相关层名额不够的时候谁让位」
      未找回：knit/src/host/context.js（零命中）
  · [synonym] 「两个代码文件之间的依赖是怎么看出来的」
      未找回：knit/src/host/relations.js（零命中）
  · [synonym] 「语义候选加在哪里 会不会动主要层」
      未找回：knit/src/host/semantic.js（有命中但没进包）、knit/src/host/context.js（有命中但没进包）
  · [synonym] 「开了语义检索以后 我的文件内容会不会被传出去」
      未找回：knit/src/host/semantic.js（零命中）
  · [synonym] 「连不上 embedding 服务会怎么样」
      未找回：knit/src/host/semantic.js（有命中但没进包）、knit/test/semantic.test.mjs（有命中但没进包）
  · [synonym] 「为什么读过的历史不会再变」
      未找回：knit/src/host/feedback.js（有命中但没进包）
  · [synonym] 「怎么证明发出去的包里测试也跑得通」
      未找回：knit/tools/clean-room-test.mjs（零命中）
  · [negative] 「混合检索的收益证据到哪一步了」
      未找回：knit/README.md（有命中但没进包）、knit/tools/hybrid-retrieval-eval.mjs（有命中但没进包）
  · [negative] 「为什么列表不会被五秒轮询拽回去」
      未找回：knit/AGENTS.md（有命中但没进包）、knit/src/client/client.js（有命中但没进包）

── 五、逐条明细 ──
✓ [exact] 「BM25 字段权重 长度归一化」
     包：01_ Knit PRD/Knit-v0.20-Phase0-审计.md | 99_暂存文档/01_ Knit PRD-历史版本/Knit_SDD-v0.6-相关性排序质量.md | 01_ Knit PRD/Knit-PRD.md | knit/test/eval/fixture.mjs | knit/tools/scale-benchmark.mjs | knit/test/context/fixture.mjs | knit/src/host/relevance.js | knit/README.md | 99_暂存文档/01_ Knit PRD-历史版本/Knit_PRD-v0.6-相关性排序质量.md
     标注答案：knit/src/host/relevance.js[有]
     语义状态：mode=lexical candidates=0 reason=-
✓ [exact] 「排除在检索之前生效」
     包：99_暂存文档/01_ Knit PRD-历史版本/Knit-v0.23-方案-可选混合检索.md | 99_暂存文档/01_ Knit PRD-历史版本/Knit-v0.21-实现说明-关系与上下文控制.md | knit/test/control.test.mjs | knit/README.md | knit/src/host/control.js | knit/CHANGELOG.md | 01_ Knit PRD/Knit-PRD.md | README.md | 01_ Knit PRD/Knit-SDD.md
     标注答案：knit/src/host/control.js[有]
     语义状态：mode=lexical candidates=0 reason=-
✓ [exact] 「片段 行号 偏移量 1 起算 两端都含」
     包：knit/src/host/passage.js | knit/src/host/relations.js | knit/CHANGELOG.md | knit/test/deep-context.test.mjs | knit/src/host/tool.js | knit/test/tool.test.mjs | knit/test/client.test.mjs | knit/src/client/client.js
     标注答案：knit/src/host/passage.js[有]
     语义状态：mode=lexical candidates=0 reason=-
✓ [exact] 「文件分类 唯一事实来源 classifyFile」
     包：knit/test/classification.test.mjs | 01_ Knit PRD/Knit-v0.20-实现说明-Deep-Context-Retrieval.md | 03_发布/发布清单-v0.20.0.md | 99_暂存文档/01_ Knit PRD-历史版本/SDD-v0.19-v0.18-v0.17-§0原文-2026-10-07.md | knit/src/host/classification.js | 02_方案与 Demo/knit-v0.21-v0.22-relation-control-demo.html | 03_发布/发布清单-v0.19.0.md | README.md
     标注答案：knit/src/host/classification.js[有]
     语义状态：mode=lexical candidates=0 reason=-
✓ [exact] 「视频 拖拽播放 HTTP Range 206 Partial Content」
     包：99_暂存文档/AGENTS-精简前的完整快照-2026-10-07.md | 99_暂存文档/01_ Knit PRD-历史版本/Knit_评审-v0.14-ContextPack.md | knit/test/host.test.mjs | knit/test/eval/fixture.mjs | knit/tools/verify-v0.11.mjs | knit/src/host/index.js | 00_调研与规划/调研-Agent上下文可观测性与Read证据-2026-10-07.md | knit/test/host-http.test.mjs | 03_发布/市场条目文案-v0.23.1.md
     标注答案：knit/src/host/index.js[有]
     语义状态：mode=lexical candidates=0 reason=-
✗ [exact] 「重启后复用索引 内容指纹 有界对账」
     包：03_发布/发布清单-v0.22.0.md | 99_暂存文档/01_ Knit PRD-历史版本/Knit-v0.23-Phase0-审计.md | 02_方案与 Demo/Knit-v0.22-v0.24-开发提示词.md | 01_ Knit PRD/Knit-决策记录.md | knit/test/retrieval-corpus.mjs | 99_暂存文档/01_ Knit PRD-历史版本/Knit-v0.22-Phase0-审计.md | README.md | 99_暂存文档/发布会话-启动提示词-v0.22.0-已执行-2026-10-11.md | knit/test/index-incremental.test.mjs
     标注答案：knit/src/host/index-store.js[无]
     语义状态：mode=lexical candidates=0 reason=-
✓ [exact] 「指令文件预算 分层闸门 上限」
     包：knit/tools/agents-budget.mjs | 03_发布/发布清单-v0.20.0.md | 03_发布/发布清单-v0.20.1.md | AGENTS.md | 99_暂存文档/发布会话-启动提示词-v0.23.0-已执行-2026-10-12.md | 99_暂存文档/01_ Knit PRD-历史版本/Knit-v0.23-实现与基准报告.md | knit/AGENTS.md | 99_暂存文档/01_ Knit PRD-历史版本/Knit-v0.22-实现与基准报告.md
     标注答案：knit/tools/agents-budget.mjs[有]
     语义状态：mode=lexical candidates=0 reason=-
✓ [synonym] 「它凭什么把一篇放进先看的那一层」
     包：99_暂存文档/01_ Knit PRD-历史版本/Knit_评审-v0.14-ContextPack.md | knit/test/context.test.mjs | knit/test/client.test.mjs | knit/src/host/context.js | knit/README.md | knit/test/context/fixture.mjs | 00_调研与规划/调研-Agent上下文可观测性与Read证据-2026-10-07.md | knit/test/eval/fixture.mjs
     标注答案：knit/src/host/context.js[有]
     语义状态：mode=lexical candidates=0 reason=-
✗ [synonym] 「相关层名额不够的时候谁让位」
     包：knit/test/hybrid-eval.test.mjs | knit/test/hybrid-retrieval.test.mjs | 99_暂存文档/01_ Knit PRD-历史版本/Knit-v0.23-方案-可选混合检索.md | 99_暂存文档/01_ Knit PRD-历史版本/Knit-v0.23-实现与基准报告.md | knit/README.md | 03_发布/发布清单-v0.23.0.md
     标注答案：knit/src/host/context.js[无]
     语义状态：mode=lexical candidates=0 reason=-
✗ [synonym] 「两个代码文件之间的依赖是怎么看出来的」
     包：03_发布/发布清单-v0.19.0.md | knit/CHANGELOG.md | 01_ Knit PRD/Knit-决策记录.md | knit/src/client/client.js | 03_发布/验收清单-v0.19.0.md | 01_ Knit PRD/Knit_MVP需求文档.md | knit/test/retrieval-corpus.mjs | knit/README.md | 03_发布/真机验收清单.md
     标注答案：knit/src/host/relations.js[无]
     语义状态：mode=lexical candidates=0 reason=-
✗ [synonym] 「语义候选加在哪里 会不会动主要层」
     包：99_暂存文档/01_ Knit PRD-历史版本/Knit-v0.23-方案-可选混合检索.md | knit/src/client/client.js | knit/test/hybrid-eval.test.mjs | 02_方案与 Demo/knit-v0.23-retrieval-mode-demo.html | 99_暂存文档/01_ Knit PRD-历史版本/Knit-v0.23-Phase0-审计.md | 02_方案与 Demo/Knit-v0.22-v0.24-开发提示词.md | 01_ Knit PRD/Knit-PRD.md
     标注答案：knit/src/host/semantic.js[无] knit/src/host/context.js[无]
     语义状态：mode=lexical candidates=0 reason=-
✗ [synonym] 「开了语义检索以后 我的文件内容会不会被传出去」
     包：knit/test/hybrid-retrieval.test.mjs | 01_ Knit PRD/Knit-v0.20-实现说明-Deep-Context-Retrieval.md | 02_方案与 Demo/Knit-v0.22-v0.24-开发提示词.md | 01_ Knit PRD/Knit v0.20–v0.24 总体开发提示词.md | 01_ Knit PRD/Knit-v0.20-Phase0-审计.md | 99_暂存文档/01_ Knit PRD-历史版本/Knit-v0.23-Phase0-审计.md | 00_调研与规划/调研-插件市场空缺-2026-09-21.md
     标注答案：knit/src/host/semantic.js[无]
     语义状态：mode=lexical candidates=0 reason=-
✗ [synonym] 「连不上 embedding 服务会怎么样」
     包：02_方案与 Demo/knit-v0.23-retrieval-mode-demo.html | 02_方案与 Demo/Knit-v0.22-v0.24-开发提示词.md | 03_发布/发布清单-v0.16.0.md | 03_发布/发布文档规划.md | 99_暂存文档/01_ Knit PRD-历史版本/Knit-v0.23-Phase0-审计.md | 99_暂存文档/01_ Knit PRD-历史版本/Knit-v0.23-方案-可选混合检索.md | 03_发布/验收清单-v0.12.0.md | 00_调研与规划/竞争力评审-v0.5.md
     标注答案：knit/src/host/semantic.js[无] knit/test/semantic.test.mjs[无]
     语义状态：mode=lexical candidates=0 reason=-
✓ [synonym] 「本地 Ollama 和别的兼容服务 探测接口有什么不一样」
     包：knit/test/semantic.test.mjs | knit/CHANGELOG.md | 99_暂存文档/AGENTS-精简前的完整快照-2026-10-07.md | knit/src/host/semantic.js | knit/test/hybrid-eval.test.mjs | 99_暂存文档/01_ Knit PRD-历史版本/Knit-v0.23-Phase0-审计.md | 99_暂存文档/01_ Knit PRD-历史版本/Knit-v0.23-实现与基准报告.md | 99_暂存文档/01_ Knit PRD-历史版本/Knit-v0.23-方案-可选混合检索.md
     标注答案：knit/src/host/semantic.js[有] knit/test/semantic.test.mjs[有]
     语义状态：mode=lexical candidates=0 reason=-
✗ [synonym] 「为什么读过的历史不会再变」
     包：99_暂存文档/01_ Knit PRD-历史版本/README.md | 01_ Knit PRD/Knit-PRD-SDD-v0.17-Document-Lifecycle.md | 00_调研与规划/调研-Agent上下文可观测性与Read证据-2026-10-07.md | 调研_Knit×豆包工作_能力边界与迁移报告.md | 03_发布/验收清单-v0.18.0.md | 03_发布/发布清单-v0.17.0.md | knit/README.md
     标注答案：knit/src/host/feedback.js[无]
     语义状态：mode=lexical candidates=0 reason=-
✗ [synonym] 「怎么证明发出去的包里测试也跑得通」
     包：01_ Knit PRD/Knit-PRD.md
     标注答案：knit/tools/clean-room-test.mjs[无]
     语义状态：mode=lexical candidates=0 reason=-
✓ [synonym] 「npm 下载量到底是不是真人在装」
     包：00_调研与规划/功能机会汇总-2026-09-23.md | 99_暂存文档/01_ Knit PRD-历史版本/Knit_评审-v0.14-ContextPack.md | 02_方案与 Demo/knit-graph-prototype.html | knit/tools/market-recheck.mjs | 03_发布/分发基线-2026-09-21.md | 03_发布/分发帖-草稿.md | README.md | knit/tools/scale-benchmark.mjs
     标注答案：knit/tools/market-recheck.mjs[有]
     语义状态：mode=lexical candidates=0 reason=-
✓ [synonym] 「面板里的插件全都不见了怎么办」
     包：00_调研与规划/调研-Knit未接通的能力-2026-09-21.md | 00_调研与规划/规划-第二梯队-对话联动与分类.md | 99_暂存文档/01_ Knit PRD-历史版本/Knit_SDD-v0.7-agent文档工具.md | 03_发布/验收清单-v0.12.0.md | DSH-插件恢复手册.md | 99_暂存文档/01_ Knit PRD-历史版本/Knit_SDD-v0.8-修复-标签碎片与工具可信度.md | 00_调研与规划/竞争力评审-v0.5.md
     标注答案：DSH-插件恢复手册.md[有]
     语义状态：mode=lexical candidates=0 reason=-
✓ [synonym] 「预览里的代码 为什么只有一段有颜色」
     包：knit/AGENTS.md | 03_发布/真机验收清单.md | 99_暂存文档/指令治理-评审-2026-10-09.md | knit/CHANGELOG.md | knit/test/retrieval-corpus.mjs | knit/README.md | knit/src/client/client.js | 99_暂存文档/AGENTS-精简前的完整快照-2026-10-07.md | 99_暂存文档/01_ Knit PRD-历史版本/Knit_SDD-v0.8-修复-标签碎片与工具可信度.md
     标注答案：knit/AGENTS.md[有] knit/src/client/client.js[有]
     语义状态：mode=lexical candidates=0 reason=-
✓ [negative] 「四路径消融 分别证明什么」
     包：99_暂存文档/01_ Knit PRD-历史版本/Knit-v0.23-实现与基准报告.md | knit/tools/hybrid-retrieval-eval.mjs | 99_暂存文档/01_ Knit PRD-历史版本/Knit-v0.23-方案-可选混合检索.md | knit/test/control.test.mjs | 03_发布/发布清单-v0.23.0.md | knit/test/retrieval-eval.mjs
     标注答案：knit/tools/hybrid-retrieval-eval.mjs[有]
     语义状态：mode=lexical candidates=0 reason=-
✓ [negative] 「评测语料里的正确答案是谁定的」
     包：knit/test/retrieval-eval.mjs | 99_暂存文档/01_ Knit PRD-历史版本/Knit_SDD-v0.8-修复-标签碎片与工具可信度.md | knit/test/eval.test.mjs | knit/test/eval/deep.mjs | knit/test/retrieval-corpus.mjs | knit/tools/scale-benchmark.mjs | 99_暂存文档/01_ Knit PRD-历史版本/Knit_PRD-v0.6-相关性排序质量.md
     标注答案：knit/test/retrieval-corpus.mjs[有]
     语义状态：mode=lexical candidates=0 reason=-
✓ [negative] 「哪些安全属性有机器核验」
     包：99_暂存文档/01_ Knit PRD-历史版本/Knit_PRD-v0.11-agent价值与信任.md | knit/SECURITY.md | knit/test/security.test.mjs | knit/test/classification.test.mjs | 01_ Knit PRD/Knit-PRD.md | 01_ Knit PRD/Knit-决策记录.md
     标注答案：knit/SECURITY.md[有]
     语义状态：mode=lexical candidates=0 reason=-
✗ [negative] 「混合检索的收益证据到哪一步了」
     包：03_发布/发布清单-v0.23.0.md | 99_暂存文档/01_ Knit PRD-历史版本/Knit-v0.23-Phase0-审计.md | AGENTS.md | 01_ Knit PRD/Knit-v0.20.1-启动提示词.md | 99_暂存文档/01_ Knit PRD-历史版本/Knit-v0.23-方案-可选混合检索.md | 03_发布/市场条目文案-v0.23.1.md | README.md | 00_调研与规划/竞品调研-Codex插件生态.md | knit/SECURITY.md
     标注答案：knit/README.md[无] knit/tools/hybrid-retrieval-eval.mjs[无]
     语义状态：mode=lexical candidates=0 reason=-
✗ [negative] 「为什么列表不会被五秒轮询拽回去」
     包：99_暂存文档/01_ Knit PRD-历史版本/Knit-PRD-v0.15-Context-Feedback.md | 03_发布/验收清单-v0.18.0.md | knit/test/deep-scale.test.mjs | 01_ Knit PRD/Knit-决策记录.md | 03_发布/分发帖-草稿.md | knit/tools/make-demo-gif.mjs | 03_发布/真机验收清单.md | 99_暂存文档/01_ Knit PRD-历史版本/Knit_PRD-v0.12-反向链接.md | 01_ Knit PRD/Knit-v0.20-实现说明-Deep-Context-Retrieval.md
     标注答案：knit/AGENTS.md[无] knit/src/client/client.js[无]
     语义状态：mode=lexical candidates=0 reason=-

结论：本次全部断言成立。
⚠️ 本脚本**没有**证明语义检索有价值：H1 没跑（本机没有 provider）。

JSON {"tool":"real-workspace-eval","corpusVersion":1,"corpusBaseline":{"measuredAt":"2026-10-13","pluginVersion":"0.23.1","gitHead":"b164d8e","note":"工作区 = 打包机上的 08_Knit；扫描结果 182 篇（md 96 / 代码 86）"},"pluginVersion":"0.23.1","gitHead":"b164d8e","root":"/Users/zhongwentuo/DeepSeek Harness Native/08_Knit","conditions":{"corpusDocs":182,"excludedArtifacts":["knit/tools/real-workspace-eval.mjs","knit/tools/real-workspace-corpus.mjs","knit/tools/semantic-request-audit.mjs","knit/docs/evaluations/hybrid-retrieval.md"],"queries":24,"cases":{"exact":7,"synonym":12,"negative":5},"kind":"context","sort":"relevance","limit":40,"provider":{"reachable":false,"kind":"ollama","base":"http://127.0.0.1:11434","model":"nomic-embed-text"}},"paths":{"L":{"metrics":{"queries":24,"recall5":0.4791666666666667,"recall10":0.5833333333333334,"mrr":0.2753968253968254,"hit5":0.5,"hit10":0.5833333333333334,"unrelated5":0.8916666666666667,"distractor5":0.5416666666666666,"avgPack":7.583333333333333},"wallMs":584,"providerCalls":0},"H2":{"metrics":{"queries":24,"recall5":0.4791666666666667,"recall10":0.5833333333333334,"mrr":0.2753968253968254,"hit5":0.5,"hit10":0.5833333333333334,"unrelated5":0.8916666666666667,"distractor5":0.5416666666666666,"avgPack":7.583333333333333},"wallMs":540,"providerCalls":1,"identicalToL":true},"H1":null},"headroom":{"queriesWithMiss":10,"missedTotal":14,"missedZeroHit":4,"detail":[{"id":"exact-index-fingerprint","query":"重启后复用索引 内容指纹 有界对账","case":"exact","missed":["knit/src/host/index-store.js"],"foundByHybrid":null},{"id":"syn-cap-related","query":"相关层名额不够的时候谁让位","case":"synonym","missed":["knit/src/host/context.js"],"foundByHybrid":null},{"id":"syn-relations","query":"两个代码文件之间的依赖是怎么看出来的","case":"synonym","missed":["knit/src/host/relations.js"],"foundByHybrid":null},{"id":"syn-semantic-inject","query":"语义候选加在哪里 会不会动主要层","case":"synonym","missed":["knit/src/host/semantic.js","knit/src/host/context.js"],"foundByHybrid":null},{"id":"syn-privacy","query":"开了语义检索以后 我的文件内容会不会被传出去","case":"synonym","missed":["knit/src/host/semantic.js"],"foundByHybrid":null},{"id":"syn-fallback","query":"连不上 embedding 服务会怎么样","case":"synonym","missed":["knit/src/host/semantic.js","knit/test/semantic.test.mjs"],"foundByHybrid":null},{"id":"syn-feedback-freeze","query":"为什么读过的历史不会再变","case":"synonym","missed":["knit/src/host/feedback.js"],"foundByHybrid":null},{"id":"syn-clean-room","query":"怎么证明发出去的包里测试也跑得通","case":"synonym","missed":["knit/tools/clean-room-test.mjs"],"foundByHybrid":null},{"id":"neg-value-evidence","query":"混合检索的收益证据到哪一步了","case":"negative","missed":["knit/README.md","knit/tools/hybrid-retrieval-eval.mjs"],"foundByHybrid":null},{"id":"neg-poll-jump","query":"为什么列表不会被五秒轮询拽回去","case":"negative","missed":["knit/AGENTS.md","knit/src/client/client.js"],"foundByHybrid":null}]},"checks":[{"id":"A1","title":"词法路径一次 provider 调用都不发","ok":true,"detail":"L 的 provider 调用 = 0"},{"id":"A2","title":"回退诚实：provider 探不通时，hybrid 的包与面板载荷与词法**逐字一致**","ok":true,"detail":"24 条查询逐条比过（包内顺序 + 除状态行外的载荷）"},{"id":"A3","title":"标注自洽：每个答案文件都在语料里、都有一条能 grep 到的依据","ok":true,"detail":"24 条查询 / 30 条答案 / 55 条干扰项，逐条核对通过"},{"id":"A4","title":"L 与 H2 的包长逐条相同（回退不改变包的大小）","ok":true,"detail":"逐条比过"},{"id":"A5","title":"评测产物（语料 / 量尺 / 报告）没有进任何一层","ok":true,"detail":"已排除 4 个路径（经 scan() 的 excluded 参数，先于检索生效）"}],"passed":true,"mechanismEvidence":"measured (lexical baseline on the real workspace + fallback identity)","valueEvidence":"pending (no provider)"}
```

### F.3 真实工作区量尺 · 最后一行 JSON（原样）

```text
$ cd knit && node tools/real-workspace-eval.mjs --json | tail -1
JSON {"tool":"real-workspace-eval","corpusVersion":1,"corpusBaseline":{"measuredAt":"2026-10-13","pluginVersion":"0.23.1","gitHead":"b164d8e","note":"工作区 = 打包机上的 08_Knit；扫描结果 182 篇（md 96 / 代码 86）"},"pluginVersion":"0.23.1","gitHead":"b164d8e","root":"/Users/zhongwentuo/DeepSeek Harness Native/08_Knit","conditions":{"corpusDocs":182,"excludedArtifacts":["knit/tools/real-workspace-eval.mjs","knit/tools/real-workspace-corpus.mjs","knit/tools/semantic-request-audit.mjs","knit/docs/evaluations/hybrid-retrieval.md"],"queries":24,"cases":{"exact":7,"synonym":12,"negative":5},"kind":"context","sort":"relevance","limit":40,"provider":{"reachable":false,"kind":"ollama","base":"http://127.0.0.1:11434","model":"nomic-embed-text"}},"paths":{"L":{"metrics":{"queries":24,"recall5":0.4791666666666667,"recall10":0.5833333333333334,"mrr":0.2753968253968254,"hit5":0.5,"hit10":0.5833333333333334,"unrelated5":0.8916666666666667,"distractor5":0.5416666666666666,"avgPack":7.583333333333333},"wallMs":586,"providerCalls":0},"H2":{"metrics":{"queries":24,"recall5":0.4791666666666667,"recall10":0.5833333333333334,"mrr":0.2753968253968254,"hit5":0.5,"hit10":0.5833333333333334,"unrelated5":0.8916666666666667,"distractor5":0.5416666666666666,"avgPack":7.583333333333333},"wallMs":537,"providerCalls":1,"identicalToL":true},"H1":null},"headroom":{"queriesWithMiss":10,"missedTotal":14,"missedZeroHit":4,"detail":[{"id":"exact-index-fingerprint","query":"重启后复用索引 内容指纹 有界对账","case":"exact","missed":["knit/src/host/index-store.js"],"foundByHybrid":null},{"id":"syn-cap-related","query":"相关层名额不够的时候谁让位","case":"synonym","missed":["knit/src/host/context.js"],"foundByHybrid":null},{"id":"syn-relations","query":"两个代码文件之间的依赖是怎么看出来的","case":"synonym","missed":["knit/src/host/relations.js"],"foundByHybrid":null},{"id":"syn-semantic-inject","query":"语义候选加在哪里 会不会动主要层","case":"synonym","missed":["knit/src/host/semantic.js","knit/src/host/context.js"],"foundByHybrid":null},{"id":"syn-privacy","query":"开了语义检索以后 我的文件内容会不会被传出去","case":"synonym","missed":["knit/src/host/semantic.js"],"foundByHybrid":null},{"id":"syn-fallback","query":"连不上 embedding 服务会怎么样","case":"synonym","missed":["knit/src/host/semantic.js","knit/test/semantic.test.mjs"],"foundByHybrid":null},{"id":"syn-feedback-freeze","query":"为什么读过的历史不会再变","case":"synonym","missed":["knit/src/host/feedback.js"],"foundByHybrid":null},{"id":"syn-clean-room","query":"怎么证明发出去的包里测试也跑得通","case":"synonym","missed":["knit/tools/clean-room-test.mjs"],"foundByHybrid":null},{"id":"neg-value-evidence","query":"混合检索的收益证据到哪一步了","case":"negative","missed":["knit/README.md","knit/tools/hybrid-retrieval-eval.mjs"],"foundByHybrid":null},{"id":"neg-poll-jump","query":"为什么列表不会被五秒轮询拽回去","case":"negative","missed":["knit/AGENTS.md","knit/src/client/client.js"],"foundByHybrid":null}]},"checks":[{"id":"A1","title":"词法路径一次 provider 调用都不发","ok":true,"detail":"L 的 provider 调用 = 0"},{"id":"A2","title":"回退诚实：provider 探不通时，hybrid 的包与面板载荷与词法**逐字一致**","ok":true,"detail":"24 条查询逐条比过（包内顺序 + 除状态行外的载荷）"},{"id":"A3","title":"标注自洽：每个答案文件都在语料里、都有一条能 grep 到的依据","ok":true,"detail":"24 条查询 / 30 条答案 / 55 条干扰项，逐条核对通过"},{"id":"A4","title":"L 与 H2 的包长逐条相同（回退不改变包的大小）","ok":true,"detail":"逐条比过"},{"id":"A5","title":"评测产物（语料 / 量尺 / 报告）没有进任何一层","ok":true,"detail":"已排除 4 个路径（经 scan() 的 excluded 参数，先于检索生效）"}],"passed":true,"mechanismEvidence":"measured (lexical baseline on the real workspace + fallback identity)","valueEvidence":"pending (no provider)"}
```

### F.4 `--verify`（标注自洽）与 182 vs 186 的差集

```text
$ cd knit && node tools/real-workspace-eval.mjs --verify --json | tail -1
JSON {"tool":"real-workspace-eval","corpusVersion":1,"corpusBaseline":{"measuredAt":"2026-10-13","pluginVersion":"0.23.1","gitHead":"b164d8e","note":"工作区 = 打包机上的 08_Knit；扫描结果 182 篇（md 96 / 代码 86）"},"pluginVersion":"0.23.1","gitHead":"b164d8e","root":"/Users/zhongwentuo/DeepSeek Harness Native/08_Knit","conditions":{"corpusDocs":182,"excludedArtifacts":["knit/tools/real-workspace-eval.mjs","knit/tools/real-workspace-corpus.mjs","knit/tools/semantic-request-audit.mjs","knit/docs/evaluations/hybrid-retrieval.md"],"queries":24,"cases":{"exact":7,"synonym":12,"negative":5},"kind":"context","sort":"relevance","limit":40,"provider":{"reachable":false,"kind":"ollama","base":"http://127.0.0.1:11434","model":"nomic-embed-text"}},"paths":{"L":{"metrics":{"queries":24,"recall5":0.4791666666666667,"recall10":0.5833333333333334,"mrr":0.2753968253968254,"hit5":0.5,"hit10":0.5833333333333334,"unrelated5":0.8916666666666667,"distractor5":0.5416666666666666,"avgPack":7.583333333333333},"wallMs":582,"providerCalls":0},"H2":{"metrics":{"queries":24,"recall5":0.4791666666666667,"recall10":0.5833333333333334,"mrr":0.2753968253968254,"hit5":0.5,"hit10":0.5833333333333334,"unrelated5":0.8916666666666667,"distractor5":0.5416666666666666,"avgPack":7.583333333333333},"wallMs":541,"providerCalls":1,"identicalToL":true},"H1":null},"headroom":{"queriesWithMiss":10,"missedTotal":14,"missedZeroHit":4,"detail":[{"id":"exact-index-fingerprint","query":"重启后复用索引 内容指纹 有界对账","case":"exact","missed":["knit/src/host/index-store.js"],"foundByHybrid":null},{"id":"syn-cap-related","query":"相关层名额不够的时候谁让位","case":"synonym","missed":["knit/src/host/context.js"],"foundByHybrid":null},{"id":"syn-relations","query":"两个代码文件之间的依赖是怎么看出来的","case":"synonym","missed":["knit/src/host/relations.js"],"foundByHybrid":null},{"id":"syn-semantic-inject","query":"语义候选加在哪里 会不会动主要层","case":"synonym","missed":["knit/src/host/semantic.js","knit/src/host/context.js"],"foundByHybrid":null},{"id":"syn-privacy","query":"开了语义检索以后 我的文件内容会不会被传出去","case":"synonym","missed":["knit/src/host/semantic.js"],"foundByHybrid":null},{"id":"syn-fallback","query":"连不上 embedding 服务会怎么样","case":"synonym","missed":["knit/src/host/semantic.js","knit/test/semantic.test.mjs"],"foundByHybrid":null},{"id":"syn-feedback-freeze","query":"为什么读过的历史不会再变","case":"synonym","missed":["knit/src/host/feedback.js"],"foundByHybrid":null},{"id":"syn-clean-room","query":"怎么证明发出去的包里测试也跑得通","case":"synonym","missed":["knit/tools/clean-room-test.mjs"],"foundByHybrid":null},{"id":"neg-value-evidence","query":"混合检索的收益证据到哪一步了","case":"negative","missed":["knit/README.md","knit/tools/hybrid-retrieval-eval.mjs"],"foundByHybrid":null},{"id":"neg-poll-jump","query":"为什么列表不会被五秒轮询拽回去","case":"negative","missed":["knit/AGENTS.md","knit/src/client/client.js"],"foundByHybrid":null}]},"checks":[{"id":"A1","title":"词法路径一次 provider 调用都不发","ok":true,"detail":"L 的 provider 调用 = 0"},{"id":"A2","title":"回退诚实：provider 探不通时，hybrid 的包与面板载荷与词法**逐字一致**","ok":true,"detail":"24 条查询逐条比过（包内顺序 + 除状态行外的载荷）"},{"id":"A3","title":"标注自洽：每个答案文件都在语料里、都有一条能 grep 到的依据","ok":true,"detail":"24 条查询 / 30 条答案 / 55 条干扰项，逐条核对通过"},{"id":"A4","title":"L 与 H2 的包长逐条相同（回退不改变包的大小）","ok":true,"detail":"逐条比过"},{"id":"A5","title":"评测产物（语料 / 量尺 / 报告）没有进任何一层","ok":true,"detail":"已排除 4 个路径（经 scan() 的 excluded 参数，先于检索生效）"}],"passed":true,"mechanismEvidence":"measured (lexical baseline on the real workspace + fallback identity)","valueEvidence":"pending (no provider)"}
```

两次 `scan()` 求差集（脚本 `scope-diff.mjs`，见 §附录 F.8）：

```text
scanned (no exclusion) : 186
pool (eval, excluded)  : 182
difference             : 4
--- exactly the files in scanned but NOT in pool ---
   knit/docs/evaluations/hybrid-retrieval.md
   knit/tools/real-workspace-eval.mjs
   knit/tools/real-workspace-corpus.mjs
   knit/tools/semantic-request-audit.mjs
--- reverse (should be empty) ---
pool by kind: {"md":97,"code":85}
scanned by kind: {"md":98,"code":88}
```

### F.5 H2 的逐行 mode / reason（证明 H2 ≡ L 来自**刻意构造**的探测失败）

```text
$ cd knit && node h2-reasons.mjs          # 引擎 base = http://127.0.0.1:9（关着的端口）
H2 provider fetch attempts (total): 1
  ×24  requested=hybrid mode=lexical available=false reason=probe-failed candidates=0
```

### F.6 真 provider 逐行检查脚本的输出（本机 = 无 provider，如实回退）

```text
$ cd knit && node /tmp/h1-row-inspector.mjs
provider = ollama http://127.0.0.1:11434 nomic-embed-text
queries  = 24   total provider calls = 1
  ×24  requested=hybrid mode=lexical available=false reason=probe-failed candidates=0
--- per query ---
  exact-bm25-weights       mode=lexical  candidates=  0 calls=1 reason=probe-failed
  exact-exclude-before     mode=lexical  candidates=  0 calls=0 reason=probe-failed
  exact-passage-lines      mode=lexical  candidates=  0 calls=0 reason=probe-failed
  exact-classify           mode=lexical  candidates=  0 calls=0 reason=probe-failed
  exact-media-range        mode=lexical  candidates=  0 calls=0 reason=probe-failed
  exact-index-fingerprint  mode=lexical  candidates=  0 calls=0 reason=probe-failed
  exact-agents-budget      mode=lexical  candidates=  0 calls=0 reason=probe-failed
  syn-layers               mode=lexical  candidates=  0 calls=0 reason=probe-failed
  syn-cap-related          mode=lexical  candidates=  0 calls=0 reason=probe-failed
  syn-relations            mode=lexical  candidates=  0 calls=0 reason=probe-failed
  syn-semantic-inject      mode=lexical  candidates=  0 calls=0 reason=probe-failed
  syn-privacy              mode=lexical  candidates=  0 calls=0 reason=probe-failed
  syn-fallback             mode=lexical  candidates=  0 calls=0 reason=probe-failed
  syn-protocol-diff        mode=lexical  candidates=  0 calls=0 reason=probe-failed
  syn-feedback-freeze      mode=lexical  candidates=  0 calls=0 reason=probe-failed
  syn-clean-room           mode=lexical  candidates=  0 calls=0 reason=probe-failed
  syn-market-downloads     mode=lexical  candidates=  0 calls=0 reason=probe-failed
  syn-plugin-recovery      mode=lexical  candidates=  0 calls=0 reason=probe-failed
  syn-highlight-window     mode=lexical  candidates=  0 calls=0 reason=probe-failed
  neg-four-paths           mode=lexical  candidates=  0 calls=0 reason=probe-failed
  neg-corpus-labels        mode=lexical  candidates=  0 calls=0 reason=probe-failed
  neg-security-table       mode=lexical  candidates=  0 calls=0 reason=probe-failed
  neg-value-evidence       mode=lexical  candidates=  0 calls=0 reason=probe-failed
  neg-poll-jump            mode=lexical  candidates=  0 calls=0 reason=probe-failed

❌ 没有任何查询走到 hybrid —— 全部回退。这不是 Mock，是**真的没打通**：上面的 reason 就是原因。
```

### F.7 隐私审计 · 最后一行 JSON（原样）

```text
$ cd knit && node tools/semantic-request-audit.mjs --json | tail -1

JSON {"tool":"semantic-request-audit","root":"/Users/zhongwentuo/DeepSeek Harness Native/08_Knit","query":"语义候选 标题与摘要 发到远端 provider","provider":{"kind":"ollama","base":"http://127.0.0.1:11434","model":"audit-recorder-v1"},"passes":25,"requests":{"total":50,"probe":1,"embed":49},"corpus":{"docs":186,"md":98,"other":88},"coverage":{"docsEmbedded":186,"share":1},"inputs":{"total":211,"mappedToDoc":186,"queryEmbedCount":25,"queryIncluded":true,"maxNewlines":1,"maxChars":119},"summaryProvenance":{"markdown":{"embedded":98,"maxBodyDerivedChars":60,"sourceConstant":"SUMMARY_CHARS=60","bodyDerived":true},"code":{"embedded":88,"distinctDirs":9,"summaryIsRelativeDir":true}},"disclosure":{"querySent":true,"markdownSummaryIsBodyExcerpt":true,"codeSummaryIsRelativeDir":true,"quotedRels":["knit/package.json","AGENTS.md","knit/CHANGELOG.md"],"quotedRelCount":3},"checks":[{"id":"C1","title":"嵌入请求的顶层字段只有 model + input","ok":true,"detail":"实测字段集合：[\"input,model\"]"},{"id":"C1b","title":"嵌入请求没有额外请求头（只有 content-type）","ok":true,"detail":"实测：[\"{\\\"content-type\\\":\\\"application/json\\\"}\"]"},{"id":"C2","title":"报文里没有绝对路径（工作区根 / 家目录 / file://）","ok":true,"detail":"四条标记一条都没出现"},{"id":"C3","title":"每个输入串都能被解释成「查询原话」或某篇的 title + summary（多一个字段就会掉出这个集合）","ok":true,"detail":"211 条输入全部可解释（查询 25 条 / 文档 186 条）"},{"id":"C3b","title":"代码的 summary 槽是工作区相对目录（空串或 `xxx/` 结尾，无前导斜杠 / 盘符 / 反斜杠）","ok":true,"detail":"逐条比过 88 条代码输入"},{"id":"C4","title":"没有任何一篇的正文成片（200 字符）出现在报文里","ok":true,"detail":"对 183 篇真实文件做了「开头 200 字 + 中段 200 字」两处探针，均未出现"},{"id":"C5","title":"每个输入串至多一个换行、长度 ≤ 2000","ok":true,"detail":"211 条输入全部合规"},{"id":"C6","title":"查询原话确实作为嵌入输入发出（这是要如实披露的事实，不是缺陷）","ok":true,"detail":"共发出 25 次（跑了 25 轮 —— 文档向量有缓存、查询没有）"},{"id":"C7","title":"披露：Markdown 摘要散文里顺带提到的相对路径（不是字段，是正文内容）","ok":true,"detail":"3 条：[\"knit/package.json\",\"AGENTS.md\",\"knit/CHANGELOG.md\"]"}],"passed":true}
```

### F.8 合成语料四路径量尺（既有工具）· 完整 stdout

```text
$ cd knit && node tools/hybrid-retrieval-eval.mjs
Knit v0.23 · 四路径消融（corpus v1）
语料：19 篇 / 13 条查询；冷启动 3 轮铺满向量缓存（每轮最多嵌 8 篇）

── 指标（按包内顺序；Recall 取前 5 / 前 10）──
路径                R@5    R@10   MRR    无关@5   平均包长
----------------  -----  -----  -----  -----  ----
L  词法             0.808  0.808  0.808  0.167  1.2 
H0 hybrid + 替身    1.000  1.000  0.962  0.205  1.6 
H2 hybrid + 探测失败  0.808  0.808  0.808  0.167  1.2 

── 代价（时延 / provider 调用）──
路径  墙钟 ms  provider 调用
--  -----  -----------
L   53     0（默认零调用）   
H0  69     56         
H2  66     0          

回退一致性（H2 vs L，逐条比包内 rel 序列）：✅ 逐字一致
H0 替身补回的**标注答案**：4 条；补进来的非标注项：1 条

── 逐条 diff（词法漏了谁 / 语义补回了谁）──
✓ [synonym-cache] 「缓存失效策略」
    L  : docs/cache-design.md
    H0 : docs/cache-design.md | docs/cache-ttl.md   ← 追加 docs/cache-ttl.md
    标注答案：docs/cache-design.md[有]；候选 2 条（hybrid）
↗ [naming-vector] 「向量召回接口」
    L  : (空)
    H0 : docs/semantic-notes.md | src/host/semantic.js   ← 追加 docs/semantic-notes.md | src/host/semantic.js
    标注答案：src/host/semantic.js[有] docs/semantic-notes.md[有]；候选 2 条（hybrid）
✓ [exact-match] 「逐出顺序」
    L  : docs/cache-design.md | docs/cache-ttl.md
    H0 : docs/cache-design.md | docs/cache-ttl.md
    标注答案：docs/cache-design.md[有]；候选 2 条（hybrid）
✓ [long-changelog-noise] 「增量对账 指纹」
    L  : docs/index-reconcile.md | CHANGELOG.md
    H0 : docs/index-reconcile.md | CHANGELOG.md
    标注答案：docs/index-reconcile.md[有]；候选 2 条（hybrid）
↗ [mixed-code-doc] 「引用关系」
    L  : docs/relations.md
    H0 : docs/relations.md | src/host/relations.js   ← 追加 src/host/relations.js
    标注答案：src/host/relations.js[有] docs/relations.md[有]；候选 2 条（hybrid）
↗ [hard-negative-size] 「缓存大小」
    L  : (空)
    H0 : docs/cache-size.md   ← 追加 docs/cache-size.md
    标注答案：docs/cache-size.md[有]；候选 1 条（hybrid）
✓ [hard-negative-exclude] 「排除 忽略规则」
    L  : docs/gitignore-style.md | docs/control-exclude.md
    H0 : docs/gitignore-style.md | docs/control-exclude.md
    标注答案：docs/control-exclude.md[有]；候选 2 条（hybrid）
✓ [payload-budget] 「载荷 预算 上限」
    L  : docs/payload-budget.md | CHANGELOG.md | docs/cache-size.md
    H0 : docs/payload-budget.md | CHANGELOG.md | docs/cache-size.md
    标注答案：docs/payload-budget.md[有]；候选 2 条（hybrid）
✓ [feedback-freeze] 「读归因冻结」
    L  : docs/feedback-attribution.md
    H0 : docs/feedback-attribution.md
    标注答案：docs/feedback-attribution.md[有]；候选 1 条（hybrid）
✓ [media-poster] 「视频缩略图海报」
    L  : docs/media-grid.md
    H0 : docs/media-grid.md
    标注答案：docs/media-grid.md[有]；候选 1 条（hybrid）
✓ [plugin-profile] 「插件装不进去 profile」
    L  : docs/plugin-recovery.md
    H0 : docs/plugin-recovery.md
    标注答案：docs/plugin-recovery.md[有]；候选 1 条（hybrid）
✓ [release-channel] 「可信发布通道」
    L  : docs/release-oidc.md
    H0 : docs/release-oidc.md
    标注答案：docs/release-oidc.md[有]；候选 1 条（hybrid）
✓ [preview-window] 「高亮窗口回落」
    L  : docs/preview-highlight.md
    H0 : docs/preview-highlight.md
    标注答案：docs/preview-highlight.md[有]；候选 1 条（hybrid）

JSON {"corpusVersion":1,"docs":19,"queries":13,"warmupPasses":3,"paths":{"L":{"metrics":{"queries":13,"recall5":0.8076923076923077,"recall10":0.8076923076923077,"mrr":0.8076923076923077,"unrelated5":0.16666666666666666,"avgPack":1.2307692307692308},"wallMs":53,"providerCalls":0},"H0":{"metrics":{"queries":13,"recall5":1,"recall10":1,"mrr":0.9615384615384616,"unrelated5":0.20512820512820512,"avgPack":1.6153846153846154},"wallMs":69,"providerCalls":56,"rescued":4,"falsePositives":1},"H2":{"metrics":{"queries":13,"recall5":0.8076923076923077,"recall10":0.8076923076923077,"mrr":0.8076923076923077,"unrelated5":0.16666666666666666,"avgPack":1.2307692307692308},"wallMs":66,"identicalToL":true},"H1":null},"mechanismEvidence":"measured (H0, deterministic stand-in provider)","valueEvidence":"pending (no provider)"}

SKIPPED: no provider at http://127.0.0.1:11434 —— H1 没跑。
value-evidence: pending (no provider)；上面 H0 的数字只能证明**管道**，不能证明**价值**。
```

> ⚠️ **读 F.8 的顺序警告**：`H0 hybrid + 替身` 那一行 `R@5 0.808 → 1.000` 看起来像「Hybrid 提升了召回」，
> 但它的向量是**为那份 19 篇合成语料手写的加权同义词表**（`test/retrieval-corpus.mjs` 的 `fakeEmbed`），
> **不是模型**。它只能证明管道（候选算得出、进得了相关层、有界、可复现），
> **不能**作为语义检索价值的证据。真正那一列是 `H1`，本轮为 `null`（没跑）。
> 另：这一份是**修复前**的原始记录 —— `H2` 一行的 `provider 调用 = 0` 是**假的 0**，
> 已于 2026-10-13 修好（修复后同一格 = **1**，见 §附录 H）。这份记录**保持原样不改写**。

### F.9 采集这些记录的脚本（`/tmp`，不落进工作区）

- `scope-diff.mjs` —— 用 `scan()` 两次（一次不排除、一次排除 4 个评测产物）求差集，产出 F.4 的下半段。
- `h2-reasons.mjs` —— 用硬编码的 `base = http://127.0.0.1:9` 跑 24 条查询，按 `mode/reason` 去重汇总，产出 F.5。
- `h1-row-inspector.mjs` —— 逐行打印真 provider 路径的 `mode/reason/candidates`，产出 F.6（脚本正文见 §附录 B.3）。

> 三个脚本**故意放在 `/tmp`**：工作区里每多一个文件，量尺的语料就多一篇（见 §附录 A.3）。

---

## 附录 G · 评测模型与查询语言是否匹配（2026-10-13）

### G.1 24 条查询的实际语言分布（脚本可复算）

判据：含 CJK 统一汉字 ⇒ 计中文；同时含拉丁字母 ⇒ 记「中英混排」。

| case | 条数 | 纯中文 | 中英混排 | **纯英文** | 中文字符 | 拉丁字符 |
|---|---|---|---|---|---|---|
| `exact` 精确查询 | 7 | 4 | 3 | **0** | 74 | 37 |
| `synonym` 同义表达 | 12 | 9 | 3 | **0** | 180 | 18 |
| `negative` 负样例 | 5 | 5 | 0 | **0** | 65 | 0 |
| **合计** | **24** | **18** | 6 | **0** | **319** | 55 |

- **18 / 24 是纯中文**；另外 6 条的拉丁部分是**术语**（`BM25` / `classifyFile` / `HTTP Range` / `embedding` / `Ollama` / `npm`），
  句子骨架仍是中文 —— **没有任何一条是英文问句**。
- 三类查询的语言构成**一致**（都以中文为主），所以「精确 / 同义 / 负样例」三种 case 之间不存在语言偏差。
- ⚠️ 顺带一条：文档侧也不是英文 —— `embedTextOf()` 发出去的是 Markdown 的中文标题 + 中文首段，
  代码发的是相对目录。**中英跨语言检索在这份语料上不是边缘情况，它就是主场。**
- 复算：
  ```sh
  cd knit && node --input-type=module -e "import('./tools/real-workspace-corpus.mjs').then(m=>{for(const q of m.QUERIES){const s=q.query;console.log((s.match(/[\\u4e00-\\u9fff]/g)||[]).length, (s.match(/[A-Za-z]/g)||[]).length, s)}})"
  ```

### G.2 `nomic-embed-text` 匹配吗 —— 把「已核实」与「未核实」分开

| 命题 | 状态 | 依据 |
|---|---|---|
| 本语料以中文为主（18/24 纯中文、0 条纯英文） | ✅ **已核实** | 本地实测（§G.1） |
| `nomic-embed-text` 的 Ollama 模型页**没有声明语言覆盖** | ✅ **已核实** | [ollama.com/library/nomic-embed-text](https://ollama.com/library/nomic-embed-text)：只写「large token context window」、274 MB / 2K 上下文，示例全是英文 |
| `nomic-embed-text` **只支持英文**（或它在中文上表现差） | ❌ **未核实** | 官方模型卡的两次抓取都失败（`fetch failed`、`cross-origin redirect`），本轮**没有**拿到一手声明；Ollama 页面也不写语言 |

⇒ **结论按可核实的那一半下**：既然语料 0 条纯英文、而该模型**没有任何多语言声明**，
那么**默认拿它当基线这件事本身就需要先被质疑**；本轮**不**把它写成「英文模型在中文上更差」——
那是一条没有证据的断言。**它在中文语料上的实际表现，属于「尚未验证」。**

### G.3 建议的模型与**兼容性实测**（不需要改任何 Provider 逻辑）

| 模型 | 多语言声明（一手来源） | 体积 / 上下文 | 是否可用 |
|---|---|---|---|
| `bge-m3` | ✅ [Ollama 模型页](https://ollama.com/library/bge-m3)：「based on the XLM-RoBERTa architecture」+「**Multi-Linguality: It can support more than 100 working languages**」 | 1.2 GB / 8K | ✅ |
| `qwen3-embedding:0.6b` | ✅ [Ollama 模型页](https://ollama.com/library/qwen3-embedding:0.6b)：「**support for over 100 languages** … robust multilingual, **cross-lingual**, and code retrieval capabilities」 | 639 MB（Q8_0）/ 长上下文 | ✅ |
| `nomic-embed-text`（现默认示例） | ⚠️ 页面未声明语言覆盖 | 274 MB / 2K | ✅（但语言是否匹配未核实） |

**Knit 的 Provider 接口对这些模型开箱兼容 —— 实测，不是推断**（`normalizeProviderConfig()` +
`createSemanticProvider()` 冷跑，注入 fetch 记录报文）：

```text
nomic-embed-text       配置合法=是 probe=true embed=true
      GET  http://127.0.0.1:11434/api/tags
      POST http://127.0.0.1:11434/api/embed body={"model":"nomic-embed-text","input":["缓存失效策略"]}
bge-m3                 配置合法=是 probe=true embed=true
      POST http://127.0.0.1:11434/api/embed body={"model":"bge-m3","input":["缓存失效策略"]}
qwen3-embedding:0.6b   配置合法=是 probe=true embed=true
      POST http://127.0.0.1:11434/api/embed body={"model":"qwen3-embedding:0.6b","input":["缓存失效策略"]}
```

- **零代码改动**：`model` 只是一个长度 ≤ 128 的非空字符串（`semantic.js:68`），冒号 / 点号都放行；
  两条协议共用同一个请求体构造。⇒ **不需要为了换模型去碰 Provider 逻辑**（本轮也确实没碰）。
- **维度不同不会互相污染**：向量缓存的键里含 `providerId`（`kind|base|model`）与 `schemaVersion`
  （`semantic.js:422`），且 `configure()` 会 `clearVectors()`；`cosine()` 对长度不等返回 0 而不是 NaN。
  （`test/semantic.test.mjs` 有一条「换 provider（模型变了）⇒ 向量缓存作废」钉着。）
- ⚠️ **`base` 不要带 `/v1`**（§1.5 的 `/v1/v1/…` 陷阱）；模型名里**可以**带冒号（`qwen3-embedding:0.6b` 合法）。

### G.4 写进流程的选择依据（以后照这个判）

1. **先看语料语言**：查询与文档的语言分布（§G.1 的命令）——这是**唯一**的判据，不看模型排行榜。
2. **中文 / 跨语言占多数 ⇒ 选明确声明多语言的模型**（`bge-m3` / `qwen3-embedding:0.6b`）。
3. **要对照英文模型**（例如 `nomic-embed-text`）：可以，但**必须**分两轮跑、分别记模型名与条件，
   报告里分成两张表，**不许平均、不许只留好看的那张**（§B.2 的纪律）。
4. **不为了让某个模型跑通去改 Provider 逻辑** —— 若某模型真的不兼容，记成「不兼容」，
   而不是给它开一条特例分支。
5. ⚠️ **无论选哪个模型：本轮的真实 Hybrid 收益仍然 `pending`** —— 换模型是「让评测有意义」的前提，
   **不是**任何收益证据。模型选对了 ≠ 语义检索有用。

---

## 附录 H · 评测工具修复记录（2026-10-13）

### H.1 修了什么（两处缺陷 + 一处顺带发现的取字段缺口）

| # | 位置 | 症状 | 修法 | 是否影响历史结论 |
|---|---|---|---|---|
| 1 | `tools/hybrid-retrieval-eval.mjs`（H2 的引擎构造） | 引擎拿到**裸 `fetch`**，而计数器包的是另一个函数（`const deadFetch = countingFetch(fetch)` 建在引擎**之后**）⇒ H2 一行打出 **`provider 调用 = 0`，一个假的 0** | 把构造收进**唯一的**导出函数 `makeDeadEngine()`：**先**建计数 fetch、**再**交给引擎 | **不影响** —— 报告里 H2 = 1 次调用取自 `real-workspace-eval.mjs`，那一处传参本来就是对的（见 §H.5 的复评） |
| 2 | `tools/real-workspace-eval.mjs`（逐条输出） | 逐条明细只打印 **L 行**的语义状态（`l.semantic`），H1 / H2 的 `mode / reason` 看不到 ⇒「真 provider 到底进没进去」在逐条层面无法确认 | 新增「**五、逐条语义诊断**」：每条查询 × 每条路径并排打印 `mode/reason/candidates`；新增每条路径的**模式/原因去重汇总**；JSON 新增 `diagnostics.perPath / perQuery / providerStatus` | 不影响（纯提取，不发新请求） |
| 3 | 同上（顺带发现） | 行里的 `semantic` 只手挑 5 个字段，**漏了 `requested` 与 `provider`** ⇒ 诊断打出来是 `requested=undefined`（宿主 `publicSemantic()` 其实两个都下发） | 补齐这两个字段 | 不影响 |
| 4 | `tools/hybrid-retrieval-eval.mjs`（JSON 输出） | `paths.H2` 这一格**没有 `providerCalls`** ⇒ 即使计数器修好了，「H2 打了几次」在 JSON 里仍然看不到（只有打印表里有） | 与 `real-workspace-eval.mjs` 对齐，补上这一格 | 不影响 |

修复后逐条诊断长这样（本机无 provider，所以 H1 是「未跑」而不是「回退」）：

```text
  查询 id                    L                            H2                           H1
  exact-bm25-weights       lexical/-/0c                 lexical/probe-failed/0c      (未跑)
  …
  ── 每条路径的模式 / 原因汇总 ──
  L ： ×24  requested=lexical mode=lexical available=null     reason=-             candidates=0
  H2： ×24  requested=hybrid  mode=lexical available=false    reason=probe-failed  candidates=0
```

### H.2 修改前后的 Git 版本与指纹

| | 值 |
|---|---|
| HEAD（全程未变） | `b164d8e`（`main`，版本仍 `0.23.1`） |
| 改动前 blob | `hybrid-retrieval-eval.mjs` `47eaf9ea5f91cd4286940076e077868e614eaac9` · `real-workspace-eval.mjs` `c3ec2ea1c9215561a67d357dba357726d1cb1d2f` |
| 改动后 blob | `hybrid-retrieval-eval.mjs` `17bef920b9c75549b2c6067d9852e421f0e9caae` · `real-workspace-eval.mjs` `855fa6ce8548079bd1dea8e750b99f300fb3a725` |
| 未改动的两个 | `real-workspace-corpus.mjs` `fbfbe239…` · `semantic-request-audit.mjs` `cd5c1535…`（前后一致） |
| `src/` 与 `test/` | **零改动**（`git diff --stat -- src test` 为空）· 版本号未升 · 未发布 |

### H.3 评测条件与**指标复评**（没有假设旧结果仍然适用）

- 条件：`--root` = 本工作区 · `kind=context` · `sort=relevance` · `limit=40` · 24 条查询 · provider 不可达（H1 未跑）。
- **做法是真正的 A/B，不是「跑一次跟记忆里的数字比」**：把 `git show HEAD:tools/hybrid-retrieval-eval.mjs`
  （修复前那一份，blob `47eaf9ea…`）临时写回**同一个路径**跑一遍，再换成修复后的那份（blob `17bef920…`）跑一遍；
  两份都按**全精度**取数（不 `toFixed`）。收尾核对了恢复后的 blob 哈希与 `--selftest`。
- ⚠️ **一个自己踩到的坑，记下来**：第一次比对时我把「改动后」的数字 `toFixed(4)` 存盘、却拿它跟未舍入的值比，
  于是打出一片假的 `≠`。**比指标要么两边都全精度，要么两边都按同一档舍入** —— 否则比的是格式，不是结果。

| 指标 | 改动前（全精度） | 改动后（全精度） | 差 |
|---|---|---|---|
| corpusDocs | 182 | 182 | = |
| R@5 | 0.4791666666666667 | 0.4791666666666667 | = |
| R@10 | 0.5833333333333334 | 0.5833333333333334 | = |
| MRR | 0.2753968253968254 | 0.2753968253968254 | = |
| 命中@5 / @10 | 0.5 / 0.5833333333333334 | 0.5 / 0.5833333333333334 | = |
| 无关@5 | 0.8916666666666667 | 0.8916666666666667 | = |
| 干扰项@5 | 0.5416666666666666 | 0.5416666666666666 | = |
| 平均包长 | 7.583333333333333 | 7.583333333333333 | = |
| headroom（查询 / 答案 / 零命中） | 10 / 14 / 4 | 10 / 14 / 4 | = |

**修复的可见效果**（唯一一处数字真的变了的地方，而且它变的正是那个 bug）：

| 读数 | 修复前 | 修复后 |
|---|---|---|
| 4 路径表的 `H2 provider 调用` | **0**（假的 0） | **1**（= 探测那一次） |
| 4 路径 JSON 的 `paths.H2.providerCalls` | **这个字段根本不存在** | `1` |
| `--selftest` | 不存在 | S1–S3 全过（S2 是回归守卫，已证伪一次） |

**更强的检查**：不只比聚合值 —— 24 条查询的**包内 rel 序列逐条 diff，完全一致**：

```sh
diff <(grep '^     包：' before.txt) <(grep '^     包：' after.txt)   # 无差异
```

### H.4 新增的**针对性自测**，并**证伪过一次**

```sh
cd knit && node tools/hybrid-retrieval-eval.mjs --selftest
```

| 断言 | 内容 | 实测 |
|---|---|---|
| S1 | `countingFetch` 每次调用 +1（「调用次数」这个数的地基） | ✅ count = 3（3 次调用） |
| S2 | **回归守卫**：H2 的引擎确实拿着计数 fetch | ✅ `check()` 之后计数器 +1 |
| S3 | 探测失败时如实回 `available:false` + `reason`，不伪装成可用 | ✅ `available=false reason=probe-failed` |

**证伪一次**（项目自己的规矩：写完守卫要把 bug 放回去试一次）：把修复前的构造顺序写回一个 `/tmp` 副本后，
S2 的判据变成 **+0** ⇒ 这条守卫会红。即它抓得住那个 bug，**不是一盏空转的绿灯**。

- ⚠️ **自测为什么住 `tools/` 而不进 `test/`**：`tools/` **不随 npm 包发布**，而 `test/` 会。
  一个 `import '../tools/…'` 的用例会让净室闸门在解包目录里 `ERR_MODULE_NOT_FOUND`
  —— 那正是 v0.20.0 的 638/1。**能在 `test/` 里跑的只有产品代码；评测工具的自测必须住 `tools/`。**
- 因此 **`npm test` 仍是 775/775**，测试文件仍是 33 个，`AGENTS.md` 的两处状态字样**不需要动**。

### H.5 这四个工具文件属不属于 182 篇语料（实测）

| 文件 | 在 182 语料里？ | 说明 |
|---|---|---|
| `tools/hybrid-retrieval-eval.mjs` | ✅ **在** | **唯一**一个进了语料的 —— 它没被 `EVAL_ARTIFACTS` 排除 |
| `tools/real-workspace-eval.mjs` | ❌ 被排除 | 量尺本身 |
| `tools/real-workspace-corpus.mjs` | ❌ 被排除 | 标注本身 |
| `tools/semantic-request-audit.mjs` | ❌ 被排除 | 审计本身 |

⇒ **只有第 1 个的改动「可能影响检索结果」，所以只有它需要复评** —— 已按 §H.3 做完（逐位未变 + 24/24 包序列一致）。
另外三个的改动**在构造上**影响不到语料（它们根本不在候选池里）。

---

## 附录 I · `kind=media` 的无效调用：只读追踪与最小修复方案（**待授权，未实施**）

### I.1 完整调用链（只读追踪，未改一行代码）

```text
面板（媒体档 + 相关序 + 混合）
  └─ GET /knit/api/recent?kind=media&sort=relevance&retrieval=hybrid      ← client.js:3882 不带 kind 条件
      └─ scan(root, limit, { kind:'media', sort:'relevance', retrieval:'hybrid' })
          ├─ mode = 'relevance'                                            ← 抽到关键词就有（index.js:1707）
          ├─ pool = collected.media                                        ← index.js:1729-1731
          ├─ semanticPassFor(root, { retrieval:'hybrid',
          │                      applies: mode === 'relevance',  ← ★ 只看排序，不看类型档
          │                      docs: pool })                             ← index.js:1776-1785
          │     └─ engine.pass() → 探测 1 次 + 查询嵌入 1 次 + 文档批若干次   ← semantic.js:389-457
          └─ contextPayload(root, payload, sort, kind)
                └─ contextKind = kind ∈ {doc, code, context, all}          ← index.js:2042
                   ⇒ kind='media' 直接 return null                          ← **没有消费者**
```

### I.2 四个问题的实测回答

| 问题 | 回答 | 实测证据（脚本在 `/tmp`，不落工作区） |
|---|---|---|
| 是否真的发生**无消费者**的 provider 调用 | ✅ **是** | `kind=media`：**3 次请求**（1 probe + 2 embed）、**9 条输入**（查询 1 + 媒体 8）；`semantic.mode=hybrid`、`candidates=8`；而 `contextPayload()` 对该档返回 `null` ⇒ **候选无处可去** |
| 是否发送了**用户查询原话** | ✅ **是** | 嵌入输入里逐字出现 `"媒体网格 缩略图 视频"` |
| 是否产生**额外延迟 / 可计量成本** | 成本可计量、延迟不可归因 | **调用次数**（确定性）：冷启 3 次 → 之后 2、2、1、1（每轮最多嵌 8 篇，18 个媒体分三批）；**稳态每轮 1 次**（查询重发，文档向量有缓存）。**Knit 侧开销**：媒体档 `lexical` 195–200 ms vs `hybrid` 195–202 ms ⇒ **不可分辨**（替身 provider 瞬时返回）。**真实延迟未测**（没有 provider）—— 它 = 1 次查询嵌入的 RTT/轮 + 冷启 `ceil(N_media/8)` 批 |
| 能否用一个**明确的 Media 模式守卫**阻止，且不动文档 / 代码 | ✅ **能，且只有一行** | 见 I.4；`kind ∈ {doc, code, context, all}` 的行为**逐字不变** |

**顺带更正**：媒体档**没有**「界面上显示成可用」这个症状 ——
状态摘要那一行的渲染条件是 `relevance && contextView`（`client.js:5447`），
而 `contextView` 要求 `kind ∈ {doc, code}` 且真有包（`client.js:4079-4081`）
⇒ 媒体档整行不渲染。**这条缺陷是静默的**：白花调用 + 媒体文件名外发，界面上一声不响。
（媒体文件名长这样：`screenshot-media`、`12-新-中文标签去掉全角冒号` —— 后者是一句描述内容的中文。）

### I.4 最小修复方案（**待授权**；两处，各自独立）

**改动 A（主守卫，一行）** —— 把「适用性」的判据从「只是相关序」扩成「相关序 **且** 这一档会产出 Context Pack」：

```js
// src/host/index.js，scan() 里调用 semanticPassFor 处（现在 :1776-1785）
// 新增一个与 contextPayload() 同源的判据（那边是 :2042 的 contextKind）
const kindHasPack = kind === 'doc' || kind === 'code' || kind === 'context' || kind === 'all'
const semantic = await semanticPassFor(root, {
  retrieval: …,
  applies: mode === 'relevance' && kindHasPack,     // ← 只加这一半
  …
})
```

- **效果**：`kind=media` + 相关序 + 混合 ⇒ 回 `not-applicable`，**连探测都不发**（与时间序同一条短路，
  `index.js:1601-1606` 已经为时间序写好这条路径，**不是新机制**）。
- **文档 / 代码 / context / all 的行为逐字不变**（`kindHasPack` 对它们恒为 true）。
- ⚠️ **一处文案债**：`not-applicable` 的现有文案是「混合检索不适用：**时间序**没有相关性分层」
  （`client.js:213` / `:511`）。**实测它不会被渲染到媒体档**（I.2 的更正），所以正确性不受影响，
  但语义上不精确。**建议同批**把它改成中性说法（「这一档没有相关性分层」），ZH / EN 各一处 ——
  那是 `src/client/` 的改动，`test/i18n.test.mjs` 会校验键集与占位符，**属于同一次授权**。

**改动 B（可选，对 `kind=all` 也堵上预算浪费）** —— 在传 `docs` 时剔掉媒体，与 `contextPayload()` 的既有过滤同源：

```js
docs: pool.filter((d) => d.kind !== KIND_IMAGE && d.kind !== KIND_VIDEO),
```

- 只对 `kind=all` 有影响（唯一一个池子里同时有媒体的档）：把每轮 8 篇的**嵌入预算**从
  「会被丢掉的媒体」挪给「真能进包的文档 / 代码」。`kind=all` 在 UI 上已于 v0.23.1 删除
  （宿主与 e2e 仍在），所以这是**内部路径**的改善。
- 不做 B 也成立：`kind=media` 的浪费由 A 完全消除；B 只是让 `kind=all` 的预算更值。

### I.5 测试方案与**测试数变化**（先说明，再动手）

| 项 | 内容 |
|---|---|
| 新增用例（`test/hybrid-retrieval.test.mjs`） | 「判据 1b：`kind=media` 时**一次 provider 调用都不发**」—— 用计数 fetch：断言 `counter.count === 0`、`payload.semantic.reason === 'not-applicable'`、`candidates === 0`、`mode === 'lexical'`；再做一条**对照**：同一工作区 `kind=code` 时 `counter.count > 0`（证明守卫不是把整条语义通道关掉） |
| 若做改动 B | 追加一条：`kind=all` 时嵌入输入里**不出现**任何 `image` / `video` 条目 |
| **测试数变化** | `775 → 776`（+1 用例；带 B 则 `777`）。⚠️ 这会**同时**要求改两处状态字样：`AGENTS.md` §1 的 `775/775` 与 `knit/AGENTS.md` §10 的 `775 项`；`node tools/agents-budget.mjs --claims` 会据此核对（字节数不变，属净零改写） |
| 必须同时复跑的闸门 | `npm test`、`node tools/clean-room-test.mjs`、`node tools/agents-budget.mjs --claims` |
| **会不会影响 182 语料** | `src/` 与 `test/` 的改动**会**改变语料内容（`src/host/index.js` 是语料里的代码文档、`test/hybrid-retrieval.test.mjs` 也是）⇒ **必须**按 §H.3 那套复评一遍（指标 + 24 条包序列） |
| 验证守卫非空转 | 把 `applies` 改回 `mode === 'relevance'` 跑一次，新用例必须**红** |

### I.6 这一节**不做**什么

- **没有**改 `src/`、**没有**改 `test/`、**没有**升版本。I.4/I.5 是**方案**，等授权。
- **没有**顺手重构语义检索：改动 A 复用时间序已经存在的 `not-applicable` 短路；
  改动 B 复用 `contextPayload()` 已经存在的过滤，不是第二套机制。
- **没有**把「媒体档不再白花调用」写成任何收益 —— 它省的是**无效调用与一次信息外发**，
  与「语义检索提不提升召回」是两件事。

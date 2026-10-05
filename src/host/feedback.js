/**
 * Knit v0.16 · **Context Feedback / Context Effectiveness**
 *
 * Context Pack 给了「应该先读什么」，这个模块回答**它之后真的被用了吗**。
 * 只有三个事实来源，全部是确定性的：
 *
 *   1. **Context Snapshot / Epoch** —— Knit 把一份 Context Pack 交出去的那一刻
 *      （工具调用 / 面板装配），记下当时的三层排序与它的 `epochId`。
 *   2. **Context Delta** —— 两次 Snapshot 之间，哪些文档进 / 出 / 换了层，以及 `fromEpoch → toEpoch`。
 *   3. **Read evidence** —— 会话事件流里**真实发生过的 `read` 工具调用**
 *      （`tool/call` 配对 `tool/result`，且 `message.isError !== true`）。
 *      搜索命中（`grep` / `glob`）**不算读过**。
 *
 * Usage 就是这三者的**连接**，而且连接发生在**读的那一刻**：
 * 每条 read 落库时就按 `snapshotAt(read.seq)` 结算出 `tierAtRead` / `rankAtRead` /
 * `insideAtRead` / `epochId` 并**冻结**。之后上下文再怎么变，历史归因都不许重算 ——
 * 「当前视图」与「历史视图」是两件事。
 *
 * ⚠️ 本模块**不碰 Retrieval**（BM25 / IDF / 关键词抽取 / 长度归一化 / freshness 一行不改），
 * 也**不落盘、不联网、不调模型、不写 memory、不自动干预上下文**。
 * 读证据的唯一来源是宿主派发的 `session/event`（v0.16 起）：本模块**自己**从不调用
 * `session.snapshotEvents()` —— 那个 API 已被 DSH 标记 deprecated
 * （「new production calls are prohibited」），而且它在 fork 会话上会把父会话继承来的
 * 前缀事件也算进来。代价是：订阅之前发生的事件不会自动进来。
 *
 * v0.17 修订：闸门开晚时（真实用法：读完才想起来看面板），宿主可以在**开闸那一刻**
 * 回填一次会话已有的事件（`markBackfilled()` 由宿主在 `ingestEvents()` 之后调用）。
 * 本模块仍然零 I/O、零网络、零模型 —— 事件是宿主喂进来的，它只多知道一件事：
 * 「这批读是补记的」。**顺序是这个机制的组成部分**：`recordRead()` 在事件入库那一刻就把
 * 归因冻结，所以宿主必须**先把手上那份包 `noteSnapshot()` 掉、再喂补记的事件**，
 * 否则那些读会在「一份快照都还没有」的状态下被冻成包外（规格 §6：不知道就不要说）。
 *
 * 这里**没有**：trajectory、span、runtime trace、reasoning、成功率、置信度、归一化评分、
 * quality score、memory 写入。Usage 不是分数，是计数与事实。
 *
 * @module feedback
 */
import { isAbsolute, relative, resolve, sep } from 'node:path'

/** 同时保留多少个会话的状态（LRU 淘汰）。 */
export const MAX_SESSIONS = 24
/** 每个会话最多记多少篇**读过**的文档。 */
export const MAX_READS_PER_SESSION = 200
/** 每个会话最多保留几份 Snapshot / Epoch。
 *
 * v0.16 由 2 提到 20：归因本身**在 Read 时结算**，保留数量不影响它的正确性；
 * 它只决定 `continuedReadAfterExit` / `reEntry` 这两个事实能回溯多远
 * （要能看见「离开过、又回来」就必须留着中间那几份）。
 */
export const MAX_SNAPSHOTS_PER_SESSION = 20
/** 每个会话最多保留多少条 Delta 明细（计数不受它影响）。 */
export const MAX_DELTAS_PER_SESSION = 50
/** 最多同时挂起多少个「已调用、还没结果」的 read。 */
export const MAX_PENDING_CALLS = 64

/** 三层，顺序即「先看 → 辅助 → 背景」。 */
const TIERS = ['primary', 'supporting', 'related']
/** 唯一算「读过」的工具名。`glob` / `grep` / `bash` 一律不算。 */
const READ_TOOL = 'read'

/* ── 1. 路径 ───────────────────────────────────────────────────────── */

/**
 * 把工具参数里的路径归一成**工作区相对路径**（正斜杠）。
 *
 * 归一化失败一律返回空串 —— 调用方据此丢弃这条证据，而不是猜一个路径出来。
 * 丢弃的四种情形：非字符串 / 空串 / URL（`http://`、`file://`）/ 落在工作区根之外。
 *
 * 相对路径**不做** `resolve` —— 工作区里 `a/../b.md` 这种写法工具不会给，
 * 而把相对路径按 DSH 进程的 cwd 去 resolve 只会得到错的东西。
 *
 * @param {string} root - 工作区根（绝对路径）
 * @param {unknown} candidate - 工具给的路径
 * @returns {string} 归一化后的相对路径，或空串
 */
export function normalizeRel(root, candidate) {
  if (typeof candidate !== 'string') return ''
  const raw = candidate.trim()
  if (!raw || raw.length > 1024) return ''
  if (raw.includes('\0')) return ''
  // 官方 `read` 只接受本地路径；URL 不该出现在这里，出现就丢掉
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) return ''

  let rel = raw
  if (isAbsolute(rel)) {
    // 绝对路径必须落在工作区根之内。root 未知时不猜 —— 直接丢弃。
    if (typeof root !== 'string' || !root) return ''
    const base = resolve(root)
    const abs = resolve(rel)
    if (abs !== base && !abs.startsWith(base + sep)) return ''
    rel = relative(base, abs)
  }

  rel = rel.split(sep).join('/')
  rel = rel.replace(/^\.\/+/, '').replace(/\/{2,}/g, '/')
  if (!rel || rel === '.') return ''
  if (rel === '..' || rel.startsWith('../')) return ''
  return rel
}

/* ── 2. Snapshot / Delta ───────────────────────────────────────────── */

/**
 * 把一份 Context Pack 压成 Snapshot（**只留 rel / 层 / 层内名次**）。
 *
 * 不留 `summary` / `reason` / `mtimeMs`：Usage 要回答的是「读没读、读的是哪一层」，
 * 不是「为什么排在那儿」。少留一份数据就少一份漂移。
 *
 * @param {object} pack - `buildContext()` 的产物（`{primary, supporting, related, task, topic, totals}`）
 * @param {{seq?: number, at?: number}} [meta] - 交出这份包的**事件 seq** 与墙钟时间
 * @returns {object} Snapshot
 */
export function snapshotOf(pack, meta = {}) {
  const items = []
  for (const tier of TIERS) {
    const list = pack && Array.isArray(pack[tier]) ? pack[tier] : []
    list.forEach((item, index) => {
      const rel = item && typeof item.rel === 'string' ? item.rel : ''
      if (!rel) return
      items.push({ rel, tier, rank: index + 1 })
    })
  }
  const task = pack && typeof pack.task === 'string' ? pack.task : ''
  return {
    seq: Number.isInteger(meta.seq) ? meta.seq : -1,
    at: Number.isFinite(meta.at) ? meta.at : 0,
    topic: (pack && typeof pack.topic === 'string') ? pack.topic : '',
    task,
    total: (pack && pack.totals && Number.isInteger(pack.totals.total)) ? pack.totals.total : 0,
    items,
    sig: signatureOf(items, task),
  }
}

/**
 * 给一份 Snapshot 算个身份串 —— 用来判断「这次和上次是不是同一份上下文」。
 * @param {Array<{rel:string,tier:string,rank:number}>} items - 扁平条目
 * @param {string} task - 任务原文
 * @returns {string} 身份串
 */
function signatureOf(items, task) {
  return [task, ...items.map((item) => `${item.tier}:${item.rank}:${item.rel}`)].join('\u0000')
}

/**
 * 比较两份 Snapshot：谁进来了、谁出去了、谁换了层。
 *
 * `taskChanged` 单独给一个布尔 —— 任务换了但三层恰好没变（少见但真实）时，
 * 它仍是「上下文变了」，不该被算成 stable。
 *
 * @param {object|null} prev - 上一份 Snapshot
 * @param {object|null} next - 这一份 Snapshot
 * @returns {{appeared: object[], disappeared: object[], moved: object[], taskChanged: boolean, fromEpoch: number|null, toEpoch: number|null, stable: boolean}} 差异
 */
export function diffContext(prev, next) {
  const before = indexOf(prev)
  const after = indexOf(next)
  const appeared = []
  const disappeared = []
  const moved = []

  for (const [rel, to] of after) {
    const from = before.get(rel)
    if (!from) appeared.push({ rel, tier: to.tier, rank: to.rank })
    else if (from.tier !== to.tier || from.rank !== to.rank) moved.push({ rel, from, to })
  }
  for (const [rel, from] of before) {
    if (!after.has(rel)) disappeared.push({ rel, tier: from.tier, rank: from.rank })
  }

  const taskChanged = ((prev && prev.task) || '') !== ((next && next.task) || '')
  return {
    appeared,
    disappeared,
    moved,
    taskChanged,
    // 哪两个 Epoch 之间的变化（没有上一份时 fromEpoch 为 null）
    fromEpoch: prev && Number.isInteger(prev.epochId) ? prev.epochId : null,
    toEpoch: next && Number.isInteger(next.epochId) ? next.epochId : null,
    stable: appeared.length === 0 && disappeared.length === 0 && moved.length === 0 && !taskChanged,
  }
}

/**
 * 扁平成 `rel → {tier, rank}`。
 * @param {object|null} snapshot - Snapshot
 * @returns {Map<string, {tier:string,rank:number}>} 索引
 */
function indexOf(snapshot) {
  const map = new Map()
  const items = snapshot && Array.isArray(snapshot.items) ? snapshot.items : []
  for (const item of items) map.set(item.rel, { tier: item.tier, rank: item.rank })
  return map
}

/* ── 3. Read evidence adapter ──────────────────────────────────────── */

/**
 * 从会话事件里抽出**真实发生过的 read**。
 *
 * 事件流的真实形状（2026-09-30 实测 `session.v4.jsonl.zstd`）：
 *   - `tool/call`   `data = {turn, step, callId, name, arguments}`，**`arguments` 是 JSON 字符串**
 *   - `tool/result` `data = {turn, step, message}`，`message = {toolCallId, source:{callId}, isError, …}`
 *
 * 配对规则：同 `callId`，且结果的 `message.isError !== true`。失败 / 被拒的读**不记账**。
 * 还没等到结果的调用挂在 `pending` 里跨轮次存活（面板 5 秒轮询时，call 与 result 常常分属两次读数）。
 *
 * 幂等靠 `fromSeq` 游标：只处理 `seq > fromSeq` 的事件，所以同一批事件喂两遍不会重复计数。
 *
 * @param {object[]} events - 会话事件（v0.16 起由 `session/event` 订阅逐条喂进来）
 * @param {{root?: string, fromSeq?: number, pending?: Map<string, object>}} [options] - 选项
 * @returns {{reads: object[], cursor: number, pending: Map<string, object>}} 证据、新游标、挂起表
 */
export function normalizeReadEvidence(events, options = {}) {
  const root = options.root
  const fromSeq = Number.isInteger(options.fromSeq) ? options.fromSeq : -1
  const pending = options.pending instanceof Map ? options.pending : new Map()
  const reads = []
  let cursor = fromSeq
  if (!Array.isArray(events)) return { reads, cursor, pending }

  for (const event of events) {
    if (!event || typeof event.type !== 'string') continue
    const seq = Number.isInteger(event.seq) ? event.seq : -1
    if (seq < 0 || seq <= fromSeq) continue
    if (seq > cursor) cursor = seq

    if (event.type === 'tool/call') {
      const data = event.data || {}
      if (data.name !== READ_TOOL) continue
      const args = parseArguments(data.arguments)
      const rel = normalizeRel(root, args.file_path || args.path || args.filePath)
      const callId = typeof data.callId === 'string' ? data.callId : ''
      if (!rel || !callId) continue
      pending.set(callId, {
        rel,
        seq,
        time: Number.isFinite(event.time) ? event.time : 0,
      })
      // 挂起表也要有上限：只调用不返回的会话不许把它撑大
      while (pending.size > MAX_PENDING_CALLS) {
        const oldest = pending.keys().next().value
        if (oldest === callId) break
        pending.delete(oldest)
      }
    } else if (event.type === 'tool/result') {
      const message = (event.data && event.data.message) || {}
      const callId = String(
        message.toolCallId || (message.source && message.source.callId) || '',
      )
      if (!callId) continue
      const call = pending.get(callId)
      if (!call) continue
      pending.delete(callId)
      // 失败的读不是「读过了」—— 规格 §9
      if (message.isError === true) continue
      reads.push({
        rel: call.rel,
        callId,
        callSeq: call.seq,
        seq,
        time: Number.isFinite(event.time) ? event.time : call.time,
      })
    }
  }

  return { reads, cursor, pending }
}

/**
 * 解析 `tool/call` 的 `arguments`（实测是 JSON **字符串**）。
 * 解析不出来就当没有参数 —— 这条证据会被丢弃，而不是猜一个路径。
 * @param {unknown} raw - 原始参数
 * @returns {object} 参数对象
 */
function parseArguments(raw) {
  if (raw && typeof raw === 'object') return raw
  if (typeof raw !== 'string' || !raw) return {}
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}
/* ── 4. 按会话分片的内存状态 ───────────────────────────────────────── */

/**
 * 建一个空的 feedback store（内存态，进程活着才在）。
 * @returns {{sessions: Map<string, object>, order: string[], audited: Set<string>}} store
 */
export function createStore() {
  return { sessions: new Map(), order: [], audited: new Set() }
}

/**
 * 标记这个会话「被审计了」—— 之后它的读事件与面板请求才会被记账。
 *
 * 默认**不记账**：没人看「使用情况」、Agent 也没要 audit 的会话，
 * 不该在内存里攒快照。这一点是刻意的（内存有上限、行为可预期）。
 *
 * @param {object} store - store
 * @param {string} sessionId - 会话 id
 * @returns {boolean} 是否成功
 */
export function activateAudit(store, sessionId) {
  try {
    if (!store || !sessionId) return false
    stateOf(store, sessionId)
    store.audited.add(sessionId)
    while (store.audited.size > MAX_SESSIONS) {
      const oldest = store.audited.values().next().value
      if (oldest === sessionId) break
      store.audited.delete(oldest)
    }
    return true
  } catch {
    return false
  }
}

/**
 * 这个会话是否在记账。**订阅回调的第一行就用它早退** ——
 * 没记账的会话一次 Map 查找就返回，不做任何别的工作。
 * @param {object} store - store
 * @param {string} sessionId - 会话 id
 * @returns {boolean} 是否记账
 */
export function isAudited(store, sessionId) {
  return !!(store && sessionId && store.audited.has(sessionId))
}

/**
 * 标记这个会话的历史**已经被回填过**（v0.17 修订）。
 *
 * 幂等：调用方（宿主）在开闸时用它保证「一个会话只回填一次」，之后从订阅来的新事件
 * 照常单独入账。
 *
 * @param {object} store - store
 * @param {string} sessionId - 会话 id
 * @returns {boolean} 是否成功
 */
export function markBackfilled(store, sessionId) {
  try {
    if (!store || !sessionId) return false
    stateOf(store, sessionId).backfilled = true
    return true
  } catch {
    return false
  }
}

/**
 * 这个会话的历史回填过了吗。
 * @param {object} store - store
 * @param {string} sessionId - 会话 id
 * @returns {boolean} 是否回填过
 */
export function isBackfilled(store, sessionId) {
  try {
    const state = store && sessionId ? store.sessions.get(sessionId) : null
    return !!(state && state.backfilled)
  } catch {
    return false
  }
}

/**
 * 取（或建）一个会话的状态，并按 LRU 触摸 —— 会话数量超上限时淘汰最久没碰的。
 * @param {object} store - store
 * @param {string} sessionId - 会话 id
 * @returns {object} 会话状态
 */
function stateOf(store, sessionId) {
  let state = store.sessions.get(sessionId)
  if (!state) {
    state = {
      seq: -1,          // 已消费到的事件 seq（幂等游标；也是「当前水位」）
      pending: new Map(), // 已调用、还没结果的 read
      snapshots: [],    // 最近 MAX_SNAPSHOTS_PER_SESSION 份 Context Pack（每份 = 一个 Epoch）
      epochs: [],       // 与 snapshots 一一对应的 Epoch 级计数
      deltas: [],       // 最近若干条变化
      reads: new Map(), // rel → 冻结的读归因
      readOrder: [],    // rel 的插入顺序（淘汰用）
      // ⚠️ 这里**不再**有 `changes` 计数：上下文换过几次 = 最后一个 Epoch 的编号 - 1，
      // 而 Epoch 编号是单调的（被淘汰的 Epoch 也计过数），所以不需要额外记一个累计值。
      churn: { appeared: 0, disappeared: 0, moved: 0, taskChanged: 0 },
      // v0.17 修订：这份状态里的读是**回填**进来的（开闸时补记的历史）。
      // 它只用于「一个会话只回填一次」，不影响归因 —— 归因由宿主喂事件的顺序保证。
      backfilled: false,
    }
    store.sessions.set(sessionId, state)
  }
  const at = store.order.indexOf(sessionId)
  if (at >= 0) store.order.splice(at, 1)
  store.order.push(sessionId)
  while (store.order.length > MAX_SESSIONS) {
    const gone = store.order.shift()
    store.sessions.delete(gone)
  }
  return state
}

/* ── 5. 入口：喂事件 / 记快照 / 取使用情况 ─────────────────────────── */

/**
 * 把**一批**会话事件喂进去，抽出 read 并按「读发生的那一刻」结算归因。
 *
 * v0.16 起调用方通常一次只喂一条（`session/event` 订阅）。仍然是幂等的：
 * 只处理 `seq > state.seq` 的事件，重复喂同一批不会重复计数。
 *
 * **任何异常都咽掉并返回 `{ok:false}`** —— 记账失败绝不能让面板或工具失败。
 *
 * @param {object} store - store
 * @param {string} sessionId - 会话 id
 * @param {object[]} events - 会话事件
 * @param {{root?: string}} [options] - 选项
 * @returns {{ok: boolean, reads: number, cursor: number}} 结果
 */
/**
 * 安全地取一次版本标记。**任何异常都咽掉**：记账坏了不许影响宿主。
 * @param {(rel: string) => unknown} stat - 宿主注入的取样函数
 * @param {string} rel - 已归一化的工作区相对路径
 * @returns {number|null} mtimeMs，或 null（拿不到就不猜）
 */
function safeStat(stat, rel) {
  try {
    const value = stat(rel)
    return Number.isFinite(value) ? value : null
  } catch {
    return null
  }
}

/**
 * 把**一批**会话事件喂进去，抽出 read 并按「读发生的那一刻」结算归因。
 *
 * v0.16 起调用方通常一次只喂一条（`session/event` 订阅）。仍然是幂等的：
 * 只处理 `seq > state.seq` 的事件，重复喂同一批不会重复计数。
 *
 * **任何异常都咽掉并返回 `{ok:false}`** —— 记账失败绝不能让面板或工具失败。
 *
 * @param {object} store - store
 * @param {string} sessionId - 会话 id
 * @param {object[]} events - 会话事件
 * @param {{root?: string, stat?: (rel: string) => unknown}} [options] - 选项（v0.17 新增 `stat`）
 * @returns {{ok: boolean, reads: number, cursor: number}} 结果
 */
export function ingestEvents(store, sessionId, events, options = {}) {
  try {
    if (!store || !sessionId) return { ok: false, reads: 0, cursor: -1 }
    const state = stateOf(store, sessionId)
    const { reads, cursor, pending } = normalizeReadEvidence(events, {
      root: options.root,
      fromSeq: state.seq,
      pending: state.pending,
    })
    state.pending = pending
    if (cursor > state.seq) state.seq = cursor
    // v0.17：只在「这次读被确认成功」的时刻取一次版本标记（stat 由宿主注入，
    // 本模块仍然零 I/O）。取样在 recordRead 之前，而 recordRead 只处理
    // seq > fromSeq 的新事件 —— 同一事件重复派发既不重复计数，也不重复取样。
    const stat = typeof options.stat === 'function' ? options.stat : null
    for (const read of reads) {
      read.mtimeMs = stat ? safeStat(stat, read.rel) : null
      recordRead(state, read)
    }
    return { ok: true, reads: reads.length, cursor: state.seq }
  } catch {
    return { ok: false, reads: 0, cursor: -1 }
  }
}

/**
 * 记下「Knit 刚刚交出了这份 Context Pack」。
 *
 * 与上一份**同签名**时不记新快照（只把时间 / seq 往前推）—— 否则 5 秒轮询会把
 * 同一份上下文记成几十份，Delta churn 立刻变成噪音。
 *
 * `meta.seq` 省略时用会话当前的**事件水位**（`state.seq`）—— 也就是「交包这一刻，
 * 已经发生到第几个事件」。这正是历史归因要的边界：seq ≤ 它的读算在这份包里。
 *
 * @param {object} store - store
 * @param {string} sessionId - 会话 id
 * @param {object} pack - Context Pack
 * @param {{seq?: number, at?: number}} [meta] - 事件 seq 与时间
 * @returns {{snapshot: object, delta: object|null}|null} 新快照与它带来的变化（无变化时 null）
 */
export function noteSnapshot(store, sessionId, pack, meta = {}) {
  try {
    if (!store || !sessionId || !pack) return null
    const state = stateOf(store, sessionId)
    // ⚠️ 不传 `seq` 时取**当前事件水位**。回填路径下宿主必须先记包再喂事件 ——
    // 那一刻水位还是 -1，第一份快照自然落在会话开头，补记的读才有资格归到
    // 「我们已知最早的那份包」上（见文件头与 index.js 的 `backfillFeedback`）。
    const seq = Number.isInteger(meta.seq) ? meta.seq : state.seq
    const next = snapshotOf(pack, { seq, at: meta.at })
    const prev = state.snapshots[state.snapshots.length - 1] || null

    if (prev && prev.sig === next.sig) {
      if (next.at > prev.at) prev.at = next.at
      if (next.seq > prev.seq) prev.seq = next.seq
      const epoch = epochIn(state, prev.epochId)
      if (epoch && prev.seq > epoch.snapshotSeq) epoch.snapshotSeq = prev.seq
      return null
    }

    // Epoch 编号从这里发出：新建一份上下文 = 一个新 Epoch。同签名不算新 Epoch。
    next.epochId = prev && Number.isInteger(prev.epochId) ? prev.epochId + 1 : 1
    state.snapshots.push(next)
    state.epochs.push(createEpoch(next))
    while (state.snapshots.length > MAX_SNAPSHOTS_PER_SESSION) {
      state.snapshots.shift()
      state.epochs.shift()
    }

    let delta = null
    if (prev) {
      delta = { at: next.at, seq: next.seq, ...diffContext(prev, next) }
      state.deltas.push(delta)
      while (state.deltas.length > MAX_DELTAS_PER_SESSION) state.deltas.shift()
      state.churn.appeared += delta.appeared.length
      state.churn.disappeared += delta.disappeared.length
      state.churn.moved += delta.moved.length
      if (delta.taskChanged) state.churn.taskChanged += 1
    }
    return { snapshot: next, delta }
  } catch {
    return null
  }
}

/**
 * 给一个新 Epoch 建计数骨架（总量取自这份快照，已读量靠后续 read 累加）。
 * @param {object} snapshot - 刚记下的快照（已带 epochId）
 * @returns {object} Epoch 记录
 */
function createEpoch(snapshot) {
  const counts = {
    primary: { total: 0, read: 0 },
    supporting: { total: 0, read: 0 },
    related: { total: 0, read: 0 },
  }
  for (const item of snapshot.items) {
    const bucket = counts[item.tier]
    if (bucket) bucket.total += 1
  }
  const primary = snapshot.items.find((item) => item.tier === 'primary' && item.rank === 1)
  return {
    epochId: snapshot.epochId,
    snapshotSeq: snapshot.seq,
    topic: snapshot.topic,
    task: snapshot.task,
    primary: { rel: primary ? primary.rel : '', read: false },
    supporting: counts.supporting,
    related: counts.related,
    outsideReads: 0,
    continuedReadsAfterExit: 0,
    reEntries: 0,
    seen: new Set(), // 本 Epoch 里已经计过「读」的 `层:rel`（导出前会剥掉）
  }
}

/**
 * 按 epochId 找 Epoch 记录。找不到返回 null（早于任何快照的读就是这种）。
 * @param {object} state - 会话状态
 * @param {number|null} epochId - Epoch 编号
 * @returns {object|null} Epoch 记录
 */
function epochIn(state, epochId) {
  const list = state && Array.isArray(state.epochs) ? state.epochs : []
  if (!Number.isInteger(epochId)) return null
  for (let i = list.length - 1; i >= 0; i -= 1) {
    if (list[i].epochId === epochId) return list[i]
  }
  return null
}

/**
 * 记一次真实读。**归因在这一次调用里就结算并冻结**，之后不再重算。
 * 不属于任何快照的读 = outside context（这不是错，是信息）。
 * @param {object} state - 会话状态
 * @param {object} read - 归一化后的 read 证据
 */
function recordRead(state, read) {
  const at = snapshotAt(state.snapshots, read.seq)
  const attribution = attributeRead(at, read.rel)
  const facts = attributeReadFacts(state.snapshots, read.rel, read.seq)
  const point = {
    seq: read.seq,
    at: read.time,
    snapshotSeq: attribution.snapshotSeq,
    epochId: attribution.epochId,
    tier: attribution.tierAtRead,
    rank: attribution.rankAtRead,
    inside: attribution.insideAtRead,
  }

  let entry = state.reads.get(read.rel)
  if (!entry) {
    entry = {
      rel: read.rel,
      count: 0,
      firstRead: { ...point },
      lastRead: { ...point },
      insideReads: 0,
      outsideReads: 0,
      primaryReads: 0,
      supportingReads: 0,
      relatedReads: 0,
      reEntry: false,
      continuedReadAfterExit: false,
      // v0.17：首次读之前没有「上一次」，三个字段的初值就是「不知道」
      lastReadMtimeMs: null,
      prevReadMtimeMs: null,
      rereadAfterChange: false,
    }
    state.reads.set(read.rel, entry)
    state.readOrder.push(read.rel)
    while (state.readOrder.length > MAX_READS_PER_SESSION) {
      state.reads.delete(state.readOrder.shift())
    }
  }

  entry.count += 1
  // v0.17：把「这次读观察到的版本标记」冻结下来 —— 只在成功 read 时更新，
  // 永不被扫描或投影改写（与「归因在读那一刻冻结」是同一条纪律）。
  entry.prevReadMtimeMs = entry.lastReadMtimeMs
  entry.rereadAfterChange = entry.lastReadMtimeMs !== null
    && read.mtimeMs !== null
    && read.mtimeMs !== entry.lastReadMtimeMs
  entry.lastReadMtimeMs = Number.isFinite(read.mtimeMs) ? read.mtimeMs : null
  // 「第一次读」按**事件 seq** 认（seq 才是真相，墙钟只用来显示）
  if (read.seq < entry.firstRead.seq || (read.seq === entry.firstRead.seq && read.time < entry.firstRead.at)) {
    entry.firstRead = { ...point }
  }
  if (read.seq > entry.lastRead.seq || (read.seq === entry.lastRead.seq && read.time >= entry.lastRead.at)) {
    entry.lastRead = { ...point }
  }
  if (attribution.insideAtRead) entry.insideReads += 1
  else entry.outsideReads += 1
  if (attribution.tierAtRead === 'primary') entry.primaryReads += 1
  else if (attribution.tierAtRead === 'supporting') entry.supportingReads += 1
  else if (attribution.tierAtRead === 'related') entry.relatedReads += 1
  if (facts.continuedReadAfterExit) entry.continuedReadAfterExit = true
  if (facts.reEntry) entry.reEntry = true

  const epoch = epochIn(state, attribution.epochId)
  if (epoch) {
    if (!attribution.insideAtRead) epoch.outsideReads += 1
    if (facts.continuedReadAfterExit) epoch.continuedReadsAfterExit += 1
    if (facts.reEntry) epoch.reEntries += 1
    if (attribution.insideAtRead && attribution.tierAtRead) {
      const key = `${attribution.tierAtRead}:${read.rel}`
      if (!epoch.seen.has(key)) {
        epoch.seen.add(key)
        const bucket = epoch[attribution.tierAtRead]
        if (bucket) bucket.read += 1
      }
      if (attribution.tierAtRead === 'primary' && epoch.primary.rel === read.rel) epoch.primary.read = true
    }
  }
}

/**
 * 找出**这次读发生的那一刻**在生效的那份快照（seq ≤ 读的 seq 里最新的那份）。
 * 找不到就返回 null —— 那是「Knit 还没给过上下文就自己读了」，如实记成 outside。
 *
 * 这是 runtime 与离线回放到共用的**同一个纯函数**：两边「规则一致」靠它，
 * 而不是靠两边的数字恰好相等（交付时刻不可观测，数字本来就不可能相等）。
 *
 * @param {object[]} snapshots - 快照栈
 * @param {number} seq - 读的 seq
 * @returns {object|null} 快照
 */
export function snapshotAt(snapshots, seq) {
  const list = Array.isArray(snapshots) ? snapshots : []
  for (let i = list.length - 1; i >= 0; i -= 1) {
    if (list[i].seq <= seq) return list[i]
  }
  return null
}

/**
 * 把「这次读」钉到一份快照上 —— 输出的是**读那一刻**的事实，不是当前视图。
 * @param {object|null} snapshot - 读那一刻生效的快照（`snapshotAt()` 的结果）
 * @param {string} rel - 归一化后的路径
 * @returns {{snapshotSeq: number|null, epochId: number|null, tierAtRead: string|null, rankAtRead: number|null, insideAtRead: boolean}} 归因
 */
export function attributeRead(snapshot, rel) {
  if (!snapshot || !Array.isArray(snapshot.items)) {
    return { snapshotSeq: null, epochId: null, tierAtRead: null, rankAtRead: null, insideAtRead: false }
  }
  const hit = snapshot.items.find((item) => item.rel === rel)
  return {
    snapshotSeq: Number.isInteger(snapshot.seq) ? snapshot.seq : null,
    epochId: Number.isInteger(snapshot.epochId) ? snapshot.epochId : null,
    tierAtRead: hit ? hit.tier : null,
    rankAtRead: hit ? hit.rank : null,
    insideAtRead: !!hit,
  }
}

/**
 * 推导两个**事实**字段（规格 §12 / §13），只用保留窗口内的快照：
 *
 *   - `continuedReadAfterExit`：这次读**在当时那份快照之外**，但更早的某份快照里有这篇
 *     ⇒ 「离开上下文之后它仍然被读了」。
 *   - `reEntry`：这次读**在当时那份快照之内**，更早的某份快照里也有过，但中间至少有一份
 *     快照里没有它 ⇒ 「离开过，又回来了，而且回来之后被读了」。
 *
 * ⚠️ 这两个字段只是**事实**。它们**不许**被解释成「Agent 不认可新上下文」
 * —— 那是推断，不在这个模块的职责里（规格 §5 Evidence Over Interpretation）。
 *
 * 只在保留窗口内推导：宁可漏记，也不猜。
 *
 * @param {object[]} snapshots - 快照栈
 * @param {string} rel - 归一化后的路径
 * @param {number} readSeq - 这次读的 seq
 * @returns {{continuedReadAfterExit: boolean, reEntry: boolean}} 两个事实
 */
export function attributeReadFacts(snapshots, rel, readSeq) {
  const list = Array.isArray(snapshots) ? snapshots : []
  const empty = { continuedReadAfterExit: false, reEntry: false }
  const at = snapshotAt(list, readSeq)
  if (!at) return empty
  const atIndex = list.indexOf(at)
  if (atIndex < 0) return empty

  const insideNow = at.items.some((item) => item.rel === rel)
  let sawInside = false
  let sawGapAfterInside = false
  for (let i = 0; i < atIndex; i += 1) {
    const has = list[i].items.some((item) => item.rel === rel)
    if (has) sawInside = true
    else if (sawInside) sawGapAfterInside = true
  }
  // 更早的窗口里从来没有过它 —— 那这次既不是「继续读」也不是「重新进入」
  if (!sawInside) return empty
  if (insideNow) return { continuedReadAfterExit: false, reEntry: sawGapAfterInside }
  return { continuedReadAfterExit: true, reEntry: false }
}

/* ── 6. Lifecycle 投影（v0.17） ─────────────────────────────────────── */

/**
 * 把一条 read entry 与**当前扫描到的版本标记**投影成一个 lifecycle 事实。
 *
 * 判定优先级是**硬顺序**：`changedAfterLastRead` 先于 `rereadAfterChange` ——
 * 这就是「文件再次变化后状态回到 `读后已更新`」的实现方式。
 *
 * 状态值只有四个英文事实，**中文文案不进数据层**（UI 按 locale 映射）：
 * `unread` / `read` / `updated_after_read` / `reread_after_update`。
 *
 * 拿不到版本标记（文件被删、不在扫描结果、stat 失败）时**不做变化判断**，
 * 状态回落到冻结的事实 —— 宁可少说，也不乱说。
 *
 * @param {object|null} entry - `state.reads` 里的 entry
 * @param {number|null} [mtimeMs] - 当前扫描到的版本标记
 * @returns {{status: string, lastReadMtimeMs: number|null, changedAfterLastRead: boolean, rereadAfterChange: boolean}} 状态
 */
export function lifecycleOf(entry, mtimeMs = null) {
  const count = entry && Number.isInteger(entry.count) ? entry.count : 0
  const lastReadMtimeMs = entry && Number.isFinite(entry.lastReadMtimeMs) ? entry.lastReadMtimeMs : null
  const changedAfterLastRead = Number.isFinite(mtimeMs) && lastReadMtimeMs !== null
    && mtimeMs !== lastReadMtimeMs
  let status = 'unread'
  if (count > 0) {
    if (changedAfterLastRead) status = 'updated_after_read'
    else if (entry.rereadAfterChange) status = 'reread_after_update'
    else status = 'read'
  }
  return {
    status,
    lastReadMtimeMs,
    changedAfterLastRead,
    rereadAfterChange: !!(entry && entry.rereadAfterChange),
  }
}

/**
 * 把 `state.reads` 摊平成数组（Map 与数组都收，测试常直接喂数组）。
 * @param {Map<string, object>|object[]} reads - 读证据
 * @returns {object[]} entry 列表
 */
function readEntries(reads) {
  if (reads instanceof Map) return [...reads.values()]
  return Array.isArray(reads) ? reads : []
}

/**
 * 「最近读取」= 所有成功 read 里 `lastRead.seq` 最大的那一篇。
 *
 * seq 才是真相（墙钟只用来显示相对时间）；seq 相同时取 `lastRead.at` 较大者，
 * 保证同样是确定性的。**不建立第二份 read history**，完全从现有 entry 派生。
 *
 * @param {Map<string, object>|object[]} reads - 读证据
 * @returns {{rel: string, at: number, seq: number, epochId: number|null, tier: string|null, rank: number|null, inside: boolean}|null} 最近读取
 */
export function latestReadOf(reads) {
  let best = null
  for (const entry of readEntries(reads)) {
    if (!entry || !entry.lastRead || !(entry.count > 0)) continue
    if (!best
      || entry.lastRead.seq > best.lastRead.seq
      || (entry.lastRead.seq === best.lastRead.seq && entry.lastRead.at > best.lastRead.at)) {
      best = entry
    }
  }
  if (!best) return null
  return {
    rel: best.rel,
    at: best.lastRead.at,
    seq: best.lastRead.seq,
    epochId: Number.isInteger(best.lastRead.epochId) ? best.lastRead.epochId : null,
    tier: best.lastRead.tier || null,
    rank: Number.isInteger(best.lastRead.rank) ? best.lastRead.rank : null,
    inside: !!best.lastRead.inside,
  }
}

/**
 * 「当前包外、且真实成功读取过」的文档明细。
 *
 * ⚠️ 与 v0.16 的 `stats.outside` / `stats.outsideReads` **语义不同，两个都要留**：
 * 那个是**历史层**（至少有一次读发生在当时的包外，永不重算），
 * 这个是**当前层**（这篇文档不在**当前**包内，但被读过）—— 当前包变了它就变。
 *
 * @param {Map<string, object>|object[]} reads - 读证据
 * @param {Array<{rel: string}>} items - 当前快照的扁平条目
 * @returns {Array<{rel: string, count: number, lastReadAt: number, seq: number}>} 包外明细（按首次读的 seq 升序）
 */
export function outsideDocsOf(reads, items) {
  const inside = new Set()
  for (const item of Array.isArray(items) ? items : []) {
    if (item && typeof item.rel === 'string' && item.rel) inside.add(item.rel)
  }
  const rows = []
  for (const entry of readEntries(reads)) {
    if (!entry || !entry.rel || !(entry.count > 0) || inside.has(entry.rel)) continue
    if (!entry.firstRead || !entry.lastRead) continue
    rows.push({
      rel: entry.rel,
      count: entry.count,
      lastReadAt: entry.lastRead.at,
      seq: entry.firstRead.seq,
    })
  }
  // 阅读顺序（首次读的 seq），同 seq 用 rel 兜底 —— 不用 localeCompare（它依赖运行环境）
  rows.sort((a, b) => (a.seq - b.seq) || (a.rel < b.rel ? -1 : (a.rel > b.rel ? 1 : 0)))
  return rows
}

/**
 * 取一个会话当前的使用情况。没有记录时返回 `null`（不编造空报告）。
 * @param {object} store - store
 * @param {string} sessionId - 会话 id
 * @param {{mtimes?: Map<string, number>|object}} [options] - v0.17：当前版本标记（rel → mtimeMs）
 * @returns {object|null} 使用情况
 */
export function usageFor(store, sessionId, options = {}) {
  try {
    const state = store && store.sessions.get(sessionId)
    if (!state) return null
    return usageFrom(state, options)
  } catch {
    return null
  }
}

/**
 * 纯函数版：从一个会话状态算出使用情况（测试直接用这个）。
 *
 * 报告分两层，界线是硬的：
 *
 *   - **历史层**（`reads[].firstRead/lastRead`、`byTier[].read`、`primaryFollowThrough`、
 *     `outside`）—— 全部来自读时冻结的归因，**永不按当前上下文重算**。
 *   - **当前层**（`items`、`byTier[].total`、`primaryRel`、`delta`）—— 反映最近一份上下文。
 *
 * 报告里只有**计数与事实**：读了几次、落在哪一层、有几篇在快照之外、
 * 上下文变过几次、有几篇离开后仍被读、有几篇重新进入。**没有分数、没有百分比评分。**
 *
 * @param {object} state - 会话状态
 * @param {{mtimes?: Map<string, number>|object}} [options] - v0.17：当前版本标记（rel → mtimeMs）
 * @returns {object} 使用情况
 */
export function usageFrom(state, options = {}) {
  const snapshots = (state && state.snapshots) || []
  const snapshot = snapshots[snapshots.length - 1] || null
  // v0.17：当前版本标记。不传 = 拿不到变化证据 = 保守（只有 read / reread_after_update）
  const mtimes = options.mtimes instanceof Map
    ? options.mtimes
    : new Map(Object.entries(options.mtimes || {}))
  const epochId = snapshot && Number.isInteger(snapshot.epochId) ? snapshot.epochId : null
  const byTier = {
    primary: { total: 0, read: 0 },
    supporting: { total: 0, read: 0 },
    related: { total: 0, read: 0 },
  }
  if (snapshot) {
    for (const item of snapshot.items) {
      if (byTier[item.tier]) byTier[item.tier].total += 1
    }
  }

  const reads = []
  // v0.17：lifecycle 是**读证据 + 当前版本标记**的投影，只含有 read 证据的 rel；
  // 没有 entry 的文档不出现在这里（UI 自行落回 unread），免得把整个工作区灌进来。
  const lifecycle = {}
  for (const entry of state.reads.values()) {
    const currentMtimeMs = mtimes.has(entry.rel) ? mtimes.get(entry.rel) : null
    const life = lifecycleOf(entry, currentMtimeMs)
    lifecycle[entry.rel] = {
      status: life.status,
      count: entry.count,
      lastReadMtimeMs: life.lastReadMtimeMs,
      changedAfterLastRead: life.changedAfterLastRead,
      rereadAfterChange: life.rereadAfterChange,
      lastReadAt: entry.lastRead.at,
    }
    reads.push({
      rel: entry.rel,
      count: entry.count,
      firstRead: { ...entry.firstRead },
      lastRead: { ...entry.lastRead },
      // 兼容别名（旧调用方与测试用的字段名）：都是**首次读**的归因，历史值
      firstReadAt: entry.firstRead.at,
      firstReadSeq: entry.firstRead.seq,
      firstTier: entry.firstRead.tier,
      lastReadAt: entry.lastRead.at,
      lastTier: entry.lastRead.tier,
      insideReads: entry.insideReads,
      outsideReads: entry.outsideReads,
      outsideCount: entry.outsideReads,
      outside: entry.outsideReads > 0,
      reEntry: !!entry.reEntry,
      continuedReadAfterExit: !!entry.continuedReadAfterExit,
      // ⚠️ `tier`/`rank` 是**首次读时**的层与名次，不是「它现在在哪一层」。
      tier: entry.firstRead.tier,
      rank: entry.firstRead.rank,
    })
  }
  reads.sort((a, b) => (a.firstRead.seq - b.firstRead.seq) || (a.firstRead.at - b.firstRead.at))
  // 「这一 Epoch 的某一层里，有几篇真的被读过」—— 只认归因落在**当前 Epoch** 的读
  for (const row of reads) {
    if (row.firstRead.epochId === epochId && row.firstRead.inside && byTier[row.firstRead.tier]) {
      byTier[row.firstRead.tier].read += 1
    }
  }

  const outside = reads.filter((row) => row.outsideReads > 0)
  const first = reads[0] || null
  const epoch = epochIn(state, epochId)
  const primaryRel = epoch && epoch.primary ? epoch.primary.rel : ''
  const continued = reads.filter((row) => row.continuedReadAfterExit)
  const reentries = reads.filter((row) => row.reEntry)
  // 只取 `state.deltas` 的最后一条：与 `delta` 是**同一个对象**的两个引用，永不新建 Delta Store
  const latestDelta = state.deltas[state.deltas.length - 1] || null
  const lastEpochId = Number.isInteger(epochId) ? epochId : 0
  const epochs = (Array.isArray(state.epochs) ? state.epochs : []).map((e) => ({
    epochId: e.epochId,
    snapshotSeq: e.snapshotSeq,
    topic: e.topic,
    task: e.task,
    primary: { rel: e.primary.rel, read: e.primary.read },
    supporting: { total: e.supporting.total, read: e.supporting.read },
    related: { total: e.related.total, read: e.related.read },
    outsideReads: e.outsideReads,
    continuedReadsAfterExit: e.continuedReadsAfterExit,
    reEntries: e.reEntries,
  }))

  return {
    at: snapshot ? snapshot.at : 0,
    seq: snapshot ? snapshot.seq : -1,
    epochId,
    task: snapshot ? snapshot.task : '',
    topic: snapshot ? snapshot.topic : '',
    items: snapshot ? snapshot.items.map((item) => ({ ...item })) : [],
    reads,
    // §16 Epoch 级使用情况：内部 / 离线回放 / 将来评估用，v0.16 **不上**任何 UI 与工具输出
    epochs,
    delta: latestDelta,
    // ── v0.17 的四个新投影（全部是当前层派生物；`stats` 一个键都不动） ──
    // `latestDelta` 与 `delta` 同引用，保证两处永远一致
    latestDelta,
    lifecycle,
    recentRead: latestReadOf(state.reads),
    outsideDocs: outsideDocsOf(state.reads, snapshot ? snapshot.items : []),
    stats: {
      reads: reads.reduce((sum, row) => sum + row.count, 0),
      distinct: reads.length,
      outside: outside.length,
      outsideReads: outside.map((row) => row.rel),
      // 第一条成功读落在哪一层：primary / supporting / related / outside / null
      firstReadTier: first ? (first.firstRead.inside ? first.firstRead.tier : 'outside') : null,
      firstReadRel: first ? first.rel : '',
      firstReadAt: first ? first.firstRead.at : 0,
      firstReadEpoch: first ? first.firstRead.epochId : null,
      primaryRel,
      // 「这个 Epoch 先看的那篇被真的读了吗」—— 按 Epoch 归因的布尔，不是成功率
      primaryFollowThrough: !!(epoch && epoch.primary && epoch.primary.read),
      byTier,
      supportingCoverage: byTier.supporting.total === 0 ? null : byTier.supporting.read / byTier.supporting.total,
      // 事实计数（不是「Agent 不认可新上下文」这种解释）
      continuedReadsAfterExit: continued.length,
      reEntries: reentries.length,
      churn: {
        // 观察到的**不同 Epoch 数**（= 最后一份 Epoch 的编号；被淘汰的也算过）
        epochs: lastEpochId,
        // 变化次数 = 换过几次上下文（第一份不算变化）
        changes: lastEpochId > 0 ? lastEpochId - 1 : 0,
        // ⚠️ `snapshots` 是客户端已经在用的键名（`usage.changes` 文案），保留它 = 变化次数
        snapshots: lastEpochId > 0 ? lastEpochId - 1 : 0,
        deltas: lastEpochId > 0 ? lastEpochId - 1 : 0,
        // 手上还留着几条 Delta 明细
        retained: state.deltas.length,
        appeared: state.churn.appeared,
        disappeared: state.churn.disappeared,
        moved: state.churn.moved,
        taskChanged: state.churn.taskChanged,
      },
    },
  }
}

/**
 * 给 Agent 看的**极短**摘要（结构化、无分数）。
 * @param {object|null} usage - `usageFrom()` 的结果
 * @returns {object|null} 摘要
 */
export function auditPayload(usage) {
  if (!usage || !usage.stats) return null
  const s = usage.stats
  return {
    primaryRead: !!s.primaryFollowThrough,
    primaryRel: String(s.primaryRel || ''),
    supportingRead: s.byTier.supporting.read,
    supportingTotal: s.byTier.supporting.total,
    readsOutside: s.outside,
    contextChanges: s.churn.changes,
    epochs: s.churn.epochs,
    continuedReadsAfterExit: s.continuedReadsAfterExit,
    reEntries: s.reEntries,
  }
}

/**
 * 给 Agent 看的那一句话（`knit_docs` 渲染在末尾）。没有可说的就返回空串。
 * @param {object|null} usage - `usageFrom()` 的结果
 * @returns {string} 一行文本
 */
export function getAuditSummary(usage) {
  const payload = auditPayload(usage)
  if (!payload) return ''
  const parts = []
  if (payload.primaryRel) {
    parts.push(payload.primaryRead
      ? `primary read (${payload.primaryRel})`
      : `primary not read yet (${payload.primaryRel})`)
  }
  if (payload.supportingTotal > 0) {
    parts.push(`supporting ${payload.supportingRead}/${payload.supportingTotal}`)
  }
  if (payload.readsOutside > 0) parts.push(`${payload.readsOutside} read outside the pack`)
  if (payload.contextChanges > 0) parts.push(`context changed ${payload.contextChanges}×`)
  if (parts.length === 0) return ''
  return `Usage since the last pack: ${parts.join(' · ')}.`
}

/**
 * 复位一个会话（或整个 store）。给测试与「重新开始记账」用。
 * @param {object} store - store
 * @param {string} [sessionId] - 省略则清空全部
 */
export function resetStore(store, sessionId) {
  if (!store) return
  if (sessionId) {
    store.sessions.delete(sessionId)
    store.audited.delete(sessionId)
    const at = store.order.indexOf(sessionId)
    if (at >= 0) store.order.splice(at, 1)
    return
  }
  store.sessions.clear()
  store.order.length = 0
  store.audited.clear()
}

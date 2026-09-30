/**
 * Knit v0.15 · **Context Feedback / Context Audit**
 *
 * Context Pack 给了「应该先读什么」，这个模块回答**它之后真的被用了吗**。
 * 只有三个事实来源，全部是确定性的：
 *
 *   1. **Context Snapshot** —— Knit 把一份 Context Pack 交出去的那一刻（工具调用 / 面板装配），
 *      记下当时的三层排序。它代表「Knit 当时提供给 Agent 的上下文」。
 *   2. **Context Delta** —— 两次 Snapshot 之间，哪些文档进 / 出 / 换了层。
 *   3. **Read evidence** —— 会话事件流里**真实发生过的 `read` 工具调用**
 *      （`tool/call` 配对 `tool/result`，且 `message.isError !== true`）。
 *      搜索命中（`grep` / `glob`）**不算读过** —— 规格 §9。
 *
 * Usage 就是这三者的**连接**：某次读，落在当时那份 Snapshot 的哪一层？
 *
 * ⚠️ 本模块**不碰 Retrieval**（BM25 / IDF / 关键词抽取 / 长度归一化 / freshness 一行不改），
 * 也**不订阅 DSH event bus、不建 Event Store、不落盘、不联网、不调模型**。
 * 它是纯函数 + 一个按会话分片的内存小状态（规格 §10）：事件由调用方从
 * `session.snapshotEvents()` 拉出来喂进来，`seq` 当幂等游标，所以 5 秒轮询重复喂同一批事件
 * 不会重复计数。
 *
 * 这里**没有**：trajectory、span、runtime trace、reasoning、成功率、置信度、归一化评分、
 * memory 写入。Usage 不是分数。
 *
 * @module feedback
 */
import { isAbsolute, relative, resolve, sep } from 'node:path'

/** 同时保留多少个会话的状态（LRU 淘汰）。 */
export const MAX_SESSIONS = 24
/** 每个会话最多记多少篇**读过**的文档。 */
export const MAX_READS_PER_SESSION = 200
/** 每个会话最多保留几份 Snapshot（判断「读的时候是哪一层」要用最近两份）。 */
export const MAX_SNAPSHOTS_PER_SESSION = 2
/** 每个会话最多保留多少条 Delta。 */
export const MAX_DELTAS_PER_SESSION = 20
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
 * @returns {{appeared: object[], disappeared: object[], moved: object[], taskChanged: boolean, stable: boolean}} 差异
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
 * @param {object[]} events - `session.snapshotEvents()` 的产物
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
 * 标记这个会话「被审计了」—— 之后它的面板请求才会被记账。
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
 * 这个会话是否在记账。
 * @param {object} store - store
 * @param {string} sessionId - 会话 id
 * @returns {boolean} 是否记账
 */
export function isAudited(store, sessionId) {
  return !!(store && sessionId && store.audited.has(sessionId))
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
      seq: -1,          // 已消费到的事件 seq（幂等游标）
      pending: new Map(), // 已调用、还没结果的 read
      snapshots: [],    // 最近两份 Context Pack
      deltas: [],       // 最近若干条变化
      reads: new Map(), // rel → 计数
      readOrder: [],    // rel 的插入顺序（淘汰用）
      // ⚠️ `changes` 是**累计**的上下文替换次数，与 `deltas` 数组的长度无关 ——
      // 数组会被上限砍掉，但「这个会话里上下文变过几次」不能被砍（那正是 churn 这个指标）。
      churn: { changes: 0, appeared: 0, disappeared: 0, moved: 0, taskChanged: 0 },
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
 * 把一批会话事件喂进去，抽出 read 并记账。
 *
 * **任何异常都咽掉并返回 `{ok:false}`** —— 记账失败绝不能让面板或工具失败（规格 §33）。
 *
 * @param {object} store - store
 * @param {string} sessionId - 会话 id
 * @param {object[]} events - 会话事件
 * @param {{root?: string}} [options] - 选项
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
    for (const read of reads) recordRead(state, read)
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
    const next = snapshotOf(pack, meta)
    const prev = state.snapshots[state.snapshots.length - 1] || null

    if (prev && prev.sig === next.sig) {
      if (next.at > prev.at) prev.at = next.at
      if (next.seq > prev.seq) prev.seq = next.seq
      return null
    }

    state.snapshots.push(next)
    while (state.snapshots.length > MAX_SNAPSHOTS_PER_SESSION) state.snapshots.shift()

    let delta = null
    if (prev) {
      delta = { at: next.at, seq: next.seq, ...diffContext(prev, next) }
      state.deltas.push(delta)
      while (state.deltas.length > MAX_DELTAS_PER_SESSION) state.deltas.shift()
      state.churn.changes += 1
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
 * 记一次真实读。**不属于任何快照的读 = outside context**（这不是错，是信息）。
 * @param {object} state - 会话状态
 * @param {object} read - 归一化后的 read 证据
 */
function recordRead(state, read) {
  const snapshot = snapshotAt(state.snapshots, read.seq)
  const hit = snapshot ? snapshot.items.find((item) => item.rel === read.rel) : null
  const inside = !!hit
  const tier = hit ? hit.tier : null
  const rank = hit ? hit.rank : null

  let entry = state.reads.get(read.rel)
  if (!entry) {
    entry = {
      rel: read.rel,
      count: 1,
      firstReadAt: read.time,
      firstReadSeq: read.seq,
      firstTier: tier,
      firstRank: rank,
      lastReadAt: read.time,
      lastTier: tier,
      outside: !inside,
      outsideCount: inside ? 0 : 1,
    }
    state.reads.set(read.rel, entry)
    state.readOrder.push(read.rel)
    while (state.readOrder.length > MAX_READS_PER_SESSION) {
      state.reads.delete(state.readOrder.shift())
    }
    return
  }

  entry.count += 1
  entry.lastReadAt = read.time
  entry.lastTier = tier
  if (!inside) {
    entry.outside = true
    entry.outsideCount += 1
  }
  if (!Number.isFinite(entry.firstReadAt) || read.time < entry.firstReadAt) {
    entry.firstReadAt = read.time
    entry.firstReadSeq = read.seq
    entry.firstTier = tier
    entry.firstRank = rank
  }
}

/**
 * 找出**这次读发生的那一刻**在生效的那份快照（seq ≤ 读的 seq 里最新的那份）。
 * 找不到就返回 null —— 那是「Knit 还没给过上下文就自己读了」，如实记成 outside。
 * @param {object[]} snapshots - 快照栈
 * @param {number} seq - 读的 seq
 * @returns {object|null} 快照
 */
function snapshotAt(snapshots, seq) {
  for (let i = snapshots.length - 1; i >= 0; i -= 1) {
    if (snapshots[i].seq <= seq) return snapshots[i]
  }
  return null
}

/**
 * 取一个会话当前的使用情况。没有记录时返回 `null`（不编造空报告）。
 * @param {object} store - store
 * @param {string} sessionId - 会话 id
 * @returns {object|null} 使用情况
 */
export function usageFor(store, sessionId) {
  try {
    const state = store && store.sessions.get(sessionId)
    if (!state) return null
    return usageFrom(state)
  } catch {
    return null
  }
}

/**
 * 纯函数版：从一个会话状态算出使用情况（测试直接用这个）。
 *
 * 报告里只有**计数与事实**：读了几次、落在哪一层、有几篇在快照之外、
 * 上下文变了几次。**没有分数、没有百分比评分、没有「相关性」**。
 *
 * @param {object} state - 会话状态
 * @returns {object} 使用情况
 */
export function usageFrom(state) {
  const snapshots = (state && state.snapshots) || []
  const snapshot = snapshots[snapshots.length - 1] || null
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
  for (const entry of state.reads.values()) {
    const hit = snapshot ? snapshot.items.find((item) => item.rel === entry.rel) : null
    reads.push({
      rel: entry.rel,
      count: entry.count,
      firstReadAt: entry.firstReadAt,
      firstReadSeq: entry.firstReadSeq,
      firstTier: entry.firstTier || null,
      tier: hit ? hit.tier : null,
      rank: hit ? hit.rank : null,
      outside: !hit,
      outsideCount: entry.outsideCount || 0,
    })
  }
  reads.sort((a, b) => a.firstReadSeq - b.firstReadSeq)
  for (const row of reads) if (row.tier && byTier[row.tier]) byTier[row.tier].read += 1

  const outside = reads.filter((row) => row.outside)
  const first = reads[0] || null
  const primary = snapshot ? snapshot.items.find((item) => item.tier === 'primary' && item.rank === 1) : null
  const supportingTotal = byTier.supporting.total

  return {
    at: snapshot ? snapshot.at : 0,
    seq: snapshot ? snapshot.seq : -1,
    task: snapshot ? snapshot.task : '',
    topic: snapshot ? snapshot.topic : '',
    items: snapshot ? snapshot.items.map((item) => ({ ...item })) : [],
    reads,
    delta: state.deltas[state.deltas.length - 1] || null,
    stats: {
      reads: reads.reduce((sum, row) => sum + row.count, 0),
      distinct: reads.length,
      outside: outside.length,
      outsideReads: outside.map((row) => row.rel),
      firstReadTier: first ? first.tier : null,
      firstReadRel: first ? first.rel : '',
      firstReadAt: first ? first.firstReadAt : 0,
      primaryRel: primary ? primary.rel : '',
      // 「先看的那篇被读了吗」—— 这不是成功率，只是一次真实的命中
      primaryFollowThrough: !!(primary && reads.some((row) => row.rel === primary.rel)),
      byTier,
      supportingCoverage: supportingTotal === 0 ? null : byTier.supporting.read / supportingTotal,
      churn: {
        // 累计变过几次（不受 Delta 数组上限影响）
        snapshots: state.churn.changes,
        deltas: state.churn.changes,
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
    contextChanges: s.churn.deltas,
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

/**
 * v0.23 · **可选混合检索**（Phase A）—— provider 接口 + 有界语义候选 + 回退叙事。
 *
 * 这一层回答的问题只有一句：**「在默认词法之外，语义候选能不能被有界地算出来，
 * 而且默认路径一分钱都不花」**。它**不改**三层分层、**不加** `provenance` 新值、
 * **不往包里塞任何东西** —— 那是 Phase B 的事（方案 §11）。
 *
 * 五条硬约束（方案 §3 / §4 / §6）：
 *
 *   1. **默认零调用**：没有配置、或调用方要的是词法模式时，**一次 provider 调用都不发**
 *      （连探测也不发）—— 判据 1。
 *   2. **有界**：每轮最多新嵌入 `SEM_EMBED_PER_PASS` 篇；候选最多 `SEM_TOPK` 条（判据 4）。
 *   3. **失败明着回退**：任何失败都收敛成一个 `reason`
 *      （`no-provider` / `probe-failed` / `timeout` / `bad-response` / `no-query`），
 *      绝不抛进检索路径、绝不伪装成「混合成功」（判据 5）。
 *   4. **零依赖**：只用内置 `fetch`（且**必须**由调用方注入，便于测试 —— 见 §4 的可测接缝）。
 *   5. **不存正文**：嵌入输入只有 `title + summary`（复用路径上 `head`/`body` 都是空串，
 *      方案 §5.1）。向量只活在进程内的有界缓存里；**持久化向量留给 Phase B**。
 */

import { headHashOf } from './index-store.js'

/** 存储单元名（与 `knit_control` / `knit_index` 各开各的）。 */
export const SEMANTIC_UNIT = 'knit_semantic'
/** 单元版本。 */
export const SEMANTIC_VERSION = 1
/** Phase A 只有一张表：provider 配置（全局一条，不按工作区）。 */
export const SEMANTIC_TABLES = ['config']
/** 配置记录的键（全局单例；unit 是 `single` 布局，键只是不透明字符串）。 */
export const SEMANTIC_CONFIG_KEY = 'provider'

/** 支持的两种协议（**够用就好**，不做通用适配层）。 */
export const SEMANTIC_KINDS = ['ollama', 'openai-compatible']

/** 每轮最多新嵌入几篇（有界；与 `INDEX_VERIFY_PER_PASS = 8` 同一条纪律）。 */
export const SEM_EMBED_PER_PASS = 8
/** 语义候选上限（占位符：**由 Phase C 的消融定**，方案 §5.2 明确「不许先拍一个数」）。 */
export const SEM_TOPK = 24
/** 相似度下限（同样只是 Phase A 的计数阈值，不是排序依据）。 */
export const SEM_MIN_SIM = 0.35
/** 进程内向量缓存条数上限（Phase A 不落盘）。 */
export const SEM_CACHE_MAX = 2000
/** 探测结果在进程内的复用时长。 */
export const SEM_PROBE_TTL_MS = 60_000
/** 默认超时（毫秒）。 */
export const SEM_PROBE_TIMEOUT_MS = 1500
export const SEM_EMBED_TIMEOUT_MS = 8000
/** 配置里字符串字段的长度上限（不可信输入的第一道闸门）。 */
const MAX_FIELD = 512

/** 登记表在后端对象上的挂点（与 `control.js` 同一个理由：同进程多次加载只留一个句柄）。 */
const SEMANTIC_SHARED = Symbol.for('dsh-knit.semantic')

/** 进程内有界向量缓存：键 = `root\0rel\0headHash\0providerId\0schemaVersion`。 */
const vectorCache = new Map()

const str = (value, max = MAX_FIELD) => (typeof value === 'string' && value.length > 0 && value.length <= max ? value : null)

/**
 * 把任意输入收敛成合法 provider 配置。
 * @param {unknown} value - 来自存储 / HTTP 的任意形状
 * @returns {{kind: string, base: string, model: string}|null} 合法配置或 null
 */
export function normalizeProviderConfig(value) {
  if (!value || typeof value !== 'object') return null
  const kind = str(value.kind, 32)
  const base = str(value.base)
  const model = str(value.model, 128)
  if (!kind || !SEMANTIC_KINDS.includes(kind)) return null
  if (!base || !/^https?:\/\/[^\s]+$/.test(base)) return null
  if (!model) return null
  // 去掉尾部斜杠：两种协议都要拼路径，留着会出现 `//`（有的服务端认，有的不认）。
  return { kind, base: base.replace(/\/+$/, ''), model }
}

/** base 是不是本机地址（客户端据此决定要不要披露「内容会发到你配置的服务」）。 */
export function isLoopbackBase(base) {
  try {
    const host = new URL(base).hostname
    return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]'
  } catch {
    return false
  }
}

const providerIdOf = (config) => `${config.kind}|${config.base}|${config.model}`
/** embedding schema 版本：换协议形状 / 换向量化口径时 +1（Phase A 固定 1）。 */
export const SEMANTIC_SCHEMA_VERSION = 1

/** 余弦相似度（两个等长数值数组；长度不等或全零返回 0）。 */
export function cosine(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length === 0 || a.length !== b.length) return 0
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i++) {
    const x = Number(a[i]) || 0
    const y = Number(b[i]) || 0
    dot += x * y
    na += x * x
    nb += y * y
  }
  if (na === 0 || nb === 0) return 0
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}

/** 取一篇文档的嵌入输入：**只有 title + summary**（两条路径上都有；方案 §5.1）。 */
export function embedTextOf(doc) {
  const title = typeof doc.title === 'string' ? doc.title : ''
  const summary = typeof doc.summary === 'string' ? doc.summary : ''
  const text = `${title}\n${summary}`.trim()
  return text.length > 0 ? text.slice(0, 2000) : null
}

/**
 * 把一次 `fetch` 收敛成「成功 / 超时 / 其它失败」三态，**不抛**。
 * @param {Function} fetchImpl - 注入的 fetch
 * @param {string} url
 * @param {object} init - fetch 的第二个参数
 * @param {number} timeoutMs
 * @returns {Promise<{ok: boolean, reason?: string, status?: number, json?: object}>}
 */
async function fetchJson(fetchImpl, url, init, timeoutMs) {
  const controller = typeof AbortController === 'function' ? new AbortController() : null
  let timer = null
  try {
    if (controller) timer = setTimeout(() => controller.abort(), timeoutMs)
    const res = await fetchImpl(url, controller ? { ...init, signal: controller.signal } : init)
    if (!res || typeof res.status !== 'number') return { ok: false, reason: 'bad-response' }
    if (res.status < 200 || res.status >= 300) return { ok: false, reason: 'probe-failed', status: res.status }
    const json = await res.json()
    if (!json || typeof json !== 'object') return { ok: false, reason: 'bad-response' }
    return { ok: true, status: res.status, json }
  } catch (error) {
    const aborted = error && (error.name === 'AbortError' || /abort/i.test(String(error.message || '')))
    return { ok: false, reason: aborted ? 'timeout' : 'probe-failed' }
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/**
 * provider：两种协议的**唯一**分叉点。
 *
 * @param {object} config - `normalizeProviderConfig()` 的产物
 * @param {{fetchImpl?: Function, probeTimeoutMs?: number, embedTimeoutMs?: number}} [options]
 * @returns {object} provider 句柄（`probe` / `embed` 都**不抛**，失败回 `reason`）
 */
export function createSemanticProvider(config, options = {}) {
  const cfg = normalizeProviderConfig(config)
  // ⚠️ `'fetchImpl' in options` 而不是 `||`：显式传 `null` 是「**没有** fetch」的意思
  // （测试用它证明默认路径一个请求都不发）；只有**没传**时才回落到全局 `fetch`。
  const fetchImpl = 'fetchImpl' in options ? options.fetchImpl : (typeof fetch === 'function' ? fetch : null)
  const probeTimeoutMs = Number(options.probeTimeoutMs) > 0 ? Number(options.probeTimeoutMs) : SEM_PROBE_TIMEOUT_MS
  const embedTimeoutMs = Number(options.embedTimeoutMs) > 0 ? Number(options.embedTimeoutMs) : SEM_EMBED_TIMEOUT_MS

  if (!cfg || !fetchImpl) {
    return {
      id: null,
      kind: null,
      model: null,
      base: null,
      schemaVersion: SEMANTIC_SCHEMA_VERSION,
      probe: async () => ({ ok: false, reason: 'no-provider' }),
      embed: async () => ({ ok: false, reason: 'no-provider' }),
    }
  }

  const probe = async () => {
    const url = cfg.kind === 'ollama' ? `${cfg.base}/api/tags` : `${cfg.base}/v1/models`
    const res = await fetchJson(fetchImpl, url, { method: 'GET' }, probeTimeoutMs)
    if (!res.ok) return { ok: false, reason: res.reason }
    // 形状只要「是个对象」就算通：不同版本的 Ollama / 兼容服务返回体差别很大，
    // 这里**不校验模型清单**（真正的判据是下面的 `embed` 能不能给出向量）。
    return { ok: true }
  }

  const embed = async (texts) => {
    const input = (Array.isArray(texts) ? texts : [texts]).filter((t) => typeof t === 'string' && t.length > 0)
    if (input.length === 0) return { ok: false, reason: 'bad-response' }
    const url = cfg.kind === 'ollama' ? `${cfg.base}/api/embed` : `${cfg.base}/v1/embeddings`
    const body = cfg.kind === 'ollama'
      ? { model: cfg.model, input }
      : { model: cfg.model, input }
    const res = await fetchJson(fetchImpl, url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }, embedTimeoutMs)
    if (!res.ok) return { ok: false, reason: res.reason }
    const vectors = cfg.kind === 'ollama'
      ? (Array.isArray(res.json.embeddings) ? res.json.embeddings : null)
      : (Array.isArray(res.json.data) ? res.json.data.map((row) => row && row.embedding) : null)
    if (!vectors || vectors.length !== input.length) return { ok: false, reason: 'bad-response' }
    for (const vector of vectors) {
      if (!Array.isArray(vector) || vector.length === 0) return { ok: false, reason: 'bad-response' }
    }
    return { ok: true, vectors }
  }

  return { id: providerIdOf(cfg), kind: cfg.kind, model: cfg.model, base: cfg.base, schemaVersion: SEMANTIC_SCHEMA_VERSION, probe, embed }
}

/**
 * 配置的持久化（Phase A 只存配置；向量留在内存里）。
 * 形状照抄 `control.js` 的 `createControlStore`（同一条纪律：**证据到之前不说自己记得**）。
 *
 * @param {{backend?: object|null}} [options]
 * @returns {{persisted: boolean, reason: string, read: Function, write: Function, flush: Function}}
 */
export function createSemanticStore(options = {}) {
  const backend = options && options.backend
  const kv = backend && typeof backend === 'object' ? backend.kv : null
  if (!kv || typeof kv.open !== 'function') {
    return {
      persisted: false,
      reason: 'no-storage',
      read: async () => null,
      write: async () => false,
      flush: async () => false,
    }
  }

  let opening = null
  let writes = Promise.resolve()
  const openUnit = () => {
    if (!opening) {
      opening = Promise.resolve()
        .then(() => kv.open({
          name: SEMANTIC_UNIT,
          version: SEMANTIC_VERSION,
          tables: SEMANTIC_TABLES,
          hasGlobal: false,
          layout: 'single',
        }))
        .catch(() => null)
    }
    return opening
  }

  const store = {
    persisted: false,
    reason: 'unproven',
    read: async () => {
      try {
        const unit = await openUnit()
        if (!unit) {
          store.persisted = false
          store.reason = 'open-failed'
          return null
        }
        const all = await unit.loadAll()
        const tables = (all && all.tables) || {}
        const rows = (tables[SEMANTIC_TABLES[0]] && typeof tables[SEMANTIC_TABLES[0]] === 'object') ? tables[SEMANTIC_TABLES[0]] : {}
        store.persisted = true
        store.reason = 'ok'
        return normalizeProviderConfig(rows[SEMANTIC_CONFIG_KEY])
      } catch {
        store.persisted = false
        store.reason = 'read-failed'
        return null
      }
    },
    write: async (config) => {
      writes = writes.then(async () => {
        const unit = await openUnit()
        if (!unit) {
          store.persisted = false
          store.reason = 'open-failed'
          return false
        }
        const cfg = normalizeProviderConfig(config)
        if (cfg) await unit.putRecord(SEMANTIC_TABLES[0], SEMANTIC_CONFIG_KEY, cfg)
        else await unit.deleteRecord(SEMANTIC_TABLES[0], SEMANTIC_CONFIG_KEY)
        store.persisted = true
        store.reason = 'ok'
        return true
      }).catch(() => {
        store.persisted = false
        store.reason = 'write-failed'
        return false
      })
      return writes
    },
    flush: async () => writes,
  }
  return store
}

/** 一个后端只留一个配置登记表（同 `sharedControlRegistry` 的理由）。 */
export function sharedSemanticStore(backend) {
  if (!backend || typeof backend !== 'object') return null
  if (!backend[SEMANTIC_SHARED]) backend[SEMANTIC_SHARED] = createSemanticStore({ backend })
  return backend[SEMANTIC_SHARED]
}

/**
 * 引擎：把 provider / 配置 / 有界候选串起来。
 *
 * `pass()` 是**唯一**会发请求的地方，且只在「有配置 + 有查询文本」时发。
 *
 * @param {{store?: object|null, fetchImpl?: Function, now?: Function, probeTtlMs?: number,
 *          embedPerPass?: number, topK?: number, minSim?: number, timeouts?: object}} [options]
 * @returns {object} 引擎句柄
 */
export function createSemanticEngine(options = {}) {
  const store = options.store || null
  const fetchImpl = options.fetchImpl || (typeof fetch === 'function' ? fetch : null)
  const now = typeof options.now === 'function' ? options.now : () => Date.now()
  const probeTtlMs = Number(options.probeTtlMs) > 0 ? Number(options.probeTtlMs) : SEM_PROBE_TTL_MS
  const embedPerPass = Number(options.embedPerPass) > 0 ? Number(options.embedPerPass) : SEM_EMBED_PER_PASS
  const topK = Number(options.topK) > 0 ? Number(options.topK) : SEM_TOPK
  const minSim = Number.isFinite(options.minSim) ? Number(options.minSim) : SEM_MIN_SIM

  let config = null
  let loaded = false
  let loading = null
  let probe = null // { ok, reason, at }

  const load = () => {
    if (loaded) return Promise.resolve(config)
    if (!loading) {
      loading = (store ? store.read().catch(() => null) : Promise.resolve(null)).then((cfg) => {
        loaded = true
        if (cfg) config = cfg
        return config
      })
    }
    return loading
  }

  const providerOf = () => createSemanticProvider(config, {
    fetchImpl,
    ...(options.timeouts || {}),
  })

  const probeCached = async () => {
    if (!config) return { ok: false, reason: 'no-provider' }
    if (probe && now() - probe.at < probeTtlMs) return { ok: probe.ok, reason: probe.reason }
    const provider = providerOf()
    const result = await provider.probe()
    probe = { ok: !!result.ok, reason: result.reason, at: now() }
    return { ok: probe.ok, reason: probe.reason }
  }

  return {
    /**
     * 当前状态（**不发任何请求**；`available` 用进程内探测缓存 —— 没探过就是 null）。
     * @returns {{configured: boolean, provider: object|null, available: boolean|null, reason: string|null}}
     */
    status() {
      const available = probe ? probe.ok : null
      const reason = !config ? (loaded ? 'no-provider' : null) : (probe && !probe.ok ? probe.reason : null)
      return {
        configured: !!config,
        provider: config ? { kind: config.kind, base: config.base, model: config.model } : null,
        available,
        reason: reason || null,
      }
    },
    /** 首访装载（判据「证据到之前不说自己记得」的对应物）。 */
    async ready() {
      await load()
      return this.status()
    },
    /** 保存配置（空 / null ⇒ 清空）。返回保存后的状态（仍**不探测**）。 */
    async configure(value) {
      const cfg = normalizeProviderConfig(value)
      config = cfg
      loaded = true
      probe = null
      clearVectors()
      if (store) await store.write(cfg)
      return this.status()
    },
    /** 显式探测一次（只有 `POST /api/semantic` 与混合模式会走到这里）。 */
    async check() {
      await load()
      const result = await probeCached()
      return { configured: !!config, provider: config || null, available: result.ok, reason: result.ok ? null : (result.reason || 'probe-failed') }
    },
    /**
     * 有界的一轮语义候选计算。
     *
     * @param {{root: string, query: string, docs: Array<object>}} input
     * @returns {Promise<{available: boolean, reason: string|null, candidates: number,
     *   rels: string[], provider: object|null, embedded: number, cacheHits: number, calls: number}>}
     */
    async pass(input) {
      const root = String((input && input.root) || '')
      const query = typeof (input && input.query) === 'string' ? input.query.trim() : ''
      const docs = Array.isArray(input && input.docs) ? input.docs : []
      await load()
      const base = {
        available: false,
        reason: null,
        candidates: 0,
        rels: [],
        provider: config ? { kind: config.kind, base: config.base, model: config.model } : null,
        embedded: 0,
        cacheHits: 0,
        calls: 0,
      }
      if (!config) return { ...base, reason: 'no-provider' }
      if (!query) return { ...base, reason: 'no-query' }
      const health = await probeCached()
      base.calls = 1
      if (!health.ok) return { ...base, reason: health.reason || 'probe-failed' }

      const provider = providerOf()
      const queryVector = await provider.embed([query.slice(0, 2000)])
      base.calls += 1
      if (!queryVector.ok) return { ...base, reason: queryVector.reason || 'bad-response' }
      const q = queryVector.vectors[0]

      // 有界：先复用缓存，再对「还没缓存」的那批做**有上限**的一轮嵌入（按池子顺序，确定性）。
      const pending = []
      const scored = []
      for (const doc of docs) {
        const text = embedTextOf(doc)
        if (!text || typeof doc.rel !== 'string') continue
        const key = `${root}\u0000${doc.rel}\u0000${headHashOf(text)}\u0000${provider.id}\u0000${provider.schemaVersion}`
        const hit = vectorCache.get(key)
        if (hit) {
          base.cacheHits += 1
          scored.push({ rel: doc.rel, sim: cosine(q, hit) })
        } else if (pending.length < embedPerPass) {
          pending.push({ key, rel: doc.rel, text })
        }
      }
      if (pending.length > 0) {
        const embedded = await provider.embed(pending.map((item) => item.text))
        base.calls += 1
        if (embedded.ok) {
          for (let i = 0; i < pending.length; i++) {
            const vec = embedded.vectors[i]
            vectorCache.set(pending[i].key, vec)
            base.embedded += 1
            scored.push({ rel: pending[i].rel, sim: cosine(q, vec) })
          }
          // 有界缓存：超上限就丢最早的（Map 保持插入序）。
          while (vectorCache.size > SEM_CACHE_MAX) {
            const oldest = vectorCache.keys().next()
            if (oldest.done) break
            vectorCache.delete(oldest.value)
          }
        } else {
          // 嵌入失败 ⇒ 明着回退（但缓存命中那部分仍然如实计数：它们不花新钱）。
          base.reason = embedded.reason || 'bad-response'
          base.available = false
          return { ...base, candidates: 0, rels: [] }
        }
      }

      scored.sort((a, b) => b.sim - a.sim || (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0))
      const picked = scored.filter((row) => row.sim >= minSim).slice(0, topK)
      return { ...base, available: true, reason: null, candidates: picked.length, rels: picked.map((row) => row.rel) }
    },
  }
}

/** 测试用：清空进程内向量缓存。 */
export function clearVectors() {
  vectorCache.clear()
}

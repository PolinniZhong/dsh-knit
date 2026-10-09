/**
 * v0.21 上下文控制层 —— 固定 / 排除。
 *
 * 这一层只回答一件事：「用户亲手标的那些文件，在检索与装配的哪一步生效」。
 * 它**不是**第二个排序阶段（与 `relations.js` 同一条纪律）：固定不改变任何一篇的名次，
 * 只是把它从三层里**移出来**单独放；排除更早就生效 —— 那篇根本不进入候选集。
 *
 * 三条硬约束（实现说明 §6、D7/D8）：
 *
 *   1. **排除在检索之前**：`excluded` 里的 rel 不进候选集 ⇒ 不出现在面板、
 *      不出现在工具输出、不计入 `matched`、不参与任何计数。
 *   2. **固定在排序之后**：固定的条目**从三层移出**，进入独立的「固定上下文」区。
 *      三层的连续编号规则因此一个字不动（固定区不编号，与 v0.14「其他相关文档」同一先例）。
 *   3. **持久化是可选能力**：拿不到存储就只活在本次进程内存里，调用方**必须把这件事说出来**
 *      （`persisted: false`），不许让用户以为它记住了。
 *
 * 零 I/O：本模块自己只做纯逻辑；唯一的外部交互是注入进来的那个 `backend.kv`（可选）。
 */

/** 存储单元名。必须匹配 `UNIT_NAME_RE = /^[a-z][a-z0-9_]*$/`（`dsh-storage` 的真实正则）。 */
export const CONTROL_UNIT = 'knit_control'
/** 单元格式版本。落在介质上；不一致时按空处理，本版不做数据迁移（§6.4）。 */
export const CONTROL_VERSION = 1
/** 两张表：固定、排除。无 global 槽（§6.4）。 */
export const CONTROL_TABLES = ['pinned', 'excluded']
/** 单个工作区里两类记录各自的硬上限 —— 防的是「状态无限长」，不是界面。 */
export const MAX_CONTROL_ROWS = 200

/** 四个动作（固定 / 取消固定 / 排除 / 恢复）。前两个作用于 pinned，后两个作用于 excluded。 */
export const CONTROL_ACTIONS = ['pin', 'unpin', 'exclude', 'restore']

/** 登记表在后端对象上的挂点（`Symbol.for` ⇒ 同一进程里的多次插件加载拿到同一个）。 */
const CONTROL_SHARED = Symbol.for('dsh-knit.control')

/** 空状态。**永远返回新对象**：调用方比较时用的是引用不等，不是内容不等。 */
export function emptyControl() {
  return { pinned: [], excluded: [] }
}

const isRel = (value) => typeof value === 'string' && value.length > 0 && value.length <= 1024

/**
 * 把任意输入（来自存储介质 / HTTP）收敛成合法状态。
 *
 * 存储里的东西是不可信输入：畸形记录按**丢弃**处理，不抛错 —— 控制层坏掉
 * 不该把面板路径带崩（与反馈层同一条纪律，§6.11 第 9 条）。
 *
 * @param {unknown} value - 任意形状
 * @returns {{pinned: Array<{rel: string, at: number}>, excluded: Array<{rel: string, at: number}>}}
 */
export function normalizeControl(value) {
  const out = emptyControl()
  if (!value || typeof value !== 'object') return out
  const seen = new Set()
  for (const row of Array.isArray(value.pinned) ? value.pinned : []) {
    if (!row || !isRel(row.rel) || seen.has(row.rel)) continue
    seen.add(row.rel)
    out.pinned.push({ rel: row.rel, at: Number.isFinite(row.at) ? row.at : 0 })
  }
  // 先固定的在前（`at` 升序）；`at` 相同则按 rel 字典序 —— 确定性优先。
  out.pinned.sort((a, b) => a.at - b.at || (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0))
  out.pinned = out.pinned.slice(0, MAX_CONTROL_ROWS)
  const excludedSeen = new Set()
  for (const row of Array.isArray(value.excluded) ? value.excluded : []) {
    if (!row || !isRel(row.rel) || excludedSeen.has(row.rel)) continue
    excludedSeen.add(row.rel)
    out.excluded.push({ rel: row.rel, at: Number.isFinite(row.at) ? row.at : 0 })
  }
  out.excluded = out.excluded.slice(0, MAX_CONTROL_ROWS)
  return out
}

const without = (rows, rel) => rows.filter((row) => row.rel !== rel)

/**
 * 施加一个动作，返回**新状态**（不改原对象）。
 *
 * 固定与排除互斥（§6.2）：固定一个已排除的 = 先恢复再固定，反过来同理。
 * 幂等：重复固定同一篇不产生第二行，也不刷新 `at`（先固定的在前，顺序不该被重复点击打乱）。
 *
 * @param {object} control - 当前状态
 * @param {string} action - `pin` / `unpin` / `exclude` / `restore`
 * @param {string} rel - 工作区相对路径
 * @param {number} [at] - 时间戳（只在新增记录时写入；不是分数）
 * @returns {{control: object, changed: boolean}} 新状态与「是否真的变了」
 */
export function applyAction(control, action, rel, at = Date.now()) {
  const current = normalizeControl(control)
  if (!CONTROL_ACTIONS.includes(action) || !isRel(rel)) {
    return { control: current, changed: false }
  }
  const has = (rows) => rows.some((row) => row.rel === rel)
  if (action === 'pin') {
    if (has(current.pinned)) return { control: current, changed: false }
    return {
      control: {
        pinned: [...current.pinned, { rel, at }].slice(-MAX_CONTROL_ROWS),
        excluded: without(current.excluded, rel),
      },
      changed: true,
    }
  }
  if (action === 'unpin') {
    if (!has(current.pinned)) return { control: current, changed: false }
    return { control: { pinned: without(current.pinned, rel), excluded: current.excluded }, changed: true }
  }
  if (action === 'exclude') {
    if (has(current.excluded)) return { control: current, changed: false }
    return {
      control: {
        pinned: without(current.pinned, rel),
        excluded: [...current.excluded, { rel, at }].slice(-MAX_CONTROL_ROWS),
      },
      changed: true,
    }
  }
  if (!has(current.excluded)) return { control: current, changed: false }
  return { control: { pinned: current.pinned, excluded: without(current.excluded, rel) }, changed: true }
}

/** `excluded` 的集合视图（`scan()` 每批都要用，别每次线性找）。 */
export function excludedSet(control) {
  return new Set(normalizeControl(control).excluded.map((row) => row.rel))
}

/** 按「先固定在前」给出 rel 列表。 */
export function pinnedRels(control) {
  return normalizeControl(control).pinned.map((row) => row.rel)
}

/**
 * 固定覆盖（D7）：把固定的条目从三层**移出**，放进 `pack.pinned`。
 *
 * 条目**只能从这一包里现成的行取**（零新 I/O，与 `relations` 的投影同一条纪律）。
 * 固定了一篇但这一批候选里没有它 —— **不硬凑**（`context.js:494` 那条先例）：
 * 用户切到「代码」档时，被固定的 Markdown 自然不在屏幕上，而不是凭空长出来。
 *
 * @param {object} pack - `buildContext()` 的产物
 * @param {object} control - 控制状态
 * @returns {object} 新包（含 `pinned`；没有固定项时原样返回）
 */
export function applyPinOverride(pack, control) {
  const rels = pinnedRels(control)
  if (!pack || rels.length === 0) return pack
  const tiers = ['primary', 'supporting', 'related']
  const byRel = new Map()
  for (const tier of tiers) {
    for (const item of Array.isArray(pack[tier]) ? pack[tier] : []) {
      if (item && item.rel && !byRel.has(item.rel)) byRel.set(item.rel, { item, tier })
    }
  }
  const pinned = []
  for (const rel of rels) {
    const found = byRel.get(rel)
    // 「用户固定」是**来源**，不是分数：原样复用行数据，只把来源改成 manual。
    // ⚠️ 不再附加 `tier` 之类的新字段 —— `tool.js` 的 `ITEM_SCHEMA` 是
    // `additionalProperties: false`，多一个键就会在工具校验层静默失败（v0.14 踩过）。
    if (found) pinned.push({ ...found.item, provenance: 'manual' })
  }
  if (pinned.length === 0) return pack
  const taken = new Set(pinned.map((item) => item.rel))
  const next = { ...pack, pinned }
  for (const tier of tiers) {
    const rows = Array.isArray(pack[tier]) ? pack[tier] : []
    next[tier] = rows.filter((item) => !taken.has(item.rel))
  }
  return next
}

/**
 * 可选持久化适配（D8）。
 *
 * 调用方把 `ctx.storage.backend.get('json')` 拿到的后端（或任何同形状的替身）递进来；
 * 拿不到就传 `null` ⇒ `persisted: false`，功能照常，只是活不过这次进程。
 *
 * 三条与契约一一对应的处理：
 *   - `backend.get(name)` **会抛** `backend-not-found`（不是返回 undefined）⇒ 调用方必须先 try；
 *     这里对 `backend.kv` 缺失也一律当「没有存储」。
 *   - 同名 unit 未关闭再次 `open` 会 reject ⇒ 只开一次并复用（`opening` 记忆化）。
 *   - unit **不保证并发写序** ⇒ 这里自己串一条写链。
 *
 * 记录形状：键 = `${root}\u0000${rel}`（unit 的 `single` 布局下键是不透明字符串），
 * 值 = `{ root, rel, at }` —— 同一张表里因此能装多个工作区，读的时候按 root 过滤。
 *
 * @param {{backend?: object|null}} [options] - `backend.kv.open(descriptor)` 是唯一依赖
 * @returns {{persisted: boolean, reason: string, read: Function, write: Function}}
 */
export function createControlStore(options = {}) {
  // ⚠️ 显式传 `null` 时默认参数不生效（`index.js` 启动那一刻就是 `null`）——
  // 所以这里再收一道，别让「没有存储」这条**正常路径**变成 TypeError。
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
  const lastWritten = new Map() // root → { pinned: Set, excluded: Set }

  const openUnit = () => {
    if (!opening) {
      opening = Promise.resolve()
        .then(() => kv.open({
          name: CONTROL_UNIT,
          version: CONTROL_VERSION,
          tables: CONTROL_TABLES,
          hasGlobal: false,
          // 整单元一个文档：键因此可以是不透明的 rel，不必满足 per-record 的
          // `[a-zA-Z0-9_-]+`（rel 里有 `/` 和 `.`）。控制状态很小，整份重写无所谓。
          layout: 'single',
        }))
        .then((unit) => unit)
        .catch(() => null) // version-mismatch / malformed-medium / 后端不支持 ⇒ 当空
    }
    return opening
  }

  const store = {
    // **证据到之前不说自己记得**：`persisted` 只在读成功或写成功后才是 true。
    // 真机验收实测过反例：老版本一拿到 `kv` 就报 true，而介质文件从没出现过。
    persisted: false,
    reason: 'unproven',
    /**
     * 读一个工作区的状态。任何失败 ⇒ `null`（调用方退回空状态），绝不抛。
     * @param {string} root - 工作区根
     * @returns {Promise<object|null>} 控制状态或 null
     */
    read: async (root) => {
      try {
        const unit = await openUnit()
        if (!unit) {
          store.persisted = false
          store.reason = 'open-failed'
          return null
        }
        const all = await unit.loadAll()
        const tables = (all && all.tables) || {}
        const state = emptyControl()
        const marks = new Map()
        for (const table of CONTROL_TABLES) {
          const rows = (tables[table] && typeof tables[table] === 'object') ? tables[table] : {}
          const keys = new Set()
          for (const [key, value] of Object.entries(rows)) {
            if (!key.startsWith(`${root}\u0000`)) continue
            keys.add(key)
            if (!value || typeof value !== 'object') continue
            state[table].push({ rel: value.rel, at: value.at })
          }
          marks.set(table, keys)
        }
        lastWritten.set(root, marks)
        store.persisted = true
        store.reason = 'ok'
        return normalizeControl(state)
      } catch {
        store.persisted = false
        store.reason = 'read-failed'
        return null
      }
    },
    /**
     * 写一个工作区的状态。只写**差量**（新增 / 删除那几行），fire-and-forget：
     * 失败就记一笔并保持内存态，不重试风暴（§6.4）。
     * @param {string} root - 工作区根
     * @param {object} control - 控制状态
     * @returns {Promise<boolean>} 是否落盘成功
     */
    write: async (root, control) => {
      const next = normalizeControl(control)
      writes = writes.then(async () => {
        const unit = await openUnit()
        if (!unit) {
          store.persisted = false
          store.reason = 'open-failed'
          return false
        }
        const marks = lastWritten.get(root) || new Map()
        for (const table of CONTROL_TABLES) {
          const before = marks.get(table) || new Set()
          const after = new Set(next[table].map((row) => `${root}\u0000${row.rel}`))
          const byKey = new Map(next[table].map((row) => [`${root}\u0000${row.rel}`, row]))
          for (const key of after) {
            if (!before.has(key)) await unit.putRecord(table, key, byKey.get(key))
          }
          for (const key of before) {
            if (!after.has(key)) await unit.deleteRecord(table, key)
          }
          marks.set(table, after)
        }
        lastWritten.set(root, marks)
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
    /**
     * 等写链排空（测试与「退出前收尾」用）。生产中不 await —— 面板点一下就该立刻有反馈，
     * 落盘是后台的事。
     * @returns {Promise<boolean>} 最后一次写是否成功
     */
    flush: async () => writes,
  }
  return store
}

/**
 * 进程内存里的控制状态登记表 —— 面板与工具共用的唯一真源。
 *
 * 有存储时：启动读一次，之后读写都走内存（§6.4「读：启动开一次 loadAll()，之后只走内存」）；
 * 没有存储时：`persisted` 恒 false，状态只活这次进程。
 *
 * @param {{backend?: object|null}} [options] - 见 `createControlStore`
 * @returns {object} 登记表
 */
export function createControlRegistry(options = {}) {
  const store = createControlStore(options)
  const states = new Map() // root → 控制状态
  const loaded = new Set()
  const loading = new Map() // root → 首访那次装载的 promise

  const get = (root) => {
    const key = String(root || '')
    if (!states.has(key)) states.set(key, emptyControl())
    return states.get(key)
  }

  // 提成局部函数（不是对象方法）：`ready()` 也要用它，而对象字面量里的方法是拿不到名字的
  const controlOf = (root) => {
    const key = String(root || '')
    if (!loaded.has(key)) {
      loaded.add(key)
      loading.set(key, store.read(key).then((loadedState) => {
        if (loadedState && loadedState.pinned.length + loadedState.excluded.length > 0) {
          states.set(key, loadedState)
        }
      }).catch(() => {}))
    }
    return get(key)
  }

  return {
    // **不是本地副本**：读与写的成败都记在 store 上，这里直接问它 ——
    // 复制一份就会漏掉「读成功」这条证据。
    get persisted() {
      return store.persisted
    },
    get reason() {
      return store.reason
    },
    /** 状态本身（同步，读内存）。首访时顺带异步装载一次。 */
    controlOf,
    /**
     * 等这个工作区首访那次装载落定 —— 只为「`persisted` 是不是一句有证据的话」。
     *
     * `persisted` 的含义是**已证明**（读或写成功过），不是「后端在那儿」：真机验收抓到
     * 的第一版就错在这里 —— 第一次点击报 `persisted: true`，而介质文件从没出现过。
     * @param {string} root - 工作区根
     * @returns {Promise<void>} 装载结束（成功或失败都 resolve）
     */
    ready(root) {
      controlOf(root)
      return loading.get(String(root || '')) || Promise.resolve()
    },
    /**
     * 改一个动作。返回 `{control, changed, persisted}`。
     *
     * **必须 await**：`persisted` 报的是**这次写的结果**，不是「大概能写」——
     * 不等它就会在写失败时先回一句 `true`（真机验收实测到的缺陷）。
     * @returns {Promise<{control: object, changed: boolean, persisted: boolean}>}
     */
    async act(root, action, rel, at) {
      const key = String(root || '')
      const { control, changed } = applyAction(get(key), action, rel, at)
      if (!changed) return { control, changed, persisted: store.persisted }
      states.set(key, control)
      await store.write(key, control)
      return { control, changed, persisted: store.persisted }
    },
    /** 测试用：清空登记表。 */
    reset() {
      states.clear()
      loaded.clear()
    },
    /** 等写链排空（测试用；生产中不 await）。 */
    flush: () => store.flush(),
  }
}

/**
 * 一个后端只留一个登记表 —— **这是真机验收时抓到的一条真缺陷的修法**。
 *
 * DSH 会在同一个进程里把插件加载很多次（实测 `[dsh-knit] route ready` 在一次运行里
 * 出现十几次），而 json 后端的 kv 单元**只允许一个活句柄**（原话
 * `unit 'x' is already open; a unit has exactly one live handle`，而且它抛的是**普通
 * Error**，不是 StorageError）。每次加载各开一次 ⇒ 第一次之后全部 open 失败，
 * 而 `controlRegistry` 这个模块级变量被**最后一次**加载覆盖 ⇒ 活跃实例恰恰是打不开的
 * 那个，`persisted` 恒 false（且 `~/.dsh/storages/knit_control.json` 永远不出现）。
 *
 * 句柄挂在**后端对象**上（同一进程里是同一个实例），后加载的实例复用它 —— 内存态与
 * 落盘态因此对所有实例是同一份。后端拿不到就返回 `null`（调用方退回内存态）。
 *
 * @param {object|null} backend - `ctx.storage` 里取到的 kv 后端
 * @returns {object|null} 该后端唯一的登记表，或 null
 */
export function sharedControlRegistry(backend) {
  if (!backend || typeof backend !== 'object') return null
  if (!backend[CONTROL_SHARED]) backend[CONTROL_SHARED] = createControlRegistry({ backend })
  return backend[CONTROL_SHARED]
}

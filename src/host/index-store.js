/**
 * v0.22 · 增量上下文索引的**持久层**。
 *
 * 这个模块只做一件事：把「一个工作区里每个候选文件是谁、什么时候变的、头部指纹是什么」
 * 存进 DSH 自己的存储（`ctx.storage` 的 KV facet），让**进程重启后**不必重读、重解析
 * 未变化的文件。**它不参与排序，不缓存正文。**
 *
 * ── 三条硬约束（来源：`Knit-v0.22-Phase0-审计.md` §4 §5）────────────────
 *
 * 1. **不存正文，也不存原文首部**（裁决 A + 修法 ①，见决策记录）。
 *    索引值 = `{root, rel, mtimeMs, size, headHash, title, summary, refs}`：
 *    · `body`（整篇正文）**永远不进索引** —— 正文永远来自当次读取 ⇒ 不可能出现
 *      「持久化的正文与磁盘漂移」这类静默错误；
 *    · `head`（16KB 原文首部）**也不进索引**，改存 `refs` = **抽取后的**引用/导入列表
 *      （Markdown 存 `extractRefsWithLines()` 的 `{raw, line}`：`{md, any}` 两套，
 *      默认口径与 `anyExt` 各一套，分别喂给引用图与关系投影；代码存 `importsOf()` 的
 *      `{spec, line}`）。理由：两个下游消费者（`relations.js` / `buildLinkGraph()`）
 *      **只要抽取结果，不要原文** —— 存 16KB 原文会让索引体积 ≈ 源码体积，
 *      而 `KvUnit` 只有 `loadAll()`（没有按需取单条），于是每一次要用索引的扫描
 *      都要为「加载一份和源码一样大的 JSON」付钱（实测让默认的相关检索在重启后
 *      比 v0.21 慢 1.31×）。抽取结果小一个量级，这个代价随之消失。
 *
 *    ⚠️ `{md, any}` 两套都存、不合并成一套，是**语义精确性**的要求：引用图用的是
 *    `extractRefs()` 的默认口径（只认 `.md` 目标），关系投影用 `anyExt: true`
 *    （还要认 md→代码）。两者各有自己的 `MAX_REFS_PER_DOC = 500` 截断点，
 *    用一套去近似另一套会在「引用数超过上限」的文件上产生不同的目标集合 ——
 *    那正好是 §6 第 7 条（索引开/关必须一致）会被破坏的地方。
 *
 * 2. **按 canonical workspace root 隔离**。`rel` 只在工作区内唯一 ⇒ 不同工作区的同名
 *    相对路径必须能区分。做法：**键 = `rootHashOf(root) + base64url(rel)`，值里也带
 *    `root`**，读的一侧再按 `value.root === root` 过滤一遍。root 进键是必需的
 *    （只用 rel 会让两个项目里的同名文件抢同一个键、互相覆盖，见 `recordKey()`），
 *    过滤是第二道 —— 键告诉「这是哪个项目」，值里的 root 则是可读的自证。
 *
 *    **归一放在这里，不指望调用方守纪律**：`canonicalRoot()` 每次进出都做一次
 *    `realpathSync`（根不存在时兜底原值）。理由是实测过的真实故障：macOS 的
 *    `/var/folders/...` 与 `/private/var/folders/...` 是同一个目录的两个字符串，
 *    `scan()` 走 `hostPathOf()` 拿到后者、而工具/测试直接用前者调 `collectDocs()`
 *    ⇒ 同一个键被两个 `root` 值轮流覆盖，`value.root === root` 过滤随最后一次写入
 *    摇摆，**索引时灵时不灵且完全不报错**。隔离是 §5② 的硬要求，不能只靠调用方。
 *
 * 3. **任何失败都不许抛进检索路径**。存储不存在、unit 版本不匹配、介质损坏、权限错误
 *    ⇒ `persisted: false` + 一个 `reason`，读返回空 Map，写返回 false。调用方据此退回
 *    现有的全量扫描路径 —— 那是**正常降级**，不是异常分支。
 *
 * 4. **遗留记录确实会被清掉**（清理补丁，v0.22 实施期）。`compatibleVersions` 让老记录
 *    「读得进来」，代价是它们在存储里**永久残留**：新版本的写入路径只会写带 root 指纹的
 *    新键，**永远覆盖不到** `base64url(rel)` 这种旧键。真机上实测到过 164 条这样的残留
 *    （v0.21/v0.22 开发期写入的，对任何工作区都已不可用，却让每次 `loadAll()` 都多付一遍
 *    钱 —— 600 条小记录约 60 ms，正比于**条数**而不是字节数）。
 *    做法：`read()` 把「键与记录不同源」（`keyFitsRecord()`）的键收进清理队列，
 *    `write()` 在**本轮本来就要写盘时**顺手删掉，每次最多 `INDEX_CLEAN_PER_WRITE = 32` 条。
 *    删除幂等，所以不需要事务：中途失败，下一轮接着删。
 *
 * ── 为什么 `per-record` 而不是 `single` ────────────────────────────────
 *
 * `single` 布局整单元一个文档：改一个文件就要重写整份索引（1000 文件 ≈ 数百 KB），
 * 与提示词 §4「已变化文件仅重建对应文件索引」直接冲突。`per-record` 下增删改各只碰
 * 一个文件，正好对上索引的访问模式。代价是键必须满足 `[a-zA-Z0-9_-]+` ⇒ base64url。
 *
 * @module index-store
 */

import { createHash } from 'node:crypto'
import { realpathSync } from 'node:fs'

/** 存储单元名。必须匹配 `UNIT_NAME_RE = /^[a-z][a-z0-9_]*$/`（`dsh-storage` 的真实正则）。 */
export const INDEX_UNIT = 'knit_index'

/**
 * 索引 schema 版本。
 *
 * v1 → v2：v1 的记录没有 `headHash`（只有 `mtimeMs + size` 这一条一致性证据），
 * 而 v0.22 的立论之一就是「不许只靠 mtime+size」。
 * v2 → v3（修法 ①）：v2 的记录存的是 16KB 原文首部 `head`，v3 改存抽取后的 `refs`。
 *
 * 声明的 `compatibleVersions` 让老记录**读得进来**，但缺 `headHash`（v1）或
 * 缺 `refs`（v2）的记录一律视为**未验证**、下一轮直接重建 —— 迁移因此不需要任何
 * 专用代码，也不需要一次性重写整份索引（`recordUsable()` 是唯一的判定处）。
 */
export const INDEX_VERSION = 3

/** 表名（单表：一个工作区的全部文件记录）。 */
export const INDEX_TABLES = ['files']

/**
 * 一次写盘最多顺手清掉多少条「键与记录不同源」的遗留记录（清理补丁）。
 *
 * 为什么必须有上界：清理是**维护索引**的动作，不是这次检索结果的一部分 ——
 * 与对账（每轮扫描最多抽验 `INDEX_VERIFY_PER_PASS = 8` 条）同一条纪律，
 * 不许为了它把一次检索拖长。32 条/次在真机的 164 条残留上 6 轮内清完，
 * 稳态下这个数永远是 0。
 */
export const INDEX_CLEAN_PER_WRITE = 32

/**
 * 读一个文件头部多少个字节做指纹。
 *
 * 与 `index.js` 的 `HEAD_BYTES = 16 * 1024` 同口径 —— 指纹要覆盖的正是**参与解析与
 * 引用关系抽取的那段字节**。指纹只对**已经读进内存**的头部做哈希，**绝不额外读盘**。
 */
export const INDEX_HEAD_BYTES = 16 * 1024

/**
 * 相对路径 → 存储键。
 *
 * `per-record` 布局把键当成路径片段，必须匹配 `[a-zA-Z0-9_-]+`；`rel` 里有 `/`、`.`、
 * 空格、中文，全都不合法。`base64url` 的输出恰好落在 `[A-Za-z0-9_-]` 内。
 *
 * @param {string} rel - 工作区相对路径（`/` 分隔）
 * @returns {string} 存储键
 */
export function relToKey(rel) {
  return Buffer.from(String(rel), 'utf8').toString('base64url')
}

/**
 * 存储键 → 相对路径（诊断与测试用；生产路径不信这个，信值里的 `rel`）。
 * @param {string} key - 存储键
 * @returns {string} 相对路径，解不开返回空串
 */
export function keyToRel(key) {
  try {
    return Buffer.from(String(key).slice(ROOT_HASH_CHARS), 'base64url').toString('utf8')
  } catch {
    return ''
  }
}

/** root 指纹占多少个 hex 字符（定长 ⇒ 键可无歧义切分）。 */
export const ROOT_HASH_CHARS = 16

/**
 * 工作区根的短指纹。
 * @param {string} root - canonical 工作区根
 * @returns {string} 16 个 hex 字符
 */
export function rootHashOf(root) {
  return createHash('sha256').update(String(root), 'utf8').digest('hex').slice(0, ROOT_HASH_CHARS)
}

/**
 * `(工作区根, 相对路径)` → 存储键。
 *
 * ⚠️ **键里必须带 root 指纹，不能只用 `base64url(rel)`**。这是写测试时抓到的一个真
 * 故障：只用 rel 的话，两个工作区里同名的 `a.md` 会**共用一个键**，谁后写谁留下
 * —— 读的一侧虽然靠 `value.root` 过滤守住了「不返回别的项目的内容」，但先前那个
 * 工作区的记录被**覆盖**掉了，于是每在两个项目间切一次就整份重建一次，而且
 * `put`/`del` 的差量会互相打架。带上 root 指纹后两个工作区的记录**共存**，
 * 与 `control.js` 用 `root + NUL + rel` 当键是同一种语义。
 *
 * 拼接不用分隔符：`base64url` 的字符集含 `-` 和 `_`，任何分隔符都可能出现在后半段
 * 里。指纹**定长 16 hex**，于是 `keyToRel()` 直接 `slice(16)` 即可无歧义还原。
 *
 * @param {string} root - canonical 工作区根
 * @param {string} rel - 工作区相对路径（`/` 分隔）
 * @returns {string} 存储键
 */
export function recordKey(root, rel) {
  return rootHashOf(root) + relToKey(rel)
}

/**
 * 键与记录是否**同源** —— 即这个键是不是 `recordKey()` 写出来的。
 *
 * ⚠️ **不能只看前 16 个字符是不是 hex**：`relToKey()` 的输出字符集
 * （`[A-Za-z0-9_-]`）本身就包含 `a-f`/`0-9`，旧键完全可能恰好以 16 个 hex 字符开头，
 * 只查前缀会把它误判成新格式、于是永不清理。这里再加一条「16 位之后解回来必须
 * 逐字等于记录自己的 `rel`」—— 对新格式恒真，对旧键实际不可能。
 *
 * 存在的理由见模块头注释第 4 条：老记录读得进来是**故意的**，但它们必须能被清掉。
 *
 * @param {string} key - 存储里取出的键
 * @param {Record<string, unknown>} row - 同一个键下的值
 * @returns {boolean} 键与记录是否同源
 */
function keyFitsRecord(key, row) {
  if (typeof key !== 'string' || key.length <= ROOT_HASH_CHARS) return false
  for (let i = 0; i < ROOT_HASH_CHARS; i += 1) {
    const c = key.charCodeAt(i)
    const isDigit = c >= 48 && c <= 57
    const isHex = c >= 97 && c <= 102
    if (!isDigit && !isHex) return false
  }
  if (typeof row.rel !== 'string' || row.rel === '') return false
  return keyToRel(key) === row.rel
}

/**
 * 对一段**已在内存里**的文本算内容指纹。
 *
 * ⚠️ 它的作用不是密码学安全，而是「内容变了但 mtime/size 没变」时的第二道证据
 * （提示词 §4：mtime/size 不得作为可靠内容一致性的**唯一**证据）。取 sha256 的前
 * 8 字节（16 hex 字符）足够区分工作区内的文件内容，且让每条记录小到可以忽略。
 *
 * @param {string} text - 文件头部文本
 * @returns {string} 16 个 hex 字符
 */
export function headHashOf(text) {
  return createHash('sha256').update(String(text), 'utf8').digest('hex').slice(0, 16)
}

/**
 * 一条索引记录是否**可用于跳过读盘**。
 *
 * 判定只有一条：元信息齐 + 有指纹。缺任何一项 ⇒ `false` ⇒ 调用方老老实实读盘重建。
 * 这是「证据到之前不说自己知道」在索引层的落实。
 *
 * @param {unknown} record - 存储里取出的值
 * @param {{mtimeMs:number, size:number, headHash:string}} observed - 本次 stat 实测值
 * @returns {boolean} 是否可复用
 */
export function recordMatches(record, observed) {
  if (!record || typeof record !== 'object') return false
  const row = /** @type {Record<string, unknown>} */ (record)
  if (typeof row.headHash !== 'string' || row.headHash.length === 0) return false
  if (typeof row.mtimeMs !== 'number' || typeof row.size !== 'number') return false
  if (row.mtimeMs !== observed.mtimeMs || row.size !== observed.size) return false
  return row.headHash === observed.headHash
}

/**
 * 一条记录的 `refs` 字段是否是**可用的抽取结果**。
 *
 * 形状（`refsForHead()` 产出）：Markdown = `{md: [{raw, line}], any: [{raw, line}]}`；
 * 代码 = `{imports: [{spec, line}]}`。**空数组是合法的**（这个文件确实一条引用都没有）；
 * 字段**缺失**则不可用 —— 「抽出来是空的」与「旧版记录还没重算」必须能区分，
 * 否则 v2 记录会被当成「没有引用」而不是「要重建」，重启后关系会静默少掉。
 *
 * @param {unknown} refs - 记录上的 `refs`
 * @returns {boolean} 是否可用
 */
export function refsShapeOk(refs) {
  if (!refs || typeof refs !== 'object' || Array.isArray(refs)) return false
  const row = /** @type {Record<string, unknown>} */ (refs)
  const keys = ['md', 'any', 'imports'].filter((k) => row[k] !== undefined)
  if (keys.length === 0) return false
  for (const k of keys) {
    const list = row[k]
    if (!Array.isArray(list)) return false
    for (const hit of list) {
      if (!hit || typeof hit !== 'object') return false
      const item = /** @type {Record<string, unknown>} */ (hit)
      const raw = typeof item.raw === 'string' ? item.raw : item.spec
      if (typeof raw !== 'string' || raw === '') return false
    }
  }
  return true
}

/**
 * 把工作区根归一成 canonical 形态（展开符号链接）。
 *
 * 见模块头注释第 2 条：隔离必须由这一层自己保证，不能只靠调用方传对路径。
 * 路径不存在时兜底返回原值 —— 索引允许为空，不值得为归一化抛错。
 *
 * @param {string} path - 工作区根
 * @returns {string} canonical 路径
 */
export function canonicalRoot(path) {
  try {
    return realpathSync(path)
  } catch {
    // 路径不存在 / 无权限 ⇒ 保持原字符串。索引本身允许为空，不值得为归一化抛错。
    return String(path)
  }
}

/**
 * 创建索引存储。
 *
 * 形状与 `src/host/control.js:188` 的 `createControlStore()` 一致，理由一样：Knit 的宿主
 * 半边不许因为「存储没接上」而抛错。`persisted` **只在读成功或写成功后**才是 true。
 *
 * @param {{backend?: object|null}} [options] - `backend.kv.open(descriptor)` 是唯一依赖
 * @returns {{persisted:boolean, reason:string, cleaned:number, read:Function, write:Function, flush:Function}}
 */
export function createIndexStore(options = {}) {
  // ⚠️ 显式传 `null` 时默认参数不生效（`apply()` 启动那一刻就是 `null`），
  // 所以这里再收一道 —— 「没有存储」是**正常路径**，不是 TypeError。
  const backend = options && options.backend
  const kv = backend && typeof backend === 'object' ? backend.kv : null
  if (!kv || typeof kv.open !== 'function') {
    return {
      persisted: false,
      reason: 'no-storage',
      cleaned: 0,
      read: async () => new Map(),
      write: async () => false,
      flush: async () => false,
    }
  }

  let opening = null
  let writes = Promise.resolve()
  /** 每个 root 上一次读/写后的键集合 —— 写的时候只写差量。 */
  const lastWritten = new Map()
  /** 上次 `read()` 看到的「键与记录不同源」的键（清理补丁），等下一次写盘顺手清掉。 */
  let staleKeys = new Set()

  const openUnit = () => {
    if (!opening) {
      opening = Promise.resolve()
        .then(() => kv.open({
          name: INDEX_UNIT,
          version: INDEX_VERSION,
          tables: INDEX_TABLES,
          hasGlobal: false,
          // 见模块头注释「为什么 per-record」。
          layout: 'per-record',
          // v1（缺 headHash）/ v2（存的是 head 而不是 refs）记录都读得进来，
          // 但过不了 `recordUsable()` ⇒ 视为未验证，下一轮重建。
          compatibleVersions: [1, 2],
        }))
        .then((unit) => unit)
        .catch(() => null) // version-mismatch / malformed-medium / 不支持 ⇒ 当空
    }
    return opening
  }

  const store = {
    persisted: false,
    reason: 'unproven',
    /**
     * 累计清掉了多少条「键与记录不同源」的遗留记录（清理补丁，**累计**值）。
     *
     * 刻意不塞进 `indexStatsFor()`：`write()` 是 fire-and-forget，那一刻计数可能
     * 还没落地，报进统计就会是「有时对、有时落后一轮」的读数。清理的证据看这里
     * （测试断言）与真机上的记录条数下降。
     */
    cleaned: 0,
    /**
     * 读一个工作区的索引。任何失败 ⇒ 空 Map（调用方退回全量扫描），绝不抛。
     * @param {string} root - canonical 工作区根
     * @returns {Promise<Map<string, object>>} rel → 记录
     */
    read: async (rawRoot) => {
      const root = canonicalRoot(rawRoot)
      try {
        const unit = await openUnit()
        if (!unit) {
          store.persisted = false
          store.reason = 'open-failed'
          return new Map()
        }
        const all = await unit.loadAll()
        const tables = (all && all.tables) || {}
        const rows = (tables[INDEX_TABLES[0]] && typeof tables[INDEX_TABLES[0]] === 'object')
          ? tables[INDEX_TABLES[0]]
          : {}
        const out = new Map()
        const keys = new Set()
        const stale = new Set()
        for (const [key, value] of Object.entries(rows)) {
          if (!value || typeof value !== 'object') continue
          const row = /** @type {Record<string, unknown>} */ (value)
          if (typeof row.rel !== 'string' || row.rel.length === 0) continue
          // 清理补丁：键不是 `recordKey()` 的形状 ⇒ 旧格式（或损坏键）的残留。
          // 它们对**任何**工作区都不可用（本版本的写入路径永远覆盖不到它们），
          // 所以判定放在 root 过滤**之前**：它们本来就不属于任何当前工作区。
          const fits = keyFitsRecord(key, row)
          if (!fits) stale.add(key)
          // 工作区隔离：同一张表里装着所有工作区，靠值里的 root 过滤。
          if (row.root !== root) continue
          // ⚠️ **只有同源的键**才算「本工作区已落盘的键」。旧格式键永远不会由本版本写出，
          // 把它们算进来会让下面清理时的 `keys.has()` 守卫永远拦住自己（写测试时踩到过）。
          if (fits) keys.add(key)
          out.set(row.rel, row)
        }
        lastWritten.set(root, keys)
        staleKeys = stale
        store.persisted = true
        store.reason = 'ok'
        return out
      } catch {
        store.persisted = false
        store.reason = 'read-failed'
        return new Map()
      }
    },
    /**
     * 写差量：只新增 / 覆盖 / 删除这一轮真正变化的记录。
     *
     * fire-and-forget（与 `control.js` 同策略）：写失败就记一笔并保持内存态，
     * 不重试风暴；下一轮扫描会再试一次。
     *
     * @param {string} root - canonical 工作区根
     * @param {{put?: Array<object>, del?: string[]}} diff - `put` 带 `rel` 的记录数组，`del` 是 rel 数组
     * @returns {Promise<boolean>} 是否落盘成功
     */
    write: async (rawRoot, diff) => {
      const root = canonicalRoot(rawRoot)
      const puts = (diff && Array.isArray(diff.put)) ? diff.put : []
      const dels = (diff && Array.isArray(diff.del)) ? diff.del : []
      writes = writes.then(async () => {
        const unit = await openUnit()
        if (!unit) {
          store.persisted = false
          store.reason = 'open-failed'
          return false
        }
        const keys = lastWritten.get(root) || new Set()
        for (const record of puts) {
          if (!record || typeof record.rel !== 'string' || !record.rel) continue
          const key = recordKey(root, record.rel)
          await unit.putRecord(INDEX_TABLES[0], key, { ...record, root })
          keys.add(key)
        }
        for (const rel of dels) {
          const key = recordKey(root, rel)
          // 幂等：删一个不存在的键是 no-op，所以这里不必先查存在性。
          await unit.deleteRecord(INDEX_TABLES[0], key)
          keys.delete(key)
        }
        lastWritten.set(root, keys)
        // 清理补丁：顺手清掉上次 `read()` 记下的遗留键。只在「本轮本来就要写盘」时执行
        // （不为清理单独触发一次写），每次有上界，删不存在的键是 no-op（所以幂等）。
        let cleaned = 0
        for (const key of staleKeys) {
          if (cleaned >= INDEX_CLEAN_PER_WRITE) break
          // 防御的是「读与写之间这条键被本工作区重新合法写下」这个窗口；不可用的残留键
          // 按定义进不了 `keys`（`keyFitsRecord()` 只放行同源的键）。
          if (keys.has(key)) continue
          await unit.deleteRecord(INDEX_TABLES[0], key)
          staleKeys.delete(key)
          cleaned += 1
        }
        if (cleaned > 0) store.cleaned += cleaned
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
     * 等写链排空（测试与「退出前收尾」用）。生产中不 await。
     * @returns {Promise<boolean>} 排空后的结果
     */
    flush: async () => {
      try {
        await writes
        return true
      } catch {
        return false
      }
    },
  }
  return store
}

/**
 * DSH 会在**同一个进程里反复加载插件**，而 kv 单元只允许一个活句柄
 * （同名 unit 未关闭再 open 会 reject）。每个加载各建一个 store 的话，只有第一次
 * 开得成，而模块级变量会被最后一次加载覆盖 ⇒ **活跃实例恰恰是打不开的那个**
 * （v0.21 在 `control.js` 上真的踩到过这条，见 `AGENTS.md` 与 `knit/CHANGELOG.md`）。
 *
 * 修法与 `sharedControlRegistry()` 同源：把登记表挂在**后端对象自己**的
 * `Symbol.for('dsh-knit.index')` 上 —— 后端是 DSH 传进来的同一个对象，
 * 因此跨加载次数稳定共享。
 *
 * @param {object|null} backend - `backend.kv.open` 可用的后端
 * @returns {object|null} 共享的 index store（后端不可用时为 null）
 */
export function sharedIndexStore(backend) {
  if (!backend || typeof backend !== 'object') return null
  const key = Symbol.for('dsh-knit.index')
  if (backend[key]) return backend[key]
  const store = createIndexStore({ backend })
  try {
    Object.defineProperty(backend, key, { value: store, enumerable: false, configurable: true })
  } catch {
    return store
  }
  return store
}

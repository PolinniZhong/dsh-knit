/**
 * **对话里「工具产出」的图**（v0.25）。
 *
 * 为什么要这个模块：在对话里生成的图**不在工作区里** —— 它们落在 DSH 的附件库
 * `<dsh home>/attachments/v1/objects/<前两位>/<sha256>`，而 Knit 的扫描只能看会话工作区内，
 * 所以那些图在媒体档里一个都看不到。
 *
 * 为了看到它们，这个模块只走一条**窄路**（与 L1 §6.9 / `SECURITY.md` 同一条纪律）：
 *
 * 1. **列表从事件来，不从盘来** —— 会话事件里本来就带着完整元数据
 *    （`attachmentId: sha256:…` / `mediaType` / `width` / `height` / `bytes` / `name`），
 *    所以「本会话有哪些图」**零 I/O**。
 * 2. **只认 `tool/result` 里的图** —— 那是工具产出的（模型生成的）；用户自己贴的图走
 *    `user/message` / `agent/inbox/spliced`，**默认不进媒体档**（隐私更保守）。
 * 3. **字节只按 sha256 读** —— 路由不接受任何路径，只接受 `sha256:<64 hex>`；
 *    而且**只有本会话出现过**的 id 才允许读（跨会话一律 404）。
 * 4. **去重不扫全库** —— 附件 id 就是内容的 sha256，所以「工作区里已经有了吗」只要拿
 *    **大小相同**的候选文件算哈希即可（候选来自扫描结果里现成的 `size`，零额外 stat）。
 *
 * 纯函数与 I/O 分离：`attachmentsFromEvent` / `dropSaved` / `objectPath` 都能用假件真断言，
 * 真正读盘只在 `readAttachment` 一处。
 */

import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** 一条附件 id 的**唯一**合法形状。这是整个边界的地基：只认内容哈希，不认路径。 */
const ATTACHMENT_ID_RE = /^sha256:([0-9a-f]{64})$/

/** 每个会话最多记多少条（超了丢最老的）。 */
const MAX_ATTACHMENTS_PER_SESSION = 200
/** 最多跟踪多少个会话（LRU；进程重启即失）。 */
const MAX_TRACKED_SESSIONS = 24
/** 单个附件的字节上限 —— 与图片上限同档，超过的不列（既不列也不读）。 */
export const MAX_ATTACHMENT_BYTES = 12 * 1024 * 1024

/** 只认这两种媒体类型：媒体档本来就只显示图片与视频。 */
const MEDIA_RE = /^(image|video)\/[a-z0-9][a-z0-9.+-]*$/i

/**
 * 是不是一条合法的附件 id。
 * @param {unknown} value - 候选值
 * @returns {boolean} 合法与否
 */
export function isAttachmentId(value) {
  return ATTACHMENT_ID_RE.test(String(value == null ? '' : value))
}

/**
 * 取出 id 里的十六进制（不合法时回空串）。
 * @param {unknown} value - 候选值
 * @returns {string} 64 位十六进制
 */
export function attachmentHex(value) {
  const m = ATTACHMENT_ID_RE.exec(String(value == null ? '' : value))
  return m ? m[1] : ''
}

/**
 * 附件库的根目录。
 *
 * 优先 `DSH_HOME`（宿主自己也是这么定的），否则 `<用户目录>/.dsh`。
 * **这是本插件唯一一处读工作区之外的地方** —— 见模块顶部那四条边界。
 *
 * @param {Record<string, string|undefined>} [env] - 环境变量（测试可注入）
 * @returns {string} 绝对路径
 */
export function attachmentsRoot(env = process.env) {
  const home = env && typeof env.DSH_HOME === 'string' && env.DSH_HOME ? env.DSH_HOME : join(homedir(), '.dsh')
  return join(home, 'attachments', 'v1', 'objects')
}

/**
 * 一条 id 对应的对象文件路径。
 *
 * 路径**由哈希算出来**（前两位做目录，与 DSH 的布局一致），所以调用方给不出一个
 * 能穿越到别处的路径 —— 不是「校验字符串里有没有 `..`」，而是**根本没有接受路径的入口**。
 *
 * @param {string} root - 附件库根
 * @param {unknown} id - 附件 id
 * @returns {string} 绝对路径（id 不合法时回空串）
 */
export function objectPath(root, id) {
  const hex = attachmentHex(id)
  if (!hex || typeof root !== 'string' || !root) return ''
  return join(root, hex.slice(0, 2), hex)
}

/**
 * 从**一条会话事件**里取出工具产出的图。
 *
 * 只认 `tool/result`：那是工具（模型）产出的。用户自己贴的图在 `user/message` /
 * `agent/inbox/spliced` 里，**这里刻意不收**。
 *
 * @param {object} event - 会话事件
 * @returns {{id:string, name:string, mediaType:string, kind:'image'|'video', width:number, height:number, bytes:number, at:number}[]} 元数据（可能为空）
 */
export function attachmentsFromEvent(event) {
  if (!event || event.type !== 'tool/result') return []
  const data = event.data && typeof event.data === 'object' ? event.data : {}
  const message = data.message && typeof data.message === 'object' ? data.message : {}
  const content = Array.isArray(message.content) ? message.content : []
  const out = []
  for (const part of content) {
    if (!part || typeof part !== 'object') continue
    if (part.type !== 'image' && part.type !== 'video') continue
    const meta = part.attachment
    if (!meta || typeof meta !== 'object') continue
    const id = typeof meta.attachmentId === 'string' ? meta.attachmentId : ''
    if (!isAttachmentId(id)) continue
    const mediaType = typeof meta.mediaType === 'string' ? meta.mediaType : ''
    if (!MEDIA_RE.test(mediaType)) continue
    const bytes = Number.isFinite(meta.bytes) ? meta.bytes : 0
    // 太小的多半不是图；太大的**不列也不读**（宁可漏，不去搬 12 MB 以上的东西）
    if (!(bytes > 0) || bytes > MAX_ATTACHMENT_BYTES) continue
    const kind = mediaType.toLowerCase().indexOf('video/') === 0 ? 'video' : 'image'
    const name = typeof meta.name === 'string' && meta.name.trim() ? meta.name.trim() : `attachment-${attachmentHex(id).slice(0, 8)}`
    out.push({
      id,
      name,
      mediaType: mediaType.toLowerCase(),
      kind,
      width: Number.isFinite(meta.width) ? meta.width : 0,
      height: Number.isFinite(meta.height) ? meta.height : 0,
      bytes,
      at: Number.isFinite(event.time) ? event.time : 0,
    })
  }
  return out
}

/**
 * 一个**有界**的附件登记簿（只活在内存里，进程重启即失）。
 *
 * 它存在的唯一理由：`/api/attachment` 必须能回答「这个 id 在本会话里出现过吗」。
 * 没有这条判断，任何拿到哈希的人都能读附件库 —— 那就等于开了一个任意读。
 *
 * @param {{maxSessions?:number, maxPerSession?:number}} [options] - 上限
 * @returns {{note:Function, list:Function, get:Function, has:Function, reset:Function, size:number}} 登记簿
 */
export function createAttachmentStore(options = {}) {
  const maxSessions = Number.isFinite(options.maxSessions) ? options.maxSessions : MAX_TRACKED_SESSIONS
  const maxPerSession = Number.isFinite(options.maxPerSession) ? options.maxPerSession : MAX_ATTACHMENTS_PER_SESSION
  /** @type {Map<string, Map<string, object>>} 会话 → (id → 元数据)，插入顺序即先后 */
  const bySession = new Map()

  const touch = (sessionId) => {
    let bag = bySession.get(sessionId)
    if (!bag) {
      bag = new Map()
      bySession.set(sessionId, bag)
    } else {
      // 触达即把会话挪到 LRU 队尾
      bySession.delete(sessionId)
      bySession.set(sessionId, bag)
    }
    return bag
  }

  return {
    /**
     * 记一条事件（不是带图的事件就什么都不做 —— 默认成本是一次类型判断）。
     * @param {string} sessionId - 会话 id
     * @param {object} event - 会话事件
     * @returns {number} 这条事件里记下的图数
     */
    note(sessionId, event) {
      if (typeof sessionId !== 'string' || !sessionId) return 0
      const items = attachmentsFromEvent(event)
      if (!items.length) return 0
      const bag = touch(sessionId)
      for (const item of items) bag.set(item.id, item)
      while (bag.size > maxPerSession) bag.delete(bag.keys().next().value)
      while (bySession.size > maxSessions) bySession.delete(bySession.keys().next().value)
      return items.length
    },
    /**
     * 本会话登记过的图（按先后顺序）。
     * @param {string} sessionId - 会话 id
     * @returns {object[]} 副本
     */
    list(sessionId) {
      const bag = bySession.get(sessionId)
      return bag ? [...bag.values()] : []
    },
    /**
     * 取一条（读字节前要用它拿 `mediaType` / `bytes`）。
     * @param {string} sessionId - 会话 id
     * @param {string} id - 附件 id
     * @returns {object|undefined} 元数据
     */
    get(sessionId, id) {
      const bag = bySession.get(sessionId)
      return bag ? bag.get(id) : undefined
    },
    /**
     * 这个 id 在本会话里出现过吗（**读字节的唯一闸门**）。
     * @param {string} sessionId - 会话 id
     * @param {string} id - 附件 id
     * @returns {boolean} 出现与否
     */
    has(sessionId, id) {
      return Boolean(this.get(sessionId, id))
    },
    reset() {
      bySession.clear()
    },
    get size() {
      return bySession.size
    },
  }
}

/**
 * 把「工作区里已经有同内容文件」的条目去掉。
 *
 * 附件 id 就是内容的 sha256，所以这里是**内容级**去重，不是文件名去重：
 * 你把图存成什么名字都行，只要字节一样就不会重复出现。
 *
 * 代价刻意压到最低：先按 `bytes` 筛候选（大小不同绝不可能同内容），
 * 只给**大小相同**的那几个候选算哈希 —— 不扫全库、不给每张图算哈希。
 *
 * @param {object[]} items - 本会话登记的图
 * @param {{candidates?:{rel:string,bytes:number}[], sha256Of?:(rel:string)=>Promise<string>|string}} [io] - 候选与哈希器（可注入）
 * @returns {Promise<object[]>} 过滤后的列表
 */
export async function dropSaved(items, io = {}) {
  const list = Array.isArray(items) ? items : []
  if (!list.length) return []
  const candidates = Array.isArray(io.candidates) ? io.candidates : []
  const sha256Of = io.sha256Of
  if (!candidates.length || typeof sha256Of !== 'function') return list.slice()
  const sizes = new Set(list.map((item) => item.bytes))
  const suspects = candidates.filter((c) => c && sizes.has(c.bytes))
  if (!suspects.length) return list.slice()
  const saved = new Set()
  for (const candidate of suspects) {
    let hex = ''
    try { hex = await sha256Of(candidate.rel) } catch { hex = '' }
    if (hex) saved.add(hex)
  }
  return list.filter((item) => !saved.has(attachmentHex(item.id)))
}

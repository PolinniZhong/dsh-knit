/**
 * Knit · 宿主半边
 *
 * 两件事：
 *   1. 扫描会话工作区里的 Markdown，按 mtime 或**与当前对话的相关性**排序后吐给浏览器半边
 *   2. 按需返回单篇正文，供面板内联预览
 *
 * 为什么必须有宿主半边：
 *   - DSH 的 workspaceFiles Remote 协议里没有 mtime
 *     （WorkspaceFileStat.version 是 opaque token 从不解析，WorkspaceDirectoryEntry 只有 name/type/size），
 *     纯客户端做不出「按修改时间倒序」。
 *   - 会话事件（`session.snapshotEvents()`）只有宿主读得到，那正是相关性排序的输入。
 *
 * 零模型、零网络出口：只读本地文件与会话日志。
 */
import { readFile, readdir, stat } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import { homedir } from 'node:os'
import { extractKeywords, rankByRelevance, topicLabel } from './relevance.js'

export const name = 'dsh-knit'

/** 本插件占用的路由前缀。 */
export const ROUTE_PREFIX = '/knit'

/* ── 扫描预算：宁可少列几条，也不能把宿主卡住 ───────────────── */
const MAX_DEPTH = 6
const MAX_DIRS = 500
const MAX_DOCS = 400
/** 图片/视频等媒体产物的扫描上限（与文档分开计数，避免截图刷爆文档列表）。 */
const MAX_MEDIA = 400
const SCAN_BUDGET_MS = 4000
const HEAD_BYTES = 16 * 1024
/** 单次内联预览返回的正文上限（超出截断，面板只做预览不做全量阅读）。 */
const DOC_MAX_BYTES = 512 * 1024
/** 参与相关性打分的正文长度（不需要整篇）。 */
const HAYSTACK_CHARS = 2500

/** 相关性输入：最多回看几条消息、总字符上限。 */
const CONV_MAX_MESSAGES = 6
const CONV_MAX_CHARS = 6000
const CONV_MESSAGE_CHARS = 2000

/**
 * 允许内联渲染的图片类型白名单。
 *
 * `/knit/api/raw` 是按路径读文件的接口，口子必须收窄：只有在这个表里的扩展名才放行，
 * 否则就成了「能读工作区里任意文件」的后门。
 */
const IMAGE_TYPES = new Map([
  ['png', 'image/png'],
  ['jpg', 'image/jpeg'],
  ['jpeg', 'image/jpeg'],
  ['gif', 'image/gif'],
  ['webp', 'image/webp'],
  ['avif', 'image/avif'],
  ['bmp', 'image/bmp'],
  ['ico', 'image/x-icon'],
  ['svg', 'image/svg+xml'],
])

/**
 * 允许内联渲染的视频类型白名单。
 * 与 IMAGE_TYPES 同样的口径：只放行表里的扩展名，/raw 不读其它任何文件。
 */
const VIDEO_TYPES = new Map([
  ['mp4', 'video/mp4'],
  ['m4v', 'video/mp4'],
  ['webm', 'video/webm'],
  ['mov', 'video/quicktime'],
  ['ogv', 'video/ogg'],
])

/** 单张内联图片的字节上限。 */
const MAX_IMAGE_BYTES = 12 * 1024 * 1024
/**
 * 单个视频的字节上限。
 * Agent 生成的短视频通常几十 MB；放宽到 256MB，再大就该用系统播放器打开，
 * 而不是让侧边栏扛着整段字节。
 */
const MAX_VIDEO_BYTES = 256 * 1024 * 1024

/** 列表条目类型：文档 / 图片 / 视频。 */
const KIND_DOC = 'md'
const KIND_IMAGE = 'image'
const KIND_VIDEO = 'video'

/**
 * 机器可读的错误码。
 *
 * 宿主**不返回面向用户的文案** —— 文案由浏览器半边按当前语言翻译。
 * 这样宿主不必知道 UI 语言，以后加语言也不用动宿主。
 */
export const ERROR_CODES = {
  outsideWorkspace: 'knit/outside-workspace',
  markdownOnly: 'knit/markdown-only',
  notFound: 'knit/not-found',
  notAFile: 'knit/not-a-file',
  imageOnly: 'knit/image-only',
  imageTooLarge: 'knit/image-too-large',
  mediaOnly: 'knit/media-only',
  mediaTooLarge: 'knit/media-too-large',
  readFailed: 'knit/read-failed',
  missingRel: 'knit/missing-rel',
  notFoundRoute: 'knit/not-found-route',
  loopbackOnly: 'knit/loopback-only',
  methodNotAllowed: 'knit/method-not-allowed',
  internal: 'knit/internal',
}

/** 摘要截断长度（需求文档写 20-32 字，演示阶段放宽到 60 更好读）。 */
export const SUMMARY_CHARS = 60

/** 明显的噪音目录，不进。 */
const SKIP_DIRS = new Set([
  'node_modules', '.git', '.hg', '.svn', '.DSH', '.dsh',
  'dist', 'build', 'out', '.next', '.nuxt', '.cache', '.turbo',
  '__pycache__', '.venv', 'venv', 'env', 'target', 'coverage',
  '.idea', '.vscode', '.gradle', 'Pods', 'DerivedData',
])

/* ── 解析结果缓存：key = 绝对路径，mtime+size 未变则直接复用 ──── */
/** @type {Map<string, object>} */
const cache = new Map()

/* ── 对话关键词缓存：key = sessionId，seq 未变则直接复用 ─────── */
/** @type {Map<string, {seq:number, keywords:Array<{term:string,weight:number}>}>} */
const convCache = new Map()

/** 会话里没有对话时的兜底关键词（空）。 */
const NO_KEYWORDS = []

/**
 * 去掉 Markdown 行内标记，留下一句干净的纯文本。
 * @param {string} line - 原始行
 * @returns {string} 清洗后的行
 */
function stripInline(line) {
  return line
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')       // 图片
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')    // 链接 → 文字
    .replace(/`([^`]*)`/g, '$1')                // 行内代码
    .replace(/[*_~]/g, '')                      // 强调
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * 从 Markdown 头部抽「标题 + 首段摘要」。
 *
 * 标题：正文里第一个 `# xxx`，没有就用文件名（去掉 .md）。
 * 摘要：跳过 YAML frontmatter / 标题行 / 代码围栏 / 列表 / 引用 / 表格，
 *       取第一段真正的正文文字。
 *
 * @param {string} head - 文件头部若干字节的文本
 * @param {string} fileName - 文件名（无路径）
 * @returns {{title:string, summary:string}} 解析结果
 */
export function parseMarkdown(head, fileName) {
  const fallbackTitle = fileName.replace(/\.md$/i, '')
  const lines = head.split(/\r?\n/)

  let title = ''
  let summary = ''
  let inFence = false
  let i = 0

  // 跳过开头可能存在的 YAML frontmatter
  if (lines[0] !== undefined && lines[0].trim() === '---') {
    for (i = 1; i < lines.length; i += 1) {
      if (lines[i].trim() === '---') { i += 1; break }
    }
  }

  for (; i < lines.length; i += 1) {
    const line = lines[i].trim()

    if (/^(```|~~~)/.test(line)) { inFence = !inFence; continue }
    if (inFence) continue

    if (!title) {
      const m = /^#\s+(.+)$/.exec(line)
      if (m) { title = stripInline(m[1]); continue }
    }
    if (summary) continue
    if (!line) continue
    if (/^#{1,6}\s/.test(line)) continue          // 其它级标题
    if (/^([-*+]|\d+\.)\s/.test(line)) continue   // 列表
    if (/^>/.test(line)) continue                 // 引用
    if (/^\|/.test(line)) continue                // 表格
    if (/^([-*_]\s*){3,}$/.test(line)) continue   // 分隔线
    if (/^</.test(line)) continue                 // HTML 块

    const cleaned = stripInline(line)
    if (cleaned) summary = cleaned
  }

  if (!title) title = fallbackTitle
  if (summary.length > SUMMARY_CHARS) summary = `${summary.slice(0, SUMMARY_CHARS)}…`

  return { title, summary }
}

/**
 * 读一个 Markdown 文件的元信息，命中缓存则跳过读盘。
 * @param {string} absPath - 绝对路径
 * @returns {Promise<object|null>} 解析结果（含小写 haystack），读失败返回 null
 */
async function readDoc(absPath) {
  let st
  try {
    st = await stat(absPath)
  } catch {
    return null
  }
  if (!st.isFile()) return null

  const hit = cache.get(absPath)
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit

  let head = ''
  try {
    const buf = await readFile(absPath)
    head = buf.subarray(0, HEAD_BYTES).toString('utf8')
  } catch {
    return null
  }

  const fileName = absPath.split(sep).pop() || absPath
  const { title, summary } = parseMarkdown(head, fileName)
  const entry = {
    mtimeMs: st.mtimeMs,
    size: st.size,
    title,
    summary,
    hayTitle: title.toLowerCase(),
    haySummary: summary.toLowerCase(),
    hayBody: head.slice(0, HAYSTACK_CHARS).toLowerCase(),
  }
  cache.set(absPath, entry)
  return entry
}

/**
 * 按扩展名判定文件是不是 Knit 要管的产物。
 * @param {string} name - 文件名
 * @returns {''|'md'|'image'|'video'} 类型，都不是返回空串
 */
function kindOfName(name) {
  const ext = (name.split('.').pop() || '').toLowerCase()
  if (ext === 'md') return KIND_DOC
  if (IMAGE_TYPES.has(ext)) return KIND_IMAGE
  if (VIDEO_TYPES.has(ext)) return KIND_VIDEO
  return ''
}

/**
 * 广度优先扫出工作区里的 Markdown 与媒体文件。
 *
 * 一次遍历同时收两类，目录预算与时间预算共享；文档、媒体各自有数量上限，
 * 截图再多也不会把文档名额挤光。
 *
 * @param {string} root - 工作区根（会话 cwd）
 * @returns {Promise<{md: string[], media: Array<{abs:string, kind:string}>,
 *                    mdTruncated: boolean, mediaTruncated: boolean}>}
 */
async function collectEntries(root) {
  /** @type {string[]} */
  const md = []
  /** @type {Array<{abs:string, kind:string}>} */
  const media = []
  const deadline = Date.now() + SCAN_BUDGET_MS
  /** @type {Array<{dir:string,depth:number}>} */
  const queue = [{ dir: root, depth: 0 }]
  let visited = 0

  while (queue.length > 0) {
    if (visited >= MAX_DIRS
      || (md.length >= MAX_DOCS && media.length >= MAX_MEDIA)
      || Date.now() > deadline) break
    const { dir, depth } = queue.shift()
    visited += 1

    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }

    for (const entry of entries) {
      const abs = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (depth >= MAX_DEPTH) continue
        if (SKIP_DIRS.has(entry.name)) continue
        if (entry.name.startsWith('.')) continue
        queue.push({ dir: abs, depth: depth + 1 })
      } else if (entry.isFile()) {
        const kind = kindOfName(entry.name)
        if (kind === KIND_DOC) {
          if (md.length < MAX_DOCS) md.push(abs)
        } else if (kind === KIND_IMAGE || kind === KIND_VIDEO) {
          if (media.length < MAX_MEDIA) media.push({ abs, kind })
        }
      }
    }
  }

  return {
    md,
    media,
    mdTruncated: md.length >= MAX_DOCS,
    mediaTruncated: media.length >= MAX_MEDIA,
  }
}

/**
 * 读一个媒体文件的元信息（只 stat，绝不读内容 —— 视频可能上百 MB）。
 * @param {string} root - 工作区根
 * @param {{abs:string, kind:string}} item - 扫描阶段记下的媒体项
 * @returns {Promise<object|null>} 列表记录，读失败返回 null
 */
async function readMediaMeta(root, { abs, kind }) {
  let st
  try {
    st = await stat(abs)
  } catch {
    return null
  }
  if (!st.isFile()) return null

  const name = abs.split(sep).pop() || abs
  return {
    kind,
    path: abs,
    rel: relative(root, abs).split(sep).join('/'),
    name,
    // 没有正文可解析，标题就用文件名（去扩展名）。
    title: name.replace(/\.[^.]+$/, ''),
    summary: '',
    size: st.size,
    mtimeMs: st.mtimeMs,
    // 媒体只能靠文件名参与相关性匹配（镜头名、截图名里的关键词）。
    haystack: { title: name.toLowerCase(), summary: '', body: '' },
  }
}

/**
 * 扫出工作区里全部 Markdown 与媒体的元信息（各自按 mtime 倒序）。
 * @param {string} root - 工作区根
 * @returns {Promise<{docs: Array<object>, media: Array<object>,
 *                    truncated: boolean, mediaTruncated: boolean}>}
 */
export async function collectDocs(root) {
  const found = await collectEntries(root)
  const docs = []

  for (const abs of found.md) {
    const meta = await readDoc(abs)
    if (!meta) continue
    docs.push({
      kind: KIND_DOC,
      path: abs,
      rel: relative(root, abs).split(sep).join('/'),
      name: abs.split(sep).pop(),
      title: meta.title,
      summary: meta.summary,
      size: meta.size,
      mtimeMs: meta.mtimeMs,
      haystack: { title: meta.hayTitle, summary: meta.haySummary, body: meta.hayBody },
    })
  }
  docs.sort((a, b) => b.mtimeMs - a.mtimeMs)

  const media = []
  for (const item of found.media) {
    const meta = await readMediaMeta(root, item)
    if (meta) media.push(meta)
  }
  media.sort((a, b) => b.mtimeMs - a.mtimeMs)

  return { docs, media, truncated: found.mdTruncated, mediaTruncated: found.mediaTruncated }
}

/* ── 会话事件 → 对话文本 ────────────────────────────── */

/**
 * 拼一条消息里所有 text block 的文字。
 * @param {object} message - UserMessage / AssistantMessage
 * @returns {string} 文本
 */
function messageText(message) {
  if (!message || !Array.isArray(message.content)) return ''
  let out = ''
  for (const block of message.content) {
    if (block && block.type === 'text' && typeof block.text === 'string') out += `${block.text}\n`
  }
  return out
}

/**
 * 取会话里最近的若干条人机对话文本（**最新在前**）。
 *
 * 只收 `source.kind === 'user'` 的 user/message —— `agent.inject()` 塞进来的
 * 合成上下文（AGENTS.md、skill 内容、文件变更通知）不是用户意图，会把话题带偏。
 *
 * @param {object} session - 宿主会话对象
 * @returns {{texts: string[], seq: number}} 对话文本与最新事件的 seq
 */
function recentConversation(session) {
  let events
  try {
    events = session && typeof session.snapshotEvents === 'function' ? session.snapshotEvents() : null
  } catch {
    return { texts: [], seq: -1 }
  }
  if (!Array.isArray(events) || events.length === 0) return { texts: [], seq: -1 }

  const texts = []
  let seq = -1
  let chars = 0

  for (let i = events.length - 1; i >= 0 && texts.length < CONV_MAX_MESSAGES; i -= 1) {
    const event = events[i]
    if (!event || typeof event.type !== 'string') continue

    let text = ''
    if (event.type === 'user/message') {
      const source = event.data && event.data.source
      if (source && source.kind && source.kind !== 'user') continue
      text = messageText(event.data)
    } else if (event.type === 'assistant/message') {
      text = messageText(event.data && event.data.message)
    } else {
      continue
    }

    if (!text.trim()) continue
    if (seq < 0) seq = event.seq

    const sliced = text.slice(0, CONV_MESSAGE_CHARS)
    texts.push(sliced)
    chars += sliced.length
    if (chars >= CONV_MAX_CHARS) break
  }

  return { texts, seq }
}

/**
 * 取一个会话当前的话题关键词，按最新事件 seq 缓存。
 * @param {object} session - 宿主会话对象
 * @param {string} sessionId - 会话 id（缓存键）
 * @returns {Array<{term:string,weight:number}>} 关键词表
 */
function keywordsFor(session, sessionId) {
  const { texts, seq } = recentConversation(session)
  const hit = convCache.get(sessionId)
  if (hit && hit.seq === seq) return hit.keywords

  const keywords = extractKeywords(texts, 30)
  convCache.set(sessionId, { seq, keywords })
  return keywords
}

/* ── 对外载荷 ───────────────────────────────────────── */

/**
 * 剥掉内部字段，得到发给浏览器的文档记录。
 * @param {object} doc - 内部文档记录
 * @returns {object} 公开记录
 */
function publicDoc(doc) {
  return {
    kind: doc.kind || KIND_DOC,
    path: doc.path,
    rel: doc.rel,
    name: doc.name,
    title: doc.title,
    summary: doc.summary,
    size: typeof doc.size === 'number' ? doc.size : null,
    mtimeMs: doc.mtimeMs,
    score: typeof doc.score === 'number' ? doc.score : null,
  }
}

/**
 * 组装一次列表扫描结果。
 *
 * @param {string} root - 工作区根
 * @param {number} limit - 最多返回多少条
 * @param {{session?: object, sessionId?: string, sort?: string, kind?: string}} options -
 *   排序上下文；`kind` 为 `doc`（默认，仅 Markdown）、`media`（仅图片/视频）或 `all`
 * @returns {Promise<object>} 给浏览器的载荷
 */
export async function scan(root, limit, options = {}) {
  const collected = await collectDocs(root)

  // 默认 doc：旧版客户端 / 悬停浮层不带 kind，行为与「只列 Markdown」时完全一致。
  const kind = options.kind === 'all' || options.kind === 'media' ? options.kind : 'doc'
  let pool
  let truncated
  if (kind === 'media') {
    pool = collected.media
    truncated = collected.mediaTruncated
  } else if (kind === 'all') {
    pool = collected.docs.concat(collected.media).sort((a, b) => b.mtimeMs - a.mtimeMs)
    truncated = collected.truncated || collected.mediaTruncated
  } else {
    pool = collected.docs
    truncated = collected.truncated
  }

  const wantRelevance = options.sort === 'relevance'
  const sessionId = options.sessionId || ''
  let keywords = NO_KEYWORDS
  let mode = 'time'
  let matched = []

  if (wantRelevance) {
    keywords = keywordsFor(options.session, sessionId)
    // 没有对话可依据时老实退回时间序，而不是假装排了个序
    mode = keywords.length > 0 ? 'relevance' : 'time'
  }

  let ordered
  if (mode === 'relevance') {
    const ranked = rankByRelevance(pool, keywords, Date.now())
    ordered = ranked.docs
    // `matched` 是**语料里真实存在**的词。候选词里有相当一部分是跨词边界的碎片
    // （「个插」「件挺」这种），它们一个文档都匹配不上 —— 拿它们当「当前话题」
    // 会把面板那行显示成乱码，所以 topic 与 keywords 都用 matched。
    matched = ranked.matched
  } else {
    ordered = pool.map((doc) => ({ ...doc, score: null }))
  }

  return {
    ok: true,
    root,
    kind,
    total: ordered.length,
    truncated,
    sessionId,
    mode,
    topic: mode === 'relevance' ? topicLabel(matched) : '',
    keywords: mode === 'relevance' ? matched.slice(0, 8) : [],
    docs: ordered.slice(0, limit).map(publicDoc),
  }
}

/**
 * 读一篇文档的完整正文，供面板内联预览。
 *
 * 路径必须落在工作区根之内——`rel` 来自浏览器，按不可信输入处理。
 *
 * @param {string} root - 工作区根
 * @param {string} rel - 工作区相对路径
 * @returns {Promise<object>} 载荷
 */
export async function readDocument(root, rel) {
  // root 由调用方给出，这里自己归一化，不假设它已经 resolve 过
  const base = resolve(root)
  const abs = resolve(base, rel)
  if (abs !== base && !abs.startsWith(base + sep)) {
    return { ok: false, code: ERROR_CODES.outsideWorkspace }
  }
  if (!/\.md$/i.test(abs)) return { ok: false, code: ERROR_CODES.markdownOnly }

  let st
  try {
    st = await stat(abs)
  } catch {
    return { ok: false, code: ERROR_CODES.notFound }
  }
  if (!st.isFile()) return { ok: false, code: ERROR_CODES.notAFile }

  const buf = await readFile(abs)
  const truncated = buf.length > DOC_MAX_BYTES
  const text = buf.subarray(0, DOC_MAX_BYTES).toString('utf8')

  return {
    ok: true,
    rel: relative(base, abs).split(sep).join('/'),
    title: parseMarkdown(text, abs.split(sep).pop() || abs).title,
    bytes: buf.length,
    truncated,
    text,
  }
}

/**
 * 解析一个媒体（图片/视频）路径：越界防护 + 扩展名白名单 + 类型与大小校验。
 *
 * 这是按路径读文件的接口，不设限就等于开了读任意文件的后门：路径必须落在工作区内，
 * 扩展名必须在图片/视频白名单里，视频还有单独的大小上限。
 *
 * 只 stat、不读字节 —— 视频可能上百 MB，字节交给流式接口按需读取。
 *
 * @param {string} root - 工作区根
 * @param {string} rel - 工作区相对路径
 * @returns {Promise<object>} 成功时带 `{ abs, kind, type, size }`，否则带错误码
 */
export async function mediaInfo(root, rel) {
  const base = resolve(root)
  const abs = resolve(base, rel)
  if (abs !== base && !abs.startsWith(base + sep)) {
    return { ok: false, code: ERROR_CODES.outsideWorkspace }
  }

  const ext = (abs.split('.').pop() || '').toLowerCase()
  let kind = KIND_IMAGE
  let type = IMAGE_TYPES.get(ext)
  if (!type) {
    kind = KIND_VIDEO
    type = VIDEO_TYPES.get(ext)
  }
  if (!type) return { ok: false, code: ERROR_CODES.mediaOnly }

  let st
  try {
    st = await stat(abs)
  } catch {
    return { ok: false, code: ERROR_CODES.notFound }
  }
  if (!st.isFile()) return { ok: false, code: ERROR_CODES.notAFile }
  if (kind === KIND_IMAGE && st.size > MAX_IMAGE_BYTES) {
    return { ok: false, code: ERROR_CODES.imageTooLarge }
  }
  if (kind === KIND_VIDEO && st.size > MAX_VIDEO_BYTES) {
    return { ok: false, code: ERROR_CODES.mediaTooLarge }
  }

  return { ok: true, abs, kind, type, size: st.size }
}

/**
 * 解析 HTTP Range 头（只支持 bytes 的单区间，覆盖 `<video>` 首帧与拖动播放的请求形态）。
 *
 * 解析不了（无 Range、多区间、语法怪异）一律返回 null —— 调用方回退成 200 整文件，
 * 而不是因为一个边角 Range 把播放掐死。
 *
 * @param {string|undefined} header - Range 头原值
 * @param {number} size - 文件总字节
 * @returns {{start:number,end:number}|null} 闭区间字节范围；null 表示返回整个文件
 */
export function parseRange(header, size) {
  if (!header || size <= 0) return null
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(header).trim())
  if (!m) return null
  const startRaw = m[1]
  const endRaw = m[2]
  if (startRaw === '' && endRaw === '') return null

  // bytes=-N：最后 N 个字节
  if (startRaw === '') {
    const suffix = Number(endRaw)
    if (!Number.isInteger(suffix) || suffix <= 0) return null
    return { start: Math.max(0, size - suffix), end: size - 1 }
  }

  const start = Number(startRaw)
  if (!Number.isInteger(start) || start < 0 || start >= size) return null
  let end = endRaw === '' ? size - 1 : Number(endRaw)
  if (!Number.isInteger(end) || end < start) end = size - 1
  end = Math.min(end, size - 1)
  return { start, end }
}

/**
 * 解析一个会话的工作区根。
 * @param {object} webCtx - 注入了 sessions 的上下文
 * @param {string} sessionId - 会话 id（可为空）
 * @returns {string} 绝对路径根
 */
function workspaceRootOf(webCtx, sessionId) {
  let root = ''
  try {
    const session = sessionId && typeof webCtx.sessions.get === 'function'
      ? webCtx.sessions.get(sessionId)
      : undefined
    if (session && session.header && typeof session.header.cwd === 'string') root = session.header.cwd
  } catch { /* 会话查不到就走兜底根 */ }
  if (!root) root = process.cwd()
  if (root.startsWith('~')) root = join(homedir(), root.slice(1))
  return resolve(root)
}

/**
 * 解析请求对应的宿主会话对象。
 * @param {object} webCtx - 注入了 sessions 的上下文
 * @param {string} sessionId - 会话 id
 * @returns {object|undefined} 会话对象
 */
function sessionOf(webCtx, sessionId) {
  try {
    return sessionId && typeof webCtx.sessions.get === 'function' ? webCtx.sessions.get(sessionId) : undefined
  } catch {
    return undefined
  }
}

/**
 * 判断来源是不是本机回环。
 * @param {string|undefined} address - socket remoteAddress
 * @returns {boolean} 是否放行
 */
function isLoopback(address) {
  if (!address) return false
  return address === '::1' || address === '127.0.0.1' || address.startsWith('::ffff:127.')
}

/**
 * 写一个 JSON 响应。
 * @param {import('node:http').ServerResponse} res - 响应对象
 * @param {number} status - HTTP 状态码
 * @param {object} body - 载荷
 * @returns {void}
 */
function sendJson(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  res.end(text)
}

/**
 * 流式回一个媒体文件（图片/视频），支持 HTTP Range（206 Partial Content）。
 *
 * 视频首帧与拖动播放都依赖 Range：一次性把上百 MB 读进内存再返回既慢又占内存；
 * createReadStream 按区间读，客户端断开就销毁流。安全头与原图片接口一致：
 * nosniff 防类型嗅探，default-src 'none' + sandbox 让 SVG 脚本/外链失效。
 *
 * @param {import('node:http').IncomingMessage} req - 请求对象
 * @param {import('node:http').ServerResponse} res - 响应对象
 * @param {{abs:string, type:string, size:number}} info - mediaInfo 的成功结果
 * @returns {void}
 */
function sendMedia(req, res, info) {
  const part = parseRange(req.headers.range, info.size)
  /** @type {Record<string, string|number>} */
  const headers = {
    'content-type': info.type,
    'accept-ranges': 'bytes',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'none'; sandbox",
  }

  let stream
  if (part) {
    headers['content-range'] = `bytes ${part.start}-${part.end}/${info.size}`
    headers['content-length'] = part.end - part.start + 1
    res.writeHead(206, headers)
    stream = createReadStream(info.abs, { start: part.start, end: part.end })
  } else {
    headers['content-length'] = info.size
    res.writeHead(200, headers)
    stream = createReadStream(info.abs)
  }

  stream.on('error', () => {
    try { stream.destroy() } catch { /* 已关闭 */ }
    try { res.destroy() } catch { /* 已关闭 */ }
  })
  req.on('close', () => { try { stream.destroy() } catch { /* 已关闭 */ } })
  stream.pipe(res)
}

/**
 * 宿主插件体：等 webServer / sessions 到位后挂只读路由。
 * @param {import('@deepseek-ai/cordis').Context} ctx - 宿主根上下文
 * @returns {void}
 */
export function apply(ctx) {
  ctx.inject(['webServer', 'sessions'], (webCtx) => {
    const handler = async (req, res) => {
      if (!isLoopback(req.socket?.remoteAddress)) {
        sendJson(res, 403, { ok: false, code: ERROR_CODES.loopbackOnly })
        return
      }
      if (req.method !== 'GET') {
        sendJson(res, 405, { ok: false, code: ERROR_CODES.methodNotAllowed })
        return
      }

      const url = new URL(req.url || '/', 'http://localhost')
      const sessionId = url.searchParams.get('sessionId') || ''
      const root = workspaceRootOf(webCtx, sessionId)

      try {
        if (url.pathname === `${ROUTE_PREFIX}/api/recent`) {
          const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 20, 1), 100)
          const sort = url.searchParams.get('sort') === 'relevance' ? 'relevance' : 'time'
          const kindParam = url.searchParams.get('kind')
          const kind = kindParam === 'all' || kindParam === 'media' ? kindParam : 'doc'
          const payload = await scan(root, limit, {
            session: sessionOf(webCtx, sessionId), sessionId, sort, kind,
          })
          sendJson(res, 200, payload)
          return
        }

        if (url.pathname === `${ROUTE_PREFIX}/api/doc`) {
          const rel = url.searchParams.get('rel') || ''
          if (!rel) {
            sendJson(res, 400, { ok: false, code: ERROR_CODES.missingRel })
            return
          }
          const payload = await readDocument(root, rel)
          sendJson(res, payload.ok ? 200 : 404, payload)
          return
        }

        if (url.pathname === `${ROUTE_PREFIX}/api/raw`) {
          const rel = url.searchParams.get('rel') || ''
          if (!rel) {
            sendJson(res, 400, { ok: false, code: ERROR_CODES.missingRel })
            return
          }
          const media = await mediaInfo(root, rel)
          if (!media.ok) {
            sendJson(res, 404, { ok: false, code: media.code })
            return
          }
          sendMedia(req, res, media)
          return
        }

        sendJson(res, 404, { ok: false, code: ERROR_CODES.notFoundRoute })
      } catch (error) {
        sendJson(res, 500, { ok: false, code: ERROR_CODES.internal, detail: String((error && error.message) || error) })
      }
    }

    webCtx.effect(() => {
      const unregister = webCtx.webServer.register({ kind: 'prefix', path: ROUTE_PREFIX, handler })
      console.log(`[${name}] route ready: ${ROUTE_PREFIX}/api/recent, ${ROUTE_PREFIX}/api/doc, ${ROUTE_PREFIX}/api/raw`)
      return () => unregister()
    }, 'dsh-knit: host route')
  })
}

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

/** 单张内联图片的字节上限。 */
const MAX_IMAGE_BYTES = 12 * 1024 * 1024

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
 * 广度优先扫出工作区里的 .md 文件。
 * @param {string} root - 工作区根（会话 cwd）
 * @returns {Promise<string[]>} 绝对路径列表
 */
async function collectMarkdown(root) {
  const found = []
  const deadline = Date.now() + SCAN_BUDGET_MS
  /** @type {Array<{dir:string,depth:number}>} */
  const queue = [{ dir: root, depth: 0 }]
  let visited = 0

  while (queue.length > 0) {
    if (visited >= MAX_DIRS || found.length >= MAX_DOCS || Date.now() > deadline) break
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
      } else if (entry.isFile() && /\.md$/i.test(entry.name)) {
        found.push(abs)
        if (found.length >= MAX_DOCS) break
      }
    }
  }

  return found
}

/**
 * 扫出工作区里全部 Markdown 的元信息（按 mtime 倒序）。
 * @param {string} root - 工作区根
 * @returns {Promise<{docs: Array<object>, truncated: boolean}>} 文档列表
 */
export async function collectDocs(root) {
  const files = await collectMarkdown(root)
  const docs = []

  for (const abs of files) {
    const meta = await readDoc(abs)
    if (!meta) continue
    docs.push({
      path: abs,
      rel: relative(root, abs).split(sep).join('/'),
      name: abs.split(sep).pop(),
      title: meta.title,
      summary: meta.summary,
      mtimeMs: meta.mtimeMs,
      haystack: { title: meta.hayTitle, summary: meta.haySummary, body: meta.hayBody },
    })
  }

  docs.sort((a, b) => b.mtimeMs - a.mtimeMs)
  return { docs, truncated: files.length >= MAX_DOCS }
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
    path: doc.path,
    rel: doc.rel,
    name: doc.name,
    title: doc.title,
    summary: doc.summary,
    mtimeMs: doc.mtimeMs,
    score: typeof doc.score === 'number' ? doc.score : null,
  }
}

/**
 * 组装一次列表扫描结果。
 *
 * @param {string} root - 工作区根
 * @param {number} limit - 最多返回多少条
 * @param {{session?: object, sessionId?: string, sort?: string}} options - 排序上下文
 * @returns {Promise<object>} 给浏览器的载荷
 */
export async function scan(root, limit, options = {}) {
  const { docs, truncated } = await collectDocs(root)

  const wantRelevance = options.sort === 'relevance'
  const sessionId = options.sessionId || ''
  let keywords = NO_KEYWORDS
  let mode = 'time'

  if (wantRelevance) {
    keywords = keywordsFor(options.session, sessionId)
    // 没有对话可依据时老实退回时间序，而不是假装排了个序
    mode = keywords.length > 0 ? 'relevance' : 'time'
  }

  const ordered = mode === 'relevance'
    ? rankByRelevance(docs, keywords, Date.now()).docs
    : docs.map((doc) => ({ ...doc, score: null }))

  return {
    ok: true,
    root,
    total: ordered.length,
    truncated,
    sessionId,
    mode,
    topic: mode === 'relevance' ? topicLabel(keywords) : '',
    keywords: mode === 'relevance' ? keywords.slice(0, 8).map((k) => k.term) : [],
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
 * 读一张内联图片的字节，供预览里的相对路径图片渲染。
 *
 * 与 `readDocument` 同样的越界防护，再叠一层扩展名白名单 —— 这是按路径读文件的接口，
 * 不设限就等于开了一个读任意文件的后门。
 *
 * @param {string} root - 工作区根
 * @param {string} rel - 工作区相对路径
 * @returns {Promise<object>} 成功时带 `type` 与 `bytes`
 */
export async function readImage(root, rel) {
  const base = resolve(root)
  const abs = resolve(base, rel)
  if (abs !== base && !abs.startsWith(base + sep)) {
    return { ok: false, code: ERROR_CODES.outsideWorkspace }
  }

  const ext = (abs.split('.').pop() || '').toLowerCase()
  const type = IMAGE_TYPES.get(ext)
  if (!type) return { ok: false, code: ERROR_CODES.imageOnly }

  let st
  try {
    st = await stat(abs)
  } catch {
    return { ok: false, code: ERROR_CODES.notFound }
  }
  if (!st.isFile()) return { ok: false, code: ERROR_CODES.notAFile }
  if (st.size > MAX_IMAGE_BYTES) return { ok: false, code: ERROR_CODES.imageTooLarge }

  try {
    const bytes = await readFile(abs)
    return { ok: true, type, bytes }
  } catch {
    return { ok: false, code: ERROR_CODES.readFailed }
  }
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
 * 写一个二进制响应（内联图片用）。
 *
 * 安全头是刻意的：`nosniff` 防止浏览器把非图片当图片猜类型；
 * `default-src 'none'` 让 SVG 里的脚本、外链一并失效 —— 即使它被直接打开也跑不起来。
 *
 * @param {import('node:http').ServerResponse} res - 响应对象
 * @param {string} type - Content-Type
 * @param {Buffer} bytes - 文件字节
 * @returns {void}
 */
function sendBytes(res, type, bytes) {
  res.writeHead(200, {
    'content-type': type,
    'content-length': bytes.length,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'none'; sandbox",
  })
  res.end(bytes)
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
          const payload = await scan(root, limit, { session: sessionOf(webCtx, sessionId), sessionId, sort })
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
          const image = await readImage(root, rel)
          if (!image.ok) {
            sendJson(res, 404, { ok: false, code: image.code })
            return
          }
          sendBytes(res, image.type, image.bytes)
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

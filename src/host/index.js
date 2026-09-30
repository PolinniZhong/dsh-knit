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
import { registerKnitDocsTool } from './tool.js'
// v0.12：引用关系。`links.js` **不反过来 import 本文件**（依赖由这里注入），所以没有环。
import { buildLinkGraph, linksOf } from './links.js'
// v0.14：上下文装配。同样由这里注入依赖（`list` / `read`），保持纯函数可单测。
// ⚠️ 这里**只 import `buildContext`**：Context Pack 的文本渲染只在 `tool.js` 的
// `renderToolText()` 里发生（模型看到的是那段文本，不是结构化 JSON）。曾经多导出一个
// `renderContextText` 却没人调用 —— 那是个会与 `tool.js` 漂移的第二渲染器，已删。
import { buildContext } from './context.js'
// v0.15：Context Feedback / Context Audit —— 「Context Pack 之后真的被用了吗」。
// ⚠️ 只做三件确定性的事：从会话事件里抽**真实的 `read`**、把交出去的包记成 Snapshot、
// 把两者接起来算 Usage。**不订阅 event bus、不落盘、不联网、不调模型、不改 Retrieval。**
import {
  createStore, activateAudit, isAudited, ingestEvents, noteSnapshot, usageFor, getAuditSummary,
} from './feedback.js'

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
 * `task` 字段（当前任务的**原文引用**）的长度上限。
 *
 * 右栏要显示它、agent 文本里也会带一行，所以太长的消息会把它变成一个正文块。
 * 截断是这里唯一允许的加工 —— 它不改语义，只是裁剪，超出部分用 `…` 标出。
 */
const TASK_MAX_CHARS = 80

/**
 * 纯应答词表：这些不是任务，是「接着说」。
 *
 * `task` 要回答「现在这个任务是什么」，而「继续」「好的」回答不了这个问题 ——
 * 把它们当任务显示，比空着更糟（空着至少不撒谎）。判定前先按标点切成段，
 * 所以「好的，继续」也命中。
 */
const TASK_ACK = new Set([
  '继续', '好的', '好', '嗯', '嗯嗯', '收到', '谢谢', '可以', '行', '对',
  '是的', '没问题', '辛苦了', '麻烦了',
  'ok', 'okay', 'yes', 'yep', 'y', 'thanks', 'thx', 'gotit', 'continue', 'goon', 'next', 'done',
])

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
 * @returns {Promise<object|null>} 解析结果（含小写 haystack 与原文首部 head），读失败返回 null
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
    // ⚠️ 原文首部**留在缓存里**（v0.14）：上下文装配要用它抽引用关系。
    // 它已经在内存里了 —— 再读一遍盘才是浪费。`publicDoc()` 不会把它发出去。
    head,
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
      // 原文首部：`buildContextFor()` 抽引用关系用（v0.14）。内部字段，不下发。
      head: meta.head,
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
 * 把一段文本压成可显示的单行。
 * @param {string} text - 原始文本
 * @returns {string} 折叠空白后的文本
 */
function tidyText(text) {
  return String(text || '').replace(/\s+/g, ' ').trim()
}

/**
 * 整条消息是否**只由应答词组成**（切成段后逐段查 `TASK_ACK`）。
 * @param {string} tidy - 已折叠空白的文本
 * @returns {boolean} 是否只是应答
 */
function isAcknowledgementOnly(tidy) {
  const parts = tidy.split(/[^\p{L}\p{N}]+/u).filter(Boolean)
  if (parts.length === 0) return false
  return parts.every((part) => TASK_ACK.has(part.toLowerCase()))
}

/**
 * 判断一条用户消息能不能当「任务」引用。
 *
 * 全部是确定性判定，没有任何主观打分：
 *   - 折叠空白后至少 2 个字符；
 *   - 至少含一个字母或汉字（纯数字 / emoji / 符号不算）；
 *   - 不能只是应答词（「继续」「好的」不是任务）。
 *
 * @param {string} text - 用户消息文本
 * @returns {boolean} 是否可作为 `task` 引用
 */
function isSubstantiveTask(text) {
  const tidy = tidyText(text)
  if (tidy.length < 2) return false
  if (!/\p{L}/u.test(tidy)) return false
  return !isAcknowledgementOnly(tidy)
}

/**
 * 把用户消息原文截成 `task` 字段的值。
 * @param {string} text - 用户消息文本
 * @returns {string} 截断后的单行文本
 */
function taskText(text) {
  const tidy = tidyText(text)
  if (tidy.length <= TASK_MAX_CHARS) return tidy
  return `${tidy.slice(0, TASK_MAX_CHARS - 1)}…`
}

/**
 * 取会话里最近的若干条人机对话文本（**最新在前**），外加当前任务的原文引用。
 *
 * 只收 `source.kind === 'user'` 的 user/message —— `agent.inject()` 塞进来的
 * 合成上下文（AGENTS.md、skill 内容、文件变更通知）不是用户意图，会把话题带偏。
 *
 * `task` 与用于检索的窗口**同源**：都只看最近 `CONV_MAX_MESSAGES` 条。这不是偷懒 ——
 * 让「右栏显示的任务」和「实际排序依据的对话」来自两个不同窗口，用户会对不上账。
 *
 * @param {object} session - 宿主会话对象
 * @returns {{texts: string[], seq: number, task: string}} 对话文本、最新事件 seq、任务原文
 */
function recentConversation(session) {
  let events
  try {
    events = session && typeof session.snapshotEvents === 'function' ? session.snapshotEvents() : null
  } catch {
    return { texts: [], seq: -1, task: '' }
  }
  if (!Array.isArray(events) || events.length === 0) return { texts: [], seq: -1, task: '' }

  const texts = []
  let seq = -1
  let chars = 0
  // 从新往旧扫，第一条通过 `isSubstantiveTask()` 的用户消息就是当前任务。
  // 用**第一条**而不是最长的：任务会变，「现在在做什么」由最近那句说了算。
  let task = ''

  for (let i = events.length - 1; i >= 0 && texts.length < CONV_MAX_MESSAGES; i -= 1) {
    const event = events[i]
    if (!event || typeof event.type !== 'string') continue

    let text = ''
    if (event.type === 'user/message') {
      const source = event.data && event.data.source
      if (source && source.kind && source.kind !== 'user') continue
      text = messageText(event.data)
      if (!task && isSubstantiveTask(text)) task = taskText(text)
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

  return { texts, seq, task }
}

/**
 * 取一个会话当前的检索关键词与任务引用，按最新事件 seq 缓存。
 *
 * 两者一起缓存是因为它们**必须来自同一次读数** —— 分开缓存会在「用户刚说完一句话」
 * 的那个 5 秒轮询里出现「词已经更新、任务还是上一句」的错位。
 *
 * @param {object} session - 宿主会话对象
 * @param {string} sessionId - 会话 id（缓存键）
 * @returns {{keywords: Array<{term:string,weight:number}>, task: string}} 关键词表与任务原文
 */
function conversationFor(session, sessionId) {
  const { texts, seq, task } = recentConversation(session)
  const hit = convCache.get(sessionId)
  if (hit && hit.seq === seq) return hit

  const keywords = extractKeywords(texts, 30)
  const entry = { seq, keywords, task }
  convCache.set(sessionId, entry)
  return entry
}

/* ── 对外载荷 ───────────────────────────────────────── */

/**
 * 剥掉内部字段，得到发给浏览器的文档记录。
 *
 * ⚠️ `raw` 与 `matchedTerms` **必须**留在这里被剥掉（v0.14）：它们是上下文装配的
 * 内部输入，泄漏出去就等于对外给了一套第二分数（`test/host.test.mjs` 有守卫）。
 *
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
 * @param {{session?: object, sessionId?: string, sort?: string, kind?: string, query?: string}} options -
 *   排序上下文；`kind` 为 `doc`（默认，仅 Markdown）、`media`（仅图片/视频）或 `all`；
 *   `query` 非空时**用它排序，而不是用当前对话**（v0.7 的 agent 工具走这条路）；
 *   HTTP 路由不传 `query`，所以 `/knit/api/recent` 的行为逐字不变
 * @returns {Promise<object>} 给浏览器的载荷。
 *   ⚠️ **不要把这个对象直接 `sendJson`** —— 它现在带一个 `ranked` 键（全量名次，
 *   含 `raw` 与 `matchedTerms`），是给 `buildContextFor()` 用的**内部输入**。
 *   HTTP 路由必须走 `publicScanPayload()`（`test/host.test.mjs` 有守卫）。
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
  // 当前任务的**原文引用**（SDD §12）。只在「对话驱动」这条路上有值：
  // 显式 query 路径下模型自己知道在问什么，把 query 当「任务」是编的。
  let task = ''

  if (wantRelevance) {
    // 调用方给了明确的 query（v0.7 的 agent 工具走这条路）：把它当成**一条最新的消息**，
    // 于是走的是完全相同的抽取与门槛规则，不引入第二条抽取路径。
    // 不进 convCache —— 那个缓存按 session seq 键控，塞 query 进去会互相污染。
    const explicitQuery = typeof options.query === 'string' ? options.query.trim() : ''
    if (explicitQuery) {
      keywords = extractKeywords([explicitQuery], 30)
    } else {
      const conv = conversationFor(options.session, sessionId)
      keywords = conv.keywords
      task = conv.task
    }
    // 没有对话可依据时老实退回时间序，而不是假装排了个序
    mode = keywords.length > 0 ? 'relevance' : 'time'
  }

  let ordered
  let topic = ''
  if (mode === 'relevance') {
    const ranked = rankByRelevance(pool, keywords, Date.now())
    ordered = ranked.docs
    // 话题标签用 `label`（把命中词的**原文区间合并**后的可读结果），不是 `matched`。
    // 后者是「语料里真实存在的词」，但仍可能是一堆碎片：
    // 「项目文档」的候选是 `项目文` / `目文档`，直接显示就成了「按「目文档、项目文」排序」。
    // `keywords` 字段保持语义不变，仍然是那批真实存在的词。
    topic = topicLabel(ranked.label)
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
    topic,
    keywords: mode === 'relevance' ? matched.slice(0, 8) : [],
    // 全量名次（未按 limit 切片）。**只给上下文装配用**，由 `publicScanPayload()` 剥掉。
    // 放在这里而不是让调用方再扫一遍，是 §二十「不要为了 Context Pack 再扫描一次
    // 整个 Workspace」那条要求的实现：这里复用同一次 `rankByRelevance` 的结果。
    ranked: mode === 'relevance' ? ordered : [],
    // 任务原文。**也不下发**（由 `publicScanPayload()` 一并剥掉）—— 它只喂装配层与右栏。
    // 剥掉不是为了保密（这是用户自己刚说过的话），而是为了不动 v0.13 的响应形状：
    // `context.task` 已经把这个值带出去了，顶层再来一份是重复。
    task: mode === 'relevance' ? task : '',
    docs: ordered.slice(0, limit).map(publicDoc),
  }
}

/**
 * 把 `scan()` 的载荷压成**可以发给浏览器/模型**的那一份。
 *
 * 存在的唯一理由是 `ranked`（全量名次、含 `raw` 与 `matchedTerms`）必须被剥掉 ——
 * 它是装配层的内部输入，发出去就等于对外给了一套第二分数，而且响应体会大好几倍。
 * `task` 同理：装配层已经把它放进 `context.task` 了。
 * HTTP 路由与 agent 工具都只许返回这个函数的产物。
 *
 * @param {object} payload - `scan()` 的产物
 * @returns {object} 公开载荷（与 v0.13 逐字一致，外加 v0.14 的 `context`）
 */
export function publicScanPayload(payload) {
  if (!payload || typeof payload !== 'object') return payload
  const { ranked, task, ...rest } = payload
  void ranked
  void task
  return rest
}

/**
 * 按需建引用图。
 *
 * `withLinks` 为假时**连图都不建** —— 媒体档 / 时间序 / 悬停浮层的条数不需要分层，
 * 不该为它们读全库（这是 §二十「不要为了 Context Pack 再扫描一次整个 Workspace」
 * 那条要求的一半；另一半是复用 `rankByRelevance` 已经算好的名次与命中词）。
 *
 * `read` 用文档记录上现成的 `head`（`collectDocs` 解析 title / summary 时已经读过
 * 同样的 16KB）—— **零额外 I/O**。代价是只看头部 16KB，长文档尾部的引用会漏，
 * 但那只影响「哪些邻居进 Supporting」，不影响任何一篇的名次。
 *
 * @param {string} root - 工作区根
 * @param {boolean} withLinks - 是否要引用关系
 * @param {Map<string, object>} byRel - 本次扫描到的文档（按 rel）
 * @returns {Promise<object|null>} 图或 null
 */
async function linkGraphFor(root, withLinks, byRel) {
  if (!withLinks) return null
  try {
    return await buildLinkGraph(root, {
      list: async () => ({ docs: [...byRel.values()], truncated: false }),
      read: async (_root, rel) => {
        const entry = byRel.get(rel)
        if (!entry || typeof entry.head !== 'string') return { ok: false }
        return { ok: true, text: entry.head }
      },
    })
  } catch {
    // 图建不起来只是少一个上下文信号 —— 分层退化成「只看命中」，不报错。
    return null
  }
}

/**
 * 装配一个工作区的 Context Pack（v0.14）。
 *
 * 顺序固定：`collect → relevance → links → context assembly`，四步复用同一批结果。
 * `ranked` 为空时**不读盘**（媒体档 / 时间序走的就是这条），直接返回空包。
 *
 * @param {string} root - 工作区根
 * @param {{ranked?: Array<object>, topic?: string, task?: string, total?: number, withLinks?: boolean}} [options] -
 *   `ranked` 是 `scan()` 里的全量名次（含 `raw` 与 `matchedTerms`）；
 *   `task` 是当前任务的**原文引用**，原样透传给 `buildContext()`，这里不生成也不改写
 * @returns {Promise<object>} Context Pack
 */
export async function buildContextFor(root, options = {}) {
  const ranked = Array.isArray(options.ranked) ? options.ranked : []
  const total = Number.isInteger(options.total) ? options.total : ranked.length
  const task = typeof options.task === 'string' ? options.task : ''
  const empty = () => buildContext({ ranked: [], topic: options.topic || '', task, total })
  if (ranked.length === 0) return empty()

  const byRel = new Map()
  for (const doc of ranked) {
    if (doc && doc.rel) byRel.set(String(doc.rel), doc)
  }

  const graph = await linkGraphFor(root, options.withLinks !== false, byRel)
  return buildContext({ ranked, topic: options.topic || '', task, total, graph })
}

/**
 * 给 Context Pack 补一份**计数摘要**（不是分数）。
 *
 * 客户端需要它来做两件事：① 在没有可见条目时区分「这个工作区是空的」与
 * 「有文档但当前话题一篇都没命中」；② 显示「相关上下文还有 N 篇」。
 * 数字全部是**集合大小**，没有任何相似度含义。
 *
 * @param {object} pack - `buildContext()` 的产物
 * @returns {object} 带 `summary` 的包
 */
function withStats(pack) {
  const primary = Array.isArray(pack.primary) ? pack.primary : []
  const supporting = Array.isArray(pack.supporting) ? pack.supporting : []
  const related = Array.isArray(pack.related) ? pack.related : []
  return {
    ...pack,
    summary: {
      primary: primary.length,
      supporting: supporting.length,
      related: related.length,
      // 三层加起来的**可见条目数**（客户端「全部」档要用它做上限判断）
      shown: primary.length + supporting.length + related.length,
      // 本批语料里命中了话题的篇数 —— 「有文档但一篇都没命中」靠它判
      matched: pack.totals ? pack.totals.matched : 0,
      total: pack.totals ? pack.totals.total : 0,
    },
  }
}

/**
 * 一次请求里的上下文载荷：不适用（时间序 / 媒体档 / 没有命中）时返回 `null`。
 *
 * **只在文档档 + 相关序 + 有命中词时装配** —— 其余情形返回 null，
 * 客户端于是退回它一直在用的平铺列表，行为与 v0.13 逐字一致。
 *
 * @param {string} root - 工作区根
 * @param {object} payload - `scan()` 的产物
 * @param {string} sort - 当前排序模式
 * @param {string} kind - 当前条目类型
 * @returns {Promise<object|null>} Context Pack（带 `summary`）或 null
 */
async function contextPayload(root, payload, sort, kind) {
  if (!payload || payload.mode !== 'relevance' || sort !== 'relevance' || kind !== 'doc') return null
  const ranked = Array.isArray(payload.ranked) ? payload.ranked : []
  if (ranked.length === 0) return null
  try {
    const pack = await buildContextFor(root, {
      ranked,
      topic: payload.topic,
      task: payload.task,
      total: payload.total,
      // 引用图只在**真有命中**时才值得建（零命中时 Primary 为空，邻居逻辑没有锚点）
      withLinks: ranked.some((doc) => Number(doc.raw) > 0),
    })
    return withStats(pack)
  } catch {
    // 装配失败不该让整个列表接口失败 —— 退回 null，面板照常出平铺列表。
    return null
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

/* ── v0.15 · Context Feedback 的宿主侧封装 ────────────────────────────
 *
 * 这一层只做三件事：
 *   1. 从 `session.snapshotEvents()` **拉**事件（不订阅任何总线）喂给 feedback store；
 *   2. 把刚交出去的 Context Pack 记成 Context Snapshot；
 *   3. 给面板与 `knit_docs` 提供「**上一份**包之后发生了什么」。
 *
 * 记账只在**被显式打开**的会话里发生（面板的「使用情况」开关，或 `knit_docs` 的
 * `audit: true`）—— 默认一个字节都不攒。所有入口都 try/catch：
 * 记账坏了不许影响面板与工具（规格 §33 的降级纪律）。
 */

/** 进程内唯一的 feedback store（按会话分片，会话数与篇数都有硬上限）。 */
const feedbackStore = createStore()

/**
 * 安全读会话事件。拿不到返回 `null` 而**不是空数组** —— 空数组会被下游当成
 * 「这个会话真的没有任何事件」，那是两件不同的事。
 * @param {object} session - 宿主会话
 * @returns {object[]|null} 事件数组或 null
 */
function sessionEvents(session) {
  try {
    if (!session || typeof session.snapshotEvents !== 'function') return null
    const events = session.snapshotEvents()
    return Array.isArray(events) ? events : null
  } catch {
    return null
  }
}

/**
 * 把会话事件喂给 feedback store。幂等靠 `seq` 游标 —— 面板每 5 秒轮询一次，
 * 每次都会把**同一批历史事件**再拉一遍，游标保证同一篇读只记一次。
 * @param {string} root - 工作区根（归一化绝对路径用）
 * @param {string} sessionId - 会话 id
 * @param {object} session - 宿主会话
 * @returns {{ok: boolean, reads: number, cursor: number}} 结果
 */
function ingestFeedback(root, sessionId, session) {
  const events = sessionEvents(session)
  if (!events || !sessionId) return { ok: false, reads: 0, cursor: -1 }
  return ingestEvents(feedbackStore, sessionId, events, { root })
}

/**
 * 打开某个会话的记账（面板的「使用情况」开关走它）。
 * @param {string} sessionId - 会话 id
 * @returns {boolean} 是否成功
 */
export function activateFeedback(sessionId) {
  return activateAudit(feedbackStore, sessionId)
}

/**
 * 这个会话在记账吗。
 * @param {string} sessionId - 会话 id
 * @returns {boolean} 是否记账
 */
export function feedbackActive(sessionId) {
  return isAudited(feedbackStore, sessionId)
}

/**
 * 线路上的紧凑使用情况：面板只需要**计数**与最近一次变化，不需要 200 条明细。
 * @param {object|null} usage - `usageFor()` 的结果
 * @param {number} [limit] - 明细最多带几条
 * @returns {object|null} 紧凑视图
 */
export function publicUsage(usage, limit = 20) {
  if (!usage || !usage.stats) return null
  return {
    at: usage.at,
    stats: { ...usage.stats, outsideReads: usage.stats.outsideReads.slice(0, limit) },
    delta: usage.delta ? {
      appeared: usage.delta.appeared.slice(0, limit),
      disappeared: usage.delta.disappeared.slice(0, limit),
      moved: usage.delta.moved.slice(0, limit),
      taskChanged: !!usage.delta.taskChanged,
    } : null,
  }
}

/**
 * 注入给 `knit_docs` 的桥 —— 工具不认识 `feedback.js`，只认识这两个方法
 * （与 `scan` / `read` / `contextFor` 同样的注入理由）。
 * ⚠️ `summary()` 必须在 `note()` **之前**调用：它报告的是**上一份**包的用法。
 */
const auditBridge = {
  usage(root, sessionId, session) {
    try {
      if (!sessionId) return null
      ingestFeedback(root, sessionId, session)
      return usageFor(feedbackStore, sessionId)
    } catch {
      return null
    }
  },
  summary(root, sessionId, session) {
    try {
      if (!sessionId) return ''
      ingestFeedback(root, sessionId, session)
      return getAuditSummary(usageFor(feedbackStore, sessionId))
    } catch {
      return ''
    }
  },
  note(root, sessionId, session, pack) {
    try {
      if (!sessionId || !pack) return null
      // 走到这里说明记账是**显式**的（面板带了 `usage=1`，或 agent 传了 `audit: true`
      // 且 `tool.js` 只在那一刻调 note）—— 所以在这里开闸是安全的。
      activateAudit(feedbackStore, sessionId)
      const { cursor } = ingestFeedback(root, sessionId, session)
      return noteSnapshot(feedbackStore, sessionId, pack, {
        seq: Number.isInteger(cursor) ? cursor : -1,
        at: Date.now(),
      })
    } catch {
      return null
    }
  },
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
          const body = publicScanPayload(payload)
          // v0.14：相关模式下顺带给出任务上下文分层。
          // ⚠️ 带上 `context` 是**可选**的（老客户端忽略它），而 `docs` 一字未动。
          body.context = await contextPayload(root, payload, sort, kind)
          // v0.15：面板把「使用情况」开关打开后，请求会带 `usage=1` —— 那一刻开始记账。
          // ⚠️ 默认（不带这个参数且本会话从未打开过）**一个字节都不记**。
          if (sessionId && url.searchParams.get('usage') === '1') activateFeedback(sessionId)
          if (sessionId && feedbackActive(sessionId)) {
            const session = sessionOf(webCtx, sessionId)
            // ⚠️ 顺序是刻意的：先取 usage（它报告的是**上一份**包之后发生了什么），
            // 再把这一份包记成新快照 —— 从下一次请求起，它才是「上一份」。
            body.usage = publicUsage(auditBridge.usage(root, sessionId, session))
            if (body.context) auditBridge.note(root, sessionId, session, body.context)
          }
          sendJson(res, 200, body)
          return
        }

        if (url.pathname === `${ROUTE_PREFIX}/api/context`) {
          // v0.14：独立的上下文接口。与 `/api/recent` 分开是为了**不让只想拿列表的
          // 调用方被迫付引用图的钱** —— 面板走 recent 里的 `context` 字段，
          // 这个路由留给「只要上下文、不要列表」的调用方。
          const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || MAX_DOCS, 1), MAX_DOCS)
          const sort = url.searchParams.get('sort') === 'time' ? 'time' : 'relevance'
          const kindParam = url.searchParams.get('kind')
          const kind = kindParam === 'all' || kindParam === 'media' ? kindParam : 'doc'
          const payload = await scan(root, limit, {
            session: sessionOf(webCtx, sessionId), sessionId, sort, kind,
          })
          // ⚠️ 与 `/api/recent` 的 `context` 字段**语义不同**：这里永远返回一个
          // 结构齐全的包（没有命中就是三层全空），不用 null。
          // null 是「请退回平铺列表」，那是 recent 的语义；独立的上下文接口
          // 没有平铺列表可退，返回 null 只会让调用方多一次判空。
          const context = withStats(await buildContextFor(root, {
            ranked: Array.isArray(payload.ranked) ? payload.ranked : [],
            topic: payload.topic,
            task: payload.task,
            total: payload.total,
            withLinks: payload.mode === 'relevance' && kind === 'doc',
          }))
          // v0.15：走这条路的调用方（只要上下文、不要列表）同样会推进 Context Snapshot ——
          // 否则「上下文变了」这件事会漏记。**只在已记账的会话里**（同 recent 的闸门）。
          if (sessionId && feedbackActive(sessionId)) {
            auditBridge.note(root, sessionId, sessionOf(webCtx, sessionId), context)
          }
          sendJson(res, 200, { ok: true, root, mode: payload.mode, topic: payload.topic, context })
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

        if (url.pathname === `${ROUTE_PREFIX}/api/links`) {
          // v0.12：某篇的「谁引用了它 / 它引用了谁」。
          // 形态逐字照抄 /api/doc —— 缺 rel 走同一个错误码，不新增读文件原语：
          // 图只用 collectDocs / readDocument 建，两者本身已强制「必须在工作区内」。
          const rel = url.searchParams.get('rel') || ''
          if (!rel) {
            sendJson(res, 400, { ok: false, code: ERROR_CODES.missingRel })
            return
          }
          const graph = await buildLinkGraph(root, { list: collectDocs, read: readDocument })
          const payload = linksOf(graph, rel)
          sendJson(res, payload.ok ? 200 : 404, payload)
          return
        }

        sendJson(res, 404, { ok: false, code: ERROR_CODES.notFoundRoute })
      } catch (error) {
        sendJson(res, 500, { ok: false, code: ERROR_CODES.internal, detail: String((error && error.message) || error) })
      }
    }

    webCtx.effect(() => {
      const unregister = webCtx.webServer.register({ kind: 'prefix', path: ROUTE_PREFIX, handler })
      console.log(`[${name}] route ready: ${ROUTE_PREFIX}/api/recent, ${ROUTE_PREFIX}/api/doc, ${ROUTE_PREFIX}/api/raw, ${ROUTE_PREFIX}/api/links, ${ROUTE_PREFIX}/api/context`)
      return () => unregister()
    }, 'dsh-knit: host route')
  })

  // ── v0.7：把同一个排序结果也交给模型 ──────────────────────────────
  //
  // 独立的一次 `ctx.inject`，**不是**把 'tools' 加进上面那个数组。
  // 加进去的话 `tools` 缺席时整个回调都不跑 —— 连面板路由都起不来。
  // 两条路互不依赖：没有 tools 服务时，浏览器那半边照常工作。
  ctx.inject(['tools'], (toolCtx) => {
    toolCtx.effect(
      // v0.15：多注入一个 `auditBridge` —— `knit_docs` 的 `audit: true` 走它拿
      // 「上一份包之后发生了什么」，并把这次交出的包记成新快照。
      () => registerKnitDocsTool(toolCtx, scan, readDocument, buildContextFor, auditBridge),
      'dsh-knit: knit_docs tool',
    )
    console.log(`[${name}] agent tool ready: knit_docs`)
  })
}

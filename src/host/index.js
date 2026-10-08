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
import { createReadStream, realpathSync, statSync } from 'node:fs'
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
// v0.20：内容片段层（Deep Context Retrieval）。**纯函数、不读盘**，
// 目录遍历与缓存全在本文件 —— 它只回答「这篇正文里哪几段相关」。
import { passageMatchesFor, passageTfOf, PASSAGE_WINDOW } from './passage.js'
// v0.19：文件分类层。**所有「这个文件是什么、能不能预览/检索/进上下文」的判断都在这里**，
// 本文件（以及 retrieval / preview / UI）不再自己看扩展名 —— 见 `classification.js` 的文件头。
import {
  classifyFile, isContextKind, isPreviewKind,
  KIND_DOCUMENT, KIND_CODE, KIND_IMAGE, KIND_VIDEO, KIND_GENERATED, KIND_IGNORED,
  IMAGE_TYPES, VIDEO_TYPES,
} from './classification.js'
// v0.15：Context Feedback / Context Audit —— 「Context Pack 之后真的被用了吗」。
// ⚠️ 只做三件确定性的事：从会话事件里抽**真实的 `read`**、把交出去的包记成 Snapshot、
// 把两者接起来算 Usage。**不订阅 event bus、不落盘、不联网、不调模型、不改 Retrieval。**
import {
  createStore, activateAudit, isAudited, ingestEvents, noteSnapshot, usageFor, getAuditSummary,
  markBackfilled, isBackfilled,
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
/**
 * 代码产物的扫描上限（v0.19）。
 *
 * ⚠️ 这个数字是**审计真实工作区之后定的**，不是拍的：
 * 拿 `DeepSeek Harness Native` 这一级真实工作区数过一遍，根下有 635 篇 Markdown、
 * 773 个代码文件（`.mjs` 270 / `.js` 173 / `.json` 122 / `.py` 105 / `.html` 74 /
 * `.yml` 13 / `.css` 10 / `.sh` 5），代码比文档多约 1.2 倍。
 *
 * 所以取 **300**（≈ 0.75 × `MAX_DOCS`）而不是和文档齐平 400：
 * 「支持代码」不该让代码把原有的 Markdown 上下文挤出去（需求 §15），
 * 同一批语料里代码的准入名额略小于文档，是这条要求最直接的落实。
 * 另外它在面板里也不与文档竞争 —— 文档档的语料只有 Markdown（见 `scan()`）。
 */
const MAX_CODE = 300
const SCAN_BUDGET_MS = 4000
const HEAD_BYTES = 16 * 1024
/**
 * 代码文件参与扫描时读取的**头部**字节数（v0.19）。
 *
 * 比 Markdown 的 16KB 更小是**刻意的**：头部只服务于引用关系与摘要渲染，
 * 而真实项目里 `.ts` / `.js` 的数量可能非常高 —— 这是「bounded content read」
 * 那条要求（需求 §16）唯一的落地点。
 *
 * ⚠️ v0.20 之后它**不再**限制检索：参与打分的正文是 `MAX_BODY_BYTES` 那份，
 * 与本常量彻底解耦（见 `readCode()`）。
 */
const CODE_HEAD_BYTES = 8 * 1024
/** 单次内联预览返回的正文上限（超出截断，面板只做预览不做全量阅读）。 */
const DOC_MAX_BYTES = 512 * 1024
/**
 * 参与相关性打分的正文字节上限（v0.20）。
 *
 * v0.19 之前这里是「正文前 2500 个字符」，于是正文命中只可能发生在前 2500 字里 ——
 * 而真实案例里目标词出现在第 29 033 字（`CHANGELOG.md` 那条「不改窗口」的记录）。
 * v0.20 取消这个窗口：**整篇正文都参与打分**，剩下的只是内存兜底。
 *
 * 单位是**字节**而不是字符：它是一道内存闸门，按字节量才是诚实的
 * （中文文件因此拿到更少的字符数 —— 偏差方向是安全的那一侧）。
 */
const MAX_BODY_BYTES = 256 * 1024
/** 解析结果缓存的条目上限（v0.20：缓存里现在留着整篇正文，必须封顶）。 */
const MAX_CACHE_ENTRIES = 1200
/** 解析结果缓存里正文的总字节上限 —— 比条目数更硬的那道闸门。 */
const MAX_CACHE_BYTES = 24 * 1024 * 1024

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
 * 图片/视频的类型白名单已经搬进 `classification.js`（v0.19）—— 扩展名归哪一类
 * 只该有一个事实来源，本文件只 import 它的 MIME 表（`mediaInfo` 按扩展名取 MIME）。
 */

/** 单张内联图片的字节上限。 */
const MAX_IMAGE_BYTES = 12 * 1024 * 1024
/**
 * 单个视频的字节上限。
 * Agent 生成的短视频通常几十 MB；放宽到 256MB，再大就该用系统播放器打开，
 * 而不是让侧边栏扛着整段字节。
 */
const MAX_VIDEO_BYTES = 256 * 1024 * 1024

/**
 * 列表条目类型：文档（Markdown）/ 代码 / 图片 / 视频。
 *
 * v0.19 起这四个常量由 `classification.js` 拥有并在这里重新导出（`KIND_*` 是本文件的
 * 惯用名）。**不要再在本文件里写扩展名判断** —— 那正是要收拢的东西。
 */
const KIND_DOC = KIND_DOCUMENT

/**
 * 机器可读的错误码。
 *
 * 宿主**不返回面向用户的文案** —— 文案由浏览器半边按当前语言翻译。
 * 这样宿主不必知道 UI 语言，以后加语言也不用动宿主。
 */
export const ERROR_CODES = {
  outsideWorkspace: 'knit/outside-workspace',
  /**
   * v0.19：从 `knit/markdown-only` 改名。
   *
   * 名字必须跟着能力改 —— 这个码现在表示「这个类型不支持在面板里预览」
   * （媒体、二进制、这一版不支持的代码语言、未知扩展名），
   * 而不只是「不是 Markdown」。留着旧名字会让下一个读代码的人以为
   * 放行范围还是「只有 Markdown」。
   */
  notPreviewable: 'knit/not-previewable',
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

/** 缓存里正文的总字节数（配合 `MAX_CACHE_BYTES` 淘汰）。 */
let cacheBodyBytes = 0

/**
 * 写缓存并做容量淘汰（v0.20）。
 *
 * 淘汰顺序是**插入序**（`Map` 的迭代序），命中时不重排 —— 也就是 FIFO，不是严格的 LRU。
 * 对本插件的访问模式这是合适的：每次轮询扫的是同一批文件，FIFO 足够；
 * 更重要的是它**完全确定**，不会引入「同一输入两次跑出不同结果」的风险（§20）。
 *
 * @param {string} key - 绝对路径
 * @param {object} entry - 解析结果（`bodyBytes` 为正文占用）
 */
function cacheSet(key, entry) {
  const prev = cache.get(key)
  if (prev) {
    cacheBodyBytes -= prev.bodyBytes || 0
    cache.delete(key)
  }
  cache.set(key, entry)
  cacheBodyBytes += entry.bodyBytes || 0
  while (cache.size > MAX_CACHE_ENTRIES || (cacheBodyBytes > MAX_CACHE_BYTES && cache.size > 1)) {
    const oldest = cache.keys().next()
    if (oldest.done) break
    const dropped = cache.get(oldest.value)
    cacheBodyBytes -= (dropped && dropped.bodyBytes) || 0
    cache.delete(oldest.value)
  }
}

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
  let body = ''
  let bodyBytes = 0
  let bodyTruncated = false
  try {
    const buf = await readFile(absPath)
    head = buf.subarray(0, HEAD_BYTES).toString('utf8')
    // v0.20：**整篇正文**参与打分。只解码前 `MAX_BODY_BYTES` 个字节 ——
    // `toString(enc, start, end)` 在字节边界解码，超出部分从不变成字符串，
    // 所以「巨文件」这条路径上的内存占用是有界的。
    bodyBytes = Math.min(buf.length, MAX_BODY_BYTES)
    body = buf.toString('utf8', 0, bodyBytes)
    bodyTruncated = buf.length > MAX_BODY_BYTES
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
    // v0.20：正文（截到上限）也留在缓存里 —— 片段切分与全文打分的输入。
    // 语义上 `head` 是「首部」（引用关系用，16KB），`body` 是「全文」，
    // 两者**不许互相挪用**（实现说明 D4）。
    body,
    bodyBytes,
    bodyTruncated,
    hayTitle: title.toLowerCase(),
    haySummary: summary.toLowerCase(),
    // v0.20：**不再截前 2500 字**。文件级 BM25 现在看得到整篇正文，
    // 于是 `avgdl[body]` 是真实长度，长文件被 `b = 0.75` 直接惩罚（D3）。
    hayBody: body.toLowerCase(),
  }
  cacheSet(absPath, entry)
  return entry
}

/**
 * 读一个**代码文件**参与检索所需的头部（v0.19），命中缓存则跳过读盘。
 *
 * 与 `readDoc` 共用同一张 `cache`（键是绝对路径，一个路径只可能是文档或代码之一），
 * 并复用同一套 `haystack` 形状 —— 这正是「不给代码建第二套检索」在数据层面的落实：
 * `relevance.js` 一个字节都不用改，它看到的仍是它一直在看的 `{title, summary, body}`。
 *
 * haystack 的字段语义在这里被**重新指派**（需求 §13：代码不复用 Markdown 的语义）：
 *
 *   - `title`   ← 文件名（权重 4，最高价值字段：`plugin-loader.js` 本身就带任务语义）
 *   - `summary` ← 工作区相对路径的目录部分（权重 2）
 *   - `body`    ← **整篇正文**（权重 1；v0.20 起不再截前 2500 字）
 *
 * 于是 `FIELD_WEIGHTS` 现成的 4 / 2 / 1 恰好等于
 * 「filename × 4 / path × 2 / content × 1」，排序器零改动。
 *
 * @param {string} absPath - 绝对路径
 * @param {string} root - 工作区根
 * @returns {Promise<object|null>} 解析结果，读失败返回 null
 */
async function readCode(absPath, root) {
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
  let body = ''
  let bodyBytes = 0
  let bodyTruncated = false
  try {
    const buf = await readFile(absPath)
    head = buf.subarray(0, CODE_HEAD_BYTES).toString('utf8')
    // v0.20：与 `readDoc` 同一条口径 —— 头部只服务引用关系，打分看整篇正文。
    bodyBytes = Math.min(buf.length, MAX_BODY_BYTES)
    body = buf.toString('utf8', 0, bodyBytes)
    bodyTruncated = buf.length > MAX_BODY_BYTES
  } catch {
    return null
  }

  const name = absPath.split(sep).pop() || absPath
  const rel = relative(root, absPath).split(sep).join('/')
  const cut = rel.lastIndexOf('/')
  // 目录部分保留结尾的 `/`（`src/context/`），与列表里第二行的观感一致；
  // 根目录下的文件是空串 —— 不编一个 `/` 出来。
  const dir = cut >= 0 ? rel.slice(0, cut + 1) : ''

  const entry = {
    mtimeMs: st.mtimeMs,
    size: st.size,
    head,
    body,
    bodyBytes,
    bodyTruncated,
    // ⚠️ 标题是**带扩展名的文件名**，不是去扩展名的 stem。
    // 代码的文件名里扩展名是信息的一部分（`plugin-loader.js` vs `plugin.json`），
    // 去掉它反而丢掉了最能区分两个候选的那个字符。
    title: name,
    // 摘要位放路径。列表第二行本来就在显示路径，这里只是让同一个值也能参与打分。
    summary: dir,
    hayTitle: name.toLowerCase(),
    haySummary: dir.toLowerCase(),
    hayBody: body.toLowerCase(),
  }
  cacheSet(absPath, entry)
  return entry
}

/**
 * 广度优先扫出工作区里的文档、代码与媒体文件（v0.19）。
 *
 * 一次遍历同时收三类，目录预算与时间预算共享；三类各自有数量上限，
 * 截图再多也不会把文档名额挤光，代码再多也不会（见 `MAX_CODE`）。
 *
 * **扫描只做「目录元数据 → 分类 → 准入」**：这里不读任何文件内容，
 * 正文读取留给 `collectDocs`（bounded，见 `readCode`）。
 *
 * @param {string} root - 工作区根（会话 cwd）
 * @returns {Promise<{md: string[], code: string[], media: Array<{abs:string, kind:string}>,
 *                    mdTruncated: boolean, codeTruncated: boolean, mediaTruncated: boolean,
 *                    stats: object, scanMs: number}>} 分类后的绝对路径与计数
 */
async function collectEntries(root) {
  const startedAt = Date.now()
  /** @type {string[]} */
  const md = []
  /** @type {string[]} */
  const code = []
  /** @type {Array<{abs:string, kind:string}>} */
  const media = []
  const deadline = startedAt + SCAN_BUDGET_MS
  /** @type {Array<{dir:string,depth:number}>} */
  const queue = [{ dir: root, depth: 0 }]
  let visited = 0
  /**
   * v0.19 验收要的计数（需求 §50）。
   * `codeSeen` 是**见到的**代码文件数，`codeAdmitted` 是进语料的，
   * `codeExcluded` 是被 `MAX_CODE` 挡在外面的 —— 三者分开，才看得出上限有没有真的生效。
   */
  const stats = {
    mdSeen: 0, mdAdmitted: 0,
    codeSeen: 0, codeAdmitted: 0, codeExcluded: 0,
    mediaSeen: 0, mediaAdmitted: 0,
    generated: 0, ignored: 0,
  }

  while (queue.length > 0) {
    if (visited >= MAX_DIRS
      || (md.length >= MAX_DOCS && media.length >= MAX_MEDIA && code.length >= MAX_CODE)
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
        const info = classifyFile(entry.name)
        // **准入判定只有这一处**：`isContextKind()` 回答「算不算上下文候选」，
        // 下面再按具体类型分账。配额与计数必须分开 —— v0.19 的 corpus pressure
        // 要求能看出到底是文档还是代码把语料撑大的（需求 §15 §50）。
        if (isContextKind(info.kind)) {
          if (info.kind === KIND_DOC) {
            stats.mdSeen += 1
            if (md.length < MAX_DOCS) { md.push(abs); stats.mdAdmitted += 1 }
          } else {
            stats.codeSeen += 1
            if (code.length < MAX_CODE) { code.push(abs); stats.codeAdmitted += 1 } else stats.codeExcluded += 1
          }
        } else if (info.kind === KIND_IMAGE || info.kind === KIND_VIDEO) {
          stats.mediaSeen += 1
          if (media.length < MAX_MEDIA) { media.push({ abs, kind: info.kind }); stats.mediaAdmitted += 1 }
        } else if (info.kind === KIND_GENERATED) {
          // 生成/噪声产物：**数一下，但一个都不准入**（需求 §6 §7）。
          stats.generated += 1
        } else {
          stats.ignored += 1
        }
      }
    }
  }

  return {
    md,
    code,
    media,
    mdTruncated: md.length >= MAX_DOCS,
    codeTruncated: code.length >= MAX_CODE,
    mediaTruncated: media.length >= MAX_MEDIA,
    stats,
    scanMs: Date.now() - startedAt,
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
 * 扫出工作区里全部文档、代码与媒体的元信息（各自按 mtime 倒序）。
 *
 * 三类共用一次目录遍历（`collectEntries`），但**只有文档与代码会读正文头部**
 * ——媒体永远只 stat（视频可能上百 MB）。
 *
 * @param {string} root - 工作区根
 * @returns {Promise<{docs: Array<object>, code: Array<object>, media: Array<object>,
 *                    truncated: boolean, codeTruncated: boolean, mediaTruncated: boolean,
 *                    stats: object, scanMs: number}>}
 */
export async function collectDocs(root) {
  const found = await collectEntries(root)
  const docs = []
  // v0.20：被 `MAX_BODY_BYTES` 截掉尾巴的文件数。**只是计数**，用来在规模报告里
  // 诚实说出「有多大比例的文件没有全量参与打分」，不参与任何排序。
  let bodyTruncated = 0

  for (const abs of found.md) {
    const meta = await readDoc(abs)
    if (!meta) continue
    if (meta.bodyTruncated) bodyTruncated += 1
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
      // v0.20：整篇正文随记录走 —— 片段切分与 `matches` 的输入。
      // 它是**内部字段**：`publicDoc()` 不转发正文，只转发派生出的行号与摘要。
      body: meta.body,
      haystack: { title: meta.hayTitle, summary: meta.haySummary, body: meta.hayBody },
    })
  }
  docs.sort((a, b) => b.mtimeMs - a.mtimeMs)

  // v0.19：代码条目与文档条目**形状完全一致**（同一个 `kind` 位、同一套 haystack、
  // 同一批下游消费者）。差别只在 haystack 字段的语义 —— 见 `readCode`。
  // 这不是「第二套数据模型」，就是同一套模型里多了一类 kind。
  const code = []
  for (const abs of found.code) {
    const meta = await readCode(abs, root)
    if (!meta) continue
    if (meta.bodyTruncated) bodyTruncated += 1
    code.push({
      kind: KIND_CODE,
      path: abs,
      rel: relative(root, abs).split(sep).join('/'),
      name: abs.split(sep).pop(),
      title: meta.title,
      summary: meta.summary,
      size: meta.size,
      mtimeMs: meta.mtimeMs,
      head: meta.head,
      body: meta.body,
      haystack: { title: meta.hayTitle, summary: meta.haySummary, body: meta.hayBody },
    })
  }
  code.sort((a, b) => b.mtimeMs - a.mtimeMs)

  const media = []
  for (const item of found.media) {
    const meta = await readMediaMeta(root, item)
    if (meta) media.push(meta)
  }
  media.sort((a, b) => b.mtimeMs - a.mtimeMs)

  return {
    docs,
    code,
    media,
    truncated: found.mdTruncated,
    codeTruncated: found.codeTruncated,
    mediaTruncated: found.mediaTruncated,
    stats: { ...found.stats, bodyTruncated },
    scanMs: found.scanMs,
  }
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
  const out = {
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
  // v0.20：命中片段（§11）。只下发**派生结果** —— 行号区间、命中词、片段摘要；
  // `body` 与 `passage.text` 一律不出宿主（§16：不准把大文件正文塞进载荷）。
  // 没有片段的记录**不带这个键**（v0.19 的响应形状因此逐字不变）。
  if (Array.isArray(doc.matches) && doc.matches.length > 0) out.matches = doc.matches
  return out
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
  // v0.19 修订：**扫的是展开符号链接后的那份路径**。
  // 每条记录里的 `path`（`publicDoc()` 原样下发给客户端）就是「打开 / 定位」时
  // 交给宿主的路径，而 DSH 只认 realpath（见 `hostPathOf()`）—— 跟着会话的
  // 符号链接走一遍，客户端拿到的 `path` 直接可用，不必等 `/api/doc` 回来再校正。
  // ⚠️ `rel` 用同一个 base 算，所以相对路径一字不变；对外的 `root` 仍是会话
  // 原本那条（界面显示用），canonical 的那份单独放在 `hostRoot`。
  const hostRoot = hostPathOf(root)
  const collected = await collectDocs(hostRoot)

  // 默认 doc：旧版客户端 / 悬停浮层不带 kind，行为与「只列 Markdown」时完全一致。
  //
  // v0.19 的 `kind` 取值集合（**唯一权威**，HTTP 与工具都从这里取）：
  //   `doc`     仅 Markdown（默认，v0.18 行为逐字不变）
  //   `code`    仅代码（v0.19）
  //   `media`   仅图片/视频（v0.18 行为逐字不变）
  //   `all`     文档 + 代码 + 媒体（面板「全部」档；v0.18 是「文档 + 媒体」，只多不少）
  //   `context` **内部**语料：文档 + 代码。不给 HTTP —— agent 工具的 Context Pack
  //             要在「文档与代码混合竞争」上排序（需求 §34 Case C），而媒体不进上下文，
  //             所以它不能复用 `all`（那会把媒体也塞进候选）。
  const kind = options.kind === 'all' || options.kind === 'media'
    || options.kind === 'code' || options.kind === 'context'
    ? options.kind
    : 'doc'
  let pool
  let truncated
  if (kind === 'media') {
    pool = collected.media
    truncated = collected.mediaTruncated
  } else if (kind === 'code') {
    pool = collected.code
    truncated = collected.codeTruncated
  } else if (kind === 'context') {
    pool = collected.docs.concat(collected.code).sort((a, b) => b.mtimeMs - a.mtimeMs)
    truncated = collected.truncated || collected.codeTruncated
  } else if (kind === 'all') {
    pool = collected.docs.concat(collected.code, collected.media)
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
    truncated = collected.truncated || collected.codeTruncated || collected.mediaTruncated
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
    // 一个 `now` 贯到底（打分与片段用同一个时间基准）—— 同一批输入两次跑出的
    // 结果因此逐字相同（§20 的确定性要求）。
    const now = Date.now()
    const ranked = rankByRelevance(pool, keywords, now)
    ordered = ranked.docs
    // v0.20（D5）：给每条命中记录附上逐词的「单窗口内最大字频」。
    // 分层闸门 `isDocHit` 原来用**整篇**字频，而整篇字频会随文件变长而虚高 ——
    // 窗口一开，29000 字的 CHANGELOG 就能对**每个**任务满足闸门（需求 §9 明令禁止）。
    // 这一步只算「正文真的命中」的词，成本是几次 `indexOf`，不改名次、也不进 payload。
    for (const doc of ordered) {
      const tf = passageTfOf(doc)
      if (tf) doc.passageTf = tf
    }
    // v0.20：给排名最前的 `PASSAGE_WINDOW` 条挂上命中片段（§11）。
    // ⚠️ 这一步**不改名次**：片段是文件名的投影（实现说明 D3）。
    // 窗口之外的记录只是「没有片段」，不是「不相关」—— `limit` 才管分页，
    // 这里是宿主侧的成本上限（切段是 O(全文)，不该为 400 篇文件各做一遍）。
    // `rankByRelevance` 返回的是浅拷贝，所以挂 `matches` 不会污染 `pool`。
    const stop = Math.min(ordered.length, PASSAGE_WINDOW)
    for (let i = 0; i < stop; i++) {
      const matches = passageMatchesFor(ordered[i], keywords, now)
      if (matches.length > 0) ordered[i].matches = matches
    }
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
    // v0.19 修订：`root` 是会话自己那条路径（可能含符号链接，用于显示）；
    // `hostRoot` 是同一目录展开链接后的 canonical 路径，**只给「打开 / 定位」用** ——
    // 宿主只认 realpath 形态，理由见 `hostPathOf()`。
    hostRoot,
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
    // 全量列表（未按 limit 切片）。**内部输入**：v0.17 的 lifecycle 需要「被读过但
    // 不一定落在当前页」的文档的当前 mtime。由 `publicScanPayload()` 剥掉。
    allDocs: ordered,
    // v0.19 扫描计数（需求 §50 要报的那几个数：见到的 / 准入的 / 被排除的 / 生成噪声）
    // 加上 `corpusSize`（本档语料的实际大小，即 `allDocs.length`）。
    // **内部输入**，由 `publicScanPayload()` 剥掉 —— HTTP 响应形状一个键都不加。
    stats: { ...collected.stats, scanMs: collected.scanMs, corpusSize: ordered.length },
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
  const { ranked, task, allDocs, stats, ...rest } = payload
  void ranked
  void task
  void allDocs
  void stats
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
 * v0.19：**入图的一律只看 Markdown**（`buildLinkGraph` 自己也只认 `.md` 目标）。
 * 代码不进图有两个理由，都不是洁癖：
 *   1. 引用图是 `.md` 与 `.md` 之间的关系（`links.js` 的解析规则就是为中文文档语料
 *      量出来的）。把代码的正文塞进这个索引没有语义，只会让 basename 歧义变多。
 *   2. 更重要的是**不能给代码开一条新的入围路径**。代码进 Supporting 的唯一正当理由
 *      应当是「任务检索命中了它」；如果它还能靠「正文里恰好写了一句 `docs/X.md`」
 *      进 Supporting，那就成了「因为它是代码所以特别」的反面 —— 一条不打分的后门。
 *
 * @param {string} root - 工作区根
 * @param {boolean} withLinks - 是否要引用关系
 * @param {Map<string, object>} byRel - 本次扫描到的产物（按 rel）
 * @returns {Promise<object|null>} 图或 null
 */
async function linkGraphFor(root, withLinks, byRel) {
  if (!withLinks) return null
  try {
    return await buildLinkGraph(root, {
      list: async () => ({
        docs: [...byRel.values()].filter((doc) => doc.kind === KIND_DOC),
        truncated: false,
      }),
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
 * **只在「文档档 / 代码档 + 相关序」时装配** —— 其余情形返回 null，
 * 客户端于是退回它一直在用的平铺列表，行为与 v0.13 逐字一致。
 *
 * v0.19：代码档走的是**同一个**装配调用，没有任何 code-only 分支。
 * 引用图仍然只有 Markdown 才建（`links.js` 解析的是 Markdown 链接语法，
 * 这是它的既有边界，v0.19 不扩）—— 所以 `withLinks` 只在文档档为真。
 *
 * @param {string} root - 工作区根
 * @param {object} payload - `scan()` 的产物
 * @param {string} sort - 当前排序模式
 * @param {string} kind - 当前条目类型
 * @returns {Promise<object|null>} Context Pack（带 `summary`）或 null
 */
async function contextPayload(root, payload, sort, kind) {
  const contextKind = kind === 'doc' || kind === 'code' || kind === 'context'
  if (!payload || payload.mode !== 'relevance' || sort !== 'relevance' || !contextKind) return null
  const ranked = Array.isArray(payload.ranked) ? payload.ranked : []
  if (ranked.length === 0) return null
  try {
    const pack = await buildContextFor(root, {
      ranked,
      topic: payload.topic,
      task: payload.task,
      total: payload.total,
      // 引用图只在**真有命中**时才值得建（零命中时 Primary 为空，邻居逻辑没有锚点）；
      // 而且只有 Markdown 有图可建。
      withLinks: kind === 'doc' && ranked.some((doc) => Number(doc.raw) > 0),
    })
    return withStats(pack)
  } catch {
    // 装配失败不该让整个列表接口失败 —— 退回 null，面板照常出平铺列表。
    return null
  }
}

/**
 * 读一个**可预览的文本产物**的完整正文（Markdown 文档 / 代码 / 生成产物），
 * 供面板内联预览。
 *
 * 路径必须落在工作区根之内——`rel` 来自浏览器，按不可信输入处理。
 *
 * v0.19：放行范围从「只认 `.md`」改成**按分类层判定**（`isPreviewKind`）。
 * 这条放宽是必须的（否则代码点不开），但边界一点没松：
 * 媒体仍然只走 `/knit/api/raw`，`ignored`（含这一版不支持的 `.go` / `.rs` / `.java`
 * / 未知扩展名）一律拒绝 —— **`/knit/api/doc` 仍然是按路径读文件的接口**，
 * 不能变成「读工作区里任意文件」的后门。
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
  const name = abs.split(sep).pop() || abs
  const info = classifyFile(name)
  if (!isPreviewKind(info.kind)) return { ok: false, code: ERROR_CODES.notPreviewable }

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

  const relPath = relative(base, abs).split(sep).join('/')
  const payload = {
    ok: true,
    rel: relPath,
    // v0.19 修订：给「打开 / 定位」用的 canonical 绝对路径（展开符号链接）。
    // 客户端拿它去 `remote.session.openWorkspacePath`；自己用 root + rel 拼出来的那份
    // 一旦含符号链接就会被宿主拒掉（`Path has no verified Host path`）。
    path: hostPathOf(abs),
    // v0.19：预览分支的判据由宿主给（分类层的结论），客户端不再自己看扩展名。
    kind: info.kind,
    language: info.language,
    // 代码不用 `parseMarkdown` 猜标题 —— 一段开头的 `# 注释` 在 shell 里是注释，
    // 不是标题。代码的标题就是文件名本身。
    title: info.kind === KIND_DOC ? parseMarkdown(text, name).title : name,
    bytes: buf.length,
    truncated,
    text,
  }
  // v0.19（需求 §6 §28）：同名 `<file>.map` 存在时，在 code 预览里给一个**极轻量**入口。
  // 只多做一次 `stat`（不读内容、不进任何列表、不进检索、不进上下文）——
  // `.map` 本身仍然不是 Context，这里只是「它就在旁边」这一个事实的搬运。
  if (info.kind === KIND_CODE && !info.sourceMap) {
    try {
      const mapStat = await stat(`${abs}.map`)
      if (mapStat.isFile()) payload.mapRel = `${relPath}.map`
    } catch {
      // 没有就是没有 —— 不加字段，不报错。
    }
  }
  return payload
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
 * 从一个宿主会话对象解析工作区根。
 *
 * v0.16 起 `session/event` 的订阅回调里**只有 session 对象**（没有注入过的 webCtx），
 * 所以这段逻辑必须能独立使用：面板路由与记账回调共用它，保证「算列表用的根」与
 * 「归一化读路径用的根」永远是同一个 —— 否则同一次读会被一边算作包内、
 * 一边算作包外（AGENTS.md §8.10 踩过这个坑）。
 * @param {object} session - 宿主会话（可为空）
 * @returns {string} 绝对路径根
 */
function rootOfSession(session) {
  let root = ''
  try {
    if (session && session.header && typeof session.header.cwd === 'string') root = session.header.cwd
  } catch { /* 取不到 cwd 就走兜底根 */ }
  if (!root) root = process.cwd()
  if (root.startsWith('~')) root = join(homedir(), root.slice(1))
  return resolve(root)
}

/**
 * 交给宿主去「打开 / 定位」的路径必须**展开所有符号链接**。
 *
 * 判据在 DSH 自己那里：`dsh-api-session-controller` 的 `verifyDesktopPath()` 把路径送进
 * `ctx.fs`，要求
 * `fs.processPath(await fs.resolve(fs.processPathFromHostPath(p))) === p`；
 * 而 `dsh-fs-local` 的 `resolve()` 落的是 `realpath()`。也就是说 ——
 * **路径里只要有一个符号链接没展开，宿主就回
 * `gateway/bad-request / Path has no verified Host path`**，
 * 客户端把它显示成「打开失败：Path has no verified Host path」。
 *
 * 会话的工作区根完全可能是符号链接（实测：`DSH_Skill_Trace -> 10_DSH_Skill_Trace`），
 * 于是「打开」这条路必须另外给一份 canonical 路径。
 * **显示与检索仍用会话原本那个 root** —— 用户看到的是自己选的那条路径，
 * 只有交给宿主打开的路径要展开。
 *
 * 文件不存在时 `realpathSync` 会抛；调用点都在 `stat` 成功之后，兜底返回原路径，
 * 免得把一次「打不开」升级成接口 500。
 *
 * @param {string} path - 绝对路径
 * @returns {string} 展开符号链接后的绝对路径
 */
function hostPathOf(path) {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}

/**
 * 解析一个会话的工作区根。
 * @param {object} webCtx - 注入了 sessions 的上下文
 * @param {string} sessionId - 会话 id（可为空）
 * @returns {string} 绝对路径根
 */
function workspaceRootOf(webCtx, sessionId) {
  let session
  try {
    session = sessionId && typeof webCtx.sessions.get === 'function'
      ? webCtx.sessions.get(sessionId)
      : undefined
  } catch { /* 会话查不到就走兜底根 */ }
  return rootOfSession(session)
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

/* ── v0.16 · Context Feedback 的宿主侧封装 ────────────────────────────
 *
 * 这一层只做三件事：
 *   1. **订阅**宿主的 `session/event`，把真实发生过的 `read` 一条条喂给 feedback store；
 *   2. 把刚交出去的 Context Pack 记成 Context Snapshot（带 `epochId`）；
 *   3. 给面板与 `knit_docs` 提供「**上一份**包之后发生了什么」。
 *
 * ⚠️ 读证据走**订阅**（`session/event`），不拿 `session.snapshotEvents()` 当审计来源：
 * 那个 API 已被 DSH 标记 deprecated（「new production calls are prohibited」）。
 * 代价是闸门打开**之前**已经发生的读不在订阅范围内，所以**开闸时回填一次**（v0.17 修订，用户拍板）：
 * 闸门只在你打开开关时才开，而真实用法是读完才看面板 —— 不回填就只能把真实发生过的读
 * 显示成「未读」，那是假话（规格 §3）。回填的代价被三条边界锁住：一个会话只做一次、
 * 只在开闸那一 tick、仍然零 I/O 零网络零模型且只在内存里。已知的不精确：回填的读按
 * 「我们已知最早的那份包」（= 开闸时看到的那份）归因，更早的包无从得知，所以**宁可少说**。
 *
 * 记账只在**被显式打开**的会话里发生（面板的「使用情况」开关，或 `knit_docs` 的
 * `audit: true`）—— 默认一条事件的处理成本就是一次 Map 查找。
 * 所有入口都 try/catch：记账坏了不许影响面板与工具（规格 §33 的降级纪律）。
 */

/** 进程内唯一的 feedback store（按会话分片，会话数与篇数都有硬上限）。 */
const feedbackStore = createStore()

/**
 * 宿主会话注册表（`webCtx.sessions`）的引用，只给**工具**那条路用。
 *
 * 面板那条路拿得到 `webCtx`；`knit_docs` 的 `audit: true` 走的是 `auditBridge`，
 * 它也需要在开闸时回填历史（见 `backfillFeedback`），所以在这里留一份引用。
 */
let sessionsRef = null

/**
 * 按会话 id 取宿主会话对象（拿不到就 undefined —— 回填只是「能补就补」）。
 * @param {string} sessionId - 会话 id
 * @returns {object|undefined} 会话
 */
function sessionFor(sessionId) {
  try {
    if (!sessionId || !sessionsRef || typeof sessionsRef.get !== 'function') return undefined
    return sessionsRef.get(sessionId)
  } catch {
    return undefined
  }
}

/**
 * 取一个**已归一化**的工作区相对路径的版本标记（`mtimeMs`）。
 *
 * v0.17 用它回答「这篇文档被读过之后改过吗」。只接受走过 `normalizeRel` 的 `rel`
 * （无 `..`、无绝对路径逃逸、无 URL scheme），再 `resolve` 到 root 之下 `statSync` ——
 * 不新增任何用户可控的路径来源。任何异常 / 非有限值都返回 `null`：拿不到证据就不说。
 *
 * ⚠️ `feedback.js` 保持零 I/O，所以取样只能由宿主注入（`options.stat`）。
 *
 * @param {string} root - 工作区根（绝对路径）
 * @param {string} rel - 已归一化的工作区相对路径
 * @returns {number|null} mtimeMs，或 null
 */
function mtimeOf(root, rel) {
  try {
    if (typeof root !== 'string' || !root) return null
    if (typeof rel !== 'string' || !rel) return null
    const st = statSync(resolve(root, rel))
    return Number.isFinite(st.mtimeMs) ? st.mtimeMs : null
  } catch {
    return null
  }
}

/**
 * 订阅宿主的会话事件流，把真实的读记进 store。
 *
 * `{ global: true }` 是**必需**的：`session/event` 按 scope 过滤派发，而这个插件挂在
 * 根上下文上、要看的却是各 agent scope 里的会话（宿主自己的 `invariant.js` 也这么订）。
 *
 * 三道闸门，顺序即开销顺序：**没记账的会话，一条事件只花一次 Map 查找**就返回。
 * 任何异常一律咽掉 —— 记账坏了绝不许影响宿主。
 * @param {object} session - 宿主会话
 * @param {object} event - 会话事件（`tool/call` / `tool/result` / 其它）
 * @returns {void}
 */
function onSessionEvent(session, event) {
  try {
    const sessionId = session && typeof session.id === 'string' ? session.id : ''
    if (!sessionId || !event) return
    if (!isAudited(feedbackStore, sessionId)) return
    const root = rootOfSession(session)
    // v0.17：成功读被确认的那一刻取一次版本标记。取样只发生在**新事件**上，
    // 所以同一事件重复派发既不重复计数，也不重复取样。
    ingestEvents(feedbackStore, sessionId, [event], {
      root,
      stat: (rel) => mtimeOf(root, rel),
    })
  } catch { /* 记账坏了不许影响宿主 */ }
}

/**
 * 把会话**已经发生**的事件补进 store（v0.17 修订，用户拍板）。
 *
 * 为什么需要：记账闸门只在面板带 `usage=1`（或 `knit_docs` 传 `audit: true`）那一刻才开，
 * 而真实用法是**读完才想起来看面板**。那些读发生在闸门外，Knit 手上零证据，面板只能把它们
 * 显示成「未读」—— 那是**假话**（规格 §3：只讲事实，不讲推断）。所以开闸时把会话已有的历史
 * 一次性补进 store：宁可补记，不可诬告。
 *
 * ⚠️ 顺序是这个函数的一部分：**先记下手上这份包，再喂事件**。`recordRead()` 在事件入库那一刻
 * 就把归因（`tier` / `inside` / `epochId`）结算并**冻结**，之后不再重算。若先喂事件，那些读会在
 * 「一份快照都还没有」的状态下被冻成包外，而「它当时不在 Context Pack 里」正是我们**不知道**的事。
 * 先记包则快照 seq 自然是 `-1`（此刻 `state.seq` 也是 `-1`），补记的读归到「我们已知最早的那份包」。
 *
 * 代价与边界（都写在这里，免得日后被误解成「全量扫描」）：
 *   - 只在**开闸那一刻**读一次 `snapshotEvents()`，一个会话只做一次（`isBackfilled`）；
 *   - 仍然**零 I/O、零网络、零模型**：事件来自宿主内存，版本标记来自一次 `statSync`；
 *   - 仍然只在内存里（重启即丢），也仍然只在有人看的时候才发生；
 *   - `ingestEvents` 自己按 `seq` 水位去重，所以回填过的事件稍后再从订阅派发一次
 *     也不会重复计数（规格 §18 Case 12 的幂等性照旧）。
 *
 * @param {string} sessionId - 会话 id
 * @param {object} session - 宿主会话（要有 `snapshotEvents()`）
 * @param {object|null} [pack] - 此刻手上这份 Context Pack；给了就先记成第一份快照
 * @returns {number} 补进来的读条数（拿不到 / 已回填过 → 0）
 */
function backfillFeedback(sessionId, session, pack = null) {
  try {
    if (!sessionId || !session) return 0
    if (typeof session.snapshotEvents !== 'function') return 0
    if (isBackfilled(feedbackStore, sessionId)) return 0
    const events = session.snapshotEvents()
    if (!Array.isArray(events) || events.length === 0) return 0
    const root = rootOfSession(session)
    // 先记包（见上面的顺序说明）：快照 seq 会是 -1，于是补记的读能归到它身上。
    // ⚠️ 不传 `at`：这份包代表的是「会话开始时的那份上下文」，与 seq = -1 同一口径。
    // 传此刻的墙钟会让第一次记账的 `usage.at` 从「还没有上一份」(0) 变成一个假的具体时间，
    // 而这一请求真正的交包时间由下面 `auditBridge.note()` 那次去重更新写进去。
    if (pack) noteSnapshot(feedbackStore, sessionId, pack)
    const result = ingestEvents(feedbackStore, sessionId, events, {
      root,
      stat: (rel) => mtimeOf(root, rel),
    })
    if (!result.ok) return 0
    markBackfilled(feedbackStore, sessionId)
    return result.reads
  } catch {
    return 0
  }
}

/**
 * 打开某个会话的记账（面板的「使用情况」开关走它），并顺手回填已有历史。
 *
 * ⚠️ 回填**必须**发生在开闸之后、同一个 tick 里：开闸前的事件由回填补，
 * 开闸后的事件走订阅，两者在 `seq` 上严丝合缝，不会漏也不会重。
 *
 * @param {string} sessionId - 会话 id
 * @param {object} [session] - 宿主会话；省略则只开闸不回填
 * @param {object|null} [pack] - 此刻手上的 Context Pack，交给回填当第一份快照
 * @returns {boolean} 是否成功
 */
export function activateFeedback(sessionId, session = null, pack = null) {
  const ok = activateAudit(feedbackStore, sessionId)
  if (ok) backfillFeedback(sessionId, session, pack)
  return ok
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
 * 线路上的紧凑使用情况：面板只需要**计数**、**四态生命周期**与最近一次变化，
 * 不需要 200 条明细。
 * @param {object|null} usage - `usageFor()` 的结果
 * @param {number} [limit] - 明细最多带几条
 * @param {Set<string>|null} [rels] - v0.17：本次真正要渲染的文档（当前页 ∪ 包外明细）；
 *   省略/为 null 时不裁剪 lifecycle（测试与其它调用方兼容）
 * @returns {object|null} 紧凑视图
 */
export function publicUsage(usage, limit = 20, rels = null) {
  if (!usage || !usage.stats) return null
  const delta = usage.delta ? {
    appeared: usage.delta.appeared.slice(0, limit),
    disappeared: usage.delta.disappeared.slice(0, limit),
    moved: usage.delta.moved.slice(0, limit),
    taskChanged: !!usage.delta.taskChanged,
  } : null

  // v0.17：lifecycle 每个条目只带 UI 要用的三个字段（状态值仍是英文事实，
  // 中文只在客户端词典里）。按 rels 裁剪是刻意的：只发真正会渲染的那些行。
  const source = usage.lifecycle && typeof usage.lifecycle === 'object' ? usage.lifecycle : {}
  const lifecycle = {}
  for (const rel of Object.keys(source)) {
    if (rels && !rels.has(rel)) continue
    const row = source[rel]
    if (!row) continue
    lifecycle[rel] = { status: row.status, count: row.count, lastReadAt: row.lastReadAt }
  }

  return {
    at: usage.at,
    epochId: usage.epochId,
    stats: { ...usage.stats, outsideReads: usage.stats.outsideReads.slice(0, limit) },
    delta,
    // v0.17 新增（`latestDelta` 与 `delta` 同值：前者是 UI 唯一读的那个键）
    latestDelta: delta,
    recentRead: usage.recentRead ? { ...usage.recentRead } : null,
    outsideDocs: (Array.isArray(usage.outsideDocs) ? usage.outsideDocs : [])
      .slice(0, limit)
      .map((row) => ({ ...row })),
    lifecycle,
  }
}

/**
 * 注入给 `knit_docs` 的桥 —— 工具不认识 `feedback.js`，只认识这两个方法
 * （与 `scan` / `read` / `contextFor` 同样的注入理由）。
 *
 * ⚠️ `summary()` 必须在 `note()` **之前**调用：它报告的是**上一份**包的用法。
 * v0.16 起这个桥**不再收** root 与 session：读证据由订阅那条路进 store，
 * 交包只是记一份快照（`seq` 用 store 自己的事件水位）。
 */
const auditBridge = {
  usage(sessionId, mtimes) {
    try {
      if (!sessionId) return null
      // mtimes：v0.17 的当前版本标记（rel → mtimeMs）。不传就是保守投影（拿不到变化证据）。
      return usageFor(feedbackStore, sessionId, { mtimes })
    } catch {
      return null
    }
  },
  summary(sessionId) {
    try {
      if (!sessionId) return ''
      return getAuditSummary(usageFor(feedbackStore, sessionId))
    } catch {
      return ''
    }
  },
  note(sessionId, pack) {
    try {
      if (!sessionId || !pack) return null
      // 走到这里说明记账是**显式**的（面板带了 `usage=1`，或 agent 传了 `audit: true`
      // 且 `tool.js` 只在那一刻调 note）—— 所以在这里开闸是安全的。
      // v0.17 修订：开闸的同时回填会话已有的事件，否则「读完才打开」的那些读
      // 会被显示成「未读」——那是假话。
      activateAudit(feedbackStore, sessionId)
      backfillFeedback(sessionId, sessionFor(sessionId), pack)
      // 不传 `seq`：noteSnapshot 用会话当前的**事件水位**，也就是「交这份包时
      // 已经发生到第几个事件」—— seq ≤ 它的读才算在这份包里。
      return noteSnapshot(feedbackStore, sessionId, pack, { at: Date.now() })
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
  // v0.16：订阅会话事件流 —— 这是 Knit 唯一的读证据来源。
  // ⚠️ 注册在这里，而不是 `inject(['webServer','sessions'])` 的回调里：
  // `knit_docs` 的 `audit: true` 也能打开记账，没有 webServer 的环境照样要记。
  ctx.on('session/event', onSessionEvent, { global: true })

  ctx.inject(['webServer', 'sessions'], (webCtx) => {
    // v0.17 修订：工具那条路（`knit_docs audit:true`）也要能回填，所以留一份引用。
    sessionsRef = webCtx.sessions
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
          // v0.19：多一档 `code`。白名单形态不变（认不出的值一律回落 `doc`），
          // 而 `context` 那个内部语料**不从 HTTP 暴露**。
          const kind = kindParam === 'all' || kindParam === 'media' || kindParam === 'code'
            ? kindParam
            : 'doc'
          const payload = await scan(root, limit, {
            session: sessionOf(webCtx, sessionId), sessionId, sort, kind,
          })
          const body = publicScanPayload(payload)
          // v0.14：相关模式下顺带给出任务上下文分层。
          // ⚠️ 带上 `context` 是**可选**的（老客户端忽略它），而 `docs` 一字未动。
          body.context = await contextPayload(root, payload, sort, kind)
          // v0.15：面板把「使用情况」开关打开后，请求会带 `usage=1` —— 那一刻开始记账。
          // v0.17 修订：开闸的同时**回填**这个会话已经发生的事件（闸门开晚时，
          // 前面那些真实发生过的读不该被显示成「未读」——那是假话，见 `backfillFeedback`）。
          // ⚠️ 默认（不带这个参数且本会话从未打开过）**一个字节都不记**。
          if (sessionId && url.searchParams.get('usage') === '1') {
            // 交上此刻手上的包，回填才能把补记的读归到「我们已知最早的那份包」，而不是包外。
            activateFeedback(sessionId, sessionOf(webCtx, sessionId), body.context)
          }
          if (sessionId && feedbackActive(sessionId)) {
            // ⚠️ 顺序是刻意的：先取 usage（它报告的是**上一份**包之后发生了什么），
            // 再把这一份包记成新快照 —— 从下一次请求起，它才是「上一份」。
            //
            // v0.17：当前版本标记用**全量**扫描结果建立，不是被 limit 截断的这一页 ——
            // 否则一篇被读过、但没落在当前页的文档拿不到当前 mtime，会永远停在「已读」。
            const full = Array.isArray(payload.allDocs) && payload.allDocs.length > 0
              ? payload.allDocs
              : payload.docs
            const mtimes = new Map(full.map((doc) => [doc.rel, doc.mtimeMs]))
            const usage = auditBridge.usage(sessionId, mtimes)
            // lifecycle 只发真正会渲染的那些行：当前页 ∪ 包外明细（后者的「已读 ×N」
            // 也要显示，只按当前页裁剪会把它们的状态丢掉）。
            const rels = new Set([
              ...body.docs.map((doc) => doc.rel),
              ...((usage && Array.isArray(usage.outsideDocs) ? usage.outsideDocs : [])
                .map((row) => row.rel)),
            ])
            body.usage = publicUsage(usage, 20, rels)
            if (body.context) auditBridge.note(sessionId, body.context)
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
          const kind = kindParam === 'all' || kindParam === 'media' || kindParam === 'code'
            ? kindParam
            : 'doc'
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
            auditBridge.note(sessionId, context)
          }
          sendJson(res, 200, { ok: true, root, hostRoot: hostPathOf(root), mode: payload.mode, topic: payload.topic, context })
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

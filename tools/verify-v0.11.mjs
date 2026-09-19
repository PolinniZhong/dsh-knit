#!/usr/bin/env node
/**
 * Knit v0.11 ② 的**真机验收**脚本。
 *
 * 背景：② 加了「命中段落」之后，成败**不是**算法问题而是行为问题 ——
 * agent 拿到段落之后**还会不会去 `read` 整篇**。判据写在
 * `01_ Knit PRD/Knit_SDD-v0.11-knit_docs命中段落.md` §六，这个脚本把那段判据自动化。
 *
 * 用法：
 *
 * ```sh
 * node tools/verify-v0.11.mjs              # 自动取当前工作区最近的**主**会话
 * node tools/verify-v0.11.mjs <sessionId>  # 指定会话
 * ```
 *
 * 只读：只解压并分析会话日志，不改任何东西、不发网络请求。
 *
 * ⚠️ 会话日志是**多帧** zstd，Node 的 `zstdDecompressSync` 只解第一帧 ——
 * 所以这里走 `zstd -dc` 命令行（`AGENTS.md` 记过这个坑）。
 */
import { execFileSync } from 'node:child_process'
import { readdirSync, statSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 工作区：本文件在 `knit/tools/`，上两级就是项目根。 */
const WORKSPACE = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

/** 包根：`knit/` 自己。宿主半边源码在 `knit/src/host/`（**不在** WORKSPACE 下）。 */
const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** 会话根目录。 */
const SESSIONS_ROOT = join(homedir(), '.dsh', 'sessions')

/**
 * 找到当前工作区对应的会话目录。
 *
 * **不自己拼转义名**（`/`→`-`、空格→`~0020` 之类的规则不值得复刻，
 * 拼错了会静默找不到）—— 直接在 `~/.dsh/sessions/` 下按工作区末段名匹配。
 *
 * @returns {string|null} 会话目录绝对路径
 */
function findSessionDir() {
  let entries
  try {
    entries = readdirSync(SESSIONS_ROOT)
  } catch {
    return null
  }
  const tail = WORKSPACE.split('/').filter(Boolean).pop() || ''
  const hit = entries
    .filter((name) => name.includes(tail))
    .map((name) => join(SESSIONS_ROOT, name))
    .filter((dir) => statSync(dir).isDirectory())
  if (hit.length === 0) return null
  // 有多个就取最近改动的那个
  return hit.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0]
}

/**
 * 列出会话目录里的主会话（子代理的目录名是裸 id，主会话带 `session-` 前缀），
 * 按日志修改时间从新到旧。
 *
 * @param {string} dir - 会话目录
 * @param {boolean} [includeSubagents] - 连子代理会话一起列（显式指定 id 时用）
 * @returns {Array<{id: string, file: string, mtimeMs: number}>} 会话
 */
function listMainSessions(dir, includeSubagents = false) {
  return readdirSync(dir)
    .filter((name) => includeSubagents || name.startsWith('session-'))
    .map((name) => ({ id: name, file: join(dir, name, 'session.v3.jsonl.zstd') }))
    .filter((s) => existsSync(s.file))
    .map((s) => ({ ...s, mtimeMs: statSync(s.file).mtimeMs }))
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
}

/**
 * 解压并逐行解析会话日志。
 *
 * @param {string} file - 日志文件
 * @returns {object[]} 事件数组（解析失败的行直接跳过）
 */
function readEvents(file) {
  const raw = execFileSync('zstd', ['-dc', file], { maxBuffer: 256 * 1024 * 1024 }).toString('utf8')
  const events = []
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    try {
      events.push(JSON.parse(line))
    } catch {
      // 半行 / 损坏行跳过，不影响整体分析
    }
  }
  return events
}

/**
 * 把工具结果事件里的文本抽出来。
 *
 * @param {object} event - `tool/result` 事件
 * @returns {string} 文本
 */
function resultText(event) {
  const content = (event.data && event.data.message && event.data.message.content) || []
  const out = []
  for (const block of content) {
    for (const inner of (block && block.content) || []) {
      if (inner && inner.type === 'text' && typeof inner.text === 'string') out.push(inner.text)
    }
  }
  return out.join('\n')
}

/**
 * 列出 `~/.dsh/sessions/` 下所有工作区的会话目录。
 *
 * **为什么要全库搜**：② 必须在一个「文档多、但没有 AGENTS.md 点名」的**别的项目**里验，
 * 而脚本原先只在**自己所在的工作区**里找会话 —— 指定的 id 明明存在却报「找不到」。
 * 这是实测踩出来的 bug（2026-09-19）。
 *
 * @returns {string[]} 会话目录绝对路径
 */
function allSessionDirs() {
  try {
    return readdirSync(SESSIONS_ROOT)
      .map((name) => join(SESSIONS_ROOT, name))
      .filter((dir) => statSync(dir).isDirectory())
  } catch {
    return []
  }
}

/**
 * 按 id 全库解析一个会话。
 *
 * @param {string} wanted - 会话 id（带或不带 `session-` 前缀都行）
 * @returns {{session: object, dir: string}|null} 命中的会话与其工作区目录
 */
function findSessionById(wanted) {
  for (const dir of allSessionDirs()) {
    const hit = listMainSessions(dir, true)
      .find((s) => s.id === wanted || s.id === `session-${wanted}`)
    if (hit) return { session: hit, dir }
  }
  return null
}

/* ── 主流程 ─────────────────────────────────────────── */

const wanted = process.argv[2]

let found = null
if (wanted) {
  found = findSessionById(wanted)
  if (!found) {
    console.error(`全库找不到会话 ${wanted}（已搜过 ${SESSIONS_ROOT} 下所有工作区）`)
    process.exit(2)
  }
} else {
  /**
   * 不给 id 时的默认选择：**最近的主会话，但优先取「别的项目」里的那个。**
   *
   * 两个理由：
   *   1. ② 的验收**必须**在别的项目里做 —— 本仓库的 `AGENTS.md` 点名了答案，
   *      在这里问什么都测不到排序工具（见 §6.10）。
   *   2. 本工作区的「最近会话」很可能就是**你正在跑脚本的这个长会话**
   *      （实测它已经有 997 次工具调用），拿它判定毫无意义。
   *
   * 所以先排除本工作区，实在没有别的才退回本工作区。
   */
  const ownDir = findSessionDir()
  const all = allSessionDirs()
    .flatMap((dir) => listMainSessions(dir).map((s) => ({ ...s, dir })))
    .sort((a, b) => (b.mtimeMs || 0) - (a.mtimeMs || 0))

  if (all.length === 0) {
    console.error(`全库都没有主会话：${SESSIONS_ROOT}`)
    process.exit(2)
  }

  const outside = all.filter((s) => s.dir !== ownDir)
  const latest = outside[0] || all[0]
  found = { session: latest, dir: latest.dir }

  console.log('（没给会话 id —— 自动选了最近的主会话，优先「别的项目」里的那个）')
  console.log('最近的会话：')
  for (const [i, s] of all.slice(0, 4).entries()) {
    const mark = s === latest ? '← 判定这一个' : ''
    const own = s.dir === ownDir ? '（本工作区）' : ''
    console.log(`  ${i + 1}. ${s.id}  ${new Date(s.mtimeMs).toLocaleString('zh-CN')} ${own} ${mark}`)
  }
  console.log('  要换一个：node tools/verify-v0.11.mjs <会话 id>')
  console.log()
}

const picked = found.session
const events = readEvents(picked.file)

// 按 callId 关联 call ↔ result
const calls = new Map()
const order = []
for (const event of events) {
  const d = event.data || {}
  if (event.type === 'tool/call' && d.callId) {
    calls.set(d.callId, { name: d.name, args: d.arguments, text: null, turn: d.turn, time: event.time })
    order.push(d.callId)
  } else if (event.type === 'tool/result') {
    const id = d.message && d.message.source && d.message.source.callId
    if (id && calls.has(id)) calls.get(id).text = resultText(event)
  }
}

const knitCalls = order.map((id) => calls.get(id)).filter((c) => c && c.name === 'knit_docs')

/**
 * 用户真正问了什么。**「没调工具」有两种完全不同的原因**：
 *   - 问题本身是「查一个事实」→ agent 的反射是 grep，不是挑文档（工具没错，问题形状不对）
 *   - 问题确实需要挑文档 → 那才是工具的可发现性问题
 * 不把提问打出来，这两种就分不开。
 */
const asked = []
for (const event of events) {
  if (event.type !== 'user/message') continue
  const d = event.data || {}
  if ((d.source || {}).kind !== 'user') continue
  const c = d.content
  const text = typeof c === 'string'
    ? c
    : Array.isArray(c) ? c.filter((p) => p && p.type === 'text').map((p) => p.text).join('\n') : ''
  if (text.trim()) asked.push(text.trim())
}

/** agent 实际用了什么工具 —— 「0 次 knit_docs」的对照组证据。 */
const usedTools = new Map()
for (const id of order) {
  const name = calls.get(id) && calls.get(id).name
  if (name) usedTools.set(name, (usedTools.get(name) || 0) + 1)
}
const usedLine = [...usedTools.entries()].sort((a, b) => b[1] - a[1])
  .map(([n, c]) => `${n}×${c}`).join('  ')

/**
 * 工作区路径：**从日志里取，不要解码会话目录名。**
 * 目录名把 `/` 和名字里的字面 `-` 都写成 `-`（`…Native-05_LoreFlow-Copilot`），
 * 有歧义，反解会错。运行时上下文那条 plugin 消息里带的是**真路径**。
 */
let sessionCwd = null
/** 这次请求实际挂给模型的工具名 —— 用来区分「工具没挂上」和「挂了但没被选」。 */
let sessionTools = null
for (const event of events) {
  const d = event.data || {}
  if (event.type === 'request/header' && d.header && Array.isArray(d.header.tools)) {
    sessionTools = d.header.tools.map((t) => t && t.name).filter(Boolean)
  }
  if (event.type === 'user/message' && (d.source || {}).kind === 'plugin') {
    const c = d.content
    const text = typeof c === 'string'
      ? c
      : Array.isArray(c) ? c.filter((p) => p && p.type === 'text').map((p) => p.text).join('\n') : ''
    const m = /session workspace: "([^"]+)"/.exec(text)
    if (m) sessionCwd = m[1]
  }
}

const workspacePath = sessionCwd || found.dir.split('/').pop()
const workspaceName = workspacePath.split('/').pop()

/** 在 Knit 自己的仓库里验 ② 是**结构性无效**的（AGENTS.md 点名了每篇文档）。 */
const inKnitRepo = workspaceName === '08_Knit'

/** `knit_docs` 当时到底挂上了没有 —— 决定「没调」该怎么解释。 */
const toolRegistered = sessionTools === null ? null : sessionTools.includes('knit_docs')

console.log('═'.repeat(72))
console.log('Knit v0.11 ② 真机验收')
console.log('═'.repeat(72))
console.log(`会话      ${picked.id}`)
// 工作区用会话目录名还原（`--Users-…-05_LoreFlow-Copilot--` 这种转义名）
console.log(`工作区    ${workspacePath}`)
console.log(`日志      ${picked.file}`)
console.log(`工具调用  ${order.length} 次，其中 knit_docs ${knitCalls.length} 次`)
if (usedLine) console.log(`实际用到  ${usedLine}`)
console.log(`工具清单  ${sessionTools === null
  ? '(日志里没有 request/header，取不到)'
  : `${sessionTools.length} 个，knit_docs ${toolRegistered ? '在 ✓' : '不在 ✗'}`}`)

/**
 * 宿主新鲜度 —— 「运行中的宿主到底加载了哪一版宿主半边」。
 *
 * 这个问题每次都要问一遍（宿主半边不热加载），而答案**不用猜**：
 * `link:` 插件在宿主启动时读磁盘，所以只要**宿主启动时间晚于 `src/host/*.js`
 * 的 mtime**，跑的就是当前代码。
 *
 * `dsh-web.log` 里是一次**完整启动序列**（各插件的 `apply` → 路由注册 →
 * 末行 `dsh web: http://127.0.0.1:3080/…`），所以它的 mtime 就是这次启动的时间。
 *
 * ⚠️ 这是**推断**（日志按大小轮转，mtime 未必精确等于启动时刻），
 * 所以两个时间都打出来，让人自己看一眼。
 */
function hostFreshness() {
  const log = join(homedir(), 'Library', 'Application Support',
    'io.github.hairyf.deepseek-harness-desktop', 'logs', 'dsh-web.log')
  let bootMs
  try {
    bootMs = statSync(log).mtimeMs
  } catch {
    return null
  }
  let newest = 0
  let newestName = ''
  try {
    for (const name of readdirSync(join(PACKAGE_ROOT, 'src', 'host'))) {
      if (!name.endsWith('.js')) continue
      const m = statSync(join(PACKAGE_ROOT, 'src', 'host', name)).mtimeMs
      if (m > newest) {
        newest = m
        newestName = name
      }
    }
  } catch {
    return null
  }
  if (newest === 0) return null
  return { bootMs, newest, newestName, fresh: bootMs > newest }
}

const fresh = hostFreshness()
if (fresh) {
  const at = (ms) => new Date(ms).toLocaleString('zh-CN')
  console.log(`宿主新鲜度 ${fresh.fresh
    ? '✅ 宿主启动晚于宿主半边改动 —— 跑的是当前代码'
    : '⚠️ 宿主启动**早于**宿主半边改动 —— 需要重启 DSH（§4.2）'}`)
  console.log(`           启动 ${at(fresh.bootMs)}　最新改动 ${at(fresh.newest)}（src/host/${fresh.newestName}）`)
}
if (asked.length) {
  console.log()
  asked.forEach((q, i) => {
    const first = q.split('\n').map((s) => s.trim()).filter(Boolean)[0] || ''
    console.log(`你问的第 ${i + 1} 句  ${first.length > 96 ? first.slice(0, 96) + '…' : first}`)
  })
}
console.log()

if (knitCalls.length === 0) {
  console.log('❌ **这个会话里 agent 一次都没调 `knit_docs`** —— 验不了 ②。')
  console.log()
  console.log('但「没调」有三种原因，先分清是哪一种：')
  console.log()

  if (toolRegistered === false) {
    console.log('【原因 C · 工具根本没挂上 —— 先修安装，别谈 ②】')
    console.log()
    console.log('  这次请求的工具清单里**没有 `knit_docs`**，所以 agent 不可能调到它。')
    console.log('  多半是宿主半边没生效（DSH 没重启）或 profile 里插件被禁用。')
    console.log()
    console.log('  先查：')
    console.log('    curl -s "http://127.0.0.1:3080/knit/api/raw?rel=nope.png"')
    console.log('      → {"ok":false,"code":"knit/not-found"} = 新代码在跑')
    console.log('      → 空 body 的 404                        = 旧代码还在跑，**重启 DSH**')
    console.log('    dsh plugin --profile web list | grep knit')
    console.log()
    console.log('  → 这不是 ② 的结论。**修完安装再重跑。**')
  } else if (inKnitRepo) {
    console.log('【原因 A · 这个工作区里 ② 结构上就验不了】')
    console.log()
    console.log('  你在 **Knit 自己的仓库**里验的。项目根的 `AGENTS.md` 会进 agent 的')
    console.log('  系统提示词，而它的 §2「必读顺序」和 §8「目录结构」把**几乎每篇文档')
    console.log('  都点名了**。agent 一看就知道去哪，不需要任何文档发现工具 ——')
    console.log('  Knit 想解决的问题，在这个仓库里已经被 AGENTS.md 解决了。')
    console.log()
    console.log('  实测印证：一次这样的会话里，agent 的第一个动作就是')
    console.log('    glob {"pattern": "01_ Knit PRD/Knit_SDD-v0.8*"}')
    console.log('  它**已经知道确切文件名**，后面全是 read。')
    console.log()
    console.log('  → 这不是 ❌ 无效，是「测不了」。**换工作区重来。**')
  } else {
    console.log('【原因 B · 问题形状不对 —— agent 把它当「查事实」而不是「挑文档」】')
    console.log()
    console.log(`  这个工作区（${workspaceName}）不是 Knit 仓库，`)
    console.log('  所以「AGENTS.md 点名」解释不了上面那份工具清单。')
    console.log()
    console.log('  真正的机制是：**`knit_docs` 的触发条件是「给我一个候选清单」，')
    console.log('  不是「帮我查一个事实」。** 问「当初为什么决定 X」，agent 的反射是')
    console.log('  grep 一个关键词、拿到精确答案；它不会想到去要一个**排序过的文档列表**。')
    console.log()
    console.log('  所以上面 `实际用到` 那行如果全是 grep / bash / read，')
    console.log('  那是**工具可发现性**的问题（v0.7–v0.9 的老问题），')
    console.log('  **不是 ② 的判定** —— ② 只在 `knit_docs` 被调用的前提下才有意义。')
    console.log()
    console.log('  → 换个**「要清单 + 要大意」**的问法，别问事实：')
    console.log('     「这个项目里讲 <主题> 的是哪几篇？各自侧重什么？」')
  }

  console.log()
  console.log('─'.repeat(72))
  console.log('重来的操作：')
  console.log('  1. **重启 DSH**（宿主半边改了必须重启，见 AGENTS.md §4.2）')
  console.log('  2. 换一个「文档多、AGENTS.md 没点名」的真实项目开新会话')
  console.log('  3. 问一个**要清单 + 要大意**的问题（不是「X 在哪」「为什么决定 Y」）')
  console.log('  4. 再跑：node tools/verify-v0.11.mjs')
  console.log()
  console.log('（验证脚本本身没问题 —— 它如实报告了「没调工具」这个事实。）')
  process.exit(1)
}

// 看每一次 knit_docs：结果有没有 match: 行，下一个工具是什么
const at = (t) => (t ? new Date(t).toLocaleString('zh-CN') : '(无时间)')
let verdict = null

knitCalls.forEach((call, i) => {
  const callId = [...calls.entries()].find(([, v]) => v === call)[0]
  const idx = order.indexOf(callId)
  const next = order.slice(idx + 1).map((id) => calls.get(id)).find(Boolean)
  const hasMatch = /(^|\n)\s*match: /m.test(call.text || '')
  const matchCount = ((call.text || '').match(/(^|\n)\s*match: /g) || []).length
  const isLast = i === knitCalls.length - 1

  console.log(`── knit_docs #${i + 1}${isLast ? '（最近一次 · 判定依据）' : ''} ──────────────`)
  console.log(`  时间          ${at(call.time)}`)
  console.log(`  参数          ${call.args}`)
  if (!call.text) {
    console.log('  结果          未捕获到（会话还在跑？）')
    console.log()
    return
  }
  console.log(`  结果体量      ${call.text.length} 字符`)
  console.log(`  match: 行     ${hasMatch ? `✅ ${matchCount} 条` : '❌ 一条都没有'}`)
  if (hasMatch) {
    const sample = (call.text.match(/(^|\n)\s*(match: .*)/) || [])[2] || ''
    console.log(`  样例          ${sample.trim().slice(0, 90)}…`)
  }
  /* ── 后续动作：**光是「下一个工具是 bash」判不出「照读整篇」** ──
   * 实测反例（2026-09-19 `session-c18b5457`）：拿到 20 条 `match:` 之后
   * 下一个工具是 `bash`，但那条 bash 只是 `pwd && ls -la` —— 一个字的正文都没读。
   * 只看下一个工具会把这个判成「无效」。
   *
   * 所以按**内容读取量**判：`read` 算读正文，`bash` 里只有
   * `sed -n` / `cat` / `head` / `tail` / `awk` 这类才算。
   */
  const after = order.slice(idx + 1).map((id) => calls.get(id)).filter(Boolean)
  const argText = (c) => String(c.args == null ? '' : c.args)
  const reads = after.filter((c) => c.name === 'read')
  const ranged = reads.filter((c) => /"(offset|limit)"\s*:/.test(argText(c)))
  const bashReads = after.filter((c) => c.name === 'bash' &&
    /(^|[;&|(\s])(sed\s+-n|cat\s|head\s|tail\s|awk\s)/.test(argText(c)))
  const contentReads = reads.length + bashReads.length

  let argLimit = null
  try {
    const a = typeof call.args === 'string' ? JSON.parse(call.args) : call.args
    if (a && Number.isFinite(Number(a.limit))) argLimit = Number(a.limit)
  } catch { /* 参数不是 JSON 就不管 */ }
  const askedForList = argLimit !== null && argLimit >= 10

  console.log(`  下一个工具    ${next ? next.name : '(没有，直接回答了)'}`)
  if (after.length > 0) {
    console.log(`  后续动作      ${after.length} 次 —— read ${reads.length}` +
      `${reads.length ? `（带 offset/limit 的 ${ranged.length}）` : ''}，` +
      `bash ${after.filter((c) => c.name === 'bash').length}` +
      `${bashReads.length ? `（其中像「读正文」的 ${bashReads.length}）` : ''}`)
  }

  // 只按**最近一次**判定 —— 会话里更早的调用可能发生在实现之前，
  // 拿它们下结论会误报（这个脚本第一版就犯过）。
  if (!isLast) {
    console.log('  → （历史调用，不参与判定）')
    console.log()
    return
  }

  if (!hasMatch) {
    console.log('  → ⚠️  这次结果里没有段落。两种可能：**跑的是旧代码**（没重启），')
    console.log('      或者这次调用发生在实现之前。重启后再问一次即可区分。')
    verdict = 'stale'
  } else if (after.length === 0) {
    console.log('  → ✅ **有效**：拿到段落之后直接回答，没有再看别的')
    verdict = 'good'
  } else if (contentReads === 0) {
    console.log('  → ✅ **有效**：后续只有列目录 / grep 这类**没读正文**的动作，')
    console.log('      `match:` 段落拦住了「读整篇」这一下')
    verdict = 'good'
  } else if (askedForList) {
    console.log(`  → ⚠️ **这一轮判不了 ②**（测例混杂）：agent 要的是 \`limit: ${argLimit}\`，`)
    console.log('     那是**一份清单**而不是候选。拿到 20 条路径之后去读其中几篇，')
    console.log('     是问法的必然结果 —— 段落有没有省下 read，这一轮问不出来。')
    console.log(`     要判 ② 得把 limit 收到默认的 5，并且问一件**答案只在一篇里**的事。`)
    verdict = 'confounded'
  } else if (contentReads <= 1 && ranged.length === reads.length) {
    console.log('  → ✅ **部分有效**：只带 offset/limit 读了一小段，没有照读整篇')
    verdict = 'partial'
  } else {
    console.log(`  → ❌ **无效**：拿到段落之后仍读了 ${contentReads} 处正文` +
      `（read ${reads.length} / bash 读片段 ${bashReads.length}）`)
    console.log('     按 v0.9 的纪律：**如实记录、停手、不试第三轮**。')
    verdict = 'bad'
  }
  console.log()
})

console.log('═'.repeat(72))
console.log('结论')
console.log('═'.repeat(72))
const words = {
  good: '✅ **有效** —— 段落拦住了「读整篇」这一下。按 SDD §一，这是 18 倍回报。',
  partial: '✅ **部分有效** —— 只带 offset/limit 读了一小段，没有照读整篇。',
  bad: '❌ **无效，负收益** —— agent 照读整篇。按 v0.9 的纪律：**如实记录、停手、不试第三轮**。',
  confounded: '⚠️ **这一轮判不了 ②**（测例混杂）—— `match:` 段落是有的（机制没问题），\n'
    + '    但 agent 要的是 `limit: N` 的**清单**，拿到之后去读其中几篇是问法的必然结果。\n'
    + '    **这不是「无效」，也不能算「有效」** —— 换一个问法重来（见下）。',
  stale: '⚠️ **没验成** —— 最近一次 `knit_docs` 的结果里没有 `match:` 行。\n'
    + '    两种可能：**跑的还是旧代码**（宿主半边不热加载，必须重启），\n'
    + '    或者这次调用发生在实现之前。**重启 DSH，再问一次**即可区分。',
}
console.log(words[verdict] || '⚠️ 情况不明，人工看上面的调用序列。')
console.log()
console.log('提醒：')
console.log('  1. ② 是宿主侧改动 —— **没重启 DSH 就一定验不出东西**')
console.log('  2. 判据的完整五种情形见 Knit_SDD-v0.11-knit_docs命中段落.md §六')
console.log('  3. 「read 但只带 offset/limit 读一小段」算**部分有效**，比照读整篇好')
console.log('  4. **别问「哪几篇 / 各自侧重什么」** —— 那是在要清单，agent 会开 `limit: 20`，')
console.log('     拿到 20 条路径去翻几篇是必然的。要问**一件答案只在一篇里**的事。')

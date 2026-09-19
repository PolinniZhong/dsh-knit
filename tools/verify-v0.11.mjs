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

/* ── 主流程 ─────────────────────────────────────────── */

const wanted = process.argv[2]
const sessionDir = findSessionDir()
if (!sessionDir) {
  console.error(`找不到工作区对应的会话目录：${SESSIONS_ROOT}（工作区 ${WORKSPACE}）`)
  process.exit(2)
}

const sessions = listMainSessions(sessionDir, Boolean(wanted))
const picked = wanted
  ? sessions.find((s) => s.id === wanted || s.id === `session-${wanted}`)
  : sessions[0]

if (!picked) {
  console.error(`找不到会话 ${wanted || '(最近)'}；可用：\n  ` + sessions.slice(0, 5).map((s) => s.id).join('\n  '))
  process.exit(2)
}

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

console.log('═'.repeat(72))
console.log('Knit v0.11 ② 真机验收')
console.log('═'.repeat(72))
console.log(`会话      ${picked.id}`)
console.log(`日志      ${picked.file}`)
console.log(`工具调用  ${order.length} 次，其中 knit_docs ${knitCalls.length} 次`)
console.log()

if (knitCalls.length === 0) {
  console.log('❌ **这个会话里 agent 一次都没调 `knit_docs`** —— 验不了 ②。')
  console.log('   换一个「需要看文档内容」的问题再问一遍（不是「文档在哪」）。')
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
  console.log(`  下一个工具    ${next ? next.name : '(没有，直接回答了)'}`)

  // 只按**最近一次**判定 —— 会话里更早的调用可能发生在实现之前，
  // 拿它们下结论会误报（这个脚本第一版就犯过）。
  if (!isLast) {
    console.log('  → （历史调用，不参与判定）')
    console.log()
    return
  }

  const readAfter = next && /^(read|bash|grep|glob|find)$/.test(next.name)
  if (!hasMatch) {
    console.log('  → ⚠️  这次结果里没有段落。两种可能：**跑的是旧代码**（没重启），')
    console.log('      或者这次调用发生在实现之前。重启后再问一次即可区分。')
    verdict = 'stale'
  } else if (!readAfter) {
    console.log('  → ✅ **有效**：拿到段落之后没有再读整篇')
    verdict = 'good'
  } else {
    console.log(`  → ❌ **无效**：拿到段落之后仍然 \`${next.name}\`（按纪律停手，不试第三轮）`)
    verdict = 'bad'
  }
  console.log()
})

console.log('═'.repeat(72))
console.log('结论')
console.log('═'.repeat(72))
const words = {
  good: '✅ **有效** —— 段落拦住了那次 read。按 SDD §一，这是 18 倍回报。',
  bad: '❌ **无效，负收益** —— agent 照读整篇。按 v0.9 的纪律：**如实记录、停手、不试第三轮**。',
  stale: '⚠️ **没验成** —— 最近一次 `knit_docs` 的结果里没有 `match:` 行。\n'
    + '    两种可能：**跑的还是旧代码**（宿主半边不热加载，必须重启），\n'
    + '    或者这次调用发生在实现之前。**重启 DSH，再问一次**即可区分。',
}
console.log(words[verdict] || '⚠️ 情况不明，人工看上面的调用序列。')
console.log()
console.log('提醒：')
console.log('  1. ② 是宿主侧改动 —— **没重启 DSH 就一定验不出东西**')
console.log('  2. 判据的完整四种情形见 Knit_SDD-v0.11-knit_docs命中段落.md §六')
console.log('  3. 「read 但只带 offset/limit 读一小段」算**部分有效**，比照读整篇好')

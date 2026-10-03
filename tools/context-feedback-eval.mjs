#!/usr/bin/env node
/**
 * Context Feedback Eval —— 「Context Pack 交出去之后，真的被用了吗」的量尺（v0.16）。
 *
 * **为什么要有它**：v0.14 已经能算出「这个任务该先看哪一篇」，但没有任何证据表明
 * agent 真的去读了那一篇。`feedback.js` 把这件事变成可测量的事实，这个脚本负责
 * **在真实会话日志上**把五个指标算出来：
 *
 *   · Primary follow-through —— 主看的那篇最终被读了吗
 *   · First read tier       —— 第一次读落在哪一层（primary / supporting / related / outside）
 *   · Supporting coverage   —— 辅助篇里被读到的比例
 *   · Outside-context       —— 有多少次读**不在**当时那份包里面
 *   · Context churn         —— 上下文换过几次、进出换层各多少
 *   · Continued / re-entry  —— 离开上下文后还读了几次、重新进来后又读了几次
 *
 * **它是回放的，不是监听的**：拿一份会话日志（`~/.dsh/sessions/<工作区>/<会话>/session.v4.jsonl.zstd`），
 * 按时间顺序把每个「真实 read 发生的那一刻」重演一遍 —— 用**磁盘上这份代码**的
 * `scan()` + `buildContextFor()` 现算出那一刻的包，再喂给**同一个** `feedback.js`
 * （`noteSnapshot()` / `ingestEvents()` / `usageFor()`）。
 *
 * ⚠️ **归因规则只有一份**：runtime 与这里都不自己算「这一读落在哪一层」——
 * 都走 `feedback.js` 的 `snapshotAt()` / `attributeRead()`。所以两边的**规则**逐字一致；
 * 对不齐的只是「交付时刻」（面板轮询 / 工具调用是采样，这里是每个读一份合成包），
 * 那是**数字**层面的差异，不是规则层面的（见 `Knit_评审-v0.16-基于DSH开放能力.md` §2）。
 * 所以：不需要重启宿主、不需要订阅 event bus、零网络、零模型、不写盘。
 * 历史会话也能补测（v0.14 的实验会话一样能算）。
 *
 * 用法：
 *   node tools/context-feedback-eval.mjs                      # 最近一份会话
 *   node tools/context-feedback-eval.mjs --session-id <id>    # 指定会话
 *   node tools/context-feedback-eval.mjs --session <路径>      # 直接给日志文件
 *   node tools/context-feedback-eval.mjs --control            # 对照组：不交包（读数应当全部 outside）
 *   node tools/context-feedback-eval.mjs --json               # 机器可读
 *
 * ⚠️ 它**只量**，不下结论：`outside` 高不高要看任务本身要不要读别的文件。
 * 脚本末尾给出的 `read:` 阈值只用来区分「量尺坏了」与「结果就是这样」。
 */
import { existsSync, readdirSync, statSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'

import { scan, buildContextFor } from '../src/host/index.js'
import { createStore, activateAudit, ingestEvents, noteSnapshot, normalizeReadEvidence, usageFor } from '../src/host/feedback.js'

const HERE = dirname(fileURLToPath(import.meta.url))
/** `knit/tools/` → 工作区根是再上两级（`08_Knit`）。会话日志里 `session.cwd` 覆盖它。 */
export const DEFAULT_ROOT = resolve(HERE, '..', '..')

/**
 * 把 `usageFor()` 的结果压成五个指标 + 若干计数。
 *
 * @param {object|null} usage - `usageFor()` 的结果
 * @returns {object} 指标
 */
export function metricsFor(usage) {
  const stats = (usage && usage.stats) || {}
  const churn = stats.churn || {}
  return {
    reads: stats.reads || 0,
    distinct: stats.distinct || 0,
    primaryRead: !!(stats.primaryFollowThrough),
    primaryRel: stats.primaryRel || '',
    firstReadTier: stats.firstReadTier || null,
    firstReadRel: stats.firstReadRel || '',
    supportingCoverage: stats.supportingCoverage === undefined ? null : stats.supportingCoverage,
    outside: stats.outside || 0,
    outsideReads: stats.outsideReads || [],
    contextChanges: churn.changes || 0,
    epochs: churn.epochs || 0,
    continuedReadsAfterExit: stats.continuedReadsAfterExit || 0,
    reentries: stats.reEntries || 0,
    appeared: churn.appeared || 0,
    disappeared: churn.disappeared || 0,
    moved: churn.moved || 0,
    taskChanged: churn.taskChanged || 0,
  }
}

/**
 * 解析 JSONL 事件流。坏行**跳过**（真实日志的尾行可能是半截的）。
 *
 * @param {string} text - JSONL 文本
 * @returns {object[]} 事件
 */
export function parseEvents(text) {
  const events = []
  for (const line of String(text || '').split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const value = JSON.parse(trimmed)
      if (value && typeof value === 'object') events.push(value)
    } catch {
      // 半截的尾行 / 坏行：跳过。**不抛** —— 量尺不该因为一行垃圾就停摆
    }
  }
  return events
}

/**
 * 读一份会话日志（`.jsonl.zstd` 用系统 `zstd -dc`；`.jsonl` 直接读）。
 *
 * @param {string} file - 日志路径
 * @returns {string} JSONL 文本
 */
export function readSessionText(file) {
  if (file.endsWith('.zstd')) {
    const out = spawnSync('zstd', ['-dc', file], { maxBuffer: 1 << 30 })
    if (out.error) throw new Error(`需要系统 zstd 才能解开 ${basename(file)}：${out.error.message}`)
    // 会话正在被写入时最后一帧可能不完整 —— 已解出来的部分照样能用
    return String(out.stdout || '')
  }
  const out = spawnSync('cat', [file], { maxBuffer: 1 << 30 })
  return String(out.stdout || '')
}

/**
 * 找最近一份会话日志。
 *
 * ⚠️ **不猜目录名的转义规则**（`~0020` 那套只对空格成立，路径里的连字符会让它歧义）——
 * 直接遍历 `~/.dsh/sessions/<工作区>/<会话>/`。
 *
 * @param {string} [sessionsDir] - 覆盖 `~/.dsh/sessions`
 * @returns {string|null} 日志路径
 */
export function findLatestSessionLog(sessionsDir = join(homedir(), '.dsh', 'sessions')) {
  let best = null
  let bestAt = -1
  for (const workspace of listDirs(sessionsDir)) {
    for (const session of listDirs(workspace)) {
      for (const file of sessionLogsIn(session)) {
        try {
          const at = statSync(file).mtimeMs
          if (at > bestAt) { bestAt = at; best = file }
        } catch {
          // 读不动：继续找
        }
      }
    }
  }
  return best
}

/**
 * 列一个会话目录里的日志，**格式版本从新到旧**。
 *
 * ⚠️ 不写死 `session.v4.jsonl.zstd`：宿主的 `SESSION_FORMAT_VERSION` 会往前走，
 * 而且同一台机器上老会话还留在 v0 / v3 上（本机三代并存）。只认形状，不认具体版本号。
 *
 * @param {string} dir - 会话目录
 * @returns {string[]} 日志绝对路径
 */
export function sessionLogsIn(dir) {
  let names = []
  try {
    names = readdirSync(dir)
  } catch {
    return []
  }
  return names
    .map((name) => ({ name, match: /^session\.v(\d+)\.jsonl(\.zstd)?$/.exec(name) }))
    .filter((entry) => entry.match)
    .sort((a, b) => Number(b.match[1]) - Number(a.match[1]) || a.name.localeCompare(b.name))
    .map((entry) => join(dir, entry.name))
}

/**
 * 按会话 id 找日志（id 是目录名的一部分，直接找同名目录）。
 *
 * @param {string} sessionId - 会话 id
 * @param {string} [sessionsDir] - 覆盖 `~/.dsh/sessions`
 * @returns {string|null} 日志路径
 */
export function findSessionLogById(sessionId, sessionsDir = join(homedir(), '.dsh', 'sessions')) {
  for (const workspace of listDirs(sessionsDir)) {
    for (const session of listDirs(workspace)) {
      if (basename(session) !== sessionId) continue
      const [file] = sessionLogsIn(session)
      if (file) return file
    }
  }
  return null
}

/**
 * 列目录（不存在 / 读不动 → 空数组）。
 * @param {string} dir - 目录
 * @returns {string[]} 子目录绝对路径
 */
function listDirs(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(dir, entry.name))
  } catch {
    return []
  }
}

/**
 * 把「读在包外」拆成两件**完全不同**的事。
 *
 * ⚠️ 这是这个量尺最容易骗人的地方：Knit **只索引 `.md`**。一次 `read knit/src/host/feedback.js`
 * 永远不可能落在包里 —— 那不是「包没命中」，是**Knit 根本不看这种文件**。
 * 不拆开，`outside` 就会一直很高，读起来像「Context Pack 没用」，其实量错了东西。
 *
 *   · `missed`     —— 文件在扫描结果里（Knit 看得到它）却没进包。**这才是真的漏**
 *   · `outOfScope` —— 压根不在 Knit 的索引里（非 `.md` / 超出上限）。与包无关
 *
 * @param {object|null} usage - `usageFor()` 的结果
 * @param {Iterable<string>} scanned - 这次回放里 `scan()` 见到过的全部 rel
 * @returns {{inScope:number, missed:string[], outOfScope:number, outOfScopeReads:string[]}} 拆分
 */
export function scopeFor(usage, scanned) {
  const seen = scanned instanceof Set ? scanned : new Set(scanned || [])
  const reads = (usage && usage.reads) || []
  const inScope = reads.filter((row) => seen.has(row.rel))
  const missed = inScope.filter((row) => row.outside)
  const out = reads.filter((row) => !seen.has(row.rel))
  return {
    inScope: inScope.length,
    missed: missed.map((row) => row.rel),
    missedReads: missed.reduce((sum, row) => sum + row.count, 0),
    outOfScope: out.length,
    outOfScopeReads: out.map((row) => row.rel),
  }
}

/**
 * 回放一份会话日志，产出**真实的**使用情况。
 *
 * 顺序刻意与宿主一致：**先把这一份包交出去，再记这次读** —— 于是一次读会被归到
 * 「它发生时生效的那一份」上（这正是 `feedback.js` 里 `snapshotAt()` 的语义）。
 *
 * @param {object[]} events - 会话事件
 * @param {object} [options] - 选项
 * @param {string} [options.root] - 工作区根（默认取日志首行 `session.cwd`）
 * @param {number} [options.limit] - 每次装配的候选上限
 * @param {boolean} [options.deliver] - `false` ＝ 对照组（不交包）
 * @param {string} [options.sessionId] - 会话 id（只用于分片）
 * @returns {Promise<{usage: object, metrics: object, packs: number, root: string}>} 结果
 */
export async function replaySession(events, options = {}) {
  const head = events.find((event) => event && event.type === 'session') || {}
  const root = resolve(options.root || head.cwd || DEFAULT_ROOT)
  const limit = Number.isFinite(options.limit) ? options.limit : 20
  const deliver = options.deliver !== false
  const sessionId = options.sessionId || head.id || 'eval'

  // 第一遍：先把「哪些位置发生过一次成功的读」问出来（用同一个 feedback.js 的
  // `normalizeReadEvidence()`，免得脚本自己再实现一遍事件配对规则 —— 两份实现必然漂移）。
  // ⚠️ 要的是**每一次**读，不只是每篇的第一次：同一篇被读第二次时，那一刻生效的包
  // 可能已经换了，正是 churn 要量的东西。
  const { reads: evidence } = normalizeReadEvidence(events, { root })
  const checkpoints = evidence
    .map((row) => ({ seq: row.seq, rel: row.rel, at: row.time }))
    .sort((a, b) => a.seq - b.seq)

  const store = createStore()
  activateAudit(store, sessionId)
  let packs = 0
  const scanned = new Set()
  for (const point of checkpoints) {
    // 「那一刻的对话」＝ seq ≤ 这次读的事件。装配器只认 user/assistant 消息，
    // 所以工具调用/返回混在里面不会污染话题。
    const upto = events.filter((event) => typeof event.seq === 'number' && event.seq <= point.seq)
    const payload = await scan(root, limit, {
      session: { header: { cwd: root }, snapshotEvents: () => upto },
      sessionId,
      sort: 'relevance',
    })
    const ranked = Array.isArray(payload.ranked) ? payload.ranked : []
    // 这一刻 Knit **看得到**的文件 —— 只有它们才有资格被算成「漏」
    for (const doc of ranked) if (doc && doc.rel) scanned.add(doc.rel)
    if (deliver && payload.mode === 'relevance') {
      const pack = await buildContextFor(root, {
        ranked,
        topic: payload.topic,
        task: payload.task,
        total: payload.total,
        withLinks: true,
      })
      noteSnapshot(store, sessionId, pack, { seq: point.seq, at: point.at })
      packs += 1
    }
    ingestEvents(store, sessionId, upto, { root })
  }
  // 收尾：把剩下的事件（读之后的事）也喂进去，游标推到最新
  ingestEvents(store, sessionId, events, { root })

  const usage = usageFor(store, sessionId)
  return { usage, metrics: metricsFor(usage), scope: scopeFor(usage, scanned), packs, root }
}

/**
 * 命令行入口。
 * @returns {Promise<number>} 退出码
 */
async function main() {
  const argv = process.argv.slice(2)
  const flag = (name) => argv.includes(name)
  const value = (name) => {
    const i = argv.indexOf(name)
    return i >= 0 ? argv[i + 1] : undefined
  }

  let file = value('--session')
  if (!file && value('--session-id')) file = findSessionLogById(value('--session-id'))
  if (!file) file = findLatestSessionLog()
  if (!file || !existsSync(file)) {
    console.error('没找到会话日志。用 --session <路径> 或 --session-id <id> 指定。')
    return 2
  }

  const events = parseEvents(readSessionText(file))
  const result = await replaySession(events, {
    root: value('--root'),
    limit: Number(value('--limit')) || undefined,
    deliver: !flag('--control'),
    sessionId: value('--session-id') || basename(dirname(file)),
  })

  if (flag('--json')) {
    console.log(JSON.stringify({ file, ...result }, null, 2))
    return 0
  }

  const m = result.metrics
  const head = events.find((event) => event && event.type === 'session') || {}
  console.log(`会话：${basename(dirname(file))}`)
  console.log(`工作区：${result.root}`)
  console.log(`模式：${flag('--control') ? 'Control（不交包）' : 'Treatment（交包）'} · 交了 ${result.packs} 份包`)
  console.log('')
  console.log(`Primary follow-through : ${m.primaryRead ? 'YES' : 'no'}${m.primaryRel ? `  (${m.primaryRel})` : ''}`)
  console.log(`First read tier        : ${m.firstReadTier === null ? '—（没有落在任何一层的读）' : m.firstReadTier}${m.firstReadRel ? `  (${m.firstReadRel})` : ''}`)
  console.log(`Supporting coverage    : ${m.supportingCoverage === null ? '—（这份包没有辅助篇）' : m.supportingCoverage.toFixed(2)}`)
  console.log(`Outside-context reads  : ${m.outside} / ${m.distinct} 篇（共 ${m.reads} 次）`)
  const scope = result.scope || { inScope: 0, missed: [], missedReads: 0, outOfScope: 0 }
  console.log(`  其中 Knit 看得到的：${scope.inScope} 篇（漏 ${scope.missedReads} 次）· 看不到的：${scope.outOfScope} 篇（非 .md / 超出上限）`)
  if (scope.missed.length) console.log(`  ⚠️ 真的漏了：${scope.missed.join('、')}`)
  if (m.outsideReads.length) console.log(`  不在包里的：${m.outsideReads.join('、')}`)
  console.log(`Context churn          : ${m.epochs} 个 Epoch（换过 ${m.contextChanges} 次）· 进 ${m.appeared} / 出 ${m.disappeared} / 换层 ${m.moved}${m.taskChanged ? ` · 任务变了 ${m.taskChanged}` : ''}`)
  console.log(`Continued / re-entry   : 离开后还读了 ${m.continuedReadsAfterExit} 篇 · 重新进来后又读了 ${m.reentries} 篇`)
  console.log('')
  // 量尺自检：Control 臂如果还能测出「落在层里」的读，那说明**量尺坏了**，不是结论。
  // v0.16：一次都没读才是 null；读过但在包外是 'outside' —— 后者在 Control 臂是**正常的**。
  if (flag('--control') && m.firstReadTier !== null && m.firstReadTier !== 'outside') {
    console.error('✗ Control 臂不该有落在层里的读 —— 量尺本身坏了')
    return 1
  }
  console.log('（只量事实，不下结论：outside 高不高，要看任务本身要不要读别的文件。）')
  return 0
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main().then((code) => process.exit(code)).catch((error) => {
    console.error(`✗ ${(error && error.message) || error}`)
    process.exit(1)
  })
}

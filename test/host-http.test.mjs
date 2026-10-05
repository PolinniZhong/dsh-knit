/**
 * 宿主 HTTP 端到端：在真实回环端口上跑 apply() 注册的路由。
 *
 * 纯函数单测覆盖不到的部分在这里验证：/raw 整文件 200、HTTP Range 206 与
 * Content-Range/字节数、安全响应头、路径越界 / 扩展名白名单 / 方法限制。
 *
 * 跑法：node --test test/host-http.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { utimesSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { stat } from 'node:fs/promises'

import { apply } from '../src/host/index.js'
import { makeWorkspace } from './fixture.mjs'

/**
 * 测试自带样本工作区（临时目录），里面有 docs/screenshot.png 当媒体样本。
 *
 * v0.12 追加了几个**带引用**的文件给 `/api/links` 用。刻意包含一组
 * **同名但不同目录**的 `SKILL.md` —— 那是真实语料里最大的误报源
 * （`SKILL.md` 有 20 个、`01_公众号正文.md` 有 12 个）。
 */
const PROJECT_ROOT = makeWorkspace([
  ['docs/hub.md', '# hub\n\n见 `docs/notes.md` 与 README.md\n'],
  ['docs/leaf.md', '# leaf\n\n见 [笔记](docs/notes.md)\n'],
  ['x/SKILL.md', '# x 的 skill\n'],
  ['y/SKILL.md', '# y 的 skill\n'],
  ['amb.md', '# amb\n\n见 `SKILL.md`（同名两处，不该产生边）\n'],
])

/**
 * 起一个挂着 Knit 路由的回环 server（伪造 cordis 的 webServer / sessions / effect）。
 *
 * ⚠️ `inject` 必须**照抄 cordis 的真实语义**：只有它真的能提供所请求的依赖时才回调。
 * v0.7 给 `apply` 加了第二个 `ctx.inject(['tools'], …)`，如果这里对所有 deps 都无脑回调，
 * 那个回调会拿到一个没有 `tools` 的假 ctx —— 那是**替身的谎**，不是代码的 bug
 * （AGENTS.md §6.1 的教训）。真实的 cordis 在回调前保证依赖可用。
 *
 * @param {object} [session] - 假会话（默认只有一个 header.cwd，没有任何事件）
 * @returns {Promise<{base:string, close:Function}>} 地址根与关闭函数
 */
async function startKnitServer(session, sessionId = 's') {
  let handler = null
  const listeners = new Map()
  // ⚠️ v0.16：订阅回调按 `session.id` 认会话，所以假会话必须有 id，
  // 且必须与请求里的 `sessionId` 一致 —— 这正是真机的形状。
  const fakeSession = {
    ...(session || {}),
    id: sessionId,
    header: { cwd: PROJECT_ROOT, id: sessionId, ...((session && session.header) || {}) },
  }
  const provided = {
    webServer: {
      register({ handler: h }) { handler = h; return () => {} },
    },
    sessions: { get: () => fakeSession },
    effect(fn) { fn() },
  }
  apply({
    on(name, fn) {
      if (!listeners.has(name)) listeners.set(name, [])
      listeners.get(name).push(fn)
      return () => {}
    },
    inject(deps, cb) {
      // 只提供 webServer / sessions；tools 不存在 → 那条回调不该被调用
      if (!deps.every((dep) => dep in provided)) return
      cb(provided)
    },
  })
  assert.ok(handler, 'apply 应注册路由 handler')
  assert.equal((listeners.get('session/event') || []).length, 1, 'apply 应恰好订阅一次 session/event')
  /**
   * 模拟宿主 append 之后派发的会话事件（v0.16：Knit 唯一的读证据来源）。
   * @param {object|null} event - 会话事件
   * @returns {void}
   */
  const emit = (event) => {
    for (const fn of listeners.get('session/event') || []) fn(fakeSession, event)
  }

  const server = http.createServer((req, res) => handler(req, res))
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}/knit`
  const close = () => new Promise((resolve) => server.close(resolve))
  return { base, close, emit }
}

test('HTTP 端到端：媒体列表、/raw 整文件、Range 206、安全拒绝', async () => {
  const { base, close } = await startKnitServer()
  try {
    // kind=media：只回图片/视频，且扫到仓库自带截图
    let r = await fetch(`${base}/api/recent?sessionId=s&kind=media&sort=time`)
    let body = await r.json()
    assert.equal(r.status, 200)
    assert.equal(body.kind, 'media')
    assert.ok(body.docs.some((d) => d.name === 'screenshot.png'))
    assert.ok(body.docs.every((d) => d.kind === 'image' || d.kind === 'video'))
    assert.ok(body.docs.every((d) => !('haystack' in d)), '不泄漏内部 haystack')

    // kind=all：文档与媒体混合
    r = await fetch(`${base}/api/recent?sessionId=s&kind=all&sort=time`)
    body = await r.json()
    assert.equal(body.kind, 'all')
    assert.ok(body.docs.some((d) => d.kind === 'md'))
    assert.ok(body.docs.some((d) => d.kind === 'image'))

    // 缺省 kind 回落 doc
    r = await fetch(`${base}/api/recent?sessionId=s`)
    body = await r.json()
    assert.equal(body.kind, 'doc')
    assert.ok(body.docs.every((d) => d.kind === 'md'))

    // /raw 整文件：200、字节一致、安全头齐全
    const rel = 'docs/screenshot.png'
    const realSize = (await stat(`${PROJECT_ROOT}/${rel}`)).size
    r = await fetch(`${base}/api/raw?sessionId=s&rel=${encodeURIComponent(rel)}`)
    assert.equal(r.status, 200)
    assert.match(r.headers.get('content-type'), /image\/png/)
    assert.equal(r.headers.get('accept-ranges'), 'bytes')
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff')
    // v0.11 ③：`sandbox` 这一半原来只写在源码里、没有断言 —— 而它是 SVG 脚本失效的
    // 关键（`default-src 'none'` 管外链，`sandbox` 管内联脚本上下文）。
    // 「安全说明里声称的都指向真实检查」这条要求把它抓出来了。
    assert.match(r.headers.get('content-security-policy') || '', /default-src 'none'/)
    assert.match(r.headers.get('content-security-policy') || '', /sandbox/)
    assert.equal(Number(r.headers.get('content-length')), realSize)
    assert.equal((await r.arrayBuffer()).byteLength, realSize)

    // Range 闭区间：206 + Content-Range + 100 字节
    r = await fetch(`${base}/api/raw?sessionId=s&rel=${encodeURIComponent(rel)}`, {
      headers: { Range: 'bytes=0-99' },
    })
    assert.equal(r.status, 206)
    assert.equal(r.headers.get('content-range'), `bytes 0-99/${realSize}`)
    assert.equal(Number(r.headers.get('content-length')), 100)
    assert.equal((await r.arrayBuffer()).byteLength, 100)

    // Range 后缀 bytes=-1000
    r = await fetch(`${base}/api/raw?sessionId=s&rel=${encodeURIComponent(rel)}`, {
      headers: { Range: 'bytes=-1000' },
    })
    assert.equal(r.status, 206)
    assert.equal(r.headers.get('content-range'), `bytes ${realSize - 1000}-${realSize - 1}/${realSize}`)
    assert.equal((await r.arrayBuffer()).byteLength, 1000)

    // 路径越界：404 + outside-workspace
    r = await fetch(`${base}/api/raw?sessionId=s&rel=${encodeURIComponent('../../../../etc/passwd')}`)
    body = await r.json()
    assert.equal(r.status, 404)
    assert.equal(body.code, 'knit/outside-workspace')

    // 非白名单扩展名：404 + media-only
    r = await fetch(`${base}/api/raw?sessionId=s&rel=${encodeURIComponent('package.json')}`)
    body = await r.json()
    assert.equal(r.status, 404)
    assert.equal(body.code, 'knit/media-only')

    // 非 GET：405
    r = await fetch(`${base}/api/recent?sessionId=s`, { method: 'POST' })
    assert.equal(r.status, 405)
  } finally {
    await close()
  }
})

test('HTTP 端到端：/api/links 的引用关系、缺参与越界、不泄漏内部结构', async () => {
  const { base, close } = await startKnitServer()
  try {
    // 正常：hub 与 leaf 都引用了 docs/notes.md，所以它被引用 2 次、自己不引用别人
    let r = await fetch(`${base}/api/links?sessionId=s&rel=${encodeURIComponent('docs/notes.md')}`)
    let body = await r.json()
    assert.equal(r.status, 200)
    assert.equal(body.ok, true)
    assert.equal(body.rel, 'docs/notes.md')
    assert.equal(body.incomingTotal, 2, 'hub 与 leaf 各一条')
    assert.deepEqual(body.incoming.map((d) => d.rel).sort(), ['docs/hub.md', 'docs/leaf.md'])
    assert.equal(body.outgoingTotal, 0)
    assert.deepEqual(body.outgoing, [])
    assert.ok(body.incoming.every((d) => d.rel && d.title), '每项要有 rel 与 title')

    // 不泄漏内部结构（与 knit_docs 同一条纪律）
    for (const k of ['out', 'in', 'titles', 'signature', 'parsed', 'skipped', 'haystack']) {
      assert.ok(!(k in body), `不该泄漏 ${k}`)
    }

    // 反向：hub 自己引用了 notes 与 README
    r = await fetch(`${base}/api/links?sessionId=s&rel=${encodeURIComponent('docs/hub.md')}`)
    body = await r.json()
    assert.equal(r.status, 200)
    assert.equal(body.outgoingTotal, 2)
    assert.deepEqual(body.outgoing.map((d) => d.rel).sort(), ['README.md', 'docs/notes.md'])
    assert.deepEqual(body.incoming, [])

    // 🔴 误报回归：同名两处 SKILL.md 时，只写 basename 必须不产生边
    r = await fetch(`${base}/api/links?sessionId=s&rel=${encodeURIComponent('x/SKILL.md')}`)
    body = await r.json()
    assert.equal(r.status, 200)
    assert.equal(body.incomingTotal, 0, '歧义 basename 不许产生边')

    // 缺 rel → 400，且是既有错误码
    r = await fetch(`${base}/api/links?sessionId=s`)
    body = await r.json()
    assert.equal(r.status, 400)
    assert.deepEqual(body, { ok: false, code: 'knit/missing-rel' })

    // 未知 rel → 404。**越界路径也走这里** —— 图里只有工作区内的 rel，
    // 所以这个路由**没有**按路径读文件的口子，套不出工作区外的内容。
    for (const bad of ['nope.md', '../outside.md', '/etc/passwd.md']) {
      r = await fetch(`${base}/api/links?sessionId=s&rel=${encodeURIComponent(bad)}`)
      body = await r.json()
      assert.equal(r.status, 404, `${bad} 应 404`)
      assert.deepEqual(body, { ok: false, code: 'knit/not-found' })
    }

    // 安全响应头：JSON 路由与 /api/recent、/api/doc 一致 —— 都走 sendJson，设 `nosniff`。
    // ⚠️ **CSP（含 `sandbox`）只有媒体路由 `/api/raw` 才设** —— 那是给浏览器渲染
    // 图片/视频/SVG 用的，JSON 不吃这一套。我第一版按「所有路由都该有 CSP」写，
    // 是**断言错了**，不是代码缺了防护。
    r = await fetch(`${base}/api/links?sessionId=s&rel=${encodeURIComponent('docs/notes.md')}`)
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff')
    assert.equal(r.headers.get('cache-control'), 'no-store')
    assert.match(r.headers.get('content-type') || '', /application\/json/)

    // 非 GET → 405（前置守卫覆盖新路由）
    r = await fetch(`${base}/api/links?sessionId=s&rel=x.md`, { method: 'POST' })
    assert.equal(r.status, 405)
  } finally {
    await close()
  }
})

/* ── v0.14 上下文接口（端到端）──────────────────────────
   两条路由都要验：`/api/recent` 里**顺带**给的 `context` 字段，
   以及独立的 `/api/context`。重点是「装配层不许把内部输入发出去」。 */

test('HTTP 端到端：/api/recent 带 context，且不泄漏装配层的内部输入', async () => {
  const { base, close } = await startKnitServer()
  try {
    // 时间序：**不该**有分层（没有对话可依据）
    let r = await fetch(`${base}/api/recent?sessionId=s&sort=time`)
    let body = await r.json()
    assert.equal(body.context, null, '时间序不该给 Context Pack')

    // 相关序：这个假会话没有事件 → 仍然退回 time，于是 context 还是 null
    r = await fetch(`${base}/api/recent?sessionId=s&sort=relevance`)
    body = await r.json()
    assert.equal(body.mode, 'time')
    assert.equal(body.context, null)

    // 关键纪律：无论哪条路，`docs` 里都不许出现装配层的内部字段
    for (const doc of body.docs) {
      for (const forbidden of ['raw', 'matchedTerms', 'strength', 'haystack', 'head']) {
        assert.ok(!(forbidden in doc), `docs 里不该出现 ${forbidden}`)
      }
    }
    // 顶层也不许把全量名次（含 raw / matchedTerms）发出去
    assert.ok(!('ranked' in body), '顶层不该出现 ranked')
  } finally {
    await close()
  }
})

test('HTTP 端到端：/api/context 返回同一份 Context Model', async () => {
  const { base, close } = await startKnitServer()
  try {
    const r = await fetch(`${base}/api/context?sessionId=s`)
    const body = await r.json()
    assert.equal(r.status, 200)
    assert.equal(body.ok, true)
    // 没有对话可依据 → 空包，但结构必须齐全（客户端靠它判空态）
    assert.deepEqual(body.context.primary, [])
    assert.deepEqual(body.context.supporting, [])
    assert.deepEqual(body.context.related, [])
    // 三层空（没有对话可依据），但 `total` 仍然是工作区里真实的 Markdown 篇数 ——
    // 客户端靠它区分「工作区是空的」与「有文档但一篇都没命中」。
    assert.deepEqual(
      {
        primary: body.context.totals.primary,
        supporting: body.context.totals.supporting,
        related: body.context.totals.related,
        matched: body.context.totals.matched,
      },
      { primary: 0, supporting: 0, related: 0, matched: 0 },
    )
    assert.ok(body.context.totals.total > 0, `应当报出工作区篇数，实际 ${body.context.totals.total}`)
    assert.deepEqual(body.context.summary, {
      primary: 0,
      supporting: 0,
      related: 0,
      shown: 0,
      matched: 0,
      total: body.context.totals.total,
    })
    assert.equal(body.context.task, '')
    // 安全头与其余 JSON 路由一致
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff')
    assert.equal(r.headers.get('cache-control'), 'no-store')
  } finally {
    await close()
  }
})

/* ── v0.16 · /api/recent 的「使用情况」通道 ──────────────────
 *
 * 这几条走真实回环 HTTP，锁的是**最容易漂移的那一层**：
 * 记账默认关闭、`usage=1` 才开闸、开着之后幂等、根外的读不计数、
 * 畸形事件不许影响接口。
 *
 * ⚠️ v0.16 起读证据来自 `session/event` 订阅（不再从 `session.snapshotEvents()` 拉），
 * 所以这几条必须先 `emit()` 派发事件再请求接口 —— 那也正是真机的顺序。
 */

/**
 * 造一个假会话：`header.cwd` + 给**检索**用的 `snapshotEvents()`。
 *
 * ⚠️ `snapshotEvents()` 现在只服务检索侧（对话 → 任务上下文分级）；
 * 读证据走 `emit()` 那条 `session/event` 路线。
 * @param {object[]} events - 会话事件（检索用）
 * @returns {object} 假会话
 */
function sessionWithEvents(events) {
  return { header: { cwd: PROJECT_ROOT }, snapshotEvents: () => events }
}

/**
 * 一条用户消息事件。
 * @param {number} seq - 序号
 * @param {string} text - 文本
 * @returns {object} 事件
 */
function userMessage(seq, text) {
  return {
    type: 'user/message',
    seq,
    time: 1000 + seq,
    data: { role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } },
  }
}

/**
 * 一次 `read` 工具调用（`arguments` 是 JSON **字符串** —— 与真机逐字一致）。
 * @param {number} seq - 序号
 * @param {string} filePath - 参数里的路径
 * @param {string} [callId] - 调用 id
 * @returns {object} 事件
 */
function readCall(seq, filePath, callId = `c${seq}`) {
  return {
    type: 'tool/call',
    seq,
    time: 1000 + seq,
    data: { turn: 1, step: 1, callId, name: 'read', arguments: JSON.stringify({ file_path: filePath }) },
  }
}

/**
 * 一次工具返回。默认成功；`isError: true` 表示失败（**失败不计入使用**）。
 * @param {number} seq - 序号
 * @param {string} callId - 对应的调用 id
 * @param {boolean} [isError] - 是否失败
 * @returns {object} 事件
 */
function toolResult(seq, callId, isError = false) {
  return {
    type: 'tool/result',
    seq,
    time: 1000 + seq,
    sourceEventSeqs: [seq - 1],
    data: {
      turn: 1, step: 1,
      message: {
        role: 'tool',
        source: { kind: 'tool', callId },
        toolCallId: callId,
        content: [{ type: 'text', text: '<path>…</path>' }],
        isError,
        id: `m${seq}`,
      },
    },
  }
}

test('HTTP 端到端：默认不记账，usage=1 开闸，读事件由 session/event 进来', async () => {
  const { base, close, emit } = await startKnitServer(
    sessionWithEvents([userMessage(1, 'hub 这份文档')]), 's1',
  )
  try {
    // ① 默认：一个字节都不记 —— 没有 usage 键，也没有任何记账状态
    let body = await (await fetch(`${base}/api/recent?sessionId=s1&sort=relevance`)).json()
    assert.ok(!('usage' in body), '默认不该回传 usage（更不该偷偷记账）')

    // ② 打开：这一刻开始记。此刻还一次读事件都没发生 → 计数是 0。
    //    这个假会话没有 `snapshotEvents()`（= 没有可回填的历史），所以仍然是 0；
    //    有历史的会话会在开闸这一刻回填一次 —— 见下面「面板开晚」那条用例。
    body = await (await fetch(`${base}/api/recent?sessionId=s1&sort=relevance&usage=1`)).json()
    assert.ok(body.usage, 'usage=1 应当回传使用情况')
    assert.equal(body.usage.stats.reads, 0, '没有历史可回填时照旧从 0 开始')
    // ⚠️ `at` 是**上一份包**交出去的时间；第一次记账时还没有上一份，所以是 0。
    // 这不是缺陷，是顺序：usage 先算、快照后记（从下一次请求起才有「上一份」）。
    assert.equal(body.usage.at, 0)
    // 面板只需要计数，不需要本机绝对路径
    assert.ok(!JSON.stringify(body.usage).includes(PROJECT_ROOT), 'usage 里不许出现绝对路径')

    // ③ 派发一次真实的读（先 call 后 result —— 与真机顺序一致）
    emit(readCall(2, 'docs/hub.md'))
    emit(toolResult(3, 'c2'))

    // ④ 开着之后，后续请求不带 usage=1 也照样回传（状态在会话上，不在参数上）
    body = await (await fetch(`${base}/api/recent?sessionId=s1&sort=relevance`)).json()
    assert.ok(body.usage, '一旦打开，后续请求仍应回传（面板靠它持续刷新）')
    assert.equal(body.usage.stats.reads, 1, '一次成功的 read 应被记成一次使用')
    assert.equal(body.usage.stats.distinct, 1)
    assert.equal(body.usage.stats.firstReadRel, 'docs/hub.md')
    assert.ok(body.usage.at > 0, '交过包之后就有了「上一份」的时间')
    // 端到端把「读」与「分层」接上的那一条：这次读落在上一份包的主看篇里
    assert.equal(body.usage.stats.primaryFollowThrough, true)
    assert.equal(body.usage.stats.firstReadTier, 'primary')
    assert.equal(body.usage.stats.outside, 0)
    // Epoch：第一次交包就是 Epoch 1，且这条读的归因钉在 Epoch 1
    assert.equal(body.usage.epochId, 1)
    assert.equal(body.usage.stats.firstReadEpoch, 1)
    assert.equal(body.usage.stats.churn.epochs, 1)
    assert.equal(body.usage.stats.churn.changes, 0, '一个 Epoch 里反复交同一份包不算「上下文变了」')
  } finally {
    await close()
  }
})

test('HTTP 端到端：记账幂等 —— 同一个事件派发十次，同一次读只算一次', async () => {
  const { base, close, emit } = await startKnitServer(
    sessionWithEvents([userMessage(1, 'hub 这份文档')]), 's2',
  )
  try {
    await fetch(`${base}/api/recent?sessionId=s2&sort=relevance&usage=1`)
    emit(readCall(2, 'docs/hub.md'))
    emit(toolResult(3, 'c2'))
    let last = null
    for (let i = 0; i < 10; i += 1) {
      // 同一批事件再派发一遍：`seq` 游标必须保证幂等
      emit(readCall(2, 'docs/hub.md'))
      emit(toolResult(3, 'c2'))
      last = await (await fetch(`${base}/api/recent?sessionId=s2&sort=relevance`)).json()
    }
    assert.equal(last.usage.stats.reads, 1, '同一个 seq 的事件重复派发不许重复计数')
    assert.equal(last.usage.stats.distinct, 1)
  } finally {
    await close()
  }
})

test('HTTP 端到端：根外的读与失败的工具返回都不计入使用', async () => {
  const { base, close, emit } = await startKnitServer(
    sessionWithEvents([userMessage(1, 'hub 这份文档')]), 's3',
  )
  try {
    await fetch(`${base}/api/recent?sessionId=s3&sort=relevance&usage=1`)
    // 根外（绝对路径）—— 隐私上直接丢掉，连计数都不留
    emit(readCall(2, '/etc/passwd'))
    emit(toolResult(3, 'c2'))
    // 根内但读失败了 —— 「尝试读」不是「读到」
    emit(readCall(4, 'docs/leaf.md'))
    emit(toolResult(5, 'c4', true))
    // 非 read 的工具不算
    emit({ type: 'tool/call', seq: 6, time: 1006, data: { turn: 1, step: 1, callId: 'c6', name: 'grep', arguments: JSON.stringify({ pattern: 'hub' }) } })
    emit(toolResult(7, 'c6'))

    const body = await (await fetch(`${base}/api/recent?sessionId=s3&sort=relevance`)).json()
    assert.equal(body.usage.stats.reads, 0, `根外 / 失败 / 非 read 都不算，实际 ${body.usage.stats.reads}`)
    assert.deepEqual(body.usage.stats.outsideReads, [])
  } finally {
    await close()
  }
})

test('HTTP 端到端：畸形事件与未记账会话的事件都不许影响接口（降级）', async () => {
  const { base, close, emit } = await startKnitServer(
    sessionWithEvents([userMessage(1, 'hub 这份文档')]), 's4',
  )
  try {
    // 未记账：派发什么都不该被记（订阅回调首行就早退）
    emit(readCall(2, 'docs/hub.md'))
    emit(toolResult(3, 'c2'))
    // 打开记账
    await fetch(`${base}/api/recent?sessionId=s4&sort=relevance&usage=1`)
    // 畸形事件：null / data 是 null / message 是 null / type 不是字符串 / 参数不是合法 JSON
    emit(null)
    emit({ type: 'tool/result', seq: 5, data: null })
    emit({ type: 'tool/result', seq: 6, data: { message: null } })
    emit({ type: 'tool/call', seq: 7, data: null })
    emit({ type: 42, seq: 8, data: {} })
    emit({ type: 'tool/call', seq: 9, data: { turn: 1, step: 1, callId: 'c9', name: 'read', arguments: '{坏掉的 JSON' } })

    const r = await fetch(`${base}/api/recent?sessionId=s4&sort=relevance`)
    const body = await r.json()
    assert.equal(r.status, 200, '畸形事件不许把列表接口搞成 500')
    assert.ok(Array.isArray(body.docs))
    assert.equal(body.usage.stats.reads, 0, '畸形事件一条都不许被记成使用')
  } finally {
    await close()
  }
})

test('HTTP 端到端：/api/context 也推进快照，但只在已记账的会话里', async () => {
  const { base, close } = await startKnitServer(sessionWithEvents([userMessage(1, 'hub 这份文档')]), 's5')
  try {
    // 没打开 → 不记
    let body = await (await fetch(`${base}/api/context?sessionId=s5`)).json()
    assert.ok(body.ok)
    assert.ok(!('usage' in body), '/api/context 本来就不回传 usage')

    // 打开 → 这个路由交出的包同样进账（否则「上下文变了」会漏记）
    await fetch(`${base}/api/recent?sessionId=s5&sort=relevance&usage=1`)
    await fetch(`${base}/api/context?sessionId=s5`)
    body = await (await fetch(`${base}/api/recent?sessionId=s5&sort=relevance`)).json()
    assert.ok(body.usage, '已记账的会话应当继续回传使用情况')
    assert.ok(body.usage.at > 0, '快照应当已经记下（at 有值）')
    // 同签名不记新快照：同一份包被两个路由反复交出**不算**「上下文变了」。
    // 否则面板 5 秒轮询一次，churn 立刻变成纯噪音。
    assert.equal(body.usage.stats.churn.snapshots, 0, '一模一样的一份包不许记成「变化」')
    assert.equal(body.usage.stats.churn.epochs, 1, '没换过上下文就只有一个 Epoch')
    assert.equal(body.usage.delta, null, '没有变化就没有 Delta')
  } finally {
    await close()
  }
})

/* ── v0.17 文档生命周期（端到端）────────────────────────────────────
   v0.16 的 15 个 stats 键一个都不许动；生命周期是**新的事实投影**：
   宿主每次请求重新 scan → 拿到真实 `mtimeMs` → 与「最后一次成功 read 时
   记下的 mtimeMs」比对。所以这两条用例必须真的改磁盘上的文件时间
   （`utimesSync`），否则测的只是替身。 */

/** v0.16 就有的 15 个 stats 键 —— v0.17 只在**顶层**加新字段，不许挤进 stats。 */
const STATS_KEYS = [
  'byTier', 'churn', 'continuedReadsAfterExit', 'distinct', 'firstReadAt',
  'firstReadEpoch', 'firstReadRel', 'firstReadTier', 'outside', 'outsideReads',
  'primaryFollowThrough', 'primaryRel', 'reEntries', 'reads', 'supportingCoverage',
]

test('HTTP 端到端：usage 顶层多出生命周期 / 最近读取 / 包外明细，stats 形状不变', async () => {
  const { base, close, emit } = await startKnitServer(
    sessionWithEvents([userMessage(1, 'hub 这份文档')]), 's6',
  )
  try {
    // ① 交第一份包（开闸）
    await fetch(`${base}/api/recent?sessionId=s6&sort=relevance&usage=1`)
    // ② 读一篇包内文档，再读一篇**不在文档包里的**文件（图片：扫描器只收 md）
    emit(readCall(2, 'docs/hub.md'))
    emit(toolResult(3, 'c2'))
    emit(readCall(4, 'docs/screenshot.png'))
    emit(toolResult(5, 'c4'))

    const body = await (await fetch(`${base}/api/recent?sessionId=s6&sort=relevance`)).json()
    assert.deepEqual(Object.keys(body.usage.stats).sort(), STATS_KEYS, 'stats 形状是 v0.16 的，一个键都不许加')

    // 每篇文档的状态只留三个字段：状态、次数、最后一次读的时间（线上载荷要瘦）
    assert.deepEqual(body.usage.lifecycle['docs/hub.md'], {
      status: 'read', count: 1, lastReadAt: 1003,
    })
    assert.equal(body.usage.lifecycle['docs/screenshot.png'].status, 'read')

    // 最近读取 = 最近一次成功 read 的文件（按 seq，不是按墙钟猜）
    assert.deepEqual(body.usage.recentRead, {
      rel: 'docs/screenshot.png', at: 1005, seq: 5, epochId: 1, tier: null, rank: null, inside: false,
    })
    // 包外明细：不在当前包里、但真的成功读过
    assert.deepEqual(body.usage.outsideDocs, [
      { rel: 'docs/screenshot.png', count: 1, lastReadAt: 1005, seq: 5 },
    ])
    // 同一份包连交两次不算「上下文变化」→ 没有最近一次 Delta
    assert.equal(body.usage.latestDelta, null)
    // 新字段同样只有相对路径
    assert.ok(!JSON.stringify(body.usage).includes(PROJECT_ROOT), 'usage 里不许出现绝对路径')
  } finally {
    await close()
  }
})

test('HTTP 端到端：真实改动文件 → 读后已更新；再读一次 → 修改后已重新读取', async () => {
  const { base, close, emit } = await startKnitServer(
    sessionWithEvents([userMessage(1, 'hub 这份文档')]), 's7',
  )
  try {
    await fetch(`${base}/api/recent?sessionId=s7&sort=relevance&usage=1`)
    emit(readCall(2, 'docs/hub.md'))
    emit(toolResult(3, 'c2'))

    let body = await (await fetch(`${base}/api/recent?sessionId=s7&sort=relevance`)).json()
    assert.equal(body.usage.lifecycle['docs/hub.md'].status, 'read', '刚读完就是「已读」')

    // 真的把文件时间往后推 —— 宿主这一轮 scan 会拿到新的 mtimeMs
    const abs = join(PROJECT_ROOT, 'docs/hub.md')
    const later = Date.now() / 1000 + 30
    utimesSync(abs, later, later)

    body = await (await fetch(`${base}/api/recent?sessionId=s7&sort=relevance`)).json()
    assert.equal(
      body.usage.lifecycle['docs/hub.md'].status, 'updated_after_read',
      '上次成功 read 之后文件变过 —— 这只是「变过」，不是「Agent 用的是旧版」',
    )
    assert.equal(body.usage.lifecycle['docs/hub.md'].count, 1, '变化本身不是一次读')

    // 变化之后又成功读了一次 → 事实升级为「修改后已重新读取」
    emit(readCall(4, 'docs/hub.md'))
    emit(toolResult(5, 'c4'))
    body = await (await fetch(`${base}/api/recent?sessionId=s7&sort=relevance`)).json()
    assert.equal(body.usage.lifecycle['docs/hub.md'].status, 'reread_after_update')
    assert.equal(body.usage.lifecycle['docs/hub.md'].count, 2)
    assert.equal(body.usage.stats.reads, 2, '两次成功 read 都算数')
  } finally {
    await close()
  }
})

test('v0.17 修订：面板开晚了也能补记 —— 开闸那一刻回填会话已有的事件', async () => {
  // 真机形状：用户在面板打开**之前**就已经让 agent 读过一篇包内文档。
  const { base, close } = await startKnitServer(
    sessionWithEvents([
      userMessage(1, 'hub 这份文档'),
      readCall(2, 'docs/hub.md'),
      toolResult(3, 'c2'),
    ]),
    's8',
  )
  try {
    // ① 面板从没打开过：闸门关着，一个字节都不记（usage 根本不出现）
    let body = await (await fetch(`${base}/api/recent?sessionId=s8&sort=relevance`)).json()
    assert.ok(!('usage' in body), '默认关：连 usage 键都不该有')

    // ② 用户读完了才打开开关：这一个请求把历史补进来
    body = await (await fetch(`${base}/api/recent?sessionId=s8&sort=relevance&usage=1`)).json()
    assert.equal(body.usage.stats.reads, 1, '开闸时回填会话已有的事件')
    assert.equal(body.usage.lifecycle['docs/hub.md'].status, 'read')
    assert.equal(body.usage.lifecycle['docs/hub.md'].count, 1)
    // ⚠️ 补记的读按「我们已知最早的那份包」归因 —— 说它当时在包外，是我们不知道的事
    assert.equal(body.usage.stats.firstReadTier, 'primary')
    assert.equal(body.usage.stats.firstReadEpoch, 1)
    assert.equal(body.usage.stats.outside, 0, '不许把包内文档说成包外')
    assert.deepEqual(body.usage.outsideDocs, [])
    assert.equal(body.usage.recentRead.rel, 'docs/hub.md')
    assert.equal(body.usage.recentRead.inside, true)

    // ③ 同一个会话不再回填第二次：再来一次请求，计数不动
    body = await (await fetch(`${base}/api/recent?sessionId=s8&sort=relevance&usage=1`)).json()
    assert.equal(body.usage.stats.reads, 1, '一个会话只回填一次')
  } finally {
    await close()
  }
})

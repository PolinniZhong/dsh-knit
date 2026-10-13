/**
 * 测试用：在**真实回环端口**上跑 `apply()` 注册的 Knit 路由。
 *
 * 抽出来的理由：v0.25 的 `/api/changes` 是**独立接口**，它必须在真实端口上验
 * （路由存在、query 解析、响应形状），而 `host-http.test.mjs` 已经有一份可信的假 ctx。
 * 与其复制一份（两份假件一定会漂移），不如共用。
 */
import assert from 'node:assert/strict'
import http from 'node:http'

import { apply } from '../src/host/index.js'

/**
 * 起一个挂着 Knit 路由的**真实回环 server**（伪造 cordis 的 webServer / sessions / effect）。
 *
 * v0.25：从 `host-http.test.mjs` 抽到这里 —— 「/api/changes 是独立接口」这件事必须
 * 在**真实端口**上验（路由、query 参数、序列化形状），而两个测试文件共用同一份替身，
 * 免得两份假 ctx 各自漂移。（`test/` 里的**替身**不挂 `scripts.test`，只有测试文件才挂。）
 *
 * ⚠️ `inject` 必须**照抄 cordis 的真实语义**：只有它真的能提供所请求的依赖时才回调。
 * v0.7 给 `apply` 加了第二个 `ctx.inject(['tools'], …)`，如果这里对所有 deps 都无脑回调，
 * 那个回调会拿到一个没有 `tools` 的假 ctx —— 那是**替身的谎**，不是代码的 bug
 * （AGENTS.md §6.1 的教训）。真实的 cordis 在回调前保证依赖可用。
 *
 * @param {{root: string, session?: object, sessionId?: string}} options
 *   `root` = **工作区根**（决定这个假会话看到哪个目录；每个用例自己造）
 * @returns {Promise<{base:string, close:Function, emit:Function}>} 地址根、关闭函数、事件投递
 */
export async function startKnitServer(options = {}) {
  const { root } = options
  const session = options.session
  const sessionId = options.sessionId || 's'
  if (!root) throw new Error('startKnitServer 需要 root')
  let handler = null
  const listeners = new Map()
  // ⚠️ v0.16：订阅回调按 `session.id` 认会话，所以假会话必须有 id，
  // 且必须与请求里的 `sessionId` 一致 —— 这正是真机的形状。
  const fakeSession = {
    ...(session || {}),
    id: sessionId,
    header: { cwd: root, id: sessionId, ...((session && session.header) || {}) },
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


/**
 * 「打开本地文件夹」测试：点头部那行工作区路径 → 用系统文件管理器打开它。
 *
 * 走官方 Remote：`ctx.remote.session.openWorkspacePath({ path })`，
 * 返回值是一个信封（`{ ok, value } | { ok: false, error }`）。
 *
 * 跑法：node --test test/
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { loadClientModule, createHarness, byClass, byExactClass, textOf, makeLocale } from './harness.mjs'

const harness = createHarness()
const React = globalThis.__knitReact
const h = React.createElement

/* ── 脚手架 ─────────────────────────────────────────── */

/**
 * 装载模块并 apply 到一个带 remote.session 的假上下文。
 *
 * @param {object} [options] - `openWorkspacePath` 的实现，省略表示没有该服务
 * @returns {{exports: object, calls: object[], log: object}} 结果与调用记录
 */
function boot(options = {}) {
  const loaded = loadClientModule()
  const log = { effects: [] }
  const { locale } = makeLocale({ active: 'zh' })

  const services = { slots: { inject(n, cb) { cb(); return () => {} }, register() { return () => {} } } }
  if (options.openWorkspacePath) {
    services['remote.session'] = { openWorkspacePath: options.openWorkspacePath }
  }

  const ctx = {
    slots: services.slots,
    locale,
    effect(fn, label) { log.effects.push(label); return fn() },
    get: (name) => services[name],
    inject(deps, cb) {
      for (const d of deps) if (!services[d]) return
      cb({ ...services, effect: (fn) => fn() })
    },
  }

  loaded.exports.apply(ctx)
  return { exports: loaded.exports, log }
}

/**
 * 造一份列表载荷。
 * @param {object} [overrides] - 覆盖字段
 * @returns {object} 载荷
 */
function listPayload(overrides = {}) {
  return {
    ok: true,
    root: '/Users/me/proj',
    total: 1,
    mode: 'time',
    topic: '',
    docs: [{ path: '/Users/me/proj/a.md', rel: 'a.md', name: 'a.md', title: 'A', summary: 's', mtimeMs: Date.now(), score: null }],
    ...overrides,
  }
}

/**
 * 渲染到列表加载完成，返回扁平节点。
 * @returns {Promise<object[]>} 节点
 */
async function render() {
  globalThis.fetch = async () => ({ json: async () => listPayload() })
  const { KnitBody } = boot({ openWorkspacePath: async () => ({ ok: true, value: { opened: true } }) }).exports.__test
  harness.reset()
  let nodes = harness.render(h(KnitBody, { sessionId: 's1' }))
  await harness.flush()
  nodes = harness.render(h(KnitBody, { sessionId: 's1' }))
  return nodes
}

/* ── 渲染 ───────────────────────────────────────────── */

test('路径：渲染成一个可点的 button，带手型与提示', async () => {
  const nodes = await render()
  const path = byClass(nodes, 'knit-root-path')[0]

  assert.ok(path, '应有工作区路径')
  assert.equal(path.type, 'button', '必须是 button（才能点击 + 无障碍）')
  assert.equal(path.props.type, 'button')
  assert.equal(path.props.disabled, false)
  assert.equal(path.props.title, '在文件管理器中打开')
  assert.match(textOf(path), /08_Knit|proj/, '显示的就是工作区路径')
})

test('路径：没有工作目录时按钮禁用，且没有提示文案', async () => {
  globalThis.fetch = async () => ({ json: async () => listPayload({ root: '', docs: [] }) })
  const { KnitBody } = boot({ openWorkspacePath: async () => ({ ok: true, value: { opened: true } }) }).exports.__test
  harness.reset()
  let nodes = harness.render(h(KnitBody, { sessionId: 's1' }))
  await harness.flush()
  nodes = harness.render(h(KnitBody, { sessionId: 's1' }))

  const path = byClass(nodes, 'knit-root-path')[0]
  assert.equal(path.props.disabled, true)
  assert.equal(path.props.title, '')
  assert.doesNotThrow(() => path.props.onClick())
})

/* ── 行为 ───────────────────────────────────────────── */

test('路径：点击调 openWorkspacePath，参数是当前工作区绝对路径', async () => {
  const calls = []
  globalThis.fetch = async () => ({ json: async () => listPayload() })
  const { KnitBody } = boot({
    openWorkspacePath: async (request) => { calls.push(request); return { ok: true, value: { opened: true } } },
  }).exports.__test

  harness.reset()
  let nodes = harness.render(h(KnitBody, { sessionId: 's1' }))
  await harness.flush()
  nodes = harness.render(h(KnitBody, { sessionId: 's1' }))

  byClass(nodes, 'knit-root-path')[0].props.onClick()
  await harness.flush()

  assert.equal(calls.length, 1, '应调用一次')
  assert.deepEqual(calls[0], { path: '/Users/me/proj' }, '参数是绝对路径')
})

test('路径：信封 ok:false 时把原因显示出来，不静默失败', async () => {
  globalThis.fetch = async () => ({ json: async () => listPayload() })
  const { KnitBody } = boot({
    openWorkspacePath: async () => ({ ok: false, error: { code: 'boom', message: 'no opener' } }),
  }).exports.__test

  harness.reset()
  let nodes = harness.render(h(KnitBody, { sessionId: 's1' }))
  await harness.flush()
  nodes = harness.render(h(KnitBody, { sessionId: 's1' }))

  byClass(nodes, 'knit-root-path')[0].props.onClick()
  await harness.flush()
  nodes = harness.render(h(KnitBody, { sessionId: 's1' }))

  const notice = byClass(nodes, 'knit-notice').map(textOf).join('')
  assert.match(notice, /打开失败/, '应给出可见提示')
  assert.match(notice, /no opener/, '应带上具体原因')
})

test('路径：remote 抛异常时不崩，转成提示', async () => {
  globalThis.fetch = async () => ({ json: async () => listPayload() })
  const { KnitBody } = boot({
    openWorkspacePath: async () => { throw new Error('transport down') },
  }).exports.__test

  harness.reset()
  let nodes = harness.render(h(KnitBody, { sessionId: 's1' }))
  await harness.flush()
  nodes = harness.render(h(KnitBody, { sessionId: 's1' }))

  await assert.doesNotReject(async () => {
    byClass(nodes, 'knit-root-path')[0].props.onClick()
    await harness.flush()
  })
  nodes = harness.render(h(KnitBody, { sessionId: 's1' }))
  assert.match(byClass(nodes, 'knit-notice').map(textOf).join(''), /transport down/)
})

test('路径：没有 remote.session 服务时给出提示而不是白点一下', async () => {
  globalThis.fetch = async () => ({ json: async () => listPayload() })
  const { KnitBody } = boot({}).exports.__test   // 不提供 remote.session

  harness.reset()
  let nodes = harness.render(h(KnitBody, { sessionId: 's1' }))
  await harness.flush()
  nodes = harness.render(h(KnitBody, { sessionId: 's1' }))

  byClass(nodes, 'knit-root-path')[0].props.onClick()
  await harness.flush()
  nodes = harness.render(h(KnitBody, { sessionId: 's1' }))

  assert.ok(byClass(nodes, 'knit-notice').length >= 1, '应给出可见提示')
})

test('路径：成功时不残留上一次的错误提示', async () => {
  globalThis.fetch = async () => ({ json: async () => listPayload() })
  let fail = true
  const { KnitBody } = boot({
    openWorkspacePath: async () => (fail ? { ok: false, error: { message: 'nope' } } : { ok: true, value: { opened: true } }),
  }).exports.__test

  harness.reset()
  let nodes = harness.render(h(KnitBody, { sessionId: 's1' }))
  await harness.flush()
  nodes = harness.render(h(KnitBody, { sessionId: 's1' }))

  byClass(nodes, 'knit-root-path')[0].props.onClick()
  await harness.flush()
  nodes = harness.render(h(KnitBody, { sessionId: 's1' }))
  assert.equal(byClass(nodes, 'knit-notice').length, 1, '先失败，有提示')

  fail = false
  byClass(nodes, 'knit-root-path')[0].props.onClick()
  await harness.flush()
  nodes = harness.render(h(KnitBody, { sessionId: 's1' }))
  assert.equal(byClass(nodes, 'knit-notice').length, 0, '再成功，提示应清掉')
})

/* ── 预览头那行路径：点它打开的是这篇文档本身 ────────── */

test('路径：点预览头的路径，打开的是这篇文档的绝对路径', async () => {
  const calls = []
  globalThis.fetch = async (url) => ({
    json: async () => (String(url).includes('/api/doc')
      ? { ok: true, rel: 'a.md', title: 'A', text: '正文', truncated: false }
      : listPayload()),
  })
  const { KnitBody } = boot({
    openWorkspacePath: async (request) => { calls.push(request); return { ok: true, value: { opened: true } } },
  }).exports.__test

  harness.reset()
  let nodes = harness.render(h(KnitBody, { sessionId: 's1' }))
  await harness.flush()
  nodes = harness.render(h(KnitBody, { sessionId: 's1' }))
  byClass(nodes, 'knit-doc')[0].props.onClick()
  nodes = harness.render(h(KnitBody, { sessionId: 's1' }))

  byExactClass(nodes, 'knit-preview-path')[0].props.onClick()
  await harness.flush()

  assert.equal(calls.length, 1, '应调用一次')
  assert.deepEqual(calls[0], { path: '/Users/me/proj/a.md' }, '用宿主给的绝对 path')
})

test('路径：宿主没给 path 时用 root + rel 兜底', async () => {
  const calls = []
  const payload = listPayload({
    docs: [{ rel: 'sub/b.md', name: 'b.md', title: 'B', summary: 's', mtimeMs: Date.now(), score: null }],
  })
  globalThis.fetch = async (url) => ({
    json: async () => (String(url).includes('/api/doc')
      ? { ok: true, rel: 'sub/b.md', title: 'B', text: '正文', truncated: false }
      : payload),
  })
  const { KnitBody } = boot({
    openWorkspacePath: async (request) => { calls.push(request); return { ok: true, value: { opened: true } } },
  }).exports.__test

  harness.reset()
  let nodes = harness.render(h(KnitBody, { sessionId: 's1' }))
  await harness.flush()
  nodes = harness.render(h(KnitBody, { sessionId: 's1' }))
  byClass(nodes, 'knit-doc')[0].props.onClick()
  nodes = harness.render(h(KnitBody, { sessionId: 's1' }))

  byExactClass(nodes, 'knit-preview-path')[0].props.onClick()
  await harness.flush()

  assert.deepEqual(calls[0], { path: '/Users/me/proj/sub/b.md' }, 'root + rel 拼出来')
})

test('路径：拼不出绝对路径时按钮 disabled，点了也不发请求', async () => {
  const calls = []
  globalThis.fetch = async (url) => ({
    json: async () => (String(url).includes('/api/doc')
      ? { ok: true, rel: 'sub/b.md', title: 'B', text: '正文', truncated: false }
      : listPayload({
        root: '',
        docs: [{ rel: 'sub/b.md', name: 'b.md', title: 'B', summary: 's', mtimeMs: Date.now(), score: null }],
      })),
  })
  const { KnitBody } = boot({
    openWorkspacePath: async (request) => { calls.push(request); return { ok: true, value: { opened: true } } },
  }).exports.__test

  harness.reset()
  let nodes = harness.render(h(KnitBody, { sessionId: 's1' }))
  await harness.flush()
  nodes = harness.render(h(KnitBody, { sessionId: 's1' }))
  byClass(nodes, 'knit-doc')[0].props.onClick()
  nodes = harness.render(h(KnitBody, { sessionId: 's1' }))

  const pathBtn = byExactClass(nodes, 'knit-preview-path')[0]
  assert.equal(pathBtn.props.disabled, true, 'root 与 path 都拿不到 → 不给点')
  pathBtn.props.onClick()                     // 回调里也有守卫，不该抛也不该发请求
  await harness.flush()
  assert.equal(calls.length, 0)
})

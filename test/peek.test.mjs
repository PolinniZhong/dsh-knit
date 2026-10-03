/**
 * 「悬停偷看」测试：鼠标停入口按钮 → 弹一个只读浮层；点击才进右边栏。
 *
 * 浮层是我们自己画的，不走框架的 `sidebarRight.float` —— 因为
 * `openTab` 一定会展开右侧栏，`float` 又要求 tab 已经停靠，
 * 那条路会让一次悬停引发布局抖动。
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
 * 造一份列表载荷。
 * @param {number} [count] - 几篇文档
 * @returns {object} 载荷
 */
function listPayload(count = 3) {
  return {
    ok: true,
    root: '/p',
    total: count,
    mode: 'time',
    topic: '',
    docs: Array.from({ length: count }, (_, i) => ({
      path: `/p/d${i}.md`,
      rel: `d${i}.md`,
      name: `d${i}.md`,
      title: `文档 ${i}`,
      summary: 's',
      mtimeMs: Date.now() - i * 60000,
      score: null,
    })),
  }
}

/**
 * 装载模块并 apply 到一个带 sessions 的假上下文。
 *
 * ⚠️ 这里的 `sessions.list` 假件**必须照着现行契约写**：
 * `SessionListState { ids, byId, phase, projectionsBySession }`——
 * **没有 `current`**。2026-09-30 之前它假的是 `{ current: 's-1' }`，
 * 一个现行内核里根本不存在的字段，于是 450 条测试全绿、真机上悬停浮层
 * 却永远显示「0 篇」。要测旧内核的兜底路径就传 `legacyCurrent`。
 *
 * 当前会话 id 走**座位 props**（session 作用域的标准 props `sessionId`），
 * 所以渲染入口按钮时要传 `{ sessionId: 's-1' }`。
 *
 * @param {{docs?: number, legacyCurrent?: string}} [options] - 列表条数、旧内核的 current
 * @returns {{exports: object, log: object, fetches: string[]}} 结果
 */
function boot(options = {}) {
  const loaded = loadClientModule()
  const log = { effects: [] }
  const fetches = []
  const { locale } = makeLocale({ active: 'zh' })
  const count = options.docs === undefined ? 3 : options.docs
  const legacy = options.legacyCurrent

  globalThis.fetch = async (url) => {
    fetches.push(url)
    return { json: async () => listPayload(count) }
  }

  const services = {
    slots: { inject(n, cb) { cb(); return () => {} }, register() { return () => {} } },
    sessions: {
      list: {
        getSnapshot: () => ({
          ids: [],
          byId: {},
          phase: 'ready',
          projectionsBySession: {},
          ...(legacy === undefined ? {} : { current: legacy }),
        }),
      },
    },
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
  return { exports: loaded.exports, log, fetches }
}

/** 取按钮（整段匹配，避免命中 .knit-peek-anchor 这种前缀）。 */
const buttonOf = (nodes) => byExactClass(nodes, 'knit-entry')[0]
/** 取悬停锚点。 */
const anchorOf = (nodes) => byClass(nodes, 'knit-peek-anchor')[0]
/** 取浮层。 */
const peekOf = (nodes) => byExactClass(nodes, 'knit-peek')[0]

/* ── 悬停显示 ───────────────────────────────────────── */

test('悬停：进入后延迟才显示，不是一碰就弹', async () => {
  const { exports } = boot()
  const Button = exports.__test.makeEntryButton(() => true)

  harness.reset()
  let nodes = harness.render(h(Button, { sessionId: 's-1' }))
  assert.equal(peekOf(nodes), undefined, '初始没有浮层')

  anchorOf(nodes).props.onMouseEnter()
  nodes = harness.render(h(Button, { sessionId: 's-1' }))
  assert.equal(peekOf(nodes), undefined, '刚进入还不该有（要等延时）')
  assert.ok(harness.pendingTimers() >= 1, '应排了一个延时')

  harness.tick()
  nodes = harness.render(h(Button, { sessionId: 's-1' }))
  assert.ok(peekOf(nodes), '延时到点后才出现')
})

test('悬停：延时到点后浮层出现，并去拉列表', async () => {
  const { exports, fetches } = boot()
  const Button = exports.__test.makeEntryButton(() => true)

  harness.reset()
  let nodes = harness.render(h(Button, { sessionId: 's-1' }))
  anchorOf(nodes).props.onMouseEnter()
  harness.tick()                       // 跑掉「延迟显示」
  await harness.flush()                // 等拉列表
  nodes = harness.render(h(Button, { sessionId: 's-1' }))

  const peek = peekOf(nodes)
  assert.ok(peek, '延时到点后应出现浮层')
  assert.equal(fetches.length, 1, '应去拉一次列表')
  assert.match(fetches[0], /\/knit\/api\/recent/, '拉的是列表接口')
  assert.match(fetches[0], /sessionId=s-1/, '带上当前会话')
})

test('悬停：浮层列出文档标题与相对时间', async () => {
  const { exports } = boot({ docs: 3 })
  const Button = exports.__test.makeEntryButton(() => true)

  harness.reset()
  let nodes = harness.render(h(Button, { sessionId: 's-1' }))
  anchorOf(nodes).props.onMouseEnter()
  harness.tick()
  await harness.flush()
  nodes = harness.render(h(Button, { sessionId: 's-1' }))

  const docs = byClass(nodes, 'knit-peek-doc')
  assert.equal(docs.length, 3, '三篇都列出来')
  assert.match(textOf(docs[0]), /文档 0/)
  assert.equal(byClass(nodes, 'knit-peek-time').length, 3, '每篇带相对时间')
  // 2026-10-01 用户要求：列表下面那条横线与「点击打开面板」页脚都删掉 ——
  // 有文档的浮层里**一个 hint 都不该有**（hint 只留给 loading / 空态）
  assert.equal(byClass(nodes, 'knit-peek-hint').length, 0, '有文档时浮层没有多余提示行')
})

test('悬停：没有当前会话时给出空态而不是一直转圈', async () => {
  const { exports } = boot()
  const Button = exports.__test.makeEntryButton(() => true)

  harness.reset()
  let nodes = harness.render(h(Button, { sessionId: '' }))
  anchorOf(nodes).props.onMouseEnter()
  harness.tick()
  await harness.flush()
  nodes = harness.render(h(Button, { sessionId: '' }))

  assert.ok(peekOf(nodes), '浮层仍在')
  assert.match(textOf(byClass(nodes, 'knit-peek-hint')[0]), /还没有/)
})

/* ── 当前会话 id 的来源（2026-09-30 真机故障的回归闸门）──── */

test('会话 id：取座位 props（session 标准 props），不依赖列表快照的 current', async () => {
  // 真机故障：现行内核的 sessions.list 快照没有 current，
  // 老写法读 snapshot.current ⇒ 恒空 ⇒ 浮层永远「0 篇」。
  const { exports, fetches } = boot()          // 假件按现行契约写：没有 current
  const Button = exports.__test.makeEntryButton(() => true)

  harness.reset()
  let nodes = harness.render(h(Button, { sessionId: 's-9' }))
  anchorOf(nodes).props.onMouseEnter()
  harness.tick()
  await harness.flush()
  nodes = harness.render(h(Button, { sessionId: 's-9' }))

  assert.equal(fetches.length, 1, '应照常去拉列表')
  assert.match(fetches[0], /sessionId=s-9/, '用座位给的会话 id')
  assert.equal(byClass(nodes, 'knit-peek-doc').length, 3, '浮层里真的列出文档')
})

test('会话 id：旧内核没有座位 props 时，退回列表快照的 current', async () => {
  const { exports, fetches } = boot({ legacyCurrent: 's-7' })
  const Button = exports.__test.makeEntryButton(() => true)

  harness.reset()
  let nodes = harness.render(h(Button, {}))     // 旧内核：座位不给 sessionId
  anchorOf(nodes).props.onMouseEnter()
  harness.tick()
  await harness.flush()

  assert.equal(fetches.length, 1, '兜底路径也应拉列表')
  assert.match(fetches[0], /sessionId=s-7/, '退回快照里的 current')
})

/* ── 离开收起 ───────────────────────────────────────── */

test('离开：延迟收起，鼠标移进浮层可取消', async () => {
  const { exports } = boot()
  const Button = exports.__test.makeEntryButton(() => true)

  harness.reset()
  let nodes = harness.render(h(Button, { sessionId: 's-1' }))
  anchorOf(nodes).props.onMouseEnter()
  harness.tick()
  await harness.flush()
  nodes = harness.render(h(Button, { sessionId: 's-1' }))
  assert.ok(peekOf(nodes), '先显示出来')

  // 离开按钮 → 排一个收起延时
  anchorOf(nodes).props.onMouseLeave()
  // 还没到点，鼠标移进浮层 → 取消收起
  peekOf(nodes).props.onMouseEnter()
  harness.tick()
  nodes = harness.render(h(Button, { sessionId: 's-1' }))
  assert.ok(peekOf(nodes), '移进浮层后不该被收起')

  // 真正离开浮层
  peekOf(nodes).props.onMouseLeave()
  harness.tick()
  nodes = harness.render(h(Button, { sessionId: 's-1' }))
  assert.equal(peekOf(nodes), undefined, '离开后应收起')
})

/* ── 点击 ───────────────────────────────────────────── */

test('点击按钮：收起浮层并打开面板', async () => {
  const { exports } = boot()
  const opened = []
  const Button = exports.__test.makeEntryButton(() => { opened.push(1); return true })

  harness.reset()
  let nodes = harness.render(h(Button, { sessionId: 's-1' }))
  anchorOf(nodes).props.onMouseEnter()
  harness.tick()
  await harness.flush()
  nodes = harness.render(h(Button, { sessionId: 's-1' }))

  let prevented = false
  let stopped = false
  buttonOf(nodes).props.onClick({ preventDefault() { prevented = true }, stopPropagation() { stopped = true } })

  nodes = harness.render(h(Button, { sessionId: 's-1' }))
  assert.equal(peekOf(nodes), undefined, '点击后浮层应收起')
  assert.equal(opened.length, 1, '应打开面板')
  assert.equal(prevented, true)
  assert.equal(stopped, true)
})

test('点击浮层里的某一篇：打开面板并记住要预览哪一篇', async () => {
  const { exports } = boot({ docs: 3 })
  const opened = []
  const Button = exports.__test.makeEntryButton(() => { opened.push(1); return true })

  harness.reset()
  let nodes = harness.render(h(Button, { sessionId: 's-1' }))
  anchorOf(nodes).props.onMouseEnter()
  harness.tick()
  await harness.flush()
  nodes = harness.render(h(Button, { sessionId: 's-1' }))

  byClass(nodes, 'knit-peek-doc')[1].props.onClick()   // 点第二篇

  nodes = harness.render(h(Button, { sessionId: 's-1' }))
  assert.equal(peekOf(nodes), undefined, '点完应收起浮层')
  assert.equal(opened.length, 1, '应打开面板')

  // pendingPreviewRel 是模块内状态，KnitBody 首次拉到列表后会消费它。
  // 这里直接验证「消费」这一半：
  const { KnitBody } = exports.__test
  harness.reset()
  let panel = harness.render(h(KnitBody, { sessionId: 's-1' }))
  await harness.flush()
  panel = harness.render(h(KnitBody, { sessionId: 's-1' }))
  assert.ok(byExactClass(panel, 'knit-preview').length === 1, '面板应直接展开那一篇的预览')
})

test('点击浮层里的某一篇：只消费一次，不粘住下一次打开', async () => {
  const { exports } = boot({ docs: 3 })
  const Button = exports.__test.makeEntryButton(() => true)
  const { KnitBody } = exports.__test

  harness.reset()
  let nodes = harness.render(h(Button, { sessionId: 's-1' }))
  anchorOf(nodes).props.onMouseEnter()
  harness.tick()
  await harness.flush()
  nodes = harness.render(h(Button, { sessionId: 's-1' }))

  byClass(nodes, 'knit-peek-doc')[0].props.onClick()

  // 第一次：应展开
  harness.reset()
  let first = harness.render(h(KnitBody, { sessionId: 's-1' }))
  await harness.flush()
  first = harness.render(h(KnitBody, { sessionId: 's-1' }))
  assert.equal(byExactClass(first, 'knit-preview').length, 1)

  // 第二次开面板：不该又自动展开
  harness.reset()
  let second = harness.render(h(KnitBody, { sessionId: 's-1' }))
  await harness.flush()
  second = harness.render(h(KnitBody, { sessionId: 's-1' }))
  assert.equal(byExactClass(second, 'knit-preview').length, 0, 'pendingPreviewRel 应已被消费掉')
})

test('浮层：没有可用宿主时点击也不抛错', async () => {
  const { exports } = boot()
  const Button = exports.__test.makeEntryButton(() => false)

  harness.reset()
  let nodes = harness.render(h(Button, { sessionId: 's-1' }))
  anchorOf(nodes).props.onMouseEnter()
  harness.tick()
  await harness.flush()
  nodes = harness.render(h(Button, { sessionId: 's-1' }))

  assert.doesNotThrow(() => buttonOf(nodes).props.onClick({ preventDefault() {}, stopPropagation() {} }))
})

/* ── 即时响应（这次修复的核心）────────────────────── */

test('即时响应：面板已挂着时，点浮层某篇立刻展开预览，不等列表也不等轮询', async () => {
  const { exports } = boot({ docs: 3 })
  const { KnitBody, requestPreview } = exports.__test

  // 列表接口**永远不返回**（模拟慢扫描）；文档接口正常。
  // 旧实现要等 load() 把列表拉回来才消费目标，这里就能复现「卡几秒」。
  globalThis.fetch = (url) => (String(url).includes('/api/doc')
    ? Promise.resolve({ json: async () => ({ ok: true, rel: 'target.md', title: '目标', text: '# 目标', truncated: false }) })
    : new Promise(() => {}))

  harness.reset()
  let panel = harness.render(h(KnitBody, { sessionId: 's-1' }))
  await harness.flush()                     // 订阅建立；列表请求挂住不返回
  panel = harness.render(h(KnitBody, { sessionId: 's-1' }))
  assert.equal(byExactClass(panel, 'knit-preview').length, 0, '此时还没有预览')

  requestPreview({ rel: 'target.md', title: '目标' })   // 等价于点浮层里那一篇
  panel = harness.render(h(KnitBody, { sessionId: 's-1' }))
  assert.equal(byExactClass(panel, 'knit-preview').length, 1, '不等列表就该展开')

  await harness.flush()                     // 只等文档接口
  panel = harness.render(h(KnitBody, { sessionId: 's-1' }))
  // 预览头现在显示路径面包屑（文件名）而不是标题 —— 见「预览头显示路径面包屑」那条用例
  assert.match(textOf(byExactClass(panel, 'knit-preview')[0]), /target\.md/, '预览头应指向被点的那一篇')
  assert.equal(byExactClass(panel, 'knit-preview-note').length, 0, '正文应已到 ready，不该还停在 loading')
})

test('即时响应：面板还没挂时，信号留成挂起值，挂载第一帧就取走', async () => {
  const { exports } = boot({ docs: 3 })
  const { KnitBody, requestPreview } = exports.__test

  // 面板还没挂（用户从没开过），此时先来一次请求
  requestPreview({ rel: 'queued.md', title: '排队的目标' })

  globalThis.fetch = (url) => (String(url).includes('/api/doc')
    ? Promise.resolve({ json: async () => ({ ok: true, rel: 'queued.md', title: '排队的目标', text: '# 排队的目标', truncated: false }) })
    : Promise.resolve({ json: async () => listPayload(3) }))

  harness.reset()
  let panel = harness.render(h(KnitBody, { sessionId: 's-1' }))
  await harness.flush()
  panel = harness.render(h(KnitBody, { sessionId: 's-1' }))
  assert.equal(byExactClass(panel, 'knit-preview').length, 1, '挂载后应自动展开挂起的那一篇')

  // 挂起值只消费一次
  harness.reset()
  let again = harness.render(h(KnitBody, { sessionId: 's-1' }))
  await harness.flush()
  again = harness.render(h(KnitBody, { sessionId: 's-1' }))
  assert.equal(byExactClass(again, 'knit-preview').length, 0, '不该粘住')
})

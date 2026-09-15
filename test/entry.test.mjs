/**
 * 会话入口按钮测试。
 *
 * 背景：产物卡片「打开」右侧「更多」菜单加不了第三项（官方硬编码）。
 * 替代方案是在官方留出的 **list 座位**上挂一个入口按钮：
 *   - conversation.session.header.utilities  （会话头部右侧，右侧栏按钮旁边）
 *
 * 只挂这一处：输入框工具行那处实测「太刻意」，已去掉（回归用例见文件末尾）。
 *
 * 跑法：node --test test/
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { loadClientModule, createHarness, byClass, textOf, makeLocale } from './harness.mjs'

const harness = createHarness()
const React = globalThis.__knitReact
const h = React.createElement

/* ── 脚手架 ─────────────────────────────────────────── */

/**
 * 造一个假的 cordis 上下文。
 * @param {object} services - 可用服务表（sidebarRight / betterSidebar / slots）
 * @returns {{ctx: object, log: object}} 上下文与记录
 */
function fakeCtx(services = {}) {
  const log = { slots: [], tabs: [], bsTabs: [], effects: [] }
  const { locale, registered } = makeLocale({ active: services.locale || 'zh' })
  const table = { ...services, locale }
  if (services.sidebarRightTabs) {
    table.sidebarRightTabs = { register(def) { log.tabs.push(def); return () => {} } }
  }
  if (services.betterSidebar) {
    table.betterSidebar = { registerTab(d) { log.bsTabs.push(d); return () => {} } }
  }
  table.slots = {
    inject(name, cb) { cb(); return () => {} },
    register(opts, component) { log.slots.push({ opts, component }); return () => {} },
  }

  const ctx = {
    slots: table.slots,
    locale,
    effect(fn, label) { log.effects.push(label); return fn() },
    get(name) { return table[name] },
    inject(deps, callback) {
      for (const dep of deps) if (!table[dep]) return
      const face = { ...table }
      face.effect = (fn) => { fn() }
      callback(face)
    },
  }
  return { ctx, log, registered }
}

/* ── openKnitPanel：宿主解析 ────────────────────────── */

test('openKnitPanel：优先用官方右侧栏 openTab(kind)', () => {
  const { exports } = loadClientModule()
  const { openKnitPanel } = exports.__test

  const calls = []
  const ctx = { get: (n) => (n === 'sidebarRight' ? { openTab: (k) => calls.push(k) } : undefined) }

  assert.equal(openKnitPanel(ctx), true)
  assert.deepEqual(calls, ['knit'], '应调用 openTab("knit")')
})

test('openKnitPanel：官方右侧栏不在时退回 better-sidebar', () => {
  const { exports } = loadClientModule()
  const { openKnitPanel } = exports.__test

  const calls = []
  const ctx = {
    get: (n) => (n === 'betterSidebar' ? { openTab: (seed) => calls.push(seed) } : undefined),
  }

  assert.equal(openKnitPanel(ctx), true)
  assert.deepEqual(calls, [{ type: 'knit:recent' }], '应调用 betterSidebar.openTab({type})')
})

test('openKnitPanel：两个宿主都没有时返回 false，不抛错', () => {
  const { exports } = loadClientModule()
  const { openKnitPanel } = exports.__test
  assert.equal(openKnitPanel({ get: () => undefined }), false)
  assert.equal(openKnitPanel(undefined), false)
  assert.equal(openKnitPanel({}), false, 'ctx 没有 get 也要安全')
})

test('openKnitPanel：官方 openTab 抛错时退到 better-sidebar，不中断', () => {
  const { exports } = loadClientModule()
  const { openKnitPanel } = exports.__test

  const calls = []
  const ctx = {
    get: (n) => {
      if (n === 'sidebarRight') return { openTab: () => { throw new Error('炸了') } }
      if (n === 'betterSidebar') return { openTab: (seed) => calls.push(seed) }
      return undefined
    },
  }

  assert.equal(openKnitPanel(ctx), true, '官方挂了应该还有兜底')
  assert.deepEqual(calls, [{ type: 'knit:recent' }])
})

test('openKnitPanel：宿主服务存在但没有 openTab 时不误判成功', () => {
  const { exports } = loadClientModule()
  const { openKnitPanel } = exports.__test
  assert.equal(openKnitPanel({ get: () => ({}) }), false)
})

/* ── 入口按钮组件 ───────────────────────────────────── */

test('入口按钮：渲染一个可点按钮，带无障碍标签', () => {
  const { exports } = loadClientModule()
  const { makeEntryButton } = exports.__test
  const Button = makeEntryButton(() => true)

  harness.reset()
  const nodes = harness.render(h(Button, {}))
  const btn = byClass(nodes, 'knit-entry')[0]

  assert.ok(btn, '应渲染出 .knit-entry')
  assert.equal(btn.type, 'button')
  assert.equal(btn.props['aria-label'], 'Knit 最近文档')

  // 图标是 mono SVG（不再是毛球 emoji）；渲染细节由 test/icon.test.mjs 覆盖
  const svg = nodes.find((n) => n.type === 'svg')
  assert.ok(svg, '按钮里应是 SVG 图标')
})

test('入口按钮：点击触发打开，并阻止冒泡', () => {
  const { exports } = loadClientModule()
  const { makeEntryButton } = exports.__test

  let opened = 0
  let prevented = false
  let stopped = false
  const Button = makeEntryButton(() => { opened += 1; return true })

  harness.reset()
  const nodes = harness.render(h(Button, {}))
  byClass(nodes, 'knit-entry')[0].props.onClick({
    preventDefault() { prevented = true },
    stopPropagation() { stopped = true },
  })

  assert.equal(opened, 1)
  assert.equal(prevented, true, '要 preventDefault（避免触发头部其它行为）')
  assert.equal(stopped, true, '要 stopPropagation')
})

test('入口按钮：没有宿主时点击不抛错', () => {
  const { exports } = loadClientModule()
  const { makeEntryButton } = exports.__test
  const Button = makeEntryButton(() => false)

  harness.reset()
  const nodes = harness.render(h(Button, {}))
  const btn = byClass(nodes, 'knit-entry')[0]
  assert.doesNotThrow(() => btn.props.onClick({ preventDefault() {}, stopPropagation() {} }))
})

/* ── 注册：两处座位 ─────────────────────────────────── */

/**
 * 从全部座位注册里挑出入口按钮那两条。
 *
 * 右侧栏的 tab body/title 也走同一个 slots，所以必须按 id 过滤，
 * 不能拿 log.slots 的总数当断言。
 *
 * @param {object} log - fakeCtx 的记录
 * @returns {object[]} 入口按钮的注册
 */
function entryRegs(log) {
  return log.slots.filter((s) => s.opts.id === 'knit:entry')
}

test('注册：入口按钮只挂会话头部一处 list 座位', () => {
  const { ctx, log } = fakeCtx({ sidebarRightTabs: true })
  const { exports } = loadClientModule()
  exports.apply(ctx)

  const entries = entryRegs(log)
  assert.equal(entries.length, 1, '入口只挂一处')
  assert.equal(entries[0].opts.name, 'conversation.session.header.utilities', '应挂到会话头部右侧')
  assert.equal(entries[0].opts.id, 'knit:entry', 'id 要稳定，便于去重与替换')
  assert.equal(typeof entries[0].opts.order, 'number', 'list 座位要按 order 排序')
  assert.equal(typeof entries[0].component, 'function', '要给出组件')
})

test('注册：不再挂输入框工具行（那处实测太刻意）', () => {
  const { ctx, log } = fakeCtx({ sidebarRightTabs: true })
  const { exports } = loadClientModule()
  exports.apply(ctx)

  const seats = entryRegs(log).map((s) => s.opts.name)
  assert.ok(!seats.includes('conversation.input.left'), '不该再挂输入框工具行')
  assert.ok(!seats.includes('conversation.input.right'), '输入框右侧同样不挂')
})

test('注册：入口按钮用 list 语义（只给 id/order，不抢 key）', () => {
  const { ctx, log } = fakeCtx({ sidebarRightTabs: true })
  const { exports } = loadClientModule()
  exports.apply(ctx)

  for (const entry of entryRegs(log)) {
    assert.equal(entry.opts.key, undefined, 'list 座位不用 key（那是 keyed 座位的东西）')
  }
})

test('注册：即使没有任何侧边栏宿主，入口按钮照常注册（点击时才解析宿主）', () => {
  const { ctx, log } = fakeCtx({})
  const { exports } = loadClientModule()
  exports.apply(ctx)

  const seats = entryRegs(log).map((s) => s.opts.name)
  assert.deepEqual(seats, ['conversation.session.header.utilities'])
})

test('注册：入口按钮与 tab 注册互不影响', () => {
  const { ctx, log } = fakeCtx({ sidebarRightTabs: true, betterSidebar: true })
  const { exports } = loadClientModule()
  exports.apply(ctx)

  assert.equal(log.tabs.length, 1, '官方右侧栏 tab 注册一份')
  assert.equal(log.bsTabs.length, 1, 'better-sidebar tab 注册一份')
  assert.equal(entryRegs(log).length, 1, '入口按钮一处，不重复')
})

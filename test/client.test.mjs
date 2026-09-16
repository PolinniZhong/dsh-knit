/**
 * 浏览器半边测试：两个宿主的注册、排序切换、相关度渲染、预览、降级。
 *
 * 跑法：node --test test/
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { loadClientModule, createHarness, byClass, byExactClass, textOf, makeLocale } from './harness.mjs'

const harness = createHarness()
const React = globalThis.__knitReact
const h = React.createElement

/* ── 假宿主 ─────────────────────────────────────────── */

/**
 * 造一个假的 cordis 上下文，只实现插件用到的 inject / effect 语义。
 * 服务缺失时**不调用**回调 —— 这正是 cordis 子 fiber 等待的行为。
 *
 * @param {{sidebarRightTabs?: boolean, betterSidebar?: boolean}} available - 哪些服务可用
 * @returns {{ctx: object, log: object}} 假上下文与调用记录
 */
function fakeCtx(available = {}) {
  const log = { tabs: [], bsTabs: [], slots: [], effects: [] }
  const { locale, registered } = makeLocale({ active: available.locale || 'zh' })

  const slots = {
    inject(name, cb) { cb(); return () => {} },
    register(opts, component) { log.slots.push({ opts, component }); return () => {} },
  }

  const services = { slots, locale }
  if (available.sidebarRightTabs) {
    services.sidebarRightTabs = { register(definition) { log.tabs.push(definition); return () => {} } }
  }
  if (available.betterSidebar) {
    services.betterSidebar = { registerTab(descriptor) { log.bsTabs.push(descriptor); return () => {} } }
  }

  const ctx = {
    // 模块级 inject: ['slots','locale'] 让它们直接挂在根 ctx 上（真实 cordis 行为）
    slots,
    locale,
    effect(fn, label) { log.effects.push(label); return fn() },
    get(name) { return services[name] },
    inject(deps, callback) {
      // 真实 cordis：派生上下文保留父级全部服务，再叠加注入的那几个
      const face = { ...services }
      for (const dep of deps) {
        if (!services[dep]) return           // 服务缺失 → 子 fiber 保持等待
      }
      face.effect = (fn, label) => { log.effects.push(label); fn() }
      callback(face)
    },
  }

  return { ctx, log, registered }
}

/**
 * 造一份文档列表载荷。
 * @param {object} overrides - 覆盖字段
 * @returns {object} 载荷
 */
function listPayload(overrides = {}) {
  return {
    ok: true,
    root: '/p',
    total: 2,
    mode: 'time',
    topic: '',
    docs: [
      { path: '/p/技术方案.md', rel: '技术方案.md', name: '技术方案.md', title: '技术方案', summary: '摘要一', mtimeMs: Date.now() - 60000, score: null },
      { path: '/p/sub/需求 文档.md', rel: 'sub/需求 文档.md', name: '需求 文档.md', title: '需求', summary: '摘要二', mtimeMs: Date.now() - 9e7, score: null },
    ],
    ...overrides,
  }
}

/**
 * 装一个记录调用的 fetch 替身。
 * @param {Function} responder - 按 url 返回载荷
 * @returns {{calls: string[]}} 调用记录
 */
function installFetch(responder) {
  const calls = []
  globalThis.fetch = async (url) => {
    calls.push(url)
    return { json: async () => responder(url) }
  }
  return { calls }
}

/* ── 注册：官方右侧栏 ───────────────────────────────── */

test('注册：有 sidebarRightTabs 时注册类型、body、标题三件套', () => {
  const { ctx, log, services } = fakeCtx({ sidebarRightTabs: true })
  const { exports } = loadClientModule()
  exports.apply(ctx)

  // 替换成带记录能力的实现还没生效，这里直接断言真实注册走的路径
  assert.equal(log.tabs.length, 1)
  assert.equal(log.tabs[0].kind, 'knit')
  assert.equal(log.tabs[0].priority, 'extension')
  assert.equal(log.tabs[0].patterns, undefined, 'page 类型不应声明 patterns')
  assert.equal(log.tabs[0].guide.length, 1)
  assert.equal(log.tabs[0].guide[0].order, 30)
})

test('注册：没有 sidebarRightTabs 时静默跳过，不抛错', () => {
  const { ctx, log } = fakeCtx({})
  const { exports } = loadClientModule()
  assert.doesNotThrow(() => exports.apply(ctx))
  assert.equal(log.tabs.length, 0)
})

/* ── 注册：better-sidebar ───────────────────────────── */

test('注册：有 betterSidebar 时注册一个 tab descriptor', () => {
  const { ctx, log } = fakeCtx({ betterSidebar: true })
  const { exports } = loadClientModule()
  exports.apply(ctx)

  assert.equal(log.bsTabs.length, 1)
  const d = log.bsTabs[0]
  assert.equal(d.id, 'knit:recent')
  assert.equal(d.single, true, '同类型只开一个')
  assert.equal(typeof d.component, 'function')
  assert.equal(d.title(), 'Knit 最近文档')
})

test('注册：两个宿主都在时互不影响，各注册一份', () => {
  const { ctx, log } = fakeCtx({ sidebarRightTabs: true, betterSidebar: true })
  const { exports } = loadClientModule()
  exports.apply(ctx)

  assert.equal(log.tabs.length, 1, '官方右侧栏注册一份')
  assert.equal(log.bsTabs.length, 1, 'better-sidebar 注册一份')
})

test('注册：better-sidebar 缺失时官方右侧栏照常注册', () => {
  const { ctx, log } = fakeCtx({ sidebarRightTabs: true })
  const { exports } = loadClientModule()
  exports.apply(ctx)

  assert.equal(log.tabs.length, 1)
  assert.equal(log.bsTabs.length, 0)
})

/* ── 渲染：排序模式 ─────────────────────────────────── */

test('渲染：relevance 模式不做任何相关度可视化，只解释排序依据', async () => {
  installFetch(() => listPayload({
    mode: 'relevance',
    topic: '相关性、sidebar',
    docs: [
      { path: '/p/a.md', rel: 'a.md', name: 'a.md', title: 'A 文档', summary: 's', mtimeMs: Date.now(), score: 96 },
      { path: '/p/b.md', rel: 'b.md', name: 'b.md', title: 'B 文档', summary: 's', mtimeMs: Date.now(), score: 12 },
    ],
  }))

  const { exports } = loadClientModule()
  const { KnitBody } = exports.__test
  harness.reset()
  let nodes = harness.render(h(KnitBody, { sessionId: 's1' }))
  await harness.flush()
  nodes = harness.render(h(KnitBody, { sessionId: 's1' }))

  // 相关度可视化已经全部移除：排序本身就是答案，名次即相关度。
  // 数字会被误读成绝对概率；长条对「找到那篇文档」没有帮助。
  assert.equal(byClass(nodes, 'knit-rel-num').length, 0, '不该有百分比数字')
  assert.equal(byClass(nodes, 'knit-rel-bar').length, 0, '不该有长条')
  assert.equal(byClass(nodes, 'knit-rel-fill').length, 0, '不该有长条填充')

  const docs = byClass(nodes, 'knit-doc')
  assert.ok(!String(docs[0].props.className).includes('hot'), '不该有相关度高亮边框')
  assert.ok(!String(docs[0].props.className).includes('dim'), '不该有变暗档')

  assert.equal(byClass(nodes, 'knit-time').length, 2, '时间对所有行都一样显示')

  const topic = byClass(nodes, 'knit-topic').map(textOf)[0]
  assert.ok(topic.includes('相关性、sidebar'), '应说明按什么话题排的')
})

test('渲染：相关度分数只影响顺序，不影响任何一行的渲染', async () => {
  const make = (scores) => listPayload({
    mode: 'relevance',
    topic: 'x',
    docs: scores.map((score, i) => ({
      path: `/p/${i}.md`, rel: `${i}.md`, name: `${i}.md`, title: `文档 ${i}`,
      summary: 's', mtimeMs: Date.now(), score,
    })),
  })

  /**
   * 渲染一份分数表，返回每一行的 class 与文本。
   * @param {number[]} scores - 分数
   * @returns {Promise<Array<{cls:string, text:string}>>} 行信息
   */
  async function rowsFor(scores) {
    installFetch(() => make(scores))
    const { exports } = loadClientModule()
    const { KnitBody } = exports.__test
    harness.reset()
    let nodes = harness.render(h(KnitBody, { sessionId: 's1' }))
    await harness.flush()
    nodes = harness.render(h(KnitBody, { sessionId: 's1' }))
    return byClass(nodes, 'knit-doc').map((n) => ({ cls: String(n.props.className), text: textOf(n) }))
  }

  const high = await rowsFor([96, 12])
  const zero = await rowsFor([80, 0])

  // 分数不同，但同样的行数、同样的 class、同样的文案结构
  assert.equal(high.length, zero.length)
  assert.deepEqual(
    high.map((r) => r.cls),
    zero.map((r) => r.cls),
    '分数高低不该改变行的 class',
  )
  assert.ok(
    high.every((r) => !/hot|dim|rel/.test(r.cls)),
    `行上不该挂任何相关度 class：${high.map((r) => r.cls).join(' / ')}`,
  )
  assert.ok(high.every((r) => !/\d+%/.test(r.text)), `行内不该出现百分比：${high.map((r) => r.text).join(' | ')}`)
})

test('渲染：分数为 0 的文档与高分文档渲染完全一致（0 不代表"没用"）', async () => {
  installFetch(() => listPayload({
    mode: 'relevance',
    topic: 'x',
    docs: [
      { path: '/p/a.md', rel: 'a.md', name: 'a.md', title: 'A', summary: 's', mtimeMs: Date.now(), score: 80 },
      { path: '/p/b.md', rel: 'b.md', name: 'b.md', title: 'B', summary: 's', mtimeMs: Date.now(), score: 0 },
    ],
  }))

  const { exports } = loadClientModule()
  const { KnitBody } = exports.__test
  harness.reset()
  let nodes = harness.render(h(KnitBody, { sessionId: 's1' }))
  await harness.flush()
  nodes = harness.render(h(KnitBody, { sessionId: 's1' }))

  const docs = byClass(nodes, 'knit-doc')
  assert.equal(docs.length, 2)
  assert.equal(docs[0].props.className, docs[1].props.className, '两行 class 必须一致')
  assert.equal(byClass(nodes, 'knit-time').length, 2, '两行都显示时间')
})

test('渲染：time 模式不显示分数，显示相对时间', async () => {
  installFetch(() => listPayload())

  const { exports } = loadClientModule()
  const { KnitBody } = exports.__test
  harness.reset()
  harness.seed(['', 'time'])          // notice='', sort='time'
  let nodes = harness.render(h(KnitBody, { sessionId: 's1' }))
  await harness.flush()
  nodes = harness.render(h(KnitBody, { sessionId: 's1' }))

  assert.equal(byClass(nodes, 'knit-rel-num').length, 0, '时间模式不应有分数')
  assert.equal(byClass(nodes, 'knit-time').length, 2, '应显示相对时间')
  assert.ok(byClass(nodes, 'knit-topic').map(textOf)[0].includes('修改时间'))
})

test('渲染：请求 URL 带上当前排序方式', async () => {
  const { calls } = installFetch(() => listPayload())
  const { exports } = loadClientModule()
  const { KnitBody } = exports.__test
  harness.reset()
  harness.seed(['', 'time'])
  harness.render(h(KnitBody, { sessionId: 's1' }))
  await harness.flush()

  assert.ok(calls[0].includes('sort=time'), `实际 URL: ${calls[0]}`)
  assert.ok(calls[0].includes('sessionId=s1'))
})

test('渲染：点「最新」会记住偏好并重新拉取', async () => {
  const { calls } = installFetch(() => listPayload())
  const { exports } = loadClientModule()
  const { KnitBody } = exports.__test
  harness.reset()
  let nodes = harness.render(h(KnitBody, { sessionId: 's1' }))
  await harness.flush()
  nodes = harness.render(h(KnitBody, { sessionId: 's1' }))

  const timeBtn = byClass(nodes, 'knit-seg-btn').find((n) => textOf(n) === '最新')
  assert.ok(timeBtn, '应有一个「最新」按钮')
  timeBtn.props.onClick()

  nodes = harness.render(h(KnitBody, { sessionId: 's1' }))
  await harness.flush()
  assert.ok(calls.some((u) => u.includes('sort=time')), '切换后应带 sort=time 重新请求')
  assert.equal(globalThis.window.localStorage.getItem('dsh-knit:sort'), 'time', '偏好应被记住')
})

/* ── 渲染：就地预览 ─────────────────────────────────── */

test('渲染：单击展开预览，再点收起', async () => {
  installFetch((url) => (url.includes('/api/doc')
    ? { ok: true, rel: '技术方案.md', title: '技术方案', text: '# 技术方案\n\n正文。', truncated: false }
    : listPayload()))

  const { exports, markdownCalls } = loadClientModule()
  const { KnitBody } = exports.__test
  harness.reset()
  harness.seed(['', 'time'])
  let nodes = harness.render(h(KnitBody, { sessionId: 's1' }))
  await harness.flush()
  nodes = harness.render(h(KnitBody, { sessionId: 's1' }))

  const panelOf = (ns) => ns.find((n) => String(n.props.className) === 'knit-preview')
  assert.equal(panelOf(nodes), undefined, '初始不应有预览')

  byClass(nodes, 'knit-doc')[0].props.onClick()
  nodes = harness.render(h(KnitBody, { sessionId: 's1' }))
  assert.ok(panelOf(nodes), '单击后应出现预览面板')

  await harness.flush()
  nodes = harness.render(h(KnitBody, { sessionId: 's1' }))
  assert.ok(markdownCalls.length >= 1, '应用原生 MarkdownText 渲染')
  assert.match(markdownCalls.at(-1).text, /正文/)

  byClass(nodes, 'knit-doc')[0].props.onClick()
  nodes = harness.render(h(KnitBody, { sessionId: 's1' }))
  assert.equal(panelOf(nodes), undefined, '再点同一条应收起')
})

test('渲染：拿不到 ui-primitives 时降级为 pre 并**显式说明**', async () => {
  installFetch((url) => (url.includes('/api/doc')
    ? { ok: true, rel: '技术方案.md', title: '技术方案', text: '纯文本正文', truncated: false }
    : listPayload()))

  const { exports, markdownCalls } = loadClientModule({ primitives: false })
  const { KnitBody } = exports.__test
  harness.reset()
  harness.seed(['', 'time'])
  let nodes = harness.render(h(KnitBody, { sessionId: 's1' }))
  await harness.flush()
  nodes = harness.render(h(KnitBody, { sessionId: 's1' }))
  byClass(nodes, 'knit-doc')[0].props.onClick()
  nodes = harness.render(h(KnitBody, { sessionId: 's1' }))
  await harness.flush()
  nodes = harness.render(h(KnitBody, { sessionId: 's1' }))

  assert.equal(markdownCalls.length, 0, '不应调用 MarkdownText')
  assert.equal(byClass(nodes, 'knit-raw').length, 1, '应退回 <pre>')
  assert.match(byClass(nodes, 'knit-preview-note').map(textOf).join(''), /原生 Markdown 渲染不可用/, '降级必须显式说明')
})

test('渲染：MarkdownText 以 React.memo 形态（对象而非函数）提供时也必须用上', async () => {
  // 真实形态：ui-primitives 的 MarkdownText = React.memo(...) → 对象，不是函数。
  // 曾经用 typeof === 'function' 判断，把可用的渲染器误判成不可用，一路静默降级成纯文本。
  installFetch((url) => (url.includes('/api/doc')
    ? { ok: true, rel: '技术方案.md', title: '技术方案', text: '# 标题\n\n正文', truncated: false }
    : listPayload()))

  const { exports, markdownCalls } = loadClientModule()
  const { KnitBody } = exports.__test
  harness.reset()
  harness.seed(['', 'time'])
  let nodes = harness.render(h(KnitBody, { sessionId: 's1' }))
  await harness.flush()
  nodes = harness.render(h(KnitBody, { sessionId: 's1' }))
  byClass(nodes, 'knit-doc')[0].props.onClick()
  nodes = harness.render(h(KnitBody, { sessionId: 's1' }))
  await harness.flush()
  nodes = harness.render(h(KnitBody, { sessionId: 's1' }))

  assert.equal(markdownCalls.length, 1, 'memo 形态的 MarkdownText 必须被用上')
  assert.equal(byClass(nodes, 'knit-raw').length, 0, '不该走纯文本降级')
})

/* ── 宿主适配层 ─────────────────────────────────────── */

/**
 * 把适配层渲染到可以双击为止。
 * @param {object} adapter - 适配层组件
 * @param {object} props - 适配层入参
 * @returns {Promise<{nodes: object[], openFirst: Function}>} 节点与「双击第一条」的动作
 */
async function renderAdapter(adapter, props) {
  harness.reset()
  let nodes = harness.render(h(adapter, props))
  await harness.flush()
  nodes = harness.render(h(adapter, props))
  const cards = byClass(nodes, 'knit-doc')
  return {
    nodes,
    openFirst: async () => {
      cards[0].props.onDoubleClick()
      let next = harness.render(h(adapter, props))
      await harness.flush()
      next = harness.render(h(adapter, props))
      return next
    },
  }
}

test('适配：官方宿主双击走 tab.actions.openResource，地址编码正确', async () => {
  const opened = []
  const { exports } = loadClientModule()
  const { OfficialTabBody } = exports.__test
  installFetch(() => listPayload())

  const props = {
    sessionId: 's-1',
    useTabInfo: () => ({
      tab: { id: 't', visible: true, actions: { openResource: (a) => opened.push(a) } },
    }),
  }
  const { openFirst } = await renderAdapter(OfficialTabBody, props)
  await openFirst()

  assert.equal(opened.length, 1, '应调用一次 openResource')
  assert.equal(opened[0], 'dsh-resource://file/session/s-1/%E6%8A%80%E6%9C%AF%E6%96%B9%E6%A1%88.md')
})

test('适配：官方宿主缺 tab.actions 时给出可见提示，不静默失败', async () => {
  const { exports } = loadClientModule()
  const { OfficialTabBody } = exports.__test
  installFetch(() => listPayload())

  const props = { sessionId: 's-1', useTabInfo: () => ({ tab: { id: 't', visible: true } }) }
  const { openFirst } = await renderAdapter(OfficialTabBody, props)
  const nodes = await openFirst()

  assert.match(byClass(nodes, 'knit-notice').map(textOf).join(''), /openResource/)
})

test('适配：better-sidebar 双击走 ctx.betterSidebar.openTab，传绝对路径', async () => {
  const opened = []
  const fakeBs = { openTab: (seed) => opened.push(seed), isTabEnabled: () => true }
  const { exports } = loadClientModule()
  const { BetterSidebarTabBody } = exports.__test
  installFetch(() => listPayload())

  const props = { ctx: { get: () => fakeBs }, scope: { sessionId: 's-9' } }
  const { openFirst } = await renderAdapter(BetterSidebarTabBody, props)
  await openFirst()

  assert.equal(opened.length, 1, '应调用一次 openTab')
  assert.equal(opened[0].type, 'editor')
  assert.equal(opened[0].path, '/p/技术方案.md', '要传绝对路径，better-sidebar 按它读文件')
  assert.equal(opened[0].title, '技术方案.md')
})

test('适配：better-sidebar 的编辑器 tab 被禁用时说明原因，不硬闯', async () => {
  const opened = []
  const fakeBs = { openTab: (seed) => opened.push(seed), isTabEnabled: () => false }
  const { exports } = loadClientModule()
  const { BetterSidebarTabBody } = exports.__test
  installFetch(() => listPayload())

  const props = { ctx: { get: () => fakeBs }, scope: { sessionId: 's-9' } }
  const { openFirst } = await renderAdapter(BetterSidebarTabBody, props)
  const nodes = await openFirst()

  assert.equal(opened.length, 0, '禁用时不该硬闯')
  assert.match(byClass(nodes, 'knit-notice').map(textOf).join(''), /禁用/)
})

test('适配：better-sidebar 服务不可用时不崩', async () => {
  const { exports } = loadClientModule()
  const { BetterSidebarTabBody } = exports.__test
  installFetch(() => listPayload())

  const props = { ctx: { get: () => undefined }, scope: { sessionId: 's-9' } }
  const { openFirst } = await renderAdapter(BetterSidebarTabBody, props)
  const nodes = await openFirst()
  assert.match(byClass(nodes, 'knit-notice').map(textOf).join(''), /不可用/)
})

/* ── 降级与错误态 ───────────────────────────────────── */

test('渲染：没有 sessionId 时给出明确错误而不是空白', async () => {
  installFetch(() => listPayload())
  const { exports } = loadClientModule()
  const { KnitBody } = exports.__test
  harness.reset()
  let nodes = harness.render(h(KnitBody, {}))
  await harness.flush()
  nodes = harness.render(h(KnitBody, {}))
  const msg = byClass(nodes, 'knit-msg').map(textOf).join('')
  assert.match(msg, /sessionId/)
})

test('渲染：宿主返回失败时把错误码翻成当前语言的文案', async () => {
  installFetch(() => ({ ok: false, code: 'knit/outside-workspace' }))
  const { exports } = loadClientModule()
  const { KnitBody } = exports.__test
  harness.reset()
  let nodes = harness.render(h(KnitBody, { sessionId: 's1' }))
  await harness.flush()
  nodes = harness.render(h(KnitBody, { sessionId: 's1' }))
  assert.match(byClass(nodes, 'knit-msg').map(textOf).join(''), /路径越出工作区/)
})

/* ── 图片与视频 ─────────────────────────────────────── */

/** 造一份媒体载荷（1 图 + 1 视频，图片在前）。 */
function mediaPayload(overrides = {}) {
  const now = Date.now()
  return {
    ok: true, root: '/p', total: 2, mode: 'time', topic: '', kind: 'media',
    docs: [
      { path: '/p/a.png', rel: 'a.png', name: 'a.png', title: 'a', kind: 'image', summary: '', size: 1024, mtimeMs: now - 60000, score: null },
      { path: '/p/demo.mp4', rel: 'demo.mp4', name: 'demo.mp4', title: 'demo', kind: 'video', summary: '', size: 99999, mtimeMs: now - 9e7, score: null },
    ],
    ...overrides,
  }
}

/** 造一份文档 + 图片 + 视频混排载荷（全部视图）。 */
function mixedPayload(overrides = {}) {
  const now = Date.now()
  return {
    ok: true, root: '/p', total: 3, mode: 'time', topic: '', kind: 'all',
    docs: [
      { path: '/p/方案.md', rel: '方案.md', name: '方案.md', title: '方案', kind: 'md', summary: '文档摘要', size: 500, mtimeMs: now - 30000, score: null },
      { path: '/p/a.png', rel: 'a.png', name: 'a.png', title: 'a', kind: 'image', summary: '', size: 1024, mtimeMs: now - 60000, score: null },
      { path: '/p/demo.mp4', rel: 'demo.mp4', name: 'demo.mp4', title: 'demo', kind: 'video', summary: '', size: 99999, mtimeMs: now - 9e7, score: null },
    ],
    ...overrides,
  }
}

/** 按请求里的 kind 参数返回对应载荷。 */
function kindResponder(map) {
  return (url) => {
    if (url.includes('/api/doc')) {
      return { ok: true, rel: 'x.md', title: 'x', text: '正文', truncated: false }
    }
    const m = url.match(/[?&]kind=([a-z]+)/)
    return (map && map[m ? m[1] : 'doc']) || listPayload()
  }
}

/** 造一份超出「全部」两个分区上限的载荷：7 篇文档 + 5 图 + 4 视频 = 16 项。 */
function bigMixedPayload() {
  const now = Date.now()
  const docs = []
  for (let i = 1; i <= 7; i += 1) {
    docs.push({
      path: `/p/d${i}.md`, rel: `d${i}.md`, name: `d${i}.md`, title: `文档${i}`,
      kind: 'md', summary: '摘要', size: 500, mtimeMs: now - i * 1000, score: null,
    })
  }
  for (let i = 1; i <= 5; i += 1) {
    docs.push({
      path: `/p/i${i}.png`, rel: `i${i}.png`, name: `i${i}.png`, title: `图${i}`,
      kind: 'image', summary: '', size: 1024, mtimeMs: now - i * 1000, score: null,
    })
  }
  for (let i = 1; i <= 4; i += 1) {
    docs.push({
      path: `/p/v${i}.mp4`, rel: `v${i}.mp4`, name: `v${i}.mp4`, title: `视频${i}`,
      kind: 'video', summary: '', size: 99999, mtimeMs: now - i * 1000, score: null,
    })
  }
  return {
    ok: true, root: '/p', total: docs.length, mode: 'time', topic: '', kind: 'all', docs,
  }
}

/**
 * 按 class **词**取节点。
 *
 * 一个节点的 className 常同时带 active / cursor / fresh，`byExactClass` 的整段相等
 * 匹配用不了，`byClass` 的子串匹配又会误伤 —— 计数类断言用这个。
 *
 * @param {object[]} nodes - 扁平节点
 * @param {string} token - 单个 class 名
 * @returns {object[]} 命中的节点
 */
function byToken(nodes, token) {
  return nodes.filter((n) => String(n.props.className || '').split(/\s+/).includes(token))
}

test('媒体：fmtDuration 格式化 m:ss / h:mm:ss，非法值回落', () => {
  const { fmtDuration } = loadClientModule().exports.__test
  assert.equal(fmtDuration(0), '0:00')
  assert.equal(fmtDuration(5), '0:05')
  assert.equal(fmtDuration(65), '1:05')
  assert.equal(fmtDuration(3725), '1:02:05')
  assert.equal(fmtDuration(NaN), '0:00')
})

test('媒体：mediaUrl 拼同源 raw 地址并编码相对路径', () => {
  const { mediaUrl } = loadClientModule().exports.__test
  const u = mediaUrl('s1', 'sub/a b.png')
  assert.match(u, /^\/knit\/api\/raw\?/)
  assert.ok(u.includes('sessionId=s1'))
  assert.ok(u.includes('rel=sub%2Fa%20b.png'), `实际: ${u}`)
})

test('媒体：isMedia 只认 image/video', () => {
  const { isMedia } = loadClientModule().exports.__test
  assert.equal(isMedia({ kind: 'image' }), true)
  assert.equal(isMedia({ kind: 'video' }), true)
  assert.equal(isMedia({ kind: 'md' }), false)
  assert.equal(isMedia(null), false)
})

test('媒体：类型偏好默认 doc，合法值保留，非法值回落', () => {
  const { readKindPref } = loadClientModule().exports.__test
  assert.equal(readKindPref(), 'doc')
  globalThis.window.localStorage.setItem('dsh-knit:kind', 'media')
  assert.equal(readKindPref(), 'media')
  globalThis.window.localStorage.setItem('dsh-knit:kind', 'all')
  assert.equal(readKindPref(), 'all')
  globalThis.window.localStorage.setItem('dsh-knit:kind', 'garbage')
  assert.equal(readKindPref(), 'doc')
})

test('媒体：默认文档视图有三个类型按钮，但不出现媒体网格，计数仍按文档', async () => {
  installFetch(kindResponder({ doc: listPayload() }))
  const { KnitBody } = loadClientModule().exports.__test
  harness.reset()
  harness.seed(['', 'time'])
  let nodes = harness.render(h(KnitBody, { sessionId: 's1' }))
  await harness.flush()
  nodes = harness.render(h(KnitBody, { sessionId: 's1' }))

  const btns = byClass(nodes, 'knit-type-btn')
  assert.equal(btns.length, 3)
  assert.deepEqual(btns.map(textOf), ['文档', '图片与视频', '全部'])
  assert.equal(btns.find((b) => textOf(b) === '文档').props['aria-selected'], true)
  assert.equal(byClass(nodes, 'knit-media-grid').length, 0)
  assert.equal(byClass(nodes, 'knit-doc').length, 2)
  assert.match(byClass(nodes, 'knit-count').map(textOf).join(''), /2 篇/)
})

test('媒体：媒体视图渲染方形网格，图片出 img、视频出首帧 video 与播放三角', async () => {
  const { calls } = installFetch(kindResponder({ media: mediaPayload() }))
  const { KnitBody } = loadClientModule().exports.__test
  harness.reset()
  harness.seed(['', 'time', 'media'])
  let nodes = harness.render(h(KnitBody, { sessionId: 's1' }))
  await harness.flush()
  nodes = harness.render(h(KnitBody, { sessionId: 's1' }))

  assert.ok(calls[0].includes('kind=media'), `实际 URL: ${calls[0]}`)
  assert.equal(byClass(nodes, 'knit-media-grid').length, 1)
  assert.equal(byClass(nodes, 'knit-media-card').length, 2)
  assert.equal(byClass(nodes, 'knit-doc').length, 0, '媒体视图不该有文档行')
  assert.equal(nodes.filter((n) => n.type === 'img').length, 1, '一张图片缩略图')
  const videos = nodes.filter((n) => n.type === 'video')
  assert.equal(videos.length, 1, '一个视频首帧')
  assert.equal(videos[0].props.preload, 'metadata')
  assert.ok(String(videos[0].props.src).includes('#t=0.5'), '用 #t=0.5 取首帧')
  assert.equal(byClass(nodes, 'knit-thumb-play').length, 1, '视频有中央播放三角')
  assert.match(byClass(nodes, 'knit-count').map(textOf).join(''), /2 个媒体/)
})

test('媒体：点图片卡片就地预览大图，且不请求 /api/doc', async () => {
  const { calls } = installFetch(kindResponder({ media: mediaPayload() }))
  const { KnitBody } = loadClientModule().exports.__test
  harness.reset()
  harness.seed(['', 'time', 'media'])
  let nodes = harness.render(h(KnitBody, { sessionId: 's1' }))
  await harness.flush()
  nodes = harness.render(h(KnitBody, { sessionId: 's1' }))

  byClass(nodes, 'knit-media-card')[0].props.onClick()   // 第一张是图片
  nodes = harness.render(h(KnitBody, { sessionId: 's1' }))
  await harness.flush()
  nodes = harness.render(h(KnitBody, { sessionId: 's1' }))

  const pm = byClass(nodes, 'knit-preview-media')
  assert.equal(pm.length, 1)
  assert.equal(pm[0].type, 'img')
  assert.ok(String(pm[0].props.src).includes('/knit/api/raw'))
  assert.ok(!calls.some((u) => u.includes('/api/doc')), '图片不应触发正文请求')
})

test('媒体：点视频卡片就地预览，播放器 controls 且静音自动播放', async () => {
  const { calls } = installFetch(kindResponder({ media: mediaPayload() }))
  const { KnitBody } = loadClientModule().exports.__test
  harness.reset()
  harness.seed(['', 'time', 'media'])
  let nodes = harness.render(h(KnitBody, { sessionId: 's1' }))
  await harness.flush()
  nodes = harness.render(h(KnitBody, { sessionId: 's1' }))

  byClass(nodes, 'knit-media-card')[1].props.onClick()   // 第二张是视频
  nodes = harness.render(h(KnitBody, { sessionId: 's1' }))
  await harness.flush()
  nodes = harness.render(h(KnitBody, { sessionId: 's1' }))

  const pm = byClass(nodes, 'knit-preview-media')
  assert.equal(pm.length, 1)
  assert.equal(pm[0].type, 'video')
  assert.equal(pm[0].props.controls, true)
  assert.equal(pm[0].props.autoPlay, true)
  assert.equal(pm[0].props.muted, true, '自动播放必须配静音以满足浏览器策略')
  assert.equal(pm[0].props.playsInline, true)
  assert.ok(!calls.some((u) => u.includes('/api/doc')), '视频不应触发正文请求')
})

test('媒体：「全部」分上下两区，文档上限 4、媒体不截断（超 8 个才等比缩小）', async () => {
  installFetch(kindResponder({ all: bigMixedPayload() }))
  const { KnitBody } = loadClientModule().exports.__test
  harness.reset()
  harness.seed(['', 'time', 'all'])
  let nodes = harness.render(h(KnitBody, { sessionId: 's1' }))
  await harness.flush()
  nodes = harness.render(h(KnitBody, { sessionId: 's1' }))

  assert.equal(byExactClass(nodes, 'knit-section').length, 2, '文档区 + 媒体区，上下两区')
  assert.deepEqual(
    byExactClass(nodes, 'knit-section-title').map(textOf),
    ['文档', '图片与视频'],
  )
  assert.equal(byToken(nodes, 'knit-doc').length, 4, '文档区最多 4 条')
  // 载荷里 5 图 + 4 视频 = 9 个媒体；一屏基准是 8，超出的那个不隐藏，改成整块等比缩小
  assert.equal(byToken(nodes, 'knit-media-card').length, 9, '媒体区不截断，9 个全出')
  assert.equal(byExactClass(nodes, 'knit-media-grid in-section').length, 1, '媒体区用分区网格')
  assert.match(byClass(nodes, 'knit-count').map(textOf).join(''), /16 项/, '顶行仍报总数')

  const grid = byExactClass(nodes, 'knit-media-grid in-section')[0]
  // 测试环境没有 ResizeObserver → 量不到宽度 → 走默认面板几何（632px）
  assert.equal(grid.props.style['--knit-media-cell'], '118px', '默认面板下 9 个媒体 → 5 列 118px')
  assert.equal(grid.props.style['--knit-media-label'], 'none', '超 8 个 → 卡片文字让位给缩略图')
  assert.equal(grid.props.style.maxHeight, '246px', '两行 + 一个 gap，超出的交给滚动')
})

test('媒体：不超过 8 个时卡片正常带文件名与时间，不进入等比缩小态', async () => {
  // 1 篇文档 + 5 媒体（正好一屏内）
  const docs = bigMixedPayload().docs.slice(0, 1).concat(
    bigMixedPayload().docs.filter((d) => d.kind !== 'md').slice(0, 5))
  installFetch(kindResponder({ all: mixedPayload({ total: docs.length, docs }) }))
  const { KnitBody } = loadClientModule().exports.__test
  harness.reset()
  harness.seed(['', 'time', 'all'])
  let nodes = harness.render(h(KnitBody, { sessionId: 's1' }))
  await harness.flush()
  nodes = harness.render(h(KnitBody, { sessionId: 's1' }))

  const grid = byExactClass(nodes, 'knit-media-grid in-section')[0]
  assert.equal(grid.props.style['--knit-media-label'], undefined, '不缩小就保留文件名/时间')
  assert.equal(byExactClass(nodes, 'knit-media-meta').length, 5, '5 个媒体都有文字区')
})

test('媒体：「全部」的文档区被截断时给「已显示 / 总数」与「查看全部」，媒体区不截断', async () => {
  installFetch(kindResponder({ all: bigMixedPayload() }))
  const { KnitBody } = loadClientModule().exports.__test
  harness.reset()
  harness.seed(['', 'time', 'all'])
  let nodes = harness.render(h(KnitBody, { sessionId: 's1' }))
  await harness.flush()
  nodes = harness.render(h(KnitBody, { sessionId: 's1' }))

  // 7 篇文档里只显示 4 条；媒体 9 个全显示，所以媒体区没有「已显示 / 总数」
  assert.deepEqual(byExactClass(nodes, 'knit-section-count').map(textOf), ['4 / 7', '9'])
  assert.equal(byExactClass(nodes, 'knit-section-more').length, 1, '只有文档区被截断')
})

test('媒体：「全部」没被截断时不出现「查看全部」，空的一区整个不渲染', async () => {
  // 1 篇文档 + 1 图：都低于上限
  installFetch(kindResponder({ all: mixedPayload({ total: 2, docs: mixedPayload().docs.slice(0, 2) }) }))
  const { KnitBody } = loadClientModule().exports.__test
  harness.reset()
  harness.seed(['', 'time', 'all'])
  let nodes = harness.render(h(KnitBody, { sessionId: 's1' }))
  await harness.flush()
  nodes = harness.render(h(KnitBody, { sessionId: 's1' }))

  assert.equal(byExactClass(nodes, 'knit-section').length, 2)
  assert.equal(byExactClass(nodes, 'knit-section-more').length, 0, '没截断就没有「查看全部」')
  assert.deepEqual(byExactClass(nodes, 'knit-section-count').map(textOf), ['1 / 1', '1'])
})

test('媒体：只有文档时「全部」只出一区，不留空标题', async () => {
  installFetch(kindResponder({ all: mixedPayload({ total: 1, docs: mixedPayload().docs.slice(0, 1) }) }))
  const { KnitBody } = loadClientModule().exports.__test
  harness.reset()
  harness.seed(['', 'time', 'all'])
  let nodes = harness.render(h(KnitBody, { sessionId: 's1' }))
  await harness.flush()
  nodes = harness.render(h(KnitBody, { sessionId: 's1' }))

  assert.equal(byExactClass(nodes, 'knit-section').length, 1)
  assert.deepEqual(byExactClass(nodes, 'knit-section-title').map(textOf), ['文档'])
  assert.equal(byExactClass(nodes, 'knit-media-grid in-section').length, 0)
})

test('媒体：「全部」文档区的「查看全部」点了切到文档分类', async () => {
  const { calls } = installFetch(kindResponder({
    all: bigMixedPayload(), doc: listPayload(), media: mediaPayload(),
  }))
  const { KnitBody } = loadClientModule().exports.__test
  harness.reset()
  harness.seed(['', 'time', 'all'])
  let nodes = harness.render(h(KnitBody, { sessionId: 's1' }))
  await harness.flush()
  nodes = harness.render(h(KnitBody, { sessionId: 's1' }))

  // 媒体区不截断，所以「全部」里只剩文档区那一个「查看全部」
  byExactClass(nodes, 'knit-section-more')[0].props.onClick()
  nodes = harness.render(h(KnitBody, { sessionId: 's1' }))
  await harness.flush()
  nodes = harness.render(h(KnitBody, { sessionId: 's1' }))

  assert.ok(calls.some((u) => u.includes('kind=doc')), `实际: ${calls.join(', ')}`)
  assert.equal(globalThis.window.localStorage.getItem('dsh-knit:kind'), 'doc')
  assert.equal(byExactClass(nodes, 'knit-section').length, 0, '已离开「全部」，不再有分区')
  assert.equal(byExactClass(nodes, 'knit-media-grid').length, 0, '文档视图里没有媒体网格')
})

test('媒体：只有媒体时「全部」的媒体区不截断、也不给「查看全部」', async () => {
  const now = Date.now()
  const docs = Array.from({ length: 9 }, (_, i) => ({
    path: `/p/i${i}.png`, rel: `i${i}.png`, name: `i${i}.png`, title: `图${i}`,
    kind: 'image', summary: '', size: 1024, mtimeMs: now - i * 1000, score: null,
  }))
  installFetch(kindResponder({ all: mixedPayload({ total: docs.length, docs }) }))
  const { KnitBody } = loadClientModule().exports.__test
  harness.reset()
  harness.seed(['', 'time', 'all'])
  let nodes = harness.render(h(KnitBody, { sessionId: 's1' }))
  await harness.flush()
  nodes = harness.render(h(KnitBody, { sessionId: 's1' }))

  assert.equal(byExactClass(nodes, 'knit-section').length, 1, '只有媒体区')
  assert.deepEqual(byExactClass(nodes, 'knit-section-title').map(textOf), ['图片与视频'])
  assert.equal(byExactClass(nodes, 'knit-section-more').length, 0, '媒体区不截断，没有「查看全部」')
  assert.equal(byToken(nodes, 'knit-media-card').length, 9)
})

test('媒体：「全部」的键盘导航只走到分区上限内，不落到被截断的条目', async () => {
  installFetch(kindResponder({ all: bigMixedPayload() }))
  const { KnitBody } = loadClientModule().exports.__test
  harness.reset()
  harness.seed(['', 'time', 'all'])
  let nodes = harness.render(h(KnitBody, { sessionId: 's1' }))
  await harness.flush()
  nodes = harness.render(h(KnitBody, { sessionId: 's1' }))

  const list = byExactClass(nodes, 'knit-list')[0]
  // 上限内共 4 + 6 = 10 条；连按 20 次也不能走到第 11 条
  for (let i = 0; i < 20; i += 1) {
    list.props.onKeyDown({ key: 'ArrowDown', preventDefault() {} })
    nodes = harness.render(h(KnitBody, { sessionId: 's1' }))
    await harness.flush()
  }
  const withCursor = byToken(nodes, 'cursor')
  assert.equal(withCursor.length, 1, '任何时候只有一个条目是 cursor')
  const reached = String(withCursor[0].props['data-knit-rel'] || '')
  assert.ok(!/^d[5-7]\.md$/.test(reached), `不该落到被截断的文档：${reached}`)
})

test('媒体：mediaLayoutFor —— 最少 3 列、一屏 8 个、超过就等比缩小', () => {
  const { mediaLayoutFor, MEDIA_MIN_PX, MEDIA_MAX_ITEMS } = loadClientModule().exports.__test

  assert.equal(MEDIA_MIN_PX, 64, '格子下限是用户定的 64×64')
  assert.equal(MEDIA_MAX_ITEMS, 8, '一屏基准 8 个（4 列 × 2 行）')

  // 一开始的 bug 是「量不到宽度就回落 3 列」，于是默认面板下格子被撑到 200px+
  assert.deepEqual(mediaLayoutFor(0, 4), { columns: 4, cell: 150, scaled: false, maxHeight: null },
    '量不到宽度按默认面板算，不是回落 3 列')

  // 不超一屏：宽度够就固定 4 列满宽；媒体少于 4 个也不缩列，免得一个缩略图独占半屏
  assert.deepEqual(mediaLayoutFor(632, 1), { columns: 4, cell: 150, scaled: false, maxHeight: null },
    '1 个也占 4 列网格里的一格（旧的 3 列回落会让它撑到 204px）')
  assert.equal(mediaLayoutFor(632, 3).columns, 4)
  assert.equal(mediaLayoutFor(632, 4).columns, 4)
  assert.equal(mediaLayoutFor(632, 4).cell, 150, '默认右侧栏 4 列时约 150px，远小于旧的 200px+')
  assert.equal(mediaLayoutFor(632, 8).columns, 4, '8 个仍是 4 列 × 2 行')

  // 超过一屏：不再隐藏，而是加列 + 缩小，两行装下
  const nine = mediaLayoutFor(632, 9)
  assert.equal(nine.columns, 5, '9 个 → 5 列 × 2 行')
  assert.ok(nine.cell < mediaLayoutFor(632, 8).cell, '格子必须比 8 个时更小')
  assert.equal(nine.scaled, true, '进入等比缩小态（卡片文字让位）')
  assert.equal(nine.maxHeight, nine.cell * 2 + 10, '两行 + 一个 gap')

  // 面板再窄也不掉到 1~2 列；够宽时网格绝不横向溢出
  for (const width of [240, 280, 375, 500, 900, 1400]) {
    for (const count of [1, 3, 8, 9, 24]) {
      const layout = mediaLayoutFor(width, count)
      assert.ok(layout.columns >= 3,
        `${width}px / ${count} 个：列数不该低于 3（实际 ${layout.columns}）`)
      assert.ok(layout.columns * layout.cell + (layout.columns - 1) * 10 <= width,
        `${width}px / ${count} 个：网格不能横向溢出`)
    }
  }
  // 极窄面板（连 3 个 64px 都放不下）时守住 3 列、允许轻微横溢 —— 用户明确要「最少 3 个」
  const tiny = mediaLayoutFor(120, 8)
  assert.equal(tiny.columns, 3, '极窄也保 3 列')
  assert.equal(tiny.cell, 64, '格子不再继续缩，守住 64px 可读下限')
})

test('样式：类型切换的选中态不再用品牌色描边，与列表行同一套中性灰填充', async () => {
  const { readFileSync } = await import('node:fs')
  const { fileURLToPath } = await import('node:url')
  const source = readFileSync(fileURLToPath(new URL('../src/client/client.js', import.meta.url)), 'utf8')

  // 用户原话：「选中的时候不用加绿色、蓝色的描边，就跟下面列表一样，选中填充背景灰就可以」
  const rule = source.match(/\.knit-type-btn\.active\{([^}]*)\}/)
  assert.ok(rule, '必须还有 .knit-type-btn.active 这条规则')
  assert.ok(!rule[1].includes('--knit-accent'), `选中态不许再出现品牌色：${rule[1]}`)
  assert.match(rule[1], /background:var\(--dsw-alias-interactive-bg-active/,
    '选中态用 DSH 的中性选中底色，与列表行同一套')
})

test('样式：媒体网格靠 CSS 变量收列数与格子边长，下限与 JS 常量同源', async () => {
  const { readFileSync } = await import('node:fs')
  const { fileURLToPath } = await import('node:url')
  const source = readFileSync(fileURLToPath(new URL('../src/client/client.js', import.meta.url)), 'utf8')

  assert.ok(!source.includes('grid-template-columns:1fr 1fr'), '不能再写死两列')
  assert.ok(!source.includes('minmax(160px,1fr)'), '160px 下限已按用户要求改成 64px')
  // 列数由 JS 算好传进来；前面的 repeat(3,1fr) 是旧内核的兜底，保证「最少 3 列」
  assert.match(source, /grid-template-columns:repeat\(3,1fr\);\s*\n\s*grid-template-columns:repeat\(var\(--knit-media-cols/)
  assert.match(source, /height:var\(--knit-media-cell/)
  assert.match(source, /const MEDIA_MIN_PX = 64/)
  assert.match(source, /const MEDIA_GAP_PX = 10/)
  assert.match(source, /const MEDIA_MAX_ITEMS = 8/)
})

test('样式：交互强调色走 DSH 品牌令牌，源码里不再有硬编码的紫/蓝强调色', async () => {
  const { readFileSync } = await import('node:fs')
  const { fileURLToPath } = await import('node:url')
  const source = readFileSync(fileURLToPath(new URL('../src/client/client.js', import.meta.url)), 'utf8')

  assert.ok(!source.includes('rgba(124,108,240'), '紫色强调色必须清掉')
  assert.ok(!source.includes('rgba(79,140,255'), '另一套硬编码蓝也要清掉')
  assert.match(source, /--knit-accent:var\(--dsw-alias-brand-primary-new-colorprimary-new-color/)
  // 品牌色只留给「正在预览」那一处表达；选中态一律走中性灰（见类型切换那条测试）
  assert.match(source, /\.knit-media-card\.active \.knit-media-thumbbox\{\s*\n\s*border-color:var\(--knit-accent\)/)
})

test('样式：每个 --knit-* 引用都必须有定义或 fallback', async () => {
  const { readFileSync } = await import('node:fs')
  const { fileURLToPath } = await import('node:url')
  const source = readFileSync(fileURLToPath(new URL('../src/client/client.js', import.meta.url)), 'utf8')

  const start = source.indexOf('const CSS = `') + 'const CSS = `'.length
  const css = source.slice(start, source.indexOf('`', start))
  assert.ok(css.length > 1000, 'CSS 块没取到')

  // 定义过的变量（`--knit-x:` 形式）
  const defined = new Set([...css.matchAll(/(--knit-[a-z-]+)\s*:/g)].map((m) => m[1]))

  // 引用时没写 fallback 的，必须自己定义过；
  // 否则 var() 失效 → 整条声明作废（invalid at computed-value time），
  // 界面会静默少一块样式 —— 曾经就这么丢过 `.knit-doc.active` 的背景填充。
  const missing = []
  for (const m of css.matchAll(/var\((--knit-[a-z-]+)\s*(,)?/g)) {
    if (!m[2] && !defined.has(m[1])) missing.push(m[1])
  }

  assert.deepEqual([...new Set(missing)], [],
    '这些变量没定义又没 fallback，会让整条声明失效')
  assert.ok(defined.has('--knit-accent'), '品牌色变量必须定义在 .knit-root 上')
})

test('媒体：点类型按钮切到「图片与视频」会带 kind=media 重拉并记住偏好', async () => {
  const { calls } = installFetch(kindResponder({ doc: listPayload(), media: mediaPayload() }))
  const { KnitBody } = loadClientModule().exports.__test
  harness.reset()
  harness.seed(['', 'time'])
  let nodes = harness.render(h(KnitBody, { sessionId: 's1' }))
  await harness.flush()
  nodes = harness.render(h(KnitBody, { sessionId: 's1' }))

  byClass(nodes, 'knit-type-btn').find((b) => textOf(b) === '图片与视频').props.onClick()
  nodes = harness.render(h(KnitBody, { sessionId: 's1' }))
  await harness.flush()
  nodes = harness.render(h(KnitBody, { sessionId: 's1' }))

  assert.ok(calls.some((u) => u.includes('kind=media')), '切换后应带 kind=media 重拉')
  assert.equal(globalThis.window.localStorage.getItem('dsh-knit:kind'), 'media')
  assert.equal(byClass(nodes, 'knit-media-grid').length, 1)
})

test('媒体：媒体视图一个媒体都没有时给出专属空态', async () => {
  installFetch(kindResponder({ media: mediaPayload({ total: 0, docs: [] }) }))
  const { KnitBody } = loadClientModule().exports.__test
  harness.reset()
  harness.seed(['', 'time', 'media'])
  let nodes = harness.render(h(KnitBody, { sessionId: 's1' }))
  await harness.flush()
  nodes = harness.render(h(KnitBody, { sessionId: 's1' }))
  assert.match(byClass(nodes, 'knit-msg').map(textOf).join(''), /还没有图片或视频/)
})

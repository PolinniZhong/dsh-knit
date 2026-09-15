/**
 * 浏览器半边测试：两个宿主的注册、排序切换、相关度渲染、预览、降级。
 *
 * 跑法：node --test test/
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { loadClientModule, createHarness, byClass, textOf, makeLocale } from './harness.mjs'

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

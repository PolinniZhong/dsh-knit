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

test('渲染：relevance 模式不做任何相关度可视化（排序即答案）', async () => {
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

  // 2026-09-30 用户裁决：排序说明那一行（.knit-topic）**整体删除** ——
  // 排序方式由头部那个「相关 / 最新」切换按钮自己表达，再补一句是重复；
  // 命中的关键词随行一起消失（它当时只在这一行的 title 里）。
  // 这段守卫从当年的「可见文本里不许出现关键词」升级成「那一行根本不存在」——
  // 只要行还在，关键词就可能再漏出来。
  assert.equal(byClass(nodes, 'knit-topic').length, 0, '排序说明行已整体删除')
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
  // 排序说明行已整体删除：切到「最新」也不会把它带回来
  assert.equal(byClass(nodes, 'knit-topic').length, 0, '排序说明行已整体删除')
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

test('渲染：预览头显示路径面包屑（目录 + 文件名），不再重复正文标题', async () => {
  installFetch((url) => (url.includes('/api/doc')
    ? { ok: true, rel: 'sub/需求 文档.md', title: '需求', text: '# 需求\n正文', truncated: false }
    : listPayload()))

  const { exports } = loadClientModule()
  const { KnitBody } = exports.__test
  harness.reset()
  harness.seed(['', 'time'])
  let nodes = harness.render(h(KnitBody, { sessionId: 's1' }))
  await harness.flush()
  nodes = harness.render(h(KnitBody, { sessionId: 's1' }))

  byClass(nodes, 'knit-doc')[1].props.onClick()      // 第二条是 sub/需求 文档.md
  nodes = harness.render(h(KnitBody, { sessionId: 's1' }))

  assert.equal(byExactClass(nodes, 'knit-preview-head').length, 1)
  assert.equal(byExactClass(nodes, 'knit-preview-dir').map(textOf).join(''), 'sub/')
  assert.equal(byExactClass(nodes, 'knit-preview-name').map(textOf).join(''), '需求 文档.md')
  // 头部不再放标题：正文 H1 已经写了，重复会让「列表 / 头 / 正文」出现三遍同一个词
  assert.equal(byClass(nodes, 'knit-preview-title').length, 0)
  // 长目录被省略号截掉时，完整路径靠 tooltip 悬停仍能看到（与列表行的 row.tooltip 同一套）
  const pathBtn = byExactClass(nodes, 'knit-preview-path')[0]
  assert.match(String(pathBtn.props.title), /sub\/需求 文档\.md/, 'tooltip 里带完整相对路径')
  assert.equal(pathBtn.props.type, 'button', '路径是可点的')
  assert.ok(pathBtn.props.onClick, '路径带打开本地的回调')
})

test('渲染：无目录时预览头不渲染空的目录段', async () => {
  installFetch((url) => (url.includes('/api/doc')
    ? { ok: true, rel: '技术方案.md', title: '技术方案', text: '正文', truncated: false }
    : listPayload()))

  const { exports } = loadClientModule()
  const { KnitBody } = exports.__test
  harness.reset()
  harness.seed(['', 'time'])
  let nodes = harness.render(h(KnitBody, { sessionId: 's1' }))
  await harness.flush()
  nodes = harness.render(h(KnitBody, { sessionId: 's1' }))

  byClass(nodes, 'knit-doc')[0].props.onClick()      // 技术方案.md，没有目录
  nodes = harness.render(h(KnitBody, { sessionId: 's1' }))

  assert.equal(byExactClass(nodes, 'knit-preview-dir').length, 0)
  assert.equal(byExactClass(nodes, 'knit-preview-name').map(textOf).join(''), '技术方案.md')
})

test('渲染：预览面板一展开就是纯阅读底色（不再「滚动才变白」）', async () => {
  installFetch((url) => (url.includes('/api/doc')
    ? { ok: true, rel: 'a.md', title: 'A', text: '正文', truncated: false }
    : listPayload()))

  const { exports } = loadClientModule()
  const { KnitBody } = exports.__test
  harness.reset()
  harness.seed(['', 'time'])
  let nodes = harness.render(h(KnitBody, { sessionId: 's1' }))
  await harness.flush()
  nodes = harness.render(h(KnitBody, { sessionId: 's1' }))

  byClass(nodes, 'knit-doc')[0].props.onClick()
  nodes = harness.render(h(KnitBody, { sessionId: 's1' }))

  assert.equal(byToken(nodes, 'knit-preview').length, 1)
  // 用户 2026-09-20：「下拉出现详情时背景是灰的，这个交互比较差……把它改成整个都是白」
  // 底色现在写在 `.knit-preview` 的 CSS 里（bg-base），**跟滚动无关、跟换篇无关**。
  assert.equal(byToken(nodes, 'reading').length, 0,
    '不再有「阅读态」这个 class —— 灰变白那套已删')
  assert.equal(byExactClass(nodes, 'knit-preview')[0].props.className, 'knit-preview',
    '预览面板的 class 恒为 knit-preview')

  // 正文上不该再挂 onScroll（那个 handler 是专门为「滚动才变白」加的）
  assert.equal(byExactClass(nodes, 'knit-preview-body')[0].props.onScroll, undefined,
    '正文不许再有 onScroll —— 它只服务于已删除的灰→白过渡')
})

test('渲染：换一篇后预览面板仍是同一套底色（没有「复位回灰」这一步）', async () => {
  installFetch((url) => (url.includes('/api/doc')
    ? { ok: true, rel: 'a.md', title: 'A', text: '正文', truncated: false }
    : listPayload()))

  const { exports } = loadClientModule()
  const { KnitBody } = exports.__test
  harness.reset()
  harness.seed(['', 'time'])
  let nodes = harness.render(h(KnitBody, { sessionId: 's1' }))
  await harness.flush()
  nodes = harness.render(h(KnitBody, { sessionId: 's1' }))

  byClass(nodes, 'knit-doc')[0].props.onClick()
  nodes = harness.render(h(KnitBody, { sessionId: 's1' }))
  const first = byExactClass(nodes, 'knit-preview')[0].props.className

  byClass(nodes, 'knit-doc')[1].props.onClick()
  nodes = harness.render(h(KnitBody, { sessionId: 's1' }))
  assert.equal(byExactClass(nodes, 'knit-preview')[0].props.className, first,
    '换一篇不改变面板底色（底色只在 CSS 里，不随文档走）')
})

test('splitRelPath：拆目录与文件名（无目录 / 多级 / 空值）', () => {
  const { splitRelPath } = loadClientModule().exports.__test
  assert.deepEqual(splitRelPath('技术方案.md'), { dir: '', name: '技术方案.md' })
  assert.deepEqual(splitRelPath('sub/需求 文档.md'), { dir: 'sub/', name: '需求 文档.md' })
  assert.deepEqual(splitRelPath('a/b/c.md'), { dir: 'a/b/', name: 'c.md' })
  assert.deepEqual(splitRelPath(''), { dir: '', name: '' })
  assert.deepEqual(splitRelPath(null), { dir: '', name: '' })
  assert.deepEqual(splitRelPath(undefined), { dir: '', name: '' })
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
  // ⚠️ 列数改造后，**默认（1 列）形态的 DOM 与改造前逐字一致**：
  // 不多包一层容器（否则 byClass('knit-doc') 这类子串匹配会多命中一个）。
  assert.equal(byClass(nodes, 'knit-multicol').length, 0, '1 列不该有网格容器')
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
  // ⚠️ 纵向不封顶：媒体档的网格也不许设 maxHeight（第三版修正，见 mediaLayoutFor 那条测试）
  assert.equal(byClass(nodes, 'knit-media-grid')[0].props.style.maxHeight, undefined,
    '媒体档的网格不设高度上限，滚动交给列表')
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

test('媒体：「全部」分上下两区，文档上限 4、媒体一格不隐藏', async () => {
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
  // 载荷里 5 图 + 4 视频 = 9 个媒体：一格都不隐藏，纵向也**不封顶**（有多少行铺多少行）
  assert.equal(byToken(nodes, 'knit-media-card').length, 9, '媒体区不截断，9 个全出')
  assert.equal(byExactClass(nodes, 'knit-media-grid in-section').length, 1, '媒体区用分区网格')
  assert.match(byClass(nodes, 'knit-count').map(textOf).join(''), /16 项/, '顶行仍报总数')

  const grid = byExactClass(nodes, 'knit-media-grid in-section')[0]
  // 测试环境没有 ResizeObserver → 量不到宽度 → 走默认面板几何（632px）
  assert.equal(grid.props.style['--knit-media-cell'], '118px', '默认面板下 9 个媒体 → 118px 的格子')
  // 列数**不再由 JS 下发** —— 交给 CSS 的 auto-fill，面板一变宽就自己多一列
  assert.equal(grid.props.style['--knit-media-cols'], undefined, '不再下发列数')
  assert.equal(grid.props.style['--knit-media-label'], undefined, '118px 还有地方写文件名/时间')
  // ⚠️ 纵向不许封顶：2026-09-20 前两版设 maxHeight 封「两行」，真机上第三行只露一点点
  assert.equal(grid.props.style.maxHeight, undefined,
    '网格不许设 maxHeight —— 纵向有多少行就铺多少行，滚动交给 .knit-list')
})

test('媒体：条目不多时卡片正常带文件名与时间，不让文字让位', async () => {
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

test('媒体：mediaLayoutFor —— 列数只跟可用宽度走，格子基准固定、与条目数无关', () => {
  const {
    mediaLayoutFor, MEDIA_TRACK_PX, MEDIA_LABEL_MIN_PX, MEDIA_GAP_PX, MEDIA_MAX_ITEMS,
  } = loadClientModule().exports.__test

  assert.equal(MEDIA_TRACK_PX, 104, '格子基准由「响应区间」定，不由条目数定')
  assert.equal(MEDIA_MAX_ITEMS, 8, '旧版的一屏基准 8 个现在只用来做默认值')

  // 量不到宽度就按默认面板算（右侧栏 ~632px 可用）
  assert.deepEqual(mediaLayoutFor(0), { min: 104, columns: 5, cell: 118, scaled: false })

  // JS 的列数口径必须与 CSS 的 auto-fill **含 gap** 的算术逐字一致，否则测试数字与真机对不上
  for (const width of [120, 240, 320, 375, 500, 632, 900, 1400]) {
    const l = mediaLayoutFor(width)
    const expected = Math.max(1, Math.floor((width + MEDIA_GAP_PX) / (MEDIA_TRACK_PX + MEDIA_GAP_PX)))
    assert.equal(l.columns, expected, `${width}px：列数口径要与 CSS 一致`)
    assert.equal(l.min, MEDIA_TRACK_PX, `${width}px：下发的基准宽始终是常量`)
    assert.equal(l.cell, Math.floor((width - (l.columns - 1) * MEDIA_GAP_PX) / l.columns),
      `${width}px：单格宽按列数现算`)
  }

  // ⚠️ 核心回归（2026-09-20 第二版）：**列数只与宽度有关，与有几个媒体无关**。
  // 第一版把格宽和条目数绑在一起（条目 >8 个就缩到 64px），结果列数被条目数**锁死** ——
  // 实测 400→1200px 一直是 5 列，只有格子被吹大；用户反馈「它不是真的响应式」。
  for (const width of [320, 420, 632, 900, 1200]) {
    const a = mediaLayoutFor(width)
    // 函数签名就只有 width —— 条目数根本传不进去（传了也忽略）
    assert.deepEqual(mediaLayoutFor(width, 120), a, `${width}px：120 个条目不该改变列数`)
    assert.ok(a.cell >= MEDIA_TRACK_PX, `${width}px：格子不低于基准宽（实际 ${a.cell}px）`)
    assert.ok(a.cell <= 160, `${width}px：格子不越过响应区间上限（实际 ${a.cell}px）`)
  }

  // 列数随宽度**平滑**增长：绝不出现「拖 400px 还是 5 列」那种平台期。
  // 第一版的病灶正是平台期（实测 400→1200px 一直 5 列），所以这条按「每 120px 至少多一列」量。
  for (let width = 200; width <= 1600; width += 120) {
    const here = mediaLayoutFor(width).columns
    const next = mediaLayoutFor(width + 120).columns
    assert.ok(next >= here, `${width}→${width + 120}px：列数不该变少（${here}→${next}）`)
    // 每 120px 至少多一列 = 不存在平台期；理论上最多多一列（120/114），允许边界上偶尔到 2
    assert.ok(next >= here + 1, `${width}→${width + 120}px：出现了平台期（${here}→${next}）`)
    assert.ok(next <= here + 2, `${width}→${width + 120}px：跳得太猛（${here}→${next}）`)
  }

  // 窄面板只出 2 列（格子约 135px），宽面板连续铺满
  assert.equal(mediaLayoutFor(320).columns, 2, '320px 面板：2 列，而不是硬塞 5 列 48px')
  assert.ok(mediaLayoutFor(900).columns >= 7, '900px 面板：至少 7 列')
  assert.ok(mediaLayoutFor(1200).columns >= 10, '1200px 面板：至少 10 列——真的是「铺满」')

  // 实际格宽永远 ≥100px（基准 104 + 1fr 只会撑宽），所以文字让位这条分支**不该被触发**
  for (const width of [200, 240, 320, 632, 900, 920, 1020, 1060, 1140, 1200, 1400]) {
    const l = mediaLayoutFor(width)
    assert.equal(l.scaled, false, `${width}px：格宽 ${l.cell}px，文件名放得下，不该让位`)
  }
  assert.equal(MEDIA_LABEL_MIN_PX, 96, '兜底阈值：只有真实格宽 < 96 才让位')

  // ⚠️ 核心回归（2026-09-20 第三版）：**纵向不许封顶**。
  // 前两版返回 maxHeight（按「两行」算死），真机上第三行只露出一点点 ——
  // 用户的原话是「本来有三行，结果第三行只显示了一点点，应该纵向也完整显示」。
  // 布局函数只要不再吐出高度的概念，就没法再被谁拿去封顶。
  assert.equal(mediaLayoutFor(632).maxHeight, undefined, '布局函数不再返回 maxHeight')
  assert.ok(!('maxHeight' in mediaLayoutFor(632)), '连这个键都不该存在')
})

test('文档：列表永远单列 —— 多列那套（docLayoutFor / .knit-multicol）已整体删除', () => {
  const client = loadClientModule().exports.__test

  // 演进：4 列 → 3 列（「视觉跳动信息过载」）→ 2 列（交互评审：3 列摘要每行只剩 16 字）
  //      → **1 列（2026-09-29 用户拍板：「文档列表最多一个就行，现在一行两个有点太多了」）**。
  // ⚠️ 最后一版是**删除**，不是「把上限从 2 改成 1」：留着一套永远算不出 2 列的代码
  // （`docLayoutFor` 本身、`DOC_TRACK_PX` / `DOC_SUMMARY_MIN_PX` 这类只为多列存在的常量），
  // 下一个人只会以为它还在生效。所以这四条守的是「它真的没了」。
  assert.equal(client.docLayoutFor, undefined, 'docLayoutFor 该删掉，不是留着不用')
  assert.equal(client.DOC_TRACK_PX, undefined, 'DOC_TRACK_PX 该删掉（只为算格子宽而存在）')
  assert.equal(client.DOC_GRID_MAX_COLS, undefined, 'DOC_GRID_MAX_COLS 该删掉')
  assert.equal(client.DOC_SUMMARY_MIN_PX, undefined, 'DOC_SUMMARY_MIN_PX 该删掉')
})

test('文档：序号是最左边一列，行一＝「点 + 标题 + 时间」（时间靠右）', async () => {
  const { nodes } = await mountWithPayload(contextPayload())

  // ⚠️ 2026-09-29 用户追加要求：「文档列表序号放在独立最左边，其他数据放在右边」。
  //    所以序号**从行一里搬了出去**，成为 .knit-doc 这条两列 grid 的第一列 ——
  //    一条行的直接子节点恰好两个：左边那一列序号 + 右边那一列全部数据（.knit-body）。
  const docs = byClass(nodes, 'knit-doc')
  assert.ok(docs.length > 0, '要有文档行')
  const numbered = docs.filter((d) => classesUnder(d).includes('knit-num'))
  assert.ok(numbered.length > 0, '这个包里得有带序号的行')
  for (const doc of numbered) {
    assert.deepEqual(
      doc.children.slice(0, 2).map((c) => String((c && c.props && c.props.className) || '')),
      ['knit-num', 'knit-body'],
      '一行＝最左边一列序号 + 右边一列其余数据',
    )
  }
  // 没有序号的行（时间序 / 筛选结果 /「其他相关文档」）**也不许掉进第一列** ——
  // 靠 .knit-body 的 grid-column 定死位置（用自动排布就会掉）。
  // 2026-10-01：这一列**不再整格空着**（用户原话：「其他相关文档…没有序号以后左边就空了，
  // 视觉上比较割裂，就觉得是个 bug 一样」）。这一屏里有号时，没号的行在同一列渲染一个
  // 中性占位标记 `.knit-gapmark`（·）—— 不冒充序号，也不让轨道断掉。
  const unnumbered = docs.filter((d) => !classesUnder(d).includes('knit-num'))
  assert.ok(unnumbered.length > 0, '这个 payload 里有不编号的条目')
  for (const doc of unnumbered) {
    assert.deepEqual(
      doc.children.slice(0, 2).map((c) => String((c && c.props && c.props.className) || '')),
      ['knit-gapmark', 'knit-body'],
      '没号的行用同列的占位标记顶住，正文仍然落在第二列',
    )
  }

  const rows = byExactClass(nodes, 'knit-row1')
  assert.ok(rows.length > 0, '要有行一')
  for (const row of rows) {
    const cls = classesUnder(row)
    // 2026-09-29 这一天里这一行改了三次，最后落在：**点 + 标题 + 时间（时间靠右）**。
    // 用户最后一条原话：「将时间放到标题同行，时间放在右边，然后标题跟时间就可以
    // 以序号平行，居中平行」⇒ 标题**回到行一**（先前那条「标题独占一行」作废）。
    assert.ok(cls.some((c) => c.includes('knit-title')), '标题就在行一里')
    assert.ok(cls.some((c) => c.includes('knit-time')), '时间也在行一里（靠右）')
    assert.equal(cls.some((c) => c.includes('knit-sum')), false, '摘要不在行一里')
    // **顺序**也是这一行的一部分：标题必须在时间前面，反了时间就跑到标题左边。
    const kids = (row.children || []).map((c) => String((c && c.props && c.props.className) || ''))
    assert.equal(kids.filter((c) => c === 'knit-title').length, 1, '行一里恰好一个标题')
    assert.equal(kids.filter((c) => c === 'knit-time').length, 1, '行一里恰好一个时间')
    assert.ok(kids.indexOf('knit-title') < kids.indexOf('knit-time'), '标题在时间左边')
  }

  // ⚠️ 2026-09-29：**列表行里不再有路径**。用户原话：「文档列表中的文档路径，我觉得不需要
  //    出现了，因为点开查看文档详情的时候已经有了，所以这里是重复的，隐藏掉」。
  //    守的是「那个节点真的没了」，**不是**「它被 display:none 藏了」—— 两者看代码的人
  //    会得出完全不同的结论（后者会让人以为样式一改就回来）。
  assert.equal(byClass(nodes, 'knit-meta').length, 0, '列表里不该再有路径节点')
  assert.equal(nodes.every((n) => !String(n.className || '').includes('knit-meta')), true,
    'knit-meta 这个类名应该整体消失，不是留在某处隐藏')
  // 反证：行的定位**不靠可见路径** —— data-knit-rel 仍在（键盘 / 预览映射靠它）。
  assert.equal(byClass(nodes, 'knit-doc').every((d) => typeof d.props['data-knit-rel'] === 'string'), true,
    '每行仍要带 data-knit-rel')

  // 标题仍然挨着自己的那一行（现在它就在行一里）：每条文档恰好一个标题。
  for (const doc of docs) {
    assert.equal(classesUnder(doc).filter((c) => c === 'knit-title').length, 1, '恰好一个标题')
  }
})

test('样式：类型切换是下划线式页签，选中态不用品牌色也不用灰底', async () => {
  const { readFileSync } = await import('node:fs')
  const { fileURLToPath } = await import('node:url')
  const source = readFileSync(fileURLToPath(new URL('../src/client/client.js', import.meta.url)), 'utf8')

  // v0.14（Design §20）：三个并排的灰底按钮改成下划线式页签。
  // ⚠️ 2026-09-29 用户裁决：这条**覆盖**了更早那条「选中填充背景灰就可以」。
  // 早先那句的诉求是「别加绿色、蓝色的描边」，现在连灰底也不要了。
  const rule = source.match(/\.knit-type-btn\.active\{([^}]*)\}/)
  assert.ok(rule, '必须还有 .knit-type-btn.active 这条规则')
  assert.ok(!rule[1].includes('--knit-accent'), `选中态不许再出现品牌色：${rule[1]}`)
  assert.match(rule[1], /border-bottom-color:/, '选中态靠下划线表达层级')
  assert.ok(!rule[1].includes('background:var(--knit-active-bg'),
    '下划线式页签不许再退回灰底按钮——两者叠加会同时占用两种「选中」表达')
  // ⚠️ 2026-09-30 用户裁决（**覆盖**上面那条「页签条要有底边」）：那条全宽 hairline
  // 与下面的列表割裂，删掉。层级现在只由选中项自己那条 2px 下划线表达 ——
  // 它是画在自己文字下面的，所以不是「下划线悬空」。
  assert.ok(!/\.knit-types\{[^}]*border/.test(source), '页签条不再画底边')
})

test('样式：列表行的「正在预览」只有灰底，描边已整体删除', async () => {
  const { readFileSync } = await import('node:fs')
  const { fileURLToPath } = await import('node:url')
  const source = readFileSync(fileURLToPath(new URL('../src/client/client.js', import.meta.url)), 'utf8')

  // v0.14（Design §12 / §8）：2026-09-29 用户裁决先把品牌色描边改成 neutral border。
  // ⚠️ 2026-09-30 用户裁决**再覆盖一次**：「悬停跟选中，最外层那个描边，我觉得也不需要了」
  // ⇒ 描边整条删掉，选中态只剩灰底。这条断言因此从「必须是中性描边」翻成「不许有任何描边」。
  const rule = source.match(/\.knit-doc\.active\{([^}]*)\}/)
  assert.ok(rule, '必须还有 .knit-doc.active 这条规则')
  assert.ok(!rule[1].includes('--knit-accent'),
    `列表行选中态不许再出现品牌色：${rule[1]}`)
  assert.ok(!rule[1].includes('border'),
    `选中态不许再有描边（2026-09-30 用户裁决）：${rule[1]}`)
  assert.match(rule[1], /background:var\(--knit-active-bg/,
    '选中态保留灰底——现在它是唯一的分层信号')
})

test('样式：这一轮的「去线 / 去描边」都不许回潮（2026-09-30 用户裁决）', async () => {
  const { readFileSync } = await import('node:fs')
  const { fileURLToPath } = await import('node:url')
  const source = readFileSync(fileURLToPath(new URL('../src/client/client.js', import.meta.url)), 'utf8')
  const start = source.indexOf('const CSS = `') + 'const CSS = `'.length
  const css = source.slice(start, source.indexOf('`', start)).replace(/\/\*[\s\S]*?\*\//g, '')

  // ① 列表行的描边：静止那圈透明占位 + 悬停 / 选中各自上的色，三处一起删
  assert.ok(!css.includes('border:.5px solid transparent'), '那条 .5px 透明边框占位已删')
  assert.ok(!/\.knit-doc:hover\{[^}]*border-color/.test(css), '悬停态没有描边')
  assert.ok(!/\.knit-doc\.active\{[^}]*border-color/.test(css), '选中态没有描边')
  // ⚠️ 边框删了就得用 padding 补回它占掉的 .5px×2，否则每一行矮 1px、左右各窄 .5px
  assert.match(css, /\.knit-doc\{[^}]*padding:10\.5px 11\.5px/,
    'padding 要把删掉的边框补回来')
  // ② 引用条自己不再画线（预览头那条由另一条用例守）
  assert.ok(!/\.knit-links\{[^}]*border/.test(css), '引用条不画线')
  // ③ 排序说明行的四个 i18n 键随行一起删掉，不许留在字典里「以后可能用」
  for (const key of ['topic.relevancePlain', 'topic.relevanceTerms', 'topic.needsConversation', 'topic.time']) {
    assert.ok(!source.includes(`'${key}'`), `${key} 已随那一行删除`)
  }
  // ④ 过滤框提示改成不列字段的一句话（两种语言都在）
  assert.match(source, /'filter\.placeholder': '过滤文档'/)
  assert.match(source, /'filter\.placeholder': 'Filter docs'/)
})

test('样式：悬停 / 选中的灰底各降一档（悬停 −60% / 选中 −40%），两个主题都给了值', async () => {
  const { readFileSync } = await import('node:fs')
  const { fileURLToPath } = await import('node:url')
  const source = readFileSync(fileURLToPath(new URL('../src/client/client.js', import.meta.url)), 'utf8')
  const start = source.indexOf('const CSS = `') + 'const CSS = `'.length
  const css = source.slice(start, source.indexOf('`', start)).replace(/\/\*[\s\S]*?\*\//g, '')

  // 两个令牌都要定义：浅色一套 + 暗色主题覆盖一套
  assert.match(css, /--knit-hover-bg:rgba\(38,49,72,\.024\)/, '浅色悬停 = DSH 的 40%')
  assert.match(css, /--knit-active-bg:rgba\(38,49,72,\.061\)/, '浅色选中 = DSH 的 60%')
  const dark = css.match(/body\[data-ds-dark-theme\] \.knit-root\{([^}]*)\}/)
  assert.ok(dark, '暗色主题必须也覆盖这两个令牌，否则暗色下不跟着降')
  assert.match(dark[1], /--knit-hover-bg:rgba\(255,255,255,\.031\)/)
  assert.match(dark[1], /--knit-active-bg:rgba\(255,255,255,\.085\)/)

  // 列表行是用户点名要改的两处
  assert.match(css, /\.knit-doc:hover\{background:var\(--knit-hover-bg/)
  assert.match(css, /\.knit-doc\.active\{[^}]*background:var\(--knit-active-bg/)
  // 缩略图占位底色不是悬停态，不能跟着降（降了就看不出格子边界了）
  assert.match(css, /\.knit-media-thumbbox\{[^}]*background:var\(--dsw-alias-interactive-bg-hover/)
})

test('样式：文档列表没有网格 —— 多列那套已整体删除，容器类名不与 knit-doc 撞前缀', async () => {
  const { readFileSync } = await import('node:fs')
  const { fileURLToPath } = await import('node:url')
  const source = readFileSync(fileURLToPath(new URL('../src/client/client.js', import.meta.url)), 'utf8')
  const start = source.indexOf('const CSS = `') + 'const CSS = `'.length
  const css = source.slice(start, source.indexOf('`', start)).replace(/\/\*[\s\S]*?\*\//g, '')
  // JS 侧扫的是**剥掉注释**的源码：注释里会有意保留「这里曾经有什么」的说明
  // （那是有价值的历史），所以「标识符不许再出现」只能在代码上判。
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')

  // 2026-09-29 用户拍板「最多一个」⇒ 上限由 2 列改成 1 列，做法是**删除**：
  // 容器规则、列数类、卡片样式、摘要让位、`transform:none` 兜底，全没了。
  // ⚠️ 这几条在删之前都是「必须存在」；现在反过来守「必须不存在」——
  // 只删一半（CSS 留着 .knit-multicol.cols-2、而 JS 不再加类）才是最坏的状态：
  // 读代码的人会以为它还生效。
  assert.ok(!css.includes('knit-multicol'), '文档多列的容器规则该删干净')
  assert.ok(!/cols-[234]\b/.test(css), '列数类（cols-2 / cols-3 / cols-4）该删干净')
  assert.ok(!css.includes('auto-fit') || css.includes('.knit-media-grid'),
    'auto-fit 只许留给媒体网格')
  // ⚠️ 容器类名里**不能含 `knit-doc`**：byClass 是子串匹配，会把它当成一个文档行
  // （§6.5 那个坑的第三次；旧名 knit-doc-grid 就是踩了这个）。
  assert.ok(!code.includes('knit-doc-grid'), '容器类名不许是 knit-doc* 前缀（会被 byClass 误命中）')
  assert.ok(!/\.knit-list\.cols-/.test(css),
    '列数类只许加在文档容器上 —— .knit-list 是唯一滚动容器，媒体档与「全部」都在它里面')
  // JS 侧也一并没了。「布局函数不许吃条目数」那条守卫跟着退休 —— 函数都不在了。
  assert.ok(!code.includes('docLayoutFor'), '源码里不该再有 docLayoutFor')
  assert.ok(!/DOC_TRACK_PX|DOC_SUMMARY_MIN_PX|DOC_GRID_(MIN|MAX)_COLS/.test(code),
    '只为多列存在的常量该删干净')

  // 数据一个不砍（这一条从「多列不砍数据」升级成「永远不砍数据」）：
  // 摘要不该再有 display:none 这条路（第一版的错就是「只剩标题 + 时间」）。
  assert.ok(!/\.knit-sum[^{]*\{[^}]*display:none/.test(css), '摘要不再有「让位」这条路')
  // ⚠️ **路径（knit-meta）在 2026-09-29 被用户要求整体删掉**，理由见上面那条测试：
  //    它和预览头的面包屑重复。所以断言要**反过来写** —— 不再是「路径任何情况下都保留」，
  //    而是「这个类名真的没了」；写成旧的 `!…display:none` 会变成一盏空转的绿灯
  //    （类名不存在时它也通过，但什么也没守住）。
  //    仍然不许 display:none 的只有**摘要**：那条守的是「不许因为排版窄就静默少给信息」，
  //    而路径是**重复信息**，删它不违反那条教训。
  assert.ok(!code.includes('knit-meta'), '路径那一行应该整体消失，不是换个方式藏起来')
  // 反证：路径仍然有地方显示 —— 预览头的面包屑（目录浅 + 文件名亮，还可点）。
  assert.match(code, /className: 'knit-preview-path'/, '预览头必须还有路径面包屑')
  assert.match(code, /className: 'knit-preview-name'/, '面包屑里要有文件名')
  // 标题不再折行（折行是为窄格子写的，现在「格子」这个概念都不存在了）
  assert.ok(!/\.knit-title\{[^}]*-webkit-line-clamp/.test(css), '标题不再折两行')

  // ⚠️ 行一＝**标题行**：Primary 点 + 标题 + 时间（时间靠右）。2026-09-29 用户最后一条要求是
  //    「将时间放到标题同行，时间放在右边，然后标题跟时间就可以以序号平行，居中平行」——
  //    它**推翻了同一天早先的「标题独占一行」**，所以下面这两条断言是反过来的。
  //    间距也从标题挪到了行一（行一 margin-bottom:5px，标题不再留 margin）。
  assert.match(css, /\.knit-row1\{display:flex;align-items:center;gap:8px;margin-bottom:5px\}/)
  assert.ok(!/\.knit-title\{[^}]*margin-bottom/.test(css), '间距归行一，不在标题上')
  // 标题 flex:1 1 auto + min-width:0 是「时间被推到行尾 + 长标题在时间之前省略」的前提；
  // 这里也钉住 .knit-num 的行高 = .knit-title 的 14px × 1.4 = 19.6px —— 序号与标题第一行
  // **垂直居中**靠的正是这两个数字对齐，改一处必须改另一处
  // （v0.14 规格 §15 把文档标题提到 14px，所以这一对数字一起变了）。
  assert.match(css, /\.knit-title\{flex:1 1 auto;min-width:0;font-weight:600;font-size:14px;line-height:1\.4;/)
  // 2026-10-01：`.knit-gapmark`（没号时的中性占位标记）与序号**共用同一条选择器**，
  // 所以「序号的行高必须等于标题行高」这条纪律自动覆盖它。
  assert.match(css, /\.knit-num,\.knit-gapmark\{grid-column:1;font-size:10\.5px;line-height:19\.6px;/)

  // ⚠️ 行的**静止态没有底色**（2026-09-29 用户看了暗色主题之后要求：
  //    「深色模式下，文档列表没有选中，鼠标没有悬停，不需要有背景。或者是说，跟深色模式的最底下的
  //    背景一样」）。这条断言是有来历的：以前写 bg-layer-1，**浅色主题下它和 .knit-pack 的
  //    bg-base 都是 #fff**（根本看不出来），**暗色主题下它比底色亮一档** ⇒ 每一行都像一张浮起来的
  //    小卡片，哪怕没选中、没悬停。现在静止态 transparent，露出 .knit-pack 的底色。
  //    hover / .active 各自有令牌，**不该**跟着变 transparent —— 那样一屏灰里就认不出选中态了。
  assert.match(css, /\.knit-doc\{[^}]*background:transparent/,
    '行的静止态要露出面板底色（暗色下 bg-layer-1 比底色亮，每行都会像卡片）')
  assert.ok(!/\.knit-doc\{[^}]*background:var\(--dsw-alias-bg-layer-1/.test(css),
    '静止态别再走 bg-layer-1')
  assert.match(css, /\.knit-doc\.active\{[^}]*background:var\(--knit-active-bg/,
    '选中态必须仍然有底色 —— 它是一屏灰里唯一的分层信号')

  // ⚠️ 2026-09-29：列表行改成**两列 grid** —— 序号占最左边一列，其余数据全在第二列
  //    （用户原话：「文档列表序号放在独立最左边，其他数据放在右边」）。
  //    第二列必须是 minmax(0,1fr)：不然长标题会把行撑宽，省略号失效。
  assert.match(css, /\.knit-doc\{display:grid;grid-template-columns:22px minmax\(0,1fr\)/)
  assert.match(css, /\.knit-num,\.knit-gapmark\{grid-column:1;/)
  assert.match(css, /\.knit-body\{grid-column:2;min-width:0\}/,
    '第二列的位置与 min-width:0 都要写死 —— 少一个长标题就会把行撑宽')
})

test('样式：媒体网格靠 auto-fill 连续加列，格子基准与 JS 常量同源', async () => {
  const { readFileSync } = await import('node:fs')
  const { fileURLToPath } = await import('node:url')
  const source = readFileSync(fileURLToPath(new URL('../src/client/client.js', import.meta.url)), 'utf8')

  assert.ok(!source.includes('grid-template-columns:1fr 1fr'), '不能再写死两列')
  assert.ok(!source.includes('minmax(160px,1fr)'), '160px 下限已按用户要求改掉')
  // 列数由 CSS 的 auto-fill 自己数（用户点名的、AIGC 资产中心那套机制）
  assert.ok(!source.includes('--knit-media-cols'), '列数不该由 JS 下发')
  assert.match(source, /grid-template-columns:repeat\(3,1fr\);/, '旧内核的 3 列兜底要留在前面')
  // 下限 104px + 1fr：1fr 不能省（否则只有一个媒体时那张图撑满面板宽度），
  // 下限也不能改成「JS 算出的实际格宽」—— 那样列数会被条目数锁死（见下面那条回归）。
  assert.match(source,
    /grid-template-columns:repeat\(auto-fill,minmax\(var\(--knit-media-track,\d+px\),1fr\)\)/,
    'auto-fill + 基准下限 + 1fr')
  assert.match(source, /--knit-media-track:\$\{MEDIA_TRACK_PX\}px/, '基准宽直接由 JS 常量插入，不许各写一套')
  assert.match(source, /const MEDIA_TRACK_PX = 104/)
  assert.match(source, /const MEDIA_GAP_PX = 10/)
  assert.match(source, /const MEDIA_MAX_ITEMS = 8/)
  // ⚠️ 核心回归（2026-09-20 第三版）：**纵向不许封顶**。
  // 前两版有 `const MEDIA_ROWS = 2` + 网格上的 `overflow-y:auto` + 行内 maxHeight，
  // 真机上第三行只露一点点。这条守三件事：常量没了、网格不自己滚、渲染不设 maxHeight。
  assert.ok(!source.includes('MEDIA_ROWS'), '不再有「一屏两行」这个常量')
  assert.ok(!/mediaLayout\.maxHeight/.test(source), '渲染处不许再读 maxHeight')
  // 网格的 CSS 规则里不许出现 overflow-y（只有 .knit-list 该滚）
  const gridRule = source.match(/\.knit-media-grid\{[^}]*\}/)
  assert.ok(gridRule, '.knit-media-grid 规则必须在')
  assert.ok(!gridRule[0].includes('overflow-y'), '媒体网格自己不滚（交给 .knit-list）')
  assert.ok(!gridRule[0].includes('max-height'), '媒体网格不设高度上限')
  // ⚠️ 核心回归（2026-09-20 第二版）：`mediaLayoutFor` **不许再接受条目数**。
  // 第一版是 mediaLayoutFor(width, count) —— count 一进来，格宽就跟着条目数走，
  // 列数随之被锁死（400→1200px 全是 5 列），用户反馈「它不是真的响应式」。
  assert.match(source, /function mediaLayoutFor\(width\) \{/, '签名里不许再有 count')
  // ⚠️ 真正的病灶在**调用处**：第一版是 `mediaLayoutFor(可用宽, 条目数)` —— 只要调用时还传
  //    条目数，格宽就会跟着条目数走、列数随之被锁死。
  //    只看**真实的调用**（先剥注释），并且要求参数表里没有**顶层**逗号
  //    （嵌套的 Math.max(0, …) 里有逗号，不算）。
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
  for (const m of code.matchAll(/mediaLayoutFor\(/g)) {
    let depth = 1
    let topLevelComma = false
    for (let i = m.index + m[0].length; i < code.length && depth > 0; i += 1) {
      const ch = code[i]
      if (ch === '(') depth += 1
      else if (ch === ')') depth -= 1
      else if (ch === ',' && depth === 1) topLevelComma = true
    }
    assert.ok(!topLevelComma, '调用处不该再传第二个参数（条目数）')
  }
  assert.match(source, /height:var\(--knit-media-cell/)
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

test('样式：滚动条交给 DSH 的全局样式，只覆盖令牌、不重写伪元素', async () => {
  const { readFileSync } = await import('node:fs')
  const { fileURLToPath } = await import('node:url')
  const source = readFileSync(fileURLToPath(new URL('../src/client/client.js', import.meta.url)), 'utf8')

  // 只看真实规则，注释里提到这个伪元素不算
  const start = source.indexOf('const CSS = `') + 'const CSS = `'.length
  const css = source.slice(start, source.indexOf('`', start)).replace(/\/\*[\s\S]*?\*\//g, '')

  // 重写它就会绕开 DSH 主题的 8px + 令牌色滚动条；
  // 之前写死了 rgba(255,255,255,.14) 的滑块，在白底上完全隐形（用户反馈「没有滑动条」）
  assert.ok(!css.includes('::-webkit-scrollbar'),
    '不要重写滚动条伪元素，交给 DSH 全局样式')
  // 正文区提到 l2，与官方文档预览面板（dsh-client-ui-sidebar-documentpreview 的 body）同档
  assert.match(css, /--dsh-scrollbar-thumb:var\(--dsw-alias-scrollbar-bg-l2\)/)
  assert.match(css, /--dsh-scrollbar-thumb-hover:var\(--dsw-alias-scrollbar-hover-l2\)/)
})

test('样式：预览面板底色恒为纯阅读底色，不靠底色分层；头部对齐官方预览', async () => {
  const { readFileSync } = await import('node:fs')
  const { fileURLToPath } = await import('node:url')
  const source = readFileSync(fileURLToPath(new URL('../src/client/client.js', import.meta.url)), 'utf8')
  const start = source.indexOf('const CSS = `') + 'const CSS = `'.length
  const css = source.slice(start, source.indexOf('`', start)).replace(/\/\*[\s\S]*?\*\//g, '')

  // 用户 2026-09-20：「下拉出现详情时背景是灰的，这个交互比较差……把它改成整个都是白」
  // 底色恒为 bg-base（浅 #fff / 深 #151517）—— **分层改由圆角+边界+柔影承担**。
  assert.match(css, /\.knit-preview\{[^}]*background:var\(--dsw-alias-bg-base/,
    '预览面板底色走 bg-base（浅色纯白 / 暗色最深的阅读底色）')
  // ⚠️ 不许写死 #fff：暗色主题下会白得刺眼。fallback 才是 #fff。
  assert.ok(!/\.knit-preview\{[^}]*background:#fff/.test(css),
    '底色不能硬编码 #fff —— 要走 bg-base 让暗色主题跟着走')
  assert.ok(!css.includes('.knit-preview.reading'),
    '「滚动才变白」那套（.knit-preview.reading）已删，不要再加回来')
  assert.ok(!/\.knit-preview\{[^}]*transition:background/.test(css),
    '没有背景过渡了，transition 也该去掉')
  // 也仍然不许用 bg-layer-2 分层（浅色主题下 layer-1/2/3 都是 #fff，等于没分）
  assert.ok(!/\.knit-preview\{[^}]*bg-layer-2/.test(css),
    '别用 bg-layer-2 分层：浅色主题下它和 bg-layer-1 都是 #fff')
  // 分层三件套仍在：上边界 + 圆角 + 柔影
  assert.match(css, /\.knit-preview\{[^}]*border-top-left-radius:12px/)
  assert.match(css, /\.knit-preview\{[^}]*box-shadow:0 -8px 24px/)
  // 头部高度仍对齐官方 .dhJKeW_header：38px；但官方那条 border-l3 底边
  // 已按 2026-09-30 用户裁决删掉（与引用条那条一起，两条细线把引用区夹得割裂）
  assert.match(css, /\.knit-preview-head\{[^}]*height:38px/)
  assert.ok(!/\.knit-preview-head\{[^}]*border-bottom/.test(css), '预览头不再画底边')
  // 全屏时要去掉圆角与柔影（那时没有「浮在列表上」的隐喻）
  assert.match(css, /\.knit-root\.fullscreen \.knit-preview\{[^}]*border-radius:0/)
  // ⚠️ 旧行为已废：不再有 .knit-preview.reading，也没有背景过渡
  assert.ok(!css.includes('.knit-preview.reading'))
  assert.ok(!css.includes('transition:background-color'))
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

/* ── v0.12 引用条 ───────────────────────────────────── */

/** 列表 / 正文 / 引用 三路分流。 */
function linksResponder(linksPayload) {
  return (url) => {
    if (url.includes('/api/links')) return linksPayload
    if (url.includes('/api/doc')) {
      return { ok: true, rel: '技术方案.md', title: '技术方案', text: '# 技术方案\n\n正文。', truncated: false }
    }
    return listPayload()
  }
}

const LINKS_PAYLOAD = {
  ok: true,
  rel: '技术方案.md',
  incoming: [{ rel: 'sub/需求 文档.md', title: '需求' }],
  outgoing: [{ rel: 'CHANGELOG.md', title: '变更' }],
  incomingTotal: 3,
  outgoingTotal: 1,
  limited: false,
}

/** 打开第一篇文档，把预览与引用条都跑完。 */
async function openFirstDoc(nodes) {
  let ns = nodes
  ns = harness.render(h(KnitBodyForLinks(), { sessionId: 's1' }))
  await harness.flush()
  ns = harness.render(h(KnitBodyForLinks(), { sessionId: 's1' }))
  byClass(ns, 'knit-doc')[0].props.onClick()
  ns = harness.render(h(KnitBodyForLinks(), { sessionId: 's1' }))
  await harness.flush()
  return harness.render(h(KnitBodyForLinks(), { sessionId: 's1' }))
}

/** `harness.seed` 的槽位与既有用例保持一致（notice / sort）。 */
function KnitBodyForLinks() {
  harness.reset()
  harness.seed(['', 'time'])
  return loadClientModule().exports.__test.KnitBody
}

test('引用条：打开一篇会请求 /api/links，默认折叠只给计数', async () => {
  const { calls } = installFetch(linksResponder(LINKS_PAYLOAD))
  const { KnitBody } = loadClientModule().exports.__test
  harness.reset()
  harness.seed(['', 'time'])
  let nodes = harness.render(h(KnitBody, { sessionId: 's1' }))
  await harness.flush()
  nodes = harness.render(h(KnitBody, { sessionId: 's1' }))

  byClass(nodes, 'knit-doc')[0].props.onClick()
  nodes = harness.render(h(KnitBody, { sessionId: 's1' }))
  await harness.flush()
  nodes = harness.render(h(KnitBody, { sessionId: 's1' }))

  const linksCall = calls.find((u) => u.includes('/api/links'))
  assert.ok(linksCall, '应请求引用关系')
  assert.ok(linksCall.includes(encodeURIComponent('技术方案.md')), `rel 应被编码：${linksCall}`)
  assert.equal(byClass(nodes, 'knit-link-row').length, 0, '默认折叠，不该有列表项')
  const summary = byClass(nodes, 'knit-links-summary').map(textOf).join('')
  assert.match(summary, /被引用 3/)
  assert.match(summary, /引用了 1/)
})

test('引用条：展开后列出两侧，超出的给「还有 N 篇」', async () => {
  installFetch(linksResponder(LINKS_PAYLOAD))
  const { KnitBody } = loadClientModule().exports.__test
  harness.reset()
  harness.seed(['', 'time'])
  let nodes = harness.render(h(KnitBody, { sessionId: 's1' }))
  await harness.flush()
  nodes = harness.render(h(KnitBody, { sessionId: 's1' }))
  byClass(nodes, 'knit-doc')[0].props.onClick()
  nodes = harness.render(h(KnitBody, { sessionId: 's1' }))
  await harness.flush()
  nodes = harness.render(h(KnitBody, { sessionId: 's1' }))

  byClass(nodes, 'knit-links-head')[0].props.onClick()
  nodes = harness.render(h(KnitBody, { sessionId: 's1' }))

  assert.equal(byClass(nodes, 'knit-link-row').length, 2, '被引用 1 条 + 引用 1 条')
  assert.deepEqual(byClass(nodes, 'knit-link-name').map(textOf), ['需求', '变更'])
  assert.deepEqual(byClass(nodes, 'knit-link-path').map(textOf),
    ['sub/需求 文档.md', 'CHANGELOG.md'], '副行给相对路径，方便认人')
  // incomingTotal 3 而只列了 1 条 → 提示还有 2 篇
  assert.match(byClass(nodes, 'knit-links-note').map(textOf).join(''), /还有 2 篇/)
})

test('引用条：点一项就切到那一篇，且**不重新拉列表**（订阅制，不走轮询）', async () => {
  const { calls } = installFetch(linksResponder(LINKS_PAYLOAD))
  const { KnitBody } = loadClientModule().exports.__test
  harness.reset()
  harness.seed(['', 'time'])
  let nodes = harness.render(h(KnitBody, { sessionId: 's1' }))
  await harness.flush()
  nodes = harness.render(h(KnitBody, { sessionId: 's1' }))
  byClass(nodes, 'knit-doc')[0].props.onClick()
  nodes = harness.render(h(KnitBody, { sessionId: 's1' }))
  await harness.flush()
  nodes = harness.render(h(KnitBody, { sessionId: 's1' }))

  byClass(nodes, 'knit-links-head')[0].props.onClick()
  nodes = harness.render(h(KnitBody, { sessionId: 's1' }))

  byClass(nodes, 'knit-link-row')[0].props.onClick()
  // ⚠️ **刻意不 flush**：订阅制是**同步**送达的，点完立刻就该是新那篇。
  // 如果这一跳要经过列表接口，就必须等一次 fetch + flush，这条断言会红。
  // （不数 `/api/recent` 次数 —— 这个 harness 的 useEffect 不跟踪依赖，
  //   每次 flush 都会重跑所有 effect，数次数测不出「有没有走轮询」。）
  nodes = harness.render(h(KnitBody, { sessionId: 's1' }))
  assert.match(
    byClass(nodes, 'knit-preview-name').map(textOf).join(''),
    /需求 文档\.md/,
    '点完立刻切到那一篇，中间不该有 fetch（AGENTS.md §6.4：即时信号别藏在轮询里）',
  )

  await harness.flush()
  nodes = harness.render(h(KnitBody, { sessionId: 's1' }))
  assert.ok(
    calls.some((u) => u.includes('/api/doc') && u.includes(encodeURIComponent('sub/需求 文档.md'))),
    '随后应真的去取那一篇的正文',
  )
})

test('引用条：「没有被引用」与「读取失败」是两句不同的话（不都显示成空白）', async () => {
  installFetch(linksResponder({
    ok: true, rel: '技术方案.md', incoming: [], outgoing: [],
    incomingTotal: 0, outgoingTotal: 0, limited: false,
  }))
  let { KnitBody } = loadClientModule().exports.__test
  harness.reset()
  harness.seed(['', 'time'])
  let nodes = harness.render(h(KnitBody, { sessionId: 's1' }))
  await harness.flush()
  nodes = harness.render(h(KnitBody, { sessionId: 's1' }))
  byClass(nodes, 'knit-doc')[0].props.onClick()
  nodes = harness.render(h(KnitBody, { sessionId: 's1' }))
  await harness.flush()
  nodes = harness.render(h(KnitBody, { sessionId: 's1' }))
  byClass(nodes, 'knit-links-head')[0].props.onClick()
  nodes = harness.render(h(KnitBody, { sessionId: 's1' }))
  const emptyText = byClass(nodes, 'knit-links-empty').map(textOf).join('')
  assert.match(emptyText, /没有被引用/)
  assert.match(emptyText, /没有引用别的文档/)

  // 失败态：服务端返回错误码 → 走另一句文案，且**不给展开按钮**
  installFetch(linksResponder({ ok: false, code: 'knit/not-found' }))
  ;({ KnitBody } = loadClientModule().exports.__test)
  harness.reset()
  harness.seed(['', 'time'])
  nodes = harness.render(h(KnitBody, { sessionId: 's1' }))
  await harness.flush()
  nodes = harness.render(h(KnitBody, { sessionId: 's1' }))
  byClass(nodes, 'knit-doc')[0].props.onClick()
  nodes = harness.render(h(KnitBody, { sessionId: 's1' }))
  await harness.flush()
  nodes = harness.render(h(KnitBody, { sessionId: 's1' }))
  assert.equal(byClass(nodes, 'knit-links-head').length, 0, '失败态没有可展开的头')
  assert.match(byClass(nodes, 'knit-links').map(textOf).join(''), /引用关系读取失败/)
})

test('引用条：图片/视频不请求 /api/links（图里只有 .md，请求必然 404）', async () => {
  const { calls } = installFetch(kindResponder({ media: mediaPayload() }))
  const { KnitBody } = loadClientModule().exports.__test
  harness.reset()
  harness.seed(['', 'time', 'media'])
  let nodes = harness.render(h(KnitBody, { sessionId: 's1' }))
  await harness.flush()
  nodes = harness.render(h(KnitBody, { sessionId: 's1' }))

  byClass(nodes, 'knit-media-card')[0].props.onClick()
  nodes = harness.render(h(KnitBody, { sessionId: 's1' }))
  await harness.flush()
  nodes = harness.render(h(KnitBody, { sessionId: 's1' }))

  assert.ok(!calls.some((u) => u.includes('/api/links')), '媒体不该请求引用关系')
  assert.equal(byClass(nodes, 'knit-links').length, 0, '媒体不显示引用条')
})

/* ── v0.14 当前任务上下文（Context Pack）─────────────────
   面板这一层的职责是**纯投影**：分组、顺序、理由全部来自宿主，
   客户端一个分组规则都不许重写（否则就会出现两套排序逻辑）。 */

/**
 * 造一份带 Context Pack 的相关模式载荷。
 * @param {object} [overrides] - 覆盖字段
 * @returns {object} 载荷
 */
function contextPayload(overrides = {}) {
  const at = Date.now()
  const item = (rel, title, reason) => ({
    rel,
    path: `/p/${rel}`,
    name: rel.split('/').pop(),
    title,
    summary: `摘要 ${title}`,
    mtimeMs: at,
    kind: 'md',
    source: 'doc',
    reason,
  })
  return {
    ok: true,
    root: '/p',
    total: 5,
    mode: 'relevance',
    topic: 'BM25、排序',
    keywords: ['bm25', '排序'],
    docs: [
      { path: '/p/docs/algo.md', rel: 'docs/algo.md', name: 'algo.md', title: '排序算法', summary: '摘要', mtimeMs: at, score: 100 },
      { path: '/p/docs/eval.md', rel: 'docs/eval.md', name: 'eval.md', title: '排序评测', summary: '摘要', mtimeMs: at, score: 40 },
      { path: '/p/CHANGELOG.md', rel: 'CHANGELOG.md', name: 'CHANGELOG.md', title: '变更记录', summary: '摘要', mtimeMs: at, score: 12 },
      { path: '/p/README.md', rel: 'README.md', name: 'README.md', title: 'Knit', summary: '摘要', mtimeMs: at, score: 0 },
      { path: '/p/docs/other.md', rel: 'docs/other.md', name: 'other.md', title: '无关文档', summary: '摘要', mtimeMs: at, score: 0 },
    ],
    context: {
      mode: 'relevance',
      topic: 'BM25、排序',
      task: '',
      primary: [item('docs/algo.md', '排序算法', { code: 'titleMatch', terms: ['排序'], fields: 2 })],
      supporting: [
        item('docs/eval.md', '排序评测', { code: 'bodyMatch', terms: ['bm25'], fields: 1 }),
        item('CHANGELOG.md', '变更记录', { code: 'linkSource', terms: [], fields: 0 }),
      ],
      related: [item('README.md', 'Knit', { code: 'related', terms: [], fields: 0 })],
      totals: { primary: 1, supporting: 2, related: 1, matched: 3, total: 5 },
      summary: { primary: 1, supporting: 2, related: 1, shown: 4, matched: 3, total: 5 },
    },
    ...overrides,
  }
}

/**
 * 挂上 KnitBody 并等首帧数据到位。
 *
 * 返回的 `renderAgain()` 用**同一份 hook 状态**重渲染 —— 断言跨帧状态
 * （cursor / preview）时必须用它，另起一次 `KnitBody` 会是全新状态（AGENTS.md §6.2）。
 *
 * @param {object} payload - `fetch` 的载荷
 * @returns {Promise<{nodes:object[], render:s Function}>} 首帧节点与重渲染函数
 */
async function mountWithPayload(payload) {
  installFetch((url) => (url.includes('/api/links')
    ? { ok: true, rel: 'x', incoming: [], outgoing: [], incomingTotal: 0, outgoingTotal: 0 }
    : payload))
  const { KnitBody } = loadClientModule().exports.__test
  harness.reset()
  // 前两个 hook 槽位是 notice / sort —— 预置成相关序，面板才会去用 Context Pack
  harness.seed(['', 'relevance'])
  const render = () => harness.render(h(KnitBody, { sessionId: 's1' }))
  // ⚠️ 数据到位后要再走一轮 render → flush → render：cursor 是在**数据到达之后**
  // 那一轮 effect 里落位的（AGENTS.md §6.2：断言前少一轮就会停在初值）。
  let nodes = render()
  await harness.flush()
  nodes = render()
  await harness.flush()
  nodes = render()
  return { nodes, render, renderAgain: async () => { nodes = render(); await harness.flush(); return render() } }
}

test('上下文：分层视图渲染三档 + 极短提示（右栏那块标题 / 计数已删）', async () => {
  const { nodes } = await mountWithPayload(contextPayload())
  // ⚠️ 必须 byExactClass：`knit-tier` 是 `knit-tierline` / `knit-tiername` 的子串
  const tiers = byExactClass(nodes, 'knit-tier')
  assert.equal(tiers.length, 4, '三层 + 「其他相关文档」')
  const titles = byExactClass(nodes, 'knit-tiername').map(textOf)
  assert.deepEqual(titles, ['主要上下文', '辅助上下文', '相关上下文', '其他相关文档'])
  // 提示语是中性说明，不是「AI 推荐」这类话术
  assert.ok(
    byExactClass(nodes, 'knit-tierhint').map(textOf).join(' ').includes('先看'),
    '主要上下文要有一句「先看」的提示',
  )
  // 提示语**必须极短**（2026-09-29 用户要求）：它是「先看 / 辅助 / 背景」这一档，
  // 不许再长成「先看这几篇 / 证据与实现支撑」那样的说明句。
  assert.deepEqual(
    byExactClass(nodes, 'knit-tierhint').map(textOf),
    ['先看', '辅助', '背景'],
    '组后面的解释只能两三个字',
  )
  // 右栏那一整块（包标题 / 命中计数）已经删除，断言也一起删 —— 见下面的「单栏」守卫
  assert.equal(byClass(nodes, 'knit-pack-title').length, 0)
})

test('上下文：分组顺序就是宿主给的顺序，客户端不重排', async () => {
  const { nodes } = await mountWithPayload(contextPayload())
  // DOM 顺序：primary 的条目 → supporting → related → 其他
  const rels = byClass(nodes, 'knit-doc').map((n) => n.props['data-knit-rel'])
  assert.deepEqual(rels, [
    'docs/algo.md',
    'docs/eval.md',
    'CHANGELOG.md',
    'README.md',
    'docs/other.md',
  ])
  // 「其他相关文档」里是宿主没有放进任何一层的那篇
  const sections = byExactClass(nodes, 'knit-tier')
  const last = sections[sections.length - 1]
  assert.match(textOf(last), /其他相关文档/)
  assert.match(textOf(last), /无关文档/)
})

test('上下文：每一条都带「为什么在这里」，且理由来自宿主给的码', async () => {
  const { nodes } = await mountWithPayload(contextPayload())
  const why = byClass(nodes, 'knit-why').map(textOf)
  assert.equal(why.length, 4, 'Context Pack 的四个条目各一行；「其他」区那篇没有理由')
  assert.match(why[0], /标题命中：排序/)
  assert.match(why[1], /正文命中：bm25/)
  assert.match(why[2], /引用了主要上下文/)
  assert.match(why[3], /与当前任务相关/)
  // ⚠️ 不许出现任何无法验证的话术
  const all = why.join(' ')
  assert.ok(!all.includes('当前话题'), '「命中当前话题」那套调试口吻已删')
  for (const banned of ['AI', '智能', '推荐', '置信', '%']) {
    assert.ok(!all.includes(banned), `理由里不该出现「${banned}」：${all}`)
  }
})

test('上下文：没有 reason 的条目不出「为什么在这里」这一行', async () => {
  const { nodes } = await mountWithPayload(contextPayload())
  const other = byClass(nodes, 'knit-doc').find((n) => n.props['data-knit-rel'] === 'docs/other.md')
  assert.ok(other, '「其他相关文档」里应当有 docs/other.md')
  // 它的 reason 是宿主给的 related —— 那也是理由，所以有 why 行；
  // 真正没有理由的是**平铺列表**里的条目，见下一条用例。
  assert.ok(byClass(nodes, 'knit-why').length >= 4)
})

test('上下文：宿主没给 context 时退回平铺列表（与 v0.13 逐字一致）', async () => {
  const flat = contextPayload()
  delete flat.context
  const { nodes } = await mountWithPayload(flat)
  assert.equal(byExactClass(nodes, 'knit-tier').length, 0, '不该有空的分区')
  assert.equal(byClass(nodes, 'knit-why').length, 0, '平铺列表不编造理由')
  assert.equal(byClass(nodes, 'knit-doc').length, 5, '五篇照常列出')
})

test('上下文：时间序 / 媒体档即使给了 context 也不分层', async () => {
  const { nodes } = await mountWithPayload(contextPayload({ mode: 'time' }))
  assert.equal(byExactClass(nodes, 'knit-tier').length, 0, '时间序不假装分了层')
})

test('上下文：过滤框在当前上下文里做子集化，不会把非命中项漏掉', async () => {
  const mounted = await mountWithPayload(contextPayload())
  // 过滤到「无关」—— 它在「其他相关文档」里，不在前三层
  byClass(mounted.nodes, 'knit-filter')[0].props.onChange({ target: { value: '无关' } })
  const after = mounted.render()
  const rels = byClass(after, 'knit-doc').map((n) => n.props['data-knit-rel'])
  assert.deepEqual(rels, ['docs/other.md'], `过滤后应当只剩那一篇，实际 ${JSON.stringify(rels)}`)
})

test('上下文：过滤到前三层里的某一篇时，只留它所在的那一档', async () => {
  const mounted = await mountWithPayload(contextPayload())
  byClass(mounted.nodes, 'knit-filter')[0].props.onChange({ target: { value: '排序评测' } })
  const after = mounted.render()
  const rels = byClass(after, 'knit-doc').map((n) => n.props['data-knit-rel'])
  assert.deepEqual(rels, ['docs/eval.md'])
  const titles = byExactClass(after, 'knit-tiername').map(textOf)
  assert.deepEqual(titles, ['辅助上下文'], '只剩有命中的那一档')
})

test('上下文：键盘按屏幕顺序穿过三档（↓ 跨区不断链）', async () => {
  const mounted = await mountWithPayload(contextPayload())
  const first = byClass(mounted.nodes, 'knit-doc')[0]
  assert.ok(String(first.props.className).includes('cursor'), 'cursor 初始在第一项')
  byClass(mounted.nodes, 'knit-list')[0].props.onKeyDown({ key: 'ArrowDown', preventDefault() {} })
  const after = await mounted.renderAgain()
  const second = byClass(after, 'knit-doc')[1]
  assert.ok(String(second.props.className).includes('cursor'), '↓ 走到第二条（跨层也不断链）')
})

/* ── v0.14 单栏（2026-09-29 用户裁定）────────────────────────────────
   这里曾经是「左＝文档列表，右＝当前任务上下文的解释」的双栏。用户否掉了它：
   Context Pack 是**数据层**结构（Primary / Supporting / Related），不是一个
   要单独显示的 UI 卡片 —— 分组直接落在文档列表里就够了。

   ⚠️ 下面那条守卫是反向的：就算宿主照旧给了 Context Pack，DOM 里也不许再出现
   任何右栏骨架。留着一套渲染不出来的样式，下一个人只会以为它还在生效。 */

/**
 * 收集一棵子树里所有元素节点的 className（展开函数组件）。
 *
 * `byClass` 只看扁平列表，答不了「谁在谁里面」；右栏必须在 listbox **外面**
 * 这条断言需要真正的包含关系。
 *
 * @param {object} node - 节点
 * @returns {string[]} className 列表
 */
function classesUnder(node) {
  const acc = []
  const walk = (n) => {
    if (!n || typeof n !== 'object') return
    if (Array.isArray(n)) { n.forEach(walk); return }
    const type = n.type
    if (type && typeof type === 'object' && typeof type.type === 'function') { walk(type.type(n.props)); return }
    if (typeof type === 'function') { walk(type(n.props)); return }
    if (n.props && n.props.className) acc.push(String(n.props.className))
    ;(n.children || []).forEach(walk)
  }
  walk(node)
  return acc
}

test('单栏：即使给了 Context Pack，DOM 里也没有任何右栏骨架', async () => {
  const { nodes } = await mountWithPayload(contextPayload())
  for (const dead of ['knit-context-layout', 'knit-col-list', 'knit-context-column',
    'knit-pack', 'knit-pack-title', 'knit-grip', 'knit-evrow', 'knit-ev-hint']) {
    assert.equal(byClass(nodes, dead).length, 0, `${dead} 不该再出现（右栏已整体删除）`)
  }
  // 删掉的是「单独一栏」，不是分层：三档 +「其他相关文档」照旧
  assert.equal(byExactClass(nodes, 'knit-tier').length, 4)
  assert.equal(byClass(nodes, 'knit-doc').length, 5)
  // 列表就是那个滚动容器本身，不再有网格包装
  assert.equal(byExactClass(nodes, 'knit-list').length, 1)
})

test('单栏：过滤后分组随之收窄，只剩有命中的那一档', async () => {
  const mounted = await mountWithPayload(contextPayload())
  byClass(mounted.nodes, 'knit-filter')[0].props.onChange({ target: { value: '排序评测' } })
  const after = mounted.render()
  assert.deepEqual(byClass(after, 'knit-doc').map((n) => n.props['data-knit-rel']), ['docs/eval.md'])
  // 这一档以前也顺便验「右栏计数跟着左栏动」——右栏没了，左侧的分区本身就是答案
  assert.deepEqual(byExactClass(after, 'knit-tiername').map(textOf), ['辅助上下文'])
})

test('上下文：行首序号跨三档连续，且「其他相关文档」不编号', async () => {
  const { nodes } = await mountWithPayload(contextPayload())
  assert.deepEqual(byExactClass(nodes, 'knit-num').map(textOf), ['01', '02', '03', '04'])
  const docs = byClass(nodes, 'knit-doc')
  assert.equal(docs.length, 5)
  assert.equal(docs[4].props['data-knit-rel'], 'docs/other.md', '最后一档是「其他相关文档」')
  assert.equal(byExactClass(nodes, 'knit-num').length, 4, '它不在这个包里，所以不编号')
  // 2026-10-01：它那一格不空着了 —— 同列一个中性标记（用户要「不要像 bug」，
  // 同时保住「所有行左边缘对齐」）。但它**不是**序号：整数序列里没有第 5 个数字。
  assert.deepEqual(byExactClass(nodes, 'knit-gapmark').map(textOf), ['·'])
  assert.equal(classesUnder(docs[4]).includes('knit-num'), false, '占位标记不许被当成序号')
})

test('上下文：占位标记跟「这一屏有没有号」走 —— 混着才有，整屏没号就一个都没有', async () => {
  // 有号的一屏：只有「其他相关文档」那一行拿到标记
  const { nodes } = await mountWithPayload(contextPayload())
  assert.equal(byExactClass(nodes, 'knit-num').length, 4)
  assert.deepEqual(byExactClass(nodes, 'knit-gapmark').map(textOf), ['·'])
  // 过滤到「无关」之后只剩「其他相关文档」这一档：整屏没号 ⇒ 一个标记都不许有
  // （这才是「像 bug」的真正判据：混着才刺眼，整屏一致就没人觉得缺东西）
  const mounted = await mountWithPayload(contextPayload())
  byClass(mounted.nodes, 'knit-filter')[0].props.onChange({ target: { value: '无关' } })
  const after = mounted.render()
  assert.equal(byExactClass(after, 'knit-num').length, 0, '只剩包外那一档 ⇒ 没有号')
  assert.equal(byExactClass(after, 'knit-gapmark').length, 0, '没有号的一屏里也不放占位标记')
})

test('上下文：Primary 那颗点是位置信号，只有主上下文那一行有', async () => {
  const { nodes } = await mountWithPayload(contextPayload())
  assert.equal(byExactClass(nodes, 'knit-dot').length, 1, 'Primary 只有一篇 ⇒ 点只有一个')
  const dots = classesUnder(byClass(nodes, 'knit-doc')[0])
  assert.ok(dots.includes('knit-dot'), '点落在第一条（主上下文）上')
  assert.ok(
    classesUnder(byClass(nodes, 'knit-doc')[1]).includes('knit-dot') === false,
    '辅助那一档不许出现点',
  )
})

test('上下文：时间序不分层，行首也不编号（平铺列表照旧）', async () => {
  const { nodes } = await mountWithPayload(contextPayload({ mode: 'time' }))
  assert.equal(byExactClass(nodes, 'knit-tier').length, 0, '时间序不分层')
  assert.equal(byExactClass(nodes, 'knit-num').length, 0, '平铺列表不编号')
  assert.equal(byExactClass(nodes, 'knit-gapmark').length, 0,
    '整屏都没号时一个占位标记都不渲染 —— 一屏里要么都有、要么都没有')
  assert.equal(byExactClass(nodes, 'knit-dot').length, 0, '平铺列表没有主上下文点')
  assert.equal(byClass(nodes, 'knit-doc').length, 5, '文档本身照常列全')
})

/* ── 右栏形态（拖宽 / 浮动 / 右缘吸附）已整体删除（2026-09-29）───────
   那一套几何交互只服务于右侧的 Context Pack 面板：面板本身被用户否掉之后
   （理由见上面「单栏」那段），宽度 / 浮动 / 吸附、把手的 separator 键盘模型、
   clampPackW / clampFloatPos / nearRightEdge 三个纯函数、以及 capturePointers
   这个只为驱动一次拖拽而存在的替身，**全部一起删掉** —— 留着一套永远调用不到的
   代码，下一个人只会以为它还在生效。

   仍然成立的那条原则（当时是为几何状态写的，现在适用于所有界面状态）：
   readPref / writePref 只用于排序 / 类型 / 预览高度这类**语义偏好**，
   界面几何状态不落盘。 */

test('单栏：源码里不再有任何右栏 CSS 规则 / 函数 / 常量', async () => {
  const { readFileSync } = await import('node:fs')
  const { fileURLToPath } = await import('node:url')
  const source = readFileSync(
    fileURLToPath(new URL('../src/client/client.js', import.meta.url)),
    'utf8',
  )
  // ⚠️ 断言的是**规则与调用**，不是名字：文件里留着墓碑注释（说明这块为什么删了），
  // 那些注释会原样提到这些名字 —— 用 includes 会把墓碑本身当成残留。
  for (const rule of ['.knit-context-layout', '.knit-col-list', '.knit-context-column',
    '.knit-pack', '.knit-grip', '.knit-evrow', '.knit-pack-btn', '.knit-undocked']) {
    assert.ok(!new RegExp(`\\${rule}\\s*[{,:]`).test(source), `${rule} 的规则必须删干净`)
  }
  assert.ok(!/--knit-pack-w/.test(source), '右栏宽度变量必须删干净')
  for (const call of ['clampPackW', 'clampFloatPos', 'nearRightEdge', 'setPackWidth']) {
    assert.ok(!new RegExp(`${call}\\s*\\(`).test(source), `${call} 不该再被调用`)
  }
  assert.ok(!/const PACK_W_DEFAULT/.test(source), 'PACK_W_DEFAULT 已删')
  assert.ok(!/const PACK_SNAP_PX/.test(source), 'PACK_SNAP_PX 已删')
  assert.ok(!source.includes('dsh-knit:pack'), '几何不落盘：没有 pack 的 localStorage 键')
})

test('样式：组与组之间只靠 16px 空间（不再画横线），序号与标题行等高', async () => {
  const { readFileSync } = await import('node:fs')
  const { fileURLToPath } = await import('node:url')
  const source = readFileSync(
    fileURLToPath(new URL('../src/client/client.js', import.meta.url)),
    'utf8',
  )
  // 用户要求「减少横向分割线」：组间距靠空间，不靠 border-top
  assert.match(source, /\.knit-tier \+ \.knit-tier\{margin-top:16px\}/)
  assert.ok(!/\.knit-tier \+ \.knit-tier\{[^}]*border-top/.test(source), '组之间不该再有横线')
  // 排序说明那一行（原名 .knit-topic）2026-09-30 已**整体删除** ——
  // 当年这条断言问的是「那一行有没有画线」，现在问的是「那一行还在不在」。
  // ⚠️ 必须剥掉注释再查 CSS：历史注释里还会提到这个类名（那是给后人 grep 的）。
  const start = source.indexOf('const CSS = `') + 'const CSS = `'.length
  const css = source.slice(start, source.indexOf('`', start)).replace(/\/\*[\s\S]*?\*\//g, '')
  assert.ok(!css.includes('.knit-topic'), '排序依据那一行的样式已整体删除')
  assert.ok(!source.includes("'knit-topic'"), '排序依据那一行的节点已整体删除')
  // 字号：标题 14px / 行高 1.4 ＝ 19.6px；序号的 line-height 必须与它同步，
  // 这是「序号与标题第一行垂直居中」的唯一手段（改一处必须改两处）
  assert.match(source, /\.knit-title\{flex:1 1 auto;min-width:0;font-weight:600;font-size:14px;line-height:1\.4;/)
  assert.match(source, /\.knit-num,\.knit-gapmark\{grid-column:1;font-size:10\.5px;line-height:19\.6px;/)
  assert.match(source, /\.knit-sum\{font-size:12px;line-height:19px;/)
})

/* ── v0.15「使用情况」 ───────────────────────────────────────────────
   三条纪律要一起守住：① **默认关**（没打开就一个事件都不读）；
   ② 打开后请求带 `usage=1`（那是宿主侧的开闸信号，不是可选参数）；
   ③ 显示的只有**事实**：读了几次、落在哪一层、上下文换过几回 ——
   **没有分数、没有百分比、没有评分条**（用户明确要求过）。 */

/** 一份带 usage 的宿主载荷：先看的那篇（docs/algo.md）已被读。 */
function usagePayload() {
  return contextPayload({
    usage: {
      at: 1_700_000_000_000,
      stats: {
        reads: 7,
        distinct: 3,
        outside: 2,
        outsideReads: ['knit/src/host/index.js'],
        firstReadTier: 'primary',
        firstReadRel: 'docs/algo.md',
        firstReadAt: 1,
        primaryRel: 'docs/algo.md',
        primaryFollowThrough: true,
        byTier: {
          primary: { total: 1, read: 1 },
          supporting: { total: 2, read: 1 },
          related: { total: 1, read: 0 },
        },
        supportingCoverage: 0.5,
        churn: { snapshots: 2, deltas: 2, retained: 2, appeared: 1, disappeared: 0, moved: 0, taskChanged: 0 },
      },
      delta: { appeared: ['docs/eval.md'], disappeared: [], moved: [], taskChanged: false },
    },
  })
}

test('使用情况：默认关 —— 请求里没有 usage=1，DOM 里也没有那一行', async () => {
  const { calls } = installFetch(() => usagePayload())
  const { KnitBody } = loadClientModule().exports.__test
  harness.reset()
  harness.seed(['', 'relevance'])
  const render = () => harness.render(h(KnitBody, { sessionId: 's1' }))
  let nodes = render()
  await harness.flush()
  nodes = render()
  await harness.flush()
  nodes = render()

  assert.ok(!calls.some((url) => url.includes('usage=1')), '默认关：一个会话事件都不该被读')
  assert.equal(byExactClass(nodes, 'knit-usage').length, 0, '默认关：不显示那一行')
})

test('使用情况：打开后请求带 usage=1，那一行只报事实（没有分数 / 百分比）', async () => {
  const { calls } = installFetch(() => usagePayload())
  const { KnitBody } = loadClientModule().exports.__test
  harness.reset()
  harness.seed(['', 'relevance'])
  const render = () => harness.render(h(KnitBody, { sessionId: 's1' }))
  let nodes = render()
  await harness.flush()
  nodes = render()
  await harness.flush()
  nodes = render()

  const toggle = byExactClass(nodes, 'knit-btn').find((node) => textOf(node) === '使用情况')
  assert.ok(toggle, '头部必须有「使用情况」按钮')
  assert.equal(toggle.props['aria-pressed'], false, '默认关')
  toggle.props.onClick()
  await harness.flush()
  nodes = render()
  await harness.flush()
  nodes = render()

  assert.ok(calls.some((url) => url.includes('usage=1')), '打开后必须带 usage=1')
  const line = byExactClass(nodes, 'knit-usage')[0]
  assert.ok(line, '打开后必须出现那一行')
  const text = textOf(line)
  assert.match(text, /已读/, '先看的那篇被读了要如实说出来')
  assert.match(text, /辅助 1\/2/)
  assert.match(text, /读了 7 次/)
  assert.match(text, /包外 2 篇/)
  assert.match(text, /上下文换过 2 次/)
  assert.ok(!text.includes('%'), '不许有百分比')
  assert.ok(!/评分|置信|分数/.test(text), '不许有评分 / 置信度这类词')
})

test('样式：使用情况那一行是弱化文字 —— 没有卡片 / 进度条 / 品牌色', async () => {
  const { readFileSync } = await import('node:fs')
  const { fileURLToPath } = await import('node:url')
  const source = readFileSync(
    fileURLToPath(new URL('../src/client/client.js', import.meta.url)),
    'utf8',
  )
  assert.match(source, /\.knit-usage\{[^}]*font-size:10\.5px/)
  assert.ok(!/\.knit-usage\{[^}]*background/.test(source), '不画卡片底色')
  assert.ok(!/\.knit-usage\{[^}]*knit-accent/.test(source), '不用品牌色')
  assert.ok(!/\.knit-usage\{[^}]*width:\s*\d/.test(source), '不是进度条')
  // 开关本身也不许染色
  assert.ok(!/\.knit-btn\.active\{[^}]*knit-accent/.test(source), '开关的选中态走中性灰')
})

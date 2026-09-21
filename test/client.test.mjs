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

test('文档：docLayoutFor —— 默认 1 列，宽了最多 2 列，字段一个不少', () => {
  const client = loadClientModule().exports.__test
  const { docLayoutFor, DOC_TRACK_PX, DOC_GRID_MAX_COLS, DOC_SUMMARY_MIN_PX, MEDIA_GAP_PX } = client

  assert.equal(DOC_TRACK_PX, 205, '格子下限由「2–3 列时摘要还放得下」反推（150px 会让 632px 排到 4 列）')
  // 演进：4 列 → 3 列（「视觉跳动信息过载」）→ 2 列（交互评审：3 列摘要每行只剩 16 字）
  assert.equal(DOC_GRID_MAX_COLS, 2, '上限 2 列 —— 3 列摘要每行只剩 16 个汉字，读不下去')
  assert.equal(DOC_SUMMARY_MIN_PX, 185)

  // 默认（量不到宽度）→ 1 列，与改造之前逐字一致
  assert.deepEqual(docLayoutFor(0),
    { columns: 1, cell: 0, compact: false, summary: true }, '量不到宽度 = 默认一列')
  // ⚠️ 「默认一个文档一行」是用户的明确要求 —— 窄面板绝不能自己变多列
  for (const w of [0, 120, 200, 300, 400]) {
    assert.equal(docLayoutFor(w).columns, 1, `${w}px：窄面板必须还是 1 列`)
    assert.equal(docLayoutFor(w).compact, false, `${w}px：1 列不是多列态`)
  }

  // 列数单调不减、封顶 4 列；断点用实测值钉住（基准 205px + gap 10）
  let prev = 1
  for (let w = 100; w <= 2000; w += 50) {
    const { columns } = docLayoutFor(w)
    assert.ok(columns >= prev, `${w}px：列数不该回落（${prev}→${columns}）`)
    assert.ok(columns <= DOC_GRID_MAX_COLS, `${w}px：不许超过 4 列`)
    prev = columns
  }
  assert.equal(docLayoutFor(2000).columns, 2, '再宽也停在 2 列')
  assert.equal(docLayoutFor(419).columns, 1, '419px 可用宽还是 1 列')
  assert.equal(docLayoutFor(420).columns, 2, '420px → 2 列')
  assert.equal(docLayoutFor(616).columns, 2, '632px 面板（可用 616px）→ 2 列')
  assert.equal(docLayoutFor(635).columns, 2, '635px 也只有 2 列（不再有第 3 列）')
  assert.equal(docLayoutFor(1400).columns, 2, '1400px 也只有 2 列')

  // ⚠️ 核心约束：**compact 与列数同源**（不能出现「排了 2 列但还是 1 列的样子」）
  for (let w = 100; w <= 2000; w += 25) {
    const { columns, compact } = docLayoutFor(w)
    assert.equal(compact, columns > 1, `${w}px：compact 必须 == (columns > 1)`)
  }
  // 与 mediaLayoutFor 同一套算术（含 gap），再按 4 列封顶
  for (const w of [200, 420, 616, 900, 1400]) {
    assert.equal(docLayoutFor(w).columns,
      Math.min(DOC_GRID_MAX_COLS,
        Math.max(1, Math.floor((w + MEDIA_GAP_PX) / (DOC_TRACK_PX + MEDIA_GAP_PX)))),
      `${w}px：文档列数口径要与媒体同一套算术（2 列封顶）`)
  }

  // ⚠️ 用户第二次修正的核心：**多列时字段一个不少** —— 摘要在任何可达的列数下都保留
  // （205px 下限 + 4 列上限 ⇒ 最窄的格子也有 ~217px，摘要放得下）。
  // `summary:false` 只是兜底分支，留给将来调窄基准宽的情况。
  for (let w = 100; w <= 2000; w += 5) {
    const { columns, cell, summary } = docLayoutFor(w)
    if (columns === 1) continue
    assert.ok(cell >= DOC_SUMMARY_MIN_PX,
      `${w}px / ${columns} 列：格子 ${cell}px 应该仍然放得下摘要`)
    assert.equal(summary, true, `${w}px / ${columns} 列：摘要不该被砍（用户否掉了「只剩标题+时间」）`)
  }
  // 兜底分支本身必须能用：格子真的窄到放不下时，摘要让位
  assert.equal(docLayoutFor(420).summary, true, '2 列 205px 格：摘要保留')
  assert.equal(docLayoutFor(400).summary, true, '1 列时摘要永远在')
})

test('样式：类型切换的选中态不再用品牌色描边，与列表行同一套中性灰填充', async () => {
  const { readFileSync } = await import('node:fs')
  const { fileURLToPath } = await import('node:url')
  const source = readFileSync(fileURLToPath(new URL('../src/client/client.js', import.meta.url)), 'utf8')

  // 用户原话：「选中的时候不用加绿色、蓝色的描边，就跟下面列表一样，选中填充背景灰就可以」
  const rule = source.match(/\.knit-type-btn\.active\{([^}]*)\}/)
  assert.ok(rule, '必须还有 .knit-type-btn.active 这条规则')
  assert.ok(!rule[1].includes('--knit-accent'), `选中态不许再出现品牌色：${rule[1]}`)
  // 中性灰用的是「降档后的」那一套（用户觉得 DSH 默认档太灰），但仍然是中性色
  assert.match(rule[1], /background:var\(--knit-active-bg/,
    '选中态用中性选中底色，与列表行同一套')
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

test('样式：文档多列只有 2 列一档显式轨道，容器类名不与 knit-doc 撞前缀', async () => {
  const { readFileSync } = await import('node:fs')
  const { fileURLToPath } = await import('node:url')
  const source = readFileSync(fileURLToPath(new URL('../src/client/client.js', import.meta.url)), 'utf8')
  const start = source.indexOf('const CSS = `') + 'const CSS = `'.length
  const css = source.slice(start, source.indexOf('`', start)).replace(/\/\*[\s\S]*?\*\//g, '')

  // 列数由 JS 算好、只下发 cols-2 这一个类（**不写 auto-fit**）：写 auto-fit 就变成
  // 「几列」会有两套算法（容器一个、卡片样式一个），而多列样式是按类生效的，必然对不上。
  assert.match(css, /\.knit-multicol\.cols-2\{display:grid/)
  assert.match(css, /\.knit-multicol\.cols-2\{[^}]*grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/)
  // ⚠️ 上限 2 列：3 列与 4 列的样式都该是死代码，不许留在 CSS 里
  assert.ok(!/\.knit-multicol\.cols-3/.test(css), '上限是 2 列，不该再有 cols-3 的样式')
  assert.ok(!/\.knit-multicol\.cols-4/.test(css), '上限是 2 列，不该再有 cols-4 的样式')
  assert.ok(!/\.knit-multicol[^{]*auto-fit/.test(css), '文档多列不许用 auto-fit')
  // ⚠️ 容器类名里**不能含 `knit-doc`**：byClass 是子串匹配，会把它当成一个文档行
  // （§6.5 那个坑的第三次；旧名 knit-doc-grid 就是踩了这个）。
  assert.ok(!/knit-doc-grid/.test(source), '容器类名不许是 knit-doc* 前缀（会被 byClass 误命中）')
  assert.ok(!/\.knit-list\.cols-/.test(css),
    '列数类只许加在文档容器上 —— .knit-list 是唯一滚动容器，媒体档与「全部」都在它里面')

  // ⚠️ **多列不砍数据**（用户第二次修正的核心）：摘要只有 `.no-sum` 那条兜底规则能藏，
  // 路径**任何情况下都不许藏**（第一版的错就是「多列只剩标题 + 时间」）。
  assert.match(css, /\.knit-multicol\.no-sum \.knit-sum\{display:none\}/,
    '摘要只由 no-sum 兜底规则让位')
  assert.ok(!/\.knit-multicol\.cols-[234] \.knit-sum[^{]*\{[^}]*display:none/.test(css),
    '不许再按列数直接藏摘要（那正是「多列只剩标题+时间」那个被否掉的写法）')
  assert.ok(!/\.knit-multicol[^{]*\.knit-meta[^{]*\{[^}]*display:none/.test(css),
    '路径在多列时也必须保留')
  // 标题折两行、路径折两行
  assert.match(css, /-webkit-line-clamp:2/)
  assert.match(css, /\.knit-multicol\.cols-2 \.knit-meta\{[^}]*-webkit-line-clamp:2/)

  // ⚠️ 布局函数不许吃条目数（与 mediaLayoutFor 同一条规矩）。先剥注释再扫真实调用。
  assert.match(source, /function docLayoutFor\(width\) \{/, 'docLayoutFor 只接受 width')
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
  for (const m of code.matchAll(/docLayoutFor\(/g)) {
    let depth = 1
    let topLevelComma = false
    for (let i = m.index + m[0].length; i < code.length && depth > 0; i += 1) {
      if (code[i] === '(') depth += 1
      else if (code[i] === ')') depth -= 1
      else if (code[i] === ',' && depth === 1) topLevelComma = true
    }
    assert.ok(!topLevelComma, 'docLayoutFor 的调用处不该传第二个参数')
  }
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
  // 头部对齐官方 .dhJKeW_header：38px + border-l3
  assert.match(css, /\.knit-preview-head\{[^}]*height:38px/)
  assert.match(css, /\.knit-preview-head\{[^}]*border-bottom:\.5px solid var\(--dsw-alias-border-l3/)
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

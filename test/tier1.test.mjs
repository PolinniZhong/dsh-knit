/**
 * 第一梯队测试：相对路径图片、预览高度与全屏、键盘导航、过滤框。
 *
 * 跑法：node --test test/
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { loadClientModule, createHarness, byClass, byExactClass, textOf } from './harness.mjs'

const harness = createHarness()
const React = globalThis.__knitReact
const h = React.createElement

/** 预览面板本体（整段匹配，避免命中 head/body/title 等子串）。 */
const panelOf = (nodes) => byExactClass(nodes, 'knit-preview')

/* ── 共用脚手架 ─────────────────────────────────────── */

/**
 * 造一份列表载荷。
 * @param {object} overrides - 覆盖字段
 * @returns {object} 载荷
 */
function listPayload(overrides = {}) {
  return {
    ok: true,
    root: '/p',
    total: 3,
    mode: 'time',
    topic: '',
    docs: [
      { path: '/p/技术方案.md', rel: '技术方案.md', name: '技术方案.md', title: '技术方案', summary: '架构拆分', mtimeMs: Date.now() - 60000, score: null },
      { path: '/p/docs/竞品分析.md', rel: 'docs/竞品分析.md', name: '竞品分析.md', title: '竞品分析', summary: '对比 Cursor', mtimeMs: Date.now() - 9e7, score: null },
      { path: '/p/docs/guide.md', rel: 'docs/guide.md', name: 'guide.md', title: 'Guide', summary: 'usage', mtimeMs: Date.now() - 1e8, score: null },
    ],
    ...overrides,
  }
}

/**
 * 装一个 fetch 替身。
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

/**
 * 渲染到列表加载完成。
 * @param {object} comp - 组件
 * @param {object} props - 入参
 * @param {Array} seed - 预置的 useState 初值
 * @returns {Promise<{nodes: object[], renderAgain: Function}>} 节点与重渲染函数
 */
async function mount(comp, props, seed) {
  harness.reset()
  if (seed) harness.seed(seed)
  let nodes = harness.render(h(comp, props))
  await harness.flush()
  nodes = harness.render(h(comp, props))
  return {
    nodes,
    /**
     * 重渲染。`flush: true` 时先渲染一次把新状态的 effect 登记上，再执行它们，
     * 最后渲染出新结果 —— 顺序不能反，否则 effect 根本还没被登记就跑了个空。
     * @param {boolean} flush - 是否执行 effect
     * @returns {Promise<object[]>} 扁平节点
     */
    renderAgain: async (flush = false) => {
      let next = harness.render(h(comp, props))
      if (flush) {
        await harness.flush()
        next = harness.render(h(comp, props))
      }
      return next
    },
  }
}

/**
 * 按 className 取第一个节点的文本。
 * @param {object[]} nodes - 扁平节点
 * @param {string} cls - class 子串
 * @returns {string} 文本
 */
function textByClass(nodes, cls) {
  const hit = byClass(nodes, cls)[0]
  return hit ? textOf(hit) : ''
}

/* ── 1. 相对路径图片 ───────────────────────────────── */

test('resolveRelative：同目录 / 子目录 / 上级目录', () => {
  const { exports } = loadClientModule()
  const { resolveRelative } = exports.__test

  assert.equal(resolveRelative('技术方案.md', './img/a.png'), 'img/a.png')
  assert.equal(resolveRelative('技术方案.md', 'img/a.png'), 'img/a.png')
  assert.equal(resolveRelative('docs/guide.md', './img/a.png'), 'docs/img/a.png')
  assert.equal(resolveRelative('docs/guide.md', '../assets/b.png'), 'assets/b.png')
  assert.equal(resolveRelative('a/b/c.md', '../../x.png'), 'x.png')
  assert.equal(resolveRelative('docs/guide.md', 'img/../pic/a.png'), 'docs/pic/a.png')
})

test('resolveRelative：网络地址 / 锚点 / 协议相对一律不接管', () => {
  const { exports } = loadClientModule()
  const { resolveRelative } = exports.__test

  assert.equal(resolveRelative('a.md', 'https://x.com/y.png'), '')
  assert.equal(resolveRelative('a.md', 'http://x.com/y.png'), '')
  assert.equal(resolveRelative('a.md', 'data:image/png;base64,AAAA'), '')
  assert.equal(resolveRelative('a.md', 'file:///tmp/x.png'), '')
  assert.equal(resolveRelative('a.md', '#anchor'), '')
  assert.equal(resolveRelative('a.md', '//cdn.x.com/y.png'), '')
  assert.equal(resolveRelative('a.md', '   '), '')
})

test('resolveRelative：去掉查询串与 hash', () => {
  const { exports } = loadClientModule()
  const { resolveRelative } = exports.__test
  assert.equal(resolveRelative('docs/g.md', './img/a.png?v=2'), 'docs/img/a.png')
  assert.equal(resolveRelative('docs/g.md', './img/a.png#frag'), 'docs/img/a.png')
})

test('pathImagesFor：返回同源相对地址，带正确的编码', () => {
  const { exports } = loadClientModule()
  const { pathImagesFor } = exports.__test

  const resolver = pathImagesFor('s-1', 'docs/需求 文档.md')
  assert.equal(typeof resolver.resolve, 'function', 'pathImages 必须是带 resolve 的对象')
  assert.equal(
    resolver.resolve('./img/图 1.png'),
    '/knit/api/raw?sessionId=s-1&rel=docs%2Fimg%2F%E5%9B%BE%201.png',
  )
  assert.equal(resolver.resolve('https://x.com/y.png'), undefined, '网络图片不接管')
})

test('渲染：把 pathImages 传给 MarkdownText', async () => {
  installFetch((url) => (url.includes('/api/doc')
    ? { ok: true, rel: 'docs/guide.md', title: 'Guide', text: '![](./img/a.png)', truncated: false }
    : listPayload()))

  const { exports, markdownCalls } = loadClientModule()
  const { KnitBody } = exports.__test
  const { nodes, renderAgain } = await mount(KnitBody, { sessionId: 's1' }, ['', 'time'])
  byClass(nodes, 'knit-doc')[2].props.onClick()
  const after = await renderAgain(true)

  assert.ok(markdownCalls.length >= 1, '应渲染 MarkdownText')
  const passed = markdownCalls.at(-1).pathImages
  assert.ok(passed && typeof passed.resolve === 'function', 'pathImages 必须传下去')
  assert.equal(passed.resolve('./img/a.png'), '/knit/api/raw?sessionId=s1&rel=docs%2Fimg%2Fa.png')
  assert.equal(panelOf(after).length, 1)
})

/* ── 2. 预览高度与全屏 ─────────────────────────────── */

test('clampRatio：夹在 20%–80%，非法值回落默认', () => {
  const { exports } = loadClientModule()
  const { clampRatio, MIN_RATIO, MAX_RATIO } = exports.__test

  assert.equal(clampRatio(0.5), 0.5)
  assert.equal(clampRatio(0.05), MIN_RATIO)
  assert.equal(clampRatio(0.95), MAX_RATIO)
  assert.equal(clampRatio('abc'), 0.46)
  assert.equal(clampRatio(NaN), 0.46)
})

test('渲染：预览高度接到 maxHeight 上，且拖拽条存在', async () => {
  installFetch((url) => (url.includes('/api/doc')
    ? { ok: true, rel: '技术方案.md', title: '技术方案', text: '# T', truncated: false }
    : listPayload()))

  const { exports } = loadClientModule()
  const { KnitBody } = exports.__test
  const { nodes, renderAgain } = await mount(KnitBody, { sessionId: 's1' }, ['', 'time'])
  byClass(nodes, 'knit-doc')[0].props.onClick()
  const after = await renderAgain()

  const panel = panelOf(after)[0]
  assert.ok(panel, '应有预览面板')
  assert.equal(panel.props.style.maxHeight, '46%', '默认高度应接到 maxHeight')
  assert.equal(byClass(after, 'knit-resize').length, 1, '应有拖拽条')
})

test('渲染：全屏切换后藏掉列表、去掉拖拽条、面板不再限高', async () => {
  installFetch((url) => (url.includes('/api/doc')
    ? { ok: true, rel: '技术方案.md', title: '技术方案', text: '# T', truncated: false }
    : listPayload()))

  const { exports } = loadClientModule()
  const { KnitBody } = exports.__test
  const { nodes, renderAgain } = await mount(KnitBody, { sessionId: 's1' }, ['', 'time'])
  byClass(nodes, 'knit-doc')[0].props.onClick()
  let after = await renderAgain()

  const fullBtn = byClass(after, 'knit-btn').find((n) => textOf(n) === '全屏')
  assert.ok(fullBtn, '应有「全屏」按钮')
  fullBtn.props.onClick()

  after = await renderAgain()
  const root = byClass(after, 'knit-root')[0]
  assert.ok(String(root.props.className).includes('fullscreen'), '根节点应带 fullscreen')
  assert.equal(byClass(after, 'knit-resize').length, 0, '全屏时不该有拖拽条')
  assert.equal(panelOf(after)[0].props.style, undefined, '全屏时不再限高')
})

test('渲染：拖拽回调存在且可调用，不抛错', async () => {
  installFetch((url) => (url.includes('/api/doc')
    ? { ok: true, rel: '技术方案.md', title: '技术方案', text: '# T', truncated: false }
    : listPayload()))

  const { exports } = loadClientModule()
  const { KnitBody } = exports.__test
  const { nodes } = await mount(KnitBody, { sessionId: 's1' }, ['', 'time'])
  byClass(nodes, 'knit-doc')[0].props.onClick()
  harness.render(h(KnitBody, { sessionId: 's1' }))
  const after = harness.render(h(KnitBody, { sessionId: 's1' }))

  const handle = byClass(after, 'knit-resize')[0]
  assert.equal(typeof handle.props.onPointerDown, 'function')
  // 没有真实 window 事件系统，至少不能因为缺 clientY 而崩
  assert.doesNotThrow(() => handle.props.onPointerDown({
    preventDefault() {},
    clientY: 300,
  }))
})

/* ── 3. 键盘导航 ───────────────────────────────────── */

/**
 * 造一个键盘事件。
 * @param {string} key - 键名
 * @returns {object} 事件
 */
function keyEvent(key) {
  return { key, defaultPrevented: false, preventDefault() { this.defaultPrevented = true } }
}

/**
 * 取列表容器节点。
 * @param {object[]} nodes - 扁平节点
 * @returns {object} 列表节点
 */
function listNode(nodes) {
  return byClass(nodes, 'knit-list')[0]
}

test('键盘：↓ 移动选中项并即时预览', async () => {
  const docCalls = []
  installFetch((url) => {
    if (url.includes('/api/doc')) {
      docCalls.push(decodeURIComponent(url.split('rel=')[1]))
      return { ok: true, rel: 'x', title: 'x', text: '# x', truncated: false }
    }
    return listPayload()
  })

  const { exports } = loadClientModule()
  const { KnitBody } = exports.__test
  let { nodes, renderAgain } = await mount(KnitBody, { sessionId: 's1' }, ['', 'time'])

  // 初次渲染后 cursor 落在第一项
  nodes = await renderAgain(true)
  let docs = byClass(nodes, 'knit-doc')
  assert.ok(String(docs[0].props.className).includes('cursor'), 'cursor 应落在第一项')

  listNode(nodes).props.onKeyDown(keyEvent('ArrowDown'))
  nodes = await renderAgain(true)
  docs = byClass(nodes, 'knit-doc')
  assert.ok(String(docs[1].props.className).includes('cursor'), '↓ 后 cursor 应到第二项')
  assert.ok(docCalls.includes('docs/竞品分析.md'), '↓ 应即时拉取第二项正文')
  assert.equal(panelOf(nodes).length, 1, '应打开预览')
})

test('键盘：↑ 到顶停住，不循环', async () => {
  installFetch((url) => (url.includes('/api/doc')
    ? { ok: true, rel: 'x', title: 'x', text: '# x', truncated: false }
    : listPayload()))

  const { exports } = loadClientModule()
  const { KnitBody } = exports.__test
  const mounted = await mount(KnitBody, { sessionId: 's1' }, ['', 'time'])
  let nodes = await mounted.renderAgain(true)

  listNode(nodes).props.onKeyDown(keyEvent('ArrowUp'))
  nodes = await mounted.renderAgain(true)
  assert.ok(String(byClass(nodes, 'knit-doc')[0].props.className).includes('cursor'), '↑ 到顶应停住')
})

/* ── 1.5 多列键盘导航（P0 修复的守卫） ───────────────
   真实列数要靠 ResizeObserver 量，测试环境量不到 → 永远是 1 列。
   所以这里**直接测纯函数**，让多列分支真的被跑到（否则又是一盏空转的绿灯）。 */

test('键盘：nextIndexFor —— 多列时 ←→ 跨行，且到行首/行尾停住不回绕', () => {
  const { nextIndexFor } = loadClientModule().exports.__test
  const at = (i, key, cols) => nextIndexFor(i, key, 5, cols)

  // 单列：只认 ↑↓（←→ 不该悄悄改变行为，返回 -1 表示「这个键我不处理」）
  assert.equal(at(0, 'ArrowDown', 1), 1)
  assert.equal(at(0, 'ArrowUp', 1), 0, '↑ 到顶停住')
  assert.equal(at(4, 'ArrowDown', 1), 4, '↓ 到底停住')
  assert.equal(at(2, 'ArrowLeft', 1), -1, '单列不认 ←（避免挡掉宿主/输入框）')
  assert.equal(at(2, 'ArrowRight', 1), -1, '单列不认 →')
  assert.equal(at(2, 'a', 1), -1, '无关的键一律不处理')

  // 2 列：0 1 / 2 3 / 4。←→ 只在本行内移动
  assert.equal(at(0, 'ArrowRight', 2), 1, '0 → 1')
  assert.equal(at(1, 'ArrowRight', 2), 1, '行尾再按 → 停住（不回绕到下一行）')
  assert.equal(at(1, 'ArrowLeft', 2), 0, '1 → 0')
  assert.equal(at(0, 'ArrowLeft', 2), 0, '行首再按 ← 停住（不跳到上一行末尾）')
  assert.equal(at(2, 'ArrowRight', 2), 3)
  assert.equal(at(3, 'ArrowRight', 2), 3, '末行不满时 → 停在最后一个')
  assert.equal(at(4, 'ArrowRight', 2), 4, '末行只有一项')
  assert.equal(at(4, 'ArrowLeft', 2), 4, '末行只有一项时 ← 也停住')
  // ↑↓ 是「相邻项」= 视觉上横向走（DOM 顺序即阅读顺序）
  assert.equal(at(0, 'ArrowDown', 2), 1, '2 列时 ↓ 视觉上是往右走')
  assert.equal(at(1, 'ArrowDown', 2), 2, '再 ↓ 落到下一行行首')

  // Home / End 与列数无关
  assert.equal(at(3, 'Home', 2), 0)
  assert.equal(at(1, 'End', 2), 4)

  // 没有光标（index < 0）时按第 0 项算；空列表返回 -1
  assert.equal(nextIndexFor(-1, 'ArrowDown', 5, 2), 1)
  assert.equal(nextIndexFor(-1, 'ArrowUp', 5, 2), 0)
  assert.equal(nextIndexFor(0, 'ArrowDown', 0, 2), -1, '空列表不处理')
})

test('可访问性（listbox）：容器指向 activedescendant，选项带 role/aria-selected', async () => {
  const docCalls = []
  installFetch((url) => {
    if (url.includes('/api/doc')) {
      docCalls.push(decodeURIComponent(url.split('rel=')[1]))
      return { ok: true, rel: 'x', title: 'x', text: '# x', truncated: false }
    }
    return listPayload()
  })

  const { KnitBody } = loadClientModule().exports.__test
  let { nodes, renderAgain } = await mount(KnitBody, { sessionId: 's1' }, ['', 'time'])
  nodes = await renderAgain(true)

  const list = listNode(nodes)
  assert.equal(list.props.role, 'listbox')
  const active = list.props['aria-activedescendant']
  assert.ok(active, '容器必须给出 aria-activedescendant')

  const docs = byClass(nodes, 'knit-doc')
  assert.equal(docs.length, 3)
  for (const doc of docs) {
    assert.equal(doc.props.role, 'option', '每个选项都要 role="option"（否则读不出「N 项中的第 i 项」）')
    assert.ok(doc.props.id, '每个选项要有 id，才能被 aria-activedescendant 指到')
  }
  // 指向的 id 必须真的在列表里（不然辅助技术指到一个不存在的节点）
  const ids = docs.map((d) => d.props.id)
  assert.ok(ids.includes(active), `aria-activedescendant=${active} 必须是真实存在的选项 id`)
  // 光标项 = aria-activedescendant 指向的那一项
  const cursorNode = docs.find((d) => String(d.props.className).includes('cursor'))
  assert.ok(cursorNode, '初次渲染 cursor 应落在第一项')
  assert.equal(cursorNode.props.id, active, 'activedescendant 必须指向光标那一项')

  // aria-selected 表达的是**正在预览**（不是光标）：没预览时全为 false
  assert.equal(docs.filter((d) => d.props['aria-selected'] === 'true').length, 0,
    '没打开预览时不该有 aria-selected=true')

  // 按 Enter 打开预览 → 那一项变成 aria-selected=true，且仍然只有一项
  list.props.onKeyDown(keyEvent('Enter'))
  nodes = await renderAgain(true)
  const after = byClass(nodes, 'knit-doc')
  const selected = after.filter((d) => d.props['aria-selected'] === 'true')
  assert.equal(selected.length, 1, '打开预览后恰好一项 aria-selected=true')
  assert.equal(selected[0].props.id, cursorNode.props.id, '选中的就是当前那一项')
})

test('可访问性：选项 id 由 rel 稳定推导（同一篇跨渲染不变，中文/空格也合法）', () => {
  const { docOptionId } = loadClientModule().exports.__test
  const a = { rel: '01_ Knit PRD/Knit_SDD-v0.12-链接解析.md' }
  assert.equal(docOptionId(a), docOptionId(a), '同一篇必须每次都得到同一个 id')
  assert.notEqual(docOptionId(a), docOptionId({ rel: '01_ Knit PRD/别的.md' }))
  assert.match(docOptionId(a), /^[A-Za-z0-9_-]+$/, 'id 只能是合法字符（会进 HTML 属性与选择器）')
  assert.ok(docOptionId(a).length <= 120, 'id 不该过长')
  // 折叠后可能撞车的两篇，靠哈希区分
  assert.notEqual(docOptionId({ rel: 'a b/c.md' }), docOptionId({ rel: 'a_b/c.md' }),
    '折叠字符相同的两篇不能拿到同一个 id')
})

test('键盘：Esc 收起预览', async () => {
  installFetch((url) => (url.includes('/api/doc')
    ? { ok: true, rel: 'x', title: 'x', text: '# x', truncated: false }
    : listPayload()))

  const { exports } = loadClientModule()
  const { KnitBody } = exports.__test
  const mounted = await mount(KnitBody, { sessionId: 's1' }, ['', 'time'])
  let nodes = await mounted.renderAgain(true)

  nodes = await mounted.renderAgain(true)
  byClass(nodes, 'knit-doc')[0].props.onClick()
  nodes = await mounted.renderAgain()
  assert.equal(panelOf(nodes).length, 1, '先打开预览')

  const event = keyEvent('Escape')
  listNode(nodes).props.onKeyDown(event)
  nodes = await mounted.renderAgain()
  assert.equal(panelOf(nodes).length, 0, 'Esc 应收起预览')
  assert.equal(event.defaultPrevented, true)
})

test('键盘：Enter 切换预览', async () => {
  installFetch((url) => (url.includes('/api/doc')
    ? { ok: true, rel: 'x', title: 'x', text: '# x', truncated: false }
    : listPayload()))

  const { exports } = loadClientModule()
  const { KnitBody } = exports.__test
  const mounted = await mount(KnitBody, { sessionId: 's1' }, ['', 'time'])
  let nodes = await mounted.renderAgain(true)

  listNode(nodes).props.onKeyDown(keyEvent('Enter'))
  nodes = await mounted.renderAgain()
  assert.equal(panelOf(nodes).length, 1, 'Enter 应打开预览')

  listNode(nodes).props.onKeyDown(keyEvent('Enter'))
  nodes = await mounted.renderAgain()
  assert.equal(panelOf(nodes).length, 0, '再按 Enter 应收起')
})

test('键盘：列表为空时按键不报错', async () => {
  installFetch(() => listPayload({ docs: [], total: 0 }))
  const { exports } = loadClientModule()
  const { KnitBody } = exports.__test
  const mounted = await mount(KnitBody, { sessionId: 's1' }, ['', 'time'])
  const nodes = await mounted.renderAgain(true)
  assert.doesNotThrow(() => listNode(nodes).props.onKeyDown(keyEvent('ArrowDown')))
})

/* ── 4. 过滤框 ─────────────────────────────────────── */

test('过滤：输入即缩小列表并显示命中计数', async () => {
  installFetch(() => listPayload())
  const { exports } = loadClientModule()
  const { KnitBody } = exports.__test
  const mounted = await mount(KnitBody, { sessionId: 's1' }, ['', 'time'])
  let nodes = await mounted.renderAgain(true)

  assert.equal(byClass(nodes, 'knit-doc').length, 3, '初始 3 篇')
  assert.equal(textByClass(nodes, 'knit-count'), '3 篇')

  const input = byClass(nodes, 'knit-filter')[0]
  assert.ok(input, '应有过滤输入框')
  input.props.onChange({ target: { value: '竞品' } })
  nodes = await mounted.renderAgain()

  assert.equal(byClass(nodes, 'knit-doc').length, 1, '应只剩竞品分析')
  assert.equal(textByClass(nodes, 'knit-count'), '1 / 3 篇', '应显示命中计数')
})

test('过滤：能按摘要和路径匹配，大小写不敏感', async () => {
  installFetch(() => listPayload())
  const { exports } = loadClientModule()
  const { KnitBody } = exports.__test
  const mounted = await mount(KnitBody, { sessionId: 's1' }, ['', 'time'])
  let nodes = await mounted.renderAgain(true)

  const input = byClass(nodes, 'knit-filter')[0]

  input.props.onChange({ target: { value: 'cursor' } })
  nodes = await mounted.renderAgain()
  assert.equal(byClass(nodes, 'knit-doc').length, 1, '摘要里的 Cursor 应大小写不敏感命中')

  input.props.onChange({ target: { value: 'docs/' } })
  nodes = await mounted.renderAgain()
  assert.equal(byClass(nodes, 'knit-doc').length, 2, '路径片段应命中')
})

test('过滤：无命中时给出明确空态，且不影响宿主请求', async () => {
  const { calls } = installFetch(() => listPayload())
  const { exports } = loadClientModule()
  const { KnitBody } = exports.__test
  const mounted = await mount(KnitBody, { sessionId: 's1' }, ['', 'time'])
  let nodes = await mounted.renderAgain(true)
  const before = calls.length

  byClass(nodes, 'knit-filter')[0].props.onChange({ target: { value: 'zzzz' } })
  nodes = await mounted.renderAgain()

  assert.equal(byClass(nodes, 'knit-doc').length, 0)
  assert.match(textByClass(nodes, 'knit-msg'), /没有匹配/)
  assert.equal(calls.length, before, '过滤是纯客户端的，不该重新请求宿主')
})

test('过滤：输入框里按 Esc 清空', async () => {
  installFetch(() => listPayload())
  const { exports } = loadClientModule()
  const { KnitBody } = exports.__test
  const mounted = await mount(KnitBody, { sessionId: 's1' }, ['', 'time'])
  let nodes = await mounted.renderAgain(true)

  const input = byClass(nodes, 'knit-filter')[0]
  input.props.onChange({ target: { value: '竞品' } })
  nodes = await mounted.renderAgain()
  assert.equal(byClass(nodes, 'knit-doc').length, 1)

  let stopped = false
  input.props.onKeyDown({ key: 'Escape', stopPropagation() { stopped = true } })
  nodes = await mounted.renderAgain()
  assert.equal(byClass(nodes, 'knit-doc').length, 3, 'Esc 应清空过滤')
  assert.equal(stopped, true, '应阻止冒泡到列表的键盘处理')
})

test('过滤：过滤掉当前 cursor 后 cursor 落回第一项', async () => {
  installFetch((url) => (url.includes('/api/doc')
    ? { ok: true, rel: 'x', title: 'x', text: '# x', truncated: false }
    : listPayload()))
  const { exports } = loadClientModule()
  const { KnitBody } = exports.__test
  const mounted = await mount(KnitBody, { sessionId: 's1' }, ['', 'time'])
  let nodes = await mounted.renderAgain(true)

  // cursor 移到第三项
  listNode(nodes).props.onKeyDown(keyEvent('ArrowDown'))
  nodes = await mounted.renderAgain(true)
  listNode(nodes).props.onKeyDown(keyEvent('ArrowDown'))
  nodes = await mounted.renderAgain(true)
  assert.ok(String(byClass(nodes, 'knit-doc')[2].props.className).includes('cursor'))

  // 过滤掉它
  byClass(nodes, 'knit-filter')[0].props.onChange({ target: { value: '技术' } })
  nodes = await mounted.renderAgain(true)
  assert.equal(byClass(nodes, 'knit-doc').length, 1)
  assert.ok(String(byClass(nodes, 'knit-doc')[0].props.className).includes('cursor'), 'cursor 应落回唯一剩下的那项')
})

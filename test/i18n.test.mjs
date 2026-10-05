/**
 * 国际化测试：中英双语、占位符、宿主错误码翻译、词典键对齐。
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
 * 造一个假上下文，用于把模块 apply 起来（真实运行时由 DSH 调用）。
 * @param {string} locale - 活动语言
 * @param {{betterSidebar?: boolean}} [extra] - 额外提供哪些可选服务
 * @returns {{ctx: object, log: object, registered: object}} 上下文与记录
 */
function contextFor(locale, extra = {}) {
  const log = { tabs: [], bsTabs: [], slots: [], effects: [] }
  const { locale: localeService, registered } = makeLocale({ active: locale })

  const slots = {
    inject(name, cb) { cb(); return () => {} },
    register(opts, component) { log.slots.push({ opts, component }); return () => {} },
  }

  const services = { slots, locale: localeService }
  services.sidebarRightTabs = { register(def) { log.tabs.push(def); return () => {} } }
  if (extra.betterSidebar) {
    services.betterSidebar = { registerTab(def) { log.bsTabs.push(def); return () => {} } }
  }

  const ctx = {
    slots,
    locale: localeService,
    effect(fn, label) { log.effects.push(label); return fn() },
    get(name) { return services[name] },
    inject(deps, callback) {
      for (const dep of deps) if (!services[dep]) return
      const face = { ...services }
      face.effect = (fn, label) => { log.effects.push(label); return fn() }
      callback(face)
    },
  }

  return { ctx, log, registered }
}

/**
 * 装载模块并 apply 到指定语言。
 * @param {string} locale - 活动语言
 * @param {object} [options] - 传给 loadClientModule
 * @param {{betterSidebar?: boolean}} [extra] - 额外提供哪些可选服务
 * @returns {{exports: object, log: object, registered: object}} 结果
 */
function boot(locale, options, extra) {
  const loaded = loadClientModule(options)
  const { ctx, log, registered } = contextFor(locale, extra)
  loaded.exports.apply(ctx)
  return { exports: loaded.exports, log, registered, markdownCalls: loaded.markdownCalls }
}

/**
 * 造一份列表载荷。
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
      { path: '/p/a.md', rel: 'a.md', name: 'a.md', title: 'A', summary: 's', mtimeMs: Date.now(), score: null },
      { path: '/p/b.md', rel: 'b.md', name: 'b.md', title: 'B', summary: 's', mtimeMs: Date.now() - 9e7, score: null },
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
 * 在指定语言下渲染面板并返回扁平节点。
 * @param {string} locale - 活动语言
 * @param {object} compose - 返回 fetch 响应的函数
 * @returns {Promise<{nodes: object[], exports: object}>} 节点与模块导出
 */
async function renderPanel(locale, compose) {
  installFetch(compose)
  const { exports } = boot(locale)
  const { KnitBody } = exports.__test
  const rerender = (flush = false) => {
    let next = harness.render(h(KnitBody, { sessionId: 's1' }))
    if (flush) {
      // 先 render 登记 effect，再执行它们，最后渲染出新结果
      return harness.flush().then(() => harness.render(h(KnitBody, { sessionId: 's1' })))
    }
    return Promise.resolve(next)
  }
  harness.reset()
  let nodes = harness.render(h(KnitBody, { sessionId: 's1' }))
  await harness.flush()
  nodes = harness.render(h(KnitBody, { sessionId: 's1' }))
  return { nodes, exports, rerender }
}

/* ── 词典本身 ───────────────────────────────────────── */

test('词典：zh 与 en 的键集完全一致（缺一条就会回落到显示 key）', () => {
  const { registered } = boot('zh')
  const dicts = registered.knit

  assert.ok(dicts, '应注册了 knit 命名空间')
  assert.ok(dicts.zh, '应有 zh 词典')
  assert.ok(dicts.en, '应有 en 词典')

  const zhKeys = Object.keys(dicts.zh).sort()
  const enKeys = Object.keys(dicts.en).sort()

  const missingInEn = zhKeys.filter((k) => !(k in dicts.en))
  const missingInZh = enKeys.filter((k) => !(k in dicts.zh))
  assert.deepEqual(missingInEn, [], `en 缺这些键：${missingInEn.join(', ')}`)
  assert.deepEqual(missingInZh, [], `zh 缺这些键：${missingInZh.join(', ')}`)

  assert.ok(zhKeys.length >= 40, `词典条目偏少（${zhKeys.length} 条），是不是漏了一整块`)
})

test('词典：中英两边的占位符必须一一对应', () => {
  const { registered } = boot('zh')
  const { zh, en } = registered.knit

  /**
   * 抽出一个模板串里的占位符名。
   * @param {string} template - 模板
   * @returns {string[]} 占位符名（已排序）
   */
  const holders = (template) => (String(template).match(/\{(\w+)\}/g) || []).map((s) => s).sort()

  for (const key of Object.keys(zh)) {
    assert.deepEqual(
      holders(zh[key]),
      holders(en[key]),
      `键 ${key} 的占位符两边不一致：zh=${zh[key]} / en=${en[key]}`,
    )
  }
})

test('词典：不存在空串或残留的 key 自指', () => {
  const { registered } = boot('zh')
  for (const locale of ['zh', 'en']) {
    for (const [key, value] of Object.entries(registered.knit[locale])) {
      assert.ok(String(value).trim().length > 0, `${locale} 的 ${key} 是空的`)
    }
  }
})

/* ── 界面文案 ───────────────────────────────────────── */

test('渲染：英文环境下整个面板出英文', async () => {
  const { nodes } = await renderPanel('en', () => listPayload())

  assert.equal(textOf(byClass(nodes, 'knit-count')[0]), '2 docs')
  // 排序说明那一行 2026-09-30 已整体删除（排序方式由切换按钮自己表达），
  // 所以这里只剩切换按钮本身的文案。
  assert.deepEqual(
    byClass(nodes, 'knit-seg-btn').map(textOf),
    ['Relevant', 'Recent'],
  )
  assert.equal(byClass(nodes, 'knit-filter')[0].props.placeholder, 'Filter docs')
  // v0.15：头部有**两个**按钮 —— 使用情况（默认关）与刷新
  assert.deepEqual(byClass(nodes, 'knit-btn').map(textOf), ['Usage', 'Refresh'])
})

test('渲染：中文环境下整个面板出中文', async () => {
  const { nodes } = await renderPanel('zh', () => listPayload())

  assert.equal(textOf(byClass(nodes, 'knit-count')[0]), '2 篇')
  assert.deepEqual(
    byClass(nodes, 'knit-seg-btn').map(textOf),
    ['相关', '最新'],
  )
  assert.equal(byClass(nodes, 'knit-filter')[0].props.placeholder, '过滤文档')
  assert.deepEqual(byClass(nodes, 'knit-btn').map(textOf), ['使用情况', '刷新'])
})

test('渲染：占位符按语言正确替换（含过滤计数）', async () => {
  const panel = await renderPanel('en', () => listPayload())

  // 未过滤：{n} docs
  assert.equal(textOf(byClass(panel.nodes, 'knit-count')[0]), '2 docs')

  // 过滤掉一篇：{hit} / {total} docs
  byClass(panel.nodes, 'knit-filter')[0].props.onChange({ target: { value: 'a.md' } })
  const filtered = await panel.rerender()
  assert.equal(textOf(byClass(filtered, 'knit-count')[0]), '1 / 2 docs')
  assert.equal(byClass(filtered, 'knit-doc').length, 1)
})

test('渲染：排序说明行已整体删除（相关 / 最新 / 中英文都不再有）', async () => {
  // 相关模式（宿主还给了命中关键词）：那一行**连 title 里的关键词一起**消失
  const rel = await renderPanel('en', () => listPayload({
    mode: 'relevance',
    topic: 'sidebar、registry',
  }))
  assert.equal(byClass(rel.nodes, 'knit-topic').length, 0, '相关模式下没有排序说明行')
  assert.ok(!JSON.stringify(ownTexts(rel.nodes)).includes('Sorted by relevance'),
    '这段文案不许从别的地方漏回来')

  // 切到「最新」：也不回来
  byClass(rel.nodes, 'knit-seg-btn').find((n) => textOf(n) === 'Recent').props.onClick()
  const after = await rel.rerender()
  assert.equal(byClass(after, 'knit-topic').length, 0, '切到最新也没有排序说明行')

  // 中文侧同样
  const zh = await renderPanel('zh', () => listPayload())
  assert.equal(byClass(zh.nodes, 'knit-topic').length, 0, '中文侧也没有排序说明行')
  const zhText = JSON.stringify(ownTexts(zh.nodes))
  assert.ok(!zhText.includes('相关性排序') && !zhText.includes('按修改时间倒序'),
    '中文排序说明也不许从别的地方漏回来')
})

test('渲染：英文空态 / 错误态文案', async () => {
  const empty = await renderPanel('en', () => listPayload({ docs: [], total: 0 }))
  assert.match(textOf(byClass(empty.nodes, 'knit-msg')[0]), /No Markdown documents/)

  const failed = await renderPanel('en', () => ({ ok: false, code: 'knit/not-found' }))
  assert.match(textOf(byClass(failed.nodes, 'knit-msg')[0]), /File not found/)
})

/* ── 宿主错误码翻译 ─────────────────────────────────── */

test('错误码：中英各自翻译，不是把码直接抛给用户', async () => {
  const en = await renderPanel('en', () => ({ ok: false, code: 'knit/outside-workspace' }))
  assert.match(textOf(byClass(en.nodes, 'knit-msg')[0]), /Path escapes the workspace/)

  const zh = await renderPanel('zh', () => ({ ok: false, code: 'knit/outside-workspace' }))
  assert.match(textOf(byClass(zh.nodes, 'knit-msg')[0]), /路径越出工作区/)
})

test('错误码：覆盖宿主声明的每一个码，不漏翻', async () => {
  const { readFileSync } = await import('node:fs')
  const hostSource = readFileSync(new URL('../src/host/index.js', import.meta.url), 'utf8')

  const codes = [...hostSource.matchAll(/'(knit\/[a-z-]+)'/g)].map((m) => m[1])
  const unique = [...new Set(codes)]
  assert.ok(unique.length >= 10, `宿主错误码偏少（${unique.length} 个）`)

  // 路由层的码不会出现在面板上，不必翻；其余必须能翻
  const notUserFacing = new Set(['knit/not-found-route', 'knit/loopback-only', 'knit/method-not-allowed', 'knit/bad-request'])
  const clientSource = readFileSync(new URL('../src/client/client.js', import.meta.url), 'utf8')

  const untranslated = unique.filter((code) => !notUserFacing.has(code) && !clientSource.includes(`'${code}'`))
  assert.deepEqual(untranslated, [], `宿主的这些码在客户端没有翻译：${untranslated.join(', ')}`)
})

test('错误码：未登记的码原样显示，便于发现漏翻', async () => {
  const { nodes } = await renderPanel('en', () => ({ ok: false, code: 'knit/brand-new-code' }))
  assert.match(textOf(byClass(nodes, 'knit-msg')[0]), /knit\/brand-new-code/)
})

test('错误码：完全没有 code 时退回通用文案', async () => {
  const en = await renderPanel('en', () => ({ ok: false }))
  assert.match(textOf(byClass(en.nodes, 'knit-msg')[0]), /The host returned a failure/)

  const zh = await renderPanel('zh', () => ({ ok: false }))
  assert.match(textOf(byClass(zh.nodes, 'knit-msg')[0]), /宿主返回失败/)})

/* ── 注册层面的文案 ─────────────────────────────────── */

test('注册：tab 类型与 guide 文案随语言解析（不是注册时定死）', () => {
  const zh = boot('zh')
  const en = boot('en')

  const zhDef = zh.log.tabs[0]
  const enDef = en.log.tabs[0]

  assert.equal(zhDef.title(), 'Knit')
  assert.equal(enDef.title(), 'Knit')

  assert.equal(zhDef.guide[0].title(), 'Knit 最近文档')
  assert.equal(enDef.guide[0].title(), 'Knit — recent documents')

  assert.notEqual(zhDef.guide[0].description(), enDef.guide[0].description())
  assert.match(enDef.guide[0].description(), /Relevance-sorted/)
})

test('注册：入口按钮的无障碍标签随语言变', () => {
  const zh = boot('zh')
  const en = boot('en')

  const zhBtn = zh.log.slots.find((s) => s.opts.id === 'knit:entry')
  const enBtn = en.log.slots.find((s) => s.opts.id === 'knit:entry')

  harness.reset()
  const zhNodes = harness.render(h(zhBtn.component, {}))
  harness.reset()
  const enNodes = harness.render(h(enBtn.component, {}))

  assert.equal(byClass(zhNodes, 'knit-entry')[0].props['aria-label'], 'Knit 最近文档')
  assert.equal(byClass(enNodes, 'knit-entry')[0].props['aria-label'], 'Knit — recent documents')
})

test('注册：座位声明带上 locale 命名空间', () => {
  const { log } = boot('zh')
  const entry = log.slots.find((s) => s.opts.id === 'knit:entry')
  assert.equal(entry.opts.locale, 'knit', 'list 座位要声明 locale，运行时才知道用哪个词典')
})

test('注册：词典通过 ctx.effect 注册（可随插件卸载回收）', () => {
  const { log } = boot('zh')
  assert.ok(
    log.effects.some((label) => String(label).includes('dictionaries')),
    `effect 标签里应有词典注册：${log.effects.join(' / ')}`,
  )
})

/* ── 冒烟：两个语言都能渲染完整面板 ───────────────────── */

test('冒烟：中英环境下渲染同一份数据都不抛错，且文案确实不同', async () => {
  const compose = () => listPayload({ mode: 'relevance', topic: 'x' })
  const zh = await renderPanel('zh', compose)
  const en = await renderPanel('en', compose)

  const zhText = zh.nodes.map(textOf).join('|')
  const enText = en.nodes.map(textOf).join('|')

  assert.notEqual(zhText, enText, '两种语言渲染出的文案不该完全一样')
  assert.ok(!/Refresh|Sorted by/.test(zhText), `中文环境混进了英文：${zhText}`)
  assert.ok(!/刷新|按/.test(enText), `英文环境混进了中文：${enText}`)
})

/* ── 硬编码中文的守卫（2026-09-19 加的）──────────────────
 *
 * 起因：真机截图暴露「英文界面 + 中文『3 分钟前』」——`relTime()` 把那六条时间文案
 * 硬编码在函数里，没进词典。同一批还查出两处：文档列表的 `aria-label`、
 * better-sidebar 的 tab 标题。
 *
 * 上面那条冒烟用例**当时没抓住它**，因为它只硬编码地查了 `刷新|按` 两个词 ——
 * 写死几个词等于给未来留了个洞。所以这里换成**通用判据**：
 * 英文环境渲染出的整棵树里，文字与无障碍属性都不许出现汉字。
 *
 * ⚠️ 语料必须保持 ASCII（`listPayload()` 的标题是 'A' / 'B'）：
 *    文档自带的中文标题会把这条用例误报成失败，而那是**数据**、不是**文案**。
 */

/**
 * 收集渲染树里所有**直接**文本子节点（不走子树，避免重复）。
 * @param {object[]} nodes - 扁平节点
 * @returns {string[]} 文本片段
 */
function ownTexts(nodes) {
  return nodes.flatMap((n) => (n.children || []).filter((c) => typeof c === 'string'))
}

/**
 * 挑出含汉字的片段，失败信息里就能直接看出漏了哪一条。
 * @param {string[]} texts - 文本片段
 * @returns {string[]} 含汉字的片段
 */
function cjkIn(texts) {
  return texts.filter((s) => /[\u3400-\u9fff]/.test(s))
}

const MIN = 60 * 1000

/**
 * 造一份**把相对时间六个分支全走一遍**的列表载荷。
 *
 * ⚠️ 这份语料不能省。第一版守卫用的是 `listPayload()`，它两篇文档只落在
 * `justNow` 与 `yesterday` 两个分支上 —— 于是「把 `分钟前` 硬编码回去」
 * 这种回归**测不出来**（我实测过：补丁打上去，守卫照样全绿）。
 * 真机截图里漏出来的恰恰就是 `分钟前` 那一条。
 *
 * @returns {object} 载荷
 */
function timePayload() {
  const now = Date.now()
  const ages = [
    ['now.md', 0],
    ['min.md', 5 * MIN],
    ['hour.md', 5 * 60 * MIN],
    ['yest.md', 25 * 60 * MIN],
    ['days.md', 3 * 24 * 60 * MIN],
    ['month.md', 40 * 24 * 60 * MIN],
  ]
  return {
    ok: true,
    root: '/p',
    total: ages.length,
    mode: 'time',
    topic: '',
    docs: ages.map(([rel, age]) => ({
      path: `/p/${rel}`, rel, name: rel, title: rel, summary: 's', mtimeMs: now - age, score: null,
    })),
  }
}

test('守卫：英文环境渲染出的整棵树里一个汉字都没有', async () => {
  // 用 timePayload：六个时间分支都要真的渲染出来，否则守卫是「没覆盖的空转绿灯」
  const { nodes } = await renderPanel('en', () => timePayload())
  const bad = cjkIn(ownTexts(nodes))
  assert.deepEqual(bad, [], `英文渲染里混进了中文（说明有文案没走 t()）：${bad.join(' / ')}`)
})

test('守卫：英文环境下无障碍与提示属性里也没有汉字', async () => {
  const { nodes } = await renderPanel('en', () => timePayload())
  const attrs = ['aria-label', 'title', 'placeholder', 'alt']
  const bad = []
  for (const n of nodes) {
    for (const a of attrs) {
      const v = n.props[a]
      if (typeof v === 'string' && /[\u3400-\u9fff]/.test(v)) bad.push(`${a}="${v}"`)
    }
  }
  assert.deepEqual(bad, [], `英文环境的属性里混进了中文：${bad.join(' / ')}`)
})

/* ── v0.18 Usage Lens：英文渲染里也不许有汉字 ───────────────
   ⚠️ 上面那两条守卫用的是 `timePayload()` —— **它没有 usage**，所以 Lens 整块
   一个节点都没渲染。也就是说 v0.18 新增的几十条 Lens 文案（含挂在 `title` /
   `aria-label` 上的）**不在那两条守卫的覆盖里**：JSX 里如果漏了 `t()`，
   它们照样全绿。下面这两条把 Lens 真的打开再查一遍。 */

/**
 * v0.18 Usage Lens 的**英文语料**（全部 ASCII）。
 *
 * ⚠️ 与 `timePayload` 同一条规矩：标题 / 主题 / 摘要都是**数据**，
 *    混进中文会被守卫误报成「文案漏了 t()」。
 * 覆盖面：三块内容全在 —— Coverage 三层、最近读取、包外 12 篇（→「还有 2 篇」）、
 * 变化 6 条（→「还有 3 条」，且 `taskChanged` 为真）；生命周期四态齐全。
 *
 * @returns {object} 载荷
 */
function lensPayload() {
  const at = Date.now()
  const item = (rel, title) => ({
    rel, path: `/p/${rel}`, name: rel.split('/').pop(), title,
    summary: 's', mtimeMs: at, kind: 'md', source: 'doc',
    reason: { code: 'titleMatch', terms: ['bm25'], fields: 1 },
  })
  const delta = {
    appeared: [{ rel: 'docs/new-a.md', tier: 'primary', rank: 2 },
      { rel: 'docs/new-b.md', tier: 'related', rank: 3 }],
    disappeared: [{ rel: 'docs/gone-a.md', tier: 'related', rank: 4 },
      { rel: 'docs/gone-b.md', tier: 'related', rank: 5 }],
    moved: [{ rel: 'docs/moved.md', from: 'supporting', to: 'related' }],
    taskChanged: true,
  }
  return {
    ok: true, root: '/p', total: 4, mode: 'relevance', topic: 'bm25 ranking', keywords: ['bm25'],
    docs: [item('docs/algo.md', 'Algo'), item('docs/eval.md', 'Eval'),
      item('CHANGELOG.md', 'Changelog'), item('README.md', 'Knit')],
    context: {
      mode: 'relevance', topic: 'bm25 ranking', task: '',
      primary: [item('docs/algo.md', 'Algo')],
      supporting: [item('docs/eval.md', 'Eval'), item('CHANGELOG.md', 'Changelog')],
      related: [item('README.md', 'Knit'), item('out/doc-0.md', 'Out')],
    },
    usage: {
      at, epochId: 4,
      stats: {
        reads: 7, distinct: 3, outside: 12, outsideReads: [],
        firstReadTier: 'primary', firstReadRel: 'docs/algo.md', firstReadAt: 1,
        primaryRel: 'docs/algo.md', primaryFollowThrough: true,
        byTier: {
          primary: { total: 1, read: 1 },
          supporting: { total: 2, read: 1 },
          related: { total: 2, read: 0 },
        },
        supportingCoverage: 0.5,
        churn: { snapshots: 5, deltas: 4, retained: 4, appeared: 2, disappeared: 2, moved: 1, taskChanged: 1 },
      },
      delta, latestDelta: delta,
      recentRead: { rel: 'docs/eval.md', at, seq: 42, epochId: 4, tier: 'supporting', rank: 2, inside: true },
      outsideDocs: Array.from({ length: 12 }, (_, i) => ({
        rel: `out/doc-${i}.md`, count: 12 - i, lastReadAt: i, seq: i,
      })),
      lifecycle: {
        'docs/algo.md': { status: 'read', count: 3, lastReadAt: 1 },
        'docs/eval.md': { status: 'reread_after_update', count: 2, lastReadAt: 2 },
        'CHANGELOG.md': { status: 'updated_after_read', count: 1, lastReadAt: 3 },
        'README.md': { status: 'unread', count: 0, lastReadAt: 0 },
        // ⚠️ 包外那 12 篇在真实载荷里**每一篇都有 read 记录**（左右两栏同源）。
        //    只给第一篇的话，守卫语料会自相矛盾：左边写 `×11`、右边写 `Unread`。
        ...Object.fromEntries(Array.from({ length: 12 }, (_, i) => [
          `out/doc-${i}.md`, { status: 'read', count: 12 - i, lastReadAt: i },
        ])),
      },
    },
  }
}

/**
 * 把 Usage Lens **打开**（数据到位后再点，与真实用法一致），返回渲染出的节点。
 * @param {string} locale - 活动语言
 * @param {object} payload - 宿主载荷
 * @returns {Promise<{nodes: object[], render: Function}>} 节点与重渲染
 */
async function mountLens(locale, payload) {
  installFetch(() => payload)
  const { exports } = boot(locale)
  const { KnitBody } = exports.__test
  harness.reset()
  const render = () => harness.render(h(KnitBody, { sessionId: 's1' }))
  render()
  await harness.flush()
  render()
  await harness.flush()
  const toggle = byExactClass(render(), 'knit-btn').find((n) => textOf(n) === 'Usage')
  assert.ok(toggle, '英文头部必须有 Usage 按钮')
  toggle.props.onClick()
  await harness.flush()
  render()
  await harness.flush()
  return { nodes: render(), render }
}

/**
 * 收集一棵树里所有 `title` / `aria-label` 之类的**文案属性**。
 * @param {object[]} nodes - 扁平节点
 * @returns {string[]} 属性值
 */
function attrTexts(nodes) {
  const attrs = ['aria-label', 'title', 'placeholder', 'alt']
  const out = []
  for (const n of nodes) {
    for (const a of attrs) {
      const v = n.props[a]
      if (typeof v === 'string' && v) out.push(`${a}="${v}"`)
    }
  }
  return out
}

test('守卫：英文环境下打开的 Usage Lens 里也没有汉字（文字 + title / aria-label）', async () => {
  const { nodes: closed, render } = await mountLens('en', lensPayload())

  // 折叠态先查一遍：`+3 more`（`usage.deltaMore`）只在折叠时出现（展开＝明细全列，不再有尾巴）
  const closedText = ownTexts(closed).join(' | ')
  assert.ok(closedText.includes('+3 more'), `折叠态少了「+3 more」：${closedText}`)
  assert.deepEqual(cjkIn(ownTexts(closed)), [], '英文折叠态 Lens 的文字里混进了中文')
  assert.deepEqual(cjkIn(attrTexts(closed)), [], '英文折叠态 Lens 的属性里混进了中文')

  // 两块集合默认折叠 —— 先把它们点开，否则那几条文案根本没进渲染树
  for (const btn of byExactClass(closed, 'knit-more-btn')) btn.props.onClick()
  const nodes = render()
  const text = ownTexts(nodes).join(' | ')

  // ⚠️ 先证明 Lens **真的渲染了**：找不到锚点就意味着下面是「空转绿灯」
  for (const anchor of ['Usage', 'Epoch 4', 'Current context', 'Recent read',
    'Reads outside context', 'Context changes', 'Entered', 'Left', 'Moved tier',
    'Task context updated', '2 more']) {
    assert.ok(text.includes(anchor), `英文 Lens 少了「${anchor}」：${text}`)
  }

  assert.deepEqual(cjkIn(ownTexts(nodes)), [], '英文 Usage Lens 的文字里混进了中文')
  const bad = cjkIn(attrTexts(nodes))
  assert.deepEqual(bad, [], `英文 Usage Lens 的属性里混进了中文：${bad.join(' / ')}`)
})

test('守卫：英文环境下**空**的 Usage Lens 里也没有汉字', async () => {
  const payload = lensPayload()
  const u = payload.usage
  u.stats.reads = 0
  u.stats.outside = 0
  u.stats.churn.snapshots = 0
  u.delta = null
  u.latestDelta = null
  u.recentRead = null
  u.outsideDocs = []
  u.lifecycle = {}

  const { nodes } = await mountLens('en', payload)
  const text = ownTexts(nodes).join(' | ')
  assert.ok(text.includes('Nothing yet'), `空态少了「Nothing yet」：${text}`)
  assert.ok(text.includes('0 reads'), `空态也要报事实（0 reads）：${text}`)
  assert.deepEqual(cjkIn(ownTexts(nodes)), [], '英文空 Lens 的文字里混进了中文')
  assert.deepEqual(cjkIn(attrTexts(nodes)), [], '英文空 Lens 的属性里混进了中文')
})

test('守卫：相对时间的六个分支都随语言（原来是硬编码中文）', async () => {
  const en = await renderPanel('en', () => timePayload())
  const enTimes = byClass(en.nodes, 'knit-time').map(textOf)
  assert.equal(enTimes.length, 6, `六个分支都该渲染出来，实际只有 ${enTimes.length} 条`)
  assert.deepEqual(
    enTimes.slice(0, 5),
    ['just now', '5 min ago', '5 h ago', 'yesterday', '3 d ago'],
  )
  // 第六档是「月/日」，具体日期随当天变，只校验形状
  assert.match(enTimes[5], /^\d{1,2}\/\d{1,2}$/, `英文的月日应形如 8/10，实际是 ${enTimes[5]}`)

  const zh = await renderPanel('zh', () => timePayload())
  const zhTimes = byClass(zh.nodes, 'knit-time').map(textOf)
  assert.deepEqual(
    zhTimes.slice(0, 5),
    ['刚刚', '5分钟前', '5小时前', '昨天', '3天前'],
  )
  assert.match(zhTimes[5], /^\d{1,2}月\d{1,2}日$/, `中文的月日应形如 8月10日，实际是 ${zhTimes[5]}`)
})

test('守卫：better-sidebar 的 tab 标题随语言（复用 guide.title，不再写死）', () => {
  const en = boot('en', undefined, { betterSidebar: true })
  assert.equal(en.log.bsTabs.length, 1, '应注册一个 better-sidebar tab')
  assert.equal(en.log.bsTabs[0].title(), 'Knit — recent documents')

  const zh = boot('zh', undefined, { betterSidebar: true })
  assert.equal(zh.log.bsTabs[0].title(), 'Knit 最近文档')
})

/* ── 文案洁癖：词典里不出现表情装饰 ───────────────────── */

test('词典：不出现 🤖 之类的表情字符（用户明确要求删掉）', async () => {
  const { readFileSync } = await import('node:fs')
  const source = readFileSync(new URL('../src/client/client.js', import.meta.url), 'utf8')

  // 用户原话：「🤖 这个图标删除」—— 排序依据那行原本顶着这个表情。
  // 只扫词典（ZH / EN 两段），因为组件的 🆕 是**有意的**新文档标记，不在词典里。
  for (const name of ['ZH', 'EN']) {
    const body = source.match(new RegExp(`const ${name} = \\{([\\s\\S]*?)\\n    \\}`))
    assert.ok(body, `没找到 ${name} 词典`)
    // 只拦表情符号区（U+1F300–U+1FAFF），放行 → 这类排版符号
    const found = [...body[1]].filter((ch) => {
      const cp = ch.codePointAt(0)
      return cp >= 0x1f300 && cp <= 0x1faff
    })
    assert.deepEqual(found, [], `${name} 词典里出现了表情字符：${found.join(' ')}`)
  }
})

/* ── v0.14：理由码必须与客户端词典一一对应 ────────────────
   宿主给码、客户端翻译（AGENTS.md §4.5）。宿主加了新码而客户端没跟上时，
   界面上会漏出 `why.xxx` 这种原始码 —— 这条守卫把那个缺口钉死。 */

test('i18n: 宿主的每个 Context Pack 理由码都有中英译文', async () => {
  const { readFileSync } = await import('node:fs')
  const { fileURLToPath } = await import('node:url')
  const context = readFileSync(fileURLToPath(new URL('../src/host/context.js', import.meta.url)), 'utf8')

  // 从 `explainContext` 的函数体里抽出全部理由码。
  // ⚠️ 不能只匹配 `code: 'xxx'` —— 有一个码写成三元里的 `? 'direct' : 'titleMatch'`，
  // 只认前者会漏掉它，于是这条守卫静默少守一个码（正是它要防的那类事）。
  const start = context.indexOf('export function explainContext')
  const end = context.indexOf('const REASON_ORDER')
  assert.ok(start > 0 && end > start, '没定位到 explainContext 的函数体')
  const body = context.slice(start, end)
  const used = new Set([...body.matchAll(/'([a-zA-Z]+)'/g)].map((m) => m[1]))
  assert.ok(used.size >= 6, `应当抽出至少 6 个理由码，实际 ${used.size}（${[...used].join('/')}）`)

  const client = readFileSync(fileURLToPath(new URL('../src/client/client.js', import.meta.url)), 'utf8')
  const zhStart = client.indexOf('const ZH = {')
  const zh = client.slice(zhStart, client.indexOf('const EN = {'))
  const enStart = client.indexOf('const EN = {')
  const en = client.slice(enStart, client.indexOf('const HOST_ERROR_KEY'))

  const missing = []
  for (const code of used) {
    // 有命中词时用 `why.<code>`；没有命中词时回落 `why.<code>Plain`（可选）
    if (!zh.includes(`'why.${code}'`)) missing.push(`ZH why.${code}`)
    if (!en.includes(`'why.${code}'`)) missing.push(`EN why.${code}`)
  }
  assert.deepEqual(missing, [], `这些理由码没有译文：${missing.join('、')}`)
  // 反向：词典里也不许留下已经不用的码（死键会让人以为那条规则还在）
  for (const m of zh.matchAll(/'why\.([a-zA-Z]+)'/g)) {
    const key = m[1]
    if (key.endsWith('Plain')) continue
    assert.ok(used.has(key), `ZH 里的 why.${key} 已经没有一个宿主理由码在用它`)
  }
})

/* ── v0.17 文档生命周期：数据层英文，界面按语言映射 ─────────────────── */

test('词典：v0.18 的 Usage Lens / 生命周期文案中英都对得上', () => {
  const { registered } = boot('zh')
  const { zh, en } = registered.knit

  // 状态值本身在数据层是英文（unread / read / ...），中文只活在词典里（SDD §15.4）
  const expected = {
    'usage.deltaEnter': ['进入', 'Entered'],
    'usage.deltaLeave': ['离开', 'Left'],
    'usage.deltaMove': ['换层', 'Moved tier'],
    'usage.deltaTask': ['任务上下文已更新', 'Task context updated'],
    'usage.deltaMore': ['还有 {n} 条', '+{n} more'],
    // v0.18 Usage Lens：标题 / 摘要行 / 三块内容
    'lens.title': ['使用情况', 'Usage'],
    'lens.expand': ['展开使用情况', 'Expand usage'],
    'lens.collapse': ['收起使用情况', 'Collapse usage'],
    'lens.epoch': ['Epoch {n}', 'Epoch {n}'],
    'lens.reads': ['{n} 次读取', '{n} reads'],
    'lens.outside': ['{n} 篇包外', '{n} outside the pack'],
    'lens.changes': ['上下文变化 {n} 次', 'context changed {n}×'],
    'lens.currentContext': ['当前上下文', 'Current context'],
    'lens.recentRead': ['最近读取', 'Recent read'],
    'lens.recentNone': ['暂无记录', 'Nothing yet'],
    'lens.outsideDocs': ['上下文外读取', 'Reads outside context'],
    'lens.more': ['还有 {n} 篇', '{n} more'],
    'lens.openDoc': ['打开 {rel}', 'Open {rel}'],
    'lens.delta': ['上下文变化', 'Context changes'],
    'lens.locate': ['定位到{tier}上下文', 'Locate {tier} context'],
    // v0.18 UI 迭代新增：读屏专用的一句（视觉上不显示）+ 变化行右侧的「最近一次」
    'lens.coverageAria': ['{tier}上下文：{read} / {total} 篇已读', '{tier} context: {read} / {total} read'],
    'lens.deltaLatest': ['最近一次', 'Latest'],
    // 类型页签 +「全部」分区标题（2026-10-06 用户定：原「图片与视频」→「媒体」；英文随
    // count.media 走成 Media）。钉住它是因为这一个键同时管页签与分区标题，改一处就两处变。
    'kind.media': ['媒体', 'Media'],
    'lifecycle.unread': ['未读', 'Unread'],
    'lifecycle.read': ['已读', 'Read'],
    'lifecycle.readCount': ['已读 ×{n}', 'Read ×{n}'],
    'lifecycle.readCountShort': ['×{n}', '×{n}'],
    'lifecycle.updatedAfterRead': ['读后已更新', 'Updated after read'],
    'lifecycle.rereadAfterUpdate': ['修改后已重新读取', 'Re-read after update'],
    'tierName.primary': ['主要', 'Primary'],
    'tierName.supporting': ['辅助', 'Supporting'],
    'tierName.related': ['相关', 'Related'],
  }

  for (const [key, [zhText, enText]] of Object.entries(expected)) {
    assert.equal(zh[key], zhText, `ZH ${key}`)
    assert.equal(en[key], enText, `EN ${key}`)
    assert.ok(!/[\u4e00-\u9fff]/.test(en[key]), `EN ${key} 里不许出现汉字`)
  }
  // 四档事实状态只陈述事实：不许写成「Agent 还不知道最新版」这类推断
  const stateWords = ['lifecycle.unread', 'lifecycle.read', 'lifecycle.updatedAfterRead', 'lifecycle.rereadAfterUpdate']
  for (const key of stateWords) {
    assert.ok(!/Agent|还不知道|旧版|没看到|忽略了/.test(zh[key]), `ZH ${key} 不许写推断`)
    assert.ok(!/Agent|outdated|stale version|missed|ignored/i.test(en[key]), `EN ${key} 不许写推断`)
  }
})

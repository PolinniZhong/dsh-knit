/**
 * 媒体全屏查看器 · 图内评论（v0.26）
 *
 * 用户要的是 Codex 画布那条闭环：图上落 pin → 写一句 → 发送 → 会话里收到
 * 「图像 1：<身份>」+「1.（x：62.5%，y：31.0%）文案」。
 *
 * 这份测试分三层：
 *   ① 纯函数（坐标 / 归一化 / §四 文本 / 身份）—— 能真断言，不碰 DOM；
 *   ② 组件接线（评论按钮 / 落 pin / 编辑 / 删除 / 切图 / 投递）—— 用 harness 真跑组件；
 *   ③ 源码守卫（坐标必须来自 contentRect / 颜色走 token / 不落盘 / 重算机制在）。
 *
 * ⚠️ 坐标是命门：绝大多数 bug 都在「拿 stage 框算百分比」这一个岔路上，
 * 所以第 ③ 层对 `commentClickPct` 做**形状守卫**，并逐条做过突变证伪（见 docs/image-comments.md）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { loadClientModule, createHarness, byClass, byExactClass, textOf } from './harness.mjs'

const harness = createHarness()
const React = globalThis.__knitReact
const h = React.createElement
const SOURCE = readFileSync(fileURLToPath(new URL('../src/client/client.js', import.meta.url)), 'utf8')
const client = loadClientModule()
const testApi = client.exports.__test
const { KnitBody } = testApi

/* ── 测试夹具 ─────────────────────────────────────────── */

/** 装一个假 fetch；只认 `/api/recent` 那份载荷。 */
function installFetch(responder) {
  globalThis.fetch = async (url) => ({ json: async () => responder(url) })
}

/** 两张图 + 一个视频的媒体载荷（时间倒序：a.png 更新）。 */
function mediaPayload(overrides = {}) {
  const now = Date.now()
  return {
    ok: true, root: '/p', total: 3, mode: 'time', topic: '', kind: 'media',
    docs: [
      { path: '/p/a.png', rel: 'a.png', name: 'a.png', title: 'a', kind: 'image', summary: '', size: 1024, mtimeMs: now - 60000, score: null },
      { path: '/p/b.png', rel: 'b.png', name: 'b.png', title: 'b', kind: 'image', summary: '', size: 2048, mtimeMs: now - 120000, score: null },
      { path: '/p/demo.mp4', rel: 'demo.mp4', name: 'demo.mp4', title: 'demo', kind: 'video', summary: '', size: 99999, mtimeMs: now - 9e7, score: null },
    ],
    ...overrides,
  }
}

/** 挂到媒体档、双击第 openIndex 张图打开查看器。 */
async function mountLightbox(payload = mediaPayload(), openIndex = 0) {
  installFetch((url) => {
    if (url.includes('/api/attachments')) return { ok: true, items: [] }
    if (url.includes('/api/doc')) return { ok: true, rel: 'x', title: 'x', text: '', truncated: false }
    return payload
  })
  const render = () => harness.render(h(KnitBody, { sessionId: 's1' }))
  harness.reset()
  harness.seed(['', 'time', 'media'])
  let nodes = render()
  await harness.flush()
  nodes = render()
  const cards = byClass(nodes, 'knit-media-card').filter((n) => String(n.props['data-knit-rel']).endsWith('.png'))
  assert.ok(cards[openIndex], '前提：有图片卡片')
  cards[openIndex].props.onDoubleClick()
  return { nodes: render(), render }
}

/** 点评论模式开关；返回最新的渲染。 */
function toggleComment(nodes) {
  const button = nodes.find((n) => n && n.props && n.props['data-knit-comment-toggle'] === '1')
  assert.ok(button, '工具条里应有评论按钮')
  button.props.onClick({ stopPropagation() {} })
}

/** 当前渲染里的评论按钮（取最新一次渲染）。 */
function commentButton(nodes) {
  return nodes.find((n) => n && n.props && n.props['data-knit-comment-toggle'] === '1')
}

/**
 * 在图片内容框的 (xPct, yPct) 处点一下。
 *
 * 夹具固定成：img 盒 400×300、自然尺寸 1000×1000 ⇒ contain 后绘制矩形 300×300 @ (50,0)。
 * 这样「点击位置 ↔ 百分比」可以手算，断言不是自证。
 */
function clickImage(nodes, xPct, yPct) {
  const img = {
    naturalWidth: 1000,
    naturalHeight: 1000,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 400, height: 300 }),
  }
  const stage = {
    querySelector: () => img,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }),
  }
  const content = { left: 50, top: 0, width: 300, height: 300 }
  let stopped = 0
  const event = {
    clientX: content.left + (content.width * xPct) / 100,
    clientY: content.top + (content.height * yPct) / 100,
    currentTarget: stage,
    stopPropagation() { stopped += 1 },
  }
  byExactClass(nodes, 'knit-lightbox-stage')[0].props.onClick(event)
  return stopped
}

/** 在评论输入框里改文字并回车保存；返回保存后的渲染。 */
function typeAndEnter(nodes, text, render) {
  const input = byExactClass(nodes, 'knit-lightbox-editor-input')[0]
  assert.ok(input, '前提：编辑框开着')
  input.props.onChange({ target: { value: text } })
  const next = byExactClass(render(), 'knit-lightbox-editor-input')[0]
  assert.ok(next, '前提：改完文字编辑框还在')
  next.props.onKeyDown({ key: 'Enter', preventDefault() {}, stopPropagation() {} })
  return render()
}

/** 在节点树里递归找一个满足条件的节点。 */
function findNode(node, predicate) {
  if (!node || typeof node !== 'object') return null
  if (predicate(node)) return node
  for (const child of node.children || []) {
    const hit = findNode(child, predicate)
    if (hit) return hit
  }
  return null
}

/** 取 `.knit-lightbox` 根（className 可能带 docked）。 */
function lightboxRoot(nodes) {
  return byClass(nodes, 'knit-lightbox')
    .find((n) => String(n.props.className).split(/\s+/).includes('knit-lightbox'))
}

/** 一条评论在渲染结果里的 pin 文本。 */
function pinLabels(nodes) {
  return byExactClass(nodes, 'knit-lightbox-pin').map((n) => textOf(n))
}

/* ── ① 纯函数：坐标 ───────────────────────────────────── */

test('纯：contentRect 返回 contain 之后**真正画出图**的矩形（letterbox 去掉）', () => {
  const { contentRect } = testApi

  // 方图塞进 400×300 的横盒子 ⇒ 300×300，左边各留 50
  assert.deepEqual(
    contentRect({ left: 0, top: 0, width: 400, height: 300 }, { width: 1000, height: 1000 }),
    { left: 50, top: 0, width: 300, height: 300 },
  )
  // 横图（2:1）塞进 400×300 ⇒ 400×200，上下各留 50
  assert.deepEqual(
    contentRect({ left: 10, top: 20, width: 400, height: 300 }, { width: 2000, height: 1000 }),
    { left: 10, top: 70, width: 400, height: 200 },
  )
  // 竖图（1:2）塞进 400×300 ⇒ 150×300，左右各留 125
  assert.deepEqual(
    contentRect({ left: 0, top: 0, width: 400, height: 300 }, { width: 500, height: 1000 }),
    { left: 125, top: 0, width: 150, height: 300 },
  )
  // cover / fill 也支持（虽然查看器只用 contain；这里钉住语义不混）
  assert.deepEqual(
    contentRect({ left: 0, top: 0, width: 400, height: 300 }, { width: 1000, height: 1000 }, 'fill'),
    { left: 0, top: 0, width: 400, height: 300 },
  )
  assert.deepEqual(
    contentRect({ left: 0, top: 0, width: 400, height: 300 }, { width: 1000, height: 1000 }, 'cover'),
    { left: 0, top: -50, width: 400, height: 400 },
  )
  // 畸形输入 ⇒ null（不许抛）
  assert.equal(contentRect(null, { width: 1, height: 1 }), null)
  assert.equal(contentRect({ left: 0, top: 0, width: 400, height: 300 }, { width: 0, height: 0 }), null)
  assert.equal(contentRect({ left: 0, top: 0, width: 0, height: 0 }, { width: 10, height: 10 }), null)
})

test('纯：pctFromPoint / pointFromPct 互逆，坐标夹到 0–100', () => {
  const { pctFromPoint, pointFromPct } = testApi
  const rect = { left: 100, top: 50, width: 400, height: 200 }

  assert.deepEqual(pctFromPoint({ x: 100, y: 50 }, rect), { xPct: 0, yPct: 0 })
  assert.deepEqual(pctFromPoint({ x: 500, y: 250 }, rect), { xPct: 100, yPct: 100 })
  assert.deepEqual(pctFromPoint({ x: 350, y: 150 }, rect), { xPct: 62.5, yPct: 50 })

  // 出界一律夹到 0–100（落点不会跑到图外面）
  assert.deepEqual(pctFromPoint({ x: -999, y: 9999 }, rect), { xPct: 0, yPct: 100 })

  // 逆运算：同一个百分比回到同一个点
  const back = pointFromPct({ xPct: 62.5, yPct: 31 }, rect)
  assert.equal(back.x, 100 + 400 * 0.625)
  assert.equal(back.y, 50 + 200 * 0.31)
  assert.deepEqual(pctFromPoint(back, rect), { xPct: 62.5, yPct: 31 })

  // 畸形 ⇒ null
  assert.equal(pctFromPoint(null, rect), null)
  assert.equal(pctFromPoint({ x: 1, y: 1 }, null), null)
  assert.equal(pctFromPoint({ x: NaN, y: 1 }, rect), null)
  assert.equal(pointFromPct({ xPct: NaN, yPct: 1 }, rect), null)
})

test('纯：同一个百分比在**不同窗口宽度 / 不同 DPR** 下落在同一视觉位置', () => {
  const { contentRect, pointFromPct, pctFromPoint } = testApi

  // 同一张方图，两个窗口宽度下 img 盒不同（面板 320 / 900 时 contain 后的盒子也不同）
  const wide = contentRect({ left: 0, top: 0, width: 800, height: 600 }, { width: 1000, height: 1000 })
  const narrow = contentRect({ left: 0, top: 0, width: 360, height: 640 }, { width: 1000, height: 1000 })
  const pct = { xPct: 48.3, yPct: 29.5 }
  const a = pointFromPct(pct, wide)
  const b = pointFromPct(pct, narrow)

  // 「同一视觉位置」= 相对内容框的比例相同（不是绝对像素相同）
  const rel = (point, rect) => ({ x: (point.x - rect.left) / rect.width, y: (point.y - rect.top) / rect.height })
  const relA = rel(a, wide)
  const relB = rel(b, narrow)
  assert.ok(Math.abs(relA.x - relB.x) < 1e-9 && Math.abs(relA.y - relB.y) < 1e-9,
    '同一百分比在两种宽度下相对内容框的比例必须相同')
  // 再把它换算回百分比，逐字相同（这就是跨 DPR 也一致的原因：几何只用 CSS px，不读 devicePixelRatio）
  assert.deepEqual(pctFromPoint(a, wide), { xPct: 48.3, yPct: 29.5 })
  assert.deepEqual(pctFromPoint(b, narrow), { xPct: 48.3, yPct: 29.5 })
  // 窄视口里图片上下留白（360 宽、640 高 ⇒ 绘制矩形 360×360 居中）—— 百分比仍相对这 360×360
  assert.equal(narrow.width, 360)
  assert.equal(narrow.top, 140)
})

test('纯：评论气泡贴着 pin，近右/近下会翻边并夹进视口（不再停到图片边上）', () => {
  const { commentPopoverBox } = testApi
  const view = { width: 1440, height: 900 }
  const size = { width: 280, height: 172 }

  // 常规位置：pin 在左上 ⇒ 气泡在右下、紧挨着 pin（不是跑到画面边角）
  const normal = commentPopoverBox({ x: 200, y: 200 }, size, view)
  assert.equal(normal.placement, 'right')
  assert.equal(normal.side, 'below')
  assert.ok(normal.left >= 200 && normal.top >= 200, '默认长在 pin 的右下方')

  // 靠右 ⇒ 翻到 pin 左侧（Infini 分享包同一套规则）
  const nearRight = commentPopoverBox({ x: 1320, y: 200 }, size, view)
  assert.equal(nearRight.placement, 'left')
  assert.ok(nearRight.left + size.width <= 1320, '翻边后不压住 pin')
  assert.ok(nearRight.left >= 12, '也不许出左边')

  // 靠下 ⇒ 翻到 pin 上方
  const nearBottom = commentPopoverBox({ x: 200, y: 840 }, size, view)
  assert.equal(nearBottom.side, 'above')
  assert.ok(nearBottom.top + size.height <= 840)

  // 极端角落 / 超小视口：一律夹在视口内（气泡不许半截出屏）
  const corner = commentPopoverBox({ x: 1435, y: 895 }, size, view)
  assert.ok(corner.left >= 12 && corner.left + size.width <= view.width - 12)
  assert.ok(corner.top >= 12 && corner.top + size.height <= view.height - 12)
  const tiny = commentPopoverBox({ x: 10, y: 10 }, size, { width: 320, height: 240 })
  assert.ok(tiny.left >= 0 && tiny.top >= 0)
  assert.ok(tiny.left + size.width <= 320 && tiny.top + size.height <= 240)

  // 量不到 pin（测试替身 / 尺寸未就绪）⇒ 视口中心附近，仍在屏内
  const noAnchor = commentPopoverBox(null, size, view)
  assert.ok(noAnchor.left >= 12 && noAnchor.left + size.width <= view.width - 12)
})

/* ── ① 纯函数：数据 ───────────────────────────────────── */

test('纯：normalizeComments 畸形回空 / 夹取 / 编号连续 / 条数上限 / 不改入参', () => {
  const { normalizeComments, COMMENT_MAX } = testApi

  assert.deepEqual(normalizeComments(null), [])
  assert.deepEqual(normalizeComments('nope'), [])
  assert.deepEqual(normalizeComments([null, 1, 'x', {}]), [], '没有正文的条目一律丢掉')

  // 夹取 + 连续编号（输入里编号乱写：7、9、3）
  const cleaned = normalizeComments([
    { n: 7, xPct: -20, yPct: 120, text: 'a' },
    { n: 9, xPct: 50, yPct: 50, text: 'b' },
    { n: 3, xPct: 200, yPct: -1, text: 'c' },
  ])
  assert.deepEqual(cleaned.map((c) => c.n), [1, 2, 3])
  assert.deepEqual(cleaned.map((c) => [c.xPct, c.yPct]), [[0, 100], [50, 50], [100, 0]])

  // 空文本 / 纯空白不占位（「空文本不保存」的数据层兜底）
  assert.deepEqual(normalizeComments([{ n: 1, xPct: 1, yPct: 1, text: '  ' }]), [])

  // 条数上限
  const many = Array.from({ length: COMMENT_MAX + 10 }, (_, i) => ({ n: i + 1, xPct: 1, yPct: 1, text: `t${i}` }))
  assert.equal(normalizeComments(many).length, COMMENT_MAX)

  // 不改入参
  const input = [{ n: 5, xPct: 10, yPct: 20, text: 'x' }]
  normalizeComments(input)
  assert.deepEqual(input, [{ n: 5, xPct: 10, yPct: 20, text: 'x' }])
})

test('纯：nextNumber 空表从 1 起、连续递增', () => {
  const { nextNumber } = testApi
  assert.equal(nextNumber([]), 1)
  assert.equal(nextNumber(null), 1)
  assert.equal(nextNumber([{ n: 1 }]), 2)
  assert.equal(nextNumber([{ n: 1 }, { n: 2 }, { n: 3 }]), 4)
  // 畸形编号先被归一化，所以「下一条」仍连续
  assert.equal(nextNumber([{ n: 9, xPct: 1, yPct: 1, text: 'a' }]), 2)
})

test('纯：commentLines 严格照 §四 的文本格式（1 位小数、不截断、带身份）', () => {
  const { commentLines } = testApi
  const list = [
    { n: 1, xPct: 62.5, yPct: 31, text: '右腿两条腿粘在一起了，分界要出来' },
    { n: 2, xPct: 41.25, yPct: 57.44, text: '陶盆和虎尾兰对不上' },
  ]

  assert.deepEqual(commentLines(list, { name: 'G3.png', sha: 'd33f4f2a1234567890abcdef' }), [
    '图像 1：G3.png（sha256 d33f4f2a1234）',
    '1.（x：62.5%，y：31.0%）右腿两条腿粘在一起了，分界要出来',
    '2.（x：41.3%，y：57.4%）陶盆和虎尾兰对不上',
  ])

  // 工作区图同时有 name 和 rel 时**优先 rel**（比文件名唯一，agent 能直接定位）
  assert.equal(commentLines(list.slice(0, 1), { name: 'G3.png', rel: 'sub/G3.png' })[0], '图像 1：sub/G3.png')

  // 没有 sha（工作区图）⇒ 不带那对括号，但身份（rel）必须在
  assert.deepEqual(commentLines(list.slice(0, 1), { rel: 'sub/G3.png' }), [
    '图像 1：sub/G3.png',
    '1.（x：62.5%，y：31.0%）右腿两条腿粘在一起了，分界要出来',
  ])

  // 文案原样，不截断（200 字整条都在）
  const long = '长'.repeat(200)
  const [line] = commentLines([{ n: 1, xPct: 0, yPct: 0, text: long }], { rel: 'x.png' }).slice(1)
  assert.ok(line.endsWith(long), '用户输入一个字都不许截')
})

test('纯：身份锚定 —— 工作区图用 rel，对话图用附件 sha256', () => {
  const { anchorIdFor, shaOfDoc } = testApi
  const sha = 'a'.repeat(64)

  assert.equal(anchorIdFor({ rel: 'sub/a.png' }), 'sub/a.png')
  assert.equal(anchorIdFor({ rel: 'sha256:' + sha, attachmentId: 'sha256:' + sha }), 'sha256:' + sha)
  assert.equal(anchorIdFor({ rel: 'sha256:' + sha }), 'sha256:' + sha, '伪文档只有 id 没有 attachmentId 时也要认')
  assert.equal(anchorIdFor(null), '')

  assert.equal(shaOfDoc({ attachmentId: 'sha256:' + sha }), sha)
  assert.equal(shaOfDoc({ sha256: sha }), sha)
  assert.equal(shaOfDoc({ rel: 'a.png' }), '', '工作区图没有哈希就空串，不瞎猜')
})

test('纯：commentsFor / withComments 按身份存、删空不留垃圾键、不改入参', () => {
  const { commentsFor, withComments } = testApi

  const empty = {}
  const one = withComments(empty, 'a.png', [{ n: 1, xPct: 10, yPct: 20, text: 'x' }])
  assert.deepEqual(empty, {}, '不许原地改 state')
  assert.deepEqual(commentsFor(one, 'a.png'), [{ n: 1, xPct: 10, yPct: 20, text: 'x' }])
  assert.deepEqual(commentsFor(one, 'b.png'), [])

  const cleared = withComments(one, 'a.png', [])
  assert.equal(Object.prototype.hasOwnProperty.call(cleared, 'a.png'), false, '删到空要删键')
  assert.deepEqual(commentsFor(null, 'a.png'), [])
})

/* ── ① 纯函数：投递通道 ───────────────────────────────── */

test('投递：合成 paste 到 [data-composer-input]，文本逐字进输入框', async () => {
  const { deliverCommentText } = testApi
  const events = []
  const input = {
    textContent: '',
    focus() {},
    dispatchEvent(event) {
      events.push(event)
      this.textContent = event.clipboardData.getData('text/plain')
      return false       // 宿主接住了（preventDefault）
    },
  }
  const doc = {
    querySelector: (selector) => (selector === '[data-composer-input]' ? input : null),
    dispatchEvent: () => true,
  }
  const text = '图像 1：a.png\n1.（x：50.0%，y：50.0%）腿粘住了'
  const result = await deliverCommentText(text, { document: doc, window: {} })

  assert.deepEqual(result, { ok: true, via: 'paste', image: false })
  assert.equal(input.textContent, text, '投进输入框的是 §四 的原文')
  assert.equal(events.length, 1, '只投递一次（不自动发送、不重复粘贴）')
  assert.equal(events[0].type, 'paste')
  assert.equal(events[0].clipboardData.getData('text/plain'), text)
})

test('投递：评论要**把原图一起**作为附件 paste 进输入框（不只是文字）', async () => {
  const { deliverCommentText } = testApi
  const events = []
  const input = {
    textContent: '',
    focus() {},
    dispatchEvent(event) {
      events.push(event)
      this.textContent = event.clipboardData.getData('text/plain')
      return false
    },
  }
  const doc = { querySelector: () => input, dispatchEvent: () => true }
  const made = []
  class FakeFile {
    constructor(parts, name, options) {
      this.parts = parts
      this.name = name
      this.type = options.type
      made.push(this)
    }
  }
  const fakeFetch = async (url) => {
    assert.match(url, /^\/knit\/api\/(raw|attachment)\?/, '只读同源图片地址')
    return { ok: true, blob: async () => ({ size: 4, type: 'image/png' }) }
  }
  const text = '图像 1：sub/a.png\n1.（x：50.0%，y：50.0%）腿粘住了'
  const result = await deliverCommentText(text, {
    document: doc,
    window: {},
    fetch: fakeFetch,
    File: FakeFile,
    attachment: { src: '/knit/api/raw?sessionId=s1&rel=sub%2Fa.png', name: 'a.png' },
  })
  assert.deepEqual(result, { ok: true, via: 'paste', image: true })
  assert.equal(made.length, 1, '读成 File')
  assert.equal(made[0].name, 'a.png')
  assert.equal(made[0].type, 'image/png')
  assert.equal(events.length, 1, '图片与文本同一个 paste 事件')
  assert.equal(events[0].clipboardData.items[0].kind, 'file')
  assert.equal(events[0].clipboardData.items[0].getAsFile(), made[0], 'File 放进剪贴板 items')
  assert.equal(events[0].clipboardData.getData('text/plain'), text)
  assert.equal(input.textContent, text)
})

test('投递：图片读不到时仍投文本，并如实报告 image:false（不假装附件成功）', async () => {
  const { deliverCommentText } = testApi
  const input = { textContent: '', focus() {}, dispatchEvent() { this.textContent = 'x'; return false } }
  const doc = { querySelector: () => input, dispatchEvent: () => true }
  const result = await deliverCommentText('x', {
    document: doc,
    window: {},
    fetch: async () => { throw new Error('boom') },
    File: class {},
    attachment: { src: '/knit/api/raw?rel=a.png', name: 'a.png' },
  })
  assert.deepEqual(result, { ok: true, via: 'paste', image: false })
})

test('投递：输入框没接住 ⇒ document drop；再不行 ⇒ clipboard', async () => {
  const { deliverCommentText } = testApi

  // paste 返回 true 且文本没变 ⇒ 视为没接住
  const input = { textContent: '', focus() {}, dispatchEvent: () => true }
  const dropEvents = []
  const docDrop = {
    querySelector: () => input,
    dispatchEvent(event) { dropEvents.push(event); return false },
  }
  assert.deepEqual(await deliverCommentText('x', { document: docDrop, window: {} }), { ok: true, via: 'drop', image: false })
  assert.equal(dropEvents[0].type, 'drop')
  assert.equal(dropEvents[0].dataTransfer.getData('text/plain'), 'x')

  // drop 也没人接 ⇒ clipboard
  const written = []
  const docClipboard = {
    querySelector: () => input,
    dispatchEvent: () => true,
  }
  const win = { navigator: { clipboard: { writeText: async (value) => { written.push(value) } } } }
  assert.deepEqual(await deliverCommentText('y', { document: docClipboard, window: win }), { ok: true, via: 'clipboard', image: false })
  assert.deepEqual(written, ['y'])
})

test('投递：全部通道都不可用 ⇒ 明确失败，不假装成功', async () => {
  const { deliverCommentText } = testApi
  assert.deepEqual(await deliverCommentText('', { document: null, window: null }), { ok: false, via: 'none', image: false })
  const doc = { querySelector: () => null, dispatchEvent: () => true }
  assert.deepEqual(await deliverCommentText('z', { document: doc, window: {} }), { ok: false, via: 'none', image: false })
})

/** 只挂媒体面板（不打开任何查看器），用于验证 hover → 面板画布这条入口。 */
async function mountMediaPanel(payload = mediaPayload()) {
  installFetch((url) => {
    if (url.includes('/api/attachments')) return { ok: true, items: [] }
    if (url.includes('/api/doc')) return { ok: true, rel: 'x', title: 'x', text: '', truncated: false }
    return payload
  })
  const { KnitBody } = testApi
  harness.reset()
  harness.seed(['', 'time', 'media'])
  const render = () => harness.render(h(KnitBody, { sessionId: 's1' }))
  let nodes = render()
  await harness.flush()
  nodes = render()
  return { nodes, render }
}

/* ── ② 组件接线 ───────────────────────────────────────── */

test('评论：工具条二态入口 —— 进入后出现评论栏与落 pin 层，退出后一起消失', async () => {
  const { nodes, render } = await mountLightbox()
  let current = nodes
  assert.equal(byExactClass(current, 'knit-lightbox-comments').length, 0, '默认不该有评论栏')

  const button = commentButton(current)
  assert.ok(button, '工具条里应有评论按钮')
  assert.equal(textOf(button), '评论')
  assert.equal(button.props['aria-pressed'], 'false')

  toggleComment(current)
  current = render()
  assert.equal(byExactClass(current, 'knit-lightbox-comments').length, 1, '进入评论模式后底部浮出评论栏')
  assert.equal(byExactClass(current, 'knit-lightbox-pins').length, 1, '图片上盖一层 pin 覆盖层')
  assert.equal(textOf(commentButton(current)), '退出评论')
  assert.equal(commentButton(current).props['aria-pressed'], 'true')

  toggleComment(current)
  current = render()
  assert.equal(byExactClass(current, 'knit-lightbox-comments').length, 0)
  assert.equal(byExactClass(current, 'knit-lightbox-pins').length, 0)
  assert.equal(textOf(commentButton(current)), '评论')
})

test('评论：点图片落 pin（1..n）→ 就地输入 → Enter 保存；空文本不落；Esc 取消', async () => {
  const { nodes, render } = await mountLightbox()
  toggleComment(nodes)
  let current = render()

  // 第一次点：落一个 pin，并就地弹出输入框
  const stopped = clickImage(current, 50, 50)
  assert.equal(stopped, 1, '评论模式里点图必须 stopPropagation（否则查看器被点没了）')
  current = render()
  assert.equal(byExactClass(current, 'knit-lightbox-editor').length, 1, '落 pin 即就地弹输入框')
  const drafts = byClass(current, 'knit-lightbox-pin')
    .filter((n) => String(n.props.className).split(/\s+/).includes('knit-lightbox-pin'))
  assert.equal(drafts.length, 1, '草稿 pin 要画在点下去的那一点上')
  assert.match(String(drafts[0].props.className), /draft/, '它是草稿态，不是已保存的 pin')
  assert.equal(textOf(drafts[0]), '1', '草稿 pin 的编号就是即将保存的 n')
  assert.equal(byExactClass(current, 'knit-lightbox-comment-row').length, 0, '还没保存，评论栏里不出现')
  const editorText = textOf(byExactClass(current, 'knit-lightbox-editor')[0])
  assert.match(editorText, /新评论/, '气泡有标题（与 Infini 的「新标注」同一套语汇）')
  assert.match(editorText, /x 50\.0% · y 50\.0%/, '气泡里直接写这条评论的坐标')
  assert.match(editorText, /0\/200/, '气泡里带字数计数')

  // 空文本回车 ⇒ 不保存
  const emptyInput = byExactClass(current, 'knit-lightbox-editor-input')[0]
  emptyInput.props.onKeyDown({ key: 'Enter', preventDefault() {}, stopPropagation() {} })
  current = render()
  assert.equal(byExactClass(current, 'knit-lightbox-editor').length, 0)
  assert.equal(byClass(current, 'knit-lightbox-pin')
    .filter((n) => String(n.props.className).split(/\s+/).includes('knit-lightbox-pin')).length, 0,
  '空文本不落 pin（草稿也一起收掉）')

  // 再点一次：写一句，回车
  clickImage(current, 50, 50)
  current = render()
  current = typeAndEnter(current, '右腿两条腿粘在一起了，分界要出来', render)
  assert.deepEqual(pinLabels(current), ['1'], '编号从 1 起')
  assert.equal(byExactClass(current, 'knit-lightbox-comment-row').length, 1, '评论栏里多一行')
  assert.match(textOf(current), /右腿两条腿粘在一起了/, '评论栏显示文字摘要')

  // 第二次落点：编号 2
  clickImage(current, 20, 30)
  current = render()
  current = typeAndEnter(current, '陶盆和虎尾兰对不上', render)
  assert.deepEqual(pinLabels(current), ['1', '2'], '编号连续')

  // Esc 取消一个新草稿：不落
  clickImage(current, 80, 80)
  current = render()
  byExactClass(current, 'knit-lightbox-editor-input')[0].props.onKeyDown({ key: 'Escape', preventDefault() {}, stopPropagation() {} })
  current = render()
  assert.equal(byExactClass(current, 'knit-lightbox-editor').length, 0)
  assert.deepEqual(pinLabels(current), ['1', '2'], 'Esc 取消不新增')

  // pin 的编号/身份在 DOM 上；像素位置由 contentViewport（同一绘制矩形）算 ——
  // 替身没有 DOM，几何本身由下面的 commentPopoverBox / contentRect 纯函数真断言。
  const pins = byExactClass(current, 'knit-lightbox-pin')
  assert.deepEqual(pins.map((pin) => pin.props['data-knit-comment-pin']), ['1', '2'])
})

test('评论：点已有 pin 重编辑；删除后编号仍然连续', async () => {
  const { nodes, render } = await mountLightbox()
  toggleComment(nodes)
  let current = render()
  for (const [x, y, text] of [[10, 10, '第一条'], [40, 40, '第二条'], [70, 70, '第三条']]) {
    clickImage(current, x, y)
    current = render()
    current = typeAndEnter(current, text, render)
  }
  assert.deepEqual(pinLabels(current), ['1', '2', '3'])

  // 点第 2 个 pin → 编辑框里是原文
  const pin = byExactClass(current, 'knit-lightbox-pin')[1]
  pin.props.onClick({ stopPropagation() {} })
  current = render()
  const input = byExactClass(current, 'knit-lightbox-editor-input')[0]
  assert.equal(input.props.value, '第二条')
  assert.match(textOf(byExactClass(current, 'knit-lightbox-editor')[0]), /评论 2/, '编辑已有评论时标题带编号')
  input.props.onChange({ target: { value: '第二条（改）' } })
  current = render()
  byExactClass(current, 'knit-lightbox-editor-input')[0]
    .props.onKeyDown({ key: 'Enter', preventDefault() {}, stopPropagation() {} })
  current = render()
  assert.match(textOf(current), /第二条（改）/)

  // 删中间一条 → 剩下的重新从 1 连续编号（发送文本里不许出现 1. 3.）
  const del = byExactClass(current, 'knit-lightbox-comment-del')[1]
  del.props.onClick()
  current = render()
  assert.deepEqual(pinLabels(current), ['1', '2'])
  const rows = byExactClass(current, 'knit-lightbox-comment-row')
  assert.match(textOf(rows[1]), /第三条/, '删第 2 条后，原第 3 条补到第 2 位')

  // 编辑框里的「删除」也真的能删
  byExactClass(current, 'knit-lightbox-pin')[0].props.onClick({ stopPropagation() {} })
  current = render()
  const editor = byExactClass(current, 'knit-lightbox-editor')[0]
  const deleteButton = findNode(editor, (node) => node && node.type === 'button' && /删除/.test(textOf(node)))
  assert.ok(deleteButton, '编辑框里应有删除')
  deleteButton.props.onClick()
  current = render()
  assert.deepEqual(pinLabels(current), ['1'])
})

test('评论：切图各自保留、编号各自从 1 起；退出查看器再进评论仍在（本会话内存）', async () => {
  const { nodes, render } = await mountLightbox()
  toggleComment(nodes)
  let current = render()

  clickImage(current, 50, 50)
  current = render()
  current = typeAndEnter(current, 'a 图的问题', render)
  assert.deepEqual(pinLabels(current), ['1'])

  // 切到第二张图：评论栏是空的（各图各自保留）
  byClass(current, 'knit-lightbox-thumb')[1].props.onClick()
  current = render()
  assert.equal(byExactClass(current, 'knit-lightbox-comment-row').length, 0, 'b 图还没有评论')
  assert.equal(byExactClass(current, 'knit-lightbox-comments-empty').length, 1)

  clickImage(current, 30, 40)
  current = render()
  current = typeAndEnter(current, 'b 图的问题', render)
  assert.deepEqual(pinLabels(current), ['1'], 'b 图自己的编号也从 1 起')

  // 切回 a 图：它那条还在
  byClass(current, 'knit-lightbox-thumb')[0].props.onClick()
  current = render()
  assert.deepEqual(pinLabels(current), ['1'])
  assert.match(textOf(current), /a 图的问题/)

  // Esc 关掉查看器，再双击打开：评论仍在（内存；硬刷新才丢）
  const rootOf = (n) => byClass(n, 'knit-root')[0]
  rootOf(current).props.onKeyDownCapture({ key: 'Escape', preventDefault() {}, stopPropagation() {} })
  current = render()
  assert.equal(byExactClass(current, 'knit-lightbox').length, 0, '已关闭')
  await harness.flush()
  current = render()

  byClass(current, 'knit-media-card').filter((n) => String(n.props['data-knit-rel']).endsWith('.png'))[0].props.onDoubleClick()
  current = render()
  assert.equal(byExactClass(current, 'knit-lightbox').length, 1, '重新打开查看器')
  toggleComment(current)
  current = render()
  assert.match(textOf(current), /a 图的问题/, '退出再进，评论仍在（P0 内存）')
  assert.deepEqual(pinLabels(current), ['1'])
})

test('评论：发送只**投递** §四 文本到输入框，不自动发送', async () => {
  const { nodes, render } = await mountLightbox()
  toggleComment(nodes)
  let current = render()
  clickImage(current, 50, 50)
  current = render()
  current = typeAndEnter(current, '右腿两条腿粘在一起了，分界要出来', render)

  const events = []
  const composer = {
    textContent: '',
    focus() {},
    dispatchEvent(event) {
      events.push(event)
      this.textContent = event.clipboardData.getData('text/plain')
      return false
    },
  }
  globalThis.document = {
    // ensureStyle / KnitGlyph 在渲染期会问这两个；给个空壳免得把测试自己的假 document 弄崩
    getElementById: () => ({ id: 'dsh-knit-style' }),
    createElement: () => ({ style: {}, setAttribute() {} }),
    head: { appendChild() {} },
    querySelector: (selector) => (selector === '[data-composer-input]' ? composer : null),
    dispatchEvent: () => true,
  }
  const made = []
  class FakeFile {
    constructor(parts, name, options) { this.parts = parts; this.name = name; this.type = options.type; made.push(this) }
  }
  const realFetch = globalThis.fetch
  const realFile = globalThis.File
  globalThis.fetch = async () => ({ ok: true, blob: async () => ({ size: 4, type: 'image/png' }) })
  globalThis.File = FakeFile
  try {
    const send = current.find((n) => n && n.props && n.props['data-knit-comment-send'] === '1')
    assert.ok(send, '评论栏里应有发送按钮')
    await send.props.onClick()
    current = render()
  } finally {
    delete globalThis.document
    globalThis.fetch = realFetch
    if (realFile === undefined) delete globalThis.File
    else globalThis.File = realFile
  }

  assert.equal(composer.textContent, [
    '图像 1：a.png',
    '1.（x：50.0%，y：50.0%）右腿两条腿粘在一起了，分界要出来',
  ].join('\n'), '输入框里逐字是 §四 的文本')
  assert.equal(events.length, 1, '只 dispatch 了一次 paste —— 没有任何「自动发送」')
  assert.equal(events[0].type, 'paste')
  assert.equal(made.length, 1, '原图被读成 File 一起投递')
  assert.equal(events[0].clipboardData.items[0].getAsFile(), made[0], '图片在同一个 paste 事件里')
  assert.match(textOf(current), /已投进输入框/, '评论栏里如实说投递成功')
})

test('评论：输入框里的 Esc / 方向键归输入框，不许被查看器的捕获阶段抢走', async () => {
  const { nodes, render } = await mountLightbox()
  toggleComment(nodes)
  let current = render()
  clickImage(current, 50, 50)
  current = render()
  assert.equal(byExactClass(current, 'knit-lightbox-editor').length, 1, '前提：编辑框开着')

  // 模拟「事件 target 落在编辑框里」：查看器根的捕获处理器必须直接放行
  const calls = { prevented: 0, stopped: 0 }
  const inEditor = {
    isContentEditable: false,
    closest: (selector) => (selector === '[data-knit-comment-editor]' ? { nodeType: 1 } : null),
  }
  byClass(current, 'knit-root')[0].props.onKeyDownCapture({
    key: 'Escape',
    target: inEditor,
    preventDefault() { calls.prevented += 1 },
    stopPropagation() { calls.stopped += 1 },
  })
  assert.deepEqual(calls, { prevented: 0, stopped: 0 }, '编辑框内的 Esc 不许被查看器拦')
  assert.equal(byExactClass(render(), 'knit-lightbox').length, 1, '查看器没被关掉')
})

test('评论：非评论模式下的既有语义没变（点图不关、点图外关、Esc 关）', async () => {
  const { nodes, render } = await mountLightbox()
  const box = byExactClass(nodes, 'knit-lightbox')[0]
  let stopped = 0
  byExactClass(nodes, 'knit-lightbox-img')[0].props.onClick({ stopPropagation() { stopped += 1 } })
  assert.equal(stopped, 1, '默认模式点图仍然 stopPropagation')
  assert.equal(byExactClass(render(), 'knit-lightbox').length, 1)
  box.props.onClick()
  assert.equal(byExactClass(render(), 'knit-lightbox').length, 0, '点图片以外照旧关闭')
})

test('评论：悬停大图点一下 → 在 **Knit 面板里**打开画布（不盖会话），且评论模式已开', async () => {
  const { nodes, render } = await mountMediaPanel()
  const card = byClass(nodes, 'knit-media-card').find((n) => String(n.props['data-knit-rel']).endsWith('.png'))
  card.props.onMouseEnter({ currentTarget: null })
  harness.tick()
  let current = render()
  const shot = byExactClass(current, 'knit-shot')[0]
  assert.ok(shot, '前提：悬停大图出来了')
  assert.equal(shot.props['data-knit-hover-shot'], '1')
  assert.match(textOf(shot), /评论/, '浮窗上写着「评论」——它现在是入口')

  shot.props.onClick({ stopPropagation() {} })
  current = render()
  const box = lightboxRoot(current)
  assert.ok(box, '打开的是画布')
  assert.match(String(box.props.className), /docked/, '默认落在面板画布（docked），不是整屏')
  assert.equal(box.props['aria-modal'], 'false', '面板画布不是模态：会话不被盖住')
  assert.equal(byExactClass(current, 'knit-canvas').length, 1, '画布挂在 Knit 面板里')
  assert.equal(byExactClass(current, 'knit-lightbox-rail').length, 0, '面板画布不需要左侧缩略图带')
  assert.equal(byExactClass(current, 'knit-lightbox-comments').length, 1, '直接进评论模式：底部评论栏在')
  assert.match(textOf(current), /点一下图片上的位置/, '空态要教用户怎么开始（不是只写「还没有评论」）')
  assert.ok(current.find((n) => n && n.props && n.props['data-knit-canvas-next'] === '1'), '画布里有「下一张」')
  assert.ok(current.find((n) => n && n.props && n.props['data-knit-canvas-prev'] === '1'), '画布里有「上一张」')
  const imgSrc = () => byExactClass(current, 'knit-lightbox-img')[0].props.src
  const first = imgSrc()
  current.find((n) => n && n.props && n.props['data-knit-canvas-next'] === '1')
    .props.onClick({ stopPropagation() {} })
  current = render()
  assert.notEqual(imgSrc(), first, '「下一张」能换图')
  const second = imgSrc()
  lightboxRoot(current).props.onWheel({ deltaY: 120, target: null })
  current = render()
  assert.notEqual(imgSrc(), second, '画布上滚轮也能换图（不用只能返回）')

  // 面板画布里点图 → 落 pin → 写 → 保存（与整屏共用同一套逻辑）
  clickImage(current, 40, 60)
  current = render()
  typeAndEnter(current, '面板画布里也能直接评', render)
  current = render()
  assert.deepEqual(pinLabels(current), ['1'])
  assert.equal(byExactClass(current, 'knit-lightbox-comment-row').length, 1)
})

test('评论：画布 ↔ 全屏 切换不丢评论；返回回到媒体网格', async () => {
  const { nodes, render } = await mountMediaPanel()
  const card = byClass(nodes, 'knit-media-card').find((n) => String(n.props['data-knit-rel']).endsWith('.png'))
  card.props.onMouseEnter({ currentTarget: null })
  harness.tick()
  let current = render()
  byExactClass(current, 'knit-shot')[0].props.onClick({ stopPropagation() {} })
  current = render()
  clickImage(current, 30, 40)
  current = render()
  typeAndEnter(current, '切换不丢', render)
  current = render()
  assert.deepEqual(pinLabels(current), ['1'])

  const full = current.find((n) => n && n.props && n.props['data-knit-canvas-fullscreen'] === '1')
  assert.ok(full, '画布工具条里有「全屏」')
  full.props.onClick({ stopPropagation() {} })
  current = render()
  assert.doesNotMatch(String(lightboxRoot(current).props.className), /docked/, '切到整屏')
  assert.equal(lightboxRoot(current).props['aria-modal'], 'true')
  assert.deepEqual(pinLabels(current), ['1'], '评论跟着走，不丢')

  const dock = current.find((n) => n && n.props && n.props['data-knit-canvas-dock'] === '1')
  assert.ok(dock, '整屏工具条里有「画布」')
  dock.props.onClick({ stopPropagation() {} })
  current = render()
  assert.match(String(lightboxRoot(current).props.className), /docked/)
  assert.deepEqual(pinLabels(current), ['1'], '切回来评论仍在')

  const back = current.find((n) => n && n.props && n.props['data-knit-canvas-back'] === '1')
  assert.ok(back, '画布工具条里有「返回」')
  back.props.onClick({ stopPropagation() {} })
  current = render()
  assert.equal(byExactClass(current, 'knit-lightbox').length, 0, '返回关掉画布')
  assert.ok(byClass(current, 'knit-media-card').length > 0, '回到媒体网格')
})

/* ── ③ 源码守卫 ───────────────────────────────────────── */

test('守卫：落点百分比只能从 contentRect 算 —— 不许出现拿 stage 宽度算的代码', () => {
  const start = SOURCE.indexOf('function commentClickPct')
  assert.ok(start > 0, 'commentClickPct 必须存在（它是落点唯一的入口）')
  const end = SOURCE.indexOf('\n    /**', start + 1)
  const body = SOURCE.slice(start, end > start ? end : undefined)

  assert.match(body, /contentRect\(/, '落点必须先算「实际绘制矩形」')
  assert.match(body, /pctFromPoint\(/, '百分比必须由 pctFromPoint 从矩形算')
  assert.ok(!/stage/i.test(body), 'commentClickPct 里根本不该出现 stage（拿 stage 算 = pin 整体偏移）')
  assert.ok(!/devicePixelRatio/.test(body), '几何只用 CSS px，不读 DPR')

  // 渲染层：pin 的像素位置 = 同一个绘制矩形（commentBox）上的百分比，不另算一套
  assert.match(SOURCE, /commentBox\.left \+ \(commentBox\.width \* item\.xPct\) \/ 100/,
    'pin 必须用 commentBox（与落点同一个绘制矩形）算像素位置')
  assert.match(SOURCE, /commentBox\.top \+ \(commentBox\.height \* item\.yPct\) \/ 100/,
    '纵坐标同理')
})

test('守卫：pin 与编辑气泡共用绘制矩形，且缩放/滚动会重算', () => {
  assert.match(SOURCE, /const rect = contentViewportOf\(img\)/,
    '几何必须来自 contentViewportOf（图片实际绘制矩形）')
  assert.match(SOURCE, /srect = surface\.getBoundingClientRect\(\)/,
    '整屏 / 面板画布共用同一套「表面坐标」，不能各算各的')
  assert.match(SOURCE, /typeof ResizeObserver !== 'undefined'/, '必须用 ResizeObserver 跟踪尺寸变化')
  assert.match(SOURCE, /addEventListener\('resize', measureCommentBox\)/, '窗口缩放要重算')
  assert.match(SOURCE, /addEventListener\('scroll', measureCommentBox, true\)/, '滚动也要重算')
})

test('守卫：评论 UI 的颜色一律走语义 token，零硬编码色值', () => {
  const start = SOURCE.indexOf('const CSS = `') + 'const CSS = `'.length
  const css = SOURCE.slice(start, SOURCE.indexOf('`', start))
  const from = css.indexOf('.knit-lightbox-pins{')
  const to = css.indexOf('.knit-preview{', from)
  assert.ok(from > 0 && to > from, '评论那段 CSS 必须找得到')
  // 注释里提到色值不算（比如「别写 #fff」这种说明），只看真实声明
  const block = css.slice(from, to).replace(/\/\*[\s\S]*?\*\//g, '')

  assert.ok(!/#[0-9a-fA-F]{3,8}\b/.test(block), '评论样式里不许出现 hex 色值')
  assert.ok(!/\brgba?\(/.test(block), '评论样式里不许出现 rgb / rgba')
  assert.ok(!/\bhsla?\(/.test(block), '评论样式里不许出现 hsl / hsla')
  assert.match(block, /var\(--dsw-alias-brand-primary-new-colorprimary-new-color\)/,
    'pin 用品牌强调色 token')
})

test('守卫：工具条 / 关闭 / 缩略图带 / 评论栏必须压在 stage 之上（真机踩过）', () => {
  const start = SOURCE.indexOf('const CSS = `') + 'const CSS = `'.length
  const css = SOURCE.slice(start, SOURCE.indexOf('`', start))
  const rule = (selector) => {
    const match = css.match(new RegExp(selector + '\\{([^}]*)\\}'))
    assert.ok(match, `应有 ${selector} 的样式`)
    return match[1]
  }
  // stage 为了摆 pin 覆盖层必须是 positioned；一旦它 positioned，DOM 里排在它前面的
  // 工具条就会被 stage 盖住（真机上「评论」按钮点不到，点了是点图 = 关查看器）。
  assert.match(rule('\\.knit-lightbox-stage'), /position:relative/)
  for (const selector of ['\\.knit-lightbox-tools', '\\.knit-lightbox-close', '\\.knit-lightbox-rail', '\\.knit-lightbox-comments']) {
    assert.match(rule(selector), /z-index:\s*\d+/, `${selector} 必须显式抬到 stage 之上`)
  }
})

test('守卫：客户端热换（HMR）后样式表必须跟着更新 —— 不能「有 style 元素就跳过」', () => {
  const start = SOURCE.indexOf('function ensureStyle')
  assert.ok(start > 0, 'ensureStyle 必须存在')
  const end = SOURCE.indexOf('\n    /**', start + 1)
  const body = SOURCE.slice(start, end > start ? end : undefined)
  // 旧版只有 `if (document.getElementById(STYLE_ID)) return`：HMR 只换 JS 不换页面时，
  // 新加的 CSS 一条都不生效（真机表现：评论气泡/评论栏被当成 flex 子项挤到图片右侧）。
  assert.match(body, /existing\.textContent !== CSS/, '样式内容变了必须比对出来')
  assert.match(body, /existing\.textContent = CSS/, '变了就整段替换，下一次渲染追上代码')
})

test('守卫：面板画布与整屏查看器共用同一份 DOM（docked 只换定位，评论逻辑不分叉）', () => {
  assert.ok(SOURCE.includes('const lightboxContent = lightboxDoc'),
    '画布内容必须只构造一次')
  assert.ok(SOURCE.includes("className: `knit-lightbox${lightboxDock ? ' docked' : ''}`"),
    'docked 只是同一个根上的一个 class')
  assert.ok(SOURCE.includes('mountLightbox(lightboxContent)'),
    '整屏挂载的是同一份内容')
  assert.ok(SOURCE.includes("h('div', { className: 'knit-canvas' }, lightboxContent)"),
    '面板画布挂载的也是同一份内容')
  const start = SOURCE.indexOf('const CSS = `') + 'const CSS = `'.length
  const css = SOURCE.slice(start, SOURCE.indexOf('`', start))
  assert.match(css, /\.knit-canvas\{/, '要有面板画布的容器')
  assert.match(css, /\.knit-lightbox\.docked\{/, '要有 docked 的定位覆盖')
  // 评论栏要与画布有明确分界（用户反馈「红框区别太低」）
  assert.match(css, /\.knit-lightbox-comments\{[^}]*border:\.5px solid var\(--dsw-alias-border-l4\)/,
    '评论栏必须有可见描边')
  assert.match(css, /\.knit-lightbox-comments-send\{[^}]*background:var\(--dsw-alias-brand-primary-new-colorprimary-new-color\)/,
    '发送必须是主操作（品牌色按钮），不是灰字')
  assert.match(css, /\.knit-lightbox-comments-emptyHint\{/, '空态要有下一步提示')
})

test('守卫：发送必须带原图附件（只发文字会被 agent 当成「不知道是哪张图」）', () => {
  assert.match(SOURCE, /attachment: \{\s*src: srcFor\(lightboxDoc\)/,
    'sendComments 必须把图片地址交给投递层')
  assert.match(SOURCE, /buildPasteEvent\(payload, win, file\)/,
    'paste 事件必须同时带文本与 File')
  assert.match(SOURCE, /async function imageFileFrom\(/, '图片要读成 File')
  assert.match(SOURCE, /credentials: 'same-origin'/, '只读同源图片，不碰外网')
})

test('守卫：评论 P0 不落盘 —— 不新增 localStorage 键，也不碰 dsh-knit:pack', () => {
  const start = SOURCE.indexOf('const [commentOn, setCommentOn]')
  const end = SOURCE.indexOf('return h(\'div\', {', start)
  const block = SOURCE.slice(start, end)
  assert.ok(!/writePref|readPref|localStorage/.test(block),
    '评论只活在内存（退出查看器仍在、刷新丢）；落盘是 P1 的事')
  assert.ok(!SOURCE.includes('dsh-knit:comment'), '不许新增 dsh-knit:comment 之类存储键')
  assert.ok(!SOURCE.includes('dsh-knit:pack'), '§6.4 的老守卫仍要绿：不许出现 dsh-knit:pack')
})

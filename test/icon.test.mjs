/**
 * 图标测试：Knit 的 mono SVG 图标（右边栏 / guide 胶囊 / tab 芯片）。
 *
 * 图标是内联在客户端代码里的（无构建步骤，加载期不能读文件），
 * 源文件在 `assets/knit-icon-24-mono-4px.svg` —— 这里同时守住两者一致。
 *
 * 跑法：node --test test/
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { loadClientModule, createHarness, byClass } from './harness.mjs'

const harness = createHarness()
const React = globalThis.__knitReact
const h = React.createElement

const CLIENT_SOURCE = readFileSync(new URL('../src/client/client.js', import.meta.url), 'utf8')
const SVG_SOURCE = readFileSync(
  new URL('../assets/knit-icon-24-mono-4px.svg', import.meta.url),
  'utf8',
)

/* ── 图标本体 ───────────────────────────────────────── */

test('图标：渲染成 svg，带正确的 viewBox 与描边参数', () => {
  const { exports } = loadClientModule()
  const { KnitGlyph } = exports.__test

  harness.reset()
  const nodes = harness.render(h(KnitGlyph, { size: 16 }))
  const svg = nodes.find((n) => n.type === 'svg')

  assert.ok(svg, '应渲染出 <svg>')
  assert.equal(svg.props.width, 16)
  assert.equal(svg.props.height, 16)
  assert.equal(svg.props.viewBox, '0 0 100 100', 'viewBox 必须与源文件一致')
  assert.equal(svg.props.stroke, 'currentColor', '颜色交给 CSS 控制')
  assert.equal(svg.props.fill, 'none')
  assert.equal(svg.props.strokeWidth, 16.67, '4px 描边（100 单位 viewBox）')
  assert.equal(svg.props['aria-hidden'], 'true', '装饰性图标要对读屏隐藏')
})

test('图标：默认 16px，显式尺寸生效', () => {
  const { exports } = loadClientModule()
  const { KnitGlyph } = exports.__test

  harness.reset()
  const dflt = harness.render(h(KnitGlyph, {})).find((n) => n.type === 'svg')
  assert.equal(dflt.props.width, 16)

  harness.reset()
  const big = harness.render(h(KnitGlyph, { size: 24 })).find((n) => n.type === 'svg')
  assert.equal(big.props.width, 24)
  assert.equal(big.props.height, 24)
})

test('图标：class 恒带 knit-icon（配色靠它），额外 class 会被拼上', () => {
  const { exports } = loadClientModule()
  const { KnitGlyph } = exports.__test

  harness.reset()
  const plain = harness.render(h(KnitGlyph, {})).find((n) => n.type === 'svg')
  assert.equal(plain.props.className, 'knit-icon')

  harness.reset()
  const extra = harness.render(h(KnitGlyph, { className: 'x' })).find((n) => n.type === 'svg')
  assert.equal(extra.props.className, 'knit-icon x')
})

test('图标：内联的 path 与 assets 里的源文件逐字一致', () => {
  const { exports } = loadClientModule()
  const { KNIT_ICON_PATH } = exports.__test

  const fromSvg = /\sd="([^"]+)"/.exec(SVG_SOURCE)[1]

  assert.equal(
    KNIT_ICON_PATH,
    fromSvg,
    '内联 path 与 assets/knit-icon-24-mono-4px.svg 不一致 —— 改图标时两处要一起改',
  )
})

/* ── 配色（用户明确要求：浅色纯黑、暗色纯白）─────────── */

test('配色：浅色模式纯黑、暗色模式纯白（锁死这条要求）', () => {
  assert.match(
    CLIENT_SOURCE,
    /\.knit-icon\s*\{\s*color:\s*#000\s*\}/,
    '缺少浅色模式的纯黑规则',
  )
  assert.match(
    CLIENT_SOURCE,
    /body\[data-ds-dark-theme\]\s+\.knit-icon\s*\{\s*color:\s*#fff\s*\}/,
    '缺少暗色模式的纯白规则（DSH 的暗色信号挂在 body 上）',
  )
})

test('配色：图标不依赖面板先渲染（样式表由图标自己保证注入）', () => {
  const glyph = CLIENT_SOURCE.slice(CLIENT_SOURCE.indexOf('function KnitGlyph'))
  const body = glyph.slice(0, glyph.indexOf('\n    }'))
  assert.match(
    body,
    /ensureStyle\(\)/,
    'KnitGlyph 必须自己调 ensureStyle —— guide 胶囊与 tab 芯片会在 KnitBody 之前渲染',
  )
})

/* ── 用在哪儿 ───────────────────────────────────────── */

test('tab 芯片标题：图标 + 名称，且不再用 emoji', () => {
  const { exports } = loadClientModule()
  const { KnitTitle } = exports.__test

  harness.reset()
  const nodes = harness.render(h(KnitTitle, {}))
  const svg = nodes.find((n) => n.type === 'svg')

  assert.ok(svg, '芯片标题应带 SVG 图标')
  assert.equal(svg.props.width, 16)

  const text = nodes.flatMap((n) => (n.children || []).filter((c) => typeof c === 'string')).join('')
  assert.equal(text, 'Knit', '图标旁边是类型名')

  const all = JSON.stringify(nodes.map((n) => n.children))
  assert.ok(!all.includes('🧶'), '芯片标题里不该再有毛球 emoji')
})

test('注册：guide 胶囊与 better-sidebar tab 都用同一个图标组件', () => {
  const uses = CLIENT_SOURCE.match(/icon:\s*KnitGlyph/g) || []
  assert.equal(uses.length, 2, `应有 2 处（guide 胶囊 + better-sidebar tab），实际 ${uses.length}`)
})

test('会话头部入口按钮：也用同一个 mono 图标', () => {
  const { exports } = loadClientModule()
  const { makeEntryButton } = exports.__test

  harness.reset()
  const nodes = harness.render(h(makeEntryButton(() => true), {}))
  const svg = nodes.find((n) => n.type === 'svg')

  assert.ok(svg, '入口按钮里应是 SVG 图标')
  assert.equal(svg.props.width, 16)
  assert.equal(svg.props.className, 'knit-icon', '和右边栏用同一套配色')
})

test('全项目不再有毛球 emoji', () => {
  assert.ok(
    !CLIENT_SOURCE.includes('🧶'),
    '客户端源码里不该再出现 🧶 —— 右边栏与入口按钮都已换成 mono 图标',
  )
})

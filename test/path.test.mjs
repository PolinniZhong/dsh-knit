/**
 * 「打开本地文件夹」测试：点头部那行工作区路径 → 用系统文件管理器打开它。
 *
 * 走官方 Remote：`ctx.remote.session.openWorkspacePath({ path })`，
 * 返回值是一个信封（`{ ok, value } | { ok: false, error }`）。
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
 * 装载模块并 apply 到一个带 remote.session 的假上下文。
 *
 * @param {object} [options] - `openWorkspacePath` 的实现，省略表示没有该服务
 * @returns {{exports: object, calls: object[], log: object}} 结果与调用记录
 */
function boot(options = {}) {
  const loaded = loadClientModule()
  const log = { effects: [] }
  const { locale } = makeLocale({ active: 'zh' })

  const services = { slots: { inject(n, cb) { cb(); return () => {} }, register() { return () => {} } } }
  if (options.openWorkspacePath) {
    services['remote.session'] = { openWorkspacePath: options.openWorkspacePath }
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
  return { exports: loaded.exports, log }
}

/**
 * 造一份列表载荷。
 * @param {object} [overrides] - 覆盖字段
 * @returns {object} 载荷
 */
function listPayload(overrides = {}) {
  return {
    ok: true,
    root: '/Users/me/proj',
    total: 1,
    mode: 'time',
    topic: '',
    docs: [{ path: '/Users/me/proj/a.md', rel: 'a.md', name: 'a.md', title: 'A', summary: 's', mtimeMs: Date.now(), score: null }],
    ...overrides,
  }
}

/**
 * 渲染到列表加载完成，返回扁平节点。
 * @returns {Promise<object[]>} 节点
 */
async function render() {
  globalThis.fetch = async () => ({ json: async () => listPayload() })
  const { KnitBody } = boot({ openWorkspacePath: async () => ({ ok: true, value: { opened: true } }) }).exports.__test
  harness.reset()
  let nodes = harness.render(h(KnitBody, { sessionId: 's1' }))
  await harness.flush()
  nodes = harness.render(h(KnitBody, { sessionId: 's1' }))
  return nodes
}

/* ── 渲染 ───────────────────────────────────────────── */

test('路径：渲染成一个可点的 button，带手型与提示', async () => {
  const nodes = await render()
  const path = byClass(nodes, 'knit-root-path')[0]

  assert.ok(path, '应有工作区路径')
  assert.equal(path.type, 'button', '必须是 button（才能点击 + 无障碍）')
  assert.equal(path.props.type, 'button')
  assert.equal(path.props.disabled, false)
  assert.equal(path.props.title, '在文件管理器中打开')
  assert.match(textOf(path), /08_Knit|proj/, '显示的就是工作区路径')
})

test('路径：没有工作目录时按钮禁用，且没有提示文案', async () => {
  globalThis.fetch = async () => ({ json: async () => listPayload({ root: '', docs: [] }) })
  const { KnitBody } = boot({ openWorkspacePath: async () => ({ ok: true, value: { opened: true } }) }).exports.__test
  harness.reset()
  let nodes = harness.render(h(KnitBody, { sessionId: 's1' }))
  await harness.flush()
  nodes = harness.render(h(KnitBody, { sessionId: 's1' }))

  const path = byClass(nodes, 'knit-root-path')[0]
  assert.equal(path.props.disabled, true)
  assert.equal(path.props.title, '')
  assert.doesNotThrow(() => path.props.onClick())
})

/* ── 行为 ───────────────────────────────────────────── */

test('路径：点击调 openWorkspacePath，参数是当前工作区绝对路径', async () => {
  const calls = []
  globalThis.fetch = async () => ({ json: async () => listPayload() })
  const { KnitBody } = boot({
    openWorkspacePath: async (request) => { calls.push(request); return { ok: true, value: { opened: true } } },
  }).exports.__test

  harness.reset()
  let nodes = harness.render(h(KnitBody, { sessionId: 's1' }))
  await harness.flush()
  nodes = harness.render(h(KnitBody, { sessionId: 's1' }))

  byClass(nodes, 'knit-root-path')[0].props.onClick()
  await harness.flush()

  assert.equal(calls.length, 1, '应调用一次')
  assert.deepEqual(calls[0], { path: '/Users/me/proj' }, '参数是绝对路径')
})

test('路径：信封 ok:false 时把原因显示出来，不静默失败', async () => {
  globalThis.fetch = async () => ({ json: async () => listPayload() })
  const { KnitBody } = boot({
    openWorkspacePath: async () => ({ ok: false, error: { code: 'boom', message: 'no opener' } }),
  }).exports.__test

  harness.reset()
  let nodes = harness.render(h(KnitBody, { sessionId: 's1' }))
  await harness.flush()
  nodes = harness.render(h(KnitBody, { sessionId: 's1' }))

  byClass(nodes, 'knit-root-path')[0].props.onClick()
  await harness.flush()
  nodes = harness.render(h(KnitBody, { sessionId: 's1' }))

  const notice = byClass(nodes, 'knit-notice').map(textOf).join('')
  assert.match(notice, /打开失败/, '应给出可见提示')
  assert.match(notice, /no opener/, '应带上具体原因')
})

test('路径：remote 抛异常时不崩，转成提示', async () => {
  globalThis.fetch = async () => ({ json: async () => listPayload() })
  const { KnitBody } = boot({
    openWorkspacePath: async () => { throw new Error('transport down') },
  }).exports.__test

  harness.reset()
  let nodes = harness.render(h(KnitBody, { sessionId: 's1' }))
  await harness.flush()
  nodes = harness.render(h(KnitBody, { sessionId: 's1' }))

  await assert.doesNotReject(async () => {
    byClass(nodes, 'knit-root-path')[0].props.onClick()
    await harness.flush()
  })
  nodes = harness.render(h(KnitBody, { sessionId: 's1' }))
  assert.match(byClass(nodes, 'knit-notice').map(textOf).join(''), /transport down/)
})

test('路径：没有 remote.session 服务时给出提示而不是白点一下', async () => {
  globalThis.fetch = async () => ({ json: async () => listPayload() })
  const { KnitBody } = boot({}).exports.__test   // 不提供 remote.session

  harness.reset()
  let nodes = harness.render(h(KnitBody, { sessionId: 's1' }))
  await harness.flush()
  nodes = harness.render(h(KnitBody, { sessionId: 's1' }))

  byClass(nodes, 'knit-root-path')[0].props.onClick()
  await harness.flush()
  nodes = harness.render(h(KnitBody, { sessionId: 's1' }))

  assert.ok(byClass(nodes, 'knit-notice').length >= 1, '应给出可见提示')
})

test('路径：成功时不残留上一次的错误提示', async () => {
  globalThis.fetch = async () => ({ json: async () => listPayload() })
  let fail = true
  const { KnitBody } = boot({
    openWorkspacePath: async () => (fail ? { ok: false, error: { message: 'nope' } } : { ok: true, value: { opened: true } }),
  }).exports.__test

  harness.reset()
  let nodes = harness.render(h(KnitBody, { sessionId: 's1' }))
  await harness.flush()
  nodes = harness.render(h(KnitBody, { sessionId: 's1' }))

  byClass(nodes, 'knit-root-path')[0].props.onClick()
  await harness.flush()
  nodes = harness.render(h(KnitBody, { sessionId: 's1' }))
  assert.equal(byClass(nodes, 'knit-notice').length, 1, '先失败，有提示')

  fail = false
  byClass(nodes, 'knit-root-path')[0].props.onClick()
  await harness.flush()
  nodes = harness.render(h(KnitBody, { sessionId: 's1' }))
  assert.equal(byClass(nodes, 'knit-notice').length, 0, '再成功，提示应清掉')
})

/* ── 预览头那行路径：点它＝在文件管理器里**定位到这个文件** ──
   走的是同一个 remote（`openWorkspacePath`），多带一个 `action: 'reveal'`
   （主机侧 macOS `open -R` / Windows `explorer /select,`）—— 打开所在文件夹**并选中**它，
   用户不必再自己找。与页脚「本地打开」刻意分开：那个打开文件，这个只定位文件。
   ⚠️ reveal 要的是**文件本身**的绝对路径；传目录过去会变成「在上级目录里选中这个文件夹」。 */

test('路径：点预览头的路径＝在文件管理器里定位到「这个文件」（reveal，不是打开目录）', async () => {
  const calls = []
  globalThis.fetch = async (url) => ({
    json: async () => (String(url).includes('/api/doc')
      ? { ok: true, rel: 'a.md', title: 'A', text: '正文', truncated: false }
      : listPayload()),
  })
  const { KnitBody } = boot({
    openWorkspacePath: async (request) => { calls.push(request); return { ok: true, value: { opened: true } } },
  }).exports.__test

  harness.reset()
  let nodes = harness.render(h(KnitBody, { sessionId: 's1' }))
  await harness.flush()
  nodes = harness.render(h(KnitBody, { sessionId: 's1' }))
  byClass(nodes, 'knit-doc')[0].props.onClick()
  nodes = harness.render(h(KnitBody, { sessionId: 's1' }))

  byExactClass(nodes, 'knit-preview-path')[0].props.onClick()
  await harness.flush()

  assert.equal(calls.length, 1, '应调用一次')
  assert.deepEqual(calls[0], { path: '/Users/me/proj/a.md', action: 'reveal' },
    'reveal 的是文件本身的绝对路径，且带上 action')
})

test('路径：宿主没给 path 时用 root + rel 兜底，reveal 的仍然是文件本身', async () => {
  const calls = []
  const payload = listPayload({
    docs: [{ rel: 'sub/b.md', name: 'b.md', title: 'B', summary: 's', mtimeMs: Date.now(), score: null }],
  })
  globalThis.fetch = async (url) => ({
    json: async () => (String(url).includes('/api/doc')
      ? { ok: true, rel: 'sub/b.md', title: 'B', text: '正文', truncated: false }
      : payload),
  })
  const { KnitBody } = boot({
    openWorkspacePath: async (request) => { calls.push(request); return { ok: true, value: { opened: true } } },
  }).exports.__test

  harness.reset()
  let nodes = harness.render(h(KnitBody, { sessionId: 's1' }))
  await harness.flush()
  nodes = harness.render(h(KnitBody, { sessionId: 's1' }))
  byClass(nodes, 'knit-doc')[0].props.onClick()
  nodes = harness.render(h(KnitBody, { sessionId: 's1' }))

  byExactClass(nodes, 'knit-preview-path')[0].props.onClick()
  await harness.flush()

  assert.deepEqual(calls[0], { path: '/Users/me/proj/sub/b.md', action: 'reveal' },
    'root + rel 拼出文件本身，再去定位 —— 不是把目录送过去')
})

test('路径：拼不出绝对路径时按钮 disabled，点了也不发请求', async () => {
  const calls = []
  globalThis.fetch = async (url) => ({
    json: async () => (String(url).includes('/api/doc')
      ? { ok: true, rel: 'sub/b.md', title: 'B', text: '正文', truncated: false }
      : listPayload({
        root: '',
        docs: [{ rel: 'sub/b.md', name: 'b.md', title: 'B', summary: 's', mtimeMs: Date.now(), score: null }],
      })),
  })
  const { KnitBody } = boot({
    openWorkspacePath: async (request) => { calls.push(request); return { ok: true, value: { opened: true } } },
  }).exports.__test

  harness.reset()
  let nodes = harness.render(h(KnitBody, { sessionId: 's1' }))
  await harness.flush()
  nodes = harness.render(h(KnitBody, { sessionId: 's1' }))
  byClass(nodes, 'knit-doc')[0].props.onClick()
  nodes = harness.render(h(KnitBody, { sessionId: 's1' }))

  const pathBtn = byExactClass(nodes, 'knit-preview-path')[0]
  assert.equal(pathBtn.props.disabled, true, 'root 与 path 都拿不到 → 不给点')
  pathBtn.props.onClick()                     // 回调里也有守卫，不该抛也不该发请求
  await harness.flush()
  assert.equal(calls.length, 0)
})

/**
 * v0.10：预览头右上角那个位置从「新标签页」换成了「本地打开」。
 *
 * 动机：「新标签页」开的是官方文档预览，但面板里已经有就地预览（重复度高、
 * 用得少）；而「用默认应用打开这篇文档」原本只藏在路径面包屑的悬停提示里。
 * 把值钱的那个放到显眼处。双击列表行仍能开新标签页 —— 所以这条要同时断言
 * **头部不再有「新标签页」**。
 */
test('预览头：右上角是「本地打开」，点击打开这篇文档', async () => {
  const calls = []
  globalThis.fetch = async (url) => ({
    json: async () => (String(url).includes('/api/doc')
      ? { ok: true, rel: 'a.md', title: 'A', text: '正文', truncated: false }
      : listPayload()),
  })
  const { KnitBody } = boot({
    openWorkspacePath: async (request) => { calls.push(request); return { ok: true, value: { opened: true } } },
  }).exports.__test

  harness.reset()
  let nodes = harness.render(h(KnitBody, { sessionId: 's1' }))
  await harness.flush()
  nodes = harness.render(h(KnitBody, { sessionId: 's1' }))
  byClass(nodes, 'knit-doc')[0].props.onClick()
  nodes = harness.render(h(KnitBody, { sessionId: 's1' }))

  const headBtns = byClass(nodes, 'knit-btn')
  const labels = headBtns.map(textOf)
  assert.ok(labels.includes('本地打开'), '头部有「本地打开」按钮，实际：' + labels.join(' / '))
  assert.ok(!labels.includes('新标签页'), '「新标签页」已从头部移除，实际：' + labels.join(' / '))

  const localBtn = headBtns.find((n) => textOf(n) === '本地打开')
  assert.notEqual(localBtn.props.disabled, true, '有服务时不禁用')
  // tooltip 里带完整相对路径 —— 与路径面包屑同一套提示
  assert.match(String(localBtn.props.title), /a\.md/, 'tooltip 里带相对路径')
  localBtn.props.onClick()
  await harness.flush()
  // ⚠️ **不带 `action: 'reveal'`** —— 这是与面包屑那条的分水岭：
  //    面包屑只定位文件（在文件管理器里选中它），这个按钮真去打开文件。
  assert.deepEqual(calls[0], { path: '/Users/me/proj/a.md' }, '打开的是这篇文档的绝对路径')
})

test('预览头：没有 remote.session 时「本地打开」给出提示，不是白点一下', async () => {
  globalThis.fetch = async (url) => ({
    json: async () => (String(url).includes('/api/doc')
      ? { ok: true, rel: 'a.md', title: 'A', text: '正文', truncated: false }
      : listPayload()),
  })
  const { KnitBody } = boot({}).exports.__test   // 不给 openWorkspacePath

  harness.reset()
  let nodes = harness.render(h(KnitBody, { sessionId: 's1' }))
  await harness.flush()
  nodes = harness.render(h(KnitBody, { sessionId: 's1' }))
  byClass(nodes, 'knit-doc')[0].props.onClick()
  nodes = harness.render(h(KnitBody, { sessionId: 's1' }))

  const localBtn = byClass(nodes, 'knit-btn').find((n) => textOf(n) === '本地打开')
  assert.ok(localBtn, '按钮仍然渲染（位置稳定）')
  // 「禁用」只在**拿不到绝对路径**时用；拿得到路径但没有服务，走「点了给可见提示」——
  // 与路径面包屑同一条规矩（见「路径：没有 remote.session 服务时给出提示」）
  assert.notEqual(localBtn.props.disabled, true, '路径拿得到 → 不禁用')

  localBtn.props.onClick()
  await harness.flush()
  nodes = harness.render(h(KnitBody, { sessionId: 's1' }))
  assert.ok(byClass(nodes, 'knit-notice').length >= 1, '应给出可见提示而不是白点一下')
})

/* ── 符号链接工作区：交给宿主打开的路径必须是 realpath（v0.19 修订） ──
   现象：在 `DSH_Skill_Trace`（→ `10_DSH_Skill_Trace` 的符号链接）这类工作区里，
   点预览头路径 / 「本地打开」/ 点工作区路径，一律弹
   「打开失败：Path has no verified Host path」；而在 08_Knit（真实目录）里同样操作没事。
   根因在 DSH 侧、不在 Knit：`dsh-api-session-controller` 的 `verifyDesktopPath()` 把路径
   送进 `ctx.fs` 做一次 realpath 再**逐字比对**（`lib/index.js:3068`），
   而 `dsh-fs-local` 的 targetKey 落的是 `realpath()` ⇒
   **任何含未展开符号链接的路径都过不了**。
   ⇒ Knit 这一侧要自己先展开：宿主给 `hostRoot`（工作区根的 canonical 形态）与
   每条记录的 `path`（文件的 canonical 形态），客户端**打开一律用它们**，
   `root` 只留给界面显示。 */

test('路径：工作区是符号链接时，打开 / 定位一律用宿主给的 canonical 路径', async () => {
  const calls = []
  globalThis.fetch = async (url) => ({
    json: async () => (String(url).includes('/api/doc')
      ? { ok: true, rel: 'sub/b.md', path: '/real/ws/sub/b.md', title: 'B', text: '正文', truncated: false }
      : listPayload({
        root: '/link/ws',
        hostRoot: '/real/ws',
        docs: [{ path: '/real/ws/sub/b.md', rel: 'sub/b.md', name: 'b.md', title: 'B', summary: 's', mtimeMs: Date.now(), score: null }],
      })),
  })
  const { KnitBody } = boot({
    openWorkspacePath: async (request) => { calls.push(request); return { ok: true, value: { opened: true } } },
  }).exports.__test

  harness.reset()
  let nodes = harness.render(h(KnitBody, { sessionId: 's1' }))
  await harness.flush()
  nodes = harness.render(h(KnitBody, { sessionId: 's1' }))
  byClass(nodes, 'knit-doc')[0].props.onClick()
  nodes = harness.render(h(KnitBody, { sessionId: 's1' }))

  // ① 点预览头路径 → reveal 文件本身
  byExactClass(nodes, 'knit-preview-path')[0].props.onClick()
  await harness.flush()
  assert.deepEqual(calls[0], { path: '/real/ws/sub/b.md', action: 'reveal' },
    'reveal 必须用宿主算好的 canonical 文件路径，不能用 root + rel 拼')

  // ② 页脚「本地打开」→ 打开文件（不带 action）
  const localBtn = byClass(nodes, 'knit-btn').find((n) => textOf(n) === '本地打开')
  localBtn.props.onClick()
  await harness.flush()
  assert.deepEqual(calls[1], { path: '/real/ws/sub/b.md' }, '打开文件同样用 canonical 路径')

  // ③ 点头部工作区路径 → 打开 canonical 目录（目录也会被同一条校验拒）
  byClass(nodes, 'knit-root-path')[0].props.onClick()
  await harness.flush()
  assert.deepEqual(calls[2], { path: '/real/ws' }, '打开工作区目录用的是 hostRoot')

  // ④ 界面显示仍是会话原本那条路径 —— 用户看到的是自己选的那个目录名
  assert.equal(textOf(byClass(nodes, 'knit-root-path')[0]), '/link/ws',
    '显示用 root，不把 canonical 路径摊给用户')
})

test('路径：老宿主不给 path 时退回 hostRoot + rel（仍然避开符号链接）', async () => {
  const calls = []
  globalThis.fetch = async (url) => ({
    json: async () => (String(url).includes('/api/doc')
      ? { ok: true, rel: 'sub/b.md', title: 'B', text: '正文', truncated: false }
      : listPayload({
        root: '/link/ws',
        hostRoot: '/real/ws',
        docs: [{ rel: 'sub/b.md', name: 'b.md', title: 'B', summary: 's', mtimeMs: Date.now(), score: null }],
      })),
  })
  const { KnitBody } = boot({
    openWorkspacePath: async (request) => { calls.push(request); return { ok: true, value: { opened: true } } },
  }).exports.__test

  harness.reset()
  let nodes = harness.render(h(KnitBody, { sessionId: 's1' }))
  await harness.flush()
  nodes = harness.render(h(KnitBody, { sessionId: 's1' }))
  byClass(nodes, 'knit-doc')[0].props.onClick()
  nodes = harness.render(h(KnitBody, { sessionId: 's1' }))

  byExactClass(nodes, 'knit-preview-path')[0].props.onClick()
  await harness.flush()
  assert.deepEqual(calls[0], { path: '/real/ws/sub/b.md', action: 'reveal' },
    '没有 path 时用 hostRoot + rel —— 兜底的也必须是 canonical 那份')
})

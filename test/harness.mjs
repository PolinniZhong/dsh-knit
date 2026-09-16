/**
 * 测试用的一套最小 React / DOM / fetch 替身。
 *
 * 目的：不改产品源码，就能在 Node 里把 __ModuleLoader__ 的工厂跑起来、
 * 渲染组件树、模拟点击，并断言副作用（fetch 了哪个 URL、调了哪个宿主 API）。
 *
 * 只实现被测组件真正用到的那几个 hook：useState / useCallback / useEffect。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const CLIENT_PATH = fileURLToPath(new URL('../src/client/client.js', import.meta.url))

/**
 * 装一个假 window + 假 React，并把客户端模块的工厂函数取出来。
 *
 * @param {{primitives?: boolean}} options - `primitives: false` 用来测降级路径
 * @returns {{factory: Function, markdownCalls: object[]}} 工厂与 MarkdownText 调用记录
 */
export function loadClientModule(options = {}) {
  const usePrimitives = options.primitives !== false

  let captured = null
  globalThis.window = {
    __ModuleLoader__: { load(registration) { captured = registration } },
    localStorage: {
      _v: new Map(),
      getItem(k) { return this._v.has(k) ? this._v.get(k) : null },
      setItem(k, v) { this._v.set(k, String(v)) },
    },
    // 拖拽用的是 window 上的 pointermove / pointerup
    addEventListener() {},
    removeEventListener() {},
    innerHeight: 800,
  }

  const markdownCalls = []
  const primitives = {
    // ⚠️ 真身是 React.memo(...) 的产物 —— 一个**对象**，不是函数。
    // 测试替身必须照抄这个形态，否则「typeof === 'function'」这类守卫的 bug 测不出来。
    MarkdownText: globalThis.__knitReact.memo(function MarkdownText(props) {
      markdownCalls.push(props)
      return { type: 'MarkdownText', props, children: [] }
    }),
  }

  const requireStub = (spec) => {
    if (spec === 'react') return globalThis.__knitReact
    if (spec === '@deepseek-ai/dsh-client-ui-primitives') {
      if (!usePrimitives) throw new Error('（测试）ui-primitives 不可用')
      return primitives
    }
    throw new Error(`unexpected require: ${spec}`)
  }

  const source = readFileSync(CLIENT_PATH, 'utf8')
    // 只为测试暴露内部件，产品文件本身不动
    .replace(
      "module.exports.inject = ['slots', 'locale']",
      'module.exports.__test = { KnitBody, OfficialTabBody, BetterSidebarTabBody, '
        + 'sessionFileAddress, relTime, resolveRelative, pathImagesFor, clampRatio, '
        + 'openKnitPanel, makeEntryButton, KnitGlyph, KnitTitle, KNIT_ICON_PATH, openLocalPath, '
        + 'requestPreview, fmtDuration, readKindPref, mediaUrl, isMedia, mediaLayoutFor, '
        + 'MIN_RATIO, MAX_RATIO, ALL_DOC_CAP, MEDIA_MAX_ITEMS, MEDIA_MIN_PX, MEDIA_VIEW_ROWS }\n'
        + "    module.exports.inject = ['slots', 'locale']",
    )

  new Function('window', source)(globalThis.window)
  if (!captured) throw new Error('客户端模块没有调用 __ModuleLoader__.load')

  return {
    factory: captured.factory,
    registration: captured,
    markdownCalls,
    exports: captured.factory(requireStub),
  }
}

/**
 * 装一套可重渲染的 hooks 替身。
 *
 * @returns {{install: Function, render: Function, flush: Function, reset: Function}}
 */
export function createHarness() {
  let hookStates = []
  let hookIdx = 0
  let pendingEffects = []

  const React = {
    createElement: (type, props, ...children) => ({
      type,
      props: props || {},
      children: children.flat().filter((c) => c !== null && c !== undefined && c !== false),
    }),
    useState(init) {
      const i = hookIdx++
      if (!(i in hookStates)) hookStates[i] = typeof init === 'function' ? init() : init
      return [hookStates[i], (v) => { hookStates[i] = typeof v === 'function' ? v(hookStates[i]) : v }]
    },
    useCallback: (fn) => fn,
    useEffect: (fn) => { pendingEffects.push(fn) },
    // 测试里不做记忆化：每次渲染重算即可，行为与真实 useMemo 等价
    useMemo: (fn) => fn(),
    // 真实 useRef 跨渲染稳定（与 useState 共用槽位空间，同 React）
    useRef(init) {
      const i = hookIdx++
      if (!(i in hookStates)) hookStates[i] = { current: init === undefined ? null : init }
      return hookStates[i]
    },
    // 照抄 React.memo 的真实形态：返回对象而不是函数
    memo: (fn) => ({ $$typeof: Symbol.for('react.memo'), type: fn, compare: null }),
  }

  globalThis.__knitReact = React

  // 可控定时器：默认什么也不做（否则轮询会拖住进程），
  // 需要时用 tick() 显式跑一轮。
  let timers = new Map()
  let timerSeq = 0
  globalThis.setTimeout = (fn) => { const id = ++timerSeq; timers.set(id, fn); return id }
  globalThis.clearTimeout = (id) => { timers.delete(id) }

  return {
    /** 重置 hook 槽位，供每个用例独立开始。 */
    reset() { hookStates = []; hookIdx = 0; pendingEffects = [] },
    /** 预置 useState 的初值（按 hook 调用顺序）。 */
    seed(values) { hookStates = values.slice() },
    /**
     * 渲染一棵树并**展开函数组件**，返回扁平节点列表。
     * 展开很重要：不展开就看不出子组件真实渲染了什么。
     */
    render(element) {
      hookIdx = 0
      pendingEffects = []
      const walk = (node, out = []) => {
        if (!node || typeof node !== 'object') return out
        if (Array.isArray(node)) { node.forEach((n) => walk(n, out)); return out }
        // React.memo / forwardRef 包出来的类型是对象，真身挂在 .type 上
        const type = node.type
        if (type && typeof type === 'object' && typeof type.type === 'function') {
          walk(type.type(node.props), out)
          return out
        }
        if (typeof type === 'function') { walk(type(node.props), out); return out }
        out.push(node)
        ;(node.children || []).forEach((c) => walk(c, out))
        return out
      }
      return walk(element)
    },
    /**
     * 跑一轮当前挂起的定时器（快照后清空，新排的不算）。
     *
     * 用来测「悬停延迟显示」这类依赖 setTimeout 的行为。
     * @returns {number} 执行了几个
     */
    tick() {
      const pending = [...timers.values()]
      timers.clear()
      pending.forEach((fn) => fn())
      return pending.length
    },
    /** 当前挂起几个定时器。 */
    pendingTimers() { return timers.size },
    /** 跑一遍已登记的 useEffect（并给微任务一个 tick）。 */
    async flush() {
      const fx = pendingEffects.slice()
      pendingEffects = []
      fx.forEach((f) => f())
      await new Promise((r) => setImmediate(r))
    },
  }
}

/**
 * 把 `{name}` 占位符换成实参（与产品里的 format 同语义）。
 * @param {string} template - 模板串
 * @param {object} [params] - 实参
 * @returns {string} 结果
 */
export function formatTemplate(template, params) {
  if (!params) return template
  return template.replace(/\{(\w+)\}/g, (whole, key) => (
    Object.prototype.hasOwnProperty.call(params, key) ? String(params[key]) : whole
  ))
}

/**
 * 造一个假的 locale 服务，语义对齐官方 LocaleRuntime：
 *   - `register(ns, { zh, en })` 收下词典
 *   - `bind(ns)` 返回「按调用时读取活动语言」的翻译函数
 *
 * @param {{active?: string}} [options] - 活动语言，默认 zh
 * @returns {{locale: object, registered: object, active: string}} 替身与词典
 */
export function makeLocale(options = {}) {
  const active = options.active || 'zh'
  const registered = {}

  const locale = {
    register(ns, dicts) {
      registered[ns] = dicts
      return () => {}
    },
    bind(ns) {
      return (key, params) => {
        const dict = registered[ns] && registered[ns][active]
        const template = dict && dict[key] !== undefined ? dict[key] : key
        return formatTemplate(template, params)
      }
    },
    getLocale() { return { active, locales: [], revision: 0 } },
    getSnapshot() { return { active, locales: [], revision: 0 } },
    subscribe() { return () => {} },
  }

  return { locale, registered, active }
}

/**
 * 从扁平节点里按 className 取节点（**子串**匹配）。
 * @param {object[]} nodes - 扁平节点
 * @param {string} className - 要匹配的 class（子串）
 * @returns {object[]} 命中的节点
 */
export function byClass(nodes, className) {
  return nodes.filter((n) => String(n.props.className || '').includes(className))
}

/**
 * 从扁平节点里按 className 取节点（**整段**匹配）。
 *
 * 子串匹配会把 `knit-preview` 同时命中 `knit-preview-head` / `-body` / `-title`，
 * 计数类断言必须用这个。
 *
 * @param {object[]} nodes - 扁平节点
 * @param {string} className - 要匹配的完整 class
 * @returns {object[]} 命中的节点
 */
export function byExactClass(nodes, className) {
  return nodes.filter((n) => String(n.props.className || '') === className)
}

/**
 * 取节点下所有字符串子节点的拼接。
 * @param {object} node - 节点
 * @returns {string} 文本
 */
export function textOf(node) {
  const acc = []
  const walk = (n) => {
    if (typeof n === 'string') { acc.push(n); return }
    if (!n || typeof n !== 'object') return
    if (Array.isArray(n)) { n.forEach(walk); return }
    ;(n.children || []).forEach(walk)
  }
  walk(node)
  return acc.join('')
}

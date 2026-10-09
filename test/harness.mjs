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
 * @param {{primitives?: boolean, noHighlighter?: boolean}} options - `primitives: false`
 *   用来测「包整个不可用」的降级路径；`noHighlighter: true` 用来测「包在、但没导出
 *   高亮器」的降级路径（旧版 DSH）
 * @returns {{factory: Function, markdownCalls: object[], highlightCalls: string[]}} 工厂、
 *   MarkdownText 调用记录、高亮器收到的语言标识
 */
export function loadClientModule(options = {}) {
  const usePrimitives = options.primitives !== false
  const useHighlighter = usePrimitives && options.noHighlighter !== true

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
    // 右栏的「拖回右缘吸附」要用它算吸附带（1024 - 28 = 996）。
    // 不给它的话，吸附的那几条测试会永远测不到东西还全绿 —— 假绿比红更贵。
    innerWidth: 1024,
  }

  const markdownCalls = []
  const highlightCalls = []
  const highlightCodes = []
  const primitives = {
    // ⚠️ 真身是 React.memo(...) 的产物 —— 一个**对象**，不是函数。
    // 测试替身必须照抄这个形态，否则「typeof === 'function'」这类守卫的 bug 测不出来。
    MarkdownText: globalThis.__knitReact.memo(function MarkdownText(props) {
      markdownCalls.push(props)
      return { type: 'MarkdownText', props, children: [] }
    }),
  }
  if (useHighlighter) {
    // 形态照抄官方：hook 收**语言标识**、返回 `(code) => HighlightSpan[][]`。
    // 逐行按空白切成若干 run、交替给两个 `--shiki-*` 颜色 —— 既能验证「逐 token 渲染」，
    // 又能验证拼接后文本一字不差（`textOf` 会替我们比）。
    primitives.useCodeHighlighter = function useCodeHighlighter(language) {
      highlightCalls.push(language)
      return (code) => {
        // 记下**被上色的那截正文**（不是全部正文）：封顶用例要断言「只把前 N 行交给
        // 高亮器」，而这个差别在渲染结果上表现为「尾巴是纯文本」，从 span 数量看不出来。
        highlightCodes.push(String(code))
        return String(code).split('\n').map((line) => (
          line === ''
            ? []
            : line.split(/(\s+)/).filter((part) => part !== '').map((text, i) => ({
              text,
              style: { color: i % 2 === 0 ? 'var(--shiki-token-keyword)' : 'var(--shiki-token-plain)' },
            }))
        ))
      }
    }
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
        + 'sessionFileAddress, relTime, resolveRelative, pathImagesFor, clampRatio, splitRelPath, '
        + 'openKnitPanel, makeEntryButton, KnitGlyph, KnitTitle, KNIT_ICON_PATH, openLocalPath, '
        + 'requestPreview, fmtDuration, readKindPref, mediaUrl, isMedia, mediaLayoutFor, '
        + 'nextIndexFor, docOptionId, planRowMotion, mergeGhostRows, motionAllowed, settleEnterAnim, motionShift, '
        + 'rowLayoutPoint, applyRowFlips, '
        // v0.20 Deep Context Retrieval：命中片段的行号区间与代码行锚点的几何。
        + 'fmtRange, firstMatchOf, anchorBandFor, '
        // v0.20（2026-10-07 用户裁决）：Markdown 预览的**文本锚点** —— 纯函数那半
        // （归一化 + 取针）在这里；DOM 那半（`docAnchorHit` / `docBlockElement`）
        // 需要真 document，走真机验证，不进这个替身。
        + 'docNeedleText, docAnchorNeedles, docPickOffset, scrollToDocAnchor, DocPane, '
        + 'DOC_NEEDLE_CHARS, DOC_NEEDLE_MIN, DOC_NEEDLE_MAX, '
        + 'MOTION_ENTER_MS, MOTION_EXIT_MS, MOTION_STAGGER_MS, MOTION_STAGGER_MAX, MOTION_EASE, '
        + 'MOTION_MOVE_MS, MOTION_MOVE_EPS, '
        // ⚠️ 右栏那套名字（clampPackW / clampFloatPos / nearRightEdge / PACK_*）已随
        // 右栏一起删除（2026-09-29）。名字留在这里，模块一加载就 ReferenceError ——
        // 这个替身是**只增不减**的重灾区，删功能时记得同步删名字。
        + 'MIN_RATIO, MAX_RATIO, ALL_DOC_CAP, MEDIA_MAX_ITEMS, MEDIA_TRACK_PX, '
        + 'MEDIA_LABEL_MIN_PX, MEDIA_GAP_PX, '
        // v0.18 Context Usage Lens：纯函数与阈值（渲染层的东西仍走 DOM 断言）。
        + 'LIFE_GLYPH, lifeStatusOf, coverageOf, groupOutsideDocs, groupDelta, '
        + 'COMPACT_PANEL_PX, MAX_OUTSIDE_SHOWN, MAX_DELTA_SHOWN, MAX_DELTA_GROUP, FLASH_MS, '
        // v0.21 关系与控制：客户端只镜像了一个上限（面板每项最多投影几条关系）。
        // 真正的截断在宿主做，客户端拿它写「共 N 条关系」那句话 —— 两个数字必须一致，
        // `test/client.test.mjs` 有一条镜像守卫同时读两侧源码。
        + 'REL_MAX }\n'
        + "    module.exports.inject = ['slots', 'locale']",
    )

  new Function('window', source)(globalThis.window)
  if (!captured) throw new Error('客户端模块没有调用 __ModuleLoader__.load')

  return {
    factory: captured.factory,
    registration: captured,
    markdownCalls,
    highlightCalls,
    highlightCodes,
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
  // 「状态真的被写了几次」—— 与渲染次数无关的语义级观测量（见 useState 里的说明）。
  let stateWrites = 0

  const React = {
    // ⚠️ children 必须**递归摊平**（真实 React 也会摊平数组）。
    // 只摊一层的话，`h(A, null, [h(B), h(C)])` 里 B/C 会变成一个数组子节点，
    // 而 textOf() 只按 node.children 递归 → 断言「分区里有这篇文档」会假红。
    createElement: (type, props, ...children) => {
      const flat = []
      const push = (c) => {
        if (Array.isArray(c)) { c.forEach(push); return }
        if (c === null || c === undefined || c === false) return
        flat.push(c)
      }
      children.forEach(push)
      return { type, props: props || {}, children: flat }
    },
    useState(init) {
      const i = hookIdx++
      if (!(i in hookStates)) hookStates[i] = typeof init === 'function' ? init() : init
      // ⚠️ 真 React 对 setState 的值先比一次 `Object.is`：**原样返回同一个对象 ⇒ 整棵子树
      // 不重渲染**（v0.20 轮询去重就靠这条）。替身因此只在「值真的换了」时才写槽位，并把
      // 写入次数记下来 —— 让「同样的载荷不该落状态」这类守卫**可证伪**（旧代码每 5 s 落一个
      // 新对象，计数必然增长）。
      return [hookStates[i], (v) => {
        const next = typeof v === 'function' ? v(hookStates[i]) : v
        if (Object.is(next, hookStates[i])) return
        stateWrites += 1
        hookStates[i] = next
      }]
    },
    useCallback: (fn) => fn,
    useEffect: (fn) => { pendingEffects.push(fn) },
    // 真实 React 里 layout effect 跑在 DOM 变更之后、paint 之前。替身没有 DOM，排进同一队
    // 即可 —— 客户端那两段进出动效在 Node 里被 `motionAllowed()` 挡掉，不会真的碰节点。
    useLayoutEffect: (fn) => { pendingEffects.push(fn) },
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
    reset() {
      hookStates = []
      hookIdx = 0
      pendingEffects = []
      stateWrites = 0
      // ⚠️ 定时器也要清：轮询链会自己续命（`setTimeout` 排下一轮），而替身从不跑 effect
      // 的 cleanup —— 上一个用例留下的链会在下一个用例的 `tick()` 里醒来，把它那份旧载荷
      // 写进**共用**的 hook 槽位（换掉别人的 state）。真机不会这样：每个实例有自己的
      // state，卸载即停表。
      timers.clear()
    },
    /** 状态真被写了几次（同一个对象原样返回不算）。 */
    stateWrites() { return stateWrites },
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
 *
 * ⚠️ **函数组件要展开**（与 `render()` 的 walk 同一套语义）。
 * 不展开的话 `h(DocRow, {...})` 这种节点在树里是 `{type: 函数, props, children}`，
 * 而它的子节点其实来自 `DocRow(props)` 的返回值 —— 于是「分区里有没有这篇文档」
 * 这类断言会假红（细节见 AGENTS.md §6.2）。
 *
 * @param {object} node - 节点
 * @returns {string} 文本
 */
export function textOf(node) {
  const acc = []
  const walk = (n) => {
    if (typeof n === 'string') { acc.push(n); return }
    if (!n || typeof n !== 'object') return
    if (Array.isArray(n)) { n.forEach(walk); return }
    const type = n.type
    if (type && typeof type === 'object' && typeof type.type === 'function') {
      walk(type.type(n.props))
      return
    }
    if (typeof type === 'function') { walk(type(n.props)); return }
    ;(n.children || []).forEach(walk)
  }
  walk(node)
  return acc.join('')
}

/**
 * Knit · 浏览器半边
 *
 * 在两个宿主上注册同一个「最近文档」面板：
 *   1. DSH 自带右侧栏（@deepseek-ai/dsh-client-ui-sidebar-right）—— 主路径
 *   2. dsh-better-sidebar 的 ctx.betterSidebar.registerTab —— 可选，吃到它那批用户
 *
 * 面板本身：列表（相关性或 mtime 排序 + 过滤 + 键盘导航）+ 列表下方的就地预览。
 * 两个宿主共用同一个 KnitBody，只在「怎么开新标签页」上用适配器分叉。
 *
 * 构建：源码在 `tools/client-src/*.js`，由 `node tools/build-client.mjs` 拼成
 * `src/client/client.js`（DSH 仍只加载这一个文件；无 bundler、无 JSX）。
 */
window.__ModuleLoader__.load({
  id: 'dsh-knit',
  factory: (require) => {
    const module = { exports: {} }
    const React = require('react')
    /* v0.25（2026-10-22）：全屏查看器要**盖住整个屏幕**，所以必须挂到 `document.body` 上。
       为什么不能就地渲染：`position:fixed` 会被**祖先的 transform / filter / contain 困住**
       —— 宿主的右侧栏是滑入的（有 transform），那一层就成了 containing block，
       `fixed` 于是变成「相对侧边栏」而不是视口，于是只能盖住面板那一块（用户实测如此）。
       这是 CSS 逃不出来的坑，只有 portal 能解。取不到 react-dom（老宿主 / 测试替身）就退回就地渲染。 */
    const ReactDOM = (() => { try { return require('react-dom') } catch { return null } })()
    const h = React.createElement


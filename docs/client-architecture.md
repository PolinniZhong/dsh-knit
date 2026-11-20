# 客户端架构：加载契约与源码分片（2026-11-20）

## 1. 加载契约（先看证据）

Knit 的浏览器半片由 DSH 的 client-modules 加载：

- `package.json` 的 `exports["./client"]` 指向**一个**文件；
- `dsh.client` 的 `DshClientManifest`（`packages/util/package-manifest/src/types.ts`）只有
  `platform / inject / immediately / external`，**没有多入口字段**；
- `window.__ModuleLoader__.load({ id, factory })` 一次只注册一个 factory；
- 加载期能 `require` 的是基线 seed（React / Cordis / 官方 UI 包），**不能 require 本仓库的本地文件**。

结论：**浏览器里只能是单文件、单 factory。** 想要真正的 ES module 图，必须引入打包器或改
DSH 的 client 加载契约 —— 这两条都超出 Knit「无 runtime build、单文件安装」的边界。

## 2. 选定的方案：源码分片 + 确定性拼接

保留单文件加载，但把**人编辑的源码**拆成有序分片：

```
tools/client-src/
  00-preamble.js      ModuleLoader 外壳 + React / ReactDOM / h
  10-i18n.js          ZH / EN / t / 宿主错误码
  20-runtime.js       常量、URL、纯函数、投递、收藏、布局
  30-styles.js        整个 CSS 模板串 + ensureStyle
  40-components.js    DocRow / PreviewPanel / DiffPane 等组件
  50-body.js          KnitBody（状态、数据、列表、lightbox、评论）
  60-entry.js         两个宿主注册 + 入口按钮
        ↓  node tools/build-client.mjs
src/client/client.js   生成物（DSH 唯一入口）
```

分片按文件名排序拼接，**共享同一个 factory 作用域**，因此语义与拆分前逐字一致。
生成文件与分片不同步时，`node tools/build-client.mjs --check` 直接失败。

### 为什么不是真模块

- `require('./foo')` 在 DSH client 里解析不到本地文件；
- `dsh.client.external` 只能声明**已安装包**的模块请求，不能声明本包分片；
- 加 esbuild / tsdown 会引入依赖、构建产物与 sourcemap 治理，且 clean-room 打包要重做。

所以这里选**零依赖、可 diff、可 check 的拼接**：加载契约不变，源码可维护性提升。

## 3. 工作流

```sh
# 改源码：只改 tools/client-src/*.js
npm run build:client
npm run build:client:check
npm test

# 提交前
npm run build:client:check
```

- `prepublishOnly` 已挂 `build:client:check`：生成物没同步时 npm publish 直接失败；
- `npm run budget:code` 统计**分片**（生成物只报行数、不设上限）；
- 分片上限 3,500 行；最大当前 `50-body.js` 约 3,117 行。

## 4. 边界规则

1. **生成物不手改**：`src/client/client.js` 顶部注释已标明；改它会被下一次 build 覆盖。
2. **跨分片共享靠同一作用域**：分片不是独立模块，变量（`t` / `h` / 常量）在拼接后同层可见；
   不要把分片写成 IIFE 或独立 `export`。
3. **新增功能先找归属分片**：数据/状态进 `50-body`，纯函数进 `20-runtime`，组件进 `40-components`，
   文案进 `10-i18n`，样式进 `30-styles`；不要新开第 8 个分片除非确实跨领域。
4. **不引入 bundler / JSX**：仍用 `React.createElement`，CSS 仍是一个模板串。
5. **clean-room 包只带生成物**：`tools/client-src` 不进 npm 包；发布前 `prepublishOnly` 保证生成物正确。

## 5. 代价（明说）

- 仓库同时有分片与生成物，**行数统计会看起来更多**；所以代码预算按分片算，生成物不设预算。
- 分片之间没有 import/export 边界，靠约定与目录名维持；不是语言级模块。
- 真正的模块图需要 DSH 侧支持多入口或引入 build；本版不做。

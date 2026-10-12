# Security

> **Knit 的安全属性 —— 每一条都指向一个真实存在的检查。**
>
> 最后更新：2026-10-13（v0.23.1）—— 本版**无安全相关改动**（只动客户端工具栏与产品文案）；
> 版本号随每版前移，好让「安全表被漏掉」与「本版没动安全面」在版本一致性检查里能分开
>
> 📌 **v0.23.0（2026-10-12）那次改了什么**：写通道由一条变两条（新增 `POST /knit/api/semantic`，只存 provider 配置）、
> 会落盘的单元由两个变三个（`knit_index` 起于 v0.22、`knit_semantic` 起于 v0.23）；
> 「**唯一的**写动作」那条从 v0.22 起就已经不成立，那次按实际改写，并补一条 ⚠️ 说明第二条写通道的守卫缺口

## 为什么有这份文件

Codex 插件生态**强制**每个插件过安全扫描（[HOL `plugin-scanner`](https://github.com/hashgraph-online/hol-guard)，
准入线 ≥80/130 分），给六维信任分，还把结果发成公开数据集。
DSH 的插件市场**只有一条「描述只说功能」的文案规范，没有任何安全评分**
（对比见 `00_调研与规划/竞品调研-Codex插件生态.md`）。

Knit 的安全属性其实一直成立 —— 但它们此前只散落在文档和代码注释里，
**没有任何一处能被机器核验**。在一个人人自述的市场里，「**能被核验**」本身就是差异化。

所以这份表格的规矩是：

- **✅ 只给真的有检查守着的属性**；没检查的宁可不写
- 每条 ✅ 的「证据」列必须指向一个**真实路径**
- **允许出现 ⚠️/❌** —— 没验证的事不装成验证过
- `test/security.test.mjs` 会**自动校验这张表**：引用的路径必须存在、
  ✅ 行必须指向具体检查、每行必须有状态列。**表格腐烂会直接让测试变红。**

## 属性对照表

| 属性 | 状态 | 证据（指向真实的检查） |
|---|---|---|
| 零运行时依赖 | ✅ | `package.json` 的 `dependencies` 为空；`test/security.test.mjs` 断言 |
| 无安装期脚本 | ✅ | `package.json` 只有 `test` 一个 script，无 `install`/`postinstall`/`prepare`；`test/security.test.mjs` 断言 |
| 读文件接口守在会话工作区内 | ✅ | `test/host.test.mjs` 的越界用例（解析后必须落在工作区内，否则一律拒绝） |
| `/knit/api/doc` 只放行文本类产物 | ✅ | v0.19 起因代码而放宽（原为「仅 Markdown」），所以边界要重新说清：**文档 / 代码 / 生成产物**放行，**媒体与未知后缀一律拒绝**。`test/host.test.mjs` 的 `notPreviewable` 用例 + `test/classification.test.mjs` 的 `isPreviewKind` 闭集断言 |
| `/knit/api/raw` 叠扩展名白名单 | ✅ | `test/host-http.test.mjs`（非图片/视频扩展名一律拒绝） |
| 只允许 GET、只允许回环地址（写通道是**例外**，不是放开 POST） | ✅ | `test/host-http.test.mjs`。写路由**只认 POST**、GET 打它回 405；**别的路由的 POST 仍回 405**（有对照断言）；坏 body 回 400。v0.21 起有 `POST /knit/api/control`（写固定 / 排除，只接受 `pin`/`unpin`/`exclude`/`restore` 四个动作 + 一条工作区内的相对路径） |
| 会写盘的东西只有三类，且只写 DSH 给的存储单元 —— **不碰工作区里的任何文件** | ✅ | 三个 kv 单元各开各的：`knit_control`（`src/host/control.js`，v0.21，固定 / 排除）、`knit_index`（`src/host/index-store.js`，v0.22，增量索引，**非 HTTP 触发**）、`knit_semantic`（`src/host/semantic.js`，v0.23，**只存 provider 配置**，向量只在内存）。落盘路径由 DSH 的 storage 服务决定，Knit 不自己拼；`test/control.test.mjs` + `test/index-store.test.mjs` |
| 第二条写通道 `POST /knit/api/semantic` 的主机侧 e2e 守卫 | ⚠️ | **如实说明（v0.23 新增，尚未补）**：它目前只有**客户端侧**断言（`test/client.test.mjs` 认这条 URL），**没有**像 `/api/control` 那样在真实回环端口上验「GET→405 / 别的路由 POST→405 / 坏 body→400」。两条写路由在 `src/host/index.js` 里共用同一段前置守卫，但「共用同一段代码」**不等于**「被验过」 |
| 响应带 `nosniff` 与 `default-src 'none'; sandbox` | ✅ | `test/host-http.test.mjs`（两个指令各自断言） |
| 零网络出口：客户端 `fetch` 全部同源相对路径 | ✅ | `src/client/client.js` 的三个接口常量都是 `/knit/api/*`；`test/security.test.mjs` 断言无协议头。HTML 的「网页预览」按钮是把文件交给 **DSH 自己的**文档预览标签页去渲染（Knit 这一侧一个请求都不发），渲染的沙箱与 CSP 归 DSH 管 —— 所以这条承诺不变 |
| 宿主半边不 import `@deepseek-ai/*` | ✅ | `test/security.test.mjs` 扫三个宿主文件，注释里提到可以、真实 `import` 不行 |
| `knit_docs` 工具只读，不写任何文件 | ✅ | `src/host/tool.js` 只调注入进来的 `scan` 与只读的 `readDocument`；无写文件调用 |
| 未经第三方安全审计 | ⚠️ | **如实说明**：这张表是**自证**。没有外部审计报告，也没有自动化扫描评分 —— 它不等于「已证明安全」 |

## 不在这张表里的东西

- **DSH 主程序本身的安全性**不在 Knit 的责任范围内。
- **用户装的其他插件**不受 Knit 影响。
- 装任何插件都等于在本机跑第三方代码。**建议只装你信任的来源。**

## 如何自己复核

```sh
npm test                            # 全套（含本节所有断言）
node --test test/security.test.mjs  # 只跑安全守卫
```

> ⚠️ **别用 `npm test -- test/security.test.mjs`**：`scripts.test` 是**逐文件枚举**的，
> 追加参数不会把范围收窄 —— 实测它照样跑全套。要只跑这一份就直接用 `node --test`。

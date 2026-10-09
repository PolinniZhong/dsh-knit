# Security

> **Knit 的安全属性 —— 每一条都指向一个真实存在的检查。**
>
> 最后更新：2026-10-08（v0.21.0）—— 新增 `POST /knit/api/control` 与固定/排除的落盘，两条属性已按实际情况改写

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
| 只允许 GET、只允许回环地址 | ✅ | `test/host-http.test.mjs`。**v0.21 起有一个例外**：`POST /knit/api/control`（写固定 / 排除），它同样只认回环地址，且只接受 `pin`/`unpin`/`exclude`/`restore` 四个动作 + 一条工作区内的相对路径；非 POST 打这个路由回 405、坏 body 回 400 |
| 唯一的写动作 = 固定 / 排除，且只写 DSH 给的存储单元 | ✅ | `src/host/control.js` 只通过 `ctx` 注入的 storage 服务读写单元 `knit_control`（`~/.dsh/storages/knit_control.json`，按工作区隔离），**不碰工作区里的任何文件**；`test/control.test.mjs` + `test/host-http.test.mjs` |
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
npm test                       # 641 项，含本节所有断言
npm test -- test/security.test.mjs   # 只跑安全守卫
```

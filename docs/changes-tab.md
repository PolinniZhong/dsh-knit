# 「变更」档：未提交改动的文件列表

> v0.26.x（未发布）。目标：像 CodeDesk 的文件变更区一样，回答「这次改了哪些 Markdown / 代码」
> 并在同一个预览面板里看**逐行 diff**。行号会漂，按函数/接口定位。

## 1. 用户看到什么

- 类型页签从三档变四档：**文档 / 代码 / 媒体 / 变更**。
- 变更档按**文件修改时间倒序**列出**未提交**的 Markdown / 代码文件。
- 每行：文件名 + 目录 + 状态徽标（修改 / 新增 / 删除 / 重命名 / 新文件 / 冲突 / 复制）+ `+N −N`。
- **工作区根不是 Git 仓库时**，会在**一层子目录**里找仓库（最多 8 个）：
  例如 workspace = `08_Knit/`、仓库在 `08_Knit/knit/` ⇒ 行 rel 显示为 `knit/src/...`；
  diff 也在子仓库里跑（路径换回仓库相对路径）。
- 点行 = 在既有预览面板里打开**逐行 diff**（新旧行号 + 上下文 / 新增 / 删除）；删除的文件仍列出，但 diff 可能为空/失败。
- 计数 = 全部变更文件数（含不在列表里的图片等）；空态区分：
  「工作区干净」「读不到 Git + 原因」「有变更但没有可列的 Markdown/代码」。
- 排序按钮在变更档禁用（变更固定按 mtime）；搜索框照常过滤。

## 2. 数据流

```
GET /knit/api/status?sessionId=…
  → git status --porcelain=v1 -z --untracked-files=all
  → git diff --numstat -z --no-renames HEAD     （只取 +N/−N，不读正文）
  → stat 每个文件（mtime / bytes）
  → 未跟踪文件：读文件数行数（≤512 KB、非二进制）
  → { ok, mode:'status', git:{available, reason, filesTotal, truncated, statsAvailable, files:[…] } }
```

客户端：

- `KIND_CHANGES` 第四档；`STATUS_API = '/knit/api/status'`。
- 载荷存 `state.changesStatus`（不是新 hook：测试按位预置 hook，新状态不插队）。
- 只在**变更档且面板可见**时轮询；切走即停；失败有独立形状，不冒充「没有改动」。
- `changeDocsOf(data)` 把文件映射成既有 `DocRow` 行（只收 `kind === 'md' | 'code'`），
  行上多一个 `change` 字段；`DocRow` 用该字段渲染状态徽标与 `+N −N`，其余渲染路径不变。
- 文件行点击走既有 `togglePreview`，预览面板 / 双击开标签页 / 键盘导航全部复用。

## 3. 宿主与安全边界

- `git.js` 的新增只读子命令：`git diff --numstat -z --no-renames HEAD`（`GIT_NUMSTAT_ARGS`）。
  - 只输出 `added\tdeleted\tpath`，**不读 diff 正文**；
  - 固定 argv、不走 shell、子进程环境白名单不变；
  - `MUTATING_VERBS` 里一个词都没有（有测试）。
- `statusPayload()` 对每个路径 `resolve` 回工作区根再 `stat`/`readFile`，越界条目跳过；
- 行数统计失败只把 `statsAvailable` 置 false，**文件清单照常可用**；
- 新路由 `GET /knit/api/status` 是 JSON，走 `sendJson`（不返回文件字节）。

## 4. 已知限制

- 只看**未提交**（工作区 vs HEAD），不是「上一次会话 / 上一轮」的改动；
- diff 正文通过 `git diff --no-color --no-ext-diff --no-textconv --unified=3 HEAD -- <rel>` 读取，
  固定 argv、不走 shell、无写动词；仍不落盘、不联网；
- 未跟踪文件没有 HEAD 基线：行数由读文件补，diff 显示「全新增」；二进制显示「二进制」；
- 只列 Markdown / 代码；图片等变更计入总数但不进列表；
- 删除文件仍列出，但点开会 404（后续可禁用点击）。

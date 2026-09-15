# Changelog

本项目的重要变更都记在这里。格式参考 [Keep a Changelog](https://keepachangelog.com/)，
版本号遵循[语义化版本](https://semver.org/lang/zh-CN/)。

## [0.4.0] - 2026-09-15

首个公开版本。

### Added

- **按当前对话的相关性排序**（纯本地关键词匹配，零模型调用）：标题 ×4 / 摘要 ×2 / 正文前
  2500 字 ×1 加权命中，单词命中封顶 6 次，叠 10% 时间新鲜度微调
- 相关性 / 修改时间双模式一键切换（偏好记在 localStorage）
- 扫描会话工作区内所有 `.md`（递归，深度 ≤ 6，跳过 `node_modules` / `.git` / `dist` 等）
- 每项显示 H1 标题（无则文件名）+ 相对时间 + 首段摘要
- 单击就地展开预览，再点收起
- **相对路径图片真实渲染**（`./img/a.png`、`../assets/b.png`）
- 预览面板可拖高度（夹在 20%–80%，位置记进 localStorage）、可全屏，`Esc` 退出
- 双击在新标签页打开
- 过滤框：按标题 / 摘要 / 路径实时过滤
- 键盘导航：`↑` `↓` 移动即预览 / `Enter` 切换 / `Esc` 收起
- 每 5 秒自动刷新 + 手动刷新；2 分钟内改动过的文档打 🆕
- 会话头部右侧的 Knit 图标入口（`conversation.session.header.utilities`）
- 中英双语，跟随 DSH 语言实时切换（`ctx.locale`，命名空间 `knit`）
- mono 图标，浅色纯黑 / 暗色纯白，四个位置统一
- 双宿主：DSH 自带右侧栏 + `dsh-better-sidebar`（均为可选依赖）
- 对话不足时退回按修改时间排序，并在面板上说明

### Notes

- 零依赖、无安装脚本、无对外网络请求
- 宿主半边改了需要重启 DSH，客户端半边硬刷新浏览器即可
- 相关度不做可视化（不显示百分比、不画长条）—— 排序本身就是答案

[0.4.0]: https://github.com/PolinniZhong/dsh-knit/releases/tag/v0.4.0

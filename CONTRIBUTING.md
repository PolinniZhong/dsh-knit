# 贡献指南

先谢过。这个项目很小，规则也少，只有几条是为了不把事情弄坏。

## 跑起来

```sh
git clone https://github.com/PolinniZhong/dsh-knit.git
cd dsh-knit
npm test                    # 105 项，零依赖，不需要 npm install
```

**没有构建步骤，也没有依赖。** 客户端半边是手写的 `window.__ModuleLoader__.load({...})`，
用 `React.createElement` 而不是 JSX。请**不要**引入打包器、JSX、TypeScript 或运行时依赖 ——
「零依赖」是这个项目对用户的承诺，不是省事。

## 改完怎么生效

| 改的地方 | 怎么生效 |
|---|---|
| `src/host/` | **重启 DSH**（实测不热加载） |
| `src/client/` | 硬刷新浏览器（`Cmd + Shift + R`） |

判断宿主半边到底有没有换新：`curl "http://127.0.0.1:3080/knit/api/raw?rel=nope.png"`
返回 `{"ok":false,"code":"knit/not-found"}` = 新代码在跑；空 body 的 404 = 旧代码还在跑。

## 提 PR 之前

1. `npm test` 必须全绿
2. **不要为了让测试变绿而删测试** —— 测试红说明行为变了，先判断是代码错还是断言错
3. 面向用户的文案**一律走 i18n**：`src/client/client.js` 里的 `ZH` / `EN` 两个词典
   **同时**加同名键；宿主只返回错误码（如 `knit/outside-workspace`），不返回文案。
   两边的键集与占位符有测试守着，只加一边会被拦下
4. 新增任何**按路径读文件**的路由，必须照抄 `/knit/api/doc` 与 `/knit/api/raw` 的防护：
   解析后必须落在会话工作区内、只允许 GET、只允许回环地址、响应带 `nosniff`
   与 `default-src 'none'; sandbox`；读图片的那条还要叠扩展名白名单
5. 不要动 `node_modules/@deepseek-ai/*`（官方包只读）。要扩展就走官方座位，
   座位与契约先在官方 `lib/types/**/*.d.ts` 里查证，不要猜

## 什么 PR 现在最受欢迎

按当前阶段（还处在验证需求，不是堆功能）：

- ✅ **修安装 / 兼容性问题** —— 最高优先级，装不上等于零
- ✅ **相关性排序的质量**：更准的关键词抽取、更好的中文分词、权重与阈值的实证调整
  （**仍然保持零模型**：不要引入 embedding 或任何模型调用）
- ✅ **文档修正**：README 里任何一句和代码对不上的话，都是 bug
- ⚠️ **新功能**：先开 issue 说清场景，**并回答「不用这个功能你现在是怎么绕过它的」**。
  说不清绕法的需求，多半是想象出来的

## 提交信息

用 [Conventional Commits](https://www.conventionalcommits.org/) 前缀：
`feat:` / `fix:` / `docs:` / `test:` / `refactor:` / `chore:`。
一句话说清「改了什么」，细节放正文。

## 协议

贡献即同意以 [MIT](LICENSE) 协议发布。

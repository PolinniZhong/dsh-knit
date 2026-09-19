/**
 * Knit · **真机集成验证**（不是单测）
 *
 * 起一个**真实的 cordis 容器** + **真实的 ToolRuntime**，把 Knit 的宿主半边挂进去，
 * 然后**通过注册表**执行 `knit_docs`。与 `npm test` 的区别：
 * 注册、参数、**输出 schema 校验**全部由真实的 `@deepseek-ai/dsh-tools` 完成 ——
 * 单测用的是替身，证明不了「真实框架会接受它」。
 *
 * 用法：
 *   node knit/tools/real-machine-check.mjs
 *
 * ⚠️ 它**依赖本机装了 DSH**（会去 `@deepseek-ai/*` 的安装目录找包），
 * 所以**不进 `npm test`**（那里必须零依赖、换台机器也能跑）。
 * 也**不在 npm 包的 `files` 里**，不会跟着发布出去。
 *
 * 它**验不了**的两件事（必须重启 DSH，见 `01_ Knit PRD/Knit_SDD-v0.8-*.md` §七）：
 *   1. 面板那行「按「xxx」排序」—— 需要运行中的宿主加载新代码
 *   2. agent 拿到结果后还会不会自己 glob 一遍 —— 需要新的工具描述真的生效
 */
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

let failures = 0
const ok = (label, pass, detail = '') => {
  if (!pass) failures += 1
  console.log(`  ${pass ? '✔' : '✘'} ${label}${detail ? '  — ' + detail : ''}`)
  return pass
}

/* ── 找 DSH 的包目录 ─────────────────────────────────── */
const CANDIDATES = [
  process.env.DSH_PACKAGES_DIR,
  join(homedir(), '.dsh/profiles/web/node_modules/@deepseek-ai'),
  '/Applications/Deepseek Harness Desktop.app/Contents/Resources/resources/node_modules/@deepseek-ai',
  '/Users/zhongwentuo/Library/Application Support/io.github.hairyf.deepseek-harness-desktop/dependencies/dsh/node_modules/@deepseek-ai',
].filter(Boolean)

const dsh = CANDIDATES.find((p) => existsSync(join(p, 'dsh-tools/lib/index.js')))
if (!dsh) {
  console.error('找不到 DSH 包目录。用 DSH_PACKAGES_DIR=<...>/node_modules/@deepseek-ai 指定。')
  console.error('找过：\n  ' + CANDIDATES.join('\n  '))
  process.exit(2)
}
const knitRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
console.log(`DSH 包目录: ${dsh}\nKnit: ${knitRoot}\n`)

const { Context } = await import(pathToFileURL(join(dsh, 'cordis/lib/index.js')).href)
const Tools = await import(pathToFileURL(join(dsh, 'dsh-tools/lib/index.js')).href)
const SP = await import(pathToFileURL(join(dsh, 'dsh-system-prompt/lib/index.js')).href)

/* ── ① 真实容器 + 真实注册 ───────────────────────────── */
console.log('① 挂进真实 cordis 容器与真实 ToolRuntime')
const ctx = new Context()
await ctx.plugin(SP.default)
await ctx.plugin(Tools.ToolRuntime)
await new Promise((resolve) => ctx.inject(['tools'], resolve))
const kit = await import(pathToFileURL(join(knitRoot, 'src/host/index.js')).href)
kit.apply(ctx)
await new Promise((r) => setTimeout(r, 300))

const names = ctx.tools.schemas().map((s) => s.name)
ok('knit_docs 注册进真实注册表', names.includes('knit_docs'), names.join(', ') || '(空)')
const schema = ctx.tools.schemas().find((s) => s.name === 'knit_docs')
if (schema) {
  // v0.9：描述要同时说清「凭什么信这个排名」与行为引导，两者都有实测支撑
  // （见 tools/scale-benchmark.mjs 与 Knit_SDD-v0.8 §8.4）
  ok('描述说明了「比你自己数准」', schema.description.includes('beats matching filenames'))
  ok('描述点名了行为引导', schema.description.includes('prefer it to doing that yourself'))
  ok('参数只有 query / limit', Object.keys(schema.parameters.properties).join(',') === 'query,limit')
}

/* ── ② 真工作区 ─────────────────────────────────────── */
const bare = mkdtempSync(join(tmpdir(), 'knit-real-'))
mkdirSync(join(bare, 'docs'), { recursive: true })
writeFileSync(join(bare, 'README.md'), '# 项目说明\n\n这是主文档，讲扩展名白名单与路径越界防护。\n')
writeFileSync(join(bare, 'docs/relevance.md'), '# 相关性排序算法\n\n讲 BM25、IDF 与长度归一化，还有悬停浮层的实现。\n')
writeFileSync(join(bare, 'docs/theme.md'), '# 主题令牌\n\n灰色太深时的对比度处理，以及暗色主题。\n')
writeFileSync(join(bare, 'docs/note.md'), '# 随手记\n\n很短的一条。\n')
process.on('exit', () => rmSync(bare, { recursive: true, force: true }))

/**
 * 通过真实注册表执行一次工具。
 * @param {object} args - 工具参数
 * @param {object|undefined} agent - 假 agent
 * @param {string} callId - 调用 id
 * @returns {Promise<{text: string, isError: boolean}>} 模型会看到的内容
 */
async function call(args, agent, callId = 'c') {
  const r = await ctx.tools.execute({
    callId, name: 'knit_docs', arguments: args, agent,
    signal: new AbortController().signal,
  })
  const text = (r.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('')
  return { text, isError: r.isError === true }
}

const agent = { session: { header: { cwd: bare, id: 'sess-check' }, snapshotEvents: () => [] } }

/* ── ③ 执行 + 输出 schema 校验 ───────────────────────── */
console.log('\n② 通过 ctx.tools.execute 执行（输出经真实 schema 校验）')
const cases = [
  ['扩展名白名单都放行什么', '扩展名白名单'],
  ['悬停浮层是怎么做的', '悬停浮层'],
  ['这个灰色太深了，读文档对比度不够', '对比度'],
]
for (const [query, wantTopic] of cases) {
  const { text, isError } = await call({ query, limit: 3 }, agent, 'q_' + wantTopic)
  const first = text.split('\n')[0]
  ok(`query「${query}」`, !isError && text.includes('of 4 Markdown documents'), first)
  ok(`  ↳ 话题是「${wantTopic}」`, text.includes(`「${wantTopic}`), first.match(/「[^」]*」/)?.[0] || '(无)')
}

// v0.11 ②：命中段落。这一条**只有在真实 apply() 里把 readDocument 注入进去**才会出现 ——
// 单测传的是替身，这里传的是 `index.js` 的真实注册路径，所以它守的是「接线」而不是算法。
{
  const { text } = await call({ query: '扩展名白名单都放行什么', limit: 3 }, agent, 'snippet')
  const matchLine = text.split('\n').find((l) => l.includes('match: '))
  ok('命中段落：结果里出现 `match:` 行（证明 readDocument 真的注入了）', Boolean(matchLine),
    matchLine ? matchLine.trim().slice(0, 100) + '…' : '(没有 match 行)')
}

const noQuery = await call({ limit: 2 }, agent, 'q_time')
ok('不传 query 且对话为空 → 如实退回时间序',
  noQuery.text.startsWith('Not enough conversation') && noQuery.text.includes('of 4 Markdown documents'),
  noQuery.text.split('\n')[0])

/* ── ④ 错误路径 ─────────────────────────────────────── */
console.log('\n③ 错误路径（必须是可读错误，不是未捕获异常）')
for (const [label, a] of [
  ['没有 agent', undefined],
  ['有 agent 但没有 cwd', { session: { header: {}, snapshotEvents: () => [] } }],
]) {
  try {
    const { text, isError } = await call({}, a, 'err')
    ok(label, isError && text.includes('workspace root'), text.trim().slice(0, 60))
  } catch (e) {
    ok(label, false, '直接抛异常了: ' + e.message)
  }
}

/* ── ⑤ 面板那行（走同一个 scan()）──────────────────── */
console.log('\n④ 面板那行「按「xxx」排序」（与工具同一个 scan()）')
const { scan } = kit
for (const [query, want] of [['扩展名白名单都放行什么', '扩展名白名单'], ['悬停浮层是怎么做的', '悬停浮层']]) {
  const payload = await scan(bare, 3, { sort: 'relevance', query })
  ok(`topic 含「${want}」`, payload.topic.includes(want), `topic=「${payload.topic}」`)
}

console.log('\n' + (failures === 0 ? '全部通过 ✔' : `${failures} 项失败 ✘`))
console.log('\n⚠️ 本脚本验不了的两件事（要重启 DSH）：')
console.log('   1. 运行中的宿主是否已加载新代码')
console.log('   2. agent 拿到结果后还会不会自己 glob 一遍')
process.exit(failures === 0 ? 0 : 1)

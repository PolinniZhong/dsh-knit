/**
 * v0.11 ③：安全属性**可核验**的守卫。
 *
 * 动机来自 `竞品调研-Codex插件生态.md`：Codex 生态**强制**所有插件过安全扫描
 * 并给六维信任分，而 DSH 市场只有一条「no superlatives」的文案规范，没有任何安全评分。
 * Knit 的安全属性其实已经成立，但**散落在文档和注释里，没有任何一处能被机器核验**。
 *
 * 这个文件的职责不是「再测一遍安全」，而是保证三件事：
 *
 * 1. `SECURITY.md` 里**声称成立**的每条属性，都真的有一个检查在守着
 * 2. `SECURITY.md` 里引用的每个文件路径**都真实存在**（表格不能腐烂）
 * 3. `SECURITY.md` 本身**进得了 npm 包**（否则「随版本一起发」是空话）
 *
 * ⚠️ **允许出现 ❌**：没验证的属性必须标出来，不能靠这个测试「洗成 ✅」。
 * 见 `Knit_PRD-v0.11-agent价值与信任.md` §7.3。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, access } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { resolve, dirname, sep } from 'node:path'

/** 包根：本文件在 `test/` 下，上一层就是包根。 */
const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * 读包内的一个文本文件。
 * @param {string} rel - 相对包根的路径
 * @returns {Promise<string>} 内容
 */
function readPkgFile(rel) {
  return readFile(resolve(PKG_ROOT, rel), 'utf8')
}

/**
 * 判断包内某个路径是否存在（文件或目录都算）。
 * @param {string} rel - 相对包根的路径
 * @returns {Promise<boolean>} 存在与否
 */
async function exists(rel) {
  try {
    await access(resolve(PKG_ROOT, rel))
    return true
  } catch {
    return false
  }
}

/* ── 属性本身：这几条必须永远成立 ─────────────────────── */

test('安全：零运行时依赖', async () => {
  const pkg = JSON.parse(await readPkgFile('package.json'))
  assert.deepEqual(pkg.dependencies || {}, {}, '运行时依赖必须为空')
})

test('安全：没有安装期脚本（用户装的时候不会执行任何东西）', async () => {
  const pkg = JSON.parse(await readPkgFile('package.json'))
  const scripts = Object.keys(pkg.scripts || {})
  const installing = scripts.filter((name) => /^(pre|post)?install$|^prepare$/.test(name))
  assert.deepEqual(installing, [], '不得有安装期脚本，实际：' + installing.join(', '))
})

test('安全：宿主半边不 import `@deepseek-ai/*`（只允许在注释里提到）', async () => {
  // 理由见 AGENTS.md §4.7：Knit 被 link: 挂进 profile，裸 Node 解析不到这些包
  for (const rel of ['src/host/index.js', 'src/host/relevance.js', 'src/host/tool.js']) {
    const source = await readPkgFile(rel)
    const realImports = source
      .split('\n')
      .filter((line) => /^\s*(import|export)\b.*from\s+['"]@deepseek-ai\//.test(line)
        || /^\s*import\s+['"]@deepseek-ai\//.test(line))
    assert.deepEqual(realImports, [], `${rel} 里出现了真实的 @deepseek-ai import`)
  }
})

test('安全：客户端的 fetch 全部指向同源相对路径（零网络出口）', async () => {
  const source = await readPkgFile('src/client/client.js')
  // 三个接口常量必须是同源相对路径 —— 带协议或 // 就是出网了
  const apis = [...source.matchAll(/const\s+\w*API\s*=\s*'([^']+)'/g)].map((m) => m[1])
  assert.ok(apis.length >= 3, '应当至少有 3 个接口常量，实际：' + apis.join(', '))
  for (const api of apis) {
    assert.match(api, /^\/knit\/api\//, `接口必须是 /knit/api/ 开头的同源路径，实际 ${api}`)
    assert.ok(!/^[a-z]+:|^\/\//i.test(api), `接口不得带协议或协议相对写法，实际 ${api}`)
  }
  // 所有 fetch 的第一个参数都应当是这些常量拼出来的，而不是字面量 URL
  const fetches = [...source.matchAll(/fetch\(\s*([^,)]+)/g)].map((m) => m[1].trim())
  assert.ok(fetches.length >= 3, '应当至少有 3 处 fetch')
  for (const target of fetches) {
    assert.ok(
      !/^['"]https?:/.test(target),
      `fetch 不得直接写 http(s) URL，实际 ${target}`,
    )
  }
})

test('安全：`knit_docs` 工具只读 —— 不写任何文件', async () => {
  const source = await readPkgFile('src/host/tool.js')
  // 按调用形态匹配，避免把注释里提到的名字当成调用
  const writes = ['writeFile', 'writeFileSync', 'appendFile', 'appendFileSync',
    'createWriteStream', 'mkdir', 'mkdirSync', 'unlink', 'unlinkSync', 'rm', 'rmSync', 'rename']
    .filter((name) => new RegExp(`\\b${name}\\s*\\(`).test(source))
  assert.deepEqual(writes, [], 'tool.js 里出现了写操作：' + writes.join(', '))
})

/* ── SECURITY.md 自身的完整性 ────────────────────────── */

test('SECURITY.md：存在，且被声明进 npm 包（否则「随版本一起发」不成立）', async () => {
  assert.ok(await exists('SECURITY.md'), 'SECURITY.md 必须存在')
  const pkg = JSON.parse(await readPkgFile('package.json'))
  assert.ok(
    (pkg.files || []).includes('SECURITY.md'),
    'SECURITY.md 必须出现在 package.json 的 files 里，否则不会被发布',
  )
})

test('SECURITY.md：引用的每个包内路径都真实存在（表格不许腐烂）', async () => {
  const md = await readPkgFile('SECURITY.md')
  // 抓反引号里的包内路径：test/xxx.mjs、src/xxx.js、package.json 之类
  const refs = [...md.matchAll(/`((?:test|src|tools)\/[\w./-]+|package\.json)`/g)].map((m) => m[1])
  assert.ok(refs.length >= 3, '表格里应当引用若干真实检查文件，实际引用数：' + refs.length)
  const missing = []
  for (const rel of new Set(refs)) {
    if (!(await exists(rel.split(sep).join('/')))) missing.push(rel)
  }
  assert.deepEqual(missing, [], 'SECURITY.md 引用了不存在的路径：' + missing.join(', '))
})

test('SECURITY.md：每条属性都有状态与证据两列（不许只写「我们声称」）', async () => {
  const md = await readPkgFile('SECURITY.md')
  // 表格行形如：| 属性 | ✅/❌ | 证据 |
  const rows = md
    .split('\n')
    .filter((line) => /^\|\s*[^|\s]/.test(line) && !/^\|\s*-+/.test(line))
    .filter((line) => !/^\|\s*(属性|Property)\s*\|/.test(line))
  assert.ok(rows.length >= 6, '属性行数太少，实际 ' + rows.length)
  for (const row of rows) {
    const cells = row.split('|').map((c) => c.trim()).filter(Boolean)
    assert.ok(cells.length >= 3, `这一行缺少「状态/证据」列：${row.trim()}`)
    assert.match(cells[1], /^(✅|❌|⚠️)/, `状态列必须是 ✅/❌/⚠️，实际「${cells[1]}」`)
    // 只有 ✅ 行的证据必须指向具体检查；❌/⚠️ 行的「证据」本来就是说明，不能强求
    if (cells[1] === '✅') {
      assert.match(
        cells[2],
        /`|测试|test/,
        `✅ 行的证据必须指向一个真实检查（不能是「我们声称」）：${row.trim()}`,
      )
    }
  }
})

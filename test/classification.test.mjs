/**
 * Knit v0.19 · 文件分类层（`src/host/classification.js`）的守卫。
 *
 * 为什么单独一个文件：v0.19 之前，扩展名判断是一个 `kindOfName()` 函数，
 * 而「一个文件能干什么」这件事被**隐含**在三个地方 —— scanner 决定收不收，
 * retrieval 决定要不要给它建索引，preview 决定读不读得出来。三处各自 if。
 *
 * v0.19 把这些浓缩成 `classifyFile()` 返回的**一个固定字段集**：
 *
 *   kind / language / previewable / searchable / contextual / generated / sourceMap
 *
 * 这个文件的职责有三层，缺一层都不算守住：
 *
 * 1. **正向**：支持范围内的后缀必须真的进来，且语言标识正确（不然徽章会说谎）。
 * 2. **负向**：`.map` / minified / bundle / generated / lock 必须**一个都不能**带着
 *    `searchable` 或 `contextual` 为真漏过去。这是 v0.19 最容易出的错 —— 少了这一条，
 *    `dist/bundle.js` 会堂堂正正地进 Context Pack。
 * 3. **架构**：断言扩展名知识**只**住在这一层。`src/host/index.js` 和
 *    `src/client/client.js` 里不许再出现 `'.ts'` / `'.yaml'` 这类后缀字面量。
 *    没有第 3 层，前两层守住的边界会被下一个「顺手加一个 if」拆掉。
 *
 * 全部断言都是纯字符串比较 —— 这一层是纯函数、零 I/O。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

import {
  classifyFile,
  isContextKind,
  isPreviewKind,
  CODE_LANGUAGES,
  UNSUPPORTED_CODE_EXTENSIONS,
  KIND_DOCUMENT,
  KIND_CODE,
  KIND_IMAGE,
  KIND_VIDEO,
  KIND_GENERATED,
  KIND_IGNORED,
} from '../src/host/classification.js'

/**
 * 第一批支持的后缀 → 期望的语言标识（与需求 §4 逐条对应）。
 * 刻意**手写**这张表而不用 `CODE_LANGUAGES` 反推：用被测数据构造期望，
 * 表本身改坏了测试也会跟着改坏，那就什么都没测到。
 */
const SUPPORTED = [
  ['app.js', 'javascript'],
  ['app.mjs', 'javascript'],
  ['app.cjs', 'javascript'],
  ['app.ts', 'typescript'],
  ['Component.tsx', 'tsx'],
  ['Widget.jsx', 'jsx'],
  ['main.py', 'python'],
  ['data.json', 'json'],
  ['index.html', 'html'],
  ['legacy.htm', 'html'],
  ['style.css', 'css'],
  ['theme.scss', 'scss'],
  ['ci.yaml', 'yaml'],
  ['ci.yml', 'yaml'],
  ['run.sh', 'shell'],
  ['run.bash', 'shell'],
  ['run.zsh', 'shell'],
]

/** 明确**不支持**的后缀（需求 §5）—— 必须是 `ignored`，不能是 code。 */
const UNSUPPORTED = ['main.go', 'lib.rs', 'App.java', 'Main.kt', 'core.c', 'core.cpp',
  'core.h', 'core.hpp', 'Program.cs', 'index.php', 'app.rb', 'App.swift', 'schema.sql']

test('classification: 第一批代码后缀全部归为 code，且语言标识正确', () => {
  for (const [name, language] of SUPPORTED) {
    const info = classifyFile(name)
    assert.equal(info.kind, KIND_CODE, `${name} 应该是 code`)
    assert.equal(info.language, language, `${name} 的语言标识应该是 ${language}`)
    assert.equal(info.previewable, true, `${name} 应该可预览`)
    assert.equal(info.searchable, true, `${name} 应该可检索（v0.19 的核心）`)
    assert.equal(info.contextual, true, `${name} 应该可进上下文`)
    assert.equal(info.generated, false, `${name} 不是生成产物`)
    assert.equal(info.sourceMap, false, `${name} 不是 source map`)
  }
})

test('classification: 支持范围外的源码后缀一律 ignored，不偷渡成 code', () => {
  for (const name of UNSUPPORTED) {
    const info = classifyFile(name)
    assert.equal(info.kind, KIND_IGNORED, `${name} 在 v0.19 范围外，应该是 ignored`)
    assert.equal(info.searchable, false, `${name} 不能进 BM25 语料`)
    assert.equal(info.contextual, false, `${name} 不能进 Context Pack`)
    assert.equal(info.previewable, false, `${name} 不给预览（没有语言渲染器，也不做纯文本兜底）`)
  }
  // 名单本身也要对得上：测试表和实现表不能各说各话。
  for (const name of UNSUPPORTED) {
    const ext = name.slice(name.lastIndexOf('.') + 1)
    assert.ok(UNSUPPORTED_CODE_EXTENSIONS.has(ext), `${ext} 应该在 UNSUPPORTED_CODE_EXTENSIONS 里`)
  }
})

test('classification: Markdown 仍是文档，能力位与 v0.18 一致', () => {
  const info = classifyFile('README.md')
  assert.equal(info.kind, KIND_DOCUMENT)
  assert.equal(info.language, 'markdown')
  assert.equal(info.previewable, true)
  assert.equal(info.searchable, true)
  assert.equal(info.contextual, true)
  assert.equal(info.generated, false)
})

test('classification: 图片 / 视频可预览可列出，但不进检索、不进上下文', () => {
  for (const [name, kind] of [['shot.png', KIND_IMAGE], ['clip.mp4', KIND_VIDEO]]) {
    const info = classifyFile(name)
    assert.equal(info.kind, kind, `${name} 的 kind`)
    assert.equal(info.language, null, `${name} 没有语言标识`)
    assert.equal(info.previewable, true, `${name} 可预览（走 /api/raw）`)
    // 这两条是 v0.19 的**向后兼容钉**：媒体行为一个字都没变。
    assert.equal(info.searchable, false, `${name} 不进 BM25 语料`)
    assert.equal(info.contextual, false, `${name} 不进 Context Pack`)
  }
})

test('classification: .map 是 generated —— 能预览，但不进检索 / 上下文 / 列表', () => {
  const info = classifyFile('app.js.map')
  assert.equal(info.kind, KIND_GENERATED)
  assert.equal(info.sourceMap, true, '要被认成 source map，预览里才给那个轻量入口')
  assert.equal(info.previewable, true, '同名源文件存在时要能点开看（需求 §6）')
  assert.equal(info.searchable, false, '**绝不能**进 BM25 语料')
  assert.equal(info.contextual, false, '**绝不能**成为 Primary / Supporting / Related')
  assert.equal(info.generated, true)
  // 大写扩展名与路径形式也要认
  assert.equal(classifyFile('dist/App.JS.MAP').sourceMap, true)
})

test('classification: minified / bundle / generated 产物全部是 generated，且不可检索', () => {
  const names = ['app.min.js', 'app.min.css', 'vendor.bundle.js', 'x.generated.js', 'x.gen.js',
    'y.generated.tsx', 'z.gen.css']
  for (const name of names) {
    const info = classifyFile(name)
    assert.equal(info.kind, KIND_GENERATED, `${name} 应该被过滤成 generated`)
    assert.equal(info.searchable, false, `${name} 不能进 BM25 语料`)
    assert.equal(info.contextual, false, `${name} 不能进 Context Pack`)
    assert.equal(info.previewable, true, `${name} 用户主动打开时仍然能看（Context eligibility ≠ 文件可见性）`)
  }
  // 反例：这些后缀没被规则误伤。
  assert.equal(classifyFile('minify.js').kind, KIND_CODE, 'minify.js 不是压缩产物')
  assert.equal(classifyFile('bundle.js').kind, KIND_CODE, 'bundle.js（无前缀）仍是普通代码')
  assert.equal(classifyFile('generated.js').kind, KIND_CODE, 'generated.js（无前缀）仍是普通代码')
})

test('classification: 锁文件按文件名判定（扩展名是 json，只看后缀会漏）', () => {
  const names = ['package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml',
    'bun.lockb', 'composer.lock', 'cargo.lock', 'poetry.lock', 'Gemfile.lock']
  for (const name of names) {
    const info = classifyFile(name)
    assert.equal(info.kind, KIND_GENERATED, `${name} 应该被过滤`)
    assert.equal(info.searchable, false, `${name} 不能进语料`)
    assert.equal(info.contextual, false, `${name} 不能进上下文`)
  }
  // 反例：普通 json 与不锁的 yaml 不受影响。
  assert.equal(classifyFile('tsconfig.json').kind, KIND_CODE)
  assert.equal(classifyFile('docker-compose.yaml').kind, KIND_CODE)
})

test('classification: 未知类型与无扩展名文件是 ignored，不给纯文本兜底', () => {
  for (const name of ['notes.txt', 'Dockerfile', 'Makefile', 'LICENSE', 'archive.zip',
    'noext', '.gitignore', 'trailing.']) {
    const info = classifyFile(name)
    assert.equal(info.kind, KIND_IGNORED, `${name} 应该是 ignored`)
    assert.equal(info.previewable, false, `${name} **不能**预览：/api/doc 是按路径读文件的接口，兜底等于开后门`)
    assert.equal(info.searchable, false)
    assert.equal(info.contextual, false)
  }
})

test('classification: 大小写与路径形式不影响判定', () => {
  assert.equal(classifyFile('README.MD').kind, KIND_DOCUMENT)
  assert.equal(classifyFile('TSConfig.JSON').kind, KIND_CODE)
  assert.equal(classifyFile('/abs/path/to/Component.tsx').language, 'tsx')
  assert.equal(classifyFile('src\\win\\path\\main.py').language, 'python')
  assert.equal(classifyFile('deep/nested/dir/app.min.js').kind, KIND_GENERATED)
})

test('classification: 判定顺序是契约的一部分（生成规则必须压过代码白名单）', () => {
  // app.min.js 的后缀也是 js，规则顺序反了它就会变成一篇「正经代码」。
  assert.equal(CODE_LANGUAGES.get('js'), 'javascript', '前提：js 确实在代码白名单里')
  assert.equal(classifyFile('app.min.js').kind, KIND_GENERATED)
  // package-lock.json 的后缀也是 json。
  assert.equal(CODE_LANGUAGES.get('json'), 'json', '前提：json 确实在代码白名单里')
  assert.equal(classifyFile('package-lock.json').kind, KIND_GENERATED)
})

test('classification: isContextKind / isPreviewKind 与 classifyFile 的能力位一致', () => {
  for (const name of ['README.md', 'app.ts', 'app.js.map', 'shot.png', 'clip.mp4',
    'main.go', 'notes.txt']) {
    const info = classifyFile(name)
    assert.equal(isContextKind(info.kind), info.contextual,
      `${name}：isContextKind 必须与 contextual 一致`)
    /* ⚠️ `previewable` 与 `isPreviewKind()` **不是同一件事**，别把它们等同起来：
       - `previewable`：用户能不能看到它。图片 / 视频为真 —— 走 `/knit/api/raw`。
       - `isPreviewKind()`：`/knit/api/doc`（**按路径读文件**的接口）放不放行。
         媒体走 /raw，不经 /doc；`ignored` 两边都拒。这条边界是安全属性，不是能力描述。
       所以媒体是「previewable 为真、isPreviewKind 为假」。 */
    const isMedia = info.kind === KIND_IMAGE || info.kind === KIND_VIDEO
    assert.equal(isPreviewKind(info.kind), info.previewable && !isMedia,
      `${name}：isPreviewKind 必须与「previewable 且不走 /api/raw」一致`)
    if (isMedia) {
      assert.equal(info.previewable, true, `${name}：媒体走 /api/raw，仍然可预览`)
      assert.equal(isPreviewKind(info.kind), false, `${name}：媒体不经 /api/doc`)
    }
  }
  // 只有文档与代码能进上下文 —— 这一版的核心边界。
  assert.equal(isContextKind(KIND_GENERATED), false)
  assert.equal(isContextKind(KIND_IMAGE), false)
  assert.equal(isContextKind(KIND_VIDEO), false)
  assert.equal(isContextKind(KIND_IGNORED), false)
  // 只有文本类产物能被 /api/doc 读出来。
  assert.equal(isPreviewKind(KIND_DOCUMENT), true)
  assert.equal(isPreviewKind(KIND_CODE), true)
  assert.equal(isPreviewKind(KIND_GENERATED), true, '.map 要能点开看（需求 §6）')
  assert.equal(isPreviewKind(KIND_IGNORED), false, '未知类型不给纯文本兜底')
})

test('architecture: 扩展名知识只住在 classification.js，不许散落回 scanner / UI', async () => {
  // 这一条守的不是行为，是**结构**。没有它，上面那些边界会被下一个
  // 「顺手在 client 里加一个 if (name.endsWith('.map'))」拆掉。
  const files = ['../src/host/index.js', '../src/client/client.js']
  const literals = ["'.ts'", "'.tsx'", "'.jsx'", "'.py'", "'.json'", "'.yaml'",
    "'.yml'", "'.scss'", "'.map'", "'.min.js'", "'.bundle.js'", "'.generated.js'"]
  for (const rel of files) {
    const path = fileURLToPath(new URL(rel, import.meta.url))
    const text = await readFile(path, 'utf8')
    for (const literal of literals) {
      assert.equal(text.includes(literal), false,
        `${rel} 里出现了后缀字面量 ${literal} —— 判定必须回到 classification.js`)
    }
  }
})

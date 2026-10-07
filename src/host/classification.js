/**
 * Knit · **文件分类层**（v0.19）
 *
 * ## 为什么要有这一层
 *
 * v0.18 之前，「这个文件 Knit 管不管」只由一个 `kindOfName(name)` 回答：
 * `md` / `image` / `video`，其余一律丢掉。v0.19 要把代码纳入检索，如果继续在
 * scanner、retrieval、preview、UI 里各写一段 `if (ext === '.js')`，同一个判断会散成
 * 四五份互相漂移的副本 —— 加一个扩展名要改四个地方，漏一个就是一个静默的 bug。
 *
 * 所以判断收拢到这里：**`classifyFile(name)` 是唯一的事实来源。**
 * 其余模块只消费它的结果，不再看扩展名。
 *
 * ## 返回的不是一个字符串，而是一组「这个文件能用来做什么」
 *
 * 三个布尔位是这一层的核心，它们回答的是三个**互相独立**的问题：
 *
 * - `searchable`  —— 能不能进 BM25 语料（能不能被任务检索到）
 * - `contextual`  —— 能不能成为 Context Pack 候选（Primary / Supporting / Related）
 * - `previewable` —— Knit 面板能不能内联预览它
 *
 * 三者**不等价**，`.map` 就是那个把它们撕开的例子：
 * 它是文本（`previewable`）、但它不是上下文（`searchable:false, contextual:false`）。
 * 把这三件事压成一个「类型」字段，`.map` 这种边界就只能靠特判活下去。
 *
 * ## 边界（v0.19 需求 §5 §6 §7）
 *
 * - 代码白名单**严格限定**第一批高频 AI Coding 扩展名；`.go` / `.rs` / `.java` ...
 *   这一版明确不支持（返回 `ignored`），不是遗漏，是范围控制。
 * - `.map` / `.min.js` / `.bundle.js` / `.generated.js` / `.gen.js` / `*.lock`
 *   归为 `generated`：**能预览，但不进检索、不进上下文、不进列表**。
 * - 未知扩展名归为 `ignored`：Knit 不管它（不做 plain-text 兜底 —— `/knit/api/doc`
 *   是按路径读文件的接口，兜底等于把「读工作区里任意文件」的口子重新打开）。
 *
 * 这一层是**纯函数、零 I/O、零依赖**：给一个文件名，立刻得到一个答案。
 */

/** 列表条目类型。前四个是「会出现在列表里」的产物类型，后两个是**不出现**的。 */
export const KIND_DOCUMENT = 'md'
export const KIND_CODE = 'code'
export const KIND_IMAGE = 'image'
export const KIND_VIDEO = 'video'
/** 生成/调试产物：可预览，但不参与检索与上下文（`.map` / minified / lock ...）。 */
export const KIND_GENERATED = 'generated'
/** Knit 不管的类型（这一版不支持的代码语言、二进制、未知扩展名）。 */
export const KIND_IGNORED = 'ignored'

/**
 * 允许内联渲染的图片类型白名单。
 *
 * `/knit/api/raw` 是按路径读文件的接口，口子必须收窄：只有在这个表里的扩展名才放行，
 * 否则就成了「能读工作区里任意文件」的后门。
 */
export const IMAGE_TYPES = new Map([
  ['png', 'image/png'],
  ['jpg', 'image/jpeg'],
  ['jpeg', 'image/jpeg'],
  ['gif', 'image/gif'],
  ['webp', 'image/webp'],
  ['avif', 'image/avif'],
  ['bmp', 'image/bmp'],
  ['ico', 'image/x-icon'],
  ['svg', 'image/svg+xml'],
])

/**
 * 允许内联渲染的视频类型白名单。
 * 与 IMAGE_TYPES 同样的口径：只放行表里的扩展名，/raw 不读其它任何文件。
 */
export const VIDEO_TYPES = new Map([
  ['mp4', 'video/mp4'],
  ['m4v', 'video/mp4'],
  ['webm', 'video/webm'],
  ['mov', 'video/quicktime'],
  ['ogv', 'video/ogg'],
])

/**
 * **第一批**支持的代码语言（v0.19 需求 §4）。
 *
 * 严格控制范围是这一版的设计目标之一：先验证「代码上下文有没有用」，
 * 而不是「支持了多少语言」。所以 `.go` / `.rs` / `.java` / `.kt` / `.c` / `.cpp` /
 * `.h` / `.hpp` / `.cs` / `.php` / `.rb` / `.swift` / `.sql` **刻意不在表里**。
 *
 * `language` 是给界面显示徽章用的稳定标识，不是语法分析结论 —— Knit 不做 AST。
 */
export const CODE_LANGUAGES = new Map([
  ['js', 'javascript'],
  ['mjs', 'javascript'],
  ['cjs', 'javascript'],
  ['ts', 'typescript'],
  ['tsx', 'tsx'],
  ['jsx', 'jsx'],
  ['py', 'python'],
  ['json', 'json'],
  ['html', 'html'],
  ['htm', 'html'],
  ['css', 'css'],
  ['scss', 'scss'],
  ['yaml', 'yaml'],
  ['yml', 'yaml'],
  ['sh', 'shell'],
  ['bash', 'shell'],
  ['zsh', 'shell'],
])

/**
 * 明确**不支持**的代码扩展名（v0.19 需求 §5）。
 *
 * 存在的意义不是分类（它们本来就落到 `ignored`），而是给测试和文档一个
 * 可引用的名单：**这是被决定的边界，不是被忘掉的东西。**
 */
export const UNSUPPORTED_CODE_EXTENSIONS = new Set([
  'go', 'rs', 'java', 'kt', 'c', 'cpp', 'h', 'hpp', 'cs', 'php', 'rb', 'swift', 'sql',
])

/** 锁文件：文件名级判定（`package-lock.json` 的扩展名是 `json`，只看扩展名会漏）。 */
const LOCK_FILES = new Set([
  'package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml', 'pnpm-lock.yml',
  'bun.lockb', 'bun.lock', 'composer.lock', 'cargo.lock', 'gemfile.lock', 'poetry.lock',
  'pipfile.lock',
])

/** 压缩产物：`foo.min.js` / `foo.min.css`。 */
const MINIFIED_RE = /\.min\.(?:js|cjs|mjs|css)$/
/** 打包产物：`foo.bundle.js`。 */
const BUNDLE_RE = /\.bundle\.(?:js|cjs|mjs)$/
/** 生成产物：`foo.generated.js` / `foo.gen.js`。 */
const GENERATED_RE = /\.(?:generated|gen)\.(?:js|cjs|mjs|ts|tsx|jsx|css)$/

/**
 * 取文件名的最后一段（同时容忍传进来的是相对路径或绝对路径）。
 * @param {string} name - 文件名或路径
 * @returns {string} 文件名
 */
function baseName(name) {
  const text = String(name == null ? '' : name)
  const cut = Math.max(text.lastIndexOf('/'), text.lastIndexOf('\\'))
  return cut >= 0 ? text.slice(cut + 1) : text
}

/**
 * 取小写扩展名（无扩展名返回空串）。
 * @param {string} base - 文件名
 * @returns {string} 扩展名
 */
function extName(base) {
  const dot = base.lastIndexOf('.')
  if (dot <= 0 || dot === base.length - 1) return ''
  return base.slice(dot + 1).toLowerCase()
}

/**
 * 造一条分类结果。字段固定，避免调用方拿到 undefined 再各自兜底。
 * @param {string} kind - 产物类型
 * @param {string|null} language - 语言标识（没有就 null）
 * @param {{previewable?:boolean, searchable?:boolean, contextual?:boolean,
 *          generated?:boolean, sourceMap?:boolean}} flags - 三个能力位与两个标记
 * @returns {object} 分类结果
 */
function record(kind, language, flags) {
  return {
    kind,
    language: language || null,
    previewable: flags.previewable !== false,
    searchable: flags.searchable === true,
    contextual: flags.contextual === true,
    generated: flags.generated === true,
    sourceMap: flags.sourceMap === true,
  }
}

/** 生成/噪声产物：可预览，绝不进检索与上下文。 */
function generated(language, sourceMap = false) {
  return record(KIND_GENERATED, language, {
    previewable: true, searchable: false, contextual: false, generated: true, sourceMap,
  })
}

/**
 * 判定一个文件属于哪一类、能用来做什么。
 *
 * 顺序是**判定的一部分**，不能重排：生成规则必须在代码白名单之前
 * （`app.min.js` 的扩展名也是 `js`），文件名级规则必须在扩展名规则之前
 * （`package-lock.json` 的扩展名也是 `json`）。
 *
 * @param {string} name - 文件名（也接受路径，只取最后一段）
 * @returns {{kind:string, language:string|null, previewable:boolean, searchable:boolean,
 *            contextual:boolean, generated:boolean, sourceMap:boolean}} 分类结果
 */
export function classifyFile(name) {
  const base = baseName(name).toLowerCase()
  const ext = extName(base)

  // ① 生成 / 噪声产物：可预览，但不进检索、不进上下文、不进列表。
  if (ext === 'map') return generated(null, true)
  if (ext === 'lock' || LOCK_FILES.has(base)) return generated(null)
  if (MINIFIED_RE.test(base) || BUNDLE_RE.test(base) || GENERATED_RE.test(base)) {
    return generated(CODE_LANGUAGES.get(ext) || null)
  }

  // ② Markdown 文档。
  if (ext === 'md') {
    return record(KIND_DOCUMENT, 'markdown', {
      previewable: true, searchable: true, contextual: true,
    })
  }

  // ③ 代码（第一批白名单）。
  const language = CODE_LANGUAGES.get(ext)
  if (language) {
    return record(KIND_CODE, language, {
      previewable: true, searchable: true, contextual: true,
    })
  }

  // ④ 媒体：沿用 v0.18 的行为（可预览、可列出，但不进 BM25 语料）。
  if (IMAGE_TYPES.has(ext)) {
    return record(KIND_IMAGE, null, { previewable: true, searchable: false, contextual: false })
  }
  if (VIDEO_TYPES.has(ext)) {
    return record(KIND_VIDEO, null, { previewable: true, searchable: false, contextual: false })
  }

  // ⑤ 其余：Knit 不管。
  return record(KIND_IGNORED, null, { previewable: false, searchable: false, contextual: false })
}

/**
 * 这个类型能不能作为 Context Pack 候选（Primary / Supporting / Related）。
 *
 * `all` 档是「文档 + 代码」，媒体沿用 v0.18 —— 媒体不进上下文。
 * @param {string} kind - 产物类型
 * @returns {boolean} 是否可作为上下文候选
 */
export function isContextKind(kind) {
  return kind === KIND_DOCUMENT || kind === KIND_CODE
}

/**
 * 这个类型能不能被 `/knit/api/doc` 读出来预览。
 *
 * 只放行**文本类**产物：文档、代码、生成产物（`.map` 要能点开看）。
 * 媒体走 `/knit/api/raw`，`ignored` 一律拒绝 —— 这是安全边界，不是能力边界。
 * @param {string} kind - 产物类型
 * @returns {boolean} 是否可预览
 */
export function isPreviewKind(kind) {
  return kind === KIND_DOCUMENT || kind === KIND_CODE || kind === KIND_GENERATED
}

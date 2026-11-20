/**
 * Knit · **Git 变更状态读取**（v0.25 Git-aware Context Retrieval）
 *
 * 这一层只回答一个问题：**这个工作区现在有哪些文件被改过、各自是什么状态**。
 * 它**不解析 diff、不读文件内容、不做任何写操作** —— 只跑一条只读的 `git status`。
 *
 * ## 五条硬约束（用户需求 §三.1 / §三.4）
 *
 *   1. **只读**：只允许两个子命令 —— `status` 与 `rev-parse --show-prefix`
 *      （见 `GIT_STATUS_ARGS` / `GIT_PREFIX_ARGS` 与 `MUTATING_VERBS` 的守卫）。
 *      没有 `add` / `commit` / `checkout` / `reset` / `clean` / `stash` … 一条都没有，也永远不会有。
 *   2. **绝不走 shell**：`spawn('git', [...GIT_GLOBAL_ARGS, ...args])`，参数是数组。
 *      全局选项见 `GIT_GLOBAL_ARGS` —— 它挡的是「git 自己被配置牵着去写盘 / 去起进程」。
 *   3. **有界**：`GIT_TIMEOUT_MS` 到点就 kill；`GIT_MAX_BYTES` 超了就 kill 并如实报 `output-too-large`；
 *      解析出来的条目超过 `MAX_CHANGED_FILES` 就截断并标记。**任何一条都不抛**。
 *   4. **失败明着降级**：`not-a-repo` / `git-missing` / `timeout` / `output-too-large` / `failed-fatal`
 *      五种 reason；调用方据此照常出原来的列表，只是不显示变更关联。
 *   5. **零依赖**：只用 Node 内置 `child_process`。**不 import `@deepseek-ai/*`**（AGENTS L1 §6.10）。
 *
 * ## 为什么不用 `--porcelain=v2`
 *
 * v1 的 `-z` 已经给全了我们要的四样（X / Y / 路径 / 重命名原路径），而且 2.7+ 都有。
 * v2 多出来的字段（mode、对象 id）我们一个都不用 —— 不引入用不上的解析面。
 *
 * ## 路径基准（实测过，不是猜的）
 *
 * `git status --porcelain` 的路径**恒以仓库根为基准** —— 从子目录跑也一样
 * （2026-10-13 实测：在 `src/` 下跑，输出仍是 `src/foo.ts`）。所以要把**工作区**
 * 那一层前缀（`git rev-parse --show-prefix`）减掉，两条命令各司其职。
 * 不在这个前缀下的路径（同一个仓库里、但工作区之外）**直接丢弃**，不算变更。
 *
 * 重命名的字段顺序也是实测的：`-z` 下是 `R  <新路径>\0<原路径>\0`（新在前）——
 * v1 与 v2 两种口径在这一点上一致。
 */

import { spawn } from 'node:child_process'

/** 单次 git 调用的墙钟上限。到点 kill，如实回 `timeout`。 */
export const GIT_TIMEOUT_MS = 2500
/** 单次 git 调用的 stdout 上限（字节）。超了 kill，如实回 `output-too-large`。 */
export const GIT_MAX_BYTES = 1 << 20
/** 结果缓存的存活时长。面板每 5 秒轮询一次，8 秒 ⇒ 一条 git 大约每两轮跑一次。 */
export const GIT_CACHE_TTL_MS = 8000
/** 工作区前缀（`--show-prefix`）的缓存时长 —— 它几乎不变，也顺便缓存「不是仓库」这个结论。 */
export const GIT_PREFIX_TTL_MS = 60_000
/** 解析出来的变更条目上限（超过就截断并标 `truncated`）。 */
export const MAX_CHANGED_FILES = 200
/** 下发到面板的变更清单上限（条目上限是为了载荷体积，与上面的解析上限不是一回事）。 */
export const MAX_REPORTED_FILES = 30

/**
 * **每次调用都带的全局选项**（在子命令之前）。这三项都是**实测**出来的，不是"照文档加上去"：
 *
 * | 选项 | 挡掉什么 | 本机实测（git 2.50.1 / Apple Git-155，2026-10-13） |
 * |---|---|---|
 * | `--no-optional-locks` | `git status` 顺手**重写 `.git/index`**（刷新 stat 缓存 / untracked cache） | 300 文件 + `core.untrackedCache=true` + stat 缓存全过期：裸 `status` **3/3 次**写了 `.git/index`；带这个选项 **0/3 次** |
 * | `-c core.fsmonitor=false` | `core.fsmonitor` 指向**外部钩子**时会**执行那个命令**；为 `true` 时 `git status` 会**拉起 builtin fsmonitor 守护进程**并落 `.git/fsmonitor--daemon` | 钩子形态：裸 `status` 让假钩子**跑了 1 次**（写日志），带覆盖 **0 次**；builtin 形态：裸 `status` 之后 `.git/fsmonitor--daemon` + `.ipc` **存在**，带覆盖**不存在** |
 * | `--no-pager` | 万一有人在全局配了 `pager.status` / `GIT_PAGER`，`status` 会去**起一个分页器进程** | 关掉分页器这条路，与输出是否 TTY 无关 |
 *
 * ⚠️ 这三项是**只读承诺的一部分**：固定 argv + 不走 shell 只挡住"我们主动写"，
 * 挡不住 **git 自己被配置牵着去写 / 去起进程**。这一层才是把"只读"真正闭合的地方。
 */
export const GIT_GLOBAL_ARGS = ['--no-optional-locks', '--no-pager', '-c', 'core.fsmonitor=false']

/** **唯一**允许的三个 git 子命令。改这个数组 = 改安全边界。 */
export const GIT_STATUS_ARGS = ['status', '--porcelain=v1', '-z', '--untracked-files=all']
export const GIT_PREFIX_ARGS = ['rev-parse', '--show-prefix']
/**
 * v0.26.x「变更」档：**只读 diff 的行数统计，不读 diff 正文**。
 *
 * `--numstat` 只输出 `added\tdeleted\tpath`，正文一个字节都不吐；`--no-renames`
 * 让「重命名」退化成一删一增（计数简单、可确定），状态仍由 `git status` 给出。
 * ⚠️ 仍然不带任何写动词；仍然是固定 argv + 不走 shell。
 */
export const GIT_NUMSTAT_ARGS = ['diff', '--numstat', '-z', '--no-renames', 'HEAD']
/**
 * v0.26.x「变更」档的逐行 diff：**只读**、固定 argv、不调用外部 diff / textconv。
 * `--` 之后才是客户端给的文件路径，且由上层先 resolve 回工作区根。
 */
export const GIT_DIFF_ARGS = ['diff', '--no-color', '--no-ext-diff', '--no-textconv', '--unified=3', 'HEAD', '--']
/** diff 正文上限（字节 / 行）；超过就截断并如实标记。 */
export const MAX_DIFF_BYTES = 512 * 1024
export const MAX_DIFF_LINES = 1200
/** 行数统计的 stdout 上限（比 status 小一个量级；它只有数字和路径）。 */
export const MAX_NUMSTAT_BYTES = 256 * 1024

/**
 * 允许从父进程**继承**的环境变量（白名单）。
 *
 * ⚠️ 这是一条**安全边界**，不是整理癖。`git` 自己承认的一批环境变量能让它读**别的仓库**、
 * 用**别的索引**、往**任意文件**写日志 —— 继承宿主进程的环境就等于把这些开关交给外面：
 *
 * | 变量 | 实测后果（git 2.50.1，2026-10-13，见 `test/git-changes.test.mjs`） |
 * |---|---|
 * | `GIT_DIR` + `GIT_WORK_TREE` | 指向另一个仓库后，`git status` **完全读那个仓库**：本工作区真实存在的改动 `M a.ts` 在结果里**消失** |
 * | `GIT_INDEX_FILE` | 换成一个不存在的索引后，已提交的 `a.ts` 被报成 `D` + `??`，而且结果里混进了**另一个仓库**的文件名 |
 * | `GIT_TRACE` | `git status` 往那个路径**写了 3 行日志**（真实写入） |
 *
 * 所以规则是**白名单 + 前缀**：只继承下面这些「与 Git 配置无关的运行时必需品」，
 * 然后**任何 `GIT_*` 一律不继承**（无论 git 将来新增什么变量，这条规则自动覆盖）。
 * `HOME` / `XDG_CONFIG_HOME` 必须留着 —— 它们决定**全局配置与 ignore 规则**从哪来，
 * 抹掉会让「哪些文件算未跟踪」这个答案跟着变。
 */
export const GIT_ENV_ALLOW = Object.freeze([
  // 可执行文件与语言：`PATH` 决定能不能找到 git 与它的子程序；locale 影响 stderr 文案
  // （我们要从 stderr 认「not a git repository」），也影响路径的编码解释。
  'PATH', 'LANG', 'LC_ALL', 'LC_CTYPE', 'LC_MESSAGES',
  // 全局配置与 ignore 规则的来源 —— **不能抹**，抹了未跟踪集合就变了。
  'HOME', 'XDG_CONFIG_HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH',
  // 临时目录（git 偶尔要在 TMPDIR 里落临时文件）。
  'TMPDIR', 'TMP', 'TEMP',
  // Windows 上跑起来的必需品（插件在 mac 上开发，但不能让别的平台直接坏掉）。
  'SystemRoot', 'SystemDrive', 'windir', 'ComSpec', 'PATHEXT',
  'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA', 'ProgramFiles', 'ProgramFiles(x86)',
])

/**
 * 子进程环境：**白名单 + 我们自己设的只读运行参数**。
 *
 * `GIT_OPTIONAL_LOCKS=0` 是 `--no-optional-locks` 的环境变量等价物（git(1) 明说两者等价），
 * 两条一起给是冗余保险；另外两条把分页器与终端提示钉死。
 *
 * @param {object} [base] - 父进程环境（默认 `process.env`；注入是为了单测）
 * @returns {object} 交给 `spawn` 的环境
 */
export function gitEnv(base = process.env) {
  const env = {}
  for (const key of GIT_ENV_ALLOW) {
    if (base && base[key] !== undefined) env[key] = base[key]
  }
  // 前缀规则（**冗余但保留**）：就算将来有人往白名单里手滑加了一个 `GIT_*`，这里也会删掉它。
  for (const key of Object.keys(env)) {
    if (key.startsWith('GIT_')) delete env[key]
  }
  return { ...env, ...GIT_ENV }
}

/**
 * 我们自己显式设置的**只读**运行参数（在白名单之后覆盖上去，所以它们一定生效）。
 */
export const GIT_ENV = Object.freeze({
  GIT_OPTIONAL_LOCKS: '0',
  GIT_PAGER: 'cat',
  GIT_TERMINAL_PROMPT: '0',
})
/** 这些动词**一个都不许**出现在上面两个数组里（有守卫钉着）。 */
export const MUTATING_VERBS = [
  'add', 'commit', 'checkout', 'reset', 'clean', 'stash', 'push', 'pull', 'fetch',
  'merge', 'rebase', 'cherry-pick', 'revert', 'rm', 'mv', 'restore', 'switch', 'apply', 'update-index',
]

/** 五种降级原因（`null` = 正常）。客户端按码翻译，宿主不返回文案（AGENTS L1 §6.8）。 */
export const GIT_REASONS = ['not-a-repo', 'git-missing', 'timeout', 'output-too-large', 'failed-fatal']

/**
 * 一次 `git status` 的原始输出 → 变更条目。**纯函数**，零 I/O、零时钟。
 *
 * 输入是 `--porcelain=v1 -z` 的原文。格式（实测）：
 *
 * ```
 * XY PATH\0                     普通条目
 * XY NEWPATH\0OLDPATH\0         X 是 R 或 C 时，紧跟一个原路径字段
 * ```
 *
 * @param {string} raw - stdout 原文（含 NUL）
 * @param {{prefix?: string}} [options] - 工作区相对仓库根的前缀（`'src/'` 或 `''`）
 * @returns {Array<{rel: string, x: string, y: string, kinds: string[], origRel?: string, isDir: boolean}>}
 *   按路径字典序（确定性）；不在 `prefix` 下的路径**丢弃**
 */
export function parseStatusZ(raw, options = {}) {
  const prefix = typeof options.prefix === 'string' ? options.prefix : ''
  const text = typeof raw === 'string' ? raw : ''
  const fields = text.split('\0')
  const out = []
  for (let i = 0; i < fields.length; i += 1) {
    const entry = fields[i]
    // 末段是空串（`-z` 以 NUL 结尾）或半截，跳过
    if (!entry || entry.length < 4) continue
    const x = entry[0]
    const y = entry[1]
    // 第 3 个字符是分隔空格；但 `??` 这类也遵守同一形状（`?? path`）
    if (entry[2] !== ' ') continue
    let path = entry.slice(3)
    let orig = null
    if (x === 'R' || x === 'C') {
      // 重命名 / 复制：下一个 NUL 字段是**原路径**（新在前，实测）
      i += 1
      orig = fields[i] === undefined ? null : fields[i]
      if (orig === '') orig = null
    }
    const trimmed = trimPrefix(path, prefix)
    if (trimmed === null) continue // 同一个仓库里、但工作区之外
    const isDir = trimmed.endsWith('/')
    const rel = isDir ? trimmed.slice(0, -1) : trimmed
    if (!rel) continue
    const origRel = orig === null ? undefined : (trimPrefix(orig, prefix) || undefined)
    out.push({ rel, x, y, kinds: kindsOf(x, y), ...(origRel ? { origRel: isDir ? origRel.replace(/\/$/, '') : origRel } : {}), isDir })
  }
  out.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0))
  return out
}

/** 把仓库根基准的路径换成工作区基准；不在工作区内返回 `null`。 */
function trimPrefix(path, prefix) {
  if (!prefix) return path
  if (!path.startsWith(prefix)) return null
  return path.slice(prefix.length)
}

/**
 * `XY` 两位 → 人话里的状态集合。
 *
 * X = 索引（HEAD → 索引），Y = 工作区（索引 → 磁盘）。两者**可以同时非空**（`MM`），
 * 所以这里给的是一个**集合**而不是一个枚举 —— 把 `MM` 压成一个标签会丢掉一半事实。
 *
 * @param {string} x - 第一位
 * @param {string} y - 第二位
 * @returns {string[]} 取值来自 `staged` / `unstaged` / `untracked` / `deleted` / `renamed` / `copied` / `added` / `unmerged`
 */
export function kindsOf(x, y) {
  if (x === '?' && y === '?') return ['untracked']
  const kinds = []
  // 冲突态（merge / rebase 未解决）：`UU` / `AA` / `DD` / `UD` / `DU` / `AU` / `UA`。
  // ⚠️ **这几位不能按「索引侧 / 工作区侧」去读** —— 它们说的是冲突的种类，不是「改好了 / 还没改」。
  // 所以这里**直接返回**，不再补 `staged` / `unstaged`：对一个冲突文件说「已暂存 + 未暂存」
  // 是错的（写完当场被守卫抓到过一次）。`DD` 那种**确实同时是删除**，所以 `deleted` 照旧给。
  const unmerged = x === 'U' || y === 'U' || (x === 'A' && y === 'A') || (x === 'D' && y === 'D')
  if (x === 'D' || y === 'D') kinds.push('deleted')
  if (unmerged) {
    kinds.push('unmerged')
    return kinds
  }
  if (x === 'A') kinds.push('added')
  if (x === 'R') kinds.push('renamed')
  if (x === 'C') kinds.push('copied')
  // X 侧 = 索引相对 HEAD 的变化；Y 侧 = 工作区相对索引的变化。两者可以同时成立（`MM`）。
  if (x !== ' ' && x !== '?') kinds.push('staged')
  if (y !== ' ' && y !== '?') kinds.push('unstaged')
  return kinds
}

/**
 * 一次 `git diff --numstat -z --no-renames HEAD` 的输出 → 每文件行数。**纯函数**。
 *
 * 格式（`-z`，`--no-renames`）：`ADDED\tDELETED\tPATH\0`；二进制文件的两个数是 `-`。
 * 路径以仓库根为基准，和 status 一样要减掉工作区前缀；工作区外的丢弃。
 *
 * @param {string} raw - stdout 原文
 * @param {{prefix?: string}} [options] - 工作区相对仓库根的前缀
 * @returns {Map<string,{added:number|null,deleted:number|null,binary:boolean}>} rel → 计数
 */
export function parseNumstatZ(raw, options = {}) {
  const prefix = typeof options.prefix === 'string' ? options.prefix : ''
  const text = typeof raw === 'string' ? raw : ''
  const out = new Map()
  for (const entry of text.split('\0')) {
    if (!entry) continue
    const first = entry.indexOf('\t')
    if (first < 0) continue
    const second = entry.indexOf('\t', first + 1)
    if (second < 0) continue
    const path = trimPrefix(entry.slice(second + 1), prefix)
    if (!path) continue
    const addedRaw = entry.slice(0, first)
    const deletedRaw = entry.slice(first + 1, second)
    const binary = addedRaw === '-' || deletedRaw === '-'
    out.set(path, {
      added: binary ? null : Number(addedRaw),
      deleted: binary ? null : Number(deletedRaw),
      binary,
    })
  }
  return out
}

/**
 * 把 `git diff --unified=3` 的原文解析成可渲染的行。**纯函数**。
 *
 * 只保留 hunk 内真正的内容行（上下文 / 新增 / 删除），并把新旧行号算好；
 * `diff --git` / `index` / `---` / `+++` 这些元信息不返回（前端只画内容）。
 * 二进制文件由调用方看 stdout 里的 `Binary files` 判定。
 *
 * @param {string} raw - diff 原文
 * @param {{maxLines?: number}} [options] - 最多保留多少内容行
 * @returns {{lines: Array<{type:'context'|'add'|'del', oldNo:number|null, newNo:number|null, text:string}>,
 *   added:number, removed:number, truncated:boolean, hunks:number}} 解析结果
 */
export function parseUnifiedDiff(raw, options = {}) {
  const text = typeof raw === 'string' ? raw : ''
  const maxLines = Number.isInteger(options.maxLines) && options.maxLines > 0 ? options.maxLines : MAX_DIFF_LINES
  const lines = []
  let oldNo = 0
  let newNo = 0
  let added = 0
  let removed = 0
  let hunks = 0
  let truncated = false
  for (const rawLine of text.split('\n')) {
    if (rawLine.startsWith('@@')) {
      const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(rawLine)
      if (!match) continue
      oldNo = Number(match[1]) - 1
      newNo = Number(match[2]) - 1
      hunks += 1
      lines.push({ type: 'hunk', oldNo: null, newNo: null, text: rawLine })
      continue
    }
    if (rawLine.startsWith('diff --git') || rawLine.startsWith('index ')
      || rawLine.startsWith('--- ') || rawLine.startsWith('+++ ')
      || rawLine.startsWith('new file mode') || rawLine.startsWith('deleted file mode')
      || rawLine.startsWith('old mode') || rawLine.startsWith('new mode')
      || rawLine.startsWith('similarity index') || rawLine.startsWith('rename from')
      || rawLine.startsWith('rename to') || rawLine.startsWith('Binary files')) continue
    if (rawLine.startsWith('\\ No newline')) continue
    if (!rawLine && oldNo === 0 && newNo === 0) continue
    let type = 'context'
    let content = rawLine
    if (rawLine.startsWith('+')) { type = 'add'; content = rawLine.slice(1); added += 1; newNo += 1 }
    else if (rawLine.startsWith('-')) { type = 'del'; content = rawLine.slice(1); removed += 1; oldNo += 1 }
    else if (rawLine.startsWith(' ')) { content = rawLine.slice(1); oldNo += 1; newNo += 1 }
    else continue
    if (lines.length >= maxLines) { truncated = true; break }
    lines.push({
      type,
      oldNo: type === 'add' ? null : oldNo,
      newNo: type === 'del' ? null : newNo,
      text: content,
    })
  }
  return { lines, added, removed, truncated, hunks }
}

/**
 * 默认的 `exec`：`spawn('git', args)` + 两个上限。**不走 shell**。
 *
 * @param {string[]} args - argv（第一个元素是子命令）
 * @param {{cwd: string, timeoutMs?: number, maxBytes?: number}} options
 * @returns {Promise<{code: number|null, stdout: string, stderr: string, killed: null|'timeout'|'too-large'}>}
 */
export function spawnGit(args, options) {
  const timeoutMs = Number(options && options.timeoutMs) > 0 ? Number(options.timeoutMs) : GIT_TIMEOUT_MS
  const maxBytes = Number(options && options.maxBytes) > 0 ? Number(options.maxBytes) : GIT_MAX_BYTES
  return new Promise((resolve) => {
    let child
    try {
      // ⚠️ 全局选项**必须拼在子命令之前** —— `git status --no-optional-locks` 不是合法写法。
      child = spawn('git', [...GIT_GLOBAL_ARGS, ...args], {
        cwd: options.cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        // ⚠️ **不是** `{...process.env, ...GIT_ENV}` —— 继承宿主环境会把 `GIT_DIR` /
        // `GIT_INDEX_FILE` / `GIT_TRACE` 这些开关一起带进来（见 `GIT_ENV_ALLOW` 的表）。
        env: gitEnv(),
      })
    } catch (error) {
      resolve({ code: null, stdout: '', stderr: String((error && error.message) || error), killed: null, spawnError: true })
      return
    }
    let stdout = ''
    let stderr = ''
    let killed = null
    let bytes = 0
    let settled = false
    const finish = (result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ ...result, killed })
    }
    const timer = setTimeout(() => { killed = 'timeout'; try { child.kill('SIGKILL') } catch { /* 已经没了 */ } }, timeoutMs)
    child.stdout.on('data', (chunk) => {
      if (killed) return
      bytes += chunk.length
      if (bytes > maxBytes) {
        killed = 'too-large'
        try { child.kill('SIGKILL') } catch { /* 已经没了 */ }
        return
      }
      stdout += chunk.toString('utf8')
    })
    child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8').slice(0, 4096) })
    child.on('error', (error) => {
      finish({ code: null, stdout, stderr, spawnError: true, message: String((error && error.message) || error) })
    })
    child.on('close', (code) => { finish({ code, stdout, stderr, spawnError: false }) })
  })
}

/** 把一次 exec 的结果收敛成「成功 / 某个 reason」，**绝不抛**。 */
function reasonOf(result) {
  if (!result) return 'failed-fatal'
  if (result.spawnError) return 'git-missing'
  if (result.killed === 'timeout') return 'timeout'
  if (result.killed === 'too-large') return 'output-too-large'
  if (result.code !== 0) {
    const err = String(result.stderr || '')
    if (/not a git repository/i.test(err)) return 'not-a-repo'
    return 'failed-fatal'
  }
  return null
}

/**
 * 造一个**带缓存**的 Git 读取器。
 *
 * 注入 `exec` 是为了可测：测试给它一个纯函数（返回固定 stdout），于是解析、分类、
 * 降级三条路径都能确定性复现，不需要真的建仓库。
 *
 * @param {{exec?: Function, now?: Function, ttlMs?: number, prefixTtlMs?: number}} [options]
 * @returns {{read: (root: string) => Promise<object>, reset: Function}}
 */
export function createGitReader(options = {}) {
  const exec = typeof options.exec === 'function' ? options.exec : spawnGit
  const now = typeof options.now === 'function' ? options.now : () => Date.now()
  const ttlMs = Number(options.ttlMs) > 0 ? Number(options.ttlMs) : GIT_CACHE_TTL_MS
  const prefixTtlMs = Number(options.prefixTtlMs) > 0 ? Number(options.prefixTtlMs) : GIT_PREFIX_TTL_MS

  /** root → {at, prefix}；`prefix: null` = 这个 root 不是 git 工作区（**也要缓存**，否则每次轮询都白跑一条 git）。 */
  const prefixCache = new Map()
  /** root → {at, result} */
  const resultCache = new Map()
  /** root → 进行中的 Promise（并发的两轮轮询共用同一次 git 调用）。 */
  const inflight = new Map()
  /** root → {at, result} —— 只给「变更」档的 status+numstat 用，不影响 `read()` 的语义。 */
  const detailCache = new Map()
  /** root → 进行中的 detail 读取。 */
  const detailInflight = new Map()

  const prefixOf = async (root) => {
    const hit = prefixCache.get(root)
    if (hit && now() - hit.at < prefixTtlMs) return hit.prefix
    const res = await exec(GIT_PREFIX_ARGS, { cwd: root, timeoutMs: GIT_TIMEOUT_MS, maxBytes: 64 * 1024 })
    const reason = reasonOf(res)
    // ⚠️ 失败也缓存：`not-a-repo` 的工作区不该每 8 秒重新问一次「你是不是仓库」
    const prefix = reason ? null : String(res.stdout || '').replace(/\r?\n$/, '').trim()
    prefixCache.set(root, { at: now(), prefix, reason: reason || null })
    return prefix
  }

  const read = async (root) => {
    const key = String(root || '')
    const cached = resultCache.get(key)
    if (cached && now() - cached.at < ttlMs) return cached.result
    if (inflight.has(key)) return inflight.get(key)
    const task = (async () => {
      const prefix = await prefixOf(key)
      const prefixHit = prefixCache.get(key)
      if (prefix === null) {
        return { available: false, reason: prefixHit && prefixHit.reason ? prefixHit.reason : 'not-a-repo', files: [], filesTotal: 0, truncated: false }
      }
      const res = await exec(GIT_STATUS_ARGS, { cwd: key, timeoutMs: GIT_TIMEOUT_MS, maxBytes: GIT_MAX_BYTES })
      const reason = reasonOf(res)
      if (reason) {
        return { available: false, reason, files: [], filesTotal: 0, truncated: false }
      }
      const all = parseStatusZ(res.stdout, { prefix })
      const truncated = all.length > MAX_CHANGED_FILES
      const files = truncated ? all.slice(0, MAX_CHANGED_FILES) : all
      return { available: true, reason: null, files, filesTotal: files.length, truncated }
    })().then((result) => {
      resultCache.set(key, { at: now(), result })
      inflight.delete(key)
      return result
    }).catch(() => {
      inflight.delete(key)
      // 兜底：这一层**绝不抛**（同 `semantic.js` 的纪律）
      return { available: false, reason: 'failed-fatal', files: [], filesTotal: 0, truncated: false }
    })
    inflight.set(key, task)
    return task
  }

  /**
   * v0.26.x「变更」档：状态 + 行数统计（只读、只跑 status + numstat，不读 diff 正文）。
   *
   * 与 `read()` 分开的原因：`/api/changes`（关联检索）只需要 status，不该因为
   * 「变更」档的上线每 8 秒多 spawn 一条 git。`readDetailed()` 只在那个档位被调用。
   *
   * @param {string} root - 工作区根
   * @returns {Promise<object>} 与 `read()` 同形；文件条目额外有 `added/deleted/binary/untracked`。
   *   读不到行数统计时 `statsAvailable=false`，状态列表**仍然可用**（不把整个功能拖垮）。
   */
  const readDetailed = async (root) => {
    const key = String(root || '')
    const cached = detailCache.get(key)
    if (cached && now() - cached.at < ttlMs) return cached.result
    if (detailInflight.has(key)) return detailInflight.get(key)
    const task = (async () => {
      const changeSet = await read(key)
      if (changeSet.available !== true) return { ...changeSet, statsAvailable: false }
      const prefixHit = prefixCache.get(key)
      const prefix = prefixHit ? prefixHit.prefix : ''
      if (prefix === null) return { ...changeSet, statsAvailable: false }
      const res = await exec(GIT_NUMSTAT_ARGS, { cwd: key, timeoutMs: GIT_TIMEOUT_MS, maxBytes: MAX_NUMSTAT_BYTES })
      const reason = reasonOf(res)
      if (reason) return { ...changeSet, statsAvailable: false }
      const stats = parseNumstatZ(res.stdout, { prefix })
      const files = changeSet.files.map((file) => {
        const stat = stats.get(file.rel)
        const untracked = Array.isArray(file.kinds) && file.kinds.includes('untracked')
        return {
          ...file,
          untracked,
          ...(stat ? { added: stat.added, deleted: stat.deleted, binary: stat.binary }
            : (untracked ? { added: null, deleted: null, binary: false } : { added: null, deleted: null, binary: false })),
        }
      })
      return { ...changeSet, files, statsAvailable: true }
    })().then((result) => {
      detailCache.set(key, { at: now(), result })
      detailInflight.delete(key)
      return result
    }).catch(() => {
      detailInflight.delete(key)
      return { available: false, reason: 'failed-fatal', files: [], filesTotal: 0, truncated: false, statsAvailable: false }
    })
    detailInflight.set(key, task)
    return task
  }

  /**
   * 一次只读的逐行 diff（只给「变更」档点开看；不缓存，点一次读一次）。
   * @param {string} root - 工作区根
   * @param {string} rel - 工作区相对路径（上层已 resolve 校验）
   * @returns {Promise<{available:boolean, reason:string|null, stdout:string, killed:string|null}>}
   */
  const readDiff = async (root, rel) => {
    const res = await exec([...GIT_DIFF_ARGS, String(rel || '')], {
      cwd: String(root || ''), timeoutMs: GIT_TIMEOUT_MS, maxBytes: MAX_DIFF_BYTES,
    })
    const reason = reasonOf(res)
    if (reason) return { available: false, reason, stdout: '', killed: res ? res.killed : null }
    return { available: true, reason: null, stdout: res.stdout, killed: res.killed }
  }

  return {
    read,
    readDetailed,
    readDiff,
    /** 仅供测试 / 显式刷新：清掉四种缓存。 */
    reset() {
      prefixCache.clear(); resultCache.clear(); inflight.clear()
      detailCache.clear(); detailInflight.clear()
    },
  }
}

/** 进程内共享一份读取器（同 `control.js` / `semantic.js` 的理由：多次加载只留一个句柄）。 */
const SHARED = Symbol.for('dsh-knit.git')
/**
 * @param {object} [backendLike] - 任意对象（这里只借它当挂点，不读它的字段）
 * @param {{exec?: Function}} [options]
 * @returns {object} Git 读取器
 */
export function sharedGitReader(backendLike, options = {}) {
  const holder = backendLike && typeof backendLike === 'object' ? backendLike : globalThis
  if (!holder[SHARED]) holder[SHARED] = createGitReader(options)
  return holder[SHARED]
}

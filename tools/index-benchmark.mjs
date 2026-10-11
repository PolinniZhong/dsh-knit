/**
 * Knit · v0.22 **增量索引基准**（可复现，不是断言）
 *
 * ── 为什么要有这个 ─────────────────────────────────────
 *
 * v0.22 是**内部性能与一致性能力**，它唯一的交付物就是「未变化的文件不再被重新读取 /
 * 解析」，以及「索引坏掉时能降级而不是悄悄给出错的结果」。这两句话都不能靠肉眼判断，
 * 只能靠**同一套可重复的语料 + 明确到次数的计数**来衡量（提示词 §6）。
 *
 * 所以这个工具测量的是三样东西：
 *   1. **墙钟**（ms）；
 *   2. **fs 真实调用次数**（`stat` / `readFile` / `readdir` / 读入字节）—— 由子进程在
 *      **插件被导入之前**给 `fs.promises` 打计数钩子拿到，不靠插件自报；
 *   3. **插件自己的索引计数**（`indexStatsFor()`：`readFiles` / `reused` / `verified` /
 *      `repaired` / `put` / `del`）—— 用来交叉验证第 2 项，并区分「复用」与「重读」。
 *
 * ⚠️ **钩子只对 `require('node:fs/promises')` 返回的那个对象做原地改写**，不改任何源码。
 * 「在 `Module._load` 里返回一个包装对象」是**没用的**（ESM 对 builtin 命名空间忽略
 * CJS 的返回值，实测计数恒为 0）—— 这个坑踩过，记在这里免得下次再踩。
 *
 * ── 场景 ───────────────────────────────────────────────
 *
 * 每个场景都在**全新的子进程**里跑（冷启动必须真的是第一次，不能在同一进程里热过），
 * 合成工作区里的 mtime 是固定值，所以结果可复现：
 *
 *   cold      建索引：空存储 + 首次扫描
 *   warm      重启后首扫：索引已在盘上，文件一个字没变（**v0.22 的主要收益点**）
 *   warm2     同一进程内再扫一次（对照：进程内 `cache` 早就兑现了这一段）
 *   touch     改一个文件（内容 + mtime）后扫描
 *   add       新增一个文件后扫描
 *   del       删除一个文件后扫描
 *   rename    重命名一个文件后扫描
 *   stale     把内容改掉但**保持字节长度与 mtime 不变**后扫描，抽验预算足以覆盖全部
 *             复用项 ⇒ 必须抓到并重建（这是「mtime/size 不是唯一证据」的证伪场景）
 *   corrupt   存储里某条记录被写坏 ⇒ 必须不抛错、退回读盘、重建
 *   openfail  KV 单元打不开 ⇒ `persisted:false` 且扫描照常可用
 *   nostorage 完全没有存储 ⇒ 行为与 v0.21 一致
 *   parity    同一语料、同一任务，索引开 / 关两次独立进程 ⇒ Context Pack 逐字节一致
 *
 * 用法：
 *   node knit/tools/index-benchmark.mjs                          # 默认 100,500,1000,5000,10000
 *   node knit/tools/index-benchmark.mjs --sizes 100,1000         # 指定规模
 *   node knit/tools/index-benchmark.mjs --sizes 1000 --pad 8000 # 每篇补 8KB（看「省下的量随文件大小增长」）
 *   node knit/tools/index-benchmark.mjs --sizes 1000 --scansort time  # 时间序（不吃正文）
 *   node knit/tools/index-benchmark.mjs --sizes 1000 --shape scan      # 生产形状（不预热）
 *   node knit/tools/index-benchmark.mjs --json                   # 机器可读
 *   node knit/tools/index-benchmark.mjs --dir-mtime              # APFS 目录 mtime 实验
 *   node knit/tools/index-benchmark.mjs --phases                 # 语料阶段 vs 检索阶段占比
 *   node knit/tools/index-benchmark.mjs --keep                   # 保留临时工作区
 *
 * 依赖：无（只用 Node 内置 + Knit 自己的源码）。**不进 `npm test`** —— 它是基准，不是断言。
 * 需要断言的七条验收在 `test/index-incremental.test.mjs` 里，那个才进 `npm test`。
 *
 * @module tools/index-benchmark
 */

import { createRequire } from 'node:module'
import { spawn } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'

// ⚠️ **不要在这里写 `import { readFile } from 'node:fs/promises'`**。
//
// ESM 对 builtin 的命名空间是**在第一次被导入时定型**的：一旦在装计数钩子之前
// 建立了这个命名空间，之后再去原地改写 `fs.promises` 上的方法，插件里的
// `import { readFile } from 'node:fs/promises'` 也**看不到**改动 —— 计数会恒为 0，
// 而且不报错（实测过，别再走一遍）。
//
// 所以本工具自己走 CJS：`createRequire` 取一次，解构成普通引用。副作用正好是想要的
// —— 工具自己的 fs 调用**不计入**，计数里只有插件的。
const nodeRequire = createRequire(import.meta.url)
const {
  mkdir, readFile, writeFile, readdir, rm, stat, utimes, rename, unlink, mkdtemp,
} = nodeRequire('node:fs/promises')

const HERE = dirname(fileURLToPath(import.meta.url))
const INDEX_JS = join(HERE, '..', 'src', 'host', 'index.js')
const INDEX_STORE_JS = join(HERE, '..', 'src', 'host', 'index-store.js')

/* ── 合成语料（确定性）───────────────────────────────── */

/** 每个主题：一个真词 + 一段只有这一篇才讲的正文。与 `scale-benchmark.mjs` 同风格。 */
const TOPICS = [
  ['排序算法', '相关性打分用 BM25，引入 IDF 抑制高频词，加上长度归一化与 k1 饱和'],
  ['键盘导航', '方向键移动即预览，回车切换展开，Esc 收起，焦点环用中性描边'],
  ['图片视频', '方形缩略图网格最少三列，视频取首帧当海报，走 HTTP Range 流式播放'],
  ['主题令牌', '强调色只允许一个来源，表面分层用 module platform，灰底要降一档'],
  ['接口契约', '列表接口返回 mode topic keywords total，错误只回错误码不回文案'],
  ['路径越界', '读文件接口必须落在工作区内，扩展名白名单，响应带 nosniff 与 sandbox'],
  ['发布流程', '先跑测试确认全绿，再核对版本号与打包内容，最后提交市场收录'],
  ['竞品调研', '全库插件总数与下载量分布，文档类目头部全是生成工具，记忆类目又深又热'],
  ['悬停浮层', '只读浮层列最近五篇，延迟显示与收起，点击才进右边栏不推挤布局'],
  ['权限模型', '按工具层控制权限，审批策略 ask，写操作受白名单约束'],
  ['会话事件', '事件流按 seq 追加，快照读取最近若干条，只认真人输入的用户消息'],
  ['本地优先', '不调模型不联网，全部是确定性字符串运算，文档不出本机'],
]

const NOISE = [
  '这里记录一些零散的想法与待办事项，与当前话题没有直接关系',
  '这段是为了把文档撑长而写的填充内容，反复出现项目名与常见词',
  '讨论过几次但没有结论，先记在这里以后再看',
]

/** 固定 mtime 的基准时刻（秒）。**不随运行时间变化** ⇒ 结果可复现。 */
const BASE_SECONDS = Math.floor(Date.UTC(2026, 0, 1) / 1000)

/**
 * `--pad <bytes>` 给每篇正文尾部补的填充字节数。
 *
 * 为什么需要这个旋钮：默认合成语料每篇只有约 260 B，**解析与读取的成本小到看不出来**，
 * 于是「索引省掉的那部分」在墙钟上只剩 1.1–1.2× —— 真实的 Markdown / 源码是几 KB 到几十 KB，
 * 省掉的是**正比于文件大小**的那一段（整读 + 解码 + 小写化 + 重解析）。这个旋钮就是用来
 * 把「省下来的量随时间增长」从一句论证变成一次测量，而不是拿来把数字调好看。
 */
let PAD_BYTES = 0

/**
 * `--scansort time|relevance`（默认 `relevance`）—— worker 里那一次 `scan()` 用哪种序。
 *
 * 两种序的取数路径**不一样**，所以必须分开测：
 *   · `relevance` 需要**整篇正文**（BM25 的 `df` / `avgdl` 是正文的函数）⇒ 走 `hydrateBodies()`；
 *   · `time` 不需要正文 ⇒ 完全吃索引里的 title / summary / 有界首部。
 * 默认面板用的就是 `relevance`（`src/client/client.js:1721`），所以这一项不能只测一种。
 */
let SCAN_SORT = 'relevance'

/**
 * `--shape collect|scan`（默认 `collect`）—— worker 的**测量形状**。
 *
 *   · `collect`（默认，历史形状）：先单独跑一次 `collectDocs()` 并计时，再跑一次
 *     `scan()`。好处是能把「语料阶段」与「整条检索」拆开看；代价是那次 `scan()` 会
 *     吃到前面 `collectDocs()` 留下的**进程内缓存**，于是它**低估**真实生产耗时。
 *   · `scan`（生产形状）：一次检索就是一个新进程里的第一次取数 —— 不预热、不单独
 *     跑 `collectDocs`，`scan(ms)` 那一列就是用户真正等的那个数。
 *
 * 修法 ②（`scan()` 在相关序下不查索引）之后，两种形状的差别是**结论性**的：
 * 相关序在生产形状下与 v0.21 同口径，而历史形状会把索引装载记在 collect 那一列。
 */
let SHAPE = 'collect'

/**
 * 第 i 篇的正文。末尾的 `<!--rev:A-->` 是给 `stale` 场景留的**等长改写位**。
 * @param {number} i - 文件序号
 * @param {boolean} isCode - 是否代码文件
 * @returns {string} 文件内容
 */
function contentOf(i, isCode, rev = 'A') {
  const [title, body] = TOPICS[i % TOPICS.length]
  const pad = PAD_BYTES > 0 ? `${'填充段落，用来让文件接近真实大小。'.repeat(Math.ceil(PAD_BYTES / 18)).slice(0, PAD_BYTES)}\n\n` : ''
  if (isCode) {
    return `// ${title} ${i}\n// ${body}\n\nexport function mod${i}(input) {\n  const ${'value'} = input\n  return ${i} + value\n}\n\n/* ${NOISE[i % NOISE.length]} */\n${pad}// <!--rev:${rev}-->\n`
  }
  return `# ${title} ${i}\n\n${body}\n\n## 细节\n\n第 ${i} 篇。${NOISE[i % NOISE.length]}\n\n${pad}- 要点一\n- 要点二\n\n<!--rev:${rev}-->\n`
}

/** 第 i 篇的相对路径：每 50 篇一个桶目录（与 `MAX_DIRS` 的关系因此可观察）。 */
function relOf(i) {
  const bucket = `mod${String(Math.floor(i / 50)).padStart(3, '0')}`
  const ext = i % 5 === 3 ? '.js' : '.md'
  return `${bucket}/f${String(i).padStart(5, '0')}${ext}`
}

/**
 * 造一个合成工作区（幂等：已存在且数量对得上就直接返回）。
 * @param {string} root - 工作区根
 * @param {number} n - 文件数
 * @returns {Promise<number>} 实际写入的文件数
 */
async function generate(root, n) {
  await mkdir(root, { recursive: true })
  let written = 0
  for (let i = 0; i < n; i += 1) {
    const rel = relOf(i)
    const abs = join(root, rel)
    await mkdir(dirname(abs), { recursive: true })
    await writeFile(abs, contentOf(i, rel.endsWith('.js')))
    const t = BASE_SECONDS + i
    await utimes(abs, t, t)
    written += 1
  }
  return written
}

/* ── 假后端：忠实镜像 `dsh-storage-json` 的 `per-record` 磁盘布局 ──────
 *
 * 为什么不用真的 `@deepseek-ai/dsh-storage-json`：它**从 knit 里不可解析**
 * （`ERR_MODULE_NOT_FOUND`，它是 DSH 宿主的依赖）。所以这里按它的真实布局写一份
 * 最小镜像：`<root>/<unit>/<table>/<key>.json`，写盘走 `tmp + rename` 原子替换，
 * 同名 unit 未关闭再 open 会 reject —— 都是那个后端真实的行为。
 */

/**
 * @param {string} root - 存储根目录
 * @param {{failOpen?: boolean}} [options] - `failOpen` 让 `open()` 抛错（模拟介质不可用）
 * @returns {{kv: object, opened: Set<string>}} 后端
 */
function makeDiskBackend(root, options = {}) {
  const opened = new Set()
  const unitDir = (name, table) => join(root, name, table)
  return {
    opened,
    kv: {
      async open(descriptor) {
        if (options.failOpen) throw new Error('medium-unavailable')
        if (opened.has(descriptor.name)) {
          throw new Error(`unit '${descriptor.name}' is already open; a unit has exactly one live handle`)
        }
        opened.add(descriptor.name)
        const dirs = {}
        for (const table of descriptor.tables) dirs[table] = unitDir(descriptor.name, table)
        return {
          async loadAll() {
            const tables = {}
            for (const table of descriptor.tables) {
              const rows = {}
              let names = []
              try {
                names = await readdir(dirs[table])
              } catch {
                names = []
              }
              for (const file of names) {
                if (!file.endsWith('.json')) continue
                const key = file.slice(0, -'.json'.length)
                try {
                  rows[key] = JSON.parse(await readFile(join(dirs[table], file), 'utf8'))
                } catch {
                  // 坏记录当不存在 —— 与真实后端「无法解析就报 malformed-medium」的
                  // **降级效果**一致：这一条重建，其余记录照常可用。
                }
              }
              tables[table] = rows
            }
            return { unit: { name: descriptor.name, version: descriptor.version }, global: null, tables }
          },
          async putRecord(table, key, value) {
            await mkdir(dirs[table], { recursive: true })
            const tmp = join(dirs[table], `${randomUUID()}.tmp`)
            await writeFile(tmp, JSON.stringify(value))
            await rename(tmp, join(dirs[table], `${key}.json`))
          },
          async deleteRecord(table, key) {
            try {
              await unlink(join(dirs[table], `${key}.json`))
            } catch {
              // 幂等：删不存在的键是 no-op。
            }
          },
          async setGlobal() {},
          async close() {
            opened.delete(descriptor.name)
          },
        }
      },
    },
  }
}

/* ── fs 计数钩子（必须在插件被 import 之前装好）────────── */

/**
 * 给 `fs.promises` 的 `stat/readFile/readdir` 与 `fs` 的 `readFileSync` 装计数。
 * **原地改写 `require('node:fs/promises')` 返回的那个对象**，并返回计数容器。
 * @returns {{stat:number, readFile:number, readdir:number, readFileSync:number, bytes:number}}
 */
function installFsCounters() {
  const realFs = nodeRequire('node:fs')
  const realFsp = nodeRequire('node:fs/promises')
  const counts = { stat: 0, readFile: 0, readdir: 0, readFileSync: 0, bytes: 0 }
  const wrapAsync = (obj, name, key) => {
    const orig = obj[name]
    if (typeof orig !== 'function') return
    obj[name] = function patched(...args) {
      counts[key] += 1
      const out = orig.apply(this, args)
      if (key === 'readFile' && out && typeof out.then === 'function') {
        return out.then((result) => {
          if (typeof result === 'string') counts.bytes += Buffer.byteLength(result)
          else if (result && typeof result.length === 'number') counts.bytes += result.length
          return result
        })
      }
      return out
    }
  }
  wrapAsync(realFsp, 'stat', 'stat')
  wrapAsync(realFsp, 'readFile', 'readFile')
  wrapAsync(realFsp, 'readdir', 'readdir')
  wrapAsync(realFs, 'readFileSync', 'readFileSync')
  return counts
}

/* ── 子进程：worker ───────────────────────────────────── */

/**
 * worker：在**全新进程**里跑一个场景，输出一行 `@@RESULT@@ {json}`。
 * @param {Record<string,string>} flags - 命令行开关
 * @returns {Promise<void>} 无
 */
async function worker(flags) {
  const counts = installFsCounters()
  const plugin = await import(pathToFileURL(INDEX_JS).href)
  const storeMod = await import(pathToFileURL(INDEX_STORE_JS).href)
  const { setIndexRegistry, resetIndexMemory, indexStatsFor, setIndexVerifyBudget, indexStorageStatus } = plugin

  const root = flags.root
  const storeRoot = flags.store
  const scenario = flags.scenario
  const query = flags.query || '排序算法 相关性打分 IDF'
  const budget = flags.budget == null ? null : Number(flags.budget)

  resetIndexMemory()
  if (budget != null) setIndexVerifyBudget(budget)

  const out = {
    scenario,
    ok: false,
    ms: {},
    fs: {},
    fsCollect: {},
    index: null,
    indexCollect: null,
    storage: null,
    collected: null,
    storeRows: 0,
    packHash: '',
    error: '',
  }

  if (scenario !== 'nostorage' && SHAPE === 'collect') {
    const backend = makeDiskBackend(storeRoot, { failOpen: scenario === 'openfail' })
    // 先读一次盘，把「盘上到底有没有可用记录」也报出来 —— 否则「没复用」和
    // 「存储没接上」在看板上长得一模一样（都是 reused=0），那是没法排查的。
    // 同一实例的 `openUnit()` 是记忆化的，所以这次探测不会占掉后面那次 open。
    const store = storeMod.createIndexStore({ backend })
    try {
      out.storeRows = (await store.read(root)).size
    } catch {
      out.storeRows = -1
    }
    setIndexRegistry(store)
  } else if (SHAPE === 'collect') {
    setIndexRegistry(null)
  }
  if (SHAPE !== 'collect') {
    // 生产形状：存储照常挂上（`apply()` 就是这么做的），但**不去读它** ——
    // 一轮相关检索本来就不该碰索引（修法 ②），把它读进来会把账记错。
    const backend = makeDiskBackend(storeRoot, { failOpen: scenario === 'openfail' })
    const store = storeMod.createIndexStore({ backend })
    setIndexRegistry(scenario === 'nostorage' ? null : store)
    out.storeRows = -2
  }

  const now = () => Number(process.hrtime.bigint() / 1000n) / 1000
  const fsBefore = { ...counts }

  try {
    const t0 = now()
    const collected = SHAPE === 'scan' ? null : await plugin.collectDocs(root)
    const t1 = now()
    if (SHAPE !== 'scan') out.ms.collect = Math.round((t1 - t0) * 100) / 100
    // **语料阶段的读数**：这才是 v0.22 要优化的那一段。`scan()` 内部会再扫一次，
    // 那一次的复用主要来自进程内 `cache`（`cached`），与索引复用是两件事。
    out.indexCollect = indexStatsFor(root) || null
    // **语料阶段自己的 fs 计数**：整个 worker 的累计值里混着 `scan()` 的正文补水
    // （那是裁决 A 记下的代价，不是索引的收益），不拆开就看不出「索引省掉的是哪一段」。
    for (const key of Object.keys(counts)) {
      out.fsCollect[key] = counts[key] - (fsBefore[key] || 0)
    }
    // 生产形状下不单独跑 `collectDocs` ⇒ 这里没有可报的语料读数（表格里显示 `-`）。
    out.collected = collected ? {
      docs: collected.docs.length,
      code: collected.code.length,
      media: collected.media.length,
    } : null

    const a0 = now()
    const payload = SCAN_SORT === 'time'
      ? await plugin.scan(root, 20, { sort: 'time', kind: 'context' })
      : await plugin.scan(root, 20, { sort: 'relevance', query, kind: 'context' })
    const a1 = now()
    out.ms.scan = Math.round((a1 - a0) * 100) / 100
    // 生产形状下「语料阶段」就是这一次检索自己的取数 —— 索引列因此描述它，不是描述预热。
    // `c.*` 计数同理要在检索之后重算：它是拿 `fsBefore` 减出来的，而 `--shape scan`
    // 根本没有「单独的 collectDocs」那一段。
    if (SHAPE === 'scan') {
      out.indexCollect = indexStatsFor(root) || null
      for (const key of Object.keys(counts)) {
        out.fsCollect[key] = counts[key] - (fsBefore[key] || 0)
      }
    }

    const pack = await plugin.buildContextFor(payload.hostRoot, {
      ranked: payload.ranked,
      total: payload.total,
      task: payload.task,
      topic: payload.topic,
    })
    out.packHash = hashOf(JSON.stringify({
      pinned: pack.pinned || [],
      primary: pack.primary || [],
      supporting: pack.supporting || [],
      related: pack.related || [],
    }))

    // 第二个场景在同一进程里再跑一次（`warm2`）—— 对照「进程内 cache 早就兑现的部分」。
    if (flags.two === '1') {
      const b0 = now()
      await plugin.collectDocs(root)
      const b1 = now()
      out.ms.collect2 = Math.round((b1 - b0) * 100) / 100
    }

    out.index = indexStatsFor(root) || null
    out.storage = indexStorageStatus()
    out.ok = true
  } catch (error) {
    out.error = String((error && error.stack) || error)
  }

  for (const key of Object.keys(counts)) {
    out.fs[key] = counts[key] - (fsBefore[key] || 0)
  }
  process.stdout.write(`@@RESULT@@ ${JSON.stringify(out)}\n`)
}

/**
 * 稳定的短哈希（parity 对比用；不是密码学用途）。
 * @param {string} text - 输入
 * @returns {string} 16 个 hex 字符
 */
function hashOf(text) {
  // 只用来比「两次是否逐字节相同」，不需要密码学强度，但也不值得另写一份 ——
  // 直接用内置 sha256，省得引入「基准与插件算法不同」的怀疑。
  const { createHash } = nodeRequire('node:crypto')
  return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16)
}

/**
 * 跑一个场景（起一个子进程）。
 * @param {object} spec - `{root, store, scenario, budget, two, shape}`
 * @returns {Promise<object>} worker 的结果
 */
function runWorker(spec) {
  const args = [fileURLToPath(import.meta.url), '--worker',
    '--root', spec.root, '--store', spec.store, '--scenario', spec.scenario]
  if (spec.budget != null) args.push('--budget', String(spec.budget))
  if (spec.two) args.push('--two', '1')
  if (PAD_BYTES > 0) args.push('--pad', String(PAD_BYTES))
  if (SCAN_SORT !== 'relevance') args.push('--scansort', SCAN_SORT)
  // 每个场景可以覆盖形状：`--shape scan` 需要一个**独立进程**先把索引建好。
  const shape = spec.shape || SHAPE
  if (shape !== 'collect') args.push('--shape', shape)
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('close', (code) => {
      const line = stdout.split('\n').find((l) => l.startsWith('@@RESULT@@ '))
      if (!line) {
        resolve({ scenario: spec.scenario, ok: false, error: `child exit ${code}: ${stderr.trim() || stdout.trim()}` })
        return
      }
      resolve(JSON.parse(line.slice('@@RESULT@@ '.length)))
    })
  })
}

/* ── 场景编排 ─────────────────────────────────────────── */

/** 由场景造出来的、基线里没有的文件（恢复基线时要删掉）。 */
const STRAY_FILES = ['mod000/zzz-new.md', 'mod000/renamed-00002.md']

/** 会改动工作区的场景 —— 之后必须先恢复基线。 */
const MUTATING = new Set(['touch', 'add', 'del', 'rename', 'stale', 'corrupt'])

/**
 * 把工作区恢复成基线：重写全部文件（mtime 也是固定的）、删掉场景造出来的多余文件。
 * @param {string} root - 工作区根
 * @param {number} n - 文件数
 * @returns {Promise<void>} 无
 */
async function restoreBaseline(root, n) {
  for (const rel of STRAY_FILES) {
    try {
      await unlink(join(root, rel))
    } catch {
      // 不存在就是干净的。
    }
  }
  await generate(root, n)
}

/** 场景 → 准备动作（在父进程里改磁盘，然后 worker 去看）。 */
const PREPARE = {
  cold: async () => {},
  warm: async () => {},
  warm2: async () => {},
  touch: async (root) => {
    const abs = join(root, relOf(0))
    await writeFile(abs, `${contentOf(0, false)}\n多出来的一行改动\n`)
  },
  add: async (root) => {
    const abs = join(root, STRAY_FILES[0])
    await writeFile(abs, contentOf(7, false))
    const t = BASE_SECONDS + 99999
    await utimes(abs, t, t)
  },
  del: async (root) => {
    await unlink(join(root, relOf(1)))
  },
  rename: async (root) => {
    await rename(join(root, relOf(2)), join(root, STRAY_FILES[1]))
  },
  stale: async (root) => {
    // 内容变了，但**字节长度与 mtime 都不变** —— 元信息骗得过，指纹骗不过。
    const abs = join(root, relOf(0))
    const before = await stat(abs)
    await writeFile(abs, contentOf(0, false, 'B'))
    const after = await stat(abs)
    await utimes(abs, before.atimeMs / 1000, before.mtimeMs / 1000)
    const restored = await stat(abs)
    if (after.size !== before.size || Math.abs(restored.mtimeMs - before.mtimeMs) > 1) {
      throw new Error('stale 场景准备失败：无法造出「同长度同 mtime」的改写')
    }
  },
  corrupt: async (root, store) => {
    const { relToKey } = await import(pathToFileURL(INDEX_STORE_JS).href)
    const file = join(store, 'knit_index', 'files', `${relToKey(relOf(0))}.json`)
    await writeFile(file, '{"root": "knit_index", "rel": ') // 故意写坏
  },
  openfail: async () => {},
  nostorage: async () => {},
  parity: async () => {},
}

/**
 * 一个规模上的全套场景。
 * @param {string} base - 临时根
 * @param {number} n - 文件数
 * @param {boolean} keep - 是否保留
 * @returns {Promise<Array<object>>} 每个场景的结果
 */
async function runSize(base, n, keep) {
  const root = join(base, `ws${n}`)
  const store = join(base, `store${n}`)
  await generate(root, n)
  const results = []
  let dirty = false
  let built = false

  for (const scenario of ['cold', 'warm', 'warm2', 'touch', 'add', 'del', 'rename']) {
    if (scenario === 'cold') {
      // 冷启动：空存储 + 全新进程。必须先清盘，否则「建索引」这一行会变成「读索引」。
      await rm(store, { recursive: true, force: true })
    } else if (dirty) {
      // 工作区被上一个场景改过 ⇒ 先恢复基线（固定 mtime，所以索引仍然对得上）。
      await restoreBaseline(root, n)
      dirty = false
    }
    if (SHAPE === 'scan' && scenario !== 'cold' && !built) {
      // 生产形状：索引是**上一次会话**留下的。用一个独立进程先把它建好（不计时、不进读数），
      // 否则 `warm` 场景里根本没有暖索引可复用；而且必须用独立进程建 —— 建索引会在测量
      // 进程里留下进程内缓存，那样 `warm` 与 `nostorage` 就不可比了。
      // 放在 `PREPARE` **之前**：`stale` 依赖「索引里存的是改写前的内容」。
      await runWorker({ root, store, scenario: 'cold', budget: null, two: false, shape: 'collect' })
      built = true
    }
    await PREPARE[scenario](root, store)
    if (MUTATING.has(scenario)) dirty = true
    const out = await runWorker({
      root, store, scenario, two: scenario === 'warm2', budget: null,
    })
    out.size = n
    results.push(out)
  }

  // 只在 1000 规模上跑检查类场景（够说明问题，又不让基准变慢）。
  if (n === 1000) {
    for (const scenario of ['stale', 'corrupt', 'openfail', 'nostorage']) {
      if (dirty) {
        await restoreBaseline(root, n)
        dirty = false
      }
      if (scenario === 'openfail' || scenario === 'nostorage') {
        // 这两种根本不依赖盘上已有索引：一个打不开、一个没有存储。
        await rm(store, { recursive: true, force: true })
      }
      await PREPARE[scenario](root, store)
      if (MUTATING.has(scenario)) dirty = true
      const budget = scenario === 'stale' ? 100000 : null
      const out = await runWorker({ root, store, scenario, budget, two: false })
      out.size = n
      results.push(out)
    }

    // parity：同一语料、同一任务，索引开 / 关在**两个独立进程**里各跑一次，
    // 比 Context Pack 的成员与顺序是否逐字节一致（提示词 §6 最后一条）。
    await restoreBaseline(root, n)
    await rm(store, { recursive: true, force: true })
    await runWorker({ root, store, scenario: 'cold', budget: null })
    const on = await runWorker({ root, store, scenario: 'warm', budget: 0 })
    const off = await runWorker({ root, store, scenario: 'nostorage', budget: null })
    on.size = n
    on.scenario = 'parity-on'
    off.size = n
    off.scenario = 'parity-off'
    results.push(on, off)
    dirty = true
  }

  if (!keep) {
    await rm(root, { recursive: true, force: true })
    await rm(store, { recursive: true, force: true })
  }
  return results
}

/* ── 两个专题实验 ─────────────────────────────────────── */

/**
 * `--dir-mtime`：APFS 目录 mtime 是否向上传播。
 *
 * 这个实验决定了一件关键设计：能不能「一个 stat 判全树是否变化」。结论是**不能**
 * —— 目录 mtime 只在**直接父目录**上更新，不向上传播，所以对账必须**按目录逐级**做。
 * @param {string} base - 临时根
 * @returns {Promise<object>} 实验读数
 */
async function dirMtimeExperiment(base) {
  const root = join(base, 'dirmtime')
  await rm(root, { recursive: true, force: true })
  await mkdir(join(root, 'sub', 'deep'), { recursive: true })
  await writeFile(join(root, 'sub', 'deep', 'a.md'), 'a')
  await writeFile(join(root, 'sub', 'b.md'), 'b')
  const snap = async () => ({
    root: (await stat(root)).mtimeMs,
    sub: (await stat(join(root, 'sub'))).mtimeMs,
    deep: (await stat(join(root, 'sub', 'deep'))).mtimeMs,
  })
  const before = await snap()
  await writeFile(join(root, 'sub', 'deep', 'a.md'), 'a changed but mtime of file only')
  const afterEdit = await snap()
  await writeFile(join(root, 'sub', 'deep', 'new.md'), 'new')
  const afterAdd = await snap()
  await unlink(join(root, 'sub', 'deep', 'new.md'))
  const afterDel = await snap()
  return {
    editExistingFile: {
      changed: {
        root: afterEdit.root !== before.root,
        sub: afterEdit.sub !== before.sub,
        deep: afterEdit.deep !== before.deep,
      },
      verdict: '写已存在文件只改文件自身 mtime，目录 mtime 不变',
    },
    addFile: {
      changed: {
        root: afterAdd.root !== afterEdit.root,
        sub: afterAdd.sub !== afterEdit.sub,
        deep: afterAdd.deep !== afterEdit.deep,
      },
      verdict: '新增/删除只更新**直接父目录** mtime，不向上传播',
    },
    deleteFile: {
      changed: {
        root: afterDel.root !== afterAdd.root,
        sub: afterDel.sub !== afterAdd.sub,
        deep: afterDel.deep !== afterAdd.deep,
      },
    },
  }
}

/**
 * `--phases`：语料阶段（`collectDocs`）与整条相关检索（`scan`）的耗时占比。
 * 用来说明「v0.22 优化的是哪一段、那一段占多少」。
 * @param {string} base - 临时根
 * @param {number[]} sizes - 规模列表
 * @returns {Promise<Array<object>>} 每个规模的读数
 */
async function phasesExperiment(base, sizes) {
  const plugin = await import(pathToFileURL(INDEX_JS).href)
  const rows = []
  for (const n of sizes) {
    const root = join(base, `ws${n}`)
    await generate(root, n)
    plugin.resetIndexMemory()
    plugin.setIndexRegistry(null)
    const now = () => Number(process.hrtime.bigint() / 1000n) / 1000
    const t0 = now()
    await plugin.collectDocs(root)
    const t1 = now()
    await plugin.scan(root, 20, { sort: 'relevance', query: '排序算法 相关性打分 IDF', kind: 'context' })
    const t2 = now()
    // 再跑一轮（热）—— 分成「热语料」与「热检索」两段。
    const t3 = now()
    await plugin.collectDocs(root)
    const t4 = now()
    await plugin.scan(root, 20, { sort: 'relevance', query: '排序算法 相关性打分 IDF', kind: 'context' })
    const t5 = now()
    rows.push({
      size: n,
      coldCollectMs: round(t1 - t0),
      coldScanExtraMs: round(t2 - t1),
      warmCollectMs: round(t4 - t3),
      warmScanExtraMs: round(t5 - t4),
    })
  }
  return rows
}

/** 保留两位小数。 */
function round(ms) {
  return Math.round(ms * 100) / 100
}

/* ── 输出 ─────────────────────────────────────────────── */

/**
 * 一行结果 → 表格行的数据。
 *
 * ⚠️ `readFiles` / `reused` / `cached` 取的是**语料阶段**（`collectDocs`）那一次的读数，
 * 不是 `scan()` 里第二次扫描的 —— 后者主要命中进程内 `cache`，混进来会把 v0.20 就有的
 * 能力算成这一版的收益。
 */
function summarize(row) {
  const fs = row.fs || {}
  const fsCollect = row.fsCollect && Object.keys(row.fsCollect).length ? row.fsCollect : fs
  const idx = row.indexCollect || {}
  return {
    size: row.size,
    scenario: row.scenario,
    collectMs: row.ms && row.ms.collect != null ? row.ms.collect : null,
    collect2Ms: row.ms && row.ms.collect2 != null ? row.ms.collect2 : null,
    scanMs: row.ms && row.ms.scan != null ? row.ms.scan : null,
    // 语料阶段（`collectDocs`）：这才是 v0.22 要优化的那一段
    stat: fsCollect.stat || 0,
    readFile: fsCollect.readFile || 0,
    readdir: fsCollect.readdir || 0,
    kib: Math.round(((fsCollect.bytes || 0) / 1024) * 10) / 10,
    // 整个 worker 的 readFile：含 `scan()` 里的正文补水（裁决 A 的已知代价）
    wholeRead: fs.readFile || 0,
    wholeKib: Math.round(((fs.bytes || 0) / 1024) * 10) / 10,
    storeRows: row.storeRows,
    readFiles: idx.readFiles == null ? null : idx.readFiles,
    cached: idx.cached == null ? null : idx.cached,
    reused: idx.reused == null ? null : idx.reused,
    verified: idx.verified == null ? null : idx.verified,
    repaired: idx.repaired == null ? null : idx.repaired,
    put: idx.put == null ? null : idx.put,
    del: idx.del == null ? null : idx.del,
    docs: row.collected ? row.collected.docs : null,
    code: row.collected ? row.collected.code : null,
    packHash: row.packHash || '',
    ok: row.ok,
    error: row.error || '',
  }
}

/** 打印主表。 */
function printTable(rows) {
  const head = [
    'size', 'scenario', 'collect(ms)', 'collect2(ms)', 'scan(ms)',
    'c.stat', 'c.read', 'c.readdir', 'c.KiB', 'w.read', 'w.KiB', 'store', 'readFiles', 'cached', 'reused', 'verified', 'repaired', 'put', 'del', 'docs/code',
  ]
  const body = rows.map(summarize).map((r) => [
    String(r.size), r.scenario,
    fmt(r.collectMs), fmt(r.collect2Ms), fmt(r.scanMs),
    String(r.stat), String(r.readFile), String(r.readdir), String(r.kib),
    String(r.wholeRead), String(r.wholeKib),
    fmt(r.storeRows),
    fmt(r.readFiles), fmt(r.cached), fmt(r.reused), fmt(r.verified), fmt(r.repaired), fmt(r.put), fmt(r.del),
    r.docs == null ? '-' : `${r.docs}/${r.code}`,
  ])
  const widths = head.map((h, i) => Math.max(h.length, ...body.map((row) => row[i].length)))
  const line = (cells) => cells.map((cell, i) => cell.padEnd(widths[i])).join('  ')
  console.log(line(head))
  console.log(widths.map((w) => '─'.repeat(w)).join('  '))
  for (const row of body) console.log(line(row))
}

/** 空值 → `-`。 */
function fmt(value) {
  return value == null ? '-' : String(value)
}

/* ── 入口 ─────────────────────────────────────────────── */

/**
 * 解析 `--flag value` 与 `--bool`。
 * @param {string[]} argv - `process.argv.slice(2)`
 * @returns {Record<string,string>} 开关表（布尔开关值为 `'1'`）
 */
function parseArgs(argv) {
  const flags = {}
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i]
    if (!item.startsWith('--')) continue
    const name = item.slice(2)
    const next = argv[i + 1]
    if (next && !next.startsWith('--')) {
      flags[name] = next
      i += 1
    } else {
      flags[name] = '1'
    }
  }
  return flags
}

async function main() {
  const flags = parseArgs(process.argv.slice(2))
  if (flags.worker) {
    if (flags.pad) PAD_BYTES = Math.max(0, Number(flags.pad) || 0)
    if (flags.scansort === 'time') SCAN_SORT = 'time'
    if (flags.shape === 'scan') SHAPE = 'scan'
    await worker(flags)
    return
  }
  if (flags.pad) PAD_BYTES = Math.max(0, Number(flags.pad) || 0)
  if (flags.scansort === 'time') SCAN_SORT = 'time'
  if (flags.shape === 'scan') SHAPE = 'scan'

  const sizes = String(flags.sizes || '100,500,1000,5000,10000')
    .split(',').map((s) => Number(s.trim())).filter((n) => Number.isFinite(n) && n > 0)
  const keep = !!flags.keep
  const base = keep
    ? await mkdtemp(join(tmpdir(), 'knit-index-bench-keep-'))
    : await mkdtemp(join(tmpdir(), 'knit-index-bench-'))

  const results = []
  try {
    if (flags['dir-mtime']) {
      const out = await dirMtimeExperiment(base)
      console.log('\n── APFS 目录 mtime 实验 ─────────────────────────────')
      console.log(JSON.stringify(out, null, 2))
      return
    }
    if (flags.phases) {
      const rows = await phasesExperiment(base, sizes)
      console.log('\n── 阶段占比（语料 vs 检索）──────────────────────────')
      for (const row of rows) {
        console.log(`N=${String(row.size).padEnd(6)} 冷: collect ${row.coldCollectMs}ms + 检索额外 ${row.coldScanExtraMs}ms`
          + `   热: collect ${row.warmCollectMs}ms + 检索额外 ${row.warmScanExtraMs}ms`)
      }
      return
    }

    for (const n of sizes) {
      const rows = await runSize(base, n, keep)
      results.push(...rows)
    }

    if (flags.json) {
      console.log(JSON.stringify({ sizes, results: results.map(summarize), raw: results }, null, 2))
      return
    }

    console.log('\n── v0.22 增量索引基准（合成语料，mtime 固定）─────────────')
    console.log('c.* = **语料阶段**（`collectDocs`）的 fs 计数与读入量 —— v0.22 要优化的就是这一段')
    console.log('w.* = 整个场景进程的 `readFile` 次数与读入量（含 `scan()` 按需补正文，裁决 A 已记下的代价）')
    console.log('readFiles/cached/reused/verified/repaired/put/del = 插件自报的语料阶段读数\n')
    printTable(results)

    const parity = results.filter((r) => r.scenario === 'parity-on' || r.scenario === 'parity-off')
    if (parity.length === 2) {
      const [on, off] = parity
      console.log(`\nContext Pack parity: on=${on.packHash} off=${off.packHash} → ${on.packHash === off.packHash ? '一致 ✓' : '不一致 ✗'}`)
    }
    const failures = results.filter((r) => !r.ok)
    if (failures.length > 0) {
      console.log(`\n⚠️ ${failures.length} 个场景失败：`)
      for (const row of failures) console.log(`  · ${row.size}/${row.scenario}: ${row.error}`)
    }
  } finally {
    if (!keep) await rm(base, { recursive: true, force: true })
    else console.log(`\n（保留：${base}）`)
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  await main()
}

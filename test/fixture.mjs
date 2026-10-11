/**
 * 测试用样本工作区：把「至少 3 篇 Markdown + 一张图 + 一个非媒体文件」
 * 造成一个临时目录，测试因此不再依赖仓库/包的目录布局。
 *
 * 为什么需要它：测试原先用 `new URL('../../')` 当样本工作区 ——
 * 作者本机那是 08_Knit/（恰好有样本），但别人 clone 公开仓库时那是 clone 的父目录，
 * 装进 npm 包时那是 node_modules/，两处都没有样本，测试就会误报红。
 */
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** 1×1 透明 PNG 的真实字节，尾部补 0 到 2048 —— 够测 Range 后缀，且仍是可解码的 PNG。 */
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64',
)
const PADDED_PNG = Buffer.concat([PNG_1X1, Buffer.alloc(2048 - PNG_1X1.length)])

/** 假视频：宿主不解析容器，只按扩展名放行并支持 Range。 */
const FAKE_MP4 = Buffer.alloc(4096, 0x21)

/**
 * 建样本工作区。文件名刻意与旧断言一致（README.md / package.json / docs/screenshot.png），
 * 断言语义不用改；mtime 用 utimes 定死，排序断言不再看运气。
 *
 * @param {Array<[string, string|Buffer]>} [extra] - 追加的 `[rel, 内容]`。
 *   v0.12 的引用关系用例需要能自己造带链接的文件 —— **样本一律从这里要**，
 *   不许去借仓库里的真实文件（AGENTS.md §6.8）。
 * @returns {string} 工作区绝对路径；进程退出时自动清理
 */
export function makeWorkspace(extra = []) {
  const dir = mkdtempSync(join(tmpdir(), 'knit-fixture-'))
  const base = Date.now() - 120_000
  const files = [
    ['README.md', '# 样本 README\n\nKnit 样本工作区主文档，含关键词：相关性排序、sidebar。\n'],
    ['docs/notes.md', '# 样本笔记\n\n第二篇，用来凑够三篇。\n'],
    ['CHANGELOG.md', '# 样本变更\n\n第三篇。\n'],
    ['package.json', '{\n  "name": "sample"\n}\n'],
    ['docs/screenshot.png', PADDED_PNG],
    ['docs/clip.mp4', FAKE_MP4],
    ...extra,
  ]
  files.forEach(([rel, content], i) => {
    const abs = join(dir, rel)
    mkdirSync(join(abs, '..'), { recursive: true })
    writeFileSync(abs, content)
    const t = (base + i * 1000) / 1000
    utimesSync(abs, t, t)
  })
  trackForCleanup(dir)
  return dir
}

/**
 * 退出时统一清理（**一个 `exit` 监听器**，不是每个工作区一个）。
 *
 * 以前每个工作区都挂一个监听器：单文件里造十几个工作区就会触发
 * `MaxListenersExceededWarning`（v0.20 的 deep-eval 一次要造 6 个、
 * 还要跑两遍确定性 → 当场撞上）。一个 `Set` + 一个监听器行为完全等价。
 */
const LIVE_DIRS = new Set()
let cleanupHooked = false

function trackForCleanup(dir) {
  LIVE_DIRS.add(dir)
  if (cleanupHooked) return
  cleanupHooked = true
  process.on('exit', () => {
    for (const d of LIVE_DIRS) rmSync(d, { recursive: true, force: true })
    LIVE_DIRS.clear()
  })
}

/* ── 存储替身（v0.22 的增量索引需要一份「能重启」的介质）───────── */

/**
 * 一个最小的假 `kv` 后端，形状与 `dsh-storage` 的 JSON 后端一致
 * （`open(descriptor)` → `loadAll / putRecord / deleteRecord`）。
 *
 * `medium` 与后端实例**分开**，于是「重启」= 同一份 medium + 一个全新的后端，
 * 而 `duplicate-mount`（同名 unit 在**同一个**后端里开两次）也能如实复现。
 *
 * @param {{tables?: object}} [medium] - 介质（省略则新建一份空的）
 * @param {{failOpen?: boolean, brokenLoad?: boolean}} [options] - 故障注入
 * @returns {object} 假后端（含 `medium` / `writes` / `descriptors`）
 */
export function fakeStorageBackend(medium = { tables: {} }, options = {}) {
  const opened = new Set()
  const writes = []
  const descriptors = []
  const unitOf = (name) => ({
    loadAll: async () => {
      if (options.brokenLoad) throw new Error('malformed-medium')
      return { unit: { name, version: 1 }, global: {}, tables: medium.tables }
    },
    putRecord: async (table, key, value) => {
      writes.push(['put', table, key])
      medium.tables[table] = medium.tables[table] || {}
      medium.tables[table][key] = value
    },
    deleteRecord: async (table, key) => {
      writes.push(['del', table, key])
      if (medium.tables[table]) delete medium.tables[table][key]
    },
    setGlobal: async () => {},
    close: async () => { opened.delete(name) },
  })
  return {
    medium,
    writes,
    descriptors,
    kv: {
      open: async (descriptor) => {
        descriptors.push(descriptor)
        if (options.failOpen) throw new Error('medium-unavailable')
        if (opened.has(descriptor.name)) throw new Error('duplicate-mount')
        opened.add(descriptor.name)
        return unitOf(descriptor.name)
      },
    },
  }
}

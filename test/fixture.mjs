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
 * @returns {string} 工作区绝对路径；进程退出时自动清理
 */
export function makeWorkspace() {
  const dir = mkdtempSync(join(tmpdir(), 'knit-fixture-'))
  const base = Date.now() - 120_000
  const files = [
    ['README.md', '# 样本 README\n\nKnit 样本工作区主文档，含关键词：相关性排序、sidebar。\n'],
    ['docs/notes.md', '# 样本笔记\n\n第二篇，用来凑够三篇。\n'],
    ['CHANGELOG.md', '# 样本变更\n\n第三篇。\n'],
    ['package.json', '{\n  "name": "sample"\n}\n'],
    ['docs/screenshot.png', PADDED_PNG],
    ['docs/clip.mp4', FAKE_MP4],
  ]
  files.forEach(([rel, content], i) => {
    const abs = join(dir, rel)
    mkdirSync(join(abs, '..'), { recursive: true })
    writeFileSync(abs, content)
    const t = (base + i * 1000) / 1000
    utimesSync(abs, t, t)
  })
  process.on('exit', () => rmSync(dir, { recursive: true, force: true }))
  return dir
}

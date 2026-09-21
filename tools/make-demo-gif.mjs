/**
 * Knit · **演示 GIF 编码器** —— 把一段录屏（或一帧帧 PNG）压成 README 能用的 GIF
 *
 * ## 为什么有这个脚本
 *
 * 第 1 屏最该有、却一直缺的，是「**排序跟着对话走**」的动图 —— 静态图只能拍到结果，
 * 拍不到「过程」，而那条才是 Knit 相对竞品的唯一差异点（`发布文档规划` §4.4）。
 *
 * **录屏这一步必须由人做**：本机这个执行环境**没有**任何截屏能力 ——
 * 2026-09-21 逐条探过，四条路全堵：
 *
 * | 路 | 结果 |
 * |---|---|
 * | `screencapture` | `rect … does not intersect any displays`（没有屏幕录制权限 / 无显示访问） |
 * | AppleScript（System Events） | `hiservices-xpcservice Connection Invalid`（发不出 Apple Event） |
 * | Playwright 自带 Chromium | `MachPortRendezvousServer … Permission denied (1100)`，起不来 |
 * | `ffmpeg -f avfoundation -list_devices` | 视频设备列表**是空的** |
 *
 * 而且**不许拿 HTML 原型充数**（`发布文档规划` §4 的硬规矩）——
 * GIF 里必须是真实 GUI。
 *
 * 所以分工是：**人录 2 分钟 → 这个脚本把剩下全做完**（裁切、抽帧、调色板优化、
 * 控制体积、打印要粘进 README 的那一行）。
 *
 * ## 用法
 *
 * ```sh
 * # 录屏文件（QuickTime / ⌘⇧5 录出来的 .mov 直接可用）
 * node tools/make-demo-gif.mjs --in ~/Desktop/knit-reorder.mov --start 2 --end 10
 *
 * # 整屏录的，只要「对话 + 右侧栏」那一块：--crop x,y,w,h（源像素，先裁后缩）
 * node tools/make-demo-gif.mjs --in ~/Desktop/knit-reorder.mov --crop 560,0,2240,1520 --width 1100
 *
 * # 或者一帧帧的 PNG 目录（文件名要能按字典序排对）
 * node tools/make-demo-gif.mjs --in /tmp/knit-frames --fps 10
 * ```
 *
 * 录之前先看 `发布文档规划` §4.3 的拍摄清单（只截「对话 + 右侧栏」、深色主题、
 * 循环能无缝衔接）。**最关键的一条**：先在对话里聊 A 话题（列表顶上是 A 的文档），
 * 再发一句 B 话题，让列表重排 —— 那一下才是这个 GIF 的全部意义。
 * ⚠️ 重排**不是瞬时的**：面板每 5 秒轮询一次，所以它落在发消息后的 0–5 秒之间，
 * 图注按这个写，别写成「1 秒内」。
 */

import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, statSync, mkdirSync, readdirSync, readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, resolve, join, extname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 仓库根 = 本脚本所在目录的上一层（`knit/`）。用来算 README 里那条相对路径。 */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/* ── 参数 ─────────────────────────────────────────────── */

function arg(name, fallback = undefined) {
  const i = process.argv.indexOf(`--${name}`)
  if (i < 0) return fallback
  const v = process.argv[i + 1]
  return v && !v.startsWith('--') ? v : true
}

const inPath = arg('in')
const outPath = resolve(arg('out', 'docs/demo-reorder.gif'))
const fps = Number(arg('fps', '12'))
const width = Number(arg('width', '880'))
const start = arg('start')
const end = arg('end')
const dryRun = Boolean(arg('dry-run', false))

/**
 * `--crop x,y,w,h`（**源画面**像素）。
 *
 * 为什么需要它：真机录屏是整屏（或至少带着左栏），而 README 只想要「对话 + 右侧栏」。
 * 裁切必须在这里做，不能事后手工跑一遍 ffmpeg —— 两个原因：
 *   ① `crop` 要排在 `scale` **前面**（先裁后缩）；反过来就是按已缩放的坐标去裁，会切错
 *   ② 画布高度是按输入比例算的，不先把裁切算进去，输出会带着一圈留边
 */
const cropArg = arg('crop')
let crop = null
if (cropArg && cropArg !== true) {
  const parts = String(cropArg).split(/[,x:]/).map((s) => Number(s.trim()))
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n) || n < 0) || parts[2] <= 0 || parts[3] <= 0) {
    console.error(`❌ --crop 要四个数：x,y,w,h（宽高必须 > 0），收到「${cropArg}」`)
    process.exit(1)
  }
  crop = { x: parts[0], y: parts[1], w: parts[2], h: parts[3] }
}

if (!inPath || inPath === true) {
  console.error('❌ 缺 --in\n\n用法：\n  node tools/make-demo-gif.mjs --in <录屏文件.mov|帧目录> [--out docs/demo-reorder.gif] [--fps 12] [--width 880] [--crop 560,0,2240,1520] [--start 2] [--end 10]\n')
  process.exit(1)
}
if (!Number.isFinite(fps) || fps <= 0 || fps > 30) {
  console.error(`❌ --fps 不合理：${fps}（取 6–30 之间；GIF 超过 15fps 体积涨得很快而看不出差别）`)
  process.exit(1)
}

const src = resolve(String(inPath))
if (!existsSync(src)) {
  console.error(`❌ 找不到输入：${src}`)
  process.exit(1)
}

/* ── 输入是「视频文件」还是「PNG 目录」 ──────────────── */

const isDir = statSync(src).isDirectory()
const VIDEO_EXT = new Set(['.mov', '.mp4', '.m4v', '.avi', '.mkv', '.webm'])
if (!isDir && !VIDEO_EXT.has(extname(src).toLowerCase())) {
  console.error(`❌ 不认识的输入类型：${src}\n   视频请给 .mov/.mp4，或给一个装满 PNG 的目录。`)
  process.exit(1)
}
if (isDir) {
  const frames = readdirSync(src).filter((f) => /\.(png|jpg|jpeg)$/i.test(f)).sort()
  if (frames.length < 2) {
    console.error(`❌ 目录里至少要有 2 帧（现在是 ${frames.length} 帧）：${src}`)
    process.exit(1)
  }
  console.log(`  输入：帧目录，${frames.length} 帧（按字典序；首帧 ${frames[0]}）`)
  if (frames.length > 400) console.log(`  ⚠️ 帧数偏多（${frames.length}）—— GIF 会很大，考虑用 --start/--end 或先抽帧`)
} else {
  const mb = (statSync(src).size / 1048576).toFixed(1)
  console.log(`  输入：视频文件 ${src}（${mb} MB）`)
}

/* ── ffmpeg ───────────────────────────────────────────── */

try {
  execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' })
} catch {
  console.error('❌ 找不到 ffmpeg（本机在 /opt/homebrew/bin/ffmpeg）。装了再来。')
  process.exit(1)
}

/* ── 画布尺寸：GIF 要求恒定，混高宽比会被静默丢帧 ────── */

/** 读 PNG 头里的宽高（IHDR：偏移 16 起 8 字节是 width/height，大端）。 */
function pngSize(file) {
  const b = readFileSync(file)
  if (b.length < 24) return null
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) }
}

/** 用 ffprobe 读视频宽高。 */
function videoSize(file) {
  try {
    const out = execFileSync('ffprobe', [
      '-v', 'error', '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height', '-of', 'csv=p=0', file,
    ]).toString().trim().split('\n')[0]
    const [w, h] = out.split(',').map(Number)
    return Number.isFinite(w) && Number.isFinite(h) ? { w, h } : null
  } catch {
    return null
  }
}

const srcSize = isDir ? pngSize(join(src, readdirSync(src).filter((f) => /\.(png|jpe?g)$/i.test(f)).sort()[0])) : videoSize(src)
if (!srcSize || !srcSize.w || !srcSize.h) {
  console.error(`❌ 读不出输入画面的宽高（${src}）—— 视频请确认 ffprobe 能读，PNG 请确认没损坏。`)
  process.exit(1)
}
// 画布高度按「首帧比例 × 目标宽」算，并压成偶数（部分编码器要求）
// 有 --crop 时按**裁完**的比例算，否则输出会多出一圈留边
const effW = crop ? crop.w : srcSize.w
const effH = crop ? crop.h : srcSize.h
if (crop && (crop.x + crop.w > srcSize.w || crop.y + crop.h > srcSize.h)) {
  console.error(`❌ --crop 超出源画面：源 ${srcSize.w}×${srcSize.h}，却要裁 ${crop.x},${crop.y} 起 ${crop.w}×${crop.h}`)
  process.exit(1)
}
const H = Math.max(2, 2 * Math.round((width * effH) / effW / 2))
console.log(`  画布：${width}×${H}（源 ${srcSize.w}×${srcSize.h}${crop ? ` → 裁到 ${crop.x},${crop.y} ${crop.w}×${crop.h}` : ''}；不同尺寸的帧会被居中留边，不会丢帧）`)

/**
 * 单命令调色板法：`split` 出一路生成调色板，再拿它量化另一路。
 * 比两遍法少一次全量解码，且 `stats_mode=diff` 对「大部分静止、只有一处变化」
 * 的录屏特别合适 —— 正是我们这种「列表重排」的画面。
 *
 * ⚠️ `scale=W:H:force_original_aspect_ratio=decrease` + `pad` 这两步**不能省**：
 * GIF 复用器要求**恒定画布**，而它遇到尺寸变化的帧时**不报错、只把后面的帧丢掉**
 * （2026-09-21 实测：3 帧不同高宽比的输入 → 静默产出 1 帧）。
 */
const FILTER = [
  ...(crop ? [`crop=${crop.w}:${crop.h}:${crop.x}:${crop.y}`] : []),
  `fps=${fps}`,
  `scale=${width}:${H}:force_original_aspect_ratio=decrease:flags=lanczos`,
  `pad=${width}:${H}:(ow-iw)/2:(oh-ih)/2:color=0x101010`,
  'split[s0][s1]',
  '[s0]palettegen=stats_mode=diff[p]',
  '[s1][p]paletteuse=dither=bayer:bayer_scale=3',
].join(',')

const args = ['-y', '-hide_banner', '-loglevel', 'error']

/**
 * 帧目录且**尺寸不一致**时，先落盘归一化一份，再从归一化的序列编码。
 *
 * 为什么不能只靠滤镜里的 `scale+pad`：帧尺寸一变，ffmpeg 要在滤镜图上重新协商尺寸，
 * 而下游接着 paletteuse 时**会静默丢掉后续帧**（实测 3 帧不同高宽比 → 只出 1 帧，
 * 且 `-loglevel error` 一声不吭）。先落盘统一尺寸就绕开了那次重新协商。
 * 真实录屏本来就是恒定尺寸，这一段只在「手工攒的帧」这种情形下才会跑。
 */
let encodeSource = src
let tempDir = null
if (isDir) {
  const files = readdirSync(src).filter((f) => /\.(png|jpe?g)$/i.test(f)).sort()
  const sizes = new Set(files.map((f) => { const s = pngSize(join(src, f)); return s ? `${s.w}x${s.h}` : '?' }))
  if (sizes.size > 1) {
    console.log(`  ⚠️ 输入帧尺寸不一致（${[...sizes].join(' / ')}）—— 先归一化到 ${width}×${H} 再编码`)
    tempDir = mkdtempSync(join(tmpdir(), 'knit-gif-'))
    files.forEach((f, i) => {
      const dst = join(tempDir, `n${String(i + 1).padStart(4, '0')}.png`)
      const r = spawnSync('ffmpeg', [
        '-y', '-hide_banner', '-loglevel', 'error', '-i', join(src, f),
        '-vf', `${crop ? `crop=${crop.w}:${crop.h}:${crop.x}:${crop.y},` : ''}scale=${width}:${H}:force_original_aspect_ratio=decrease:flags=lanczos,pad=${width}:${H}:(ow-iw)/2:(oh-ih)/2:color=0x101010`,
        '-frames:v', '1', dst,
      ], { stdio: ['ignore', 'inherit', 'inherit'] })
      if (r.status !== 0) {
        console.error(`\n❌ 归一化第 ${i + 1} 帧失败（${f}）`)
        process.exit(1)
      }
    })
    encodeSource = tempDir
  }
}

if (isDir) args.push('-framerate', String(fps), '-pattern_type', 'glob', '-i', join(encodeSource, '*.png'))
else {
  if (start && start !== true) args.push('-ss', String(start))
  if (end && end !== true) args.push('-to', String(end))
  args.push('-i', src)
}
args.push('-vf', FILTER, '-loop', '0', outPath)

console.log(`\n  输出：${outPath}`)
console.log(`  参数：${fps} fps · 宽 ${width}px · ${isDir ? '帧序列' : '视频'}${crop ? ` · 裁 ${crop.w}×${crop.h}+${crop.x}+${crop.y}` : ''}${start ? ` · 从 ${start}s` : ''}${end ? ` · 到 ${end}s` : ''}`)
console.log(`  滤镜：palettegen(stats_mode=diff) + paletteuse(bayer)\n`)

if (dryRun) {
  console.log('  ffmpeg ' + args.join(' '))
  process.exit(0)
}

mkdirSync(dirname(outPath), { recursive: true })
const t0 = Date.now()
const r = spawnSync('ffmpeg', args, { stdio: ['ignore', 'inherit', 'inherit'] })
/** 归一化用的临时目录不能留在磁盘上。 */
const cleanup = () => { if (tempDir) { rmSync(tempDir, { recursive: true, force: true }); tempDir = null } }
if (r.status !== 0) {
  cleanup()
  console.error(`\n❌ ffmpeg 失败（exit ${r.status}）`)
  process.exit(r.status || 1)
}
cleanup()

const kb = statSync(outPath).size / 1024

/**
 * 编码后自检：**只有 1 帧的 GIF 等于什么都没录到**，而这种失败是静默的
 * （ffmpeg 不会报错）。宁可这里红，也不要让一张「不动的动图」混进 README。
 */
function gifFrameCount(file) {
  try {
    const out = execFileSync('ffprobe', [
      '-v', 'error', '-count_frames', '-select_streams', 'v:0',
      '-show_entries', 'stream=nb_read_frames', '-of', 'default=nw=1:nk=1', file,
    ]).toString().trim()
    const n = Number(out)
    return Number.isFinite(n) ? n : null
  } catch {
    return null
  }
}
const encodedFrames = gifFrameCount(outPath)
console.log(`  ✅ 完成：${kb.toFixed(0)} KB，${encodedFrames ?? '?'} 帧，耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`)
if (encodedFrames !== null && encodedFrames < 2) {
  console.error(`
❌ 产出的 GIF 只有 ${encodedFrames} 帧 —— 这不是「动图」。常见原因：
   ① 录屏里那段本来就没动（对着一个静止画面录了 N 秒）
   ② --start/--end 把有效区间剪掉了
   ③ 输入帧尺寸不一致（本脚本已用 scale+pad 统一画布，若仍出现请贴出上面「画布」那行）
   先确认录屏本身有「列表重排」那一秒，再重跑。产物已留下供你查看：${outPath}`)
  process.exitCode = 1
}

if (kb > 3000) {
  console.log('  ⚠️ 超过 3 MB —— GitHub 页面会加载很慢。降体积的优先顺序：')
  console.log('     ① 缩窄画面（--width 640）② 剪掉多余秒数（--start/--end）③ 降 fps（--fps 10）')
} else if (kb > 1500) {
  console.log('  ℹ️ 1.5–3 MB：能接受，但再剪掉一两秒会明显更快。')
} else {
  console.log('  ✅ 体积很健康。')
}

/* ── 录完要改的三处 ──────────────────────────────────── */

const relOut = relative(REPO_ROOT, outPath)
const inRepo = relOut && !relOut.startsWith('..')
console.log()
if (inRepo) {
  const raw = `https://raw.githubusercontent.com/PolinniZhong/dsh-knit/main/${relOut.split('\\').join('/')}`
  console.log(`  接下来把图接进 README（三处，别漏）：
    1. README.md      —— 「另外两档长什么样」之后加：
       ![排序跟着对话走](${raw})
    2. README.en.md   —— 同一位置的英文版
    3. docs/README.md —— 把 demo-reorder.gif 那行的状态从 ⬜ 改成 ✅
  图注记得写清「图里在发生什么」，别只写「演示」。**而且别写「1 秒内重排」**：
  面板是**每 5 秒轮询一次**（POLL_MS，见 src/client/client.js），所以重排发生在发消息之后的
  **0–5 秒**内，快的时候看着像瞬时，慢的时候要等一轮。写「下一次轮询就重排」才是准的。
  补图**不用发版**：README 走的是绝对 raw URL + HEAD。`)
} else {
  console.log(`  ⚠️ 输出不在仓库里（${outPath}）—— 正式产物请输出到 docs/ 下，例如：
       node tools/make-demo-gif.mjs --in <录屏> --out docs/demo-reorder.gif
     放进仓库后 README 才能用绝对 raw URL 引用它。`)
}

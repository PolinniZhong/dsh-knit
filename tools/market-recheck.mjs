/**
 * Knit · **市场收录与下载量复查** —— 一条命令把「发布后该盯的数」全打出来
 *
 * ## 为什么有这个脚本（2026-09-21）
 *
 * 原本有个 DSH 定时任务（`Knit 市场收录复查`，每日 10:30）干这件事，但它
 * **从来没有成功过一次**：4/4 全部在 12–62 ms 内失败，错误恒为
 * `cannot get property "agent" without inject` —— 会话根本没起来。
 *
 * 用一个**最小探针任务**（prompt 只写「回一个 OK」）复现过：同样 53 ms 同一个错，
 * 所以**不是任务写坏了，是调度子系统起不来会话**（宿主侧的服务注入问题），
 * 改 prompt 救不了。任务已撤除，改由这个脚本承担 —— 它**不需要 agent**，
 * 只做 HTTP 取数 + 判读，因此不受那个 bug 影响。
 *
 * ## 用法
 *
 * ```sh
 * node tools/market-recheck.mjs                 # 全部检查
 * node tools/market-recheck.mjs --days 14       # 下载曲线看最近 14 天
 * ```
 *
 * 直连即可（`awesome-dsh-plugin.com` 与 `api.npmjs.org` 都不在墙内）。
 * 需要走代理的环境加 `NODE_USE_ENV_PROXY=1`（Node 24+ 才认这个变量）。
 *
 * ## 判读规则（都是踩过坑写下的，别改）
 *
 * 1. **npm 日统计有空洞**：`react` 显示 0 的那天是「还没统计到」，不是「没人下载」。
 *    所以每条曲线都要跟 `react` 逐日对照，只看**非空洞**的天。
 * 2. **只看「连续多日非零」**，不看单日数字 —— 发布当天必然尖峰（镜像/自动化在拉新版本）。
 * 3. **版本分布是自动化流量最灵的判据**：持续有旧版本（如 `0.4.0`）被下载，
 *    更像有工具在枚举所有版本，不是真人在用。
 * 4. 聚合器没补全就直说「还没」，**不要拿 `null` 当 0**。
 *
 * 背景与历史误读见 `03_发布/发布清单-v0.9.0.md` §三 / §五。
 */

const MARKET_INDEX = 'https://awesome-dsh-plugin.com/plugins.json'
const PAGE_ZH = 'https://awesome-dsh-plugin.com/zh/p/PolinniZhong/dsh-knit/'
const NPM_DAILY = (pkg, from, to) => `https://api.npmjs.org/downloads/range/${from}:${to}/${pkg}`
const NPM_VERSION_SPLIT = 'https://api.npmjs.org/versions/dsh-knit/last-week'
const PKG = 'dsh-knit'
const PROBE = 'react' // 空洞探针

/** 上一次人工测得的基线（2026-09-20），用来出对照表 */
const BASELINE = {
  measuredAt: '2026-09-20',
  version: '0.12.1',
  stars: 2,
  downloads: 396,
  downloadsWindow: '08-21→09-19',
  install: 'dsh plugin --profile web add dsh-knit',
  screenshots: 1,
}

const days = (() => {
  const i = process.argv.indexOf('--days')
  const n = i >= 0 ? Number(process.argv[i + 1]) : 12
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 12
})()

const iso = (d) => d.toISOString().slice(0, 10)
const today = new Date()
const from = iso(new Date(today.getTime() - days * 86400000))
const to = iso(today)

const line = (s = '') => console.log(s)
const head = (s) => { line(); line(`── ${s} ${'─'.repeat(Math.max(0, 60 - s.length))}`) }
const kv = (k, v, pad = 20) => line(`  ${String(k).padEnd(pad)}${v}`)

async function getJson(url) {
  const res = await fetch(url, { headers: { accept: 'application/json' } })
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`)
  return res.json()
}

async function getText(url) {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`)
  return res.text()
}

/** 把两条日曲线对齐，标出探针为 0 的日子（= 没统计到，不是没人下载）。 */
function alignDaily(pkgDays, probeDays) {
  const probe = new Map((probeDays || []).map((d) => [d.day, d.downloads]))
  return (pkgDays || []).map((d) => ({
    day: d.day,
    n: d.downloads,
    hole: (probe.get(d.day) ?? 0) === 0,
  }))
}

async function main() {
  line('Knit · 市场收录与下载量复查')
  kv('检查时间', new Date().toISOString())
  kv('下载窗口', `${from} → ${to}（${days} 天）`)

  /* ── 一、市场索引 ─────────────────────────────────── */
  head('一、市场索引（awesome-dsh-plugin）')
  try {
    const idx = await getJson(MARKET_INDEX)
    const items = Array.isArray(idx) ? idx : (idx.plugins || idx.items || [])
    const me = items.find((p) => p && (p.name === PKG || p.url === 'https://github.com/PolinniZhong/dsh-knit'))
    if (!me) {
      line(`  ❌ 索引里找不到 ${PKG}（共 ${items.length} 条）—— 条目是不是被移除了？`)
    } else {
      const shots = Array.isArray(me.screenshots) ? me.screenshots.length : 0
      const now = {
        version: me.version ?? null,
        stars: me.stars ?? null,
        downloads: me.downloads ?? null,
        install: me.install ?? null,
        screenshots: shots,
      }
      line(`  索引条目数: ${items.length}`)
      line()
      // 两列宽度都按最长值算：第一列要放 install 命令（39 字符），第二列放基线里的同一条
      const W1 = 12
      const W2 = Math.max(24, BASELINE.install.length + 2, String(BASELINE.downloads).length + 14)
      line(`  ${'字段'.padEnd(W1)}${'上次 ' + BASELINE.measuredAt}`)
      line(`  ${'-'.repeat(W1 + W2 + 20)}`)
      const row = (k, before, after) =>
        line(`  ${k.padEnd(W1)}${String(before).padEnd(W2)}${after}`)
      row('version', BASELINE.version, now.version ?? '❌ null（还没补全）')
      row('stars', BASELINE.stars, now.stars ?? '❌ null')
      row('downloads', `${BASELINE.downloads}（${BASELINE.downloadsWindow}）`, now.downloads ?? '❌ null')
      row('install', BASELINE.install, now.install ?? '❌ null')
      row('screenshots', BASELINE.screenshots, now.screenshots)

      line()
      const zh = (me.description || {}).zh || ''
      const en = (me.description || {}).en || ''
      line(`  描述：zh ${zh.length} 字符 / en ${en.length} 字符`)
      line(`        含「引用条/references bar」？${/引用条|references bar/i.test(zh + en) ? '✅ 有' : '⬜ 还没有（PR #5542 若已合并则该出现）'}`)

      if (now.downloadsCheckedAt !== undefined) kv('下载量核对于', me.downloadsCheckedAt)
      line()
      if (now.install && String(now.install).startsWith('dsh plugin')) {
        line('  ✅ 安装方式已是 npm（`dsh plugin … add dsh-knit`）—— 不再显示「要跑构建脚本」的误伤警告')
      } else {
        line(`  ⚠️ 安装方式仍是 ${now.install} —— 若为 \`github:\` 装法，市场页面会显示构建警告（对零依赖的我们是误伤）`)
      }
      if (now.version !== BASELINE.version) {
        line(`  ℹ️ version 从 ${BASELINE.version} → ${now.version}：索引是**每天 UTC 02:23 定时重建**的，` +
          '我们发版后要等那次构建（或推它们的 main）才会变。')
      }
    }
  } catch (e) {
    line(`  ❌ 取索引失败：${e.message}`)
  }

  /* ── 二、市场页面是否渲染了 README ────────────────── */
  head('二、市场详情页的 README 渲染')
  try {
    const html = await getText(PAGE_ZH)
    const imgs = (html.match(/<img/g) || []).length
    kv('页面字节数', html.length)
    kv('<img> 数量', imgs)
    line(imgs > 0
      ? '  ✅ README 渲染成功（判据：页面里有图）'
      : '  ⬜ 页面里没有图 —— README 可能没渲染出来（或索引还没抓）')
  } catch (e) {
    line(`  ❌ 取页面失败：${e.message}`)
  }

  /* ── 三、npm 下载量（避开空洞） ───────────────────── */
  head('三、npm 下载量（逐日，已对 react 探针标出空洞）')
  try {
    const [mine, probe] = await Promise.all([
      getJson(NPM_DAILY(PKG, from, to)),
      getJson(NPM_DAILY(PROBE, from, to)),
    ])
    const rows = alignDaily(mine.downloads, probe.downloads)
    const real = rows.filter((r) => !r.hole)
    const realNonZero = real.filter((r) => r.n > 0)

    line(`  ${'日期'.padEnd(12)}${'下载'.padStart(6)}   状态`)
    line(`  ${'-'.repeat(38)}`)
    for (const r of rows) {
      line(`  ${r.day.padEnd(12)}${String(r.n).padStart(6)}   ${r.hole ? '（空洞：react 当天也是 0）' : (r.n > 0 ? '✅ 已统计' : '已统计，0')}`)
    }
    line()
    kv('已统计的天数', `${real.length} / ${rows.length}`)
    kv('其中非零', realNonZero.length)
    kv('非零合计', realNonZero.reduce((s, r) => s + r.n, 0))

    // 「连续多日非零」= 真实采用的判据（不是单日数字）
    let best = 0
    let cur = 0
    for (const r of rows) {
      if (!r.hole && r.n > 0) { cur += 1; best = Math.max(best, cur) } else { cur = 0 }
    }
    kv('最长连续非零', `${best} 天`)
    line()
    if (real.length < 5) {
      line('  ⚠️ 已统计的天数太少 —— **还不能判断**，不要给确定性结论（历史误读见发布清单-v0.9.0 §3.2）')
    } else if (best >= 3) {
      line(`  ✅ 出现 ${best} 天连续非零 —— 这是「真人在用」的信号（但仍要看下面版本分布）`)
    } else {
      line('  ⬜ 没有连续多日非零 —— 目前更像发布当天的尖峰或零散自动化流量')
    }
  } catch (e) {
    line(`  ❌ 取下载曲线失败：${e.message}`)
  }

  /* ── 四、按版本拆分（自动化流量最灵的判据） ───────── */
  head('四、按版本拆分（last-week）—— 自动化流量判据')
  try {
    const split = await getJson(NPM_VERSION_SPLIT)
    const dl = split.downloads || {}
    const entries = Object.entries(dl).sort((a, b) => b[1] - a[1])
    if (entries.length === 0) {
      line('  ⬜ 没有数据')
    } else {
      const total = entries.reduce((s, [, n]) => s + n, 0)
      for (const [v, n] of entries) line(`  ${v.padEnd(12)}${String(n).padStart(8)}`)
      kv('合计', total)
      line()
      const old = entries.filter(([v]) => v !== (entries[0][0]))
      if (old.length >= 2) {
        line(`  ⚠️ 有 ${old.length} 个非首位版本仍在被下载 —— 更像**有工具在枚举所有版本**，`)
        line('     而不是真人在装某一个。判据是「连续多日非零」+「版本分布是否发散」，两者一起看。')
      } else {
        line('  ℹ️ 版本分布集中 —— 没有明显的版本枚举迹象（但样本仍可能太小）')
      }
    }
  } catch (e) {
    line(`  ❌ 取版本拆分失败：${e.message}`)
  }

  line()
  line('（判读口径与历史误读：03_发布/发布清单-v0.9.0.md §三 / §五；本脚本取代了那个坏掉的每日定时任务）')
}

main().catch((e) => {
  console.error(`\n❌ 复查脚本失败：${e && e.stack ? e.stack : e}`)
  process.exitCode = 1
})

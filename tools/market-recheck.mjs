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

/** 上一次人工测得的基线（2026-09-23），用来出对照表 */
const BASELINE = {
  measuredAt: '2026-09-23',
  version: '0.13.0',
  stars: 2,
  downloads: 1115,
  downloadsWindow: '08-23→09-21（30 天）',
  install: 'dsh plugin --profile web add dsh-knit',
  screenshots: 3,
}

/** 取包元数据（为了拿 dist-tags.latest —— 形状判读要用它） */
const NPM_PKG_META = `https://registry.npmjs.org/${PKG}`

/**
 * ── 「形状判读」的两条门槛（2026-09-23 建立，**取代旧的「连续多日非零」**）──
 *
 * **旧判据分不出真人和爬虫** —— 2026-09-21 那次它打出「最长连续非零 2 天」，
 * 读起来像「有点人气」，而真相是自动化枚举。
 *
 * 实测对照（同一个 30 天窗口）：
 *
 *   真有人在用的包                        被自动化枚举的包
 *   latest 占比 **60–80%**               latest 占比 **11–15%**（各版本均分）
 *   旧版本**塌到 1–2%**                  旧版本**和最新版一样多**
 *   日覆盖 **23–24 / 24**                日覆盖 **2–9 / 24**
 *
 * 决定性证据（就是 dsh-knit 自己）：
 *   `0.5.0`  当了 latest **0.47 小时**（28 分） → 155 次
 *   `0.13.0` 当了 latest **59.6 小时**          → 161 次
 *   **曝光相差 127 倍、下载只差 1.04 倍** ⇒ 不可能是人（人只装 `latest`）。
 *
 * ⚠️ **不要拿「每版本下载量」当判据** —— 实测分不出来：
 * `dsh-workbench` 每版本只有 117 次（低于所谓地板），但它 `latest` 占 64.9%、
 * 日覆盖 24/24，是真有人在用的包。**只有「形状」能分。**
 */
const FLOOR_LATEST_SHARE = 50 // % —— latest 占比低于此值 = 疑似枚举
const FLOOR_COVERAGE_DAYS = 10 // 非空洞且有量的天数低于此值 = 样本不足

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
  /** 形状判读的两个读数，算完给 §五 出总结论 */
  let coverageDays = null
  let latestShare = null

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

    // ★ 判据一：**日覆盖度** —— 非空洞且有量的天数。
    //   真包 23–24/24；发布日一次小尖峰只有 2–9/24。
    coverageDays = realNonZero.length
    kv('★ 日覆盖度', `${coverageDays} / ${real.length} 个可测日`)

    // 仅作参考，**不再是判据**（它分不出真人和爬虫）
    let best = 0
    let cur = 0
    for (const r of rows) {
      if (!r.hole && r.n > 0) { cur += 1; best = Math.max(best, cur) } else { cur = 0 }
    }
    kv('（参考）最长连续非零', `${best} 天 —— ⚠️ 这不是判据，见 §五`)
    line()
    if (real.length < 5) {
      line('  ⚠️ 已统计的天数太少 —— 还不能判断，不要给确定性结论（历史误读见发布清单-v0.9.0 §3.2）')
    } else if (coverageDays >= FLOOR_COVERAGE_DAYS) {
      line(`  ✅ 日覆盖 ${coverageDays}/${real.length} —— 过了覆盖门槛（但还要看 §五 的 latest 占比）`)
    } else {
      line(`  ⬜ 日覆盖只有 ${coverageDays}/${real.length} —— 更像发布当天的小尖峰，不是持续使用`)
    }
  } catch (e) {
    line(`  ❌ 取下载曲线失败：${e.message}`)
  }

  /* ── 四、按版本拆分 —— ★ 判据二：latest 占比 ─────── */
  head('四、按版本拆分（last-week）—— ★ 判据二：latest 占比')
  try {
    const [split, meta] = await Promise.all([
      getJson(NPM_VERSION_SPLIT),
      getJson(NPM_PKG_META).catch(() => null),
    ])
    const dl = split.downloads || {}
    const entries = Object.entries(dl).sort((a, b) => b[1] - a[1])
    if (entries.length === 0) {
      line('  ⬜ 没有数据')
    } else {
      const total = entries.reduce((s, [, n]) => s + n, 0)
      const latest = (meta && meta['dist-tags'] && meta['dist-tags'].latest) || null
      for (const [v, n] of entries) {
        const pct = total > 0 ? (n / total) * 100 : 0
        const bar = '█'.repeat(Math.max(1, Math.round(pct / 2.5)))
        line(`  ${v.padEnd(12)}${String(n).padStart(8)}  ${pct.toFixed(1).padStart(5)}%  ${bar}${v === latest ? ' ← latest' : ''}`)
      }
      kv('合计', total)

      // ★ 判据二：**latest 占比**。人只装 latest（真包 60–80%）；
      //   枚举会把每个版本各取一遍 ⇒ 各版本均分 11–15%。
      if (latest && dl[latest] !== undefined && total > 0) {
        latestShare = (dl[latest] / total) * 100
        kv('★ latest 占比', `${latestShare.toFixed(1)}%（${latest}）`)
      } else {
        kv('★ latest 占比', `⚠️ 拿不到 dist-tags.latest（${latest || 'null'}），本项跳过`)
      }

      line()
      const flat = entries
        .filter(([v]) => v !== latest)
        .filter(([, n]) => total > 0 && (n / total) * 100 >= 5)
      if (flat.length >= 3) {
        line(`  ⚠️ 除 latest 外还有 ${flat.length} 个版本各占 ≥5%（近乎均分）——`)
        line('     **这是版本枚举的指纹**：人不会去装一个被取代多次的旧版本。')
      } else {
        line('  ✅ 版本分布集中、旧版本已塌下去 —— 没有被枚举的迹象。')
      }
    }
  } catch (e) {
    line(`  ❌ 取版本拆分失败：${e.message}`)
  }

  /* ── 五、形状判读（总结论） ───────────────────────── */
  head('五、形状判读 —— 一句话结论')
  line()
  kv('日覆盖度', coverageDays === null ? '取数失败' : `${coverageDays} 天（门槛 ≥ ${FLOOR_COVERAGE_DAYS}）`)
  kv('latest 占比', latestShare === null ? '取数失败' : `${latestShare.toFixed(1)}%（门槛 ≥ ${FLOOR_LATEST_SHARE}%）`)
  line()
  if (coverageDays === null || latestShare === null) {
    line('  ⚠️ 有一项取数失败 —— 不给结论，不要猜。')
  } else if (latestShare >= FLOOR_LATEST_SHARE) {
    line('  ✅ **latest 占比过了门槛 —— 开始有真人 npm install 了。**')
    line('     这是「有个真人装了」的唯一硬信号；到这步才该看有没有人开口。')
  } else if (coverageDays >= FLOOR_COVERAGE_DAYS) {
    line('  ⚠️ 有量，但 latest 占比仍低 —— 量在、形状不像人。**继续按枚举对待。**')
  } else {
    line('  ⬜ **两条都没过：这个下载量是自动化枚举，不是用户。**')
    line('     不要把总下载量当采用度，也不要据此推论需求。')
    line('     ⇒ 下一步不是加功能，是「**触达**」（去官方 Discord / Discussions 说一次）。')
  }
  line()
  line('  对照：真包 latest 60–80% / 日覆盖 23–24 天；枚举 11–15% / 2–9 天。')
  line('  （口径与实测见 00_调研与规划/功能机会汇总-2026-09-23.md §一）')
}

main().catch((e) => {
  console.error(`\n❌ 复查脚本失败：${e && e.stack ? e.stack : e}`)
  process.exitCode = 1
})

/**
 * Knit · **清洁间闸门**（发版前必跑）：真 `npm pack` → 解到临时目录 → 在解包目录里跑 `npm test`。
 *
 * ── 为什么要有这一个 ──────────────────────────────────
 *
 * v0.20.0 的包装缺陷是**发完之后**才发现的：registry 上那份 tarball 里 `npm test`
 * 是 638 pass / 1 fail —— `test/deep-scale.test.mjs` 从 `../tools/deep-benchmark.mjs`
 * 取语料工厂，而 `tools/` 不在 `package.json` 的 `files` 白名单里。
 * 发布清单只在发完之后查，太晚。仓库里全绿不能说明任何事：**仓库里有 tools/**。
 *
 * 这个脚本把「发出去的那份东西」真的装一遍再跑测试，装不上就地红。
 * 零依赖（只用 Node 标准库 + `npm` / `tar`），不改任何文件、不发任何网络请求。
 *
 * ── 判据 ─────────────────────────────────────────────
 *
 *   ① `npm pack` 成功，且包里**没有** `tools/`（白名单里那两个脚本除外 —— `tools/` 不是
 *      发布物，这是不变式，不是配置细节）；
 *   ② 解包目录里 `npm test` 的 `fail` 为 0。
 *
 * 任一条不成立 ⇒ 退出码 1，并打出失败摘要。
 *
 * 用法：`node tools/clean-room-test.mjs`
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = join(dirname(fileURLToPath(import.meta.url)), '..')
const tmp = mkdtempSync(join(tmpdir(), 'knit-cleanroom-'))
/** 自带 npm 缓存：不去碰用户那个 `~/.npm`（有的机器上是 root 所有，会 EPERM），也顺带更「清洁」。 */
const cache = join(tmp, 'npm-cache')

/** 跑一条命令，把 stdout / stderr 收成字符串；不抛，失败也拿得到输出。 */
function run(cmd, args, cwd) {
  try {
    return { code: 0, out: execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 128 * 1024 * 1024 }) }
  } catch (e) {
    return { code: typeof e.status === 'number' ? e.status : -1, out: `${e.stdout || ''}${e.stderr || ''}` }
  }
}

/** 从 `node --test` 的两种报告器里取计数（spec 是 `ℹ pass 662`，TAP 是 `# pass 662`）。 */
function count(out, label) {
  const m = out.match(new RegExp(`^\\s*(?:[ℹ#]\\s*)?${label}\\s+(\\d+)\\s*$`, 'm'))
  return m ? Number(m[1]) : null
}

const fail = (msg, detail) => {
  console.error(`\n✗ ${msg}`)
  if (detail) console.error(detail.split('\n').slice(-30).join('\n'))
  process.exitCode = 1
}

try {
  console.log('Knit 清洁间闸门（发版前必跑）\n')

  const pack = run('npm', ['pack', '--cache', cache, '--pack-destination', tmp], repo)
  if (pack.code !== 0) { fail('npm pack 失败', pack.out); } else {
    const tgz = pack.out.trim().split('\n').pop().trim()
    const entries = run('tar', ['-tzf', join(tmp, tgz)])
    const list = entries.out.split('\n').filter(Boolean)
    const tools = list.filter((e) => e.startsWith('package/tools/')).map((e) => e.replace('package/', ''))
    const allowed = ['tools/json-schema-subset.mjs', 'tools/context-feedback-eval.mjs']
    const leaked = tools.filter((t) => !allowed.includes(t))
    console.log(`  打包      ${tgz} · ${list.length} 个文件`)
    console.log(`  tools/    ${tools.length ? tools.join(', ') : '(无)'}${leaked.length ? '  ← 漏了 ' + leaked.join(', ') : ' ✓ 只有白名单里那两个'}`)

    const untar = run('tar', ['-xzf', join(tmp, tgz), '-C', tmp])
    if (untar.code !== 0) fail('解包失败', untar.out)
    else {
      const dir = join(tmp, 'package')
      const res = run('npm', ['test', '--cache', cache], dir)
      const pass = count(res.out, 'pass')
      const failed = count(res.out, 'fail')
      console.log(`  解包到    ${dir}`)
      console.log(`  npm test  pass=${pass === null ? '?' : pass} fail=${failed === null ? '?' : failed}（退出码 ${res.code}）`)

      if (leaked.length) fail(`tools/ 漏进包里：${leaked.join(', ')}`)
      if (failed === null) fail('在解包目录里没读到 npm test 的计数 —— 测试根本没跑起来', res.out)
      else if (failed !== 0 || res.code !== 0) fail(`解包目录里 npm test 有 ${failed} 条失败 ⇒ 这份包不能发`, res.out)
      else console.log(`\n✓ 解包目录里 ${pass} 条全绿 —— 这份包可以发`)
    }
  }
} finally {
  rmSync(tmp, { recursive: true, force: true })
}

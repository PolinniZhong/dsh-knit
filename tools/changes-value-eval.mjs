/**
 * **Git 变更关联 · 真实任务量尺**（v0.25 的下一阶段：量「值」，不是量「机制」）。
 *
 * 它回答一个**只能由真实历史回答**的问题：
 *
 *   > 开发者改了一处代码，Knit 的变更关联牵出来的那些**测试 / 文档**里，
 *   > 有多少是这次改动**当时没一起改、后来又被补上**的？
 *
 * 为什么用「后来又被补上」当判据：`git` 里只有事实，没有意图。一次提交没带某个测试，
 * 可能是「不知道要改它」，也可能是「知道但这次不改」。**后续提交把它们一起改了**
 * 是能把它区分开的唯一客观证据 —— 那说明它当时确实已经过期/该改。
 * 所以本量尺**不采信任何主观标注**，也不构造语料：它回放真实提交，用真实历史当答案。
 *
 * ## 做法（对每个提交）
 *
 * ```
 * ① 一个临时克隆（对被测仓库**只读**：clone 只读源，之后所有写都在 /tmp 里）
 * ② checkout <commit>^ → cherry-pick -n <commit>     ⇒ 工作区 = 父提交 + 这次改动（未提交）
 * ③ scan() + changesPayload()                        ⇒ 与面板/接口**同一份实现**（不重写算法）
 * ④ 对每条关联：目标在这次提交里吗？
 *       · 在   ⇒ 「没漏」（开发者当时就动了它）
 *       · 不在 ⇒ 候选漏项，再看**后续 K 个提交**里有没有「它和本次改动的文件一起被改」⇒ 实证漏项
 * ⑤ reset --hard + clean，下一个提交
 * ```
 *
 * ## 怎么读输出
 *
 *   · `实证漏项`（material）——**唯一能称作「值」的那个数**：目标不在本次提交里，
 *     但后续某次**聚焦提交**把它和本次改动的文件**一起**改了 ⇒ 当时漏了，且确实要改。
 *     ⚠️ 「聚焦」是必须的条件，不是修饰：`release:` 那种一次动 8–30 个文件的提交里，
 *     任何两篇都「同框」——松口径下几乎每条关联都能被说成「后来补上了」，那是假的
 *     （本工具的**松口径 vs 严格口径**对比会把这个差直接印出来）。
 *   · `候选漏项`（candidate）——不在本次提交里、但后续窗口内没被一起改：**不宣称是值**。
 *     它可能是「其实不用改」，也可能是「一直没补」。要下结论必须人工看具体用例。
 *   · `已带上`（accompanied）——目标本来就在本次提交里：计数用，不是值。
 *
 * ⚠️ 三条**不许越界**的话：
 *   1. 这是**回放**，不是「让开发者真的用一次」。它量的是「当时漏改、后来补上」的**事后**事实，
 *      不等于「当时提醒他就能省下那次返工」—— 后者要做前向实验，见 `--forward` 说明。
 *   2. 语料是「这一个仓库」。换仓库要显式 `--repo`，**不同仓库的结论不许相加**当总体结论。
 *   3. **不构造语料、不标注、不调参**。数字难看就难看。
 *
 * 用法：
 *   node tools/changes-value-eval.mjs --repo . --limit 40 --lookahead 40
 *   node tools/changes-value-eval.mjs --repo /path/to/other --limit 30 --json /tmp/out.json
 *
 * `tools/` 不进 npm 包（`package.json` 的 `files` 是逐条白名单），所以这个量尺不会污染语料。
 */

import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { scan, changesPayload, resetScanMemo, resetGitReaderCache } from '../src/host/index.js'
import { resetRelationCache } from '../src/host/relations.js'

/** git 一个命令的薄封装：argv 数组、不走 shell、输出按行切。 */
function git(repo, args, options = {}) {
  return execFileSync('git', ['-C', repo, ...args], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024, ...options,
  })
}

/** 提交清单（新→旧）。merge 提交没有「父提交 + 本次改动」这个形状，一律跳过。 */
function commitList(repo, limit) {
  const raw = git(repo, ['log', '--no-merges', `-n`, String(limit), '--format=%H%x1f%ct%x1f%s'])
  return raw.split('\n').filter(Boolean).map((line) => {
    const [sha, ct, subject] = line.split('\x1f')
    return { sha, at: Number(ct) * 1000, subject: subject || '' }
  })
}

/** 某个提交改了哪些文件（工作区相对路径，字典序）。 */
function filesOf(repo, sha) {
  const raw = git(repo, ['show', '--name-only', '--format=', sha])
  return raw.split('\n').map((s) => s.trim()).filter(Boolean).sort()
}

/**
 * 回放一次提交，拿到变更关联的结果。
 *
 * ⚠️ **三个缓存必须逐个清掉**，否则整个量尺会变成「所有提交都得到第一次那一份答案」：
 *   · `resetGitReaderCache()` —— git 状态缓存按 root 记 8 秒，而这里 root 是同一个克隆目录；
 *   · `resetScanMemo()`      —— 工作区扫描备忘也是同一个 root；
 *   · `resetRelationCache()` —— 关系事实表按候选集签名缓存（换个提交通常签名就变了，但别赌）。
 * 这三行是本工具成立的**前提**，不是保险。
 */
async function replayOnce(clone, sha) {
  // ⚠️ **根提交没有父提交**：`<sha>^` 会直接把 `checkout` 抛出来。这一句原来在 try 外面，
  // 在 Knit 自己的历史里从没炸过（近 40 个提交离根很远），一换仓库就会炸 —— 换仓库才暴露。
  try {
    git(clone, ['rev-parse', '--verify', '-q', `${sha}^`])
  } catch {
    return { skipped: true, why: '根提交（没有父提交，造不出「父提交 + 本次改动」）' }
  }
  try {
    git(clone, ['checkout', '-q', '--detach', `${sha}^`])
    git(clone, ['cherry-pick', '-n', sha])
  } catch (error) {
    // 冲突 / 空提交：如实跳过，不硬凑
    try { git(clone, ['cherry-pick', '--abort']) } catch { /* 没有可中止的就继续 */ }
    try { git(clone, ['reset', '-q', '--hard']) } catch { /* 同上 */ }
    return { skipped: true, why: String((error && error.stderr) || (error && error.message) || error).split('\n')[0].slice(0, 120) }
  }
  resetGitReaderCache()
  resetScanMemo()
  resetRelationCache()
  // 会话替身只为了 `scan()` 的签名；变更关联**不使用名次**（它固定吃不分档语料），
  // 所以这里给一个固定任务串 —— 不拿提交信息去诱导排序，也不假装那是「用户的原话」。
  const session = {
    header: { cwd: clone, id: 'value-eval' },
    snapshotEvents: () => [],
  }
  const payload = await scan(clone, 40, { session, sessionId: 'value-eval-1', sort: 'relevance', kind: 'context' })
  const result = await changesPayload(clone, { corpus: payload.contextCorpus })
  git(clone, ['reset', '-q', '--hard'])
  git(clone, ['clean', '-fdq'])
  return { skipped: false, payload: result }
}

/** 主流程。 */
export async function runValueEval({ repo, limit = 40, lookahead = 40, maxFix = 4 } = {}) {
  const source = resolve(repo || '.')
  const head = git(source, ['rev-parse', '--short', 'HEAD']).trim()
  // 多取 lookahead 个提交，好让**最新**的那些也有「后续」可看
  const all = commitList(source, limit + lookahead)
  const analyzed = all.slice(0, limit)
  // 每个提交改了什么（一次算好，后面查「后续提交」反复用）
  const filesBySha = new Map(all.map((c) => [c.sha, filesOf(source, c.sha)]))
  const indexOf = new Map(all.map((c, i) => [c.sha, i]))   // 0 = 最新

  const clone = mkdtempSync(join(tmpdir(), 'knit-value-'))
  const records = []
  try {
    git(clone, ['clone', '--quiet', '--no-hardlinks', source, clone], { stdio: ['ignore', 'ignore', 'pipe'] })
    for (const commit of analyzed) {
      const touched = filesBySha.get(commit.sha) || []
      const replayed = await replayOnce(clone, commit.sha)
      if (replayed.skipped) {
        records.push({ sha: commit.sha.slice(0, 8), subject: commit.subject, touched: touched.length, skipped: replayed.why })
        continue
      }
      const result = replayed.payload
      const i = indexOf.get(commit.sha)
      const laterWindow = all.slice(Math.max(0, i - lookahead), i)   // 新→旧，索引更小 = 更晚
      const touchedSet = new Set(touched)

      const links = result.links.map((link) => {
        const target = link.target
        const inCommit = touchedSet.has(target)
        // 「后来被和本次改动的文件**一起**改了」= 实证漏项。
        // ⚠️ 两个口径都算：`loose` 是「只要同框」，`strict` 额外要求那个后来的提交**是聚焦的**
        // （文件数 ≤ maxFix）。松口径几乎恒真（release 提交一次动 8 个文件），只配当对照。
        let materialAt = null
        let looseAt = null
        let soloAt = null
        for (const later of laterWindow) {
          const f = filesBySha.get(later.sha) || []
          if (!f.includes(target)) continue
          if (f.some((x) => touchedSet.has(x))) {
            if (!looseAt) looseAt = `${later.sha.slice(0, 8)}(${f.length})`
            // 强证据：后来的**聚焦提交**把目标和本次改动的文件一起补上了
            if (f.length <= maxFix && !materialAt) materialAt = later.sha.slice(0, 8)
          } else if (f.length === 1 && !soloAt) {
            // 弱证据：后来有一次提交**只**改了这一篇（`94b3cb6` 那种「补上漏更」的形态）。
            // ⚠️ 它比强证据弱：单独改一篇也可能与此无关。所以两层分开报，不合并成一个数。
            soloAt = later.sha.slice(0, 8)
          }
        }
        const isTestDoc = link.kind === 'md' || link.source === 'test'
        const types = [...new Set(link.evidence.map((e) => e.type))].sort()
        return {
          sha: commit.sha.slice(0, 8), subject: commit.subject,
          target, isTestDoc, inCommit, materialAt, soloAt, looseAt,
          types, evidence: link.evidence.length,
        }
      })

      records.push({
        sha: commit.sha.slice(0, 8),
        subject: commit.subject,
        touched: touched.length,
        gitAvailable: result.git.available,
        changedFiles: result.git.filesTotal,
        linksTotal: result.linksTotal,
        shown: links.length,
        links,
      })
    }
  } finally {
    rmSync(clone, { recursive: true, force: true })
    resetGitReaderCache()
    resetScanMemo()
    resetRelationCache()
  }

  // ── 汇总 ────────────────────────────────────────────────
  const ok = records.filter((r) => !r.skipped)
  const allLinks = ok.flatMap((r) => r.links || [])
  const testDoc = allLinks.filter((l) => l.isTestDoc)
  const material = testDoc.filter((l) => l.materialAt)
  const solo = testDoc.filter((l) => !l.materialAt && l.soloAt)
  const looseMaterial = testDoc.filter((l) => l.looseAt)
  const noEvidence = testDoc.filter((l) => !l.materialAt && !l.soloAt)
  const accompanied = testDoc.filter((l) => l.inCommit)
  return {
    repo: source,
    head,
    analyzed: analyzed.length,
    analyzedWithLinks: ok.filter((r) => (r.linksTotal || 0) > 0).length,
    skipped: records.filter((r) => r.skipped).length,
    lookahead,
    maxFix,
    totals: {
      links: allLinks.length,
      testDocLinks: testDoc.length,
      // ⚠️ 「本次就改了」这一格**恒为 0**，不是成绩：变更关联**结构上**就把变更文件自己
      // 排除在结果之外（`exclude = seeds`）。留这个字段是为了让读者看到那条性质。
      alreadyTouchedStructurally: 0,
      solo: solo.length,
      material: material.length,
      noEvidence: noEvidence.length,
      // 松口径永远 ≥ 严格口径；两个数一起给，读者自己看那个差有多大
      looseMaterial: looseMaterial.length,
    },
    materialCases: material,
    soloCases: solo,
    candidateCases: noEvidence,
    records,
  }
}

/**
 * **单提交模式**：只回放一个提交，把它的关联目标全列出来（含「本次是否已带上」）。
 * 用途是**人工核查具体案例** —— 比如某次提交后来被一次「补上漏更」的提交修过，
 * 就来这里看那次提交当时有没有把那一篇牵出来。可复现，不靠记忆。
 *
 * @param {{repo: string, sha: string}} options
 * @returns {Promise<object>} 该提交的完整关联清单
 */
export async function inspectCommit({ repo, sha }) {
  const source = resolve(repo || '.')
  const full = git(source, ['rev-parse', sha]).trim()
  const touched = filesOf(source, full)
  const clone = mkdtempSync(join(tmpdir(), 'knit-inspect-'))
  try {
    git(clone, ['clone', '--quiet', '--no-hardlinks', source, clone], { stdio: ['ignore', 'ignore', 'pipe'] })
    const replayed = await replayOnce(clone, full)
    if (replayed.skipped) return { sha: full.slice(0, 8), touched, skipped: replayed.why, links: [] }
    const touchedSet = new Set(touched)
    return {
      sha: full.slice(0, 8),
      subject: git(source, ['log', '-1', '--format=%s', full]).trim(),
      touched,
      gitFilesTotal: replayed.payload.git.filesTotal,
      links: replayed.payload.links.map((l) => ({
        target: l.target, kind: l.kind, source: l.source,
        inCommit: touchedSet.has(l.target),
        types: [...new Set(l.evidence.map((e) => e.type))].sort(),
        evidence: l.evidence,
      })),
    }
  } finally {
    rmSync(clone, { recursive: true, force: true })
    resetGitReaderCache(); resetScanMemo(); resetRelationCache()
  }
}

/** 文本报表（stdout 用）。 */
export function formatValueReport(summary) {
  const t = summary.totals
  const lines = []
  lines.push(`Git 变更关联 · 真实任务量尺 —— ${summary.repo}`)
  lines.push(`  回放提交 ${summary.analyzed} 个（HEAD ${summary.head}，后续窗口 ${summary.lookahead} 个提交）`)
  lines.push(`  其中牵出过关联的 ${summary.analyzedWithLinks} 个；跳过 ${summary.skipped} 个（冲突/空提交）`)
  lines.push('')
  lines.push(`  关联目标合计            ${t.links}（其中测试/文档 ${t.testDocLinks}）`)
  lines.push(`  （「本次就改了」那一格恒为 0：变更关联**结构上**排除了变更文件自己，不是成绩）`)
  lines.push(`  ├─ **实证漏项（严格）**  ${t.material}   ← 后续一次**聚焦提交**（≤ ${summary.maxFix} 个文件）把它和本次改动的文件一起补上了`)
  lines.push(`  │    （松口径 ${t.looseMaterial}：只要「同框」就算 —— 那个数是被 release 提交灌出来的，只作对照）`)
  lines.push(`  ├─ **弱证据：后来被单篇补上** ${t.solo}   ← 后来有一次提交**只**改了它（94b3cb6 那种「补上漏更」）`)
  lines.push(`  └─ 无证据                ${t.noEvidence}   ← 后续窗口内没有任何补改痕迹；不宣称是值，也不宣称是噪音`)
  lines.push('')
  if (summary.materialCases.length > 0) {
    lines.push('  实证漏项逐条（人工可核）：')
    const bySha = new Map()
    for (const item of summary.materialCases) {
      if (!bySha.has(item.sha)) bySha.set(item.sha, [])
      bySha.get(item.sha).push(item)
    }
    for (const [sha, items] of bySha) {
      lines.push(`    ${sha}  ${String(items[0].subject || '').slice(0, 58)}`)
      for (const item of items) {
        lines.push(`      → 当时没改 ${item.target}  [${item.types.join('+')}]  ⇒ 后来在 ${item.materialAt} 与本次改动的文件一起改了`)
      }
    }
  } else {
    lines.push('  实证漏项：0 条。')
  }
  if (summary.soloCases.length > 0) {
    lines.push('')
    lines.push('  弱证据逐条（后来被单篇提交补上）：')
    const seen = new Set()
    for (const item of summary.soloCases) {
      const key = `${item.sha}->${item.target}`
      if (seen.has(key)) continue
      seen.add(key)
      lines.push(`    ${item.sha}  当时没改 ${item.target}  [${item.types.join('+')}]  ⇒ 后来在 ${item.soloAt} 被单独改了`)
    }
  }
  lines.push('')
  lines.push('  ⚠️ 「实证漏项」= 事后事实（当时漏改、后来补上），不等于「当时提醒就能省下返工」。')
  lines.push('  ⚠️ 这只是一个仓库的数字，不许与别的仓库相加当总体结论。')
  return lines.join('\n')
}

/* ── CLI ───────────────────────────────────────────────── */
const invokedDirectly = process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())
if (invokedDirectly) {
  const argOf = (name, fallback) => {
    const i = process.argv.indexOf(`--${name}`)
    return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback
  }
  const repo = argOf('repo', '.')
  const one = argOf('commit', '')
  if (one) {
    const detail = await inspectCommit({ repo, sha: one })
    console.log(`单提交核查 ${detail.sha}  ${detail.subject || ''}`)
    console.log(`  本次改动 ${detail.touched.length} 个文件：${detail.touched.join(', ')}`)
    if (detail.skipped) console.log(`  ⚠️ 跳过：${detail.skipped}`)
    console.log(`  关联目标 ${detail.links.length} 个：`)
    for (const l of detail.links) {
      const mark = l.inCommit ? '（本次已带上）' : ''
      console.log(`    ${l.target.padEnd(34)} [${l.kind}/${l.source}] ${l.types.join('+')}${mark}`)
    }
    process.exit(0)
  }
  const limit = Number(argOf('limit', '40'))
  const lookahead = Number(argOf('lookahead', '40'))
  const json = argOf('json', '')
  const summary = await runValueEval({ repo, limit, lookahead })
  console.log(formatValueReport(summary))
  if (json) {
    writeFileSync(json, JSON.stringify(summary, null, 2))
    console.log(`\n  （完整记录已写入 ${json}）`)
  }
}

/**
 * **变更关联 · 前向对账**（给「真实任务」用的一条命令）。
 *
 * 它替你做前向实验里**唯一可以自动化**的那一步：把「你的预判」和「Knit 牵出来的」
 * 摆在一起，算出两个数。**唯一不能自动化的是第一步** —— 预判必须由**动手的人**先写下来，
 * 因为那是这个实验的盲测基线：先看答案再写预判，等于给自己打分。
 *
 * ## 用法（三步）
 *
 * ```sh
 * cd "/Users/zhongwentuo/DeepSeek Harness Native/08_Knit/knit"
 *
 * # ① 动手之前/之后、**打开面板之前**，写下你以为**还要一起改/一起看**的文件
 * #    ⚠️ 写的是「陪跑的」，**不是**「我正在改的」—— 变更文件自己永远不会出现在 Knit 的结果里
 * #    （它结构上把变更文件排除了：那是「起点」，不是「该一起看的东西」）。
 * echo "src/host/relations.js docs/git-aware-context.md" > /tmp/我的预判.txt
 *
 * # ② 做你的真实改动（正常写代码），然后跑这一条
 * node tools/changes-forward-check.mjs --repo "<你的仓库路径>" --guess /tmp/我的预判.txt
 *
 * # ③ 把最后那段「发回给我」原样贴回来（其中两行要你自己填）
 * ```
 *
 * ⚠️ 三点必须说在前面：
 *   1. **默认仓库是当前目录**；测别的项目就显式 `--repo`。
 *   2. 它用的是**产品自己的实现**（`scan()` + `changesPayload()`，与面板/接口同一份），
 *      所以它量到的就是面板会说的；它**不做**任何二次判断、不排序、不打分。
 *   3. 它**只读**：一条 `git status` + 一次工作区扫描，不写任何东西（不 add、不 commit）。
 *
 * `tools/` 不进 npm 包，所以这个量尺不会污染语料。
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'

import { scan, changesPayload, resetScanMemo, resetGitReaderCache } from '../src/host/index.js'
import { resetRelationCache } from '../src/host/relations.js'
import { createGitReader } from '../src/host/git.js'

/** 读预判文件：空格 / 换行 / 逗号都当分隔符；`#` 开头的行是注释。 */
function readGuess(path) {
  if (!path || !existsSync(path)) return null
  const text = readFileSync(path, 'utf8')
  const out = []
  const seen = new Set()
  for (const line of text.split('\n')) {
    if (line.trim().startsWith('#')) continue
    for (const token of line.split(/[\s,]+/)) {
      const rel = token.trim().replace(/^\.\//, '')
      if (!rel || seen.has(rel)) continue
      seen.add(rel)
      out.push(rel)
    }
  }
  return out
}

/**
 * 跑一次前向对账。
 *
 * @param {{repo: string, guessPath: string, only?: string[]}} options
 *   `only` = **只看这几个改动**（其余未提交改动一律忽略）。存在的理由很实在：
 *   工作区里常常还压着别的未提交工作（本仓库现在就压着 21 个），
 *   不隔离的话「你这一处改动」会被淹掉，对账根本读不出来。
 * @returns {Promise<object>} 对账结果（可 JSON 化）
 */
export async function forwardCheck({ repo, guessPath, only = [] }) {
  const root = resolve(repo || '.')
  // ⚠️ 两个缓存都要清：面板可能刚轮询过（8 秒同窗），不清就会拿到**上一次**的变更集，
  // 而这里量的是「我刚刚改完的这一刻」。
  resetGitReaderCache(); resetScanMemo(); resetRelationCache()
  const session = { header: { cwd: root, id: 'forward-check' }, snapshotEvents: () => [] }
  const payload = await scan(root, 40, { session, sessionId: 'forward-check-1', sort: 'relevance', kind: 'context' })
  // 变更集自己读一次（这样能拿到**完整**的 200 条上限，而不是下发的 30 条），再按 `--only` 收窄。
  const fullSet = await createGitReader({ now: () => Date.now() }).read(root)
  const onlySet = new Set((only || []).map((x) => String(x).replace(/^\.\//, '')))
  const changeSet = onlySet.size > 0
    ? { ...fullSet, files: fullSet.files.filter((f) => onlySet.has(f.rel)), filesTotal: fullSet.files.filter((f) => onlySet.has(f.rel)).length }
    : fullSet
  const result = await changesPayload(root, { corpus: payload.contextCorpus, changeSet })

  const guessRaw = readGuess(guessPath)
  const targets = result.links.map((l) => ({
    target: l.target,
    kind: l.kind,
    source: l.source,
    isTestDoc: l.kind === 'md' || l.source === 'test',
    types: [...new Set(l.evidence.map((e) => e.type))].sort(),
    from: [...new Set(l.evidence.map((e) => e.origin))].sort(),
    firstLine: (l.evidence.find((e) => Number.isInteger(e.line)) || {}).line ?? null,
  }))
  const targetSet = new Set(targets.map((t) => t.target))
  // ⚠️ 预判里若写了「我正在改的文件」，它**必然**不会出现在结果里（Knit 结构上排除变更文件）。
  // 不摘出去的话，它会被算成「Knit 没提」—— 那是拿一个它明确不回答的问题去扣它的分。
  const changedSet = new Set(result.git.files.map((f) => f.rel))
  const guessAll = guessRaw || []
  const guessSelf = guessAll.filter((rel) => changedSet.has(rel))
  const guess = guessAll.filter((rel) => !changedSet.has(rel))
  const guessSet = new Set(guess)

  return {
    root,
    at: new Date().toISOString(),
    only: [...onlySet],
    ignoredOtherChanges: onlySet.size > 0 ? Math.max(0, fullSet.filesTotal - changeSet.filesTotal) : 0,
    git: { available: result.git.available, reason: result.git.reason, filesTotal: result.git.filesTotal, files: result.git.files.map((f) => ({ rel: f.rel, kinds: f.kinds })) },
    guessProvided: guessRaw !== null,
    guess,
    // 预判里「本身就是变更文件」的那些：**不计入对账**（打印出来只是提醒你下次别写它们）
    guessSelf,
    links: targets,
    // 两个数（外加一个「你我都想到」）—— 实验要的就是它们
    agreed: targets.filter((t) => guessSet.has(t.target)).map((t) => t.target),
    knitExtra: targets.filter((t) => !guessSet.has(t.target)),
    guessNotMentioned: guess.filter((rel) => !targetSet.has(rel)),
  }
}

/** 人看的报表。最后那一段是**给你贴回给我**的。 */
export function formatForwardReport(r) {
  const L = []
  const pad = (s, n) => String(s).padEnd(n)
  L.push('变更关联 · 前向对账')
  L.push(`  仓库      ${r.root}`)
  L.push(`  时间      ${r.at}`)
  if (!r.git.available) {
    L.push(`  ⚠️ git 读不到：${r.git.reason} —— 这次不算数（先把仓库状态弄正常再测）`)
    return L.join('\n')
  }
  L.push(`  git       ${r.git.filesTotal} 个变更文件${r.only && r.only.length ? `（**只看** ${r.only.join(', ')}；工作区里另外 ${r.ignoredOtherChanges} 处未提交改动已忽略）` : ''}`)
  for (const f of r.git.files.slice(0, 12)) L.push(`              ${pad(f.kinds.join('+'), 20)} ${f.rel}`)
  if (r.git.filesTotal > 12) L.push(`              …另 ${r.git.filesTotal - 12} 个`)
  L.push('')
  if (!r.guessProvided) {
    L.push('  ⚠️ 没有读到你的预判文件 —— 这次只列出 Knit 牵出来的，**两个数算不出来**。')
    L.push('     正确姿势：动手前先 `echo "你以为要改的文件" > /tmp/我的预判.txt`。')
    L.push('')
  } else {
    L.push(`  你的预判  ${r.guess.length} 条（陪跑文件）：${r.guess.join(', ') || '（空）'}`)
    if (r.guessSelf.length > 0) {
      L.push(`            ⚠️ 另有 ${r.guessSelf.length} 条本身就是**你正在改的**文件，已摘出不计：${r.guessSelf.join(', ')}`)
      L.push('               （变更关联**结构上**不把变更文件当结果 —— 把它算成「它没提」是拿它不回答的问题扣分）')
    }
  }
  L.push(`  Knit 牵出 ${r.links.length} 条关联目标`)
  L.push('')

  L.push(`  ✅ 你我都想到（${r.agreed.length}）`)
  for (const t of r.agreed) L.push(`        ${t}`)
  L.push('')
  L.push(`  🔎 **Knit 多说**（${r.knitExtra.length}）  ← 实验要的第一个数`)
  if (r.knitExtra.length === 0) L.push('        （没有；说明这一轮它没多说什么）')
  for (const t of r.knitExtra) {
    const line = t.firstLine ? ` 第 ${t.firstLine} 行` : ' （文件名约定，无行号）'
    L.push(`        ${pad(t.target, 34)} [${t.types.join('+')} 起点 ${t.from.join('/')}${line}]${t.isTestDoc ? '  ← 测试/文档' : ''}`)
  }
  L.push('')
  L.push(`  ❓ **你预判了、Knit 没提**（${r.guessNotMentioned.length}）  ← 不一定是它漏，也可能是你多虑`)
  for (const t of r.guessNotMentioned) L.push(`        ${t}`)
  L.push('')

  L.push('--- 把下面这段发回给我（最后两行要你自己填）---')
  L.push(`仓库: ${r.root}`)
  L.push(`变更文件数: ${r.git.filesTotal}`)
  L.push(`我的预判: ${r.guess.length} 条（另有 ${r.guessSelf.length} 条是变更文件本身，已摘出）`)
  L.push(`Knit 牵出: ${r.links.length} 条`)
  L.push(`你我都想到: ${r.agreed.length}`)
  L.push(`Knit 多说: ${r.knitExtra.length}`)
  L.push(`我预判了但它没提: ${r.guessNotMentioned.length}`)
  L.push('其中「我确实该改却没想到」的: ___')
  L.push('其中「其实无关」的: ___')
  return L.join('\n')
}

/* ── CLI ───────────────────────────────────────────────── */
const invokedDirectly = process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())
if (invokedDirectly) {
  const argOf = (name, fallback) => {
    const i = process.argv.indexOf(`--${name}`)
    return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback
  }
  const repo = argOf('repo', '.')
  const guessPath = argOf('guess', '/tmp/我的预判.txt')
  const json = argOf('json', '')
  // `--only a.md --only b.md` 或 `--only "a.md b.md"` 都收
  const only = []
  for (let i = 0; i < process.argv.length; i++) {
    if (process.argv[i] !== '--only' || !process.argv[i + 1]) continue
    for (const token of String(process.argv[i + 1]).split(/[\s,]+/)) if (token.trim()) only.push(token.trim())
  }
  const result = await forwardCheck({ repo, guessPath, only })
  console.log(formatForwardReport(result))
  if (json) {
    writeFileSync(json, JSON.stringify(result, null, 2))
    console.log(`\n（记录已写入 ${json}）`)
  }
}

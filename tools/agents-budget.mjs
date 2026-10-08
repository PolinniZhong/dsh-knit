#!/usr/bin/env node
/**
 * Knit · 指令文件预算闸门 + 指令载荷自检（v0.20 分层改造的配套工具）
 *
 * 为什么需要它：DSH 会把「项目根 → 会话工作目录」每一层的 AGENTS.md 串成**一条指令链**，
 * 每轮都注入，链上总量受宿主 `maxBytes = 65536` 约束 —— 超了宿主会**先整体丢弃较宽泛的文件**
 * （也就是 `08_Knit/AGENTS.md` 先消失）、再**按字节前缀截断**最具体的那一个
 * （`dsh-agent-instructions/lib/index.js` 的 `truncateUtf8()` 不认 Markdown 结构，会切在半截
 * 标题 / 规则上），并输出 `Workspace instruction budget …`。这不是「最好别超」，是**超了会静默变样**。
 *
 * 因此本仓库把预算写成分层闸门：
 *   L0 `08_Knit/AGENTS.md`  ≤ 16 KiB（每一轮都在）+ 净零规则（加内容必须同量删）
 *   L1 `knit/AGENTS.md`     ≤ 40 KiB（碰过 knit/ 文件后按需注入）
 *   合计                    ≤ 56 KiB（给宿主的 65536 B 硬上限留 ≈9 KiB 余量：
 *                            还会有别的指令文件 / overlay 进来，例如 `AGENTS.local.md`）
 *
 * 报告里额外给三样东西（2026-10-07 加，形态参考 DSH 的 ContextBudgetReport 与 provenance）：
 *   · 每层的 sha256 + mtime —— 出了事能证明「agent 那一轮看到的就是这些字节」
 *   · 每层占比、省略量（恒 0：本方案从不省略，超限直接红，绝不让 agent 收到半份规则）
 *   · 余量预警（低于 `FLOOR` 打黄灯；只有 `--strict` 才致命）
 * `--claims` 再从**代码侧**反查状态类断言（真源 = `knit/package.json`），防文档漂移。
 *
 * 零依赖、零网络、只读。用法：
 *   node knit/tools/agents-budget.mjs            # 人读
 *   node knit/tools/agents-budget.mjs --json     # 机器读（含 sha256 / mtime / 占比）
 *   node knit/tools/agents-budget.mjs --claims   # 状态类断言：版本 / 测试文件数 / 测试数自洽
 *   node knit/tools/agents-budget.mjs --strict   # 余量预警也当红
 * 超阈值 ⇒ 退出码 1，并指出超了多少字节。
 *
 * ⚠️ 本文件**不进 npm 包**（`files` 白名单逐个列举 `tools/` 下的文件，没有它）。
 */
import { createHash } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, relative } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const WORKSPACE = join(HERE, '..', '..')

export const LIMITS = {
  l0: 16 * 1024, // 常驻层：每一轮都注入
  l1: 40 * 1024, // 作用域层：碰过 knit/ 下文件后注入
  sum: 56 * 1024, // 两层合计（宿主硬上限 65536，留余量）
  host: 64 * 1024, // 宿主 maxBytes，只用于报告余量，不作为闸门
}

/** 余量预警线（B）：低于它打黄灯；加 `--strict` 才当成红。 */
export const FLOOR = { l0: 512, l1: 2 * 1024, sum: 4 * 1024 }

export const FILES = {
  l0: join(WORKSPACE, 'AGENTS.md'),
  l1: join(WORKSPACE, 'knit', 'AGENTS.md'),
}

const MANIFEST = join(WORKSPACE, 'knit', 'package.json')
const LABEL = { l0: '常驻层', l1: '作用域层', sum: '两层合计' }

const textOf = (path) => {
  try {
    return readFileSync(path, 'utf8')
  } catch (err) {
    if (err && err.code === 'ENOENT') return null
    throw err
  }
}

const layerOf = (key) => {
  const path = FILES[key]
  const text = textOf(path)
  return {
    key,
    path,
    rel: relative(WORKSPACE, path),
    bytes: text === null ? null : Buffer.byteLength(text, 'utf8'),
    sha256: text === null ? null : createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16),
    mtime: text === null ? null : statSync(path).mtime.toISOString(),
  }
}

const kib = (n) => (n / 1024).toFixed(2) + ' KiB'
const pct = (n, base) => (base ? ((n / base) * 100).toFixed(1) + '%' : '—')

export function measure() {
  const layers = { l0: layerOf('l0'), l1: layerOf('l1') }
  const l0 = layers.l0.bytes
  const l1 = layers.l1.bytes
  const sum = (l0 || 0) + (l1 || 0)
  const headroom = {
    l0: l0 === null ? null : LIMITS.l0 - l0,
    l1: l1 === null ? null : LIMITS.l1 - l1,
    sum: LIMITS.sum - sum,
  }
  const warn = Object.keys(LABEL)
    .filter((key) => headroom[key] !== null && headroom[key] < FLOOR[key])
    .map((key) => `${LABEL[key]}余量 ${kib(headroom[key])} < ${kib(FLOOR[key])}`)
  return {
    l0,
    l1,
    sum,
    layers,
    limits: LIMITS,
    floor: FLOOR,
    headroom,
    headroomToHost: LIMITS.host - sum,
    share: { l0: pct(l0, LIMITS.l0), l1: pct(l1, LIMITS.l1), sum: pct(sum, LIMITS.sum) },
    omittedBytes: 0,
    warn,
    over: {
      l0: l0 === null ? null : Math.max(0, l0 - LIMITS.l0),
      l1: l1 === null ? null : Math.max(0, l1 - LIMITS.l1),
      sum: Math.max(0, sum - LIMITS.sum),
    },
  }
}

/**
 * 状态类断言：拿 `knit/package.json` 当唯一真源，反查**注入载荷**里有没有漂移。
 * 只查能确定性推导的三件事，宁可少查也不猜 —— 历史数字满仓库都是（517/517、532/532…），
 * 模糊扫描只会误报，所以只扫 L0/L1 这两份「不许出现历史」的文件。
 */
export function claims(expectTests) {
  const manifest = JSON.parse(textOf(MANIFEST) || '{}')
  const docs = { l0: textOf(FILES.l0) || '', l1: textOf(FILES.l1) || '' }
  const listed = String((manifest.scripts || {}).test || '').match(/test\/[\w./-]+\.mjs/g) || []
  const findings = []
  const claimed = (text, re) => (text.match(re) || [])[1] || null

  const version = claimed(docs.l0, /插件包版本[^\n]*?(\d+\.\d+\.\d+)/)
  if (version !== manifest.version) findings.push(`版本漂移：L0 §1 写 ${version || '（没写）'}，knit/package.json 是 ${manifest.version}`)

  const testFiles = {}
  for (const key of ['l0', 'l1']) {
    const n = claimed(docs[key], /(\d+)\s*个测试文件/)
    if (n === null) continue
    testFiles[key] = Number(n)
    if (Number(n) !== listed.length) findings.push(`${FILES[key]} 写 ${n} 个测试文件，knit/package.json 的 scripts.test 列了 ${listed.length} 个`)
  }

  const counts = []
  for (const key of ['l0', 'l1']) {
    // 只认两位以上的 N/N：`aspect-ratio:1/1` 这类 CSS 字面量不是测试数（真报过一次）。
    for (const m of docs[key].matchAll(/(\d{2,4})\s*\/\s*(\d{2,4})/g)) if (m[1] === m[2]) counts.push(Number(m[1]))
  }
  const uniq = [...new Set(counts)]
  if (uniq.length > 1) findings.push(`注入载荷里出现了多个测试数：${uniq.join(' / ')}`)
  const testCount = uniq.length === 1 ? uniq[0] : null
  if (expectTests && testCount !== expectTests) findings.push(`测试数漂移：注入载荷写 ${testCount}，--tests 传的是 ${expectTests}`)

  return { ok: findings.length === 0, version, manifestVersion: manifest.version, testFiles, listedTestFiles: listed.length, testCount, counts: counts.length, expectTests: expectTests || null, findings }
}

function main() {
  const m = measure()
  const wantClaims = process.argv.includes('--claims')
  const strict = process.argv.includes('--strict')
  const asJson = process.argv.includes('--json')
  const expectTests = Number((process.argv.find((a) => a.startsWith('--tests=')) || '').split('=')[1]) || undefined
  const c = wantClaims ? claims(expectTests) : null

  if (asJson) {
    console.log(JSON.stringify({ ...m, files: FILES, rel: { l0: m.layers.l0.rel, l1: m.layers.l1.rel }, ...(c ? { claims: c } : {}) }, null, 2))
  } else {
    console.log('Knit 指令文件预算（分层闸门）')
    console.log('  ' + m.layers.l0.rel.padEnd(18) + (m.l0 === null ? '缺失' : kib(m.l0) + '  / 上限 ' + kib(LIMITS.l0) + '（占 ' + m.share.l0 + '）'))
    console.log('  ' + m.layers.l1.rel.padEnd(18) + (m.l1 === null ? '缺失' : kib(m.l1) + '  / 上限 ' + kib(LIMITS.l1) + '（占 ' + m.share.l1 + '）'))
    console.log('  合计              ' + kib(m.sum) + '  / 上限 ' + kib(LIMITS.sum) + '（占 ' + m.share.sum + '；宿主硬上限 ' + kib(LIMITS.host) + ' ⇒ 余量 ' + kib(m.headroomToHost) + '）')
    console.log('  省略（omitted）    ' + m.omittedBytes + ' B —— 本方案从不省略：两份都完整注入，超限直接红，绝不让 agent 收到半份规则')
    for (const key of ['l0', 'l1']) {
      const L = m.layers[key]
      if (L.bytes !== null) console.log('  载荷指纹 · ' + L.rel.padEnd(14) + ' sha256 ' + L.sha256 + '  mtime ' + L.mtime)
    }
    if (m.l0 === null) console.log('  ⚠️ 常驻层缺失：DSH 的指令链里就没有它了（路径或文件名被改过？）')
    if (m.l1 === null) console.log('  ⚠️ 作用域层缺失：碰过 knit/ 下文件后也不会有代码级纪律')
    if (c) {
      console.log('')
      console.log('  状态类断言（真源 = knit/package.json）')
      console.log('  ' + (c.version === c.manifestVersion ? '✓' : '✗') + ' 版本 ' + c.manifestVersion + '（L0 §1 写 ' + (c.version || '（没写）') + '）')
      console.log('  ' + (c.listedTestFiles === c.testFiles.l0 ? '✓' : '✗') + ' 测试文件数 ' + c.listedTestFiles + '（L0 写 ' + (c.testFiles.l0 === undefined ? '（没写）' : c.testFiles.l0) + '）')
      console.log('  ' + (c.testCount !== null ? '✓' : '✗') + ' 测试数 ' + (c.testCount === null ? '（载荷里没有 N/N 或存在多个）' : c.testCount + '（' + c.counts + ' 处 N/N 自洽）'))
      for (const f of c.findings) console.log('  ✗ ' + f)
    }
    if (m.warn.length) for (const w of m.warn) console.log('  ⚠️ 余量预警（--strict 会红）：' + w)
  }

  const bad = []
  if (m.over.l0) bad.push('常驻层超 ' + m.over.l0 + ' B')
  if (m.over.l1) bad.push('作用域层超 ' + m.over.l1 + ' B')
  if (m.over.sum) bad.push('两层合计超 ' + m.over.sum + ' B')
  if (bad.length) {
    console.error('✗ 指令文件预算超阈值：' + bad.join('；'))
    console.error('  先过「准入三问」，再按净零规则删等量旧内容（或把细节下移到 L2/L3）。')
    process.exit(1)
  }
  if (strict && m.warn.length) {
    console.error('✗ 余量预警（--strict）：' + m.warn.join('；'))
    process.exit(1)
  }
  if (c && !c.ok) {
    console.error('✗ 状态类断言不通过：' + c.findings.join('；'))
    process.exit(1)
  }
  if (!asJson) console.log('✓ 预算内')
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main()

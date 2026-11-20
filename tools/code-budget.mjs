#!/usr/bin/env node
/**
 * Knit · **代码体量预算**（治理用，不随 npm 包发布）。
 *
 * 这个脚本只回答三件事：
 *   1. `src/` 每个文件多少行、总量多少行；
 *   2. 几个**已知大文件**是否超过约定上限（超了就红，要求先拆 / 先删再合）；
 *   3. 测试文件多少行、多少条 —— **条数只报数，不设上限**。
 *      「927 条」不是坏味道：当前 927 条跑完约 3.7 s，平均 ~25 行源码一条；
 *      真正该盯的是大文件与功能重复，而不是把测试删到某个数字。
 *
 * 跑法：`node tools/code-budget.mjs`（npm run budget:code）。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('../', import.meta.url))
const LIMITS = {
  'src/host/index.js': 3_700,
  'src/host/feedback.js': 1_120,
  srcTotal: 20_200,
  testTotal: 26_000,
  clientPart: 3_500,
}

/** 递归列出某个目录下的 .js / .mjs 文件。 */
function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
    const abs = join(dir, entry.name)
    if (entry.isDirectory()) walk(abs, out)
    else if (/\.(m?js)$/.test(entry.name)) out.push(abs)
  }
  return out
}

const GENERATED = join(ROOT, 'src', 'client', 'client.js')
const srcFiles = walk(join(ROOT, 'src')).filter((abs) => abs !== GENERATED).map((abs) => ({ rel: relative(ROOT, abs), lines: statSync(abs).size ? readFileSync(abs, 'utf8').split('\n').length : 0 }))
const clientParts = walk(join(ROOT, 'tools', 'client-src')).map((abs) => ({ rel: relative(ROOT, abs), lines: readFileSync(abs, 'utf8').split('\n').length }))
const testFiles = walk(join(ROOT, 'test')).filter((abs) => abs.endsWith('.test.mjs') || abs.endsWith('.mjs'))
const testStats = testFiles.map((abs) => {
  const text = readFileSync(abs, 'utf8')
  return { rel: relative(ROOT, abs), lines: text.split('\n').length, tests: (text.match(/^test\(/gm) || []).length }
})
const srcTotal = srcFiles.reduce((n, f) => n + f.lines, 0) + clientParts.reduce((n, f) => n + f.lines, 0)
const generatedLines = readFileSync(GENERATED, 'utf8').split('\n').length
const testTotal = testStats.reduce((n, f) => n + f.lines, 0)
const testCount = testStats.reduce((n, f) => n + f.tests, 0)
const byRel = new Map(srcFiles.map((f) => [f.rel, f.lines]))

const checks = [
  ...Object.entries(LIMITS).filter(([key]) => key.includes('/')).map(([key, max]) => ({ key, actual: byRel.get(key) || 0, max })),
  { key: 'srcTotal', actual: srcTotal, max: LIMITS.srcTotal },
  { key: 'testTotal', actual: testTotal, max: LIMITS.testTotal },
  ...clientParts.map((part) => ({ key: part.rel, actual: part.lines, max: LIMITS.clientPart })),
]
const failed = checks.filter((c) => c.actual > c.max)

console.log('Knit 代码预算')
console.log('')
console.log('== 源码最大文件（不含生成物）==')
for (const file of [...srcFiles, ...clientParts].sort((a, b) => b.lines - a.lines).slice(0, 10)) {
  console.log(`  ${String(file.lines).padStart(6)}  ${file.rel}`)
}
console.log(`  ${String(generatedLines).padStart(6)}  src/client/client.js（生成物，不手改）`)
console.log('')
console.log('== 预算 ==')
for (const check of checks) {
  const mark = check.actual > check.max ? '✗' : '✓'
  console.log(`  ${mark} ${check.key.padEnd(26)} ${String(check.actual).padStart(6)} / ${check.max}`)
}
console.log('')
console.log(`测试：顶层 test() ${testCount} 条 · ${testStats.length} 个文件 · ${testTotal} 行（node 报告 927 条含子测试；条数只报数，不设上限）`)
console.log('')
if (failed.length) {
  console.error(`✗ ${failed.length} 处超过预算。先拆分 / 去重 / 删除，再调高上限；不要直接改预算。`)
  process.exitCode = 1
} else {
  console.log('✓ 预算内。新增功能请优先复用现有层，不要继续把 client.js 养成单文件巨兽。')
}

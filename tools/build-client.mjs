#!/usr/bin/env node
/**
 * Knit · 客户端拼接构建（**无 bundler**）。
 *
 * DSH 的 `DshClientManifest` 只有一个 `client` 入口，`__ModuleLoader__.load` 只注册
 * 一个 factory —— 所以浏览器里仍然是**单文件**。这里只做一件事：把
 * `tools/client-src/*.js` 按文件名顺序拼成 `src/client/client.js`（它们共享同一个
 * 工厂作用域，拼接后语义不变）。
 *
 * 跑法：
 *   node tools/build-client.mjs           写生成文件
 *   node tools/build-client.mjs --check   只校验是否同步（CI / 提交前）
 *
 * ⚠️ 不要直接改 `src/client/client.js`：它是生成物。改 `tools/client-src/` 后重新 build。
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('../', import.meta.url))
const SRC = join(ROOT, 'tools', 'client-src')
const OUT = join(ROOT, 'src', 'client', 'client.js')

const parts = readdirSync(SRC).filter((name) => name.endsWith('.js')).sort()
if (parts.length === 0) {
  console.error('✗ tools/client-src/ 里没有分片')
  process.exit(1)
}
const output = parts.map((name) => readFileSync(join(SRC, name), 'utf8')).join('')
const current = readFileSync(OUT, 'utf8')
const check = process.argv.includes('--check')

if (check) {
  if (current !== output) {
    console.error(`✗ src/client/client.js 与分片不同步（${parts.length} 片）。请跑：npm run build:client`)
    process.exit(1)
  }
  console.log(`✓ 客户端生成文件与 ${parts.length} 个分片同步`)
} else {
  writeFileSync(OUT, output)
  console.log(`✓ 已生成 src/client/client.js（${parts.length} 片，${output.split('\n').length} 行）`)
}

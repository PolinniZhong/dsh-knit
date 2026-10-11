/**
 * Knit · **增量索引的持久层**（v0.22）的测试
 *
 * 这一层只回答一个问题：**「重启之后还能不能凭证据相信盘上那份索引」**。
 * 所以断言分成三组，分别对应模块头注释里的三条硬约束：
 *   · 不存正文 —— 记录形状里不许出现 `body`；
 *   · 按 canonical root 隔离 —— 同一个 `rel` 在两个工作区之间不许串；
 *   · 任何失败都不许抛进检索路径 —— 没有存储、开不起来、介质损坏一律空 Map。
 *
 * 「重启」的测法与 `control.test.mjs` 一致：**同一份介质 + 一个全新的后端**。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  INDEX_CLEAN_PER_WRITE, INDEX_TABLES, INDEX_UNIT, INDEX_VERSION,
  canonicalRoot, createIndexStore, headHashOf, keyToRel, recordKey, recordMatches, refsShapeOk, relToKey,
} from '../src/host/index-store.js'
import { fakeStorageBackend } from './fixture.mjs'

/* ── 工具 ─────────────────────────────────────────────── */

/** 假存储后端（与 `control.test.mjs` 同一个形状，放在 `fixture.mjs` 里共用）。 */
const fakeBackend = fakeStorageBackend

/** 造一条合法记录。 */
const recordOf = (rel, extra = {}) => ({
  root: '/w', rel, mtimeMs: 1000, size: 12, headHash: headHashOf(`# ${rel}`),
  title: rel, summary: '', refs: { md: [], any: [] }, ...extra,
})

/** 建一个临时目录（进程退出时清理）。 */
const dirs = []
function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'knit-index-store-'))
  dirs.push(dir)
  return dir
}
process.on('exit', () => {
  for (const dir of dirs) {
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* 清理失败不影响结论 */ }
  }
})

/* ── 1 · 键与指纹：纯函数，先钉死 ─────────────────────── */

test('relToKey：per-record 布局的键必须匹配 `[a-zA-Z0-9_-]+`，中文/斜杠/点都活得下来', () => {
  const rels = [
    'README.md', 'docs/notes.md', 'a b c/d.e.md',
    '文档/中文 名称.md', 'x/y/z/deep/file-1_2.md', '',
  ]
  for (const rel of rels) {
    const key = relToKey(rel)
    assert.match(key, /^[a-zA-Z0-9_-]*$/, `键 ${key} 不是安全的路径片段`)
  }
  // 同一个 rel 一定映射到同一个键（索引靠它做身份）
  assert.equal(relToKey('a/b.md'), relToKey('a/b.md'))
  assert.notEqual(relToKey('a/b.md'), relToKey('a/b.md/'))
})

test('recordKey：同一个 rel 在不同工作区必须是不同的键（否则互相覆盖）', () => {
  const a = recordKey('/w/one', 'docs/a.md')
  const b = recordKey('/w/two', 'docs/a.md')
  assert.notEqual(a, b, '两个工作区的同名文件不能共用一个键')
  assert.equal(a, recordKey('/w/one', 'docs/a.md'), '同一个输入必须给同一个键')
  assert.match(a, /^[a-zA-Z0-9_-]+$/, 'per-record 布局的键必须是安全路径片段')
  assert.equal(keyToRel(a), 'docs/a.md', '定长 root 指纹 ⇒ 无歧义还原')
  assert.equal(keyToRel(b), 'docs/a.md')
  // 键的长度随 rel 增长，前缀恒为 16 个 hex
  assert.match(a.slice(0, 16), /^[0-9a-f]{16}$/)
  // 还原：各种棘手的 rel 都要能原样取回来
  for (const rel of ['README.md', 'a b c/d.e.md', '文档/中文 名称.md', 'x/y/z/deep/file-1_2.md', '']) {
    assert.equal(keyToRel(recordKey('/w', rel)), rel, `rel=${rel} 必须能还原`)
  }
})

test('headHashOf：16 个 hex、确定、内容不同则不同', () => {
  const a = headHashOf('# 标题\n\n正文')
  assert.match(a, /^[0-9a-f]{16}$/)
  assert.equal(a, headHashOf('# 标题\n\n正文'), '同样的输入必须给同样的指纹')
  assert.notEqual(a, headHashOf('# 标题\n\n正文 '), '差一个字符就必须不同')
  assert.notEqual(headHashOf(''), headHashOf('a'))
})

test('recordMatches：缺指纹 / 元信息不符一律不可复用（不许只靠 mtime+size）', () => {
  const observed = { mtimeMs: 1000, size: 12, headHash: headHashOf('# a.md') }
  assert.equal(recordMatches(recordOf('a.md'), observed), true)
  // 只有 mtime+size 对得上 —— 这正是 v0.21 的全部证据，v0.22 必须拒绝它
  assert.equal(recordMatches({ rel: 'a.md', mtimeMs: 1000, size: 12 }, observed), false)
  assert.equal(recordMatches(recordOf('a.md', { headHash: '' }), observed), false)
  assert.equal(recordMatches(recordOf('a.md', { mtimeMs: 999 }), observed), false)
  assert.equal(recordMatches(recordOf('a.md', { size: 13 }), observed), false)
  assert.equal(recordMatches(recordOf('a.md', { headHash: headHashOf('别的') }), observed), false)
  // 畸形输入不抛
  for (const bad of [null, undefined, 0, 'x', []]) {
    assert.equal(recordMatches(bad, observed), false)
  }
})

test('canonicalRoot：展开符号链接；路径不存在时兜底原值不抛', () => {
  const dir = tempDir()
  const real = join(dir, 'real')
  mkdirSync(real)
  const link = join(dir, 'link')
  symlinkSync(real, link)
  assert.equal(canonicalRoot(link), realpathSync(real))
  assert.equal(canonicalRoot(join(dir, 'nope')), join(dir, 'nope'))
})

/* ── 2 · 元数据与隔离 ─────────────────────────────────── */

test('open 的 descriptor 钉死布局与版本：per-record + version 3 + compatibleVersions [1, 2]', async () => {
  const backend = fakeBackend()
  const store = createIndexStore({ backend })
  await store.read('/w')
  assert.equal(backend.descriptors.length, 1, '`openUnit()` 必须记忆化（只开一次）')
  const descriptor = backend.descriptors[0]
  assert.equal(descriptor.name, INDEX_UNIT)
  assert.equal(descriptor.version, INDEX_VERSION)
  assert.equal(descriptor.layout, 'per-record')
  assert.deepEqual(descriptor.tables, INDEX_TABLES)
  // v1（缺 headHash）/ v2（存 head 不存 refs）都必须读得进来，但会被 `refsShapeOk()`
  // 或指纹检查挡在复用之外 ⇒ 下一轮重建 —— 升级不需要迁移代码。
  assert.deepEqual(descriptor.compatibleVersions, [1, 2])
  assert.equal(INDEX_UNIT, 'knit_index')
  assert.equal(INDEX_VERSION, 3)
})

test('持久化：写进去的索引能被「重启后」的新 store 读回来，且记录里不含正文', async () => {
  const medium = { tables: {} }
  const first = createIndexStore({ backend: fakeBackend(medium) })
  assert.equal(first.persisted, false, '证据到之前不许说自己在用存储')
  assert.equal(first.reason, 'unproven')
  await first.write('/w', { put: [recordOf('a.md'), recordOf('b.md')], del: [] })
  await first.flush()

  const second = createIndexStore({ backend: fakeBackend(medium) })
  const rows = await second.read('/w')
  assert.equal(second.persisted, true, '读成功之后才有资格说在用存储')
  assert.equal(second.reason, 'ok')
  assert.deepEqual([...rows.keys()].sort(), ['a.md', 'b.md'])
  assert.equal(rows.get('a.md').headHash, recordOf('a.md').headHash)
  // 裁决 A + 修法 ①：正文与原文首部都不进索引，只留抽取结果
  for (const value of rows.values()) {
    assert.equal('body' in value, false, '索引记录里不许出现 body')
    assert.equal('head' in value, false, '索引记录里不许出现原文首部 head（修法 ①）')
    assert.equal(refsShapeOk(value.refs), true, '记录里要带可用的抽取结果 refs')
  }
})

test('隔离：同一个 rel 在两个工作区之间不许串（靠值里的 root 过滤）', async () => {
  const medium = { tables: {} }
  const store = createIndexStore({ backend: fakeBackend(medium) })
  const refsOfOne = { md: [{ raw: 'one.md', line: 1 }], any: [{ raw: 'one.md', line: 1 }] }
  const refsOfTwo = { md: [{ raw: 'two.md', line: 2 }], any: [{ raw: 'two.md', line: 2 }] }
  await store.write('/w/one', { put: [recordOf('a.md', { refs: refsOfOne })], del: [] })
  await store.write('/w/two', { put: [recordOf('a.md', { refs: refsOfTwo })], del: [] })
  await store.flush()

  const restarted = createIndexStore({ backend: fakeBackend(medium) })
  const one = await restarted.read('/w/one')
  const two = await restarted.read('/w/two')
  assert.deepEqual(one.get('a.md').refs, refsOfOne)
  assert.deepEqual(two.get('a.md').refs, refsOfTwo)
  assert.equal((await restarted.read('/w/three')).size, 0, '没索引过的工作区必须是空的')
})

test('隔离：符号链接工作区与真实路径是同一份索引（canonicalRoot 归一）', async () => {
  const dir = tempDir()
  const real = join(dir, 'real')
  mkdirSync(real)
  const link = join(dir, 'link')
  symlinkSync(real, link)

  const medium = { tables: {} }
  const store = createIndexStore({ backend: fakeBackend(medium) })
  await store.write(link, { put: [recordOf('a.md')], del: [] })
  await store.flush()

  // 换个字符串形态（真实路径）去读，必须命中同一份记录 —— 否则索引会时灵时不灵
  const restarted = createIndexStore({ backend: fakeBackend(medium) })
  const viaReal = await restarted.read(real)
  assert.deepEqual([...viaReal.keys()], ['a.md'])
  const viaLink = await restarted.read(link)
  assert.deepEqual([...viaLink.keys()], ['a.md'])
})

test('只写差量：一次 `put` 只碰一个键，取消是 `deleteRecord` 而不是重写整张表', async () => {
  const medium = { tables: {} }
  const backend = fakeBackend(medium)
  const store = createIndexStore({ backend })
  await store.write('/w', { put: [recordOf('a.md'), recordOf('b.md'), recordOf('c.md')], del: [] })
  await store.flush()
  assert.equal(backend.writes.length, 3)

  const before = backend.writes.length
  await store.write('/w', { put: [recordOf('b.md', { refs: { md: [{ raw: 'c.md', line: 3 }], any: [] } })], del: ['c.md'] })
  await store.flush()
  assert.deepEqual(backend.writes.slice(before), [
    ['put', INDEX_TABLES[0], recordKey('/w', 'b.md')],
    ['del', INDEX_TABLES[0], recordKey('/w', 'c.md')],
  ])
  const rows = await store.read('/w')
  assert.deepEqual([...rows.keys()].sort(), ['a.md', 'b.md'])
  assert.deepEqual(rows.get('b.md').refs.md, [{ raw: 'c.md', line: 3 }])
})

/* ── 3 · 降级：任何失败都不许抛进检索路径 ─────────────── */

test('降级：没有存储时功能是空转，但必须说清理由，且绝不抛', async () => {
  for (const backend of [null, undefined, {}, { kv: {} }]) {
    const store = createIndexStore({ backend })
    assert.equal(store.persisted, false)
    assert.equal(store.reason, 'no-storage')
    assert.deepEqual(await store.read('/w'), new Map())
    assert.equal(await store.write('/w', { put: [recordOf('a.md')], del: [] }), false)
    assert.equal(await store.flush(), false)
  }
  // 显式传 null 也要走降级（`apply()` 启动那一刻就是 null）
  assert.equal(createIndexStore(null).reason, 'no-storage')
})

test('降级：unit 开不起来 / 介质损坏 ⇒ 空 Map + 明确 reason，检索照常', async () => {
  const failOpen = createIndexStore({ backend: fakeBackend(undefined, { failOpen: true }) })
  assert.deepEqual(await failOpen.read('/w'), new Map())
  assert.equal(failOpen.persisted, false)
  assert.equal(failOpen.reason, 'open-failed')
  assert.equal(await failOpen.write('/w', { put: [recordOf('a.md')], del: [] }), false)
  assert.equal(failOpen.reason, 'open-failed')

  const broken = createIndexStore({ backend: fakeBackend(undefined, { brokenLoad: true }) })
  assert.deepEqual(await broken.read('/w'), new Map())
  assert.equal(broken.persisted, false)
  assert.equal(broken.reason, 'read-failed')
})

test('降级：表里混着别的工作区与畸形记录时，只挑得出来的那些，不抛', async () => {
  const medium = {
    tables: {
      [INDEX_TABLES[0]]: {
        k1: recordOf('a.md'),
        k2: { root: '/other', rel: 'a.md' },
        k3: null,
        k4: 'not-an-object',
        k5: { root: '/w', rel: '' },
        k6: { root: '/w', rel: 'b.md', mtimeMs: 1, size: 1 },
      },
    },
  }
  const store = createIndexStore({ backend: fakeBackend(medium) })
  const rows = await store.read('/w')
  assert.deepEqual([...rows.keys()], ['a.md', 'b.md'], '缺 headHash 的记录仍要读进来（由复用判定去拒）')
})

/* ── 4 · 清理：遗留键不许永远留在盘上（清理补丁）────────── */

test('清理：键与记录不同源的遗留记录只在下一次写盘时顺手删掉，且绝不碰新格式键', async () => {
  const root = '/w'
  const shortLegacy = relToKey('legacy.md')
  const foreignLegacy = relToKey('outside.md')
  // 反例：长度 > 16 且前 16 个字符恰好都是 hex —— **只看前缀**会把它当成新格式、
  // 于是永远不清；加上「解回来必须等于 row.rel」才判得出来。这里它指向另一个 rel。
  const hexPrefixed = `0123456789abcdef${relToKey('other.md')}`
  assert.equal(keyToRel(hexPrefixed), 'other.md', '夹具自证：它确实不是 trap.md 的键')
  const good = recordKey(root, 'a.md')

  const medium = {
    tables: {
      [INDEX_TABLES[0]]: {
        [shortLegacy]: recordOf('legacy.md'),
        [foreignLegacy]: recordOf('outside.md', { root: '/other' }),
        [hexPrefixed]: recordOf('trap.md'),
        [good]: recordOf('a.md'),
      },
    },
  }
  const backend = fakeBackend(medium)
  const store = createIndexStore({ backend })

  // 读**不动盘**：老记录仍然读得进来（由复用判定去拒），只是被记进清理队列。
  const rows = await store.read(root)
  assert.deepEqual([...rows.keys()].sort(), ['a.md', 'legacy.md', 'trap.md'])
  assert.equal(backend.writes.length, 0, '读不许写盘')
  assert.equal(store.cleaned, 0)

  await store.write(root, { put: [recordOf('b.md')], del: [] })
  await store.flush()
  assert.equal(store.cleaned, 3, '两条短旧键 + 一条 hex 前缀旧键都要清，别的工作区的残留也清')
  assert.deepEqual(
    backend.writes.filter((w) => w[0] === 'del').map((w) => w[2]).sort(),
    [shortLegacy, foreignLegacy, hexPrefixed].sort(),
  )
  assert.ok(!backend.writes.some((w) => w[0] === 'del' && w[2] === good), '新格式键不许被删')
  assert.equal(medium.tables[INDEX_TABLES[0]][shortLegacy], undefined)
  assert.equal(medium.tables[INDEX_TABLES[0]][good].rel, 'a.md', '新格式记录原样保留')

  // 幂等：下一轮读到的是干净的键集合，再写一次不会重复删也不会重复计数。
  await store.read(root)
  await store.write(root, { put: [recordOf('c.md')], del: [] })
  await store.flush()
  assert.equal(store.cleaned, 3)
})

test('清理有上界：一次写盘最多删 INDEX_CLEAN_PER_WRITE 条，剩下的下一轮接着删', async () => {
  const root = '/w'
  const plants = {}
  const planted = 40
  for (let i = 0; i < planted; i += 1) plants[relToKey(`old${i}.md`)] = recordOf(`old${i}.md`)
  const medium = { tables: { [INDEX_TABLES[0]]: plants } }
  const backend = fakeBackend(medium)
  const store = createIndexStore({ backend })

  await store.read(root)
  await store.write(root, { put: [recordOf('a.md')], del: [] })
  await store.flush()
  assert.equal(store.cleaned, INDEX_CLEAN_PER_WRITE, '一轮最多清 INDEX_CLEAN_PER_WRITE 条')

  await store.read(root)
  await store.write(root, { put: [recordOf('b.md')], del: [] })
  await store.flush()
  assert.equal(store.cleaned, planted, '两轮把 40 条清完（32 + 8）')
  assert.equal(
    Object.keys(medium.tables[INDEX_TABLES[0]]).length, 2,
    '盘上只剩两条新格式记录（旧格式不让 loadAll() 永远多付钱）',
  )
})

test('sharedIndexStore：同一个后端对象只造一个 store（DSH 同进程反复加载插件）', async () => {
  const { sharedIndexStore } = await import('../src/host/index-store.js')
  const backend = fakeBackend()
  const first = sharedIndexStore(backend)
  const second = sharedIndexStore(backend)
  assert.ok(first)
  assert.equal(first, second, '第二次加载必须复用同一个 store，否则只有第一次开得成 kv unit')
  assert.equal(sharedIndexStore(null), null)
})


/**
 * Knit · **上下文控制层**（v0.21）的测试
 *
 * 靶心是**「用户的话比排序算法更硬」这句话到底有没有落地**，分两步分别证伪：
 *   · 排除在**检索之前** —— 被排掉的文件不进候选集，连 `matched` 都不算它；
 *   · 固定在**装配之后** —— 被固定的条目从三层**移出**，三层本身一字不动。
 *
 * 还有一件事必须测：拿不到存储时**功能照常、只是说出来**（D8 的降级路径），
 * 因为那条路径在真机上永远不会被「正常使用」走到，只有测试能一直守着它。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  normalizeControl, applyAction, excludedSet, pinnedRels, applyPinOverride,
  createControlStore, createControlRegistry, sharedControlRegistry, emptyControl,
  MAX_CONTROL_ROWS, CONTROL_UNIT, CONTROL_VERSION,
} from '../src/host/control.js'
import { scan, buildContextFor } from '../src/host/index.js'
import { makeWorkspace } from './fixture.mjs'

const rel = (item) => item.rel

/* ── 1 · 状态机：确定性、幂等、互斥 ─────────────────────── */

test('normalizeControl：畸形输入一律当空状态处理，不抛', () => {
  for (const bad of [null, undefined, 0, 'x', [], { pinned: 'no' }, { pinned: [null, 3, {}] }]) {
    assert.deepEqual(normalizeControl(bad), emptyControl())
  }
  // 缺 `at` 的记录保留（时间戳不是身份），但不合法的 `rel` 直接丢
  assert.deepEqual(normalizeControl({ pinned: [{ rel: 'a.md' }, { rel: '' }] }), {
    pinned: [{ rel: 'a.md', at: 0 }], excluded: [],
  })
})

test('normalizeControl：固定项按 `at` 升序，`at` 相同按 rel 字典序（确定性）', () => {
  const out = normalizeControl({
    pinned: [{ rel: 'b.md', at: 5 }, { rel: 'a.md', at: 5 }, { rel: 'c.md', at: 1 }],
  })
  assert.deepEqual(out.pinned.map(rel), ['c.md', 'a.md', 'b.md'])
})

test('applyAction：同一篇排两次不出现第二行，重复固定也不刷新 `at`', () => {
  const first = applyAction(emptyControl(), 'pin', 'a.md', 100)
  assert.equal(first.changed, true)
  const again = applyAction(first.control, 'pin', 'a.md', 999)
  assert.equal(again.changed, false)
  assert.deepEqual(again.control.pinned, [{ rel: 'a.md', at: 100 }])

  const ex = applyAction(emptyControl(), 'exclude', 'a.md', 7)
  assert.equal(applyAction(ex.control, 'exclude', 'a.md', 8).changed, false)
})

test('applyAction：固定与排除互斥（一个动作同时清掉对面那一侧）', () => {
  const pinned = applyAction(emptyControl(), 'pin', 'a.md', 1).control
  const excluded = applyAction(pinned, 'exclude', 'a.md', 2).control
  assert.deepEqual(excluded.pinned, [])
  assert.deepEqual(excluded.excluded.map(rel), ['a.md'])
  const back = applyAction(excluded, 'pin', 'a.md', 3).control
  assert.deepEqual(back.excluded, [])
  assert.deepEqual(back.pinned.map(rel), ['a.md'])
})

test('applyAction：未知动作 / 非法 rel 一律不动状态，也不抛', () => {
  const base = applyAction(emptyControl(), 'pin', 'a.md', 1).control
  for (const [action, r] of [['delete', 'a.md'], ['pin', ''], ['pin', 42], ['restore', 'a.md']]) {
    const out = applyAction(base, action, r, 2)
    assert.equal(out.changed, false)
    assert.deepEqual(out.control, base)
  }
  // 两个方向都能取消：unpin 拿掉固定，restore 拿掉排除
  assert.equal(applyAction(base, 'unpin', 'a.md').changed, true)
  assert.deepEqual(applyAction(base, 'unpin', 'a.md').control.pinned, [])
})

test('applyAction：记录数有硬上限（状态不能无限长）', () => {
  let control = emptyControl()
  for (let i = 0; i < MAX_CONTROL_ROWS + 20; i++) {
    control = applyAction(control, 'pin', `f${i}.md`, i).control
  }
  assert.equal(control.pinned.length, MAX_CONTROL_ROWS)
})

test('excludedSet / pinnedRels：集合与顺序两个视图', () => {
  const control = { pinned: [{ rel: 'p.md', at: 2 }], excluded: [{ rel: 'x.md', at: 1 }] }
  assert.deepEqual([...excludedSet(control)], ['x.md'])
  assert.deepEqual(pinnedRels(control), ['p.md'])
  assert.deepEqual([...excludedSet(null)], [])
})

/* ── 2 · 固定覆盖：只从本包现成的行里取 ─────────────────── */

/** 造一个最小 pack（形状与 `buildContext()` 的产物一致）。 */
const fakePack = () => ({
  primary: [{ rel: 'p.md', title: 'P', reason: {}, provenance: 'retrieval' }],
  supporting: [{ rel: 's.md', title: 'S', reason: {}, provenance: 'retrieval' }],
  related: [{ rel: 'r.md', title: 'R', reason: {}, provenance: 'retrieval' }],
})

test('applyPinOverride：固定项从三层移出，来源改成 `manual`，其余行原样', () => {
  const pack = fakePack()
  const out = applyPinOverride(pack, { pinned: [{ rel: 's.md', at: 1 }], excluded: [] })
  assert.deepEqual(out.pinned.map(rel), ['s.md'])
  assert.equal(out.pinned[0].provenance, 'manual')
  assert.equal(out.pinned[0].title, 'S', '复用现成的行，不重新装配')
  assert.deepEqual(out.supporting, [])
  assert.deepEqual(out.primary.map(rel), ['p.md'])
  assert.deepEqual(out.related.map(rel), ['r.md'])
})

test('applyPinOverride：顺序按用户固定的先后，不是按层', () => {
  const pack = fakePack()
  const out = applyPinOverride(pack, {
    pinned: [{ rel: 'r.md', at: 1 }, { rel: 'p.md', at: 2 }], excluded: [],
  })
  assert.deepEqual(out.pinned.map(rel), ['r.md', 'p.md'])
})

test('applyPinOverride：固定了但这一批里没有它 —— 不硬凑，原样返回同一个对象', () => {
  const pack = fakePack()
  const out = applyPinOverride(pack, { pinned: [{ rel: 'gone.md', at: 1 }], excluded: [] })
  assert.equal(out, pack, '一篇都没落到本批 ⇒ 连拷贝都不做')
  assert.equal(out.pinned, undefined, '没有固定项时这个键不出现（不是空数组）')
  assert.deepEqual(out.primary.map(rel), ['p.md'], '三层一篇都不许少')
})

test('applyPinOverride：没有固定项时原样返回**同一个对象**（零开销路径）', () => {
  const pack = fakePack()
  assert.equal(applyPinOverride(pack, emptyControl()), pack)
  assert.equal(applyPinOverride(pack, null), pack)
})

/* ── 3 · 端到端：排除在检索之前、固定在装配之后 ─────────── */

test('端到端：排除在检索之前 —— 被排掉的那篇不进候选集，也不计入 matched', async () => {
  const root = makeWorkspace()
  const query = '相关性排序 sidebar'
  const plain = await scan(root, 20, { sort: 'relevance', kind: 'context', query })
  const victim = plain.docs[0].rel
  const hit = await scan(root, 20, {
    sort: 'relevance', kind: 'context', query, excluded: new Set([victim]),
  })

  assert.equal(hit.mode, 'relevance', '排除不该把相关性模式打回时间序')
  assert.ok(!hit.ranked.some((doc) => doc.rel === victim), '被排掉的不该留在全量名次里')
  assert.ok(!hit.docs.some((doc) => doc.rel === victim), '也不该留在这一页里')
  assert.equal(hit.total, plain.total - 1)
  assert.equal(hit.stats.controlSkipped, 1, '管道条要的是「这一批真的排掉几篇」')
  assert.ok(plain.ranked.some((doc) => doc.rel === victim), '不传 excluded 时一切照旧')
})

test('端到端：排除一个不在这批语料里的 rel —— 计数为 0，别的什么都不变', async () => {
  const root = makeWorkspace()
  const plain = await scan(root, 20, { sort: 'relevance', kind: 'context', query: 'sidebar' })
  const hit = await scan(root, 20, {
    sort: 'relevance', kind: 'context', query: 'sidebar', excluded: new Set(['nope.txt']),
  })
  assert.equal(hit.stats.controlSkipped, 0)
  assert.deepEqual(hit.docs.map(rel), plain.docs.map(rel))
})

test('端到端：固定在装配之后 —— 三层成员与顺序逐字不变（只少了被固定那一篇）', async () => {
  const root = makeWorkspace()
  const query = '相关性排序 sidebar'
  const payload = await scan(root, 20, { sort: 'relevance', kind: 'context', query })
  const plain = await buildContextFor(root, {
    ranked: payload.ranked, topic: payload.topic, task: payload.task, total: payload.total,
  })
  const target = plain.supporting[0] || plain.related[0] || plain.primary[0]
  assert.ok(target, '夹具太弱：一篇都没进包')

  const pinnedPack = await buildContextFor(root, {
    ranked: payload.ranked, topic: payload.topic, task: payload.task, total: payload.total,
    control: { pinned: [{ rel: target.rel, at: 1 }], excluded: [] },
  })
  assert.deepEqual(pinnedPack.pinned.map(rel), [target.rel])
  assert.equal(pinnedPack.pinned[0].provenance, 'manual')
  /** 把某一篇从「那三个数组」里全部抽掉，剩下的序列必须逐字相同。 */
  const strip = (pack) => ['primary', 'supporting', 'related']
    .map((tier) => pack[tier].map(rel).filter((r) => r !== target.rel))
  assert.deepEqual(strip(pinnedPack), strip(plain), '被固定的只是移出，不许重排别人')
  const all = (pack) => ['primary', 'supporting', 'related']
    .flatMap((tier) => pack[tier]).filter((item) => item.rel !== target.rel)
  assert.deepEqual(all(pinnedPack), all(plain), '其余每一条的数据也该逐字相同')
})

/* ── 4 · 持久化与降级（D8）─────────────────────────────── */

/**
 * 一个最小的假 `kv` 后端：形状与 `dsh-storage` 的 JSON 后端一致
 * （`open(descriptor)` → `loadAll / putRecord / deleteRecord`），
 * **介质单独放在 `medium` 里** —— 于是「重启」就是「拿同一份介质、造一个新的后端」，
 * 而 `duplicate-mount`（同名 unit 在**同一个**后端里开两次）也能如实复现。
 */
function fakeMedium() {
  return { tables: {} }
}

function fakeBackend(medium = fakeMedium()) {
  const opened = new Set()
  const writes = []
  const unitOf = (name) => ({
    loadAll: async () => ({
      unit: { name, version: 1 }, global: {}, tables: medium.tables,
    }),
    putRecord: async (table, key, value) => {
      writes.push(['put', table, key])
      medium.tables[table] = medium.tables[table] || {}
      medium.tables[table][key] = value
    },
    deleteRecord: async (table, key) => {
      writes.push(['del', table, key])
      if (medium.tables[table]) delete medium.tables[table][key]
    },
  })
  return {
    medium,
    writes,
    kv: {
      open: async (descriptor) => {
        if (opened.has(descriptor.name)) throw new Error('duplicate-mount')
        opened.add(descriptor.name)
        return unitOf(descriptor.name)
      },
    },
  }
}

test('持久化：写进去的状态能被「重启后」的新 registry 读回来', async () => {
  const medium = fakeMedium()
  const first = createControlRegistry({ backend: fakeBackend(medium) })
  assert.equal(first.persisted, false, '证据到之前不许说自己记得')
  await first.ready('/w')
  assert.equal(first.persisted, true, '装载成功 ⇒ 这时候才有资格说记得')
  await first.act('/w', 'pin', 'a.md', 11)
  await first.act('/w', 'exclude', 'b.md', 12)
  await first.flush()

  // 「重启」= 同一份介质 + 一个全新的后端与 registry
  const second = createControlRegistry({ backend: fakeBackend(medium) })
  // 首访是**异步**装载（同步读先给空状态，装载完再补上）—— 这正是设计：不阻塞面板。
  second.controlOf('/w')
  await second.flush()
  await new Promise((resolve) => setTimeout(resolve, 5))
  assert.deepEqual(pinnedRels(second.controlOf('/w')), ['a.md'])
  assert.deepEqual([...excludedSet(second.controlOf('/w'))], ['b.md'])
  assert.equal(CONTROL_UNIT, 'knit_control')
  assert.equal(CONTROL_VERSION, 1)
})

test('持久化：只写差量 —— 取消固定发的是 delete，不是把整张表重写一遍', async () => {
  const backend = fakeBackend()
  const registry = createControlRegistry({ backend })
  await registry.act('/w', 'pin', 'a.md', 1)
  await registry.act('/w', 'pin', 'c.md', 2)
  await registry.flush()
  const before = backend.writes.length
  await registry.act('/w', 'unpin', 'a.md')
  await registry.flush()
  assert.deepEqual(backend.writes.slice(before), [['del', 'pinned', '/w\u0000a.md']])
})

test('降级：没有 storage 时功能照常，但 `persisted` 必须说「没有」', async () => {
  const registry = createControlRegistry(null)
  assert.equal(registry.persisted, false)
  const out = await registry.act('/w', 'pin', 'a.md', 1)
  assert.equal(out.changed, true)
  assert.equal(out.persisted, false)
  assert.deepEqual(pinnedRels(registry.controlOf('/w')), ['a.md'])
  assert.deepEqual(await createControlStore(null).read('/w'), null)

  // 后端存在但 `open` 抛（version-mismatch / malformed-medium 那类）⇒ 一样是降级，不抛
  const broken = { kv: { open: async () => { throw new Error('version-mismatch') } } }
  const store = createControlStore({ backend: broken })
  assert.equal(await store.read('/w'), null)
  assert.equal(store.persisted, false)
})

test('真机缺陷回归：写失败时 `act()` 必须在**同一次响应**里就报 false', async () => {
  // 真机实测到的老行为：第一次点击报 `persisted: true`（只是「后端在那儿」），
  // 写其实失败了 —— 而介质文件从来没有出现过。现在 `act()` 等写完再说。
  const medium = fakeMedium()
  const backend = fakeBackend(medium)
  const store = createControlStore({ backend })
  const unit = await backend.kv.open({ name: 'probe', version: 1, tables: ['pinned', 'excluded'], hasGlobal: false })
  unit.putRecord = async () => { throw new Error('disk-full') }
  const registry = createControlRegistry({ backend: { kv: { open: async () => unit } } })
  const out = await registry.act('/w', 'pin', 'a.md', 1)
  assert.equal(out.changed, true)
  assert.equal(out.persisted, false, '写失败 ⇒ 同一次响应就如实说 false')
  assert.equal(registry.persisted, false)
  assert.equal(store.persisted, false)
  assert.deepEqual(pinnedRels(registry.controlOf('/w')), ['a.md'], '内存态照常，功能不坏')
})

test('真机缺陷回归：同一进程里插件被加载多次 ⇒ 一个后端只留一个登记表', async () => {
  // 这份 fake 的 `open` 第二次会抛（普通 Error，如实复现 json 后端的
  // 「a unit has exactly one live handle」）⇒ 各自新建的第二个实例必然降级。
  const backend = fakeBackend()
  const first = sharedControlRegistry(backend)
  const second = sharedControlRegistry(backend)
  assert.equal(second, first, '同一个后端必须复用同一份登记表')

  await first.act('/w', 'pin', 'a.md', 1)
  await first.flush()
  assert.deepEqual(pinnedRels(second.controlOf('/w')), ['a.md'], '两个实例看到的是同一份状态')
  assert.deepEqual(backend.writes, [['put', 'pinned', '/w\u0000a.md']], '只开了一次、只写了一次')

  // 反证：不走共享、各自新建的话，第二个实例的 `persisted` 会变成 false，
  // 而模块级变量被最后一次加载覆盖 ⇒ 活跃实例恰恰是打不开的那个。
  const shared = fakeBackend()
  const a = createControlRegistry({ backend: shared })
  const b = createControlRegistry({ backend: shared })
  await a.act('/w', 'pin', 'a.md', 1)
  await a.flush()
  assert.equal(a.persisted, true, '写得成 ⇒ true（这次写的结果，不是「大概能写」）')
  await b.act('/w', 'pin', 'b.md', 2)
  await b.flush()
  assert.equal(b.persisted, false, '第二个实例打不开 ⇒ 必须如实说没有记住')
  assert.equal(shared.writes.length, 1, '打不开的实例一条都不该写')
  assert.deepEqual(pinnedRels(b.controlOf('/w')), ['b.md'], '内存态照常')

  assert.equal(sharedControlRegistry(null), null, '没有后端 ⇒ 返回 null（调用方退回内存态）')
})

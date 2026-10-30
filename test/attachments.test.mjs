/**
 * v0.25：**对话里「工具产出」的图**（`src/host/attachments.js` + 两条宿主路由）。
 *
 * 这份测试的重点不是「能不能显示」，而是**那条边界**：本插件唯一一处读工作区之外的地方。
 * 所以除纯函数外，还有一组**真实回环端口**的 e2e，逐条钉住：
 *   · 只认 `sha256:<64 hex>`（给不出路径 ⇒ 穿越无从谈起）
 *   · 只读**本会话 `tool/result`** 里的 id（跨会话、用户自己贴的图，一律 404）
 *   · 工作区里已有同内容文件的 ⇒ 列表里不再出现（按 sha256，不是按文件名）
 *
 * ⚠️ e2e 要把 `DSH_HOME` 指到临时目录 —— 那条路由按 `attachmentsRoot()` 算路径，
 * 所以这里造的是**真的附件库形状**（`attachments/v1/objects/<前两位>/<sha256>`），不是假路径。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  isAttachmentId, attachmentHex, attachmentsRoot, objectPath, attachmentsFromEvent,
  createAttachmentStore, dropSaved,
} from '../src/host/attachments.js'
import { startKnitServer } from './http-harness.mjs'
import { resetAttachments, resetScanMemo } from '../src/host/index.js'

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex')

/** 造一条 `tool/result` 事件（工具产出的图）。 */
function toolEvent(meta, time = 1000) {
  return {
    type: 'tool/result',
    time,
    data: { message: { role: 'tool', content: [{ type: 'image', attachment: meta }] } },
  }
}

const META = {
  attachmentId: 'sha256:' + 'a'.repeat(64),
  mediaType: 'image/png',
  width: 64,
  height: 64,
  bytes: 128,
  name: 'D1_测试.png',
}

/* ── 纯函数 ───────────────────────────────────────────── */

test('附件（纯）：只认 sha256 一种形状 —— 给不出路径，就没有穿越', () => {
  assert.equal(isAttachmentId('sha256:' + 'a'.repeat(64)), true)
  assert.equal(attachmentHex('sha256:' + 'a'.repeat(64)), 'a'.repeat(64))
  for (const bad of [
    '', null, undefined, 'a'.repeat(64), 'sha256:', 'sha256:' + 'A'.repeat(64), // 大写不认
    'sha256:' + 'a'.repeat(63), 'sha256:' + 'a'.repeat(65),
    'sha256:../../etc/passwd', '/etc/passwd', '../a', 'sha512:' + 'a'.repeat(64),
  ]) {
    assert.equal(isAttachmentId(bad), false, `该拒：${bad}`)
    assert.equal(attachmentHex(bad), '', `该拒：${bad}`)
    assert.equal(objectPath('/tmp/objects', bad), '', `不合法 id 不许算出路径：${bad}`)
  }
  // 合法 id：路径**由哈希算出来**（前两位做目录），与 DSH 的布局一致
  const abs = objectPath('/tmp/objects', 'sha256:' + 'abcdef'.padEnd(64, '0'))
  assert.equal(abs, join('/tmp/objects', 'ab', 'abcdef'.padEnd(64, '0')))
})

test('附件（纯）：附件库根认 DSH_HOME，否则退回 ~/.dsh', () => {
  assert.equal(attachmentsRoot({ DSH_HOME: '/x/dsh' }), '/x/dsh/attachments/v1/objects')
  assert.match(attachmentsRoot({}), /\.dsh\/attachments\/v1\/objects$/)
})

test('附件（纯）：只收 tool/result 里的图 —— 用户自己贴的图**一条都不收**', () => {
  const got = attachmentsFromEvent(toolEvent(META))
  assert.equal(got.length, 1)
  assert.equal(got[0].id, META.attachmentId)
  assert.equal(got[0].kind, 'image')
  assert.equal(got[0].at, 1000, '时间戳要带出来（客户端按它排序）')

  // ⚠️ 这是隐私那一条：用户贴的图**默认不进媒体档**。
  // 两层都要钉：① 真实信封（`data.content` / `data.inserted`）；② **同形状**的假想信封 ——
  // 后者才是「类型过滤」本身，少了它这条守卫会空转（信封不同替过滤挡了枪）。
  for (const type of ['user/message', 'agent/inbox/spliced', 'assistant/message']) {
    const ev = { type, time: 1, data: { content: [{ type: 'image', attachment: META }] } }
    assert.deepEqual(attachmentsFromEvent(ev), [], `${type} 不该被收`)
    const sameShape = { type, time: 1, data: { message: { role: 'user', content: [{ type: 'image', attachment: META }] } } }
    assert.deepEqual(attachmentsFromEvent(sameShape), [], `${type}（与 tool/result 同形状）也不许收`)
  }
  // 工具事件里但形状不对的，也不收
  assert.deepEqual(attachmentsFromEvent({ type: 'tool/result', data: {} }), [])
  assert.deepEqual(attachmentsFromEvent({ type: 'tool/result', data: { message: { content: [{ type: 'text', text: 'x' }] } } }), [])
  assert.deepEqual(attachmentsFromEvent(null), [])
})

test('附件（纯）：类型 / 大小不合规的条目被拒（太大既不列也不读）', () => {
  const base = { ...META, attachmentId: 'sha256:' + 'b'.repeat(64) }
  const cases = [
    [{ ...base, mediaType: 'text/plain' }, '不是图片/视频'],
    [{ ...base, mediaType: 'application/pdf' }, '不是图片/视频'],
    [{ ...base, mediaType: '' }, '没有类型'],
    [{ ...base, bytes: 0 }, '字节数为 0'],
    [{ ...base, bytes: -5 }, '负数'],
    [{ ...base, bytes: 12 * 1024 * 1024 + 1 }, '超过 12 MB 上限'],
    [{ ...base, attachmentId: 'nope' }, 'id 不合法'],
  ]
  for (const [meta, why] of cases) assert.deepEqual(attachmentsFromEvent(toolEvent(meta)), [], why)
  // 视频要认成 video（媒体档要按视频渲染）
  const video = attachmentsFromEvent(toolEvent({ ...base, mediaType: 'video/mp4' }))[0]
  assert.equal(video.kind, 'video')
  // 没有名字就给一个由哈希派生的名字（列表里不能出现空白名）
  const unnamed = attachmentsFromEvent(toolEvent({ ...base, name: '' }))[0]
  assert.match(unnamed.name, /^attachment-[0-9a-f]{8}$/)
})

test('附件（纯）：登记簿按会话隔离，且**跨会话一律不认**（读字节的唯一闸门）', () => {
  const store = createAttachmentStore()
  store.note('s1', toolEvent(META))
  assert.equal(store.has('s1', META.attachmentId), true)
  assert.equal(store.has('s2', META.attachmentId), false, '另一个会话不许认这条 id')
  assert.equal(store.list('s2').length, 0)
  assert.equal(store.get('s2', META.attachmentId), undefined)
  // 同一条重复记：不重复、元数据覆盖
  store.note('s1', toolEvent({ ...META, name: '改名.png' }))
  assert.equal(store.list('s1').length, 1)
  assert.equal(store.list('s1')[0].name, '改名.png')
  // 不是带图的事件：什么都不做
  assert.equal(store.note('s1', { type: 'tool/result', data: {} }), 0)
  assert.equal(store.note('', toolEvent(META)), 0, '没有会话 id 不记')
})

test('附件（纯）：登记簿有界 —— 每会话丢最老的，会话数按 LRU 丢', () => {
  const store = createAttachmentStore({ maxPerSession: 2, maxSessions: 2 })
  const id = (n) => 'sha256:' + String(n).repeat(64).slice(0, 64)
  store.note('s1', toolEvent({ ...META, attachmentId: id(1), name: '1' }))
  store.note('s1', toolEvent({ ...META, attachmentId: id(2), name: '2' }))
  store.note('s1', toolEvent({ ...META, attachmentId: id(3), name: '3' }))
  assert.deepEqual(store.list('s1').map((x) => x.name), ['2', '3'], '超上限丢最老的')
  store.note('s2', toolEvent({ ...META, attachmentId: id(4), name: '4' }))
  store.note('s3', toolEvent({ ...META, attachmentId: id(5), name: '5' }))
  assert.equal(store.size, 2, '会话数也封顶')
  assert.equal(store.has('s1', id(2)), false, '最久没动的会话被丢（LRU）')
  assert.equal(store.has('s3', id(5)), true)
})

test('附件（纯）：去重按 **sha256**，且只给「大小相同」的候选算哈希（不扫全库）', async () => {
  const items = [
    { id: 'sha256:' + 'a'.repeat(64), bytes: 100 },
    { id: 'sha256:' + 'b'.repeat(64), bytes: 200 },
  ]
  const hashed = []
  const sha256Of = async (rel) => { hashed.push(rel); return rel === 'shot-a.png' ? 'a'.repeat(64) : 'f'.repeat(64) }
  const candidates = [
    { rel: 'shot-a.png', bytes: 100 },   // 大小与 a 相同 ⇒ 算哈希 ⇒ 命中 ⇒ 去掉
    { rel: 'other.png', bytes: 200 },    // 大小与 b 相同 ⇒ 算哈希 ⇒ 不命中 ⇒ 留着
    { rel: 'big.png', bytes: 999 },      // 大小都不像 ⇒ **根本不算哈希**
  ]
  const kept = await dropSaved(items, { candidates, sha256Of })
  assert.deepEqual(kept.map((x) => x.bytes), [200], '已经在工作区里的那条被去掉')
  assert.deepEqual(hashed, ['shot-a.png', 'other.png'], '不同大小的候选一次哈希都不该算')
  // 没有候选 / 没有哈希器：原样返回（不假装去重过）
  assert.equal((await dropSaved(items, { candidates: [] })).length, 2)
  assert.equal((await dropSaved(items, {})).length, 2)
  assert.deepEqual(await dropSaved([], { candidates }), [])
  // 哈希器抛错：那条候选当作没命中（宁可重复出现，也不许误删）
  const bad = await dropSaved(items, { candidates, sha256Of: () => { throw new Error('boom') } })
  assert.equal(bad.length, 2)
})

/* ── 真实回环端口的 e2e：把那条边界逐条钉住 ───────────────────── */

/** 造「附件库 + 工作区」两个临时目录，并把 DSH_HOME 指过去。 */
async function makeWorld(options = {}) {
  const home = await mkdtemp(join(tmpdir(), 'knit-attach-home-'))
  const root = await mkdtemp(join(tmpdir(), 'knit-attach-root-'))
  const bytes = Buffer.from('fake-png-bytes-' + 'x'.repeat(20))
  const hex = sha256(bytes)
  const id = 'sha256:' + hex
  // 真的附件库形状：attachments/v1/objects/<前两位>/<sha256>
  await mkdir(join(home, 'attachments', 'v1', 'objects', hex.slice(0, 2)), { recursive: true })
  await writeFile(join(home, 'attachments', 'v1', 'objects', hex.slice(0, 2), hex), bytes)
  if (options.saveToWorkspace) await writeFile(join(root, 'shot.png'), bytes)
  if (options.otherWorkspaceFile) await writeFile(join(root, 'other.png'), Buffer.from('different-bytes'))
  const meta = { attachmentId: id, mediaType: 'image/png', width: 8, height: 8, bytes: bytes.length, name: '生成图.png' }
  return { home, root, bytes, hex, id, meta }
}

async function withServer(world, events, fn) {
  // ⚠️ 附件登记簿是**模块级**的（生产里就是进程级的），用例之间必须清 ——
  // 不清的话上一个用例的 id 还挂着，下一个用例的「用户贴的图不许读」会假红。
  resetAttachments()
  const prev = process.env.DSH_HOME
  process.env.DSH_HOME = world.home
  const session = { header: { cwd: world.root, id: 's1' }, snapshotEvents: () => events }
  const server = await startKnitServer({ root: world.root, session, sessionId: 's1' })
  try {
    await fn(server)
  } finally {
    await server.close()
    if (prev === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prev
    await rm(world.home, { recursive: true, force: true })
    await rm(world.root, { recursive: true, force: true })
  }
}

test('附件（e2e）：/api/attachments 列出本会话工具产出的图；存进工作区之后就不出现了', async () => {
  const world = await makeWorld()
  const events = [toolEvent(world.meta)]
  await withServer(world, events, async (server) => {
    let res = await fetch(`${server.base}/api/attachments?sessionId=s1`)
    let data = await res.json()
    assert.equal(res.status, 200)
    assert.deepEqual(data.items.map((x) => x.id), [world.id], '还没保存 ⇒ 出现在列表里')

    // 把同样的字节存进工作区（模拟「拿到本地」）
    await writeFile(join(world.root, 'shot.png'), world.bytes)
    // 扫描结果有 8 秒备忘（与面板轮询同窗）⇒ 要看「下一次扫描」，必须把它清掉
    resetScanMemo()
    res = await fetch(`${server.base}/api/attachments?sessionId=s1`)
    data = await res.json()
    assert.deepEqual(data.items, [], '工作区里已有同内容文件 ⇒ 列表里不再出现（按 sha256 去重）')
  })
})

test('附件（e2e）：不同内容的同名文件**不会**把附件误删（去重看内容不看名字）', async () => {
  const world = await makeWorld({ otherWorkspaceFile: true })
  await withServer(world, [toolEvent(world.meta)], async (server) => {
    const res = await fetch(`${server.base}/api/attachments?sessionId=s1`)
    const data = await res.json()
    assert.equal(data.items.length, 1, '工作区里那几张图内容不同 ⇒ 附件仍然显示')
  })
})

test('附件（e2e）：/api/attachment 按 sha256 回字节，类型取事件里的 mediaType', async () => {
  const world = await makeWorld()
  await withServer(world, [toolEvent(world.meta)], async (server) => {
    const res = await fetch(`${server.base}/api/attachment?sessionId=s1&id=${encodeURIComponent(world.id)}`)
    assert.equal(res.status, 200)
    assert.equal(res.headers.get('content-type'), 'image/png', '附件对象没有扩展名 ⇒ 类型只能取事件里的')
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff')
    assert.match(String(res.headers.get('content-security-policy')), /sandbox/, '与 /api/raw 同一套防护')
    const got = Buffer.from(await res.arrayBuffer())
    assert.deepEqual(got, world.bytes, '回的必须是那份字节')
  })
})

test('附件（e2e）：只认本会话的 id —— 跨会话 / 没出现过 / 用户贴的图 / 畸形 id 一律 404', async () => {
  const world = await makeWorld()
  // 同一个附件：一条来自 tool/result（会被收），一条来自 user/message（不会被收）
  const pastedOnly = {
    // 刻意用**与 tool/result 相同**的信封：这样 404 只能归因于「类型不是 tool/result」，
    // 而不是「信封字段凑巧不一样」—— 后者会让这条 e2e 变成空转的绿灯。
    type: 'user/message', time: 5,
    data: { message: { role: 'user', content: [{ type: 'image', attachment: world.meta }] } },
  }
  await withServer(world, [toolEvent(world.meta)], async (server) => {
    const url = (q) => `${server.base}/api/attachment?${q}`
    assert.equal((await fetch(url(`sessionId=s1&id=${encodeURIComponent(world.id)}`))).status, 200, '本会话：可以读')

    const otherId = 'sha256:' + 'c'.repeat(64)
    assert.equal((await fetch(url(`sessionId=s2&id=${encodeURIComponent(world.id)}`))).status, 404, '别的会话：404')
    assert.equal((await fetch(url(`sessionId=s1&id=${encodeURIComponent(otherId)}`))).status, 404, '没出现过：404')
    assert.equal((await fetch(url(`sessionId=&id=${encodeURIComponent(world.id)}`))).status, 404, '没有会话：404')
    for (const bad of ['../../etc/passwd', '/etc/passwd', 'sha256:../../x', 'sha256:' + 'A'.repeat(64)]) {
      const res = await fetch(url(`sessionId=s1&id=${encodeURIComponent(bad)}`))
      assert.equal(res.status, 404, `畸形 id 必须 404：${bad}`)
    }
  })

  // 用户贴的图：即便本会话真的有这条事件，也**不许**读（只收 tool/result）
  await withServer(world, [pastedOnly], async (server) => {
    const res = await fetch(`${server.base}/api/attachment?sessionId=s1&id=${encodeURIComponent(world.id)}`)
    assert.equal(res.status, 404, '用户自己贴的图默认不进媒体档，也不给读')
    const list = await (await fetch(`${server.base}/api/attachments?sessionId=s1`)).json()
    assert.deepEqual(list.items, [], '列表里也不该有')
  })
})

test('附件（e2e）：对象文件不存在时 404（不抛、不挂）', async () => {
  const world = await makeWorld()
  // 事件里登记了 id，但把对象文件删掉
  await rm(join(world.home, 'attachments', 'v1', 'objects', world.hex.slice(0, 2), world.hex), { force: true })
  await withServer(world, [toolEvent(world.meta)], async (server) => {
    const res = await fetch(`${server.base}/api/attachment?sessionId=s1&id=${encodeURIComponent(world.id)}`)
    assert.equal(res.status, 404)
  })
})

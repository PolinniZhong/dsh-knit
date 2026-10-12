/**
 * Knit · **可选混合检索**（v0.23 Phase A）的单位测试 —— `src/host/semantic.js`。
 *
 * 这一层只回答一个问题：**「默认不花钱、失败能回退、候选有上界」这三件事是不是真的**。
 * 所以断言分四组：
 *   · 配置的收敛（不可信输入一律丢弃，不抛）；
 *   · 两种协议的**形状**（用注入的假 `fetch`，不打真网络）；
 *   · 有界与缓存（每轮最多嵌入 N 篇；第二轮不再重算）；
 *   · 五条回退原因（`no-provider` / `probe-failed` / `timeout` / `bad-response` / `no-query`）。
 *
 * ⚠️ **这些都是「机制通过」，不是「语义检索有用」** —— 价值证据只能由 Phase C 的消融在
 * 真 provider 上给出（方案 §9.1 的 `value-evidence: pending`）。
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { fakeStorageBackend } from './fixture.mjs'
import {
  cosine, createSemanticEngine, createSemanticProvider, createSemanticStore,
  embedTextOf, isLoopbackBase, normalizeProviderConfig, SEM_EMBED_PER_PASS,
} from '../src/host/semantic.js'

/** 一个记数的假 fetch：按 URL 分派，可注入失败模式。 */
function fakeFetch(routes = {}) {
  const calls = []
  const impl = async (url, init) => {
    calls.push({ url: String(url), method: (init && init.method) || 'GET', body: init && init.body })
    for (const [pattern, handler] of Object.entries(routes)) {
      if (String(url).includes(pattern)) return handler(url, init)
    }
    return { status: 404, json: async () => ({}) }
  }
  impl.calls = calls
  return impl
}

const okJson = (body) => async () => ({ status: 200, json: async () => body })
const status = (code) => async () => ({ status: code, json: async () => ({}) })
const throwAbort = () => async () => {
  const error = new Error('The operation was aborted')
  error.name = 'AbortError'
  throw error
}

const OLLAMA = { kind: 'ollama', base: 'http://127.0.0.1:11434', model: 'nomic-embed-text' }
const OPENAI = { kind: 'openai-compatible', base: 'https://api.example.com', model: 'text-embedding-3-small' }

test('配置收敛：只认两种协议 + http(s) base + 非空 model，其余一律 null（不抛）', () => {
  assert.deepEqual(normalizeProviderConfig(OLLAMA), OLLAMA)
  assert.deepEqual(normalizeProviderConfig(OPENAI), OPENAI)
  // 尾部斜杠去掉（两种协议都要拼路径，留着会出现 `//`）
  assert.equal(normalizeProviderConfig({ ...OLLAMA, base: 'http://127.0.0.1:11434/' }).base, 'http://127.0.0.1:11434')
  for (const bad of [
    null, undefined, 'ollama', 42, [],
    { ...OLLAMA, kind: 'openai' },            // 不在白名单
    { ...OLLAMA, base: 'file:///etc/passwd' }, // 不是 http(s)
    { ...OLLAMA, model: '' },                 // 空模型
    { ...OLLAMA, base: 'http://127.0.0.1:11434', model: 'x'.repeat(200) }, // 过长
  ]) {
    assert.equal(normalizeProviderConfig(bad), null, `应被丢弃：${JSON.stringify(bad)}`)
  }
})

test('isLoopbackBase：只有本机三种写法算本机（客户端据此决定要不要披露）', () => {
  assert.equal(isLoopbackBase('http://127.0.0.1:11434'), true)
  assert.equal(isLoopbackBase('http://localhost:1234/v1'), true)
  assert.equal(isLoopbackBase('http://[::1]:8080'), true)
  assert.equal(isLoopbackBase('https://api.example.com'), false)
  assert.equal(isLoopbackBase('http://192.168.1.9:11434'), false)
  assert.equal(isLoopbackBase('not a url'), false)
})

test('cosine：同向 = 1、正交 = 0、长度不等 / 全零 = 0（不是 NaN）', () => {
  assert.equal(cosine([1, 2, 3], [1, 2, 3]), 1)
  assert.equal(cosine([1, 0], [0, 1]), 0)
  assert.equal(cosine([1, 0], [1, 0, 0]), 0)
  assert.equal(cosine([0, 0], [1, 1]), 0)
  assert.equal(cosine(null, [1]), 0)
})

test('embedTextOf：只有 title + summary（两条路径上都有），空 ⇒ null', () => {
  assert.equal(embedTextOf({ title: '甲', summary: '摘要' }), '甲\n摘要')
  assert.equal(embedTextOf({ title: '', summary: '摘要' }), '摘要')
  assert.equal(embedTextOf({ title: '', summary: '' }), null)
  assert.equal(embedTextOf({}), null)
})

test('provider · ollama：探测打 /api/tags，嵌入打 /api/embed 并读 embeddings', async () => {
  const fetchImpl = fakeFetch({
    '/api/tags': okJson({ models: [] }),
    '/api/embed': okJson({ embeddings: [[1, 0], [0, 1]] }),
  })
  const provider = createSemanticProvider(OLLAMA, { fetchImpl })
  assert.deepEqual(await provider.probe(), { ok: true })
  const embedded = await provider.embed(['甲', '乙'])
  assert.equal(embedded.ok, true)
  assert.deepEqual(embedded.vectors, [[1, 0], [0, 1]])
  assert.equal(fetchImpl.calls.length, 2)
  assert.equal(fetchImpl.calls[1].method, 'POST')
  assert.deepEqual(JSON.parse(fetchImpl.calls[1].body), { model: OLLAMA.model, input: ['甲', '乙'] })
})

test('provider · openai 兼容：探测打 /v1/models，嵌入打 /v1/embeddings 并读 data[].embedding', async () => {
  const fetchImpl = fakeFetch({
    '/v1/models': okJson({ data: [] }),
    '/v1/embeddings': okJson({ data: [{ embedding: [0.5, 0.5] }] }),
  })
  const provider = createSemanticProvider(OPENAI, { fetchImpl })
  assert.deepEqual(await provider.probe(), { ok: true })
  const embedded = await provider.embed(['甲'])
  assert.deepEqual(embedded.vectors, [[0.5, 0.5]])
})

test('provider · 失败三态：HTTP 非 2xx / 形状不对 / 被 abort，各有各的 reason', async () => {
  const notOk = createSemanticProvider(OLLAMA, { fetchImpl: fakeFetch({ '/api/tags': status(500) }) })
  assert.deepEqual(await notOk.probe(), { ok: false, reason: 'probe-failed' })

  const badShape = createSemanticProvider(OLLAMA, { fetchImpl: fakeFetch({ '/api/embed': okJson({ nope: true }) }) })
  assert.deepEqual(await badShape.embed(['甲']), { ok: false, reason: 'bad-response' })

  // 条数对不上也算形状不对（少给一条比多给一条更危险：会错位）
  const short = createSemanticProvider(OLLAMA, { fetchImpl: fakeFetch({ '/api/embed': okJson({ embeddings: [[1]] }) }) })
  assert.deepEqual(await short.embed(['甲', '乙']), { ok: false, reason: 'bad-response' })

  const aborted = createSemanticProvider(OLLAMA, { fetchImpl: throwAbort() })
  assert.deepEqual(await aborted.probe(), { ok: false, reason: 'timeout' })
})

test('provider · 没有配置或没有 fetch：一律 no-provider，且一个请求都不发', async () => {
  const provider = createSemanticProvider(null)
  assert.deepEqual(await provider.probe(), { ok: false, reason: 'no-provider' })
  const noFetch = createSemanticProvider(OLLAMA, { fetchImpl: null })
  assert.deepEqual(await noFetch.probe(), { ok: false, reason: 'no-provider' })
})

test('store · 配置落盘再读回；没有后端时如实说没存储', async () => {
  const backend = fakeStorageBackend({ tables: {} })
  const store = createSemanticStore({ backend })
  assert.equal(await store.read(), null)
  assert.equal(store.persisted, true, '读成功就是证据（哪怕读回来是空）')
  await store.write(OLLAMA)
  assert.deepEqual(await store.read(), OLLAMA)
  // 坏值写不进去：`normalizeProviderConfig` 拦在门口 ⇒ 等价于清空
  await store.write({ kind: 'nope' })
  assert.equal(await store.read(), null)

  const none = createSemanticStore({ backend: null })
  assert.equal(await none.read(), null)
  assert.equal(none.persisted, false)
  assert.equal(none.reason, 'no-storage')
})

test('engine · 没有配置 ⇒ no-provider，且**一次 provider 调用都不发**（判据 1）', async () => {
  const fetchImpl = fakeFetch({})
  const engine = createSemanticEngine({ store: null, fetchImpl })
  const result = await engine.pass({ root: '/w', query: '排序', docs: [{ rel: 'a.md', title: '甲', summary: '排序' }] })
  assert.equal(result.reason, 'no-provider')
  assert.equal(result.candidates, 0)
  assert.equal(fetchImpl.calls.length, 0)
})

test('engine · 没有查询文本 ⇒ no-query（探测都不必发）', async () => {
  const fetchImpl = fakeFetch({ '/api/tags': okJson({}) })
  const engine = createSemanticEngine({ store: null, fetchImpl })
  await engine.configure(OLLAMA)
  const result = await engine.pass({ root: '/w', query: '   ', docs: [{ rel: 'a.md', title: '甲', summary: '甲' }] })
  assert.equal(result.reason, 'no-query')
  assert.equal(fetchImpl.calls.length, 0)
})

test('engine · 探测失败 ⇒ probe-failed（结果与词法一致：0 候选）', async () => {
  const fetchImpl = fakeFetch({ '/api/tags': status(503) })
  const engine = createSemanticEngine({ store: null, fetchImpl })
  await engine.configure(OLLAMA)
  const result = await engine.pass({ root: '/w', query: '排序', docs: [{ rel: 'a.md', title: '甲', summary: '甲' }] })
  assert.equal(result.available, false)
  assert.equal(result.reason, 'probe-failed')
  assert.equal(result.candidates, 0)
})

test('engine · 走通一轮：候选按相似度取，且**每轮最多嵌入 N 篇**（有界）', async () => {
  const docs = Array.from({ length: SEM_EMBED_PER_PASS + 4 }, (_, i) => ({
    rel: `d${i}.md`, title: `文档 ${i}`, summary: `第 ${i} 篇`,
  }))
  // ⚠️ 这里用**内联**假 fetch，不走 `fakeFetch()`：这一条要同时断言「调用次数」与
  // 「每轮嵌入上界」，把两者绑在同一个计数器上最不容易读错。
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push(String(url))
    if (String(url).includes('/api/tags')) return { status: 200, json: async () => ({}) }
    const input = JSON.parse(init.body).input
    return { status: 200, json: async () => ({ embeddings: input.map(() => [1, 0]) }) }
  }
  const engine = createSemanticEngine({ store: null, fetchImpl })
  await engine.configure(OLLAMA)

  const first = await engine.pass({ root: '/w', query: '排序', docs })
  assert.equal(first.available, true)
  assert.equal(first.embedded, SEM_EMBED_PER_PASS, `一轮最多嵌入 ${SEM_EMBED_PER_PASS} 篇`)
  assert.ok(first.candidates > 0)
  assert.ok(first.candidates <= docs.length)
  assert.equal(calls.length, 3, '探测 1 次 + query 1 次 + 变更批次 1 次')

  // 第二轮：已缓存的不再重算（有界 + 增量）
  const second = await engine.pass({ root: '/w', query: '排序', docs })
  assert.equal(second.cacheHits, SEM_EMBED_PER_PASS)
  assert.ok(second.embedded > 0, '池子里还没缓存的那些，这一轮继续补')
  assert.ok(second.embedded <= SEM_EMBED_PER_PASS)
})

test('engine · 换 provider（模型变了）⇒ 向量缓存作废，不混用不同模型空间', async () => {
  const docs = [{ rel: 'a.md', title: '甲', summary: '甲' }]
  const fetchImpl = fakeFetch({
    '/api/tags': okJson({}),
    '/api/embed': okJson({ embeddings: [[1, 0]] }),
  })
  const engine = createSemanticEngine({ store: null, fetchImpl })
  await engine.configure(OLLAMA)
  const first = await engine.pass({ root: '/w', query: '排序', docs })
  assert.equal(first.embedded, 1)
  await engine.configure({ ...OLLAMA, model: '另一个模型' })
  const second = await engine.pass({ root: '/w', query: '排序', docs })
  assert.equal(second.cacheHits, 0, '换模型后不许复用旧向量')
  assert.equal(second.embedded, 1)
})

test('engine · 嵌入失败 ⇒ 明着回退（reason 如实，候选 0），不抛', async () => {
  const fetchImpl = fakeFetch({
    '/api/tags': okJson({}),
    '/api/embed': async (url, init) => {
      const input = JSON.parse(init.body).input
      // 探测之后的第一次 embed 是 query；让它失败
      if (input.length === 1) return { status: 200, json: async () => ({ nope: true }) }
      return { status: 200, json: async () => ({ embeddings: [[1, 0]] }) }
    },
  })
  const engine = createSemanticEngine({ store: null, fetchImpl })
  await engine.configure(OLLAMA)
  const result = await engine.pass({ root: '/w', query: '排序', docs: [{ rel: 'a.md', title: '甲', summary: '甲' }] })
  assert.equal(result.available, false)
  assert.equal(result.reason, 'bad-response')
  assert.equal(result.candidates, 0)
})

test('engine · status()：配置存在但还没探测过时 available = null（不谎报可用）', async () => {
  const fetchImpl = fakeFetch({ '/api/tags': okJson({}) })
  const engine = createSemanticEngine({ store: null, fetchImpl })
  await engine.ready()
  assert.deepEqual(engine.status().provider, null)
  assert.equal(engine.status().configured, false)
  await engine.configure(OLLAMA)
  assert.equal(engine.status().available, null, '没探测过不许说可用')
  assert.equal(fetchImpl.calls.length, 0, 'status() 本身不发请求')
  await engine.check()
  assert.equal(engine.status().available, true)
})

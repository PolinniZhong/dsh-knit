/**
 * 宿主半边测试：解析、越界防护、相关性排序、对话事件提取。
 *
 * 跑法：node --test test/
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  parseMarkdown,
  scan,
  readDocument,
  collectDocs,
  mediaInfo,
  parseRange,
  ERROR_CODES,
} from '../src/host/index.js'
import { extractKeywords, rankByRelevance, topicLabel } from '../src/host/relevance.js'

/** 本仓库根（08_Knit），里面有真实 Markdown 可当样本。 */
const PROJECT_ROOT = fileURLToPath(new URL('../../', import.meta.url))

/**
 * 造一个假的宿主会话对象。
 * @param {Array<object>} events - 会话事件
 * @returns {object} 假会话
 */
function fakeSession(events) {
  return {
    header: { cwd: PROJECT_ROOT },
    snapshotEvents: () => events,
  }
}

/**
 * 造一条会话事件。
 * @param {string} type - 事件类型
 * @param {number} seq - 序号
 * @param {object} data - 载荷
 * @returns {object} 事件
 */
function ev(type, seq, data) {
  return { type, seq, time: Date.now(), data }
}

/**
 * 造一条用户消息事件。
 * @param {number} seq - 序号
 * @param {string} text - 文本
 * @param {string} kind - source.kind
 * @returns {object} 事件
 */
function userMessage(seq, text, kind = 'user') {
  return ev('user/message', seq, {
    role: 'user',
    content: [{ type: 'text', text }],
    source: kind === 'user' ? { kind: 'user' } : { kind, plugin: 'test' },
  })
}

/**
 * 造一条助手消息事件。
 * @param {number} seq - 序号
 * @param {string} text - 文本
 * @returns {object} 事件
 */
function assistantMessage(seq, text) {
  return ev('assistant/message', seq, {
    message: { role: 'assistant', content: [{ type: 'text', text }] },
  })
}

/* ── parseMarkdown ─────────────────────────────────── */

test('parseMarkdown: 跳过 YAML frontmatter，取 H1 与首段', () => {
  const head = ['---', 'title: x', '---', '', '# 我的标题', '', '这是第一段正文。', '', '## 二级', '第二段'].join('\n')
  assert.deepEqual(parseMarkdown(head, 'fallback.md'), { title: '我的标题', summary: '这是第一段正文。' })
})

test('parseMarkdown: 没有 H1 时用文件名', () => {
  const head = ['', '直接就是正文。'].join('\n')
  assert.equal(parseMarkdown(head, '中文文件名.md').title, '中文文件名')
})

test('parseMarkdown: 跳过列表/引用/表格/围栏，取真正的正文', () => {
  const head = ['# T', '', '- 列表项', '> 引用', '| a | b |', '```', 'code', '```', '真正的第一段。'].join('\n')
  assert.equal(parseMarkdown(head, 'x.md').summary, '真正的第一段。')
})

test('parseMarkdown: 摘要按 60 字截断并加省略号', () => {
  const long = '啊'.repeat(200)
  const { summary } = parseMarkdown(`# T\n\n${long}`, 'x.md')
  assert.equal(summary.length, 61)
  assert.ok(summary.endsWith('…'))
})

/* ── 扫描 ──────────────────────────────────────────── */

test('collectDocs: 扫到工作区 Markdown，且 mtime 倒序', async () => {
  const { docs } = await collectDocs(PROJECT_ROOT)
  assert.ok(docs.length >= 3, `至少应有 3 篇，实际 ${docs.length}`)
  for (let i = 1; i < docs.length; i += 1) {
    assert.ok(docs[i - 1].mtimeMs >= docs[i].mtimeMs, 'mtime 必须倒序')
  }
  assert.ok(docs.every((d) => d.haystack && typeof d.haystack.body === 'string'), '每篇都要带 haystack')
})

test('collectDocs: 跳过 node_modules 与隐藏目录', async () => {
  const { docs } = await collectDocs(PROJECT_ROOT)
  assert.ok(!docs.some((d) => d.rel.includes('node_modules')), '不应包含 node_modules')
  assert.ok(!docs.some((d) => d.rel.split('/').some((seg) => seg.startsWith('.'))), '不应包含隐藏目录')
})

/* ── readDocument 越界防护 ──────────────────────────── */

test('readDocument: 正常路径可读', async () => {
  const r = await readDocument(PROJECT_ROOT, 'README.md')
  assert.equal(r.ok, true)
  assert.match(r.text, /Knit/)
})

test('readDocument: 拒绝目录穿越', async () => {
  const r = await readDocument(PROJECT_ROOT, '../../../../etc/passwd')
  assert.equal(r.ok, false)
  assert.equal(r.code, ERROR_CODES.outsideWorkspace)
})

test('readDocument: 拒绝绝对路径逃逸', async () => {
  const r = await readDocument(PROJECT_ROOT, '/etc/passwd')
  assert.equal(r.ok, false)
})

test('readDocument: 拒绝非 Markdown', async () => {
  const r = await readDocument(PROJECT_ROOT, 'knit/package.json')
  assert.equal(r.ok, false)
  assert.equal(r.code, ERROR_CODES.markdownOnly)
})

/* ── 相关性引擎 ─────────────────────────────────────── */

test('extractKeywords: 中文取到有意义的词，滤掉虚词', () => {
  const kws = extractKeywords([
    '把 better-sidebar 注册和相关性排序这两个补上',
    '相关性排序要用本地关键词匹配，不要调模型',
  ], 20)
  const terms = kws.map((k) => k.term)
  assert.ok(terms.some((t) => t.includes('相关性')), `应含「相关性」，实际 ${terms.join('/')}`)
  assert.ok(terms.includes('better'), '应含 better')
  assert.ok(!terms.includes('的'), '不应含虚词')
  assert.ok(!terms.includes('我们'), '不应含 2-gram 虚词')
})

test('extractKeywords: 最新消息只出现一次的词也保留，旧消息的要重复才要', () => {
  const kws = extractKeywords(['最新话题甲甲甲', '很久以前的话题乙乙乙'], 5)
  assert.ok(kws.length > 0, '应取到词')
  // 旧消息里的词只出现一次、且不在最新消息里 → 整段滤掉
  assert.ok(kws.every((k) => !k.term.includes('乙')), `不该出现旧消息的词：${kws.map((k) => k.term).join('/')}`)
  assert.ok(kws.some((k) => k.term.includes('甲')), `应含最新消息的词：${kws.map((k) => k.term).join('/')}`)
})

test('extractKeywords: 最新消息的中文片段会进入候选（当下话题的最强信号）', () => {
  const kws = extractKeywords(['独一无二词汇出现了'], 20)
  assert.ok(kws.length > 0, '最新消息里的词应当保留')
  assert.ok(kws.every((k) => '独一无二词汇出现了'.includes(k.term)), '不应凭空造词')
})

test('extractKeywords: 单次出现的 ASCII 词保留（chokidar 这种精确词很值钱）', () => {
  const kws = extractKeywords(['先放着', '试试 chokidar 吧'], 20)
  assert.ok(kws.some((k) => k.term === 'chokidar'), `应保留 chokidar，实际 ${kws.map((k) => k.term).join('/')}`)
})

test('rankByRelevance: 命中多的排前面且分数归一', () => {
  const docs = [
    { rel: 'a.md', mtimeMs: Date.now(), haystack: { title: '相关性排序', summary: '', body: '相关性排序 相关性排序' } },
    { rel: 'b.md', mtimeMs: Date.now(), haystack: { title: '', summary: '', body: '无关内容' } },
  ]
  const kws = extractKeywords(['相关性排序 相关性排序', '相关性排序'], 10)
  const { docs: ranked } = rankByRelevance(docs, kws, Date.now())
  assert.equal(ranked[0].rel, 'a.md')
  assert.equal(ranked[0].score, 100)
  assert.equal(ranked[1].score, 0)
})

test('rankByRelevance: 没有关键词时全部 0 分且不打乱顺序', () => {
  const docs = [
    { rel: 'a.md', mtimeMs: 2, haystack: { title: '', summary: '', body: '' } },
    { rel: 'b.md', mtimeMs: 1, haystack: { title: '', summary: '', body: '' } },
  ]
  const { docs: ranked } = rankByRelevance(docs, [], Date.now())
  assert.deepEqual(ranked.map((d) => d.rel), ['a.md', 'b.md'])
  assert.ok(ranked.every((d) => d.score === 0))
})

test('topicLabel: 用、连接前几个词', () => {
  assert.equal(topicLabel([{ term: '相关性' }, { term: '排序' }, { term: 'sidebar' }]), '相关性、排序、sidebar')
})

/* ── scan 与排序模式 ────────────────────────────────── */

test('scan: sort=time 时 score 为 null 且 mode 为 time', async () => {
  const r = await scan(PROJECT_ROOT, 10, { session: fakeSession([]), sessionId: 's', sort: 'time' })
  assert.equal(r.mode, 'time')
  assert.equal(r.topic, '')
  assert.ok(r.docs.every((d) => d.score === null))
})

test('scan: sort=relevance 且有对话时给出分数与主题', async () => {
  const session = fakeSession([
    userMessage(1, '把 better-sidebar 注册和相关性排序这两个补上'),
    assistantMessage(2, '我先做纯本地的相关性排序，再接 better-sidebar 的 registerTab。'),
    userMessage(3, '相关性排序不要调模型'),
  ])
  const r = await scan(PROJECT_ROOT, 10, { session, sessionId: 's', sort: 'relevance' })
  assert.equal(r.mode, 'relevance')
  assert.ok(r.topic.length > 0, '应给出话题标签')
  assert.ok(r.docs.every((d) => typeof d.score === 'number'), '每篇都应有分数')
  assert.ok(r.docs[0].score >= r.docs[r.docs.length - 1].score, '分数应降序')
})

test('scan: relevance 但会话无事件 → 老实退回 time', async () => {
  const r = await scan(PROJECT_ROOT, 10, { session: fakeSession([]), sessionId: 's', sort: 'relevance' })
  assert.equal(r.mode, 'time')
})

test('scan: relevance 但没有 session 对象 → 退回 time', async () => {
  const r = await scan(PROJECT_ROOT, 10, { sessionId: 's', sort: 'relevance' })
  assert.equal(r.mode, 'time')
})

test('scan: agent 注入的合成消息不算用户意图', async () => {
  const session = fakeSession([
    userMessage(1, 'AGENTS.md 项目约定：相关性排序 宿主半边 mtime 协议', 'plugin'),
  ])
  const r = await scan(PROJECT_ROOT, 10, { session, sessionId: 's', sort: 'relevance' })
  assert.equal(r.mode, 'time', '只有合成消息时应退回 time')
  assert.deepEqual(r.keywords, [])
})

test('scan: 不把内部 haystack 泄漏给浏览器', async () => {
  const session = fakeSession([userMessage(1, '相关性排序 相关性排序')])
  const r = await scan(PROJECT_ROOT, 10, { session, sessionId: 's', sort: 'relevance' })
  assert.ok(r.docs.every((d) => d.haystack === undefined), 'haystack 是内部字段')
  assert.ok(r.docs.every((d) => typeof d.rel === 'string' && typeof d.mtimeMs === 'number'))
})

test('scan: limit 生效', async () => {
  const r = await scan(PROJECT_ROOT, 2, { sessionId: 's', sort: 'time' })
  assert.ok(r.docs.length <= 2)
  assert.ok(r.total >= r.docs.length)
})

/* ── 图片与视频：扫描、类型过滤、Range、安全边界 ──────── */

/** 建一个临时工作区并写入若干文件，跑完自动清理。 */
async function withTempFiles(files, fn) {
  const dir = await mkdtemp(join(tmpdir(), 'knit-media-'))
  try {
    for (const [name, content] of Object.entries(files)) {
      await writeFile(join(dir, name), content)
    }
    await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

test('collectDocs: 同时扫出 Markdown 与媒体，媒体带 kind/size 且不读正文', async () => {
  const { docs, media } = await collectDocs(PROJECT_ROOT)
  assert.ok(docs.length > 0)
  assert.ok(docs.every((d) => d.kind === 'md'), '文档池 kind 全为 md')
  assert.ok(docs.every((d) => typeof d.size === 'number'))

  const shot = media.find((m) => m.rel.split('/').pop() === 'screenshot.png')
  assert.ok(shot, '应扫到 knit/docs/screenshot.png')
  assert.equal(shot.kind, 'image')
  assert.ok(shot.size > 0)
  assert.equal(shot.summary, '', '媒体没有正文摘要')
  assert.equal(shot.haystack.body, '')
  assert.match(shot.haystack.title, /screenshot\.png/)
})

test('scan: 默认（doc）只回 Markdown 并回显 kind=doc', async () => {
  const r = await scan(PROJECT_ROOT, 400, { sessionId: 's', sort: 'time' })
  assert.equal(r.kind, 'doc')
  assert.ok(r.docs.length > 0)
  assert.ok(r.docs.every((d) => d.kind === 'md'))
})

test('scan: kind=media 只回图片/视频，公开载荷不带 haystack', async () => {
  const r = await scan(PROJECT_ROOT, 400, { sessionId: 's', sort: 'time', kind: 'media' })
  assert.equal(r.kind, 'media')
  assert.ok(r.docs.some((d) => d.name === 'screenshot.png'))
  assert.ok(r.docs.every((d) => d.kind === 'image' || d.kind === 'video'))
  assert.ok(r.docs.every((d) => !('haystack' in d)), '媒体公开载荷也不得泄漏 haystack')
})

test('scan: kind=all 文档与媒体混排，并整体按 mtime 倒序', async () => {
  const r = await scan(PROJECT_ROOT, 400, { sessionId: 's', sort: 'time', kind: 'all' })
  assert.equal(r.kind, 'all')
  assert.ok(r.docs.some((d) => d.kind === 'md'))
  assert.ok(r.docs.some((d) => d.kind === 'image'))
  const mt = r.docs.map((d) => d.mtimeMs)
  assert.ok(mt.every((v, i) => i === 0 || mt[i - 1] >= v), '应整体按 mtime 倒序')
})

test('scan: 非法 kind 老实回落 doc', async () => {
  const r = await scan(PROJECT_ROOT, 50, { sessionId: 's', sort: 'time', kind: 'wat' })
  assert.equal(r.kind, 'doc')
  assert.ok(r.docs.every((d) => d.kind === 'md'))
})

test('parseRange: 无 Range 头或空文件回 null（交给整文件响应）', () => {
  assert.equal(parseRange(undefined, 1000), null)
  assert.equal(parseRange('', 1000), null)
  assert.equal(parseRange('bytes=0-99', 0), null)
})

test('parseRange: 解析起止区间与开放结尾', () => {
  assert.deepEqual(parseRange('bytes=0-99', 1000), { start: 0, end: 99 })
  assert.deepEqual(parseRange('bytes=0-', 1000), { start: 0, end: 999 })
  assert.deepEqual(parseRange('bytes=500-', 1000), { start: 500, end: 999 })
})

test('parseRange: bytes=-N 取最后 N 字节，超过总长则从 0 开始', () => {
  assert.deepEqual(parseRange('bytes=-500', 1000), { start: 500, end: 999 })
  assert.deepEqual(parseRange('bytes=-2000', 1000), { start: 0, end: 999 })
})

test('parseRange: end 越界截断、end 小于 start 回落整段、start 越界拒绝', () => {
  assert.deepEqual(parseRange('bytes=0-99999', 1000), { start: 0, end: 999 })
  assert.deepEqual(parseRange('bytes=500-100', 1000), { start: 500, end: 999 })
  assert.equal(parseRange('bytes=1000-', 1000), null)
})

test('parseRange: 多区间与怪异语法一律回 null', () => {
  assert.equal(parseRange('bytes=0-9,20-29', 1000), null)
  assert.equal(parseRange('bytes=-', 1000), null)
  assert.equal(parseRange('items=0-9', 1000), null)
})

test('mediaInfo: 放行白名单图片并给出类型与大小', async () => {
  await withTempFiles({ 'shot.png': Buffer.from([0x89, 0x50, 0x4e, 0x47]) }, async (dir) => {
    const r = await mediaInfo(dir, 'shot.png')
    assert.equal(r.ok, true)
    assert.equal(r.kind, 'image')
    assert.equal(r.type, 'image/png')
    assert.equal(r.size, 4)
  })
})

test('mediaInfo: 放行视频扩展名并判为 video', async () => {
  await withTempFiles({ 'clip.mp4': Buffer.from([0, 0, 0, 20]) }, async (dir) => {
    const r = await mediaInfo(dir, 'clip.mp4')
    assert.equal(r.ok, true)
    assert.equal(r.kind, 'video')
    assert.equal(r.type, 'video/mp4')
  })
})

test('mediaInfo: 拒绝非白名单扩展名（只准图片/视频）', async () => {
  await withTempFiles({ 'secret.txt': 'x' }, async (dir) => {
    const r = await mediaInfo(dir, 'secret.txt')
    assert.equal(r.ok, false)
    assert.equal(r.code, ERROR_CODES.mediaOnly)
  })
})

test('mediaInfo: 拒绝目录穿越', async () => {
  await withTempFiles({ 'a.png': Buffer.from([1]) }, async (dir) => {
    const r = await mediaInfo(dir, '../../../../etc/passwd')
    assert.equal(r.ok, false)
    assert.equal(r.code, ERROR_CODES.outsideWorkspace)
  })
})

test('mediaInfo: 文件不存在回 notFound', async () => {
  await withTempFiles({ 'a.png': Buffer.from([1]) }, async (dir) => {
    const r = await mediaInfo(dir, 'missing.png')
    assert.equal(r.ok, false)
    assert.equal(r.code, ERROR_CODES.notFound)
  })
})

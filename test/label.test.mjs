/**
 * Knit v0.8 · 「当前话题」标签的可读性回归。
 *
 * 为什么单独一个文件：v0.6 的评测只量了**排序**（top-1 / MRR），
 * 从来没量过标签 —— 于是「按「目文档、项目文」排序」这种碎片一路漏到了真机上，
 * 是**验收时用 getUserMedia 之外的手段**（读会话日志）才发现的。
 * 这个文件的唯一职责就是守住标签。
 *
 * 断言是**双向**的：
 *   - `expect`：真词必须出现（防止「什么都不显示」也算过关）
 *   - `deny`：**旧碎片必须不出现**（这是真正的回归钉）
 * 另外所有标签词都必须是**输入里真实存在的子串** —— 标签只能来自用户自己打的字。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { readableTopics, extractKeywords, rankByRelevance } from '../src/host/relevance.js'
import { CORPUS, NOW } from './eval/fixture.mjs'

/**
 * 跑一遍「抽词 → 按语料过滤 → 合并标签」的完整链路。
 * @param {string} query - 一句话
 * @returns {{label: string[], matched: string[]}} 标签与真实命中的词
 */
function labelFor(query) {
  const keywords = extractKeywords([query], 30)
  const { matched, label } = rankByRelevance(CORPUS, keywords, NOW)
  return { label, matched }
}

/**
 * 用例。`deny` 里的都是 v0.8 之前真机上出现过的碎片。
 * @type {Array<{q: string, expect: string[], deny: string[]}>}
 */
const CASES = [
  {
    // 真机验收里 agent 自己拼的 query —— 旧标签就是「目文档、项目文、索引」
    q: '项目文档 索引',
    expect: ['项目文档'],
    deny: ['目文档', '项目文'],
  },
  {
    q: '这个项目有什么文档',
    expect: ['项目', '文档'],
    deny: ['目有什', '什么文'],
  },
  {
    // 旧标签：「bm25、排序、关性排」
    q: '排序算法 相关性排序 BM25',
    expect: ['bm25', '排序算法', '相关性排序'],
    deny: ['关性排', '序算法', '性排序'],
  },
  {
    // 旧标签：「名白名、展名白、扩展名」
    q: '扩展名白名单都放行什么',
    expect: ['扩展名白名单'],
    deny: ['名白名', '展名白'],
  },
  {
    // 旧标签：「停浮层、悬停浮」
    q: '悬停浮层是怎么做的',
    expect: ['悬停浮层'],
    deny: ['停浮层', '悬停浮'],
  },
  {
    // 旧标签：「灰色太、色太深」；「对比度」被 CN_EDGE_STOP 的「对」误杀成「比度」
    q: '这个灰色太深了，读文档对比度不够',
    expect: ['对比度'],
    deny: ['比度', '灰色太', '色太深'],
  },
]

test('话题标签: 真词必须出现，旧碎片必须不出现', () => {
  // 大小写不敏感：标签是**切原文**得来的，所以保留用户自己打的大小写
  // （打 BM25 就显示 BM25，不会被小写成 bm25）。这是有意的 —— 标签就该是用户的原话。
  const has = (list, term) => list.some((x) => x === term || x.toLowerCase() === term.toLowerCase())
  for (const testCase of CASES) {
    const { label } = labelFor(testCase.q)
    const text = label.join('、')
    assert.ok(label.length > 0, `「${testCase.q}」不该没有标签`)
    for (const want of testCase.expect) {
      assert.ok(has(label, want), `「${testCase.q}」的标签应含「${want}」，实际是「${text}」`)
    }
    for (const bad of testCase.deny) {
      assert.ok(!has(label, bad), `「${testCase.q}」的标签不该含碎片「${bad}」，实际是「${text}」`)
    }
  }
})

test('话题标签: 每个词都必须是输入里真实存在的子串', () => {
  // 标签只能来自用户自己打的字 —— 合并区间时切错位置会切出输入里没有的串
  for (const testCase of CASES) {
    const { label } = labelFor(testCase.q)
    for (const term of label) {
      assert.ok(testCase.q.includes(term), `「${term}」不是「${testCase.q}」的子串`)
    }
  }
})

test('话题标签: 合并的是原文区间，不是把词拼起来', () => {
  // 两个**重叠**的碎片 → 合并成原文那一段
  const keywords = [
    { term: '项目文', weight: 27, spans: [{ text: '项目文档 索引', start: 0, end: 3 }] },
    { term: '目文档', weight: 27, spans: [{ text: '项目文档 索引', start: 1, end: 4 }] },
  ]
  assert.deepEqual(readableTopics(keywords, 3), ['项目文档'])
})

test('话题标签: 相邻但不重叠的两段不合并', () => {
  // 合并相邻段会把「相关」+「性排」粘成更难看的「相关性排」—— 所以只认严格重叠。
  // 两者权重相同，顺带不依赖 tie-break 的具体次序。
  const keywords = [
    { term: '相关', weight: 12, spans: [{ text: '相关性排序', start: 0, end: 2 }] },
    { term: '性排', weight: 12, spans: [{ text: '相关性排序', start: 2, end: 4 }] },
  ]
  const out = readableTopics(keywords, 3)
  assert.equal(out.length, 2, `相邻的两段应当各自成为一个标签，实际：${out.join('、')}`)
  assert.ok(out.includes('相关') && out.includes('性排'), `实际：${out.join('、')}`)
})

test('话题标签: 合并后过长的丢掉，不吐一长串', () => {
  const long = '一二三四五六七八九十甲乙丙丁'
  const keywords = [
    { term: '一二三', weight: 10, spans: [{ text: long, start: 0, end: 3 }] },
    { term: '二三四', weight: 10, spans: [{ text: long, start: 1, end: 4 }] },
    { term: '三四五', weight: 10, spans: [{ text: long, start: 2, end: 5 }] },
    { term: '四五六', weight: 10, spans: [{ text: long, start: 3, end: 6 }] },
    { term: '五六七', weight: 10, spans: [{ text: long, start: 4, end: 7 }] },
    { term: '六七八', weight: 10, spans: [{ text: long, start: 5, end: 8 }] },
  ]
  const out = readableTopics(keywords, 3)
  for (const term of out) {
    assert.ok(term.length <= 12, `标签「${term}」太长了`)
  }
})

test('话题标签: 没有 spans 时返回空数组（由调用方回落）', () => {
  assert.deepEqual(readableTopics([{ term: '排序', weight: 10 }], 3), [])
  assert.deepEqual(readableTopics([], 3), [])
})

test('话题标签: 按权重降序，且去重', () => {
  const keywords = [
    { term: '甲甲', weight: 5, spans: [{ text: '甲甲 乙乙', start: 0, end: 2 }] },
    { term: '乙乙', weight: 20, spans: [{ text: '甲甲 乙乙', start: 3, end: 5 }] },
    { term: '乙乙', weight: 20, spans: [{ text: '甲甲 乙乙', start: 3, end: 5 }] },
  ]
  assert.deepEqual(readableTopics(keywords, 3), ['乙乙', '甲甲'])
})

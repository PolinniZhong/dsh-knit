/**
 * 宿主 HTTP 端到端：在真实回环端口上跑 apply() 注册的路由。
 *
 * 纯函数单测覆盖不到的部分在这里验证：/raw 整文件 200、HTTP Range 206 与
 * Content-Range/字节数、安全响应头、路径越界 / 扩展名白名单 / 方法限制。
 *
 * 跑法：node --test test/host-http.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { fileURLToPath } from 'node:url'
import { stat } from 'node:fs/promises'

import { apply } from '../src/host/index.js'
import { makeWorkspace } from './fixture.mjs'

/** 测试自带样本工作区（临时目录），里面有 docs/screenshot.png 当媒体样本。 */
const PROJECT_ROOT = makeWorkspace()

/**
 * 起一个挂着 Knit 路由的回环 server（伪造 cordis 的 webServer / sessions / effect）。
 * @returns {Promise<{base:string, close:Function}>} 地址根与关闭函数
 */
async function startKnitServer() {
  let handler = null
  apply({
    inject(_deps, cb) {
      cb({
        webServer: {
          register({ handler: h }) { handler = h; return () => {} },
        },
        sessions: { get: () => ({ header: { cwd: PROJECT_ROOT } }) },
        effect(fn) { fn() },
      })
    },
  })
  assert.ok(handler, 'apply 应注册路由 handler')

  const server = http.createServer((req, res) => handler(req, res))
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}/knit`
  const close = () => new Promise((resolve) => server.close(resolve))
  return { base, close }
}

test('HTTP 端到端：媒体列表、/raw 整文件、Range 206、安全拒绝', async () => {
  const { base, close } = await startKnitServer()
  try {
    // kind=media：只回图片/视频，且扫到仓库自带截图
    let r = await fetch(`${base}/api/recent?sessionId=s&kind=media&sort=time`)
    let body = await r.json()
    assert.equal(r.status, 200)
    assert.equal(body.kind, 'media')
    assert.ok(body.docs.some((d) => d.name === 'screenshot.png'))
    assert.ok(body.docs.every((d) => d.kind === 'image' || d.kind === 'video'))
    assert.ok(body.docs.every((d) => !('haystack' in d)), '不泄漏内部 haystack')

    // kind=all：文档与媒体混合
    r = await fetch(`${base}/api/recent?sessionId=s&kind=all&sort=time`)
    body = await r.json()
    assert.equal(body.kind, 'all')
    assert.ok(body.docs.some((d) => d.kind === 'md'))
    assert.ok(body.docs.some((d) => d.kind === 'image'))

    // 缺省 kind 回落 doc
    r = await fetch(`${base}/api/recent?sessionId=s`)
    body = await r.json()
    assert.equal(body.kind, 'doc')
    assert.ok(body.docs.every((d) => d.kind === 'md'))

    // /raw 整文件：200、字节一致、安全头齐全
    const rel = 'docs/screenshot.png'
    const realSize = (await stat(`${PROJECT_ROOT}/${rel}`)).size
    r = await fetch(`${base}/api/raw?sessionId=s&rel=${encodeURIComponent(rel)}`)
    assert.equal(r.status, 200)
    assert.match(r.headers.get('content-type'), /image\/png/)
    assert.equal(r.headers.get('accept-ranges'), 'bytes')
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff')
    assert.match(r.headers.get('content-security-policy') || '', /default-src 'none'/)
    assert.equal(Number(r.headers.get('content-length')), realSize)
    assert.equal((await r.arrayBuffer()).byteLength, realSize)

    // Range 闭区间：206 + Content-Range + 100 字节
    r = await fetch(`${base}/api/raw?sessionId=s&rel=${encodeURIComponent(rel)}`, {
      headers: { Range: 'bytes=0-99' },
    })
    assert.equal(r.status, 206)
    assert.equal(r.headers.get('content-range'), `bytes 0-99/${realSize}`)
    assert.equal(Number(r.headers.get('content-length')), 100)
    assert.equal((await r.arrayBuffer()).byteLength, 100)

    // Range 后缀 bytes=-1000
    r = await fetch(`${base}/api/raw?sessionId=s&rel=${encodeURIComponent(rel)}`, {
      headers: { Range: 'bytes=-1000' },
    })
    assert.equal(r.status, 206)
    assert.equal(r.headers.get('content-range'), `bytes ${realSize - 1000}-${realSize - 1}/${realSize}`)
    assert.equal((await r.arrayBuffer()).byteLength, 1000)

    // 路径越界：404 + outside-workspace
    r = await fetch(`${base}/api/raw?sessionId=s&rel=${encodeURIComponent('../../../../etc/passwd')}`)
    body = await r.json()
    assert.equal(r.status, 404)
    assert.equal(body.code, 'knit/outside-workspace')

    // 非白名单扩展名：404 + media-only
    r = await fetch(`${base}/api/raw?sessionId=s&rel=${encodeURIComponent('package.json')}`)
    body = await r.json()
    assert.equal(r.status, 404)
    assert.equal(body.code, 'knit/media-only')

    // 非 GET：405
    r = await fetch(`${base}/api/recent?sessionId=s`, { method: 'POST' })
    assert.equal(r.status, 405)
  } finally {
    await close()
  }
})

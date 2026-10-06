import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'

// 必须在引入 index.ts 之前设置：里面的 CORS 白名单、请求体上限都是模块级读取的。
process.env.LOG_LEVEL = 'error'
process.env.OPENAI_API_KEY = ''
process.env.SONIC_MATTER_TEST = '1'
process.env.CORS_ORIGIN = 'http://allowed.example'
process.env.JSON_BODY_LIMIT = '2kb'
// 显式关掉前端静态托管，保证这里是“开发模式”的行为；SERVE_WEB=1 的场景在 webStatic.test.ts 覆盖。
delete process.env.SERVE_WEB

/** 真实应用的接口冒烟：直接拿 index.ts 导出的 app，不监听固定端口。
 *  http.ts 也要动态引入——CORS 白名单是模块级读环境变量的。 */
const { corsOrigin } = await import('./http.ts')
const { app } = await import('./index.ts')

let server: Server
let base = ''

before(async () => {
  server = app.listen(0, '127.0.0.1')
  await new Promise<void>(resolve => server.once('listening', () => resolve()))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

after(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()))
})

const post = (path: string, body: string, headers: Record<string, string> = {}) =>
  fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body })

test('没有 API Key 也能通过健康检查，并沿用客户端给的 X-Request-Id', async () => {
  const response = await fetch(`${base}/api/health`, { headers: { 'x-request-id': 'p0-health-check' } })
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('x-request-id'), 'p0-health-check')
  const body = await response.json() as { ok: boolean; agent: boolean }
  assert.equal(body.ok, true)
  assert.equal(body.agent, false)
})

test('概念解析在没有 Key 时返回本地 fallback 的三个视角', async () => {
  const response = await post('/api/concept/interpret', JSON.stringify({ concept: '冰山', agent: { apiKey: '' } }))
  assert.equal(response.status, 200)
  const body = await response.json() as { source: string; interpretations: unknown[] }
  assert.equal(body.source, 'fallback')
  assert.equal(body.interpretations.length, 3)
})

test('坏 JSON 与不合法入参都是 400，并且带上 requestId', async () => {
  const malformed = await post('/api/concept/interpret', '{"concept":')
  assert.equal(malformed.status, 400)
  const malformedBody = await malformed.json() as { code: string; requestId: string }
  assert.equal(malformedBody.code, 'bad_request')
  assert.equal(typeof malformedBody.requestId, 'string')

  const invalid = await post('/api/concept/interpret', JSON.stringify({ concept: '' }))
  assert.equal(invalid.status, 400)
})

test('超过 JSON_BODY_LIMIT 的请求给出 413 + payload_too_large，而不是上游错误', async () => {
  const huge = JSON.stringify({ concept: 'x'.repeat(8 * 1024), agent: { apiKey: '' } })
  const response = await post('/api/concept/interpret', huge)
  assert.equal(response.status, 413)
  const body = await response.json() as { code: string; status: number; requestId: string }
  assert.equal(body.code, 'payload_too_large')
  assert.equal(body.status, 413)
  assert.equal(typeof body.requestId, 'string')
})

test('CORS：名单里的来源放行，名单外的来源 403', async () => {
  const allowed = await fetch(`${base}/api/health`, { headers: { origin: 'http://allowed.example' } })
  assert.equal(allowed.status, 200)
  assert.equal(allowed.headers.get('access-control-allow-origin'), 'http://allowed.example')

  const denied = await fetch(`${base}/api/health`, { headers: { origin: 'http://evil.example' } })
  assert.equal(denied.status, 403)
  const body = await denied.json() as { code: string; status: number }
  assert.equal(body.code, 'cors_not_allowed')
  assert.equal(body.status, 403)
})

test('corsOrigin 回调：白名单为空时不限制来源，有白名单时只放行名单内来源', () => {
  const seen: Array<{ error: Error | null; allow?: boolean }> = []
  corsOrigin(undefined, (error, allow) => seen.push({ error, allow }))
  corsOrigin('http://allowed.example', (error, allow) => seen.push({ error, allow }))
  corsOrigin('http://evil.example', (error, allow) => seen.push({ error, allow }))
  assert.deepEqual(seen.map(item => item.allow), [true, true, undefined])
  assert.equal(seen[2].error?.message.includes('CORS_ORIGIN'), true)
})

test('MIDI 导出仍然返回标准头 MThd', async () => {
  const response = await post('/api/export/midi', JSON.stringify({
    project: {
      title: 'Smoke test', tempo: 92, key: 'C Major', duration: 2,
      tracks: [{ id: 'melody', name: 'Melody', kind: 'midi', instrument: 'Piano', color: '#fff', notes: [{ id: 'n1', pitch: 60, start: 0, duration: .5, velocity: 90 }] }],
    },
  }))
  assert.equal(response.status, 200)
  const bytes = new Uint8Array(await response.arrayBuffer())
  assert.deepEqual(Array.from(bytes.slice(0, 4)), [0x4d, 0x54, 0x68, 0x64])
})

test('开发模式（未设 SERVE_WEB）不托管前端，根路径仍然走 404 错误信封', async () => {
  const response = await fetch(`${base}/`)
  assert.equal(response.status, 404)
  const body = await response.json() as { code: string }
  assert.equal(body.code, 'not_found')
})

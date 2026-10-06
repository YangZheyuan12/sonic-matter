import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

// 造一个假的 web/dist：生产模式的静态托管是对着目录读文件的，不需要真实构建产物。
const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), 'sonic-matter-web-'))
const distDir = path.join(fixtureRoot, 'dist')
await mkdir(path.join(distDir, 'assets'), { recursive: true })
await writeFile(path.join(distDir, 'index.html'), '<!doctype html><title>Sonic Matter</title><div id="root"></div>')
await writeFile(path.join(distDir, 'assets', 'app.js'), 'console.log("sonic-matter")')
// 故意在 dist 外面放一个文件，用来验证静态托管不会越出根目录。
await writeFile(path.join(fixtureRoot, 'secret.txt'), 'DO-NOT-SERVE')

// 必须在引入 index.ts 之前设置：静态托管是模块级读环境变量的。
process.env.LOG_LEVEL = 'error'
process.env.OPENAI_API_KEY = ''
process.env.SONIC_MATTER_TEST = '1'
process.env.CORS_ORIGIN = ''
process.env.SERVE_WEB = '1'
process.env.WEB_DIST_DIR = distDir

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
  await rm(fixtureRoot, { recursive: true, force: true })
})

test('SERVE_WEB=1：根路径返回前端 index.html', async () => {
  const response = await fetch(`${base}/`)
  assert.equal(response.status, 200)
  assert.match(response.headers.get('content-type') ?? '', /text\/html/)
  assert.match(await response.text(), /Sonic Matter/)
})

test('SERVE_WEB=1：构建产物按真实文件返回', async () => {
  const response = await fetch(`${base}/assets/app.js`)
  assert.equal(response.status, 200)
  assert.match(response.headers.get('content-type') ?? '', /javascript/)
  assert.equal(await response.text(), 'console.log("sonic-matter")')
})

test('SERVE_WEB=1：/api 路由优先于静态托管，不会被吞掉', async () => {
  const response = await fetch(`${base}/api/health`)
  assert.equal(response.status, 200)
  const body = await response.json() as { ok: boolean }
  assert.equal(body.ok, true)
})

test('SERVE_WEB=1：静态目录里没有的路径仍然是 404 错误信封', async () => {
  const response = await fetch(`${base}/missing.js`)
  assert.equal(response.status, 404)
  const body = await response.json() as { code: string }
  assert.equal(body.code, 'not_found')
})

test('SERVE_WEB=1：静态托管不会越出 web/dist 根目录读到外部文件', async () => {
  const response = await fetch(`${base}/..%2fsecret.txt`)
  assert.ok([403, 404].includes(response.status), `期望 403/404，实际 ${response.status}`)
  assert.equal((await response.text()).includes('DO-NOT-SERVE'), false)
})

/**
 * 云端工程接口的端到端测试：真的起一个 HTTP 服务、真的落到 SQLite 文件上。
 *
 * 覆盖的是"这个 Demo 承诺了什么"：
 * - 分享链接（公开读取）确实能用；
 * - 别人的工程改不了 / 删不了（403），不是静默成功；
 * - 非法输入不会写进库；配额与大小上限给出明确的错误码；
 * - 重启进程后数据还在（证明是落盘而不是内存）；
 * - 没用到云端功能时不产生任何文件（惰性建库）。
 */
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'

// 注意：mkdtempSync 自己会建出目录，所以惰性测试要盯着一个还不存在的子目录。
const projectsDir = path.join(mkdtempSync(path.join(tmpdir(), 'sonic-projects-')), 'projects')

// 必须在引入 index.ts 之前设置：这些都是模块级读取的环境变量。
process.env.LOG_LEVEL = 'error'
process.env.OPENAI_API_KEY = ''
process.env.SONIC_MATTER_TEST = '1'
process.env.CORS_ORIGIN = ''
process.env.PROJECTS_DIR = projectsDir
delete process.env.SERVE_WEB

const { app } = await import('./index.ts')
const { ProjectStore } = await import('./projectStore.ts')

let server: Server
let base = ''

before(async () => {
  server = app.listen(0, '127.0.0.1')
  await new Promise<void>(resolve => server.once('listening', () => resolve()))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

after(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()))
  // Windows 上 SQLite 文件可能还被占用，删不掉就算了（临时目录本来也不重要）。
  try {
    rmSync(projectsDir, { recursive: true, force: true })
  } catch {
    /* 忽略 */
  }
})

const OWNER_A = 'owner-aaaaaaaaaaaaaaaa'
const OWNER_B = 'owner-bbbbbbbbbbbbbbbb'

const notesOf = (count: number) =>
  Array.from({ length: count }, (_, index) => ({ id: `n${index}`, pitch: 60 + (index % 12), start: index * 0.25, duration: 0.2, velocity: 90 }))

const projectOf = (title: string, noteCount = 4) => ({
  title,
  tempo: 120,
  key: 'C minor',
  tracks: [{ id: 't1', name: '钢琴', kind: 'midi', instrument: 'piano', color: '#ffffff', notes: notesOf(noteCount) }],
})

type CallOptions = { owner?: string; body?: unknown; method?: string }

const call = (target: string, options: CallOptions = {}) =>
  fetch(base + target, {
    method: options.method ?? (options.body === undefined ? 'GET' : 'POST'),
    headers: {
      ...(options.owner ? { 'x-sonic-owner': options.owner } : {}),
      ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  })

const save = async (owner: string, project: unknown) => {
  const response = await call('/api/projects', { owner, body: { project } })
  return { status: response.status, body: await response.json() as { id: string; title: string; path: string; revision: number; createdAt: number; updatedAt: number; code?: string } }
}

test('没人碰云端工程时不会建目录、不会建库（惰性）', () => {
  assert.equal(existsSync(projectsDir), false, `${projectsDir} 不该在被使用前出现`)
})

test('保存后拿到分享 ID，任何人用这个 ID 都能读到工程内容', async () => {
  const saved = await save(OWNER_A, projectOf('分享测试', 6))
  assert.equal(saved.status, 201)
  assert.match(saved.body.id, /^[A-Za-z0-9_-]{16}$/)
  assert.equal(saved.body.path, `/?p=${saved.body.id}`)
  assert.equal(saved.body.revision, 1)

  // 没带 owner 头也能读——分享链接的用途就是让别人打开。
  const opened = await call(`/api/projects/${saved.body.id}`)
  assert.equal(opened.status, 200)
  const body = await opened.json() as { project: { title: string; tracks: Array<{ notes: unknown[] }> }; title: string; trackCount: number }
  assert.equal(body.title, '分享测试')
  assert.equal(body.trackCount, 1)
  assert.equal(body.project.title, '分享测试')
  assert.equal(body.project.tracks[0].notes.length, 6)

  assert.equal(existsSync(path.join(projectsDir, 'projects.db')), true, '第一次保存后数据库文件应当出现')
})

test('列表只给元信息，并且按浏览器身份隔离', async () => {
  await save(OWNER_A, projectOf('A 的第二个工程'))
  await save(OWNER_B, projectOf('B 的工程'))

  const listed = await call('/api/projects', { owner: OWNER_A })
  assert.equal(listed.status, 200)
  const body = await listed.json() as { projects: Array<Record<string, unknown>>; owned: number; total: number; perOwnerLimit: number }
  assert.equal(body.owned, 2)
  assert.equal(body.total, 3)
  assert.equal(body.perOwnerLimit, 50)
  assert.deepEqual(body.projects.map(item => item.title).sort(), ['A 的第二个工程', '分享测试'])
  // 列表里不能带工程正文，否则一次请求要把几十个工程全传下来。
  for (const item of body.projects) assert.equal('project' in item, false)

  const stranger = await call('/api/projects', { owner: OWNER_B })
  const strangerBody = await stranger.json() as { projects: Array<{ title: string }> }
  assert.deepEqual(strangerBody.projects.map(item => item.title), ['B 的工程'])
})

test('云端工程保存和打开会保留游戏音频上下文', async () => {
  const project = {
    ...projectOf('上下文往返'),
    gameBrief: { title: '海底遗迹', genre: '探索解谜', gameplay: '寻找线索', world: '水下古城', references: [], scenes: [{ id: 'ruins', name: '遗迹', description: '夜晚遗迹' }], events: [] },
    soundDirection: { musicStyle: ['空旷神秘'], musicMood: ['神秘'], primaryInstruments: ['钢琴'], secondaryInstruments: [], rhythmIntensity: 20, melodicDensity: 30, ambienceLevel: 80, sfxStyle: ['写实自然'], selectedDemos: [] },
  }
  const saved = await save(OWNER_A, project)
  assert.equal(saved.status, 201)
  const opened = await call(`/api/projects/${saved.body.id}`)
  assert.equal(opened.status, 200)
  const body = await opened.json() as { project: typeof project }
  assert.equal(body.project.gameBrief.scenes[0].id, 'ruins')
  assert.equal(body.project.soundDirection.ambienceLevel, 80)
})

test('覆盖保存会递增版本号，createdAt 不变', async () => {
  const saved = await save(OWNER_A, projectOf('要改的工程', 2))
  const updated = await call(`/api/projects/${saved.body.id}`, { owner: OWNER_A, method: 'PUT', body: { project: projectOf('改过标题', 3) } })
  assert.equal(updated.status, 200)
  const body = await updated.json() as { revision: number; createdAt: number; title: string }
  assert.equal(body.revision, 2)
  assert.equal(body.title, '改过标题')
  assert.equal(body.createdAt, saved.body.createdAt)

  const reopened = await call(`/api/projects/${saved.body.id}`)
  const reopenedBody = await reopened.json() as { project: { title: string }; revision: number }
  assert.equal(reopenedBody.project.title, '改过标题')
  assert.equal(reopenedBody.revision, 2)
})

test('别的浏览器身份改不了也删不了，返回 403 而不是静默成功', async () => {
  const saved = await save(OWNER_A, projectOf('别人别动'))
  const hijack = await call(`/api/projects/${saved.body.id}`, { owner: OWNER_B, method: 'PUT', body: { project: projectOf('被改了') } })
  assert.equal(hijack.status, 403)
  assert.equal((await hijack.json() as { code: string; retryable: boolean }).code, 'forbidden')

  const steal = await call(`/api/projects/${saved.body.id}`, { owner: OWNER_B, method: 'DELETE' })
  assert.equal(steal.status, 403)

  // 内容原封不动。
  const still = await call(`/api/projects/${saved.body.id}`)
  assert.equal((await still.json() as { project: { title: string } }).project.title, '别人别动')
})

test('删除自己的工程：之后读不到，删第二次是 404', async () => {
  const saved = await save(OWNER_A, projectOf('待删除'))
  const removed = await call(`/api/projects/${saved.body.id}`, { owner: OWNER_A, method: 'DELETE' })
  assert.equal(removed.status, 200)
  assert.deepEqual(await removed.json(), { deleted: true, id: saved.body.id })

  const gone = await call(`/api/projects/${saved.body.id}`)
  assert.equal(gone.status, 404)
  assert.equal((await gone.json() as { code: string }).code, 'not_found')

  const again = await call(`/api/projects/${saved.body.id}`, { owner: OWNER_A, method: 'DELETE' })
  assert.equal(again.status, 404)
})

test('缺少或格式不对的本机标识 → 400，而不是当成匿名可写', async () => {
  const noHeader = await call('/api/projects', { body: { project: projectOf('无身份') } })
  assert.equal(noHeader.status, 400)
  assert.equal((await noHeader.json() as { code: string }).code, 'bad_request')

  const tooShort = await call('/api/projects', { owner: 'abc', body: { project: projectOf('身份太短') } })
  assert.equal(tooShort.status, 400)

  const illegalChars = await call('/api/projects', { owner: 'owner with space 123456', body: { project: projectOf('非法字符') } })
  assert.equal(illegalChars.status, 400)
})

test('工程结构不合法 → 400，并且不会写进库', async () => {
  const before = await call('/api/projects', { owner: OWNER_A })
  const beforeCount = (await before.json() as { owned: number }).owned

  const bad = await save(OWNER_A, { title: '', tempo: 999, tracks: [] })
  assert.equal(bad.status, 400)
  assert.equal(bad.body.code, 'bad_request')

  const afterCount = (await (await call('/api/projects', { owner: OWNER_A })).json() as { owned: number }).owned
  assert.equal(afterCount, beforeCount)
})

test('单个工程超过上限 → 413 payload_too_large', async () => {
  // 一条音轨最多 64 个片段、每个 source 最长 24000 字符，堆到 512 KB 以上绰绰有余。
  const clips = Array.from({ length: 32 }, (_, index) => ({
    id: `c${index}`,
    source: 'x'.repeat(24_000),
    start: 0,
    offset: 0,
    duration: 1,
    fadeIn: 0,
    fadeOut: 0,
    gain: 1,
  }))
  const huge = { ...projectOf('超大工程'), tracks: [{ id: 't1', name: '音频', kind: 'audio', instrument: 'audio', color: '#fff', notes: [], clips }] }
  const response = await call('/api/projects', { owner: OWNER_A, body: { project: huge } })
  assert.equal(response.status, 413)
  assert.equal((await response.json() as { code: string }).code, 'payload_too_large')
})

test('不存在的分享 ID → 404，文案能直接展示给用户', async () => {
  const response = await call('/api/projects/this-id-does-not-exist')
  assert.equal(response.status, 404)
  const body = await response.json() as { code: string; error: string }
  assert.equal(body.code, 'not_found')
  assert.match(body.error, /不存在|删除/)
})

test('重新打开数据库（相当于重启服务）数据还在，说明是落盘存储', async () => {
  const saved = await save(OWNER_A, projectOf('持久化验证', 5))
  const reopened = new ProjectStore(projectsDir)
  const record = reopened.get(saved.body.id)
  assert.ok(record, '新开的连接应当能读到之前保存的工程')
  assert.equal(record.title, '持久化验证')
  assert.equal(record.revision, 1)
  assert.equal(reopened.databasePath, path.join(projectsDir, 'projects.db'))
  reopened.close()
})

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { defaultApiConfig, loadPersonalConfig, normalizePersonalConfig } from './personalConfig.ts'

test('旧版个人配置只迁移 OpenAI Agent 字段并移除平台音乐与音效凭据', () => {
  const clean = normalizePersonalConfig({
    baseUrl: 'https://agent.example/v1', apiKey: 'personal-agent-key', model: 'agent-model',
    protocol: 'chat-completions', musicMode: 'audio', rememberKey: true,
    musicBaseUrl: 'https://evil.example', musicApiKey: 'legacy-music-key', musicModel: 'expensive/music',
    sfxBaseUrl: 'https://evil.example', sfxApiKey: 'legacy-sfx-key', sfxModel: 'expensive/sfx',
  })
  assert.deepEqual(clean, {
    baseUrl: 'https://agent.example/v1', apiKey: 'personal-agent-key', model: 'agent-model',
    protocol: 'chat-completions', musicMode: 'audio', rememberKey: true,
  })
  assert.equal(JSON.stringify(clean).includes('legacy-music-key'), false)
  assert.equal(JSON.stringify(clean).includes('legacy-sfx-key'), false)
})

test('未选择记住密钥时不会从浏览器存储恢复个人 OpenAI Key', () => {
  const clean = normalizePersonalConfig({ apiKey: 'temporary-key', rememberKey: false })
  assert.equal(clean.apiKey, '')
  assert.equal(clean.rememberKey, false)
  assert.equal(clean.baseUrl, defaultApiConfig.baseUrl)
  assert.equal(clean.model, defaultApiConfig.model)
})

test('加载配置时把清理后的结构写回 localStorage', () => {
  let persisted = JSON.stringify({
    apiKey: 'agent-key', rememberKey: true, musicApiKey: 'must-be-removed', sfxApiKey: 'must-be-removed',
  })
  const storage = {
    getItem: () => persisted,
    setItem: (_key: string, value: string) => { persisted = value },
  }
  const loaded = loadPersonalConfig(storage)
  assert.equal(loaded.apiKey, 'agent-key')
  assert.deepEqual(JSON.parse(persisted), loaded)
  assert.equal(persisted.includes('must-be-removed'), false)
})

test('损坏或不可访问的浏览器存储会安全回退到默认配置', () => {
  const invalidJson = { getItem: () => '{bad json', setItem: () => undefined }
  assert.deepEqual(loadPersonalConfig(invalidJson), defaultApiConfig)

  const inaccessible = {
    getItem: () => { throw new Error('storage denied') },
    setItem: () => { throw new Error('storage denied') },
  }
  assert.deepEqual(loadPersonalConfig(inaccessible), defaultApiConfig)
})

import { apiJson, type ApiOptions } from '../api/client.ts'

export type Account = { id: string; username: 'admin' | 'user'; role: 'admin' | 'user' }
export type Session = { account: Account | null; expiresAt: number | null }
export type Provider = 'replicate' | 'elevenlabs'
export type ServiceConfigStatus = {
  encryptionReady: boolean
  providers: Record<Provider, { configured: boolean; updatedAt: string | null }>
}
export type ConfigDraft = Record<Provider, string>
export type ConfigPatch = Partial<Record<Provider, string | null>>
const protection = { 'X-Sonic-Auth': '1' }

export const loadSession = (options: ApiOptions = {}) => apiJson<Session>('/api/auth/me', options)
export const loginAccount = (username: string, password: string) => apiJson<Session>('/api/auth/login', {
  method: 'POST', headers: protection, body: { username: username.trim(), password },
})
export const logoutAccount = () => apiJson<{ ok: boolean }>('/api/auth/logout', {
  method: 'POST', headers: protection, body: {},
})
export const loadServiceConfig = (options: ApiOptions = {}) => apiJson<ServiceConfigStatus>('/api/admin/service-config', options)
export const saveServiceConfig = (patch: ConfigPatch) => apiJson<ServiceConfigStatus>('/api/admin/service-config', {
  method: 'PUT', headers: protection, body: patch,
})
export const runPlatformGeneration = <T>(path: '/api/music/generate' | '/api/sfx/generate', body: unknown, options: ApiOptions = {}) =>
  apiJson<T>(path, { ...options, method: 'POST', headers: protection, body })

/** 空白输入保留已有密钥，显式选择清除才删除，避免将状态占位符写成密钥。 */
export function buildConfigPatch(draft: ConfigDraft, clear: Record<Provider, boolean>): ConfigPatch {
  const patch: ConfigPatch = {}
  for (const provider of ['replicate', 'elevenlabs'] as const) {
    if (clear[provider]) patch[provider] = null
    else if (draft[provider].trim()) patch[provider] = draft[provider].trim()
  }
  return patch
}

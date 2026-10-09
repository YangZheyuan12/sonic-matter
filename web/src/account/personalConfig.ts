export type ApiConfig = {
  baseUrl: string; apiKey: string; model: string; protocol: 'responses' | 'chat-completions'
  musicMode: 'structured' | 'audio'; rememberKey: boolean
}
export const defaultApiConfig: ApiConfig = {
  baseUrl: 'https://api.openai.com/v1', apiKey: '', model: 'gpt-4.1-mini', protocol: 'responses',
  musicMode: 'structured', rememberKey: false,
}

/** 只迁移个人 Agent 配置，清除历史音乐/音效密钥、地址和模型。 */
export function normalizePersonalConfig(value: unknown): ApiConfig {
  const saved = value && typeof value === 'object' ? value as Partial<ApiConfig> : {}
  const rememberKey = saved.rememberKey === true
  return {
    baseUrl: typeof saved.baseUrl === 'string' ? saved.baseUrl : defaultApiConfig.baseUrl,
    apiKey: rememberKey && typeof saved.apiKey === 'string' ? saved.apiKey : '',
    model: typeof saved.model === 'string' ? saved.model : defaultApiConfig.model,
    protocol: saved.protocol === 'chat-completions' ? saved.protocol : 'responses',
    musicMode: saved.musicMode === 'audio' ? saved.musicMode : 'structured', rememberKey,
  }
}

export function loadPersonalConfig(storage: Pick<Storage, 'getItem' | 'setItem'>): ApiConfig {
  try {
    const clean = normalizePersonalConfig(JSON.parse(storage.getItem('sonic-matter-agent') ?? '{}'))
    storage.setItem('sonic-matter-agent', JSON.stringify(clean))
    return clean
  } catch { return { ...defaultApiConfig } }
}

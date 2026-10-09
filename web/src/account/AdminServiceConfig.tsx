import { useEffect, useRef, useState, type FormEvent } from 'react'
import { errorMessage, isApiError } from '../api/client'
import { buildConfigPatch, loadServiceConfig, saveServiceConfig, type ConfigDraft, type Provider, type ServiceConfigStatus } from './api'

const blank = (): ConfigDraft => ({ replicate: '', elevenlabs: '' })

export default function AdminServiceConfig({ onNotice, onSessionExpired }: {
  onNotice: (message: string) => void; onSessionExpired: () => void
}) {
  const [status, setStatus] = useState<ServiceConfigStatus | null>(null)
  const [draft, setDraft] = useState(blank)
  const [clear, setClear] = useState({ replicate: false, elevenlabs: false })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [reload, setReload] = useState(0)
  const [loading, setLoading] = useState(true)
  const alive = useRef(false)
  const pending = useRef(false)

  useEffect(() => {
    alive.current = true
    const controller = new AbortController()
    void loadServiceConfig({ signal: controller.signal }).then(data => {
      if (!controller.signal.aborted) { setStatus(data); setError('') }
    }).catch(reason => {
      if (!controller.signal.aborted) {
        setError(errorMessage(reason))
        if (isApiError(reason) && reason.status === 401) onSessionExpired()
      }
    }).finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => { alive.current = false; controller.abort() }
  }, [reload, onSessionExpired])

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (pending.current || loading || !status?.encryptionReady) return
    const patch = buildConfigPatch(draft, clear)
    if (!Object.keys(patch).length) { setError('请填写新的密钥，或选择清除已有密钥。空白输入会保留原配置。'); return }
    pending.current = true
    setBusy(true)
    setError('')
    setDraft(blank())
    try {
      const saved = await saveServiceConfig(patch)
      if (alive.current) { setStatus(saved); setClear({ replicate: false, elevenlabs: false }); onNotice('平台密钥已加密保存到服务器。') }
    } catch (reason) {
      if (alive.current) {
        setError(errorMessage(reason))
        if (isApiError(reason) && reason.status === 401) onSessionExpired()
      }
    } finally { pending.current = false; if (alive.current) setBusy(false) }
  }

  const services: [Provider, string, string][] = [
    ['replicate', '音乐服务 · Replicate', 'REPLICATE_API_TOKEN'],
    ['elevenlabs', '音效服务 · ElevenLabs', 'ELEVENLABS_API_KEY'],
  ]
  return <form className="admin-service-config" onSubmit={event => void submit(event)}>
    <div className="paneltitle"><span>平台服务配置</span><span>仅管理员</span></div>
    <p>密钥只保存到服务器，不会回显或写入浏览器本地存储。个人 OpenAI 配置仍在 Agent 中管理。</p>
    {!status && !error && <p role="status">正在读取配置状态…</p>}
    {status && !status.encryptionReady && <p role="alert">服务器密钥保护参数尚未就绪，暂时无法保存，请检查服务器配置。</p>}
    <div className="settings-grid service-settings-grid">
      {services.map(([provider, title, label]) => <div className="settings-card" key={provider}>
        <div className="paneltitle"><span>{title}</span><span>{status ? status.providers[provider].configured ? '已配置' : '未配置' : '等待确认'}</span></div>
        {status?.providers[provider].updatedAt && <p>更新于 {new Date(status.providers[provider].updatedAt!).toLocaleString('zh-CN')}</p>}
        <label className="setting-row"><span>{label}</span><input type="password" autoComplete="off" maxLength={500} value={draft[provider]} disabled={busy || !status?.encryptionReady || clear[provider]} onChange={event => setDraft(current => ({ ...current, [provider]: event.target.value }))} placeholder={status?.providers[provider].configured ? '留空保留现有密钥' : '输入平台服务密钥'} /></label>
        {status?.providers[provider].configured && <label className="check-row"><input type="checkbox" checked={clear[provider]} disabled={busy || !status.encryptionReady} onChange={event => {
          setClear(current => ({ ...current, [provider]: event.target.checked }))
          setDraft(current => ({ ...current, [provider]: '' }))
        }} /><span>清除此服务密钥（保存后生效）</span></label>}
      </div>)}
    </div>
    {error && <p role="alert">{error}</p>}
    <div className="settings-actions"><button className="primary" type="submit" disabled={busy || loading || !status?.encryptionReady}>{busy ? '保存中…' : '保存平台配置'}</button><button className="secondary" type="button" disabled={busy || loading} onClick={() => { setLoading(true); setReload(value => value + 1) }}>刷新状态</button></div>
    <p className="security-note">保存后，已登录账号可使用对应平台生成服务；保存本身不会发起生成或扣费。清除密钥后将停止新的生成请求。</p>
  </form>
}

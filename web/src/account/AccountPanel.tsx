import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { errorMessage, isApiError } from '../api/client'
import { loadSession, loginAccount, logoutAccount, type Session } from './api'
import AdminServiceConfig from './AdminServiceConfig'

export default function AccountPanel({ onNotice }: { onNotice: (message: string) => void }) {
  const [session, setSession] = useState<Session>({ account: null, expiresAt: null })
  const [checking, setChecking] = useState(true)
  const [busy, setBusy] = useState(false)
  const [username, setUsername] = useState('user')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const version = useRef(0)
  const mutationPending = useRef(false)
  const mounted = useRef(false)
  const expireSession = useCallback(() => setSession({ account: null, expiresAt: null }), [])
  const invalidateRequests = useCallback(() => { version.current++ }, [])

  useEffect(() => {
    mounted.current = true
    const controller = new AbortController()
    // 历史 Demo 标记不再作为身份依据，也不迁移成真实登录。
    try { localStorage.removeItem('sonic-matter-account') } catch { /* 存储受限不影响登录 */ }
    const refresh = () => {
      if (mutationPending.current) return
      const request = ++version.current
      void loadSession({ signal: controller.signal }).then(data => {
        if (mounted.current && request === version.current) { setSession(data); setError('') }
      }).catch(reason => {
        if (mounted.current && request === version.current && !controller.signal.aborted) {
          setError(errorMessage(reason, '无法确认登录状态，请稍后重试。'))
        }
      }).finally(() => { if (mounted.current && request === version.current) setChecking(false) })
    }
    refresh()
    window.addEventListener('focus', refresh)
    return () => { mounted.current = false; invalidateRequests(); controller.abort(); window.removeEventListener('focus', refresh) }
  }, [invalidateRequests])

  const mutate = async (logout = false) => {
    if (mutationPending.current) return
    if (!logout && (!username.trim() || !password)) { setError('请输入管理员分发的账号和密码。'); return }
    const request = ++version.current
    mutationPending.current = true
    setBusy(true)
    setError('')
    const submittedPassword = password
    setPassword('')
    try {
      let data: Session
      if (logout) { await logoutAccount(); data = { account: null, expiresAt: null } }
      else data = await loginAccount(username, submittedPassword)
      if (mounted.current && request === version.current) {
        setSession(data)
        onNotice(logout ? '已退出服务器会话。' : `已登录${data.account?.role === 'admin' ? '管理员' : '使用者'}账号。`)
      }
    } catch (reason) {
      if (mounted.current && request === version.current) {
        setError(errorMessage(reason))
        if (isApiError(reason) && reason.status === 401) setSession({ account: null, expiresAt: null })
      }
    } finally {
      mutationPending.current = false
      if (mounted.current && request === version.current) setBusy(false)
    }
  }

  const submit = (event: FormEvent) => { event.preventDefault(); void mutate() }
  const account = session.account
  return <>
    <div className="settings-grid">
      <div className="settings-card">
        <div className="paneltitle"><span>ACCOUNT</span><span>{checking ? '确认身份中' : account ? account.role === 'admin' ? '管理员' : '使用者' : '未登录'}</span></div>
        {checking ? <p role="status">正在确认登录状态…</p> : account ? <div className="account-state">
          <span className="avatar">{account.username.slice(0, 1).toUpperCase()}</span>
          <div><strong>{account.username} · {account.role === 'admin' ? '管理员' : '使用者'}</strong>
            <p>{account.role === 'admin' ? '可以管理平台音乐与音效服务的密钥。' : '使用管理员分发的账号访问创作服务。'}</p>
            {session.expiresAt && <p>会话有效至 {new Date(session.expiresAt).toLocaleString('zh-CN')}</p>}
          </div>
          <button className="secondary" onClick={() => void mutate(true)} disabled={busy}>{busy ? '退出中…' : '退出登录'}</button>
        </div> : <form onSubmit={submit}>
          <label className="setting-row"><span>账号</span><input name="username" autoComplete="username" value={username} onChange={event => setUsername(event.target.value)} maxLength={64} placeholder="admin 或 user" required disabled={busy} /></label>
          <label className="setting-row"><span>密码</span><input name="password" type="password" autoComplete="current-password" value={password} onChange={event => setPassword(event.target.value)} maxLength={256} placeholder="管理员分发的密码" required disabled={busy} /></label>
          <div className="settings-actions"><button className="primary" type="submit" disabled={busy}>{busy ? '登录中…' : '登录'}</button></div>
          <p className="security-note">仅支持管理员分发的固定账号；账号密码不会保存到浏览器本地存储。</p>
        </form>}
        {error && <p role="alert">{error}</p>}
      </div>
      <div className="settings-card explain">
        <div className="paneltitle"><span>PROJECT STORAGE</span><span>BROWSER + SQLITE</span></div>
        <div className="provider"><strong>本地工程</strong><span>工程自动保存在当前浏览器，可导出 JSON 备份。</span></div>
        <div className="provider"><strong>云端工程</strong><span>在音乐工作室保存到 SQLite 并生成分享链接；链接持有者可以查看工程。</span></div>
      </div>
    </div>
    {account?.role === 'admin' && !busy && <AdminServiceConfig key={account.id} onNotice={onNotice} onSessionExpired={expireSession} />}
  </>
}

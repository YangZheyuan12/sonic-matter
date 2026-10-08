/**
 * 一次性初始化固定双账号。
 *
 * 运行方式（服务器 WorkingDirectory 为 server/）：
 *   node src/auth-init.ts
 *
 * 首次运行会生成随机密码并写入 auth/initial-credentials.txt；文件只允许
 * root 读取。已有账号不会重置密码，重复运行不会覆盖凭据文件。
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { AuthStore, createRandomPassword, FIXED_ACCOUNTS, lockCredentialsFile, type FixedPasswordInput } from './authStore.ts'

const authDir = path.resolve(process.cwd(), process.env.AUTH_DIR ?? 'auth')
const credentialsPath = path.resolve(process.env.AUTH_CREDENTIAL_FILE ?? path.join(authDir, 'initial-credentials.txt'))
const store = new AuthStore(authDir)
const existing = new Set(store.listAccounts().map(account => account.username))
const passwords: FixedPasswordInput = {}
const generated: Partial<Record<'admin' | 'user', string>> = {}

for (const account of FIXED_ACCOUNTS) {
  if (existing.has(account.username)) continue
  const password = createRandomPassword()
  passwords[account.username] = password
  generated[account.username] = password
}

let credentialsCreated = false
try {
  if (Object.keys(generated).length && existsSync(credentialsPath)) {
    throw new Error(`凭据文件已存在：${credentialsPath}。为避免覆盖它，初始化已停止。`)
  }
  const lines = [
    'Sonic Matter 固定账号初始凭据',
    `生成时间：${new Date().toISOString()}`,
    '请通过安全方式保存；应用不会再次显示这些密码。',
    '',
    ...FIXED_ACCOUNTS.map(account => `${account.role} (${account.username}): ${generated[account.username] ?? '已存在，密码未修改'}`),
    '',
  ]
  const result = store.initializeFixedAccounts(passwords, () => {
    mkdirSync(path.dirname(credentialsPath), { recursive: true, mode: 0o700 })
    writeFileSync(credentialsPath, lines.join('\n'), { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    credentialsCreated = true
    lockCredentialsFile(credentialsPath)
  })
  if (Object.keys(generated).length) {
    console.log(`已创建固定账号：admin、user。初始凭据已写入 ${credentialsPath}（不会在终端显示）。`)
  } else {
    console.log('固定账号已存在，未修改任何密码或凭据文件。')
  }
  console.log(`账号数据库：${store.databasePath}`)
  console.log(`本次新建：${result.created.length ? result.created.join('、') : '无'}`)
} catch (error) {
  if (credentialsCreated) rmSync(credentialsPath, { force: true })
  throw error
} finally {
  store.close()
}

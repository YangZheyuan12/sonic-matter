export type UnsafeAgentInstructionReason =
  | 'policy_bypass'
  | 'system_command'
  | 'credential_access'
  | 'arbitrary_network'

export type AgentInstructionSecurityResult =
  | Readonly<{ safe: true }>
  | Readonly<{
      safe: false
      reason: UnsafeAgentInstructionReason
      message: string
    }>

export type AgentEndpointSecurityResult =
  | Readonly<{ safe: true }>
  | Readonly<{ safe: false; message: string }>

const RULES: readonly Readonly<{
  reason: UnsafeAgentInstructionReason
  pattern: RegExp
  message: string
}>[] = [
  {
    reason: 'policy_bypass',
    pattern: /(?:忽略|绕过|跳过|禁用|override|bypass|ignore).{0,48}(?:规则|系统提示|审批|批准|权限|限制|tool\s*registry|工具注册|policy|approval|permission|instruction)/iu,
    message: '请求试图绕过 Agent 规则、工具注册表或人工审批。',
  },
  {
    reason: 'system_command',
    pattern: /(?:执行|运行|调用|启动|execute|run|invoke|launch).{0,48}(?:shell|powershell|cmd(?:\.exe)?|bash|\/bin\/sh|系统命令|终端命令|command\s*line)/iu,
    message: 'Agent 不具备 Shell 或系统命令执行权限。',
  },
  {
    reason: 'credential_access',
    pattern: /(?:读取|获取|显示|输出|泄露|打印|read|show|print|exfiltrate|reveal).{0,72}(?:\.env|环境变量|api[-_ ]?key|authorization|access[-_ ]?token|refresh[-_ ]?token|私钥|密码|密钥|secret|credential)/iu,
    message: 'Agent 不允许读取或输出凭据、环境变量和私钥。',
  },
  {
    reason: 'arbitrary_network',
    pattern: /(?:访问|请求|下载|上传|发送到|fetch|curl|wget|request|download|upload).{0,96}(?:https?:\/\/|任意网络|外部地址|内网|localhost|127\.0\.0\.1|169\.254\.169\.254)/iu,
    message: 'Agent 不具备访问任意网络地址的权限。',
  },
]

/**
 * 对用户指令做最小、可解释的高风险能力预检。它不是内容审核器，也不能替代工具白名单；
 * 作用是在明显要求越权时，阻止原文继续进入 Planner 供应商。
 */
export function inspectAgentInstructionSecurity(
  instruction: string,
): AgentInstructionSecurityResult {
  for (const rule of RULES) {
    if (rule.pattern.test(instruction)) {
      return { safe: false, reason: rule.reason, message: rule.message }
    }
  }
  return { safe: true }
}

function privateIpv4(hostname: string): boolean {
  if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname)) return false
  const parts = hostname.split('.').map(Number)
  if (parts.some((part) => part < 0 || part > 255)) return true
  const [first = 0, second = 0] = parts
  return first === 0 ||
    first === 10 ||
    first === 127 ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168) ||
    (first === 198 && (second === 18 || second === 19)) ||
    first >= 224
}

function privateHostname(rawHostname: string): boolean {
  const hostname = rawHostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (privateIpv4(hostname)) return true
  if (
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname.endsWith('.local') ||
    hostname.endsWith('.internal') ||
    hostname === 'metadata.google.internal'
  ) return true
  if (hostname === '::' || hostname === '::1') return true
  if (/^(?:fc|fd|fe[89ab])/i.test(hostname)) return true
  const embeddedIpv4 = hostname.match(/(?:^|:)(\d{1,3}(?:\.\d{1,3}){3})$/)?.[1]
  return embeddedIpv4 !== undefined && privateIpv4(embeddedIpv4)
}

/** 客户端自定义的模型地址只能指向无凭据的公开 HTTPS 端点。 */
export function inspectClientAgentBaseUrl(baseUrl: string | undefined): AgentEndpointSecurityResult {
  if (baseUrl === undefined) return { safe: true }
  let parsed: URL
  try {
    parsed = new URL(baseUrl)
  } catch {
    return { safe: false, message: 'Agent 服务地址不是合法 URL。' }
  }
  if (parsed.protocol !== 'https:') {
    return { safe: false, message: '客户端自定义 Agent 服务必须使用 HTTPS。' }
  }
  if (parsed.username !== '' || parsed.password !== '') {
    return { safe: false, message: 'Agent 服务地址不能内嵌用户名或密码。' }
  }
  if (privateHostname(parsed.hostname)) {
    return { safe: false, message: 'Agent 服务地址不能指向本机、内网或云元数据网络。' }
  }
  return { safe: true }
}

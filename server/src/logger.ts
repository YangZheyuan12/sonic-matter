/**
 * 极简结构化日志。
 *
 * 两个目的：
 * 1. 排查问题时能按 requestId 串起一次请求（响应头也会回传 `X-Request-Id`）。
 * 2. 永远不要把用户填的 API Key 打进日志 —— 这里做了两层脱敏：
 *    按字段名（apiKey / Authorization / token ...）整值打码，按取值形态（sk-xxx、Bearer xxx）替换片段。
 */

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const

export type LogLevel = keyof typeof LEVELS

const SECRET_KEY = /(api[-_]?key|authorization|token|secret|password|cookie)/i
const SECRET_VALUE = /(sk-[A-Za-z0-9_-]{6,}|Bearer\s+[A-Za-z0-9._-]{6,}|xi-api-key["']?\s*[:=]\s*["']?[A-Za-z0-9_-]{6,})/gi

export function redactText(text: string): string {
  return text.replace(SECRET_VALUE, '***')
}

function maskValue(value: unknown): string {
  if (typeof value === 'string') return value ? `***(${value.length})` : '***'
  return '***'
}

/** 递归脱敏：字段名命中敏感词就整值打码，字符串里的密钥片段就地替换。 */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[嵌套过深]'
  if (typeof value === 'string') return redactText(value)
  if (value instanceof Error) return { name: value.name, message: redactText(value.message) }
  if (Array.isArray(value)) return value.map(item => redact(item, depth + 1))
  if (value && typeof value === 'object') {
    const output: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      output[key] = SECRET_KEY.test(key) ? maskValue(item) : redact(item, depth + 1)
    }
    return output
  }
  return value
}

function threshold(): number {
  const configured = (process.env.LOG_LEVEL ?? 'info').toLowerCase()
  return LEVELS[configured as LogLevel] ?? LEVELS.info
}

export function log(level: LogLevel, message: string, meta?: Record<string, unknown>) {
  if (LEVELS[level] < threshold()) return
  const parts = [new Date().toISOString(), level.toUpperCase().padEnd(5), redactText(message)]
  if (meta && Object.keys(meta).length) parts.push(JSON.stringify(redact(meta)))
  const line = parts.join(' ')
  if (level === 'error') process.stderr.write(`${line}\n`)
  else process.stdout.write(`${line}\n`)
}

export const logger = {
  debug: (message: string, meta?: Record<string, unknown>) => log('debug', message, meta),
  info: (message: string, meta?: Record<string, unknown>) => log('info', message, meta),
  warn: (message: string, meta?: Record<string, unknown>) => log('warn', message, meta),
  error: (message: string, meta?: Record<string, unknown>) => log('error', message, meta),
}

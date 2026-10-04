import { test } from 'node:test'
import assert from 'node:assert/strict'
import { log, redact, redactText } from './logger.ts'

test('redact 按字段名整值打码', () => {
  const redacted = redact({
    apiKey: 'sk-abcdefghijklmnop',
    Authorization: 'Bearer abcdefghijklmnop',
    nested: { userToken: 'xyz', keep: 'visible' },
    password: 'p@ssw0rd',
    count: 3,
  }) as Record<string, unknown>
  assert.equal(redacted.apiKey, '***(19)')
  assert.equal(redacted.Authorization, '***(23)')
  assert.equal(redacted.password, '***(8)')
  assert.deepEqual(redacted.nested, { userToken: '***(3)', keep: 'visible' })
  assert.equal(redacted.count, 3)
})

test('redact 替换字符串里出现的密钥形态', () => {
  assert.equal(redactText('使用 sk-abcdef1234567890 调用'), '使用 *** 调用')
  assert.match(redactText('Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.abc'), /\*\*\*/)
  assert.equal(redactText('普通日志没有密钥'), '普通日志没有密钥')
  assert.deepEqual(redact(['sk-abcdef123456', 'plain']), ['***', 'plain'])
})

test('redact 能处理 Error 与循环深度', () => {
  const redacted = redact(new Error('bad key sk-abcdef123456')) as Record<string, unknown>
  assert.equal(redacted.name, 'Error')
  assert.equal(redacted.message, 'bad key ***')

  let deep: Record<string, unknown> = { leaf: true }
  for (let index = 0; index < 10; index += 1) deep = { child: deep }
  assert.doesNotThrow(() => JSON.stringify(redact(deep)))
})

test('日志按级别过滤并写入 stdout / stderr', () => {
  const out: string[] = []
  const err: string[] = []
  const originalOut = process.stdout.write.bind(process.stdout)
  const originalErr = process.stderr.write.bind(process.stderr)
  const originalLevel = process.env.LOG_LEVEL
  process.stdout.write = ((chunk: string) => {
    out.push(String(chunk))
    return true
  }) as typeof process.stdout.write
  process.stderr.write = ((chunk: string) => {
    err.push(String(chunk))
    return true
  }) as typeof process.stderr.write
  try {
    process.env.LOG_LEVEL = 'warn'
    log('info', '这条会被过滤')
    log('warn', '这条要留下', { requestId: 'r1', apiKey: 'sk-abcdefghijklmnop' })
    log('error', '错误写到 stderr', { code: 'internal_error' })
  } finally {
    process.stdout.write = originalOut
    process.stderr.write = originalErr
    if (originalLevel === undefined) delete process.env.LOG_LEVEL
    else process.env.LOG_LEVEL = originalLevel
  }
  assert.equal(out.length, 1)
  assert.match(out[0], /WARN\s+这条要留下/)
  assert.match(out[0], /"requestId":"r1"/)
  assert.match(out[0], /"apiKey":"\*\*\*\(19\)"/)
  assert.equal(err.length, 1)
  assert.match(err[0], /ERROR\s+错误写到 stderr/)
})

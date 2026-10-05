import { test } from 'node:test'
import assert from 'node:assert/strict'
import { z } from 'zod'
import { badRequest, errorPayload, forbiddenOrigin, fromProviderStatus, toAppError, zodDetail } from './errors.ts'

test('AppError 工厂保留 code / status / detail', () => {
  const error = badRequest('concept 必须是 1-80 个字符。', 'concept: Too big')
  assert.equal(error.message, 'concept 必须是 1-80 个字符。')
  assert.equal(error.code, 'bad_request')
  assert.equal(error.status, 400)
  assert.equal(error.retryable, false)
  assert.equal(error.detail, 'concept: Too big')
})

test('toAppError 把上游状态码翻成可重试/不可重试', () => {
  const rateLimited = toAppError(new Error('REPLICATE_CREATE_429'))
  assert.equal(rateLimited.code, 'provider_rate_limited')
  assert.equal(rateLimited.status, 429)
  assert.equal(rateLimited.retryable, true)

  const unauthorized = toAppError(new Error('ELEVENLABS_GENERATE_401'))
  assert.equal(unauthorized.code, 'provider_unauthorized')
  assert.equal(unauthorized.status, 502)
  assert.match(unauthorized.message, /API Key/)

  const unavailable = toAppError(new Error('AUDIO_DOWNLOAD_503'))
  assert.equal(unavailable.code, 'provider_unavailable')
  assert.equal(unavailable.retryable, true)
})

test('toAppError 认识 OpenAI SDK 的 .status 与缺失 Key 哨兵', () => {
  const sdkError = Object.assign(new Error('429 Too Many Requests'), { status: 429 })
  assert.equal(toAppError(sdkError).code, 'provider_rate_limited')

  const missingKey = toAppError(new Error('OPENAI_API_KEY_MISSING'))
  assert.equal(missingKey.code, 'provider_not_configured')
  assert.equal(missingKey.status, 503)

  const missingToken = toAppError(new Error('REPLICATE_API_TOKEN_MISSING'))
  assert.equal(missingToken.code, 'provider_not_configured')
  assert.equal(missingToken.detail, 'REPLICATE_API_TOKEN_MISSING')
})

test('超时与空输出被标成可重试', () => {
  const timeout = toAppError(new Error('PROVIDER_TIMEOUT'))
  assert.equal(timeout.code, 'provider_timeout')
  assert.equal(timeout.status, 504)
  assert.equal(timeout.retryable, true)

  const empty = toAppError(new Error('OPENAI_EMPTY_OUTPUT'))
  assert.equal(empty.code, 'provider_bad_response')
  assert.equal(empty.retryable, true)

  const incomplete = toAppError(new Error('OPENAI_INCOMPLETE_max_output_tokens'))
  assert.equal(incomplete.code, 'provider_bad_response')
  assert.match(incomplete.message, /截断/)
})

test('AbortError 视为客户端断开，未知异常兜底成 500', () => {
  const aborted = toAppError(Object.assign(new Error('This operation was aborted'), { name: 'AbortError' }))
  assert.equal(aborted.code, 'client_closed_request')
  assert.equal(aborted.status, 499)

  const unknown = toAppError(new Error('boom'))
  assert.equal(unknown.code, 'internal_error')
  assert.equal(unknown.status, 500)
  assert.equal(unknown.detail, 'boom')
  assert.doesNotThrow(() => toAppError(undefined))
})

test('fromProviderStatus 覆盖常见分类', () => {
  assert.equal(fromProviderStatus(408, '上游').retryable, true)
  assert.equal(fromProviderStatus(422, '上游').code, 'provider_bad_response')
  assert.equal(fromProviderStatus(422, '上游').retryable, false)
  assert.equal(fromProviderStatus(500, '上游').code, 'provider_unavailable')
})

test('errorPayload 只带非空字段，并附带 requestId', () => {
  const payload = errorPayload(badRequest('参数不对。'), 'req-1')
  assert.deepEqual(payload, {
    error: '参数不对。',
    code: 'bad_request',
    status: 400,
    retryable: false,
    requestId: 'req-1',
  })
  assert.equal('detail' in errorPayload(badRequest(' x ')), false)
})

test('zodDetail 把校验问题压成一行', () => {
  const result = z.object({ concept: z.string().min(3) }).safeParse({ concept: 'a' })
  assert.equal(result.success, false)
  if (!result.success) {
    assert.match(zodDetail(result.error), /concept:/)
    assert.equal(toAppError(result.error).code, 'provider_bad_response')
  }
})
test('body-parser 的 entity.too.large 翻成 413，而不是被当成上游拒绝', () => {
  const tooLarge = toAppError(Object.assign(new Error('request entity too large'), {
    type: 'entity.too.large',
    status: 413,
    statusCode: 413,
  }))
  assert.equal(tooLarge.code, 'payload_too_large')
  assert.equal(tooLarge.status, 413)
  assert.equal(tooLarge.retryable, false)
  assert.equal(errorPayload(tooLarge, 'req-1').code, 'payload_too_large')
})

test('来源不在 CORS_ORIGIN 名单里是 403 + cors_not_allowed', () => {
  const error = forbiddenOrigin('http://evil.example')
  assert.equal(error.code, 'cors_not_allowed')
  assert.equal(error.status, 403)
  assert.equal(error.retryable, false)
  assert.equal(error.detail, 'http://evil.example')
  assert.match(error.message, /CORS_ORIGIN/)
  assert.equal(toAppError(error), error, '已经是 AppError 就原样透传')
})


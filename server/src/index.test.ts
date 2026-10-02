import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { after, before, describe, it } from 'node:test'

process.env.OPENAI_API_KEY = ''
process.env.SONIC_MATTER_TEST = '1'

const { app } = await import('./index.js')
let server: Server
let baseUrl = ''

before(async () => {
  server = createServer(app)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert(address && typeof address === 'object')
  baseUrl = `http://127.0.0.1:${address.port}`
})

after(async () => {
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
})

describe('HTTP API smoke tests', () => {
  it('reports service health without requiring an API key', async () => {
    const response = await fetch(`${baseUrl}/api/health`, { headers: { 'x-request-id': 'p0-health-check' } })
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('x-request-id'), 'p0-health-check')
    const body = await response.json() as { ok: boolean; agent: boolean }
    assert.equal(body.ok, true)
    assert.equal(body.agent, false)
  })

  it('returns a validated local fallback for concept interpretation', async () => {
    const response = await fetch(`${baseUrl}/api/concept/interpret`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ concept: '冰山', agent: { apiKey: '' } }),
    })
    assert.equal(response.status, 200)
    const body = await response.json() as { source: string; interpretations: unknown[] }
    assert.equal(body.source, 'fallback')
    assert.equal(body.interpretations.length, 3)
  })

  it('rejects malformed JSON and invalid input with 400 responses', async () => {
    const malformed = await fetch(`${baseUrl}/api/concept/interpret`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"concept":',
    })
    assert.equal(malformed.status, 400)
    const malformedBody = await malformed.json() as { requestId: string }
    assert.equal(typeof malformedBody.requestId, 'string')

    const invalid = await fetch(`${baseUrl}/api/concept/interpret`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ concept: '' }),
    })
    assert.equal(invalid.status, 400)
  })

  it('exports a standard MIDI response for a valid project', async () => {
    const response = await fetch(`${baseUrl}/api/export/midi`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ project: {
        title: 'Smoke test', tempo: 92, key: 'C Major', duration: 2,
        tracks: [{ id: 'melody', name: 'Melody', kind: 'midi', instrument: 'Piano', color: '#fff', notes: [{ id: 'n1', pitch: 60, start: 0, duration: .5, velocity: 90 }] }],
      } }),
    })
    assert.equal(response.status, 200)
    const bytes = new Uint8Array(await response.arrayBuffer())
    assert.deepEqual(Array.from(bytes.slice(0, 4)), [0x4d, 0x54, 0x68, 0x64])
  })
})

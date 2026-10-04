import { test } from 'node:test'
import assert from 'node:assert/strict'
import { LOCAL_SOUND_CLIP_PREFIX } from '../project/model.ts'
import { decodeSoundClip, encodeSoundClip, type SoundMixer } from './sfxPreview.ts'

const mixer: SoundMixer = { length: 2.4, density: 42, brightness: 64, space: 78, compact: 35 }

/** 把任意字符串编码成 local-sfx clip，用来构造非法 / 残缺的样本。 */
const clipOf = (raw: string) => `${LOCAL_SOUND_CLIP_PREFIX}${Buffer.from(raw, 'utf8').toString('base64')}`

test('encodeSoundClip / decodeSoundClip 往返后参数不变', () => {
  const clip = encodeSoundClip('冰面下低频的开裂', mixer)
  assert.ok(clip.startsWith(LOCAL_SOUND_CLIP_PREFIX))
  // clip 会写进工程 JSON，必须是纯 ASCII，不能把中文原样塞进去
  assert.match(clip.slice(LOCAL_SOUND_CLIP_PREFIX.length), /^[A-Za-z0-9+/=]+$/)

  const decoded = decodeSoundClip(clip)
  assert.ok(decoded)
  assert.equal(decoded.description, '冰面下低频的开裂')
  assert.deepEqual(decoded.mixer, mixer)
})

test('decodeSoundClip 对缺失或非法输入返回 null，不抛异常', () => {
  assert.equal(decodeSoundClip(undefined), null)
  assert.equal(decodeSoundClip(''), null)
  assert.equal(decodeSoundClip('/generated/123.wav'), null)
  assert.equal(decodeSoundClip(`${LOCAL_SOUND_CLIP_PREFIX}!!!not-base64!!!`), null)
  assert.equal(decodeSoundClip(clipOf('这不是 JSON')), null)
  // 合法 JSON 但结构不对：缺 description
  assert.equal(decodeSoundClip(clipOf(JSON.stringify({ mixer }))), null)
  // 合法 JSON 但结构不对：缺 mixer
  assert.equal(decodeSoundClip(clipOf(JSON.stringify({ description: 'x' }))), null)
})

test('decodeSoundClip 对残缺 mixer 补默认值', () => {
  const decoded = decodeSoundClip(clipOf(JSON.stringify({ description: '残缺参数', mixer: { length: 1.5, density: '很密' } })))
  assert.ok(decoded)
  assert.equal(decoded.description, '残缺参数')
  assert.equal(decoded.mixer.length, 1.5)
  assert.equal(decoded.mixer.density, 42)
  assert.equal(decoded.mixer.brightness, 64)
  assert.equal(decoded.mixer.space, 78)
  assert.equal(decoded.mixer.compact, 35)
})

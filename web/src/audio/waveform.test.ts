import { test } from 'node:test'
import assert from 'node:assert/strict'
import { clipPeaks, peaksFromBuffer, peaksFromChannels, waveformPolygon } from './waveform.ts'

// 与源码同目录，用 Node 自带的测试运行器执行：node --test "src/**/*.test.ts"
// 波形只做纯计算，不碰 Web Audio：直接喂通道数据断言柱高。

const ramp = (length: number) => Float32Array.from({ length }, (_, index) => (index + 1) / length)

test('peaksFromChannels 每根柱取区间内最大绝对值，并归一化到 0-1', () => {
  const peaks = peaksFromChannels([ramp(100)], 10)
  assert.equal(peaks.length, 10)
  assert.equal(peaks[9], 1, '最响的一段归一化成 1')
  // 只有一根柱：整段的最大值落在柱尾。
  assert.equal(peaksFromChannels([Float32Array.from([.2, .8, .4])], 1)[0], 1)
  assert.ok(peaks.every((peak, index) => index === 0 || peak >= peaks[index - 1]), '线性上升的素材柱高单调不减')
})

test('peaksFromChannels 多声道取每根柱的最大值，短声道不会越界', () => {
  // 两条声道长度不同：按最短的那条对齐，后面的声道数据不参与。
  assert.deepEqual(peaksFromChannels([Float32Array.from([0, 0, 0, 0]), Float32Array.from([0, 1])], 2), [0, 1])
  assert.deepEqual(peaksFromChannels([Float32Array.from([.2, .2]), Float32Array.from([.8, .1])], 2), [1, .25], '第二根柱取两条声道里更大的那个（.2）再归一化')
})

test('peaksFromChannels 面对全静音 / 空数据 / 非法柱数时不抛异常', () => {
  assert.deepEqual(peaksFromChannels([new Float32Array(8)], 4), [0, 0, 0, 0], '全静音就全是 0，不做除法')
  assert.deepEqual(peaksFromChannels([], 4), [])
  assert.deepEqual(peaksFromChannels([new Float32Array(0)], 4), [])
  assert.deepEqual(peaksFromChannels([new Float32Array(8)], 0), [])
})

test('柱数比采样点多时也能给出等长的柱子：每根柱至少覆盖一个采样点', () => {
  const peaks = peaksFromChannels([Float32Array.from([.5, .75])], 4)
  assert.equal(peaks.length, 4, '柱数与请求一致，画出来的波形不会缺格')
  assert.deepEqual(peaks, [2 / 3, 2 / 3, 1, 1], '采样点不够分时相邻柱会取到同一个点，但不越界也不漏')
})

test('peaksFromBuffer 把 AudioBuffer 的通道数据喂给同一套算法', () => {
  const buffer = { numberOfChannels: 2, getChannelData: (channel: number) => channel === 0 ? Float32Array.from([.4, .4]) : Float32Array.from([.9, .1]) } as unknown as AudioBuffer
  assert.deepEqual(peaksFromBuffer(buffer, 2).map(peak => Number(peak.toFixed(3))), [1, .444])
  assert.deepEqual(peaksFromBuffer(null, 2), [])
})

test('waveformPolygon 上下对称：峰值 1 顶到边、峰值 0 贴着中线', () => {
  const points = waveformPolygon([1, 0]).split(' ')
  assert.deepEqual(points, ['0.00,1.00', '100.00,50.00', '100.00,50.00', '0.00,99.00'], '先走上边再折回下边')
  assert.equal(waveformPolygon([]), '', '没有峰值就没有多边形')
  assert.equal(waveformPolygon([.5]).split(' ').length, 2, '只有一根柱时不会除以零')
  const clamped = waveformPolygon([2]).split(' ')[0]
  assert.equal(clamped, '0.00,1.00', '超过 1 的峰值被压回边界内')
})

test('clipPeaks 只取片段裁出来的那一段素材', () => {
  const peaks = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]
  assert.deepEqual(clipPeaks(peaks, 10, 2, 3), [2, 3, 4], '入点 2s、时长 3s 的片段对应第 3-5 根柱')
  assert.deepEqual(clipPeaks(peaks, 10, 0, 100), peaks, '裁到素材末尾之外也不会越界')
  assert.deepEqual(clipPeaks(peaks, 10, -1, 1), [0], '负入点被钳到 0，且至少保留一根柱')
  assert.deepEqual(clipPeaks(peaks, 0, 2, 3), peaks, '量不出素材长度就整段显示')
  assert.deepEqual(clipPeaks([], 10, 0, 1), [], '没有波形就没有片段波形')
})

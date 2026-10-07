import assert from 'node:assert/strict'
import test from 'node:test'
import type { Project } from './model.ts'
import { projectWorkspaceSummary } from './summary.ts'

const project = (over: Partial<Project> = {}): Project => ({
  title: '测试工程', tempo: 92, key: 'C Major',
  tracks: [
    { id: 'midi', name: '旋律', kind: 'midi', instrument: 'Piano', color: '#fff', notes: [] },
    { id: 'audio', name: '音效', kind: 'audio', instrument: 'SFX', color: '#fff', clips: [] },
  ],
  ...over,
})

test('My 工程摘要区分 MIDI、音频轨和声音方向状态', () => {
  assert.deepEqual(projectWorkspaceSummary(project()), {
    trackCount: 2, midiTrackCount: 1, audioTrackCount: 1, soundDirectionConfigured: false,
  })
  assert.equal(projectWorkspaceSummary(project({ soundDirection: {
    musicStyle: [], musicMood: [], primaryInstruments: [], secondaryInstruments: [], rhythmIntensity: 50,
    melodicDensity: 50, ambienceLevel: 50, sfxStyle: [], selectedDemos: [],
  } })).soundDirectionConfigured, true)
})

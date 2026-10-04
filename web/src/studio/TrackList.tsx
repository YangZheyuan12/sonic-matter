import { useState } from 'react'
import { projectDuration, trackGain, trackPan, trackStart, type Project, type Track } from '../project/model'
import {
  canRemoveTrack,
  INSTRUMENT_PRESETS,
  instrumentOptions,
  isDrumTrack,
  MAX_TRACK_NAME,
  presetFor,
  trackNoteCount,
} from '../project/tracks'

export type TrackListProps = {
  project: Project
  /** 当前在钢琴卷帘里编辑的轨道；轨道列表会把它标出来。 */
  activeTrackId: string
  quickAddTrack: () => void
  loading: boolean
  onSelect: (id: string) => void
  onPatch: (id: string, patch: Partial<Track>) => void
  onInstrument: (id: string, instrument: string) => void
  onAdd: (instrument: string, name: string) => void
  onDuplicate: (id: string) => void
  onRemove: (id: string) => void
  onMove: (id: string, delta: number) => void
  onRename: (id: string, name: string) => void
}

const panLabel = (pan: number) => pan < -.05 ? `L${Math.round(Math.abs(pan) * 100)}` : pan > .05 ? `R${Math.round(pan * 100)}` : 'C'
const kindLabel = (track: Track) => track.kind === 'midi' ? (isDrumTrack(track) ? 'MIDI · 鼓组' : 'MIDI') : 'AUDIO'

export default function TrackList({ project, activeTrackId, quickAddTrack, loading, onSelect, onPatch, onInstrument, onAdd, onDuplicate, onRemove, onMove, onRename }: TrackListProps) {
  const duration = projectDuration(project)
  const [renaming, setRenaming] = useState('')
  const [draft, setDraft] = useState('')
  const [creating, setCreating] = useState(false)
  const [presetName, setPresetName] = useState(INSTRUMENT_PRESETS[0].label)
  const [newName, setNewName] = useState('')

  const startRename = (track: Track) => { setRenaming(track.id); setDraft(track.name) }
  const commitRename = () => { if (renaming) onRename(renaming, draft); setRenaming('') }
  const create = () => {
    onAdd(presetName, newName.trim() || presetName)
    setNewName('')
    setCreating(false)
  }
  const midiPresets = INSTRUMENT_PRESETS.filter(preset => preset.kind === 'midi')

  return <aside className="track-list">
    <div className="paneltitle"><span>TRACKS</span><span>{project.tracks.length} LAYERS</span></div>
    {project.tracks.map((track, index) => {
      const preset = presetFor(track.instrument)
      const value = preset?.label ?? track.instrument
      return <div className={`track ${track.id === activeTrackId ? 'active' : ''} ${track.muted ? 'muted' : ''}`} key={track.id}>
        <div className="track-heading">
          <button className="track-dot" aria-label={`编辑轨道 ${track.name}`} title="在钢琴卷帘里编辑这条轨道" style={{ background: track.color, boxShadow: `0 0 14px ${track.color}` }} onClick={() => onSelect(track.id)} />
          <div className="track-title">
            {renaming === track.id
              ? <input className="track-rename" autoFocus aria-label={`${track.name}轨道名`} value={draft} maxLength={MAX_TRACK_NAME} placeholder="轨道名" onChange={event => setDraft(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') commitRename(); if (event.key === 'Escape') setRenaming('') }} onBlur={commitRename} />
              : <button className="track-name" title="点击在卷帘里编辑，双击重命名" onClick={() => onSelect(track.id)} onDoubleClick={() => startRename(track)}>{track.name}</button>}
            <small>{value} · {kindLabel(track)} · {track.kind === 'midi' ? `${trackNoteCount(track)} 个音符` : '音频片段'}</small>
          </div>
          <div className="track-toggles">
            <button className={`track-toggle ${track.muted ? 'active mute' : ''}`} title="静音（M）" onClick={() => onPatch(track.id, { muted: !track.muted })}>M</button>
            <button className={`track-toggle ${track.solo ? 'active solo' : ''}`} title="独奏（S）" onClick={() => onPatch(track.id, { solo: !track.solo })}>S</button>
          </div>
        </div>
        {track.kind === 'midi' ? <label className="track-instrument">
          <span>乐器</span>
          <select aria-label={`${track.name}乐器`} value={value} onChange={event => onInstrument(track.id, event.target.value)}>{instrumentOptions(track).map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select>
        </label> : null}
        <div className="track-sliders">
          <label><span>音量 {Math.round(trackGain(track) * 100)}</span><input aria-label={`${track.name}音量`} type="range" min="0" max="1" step="0.01" value={trackGain(track)} onChange={event => onPatch(track.id, { gain: Number(event.target.value) })} /></label>
          <label><span>声像 {panLabel(trackPan(track))}</span><input aria-label={`${track.name}声像`} type="range" min="-1" max="1" step="0.01" value={trackPan(track)} onChange={event => onPatch(track.id, { pan: Number(event.target.value) })} /></label>
          <label><span>起始 {trackStart(track).toFixed(1)}s</span><input aria-label={`${track.name}起始位置`} type="range" min="0" max={Math.max(0, duration - .1)} step="0.1" value={Math.min(trackStart(track), Math.max(0, duration - .1))} onChange={event => onPatch(track.id, { start: Number(event.target.value) })} /></label>
        </div>
        <div className="track-actions">
          <button className="track-action" title="上移轨道" disabled={index === 0} onClick={() => onMove(track.id, -1)}>↑</button>
          <button className="track-action" title="下移轨道" disabled={index === project.tracks.length - 1} onClick={() => onMove(track.id, 1)}>↓</button>
          <button className="track-action" title="复制轨道（音符会一起复制）" onClick={() => onDuplicate(track.id)}>复制</button>
          <button className="track-action" title="重命名轨道" onClick={() => startRename(track)}>重命名</button>
          <button className="track-action danger" title={canRemoveTrack(project, track.id) ? '删除轨道' : '至少要保留一条轨道'} disabled={!canRemoveTrack(project, track.id)} onClick={() => onRemove(track.id)}>删除</button>
        </div>
      </div>
    })}
    {creating ? <div className="track-create">
      <label><span>乐器</span><select aria-label="新轨道乐器" value={presetName} onChange={event => setPresetName(event.target.value)}>{midiPresets.map(preset => <option key={preset.id} value={preset.label}>{preset.label}</option>)}</select></label>
      <label><span>名称</span><input aria-label="新轨道名称" value={newName} maxLength={MAX_TRACK_NAME} placeholder={presetName} onChange={event => setNewName(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') create() }} /></label>
      <div className="track-create-actions">
        <button className="secondary" onClick={create}>创建</button>
        <button className="link" onClick={() => setCreating(false)}>取消</button>
      </div>
    </div> : <button className="link track-add" onClick={() => setCreating(true)}>＋ 新建轨道</button>}
    <button className="link track-add" onClick={quickAddTrack} disabled={loading}>{loading ? '+ Agent 正在编排…' : '+ 让 Agent 添加一条轨道'}</button>
    <p className="hint">点色块或轨道名可切换卷帘里的编辑对象；双击轨道名就地重命名；↑ ↓ 调整顺序；M / S 静音与独奏；「复制」会连音符一起复制成一条新轨道；换成「鼓组」后卷帘会切成鼓件行。</p>
  </aside>
}

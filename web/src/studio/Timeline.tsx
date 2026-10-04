import { useState, type PointerEvent as ReactPointerEvent } from 'react'
import {
  CLIP_MIN_DURATION,
  clipAt,
  clipById,
  clipEnd,
  clipSourceLabel,
  clipsOf,
  moveClip,
  removeClip,
  setClipFade,
  setClipGain,
  splitClip,
  trimClipEdge,
  type Clip,
} from '../project/clips'
import { pitchName, projectDuration, trackStart, type Project, type Track } from '../project/model'

type ClipDrag = { kind: 'move' | 'start' | 'end'; trackId: string; clipId: string; startX: number; width: number }

const capturePointer = (target: HTMLElement, pointerId: number) => { try { target.setPointerCapture(pointerId) } catch { /* 合成事件没有真实指针，忽略 */ } }

/** 时间线：MIDI 车道画音符，音频车道画可编辑片段（拖动 / 裁剪 / 淡入淡出 / 增益 / 分割）。 */
export default function Timeline({ project, playhead, activeTrackId, seek, editClips, selectTrack }: {
  project: Project
  playhead: number
  activeTrackId: string
  seek: (time: number) => void
  editClips: (trackId: string, edit: (clips: Clip[]) => Clip[], label: string) => void
  selectTrack: (id: string) => void
}) {
  const [selected, setSelected] = useState<{ trackId: string; clipId: string } | null>(null)
  const [drag, setDrag] = useState<ClipDrag | null>(null)
  const duration = projectDuration(project)
  const time = (value: number) => `00:${Math.floor(value).toString().padStart(2, '0')}`
  const soloActive = project.tracks.some(track => track.solo)

  const selectedTrack = project.tracks.find(track => track.id === selected?.trackId)
  const selectedClip = selectedTrack && selected ? clipById(clipsOf(selectedTrack), selected.clipId) : undefined
  const timeAt = (clientX: number, width: number, left: number) => Math.max(0, Math.min(duration, (clientX - left) / width * duration))

  const clipPointerDown = (event: ReactPointerEvent<HTMLElement>, track: Track, clip: Clip, kind: ClipDrag['kind']) => {
    event.stopPropagation()
    const rect = event.currentTarget.closest('.timeline-grid')?.getBoundingClientRect()
    if (!rect) return
    capturePointer(event.currentTarget, event.pointerId)
    setSelected({ trackId: track.id, clipId: clip.id })
    setDrag({ kind, trackId: track.id, clipId: clip.id, startX: event.clientX, width: rect.width })
  }

  const clipPointerMove = (event: ReactPointerEvent<HTMLElement>) => {
    if (!drag) return
    if (event.buttons === 0) { setDrag(null); return }
    const delta = (event.clientX - drag.startX) / drag.width * duration
    if (drag.kind === 'move') editClips(drag.trackId, clips => moveClip(clips, drag.clipId, delta, duration), '移动片段')
    else if (drag.kind === 'start') editClips(drag.trackId, clips => trimClipEdge(clips, drag.clipId, 'start', delta), '裁剪片段')
    else editClips(drag.trackId, clips => trimClipEdge(clips, drag.clipId, 'end', delta, duration), '裁剪片段')
  }

  const splitAt = (track: Track, at: number) => {
    const hit = clipAt(clipsOf(track), at)
    if (!hit) return
    setSelected({ trackId: track.id, clipId: hit.id })
    editClips(track.id, clips => splitClip(clips, hit.id, at), '分割片段')
  }

  return <>
    <div className="timeline">
      <div className="ruler"><span />{Array.from({ length: 6 }, (_, index) => <span key={index}>{time(duration * index / 5)}</span>)}</div>
      {project.tracks.map(track => {
        const clips = clipsOf(track)
        return <div className={`lane ${track.id === activeTrackId ? 'active' : ''}${track.muted || soloActive && !track.solo ? ' dim' : ''}`} key={track.id}>
          <label>{track.name}</label>
          <div
            className="timeline-grid"
            onPointerDown={event => { if (event.target !== event.currentTarget) return; selectTrack(track.id); const rect = event.currentTarget.getBoundingClientRect(); seek(timeAt(event.clientX, rect.width, rect.left)) }}
            onDoubleClick={event => { if (event.target !== event.currentTarget) return; const rect = event.currentTarget.getBoundingClientRect(); splitAt(track, timeAt(event.clientX, rect.width, rect.left)) }}
          >
            {track.kind === 'midi'
              ? track.notes?.map(note => <i key={note.id} title={`${pitchName(note.pitch)} · ${note.start.toFixed(2)}s`} style={{ left: `${(trackStart(track) + note.start) / duration * 100}%`, width: `${Math.max(1.5, note.duration / duration * 100)}%`, top: `${((84 - note.pitch) % 6) * 13 + 9}%`, background: track.color }} />)
              : clips.map(clip => <div
                key={clip.id}
                className={`audio-clip ${selected?.clipId === clip.id ? 'selected' : ''}`}
                title={`${clipSourceLabel(clip.source)} · ${clip.start.toFixed(2)}–${clipEnd(clip).toFixed(2)}s · 入点 ${clip.offset.toFixed(2)}s · 增益 ${Math.round(clip.gain * 100)}%`}
                style={{ left: `${clip.start / duration * 100}%`, width: `${Math.max(.8, clip.duration / duration * 100)}%`, background: `linear-gradient(90deg, ${track.color}, rgba(251,113,133,.1))`, opacity: .35 + clip.gain * .65 }}
                onPointerDown={event => clipPointerDown(event, track, clip, 'move')}
                onPointerMove={clipPointerMove}
                onPointerUp={() => setDrag(null)}
                onPointerCancel={() => setDrag(null)}
              >
                <span className="clip-handle" onPointerDown={event => clipPointerDown(event, track, clip, 'start')} />
                <span className="clip-label">{clipSourceLabel(clip.source)} · {clip.duration.toFixed(1)}s</span>
                <span className="clip-handle right" onPointerDown={event => clipPointerDown(event, track, clip, 'end')} />
                {clip.fadeIn > 0 ? <i className="clip-fade in" style={{ width: `${Math.min(100, clip.fadeIn / clip.duration * 100)}%` }} /> : null}
                {clip.fadeOut > 0 ? <i className="clip-fade out" style={{ width: `${Math.min(100, clip.fadeOut / clip.duration * 100)}%` }} /> : null}
              </div>)
            }
          </div>
        </div>
      })}
      <span className="playhead" style={{ left: `calc(128px + (100% - 148px) * ${playhead / duration})` }} />
    </div>
    {selectedClip && selectedTrack ? <div className="clip-inspector">
      <div>
        <small>SELECTED CLIP</small>
        <strong>{selectedTrack.name} · {clipSourceLabel(selectedClip.source)}</strong>
      </div>
      <div>
        <small>区间 / 入点 / 增益</small>
        <strong>{selectedClip.start.toFixed(2)}–{clipEnd(selectedClip).toFixed(2)}s · {selectedClip.offset.toFixed(2)}s · {Math.round(selectedClip.gain * 100)}%</strong>
      </div>
      <label>淡入<input aria-label="片段淡入" type="range" min="0" max={selectedClip.duration.toFixed(2)} step="0.01" value={selectedClip.fadeIn} onChange={event => editClips(selectedTrack.id, clips => setClipFade(clips, selectedClip.id, 'in', Number(event.target.value)), '片段淡入')} /></label>
      <label>淡出<input aria-label="片段淡出" type="range" min="0" max={selectedClip.duration.toFixed(2)} step="0.01" value={selectedClip.fadeOut} onChange={event => editClips(selectedTrack.id, clips => setClipFade(clips, selectedClip.id, 'out', Number(event.target.value)), '片段淡出')} /></label>
      <label>增益<input aria-label="片段增益" type="range" min="0" max="1" step="0.01" value={selectedClip.gain} onChange={event => editClips(selectedTrack.id, clips => setClipGain(clips, selectedClip.id, Number(event.target.value)), '片段增益')} /></label>
      <div className="clip-actions">
        <button className="secondary" disabled={playhead <= selectedClip.start + CLIP_MIN_DURATION || playhead >= clipEnd(selectedClip) - CLIP_MIN_DURATION} onClick={() => editClips(selectedTrack.id, clips => splitClip(clips, selectedClip.id, playhead), '分割片段')}>在播放头分割</button>
        <button className="secondary" onClick={() => { setSelected(null); editClips(selectedTrack.id, clips => removeClip(clips, selectedClip.id), '删除片段') }}>删除片段</button>
      </div>
    </div> : <p className="hint">音频轨道上的片段可以拖动改位置、拖左右边缘裁剪、双击分割；选中片段后调整淡入 / 淡出 / 增益，播放与 WAV / MP3 导出都会带上这些设置。</p>}
  </>
}

import { useRef, useState, type KeyboardEvent, type MouseEvent, type PointerEvent } from 'react'
import { pitchName, projectDuration, type Note, type Project, type Track } from '../project/model'
import {
  copyNotes,
  deleteNotes,
  FREE_STEP_SECONDS,
  makeNoteIds,
  mergeNotes,
  MIN_NOTE_DURATION,
  moveNotes,
  notesInRange,
  nudgeNotes,
  pasteNotes,
  pasteOffsetFor,
  quantizeNotes,
  resizeNotes,
  ROLL_HIGH_PITCH,
  ROLL_LOW_PITCH,
  ROLL_ROWS,
  setVelocity,
  snapDuration,
  snapSeconds,
  snapTime,
  sortNotes,
  summarizeSelection,
  toggleSelection,
  replaceSelection,
  type NoteWindow,
  type SnapChoice,
} from '../project/notes'

type DragMode = 'move' | 'resize'
type Drag = { mode: DragMode; ids: string[]; base: Note[]; startX: number; startY: number }
type Marquee = { x0: number; y0: number; x1: number; y1: number; moved: boolean }

const SNAP_OPTIONS: Array<{ value: SnapChoice; label: string }> = [
  { value: '1/4', label: '1/4 拍' },
  { value: '1/8', label: '1/8 拍' },
  { value: '1/16', label: '1/16 拍' },
  { value: 'off', label: '自由（不吸附）' },
]

/** 指针捕获：合成事件或已被系统释放的指针会抛错，这里忽略即可，不影响拖拽本身。 */
const capturePointer = (element: Element, pointerId: number) => { try { element.setPointerCapture(pointerId) } catch { /* 忽略 */ } }

/** 框选判定的最小拖动距离（像素），低于它视为单击新增。 */
const MARQUEE_THRESHOLD = 4

export default function PianoRoll({ project, playhead = 0, updateTrack }: { project: Project; playhead?: number; updateTrack: (id: string, patch: Partial<Track>, label?: string) => void }) {
  const midiTracks = project.tracks.filter(track => track.kind === 'midi')
  const [trackId, setTrackId] = useState(midiTracks[0]?.id ?? '')
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [snapChoice, setSnapChoice] = useState<SnapChoice>('1/8')
  const [drag, setDrag] = useState<Drag | null>(null)
  const [marquee, setMarquee] = useState<Marquee | null>(null)
  const [clipboard, setClipboard] = useState<Note[]>([])
  const gridRef = useRef<HTMLDivElement>(null)

  const track = midiTracks.find(item => item.id === trackId) ?? midiTracks[0]
  const notes = sortNotes(track?.notes ?? [])
  const duration = projectDuration(project)
  const beat = 60 / project.tempo
  const snap = snapSeconds(snapChoice, beat)
  const window: NoteWindow = { duration, snap, lowPitch: ROLL_LOW_PITCH, highPitch: ROLL_HIGH_PITCH }
  // 选中集合直接从渲染期派生：音符被删除或轨道被替换后失效的 id 会自动被过滤掉，不需要 effect 回写状态。
  const selection = selectedIds.filter(id => notes.some(item => item.id === id))
  const summary = summarizeSelection(notes, selection)
  const soleNote = summary && summary.count === 1 ? notes.find(item => item.id === selection[0]) : undefined

  const write = (next: Note[]) => { if (track) updateTrack(track.id, { notes: sortNotes(next) }, '编辑音符') }
  const applyPatches = (patches: Note[]) => { if (patches.length) write(mergeNotes(notes, patches)) }
  const focusGrid = () => gridRef.current?.focus({ preventScroll: true })
  const gridRect = () => {
    const rect = gridRef.current?.getBoundingClientRect()
    return rect && rect.width > 0 && rect.height > 0 ? rect : null
  }
  const rowAt = (rect: DOMRect, clientY: number) => Math.min(ROLL_ROWS - 1, Math.max(0, Math.floor((clientY - rect.top) / rect.height * ROLL_ROWS)))
  const pitchAt = (rect: DOMRect, clientY: number) => ROLL_HIGH_PITCH - rowAt(rect, clientY)
  const timeAt = (rect: DOMRect, clientX: number) => (clientX - rect.left) / rect.width * duration

  const addNote = (rect: DOMRect, clientX: number, clientY: number, additive: boolean) => {
    if (!track) return
    const length = snap > 0 ? snap : Math.max(MIN_NOTE_DURATION, beat / 2)
    const [id] = makeNoteIds(track.id, notes, 1)
    const fresh: Note = { id, pitch: pitchAt(rect, clientY), start: snapTime(timeAt(rect, clientX), snap, duration), duration: length, velocity: 90 }
    write([...notes, fresh])
    setSelectedIds(current => (additive ? [...current, id] : [id]))
  }

  const removeSelection = (ids: string[]) => {
    if (!ids.length) return
    write(deleteNotes(notes, ids))
    setSelectedIds(current => current.filter(id => !ids.includes(id)))
  }

  const selectInMarquee = (rect: DOMRect, box: Marquee, additive: boolean) => {
    const [from, to] = [Math.min(box.x0, box.x1), Math.max(box.x0, box.x1)]
    const [top, bottom] = [Math.min(box.y0, box.y1), Math.max(box.y0, box.y1)]
    const hits = notesInRange(notes, {
      startTime: from / rect.width * duration,
      endTime: to / rect.width * duration,
      lowPitch: ROLL_HIGH_PITCH - rowAt(rect, rect.top + bottom),
      highPitch: ROLL_HIGH_PITCH - rowAt(rect, rect.top + top),
    })
    setSelectedIds(current => (additive ? [...new Set([...current, ...hits])] : hits))
  }

  const gridPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) return
    const rect = gridRect()
    if (!rect) return
    capturePointer(event.currentTarget, event.pointerId)
    focusGrid()
    setMarquee({ x0: event.clientX - rect.left, y0: event.clientY - rect.top, x1: event.clientX - rect.left, y1: event.clientY - rect.top, moved: false })
  }

  const gridPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (!marquee) return
    const rect = gridRect()
    if (!rect) return
    const x = event.clientX - rect.left
    const y = event.clientY - rect.top
    setMarquee({ ...marquee, x1: x, y1: y, moved: marquee.moved || Math.hypot(x - marquee.x0, y - marquee.y0) > MARQUEE_THRESHOLD })
  }

  const gridPointerUp = (event: PointerEvent<HTMLDivElement>) => {
    if (!marquee) { setDrag(null); return }
    const box = marquee
    const rect = gridRect()
    setMarquee(null)
    if (!rect) return
    if (box.moved) { selectInMarquee(rect, box, event.shiftKey); return }
    if (!event.shiftKey) setSelectedIds([])
    addNote(rect, event.clientX, event.clientY, event.shiftKey)
  }

  const notePointerDown = (event: PointerEvent<HTMLElement>, note: Note, mode: DragMode) => {
    if (!track) return
    event.stopPropagation()
    capturePointer(event.currentTarget, event.pointerId)
    focusGrid()
    let ids = selection
    if (event.shiftKey) {
      ids = toggleSelection(ids, note.id)
      setSelectedIds(ids)
      if (!ids.includes(note.id)) return
    } else if (!ids.includes(note.id)) {
      ids = replaceSelection(ids, note.id)
      setSelectedIds(ids)
    }
    const target = new Set(ids)
    setDrag({ mode, ids: [...ids], base: notes.filter(item => target.has(item.id)).map(item => ({ ...item })), startX: event.clientX, startY: event.clientY })
  }

  const notePointerMove = (event: PointerEvent<HTMLElement>) => {
    if (!drag) return
    // 指针在编辑区外释放（或有合成事件）时兜底结束拖拽，避免松手后继续跟着鼠标走。
    if (event.buttons === 0) { setDrag(null); return }
    const rect = gridRect()
    if (!rect) return
    if (drag.mode === 'resize') {
      applyPatches(resizeNotes(drag.base, drag.ids, timeAt(rect, event.clientX) - timeAt(rect, drag.startX), window))
      return
    }
    applyPatches(moveNotes(drag.base, drag.ids, { time: timeAt(rect, event.clientX) - timeAt(rect, drag.startX), pitch: -Math.round((event.clientY - drag.startY) / rect.height * ROLL_ROWS) }, window))
  }

  const noteContextMenu = (event: MouseEvent<HTMLElement>, note: Note) => {
    event.preventDefault()
    removeSelection(selection.includes(note.id) ? selection : [note.id])
  }

  const copySelection = () => { if (selection.length) setClipboard(copyNotes(notes, selection)) }

  const pasteAt = (items: Note[], offset: number) => {
    if (!track || !items.length) return
    const result = pasteNotes(notes, items, { offset, duration, snap, lowPitch: ROLL_LOW_PITCH, highPitch: ROLL_HIGH_PITCH, makeIds: count => makeNoteIds(track.id, notes, count) })
    if (!result.ids.length) return
    write(result.notes)
    setSelectedIds(result.ids)
  }

  const pasteClipboard = () => { if (clipboard.length) pasteAt(clipboard, pasteOffsetFor(playhead, Math.min(...clipboard.map(item => item.start)), snap)) }
  const duplicateSelection = () => { if (selection.length) pasteAt(copyNotes(notes, selection), snap > 0 ? snap : FREE_STEP_SECONDS) }
  const quantizeSelection = () => applyPatches(quantizeNotes(notes, selection, window))
  const transposeSelection = (semitones: number) => applyPatches(nudgeNotes(notes, selection, { semitones }, window))
  const setSelectionVelocity = (velocity: number) => applyPatches(setVelocity(notes, selection, velocity))
  const patchSelection = (patch: Partial<Note>) => {
    const target = new Set(selection)
    const patches: Note[] = []
    for (const item of notes) {
      if (!target.has(item.id)) continue
      const next = { ...item, ...patch }
      if (next.pitch !== item.pitch || next.start !== item.start || next.duration !== item.duration || next.velocity !== item.velocity) patches.push(next)
    }
    applyPatches(patches)
  }

  const keyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const meta = event.metaKey || event.ctrlKey
    const key = event.key.toLowerCase()
    if (meta && key === 'a') { event.preventDefault(); setSelectedIds(notes.map(item => item.id)); return }
    if (meta && key === 'c') { event.preventDefault(); copySelection(); return }
    if (meta && key === 'x') { event.preventDefault(); copySelection(); removeSelection(selection); return }
    if (meta && key === 'v') { event.preventDefault(); pasteClipboard(); return }
    if (meta && key === 'd') { event.preventDefault(); duplicateSelection(); return }
    if (event.key === 'Escape') { setSelectedIds([]); return }
    if (event.key === 'Delete' || event.key === 'Backspace') { event.preventDefault(); removeSelection(selection); return }
    const vertical = event.key === 'ArrowUp' ? 1 : event.key === 'ArrowDown' ? -1 : 0
    const horizontal = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0
    if (!vertical && !horizontal) return
    if (!selection.length) return
    event.preventDefault()
    if (vertical) transposeSelection(vertical * (event.shiftKey ? 12 : 1))
    else applyPatches(nudgeNotes(notes, selection, { steps: horizontal * (event.shiftKey ? 4 : 1) }, window))
  }

  const activeCount = summary?.count ?? 0
  return <section className="piano-roll-panel">
    <div className="paneltitle">
      <span>PIANO ROLL</span>
      <span>DAW EDITOR · CLICK ADD · DRAG MOVE · SHIFT SELECT · MARQUEE</span>
    </div>
    <div className="piano-roll-toolbar">
      <select aria-label="编辑 MIDI 轨道" value={track?.id ?? ''} onChange={event => { setTrackId(event.target.value); setSelectedIds([]) }}>{midiTracks.map(item => <option key={item.id} value={item.id}>{item.name} · {item.instrument}</option>)}</select>
      <label className="quantize-control">
        <span>吸附</span>
        <select aria-label="钢琴卷帘吸附网格" value={snapChoice} onChange={event => setSnapChoice(event.target.value as SnapChoice)}>{SNAP_OPTIONS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select>
      </label>
      <div className="roll-actions">
        <button className="roll-action" onClick={copySelection} disabled={!activeCount} title="复制选中音符（Ctrl/Cmd + C）">复制</button>
        <button className="roll-action" onClick={pasteClipboard} disabled={!clipboard.length} title="粘贴到播放头（Ctrl/Cmd + V）">粘贴</button>
        <button className="roll-action" onClick={duplicateSelection} disabled={!activeCount} title="原位错开一格复制（Ctrl/Cmd + D）">再制</button>
        <button className="roll-action" onClick={quantizeSelection} disabled={!activeCount || snap <= 0} title="把选中音符吸附到当前网格">量化</button>
        <button className="roll-action" onClick={() => setSelectedIds(notes.map(item => item.id))} disabled={!notes.length}>全选</button>
        <button className="roll-action" onClick={() => removeSelection(selection)} disabled={!activeCount}>删除</button>
        <button className="roll-action" onClick={() => { write([]); setSelectedIds([]) }} disabled={!notes.length}>清空</button>
      </div>
    </div>
    <div className="roll-status">
      <span>网格 {snap > 0 ? `${snap.toFixed(2)}s` : '自由'} · 音域 {pitchName(ROLL_LOW_PITCH)}–{pitchName(ROLL_HIGH_PITCH)} · {notes.length} 个音符</span>
      <span>{activeCount ? `已选 ${activeCount} 个 · 方向键微调 · Shift + 方向键 = 4 格 / 八度` : '点击空白新增 · 拖动框选 · Shift + 点击加选'}</span>
    </div>
    <div className="piano-roll">
      <div className="piano-keys">{Array.from({ length: ROLL_ROWS }, (_, index) => { const pitch = ROLL_HIGH_PITCH - index; return <span key={pitch} className={pitch % 12 === 1 || pitch % 12 === 3 || pitch % 12 === 6 || pitch % 12 === 8 || pitch % 12 === 10 ? 'black-key' : ''}>{pitchName(pitch)}</span> })}</div>
      <div
        ref={gridRef}
        className="roll-grid"
        tabIndex={0}
        role="application"
        aria-label="钢琴卷帘编辑器"
        onPointerDown={gridPointerDown}
        onPointerMove={gridPointerMove}
        onPointerUp={gridPointerUp}
        onPointerCancel={() => setMarquee(null)}
        onKeyDown={keyDown}
      >
        {Array.from({ length: ROLL_ROWS }, (_, index) => <i className="roll-row" key={index} style={{ top: `${index / ROLL_ROWS * 100}%`, height: `${100 / ROLL_ROWS}%` }} />)}
        {Array.from({ length: Math.floor(duration / (snap || beat / 4)) + 1 }, (_, index) => <i className={`roll-beat ${index % 2 === 0 ? 'strong' : ''}`} key={index} style={{ left: `${index * (snap || beat / 4) / duration * 100}%` }} />)}
        {notes.map(note => <button
          key={note.id}
          className={`roll-note ${selection.includes(note.id) ? 'selected' : ''}`}
          title={`${pitchName(note.pitch)} · ${note.start.toFixed(2)}s · ${note.duration.toFixed(2)}s · 力度 ${note.velocity}`}
          style={{ left: `${note.start / duration * 100}%`, top: `${(ROLL_HIGH_PITCH - note.pitch) / ROLL_ROWS * 100}%`, width: `${Math.max(.8, note.duration / duration * 100)}%`, height: `${Math.max(2.5, 100 / ROLL_ROWS - .8)}%`, background: track?.color }}
          onPointerDown={event => notePointerDown(event, note, 'move')}
          onPointerMove={notePointerMove}
          onPointerUp={() => setDrag(null)}
          onPointerCancel={() => setDrag(null)}
          onContextMenu={event => noteContextMenu(event, note)}
        >
          <span className="roll-note-label">{pitchName(note.pitch)}</span>
          <i className="roll-resize" onPointerDown={event => notePointerDown(event, note, 'resize')} />
        </button>)}
        {marquee?.moved ? <span className="roll-marquee" style={{ left: Math.min(marquee.x0, marquee.x1), top: Math.min(marquee.y0, marquee.y1), width: Math.abs(marquee.x1 - marquee.x0), height: Math.abs(marquee.y1 - marquee.y0) }} /> : null}
      </div>
    </div>
    <div className="note-inspector">
      <div>
        <small>{activeCount > 1 ? 'MULTI SELECTION' : 'SELECTED NOTE'}</small>
        <strong>{activeCount > 1 ? `${activeCount} 个音符` : soleNote ? pitchName(soleNote.pitch) : '未选择'}</strong>
      </div>
      {activeCount > 1 ? <div>
        <small>音高范围 / 时间范围</small>
        <strong>{pitchName(summary!.lowPitch)}–{pitchName(summary!.highPitch)} · {summary!.minStart.toFixed(2)}–{summary!.maxEnd.toFixed(2)}s</strong>
      </div> : <label>音高<input aria-label="选中音符音高" type="number" min={ROLL_LOW_PITCH} max={ROLL_HIGH_PITCH} value={soleNote?.pitch ?? 60} disabled={!soleNote} onChange={event => patchSelection({ pitch: Math.round(Number(event.target.value)) })} /></label>}
      {activeCount > 1 ? <div className="roll-nudge-cell">
        <small>移调（半音）</small>
        <span className="roll-nudge">
          <button className="roll-action" onClick={() => transposeSelection(-12)}>−12</button>
          <button className="roll-action" onClick={() => transposeSelection(-1)}>−1</button>
          <button className="roll-action" onClick={() => transposeSelection(1)}>+1</button>
          <button className="roll-action" onClick={() => transposeSelection(12)}>+12</button>
        </span>
      </div> : <label>起点(s)<input aria-label="选中音符起点" type="number" min="0" max={duration} step="0.01" value={soleNote?.start.toFixed(2) ?? '0.00'} disabled={!soleNote} onChange={event => patchSelection({ start: snapTime(Number(event.target.value), snap, duration) })} /></label>}
      {activeCount > 1 ? <label>力度<input aria-label="选中音符力度" type="number" min="1" max="127" value={summary!.minVelocity} onChange={event => setSelectionVelocity(Number(event.target.value))} /></label> : <label>时长(s)<input aria-label="选中音符时长" type="number" min={Math.max(MIN_NOTE_DURATION, snap).toFixed(2)} max={duration} step="0.01" value={soleNote?.duration.toFixed(2) ?? MIN_NOTE_DURATION.toFixed(2)} disabled={!soleNote} onChange={event => patchSelection({ duration: snapDuration(Number(event.target.value), soleNote?.start ?? 0, snap, duration) })} /></label>}
      {activeCount > 1 ? null : <label>力度<input aria-label="选中音符力度" type="number" min="1" max="127" value={soleNote?.velocity ?? 90} disabled={!soleNote} onChange={event => setSelectionVelocity(Number(event.target.value))} /></label>}
      <div className="roll-inspector-actions">
        <button className="roll-action" onClick={quantizeSelection} disabled={!activeCount || snap <= 0}>量化选中</button>
        <button className="secondary" onClick={() => removeSelection(selection)} disabled={!activeCount}>删除选中</button>
      </div>
    </div>
    <p className="hint">点击空白新增；拖动音符改变时间和音高，拖右下角改变时长；拖动空白框选、Shift + 点击加选；方向键微调（Shift 为 4 格 / 八度）；Ctrl/Cmd + C/V/D 复制、粘贴到播放头（播放头靠前时错开一格）、再制；Ctrl/Cmd + A 全选；Delete 删除；右键删除。力度与吸附网格会立即写回 Project JSON。</p>
  </section>
}

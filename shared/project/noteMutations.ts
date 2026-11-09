export const MAX_NOTES_PER_TRACK = 4_096

export type NoteMutationNote = Readonly<{
  id: string
  pitch: number
  start: number
  duration: number
  velocity: number
}>

export type NoteMutationTrack<Note extends NoteMutationNote> = Readonly<{
  id: string
  kind: 'midi' | 'audio'
  notes?: readonly Note[]
}>

export type NoteMutationProject<Note extends NoteMutationNote, Track extends NoteMutationTrack<Note>> =
  Readonly<{
    duration?: number
    tracks: readonly Track[]
  }>

export type NoteMutationErrorCode =
  | 'track_not_found'
  | 'non_midi_track'
  | 'note_limit_reached'
  | 'duplicate_note_id'
  | 'invalid_note'
  | 'note_out_of_project_bounds'

export type NoteMutationError = Readonly<{
  code: NoteMutationErrorCode
  message: string
  shouldTerminate: boolean
}>

export type NoteMutationResult<Project> =
  | Readonly<{ ok: true; changed: boolean; project: Project }>
  | Readonly<{ ok: false; error: NoteMutationError }>

function rejected(
  code: NoteMutationErrorCode,
  message: string,
  shouldTerminate: boolean,
): NoteMutationResult<never> {
  return { ok: false, error: { code, message, shouldTerminate } }
}

function sameNotes<Note extends NoteMutationNote>(
  current: readonly Note[],
  replacement: readonly Note[],
): boolean {
  return current.length === replacement.length && current.every((note, index) => {
    const next = replacement[index]
    return next !== undefined && note.id === next.id && note.pitch === next.pitch &&
      note.start === next.start && note.duration === next.duration &&
      note.velocity === next.velocity
  })
}

/**
 * 原子地替换一条 MIDI 轨的全部音符。所有音符先完成业务校验，
 * 校验失败时不会创建或暴露部分修改过的工程快照。
 */
export function replaceTrackNotesSnapshot<
  Note extends NoteMutationNote,
  Track extends NoteMutationTrack<Note>,
  Project extends NoteMutationProject<Note, Track>,
>(
  project: Project,
  trackId: string,
  notes: readonly Note[],
): NoteMutationResult<Project> {
  const trackIndex = project.tracks.findIndex((track) => track.id === trackId)
  if (trackIndex < 0) {
    return rejected(
      'track_not_found',
      `未找到轨道“${trackId}”，请重新检查工程后再试。`,
      false,
    )
  }

  const track = project.tracks[trackIndex]
  if (track.kind !== 'midi') {
    return rejected(
      'non_midi_track',
      `轨道“${trackId}”不是 MIDI 轨，不能写入音符。`,
      false,
    )
  }

  if (notes.length > MAX_NOTES_PER_TRACK) {
    return rejected(
      'note_limit_reached',
      `单条轨道最多只能包含 ${MAX_NOTES_PER_TRACK} 个音符。`,
      true,
    )
  }

  const duration = project.duration ?? 10
  const ids = new Set<string>()
  for (const [index, note] of notes.entries()) {
    if (
      !note.id || !Number.isInteger(note.pitch) || note.pitch < 0 || note.pitch > 127 ||
      !Number.isFinite(note.start) || note.start < 0 ||
      !Number.isFinite(note.duration) || note.duration <= 0 ||
      !Number.isInteger(note.velocity) || note.velocity < 1 || note.velocity > 127
    ) {
      return rejected(
        'invalid_note',
        `第 ${index + 1} 个音符包含非法的 ID、音高、起点、时长或力度。`,
        true,
      )
    }

    if (ids.has(note.id)) {
      return rejected(
        'duplicate_note_id',
        `音符 ID“${note.id}”重复，请为每个音符提供唯一 ID。`,
        false,
      )
    }
    ids.add(note.id)

    if (note.start >= duration || note.start + note.duration > duration) {
      return rejected(
        'note_out_of_project_bounds',
        `音符“${note.id}”超出工程的 ${duration} 秒边界。`,
        false,
      )
    }
  }

  if (sameNotes(track.notes ?? [], notes)) {
    return { ok: true, changed: false, project }
  }

  const tracks = project.tracks.map((item, index) =>
    index === trackIndex ? ({ ...item, notes: [...notes] } as Track) : item,
  )
  return {
    ok: true,
    changed: true,
    project: { ...project, tracks } as Project,
  }
}

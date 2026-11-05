export const MAX_PROJECT_TRACKS = 32

export type MutableTrackFields = Readonly<{
  name?: string
  instrument?: string
  color?: string
  gain?: number
  pan?: number
  muted?: boolean
  solo?: boolean
  start?: number
}>

export type TrackMutationTrack = Readonly<{
  id: string
  name: string
  instrument: string
  color: string
  gain?: number
  pan?: number
  muted?: boolean
  solo?: boolean
  start?: number
}>

export type TrackMutationProject<Track extends TrackMutationTrack> = Readonly<{
  tracks: readonly Track[]
}>

export type TrackMutationErrorCode =
  | 'track_id_conflict'
  | 'track_limit_reached'
  | 'track_not_found'
  | 'last_track_removal_forbidden'
  | 'invalid_track_update'

export type TrackMutationError = Readonly<{
  code: TrackMutationErrorCode
  message: string
  shouldTerminate: boolean
}>

export type TrackMutationResult<Project> =
  | Readonly<{
      ok: true
      changed: boolean
      project: Project
    }>
  | Readonly<{
      ok: false
      error: TrackMutationError
    }>

function rejected(
  code: TrackMutationErrorCode,
  message: string,
  shouldTerminate: boolean,
): TrackMutationResult<never> {
  return {
    ok: false,
    error: { code, message, shouldTerminate },
  }
}

function projectWithTracks<
  Track extends TrackMutationTrack,
  Project extends TrackMutationProject<Track>,
>(project: Project, tracks: readonly Track[]): Project {
  return { ...project, tracks } as Project
}

export function addTrackSnapshot<
  Track extends TrackMutationTrack,
  Project extends TrackMutationProject<Track>,
>(project: Project, track: Track): TrackMutationResult<Project> {
  if (project.tracks.some((item) => item.id === track.id)) {
    return rejected(
      'track_id_conflict',
      `轨道 ID“${track.id}”已存在，请更换 ID 后重试。`,
      false,
    )
  }

  if (project.tracks.length >= MAX_PROJECT_TRACKS) {
    return rejected(
      'track_limit_reached',
      `工程最多只能包含 ${MAX_PROJECT_TRACKS} 条轨道。`,
      true,
    )
  }

  return {
    ok: true,
    changed: true,
    project: projectWithTracks(project, [...project.tracks, track]),
  }
}

function validateUpdate(update: MutableTrackFields): TrackMutationError | undefined {
  if (Object.keys(update).length === 0) {
    return {
      code: 'invalid_track_update',
      message: '轨道更新至少需要包含一个字段。',
      shouldTerminate: true,
    }
  }

  if (update.name !== undefined && (!update.name.trim() || update.name.length > 40)) {
    return {
      code: 'invalid_track_update',
      message: '轨道名不能为空，且不能超过 40 个字符。',
      shouldTerminate: true,
    }
  }

  if (
    update.instrument !== undefined &&
    (!update.instrument.trim() || update.instrument.length > 60)
  ) {
    return {
      code: 'invalid_track_update',
      message: '乐器名不能为空，且不能超过 60 个字符。',
      shouldTerminate: true,
    }
  }

  if (update.color !== undefined && (!update.color.trim() || update.color.length > 32)) {
    return {
      code: 'invalid_track_update',
      message: '轨道颜色不能为空，且不能超过 32 个字符。',
      shouldTerminate: true,
    }
  }

  if (
    update.gain !== undefined &&
    (!Number.isFinite(update.gain) || update.gain < 0 || update.gain > 1)
  ) {
    return {
      code: 'invalid_track_update',
      message: '轨道音量必须是 0 到 1 之间的有限数。',
      shouldTerminate: true,
    }
  }

  if (
    update.pan !== undefined &&
    (!Number.isFinite(update.pan) || update.pan < -1 || update.pan > 1)
  ) {
    return {
      code: 'invalid_track_update',
      message: '轨道声像必须是 -1 到 1 之间的有限数。',
      shouldTerminate: true,
    }
  }

  if (
    update.start !== undefined &&
    (!Number.isFinite(update.start) || update.start < 0 || update.start > 120)
  ) {
    return {
      code: 'invalid_track_update',
      message: '轨道起点必须是 0 到 120 之间的有限数。',
      shouldTerminate: true,
    }
  }

  return undefined
}

export function updateTrackSnapshot<
  Track extends TrackMutationTrack,
  Project extends TrackMutationProject<Track>,
>(
  project: Project,
  trackId: string,
  update: MutableTrackFields,
): TrackMutationResult<Project> {
  const validationError = validateUpdate(update)
  if (validationError !== undefined) {
    return { ok: false, error: validationError }
  }

  const index = project.tracks.findIndex((track) => track.id === trackId)
  if (index < 0) {
    return rejected(
      'track_not_found',
      `未找到轨道“${trackId}”，请重新检查工程后再试。`,
      false,
    )
  }

  const current = project.tracks[index]
  const changed = Object.entries(update).some(
    ([field, value]) => current[field as keyof TrackMutationTrack] !== value,
  )
  if (!changed) {
    return { ok: true, changed: false, project }
  }

  const tracks = project.tracks.map((track, trackIndex) =>
    trackIndex === index ? ({ ...track, ...update } as Track) : track,
  )
  return {
    ok: true,
    changed: true,
    project: projectWithTracks(project, tracks),
  }
}

export function removeTrackSnapshot<
  Track extends TrackMutationTrack,
  Project extends TrackMutationProject<Track>,
>(project: Project, trackId: string): TrackMutationResult<Project> {
  const index = project.tracks.findIndex((track) => track.id === trackId)
  if (index < 0) {
    return rejected(
      'track_not_found',
      `未找到轨道“${trackId}”，请重新检查工程后再试。`,
      false,
    )
  }

  if (project.tracks.length === 1) {
    return rejected(
      'last_track_removal_forbidden',
      '工程至少需要保留一条轨道，不能删除最后一条轨道。',
      true,
    )
  }

  return {
    ok: true,
    changed: true,
    project: projectWithTracks(
      project,
      project.tracks.filter((_, trackIndex) => trackIndex !== index),
    ),
  }
}

export function canRemoveTrackSnapshot<Track extends TrackMutationTrack>(
  project: TrackMutationProject<Track>,
  trackId: string,
): boolean {
  return (
    project.tracks.length > 1 &&
    project.tracks.some((track) => track.id === trackId)
  )
}

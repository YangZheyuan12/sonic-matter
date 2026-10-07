import type { Project } from './model.ts'

export type ProjectWorkspaceSummary = {
  trackCount: number
  midiTrackCount: number
  audioTrackCount: number
  soundDirectionConfigured: boolean
}

/** My 页只消费稳定的工程摘要，不在视图里重复推导统计规则。 */
export function projectWorkspaceSummary(project: Project): ProjectWorkspaceSummary {
  const midiTrackCount = project.tracks.filter(track => track.kind === 'midi').length
  return {
    trackCount: project.tracks.length,
    midiTrackCount,
    audioTrackCount: project.tracks.length - midiTrackCount,
    soundDirectionConfigured: Boolean(project.soundDirection),
  }
}

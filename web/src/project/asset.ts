/** 当前 Project 的正式音频资产；与不属于项目的 DemoClip 分开。 */
export type ProjectAsset = {
  id: string
  title: string
  kind: 'music' | 'sfx' | 'ambience' | 'voice'
  origin: 'generated' | 'uploaded' | 'recorded'
  status: 'draft' | 'confirmed' | 'archived'
  source: string
  createdAt: number
  sceneId?: string
  eventId?: string
}

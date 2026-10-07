import type { Project } from './model'

const compact = (value: string | undefined, max: number) => (value ?? '').trim().slice(0, max)
const list = (values: string[] | undefined, max = 4) => values?.slice(0, max).join('、') || '未指定'

/** 将 Game Brief、Game Analysis 和声音方向之外的项目语义压缩成生成模型上下文。 */
export function audioContextPrompt(project: Project): string {
  const brief = project.gameBrief
  const analysis = project.gameAnalysis
  const scenes = brief?.scenes.slice(0, 3).map(scene => `${compact(scene.name, 40)}${scene.moods?.length ? `（${list(scene.moods, 3)}）` : ''}`).filter(Boolean).join('、')
  const events = brief?.events.slice(0, 3).map(event => `${compact(event.name, 40)}${event.category ? `（${compact(event.category, 30)}）` : ''}`).filter(Boolean).join('、')
  const prompt = [
    '游戏创作上下文：',
    `游戏名称：${compact(brief?.title || project.title, 80) || '未命名游戏'}`,
    `游戏类型：${compact(brief?.genre, 80) || '未指定'}`,
    `核心玩法：${compact(brief?.gameplay, 180) || '未指定'}`,
    `世界观：${compact(brief?.world, 180) || '未指定'}`,
    `场景：${scenes || '未指定'}`,
    `关键事件：${events || '未指定'}`,
    `游戏理解：${compact(analysis?.summary, 180) || '未生成'}`,
    `理解中的情绪：${list(analysis?.moods, 5)}`,
    `推荐乐器：${list(analysis?.recommendedInstruments, 6)}`,
    `推荐材质：${list(analysis?.recommendedMaterials, 6)}`,
    `避免方向：${list(analysis?.avoidDirections, 3)}`,
    '请让生成结果服务于这个游戏语境，不要只根据孤立的声音描述创作。',
  ].join('\n')
  return prompt.length > 800 ? `${prompt.slice(0, 799)}…` : prompt
}

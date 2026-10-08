import { definitionContext, type GameDefinition } from '../project/gameDefinition'
import type { Concept, ConceptId } from '../project/gameUnderstanding'

type AbstractLabProps = {
  definition: GameDefinition
  focus: string
  setFocus: (value: string) => void
  concepts: Record<ConceptId, Concept> | null
  choice: ConceptId
  setChoice: (value: ConceptId) => void
  loading: boolean
  generate: () => void
  apply: () => void
}

const perspectiveLabels: Record<ConceptId, string> = {
  physical: '物理视角',
  psychological: '心理视角',
  climate: '生态 / 社会视角',
}

export default function AbstractLab({ definition, focus, setFocus, concepts, choice, setChoice, loading, generate, apply }: AbstractLabProps) {
  const context = definitionContext(definition)
  const selected = concepts?.[choice]

  return <div className="abstract-lab">
    <section className="abstract-context">
      <div className="paneltitle"><span>GAME CONTEXT</span><span>{context ? 'DEFINITION + SOUND DIRECTION' : 'WAITING FOR GAME DATA'}</span></div>
      <div className="abstract-context-copy">{context || '还没有游戏资料。你可以先在“定义你的游戏”里补充设定，或直接输入一个理解焦点开始探索。'}</div>
      <div className="abstract-controls">
        <label><small>理解焦点</small><input value={focus} onChange={event => setFocus(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && focus.trim()) generate() }} placeholder="例如：潮汐、失去、迁徙" /></label>
        <button className="primary" onClick={generate} disabled={loading || !focus.trim()}>{loading ? '正在生成理解…' : '生成三种理解 ✦'}</button>
      </div>
      {!concepts && <p className="abstract-empty">生成结果会从不同视角拆解游戏世界，并转化成可用于音乐创作的故事弧线。</p>}
    </section>
    {concepts && <>
      <div className="abstract-results-heading"><div><small>THREE PERSPECTIVES</small><h2>选择一种理解方式</h2></div><span>游戏资料不会被改写</span></div>
      <div className="cards abstract-cards">{(Object.keys(concepts) as ConceptId[]).map((id, index) => <button key={id} className={choice === id ? 'card selected' : 'card'} aria-pressed={choice === id} onClick={() => setChoice(id)}><small>0{index + 1} · {perspectiveLabels[id]}</small><h3>{concepts[id].title}</h3><p>{concepts[id].summary}</p><b>{choice === id ? '当前视角' : '查看这个视角'} →</b></button>)}</div>
      {selected && <div className="semantic abstract-semantic">
        <div className="abstract-map"><small>SONIC THESIS</small><h2>{selected.title}</h2><p>{selected.thesis ?? selected.summary}</p>{selected.musicMapping && <div className="abstract-mapping"><span>{selected.musicMapping.tempo} BPM</span><span>{selected.musicMapping.key}</span><span>密度 {Math.round(selected.musicMapping.density * 100)}%</span><span>张力 {Math.round(selected.musicMapping.tension * 100)}%</span></div>}<small className="mapping-instruments">建议音色 · {selected.musicMapping?.instruments.join(' / ') ?? '等待生成'}</small></div>
        <div className="story"><div className="paneltitle"><span>10-SECOND STORY ARC</span><span>{perspectiveLabels[choice]}</span></div>{selected.story.map(item => <div className="storyrow" key={`${item.time}-${item.title}`}><time style={{ color: item.color }}>{item.time}</time><div><strong>{item.title}</strong><p>{item.text}</p></div></div>)}<button className="primary abstract-apply" onClick={apply}>应用到音乐工程 ↗</button></div>
      </div>}
    </>}
  </div>
}

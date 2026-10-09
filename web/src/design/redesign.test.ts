import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const app = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8')
const css = readFileSync(new URL('../redesign.css', import.meta.url), 'utf8')

test('React 应用使用统一的五阶段创作导航', () => {
  assert.match(app, /className="workflow-nav"/)
  for (const label of ['游戏简报', '声音方向', '音乐工作室', '音效实验室']) assert.match(app, new RegExp(label))
  assert.match(app, /setDefinitionStep\('brief'\)/)
  assert.match(app, /setDefinitionStep\('sound'\)/)
})

test('首页将概念稿的主叙事、声场与最近工程落到真实 React 页面', () => {
  assert.match(app, /让游戏先拥有/)
  assert.match(app, /className="orb"/)
  assert.match(app, /className="recent-project"/)
  assert.match(app, /project\.tracks\.length/)
  assert.match(css, /\.home-main\s*\{/)
  assert.match(app, /className="home-project-strip"/)
  assert.doesNotMatch(app, /className="home-actions"/)
})

test('游戏简报与声音方向继续使用真实 GameDefinition 数据', () => {
  assert.match(app, /className="brief-workspace"/)
  assert.match(app, /className="direction-workspace"/)
  assert.match(app, /definition\.brief\.coreLoop/)
  assert.match(app, /definition\.sound\.texture/)
  assert.match(app, /实时游戏摘要/)
  assert.match(app, /声音指纹/)
})

test('Music Studio 保留编辑组件并采用控制台布局', () => {
  assert.match(app, /className="studio-workspace"/)
  assert.match(app, /<TrackList/)
  assert.match(app, /<Timeline/)
  assert.match(app, /<PianoRoll/)
  assert.match(app, /<HistoryBar/)
  assert.match(css, /grid-template-columns:225px minmax\(0,1fr\) 285px/)
})

test('SFX Lab 使用真实波形、语义参数和工程加入操作', () => {
  assert.match(app, /className="sfx-workspace"/)
  assert.match(app, /waveformPeaksFor/)
  assert.match(app, /previewWaveform/)
  assert.match(app, /语义混音器/)
  assert.match(app, /加入当前工程/)
  assert.match(css, /\.waveform-display/)
  assert.match(app, /Math\.max\(peaks\[i\]/)
})

test('新版视觉样式包含桌面与移动端响应式规则', () => {
  assert.match(css, /@media \(max-width: 1100px\)/)
  assert.match(css, /@media \(max-width: 780px\)/)
  assert.match(css, /--sm-cyan:/)
  assert.match(css, /--sm-violet:/)
  assert.match(css, /\.app main\.app-main/)
  assert.match(css, /\.app \.toast-stack/)
  assert.match(app, /setTimeout\(\(\) => setNotice\(''\), 4500\)/)
})



import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const app = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8')
const css = readFileSync(new URL('../concept-ui.css', import.meta.url), 'utf8')
const header = readFileSync(new URL('../app/WorkflowHeader.tsx', import.meta.url), 'utf8')
const workflow = readFileSync(new URL('../app/workflow.ts', import.meta.url), 'utf8')

test('高保真概念稿已接入生产 React，而不只是保留静态 HTML', () => {
  assert.match(app, /import '\.\/concept-ui\.css'/)
  assert.match(app, /<WorkflowHeader/)
  for (const className of ['home-main', 'brief-layout', 'direction-layout', 'studio-shell', 'sound-workspace', 'settings-layout']) {
    assert.match(app, new RegExp(`className="[^"]*${className}`))
    assert.match(css, new RegExp(`\\.${className}`))
  }
})

test('新工作流仍保留账户、管理员密钥、云端工程与导出入口', () => {
  assert.match(app, /<AccountPanel/)
  assert.match(app, /<CloudBar/)
  assert.match(app, /exportMidi/)
  assert.match(app, /exportWav/)
  assert.match(app, /exportMp3/)
  assert.match(header, /workflowItems/)
  assert.match(workflow, /游戏简报/)
  assert.match(workflow, /声音方向/)
})

# Sonic / Matter · 前端

React 19 + TypeScript + Vite 的前端工程，负责四个页面（灵感空间 / 万物声谱 / 音乐工作室 / 音效实验室）、
钢琴卷帘编辑、Web Audio 本地渲染，以及 WAV / MP3 导出。`/api` 与 `/generated` 由 Vite 代理到后端 `http://localhost:8787`。

## 启动

```powershell
npm install
npm run dev
```

打开 `http://127.0.0.1:5173/`。端口与代理在 `vite.config.ts` 里固定为 `127.0.0.1:5173`（`strictPort`），
因此不要用别的端口启动，否则后端代理和文档里的地址会对不上。

## 脚本

- `npm run dev`：开发服务器（已固定 host / port）。
- `npm run build`：`tsc -b` 类型检查 + 生产构建。
- `npm run lint`：oxlint。
- `npm run preview`：预览构建产物。

## 目录

```text
src/
  App.tsx                # 页面路由、工程状态、Agent 调用、录制与导出
  index.css              # 全部样式（无 CSS 框架）
  project/model.ts       # Project / Track / Note 类型、校验、clip 判定
  audio/projectAudio.ts  # 工程播放与离线渲染（本地音色、audio clip）
  audio/sfxPreview.ts    # 音效本地合成：实时试听 + 离线渲染 + clip 编解码
  audio/exportAudio.ts   # WAV（手写 RIFF）与 MP3（lamejs）编码
public/soundfonts/       # 可选 WAV 采样；缺失时自动回退浏览器合成器
```

## 音频说明

- MIDI 轨道：优先用 `public/soundfonts/manifest.json` 里的 WAV 采样，缺失时回退到振荡器合成。
- `kind: 'audio'` 轨道有两种来源：后端生成的 `/generated/xxx.wav|mp3`，以及音效实验室加入工程时写入的
  `local-sfx:<base64>`（只存描述与调音台参数，播放/导出时用 `sfxPreview` 现场渲染，避免把音频数据塞进工程文件）。
- 两种 clip 都会参与播放和 WAV / MP3 导出；单条 clip 载入失败只会静音跳过该轨道，不会中断整个工程。

## 真实 API

设置页里的 Agent / 音乐 / 音效三组服务都是可选的；没有 Key 时概念解释、音效计划、音乐工程计划会走后端本地 fallback，
依然可以完整演示。默认模型名请填你自己账号可用的模型（默认值为 `gpt-4.1-mini`），
并且该模型需要支持 Structured Outputs。

# Sonic / Matter

一个把手势、抽象概念与 Agent 生成结果转化为可编辑音乐工程的交互式 Web Demo。

## 主要功能

- **灵感空间**：在粒子画布中滑动演奏，并把手势记录为 MIDI 音符。
- **万物声谱**：使用兼容 OpenAI 的 Agent 将“冰山、环保、木桶”等概念解释为故事和音乐映射。
- **音乐工作室**：生成和编辑结构化 Project JSON、管理多轨、使用 DAW 风格钢琴卷帘编辑音符，并导出 MIDI、WAV 和 MP3。
- **音效实验室**：根据文字生成音效设计计划，通过语义调音台调整长度、密度、明亮度、空间感和紧凑度，支持本地试听与可选真实音效 API。
- **多服务设置**：分别配置 Agent、音乐生成和音效生成服务；API Key 默认不持久化。

## 技术栈

- 前端：React 19、TypeScript、Vite、Web Audio API、OfflineAudioContext、lamejs
- 后端：Node.js、Express、OpenAI SDK、Zod
- AI 工作流：Agent → JSON Schema → Zod 校验 → Project/MIDI JSON → 本地音色渲染

## 本地启动

要求 Node.js 20 或更高版本。

### 1. 启动后端

```powershell
cd server
npm install
Copy-Item .env.example .env
npm run dev
```

后端默认运行在 `http://localhost:8787`。

### 2. 启动前端

另开一个终端：

```powershell
cd web
npm install
npm run dev
```

打开 `http://127.0.0.1:5173/`。

无需 API Key 也可以使用本地 fallback、钢琴卷帘、本地音色渲染和音效预览。真实 Agent、音乐生成和音效生成需要在“设置”中填写相应服务配置。

## 本地音色

将已确认许可证的 WAV 根音采样放到：

```text
web/public/soundfonts/
```

默认文件名和根音映射见 [`web/public/soundfonts/README.md`](web/public/soundfonts/README.md)。音色文件缺失时，应用会自动回退到浏览器合成器。

> 不要提交许可证不允许再分发的商业音色，也不要提交 `.env`、API Key 或本地生成的音频。

## 验证

```powershell
cd web
npm ci
npm run verify

cd ../server
npm ci
npm run verify
```

CI 会在每次 push 和 pull request 时使用 Node.js 20 执行相同的验证命令。

如果只需要检查前端构建，可运行 `npm run verify --prefix web`；只需要检查后端，可运行 `npm run verify --prefix server`。

## 当前状态

这是可交互的功能 Demo。多选音符、撤销/重做、完整音频波形编辑、多供应商 Provider Adapter 和云端项目存储仍属于后续路线。

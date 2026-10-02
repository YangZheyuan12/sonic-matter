# Sonic / Matter Agent 服务

这是网站的 Agent 与音频导出后端。前端通过 Vite `/api` 代理访问 `http://localhost:8787`。

## 配置方式

网站新增了“设置 → Agent”页面，可以一次性配置三类服务：

- Agent：Base URL、API Key、Model、Responses API 或 Chat Completions 协议
- 音乐服务：Base URL、API Key、Model，以及“结构化工程（推荐）/ 直接 AI 音频增强”模式
- 音效服务：Base URL、API Key、Model

音乐和音效凭证与 Agent 凭证相互独立；可以只填写 Agent，音乐 API 与音效 API 都是可选增强层。

配置可以只保存在当前页面，也可以选择保存在当前浏览器的 localStorage。API Key 不会写入项目文件。

也可以使用服务端环境变量作为默认配置。复制 `.env.example` 为 `.env`：

```env
OPENAI_API_KEY=你的_api_key
OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_MODEL=gpt-6-astra
OPENAI_PROTOCOL=responses
REPLICATE_API_TOKEN=你的_replicate_token
MUSIC_REPLICATE_MODEL=meta/musicgen
ELEVENLABS_API_KEY=你的_elevenlabs_key
PORT=8787
```

## 启动

在两个终端分别运行：

```powershell
cd "D:\MyProjects\sonic-matter\server"
npm run start
```

```powershell
cd "D:\MyProjects\sonic-matter\web"
npm run dev
```

打开 `http://127.0.0.1:5173/`，进入“Agent 设置”测试连接。

## 接口

- `GET /api/health`：检查默认 Agent 配置。
- `POST /api/agent/test`：测试页面提交的 Base URL、API Key、Model 和协议。
- `POST /api/concept/interpret`：概念解释 Agent，返回三种结构化解释和 10 秒音乐叙事。
- `POST /api/project/edit`：工程编辑 Agent，返回可撤销方向的结构化工程操作。
- `POST /api/sfx/plan`：音效设计 Agent，把描述和调音台参数转为音效生成计划。
- `POST /api/music/plan`：由 Agent 生成可编辑的 MIDI / 和弦 Project JSON，这是默认的音乐生成路径。
- `POST /api/music/generate`：按设置页中的音乐服务配置调用音频模型生成真实音频，并保存到 `server/generated`。
- `POST /api/sfx/generate`：调用 ElevenLabs Sound Generation 生成真实音效，并保存到 `server/generated`。
- `POST /api/export/midi`：把当前 Project 的 MIDI 轨道导出为 `.mid` 文件。

所有 Agent 输出都经过 JSON Schema Structured Outputs，并用 Zod 二次校验。前端每次请求都可以覆盖服务端默认 Agent 配置，因此支持大多数 OpenAI-compatible 接口；完全不同协议的 Anthropic 原生接口、Gemini 原生接口等需要另写 adapter。

## 当前导出能力

- MIDI：服务端生成标准 MIDI 文件。
- WAV：浏览器端 OfflineAudioContext 渲染当前 MIDI 轨道并下载。
- MP3：浏览器端使用 `lamejs` 将当前 MIDI 渲染结果编码下载；真实 AI 音频会以原始服务文件格式试听。

## 音频服务分工

- OpenAI 只负责概念解释、故事映射、工程编辑、结构化音乐计划和音效计划等 Agent 工作，并通过 JSON Schema + Zod 校验。
- 默认音乐路径是 Agent → Project JSON → 浏览器本地 WebAudio / MIDI 渲染，保留音符、和弦与轨道编辑能力。
- Replicate 负责真实音乐音频生成，默认模型为 `meta/musicgen`。它生成的是音频，不是 MIDI。
- ElevenLabs Sound Generation 负责真实音效生成。调音台参数会被翻译进文本提示中。
- 用户点击的音符仍保存在工程的 MIDI 事件骨架里，因此可以继续编辑、导出 MIDI，并与 AI 音频同时保留。不要把 AI 音频默认反向识别为 MIDI，否则复调、鼓组和起止时间都会产生不可避免的误差。

生成文件只保存在本地 `server/generated`，适合演示 Demo。当前不需要云服务器、数据库或真实账号；正式部署时再把生成文件迁移到 S3、Cloudflare R2、腾讯云 COS 或阿里云 OSS，并按需增加数据库和认证服务。

没有配置 API Key 时，概念、音效计划和音乐工程计划接口会返回本地 fallback，方便继续演示；工程编辑会明确提示需要真实 Agent。

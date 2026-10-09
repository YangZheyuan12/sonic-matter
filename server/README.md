# Sonic / Matter Agent 服务

这是网站的 Agent 与音频导出后端。前端通过 Vite `/api` 代理访问 `http://localhost:8787`。

## 配置方式

网站的“我的 → Agent”页面配置用户自己的 OpenAI 兼容 Agent：

- Base URL、API Key、Model
- Responses API 或 Chat Completions 协议
- 音乐生成方式：“结构化工程（推荐）”或“直接 AI 音频增强”

Replicate 音乐和 ElevenLabs 音效是登录后可用的平台增强服务。它们的密钥只由管理员在“我的 → 账户”配置，普通用户无需也不能在浏览器填写。

个人 Agent 配置保存在当前浏览器的 localStorage；只有勾选“记住 API Key”才会持久化个人 Key。平台音乐/音效密钥不会写入 localStorage 或项目文件。

也可以使用服务端环境变量作为默认配置。复制 `.env.example` 为 `.env`：

```env
OPENAI_API_KEY=你的_api_key
OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_MODEL=gpt-4.1-mini
OPENAI_PROTOCOL=responses
MUSIC_REPLICATE_MODEL=meta/musicgen
PORT=8787
# 服务端行为
CORS_ORIGIN=
JSON_BODY_LIMIT=2mb
# 下面这些都有默认值，一般不用改
AGENT_TIMEOUT_MS=60000
PROVIDER_TIMEOUT_MS=180000
REQUEST_TIMEOUT_MS=300000
PROVIDER_RETRY_ATTEMPTS=3
PROVIDER_RETRY_BASE_MS=500
LOG_LEVEL=info
```

## 测试

```powershell
npm test
```

`CORS_ORIGIN` 用逗号分隔多个浏览器来源；留空表示不限制来源（只适合本地开发）。不在名单里的来源会收到 `403` + `cors_not_allowed`。
`JSON_BODY_LIMIT` 控制请求体上限，默认 `2mb`，超限返回 `413` + `payload_too_large`。
每个请求都会带上 `X-Request-Id`（请求头里给了就沿用），错误信封里也有同一个 `requestId`，方便和服务端日志对上。
`SONIC_MATTER_TEST=1` 时服务只导出 `app`、不监听端口，供接口冒烟测试使用。

用 Node 自带的 `node:test` 运行 `src/**/*.test.ts`（不需要额外依赖）。注意 Node 原生运行时不支持省略扩展名的相对导入，因此服务端源码里的相对导入统一写成 `./midi.ts` 这种形式；`tsconfig.json` 已打开 `allowImportingTsExtensions`，`tsx` 与 `tsc` 都能正常解析。

## 启动

在两个终端分别运行：

```powershell
cd server
npm run start
```

```powershell
cd ..\web
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

失败响应的格式、超时与重试策略、日志约定见上面的「统一错误信封」等小节。
所有 Agent 输出都经过 JSON Schema Structured Outputs，并用 Zod 二次校验。前端每次请求都可以覆盖服务端默认 Agent 配置，因此支持大多数 OpenAI-compatible 接口；完全不同协议的 Anthropic 原生接口、Gemini 原生接口等需要另写 adapter。

### 统一错误信封

所有 `/api/*` 的失败响应形状一致（HTTP 状态码同时表达语义）：

```json
{
  "error": "上游服务响应超时，请稍后重试。",
  "code": "provider_timeout",
  "status": 504,
  "retryable": true,
  "detail": "PROVIDER_TIMEOUT",
  "requestId": "0f7c1a1e-..."
}
```

- `error`：给用户看的中文文案，前端可以直接展示。
- `code`：稳定的机器可读标识：`bad_request`、`not_found`、`provider_not_configured`、
  `provider_unauthorized`、`provider_rate_limited`、`provider_timeout`、`provider_unavailable`、
  `provider_bad_response`、`internal_error`。
- `retryable`：前端据此决定要不要显示「重试」按钮。
- `detail`：内部原因（哨兵错误名、zod 问题列表、上游原始信息），只用于排查，不保证稳定，不要拿来判断逻辑。
- `requestId`：这次请求的追踪 ID，同时写在响应头 `X-Request-Id` 里，和日志中的 `requestId` 一致。
  前端也可以自带 `X-Request-Id`，方便把浏览器的问题和服务端日志对上。

「没有配 Key」属于配置问题而不是服务故障，所以是 503 `provider_not_configured`；
概念解释、音效计划、音乐工程计划这三条接口会退化成本地 fallback（响应里带 `source: "fallback"` 和 `warning`）继续演示，
其它接口则明确报错，不做假数据。

### 超时、重试与取消

- 每个上游请求都有独立超时：Agent 默认 `AGENT_TIMEOUT_MS=60000`，音频生成与下载默认
  `PROVIDER_TIMEOUT_MS=180000`；整个 HTTP 请求还有 `REQUEST_TIMEOUT_MS=300000` 兜底。
- 只在「网络错误 / 408 / 429 / 5xx」时重试，最多 `PROVIDER_RETRY_ATTEMPTS`（默认 3）次，指数退避
  （`PROVIDER_RETRY_BASE_MS`，默认 500ms 起、单次最多 8 秒）并优先遵守上游的 `Retry-After`；
  400 这类参数错误不重试，直接就报错。
- 浏览器断开连接时，服务端会通过 `AbortSignal` 立刻取消上游请求，不会留下还在跑的生成任务。
- 前端「取消」按钮走的是同一条路径：`AbortSignal` 从请求层一路传到上游。

### 日志

输出单行结构化日志（默认 `info`，用 `LOG_LEVEL` 调整）：

```text
2026-01-01T00:00:00.000Z INFO  请求完成 {"requestId":"...","method":"POST","url":"/api/music/plan","status":200,"ms":812}
```

日志会自动脱敏：字段名命中 `apiKey` / `Authorization` / `token` / `password` 等会整值打码成 `***(长度)`，
字符串里出现的 `sk-xxx`、`Bearer xxx` 也会被替换成 `***`。**排查问题时不要临时取消脱敏。**
4xx 记 `warn`，5xx 记 `error`（写 stderr）。所有响应都带 `X-Request-Id`，出问题时让用户把这一串发过来即可。

### 优雅退出

收到 `SIGINT` / `SIGTERM`（Ctrl+C 或 `npm run dev` 退出）时会先关闭监听、再退出，
最多等 5 秒；端口被占用时会打印可读的中文提示而不是抛栈。

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

生成文件保存在 `server/generated`，云端工程存入独立的 `server/projects` SQLite 库，固定双账号及会话存入非公开的 `server/auth` SQLite 库。“我的 → 账户”已接入 `/api/auth/login`、`/api/auth/me`、`/api/auth/logout`。管理员通过 `GET /api/admin/service-config` 查询状态，`PUT /api/admin/service-config` 保存 `{ replicate?: string | null, elevenlabs?: string | null }`。省略字段保留配置，`null` 清除配置，空字符串不合法。接口仅允许管理员；写操作需同源 JSON 和 `X-Sonic-Auth: 1`，生产需 HTTPS。

密钥以 AES-256-GCM 加密存入 `AUTH_DIR/service-config.db`，随机 IV 和供应商绑定的 AAD 防止密文篡改与串用。接口不会回显明文、密文或末尾字符；前端不会保存平台密钥到 localStorage。`SONIC_CONFIG_KEY` 必须是 32 随机字节的 hex 或标准 base64，缺失时拒绝保存，错误参数无法覆盖已有配置。更新不会生成新的保护密钥。备份必须同时保留数据库和 `.env` 中的保护密钥。

`POST /api/music/generate` 与 `POST /api/sfx/generate` 只允许已登录的管理员或使用者账号调用，并从上述加密配置读取平台密钥。客户端提交的音乐/音效密钥、供应商地址或模型会被拒绝；服务器固定调用官方 HTTPS 地址和受控模型。保存配置本身不会调用供应商或扣费，清除某项密钥后，对应生成接口立即停止工作。个人 OpenAI Agent 配置仍由用户在当前浏览器管理。生产配置、Cookie 安全设置和登录限流见 [`deploy/README.md`](../deploy/README.md)。

没有配置 API Key 时，概念、音效计划和音乐工程计划接口会返回本地 fallback，方便继续演示；工程编辑会明确提示需要真实 Agent。

# AGENTS.md · Sonic / Matter 协作约定

这份文件对人和 AI 助手都生效。改动前请先读一遍。

## 提交约定

- **一个功能（或一个修复）一个 commit**，commit message 用中文写清楚「做了什么」和「为什么」。
- 不要在一个 commit 里混入无关的格式化 / 重命名改动，方便 review 与回滚。
- **改了行为就要补测试**。纯逻辑（数据模型、编码解码、导出）必须有单测；无法自动化测试的部分
  （音频听感、手势交互）在 PR 描述里写清楚手动验证步骤。

## 代码约定

- 相对导入在 `web/src/**/*.test.ts` 与 `server/src/**.ts` 里要带 `.ts` 后缀：单测用 Node 原生
  TypeScript 支持运行，原生运行时不解析省略扩展名的相对导入。前端应用代码仍可用 Vite 风格的无后缀导入。
- `Project` / `Track` / `Note` 的类型定义（`web/src/project/model.ts`）和 9 个 HTTP 接口是前后端唯一的共享面。
  **改这两个地方之前先在群里说一声**，两边一起改。
- 前端所有请求都走 `web/src/api/client.ts`（超时、取消、错误文案统一在这里），不要在组件里裸写 `fetch`。
- 后端所有路由都返回统一错误信封 `{ error, code, detail?, retryable?, requestId }`，不要在分支里手拼自己的错误结构。
- UI 文案与错误提示统一用中文，尽量具体（说明下一步该做什么），不要只丢一个「失败」。

## 安全约定（强制执行）

- **绝对不要提交** GitHub / OpenAI / AWS / Slack token、私钥、password、`.env` 等任何凭据。
  代码里一律用环境变量引用，凭据文件必须留在 `.gitignore` 里（当前已覆盖 `.env`、`.env.*`、`*.local`）。
- 本地开发用的 Key 只填在「设置 → Agent」里，或写进 `server/.env`（已被忽略）。
- 日志里不要输出 API Key、Authorization 头或完整请求体；需要排查时只打印长度或后四位。

## 验证

提交前在仓库根目录跑：

```powershell
npm run verify
```

它会依次执行 typecheck（server + web）→ lint → test → build；CI 跑的是同一套命令。

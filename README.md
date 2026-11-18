# Sonic / Matter

Sonic / Matter 是一个面向游戏音乐创作的交互式 Web Demo。它的核心不是让模型一次性“吐出一段音频”，而是让 **Audio Director Agent** 把自然语言意图转成可编辑的结构化音乐工程：先规划，只调用白名单工具，在确定性规则下验收，必要时有限修订，最后把差异交给人确认。

[![CI](https://github.com/YangZheyuan12/sonic-matter/actions/workflows/ci.yml/badge.svg)](https://github.com/YangZheyuan12/sonic-matter/actions/workflows/ci.yml)

## 先用 5 分钟理解 Agent

- **问题**：直接生成音频难以解释、难以局部修改，也很难证明约束真的满足。
- **决策**：让单个 Agent 操作 `Project → Track → Note`，每次工具调用和状态迁移都留下 Trace；候选工程通过确定性评估后，仍必须由用户批准才会写入当前工程。
- **证据**：固定离线 Eval 覆盖创建、修改、约束、冲突与提示词注入；指标由同一条命令生成到报告和本页。
- **取舍**：当前不使用多 Agent。所有角色共享一个工程状态，规划、执行、验收之间也没有需要独立自治的边界；引入多 Agent 会增加状态同步、仲裁与延迟，却暂时没有 Eval 证据表明收益更高。现阶段用“单 Agent + 工具注册表 + 确定性评估器 + 有界修订”更容易审计和复现。

继续阅读：[当前架构与状态机](docs/agent/architecture.md) · [成功、自动修订与安全失败案例](docs/agent/cases.md) · [安全边界](docs/agent/security.md) · [最终验收](docs/agent/final-acceptance.md) · [2–3 分钟演示稿](docs/agent/demo-script.md) · [模拟面试问答](docs/agent/interview-qa.md)

<!-- agent-eval:start -->
## 可重复的 Agent Eval 基线

> 本节由 `npm run eval:agent` 自动更新。基线使用固定离线适配器，不产生付费调用，也不把离线满分等同于真实模型在所有输入上都正确。

| 指标 | 当前基线 |
| --- | ---: |
| 案例通过 | 20/20 |
| 总成功率 | 100.00% |
| 约束满足率 | 100.00% |
| 工具成功率 | 100.00% |
| 一次完成率 | 93.33% |
| 修订成功率 | 100.00% |
| 可导出率 | 100.00% |
| 平均工具步骤 / 修订总次数 | 0.85 / 1 |
| 真实付费调用 / 估算成本 | 0 / $0.00 |

复现命令：`npm run eval:agent`。查看[完整报告](server/src/agent/evals/reports/README.md)、[机器可读结果](server/src/agent/evals/reports/baseline.json)与[三个演示案例](docs/agent/cases.md)。
<!-- agent-eval:end -->

## 用户能做什么

- **首页**：在背景画布中滑动演奏和录制旋律，从“定义你的游戏”或 Agent 对话进入创作流程。
- **定义你的游戏**：依次填写游戏资料与 Sound Direction，作为音乐和音效生成的共同创作背景。
- **音乐工作室**：让 Agent 创建或修改结构化 Project，查看执行 Trace 和候选差异，批准后再进入历史记录；也可手动管理多轨、编辑音符并导出 MIDI、WAV 和 MP3。
- **音效实验室**：根据文字生成音效设计计划，通过语义调音台调整长度、密度、明亮度、空间感和紧凑度，支持本地试听与可选真实音效 API。
- **多服务设置**：分别配置 Agent、音乐生成和音效生成服务；API Key 默认不持久化。
- **云端工程与分享链接**：把工程存到服务器（`/api/projects`），拿到 `?p=<id>` 链接的人都能打开；本机身份串决定谁可以改。

## 实现边界

- 前端：React 19、TypeScript、Vite、Web Audio API、OfflineAudioContext、lamejs
- 后端：Node.js、Express、OpenAI SDK、Zod
- Agent 工作流：指令安全检查 → 规划 → 白名单工具 → 候选快照 → 确定性验收 → 有界修订 → 人工审批
- 工程工作流：JSON Schema / Zod → Project / MIDI JSON → 本地音色渲染

## 本地启动

要求 Node.js 22.18 或更高版本（`.nvmrc` 固定为 24，CI 也用这个版本；运行 `npm test` 依赖 Node 自带 TypeScript 支持，因此不要用更低的版本）。

### 0. 一条命令同时启动前后端

```powershell
npm run dev
```

等价于在 `server/` 与 `web/` 里各跑一次 `npm run dev`（依赖仍需在两个目录各自 `npm install` 一次）：按 Ctrl+C 会连子进程一起退出、端口一起释放。

也可以按下面两个小节开两个终端手动启动。

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

在仓库根目录执行：

```powershell
npm ci --prefix server ; npm ci --prefix web   # 首次准备依赖
npm run verify
```

它依次跑 `typecheck`（server + web）→ `lint` → `test` → `build`。也可以单独执行：

```powershell
npm run typecheck   # server: tsc --noEmit，web: tsc -b
npm run lint        # oxlint
npm test            # node:test（web + server 的全部用例）
npm run build       # web 生产构建
```

只检查一个包时，可以进到对应目录跑 `npm ci ; npm run verify`——`server/` 与 `web/` 各自都有一个 `verify` 脚本。

测试用 Node 自带的 `node:test`，不引入额外依赖，离线也能跑。推送后由 `.github/workflows/ci.yml` 在 Node 24（见 `.nvmrc`）上跑同一套命令。

## 部署（8088 + Nginx）

线上 Node 服务仅在本机监听 `8088`，设 `SERVE_WEB=1` 后同时托管前端与 API；Nginx 的 HTTPS 入口为 `https://8.141.109.141/`，HTTP 入口跳转到 HTTPS。排查上游服务在服务器内部访问 `http://127.0.0.1:8088/`。

```bash
cd server
SERVE_WEB=1 PORT=8088 node src/index.ts   # Node 24 原生运行 TS 入口，生产环境不需要 tsx
```

相关环境变量（见 [`server/.env.example`](server/.env.example)）：

| 变量 | 说明 |
| --- | --- |
| `SERVE_WEB` | `1` = 同时托管前端构建产物；本地开发保持 `0`，继续用 Vite 的 5173 |
| `WEB_DIST_DIR` | 前端构建产物目录，相对 `server/` 解析，默认 `../web/dist` |
| `DATA_DIR` | 导出音频等本地数据的落盘目录，默认 `generated` |
| `PROJECTS_DIR` | 云端工程的 SQLite 库目录，默认 `projects`。**必须放在 `DATA_DIR` 之外**：`DATA_DIR` 是公开静态目录 |

针对云服务器的完整步骤（Node 24 安装、systemd 守护、防火墙放行、日常更新与排错、HTTPS 兜底）见 [`deploy/README.md`](deploy/README.md)。部署到公网前请先读该文档最后的「安全边界」。

如果服务器不是自己的、需要先征得 owner 同意，用 [`deploy/队友服务器操作步骤.md`](deploy/%E9%98%9F%E5%8F%8B%E6%9C%8D%E5%8A%A1%E5%99%A8%E6%93%8D%E4%BD%9C%E6%AD%A5%E9%AA%A4.md)：里面把"新增了什么 / 不动什么 / 占多少资源 / 怎么一键卸载"逐项写清，对方不用读代码就能判断。

## 当前状态

这是可交互的功能 Demo：首页旋律录制、游戏资料与 Sound Direction、音乐工作室、音效双实验室、多轨编辑、钢琴卷帘、音频片段编辑、真实波形、撤销/重做、本地与 SQLite 云端工程、MIDI / WAV / MP3 导出均已落地，并由单元测试与 CI 兜底。生产环境使用 HTTPS + Nginx + 本机 8088（见 [`deploy/README.md`](deploy/README.md)）。固定 `admin` / `user` 双账号支持“我的 → 账户”真实登录、退出、持久化会话和登录限流。管理员可配置 Replicate / ElevenLabs 平台密钥，服务端 AES-256-GCM 加密保存；已登录用户可使用平台生成，带共享每日额度、频率与并发保护。个人 Agent 配置保留。云端工程读取公开，写入继续使用浏览器本地身份串校验。

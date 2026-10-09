# Sonic / Matter

一个把手势、抽象概念与 Agent 生成结果转化为可编辑音乐工程的交互式 Web Demo。

[![CI](https://github.com/YangZheyuan12/sonic-matter/actions/workflows/ci.yml/badge.svg)](https://github.com/YangZheyuan12/sonic-matter/actions/workflows/ci.yml)

## 主要功能

- **首页**：在背景画布中滑动演奏和录制旋律，从“定义你的游戏”或 Agent 对话进入创作流程。
- **定义你的游戏**：依次填写游戏资料与 Sound Direction，作为音乐和音效生成的共同创作背景。
- **音乐工作室**：生成和编辑结构化 Project JSON、管理多轨、使用 DAW 风格钢琴卷帘编辑音符，并导出 MIDI、WAV 和 MP3。
- **音效实验室**：根据文字生成音效设计计划，通过语义调音台调整长度、密度、明亮度、空间感和紧凑度，支持本地试听与可选真实音效 API。
- **多服务设置**：分别配置 Agent、音乐生成和音效生成服务；API Key 默认不持久化。
- **云端工程与分享链接**：把工程存到服务器（`/api/projects`），拿到 `?p=<id>` 链接的人都能打开；本机身份串决定谁可以改。

## 技术栈

- 前端：React 19、TypeScript、Vite、Web Audio API、OfflineAudioContext、lamejs
- 后端：Node.js、Express、OpenAI SDK、Zod
- AI 工作流：Agent → JSON Schema → Zod 校验 → Project/MIDI JSON → 本地音色渲染

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

线上 Node 服务监听 `8088`，设 `SERVE_WEB=1` 后同时托管前端与 API；服务器已有的 Nginx 从 80 端口反向代理到 `127.0.0.1:8088`。因此既可直接访问 `http://8.141.109.141/`，也可用 `http://8.141.109.141:8088/` 排查上游服务。

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

这是可交互的功能 Demo：首页旋律录制、游戏资料与 Sound Direction、音乐工作室、音效双实验室、多轨编辑、钢琴卷帘、音频片段编辑、真实波形、撤销/重做、本地与 SQLite 云端工程、MIDI / WAV / MP3 导出均已落地，并由单元测试与 CI 兜底。生产环境使用 HTTPS + Nginx + 本机 8088（见 [`deploy/README.md`](deploy/README.md)）。固定 `admin` / `user` 双账号的后端登录、退出、持久化会话和登录限流已实现，前端登录入口与 AI 接口权限接入仍在后续步骤中。云端工程读取公开，写入继续使用浏览器本地身份串校验。多供应商真实音乐与音效 API 仍是可选增强层。

# 部署到公网服务器（单端口方案）

把本机 Demo 变成"别人打开网址就能用"的线上服务。当前赛期内的目标机器是一台**阿里云华南 2 核 1.8G / Alibaba Cloud Linux 3**，上面已经装了宝塔面板，因此方案刻意选择**改动最小**的方式。

> 如果要把这份文档发给**服务器 owner**（说明"会在她服务器上做什么、需要她做什么"），用更适合非执行者阅读的版本：[`队友服务器操作步骤.md`](%E9%98%9F%E5%8F%8B%E6%9C%8D%E5%8A%A1%E5%99%A8%E6%93%8D%E4%BD%9C%E6%AD%A5%E9%AA%A4.md)。本文档是执行细节，那份是"改动清单 + 资源占用 + 一键卸载"。

## 0. 目标形态

```text
http://<公网IP>:8080/             → web/dist 静态文件（由 Node 服务直接托管）
http://<公网IP>:8080/api/*        → 后端接口
http://<公网IP>:8080/generated/*  → 导出的音频文件
```

只开 **一个端口、一个进程**，原因是：

- **不装 Nginx、不配反向代理**：`SERVE_WEB=1` 时后端会用 `express.static` 托管 `web/dist`，前端与 API 同源，连 CORS 都不用配。
- **不用 80/443**：大陆服务器的域名要 ICP 备案才能用这两个端口；用 IP + 高位端口（8080）不受影响，赛期内可以直接访问。
- **不用 Docker**：机器上虽然有 Docker，但拉镜像慢、还多占内存；直接跑 Node 进程更简单。
- **不碰宝塔/MySQL**：宝塔的 Nginx 占着 80 和 888、MySQL 占 3306，我们只用 8080，服务崩了也不会影响同机的其它进程（unit 里有 `MemoryMax=512M` 保险）。

> 前端是单页应用、没有路由库，工程分享走 `?p=<id>` 查询参数，所以**不需要 SPA fallback**：静态目录里没有的文件就是 404。

## 1. 前置：在本地构建前端

服务器只有 1.8G 内存，**不要在服务器上跑 `vite build`**（容易 OOM）。在本地仓库根目录：

```powershell
npm ci --prefix server ; npm ci --prefix web
npm run build          # 产出 web/dist（约 500 KB + 音色文件）
```

## 2. 安装 Node 24（官方 tar.gz，不依赖 dnf）

Ubuntu/Anolis 自带的 Node 版本太老，且项目运行 `node --test` 依赖 Node 自带的 TypeScript 支持，所以直接解压官方包到 `/opt/sonic-matter/node`：

```bash
curl -fsSL -o /tmp/node24.tar.gz https://npmmirror.com/mirrors/node/v24.20.0/node-v24.20.0-linux-x64.tar.gz
mkdir -p /opt/sonic-matter
tar -xzf /tmp/node24.tar.gz -C /opt/sonic-matter
mv /opt/sonic-matter/node-v24.20.0-linux-x64 /opt/sonic-matter/node
/opt/sonic-matter/node/bin/node -v     # 期望输出 v24.20.0
```

`npmmirror.com`（淘宝镜像）对大陆机器速度正常，已实测可达；如果下载失败可以换成 `https://nodejs.org/dist/...`。

## 3. 上传代码

在本地仓库根目录打包源码（排除依赖与构建产物），再上传：

```powershell
tar --exclude=server/node_modules --exclude=web/node_modules --exclude=web/dist --exclude=server/generated --exclude=_tmp -czf $env:TEMP\sonic-matter-src.tgz server web deploy package.json README.md AGENTS.md .nvmrc
scp $env:TEMP\sonic-matter-src.tgz root@<公网IP>:/tmp/
```

服务器上解压：

```bash
tar -xzf /tmp/sonic-matter-src.tgz -C /opt/sonic-matter
ls /opt/sonic-matter          # 期望看到 server/  web/  deploy/
```

> 用宝塔面板的「文件管理」直接拖拽上传也完全可以，效果一样。

> **更省事的做法**：这个仓库本来就在服务器 owner 自己的 GitHub 上，那就在服务器上直接 clone 源码，只有前端产物需要我们单独发一个包（`web/dist` 是构建产物，不入库）：
>
> ```bash
> git clone --depth 1 -b main https://github.com/YangZheyuan12/sonic-matter.git /tmp/sm-src
> cp -r /tmp/sm-src/server /opt/sonic-matter/
> mkdir -p /opt/sonic-matter/deploy && cp /tmp/sm-src/deploy/sonic-matter.service /opt/sonic-matter/deploy/
> rm -rf /tmp/sm-src
> ```
>
> 依赖清单一并带过来了（`server/package-lock.json` 在仓库里），第 4 节的 `npm ci` 照旧。

## 4. 安装后端依赖（走国内镜像）

```bash
cd /opt/sonic-matter/server
/opt/sonic-matter/node/bin/npm ci --registry=https://registry.npmmirror.com --omit=dev
```

- `--omit=dev`：不装 tsx / typescript —— 生产环境用 `node src/index.ts`（Node 原生的类型剥离）直接运行，用不到它们。类型检查和测试在本地与 CI 里跑。
- 装完可以确认一下：`du -sh /opt/sonic-matter/server/node_modules`（约 20 MB 级）。

## 5. 写 `.env`

```bash
cd /opt/sonic-matter/server
cp .env.example .env
vi .env
chmod 600 .env        # 里面可能有 API Key，只给 root 读
```

**这次部署请确保 `.env` 里有这四行**（与 systemd unit 保持一致，避免两边不一致时互相覆盖）：

```ini
PORT=8080
SERVE_WEB=1
WEB_DIST_DIR=/opt/sonic-matter/web/dist
DATA_DIR=/opt/sonic-matter/server/generated
```

**关于 API Key（重要）**：

- **推荐不填**：`OPENAI_API_KEY` / `REPLICATE_API_TOKEN` / `ELEVENLABS_API_KEY` 全部留空。后端支持"每个请求自带 Key"，访客在「设置」里填自己的 Key，**不会消耗你们的额度**，没配 Key 时自动走本地 fallback，功能仍然可演示。
- **如果一定要填**：任何访客都能不限量地消耗你的额度（当前后端**没有限流**）。要么先加限流，要么只把链接发给评委。
- `.env` 永不提交到仓库（`.gitignore` 已排除 `.env` / `.env.*`），只存在于服务器上。

## 6. 上传前端构建产物

```powershell
# 本地仓库根目录
tar -czf $env:TEMP\sonic-matter-dist.tgz -C web dist
scp $env:TEMP\sonic-matter-dist.tgz root@<公网IP>:/tmp/
```

```bash
# 服务器
mkdir -p /opt/sonic-matter/web && tar -xzf /tmp/sonic-matter-dist.tgz -C /opt/sonic-matter/web
ls /opt/sonic-matter/web/dist     # 期望看到 index.html  assets/  favicon.svg  soundfonts/
```

## 7. 安装并启动 systemd 服务

```bash
cp /opt/sonic-matter/deploy/sonic-matter.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now sonic-matter
systemctl status sonic-matter --no-pager      # 期望 active (running)
```

看日志（`Ctrl+C` 退出）：

```bash
journalctl -u sonic-matter -f
```

启动成功时会打印 `已开启前端静态托管` 和 `Agent server 已启动`。

## 8. 放行防火墙（两层，都要做）

```bash
# ① 系统内 firewalld
firewall-cmd --permanent --add-port=8080/tcp
firewall-cmd --reload
firewall-cmd --list-ports          # 确认出现 8080/tcp
```

② 阿里云控制台 → 该实例 → **安全组** → 入方向 → 添加规则：`TCP` / 端口 `8080/8080` / 授权对象 `0.0.0.0/0`。

> 宝塔面板自带防火墙（面板里叫「安全」）。如果 `firewall-cmd` 里加完仍然打不开，从面板里再加一条，或在面板里直接放行 8080。

## 9. 验证

```bash
# 服务器内部
curl -s http://127.0.0.1:8080/api/health ; echo
curl -s http://127.0.0.1:8080/ | head -3
```

```powershell
# 你自己的电脑上（换成公网 IP）
curl.exe -s -o NUL -w "%{http_code}`n" http://<公网IP>:8080/
```

期望：`/api/health` 返回 `{"ok":true,...}`，根路径返回 `index.html`，浏览器打开能看到完整界面并导出 MIDI / WAV / MP3。

## 10. 日常更新

**只改了前端**（改了 React 代码）：本地 `npm run build` → 重传 `web/dist` → **不需要重启**（静态文件是按请求从磁盘读的）。

**改了后端**：重传 `server/` 源码 → `systemctl restart sonic-matter`。

```bash
systemctl restart sonic-matter
systemctl is-active sonic-matter
```

## 11. 排错速查

| 现象 | 排查方向 |
| --- | --- |
| `systemctl status` 显示 failed / 反复重启 | `journalctl -u sonic-matter -n 100 --no-pager` |
| 日志里 `端口 8080 已被占用` | `ss -lntp \| grep 8080`，换端口（改 `.env` 与 unit 的 `PORT`） |
| `/api/health` 正常，但 `/` 返回 404 JSON | `WEB_DIST_DIR` 指错，或 `web/dist` 没上传；看启动日志有没有 `前端构建产物目录不存在` 警告 |
| 服务器内 `curl` 正常，外面打不开 | 防火墙/安全组漏了一层（见第 8 步） |
| 页面能开但接口全 404 | 检查 `.env` 与 unit 里的 `SERVE_WEB`、`WEB_DIST_DIR` 是否指向同一份产物；`/opt/sonic-matter/web/dist` 里应有 `index.html` |
| 内存告警 / 服务被杀 | `systemctl show sonic-matter -p MemoryCurrent`；`MemoryMax=512M` 只会杀本服务 |
| 反复失败后 systemd 不再重启 | `systemctl reset-failed sonic-matter` 后重新 `start` |

## 12. HTTPS 兜底（免备案，可选）

如果需要一个 `https://` 的链接（比如提交材料里写着更好看），可以用 Cloudflare 免费隧道，**不需要域名、不需要备案**：

```bash
# 服务器上（github.com 已实测可达）
curl -fsSL -o /tmp/cloudflared.rpm https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-x86_64.rpm
rpm -ivh /tmp/cloudflared.rpm
cloudflared tunnel --url http://127.0.0.1:8080 --no-autoupdate
```

它会打印一个 `https://xxxx.trycloudflare.com` 地址，直接可用。

⚠️ **必须实测**：大陆网络到 Cloudflare 的连通性不稳定，用你的手机 4G 和校园网各打开一次。**打不开就放弃它**，用 IP 地址那套（第 9 步）。隧道是临时地址、重启会变，所以**提交材料以 `http://<公网IP>:8080` 为主，隧道地址作为备用**。

## 13. 安全边界（如实写进材料）

- 赛期内是 **IP + HTTP** 访问：浏览器会提示"不安全"，没有域名、没有备案 —— 这是时间约束下的临时方案。
- 服务器上 **不放 API Key**：访客用自己的 Key，或走本地 fallback。
- 后端目前**没有限流、没有鉴权**（Demo 定位）。公网开放后，任何知道地址的人都能调用接口；正式版需要限流 + 账号体系。
- SSH 用**密码登录且 22 端口对公网开放**：建议装 fail2ban、把 22 端口限制到自己的 IP，赛后换成密钥登录。
- 工程数据默认存在**访客各自的浏览器 localStorage** 里；换设备/清缓存会丢，请用「保存工程」导出一份 JSON 备份。
- 云端工程（`/api/projects`）已可用：数据存在 `PROJECTS_DIR`（默认 `server/projects/projects.db`，SQLite 单文件）。**Demo 级实现：无账号、无密码，读取公开（分享链接靠这个），写入用浏览器本地生成的 owner 串校验。**

## 14. 附：在本地演练生产模式

上线前想先在本机验证"单端口托管"这套逻辑（Git Bash / Linux / macOS）：

```bash
cd server
SERVE_WEB=1 PORT=8080 node src/index.ts
# 打开 http://127.0.0.1:8080/ ，看到的应该是构建产物而不是 Vite 的 5173
```

PowerShell 下：

```powershell
cd server
$env:SERVE_WEB='1' ; $env:PORT='8080' ; node src/index.ts
```

依赖仍需先在 `server/` 与 `web/` 各 `npm ci` 一次，并且 `web/dist` 要先 `npm run build` 出来。

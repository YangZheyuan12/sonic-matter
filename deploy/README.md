# Sonic / Matter 线上部署与更新

当前生产环境：

```text
https://8.141.109.141/         -> Nginx :443 -> Node :8088
http://8.141.109.141/          -> 308 跳转 HTTPS
127.0.0.1:8088                -> Node 内网监听（不对公网开放）
/api/*                         -> 同一个 Node 进程
/generated/*                   -> server/generated
云端工程                       -> server/projects/projects.db
```

服务器为 Alibaba Cloud Linux 3，应用目录为 `/opt/sonic-matter`，systemd 服务名为 `sonic-matter`。Node 进程同时托管 `web/dist` 与 API，Nginx 终止 HTTPS 并把请求反代到本机 8088。

## 安全边界

- 不要提交或覆盖服务器的 `server/.env`，其中可能包含密钥和部署路径。
- 更新前备份 `server/projects/projects.db` 与 `server/auth`；它们分别保存云端工程、账号库和初始凭据。
- `server/generated`、`server/projects` 与 `server/auth` 都是运行时数据，更新源码时不能删除。
- 已提供固定双账号登录接口、持久化会话及登录限流；前端登录入口、管理员密钥配置和 AI 接口权限接入将在后续步骤完成。
- 现有创作 API 暂未应用登录守卫。分享链接可公开读取；工程写入权限仍依赖浏览器本地 owner 串。完成 AI 接口权限接入前，不应配置公共付费供应商密钥。

## 首次部署

### 1. 准备源码与依赖

```bash
git clone https://github.com/YangZheyuan12/sonic-matter.git /opt/sonic-matter
cd /opt/sonic-matter/server
/opt/sonic-matter/node/bin/npm ci --omit=dev
```

Node 版本须为 24；项目可直接用 Node 原生类型剥离运行 `server/src/index.ts`。

### 2. 构建前端

服务器内存不足时在本地执行 `npm run build --prefix web`，再把整个 `web/dist` 上传到 `/opt/sonic-matter/web/dist`。服务器资源允许时也可直接构建：

```bash
cd /opt/sonic-matter/web
/opt/sonic-matter/node/bin/npm ci
/opt/sonic-matter/node/bin/npm run build
```

### 3. 服务配置

`server/.env` 至少包含：

```ini
PORT=8088
SERVE_WEB=1
WEB_DIST_DIR=/opt/sonic-matter/web/dist
DATA_DIR=/opt/sonic-matter/server/generated
PROJECTS_DIR=/opt/sonic-matter/server/projects
AUTH_DIR=/opt/sonic-matter/server/auth
AUTH_ORIGIN=https://8.141.109.141
NODE_ENV=production
```

安装仓库中的 systemd 单元：

```bash
cp /opt/sonic-matter/deploy/sonic-matter.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now sonic-matter
```

### 4. Nginx 反向代理

在现有 Nginx 站点的 `server` 块中将 `/` 代理到 8088；具体配置文件位置由宝塔/Nginx 当前安装决定，不要覆盖其它站点：

```nginx
location / {
    proxy_pass http://127.0.0.1:8088;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    add_header Cache-Control "no-cache";
}
```

修改后先检查再重载：

```bash
nginx -t
systemctl reload nginx
```

### 5. 初始化固定双账号（当前认证阶段）

账号不开放注册，固定只有 `admin`（管理员）和 `user`（使用者）。首次部署源码后，在服务器执行：

```bash
cd /opt/sonic-matter/server
/opt/sonic-matter/node/bin/node src/auth-init.ts
chmod 700 auth
chmod 600 auth/auth.db auth/initial-credentials.txt
```

命令会为两个账号生成随机初始密码并写入 `auth/initial-credentials.txt`，不会在终端打印密码；重复执行不会重置已有账号。该文件只允许 root 读取，不要复制进 GitHub 或发送到聊天中。

### 6. 登录接口与会话（第三步）

| 接口 | 行为 |
| --- | --- |
| `POST /api/auth/login` | JSON `{ username, password }`，成功返回 `{ account: { id, username, role }, expiresAt }` 并设置会话 Cookie |
| `GET /api/auth/me` | 返回当前账号和过期时间；访客或过期会话返回 `{ account: null, expiresAt: null }` |
| `POST /api/auth/logout` | 撤销当前会话并清除 Cookie，返回 `{ ok: true }`，重复退出仍成功 |

登录与退出必须携带 `Content-Type: application/json` 和 `X-Sonic-Auth: 1`。浏览器请求必须来自 `AUTH_ORIGIN`（未配置时按当前 Host 和协议校验），拒绝跨站请求。前端后续通过已有 `apiJson` 同源请求这三个接口，Cookie 自动随请求发送，无需把密码或令牌保存到 localStorage。

生产环境自动使用 `__Host-sonic-session` Cookie，开启 `Secure`、`HttpOnly`、`SameSite=Strict` 和 `Path=/`，只允许 HTTPS 登录/退出。本地非生产环境使用 `sonic-session`，可通过 Vite 同源代理开发。服务仅信任 loopback 反向代理，Nginx 必须设置 `X-Forwarded-Proto` 和 `X-Forwarded-For`，并保持公网 8088 关闭。

会话绝对有效期 7 天，登录时轮换当前会话；同一账号允许最多 20 个浏览器会话并存，超出时淘汰最早会话。会话令牌仅以 SHA-256 哈希存入 `auth.db`，退出即时撤销，重启不丢失会话；禁用账号立即使其会话无效。登录尝试每 IP 每 15 分钟最多 10 次、每账号最多 30 次，超限返回 `429 / login_rate_limited` 和 `Retry-After`，计数同样在 SQLite 持久化。

`createAuth` 导出的 `requireAccount`、`requireRole` 和 `protectMutation` 供后续创作接口与管理员配置接口使用。当前步骤尚未增加前端登录表单，也尚未用这些守卫限制 AI 生成接口。

## 日常更新

Git 工作副本可从 GitHub 的 `main` 更新。当前生产目录是源码快照，没有 `.git`，应上传指定提交的源码包并更新 `DEPLOYED_COMMIT`，不能直接在该目录执行 `git pull`。无论哪种方式，构建前均不要删除运行时数据。

SQLite 启用 WAL，更新前应使用 SQLite 在线备份（Node `node:sqlite` 的 `backup` API）或停服务后复制整个数据库目录；不能仅复制活跃数据库的 `.db` 文件。备份应保存在 root 专用目录，包含工程库、认证库、初始凭据和 `.env`。下面 Git 更新示例省略备份命令，执行前须先完成备份：

```bash
cd /opt/sonic-matter
git fetch origin
git pull --ff-only origin main

cd /opt/sonic-matter/server
/opt/sonic-matter/node/bin/npm ci --omit=dev

cd /opt/sonic-matter/web
/opt/sonic-matter/node/bin/npm ci
/opt/sonic-matter/node/bin/npm run build

systemctl restart sonic-matter
systemctl is-active sonic-matter
```

若服务器不适合构建前端，在本地构建并上传 `web/dist`，服务端源码更新后再重启 systemd。

## 验证

服务器内部：

```bash
curl -fsS http://127.0.0.1:8088/api/health
curl -I http://127.0.0.1:8088/
curl -I http://127.0.0.1/
```

服务器外部：

```powershell
curl.exe -kfsS https://8.141.109.141/api/health
curl.exe -kI https://8.141.109.141/
curl.exe -I http://8.141.109.141/
```

期望健康接口包含 `"ok":true`，HTTPS 页面返回 HTTP 200，HTTP 入口返回 308。IP 证书受客户端兼容性影响，排错命令使用 `-k`；浏览器访问时仍会校验证书。

## 回滚

代码回滚使用明确的已知正常 commit，不要删除工程数据库：

```bash
cd /opt/sonic-matter
git log --oneline -10
git switch --detach <已知正常的commit>
cd web && /opt/sonic-matter/node/bin/npm run build
systemctl restart sonic-matter
```

如更新后发现 SQLite 工程异常，先停止服务，再用更新前的数据库备份恢复；恢复会覆盖更新后的云端工程，必须先确认数据范围。第三步只新增会话和限流表，代码回滚无需恢复账号数据库，也不会重置已有密码。

## 排错

```bash
systemctl status sonic-matter --no-pager
journalctl -u sonic-matter -n 100 --no-pager
ss -lntp | grep 8088
nginx -t
curl -v http://127.0.0.1:8088/api/health
```

| 现象 | 检查 |
| --- | --- |
| 8088 正常、HTTPS 返回 502 | Nginx `proxy_pass`、`nginx -t`、Nginx 错误日志 |
| API 正常、页面 404 | `SERVE_WEB=1` 与 `WEB_DIST_DIR`，确认 `web/dist/index.html` 存在 |
| 服务反复重启 | `journalctl -u sonic-matter`、Node 版本、`.env` 路径 |
| 云端工程列表为空 | `PROJECTS_DIR` 是否仍指向原目录，`projects.db` 是否被保留 |
| 公网 8088 不通但 HTTPS 正常 | 这是预期状态；8088 仅供服务器本机访问 |

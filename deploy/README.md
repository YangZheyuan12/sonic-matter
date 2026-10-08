# Sonic / Matter 线上部署与更新

当前生产环境：

```text
http://8.141.109.141/          -> Nginx :80 -> Node :8088
http://8.141.109.141:8088/     -> Node 直连（排错备用）
/api/*                         -> 同一个 Node 进程
/generated/*                   -> server/generated
云端工程                       -> server/projects/projects.db
```

服务器为 Alibaba Cloud Linux 3，应用目录为 `/opt/sonic-matter`，systemd 服务名为 `sonic-matter`。Node 进程同时托管 `web/dist` 与 API，Nginx 只负责把默认 HTTP 入口反代到 8088。

## 安全边界

- 不要提交或覆盖服务器的 `server/.env`，其中可能包含密钥和部署路径。
- 更新前备份 `server/projects/projects.db`，它保存 SQLite 云端工程。
- `server/generated` 与 `server/projects` 都是运行时数据，更新源码时不能删除。
- 当前没有正式账号认证。分享链接可公开读取；写入权限依赖浏览器本地 owner 串。
- 公网服务没有通用限流，不应把服务器 API Key 暴露给不受信任的访客。

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

## 日常更新

推荐让服务器从 GitHub 的 `main` 更新，构建前不要删除运行时数据：

```bash
cd /opt/sonic-matter
cp server/projects/projects.db /tmp/sonic-matter-projects.db.bak
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
curl.exe -fsS http://8.141.109.141/api/health
curl.exe -I http://8.141.109.141/
curl.exe -I http://8.141.109.141:8088/
```

期望健康接口包含 `"ok":true`，两个页面入口均返回 HTTP 200。

## 回滚

代码回滚使用明确的已知正常 commit，不要删除工程数据库：

```bash
cd /opt/sonic-matter
git log --oneline -10
git switch --detach <已知正常的commit>
cd web && /opt/sonic-matter/node/bin/npm run build
systemctl restart sonic-matter
```

如更新后发现 SQLite 工程异常，先停止服务，再用更新前的 `/tmp/sonic-matter-projects.db.bak` 恢复；恢复会覆盖更新后的云端工程，必须先确认数据范围。

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
| 8088 正常、80 返回 502 | Nginx `proxy_pass`、`nginx -t`、Nginx 错误日志 |
| API 正常、页面 404 | `SERVE_WEB=1` 与 `WEB_DIST_DIR`，确认 `web/dist/index.html` 存在 |
| 服务反复重启 | `journalctl -u sonic-matter`、Node 版本、`.env` 路径 |
| 云端工程列表为空 | `PROJECTS_DIR` 是否仍指向原目录，`projects.db` 是否被保留 |
| 公网 8088 不通但 80 正常 | 直连端口的安全组/防火墙；不影响 Nginx 默认入口 |

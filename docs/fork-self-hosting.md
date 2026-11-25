# Fork 自托管：GitHub 登录与账户等级

本指南只适用于包含 GitHub 账户功能的 fork。使用 fork 源码构建应用，不使用官方镜像或一键安装、更新脚本部署此功能；后续升级也从 fork 源码重新构建。

## 从源码部署

在部署主机上安装 Docker 和 Docker Compose 插件，进入 fork 的仓库根目录。新实例用 `cp local/local.env.example .env` 创建配置，再将文件权限设为 `600`。填写 `POSTGRES_PASSWORD`、`DATABASE_URL`、`ENCRYPTION_KEY`、`JWT_SECRET`、`CRON_SECRET` 和 `LOCAL_SETUP_TOKEN`；删除示例占位符。三个应用密钥和初始化令牌分别用 `openssl rand -hex 32` 生成。`DATABASE_URL` 应指向 Compose 中的 `db:5432`，并与 `POSTGRES_DB`、`POSTGRES_USER` 和 `POSTGRES_PASSWORD` 匹配。若数据库密码含 URL 特殊字符，请在连接串中对密码部分做百分号编码。

将 `APP_URL` 设置为浏览器实际访问的站点地址，例如 `https://subboost.example.com`（不是容器地址，也不含路径）。对外部署使用 HTTPS；如果反向代理与应用在同一台主机上，可保留示例中的 `SUBBOOST_BIND_ADDRESS=127.0.0.1`。

```bash
# 在仓库根目录执行。升级时将 subboost 替换成现有 Compose 项目名（见下文）。
fork_compose() {
  docker compose -p subboost --env-file .env \
    -f local/docker-compose.yml -f local/docker-compose.fork.yml "$@"
}
fork_compose config --quiet
fork_compose up -d --build
fork_compose logs app
```

容器启动时运行 Prisma 迁移。新实例访问 `${APP_URL}/login#setup-token=<LOCAL_SETUP_TOKEN 的值>` 初始化密码管理员；升级实例沿用原密码和会话，不重新初始化。

## 启用 GitHub 登录（可选）

1. 在 GitHub 的 **Settings → Developer settings → OAuth Apps → New OAuth App** 创建 [OAuth App](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/creating-an-oauth-app)，不要选 GitHub App。**Homepage URL** 填 `APP_URL`，**Authorization callback URL** 填站点地址加 `/api/auth/github/callback`，例如 `https://subboost.example.com/api/auth/github/callback`。不要把 `${APP_URL}` 字面量填进 GitHub。
2. 登记后将 Client ID 和生成的 Client Secret 写入部署用的 `.env`：

   ```dotenv
   GITHUB_OAUTH_CLIENT_ID=<GitHub OAuth App Client ID>
   GITHUB_OAUTH_CLIENT_SECRET=<GitHub OAuth App Client Secret>
   ```

   这两项由 fork 的 Compose 覆盖文件传给 `app` 容器，仅在运行时使用。不要提交 `.env` 或分享带有环境值的 Compose 输出。
3. 运行 `fork_compose up -d app` 应用配置。密码管理员已初始化且两项都有值后，登录页才显示 GitHub 入口。缺任一项不会影响初始化或密码登录；要关闭新的 GitHub 登录，清空两项并再次运行该命令。关闭后不会删除已创建的账户。

开启后，任何能完成 GitHub 授权并访问本站的人都能注册，首次登录自动获得 Level 1。等级只限制每个账户的资源数量，不是注册白名单，也不限制全站用量；删除账户也不会阻止同一用户再次注册。

## 升级已有实例和回退

1. 保留旧版本的镜像、Compose 配置和 `.env`，尤其是原有的 `JWT_SECRET`、`ENCRYPTION_KEY`、数据库连接配置和 `APP_URL`。先在隔离数据库上恢复备份并演练升级。正式切换时停止原实例的 `app` 和 `cron` 再做一次备份，确保备份后没有旧版写入。官方安装可使用 `subboost backup`；手动 Compose 部署可用原项目的 `docker compose … exec -T db sh -c 'pg_dump -Fc -U "$POSTGRES_USER" -d "$POSTGRES_DB"'` 导出到受保护的文件，确认命令成功并验证可恢复。不要删除原数据卷。
2. 用原配置作为 fork 的 `.env`，确认原 PostgreSQL 数据卷。若沿用同一个内置数据库卷，保留原 Compose 项目名（可用 `docker compose ls` 查看），并确认 `subboost-local-db` 仍解析到原卷，而不是创建空库；自定义卷或外部库需保留原数据库连接和存储配置。OAuth 先留空，再用上文命令从 fork 源码构建并启动。
3. 先验证密码登录、升级前已登录的会话及原有订阅链接。确认迁移成功后再配置 OAuth。单管理员迁移不会挑选某一行授予权限：若旧库含多个管理员，迁移会失败，应调查数据后再重试。
4. **回退时不能只换回旧镜像。** 旧版不支持升级后的账户结构，尤其是含 GitHub 账户的数据库。停止 fork 的 `app` 和 `cron`，保留当前库备查，将升级前备份恢复到干净的数据库，使用原配置和旧版本连接已恢复的库，再启动服务。升级之后新增或修改的数据不包含在升级前备份中。

# SubBoost 自用 Fork 说明

本仓库（[laplacesc/subboost](https://github.com/laplacesc/subboost)）基于官方 [SubBoost](https://subboost.org/) 2.12.0，在自托管版（`local/`）上增加 GitHub 登录、账户等级和账户管理。仅供自用。

官方原有的说明见 [README.md](README.md) / [README-CN.md](README-CN.md)，这两个文件不做修改。

## 相对官方的改动

### 账户模型

- 仍只使用 `LocalAdmin` 一张账户表，没有新建用户表，原有订阅、模板等数据的 `ownerId` 关联和 JWT 会话保持不变。
- 新增字段：`accountKind`（`PASSWORD` / `GITHUB`）、`accountLevel`、`githubId`、`githubLogin`、`displayName`、`avatarUrl`；`username` 和 `passwordHash` 改为可空。
- 迁移 `local/prisma/migrations/20261124090000_github_accounts` 把升级前唯一的管理员回填为 `PASSWORD` + Level 4。旧库若有多于一个管理员，迁移会直接失败，不会自动挑选一个授权。

### GitHub 登录

- 使用 GitHub OAuth App 的 Web 流程，state 和 PKCE 放在签名的短时 cookie 中，只请求公开身份信息。
- 按 GitHub 数字 ID 原子创建或更新账户，用户改名后仍对应同一账户；首次登录得到 Level 1。
- GitHub 账户不能走密码登录。`GITHUB_OAUTH_CLIENT_ID` 或 `GITHUB_OAUTH_CLIENT_SECRET` 未配置时，登录页不显示 GitHub 入口，密码登录和初始化流程不受影响。
- 代码：`local/src/lib/github-oauth*.ts`、`local/app/api/auth/github/`、`local/src/components/github-login-entry.tsx`。

### 账户等级与配额

| 等级 | 订阅 | 模板 | 节点上限/订阅 | 导入源/类型 | 说明 |
| --- | --- | --- | --- | --- | --- |
| Level 1 | 1 | 1 | 100 | 2 | GitHub 首次登录默认 |
| Level 2 | 1 | 1 | 200 | 3 | |
| Level 3 | 5 | 5 | 1000 | 10 | |
| Level 4 | 9999 | 9999 | 10000 | 不限 | 仅密码管理员，不可修改 |

- 配额定义在 `local/src/lib/account-quota.ts`，修改数值只需改这一处。
- 配额在服务端检查，并在账户行锁内执行（`local/src/lib/account-quota-store.ts`）；超限返回 `403 QUOTA_EXCEEDED`。
- 降级不删除已有数据：超额资源可以保留，但不能在超额的维度继续增加用量。手动刷新和定时任务的节点上限取当前配额与已保存节点数中的较大值，且不超过系统硬上限。
- 导入局域网/不安全来源的放行设置只对密码管理员本人的请求生效。

### 账户管理页

- 密码管理员登录后，顶部菜单出现“账户管理”，页面为 `/dashboard/accounts`，接口为 `local/app/api/admin/accounts/`。
- 可以查看所有账户、删除 GitHub 账户（级联删除其订阅和模板）、把 GitHub 账户调整为 Level 1–3。管理员自身不能被删除或调级。
- 修改类请求要求同源 `Origin`。
- 账户设置页显示登录方式、等级和配额使用情况（`local/src/components/account-profile-card.tsx`）。

## 与官方保持易于合并

- 新功能尽量放在新文件里，新增的代码文件顶部注明 `Fork extension`。
- 对官方已有文件只做必要的小改动：插入入口、传入 `ownerId`、调用配额检查。
- 共享包只改了一行：`packages/ui/src/templates/template-upload-dialog.tsx` 中的公开发布开关加上 `showVisibilityControls &&` 条件。
- 部署差异放在独立的覆盖文件 `local/docker-compose.fork.yml` 中，官方的 `local/docker-compose.yml`、安装脚本和更新脚本均未修改。
- 设计与需求记录在 `openspec/specs/local-*` 和 `openspec/changes/archive/2026-11-25-add-github-account-levels/`。

合并官方更新：

```bash
git remote add upstream https://github.com/SubBoost/subboost.git   # 只需执行一次
git fetch upstream
git merge upstream/main
```

冲突多半出现在上面提到的少数官方文件和 Prisma schema 里。合并后检查新的官方迁移目录名是否排在 fork 迁移 `20261124090000_github_accounts` 之后，然后运行：

```bash
npm ci
npm run typecheck
npm run test:unit
```

涉及数据库的测试需要一个 PostgreSQL，通过 `MIGRATION_TEST_DATABASE_URL` 传入，例如 `postgresql://sb:sb@localhost:55432/postgres`。

## 部署

本 fork **不能**用官方镜像或 `subboost update` 部署，否则会回到官方版本，并且官方版本无法读取迁移后的账户结构。只能从本仓库源码构建。

### 方式一：在部署主机上从源码构建

完整步骤（新实例初始化、配置 GitHub OAuth App、升级已有实例、回退）见 [docs/fork-self-hosting.md](docs/fork-self-hosting.md)。核心命令：

```bash
docker compose -p subboost --env-file .env \
  -f local/docker-compose.yml -f local/docker-compose.fork.yml up -d --build
```

### 方式二：本机构建镜像后传到低配主机

部署主机内存或磁盘不够构建时（例如 2 GB 内存的 ARM 软路由），在开发机上交叉构建，再传过去：

```bash
# 开发机，仓库根目录
docker buildx build --platform linux/arm64 -f local/Dockerfile \
  -t subboost-fork:<版本> --load .
docker save subboost-fork:<版本> | gzip | ssh <主机> 'gunzip | docker load'
```

在部署主机的 Compose 目录里（与官方 `docker-compose.yml` 放在一起）新建 `docker-compose.fork.yml`：

```yaml
services:
  app:
    image: subboost-fork:<版本>
    environment:
      GITHUB_OAUTH_CLIENT_ID: ${GITHUB_OAUTH_CLIENT_ID:-}
      GITHUB_OAUTH_CLIENT_SECRET: ${GITHUB_OAUTH_CLIENT_SECRET:-}
```

沿用已有实例的 Compose 项目名、数据卷和 `.env`。先按[升级指南](docs/fork-self-hosting.md#升级已有实例和回退)停止旧版 `app` 和 `cron`、备份配置和数据库，再启动：

```bash
docker compose -p subboost --env-file .env \
  -f docker-compose.yml -f docker-compose.fork.yml up -d app cron
```

容器启动时会自动执行迁移。确认密码登录、原有订阅链接都正常后，再在 `.env` 中填写 `GITHUB_OAUTH_CLIENT_ID` 和 `GITHUB_OAUTH_CLIENT_SECRET`，并重新执行上面的 `up -d app`。OAuth App 的回调地址为 `${APP_URL}/api/auth/github/callback`。

升级时用新代码重新构建镜像、换一个标签，修改 `docker-compose.fork.yml` 中的 `image` 后执行同样的命令。回退方法见 [docs/fork-self-hosting.md](docs/fork-self-hosting.md#升级已有实例和回退)：只换回旧镜像不够，需要恢复升级前的数据库备份。

### 注意事项

- 开启 GitHub 登录后，任何能完成 GitHub 授权的人都可以注册（Level 1）。等级只限制资源数量，不是注册白名单。
- `.env` 中有 OAuth Secret 和应用密钥，权限设为 `600`，不要提交到仓库。

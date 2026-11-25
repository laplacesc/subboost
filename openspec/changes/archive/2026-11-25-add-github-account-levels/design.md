# Design

## Context

`local/prisma/schema.prisma` 目前由 `LocalAdmin` 持有 `Subscription` 和 `LocalTemplate`，所有权关联已支持级联删除。`local/src/lib/session.ts` 在 JWT `sub` 中存账户主键，`local/src/lib/auth.ts` 每次请求查账户，但目前把已登录账户和密码管理员视为同一概念。订阅的保存、手动刷新和定时刷新走不同入口；公开 YAML 路由只读缓存，不发出源站请求。变更动机见 `proposal.md`。

## Goals / Non-Goals

**Goals:**
- 升级后密码管理员、旧会话、资源所有权和订阅 URL 不变；普通账户沿用现有资源所有权和会话生命周期。
- 服务端只从当前数据库记录确定身份、权限和额度；账号变更与配额写入在并发下仍成立。
- 让 fork 的功能主体维持在新增文件中，减少上游更新时要重放的现有文件差异。

**Non-Goals:**
- 不实现 GitHub 与密码账户互绑、组织白名单、封禁、兑换码、付费或官方信任评级算法。
- 不更改公开订阅的 token 协议、自托管刷新间隔、已有刷新失败处理或模板可见性合同。
- 不重命名历史数据库表、重写迁移或引入第二套会话与资源所有权系统。

## Decisions

### 保留原账户主键，显式区分认证方式与权限

- `LocalAdmin` 继续作为唯一账户主表和资源外键目标，只新增显式身份类型、等级和 GitHub 资料字段。密码账户使用原 `username` / `passwordHash`，固定 Level 4；GitHub 账户使用唯一的 GitHub 数字 ID（十进制字符串），等级仅为 1–3，密码字段为空。用户名与密码哈希改为条件可空，不为 GitHub 生成假密码或占用密码用户名。用数据库约束固定两种状态，限制密码管理员至多一个；首次 setup 的现有事务和锁继续保证只建一次。
- 密码登录和 setup 检查显式密码管理员；缺失或不合法账户类型拒绝授权。把 `getCurrentAdmin` / `withCurrentAdmin` 等实际上验证会话的调用迁移到普通账户入口；另外为管理页、管理 API 和内网例外设置使用明确的管理员鉴权。保留 JWT 字段和 cookie 兼容，更新后的角色、等级和用量始终读取数据库，不从 token 或请求体取权限。
- 不采用独立的多态账户表，因为会复制会话查找，或迫使订阅和模板重接外键；也不把缺失 OAuth 记录解释为管理员，避免迁移不完整时误授权。

### GitHub 登录走现有会话

- 新增 `/api/auth/github` 与 `/api/auth/github/callback`。两项配置 `GITHUB_OAUTH_CLIENT_ID`、`GITHUB_OAUTH_CLIENT_SECRET` 齐全且 setup 完成才显示入口、接受 OAuth；回调 URL 固定为 `APP_URL` 的站点地址加 `/api/auth/github/callback`。不使用请求 Host 推导回调，不接受任意返回地址。
- 使用 [GitHub OAuth App Web flow](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps)：短时且与浏览器绑定的签名 HttpOnly cookie 保存随机 `state` 与 PKCE verifier，使用 S256，按部署 HTTPS 设置 Secure、SameSite=Lax。回调验证并消费临时状态后向固定 GitHub 端点换码、读取 `/user`；不请求仓库、邮箱或离线权限，不持久化或输出 OAuth token、code 或 secret。缺失、过期、拒绝授权、状态失配或上游失败都不签发新会话。
- 按 GitHub 数字 ID 原子创建或更新账户；并发首次登录只能得到同一内部账户。只在创建时分配 Level 1；之后更新显示名、GitHub 登录名、头像和最近登录时间，不改等级或绑定。不同身份即使显示名相同也不合并。成功后使用现有会话并返回站内页面；未配置 OAuth 不妨碍密码登录与初始化。

### 管理页和账户设置沿用共享 UI 能力

- `/dashboard/settings` 和 `/api/auth/me` 提供当前账户身份、等级、上限与订阅/模板用量，沿用共享用户模型；明确 Level 4 才投影 `isAdmin`。在 `local/src/components/local-header.tsx` 注入现有 `privilegedMenuItem`，指向 `/dashboard/accounts`。沿用 `local/` 页面布局和共享组件，不改共享导航结构。
- `/api/admin/accounts` 列表只返回展示和管理必要字段（内部 ID、认证方式、登录标识、显示名、等级和最近登录等）；`PATCH`、`DELETE /api/admin/accounts/[id]` 仅允许管理员管理 GitHub 目标。写操作拒绝非本站来源，数据库写入条件再次限定目标类型。管理员行只读，不显示可用的调级或删除控件；GitHub 删除需先确认。
- 删除事务依赖已有级联关系清理被删账户的订阅、节点快照、刷新状态、模板和账户设置。沿用会话的账户存活检查以及订阅 token 查库，使删除后的请求失效；再次登录获得新内部 ID 和初始等级，不复用资源、会话或账号级草稿键。
- `local/app/templates/page.tsx` 已设置 `allowPublicTemplates: false`，但共享上传对话框的公开默认开关只看 `userIsAdmin`。给该开关加上已有 `showVisibilityControls` 条件是唯一计划中的共享实现改动；避免假报 `isAdmin`，不改变官方模式的模板功能。保持两个本地订阅界面的现有刷新间隔覆盖配置。

### 用一个本地策略算配额，在每次持久化时检查

- 新增本地配额策略模块，统一解析等级上限、现有用量和错误信息。用持久化前的实际当前用量作比较：每个维度独立要求 `候选用量 ≤ max(当前用量, 等级上限)`；新资源的节点、来源维度当前用量为零。仅在用户新增资源时阻止超额总数，改名、删除等不因其他维度超限被阻止。系统模板不计数；无上限在服务端作为不限处理，对共享 UI 沿用其不限展示约定。
- `local/src/lib/subscription-service.ts` 和 `local/src/lib/template-service.ts` 的创建事务先锁账户行，再读取等级、计数并保存。对订阅更新、刷新提交和管理员调级使用同一账户锁，顺序为账户、资源；读取合并 patch 所需的当前数据也必须在事务内。使用服务端实际归一化后的 `config.sources` 分别计数 `url`、`yaml`、`nodes`；独立 `urls` 表示也执行 URL 上限，镜像不与配置叠加。`userinfoUrl` 是该来源的一部分，不另计来源，但同样受出站策略约束。
- 手动和定时刷新在事务外拉取与计算快照，最终提交时重读所有者等级并验证当前订阅版本，使用相同节点阈值。版本变化或账户删除时不覆盖新数据；配额失败复用现有失败状态和错误、保留旧快照，不截断节点。调级本身不改链接或刷新设置；定时任务在实际连续失败后的既有退避或停用规则仍生效。
- 不把 UI 限制或 `/api/auth/me` 当授权，不把配额散落成多处常量，也不改共享快照算法。公开 YAML 继续使用缓存并保持现有响应头策略。

### 内网例外按发起者或订阅所有者授权

- `local/src/lib/source-import-settings.ts` 不再匿名取第一条账户记录。只有显式密码管理员且其设置已开启时，才对该管理员的请求允许例外；普通用户及无法识别所有者的调用始终沿用关闭例外时的现有出站策略，拒绝受限目标。
- 把调用者策略传到 `local/src/lib/source-import.ts`，覆盖直接订阅导入、规则探测、用量请求与两个刷新路径，包括重定向和独立 userinfo URL。手动操作用当前账户，后台刷新用订阅所有者；不能使用执行 cron 的身份或全局开关代替。设置页面、读写 API 都只向密码管理员开放。沿用既有目标验证与安全传输，不另写网络栈。

### 上游同步保留单独的变更面

- OAuth、账户管理、配额模块和页面放在 `local/` 新文件；在现有文件只接入身份、锁与策略，Prisma 只追加迁移。用独立的 fork 部署说明和 compose 覆盖文件给源码构建传入可选 OAuth 配置，不修改官方镜像或安装更新脚本，不将官方镜像部署成包含此功能的版本。
- 保持 `upstream` 指向官方、私有部署从 fork 源码构建。合入官方更新时，优先重跑本地认证、配额与管理员 UI 的回归用例，并检查上游新增的资源写入、源请求或权限入口是否接入现有本地策略，不维护一份共享代码副本。

## Risks / Trade-offs

- 配置 OAuth 后，能完成 GitHub 登录的人均可注册；配额是每账户的资源限制，不是邀请制度或全站容量保护。未打算开放注册时不配置 OAuth；不把删除当封禁。
- 同一账户的容量变更在 PostgreSQL 中串行，以数据库正确性换取少量锁等待；不在持锁期间执行 GitHub 或源站网络请求。
- 降级后旧快照可能暂时高于当前等级；允许持平和减量，优先保留已有链接与可用数据。
- 共享 UI 的管理员标志还触及模板与刷新等界面；验证自托管未新增公开模板能力、刷新间隔不变，官方可见性逻辑保持原状。

## Migration Plan

1. 备份数据库，并用一份已有管理员、订阅、模板、刷新状态和内网设置的数据库副本演练；空库另测 setup。
2. 追加 Prisma 迁移：先把已存在且符合旧单管理员约束的账户显式回填为密码管理员 Level 4，再启用身份/等级约束和 GitHub 唯一索引。若旧数据不符合单管理员约束，迁移失败而不是选任一行授予权限。不更改旧账户主键及任何资源 token。
3. 部署 fork build；先验证密码登录、旧会话和原链接，再配置 OAuth App 和回调 URL、开启 GitHub 登录。关闭 OAuth 可停止新的 GitHub 登录但不自动移除账户；含 GitHub 数据的库不直接运行旧版应用，需回退时同时恢复升级前备份。

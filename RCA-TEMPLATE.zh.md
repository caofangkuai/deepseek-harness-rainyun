# 雨云云应用（RCA）模板逐字段填写文档 — DeepSeek Harness

> 依据雨云官方教程《App版本制作教程详解》(forum.rainyun.com/t/topic/11296) 逐字段对照。
> 创建入口：https://app.rainyun.com/apps/rca/app-template/create

## 0. 前置

- [ ] 已有雨云账号并开通云应用（RCA）能力
- [ ] 镜像已推送到公网可拉取仓库（见 README 推送章节），本文档以 GitHub Container Registry 为例
- [ ] 准备一张应用图标（可选，商店展示用）

## 1. 应用模板（App 模板）

| 字段 | 填写建议 |
|---|---|
| 名称 | `DeepSeek Harness` |
| 简介 | DeepSeek 官方开源的 AI Agent 框架（一切皆插件），此处为 Web UI 一键部署版 |
| 分类 | 开发工具 / AI |
| 图标 | 可临时用 DeepSeek 相关素材，上架审核前替换为合规图标 |

## 2. 版本（Version）— 基本信息

| 字段 | 值 | 说明 |
|---|---|---|
| 版本号 | `0.2.2-rc.1-fix3` | 与镜像 tag 保持一致 |
| 镜像 | `ghcr.io/caofangkuai/deepseek-harness:0.2.2-rc.1-fix3` | 已推送到 ghcr.io（公开），也可用 `:latest`。注意：当前为 **linux/amd64** 单架构镜像，雨云 x86_64 节点可直接拉取；若雨云给 arm64 节点，需先构建多架构镜像 |
| 最小CPU | `1` 核 | Node 服务，1 核可跑 |
| 最小内存 | `512` MB | 推荐给用户写 1GB，agent 跑任务更从容 |

## 3. 版本 — Command & Env

- **Command**：留空（使用镜像内置 ENTRYPOINT，即 `docker-entrypoint.sh`）
- **Args**：留空
- 不需要覆盖，入口脚本已处理全部初始化逻辑。

## 4. 版本 — Env 环境变量

| 键 | 值 | 说明 |
|---|---|---|
| `PORT` | `3080` | 服务监听端口，与 Services 内部端口一致 |
| `DSH_HOME` | `/data` | 数据目录，与 VolumeMounts 挂载路径一致 |
| `DSH_TELEMETRY_DISABLED` | `1` | 关闭遥测 |

## 5. 版本 — VolumeMounts 持久化卷挂载

> ⚠️ **挂载路径（容器内路径）必填，且必须与 Env 中的 `DSH_HOME` 一致（=`/data`）**。dsh 的所有用户数据（settings.yaml、.credentials.yaml、会话、profiles、storages）都存于 `$DSH_HOME`；路径不一致时数据落不到卷里，容器重建即丢失。

| 名称 | 挂载路径（容器内） | 子路径（必填） | 内容类型 | 说明 |
|---|---|---|---|---|
| `dsh-data` | `/data` | `dsh` | 目录 | **必填**。与 Env `DSH_HOME=/data` 对应；子路径是项目共享磁盘下的子目录，**固定后勿改**（改了=数据位置变了） |
| `workspace` | `/workspace` | `workspace` | 目录 | 可选。agent 工作区；不挂则每次重建后工作区为空 |

> 说明：雨云每个项目有共享磁盘，App 挂载的是项目磁盘中的子路径；多个 App 可共用。
> 容器默认以 root 运行，镜像内已预先创建 `/data` 与 `/workspace`；如需非 root 运行，设置 `DSH_RUNTIME_UID=1000`，入口会自动修复卷属主。

## 6. 版本 — Services 服务配置

| 字段 | 值 |
|---|---|
| 服务名称 | `web` |
| 显示名称 | Web UI |
| 服务类型 | **外部访问**（公网） |
| 内部端口 | `${PORT}`（或直接 `3080`） |
| 外部端口 | `3080`（或雨云分配的固定端口） |
| 协议 | `tcp` |

## 7. 版本 — Options 选项（用户部署时填写）

| 标签 | 环境变量键 | 类型 | 默认值 | 必填 | 说明 |
|---|---|---|---|---|---|
| 模型 API Key | `DEEPSEEK_API_KEY` | 文本/密码 | 空 | 否 | 部署后也可在 Web UI「设置→模型」里填；填了则开箱即用（DeepSeek 提供方默认读取此变量） |
| 登录密码（推荐） | `DSH_AUTH_PASSWORD` | 文本/密码 | 空 | 否 | **推荐填写**：密码存在模板配置里（不依赖卷）。即使雨云重建容器导致卷数据被重置，重启后也会自动用此值恢复密码，**不会**再回到"设置密码"页。不填则用首次访问注册的方式（卷重置后需重新设置） |
| 服务端口 | `PORT` | 数字 | `3080` | 否 | 一般无需修改。改端口后重启会自动更新 profile 补丁（`/data/profiles/web/cordis.patch.yml`）的托管行 |

> 说明：dsh 0.2.2+ 拒绝绑定 `0.0.0.0`，镜像会让 dsh 只监听容器回环地址，公网统一经内置网关进入。网关会自动改写 Host 并剥离 Origin，因此**无需填写公网访问地址**，`DSH_TRUSTED_HOSTS` / `DSH_TRUST_FENCE` 也不再需要。

## 8. 版本 — Scripts（可选）

- 不需要。首次初始化（写 profile 补丁、启动回环 dsh 与网关）已由镜像内置入口脚本完成。
- 若想用雨云的**安装脚本**（initContainer）预置 profile，可参考：在安装镜像 `node:24-slim` 中执行
  `mkdir -p /data/profiles/web` 并写入 webserver 补丁（内容见 `docker-entrypoint.sh`）。

## 9. 特殊环境变量（如有多容器需求）

本模板单容器即可，无需使用 `${rca_svc_*}` 特殊变量。若以后扩展（如加 Postgres 存会话），数据库容器内可这样引用：
- `${rca_svc_main_db}` → 数据库内部集群地址
- `${rca_svc_main_db_ext_ip}` → 数据库公网 IP

## 10. 提交上架（对照 topic/11430）

1. 模板制作完成后，在「应用模板」选项卡点击**提交上架审核**
2. 审核通过后，在**应用商店** `https://app.rainyun.com/apps/rca/store` 找到你的应用详情页链接
3. 制作推广链接：`https://app.rainyun.com/apps/rca/store/<应用ID>?ref=[你的UID]`（或 `/[优惠码]_`）
4. 在仓库 README 放一键部署按钮（素材与 Markdown 见 README.md 的「雨云一键部署」章节）
5. 想提高返利比例/拿官方合作标识：QQ 联系雨云 952637635 洽谈（开源作者专属活动）

## 11. 部署后验收清单

- [ ] 容器日志出现 `[dsh-entrypoint] starting dsh web on 127.0.0.1:3081` 和 `[auth] gate listening on 0.0.0.0:3080`（若首次出现 `fixing ownership of volume roots` 属正常，说明卷属主已自动修复）
- [ ] 浏览器打开雨云分配的公网地址，首页正常加载（无 /api 403）
- [ ] 设置→模型 填入 DeepSeek API Key 保存成功
- [ ] 选择一个工作区，发一条任务（如 `Summarize this repository`）能正常执行 —— 这一步同时验证**进程沙箱**（bash 工具可用）
- [ ] 重启应用后设置/会话仍在（卷持久化生效）

## 12. 常见问题排查

| 现象 | 原因 | 解决 |
|---|---|---|
| 日志报 `mkdir: cannot create directory '/data/profiles': Permission denied` | 旧镜像以非 root 启动且卷属主为 root | 使用最新镜像（默认 root 运行；设 `DSH_RUNTIME_UID=1000` 时入口也会自动修复属主）；或删除应用重建成新镜像 |
| 页面能打开但反复跳登录/401 | 重启后旧 dsh cookie 签名失效 | 网关会自动清旧 cookie 重试；仍失败则重启容器，或清除浏览器站点数据 |
| 日志报 `host "0.0.0.0" is an unspecified (wildcard) address` | 旧镜像的 legacy 直连模式 | 升级镜像；dsh 0.2.2+ 只允许绑定回环地址，公网统一走网关 |
| agent 无法执行命令，报 `SANDBOX_UNAVAILABLE` | 雨云运行环境不支持 Landlock/bwrap 沙箱 | 联系雨云确认内核版本与安全上下文支持；Landlock 需内核 5.13+ |
| 点 DeepSeek 账号登录立即显示“登录失败” | 镜像已放行任意 HTTP(S) 回调 origin，但 DeepSeek Platform 拒绝公网 `redirect_uri`，或其回调地址无法到达容器 | 查看容器日志的 `[deepseek-account]` 错误；使用 SSH 本地转发或 `local-proxy.mjs`。若预览是带路径前缀的反代，`/oauth/callback` 无法回到容器，也需本地转发 |

## 13. 密码登录（默认开启，镜像内置鉴权网关）

镜像自 `0.2.2-rc.1` 起默认开启密码访问（`DSH_AUTH=1`）：

| 环境变量 | 默认 | 说明 |
|---|---|---|
| `DSH_AUTH` | `1` | `1`=启用密码登录（默认）；`0`=关闭密码（网关转为透传，公网端口仍由网关监听） |

- **首次使用**：打开公网地址 → 自动跳转"设置密码"页 → 设置密码（至少 8 位）→ 之后每次访问需登录（会话 30 天有效）。
- **数据位置**：密码与密钥存在持久卷 `/data/auth/`（重启不丢）。
- **忘记密码**：删除 `/data/auth/` 下的 `password.json`（或整个 auth 目录）后重启，即回到"首次设置密码"状态。
- **安全边界**：无论是否启用密码，dsh 都只监听容器回环地址（127.0.0.1），公网始终经内置网关进入；网关改写 Host 并剥离 Origin，无需设置 `DSH_TRUSTED_HOSTS` / `DSH_TRUST_FENCE`。
- **防爆破**：登录失败 10 次后锁定该 IP 5 分钟。
- ⚠️ 网关走明文 HTTP（雨云一般只提供 HTTP），密码经网络传输；若雨云支持 HTTPS/域名证书可更安全。

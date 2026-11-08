# DeepSeek Harness Docker · 雨云一键部署版

[![Container Image](https://img.shields.io/badge/ghcr.io-caofangkuai%2Fdeepseek--harness-2496ed?logo=github&logoColor=white)](https://github.com/caofangkuai/deepseek-harness/pkgs/container/deepseek-harness)
[![License](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（`dsh`，DeepSeek AI 官方开源的 Agent 智能体框架，**一切皆插件**）Web UI 的 Docker 镜像，开箱即用，支持**雨云云应用（RCA）一键部署**。

> 面向个人使用做了三处增强：内置密码登录、持久卷权限自愈、默认 root 运行（可用 `DSH_RUNTIME_UID` 切换非 root），bash 工具仍走 Landlock 沙箱。

---

## ✨ 特性

| 特性 | 说明 |
|---|---|
| 🔐 **内置密码登录** | 首次访问注册密码，之后需登录（默认开启，`DSH_AUTH=0` 可关闭） |
| 💾 **持久卷自愈** | 自动修复 root 属主卷（K8s/雨云不继承镜像属主的问题），幂等、重启不重复 chown |
| 🌐 **免配置公网访问** | 鉴权模式下 dsh 只监听回环地址，网关自动处理 Host/Origin，无需填公网地址 |
| 🧩 **旧浏览器兼容** | 构建期把前端转译到 Chrome 90 语法，并注入 `Object.hasOwn` / `.at` / `URL.canParse` / `Promise.withResolvers` / `AbortSignal.any` / `AbortSignal.throwIfAborted` / `crypto.randomUUID` 等 polyfill（Chrome 91 WebView、微信内置浏览器等也能正常启动并建立连接） |
| 🔒 **默认 root 运行** | dsh 与鉴权网关默认以 root 启动；如需降权设置 `DSH_RUNTIME_UID=1000`，bash 工具仍走 Landlock 沙箱 |
| 🚀 **多阶段构建** | 基于 npm 官方包 `@deepseek-ai/dsh`，原生依赖构建期编译，运行镜像精简 |

---

## 🚀 快速开始

```sh
docker run -d --name dsh \
  -p 3080:3080 \
  -v dsh-data:/data \
  ghcr.io/caofangkuai/deepseek-harness:0.2.2-rc.1-fix6
```

打开 http://localhost:3080 ：

1. **首次访问** → 自动跳转「设置密码」页，设置至少 8 位密码；
2. 之后每次访问需登录（会话 30 天有效）；
3. 进入后在「设置 → 模型」填入 DeepSeek API Key（或通过环境变量 `DEEPSEEK_API_KEY` 注入），选择工作区即可开始使用。

> 忘记密码？删除持久卷中的 `/data/auth/password.json` 后重启，即可重新设置。

### docker compose

```yaml
services:
  dsh:
    image: ghcr.io/caofangkuai/deepseek-harness:0.2.2-rc.1-fix6
    container_name: dsh
    restart: unless-stopped
    ports:
      - "3080:3080"
    volumes:
      - dsh-data:/data
      # 可选：agent 工作区
      # - ./workspace:/workspace
    environment:
      - DSH_HOME=/data
      - PORT=3080
      - DSH_TELEMETRY_DISABLED=1
      # 公网访问并需要登录 DeepSeek 账号时改为 1
      - DSH_MANUAL_OAUTH=0
      # 可选：模型密钥（也可在 Web UI 配置）
      # - DEEPSEEK_API_KEY=sk-...
volumes:
  dsh-data:
```

> 通过公网地址访问时，账号登录需要 `DSH_MANUAL_OAUTH=1`：授权后浏览器会跳到 `127.0.0.1` 报错，复制地址栏 URL 粘贴到 `http://<公网地址>:<PORT>/oauth/manual` 完成登录。`localhost` / SSH 转发 / `local-proxy.mjs` 访问时保持 `0` 即可。

---

## 旧浏览器兼容

dsh 0.2.2-rc.1 的前端默认按现代浏览器构建，包含 `static {}` 类静态块（Chrome 94+）、`Object.hasOwn`（Chrome 93+）、`Array.prototype.at`（Chrome 92+）、`URL.canParse`（Chrome 120+）、`AbortSignal.prototype.throwIfAborted`（Chrome 100+）等语法/API。旧 WebView 会先因语法解析失败表现为登录后白屏；修掉语法后，又会因缺少 `throwIfAborted` 卡在“连接中”。

镜像构建阶段会做两件事：

- 用 esbuild 把 `dist/assets` 下全部 JS 转译到 Chrome 90 语法，去掉 `static {}` 等旧引擎无法解析的语法；
- 在 `index.html` 的模块脚本之前注入经典 `<script>` polyfill，覆盖 `Object.hasOwn`、`Array.prototype.at` / `String.prototype.at`、`URL.canParse` / `URL.parse`、`Promise.withResolvers` / `Promise.try`、`AbortSignal.any` / `AbortSignal.timeout` / `AbortSignal.prototype.throwIfAborted`、`findLast`、`toSorted`、`Object.groupBy`、`crypto.randomUUID` 等缺失 API。

polyfill 只在原生 API 不存在时安装，现代浏览器行为不变。

---

## 📦 镜像

GitHub Container Registry（公开）：[ghcr.io/caofangkuai/deepseek-harness](https://github.com/caofangkuai/deepseek-harness/pkgs/container/deepseek-harness)

| Tag | 说明 |
|---|---|
| `0.2.2-rc.1-fix6` | **当前推荐**：fix5 + `AbortSignal.prototype.throwIfAborted` polyfill。修复旧 WebView 登录后一直显示“连接中”的问题（dsh 客户端调用该 API 建立 mux 连接） |
| `0.2.2-rc.1-fix5` | 0.2.2-rc.1 + 旧浏览器兼容首版：转译 Chrome 90 语法并注入基础 polyfill，解决登录后白屏；旧 WebView 仍会因缺少 `throwIfAborted` 停在“连接中” |
| `0.2.2-rc.1-fix4` | 0.2.2-rc.1 + WebSocket 修复 + 手动回调桥接。设 `DSH_MANUAL_OAUTH=1` 后账号登录强制使用 loopback `redirect_uri`，浏览器跳转失败后把地址栏 URL 粘贴到 `/oauth/manual` 即可完成登录 |
| `0.2.2-rc.1-fix3` | 0.2.2-rc.1 + WebSocket 修复 + 远程 OAuth 补丁（dsh 侧放行任意 HTTP(S) origin；Platform 仍拒绝公网回调，公开账号登录不可用） |
| `0.2.2-rc.1-fix2` | 0.2.2-rc.1 + WebSocket 修复 + 远程 OAuth 补丁（仅 `DSH_PUBLIC_ORIGIN` 白名单） |
| `0.2.2-rc.1-fix1` | 0.2.2-rc.1 + WebSocket 修复 |
| `0.2.2-rc.1` | 上游 npm 版本 tag |
| `latest` | 跟随最新构建 |

> **版本策略**：镜像 tag 的基线与上游 `@deepseek-ai/dsh` 的 npm 版本号一致，`-fixN` 表示同版本下的本地修复构建。同 tag 被重新推送时，雨云等按 tag 缓存的平台可能不会自动拉新——如需强制更新，把镜像字段临时改为 `latest` 或删除应用重建。

---

## ⚙️ 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | `3080` | 公网监听端口（网关）；改端口后重启会自动更新 `cordis.patch.yml` 的托管行，无需删文件 |
| `DSH_HOME` | `/data` | 数据目录，**务必挂卷**（设置、密钥、会话、profiles、密码都在这里） |
| `DSH_AUTH` | `1` | 密码登录开关：`1`=开启（默认），`0`=关闭密码（网关转为透传，仍由网关监听公网端口） |
| `DSH_AUTH_PASSWORD` | 空 | **推荐**：预置登录密码。密码保存在部署配置里而非仅卷中——即使卷数据被重置（雨云重建容器），重启后也会自动恢复该密码，不会回到"设置密码"页。不填则首次访问注册 |
| `DSH_TELEMETRY_DISABLED` | `1` | 关闭遥测 |
| `DEEPSEEK_API_KEY` | 空 | 可选，模型密钥（也可在 Web UI 配置） |
| `DSH_MANUAL_OAUTH` | `0` | 设为 `1` 时账号登录强制使用 `http://127.0.0.1:3081/oauth/callback` 作为回调（Platform 只接受 loopback）。授权后浏览器会跳到 `127.0.0.1` 并报错，复制地址栏 URL 粘贴到 `/oauth/manual` 完成登录 |
| `DSH_INTERNAL_PORT` | `3081` | dsh 内部回环端口；修改后手动回调 URL 中的端口也要对应替换 |
| `DSH_RUNTIME_UID` / `DSH_RUNTIME_GID` | `0` | 运行用户，默认 root；设为非零（如 `1000`）则降权运行，入口会自动修复卷属主 |

> dsh 0.2.2+ 拒绝绑定 `0.0.0.0`，因此无论是否开启密码，dsh 都只监听容器回环地址，公网始终由网关进入。网关会自动改写 Host 并剥离 Origin，`DSH_TRUSTED_HOSTS` / `DSH_TRUST_FENCE` 不再需要（旧配置保留也无副作用）。
>
> 账号登录（fix4）：DeepSeek Platform 只在 schema 层接受 loopback `redirect_uri`，公网回调会被拒绝（`auth_init` 返回 `50005 PAYLOAD_SCHEMA_MISMATCH`）。设置 `DSH_MANUAL_OAUTH=1` 后，非 loopback 的登录请求会被固定为 `http://127.0.0.1:3081/oauth/callback`；Platform 接受后，浏览器授权完会跳到本机 `127.0.0.1` 并提示无法访问。复制地址栏里的完整 URL（含 `code` 和 `state`），打开 `http://<公网地址>:<PORT>/oauth/manual`，粘贴并提交，网关会在服务端完成回调，账号随即登录。token 持久化在 `/data`。
>
> 仍可使用 SSH 本地转发（`ssh -N -L 13080:127.0.0.1:3080 root@服务器`，浏览器打开 `http://127.0.0.1:13080`）或在本机运行 `node local-proxy.mjs https://<公网地址> 13080` 后打开 `http://127.0.0.1:13080`；浏览器 origin 为 loopback 时走官方登录路径，不需要 `DSH_MANUAL_OAUTH`。
>
> hosts 方案也可用：临时把 `localhost` 指向服务器（仅 HTTP 端口可用），浏览器打开 `http://localhost:<PORT>` 完成网关和账号登录，然后还原 hosts。账号 token 存在 `/data`，还原后从公网地址访问仍然有效；hosts 改动期间会影响本机其他使用 `localhost` 的服务。

---

## ☁️ 雨云云应用（RCA）部署

**逐字段填写文档**：[RCA-TEMPLATE.zh.md](RCA-TEMPLATE.zh.md)（对照雨云官方教程 [topic/11296](https://forum.rainyun.com/t/topic/11296)）

核心配置速览：

| 项 | 值 |
|---|---|
| 镜像 | `ghcr.io/caofangkuai/deepseek-harness:0.2.2-rc.1-fix6` |
| 最小资源 | 1 核 / 512MB（推荐 1核1GB+） |
| Env | `DSH_HOME=/data`、`PORT=3080`、`DSH_TELEMETRY_DISABLED=1`、`DSH_AUTH_PASSWORD=<密码>`、`DSH_MANUAL_OAUTH=1`（公网账号登录） |
| 持久卷 | 挂载路径 `/data`（与 DSH_HOME 一致），子路径 `dsh`，目录类型 |
| 服务 | 外部访问，内部端口 `3080`，协议 tcp |

### 一键部署按钮

```markdown
[![通过雨云一键部署](https://rainyun-apps.cn-nb1.rains3.com/materials/deploy-on-rainyun-cn.svg)](https://app.rainyun.com/apps/rca/store/<应用ID>?ref=<你的UID>)
```

英文版素材：`https://rainyun-apps.cn-nb1.rains3.com/materials/deploy-on-rainyun-en.svg`
推广链接格式：`https://app.rainyun.com/apps/rca/store/<应用ID>?ref=[UID]` 或 `.../<应用ID>/[优惠码]_`
上架与返利流程见雨云官方指南 [topic/11430](https://forum.rainyun.com/t/topic/11430)。

---

## 🔨 本地构建 / 测试 / 发布

```sh
# 构建（默认 npm 包 0.2.2-rc.1；换版本：--build-arg DSH_VERSION=<version>）
docker build -t deepseek-harness:0.2.2-rc.1-fix5 .

# 冒烟测试（网关/登录/沙箱/持久化/legacy/健康，全过才退出 0）
./smoke-test.sh deepseek-harness:0.2.2-rc.1-fix5

# 推送新 tag 到 GitHub Container Registry
GHCR_USERNAME=<用户> GHCR_TOKEN=<令牌> DSH_VERSION=0.2.2-rc.1 ./push.sh
```

- 令牌需要 `write:packages` 权限（PAT 在 https://github.com/settings/tokens 创建；GitHub App 令牌用用户名 `x-access-token`）。
- **CI 自动发布（可选）**：`.github/workflows/docker-publish.yml` 配置 `GHCR_TOKEN` 等 Secrets 后，打 `v*` tag 或手动触发即自动构建 → 冒烟 → 推送 ghcr.io。

---

## ❓ 常见问题

| 现象 | 原因 / 解决 |
|---|---|
| 日志报 `mkdir: cannot create directory '/data/profiles': Permission denied` | 旧镜像的已知问题；用当前镜像（`0.2.2-rc.1`）重新部署即自动修复。若雨云仍用缓存旧镜像（同 tag 更新不自动拉新），把镜像字段临时改为 `latest` 或删除应用重建 |
| 报 `trustedHosts entry "http://..." is not a bare host` | 旧镜像才需要 `DSH_TRUSTED_HOSTS`；当前镜像的网关会自动处理 Host/Origin，删除该变量并升级镜像即可 |
| 页面报 `crypto.randomUUID is not a function` | 旧版 dsh（<=0.1.0-rc.6）的已知问题；当前镜像已内置该 polyfill，升级镜像即可解决 |
| 密码登录成功后页面白屏（Chrome 91 等旧 WebView） | 前端含 `static {}` 类静态块，Chrome 94 以下无法解析，SPA 整体不启动；当前镜像会在构建期转译到 Chrome 90 语法并注入运行时 polyfill，升级镜像即可解决 |
| agent 无法执行命令，报 `SANDBOX_UNAVAILABLE` | 宿主内核不支持 Landlock（5.13+）；确认容器安全上下文是否放行 |
| 登录失败 10 次被锁 | 防爆破机制，5 分钟后自动解锁 |

---

## 📁 目录结构

```
├── Dockerfile                  # 多阶段构建（node:24-trixie-slim + npm 官方包）
├── docker-entrypoint.sh        # 入口：卷属主自愈 → profile 补丁 → 回环启动 dsh + 网关
├── auth-proxy.js               # 内置密码登录网关（零依赖；含 /oauth/manual 手动回调桥接）
├── patch-browser-compat.mjs    # 构建期浏览器兼容：前端转译到 Chrome 90 语法 + 注入旧 WebView polyfill
├── patch-trust-fence.mjs       # 构建期补丁：可选关闭 /api 信任围栏（DSH_TRUST_FENCE=0 构建参数）
├── patch-remote-oauth.mjs      # 构建期补丁：OAuth 回调（默认任意 HTTP(S)，DSH_MANUAL_OAUTH=1 强制 loopback）
├── local-proxy.mjs             # 可选：在浏览器本机把 loopback 转发到远端网关
├── smoke-test.sh               # 一键冒烟测试
├── push.sh                     # 一键发布脚本
├── docker-compose.yml          # 本地一键起服务
├── RCA-TEMPLATE.zh.md          # 雨云模板逐字段填写文档
└── .github/workflows/          # CI 自动构建发布
```

## 📄 许可证

MIT。上游项目 [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) 同样为 MIT 许可，其第三方依赖许可见上游仓库的 [THIRD_PARTY_NOTICES](https://github.com/deepseek-ai/deepseek-harness/blob/master/THIRD_PARTY_NOTICES.md)。

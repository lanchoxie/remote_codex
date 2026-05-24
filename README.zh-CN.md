# Mobile Codex Remote 中文说明

`Mobile Codex Remote` 是一个用手机或浏览器控制多台电脑 / HPC 上 Codex 会话的轻量控制面板。

当前版本：`v0.2.0-basic-multiplatform`，也就是“基础多平台版本”。

## 这个项目能做什么

- 在同一个网页里查看本地电脑、远端电脑、HPC 上的 Codex 会话。
- 从手机或浏览器继续控制正在运行的 Codex。
- 在本地或 HPC 指定目录中新建 Codex 会话。
- 从历史会话 resume 或 fork 出新的 live 会话。
- 在多个 host 之间切换，并在切换前做健康检查。
- 浏览远端目录，HPC/Linux 默认支持 `~` 和 `/` 根目录。
- 搜索会话，支持关键词、路径、标题类信息。
- 用收藏夹管理跨 host 的会话。
- 使用 Codex app-server 能力：切换模型、推理强度、summary、审批策略、审批 reviewer、沙盒模式、plan-only、review、interrupt、steer、compact、shell command。
- 支持图片输入、host 本地图片路径、拖拽图片、拖拽文本/代码文件进入对话。
- 支持 HPC connector：保存 SSH/gateway/MFA/bootstrap 配置，并通过 tmux 在 HPC 上启动 host-agent。

## 重要安全提醒

这个项目目前适合自己在可信网络里使用，还没有登录鉴权系统。

- 不要把正在运行的 `http://你的IP:8797` 直接暴露到公网。
- 不要把 live relay 地址发给不可信的人。
- 如果别人能访问你的 live relay，就可能看到或控制你当前挂在 relay 上的本地 / HPC Codex 会话。
- 给朋友体验时，发 GitHub 仓库链接最安全，不要发你正在运行的服务地址。

不会被提交到 GitHub 的本地敏感文件包括：

- `tmp/connectors.json`
- `tmp/connector-secrets.json`
- `tmp/session-collections.json`
- `.env`
- `.env.local`
- `tmp/remote-codex-askpass.*`

朋友 clone 仓库以后，不会自动拥有你的电脑或 HPC 登录权限。他需要自己配置 host、SSH key、密码、OTP、Codex 账号和本机 `~/.codex`。

## 安装要求

推荐环境：

- Node.js 22 或更新版本
- 本机已经安装并登录过 Codex
- 本机存在 `~/.codex` 会更方便导入历史会话
- 如果要连接 HPC，需要本机 OpenSSH 可用

检查 Node：

```bash
node --version
```

## 快速启动本地版本

克隆仓库：

```bash
git clone https://github.com/lanchoxie/remote_codex.git
cd remote_codex
git checkout v0.2.0-basic-multiplatform
```

启动 relay 和本地 host-agent：

```bash
npm run dev
```

打开浏览器：

```text
http://127.0.0.1:8787
```

如果你是在当前开发机上使用，也可能运行在：

```text
http://127.0.0.1:8797
```

具体端口以启动日志为准。

## 常用脚本

```bash
npm run dev
npm run relay
npm run agent
npm run test:managed
```

- `npm run dev`：同时启动 relay 和一个本地 host-agent。
- `npm run relay`：只启动 relay。
- `npm run agent`：只启动当前机器的 host-agent。
- `npm run test:managed`：跑一个基础 managed session 测试。

## 用手机访问

同一局域网内，先确认电脑的局域网 IP，例如 `192.168.1.20`。

电脑上启动 relay 后，手机浏览器访问：

```text
http://192.168.1.20:8787
```

如果你使用的是 `8797`：

```text
http://192.168.1.20:8797
```

注意：

- 手机和电脑需要在同一个网络里。
- Windows 防火墙可能需要允许 Node.js 监听局域网。
- 不要把这个地址发到公网群里。

## 本地 host 怎么用

启动后，左侧会出现本机 host。

你可以：

- 查看本机 `~/.codex` 里的历史会话。
- 选择一个历史会话并 `Resume From History`。
- 在 `Path on selected host` 输入目录，然后点 `New In Directory`。
- 选择 live session 后直接在底部输入框继续对话。

底部 composer 支持：

- 输入普通 prompt。
- `Models` 拉取模型列表。
- 手动填写模型 id。
- 切换 effort / summary / approval / sandbox。
- 点 `Plan` 只让 Codex 给计划，不直接改文件。
- 点 `Review` 审查当前工作区改动。
- 拖图片进去作为图片输入。
- 拖 `.md/.py/.js/.json/.txt` 等文本文件进去，内容会嵌入 prompt。

## HPC host 怎么用

推荐流程是：手机 / 浏览器只连 relay，HPC 上跑 host-agent，让 HPC 主动连回 relay。

在网页左侧点：

```text
Manage HPC
```

新建一个 connector，常用字段：

- `Label`：显示名，比如 `hkl` 或 `dm`
- `Relay URL`：HPC 能访问到的 relay 地址，比如 `http://你的电脑IP:8797`
- `Target host`：HPC 登录节点地址
- `Target port`：SSH 端口
- `Login username`：HPC 用户名
- `CODEX_HOME`：通常是 `~/.codex`
- `Remote agent directory`：远端项目目录，比如 `~/mobile-codex-remote`
- `tmux session name`：比如 `codex-remote`

如果不需要 gateway：

- `Gateway` 选择 disabled
- 只填 target host / port / username / auth

如果需要 gateway / jump host：

- 开启 Gateway
- 填 gateway host、port、username
- 根据学校或集群要求选择 SSH key、password、keyboard-interactive、OTP 等认证方式

保存后可以使用：

- `Run Test`：测试 SSH 是否能连通。
- `Check Status`：检查远端 tmux/agent 状态。
- `Start Agent`：把 host-agent 启动到远端 tmux 里。
- `Restart Agent`：杀掉远端 tmux 里的旧 host-agent，并用当前代码重新启动。更新功能后如果看到“host agent needs to be restarted”，用这个按钮。
- `Copy Login` / `Copy Bootstrap`：复制命令，必要时手动在终端执行。

## OTP / 验证码说明

很多 HPC 会要求：

- SSH key
- 密码
- Google Authenticator 六位验证码
- keyboard-interactive
- 设备记住 / 不记住

这个项目会尽量弹窗提示你输入当前 SSH 请求需要的内容。

但是验证码通常几十秒过期，如果失败：

- 重新点 `Run Test` 或 `Start Agent`
- 输入新的六位验证码
- 如果系统管理员断开长连接，也需要重新认证

更稳定的做法是使用 SSH ControlMaster / tmux / 集群允许的 remember-device 机制，但不同 HPC 策略差异很大。

## 会话管理

左侧 session 区域支持：

- 按 host 查看会话。
- 搜索关键词。
- 搜索路径。
- 搜索标题类信息。
- Default 收藏夹。
- 自定义收藏夹。
- 把某个会话保存到收藏夹。
- 跨 host 记录收藏项。

收藏夹只记录会话元信息，不会保存你的 SSH 密码或 OTP。

## Codex 控制项说明

底部控制栏里常见选项：

- `Model`：本轮和后续轮使用的模型。
- `Effort`：推理强度，例如 low / medium / high / xhigh。
- `Summary`：推理 summary 级别。
- `Default mode`：正常对话。
- `Plan only`：只规划，默认 read-only sandbox + never approval。
- `Approval policy`：何时需要用户审批。
- `Reviewer`：审批由用户还是 auto_review 处理。
- `Sandbox mode`：workspace write / read only / danger full access。
- `Review`：启动 Codex review。
- `Interrupt`：打断当前 turn。
- `Steer`：给正在运行的 turn 增加方向。
- `Compact`：压缩上下文。

## 给朋友体验应该发什么

推荐发：

```text
https://github.com/lanchoxie/remote_codex
```

或者指定版本：

```text
https://github.com/lanchoxie/remote_codex/tree/v0.2.0-basic-multiplatform
```

不要发：

- 你的整个工作目录压缩包
- 你的 `tmp/` 目录
- 你的 `.env`
- 你的 live relay URL
- 你的 SSH key
- 你的 HPC 密码或 OTP

朋友自己运行后，只会看到他自己机器上的 host 和会话。除非你主动把 live relay 暴露给他，否则他不会登录到你的电脑或 HPC。

## 当前限制

- relay 多数 runtime 状态仍在内存里，重启后 live 状态需要 host-agent 重新上报。
- 没有用户登录 / 权限系统。
- 不建议暴露公网。
- 不同 HPC 的 MFA 和 SSH 策略差异很大，可能需要针对集群微调。
- 图片输入依赖当前 Codex app-server 支持 image input。
- 普通二进制文件目前不能作为 blob 附件直接发给 Codex。

## 开发验证

运行：

```bash
npm run test:managed
```

也可以做基础语法检查：

```bash
node --check apps/relay/server.js
node --check apps/host-agent/agent.js
node --check apps/host-agent/codex-app-server-runner.js
node --check apps/mobile-web/public/app.js
```

## 目录结构

```text
apps/
  relay/        relay API + SSE + connector manager backend
  host-agent/   host-side Codex controller
  mobile-web/   mobile-first browser UI
shared/         protocol, connector, discovery helpers
docs/           design and module notes
tmp/            local runtime state, ignored by git
```

## 一句话总结

这个版本已经可以作为“本地电脑 + HPC + 手机网页控制 Codex”的基础版本使用。真正给朋友体验时，发 GitHub 仓库链接；不要发你正在运行的 relay 地址。

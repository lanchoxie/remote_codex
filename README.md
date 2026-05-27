# Mobile Codex Remote 使用指南

`Mobile Codex Remote` 是一个用网页或手机控制多台电脑、远程服务器和 HPC 上 Codex 会话的轻量工具。你可以在一个界面里切换本地电脑、Linux 主机和 HPC，继续历史会话，启动新的 Codex 会话，上传文件/图片，并把远端生成的文件下载回来。

旧版开发说明已归档到 [README_v2.01.md](README_v2.01.md)。本文只保留安装、启动、导入和安全使用方式。

## 功能概览

- 多 host：本地电脑、远程 Linux、HPC 都可以接入同一个 relay。
- 会话管理：查看历史、按关键词/路径/标题搜索，按创建时间、更新时间、消息数排序。
- Live 控制：新建、Resume、Fork、Stop、Interrupt、Steer、Plan、Review。
- 文件传输：拖拽或选择文件上传到选中 host；远端回复里的图片/文件路径可打开或保存。
- 手机适配：左侧导航可折叠，适合通过手机浏览器或 Tailscale 访问。
- HPC 连接器：支持 SSH key、密码、keyboard-interactive、OTP/MFA、gateway/jump host、tmux bootstrap。
- API profiles：可以保存多个 API profile，并为不同 host 选择不同 API key/base URL。

## 安全提醒

不要把 relay 直接暴露到公网。推荐用 Tailscale 这种私有网络访问。

不会提交到 GitHub 的本地敏感文件包括：

- `tmp/connectors.json`
- `tmp/connector-secrets.json`
- `tmp/session-collections.json`
- `tmp/session-logs.json`
- `tmp/relay-auth-token.txt`
- `tmp/relay-auth-account.json`
- `.env`
- `.env.local`
- `tmp/.codex-remote-files/`
- `tmp/received-files/`

给朋友体验时，发 GitHub 仓库链接即可。不要发你的 live relay 地址、SSH key、HPC 密码、OTP、`.env` 或 `tmp/` 目录。

## 安装

推荐环境：

- Node.js 22 或更新版本。
- Git。
- 本地或远端已安装 Codex CLI。
- 如果要连接 HPC，本机需要可用的 OpenSSH。

克隆仓库：

```bash
git clone https://github.com/lanchoxie/remote_codex.git
cd remote_codex
```

本项目当前没有第三方 npm 依赖，通常可以直接运行。如果你后续添加依赖，再执行：

```bash
npm install
```

## 启动本地 relay 和本地 host

在电脑上运行：

```bash
npm run dev
```

默认打开：

```text
http://127.0.0.1:8787
```

如果你用自定义端口，例如 `8797`，启动 relay 前设置 `PORT=8797`，然后打开：

```text
http://127.0.0.1:8797
```

第一次打开网页会要求创建 relay 登录账号。这个账号只保护网页入口，密码以 scrypt hash 存在本机 `tmp/relay-auth-account.json`，不是明文。

常用脚本：

```bash
npm run dev
npm run relay
npm run agent
npm run test:managed
```

- `npm run dev`：同时启动 relay 和本地 host-agent。
- `npm run relay`：只启动网页/API relay。
- `npm run agent`：只启动当前机器的 host-agent。
- `npm run test:managed`：跑基础 managed session 和文件传输测试。

## 在电脑上使用

启动后，左侧会显示当前 host。常见操作：

- `New In Directory`：输入选中 host 上的工作目录，新建 Codex 会话。
- `Resume From History`：把历史会话恢复成 live 会话。
- `Fork New Branch`：从当前历史或 live 会话 fork 出一个新分支。
- `Stop Session`：结束当前 live session，但保留历史。
- `Interrupt`：打断正在运行的 turn。
- `Plan`：只让 Codex 规划，不直接改文件。
- `Review`：让 Codex 审查当前工作区改动。

聊天输入：

- `Enter` 发送。
- `Shift+Enter` 换行。
- 输入 `/` 打开快捷菜单。
- 点 `+` 添加文件或图片。
- 拖拽文件到输入区也可以上传。
- 如果 Codex 回复里出现远端图片或文件路径，聊天框会尝试生成 `Open` / `Save` 卡片。

## 连接手机

如果手机和电脑在同一个局域网，先查电脑局域网 IP，例如 `192.168.1.20`，然后手机浏览器打开：

```text
http://192.168.1.20:8787
```

如果你使用自定义端口：

```text
http://192.168.1.20:8797
```

如果打不开，通常检查三件事：

- 手机和电脑是否在同一个网络。
- Windows 防火墙是否允许 Node.js 监听局域网。
- relay 是否真的在对应端口运行。

## 使用 Tailscale 安全内网穿透

Tailscale 官方下载地址：

```text
https://tailscale.com/download
```

推荐流程：

1. 在电脑和手机上都安装 Tailscale。
2. 两台设备登录同一个 tailnet。
3. 在电脑上启动 `npm run dev` 或你的 relay/agent。
4. 在电脑上查看 Tailscale IP，通常是 `100.x.y.z`。
5. 手机连上 Tailscale 后访问：

```text
http://100.x.y.z:8787
```

如果你的 relay 端口是 `8797`：

```text
http://100.x.y.z:8797
```

安全建议：

- Tailscale 账号开启 MFA。
- 不要在路由器上做公网端口转发。
- 不要把 relay 登录密码、recovery token 或 Tailscale 设备权限给不可信的人。
- 只在本机临时调试时才考虑 `RELAY_AUTH_DISABLED=1`。

## 导入和管理 host

本地 host-agent 启动后会自动注册到 relay，一般不需要手动导入。

如果 host 已经存在但被隐藏，或者你知道一个 host id，可以到：

```text
设置 -> Hosts and connectors
```

使用 `Import Host` 输入 host id。

如果要连接 HPC 或远程 Linux，使用：

```text
设置 -> Hosts and connectors -> Manage HPC
```

新建 connector 时常用字段：

- `Label`：显示名，例如 `dm`、`hkl`、`lab-gpu`。
- `Relay URL`：远端 host-agent 能访问到的 relay 地址，例如 `http://100.x.y.z:8787`。
- `Target host`：HPC 登录节点或远程服务器地址。
- `Target port`：SSH 端口。
- `Login username`：远端用户名。
- `CODEX_HOME`：通常是 `~/.codex`。
- `Workspace roots`：可浏览的工作目录，一行一个。
- `Remote agent directory`：远端放置本项目的目录，例如 `~/mobile-codex-remote`。
- `tmux session name`：推荐 `codex-remote`。

如果不需要 gateway，保持 `Gateway Disabled`。如果需要跳板机，打开 Gateway 并填写 gateway host、port、username 和认证方式。

保存 connector 后：

1. 点 `Run Test` 检查 SSH 是否能登录。
2. 点 `Start Agent` 上传/启动远端 host-agent。
3. 如果更新了项目代码，点 `Restart Agent` 让远端使用新版本。
4. 如果 OTP 过期，页面会重新提示输入验证码或密码。

## 远端安装 Codex CLI

如果 HPC 上没有 Codex CLI，先在远端安装 Node.js 和 Codex。

HPC/conda 推荐：

```bash
conda create -n codex-node -c conda-forge nodejs=20 -y
conda activate codex-node
npm install -g @openai/codex
codex --help
```

个人 Linux 服务器也可以用 `fnm`：

```bash
curl -fsSL https://fnm.vercel.app/install | bash
source ~/.bashrc
fnm install 20
fnm use 20
npm install -g @openai/codex
codex --help
```

安装完成后，回到网页 connector 里点 `Start Agent` 或 `Restart Agent`。

## API profile

在右上角：

```text
设置 -> API profiles
```

可以添加多个 API profile，例如 OpenAI 官方 key、sub2api 反代 key、实验室代理 key。每个 host 可以绑定不同 profile。

注意：

- API key 只在你选择“记住”时保存在当前浏览器本地。
- API key 不会提交到 GitHub。
- API profile 变更通常作用于新启动或重新 Resume/Fork 的 session；已经运行中的 Codex app-server 需要 Stop/Resume 或 Restart host-agent 才能完全换环境。

## 分享给朋友

推荐发送：

```text
https://github.com/lanchoxie/remote_codex
```

朋友 clone 后只能看到他自己机器上的 host、Codex 历史和配置。除非你把正在运行的 relay 地址和登录凭据给他，否则他不会自动进入你的电脑或 HPC。

## 当前限制

- relay 仍是轻量实现，部分 live runtime 状态在内存里，重启后需要 host-agent 重新上报。
- 不同 HPC 的 SSH/MFA/OTP 策略差异很大，可能需要按集群微调 connector。
- 超大数据集不建议通过手机上传，最好让 Codex 在远端直接读路径。
- 远端 host-agent 必须更新到当前版本后，才能使用最新的图片输入、文件下载、模型列表和排序元数据能力。

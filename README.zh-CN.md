# Mobile Codex Remote 中文使用指南

Mobile Codex Remote 是一个用网页或手机控制 Codex 会话的轻量控制台。它可以同时管理本地电脑、远程 Linux 主机和 HPC 集群上的 Codex 会话，支持新建、恢复、派生、打断、文件上传下载和运行状态监控。

英文 README: [README.md](README.md)
v2.01 阶段说明归档: [README_v2.01.md](README_v2.01.md)

## 功能概览

- 多 host 控制：本地电脑、远程 Linux、HPC 登录节点都可以接入同一个 relay。
- 历史发现：从每台 host 的 Codex home 读取历史，通常是 `~/.codex`。
- 会话操作：新建、Resume、Fork、Stop、Interrupt、Steer、Plan、Review。
- 会话搜索：支持关键词、路径、标题类信息搜索。
- 会话排序：支持按创建时间、最近更新时间、消息数量排序，并可切换升序/降序。
- 文件传输：从浏览器上传文件或图片到选中 host，也可以打开/保存远端生成的文件。
- 手机界面：抽屉式导航、紧凑状态条、移动端可用的下拉菜单。
- HPC 连接器：支持 SSH key、密码、keyboard-interactive、OTP/MFA、gateway/jump host、tmux bootstrap。
- API profiles：可以配置多个 OpenAI 兼容 API key 和 base URL，并按 host 绑定。

## 项目结构

```text
手机/浏览器 -> relay 网页/API 服务 -> host-agent -> Codex app-server
                                     -> 本地文件 / HPC 工作目录
```

- `apps/relay`：提供网页、API、SSE、会话状态和命令中转。
- `apps/host-agent`：运行在被控制的电脑或 HPC 上，负责启动和管理 Codex app-server。
- `apps/mobile-web`：浏览器 UI。
- `shared`：协议、connector、发现和存储工具。

relay 建议运行在可信私有网络里。手机远程访问推荐使用 Tailscale、校园 VPN 或其他私有网络。

## 环境要求

- 推荐 Node.js 22 或更新版本。
- Git。
- 每台要控制的 host 上安装 Codex CLI。
- 如果要从本机 bootstrap HPC/远程主机，本机需要 OpenSSH。

## 安装

```bash
git clone https://github.com/lanchoxie/remote_codex.git
cd remote_codex
```

当前项目基本只使用 Node.js 内置模块，通常不需要安装依赖。如果未来加入依赖，再执行：

```bash
npm install
```

## 本地启动

同时启动 relay 和本地 host-agent：

```bash
npm run dev
```

浏览器打开：

```text
http://127.0.0.1:8787
```

常用脚本：

```bash
npm run dev
npm run relay
npm run agent
npm run test:managed
```

- `npm run dev`：启动 relay 和一个本地 host-agent。
- `npm run relay`：只启动 relay 服务。
- `npm run agent`：只启动当前机器的 host-agent。
- `npm run test:managed`：运行 managed session 和文件传输 smoke test。

自定义端口：

```bash
PORT=8797 npm run relay
```

Windows PowerShell：

```powershell
$env:PORT=8797
npm run relay
```

## 网页基本用法

常见操作：

- `New In Directory`：在选中 host 的指定目录新建 Codex 会话。
- `Resume From History`：把导入的历史会话恢复成 live managed session。
- `Fork New Branch`：从当前会话派生一个新的 live 分支。
- `Stop Session`：停止当前 live 进程，但保留历史。
- `Interrupt`：打断当前 Codex turn。
- `Plan`：下一条消息以计划模式发送。
- `Review`：让 Codex 审查当前工作区改动。

输入框快捷键：

- `Enter`：发送消息。
- `Shift+Enter`：在输入框内换行。
- 输入 `/`：打开命令菜单。
- 点击 `+` 或拖拽文件：添加附件。

## 手机访问

如果手机和 relay 电脑在同一个局域网，使用电脑的局域网 IP 访问：

```text
http://192.168.1.20:8787
```

把 `192.168.1.20` 和端口替换成你的实际地址。

## Tailscale 访问

Tailscale 下载地址：

```text
https://tailscale.com/download
```

推荐流程：

1. 在 relay 电脑和手机上安装 Tailscale。
2. 两台设备登录同一个 tailnet。
3. 在 relay 电脑上启动 relay 和 host-agent。
4. 查看 relay 电脑的 Tailscale IP，通常是 `100.x.y.z`。
5. 手机打开：

```text
http://100.x.y.z:8787
```

如果 relay 使用其他端口，把 `8787` 换成对应端口。

## 添加远程主机或 HPC

打开：

```text
设置 -> Hosts and connectors -> Manage HPC
```

新建 connector，常用字段：

- `Label`：显示名，例如 `dm`、`hkl`、`lab-gpu`。
- `Relay URL`：远端 host-agent 能访问到的 relay 地址。
- `Target host`：远程服务器或 HPC 登录节点。
- `Target port`：SSH 端口。
- `Login username`：SSH 用户名。
- `CODEX_HOME`：通常是 `~/.codex`。
- `Workspace roots`：可浏览的工作目录，一行一个。
- `Remote agent directory`：例如 `~/mobile-codex-remote`。
- `tmux session name`：例如 `codex-remote`。

保存后可以使用：

- `Run Test`：测试 SSH 登录。
- `Start Agent`：部署并启动远端 host-agent。
- `Restart Agent`：项目更新后重启远端 host-agent。
- `Check Status`：检查远端 tmux/agent 状态。

如果集群需要 OTP/MFA，页面会在 SSH 需要时提示输入新的验证码或密码。

## 远端安装 Codex CLI

HPC/conda 环境推荐：

```bash
conda create -n codex-node -c conda-forge nodejs=20 -y
conda activate codex-node
npm install -g @openai/codex
codex --help
```

个人 Linux 服务器也可以使用 `fnm`：

```bash
curl -fsSL https://fnm.vercel.app/install | bash
source ~/.bashrc
fnm install 20
fnm use 20
npm install -g @openai/codex
codex --help
```

安装完成后，回到网页里重启远端 host-agent。

## API Profiles

打开：

```text
设置 -> API profiles
```

可以添加多个 OpenAI 兼容 API profile，例如 OpenAI 官方 key、反代 base URL 或实验室代理。不同 host 可以绑定不同 profile。变更通常作用于新启动、Resume 或 Fork 的 Codex app-server session。

## 开发检查

```bash
node --check apps/relay/server.js
node --check apps/host-agent/agent.js
node --check apps/host-agent/codex-app-server-runner.js
node --check apps/mobile-web/public/app.js
npm run test:managed
```

## 当前限制

- relay 的 runtime 状态比较轻量，host-agent 重连后会重新上报 live 状态。
- 导入的历史会话需要 Resume 或 Fork 后才会变成可交互 live session。
- 不同 HPC 的 SSH/MFA 策略差异很大，connector 可能需要按集群调整。
- 超大数据集建议留在 host 文件系统里，让 Codex 按路径读取，不建议通过浏览器上传。
